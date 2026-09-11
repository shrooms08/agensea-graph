/**
 * Turns the assistant message parts of a Scout stream into what the page
 * renders. Pure, no React, no network — so the rules that decide how many
 * verdict cards appear can be unit-tested against a synthetic stream instead
 * of against a live model.
 *
 * This module holds no runtime imports (only `import type`), so Node's type
 * stripping loads the .ts directly in tests.
 */

export type Recommendation = 'hire' | 'caution' | 'avoid' | 'insufficient_data';

export interface Verdict {
  agentId: string;
  chainId: number;
  name: string;
  liveness: string;
  reputationSummary: string;
  flags: string[];
  recommendation: Recommendation;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

export interface EvidenceQuery {
  seq: number;
  subgraphId: string;
  query: string;
  variables: Record<string, unknown>;
  rowCount: number;
  ms: number;
  ok: boolean;
  error?: string;
}

export interface EvidencePart {
  toolCallId: string;
  toolName: string;
  cached: boolean;
  queries: EvidenceQuery[];
}

export interface StreamView {
  answer: string;
  verdicts: Verdict[];
  evidence: EvidencePart[];
  model: string;
}

/** The shape we need from a UIMessage; deliberately loose. */
export interface ViewMessage {
  role: string;
  parts: Array<Record<string, unknown>>;
}

/**
 * "30867" and "56:30867" are the same agent. Without normalising, a model that
 * spells the id both ways in one answer defeats the dedupe and draws two cards
 * for one agent.
 */
export function verdictKey(v: { agentId: string; chainId?: number }): string {
  const raw = String(v.agentId ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes(':')) return raw;
  return v.chainId != null ? `${v.chainId}:${raw}` : raw;
}

/**
 * Project ONE assistant message into the view.
 *
 * Scoped to a single message on purpose — this is a single-answer view. The
 * earlier version folded every assistant message in `messages`, so a second
 * question appended its cards and text to the first one's instead of replacing
 * them. Two submissions then produced two cards for the same agent and two
 * answer paragraphs run together.
 */
export function projectMessage(message: ViewMessage | undefined): StreamView {
  const texts: string[] = [];
  const verdicts: Verdict[] = [];
  const evidence: EvidencePart[] = [];
  const seen = new Set<string>();
  let model = '';

  for (const part of message?.parts ?? []) {
    const type = part.type as string;

    if (type === 'text') {
      const t = (part.text as string) ?? '';
      if (t.trim()) texts.push(t.trim());
      continue;
    }

    if (type === 'data-evidence') {
      evidence.push(part.data as unknown as EvidencePart);
      continue;
    }

    if (type === 'data-model') {
      model = (part.data as { id?: string })?.id ?? model;
      continue;
    }

    if (type === 'tool-emit_verdict' && part.state === 'output-available') {
      const out = part.output as (Verdict & { recorded?: boolean }) | undefined;
      // recorded:false is the SERVER's duplicate guard rejecting a repeat.
      // That rejection is carried on the streamed tool output, so the client
      // sees it — but the client dedupes again below rather than trusting it,
      // because the two guards protect against different things: the server's
      // is per request, this one is per rendered answer.
      if (!out?.recorded) continue;
      const key = verdictKey(out);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      verdicts.push(out as Verdict);
    }
  }

  return {
    // Separate text parts are separate blocks from separate model steps.
    // Concatenating them bare fused the last word of one into the first word
    // of the next ("...reviewers.Recommendation:"), so they are joined as
    // paragraphs. <Answer> splits on a blank line to render them.
    answer: texts.join('\n\n'),
    verdicts,
    evidence,
    model,
  };
}

/**
 * The view for the newest answer only. Anything older is history the page does
 * not show.
 */
export function projectLatestAnswer(messages: readonly ViewMessage[]): StreamView {
  let latest: ViewMessage | undefined;
  for (const m of messages) if (m.role === 'assistant') latest = m;
  return projectMessage(latest);
}
