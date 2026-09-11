/**
 * Buyer account provisioning.
 *
 * If hedera/.env has no BUYER_ACCOUNT_ID / BUYER_PRIVATE_KEY, creates a fresh testnet
 * account with the same key type as the service account, funds it from the service
 * account with an initial balance, and appends the credentials to hedera/.env.
 *
 * Uses @hiero-ledger/sdk (the maintained continuation of @hashgraph/sdk, same API)
 * because @x402/hedera pins and re-exports it — two copies of the SDK in one process
 * cross-fail each other's instanceof checks.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import {
  AccountCreateTransaction,
  AccountId,
  Client,
  Hbar,
  PrivateKey,
} from '@hiero-ledger/sdk';
import { BUYER_FUNDING_HBAR, CONFIG, ENV_PATH, resolveKeyPair, type KeyType } from './config.js';

export type BuyerCredentials = {
  accountId: string;
  privateKey: PrivateKey;
  keyType: KeyType;
  created: boolean;
};

/** Parses a private key string with the method matching its declared type. */
export function parsePrivateKey(value: string, keyType: KeyType): PrivateKey {
  return keyType === 'ED25519' ? PrivateKey.fromStringED25519(value) : PrivateKey.fromStringECDSA(value);
}

function hederaClient(): Client {
  const client = CONFIG.network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(
    AccountId.fromString(CONFIG.serviceAccountId),
    parsePrivateKey(CONFIG.servicePrivateKey, CONFIG.serviceKeyType),
  );
  return client;
}

function envHasBuyer(): boolean {
  const id = process.env.BUYER_ACCOUNT_ID?.trim();
  const key = process.env.BUYER_PRIVATE_KEY?.trim();
  return Boolean(id && key);
}

function appendBuyerToEnv(accountId: string, privateKey: string, keyType: KeyType): void {
  const existing = readFileSync(ENV_PATH, 'utf8');
  const prefix = existing.endsWith('\n') ? '' : '\n';
  appendFileSync(
    ENV_PATH,
    `${prefix}\n# Buyer agent account, created automatically by \`npm run buy\`.\n` +
      `BUYER_ACCOUNT_ID=${accountId}\n` +
      `BUYER_PRIVATE_KEY=${privateKey}\n` +
      `BUYER_KEY_TYPE=${keyType}\n`,
  );
}

export async function ensureBuyerAccount(): Promise<BuyerCredentials> {
  if (envHasBuyer()) {
    const { privateKey, keyType } = resolveKeyPair(
      process.env.BUYER_PRIVATE_KEY,
      process.env.BUYER_KEY_TYPE,
      'BUYER',
    );
    return {
      accountId: process.env.BUYER_ACCOUNT_ID!.trim(),
      privateKey: parsePrivateKey(privateKey, keyType),
      keyType,
      created: false,
    };
  }

  const keyType = CONFIG.serviceKeyType;
  const newKey = keyType === 'ED25519' ? PrivateKey.generateED25519() : PrivateKey.generateECDSA();

  const client = hederaClient();
  try {
    const receipt = await new AccountCreateTransaction()
      .setKeyWithoutAlias(newKey.publicKey)
      .setInitialBalance(new Hbar(BUYER_FUNDING_HBAR))
      .execute(client)
      .then(response => response.getReceipt(client));

    const accountId = receipt.accountId;
    if (!accountId) throw new Error('AccountCreateTransaction returned no account id');

    appendBuyerToEnv(accountId.toString(), newKey.toStringRaw(), keyType);

    return { accountId: accountId.toString(), privateKey: newKey, keyType, created: true };
  } finally {
    client.close();
  }
}
