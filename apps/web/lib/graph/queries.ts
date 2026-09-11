import 'server-only';

import { CHAINS, getChainById, subgraphIdFor } from './chains';
import { GraphError, graphQuery } from './client';
import type {
  Agent,
  AgentFeedbackStats,
  AgentTrustProfile,
  AgentValidationStats,
  ChainAdoption,
  ChainAdoptionResult,
  Feedback,
  Protocol,
  ProtocolAgentStats,
  ProtocolFeedbackStats,
  ProtocolValidationStats,
  Validation,
} from './types';

/** The gateway's hard ceiling on `first`. */
const MAX_PAGE = 1000;

/** Fields shared by the list and detail reads, so the two cannot drift apart. */
const REGISTRATION_FILE_FIELDS = `
  id
  cid
  name
  description
  image
  active
  x402Support
  supportedTrusts
  mcpEndpoint
  mcpVersion
  a2aEndpoint
  a2aVersion
  webEndpoint
  oasfEndpoint
  oasfVersion
  oasfSkills
  oasfDomains
  hasOASF
  emailEndpoint
  ens
  did
  mcpTools
  a2aSkills
  createdAt
`;

const AGENT_FIELDS = `
  id
  chainId
  agentId
  agentURI
  agentURIType
  owner
  agentWallet
  operators
  createdAt
  updatedAt
  totalFeedback
  lastActivity
`;

/**
 * Accept "30867", 30867 or "56:30867" and always produce "56:30867".
 *
 * Callers reach this layer from a route param, from another subgraph response
 * and from a hand-typed script argument; making each of them remember the
 * composite form is how you get a silent empty result, because `agent(id:)`
 * returns null for an unknown id rather than erroring.
 */
export function toCompositeId(chainId: number, agentId: string | number): string {
  const raw = String(agentId).trim();
  if (raw.includes(':')) {
    const [prefix, ...rest] = raw.split(':');
    const bare = rest.join(':');
    if (Number(prefix) !== chainId) {
      throw new Error(
        `Agent id "${raw}" is for chain ${prefix}, but chainId ${chainId} was requested.`,
      );
    }
    return `${chainId}:${bare}`;
  }
  return `${chainId}:${raw}`;
}

/* -------------------------------------------------------------------------- */
/* listAgents                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Agent_orderBy values worth exposing. `totalFeedback` and `lastActivity` are
 * plain columns on the entity, so ordering by them costs nothing — this is the
 * reason the list does not need the aggregations at all.
 */
export type AgentOrderBy = 'createdAt' | 'updatedAt' | 'totalFeedback' | 'lastActivity' | 'agentId';

export interface ListAgentsArgs {
  chainId: number;
  first?: number;
  skip?: number;
  orderBy?: AgentOrderBy;
  orderDirection?: 'asc' | 'desc';
  /** Restrict to agents that have been reviewed at least once. */
  withFeedbackOnly?: boolean;
}

/**
 * One page of agents with their registration file.
 *
 * The per-agent stats rollup is deliberately NOT joined here: AgentFeedbackStats
 * is a timeseries aggregation, not a relation on Agent, so pulling it for a page
 * of agents would mean one *_collection query per agent. `Agent.totalFeedback`
 * is the same number, denormalised onto the entity. The full rollup is available
 * per-agent from getAgentTrustProfile.
 */
export async function listAgents({
  chainId,
  first = 25,
  skip = 0,
  orderBy = 'totalFeedback',
  orderDirection = 'desc',
  withFeedbackOnly = false,
}: ListAgentsArgs): Promise<Agent[]> {
  const subgraphId = subgraphIdFor(chainId);
  const query = `
    query ListAgents($first: Int!, $skip: Int!, $orderBy: Agent_orderBy!, $orderDirection: OrderDirection!, $where: Agent_filter) {
      agents(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
        ${AGENT_FIELDS}
        registrationFile { ${REGISTRATION_FILE_FIELDS} }
      }
    }
  `;
  const data = await graphQuery<{ agents: Agent[] }>(subgraphId, query, {
    first: Math.min(first, MAX_PAGE),
    skip,
    orderBy,
    orderDirection,
    where: withFeedbackOnly ? { totalFeedback_gt: 0 } : {},
  });
  return data.agents;
}

/* -------------------------------------------------------------------------- */
/* getAgentTrustProfile                                                        */
/* -------------------------------------------------------------------------- */

export interface GetAgentTrustProfileArgs {
  chainId: number;
  /** Bare ("30867") or composite ("56:30867"). */
  agentId: string | number;
  /** How many feedback entries to pull, newest first. */
  feedbackLimit?: number;
}

/**
 * Everything needed to judge one agent, in a single round trip.
 *
 * The two *Stats_collection selections each take the LATEST bucket only
 * (`orderDirection: desc, first: 1, current: include`) because the aggregation
 * counters are cumulative running totals — see the schema notes. `current:
 * include` matters: without it the in-progress bucket is dropped and a brand
 * new agent reads as having no stats at all.
 */
export async function getAgentTrustProfile({
  chainId,
  agentId,
  feedbackLimit = 20,
}: GetAgentTrustProfileArgs): Promise<AgentTrustProfile> {
  const subgraphId = subgraphIdFor(chainId);
  const id = toCompositeId(chainId, agentId);

  const query = `
    query AgentTrustProfile($id: ID!, $agentFilter: String!, $feedbackLimit: Int!) {
      agent(id: $id) {
        ${AGENT_FIELDS}
        registrationFile { ${REGISTRATION_FILE_FIELDS} }
        validations(first: 100, orderBy: createdAt, orderDirection: desc) {
          id
          validatorAddress
          requestUri
          requestHash
          response
          responseUri
          responseHash
          tag
          status
          createdAt
          updatedAt
        }
      }
      feedbacks(
        first: $feedbackLimit
        orderBy: createdAt
        orderDirection: desc
        where: { agent: $agentFilter }
      ) {
        id
        clientAddress
        feedbackIndex
        value
        tag1
        tag2
        endpoint
        feedbackURI
        feedbackURIType
        feedbackHash
        isRevoked
        createdAt
        revokedAt
        feedbackFile {
          id
          cid
          text
          valueRaw
          valueDecimals
          createdAtIso
          mcpTool
          mcpPrompt
          mcpResource
          a2aSkills
          oasfSkills
          oasfDomains
          proofOfPaymentTxHash
          proofOfPaymentChainId
          tag1
          tag2
        }
      }
      agentFeedbackStats_collection(
        interval: day
        first: 1
        orderBy: timestamp
        orderDirection: desc
        current: include
        where: { agent: $agentFilter }
      ) {
        id
        timestamp
        feedbackCreated
        feedbackRevoked
        valueSum
        valueDeltaSum
      }
      agentValidationStats_collection(
        interval: day
        first: 1
        orderBy: timestamp
        orderDirection: desc
        current: include
        where: { agent: $agentFilter }
      ) {
        id
        timestamp
        validationRequests
        validationResponses
        scoreSum
      }
    }
  `;

  const data = await graphQuery<{
    agent: (Agent & { validations: Validation[] }) | null;
    feedbacks: Feedback[];
    agentFeedbackStats_collection: AgentFeedbackStats[];
    agentValidationStats_collection: AgentValidationStats[];
  }>(subgraphId, query, { id, agentFilter: id, feedbackLimit });

  return {
    chainId,
    id,
    agent: data.agent,
    registrationFile: data.agent?.registrationFile ?? null,
    feedback: data.feedbacks,
    validations: data.agent?.validations ?? [],
    feedbackStats: data.agentFeedbackStats_collection[0] ?? null,
    validationStats: data.agentValidationStats_collection[0] ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* getChainAdoption                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Default ceiling on the agents-with-feedback count: 40 pages = 40,000 agents.
 *
 * Sized off the real numbers, not a round guess. Measured 11 Sep 2026:
 * BSC 4,448 agents (5 pages, ~3s), Base 29,783 (30 pages, ~11s). A 20-page cap
 * silently truncated Base to "20,000". 40 leaves Base room to roughly grow by a
 * third before the count degrades to a lower bound — and when it does, the
 * `exact: false` flag says so rather than the number quietly lying.
 */
const AGENTS_WITH_FEEDBACK_MAX_PAGES = 40;

/**
 * Count agents with at least one feedback entry.
 *
 * WHY A SECOND QUERY: the Protocol entity exposes no counters whatsoever — only
 * the three registry addresses — so there is nothing to read this from. The
 * *Stats aggregations do not help either: AgentFeedbackStats is dimensioned by
 * agent, so counting distinct agents in it still means paging every row.
 *
 * The cheapest correct route is the denormalised `Agent.totalFeedback` column,
 * keyset-paged on `id_gt`. Keyset, not `skip`, because the gateway caps skip at
 * 5,000 and would silently stop counting there. Returns `exact: false` if the
 * page cap is reached, so a truncated count can never be mistaken for a real one.
 */
async function countAgentsWithFeedback(
  subgraphId: string,
  maxPages = AGENTS_WITH_FEEDBACK_MAX_PAGES,
): Promise<{ count: number; exact: boolean }> {
  const query = `
    query AgentsWithFeedback($cursor: ID!) {
      agents(
        first: ${MAX_PAGE}
        orderBy: id
        orderDirection: asc
        where: { totalFeedback_gt: 0, id_gt: $cursor }
      ) { id }
    }
  `;

  let cursor = '';
  let count = 0;

  for (let page = 0; page < maxPages; page++) {
    const data = await graphQuery<{ agents: { id: string }[] }>(subgraphId, query, { cursor });
    const rows = data.agents;
    count += rows.length;
    if (rows.length < MAX_PAGE) return { count, exact: true };
    cursor = rows[rows.length - 1].id;
  }

  return { count, exact: false };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Per-chain adoption rollup.
 *
 * Each *Stats_collection selection takes the LATEST bucket only. The counters
 * are cumulative running totals, so summing the daily buckets is wrong — doing
 * that on BSC yields 29,025,949 "registrations" against a highest agentId of
 * 344,805. Verified the other way too: agent 56:30867 has totalFeedback 234 and
 * its latest bucket reads feedbackCreated 234.
 *
 * `highestAgentId` is carried alongside `totalAgents` as a free cross-check:
 * agent ids are sequential from 0, so the two should agree within one bucket's
 * worth of drift.
 */
export interface GetChainAdoptionArgs {
  chainId: number;
  /**
   * Page cap for the agents-with-feedback count. Set 0 to skip that count
   * entirely — it is the only part of this function that is not O(1), and a
   * caller that just wants the headline totals should not pay ~11s for it.
   */
  agentsWithFeedbackMaxPages?: number;
}

export async function getChainAdoption({
  chainId,
  agentsWithFeedbackMaxPages = AGENTS_WITH_FEEDBACK_MAX_PAGES,
}: GetChainAdoptionArgs): Promise<ChainAdoption> {
  const chain = getChainById(chainId);
  if (!chain) throw new Error(`Unknown chainId ${chainId}`);
  const subgraphId = subgraphIdFor(chainId);

  const query = `
    query ChainAdoption($protocol: String!) {
      _meta { block { number } }
      protocol(id: $protocol) {
        id
        chainId
        name
        identityRegistry
        reputationRegistry
        validationRegistry
        createdAt
        updatedAt
      }
      highest: agents(first: 1, orderBy: agentId, orderDirection: desc) { agentId }
      protocolAgentStats_collection(
        interval: day, first: 1, orderBy: timestamp, orderDirection: desc
        current: include, where: { protocol: $protocol }
      ) { timestamp agentRegistrations }
      protocolFeedbackStats_collection(
        interval: day, first: 1, orderBy: timestamp, orderDirection: desc
        current: include, where: { protocol: $protocol }
      ) { timestamp feedbackCreated feedbackRevoked valueSum valueDeltaSum }
      protocolValidationStats_collection(
        interval: day, first: 1, orderBy: timestamp, orderDirection: desc
        current: include, where: { protocol: $protocol }
      ) { timestamp validationRequests validationResponses scoreSum }
    }
  `;

  const data = await graphQuery<{
    _meta: { block: { number: number } };
    protocol: Protocol | null;
    highest: { agentId: string }[];
    protocolAgentStats_collection: ProtocolAgentStats[];
    protocolFeedbackStats_collection: ProtocolFeedbackStats[];
    protocolValidationStats_collection: ProtocolValidationStats[];
  }>(subgraphId, query, { protocol: String(chainId) });

  const agentStats = data.protocolAgentStats_collection[0];
  const feedbackStats = data.protocolFeedbackStats_collection[0];
  const validationStats = data.protocolValidationStats_collection[0];
  const highestAgentId = data.highest[0] ? Number(data.highest[0].agentId) : -1;

  const { count, exact } =
    agentsWithFeedbackMaxPages > 0
      ? await countAgentsWithFeedback(subgraphId, agentsWithFeedbackMaxPages)
      : { count: 0, exact: false };

  return {
    chainId,
    chainName: data.protocol?.name ?? chain.name,
    protocol: data.protocol,
    // Fall back to the sequential-id cross-check when no bucket exists yet
    // (a chain indexed but with no completed day).
    totalAgents: agentStats ? Number(agentStats.agentRegistrations) : highestAgentId + 1,
    highestAgentId,
    totalFeedbackCreated: feedbackStats ? Number(feedbackStats.feedbackCreated) : 0,
    totalFeedbackRevoked: feedbackStats ? Number(feedbackStats.feedbackRevoked) : 0,
    // Number() is lossy here — Base's real sum is ~2.5e38. Both are carried so
    // a caller can pick precision or convenience deliberately.
    feedbackValueSum: feedbackStats ? Number(feedbackStats.valueSum) : 0,
    feedbackValueSumRaw: feedbackStats ? feedbackStats.valueSum : '0',
    totalValidationRequests: validationStats ? Number(validationStats.validationRequests) : 0,
    totalValidationResponses: validationStats ? Number(validationStats.validationResponses) : 0,
    // BSC's validationRegistry is the zero address: no registry is deployed, so
    // an empty validation rollup is expected, not a gap in the data.
    hasValidationRegistry:
      !!data.protocol && data.protocol.validationRegistry.toLowerCase() !== ZERO_ADDRESS,
    agentsWithFeedback: count,
    agentsWithFeedbackExact: exact,
    blockNumber: data._meta.block.number,
  };
}

/* -------------------------------------------------------------------------- */
/* getAllChainsAdoption                                                        */
/* -------------------------------------------------------------------------- */

function describeError(err: unknown): string {
  // GraphError.message already folds in the GraphQL error messages; re-appending
  // err.errors here just printed every failure twice.
  if (err instanceof GraphError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fan out getChainAdoption across all five chains.
 *
 * Never throws. One unreachable deployment must not blank the whole comparison
 * — which is not hypothetical: Monad's indexer has been returning `bad indexers
 * … Unavailable` throughout. A failed chain comes back as { ok: false, error }
 * and the caller renders it as "unavailable" beside four live rows.
 */
export async function getAllChainsAdoption(): Promise<ChainAdoptionResult[]> {
  const settled = await Promise.allSettled(
    CHAINS.map((c) => getChainAdoption({ chainId: c.chainId })),
  );

  return settled.map((result, i) => {
    const chain = CHAINS[i];
    if (result.status === 'fulfilled') {
      return { ok: true as const, ...result.value };
    }
    return {
      ok: false as const,
      chainId: chain.chainId,
      chainName: chain.name,
      error: describeError(result.reason),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* searchAgents                                                                */
/* -------------------------------------------------------------------------- */

export interface SearchAgentsArgs {
  chainId: number;
  /** Free text matched against registrationFile name and description. */
  text: string;
  first?: number;
  /** Only agents that have been reviewed at least once. */
  withFeedbackOnly?: boolean;
}

/**
 * Find agents whose registration file name or description matches `text`.
 *
 * NESTED FILTERS ARE SUPPORTED — the fallback the schema notes warned about is
 * not needed. `Agent_filter` really does expose `registrationFile_`, which
 * takes a full `AgentRegistrationFile_filter`, and the top-level `or` composes
 * two of them. Verified against the live BSC subgraph:
 *
 *   where: { or: [ { registrationFile_: { name_contains_nocase: "yield" } },
 *                  { registrationFile_: { description_contains_nocase: "yield" } } ] }
 *
 * So this is one server-side query over the whole registry, not five pages of
 * 1,000 filtered in JS — which matters at 344,815 agents on BSC, where the
 * client-side approach would have searched the top 5,000 by feedback and
 * silently missed everything else.
 *
 * Ordering by totalFeedback desc means the most-reviewed match comes first,
 * which is what "find me an agent that actually does X" wants.
 */
export async function searchAgents({
  chainId,
  text,
  first = 10,
  withFeedbackOnly = false,
}: SearchAgentsArgs): Promise<Agent[]> {
  const subgraphId = subgraphIdFor(chainId);
  const term = text.trim();
  if (!term) return [];

  // `or` branches are combined with the feedback restriction inside each
  // branch: a top-level sibling key would AND with the whole `or`, which
  // graph-node accepts but which reads ambiguously. Explicit is safer.
  const feedbackClause = withFeedbackOnly ? { totalFeedback_gt: 0 } : {};
  const where = {
    or: [
      { ...feedbackClause, registrationFile_: { name_contains_nocase: term } },
      { ...feedbackClause, registrationFile_: { description_contains_nocase: term } },
    ],
  };

  const query = `
    query SearchAgents($first: Int!, $where: Agent_filter!) {
      agents(first: $first, orderBy: totalFeedback, orderDirection: desc, where: $where) {
        ${AGENT_FIELDS}
        registrationFile { ${REGISTRATION_FILE_FIELDS} }
      }
    }
  `;

  const data = await graphQuery<{ agents: Agent[] }>(subgraphId, query, {
    first: Math.min(first, MAX_PAGE),
    where,
  });
  return data.agents;
}

/* -------------------------------------------------------------------------- */
/* getFeedbackForAgent                                                         */
/* -------------------------------------------------------------------------- */

export interface GetFeedbackForAgentArgs {
  chainId: number;
  /** Bare ("30867") or composite ("56:30867"). */
  agentId: string | number;
  first?: number;
}

/**
 * Feedback for one agent, newest first.
 *
 * The reviewer field is `clientAddress` (Bytes), not `reviewer` or `author`.
 * Ordering is on `createdAt` — Feedback has no `timestamp` field.
 *
 * Separate from getAgentTrustProfile so the analysis layer can pull a deeper
 * history (concentration and burstiness get noticeably better with more than
 * the profile's default 20) without re-fetching the agent and both rollups.
 */
export async function getFeedbackForAgent({
  chainId,
  agentId,
  first = 100,
}: GetFeedbackForAgentArgs): Promise<Feedback[]> {
  const subgraphId = subgraphIdFor(chainId);
  const id = toCompositeId(chainId, agentId);

  const query = `
    query FeedbackForAgent($agentFilter: String!, $first: Int!) {
      feedbacks(
        first: $first
        orderBy: createdAt
        orderDirection: desc
        where: { agent: $agentFilter }
      ) {
        id
        clientAddress
        feedbackIndex
        value
        tag1
        tag2
        endpoint
        isRevoked
        createdAt
        revokedAt
        feedbackFile { id cid text valueRaw valueDecimals createdAtIso }
      }
    }
  `;

  const data = await graphQuery<{ feedbacks: Feedback[] }>(subgraphId, query, {
    agentFilter: id,
    first: Math.min(first, MAX_PAGE),
  });
  return data.feedbacks;
}

/* -------------------------------------------------------------------------- */
/* getProtocol                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The Protocol row for one chain — registry addresses and nothing else.
 *
 * O(1) and deliberately separate from getChainAdoption. Callers that only need
 * a registry address (chiefly "is a validation registry deployed here?")
 * should never pay for the reviewer count, which is the one non-constant-time
 * read in this module.
 */
export async function getProtocol(chainId: number): Promise<Protocol | null> {
  const subgraphId = subgraphIdFor(chainId);
  const query = `
    query GetProtocol($id: ID!) {
      protocol(id: $id) {
        id
        chainId
        name
        identityRegistry
        reputationRegistry
        validationRegistry
        createdAt
        updatedAt
      }
    }
  `;
  const data = await graphQuery<{ protocol: Protocol | null }>(subgraphId, query, {
    id: String(chainId),
  });
  return data.protocol;
}
