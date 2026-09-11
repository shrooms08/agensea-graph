/**
 * ERC-8004 identity for the agent behind this service.
 *
 * The paid endpoint is machine-to-machine, so a buyer agent needs to know *which*
 * agent it is paying before it commits funds. ERC-8004 gives that a portable answer:
 * an identity-registry entry the buyer can resolve independently of anything this
 * service says about itself. We surface it in the three places a buyer looks — the
 * 402 quote, GET /health, and the paid response.
 *
 * The registration is AgenSea's own, already on chain before this service existed:
 * Venus Health Factor Monitor, agentId 322885 in the BNB Smart Chain mainnet
 * IdentityRegistry (registered 31 Aug 2026, tx 0x381cff97…). Its metadata already
 * declares `x402Support: true`; this service is that support, made real on Hedera.
 *
 * The agent URI is a `data:application/json;base64,…` blob rather than a hosted
 * AgentCard — a deliberate choice recorded in apps/agents/src/agent/identity.ts,
 * after Phase 1b measured 59/59 hosted agent URIs returning 404. The record below is
 * byte-identical to what `tokenURI(322885)` returns on chain 56; `verify` tells a
 * buyer how to confirm that themselves rather than trusting this file.
 */

/** Byte-identical to the record registered on chain. Source: apps/agents/src/agent/identity.ts. */
const AGENT_RECORD = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'Venus Health Factor Monitor',
  description:
    "Reads any wallet's Venus Protocol lending position and returns its health factor, " +
    'collateral, borrowings, per-market liquidation thresholds, and a plain-language risk ' +
    'recommendation. Read-only analysis over eth_call; supports BNB Chain mainnet (56) and testnet (97).',
  image: 'https://raw.githubusercontent.com/VenusProtocol/venus-protocol/main/logo.png',
  category: 'health-factor-monitoring',
  services: [
    { name: 'x402', endpoint: 'https://agensea-health-factor.vercel.app/x402' },
    { name: 'erc8183', endpoint: 'onchain:AgenticCommerce.submit' },
  ],
  x402Support: true,
  active: true,
  supportedTrust: ['reputation'],
  registrations: [] as { agentId: number; agentRegistry: string }[],
} as const;

/** The registered URI form: our extra fields survive verbatim through base64. */
function toAgentUri(record: unknown): string {
  return 'data:application/json;base64,' + Buffer.from(JSON.stringify(record), 'utf8').toString('base64');
}

export type AgentIdentity = {
  name: string;
  agentId: string;
  registry: string;
  chainId: number;
  agentUri: string;
  listingUrl: string;
  /** The earlier BNB testnet registration of the same agent. */
  testnetRegistration: { agentId: string; registry: string; chainId: number };
  /** How to confirm the above against chain rather than trusting this response. */
  verify: { method: string; note: string };
};

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** .env may override any field, so one build can point at a different registration. */
export const IDENTITY: AgentIdentity = {
  name: AGENT_RECORD.name,
  agentId: env('AGENT_ERC8004_ID') ?? '322885',
  registry: env('AGENT_ERC8004_REGISTRY') ?? '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  chainId: Number(env('AGENT_ERC8004_CHAIN_ID') ?? '56'),
  agentUri: env('AGENT_ERC8004_URI') ?? toAgentUri(AGENT_RECORD),
  listingUrl: env('AGENT_LISTING_URL') ?? 'https://agensea-navy.vercel.app/marketplace/2012',
  testnetRegistration: {
    agentId: '2012',
    registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    chainId: 97,
  },
  verify: {
    method: 'eth_call tokenURI(uint256) — selector 0xc87b56dd — on the registry above',
    note: 'Returns the same data: URI as agentUri. The agent reads Venus on BSC mainnet (56) and is paid on Hedera testnet.',
  },
};

/** Compact form for places where the 1KB data: URI is noise. */
export const IDENTITY_SUMMARY = {
  name: IDENTITY.name,
  agentId: IDENTITY.agentId,
  registry: IDENTITY.registry,
  chainId: IDENTITY.chainId,
  listingUrl: IDENTITY.listingUrl,
};
