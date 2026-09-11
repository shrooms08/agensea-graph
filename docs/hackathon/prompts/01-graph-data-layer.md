You are working in the AgenSea repo, a Next.js/TypeScript app on Vercel that is an ERC-8004 agent marketplace and registry explorer for BNB Chain. This repo is a hackathon copy for ETHOnline 2026 (The Graph track, Continuity pool). We are adding The Graph's Agent0 subgraphs as a live data source. Do not modify any existing pages, components, or Supabase code in this task. Only add new files under lib/graph/, scripts/, and docs/hackathon/.

STEP 0. Before anything else, create docs/hackathon/prompts/01-graph-data-layer.md and paste this entire prompt into it verbatim. Commit it on a new branch: git checkout -b feat/graph-data-layer, then commit with message "docs: save prompt 01 (graph data layer)".

STEP 1. Read the repo enough to answer: is it app router or pages router, what TypeScript strictness is set, what fetch/HTTP helpers already exist, where env vars are read, and whether there is an existing types file for agents. Do not change any of it. Summarize in 5 lines.

STEP 2. Introspect the real subgraph schema. The BSC mainnet Agent0 subgraph ID is D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K. The gateway URL pattern is https://gateway.thegraph.com/api/{THEGRAPH_API_KEY}/subgraphs/id/{SUBGRAPH_ID}. THEGRAPH_API_KEY is already in .env.local. Run a GraphQL introspection query (or fetch the schema from https://github.com/agent0lab/subgraph) and write the actual entity names and fields into docs/hackathon/agent0-schema-notes.md. I expect entities like Agent, AgentRegistrationFile, Feedback, FeedbackFile, Validation, a per-agent stats rollup, and a per-chain Protocol rollup, but use what the schema actually says. Note: agent IDs are strings in the form "chainId:agentId" such as "56:0". Some agents have registrationFile null.

STEP 3. Find the subgraph IDs for the other four Agent0 deployments (Ethereum mainnet, Base mainnet, Monad mainnet, Polygon mainnet). Fetch https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/ which lists them. Known so far: BSC is D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K, Base is very likely 43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb. If you cannot confirm an ID, leave it as an empty string in the config with a TODO and do not invent one.

STEP 4. Create these files:

lib/graph/chains.ts: export a typed array of the five chains with chainId, name, slug, subgraphId, and an explorer base URL for tx and address links. BSC first. Export helpers getChainById(chainId) and getChainBySlug(slug).

lib/graph/client.ts: server-only (import "server-only" at top). One function graphQuery<T>(subgraphId, query, variables) that POSTs to the gateway with the API key from process.env.THEGRAPH_API_KEY, 10 second AbortController timeout, throws a typed GraphError with the subgraph ID and the GraphQL errors array on failure, and returns data on success. Never log the API key. If the env var is missing, throw a clear error at call time, not at import time.

lib/graph/types.ts: TypeScript types for the entities you found in STEP 2, matching the real schema field names.

lib/graph/queries.ts: typed functions built on graphQuery, each accepting a chainId as the first argument and resolving the subgraph ID via chains.ts:
  - listAgents({ chainId, first, skip, orderBy }): agents with their registrationFile (name, description, and whatever capability/endpoint fields exist) and the stats rollup if it is a direct relation.
  - getAgentTrustProfile({ chainId, agentId }): the single agent, its registrationFile, its feedback entries (latest 20, with score and any feedbackFile text), its validations (with status), and the stats rollup. Normalize the id to "chainId:agentId" internally so callers can pass either the bare agentId or the composite id.
  - getChainAdoption({ chainId }): whatever per-chain rollup the Protocol entity exposes (total agents, total feedback, etc). If the Protocol entity does not give "agents with at least one feedback", compute it with a second query using a where filter on the stats rollup and note the approach in a code comment.
  - getAllChainsAdoption(): runs getChainAdoption across all five chains with Promise.allSettled, returns an array where a failed chain is reported as { chainId, ok: false, error } instead of throwing.

STEP 5. Create scripts/graph-smoke.ts. It loads .env.local (use dotenv if present in package.json, otherwise process.loadEnvFile('.env.local')), then prints: for each chain, the adoption rollup or the error; then for BSC, listAgents first 5 names; then getAgentTrustProfile for the first BSC agent that has at least one feedback entry (find one by querying feedback ordered by timestamp desc, take its agent id). Print the profile as formatted JSON. Add an npm script "graph:smoke" that runs it with tsx (add tsx as a devDependency if not present).

STEP 6. Run npm run graph:smoke. If it fails, fix and rerun until it prints real data. Then run the project's existing typecheck and lint commands and fix anything you introduced.

STEP 7. Commit in at least three logical commits (chains+client, types+queries, smoke script) with clear messages. Do not push.

STEP 8. Report back in this order: (a) the STEP 1 summary, (b) the entity list from STEP 2 and any schema surprises, (c) which chain subgraph IDs were confirmed vs left TODO, (d) the full output of npm run graph:smoke, (e) git log --oneline for the branch.
