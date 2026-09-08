# Agent Hedging Desk

**One agent sells another agent downside protection on a Binance asset. The premium
is paid agent-to-agent over x402. The desk hedges the risk through Binance Agent OS,
and pays the holder on-chain if the option finishes in the money.**

Built for the Binance Agent OS Mini Hackathon — **Track A**, theme **Payment Workflows
(agent-to-agent payments)**.

---

## Why this exists

Autonomous trading agents can take positions, but they have no way to *hedge* one
without a human wiring up an options account somewhere. Deltr-style agents run a
strategy for themselves; there is no counterparty, no market.

The Hedging Desk is the missing primitive: an agent that **writes protection for
other agents** and settles it end-to-end, with the payment leg as the product, not
a side effect.

```
Client agent A                         Desk agent B
  |  POST /quote (pair, size, strike, expiry)   |
  |-------------------------------------------->|  prices a put from live
  |            quote + premium                  |  Binance realized vol (BS, r=0)
  |<-------------------------------------------|
  |  policy check: premium <= X% of notional    |
  |  POST /buy/:id   --- HTTP 402 --------------|
  |  sign USDC payment, retry with X-PAYMENT -->|  x402 premium received  (A -> B)
  |                                            |  opens short perp hedge (Agent OS)
  |            contract ACTIVE                  |
  |<-------------------------------------------|
  |            ... expiry timer ...             |
  |                                            |  reads Binance mark price
  |                                            |  closes hedge, computes payout
  |         USDC payout (if ITM)  <-------------|  on-chain transfer  (B -> A)
  |         signed settlement record            |
  |<-------------------------------------------|
```

Two payments, opposite directions, no human in the loop.

## Where the model actually decides

Execution is deterministic on purpose — pricing, payout, settlement and the policy
caps are all arithmetic, auditable and replayable. The model sits at the **judgment**
layer, on the buy side:

- The client computes the numbers that matter: premium as a share of the position,
  payoff ratio, the expected move over the contract's life, and how many sigma out
  the strike sits.
- Those go to the configured model, which decides **buy or decline** and says why.
- **Hard policy guardrails run first and cannot be lifted by the model**: if the
  premium exceeds the wallet balance or the `MAX_PREMIUM_PCT` cap, the request is
  blocked before the model is even asked. A hallucinating model can decline a good
  trade; it cannot overspend and it cannot raise a limit.
- The model never sees or sets amounts, addresses or execution parameters.

A model API key is therefore **required** to run the client. This is the
difference between an agent and a threshold: offered a cent-priced put with a 200x
payoff ratio but a strike 36 sigma away, it declines — for a stated reason.

## How it maps to Agent OS

| Agent OS tool | Use here |
| --- | --- |
| **x402** (agent-driven payments) | premium `A -> B`; the `/buy` route is x402-gated at the exact per-quote premium |
| **MCP server** (market data) | live spot, hourly klines for realized vol, and the settlement reference price |
| **MCP server** (trade) / **Agentic Wallet** | the short-perp hedge leg — see `HEDGE_MODE` below |

The premium payment is genuine x402 today. The hedge leg ships in `simulated` mode
so the full loop runs unattended; `manual` mode prints the exact futures order to
place in an MCP-connected client on camera. A fully automated hedge issues that
order through the Binance MCP `Trade` scope — that swap lives entirely in
`src/hedge.js`.

## Pricing (deliberately simple, documented)

- Black-Scholes European put, risk-free rate = 0.
- Volatility = annualized realized vol from the last 168 hourly closes (Binance).
- Premium = fair value x `(1 + DESK_FEE_BPS/10000)` + `$0.01` floor.
- Payout at expiry = `min( max(strike - mark, 0) x qty , MAX_PAYOUT_USD )`,
  with `qty = notional / entry spot`.

**The payout is capped**, so this is a put *spread*, not a naked put. That is
deliberate: it bounds the desk's liability to a known number, which is what makes
the collateral check below possible at all.

This is a demo pricer. It ignores gamma, vol-of-vol, jumps and adverse selection —
a production desk needs a real risk engine and capital. See *Limitations*.

## Solvency and contract lifecycle

The desk will not write cover it cannot pay:

- Free collateral = on-chain USDC balance − liability already reserved by live
  contracts. `/quote` returns **409** if free collateral is below `MAX_PAYOUT_USD`,
  and the check runs again at purchase.
- Reserved collateral is released on settlement or void.

```
pending_settlement ──► active ──► settled | settled_unpaid
        └──────────► void   (x402 on-chain settlement never landed)
```

A contract is staged as `pending_settlement` while the premium is still settling
on-chain. x402 verifies the signature *before* handing off to the handler but only
settles *after* it returns — so the desk waits for the settlement receipt before it
opens a hedge or arms a payout timer. If settlement never lands, the contract goes
`void` and nothing was written. `settled_unpaid` means the put finished in the money
but the payout transfer failed; the signed record carries `payoutStatus` and
`payoutError` rather than silently claiming it paid.

## Prerequisites

- Node 20+
- Two wallets on **Base Sepolia** (USDC faucet: <https://faucet.circle.com>):
  - **client** — a few cents of USDC to pay premiums. **No ETH needed**: the x402
    premium uses EIP-3009, so the facilitator submits it and the payer spends no gas.
  - **desk** — at least `MAX_PAYOUT_USD` (default $2) in USDC, **plus some Base
    Sepolia ETH for gas**. The payout is an ordinary ERC-20 transfer sent by the
    desk, so it does pay gas. Below the USDC threshold the desk refuses to quote —
    that is the solvency gate, not a bug.
- **A model API key — required.** The client agent's buy/decline is a model
  judgment; it will not start without one. Any OpenAI-compatible endpoint works
  (`LLM_PROVIDER=openai` + `LLM_BASE_URL`), or set `LLM_PROVIDER=anthropic`.
  See *Where the model actually decides*.

## Setup

```bash
npm install
cp .env.example .env      # fill DESK_PRIVATE_KEY, CLIENT_PRIVATE_KEY, LLM_API_KEY
```

> Verify the x402 package versions resolve — the API moves fast:
> `npm view x402-express version && npm view x402-fetch version`.
> If `wrapFetchWithPayment` rejects a bare account, pass a viem `WalletClient` instead
> (one-line change in `src/client.js`).

## Run

Terminal 1 — the desk:

```bash
npm run desk
```

Terminal 2 — the client (args optional; defaults come from `.env`):

```bash
npm run client                          # uses .env defaults
npm run client BNBUSDT 100 0.05 90      # ~0.7 sigma out -> agent buys, full loop runs
npm run client BNBUSDT 100 2.5  90      # ~36 sigma out -> agent declines, no payment
```

Arguments are `PAIR NOTIONAL_USD STRIKE_PCT EXPIRY_SECONDS`.

Whether the agent buys is a judgment call, not a switch — the strike distance in
sigma is what moves it. At BNB's ~41% vol over a 90s expiry, `0.05` sits around
0.7 sigma out (worth buying) while `2.5` is ~36 sigma out and gets declined even
though it costs a cent and offers a 200x payoff ratio. There is no dry-run flag:
if it decides to buy, it pays for real.

## What a run looks like

Two outcomes are worth trying, because the client agent genuinely decides between
them rather than following a switch.

**It buys** — strike ~0.7 sigma out, so the cover is plausible:

```
[client] 2) deliberating...
     premium 0.020% of notional | max payout $2 = 101x premium
     expected move over 300s: $0.94 | strike sits 0.72 sigma out
[client]    BUY
     "Premium 0.02% of notional, strike 0.72 sigma from spot, max payout $2 covers
      plausible move. Payoff ratio 101x, vol high, recent -1.88% move."
[client]    premium paid - x402 receipt: { success: true, transaction: '0x4384d71a...' }
[client]    contract 659aa490 pending_settlement
[client]    status -> active
[client]    status -> settled
[client] 5) SETTLED
     mark @ expiry : 739.36  (spot-fallback)   strike 738.231
     payout        : $0 [none]
     USDC after    : 19.980246   (before 20)
```

**It declines** — same $0.01 premium and a 200x payoff ratio, but the strike is far
enough out that the option cannot realistically pay:

```
[client]    DECLINE
     "Strike 35.96 sigma out with only $0.51 expected move over 90s. Probability of
      payout is effectively zero; payoff ratio 200x is meaningless against negative EV."
[client] declined the cover. no payment made.
```

That second case is the point: it is offered something cheap with a huge headline
payoff and turns it down for the right reason.

## Limitations (stated plainly)

- **Hedge leg is `simulated` by default.** Real automated futures execution via the
  Binance MCP is the documented next step, not done here. Settlement records carry
  `hedgeIsSimulated`, and `deskCashNetUsd` counts only real cash flows — simulated
  hedge PnL is reported separately, never folded into the headline number.
- **Pricing is a toy.** Trailing realized vol is gameable; no gamma/jump risk model.
- **Testnet.** x402 premium + payout settle in Base Sepolia USDC.
- **All state is in memory.** A desk restart drops live contracts and their payout
  timers — obligations are lost silently. Needs persistence before it is real.
- **Payout leg is a direct USDC transfer, not x402.** Only the premium uses the
  x402 handshake.
- **The payout address is not bound to the payer.** Whoever holds a `quoteId`
  within its 60s window can pay it, and the payout goes to the quote requester.
- **Single writer.** A real desk pools risk and margin across many writers.
- **Settlement reference**: the desk prefers the USDⓈ-M perpetual mark price, but
  `fapi.binance.com` is blocked on many networks, in which case it falls back to
  the spot price. The signed record always states which was used (`markSource`:
  `futures-mark` or `spot-fallback`), so a settlement is never silently rebased.
- The client's underlying spot bag is assumed, not verified on-chain.
