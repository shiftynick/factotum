// dev.86: findings J1–J6 and J8 of the dev.85 readiness re-test. A refused answer that named a
// version the question never had says so (J1); Health keeps the last completed verification and
// its checks while a new one runs (J2); a settled event shows the attempt's derived result (J3); a
// main verification's attempt lists every check with its result, limit and run time (J4); the
// re-verification time in Health and Queue is the dev.83 time element (J5, J6); and every inbox,
// flow and task id Factotum builds can be read back by status --inbox/--flow/--task, the project
// service and the console (J8). Fictional fixtures throughout. See docs/changes/dev86-console-j-items.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { installDom, byTag, descendants } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { digest, recordId, RECORD_ID_MAX, GENERATED_ID_MAX, TARGET_BRANCH_MAX } from '../starter/factory/core/contracts.mjs';
import { staleQuestionReason } from '../starter/factory/core/stale-question.mjs';
import { flowNotice, stopFlow } from '../starter/factory/core/project.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { setTargetHealth, targetHealth } from '../starter/factory/operations/targets.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { ensureTargetSync, verificationRequest } from '../starter/factory/operations/main-freshness.mjs';
import { operationalTick, runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { requestProject } from '../starter/factory/console/client.mjs';
import { startConsole, registerProject } from '../starter/factory/console/console.mjs';

// The fake DOM replaces fetch; the console server is read with the real one.
const realFetch = globalThis.fetch;
installDom();
const { state } = await import('../starter/factory/console/ui/state.mjs');
const records = await import('../starter/factory/console/ui/records.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const { queueView } = await import('../starter/factory/console/ui/queue.mjs');
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');

const text = node => node.textContent;
const ISO = /\d{4}-\d\d-\d\dT\d\d:\d\d/;
function project(snapshot = {}, settings = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [],
    ...snapshot, settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: { autoQueue: true }, ...settings } } };
}
const dd = (node, label) => { const terms = byTag(node, 'dt'), i = terms.findIndex(dt => text(dt) === label); return i < 0 ? null : byTag(node, 'dd')[i]; };
const utcTitle = iso => `${iso} (UTC as recorded)`;

// ---- J1: the stale-answer wording for each version mismatch -----------------------------------------

test('J1: an answer naming a version the question never had is not described as a change since it was read', () => {
  const open = { status: 'open', version: 1, subjectDigest: 's' };
  assert.equal(staleQuestionReason(open, { version: 2, subjectDigest: 's' }), 'stale or resolved question: the version given (2) is not the current one (1); it has never had that version; read it again before answering');
  assert.equal(staleQuestionReason({ ...open, version: 3 }, { version: 2 }), 'stale or resolved question: it changed since it was read (version 2, now 3); read it again before answering', 'an older version still reads as a change');
  assert.equal(staleQuestionReason(open, { version: undefined }), 'stale or resolved question: no version was given (it is at version 1); read it again before answering');
  assert.equal(staleQuestionReason(open, { version: '1' }), 'stale or resolved question: the version given ("1") is not a version number (it is at version 1); read it again before answering');
  assert.match(staleQuestionReason(open, { version: 0 }), /the version given \(0\) is not a version number/, 'versions start at 1');
  assert.equal(staleQuestionReason(open, { version: 1, subjectDigest: 's' }), null);
});

// ---- J8: generated ids can be read back -------------------------------------------------------------

test('J8: the longest generated ids pass the read validator; ids a caller chooses stay at 128 characters', () => {
  const flow128 = `f${'x'.repeat(127)}`, post = `maintenance:post-merge-main:${flow128}`;
  const forms = {
    // The finding's case: a failed main.verify notice of a maintenance flow (132 characters there).
    mainRefreshNotice: `flow-notice:maintenance:main-refresh:${new Date().toISOString()}:failed:${'a'.repeat(64)}`,
    // The longest form built only from bounded parts: the post-merge verification flow of a flow with a 128-character id.
    postMergeNotice: `flow-notice:${post}:completed:${'a'.repeat(64)}`,
    scheduledNotice: `flow-notice:maintenance:${'b'.repeat(64)}:completed:${'a'.repeat(64)}`,
    cleanupNotice: `cleanup-notice:${post}`,
    lifecycleNotice: `flow-notice:maintenance:lifecycle-stop:${flow128}:completed:${'a'.repeat(64)}`,
    authorityRace: `authority-race:${crypto.randomUUID()}:d${'y'.repeat(127)}:12`,
    // A target branch name in a job id, with a slash.
    slashTarget: `flow-notice:maintenance:main-timeout-retry:release/2026.11:${new Date().toISOString()}:failed:${'a'.repeat(64)}`,
  };
  assert.equal(forms.postMergeNotice.length, 243);
  for (const [name, value] of Object.entries(forms)) { assert.ok(value.length <= RECORD_ID_MAX, name); assert.equal(recordId(value, 'inbox id'), value, name); }
  assert.ok(forms.mainRefreshNotice.length > 128);
  assert.throws(() => recordId('a'.repeat(RECORD_ID_MAX + 1), 'inbox id'), /^Error: invalid inbox id: at most 640/);
  for (const bad of ['', ':leading', 'has space', 'semi;colon', 'new\nline', 42]) assert.throws(() => recordId(bad, 'inbox id'), /invalid inbox id/, String(bad));
});

test('J8: status --inbox, the project service and the console read a flow notice and a flow whose ids are longer than 128 characters', async t => {
  const f = sandbox(t, { question: true });
  f.start();
  const base = f.store.need('flow', 'flow-1'), longFlowId = `maintenance:post-merge-main:f${'x'.repeat(127)}`;
  f.store.tx(() => { f.store.put('flow', { ...base, id: longFlowId, state: 'completed', finishedAt: new Date().toISOString() }); flowNotice(f.store, f.store.need('flow', longFlowId), 'completed'); });
  const notice = f.store.by('inbox', 'flowId', longFlowId).find(row => row.id.startsWith('flow-notice:'));
  assert.ok(notice && notice.id.length > 200, `a real notice id of ${notice?.id.length} characters`);
  // status --inbox (the narrow read the guides prescribe).
  const view = stateView(f.store, { inbox: notice.id });
  assert.equal(view.item.id, notice.id); assert.equal(view.flow.id, longFlowId);
  assert.throws(() => stateView(f.store, { inbox: 'n'.repeat(RECORD_ID_MAX + 1) }), /invalid inbox id/);
  // The CLI's status --inbox, end to end.
  const cli = new URL('../starter/factory/cli.mjs', import.meta.url).pathname;
  const out = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--state', f.stateDir, '--inbox', notice.id], { encoding: 'utf8' }));
  assert.equal(out.item.id, notice.id);
  // The project service's flow read and the console's read route.
  const socketPath = join(f.base, 'j8.sock'), app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false }); t.after(() => app.close());
  const detail = await requestProject(socketPath, { path: `/v1/flows/${encodeURIComponent(longFlowId)}`, timeoutMs: 30000 });
  assert.equal(detail.flow.id, longFlowId); assert.ok(detail.inbox.some(row => row.id === notice.id));
  const consoleState = join(f.base, 'console'), binding = await registerProject(consoleState, { socketPath }, { timeoutMs: 30000 });
  const web = await startConsole({ stateDir: consoleState, timeoutMs: 30000 }); t.after(() => web.close());
  const page = await realFetch(web.url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const response = await realFetch(`${web.url}/api/project/${binding.projectId}/flows/${encodeURIComponent(longFlowId)}?bindingId=${binding.bindingId}`, { headers: { cookie } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).flow.id, longFlowId);
  const tooLong = await realFetch(`${web.url}/api/project/${binding.projectId}/flows/${'z'.repeat(RECORD_ID_MAX + 1)}?bindingId=${binding.bindingId}`, { headers: { cookie } });
  assert.equal(tooLong.status, 400);
});

// Every generated form at its longest, through its real generator: target branch names at the
// target rule's bound (200 characters), a caller-chosen flow id at 128, the outcome "completed".
// Each job, maintenance flow and notice id is read back through status --flow/--inbox, the project
// service and the console. The longest is GENERATED_ID_MAX (533), the reviewer's case.
test('J8: the longest id of each generated form is built by its generator and read back everywhere', async t => {
  const A = 'a'.repeat(TARGET_BRANCH_MAX), B = 'b'.repeat(TARGET_BRANCH_MAX), F = `f${'x'.repeat(127)}`, G = `g${'x'.repeat(127)}`;
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', A]); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', A]);
  const config = validateConfig({ version: 1, mode: 'delivery', repository: { slug: 'fictional/long-ids', account: 'fictional', target: A, remote: 'origin', syncTargets: [{ from: A, into: B }] }, providers,
    mainChecks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], checks: [{ id: 'acceptance', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }],
    context: { files: [], maxChars: 1000 }, policy: { autoQueue: true }, workflows: { definitions: { change: { reference: 'change.standard' }, next: { reference: 'change.standard', target: B } }, selection: { default: 'change' } } });
  // The flows here run the one-step graph below (no catalog is compiled); the configuration names both targets.
  const graph = { version: 1, start: 'merge', nodes: { merge: { kind: 'effect', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('workflow', graph); f.store.setMeta('workflowDigest', digest(graph)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  const head = repositoryIdentity(f.root).head, nowMs = Date.now(), green = () => f.store.tx(() => setTargetHealth(f.store, null, { status: 'green', head, checkedAt: new Date().toISOString() }));
  green();
  const jobs = {};
  // target-sync:outside:<from>:<into>:<head> (the probe saw the source move outside the factory).
  const moved = 'c'.repeat(40);
  const queued = await ensureTargetSync(f.store, { nowMs, run: async () => ({ code: 0, stdout: `${moved}\trefs/heads/${A}\n`, stderr: '' }) });
  jobs.outside = f.store.all('job').find(job => job.id.startsWith('target-sync:outside:')).id;
  assert.ok(queued.length && jobs.outside === `target-sync:outside:${A}:${B}:${moved.slice(0, 12)}`);
  // target-sync:<flow id>:<into> and post-merge-main:<flow id> (a merge of flow F into A).
  const task = f.command('task.put', { task: { id: 'task-long', title: 'Fictional long-id work', acceptance: ['Works'] } }).result;
  const ok = result => { assert.equal(result.status, 'completed', result.error); return result; };
  ok(f.command('task.approve', { taskId: task.id, revision: task.revision }));
  ok(f.command('flow.start', { taskId: task.id, revision: task.revision, flowId: F }));
  const flow = f.store.need('flow', F), identity = repositoryIdentity(f.root); flow.mergeAuthorization = { identity, taskRevision: flow.taskRevision, configDigest: flow.configDigest }; f.store.put('flow', flow);
  await f.engine.step(F); const attempt = f.store.need('attempt', f.store.need('flow', F).attemptId);
  attempt.intent = { ...attempt.intent, action: { operation: 'forge.merge' } };
  f.engine.settle(F, attempt, { version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: { route: 'merged', merged: true, sha: identity.head, expectedHead: identity.head, expectedBase: identity.head, outputIdentity: identity } });
  await f.engine.step(F);
  jobs.mergeSync = `target-sync:${F}:${B}`; jobs.postMerge = `post-merge-main:${F}`;
  for (const id of [jobs.mergeSync, jobs.postMerge]) assert.ok(f.store.get('job', id), id);
  // main-timeout-retry:<target>:<time> (B failed only on a timeout, 20 minutes ago) and main-refresh:<target>:<time>.
  const failedAt = new Date(nowMs - 20 * 60000).toISOString();
  f.store.tx(() => setTargetHealth(f.store, B, { status: 'red', head, checkedAt: failedAt, timeoutOnly: true, timedOut: true, timeout: { checkId: 'unit', timeoutMs: 1500, limit: 'check' }, checks: [{ id: 'unit', status: 'failed', failureClass: 'timeout', timedOut: true, timeoutMs: 1500 }] }));
  jobs.timeoutRetry = f.store.tx(() => verificationRequest(f.store, B, { nowMs })).jobId;
  assert.equal(jobs.timeoutRetry, `main-timeout-retry:${B}:${failedAt}`);
  f.store.tx(() => { f.store.put('job', { ...f.store.need('job', jobs.timeoutRetry), status: 'completed' }); setTargetHealth(f.store, B, { status: 'unknown', head, checkedAt: failedAt, reason: 'fictional' }); });
  jobs.refresh = f.store.tx(() => verificationRequest(f.store, B, { nowMs })).jobId;
  assert.equal(jobs.refresh, `main-refresh:${B}:${new Date(nowMs).toISOString()}`);
  // lifecycle-stop:<flow id> (a change flow from an issue source stops while lifecycle sync is on).
  f.store.setMeta('config', { ...config, repository: { ...config.repository, issueProfile: { lifecycle: true } } });
  green();
  const other = f.command('task.put', { task: { id: 'task-stop', title: 'Fictional stopped work', acceptance: ['Works'] } }).result;
  ok(f.command('task.approve', { taskId: other.id, revision: other.revision })); ok(f.command('flow.start', { taskId: other.id, revision: other.revision, flowId: G }));
  f.store.tx(() => { const g = f.store.need('flow', G); g.taskSnapshot = { ...g.taskSnapshot, source: { kind: 'github', number: 1 } }; f.store.put('flow', g); stopFlow(f.store, f.store.need('flow', G), 'fictional stop'); });
  jobs.lifecycle = `lifecycle-stop:${G}`;
  assert.ok(f.store.get('job', jobs.lifecycle), 'the lifecycle job was created');
  f.store.setMeta('config', config);

  // Each job's maintenance flow, admitted by the operations loop, and that flow's notice.
  const expected = { outside: [434, 446, 533], mergeSync: [341, 353, 440], postMerge: [144, 156, 243], timeoutRetry: [244, 256, 343], refresh: [238, 250, 337], lifecycle: [143, 155, 242] };
  // A lifecycle-stop flow notifies only at the actionable level, when it needs attention (flowNotice).
  const level = form => f.store.setMeta('config', form === 'lifecycle' ? { ...config, notifications: { level: 'actionable' } } : config);
  const built = {};
  for (const [form, jobId] of Object.entries(jobs)) {
    f.store.tx(() => { for (const job of f.store.all('job')) if (job.id !== jobId && ['queued', 'running'].includes(job.status)) f.store.put('job', { ...job, status: 'revoked', reason: 'test: one at a time' }); f.store.put('job', { ...f.store.need('job', jobId), status: 'queued' }); });
    await operationalTick(f.store);
    const job = f.store.need('job', jobId);
    assert.equal(job.status, 'running', `${form}: ${job.reason ?? job.status}`);
    const flowId = job.flowId;
    assert.equal(flowId, `maintenance:${jobId}`);
    f.store.tx(() => { level(form); f.store.put('flow', { ...f.store.need('flow', flowId), state: 'completed', finishedAt: new Date().toISOString() }); flowNotice(f.store, f.store.need('flow', flowId), 'completed', form === 'lifecycle' ? 'The source issue could not be updated (fictional).' : ''); level(''); f.store.put('job', { ...f.store.need('job', jobId), status: 'completed' }); });
    const notice = f.store.by('inbox', 'flowId', flowId).find(row => row.id.startsWith('flow-notice:'));
    assert.ok(notice, `${form}: a notice`);
    built[form] = { jobId, flowId, noticeId: notice.id };
    assert.deepEqual([jobId.length, flowId.length, notice.id.length], expected[form], form);
  }
  const longest = Math.max(...Object.values(built).map(row => row.noticeId.length));
  assert.equal(longest, GENERATED_ID_MAX); assert.equal(built.outside.noticeId.length, 533);
  assert.ok(RECORD_ID_MAX > GENERATED_ID_MAX);

  // Read back: status --flow and --inbox (the CLI), the project service, and the console.
  const cli = new URL('../starter/factory/cli.mjs', import.meta.url).pathname;
  const status = args => JSON.parse(execFileSync(process.execPath, [cli, 'status', '--state', f.stateDir, ...args], { encoding: 'utf8' }));
  const socketPath = join(f.base, 'long.sock'), app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false }); t.after(() => app.close());
  const consoleState = join(f.base, 'console'), binding = await registerProject(consoleState, { socketPath }, { timeoutMs: 30000 });
  const web = await startConsole({ stateDir: consoleState, timeoutMs: 30000 }); t.after(() => web.close());
  const page = await realFetch(web.url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const viaConsole = async (kind, subject) => { const response = await realFetch(`${web.url}/api/project/${binding.projectId}/${kind}/${encodeURIComponent(subject)}?bindingId=${binding.bindingId}`, { headers: { cookie } }); assert.equal(response.status, 200, `${kind} ${subject.length}: ${await response.clone().text()}`); return response.json(); };
  for (const [form, { jobId, flowId, noticeId }] of Object.entries(built)) {
    assert.equal(status(['--flow', flowId]).flow.id, flowId, `${form} status --flow`);
    const item = status(['--inbox', noticeId]);
    assert.equal(item.item.id, noticeId, `${form} status --inbox`); assert.equal(item.flow.id, flowId);
    const detail = await requestProject(socketPath, { path: `/v1/flows/${encodeURIComponent(flowId)}`, timeoutMs: 30000 });
    assert.equal(detail.flow.id, flowId); assert.ok(detail.inbox.some(row => row.id === noticeId), `${form} notice in the flow read`);
    assert.equal((await requestProject(socketPath, { path: `/v1/jobs/${encodeURIComponent(jobId)}`, timeoutMs: 30000 })).job.id, jobId, `${form} job read`);
    assert.equal((await viaConsole('flows', flowId)).flow.id, flowId, `${form} console flow`);
    assert.equal((await viaConsole('jobs', jobId)).job.id, jobId, `${form} console job`);
  }
});

test('J8: a default branch name outside the target rule is refused by validation and doctor, with the rule and what to do', () => {
  const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/rule', account: 'fictional', remote: 'origin' }, providers,
    mainChecks: [{ id: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], checks: [{ id: 'acceptance', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }] };
  const withTarget = target => validateConfig({ ...base, repository: { ...base.repository, target } });
  for (const ok of ['main', 'release/2026.11', 'a'.repeat(TARGET_BRANCH_MAX)]) assert.equal(withTarget(ok).repository.target, ok);
  const rule = 'at most 200 characters of letters, digits, ".", "_", "/" and "-", starting with a letter or digit, without ".."';
  for (const bad of ['a'.repeat(TARGET_BRANCH_MAX + 1), 'release+1', 'feature@x', '-main', '_main', 'a..b', 'with space'])
    assert.throws(() => withTarget(bad), error => error.message.startsWith(`repository.target must be a branch name of ${rule}; `) && /use a branch whose name follows the rule \(rename the branch, or point repository\.target at one that does\), then run doctor$/.test(error.message), bad);
  assert.throws(() => withTarget('x'.repeat(300)), /; "x{60}…" is not\./, 'a long name is shown shortened');
  // A workflow's target and a sync pair follow the same rule.
  assert.throws(() => validateConfig({ ...base, repository: { ...base.repository, target: 'main' }, workflows: { definitions: { change: { reference: 'change.standard' }, odd: { reference: 'change.standard', target: 'next+1' } }, selection: { default: 'change' } } }), /^Error: workflow odd target must be a branch name of at most 200 characters/);
  assert.throws(() => validateConfig({ ...base, repository: { ...base.repository, target: 'main', syncTargets: [{ from: 'main', into: 'release+1' }] } }), /repository\.syncTargets entry/);
});

// ---- A main.verify fixture (J2, J3, J4 and J6 on real records) --------------------------------------

const providers = { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } };
const check = (id, script, timeoutMs) => ({ id, argv: [process.execPath, '-e', script], timeoutMs });
function verifyFixture(t, mainChecks) {
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  const config = validateConfig({ version: 1, mode: 'delivery', repository: { slug: 'fictional/j-items', account: 'fictional', target: 'main', remote: 'origin' }, providers, mainChecks, checks: [{ id: 'acceptance', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], policy: { autoQueue: true } });
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  return { ...f, config, head: repositoryIdentity(f.root).head };
}
const receipt = (attempt, actionResult) => ({ version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult });
// Admits a main.verify job and prepares its attempt; `dispatch` takes one more engine step, which
// dispatches it (the supervisor starts; nothing settles it until the engine steps again).
async function verifyOnce(f, { dispatch = false } = {}) {
  const job = f.command('job.enqueue', { operation: 'main.verify', payload: {}, note: 'Fictional verification' }).result;
  await operationalTick(f.store);
  const flowId = f.store.need('job', job.id).flowId;
  await f.engine.step(flowId);
  if (dispatch) await f.engine.step(flowId);
  const flow = f.store.need('flow', flowId), attempt = f.store.need('attempt', flow.attemptId);
  return { flow, attempt, run: () => runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } }) };
}

test('J2: while main verification runs, the health record keeps the last completed run and its checks, and Health shows them as the previous run', async t => {
  const f = verifyFixture(t, [check('unit', 'process.exit(0)', 60000), check('lint', 'process.exit(1)', 30000)]);
  setTargetHealth(f.store, null, { status: 'unknown', head: f.head, checkedAt: new Date().toISOString(), reason: 'fictional baseline' });
  const first = await verifyOnce(f), outcome = await first.run();
  f.engine.settle(first.flow.id, first.attempt, receipt(first.attempt, outcome)); await f.engine.step(first.flow.id);
  const completed = targetHealth(f.store, null);
  assert.equal(completed.status, 'red'); assert.equal(completed.checks.length, 2); assert.equal(completed.previousRun, undefined, 'a record with its own checks carries no previous run');
  // A new verification is dispatched: the in-progress record keeps the completed run.
  const second = await verifyOnce(f, { dispatch: true });
  const running = targetHealth(f.store, null);
  assert.equal(running.status, 'unknown'); assert.equal(running.checks, undefined); assert.equal(running.running, true); assert.equal(running.attemptId, second.attempt.id);
  assert.equal(running.reason, 'Main verification in progress; current result required');
  assert.deepEqual(running.previousRun.checks.map(c => [c.id, c.status]), [['unit', 'passed'], ['lint', 'failed']]);
  assert.equal(running.previousRun.status, 'red'); assert.equal(running.previousRun.checkedAt, completed.checkedAt); assert.equal(running.previousRun.previousRun, undefined);
  // A second record without checks (the run is re-dispatched, a merge resets it) keeps the same previous run.
  f.store.tx(() => setTargetHealth(f.store, null, { status: 'unknown', head: completed.head, checkedAt: new Date().toISOString(), reason: 'Post-merge baseline verification required' }));
  assert.equal(targetHealth(f.store, null).previousRun.checkedAt, completed.checkedAt);
  // The console: current state, "Verification running", and the previous run with its checks.
  const view = operationsView(project({ mainHealth: running }, { mainChecks: f.config.mainChecks }));
  assert.ok(descendants(view).some(node => node.classList?.includes('chip') && /Verification running$/.test(text(node))), 'verification running is shown');
  const previous = dd(view, 'Previous run');
  assert.ok(previous, 'the previous run is listed');
  assert.match(text(previous), /Previous run red at [0-9a-f]{12}/);
  assert.match(text(previous), /passed unit/); assert.match(text(previous), /failed lint/);
  assert.equal(byTag(previous, 'time')[0].getAttribute('datetime'), completed.checkedAt);
  // A completed record shows its own checks and no previous run.
  const done = operationsView(project({ mainHealth: completed }));
  assert.equal(dd(done, 'Previous run'), null); assert.match(text(dd(done, 'Checks')), /unit/);
});

test('J3 and J4: a main verification attempt lists each check with its result, limit and run time, and its settled event shows the outcome', async t => {
  const f = verifyFixture(t, [check('unit', 'process.exit(0)', 60000), check('hang', "setTimeout(() => {}, 600000)", 1500), check('after', 'process.exit(0)', 45000)]);
  setTargetHealth(f.store, null, { status: 'green', head: f.head, checkedAt: new Date().toISOString() });
  const { flow, attempt, run } = await verifyOnce(f), outcome = await run();
  assert.equal(outcome.route, 'fail');
  f.engine.settle(flow.id, attempt, receipt(attempt, outcome)); await f.engine.step(flow.id);
  // J3 (core): the settled event records the routed outcome beside "passed".
  const settled = f.store.events(400).find(event => event.type === 'attempt.settled' && event.payload.attemptId === attempt.id);
  assert.equal(settled.payload.passed, true); assert.equal(settled.payload.outcome, 'failed');
  // J4 (service): the attempt read carries the check rows with each check's limit from the run's configuration.
  const socketPath = join(f.base, 'j4.sock'), app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false }); t.after(() => app.close());
  const detail = await requestProject(socketPath, { path: `/v1/flows/${encodeURIComponent(flow.id)}`, timeoutMs: 30000 });
  const read = detail.attempts.find(row => row.id === attempt.id);
  assert.deepEqual(read.mainVerification.checks.map(c => [c.id, c.status, c.timedOut ?? false, c.checkTimeoutMs]), [['unit', 'passed', false, 60000], ['hang', 'failed', true, 1500], ['after', 'passed', false, 45000]]);
  assert.equal(read.mainVerification.checks[1].timeoutMs, 1500); assert.equal(read.mainVerification.stepTimeoutMs, attempt.intent.timeoutMs);
  assert.ok(read.mainVerification.checks.every(c => c.startedAt && c.endedAt));
  assert.ok(!JSON.stringify(read.mainVerification).includes(f.stateDir), 'no private paths');
  // J4 (console): the attempt panel's list.
  const shown = timeline.mainVerificationView(project(), read);
  const items = byTag(shown, 'li').map(text);
  assert.equal(items.length, 3);
  assert.match(items[0], /^✓passed unit · ran [\d.]+ (ms|s) · limit 1 min$/);
  assert.match(items[1], /^✕timed out hang · ran [\d.]+ s · timed out at its limit of 1\.5 s$/);
  assert.match(items[2], /^✓passed after · ran [\d.]+ (ms|s) · limit 45 s$/);
  assert.match(text(shown), /This main\.verify step could run/);
  // J3 (console): the flow's event list shows the derived outcome, not "passed".
  const events = records.eventList(detail.events, { attempts: detail.attempts });
  const row = byTag(events, 'li').find(li => /Attempt settled/.test(text(li)));
  assert.match(text(row), /Attempt settled — failed · attempt/); assert.doesNotMatch(text(row), /passed/);
  assert.ok(row.classList.includes('tone-bad'));
});

test('J4: checks the step\'s time ran out for are listed as not run, and a check stopped by the step\'s time says so', () => {
  const attempt = { id: 'attempt-j4', mainVerification: { status: 'red', stepTimeoutMs: 1515000, checks: [
    { id: 'slow', status: 'passed', startedAt: '2026-11-16T02:00:00.000Z', endedAt: '2026-11-16T02:11:03.000Z', checkTimeoutMs: 900000 },
    { id: 'hang', status: 'failed', failureClass: 'timeout', timedOut: true, timeoutMs: 240000, limitSource: 'verification', checkTimeoutMs: 600000, startedAt: '2026-11-16T02:11:03.000Z', endedAt: '2026-11-16T02:15:03.000Z' },
    { id: 'legacy', status: 'passed', startedAt: '2026-11-16T02:00:00.000Z', endedAt: '2026-11-16T02:00:02.000Z' },
  ], notRun: [{ id: 'after', checkTimeoutMs: 120000 }] } };
  const view = timeline.mainVerificationView(project({}, { mainChecks: [{ id: 'legacy', timeoutMs: 30000 }] }), attempt);
  const items = byTag(view, 'li').map(text);
  assert.deepEqual(items, [
    '✓passed slow · ran 11 min 3 s · limit 15 min',
    '✕timed out hang · ran 4 min · stopped after 4 min, the time left in the step (its own limit 10 min)',
    '✓passed legacy · ran 2.0 s · limit 30 s (current configuration)',
    '○not run after · did not start: the step’s time was used up · limit 2 min',
  ]);
  assert.match(text(view), /This main\.verify step could run 25 min 15 s in all\./);
  assert.equal(timeline.mainVerificationView(project(), { id: 'other' }), null, 'nothing for an attempt that is not a main verification');
});

test('J3: an event list reads a turn-limited build as stopped at its turn limit, from the attempt or the recorded outcome', () => {
  const attempt = { id: 'attempt-build-1', step: 'build', status: 'passed', outcome: 'turn-limit', route: 'blocked', settledAt: '2026-11-16T02:44:00.000Z' };
  const event = { type: 'attempt.settled', at: '2026-11-16T02:44:00.000Z', sequence: 9, payload: { attemptId: attempt.id, passed: true, costMicros: 0 } };
  const withAttempt = byTag(records.eventList([event], { attempts: [attempt] }), 'li')[0];
  assert.equal(text(withAttempt).replace(/^.*?Attempt settled/, 'Attempt settled'), 'Attempt settled — stopped at turn limit · attempt attempt-…');
  assert.ok(withAttempt.classList.includes('tone-warn'));
  // A new event records the outcome itself; an old one without attempts still says passed.
  const recorded = byTag(records.eventList([{ ...event, payload: { ...event.payload, outcome: 'turn-limit' } }]), 'li')[0];
  assert.match(text(recorded), /stopped at turn limit/); assert.doesNotMatch(text(recorded), /passed/);
  assert.match(records.eventDetail({ type: 'attempt.settled', payload: { attemptId: 'x', passed: false } }), /^did not pass/);
  assert.match(records.eventDetail({ type: 'attempt.settled', payload: { attemptId: 'x', passed: true } }), /^passed/);
});

// ---- J5, J6: the re-verification time is the dev.83 time element -----------------------------------

test('J5 and J6: the main hold carries the times it embeds; Health and Queue show the re-verification time as a local time with its UTC value', async t => {
  const f = verifyFixture(t, [check('hang', 'process.exit(0)', 60000)]);
  const failedAt = new Date().toISOString();
  setTargetHealth(f.store, null, { status: 'red', head: f.head, checkedAt: failedAt, timeoutOnly: true, timedOut: true, timeout: { checkId: 'hang', timeoutMs: 1500, limit: 'check' }, checks: [{ id: 'hang', status: 'failed', failureClass: 'timeout', timedOut: true, timeoutMs: 1500 }] });
  const status = queueStatus(f.store), hold = status.holds.find(row => row.kind === 'main');
  const after = hold.timeoutRetry.after;
  assert.equal(hold.timeoutRetry.status, 'pending'); assert.ok(hold.text.includes(`after ${after}`));
  assert.deepEqual(hold.times, [after], 'the recorded re-verification time, as an exact string');
  const p = project({ mainHealth: targetHealth(f.store, null), queueStatus: status });
  // Health: Admission and Automatic re-verification both use the time element; no raw ISO text.
  const view = operationsView(p);
  for (const label of ['Admission', 'Automatic re-verification']) {
    const value = dd(view, label), [node] = byTag(value, 'time');
    assert.ok(node, `${label} has a time element`);
    assert.equal(node.getAttribute('datetime'), after); assert.equal(node.getAttribute('title'), utcTitle(after));
    assert.doesNotMatch(text(value), ISO, `${label} shows no raw UTC string`);
  }
  assert.equal(byTag(dd(view, 'Checked'), 'time')[0].getAttribute('title'), utcTitle(failedAt));
  // Queue's hold banner.
  state.reads.clear();
  const queue = queueView({ ...p, snapshot: { ...p.snapshot, queueRevision: 'q1', queueComplete: true } }, { params: {} });
  const banner = descendants(queue).find(node => node.tag === 'li' && /one automatic re-verification is requested after/.test(text(node)));
  assert.ok(banner, 'the banner names the re-verification');
  const [time] = byTag(banner, 'time');
  assert.equal(time.getAttribute('datetime'), after); assert.equal(time.getAttribute('title'), utcTitle(after));
  assert.doesNotMatch(text(banner), ISO);
  // A project service without structured times: the banner still marks the times found in the text.
  state.reads.clear();
  const legacy = queueView({ ...p, snapshot: { ...p.snapshot, queueRevision: 'q1', queueComplete: true, queueStatus: { ...status, holds: status.holds.map(({ times, ...row }) => row) } } }, { params: {} });
  const old = descendants(legacy).find(node => node.tag === 'li' && /re-verification is requested after/.test(text(node)));
  assert.equal(byTag(old, 'time')[0].getAttribute('title'), utcTitle(after));
});
