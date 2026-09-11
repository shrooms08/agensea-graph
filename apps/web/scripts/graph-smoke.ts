/**
 * Smoke test for lib/graph — proves the Agent0 data layer returns real data
 * from the live gateway, not that it compiles.
 *
 * Run: npm run graph:smoke   (from apps/web)
 *
 * The `--conditions=react-server` in that script is load-bearing. lib/graph
 * imports `server-only`, whose default export throws by design; the
 * react-server condition resolves it to the empty module instead, which is
 * exactly what Next does when it builds a server component.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAINS, DEFAULT_CHAIN_ID, getChainById, subgraphIdFor } from '../lib/graph/chains.ts';
import { graphQuery } from '../lib/graph/client.ts';
import {
  getAgentTrustProfile,
  getAllChainsAdoption,
  listAgents,
} from '../lib/graph/queries.ts';

/**
 * dotenv is not a dependency of this workspace, so use Node's own loader.
 * .env.local lives at the REPO ROOT, two levels up from apps/web — resolved
 * from this file rather than cwd so the script works from anywhere.
 */
function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '../../../.env.local'), // repo root
    resolve(here, '../.env.local'), // apps/web, if one is ever added
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      process.loadEnvFile(path);
      console.log(`env: loaded ${path}`);
      return;
    }
  }
  console.warn(`env: no .env.local found (looked in ${candidates.join(', ')})`);
}

const rule = (label: string) => console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}`);
const num = (n: number) => n.toLocaleString('en-US');

async function main(): Promise<void> {
  loadEnv();

  /* ---------------------------------------------------------------- 1 */
  rule('1. Per-chain adoption rollup (all five chains, Promise.allSettled)');

  const adoption = await getAllChainsAdoption();
  for (const row of adoption) {
    if (!row.ok) {
      console.log(`\n  ${row.chainName} (${row.chainId})  ✗ FAILED`);
      console.log(`    ${row.error}`);
      continue;
    }
    console.log(`\n  ${row.chainName} (${row.chainId})  ✓ block ${num(row.blockNumber)}`);
    console.log(`    agents                 ${num(row.totalAgents)}`);
    console.log(`    highest agentId        ${num(row.highestAgentId)}`);
    console.log(
      `    agents with feedback   ${num(row.agentsWithFeedback)}` +
        (row.agentsWithFeedbackExact ? '' : '  (page cap hit — lower bound)'),
    );
    console.log(`    feedback created       ${num(row.totalFeedbackCreated)}`);
    console.log(`    feedback revoked       ${num(row.totalFeedbackRevoked)}`);
    console.log(
      `    feedback value sum     ` +
        // Above 2^53 the Number form is fiction; show what the subgraph said.
        (row.feedbackValueSum > Number.MAX_SAFE_INTEGER
          ? `${row.feedbackValueSumRaw}  (raw — exceeds 2^53)`
          : num(row.feedbackValueSum)),
    );
    console.log(
      `    validations            ` +
        (row.hasValidationRegistry
          ? `${num(row.totalValidationRequests)} req / ${num(row.totalValidationResponses)} resp`
          : 'no validation registry deployed'),
    );
    console.log(`    identityRegistry       ${row.protocol?.identityRegistry ?? '—'}`);
  }

  const failures = adoption.filter((r) => !r.ok).length;
  console.log(`\n  ${adoption.length - failures}/${adoption.length} chains answered.`);

  /* ---------------------------------------------------------------- 2 */
  const bsc = getChainById(DEFAULT_CHAIN_ID);
  if (!bsc) throw new Error(`Default chain ${DEFAULT_CHAIN_ID} is missing from CHAINS`);

  rule(`2. listAgents — first 5 on ${bsc.name}, by totalFeedback desc`);

  const agents = await listAgents({ chainId: bsc.chainId, first: 5 });
  for (const a of agents) {
    const name = a.registrationFile?.name ?? '(no registration file)';
    console.log(
      `  ${a.id.padEnd(12)} ${String(a.totalFeedback).padStart(5)} feedback  ${name}`,
    );
  }

  /* ---------------------------------------------------------------- 3 */
  rule('3. getAgentTrustProfile — first BSC agent with at least one feedback');

  // Feedback has no `timestamp` field; `createdAt` (seconds) is the ordering
  // key. Newest first, then take that entry's agent.
  const latest = await graphQuery<{ feedbacks: { id: string; agent: { id: string } }[] }>(
    subgraphIdFor(bsc.chainId),
    `{ feedbacks(first: 1, orderBy: createdAt, orderDirection: desc) { id agent { id } } }`,
  );
  const target = latest.feedbacks[0]?.agent.id;
  if (!target) throw new Error('No feedback entries found on BSC — cannot pick a target agent.');

  console.log(`  most recent feedback: ${latest.feedbacks[0].id}`);
  // Passed as the COMPOSITE id here; toCompositeId accepts the bare form too.
  console.log(`  resolving trust profile for ${target}\n`);

  const profile = await getAgentTrustProfile({ chainId: bsc.chainId, agentId: target });
  console.log(JSON.stringify(profile, null, 2));

  /* ---------------------------------------------------------------- 4 */
  rule('Summary');
  console.log(`  chains configured   ${CHAINS.length}`);
  console.log(`  chains answering    ${adoption.length - failures}`);
  console.log(`  agents listed       ${agents.length}`);
  console.log(`  profile feedback    ${profile.feedback.length}`);
  console.log(`  profile validations ${profile.validations.length}`);
  console.log(
    `  profile stats       ${profile.feedbackStats ? 'present' : 'none'} (feedback) / ` +
      `${profile.validationStats ? 'present' : 'none'} (validation)`,
  );

  if (failures > 0) {
    console.log(
      `\n  NOTE: ${failures} chain(s) failed. That is reported, not thrown — ` +
        `getAllChainsAdoption is designed to degrade per-chain.`,
    );
  }
}

main().catch((err) => {
  console.error('\ngraph-smoke FAILED\n');
  console.error(err);
  process.exit(1);
});
