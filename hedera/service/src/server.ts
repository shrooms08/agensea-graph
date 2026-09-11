/**
 * x402-gated Venus health service on Hedera testnet.
 *
 *   GET  /                  free   — human-readable landing page
 *   GET  /health            free   — liveness, prices, payee, agent identity
 *   GET  /audit             free   — last 10 HCS audit records, read from the mirror node
 *   POST /api/venus-health  paid   — 0.05 HBAR (summary) or 0.1 HBAR (full)
 *
 * The paid route runs under x402's `upfront` payment flow: the facilitator settles
 * before the handler runs. That ordering is what lets one response carry the work,
 * the settlement transaction id, and the HCS audit sequence number that records both.
 */
import express, { type Request, type Response } from 'express';
import { paymentMiddleware } from '@x402/express';
import type { HTTPRequestContext } from '@x402/core/server';
import { CONFIG } from './config.js';
import { createResourceServer } from './x402.js';
import { getVenusHealth, isBscAddress, summarise } from './venus-health.js';
import { IDENTITY, IDENTITY_SUMMARY } from './identity.js';
import { DEFAULT_TIER, TIER_DESCRIPTION, TIER_PRICE_HBAR, isTier, tierFromBody, type Tier } from './tiers.js';
import { runWithRequestStore, currentRequestStore } from './request-context.js';
import { ensureAuditTopic, hashscanTopicUrl, readRecentAudit, sha256Hex, submitAudit } from './hcs.js';
import { renderLandingPage } from './page.js';

// The vendored Venus reader looks up its RPC in ALCHEMY_BSC and otherwise uses a
// public fallback. Let hedera/.env override it with a plain BSC_RPC_URL.
if (process.env.BSC_RPC_URL && !process.env.ALCHEMY_BSC) {
  process.env.ALCHEMY_BSC = process.env.BSC_RPC_URL;
}

const PAID_PATH = '/api/venus-health';
const PAID_ROUTE = `POST ${PAID_PATH}`;

/** Explicit AssetAmount: 0.0.0 is HBAR, amount in tinybars. */
const priceForTier = (tier: Tier) => ({
  asset: '0.0.0',
  amount: CONFIG.tinybarsForTier[tier],
});

const app = express();
app.use(express.json({ limit: '256kb' }));

// Establish the per-request store before the x402 middleware, so the resource
// server's onAfterSettle hook and the route handler share one async context.
app.use(PAID_PATH, (req, res, next) => {
  runWithRequestStore({ tier: tierFromBody(req.body) }, next);
});

// x402 v2 carries the PaymentRequired document in the base64 PAYMENT-REQUIRED header
// and leaves the 402 body empty. A header is not readable in a demo, so mirror the
// decoded document into the body alongside a plain-language quote and the agent's
// ERC-8004 identity. Clients still read the header, which takes precedence.
app.use((req: Request, res: Response, next) => {
  if (`${req.method} ${req.path}` !== PAID_ROUTE) return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode !== 402) return json(body);

    const tier = currentRequestStore()?.tier ?? DEFAULT_TIER;
    const enriched: Record<string, unknown> = {
      ...(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}),
      error: 'Payment Required',
      quote: {
        tier,
        price: `${TIER_PRICE_HBAR[tier]} HBAR`,
        amountTinybars: CONFIG.tinybarsForTier[tier],
        asset: 'HBAR (native, asset id 0.0.0)',
        network: CONFIG.caip2,
        payTo: CONFIG.serviceAccountId,
        facilitator: CONFIG.facilitatorUrl,
        scheme: 'exact',
        paymentFlow: 'upfront',
      },
      tiers: Object.fromEntries(
        (Object.keys(TIER_PRICE_HBAR) as Tier[]).map(t => [
          t,
          { priceHbar: TIER_PRICE_HBAR[t], returns: TIER_DESCRIPTION[t] },
        ]),
      ),
      agent: IDENTITY,
      audit: auditPointer(),
    };

    const header = res.getHeader('PAYMENT-REQUIRED');
    if (typeof header === 'string') {
      try {
        enriched.paymentRequired = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
      } catch {
        // Header is authoritative for clients; a decode failure only costs readability.
      }
    }

    return json(enriched);
  };
  next();
});

app.use(
  paymentMiddleware(
    {
      [PAID_ROUTE]: {
        accepts: [
          {
            scheme: 'exact',
            // Dynamic price: the tier named in the request body decides what the 402 quotes.
            price: (context: HTTPRequestContext) =>
              priceForTier(tierFromBody(context.adapter.getBody?.())),
            network: CONFIG.caip2,
            payTo: CONFIG.serviceAccountId,
            // Settle before the handler so the response can carry the receipt.
            extra: { paymentFlow: 'upfront' },
          },
        ],
        description: `Venus Protocol health-factor read for one BSC address — ${TIER_PRICE_HBAR.summary} or ${TIER_PRICE_HBAR.full} HBAR`,
        mimeType: 'application/json',
      },
    },
    createResourceServer(),
  ),
);

app.post(PAID_PATH, async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { address?: unknown; tier?: unknown };

  if (!isBscAddress(body.address)) {
    res.status(400).json({ error: 'body must be { "address": "0x<40 hex>", "tier"?: "summary"|"full" }' });
    return;
  }
  if (body.tier !== undefined && !isTier(body.tier)) {
    res.status(400).json({ error: `tier must be one of: ${Object.keys(TIER_PRICE_HBAR).join(', ')}` });
    return;
  }

  const store = currentRequestStore();
  const tier = store?.tier ?? DEFAULT_TIER;

  try {
    const full = await getVenusHealth(body.address);
    const result = tier === 'summary' ? summarise(full) : full;

    const audit = await recordAudit(tier, result, store?.settlementTx, store?.payer);

    res.json({
      ...result,
      tier,
      agent: IDENTITY_SUMMARY,
      payment: {
        priceHbar: TIER_PRICE_HBAR[tier],
        network: CONFIG.caip2,
        payer: store?.payer ?? null,
        settlementTx: store?.settlementTx ?? null,
        hashscanUrl: store?.settlementTx
          ? `https://hashscan.io/${CONFIG.network}/transaction/${store.settlementTx}`
          : null,
      },
      audit,
    });
  } catch (err) {
    console.error('[venus-health] unexpected failure:', err);
    res.status(500).json({ error: 'venus read failed' });
  }
});

/**
 * Writes one record of this sale to the HCS topic. A failure here must never fail a
 * request the buyer already paid for, so it degrades to an audit object carrying the
 * error instead of throwing.
 */
async function recordAudit(
  tier: Tier,
  result: unknown,
  settlementTx: string | undefined,
  payer: string | undefined,
) {
  try {
    return await submitAudit({
      v: 1,
      endpoint: PAID_PATH,
      tier,
      payer: payer ?? 'unknown',
      priceHbar: TIER_PRICE_HBAR[tier],
      settlementTx: settlementTx ?? 'unknown',
      resultSha256: sha256Hex(result),
      at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[hcs] could not record audit entry:', err);
    return { ...auditPointer(), error: 'audit submit failed' };
  }
}

function auditPointer() {
  const id = process.env.HCS_TOPIC_ID?.trim();
  return id ? { topicId: id, hashscanTopicUrl: hashscanTopicUrl(id) } : { topicId: null };
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    network: CONFIG.caip2,
    priceHbar: TIER_PRICE_HBAR[DEFAULT_TIER],
    payTo: CONFIG.serviceAccountId,
    facilitator: CONFIG.facilitatorUrl,
    tiers: Object.fromEntries(
      (Object.keys(TIER_PRICE_HBAR) as Tier[]).map(t => [
        t,
        { priceHbar: TIER_PRICE_HBAR[t], returns: TIER_DESCRIPTION[t] },
      ]),
    ),
    agent: IDENTITY,
    audit: auditPointer(),
  });
});

app.get('/audit', async (_req: Request, res: Response) => {
  try {
    const messages = await readRecentAudit(10);
    res.json({ ...auditPointer(), count: messages.length, messages });
  } catch (err) {
    console.error('[audit] mirror node read failed:', err);
    res.status(502).json({ ...auditPointer(), error: 'mirror node read failed' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.type('html').send(
    renderLandingPage({
      network: CONFIG.caip2,
      payTo: CONFIG.serviceAccountId,
      facilitator: CONFIG.facilitatorUrl,
      port: CONFIG.port,
      topicId: process.env.HCS_TOPIC_ID?.trim() ?? null,
      hashscanTopicUrl: process.env.HCS_TOPIC_ID?.trim()
        ? hashscanTopicUrl(process.env.HCS_TOPIC_ID.trim())
        : null,
    }),
  );
});

const topic = await ensureAuditTopic();

app.listen(CONFIG.port, () => {
  console.log(`\n  AgenSea x402 on Hedera — Venus health service`);
  console.log(`  http://localhost:${CONFIG.port}`);
  console.log(`  network      ${CONFIG.caip2}`);
  console.log(`  tiers        summary ${TIER_PRICE_HBAR.summary} HBAR · full ${TIER_PRICE_HBAR.full} HBAR`);
  console.log(`  payTo        ${CONFIG.serviceAccountId}`);
  console.log(`  facilitator  ${CONFIG.facilitatorUrl}`);
  console.log(`  agent        ERC-8004 #${IDENTITY.agentId} on chain ${IDENTITY.chainId}`);
  console.log(`  HCS topic    ${topic}`);
  console.log(`               ${hashscanTopicUrl(topic)}`);
  console.log(`\n  free   GET  /  ·  GET /health  ·  GET /audit`);
  console.log(`  paid   POST ${PAID_PATH}  { "address": "0x…", "tier": "summary"|"full" }\n`);
});
