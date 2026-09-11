import 'server-only';

import { unstable_cache } from 'next/cache';

import { getAllChainsAdoption, getChainAdoption, getProtocol } from './queries';
import type { ChainAdoptionResult } from './types';

/**
 * One shared, hour-long cache of the adoption rollup.
 *
 * Both /api/graph/adoption and Scout's get_chain_adoption tool read through
 * here, so the two can never disagree and the expensive part runs once per
 * hour rather than once per caller.
 *
 * The alternative — having the Scout tool fetch its own /api/graph/adoption
 * over HTTP — would need an absolute origin (so `headers()`, so the Scout
 * route goes dynamic) and would add a network hop to reach data already in
 * this process. A shared cached function is the same cache with none of that.
 *
 * Why this matters for Scout specifically: the uncached call is 4 live chains
 * x up to 40 paginated pages, ~11s for Base alone. Inside a 60s streaming
 * budget that is most of the turn, and the model may want adoption more than
 * once.
 */

const REVALIDATE_SECONDS = 3600;

export interface CachedAdoption {
  /**
   * When the subgraph was actually read — captured INSIDE the cached function
   * on purpose. Stamping it in the caller instead produced a `fetchedAt` that
   * advanced on every request while the data underneath was up to an hour old,
   * which is exactly the kind of quietly-wrong freshness claim this codebase
   * avoids elsewhere.
   */
  fetchedAt: string;
  chains: ChainAdoptionResult[];
}

const cachedAdoption = unstable_cache(
  async (): Promise<CachedAdoption> => ({
    fetchedAt: new Date().toISOString(),
    chains: await getAllChainsAdoption(),
  }),
  ['agent0-adoption-all-chains'],
  { revalidate: REVALIDATE_SECONDS, tags: ['agent0-adoption'] },
);

/** The rollup plus the timestamp it was actually measured at. */
export async function cachedAdoptionSnapshot(): Promise<CachedAdoption> {
  return cachedAdoption();
}

export async function cachedAllChainsAdoption(): Promise<ChainAdoptionResult[]> {
  return (await cachedAdoption()).chains;
}

/**
 * One chain, cached per chain.
 *
 * Deliberately its OWN cache entry rather than a slice of the all-chains one.
 * Reading a slice looks cheaper and is the opposite: a cold miss would compute
 * all five chains — including Base's 30-page reviewer count — to answer about
 * one. Measured that mistake: a single-agent question fired 45 subgraph
 * queries and took 62s, blowing the 60s function budget.
 */
const cachedOneChain = unstable_cache(
  async (chainId: number): Promise<ChainAdoptionResult> => {
    try {
      return { ok: true as const, ...(await getChainAdoption({ chainId })) };
    } catch (err) {
      return {
        ok: false as const,
        chainId,
        chainName: `chain ${chainId}`,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  ['agent0-adoption-one-chain'],
  { revalidate: REVALIDATE_SECONDS, tags: ['agent0-adoption'] },
);

export async function cachedChainAdoption(chainId: number): Promise<ChainAdoptionResult> {
  return cachedOneChain(chainId);
}

/**
 * Does this chain have a validation registry deployed?
 *
 * Its own tiny cached query rather than a field plucked off the adoption
 * rollup. The trust profile needs exactly this one boolean, and going through
 * adoption to get it meant paying for a full reviewer count — the single most
 * expensive thing in lib/graph — to learn whether an address is zero.
 *
 * False on every live chain as of 11 Sep 2026.
 */
export const cachedHasValidationRegistry = unstable_cache(
  async (chainId: number): Promise<boolean> => {
    const protocol = await getProtocol(chainId);
    return protocol != null && !/^0x0+$/i.test(protocol.validationRegistry);
  },
  ['agent0-has-validation-registry'],
  { revalidate: REVALIDATE_SECONDS, tags: ['agent0-adoption'] },
);

export { REVALIDATE_SECONDS as ADOPTION_REVALIDATE_SECONDS };
