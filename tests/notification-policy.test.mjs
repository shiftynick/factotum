import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { deliverDue } from '../starter/factory/operations/notifications.mjs';

function fixture(t, notifications = { level: 'all' }) {
  const f = sandbox(t); f.store.setMeta('config', { mode: 'delivery', policy: {}, notifications });
  const configPath = join(f.base, 'notifications.json'); writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  const sent = [], transport = async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; };
  const deliver = nowMs => deliverDue(f.store, { configPath, transport, nowMs });
  return { ...f, sent, deliver, configPath };
}
const notice = { id: 'review-x', kind: 'notice', title: 'Please review X', context: 'A long review' };
const question = { id: 'pick', kind: 'question', title: 'Pick one', context: 'Two options', question: 'Which?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
const hour = 3600000;
// Deliveries become due at the real time they are queued, so a delivery clock read
// before slow setup work can fall behind them. Read it once queueing is done.
const afterQueued = () => Date.now() + 1000;

test('notices are delivered once by default while questions keep reminding', async t => {
  const f = fixture(t);
  f.command('inbox.publish', notice, { actor: 'orchestrator' }); f.command('inbox.publish', question, { actor: 'orchestrator' });
  await operationalTick(f.store); const now = afterQueued(); await f.deliver(now);
  assert.equal(f.sent.length, 2);
  await f.deliver(now + 5 * hour);
  assert.deepEqual(f.sent.slice(2).map(body => body.inboxId), ['pick'], 'only the question is re-sent');
  assert.equal(f.store.all('delivery').find(row => row.inboxId === 'review-x').status, 'delivered');
});

test('publishers can set reminders per item', async t => {
  const f = fixture(t);
  assert.equal(f.command('inbox.publish', { ...notice, remind: 60000 }).status, 'rejected');
  f.command('inbox.publish', { ...notice, remind: 2 * hour }); f.command('inbox.publish', { ...question, remind: 'never' });
  await operationalTick(f.store); const now = afterQueued(); await f.deliver(now); await f.deliver(now + 3 * hour);
  assert.deepEqual(f.sent.slice(2).map(body => body.inboxId), ['review-x']);
});

test('resolution wakes carry the resolving actor and can skip the orchestrator\'s own resolutions', async t => {
  const plain = fixture(t);
  const item = plain.command('inbox.publish', notice, { actor: 'orchestrator' }).result;
  plain.command('inbox.ack', { inboxId: item.id }, { actor: 'orchestrator' });
  await operationalTick(plain.store); await plain.deliver(afterQueued());
  const resolved = plain.sent.find(body => body.event === 'inbox.resolved');
  assert.equal(resolved.resolution, 'acknowledged'); assert.equal(resolved.actor, 'orchestrator');

  const quiet = fixture(t, { level: 'all', suppressSelfResolutions: true });
  const mine = quiet.command('inbox.publish', question, { actor: 'orchestrator' }).result;
  const theirs = quiet.command('inbox.publish', { ...question, id: 'ask-operator' }, { actor: 'orchestrator' }).result;
  quiet.command('inbox.withdraw', { inboxId: mine.id, expectedVersion: mine.version, reason: 'Decided elsewhere' }, { actor: 'orchestrator' });
  quiet.command('answer', { inboxId: theirs.id, version: theirs.version, subjectDigest: theirs.subjectDigest, answer: 'a' });
  await operationalTick(quiet.store); await operationalTick(quiet.store); await quiet.deliver(afterQueued());
  assert.deepEqual(quiet.sent.map(body => [body.inboxId, body.resolution, body.actor]), [['ask-operator', 'answered', 'operator']]);
  assert.equal(quiet.store.all('delivery').find(row => row.inboxId === mine.id).status, 'suppressed');
});

test('an accepted notice delivery scheduled to remind before the policy change completes without re-sending', async t => {
  const f = fixture(t), now = Date.now() + 1000;
  f.command('inbox.publish', notice, { actor: 'orchestrator' });
  await operationalTick(f.store);
  // A pre-change delivery: accepted earlier, acknowledged, reminder due now.
  const row = f.store.all('delivery')[0];
  f.store.put('delivery', { ...row, status: 'accepted', attempts: 2, acknowledgedAt: new Date(now - 4 * hour).toISOString(), nextAt: new Date(now - 1).toISOString() });
  await f.deliver(now);
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.need('delivery', row.id).status, 'delivered');
});

test('essential level wakes once per flow end and never for the orchestrator\'s own actions', async t => {
  const { queueStateDeliveryInTransaction } = await import('../starter/factory/operations/notifications.mjs');
  const f = fixture(t, { level: 'essential' });
  f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level: 'essential', configPath: f.configPath } });
  const states = () => f.store.all('delivery').filter(row => row.kind === 'state').map(row => row.event);
  const emit = (type, actor) => { f.store.commandActor = actor; queueStateDeliveryInTransaction(f.store, { sequence: Math.floor(Math.random() * 1e9), at: new Date().toISOString(), type, payload: { taskId: f.task.id } }); f.store.commandActor = null; };
  for (const type of ['flow.admitted', 'flow.finished', 'flow.stopped', 'flow.resumed']) emit(type, null);
  assert.deepEqual(states(), [], 'flow ends arrive as the flow notice; admissions and resumes do not wake');
  emit('task.approved', 'orchestrator'); assert.deepEqual(states(), [], 'own approval');
  emit('task.approval-revoked', 'operator'); assert.deepEqual(states(), ['task.approval-revoked']);
  // Its own published question and resolutions it caused do not wake it; the operator's answer does.
  const mine = f.command('inbox.publish', question, { actor: 'orchestrator' }).result;
  const theirs = f.command('inbox.publish', { ...question, id: 'operator-asks' }).result;
  f.store.put('inbox', { ...f.store.need('inbox', 'operator-asks'), status: 'superseded', version: 2, supersededBy: null });
  f.command('inbox.publish', notice);
  const { queueDelivery } = await import('../starter/factory/operations/notifications.mjs');
  for (const item of f.store.all('inbox')) queueDelivery(f.store, { inboxId: item.id });
  await f.deliver(afterQueued());
  assert.deepEqual(f.sent.filter(body => body.kind === 'inbox').map(body => body.inboxId), ['review-x'], 'operator notice wakes; own question and superseded resolution do not');
  assert.equal(f.store.all('delivery').find(row => row.inboxId === mine.id).status, 'suppressed');
  void theirs;
});
