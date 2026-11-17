import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';
import { collection } from '../starter/factory/service/project-service.mjs';

function fixture(t) {
  const f = sandbox(t);
  f.store.put('schedule', { id: 'issue-source', operation: 'source.sync', type: 'interval', everyMs: 900000, enabled: true });
  for (const n of [1, 2, 3]) {
    f.store.put('task', { id: `job:sync-${n}`, title: 'Maintenance: source.sync', acceptance: ['Run'], revision: `r${n}`, approvalKind: 'schedule', scheduleId: 'issue-source' });
    f.store.put('job', { id: `sync-${n}`, operation: 'source.sync', scheduleId: 'issue-source', status: n === 3 ? 'failed' : 'completed', createdAt: `2026-10-23T0${n}:00:00.000Z`, finishedAt: `2026-10-23T0${n}:01:00.000Z` });
  }
  return f;
}

test('Tasks and its count leave out scheduled maintenance runs', t => {
  const f = fixture(t), s = snapshot(f.store);
  assert.deepEqual(s.tasks.map(task => task.id), ['task-1']); assert.equal(s.taskCount, 1); assert.equal(s.maintenanceTaskCount, 3);
  const page = collection(f.store, 'task', new URLSearchParams());
  assert.equal(page.total, 1); assert.deepEqual(page.items.map(task => task.id), ['task-1']);
  assert.equal(collection(f.store, 'task', new URLSearchParams({ include: 'maintenance' })).total, 4);
});

test('each schedule reports its run count and latest outcome', t => {
  const schedule = snapshot(fixture(t).store).schedules.find(row => row.id === 'issue-source');
  assert.equal(schedule.runs, 3);
  assert.deepEqual(schedule.lastRun, { jobId: 'sync-3', flowId: null, status: 'failed', startedAt: '2026-10-23T03:00:00.000Z', finishedAt: '2026-10-23T03:01:00.000Z' });
});

test('the snapshot counts open project tasks that need approval', t => {
  const f = fixture(t);
  f.store.put('task', { id: 'blocked', title: 'Blocked', acceptance: ['x'], revision: 'b', approvedRevision: null, blocked: true });
  f.store.put('task', { id: 'approved', title: 'Approved', acceptance: ['x'], revision: 'a', approvedRevision: 'a' });
  assert.equal(snapshot(f.store).approvalNeededCount, 1, 'only task-1: maintenance runs, blocked and approved tasks are excluded');
});

test('a main health hold names the verification already in progress', async t => {
  const { mainHealthReason } = await import('../starter/factory/operations/main-health-reason.mjs');
  const f = fixture(t);
  f.store.put('job', { id: 'post-merge-main:flow-9', operation: 'main.verify', status: 'running' });
  assert.match(mainHealthReason(f.store), /main verification in progress \(job post-merge-main:flow-9\)/);
  f.store.put('job', { id: 'post-merge-main:flow-9', operation: 'main.verify', status: 'completed' });
  f.store.setMeta('mainHealth', { status: 'red' });
  assert.match(mainHealthReason(f.store), /main health is red/);
});

test('an uncommissioned project holds admission with a reason and queue.dispatch completes instead of faulting', async t => {
  const { admissionReasons } = await import('../starter/factory/operations/admission.mjs');
  const { operationalTick } = await import('../starter/factory/workflows/maintenance.mjs');
  const f = sandbox(t);
  f.store.setMeta('config', { ...f.store.meta('config', {}), mode: 'delivery', policy: {} }); f.store.setMeta('commissioning', null);
  f.command('task.approve', { taskId: f.task.id, revision: f.task.revision });
  f.store.put('queue', { id: f.task.id, status: 'queued', order: 0 });
  assert.ok(admissionReasons(f.store, f.store.need('task', f.task.id)).some(reason => /doctor qualification required/.test(reason)));
  assert.equal(snapshot(f.store).commissioningRequired, true);
  f.store.put('job', { id: 'nudge', operation: 'queue.dispatch', payload: {}, grant: { actor: 'operator', note: 'Nudge', configDigest: f.store.meta('configDigest') }, status: 'queued', createdAt: new Date().toISOString() });
  await operationalTick(f.store);
  const job = f.store.need('job', 'nudge');
  assert.equal(job.status, 'completed'); assert.equal(job.outcome, 'no-eligible-task');
  assert.ok(job.heldReasons.some(reason => /doctor qualification required/.test(reason)));
  assert.notEqual(f.store.meta('recoveryHold'), true);
});
