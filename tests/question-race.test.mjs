import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox, until } from './helpers.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

test('an answer landing between the engine reading a question step and opening it does not reopen the question', async t => {
  const f = sandbox(t, { question: true }); f.start();
  const first = await until(() => f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open'), { tick: () => f.engine.tick() });
  // Answer inside the engine's next step, after it has read the flow at the question node.
  const tx = f.store.tx.bind(f.store); let answered = false;
  f.store.tx = fn => { if (!answered) { answered = true; assert.equal(f.command('answer', { inboxId: first.id, version: first.version, subjectDigest: first.subjectDigest, answer: 'continue' }).status, 'completed'); } return tx(fn); };
  await f.engine.step('flow-1');
  f.store.tx = tx;
  assert.equal(f.store.all('inbox').filter(row => row.flowId === 'flow-1' && row.kind === 'question').length, 1, 'no second question');
  await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'completed');
});

test('a finished flow resolves its open questions, and maintenance repairs ones already stranded', async t => {
  const f = sandbox(t);
  f.store.put('flow', { id: 'old', taskId: f.task.id, state: 'completed', step: 'done' });
  f.store.put('inbox', { id: 'stranded', kind: 'question', status: 'open', flowId: 'old', version: 1, role: 'orchestrator', question: 'Merge?', answers: ['merge'] });
  f.store.put('wait', { id: 'question:stranded', flowId: 'old', inboxId: 'stranded', kind: 'question', startedAt: new Date().toISOString(), endedAt: null });
  await operationalTick(f.store);
  const item = f.store.need('inbox', 'stranded');
  assert.equal(item.status, 'superseded'); assert.equal(item.supersededReason, 'flow already finished'); assert.equal(item.version, 2);
  assert.ok(f.store.need('wait', 'question:stranded').endedAt);
});
