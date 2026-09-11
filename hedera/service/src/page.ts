/**
 * The landing page. Plain HTML and inline CSS — no build step, no framework, no CDN.
 * It exists so a judge can open the port and understand what is being sold, at what
 * price, by which agent, and how to trigger the 402 themselves.
 */
import { IDENTITY } from './identity.js';
import { TIER_DESCRIPTION, TIER_PRICE_HBAR } from './tiers.js';

export type LandingPageData = {
  network: string;
  payTo: string;
  facilitator: string;
  port: number;
  topicId: string | null;
  hashscanTopicUrl: string | null;
};

const esc = (v: unknown) =>
  String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function renderLandingPage(d: LandingPageData): string {
  const curl = `curl -s -X POST http://localhost:${d.port}/api/venus-health \\
  -H 'content-type: application/json' \\
  -d '{"address":"0x1e0395b9de1e5e4b2c52ef17b7d0c56901212c7f","tier":"full"}' | jq`;

  const topic = d.topicId
    ? `<a href="${esc(d.hashscanTopicUrl)}">${esc(d.topicId)}</a>`
    : '<span class="muted">not yet created</span>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgenSea x402 on Hedera</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;padding:48px 20px;background:#0b0d10;color:#d8dee6;
 font:15px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto}
h1{font-size:26px;margin:0 0 6px;color:#fff;letter-spacing:-.02em}
p.lede{margin:0 0 36px;color:#9aa4b2}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.09em;
 color:#7c8695;margin:36px 0 12px;font-weight:600}
table{width:100%;border-collapse:collapse;margin:0}
td{padding:9px 0;border-bottom:1px solid #1b2028;vertical-align:top}
td:first-child{color:#7c8695;width:170px;padding-right:16px}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
code{color:#8ed6c0;word-break:break-all}
pre{background:#11141a;border:1px solid #1b2028;border-radius:8px;
 padding:14px 16px;overflow-x:auto;color:#c3ccd8;margin:0}
a{color:#6db3f2;text-decoration:none}
a:hover{text-decoration:underline}
.tier{display:flex;justify-content:space-between;gap:16px;padding:11px 0;
 border-bottom:1px solid #1b2028}
.tier b{color:#fff;font-weight:600}
.tier span{color:#9aa4b2}
.price{color:#8ed6c0;white-space:nowrap;font-family:ui-monospace,monospace}
.muted{color:#5d6673}
footer{margin-top:40px;padding-top:18px;border-top:1px solid #1b2028;
 color:#5d6673;font-size:13px}
</style></head><body><main>

<h1>AgenSea x402 on Hedera</h1>
<p class="lede">One paid endpoint. A Venus Protocol health-factor read for any BNB Chain
address, sold per call over x402 and settled in HBAR on ${esc(d.network)}.</p>

<h2>Endpoint</h2>
<table>
<tr><td>paid</td><td><code>POST /api/venus-health</code> &mdash; <code>{ "address": "0x…", "tier": "summary"|"full" }</code></td></tr>
<tr><td>free</td><td><code>GET /health</code> &middot; <code>GET /audit</code></td></tr>
</table>

<h2>Tiers</h2>
${(Object.keys(TIER_PRICE_HBAR) as (keyof typeof TIER_PRICE_HBAR)[])
  .map(
    t => `<div class="tier"><span><b>${esc(t)}</b> &mdash; ${esc(TIER_DESCRIPTION[t])}</span>
<span class="price">${esc(TIER_PRICE_HBAR[t])} HBAR</span></div>`,
  )
  .join('\n')}

<h2>Payment</h2>
<table>
<tr><td>network</td><td><code>${esc(d.network)}</code></td></tr>
<tr><td>scheme</td><td><code>exact</code>, payment flow <code>upfront</code></td></tr>
<tr><td>payTo</td><td><code>${esc(d.payTo)}</code></td></tr>
<tr><td>facilitator</td><td><a href="${esc(d.facilitator)}/supported">${esc(d.facilitator)}</a></td></tr>
</table>

<h2>Agent identity (ERC-8004)</h2>
<table>
<tr><td>name</td><td>${esc(IDENTITY.name)}</td></tr>
<tr><td>agentId</td><td><code>${esc(IDENTITY.agentId)}</code> on chain ${esc(IDENTITY.chainId)}</td></tr>
<tr><td>registry</td><td><code>${esc(IDENTITY.registry)}</code></td></tr>
<tr><td>listing</td><td><a href="${esc(IDENTITY.listingUrl)}">${esc(IDENTITY.listingUrl)}</a></td></tr>
<tr><td>agentUri</td><td><span class="muted">data:application/json;base64 &mdash; resolve with <code>tokenURI(${esc(IDENTITY.agentId)})</code></span></td></tr>
</table>

<h2>Audit trail (HCS)</h2>
<table>
<tr><td>topic</td><td>${topic}</td></tr>
<tr><td>read it</td><td><a href="/audit"><code>GET /audit</code></a> &mdash; last 10 records via the public mirror node</td></tr>
</table>

<h2>Try the 402</h2>
<pre>${esc(curl)}</pre>

<footer>Every settled call writes one record to the HCS topic above: endpoint, tier,
payer, price, settlement transaction, and a SHA-256 of the result.</footer>
</main></body></html>`;
}
