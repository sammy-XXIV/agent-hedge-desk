// Provider-agnostic model client.
//
// LLM_PROVIDER=openai    -> any OpenAI-compatible endpoint (set LLM_BASE_URL)
// LLM_PROVIDER=anthropic -> Anthropic API
//
// Both return a plain string. `json: true` asks the provider to emit a single JSON
// object; on OpenAI-compatible endpoints that uses response_format, which matters
// for reasoning models that otherwise stream their chain-of-thought into content.

const PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const MODEL = process.env.LLM_MODEL || (PROVIDER === "anthropic" ? "claude-sonnet-5" : "free");
const BASE_URL = process.env.LLM_BASE_URL || "https://api.rntm.sh/v1";
const API_KEY = process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;

export const modelName = MODEL;

export function assertModelConfigured() {
  if (!API_KEY) {
    throw new Error(
      "No model API key. Set LLM_API_KEY (with LLM_PROVIDER, LLM_BASE_URL, LLM_MODEL) in .env - " +
        "the client agent's buy/decline is a model judgment, not a threshold."
    );
  }
}

let _client;
async function client() {
  assertModelConfigured();
  if (_client) return _client;
  if (PROVIDER === "anthropic") {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    _client = new Anthropic({ apiKey: API_KEY });
  } else {
    const { default: OpenAI } = await import("openai");
    _client = new OpenAI({ apiKey: API_KEY, baseURL: BASE_URL });
  }
  return _client;
}

export async function complete({ system, user, maxTokens = 4000, json = false }) {
  const c = await client();

  if (PROVIDER === "anthropic") {
    const msg = await c.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    });
    return msg.content.map((p) => p.text || "").join("");
  }

  const res = await c.chat.completions.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    ...(json ? { response_format: { type: "json_object" } } : {}),
  });
  return res.choices?.[0]?.message?.content || "";
}

// Reasoning models sometimes prepend their thinking, so take the LAST balanced
// object in the text rather than a greedy first-to-last match.
export function parseJsonObject(text) {
  const s = String(text || "").trim();
  try {
    return JSON.parse(s);
  } catch {
    /* fall through to scanning */
  }
  const starts = [];
  for (let i = 0; i < s.length; i++) if (s[i] === "{") starts.push(i);
  for (const start of starts.reverse()) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(s.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`model returned no parseable JSON object: ${s.slice(0, 160)}`);
}
