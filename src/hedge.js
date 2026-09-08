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

export function openHedge({ pair, notionalUsd, entryPrice, mode }) {
  const qty = notionalUsd / entryPrice;
  if (mode === "manual") {
    console.log("\n[hedge:manual] >>> place this now in your MCP client:");
    console.log(`    USDdS-M Futures  SHORT  ${qty.toFixed(6)} ${pair}  (~$${notionalUsd})  @ market`);
    console.log("    the desk will settle on the expiry timer regardless\n");
  } else {
    console.log(`[hedge:simulated] opened SHORT ${qty.toFixed(6)} ${pair} @ ${entryPrice}`);
  }
  return { pair, side: "short", qty, entryPrice, notionalUsd, mode, openedAt: Date.now() };
}

export async function closeHedge(pos) {
  const { price: exit, source } = await markPrice(pos.pair);
  const hedgePnlUsd = Number(((pos.entryPrice - exit) * pos.qty).toPrecision(6)); // short gains as price falls
  console.log(`[hedge:${pos.mode}] closed ${pos.pair} @ ${exit} (${source})  ->  hedge PnL $${hedgePnlUsd}`);
  return { ...pos, exitPrice: exit, exitSource: source, hedgePnlUsd, closedAt: Date.now() };
}
