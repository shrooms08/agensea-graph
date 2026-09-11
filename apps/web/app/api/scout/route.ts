/**
 * POST /api/scout — Scout, a trust analyst over live Agent0 subgraph data.
 *
 * The model gets four tools and no ability to invent numbers: every figure it
 * can cite comes from a tool result, and every subgraph query that produced
 * one is streamed to the UI as evidence.
 *
 * Shape notes for this AI SDK version (ai@7):
 *   - step limit is `stopWhen: stepCountIs(n)`, not `maxSteps`
 *   - tool schemas are `inputSchema`, not `parameters`
 *   - the response helper is `toUIMessageStreamResponse()` / the standalone
 *     `toUIMessageStream()`, not `toDataStreamResponse()`
 * All three were renamed after v5.
 */
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  tool,
  toUIMessageStream,
  type UIMessageStreamWriter,
} from 'ai';
import { z } from 'zod';

import {
  cachedAllChainsAdoption,
  cachedChainAdoption,
  cachedHasValidationRegistry,
} from '@/lib/graph/adoption-cache';
import { CHAINS, DEFAULT_CHAIN_ID, getChainById } from '@/lib/graph/chains';
import { withEvidence, type EvidenceRecord } from '@/lib/graph/evidence';
import {
  getAgentTrustProfile,
  getFeedbackForAgent,
  searchAgents,
  toCompositeId,
} from '@/lib/graph/queries';
import { activeModelId, getModel, isRateLimit, modelProviderOptions } from '@/lib/llm';
import { computeTrustSignals } from '@/lib/scout/analysis';

export const runtime = 'nodejs';
export const maxDuration = 60;

/* -------------------------------------------------------------------------- */
/* Evidence                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Evidence is streamed to the UI as its own `data-evidence` part, NOT returned
 * inside the tool result.
 *
 * Both were viable, and the tool result was the first thing tried. It is the
 * wrong place: a tool result goes back into the model's context, so the full
 * GraphQL document text — ~2KB per query — was being re-sent to Gemini on
 * every subsequent step to no purpose whatsoever. The model never needs to
 * read the query it caused; only the reader does. Moving it to a data part cut
 * about 20KB of tool payload out of the conversation.
 *
 * `toolCallId` is what ties a data part back to the call that produced it,
 * which is the one thing the tool-result form gave for free.
 */
interface EvidencePart {
  toolCallId: string;
  toolName: string;
  cached: boolean;
  queries: {
    seq: number;
    subgraphId: string;
    query: string;
    variables: Record<string, unknown>;
    rowCount: number;
    ms: number;
    ok: boolean;
    error?: string;
  }[];
}

/** The source documents are indented for humans; that indentation is a third
 *  of the bytes on a stream that also carries model tokens. */
function forWire(r: EvidenceRecord) {
  return {
    seq: r.seq,
    subgraphId: r.subgraphId,
    query: r.query.replace(/\n\s*/g, ' ').trim(),
    variables: r.variables,
    rowCount: r.rowCount,
    ms: r.ms,
    ok: r.ok,
    ...(r.error ? { error: r.error } : {}),
  };
}

type Writer = UIMessageStreamWriter;

/** Run a tool body with subgraph calls recorded, streaming them to the UI. */
async function tracked<T>(
  writer: Writer,
  toolName: string,
  toolCallId: string,
  fn: () => Promise<T>,
  opts: { cached?: boolean } = {},
): Promise<T> {
  const { result, evidence } = await withEvidence(fn);
  const part: EvidencePart = {
    toolCallId,
    toolName,
    cached: opts.cached ?? false,
    queries: evidence.map(forWire),
  };
  writer.write({ type: 'data-evidence', data: part as unknown as Record<string, unknown> });
  return result;
}

/* -------------------------------------------------------------------------- */
/* Projections — what the model is allowed to see                              */
/* -------------------------------------------------------------------------- */

/**
 * Agents are projected down before reaching the model.
 *
 * `agentURI` in particular is dropped: on BSC it is routinely a 2.5KB base64
 * data: URI holding the same name and description already present in
 * registrationFile. Ten search hits of that is most of a context window spent
 * re-sending what the model already has in readable form.
 */
function projectAgent(a: Awaited<ReturnType<typeof searchAgents>>[number]) {
  const reg = a.registrationFile;
  return {
    id: a.id,
    agentId: a.agentId,
    owner: a.owner,
    totalFeedback: Number(a.totalFeedback),
    createdAt: a.createdAt,
    lastActivity: a.lastActivity,
    name: reg?.name ?? null,
    description: reg?.description?.slice(0, 300) ?? null,
    hasRegistrationFile: reg != null,
    selfDeclaredActive: reg?.active ?? null,
    endpoints: {
      mcp: reg?.mcpEndpoint ?? null,
      a2a: reg?.a2aEndpoint ?? null,
      web: reg?.webEndpoint ?? null,
      oasf: reg?.oasfEndpoint ?? null,
      email: reg?.emailEndpoint ?? null,
    },
    supportedTrusts: reg?.supportedTrusts ?? [],
    oasfSkills: reg?.oasfSkills ?? [],
    x402Support: reg?.x402Support ?? null,
  };
}

const chainIdSchema = z
  .number()
  .int()
  .describe(`Chain id. One of: ${CHAINS.map((c) => `${c.chainId} (${c.name})`).join(', ')}.`);

/**
 * NULL-TOLERANT OPTIONAL PARAMS.
 *
 * Every optional tool parameter below uses `.nullish()` and applies its
 * default in the execute body, rather than `.optional()` or `.default()`.
 *
 * Models disagree about how to decline an optional argument. Gemini omits the
 * key. Groq's gpt-oss sends it explicitly as `null` — which `.optional()`
 * rejects, and the whole run dies on:
 *
 *   Tool call validation failed: parameters for tool get_chain_adoption did
 *   not match schema: errors: [`/chainId`: expected integer, but got null]
 *
 * `.default()` has the same hole: a default only fills an ABSENT key, so an
 * explicit null still fails validation. Accepting both spellings and
 * defaulting in code is the only form that survives a provider swap.
 */

/* -------------------------------------------------------------------------- */
/* System prompt                                                               */
/* -------------------------------------------------------------------------- */

const SYSTEM = `You are Scout, a trust analyst for the ERC-8004 agent registries indexed by The Graph's Agent0 subgraphs. You answer questions about whether an on-chain agent can be trusted, using ONLY data returned by your tools.

HOW YOU WORK
- Call tools to get facts. Never state a number, name, date or score that did not come from a tool result in this conversation.
- Cite your source inline for each claim, naming the tool, e.g. "234 reviews (get_trust_profile)".
- If a tool fails or returns nothing, say so plainly. Do not substitute an estimate, and do not retry the same call more than once.
- You must call emit_verdict EXACTLY ONCE for each agent you evaluate — no more, no less. Do not emit a verdict for an agent you did not look up.
- emit_verdict is a TOOL CALL. NEVER write a verdict as JSON, a code block, or any other text in your reply — text is not a verdict, renders no card, and the user sees nothing. If you catch yourself typing "{" to describe an agent, stop and call the tool instead.
- After your tool calls, finish with a SHORT plain-language answer, 2-4 sentences. The verdict cards carry the detail; do not repeat them in full.
- Be efficient: you have a 60 second budget and 8 steps, and the model is rate limited, so every wasted call risks the whole answer. Do not look up more than 2 agents in one answer.

USING search_agents WELL
- It is a SUBSTRING match, not a semantic one. Search ONE short word: "yield", not "yield monitoring" — a multi-word phrase must appear verbatim and usually matches nothing.
- Pass withFeedbackOnly: true whenever the question asks for agents with real usage or real feedback.
- Get it right first time. If one short term returns nothing, try at most ONE alternative, then say nothing matched.

DATA FACTS YOU MUST RESPECT
1. Agent ids are composite strings "chainId:agentId", e.g. "56:30867". A bare "30867" is ambiguous; always pair it with a chainId. The tools accept either form.
2. Feedback.value has NO fixed unit. Its meaning is set by tag1 on the same row: value 100 under tag1 "uptime" is a percentage, value 236 under tag1 "responseTime" is milliseconds, value 60 under "outcome:partially" is a rating. NEVER average or compare values across different tags, and never call value "the score" without naming its tag. feedbackByTag in the trust signals is already grouped correctly — use it.
3. No validation registry is deployed on ANY live chain right now (every Protocol.validationRegistry is the zero address). So an agent having zero validations is expected and is NOT a negative signal. The VALIDATION_UNAVAILABLE flag is informational. Say this if validation comes up.
4. registrationFile == null means the agent published no metadata (no name, description or endpoints). That is a real gap worth reporting, not a tool failure.
5. All *Stats counters from the subgraph are CUMULATIVE running totals, not per-period deltas. Do not describe them as "new this day/week" and do not sum them.
6. Flags marked heuristic:true are guesses, not measurements. NAME_LOOKALIKE especially: report it as "worth verifying", never as proof of impersonation.
7. reportedTotalFeedback is the chain's own count for the agent; analysedFeedback is how many rows were actually fetched. If analysedFeedback is lower, your concentration and burstiness figures describe that sample, so say so.

RECOMMENDATIONS
- "hire": real independent usage, metadata and a reachable endpoint, no serious flags.
- "caution": usable but with a concrete concern — concentrated reviewers, a burst pattern, thin history, or a lookalike name.
- "avoid": no metadata, no endpoints, or evidence the reputation is manufactured.
- "insufficient_data": too little to judge. Prefer this over guessing.
Confidence reflects how much evidence you actually have, not how strong your opinion is.`;

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/** Built per request so each tool can stream evidence through `writer`. */
function makeTools(writer: Writer) {
  /**
   * One verdict per agent, enforced server-side.
   *
   * The system prompt says "exactly once per agent", but a prompt is a request,
   * not a constraint — and a model that re-emits after re-reading a profile
   * would put two contradictory cards on screen for the same agent. The second
   * call is answered with recorded:false so the model learns it already did
   * this, and the UI (which renders only recorded:true) never draws it.
   */
  const emitted = new Set<string>();

  return {
    search_agents: tool({
      description:
        'Search agents on one chain by free text matched against their registration file name ' +
        'and description, case-insensitively. Returns the most-reviewed matches first. Use this ' +
        'to find agents by what they do, e.g. "yield", "lending", "monitoring".',
      inputSchema: z.object({
        chainId: chainIdSchema,
        text: z.string().min(1).describe('Free text to match, e.g. "yield".'),
        // nullish(), not optional()/default(): see NULL-TOLERANT note above.
        first: z.number().int().min(1).max(25).nullish(),
        withFeedbackOnly: z
          .boolean()
          .nullish()
          .describe('True to return only agents that have at least one review.'),
      }),
      execute: async ({ chainId, text, first, withFeedbackOnly }, { toolCallId }) =>
        tracked(writer, 'search_agents', toolCallId, async () => {
          const agents = await searchAgents({
            chainId,
            text,
            first: first ?? 8,
            withFeedbackOnly: withFeedbackOnly ?? false,
          });
          return { chainId, text, matchCount: agents.length, agents: agents.map(projectAgent) };
        }),
    }),

    get_trust_profile: tool({
      description:
        'Full trust profile for ONE agent: registration metadata, recent feedback, and computed ' +
        'trust signals (per-tag feedback stats, distinct reviewers, concentration, burstiness, ' +
        'flags). This is the main tool for judging an agent.',
      inputSchema: z.object({
        chainId: chainIdSchema,
        agentId: z
          .string()
          .describe('Bare agent id ("30867") or composite ("56:30867"). Both accepted.'),
      }),
      execute: async ({ chainId, agentId }, { toolCallId }) =>
        tracked(writer, 'get_trust_profile', toolCallId, async () => {
          const id = toCompositeId(chainId, agentId);
          const profile = await getAgentTrustProfile({ chainId, agentId: id });

          if (!profile.agent) {
            return {
              found: false as const,
              id,
              message: `No agent ${id} is indexed on chain ${chainId}.`,
            };
          }

          // A deeper feedback history than the profile's default 20: both
          // concentration and burstiness are materially wrong on a truncated
          // sample, and this is one extra query rather than one per row.
          const feedback = await getFeedbackForAgent({ chainId, agentId: id, first: 200 });

          // One cheap cached boolean. Reading it off the adoption rollup
          // instead cost a full five-chain recompute — 45 subgraph queries and
          // 62s — to answer a question about one agent.
          const hasValidationRegistry = await cachedHasValidationRegistry(chainId);

          const signals = computeTrustSignals({ profile, feedback, hasValidationRegistry });

          return {
            found: true as const,
            id,
            chainId,
            agent: projectAgent(profile.agent),
            signals,
            validationCount: profile.validations.length,
            hasValidationRegistry,
            recentFeedback: feedback.slice(0, 8).map((f) => ({
              client: f.clientAddress,
              value: f.value,
              tag1: f.tag1,
              tag2: f.tag2,
              createdAt: f.createdAt,
              isRevoked: f.isRevoked,
              text: f.feedbackFile?.text ?? null,
            })),
          };
        }),
    }),

    get_chain_adoption: tool({
      description:
        'Adoption totals for one chain, or for all five when chainId is omitted: total agents, ' +
        'agents with at least one review, total feedback, and whether a validation registry is ' +
        'deployed. Served from an hourly cache. Use this for "compare chains" questions.',
      inputSchema: z.object({
        // nullish(): gpt-oss sends an explicit null here rather than omitting
        // the key. See the NULL-TOLERANT note above.
        chainId: chainIdSchema.nullish().describe('Omit to get every chain.'),
      }),
      execute: async ({ chainId }, { toolCallId }) =>
        // cached: true — on a cache hit this issues no subgraph query at all,
        // so an empty query list here is honest rather than a gap.
        tracked(
          writer,
          'get_chain_adoption',
          toolCallId,
          async () => {
            const rows = chainId
              ? [await cachedChainAdoption(chainId)]
              : await cachedAllChainsAdoption();
            return {
              cached: true,
              cacheWindowSeconds: 3600,
              chains: rows.map((c) =>
                c.ok
                  ? {
                      ok: true,
                      chainId: c.chainId,
                      chainName: c.chainName,
                      totalAgents: c.totalAgents,
                      agentsWithFeedback: c.agentsWithFeedback,
                      agentsWithFeedbackExact: c.agentsWithFeedbackExact,
                      adoptionRate:
                        c.totalAgents > 0
                          ? Math.round((c.agentsWithFeedback / c.totalAgents) * 1e6) / 1e6
                          : null,
                      totalFeedbackCreated: c.totalFeedbackCreated,
                      totalFeedbackRevoked: c.totalFeedbackRevoked,
                      hasValidationRegistry: c.hasValidationRegistry,
                      blockNumber: c.blockNumber,
                    }
                  : { ok: false, chainId: c.chainId, chainName: c.chainName, error: c.error },
              ),
            };
          },
          { cached: true },
        ),
    }),

    emit_verdict: tool({
      description:
        'Record your verdict for ONE agent. Call this exactly once per agent you evaluate, after ' +
        'you have its trust profile. The UI renders each verdict as a card.',
      inputSchema: z.object({
        agentId: z.string().describe('Composite id, e.g. "56:30867".'),
        chainId: z.number().int(),
        name: z.string().describe('Agent name, or "(no registration file)" when it has none.'),
        liveness: z.string().describe('One line on metadata, endpoints and recency.'),
        reputationSummary: z
          .string()
          .describe('One or two lines. Name the tag whenever you quote a feedback value.'),
        flags: z.array(z.string()).describe('Flag codes from the trust signals, or [] if none.'),
        recommendation: z.enum(['hire', 'caution', 'avoid', 'insufficient_data']),
        confidence: z.enum(['low', 'medium', 'high']),
        reasoning: z.string().describe('2-4 sentences justifying the recommendation.'),
      }),
      // Echoing the verdict back keeps it in the message parts for the UI to
      // render and gives the model a confirmation it can move on from.
      execute: async (verdict) => {
        // Normalise through toCompositeId so "30867" and "56:30867" are one
        // key, not two — otherwise the guard is trivially defeated by the
        // model spelling the same agent both ways. Falls back to the raw
        // string when the id is for another chain or is unparseable, which
        // toCompositeId signals by throwing.
        let key: string;
        try {
          key = toCompositeId(verdict.chainId, verdict.agentId).toLowerCase();
        } catch {
          key = verdict.agentId.trim().toLowerCase();
        }
        if (emitted.has(key)) {
          return {
            recorded: false as const,
            duplicate: true as const,
            agentId: verdict.agentId,
            message:
              `A verdict for ${verdict.agentId} was already recorded in this answer. ` +
              `It has been kept and this one discarded. Do not call emit_verdict for ` +
              `this agent again — move on to your final plain-language answer.`,
          };
        }
        emitted.add(key);
        return { recorded: true as const, ...verdict };
      },
    }),
  };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                     */
/* -------------------------------------------------------------------------- */

const bodySchema = z.object({
  question: z.string().min(1).max(2000),
  chainId: z.number().int().optional(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Body must be JSON.' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: 'Expected { question: string, chainId?: number }.', detail: parsed.error.issues },
      { status: 400 },
    );
  }

  const { question } = parsed.data;
  const chainId = parsed.data.chainId ?? DEFAULT_CHAIN_ID;
  const chain = getChainById(chainId);
  if (!chain) {
    return Response.json(
      { error: `Unknown chainId ${chainId}. Known: ${CHAINS.map((c) => c.chainId).join(', ')}.` },
      { status: 400 },
    );
  }

  let model;
  try {
    model = getModel();
  } catch (err) {
    // A missing API key is a configuration problem, not a model failure — 503
    // naming the variable beats a stream that dies with no explanation.
    return Response.json({ error: (err as Error).message }, { status: 503 });
  }

  /**
   * Shown to the user, so it has to be useful — and must never leak the
   * gateway URL, which carries the API key in its path. GraphError messages
   * are already redacted at the client layer.
   */
  const describe = (err: unknown): string => {
    if (isRateLimit(err)) {
      return (
        `${activeModelId()} is rate limited (429). The free tier allows only a few requests ` +
        `per minute — wait a minute and ask again.`
      );
    }
    if ((err as { statusCode?: number } | null)?.statusCode === 503) {
      return `${activeModelId()} is temporarily overloaded (503). Try again in a moment.`;
    }
    return `Scout failed: ${err instanceof Error ? err.message : String(err)}`;
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /**
   * Hard deadline, a few seconds inside maxDuration.
   *
   * Without it the run can overshoot 60s and Vercel kills the function, which
   * the browser sees as a truncated stream with no explanation. Measured: one
   * rate-limited run took 143s in dev (SDK backoff plus the 429 retry below),
   * which in production would simply have vanished. Aborting ourselves ends
   * the stream cleanly with whatever verdicts already landed.
   */
  const DEADLINE_MS = 56_000;
  /**
   * Soft budget: after this, no NEW tool calls are allowed and the model must
   * write its answer with what it already has.
   *
   * The hard abort alone was not enough. Groq free-tier latency is wildly
   * variable — the same question measured 4.6s and 38.7s on consecutive runs —
   * and the 4-model-call shape ("search, profile, verdict, answer") hit the
   * 52s abort on every attempt, killing the final plain-language answer after
   * the verdict card had already rendered. A verdict with no answer is the
   * worst possible output: it looks like the product is broken.
   *
   * TWO tiers, because one is a trap. A single gate that turns all tools off
   * can fire before emit_verdict has been called, which loses the verdict as
   * well as the answer — strictly worse than doing nothing.
   *
   *   past GATHER_BUDGET : only emit_verdict stays enabled. No new lookups,
   *                        but the model can still record what it has judged.
   *   past ANSWER_BUDGET : tools off entirely. Write the summary now.
   *
   * Tuned against measurements, not guessed. At 34s/52s the four-call shape
   * lost its answer on every run: the closing call started at ~39s with 13s
   * left and did not make it. These values leave the summary ~18s, which is
   * above the median single Groq response measured here.
   */
  const GATHER_BUDGET_MS = 20_000;
  const ANSWER_BUDGET_MS = 38_000;
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(DEADLINE_MS);

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      // Announce the model that is actually answering. The page is statically
      // rendered, so anything it printed about the model would be frozen at
      // build time — and LLM_MODEL exists precisely so the model can change at
      // runtime. Sending it per-request is the only version that stays true.
      writer.write({ type: 'data-model', data: { id: activeModelId() } });

      const tools = makeTools(writer);

      const providerOptions = modelProviderOptions();

      const runStream = () =>
        streamText({
          model,
          system: SYSTEM,
          stopWhen: stepCountIs(8),
          tools,
          ...(providerOptions ? { providerOptions } : {}),
          abortSignal: deadline,
          /**
           * Wind the tool loop down on a clock so the run ends with prose
           * rather than being guillotined mid-loop. See the budget constants.
           */
          prepareStep: ({ stepNumber }) => {
            if (stepNumber === 0) return {};
            const spent = Date.now() - startedAt;
            if (spent > ANSWER_BUDGET_MS) return { toolChoice: 'none' as const };
            if (spent > GATHER_BUDGET_MS) return { activeTools: ['emit_verdict' as const] };
            return {};
          },
          // Free tiers return transient 503s as well as 429s — Gemini as
          // "high demand", Groq under load. These are the SDK's own per-call
          // retries with backoff; the 429 handling below is a separate,
          // coarser retry of the whole run. Kept at 2, not 3: the backoff is
          // exponential and both mechanisms must fit inside DEADLINE_MS.
          maxRetries: 2,
          prompt:
            `Default chain for this question: ${chainId} (${chain.name}). ` +
            `Use it unless the question names another.\n\nQuestion: ${question}`,
        });

      /**
       * One retry, for 429 only — without giving up streaming.
       *
       * The probe is `await result.warnings`, which settles once the provider
       * has actually responded and REJECTS on a 429, but does not buffer any
       * content. The obvious alternative, `await result.text`, would also
       * catch the 429 — but only by generating the whole answer first, which
       * turns the stream into one late blob and defeats the streaming UI.
       *
       * The wait is 12s, not the full 60s quota window: it has to fit inside
       * DEADLINE_MS alongside the SDK's own backoff and still leave time to
       * answer. A second 429 is reported, not retried again.
       */
      let result = runStream();
      try {
        await result.warnings;
      } catch (err) {
        if (!isRateLimit(err)) throw err;
        await sleep(12_000);
        result = runStream();
        await result.warnings;
      }

      // onError is needed HERE as well as on createUIMessageStream: an error
      // raised inside the merged stream is masked by toUIMessageStream's own
      // default handler, which is why a real 503 first reached the browser as
      // the useless string "An error occurred."
      writer.merge(
        toUIMessageStream({
          stream: result.fullStream,
          tools,
          sendStart: false,
          onError: describe,
        }),
      );

      /**
       * If the hard deadline fired, say so in the answer area.
       *
       * Otherwise a timed-out run renders as a verdict card with no prose
       * under it, which reads as a broken product rather than a slow one. The
       * verdict is still real and still evidence-backed — only the closing
       * summary is missing, and that is worth stating plainly.
       */
      // PromiseLike, not a Promise — no .catch(), so wrap it.
      await Promise.resolve(result.finishReason).catch(() => undefined);
      if (deadline.aborted) {
        writer.write({
          type: 'text-delta',
          id: 'deadline-note',
          delta:
            `\n\n_(Scout ran out of time at ${Math.round(DEADLINE_MS / 1000)}s and stopped ` +
            `before writing its summary. Any verdict above is complete and backed by the ` +
            `queries in Evidence — ${activeModelId()} on Groq's free tier is slow and highly ` +
            `variable. Re-ask to get the summary.)_`,
        });
      }
    },
    onError: describe,
  });

  return createUIMessageStreamResponse({ stream });
}
