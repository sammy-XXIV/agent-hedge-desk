// The client agent's actual decision: is this cover worth buying?
//
// The model decides only WHETHER to buy. It never sees or sets amounts, addresses,
// or execution parameters - those are computed deterministically, and hard policy
// guardrails in client.js run BEFORE this is ever called. A model that hallucinates
// can decline a good trade; it cannot overspend, and it cannot lift a policy cap.

import { complete, parseJsonObject, modelName } from "./model.js";

const SYSTEM = `You are the risk officer for an autonomous trading agent holding a spot position on Binance.
A hedging desk has quoted you a capped put (a put spread) on that position. Decide whether to BUY it.

Weigh:
- premiumVsFairValue: what you pay divided by the desk's own Black-Scholes number.
  Near 1.0 is a fair market. Well above it means you are buying fee, not risk transfer.
- payoutAtMinus1/2/3SigmaUsd against the premium: what the cover actually returns at
  plausible moves. Ignore maxPayoutUsd as a headline - capRequiresMovePct says how far
  price must fall to reach it, and that is often an implausible crash.
- breakevenRequiresMovePct: how far price must fall just to get your premium back.
- strikeDistanceSigmas: how far OTM the strike sits in units of the expected move over
  the LIFE of this contract. Beyond roughly 2 sigma the cover rarely pays at all.
- the volatility regime and the recent 24h move

Be willing to DECLINE. Most short-dated, far-out-of-the-money cover is not worth buying,
and saying so is the correct answer. Do not buy just because it is cheap.

Reply with a single JSON object and nothing else:
{"decision":"buy"|"decline","reasoning":"<=280 chars, concrete, cite the numbers that drove it"}
You cannot change any amount or parameter.`;

export async function decideProtection(context) {
  const text = await complete({
    system: SYSTEM,
    user: JSON.stringify(context),
    maxTokens: 4000,
    json: true,
  });
  const out = parseJsonObject(text);
  // Some models emit "reason" instead of "reasoning".
  const reasoning = out.reasoning ?? out.reason ?? out.rationale ?? "";
  return {
    decision: out.decision === "buy" ? "buy" : "decline",
    reasoning: trim(String(reasoning), 420),
    model: modelName,
  };
}

// Models overrun the character budget. Cut at a sentence, else a word - never
// mid-word, since this line goes on screen.
function trim(s, max) {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1);
  const word = cut.lastIndexOf(" ");
  return (word > 0 ? cut.slice(0, word) : cut).replace(/[,;:]$/, "") + "…";
}
