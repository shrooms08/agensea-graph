# ETHGlobal submission — draft copy

Draft text for the ETHOnline 2026 submission form. Every figure here matches the root
[README](../../README.md); update both together.

- **Repo:** https://github.com/shrooms08/agensea-graph
- **Live:** https://agensea-graph.vercel.app · [/scout](https://agensea-graph.vercel.app/scout) · [/adoption](https://agensea-graph.vercel.app/adoption)
- **Pool:** Continuity ("Extend Open Source"). Pre-existing work is tagged `pre-hackathon-baseline` (`e0d1392`); only work after that tag is submitted.
- **Demo video:** https://youtu.be/l2mFW1gmD4M
- **Licence:** MIT — [LICENSE](../../LICENSE)

---

## Project name

**AgenSea Trust Layer**

## Tagline (2 sentences)

> ERC-8004 registries hold hundreds of thousands of agents and almost none of them have ever
> been used. AgenSea's Trust Layer reads The Graph's Agent0 subgraphs across five chains to
> answer the question that actually matters — can I trust this one? — and shows you every
> query behind the answer.

## Description (~250 words)

Anyone can mint an ERC-8004 agent. On BNB Smart Chain 345,162 have been registered and just
4,448 — **1.3%** — have ever received a single piece of feedback. Discovery is solved;
trust is not.

The Trust Layer is two surfaces over The Graph's Agent0 subgraphs.

**Scout** is a natural-language trust analyst. Ask "is 56:30867 safe to hire?" and it runs a
tool loop over the subgraphs, computes trust signals from what comes back, and returns a
verdict card: liveness, per-tag reputation, flags, a hire/caution/avoid recommendation and a
confidence. The signals are not the model's opinion — reviewer concentration, burstiness over
a sliding 24-hour window, and per-tag score ranges are computed in pure, unit-tested
arithmetic the model cannot fudge. It is told to cite a tool for every claim and to answer
"insufficient data" rather than guess. Under each answer, an Evidence panel lists every
GraphQL document it ran, with variables, row counts and latency.

**Adoption** charts registered agents against agents with feedback across all five chains —
one query pattern run against five deployments of one shared schema.

The result is a check that already found something: The Graph puts BSC adoption at 1.3%,
and AgenSea's own independent full-registry sweep put it at 1.35%. Two entirely separate
data paths agreeing is a far stronger claim than either number alone — and it is the kind of
cross-check a standardised subgraph schema makes cheap.

## How it's made (~300 words)

Next.js 16 App Router on Vercel. `lib/graph` is a server-only gateway client: the API key
sits in the URL path, so the module never logs a URL and redacts the key out of nested fetch
errors, with a 10s `AbortController` timeout and a typed `GraphError` carrying the subgraph
ID and the GraphQL errors array.

Types were transcribed from **live GraphQL introspection**, not from docs — which is how we
found that `Protocol` is not a rollup at all, and that the `*Stats` entities are timeseries
aggregations holding **cumulative** running totals. Summing their daily buckets yields
29,025,949 "registrations" on a chain whose highest agentId is ~345k; the correct read is the
single latest bucket with `current: include`.

Search uses **nested subgraph filters** — `Agent_filter.registrationFile_` composed under a
top-level `or` — so a name/description search runs server-side across all 345k BSC agents
instead of paging the top N and filtering in JS.

Scout is the **Vercel AI SDK v7** (`streamText`, `stopWhen: stepCountIs(8)`, `prepareStep`)
with four tools. Evidence is captured by an `AsyncLocalStorage` recorder inside the gateway
client — the only layer that knows the query text — and streamed to the browser as a
`data-evidence` part rather than returned in the tool result, which kept ~20KB of GraphQL
text out of the model's context each step. A two-tier time budget uses `prepareStep` to
disable data-gathering tools at 20s and all tools at 38s, so a slow run still ends with prose
instead of being cut off mid-loop.

`unstable_cache` (3600s, tagged) holds the adoption rollup, and the page, the API route and
Scout's tool all read the **same entry**, so the three cannot disagree.

A 429 whose body says "per day"/TPD/RPD fails the whole request over to a second vendor;
per-minute 429s just back off. 86 unit tests, no network, no model.

---

## Partner: The Graph

**Tracks:** Best AI Tooling or AI Use Case (Continuity) · Best Use of Composable or
Standardized Graph Products.

**Subgraphs used** — five deployments of the Agent0 schema, via the decentralised gateway:

| Chain | Subgraph ID |
|---|---|
| BSC Mainnet (56) | `D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K` |
| Ethereum Mainnet (1) | `FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k` |
| Base Mainnet (8453) | `43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb` |
| Polygon Mainnet (137) | `9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF` |
| Monad Mainnet (143) | `4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg` |

**Why it's composable:** comparing BSC to Base is the same code with a different subgraph ID.
Because Agent0 standardises the schema across chains, the adoption page is one query pattern
run five times — the cross-chain view costs nothing extra to build. `/adoption` also deep-links
into `/scout?chain=<chainId>`, so a chain-level finding leads straight into agent-level
reasoning over the same data.

**Why it's real AI tooling:** the model never invents a figure. Every number originates in a
subgraph query, the trust arithmetic is computed outside the model, and the Evidence panel
publishes the exact GraphQL behind each answer.

### Feedback for The Graph

Offered in the spirit of the docs being good and these three costing us real time:

1. **Counting entities has a pagination trap.** There is no `count` aggregate, so
   "how many agents have feedback?" means keyset-paging `agents(where: { totalFeedback_gt: 0 })`
   1,000 at a time. We first capped at 20 pages, which silently truncated Base to exactly
   20,000 — a plausible-looking wrong number with no error. Our fix was a 40-page cap plus an
   explicit `agentsWithFeedbackExact: false` flag, but a native count, or a documented warning
   on this pattern, would prevent a class of quietly-wrong dashboards.
2. **Cumulative aggregations read like deltas.** `protocolAgentStats_collection` returns
   running totals, so the natural instinct — sum the buckets for a period — produces
   29,025,949 registrations on a ~345k-agent chain. Nothing in the field names signals
   "cumulative". A naming convention (`…Total` vs `…Delta`) or a schema-level note would help.
   `current: include` also matters more than it appears: without it the in-progress bucket is
   dropped and a brand-new agent reads as having no stats at all.
3. **Monad's indexer has been unavailable for the whole event.** The ID from the official
   catalogue returns `bad indexers: {0xbdfb…: Unavailable(no status: failed to get indexing
   progress)}` on every attempt. A wrong ID and an unindexed deployment surface almost
   identically, which made this slow to diagnose — a distinguishable error, or a
   catalogue-level health indicator, would have saved an hour.

---

## Partner: Hedera

**Track:** AI & Agentic Payments. Full detail, verification links and the five on-chain
settlements are in [`hedera/README.md`](../../hedera/README.md).

**What it is:** AgenSea's Venus Health Factor Monitor — ERC-8004 agentId 322885, already
registered on BNB Smart Chain — is made hireable *by another agent*, with no human in the
loop. The buyer agent requests work, receives an HTTP 402 quote, signs an exact HBAR transfer
as payer only, and the Blocky402 facilitator verifies that signature, co-signs as fee payer
and settles it on Hedera testnet. The buyer spends exactly the quoted price and never pays
gas. Every completed sale is written to a Hedera Consensus Service topic
(`0.0.10472717`) carrying a SHA-256 of the delivered bytes, so what was sold, to whom, for
how much, and under which settlement transaction is publicly auditable without trusting the
seller.

**Pay-per-call metering:** two tiers priced from the request body via x402 `DynamicPrice` on
one route — 0.05 HBAR for `summary`, 0.10 for `full`, charged on chain.

**The interesting bit:** x402's default Hedera flow is `authorization`, which settles *after*
the handler has written its response — so a response can never contain its own settlement id.
Declaring `extra: { paymentFlow: "upfront" }` moves settlement in front of the handler, and an
`onAfterSettle` hook drops the receipt into an `AsyncLocalStorage` store the handler reads.
That ordering is the only reason one response can carry the work, the settlement transaction,
and the HCS sequence number recording both.

**Live:** https://agensea-hedera-x402.fly.dev · topic
[`0.0.10472717`](https://hashscan.io/testnet/topic/0.0.10472717) (5 settled sales, all SUCCESS).
