/**
 * Unit tests for the rate-limit classifier (lib/llm.ts classifyRateLimit).
 *
 * The classifier decides whether a 429 means "wait a few seconds" or "this
 * provider is done for the day", and those have opposite remedies — a short
 * backoff vs switching providers. Getting it backwards either abandons the
 * configured model over a hiccup, or backs off for 12 seconds against a quota
 * that will not return for hours.
 *
 * EVERY ERROR BODY BELOW IS SYNTHETIC. They are hand-written to match the
 * shapes and wording the two providers actually use — Groq's prose
 * "tokens per day (TPD)" and Google's structured QuotaFailure with a
 * "GenerateRequestsPerDayPerProjectPerModel" quotaId — but they are not
 * captured responses, and no network call is made.
 *
 *   node tests/llm-ratelimit.test.mjs      (run by: npm test)
 */
import { classifyRateLimit, isRateLimit } from '../lib/llm.ts';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
};

/** An AI SDK APICallError-shaped object. */
const apiError = ({ statusCode = 429, message = 'Rate limit', responseBody, data }) => {
  const e = new Error(message);
  e.statusCode = statusCode;
  if (responseBody !== undefined) e.responseBody = responseBody;
  if (data !== undefined) e.data = data;
  return e;
};

/* -------------------------------------------------------------------- */
console.log('\n-- Groq shapes (synthetic) --');

const groqTPD = apiError({
  message: 'Rate limit reached for model `openai/gpt-oss-120b`',
  responseBody: JSON.stringify({
    error: {
      message:
        'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` '
        + 'service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 200000, '
        + 'Requested 1200. Please try again in 6h13m20s.',
      type: 'tokens',
      code: 'rate_limit_exceeded',
    },
  }),
});
check('Groq tokens-per-day (TPD) -> daily', classifyRateLimit(groqTPD) === 'daily', classifyRateLimit(groqTPD));

const groqRPD = apiError({
  responseBody: JSON.stringify({
    error: {
      message:
        'Rate limit reached for model `openai/gpt-oss-20b` on requests per day (RPD): '
        + 'Limit 1000, Used 1000, Requested 1. Please try again in 2h.',
      code: 'rate_limit_exceeded',
    },
  }),
});
check('Groq requests-per-day (RPD) -> daily', classifyRateLimit(groqRPD) === 'daily', classifyRateLimit(groqRPD));

const groqTPM = apiError({
  responseBody: JSON.stringify({
    error: {
      message:
        'Rate limit reached for model `openai/gpt-oss-120b` in organization `org_x` '
        + 'service tier `on_demand` on tokens per minute (TPM): Limit 8000, Used 7800, '
        + 'Requested 900. Please try again in 5.2s.',
      code: 'rate_limit_exceeded',
    },
  }),
});
check('Groq tokens-per-minute (TPM) -> per-minute', classifyRateLimit(groqTPM) === 'per-minute', classifyRateLimit(groqTPM));

const groqRPM = apiError({
  responseBody: JSON.stringify({
    error: { message: 'Rate limit reached on requests per minute (RPM): Limit 30. Try again in 1.4s.' },
  }),
});
check('Groq requests-per-minute (RPM) -> per-minute', classifyRateLimit(groqRPM) === 'per-minute', classifyRateLimit(groqRPM));

/* -------------------------------------------------------------------- */
console.log('\n-- Google shapes (synthetic) --');

// Google buries the quota id in a structured detail array rather than prose.
const googlePerDay = apiError({
  message: 'You exceeded your current quota, please check your plan and billing details.',
  data: {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
              quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
              quotaDimensions: { model: 'gemini-3.8-flash', location: 'global' },
              quotaValue: '20',
            },
          ],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' },
      ],
    },
  },
});
check(
  'Google PerDay quotaId -> daily (camel-case, no spaces)',
  classifyRateLimit(googlePerDay) === 'daily',
  classifyRateLimit(googlePerDay),
);

const googlePerMinute = apiError({
  message: 'You exceeded your current quota.',
  data: {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            {
              quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
              quotaValue: '15',
            },
          ],
        },
      ],
    },
  },
});
check(
  'Google PerMinute quotaId -> per-minute',
  classifyRateLimit(googlePerMinute) === 'per-minute',
  classifyRateLimit(googlePerMinute),
);

/* -------------------------------------------------------------------- */
console.log('\n-- boundaries --');

check('a non-429 error is not a rate limit at all', classifyRateLimit(apiError({ statusCode: 503, message: 'overloaded' })) === 'none');
check('null is classified none', classifyRateLimit(null) === 'none');
check('a bare 429 with no quota wording defaults to per-minute', classifyRateLimit(apiError({ statusCode: 429, message: 'Too Many Requests' })) === 'per-minute');
check('per-minute is the safe default: it retries rather than abandoning the provider', classifyRateLimit(apiError({ statusCode: 429, message: '' })) === 'per-minute');

// Whole-word matching: an opaque id containing those letters must not trip it.
const idLooksLikeTPD = apiError({
  statusCode: 429,
  message: 'Rate limit reached',
  responseBody: JSON.stringify({ error: { message: 'request id req_XTPDY99 throttled, retry in 2s' } }),
});
check('"XTPDY" inside an id does not count as TPD', classifyRateLimit(idLooksLikeTPD) === 'per-minute', classifyRateLimit(idLooksLikeTPD));

check('hyphenated "per-day" is matched', classifyRateLimit(apiError({ statusCode: 429, message: 'per-day limit reached' })) === 'daily');
check('case is ignored', classifyRateLimit(apiError({ statusCode: 429, message: 'TOKENS PER DAY exceeded' })) === 'daily');
check('isRateLimit still recognises a 429 without a body', isRateLimit(apiError({ statusCode: 429, message: '' })) === true);
check('isRateLimit rejects a 500', isRateLimit(apiError({ statusCode: 500, message: 'boom' })) === false);

/* -------------------------------------------------------------------- */
console.log(`\n${failed === 0 ? 'all rate-limit classifier rules verified' : `${failed} FAILING CHECK(S)`}`);
process.exit(failed === 0 ? 0 : 1);
