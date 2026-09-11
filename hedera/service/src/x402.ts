/**
 * x402 resource server wiring for Hedera.
 *
 * Mirrors hedera-dev/x402-inference-pay-per-request-poc: an HTTPFacilitatorClient
 * pointed at Blocky402, with the Hedera "exact" scheme registered for every Hedera
 * network so the middleware can price, verify and settle HBAR transfers.
 *
 * The `onAfterSettle` hook copies the settlement receipt into the per-request store.
 * Under the `upfront` payment flow that hook runs before the route handler, which is
 * what lets the handler write the settlement transaction id — and the HCS audit
 * sequence number derived from it — into the response body.
 */
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { CONFIG } from './config.js';
import { currentRequestStore } from './request-context.js';

export function createResourceServer(): x402ResourceServer {
  const facilitatorClient = new HTTPFacilitatorClient({ url: CONFIG.facilitatorUrl });

  return new x402ResourceServer(facilitatorClient)
    .register('hedera:*', new ExactHederaScheme({}))
    .onAfterSettle(async ({ result }) => {
      const store = currentRequestStore();
      if (!store || !result.success) return;
      store.settlementTx = result.transaction;
      store.payer = result.payer;
      store.amount = result.amount;
    });
}
