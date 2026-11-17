import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { projectTimeline, stepCategory } from '../starter/factory/operations/timeline-view.mjs';
import { parseMachineSample, recordHostSample } from '../starter/factory/operations/sampling.mjs';

const at = (base, minutes) => new Date(base + minutes * 60000).toISOString();

test('the project timeline places flows in slots with step segments, events and stats', t => {
  const f = sandbox(t), now = Date.now(), workflow = { nodes: { build: { action: { operation: 'provider.build' } }, gate: { action: { operation: 'gate' } }, ask: { kind: 'question' } } };
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { maxFlows: 2 } });
  f.store.put('flow', { id: 'a', taskId: 'task-1', taskSnapshot: { title: 'First', source: { issue: 12 } }, kind: 'change', state: 'completed', workflow, createdAt: at(now, -300), finishedAt: at(now, -200), results: { merge: { merged: true } } });
  f.store.put('flow', { id: 'b', taskId: 'task-1', taskSnapshot: { title: 'Second' }, kind: 'change', state: 'waiting', step: 'ask', workflow, createdAt: at(now, -150) });
  f.store.put('flow', { id: 'c', taskId: 'task-1', taskSnapshot: { title: 'Overlap' }, kind: 'change', state: 'failed', workflow, createdAt: at(now, -250), finishedAt: at(now, -100) });
  f.store.put('flow', { id: 'old', taskId: 'task-1', kind: 'change', state: 'completed', workflow, createdAt: at(now, -2000), finishedAt: at(now, -1900) });
  f.store.put('attempt', { id: 'x', flowId: 'a', step: 'build', status: 'passed', createdAt: at(now, -290), receipt: { startedAt: at(now, -290), endedAt: at(now, -250) }, settledAt: at(now, -250) });
  f.store.put('attempt', { id: 'y', flowId: 'a', step: 'gate', status: 'passed', createdAt: at(now, -249), receipt: { startedAt: at(now, -249), endedAt: at(now, -210) }, settledAt: at(now, -210) });
  f.store.put('inbox', { id: 'q', kind: 'question', role: 'orchestrator', flowId: 'b', status: 'open', question: 'Merge?', createdAt: at(now, -120) });
  f.store.put('wait', { id: 'w', flowId: 'b', inboxId: 'q', kind: 'question', startedAt: at(now, -120) });
  assert.equal(stepCategory({ workflow }, 'gate'), 'checks');

  const view = projectTimeline(f.store, { hours: 6, nowMs: now });
  const change = view.pools.find(p => p.kind === 'change');
  assert.equal(change.lanes.length, 2);
  assert.deepEqual(change.lanes.map(l => l.flows.map(x => x.id)), [['a', 'b'], ['c']], 'b reuses the slot a freed');
  assert.deepEqual(change.lanes[0].flows[0].segments.map(s => s.category), ['building', 'checks']);
  assert.equal(change.lanes[0].flows[1].segments[0].category, 'waiting-orchestrator');
  assert.equal(change.lanes[0].current.flowId, 'b');
  assert.equal(change.lanes[1].current, null);
  assert.deepEqual(view.events.map(e => e.type), ['merged', 'question-orchestrator', 'failed']);
  assert.equal(view.events[0].ref, 12);
  assert.equal(view.stats.merged, 1);
  assert.equal(view.stats.slotMs, 2 * 6 * 3600000);
  assert.equal(view.stats.idleSlotMs, view.stats.slotMs - (100 + 150 + 150) * 60000);
  assert.throws(() => projectTimeline(f.store, { hours: 5 }), /must be one of/);
});

test('host samples carry CPU and swap, are taken at most every two minutes and turn into chart points', t => {
  const f = sandbox(t), now = Date.now();
  const files = ticks => ({ loadavg: '1 1 1 1/1 1', meminfo: 'MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 500 kB\nSwapFree: 400 kB\n', uptime: '10 10', stat: `cpu  ${ticks.join(' ')} 0 0 0\ncpu0 1 1 1 1\n` });
  const sample = parseMachineSample(files([100, 0, 100, 700, 100]));
  assert.deepEqual(sample.cpuTicks, { total: 1000, idle: 700, iowait: 100 }); assert.deepEqual(sample.swapBytes, { total: 512000, free: 409600 });
  let next = [100, 0, 100, 700, 100];
  const take = nowMs => recordHostSample(f.store, { nowMs, sample: ({ observedAt }) => parseMachineSample(files(next), observedAt) });
  assert.ok(take(now - 300000)); assert.equal(take(now - 250000), null, 'too soon');
  next = [300, 0, 300, 1000, 400]; assert.ok(take(now - 100000));
  const machine = projectTimeline(f.store, { hours: 6, nowMs: now }).machine;
  assert.equal(machine.length, 2); assert.equal(machine[0].cpu, null, 'the first sample has no previous counters');
  assert.equal(machine[1].cpu, 0.4); assert.equal(machine[1].iowait, 0.3); assert.equal(machine[1].swapUsed, 102400);
});

test('abandoned flows end at their abandonment, and finished flows without an end are repaired', async t => {
  const f = sandbox(t), now = Date.now(), { backfillFinishedAt } = await import('../starter/factory/core/project.mjs');
  f.store.put('flow', { id: 'gone', taskId: 'task-1', kind: 'task', state: 'failed', workflow: { nodes: {} }, createdAt: at(now, -200), abandonedAt: at(now, -150) });
  f.store.put('flow', { id: 'bare', taskId: 'task-1', kind: 'maintenance', state: 'failed', workflow: { nodes: {} }, createdAt: at(now, -100) });
  const view = projectTimeline(f.store, { hours: 6, nowMs: now }), bars = view.pools.flatMap(p => p.lanes.flatMap(l => l.flows));
  assert.equal(bars.find(b => b.id === 'gone').end, at(now, -150)); assert.equal(bars.find(b => b.id === 'gone').open, false);
  assert.ok(Date.parse(bars.find(b => b.id === 'bare').end) < now - 60000, 'no bar runs to now for a finished flow');
  assert.equal(view.pools.find(p => p.kind === 'task').lanes[0].current, null);
  assert.match(view.events.find(e => e.flowId === 'gone').label, /^Abandoned/);
  f.store.tx(() => backfillFinishedAt(f.store));
  assert.equal(f.store.need('flow', 'gone').finishedAt, at(now, -150)); assert.equal(f.store.need('flow', 'bare').finishedAt, at(now, -100));
});

test('abandoning a flow records when it finished', t => {
  const f = sandbox(t);
  assert.equal(f.start().status, 'completed');
  f.command('stop', { flowId: 'flow-1', note: 'Stop it' });
  const result = f.command('flow.abandon', { flowId: 'flow-1', note: 'Abandon it' });
  assert.equal(result.status, 'completed', result.error);
  const flow = f.store.need('flow', 'flow-1'); assert.equal(flow.finishedAt, flow.abandonedAt);
});
