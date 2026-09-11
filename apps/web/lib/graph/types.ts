/**
 * Entity types for the Agent0 subgraph, transcribed from live introspection of
 * the BSC deployment on 11 Sep 2026. Ethereum introspects to a byte-identical
 * SDL, so these are chain-independent. Full notes and the reproduce command:
 * docs/hackathon/agent0-schema-notes.md
 *
 * Scalar mapping, and why:
 *   BigInt      -> string   (agentId, timestamps, counters — 344,805 agents and
 *                            microsecond timestamps both exceed nothing, but
 *                            valueSum does not fit a float safely, and mixing
 *                            representations per field is worse than one rule)
 *   BigDecimal  -> string   (feedback scores; parse at the edge that needs a number)
 *   Bytes       -> string   (0x-prefixed, lowercase)
 *   Int8        -> string   (aggregation row ids and agentRegistrations)
 *   Timestamp   -> string   (MICROSECONDS — unlike every createdAt, which is seconds)
 *
 * Every field is named exactly as the schema names it. Where the schema is
 * nullable, so is the type: `registrationFile` and `feedbackFile` are null far
 * more often than the docs suggest.
 */

/** Selection-set shaped: a relation is present only when the query asked for it. */
export interface Agent {
  /** "{chainId}:{agentId}", e.g. "56:0". */
  id: string;
  chainId: string;
  agentId: string;
  agentURI: string | null;
  agentURIType: string | null;
  owner: string;
  agentWallet: string | null;
  operators: string[];
  createdAt: string;
  updatedAt: string;
  /** Null whenever the off-chain registration file was never resolved. */
  registrationFile: AgentRegistrationFile | null;
  feedback?: Feedback[];
  validations?: Validation[];
  metadata?: AgentMetadata[];
  /** Denormalised onto the entity — filterable and sortable without the aggregations. */
  totalFeedback: string;
  lastActivity: string;
}

export interface AgentRegistrationFile {
  id: string;
  cid: string;
  agentId: string;
  name: string | null;
  description: string | null;
  image: string | null;
  active: boolean | null;
  x402Support: boolean | null;
  supportedTrusts: string[];
  endpointsRawJson: string | null;
  mcpEndpoint: string | null;
  mcpVersion: string | null;
  a2aEndpoint: string | null;
  a2aVersion: string | null;
  webEndpoint: string | null;
  oasfEndpoint: string | null;
  oasfVersion: string | null;
  oasfSkills: string[];
  oasfDomains: string[];
  hasOASF: boolean;
  emailEndpoint: string | null;
  ens: string | null;
  did: string | null;
  mcpTools: string[];
  mcpPrompts: string[];
  mcpResources: string[];
  a2aSkills: string[];
  createdAt: string;
}

export interface Feedback {
  /** "{chainId}:{agentId}:{clientAddress}:{feedbackIndex}". */
  id: string;
  agent?: Pick<Agent, 'id'>;
  clientAddress: string;
  feedbackIndex: string;
  /**
   * The score. Named `value`, not `score`.
   *
   * NOT normalised to 0..100: the unit is whatever `tag1` says it is. Real BSC
   * rows include value 60 under "outcome:partially", 100 under "uptime", and
   * 236 under "responseTime" (milliseconds). Read it together with tag1, and
   * with feedbackFile.valueDecimals where that is present.
   */
  value: string;
  /** Free-form and load-bearing — it names the unit of `value`. */
  tag1: string | null;
  tag2: string | null;
  endpoint: string | null;
  feedbackURI: string | null;
  feedbackURIType: string | null;
  feedbackHash: string | null;
  isRevoked: boolean;
  createdAt: string;
  revokedAt: string | null;
  feedbackFile: FeedbackFile | null;
  responses?: FeedbackResponse[];
}

export interface FeedbackFile {
  id: string;
  cid: string;
  feedbackId: string;
  agentRegistry: string | null;
  agentId: string | null;
  clientAddress: string | null;
  createdAtIso: string | null;
  valueRaw: string | null;
  valueDecimals: number | null;
  /** The human-readable review body. */
  text: string | null;
  mcpTool: string | null;
  mcpPrompt: string | null;
  mcpResource: string | null;
  a2aSkills: string[];
  a2aContextId: string | null;
  a2aTaskId: string | null;
  oasfSkills: string[];
  oasfDomains: string[];
  proofOfPaymentFromAddress: string | null;
  proofOfPaymentToAddress: string | null;
  proofOfPaymentChainId: string | null;
  proofOfPaymentTxHash: string | null;
  tag1: string | null;
  tag2: string | null;
  createdAt: string;
}

export interface FeedbackResponse {
  id: string;
  feedback?: Pick<Feedback, 'id'>;
  responder: string;
  responseUri: string | null;
  responseHash: string | null;
  createdAt: string;
}

export type ValidationStatus = 'PENDING' | 'COMPLETED' | 'EXPIRED';

export interface Validation {
  id: string;
  agent?: Pick<Agent, 'id'>;
  validatorAddress: string;
  requestUri: string | null;
  requestHash: string;
  response: number | null;
  responseUri: string | null;
  responseHash: string | null;
  tag: string | null;
  status: ValidationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface AgentMetadata {
  id: string;
  agent?: Pick<Agent, 'id'>;
  key: string;
  value: string;
  updatedAt: string;
}

/**
 * Per-chain registry addresses. NOT a rollup — it has no counters at all.
 * Everything adoption-shaped is derived in queries.ts.
 */
export interface Protocol {
  /** The chainId as a string, e.g. "56". */
  id: string;
  chainId: string;
  name: string;
  identityRegistry: string;
  /** 0x0000…0000 on BSC — no validation registry is deployed there. */
  validationRegistry: string;
  reputationRegistry: string;
  createdAt: string;
  updatedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Timeseries aggregations                                                     */
/*                                                                             */
/* Queried as *_collection(interval: hour|day), never as a field on Agent.     */
/* Every counter below is a CUMULATIVE running total as of `timestamp`, not a  */
/* per-bucket delta: summing buckets double-counts catastrophically. Always    */
/* read the single latest bucket. See the schema notes.                        */
/* -------------------------------------------------------------------------- */

/** Microseconds since epoch. */
export type MicroTimestamp = string;

export interface ProtocolAgentStats {
  id: string;
  timestamp: MicroTimestamp;
  protocol?: Pick<Protocol, 'id'>;
  /** Cumulative agents registered on this chain. */
  agentRegistrations: string;
}

export interface ProtocolFeedbackStats {
  id: string;
  timestamp: MicroTimestamp;
  protocol?: Pick<Protocol, 'id'>;
  feedbackCreated: string;
  feedbackRevoked: string;
  valueSum: string;
  valueDeltaSum: string;
}

export interface ProtocolValidationStats {
  id: string;
  timestamp: MicroTimestamp;
  protocol?: Pick<Protocol, 'id'>;
  validationRequests: string;
  validationResponses: string;
  scoreSum: string;
}

export interface AgentFeedbackStats {
  id: string;
  timestamp: MicroTimestamp;
  protocol?: Pick<Protocol, 'id'>;
  agent?: Pick<Agent, 'id'>;
  feedbackCreated: string;
  feedbackRevoked: string;
  valueSum: string;
  valueDeltaSum: string;
}

export interface AgentValidationStats {
  id: string;
  timestamp: MicroTimestamp;
  protocol?: Pick<Protocol, 'id'>;
  agent?: Pick<Agent, 'id'>;
  validationRequests: string;
  validationResponses: string;
  scoreSum: string;
}

/* -------------------------------------------------------------------------- */
/* Shapes this layer returns (not subgraph entities)                           */
/* -------------------------------------------------------------------------- */

/** Everything needed to judge one agent's trustworthiness, in one round trip. */
export interface AgentTrustProfile {
  chainId: number;
  /** The composite id actually queried, e.g. "56:30867". */
  id: string;
  agent: Agent | null;
  registrationFile: AgentRegistrationFile | null;
  /** Latest 20, newest first. */
  feedback: Feedback[];
  validations: Validation[];
  /** Latest cumulative bucket, or null when the agent has no feedback yet. */
  feedbackStats: AgentFeedbackStats | null;
  /** Null on chains with no validation registry (BSC). */
  validationStats: AgentValidationStats | null;
}

export interface ChainAdoption {
  chainId: number;
  chainName: string;
  /** The Protocol row, or null when the subgraph has not indexed one. */
  protocol: Protocol | null;
  /** Cumulative, from the latest protocolAgentStats bucket. */
  totalAgents: number;
  /** Cross-check on totalAgents: max(agentId) + 1, since ids are sequential from 0. */
  highestAgentId: number;
  totalFeedbackCreated: number;
  totalFeedbackRevoked: number;
  /**
   * Lossy above 2^53. Base's real sum is 2.51142355038140767847409093856573900e38
   * — feedback `value` is not a bounded score, so one row carrying a raw wei-scale
   * number dominates the total. Use `feedbackValueSumRaw` for anything exact, and
   * treat this figure as an order of magnitude, not a headline.
   */
  feedbackValueSum: number;
  /** The BigDecimal exactly as the subgraph returned it. */
  feedbackValueSumRaw: string;
  /** Zero on a chain with no validation registry — see `hasValidationRegistry`. */
  totalValidationRequests: number;
  totalValidationResponses: number;
  hasValidationRegistry: boolean;
  /** Derived by paging `agents(where: { totalFeedback_gt: 0 })`. */
  agentsWithFeedback: number;
  /** False when the page cap was hit, so agentsWithFeedback is a lower bound. */
  agentsWithFeedbackExact: boolean;
  /** Head block the answer was indexed to. */
  blockNumber: number;
}

export type ChainAdoptionResult =
  | ({ ok: true } & ChainAdoption)
  | { ok: false; chainId: number; chainName: string; error: string };
