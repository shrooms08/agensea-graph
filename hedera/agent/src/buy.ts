/**
 * Buyer agent: pays for one Venus health-factor read over x402 on Hedera.
 *
 *   npm run buy -- 0x<bsc address>
 *
 * Flow: ensure a funded buyer account exists → POST the request → receive 402 →
 * @x402/fetch builds the partially-signed HBAR TransferTransaction via the Hedera
 * exact scheme and retries with the PAYMENT-SIGNATURE header → the facilitator
 * co-signs as fee payer, submits, and the settled transaction id comes back on the
 * PAYMENT-RESPONSE header.
 */
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner } from '@x402/hedera';
import { CONFIG, MAX_SPEND_TINYBARS } from './config.js';
import { ensureBuyerAccount } from './buyer-account.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TIERS = ['summary', 'full'] as const;
type Tier = (typeof TIERS)[number];

function hashscanUrl(transactionId: string): string {
  return `https://hashscan.io/${CONFIG.network}/transaction/${transactionId}`;
}

function usage(message: string): never {
  console.error(message);
  console.error('usage: npm run buy -- <bsc address> [summary|full]');
  console.error('   eg: npm run buy -- 0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f summary');
  process.exit(1);
}

/**
 * Parses `<address> [tier]` / `<address> [--tier t]` in any order.
 *
 * A bare tier token is accepted as well as the flag because `npm run buy` hops through
 * two npm invocations, and npm consumes an unrecognised `--tier` as its own config
 * before the script ever sees it. The positional form survives both hops.
 */
function parseArgs(argv: string[]): { address: string; tier: Tier } {
  let address: string | undefined;
  let tier: Tier | undefined;

  const setTier = (value: string | undefined) => {
    if (!TIERS.includes(value as Tier)) usage(`unknown tier: ${value ?? '(missing)'}`);
    tier = value as Tier;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tier' || arg === '-t') {
      setTier(argv[++i]);
    } else if (arg.startsWith('--tier=')) {
      setTier(arg.slice('--tier='.length));
    } else if (TIERS.includes(arg as Tier)) {
      setTier(arg);
    } else if (!address) {
      address = arg;
    } else {
      usage(`unexpected argument: ${arg}`);
    }
  }

  if (!address || !ADDRESS_RE.test(address)) usage(`not a BSC address: ${address ?? '(missing)'}`);
  return { address, tier: tier ?? 'full' };
}

async function main(): Promise<void> {
  const { address, tier } = parseArgs(process.argv.slice(2).map(a => a.trim()).filter(Boolean));

  const buyer = await ensureBuyerAccount();
  if (buyer.created) {
    console.log(`created buyer account ${buyer.accountId} (credentials appended to hedera/.env)`);
  } else {
    console.log(`using buyer account ${buyer.accountId}`);
  }

  const signer = createClientHederaSigner(buyer.accountId, buyer.privateKey, {
    network: CONFIG.caip2,
  });
  const client = new x402Client()
    .register(CONFIG.caip2, new ExactHederaScheme(signer))
    // HBAR is not one of x402's recognised default assets on Hedera (USDC is), so it
    // must be opted into by asset id. The cap is the agent's own budget for one call.
    .setSpendControls({
      allowedAssets: [
        { network: CONFIG.caip2, asset: '0.0.0', maxAmountPerPayment: MAX_SPEND_TINYBARS },
      ],
    });
  const fetchWithPayment = wrapFetchWithPayment(globalThis.fetch, client);

  const url = `${CONFIG.serviceUrl}/api/venus-health`;
  console.log(`POST ${url}  { "address": "${address}", "tier": "${tier}" }`);

  const response = await fetchWithPayment(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, tier }),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`\nrequest failed: HTTP ${response.status}`);
    console.error(body);
    process.exit(1);
  }

  const parsed = JSON.parse(body) as {
    audit?: { topicId?: string | null; sequenceNumber?: string; hashscanTopicUrl?: string };
  };

  console.log('\n─── service response ───');
  console.log(JSON.stringify(parsed, null, 2));

  const receiptHeader =
    response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
  if (!receiptHeader) {
    console.warn('\nno PAYMENT-RESPONSE header on the response — payment receipt unavailable');
    return;
  }

  const receipt = decodePaymentResponseHeader(receiptHeader);
  console.log('\n─── settlement ───');
  console.log(`tier           ${tier}`);
  console.log(`success        ${receipt.success}`);
  console.log(`payer          ${receipt.payer ?? buyer.accountId}`);
  console.log(`network        ${receipt.network}`);
  console.log(`transaction    ${receipt.transaction}`);
  console.log(`hashscan       ${hashscanUrl(receipt.transaction)}`);

  const audit = parsed.audit;
  if (audit?.topicId) {
    console.log('\n─── hcs audit ───');
    console.log(`topic          ${audit.topicId}`);
    console.log(`sequence       ${audit.sequenceNumber ?? '(pending consensus)'}`);
    console.log(`hashscan       ${audit.hashscanTopicUrl ?? ''}`);
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
