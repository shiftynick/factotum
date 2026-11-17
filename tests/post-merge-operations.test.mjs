import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, delay, until } from './helpers.mjs';
import { digest, atomicJSON } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { metrics } from '../starter/factory/operations/governance.mjs';
import { operationalTick, runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';

async function mergedFixture(t, { autoQueue = true, syncTargets, target } = {}) {
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  const identity = repositoryIdentity(f.root);
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/post-merge', account: 'fictional', target: 'main', remote: 'origin' }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, mainChecks: [{ id: 'actual-baseline', argv: [process.execPath, '-e', "if(!require('node:fs').readFileSync('input.txt','utf8').includes('fictional'))process.exit(1)"], timeoutMs: 60000 }], checks: [{ id: 'acceptance', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { planning: false, autoQueue, maxFlows: 1 } };
  const workflow = { version: 1, start: 'merge', nodes: { merge: { kind: 'effect', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  if (syncTargets) config.repository.syncTargets = syncTargets;
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) }); f.store.setMeta('mainHealth', { status: 'green', head: identity.head, checkedAt: new Date().toISOString() });
  assert.equal(f.command('task.approve', { taskId: f.task.id, revision: f.task.revision }).status, 'completed');
  assert.equal(f.command('flow.start', { taskId: f.task.id, revision: f.task.revision, flowId: 'flow-1' }).status, 'completed');
  const flow = f.store.need('flow', 'flow-1'); flow.mergeAuthorization = { identity, taskRevision: flow.taskRevision, configDigest: flow.configDigest }; if (target) flow.target = target; f.store.put('flow', flow);
  await f.engine.tick(); const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId);
  attempt.intent = { ...attempt.intent, action: { operation: 'forge.merge' } };
  // Only the forge boundary is substituted. All canonical admission, settlement, jobs and baseline checks below run normally.
  const result = { route: 'merged', merged: true, sha: identity.head, expectedHead: identity.head, expectedBase: identity.head, outputIdentity: identity };
  const receipt = { version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: result };
  f.engine.settle(flow.id, attempt, receipt);
  return { ...f, flow, attempt, result, receipt, identity, config };
}

test('merged settlement invalidates main health and authorizes exactly one post-merge baseline before another queued admission', async t => {
  const f = await mergedFixture(t);
  assert.equal(f.store.meta('mainHealth').status, 'unknown'); assert.equal(f.store.meta('mainHealth').head, f.result.sha);
  let jobs = f.store.all('job'); assert.equal(jobs.length, 1); const job = jobs[0];
  assert.equal(job.id, `post-merge-main:${f.flow.id}`); assert.equal(job.operation, 'main.verify'); assert.equal(job.status, 'queued'); assert.equal(job.grant.actor, 'operator'); assert.equal(job.grant.source, 'configuration'); assert.equal(job.grant.policy, 'autoQueue'); assert.equal(job.grant.configDigest, f.store.meta('configDigest'));
  f.engine.settle(f.flow.id, f.attempt, f.receipt); assert.equal(f.store.all('job').length, 1, 'settlement replay cannot multiply authorized baseline jobs');
  await f.engine.tick(); assert.equal(f.store.need('flow', f.flow.id).state, 'completed');
  const next = f.command('task.put', { task: { id: 'next', title: 'Next fictional queued task', acceptance: ['Fictional behavior'] } }).result;
  f.command('task.approve', { taskId: next.id, revision: next.revision }); f.command('queue.put', { taskIds: [next.id] });
  const held = f.command('flow.start', { taskId: next.id, revision: next.revision }); assert.equal(held.status, 'rejected'); assert.match(held.error, /main health/);
  await operationalTick(f.store); assert.equal(f.store.get('queue', next.id).status, 'queued'); assert.equal(f.store.all('flow').filter(flow => flow.taskId === next.id).length, 0);
  const baseline = f.store.need('flow', f.store.need('job', job.id).flowId); assert.equal(baseline.kind, 'maintenance');
  await f.engine.tick(); const attempt = f.store.need('attempt', f.store.need('flow', baseline.id).attemptId); assert.equal(attempt.intent.action.operation, 'main.verify');
  // Resource containment has separate real-cgroup qualification. This exercise runs real Git and checks offline directly.
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } });
  assert.equal(outcome.mainHealth.status, 'green'); assert.equal(outcome.mainHealth.head, f.identity.head); assert.equal(outcome.mainHealth.checks.length, 1); assert.equal(outcome.mainHealth.checks[0].passed, true);
  f.engine.settle(baseline.id, attempt, { version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: outcome });
  await f.engine.tick(); assert.equal(f.store.need('flow', baseline.id).state, 'completed'); assert.equal(f.store.meta('mainHealth').status, 'green');
  await operationalTick(f.store); assert.equal(f.store.get('queue', next.id).status, 'claimed'); assert.equal(f.store.all('flow').filter(flow => flow.taskId === next.id).length, 1);
});

test('manual policy still invalidates main but does not invent automatic maintenance authority', async t => {
  const f = await mergedFixture(t, { autoQueue: false }); assert.equal(f.store.meta('mainHealth').status, 'unknown'); assert.equal(f.store.all('job').length, 0);
});

async function questionFixture(t) {
  const f = sandbox(t), workflow = { version: 1, start: 'decision', nodes: { decision: { kind: 'question', role: 'operator', question: 'Accept the fictional observed outcome?', answers: { accept: 'done', stop: 'stopped' } }, done: { kind: 'end', outcome: 'completed' }, stopped: { kind: 'end', outcome: 'stopped' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.start(); await f.engine.tick();
  const item = f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open'); assert.ok(item); return { ...f, item };
}
test('actual question answer closes its measured wait and dashboard counts only the observed interval', async t => {
  const f = await questionFixture(t); let measured = metrics(f.store); assert.equal(measured.wait.open, 1); assert.equal(measured.wait.count, 0); assert.equal(measured.waitByKind.question.open, 1);
  await delay(15);
  const receipt = f.command('answer', { inboxId: f.item.id, version: f.item.version, subjectDigest: f.item.subjectDigest, answer: 'accept' }); assert.equal(receipt.status, 'completed');
  const span = f.store.need('wait', `question:${f.item.id}`); assert.equal(span.reason, 'answered'); assert.ok(span.endedAt); const observed = Date.parse(span.endedAt) - Date.parse(span.startedAt); assert(observed > 0);
  measured = metrics(f.store); assert.equal(measured.wait.open, 0); assert.equal(measured.wait.count, 1); assert.equal(measured.wait.totalMs, observed); assert.equal(measured.waitByKind.question.totalMs, observed);
});
test('actual stop and expiry close question waits without granting consent or duplicating spans', async t => {
  const stopped = await questionFixture(t); const result = stopped.command('stop', { flowId: 'flow-1', note: 'Hold the fictional decision' }); assert.equal(result.status, 'completed');
  const first = stopped.store.need('wait', `question:${stopped.item.id}`); assert.equal(first.reason, 'stopped'); assert.equal(stopped.store.need('inbox', stopped.item.id).status, 'superseded');
  stopped.command('stop', { flowId: 'flow-1', note: 'Keep the existing stop' }); assert.equal(stopped.store.need('wait', first.id).endedAt, first.endedAt); assert.equal(metrics(stopped.store).wait.count, 1);
  const expired = await questionFixture(t); expired.store.put('inbox', { ...expired.item, expiresAt: new Date(Date.now() - 1).toISOString() }); await expired.engine.tick();
  assert.equal(expired.store.need('flow', 'flow-1').state, 'stopped'); assert.equal(expired.store.need('inbox', expired.item.id).status, 'expired'); const span = expired.store.need('wait', `question:${expired.item.id}`); assert.equal(span.reason, 'expired'); assert.ok(span.endedAt); assert.equal(metrics(expired.store).wait.open, 0); assert.equal(metrics(expired.store).wait.count, 1);
});

async function verifierBoundaryFixture(t, code) {
  const f = sandbox(t), identity = repositoryIdentity(f.root), config = { version: 1, mode: 'delivery', policy: { autoQueue: false }, context: { files: [], maxChars: 1000 } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('mainHealth', { status: 'green', head: identity.head, checkedAt: new Date().toISOString() }); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  const job = f.command('job.enqueue', { operation: 'main.verify', note: 'Test the actual verifier dispatch boundary with a controlled crashing worker' }).result;
  await operationalTick(f.store); const flow = f.store.need('flow', f.store.need('job', job.id).flowId); await f.engine.tick();
  const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId);
  assert.equal(attempt.intent.action.operation, 'main.verify'); assert.equal(f.store.meta('mainHealth').status, 'green', 'preparation alone does not claim a new baseline result');
  // Substitute only the external verifier worker; retain the actual action identity and real supervisor lifecycle.
  attempt.intent.argv = [process.execPath, '-e', code, join(f.stateDir, 'attempts', attempt.id, 'action-result.json')]; attempt.intentDigest = digest(attempt.intent); f.store.put('attempt', attempt);
  atomicJSON(join(f.stateDir, 'attempts', attempt.id, 'intent.json'), { ...attempt.intent, intentDigest: attempt.intentDigest });
  await f.engine.tick(); assert.equal(f.store.meta('mainHealth').status, 'unknown'); assert.equal(f.store.meta('mainHealth').attemptId, attempt.id);
  return { ...f, flow, attempt };
}
test('main verification invalidates previous green at real dispatch and a crashing worker cannot restore it', async t => {
  const f = await verifierBoundaryFixture(t, "require('node:fs').writeFileSync(process.argv[1],JSON.stringify({error:'Controlled verifier failure'}));process.exit(19)");
  await until(() => ['failed', 'uncertain'].includes(f.store.need('attempt', f.attempt.id).status), { tick: () => f.engine.tick() });
  assert.notEqual(f.store.need('attempt', f.attempt.id).status, 'passed'); assert.equal(f.store.meta('mainHealth').status, 'unknown');
});
test('missing verifier receipt after actual supervisor death retains unknown health and holds normal admission', async t => {
  const f = await verifierBoundaryFixture(t, 'setInterval(()=>{},1000)');
  const ownerPath = join(f.stateDir, 'attempts', f.attempt.id, 'owner.json');
  const owner = await until(() => existsSync(ownerPath) && JSON.parse(readFileSync(ownerPath, 'utf8')));
  const childPid = await until(() => { try { const child = Number(readFileSync(`/proc/${owner.pid}/task/${owner.pid}/children`, 'utf8').trim().split(/\s+/)[0]); return child > 0 && child; } catch { return false; } });
  t.after(() => { try { process.kill(-childPid, 'SIGKILL'); } catch {} });
  process.kill(owner.pid, 'SIGKILL'); try { process.kill(-childPid, 'SIGKILL'); } catch {}
  await until(() => f.store.need('attempt', f.attempt.id).status === 'uncertain', { tick: () => f.engine.tick() });
  assert.equal(f.store.meta('mainHealth').status, 'unknown'); assert.equal(f.store.need('attempt', f.attempt.id).settledAt, undefined);
  const next = f.command('task.put', { task: { id: 'held-after-verifier-loss', title: 'Fictional next task', acceptance: ['Fictional acceptance'] } }).result;
  f.command('task.approve', { taskId: next.id, revision: next.revision }); const receipt = f.command('flow.start', { taskId: next.id, revision: next.revision });
  assert.equal(receipt.status, 'rejected'); assert.match(receipt.error, /main health/); assert.equal(f.store.all('flow').filter(flow => flow.taskId === next.id).length, 0);
});

test('a merge into main queues the configured sync into next; a merge into next verifies next', async t => {
  const main = await mergedFixture(t, { syncTargets: [{ from: 'main', into: 'next' }] });
  const sync = main.store.get('job', 'target-sync:flow-1:next');
  assert.deepEqual(sync.payload, { from: 'main', into: 'next' }); assert.equal(sync.grant.policy, 'syncTargets');
  assert.deepEqual(main.store.get('job', 'post-merge-main:flow-1').payload, {}, 'main is the default target');
  const next = await mergedFixture(t, { syncTargets: [{ from: 'main', into: 'next' }], target: 'next' });
  assert.equal(next.store.get('job', 'target-sync:flow-1:next'), undefined, 'nothing to sync from next');
  assert.deepEqual(next.store.get('job', 'post-merge-main:flow-1').payload, { target: 'next' });
  assert.equal(next.store.meta('targetHealth').next.status, 'unknown'); assert.equal(next.store.meta('mainHealth').status, 'green', 'main untouched');
});
