# Agent Hedging Desk

> An autonomous agent can open a position. It cannot buy insurance on one —
> there is no options desk that answers to software. This is that desk.

One agent quotes downside cover on a Binance asset. Another agent decides whether
the cover is worth buying, and pays for it **agent-to-agent over x402**. The desk
hedges the risk and settles the payout on-chain when the option finishes in the
money. No human approves anything in the middle.

> **Status: working end-to-end on testnet.** Premium settlement, contract lifecycle
> and signed records are real. The hedge leg runs in `simulated` mode by default —
> `manual` prints the exact futures order for an MCP-connected client to place.
> Payment settles on Base Sepolia, not BNB Chain; see [Scope](#scope).

Built for the Binance Agent OS Mini Hackathon — Track A, **Payment Workflows**.

## Why an agent can't just hedge itself

A trading agent holding spot has three choices today and all of them need a human:
open a futures account and manage margin, buy options on a venue with no agent API,
or eat the drawdown. Delta-neutral bots sidestep this by running one strategy for
their own book — there is no counterparty, no market, nothing to buy.

Risk transfer needs two parties. That is why this is a **payment** problem and not a
trading one: for one agent to carry another's downside, money has to move between
them, per contract, without anyone clicking approve. x402 is what makes that
possible, and it is the product here — not billing bolted onto a trading demo.

## Why the payout is capped

The desk sells a put **spread**, not a naked put:

```
payout = min( max(strike − mark, 0) × qty , MAX_PAYOUT_USD )
```

A naked put has unbounded liability — the underlying can go to zero and the writer
owes `strike × qty`. That number is unknowable when the contract is written, so a
desk carrying it cannot answer the only question that matters: *can I pay what I
just sold?*

Capping the payout turns liability into a constant, and that constant is what makes
solvency checkable at all:

```
free collateral = on-chain USDC balance − liability reserved by live contracts
```

`/quote` returns **409** when free collateral is below the cap, and the check runs
again at purchase. The desk refuses to write cover it cannot fund. Reserved
collateral is released on settlement or void.

## Why the contract waits before going live

x402's middleware verifies the payment **signature** before handing off to the route
handler, but performs **on-chain settlement only after that handler returns**. Write
the contract inside the handler and you have written cover for a premium that may
never land — free options for anyone who can make settlement fail.

So contracts stage first and activate only once a settlement receipt exists:

```
pending_settlement ──► active ──► settled | settled_unpaid
        └──────────► void   (settlement never landed)
```

Nothing is hedged and no payout timer is armed until the premium is actually on
chain. `settled_unpaid` means the put finished in the money but the transfer failed —
the signed record carries `payoutStatus` and `payoutError` rather than quietly
claiming it paid.

## Why the model only judges, never executes

Pricing, payout, collateral and the policy caps are arithmetic — auditable, and
identical on every replay. The model sits at exactly one point: deciding whether the
cover is worth buying.

```
premium · payoff ratio · expected move · strike distance in sigma
        │
   policy guardrails ── balance / MAX_PREMIUM_PCT ──► blocked, model never asked
        │
      model ──► buy | decline   + stated reason
        │
   deterministic execution
```

A hallucinating model can decline a good trade. It cannot overspend, cannot raise a
limit, and never sees an address or an amount it could change.

The discrimination is real. Offered a **$0.01** premium at a **200× payoff ratio**:

```
[client]    DECLINE
     "Strike 35.96 sigma out with only $0.51 expected move over 90s. Probability of
      payout is effectively zero; payoff ratio 200x is meaningless against negative EV."
```

Move the strike to ~0.7 sigma and it buys, pays, and the loop runs:

```
[client]    BUY
     "Premium 0.02% of notional, strike 0.72 sigma from spot. Payoff ratio 101x,
      vol high, recent -1.88% move."
[client]    premium paid - x402 receipt: { success: true, transaction: '0x4384d71a…' }
[client]    status -> active -> settled
     mark @ expiry : 739.36 (spot-fallback)   strike 738.231
     payout        : $0 [none]
     USDC after    : 19.980246   (before 20)
```

## Flow

```
Client agent A                                     Desk agent B
  │  POST /quote  (pair, size, strike, expiry)          │
  │────────────────────────────────────────────────────►│  prices a put from live
  │             quote + premium                         │  Binance realized vol
  │◄────────────────────────────────────────────────────│
  │  guardrails, then model: buy or decline             │
  │  POST /buy/:id  ───────── HTTP 402 ─────────────────│
  │  sign USDC payment, retry with X-PAYMENT  ─────────►│  premium settles   (A → B)
  │                                                     │  stage → activate → hedge
  │◄──────────── contract active ───────────────────────│
  │                     … expiry …                      │
  │                                                     │  reads settlement price,
  │                                                     │  closes hedge, computes payout
  │◄──────────── USDC payout, if ITM ───────────────────│  on-chain transfer  (B → A)
  │◄──────────── signed settlement record ──────────────│
```

Two payments, opposite directions, no human in the loop.

## Try it

Setup and reproduction steps: [SETUP.md](SETUP.md).

The desk is live. No install, no wallet needed to see it price and challenge:

```bash
URL=https://agent-hedge-desk-production.up.railway.app

curl $URL/health
# desk address, hedge mode, and live collateral: balance / reserved / free

curl -X POST $URL/quote -H 'content-type: application/json'   -d '{"pair":"BNBUSDT","strikePct":0.09,"expirySeconds":300,"notionalUsd":7.5,
       "payoutAddress":"0xYourAddress"}'
# a real put priced off live Binance realized volatility

curl -X POST $URL/buy/<quoteId> -H 'content-type: application/json' -d '{}'
# HTTP 402 - the x402 challenge, with the exact atomic premium and payTo
```

To actually buy one you need a Base Sepolia wallet with test USDC
(<https://faucet.circle.com>) and any x402 client. `src/client.js` is one.

## API

| Route | Paid | Does |
|---|---|---|
| `POST /quote` | free | prices a capped put from 168h realized vol; returns a 60s single-use `quoteId` |
| `POST /buy/:quoteId` | **x402** | premium priced per quote; stages the contract, activates on settlement |
| `GET /contract/:id` | free | lifecycle status, then the wallet-signed settlement record |
| `GET /health` | free | desk address, hedge mode, collateral: balance / reserved / free |

`POST /quote` with `{ pair, strikePct, expirySeconds, notionalUsd, payoutAddress }`:

```json
{
  "quoteId": "26db4f1a-…",
  "quote": {
    "pair": "BNBUSDT", "spot": 739.93, "strike": 738.82,
    "sigmaAnnualized": 0.4116, "expirySeconds": 90,
    "qty": 0.135148, "maxPayoutUsd": 2,
    "fairPremiumUsd": 0.000381, "premiumUsd": 0.010387,
    "model": "black-scholes put, r=0, realized vol (168h hourly), payout capped"
  }
}
```

An unpaid `POST /buy/:quoteId` returns a standard x402 challenge carrying the exact
atomic premium, the desk's `payTo`, and the USDC asset for the network.

## Layout

| File | Role |
|---|---|
| `src/desk.js` | the desk agent — quote, x402-gated buy, staging, settlement, payout |
| `src/client.js` | the client agent — guardrails, judgment, payment, balance proof |
| `src/judgment.js` | the buy/decline call and its stated reason |
| `src/model.js` | provider-agnostic model client — OpenAI-compatible or Anthropic |
| `src/pricing.js` | Black-Scholes put on realized vol, capped payout |
| `src/binance.js` | public market data, multi-host with mirror fallback |
| `src/hedge.js` | the hedge leg — `simulated` or `manual`; the swap point for MCP execution |
| `src/settle.js` | wallet-signed settlement records |

## Scope

A working demo, not a desk to route real risk through. The premium leg settles on
**Base Sepolia** — Binance's own x402 is partner-gated and the open x402 stack has no
BNB Chain network. The hedge runs simulated unless you place the printed order
yourself; records flag that with `hedgeIsSimulated` and keep it out of the cash P&L.
Settlement prefers the USDⓈ-M mark price and falls back to spot where
`fapi.binance.com` is blocked, always stating which in `markSource`. Pricing is
Black-Scholes on trailing realized vol: fine here, gameable at size.
