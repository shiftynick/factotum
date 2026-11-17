import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

// A weekly link check: one read-only adapter step; pass completes quietly, fail ends in a notice with evidence.
function setup(t, broken) {
  const f = sandbox(t), script = join(f.base, 'check-links.mjs');
  writeFileSync(script, `process.stdout.write(JSON.stringify(${broken} ? { route: 'fail', summary: '2 broken links', observations: [{ id: 'research/a.md#L3', status: 'broken', url: 'https://example.invalid/a' }, { id: 'research/b.md#L9', status: 'broken', url: 'https://example.invalid/b' }] } : { route: 'pass', summary: 'all links resolve', observations: [] }));`);
  const observation = { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string' }, url: { type: 'string' } } };
  const config = { mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, policy: {},
    integrationAdapters: { 'link-check': { argv: [process.execPath, script], effect: 'read', schema: { type: 'object', required: ['route'], properties: { route: { type: 'string' }, summary: { type: 'string' }, observations: { type: 'array', items: observation } } } } },
    integrationWorkflows: { 'source-link-check': { kind: 'maintenance', workflow: { version: 1, start: 'check', nodes: {
      check: { kind: 'effect', action: { operation: 'integration.run', adapter: 'link-check', stage: 'link-check' }, timeoutMs: 600000, next: 'done', onFailure: 'failed', resultEdges: { pass: 'done', fail: 'broken' } },
      done: { kind: 'end', outcome: 'completed' }, broken: { kind: 'end', outcome: 'failed' }, failed: { kind: 'end', outcome: 'failed' } } } } } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  return f;
}
async function run(f) {
  const job = f.command('job.enqueue', { operation: 'workflow:source-link-check', note: 'Weekly link check', payload: {} });
  assert.equal(job.status, 'completed', job.error);
  await operationalTick(f.store);
  await until(() => ['completed', 'failed'].includes(f.store.need('job', job.result.id).status), { tick: () => f.engine.tick()});
  return f.store.need('job', job.result.id);
}

test('a read-only maintenance workflow binds the current head, and a pass completes quietly', async t => {
  const f = setup(t, false), job = await run(f);
  assert.equal(job.status, 'completed');
  assert.match(f.store.need('flow', job.flowId).integration.payload.candidate.head, /^[a-f\d]{40}$/);
  assert.equal(f.store.all('inbox').filter(row => row.flowId === job.flowId).length, 0, 'no notice for a pass');
});

test('a failing read-only check ends in one notice carrying the evidence', async t => {
  const f = setup(t, true), job = await run(f);
  assert.equal(job.status, 'failed');
  const notices = f.store.all('inbox').filter(row => row.flowId === job.flowId);
  assert.equal(notices.length, 1);
  assert.match(notices[0].context, /2 broken links/); assert.match(notices[0].context, /research\/b\.md#L9/);
  assert.notEqual(f.store.meta('recoveryHold'), true);
});

test('an integration job that cannot be admitted fails with its reason instead of faulting operations', async t => {
  const f = setup(t, false); f.store.setMeta('commissioning', null);
  const job = f.command('job.enqueue', { operation: 'workflow:source-link-check', note: 'Weekly link check', payload: {} }).result;
  await operationalTick(f.store);
  const row = f.store.need('job', job.id);
  assert.equal(row.status, 'failed'); assert.match(row.reason, /commission installed integration workflows/);
  assert.notEqual(f.store.meta('recoveryHold'), true);
});

test('a weekly Sunday 21:00 New York schedule accepts the workflow with an empty payload', t => {
  const f = setup(t, false);
  const receipt = f.command('schedule.put', { schedule: { id: 'source-link-check', operation: 'workflow:source-link-check', type: 'daily', timeOfDay: '21:00', timezone: 'America/New_York', weekdays: [0], enabled: true, payload: {} }, note: 'Weekly source link check' });
  assert.equal(receipt.status, 'completed', receipt.error);
});
