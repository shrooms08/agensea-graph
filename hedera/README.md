# AgenSea × Hedera — x402-gated Venus health service

An HTTP service that sells one piece of work — a Venus Protocol health-factor read for a
BSC address — **per call, in HBAR, on Hedera testnet**, and an autonomous buyer agent that
discovers the price, pays it, and collects the answer without a human in the loop.

Payment runs over [x402](https://github.com/x402-foundation/x402) using the Hedera `exact`
scheme, settled through the [Blocky402](https://blocky402.com) facilitator. The buyer signs
an HBAR `TransferTransaction` but never pays the network fee — the facilitator co-signs as
fee payer and submits. That is the point of the Hedera exact scheme: the payer commits to an
exact transfer, the facilitator carries the gas.

Three things sit on top of that:

- **An HCS audit trail.** Every settled call writes one record to a Hedera Consensus Service
  topic — endpoint, tier, payer, price, settlement transaction, SHA-256 of the result. The
  log is public, ordered, and verifiable without trusting this service.
- **An ERC-8004 identity.** The seller is not an anonymous URL. It is AgenSea's Venus Health
  Factor Monitor, agentId **322885** in the BNB Smart Chain IdentityRegistry, registered
  before this service existed and already declaring `x402Support: true`.
- **Metered tiers.** `summary` costs half what `full` costs, quoted per request from one
  route via x402's dynamic pricing.

## Endpoints

| | | |
|---|---|---|
| `GET /` | free | Landing page: prices, payee, identity, topic, a curl that triggers the 402 |
| `GET /health` | free | Liveness, both tier prices, payee, facilitator, full agent identity |
| `GET /audit` | free | Last 10 audit records, read back from the public mirror node |
| `POST /api/venus-health` | **paid** | `{ "address": "0x…", "tier": "summary" \| "full" }` |

### Tiers

| Tier | Price | Returns |
|---|---|---|
| `summary` | 0.05 HBAR | `address`, `healthFactor`, `riskLevel`, `recommendation`, `checkedAt` |
| `full` | 0.10 HBAR | Everything above plus collateral, borrowings, liquidity/shortfall, drop-to-liquidation, and the per-market breakdown |

`full` is the default, so an omitted `tier` behaves exactly as it did before tiers existed.

## Layout

| | |
|---|---|
| `service/` | Express app. `x402.ts` wires the facilitator; `hcs.ts` owns the audit topic; `identity.ts` holds the ERC-8004 registration; `tiers.ts` the price table; `page.ts` the landing page. |
| `agent/` | CLI buyer. Provisions its own testnet account on first run, then pays per call. |
| `service/src/venus/` | Vendored from `apps/agents/src/venus/` — AgenSea's Venus Health Factor Monitor. Read-only `eth_call` against BSC mainnet; no key, no transaction. |

## Prerequisites

`hedera/.env` (git-ignored) with a funded Hedera testnet account:

```
HEDERA_NETWORK=testnet
SERVICE_ACCOUNT_ID=0.0.xxxxxxx
SERVICE_PRIVATE_KEY=0x…            # 32-byte hex or DER
SERVICE_KEY_TYPE=ECDSA             # or ED25519
FACILITATOR_URL=https://api.testnet.blocky402.com
PRICE_HBAR=0.1
PORT=4021
```

Written automatically, never by hand:

- `HCS_TOPIC_ID` — appended the first time the service starts, after it creates the topic.
- `BUYER_ACCOUNT_ID` / `BUYER_PRIVATE_KEY` / `BUYER_KEY_TYPE` — appended by the first
  `npm run buy`, after it creates and funds the buyer account.

Optional overrides: `BSC_RPC_URL` (Venus read), `MAX_SPEND_HBAR` (buyer's per-call budget,
default `1`), `SERVICE_URL` (point the buyer at a remote service), and
`AGENT_ERC8004_ID` / `AGENT_ERC8004_REGISTRY` / `AGENT_ERC8004_CHAIN_ID` /
`AGENT_ERC8004_URI` / `AGENT_LISTING_URL` to point at a different registration.

Install once:

```bash
cd hedera && npm install
```

## Run it

Terminal 1 — the service. On first start it creates the HCS topic and prints its id:

```bash
cd hedera
npm run dev
```

Terminal 2 — the buyer:

```bash
cd hedera
npm run buy -- 0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f full
npm run buy -- 0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f summary
```

The tier is a bare positional argument because `npm run` hops through two npm invocations
and npm eats an unrecognised `--tier` before the script sees it. Invoking the agent
workspace directly, `--tier summary` and `--tier=summary` both work:

```bash
npm run buy --workspace=agent -- 0x1e03…2c7f --tier summary
```

On its first run the buyer creates a fresh testnet account (same key type as the service
account), funds it with 50 HBAR from the service account, and writes the credentials into
`hedera/.env`. Every run after that reuses it.

## What a run looks like

```
using buyer account 0.0.10472377
POST http://localhost:4021/api/venus-health  { "address": "0x1e03…2c7f", "tier": "summary" }

─── service response ───
{
  "address": "0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f",
  "source": "REAL",
  "healthFactor": 1.5796,
  "riskLevel": "MODERATE",
  "recommendation": "Health factor is 1.5796. The position survives a 36.7% collateral drawdown…",
  "tier": "summary",
  "agent": { "agentId": "322885", "registry": "0x8004A169…a432", "chainId": 56, … },
  "payment": { "priceHbar": "0.05", "payer": "0.0.10472377", "settlementTx": "0.0.7162784@1789112898.381648728" },
  "audit": { "topicId": "0.0.10472717", "sequenceNumber": "1", "hashscanTopicUrl": "…" }
}

─── settlement ───
tier           summary
transaction    0.0.7162784@1789112898.381648728
hashscan       https://hashscan.io/testnet/transaction/0.0.7162784@1789112898.381648728

─── hcs audit ───
topic          0.0.10472717
sequence       1
```

## The audit trail

Topic `0.0.10472717` — [HashScan](https://hashscan.io/testnet/topic/0.0.10472717).

Created on first start with memo `AgenSea x402 audit` and the service account as both admin
and submit key: only this service can append, anyone can read. One record per settled call:

```json
{ "v": 1, "endpoint": "/api/venus-health", "tier": "full", "payer": "0.0.10472377",
  "priceHbar": "0.1", "settlementTx": "0.0.7162784@1789112920.279818410",
  "resultSha256": "ec90c58c…ab83c", "at": "2026-09-11T07:48:57.026Z" }
```

`resultSha256` commits to the exact bytes the buyer received, so a later dispute about what
was delivered is settled by hashing the response, not by taking anyone's word.

Read it back through `GET /audit`, which fetches from the public mirror node rather than
local state — the same path a third party would use:

```bash
curl -s http://localhost:4021/audit | jq
```

## The agent's identity

```
name      Venus Health Factor Monitor
agentId   322885           on BNB Smart Chain mainnet (56)
registry  0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
listing   https://agensea-navy.vercel.app/marketplace/2012
agentUri  data:application/json;base64,…  (1025 chars)
```

Surfaced in the 402 body, `GET /health`, and every paid response. An earlier registration of
the same agent lives at agentId `2012` in the BNB testnet registry
`0x8004A818BFB912233c491871b3d84c89A494BD9e` on chain 97.

The agent URI is a `data:` blob rather than a hosted AgentCard — a deliberate choice recorded
in `apps/agents/src/agent/identity.ts` after Phase 1b measured 59/59 hosted agent URIs
returning 404. Don't take this service's word for any of it; resolve it yourself:

```bash
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 "tokenURI(uint256)(string)" 322885 \
  --rpc-url https://bsc-rpc.publicnode.com
```

## The 402

An unpaid request gets the machine-readable `PAYMENT-REQUIRED` header that x402 v2 clients
use, **plus** the same document inlined in the body, the quote for the tier you asked for,
the full tier table, the agent identity, and the audit topic:

```bash
curl -s -X POST http://localhost:4021/api/venus-health \
  -H 'content-type: application/json' \
  -d '{"address":"0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f","tier":"summary"}' | jq
```

```json
{
  "error": "Payment Required",
  "quote": {
    "tier": "summary", "price": "0.05 HBAR", "amountTinybars": "5000000",
    "asset": "HBAR (native, asset id 0.0.0)", "network": "hedera:testnet",
    "payTo": "0.0.10469709", "scheme": "exact", "paymentFlow": "upfront"
  },
  "tiers": { "summary": { "priceHbar": "0.05", … }, "full": { "priceHbar": "0.1", … } },
  "agent": { "agentId": "322885", … },
  "audit": { "topicId": "0.0.10472717", … },
  "paymentRequired": { "x402Version": 2, "accepts": [ … "extra": { "paymentFlow": "upfront", "feePayer": "0.0.7162784" } ] }
}
```

`feePayer` is injected by the facilitator through `/supported` — the account that pays the
Hedera network fee, and the account the buyer's transaction id is generated against.

## Notes on the wiring

**`upfront`, not `authorization`.** x402's default Hedera flow settles *after* the handler
returns, so a response can never carry its own settlement id. The paid route declares
`extra: { paymentFlow: "upfront" }`, which the Hedera scheme supports, moving settlement in
front of the handler. An `onAfterSettle` hook drops the receipt into an `AsyncLocalStorage`
store the handler reads. That ordering is the only reason one response can contain the work,
the settlement transaction, and the HCS sequence number that records both.

**Dynamic pricing, one route.** `PaymentOption.price` accepts a function of the request
context, and the Express adapter exposes the parsed body — so the 402 quotes 0.05 or 0.1 HBAR
based on the `tier` field in the very request being priced. No split routes, no aliases.

**HCS never blocks a response for long.** `submitAudit` races the receipt against a 3-second
timeout. In practice consensus lands in well under a second and the response carries the
sequence number; if it were slow, the response goes out without it and the submit finishes in
the background. An HCS failure degrades to an `audit.error` field — it never fails a request
the buyer already paid for.

**Versions.** `@x402/core`, `@x402/express`, `@x402/fetch`, `@x402/hedera` all at `2.25.0`.

**One SDK instance.** Both packages use `@hiero-ledger/sdk` (the maintained continuation of
`@hashgraph/sdk`, same API) pinned to `2.85.0` — the version `@x402/hedera` depends on and
re-exports. Two copies of the Hedera SDK in one process cross-fail each other's `instanceof`
checks, which `@x402/hedera` warns about explicitly.

**HBAR is opted into, not waved through.** x402's client spend controls only auto-allow
"default assets", which on Hedera means USDC. Native HBAR is opted in by asset id with an
explicit per-call cap (`MAX_SPEND_HBAR`), so a service quoting more than the agreed budget is
refused before anything is signed. Turning spend controls off entirely would have been one
line shorter and materially worse.

**Swapped `.env` fields.** The provisioned `.env` had `SERVICE_PRIVATE_KEY` and
`SERVICE_KEY_TYPE` populated the wrong way round — key in the type field, EVM alias in the
key field. Both config loaders detect the two values by shape and route them correctly, so a
correct `.env` and the provisioned one both work. See `service/src/config.ts`.

**Venus fallback.** If the BSC read fails, the service returns deterministic sample data
labelled `"source": "MOCK"` with a `mockReason`, rather than failing a paid request. Live
runs return `"source": "REAL"`.
