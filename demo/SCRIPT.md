# Demo script (60-90 seconds)

Goal: two autonomous agents — one **judges** whether cover is worth buying, pays for
it over x402, and the other hedges through Binance and settles on-chain. No human
touches either side mid-run.

## Before recording

1. `npm install`, `.env` filled: `DESK_PRIVATE_KEY`, `CLIENT_PRIVATE_KEY`,
   `LLM_API_KEY` (the client will not start without a model key).
2. Wallets funded on Base Sepolia:
   - **desk**: >= `MAX_PAYOUT_USD` ($2) in USDC, **plus a little ETH for gas** —
     the payout is a normal ERC-20 transfer sent by the desk.
   - **client**: a few cents of USDC. No ETH needed (x402 premium is gasless for
     the payer; the facilitator submits it).
3. `npm run desk` in one terminal — confirm the collateral line looks right.
4. If using `HEDGE_MODE=manual`: connect `binance-mcp-server` in Claude Code and
   have the Agentic sub-account funded with futures scope, **before** you hit record.
5. Do one throwaway run to warm caches and confirm the loop works.

## Picking the strike

The client agent reasons about `strikeDistanceSigmas` — how far OTM the strike is
in units of the expected move over the contract's life. Beyond ~2 sigma it will
decline, correctly. At BNB's typical ~41% vol over a 90s expiry:

| `STRIKE_PCT` | distance | what the agent does |
| --- | --- | --- |
| `0.05` | ~0.7 sigma | buys — this is your full-loop take |
| `0.15` | ~2.2 sigma | usually declines |
| `2.5`  | ~36 sigma  | declines, emphatically |

## Take 1 — the agent buys, contract settles (~45s)

```bash
npm run client BNBUSDT 100 0.05 90
```

Point at, in order:

- `[client] USDC before: …`
- `[client] 1) requesting a quote` → premium, fair value, strike, vol
- `[client] 2) deliberating…` → **the three derived lines**: premium as % of notional,
  payoff ratio, expected move and sigma distance, vol regime and 24h change
- `[client]    BUY  (<model>)` + the model's one-line reasoning ← **the agent beat**
  (expect a 5-20s pause here while it deliberates; cut it in the edit)
- `[client]    premium paid - x402 receipt: { transaction: '0x…' }` ← **payment A → B**
- desk: `contract … staged` → `ACTIVE` (it waits for on-chain settlement first)
- `[hedge:manual] >>> place this now in your MCP client: SHORT … BNBUSDT` →
  cut to Claude Code and place it for real ← **the Agent OS beat**
- desk: `PUT ITM - paid $… tx 0x…` ← **payout B → A**
- `[client] 5) SETTLED` → mark vs strike, payout + tx, USDC after, net line,
  `settlement signed by desk: 0x…`

At ~0.7 sigma the payout is close to a coin flip. If it expires worthless, that is
still a good take — it shows the desk keeping the premium and the client eating a
known, tiny cost. Record two or three and keep the pair you want.

## Take 2 — the agent declines (~20s)

```bash
npm run client BNBUSDT 100 2.5 90
```

Show:

- the same deliberation block, now with `strike sits ~36 sigma out`
- `[client]    DECLINE (<model>)` + reasoning
- `[client] declined the cover. no payment made.`

This is the take that proves it is an agent and not a script: it was offered a
cent-priced option with a 200x payoff ratio and turned it down for the right reason.

## Editing notes

- The 90s expiry is dead air — cut or speed-ramp it.
- Optionally flash BaseScan on the two tx hashes (premium in, payout out).

## One-liner to close on

"Two agents. One decided the cover was worth buying and paid for it over x402, the
other hedged it through Binance Agent OS and settled the payout on-chain. No human
in the loop — and when the trade isn't worth it, it says no."
