Continue in the AgenSea repo (apps/web, Next 16 App Router). The cached adoption endpoint at apps/web/app/api/graph/adoption/route.ts (backed by lib/graph/adoption-cache.ts) returns per-chain ERC-8004 adoption data for five chains. Build a page that turns it into the headline visual for the demo. Existing design system only, no new chart libraries.

STEP 0. Save this prompt verbatim to docs/hackathon/prompts/04-adoption-page.md. Branch feat/adoption-page, commit "docs: save prompt 04 (adoption page)".

STEP 1. Create apps/web/app/adoption/page.tsx, server-rendered, reading the same cached adoption function the API route uses (call the lib function directly, do not fetch your own API over HTTP). Use the same unstable_cache path so the page is static with hourly revalidation, and verify with next build output that it shows as static with revalidate 1h.

STEP 2. Page content, top to bottom:
  - Title: "ERC-8004 adoption across chains" with a one-line subtitle: "Live from The Graph's Agent0 subgraphs. Registered agents vs agents that have ever received feedback."
  - Headline stat row: for BSC specifically, show registered agents, agents with feedback, and adoption rate as a percentage with one decimal. Add a small caption: "Independently measured by AgenSea's own on-chain sweep at 1.35%" (this is the pre-existing AgenSea finding; we are showing the two measurements agree).
  - A horizontal bar chart built with plain divs and CSS: one row per chain, bar length = adoption rate, label shows chain name, rate percentage, and "agents with feedback / registered" in smaller text. Sort by adoption rate descending. Monad or any failed chain renders as a greyed row with the text "indexer unavailable" and no bar, never a zero.
  - A table below with columns: chain, registered agents, agents with feedback, adoption rate, feedback created, last indexed block. Numbers formatted with thousands separators.
  - A "Scout this chain" link on each chain row that goes to /scout?chain=<chainId>. Update the Scout page so it reads the chain query parameter and preselects that chain in the selector.
  - Footer line: "Data: Agent0 subgraphs on The Graph Network, cached hourly. Fetched at <fetchedAt> UTC."
  - Add an "Adoption" link to components/Nav.tsx next to Scout.

STEP 3. Mobile: the bar chart must stack cleanly at 390px wide and the table must scroll horizontally inside a container rather than breaking layout. Verify with Playwright at 390px as you did for /scout.

STEP 4. Run next build, typecheck, and tests. Commit in two commits (page + nav, scout chain param). Merge into main with --no-ff and push main and the branch. Vercel deploys automatically from main; wait for it, then curl the production /adoption and confirm 200 and that the response HTML contains "ERC-8004 adoption". Do not call /api/scout.

STEP 5. Report: (a) confirmation the page is static with 1h revalidate in the build output, (b) the adoption rates shown per chain in descending order, (c) production /adoption status code, (d) git log --oneline -4 on main.
