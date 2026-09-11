import 'server-only';

import { countRows, record } from './evidence';

/**
 * The only place THEGRAPH_API_KEY is read, and the only place that talks to the
 * gateway.
 *
 * The key sits in the URL PATH, not a header — that is the gateway's scheme,
 * not a choice. It makes the URL itself a secret, so nothing here may ever put
 * a URL into an error message, a log line, or a thrown value. GraphError
 * carries the subgraph ID instead, which is public and is the part you actually
 * need to debug. `redactKey` is the backstop for anything that slips through a
 * nested fetch error.
 *
 * server-only is load-bearing: an accidental import from a client component
 * would bundle the key into the browser.
 */

const GATEWAY = 'https://gateway.thegraph.com/api';
const TIMEOUT_MS = 10_000;

export interface GraphQLError {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
  extensions?: Record<string, unknown>;
}

/**
 * Every failure mode of a gateway call, with the subgraph ID always attached.
 * `errors` is populated only for a GraphQL-level failure; a transport failure
 * (timeout, DNS, TLS) leaves it empty and sets `cause`.
 */
export class GraphError extends Error {
  readonly subgraphId: string;
  readonly errors: GraphQLError[];
  readonly status?: number;
  readonly timedOut: boolean;

  constructor(
    message: string,
    opts: {
      subgraphId: string;
      errors?: GraphQLError[];
      status?: number;
      timedOut?: boolean;
      cause?: unknown;
    },
  ) {
    super(message, { cause: opts.cause });
    this.name = 'GraphError';
    this.subgraphId = opts.subgraphId;
    this.errors = opts.errors ?? [];
    this.status = opts.status;
    this.timedOut = opts.timedOut ?? false;
  }
}

/**
 * Strip anything that looks like the API key out of a string before it is
 * allowed into an Error. Matches the gateway path shape rather than the key
 * value, so it also catches a key we were never given.
 */
function redactKey(s: string): string {
  return s.replace(
    /(gateway\.thegraph\.com\/api\/)[^/\s]+/gi,
    '$1<redacted>',
  );
}

function apiKey(): string {
  // Read at CALL time, never at import time. Reading at import time would make
  // the whole module unimportable in any context without the env var — which
  // includes `next build` collecting page metadata, and includes typecheck-
  // adjacent tooling that merely resolves the module graph.
  const key = process.env.THEGRAPH_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'THEGRAPH_API_KEY is not set. Add it to .env.local (local) or the Vercel ' +
        'project environment (deployed). Get a key at https://thegraph.com/studio/apikeys/',
    );
  }
  return key;
}

/**
 * POST one GraphQL operation to one subgraph and return `data`.
 *
 * Throws GraphError on: non-2xx, a populated `errors` array, a missing `data`,
 * or the 10s timeout. It never returns a partial result silently — the gateway
 * will happily answer 200 with `{"errors":[…]}` when an indexer is unavailable,
 * and treating that as success is how a dead chain renders as an empty one.
 */
export async function graphQuery<T>(
  subgraphId: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  // Record every call for Scout's evidence panel. This is the only layer that
  // knows the query text, and wrapping here catches pagination loops the tool
  // layer never sees. No-op outside a withEvidence scope.
  const started = Date.now();
  try {
    const data = await runQuery<T>(subgraphId, query, variables);
    record({
      subgraphId,
      query,
      variables,
      rowCount: countRows(data),
      ms: Date.now() - started,
      ok: true,
    });
    return data;
  } catch (err) {
    record({
      subgraphId,
      query,
      variables,
      rowCount: 0,
      ms: Date.now() - started,
      ok: false,
      // GraphError messages are already key-redacted.
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function runQuery<T>(
  subgraphId: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const key = apiKey();
  const url = `${GATEWAY}/${key}/subgraphs/id/${subgraphId}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
      // Opt out of Next's fetch cache by default. Callers that want ISR should
      // wrap this, rather than have every read silently share one cache entry.
      cache: 'no-store',
    });
  } catch (cause) {
    const timedOut = controller.signal.aborted;
    throw new GraphError(
      timedOut
        ? `Subgraph ${subgraphId} timed out after ${TIMEOUT_MS}ms`
        : `Subgraph ${subgraphId} request failed: ${redactKey(
            cause instanceof Error ? cause.message : String(cause),
          )}`,
      { subgraphId, timedOut, cause },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // Read the body for context but cap it — an HTML error page from a proxy
    // is not worth putting in full into an exception.
    const body = redactKey((await res.text().catch(() => '')).slice(0, 500));
    throw new GraphError(
      `Subgraph ${subgraphId} returned HTTP ${res.status}${body ? `: ${body}` : ''}`,
      { subgraphId, status: res.status },
    );
  }

  let payload: { data?: T; errors?: GraphQLError[] };
  try {
    payload = (await res.json()) as { data?: T; errors?: GraphQLError[] };
  } catch (cause) {
    throw new GraphError(`Subgraph ${subgraphId} returned a non-JSON body`, {
      subgraphId,
      status: res.status,
      cause,
    });
  }

  if (payload.errors?.length) {
    throw new GraphError(
      `Subgraph ${subgraphId} returned ${payload.errors.length} GraphQL error(s): ` +
        payload.errors.map((e) => redactKey(e.message)).join('; '),
      { subgraphId, errors: payload.errors, status: res.status },
    );
  }

  if (payload.data == null) {
    throw new GraphError(`Subgraph ${subgraphId} returned no data`, {
      subgraphId,
      status: res.status,
    });
  }

  return payload.data;
}
