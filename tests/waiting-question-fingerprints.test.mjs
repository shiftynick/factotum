import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { Worker } from 'node:worker_threads';
import { sandbox, until, delay } from './helpers.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { Engine, QUESTION_REVALIDATE_MS } from '../starter/factory/core/engine.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { digest, validateWorkflow } from '../starter/factory/core/contracts.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

// Every Git process this test file starts goes through a wrapper that records it. When
// FCT_LOCK_PROBE names a state database, the wrapper also tries to take that database's
// write lock without waiting, and records whether it was free: a fingerprint made while
// the engine holds a write transaction shows up as "locked".
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const shim = mkdtempSync(join(tmpdir(), 'fct-git-shim-')), gitLog = join(shim, 'git.log'), lockLog = join(shim, 'lock.log');
writeFileSync(join(shim, 'probe.cjs'), `const { DatabaseSync } = require('node:sqlite'), { appendFileSync } = require('node:fs');
const db = new DatabaseSync(process.env.FCT_LOCK_PROBE); db.exec('PRAGMA busy_timeout=0');
let state = 'free'; try { db.exec('BEGIN IMMEDIATE'); db.exec('COMMIT'); } catch (error) { state = /locked|busy/i.test(error.message) ? 'locked' : 'error ' + error.message; }
db.close(); appendFileSync(process.env.FCT_LOCK_LOG, state + '\\n');\n`);
writeFileSync(join(shim, 'git'), `#!/bin/sh\necho "$*" >> "${gitLog}"\nif [ -n "$FCT_LOCK_PROBE" ]; then "${process.execPath}" "${join(shim, 'probe.cjs')}"; fi\nexec "${realGit}" "$@"\n`);
chmodSync(join(shim, 'git'), 0o755);
process.env.PATH = `${shim}${delimiter}${process.env.PATH}`; process.env.FCT_LOCK_LOG = lockLog;
test.after(() => rmSync(shim, { recursive: true, force: true }));
const lines = path => existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
const gitCalls = () => lines(gitLog).length;
const git = (root, args) => execFileSync(realGit, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const writes = store => store.db.prepare('SELECT total_changes() AS changes').get().changes;
const question = store => store.all('inbox').find(item => item.kind === 'question');
// Ticks until the flow waits on its open question and a further tick changes nothing.
async function parked(f, engine = f.engine) {
  await until(() => question(f.store)?.status === 'open', { tick: () => engine.tick() });
  await engine.tick(); await engine.tick();
  return question(f.store);
}

test('a flow waiting on its question starts no Git process, takes no fingerprint and writes nothing, tick after tick', async t => {
  const f = sandbox(t, { question: true }); f.start();
  const item = await parked(f);
  const before = { git: gitCalls(), writes: writes(f.store), events: f.store.events(1000).length, stats: { ...f.engine.stats } };
  for (let n = 0; n < 200; n++) await f.engine.tick();
  assert.equal(gitCalls() - before.git, 0, 'Git processes started over 200 ticks of a parked question');
  assert.deepEqual(f.engine.stats, before.stats, 'no step and no fingerprint while parked');
  assert.equal(writes(f.store), before.writes); assert.equal(f.store.events(1000).length, before.events);
  assert.equal(f.store.need('flow', 'flow-1').state, 'waiting'); assert.equal(f.store.need('inbox', item.id).status, 'open');
  // Parking holds nothing back: the answer is accepted and the flow completes.
  assert.equal(f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' }).status, 'completed');
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
});

test('several parked questions cost the same as none', async t => {
  const f = sandbox(t, { question: true }); f.start();
  await parked(f);
  const first = f.store.need('flow', 'flow-1');
  for (let n = 2; n <= 5; n++) {
    const task = f.command('task.put', { task: { id: `task-${n}`, title: `Fictional feature ${n}`, acceptance: ['Observed fixture behavior'] } }).result;
    f.command('task.approve', { taskId: task.id, revision: task.revision });
    const current = f.store.need('task', task.id);
    f.store.put('flow', { ...first, id: `flow-${n}`, taskId: task.id, taskSnapshot: structuredClone(current), taskRevision: current.revision, approvalVersion: current.approvalVersion, state: 'ready' });
  }
  await until(() => f.store.all('inbox').filter(item => item.kind === 'question' && item.status === 'open').length === 5, { tick: () => f.engine.tick() });
  await f.engine.tick(); await f.engine.tick();
  const before = { git: gitCalls(), writes: writes(f.store), stats: { ...f.engine.stats } };
  for (let n = 0; n < 100; n++) await f.engine.tick();
  assert.equal(gitCalls() - before.git, 0); assert.deepEqual(f.engine.stats, before.stats); assert.equal(writes(f.store), before.writes);
  // They wait on the same checkout: one fingerprint serves all five when it changes.
  writeFileSync(join(f.root, 'input.txt'), 'changed candidate\n'); git(f.root, ['commit', '-qam', 'Fictional candidate change']);
  await until(() => f.store.all('flow').every(flow => flow.state === 'stopped'), { tick: () => f.engine.tick() });
  assert.equal(f.engine.stats.fingerprints, before.stats.fingerprints + 1);
  assert.equal(f.store.all('inbox').filter(item => item.kind === 'question' && item.status === 'open').length, 0);
});

test('a commit in the candidate checkout stops the parked flow without waiting for the revalidation interval', async t => {
  const f = sandbox(t, { question: true }), engine = new Engine(f.store, { revalidateMs: 24 * 3600000 }); f.start();
  const item = await parked(f, engine), fingerprints = engine.stats.fingerprints;
  writeFileSync(join(f.root, 'input.txt'), 'changed candidate\n'); git(f.root, ['commit', '-qam', 'Fictional candidate change']);
  await until(() => f.store.need('flow', 'flow-1').state === 'stopped', { tick: () => engine.tick() });
  assert.match(f.store.need('flow', 'flow-1').stopReason, /question subject changed/);
  assert.equal(f.store.need('inbox', item.id).status, 'superseded');
  assert.equal(engine.stats.fingerprints, fingerprints + 1, 'one fingerprint established the change');
});

test('staging a change in the candidate checkout is found the same way', async t => {
  const f = sandbox(t, { question: true }), engine = new Engine(f.store, { revalidateMs: 24 * 3600000 }); f.start();
  const item = await parked(f, engine);
  writeFileSync(join(f.root, 'added.txt'), 'new candidate file\n'); git(f.root, ['add', 'added.txt']);
  await until(() => f.store.need('flow', 'flow-1').state === 'stopped', { tick: () => engine.tick() });
  assert.equal(f.store.need('inbox', item.id).status, 'superseded');
});

test('an edit Git was not told about stops the flow within the revalidation interval', async t => {
  const f = sandbox(t, { question: true }), engine = new Engine(f.store, { revalidateMs: 400 }); f.start();
  const item = await parked(f, engine), fingerprints = engine.stats.fingerprints, events = f.store.events(1000).length;
  writeFileSync(join(f.root, 'input.txt'), 'changed candidate\n');
  // No command and no Git operation: only the interval can find this.
  await until(() => f.store.need('flow', 'flow-1').state === 'stopped', { tick: () => engine.tick() });
  assert.match(f.store.need('flow', 'flow-1').stopReason, /question subject changed/);
  assert.equal(f.store.need('inbox', item.id).status, 'superseded');
  assert.ok(engine.stats.fingerprints > fingerprints);
  assert.ok(!f.store.events(1000).slice(0, -events || undefined).some(event => event.type.startsWith('command.')), 'no command woke the flow');
});

test('inside the interval an unreported edit leaves the question open, its answer is refused exactly, and the refusal stops the flow at the next tick', async t => {
  assert.equal(QUESTION_REVALIDATE_MS, 60000, 'the documented detection window');
  const f = sandbox(t, { question: true }); f.start();
  const item = await parked(f);
  writeFileSync(join(f.root, 'input.txt'), 'changed candidate\n');
  for (let n = 0; n < 30; n++) await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'waiting', 'not yet revalidated: the window');
  assert.equal(f.store.need('inbox', item.id).status, 'open');
  const refused = f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /question subject changed/);
  assert.equal(f.store.need('flow', 'flow-1').step, 'decision', 'a refused answer moves nothing');
  await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.equal(f.store.need('inbox', item.id).status, 'superseded');
});

test('an unchanged candidate is revalidated at the interval and stays parked', async t => {
  const f = sandbox(t, { question: true }), engine = new Engine(f.store, { revalidateMs: 200 }); f.start();
  const item = await parked(f, engine), fingerprints = engine.stats.fingerprints;
  await until(() => engine.stats.fingerprints >= fingerprints + 2, { tick: () => engine.tick() });
  assert.equal(f.store.need('flow', 'flow-1').state, 'waiting'); assert.equal(f.store.need('inbox', item.id).status, 'open');
  assert.equal(f.store.need('inbox', item.id).version, item.version, 'revalidation does not touch the question');
});

test('a parked question expires at the first tick after its time, with no store write to wake it', async t => {
  const f = sandbox(t, { question: true });
  const workflow = structuredClone(f.store.meta('workflow')); workflow.nodes.decision.expiryMs = 1500; validateWorkflow(workflow);
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.start();
  const item = await parked(f), expiresAt = Date.parse(item.expiresAt), fingerprints = f.engine.stats.fingerprints, changes = writes(f.store);
  while (Date.now() < expiresAt) {
    await f.engine.tick();
    if (Date.now() < expiresAt) { assert.equal(f.store.need('inbox', item.id).status, 'open'); assert.equal(writes(f.store), changes); }
    await delay(20);
  }
  await f.engine.tick();
  assert.equal(f.store.need('inbox', item.id).status, 'expired');
  const flow = f.store.need('flow', 'flow-1'); assert.equal(flow.state, 'stopped'); assert.match(flow.stopReason, /expired before an authorized answer/);
  assert.equal(f.engine.stats.fingerprints, fingerprints, 'expiry needs no fingerprint');
});

test('a store change re-checks a parked question at the next tick without a new fingerprint', async t => {
  const f = sandbox(t, { question: true }); f.start();
  const item = await parked(f), fingerprints = f.engine.stats.fingerprints, calls = gitCalls();
  // Unrelated write: the question is re-checked against the store and stays open.
  f.command('task.put', { task: { id: 'task-other', title: 'Fictional other work', acceptance: ['Observed'] } });
  const steps = f.engine.stats.steps; await f.engine.tick();
  assert.equal(f.engine.stats.steps, steps + 1); assert.equal(f.store.need('inbox', item.id).status, 'open');
  // Authority withdrawn: the flow stops at the next tick, as before.
  f.command('task.revoke', { taskId: f.task.id, note: 'Withdraw authority' });
  await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped'); assert.equal(f.store.need('inbox', item.id).status, 'superseded');
  assert.equal(f.engine.stats.fingerprints, fingerprints); assert.equal(gitCalls(), calls);
});

test('a write from another database connection wakes a parked question', async t => {
  const f = sandbox(t, { question: true }); f.start();
  const item = await parked(f);
  const other = new Store(f.stateDir);
  try { other.tx(() => { const row = other.need('inbox', item.id); row.expiresAt = new Date(Date.now() - 1000).toISOString(); other.put('inbox', row); }); } finally { other.close(); }
  await f.engine.tick();
  assert.equal(f.store.need('inbox', item.id).status, 'expired'); assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
});

test('a question, preparation and settlement are fingerprinted without the write lock; only the final dispatch and completion checks hold it', async t => {
  const f = sandbox(t, { question: true });
  const tick = async () => { process.env.FCT_LOCK_PROBE = join(f.stateDir, 'state.sqlite'); try { await f.engine.tick(); } finally { delete process.env.FCT_LOCK_PROBE; } };
  t.after(() => { delete process.env.FCT_LOCK_PROBE; });
  let seen = lines(lockLog).length; f.start();
  // Prepare, dispatch and settle the effect, then open the question.
  await until(() => question(f.store)?.status === 'open', { tick });
  for (let n = 0; n < 20; n++) await tick();
  let observed = lines(lockLog).slice(seen);
  assert.ok(observed.length >= 8, `fingerprints observed up to the open question: ${observed.length}`);
  // One fingerprint is two Git processes: the final input check of the one dispatch, and nothing else.
  assert.deepEqual(observed.filter(state => state !== 'free'), ['locked', 'locked']);
  const item = question(f.store); seen = lines(lockLog).length;
  assert.equal(f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' }).status, 'completed');
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick });
  observed = lines(lockLog).slice(seen);
  // The accepted candidate's check at completion, and nothing else.
  assert.deepEqual(observed, ['locked', 'locked']);
});

// The engine's write transaction waits (synchronously) for the lock. A second connection on
// another thread holds it, edits the candidate while the engine waits, and releases. A
// fingerprint taken before that wait would be stale; the check must be made with the lock held.
// The holder edits once it has seen a fingerprint start (two Git processes: the stale
// pre-lock fingerprint this guards against) or, when none is taken before the lock, after a
// pause in which the engine is already waiting. Either order must end with the flow stopped.
function holdWriteLockThenEdit(f, file, text) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads'), { DatabaseSync } = require('node:sqlite'), fs = require('node:fs');
    const count = () => fs.existsSync(workerData.gitLog) ? fs.readFileSync(workerData.gitLog, 'utf8').split('\\n').filter(Boolean).length : 0;
    const db = new DatabaseSync(workerData.database); db.exec('BEGIN IMMEDIATE');
    const before = count(), pause = new Int32Array(new SharedArrayBuffer(4)), end = Date.now() + 1500;
    parentPort.postMessage('held');
    while (count() < before + 2 && Date.now() < end) Atomics.wait(pause, 0, 0, 10);
    fs.writeFileSync(workerData.file, workerData.text);
    db.exec('ROLLBACK'); db.close(); parentPort.postMessage('released');
  `, { eval: true, workerData: { database: join(f.stateDir, 'state.sqlite'), gitLog, file, text } });
  const next = expected => new Promise((resolve, reject) => { worker.once('message', message => message === expected ? resolve() : reject(new Error(`unexpected ${message}`))); worker.once('error', reject); });
  return { held: next('held'), released: () => next('released') };
}

test('an input edited while the dispatch waits for the database write lock is not dispatched', async t => {
  const f = sandbox(t); f.start();
  await f.engine.tick();
  const attempt = f.store.all('attempt')[0]; assert.equal(attempt.status, 'prepared');
  const holder = holdWriteLockThenEdit(f, join(f.root, 'input.txt'), 'edited while the engine waited for the lock\n'); await holder.held;
  const released = holder.released();
  await f.engine.tick(); await released;
  const flow = f.store.need('flow', 'flow-1'), after = f.store.need('attempt', attempt.id);
  assert.equal(flow.state, 'stopped'); assert.match(flow.stopReason, /prepared input changed before dispatch/);
  assert.equal(after.status, 'prepared'); assert.equal(after.dispatchedAt, undefined);
  assert.ok(!f.store.events(100).some(event => event.type === 'attempt.dispatching'));
});

test('a candidate edited while completion waits for the database write lock does not complete', async t => {
  const f = sandbox(t, { question: true }); f.start();
  await until(() => question(f.store)?.status === 'open', { tick: () => f.engine.tick() });
  const item = question(f.store);
  assert.equal(f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' }).status, 'completed');
  assert.equal(f.store.need('flow', 'flow-1').step, 'done');
  const holder = holdWriteLockThenEdit(f, join(f.root, 'input.txt'), 'edited while the engine waited for the lock\n'); await holder.held;
  const released = holder.released();
  await f.engine.tick(); await released;
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.state, 'stopped'); assert.match(flow.stopReason, /accepted completion candidate changed/);
  assert.notEqual(f.store.need('task', f.task.id).status, 'completed');
});

test('a question is fingerprinted with no transaction open: another connection can write meanwhile', async t => {
  const f = sandbox(t, { question: true });
  let during = 0;
  const engine = new Engine(f.store, { fingerprint: async root => {
    const other = new Store(f.stateDir);
    try { other.db.exec('PRAGMA busy_timeout=0'); other.tx(() => other.setMeta('fictionalConcurrentWrite', ++during)); } finally { other.close(); }
    return repositoryIdentity(root);
  } });
  f.start();
  await until(() => question(f.store)?.status === 'open', { tick: () => engine.tick() });
  assert.ok(during >= 1); assert.equal(f.store.meta('fictionalConcurrentWrite'), during);
});

test('a stop that lands while the question is being fingerprinted is not overwritten', async t => {
  const f = sandbox(t, { question: true });
  let stop = false;
  const engine = new Engine(f.store, { fingerprint: async root => {
    if (stop) { stop = false; assert.equal(f.command('stop', { flowId: 'flow-1', note: 'Fictional operator stop' }).status, 'completed'); }
    return repositoryIdentity(root);
  } });
  f.start();
  await until(() => f.store.need('flow', 'flow-1').step === 'decision', { tick: () => f.store.need('flow', 'flow-1').step === 'decision' ? null : engine.tick() });
  stop = true; await engine.tick();
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.state, 'stopped'); assert.equal(flow.stopSequence, 1); assert.doesNotMatch(flow.stopReason, /flow is stopped/);
  assert.equal(f.store.all('inbox').filter(item => item.kind === 'question').length, 0, 'no question opened for a stopped flow');
});

test('a pending timer wait opens no transaction and writes nothing', async t => {
  const f = sandbox(t), workflow = { version: 1, start: 'waiting', nodes: { read: { kind: 'end', outcome: 'completed' }, waiting: { kind: 'wait', untilFrom: { step: 'read', field: 'until' }, maxWaitMs: 3600000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  validateWorkflow(workflow); f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.start();
  const flow = f.store.need('flow', 'flow-1'); flow.results.read = { until: new Date(Date.now() + 1800000).toISOString() }; f.store.put('flow', flow);
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'waiting');
  const changes = writes(f.store), other = new Store(f.stateDir);
  try {
    // A second connection holds the write lock: a tick that opened a write transaction would wait on it and fail.
    other.db.exec('BEGIN IMMEDIATE'); f.store.db.exec('PRAGMA busy_timeout=0');
    for (let n = 0; n < 20; n++) await f.engine.tick();
    assert.equal(f.store.need('flow', 'flow-1').state, 'waiting', 'a tick blocked on the write lock would have stopped the flow');
  } finally { other.db.exec('ROLLBACK'); other.close(); f.store.db.exec('PRAGMA busy_timeout=5000'); }
  assert.equal(writes(f.store), changes);
});

test('the operations tick starts no Git process for a parked change flow while nothing is queued', async t => {
  const f = sandbox(t);
  f.store.setMeta('config', { mode: 'delivery', repository: { target: 'main' }, policy: { autoQueue: true } });
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', { status: 'unknown' });
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'parked' });
  f.store.put('flow', { id: 'parked', taskId: 'parked-task', kind: 'change', state: 'waiting', workspace });
  writeFileSync(join(workspace.path, 'input.txt'), 'fictional candidate work\n');
  await operationalTick(f.store);
  let calls = gitCalls();
  for (let n = 0; n < 5; n++) await operationalTick(f.store);
  assert.equal(gitCalls() - calls, 0, 'Git processes started by five operations ticks with an empty queue');
  // A queued task is still judged against an observation of the active workspace.
  f.store.put('task', { id: 'queued-1', title: 'Fictional task', acceptance: ['Works'], revision: 'r', approvedRevision: 'r', paths: ['input.txt'] });
  f.store.put('queue', { id: 'queued-1', status: 'queued', order: 0 });
  calls = gitCalls(); await operationalTick(f.store);
  assert.ok(gitCalls() - calls >= 4, 'the workspace is observed once a task is queued');
  assert.ok(f.store.get('queue', 'queued-1').eligibility.reasons.some(reason => /paths overlap: parked/.test(reason)), JSON.stringify(f.store.get('queue', 'queued-1')));
});
