/**
 * Trust signals computed from subgraph data. No LLM, no network, no clock
 * except the one you pass in — every function here is pure so the flag rules
 * can be unit-tested and so Scout's model is reasoning over arithmetic it
 * cannot fudge.
 *
 * This module deliberately imports only TYPES from lib/graph. It must stay
 * runnable under plain `node` (type imports are erased), which is what lets
 * tests/scout-analysis.test.mjs import it directly.
 */

import type { AgentTrustProfile, Feedback } from '../graph/types';

/* -------------------------------------------------------------------------- */
/* Shapes                                                                      */
/* -------------------------------------------------------------------------- */

export type FlagCode =
  | 'SINGLE_CLIENT_DOMINANCE'
  | 'HIGH_CONCENTRATION'
  | 'BURST'
  | 'NO_METADATA'
  | 'NO_ENDPOINTS'
  | 'VALIDATION_UNAVAILABLE'
  | 'NAME_LOOKALIKE';

export interface Flag {
  code: FlagCode;
  /** One line, already phrased for display. */
  reason: string;
  /**
   * Heuristic flags are guesses about intent, not measurements. The UI marks
   * them so a false positive reads as a prompt to look, not as a finding.
   */
  heuristic: boolean;
}

export interface EndpointRef {
  kind: 'mcp' | 'a2a' | 'web' | 'oasf' | 'email';
  value: string;
}

export interface Liveness {
  hasRegistrationFile: boolean;
  hasEndpoints: boolean;
  endpoints: EndpointRef[];
  /** Null when there is no registration file to date. */
  registrationAgeDays: number | null;
  /** registrationFile.active, which is self-declared and often null. */
  selfDeclaredActive: boolean | null;
  /** Days since Agent.lastActivity. */
  lastActivityAgeDays: number | null;
}

export interface TagStats {
  tag: string;
  count: number;
  min: number;
  max: number;
  mean: number;
}

export interface TrustSignals {
  chainId: number;
  agentId: string;
  name: string | null;
  liveness: Liveness;
  /**
   * Per-tag only. Feedback.value's unit is whatever tag1 says — a 236 under
   * "responseTime" is milliseconds and a 100 under "uptime" is a percentage —
   * so there is deliberately no overall mean anywhere in this object.
   */
  feedbackByTag: TagStats[];
  distinctClients: number;
  /** Feedback rows actually analysed (what was fetched, not the chain total). */
  analysedFeedback: number;
  /** Agent.totalFeedback, the chain's own count. May exceed analysedFeedback. */
  reportedTotalFeedback: number;
  /** analysedFeedback / distinctClients. 0 when there is no feedback. */
  concentrationRatio: number;
  /** Largest single client's share of analysed feedback, 0..1. */
  topClientShare: number;
  /** Share of analysed feedback falling in the busiest 24h window, 0..1. */
  burstiness: number;
  flags: Flag[];
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const DAY_SECONDS = 86_400;

const round = (n: number, dp = 3): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** Seconds-since-epoch string -> whole days before `nowSeconds`. */
function ageDays(seconds: string | null | undefined, nowSeconds: number): number | null {
  if (seconds == null) return null;
  const t = Number(seconds);
  if (!Number.isFinite(t) || t <= 0) return null;
  return Math.max(0, Math.floor((nowSeconds - t) / DAY_SECONDS));
}

export function extractEndpoints(
  reg: AgentTrustProfile['registrationFile'],
): EndpointRef[] {
  if (!reg) return [];
  const candidates: [EndpointRef['kind'], string | null][] = [
    ['mcp', reg.mcpEndpoint],
    ['a2a', reg.a2aEndpoint],
    ['web', reg.webEndpoint],
    ['oasf', reg.oasfEndpoint],
    ['email', reg.emailEndpoint],
  ];
  return candidates
    .filter((c): c is [EndpointRef['kind'], string] => !!c[1] && c[1].trim() !== '')
    .map(([kind, value]) => ({ kind, value }));
}

/**
 * Per-tag1 statistics. Feedback with a null tag1 is grouped under "(untagged)"
 * rather than dropped — an agent whose reviews carry no tag at all is a real
 * shape, and silently discarding those rows would understate its review count.
 *
 * Revoked feedback is excluded: it has been withdrawn by its author, so
 * counting it would let a retracted score keep propping up a mean.
 */
export function feedbackByTag(feedback: Feedback[]): TagStats[] {
  const groups = new Map<string, number[]>();
  for (const f of feedback) {
    if (f.isRevoked) continue;
    const v = Number(f.value);
    if (!Number.isFinite(v)) continue;
    const tag = f.tag1?.trim() || '(untagged)';
    const arr = groups.get(tag);
    if (arr) arr.push(v);
    else groups.set(tag, [v]);
  }
  return [...groups.entries()]
    .map(([tag, values]) => ({
      tag,
      count: values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      mean: round(values.reduce((s, x) => s + x, 0) / values.length),
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Share of feedback inside the busiest 24h window.
 *
 * Sliding window over sorted timestamps rather than fixed calendar buckets: a
 * burst that straddles midnight is still a burst, and calendar bucketing would
 * halve it. O(n log n) for the sort, O(n) for the scan.
 */
export function burstiness(feedback: Feedback[]): number {
  const times = feedback
    .map((f) => Number(f.createdAt))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (times.length === 0) return 0;
  if (times.length === 1) return 1;

  let best = 1;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] >= DAY_SECONDS) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return round(best / times.length);
}

/**
 * Handles of well-known brands and public figures, for the impersonation
 * heuristic.
 *
 * HEURISTIC AND INCOMPLETE BY DESIGN. This is a hand-kept list, it will have
 * false positives (a genuinely operated brand account trips it) and false
 * negatives (anything not listed). It exists because the BSC registry is full
 * of "@binance · Ensoul"-shaped names that nobody at Binance registered, and a
 * reader deserves a nudge to check. Every flag it raises is marked
 * heuristic: true so the UI can say "worth checking", never "this is fake".
 */
export const LOOKALIKE_HANDLES: readonly string[] = [
  'binance', 'cz_binance', 'bnbchain', 'coinbase', 'kraken', 'okx', 'bybit',
  'gate', 'gateio', 'bitget', 'htx', 'kucoin', 'upbit',
  'coinmarketcap', 'coingecko', 'tether', 'circle', 'paxos',
  'ethereum', 'vitalikbuterin', 'solana', 'polygon', 'arbitrum', 'optimism',
  'uniswap', 'pancakeswap', 'aave', 'venusprotocol', 'lido', 'curvefinance',
  'metamask', 'ledger', 'trezor', 'trustwallet', 'phantom',
  'elonmusk', 'mayemusk', 'saylor', 'cryptohayes', 'apecrypto',
  'thegraph', 'chainlink', 'a16z', 'paradigm',
];

/**
 * Does this name look like it is trading on someone else's identity?
 *
 * Matches an @handle anywhere in the name against the list above, plus the
 * bare-word case ("Binance Assistant"). Case-insensitive; the handle must be a
 * whole token so "gate" does not fire on "gateway".
 */
export function nameLookalike(name: string | null | undefined): string | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const handle of LOOKALIKE_HANDLES) {
    const atForm = new RegExp(`@${handle}\\b`, 'i');
    const wordForm = new RegExp(`(^|[^a-z0-9_])${handle}([^a-z0-9_]|$)`, 'i');
    if (atForm.test(lower) || wordForm.test(lower)) return handle;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* computeTrustSignals                                                         */
/* -------------------------------------------------------------------------- */

export interface ComputeTrustSignalsArgs {
  profile: AgentTrustProfile;
  /**
   * Feedback to analyse. Pass a deeper history than the profile's own 20 where
   * you have it — concentration and burstiness both sharpen with more rows.
   * Defaults to profile.feedback.
   */
  feedback?: Feedback[];
  /**
   * Whether the chain has a validation registry deployed. FALSE on every live
   * chain as of 11 Sep 2026 (every Protocol.validationRegistry is the zero
   * address), which is why VALIDATION_UNAVAILABLE is informational rather than
   * damning. Comes from ChainAdoption.hasValidationRegistry.
   */
  hasValidationRegistry: boolean;
  /** Injectable clock, seconds since epoch. Defaults to now. */
  nowSeconds?: number;
}

export function computeTrustSignals({
  profile,
  feedback,
  hasValidationRegistry,
  nowSeconds = Math.floor(Date.now() / 1000),
}: ComputeTrustSignalsArgs): TrustSignals {
  const rows = feedback ?? profile.feedback;
  const reg = profile.registrationFile;
  const endpoints = extractEndpoints(reg);

  const liveness: Liveness = {
    hasRegistrationFile: reg != null,
    hasEndpoints: endpoints.length > 0,
    endpoints,
    registrationAgeDays: ageDays(reg?.createdAt ?? profile.agent?.createdAt, nowSeconds),
    selfDeclaredActive: reg?.active ?? null,
    lastActivityAgeDays: ageDays(profile.agent?.lastActivity, nowSeconds),
  };

  const clientCounts = new Map<string, number>();
  for (const f of rows) {
    const c = f.clientAddress.toLowerCase();
    clientCounts.set(c, (clientCounts.get(c) ?? 0) + 1);
  }

  const analysed = rows.length;
  const distinctClients = clientCounts.size;
  const topCount = distinctClients ? Math.max(...clientCounts.values()) : 0;
  const topClientShare = analysed ? round(topCount / analysed) : 0;
  const concentrationRatio = distinctClients ? round(analysed / distinctClients) : 0;
  const burst = burstiness(rows);
  const name = reg?.name ?? null;

  const flags: Flag[] = [];

  if (topClientShare > 0.5 && analysed > 0) {
    flags.push({
      code: 'SINGLE_CLIENT_DOMINANCE',
      reason:
        `One address wrote ${topCount} of ${analysed} reviews ` +
        `(${Math.round(topClientShare * 100)}%) — the score largely reflects one counterparty.`,
      heuristic: false,
    });
  }

  if (concentrationRatio > 5) {
    flags.push({
      code: 'HIGH_CONCENTRATION',
      reason:
        `${analysed} reviews from only ${distinctClients} distinct address(es) ` +
        `(${concentrationRatio} per address) — few independent sources.`,
      heuristic: false,
    });
  }

  if (burst > 0.7 && analysed >= 10) {
    flags.push({
      code: 'BURST',
      reason:
        `${Math.round(burst * 100)}% of ${analysed} reviews landed inside a single 24h window — ` +
        `consistent with a scripted run rather than organic use.`,
      heuristic: false,
    });
  }

  if (!liveness.hasRegistrationFile) {
    flags.push({
      code: 'NO_METADATA',
      reason: 'No registration file indexed — the agent publishes no name, description or endpoints.',
      heuristic: false,
    });
  }

  if (!liveness.hasEndpoints) {
    flags.push({
      code: 'NO_ENDPOINTS',
      reason: 'No MCP, A2A, web, OASF or email endpoint advertised — nothing to actually call.',
      heuristic: false,
    });
  }

  if (!hasValidationRegistry) {
    flags.push({
      code: 'VALIDATION_UNAVAILABLE',
      reason:
        'No validation registry is deployed on this chain, so no agent here can hold a ' +
        'validation. Absence of validation is not evidence against this agent.',
      heuristic: false,
    });
  }

  const impersonated = nameLookalike(name);
  if (impersonated) {
    flags.push({
      code: 'NAME_LOOKALIKE',
      reason:
        `Name "${name}" references "${impersonated}", a well-known brand or public figure. ` +
        `Heuristic match against a hand-kept list — verify ownership before trusting the identity.`,
      heuristic: true,
    });
  }

  return {
    chainId: profile.chainId,
    agentId: profile.id,
    name,
    liveness,
    feedbackByTag: feedbackByTag(rows),
    distinctClients,
    analysedFeedback: analysed,
    reportedTotalFeedback: Number(profile.agent?.totalFeedback ?? 0),
    concentrationRatio,
    topClientShare,
    burstiness: burst,
    flags,
  };
}
