import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../starter/factory/core/store.mjs';
import { observeQueue, recordQueueAdmission } from '../starter/factory/operations/queue-diagnostics.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { queueDelivery, deliverDue } from '../starter/factory/operations/notifications.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'factotum-queue-diagnostics-'));
  const store = new Store(join(root, 'private'), { create: true });
  store.setMeta('project', { projectId: 'fictional' });
  store.setMeta('config', { mode: 'delivery', policy: { autoQueue: true, maxFlows: 2 } });
  store.setMeta('commissioning', { ready: true });
  store.put('task', { id: 'task', revision: 'v1' });
  store.put('queue', { id: 'task', status: 'queued', queuedAt: '2026-01-01T00:00:00Z' });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { store, root };
}
const start = Date.parse('2026-01-01T00:00:00Z');
test('eligibility records transitions only, survives reopening, and resets ready interval when blocked', t => {
  const { store } = fixture(t);
  let reasons = ['main unavailable'];
  const tick = nowMs => observeQueue(store, { reasonsForTask: () => reasons, nowMs });
  tick(start); tick(start + 1000);
  assert.equal(store.events().filter(e => e.type === 'queue.eligibility-changed').length, 1);
  reasons = []; tick(start + 2000); tick(start + 3000);
  let eligibility = store.get('queue', 'task').eligibility;
  assert.equal(eligibility.firstReadyAt, new Date(start + 2000).toISOString());
  assert.equal(eligibility.readySince, eligibility.firstReadyAt);
  const reopened = new Store(store.stateDir); assert.deepEqual(reopened.get('queue', 'task').eligibility, eligibility); reopened.close();
  reasons = ['dependency incomplete']; tick(start + 4000);
  reasons = []; tick(start + 5000);
  eligibility = store.get('queue', 'task').eligibility;
  assert.equal(eligibility.firstReadyAt, new Date(start + 2000).toISOString());
  assert.equal(eligibility.readySince, new Date(start + 5000).toISOString());
  store.tx(() => recordQueueAdmission(store, store.need('queue', 'task'), { id: 'flow' }, { nowMs: start + 7000 }));
  const timing = store.get('queue', 'task').admissionTiming;
  assert.equal(timing.readyToAdmissionMs, 2000); assert.equal(timing.firstReadyToAdmissionMs, 5000);
  assert.equal(timing.basis, 'observed-eligibility');
  const eventCount = store.events().length;
  recordQueueAdmission(store, { id: 'task', status: 'queued' }, { id: 'flow' }, { nowMs: start + 8000 });
  assert.deepEqual(store.get('queue', 'task').admissionTiming, timing);
  assert.equal(store.events().length, eventCount);
});
test('task revisions start new observations and failed admission rolls back diagnostic evidence', t => {
  const { store } = fixture(t);
  observeQueue(store, { reasonsForTask: () => [], nowMs: start });
  store.put('task', { id: 'task', revision: 'v2' });
  observeQueue(store, { reasonsForTask: () => [], nowMs: start + 2000 });
  assert.equal(store.get('queue', 'task').eligibility.firstReadyAt, new Date(start + 2000).toISOString());
  const before = store.get('queue', 'task'), count = store.events().length;
  assert.throws(() => store.tx(() => { recordQueueAdmission(store, before, { id: 'aborted' }, { nowMs: start + 3000 }); throw Error('rollback'); }), /rollback/);
  assert.deepEqual(store.get('queue', 'task'), before); assert.equal(store.events().length, count);
});
test('idle notices are delayed, versioned on repeat, resolve on holds or capacity use, and exclude planning slots', t => {
  const { store } = fixture(t);
  const tick = nowMs => observeQueue(store, { reasonsForTask: () => ['dependency incomplete'], nowMs, idleAfterMs: 100, repeatMs: 300 });
  tick(start); tick(start + 99); assert.equal(store.all('inbox').length, 0);
  store.put('flow', { id: 'plan', kind: 'planning', state: 'ready' });
  store.put('flow', { id: 'active', kind: 'change', state: 'stopped' });
  tick(start + 100); let item = store.get('inbox', 'queue:idle-capacity');
  assert.equal(item.version, 1); assert.equal(item.freeSlots, 1); assert.equal(item.blockers[0].reasons[0], 'dependency incomplete');
  tick(start + 399); assert.equal(store.get('inbox', item.id).version, 1);
  tick(start + 400); assert.equal(store.get('inbox', item.id).version, 2);
  store.setMeta('paused', true); tick(start + 401);
  assert.equal(store.get('inbox', item.id).status, 'resolved'); assert.equal(store.meta('queueIdle'), null);
  store.setMeta('paused', false); tick(start + 500); tick(start + 600);
  assert.equal(store.get('inbox', item.id).status, 'open');
  store.put('flow', { id: 'second', state: 'ready' }); tick(start + 601);
  assert.equal(store.get('inbox', item.id).status, 'resolved');
});
test('manual queues never produce idle-capacity notices and delivery respects a notice reminder interval', async t => {
  const { store, root } = fixture(t);
  store.setMeta('config', { mode: 'delivery', policy: { autoQueue: false } });
  for (const nowMs of [start, start + 1000]) observeQueue(store, { reasonsForTask: () => [], nowMs, idleAfterMs: 100 });
  assert.equal(store.all('inbox').length, 0);
  store.put('inbox', { id: 'notice', status: 'open', version: 1, notificationReminderMs: 10800000 });
  const delivery = queueDelivery(store, { inboxId: 'notice', nowMs: start });
  const configPath = join(root, 'notification.json'); writeFileSync(configPath, JSON.stringify({ url: 'https://fictional.invalid/hook' }), { mode: 0o600 });
  await deliverDue(store, { configPath, nowMs: start, transport: async () => ({ status: 204 }) });
  assert.equal(Date.parse(store.get('delivery', delivery.id).nextAt), start + 10800000);
});

test('delivery maintenance records canonical blockers and resolves stale notices while paused', async t => {
  const { store } = fixture(t);
  await operationalTick(store);
  assert.match(store.get('queue', 'task').eligibility.reasons.join('; '), /current approval/);
  store.setMeta('queueIdle', { since: new Date(Date.now() - 1800001).toISOString(), lastNoticeAt: null });
  await operationalTick(store);
  assert.equal(store.get('inbox', 'queue:idle-capacity').status, 'open');
  store.setMeta('paused', true); await operationalTick(store);
  assert.equal(store.get('inbox', 'queue:idle-capacity').status, 'resolved');
  assert.match(store.get('queue', 'task').eligibility.reasons.join('; '), /project held/);
});
