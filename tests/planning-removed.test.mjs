import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };

test('planning-ahead settings are ignored and reported, so older configurations still commission', t => {
  const f = sandbox(t);
  const result = f.command('config.update', { config: { ...base, policy: { autoPlanQueue: true, planningWindow: 3, planMaxAgeMs: 60000 }, stepModels: { planning: { plan: { model: 'm' } } } }, note: 'Upgrade' });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.result.ignoredSettings, ['policy.autoPlanQueue', 'policy.planningWindow', 'policy.planMaxAgeMs', 'stepModels.planning']);
  const config = f.store.meta('config');
  assert.equal(config.policy.autoPlanQueue, undefined); assert.equal(config.stepModels.planning, undefined);
});

test('the Plan command is gone and leftover ready plans are retired, with an obligation for a retained worktree', t => {
  const f = sandbox(t), workspace = join(f.base, 'old-plan-tree'); mkdirSync(workspace);
  assert.equal(f.command('flow.plan', { taskId: f.task.id, revision: f.task.revision }).status, 'rejected');
  f.store.put('plan', { id: 'with-tree', status: 'ready', flowId: 'planning-1', workspace: { path: workspace } });
  f.store.put('plan', { id: 'no-tree', status: 'ready', flowId: 'planning-2' });
  f.store.put('plan', { id: 'used', status: 'consumed', flowId: 'planning-3' });
  assert.equal(f.command('config.update', { config: base, note: 'Upgrade' }).status, 'completed');
  assert.equal(f.store.need('plan', 'with-tree').status, 'retired'); assert.equal(f.store.need('plan', 'no-tree').status, 'retired');
  assert.equal(f.store.need('plan', 'used').status, 'consumed');
  const obligation = f.store.need('obligation', f.store.need('plan', 'with-tree').cleanupObligationId);
  assert.equal(obligation.requiresAuthorization, true); assert.equal(f.store.need('plan', 'no-tree').cleanupObligationId, undefined);
});
