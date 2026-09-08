// Agent B - the hedging desk.
//
// Sells a capped synthetic put on a Binance asset to another agent:
//   POST /quote            -> price a put from live Binance realized vol (free)
//   POST /buy/:quoteId     -> pay the premium via x402, protection goes live
//   GET  /contract/:id     -> status, then the signed settlement record
//
// On expiry the desk reads the Binance mark price, closes its hedge, and if the
// put is in the money it pays the holder on-chain (USDC transfer).
//
// Contract lifecycle:
//   pending_settlement -> active -> settled | settled_unpaid
//                      \-> void   (x402 on-chain settlement never landed)

import "dotenv/config";
import express from "express";
import { randomUUID } from "node:crypto";
import { paymentMiddleware } from "x402-express";
import { getDefaultAsset } from "x402/shared";
import {
  createWalletClient,
  createPublicClient,
  http,
  erc20Abi,
  parseUnits,
  formatUnits,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { spotPrice, markPrice, normalizePair } from "./binance.js";
import { quotePut, payoutUsd } from "./pricing.js";
import { openHedge, closeHedge } from "./hedge.js";
import { signRecord } from "./settle.js";

const PORT = Number(process.env.PORT || process.env.DESK_PORT || 4040);
const NETWORK = process.env.X402_NETWORK || "base-sepolia";
const FACILITATOR = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
const RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const USDC = process.env.PAYOUT_TOKEN || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const HEDGE_MODE = process.env.HEDGE_MODE || "simulated";
const FEE_BPS = Number(process.env.DESK_FEE_BPS || 150);
const MAX_PAYOUT_USD = Number(process.env.MAX_PAYOUT_USD || 2);
const QUOTE_TTL_MS = 60_000; // single-use plans expire in 60s; re-quote to proceed

const DESK_PK = process.env.DESK_PRIVATE_KEY;
if (!DESK_PK) {
  console.error("DESK_PRIVATE_KEY missing - set it in .env");
  process.exit(1);
}
const account = privateKeyToAccount(DESK_PK);
const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(RPC) });
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(RPC) });

// Explicit atomic price (x402's "$x" string path does float math that can produce
// non-integer atomic amounts; passing { amount, asset } skips it entirely).
const USDC_ASSET = getDefaultAsset(NETWORK);
const priceFor = (usd) => ({
  amount: String(Math.round(usd * 10 ** USDC_ASSET.decimals)),
  asset: USDC_ASSET,
});

const quotes = new Map(); // quoteId -> { quoteId, quote, payoutAddress, createdAt }
const contracts = new Map(); // contractId -> contract state
let reservedUsd = 0; // worst-case liability held against pending + active contracts

async function deskUsdcBalance() {
  try {
    const bal = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    return Number(formatUnits(bal, 6));
  } catch {
    return null;
  }
}

// Free = on-chain balance minus what is already promised to live contracts.
async function freeCollateralUsd() {
  const bal = await deskUsdcBalance();
  return bal == null ? null : bal - reservedUsd;
}

function reserve(c) {
  if (c.reserved) return;
  c.reserved = true;
  reservedUsd += c.terms.maxPayoutUsd;
}

function release(c) {
  if (!c.reserved) return;
  c.reserved = false;
  reservedUsd = Math.max(0, reservedUsd - c.terms.maxPayoutUsd);
}

async function sendUsdc(to, amountUsd) {
  const value = parseUnits(Number(amountUsd).toFixed(6), 6);
  const hash = await walletClient.writeContract({
    address: USDC,
    abi: erc20Abi,
    functionName: "transfer",
    args: [to, value],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

const app = express();
// Behind a platform proxy (Railway et al) so the x402 challenge advertises the
// real https resource URL rather than http://<internal-host>.
app.set("trust proxy", true);
app.use(express.json({ limit: "32kb" }));

app.get("/health", async (_req, res) => {
  const bal = await deskUsdcBalance();
  res.json({
    ok: true,
    service: "agent-hedge-desk",
    desk: account.address,
    network: NETWORK,
    hedgeMode: HEDGE_MODE,
    maxPayoutUsd: MAX_PAYOUT_USD,
    collateral: { balanceUsd: bal, reservedUsd, freeUsd: bal == null ? null : bal - reservedUsd },
  });
});

// ---- price a put -------------------------------------------------------------
app.post("/quote", async (req, res) => {
  try {
    const b = req.body || {};
    const pair = normalizePair(b.pair || process.env.PAIR || "BNBUSDT");
    const strikePct = Number(b.strikePct ?? process.env.STRIKE_PCT ?? 1.0);
    const expirySeconds = Number(b.expirySeconds ?? process.env.EXPIRY_SECONDS ?? 90);
    const notionalUsd = Number(b.notionalUsd ?? process.env.NOTIONAL_USD ?? 100);
    const payoutAddress = b.payoutAddress;
    if (!/^0x[0-9a-fA-F]{40}$/.test(payoutAddress || "")) {
      return res.status(400).json({ error: "payoutAddress (0x...) required" });
    }

    // Refuse to write cover we could not pay.
    const free = await freeCollateralUsd();
    if (free == null) {
      return res.status(503).json({ error: "cannot read desk collateral balance" });
    }
    if (free < MAX_PAYOUT_USD) {
      return res.status(409).json({
        error: "insufficient desk collateral",
        detail: `free $${free.toFixed(6)} < required $${MAX_PAYOUT_USD} per contract`,
      });
    }

    const spot = await spotPrice(pair);
    const quote = await quotePut({
      pair,
      spot,
      strikePct,
      expirySeconds,
      notionalUsd,
      feeBps: FEE_BPS,
      maxPayoutUsd: MAX_PAYOUT_USD,
    });
    const quoteId = randomUUID();
    quotes.set(quoteId, { quoteId, quote, payoutAddress, createdAt: Date.now() });

    console.log(
      `[desk] quote ${pair} put  premium $${quote.premiumUsd} (fair $${quote.fairPremiumUsd})  ` +
        `strike ${quote.strike}  cap $${quote.maxPayoutUsd}  vol ${(quote.sigmaAnnualized * 100).toFixed(1)}%`
    );
    res.json({ quoteId, quote, ttlSeconds: QUOTE_TTL_MS / 1000 });
  } catch (e) {
    console.error("[desk] quote error:", e.message);
    res.status(502).json({ error: "quote failed", detail: e.message });
  }
});

// ---- buy: pay the premium via x402 (price is per-quote, so mount inline) -----
app.post("/buy/:quoteId", (req, res) => {
  const q = quotes.get(req.params.quoteId);
  if (!q) return res.status(404).json({ error: "unknown quoteId" });
  if (Date.now() - q.createdAt > QUOTE_TTL_MS) {
    quotes.delete(q.quoteId);
    return res.status(410).json({ error: "quote expired (60s) - request a fresh quote" });
  }
  // NOTE: the quote must stay resolvable here. x402's client flow is
  // request -> 402 -> sign -> retry the SAME url, so deleting it now would make
  // the retry 404. It is consumed in onPaid(), after signature verification.
  const routeKey = `POST /buy/${req.params.quoteId}`;
  const mw = paymentMiddleware(
    account.address,
    {
      [routeKey]: {
        price: priceFor(q.quote.premiumUsd),
        network: NETWORK,
        config: {
          description: `Premium: ${q.quote.pair} put, strike ${q.quote.strikePct}% OTM, ${q.quote.expirySeconds}s, $${q.quote.notionalUsd} notional, payout capped $${q.quote.maxPayoutUsd}`,
        },
      },
    },
    { url: FACILITATOR }
  );

  mw(req, res, () =>
    onPaid(q, res)
      .then((out) => res.json(out))
      .catch((e) => {
        console.error("[desk] onPaid error:", e.message);
        // 4xx/5xx makes x402 skip on-chain settlement, so the buyer is not charged.
        res.status(500).json({ error: e.message });
      })
  );
});

// Runs inside the x402 middleware's next(), i.e. AFTER signature verification but
// BEFORE on-chain settlement. So the contract is only staged here; it goes live in
// the response 'finish' handler, once we can see settlement actually landed.
async function onPaid(q, res) {
  // Single-use, claimed only after the payment signature verified. Guards against
  // two concurrent verified payments racing on one quote.
  if (q.consumed) throw new Error("quote already used");
  q.consumed = true;
  quotes.delete(q.quoteId);

  const free = await freeCollateralUsd();
  if (free == null) throw new Error("cannot read desk collateral balance");
  if (free < q.quote.maxPayoutUsd) {
    throw new Error(`insufficient desk collateral: free $${free.toFixed(6)} < $${q.quote.maxPayoutUsd}`);
  }

  const contractId = randomUUID();
  const c = {
    contractId,
    status: "pending_settlement",
    terms: q.quote,
    payoutAddress: q.payoutAddress,
    premiumPaidUsd: q.quote.premiumUsd,
    stagedAt: Date.now(),
    openedAt: null,
    expiresAt: null,
    hedge: null,
    reserved: false,
  };
  reserve(c); // hold the collateral while settlement is in flight
  contracts.set(contractId, c);

  res.on("finish", () => {
    const settlementLanded = Boolean(res.getHeader("X-PAYMENT-RESPONSE"));
    if (res.statusCode < 400 && settlementLanded) {
      activate(contractId).catch((e) => {
        console.error("[desk] activate error:", e.message);
        voidContract(contractId, `activation failed: ${e.message}`);
      });
    } else {
      voidContract(contractId, settlementLanded ? `http ${res.statusCode}` : "x402 settlement did not land");
    }
  });

  console.log(`[desk] contract ${contractId} staged - awaiting on-chain settlement of $${q.quote.premiumUsd}`);
  return {
    contractId,
    status: "pending_settlement",
    note: "poll GET /contract/:id - goes active once the premium settles on-chain",
    terms: q.quote,
  };
}

async function activate(id) {
  const c = contracts.get(id);
  if (!c || c.status !== "pending_settlement") return;

  const entry = await spotPrice(c.terms.pair);
  c.hedge = openHedge({
    pair: c.terms.pair,
    notionalUsd: c.terms.notionalUsd,
    entryPrice: entry,
    mode: HEDGE_MODE,
  });
  c.status = "active";
  c.openedAt = Date.now();
  c.expiresAt = c.openedAt + c.terms.expirySeconds * 1000;
  contracts.set(id, c);

  setTimeout(
    () => settle(id).catch((e) => console.error("[desk] settle error:", e.message)),
    c.terms.expirySeconds * 1000
  );
  console.log(`[desk] contract ${id} ACTIVE - premium $${c.premiumPaidUsd} settled, cover live ${c.terms.expirySeconds}s`);
}

function voidContract(id, reason) {
  const c = contracts.get(id);
  if (!c || (c.status !== "pending_settlement" && c.status !== "active")) return;
  release(c);
  c.status = "void";
  c.voidReason = reason;
  contracts.set(id, c);
  console.warn(`[desk] contract ${id} VOID - ${reason} (no cover written, collateral released)`);
}

async function settle(id) {
  const c = contracts.get(id);
  if (!c || c.status !== "active") return;

  const { price: mark, source: markSource } = await markPrice(c.terms.pair);
  const closed = await closeHedge(c.hedge);
  const payout = payoutUsd({
    strike: c.terms.strike,
    mark,
    qty: c.terms.qty,
    maxPayoutUsd: c.terms.maxPayoutUsd,
  });

  let payoutTx = null;
  let payoutStatus = "none";
  let payoutError = null;
  if (payout > 0) {
    try {
      payoutTx = await sendUsdc(c.payoutAddress, payout);
      payoutStatus = "paid";
      console.log(`[desk] PUT ITM - paid $${payout} to ${c.payoutAddress}  tx ${payoutTx}`);
    } catch (e) {
      payoutStatus = "failed";
      payoutError = e.message;
      console.error(`[desk] payout transfer FAILED ($${payout} owed to ${c.payoutAddress}): ${e.message}`);
    }
  } else {
    console.log(`[desk] put worthless (mark ${mark} >= strike ${c.terms.strike}) - premium kept`);
  }

  const simulatedHedge = closed.mode !== "mcp";
  const record = {
    contractId: id,
    pair: c.terms.pair,
    strike: c.terms.strike,
    notionalUsd: c.terms.notionalUsd,
    qty: c.terms.qty,
    maxPayoutUsd: c.terms.maxPayoutUsd,
    premiumUsd: c.premiumPaidUsd,
    markPriceAtExpiry: mark,
    markSource,
    payoutUsd: payout,
    payoutStatus, // "paid" | "failed" | "none"
    payoutTx,
    payoutError,
    hedgeMode: closed.mode,
    hedgeIsSimulated: simulatedHedge,
    hedgePnlUsd: closed.hedgePnlUsd,
    // Only real cash flows. Hedge PnL is reported separately because in
    // simulated/manual mode it is not money this desk actually holds.
    deskCashNetUsd: Number((c.premiumPaidUsd - (payoutStatus === "paid" ? payout : 0)).toPrecision(6)),
    settledAt: new Date().toISOString(),
  };

  release(c);
  c.status = payoutStatus === "failed" ? "settled_unpaid" : "settled";
  c.settlement = await signRecord(DESK_PK, record);
  contracts.set(id, c);
  console.log(
    `[desk] contract ${id} ${c.status.toUpperCase()}  cash net $${record.deskCashNetUsd}` +
      (simulatedHedge ? `  (hedge PnL $${record.hedgePnlUsd} is ${closed.mode}, not real cash)` : "")
  );
}

app.get("/contract/:id", (req, res) => {
  const c = contracts.get(req.params.id);
  if (!c) return res.status(404).json({ error: "unknown contractId" });
  res.json({
    contractId: c.contractId,
    status: c.status,
    terms: c.terms,
    expiresAt: c.expiresAt,
    voidReason: c.voidReason || null,
    settlement: c.settlement || null,
  });
});

app.listen(PORT, async () => {
  const bal = await deskUsdcBalance();
  console.log(`[desk] listening on http://localhost:${PORT}`);
  console.log(`[desk] wallet ${account.address}  USDC ${bal ?? "?"} on ${NETWORK}`);
  console.log(`[desk] hedge mode: ${HEDGE_MODE}   payout cap $${MAX_PAYOUT_USD}/contract   facilitator: ${FACILITATOR}`);
  if (bal != null && bal < MAX_PAYOUT_USD) {
    console.log(
      `[desk] WARNING: balance $${bal} < payout cap $${MAX_PAYOUT_USD} - quotes will be refused. Fund via https://faucet.circle.com`
    );
  }
});
