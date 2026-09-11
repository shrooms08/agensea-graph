/**
 * Metering tiers.
 *
 * The buyer names a tier in the request body; x402's DynamicPrice reads that same body
 * when it builds the 402, so one route quotes two prices. `full` is the default so an
 * omitted tier behaves exactly as it did before tiers existed.
 */
export const TIERS = ['summary', 'full'] as const;
export type Tier = (typeof TIERS)[number];

export const DEFAULT_TIER: Tier = 'full';

/** Price per tier, as a decimal HBAR string. */
export const TIER_PRICE_HBAR: Record<Tier, string> = {
  summary: '0.05',
  full: '0.1',
};

export const TIER_DESCRIPTION: Record<Tier, string> = {
  summary: 'Health factor, risk level and recommendation only',
  full: 'Everything, including the per-market breakdown',
};

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

/**
 * Reads the tier from a parsed request body, falling back to the default.
 * An unrecognised tier also falls back rather than throwing — the route handler
 * rejects bad input with a 400, and the pricing path must never throw mid-402.
 */
export function tierFromBody(body: unknown): Tier {
  const raw = (body as { tier?: unknown } | null | undefined)?.tier;
  return isTier(raw) ? raw : DEFAULT_TIER;
}
