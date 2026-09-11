/**
 * Hedera Consensus Service audit trail.
 *
 * Every settled paid request is written to one HCS topic as a compact JSON message,
 * giving the service a tamper-evident, publicly verifiable log of what it sold, to
 * whom, for how much, and which payment settled it — independent of the service's
 * own storage. The topic is created on first run and its id persisted to hedera/.env.
 *
 * Submission never blocks the HTTP response for more than HCS_SUBMIT_TIMEOUT_MS. On
 * the normal path the receipt arrives well inside that and the response carries the
 * sequence number; if consensus is slow, the response goes out without it and the
 * submit finishes in the background.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  AccountId,
  Client,
  PrivateKey,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
} from '@hiero-ledger/sdk';
import { CONFIG, ENV_PATH } from './config.js';

const TOPIC_MEMO = 'AgenSea x402 audit';

/** How long the HTTP response will wait on HCS consensus before giving up on the receipt. */
export const HCS_SUBMIT_TIMEOUT_MS = 3_000;

const MIRROR_NODE_URL =
  CONFIG.network === 'mainnet'
    ? 'https://mainnet-public.mirrornode.hedera.com'
    : 'https://testnet.mirrornode.hedera.com';

/** One audit record, as written to the topic. Kept short — HCS messages are billed by size. */
export type AuditEntry = {
  v: 1;
  endpoint: string;
  tier: string;
  payer: string;
  priceHbar: string;
  settlementTx: string;
  resultSha256: string;
  at: string;
};

export type AuditReceipt = {
  topicId: string;
  sequenceNumber?: string;
  hashscanTopicUrl: string;
};

let client: Client | null = null;
let topicId: string | null = null;

function hederaClient(): Client {
  if (client) return client;
  const c = CONFIG.network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
  c.setOperator(
    AccountId.fromString(CONFIG.serviceAccountId),
    parseServiceKey(),
  );
  client = c;
  return c;
}

function parseServiceKey(): PrivateKey {
  return CONFIG.serviceKeyType === 'ED25519'
    ? PrivateKey.fromStringED25519(CONFIG.servicePrivateKey)
    : PrivateKey.fromStringECDSA(CONFIG.servicePrivateKey);
}

export function hashscanTopicUrl(id: string): string {
  return `https://hashscan.io/${CONFIG.network}/topic/${id}`;
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function appendTopicToEnv(id: string): void {
  const existing = readFileSync(ENV_PATH, 'utf8');
  const prefix = existing.endsWith('\n') ? '' : '\n';
  appendFileSync(
    ENV_PATH,
    `${prefix}\n# HCS audit topic, created automatically on first service start.\nHCS_TOPIC_ID=${id}\n`,
  );
}

/**
 * Returns the audit topic id, creating the topic on first run.
 *
 * The topic carries the service account as both admin and submit key, so only this
 * service can append to the log while anyone can read it.
 */
export async function ensureAuditTopic(): Promise<string> {
  if (topicId) return topicId;

  const fromEnv = process.env.HCS_TOPIC_ID?.trim();
  if (fromEnv) {
    topicId = fromEnv;
    return topicId;
  }

  const key = parseServiceKey();
  const receipt = await new TopicCreateTransaction()
    .setTopicMemo(TOPIC_MEMO)
    .setAdminKey(key.publicKey)
    .setSubmitKey(key.publicKey)
    .execute(hederaClient())
    .then(response => response.getReceipt(hederaClient()));

  if (!receipt.topicId) throw new Error('TopicCreateTransaction returned no topic id');

  topicId = receipt.topicId.toString();
  appendTopicToEnv(topicId);
  process.env.HCS_TOPIC_ID = topicId;
  return topicId;
}

/**
 * Submits one audit entry.
 *
 * Resolves as soon as the receipt arrives or HCS_SUBMIT_TIMEOUT_MS elapses, whichever
 * comes first. On timeout the returned receipt has no sequenceNumber and the submit
 * continues in the background.
 */
export async function submitAudit(entry: AuditEntry): Promise<AuditReceipt> {
  const id = await ensureAuditTopic();
  const base: AuditReceipt = { topicId: id, hashscanTopicUrl: hashscanTopicUrl(id) };

  const submit = (async () => {
    const c = hederaClient();
    const response = await new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(id))
      .setMessage(JSON.stringify(entry))
      .execute(c);
    const receipt = await response.getReceipt(c);
    return receipt.topicSequenceNumber?.toString();
  })();

  // Never let a background failure become an unhandled rejection.
  submit.catch(err => console.error('[hcs] audit submit failed:', err));

  const timeout = new Promise<undefined>(resolve =>
    setTimeout(() => resolve(undefined), HCS_SUBMIT_TIMEOUT_MS).unref(),
  );

  const sequenceNumber = await Promise.race([submit.catch(() => undefined), timeout]);
  return sequenceNumber ? { ...base, sequenceNumber } : base;
}

export type AuditMessage = {
  sequenceNumber: string;
  consensusTimestamp: string;
  payerAccountId?: string;
  message: unknown;
};

/**
 * Reads the most recent audit messages back from the public mirror node, decoding the
 * base64 payloads. This is the read path a third party would use to verify the log,
 * which is why it goes through the mirror node rather than local state.
 */
export async function readRecentAudit(limit = 10): Promise<AuditMessage[]> {
  const id = await ensureAuditTopic();
  const url = `${MIRROR_NODE_URL}/api/v1/topics/${id}/messages?limit=${limit}&order=desc`;

  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`mirror node returned HTTP ${response.status} for topic ${id}`);
  }

  const body = (await response.json()) as {
    messages?: {
      sequence_number: number;
      consensus_timestamp: string;
      payer_account_id?: string;
      message: string;
    }[];
  };

  return (body.messages ?? []).map(m => {
    const raw = Buffer.from(m.message, 'base64').toString('utf8');
    let decoded: unknown = raw;
    try {
      decoded = JSON.parse(raw);
    } catch {
      // A non-JSON message is still worth surfacing verbatim.
    }
    return {
      sequenceNumber: String(m.sequence_number),
      consensusTimestamp: m.consensus_timestamp,
      payerAccountId: m.payer_account_id,
      message: decoded,
    };
  });
}

export function closeHcsClient(): void {
  client?.close();
  client = null;
}
