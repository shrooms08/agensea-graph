/**
 * x402 resource server wiring for Hedera.
 *
 * Mirrors hedera-dev/x402-inference-pay-per-request-poc: an HTTPFacilitatorClient
 * pointed at Blocky402, with the Hedera "exact" scheme registered for every Hedera
 * network so the middleware can price, verify and settle HBAR transfers.
 */
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';
import { CONFIG } from './config.js';

export function createResourceServer(): x402ResourceServer {
  const facilitatorClient = new HTTPFacilitatorClient({ url: CONFIG.facilitatorUrl });
  return new x402ResourceServer(facilitatorClient).register('hedera:*', new ExactHederaScheme({}));
}
