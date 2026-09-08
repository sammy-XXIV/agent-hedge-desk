// The desk's hedge against the puts it writes.
//
//   simulated : track a synthetic short perp + mark-to-market PnL (always runs)
//   manual    : print the exact USDdS-M futures order to place by hand in an
//               MCP-connected client (Claude Code / Cursor / etc) on camera
//
// A fully automated leg would issue the futures order through the Binance Agent OS
// MCP server (Trade scope) from an MCP-connected agent. That path is kept behind
// this interface so it can drop in without touching desk.js.

import { markPrice } from "./binance.js";

// Binance USDdS-M LOT_SIZE / MIN_NOTIONAL for the hedge symbol. An order has to be
// a multiple of the step, at or above minQty, and clear the notional floor - so the
// printed order is placeable as-is rather than needing rounding by hand.
const QTY_STEP = Number(process.env.HEDGE_QTY_STEP || 0.01);
const MIN_QTY = Number(process.env.HEDGE_MIN_QTY || 0.01);
const MIN_NOTIONAL_USD = Number(process.env.HEDGE_MIN_NOTIONAL || 5);

const stepDecimals = (String(QTY_STEP).split(".")[1] || "").length;

export function openHedge({ pair, notionalUsd, entryPrice, mode }) {
  // Round DOWN to the step so the hedge never exceeds the intended notional.
  const stepped = Math.floor(notionalUsd / entryPrice / QTY_STEP) * QTY_STEP;
  const orderQty = Number(stepped.toFixed(stepDecimals));
  const orderNotional = orderQty * entryPrice;

  const problems = [];
  if (orderQty < MIN_QTY) problems.push(`below minQty ${MIN_QTY}`);
  if (orderNotional < MIN_NOTIONAL_USD) problems.push(`below min notional $${MIN_NOTIONAL_USD}`);

  // Returned as part of the contract so whoever is driving the desk can see the
  // order without needing access to the desk's logs.
  const instruction =
    mode === "manual"
      ? {
          venue: "Binance USDdS-M Futures",
          side: "SELL",
          symbol: pair,
          quantity: orderQty,
          type: "MARKET",
          approxNotionalUsd: Number(orderNotional.toFixed(2)),
          text: `SELL ${orderQty} ${pair} MARKET on Binance USDdS-M Futures (~$${orderNotional.toFixed(2)})`,
          rejectsBecause: problems.length ? problems : null,
        }
      : null;

  if (mode === "manual") {
    console.log(`\n[hedge:manual] desk must hedge: ${instruction.text}`);
    if (problems.length) console.log(`    !! Binance will REJECT this: ${problems.join(", ")}`);
    console.log("");
  } else {
    console.log(
      `[hedge:simulated] opened SHORT ${orderQty} ${pair} @ ${entryPrice} (~$${orderNotional.toFixed(2)})`
    );
  }

  // Track the quantity actually placeable, so hedge PnL reflects the real order.
  return {
    pair,
    side: "short",
    qty: orderQty,
    entryPrice,
    notionalUsd,
    mode,
    instruction,
    openedAt: Date.now(),
  };
}

export async function closeHedge(pos) {
  const { price: exit, source } = await markPrice(pos.pair);
  const hedgePnlUsd = Number(((pos.entryPrice - exit) * pos.qty).toPrecision(6)); // short gains as price falls
  console.log(`[hedge:${pos.mode}] closed ${pos.pair} @ ${exit} (${source})  ->  hedge PnL $${hedgePnlUsd}`);
  return { ...pos, exitPrice: exit, exitSource: source, hedgePnlUsd, closedAt: Date.now() };
}
