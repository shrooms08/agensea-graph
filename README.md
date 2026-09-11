# AgenSea Trust Layer

**ETHOnline 2026 · Continuity pool ("Extend Open Source")**

ERC-8004 registries now hold hundreds of thousands of agents, and almost none of them have
ever been used. AgenSea's Trust Layer answers the question that follows — *can I trust this
one?* — by reasoning over live data from The Graph's Agent0 subgraphs across five chains.
**Scout** is a natural-language trust analyst that computes reviewer concentration, burst
patterns and per-tag score ranges from real subgraph queries, then shows you every query it
ran. **Adoption** charts how little of each registry is actually in use. Every figure on
both pages traces to a GraphQL query you can read.

**Live: https://agensea-graph.vercel.app** · [**/scout**](https://agensea-graph.vercel.app/scout) · [**/adoption**](https://agensea-graph.vercel.app/adoption)

---

## What was built during ETHOnline

Everything below is `pre-hackathon-baseline..main`
([compare](https://github.com/shrooms08/agensea-graph/compare/pre-hackathon-baseline...main)) —
33 commits, 60 files, +13,756 lines.

- **Graph data layer** — [`apps/web/lib/graph/`](apps/web/lib/graph/): a server-only gateway
  client with timeouts and key redaction (`client.ts`), a five-chain registry (`chains.ts`),
  typed entities transcribed from live introspection (`types.ts`), the queries
  (`queries.ts`), an `AsyncLocalStorage` evidence recorder (`evidence.ts`) and the shared
  hourly cache (`adoption-cache.ts`). Schema notes in
  [`docs/hackathon/agent0-schema-notes.md`](docs/hackathon/agent0-schema-notes.md).
  ([`129daea..c7b67de`](https://github.com/shrooms08/agensea-graph/compare/129daea...c7b67de))
- **Scout, the trust analyst** — [`/scout`](https://agensea-graph.vercel.app/scout),
  [`apps/web/app/api/scout/route.ts`](apps/web/app/api/scout/route.ts),
  [`apps/web/lib/scout/`](apps/web/lib/scout/). A four-tool AI SDK loop over the subgraphs;
  `analysis.ts` computes the trust signals in pure, unit-tested arithmetic the model cannot
  fudge. ([`96cf1a5..f47762a`](https://github.com/shrooms08/agensea-graph/compare/96cf1a5...f47762a))
- **Cross-chain adoption** — [`/adoption`](https://agensea-graph.vercel.app/adoption),
  [`apps/web/app/adoption/page.tsx`](apps/web/app/adoption/page.tsx),
  [`/api/graph/adoption`](https://agensea-graph.vercel.app/api/graph/adoption). One query
  pattern across five deployments, rendered with plain divs — no chart library.
  ([`f613fb6..b1aa803`](https://github.com/shrooms08/agensea-graph/compare/f613fb6...b1aa803))
- **Provider failover** — [`apps/web/lib/llm.ts`](apps/web/lib/llm.ts). A 429 that means
  "daily quota gone" is routed to a second vendor; a per-minute 429 gets a short backoff on
  the same one. ([`7744646`](https://github.com/shrooms08/agensea-graph/commit/7744646))
- **Hardening** — single-submission Scout, one card per agent, and a footer job lookup that
  cannot drift. ([`c25f900..f3cfaef`](https://github.com/shrooms08/agensea-graph/compare/c25f900...f3cfaef))
- **Hedera: agents hiring agents** — [`hedera/`](hedera/). An x402-gated service that makes
  the Venus Health Factor Monitor hireable by another agent with no human in the loop, paid
  per call in HBAR on Hedera testnet, with every sale written to a Hedera Consensus Service
  topic. Full detail and verification links in [`hedera/README.md`](hedera/README.md).
  ([`fbab343..58511a3`](https://github.com/shrooms08/agensea-graph/compare/fbab343...58511a3))

## What existed before

Tagged [`pre-hackathon-baseline`](https://github.com/shrooms08/agensea-graph/releases/tag/pre-hackathon-baseline)
(`e0d1392`). **Only work after that tag is submitted for judging.** The pre-existing README
is preserved verbatim at [`docs/PRE-HACKATHON-README.md`](docs/PRE-HACKATHON-README.md).

- A marketplace and registry explorer for ERC-8004 on BNB Smart Chain.
- Its own full-registry sweep over Multicall3 — the source of the independent 1.35% figure
  this project cross-checks against The Graph.
- A Supabase data layer holding sweep results, with RLS and an anon read path.
- Four first-party agents (health factor, rebalancing, grid trading, yield optimisation).
- ERC-8183 session-key hiring: hire an agent, get a hash-verifiable deliverable, revoke.

The Trust Layer adds no dependency on any of it: `lib/graph`, `lib/scout`, `/scout` and
`/adoption` read The Graph only.

## How The Graph is used

All five are deployments of one shared Agent0 schema on The Graph Network, queried through
the decentralised gateway. IDs live in [`apps/web/lib/graph/chains.ts`](apps/web/lib/graph/chains.ts).

| Chain | Subgraph ID | What is queried |
|---|---|---|
| BSC Mainnet (56) | `D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K` | Agents, registration files, feedback + feedback files, validations, protocol + agent rollups |
| Ethereum Mainnet (1) | `FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k` | Adoption rollup, agents-with-feedback count |
| Base Mainnet (8453) | `43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb` | Adoption rollup, agents-with-feedback count |
| Polygon Mainnet (137) | `9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF` | Adoption rollup, agents-with-feedback count |
| Monad Mainnet (143) | `4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg` | Same pattern; indexer currently unavailable (handled, see below) |

Why it is load-bearing rather than decorative:

- **Every claim Scout makes comes from a subgraph query, and you can read the query.** The
  Evidence panel under each answer lists the GraphQL document, the variables, the row count
  and the latency for every call the answer rests on. The system prompt forbids stating any
  number that did not come from a tool result.
- **The adoption page is one query pattern run across five deployments of one schema.**
  Because Agent0 standardises the schema, comparing BSC to Base is the same code with a
  different subgraph ID — that is the composability argument made concrete.
- **Nested filters make search work across the whole registry.** `Agent_filter` exposes
  `registrationFile_`, so `or: [{ name_contains_nocase }, { description_contains_nocase }]`
  searches all **345,162** BSC agents server-side. The naive fallback — page the top N and
  filter in JS — would have searched 5,000 and silently missed the rest.
- **It independently cross-checks our own measurement.** AgenSea's full on-chain sweep put
  BSC adoption at **1.35%**; The Graph puts it at **1.3%**. Two methods, two data paths, the
  same answer. One number from one source is just a number.

## Key findings from the data

Live at the `fetchedAt` stamp on [`/api/graph/adoption`](https://agensea-graph.vercel.app/api/graph/adoption)
(figures below: 11 Sep 2026, 20:06 UTC).

| Chain | Registered | With feedback | Adoption | Feedback created |
|---|---|---|---|---|
| Base Mainnet | 86,093 | 29,783 | **34.6%** | 473,623 |
| Polygon Mainnet | 658 | 159 | **24.2%** | 499 |
| Ethereum Mainnet | 50,781 | 1,681 | **3.3%** | 3,445 |
| BSC Mainnet | 345,162 | 4,448 | **1.3%** | 29,814 |
| Monad Mainnet | — | — | indexer unavailable | — |

- **The headline: registration is not adoption.** BSC has by far the most agents and by far
  the lowest share that anyone has ever reviewed.
- **The `*Stats` aggregations are CUMULATIVE running totals, not per-bucket deltas.** Summing
  the daily buckets of `protocolAgentStats_collection` yields 29,025,949 "registrations" on a
  chain whose highest agentId is ~345k. The correct read is the single latest bucket with
  `current: include`. This is the easiest way to get a confidently wrong number out of this
  schema.
- **`Feedback.value` has no fixed unit — `tag1` defines it.** 100 under `uptime` is a
  percentage; 236 under `responseTime` is milliseconds. Averaging across tags is meaningless,
  so `TrustSignals` exposes per-tag stats and deliberately has no overall mean anywhere.
- **No validation registry is deployed on any live chain.** Every
  `Protocol.validationRegistry` is the zero address, so zero validations is expected and is
  not evidence against an agent. Scout is told this explicitly.
- **Monad's indexer has been returning `bad indexers … Unavailable` throughout.** The ID is
  correct (from The Graph's own catalogue); the deployment does not answer. `Promise.allSettled`
  reports it as `{ ok: false }` and the UI renders "indexer unavailable" with **no bar** — a
  zero-length bar would assert a 0% measurement we do not have.

## Architecture

```
Scout (reasoning path, dynamic)
  browser  ──►  /scout (static page)
                   │  POST
                   ▼
              /api/scout ──► AI SDK tool loop (max 8 steps, 56s budget)
                   │           ├─ search_agents        ─┐
                   │           ├─ get_trust_profile    ─┤
                   │           ├─ get_chain_adoption   ─┤──► lib/graph ──► gateway.thegraph.com
                   │           └─ emit_verdict          │       (server-only,      │
                   │              (deduped server-side) │        10s timeout)      ▼
                   │                                    │              Agent0 subgraphs (x5)
                   │           lib/scout/analysis.ts ◄──┘
                   │              (pure arithmetic: concentration,
                   │               burstiness, per-tag stats, flags)
                   ▼
           UI message stream ──► answer · verdict cards · Evidence panel
                                 (every GraphQL query, rows, latency)

Adoption (cached path, static)
  /adoption page ─┐
                  ├─► cachedAdoptionSnapshot()  ──►  lib/graph ──► Agent0 subgraphs (x5)
  /api/graph/…  ─┘    unstable_cache, 3600s, tag "agent0-adoption"
  Scout's get_chain_adoption reads the SAME entry, so the three can never disagree.
```

## Run it locally

Requires **Node 24+** (the tests rely on native TypeScript type stripping) and a free
[The Graph API key](https://thegraph.com/studio/apikeys/).

```bash
git clone https://github.com/shrooms08/agensea-graph.git
cd agensea-graph

# The web app, plus the agents workspace it imports from (same as Vercel's installCommand)
npm --prefix apps/web install
npm --prefix apps/agents install --omit=dev
```

Create `.env.local` **at the repo root** (not in `apps/web` — `with-root-env.sh` exports it),
using [`.env.example`](.env.example) as the reference. The Trust Layer needs only:

```bash
THEGRAPH_API_KEY=            # required: every subgraph read
LLM_PROVIDER=groq            # groq | google | anthropic | openai  (default groq)
LLM_FALLBACK_PROVIDER=google # used only on a daily-quota 429; "none" disables
GROQ_API_KEY=                # key for whichever provider is active
GOOGLE_GENERATIVE_AI_API_KEY=# key for the fallback
```

`/scout` and `/adoption` need nothing else. The **pre-existing** pages additionally need
`SUPABASE_URL` and `SUPABASE_ANON_KEY`; without them the shared layout throws at module
evaluation and every route 500s, so set them to any placeholder if you only want the Trust
Layer.

```bash
cd apps/web
npm run dev:env          # loads the repo-root .env.local, serves on :3111
```

Open [http://localhost:3111/scout](http://localhost:3111/scout),
[http://localhost:3111/adoption](http://localhost:3111/adoption), and
[http://localhost:3111/api/graph/adoption](http://localhost:3111/api/graph/adoption).

```bash
npm run graph:smoke      # proves the data layer against all five live subgraphs, no LLM
npm test                 # 86 assertions, no network, no model
npm run typecheck
```

`graph:smoke` is the fastest way to confirm your Graph key works: it prints the adoption
rollup per chain, five BSC agent names, and a full trust profile as JSON.

## AI usage disclosure

- **Claude (claude.ai)** acted as tech lead: it wrote the plans and the prompts.
- **Claude Code** executed all of the coding from those prompts. Every prompt is saved
  verbatim and in order in [`docs/hackathon/prompts/`](docs/hackathon/prompts/) —
  `01-graph-data-layer`, `02-scout`, `03-groq-provider`, `04-adoption-page`, `05-hardening`,
  `06-readme`. The commit history maps onto them one-to-one.
- **Minos** directed the product decisions, ran every deploy and test, and reviewed the
  output at each step.
- At **runtime**, Scout is powered by Groq `openai/gpt-oss-120b`, with Gemini
  `gemini-3.8-flash` as the daily-quota failover. The model chooses which tools to call and
  writes the prose; it does not compute any trust signal — that arithmetic is in
  `lib/scout/analysis.ts` and is unit-tested.

## Known limitations

- **Groq's free tier is 200,000 tokens/day.** Scout spends one request per reasoning step,
  so heavy use exhausts it. When that happens the daily-quota classifier routes the next
  request to Gemini and the "answered by" line under the answer names the model that
  actually replied. If both are exhausted, Scout says so rather than failing silently.
- **Monad's subgraph is unavailable** and has been throughout. It renders as "indexer
  unavailable", never as 0%.
- **No chain has a validation registry**, so Scout's `VALIDATION_UNAVAILABLE` flag fires on
  every agent and is informational only.
- **`NAME_LOOKALIKE` is a heuristic** against a hand-kept list of well-known handles. It has
  false positives and false negatives, is flagged `heuristic: true`, and is reported as
  "worth verifying" — never as proof of impersonation.
- **A Scout answer takes roughly 5 to 50 seconds.** Free-tier latency is highly variable; a
  56s deadline stops the tool loop in time to still write a summary, and says so if it fires.
- **`agentsWithFeedback` is paginated with a 40-page cap.** Above 40,000 the figure becomes a
  lower bound, flagged by `agentsWithFeedbackExact: false` and rendered with a `+`.

## Demo video

<!-- TODO: paste the ETHGlobal demo video link here before submitting -->
_To be added._

## Licence

**Not yet licensed.** This repository has no `LICENSE` file. The Continuity pool and The
Graph's track both expect open source, so a licence (MIT or Apache-2.0) should be added
before submitting — until then "open source" is an intention, not a grant.
