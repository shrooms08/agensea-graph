/**
 * LAST JOB strip data — SERVER ONLY, read at ISR time, eth_call only.
 *
 * Candidates are ALL COMPLETED jobs on chain 97 for our four agents: we walk
 * down from the commerce job counter and take the highest-id COMPLETED job
 * whose provider is the agents' wallet. What renders depends on what can be
 * PROVEN for that job:
 *
 *  - Config jobs (data/first-party-agents.ts) carry measured analysisMs and
 *    a recorded settleTx — full row, gated on the on-chain deliverable hash
 *    equalling the config hash.
 *  - Demo hires have neither measurement; they render as "demo hire" with
 *    only chain-proven fields. The hash check recomputes keccak256 of the
 *    manifest persisted by the hire route (demo_deliverables, backfilled
 *    from the submit events for jobs before persistence existed) against
 *    the on-chain job.deliverable — made now, not remembered.
 *
 * A candidate that cannot be verified is SKIPPED (never half-rendered) and
 * the walk continues to the next lower COMPLETED job. Any failure, or an
 * empty walk, returns null and the strip renders "last job: unavailable" —
 * never stale, never invented.
 */
import 'server-only';
import { BNB_TESTNET, getErc8183Job } from '@altananetwork/sdk';
import { manifestHash, type DeliverableManifest } from '../../../agents/src/erc8183/manifest.ts';
import { FIRST_PARTY_AGENTS, ERC8183, byId } from '@/data/first-party-agents';
import { sbSelect } from '@/lib/supabase';

const PROVIDER = '0x85d32d525E1812FeE7001f34DD6dd86154619090'.toLowerCase();
const JOB_COUNTER_SELECTOR = '0x50355d76'; // same read the hire route uses for the next id
const MAX_WALK = 25;    // candidates to examine below the counter
const DEADLINE_MS = 15000;

export interface LastJob {
  jobId: string;
  agentId: number;
  agentName: string;
  demo: boolean;
  analysisMs?: number;  // config jobs only — never invented for demo hires
  settleTx?: string;    // config jobs only
  measuredAt: string;   // ISO, time of the chain read
}

/** Six hours: the strip is a footer, and the keepalive revalidates on that
 *  cadence anyway. Kept in one place so the RPC read and the row read agree. */
const FOOTER_REVALIDATE = 21_600;

async function latestJobId(): Promise<number> {
  // NOT no-store. This runs in SiteFooter, which the ROOT LAYOUT renders, so an
  // uncached fetch here opted EVERY route out of static rendering — twelve
  // revalidate declarations were inert and every page paid a server render. The
  // default ('auto no cache') participates in the prerender instead: the value
  // is read when a route is built or revalidated, not per request. The strip is
  // a footer; six-hour staleness is invisible, and the keepalive revalidates.
  const r = await fetch(BNB_TESTNET.publicRpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    next: { revalidate: FOOTER_REVALIDATE },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: ERC8183.commerce, data: JOB_COUNTER_SELECTOR }, 'latest'] }),
  });
  return Number(BigInt(((await r.json()) as { result: string }).result));
}

type ConfigJobs = Map<number, { agent: (typeof FIRST_PARTY_AGENTS)[number]; job: (typeof FIRST_PARTY_AGENTS)[number]['jobs'][number] }>;

const configJobIndex = (): ConfigJobs =>
  new Map(FIRST_PARTY_AGENTS.flatMap((a) => a.jobs.map((j) => [Number(j.jobId), { agent: a, job: j }] as const)));

/**
 * Verify ONE job id and render it, or return null if it does not qualify.
 *
 * Lifted verbatim out of the old walk body so both the direct lookup and the
 * fallback walk run identical checks — provider match, COMPLETED status, and
 * the same hash comparison against either the config deliverableHash or the
 * recomputed manifest hash. Nothing here is new; only the caller changed.
 */
async function verifyJob(id: number, configJobs: ConfigJobs): Promise<LastJob | null> {
  const chainJob = await getErc8183Job(BNB_TESTNET, BigInt(id));
  if (String((chainJob as { provider?: string }).provider ?? '').toLowerCase() !== PROVIDER) return null;
  if (chainJob.statusName !== 'COMPLETED') return null;

  const cfg = configJobs.get(id);
  if (cfg) {
    if (chainJob.deliverable.toLowerCase() !== cfg.job.deliverableHash.toLowerCase()) return null;
    if (!cfg.job.settleTx) return null; // not fully documented — not renderable with full fields
    return { jobId: String(id), agentId: cfg.agent.agentId, agentName: cfg.agent.name, demo: false,
             analysisMs: cfg.job.analysisMs, settleTx: cfg.job.settleTx, measuredAt: new Date().toISOString() };
  }

  // Demo hire: verify against the persisted manifest, or skip.
  const { rows } = await sbSelect<{ agent_id: number; manifest: DeliverableManifest }>(
    'demo_deliverables', { query: `select=agent_id,manifest&job_id=eq.${id}`, range: [0, 0], revalidate: FOOTER_REVALIDATE });
  const row = rows[0];
  if (!row) return null;
  if (manifestHash(row.manifest).toLowerCase() !== chainJob.deliverable.toLowerCase()) return null;
  const agent = byId(row.agent_id);
  if (!agent) return null;
  return { jobId: String(id), agentId: agent.agentId, agentName: agent.name, demo: true,
           measuredAt: new Date().toISOString() };
}

/**
 * Ask Supabase which of OUR jobs is newest, then verify exactly that one.
 *
 * This replaced a blind walk down from the on-chain job counter. The walk was
 * correct when written and then silently stopped finding anything: it examined
 * MAX_WALK=25 ids below the counter, and other people's jobs pushed the
 * counter ~70 ids past our newest recorded hire, so the window no longer
 * contained a single job of ours and the strip read "unavailable" for weeks.
 *
 * A lookup keyed on our own records cannot drift that way — it asks "what is
 * the newest job we recorded?" instead of "is one of ours near the top?".
 * It is also one indexed query plus one eth_call rather than up to 25
 * sequential eth_calls against a 15s deadline.
 *
 * A few rows rather than strictly one, because a row that fails verification
 * must be skipped exactly as the walk skipped it — otherwise one unverifiable
 * hire would blank the strip while older good ones sit right behind it.
 */
const DIRECT_CANDIDATES = 5;

async function directLookup(configJobs: ConfigJobs): Promise<LastJob | null> {
  const { rows } = await sbSelect<{ job_id: number }>('demo_deliverables', {
    query: 'select=job_id&order=job_id.desc',
    range: [0, DIRECT_CANDIDATES - 1],
    revalidate: FOOTER_REVALIDATE,
  });
  if (rows.length === 0) return null;

  // Config jobs are ours too, and one could outrank the newest demo hire.
  // Merge both sources and take them strictly newest-first.
  const candidates = [...new Set([...rows.map((r) => Number(r.job_id)), ...configJobs.keys()])]
    .filter((id) => Number.isInteger(id) && id > 0)
    .sort((a, b) => b - a)
    .slice(0, DIRECT_CANDIDATES);

  for (const id of candidates) {
    const hit = await verifyJob(id, configJobs);
    if (hit) return hit;
  }
  return null;
}

/**
 * Fallback only: the original walk down from the counter.
 *
 * Kept for the case where Supabase returns nothing at all — an outage, or a
 * fresh environment with no recorded hires — where a job of ours near the top
 * of the counter is still the best available answer.
 */
async function scan(configJobs: ConfigJobs): Promise<LastJob | null> {
  const latest = await latestJobId();
  for (let id = latest; id > latest - MAX_WALK && id > 0; id--) {
    const hit = await verifyJob(id, configJobs);
    if (hit) return hit;
  }
  return null;
}

export async function readLastJob(): Promise<LastJob | null> {
  try {
    const configJobs = configJobIndex();
    return (await Promise.race([
      directLookup(configJobs).then((hit) => hit ?? scan(configJobs)),
      new Promise<null>((_, rej) => setTimeout(() => rej(new Error('last-job deadline')), DEADLINE_MS)),
    ])) as LastJob | null;
  } catch {
    return null;
  }
}
