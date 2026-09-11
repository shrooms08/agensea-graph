/**
 * Per-request store, so the route handler can see facts the x402 middleware learned.
 *
 * The paid route runs under the `upfront` payment flow, which settles *before* the
 * handler. The resource server's `onAfterSettle` hook fires inside the same async
 * context as the request, so it can drop the settlement receipt here and the handler
 * can pick it up — which is what lets the response body carry both the settlement
 * transaction id and the HCS sequence number it produced.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tier } from './tiers.js';

export type RequestStore = {
  tier: Tier;
  /** Hedera transaction id of the settled payment, once the facilitator reports it. */
  settlementTx?: string;
  /** Account that paid, as reported by the facilitator. */
  payer?: string;
  /** Atomic amount actually settled, in tinybars. */
  amount?: string;
};

const storage = new AsyncLocalStorage<RequestStore>();

export function runWithRequestStore<T>(store: RequestStore, fn: () => T): T {
  return storage.run(store, fn);
}

export function currentRequestStore(): RequestStore | undefined {
  return storage.getStore();
}
