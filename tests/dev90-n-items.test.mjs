// The dev.89 readiness re-test findings N1–N5 (docs/changes/dev90-n-items.md).
// Each test's first failing assertion on the base (624710e) is the finding it is about.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { executorDigest } from '../starter/factory/core/effects.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { refusalNotice } from '../starter/factory/workflows/refusal-notice.mjs';
import { deliverDue, queueDelivery } from '../starter/factory/operations/notifications.mjs';
import * as triage from '../starter/project/integrations/triage.example.mjs';

const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, '..');
const DISPATCH = join(repo, 'starter/factory/workflows/dispatch.mjs');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const read = path => readFileSync(join(repo, path), 'utf8');

// ---- N1: an enforcement refusal's notice says what was refused and what to do ----
const context = { maxChars: 16000, files: [
  { id: 'house-style', path: 'GUIDE.md', required: true },
  { id: 'project-agents', path: 'AGENTS.md', required: true },
] };
const assessment = { level: 'ordinary', rationale: 'Fictional', threatModel: [], stopConditions: [] };
const effect = (operation, resultEdges, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: 60000, next: Object.values(resultEdges)[0], onFailure: 'failed', resultEdges, ...extra });
// Build, then the factory's own commit, then review: the commit refuses the governing change.
const graph = { version: 1, start: 'build', nodes: {
  build: effect('provider.build', { implemented: 'commit', blocked: 'failed' }, { maxVisits: 3 }),
  commit: effect('workspace.commit', { committed: 'review' }),
  review: effect('provider.review', { pass: 'done', revise: 'build' }, { preserveInput: true }),
  done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' },
} };
// A fictional builder that leaves an edit of AGENTS.md uncommitted, for the factory's commit step.
const builder = (f, edit = root => writeFileSync(join(root, 'AGENTS.md'), 'Fictional project rule: anything goes.\n')) => async spec => {
  const base = { provider: spec.provider, model: spec.model, family: spec.provider === 'codex' ? 'openai' : 'anthropic', sessionId: 'fictional-session' };
  if (spec.role === 'builder') {
    edit(f.store.need('flow', 'flow-1').workspace.path);
    return { ...base, result: { status: 'implemented', summary: 'Fictional', departures: [], unverified: [], pushback: [], questions: [], assumptions: [] } };
  }
  return { ...base, result: { verdict: 'pass', summary: 'Fictional', findings: [], riskAssessment: assessment, strictReview: { fullDiffInspected: true, threatModelReviewed: true, stopConditionsReviewed: true }, scopeSummary: 'Fictional', priorFindingsDisposition: [] } };
};
async function governedProject(t, { governingEdits = null } = {}) {
  const f = sandbox(t);
  writeFileSync(join(f.root, 'GUIDE.md'), 'Fictional house style.\n');
  writeFileSync(join(f.root, 'AGENTS.md'), 'Fictional project rule: entries balance.\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Fictional governing files');
  const ghPath = join(f.base, 'gh'); writeFileSync(ghPath, `#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');\n`, { mode: 0o700 });
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', ghPath }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, checks: [{ id: 'verify', argv: ['true'], timeoutMs: 60000 }], context };
  assert.equal(f.command('config.update', { config, note: 'Fictional delivery' }).status, 'completed');
  // An ordinary task, with no governingEdits, that may touch AGENTS.md by its paths.
  assert.equal(f.command('task.put', { task: { id: f.task.id, title: 'Fictional change', acceptance: ['Fictional'], risk: 'ordinary', paths: ['input.txt', 'AGENTS.md', ...(governingEdits ? ['GUIDE.md'] : [])], ...(governingEdits ? { governingEdits } : {}) } }).status, 'completed');
  assert.equal(f.command('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision }).status, 'completed');
  const task = f.store.need('task', f.task.id), head = repositoryIdentity(f.root).head;
  // The owned workspace, as workspace.prepare makes it; its base is the comparison commit.
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'flow-1', baseRef: head });
  const flow = { id: 'flow-1', taskId: task.id, taskSnapshot: structuredClone(task), taskRevision: task.revision, approvalVersion: task.approvalVersion, workflow: graph, workflowDigest: digest(graph), configDigest: f.store.meta('configDigest'), mode: 'delivery', kind: 'change', target: 'main', reviewProtocol: 'fresh-full', effectiveRisk: 'ordinary', riskAssessments: [], completionMode: 'merge', candidate: null, executorDigest: executorDigest(), step: 'build', state: 'ready', stopRequested: false, abortRequested: false, transitions: 0, visits: { build: 1 }, evidence: {}, results: { source: { head } }, sessions: {}, attemptId: null, workspace, governanceBase: workspace.base, createdAt: new Date().toISOString() };
  f.store.setMeta('workflow', graph); f.store.setMeta('workflowDigest', digest(graph)); f.store.put('flow', flow);
  return f;
}

test('N1: a governing edit refused at workspace.commit fails the flow with a notice naming the file and both remedies, and status --flow carries it', async t => {
  const f = await governedProject(t), invoke = builder(f);
  // The build, run in process.
  await f.engine.step('flow-1');
  let attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: await runAction({ ...attempt.intent }, { providerInvoke: invoke }) });
  assert.equal(f.store.need('flow', 'flow-1').step, 'commit');
  // The commit, run as the supervisor runs it: dispatch.mjs as its own process, writing action-result.json.
  await f.engine.step('flow-1');
  attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  const spec = join(f.base, 'spec.json'), { intent } = attempt;
  mkdirSync(intent.action.artifactDir, { recursive: true });
  writeFileSync(spec, JSON.stringify({ ...intent, intentDigest: digest(intent) }));
  const run = spawnSync(process.execPath, [DISPATCH, spec], { cwd: intent.cwd, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 1, run.stderr);
  const actionResult = JSON.parse(readFileSync(join(intent.action.artifactDir, 'action-result.json'), 'utf8'));
  assert.equal(actionResult.route, 'error');
  assert.match(actionResult.error, /^workspace\.commit: the candidate [0-9a-f]{12} changes governing context project-agents \(AGENTS\.md\)/, 'the refusal itself is unchanged');
  assert.ok(actionResult.notice, 'dev.89: the refusal gave no notice, so the flow said only "inspect retained attempt evidence"');
  f.engine.settle('flow-1', attempt, { exitCode: 1, costMicros: 0, actionResult });
  await f.engine.step('flow-1');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.state, 'failed');
  const notice = f.store.by('inbox', 'flowId', 'flow-1').filter(row => row.kind === 'notice').at(-1);
  assert.ok(notice, 'one notice for the failed flow');
  const text = JSON.stringify(notice);
  assert.doesNotMatch(text, /inspect retained attempt evidence/);
  assert.match(text, /Change workflow failed at commit: The candidate of task task-1 changes governing file project-agents \(AGENTS\.md\), which the task is not approved to change \(it names no governingEdits\), so workspace\.commit refused it\./);
  assert.match(text, /put a task revision that names project-agents in governingEdits, with AGENTS\.md in its paths, approve that revision directly as the operator \(task\.approve\), and start the task again \(task\.restart\)/, 'remedy one: approve the edit');
  assert.match(text, /Otherwise undo the change: start the task again \(task\.restart\) with a note that AGENTS\.md must stay unchanged\./, 'remedy two: undo it');
  assert.match(text, /Refusal: workspace\.commit: the candidate [0-9a-f]{12} changes governing context project-agents/, 'the refusal is quoted');
  // status --flow: the failed flow says why.
  const view = stateView(f.store, { flow: 'flow-1' });
  assert.equal(view.flow.state, 'failed');
  assert.equal(view.flow.failure?.step, 'commit');
  assert.equal(view.flow.failure.attemptId, attempt.id);
  assert.match(view.flow.failure.notice, /^The candidate of task task-1 changes governing file project-agents \(AGENTS\.md\)/);
  assert.equal(view.attempts.at(-1).notice, view.flow.failure.notice, 'the attempt row carries its notice too');
});

test('N1: a governing edit refused before review stops the flow with the same notice, remedies for a stopped flow', async t => {
  const f = await governedProject(t), invoke = builder(f);
  // A graph whose build goes straight to review, so the before-review boundary decides.
  const direct = { ...graph, nodes: { ...graph.nodes, build: { ...graph.nodes.build, next: 'review', resultEdges: { implemented: 'review', blocked: 'failed' } } } };
  f.store.tx(() => { const flow = f.store.need('flow', 'flow-1'); flow.workflow = direct; flow.workflowDigest = digest(direct); f.store.put('flow', flow); f.store.setMeta('workflow', direct); f.store.setMeta('workflowDigest', digest(direct)); });
  await f.engine.step('flow-1');
  const attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: await runAction({ ...attempt.intent }, { providerInvoke: invoke }) });
  git(f.store.need('flow', 'flow-1').workspace.path, 'commit', '-qam', 'Fictional candidate');
  assert.equal(f.store.need('flow', 'flow-1').step, 'review');
  await f.engine.tick();
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.state, 'stopped');
  assert.match(flow.stopReason, /^The candidate of task task-1 changes governing file project-agents \(AGENTS\.md\), which the task is not approved to change \(it names no governingEdits\), so review \(before review\) refused it\./);
  assert.match(flow.stopReason, /Otherwise undo the change: replan the flow \(flow\.replan\) with a note that AGENTS\.md must stay unchanged\./);
  assert.match(flow.stopReason, /Refusal: review \(before review\): the candidate/);
  assert.equal(stateView(f.store, { flow: 'flow-1' }).flow.stopReason, flow.stopReason);
});

test('N1, review of 8441ff4: an approved governing edit that also changes an unnamed governing file and the approved file\'s mode is refused at commit with both parts of the notice', async t => {
  const f = await governedProject(t, { governingEdits: ['project-agents'] });
  const invoke = builder(f, root => { writeFileSync(join(root, 'AGENTS.md'), 'Fictional project rule: entries are dated.\n'); chmodSync(join(root, 'AGENTS.md'), 0o755); writeFileSync(join(root, 'GUIDE.md'), 'Fictional house style: anything.\n'); });
  await f.engine.step('flow-1');
  let attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: await runAction({ ...attempt.intent }, { providerInvoke: invoke }) });
  await f.engine.step('flow-1');
  attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  let error = null; try { await runAction({ ...attempt.intent }); } catch (caught) { error = caught; }
  assert.equal(error?.refusal?.kind, 'governing-file', error?.stack);
  assert.deepEqual(error.refusal.files.map(row => [row.id, row.path, row.approved]).sort(), [['house-style', 'GUIDE.md', false], ['project-agents', 'AGENTS.md', true]]);
  assert.match(error.notice, /^The candidate of task task-1 changes governing file house-style \(GUIDE\.md\), which the task is not approved to change \(its approved governingEdits name only project-agents\), so workspace\.commit refused it\./);
  assert.match(error.notice, /It also changes project-agents \(AGENTS\.md\) in a way an approval never covers \(a link, a move or a mode change; only the file's content may change\), so workspace\.commit refused it\. Undo that part of the change: start the task again \(task\.restart\) with a note that the file keeps its path and mode\./);
});

test('N1, review of 8441ff4: refusal-notice reads only the boundary\'s refusal field, and every boundary sets it', () => {
  // Errors with the old scattered fields and no `refusal` get no notice: every boundary sets `refusal`.
  for (const fields of [{ governingBoundary: ['project-agents'] }, { upkeepViolations: [{ code: 'undeclared' }] }, { upkeepEnding: 'base-moved' }, { upkeepMarker: true }, { refusal: { kind: 'unknown-kind' } }])
    assert.equal(refusalNotice(Object.assign(new Error('workspace.commit: refused'), fields), { task: { id: 'task-1' }, where: 'workspace.commit' }), '', JSON.stringify(fields));
  // The provider-configuration refusals are tested on their real path in tests/provider-worktree-isolation.test.mjs.
  const provider = refusalNotice(Object.assign(new Error('workspace.integrate: the candidate abc changes provider configuration (.claude/settings.json)'), { refusal: { kind: 'provider-config', paths: ['.claude/settings.json'] } }), { task: { id: 'task-3' }, where: 'workspace.integrate' });
  assert.match(provider, /^The candidate of task task-3 changes provider configuration \(\.claude\/settings\.json\) that the task does not declare in its paths, so workspace\.integrate refused it\..*Otherwise undo the change/);
  // A long refusal keeps the remedy; the cut falls in the quoted refusal.
  const long = refusalNotice(Object.assign(new Error(`workspace.commit: ${'x'.repeat(5000)}`), { refusal: { kind: 'governing-file', files: [{ id: 'project-agents', path: 'AGENTS.md', approved: false }], approvedEdits: [] } }), { task: { id: 'task-4' }, where: 'workspace.commit' });
  assert.ok(long.length <= 2000);
  assert.match(long, /must stay unchanged\. Refusal: /);
  // Every boundary in this branch sets it.
  for (const [path, kind] of [['starter/factory/operations/governance-edit.mjs', 'governing-file'], ['starter/factory/workflows/upkeep-enforcement.mjs', 'upkeep-limits'], ['starter/factory/core/upkeep-namespace.mjs', 'upkeep-marker'], ['starter/factory/workflows/dispatch.mjs', 'upkeep-conflict'], ['starter/factory/workflows/dispatch.mjs', 'upkeep-merge-in-progress'], ['starter/factory/operations/provider-config.mjs', 'provider-config'], ['starter/factory/operations/provider-config.mjs', 'provider-config-link']])
    assert.ok(read(path).includes(`refusal: { kind: '${kind}'`) || read(path).includes(`refusal = { kind: '${kind}'`), `${path} tags ${kind}`);
});

// ---- N2: the triage proxy's failure modes ----
const THREAD = 'fictional-orchestrator-thread';
const readLog = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function proxyProject(t, level = 'essential') {
  const f = sandbox(t), configPath = join(f.base, 'notifications.json'), sent = [];
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level, configPath } });
  let clock = Date.now() + 1000;
  const deliver = async () => { clock += 1000; for (const row of f.store.all('inbox')) queueDelivery(f.store, { inboxId: row.id }); const before = sent.length; await deliverDue(f.store, { configPath, nowMs: clock, limit: 100, transport: async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; } }); return sent.slice(before); };
  const ok = (operation, payload, options) => { const r = f.command(operation, payload, options); assert.equal(r.status, 'completed', JSON.stringify(r)); return r.result; };
  // The proxy's state and its log in separate folders, so the state alone can be made unwritable.
  const dir = mkdtempSync(join(tmpdir(), 'fct-n2-')); t.after(() => { try { chmodSync(join(dir, 'state'), 0o700); } catch {} rmSync(dir, { recursive: true, force: true }); });
  mkdirSync(join(dir, 'state'), { mode: 0o700 }); mkdirSync(join(dir, 'log'), { mode: 0o700 });
  const files = { memoryPath: join(dir, 'state', 'state.json'), logPath: join(dir, 'log', 'log.jsonl'), statePath: join(dir, 'read.json') };
  ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const wake = (body, extra = {}) => { writeFileSync(files.statePath, JSON.stringify(stateView(f.store, body.inboxId ? { inbox: body.inboxId } : { task: body.taskId }))); return triage.runRecorded('wake', { ...files, input: JSON.stringify(body), projectId: f.project.projectId, ...extra }); };
  return { ...f, deliver, ok, dir, files, wake };
}
const canDenyWrites = typeof process.getuid !== 'function' || process.getuid() !== 0;

test('N2: a run that cannot write its state logs no forward, so nothing stays unconfirmed with no end', { skip: !canDenyWrites && 'running as root: a read-only folder does not stop writes' }, async t => {
  const f = proxyProject(t);
  const notice = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional notice', context: 'Fictional.' });
  const [body] = (await f.deliver()).filter(row => row.inboxId === notice.id);
  // The state folder is read-only for this run: the state write fails, the log is still writable.
  chmodSync(join(f.dir, 'state'), 0o500);
  assert.throws(() => f.wake(body), /EACCES|permission denied/i);
  chmodSync(join(f.dir, 'state'), 0o700);
  const entries = readLog(f.files.logPath);
  assert.deepEqual(triage.unconfirmedForwards(entries, null, { nowMs: Date.now() + 3600000 }), [], 'dev.89: the forward was logged as decided, and no run ever re-sent, escalated or closed it');
  assert.equal(entries.filter(e => e.decision === 'forward').length, 0, 'no decision is logged for a run that could not record it');
  // The delivery itself is untouched: the next run decides it afresh and records it.
  const again = f.wake(body);
  assert.equal(again.decision, 'forward');
  assert.equal(triage.unconfirmedForwards(readLog(f.files.logPath), null).length, 1);
});

test('N2: a --sent whose state write failed after its log line is closed as delivered by the next run, not re-sent or escalated', { skip: !canDenyWrites && 'running as root' }, async t => {
  const f = proxyProject(t), t0 = Date.now();
  const first = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional first notice', context: 'Fictional.' });
  const [body] = (await f.deliver()).filter(row => row.inboxId === first.id);
  const run = f.wake(body, { nowMs: t0 });
  assert.equal(run.send.threadId, THREAD);
  // The proxy sends it, then --sent runs while the state folder is read-only: the log line is written, the state is not.
  chmodSync(join(f.dir, 'state'), 0o500);
  assert.throws(() => triage.confirmSent(run.sendId, { ...f.files, to: THREAD, nowMs: t0 + 5000 }), /EACCES|permission denied/i);
  chmodSync(join(f.dir, 'state'), 0o700);
  assert.ok(readLog(f.files.logPath).some(e => e.decision === 'sent' && e.sendId === run.sendId), 'the log has the confirmation');
  // Fifteen minutes later another delivery's run: the first forward is closed, never re-sent or escalated.
  const second = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional second notice', context: 'Fictional.' });
  const [later] = (await f.deliver()).filter(row => row.inboxId === second.id);
  const next = f.wake(later, { nowMs: t0 + 15 * 60000 });
  assert.equal(next.retries.some(row => row.sendId === run.sendId), false, 'dev.89: it was re-sent and marked for escalation as undelivered');
  assert.deepEqual(next.closed.map(row => [row.sendId, row.closed]), [[run.sendId, 'delivered']]);
  assert.equal(triage.unconfirmedForwards(readLog(f.files.logPath), null, { nowMs: t0 + 20 * 60000 }).some(row => row.sendId === run.sendId), false);
});

test('N2: a triage-failed notice words each delivery kind correctly and states the real dedup key', () => {
  const base = { projectId: 'fictional-project', deliveryId: 'fictional-delivery-1' };
  const state = triage.failureNotice({ kind: 'wake', payload: { ...base, kind: 'state', event: 'task.approved', eventSequence: 7, taskId: 'fictional-task' }, error: 'EACCES' }).context;
  assert.doesNotMatch(state, /notice delivery|look for that item in the Inbox/, 'dev.89 called a task.approved state event "a notice delivery" with an item to look for');
  assert.match(state, /It is a state event \(task\.approved for task fictional-task\), not an Inbox item, so there is no item to look for\. Factotum sends a state event again until it is acknowledged/);
  const attention = triage.failureNotice({ kind: 'wake', payload: { ...base, kind: 'inbox', event: 'inbox.attention', status: 'open', inboxId: 'fictional-item', version: 1 }, error: 'EACCES' }).context;
  assert.match(attention, /It is an attention delivery for inbox item fictional-item\. If that item is a notice, Factotum delivers it once and does not send it again, so it may never reach the orchestrator; if it is a question, Factotum sends it again while it stays open/);
  const resolved = triage.failureNotice({ kind: 'wake', payload: { ...base, kind: 'inbox', event: 'inbox.resolved', status: 'answered', resolution: 'answered', inboxId: 'fictional-item', version: 2 }, error: 'EACCES' }).context;
  assert.match(resolved, /It is a resolution delivery: inbox item fictional-item was answered\. Factotum sends a resolution again until it is acknowledged/);
  for (const text of [state, attention, resolved]) {
    assert.doesNotMatch(text, /in the same hour/, 'dev.89: two deliveries 27 seconds apart each got a notice while the text said "or in the same hour"');
    assert.match(text, /A repeated failure of the same delivery does not publish another notice; each other delivery that fails gets its own\./);
  }
  // The ID is the delivery's: two deliveries in one hour, two notices; the same delivery, the same notice.
  const id = deliveryId => triage.failureNotice({ kind: 'wake', payload: { ...base, deliveryId, kind: 'state', event: 'task.approved', eventSequence: 7, taskId: 'fictional-task' }, error: 'x', nowMs: 0 }).id;
  assert.notEqual(id('fictional-delivery-1'), id('fictional-delivery-2'));
  assert.equal(id('fictional-delivery-1'), triage.failureNotice({ kind: 'wake', payload: { ...base, kind: 'state', event: 'task.approved', eventSequence: 7, taskId: 'fictional-task' }, error: 'x', nowMs: 1800000 }).id);
  // A timer run has no delivery: one notice per UTC hour.
  const timer = triage.failureNotice({ kind: 'timer', error: 'x', nowMs: Date.UTC(2026, 10, 16, 21, 5) });
  assert.equal(timer.id, triage.failureNotice({ kind: 'timer', error: 'x', nowMs: Date.UTC(2026, 10, 16, 21, 55) }).id);
  assert.match(timer.context, /Another failure of the timer run in the same UTC hour does not publish another notice\./);
  assert.equal(triage.PROTOCOL, 90, 'the script changed, so the protocol moved');
});

test('N2: the handling guide knows the reset notice, the error notices\' delivery kinds, in-progress forwards and a forward re-addressed after it arrived', () => {
  const guide = read('starter/project/integrations/t3-notifications.example.md'), doc = read('docs/integrations/t3.md');
  assert.match(guide, /`triage-reset-<id>`: the proxy's state file could not be read/, 'dev.89: the guide never mentioned triage-reset');
  assert.match(guide, /run `TRIAGE --forwards --unconfirmed` \(without `--for`\) and handle every forward decided before the reset from state/);
  assert.match(guide, /Each failed delivery has its own notice; a repeated failure of the same delivery, or of a timer or digest run within one UTC hour, publishes no second one\./);
  assert.match(guide, /A state event \(for example `task\.approved`\) has no Inbox item/);
  assert.match(guide, /it only means the last send is under two minutes old/);
  assert.match(guide, /\*\*A forward in this thread now listed for another session\.\*\*/);
  assert.match(guide, /`--protocol 90`/);
  assert.match(read('starter/project/integrations/t3-triage.example.md'), /--protocol 90`/);
  assert.doesNotMatch(doc, /so repeated failures publish it once/);
  assert.match(doc, /\*\*A decision is logged before anything is sent\*\* \(dev\.90\)/);
});

test('N2: the script accepts "received" from the thread a forward reached after it was re-addressed to another session, as the guide says', () => {
  const t0 = Date.parse('2026-11-16T21:49:15Z'), at = ms => new Date(t0 + ms).toISOString(), other = 'fictional-missing-session';
  const entries = [
    { at: at(0), decision: 'forward', rule: 'flow-notice', sendId: 'fictional-delivery:1', deliveryId: 'fictional-delivery', forwardTo: THREAD, forwardSource: 'session' },
    { at: at(137000), decision: 'retry', sendId: 'fictional-delivery:1', deliveryId: 'fictional-delivery', retry: 1, forwardTo: other, forwardSource: 'session' },
    { at: at(147000), decision: 'send-failed', sendId: 'fictional-delivery:1', deliveryId: 'fictional-delivery', forwardTo: other, error: 'thread_not_found' },
  ];
  const nowMs = t0 + 600000;
  assert.deepEqual(triage.unconfirmedForwards(entries, null, { forThread: THREAD, nowMs }), [], '--for lists it under the other session now');
  assert.equal(triage.missedRefCheck(entries, { kind: 'received', ref: 'fictional-delivery:1', forThread: THREAD, nowMs }).sendId, 'fictional-delivery:1');
  assert.throws(() => triage.missedRefCheck(entries, { kind: 'undelivered', ref: 'fictional-delivery:1', forThread: THREAD, nowMs }), /addressed to fictional-missing-session/);
  assert.throws(() => triage.missedRefCheck(entries, { kind: 'received', ref: 'fictional-delivery:1', forThread: 'fictional-third-thread', nowMs }), /was never sent to fictional-third-thread/);
});

// ---- N5: the checklist matches the product on a click on blank space in the flow window ----
test('N5: Pass A step 3 no longer expects the list to survive a click on blank space in the modal; that click closes the list and the modal stays open', () => {
  const checklist = read('docs/qualification/console-browser.md');
  assert.doesNotMatch(checklist, /or on blank space in the modal/, 'dev.89: the L6 sentence contradicted the outside-click rule');
  assert.match(checklist, /A click on blank space in the modal, outside the panel, is a click outside the list: it closes the list and the modal stays open \(dev\.89 M5\), so the next Escape closes the modal/);
  assert.match(checklist, /A click or tap anywhere outside it closes it, including on another grouped marker/, 'the outside-click rule is unchanged');
});

// Review of 8441ff4, P2-1: the state was saved before the decision line, so a run whose log append
// failed left a pending forward that a later run sent with no decision in the log.
async function approvalForward(t) {
  const f = proxyProject(t, 'all');
  f.ok('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision });
  const body = (await f.deliver()).find(row => row.kind === 'state' && row.event === 'task.approved');
  assert.ok(body, 'a task.approved delivery');
  return { f, body };
}
const timerRun = (f, nowMs) => triage.runRecorded('timer', { ...f.files, statePath: null, input: '', projectId: f.project.projectId, nowMs });

test('N2, review of 8441ff4 P2-1: a run whose log line fails sends nothing, and the next run logs the decision as recovered before re-sending it', { skip: !canDenyWrites && 'running as root' }, async t => {
  const { f, body } = await approvalForward(t), t0 = Date.now();
  writeFileSync(f.files.logPath, ''); chmodSync(f.files.logPath, 0o400);
  assert.throws(() => f.wake(body, { nowMs: t0 }), /EACCES|permission denied/i);
  chmodSync(f.files.logPath, 0o600);
  const saved = JSON.parse(readFileSync(f.files.memoryPath, 'utf8')), [sendId] = Object.keys(saved.pending);
  assert.equal(saved.pending[sendId].undecided, true, 'the state marks the forward as not yet logged');
  assert.equal(triage.verifyForward(readLog(f.files.logPath), sendId).logged, false);
  // Three minutes later a timer run: the decision is logged first, then the forward is sent again.
  const run = timerRun(f, t0 + 3 * 60000);
  assert.deepEqual(run.recovered, [sendId]);
  assert.ok(run.retries.some(row => row.sendId === sendId && row.send), 'it is re-sent');
  const entries = readLog(f.files.logPath), decided = entries.findIndex(e => e.decision === 'forward' && e.sendId === sendId), retried = entries.findIndex(e => e.decision === 'retry' && e.sendId === sendId);
  assert.ok(decided >= 0 && decided < retried, 'the decision line comes before the re-send');
  assert.equal(entries[decided].recovered, true); assert.equal(entries[decided].at, new Date(t0).toISOString(), 'with the time it was decided');
  const verified = triage.verifyForward(entries, sendId);
  assert.equal(verified.logged, true, 'dev.90 before the review: "this proxy did not decide to forward it"');
  assert.equal(verified.decisions[0].recovered, true);
  assert.equal(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending[sendId].undecided, undefined);
});

test('N2, review of 8441ff4 P2-1: a forward whose decision cannot be logged is never re-sent; a crash after its line was logged adds no second line', { skip: !canDenyWrites && 'running as root' }, async t => {
  const { f, body } = await approvalForward(t), t0 = Date.now();
  writeFileSync(f.files.logPath, ''); chmodSync(f.files.logPath, 0o400);
  assert.throws(() => f.wake(body, { nowMs: t0 }), /EACCES|permission denied/i);
  // The log is still read-only at the next run: it fails before any re-send, and the forward stays marked.
  assert.throws(() => timerRun(f, t0 + 3 * 60000), /EACCES|permission denied/i);
  chmodSync(f.files.logPath, 0o600);
  assert.equal(readLog(f.files.logPath).some(e => e.decision === 'retry'), false, 'nothing was sent without its decision');
  const [sendId] = Object.keys(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending);
  assert.equal(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending[sendId].undecided, true);

  // A crash between the decision line and clearing the mark: the line is there and the mark is not cleared.
  const g = await approvalForward(t), t1 = Date.now();
  const first = g.f.wake(g.body, { nowMs: t1 });
  const memory = JSON.parse(readFileSync(g.f.files.memoryPath, 'utf8'));
  memory.pending[first.sendId].undecided = true; writeFileSync(g.f.files.memoryPath, JSON.stringify(memory));
  const next = timerRun(g.f, t1 + 3 * 60000);
  assert.equal(next.recovered, undefined, 'its line was already logged');
  assert.equal(readLog(g.f.files.logPath).filter(e => ['forward', 'unsure'].includes(e.decision) && e.sendId === first.sendId).length, 1, 'no second decision line');
  assert.ok(next.retries.some(row => row.sendId === first.sendId && row.send), 'it is re-sent as usual');
  assert.equal(JSON.parse(readFileSync(g.f.files.memoryPath, 'utf8')).pending[first.sendId].undecided, undefined);
});

// Review of 8441ff4, guidance (the orchestrator's gap 13): a forward "approved, not queued or running"
// came for a task whose flow had just failed, and the guide said to queue it.
test('gap 13: the guide and the approval forward say a failed flow is diagnosed before its task is queued or restarted', () => {
  const guide = read('starter/project/integrations/t3-notifications.example.md');
  assert.match(guide, /a row `finished` with `flowState: failed` or `abandoned`, or a flow of the task that is `stopped`, means the last flow did not deliver\. Then "approved, not queued or running" is not a reason to queue or restart it/);
  assert.match(guide, /queue it with `queue\.put` or restart it only once the cause is understood and fixed, or the operator says to/);
  assert.match(guide, /Restart a flow, or queue its task again, only when the cause is understood and fixed/);
  assert.match(read('starter/project/integrations/triage.example.mjs'), /if its last flow failed, was abandoned or is stopped, diagnose that flow before anything else and do not queue or restart the task/);
});

// Re-check of 766c23e: --send-failed (and every command but a run) skipped decision recovery, so it
// offered a send for a row still undecided, which --verify did not find. The gate is now in loadMemory,
// which every state command uses, and log-only commands run it when given --memory.
const SCRIPT = join(repo, 'starter/project/integrations/triage.example.mjs');
const triageCli = (args, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args, '--protocol', '90'], { encoding: 'utf8', timeout: 60000, ...options });
// A forward saved as undecided: a task.approved wake whose log append failed.
async function undecidedForward(t) {
  const { f, body } = await approvalForward(t);
  writeFileSync(f.files.logPath, ''); chmodSync(f.files.logPath, 0o400);
  assert.throws(() => f.wake(body), /EACCES|permission denied/i);
  chmodSync(f.files.logPath, 0o600);
  const memory = JSON.parse(readFileSync(f.files.memoryPath, 'utf8')), [sendId] = Object.keys(memory.pending);
  assert.equal(memory.pending[sendId].undecided, true);
  return { f, body, sendId, memory: readFileSync(f.files.memoryPath, 'utf8') };
}
const decidedIn = (logPath, sendId) => readLog(logPath).filter(e => ['forward', 'unsure'].includes(e.decision) && e.sendId === sendId);

test('re-check of 766c23e: --send-failed on an undecided forward logs its decision first, so the send it offers is verifiable', { skip: !canDenyWrites && 'running as root' }, async t => {
  const { f, sendId } = await undecidedForward(t);
  const r = triageCli(['--send-failed', sendId, '--to', THREAD, '--error', 'thread_not_found', '--memory', f.files.memoryPath, '--log', f.files.logPath]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.next?.send, 'it still offers the send');
  assert.equal(triage.verifyForward(readLog(f.files.logPath), sendId).logged, true, 'dev.90 at 766c23e: logged false');
  assert.equal(decidedIn(f.files.logPath, sendId)[0].recovered, true);
  assert.equal(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending[sendId].undecided, undefined);
  // If the decision cannot be logged, the command fails and offers nothing.
  const again = await undecidedForward(t);
  chmodSync(again.f.files.logPath, 0o400);
  const refused = triageCli(['--send-failed', again.sendId, '--to', THREAD, '--error', 'x', '--memory', again.f.files.memoryPath, '--log', again.f.files.logPath]);
  chmodSync(again.f.files.logPath, 0o600);
  assert.notEqual(refused.status, 0); assert.doesNotMatch(refused.stdout, /"send"/);
  assert.equal(JSON.parse(readFileSync(again.f.files.memoryPath, 'utf8')).pending[again.sendId].undecided, true);
});

test('re-check of 766c23e: every command that holds the state logs an undecided decision before it acts; without the state, log-only commands neither list nor count it', { skip: !canDenyWrites && 'running as root' }, async t => {
  const { f, body, sendId, memory } = await undecidedForward(t);
  const decidedAt = JSON.parse(memory).pending[sendId].decidedAt, read = join(f.dir, 'escalated-read.json'); writeFileSync(read, '{}');
  const files = ['--memory', f.files.memoryPath, '--log', f.files.logPath];
  const reset = () => { writeFileSync(f.files.memoryPath, memory); writeFileSync(f.files.logPath, ''); };
  // Without --memory, a log-only command sees no forward: nothing to list, count, verify or close.
  reset();
  assert.deepEqual(JSON.parse(triageCli(['--forwards', '--unconfirmed', '--log', f.files.logPath]).stdout), []);
  assert.equal(JSON.parse(triageCli(['--counts', '--log', f.files.logPath]).stdout).unconfirmed, 0);
  assert.equal(JSON.parse(triageCli(['--verify', sendId, '--log', f.files.logPath]).stdout).logged, false);
  assert.notEqual(triageCli(['--missed', '--kind', 'undelivered', '--ref', sendId, '--for', THREAD, '--note', 'x', '--log', f.files.logPath]).status, 0, 'not closable');
  assert.equal(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending[sendId].undecided, true, 'and nothing settled it');
  const commands = {
    '--sent': [['--sent', sendId, '--to', THREAD, ...files], out => assert.equal(out.recorded, 'sent')],
    '--send-failed': [['--send-failed', sendId, '--to', THREAD, '--error', 'x', ...files], out => assert.ok(out.next)],
    '--escalate': [['--escalate', sendId, ...files], out => assert.ok('escalate' in out)],
    '--escalated': [['--escalated', sendId, '--state', read, ...files], null],
    '--judged-absorb': [['--judged-absorb', body.deliveryId, '--note', 'x', ...files], null],
    '--set-proxy-id': [['--set-proxy-id', 'fictional-proxy-thread', ...files], out => assert.equal(out.recorded, 'proxy-id')],
    '--forwards': [['--forwards', '--unconfirmed', ...files], out => assert.deepEqual(out.map(row => row.sendId), [sendId])],
    '--verify': [['--verify', sendId, ...files], out => assert.equal(out.logged, true)],
    '--counts': [['--counts', ...files], out => assert.equal(out.unconfirmed, 1)],
    '--absorbed': [['--absorbed', ...files], out => assert.ok(Array.isArray(out))],
    '--missed': [['--missed', '--kind', 'lookup', '--note', 'x', ...files], out => assert.equal(out.recorded, 'missed')],
    '--correct': [['--correct', decidedAt, '--note', 'x', ...files], out => assert.equal(out.recorded, 'correction', 'the recovered line is the entry it corrects')],
    'a timer run': [['--timer', ...files], out => assert.deepEqual(out.recovered, [sendId], 'the run reports what it logged')],
  };
  for (const [name, [args, check]] of Object.entries(commands)) {
    reset();
    const r = triageCli(args, { input: '' });
    if (check) { assert.equal(r.status, 0, `${name}: ${r.stderr}`); check(JSON.parse(r.stdout)); }
    const decided = decidedIn(f.files.logPath, sendId), entries = readLog(f.files.logPath);
    assert.equal(decided.length, 1, `${name}: its decision is logged once`);
    assert.equal(decided[0].recovered, true, name); assert.equal(decided[0].at, decidedAt, `${name}: with its original time`);
    assert.equal(entries.findIndex(e => e === decided[0] || (e.decision === decided[0].decision && e.sendId === sendId)), 0, `${name}: before anything the command wrote`);
    assert.equal(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending?.[sendId]?.undecided, undefined, `${name}: the mark is cleared`);
  }
});
