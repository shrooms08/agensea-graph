'use client';
/**
 * Scout's client surface: ask a question, watch the answer stream, read the
 * verdict cards and the queries behind them.
 *
 * Every visual primitive here already existed — .card-lg, .docs-pre, the
 * .cat-switch-chip shape, the .preflight-short inset rule, the liveness
 * tokens. The only new thing is which token maps to which recommendation.
 */
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CHAINS, DEFAULT_CHAIN_ID, getChainById } from '@/lib/graph/chains';
import {
  projectLatestAnswer,
  type EvidencePart,
  type EvidenceQuery,
  type Recommendation,
  type Verdict,
  type ViewMessage,
} from '@/lib/scout/stream-view';

const EXAMPLES = [
  'Is 56:30867 safe to hire?',
  'Find me a live BSC agent that does yield monitoring with real feedback',
  'Compare adoption across chains',
] as const;

const REC_LABEL: Record<Recommendation, string> = {
  hire: 'Hire',
  caution: 'Caution',
  avoid: 'Avoid',
  insufficient_data: 'Insufficient data',
};

/**
 * Flags that describe the world rather than the agent render in the muted
 * tone. VALIDATION_UNAVAILABLE is true of every agent on every live chain
 * right now, so colouring it as a warning would put an amber chip on
 * absolutely everything and teach the reader to ignore all of them.
 */
const INFO_FLAGS = new Set(['VALIDATION_UNAVAILABLE']);

/** Minimal inline markdown: `code` and **bold**, which is all the model emits. */
function renderInline(text: string, keyBase: string) {
  const out: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={`${keyBase}-c${i}`}>{tok.slice(1, -1)}</code>);
    else out.push(<strong key={`${keyBase}-b${i}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Answer({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  return (
    <div className="prose scout-answer">
      {paragraphs.map((p, i) => (
        <p key={i}>{renderInline(p, `p${i}`)}</p>
      ))}
    </div>
  );
}

function VerdictCard({ v }: { v: Verdict }) {
  return (
    <article className="scout-verdict" data-rec={v.recommendation}>
      <div className="scout-verdict-head">
        <h3 className="scout-verdict-name">{v.name}</h3>
        <span className="scout-badge" data-rec={v.recommendation}>
          {REC_LABEL[v.recommendation] ?? v.recommendation}
        </span>
        <span className="scout-verdict-id">
          {v.agentId} · {v.confidence} confidence
        </span>
      </div>

      <div className="scout-rows">
        <div className="scout-row">
          <div className="scout-row-k">Liveness</div>
          <div className="scout-row-v">{v.liveness}</div>
        </div>
        <div className="scout-row">
          <div className="scout-row-k">Reputation</div>
          <div className="scout-row-v">{v.reputationSummary}</div>
        </div>
        <div className="scout-row">
          <div className="scout-row-k">Flags</div>
          <div className="scout-row-v">
            {v.flags.length === 0 ? (
              <span style={{ color: 'var(--text-faint)' }}>none</span>
            ) : (
              <div className="scout-flags">
                {v.flags.map((f) => (
                  <span key={f} className="scout-flag" data-tone={INFO_FLAGS.has(f) ? 'info' : 'warn'}>
                    {f}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="scout-row">
          <div className="scout-row-k">Reasoning</div>
          <div className="scout-row-v">{v.reasoning}</div>
        </div>
      </div>
    </article>
  );
}

function EvidencePanel({ parts }: { parts: EvidencePart[] }) {
  const queryCount = parts.reduce((n, p) => n + p.queries.length, 0);
  const rowCount = parts.reduce((n, p) => n + p.queries.reduce((m, q) => m + q.rowCount, 0), 0);
  const cachedOnly = parts.filter((p) => p.cached && p.queries.length === 0).length;

  return (
    <details className="scout-evidence">
      <summary className="scout-evidence-sum">
        Evidence — {queryCount} subgraph {queryCount === 1 ? 'query' : 'queries'},{' '}
        {rowCount.toLocaleString('en-US')} rows
        {cachedOnly > 0 ? ` · ${cachedOnly} from cache` : ''}
      </summary>

      {parts.map((p) =>
        p.queries.length === 0 ? (
          <div key={p.toolCallId} className="scout-ev-item">
            <div className="scout-ev-head">
              <span className="scout-ev-tool">{p.toolName}</span>
              <span>
                {p.cached
                  ? 'served from the hourly adoption cache — no query issued'
                  : 'no subgraph query'}
              </span>
            </div>
          </div>
        ) : (
          p.queries.map((q) => (
            <div key={`${p.toolCallId}-${q.seq}`} className="scout-ev-item">
              <div className="scout-ev-head">
                <span className="scout-ev-tool">{p.toolName}</span>
                <span>subgraph {q.subgraphId.slice(0, 10)}…</span>
                <span>{q.ms} ms</span>
                <span className={q.ok ? 'scout-ev-rows' : 'scout-ev-rows scout-ev-fail'}>
                  {q.ok ? `${q.rowCount.toLocaleString('en-US')} rows` : 'failed'}
                </span>
              </div>
              {q.error ? <div className="scout-ev-pre scout-ev-fail">{q.error}</div> : null}
              <pre className="scout-ev-pre">{q.query}</pre>
              <pre className="scout-ev-pre">{JSON.stringify(q.variables)}</pre>
            </div>
          ))
        ),
      )}
    </details>
  );
}

/**
 * Initial chain from `?chain=<chainId>`, which is how /adoption's per-chain
 * "Scout this chain" links arrive.
 *
 * Read CLIENT-side on purpose. Taking it from the page's `searchParams` would
 * turn /scout into a dynamic route — it is currently static with an hourly
 * revalidate, and a deep link is not worth giving that up. useSearchParams
 * needs a Suspense boundary on a static page; page.tsx provides one.
 *
 * An unknown or malformed chain falls back to the default rather than leaving
 * the selector on a chain that is not in the list.
 */
function useInitialChainId(): number {
  const params = useSearchParams();
  const raw = params?.get('chain');
  if (!raw) return DEFAULT_CHAIN_ID;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || !getChainById(parsed)) return DEFAULT_CHAIN_ID;
  return parsed;
}

export function Scout() {
  const [chainId, setChainId] = useState<number>(useInitialChainId());
  const [input, setInput] = useState('');

  const { messages, sendMessage, status, error, setMessages, stop } = useChat({
    transport: new DefaultChatTransport({ api: '/api/scout' }),
  });

  const busy = status === 'submitted' || status === 'streaming';

  /**
   * Latch that closes on submit and opens when the request settles.
   *
   * `status` is React state, so it is still 'ready' during the same tick as a
   * click. Two fast clicks (or a click landing while the first submit is still
   * being processed) both pass a `busy` check and both send. The ref flips
   * synchronously, which `busy` alone cannot.
   */
  const inFlight = useRef(false);
  useEffect(() => {
    if (!busy) inFlight.current = false;
  }, [busy]);

  // Abort a streaming request if the user navigates away mid-answer, so the
  // response is not left running against the model on nobody's behalf.
  useEffect(
    () => () => {
      // Braces matter: an arrow returning stop()'s Promise would make React
      // treat the Promise as the cleanup function.
      void stop();
    },
    [stop],
  );

  /** Single-answer view: the newest assistant message only, deduped. */
  const { answer, verdicts, evidence, model } = useMemo(
    () => projectLatestAnswer(messages as unknown as ViewMessage[]),
    [messages],
  );

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || busy || inFlight.current) return;
    inFlight.current = true;
    setInput(q);
    // Replace rather than append. Without this the previous answer's cards,
    // text and evidence stayed on screen beneath the new ones.
    setMessages([]);
    sendMessage({ text: q }, { body: { question: q, chainId } });
  };

  const asked = messages.some((m) => m.role === 'user');

  return (
    <>
      <form
        className="scout-ask"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <div className="scout-field">
          <input
            className="scout-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about an agent's trustworthiness…"
            aria-label="Question for Scout"
            readOnly={busy}
            aria-busy={busy}
          />
          <button className="scout-send" type="submit" disabled={busy || !input.trim()}>
            {busy ? 'Working…' : 'Ask Scout'}
          </button>
        </div>

        <div className="scout-chips" role="group" aria-label="Chain">
          <span className="label" style={{ marginRight: 2 }}>
            Chain
          </span>
          {CHAINS.map((c) => (
            <button
              key={c.chainId}
              type="button"
              className="scout-chip"
              data-active={c.chainId === chainId}
              aria-pressed={c.chainId === chainId}
              disabled={busy}
              onClick={() => setChainId(c.chainId)}
            >
              {c.slug}
            </button>
          ))}
        </div>

        <div className="scout-chips" role="group" aria-label="Example questions">
          <span className="label" style={{ marginRight: 2 }}>
            Try
          </span>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              className="scout-chip scout-example"
              disabled={busy}
              // Fills the input only. This used to call ask() directly, so a
              // user who clicked a chip and then pressed Ask Scout submitted
              // the same question twice — the double-card bug.
              onClick={() => setInput(ex)}
            >
              {ex}
            </button>
          ))}
        </div>
      </form>

      {busy ? (
        <div className="scout-status">
          <span className="scout-dot" aria-hidden="true" />
          {status === 'submitted' ? 'querying the subgraph' : 'reasoning over live data'}
        </div>
      ) : null}

      {error ? (
        <div className="scout-error" role="alert">
          {error.message || 'Scout failed.'}
        </div>
      ) : null}

      {answer ? <Answer text={answer} /> : null}

      {verdicts.length > 0 ? (
        <div className="scout-verdicts">
          {verdicts.map((v, i) => (
            <VerdictCard key={`${v.agentId}-${i}`} v={v} />
          ))}
        </div>
      ) : null}

      {evidence.length > 0 ? <EvidencePanel parts={evidence} /> : null}

      {model && !busy ? (
        <div className="meta" style={{ marginTop: 14 }}>
          answered by {model}
        </div>
      ) : null}

      {asked && !busy && !answer && !error && verdicts.length === 0 ? (
        <div className="scout-error" role="status">
          Scout returned nothing. That usually means the model hit its free-tier rate limit
          mid-answer — wait a minute and ask again.
        </div>
      ) : null}
    </>
  );
}
