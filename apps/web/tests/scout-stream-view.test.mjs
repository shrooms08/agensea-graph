/**
 * Mocked-stream tests for what /scout actually renders (lib/scout/stream-view.ts).
 *
 * These reproduce the production bug directly: a stream carrying two
 * emit_verdict calls for the same agent must render ONE card, and two separate
 * answers must not pile up on top of each other.
 *
 * The message shapes below are synthetic — hand-built to match the part types
 * the AI SDK emits (`text`, `data-evidence`, `data-model`,
 * `tool-emit_verdict` with state `output-available`) — so no model is called.
 *
 *   node tests/scout-stream-view.test.mjs      (run by: npm test)
 */
import {
  projectLatestAnswer,
  projectMessage,
  verdictKey,
} from '../lib/scout/stream-view.ts';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : ` — ${detail}`}`);
};

/** A recorded emit_verdict tool part, as the server streams it. */
const verdictPart = ({ agentId, chainId = 56, name = 'Agent', recorded = true }) => ({
  type: 'tool-emit_verdict',
  state: 'output-available',
  output: {
    recorded,
    agentId,
    chainId,
    name,
    liveness: 'has metadata',
    reputationSummary: 'uptime mean 97',
    flags: ['HIGH_CONCENTRATION'],
    recommendation: 'caution',
    confidence: 'medium',
    reasoning: 'concentrated reviewers',
  },
});

const textPart = (text) => ({ type: 'text', text });
const msg = (parts, role = 'assistant') => ({ role, parts });

/* -------------------------------------------------------------------- */
console.log('\n-- one card per agent, whatever the stream contains --');

// The exact production symptom: the model emitted twice and the server guard
// did not catch it (both marked recorded:true).
const twoSameAgent = projectMessage(
  msg([
    verdictPart({ agentId: '56:30867', name: '@btcdayu · Ensoul' }),
    textPart('Looking at the reviewer spread.'),
    verdictPart({ agentId: '56:30867', name: '@btcdayu · Ensoul' }),
  ]),
);
check(
  'two emit_verdict calls for the same agent render ONE card',
  twoSameAgent.verdicts.length === 1,
  `got ${twoSameAgent.verdicts.length}`,
);

check(
  'the surviving card is the first one emitted',
  twoSameAgent.verdicts[0].agentId === '56:30867',
);

// The server's own guard marks a repeat recorded:false. That rejection is
// carried on the streamed tool output, so the client must honour it.
const guarded = projectMessage(
  msg([
    verdictPart({ agentId: '56:30867' }),
    verdictPart({ agentId: '56:30867', recorded: false }),
  ]),
);
check(
  "server guard's recorded:false is honoured by the renderer",
  guarded.verdicts.length === 1,
  `got ${guarded.verdicts.length}`,
);

check(
  'a verdict that is only recorded:false renders no card at all',
  projectMessage(msg([verdictPart({ agentId: '56:1', recorded: false })])).verdicts.length === 0,
);

// "30867" and "56:30867" are the same agent spelled two ways.
const mixedSpelling = projectMessage(
  msg([
    verdictPart({ agentId: '56:30867' }),
    verdictPart({ agentId: '30867', chainId: 56 }),
  ]),
);
check(
  'bare and composite ids for one agent collapse to one card',
  mixedSpelling.verdicts.length === 1,
  `got ${mixedSpelling.verdicts.length}`,
);

check(
  'two DIFFERENT agents still render two cards',
  projectMessage(
    msg([verdictPart({ agentId: '56:30867' }), verdictPart({ agentId: '56:265876' })]),
  ).verdicts.length === 2,
);

check('verdictKey normalises a bare id using chainId', verdictKey({ agentId: '30867', chainId: 56 }) === '56:30867');
check('verdictKey leaves a composite id alone', verdictKey({ agentId: '56:30867' }) === '56:30867');
check('verdictKey is case-insensitive', verdictKey({ agentId: '56:ABC' }) === '56:abc');

/* -------------------------------------------------------------------- */
console.log('\n-- single-answer view: replace, never append --');

// Two submissions in one session. Only the newest answer may render.
const twoAnswers = [
  msg([textPart('First answer.')], 'user'),
  msg([verdictPart({ agentId: '56:30867' }), textPart('First answer.')]),
  msg([textPart('Second question.')], 'user'),
  msg([verdictPart({ agentId: '56:30867' }), textPart('Second answer.')]),
];
const latest = projectLatestAnswer(twoAnswers);
check('only the newest assistant message is projected', latest.answer === 'Second answer.', `got "${latest.answer}"`);
check('the previous answer contributes no extra card', latest.verdicts.length === 1, `got ${latest.verdicts.length}`);
check('no assistant message yields an empty view', projectLatestAnswer([]).answer === '' && projectLatestAnswer([]).verdicts.length === 0);

/* -------------------------------------------------------------------- */
console.log('\n-- text parts must not fuse --');

// The bug: `answer += part.text` ran the last word of one block into the first
// word of the next.
const twoBlocks = projectMessage(msg([textPart('...few independent reviewers.'), textPart('Recommendation: caution.')]));
check(
  'separate text parts are separated, not concatenated bare',
  !twoBlocks.answer.includes('reviewers.Recommendation'),
  `got "${twoBlocks.answer}"`,
);
check('they are joined as paragraphs', twoBlocks.answer === '...few independent reviewers.\n\nRecommendation: caution.');
check('a single text part is unchanged', projectMessage(msg([textPart('Just one.')])).answer === 'Just one.');
check('whitespace-only parts are dropped', projectMessage(msg([textPart('A.'), textPart('   '), textPart('B.')])).answer === 'A.\n\nB.');

/* -------------------------------------------------------------------- */
console.log('\n-- evidence and model --');

const withMeta = projectMessage(
  msg([
    { type: 'data-model', data: { id: 'openai/gpt-oss-120b' } },
    { type: 'data-evidence', data: { toolCallId: 'c1', toolName: 'get_trust_profile', cached: false, queries: [{ seq: 1, subgraphId: 'D6aW', query: '{ agent }', variables: {}, rowCount: 22, ms: 800, ok: true }] } },
    { type: 'data-evidence', data: { toolCallId: 'c2', toolName: 'get_chain_adoption', cached: true, queries: [] } },
  ]),
);
check('model id is taken from the data-model part', withMeta.model === 'openai/gpt-oss-120b');
check('every evidence part is collected', withMeta.evidence.length === 2);
check('a cached tool reports no queries', withMeta.evidence[1].cached === true && withMeta.evidence[1].queries.length === 0);
check('an in-progress verdict (no output yet) renders nothing', projectMessage(msg([{ type: 'tool-emit_verdict', state: 'input-available' }])).verdicts.length === 0);

/* -------------------------------------------------------------------- */
console.log(`\n${failed === 0 ? 'all scout stream-view rules verified' : `${failed} FAILING CHECK(S)`}`);
process.exit(failed === 0 ? 0 : 1);
