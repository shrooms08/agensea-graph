/**
 * GET /api/graph/adoption — per-chain Agent0 adoption, cached for an hour.
 *
 * CAN A `cache: 'no-store'` ELSEWHERE DISABLE THIS ROUTE'S CACHING?
 *
 * Yes — unless it is isolated, which is what unstable_cache does here. Every
 * gateway call in lib/graph/client.ts passes `cache: 'no-store'` (deliberately;
 * it is the right default for a live explorer), and Next's documented rule is
 * that "it is still possible for individual fetch requests to use cache:
 * 'no-store' ... to avoid being cached and make the route dynamically
 * rendered".
 *
 * Settled by measurement rather than by reading, because the reading is easy
 * to get backwards. Three `next build` runs, reading the route table:
 *
 *   unstable_cache + force-static   ->  o  Static, 1h        (what ships)
 *   unstable_cache, no force-static ->  o  Static, 1h
 *   neither                         ->  f  Dynamic
 *
 * So unstable_cache is the load-bearing part: it puts the no-store fetches
 * inside its own cache scope where they no longer taint the segment. Calling
 * getAllChainsAdoption() directly here really would make the route dynamic and
 * re-run 4 live chains x up to 40 paginated pages — Base's count alone is ~11s
 * — on every single request.
 *
 * `force-static` is therefore redundant TODAY and kept as a guard: it states
 * the intent in the segment itself, and it keeps the route cached if someone
 * later unwraps the unstable_cache call. It is not what is doing the work.
 *
 * The corollary worth remembering: adding a Request-time API (cookies, headers,
 * request.url, searchParams) to this handler would silently undo all of it.
 * Keep the handler argument-free.
 */
import { ADOPTION_REVALIDATE_SECONDS, cachedAdoptionSnapshot } from '@/lib/graph/adoption-cache';

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const revalidate = 3600;

/** Share of a chain's agents that have ever been reviewed. */
function adoptionRate(agentsWithFeedback: number, totalAgents: number): number | null {
  if (!Number.isFinite(totalAgents) || totalAgents <= 0) return null;
  return Math.round((agentsWithFeedback / totalAgents) * 1e6) / 1e6;
}

export async function GET() {
  // Shared with Scout's get_chain_adoption tool — see lib/graph/adoption-cache.
  // fetchedAt rides along from inside the cache so it dates the DATA, not this
  // request.
  const { fetchedAt, chains } = await cachedAdoptionSnapshot();

  const rows = chains.map((c) => {
    if (!c.ok) return c;
    return {
      ...c,
      adoptionRate: adoptionRate(c.agentsWithFeedback, c.totalAgents),
      /**
       * True when agentsWithFeedback hit the pagination cap, making
       * adoptionRate a LOWER BOUND rather than a measurement. Surfaced so the
       * UI can mark it rather than print a confident wrong percentage.
       */
      adoptionRateIsLowerBound: !c.agentsWithFeedbackExact,
    };
  });

  return Response.json(
    {
      fetchedAt,
      revalidateSeconds: ADOPTION_REVALIDATE_SECONDS,
      chainsTotal: rows.length,
      chainsOk: rows.filter((r) => r.ok).length,
      chains: rows,
    },
    { headers: { 'cache-control': 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' } },
  );
}
