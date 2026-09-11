# AgenSea × Hedera — x402-gated Venus health service

An HTTP service that sells one piece of work — a Venus Protocol health-factor read for a
BSC address — for **0.1 HBAR per call on Hedera testnet**, and an autonomous buyer agent
that discovers the price, pays it, and collects the answer without a human in the loop.

Payment runs over [x402](https://github.com/x402-foundation/x402) using the Hedera `exact`
scheme, settled through the [Blocky402](https://blocky402.com) facilitator. The buyer signs
an HBAR `TransferTransaction` but never pays the network fee — the facilitator co-signs as
fee payer and submits. That is the whole point of the Hedera exact scheme: the payer commits
to an exact transfer, the facilitator carries the gas.

## What runs where

| | |
|---|---|
| `service/` | Express app. `GET /health` is free; `POST /api/venus-health` is x402-gated. |
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

Optional: `BSC_RPC_URL` to override the public BSC RPC, `MAX_SPEND_HBAR` to change the
buyer's per-call budget (default `1`), `SERVICE_URL` to point the buyer at a remote service.

`BUYER_ACCOUNT_ID` / `BUYER_PRIVATE_KEY` / `BUYER_KEY_TYPE` are **appended automatically**
by the first `npm run buy`; you do not create them by hand.

Install once:

```bash
cd hedera && npm install
```

## Run it

Terminal 1 — the service:

```bash
cd hedera
npm run dev
```

Terminal 2 — the buyer, against any BSC address:

```bash
cd hedera
npm run buy -- 0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f
```

On its first run the buyer creates a fresh testnet account (same key type as the service
account), funds it with 50 HBAR from the service account, and writes the credentials into
`hedera/.env`. Every run after that reuses it.

## What a run looks like

```
using buyer account 0.0.10472377
POST http://localhost:4021/api/venus-health  { "address": "0x1e03…2c7f" }

─── service response ───
{
  "address": "0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f",
  "source": "REAL",
  "healthFactor": 1.5811,
  "riskLevel": "MODERATE",
  "collateralUsd": 49040.82,
  "borrowedUsd": 24812.94,
  "priceDropToLiquidation": 0.3675,
  "recommendation": "Health factor is 1.5811. The position survives a 36.8% collateral drawdown…"
}

─── settlement ───
success        true
payer          0.0.10472377
transaction    0.0.7162784@1789110994.150057670
hashscan       https://hashscan.io/testnet/transaction/0.0.7162784@1789110994.150057670
```

## The 402

An unpaid request gets the machine-readable `PAYMENT-REQUIRED` header that x402 v2 clients
use, **plus** the same document inlined in the body so it is readable without base64:

```bash
curl -s -X POST http://localhost:4021/api/venus-health \
  -H 'content-type: application/json' \
  -d '{"address":"0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f"}' | jq
```

```json
{
  "error": "Payment Required",
  "quote": {
    "price": "0.1 HBAR",
    "amountTinybars": "10000000",
    "asset": "HBAR (native, asset id 0.0.0)",
    "network": "hedera:testnet",
    "payTo": "0.0.10469709",
    "facilitator": "https://api.testnet.blocky402.com",
    "scheme": "exact"
  },
  "paymentRequired": { "x402Version": 2, "accepts": [ { "…": "…", "extra": { "feePayer": "0.0.7162784" } } ] }
}
```

`feePayer` is injected by the facilitator through `/supported` — it is the account that
pays the Hedera network fee, and the buyer's transaction id is generated against it.

## Notes on the wiring

**Versions.** `@x402/core`, `@x402/express`, `@x402/fetch`, `@x402/hedera` all at `2.25.0`,
matching what the packages ship against each other.

**One SDK instance.** The agent uses `@hiero-ledger/sdk` (the maintained continuation of
`@hashgraph/sdk`, same API) pinned to `2.85.0` — the version `@x402/hedera` depends on and
re-exports. Two copies of the Hedera SDK in one process cross-fail each other's `instanceof`
checks, which `@x402/hedera` warns about explicitly.

**HBAR is opted into, not waved through.** x402's client spend controls only auto-allow
"default assets", which on Hedera means USDC. Native HBAR is opted in by asset id with an
explicit per-call cap (`MAX_SPEND_HBAR`), so a service quoting more than the agreed budget
is refused before anything is signed. Turning spend controls off entirely would have been
one line shorter and materially worse.

**Swapped `.env` fields.** The provisioned `.env` had `SERVICE_PRIVATE_KEY` and
`SERVICE_KEY_TYPE` populated the wrong way round — key in the type field, EVM alias in the
key field. Both config loaders detect the two values by shape and route them correctly, so
a correct `.env` and the provisioned one both work. See `service/src/config.ts`.

**Venus fallback.** If the BSC read fails, the service returns deterministic sample data
labelled `"source": "MOCK"` with a `mockReason`, rather than failing a paid request. Live
runs return `"source": "REAL"`.
