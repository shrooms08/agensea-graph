import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request capture of every subgraph call made while handling it.
 *
 * Scout's UI has to show its working: which GraphQL queries ran, against which
 * subgraph, and how many rows came back. The alternative designs were both
 * worse — threading an `onEvidence` callback through every query signature, or
 * having each tool wrapper re-state the query text it did not write (which
 * drifts the moment queries.ts changes). AsyncLocalStorage records at the one
 * place that actually knows the query text, catches nested calls the tool
 * layer cannot see (getChainAdoption's 5..40 pagination pages, for one), and
 * changes no signatures.
 *
 * Outside a `withEvidence` scope, recording is a no-op — so lib/graph stays
 * usable from a script, a page, or a test with nothing collecting.
 */

export interface EvidenceRecord {
  /** Monotonic within the request, so the UI can show call order. */
  seq: number;
  subgraphId: string;
  /** Human label for the chain, filled in by the caller when known. */
  label?: string;
  /** The GraphQL document as sent. */
  query: string;
  variables: Record<string, unknown>;
  /** Sum of array lengths across the top-level fields of `data`. */
  rowCount: number;
  ms: number;
  ok: boolean;
  error?: string;
}

interface Collector {
  records: EvidenceRecord[];
  seq: number;
}

const store = new AsyncLocalStorage<Collector>();

/**
 * Run `fn` with evidence collection active and return what it produced
 * alongside the records. Nested calls share the outermost collector.
 */
export async function withEvidence<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; evidence: EvidenceRecord[] }> {
  const collector: Collector = { records: [], seq: 0 };
  const result = await store.run(collector, fn);
  return { result, evidence: collector.records };
}

/** The records captured so far in the current scope. Empty when unscoped. */
export function currentEvidence(): EvidenceRecord[] {
  return store.getStore()?.records ?? [];
}

/**
 * Count rows in a GraphQL `data` payload: every top-level field that is an
 * array contributes its length, and a non-null object field counts as one.
 * Approximate by construction — it is a "how much came back" indicator for
 * the evidence panel, not a figure anything computes on.
 */
export function countRows(data: unknown): number {
  if (data == null || typeof data !== 'object') return 0;
  let n = 0;
  for (const v of Object.values(data as Record<string, unknown>)) {
    if (Array.isArray(v)) n += v.length;
    else if (v != null && typeof v === 'object') n += 1;
  }
  return n;
}

/** Called by client.ts. No-op when nothing is collecting. */
export function record(r: Omit<EvidenceRecord, 'seq'>): void {
  const collector = store.getStore();
  if (!collector) return;
  collector.records.push({ seq: ++collector.seq, ...r });
}
