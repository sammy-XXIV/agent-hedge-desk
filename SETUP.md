# Reproducing this

Two agents, run separately. The **desk** is a service you can host or run locally;
the **client** runs on your machine and holds the wallet that pays.

A live desk is already deployed, so you can skip straight to step 5 and point the
client at it.

---

## 1. Requirements

- Node 20+
- Two wallets on **Base Sepolia** (testnet — no real funds)
- A model API key: any OpenAI-compatible endpoint, or Anthropic
- Optional, only for the real hedge leg: a Binance account with USDⓈ-M futures
  enabled and the Agent OS MCP server connected

## 2. Install

```bash
git clone https://github.com/sammy-XXIV/agent-hedge-desk
cd agent-hedge-desk
npm install
```

## 3. Fund two testnet wallets

Generate two keypairs (any tool; `viem`'s `generatePrivateKey` works):

- **Client** — pays premiums. Needs a few cents of USDC. **No ETH required**: the
  x402 premium uses EIP-3009, so the facilitator submits it and the payer spends
  no gas.
- **Desk** — receives premiums, sends payouts. Needs at least `MAX_PAYOUT_USD`
  (default $2) in USDC **plus a little Base Sepolia ETH for gas**, since the
  payout is an ordinary ERC-20 transfer it sends itself.

USDC faucet: <https://faucet.circle.com> (select Base Sepolia).
ETH: any Base Sepolia faucet.

The desk refuses to quote below its collateral threshold — that is the solvency
gate, not a bug.

## 4. Configure

Create `.env`:

```bash
# --- desk ---
DESK_PRIVATE_KEY=0x...
MAX_PAYOUT_USD=2
DESK_FEE_BPS=150
HEDGE_MODE=simulated          # or "manual" to print a real Binance order

# --- client ---
CLIENT_PRIVATE_KEY=0x...
DESK_URL=https://agent-hedge-desk-production.up.railway.app
MAX_PREMIUM_PCT=6

# --- model (required for the client) ---
LLM_PROVIDER=openai           # any OpenAI-compatible endpoint
LLM_BASE_URL=https://api.rntm.sh/v1
LLM_MODEL=free
LLM_API_KEY=...
# or: LLM_PROVIDER=anthropic, LLM_MODEL=claude-sonnet-5, LLM_API_KEY=sk-ant-...

# --- contract defaults ---
PAIR=BNBUSDT
NOTIONAL_USD=10
STRIKE_PCT=0.05
EXPIRY_SECONDS=600

# --- chain ---
X402_NETWORK=base-sepolia
X402_FACILITATOR_URL=https://x402.org/facilitator
BASE_SEPOLIA_RPC=https://sepolia.base.org
PAYOUT_TOKEN=0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

The client will not start without a model key — its buy/decline is a model
judgment, not a threshold.

## 5. Run

Against the live desk, only the client is needed:

```bash
npm run client
```

To run your own desk as well:

```bash
npm run desk        # terminal 1
npm run client      # terminal 2, with DESK_URL=http://localhost:4040
```

Arguments override the defaults: `PAIR NOTIONAL_USD STRIKE_PCT EXPIRY_SECONDS`

```bash
npm run client BNBUSDT 10 0.05 600   # ~0.3 sigma out -> the agent buys
npm run client BNBUSDT 10 2.5  600   # ~13 sigma out -> the agent declines
npm run client BNBUSDT 5  0.05 600   # too small to hedge -> the desk declines
```

Whether it buys is a judgment, not a flag. There is no dry-run: if it decides to
buy, it pays.

## 6. The Binance hedge leg (optional)

With `HEDGE_MODE=manual` the desk returns the exact futures order it needs, on
`GET /contract/:id`, and the client prints it when the contract activates:

```
SELL 0.01 BNBUSDT MARKET on Binance USDⓈ-M Futures (~$7.5)
```

To place it through Agent OS:

```bash
claude mcp add binance-mcp-server --transport http https://agent.binance.com/mcp/agentic
```

Then `/mcp` in Claude Code, authenticate, and grant **Market data + Account +
Trade (USDⓈ-M Futures)**. Authorising creates an Agentic sub-account; fund it
manually from your main account — the agent cannot pull funds itself. Around
$3 USDT covers the minimum hedge at 5x leverage.

**This order is real money on Binance mainnet**, unlike the testnet premium and
payout. It stays open until you close it.

If your network cannot resolve `agent.binance.com`, that is usually ISP-level DNS
filtering; pointing the machine at a public resolver (1.1.1.1 / 8.8.8.8) fixes it.

## 7. Verify independently

Nothing needs to be taken on trust:

```bash
curl $DESK_URL/health              # desk address, hedge mode, live collateral
curl $DESK_URL/contract/<id>       # lifecycle, hedge order, signed settlement
```

The settlement record is signed by the desk wallet and carries `premiumTx`,
`payoutTx`, `markSource`, `payoutStatus` and `hedgeIsSimulated`. Both transfers
are visible on Base Sepolia — check the client and desk addresses directly rather
than believing the client's own printout.
