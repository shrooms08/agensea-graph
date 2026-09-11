/**
 * Unit tests for the Scout flag rules (lib/scout/analysis.ts).
 *
 * These are the rules that decide whether an agent reads as trustworthy, so
 * each one is tested at its boundary as well as in the obvious case — ">50%"
 * and ">5" and ">0.7" are strict, and a rule that silently became >= would
 * change verdicts on real agents.
 *
 * analysis.ts is imported directly: it holds no runtime imports (only `import
 * type`), so Node 24's type stripping loads the .ts file as-is. No build step,
 * no mock of the subgraph.
 *
 *   node tests/scout-analysis.test.mjs      (run by: npm test)
 */
import {
  burstiness,
  computeTrustSignals,
  feedbackByTag,
  nameLookalike,
} from '../lib/scout/analysis.ts';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
};

const DAY = 86_400;
const T0 = 1_780_000_000;

/** Minimal Feedback row. Only the fields analysis.ts reads. */
const fb = ({ client = '0xaaa', value = 100, tag1 = 'uptime', at = T0, revoked = false }) => ({
  id: `${client}:${at}:${value}`,
  clientAddress: client,
  feedbackIndex: '1',
  value: String(value),
  tag1,
  tag2: null,
  endpoint: null,
  feedbackURI: null,
  feedbackURIType: null,
  feedbackHash: null,
  isRevoked: revoked,
  createdAt: String(at),
  revokedAt: null,
  feedbackFile: null,
});

/** Minimal AgentTrustProfile. */
const profile = ({ reg = {}, feedback = [], totalFeedback = feedback.length, agent = {} } = {}) => ({
  chainId: 56,
  id: '56:1',
  agent: {
    id: '56:1',
    chainId: '56',
    agentId: '1',
    agentURI: null,
    agentURIType: null,
    owner: '0xowner',
    agentWallet: null,
    operators: [],
    createdAt: String(T0 - 30 * DAY),
    updatedAt: String(T0),
    registrationFile: null,
    totalFeedback: String(totalFeedback),
    lastActivity: String(T0),
    ...agent,
  },
  registrationFile:
    reg === null
      ? null
      : {
          id: 'r1', cid: 'c1', agentId: '1',
          name: 'Test Agent', description: 'does things', image: null,
          active: true, x402Support: null, supportedTrusts: [],
          endpointsRawJson: null,
          mcpEndpoint: null, mcpVersion: null,
          a2aEndpoint: 'https://example.com/a2a', a2aVersion: null,
          webEndpoint: null, oasfEndpoint: null, oasfVersion: null,
          oasfSkills: [], oasfDomains: [], hasOASF: false,
          emailEndpoint: null, ens: null, did: null,
          mcpTools: [], mcpPrompts: [], mcpResources: [], a2aSkills: [],
          createdAt: String(T0 - 30 * DAY),
          ...reg,
        },
  feedback,
  validations: [],
  feedbackStats: null,
  validationStats: null,
});

const signals = (args) =>
  computeTrustSignals({ hasValidationRegistry: true, nowSeconds: T0, ...args });
const codes = (s) => s.flags.map((f) => f.code);

/* -------------------------------------------------------------------- */
console.log('\n-- SINGLE_CLIENT_DOMINANCE (strict >50%) --');

// 3 of 5 = 60% -> fires
check(
  'fires when one client wrote 60% of reviews',
  codes(
    signals({
      profile: profile({
        feedback: [
          fb({ client: '0xa' }), fb({ client: '0xa' }), fb({ client: '0xa' }),
          fb({ client: '0xb' }), fb({ client: '0xc' }),
        ],
      }),
    }),
  ).includes('SINGLE_CLIENT_DOMINANCE'),
);

// exactly 50% must NOT fire — the rule is "more than 50%"
check(
  'does not fire at exactly 50%',
  !codes(
    signals({
      profile: profile({
        feedback: [fb({ client: '0xa' }), fb({ client: '0xa' }), fb({ client: '0xb' }), fb({ client: '0xc' })],
      }),
    }),
  ).includes('SINGLE_CLIENT_DOMINANCE'),
);

check(
  'address comparison is case-insensitive (0xAA and 0xaa are one client)',
  signals({
    profile: profile({ feedback: [fb({ client: '0xAA' }), fb({ client: '0xaa' })] }),
  }).distinctClients === 1,
);

/* -------------------------------------------------------------------- */
console.log('\n-- HIGH_CONCENTRATION (strict ratio > 5) --');

// 12 reviews / 2 clients = 6.0 -> fires
check(
  'fires at ratio 6',
  codes(
    signals({
      profile: profile({
        feedback: Array.from({ length: 12 }, (_, i) =>
          fb({ client: i < 6 ? '0xa' : '0xb', at: T0 - i * 5 * DAY }),
        ),
      }),
    }),
  ).includes('HIGH_CONCENTRATION'),
);

// 10 reviews / 2 clients = exactly 5.0 -> must not fire
check(
  'does not fire at exactly ratio 5',
  !codes(
    signals({
      profile: profile({
        feedback: Array.from({ length: 10 }, (_, i) =>
          fb({ client: i < 5 ? '0xa' : '0xb', at: T0 - i * 5 * DAY }),
        ),
      }),
    }),
  ).includes('HIGH_CONCENTRATION'),
);

/* -------------------------------------------------------------------- */
console.log('\n-- BURST (burstiness > 0.7 AND >= 10 reviews) --');

// 10 reviews all within one hour -> burstiness 1.0
const tenInAnHour = Array.from({ length: 10 }, (_, i) =>
  fb({ client: `0x${i}`, at: T0 + i * 60 }),
);
check('fires: 10 reviews inside one hour', codes(signals({ profile: profile({ feedback: tenInAnHour }) })).includes('BURST'));

// same burst shape but only 9 reviews -> below the count threshold
check(
  'does not fire below 10 reviews even at burstiness 1.0',
  !codes(signals({ profile: profile({ feedback: tenInAnHour.slice(0, 9) }) })).includes('BURST'),
);

// 10 reviews spread one per week -> burstiness 0.1
check(
  'does not fire when reviews are spread weekly',
  !codes(
    signals({
      profile: profile({
        feedback: Array.from({ length: 10 }, (_, i) => fb({ client: `0x${i}`, at: T0 + i * 7 * DAY })),
      }),
    }),
  ).includes('BURST'),
);

check('burstiness of an empty list is 0', burstiness([]) === 0);
check('burstiness of a single review is 1', burstiness([fb({})]) === 1);
check(
  'sliding window catches a burst straddling a calendar boundary',
  // 8 reviews spanning 23h, crossing midnight; calendar bucketing would split these
  burstiness(Array.from({ length: 8 }, (_, i) => fb({ at: T0 + i * 3 * 3600 }))) === 1,
);
check(
  'window is half-open: reviews exactly 24h apart are not the same window',
  burstiness([fb({ at: T0 }), fb({ at: T0 + DAY })]) === 0.5,
);

/* -------------------------------------------------------------------- */
console.log('\n-- NO_METADATA / NO_ENDPOINTS --');

const noReg = signals({ profile: profile({ reg: null }) });
check('NO_METADATA fires when registrationFile is null', codes(noReg).includes('NO_METADATA'));
check('NO_ENDPOINTS also fires when there is no registration file', codes(noReg).includes('NO_ENDPOINTS'));

check(
  'NO_ENDPOINTS fires when every endpoint field is null',
  codes(signals({ profile: profile({ reg: { a2aEndpoint: null } }) })).includes('NO_ENDPOINTS'),
);
check(
  'NO_ENDPOINTS does not fire when an a2a endpoint is present',
  !codes(signals({ profile: profile({}) })).includes('NO_ENDPOINTS'),
);
check(
  'an empty-string endpoint counts as absent',
  codes(signals({ profile: profile({ reg: { a2aEndpoint: '   ' } }) })).includes('NO_ENDPOINTS'),
);

/* -------------------------------------------------------------------- */
console.log('\n-- VALIDATION_UNAVAILABLE --');

check(
  'fires when the chain has no validation registry',
  computeTrustSignals({
    profile: profile({}),
    hasValidationRegistry: false,
    nowSeconds: T0,
  }).flags.map((f) => f.code).includes('VALIDATION_UNAVAILABLE'),
);
check(
  'does not fire when a validation registry exists',
  !codes(signals({ profile: profile({}) })).includes('VALIDATION_UNAVAILABLE'),
);

/* -------------------------------------------------------------------- */
console.log('\n-- NAME_LOOKALIKE (heuristic) --');

check('matches an @handle', nameLookalike('@binance · Ensoul') === 'binance');
check('matches a bare brand word', nameLookalike('Binance Assistant') === 'binance');
check('is case-insensitive', nameLookalike('@ElonMusk · Ensoul') === 'elonmusk');
check('does not match a substring inside a longer word', nameLookalike('Gateway Monitor') === null);
check('returns null for an ordinary name', nameLookalike('Venus Health Factor Monitor') === null);
check('returns null for a null name', nameLookalike(null) === null);
check(
  'the flag is marked heuristic',
  signals({ profile: profile({ reg: { name: '@binance · Ensoul' } }) }).flags.find(
    (f) => f.code === 'NAME_LOOKALIKE',
  )?.heuristic === true,
);
check(
  'measured flags are not marked heuristic',
  signals({ profile: profile({ reg: null }) }).flags.find((f) => f.code === 'NO_METADATA')
    ?.heuristic === false,
);

/* -------------------------------------------------------------------- */
console.log('\n-- feedbackByTag never averages across tags --');

const mixed = [
  fb({ tag1: 'uptime', value: 100, client: '0xa' }),
  fb({ tag1: 'uptime', value: 90, client: '0xb' }),
  fb({ tag1: 'responseTime', value: 236, client: '0xc' }),
];
const byTag = feedbackByTag(mixed);
check('groups into one row per tag', byTag.length === 2, `got ${byTag.length}`);
const uptime = byTag.find((t) => t.tag === 'uptime');
const rt = byTag.find((t) => t.tag === 'responseTime');
check('uptime mean is 95, not polluted by the 236ms row', uptime.mean === 95, `got ${uptime.mean}`);
check('uptime min/max are 90/100', uptime.min === 90 && uptime.max === 100);
check('responseTime stays its own group', rt.count === 1 && rt.mean === 236);
check(
  'TrustSignals exposes no cross-tag mean',
  !('mean' in signals({ profile: profile({ feedback: mixed }) })),
);

check(
  'revoked feedback is excluded from tag stats',
  feedbackByTag([fb({ value: 10 }), fb({ value: 90, revoked: true })])[0].mean === 10,
);
check(
  'null tag1 is grouped as (untagged) rather than dropped',
  feedbackByTag([fb({ tag1: null, value: 5 })])[0].tag === '(untagged)',
);

/* -------------------------------------------------------------------- */
console.log('\n-- liveness --');

const live = signals({ profile: profile({}) });
check('registration age is computed in whole days', live.liveness.registrationAgeDays === 30);
check('endpoints are extracted with their kind', live.liveness.endpoints[0].kind === 'a2a');
check(
  'reportedTotalFeedback comes from the chain, not the fetched page',
  signals({ profile: profile({ feedback: [fb({})], totalFeedback: 234 }) }).reportedTotalFeedback === 234,
);

/* -------------------------------------------------------------------- */
console.log(
  `\n${failed === 0 ? 'all scout analysis rules verified' : `${failed} FAILING CHECK(S)`}`,
);
process.exit(failed === 0 ? 0 : 1);
