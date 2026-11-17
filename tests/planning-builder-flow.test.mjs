import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { flowNotice, snapshot } from '../starter/factory/core/project.mjs';
import { validateOperations } from '../starter/factory/core/operations.mjs';
import * as dispatchModule from '../starter/factory/workflows/dispatch.mjs';
const { runAction, previousPlanBrief } = dispatchModule, PREVIOUS_PLAN_CHARS = dispatchModule.PREVIOUS_PLAN_CHARS ?? 16000;
import { recordCarriedQuestions, carriedOverflow, overflowMarker } from '../starter/factory/core/worker-questions.mjs';
import { actionSpecification } from '../starter/factory/workflows/actions.mjs';
import { validateSchema, RISK_PLAN_SCHEMA, DELIVERY_BUILD_SCHEMA } from '../starter/factory/adapters/providers/index.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';

// dev.83, from the dev.82 re-test: G4 (ready plans with only non-blocking questions proceed and
// carry them to the merge question), G2 (a builder's questions get a full card; non-blocking ones
// go on), G3 (a replanning planner sees its previous plan) and G16 (status --task fields).
const config = { policy: {}, repository: {} };
const ordinary = { level: 'ordinary', rationale: 'Fictional bounded change', threatModel: [], stopConditions: [] };
const strictIncomplete = { level: 'strict', rationale: 'Fictional saved ledger entries', threatModel: [], stopConditions: [] };
const OPERATIONS = { plan: 'provider.plan', 'plan-review': 'provider.planReview', build: 'provider.build', review: 'provider.review' };
const C0_C1 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function fixture(t, { workflow = changeWorkflow(config), step = 'plan' } = {}) {
  const f = sandbox(t);
  assert.equal(f.command('task.put', { task: { id: f.task.id, title: 'Fictional ledger export', acceptance: ['Exports balance'], risk: 'ordinary', paths: ['src/export.js'] } }).status, 'completed');
  f.start();
  const flow = f.store.need('flow', 'flow-1');
  // The comparison commit a real flow records before its model work (core/engine.mjs).
  Object.assign(flow, { governanceBase: repositoryIdentity(f.root).head, workflow, workflowDigest: digest(workflow), mode: 'delivery', kind: 'change', reviewProtocol: 'fresh-full', step, visits: { source: 1, plan: 1, ...(step === 'build' ? { build: 1 } : {}) }, results: {}, evidence: {} });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.store.put('flow', flow);
  return { ...f, identity: repositoryIdentity(f.root) };
}
function settle(f, result) {
  const flow = f.store.need('flow', 'flow-1'), step = flow.step, id = `synthetic-${step}-${f.store.all('attempt').length}`;
  const attempt = { id, flowId: flow.id, step, status: 'running', intent: { action: { operation: OPERATIONS[step] }, inputIdentity: f.identity }, intentDigest: digest(id) };
  flow.attemptId = id; f.store.put('flow', flow); f.store.put('attempt', attempt);
  f.engine.settle(flow.id, attempt, { exitCode: 0, costMicros: 0, actionResult: { ...result, identity: f.identity } });
  return f.store.need('flow', flow.id);
}
const assumption = (question, answer) => ({ question, assumption: answer });
const planResult = ({ status = 'ready', questions = [], assumptions = [], riskAssessment = ordinary, summary = 'Fictional plan: add the export' } = {}) =>
  ({ status, summary, files: ['src/export.js'], checks: [], risks: [], questions, assumptions, departures: [], unverified: [], pushback: [], riskAssessment, learningsApplied: [] });
const buildResult = ({ status = 'implemented', questions = [], assumptions = [], summary = 'Added the fictional export and its test', departures = [], unverified = [] } = {}) =>
  ({ status, summary, questions, assumptions, departures, unverified, pushback: [], learningsApplied: [] });
const routed = (route, result) => ({ route, result });
async function openQuestion(f) {
  await f.engine.step('flow-1');
  return f.store.all('inbox').find(row => row.kind === 'question' && row.status === 'open') ?? null;
}
const answer = (f, item, value, extra = {}) => f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: value, ...extra });
// A model step run through the real dispatcher with a scripted provider; returns its prompt and result.
async function dispatch(f, operation, providerResult, action = {}) {
  const prompts = [], head = repositoryIdentity(f.root).head;
  const task = { id: 'fictional-task', title: 'Fictional task', acceptance: ['Observed fictional behavior'], risk: 'ordinary', revision: 'r1', paths: ['src/export.js'] };
  const result = await runAction({ cwd: f.root, timeoutMs: 60000, action: { operation, step: operation === 'provider.review' ? 'review' : undefined, task, config: { mode: 'rehearsal', repository: { slug: 'fictional/project', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'claude', model: 'synthetic' }, reviewer: { provider: 'claude', model: 'synthetic' }, builder: { provider: 'claude', model: 'synthetic' } }, policy: {} }, risk: { level: 'ordinary' }, context: { files: [], digest: 'fictional-context' }, results: { source: { head }, plan: { result: planResult() } }, reviewHistory: [], sessions: {}, artifactDir: join(f.base, 'artifacts', `${operation}-${Math.random()}`), ...action } },
    { providerInvoke: async spec => { prompts.push(spec.prompt); return { provider: 'fictional', model: 'synthetic', sessionId: 'fresh', result: providerResult }; } });
  return { prompt: prompts[0], result };
}

// Fix 1 (G4).
test('the planner marks non-blocking questions as assumptions, and a ready plan with only assumptions routes ready', async t => {
  const f = sandbox(t);
  assert.ok(RISK_PLAN_SCHEMA.required.includes('assumptions') && DELIVERY_BUILD_SCHEMA.required.includes('assumptions'));
  const withAssumptions = planResult({ assumptions: [assumption('Should docs link back to the guide?', 'No link back.')] });
  assert.equal(validateSchema(withAssumptions, RISK_PLAN_SCHEMA), withAssumptions);
  const ready = await dispatch(f, 'provider.plan', withAssumptions);
  assert.equal(ready.result.route, 'ready', 'only assumptions: no stop');
  assert.match(ready.prompt, /Put each question whose answer would not change the plan in assumptions instead, with the answer the plan assumes, and return status ready/);
  assert.match(ready.prompt, /A ready plan that still lists questions waits for the operator/);
  // Still stopping: a blocking question, a blocked plan, a strict plan without a complete assessment.
  assert.equal((await dispatch(f, 'provider.plan', planResult({ questions: ['Which ledger owns refunds?'], assumptions: withAssumptions.assumptions }))).result.route, 'blocked');
  assert.equal((await dispatch(f, 'provider.plan', planResult({ status: 'blocked', assumptions: withAssumptions.assumptions }))).result.route, 'blocked');
  assert.equal((await dispatch(f, 'provider.plan', planResult({ riskAssessment: strictIncomplete, assumptions: withAssumptions.assumptions }))).result.route, 'blocked');
});

test('a ready plan with only assumptions goes to plan review without stopping and carries them, sanitised', async t => {
  const f = fixture(t);
  const flow = settle(f, routed('ready', planResult({ assumptions: [assumption('Link\u009b2J back to the guide?\u0000', 'No link back.\u001b[31m')] })));
  assert.equal(flow.step, 'plan-review'); assert.equal(flow.state, 'ready');
  assert.equal(f.store.all('inbox').filter(row => row.kind === 'question').length, 0, 'no question for the operator');
  assert.deepEqual(flow.carriedQuestions, [{ from: 'planner', attemptId: 'synthetic-plan-0', question: 'Link back to the guide?', assumption: 'No link back.' }]);
  // The plan reviewer gets them through the action specification.
  const spec = actionSpecification(f.store, flow, flow.workflow.nodes['plan-review'], join(f.base, 'spec'));
  assert.deepEqual(spec.action.carriedQuestions.map(row => row.question), ['Link back to the guide?']);
  // A later plan replaces the earlier plan's assumptions; the graph's digest is untouched by any of this.
  settle(f, routed('revise', { verdict: 'revise', summary: 'Fictional', findings: [{ severity: 'high', file: 'src/export.js', line: 1, message: 'Missing case' }], riskAssessment: ordinary }));
  const replanned = settle(f, routed('ready', planResult({ assumptions: [assumption('Keep column order?', 'Yes.')] })));
  assert.deepEqual(replanned.carriedQuestions.map(row => row.question), ['Keep column order?']);
  assert.equal(replanned.workflowDigest, digest(changeWorkflow(config)));
});

test('the plan reviewer, the builder and the code reviewer are given the carried questions', async t => {
  const f = sandbox(t);
  const carriedQuestions = [{ from: 'planner', question: 'Should docs link back to the guide?', assumption: 'No link back.' }, { from: 'planner', question: 'Round half even?', assumption: null, answer: 'proceed', answeredBy: 'operator', note: 'Yes, half even.' }];
  const planReview = await dispatch(f, 'provider.planReview', { verdict: 'pass', summary: 'Fictional', findings: [], riskAssessment: ordinary }, { carriedQuestions });
  assert.match(planReview.prompt, /Should docs link back to the guide\?/); assert.match(planReview.prompt, /"operatorNote":"Yes, half even\."/);
  assert.match(planReview.prompt, /If an assumption is wrong for this task, report it as a blocking finding/);
  const build = await dispatch(f, 'provider.build', buildResult(), { carriedQuestions });
  assert.match(build.prompt, /Should docs link back to the guide\?/);
  assert.match(build.prompt, /Treat these as settled: work on the assumed answers unless Operator feedback says otherwise, and do not ask them again/);
  assert.match(build.prompt, /Put each question whose answer would not change your work in assumptions, with the answer you assumed, and return implemented/);
  const review = await dispatch(f, 'provider.review', { verdict: 'pass', summary: 'Fictional', findings: [], riskAssessment: ordinary, strictReview: { fullDiffInspected: true, threatModelReviewed: true, stopConditionsReviewed: true }, scopeSummary: 'Fictional scope', priorFindingsDisposition: [] }, { carriedQuestions });
  assert.match(review.prompt, /If an assumption is wrong for this task, report it as a blocking finding/);
});

test('proceed carries the questions it went ahead on, with the operator note, and proceed is still offered when a plan stops', async t => {
  const f = fixture(t);
  settle(f, routed('blocked', planResult({ questions: ['Round half even or half up?'], assumptions: [assumption('Keep column order?', 'Yes.')] })));
  const item = await openQuestion(f);
  assert.deepEqual(item.answers, ['replan', 'proceed', 'stop']);
  assert.match(item.context, /left 1 question open/); assert.match(item.context, /Keep column order\? Assumed: Yes\./);
  assert.deepEqual(item.planQuestion.assumptions, [{ question: 'Keep column order?', assumption: 'Yes.' }]);
  assert.equal(item.planQuestion.summary, 'Fictional plan: add the export');
  assert.equal(answer(f, item, 'proceed', { note: 'Half even.' }).status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'plan-review');
  assert.deepEqual(flow.carriedQuestions.map(({ from, question, assumption: assumed, answer: chosen, note }) => ({ from, question, assumed, chosen, note })), [
    { from: 'planner', question: 'Keep column order?', assumed: 'Yes.', chosen: undefined, note: undefined },
    { from: 'planner', question: 'Round half even or half up?', assumed: null, chosen: 'proceed', note: 'Half even.' }]);
});

// A flow at its merge question, with the given carried records on it.
async function mergeFixture(t, extra) {
  const workflow = { version: 1, start: 'decide', nodes: {
    decide: { kind: 'question', question: 'Merge?', role: 'operator', mergeDecision: true, requireEvidence: ['review'], answers: { merge: 'done', stop: 'stopped' } },
    done: { kind: 'end', outcome: 'stopped' }, stopped: { kind: 'end', outcome: 'stopped' } } };
  const f = sandbox(t);
  f.store.put('task', { ...f.store.need('task', 'task-1'), risk: 'ordinary' });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.start();
  const identity = repositoryIdentity(f.root), flow = f.store.need('flow', 'flow-1');
  const review = { route: 'pass', identity, result: { verdict: 'pass', summary: 'Fine', findings: [], riskAssessment: ordinary } };
  f.store.put('flow', { ...flow, mode: 'delivery', kind: 'change', pool: 'document', workflow, workflowDigest: digest(workflow), step: 'decide', results: { review }, evidence: { review: { ...identity, attemptId: 'review-attempt' } }, ...extra });
  return { f, item: await openQuestion(f) };
}

test('the merge question, the merge card and the completion notice list the carried questions', async t => {
  const carriedQuestions = [{ from: 'planner', attemptId: 'p1', question: 'Link back to the guide?', assumption: 'No link back.' }, { from: 'builder', attemptId: 'b1', question: 'Name the flag --limit\u009b31m?', assumption: 'Yes, --limit.' }];
  const { f, item } = await mergeFixture(t, { carriedQuestions });
  assert.ok(item, 'merge question opened');
  // A structured field of its own (review fix 4): the context is left as it was.
  assert.deepEqual(item.carriedQuestions, { questions: [{ question: 'Link back to the guide?', from: 'planner', assumption: 'No link back.' }, { question: 'Name the flag --limit?', from: 'builder', assumption: 'Yes, --limit.' }], overflow: null });
  assert.equal(item.context, undefined, 'nothing is appended to the context');
  // The completion notice lists them too.
  flowNotice(f.store, { ...f.store.need('flow', 'flow-1'), state: 'completed' }, 'completed');
  const notice = f.store.all('inbox').find(row => row.kind === 'notice' && row.outcome === 'completed');
  assert.match(notice.context, /Questions this flow went ahead on without an answer, with the answers assumed:\n1\. Planner asked: Link back to the guide\? Assumed: No link back\.\n2\. Builder asked: Name the flag --limit\? Assumed: Yes, --limit\./);
  assert.doesNotMatch(notice.context, C0_C1);
  // The console renders the item's field once, as its own card.
  const text = await consoleText(f);
  assert.ok(text.includes('Went ahead without an answer (2)'), 'card heading');
  assert.ok(text.includes('Builder: Name the flag --limit?') && text.includes('Assumed: Yes, --limit.'));
});

test('a merge question context that quotes the carried heading is shown whole (no text matching)', async t => {
  // Review fix 4: the console used to hide everything after the heading text wherever it appeared.
  const { f, item } = await mergeFixture(t, { carriedQuestions: [{ from: 'planner', attemptId: 'p1', question: 'Keep column order?', assumption: 'Yes.' }] });
  const context = 'Fictional adopted pull request notes.\n\nQuestions this flow went ahead on without an answer are discussed in the README.\n\nAfter the heading: the original pull request was unchanged.';
  f.store.put('inbox', { ...item, context });
  const text = await consoleText(f);
  // The paragraph has real newlines; the page's raw record of the item escapes them, so this matches the paragraph only.
  assert.ok(text.includes('in the README.\n\nAfter the heading: the original pull request was unchanged.'), 'unrelated context after the heading text is still shown');
  assert.ok(text.includes('Planner: Keep column order?'));
});

// Review fix 1: a later answer to the same question wins; earlier ones stay as history.
test('a corrected assumption replaces the earlier answer everywhere and keeps it as history', async t => {
  const f = fixture(t, { step: 'build' });
  settle(f, routed('implemented', buildResult({ assumptions: [assumption('Use CSV?', 'Yes')] })));
  let flow = f.store.need('flow', 'flow-1'); flow.step = 'build'; f.store.put('flow', flow);
  flow = settle(f, routed('implemented', buildResult({ assumptions: [assumption('  Use CSV?\n', 'No, JSON per corrected plan')] })));
  assert.equal(flow.carriedQuestions.length, 1);
  assert.equal(flow.carriedQuestions[0].assumption, 'No, JSON per corrected plan', 'the latest answer wins');
  assert.deepEqual(flow.carriedQuestions[0].history, [{ from: 'builder', attemptId: 'synthetic-build-0', assumption: 'Yes' }]);
  // Builders and reviewers get the current answer only.
  const spec = actionSpecification(f.store, { ...flow, step: 'review' }, flow.workflow.nodes.review, join(f.base, 'spec'));
  assert.deepEqual(spec.action.carriedQuestions.map(row => row.assumption), ['No, JSON per corrected plan']);
  const brief = await dispatch(f, 'provider.planReview', { verdict: 'pass', summary: 'Fictional', findings: [], riskAssessment: ordinary }, { carriedQuestions: spec.action.carriedQuestions });
  assert.match(brief.prompt, /"assumption":"No, JSON per corrected plan"/); assert.doesNotMatch(brief.prompt, /"assumption":"Yes"/);
  // The merge card shows that it changed, and from what.
  const { f: g, item } = await mergeFixture(t, { carriedQuestions: flow.carriedQuestions });
  assert.deepEqual(item.carriedQuestions.questions[0].history, [{ from: 'builder', assumption: 'Yes' }]);
  const text = await consoleText(g);
  assert.ok(text.includes('Assumed: No, JSON per corrected plan'));
  assert.ok(text.includes('Changed during the flow. Earlier: builder — Assumed: Yes'));
  flowNotice(g.store, { ...g.store.need('flow', 'flow-1'), state: 'completed' }, 'completed');
  assert.match(g.store.all('inbox').find(row => row.outcome === 'completed').context, /Assumed: No, JSON per corrected plan \(changed; earlier: builder: Assumed: Yes\)/);
});

// Review fix 3: nothing beyond the bound disappears silently; the flow stops instead of going on.
test('assumptions beyond the bound are counted, marked everywhere and stop the flow for the operator', async t => {
  const f = fixture(t);
  const many = Array.from({ length: 21 }, (_, i) => assumption(`Q${i + 1}?`, `A${i + 1}.`));
  const flow = settle(f, routed('ready', planResult({ assumptions: many })));
  assert.equal(flow.state, 'stopped', 'not sent on to plan review with a list missing Q21');
  assert.equal(flow.resumeStep, 'plan-review');
  assert.match(flow.stopReason, /1 more question the flow went ahead on could not be kept \(at most 20 are\); it is in the action-result\.json of attempt synthetic-plan-0/);
  assert.equal(flow.carriedQuestions.length, 20); assert.deepEqual(flow.carriedOverflow, { planner: 1, builder: 0, attemptIds: ['synthetic-plan-0'] });
  assert.ok(f.store.events().some(e => e.type === 'flow.carried-overflow'));
  // If the operator resumes anyway, every reader is told the list is incomplete.
  const spec = actionSpecification(f.store, { ...flow, step: 'plan-review' }, flow.workflow.nodes['plan-review'], join(f.base, 'spec'));
  assert.equal(spec.action.carriedQuestions.length, 20); assert.deepEqual(spec.action.carriedOverflow, { count: 1, attemptIds: ['synthetic-plan-0'] });
  const brief = await dispatch(f, 'provider.planReview', { verdict: 'pass', summary: 'Fictional', findings: [], riskAssessment: ordinary }, { carriedQuestions: spec.action.carriedQuestions, carriedOverflow: spec.action.carriedOverflow });
  assert.match(brief.prompt, /This list is incomplete: 1 more question/);
  const { f: g, item } = await mergeFixture(t, { carriedQuestions: flow.carriedQuestions, carriedOverflow: flow.carriedOverflow });
  assert.deepEqual(item.carriedQuestions.overflow, { count: 1, attemptIds: ['synthetic-plan-0'] });
  assert.ok((await consoleText(g)).includes('1 more question could not be kept on the flow, and the reviewers did not see it: the plan reviewer, the builder and the code reviewer were given only the list above, marked incomplete. Read the action-result.json of attempt synthetic-plan-0'));
  flowNotice(g.store, { ...g.store.need('flow', 'flow-1'), state: 'completed' }, 'completed');
  assert.match(g.store.all('inbox').find(row => row.outcome === 'completed').context, /1 more question the flow went ahead on could not be kept/);
  // Builds that fill the list cannot push a later plan's assumptions out silently either.
  const h = fixture(t, { step: 'build' });
  settle(h, routed('implemented', buildResult({ assumptions: Array.from({ length: 20 }, (_, i) => assumption(`B${i}?`, 'Yes.')) })));
  const later = h.store.need('flow', 'flow-1'); later.step = 'plan'; h.store.put('flow', later);
  const replanned = settle(h, routed('ready', planResult({ assumptions: [assumption('New plan question?', 'Yes.')] })));
  assert.equal(replanned.state, 'stopped'); assert.equal(replanned.carriedOverflow.planner, 1);
  // A proceed answer that could not carry its questions is refused rather than hiding them.
  const p = fixture(t);
  const full = p.store.need('flow', 'flow-1'); full.carriedQuestions = Array.from({ length: 20 }, (_, i) => ({ from: 'builder', attemptId: 'b', question: `B${i}?`, assumption: 'Yes.' })); p.store.put('flow', full);
  settle(p, routed('blocked', planResult({ questions: ['Round half even?'] })));
  const question = await openQuestion(p);
  const refused = answer(p, question, 'proceed');
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /more questions than the flow carries/);
  // A plan and build card say how many assumptions they do not show.
  const c = fixture(t);
  settle(c, routed('blocked', planResult({ questions: ['Which ledger?'], assumptions: Array.from({ length: 12 }, (_, i) => assumption(`P${i}?`, 'Yes.')) })));
  const card = await openQuestion(c);
  assert.match(card.context, /\(2 more assumptions in the plan attempt’s result\)/); assert.equal(card.planQuestion.omittedAssumptions, 2);
  // A plan whose own assumptions overflowed and that stops at its question cannot be proceeded either.
  const o = fixture(t);
  settle(o, routed('blocked', planResult({ questions: ['Which ledger?'], assumptions: many })));
  assert.equal(o.store.need('flow', 'flow-1').carriedOverflow.planner, 1);
  const overflowed = await openQuestion(o);
  assert.ok(overflowed.answers.includes('proceed'));
  assert.match(answer(o, overflowed, 'proceed').error, /more questions than the flow carries/);
});

test('flow.replan archives the carried questions as history and stops carrying them', async t => {
  const f = fixture(t, { step: 'build' });
  settle(f, routed('implemented', buildResult({ assumptions: [assumption('Use CSV?', 'Yes')] })));
  assert.equal(f.command('flow.replan', { flowId: 'flow-1', note: 'Start again with the corrected brief.' }).status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  assert.deepEqual(flow.carriedQuestions, []); assert.equal(flow.carriedOverflow, undefined);
  assert.equal(flow.carriedArchive.length, 1);
  assert.equal(flow.carriedArchive[0].question, 'Use CSV?'); assert.equal(flow.carriedArchive[0].archivedBecause, 'flow replanned');
  // A later plan's questions it no longer asks are archived too.
  const g = fixture(t);
  settle(g, routed('ready', planResult({ assumptions: [assumption('Old question?', 'Yes.')] })));
  let moved = g.store.need('flow', 'flow-1'); moved.step = 'plan'; g.store.put('flow', moved);
  moved = settle(g, routed('ready', planResult({ assumptions: [assumption('New question?', 'Yes.')] })));
  assert.deepEqual(moved.carriedQuestions.map(row => row.question), ['New question?']);
  assert.equal(moved.carriedArchive[0].archivedBecause, 'a later plan no longer asks it');
});

// Fix 2 (G2).
test('an implemented build that asks a blocking question opens a full build question card', async t => {
  const f = fixture(t, { step: 'build' });
  settle(f, routed('blocked', buildResult({ questions: ['Should --limit 0 mean no limit?\u009d0;spoof\u009c'], assumptions: [assumption('Keep the help text short?', 'Yes.')], departures: [{ from: 'Plan step 2', why: 'The helper already existed' }], unverified: ['Manual check of the help page'] })));
  const item = await openQuestion(f);
  assert.equal(f.store.need('flow', 'flow-1').step, 'build-question');
  assert.match(item.context, /^The builder reports the work implemented, but asks 1 question it cannot settle on its own\./);
  assert.match(item.context, /1\. Should --limit 0 mean no limit\?0;spoof/);
  assert.match(item.context, /What the builder did: Added the fictional export and its test/);
  assert.match(item.context, /Keep the help text short\? Assumed: Yes\./);
  assert.match(item.context, /Plan step 2: The helper already existed/); assert.match(item.context, /Manual check of the help page/);
  assert.match(item.context, /choose retry with a note that answers these questions; the builder continues in its session/);
  assert.doesNotMatch(item.context, C0_C1);
  assert.deepEqual(item.choices.map(c => [c.id, c.label]), [['retry', 'Answer and continue the build'], ['stop', 'Stop flow']]);
  assert.equal(item.buildQuestion.status, 'implemented'); assert.deepEqual(item.buildQuestion.questions, ['Should --limit 0 mean no limit?0;spoof']);
  // A blocked build without a question still gets its summary.
  const g = fixture(t, { step: 'build' });
  settle(g, routed('blocked', buildResult({ status: 'blocked', summary: 'The fixture repository has no test runner' })));
  const blocked = await openQuestion(g);
  assert.match(blocked.context, /^The builder is blocked and asked no question/); assert.match(blocked.context, /What the builder did: The fixture repository has no test runner/);
  // The console labels the note for the builder.
  const text = await consoleText(f);
  assert.ok(text.includes('Your answers to the builder’s questions') && text.includes('Answer and continue the build'));
  // Retry with a note reaches the builder as operator feedback.
  assert.equal(answer(f, item, 'retry', { note: '0 means no limit.' }).status, 'completed');
  assert.equal(f.store.need('flow', 'flow-1').operatorFeedback.at(-1).note, '0 means no limit.');
});

test('an implemented build with only assumptions goes on to commit and carries them; a project graph without a build question still works', async t => {
  const f = fixture(t, { step: 'build' });
  const assumptions = [assumption('Keep the help text short?', 'Yes.')];
  assert.equal((await dispatch(f, 'provider.build', buildResult({ assumptions }))).result.route, 'implemented');
  assert.equal((await dispatch(f, 'provider.build', buildResult({ questions: ['Which flag name?'], assumptions }))).result.route, 'blocked');
  const flow = settle(f, routed('implemented', buildResult({ assumptions })));
  assert.equal(flow.step, 'commit');
  assert.deepEqual(flow.carriedQuestions.map(row => [row.from, row.question, row.assumption]), [['builder', 'Keep the help text short?', 'Yes.']]);
  assert.deepEqual(flow.workerReports.at(-1).assumptions, assumptions);
  // A project graph whose blocked build goes straight to a stop (no build question) is unchanged.
  const custom = changeWorkflow(config); custom.nodes.build = { ...custom.nodes.build, resultEdges: { implemented: 'commit', blocked: 'stopped' } }; delete custom.nodes['build-question'];
  validateOperations(custom);
  const g = fixture(t, { workflow: custom, step: 'build' });
  assert.equal(settle(g, routed('implemented', buildResult({ assumptions }))).step, 'commit');
});

// Fix 3 (G3).
test('a replanning planner is given its previous plan with numbered questions and told to revise it', async t => {
  const f = sandbox(t);
  const previous = planResult({ status: 'blocked', summary: 'Export per account', questions: ['Round half even?', 'Include refunds?', 'CSV or JSON?', 'Header language?'], assumptions: [assumption('Keep column order?', 'Yes.')] });
  const { prompt } = await dispatch(f, 'provider.plan', planResult(), { results: { source: { head: repositoryIdentity(f.root).head }, plan: { result: previous } }, operatorFeedback: [{ step: 'plan-question', answer: 'replan', note: '1: half even; 2, 3, 4: your assumptions are accepted as written' }] });
  assert.match(prompt, /Your previous plan in this flow, as the operator and the plan reviewer saw it, with its questions numbered as the operator saw them/);
  assert.match(prompt, /"1\. Round half even\?","2\. Include refunds\?","3\. CSV or JSON\?","4\. Header language\?"/);
  assert.match(prompt, /"summary":"Export per account"/); assert.match(prompt, /Keep column order\?/);
  assert.match(prompt, /Revise this plan instead of starting over/);
  assert.match(prompt, /1: half even; 2, 3, 4: your assumptions are accepted as written/, 'the answer is in the same prompt');
  // Bounded: a huge previous plan does not grow the prompt without limit.
  const huge = planResult({ summary: 's'.repeat(50000), files: Array.from({ length: 500 }, (_, i) => `src/${'f'.repeat(400)}${i}.js`) });
  const bounded = await dispatch(f, 'provider.plan', planResult(), { results: { source: { head: repositoryIdentity(f.root).head }, plan: { result: huge } } });
  const section = bounded.prompt.slice(bounded.prompt.indexOf('Your previous plan'), bounded.prompt.indexOf('Revise this plan'));
  assert.ok(section.length < 17000, `previous plan section is ${section.length} characters`);
  // The first plan of a flow has no previous plan.
  const first = await dispatch(f, 'provider.plan', planResult(), { results: { source: { head: repositoryIdentity(f.root).head } } });
  assert.doesNotMatch(first.prompt, /Your previous plan/);
});

// Review fix 2: the numbered questions and the operator's answers are reserved before anything is cut.
test('the previous-plan brief keeps the numbered questions and answers however large the rest is', async t => {
  const f = sandbox(t), head = repositoryIdentity(f.root).head;
  const previous = planResult({ status: 'blocked', summary: 's'.repeat(4000), questions: ['Which account?'] });
  previous.files = Array.from({ length: 100 }, (_, i) => `src/${String(i).padStart(3, '0')}${'f'.repeat(292)}.js`);
  const { prompt } = await dispatch(f, 'provider.plan', planResult(), { results: { source: { head }, plan: { result: previous } }, operatorFeedback: [{ step: 'plan-question', answer: 'replan', note: '1: the savings account.' }] });
  const section = prompt.slice(prompt.indexOf('Your previous plan'), prompt.indexOf('Revise this plan'));
  assert.match(section, /"questions":\["1\. Which account\?"\]/, 'the question survives');
  assert.match(section, /"operatorAnswers":\["1: the savings account\."\]/, 'and the answer to it');
  assert.ok(section.length < 16500, `section is ${section.length} characters`);
  const omitted = JSON.parse(section.match(/"omitted":(\{[^}]*\})/)[1]);
  assert.ok(omitted.files > 0, 'the files that did not fit are counted');
  assert.match(section, /what was cut or left out to fit is counted in omitted/);
  // Ten long questions and three long answers still fit, with the rest counted.
  const crowded = planResult({ status: 'blocked', summary: 's'.repeat(4000), questions: Array.from({ length: 12 }, (_, i) => `Q${i + 1} ${'q'.repeat(990)}`) });
  crowded.files = previous.files;
  const notes = Array.from({ length: 4 }, (_, i) => ({ step: 'plan-question', answer: 'replan', note: `Answer ${i} ${'n'.repeat(1200)}` }));
  const full = (await dispatch(f, 'provider.plan', planResult(), { results: { source: { head }, plan: { result: crowded } }, operatorFeedback: notes })).prompt;
  const part = full.slice(full.indexOf('Your previous plan'), full.indexOf('Revise this plan'));
  for (let i = 1; i <= 10; i++) assert.ok(part.includes(`"${i}. Q${i} `), `question ${i}`);
  assert.match(part, /"omitted":\{"questions":2/, 'questions beyond ten are counted');
  for (const i of [1, 2, 3]) assert.ok(part.includes(`Answer ${i} `), `answer ${i}`);
  assert.ok(part.length < 16500, `section is ${part.length} characters`);
});

// Round 2 of the review.
test('questions that differ in case or inner spacing are different questions, never a correction', async t => {
  const flow = {};
  recordCarriedQuestions(flow, 'build', { result: { assumptions: [assumption('Export `UserID`?', 'Yes')] } }, 'b1');
  recordCarriedQuestions(flow, 'build', { result: { assumptions: [assumption('Export `userid`?', 'No')] } }, 'b2');
  recordCarriedQuestions(flow, 'build', { result: { assumptions: [assumption('Match "a  b"?', 'Yes')] } }, 'b3');
  recordCarriedQuestions(flow, 'build', { result: { assumptions: [assumption('Match "a b"?', 'No')] } }, 'b4');
  assert.deepEqual(flow.carriedQuestions.map(row => [row.question, row.assumption, row.history ?? null]), [
    ['Export `UserID`?', 'Yes', null], ['Export `userid`?', 'No', null], ['Match "a  b"?', 'Yes', null], ['Match "a b"?', 'No', null]]);
  // Only leading and trailing whitespace is ignored: that one is a correction.
  recordCarriedQuestions(flow, 'build', { result: { assumptions: [assumption(' Export `UserID`? ', 'No, per the corrected plan')] } }, 'b5');
  assert.equal(flow.carriedQuestions.length, 4);
  assert.equal(flow.carriedQuestions[0].assumption, 'No, per the corrected plan'); assert.equal(flow.carriedQuestions[0].history[0].assumption, 'Yes');
});

test('the previous-plan payload never exceeds its bound, even when escaping doubles the reserved text', () => {
  const quotes = '"'.repeat(1000), payload = brief => JSON.parse(brief.slice(brief.indexOf(': {') + 2, brief.indexOf('}\nRevise') + 1));
  const previous = { status: 'blocked', summary: 's'.repeat(4000), files: Array.from({ length: 100 }, () => 'f'.repeat(300)), questions: Array.from({ length: 10 }, () => quotes), assumptions: [assumption('Keep order?', 'Yes.')] };
  const brief = previousPlanBrief({ result: previous }, Array.from({ length: 3 }, () => ({ answer: 'replan', note: quotes })));
  const json = brief.slice(brief.indexOf(': {') + 2, brief.indexOf('}\nRevise') + 1), shown = payload(brief);
  assert.ok(json.length <= PREVIOUS_PLAN_CHARS, `payload is ${json.length} characters`);
  // Every question keeps its number and the start of its text, and says that it was cut.
  shown.questions.forEach((q, i) => { assert.ok(q.startsWith(`${i + 1}. ""`), q.slice(0, 20)); assert.match(q, /… \[cut to fit; \d+ characters in all\]$/); });
  assert.equal(shown.operatorAnswers.length, 3); assert.ok(shown.operatorAnswers.every(a => a.startsWith('""') && a.endsWith('characters in all]')));
  assert.deepEqual({ questionsCut: shown.omitted.questionsCut, answersCut: shown.omitted.answersCut }, { questionsCut: 10, answersCut: 3 });
  assert.equal(shown.omitted.files, 100); assert.equal(shown.omitted.summary, 'cut');
  // Short items are kept whole while long ones are cut, and nothing at all is cut when everything fits.
  const mixed = payload(previousPlanBrief({ result: { ...previous, questions: ['Which account?', ...Array.from({ length: 9 }, () => quotes)] } }, [{ answer: 'replan', note: '1: savings' }]));
  assert.equal(mixed.questions[0], '1. Which account?'); assert.equal(mixed.operatorAnswers[0], '1: savings');
  const small = payload(previousPlanBrief({ result: { ...previous, questions: ['Which account?'], files: [] } }, []));
  assert.equal(small.omitted, undefined); assert.equal(small.summary.length, 4000);
});

test('overflow beyond the named attempts is counted and said', () => {
  const flow = { carriedQuestions: Array.from({ length: 20 }, (_, i) => ({ from: 'builder', attemptId: 'b0', question: `B${i}?`, assumption: 'Yes.' })) };
  for (let i = 1; i <= 11; i++) recordCarriedQuestions(flow, 'build', { result: { assumptions: [assumption(`Extra ${i}?`, 'Yes.')] } }, `build-${i}`);
  const o = carriedOverflow(flow);
  assert.equal(o.count, 11); assert.equal(o.attemptIds.length, 10); assert.equal(o.attemptIds[0], 'build-2'); assert.equal(o.omittedAttempts, 1);
  assert.match(overflowMarker(o), /11 more questions .* attempts build-2, .*build-11 and of 1 earlier attempt not named here \(every plan and build attempt of this flow is in its attempt history\)\./);
});

// Fix 4 (G16).
test('status --task shows the acceptance criteria, per-task models and schedule time', async t => {
  const f = sandbox(t);
  // task.models needs a delivery project (tests/task-models.test.mjs); the read shows whatever the task records.
  f.store.put('task', { ...f.store.need('task', 'task-1'), models: { builder: { model: 'fictional-builder' } } });
  const notBefore = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
  assert.equal(f.command('task.schedule', { taskId: 'task-1', notBefore }).status, 'completed');
  const task = stateView(f.store, { task: 'task-1' }).task;
  assert.deepEqual(task.acceptance, ['Observed fixture behavior']);
  assert.equal(task.notBefore, f.store.need('task', 'task-1').notBefore);
  assert.deepEqual(task.models, { builder: { model: 'fictional-builder' } });
  // A task without them shows null, not a missing field.
  f.store.put('task', { ...f.store.need('task', 'task-1'), models: undefined });
  assert.equal(stateView(f.store, { task: 'task-1' }).task.models, null);
});

async function consoleText(f) {
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this._text = text; }
    append(...items) { this.children.push(...items.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false)); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(key, value) { this[key] = value; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? String(c)).join(''); }
    reportValidity() { return true; }
  }
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window'], old = Object.fromEntries(keys.map(k => [k, globalThis[k]])), storage = { getItem: () => null, setItem() {} };
  Object.assign(globalThis, { Node: Element, document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) }, localStorage: storage, sessionStorage: storage, window: { dispatchEvent() {}, confirm: () => true } });
  try {
    const { inboxView } = await import('../starter/factory/console/ui/inbox.mjs'), { state } = await import('../starter/factory/console/ui/state.mjs');
    const { dashboardSnapshot } = await import('../starter/factory/service/dashboard.mjs');
    const project = { projectId: f.project.projectId, bindingId: 'binding', name: 'Fictional', status: 'available', snapshot: { ...snapshot(f.store), inbox: dashboardSnapshot(f.store).inbox } };
    state.projects = [project];
    return inboxView(project, { params: {} }).textContent;
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
}
