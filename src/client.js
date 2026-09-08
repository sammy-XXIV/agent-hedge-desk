// Agent A - the client.
//
// Wants downside cover on a Binance asset. Gets a quote, applies its own premium
// policy, pays the premium agent-to-agent over x402, waits for settlement, and
// reports its own USDC balance before/after so the payment is visible on-chain.
//
//   node src/client.js [PAIR] [NOTIONAL_USD] [STRIKE_PCT] [EXPIRY_SECONDS]

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, erc20Abi, formatUnits, parseUnits } from "viem";
import { baseSepolia } from "viem/chains";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";
import { narrate } from "./llm.js";
import { decideProtection } from "./judgment.js";
import { assertModelConfigured } from "./model.js";
import { dayStats } from "./binance.js";

const DESK_URL = process.env.DESK_URL || "http://localhost:4040";
const RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const USDC = process.env.PAYOUT_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MAX_PREMIUM_PCT = Number(process.env.MAX_PREMIUM_PCT || 6);

const PK = process.env.CLIENT_PRIVATE_KEY;
if (!PK) {
  console.error("CLIENT_PRIVATE_KEY missing. Copy .env.example -> .env and set it.");
  process.exit(1);
}
try {
  assertModelConfigured();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const argv = process.argv.slice(2);
const terms = {
  pair: (argv[0] || process.env.PAIR || "BNBUSDT").toUpperCase(),
  notionalUsd: Number(argv[1] || process.env.NOTIONAL_USD || 100),
  strikePct: Number(argv[2] || process.env.STRIKE_PCT || 1.0),
  expirySeconds: Number(argv[3] || process.env.EXPIRY_SECONDS || 90),
};

const account = privateKeyToAccount(PK);
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const hr = () => console.log("-".repeat(64));

async function usdc(addr) {
  try {
    const bal = await pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [addr] });
    return Number(formatUnits(bal, 6));
  } catch {
    return null;
  }
}

async function main() {
  hr();
  console.log(`[client] agent ${account.address}`);
  console.log(`[client] wants cover: $${terms.notionalUsd} of ${terms.pair}, strike ${terms.strikePct}% OTM, ${terms.expirySeconds}s`);
  const balBefore = await usdc(account.address);
  console.log(`[client] USDC before: ${balBefore ?? "?"}`);

  hr();
  console.log("[client] 1) requesting a quote...");
  const qr = await fetch(`${DESK_URL}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...terms, payoutAddress: account.address }),
  });
  if (!qr.ok) throw new Error(`quote failed ${qr.status}: ${await qr.text()}`);
  const { quoteId, quote } = await qr.json();
  console.log(
    `[client]    premium $${quote.premiumUsd}  fair $${quote.fairPremiumUsd}  strike ${quote.strike}  vol ${(quote.sigmaAnnualized * 100).toFixed(1)}%`
  );

  // ---- deterministic policy guardrails: the model cannot lift these ----
  const premiumPct = (quote.premiumUsd / terms.notionalUsd) * 100;
  const blocks = [];
  if (balBefore != null && quote.premiumUsd > balBefore) {
    blocks.push(`premium $${quote.premiumUsd} exceeds USDC balance ${balBefore}`);
  }
  if (premiumPct > MAX_PREMIUM_PCT) {
    blocks.push(`premium ${premiumPct.toFixed(2)}% of notional exceeds the ${MAX_PREMIUM_PCT}% policy cap`);
  }
  if (blocks.length) {
    console.log(`[client] 2) BLOCKED by policy - ${blocks.join("; ")}.`);
    console.log("[client]    not sent to the model. no deal.");
    return;
  }

  // ---- the numbers the judgment actually hinges on ----
  const T = quote.expirySeconds / (365 * 24 * 3600);
  const expectedMoveUsd = quote.spot * quote.sigmaAnnualized * Math.sqrt(T);
  const strikeDistanceSigmas = expectedMoveUsd > 0 ? (quote.spot - quote.strike) / expectedMoveUsd : Infinity;
  const payoffRatio = quote.maxPayoutUsd / quote.premiumUsd;
  const day = await dayStats(quote.pair);

  console.log("[client] 2) deliberating...");
  console.log(`     premium ${premiumPct.toFixed(3)}% of notional | max payout $${quote.maxPayoutUsd} = ${payoffRatio.toFixed(0)}x premium`);
  console.log(`     expected move over ${quote.expirySeconds}s: $${expectedMoveUsd.toFixed(2)} | strike sits ${strikeDistanceSigmas.toFixed(2)} sigma out`);
  console.log(`     vol ${(quote.sigmaAnnualized * 100).toFixed(1)}% annualized | 24h ${day.priceChangePct24h > 0 ? "+" : ""}${day.priceChangePct24h}%`);

  const judgment = await decideProtection({
    position: { pair: quote.pair, notionalUsd: terms.notionalUsd, spot: quote.spot },
    quote: {
      premiumUsd: quote.premiumUsd,
      fairPremiumUsd: quote.fairPremiumUsd,
      strike: quote.strike,
      strikePct: quote.strikePct,
      expirySeconds: quote.expirySeconds,
      maxPayoutUsd: quote.maxPayoutUsd,
    },
    derived: {
      premiumPctOfNotional: Number(premiumPct.toFixed(4)),
      payoffRatio: Number(payoffRatio.toFixed(2)),
      expectedMoveUsd: Number(expectedMoveUsd.toFixed(4)),
      strikeDistanceSigmas: Number(strikeDistanceSigmas.toFixed(3)),
    },
    market: {
      annualizedVolPct: Number((quote.sigmaAnnualized * 100).toFixed(2)),
      priceChangePct24h: day.priceChangePct24h,
      high24h: day.high24h,
      low24h: day.low24h,
    },
    budget: { usdcBalance: balBefore, maxPremiumPctPolicy: MAX_PREMIUM_PCT },
  });

  console.log(`[client]    ${judgment.decision.toUpperCase()}  (${judgment.model})`);
  console.log(`     "${judgment.reasoning}"`);
  if (judgment.decision !== "buy") {
    console.log("[client] declined the cover. no payment made.");
    hr();
    return;
  }

  hr();
  console.log("[client] 3) paying premium via x402...");
  // maxValue guard: x402-fetch defaults to 0.10 USDC and would throw on a larger premium
  const payFetch = wrapFetchWithPayment(fetch, account, parseUnits("5", 6));
  const br = await payFetch(`${DESK_URL}/buy/${quoteId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!br.ok) throw new Error(`buy failed ${br.status}: ${await br.text()}`);
  const contract = await br.json();

  const rcpt = br.headers.get("x-payment-response");
  if (rcpt) {
    try {
      console.log("[client]    premium paid - x402 receipt:", decodeXPaymentResponse(rcpt));
    } catch {
      console.log("[client]    premium paid (receipt header present)");
    }
  } else {
    console.log("[client]    premium paid");
  }
  console.log(`[client]    contract ${contract.contractId} ${contract.status}`);

  hr();
  console.log(`[client] 4) waiting for activation, ${terms.expirySeconds}s expiry, then settlement...`);
  // Generous window: expiry + two Binance reads + a Base Sepolia tx confirmation.
  const deadline = Date.now() + terms.expirySeconds * 1000 + 120_000;
  let settled = null;
  let lastStatus = contract.status;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const s = await fetch(`${DESK_URL}/contract/${contract.contractId}`)
      .then((r) => r.json())
      .catch(() => null);
    if (!s) continue;
    if (s.status !== lastStatus) {
      lastStatus = s.status;
      const until = s.expiresAt ? ` until ${new Date(s.expiresAt).toISOString()}` : "";
      console.log(`[client]    status -> ${s.status}${until}`);
    }
    if (s.status === "void") {
      console.log(`[client] contract VOID: ${s.voidReason}. Premium was not settled, no charge.`);
      return;
    }
    if (s.status === "settled" || s.status === "settled_unpaid") {
      settled = s;
      break;
    }
  }
  if (!settled) {
    console.log(`[client] no settlement seen in ${Math.round((deadline - Date.now()) / 1000)}s window (last status: ${lastStatus}) - check desk logs.`);
    return;
  }

  hr();
  const rec = settled.settlement.record;
  console.log(`[client] 5) ${settled.status.toUpperCase()}`);
  console.log(`     mark @ expiry : ${rec.markPriceAtExpiry}  (${rec.markSource})   strike ${rec.strike}`);
  console.log(`     payout        : $${rec.payoutUsd} [${rec.payoutStatus}]${rec.payoutTx ? `   tx ${rec.payoutTx}` : ""}`);
  if (rec.payoutStatus === "failed") {
    console.log(`     !! desk owes $${rec.payoutUsd} but the transfer failed: ${rec.payoutError}`);
  }
  const balAfter = await usdc(account.address);
  console.log(`     USDC after    : ${balAfter ?? "?"}   (before ${balBefore ?? "?"})`);
  if (balAfter != null && balBefore != null) {
    console.log(`     net vs before : ${(balAfter - balBefore).toFixed(6)}  (paid $${rec.premiumUsd}, received $${rec.payoutUsd})`);
  }
  console.log(await narrate({ role: "client", record: rec, premiumPct }));
  console.log(`     settlement signed by desk: ${settled.settlement.signer}`);
  hr();
}

main().catch((e) => {
  console.error("[client] fatal:", e.message);
  process.exit(1);
});
