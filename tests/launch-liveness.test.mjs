import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandbox, until, delay, attemptState } from './helpers.mjs';
import { inspect, attemptDir, requestAbort, resumeInterruptedFreeze, launch, launchEndedBeforeOwnership, LAUNCH_ABORT_GRACE_MS, LAUNCH_STALL_NOTICE_MS } from '../starter/factory/core/effects.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';
import { atomicJSON } from '../starter/factory/core/contracts.mjs';
import { processIdentity } from '../starter/factory/core/process-identity.mjs';

// A supervisor can take longer than the launch window to record ownership on a busy host.
// While the launched supervisor process lives, the attempt is launching, not uncertain;
// once it is gone without ownership or a receipt, the attempt is uncertain.
test('a live but slow-starting supervisor keeps its attempt launching past the launch window', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const prepared = f.store.all('attempt')[0];
  const attempt = { ...prepared, status: 'dispatching', dispatchedAt: new Date(Date.now() - 60000).toISOString() };
  assert.equal(inspect(f.store, attempt).kind, 'uncertain', 'without launch evidence the old window still applies');
  const slow = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(() => { if (slow.exitCode === null && slow.signalCode === null) slow.kill('SIGKILL'); });
  await once(slow, 'spawn');
  const record = { attemptId: attempt.id, intentDigest: attempt.intentDigest, supervisor: processIdentity(slow.pid) };
  atomicJSON(join(attemptDir(f.store, attempt), 'launch.json'), record);
  assert.equal(inspect(f.store, attempt).kind, 'launching');
  atomicJSON(join(attemptDir(f.store, attempt), 'launch.json'), { ...record, intentDigest: 'f'.repeat(64) });
  assert.equal(inspect(f.store, attempt).kind, 'uncertain', 'launch evidence for another intent is not accepted');
  atomicJSON(join(attemptDir(f.store, attempt), 'launch.json'), record);
  slow.kill('SIGKILL'); await once(slow, 'exit');
  const effect = await until(() => { const value = inspect(f.store, attempt); return value.kind !== 'launching' && value; });
  assert.equal(effect.kind, 'uncertain'); assert.match(effect.reason, /no live owner/);
});

test('real dispatch records the launched supervisor identity', async t => {
  const f = sandbox(t, { argv: [process.execPath, '-e', 'setTimeout(()=>{},200)'] }); f.start(); await f.engine.tick(); await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  const launched = JSON.parse(readFileSync(join(attemptDir(f.store, attempt), 'launch.json'), 'utf8'));
  assert.equal(launched.attemptId, attempt.id); assert.equal(launched.intentDigest, attempt.intentDigest);
  assert.ok(Number.isSafeInteger(launched.supervisor.pid) && launched.supervisor.startTime);
  await until(() => f.store.need('attempt', attempt.id).settledAt, { tick: () => f.engine.tick() });
});

// Cancelling a launch that has not recorded ownership. The supervisor is real; the spawn hook
// only freezes it, or slows it with a preload, so the window before ownership can be held open.
const supervisorSpawn = (hook) => {
  const original = childProcess.spawn, launched = [];
  childProcess.spawn = (binary, args, options) => {
    if (!args[0]?.endsWith('/supervisor.mjs')) return original(binary, args, options);
    const child = hook(original, binary, args, options); launched.push(child); return child;
  };
  syncBuiltinESMExports();
  return { launched, async restore() {
    childProcess.spawn = original; syncBuiltinESMExports();
    for (const child of launched) if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }
  } };
};
const frozenSupervisor = (original, binary, args, options) => { const child = original(binary, args, options); process.kill(child.pid, 'SIGSTOP'); return child; };
const exited = child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit');
const age = (f, id, change) => { const row = f.store.need('attempt', id); change(row); f.store.put('attempt', row); };
const recordSignals = t => {
  const real = process.kill, sent = [];
  process.kill = (pid, signal) => { if (signal !== 0) sent.push({ pid, signal }); return real.call(process, pid, signal); };
  t.after(() => { process.kill = real; });
  return { sent, real };
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a supervisor stalled before ownership is asked to stop on revoke, killed after the grace and becomes reconcilable', async t => {
  // Restored first, so a failure cannot leave frozen supervisors for the sandbox cleanup or later tests.
  const hook = supervisorSpawn(frozenSupervisor); t.after(() => hook.restore()); const f = sandbox(t);
  f.start(); await f.engine.tick(); await f.engine.tick();
  const [supervisor] = hook.launched, attempt = f.store.all('attempt')[0];
  age(f, attempt.id, row => { row.dispatchedAt = new Date(Date.now() - 3600000).toISOString(); });
  assert.equal(existsSync(join(attemptDir(f.store, attempt), 'owner.json')), false);
  assert.equal(inspect(f.store, attempt).kind, 'launching');
  assert.equal(f.command('task.revoke', { taskId: f.task.id, note: 'Revoke during a stalled launch' }).status, 'completed');
  const signals = recordSignals(t);
  await f.engine.tick();
  assert.deepEqual(signals.sent.filter(s => s.pid === supervisor.pid), [], 'no signal within the grace');
  const requested = f.store.need('attempt', attempt.id).launchAbort.requestedAt;
  assert.deepEqual(JSON.parse(readFileSync(join(attemptDir(f.store, attempt), 'abort.json'), 'utf8')), { attemptId: attempt.id, intentDigest: attempt.intentDigest, requestedAt: requested }, 'durable stop request');
  await f.engine.tick();
  assert.deepEqual(signals.sent.filter(s => s.pid === supervisor.pid), []);
  assert.equal(supervisor.signalCode, null, 'not killed within the grace');
  assert.equal(f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'failed', costMicros: 0, note: 'Too early' }).status, 'rejected', 'a live launch cannot be reconciled');
  age(f, attempt.id, row => { row.launchAbort.requestedAt = new Date(Date.now() - LAUNCH_ABORT_GRACE_MS - 1000).toISOString(); });
  await f.engine.tick();
  assert.deepEqual(signals.sent.filter(s => s.pid === supervisor.pid).map(s => s.signal), ['SIGSTOP', 'SIGKILL']);
  await exited(supervisor); assert.equal(supervisor.signalCode, 'SIGKILL');
  assert.ok(f.store.need('attempt', attempt.id).launchAbort.killedAt);
  assert.ok(f.store.events(20).some(e => e.type === 'attempt.launch-killed'));
  const uncertain = await until(() => f.store.need('attempt', attempt.id).status === 'uncertain' && f.store.need('attempt', attempt.id), { tick: () => f.engine.tick(), explain: attemptState(f, attempt) });
  assert.match(uncertain.reason, /ended before recording ownership/);
  // Quiescence is established from the launch evidence: the supervisor is gone and never owned anything.
  const resolution = f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'failed', costMicros: 0, note: 'Supervisor killed before ownership' });
  assert.equal(resolution.status, 'completed', JSON.stringify(resolution));
  assert.ok(f.store.need('attempt', attempt.id).settledAt);
});

test('a stop request received before ownership means the effect is never started', async t => {
  const f = sandbox(t, { argv: [process.execPath, '-e', 'require("fs").writeFileSync("effect-started","yes");setInterval(()=>{},1000)'] });
  const stalling = join(f.base, 'stalling'), preload = join(f.base, 'stall-before-ownership.mjs');
  // Holds the supervisor, alive and busy, just before it records ownership.
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;
fs.renameSync=(from,to)=>{if(String(to).endsWith('/owner.json')){fs.writeFileSync(${JSON.stringify(stalling)},'');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);}return rename(from,to);};syncBuiltinESMExports();`);
  const hook = supervisorSpawn((original, binary, args, options) => original(binary, ['--import', pathToFileURL(preload).href, ...args], options)); t.after(() => hook.restore());
  f.start(); await f.engine.tick(); await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  await until(() => existsSync(stalling), { explain: attemptState(f, attempt) });
  assert.equal(inspect(f.store, attempt).kind, 'launching');
  f.command('task.revoke', { taskId: f.task.id, note: 'Revoke before ownership' });
  await f.engine.tick();
  const settled = await until(() => f.store.need('attempt', attempt.id).settledAt && f.store.need('attempt', attempt.id), { tick: () => f.engine.tick(), explain: attemptState(f, attempt) });
  assert.equal(settled.receipt.reason, 'abort'); assert.equal(settled.receipt.effectStarted, false);
  assert.equal(existsSync(join(f.root, 'effect-started')), false, 'the effect never ran');
  await exited(hook.launched[0]); assert.equal(hook.launched[0].exitCode, 0, 'the supervisor wrote its receipt and exited');
});

test('when ownership is recorded as the launch is frozen, the supervisor is resumed, never killed', async t => {
  // Restored first, so a failure cannot leave frozen supervisors for the sandbox cleanup or later tests.
  const hook = supervisorSpawn(frozenSupervisor); t.after(() => hook.restore()); const f = sandbox(t);
  f.start(); await f.engine.tick(); await f.engine.tick();
  const [supervisor] = hook.launched, attempt = f.store.all('attempt')[0];
  f.command('task.revoke', { taskId: f.task.id, note: 'Revoke racing ownership' });
  await f.engine.tick();
  age(f, attempt.id, row => { row.launchAbort.requestedAt = new Date(Date.now() - LAUNCH_ABORT_GRACE_MS - 1000).toISOString(); });
  const signals = recordSignals(t);
  // The supervisor wins: it records ownership just before the freeze lands.
  process.kill = (pid, signal) => {
    if (pid === supervisor.pid && signal === 'SIGSTOP') atomicJSON(join(attemptDir(f.store, attempt), 'owner.json'), { ...processIdentity(supervisor.pid), attemptId: attempt.id, intentDigest: attempt.intentDigest });
    signals.sent.push({ pid, signal }); return signals.real.call(process, pid, signal);
  };
  await f.engine.tick();
  assert.deepEqual(signals.sent.filter(s => s.pid === supervisor.pid).map(s => s.signal), ['SIGSTOP', 'SIGCONT']);
  assert.ok(f.store.events(20).some(e => e.type === 'attempt.launch-abort-owned'));
  // Resumed, it reads the stop request before starting the effect and records an aborted receipt.
  await exited(supervisor); assert.equal(supervisor.signalCode, null); assert.equal(supervisor.exitCode, 0);
  const settled = await until(() => f.store.need('attempt', attempt.id).settledAt && f.store.need('attempt', attempt.id), { tick: () => f.engine.tick(), explain: attemptState(f, attempt) });
  assert.equal(settled.receipt.reason, 'abort'); assert.equal(settled.receipt.effectStarted, false);
  assert.equal(settled.launchAbort.killedAt, undefined);
});

test('launch evidence whose PID now belongs to another process never signals that process', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const prepared = f.store.all('attempt')[0];
  const attempt = { ...prepared, status: 'dispatching', dispatchedAt: new Date(Date.now() - 3600000).toISOString() };
  f.store.put('attempt', attempt);
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  t.after(async () => { if (other.exitCode === null && other.signalCode === null) { const done = once(other, 'exit'); other.kill('SIGKILL'); await done; } });
  await once(other, 'spawn');
  // Same PID, different process start: the recorded supervisor is gone and the PID was reused.
  const reused = { ...processIdentity(other.pid), startTime: '1' };
  atomicJSON(join(attemptDir(f.store, attempt), 'launch.json'), { attemptId: attempt.id, intentDigest: attempt.intentDigest, supervisor: reused });
  assert.equal(inspect(f.store, attempt).kind, 'uncertain');
  const signals = recordSignals(t);
  await requestAbort(f.store, attempt, { graceMs: 0 });
  await requestAbort(f.store, attempt);
  assert.deepEqual(signals.sent.filter(s => s.pid === other.pid), []);
  assert.equal(alive(other.pid), true);
  // The recorded identity matched when the abort began, and the PID is reused before escalation.
  atomicJSON(join(attemptDir(f.store, attempt), 'launch.json'), { attemptId: attempt.id, intentDigest: attempt.intentDigest, supervisor: processIdentity(other.pid) });
  age(f, attempt.id, row => { row.launchAbort = { requestedAt: new Date(Date.now() - 60000).toISOString(), supervisor: processIdentity(other.pid) }; });
  atomicJSON(join(attemptDir(f.store, attempt), 'launch.json'), { attemptId: attempt.id, intentDigest: attempt.intentDigest, supervisor: reused });
  await requestAbort(f.store, f.store.need('attempt', attempt.id), { graceMs: 0 });
  assert.deepEqual(signals.sent.filter(s => s.pid === other.pid), []);
  assert.equal(alive(other.pid), true);
});

test('without launch evidence (systemd mode) the launch window still applies and nothing is signalled', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const bin = join(f.base, 'bin'), calls = join(f.base, 'systemd-run.calls');
  mkdirSync(bin); writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\n`, { mode: 0o755 });
  const project = f.store.meta('project'); f.store.setMeta('project', { ...project, supervisor: 'systemd' });
  const prepared = f.store.all('attempt')[0];
  const attempt = { ...prepared, status: 'dispatching', dispatchedAt: new Date().toISOString(), unit: 'factotum-fixture-unit' };
  const path = process.env.PATH; process.env.PATH = `${bin}:${path}`;
  try { await launch(f.store, attempt); } finally { process.env.PATH = path; }
  assert.match(readFileSync(calls, 'utf8'), /--unit=factotum-fixture-unit/);
  assert.equal(existsSync(join(attemptDir(f.store, attempt), 'launch.json')), false, 'systemd mode records no launch evidence');
  f.store.put('attempt', attempt);
  assert.deepEqual(inspect(f.store, attempt), { kind: 'launching' });
  const signals = recordSignals(t);
  await requestAbort(f.store, attempt, { graceMs: 0 });
  assert.deepEqual(signals.sent, []); assert.equal(f.store.need('attempt', attempt.id).launchAbort, undefined);
  const late = { ...attempt, dispatchedAt: new Date(Date.now() - 5001).toISOString() };
  assert.deepEqual(inspect(f.store, late), { kind: 'uncertain', reason: 'dispatch has no live owner or terminal receipt' });
  f.store.put('attempt', late);
});

test('a live launch stalled past the notice bound is reported, not declared lost', async t => {
  // Restored first, so a failure cannot leave frozen supervisors for the sandbox cleanup or later tests.
  const hook = supervisorSpawn(frozenSupervisor); t.after(() => hook.restore()); const f = sandbox(t);
  f.start(); await f.engine.tick(); await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  await f.engine.tick();
  assert.equal(f.store.need('attempt', attempt.id).launchStalled, undefined, 'a young launch is not reported');
  age(f, attempt.id, row => { row.dispatchedAt = new Date(Date.now() - LAUNCH_STALL_NOTICE_MS - 1000).toISOString(); });
  await f.engine.tick(); await f.engine.tick();
  const current = f.store.need('attempt', attempt.id);
  assert.equal(current.status, 'dispatching'); assert.equal(inspect(f.store, current).kind, 'launching');
  assert.equal(current.launchStalled.supervisorPid, hook.launched[0].pid);
  assert.equal(f.store.events(50).filter(e => e.type === 'attempt.launch-stalled').length, 1, 'reported once');
  const hold = queueStatus(f.store).holds.find(h => h.kind === 'launch-stalled');
  assert.equal(hold.attemptId, attempt.id); assert.match(hold.text, /Stop the flow to abort it/);
  assert.equal(snapshot(f.store).attempts.find(a => a.id === attempt.id).launchStalled.since, current.dispatchedAt, 'in the attempt view');
  assert.equal(f.store.need('flow', attempt.flowId).abortRequested, false, 'reporting does not abort');
  await hook.restore();
});

test('aborts racing a real supervisor through startup and ownership never leave an effect running', async t => {
  for (const wait of [0, 10, 25, 50, 80, 120, 200, 400]) {
    await t.test(`abort ${wait} ms after dispatch`, async t => {
      const f = sandbox(t, { argv: [process.execPath, '-e', 'require("fs").writeFileSync("effect.pid",String(process.pid));setInterval(()=>{},1000)'] });
      f.start(); await f.engine.tick(); await f.engine.tick();
      const attempt = f.store.all('attempt')[0];
      await delay(wait);
      f.command('task.revoke', { taskId: f.task.id, note: 'Revoke racing startup' });
      const end = await until(() => { const row = f.store.need('attempt', attempt.id); return (row.settledAt || row.status === 'uncertain') && row; }, { tick: () => f.engine.tick(), explain: attemptState(f, attempt) });
      const pidPath = join(f.root, 'effect.pid');
      if (existsSync(pidPath)) await until(() => !alive(Number(readFileSync(pidPath, 'utf8'))), { explain: () => `effect ${readFileSync(pidPath, 'utf8')} still running; ${attemptState(f, attempt)()}` });
      if (end.status === 'uncertain') assert.equal(f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'failed', costMicros: 0, note: 'Quiescent' }).status, 'completed');
      else assert.equal(end.receipt.reason, 'abort');
    });
  }
});

// Re-check fixes: malformed launch identity is not evidence, and an owned supervisor left
// frozen by a runner crash during launch cancellation is continued so it can stop.
test('launch evidence without a usable process identity is not evidence and grants no shortcut', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const prepared = f.store.all('attempt')[0];
  const attempt = { ...prepared, status: 'dispatching', dispatchedAt: new Date(Date.now() - 60000).toISOString() };
  for (const supervisor of [{}, { pid: 1 }, { pid: 1, bootId: 'x', startTime: '1' }, { pid: -4, bootId: 'a'.repeat(32), startTime: '1' }]) {
    atomicJSON(join(attemptDir(f.store, attempt), 'launch.json'), { attemptId: attempt.id, intentDigest: attempt.intentDigest, supervisor });
    assert.equal(launchEndedBeforeOwnership(f.store, attempt), false, JSON.stringify(supervisor));
    const effect = inspect(f.store, attempt);
    assert.equal(effect.kind, 'uncertain'); assert.doesNotMatch(effect.reason, /ended before recording ownership/);
  }
});

// A frozen fixture must be continued and reaped before sandbox cleanup runs, even on failure.
async function stoppedChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  await once(child, 'spawn');
  const exited = once(child, 'exit');
  process.kill(child.pid, 'SIGSTOP');
  await until(() => readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1].startsWith('T'));
  const state = () => { try { return readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(') ')[1][0]; } catch { return 'gone'; } };
  const reap = async () => { if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 'SIGCONT'); } catch {} child.kill('SIGKILL'); await exited; } };
  return { child, exited, state, reap };
}

test('an owned supervisor left frozen across a runner restart is continued and stops on abort', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const prepared = f.store.all('attempt')[0];
  const attempt = { ...prepared, status: 'dispatching', dispatchedAt: new Date().toISOString() };
  const { child: owner, exited, reap } = await stoppedChild();
  try {
    atomicJSON(join(attemptDir(f.store, attempt), 'owner.json'), { attemptId: attempt.id, intentDigest: attempt.intentDigest, ...processIdentity(owner.pid) });
    assert.equal(inspect(f.store, attempt).kind, 'running');
    await requestAbort(f.store, attempt);
    const outcome = await Promise.race([exited.then(([, signal]) => signal), delay(10000).then(() => 'still-stopped')]);
    assert.equal(outcome, 'SIGTERM', 'the stop is delivered once the process is continued');
  } finally { await reap(); }
});

test('a supervisor frozen by an interrupted launch cancellation is continued whatever the attempt state', async t => {
  const f = sandbox(t); f.start(); await f.engine.tick();
  const prepared = f.store.all('attempt')[0];
  const { child, state, reap } = await stoppedChild();
  try {
    // Ownership and a receipt may have won before the freeze; the attempt can already be terminal.
    // A stopped process with no recorded freeze (stopped by someone else) is left alone.
    f.store.put('attempt', { ...prepared, launchAbort: { requestedAt: new Date().toISOString(), supervisor: processIdentity(child.pid) } });
    assert.equal(resumeInterruptedFreeze(f.store, prepared), false); assert.equal(state(), 'T');
    f.store.put('attempt', { ...prepared, launchAbort: { requestedAt: new Date().toISOString(), supervisor: processIdentity(child.pid), frozen: true } });
    assert.equal(resumeInterruptedFreeze(f.store, prepared), true);
    assert.equal(f.store.need('attempt', prepared.id).launchAbort.frozen, false);
    await until(() => state() !== 'T');
    assert.notEqual(state(), 'T');
    // Identity is checked first: a recorded identity that no longer matches is never signalled.
    process.kill(child.pid, 'SIGSTOP'); await until(() => state() === 'T');
    f.store.put('attempt', { ...prepared, launchAbort: { requestedAt: new Date().toISOString(), supervisor: { ...processIdentity(child.pid), startTime: '1' }, frozen: true } });
    assert.equal(resumeInterruptedFreeze(f.store, prepared), false);
    assert.equal(state(), 'T');
  } finally { await reap(); }
});

test('a stop signal arriving while the receipt is being published never kills the supervisor', async t => {
  const f = sandbox(t, { argv: [process.execPath, '-e', ''] });
  const publishing = join(f.base, 'publishing'), preload = join(f.base, 'stall-receipt.mjs');
  // Holds the supervisor just before it renames receipt.json into place.
  writeFileSync(preload, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.renameSync;
fs.renameSync=(from,to)=>{if(String(to).endsWith('/receipt.json')){fs.writeFileSync(${JSON.stringify(publishing)},'');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);}return rename(from,to);};syncBuiltinESMExports();`);
  const hook = supervisorSpawn((original, binary, args, options) => original(binary, ['--import', pathToFileURL(preload).href, ...args], options));
  try {
    f.start(); await f.engine.tick(); await f.engine.tick();
    const attempt = f.store.all('attempt')[0];
    await until(() => existsSync(publishing), { explain: attemptState(f, attempt) });
    const supervisor = hook.launched[0];
    process.kill(supervisor.pid, 'SIGTERM');
    await exited(supervisor);
    assert.equal(supervisor.signalCode, null, 'the supervisor was not killed by the late stop');
    assert.equal(supervisor.exitCode, 0);
    assert.ok(existsSync(join(attemptDir(f.store, attempt), 'receipt.json')), 'the receipt was published');
  } finally { await hook.restore(); }
});
