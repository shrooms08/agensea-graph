/**
 * Environment loading for the buyer agent. Shares hedera/.env with the service and
 * applies the same swapped-field tolerance (see hedera/service/src/config.ts).
 */
import { config as loadDotenv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENV_PATH = resolve(HERE, '../../.env');

loadDotenv({ path: ENV_PATH });

export type KeyType = 'ECDSA' | 'ED25519';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const RAW_32_BYTE = /^(0x)?[0-9a-fA-F]{64}$/;
const DER_ENCODED = /^30[0-9a-fA-F]+$/;

const isPrivateKeyish = (v: string) => RAW_32_BYTE.test(v) || DER_ENCODED.test(v);
const isKeyTypeLabel = (v: string) => /^(ECDSA|ED25519)$/i.test(v.replace(/[-_\s]/g, ''));

export function resolveKeyPair(
  rawKey: string | undefined,
  rawType: string | undefined,
  label: string,
): { privateKey: string; keyType: KeyType } {
  const key = (rawKey ?? '').trim();
  const type = (rawType ?? '').trim();

  let privateKey = key;
  let keyType = type;

  if (!isPrivateKeyish(key) && isPrivateKeyish(type)) {
    privateKey = type;
    keyType = isKeyTypeLabel(key) || !EVM_ADDRESS.test(key) ? key : '';
  }

  if (!isPrivateKeyish(privateKey)) {
    throw new Error(`${label}: no usable private key in ${label}_PRIVATE_KEY / ${label}_KEY_TYPE`);
  }

  const normalised = keyType.replace(/[-_\s]/g, '').toUpperCase();
  return { privateKey, keyType: normalised === 'ED25519' ? 'ED25519' : 'ECDSA' };
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

const service = resolveKeyPair(process.env.SERVICE_PRIVATE_KEY, process.env.SERVICE_KEY_TYPE, 'SERVICE');

export const CONFIG = {
  network: network as 'testnet' | 'mainnet',
  caip2: `hedera:${network}` as `hedera:${'testnet' | 'mainnet'}`,
  serviceAccountId: required('SERVICE_ACCOUNT_ID'),
  servicePrivateKey: service.privateKey,
  serviceKeyType: service.keyType,
  serviceUrl: (process.env.SERVICE_URL ?? `http://localhost:${process.env.PORT ?? '4021'}`).replace(/\/$/, ''),
} as const;

/** HBAR the agent funds a freshly created buyer account with. */
export const BUYER_FUNDING_HBAR = 50;

/** Hedera's smallest unit: 1 HBAR = 100,000,000 tinybars. */
const TINYBARS_PER_HBAR = 100_000_000n;

/** Converts a decimal HBAR string to an integer tinybar string without floating point. */
export function hbarToTinybars(hbar: string): string {
  const [whole, frac = ''] = hbar.split('.');
  if (frac.length > 8) throw new Error(`value has more than 8 decimals: ${hbar}`);
  return (BigInt(whole || '0') * TINYBARS_PER_HBAR + BigInt((frac + '00000000').slice(0, 8))).toString();
}

/**
 * Per-payment ceiling the buyer will authorise, in tinybars.
 *
 * x402's client spend controls only auto-allow "default assets", which on Hedera means
 * USDC — native HBAR has to be opted into explicitly. Rather than switch the controls
 * off, the agent opts HBAR in behind this cap, so a service that quotes more than the
 * agreed budget is refused before anything is signed.
 */
export const MAX_SPEND_TINYBARS = hbarToTinybars(process.env.MAX_SPEND_HBAR?.trim() || '1');
