/**
 * The paid business logic: a Venus Protocol health-factor read for one BSC address.
 *
 * Read-only eth_call against BSC mainnet — no key, no transaction. If the RPC is
 * unreachable or the read throws, we fall back to deterministic sample data that is
 * labelled `source: "MOCK"` in the response, so a demo never dies on a flaky RPC.
 */
import { analyze, type Analysis } from './venus/analyze.js';

/** BSC mainnet. The vendored reader keys its deployment table on chain id. */
const BSC_MAINNET = 56 as const;

export type VenusHealthResponse = {
  address: string;
  source: 'REAL' | 'MOCK';
  chainId: number;
  chainLabel: string;
  blockNumber: number;
  healthFactor: number | null;
  riskLevel: string;
  collateralUsd: number;
  borrowedUsd: number;
  liquidityUsd: number;
  shortfallUsd: number;
  priceDropToLiquidation: number | null;
  recommendation: string;
  markets: Analysis['markets'];
  checkedAt: string;
  /** Present only when `source` is MOCK. */
  mockReason?: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isBscAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS_RE.test(value);
}

function toResponse(a: Analysis, liquidityUsd: number, shortfallUsd: number): VenusHealthResponse {
  return {
    address: a.account,
    source: 'REAL',
    chainId: a.chainId,
    chainLabel: a.chainLabel,
    blockNumber: a.blockNumber,
    healthFactor: a.healthFactor,
    riskLevel: a.riskLevel,
    collateralUsd: a.collateralUsd,
    borrowedUsd: a.borrowedUsd,
    liquidityUsd,
    shortfallUsd,
    priceDropToLiquidation: a.priceDropToLiquidation,
    recommendation: a.recommendation,
    markets: a.markets,
    checkedAt: new Date().toISOString(),
  };
}

function mock(address: string, reason: string): VenusHealthResponse {
  return {
    address: address.toLowerCase(),
    source: 'MOCK',
    chainId: BSC_MAINNET,
    chainLabel: 'BNB Smart Chain mainnet',
    blockNumber: 0,
    healthFactor: 1.42,
    riskLevel: 'MODERATE',
    collateralUsd: 25_000,
    borrowedUsd: 12_500,
    liquidityUsd: 5_000,
    shortfallUsd: 0,
    priceDropToLiquidation: 0.2958,
    recommendation:
      'MOCK DATA — the live Venus read was unavailable, so this is deterministic sample output and must not be used for any real decision.',
    markets: [],
    checkedAt: new Date().toISOString(),
    mockReason: reason,
  };
}

export async function getVenusHealth(address: string): Promise<VenusHealthResponse> {
  try {
    const analysis = await analyze(BSC_MAINNET, address);
    // The Comptroller's own liquidity/shortfall view, 1e18-scaled, is carried on the
    // position; analyze() drops it, so recompute the USD figures from the analysis.
    const liquidityUsd = Math.max(analysis.borrowPowerUsd - analysis.borrowedUsd, 0);
    const shortfallUsd = Math.max(analysis.borrowedUsd - analysis.borrowPowerUsd, 0);
    return toResponse(analysis, round2(liquidityUsd), round2(shortfallUsd));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[venus] live read failed, returning MOCK:', reason);
    return mock(address, reason);
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The `summary` tier: the verdict without the per-market breakdown behind it. */
export type VenusHealthSummary = Pick<
  VenusHealthResponse,
  'address' | 'source' | 'healthFactor' | 'riskLevel' | 'recommendation' | 'checkedAt'
>;

export function summarise(full: VenusHealthResponse): VenusHealthSummary {
  return {
    address: full.address,
    source: full.source,
    healthFactor: full.healthFactor,
    riskLevel: full.riskLevel,
    recommendation: full.recommendation,
    checkedAt: full.checkedAt,
  };
}
