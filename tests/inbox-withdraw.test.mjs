import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, until } from './helpers.mjs';

const question = { id: 'pick-one', kind: 'question', title: 'Which option?', context: 'Two options were considered.', question: 'Which option?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };

test('the publisher can withdraw its standalone question with a reason, ending its wait', t => {
  const f = sandbox(t);
  const item = f.command('inbox.publish', question, { actor: 'orchestrator' }).result;
  const missing = f.command('inbox.withdraw', { inboxId: item.id, expectedVersion: item.version }, { actor: 'orchestrator' });
  assert.equal(missing.status, 'rejected'); assert.match(missing.error, /reason/);
  assert.equal(f.command('inbox.withdraw', { inboxId: item.id, expectedVersion: item.version + 1, reason: 'Decided elsewhere' }, { actor: 'orchestrator' }).status, 'rejected');
  const withdrawn = f.command('inbox.withdraw', { inboxId: item.id, expectedVersion: item.version, reason: 'Decided a third option, tracked as github:17' }, { actor: 'orchestrator' }).result;
  assert.equal(withdrawn.status, 'superseded'); assert.equal(withdrawn.withdrawal.actor, 'orchestrator'); assert.match(withdrawn.withdrawal.reason, /third option/);
  assert.equal(withdrawn.version, item.version + 1);
  assert.equal(f.store.need('wait', `question:${item.id}`).reason, 'withdrawn');
  assert.equal(f.command('answer', { inboxId: item.id, version: withdrawn.version, subjectDigest: item.subjectDigest, answer: 'a' }).status, 'rejected');
});

test('only the publisher or the operator can withdraw, and never a flow question', async t => {
  const f = sandbox(t);
  const item = f.command('inbox.publish', question).result;
  assert.equal(f.command('inbox.withdraw', { inboxId: item.id, expectedVersion: item.version, reason: 'Not mine' }, { actor: 'orchestrator' }).status, 'rejected');
  assert.equal(f.command('inbox.withdraw', { inboxId: item.id, expectedVersion: item.version, reason: 'Operator cleared it' }).status, 'completed');
  const g = sandbox(t, { question: true }); g.start();
  const flowQuestion = await until(() => g.store.all('inbox').find(row => row.flowId === 'flow-1'), { tick: () => g.engine.tick() });
  assert.ok(flowQuestion);
  const refused = g.command('inbox.withdraw', { inboxId: flowQuestion.id, expectedVersion: flowQuestion.version, reason: 'Try anyway' });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /standalone/);
});
