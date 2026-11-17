import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { autoQueue: true } };

test('the queue status names what holds the whole queue, and the last dispatch outcome', t => {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed');
  assert.deepEqual(queueStatus(f.store).holds.map(h => h.kind), ['doctor', 'main']);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', { status: 'green', head: 'a'.repeat(40), checkedAt: new Date().toISOString() });
  const { capacity, ...status } = queueStatus(f.store);
  assert.deepEqual(status, { autoQueue: true, holds: [], lastDispatch: null }, 'nothing to show');
  // Flow slots are always reported (operations/capacity.mjs): nothing running, nothing parked.
  assert.deepEqual(capacity.pools.change, { max: 1, inUse: 0, working: 0, stopped: 0, parked: 0, parkedHoldingSlot: 0, waitingForSlot: 0, free: 1 });
  assert.deepEqual({ maxParkedFlows: capacity.maxParkedFlows, parkedCount: capacity.parkedCount, waitingCount: capacity.waitingCount, parked: capacity.parked, waiting: capacity.waiting }, { maxParkedFlows: 3, parkedCount: 0, waitingCount: 0, parked: [], waiting: [] });
  f.store.setMeta('paused', true);
  assert.deepEqual(queueStatus(f.store).holds.map(h => h.kind), ['paused']);
  f.store.put('job', { id: 'd1', operation: 'queue.dispatch', status: 'completed', outcome: 'no-eligible-task', heldReasons: ['project held'], createdAt: new Date().toISOString() });
  assert.deepEqual(queueStatus(f.store).lastDispatch.heldReasons, ['project held']);
  assert.equal(snapshot(f.store).queueStatus.holds[0].kind, 'paused', 'in the console snapshot');
});
