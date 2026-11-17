// Must-fix review, slice 2 (docs/designs/review-must-fix.md 15): the purpose block and assessment,
// purpose synthesis, the fail-closed protocol checks of 5.4 with one correction review, the
// plan-review protocol-failure stop of 6.4, and shadow route v2. A flow pinned to `must-fix` exists
// only in fixtures here: configuration validation still refuses the setting (review-must-fix.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { purposeOf } from './review-bar-scenarios.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { pinnedReviewSettings } from '../starter/factory/core/review-bar.mjs';
import { protocolContradictions, purposeBlock, purposeSummary, shadowRouteV1, shadowRouteV2, SHADOW_V2_OMITS } from '../starter/factory/workflows/must-fix.mjs';

const ACCEPTANCE = ['Observed fixture behavior', 'The reader reports a missing file'];
const pinnedPolicy = pinnedReviewSettings({ policy: { reviewBar: 'shadow' } }).reviewPolicy;
const ordinary = { level: 'ordinary', rationale: 'Bounded fictional change', threatModel: [], stopConditions: [] };
const strictAssessment = { level: 'strict', rationale: 'Fictional saved records', threatModel: ['Loss of fictional records'], stopConditions: ['Halt when integrity is unproven'] };
const finding = (purposeImpact, status, extra = {}) => ({ severity: 'high', file: 'input.txt', line: 1, message: `A ${purposeImpact} ${status} finding`, scenario: 'A reader opens a missing file and returns an empty list instead of reporting it.', reachable: { status, evidence: [], coverage: '' }, purposeImpact, silent: false, origin: 'new-code', fixOf: null, ...extra });
const oldFinding = { severity: 'high', file: 'input.txt', line: 1, message: 'Concrete defect' };
// Purpose assessments: complete, and one that omits the second criterion.
const complete = (extra = {}) => purposeOf(ACCEPTANCE, extra);
const omitsSecond = () => purposeOf([ACCEPTANCE[0]]);
const changeResult = ({ verdict = 'pass', findings = [], purpose = complete(), strict = false } = {}) => ({ verdict, summary: `Fictional ${verdict} review`, findings, riskAssessment: strict ? strictAssessment : ordinary, strictReview: { fullDiffInspected: true, threatModelReviewed: strict, stopConditionsReviewed: strict }, scopeSummary: 'All', priorFindingsDisposition: [], learningsChecked: [], ...(purpose ? { purpose } : {}) });
const planResult = ({ verdict = 'pass', findings = [], purpose = complete() } = {}) => ({ verdict, summary: `Fictional plan ${verdict}`, findings, riskAssessment: ordinary, ...(purpose ? { purpose } : {}) });
// A scripted reviewer that answers each call with the next result and records what it was asked.
const scripted = (results, calls = []) => async spec => { calls.push(spec); const result = results.shift(); assert.ok(result, `no scripted answer for call ${calls.length}`); return { provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: `review-${calls.length}`, result: structuredClone(result) }; };

// ---- The protocol checks (5.4) ----

test('protocol checks: the purpose assessment lists each acceptance line exactly once by exact text, and a yes silent answer needs a silent finding', () => {
  const task = { acceptance: ACCEPTANCE };
  assert.deepEqual(protocolContradictions(changeResult(), task), []);
  assert.deepEqual(protocolContradictions(changeResult({ purpose: null }), task), ['the purpose assessment is missing'], 'a result in today\'s shape is contradictory (5.5)');
  assert.deepEqual(protocolContradictions(changeResult({ purpose: omitsSecond() }), task), ['purpose.acceptance omits criterion 2, "The reader reports a missing file"']);
  assert.deepEqual(protocolContradictions(changeResult({ purpose: purposeOf([...ACCEPTANCE, ACCEPTANCE[0]]) }), task), ['purpose.acceptance lists criterion 1, "Observed fixture behavior", 2 times instead of once']);
  assert.deepEqual(protocolContradictions(changeResult({ purpose: purposeOf([...ACCEPTANCE, 'Something else']) }), task), ['purpose.acceptance lists "Something else", which is not an acceptance criterion of this task']);
  assert.deepEqual(protocolContradictions(changeResult({ purpose: purposeOf([ACCEPTANCE[0], `${ACCEPTANCE[1]} `]) }), task).length, 2, 'exact text: a trailing space is another criterion');
  assert.deepEqual(protocolContradictions(changeResult({ purpose: purposeOf(['A', 'A']) }), { acceptance: ['A', 'A'] }), [], 'a repeated acceptance line is listed as often as the task has it');
  assert.equal(protocolContradictions(changeResult({ purpose: purposeOf(['A']) }), { acceptance: ['A', 'A'] }).length, 1);
  assert.deepEqual(protocolContradictions(changeResult({ purpose: purposeOf([]) }), { acceptance: [] }), [], 'a tracked task without criteria');
  const silentYes = complete({ silentWrongAnswer: { answer: 'yes', how: 'A stale build passes', settle: '', evidence: [] } });
  assert.deepEqual(protocolContradictions(changeResult({ purpose: silentYes, findings: [finding('outcome', 'unknown')] }), task), ['purpose.silentWrongAnswer is yes, but no finding is marked silent']);
  assert.deepEqual(protocolContradictions(changeResult({ purpose: silentYes, findings: [finding('check-trust', 'unknown', { silent: true })] }), task), []);
  assert.deepEqual(protocolContradictions(changeResult({ purpose: complete({ silentWrongAnswer: { answer: 'unknown', how: '', settle: 'Run the gate on a clean build', evidence: [] } }) }), task), [], 'unknown is honest, not contradictory');
});

test('shadow route v2: a protocol failure comes first and parks, revises a satisfied review, or stops a plan review; otherwise v1', () => {
  const must = [{ kind: 'must-fix' }], none = [];
  assert.deepEqual(shadowRouteV2(none, { strict: false }, { failure: true }), { route: 'park', disposition: 'protocol-failure' }, 'even a pass with no findings');
  assert.deepEqual(shadowRouteV2(must, { strict: true, incomplete: true, bounded: true, phase: 'final' }, { failure: true }), { route: 'park', disposition: 'protocol-failure' }, 'before the strict checks');
  assert.deepEqual(shadowRouteV2(none, { satisfied: true }, { failure: true }), { route: 'revise', disposition: 'protocol-failure' });
  assert.deepEqual(shadowRouteV2(none, { plan: true }, { failure: true }), { route: 'stop', disposition: 'protocol-failure' });
  for (const review of [{ strict: false }, { strict: true, bounded: true, phase: 'full' }, { satisfied: true }]) assert.deepEqual(shadowRouteV2(must, review), shadowRouteV1(must, review));
  assert.deepEqual(shadowRouteV2(none, { plan: true }), { route: 'pass', disposition: 'accepted' });
});

test('the purpose block: the outcome verbatim or labelled when there is none, numbered criteria, the reviewed plan and the protected classes', () => {
  const withOutcome = purposeBlock({ task: { outcome: 'Fictional records are read once', acceptance: ACCEPTANCE }, plan: { summary: 'Pinned fictional plan', checks: ['unit'], risks: ['none'] }, subject: 'change' });
  assert.match(withOutcome, /^Purpose first\. Answer these two questions in purpose before you look for defects\.\nOutcome: "Fictional records are read once"\nAcceptance criteria:\n1\. "Observed fixture behavior"\n2\. "The reader reports a missing file"\nReviewed plan: \{"summary":"Pinned fictional plan","checks":\["unit"\],"risks":\["none"\]\}\nProtected classes: security/);
  assert.match(withOutcome, /Can it give a wrong answer silently\?.*stale inputs read as current/);
  const without = purposeBlock({ task: { title: 'Fictional', acceptance: ACCEPTANCE }, subject: 'plan' });
  assert.match(without, /\nOutcome: none recorded for this task\. Judge the outcome by its title and acceptance criteria\.\n/);
  assert.doesNotMatch(without, /Reviewed plan/, 'a plan review has the plan itself');
  assert.deepEqual(purposeSummary(changeResult(), { acceptance: ACCEPTANCE }), { outcomeRecorded: false, assessed: true, outcome: 'met', notMet: [], unverified: [], silentWrongAnswer: 'no' });
  assert.equal(purposeSummary(changeResult({ purpose: null }), { outcome: 'x' }).outcomeRecorded, true);
});

// ---- Change review, through the dispatcher ----

// A one-commit repository and a change review intent for `bar`, as workflows/actions.mjs builds it.
function candidate(t, { bar = 'must-fix', outcome = null, step = 'review', risk = 'ordinary' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fct-mf2-')), root = join(base, 'repo'); t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fictional Evaluator']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'input.txt'), 'fictional candidate text\n'); git(['add', '.']); git(['commit', '-qm', 'Fictional candidate']);
  const head = repositoryIdentity(root).head, config = { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { reviewer: { provider: 'claude', model: 'fictional' } }, policy: {}, context: { files: [], maxChars: 1000 } };
  const task = { id: 'task-1', title: 'Fictional reader', ...(outcome ? { outcome } : {}), acceptance: ACCEPTANCE, risk };
  const action = { operation: 'provider.review', step, binding: step, task, config, risk: { level: risk }, reviewHistory: [], results: { source: { head }, plan: { result: { summary: 'Pinned fictional plan', files: [], checks: [], risks: [] } } }, context: { files: [], digest: 'fictional-context' }, artifactDir: join(base, 'artifacts'), projectId: 'project-1', flowId: 'flow-1', ...(bar === 'severity' ? {} : { reviewBar: bar, reviewPolicy: pinnedPolicy, reviewRecords: [] }) };
  return { intent: { cwd: root, timeoutMs: 60000, action }, head };
}

test('must-fix fixture: a pass with no findings that omits a criterion twice routes park (protocol-failure); one contradiction then a valid review proceeds', async t => {
  const calls = [], review = await runAction(candidate(t).intent, { providerInvoke: scripted([changeResult({ purpose: omitsSecond() }), changeResult({ purpose: omitsSecond() })], calls) });
  assert.equal(calls.length, 2, 'one correction review');
  assert.match(calls[1].prompt, /A previous fresh review returned a result that fails the factory's protocol checks: \["purpose\.acceptance omits criterion 2, \\"The reader reports a missing file\\""\]/);
  assert.ok(calls[1].prompt.startsWith(calls[0].prompt), 'the correction is the same review with the contradiction stated');
  assert.equal(calls[1].legacySchema, undefined, 'a must-fix flow offers no schema fallback');
  assert.deepEqual([review.route, review.disposition], ['park', 'protocol-failure']);
  assert.deepEqual(review.protocolCorrections.map(row => [row.reason, row.contradictions, row.correctionArtifact]), [['protocol', ['purpose.acceptance omits criterion 2, "The reader reports a missing file"'], 'provider-protocol-correction-1']]);
  assert.deepEqual(review.mustFix.protocol, { contradictions: ['purpose.acceptance omits criterion 2, "The reader reports a missing file"'], correction: { contradictions: ['purpose.acceptance omits criterion 2, "The reader reports a missing file"'] }, failure: true });
  assert.equal(review.shadowRoute, undefined, 'a must-fix flow is not a shadow');
  // One contradiction, then a valid review: the correction's result is the review's, routed as usual.
  const fixed = await runAction(candidate(t).intent, { providerInvoke: scripted([changeResult({ purpose: omitsSecond() }), changeResult()]) });
  assert.deepEqual([fixed.route, fixed.disposition], ['pass', 'accepted']);
  assert.deepEqual(fixed.result.purpose, complete());
  assert.equal(fixed.mustFix.basis, 'correction');
  // No contradiction: no correction review.
  const once = [];
  assert.equal((await runAction(candidate(t).intent, { providerInvoke: scripted([changeResult()], once) })).route, 'pass'); assert.equal(once.length, 1);
});

test('must-fix fixture: protocol failure takes precedence over the legacy fallback and the strict checks; an old-shape result never passes', async t => {
  // Today's shape with a finding: the legacy fallback alone would send it back (revise); twice it parks.
  const legacy = await runAction(candidate(t).intent, { providerInvoke: scripted([changeResult({ verdict: 'revise', findings: [oldFinding], purpose: null }), changeResult({ verdict: 'revise', findings: [oldFinding], purpose: null })]) });
  assert.deepEqual([legacy.route, legacy.disposition], ['park', 'protocol-failure']);
  assert.deepEqual(legacy.mustFix.findings.map(row => [row.bar, row.kind]), [['legacy', 'must-fix']]);
  // Today's shape with no findings: never a pass.
  const empty = await runAction(candidate(t).intent, { providerInvoke: scripted([changeResult({ purpose: null }), changeResult({ purpose: null })]) });
  assert.deepEqual([empty.route, empty.disposition], ['park', 'protocol-failure']);
  // Strict work with incomplete attestations would revise; the protocol failure comes first.
  const strictIncomplete = { ...changeResult({ purpose: omitsSecond(), strict: true }), strictReview: { fullDiffInspected: false, threatModelReviewed: false, stopConditionsReviewed: false } };
  const strict = await runAction(candidate(t, { risk: 'strict' }).intent, { providerInvoke: scripted([strictIncomplete, strictIncomplete]) });
  assert.deepEqual([strict.route, strict.disposition], ['park', 'protocol-failure']);
  // The satisfied review has no park edge: it revises, which fails that flow (6.5).
  const satisfied = await runAction(candidate(t, { step: 'satisfied-review' }).intent, { providerInvoke: scripted([changeResult({ purpose: null }), changeResult({ purpose: null })]) });
  assert.deepEqual([satisfied.route, satisfied.disposition], ['revise', 'protocol-failure']);
});

test('shadow: the protocol failure is recorded as shadowRoute v2 and the actual route is today\'s, decided by the original result', async t => {
  const calls = [];
  const review = await runAction(candidate(t, { bar: 'shadow' }).intent, { providerInvoke: scripted([changeResult({ purpose: omitsSecond() }), changeResult({ verdict: 'revise', findings: [finding('outcome', 'unknown')], purpose: omitsSecond() })], calls) });
  assert.equal(calls.length, 2); assert.equal(calls[1].legacySchema, calls[0].legacySchema, 'the correction review accepts the same shapes');
  assert.deepEqual([review.route, review.disposition], ['pass', 'accepted'], 'the severity route of the original result');
  assert.deepEqual(review.result, changeResult({ purpose: omitsSecond() }), 'the reviewed result is the original one');
  assert.equal(review.protocolCorrections, undefined, 'nothing of the shadow\'s correction is on the actual review');
  assert.deepEqual(review.shadowRoute, { version: 'v2', estimate: true, omits: [...SHADOW_V2_OMITS], route: 'park', disposition: 'protocol-failure', actualRoute: 'pass', actualDisposition: 'accepted', differs: true, verdictOverridden: false }, 'the correction\'s verdict, revise, agrees with a park');
  assert.equal(review.mustFix.basis, 'correction'); assert.equal(review.mustFix.protocol.failure, true);
  assert.deepEqual(review.mustFix.protocol.correction.result.findings.map(row => row.message), ['A outcome unknown finding'], 'the correction\'s result is kept with the estimate');
  // A valid correction: the estimate is derived from it, and the actual route is still the original's.
  const corrected = await runAction(candidate(t, { bar: 'shadow' }).intent, { providerInvoke: scripted([changeResult({ purpose: omitsSecond() }), changeResult({ verdict: 'revise', findings: [finding('outcome', 'unknown')] })]) });
  assert.deepEqual([corrected.route, corrected.shadowRoute.route, corrected.shadowRoute.disposition], ['pass', 'defer', 'followup-required']);
  assert.deepEqual(corrected.mustFix.findings.map(row => [row.id, row.kind, row.reason]), [['R1.1', 'operator-item', 'unresolved-scenario']]);
  // A stop while the shadow's correction review runs stops the attempt; it is not recorded as a shadow failure.
  const controller = new AbortController(), results = [changeResult({ purpose: omitsSecond() })];
  await assert.rejects(runAction(candidate(t, { bar: 'shadow' }).intent, { signal: controller.signal, providerInvoke: async spec => { if (!results.length) { controller.abort(); throw new Error('fictional abort'); } return scripted(results)(spec); } }), /fictional abort/);
});

test('purpose synthesis: an unmet criterion or outcome, or a silent wrong answer, that no must-fix finding covers adds one; unverified never does', async t => {
  const notMet = complete(); notMet.acceptance[1].status = 'not-met';
  const shadow = await runAction(candidate(t, { bar: 'shadow' }).intent, { providerInvoke: scripted([changeResult({ purpose: notMet })]) });
  assert.equal(shadow.route, 'pass', 'shadow: today\'s route');
  assert.deepEqual(shadow.mustFix.findings, [{ id: 'R1.1', bar: 'must-fix', kind: 'must-fix', reason: 'unmet-acceptance', added: true }]);
  assert.deepEqual([shadow.shadowRoute.route, shadow.shadowRoute.disposition], ['revise', 'correct']);
  assert.deepEqual(shadow.mustFix.purpose, { outcomeRecorded: false, assessed: true, outcome: 'met', notMet: [ACCEPTANCE[1]], unverified: [], silentWrongAnswer: 'no' });
  const outcome = await runAction(candidate(t, { bar: 'shadow' }).intent, { providerInvoke: scripted([changeResult({ purpose: complete({ outcome: 'not-met' }) })]) });
  assert.equal(outcome.shadowRoute.route, 'revise');
  // A silent yes with a silent finding that is not must-fix (an operator item): the factory adds a must-fix one.
  const silent = await runAction(candidate(t, { bar: 'shadow' }).intent, { providerInvoke: scripted([changeResult({ findings: [finding('outcome', 'unknown', { silent: true, severity: 'medium' })], purpose: complete({ silentWrongAnswer: { answer: 'yes', how: 'A missing file reads as empty', settle: '', evidence: [] } }) })]) });
  assert.deepEqual(silent.mustFix.findings.map(row => [row.id, row.kind, row.reason]), [['R1.1', 'operator-item', 'unresolved-scenario'], ['R1.2', 'must-fix', 'silent-wrong-answer']]);
  assert.equal(silent.shadowRoute.route, 'revise');
  // Unverified, partly and an unknown silent answer name no scenario to fix.
  const unsure = complete({ outcome: 'partly', silentWrongAnswer: { answer: 'unknown', how: '', settle: 'Run the reader on a missing file', evidence: [] } }); unsure.acceptance[0].status = 'unverified';
  const honest = await runAction(candidate(t, { bar: 'shadow' }).intent, { providerInvoke: scripted([changeResult({ purpose: unsure })]) });
  assert.deepEqual([honest.mustFix.findings, honest.shadowRoute.route], [[], 'pass']);
  assert.deepEqual(honest.mustFix.purpose.unverified, [ACCEPTANCE[0]]);
  // In a must-fix fixture flow the same finding is recorded; acting on it is enforcement routing (slice 4).
  const fixture = await runAction(candidate(t).intent, { providerInvoke: scripted([changeResult({ purpose: notMet })]) });
  assert.deepEqual(fixture.mustFix.findings.map(row => [row.kind, row.reason]), [['must-fix', 'unmet-acceptance']]);
});

test('a task without an outcome is labelled in the purpose block and in the record; one with an outcome is quoted verbatim', async t => {
  for (const outcome of [null, 'Fictional records are read once']) {
    const calls = [], review = await runAction(candidate(t, { bar: 'shadow', outcome }).intent, { providerInvoke: scripted([changeResult()], calls) });
    const [before, after] = calls[0].prompt.split('\nPurpose first.');
    assert.ok(after && before.length < calls[0].prompt.indexOf('Trusted diff:'), 'the purpose block comes before the diff');
    if (outcome) assert.match(after, /\nOutcome: "Fictional records are read once"\n/); else assert.match(after, /\nOutcome: none recorded for this task\./);
    assert.equal(review.mustFix.purpose.outcomeRecorded, Boolean(outcome));
  }
});

// ---- Through the engine ----

// A rehearsal flow at a change review whose graph has the reference review edges (park to a question).
async function reviewFlow(t, bar) {
  const f = sandbox(t);
  const effect = (operation, next, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: 60000, next, onFailure: 'failed', ...extra });
  const workflow = { version: 1, start: 'review', nodes: { review: effect('provider.review', 'gate', { preserveInput: true, evidence: 'review', resultEdges: { pass: 'gate', revise: 'gate', defer: 'gate', park: 'review-question' } }), gate: { kind: 'end', outcome: 'completed' }, 'review-question': { kind: 'question', role: 'operator', question: 'Fictional park question', answers: { stop: 'failed' } }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { reviewer: { provider: 'claude', model: 'fictional' } }, policy: { planning: false, ...(bar === 'shadow' ? { reviewBar: 'shadow' } : {}) }, context: { files: [], maxChars: 1000 } });
  f.command('task.put', { task: { id: f.task.id, title: 'Fictional reader', acceptance: ACCEPTANCE, risk: 'ordinary' } });
  f.start();
  // A must-fix flow is a fixture: the configuration cannot pin it.
  const flow = f.store.need('flow', 'flow-1'); flow.results.source = { head: repositoryIdentity(f.root).head }; if (bar === 'must-fix') Object.assign(flow, { reviewBar: 'must-fix', reviewPolicy: pinnedPolicy }); f.store.put('flow', flow);
  writeFileSync(join(f.root, 'input.txt'), 'fictional candidate\n'); execFileSync('git', ['commit', '-qam', 'Fictional candidate'], { cwd: f.root });
  await f.engine.tick();
  return { ...f, attempt: f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId) };
}
const receipt = actionResult => ({ exitCode: 0, reason: null, costMicros: 0, actionResult });

test('engine: a must-fix review that is contradictory twice parks for the operator and mints no review evidence; shadow follows today\'s route', async t => {
  const twice = () => scripted([changeResult({ purpose: omitsSecond() }), changeResult({ purpose: omitsSecond() })]);
  const f = await reviewFlow(t, 'must-fix');
  assert.equal(f.attempt.intent.action.reviewBar, 'must-fix');
  const review = await runAction(f.attempt.intent, { providerInvoke: twice() });
  f.engine.settle('flow-1', f.attempt, receipt(review));
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'review-question', 'parked for the operator');
  assert.equal(flow.evidence.review, undefined, 'no review evidence');
  assert.deepEqual([flow.reviewHistory[0].disposition, flow.reviewHistory[0].mustFix.protocol.failure], ['protocol-failure', true]);
  const shadow = await reviewFlow(t, 'shadow');
  const shadowReview = await runAction(shadow.attempt.intent, { providerInvoke: twice() });
  shadow.engine.settle('flow-1', shadow.attempt, receipt(shadowReview));
  const shadowFlow = shadow.store.need('flow', 'flow-1');
  assert.equal(shadowFlow.step, 'gate', 'today\'s pass');
  assert.ok(shadowFlow.evidence.review, 'today\'s evidence');
  assert.deepEqual([shadowFlow.reviewHistory[0].shadowRoute.route, shadowFlow.reviewHistory[0].shadowRoute.disposition], ['park', 'protocol-failure']);
});

// A rehearsal flow at plan review, on the reference plan and plan-review nodes, with a reviewed-for plan.
const PLAN = { route: 'ready', result: { status: 'ready', summary: 'Fictional plan', files: ['input.txt'], checks: ['unit'], risks: [], questions: [] } };
async function planFlow(t, bar) {
  const f = sandbox(t), reference = changeWorkflow({ policy: {} }).nodes;
  const workflow = { version: 1, start: 'plan-review', nodes: { plan: { ...reference.plan, resultEdges: { ready: 'plan-review', blocked: 'failed' } }, 'plan-review': reference['plan-review'], 'publish-plan': { ...reference['publish-plan'], next: 'done' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'claude', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: bar === 'shadow' ? { reviewBar: 'shadow' } : {}, context: { files: [], maxChars: 1000 } });
  f.command('task.put', { task: { id: f.task.id, title: 'Fictional reader', acceptance: ACCEPTANCE, risk: 'ordinary' } });
  f.start();
  const flow = f.store.need('flow', 'flow-1'); flow.results.plan = structuredClone(PLAN); flow.visits.plan = 1; if (bar === 'must-fix') Object.assign(flow, { reviewBar: 'must-fix', reviewPolicy: pinnedPolicy }); f.store.put('flow', flow);
  await f.engine.tick();
  const attempt = () => f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  return { ...f, attempt };
}
// What the runner writes when an action throws (workflows/dispatch.mjs, its main block).
const failedReceipt = error => ({ exitCode: 1, reason: null, costMicros: 0, actionResult: { route: 'error', error: error.message, ...(error.notice ? { notice: error.notice } : {}), ...(error.protocolFailure ? { protocolFailure: error.protocolFailure } : {}) } });

test('engine: a must-fix plan review contradictory twice stops at plan review (protocol-failure): no edge, no plan published, no plan visit; resume reviews the same plan again', async t => {
  const f = await planFlow(t, 'must-fix'), first = f.attempt();
  assert.equal(first.intent.action.reviewBar, 'must-fix');
  const calls = [];
  let thrown;
  await assert.rejects(runAction(first.intent, { providerInvoke: scripted([planResult({ purpose: omitsSecond() }), planResult({ purpose: null })], calls) }), error => { thrown = error; return true; });
  assert.equal(calls.length, 2, 'plan review\'s single correction');
  assert.match(calls[1].prompt, /fails the factory's protocol checks: \["purpose\.acceptance omits criterion 2/);
  assert.equal(thrown.code, 'PROTOCOL_FAILURE');
  assert.deepEqual(thrown.protocolFailure, { step: 'plan-review', contradictions: [['purpose.acceptance omits criterion 2, "The reader reports a missing file"'], ['the purpose assessment is missing']] });
  assert.equal(thrown.notice, 'The plan review returned a contradictory result twice, so the flow stopped at plan-review without following any edge: no plan was published and no plan visit was spent. Resume runs a fresh plan review of the same plan; or replan with a note (flow.replan), or stop. First: purpose.acceptance omits criterion 2, "The reader reports a missing file". Second: the purpose assessment is missing.');
  f.engine.settle('flow-1', first, failedReceipt(thrown));
  let flow = f.store.need('flow', 'flow-1');
  const settled = f.store.need('attempt', first.id);
  assert.deepEqual([flow.state, flow.step, flow.resumeStep, flow.stopReason], ['stopped', 'plan-review', 'plan-review', thrown.notice]);
  assert.deepEqual([settled.status, settled.classification], ['failed', 'protocol-failure']);
  assert.deepEqual(settled.protocolFailure, thrown.protocolFailure);
  assert.equal(flow.results['plan-review'], undefined, 'no plan review result is recorded');
  assert.deepEqual(flow.results.plan, PLAN, 'the plan is kept');
  assert.equal(flow.visits.plan, 1, 'no plan visit is spent');
  assert.ok(!f.store.all('attempt').some(row => row.step !== 'plan-review'), 'publish-plan never ran');
  assert.equal(f.store.events(50).filter(event => event.type === 'flow.protocol-failure-held').length, 1);
  // Resume: a fresh plan review of the same plan.
  f.command('resume', { flowId: 'flow-1', note: 'Fictional resume' });
  await f.engine.tick();
  const again = f.attempt();
  assert.notEqual(again.id, first.id); assert.equal(again.step, 'plan-review');
  assert.deepEqual(again.intent.action.results.plan, PLAN);
  const passed = await runAction(again.intent, { providerInvoke: scripted([planResult()]) });
  assert.equal(passed.route, 'pass');
  f.engine.settle('flow-1', again, receipt(passed));
  flow = f.store.need('flow', 'flow-1');
  assert.deepEqual([flow.step, flow.visits.plan], ['publish-plan', 1]);
});

test('plan review: one contradiction followed by a valid review proceeds; severity and shadow plan reviews keep today\'s route', async t => {
  const f = await planFlow(t, 'must-fix'), calls = [];
  const fixed = await runAction(f.attempt().intent, { providerInvoke: scripted([planResult({ purpose: omitsSecond() }), planResult()], calls) });
  assert.deepEqual([fixed.route, fixed.protocolCorrections.map(row => [row.reason, row.contradictions])], ['pass', [['protocol', ['purpose.acceptance omits criterion 2, "The reader reports a missing file"']]]]);
  assert.doesNotMatch(calls[1].prompt, /internally contradictory pass with findings/, 'only the protocol contradiction is stated');
  // A pass with findings that also omits a criterion: one correction states both; a valid answer proceeds.
  const both = [], bothFixed = await runAction(f.attempt().intent, { providerInvoke: scripted([planResult({ findings: [finding('none', 'unknown', { severity: 'low' })], purpose: omitsSecond() }), planResult()], both) });
  assert.equal(bothFixed.route, 'pass'); assert.equal(both.length, 2);
  assert.match(both[1].prompt, /internally contradictory pass with findings[\s\S]*fails the factory's protocol checks/);
  // Old shape, twice: a must-fix plan review never passes on it.
  await assert.rejects(runAction(f.attempt().intent, { providerInvoke: scripted([planResult({ purpose: null }), planResult({ purpose: null })]) }), error => error.code === 'PROTOCOL_FAILURE');
  // Severity: no purpose is asked or checked, one call, today's pass.
  const severity = await planFlow(t, 'severity'), severityCalls = [];
  const today = await runAction(severity.attempt().intent, { providerInvoke: scripted([planResult({ purpose: null })], severityCalls) });
  assert.deepEqual([today.route, severityCalls.length, today.protocolCorrections, today.mustFix], ['pass', 1, [], undefined]);
  assert.doesNotMatch(severityCalls[0].prompt, /Purpose first/);
  // Shadow: today's pass; the estimate records the stop, after the shadow's own correction review.
  const shadow = await planFlow(t, 'shadow'), shadowCalls = [];
  const estimate = await runAction(shadow.attempt().intent, { providerInvoke: scripted([planResult({ purpose: omitsSecond() }), planResult({ purpose: omitsSecond() })], shadowCalls) });
  assert.deepEqual([estimate.route, estimate.protocolCorrections, shadowCalls.length], ['pass', [], 2]);
  assert.deepEqual([estimate.shadowRoute.route, estimate.shadowRoute.disposition, estimate.shadowRoute.actualRoute], ['stop', 'protocol-failure', 'pass']);
  assert.match(shadowCalls[0].prompt, /\nPurpose first\.[\s\S]*\nReview this proposed plan/);
});

test('engine: only a must-fix flow is held by a plan review protocol failure', async t => {
  const f = await planFlow(t, 'shadow'), attempt = f.attempt();
  const forged = Object.assign(new Error('fictional'), { protocolFailure: { step: 'plan-review', contradictions: [] } });
  f.engine.settle('flow-1', attempt, failedReceipt(forged));
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'failed', 'its failure route, as for any failed plan review');
  assert.notEqual(f.store.need('attempt', attempt.id).classification, 'protocol-failure');
});
