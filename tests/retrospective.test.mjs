import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, until } from './helpers.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';
import { recordRetrospective } from '../starter/factory/operations/governance.mjs';

test('completed flow retrospective survives restart and is visible in the canonical console projection', async t => {
  const f = sandbox(t); f.start();
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  const saved = f.store.need('retrospective', 'flow-1');
  assert.equal(saved.state, 'completed');
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.attempts[0].status, 'passed');
  assert(saved.events.some(event => event.type === 'flow.finished'));
  assert.deepEqual(snapshot(f.store).retrospectives, [saved]);
  const reopened = new Store(f.stateDir);
  try {
    assert.deepEqual(snapshot(reopened).retrospectives, [saved]);
    const before = reopened.events().filter(event => event.type === 'retrospective.recorded').length;
    assert.deepEqual(recordRetrospective(reopened, { flowId: 'flow-1' }), saved);
    assert.equal(reopened.events().filter(event => event.type === 'retrospective.recorded').length, before);
  } finally { reopened.close(); }
});


test('historical retrospective retains the approved acceptance after a later task revision', async t => {
  const f = sandbox(t); f.start();
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  const original = f.store.need('retrospective', 'flow-1').acceptance;
  assert.equal(original.briefAvailable, true);
  assert.equal(f.command('task.put', {task:{id:f.task.id,title:'Later changed task',acceptance:['A new outcome unrelated to the completed flow']}}).status, 'completed');
  const refreshed = recordRetrospective(f.store, {flowId:'flow-1'});
  assert.deepEqual(refreshed.acceptance, original);
  assert.notDeepEqual(refreshed.acceptance.criteria, f.store.need('task', f.task.id).acceptance);
});
