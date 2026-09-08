// One-line closing narration for the demo. Falls back to a plain sentence if the
// model call fails - this is cosmetic, unlike the buy/decline judgment.

import { complete } from "./model.js";

export async function narrate({ role, record, premiumPct }) {
  const plain =
    record.payoutUsd > 0
      ? `[${role}] the put paid $${record.payoutUsd}, against a $${record.premiumUsd} premium.`
      : `[${role}] put expired worthless; cost was the $${record.premiumUsd} premium.`;
  try {
    const text = await complete({
      system: `You are the ${role} agent in an agent-to-agent options trade on Binance. Give ONE dry sentence on the outcome from your side. No preamble, no JSON, no quotes.`,
      user: JSON.stringify({ record, premiumPct }),
      maxTokens: 2000,
    });
    const line = String(text || "").trim().split("\n").filter(Boolean).pop();
    return line ? `[${role}] ${line}` : plain;
  } catch {
    return plain;
  }
}
