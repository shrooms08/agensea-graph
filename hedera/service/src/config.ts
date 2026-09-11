/**
 * Environment loading for the Hedera x402 service.
 *
 * Tolerates a known quirk of the provisioned hedera/.env: SERVICE_PRIVATE_KEY and
 * SERVICE_KEY_TYPE were populated the wrong way round — the private key landed in
 * SERVICE_KEY_TYPE and the account's EVM alias in SERVICE_PRIVATE_KEY. Rather than
 * rewrite a file holding live secrets, we detect the two values by shape and route
 * them to the right place. A correctly-filled .env passes through untouched.
 */
import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIER_PRICE_HBAR } from './tiers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** hedera/.env — shared by the service and the agent. */
export const ENV_PATH = resolve(HERE, '../../.env');

loadDotenv({ path: ENV_PATH });

export type KeyType = 'ECDSA' | 'ED25519';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RAW_32_BYTE = /^(0x)?[0-9a-fA-F]{64}$/;
const DER_ENCODED = /^30[0-9a-fA-F]+$/;

const isPrivateKeyish = (v: string) => RAW_32_BYTE.test(v) || DER_ENCODED.test(v);
const isKeyTypeLabel = (v: string) => /^(ECDSA|ED25519)$/i.test(v.replace(/[-_\s]/g, ''));

/**
 * Returns { privateKey, keyType } from a PRIVATE_KEY / KEY_TYPE pair, swapping them
 * back if the values are in the wrong slots. `evmAddress` is surfaced when one of the
 * fields turns out to hold an EVM alias instead.
 */
export function resolveKeyPair(
  rawKey: string | undefined,
  rawType: string | undefined,
  label: string,
): { privateKey: string; keyType: KeyType; evmAddress?: string } {
  const key = (rawKey ?? '').trim();
  const type = (rawType ?? '').trim();

  let privateKey = key;
  let keyType = type;
  let evmAddress: string | undefined;

  if (!isPrivateKeyish(key) && isPrivateKeyish(type)) {
    privateKey = type;
    keyType = isKeyTypeLabel(key) ? key : '';
    if (EVM_ADDRESS.test(key)) evmAddress = key;
  }

  if (!isPrivateKeyish(privateKey)) {
    throw new Error(
      `${label}: no usable private key found. Expected a 32-byte hex or DER-encoded key ` +
        `in ${label}_PRIVATE_KEY (or ${label}_KEY_TYPE, if the two were swapped).`,
    );
  }

  // With no explicit label, infer: DER keys carry their own OID, and a bare 32-byte
  // hex on an account with an EVM alias is secp256k1. ECDSA is the portal default.
  const normalised = keyType.replace(/[-_\s]/g, '').toUpperCase();
  const resolvedType: KeyType =
    normalised === 'ED25519' ? 'ED25519' : normalised === 'ECDSA' ? 'ECDSA' : 'ECDSA';

  return { privateKey, keyType: resolvedType, evmAddress: evmAddress ?? process.env.SERVICE_EVM_ADDRESS };
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is required in ${ENV_PATH}`);
  return v;
}

const network = (process.env.HEDERA_NETWORK ?? 'testnet').trim().toLowerCase();
if (network !== 'testnet' && network !== 'mainnet') {
  throw new Error(`HEDERA_NETWORK must be "testnet" or "mainnet", got "${network}"`);
}

const priceHbar = process.env.PRICE_HBAR?.trim() ?? '0.1';
/** Hedera's smallest unit: 1 HBAR = 100,000,000 tinybars. */
const TINYBARS_PER_HBAR = 100_000_000n;

/** Converts a decimal HBAR string to an integer tinybar string without floating point. */
export function hbarToTinybars(hbar: string): string {
  const [whole, frac = ''] = hbar.split('.');
  if (frac.length > 8) throw new Error(`PRICE_HBAR has more than 8 decimals: ${hbar}`);
  return (BigInt(whole || '0') * TINYBARS_PER_HBAR + BigInt((frac + '00000000').slice(0, 8))).toString();
}

const serviceKeys = resolveKeyPair(
  process.env.SERVICE_PRIVATE_KEY,
  process.env.SERVICE_KEY_TYPE,
  'SERVICE',
);

const tinybarsForTier = {
  summary: hbarToTinybars(TIER_PRICE_HBAR.summary),
  full: hbarToTinybars(TIER_PRICE_HBAR.full),
} as const;

export const CONFIG = {
  /** "testnet" | "mainnet" */
  network,
  /** CAIP-2 identifier the facilitator advertises, e.g. "hedera:testnet". */
  caip2: `hedera:${network}` as `hedera:${'testnet' | 'mainnet'}`,
  serviceAccountId: required('SERVICE_ACCOUNT_ID'),
  servicePrivateKey: serviceKeys.privateKey,
  serviceKeyType: serviceKeys.keyType,
  facilitatorUrl: (process.env.FACILITATOR_URL ?? 'https://api.testnet.blocky402.com').replace(/\/$/, ''),
  /** Legacy flat price, kept for the flat-pricing fallback and for display. */
  priceHbar,
  priceTinybars: hbarToTinybars(priceHbar),
  /** Per-tier price in tinybars. */
  tinybarsForTier,
  port: parseInt(process.env.PORT ?? '4021', 10),
  /**
   * Interface to bind. Containers must listen on all interfaces for the platform's
   * proxy to reach them, so this defaults to 0.0.0.0 rather than loopback.
   */
  host: process.env.HOST ?? '0.0.0.0',
  /**
   * Public base URL, when the service is deployed behind a proxy. Used for the
   * examples on the landing page so they are copy-pasteable as shown.
   */
  publicUrl: process.env.PUBLIC_URL?.trim().replace(/\/$/, '') || null,
} as const;
