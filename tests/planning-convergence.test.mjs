import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { changeWorkflow, documentWorkflow } from '../starter/factory/core/configuration.mjs';
import { executeCommand, publicFlow, snapshot, QUESTION_SUBJECT_CHANGED } from '../starter/factory/core/project.mjs';
import { validateOperations } from '../starter/factory/core/operations.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { COMMANDS } from '../starter/factory/core/command-help.mjs';
import { excerpt } from '../starter/factory/workflows/check-diagnostics.mjs';
import { cliFailureDetails } from '../starter/factory/adapters/github/errors.mjs';

// F15 and F12 of the dev.82 readiness trial: planning must converge on a strict task, and a
// planner's clarification question must reach the inbox with its questions.
const config = { policy: {}, repository: {} };
const ordinary = { level: 'ordinary', rationale: 'Fictional bounded change', threatModel: [], stopConditions: [] };
const strictIncomplete = { level: 'strict', rationale: 'Fictional saved ledger entries', threatModel: [], stopConditions: [] };
const strictComplete = { level: 'strict', rationale: 'Fictional saved ledger entries', threatModel: ['Imports overwrite entries'], stopConditions: ['Halt on a lost entry'] };
const OPERATIONS = { plan: 'provider.plan', 'plan-review': 'provider.planReview' };

function fixture(t, { workflow = changeWorkflow(config), risk = 'ordinary', policy } = {}) {
  const f = sandbox(t);
  assert.equal(f.command('task.put', { task: { id: f.task.id, title: 'Fictional ledger export', acceptance: ['Exports balance'], risk, paths: ['src/export.js'] } }).status, 'completed');
  if (policy) { const projectConfig = { ...f.store.meta('config', {}), policy }; f.store.setMeta('config', projectConfig); f.store.setMeta('configDigest', digest(projectConfig)); }
  f.start();
  // The flow has entered its plan step once, as admission and source verification would leave it.
  const flow = f.store.need('flow', 'flow-1');
  Object.assign(flow, { workflow, workflowDigest: digest(workflow), mode: 'delivery', kind: 'change', reviewProtocol: 'fresh-full', step: 'plan', visits: { source: 1, plan: 1 }, results: {}, evidence: {} });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.store.put('flow', flow);
  return { ...f, identity: repositoryIdentity(f.root) };
}
// Settle a synthetic attempt of the step the flow is at, as the engine would after the real dispatch.
function settle(f, result) {
  const flow = f.store.need('flow', 'flow-1'), step = flow.step, id = `synthetic-${step}-${f.store.all('attempt').length}`;
  const attempt = { id, flowId: flow.id, step, status: 'running', intent: { action: { operation: OPERATIONS[step] }, inputIdentity: f.identity }, intentDigest: digest(id) };
  flow.attemptId = id; f.store.put('flow', flow); f.store.put('attempt', attempt);
  f.engine.settle(flow.id, attempt, { exitCode: 0, costMicros: 0, actionResult: { ...result, identity: f.identity } });
  return f.store.need('flow', flow.id);
}
const plan = ({ status = 'ready', questions = [], riskAssessment = ordinary, pushback = [], summary = 'Fictional plan: add the export' } = {}) => ({
  route: status === 'ready' && !questions.length && (riskAssessment.level !== 'strict' || riskAssessment.threatModel.length) ? 'ready' : 'blocked',
  result: { status, summary, files: ['src/export.js'], checks: [], risks: [], questions, departures: [], unverified: [], pushback, riskAssessment },
});
const review = (verdict, message) => ({ route: verdict, result: { verdict, summary: 'Fictional plan review', findings: verdict === 'pass' ? [] : [{ severity: 'high', file: 'src/export.js', line: 1, message }], riskAssessment: ordinary } });
async function openQuestion(f) {
  await f.engine.step('flow-1');
  const item = f.store.all('inbox').find(row => row.kind === 'question' && row.status === 'open');
  assert.ok(item, `no open question at ${f.store.need('flow', 'flow-1').step}`);
  return item;
}
const answer = (f, item, value, extra = {}, actor) => f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: value, ...extra }, actor ? { actor } : undefined);

test('the reference graph allows three plan attempts per cycle and offers proceed at its plan question', () => {
  for (const graph of [changeWorkflow(config), documentWorkflow(config)]) {
    assert.equal(graph.nodes.plan.maxVisits, 3);
    assert.deepEqual(graph.nodes['plan-question'].answers, { replan: 'plan', proceed: 'plan-review', stop: 'stopped' });
    assert.doesNotMatch(graph.nodes['plan-question'].question, /update the task/i, 'a task edit would revoke approval');
    validateOperations(graph);
  }
  // A project graph keeps its own bound; proceed may not skip what a ready plan goes through.
  const custom = changeWorkflow(config); custom.nodes.plan.maxVisits = 5; custom.nodes['plan-question'].answers.proceed = 'publish-plan';
  assert.throws(() => validateOperations(custom), /must send proceed to the step a ready plan goes to/);
});

test('answering a plan question replans without using a plan attempt', async t => {
  const f = fixture(t);
  settle(f, plan({ status: 'blocked', questions: ['Should totals round half up or half even?'] }));
  const item = await openQuestion(f);
  assert.equal(answer(f, item, 'replan', { note: 'Round half even.' }).status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'plan');
  assert.deepEqual(publicFlow(flow).visitBudgets.plan, { allowance: 3, used: 1, remaining: 2, cumulative: 2 }, 'the replan after an answer is recorded but not counted');
  assert.equal(f.store.events().find(e => e.type === 'inbox.answered').payload.uncountedVisit, 'plan');
  assert.equal(flow.operatorFeedback.at(-1).note, 'Round half even.', 'the answer reaches the next planner');
});

test('a project graph keeps its plan bound, and an answered question still does not count against it', async t => {
  const workflow = changeWorkflow(config); workflow.nodes.plan.maxVisits = 1;
  const f = fixture(t, { workflow });
  settle(f, plan({ status: 'blocked', questions: ['Which export format?'] }));
  const item = await openQuestion(f);
  // Without a note too: an answer that only says "replan" (after the governing context changed) is free as well.
  assert.equal(answer(f, item, 'replan').status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.workflow.nodes.plan.maxVisits, 1, 'the configured value is kept');
  assert.equal(flow.step, 'plan'); assert.equal(publicFlow(flow).visitBudgets.plan.used, 1);
  // The bound itself still holds: a review revision now exhausts it.
  settle(f, plan());
  const stopped = settle(f, review('revise', 'Fictional missing case'));
  assert.equal(stopped.state, 'stopped'); assert.match(stopped.stopReason, /visit bound exhausted at plan/);
});

test('one clarification and two plan review revisions do not stop at the plan bound under the default', async t => {
  const f = fixture(t);
  settle(f, plan({ status: 'blocked', questions: ['Do refunds export as negative totals?'] }));
  assert.equal(answer(f, await openQuestion(f), 'replan', { note: 'Yes, negative totals.' }).status, 'completed');
  settle(f, plan());
  let flow = settle(f, review('revise', 'Missing the empty ledger case'));
  assert.equal(flow.step, 'plan');
  settle(f, plan());
  flow = settle(f, review('revise', 'Missing the zero-total case'));
  assert.equal(flow.step, 'plan', `stopped instead: ${flow.stopReason}`);
  settle(f, plan());
  flow = settle(f, review('pass'));
  assert.equal(flow.state, 'ready'); assert.equal(flow.step, 'publish-plan');
  assert.deepEqual(publicFlow(flow).visitBudgets.plan, { allowance: 3, used: 3, remaining: 0, cumulative: 4 });
});

test('a third plan review revision still stops at the default bound', async t => {
  const f = fixture(t);
  settle(f, plan()); settle(f, review('revise', 'Fictional finding one'));
  settle(f, plan()); settle(f, review('revise', 'Fictional finding two'));
  settle(f, plan()); const flow = settle(f, review('revise', 'Fictional finding three'));
  assert.equal(flow.state, 'stopped'); assert.match(flow.stopReason, /visit bound exhausted at plan \(3\/3/);
});

test('proceed sends a ready plan with non-blocking questions to plan review as it is', async t => {
  const f = fixture(t);
  settle(f, plan({ questions: ['Non-blocking: the plan assumes CSV headers stay in English; confirm?'] }));
  const item = await openQuestion(f);
  assert.deepEqual(item.answers, ['replan', 'proceed', 'stop']);
  assert.deepEqual(item.choices.map(c => [c.id, c.label]), [['replan', 'Replan with my answers'], ['proceed', 'Proceed with this plan'], ['stop', 'Stop flow']]);
  assert.equal(item.planQuestion.proceedable, true);
  const visits = f.store.need('flow', 'flow-1').visits.plan;
  assert.equal(answer(f, item, 'proceed', { note: 'English headers are right.' }).status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'plan-review'); assert.equal(flow.visits.plan, visits, 'no plan attempt is used');
  assert.equal(flow.results.plan.result.summary, 'Fictional plan: add the export', 'the exact plan goes on');
  assert.equal(flow.operatorFeedback.at(-1).answer, 'proceed'); assert.equal(flow.operatorFeedback.at(-1).note, 'English headers are right.');
});

test('proceed is neither offered nor accepted for a blocked plan or an incomplete strict assessment', async t => {
  const blocked = fixture(t);
  settle(blocked, plan({ status: 'blocked', questions: ['Which ledger owns refunds?'] }));
  const item = await openQuestion(blocked);
  assert.deepEqual(item.answers, ['replan', 'stop']); assert.equal(item.planQuestion.proceedable, false);
  assert.equal(answer(blocked, item, 'proceed').status, 'rejected');
  // Strict work: a ready plan with questions proceeds only with a complete threat model and stop conditions.
  const strict = fixture(t, { risk: 'strict' });
  settle(strict, plan({ questions: ['Non-blocking: keep the old export?'], riskAssessment: strictIncomplete }));
  const held = await openQuestion(strict);
  assert.deepEqual(held.answers, ['replan', 'stop']);
  assert.match(held.context, /threat model or stop conditions are incomplete/);
  const complete = fixture(t, { risk: 'strict' });
  settle(complete, plan({ questions: ['Non-blocking: keep the old export?'], riskAssessment: strictComplete }));
  const offered = await openQuestion(complete);
  assert.ok(offered.answers.includes('proceed'));
  assert.equal(answer(complete, offered, 'proceed').status, 'completed');
  // Plan review still runs; the strict merge sign-off is untouched by this answer.
  assert.equal(complete.store.need('flow', 'flow-1').step, 'plan-review');
  assert.equal(complete.store.need('flow', 'flow-1').mergeAuthorization ?? null, null);
});

test('proceed is refused for an unauthorised actor and after the subject or the plan changed', async t => {
  const f = fixture(t, { policy: { delegatedOperations: ['flow.note'] } });
  settle(f, plan({ questions: ['Non-blocking: keep column order?'] }));
  let item = await openQuestion(f);
  const command = (actor, onBehalfOf, payload = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), operation: 'answer', actor, ...(onBehalfOf ? { onBehalfOf } : {}), payload: { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'proceed', ...payload } });
  const onBehalfOf = { principal: 'operator', instruction: 'Proceed with the plan' };
  assert.equal(command('orchestrator').status, 'rejected', 'no recorded operator instruction');
  const undelegated = command('orchestrator', onBehalfOf);
  assert.equal(undelegated.status, 'rejected'); assert.match(undelegated.error, /answer is not delegated/);
  // The plan changed while its question was open: refused, and the stale question is replaced.
  const flow = f.store.need('flow', 'flow-1'); flow.results.plan = { ...flow.results.plan, result: { ...flow.results.plan.result, summary: 'A different fictional plan' } }; f.store.put('flow', flow);
  const changedPlan = command('operator');
  assert.equal(changedPlan.status, 'rejected'); assert.match(changedPlan.error, /plan changed since this question opened/);
  const fresh = await openQuestion(f);
  assert.notEqual(fresh.id, item.id); assert.equal(f.store.need('inbox', item.id).status, 'superseded');
  assert.match(fresh.context, /Plan summary: A different fictional plan/);
  // The candidate changed: the existing subject check refuses it.
  item = fresh;
  writeFileSync(join(f.root, 'input.txt'), 'changed outside the factory\n');
  execFileSync('git', ['commit', '-qam', 'Fictional out-of-band change'], { cwd: f.root });
  const changed = command('operator');
  assert.equal(changed.status, 'rejected'); assert.equal(changed.error, QUESTION_SUBJECT_CHANGED);
  assert.equal(f.store.need('flow', 'flow-1').step, 'plan-question');
});

test('a delegated orchestrator answers a plan question exactly as delegation allows', async t => {
  const f = fixture(t, { policy: { delegatedOperations: ['answer'] } });
  settle(f, plan({ questions: ['Non-blocking: keep column order?'] }));
  const item = await openQuestion(f);
  const receipt = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), operation: 'answer', actor: 'orchestrator', onBehalfOf: { principal: 'operator', instruction: 'Go ahead with that plan' }, payload: { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'proceed' } });
  assert.equal(receipt.status, 'completed'); assert.equal(f.store.need('inbox', item.id).answeredBy, 'orchestrator');
});

test('the plan question item carries the planner questions, options and risk and suggests a replan note', async t => {
  const f = fixture(t);
  const long = `Which rounding? ${'x'.repeat(5000)}`;
  settle(f, plan({ status: 'blocked', summary: 'Export totals per account\u001b[31m', riskAssessment: strictIncomplete,
    questions: ['Should a refund\u0000 export as a negative total or a separate row?', long],
    pushback: [{ ruleId: 'rule-csv', ruleText: 'Exports are CSV only', cost: 'Two formats to keep', proposal: 'Option B: allow JSON for the audit export' }] }));
  const item = await openQuestion(f);
  assert.match(item.context, /could not finish the plan and asks 2 questions/);
  assert.match(item.context, /1\. Should a refund export as a negative total or a separate row\?/);
  assert.match(item.context, /2\. Which rounding\?/);
  assert.match(item.context, /rule-csv: Option B: allow JSON for the audit export/);
  assert.match(item.context, /Risk: strict, escalated by the planner from ordinary\. Fictional saved ledger entries/);
  assert.match(item.context, /choose replan with a note that answers these questions/);
  assert.match(item.context, /Do not edit the task to answer: a task edit revokes its approval/);
  assert.doesNotMatch(item.context, /[\u0000-\u0008\u001b]/, 'control and terminal characters are removed');
  assert.ok(item.planQuestion.questions[1].length <= 1000 && item.context.length <= 12000, 'bounded');
  assert.deepEqual(item.planQuestion.risk, { level: 'strict', escalated: true, rationale: 'Fictional saved ledger entries', complete: false });
  assert.doesNotMatch(item.question, /update the task/i);
  assert.match(COMMANDS.answer[1].find(([field]) => field === 'answer')[2], /Proceed with this plan/);
});

test('planner and reviewer prompts ask for every in-scope finding in one round and separate blocking questions', async t => {
  const f = sandbox(t), prompts = [];
  const task = { id: 'fictional-task', title: 'Fictional task', acceptance: ['Observed fictional behavior'], risk: 'ordinary', revision: 'r1', paths: ['src/export.js'] };
  const head = repositoryIdentity(f.root).head;
  const action = operation => ({ cwd: f.root, timeoutMs: 60000, action: { operation, step: operation === 'provider.review' ? 'review' : undefined, task, config: { mode: 'rehearsal', repository: { slug: 'fictional/project', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'claude', model: 'synthetic' }, reviewer: { provider: 'claude', model: 'synthetic' } }, policy: {} }, risk: { level: 'ordinary' }, context: { files: [], digest: 'fictional-context' }, results: { source: { head }, plan: { result: { summary: 'Pinned fictional plan' } } }, reviewHistory: [], sessions: {}, artifactDir: join(f.base, 'artifacts', operation) } });
  const invoke = result => async spec => { prompts.push(spec.prompt); return { provider: 'fictional', model: 'synthetic', sessionId: 'fresh', result }; };
  await runAction(action('provider.plan'), { providerInvoke: invoke(plan().result) });
  await runAction(action('provider.planReview'), { providerInvoke: invoke(review('pass').result) });
  await runAction(action('provider.review'), { providerInvoke: invoke({ ...review('pass').result, strictReview: { fullDiffInspected: true, threatModelReviewed: true, stopConditionsReviewed: true }, scopeSummary: 'Fictional scope', priorFindingsDisposition: [] }) });
  const [planner, planReviewer, codeReviewer] = prompts;
  assert.match(planner, /Return status blocked only when the plan cannot be carried out without an answer/);
  assert.match(planner, /Put each question whose answer would not change the plan in assumptions instead/);
  for (const prompt of [planReviewer, codeReviewer]) {
    assert.match(prompt, /Report every blocking finding you can see in this one review: do not hold findings back for a later round/);
    assert.match(prompt, /its declared paths \(src\/export\.js\)/);
    assert.match(prompt, /check its neighbouring cases in the same review and report them together/);
    assert.match(prompt, /outside this scope are not blocking: mention them in summary, never as findings/);
  }
  assert.match(planReviewer, /judge this plan against the task's acceptance criteria/);
  assert.match(codeReviewer, /judge this change against the task's acceptance criteria/);
});

test('the console shows the planner questions and labelled replan and proceed forms', async t => {
  const f = fixture(t);
  settle(f, plan({ questions: ['Non-blocking: the plan assumes English CSV headers; confirm?'] }));
  const item = await openQuestion(f);
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this._text = text; }
    append(...items) { this.children.push(...items.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false)); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(key, value) { this[key] = value; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? String(c)).join(''); }
    reportValidity() { return true; }
  }
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window', 'fetch'], old = Object.fromEntries(keys.map(k => [k, globalThis[k]])), storage = { getItem: () => null, setItem() {} };
  Object.assign(globalThis, { Node: Element, document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) }, localStorage: storage, sessionStorage: storage, window: { dispatchEvent() {}, confirm: () => true } });
  try {
    const { inboxView } = await import('../starter/factory/console/ui/inbox.mjs'), { state } = await import('../starter/factory/console/ui/state.mjs');
    const project = { projectId: f.project.projectId, bindingId: 'binding', name: 'Fictional', status: 'available', snapshot: snapshot(f.store) };
    state.projects = [project];
    const view = inboxView(project, { params: {} }), text = view.textContent;
    assert.ok(text.includes('1. Non-blocking: the plan assumes English CSV headers; confirm?'));
    for (const label of ['Replan with my answers', 'Proceed with this plan', 'Your answers to the planner’s questions', 'Answers or assumptions for the plan reviewer and builder (optional)', 'Stop flow']) assert.ok(text.includes(label), label);
    const descendants = node => [node, ...node.children.flatMap(child => child instanceof Element ? descendants(child) : [])];
    const sent = []; globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'completed' }) }; };
    const proceed = descendants(view).find(n => n.tag === 'form' && n['aria-label']?.startsWith('Proceed with this plan'));
    for (const field of descendants(proceed).filter(n => n.name)) field.value = 'Headers stay English.';
    await proceed.handlers.submit({ preventDefault() {} });
    assert.deepEqual(sent.at(-1).payload, { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'proceed', note: 'Headers stay English.' });
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});

// Review fixes.
test('repeated clarification answers stop at a bound and never extend the transition allowance', async t => {
  const f = fixture(t);
  const limit = f.store.need('flow', 'flow-1').workflow.maxTransitions;
  let answered = 0, refused = null;
  for (let cycle = 0; cycle < 60 && !refused; cycle++) {
    settle(f, plan({ status: 'blocked', questions: ['Which default?'] }));
    const item = await openQuestion(f), receipt = answer(f, item, 'replan', { note: 'Use the default.' });
    if (receipt.status === 'completed') answered++; else refused = receipt;
    const flow = f.store.need('flow', 'flow-1');
    assert.equal(flow.transitionAllowance ?? 0, 0, 'a clarification never adds transition allowance');
    assert.ok(flow.transitions <= limit);
  }
  // Three free clarifications, then two counted plan entries (plan bound 3, the first entry already used).
  assert.equal(answered, 5); assert.ok(refused, 'the loop stopped at a bound');
  assert.match(refused.error, /visit bound exhausted at plan/);
  let flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'plan-question'); assert.equal(flow.planClarifications, 5, 'the refused answer is rolled back');
  assert.equal(flow.operatorFeedback.filter(row => row.note === 'Use the default.').length, 5, 'every note still reaches the planner');
  assert.deepEqual(f.store.events().filter(e => e.type === 'inbox.answered').sort((a, b) => a.sequence - b.sequence).map(e => e.payload.uncountedVisit ?? null), ['plan', 'plan', 'plan', null, null]);
  const open = f.store.all('inbox').find(row => row.kind === 'question' && row.status === 'open');
  assert.match(open.context, /free clarifications are used up/); assert.equal(open.planQuestion.freeClarifications, 0);
  // Recovery is a deliberate new cycle: it settles the open question and restores the clarifications.
  assert.equal(f.command('flow.replan', { flowId: 'flow-1', note: 'Operator settles the defaults in the brief context.' }).status, 'completed');
  flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'plan'); assert.equal(flow.planClarifications, 0); assert.equal(f.store.need('inbox', open.id).status, 'superseded');
});

test('long planner text never cuts the risk, the answering guidance or the task-edit warning', async t => {
  const f = fixture(t);
  settle(f, plan({ status: 'blocked', riskAssessment: strictIncomplete, summary: 's'.repeat(1500),
    questions: Array.from({ length: 10 }, (_, i) => `Q${i} ${'q'.repeat(995)}`),
    pushback: Array.from({ length: 5 }, (_, i) => ({ ruleId: `rule-${i}`, ruleText: 'Fictional rule', cost: 'c'.repeat(200), proposal: 'p'.repeat(400) })) }));
  const item = await openQuestion(f);
  assert.ok(item.context.length <= 12000, `context is ${item.context.length} characters`);
  assert.match(item.context, /^The planner could not finish the plan and asks 10 questions\./);
  assert.match(item.context, /Risk: strict, escalated by the planner from ordinary\. Fictional saved ledger entries The threat model or stop conditions are incomplete/);
  assert.match(item.context, /How to answer: choose replan with a note that answers these questions/);
  assert.match(item.context, /Do not edit the task to answer: a task edit revokes its approval and stops this flow\.$/);
  assert.match(item.context, /cut to fit; every question is in planQuestion\.questions/);
  assert.equal(item.planQuestion.questions.length, 10);
});

test('C1 control characters are removed from planner questions, check excerpts and forge error text', async t => {
  const f = fixture(t);
  settle(f, plan({ status: 'blocked', summary: 'Summary\u0085 line', questions: ['Clear\u009b2J the screen?', 'Title\u009d0;spoof\u009c here?'] }));
  const item = await openQuestion(f), c1 = /[\u0080-\u009f]/;
  assert.doesNotMatch(item.context, c1); assert.ok(item.planQuestion.questions.every(q => !c1.test(q)));
  assert.equal(item.planQuestion.questions[0], 'Clear the screen?', 'an 8-bit CSI sequence is removed whole');
  assert.equal(excerpt('ok\u009b31mred\u0085\u009d0;x\u009c done\n', 100).text, 'okred0;x done\n');
  assert.doesNotMatch(cliFailureDetails({ stderr: 'gh: failed\u009b2J\u0090 here' }).stderr, c1);
});
