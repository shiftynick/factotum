import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { releaseProject, addHistory, instrument } from './history-fixtures.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { requestProject } from '../starter/factory/console/client.mjs';

// What an idle project reads, counted (statements, rows and bytes handed to JavaScript, and
// whether any statement reads every record of a kind), never timed. The state is written the
// way the earlier release wrote it; starting the service is all that brings it up to date.
async function idleReads(t, history) {
  const f = releaseProject(t, { autoQueue: true }), { attemptBytes } = addHistory(f.stateDir, history);
  const service = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'p.sock'), run: false });
  t.after(() => service.close());
  const store = service.store, engine = new Engine(store);
  // One round first: the first operations tick after a start does its one-time work.
  await engine.tick(); await operationalTick(store); dashboardSnapshot(store);
  const probe = instrument(store);
  await engine.tick(); await operationalTick(store); const tick = probe.take();
  const snapshot = dashboardSnapshot(store); queueStatus(store); const poll = probe.take();
  return { f, service, store, tick, poll, snapshot, attemptBytes, probe };
}
// Both fill the poll's fixed windows (the latest 100 tasks, 20 flows, attempts and inbox items).
const SMALL = { changes: 110, maintenance: 30, samples: 100, intentBytes: 2000 };
const LARGE = { changes: 220, maintenance: 300, samples: 2000, intentBytes: 70000 };
// Kinds a tick or a poll may still read whole: bounded by configuration, not by history.
const CONFIGURED = ['schedule'];

test('an idle service tick and console poll read a bounded amount, whatever the settled history', async t => {
  const small = await idleReads(t, SMALL), large = await idleReads(t, LARGE);
  assert.ok(large.attemptBytes > 60e6 && large.attemptBytes > 30 * small.attemptBytes, `the histories hold ${small.attemptBytes} and ${large.attemptBytes} bytes of attempts`);
  for (const [name, run] of [['small', small], ['large', large]]) {
    assert.deepEqual(run.tick.wholeKinds.filter(kind => !CONFIGURED.includes(kind)), [], `${name}: an idle tick reads every record of ${run.tick.wholeKinds}`);
    assert.deepEqual(run.poll.wholeKinds.filter(kind => !CONFIGURED.includes(kind)), [], `${name}: an idle console poll reads every record of ${run.poll.wholeKinds}`);
    assert.deepEqual([...run.tick.eventScans, ...run.poll.eventScans], [], `${name}: no unbounded read of the event log`);
    assert.ok(run.tick.bytes < 64 * 1024, `${name}: an idle engine and operations tick was handed ${run.tick.bytes} bytes`);
    assert.ok(run.poll.bytes < 512 * 1024, `${name}: an idle console poll was handed ${run.poll.bytes} bytes`);
  }
  // More than thirty times the attempt bytes and ten times the maintenance runs: the same statements and the same number of rows.
  assert.equal(large.tick.statements, small.tick.statements); assert.equal(large.tick.rows, small.tick.rows);
  assert.equal(large.poll.statements, small.poll.statements); assert.equal(large.poll.rows, small.poll.rows);
  assert.ok(Math.abs(large.poll.bytes - small.poll.bytes) < 16 * 1024, `poll bytes ${small.poll.bytes} against ${large.poll.bytes}`);
  t.diagnostic(`attempt history ${small.attemptBytes} and ${large.attemptBytes} bytes; idle tick ${JSON.stringify({ statements: large.tick.statements, rows: large.tick.rows, bytes: large.tick.bytes })}; idle poll ${JSON.stringify({ statements: large.poll.statements, rows: large.poll.rows, bytes: large.poll.bytes })}`);
  // The poll still shows what it showed: totals over all history and the recent records.
  assert.equal(large.snapshot.taskCount, LARGE.changes); assert.equal(large.snapshot.maintenanceTaskCount, LARGE.maintenance);
  assert.equal(large.snapshot.stats.flows.total, LARGE.changes + LARGE.maintenance);
  assert.equal(large.snapshot.tasks.length, 100); assert.equal(large.snapshot.flows.length, 20); assert.equal(large.snapshot.attempts.length, 20); assert.equal(large.snapshot.inbox.length, 20);
  assert.deepEqual(large.snapshot.budget, { unit: 'USD_MICRO', actual: 0, reserved: 0 });
});

test('current work is read in full while history stays out of the tick and the poll', async t => {
  const run = await idleReads(t, SMALL), { store, probe } = run, projectId = store.meta('project').projectId;
  const command = (operation, payload) => requestProject(run.service.socketPath, { method: 'POST', path: '/v1/commands', body: { protocolVersion: 1, projectId, commandId: `${operation}-${Math.random()}`, actor: 'operator', operation, payload } });
  // A queued task, held by a pause so that no tick admits it, and a standalone open question.
  assert.equal((await command('pause', { paused: true, note: 'Hold admission for the fixture' })).status, 'completed');
  const put = await command('task.put', { task: { id: 'live-task', title: 'Fictional live task', acceptance: ['Observed'], paths: ['src/live.js'] } }); assert.equal(put.status, 'completed', put.error);
  const approved = await command('task.approve', { taskId: 'live-task', revision: put.result.revision, queue: true }); assert.equal(approved.status, 'completed', approved.error);
  store.put('inbox', { id: 'live-question', kind: 'question', standalone: true, status: 'open', version: 1, role: 'operator', question: 'A fictional question?', answers: ['yes', 'no'], createdBy: 'orchestrator', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const settled = store.all('attempt')[0];
  store.put('attempt', { ...settled, id: 'live-attempt', status: 'dispatching', settledAt: undefined, receipt: undefined, reservedMicros: 700, costMicros: undefined, launchStalled: { since: new Date().toISOString(), supervisorPid: 4242 } });
  store.put('attempt', { ...settled, id: 'costly-attempt', costMicros: 1234 });
  await operationalTick(store); await operationalTick(store); probe.take();
  await new Engine(store).tick(); await operationalTick(store); const tick = probe.take();
  const snapshot = dashboardSnapshot(store); const poll = probe.take();
  assert.deepEqual([...tick.wholeKinds, ...poll.wholeKinds].filter(kind => !CONFIGURED.includes(kind)), []);
  assert.ok(tick.bytes < 64 * 1024 && poll.bytes < 512 * 1024, `tick ${tick.bytes} bytes, poll ${poll.bytes} bytes`);
  assert.deepEqual(snapshot.queueTasks.map(task => task.id), ['live-task']); assert.deepEqual(snapshot.queueDispatchOrder, ['live-task']);
  assert.ok(snapshot.inbox.some(item => item.id === 'live-question' && item.status === 'open'));
  assert.ok(snapshot.attempts.some(attempt => attempt.id === 'live-attempt' && attempt.status === 'dispatching'));
  assert.ok(snapshot.queueStatus.holds.some(hold => hold.kind === 'launch-stalled' && hold.attemptId === 'live-attempt'));
  assert.deepEqual(snapshot.budget, { unit: 'USD_MICRO', actual: 1234, reserved: 700 });
  // The open question got its operator delivery exactly once; a quiet tick queues nothing more.
  const deliveries = () => store.all('delivery').filter(row => row.inboxId === 'live-question').length;
  assert.equal(deliveries(), 1); await operationalTick(store); assert.equal(deliveries(), 1);
});

test('flow detail, timeline and statistics over a large history read no dispatch intent', async t => {
  const run = await idleReads(t, LARGE), { store, probe } = run, socket = run.service.socketPath;
  const flowId = store.all('flow').findLast(flow => flow.kind === 'change').id; probe.take();
  const detail = await requestProject(socket, { path: `/v1/flows/${flowId}` }), detailReads = probe.take();
  assert.equal(detail.attempts.length, 4); assert.ok(detail.attempts.every(attempt => !('intent' in attempt) && attempt.receipt?.endedAt));
  assert.equal(detail.inbox.length, 1); assert.equal(detail.waits.length, 1); assert.equal(detail.contexts.length, 1);
  assert.deepEqual(detailReads.wholeKinds, [], 'flow detail looks its records up by flow');
  assert.ok(detailReads.bytes < 256 * 1024, `flow detail was handed ${detailReads.bytes} bytes`);
  const timeline = await requestProject(socket, { path: '/v1/timeline/72' }), timelineReads = probe.take();
  assert.ok(timeline.pools.length >= 1); assert.deepEqual(timelineReads.wholeKinds, []);
  assert.ok(timelineReads.bytes < 4 * 1024 * 1024, `the timeline was handed ${timelineReads.bytes} bytes`);
  const stats = await requestProject(socket, { path: '/v1/stats/12w' }), statsReads = probe.take();
  assert.ok(stats.periods?.length || stats.buckets?.length || Object.keys(stats).length > 3);
  // Statistics cover all history by design, but through the attempts as stored: far less than their intents.
  assert.ok(statsReads.bytes < run.attemptBytes / 8, `statistics were handed ${statsReads.bytes} of ${run.attemptBytes} attempt bytes`);
  const page = await requestProject(socket, { path: '/v1/collections/attempt?limit=100&order=desc' }), pageReads = probe.take();
  assert.equal(page.items.length, 100); assert.ok(page.items.every(attempt => !('intent' in attempt)));
  assert.ok(pageReads.bytes < 1024 * 1024, `an attempt page was handed ${pageReads.bytes} bytes`);
});
