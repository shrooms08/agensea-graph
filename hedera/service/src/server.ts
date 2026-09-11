/**
 * x402-gated Venus health service on Hedera testnet.
 *
 *   GET  /health            free   — liveness + the price and payee a buyer will be quoted
 *   POST /api/venus-health  paid   — PRICE_HBAR in HBAR, settled via the Blocky402 facilitator
 *
 * The paid route is guarded by @x402/express. An unpaid request gets a 402 whose body
 * carries the full PaymentRequired document (scheme, network, asset, amount, payTo);
 * we additionally attach a human-readable `quote` so the 402 reads on its own in a demo.
 */
import express, { type Request, type Response } from 'express';
import { paymentMiddleware } from '@x402/express';
import { CONFIG } from './config.js';
import { createResourceServer } from './x402.js';
import { getVenusHealth, isBscAddress } from './venus-health.js';

// The vendored Venus reader looks up its RPC in ALCHEMY_BSC and otherwise uses a
// public fallback. Let hedera/.env override it with a plain BSC_RPC_URL.
if (process.env.BSC_RPC_URL && !process.env.ALCHEMY_BSC) {
  process.env.ALCHEMY_BSC = process.env.BSC_RPC_URL;
}

const PAID_ROUTE = 'POST /api/venus-health';

/** Explicit AssetAmount: 0.0.0 is HBAR, amount is in tinybars. */
const HBAR_PRICE = { asset: '0.0.0', amount: CONFIG.priceTinybars };

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    network: CONFIG.caip2,
    priceHbar: CONFIG.priceHbar,
    payTo: CONFIG.serviceAccountId,
  });
});

// x402 v2 carries the PaymentRequired document in the base64 PAYMENT-REQUIRED header
// and leaves the 402 body empty. A header is not readable in a demo, so mirror the
// decoded document into the body alongside a plain-language quote. Clients still read
// the header, which takes precedence, so this is additive.
app.use((req: Request, res: Response, next) => {
  if (`${req.method} ${req.path}` !== PAID_ROUTE) return next();
  const json = res.json.bind(res);
  res.json = (body: unknown) => {
    if (res.statusCode !== 402) return json(body);

    const enriched: Record<string, unknown> = {
      ...(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}),
      error: 'Payment Required',
      quote: {
        price: `${CONFIG.priceHbar} HBAR`,
        amountTinybars: CONFIG.priceTinybars,
        asset: 'HBAR (native, asset id 0.0.0)',
        network: CONFIG.caip2,
        payTo: CONFIG.serviceAccountId,
        facilitator: CONFIG.facilitatorUrl,
        scheme: 'exact',
      },
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
            price: HBAR_PRICE,
            network: CONFIG.caip2,
            payTo: CONFIG.serviceAccountId,
          },
        ],
        description: `Venus Protocol health-factor read for one BSC address — ${CONFIG.priceHbar} HBAR`,
        mimeType: 'application/json',
      },
    },
    createResourceServer(),
  ),
);

app.post('/api/venus-health', async (req: Request, res: Response) => {
  const address = (req.body as { address?: unknown } | undefined)?.address;
  if (!isBscAddress(address)) {
    res.status(400).json({ error: 'body must be { "address": "0x<40 hex>" }' });
    return;
  }
  try {
    res.json(await getVenusHealth(address));
  } catch (err) {
    console.error('[venus-health] unexpected failure:', err);
    res.status(500).json({ error: 'venus read failed' });
  }
});

app.listen(CONFIG.port, () => {
  console.log(`\n  AgenSea x402 Venus health service`);
  console.log(`  http://localhost:${CONFIG.port}`);
  console.log(`  network      ${CONFIG.caip2}`);
  console.log(`  price        ${CONFIG.priceHbar} HBAR (${CONFIG.priceTinybars} tinybars)`);
  console.log(`  payTo        ${CONFIG.serviceAccountId}`);
  console.log(`  facilitator  ${CONFIG.facilitatorUrl}`);
  console.log(`\n  free   GET  /health`);
  console.log(`  paid   POST /api/venus-health  { "address": "0x…" }\n`);
});
