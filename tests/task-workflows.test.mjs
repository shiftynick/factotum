import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, until } from './helpers.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { compileCatalog, selectWorkflow } from '../starter/factory/core/catalog.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 },
  workflows: { definitions: { change: { reference: 'change.standard' }, 'orchestrator-task': { reference: 'task.orchestrator' }, 'operator-task': { reference: 'task.operator' } }, selection: { default: 'change', rules: [{ label: 'orchestrator', workflow: 'orchestrator-task' }, { label: 'operator', workflow: 'operator-task' }] } } };

function setup(t) {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: base, note: 'Add task workflows' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  return f;
}
const open = f => f.store.all('inbox').find(row => row.flowId === 'deploy-flow' && row.status === 'open');

test('selection: brief workflow field, then the first matching label or category rule, then the default', () => {
  const catalog = compileCatalog(base, process.cwd());
  assert.equal(catalog.workflows['orchestrator-task'].kind, 'task');
  assert.equal(selectWorkflow(catalog, { labels: ['operator', 'orchestrator'] }).name, 'orchestrator-task', 'first rule wins');
  assert.equal(selectWorkflow(catalog, { labels: ['operator'] }).name, 'operator-task');
  assert.equal(selectWorkflow(catalog, { labels: ['operator'], workflow: 'change' }).name, 'change', 'brief field wins');
  assert.equal(selectWorkflow(catalog, {}).name, 'change');
  assert.throws(() => compileCatalog({ ...base, workflows: { definitions: { bad: { reference: 'task.operator', kind: 'change' } }, selection: { default: 'bad' } } }, process.cwd()), /contradicts/);
});

test('an orchestrator task is carried out, returned to the operator when blocked, and completed without a merge', async t => {
  const f = setup(t);
  const put = f.command('task.put', { task: { id: 'deploy', title: 'Deploy the site', acceptance: ['The site serves the new build'], labels: ['orchestrator'] } }).result;
  assert.equal(f.command('task.approve', { taskId: put.id, revision: put.revision }).status, 'completed');
  const reasons = admissionReasons(f.store, f.store.need('task', 'deploy'));
  assert.deepEqual(reasons, [], 'no main health, paths or build capacity needed');
  const start = f.command('flow.start', { taskId: 'deploy', revision: put.revision, flowId: 'deploy-flow' });
  assert.equal(start.status, 'completed', start.error); assert.equal(f.store.need('flow', 'deploy-flow').kind, 'task');
  await f.engine.step('deploy-flow');
  let item = open(f);
  assert.equal(item.role, 'orchestrator'); assert.equal(item.remind, 'never'); assert.match(item.context, /Deploy the site\nDone when: The site serves the new build/);
  const answer = (row, value, actor, extra = {}) => f.command('answer', { inboxId: row.id, version: row.version, subjectDigest: row.subjectDigest, answer: value, ...extra }, { actor });
  assert.equal(answer(item, 'blocked', 'orchestrator', { note: 'Needs the hosting token' }).status, 'completed');
  await f.engine.step('deploy-flow'); item = open(f);
  assert.equal(item.role, 'operator'); assert.match(item.context, /Note from orchestrator \(blocked\): Needs the hosting token/);
  assert.equal(answer(item, 'retry', 'operator').status, 'completed');
  await f.engine.step('deploy-flow'); item = open(f);
  assert.equal(answer(item, 'done', 'orchestrator').status, 'completed');
  await until(() => f.store.need('flow', 'deploy-flow').state === 'completed', { tick: () => f.engine.tick()});
  assert.equal(f.store.need('task', 'deploy').status, 'completed');
});

test('task flows use their own capacity and never take a build slot', async t => {
  const f = setup(t);
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { maxFlows: 1, maxTaskFlows: 1 } });
  f.store.put('flow', { id: 'busy-task', kind: 'task', state: 'waiting', taskId: 'other' });
  const put = f.command('task.put', { task: { id: 'call', title: 'Set up the newsletter account', acceptance: ['Account exists'], labels: ['operator'] } }).result;
  f.command('task.approve', { taskId: 'call', revision: put.revision });
  assert.ok(admissionReasons(f.store, f.store.need('task', 'call')).includes('task flow capacity exhausted'));
  const change = f.command('task.put', { task: { id: 'build', title: 'Build a thing', acceptance: ['It works'] } }).result;
  f.command('task.approve', { taskId: 'build', revision: change.revision });
  assert.ok(!admissionReasons(f.store, f.store.need('task', 'build')).includes('flow capacity exhausted'), 'the task flow does not use build capacity');
});

test('a task flow parked on its question carries over a configuration change and keeps its question', async t => {
  const f = setup(t);
  const { drainReasons } = await import('../starter/factory/operations/upgrade-apply.mjs');
  const put = f.command('task.put', { task: { id: 'deploy', title: 'Deploy on Monday', acceptance: ['Deployed'], labels: ['orchestrator'] } }).result;
  f.command('task.approve', { taskId: 'deploy', revision: put.revision });
  f.command('flow.start', { taskId: 'deploy', revision: put.revision, flowId: 'deploy-flow' });
  await f.engine.step('deploy-flow'); const first = open(f);
  assert.deepEqual(drainReasons(f.store), [], 'a parked task flow does not block an upgrade');
  // Recommissioning twice leaves the same question open: no new question, so no new wake.
  for (const note of ['Recommission after upgrade', 'Recommission again']) assert.equal(f.command('config.update', { config: base, note }, { actor: 'operator' }).status, 'completed');
  assert.equal(f.store.need('inbox', first.id).status, 'open'); assert.equal(f.store.need('flow', 'deploy-flow').state, 'waiting');
  assert.equal(f.store.need('flow', 'deploy-flow').executorDigest !== undefined, true);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  await f.engine.step('deploy-flow'); assert.equal(open(f).id, first.id);
  assert.equal(f.command('answer', { inboxId: first.id, version: first.version, subjectDigest: first.subjectDigest, answer: 'done' }, { actor: 'orchestrator' }).status, 'completed');
});

test('a question reopened by the rebind does not wake the orchestrator that caused it, and nobody waits on it meanwhile', async t => {
  const f = setup(t);
  const { drainReasons } = await import('../starter/factory/operations/upgrade-apply.mjs');
  const { queueDelivery } = await import('../starter/factory/operations/notifications.mjs');
  const put = f.command('task.put', { task: { id: 'deploy', title: 'Deploy on Monday', acceptance: ['Deployed'], labels: ['orchestrator'] } }).result;
  f.command('task.approve', { taskId: 'deploy', revision: put.revision });
  f.command('flow.start', { taskId: 'deploy', revision: put.revision, flowId: 'deploy-flow' });
  await f.engine.step('deploy-flow'); const first = open(f);
  // Simulate a subject change (for example a recompiled task workflow): the question must be reopened.
  f.store.put('inbox', { ...first, subjectDigest: 'stale' });
  const { executeCommand } = await import('../starter/factory/core/project.mjs');
  const delegated = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: 'recommission-1', actor: 'orchestrator', operation: 'config.update', payload: { config: base, note: 'Recommission' }, onBehalfOf: { principal: 'operator', instruction: 'Operator: adopt the release', reference: 't3-thread://v1/example' } });
  assert.equal(delegated.status, 'completed', delegated.error);
  assert.equal(f.store.need('inbox', first.id).status, 'superseded');
  assert.equal(f.store.need('flow', 'deploy-flow').state, 'ready'); assert.deepEqual(drainReasons(f.store), [], 'no race after the rebind');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  await f.engine.step('deploy-flow'); const reopened = open(f);
  assert.ok(reopened && reopened.id !== first.id); assert.equal(reopened.causedBy, 'orchestrator');
  assert.equal(queueDelivery(f.store, { inboxId: reopened.id, channel: 'orchestrator' }).status, 'suppressed', 'no wake under essential');
  assert.equal(f.store.need('flow', 'deploy-flow').reopenCausedBy, undefined);
});

test('a carried-over task flow whose step changed meaning stops with a reason', async t => {
  const f = setup(t);
  const put = f.command('task.put', { task: { id: 'deploy', title: 'Deploy on Monday', acceptance: ['Deployed'], labels: ['orchestrator'] } }).result;
  f.command('task.approve', { taskId: 'deploy', revision: put.revision });
  f.command('flow.start', { taskId: 'deploy', revision: put.revision, flowId: 'deploy-flow' });
  await f.engine.step('deploy-flow');
  const changed = { ...base, workflows: { ...base.workflows, definitions: { ...base.workflows.definitions, 'orchestrator-task': { reference: 'task.operator' } } } };
  assert.equal(f.command('config.update', { config: changed, note: 'Changed the task workflow' }).status, 'completed');
  assert.equal(f.store.need('flow', 'deploy-flow').state, 'stopped'); assert.match(f.store.need('flow', 'deploy-flow').stopReason, /changed this task workflow/);
});
