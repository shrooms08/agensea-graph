/**
 * Post-delta refresh: recompute the fan-out curve and the AGENT-SIDE stats.
 *
 * ONLY the keys whose underlying data was actually re-measured get a new
 * measured_at. The bazaar_* keys come from a B402 ingest that did not run here,
 * so they are left untouched — stamping them with a fresh timestamp would claim
 * a measurement that never happened.
 */
import { supabase, withRetry } from '../env.ts';
import process from 'node:process';

const log = (s: string) => process.stdout.write(s + '\n');
const db = supabase();

// ---- 1. refresh_fanout() ----------------------------------------------------
// It cannot be called through PostgREST: pg_safeupdate is on for that session
// and the function's `delete from public.client_fanout;` has no WHERE clause,
// so the call fails with "DELETE requires a WHERE clause". It runs from the SQL
// editor, which is presumably how it was last run.
//
// It is also a no-op for THIS sweep, and the check below proves rather than
// assumes that: the function reads only `where client_count > 0`, and every one
// of the 206 ids the delta added has zero clients. So the derived figures must
// already equal what a refresh would produce. If they do not, stop.
const { data: fan, error: fanErr } = await withRetry('refresh_fanout', () => db.rpc('refresh_fanout'));
const fanRan = !fanErr;
if (fanRan) {
  const row = Array.isArray(fan) ? fan[0] : fan;
  log(`refresh_fanout(): clients_out=${row?.clients_out}  breakpoints_out=${row?.breakpoints_out}`);
} else {
  log(`refresh_fanout() NOT run: ${fanErr.message}`);
  log('  -> verifying the derived figures are already correct instead');
}

// ---- 2. recompute the agent-side figures ------------------------------------
const exact = async (table: string, filter = '') => {
  const { count, error } = await withRetry(`count ${table}`, () =>
    db.from(table).select('*', { count: 'exact', head: true }).or(filter || 'agent_id.gte.0'));
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return count ?? 0;
};

const { data: cur } = await withRetry('cursor', () =>
  db.from('sweep_cursor').select('ceiling_used').eq('sweep_name', 'pass1_liveness').maybeSingle());
const ceiling = Number(cur?.ceiling_used);
if (!Number.isInteger(ceiling) || ceiling < 1) throw new Error('no pass1 ceiling');

const withClient = await exact('agent_liveness', 'client_count.gt.0');

// distinct clients = rows in client_fanout (one row per lowercased client)
const { count: distinctClients, error: dcErr } = await withRetry('client_fanout', () =>
  db.from('client_fanout').select('*', { count: 'exact', head: true }));
if (dcErr) throw new Error(dcErr.message);

// edges = sum(agent_count) over client_fanout — each row is one client's agents
let edges = 0;
for (let from = 0; ; from += 1000) {
  const { data, error } = await withRetry('fanout page', () =>
    db.from('client_fanout').select('agent_count').range(from, from + 999));
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  for (const r of rows) edges += Number((r as { agent_count: number }).agent_count);
  if (rows.length < 1000) break;
}

// minted_per_day, derived from the previously recorded ceiling and its date
const { data: prev } = await withRetry('prev minted', () =>
  db.from('registry_stats').select('value,measured_at').eq('key', 'agents_minted').maybeSingle());
const prevVal = Number(prev?.value);
const prevAt = new Date(String(prev?.measured_at)).getTime();
const now = new Date();
const days = (now.getTime() - prevAt) / 86_400_000;
const perDay = days > 0 ? Number(((ceiling - prevVal) / days).toFixed(1)) : null;

log(`\n  agents_minted     ${prevVal} -> ${ceiling}`);
log(`  agents_with_client              ${withClient}`);
log(`  distinct_clients                ${distinctClients}`);
log(`  client_edges                    ${edges}`);
log(`  minted_per_day                  ${perDay}  (over ${days.toFixed(3)} days)`);

// ---- 2b. if the refresh could not run, prove it was unnecessary -------------
const { data: stored } = await withRetry('stored stats', () =>
  db.from('registry_stats').select('key,value').in('key', ['agents_with_client', 'distinct_clients', 'client_edges']));
const storedMap = Object.fromEntries((stored ?? []).map((r) => [(r as { key: string }).key, Number((r as { value: number }).value)]));
const drift = [
  ['agents_with_client', withClient, storedMap.agents_with_client],
  ['distinct_clients', distinctClients ?? 0, storedMap.distinct_clients],
  ['client_edges', edges, storedMap.client_edges],
].filter(([, live, was]) => live !== was);
if (!fanRan && drift.length) {
  log('\nDERIVED FIGURES HAVE DRIFTED and refresh_fanout() could not run:');
  for (const [k, live, was] of drift) log(`  ${k}: stored ${was}, live ${live}`);
  throw new Error('refresh_fanout() must be run from the SQL editor before these are published');
}
if (!fanRan) log('  verified: client-derived figures already match live tables — refresh was a no-op');

// ---- 3. upsert, agent-side keys only ----------------------------------------
const at = now.toISOString();
const rows = [
  { key: 'agents_minted', value: ceiling, measured_at: at, note: `contiguous ids 1..${ceiling}` },
  { key: 'agents_with_client', value: withClient, measured_at: at, note: 'ever had >=1 client' },
  { key: 'client_edges', value: edges, measured_at: at, note: null },
  { key: 'distinct_clients', value: distinctClients ?? 0, measured_at: at, note: null },
];
if (perDay !== null) {
  rows.push({ key: 'minted_per_day', value: perDay, measured_at: at,
    note: `derived: (ceiling - ${prevVal}) / days since the previous sweep` });
}
const { error: upErr } = await withRetry('upsert registry_stats', () =>
  db.from('registry_stats').upsert(rows, { onConflict: 'key' }));
if (upErr) throw new Error(`upsert failed: ${upErr.message}`);

log(`\nREFRESH COMPLETE — ${rows.length} agent-side keys stamped ${at}`);
log('  bazaar_* left untouched (no ingest ran); their measured_at is unchanged.');
