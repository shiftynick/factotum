import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { sandbox, until, attemptState } from './helpers.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { backupProject, restoreProject } from '../starter/factory/core/backup.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { inspect, attemptDir } from '../starter/factory/core/effects.mjs';
import { atomicJSON, digest, uid } from '../starter/factory/core/contracts.mjs';
import { supervise } from '../starter/factory/core/supervisor.mjs';

test('approval, actor boundaries and content-bound command deduplication', t => {
  const f = sandbox(t);
  assert.equal(f.command('flow.start', { taskId: f.task.id }).status, 'rejected');
  assert.equal(f.command('task.approve', { taskId: f.task.id, revision: f.task.revision }, { actor: 'orchestrator' }).status, 'rejected');
  const commandId = uid(), payload = { taskId: f.task.id, revision: f.task.revision };
  const first = f.command('task.approve', payload, { commandId });
  assert.deepEqual(f.command('task.approve', payload, { commandId }), first);
  assert.throws(() => f.command('task.approve', { ...payload, revision: 'changed' }, { commandId }), /different content/);
  assert.equal(f.command('task.put', { task: { ...f.task, acceptance: ['Different acceptance'] } }).result.approvedRevision, null);
  assert.equal(f.command('flow.start', { taskId: f.task.id }).status, 'rejected');
});

test('stop before dispatch leaves no effect; admission unpause does not resume flow', async t => {
  const f = sandbox(t, { argv: [process.execPath, '-e', 'require("fs").writeFileSync("effect.txt","once")'] });
  f.start(); await f.engine.tick();
  assert.equal(f.store.all('attempt')[0].status, 'prepared');
  f.command('stop', { flowId: 'flow-1', note: 'Test before boundary' });
  await f.engine.tick();
  f.command('pause', { paused: false, note: 'Only release admission' });
  await f.engine.tick();
  assert.equal(existsSync(join(f.root, 'effect.txt')), false);
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.equal(f.command('flow.start', { taskId: f.task.id }).status, 'rejected');
  assert.equal(f.command('resume', { flowId: 'flow-1', note: 'Prepared attempt proven not dispatched' }).status, 'completed');
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  assert.equal(readFileSync(join(f.root, 'effect.txt'), 'utf8'), 'once');
  assert.equal(f.store.need('task', f.task.id).approvedRevision, null);
});

// The effect finishes only when the test releases it, so it is still running when stopped however slowly the host schedules either side.
const releasable = [process.execPath, '-e', 'const fs=require("fs");const t=setInterval(()=>{if(fs.existsSync("release")){clearInterval(t);console.log("done");}},20)'];
test('late successful receipt records cost without progressing stopped work', async t => {
  const f = sandbox(t, { argv: releasable });
  f.start(); await f.engine.tick(); await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  await until(() => inspect(f.store, attempt).kind === 'running', { explain: attemptState(f, attempt) });
  f.command('stop', { flowId: 'flow-1', note: 'Let running attempt finish' });
  writeFileSync(join(f.root, 'release'), '');
  await until(() => f.store.need('attempt', attempt.id).settledAt, { tick: () => f.engine.tick() });
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.equal(f.store.need('flow', 'flow-1').resumeStep, 'done');
  const terminal = f.store.need('attempt', attempt.id);
  f.engine.uncertain(attempt, 'stale observational write');
  f.engine.settle('flow-1', attempt, terminal.receipt);
  assert.deepEqual(f.store.need('attempt', attempt.id), terminal);
  assert.equal(f.store.events().filter(e => e.type === 'attempt.settled').length, 1);
});

test('revocation cancels owned running work and resume requires a new grant', async t => {
  // The effect never finishes by itself, so only revocation can end it.
  const f = sandbox(t, { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'] });
  f.start(); await f.engine.tick(); await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  await until(() => inspect(f.store, attempt).kind === 'running', { explain: attemptState(f, attempt) });
  f.command('task.revoke', { taskId: f.task.id, note: 'Withdraw authority' });
  await until(() => f.store.need('attempt', attempt.id).settledAt, { tick: () => f.engine.tick() });
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.equal(f.command('resume', { flowId: 'flow-1', note: 'No new grant' }).status, 'rejected');
  assert.equal(f.store.need('attempt', attempt.id).receipt.reason, 'abort');
});

test('read/ack are not answers; candidate changes reject a stale answer', async t => {
  const f = sandbox(t, { question: true }); f.start();
  await until(() => f.store.all('inbox')[0], { tick: () => f.engine.tick() });
  const item = f.store.all('inbox')[0];
  f.command('inbox.read', { inboxId: item.id }); f.command('inbox.ack', { inboxId: item.id });
  assert.equal(f.store.need('inbox', item.id).status, 'open');
  const payload = { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' };
  assert.equal(f.command('answer', payload, { actor: 'orchestrator' }).status, 'rejected');
  writeFileSync(join(f.root, 'input.txt'), 'changed candidate\n');
  assert.equal(f.command('answer', payload).status, 'rejected');
  await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.equal(f.store.need('inbox', item.id).status, 'superseded');
});

test('duplicate answers do not cause a second transition', async t => {
  const f = sandbox(t, { question: true }); f.start();
  await until(() => f.store.all('inbox')[0], { tick: () => f.engine.tick() });
  const item = f.store.all('inbox')[0], payload = { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' };
  assert.equal(f.command('answer', payload).status, 'completed');
  assert.equal(f.command('answer', payload).status, 'rejected');
  await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'completed');
});

test('completion rechecks the accepted candidate after the operator answer', async t => {
  const f = sandbox(t, { question: true }); f.start();
  await until(() => f.store.all('inbox')[0], { tick: () => f.engine.tick() });
  const item = f.store.all('inbox')[0];
  assert.equal(f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' }).status, 'completed');
  writeFileSync(join(f.root, 'input.txt'), 'changed after answer acceptance');
  await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.match(f.store.need('flow', 'flow-1').stopReason, /accepted completion candidate changed/);
  assert.equal(f.store.need('task', f.task.id).approvedRevision, f.task.revision);
});

test('expired questions hold the action rather than granting consent', async t => {
  const f = sandbox(t, { question: true }); f.start();
  await until(() => f.store.all('inbox')[0], { tick: () => f.engine.tick() });
  const item = f.store.all('inbox')[0];
  f.store.tx(() => { item.expiresAt = new Date(Date.now() - 1000).toISOString(); f.store.put('inbox', item); });
  assert.equal(f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'continue' }).status, 'rejected');
  await f.engine.tick();
  assert.equal(f.store.need('inbox', item.id).status, 'expired');
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
});

test('prepared commands refuse a changed input tree before dispatch', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  writeFileSync(join(f.root, 'input.txt'), 'changed before launch');
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.equal(f.store.all('attempt')[0].status, 'not-dispatched');
});

test('missing receipt after a zero-cost external effect parks rather than replaying', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  writeFileSync(join(f.root, 'external-effect.txt'), 'already happened');
  f.store.tx(() => { attempt.status = 'dispatching'; attempt.dispatchedAt = new Date(Date.now() - 6000).toISOString(); f.store.put('attempt', attempt); });
  await f.engine.tick(); await f.engine.tick();
  assert.equal(f.store.need('attempt', attempt.id).status, 'uncertain');
  assert.equal(f.store.all('attempt').length, 1);
  assert.equal(f.command('resume', { flowId: 'flow-1', note: 'Cannot infer replay safety from cost' }).status, 'rejected');
});

test('controller SIGKILL leaves supervisor alive; restart settles same attempt once', async t => {
  const f = sandbox(t, { argv: [process.execPath, '-e', 'require("fs").appendFileSync("count.txt","once\\n");setTimeout(()=>{},700)'] });
  f.start();
  const socket = join(f.base, 'project.sock');
  const child = spawn(process.execPath, [resolve('starter/factory/cli.mjs'), 'serve', '--state', f.stateDir, '--socket', socket], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = ''; child.stderr.on('data', data => { diagnostics += data; });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await until(() => existsSync(join(f.root, 'count.txt')));
  const attempt = f.store.all('attempt')[0];
  child.kill('SIGKILL'); await once(child, 'exit');
  const restarted = await startProjectService({ stateDir: f.stateDir, socketPath: socket });
  try {
    await until(() => f.store.need('flow', 'flow-1').state === 'completed');
    assert.equal(readFileSync(join(f.root, 'count.txt'), 'utf8'), 'once\n', diagnostics);
    assert.equal(f.store.all('attempt').length, 1);
    assert.equal(f.store.events().filter(e => e.type === 'attempt.settled').length, 1);
  } finally { await restarted.close(); }
});

test('one live service owns each project even with different socket paths', async t => {
  const f = sandbox(t);
  const service = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'one.sock'), run: false });
  try { await assert.rejects(startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'two.sock'), run: false }), /already owned/); }
  finally { await service.close(); }
});

test('concurrent initialization cannot replace one canonical project identity', async t => {
  const f = sandbox(t), stateDir = join(f.base, 'initialization-race');
  const moduleURL = pathToFileURL(resolve('starter/factory/core/store.mjs')).href;
  const script = `import { initProject } from ${JSON.stringify(moduleURL)}; try { console.log(JSON.stringify(initProject({stateDir:process.argv[1],root:process.argv[2],name:'Fictional race',workflow:{version:1,start:'done',nodes:{done:{kind:'end',outcome:'completed'}}}}))); } catch(error) { process.exitCode=1; }`;
  const outcomes = await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, stateDir, f.root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject); child.once('close', code => resolve({ code, stdout }));
  })));
  const successful = outcomes.filter(result => result.code === 0);
  assert.equal(successful.length, 1);
  const canonical = new Store(stateDir);
  try { assert.equal(canonical.meta('project').projectId, JSON.parse(successful[0].stdout).projectId); }
  finally { canonical.close(); }
});

test('restore verifies artifacts and retains reservations under a dispatch hold', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  f.store.tx(() => { attempt.reservedMicros = 23; f.store.put('attempt', attempt); });
  const backup = join(f.base, 'backup'), restored = join(f.base, 'restored');
  backupProject(f.stateDir, backup); restoreProject(backup, restored);
  const store = new Store(restored);
  try {
    await new Engine(store).tick();
    assert.equal(store.meta('paused'), true); assert.equal(store.meta('recoveryHold'), true);
    assert.equal(store.need('attempt', attempt.id).reservedMicros, 23);
    assert.equal(store.need('attempt', attempt.id).status, 'prepared');
  } finally { store.close(); }
  writeFileSync(join(backup, 'attempts', attempt.id, 'intent.json'), 'corrupt');
  assert.throws(() => restoreProject(backup, join(f.base, 'bad')), /corrupt/);
  assert.equal(existsSync(join(f.base, 'bad')), false);
});

test('missing or corrupt authoritative state never becomes an empty project', t => {
  const f = sandbox(t), missing = join(f.base, 'missing');
  assert.throws(() => new Store(missing), /missing/); assert.equal(existsSync(missing), false);
  const corrupt = join(f.base, 'broken');
  // A separately created non-database must not be replaced by initialization on open.
  mkdirSync(corrupt); writeFileSync(join(corrupt, 'state.sqlite'), 'broken');
  assert.throws(() => new Store(corrupt), /database/);
  assert.equal(readFileSync(join(corrupt, 'state.sqlite'), 'utf8'), 'broken');
});

// The descendant outlives any scheduling delay, so the supervisor cannot miss it by
// checking late; termination is proven by the process disappearing, not by elapsed time.
test('supervisor rejects surviving background descendants before receipt', async t => {
  const f = sandbox(t), dir = join(f.base, 'descendant');
  const intent = { version: 1, attemptId: uid(), argv: ['/bin/sh', '-c', '(sleep 600; touch late-effect) >/dev/null 2>&1 & echo $! > descendant.pid'], cwd: f.root, timeoutMs: 60000, synthetic: true, maxCostMicros: 0 };
  const path = join(dir, 'intent.json'); atomicJSON(path, { ...intent, intentDigest: digest(intent) });
  const receipt = await supervise(path);
  assert.equal(receipt.reason, 'descendant-survival');
  const pid = Number(readFileSync(join(f.root, 'descendant.pid'), 'utf8'));
  await until(() => { try { return /^\S+ \(.*\) [ZX]/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; } });
  assert.equal(existsSync(join(f.root, 'late-effect')), false);
});

test('an open notice of the flow does not block its next question', async t => {
  // Reported by an adopter trial: a recovered flow with an unacknowledged stop notice stopped
  // again at its next question node with "question subject changed; revalidation required".
  const f = sandbox(t, { question: true }); f.start();
  f.store.put('inbox', { id: 'flow-notice:flow-1:stopped:fictional', kind: 'notice', flowId: 'flow-1', status: 'open', version: 1, role: 'operator', title: 'Flow stopped', createdAt: new Date().toISOString() });
  const question = await until(() => f.store.all('inbox').find(item => item.kind === 'question' && item.flowId === 'flow-1'), { tick: () => f.engine.tick() });
  assert.equal(question.status, 'open');
  assert.notEqual(f.store.need('flow', 'flow-1').state, 'stopped');
  assert.equal(f.store.need('inbox', 'flow-notice:flow-1:stopped:fictional').status, 'open', 'the notice is untouched');
});
