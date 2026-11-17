import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { actionSpecification } from '../starter/factory/workflows/actions.mjs';

test('a start note and a later flow note reach the flow agents as operator feedback', t => {
  const f = sandbox(t), task = f.store.need('task', f.task.id);
  f.command('task.approve', { taskId: task.id, revision: task.revision });
  const typo = f.command('flow.start', { taskId: task.id, revision: task.revision, notes: 'misspelt field' });
  assert.equal(typo.status, 'rejected'); assert.match(typo.error, /flow.start accepts/);
  const started = f.command('flow.start', { taskId: task.id, revision: task.revision, flowId: 'noted', note: 'Frozen source data is in data/frozen; the sandbox has no network.' }, { actor: 'orchestrator' });
  assert.equal(started.status, 'completed', started.error);
  let flow = f.store.need('flow', 'noted');
  assert.deepEqual(flow.operatorFeedback.map(row => [row.step, row.answer, row.actor]), [['start', 'start', 'orchestrator']]);
  const spec = actionSpecification(f.store, flow, { action: { operation: 'provider.build' } }, join(f.stateDir, 'spec-test'));
  assert.match(JSON.stringify(spec), /Frozen source data is in data\/frozen/);
  assert.equal(f.command('flow.note', { flowId: 'noted', note: 'Also: keep the CSV header unchanged.' }).status, 'completed');
  flow = f.store.need('flow', 'noted'); assert.equal(flow.operatorFeedback.length, 2); assert.equal(flow.operatorFeedback[1].answer, 'note');
  assert.equal(f.command('flow.note', { flowId: 'noted', note: '' }).status, 'rejected', 'a note is required');
});
