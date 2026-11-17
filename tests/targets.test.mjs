import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sandbox } from './helpers.mjs';
import { admissionReasons, claimCandidate } from '../starter/factory/operations/admission.mjs';
import { runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';
import { setTargetHealth, targetHealth } from '../starter/factory/operations/targets.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { admitFlow, authorized } from '../starter/factory/core/project.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', syncTargets: [{ from: 'main', into: 'next' }] }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 },
  workflows: { definitions: { change: { reference: 'change.standard' }, web: { reference: 'change.standard', target: 'next' } }, selection: { default: 'change', rules: [{ label: 'web', workflow: 'web' }] } } };
const green = () => ({ status: 'green', head: 'a'.repeat(40), checkedAt: new Date().toISOString() });

function admittedFixture(t, config = base) {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config, note: 'Commission branch workflows' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  for (const target of ['main', 'next']) setTargetHealth(f.store, target, green());
  const task = f.command('task.put', { task: { id: 'site', title: 'Fictional website', acceptance: ['Works'], labels: ['web'] } }).result;
  assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed');
  return { ...f, task: f.store.need('task', task.id) };
}

for (const admission of ['flow.start', 'queue', 'task.restart']) test(`${admission} pins the approved branch identity and prepares source on that branch`, async t => {
  const f = admittedFixture(t, { ...base, policy: { autoQueue: admission === 'queue' } });
  let flow;
  if (admission === 'queue') {
    assert.equal(f.command('queue.put', { taskIds: [f.task.id] }).status, 'completed');
    flow = claimCandidate(f.store, { admit: (task, store) => admitFlow(store, task, { revision: task.revision }) });
    assert.equal(f.store.need('queue', f.task.id).flowId, flow.id);
  } else if (admission === 'task.restart') {
    const old = f.command('flow.start', { taskId: f.task.id, revision: f.task.revision }).result;
    // Reproduce the retained pre-fix record without rewriting its historical evidence.
    f.store.put('flow', { ...old, workflowDigest: digest(old.workflow), state: 'stopped', stopRequested: true, stopReason: 'workflow changed; revalidation required' });
    const restarted = f.command('task.restart', { taskId: f.task.id, revision: f.task.revision, note: 'Retry after upstream fix' });
    assert.equal(restarted.status, 'completed', restarted.error);
    assert.ok(f.store.need('flow', old.id).abandonedAt);
    assert.equal(f.store.need('flow', old.id).workflowDigest, digest(old.workflow));
    flow = f.store.need('flow', restarted.result.flowId);
    assert.equal(f.store.need('flow', old.id).replacedBy, flow.id);
  } else {
    const started = f.command('flow.start', { taskId: f.task.id, revision: f.task.revision });
    assert.equal(started.status, 'completed', started.error); flow = started.result;
  }
  assert.equal(flow.workflowName, 'web'); assert.equal(flow.target, 'next');
  assert.equal(flow.workflowDigest, f.task.approvedWorkflow.digest);
  assert.notEqual(flow.workflowDigest, f.store.meta('catalog').workflows.change.digest);
  await f.engine.tick();
  const current = f.store.need('flow', flow.id);
  assert.equal(current.state, 'running', current.stopReason);
  const attempt = f.store.need('attempt', current.attemptId);
  assert.equal(attempt.status, 'prepared'); assert.equal(attempt.intent.action.operation, 'source.verify');
  assert.equal(attempt.intent.action.target, 'next');
});

test('branch and graph integrity are rechecked before dispatch of a prepared attempt', async t => {
  const f = admittedFixture(t), flow = f.command('flow.start', { taskId: f.task.id, revision: f.task.revision }).result;
  await f.engine.step(flow.id);
  const prepared = f.store.need('flow', flow.id);
  for (const changed of [{ ...prepared, target: 'main' }, { ...prepared, workflow: { ...prepared.workflow, maxTransitions: prepared.workflow.maxTransitions + 1 } }]) {
    f.store.put('flow', changed);
    await assert.rejects(f.engine.step(flow.id), /pinned workflow.*mismatch/);
    assert.equal(f.store.need('attempt', prepared.attemptId).status, 'prepared', 'no dispatch under changed identity');
  }
  f.store.put('flow', prepared);
  assert.doesNotThrow(() => authorized(f.store, prepared));
});

test('changing only the commissioned target invalidates previous approval', t => {
  const f = admittedFixture(t), oldDigest = f.task.approvedWorkflow.digest;
  const config = structuredClone(base); config.workflows.definitions.web.target = 'main';
  delete config.repository.syncTargets;
  assert.equal(f.command('config.update', { config, note: 'Retarget website' }).status, 'completed');
  assert.notEqual(f.store.meta('catalog').workflows.web.digest, oldDigest);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  const started = f.command('flow.start', { taskId: f.task.id, revision: f.task.revision });
  assert.equal(started.status, 'rejected'); assert.match(started.error, /approve.*again/);
});

test('default-target and pre-catalog flows keep their graph-only identity', async t => {
  for (const catalog of [true, false]) {
    const config = structuredClone(base);
    if (catalog) delete config.workflows.definitions.web.target;
    else { delete config.workflows; delete config.repository.syncTargets; }
    if (catalog) delete config.repository.syncTargets;
    const f = admittedFixture(t, config);
    if (!catalog) f.store.setMeta('catalog', null); // Legacy projects without a compiled catalog.
    const started = f.command('flow.start', { taskId: f.task.id, revision: f.task.revision });
    assert.equal(started.status, 'completed', started.error);
    const flow = started.result;
    assert.equal(flow.target, 'main'); assert.equal(flow.workflowDigest, digest(flow.workflow));
    await f.engine.step(flow.id);
    assert.equal(f.store.need('attempt', f.store.need('flow', flow.id).attemptId).intent.action.target, 'main');
  }
});

test('project-file workflows with explicit targets retain their approved graph and target', async t => {
  const f = sandbox(t), graph = { version: 1, start: 'ask', nodes: { ask: { kind: 'question', role: 'operator', question: 'Proceed?', answers: { stop: 'stopped' } }, stopped: { kind: 'end', outcome: 'stopped' } } };
  writeFileSync(join(f.root, 'workflow.json'), JSON.stringify(graph));
  const config = structuredClone(base); config.workflows.definitions.web = { path: 'workflow.json', target: 'next' };
  assert.equal(f.command('config.update', { config, note: 'Custom workflow' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'next', green());
  const task = f.command('task.put', { task: { id: 'custom', title: 'Custom task', labels: ['web'], acceptance: ['Inspected'] } }).result;
  f.command('task.approve', { taskId: task.id, revision: task.revision });
  const flow = f.command('flow.start', { taskId: task.id, revision: task.revision }).result;
  assert.equal(flow.workflowDigest, digest({ workflow: graph, target: 'next' }));
  await f.engine.step(flow.id);
  assert.equal(f.store.need('flow', flow.id).state, 'waiting');
});

test('a targeted task workflow carries its target binding across recommissioning', async t => {
  const config = structuredClone(base); config.workflows.definitions.web.reference = 'task.orchestrator';
  const f = admittedFixture(t, config), flow = f.command('flow.start', { taskId: f.task.id, revision: f.task.revision }).result;
  await f.engine.step(flow.id);
  assert.equal(f.store.need('flow', flow.id).state, 'waiting');
  // Carried task workflows have no workspace or branch effects and rebind under existing policy.
  config.workflows.definitions.web.target = 'main'; delete config.repository.syncTargets;
  assert.equal(f.command('config.update', { config, note: 'Recommission carried task' }).status, 'completed');
  await f.engine.step(flow.id);
  const rebound = f.store.need('flow', flow.id);
  assert.equal(rebound.target, 'main'); assert.equal(rebound.workflowDigest, f.store.meta('catalog').workflows.web.digest);
  assert.equal(rebound.state, 'waiting');
});

test('a workflow can target another branch; its work waits on that branch’s health', t => {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: base, note: 'Two branches' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', green());
  const put = id => { const r = f.command('task.put', { task: { id, title: id, acceptance: ['x'], labels: id === 'site' ? ['web'] : [] } }).result; f.command('task.approve', { taskId: id, revision: r.revision }); return f.store.need('task', id); };
  const site = put('site'), docs = put('docs');
  assert.deepEqual(admissionReasons(f.store, docs), [], 'main is green');
  assert.ok(admissionReasons(f.store, site).some(r => /^next health unknown: next has never been verified/.test(r)), admissionReasons(f.store, site).join('; '));
  setTargetHealth(f.store, 'next', green());
  assert.deepEqual(admissionReasons(f.store, site), []);
  assert.equal(targetHealth(f.store, 'main').status, 'green'); assert.equal(f.store.meta('targetHealth').next.target, 'next');
  assert.equal(f.command('flow.start', { taskId: 'site', revision: site.revision, flowId: 'site-flow' }).status, 'completed');
  assert.equal(f.store.need('flow', 'site-flow').target, 'next');
  f.store.setMeta('targetHealth', {});
  assert.ok(queueStatus(f.store).holds.some(h => h.target === 'next'), 'the queue banner names the branch');
  assert.equal(f.command('config.update', { config: { ...base, repository: { ...base.repository, syncTargets: [{ from: 'main', into: 'release' }] } }, note: 'x' }).status, 'rejected', 'sync only between target branches');
});

test('target.sync merges main into next and pushes; a conflict stops without pushing', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'fct-sync-')), remote = join(dir, 'remote.git'), root = join(dir, 'root');
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git(dir, 'init', '-q', '--bare', remote); git(dir, 'init', '-q', '-b', 'main', root);
  git(root, 'config', 'user.email', 'f@example.invalid'); git(root, 'config', 'user.name', 'F'); git(root, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(root, 'a.txt'), 'one\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'base'); git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', 'origin', 'main', 'main:next');
  writeFileSync(join(root, 'b.txt'), 'main work\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'main work'); git(root, 'push', '-q', 'origin', 'main');
  const action = (flowId) => ({ projectRoot: root, cwd: root, action: { operation: 'target.sync', config: base, stateDir: join(dir, 'state'), flowId, jobPayload: { from: 'main', into: 'next' } } });
  const synced = await runMaintenanceAction(action('one'));
  assert.equal(synced.route, 'pass'); assert.ok(synced.sync.head);
  assert.equal(synced.sync.fromHead, git(dir, '--git-dir', remote, 'rev-parse', 'main'));
  assert.equal(synced.sync.head, git(dir, '--git-dir', remote, 'rev-parse', 'next'));
  assert.equal(synced.sync.contained, true);
  assert.equal(git(dir, '--git-dir', remote, 'merge-base', '--is-ancestor', 'main', 'next') , '', 'next now contains main');
  const noOp = await runMaintenanceAction(action('two'));
  assert.equal(noOp.route, 'pass');
  assert.deepEqual(noOp.sync, { ...synced.sync, upToDate: true });
  // Conflicting edits on both branches.
  writeFileSync(join(root, 'a.txt'), 'main says\n'); git(root, 'commit', '-qam', 'main edit'); git(root, 'push', '-q', 'origin', 'main');
  git(root, 'fetch', '-q', 'origin'); git(root, 'checkout', '-q', '-b', 'n', 'origin/next'); writeFileSync(join(root, 'a.txt'), 'next says\n'); git(root, 'commit', '-qam', 'next edit'); git(root, 'push', '-q', 'origin', 'n:next'); git(root, 'checkout', '-q', 'main');
  const before = git(dir, '--git-dir', remote, 'rev-parse', 'next');
  const conflict = await runMaintenanceAction(action('three'));
  assert.equal(conflict.route, 'fail'); assert.deepEqual(conflict.sync.files, ['a.txt']); assert.match(conflict.reason, /Merge main into next by hand/);
  assert.equal(git(dir, '--git-dir', remote, 'rev-parse', 'next'), before, 'nothing pushed');
});

test('a merge made outside the factory queues the sync once', async t => {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: base, note: 'Two branches' }).status, 'completed');
  const { ensureTargetSync } = await import('../starter/factory/operations/main-freshness.mjs');
  let head = 'a'.repeat(40); const run = async () => ({ code: 0, stdout: `${head}\trefs/heads/main\n` });
  const now = Date.now();
  assert.equal((await ensureTargetSync(f.store, { nowMs: now, run })).length, 1);
  assert.deepEqual(await ensureTargetSync(f.store, { nowMs: now + 120000, run }), [], 'one pending at a time');
  f.store.put('job', { ...f.store.all('job').find(j => j.operation === 'target.sync'), status: 'completed' });
  assert.deepEqual(await ensureTargetSync(f.store, { nowMs: now + 240000, run }), [], 'main has not moved since');
  head = 'b'.repeat(40);
  assert.equal((await ensureTargetSync(f.store, { nowMs: now + 360000, run }))[0], `target-sync:outside:main:next:${'b'.repeat(12)}`);
});
