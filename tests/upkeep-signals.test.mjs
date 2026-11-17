// Knowledge upkeep, slice 1: the deterministic lesson signals (design 10.1) and the class keys
// (4.2). Everything is fictional. Nothing here calls a model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, until } from './helpers.mjs';
import { replanFlow } from '../starter/factory/core/project.mjs';
import { retrospective, recordRetrospective } from '../starter/factory/operations/governance.mjs';
import { LESSON_SIGNAL_KINDS, MAX_LESSON_SIGNALS, hasVerifiedCorrection, lessonSignals } from '../starter/factory/operations/lesson-signals.mjs';
import { CAPTURE_TOPICS, anchorDirectories, captureClassKey, classKey, collapseWhitespace, quoteClassKey, staleLearningClassKey } from '../starter/factory/operations/upkeep-class-key.mjs';

// A flow with the steps of the change reference that signals are read from.
const NODES = Object.fromEntries([['plan', 'provider.plan'], ['plan-review', 'provider.planReview'], ['build', 'provider.build'], ['fast-check', 'fastCheck'], ['review', 'provider.review'], ['delta-review', 'provider.review'], ['gate', 'gate']].map(([step, operation]) => [step, { kind: 'effect', action: { operation } }]));
const flowOf = (extra = {}) => ({ id: 'flow-1', taskId: 'task-1', kind: 'change', state: 'completed', workflow: { nodes: NODES }, results: {}, ...extra });
const attempt = (id, step, route, extra = {}) => ({ id, flowId: 'flow-1', step, status: 'passed', settledAt: '2026-11-16T10:00:00.000Z', receipt: { actionResult: { route } }, ...extra });
const failed = (id, step, checks) => attempt(id, step, 'fail', { outcome: 'failed', ...(checks ? { failedChecks: checks.map(check => ({ id: check, status: 'failed' })) } : {}) });
const round = (attemptId, disposition, verdict, findings = [], priorFindingsDisposition) => ({ attemptId, step: 'review', phase: 'full', disposition, result: { verdict, findings: findings.map(message => ({ message, severity: 'medium' })), ...(priorFindingsDisposition ? { priorFindingsDisposition } : {}) } });
const kinds = result => result.signals.map(row => [row.kind, row.class]);
const signals = input => lessonSignals({ attempts: [], pushback: [], ...input });

test('every signal kind has a class, and the verified ones are the three corrections something else attested', () => {
  assert.deepEqual(Object.entries(LESSON_SIGNAL_KINDS).filter(([, kind]) => kind === 'verified').map(([name]) => name), ['review-correction', 'fast-check-correction', 'gate-correction']);
  assert.deepEqual(Object.entries(LESSON_SIGNAL_KINDS).filter(([, kind]) => kind === 'weak').map(([name]) => name), ['review-correction-inferred', 'plan-send-back', 'person-replan', 'operator-note', 'rule-pushback', 'plan-departure', 'unverified-acceptance', 'unchanged-candidate', 'review-deferral', 'fix-churn'], 'the two weak kinds of a must-fix flow (review-must-fix design 12.1) are weak');
});

test('a clean flow produces no signal', () => {
  const clean = flowOf({ reviewHistory: [round('review-1', 'accepted', 'pass')], workerReports: [{ attemptId: 'build-1', step: 'build', binding: 'build', departures: [], unverified: [], questions: [], assumptions: [] }], operatorFeedback: [] });
  const attempts = [attempt('plan-1', 'plan', 'ready'), attempt('plan-review-1', 'plan-review', 'pass'), attempt('build-1', 'build', 'implemented'), attempt('fast-1', 'fast-check', 'pass'), attempt('review-1', 'review', 'pass'), attempt('gate-1', 'gate', 'pass')];
  assert.deepEqual(lessonSignals({ flow: clean, attempts, pushback: [] }), { signals: [], omitted: 0 });
  assert.deepEqual(signals({ flow: flowOf() }), { signals: [], omitted: 0 });
  assert.deepEqual(signals({ flow: { id: 'bare' } }), { signals: [], omitted: 0 }, 'a flow record without any of the fields');
});

test('a review sent the change back and a later review marked the finding fixed: one verified correction per finding', () => {
  const history = [round('review-1', 'correct', 'revise', ['Missing null check in parse()', 'Docs name the old flag']), round('review-2', 'accepted', 'pass', [], [{ finding: 'Missing null check in parse()', disposition: 'fixed', evidence: 'Guarded at src/parse.js:12' }, { finding: 'Docs name the old flag', disposition: 'fixed', evidence: 'README now says --mode' }])];
  const result = signals({ flow: flowOf({ reviewHistory: history }) });
  assert.deepEqual(kinds(result), [['review-correction', 'verified'], ['review-correction', 'verified']]);
  assert.deepEqual(result.signals.map(({ id, finding, ...rest }) => rest), [
    { kind: 'review-correction', class: 'verified', attemptId: 'review-1', step: 'review', severity: 'medium', message: 'Missing null check in parse()', fixedBy: 'review-2', evidence: 'Guarded at src/parse.js:12' },
    { kind: 'review-correction', class: 'verified', attemptId: 'review-1', step: 'review', severity: 'medium', message: 'Docs name the old flag', fixedBy: 'review-2', evidence: 'README now says --mode' },
  ]);
  assert.equal(hasVerifiedCorrection(result.signals), true);
  // Not a verified correction: still open, out of scope, or "fixed" without evidence.
  for (const entry of [{ disposition: 'remaining', evidence: 'Still there' }, { disposition: 'outside-scope', evidence: 'Another task' }, { disposition: 'fixed', evidence: '   ' }, { disposition: 'fixed' }]) {
    const other = [round('review-1', 'correct', 'revise', ['Missing null check in parse()']), round('review-2', 'accepted', 'pass', [], [{ finding: 'Missing null check in parse()', ...entry }])];
    assert.deepEqual(signals({ flow: flowOf({ reviewHistory: other }) }).signals, [], JSON.stringify(entry));
  }
  // A send-back with no later review, a pass, and findings deferred as follow-ups are not corrections.
  assert.deepEqual(signals({ flow: flowOf({ reviewHistory: [round('review-1', 'correct', 'revise', ['Unreviewed fix'])] }) }).signals, []);
  assert.deepEqual(signals({ flow: flowOf({ reviewHistory: [round('review-1', 'followup-required', 'pass', ['A low finding']), round('review-2', 'accepted', 'pass')] }) }).signals, []);
});

test('where no disposition was required, a finding absent from the passing round is inferred and weak', () => {
  const history = [round('review-1', 'correct', 'revise', ['Missing null check in parse()']), round('review-2', 'correct', 'revise', ['Another problem']), round('review-3', 'accepted', 'pass')];
  const result = signals({ flow: flowOf({ reviewHistory: history }) });
  assert.deepEqual(kinds(result), [['review-correction-inferred', 'weak'], ['review-correction-inferred', 'weak']]);
  assert.deepEqual(result.signals.map(row => [row.attemptId, row.absentFrom]), [['review-1', 'review-3'], ['review-2', 'review-3']]);
  assert.equal(hasVerifiedCorrection(result.signals), false);
  // Still present in the passing round: nothing can be inferred. Recorded before dispositions existed: the verdict decides.
  assert.deepEqual(signals({ flow: flowOf({ reviewHistory: [round('review-1', 'correct', 'revise', ['Persistent']), round('review-2', 'followup-required', 'pass', ['Persistent'])] }) }).signals, []);
  const legacy = [{ attemptId: 'review-1', step: 'review', result: { verdict: 'revise', findings: [{ message: 'Old-format finding' }] } }, { attemptId: 'review-2', step: 'review', result: { verdict: 'pass', findings: [] } }];
  assert.deepEqual(kinds(signals({ flow: flowOf({ reviewHistory: legacy }) })), [['review-correction-inferred', 'weak']]);
});

test('a fast check failed and later passed on the same flow: one verified correction per failed check', () => {
  const attempts = [failed('fast-1', 'fast-check', ['lint', 'types']), attempt('build-2', 'build', 'implemented'), attempt('fast-2', 'fast-check', 'pass')];
  const result = lessonSignals({ flow: flowOf(), attempts, pushback: [] });
  assert.deepEqual(result.signals.map(({ id, ...rest }) => rest), [
    { kind: 'fast-check-correction', class: 'verified', attemptId: 'fast-1', checkId: 'lint', step: 'fast-check', passedBy: 'fast-2' },
    { kind: 'fast-check-correction', class: 'verified', attemptId: 'fast-1', checkId: 'types', step: 'fast-check', passedBy: 'fast-2' },
  ]);
  // Failed and never passed afterwards; a pass before the failure; an attempt that itself failed to run.
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts: [failed('fast-1', 'fast-check', ['lint'])], pushback: [] }).signals, []);
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts: [attempt('fast-0', 'fast-check', 'pass'), failed('fast-1', 'fast-check', ['lint'])], pushback: [] }).signals, []);
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts: [{ ...attempt('fast-1', 'fast-check', 'fail'), status: 'failed' }, attempt('fast-2', 'fast-check', 'pass')], pushback: [] }).signals, []);
  // An attempt settled before the routed outcome was recorded is read from its receipt.
  const old = [attempt('fast-1', 'fast-check', 'fail', { receipt: { actionResult: { route: 'fail', checks: [{ id: 'lint', status: 'failed' }, { id: 'unit', status: 'passed' }] } } }), attempt('fast-2', 'fast-check', 'pass')];
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts: old, pushback: [] }).signals.map(row => [row.kind, row.checkId]), [['fast-check-correction', 'lint']]);
  // The operation comes from the flow's own workflow, not the step's name: a project graph may name its step differently.
  const custom = flowOf({ workflow: { nodes: { 'quick-verify': { kind: 'effect', action: { operation: 'fastCheck' } } } } });
  assert.deepEqual(kinds(lessonSignals({ flow: custom, attempts: [failed('q-1', 'quick-verify', ['lint']), attempt('q-2', 'quick-verify', 'pass')], pushback: [] })), [['fast-check-correction', 'verified']]);
});

test('the gate failed and later passed: verified; a gate that could not run is not a correction', () => {
  const attempts = [failed('gate-1', 'gate', ['unit']), attempt('build-2', 'build', 'implemented'), attempt('gate-2', 'gate', 'pass')];
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts, pushback: [] }).signals.map(({ id, ...rest }) => rest), [{ kind: 'gate-correction', class: 'verified', attemptId: 'gate-1', checkId: 'unit', step: 'gate', passedBy: 'gate-2' }]);
  // No check rows on record: one signal for the run.
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts: [failed('gate-1', 'gate'), attempt('gate-2', 'gate', 'pass')], pushback: [] }).signals.map(row => [row.kind, row.checkId]), [['gate-correction', null]]);
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts: [attempt('gate-1', 'gate', 'blocked'), attempt('gate-2', 'gate', 'pass')], pushback: [] }).signals, []);
  // A failed fast check is not passed by a gate, nor the reverse.
  assert.deepEqual(lessonSignals({ flow: flowOf(), attempts: [failed('fast-1', 'fast-check', ['lint']), attempt('gate-1', 'gate', 'pass')], pushback: [] }).signals, []);
});

test('each weak signal, exactly and with the weak class', () => {
  const cases = [
    ['plan-send-back', { attempts: [attempt('plan-review-1', 'plan-review', 'revise'), attempt('plan-review-2', 'plan-review', 'pass')] }],
    ['person-replan', { flow: flowOf({ operatorFeedback: [{ step: 'plan-question', answer: 'replan', note: 'Use the existing parser', actor: 'operator', at: '2026-11-16T10:00:00.000Z' }] }) }],
    ['person-replan', { flow: flowOf({ operatorFeedback: [{ step: 'build', answer: 'replan', note: 'On the operator\'s instruction', actor: 'orchestrator', onBehalfOf: { instruction: 'x' }, at: '2026-11-16T10:00:00.000Z' }] }) }],
    ['operator-note', { flow: flowOf({ operatorFeedback: [{ step: 'build', answer: 'note', note: 'Mind the migration', actor: 'operator', at: '2026-11-16T10:00:00.000Z' }] }) }],
    ['operator-note', { flow: flowOf({ operatorFeedback: [{ inboxId: 'q1', step: 'build-question', answer: 'retry', note: 'Try again with the fixture', actor: 'operator', at: '2026-11-16T10:00:00.000Z' }] }) }],
    ['rule-pushback', { pushback: [{ id: 'pushback-1', flowId: 'flow-1', ruleId: 'tests-first', reason: 'Cost', evidence: '{}', actor: 'builder', status: 'proposed' }] }],
    ['plan-departure', { flow: flowOf({ workerReports: [{ attemptId: 'build-1', step: 'build', binding: 'build', departures: [{ from: 'Planned a new module', why: 'An existing one fits' }], unverified: [] }] }) }],
    ['unverified-acceptance', { flow: flowOf({ workerReports: [{ attemptId: 'build-1', step: 'build', binding: 'build', departures: [], unverified: ['Works on Windows'] }] }) }],
    ['unchanged-candidate', { attempts: [attempt('build-2', 'build', 'implemented', { reason: 'unchanged candidate after review required revision' })] }],
    ['unchanged-candidate', { attempts: [attempt('build-2', 'build', 'implemented', { reason: 'unchanged candidate after fast checks failed' })] }],
  ];
  for (const [kind, input] of cases) {
    const result = lessonSignals({ flow: flowOf(), attempts: [], pushback: [], ...input });
    assert.deepEqual(kinds(result), [[kind, 'weak']], kind); assert.equal(hasVerifiedCorrection(result.signals), false);
    assert.match(result.signals[0].id, /^[a-f0-9]{64}$/);
  }
  // One report with both gives both, in that order.
  const both = flowOf({ workerReports: [{ attemptId: 'build-1', step: 'build', binding: 'build', departures: [{ from: 'a', why: 'b' }], unverified: ['c'] }] });
  assert.deepEqual(kinds(signals({ flow: both })), [['plan-departure', 'weak'], ['unverified-acceptance', 'weak']]);
});

test('an automatic target-follow replan is not a signal; a person\'s replan is', t => {
  // The entry the factory records when the target moved under the planned paths (workflows/actions.mjs followTarget).
  const automatic = { step: 'build', answer: 'replan', note: 'Main moved and changed planned paths: src/parse.js', actor: 'factory', at: '2026-11-16T10:00:00.000Z' };
  assert.deepEqual(signals({ flow: flowOf({ operatorFeedback: [automatic, automatic] }) }), { signals: [], omitted: 0 });
  // Through the factory's own replan: the flow record the retrospective reads.
  const f = sandbox(t), planFlow = { id: 'flow-plan', taskId: 'task-1', kind: 'change', state: 'ready', step: 'build', transitions: 3, visits: { plan: 1, build: 1 }, results: {}, evidence: {}, sessions: {}, workflow: { version: 1, start: 'plan', maxTransitions: 50, nodes: { plan: { kind: 'effect', action: { operation: 'provider.plan' }, next: 'build', maxVisits: 3 }, build: { kind: 'effect', action: { operation: 'provider.build' }, next: 'done' }, done: { kind: 'end', outcome: 'completed' } } } };
  f.store.tx(() => { f.store.put('flow', planFlow); replanFlow(f.store, f.store.need('flow', 'flow-plan'), { note: 'Main moved and changed planned paths: src/parse.js', by: 'factory', reason: 'target-changed-planned-paths' }); });
  assert.equal(f.store.need('flow', 'flow-plan').operatorFeedback[0].actor, 'factory');
  assert.deepEqual(retrospective(f.store, { flowId: 'flow-plan' }).lessonSignals, []);
  f.store.tx(() => { const flow = f.store.need('flow', 'flow-plan'); flow.step = 'build'; replanFlow(f.store, flow, { note: 'Plan around the new parser', by: 'operator' }); });
  assert.deepEqual(retrospective(f.store, { flowId: 'flow-plan' }).lessonSignals.map(row => [row.kind, row.class, row.actor]), [['person-replan', 'weak', 'operator']]);
});

test('the list is bounded, verified corrections first, and says what it left out', () => {
  const notes = Array.from({ length: 60 }, (_, index) => ({ step: 'build', answer: 'note', note: `Fictional note ${index}`, actor: 'operator', at: `2026-11-16T10:00:${String(index).padStart(2, '0')}.000Z` }));
  const attempts = [failed('gate-1', 'gate', ['unit']), attempt('gate-2', 'gate', 'pass')];
  const result = lessonSignals({ flow: flowOf({ operatorFeedback: notes }), attempts, pushback: [] });
  assert.equal(result.signals.length, MAX_LESSON_SIGNALS); assert.equal(result.omitted, 21); assert.equal(result.signals[0].kind, 'gate-correction');
  // Text copied from records is collapsed and cut.
  const long = signals({ flow: flowOf({ operatorFeedback: [{ step: 'build', answer: 'note', note: `${'word  \n'.repeat(200)}`, actor: 'operator', at: 'x' }] }) }).signals[0];
  assert.equal(long.note.length, 300); assert.doesNotMatch(long.note, /\s\s|\n/);
});

test('the retrospective carries the signals, and they do not depend on its event sample', async t => {
  const f = sandbox(t);
  assert.equal(f.start().status, 'completed');
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  assert.deepEqual(f.store.need('retrospective', 'flow-1').lessonSignals, [], 'a clean rehearsal flow records an empty list');
  // The corrections on record: on the flow, on its attempts and in its pushback rows.
  f.store.tx(() => {
    const flow = f.store.need('flow', 'flow-1');
    flow.workflow = { ...flow.workflow, nodes: { ...flow.workflow.nodes, ...NODES } };
    flow.reviewHistory = [round('review-1', 'correct', 'revise', ['Missing null check in parse()']), round('review-2', 'accepted', 'pass', [], [{ finding: 'Missing null check in parse()', disposition: 'fixed', evidence: 'Guarded' }])];
    flow.operatorFeedback = [{ step: 'build', answer: 'note', note: 'Mind the migration', actor: 'operator', at: '2026-11-16T10:00:00.000Z' }];
    f.store.put('flow', flow);
    f.store.put('attempt', failed('fast-1', 'fast-check', ['lint'])); f.store.put('attempt', attempt('fast-2', 'fast-check', 'pass'));
    f.store.put('pushback', { id: 'pushback-1', flowId: 'flow-1', ruleId: 'tests-first', reason: 'Cost', evidence: '{}', actor: 'builder', status: 'proposed' });
  });
  const expected = [['review-correction', 'verified'], ['fast-check-correction', 'verified'], ['operator-note', 'weak'], ['rule-pushback', 'weak']];
  const first = retrospective(f.store, { flowId: 'flow-1' });
  assert.deepEqual(first.lessonSignals.map(row => [row.kind, row.class]), expected); assert.equal(first.lessonSignalsOmitted, undefined); assert.ok(first.events.length > 0);
  assert.deepEqual(recordRetrospective(f.store, { flowId: 'flow-1' }).lessonSignals, first.lessonSignals);
  // The flow's events pushed out of the latest 10,000 by later, unrelated ones: the sample is empty, the signals are the same.
  const insert = f.store.db.prepare('INSERT INTO events(at,type,payload) VALUES(?,?,?)'); f.store.db.exec('BEGIN'); for (let i = 0; i < 10050; i++) insert.run('2026-11-16T11:00:00.000Z', 'fictional.later', '{"flowId":"another-flow"}'); f.store.db.exec('COMMIT');
  const later = retrospective(f.store, { flowId: 'flow-1' });
  assert.equal(later.events.length, 0); assert.deepEqual(later.lessonSignals, first.lessonSignals);
  // And with no events at all.
  f.store.db.exec('DELETE FROM events'); assert.deepEqual(retrospective(f.store, { flowId: 'flow-1' }).lessonSignals, first.lessonSignals);
});

// ---- Class keys ----
const KEYS = {
  docs: ['quoteClassKey', { kind: 'docs', path: 'docs/guide.md', quote: 'Run  `tool --fast`\n to build.' }],
  context: ['quoteClassKey', { kind: 'context', path: 'docs/guide.md', quote: 'Run `tool --fast` to build.' }],
  check: ['captureClassKey', { form: 'check', anchor: 'lint', topic: 'style' }],
  rule: ['captureClassKey', { form: 'rule', anchor: 'project-governance', topic: 'procedure' }],
  learning: ['captureClassKey', { form: 'learning', anchor: 'src/api', topic: 'interface-use' }],
  stale: ['staleLearningClassKey', { learningId: 'api-pagination', condition: 'path-absent' }],
};
// Computed once and written down: a key is the same in every run and on every machine.
const PINNED = {
  docs: 'a1a05c2ba178bae05e2b29a35ea4fba5dda88a572ec07853dee727a026b937f9',
  context: 'd2bb4d9a86fab23798d7e8f0e4f53c395e62423146cd1b1840778c94dd82dc9e',
  check: '544a66a927c63be17549aebbe3b6208ffd09867225a1be067800680a0dd0ffe6',
  rule: '85d080ec54a38295ab060e3268eacdcb7791c64aa3f791034452b1a86df60428',
  learning: '611db08b25059a39fe189299c795711086d61c67fbe239d16eb882c8e726d486',
  stale: '7e94dc87c5f34a47b7c752da563e3d83b656d03e6c3ccd55e158b77fb8bb2456',
};
const api = { quoteClassKey, captureClassKey, staleLearningClassKey };
const compute = () => Object.fromEntries(Object.entries(KEYS).map(([name, [fn, input]]) => [name, api[fn](input)]));

test('class keys are stable: the same in this process, in another process, and as written down', () => {
  const here = compute();
  for (const value of Object.values(here)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(new Set(Object.values(here)).size, Object.keys(here).length, 'six different candidates, six different keys');
  assert.deepEqual(here, compute());
  const script = `import * as api from ${JSON.stringify(new URL('../starter/factory/operations/upkeep-class-key.mjs', import.meta.url).href)}; const keys = ${JSON.stringify(KEYS)}; console.log(JSON.stringify(Object.fromEntries(Object.entries(keys).map(([name, [fn, input]]) => [name, api[fn](input)]))));`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) })), here);
  assert.deepEqual(here, PINNED);
});

test('a quoted candidate\'s key: the kind, the resolved path and the quote after whitespace collapsing', () => {
  const base = { kind: 'docs', path: 'docs/guide.md', quote: 'Run `tool --fast` to build.' }, same = quoteClassKey(base);
  assert.equal(collapseWhitespace('  Run  `tool --fast`\n\tto   build. '), 'Run `tool --fast` to build.');
  for (const quote of ['Run  `tool --fast`\n to build.', '  Run `tool --fast` to build.\n', 'Run\t`tool --fast` to\r\nbuild.']) assert.equal(quoteClassKey({ ...base, quote }), same, JSON.stringify(quote));
  // Anything else is a different class: other words, another file, the other kind, another letter case of the path.
  for (const other of [{ ...base, quote: 'Run `tool --slow` to build.' }, { ...base, quote: 'run `tool --fast` to build.' }, { ...base, path: 'docs/other.md' }, { ...base, path: 'Docs/guide.md' }, { ...base, kind: 'context' }]) assert.notEqual(quoteClassKey(other), same, JSON.stringify(other));
  // The key takes a resolved repository path, and a quote that says something.
  for (const bad of [{ ...base, path: './docs/guide.md' }, { ...base, path: 'docs/../guide.md' }, { ...base, path: '/docs/guide.md' }, { ...base, path: 'docs//guide.md' }, { ...base, path: '' }, { ...base, quote: ' \n ' }, { ...base, quote: '' }, { ...base, kind: 'check' }, { ...base, kind: 'learning-stale' }]) assert.throws(() => quoteClassKey(bad), JSON.stringify(bad));
  assert.equal(classKey(base), same);
});

test('a capture candidate\'s key: the form, an anchor and a topic from the fixed list, and nothing a model phrases freely', () => {
  assert.deepEqual(CAPTURE_TOPICS, ['procedure', 'test', 'documentation', 'interface-use', 'build', 'data', 'style', 'other']);
  const base = { form: 'rule', anchor: 'src/api', topic: 'test' }, same = captureClassKey(base);
  // Deliberately coarse: two lessons about tests in one directory share a key, whatever else is said about them.
  assert.equal(captureClassKey({ ...base, title: 'Always paginate', description: 'A long free description' }), same);
  assert.equal(classKey({ kind: 'rule', anchor: 'src/api', topic: 'test', title: 'Another lesson about tests there' }), same);
  for (const other of [{ ...base, form: 'learning' }, { ...base, form: 'check' }, { ...base, anchor: 'src/cli' }, { ...base, topic: 'build' }]) assert.notEqual(captureClassKey(other), same, JSON.stringify(other));
  for (const bad of [{ ...base, topic: 'testing' }, { ...base, topic: 'Test' }, { ...base, form: 'docs' }, { ...base, anchor: '' }, { ...base, anchor: 7 }]) assert.throws(() => captureClassKey(bad), JSON.stringify(bad));
  // The anchor directories offered: the directories of the files the signals name, to a depth of two.
  assert.deepEqual(anchorDirectories(['src/api/v2/pages.js', 'src/api/index.js', 'src/cli.js', 'README.md', './docs/guide.md', '../outside/x.md']), ['docs', 'src', 'src/api']);
});

test('a stale learning\'s key: the learning id and the typed condition that fired', () => {
  const same = staleLearningClassKey({ learningId: 'api-pagination', condition: 'paths' });
  assert.equal(classKey({ kind: 'learning-stale', learningId: 'api-pagination', condition: 'paths' }), same);
  for (const other of [{ learningId: 'api-pagination', condition: 'unused' }, { learningId: 'cli-flags', condition: 'paths' }]) assert.notEqual(staleLearningClassKey(other), same);
  for (const bad of [{ learningId: 'api-pagination', condition: 'old' }, { learningId: '', condition: 'paths' }]) assert.throws(() => staleLearningClassKey(bad));
  assert.throws(() => classKey({ kind: 'audit' }), /no class key is defined/); assert.throws(() => classKey(undefined), /no class key is defined/);
});
