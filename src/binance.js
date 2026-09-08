// Binance market data (public REST - no auth, no keys).
//
// This is the same class of data the Binance Agent OS MCP server exposes under its
// public "Market data" scope. Isolated here so the desk can be repointed at an
// MCP-client call without touching pricing or settlement.

// Spot hosts tried in order. data-api.binance.vision is the public read-only
// mirror and is reachable from the widest set of networks; api.binance.com is the
// canonical host. Override with BINANCE_REST.
const SPOT_HOSTS = [
  process.env.BINANCE_REST,
  "https://data-api.binance.vision",
  "https://api.binance.com",
].filter(Boolean);

const FAPI_HOSTS = [process.env.BINANCE_FAPI, "https://fapi.binance.com"].filter(Boolean);

async function tryHosts(hosts, path) {
  let lastErr;
  for (const base of hosts) {
    try {
      const r = await fetch(`${base}${path}`, {
        headers: { "User-Agent": "agent-hedge-desk/0.1" },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) {
        lastErr = new Error(`${base}${path} -> ${r.status} ${(await r.text().catch(() => "")).slice(0, 160)}`);
        continue;
      }
      return r.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`all hosts failed for ${path}`);
}

const spot = (path) => tryHosts(SPOT_HOSTS, path);
const fapi = (path) => tryHosts(FAPI_HOSTS, path);

const KNOWN_QUOTES = ["USDT", "FDUSD", "USDC", "TUSD", "BTC", "ETH", "BNB"];

export function normalizePair(input) {
  const s = String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!s) throw new Error("empty pair");
  if (KNOWN_QUOTES.some((q) => s.endsWith(q) && s.length > q.length)) return s;
  return `${s}USDT`;
}

export async function spotPrice(pair) {
  const d = await spot(`/api/v3/ticker/price?symbol=${pair}`);
  return Number(d.price);
}

// 24h rolling stats - context for the client agent's buy/decline judgment.
export async function dayStats(pair) {
  const d = await spot(`/api/v3/ticker/24hr?symbol=${pair}`);
  return {
    lastPrice: Number(d.lastPrice),
    priceChangePct24h: Number(d.priceChangePercent),
    high24h: Number(d.highPrice),
    low24h: Number(d.lowPrice),
    quoteVolume24h: Number(d.quoteVolume),
  };
}

// Hourly closes, most recent last. Used for realized-volatility estimation.
export async function hourlyCloses(pair, hours = 168) {
  const d = await spot(`/api/v3/klines?symbol=${pair}&interval=1h&limit=${Math.min(hours, 1000)}`);
  return d.map((k) => Number(k[4]));
}

// USDdS-M perpetual mark price - the settlement reference. Falls back to spot if
// the futures API is unreachable or the pair has no perp listed.
// Returns { price, source } so settlement records state which reference was used.
export async function markPrice(pair) {
  try {
    const d = await fapi(`/fapi/v1/premiumIndex?symbol=${pair}`);
    const m = Number(d.markPrice);
    if (Number.isFinite(m) && m > 0) return { price: m, source: "futures-mark" };
  } catch {
    /* fall through to spot */
  }
  return { price: await spotPrice(pair), source: "spot-fallback" };
}
