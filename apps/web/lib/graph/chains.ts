/**
 * The five Agent0 mainnet deployments on The Graph's decentralised network.
 *
 * Subgraph IDs are transcribed from The Graph's own catalogue page
 * (https://thegraph.com/docs/en/subgraphs/existing-subgraphs/agent0/) and every
 * one was then verified against the gateway — see the note on Monad below.
 * None of them is guessed: an unconfirmed ID belongs here as '' with a TODO,
 * never as a plausible-looking string, because a wrong base58 ID fails as an
 * indexer error rather than a 404 and so reads like an outage.
 *
 * BSC is first and stays first: it is the chain the rest of AgenSea indexes,
 * so it is the default wherever a chain is not named explicitly.
 */

export interface GraphChain {
  chainId: number;
  /** Human label. Matches Protocol.name in the subgraph. */
  name: string;
  /** URL-safe key for routes and query params. */
  slug: string;
  /**
   * The Graph subgraph ID, or '' when no ID has been confirmed. Callers must
   * treat '' as "not configured" — `subgraphIdFor` throws on it rather than
   * letting an empty path segment reach the gateway.
   */
  subgraphId: string;
  explorer: {
    /** Origin + path prefix, no trailing slash. */
    base: string;
    tx: (hash: string) => string;
    address: (addr: string) => string;
  };
}

const explorer = (base: string) => ({
  base,
  tx: (hash: string) => `${base}/tx/${hash}`,
  address: (addr: string) => `${base}/address/${addr}`,
});

export const CHAINS: readonly GraphChain[] = [
  {
    chainId: 56,
    name: 'BSC Mainnet',
    slug: 'bsc',
    subgraphId: 'D6aWqowLkWqBgcqmpNKXuNikPkob24ADXCciiP8Hvn1K',
    explorer: explorer('https://bscscan.com'),
  },
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    slug: 'ethereum',
    subgraphId: 'FV6RR6y13rsnCxBAicKuQEwDp8ioEGiNaWaZUmvr1F8k',
    explorer: explorer('https://etherscan.io'),
  },
  {
    chainId: 8453,
    name: 'Base Mainnet',
    slug: 'base',
    subgraphId: '43s9hQRurMGjuYnC1r2ZwS6xSQktbFyXMPMqGKUFJojb',
    explorer: explorer('https://basescan.org'),
  },
  {
    chainId: 137,
    name: 'Polygon Mainnet',
    slug: 'polygon',
    subgraphId: '9q16PZv1JudvtnCAf44cBoxg82yK9SSsFvrjCY9xnneF',
    explorer: explorer('https://polygonscan.com'),
  },
  {
    /**
     * ID confirmed from the catalogue page, but the gateway has answered
     * `bad indexers: … Unavailable(no status: failed to get indexing progress)`
     * on every attempt (11 Sep 2026). That is an indexer-side outage, not a bad
     * ID, so the ID stays. getAllChainsAdoption reports Monad as { ok: false }
     * while this lasts instead of failing the whole fan-out.
     */
    chainId: 143,
    name: 'Monad Mainnet',
    slug: 'monad',
    subgraphId: '4tvLxkczjhSaMiqRrCV1EyheYHyJ7Ad8jub1UUyukBjg',
    explorer: explorer('https://monadexplorer.com'),
  },
] as const;

/** The chain every query falls back to when none is named. */
export const DEFAULT_CHAIN_ID = 56;

export function getChainById(chainId: number): GraphChain | undefined {
  return CHAINS.find((c) => c.chainId === chainId);
}

export function getChainBySlug(slug: string): GraphChain | undefined {
  const key = slug.toLowerCase();
  return CHAINS.find((c) => c.slug === key);
}

/**
 * Resolve a chainId to the subgraph ID to query, throwing rather than returning
 * a falsy value. Keeps every call site in queries.ts a one-liner and makes the
 * "no confirmed ID" case impossible to forget.
 */
export function subgraphIdFor(chainId: number): string {
  const chain = getChainById(chainId);
  if (!chain) {
    throw new Error(
      `Unknown chainId ${chainId}. Known: ${CHAINS.map((c) => c.chainId).join(', ')}`,
    );
  }
  if (!chain.subgraphId) {
    throw new Error(
      `No Agent0 subgraph ID is configured for ${chain.name} (chainId ${chainId}).`,
    );
  }
  return chain.subgraphId;
}
