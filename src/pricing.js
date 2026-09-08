// Put-option pricing from real Binance data.
// Model: Black-Scholes European put, risk-free rate = 0, volatility = annualized
// realized vol from the last 168 hourly closes. Deliberately simple - documented
// as such in the README.
//
// Payout is CAPPED at maxPayoutUsd (i.e. this is a put spread, not a naked put).
// That bounds the desk's liability so collateral can actually be checked.

import { hourlyCloses } from "./binance.js";

const HOURS_PER_YEAR = 24 * 365;

export function realizedVol(closes) {
  if (!Array.isArray(closes) || closes.length < 3) {
    throw new Error(`need >= 3 closes to estimate volatility, got ${closes?.length ?? 0}`);
  }
  const rets = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (!Number.isFinite(r)) throw new Error("non-finite log return in close series");
    rets.push(r);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  const sigma = Math.sqrt(varc) * Math.sqrt(HOURS_PER_YEAR);
  if (!Number.isFinite(sigma) || sigma <= 0) {
    throw new Error(`unusable volatility estimate (${sigma})`);
  }
  return sigma;
}

// Standard normal CDF (Abramowitz & Stegun 26.2.17)
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x >= 0 ? 1 - p : p;
}

// Black-Scholes put value per 1 unit of underlying. r = 0.
export function bsPut(S, K, sigma, T) {
  if (!Number.isFinite(S) || !Number.isFinite(K) || S <= 0 || K <= 0) {
    throw new Error("bsPut: S and K must be positive and finite");
  }
  // NaN fails every comparison, so test for finiteness explicitly.
  if (!Number.isFinite(sigma) || !Number.isFinite(T) || sigma <= 0 || T <= 0) {
    return Math.max(K - S, 0);
  }
  const vsqrtT = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + ((sigma * sigma) / 2) * T) / vsqrtT;
  const d2 = d1 - vsqrtT;
  const v = K * ncdf(-d2) - S * ncdf(-d1);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const round = (n) => Number(Number(n).toPrecision(6));
// fixed 6-dp quantisation for anything that becomes a USDC (6-decimal) amount
const q6 = (n) => Number(Number(n).toFixed(6));

// Quote a capped put covering `notionalUsd` of the asset.
export async function quotePut({
  pair,
  spot,
  strikePct,
  expirySeconds,
  notionalUsd,
  feeBps = 150,
  maxPayoutUsd = 2,
}) {
  if (!Number.isFinite(spot) || spot <= 0) throw new Error("invalid spot price");
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) throw new Error("notionalUsd must be > 0");
  if (!Number.isFinite(expirySeconds) || expirySeconds <= 0) throw new Error("expirySeconds must be > 0");
  if (!Number.isFinite(strikePct) || strikePct <= 0 || strikePct >= 100) {
    throw new Error("strikePct must be between 0 and 100 (exclusive)");
  }
  if (!Number.isFinite(maxPayoutUsd) || maxPayoutUsd <= 0) throw new Error("maxPayoutUsd must be > 0");

  const closes = await hourlyCloses(pair, 168);
  const sigma = realizedVol(closes);
  const strike = spot * (1 - strikePct / 100);
  const T = expirySeconds / (365 * 24 * 3600);
  const qty = notionalUsd / spot; // units of base asset covered

  // Fair value of the uncapped put, then charge for the capped version. The cap
  // only ever reduces value, so pricing the uncapped leg is conservative for the
  // buyer (they never overpay relative to what they can receive... they pay a
  // little more). Documented simplification.
  const perUnitFair = bsPut(spot, strike, sigma, T);
  const fairPremium = Math.min(perUnitFair * qty, maxPayoutUsd);
  const premium = fairPremium * (1 + feeBps / 10000) + 0.01; // desk markup + $0.01 floor

  const premiumUsd = Math.max(q6(premium), 0.0001); // x402 minimum is 1e-4
  if (!Number.isFinite(premiumUsd)) throw new Error("premium computation produced a non-finite value");

  return {
    pair,
    spot: round(spot),
    strike: round(strike),
    strikePct,
    sigmaAnnualized: round(sigma),
    expirySeconds,
    notionalUsd,
    qty: round(qty),
    maxPayoutUsd: q6(maxPayoutUsd),
    fairPremiumUsd: q6(fairPremium),
    premiumUsd,
    feeBps,
    model: "black-scholes put, r=0, realized vol (168h hourly), payout capped",
  };
}

// Intrinsic payout at settlement, capped. USDC amount -> fixed 6-dp.
export function payoutUsd({ strike, mark, qty, maxPayoutUsd }) {
  if (!Number.isFinite(strike) || !Number.isFinite(mark) || !Number.isFinite(qty)) return 0;
  const intrinsic = Math.max(strike - mark, 0) * Math.max(qty, 0);
  const cap = Number.isFinite(maxPayoutUsd) && maxPayoutUsd > 0 ? maxPayoutUsd : Infinity;
  return q6(Math.min(intrinsic, cap));
}
