/**
 * /adoption — ERC-8004 adoption across the five Agent0 chains.
 *
 * Reads `cachedAdoptionSnapshot()` DIRECTLY, not /api/graph/adoption over
 * HTTP. Fetching our own API would need an absolute origin (so `headers()`,
 * so the page goes dynamic), add a network hop to reach data already in this
 * process, and give the page its own cache entry that could disagree with the
 * API's. Calling the lib function puts the page on the same hourly
 * unstable_cache entry the API route and Scout's tool already share, so all
 * three are incapable of showing different numbers.
 *
 * Static with a 1h revalidate — confirmed in the build route table.
 */
import type { Metadata } from 'next';
import Link from 'next/link';

import { cachedAdoptionSnapshot } from '@/lib/graph/adoption-cache';
import type { ChainAdoptionResult } from '@/lib/graph/types';

export const revalidate = 3600;

export const metadata: Metadata = {
  title: 'Adoption',
  description:
    'ERC-8004 adoption across BNB Chain, Ethereum, Base, Polygon and Monad — registered agents '
    + 'versus agents that have ever received feedback, live from The Graph.',
};

const int = (n: number) => n.toLocaleString('en-US');
const pct = (rate: number) => `${(rate * 100).toFixed(1)}%`;

/** Share of a chain's agents that have ever been reviewed. */
function adoptionRate(c: Extract<ChainAdoptionResult, { ok: true }>): number {
  return c.totalAgents > 0 ? c.agentsWithFeedback / c.totalAgents : 0;
}

export default async function AdoptionPage() {
  const { fetchedAt, chains } = await cachedAdoptionSnapshot();

  const live = chains.filter((c): c is Extract<ChainAdoptionResult, { ok: true }> => c.ok);
  const failed = chains.filter((c) => !c.ok);

  // Sorted by adoption rate descending; unreachable chains land at the bottom
  // in their own group rather than being sorted as if they were zero.
  const ranked = [...live].sort((a, b) => adoptionRate(b) - adoptionRate(a));
  const topRate = ranked.length ? adoptionRate(ranked[0]) : 0;

  const bsc = live.find((c) => c.chainId === 56);

  return (
    <>
      <section className="sec-lead">
        <div className="label">The Graph · Agent0 subgraphs</div>
        <h1 style={{ fontSize: 38, marginTop: 14 }}>ERC-8004 adoption across chains</h1>
        <p className="prose prose-muted" style={{ marginTop: 16 }}>
          Live from The Graph&rsquo;s Agent0 subgraphs. Registered agents vs agents that have ever
          received feedback.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Headline: BSC, the chain the rest of AgenSea measures directly.   */}
      {/* ---------------------------------------------------------------- */}
      {bsc ? (
        <section className="sec sec-rule">
          <div className="label">{bsc.chainName} · headline</div>
          <div className="grid-panel cols-3" style={{ marginTop: 16 }}>
            <div className="card">
              <div className="label" style={{ fontSize: 9 }}>Registered agents</div>
              <div className="num stat-value tnum" style={{ marginTop: 10 }}>{int(bsc.totalAgents)}</div>
            </div>
            <div className="card">
              <div className="label" style={{ fontSize: 9 }}>Agents with feedback</div>
              <div className="num stat-value tnum" style={{ marginTop: 10 }}>
                {int(bsc.agentsWithFeedback)}
                {bsc.agentsWithFeedbackExact ? '' : '+'}
              </div>
            </div>
            <div className="card">
              <div className="label" style={{ fontSize: 9 }}>Adoption rate</div>
              <div className="num stat-value tnum" style={{ marginTop: 10, color: 'var(--live)' }}>
                {pct(adoptionRate(bsc))}
              </div>
            </div>
          </div>

          {/*
            The point of this caption. AgenSea's own full on-chain sweep of the
            BSC registry put this at 1.35%, arrived at independently of The
            Graph. Two methods agreeing is the claim worth making — a single
            number from a single source is just a number.
          */}
          <div className="adopt-note">
            Independently measured by AgenSea&rsquo;s own on-chain sweep at 1.35%
          </div>
        </section>
      ) : null}

      {/* ---------------------------------------------------------------- */}
      {/* The chart. Plain divs; the bar is the existing .bar-* pattern.     */}
      {/* ---------------------------------------------------------------- */}
      <section className="sec sec-rule">
        <div className="label">Adoption rate by chain</div>

        <div className="adopt-chart">
          {ranked.map((c) => {
            const rate = adoptionRate(c);
            const isTop = rate === topRate;
            return (
              <div className="adopt-row" key={c.chainId} data-top={isTop}>
                <div className="adopt-row-head">
                  <span className="adopt-name">{c.chainName}</span>
                  <span className="adopt-rate tnum">{pct(rate)}</span>
                  <span className="adopt-counts tnum">
                    {int(c.agentsWithFeedback)}
                    {c.agentsWithFeedbackExact ? '' : '+'} / {int(c.totalAgents)}
                  </span>
                </div>
                {/*
                  Bars are scaled against the LARGEST rate, not against 100%.
                  At a 1.3% true rate a full-scale bar is two pixels, which
                  compares nothing; the percentage beside it carries the
                  absolute value.
                */}
                <div
                  className="adopt-track"
                  role="img"
                  aria-label={`${c.chainName}: ${pct(rate)} of registered agents have feedback`}
                >
                  <div
                    className="adopt-fill"
                    style={{ width: topRate > 0 ? `${(rate / topRate) * 100}%` : '0%' }}
                  />
                </div>
                {/* After the bar in DOM order so a narrow screen reads
                    label → bar → action; grid puts it top-right on desktop. */}
                <Link className="adopt-scout" href={`/scout?chain=${c.chainId}`}>
                  Scout this chain →
                </Link>
              </div>
            );
          })}

          {failed.map((c) => (
            <div className="adopt-row" key={c.chainId} data-failed="true">
              <div className="adopt-row-head">
                <span className="adopt-name">{c.chainName}</span>
                {/*
                  No bar, and no 0%. A zero-length bar would read as "no agents
                  have feedback here", which is a measurement we do not have —
                  the subgraph simply did not answer.
                */}
                <span className="adopt-unavailable">indexer unavailable</span>
              </div>
            </div>
          ))}
        </div>

        <div className="adopt-note">
          Bars are scaled to the highest rate so the smaller chains stay legible; the percentage
          beside each is the absolute figure.
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* The numbers behind the chart.                                     */}
      {/* ---------------------------------------------------------------- */}
      <section className="sec sec-rule">
        <div className="label">Per-chain detail</div>
        <div className="cmp-hint meta" style={{ marginTop: 10 }}>
          scroll the table sideways to see every column →
        </div>

        <div className="cmp-scroll" style={{ marginTop: 14 }}>
          <table className="cmp-table adopt-table">
            <thead>
              <tr>
                <th scope="col">Chain</th>
                <th scope="col">Registered agents</th>
                <th scope="col">Agents with feedback</th>
                <th scope="col">Adoption rate</th>
                <th scope="col">Feedback created</th>
                <th scope="col">Last indexed block</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((c) => (
                <tr key={c.chainId}>
                  <td>{c.chainName}</td>
                  <td className="tnum">{int(c.totalAgents)}</td>
                  <td className="tnum">
                    {int(c.agentsWithFeedback)}
                    {c.agentsWithFeedbackExact ? '' : '+'}
                  </td>
                  <td className="tnum">{pct(adoptionRate(c))}</td>
                  <td className="tnum">{int(c.totalFeedbackCreated)}</td>
                  <td className="tnum">{int(c.blockNumber)}</td>
                </tr>
              ))}
              {failed.map((c) => (
                <tr key={c.chainId} data-failed="true">
                  <td>{c.chainName}</td>
                  <td colSpan={5}>indexer unavailable</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="adopt-foot">
          Data: Agent0 subgraphs on The Graph Network, cached hourly. Fetched at{' '}
          {new Date(fetchedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC.
        </div>
      </section>
    </>
  );
}
