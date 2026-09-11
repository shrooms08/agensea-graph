# Agent0 subgraph — real schema notes

Source: live GraphQL introspection of the BSC mainnet deployment
`D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K` on 11 Sep 2026, not the README.
The Ethereum mainnet deployment introspects to a **byte-identical** SDL, so the
types below are safe to treat as chain-independent.

Deployment at time of writing: `QmaNus7TyK4uBnUqd4J12XddVjZMifh4EB3wKz3SzQ6huS`,
BSC block 121,211,659, `hasIndexingErrors: false`.

Reproduce with:

```
curl -sS -X POST "https://gateway.thegraph.com/api/$THEGRAPH_API_KEY/subgraphs/id/$SUBGRAPH_ID" \
  -H 'content-type: application/json' \
  -d '{"query":"{ __schema { types { name kind fields { name } } } }"}'
```

---

## Surprises worth reading before you write a query

These are the four places where the real schema differs from what the ERC-8004
docs lead you to expect. Each one changed the code in `lib/graph/`.

1. **`Protocol` is not a rollup.** It carries only `chainId`, `name` and the
   three registry addresses. It has **no** `totalAgents` / `totalFeedback`
   counters. Anything adoption-shaped has to be derived.

2. **The `*Stats` entities are timeseries aggregations, not entities you can
   join to.** They are queried as `agentFeedbackStats_collection(interval: …)`,
   they have an `Int8!` id and a `Timestamp!`, and they are **not** reachable as
   a field on `Agent`. There is no `agent.stats`.

3. **Those aggregations are CUMULATIVE running totals, not per-bucket deltas.**
   This is the one that silently produces garbage. Summing the daily buckets of
   `protocolAgentStats_collection` gives 29,025,949 "registrations" on a chain
   whose highest agentId is 344,805. The correct read is **the single latest
   bucket**: `orderBy: timestamp, orderDirection: desc, first: 1,
   current: include`. Verified against ground truth — agent `56:30867` has
   `Agent.totalFeedback = 234` and its latest `agentFeedbackStats` bucket reads
   `feedbackCreated: 234`.

4. **`Validation` is empty on BSC.** BSC's `Protocol.validationRegistry` is
   `0x0000…0000` — no validation registry is deployed there, so `validations`
   returns `[]` and `protocolValidationStats_collection` has zero buckets. Code
   must treat an absent validation rollup as "not deployed", not as an error.

And four smaller ones:

- Feedback's score field is called **`value`** (a `BigDecimal`), not `score` —
  and it is **not a bounded 0–100 rating**. Its unit is whatever `tag1` says.
  Real BSC rows on agent `56:302257`: `60` under `outcome:partially`, `100`
  under `uptime`, `236` under `responseTime` (milliseconds). Rendering `value`
  as a star rating without reading `tag1` produces nonsense.
- Because `value` is unbounded, **`valueSum` can be enormous**. Base's latest
  bucket reads `251142355038140767847409093856573900000` (~2.5e38) across
  472,515 feedback rows — one row carrying a raw wei-scale number dominates the
  total. It does not survive `Number()`, so `ChainAdoption` carries both
  `feedbackValueSum` (convenient, lossy) and `feedbackValueSumRaw` (exact).
- `feedbackFile` is frequently `null` (the off-chain file was never fetched or
  never published), exactly as `registrationFile` is. Both need null handling.
  When it is present, `text` is still often `null` — of the 8 feedback entries
  on `56:302257`, 3 have a file and none of those has `text`.
- `interval` only accepts **`hour`** and **`day`**. There is no `week`/`month`.

## ID conventions

- `Agent.id` is the composite string `"{chainId}:{agentId}"` — `"56:0"`,
  `"56:344805"`. Sequential from 0, matching the identity registry's counter.
- `Feedback.id` is `"{chainId}:{agentId}:{clientAddress}:{feedbackIndex}"`,
  e.g. `"56:302257:0x13450a106568d011d25d8ac222b489b098df9196:2"`.
- `AgentRegistrationFile.id` / `FeedbackFile.id` are keyed by the content CID.

---

## Entities

### `Agent`

```graphql
id: ID!                                   # "{chainId}:{agentId}"
chainId: BigInt!
agentId: BigInt!
agentURI: String                          # often a data:application/json;base64 URI
agentURIType: String
owner: Bytes!
agentWallet: Bytes
operators: [Bytes!]!
createdAt: BigInt!
updatedAt: BigInt!
registrationFile: AgentRegistrationFile   # nullable
feedback: [Feedback!]!
validations: [Validation!]!
metadata: [AgentMetadata!]!
totalFeedback: BigInt!                    # denormalised on the entity — cheap to filter/sort on
lastActivity: BigInt!
```

`totalFeedback` and `lastActivity` being plain fields is what makes
`where: { totalFeedback_gt: 0 }` and `orderBy: totalFeedback` possible without
touching the aggregations at all.

### `AgentRegistrationFile`

```graphql
id: ID!            cid: String!        agentId: String!
name: String       description: String image: String
active: Boolean    x402Support: Boolean
supportedTrusts: [String!]!
endpointsRawJson: String
mcpEndpoint: String  mcpVersion: String
a2aEndpoint: String  a2aVersion: String
webEndpoint: String
oasfEndpoint: String oasfVersion: String
oasfSkills: [String!]!  oasfDomains: [String!]!  hasOASF: Boolean!
emailEndpoint: String   ens: String   did: String
mcpTools: [String!]!    mcpPrompts: [String!]!   mcpResources: [String!]!
a2aSkills: [String!]!
createdAt: BigInt!
```

### `Feedback`

```graphql
id: ID!            agent: Agent!
clientAddress: Bytes!   feedbackIndex: BigInt!
value: BigDecimal!                    # the score
tag1: String  tag2: String            # e.g. "outcome:partially", "rehire:yes"
endpoint: String
feedbackURI: String  feedbackURIType: String  feedbackHash: Bytes
isRevoked: Boolean!  createdAt: BigInt!  revokedAt: BigInt
feedbackFile: FeedbackFile            # nullable
responses: [FeedbackResponse!]!
```

### `FeedbackFile`

```graphql
id: ID!  cid: String!  feedbackId: String!
agentRegistry: String  agentId: BigInt  clientAddress: String
createdAtIso: String
valueRaw: BigInt  valueDecimals: Int
text: String                          # the human-readable review
mcpTool: String  mcpPrompt: String  mcpResource: String
a2aSkills: [String!]!  a2aContextId: String  a2aTaskId: String
oasfSkills: [String!]!  oasfDomains: [String!]!
proofOfPaymentFromAddress: String  proofOfPaymentToAddress: String
proofOfPaymentChainId: String      proofOfPaymentTxHash: String
tag1: String  tag2: String  createdAt: BigInt!
```

### `FeedbackResponse`

```graphql
id: ID!  feedback: Feedback!  responder: Bytes!
responseUri: String  responseHash: Bytes  createdAt: BigInt!
```

### `Validation`

```graphql
id: ID!  agent: Agent!  validatorAddress: Bytes!
requestUri: String  requestHash: Bytes!
response: Int  responseUri: String  responseHash: Bytes
tag: String
status: ValidationStatus!             # PENDING | COMPLETED | EXPIRED
createdAt: BigInt!  updatedAt: BigInt!
```

### `AgentMetadata`

```graphql
id: ID!  agent: Agent!  key: String!  value: Bytes!  updatedAt: BigInt!
```

### `Protocol` — per-chain, but NOT a rollup

```graphql
id: ID!                   # the chainId as a string, e.g. "56"
chainId: BigInt!
name: String!             # "BSC Mainnet"
identityRegistry: Bytes!
reputationRegistry: Bytes!
validationRegistry: Bytes!   # 0x0000…0000 on BSC — not deployed
createdAt: BigInt!  updatedAt: BigInt!
```

---

## Timeseries aggregations

Raw per-event timeseries (queryable directly, one row per event):
`AgentRegistrationPoint`, `FeedbackPoint`, `ValidationPoint`.

Aggregated rollups, all **cumulative** and all requiring `interval: hour|day`:

| Query field | Dimension | Cumulative fields |
|---|---|---|
| `protocolAgentStats_collection` | `protocol` | `agentRegistrations: Int8!` |
| `protocolFeedbackStats_collection` | `protocol` | `feedbackCreated`, `feedbackRevoked`, `valueSum`, `valueDeltaSum` |
| `protocolValidationStats_collection` | `protocol` | `validationRequests`, `validationResponses`, `scoreSum` |
| `agentFeedbackStats_collection` | `protocol`, `agent` | `feedbackCreated`, `feedbackRevoked`, `valueSum`, `valueDeltaSum` |
| `agentValidationStats_collection` | `protocol`, `agent` | `validationRequests`, `validationResponses`, `scoreSum` |

`timestamp` is a `Timestamp!` in **microseconds** (`1789084800000000`), not
seconds — unlike every `createdAt` on the entities above, which are seconds.

## "Agents with at least one feedback"

Not available from any rollup: the aggregations are dimensioned by agent, so
counting distinct agents in them still means paging. The cheapest correct route
is the denormalised field on `Agent`:

```graphql
agents(first: 1000, orderBy: id, orderDirection: asc,
       where: { totalFeedback_gt: 0, id_gt: $cursor }) { id }
```

Keyset-paged on `id_gt` (not `skip`, which the gateway caps at 5,000 and would
stop counting there silently). Measured 11 Sep 2026:

| Chain | Agents with ≥1 feedback | Pages | Time |
|---|---|---|---|
| BSC | 4,448 | 5 | ~3s |
| Base | 29,783 | 30 | ~11s |
| Ethereum | 1,681 | 2 | ~1s |
| Polygon | 159 | 1 | <1s |

`lib/graph/queries.ts` does exactly this behind a 40-page cap and returns an
`exact` flag, so a truncated count can never be mistaken for a real one. The
cap is sized off Base: a 20-page cap reported Base as a flat "20,000". Pass
`agentsWithFeedbackMaxPages: 0` to skip the count — it is the only part of
`getChainAdoption` that is not O(1).

Total agent count comes from the latest `protocolAgentStats` bucket instead,
which is O(1) — and cross-checks against `max(agentId) + 1`.
