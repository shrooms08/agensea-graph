/**
 * /scout — ask a question in English, get a trust verdict backed by live
 * Agent0 subgraph data and the queries that produced it.
 *
 * The page itself is a server component and stays static: everything dynamic
 * lives in <Scout />, which streams from /api/scout. The adoption strip is
 * read at build/revalidate time from the same hourly cache the API and the
 * Scout tool share, so the three can never disagree.
 */
import type { Metadata } from 'next';

import { Scout } from '@/components/Scout';
import { cachedAdoptionSnapshot } from '@/lib/graph/adoption-cache';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Scout',
  description:
    'A natural-language trust analyst over live ERC-8004 registry data, indexed by The Graph. '
    + 'Every claim is backed by the subgraph query that produced it.',
};

const int = (n: number) => n.toLocaleString('en-US');

export default async function ScoutPage() {
  const { fetchedAt, chains } = await cachedAdoptionSnapshot();
  const live = chains.filter((c) => c.ok);

  // The model id deliberately is NOT printed here. This page is statically
  // rendered, so it would be frozen at build time — and LLM_MODEL exists
  // precisely so the model can be switched at runtime when one exhausts its
  // daily quota. Caught in review: a build made before LLM_MODEL was set
  // advertised gemini-3.8-flash while the server was answering on 3.6. The
  // answer now reports its own model, streamed per request.

  return (
    <>
      <section className="sec-lead">
        <div className="label">Trust analyst · The Graph</div>
        <h1 style={{ fontSize: 38, marginTop: 14 }}>Scout</h1>
        <p className="prose prose-muted" style={{ marginTop: 16 }}>
          Ask whether an agent can be trusted. Scout reads the Agent0 subgraphs live, computes the
          trust signals itself — reviewer concentration, burst patterns, per-tag score ranges — and
          shows you every query it ran. It cites a tool for each claim, and says
          &ldquo;insufficient data&rdquo; rather than guessing.
        </p>

        <Scout />
      </section>

      <section className="sec sec-rule">
        <div className="label">Registry coverage · cached hourly</div>
        <div className="grid-panel cols-4" style={{ marginTop: 16 }}>
          {live.map((c) => (
            <div className="card" key={c.chainId}>
              <div className="label" style={{ fontSize: 9 }}>
                {c.chainName}
              </div>
              <div
                className="data tnum stat-value"
                style={{ marginTop: 8, fontSize: 14, fontWeight: 500 }}
              >
                {int(c.totalAgents)} agents
              </div>
              <div className="meta" style={{ marginTop: 6 }}>
                {int(c.agentsWithFeedback)}
                {c.agentsWithFeedbackExact ? '' : '+'} reviewed
                {c.totalAgents > 0
                  ? ` · ${((c.agentsWithFeedback / c.totalAgents) * 100).toFixed(1)}%`
                  : ''}
              </div>
            </div>
          ))}
        </div>

        <div className="meta" style={{ marginTop: 14 }}>
          measured {new Date(fetchedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC ·{' '}
          {live.length}/{chains.length} chains answering
          {chains.length - live.length > 0
            ? ` · ${chains
                .filter((c) => !c.ok)
                .map((c) => c.chainName)
                .join(', ')} unavailable`
            : ''}
        </div>

        <p className="prose-sm prose-muted" style={{ marginTop: 18 }}>
          No validation registry is deployed on any live chain yet, so no agent anywhere can hold a
          validation. Scout treats that as a fact about the chain, not a mark against an agent.
        </p>
      </section>
    </>
  );
}
