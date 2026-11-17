import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { flowNotice } from '../starter/factory/core/project.mjs';

function notice(t, receipt) {
  const f = sandbox(t);
  const flow = { id: 'maintenance:sync', kind: 'maintenance', taskId: 'job:sync', step: 'failed', jobId: 'sync', taskSnapshot: { title: 'Maintenance: source.sync' } };
  f.store.put('job', { id: 'sync', operation: 'source.sync', scheduleId: 'every-15m' });
  f.store.put('attempt', { id: 'attempt-1', flowId: flow.id, status: 'failed', receipt });
  f.store.tx(() => flowNotice(f.store, flow, 'failed'));
  return f.store.all('inbox').find(row => row.flowId === flow.id);
}

test('a successful action that failed only containment gets a containment notice', t => {
  const item = notice(t, { exitCode: 0, reason: 'descendant-survival', descendants: [{ pid: 7, comm: 'gh', phase: 'leader-exited' }], actionResult: { route: 'pass' } });
  assert.equal(item.title, 'Maintenance: source.sync: containment failed');
  assert.match(item.context, /results were recorded, but gh was still running/);
  assert.match(item.context, /next scheduled run will retry/);
});

test('an action that itself failed keeps the plain failed notice', t => {
  const item = notice(t, { exitCode: 1, reason: null, actionResult: { route: 'error', error: 'scan failed' } });
  assert.equal(item.title, 'Maintenance: source.sync: failed');
});

test('maintenance the orchestrator enqueued itself completes quietly but still reports failure', t => {
  const f = sandbox(t);
  f.store.setMeta('config', { mode: 'delivery', policy: {} });
  f.store.put('job', { id: 'self', operation: 'source.sync', grant: { actor: 'orchestrator', onBehalfOf: { principal: 'operator', instruction: 'refresh' } } });
  const flow = { id: 'maintenance:self', kind: 'maintenance', taskId: 'job:self', step: 'done', jobId: 'self', taskSnapshot: { title: 'Maintenance: source.sync' }, results: { run: { sourceSync: { status: 'ok', complete: true, errors: 0, imported: 3, changed: 0, revoked: 0 } } } };
  f.store.tx(() => flowNotice(f.store, flow, 'completed'));
  assert.equal(f.store.all('inbox').length, 0);
  f.store.tx(() => flowNotice(f.store, { ...flow, step: 'failed' }, 'failed'));
  assert.equal(f.store.all('inbox').length, 1);
});
