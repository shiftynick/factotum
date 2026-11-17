// The real-browser pass of the console (trial R6) found operator-misleading displays that a
// fake DOM had not been asked about. These tests render the console views with a fake DOM from
// the data the project service now returns, and check the service side where the data changed.
// Fictional fixtures throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installDom, byClass, byTag, withText, click, descendants } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { executeCommand, publicAttempt } from '../starter/factory/core/project.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { observeQueue } from '../starter/factory/operations/queue-diagnostics.mjs';
import { startConsole, registerProject } from '../starter/factory/console/console.mjs';

const realFetch = globalThis.fetch;
installDom();
const { state, readPath, uiState, prefs } = await import('../starter/factory/console/ui/state.mjs');
const { flowDetail, clusterMarkers, resumeBlockers } = await import('../starter/factory/console/ui/timeline.mjs');
const { inboxView, itemHeading, staleAnswer } = await import('../starter/factory/console/ui/inbox.mjs');
const { projectOverview } = await import('../starter/factory/console/ui/overview.mjs');
const { receiptsView } = await import('../starter/factory/console/ui/receipts.mjs');
const { projectSettings } = await import('../starter/factory/console/ui/settings.mjs');
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const { tasksView } = await import('../starter/factory/console/ui/plan.mjs');
const { unitFor } = await import('../starter/factory/console/ui/stats.mjs');
const { time, localizeTimes, copyButton, forgeUrl, safeUrl } = await import('../starter/factory/console/ui/dom.mjs');
const { recordDetail } = await import('../starter/factory/console/ui/records.mjs');
const { HISTORY_KINDS } = await import('../starter/factory/console/ui/history.mjs');
const { mergeCandidateView } = await import('../starter/factory/console/ui/inbox.mjs');
const { flowNeedsAttention } = await import('../starter/factory/operations/notifications.mjs');
const { flowNotice } = await import('../starter/factory/core/project.mjs');

const NOW = Date.now(), ago = ms => new Date(NOW - ms).toISOString();
const HEAD = 'c0ffee'.padEnd(40, '1'), BASE = 'ba5e00'.padEnd(40, '2');
const RULE = 'A change to behaviour updates its verify step';
function project(snapshot = {}, settings = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [],
    ...snapshot, settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, fastChecks: { checks: [{ id: 'verify-step', rules: [RULE] }] }, ...settings } } };
}
// A canonical read the view would otherwise fetch, already answered.
function preload(p, kind, subject, data, query = {}) {
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, kind, subject, query)}`, { status: 'ready', data, fetchedAt: new Date().toISOString(), revision: p.snapshot.revision });
}
const text = node => node.textContent;
const settle = () => new Promise(resolve => setImmediate(resolve));

// ---- Flow detail: the record a fast-check failure, decisions, stop reason and candidate -----------
function flowFixture({ state: flowState = 'running', stopReason = 'Stopped by the operator to check the plan' } = {}) {
  const flow = { id: 'flow-1', taskId: 'task-1', kind: 'change', mode: 'delivery', state: flowState, step: flowState === 'completed' ? 'done' : 'build', createdAt: ago(900000), transitions: 9, stopReason,
    taskSnapshot: { title: 'Fictional change' }, workspace: { branch: 'factotum/fictional', base: BASE, head: BASE },
    evidence: { gate: { head: HEAD, treeDigest: 't', attemptId: 'gate-1' }, review: { head: HEAD, treeDigest: 't', attemptId: 'review-1' } },
    results: { publish: { number: 7, url: 'https://forge.invalid/fictional/demo/pull/7', head: HEAD } },
    answerNotes: [{ inboxId: 'q-replan', step: 'plan-question', answer: 'replan', note: 'Use the smaller scope', actor: 'orchestrator', onBehalfOf: { principal: 'operator', instruction: 'Operator in thread: "replan with the smaller scope"' }, at: ago(700000) }],
    mergeAuthorization: { inboxId: 'q-merge', actor: 'operator', authority: 'operator', reviewedHead: HEAD, answeredAt: ago(100000), identity: { head: HEAD } } };
  const receipt = (start, end) => ({ startedAt: ago(start), endedAt: ago(end), exitCode: 0 });
  const attempts = [
    { id: 'att-fast', flowId: 'flow-1', step: 'fast-check', status: 'passed', outcome: 'failed', route: 'fail', operation: 'fastCheck', failedChecks: [{ id: 'verify-step', status: 'failed', failureClass: 'product' }],
      checks: [{ id: 'verify-step', status: 'failed', failureClass: 'product', diagnostics: { format: 'check-diagnostics-v1', supplied: true, detail: 'RULE verify-step: src/app.txt changed but verify.sh was not updated', truncated: false } }],
      createdAt: ago(600000), dispatchedAt: ago(599000), settledAt: ago(590000), receipt: receipt(599000, 591000) },
    // Settled before the outcome field: recognised by its result's route.
    { id: 'att-older', flowId: 'flow-1', step: 'fast-check', status: 'passed', route: 'fail', createdAt: ago(800000), dispatchedAt: ago(799000), settledAt: ago(790000), receipt: receipt(799000, 791000) },
    { id: 'att-build', flowId: 'flow-1', step: 'build', status: 'passed', route: 'implemented', operation: 'provider.build', createdAt: ago(500000), dispatchedAt: ago(499000), settledAt: ago(400000), receipt: receipt(499000, 401000) },
  ];
  const choices = [{ id: 'send_back', label: 'Send back' }, { id: 'replan', label: 'Replan' }, { id: 'merge', label: 'Merge' }];
  const inbox = [
    { id: 'q-send', flowId: 'flow-1', kind: 'question', status: 'answered', question: 'Review asked for changes. What next?', choices, answer: 'send_back', answeredBy: 'operator', answeredAt: ago(650000), answerNote: 'Keep the old header row', createdAt: ago(660000) },
    { id: 'q-replan', flowId: 'flow-1', kind: 'question', status: 'answered', question: 'The plan is ready. Proceed?', choices, answer: 'replan', answeredBy: 'orchestrator', answeredAt: ago(700000), createdAt: ago(710000) },
    { id: 'q-merge', flowId: 'flow-1', kind: 'question', status: 'answered', question: 'Merge? Strict outcome: the designated reviewer must inspect the exact candidate.', strictReview: { head: HEAD }, choices, answer: 'merge', answeredBy: 'operator', answeredAt: ago(100000), createdAt: ago(200000) },
  ];
  return { projectId: 'fictional', flow, attempts, inbox, events: [], waits: [], contexts: [], pushback: [], obligations: [], regressions: [], retrospective: null };
}
function renderFlow(detail, attempt) {
  const p = project({ flows: [{ ...detail.flow }] });
  preload(p, 'flows', detail.flow.id, detail);
  return flowDetail(p, detail.flow.id, { params: attempt ? { attempt } : {} });
}

test('defect 1: a failed fast check is drawn as failed, with its check, rules and diagnostics in the attempt view', () => {
  const view = renderFlow(flowFixture(), 'att-fast');
  // The drawn run bar of an attempt (its accessible name is on the tap target above it: dev.94, R2).
  const bar = id => byClass(view, 'bar').find(n => n.dataset.attempt === id && n.dataset.kind === 'run');
  assert.ok(bar('att-fast').classList.includes('tone-bad'), 'the failed fast check is not drawn green');
  assert.ok(!bar('att-fast').classList.includes('tone-good'));
  assert.ok(bar('att-older').classList.includes('tone-bad'), 'an attempt recorded before the outcome field is recognised by its route');
  assert.ok(bar('att-build').classList.includes('tone-good'));
  const panel = byClass(view, 'attempt-panel')[0];
  assert.match(text(panel), /Failed checks/); assert.match(text(panel), /verify-step/); assert.match(text(panel), /product failure/);
  assert.ok(text(panel).includes(RULE), 'the rule the check enforces is shown');
  assert.match(text(panel), /verify\.sh was not updated/);
  assert.match(text(panel), /Outcome\s*\S*\s*failed the step ran to completion and reported a failure \(route fail\)/);
  assert.match(text(panel), /Process exit\s*code 0 \(the step runner process, not the outcome\)/);
  assert.doesNotMatch(text(panel), /Outcome\s*\S*\s*passed/);
  // Only files a non-model step can have are offered: no provider logs (they would be a 404).
  const options = byClass(panel, 'segmented').flatMap(n => byTag(n, 'button')).map(text);
  assert.ok(options.includes('action-result.json')); assert.ok(!options.some(name => name.startsWith('provider/')), options.join(', '));
});

test('defect 3: Decisions shows each answer, who gave it (including on the operator\'s behalf), when, its note and the merge sign-off', () => {
  const view = renderFlow(flowFixture());
  const decisions = byClass(view, 'decisions')[0], shown = text(decisions);
  assert.match(shown, /Answered “Send back” by the operator/); assert.match(shown, /Note: Keep the old header row/);
  assert.match(shown, /Answered “Replan” by the orchestrator on behalf of the operator/);
  assert.match(shown, /Operator instruction it acted on: “Operator in thread: "replan with the smaller scope"”/);
  assert.match(shown, /Note: Use the smaller scope/, 'a note kept only in the flow record (older items) is shown too');
  assert.match(shown, /Merge signed off by the operator for commit c0ffee111111 after an exact-head strict review/);
  assert.ok(shown.includes(time(ago(100000))), 'the answer time is shown');
});

test('defect 5: the stop reason is shown only while the flow is stopped', () => {
  assert.doesNotMatch(text(renderFlow(flowFixture({ state: 'running' }))), /Stop reason/);
  assert.doesNotMatch(text(renderFlow(flowFixture({ state: 'completed' }))), /Stop reason/);
  assert.match(text(renderFlow(flowFixture({ state: 'stopped' }))), /Stop reason\s*Stopped by the operator to check the plan/);
  const flow = { id: 'flow-9', taskId: 'task-9', kind: 'change', step: 'review', createdAt: ago(5000), stopReason: 'Earlier stop', taskSnapshot: { title: 'Resumed work' } };
  const overview = state => text(projectOverview(project({ flows: [{ ...flow, state }] })));
  assert.doesNotMatch(overview('running'), /Earlier stop/); assert.match(overview('stopped'), /Stop reason: Earlier stop/);
});

test('defect 4: the flow summary labels the workspace branch, its starting point and the candidate commit', () => {
  const shown = text(renderFlow(flowFixture()));
  assert.match(shown, /Workspace branch\s*factotum\/fictional/);
  assert.match(shown, new RegExp(`Created from\\s*${BASE.slice(0, 10)}… \\(target head when the workspace was made\\)`));
  assert.match(shown, /Candidate commit\s*c0ffee111111 gated and reviewed/);
  assert.doesNotMatch(shown, /Workspace\s*branch factotum\/fictional · head/);
});

test('defect 2: a resolved question keeps its own status after its expiry passes', () => {
  const item = { id: 'q-old', flowId: null, standalone: true, kind: 'question', status: 'answered', title: 'Which colour?', question: 'Which colour?', choices: [{ id: 'green', label: 'Green' }], answer: 'green', answeredBy: 'orchestrator', answeredAt: ago(11 * 3600000), createdAt: ago(12 * 3600000), expiresAt: ago(3600000), version: 2 };
  const open = { ...item, id: 'q-open', status: 'open', answer: undefined, answeredAt: undefined, answeredBy: undefined, version: 1 };
  uiState('inbox').filter = 'all';
  const p = project({ inbox: [item, open] }); state.projects = [p];
  const view = inboxView(p, { params: {} });
  const header = id => byTag(view, 'article').find(n => n.attributes.id === `decision-${id}`).children[0];
  assert.match(text(header('q-old')), /answered/); assert.doesNotMatch(text(header('q-old')), /Expired/);
  assert.match(text(header('q-open')), /Expired/, 'an open question past its expiry is still badged Expired');
});

// ---- The merge question: real snapshot from a real open merge question ----------------------------
const mergeWorkflow = { version: 1, start: 'decide', nodes: {
  decide: { kind: 'question', question: 'Merge?', role: 'operator', mergeDecision: true, answers: { merge: 'merge', stop: 'stopped' } },
  merge: { kind: 'effect', action: { operation: 'forge.merge' }, timeoutMs: 60000, next: 'done', onFailure: 'failed' },
  done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' }, stopped: { kind: 'end', outcome: 'stopped' } } };
async function mergeQuestion(t, { adopted = false } = {}) {
  const f = sandbox(t);
  f.store.put('task', { ...f.store.need('task', 'task-1'), risk: 'ordinary' });
  f.store.setMeta('workflow', mergeWorkflow); f.store.setMeta('workflowDigest', digest(mergeWorkflow));
  f.start();
  const identity = repositoryIdentity(f.root), flow = f.store.need('flow', 'flow-1');
  const review = { route: 'pass', phase: 'full', identity, result: { verdict: 'pass', summary: 'The header row is kept.', findings: [{ severity: 'low', file: 'src/a.js', line: 1, message: 'Fictional nit' }], riskAssessment: { level: 'ordinary', rationale: 'Copy change', threatModel: [], stopConditions: [] } } };
  const gate = { route: 'pass', inputIdentity: identity, checks: [{ id: 'acceptance', status: 'passed' }, { id: 'lint', status: 'passed' }] };
  const publish = { route: 'published', number: 7, url: 'https://forge.invalid/fictional/demo/pull/7', head: identity.head, branch: 'factotum/fictional' };
  // An adopted external PR whose original moved after adoption (R5): two commits are not delivered.
  const adoption = adopted ? { candidate: { number: 42, head: identity.head, base: identity.head }, originalPRObservation: { number: 42, url: 'https://forge.invalid/fictional/demo/pull/42', status: 'moved', adoptedHead: identity.head, head: 'd'.repeat(40), checkedAt: new Date().toISOString(), commits: [{ sha: 'e'.repeat(40), title: 'Fictional follow-up commit' }, { sha: 'f'.repeat(40), title: 'Another fictional commit' }], commitCount: 2 } } : {};
  f.store.put('flow', { ...flow, ...adoption, mode: 'delivery', kind: 'change', workflow: mergeWorkflow, workflowDigest: digest(mergeWorkflow), step: 'decide', results: { review, gate, publish, integrate: { base: identity.head } }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
  await f.engine.step('flow-1');
  const item = f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open');
  assert.ok(item, 'merge question opened');
  return { ...f, identity, item };
}

test('defect 4: the snapshot gives an open merge question its candidate, pull request, review and checks', async t => {
  const f = await mergeQuestion(t);
  const listed = dashboardSnapshot(f.store).inbox.find(row => row.id === f.item.id), m = listed.mergeContext;
  assert.equal(m.candidate, f.identity.head);
  assert.deepEqual(m.pullRequest, { number: 7, url: 'https://forge.invalid/fictional/demo/pull/7', adopted: false });
  assert.equal(m.review.verdict, 'pass'); assert.equal(m.review.findings, 1); assert.deepEqual(m.review.bySeverity, { low: 1 }); assert.equal(m.review.current, true);
  assert.equal(m.gate.route, 'pass'); assert.equal(m.gate.current, true); assert.deepEqual(m.gate.checks.map(c => c.id), ['acceptance', 'lint']);
  assert.equal(m.fastChecks, null);
  // The stored question is unchanged; only the snapshot carries the context.
  assert.equal(f.store.need('inbox', f.item.id).mergeContext, undefined);
});

test('defect 4: the merge question card shows the pull request, labelled candidate commit, review, checks and a diff link', async t => {
  const f = await mergeQuestion(t);
  const snapshot = dashboardSnapshot(f.store), p = { ...project(snapshot, { ...snapshot.settings, repository: { slug: 'fictional/demo', target: 'main', hostname: 'forge.invalid' } }) };
  uiState('inbox').filter = 'open'; state.projects = [p];
  const view = inboxView(p, { params: {} }), card = byClass(view, 'merge-candidate')[0];
  assert.ok(card, 'the merge question has a Candidate section');
  const shown = text(card), links = byTag(card, 'a');
  assert.match(shown, /Candidate/); assert.match(shown, new RegExp(`Candidate commit\\s*${f.identity.head.slice(0, 12)}`));
  assert.ok(links.some(a => a.getAttribute('href') === 'https://forge.invalid/fictional/demo/pull/7' && text(a) === '#7'), 'pull request link');
  assert.ok(links.some(a => a.getAttribute('href') === 'https://forge.invalid/fictional/demo/pull/7/files' && /View the changes on forge\.invalid/.test(text(a))), 'diff link on the forge');
  assert.match(shown, /Review\s*\S*\s*pass 1 finding \(0 critical, 0 high, 0 medium, 1 low\) · full review/);
  assert.match(shown, /Checks\s*\S*\s*passed 2 of 2 passed: acceptance, lint/);
  assert.match(shown, /Review summary: The header row is kept\./);
});

test('defect 4 with R5: an adopted pull request\'s merge card shows the original, its undelivered commits and the project\'s context', async t => {
  const f = await mergeQuestion(t, { adopted: true });
  const snapshot = dashboardSnapshot(f.store), listed = snapshot.inbox.find(row => row.id === f.item.id);
  assert.deepEqual(listed.mergeContext.adoptedFrom, { number: 42, head: f.identity.head });
  assert.equal(listed.mergeContext.pullRequest.adopted, false, 'the published replacement is not itself the adopted PR');
  assert.equal(listed.role, 'operator'); assert.match(listed.context, /Fictional follow-up commit/, 'R5 context is on the question');
  const p = project(snapshot, { ...snapshot.settings, repository: { slug: 'fictional/demo', target: 'main', hostname: 'forge.invalid' } });
  uiState('inbox').filter = 'open'; state.projects = [p];
  const view = inboxView(p, { params: {} }), article = byTag(view, 'article').find(n => n.attributes.id === `decision-${f.item.id}`);
  const card = byClass(article, 'merge-candidate')[0], shown = text(card);
  assert.match(text(article), /original pull request #42 .*changed after adoption/i, 'the project\'s own context text is shown');
  assert.match(shown, /Pull request\s*#7 \(replaces adopted #42\)/);
  assert.match(shown, /Original pull request\s*#42 changed after adoption: head now dddddddddddd/);
  assert.match(shown, /Not delivered\s*eeeeeeeeeeee Fictional follow-up commit\s*ffffffffffff Another fictional commit/);
  assert.match(shown, /answered by the operator only/);
  assert.ok(byTag(card, 'a').some(a => a.getAttribute('href') === 'https://forge.invalid/fictional/demo/pull/42'));
});

test('defect 3 (record): an orchestrator answering a flow question for the operator keeps the instruction on the answer', async t => {
  const f = await mergeQuestion(t);
  const instruction = { principal: 'operator', instruction: 'Operator in thread: "merge it"' };
  const receipt = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'answer', payload: { inboxId: f.item.id, version: f.item.version, subjectDigest: f.item.subjectDigest, answer: 'merge' }, onBehalfOf: instruction });
  assert.equal(receipt.status, 'completed', receipt.error);
  const answered = f.store.need('inbox', f.item.id);
  assert.equal(answered.answeredBy, 'orchestrator'); assert.deepEqual(answered.onBehalfOf, instruction);
});

// ---- Commissioning required: Overview and receipts ----------------------------------------------
test('defect 6: with commissioning required, Overview shows the hold with a link to Run doctor, not an idle open project', () => {
  const p = project({ commissioningRequired: true }, { commissioningRequired: true, doctorRequest: null });
  const view = projectOverview(p), shown = text(view);
  assert.match(shown, /Commissioning required/);
  assert.doesNotMatch(shown, /\bIdle\b/); assert.doesNotMatch(shown, /Project admission is open/); assert.doesNotMatch(shown, /Approve a task and start it from Tasks/);
  assert.doesNotMatch(shown, /qualification run from the CLI/);
  const run = byTag(view, 'a').filter(a => text(a) === 'Run doctor in Settings');
  assert.ok(run.length && run.every(a => a.getAttribute('href') === '#/p/fictional/settings?section=status'), 'links to Settings → Status');
  // While doctor runs, Overview says so.
  const running = project({ commissioningRequired: true }, { commissioningRequired: true, doctorRequest: { id: 'dr-1', status: 'running', configDigest: 'config-1', requestedAt: ago(1000), by: 'operator' } });
  assert.match(text(projectOverview(running)), /Doctor is running\./);
});

test('defect 6: Run doctor reports an accepted request, and Receipts follow the run to its real outcome', async t => {
  const p = project({ commissioningRequired: true }, { commissioningRequired: true, doctorRequest: null, commissioning: null });
  state.projects = [p]; state.unresolved = new Set();
  const button = withText(projectSettings(p), 'button', 'Run doctor')[0];
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ projectId: 'fictional', commandId: 'c-1', status: 'completed', receipt: { status: 'completed', result: { id: 'dr-1', status: 'queued' } } }) });
  await click(button);
  assert.match(state.message.text, /Run doctor — request accepted; doctor is queued and runs next/);
  assert.doesNotMatch(state.message.text, /Run doctor — completed/);
  const journal = [{ projectId: 'fictional', commandId: 'c-1', bindingId: 'binding-1', operation: 'doctor.request', status: 'completed', submittedAt: ago(5000), receipt: { status: 'completed', result: { id: 'dr-1' } } }];
  state.journal = journal;
  const at = status => text(receiptsView(state.projects[0] = project({}, { doctorRequest: { id: 'dr-1', status, configDigest: 'config-1', startedAt: ago(4000), ...(status === 'failed' ? { finishedAt: ago(1000), reasons: ['Fictional provider is not signed in'] } : {}) } })));
  assert.match(at('queued'), /Request accepted · \S*\s*Doctor queued/);
  assert.match(at('running'), /Request accepted · \S*\s*Doctor running/);
  assert.match(at('passed'), /Doctor passed/);
  assert.match(at('failed'), /Doctor failed[\s\S]*Fictional provider is not signed in/);
  state.journal = []; state.projects = [];
});

// ---- Smaller items ----------------------------------------------------------------------------------
test('times name their zone, and raw ISO timestamps in recorded text are shown as zoned times', () => {
  prefs.timeZone = 'local';
  assert.match(time('2026-11-15T04:55:21.474Z'), /\d{2}:\d{2}:\d{2}\s+\S*[A-Za-z]\S*$/, 'a zone name follows the time');
  const local = localizeTimes('Held until 2026-11-15T15:33:03.000Z for the hold');
  assert.doesNotMatch(local, /T15:33:03\.000Z/); assert.ok(local.includes(time('2026-11-15T15:33:03.000Z')));
  prefs.timeZone = 'utc'; assert.match(time('2026-11-15T04:55:21.474Z'), /04:55:21 UTC$/); prefs.timeZone = 'local';
});

test('Health names every main check, including scheduled-only checks a merge-tier run did not include', () => {
  const p = project({ mainHealth: { status: 'green', head: HEAD, checkedAt: ago(1000), tier: 'merge', tiers: ['merge'], checks: [{ id: 'unit', status: 'passed' }], scheduled: { status: 'green', head: HEAD, checkedAt: ago(7200000), checks: [{ id: 'browser-suite', passed: true }], failed: [] } } },
    { mainChecks: [{ id: 'unit', tier: 'merge' }, { id: 'browser-suite', tier: 'scheduled' }, { id: 'nightly-audit', tier: 'scheduled' }] });
  const shown = text(operationsView(p));
  assert.match(shown, /browser-suite · scheduled tier, not part of this run · last full verification/);
  assert.match(shown, /nightly-audit · scheduled tier, not part of this run · no full verification recorded yet/);
});

test('open-item counts agree: Overview counts open inbox items and to-dos together, as the sidebar and Inbox tab do', () => {
  const p = project({ inbox: [{ id: 'n-1', kind: 'notice', status: 'open', title: 'A fictional notice', createdAt: ago(1000), version: 1 }], obligations: [{ id: 'o-1', status: 'pending', title: 'Close the fictional issue' }, { id: 'o-2', status: 'pending', title: 'Tag the fictional release' }] });
  const kpi = byClass(projectOverview(p), 'kpi').find(n => /Open inbox items/.test(text(n)));
  assert.equal(text(byClass(kpi, 'kpi-value')[0]), '3'); assert.match(text(kpi), /1 questions and notices · 2 to-dos/);
});

test('a title-less notice is headed by its first sentence and not repeated as its heading', () => {
  assert.equal(itemHeading({ summary: 'Queued work has 2 free slots. Inspect the reasons.' }), 'Queued work has 2 free slots.');
  assert.equal(itemHeading({ title: 'Given title', summary: 'Body.' }), 'Given title');
});

test('the idle-capacity notice has a title and keeps showing current reasons between reminders without a new version', t => {
  const f = sandbox(t), start = Date.now();
  const config = f.store.meta('config'); f.store.setMeta('config', { ...config, mode: 'delivery', policy: { ...config.policy, autoQueue: true, maxFlows: 2 } });
  f.store.setMeta('commissioning', { ready: true }); f.store.put('queue', { id: 'task-1', status: 'queued', order: 1 });
  let reason = 'provider held until 2026-11-15T12:55:00.000Z';
  const tick = nowMs => observeQueue(f.store, { reasonsForTask: () => [reason], nowMs, idleAfterMs: 100, repeatMs: 100000 });
  tick(start); tick(start + 200);
  const first = f.store.need('inbox', 'queue:idle-capacity');
  assert.equal(first.title, 'Queued work is not starting although slots are free');
  reason = 'provider held until 2026-11-15T15:33:00.000Z'; tick(start + 300);
  const refreshed = f.store.need('inbox', 'queue:idle-capacity');
  assert.equal(refreshed.version, first.version, 'a refresh does not notify again');
  assert.deepEqual(refreshed.blockers, [{ taskId: 'task-1', reasons: ['provider held until 2026-11-15T15:33:00.000Z'] }]);
});

test('close timeline markers are drawn as one counted marker', () => {
  const groups = clusterMarkers([{ at: 1000 }, { at: 1002 }, { at: 1004 }, { at: 5000 }].map(m => ({ ...m, event: { type: 'flow.stopped', at: new Date(m.at).toISOString() } })), 0, 10000, 1);
  assert.deepEqual(groups.map(g => g.markers.length), [3, 1]);
});

test('Copy link reports success without touching a released event target', async t => {
  const old = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });
  t.after(() => { if (old) Object.defineProperty(globalThis, 'navigator', old); });
  const button = copyButton('Copy link', () => 'http://127.0.0.1/#/p/fictional/overview');
  // A real click event loses currentTarget once the handler awaits.
  await button.handlers.click[0]({ currentTarget: null });
  assert.equal(text(button), 'Copied');
});

test('a refused stale answer says what the project now records', () => {
  const p = project({ inbox: [{ id: 'q-1', status: 'answered', answer: 'friday', choices: [{ id: 'friday', label: 'Friday' }], answeredBy: 'operator', answeredAt: ago(30000) }] });
  assert.match(staleAnswer('q-1')(p, 'stale or resolved question'), /already been answered “Friday” by the operator .* not applied/);
  assert.equal(staleAnswer('q-1')(p, 'some other refusal'), '');
});

test('Resume explains a still-running attempt rather than calling it a fault', () => {
  assert.match(resumeBlockers({ attemptId: 'a1' }, [{ id: 'a1', status: 'running' }])[0], /still finishing/);
  assert.match(resumeBlockers({ attemptId: 'a1' }, [{ id: 'a1', status: 'uncertain' }])[0], /needs reconciliation/);
  assert.deepEqual(resumeBlockers({ attemptId: null }, []), []);
});

test('Tasks counts what the filter shows, and a paused project\'s task detail does not promise automatic admission', () => {
  const tasks = Array.from({ length: 10 }, (_, i) => ({ id: `task-${i}`, title: `Fictional task ${i}`, revision: 'r1', approvedRevision: i < 3 ? null : 'r1', closed: i >= 3, status: i >= 3 ? 'completed' : 'open', labels: [] }));
  const p = project({ paused: true, taskCount: 10, queueComplete: true, queueRevision: 'q1' }, { policy: { autoQueue: true } });
  preload(p, 'collections', 'task', { items: tasks, total: 10, nextCursor: null }, { cursor: '0', limit: '50', order: 'desc' });
  const shown = text(tasksView(p, { params: {} }));
  assert.match(shown, /3 shown of 10 tasks on this page · 10 total/);
  assert.doesNotMatch(shown, /The queue admits it automatically/); assert.match(shown, /nothing is admitted now: admission is paused/);
});

test('Settings → Status mentions Run doctor above only when it is offered', () => {
  const passed = text(projectSettings(project({}, { commissioningRequired: false, commissioning: { ready: true, current: true, checkedAt: ago(1000), reasons: [] } })));
  assert.doesNotMatch(passed, /Run doctor above/);
  assert.match(text(projectSettings(project({}, { commissioningRequired: true }))), /Run doctor above/);
});

test('sample units are singular for one sample', () => {
  assert.equal(unitFor(1, 'documents'), 'document'); assert.equal(unitFor(2, 'documents'), 'documents'); assert.equal(unitFor(1, 'changes'), 'change');
});

test('the console keeps a project service 404 (an artifact a step never wrote) instead of reporting a console fault', async t => {
  const root = await mkdtemp(join(tmpdir(), 'fct-r6-')); t.after(() => rm(root, { recursive: true, force: true }));
  const socketPath = join(root, 'service.sock'), stateDir = join(root, 'private');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://local'); res.setHeader('content-type', 'application/json');
    if (url.pathname === '/v1/handshake') return res.end(JSON.stringify({ projectId: 'alpha', serviceId: 'service-alpha', protocolVersion: 1, name: 'Fictional alpha', capabilities: ['snapshot', 'command', 'commandStatus'] }));
    res.writeHead(404); res.end(JSON.stringify({ error: 'artifact not available' }));
  });
  await new Promise(resolve => server.listen(socketPath, resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const binding = await registerProject(stateDir, { socketPath }, { timeoutMs: 2000 });
  const app = await startConsole({ stateDir, timeoutMs: 2000 }); t.after(() => app.close());
  const page = await realFetch(app.url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const response = await realFetch(`${app.url}/api/project/alpha/artifacts/attempt-1?bindingId=${encodeURIComponent(binding.bindingId)}&name=provider%2Fstdout.jsonl`, { headers: { cookie } });
  assert.equal(response.status, 404); assert.match((await response.json()).error, /artifact not available/);
});

test('defect 1 (record): an attempt settled before the outcome field is projected with its routed outcome', () => {
  const view = publicAttempt({ id: 'a', status: 'passed', intent: { action: { operation: 'gate' }, secret: 'NOT-PUBLIC' }, receipt: { exitCode: 0, actionResult: { route: 'fail', checks: [{ id: 'acceptance', status: 'failed', failureClass: 'product' }, { id: 'lint', status: 'passed' }] } } });
  assert.equal(view.outcome, 'failed'); assert.equal(view.route, 'fail'); assert.equal(view.operation, 'gate'); assert.equal(view.status, 'passed');
  assert.deepEqual(view.failedChecks, [{ id: 'acceptance', status: 'failed', failureClass: 'product' }]);
  assert.ok(!JSON.stringify(view).includes('NOT-PUBLIC'));
  assert.equal(publicAttempt({ id: 'b', status: 'passed', receipt: { actionResult: { route: 'pass' } } }).outcome, undefined);
  assert.equal(publicAttempt({ id: 'c', status: 'failed', receipt: { actionResult: { route: 'fail' } } }).outcome, undefined, 'a failed run keeps its own status');
});

await settle();

// ---- Review fixes ------------------------------------------------------------------------------
const failedCheckAttempt = { id: 'att-fast', flowId: 'flow-1', step: 'fast-check', status: 'passed', outcome: 'failed', route: 'fail', operation: 'fastCheck', failedChecks: [{ id: 'verify-step', status: 'failed', failureClass: 'product' }], createdAt: ago(600000), settledAt: ago(590000), receipt: { startedAt: ago(599000), endedAt: ago(591000), exitCode: 0 } };

test('review 1: History rows, filters and the attempt record show a failed check as failed, with the exit code apart', () => {
  const detail = text(recordDetail('attempt', failedCheckAttempt, project()));
  assert.match(detail, /Outcome\s*\S*\s*failed the step ran to completion and reported a failure \(route fail\)/);
  assert.match(detail, /Lifecycle\s*settled cleanly \(status passed\); the flow followed the step's fail route/);
  assert.match(detail, /Failed checks\s*verify-step \(failed, product\)/);
  assert.match(detail, /Process exit\s*code 0 \(the step runner process, not the outcome\)/);
  assert.doesNotMatch(detail, /Outcome\s*\S*\s*passed/); assert.doesNotMatch(detail, /Exit code/);
  const kind = HISTORY_KINDS.attempt, older = { ...failedCheckAttempt, id: 'att-older', outcome: undefined, failedChecks: undefined };
  assert.equal(kind.status(failedCheckAttempt), 'failed', 'the Failed filter includes it'); assert.equal(kind.status(older), 'failed', 'an older attempt by its route');
  assert.equal(kind.status({ ...failedCheckAttempt, outcome: undefined, route: 'pass' }), 'passed');
  const statusColumn = kind.columns.find(c => c.label === 'Status');
  assert.match(text(statusColumn.render(failedCheckAttempt)), /failed/); assert.doesNotMatch(text(statusColumn.render(failedCheckAttempt)), /passed/);
  // A plain successful attempt still reads passed, with its exit code.
  const ok = text(recordDetail('attempt', { ...failedCheckAttempt, outcome: undefined, route: 'pass', failedChecks: undefined }, project()));
  assert.match(ok, /Outcome\s*\S*\s*passed/); assert.match(ok, /Process exit\s*code 0 \(the step runner process\)/);
});

const HOSTILE = ['javascript:alert(1)', 'http://forge.invalid/fictional/demo/pull/7', 'https://outside.invalid/fictional/demo/pull/7', 'https://user:secret@forge.invalid/fictional/demo/pull/7', 'https://forge.invalid/other/repo/pull/7'];
const repo = { slug: 'fictional/demo', target: 'main', hostname: 'forge.invalid' };
const hrefs = node => byTag(node, 'a').map(a => a.getAttribute('href'));

test('review 2: forge and record URLs are linked only when https, credential-free and on the configured repository', () => {
  for (const bad of HOSTILE) assert.equal(forgeUrl(repo, bad), null, bad);
  assert.equal(forgeUrl(repo, 'https://forge.invalid/fictional/demo/pull/7'), 'https://forge.invalid/fictional/demo/pull/7');
  assert.equal(forgeUrl(repo, 'https://forge.invalid/fictional/demo-evil/pull/7'), null, 'a sibling repository with the same prefix');
  assert.equal(forgeUrl({ slug: '../x', hostname: 'forge.invalid' }, 'https://forge.invalid/x'), null);
  for (const bad of ['javascript:alert(1)', 'http://example.invalid/', 'https://user:secret@example.invalid/', 'data:text/html,hi']) assert.equal(safeUrl(bad), null, bad);
  assert.equal(safeUrl('https://example.invalid/issue/3'), 'https://example.invalid/issue/3');
});

test('review 2: the merge card never links a recorded URL that is not on the configured forge, including the /files diff link', () => {
  const p = project({}, { repository: repo });
  for (const bad of HOSTILE) {
    // No number: the card cannot build the link from trusted data, so the recorded URL decides.
    const item = { id: 'q', status: 'open', mergeContext: { candidate: HEAD, base: BASE, pullRequest: { number: null, url: bad, adopted: false }, review: null, gate: null, fastChecks: null, adoptedFrom: null } };
    const links = hrefs(mergeCandidateView(p, item));
    assert.ok(!links.some(href => href.includes(bad) || href.startsWith('javascript:') || href.startsWith('http:') || href.includes('outside.invalid') || href.includes('secret')), `${bad}: ${links.join(' ')}`);
    assert.ok(links.includes(`https://forge.invalid/fictional/demo/compare/${BASE}...${HEAD}`), 'the diff link is built from the repository and commits instead');
  }
  // With a number, links are built from the repository whatever URL the record carries.
  const item = { id: 'q', status: 'open', originalPR: { number: 42, url: 'javascript:alert(1)', status: 'unchanged', checkedAt: ago(1000) }, mergeContext: { candidate: HEAD, base: BASE, pullRequest: { number: 7, url: 'javascript:alert(2)', adopted: false }, adoptedFrom: { number: 42, head: HEAD }, review: null, gate: null, fastChecks: null } };
  const links = hrefs(mergeCandidateView(p, item));
  assert.deepEqual(links.sort(), ['https://forge.invalid/fictional/demo/commit/' + HEAD, 'https://forge.invalid/fictional/demo/pull/42', 'https://forge.invalid/fictional/demo/pull/7', 'https://forge.invalid/fictional/demo/pull/7/files'].sort());
  // Without a configured repository nothing is linked.
  assert.deepEqual(hrefs(mergeCandidateView(project({}, { repository: null }), item)), []);
});

test('review 2: the flow summary, strict candidate links, inbox links and task source links validate record URLs', () => {
  const detail = flowFixture(); detail.flow.results.publish = { number: null, url: 'javascript:alert(1)', head: HEAD };
  const p = project({ flows: [detail.flow] }, { repository: repo }); preload(p, 'flows', 'flow-1', detail);
  const summary = flowDetail(p, 'flow-1', { params: {} });
  assert.ok(!hrefs(summary).some(href => href.startsWith('javascript:')));
  assert.match(text(summary), /Pull request\s*On the forge/);
  const items = [
    { id: 'q-strict', flowId: 'flow-1', kind: 'question', status: 'open', role: 'operator', question: 'Merge?', answers: ['merge'], strictReview: { head: HEAD, threatModel: [], stopConditions: [] }, version: 1, subjectDigest: 'd', createdAt: ago(1000), expiresAt: new Date(NOW + 3600000).toISOString() },
    { id: 'n-links', kind: 'notice', status: 'open', title: 'Fictional notice', version: 1, createdAt: ago(1000), links: [{ label: 'Safe', url: 'https://example.invalid/a' }, { label: 'Thread', url: 't3-thread://fictional' }, { label: 'Plain', url: 'http://example.invalid/b' }, { label: 'Secret', url: 'https://user:secret@example.invalid/c' }, { label: 'Script', url: 'javascript:alert(1)' }] },
  ];
  const withFlow = project({ inbox: items, flows: [{ ...detail.flow, results: { publish: { url: 'https://outside.invalid/fictional/demo/pull/7' } } }] }, { repository: repo }); state.projects = [withFlow]; uiState('inbox').filter = 'open';
  const inbox = inboxView(withFlow, { params: {} }), links = hrefs(inbox);
  assert.ok(links.includes('https://example.invalid/a') && links.includes('t3-thread://fictional'));
  assert.ok(!links.some(href => /^(javascript|http):|secret|outside\.invalid/.test(href)), links.join(' '));
  assert.match(text(inbox), /Plain \(http:\/\/example\.invalid\/b, not linked\)/);
  assert.ok(links.includes(`https://forge.invalid/fictional/demo/commit/${HEAD}`), 'the strict candidate commit link is built from the repository');
  state.projects = [];
});

test('review 3: a fast-check failure the builder corrected is not attention, and the completion notice summarises it', t => {
  const f = sandbox(t); f.start();
  const flow = { ...f.store.need('flow', 'flow-1'), state: 'completed', kind: 'change', finishedAt: new Date().toISOString(), results: { publish: { route: 'published' } } };
  f.store.put('flow', flow);
  f.store.put('attempt', { ...failedCheckAttempt, id: 'att-1', flowId: 'flow-1', settledAt: ago(5000) });
  // An attempt settled before the outcome field: recognised from its receipt.
  f.store.put('attempt', { id: 'att-2', flowId: 'flow-1', step: 'fast-check', status: 'passed', createdAt: ago(4000), settledAt: ago(3500), receipt: { exitCode: 0, actionResult: { route: 'fail', checks: [{ id: 'verify-step', status: 'failed', failureClass: 'product' }] } } });
  f.store.put('attempt', { id: 'att-3', flowId: 'flow-1', step: 'fast-check', status: 'passed', createdAt: ago(3000), settledAt: ago(2000), receipt: { exitCode: 0, actionResult: { route: 'pass', checks: [{ id: 'verify-step', status: 'passed' }] } } });
  assert.equal(flowNeedsAttention(f.store, flow, 'completed'), false);
  f.store.tx(() => flowNotice(f.store, flow, 'completed'));
  const notice = f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.kind === 'notice' && row.outcome === 'completed');
  assert.match(notice.context, /Corrected on the way: fast-check reported a failure 2 times \(verify-step\)\. Each time the flow went back to the builder/);
});

// Re-check of 19ddfd1: the changes link is built on the URL path, never appended after a query or fragment.
test('pull request changes links drop the query and fragment of a recorded URL', async () => {
  const { pullRequestFiles } = await import('../starter/factory/console/ui/inbox.mjs');
  assert.equal(pullRequestFiles('https://github.com/owner/repo/pull/7?view=all#discussion'), 'https://github.com/owner/repo/pull/7/files');
  assert.equal(pullRequestFiles('https://github.com/owner/repo/pull/7/'), 'https://github.com/owner/repo/pull/7/files');
});
