import 'server-only';

import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
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

export type LlmProvider = 'google' | 'anthropic' | 'openai';

/**
 * Mid-tier, tool-calling, cheap enough to run a hackathon demo on.
 *
 * google:    gemini-3.8-flash is the id the @ai-sdk/google docs use throughout
 *            their own setup snippets, it is listed with tool support, and it
 *            works on the free tier. Verified 11 Sep 2026.
 * anthropic: Sonnet is the mid tier between Haiku and Opus.
 * openai:    gpt-5-mini is the mid tier between nano and full gpt-5.
 */
export const MODEL_IDS: Record<LlmProvider, string> = {
  google: 'gemini-3.8-flash',
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5-mini',
};

const ENV_KEY: Record<LlmProvider, string> = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const PROVIDERS: readonly LlmProvider[] = ['google', 'anthropic', 'openai'];

/**
 * Optional per-deployment model override.
 *
 * This exists because Gemini's free tier meters
 * `GenerateRequestsPerDayPerProjectPerModel` at **20 requests per day, per
 * model**. Scout spends one request per reasoning step, so a handful of
 * questions exhausts a model for the rest of the day — and because the quota
 * is per MODEL, the fix is simply to name a different one. Without this
 * override that is a code change and a redeploy, which is absurd for a demo
 * that has just run out of quota mid-session.
 *
 * Unset, the documented default below is used.
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
  if (!raw) return 'google';
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
 * Gemini's free tier has a low per-minute quota and Scout's multi-step tool
 * loop can burn through it inside one question. The AI SDK surfaces the HTTP
 * status on APICallError; the string check is the fallback for providers that
 * bury it in the message instead.
 */
export function isRateLimit(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; message?: string } | null;
  if (!e) return false;
  if (e.statusCode === 429 || e.status === 429) return true;
  return typeof e.message === 'string' && /\b429\b|rate.?limit|quota/i.test(e.message);
}
