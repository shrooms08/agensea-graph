import 'server-only';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

/**
 * Provider selection for Scout. One mid-tier tool-calling model per provider.
 *
 * Every id below was taken from the model list compiled into the installed
 * provider package, not from memory — and the Google one was then confirmed
 * with a real tool-calling round trip against the key in .env.local. That
 * check earned its keep: the obvious choice, `gemini-2.5-flash`, answers
 * "no longer available to new users" on a key issued today. Re-verify rather
 * than re-reason if any of these ever start 404ing.
 */

export type LlmProvider = 'groq' | 'google' | 'anthropic' | 'openai';

/**
 * Default provider: groq.
 *
 * Not a preference — a capacity decision. Gemini's free tier allows 20
 * requests per DAY per model, and Scout spends one per reasoning step, so
 * roughly four questions exhausted it. Groq's free tier allows 1,000 per day
 * on the model below: 50x the headroom, which is the difference between a
 * demo that works and one that does not.
 */
export const DEFAULT_PROVIDER: LlmProvider = 'groq';

/**
 * Mid-tier, tool-calling, cheap enough to run a hackathon demo on.
 *
 * groq:      openai/gpt-oss-120b. Groq's published free-tier table tops out
 *            at 1,000 requests/day, shared by gpt-oss-120b, gpt-oss-20b and
 *            the qwen3.x-27b pair; the 14.4K-RPD entries are
 *            llama-prompt-guard classifiers, not chat models, so they cannot
 *            run Scout. Of the three real candidates, verified against the
 *            key in .env.local: both gpt-oss sizes tool-call correctly, and
 *            qwen/qwen3.6-27b returns 429 "Request too large" even on a
 *            two-number test call. 120b over 20b because the larger model
 *            follows the emit_verdict protocol more reliably.
 *
 *            THE BINDING LIMIT IS TOKENS PER DAY, NOT REQUESTS. Measured the
 *            hard way: 200,000 TPD, and a day of testing Scout exhausted it
 *            at 198,955 used while 892 of the 1,000 requests were still
 *            unspent. A Scout question costs roughly 5-10K tokens across its
 *            tool loop, so the real budget is ~20-40 questions/day per model,
 *            not 1,000. Only the 429 body reports TPD; the x-ratelimit-*
 *            headers show the 8K-per-MINUTE token cap and hide it.
 *            The per-model pools are separate — hence LLM_MODEL below.
 * google:    gemini-3.8-flash is the id the @ai-sdk/google docs use throughout
 *            their own setup snippets, it is listed with tool support, and it
 *            works on the free tier. Verified 11 Sep 2026.
 * anthropic: Sonnet is the mid tier between Haiku and Opus.
 * openai:    gpt-5-mini is the mid tier between nano and full gpt-5.
 */
export const MODEL_IDS: Record<LlmProvider, string> = {
  groq: 'openai/gpt-oss-120b',
  google: 'gemini-3.8-flash',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5-mini',
};

const ENV_KEY: Record<LlmProvider, string> = {
  groq: 'GROQ_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const PROVIDERS: readonly LlmProvider[] = ['groq', 'google', 'anthropic', 'openai'];

/**
 * Optional per-deployment model override.
 *
 * Applies to every provider, groq included. It exists because free-tier quota
 * is metered PER MODEL, so the fix for an exhausted model is to name another
 * one — and without this override that is a code change and a redeploy, which
 * is absurd for a demo that has just run out of quota mid-session.
 *
 * Unset, the per-provider default below is used.
 */
function overrideModelId(): string | null {
  return process.env.LLM_MODEL?.trim() || null;
}

function isProvider(v: string): v is LlmProvider {
  return (PROVIDERS as readonly string[]).includes(v);
}

/**
 * Which provider is configured. Defaults to google because that is the only
 * key present in .env.local; an unset LLM_PROVIDER should not be an error when
 * exactly one provider is actually usable.
 */
export function activeProvider(): LlmProvider {
  const raw = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (!raw) return DEFAULT_PROVIDER;
  if (!isProvider(raw)) {
    throw new Error(
      `LLM_PROVIDER="${raw}" is not supported. Use one of: ${PROVIDERS.join(', ')}.`,
    );
  }
  return raw;
}

/**
 * The configured model, constructed fresh per call.
 *
 * Keys are read at CALL time, never at import time: this module is reachable
 * from the route's module graph, and reading at import time would make the
 * whole route fail to build wherever the key is absent (CI, a preview deploy
 * without the secret, `next build` tracing the graph).
 */
export function getModel(): LanguageModel {
  const provider = activeProvider();
  const envVar = ENV_KEY[provider];
  const apiKey = process.env[envVar]?.trim();

  if (!apiKey) {
    throw new Error(
      `${envVar} is not set, but LLM_PROVIDER resolves to "${provider}". ` +
        `Add ${envVar} to .env.local (local) or the Vercel project environment (deployed), ` +
        `or set LLM_PROVIDER to a provider whose key you do have.`,
    );
  }

  const modelId = activeModelId();

  switch (provider) {
    case 'groq':
      return createGroq({ apiKey })(modelId);
    case 'google':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'anthropic':
      return createAnthropic({ apiKey })(modelId);
    case 'openai':
      return createOpenAI({ apiKey })(modelId);
  }
}

/** For the UI and error messages — which model actually answered. */
export function activeModelId(): string {
  return overrideModelId() ?? MODEL_IDS[activeProvider()];
}

/**
 * True for a provider rate-limit response.
 *
 * Every free tier here meters something Scout's multi-step tool loop can
 * exhaust inside a question — Gemini 20 requests/day/model, Groq 1,000/day
 * plus a token-per-minute cap. The AI SDK surfaces the HTTP status on
 * APICallError; the string check is the fallback for providers that bury it
 * in the message instead.
 */
export function isRateLimit(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string } | null;
  if (!e) return false;
  if (e.statusCode === 429 || e.status === 429) return true;
  return typeof e.message === 'string' && /\b429\b|rate.?limit|quota/i.test(e.message);
}

/**
 * Provider-specific call options, keyed for `streamText({ providerOptions })`.
 *
 * Lives here rather than in the route so the route stays provider-agnostic:
 * switching LLM_PROVIDER must not require editing app/api/scout.
 *
 * groq — gpt-oss is a reasoning model, and left to its own default it spent
 * long enough thinking between tool calls that a 4-step question ran out the
 * 52s budget and lost its final answer. `reasoningEffort: 'low'` is the
 * cheapest tier Groq accepts. Note the AI SDK's enum also offers 'none' and
 * 'default'; Groq rejects both with
 * "`reasoning_effort` must be one of `low`, `medium`, or `high`", so do not
 * "fix" this to 'none'.
 */
export function modelProviderOptions():
  | Record<string, Record<string, string | number | boolean>>
  | undefined {
  switch (activeProvider()) {
    case 'groq':
      return { groq: { reasoningEffort: 'low' } };
    default:
      return undefined;
  }
}
