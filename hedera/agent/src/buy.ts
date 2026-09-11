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

function hashscanUrl(transactionId: string): string {
  return `https://hashscan.io/${CONFIG.network}/transaction/${transactionId}`;
}

async function main(): Promise<void> {
  const address = process.argv[2]?.trim();
  if (!address || !ADDRESS_RE.test(address)) {
    console.error('usage: npm run buy -- <bsc address>');
    console.error('   eg: npm run buy -- 0x0000000000000000000000000000000000000000');
    process.exit(1);
  }

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
  console.log(`POST ${url}  { "address": "${address}" }`);

  const response = await fetchWithPayment(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`\nrequest failed: HTTP ${response.status}`);
    console.error(body);
    process.exit(1);
  }

  console.log('\n─── service response ───');
  console.log(JSON.stringify(JSON.parse(body), null, 2));

  const receiptHeader =
    response.headers.get('PAYMENT-RESPONSE') ?? response.headers.get('X-PAYMENT-RESPONSE');
  if (!receiptHeader) {
    console.warn('\nno PAYMENT-RESPONSE header on the response — payment receipt unavailable');
    return;
  }

  const receipt = decodePaymentResponseHeader(receiptHeader);
  console.log('\n─── settlement ───');
  console.log(`success        ${receipt.success}`);
  console.log(`payer          ${receipt.payer ?? buyer.accountId}`);
  console.log(`network        ${receipt.network}`);
  console.log(`transaction    ${receipt.transaction}`);
  console.log(`hashscan       ${hashscanUrl(receipt.transaction)}`);
}

main().catch(err => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
