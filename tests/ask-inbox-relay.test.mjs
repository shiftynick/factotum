// Readiness G2: one question shown through an external prompt channel and the inbox
// together, and answers that arrive through that channel stored as relayed. Fictional
// fixtures; real command paths (executeCommand, the operations tick, the delivery
// loop, the project service, the console command endpoint and the CLI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, until } from './helpers.mjs';
import { migrated } from './authority-fixtures.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { executeCommand, snapshot } from '../starter/factory/core/project.mjs';
import { auditAuthorityRecords } from '../starter/factory/core/decision-authority.mjs';
import { settlePresentations } from '../starter/factory/core/communication.mjs';
import { deliverDue, queueDelivery } from '../starter/factory/operations/notifications.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { startProjectService, collection } from '../starter/factory/service/project-service.mjs';
import { startConsole } from '../starter/factory/console/console.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const CHANNEL = 'fictional-ask';
const ok = receipt => { assert.equal(receipt.status, 'completed', receipt.error); return receipt.result; };
const refused = (receipt, pattern) => { assert.equal(receipt.status, 'rejected', `expected a refusal matching ${pattern}`); assert.match(receipt.error, pattern); return receipt; };
const instruction = { principal: 'operator', instruction: 'Fictional operator chose an option in the prompt.' };
const as = (f, operation, payload, { actor = 'orchestrator', onBehalfOf, authority, commandId = uid(), store = f.store } = {}) => executeCommand(store, { protocolVersion: 1, projectId: f.project.projectId, commandId, operation, payload, actor, ...(onBehalfOf ? { onBehalfOf } : {}), ...(authority ? { authority } : {}) });
const question = { id: 'pick-one', kind: 'question', title: 'Which fictional layout?', context: 'Two layouts were drafted.', question: 'Which fictional layout?', choices: [{ id: 'a', label: 'Layout A' }, { id: 'b', label: 'Layout B' }] };
const item = (f, inboxId = 'pick-one') => f.store.need('inbox', inboxId);
const present = (f, inboxId = 'pick-one', extra = {}) => ok(as(f, 'inbox.present', { inboxId, expectedVersion: item(f, inboxId).version, channel: CHANNEL, ...extra }));
const answerOf = (f, inboxId, extra) => { const row = item(f, inboxId); return { inboxId, version: row.version, subjectDigest: row.subjectDigest, ...extra }; };
const events = (f, type) => f.store.events(200).filter(event => event.type === type).map(event => event.payload);
// The presentation's time passes (the shortest a command accepts is a minute).
const elapse = (f, inboxId = 'pick-one') => { const row = item(f, inboxId); for (const shown of row.presentations) if (shown.status === 'pending') shown.expiresAt = new Date(Date.now() - 1000).toISOString(); f.store.put('inbox', row); };

test('a question is presented on a prompt channel without changing it; one pending presentation at a time; replay returns the first receipt', t => {
  const f = sandbox(t), q = ok(f.command('inbox.publish', question));
  refused(as(f, 'inbox.present', { inboxId: q.id, expectedVersion: q.version + 1, channel: CHANNEL }), /stale or resolved question/);
  refused(as(f, 'inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: '' }), /presentation channel required/);
  refused(as(f, 'inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: CHANNEL, expiryMs: 59999 }), /one minute to one day/);
  refused(as(f, 'inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: CHANNEL, expiryMs: 86400001 }), /one minute to one day/);
  refused(as(f, 'inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: CHANNEL, actor: 'operator' }), /does not accept actor/);
  const notice = ok(f.command('inbox.publish', { kind: 'notice', title: 'Fictional notice', context: 'Nothing is asked.' }));
  refused(as(f, 'inbox.present', { inboxId: notice.id, expectedVersion: notice.version, channel: CHANNEL }), /only a question can be presented/);
  const payload = { inboxId: q.id, expectedVersion: q.version, channel: CHANNEL, expiryMs: 600000, id: 'shown-1' };
  const first = as(f, 'inbox.present', payload, { commandId: 'cmd-present' }), shown = ok(first);
  assert.equal(shown.presentation.status, 'pending'); assert.equal(shown.presentation.presentedBy, 'orchestrator'); assert.equal(shown.presentation.channel, CHANNEL);
  assert.equal(Date.parse(shown.presentation.expiresAt) - Date.parse(shown.presentation.presentedAt), 600000);
  // The question itself is untouched: same version, digest, status and wait, so an answer form already open stays valid.
  const after = item(f);
  assert.equal(after.version, q.version); assert.equal(after.subjectDigest, q.subjectDigest); assert.equal(after.status, 'open');
  assert.equal(f.store.need('wait', `question:${q.id}`).endedAt, null);
  assert.deepEqual(shown, { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, presentation: after.presentations[0] });
  assert.deepEqual(snapshot(f.store).inbox.find(row => row.id === q.id).presentations, after.presentations, 'visible on the inbox item');
  // Replay and a second presentation.
  assert.deepEqual(as(f, 'inbox.present', payload, { commandId: 'cmd-present' }), first);
  assert.throws(() => as(f, 'inbox.present', { ...payload, channel: 'another' }, { commandId: 'cmd-present' }), /command id reused/);
  refused(as(f, 'inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: 'second-channel' }), /already presented on fictional-ask/);
  assert.equal(item(f).presentations.length, 1); assert.equal(events(f, 'inbox.presented').length, 1);
  // Withdrawal: the presenter or the operator, with a reason; the question stays open.
  refused(as(f, 'inbox.unpresent', { inboxId: q.id, presentationId: 'shown-1' }), /withdrawal reason required/);
  refused(as(f, 'inbox.unpresent', { inboxId: q.id, presentationId: 'unknown', reason: 'Fictional' }), /unknown presentation/);
  const withdrawn = ok(as(f, 'inbox.unpresent', { inboxId: q.id, presentationId: 'shown-1', reason: 'The fictional operator stepped away.' }));
  assert.equal(withdrawn.presentation.status, 'withdrawn'); assert.equal(withdrawn.presentation.endedBy, 'orchestrator'); assert.equal(withdrawn.status, 'open');
  refused(as(f, 'inbox.unpresent', { inboxId: q.id, presentationId: 'shown-1', reason: 'Again' }), /already withdrawn/);
  assert.equal(item(f).version, q.version);
  // It can be presented again; a presentation by the operator is not the orchestrator's to withdraw.
  const again = ok(f.command('inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: CHANNEL }));
  assert.equal(Date.parse(again.presentation.expiresAt) - Date.parse(again.presentation.presentedAt), 900000, 'fifteen minutes by default');
  refused(as(f, 'inbox.unpresent', { inboxId: q.id, presentationId: again.presentation.id, reason: 'Not mine' }), /only the presenter or the operator/);
  ok(f.command('inbox.unpresent', { inboxId: q.id, presentationId: again.presentation.id, reason: 'Operator took it down.' }));
  // Never past the question's own expiry.
  const brief = ok(f.command('inbox.publish', { ...question, id: 'brief', expiryMs: 120000 }));
  assert.equal(present(f, 'brief', { expiryMs: 3600000 }).presentation.expiresAt, brief.expiresAt);
});

test('an answer in the inbox settles the prompt: the pending presentation becomes obsolete and accepts nothing', t => {
  const f = sandbox(t), q = ok(f.command('inbox.publish', question));
  const shown = present(f).presentation;
  // The operator answers with the version read before the presentation.
  const answered = ok(f.command('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'b', note: 'B reads better.' }));
  assert.equal(answered.status, 'answered'); assert.equal(answered.answeredBy, 'operator'); assert.equal(answered.relay, undefined, 'a direct operator answer is not relayed');
  const row = item(f).presentations[0];
  assert.equal(row.status, 'obsolete'); assert.equal(row.endedBy, 'operator'); assert.match(row.reason, /answered by the operator in the inbox/); assert.equal(row.notify, true);
  assert.deepEqual(events(f, 'inbox.presentation-ended').map(e => [e.presentationId, e.status]), [[shown.id, 'obsolete']]);
  assert.equal(f.store.meta('presentedInbox').length, 0);
  // A late answer through the prompt changes nothing.
  refused(as(f, 'answer', answerOf(f, q.id, { answer: 'a', relay: { quote: 'Layout A', channel: CHANNEL }, presentationId: shown.id }), { onBehalfOf: instruction }), /presentation .* is obsolete/);
  assert.equal(item(f).answer, 'b');
  // Every other way a question ends settles its prompt too: withdrawal, expiry and a stopped flow.
  const w = ok(f.command('inbox.publish', { ...question, id: 'withdrawn' })); present(f, w.id);
  ok(f.command('inbox.withdraw', { inboxId: w.id, expectedVersion: w.version, reason: 'Decided elsewhere.' }));
  assert.equal(item(f, w.id).presentations[0].status, 'obsolete'); assert.match(item(f, w.id).presentations[0].reason, /withdrawn by the operator/);
});

test('a flow question presented on a prompt is settled when its flow is stopped', async t => {
  const f = sandbox(t, { question: true }); f.start();
  const q = await until(() => f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open'), { tick: () => f.engine.tick() });
  const shown = present(f, q.id).presentation;
  ok(f.command('stop', { flowId: 'flow-1', note: 'Fictional stop' }));
  const stopped = item(f, q.id);
  assert.equal(stopped.status, 'superseded'); assert.equal(stopped.presentations[0].status, 'obsolete'); assert.equal(stopped.presentations[0].id, shown.id);
  refused(as(f, 'answer', { inboxId: q.id, version: stopped.version, subjectDigest: q.subjectDigest, answer: 'continue', relay: { quote: 'Continue', channel: CHANNEL }, presentationId: shown.id }, { onBehalfOf: instruction }), /is obsolete/);
});

test('an answer through the prompt settles the inbox item and is stored as relayed: verbatim, nothing added, never the operator’s', t => {
  const f = sandbox(t), q = ok(f.command('inbox.publish', question));
  const shown = present(f).presentation;
  const quote = '  Layout B —\n“the roomier one”, please.  ', relay = { quote, channel: CHANNEL };
  const base = answerOf(f, q.id, { answer: 'b', relay, presentationId: shown.id });
  // Through a presentation an answer is always relayed, and the relayer is never the operator.
  const { relay: _dropped, ...bare } = base;
  refused(as(f, 'answer', bare, { onBehalfOf: instruction }), /arrived through a presentation is relayed/);
  refused(f.command('answer', base), /the operator answers directly/);
  refused(f.command('answer', bare), /the operator answers directly/);
  // No payload field names the relayer or makes the answer the operator's.
  refused(as(f, 'answer', { ...base, relay: { ...relay, actor: 'operator' } }, { onBehalfOf: instruction }), /relay is \{quote, channel\}/);
  refused(as(f, 'answer', { ...base, relay: { ...relay, relayedBy: 'operator' } }, { onBehalfOf: instruction }), /relay is \{quote, channel\}/);
  refused(as(f, 'answer', { ...base, answeredBy: 'operator' }, { onBehalfOf: instruction }), /does not accept answeredBy/);
  refused(as(f, 'answer', { ...base, actor: 'operator' }, { onBehalfOf: instruction }), /does not accept actor/);
  refused(as(f, 'answer', { ...base, relay: { quote: '', channel: CHANNEL } }, { onBehalfOf: instruction }), /relay quote/);
  refused(as(f, 'answer', { ...base, relay: { quote, channel: 'elsewhere' } }, { onBehalfOf: instruction }), /relay channel must be the presentation's channel/);
  refused(as(f, 'answer', { ...base, presentationId: 'unknown' }, { onBehalfOf: instruction }), /unknown presentation/);
  // It confers no authority: without the delegation an answer needs today, the relay changes nothing.
  refused(as(f, 'answer', base), /operator authority required/);
  const config = f.store.meta('config');
  f.store.setMeta('config', { ...config, policy: { ...config.policy, delegatedOperations: [] } });
  refused(as(f, 'answer', base, { onBehalfOf: instruction }), /not delegated to the orchestrator/);
  f.store.setMeta('config', config);
  assert.equal(item(f).status, 'open'); assert.equal(item(f).presentations[0].status, 'pending'); assert.equal(item(f).relay, undefined);
  // The relayed answer.
  const first = as(f, 'answer', base, { onBehalfOf: instruction, commandId: 'cmd-relayed-answer' }), answered = ok(first);
  assert.equal(answered.status, 'answered'); assert.equal(answered.answer, 'b'); assert.equal(answered.answeredBy, 'orchestrator');
  const { recordedAt, ...record } = answered.relay;
  assert.deepEqual(record, { schemaVersion: 1, relayedBy: 'orchestrator', channel: CHANNEL, quote, commandId: 'cmd-relayed-answer', presentationId: shown.id });
  assert.ok(Date.parse(recordedAt));
  assert.equal(answered.presentations[0].status, 'answered'); assert.equal(answered.presentations[0].endedBy, 'orchestrator'); assert.equal(answered.presentations[0].notify, undefined);
  assert.equal(f.store.need('wait', `question:${q.id}`).reason, 'answered');
  assert.deepEqual(item(f), answered, 'stored as returned');
  // Visible in History: the item, its events and the command.
  const answeredEvent = events(f, 'inbox.answered').at(-1);
  assert.equal(answeredEvent.relayed, true); assert.equal(answeredEvent.relayedBy, 'orchestrator'); assert.equal(answeredEvent.channel, CHANNEL);
  assert.deepEqual(collection(f.store, 'inbox', new URLSearchParams()).items.find(row => row.id === q.id).relay, answered.relay);
  assert.equal(f.store.command('cmd-relayed-answer').onBehalfOf.principal, 'operator', 'the delegation instruction stays attribution, not the answerer');
  // Replay, and a second answer.
  assert.deepEqual(as(f, 'answer', base, { onBehalfOf: instruction, commandId: 'cmd-relayed-answer' }), first);
  refused(as(f, 'answer', base, { onBehalfOf: instruction }), /is answered|stale or resolved/);
  assert.equal(events(f, 'inbox.answered').length, 1);
  // Words relayed from elsewhere (no presentation) are recorded the same way.
  const other = ok(f.command('inbox.publish', { ...question, id: 'chat' }));
  const chat = ok(as(f, 'answer', answerOf(f, other.id, { answer: 'a', relay: { quote: 'Go with A.', channel: 'fictional chat thread' } }), { onBehalfOf: instruction }));
  assert.equal(chat.relay.relayedBy, 'orchestrator'); assert.equal(chat.relay.quote, 'Go with A.'); assert.equal(chat.relay.presentationId, undefined);
  // Today's delegated answer without a relay is unchanged.
  const plain = ok(f.command('inbox.publish', { ...question, id: 'plain' }));
  const delegated = ok(as(f, 'answer', answerOf(f, plain.id, { answer: 'a' }), { onBehalfOf: instruction }));
  assert.equal(delegated.answeredBy, 'orchestrator'); assert.equal(delegated.relay, undefined); assert.equal(delegated.presentations, undefined);
});

test('a flow question answered through the prompt moves its flow under the same authority as before, and is stored as relayed', async t => {
  const f = sandbox(t, { question: true }); f.start();
  const q = await until(() => f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open'), { tick: () => f.engine.tick() });
  const shown = present(f, q.id).presentation, base = answerOf(f, q.id, { answer: 'continue', relay: { quote: 'continue', channel: CHANNEL }, presentationId: shown.id });
  refused(as(f, 'answer', base), /operator authority required|question requires designated actor/);
  refused(as(f, 'answer', { ...base, answer: 'merge' }, { onBehalfOf: instruction }), /invalid answer/);
  assert.equal(item(f, q.id).presentations[0].status, 'pending');
  const answered = ok(as(f, 'answer', base, { onBehalfOf: instruction }));
  assert.equal(answered.relay.relayedBy, 'orchestrator'); assert.equal(answered.relay.quote, 'continue'); assert.equal(answered.presentations[0].status, 'answered');
  assert.equal(events(f, 'inbox.answered').at(-1).relayed, true);
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
});

test('an unanswered presentation expires on the factory’s own timer and the question stays open in the inbox', async t => {
  const f = sandbox(t), q = ok(f.command('inbox.publish', question));
  const shown = present(f, q.id, { expiryMs: 60000 }).presentation;
  await operationalTick(f.store);
  assert.equal(item(f).presentations[0].status, 'pending', 'not before its time');
  elapse(f);
  // Before any sweep, an answer through it is already refused by the clock.
  refused(as(f, 'answer', answerOf(f, q.id, { answer: 'a', relay: { quote: 'Layout A', channel: CHANNEL }, presentationId: shown.id }), { onBehalfOf: instruction }), /is expired; no answer is accepted through it/);
  await operationalTick(f.store);
  const row = item(f);
  assert.equal(row.presentations[0].status, 'expired'); assert.equal(row.presentations[0].endedBy, 'factory'); assert.match(row.presentations[0].reason, /stays open in the inbox/);
  assert.equal(row.status, 'open'); assert.equal(row.version, q.version); assert.equal(f.store.need('wait', `question:${q.id}`).endedAt, null);
  assert.deepEqual(events(f, 'inbox.presentation-ended').map(e => e.status), ['expired']);
  await operationalTick(f.store);
  assert.equal(events(f, 'inbox.presentation-ended').length, 1, 'expired once');
  refused(as(f, 'answer', answerOf(f, q.id, { answer: 'a', relay: { quote: 'Layout A', channel: CHANNEL }, presentationId: shown.id }), { onBehalfOf: instruction }), /is expired/);
  // It can be presented again, and the inbox still takes the answer.
  const again = present(f).presentation;
  assert.notEqual(again.id, shown.id); assert.equal(item(f).presentations.length, 2);
  ok(f.command('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'a' }));
  assert.deepEqual(item(f).presentations.map(p => p.status), ['expired', 'obsolete']);
});

test('an open presentation holds nothing: other questions, notices, deliveries, flows and configuration go on', async t => {
  const f = sandbox(t), configPath = join(f.base, 'notifications.json'), sent = [];
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level: 'all', configPath } });
  const deliver = nowMs => deliverDue(f.store, { configPath, nowMs, limit: 100, transport: async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; } });
  const q = ok(f.command('inbox.publish', question));
  present(f, q.id, { expiryMs: 86400000 });
  // Other inbox work.
  const other = ok(f.command('inbox.publish', { ...question, id: 'other' }));
  ok(f.command('answer', { inboxId: other.id, version: other.version, subjectDigest: other.subjectDigest, answer: 'a' }));
  const notice = ok(f.command('inbox.publish', { kind: 'notice', title: 'Fictional notice', context: 'Unrelated.' }));
  ok(f.command('inbox.ack', { inboxId: notice.id }));
  // A whole flow, start to finish.
  ok(f.start());
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: async () => { await f.engine.tick(); await operationalTick(f.store); } });
  // Deliveries: the presented question's own first delivery, the other items' resolutions and state events.
  for (const row of f.store.all('inbox')) queueDelivery(f.store, { inboxId: row.id });
  await deliver(Date.now() + 1000);
  assert.ok(sent.some(body => body.inboxId === q.id && body.event === 'inbox.attention'), 'the presented question is still delivered');
  assert.ok(sent.some(body => body.inboxId === other.id && body.event === 'inbox.resolved'));
  assert.ok(sent.some(body => body.inboxId === notice.id));
  assert.ok(sent.some(body => body.kind === 'state' && body.event === 'flow.finished'));
  // Administrative commands and a drain check.
  ok(f.command('pause', { paused: true, note: 'Fictional pause' })); ok(f.command('pause', { paused: false, note: 'Fictional resume' }));
  ok(f.command('config.update', { config: f.store.meta('config'), note: 'Fictional unchanged configuration' }));
  assert.equal(item(f).presentations[0].status, 'pending'); assert.equal(item(f).status, 'open');
  assert.equal(f.store.all('wait').filter(w => !w.endedAt).length, 1, 'only the question itself is waiting; a presentation is not a wait');
});

function notifying(t, level, options) {
  const f = sandbox(t, options), configPath = join(f.base, 'notifications.json'), sent = [];
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level, configPath } });
  const queue = () => { for (const row of f.store.all('inbox')) queueDelivery(f.store, { inboxId: row.id }); };
  // `during` holds what happens while one request is in flight (run once, in order); each may return the endpoint's reply.
  const during = [];
  const deliver = async (nowMs, store = f.store) => { queue(); return deliverDue(store, { configPath, nowMs, limit: 100, transport: async request => { const body = JSON.parse(request.payload); sent.push(body); return (await during.shift()?.(body)) ?? { status: 202 }; } }); };
  return { ...f, sent, deliver, queue, during, configPath };
}
const MIN = 60000;

for (const level of ['actionable', 'essential']) test(`${level} notifications: a presented question is delivered once, not reminded while the prompt is up, and its presenter is woken once at expiry`, async t => {
  const f = notifying(t, level), q = ok(f.command('inbox.publish', question)), start = Date.now();
  await f.deliver(start + 1000);
  assert.deepEqual(f.sent.map(body => [body.inboxId, body.event]), [[q.id, 'inbox.attention']]);
  const shown = present(f, q.id, { expiryMs: 120 * MIN }).presentation;
  await f.deliver(start + 2000);
  assert.equal(f.sent.length, 1, 'presenting sends nothing');
  // The 30-minute reminder falls while the prompt is up: held until the presentation ends.
  await f.deliver(start + 31 * MIN); await f.deliver(start + 90 * MIN);
  assert.equal(f.sent.length, 1);
  const attention = () => f.store.all('delivery').find(row => row.inboxId === q.id && row.event === 'inbox.attention');
  assert.equal(attention().nextAt, shown.expiresAt); assert.equal(attention().status, 'accepted');
  // Expiry: one wake so the presenter takes the prompt down; then reminders resume as usual.
  const expiry = Date.parse(shown.expiresAt) + 1000;
  f.store.tx(() => settlePresentations(f.store, { nowMs: expiry }));
  assert.equal(item(f).presentations[0].status, 'expired');
  await f.deliver(expiry); await f.deliver(expiry + 1000);
  assert.deepEqual(f.sent.slice(1).map(body => [body.inboxId, body.event, body.version]), [[q.id, 'inbox.attention', q.version]]);
  assert.equal(attention().status, 'accepted'); assert.equal(attention().presentationEnded, undefined);
  await f.deliver(expiry + 31 * MIN);
  assert.equal(f.sent.length, 3, 'the ordinary reminder, now that nothing else is asking');
  // An inbox answer: one resolution, attributed to the operator.
  ok(f.command('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'a' }));
  await f.deliver(expiry + 32 * MIN); await f.deliver(expiry + 33 * MIN);
  assert.deepEqual(f.sent.slice(3).map(body => [body.event, body.resolution, body.actor]), [['inbox.resolved', 'answered', 'operator']]);
});

test('the orchestrator’s own question stays quiet, except for the one wake when its prompt expires or someone else resolves it', async t => {
  const f = notifying(t, 'essential'), start = Date.now();
  const own = ok(as(f, 'inbox.publish', { ...question, id: 'own' }));
  const shown = present(f, own.id, { expiryMs: 10 * MIN }).presentation;
  await f.deliver(start + 1000); await f.deliver(start + 6 * MIN);
  assert.equal(f.sent.length, 0, 'its own open question does not wake it');
  const expiry = Date.parse(shown.expiresAt) + 1000;
  f.store.tx(() => settlePresentations(f.store, { nowMs: expiry }));
  await f.deliver(expiry); await f.deliver(expiry + 31 * MIN); await f.deliver(expiry + 5 * 60 * MIN);
  assert.deepEqual(f.sent.map(body => [body.inboxId, body.event]), [[own.id, 'inbox.attention']], 'woken once to take the prompt down');
  assert.equal(f.store.all('delivery').find(row => row.inboxId === own.id).status, 'suppressed', 'and quiet again afterwards');
  // Its own relayed answer through a new prompt is its own resolution: no wake.
  const again = present(f, own.id).presentation;
  ok(as(f, 'answer', answerOf(f, own.id, { answer: 'a', relay: { quote: 'Layout A', channel: CHANNEL }, presentationId: again.id }), { onBehalfOf: instruction }));
  await f.deliver(Date.now() + 1000);
  assert.equal(f.sent.length, 1);
  // A question that never reminds: one wake at expiry, then delivered and silent again.
  const quiet = ok(f.command('inbox.publish', { ...question, id: 'quiet', remind: 'never' }));
  await f.deliver(Date.now() + 1000);
  const row = () => f.store.all('delivery').find(d => d.inboxId === quiet.id);
  assert.equal(row().status, 'delivered'); assert.equal(f.sent.length, 2);
  const brief = present(f, quiet.id, { expiryMs: 10 * MIN }).presentation, ended = Date.parse(brief.expiresAt) + 1000;
  f.store.tx(() => settlePresentations(f.store, { nowMs: ended }));
  await f.deliver(ended); await f.deliver(ended + 31 * MIN); await f.deliver(ended + 5 * 60 * MIN);
  assert.deepEqual(f.sent.slice(2).map(body => [body.inboxId, body.event]), [[quiet.id, 'inbox.attention']]);
  assert.equal(row().status, 'delivered');
  // The operator takes the prompt down from the console: the presenter is told once, and the question stays open.
  const g = notifying(t, 'actionable');
  const mine = ok(as(g, 'inbox.publish', { ...question, id: 'mine' })), prompt = present(g, mine.id).presentation;
  ok(g.command('inbox.unpresent', { inboxId: mine.id, presentationId: prompt.id, reason: 'Not now.' }));
  await g.deliver(Date.now() + 1000); await g.deliver(Date.now() + 2000);
  assert.deepEqual(g.sent.map(body => [body.inboxId, body.event]), [[mine.id, 'inbox.attention']]);
  assert.equal(g.store.need('inbox', mine.id).status, 'open');
  // Taking its own prompt down wakes no one.
  const self = present(g, mine.id).presentation;
  ok(as(g, 'inbox.unpresent', { inboxId: mine.id, presentationId: self.id, reason: 'Asked in the wrong place.' }));
  await g.deliver(Date.now() + 3000);
  assert.equal(g.sent.length, 1);
});

test('a presented flow question superseded by someone else still tells its presenter once, despite the superseded filter', async t => {
  const f = notifying(t, 'actionable', { question: true }); f.start();
  const q = await until(() => f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open'), { tick: () => f.engine.tick() });
  await f.deliver(Date.now() + 1000);
  present(f, q.id);
  ok(f.command('stop', { flowId: 'flow-1', note: 'Fictional stop by the operator' }));
  await f.deliver(Date.now() + 2000); await f.deliver(Date.now() + 3000);
  assert.deepEqual(f.sent.filter(body => body.inboxId === q.id).map(body => [body.event, body.resolution ?? null]), [['inbox.attention', null], ['inbox.resolved', 'superseded']]);
  // Without a presentation the same supersession stays filtered.
  const g = notifying(t, 'actionable', { question: true }); g.start();
  const plain = await until(() => g.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open'), { tick: () => g.engine.tick() });
  await g.deliver(Date.now() + 1000);
  ok(g.command('stop', { flowId: 'flow-1', note: 'Fictional stop by the operator' }));
  await g.deliver(Date.now() + 2000);
  assert.deepEqual(g.sent.filter(body => body.inboxId === plain.id).map(body => body.event), ['inbox.attention']);
});

test('presentations, relayed answers and replay survive a restart; expiry is settled by the next process', async t => {
  const f = sandbox(t), q = ok(f.command('inbox.publish', question));
  const shown = present(f).presentation;
  const second = new Store(f.stateDir); t.after(() => second.close());
  assert.deepEqual(second.need('inbox', q.id).presentations, [shown]);
  assert.deepEqual(second.meta('presentedInbox'), [q.id]);
  const payload = { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'b', relay: { quote: 'Layout B', channel: CHANNEL }, presentationId: shown.id };
  const first = as(f, 'answer', payload, { onBehalfOf: instruction, commandId: 'cmd-restart', store: second });
  assert.equal(first.status, 'completed', first.error);
  const third = new Store(f.stateDir); t.after(() => third.close());
  assert.deepEqual(as(f, 'answer', payload, { onBehalfOf: instruction, commandId: 'cmd-restart', store: third }), first);
  assert.equal(third.need('inbox', q.id).relay.quote, 'Layout B'); assert.equal(third.need('inbox', q.id).presentations[0].status, 'answered');
  // A presentation left pending by a stopped process expires when the next one ticks.
  const late = ok(f.command('inbox.publish', { ...question, id: 'late' })); present(f, late.id); elapse(f, late.id);
  const fourth = new Store(f.stateDir); t.after(() => fourth.close());
  await operationalTick(fourth);
  assert.equal(fourth.need('inbox', late.id).presentations[0].status, 'expired'); assert.equal(fourth.need('inbox', late.id).status, 'open');
  assert.deepEqual(fourth.meta('presentedInbox'), []);
});

test('the project service, the console command endpoint and the CLI carry presentations and relayed answers', async t => {
  const f = sandbox(t), q = ok(f.command('inbox.publish', question));
  const service = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'ask.sock'), run: false });
  const app = await startConsole({ stateDir: join(f.base, 'console'), port: 0, timeoutMs: 30000 });
  t.after(async () => { await app.close(); await service.close(); });
  const binding = await app.registerProject({ socketPath: service.socketPath });
  const page = await fetch(app.url), cookie = page.headers.get('set-cookie').split(';')[0], csrf = (await page.text()).match(/name="factotum-csrf" content="([^"]+)"/)[1];
  const send = async body => { const response = await fetch(`${app.url}/api/commands`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-factotum-csrf': csrf }, body: JSON.stringify({ projectId: f.project.projectId, bindingId: binding.bindingId, commandId: uid(), ...body }) }); return { status: response.status, body: await response.json() }; };
  const presented = await send({ actor: 'orchestrator', operation: 'inbox.present', payload: { inboxId: q.id, expectedVersion: q.version, channel: CHANNEL, id: 'shown-console' } });
  assert.equal(presented.status, 200); assert.equal(presented.body.status, 'completed', JSON.stringify(presented.body));
  const withdrawn = await send({ actor: 'operator', operation: 'inbox.unpresent', payload: { inboxId: q.id, presentationId: 'shown-console', reason: 'Fictional operator took it down.' } });
  assert.equal(withdrawn.body.status, 'completed', JSON.stringify(withdrawn.body));
  // CLI: present, then the relayed answer with the delegation flags an orchestrator already uses.
  const cli = (...args) => spawnSync(process.execPath, [join(repo, 'starter/factory/cli.mjs'), 'command', '--state', f.stateDir, ...args], { encoding: 'utf8' });
  const shown = cli('--actor', 'orchestrator', '--operation', 'inbox.present', '--payload', JSON.stringify({ inboxId: q.id, expectedVersion: q.version, channel: CHANNEL }));
  assert.equal(shown.status, 0, shown.stderr + shown.stdout);
  const presentationId = JSON.parse(shown.stdout).result.presentation.id;
  const answered = cli('--actor', 'orchestrator', '--instruction', 'Fictional operator chose Layout B in the prompt.', '--reference', 'fictional-ask-1', '--operation', 'answer', '--payload', JSON.stringify({ inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'b', relay: { quote: 'Layout B', channel: CHANNEL }, presentationId }));
  assert.equal(answered.status, 0, answered.stderr + answered.stdout);
  const result = JSON.parse(answered.stdout).result;
  assert.equal(result.relay.relayedBy, 'orchestrator'); assert.equal(result.answeredBy, 'orchestrator');
  assert.deepEqual(item(f).presentations.map(p => p.status), ['withdrawn', 'answered']);
  const help = cli('--operation', 'inbox.present', '--help');
  assert.match(help.stdout, /external prompt channel/);
});

test('the console shows the prompt on the open item and the relay record on the answered item and in History', async t => {
  const f = sandbox(t), q = ok(f.command('inbox.publish', question));
  const shown = present(f).presentation;
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this._text = text; }
    append(...items) { this.children.push(...items.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false)); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(key, value) { this[key] = value; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? String(c)).join(''); }
    reportValidity() { return true; }
  }
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window', 'fetch'], old = Object.fromEntries(keys.map(k => [k, globalThis[k]])), storage = { getItem: () => null, setItem() {} };
  Object.assign(globalThis, { Node: Element, document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) }, localStorage: storage, sessionStorage: storage, window: { dispatchEvent() {}, confirm: () => true } });
  try {
    const { inboxView } = await import('../starter/factory/console/ui/inbox.mjs'), { state, uiState } = await import('../starter/factory/console/ui/state.mjs'), { recordDetail, eventDetail, eventLabel } = await import('../starter/factory/console/ui/records.mjs');
    const project = () => ({ projectId: f.project.projectId, bindingId: 'binding', name: 'Fictional', status: 'available', snapshot: snapshot(f.store) });
    const descendants = node => [node, ...node.children.flatMap(child => child instanceof Element ? descendants(child) : [])];
    const sent = [];
    globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'completed' }) }; };
    let current = project(); state.projects = [current];
    const open = inboxView(current, { params: {} });
    assert.match(open.textContent, /Also being asked on fictional-ask/); assert.match(open.textContent, /either settles both/);
    // The operator can take the prompt down from the item; the command names that exact presentation.
    for (const form of descendants(open).filter(n => n.tag === 'form')) { for (const field of descendants(form).filter(n => n.name)) field.value = 'Fictional reason'; await form.handlers.submit({ preventDefault() {} }); }
    const unpresent = sent.find(r => r.operation === 'inbox.unpresent');
    assert.equal(unpresent.actor, 'operator'); assert.deepEqual(unpresent.payload, { inboxId: q.id, presentationId: shown.id, reason: 'Fictional reason' });
    // Answered through the prompt.
    const quote = 'Layout B, the roomier one.';
    ok(as(f, 'answer', answerOf(f, q.id, { answer: 'b', relay: { quote, channel: CHANNEL }, presentationId: shown.id }), { onBehalfOf: instruction }));
    current = project(); state.projects = [current]; uiState('inbox', { filter: 'open' }).filter = 'all';
    const closed = inboxView(current, { params: {} });
    assert.match(closed.textContent, /Answered “Layout B”/); assert.match(closed.textContent, /by the orchestrator/);
    assert.match(closed.textContent, /Relayed answer/); assert.ok(closed.textContent.includes(quote)); assert.match(closed.textContent, /not as a direct operator answer/);
    assert.match(closed.textContent, /Prompt on fictional-ask .*: answered/);
    // History: the inbox record and the events.
    const detail = recordDetail('inbox', item(f), current);
    assert.match(detail.textContent, /Entered by the orchestrator, relaying words received on fictional-ask/); assert.ok(detail.textContent.includes(quote)); assert.match(detail.textContent, /fictional-ask: answered/);
    const answeredEvent = f.store.events(50).find(event => event.type === 'inbox.answered');
    assert.match(eventDetail(answeredEvent), /relayed by the orchestrator from fictional-ask/);
    assert.equal(eventLabel('inbox.presented'), 'Question shown on a prompt channel');
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});

test('migrated project: a decision card answered through the prompt follows the relayedAnswer rules; an informational question keeps the item record', async t => {
  const f = await migrated(t), sound = () => assert.deepEqual(auditAuthorityRecords(f.store), []);
  const rev = () => f.store.need('task', 'task-1').revision;
  const open = decisionId => ok(f.command('decision.open', { decisionId, taskId: 'task-1', expectedRevision: rev(), question: `Which storage format should fictional ${decisionId} use?`, choiceId: `choice-${decisionId}`, options: [{ id: 'json', label: 'Keep JSON' }, { id: 'yaml', label: 'Switch to YAML' }] }));
  const decision = decisionId => f.store.need('decisionObligation', decisionId);
  // Without a grant: the relay is kept for confirmation, the card and the decision stay open, the prompt is settled.
  const a = open('decision-a'), card = ok(f.command('decision.present', { decisionId: a.id, expectedDecisionVersion: 1 }));
  const shown = present(f, card.id).presentation, relay = { quote: 'Switch to YAML', channel: CHANNEL };
  const base = { inboxId: card.id, version: card.version, subjectDigest: card.subjectDigest, answer: 'yaml', relay, presentationId: shown.id };
  const { relay: _dropped, ...bare } = base;
  refused(as(f, 'answer', bare, { onBehalfOf: instruction }), /arrived through a presentation is relayed/);
  refused(f.command('answer', base), /the operator answers directly/);
  refused(as(f, 'answer', { ...base, relay: { ...relay, actor: 'operator' } }, { onBehalfOf: instruction }), /relay is \{quote, channel\}/);
  assert.equal(item(f, card.id).presentations[0].status, 'pending');
  const relayed = ok(as(f, 'answer', base, { onBehalfOf: instruction }));
  const record = f.store.need('relayedAnswer', relayed.relayedAnswerId);
  assert.equal(record.status, 'pending'); assert.equal(record.relayedBy, 'orchestrator'); assert.equal(record.quote, relay.quote); assert.equal(record.channel, CHANNEL);
  assert.equal(decision(a.id).status, 'unresolved', 'a relay settles no decision on its own');
  const kept = item(f, card.id);
  assert.equal(kept.status, 'open'); assert.equal(kept.relay, undefined, 'a decision card keeps the authority record, not the item record');
  assert.equal(kept.presentations[0].status, 'answered'); assert.equal(kept.presentations[0].relayedAnswerId, record.id);
  assert.deepEqual(relayed.presentations, kept.presentations);
  refused(as(f, 'answer', { ...base, version: kept.version }, { onBehalfOf: instruction }), /is answered/);
  sound();
  // The operator confirms the relay directly, as before.
  ok(f.command('decision.dispose', { decisionId: a.id, expectedDecisionVersion: 1, kind: 'answer', optionId: 'yaml', relayedAnswerId: record.id, rationale: 'Confirmed.' }));
  assert.equal(f.store.need('relayedAnswer', record.id).status, 'confirmed'); assert.equal(decision(a.id).status, 'resolved');
  // With an exact grant: the relayed answer settles the decision and the card; the prompt is answered.
  const b = open('decision-b'), o = decision(b.id);
  ok(f.command('grant.issue', { grantId: 'grant-b', expiresAt: new Date(Date.now() + 3600000).toISOString(), entries: [{ entryId: 'answer-b', operation: 'decision.dispose', disposition: 'answer', taskId: 'task-1', taskRevision: rev(), obligationId: o.id, obligationVersion: o.version, scopeDigest: o.scopeDigest, optionSetDigest: o.optionSetDigest, answers: [{ optionId: 'json', payloadDigest: o.options.find(x => x.id === 'json').payloadDigest }] }] }));
  const cardB = ok(f.command('decision.present', { decisionId: b.id, expectedDecisionVersion: 1 })), shownB = present(f, cardB.id).presentation;
  const granted = ok(as(f, 'answer', { inboxId: cardB.id, version: cardB.version, subjectDigest: cardB.subjectDigest, answer: 'json', relay: { quote: 'Keep JSON', channel: CHANNEL }, presentationId: shownB.id }, { authority: { grantId: 'grant-b', entryId: 'answer-b', expectedVersion: 1 } }));
  assert.equal(f.store.need('relayedAnswer', granted.relayedAnswerId).status, 'applied'); assert.equal(decision(b.id).status, 'resolved');
  assert.equal(item(f, cardB.id).status, 'answered'); assert.equal(item(f, cardB.id).presentations[0].status, 'answered');
  sound();
  // A card answered by the operator in the inbox obsoletes its prompt.
  const c = open('decision-c'), cardC = ok(f.command('decision.present', { decisionId: c.id, expectedDecisionVersion: 1 })); present(f, cardC.id);
  ok(f.command('answer', { inboxId: cardC.id, version: cardC.version, subjectDigest: cardC.subjectDigest, answer: 'json' }));
  assert.equal(item(f, cardC.id).presentations[0].status, 'obsolete'); assert.equal(decision(c.id).status, 'resolved');
  // An informational question on a migrated project keeps the item relay record.
  const info = ok(f.command('inbox.publish', { ...question, id: 'info', purpose: 'informational' })), shownInfo = present(f, info.id).presentation;
  const answered = ok(as(f, 'answer', answerOf(f, info.id, { answer: 'a', relay: { quote: 'Layout A', channel: CHANNEL }, presentationId: shownInfo.id }), { onBehalfOf: instruction }));
  assert.equal(answered.relay.relayedBy, 'orchestrator'); assert.equal(answered.relay.schemaVersion, 1); assert.equal(answered.presentations[0].status, 'answered');
  sound();
});

// Independent review fixes: the wake for an ended presentation is bound to the send that
// carries it, and keeps the delivery's earlier status however often it is replaced or retried.
const HOUR = 60 * MIN;
const deliveryOf = (f, inboxId, event = 'inbox.attention') => f.store.all('delivery').find(row => row.inboxId === inboxId && row.event === event);
const endAt = (f, shown) => { const at = Date.parse(shown.expiresAt) + 1000; f.store.tx(() => settlePresentations(f.store, { nowMs: at })); return at; };
const accepted = f => events(f, 'notification.delivery').filter(event => event.accepted).length;

test('a presentation that expires while a request is in flight still wakes its presenter: that request does not consume the wake', async t => {
  const f = notifying(t, 'essential'), q = ok(f.command('inbox.publish', { ...question, remind: 'never' })), start = Date.now();
  const shown = present(f, q.id, { expiryMs: 10 * MIN }).presentation;
  // The first delivery leaves while the prompt is up; the presentation expires before the endpoint replies.
  let expiry;
  f.during.push(() => { assert.equal(item(f).presentations[0].status, 'pending', 'the consumer of this request can still read the prompt as up'); expiry = endAt(f, shown); });
  await f.deliver(start + 1000);
  assert.equal(item(f).presentations[0].status, 'expired'); assert.equal(f.sent.length, 1);
  assert.equal(deliveryOf(f, q.id).presentationEnded?.id, shown.id, 'the wake recorded after the request left is still owed');
  assert.equal(deliveryOf(f, q.id).status, 'pending');
  await f.deliver(expiry); await f.deliver(expiry + 31 * MIN); await f.deliver(expiry + 5 * HOUR);
  assert.deepEqual(f.sent.map(body => [body.inboxId, body.event, body.version]), [[q.id, 'inbox.attention', q.version], [q.id, 'inbox.attention', q.version]], 'one wake after the request that left before the expiry, and no more');
  assert.equal(deliveryOf(f, q.id).status, 'delivered'); assert.equal(deliveryOf(f, q.id).presentationEnded, undefined);
  // The same during a reminder of a question that keeps reminding: one extra send, then the usual interval.
  const g = notifying(t, 'essential'), r = ok(g.command('inbox.publish', question)), began = Date.now();
  await g.deliver(began + 1000);
  const again = present(g, r.id, { expiryMs: 10 * MIN }).presentation; let ended;
  g.store.tx(() => { const row = deliveryOf(g, r.id); row.nextAt = new Date(began + 2000).toISOString(); row.status = 'pending'; g.store.put('delivery', row); }); // a retry is due while the prompt is up
  g.during.push(() => { ended = endAt(g, again); });
  await g.deliver(began + 3000); await g.deliver(ended); await g.deliver(ended + 1000);
  assert.equal(g.sent.length, 3); assert.equal(deliveryOf(g, r.id).status, 'accepted'); assert.equal(deliveryOf(g, r.id).presentationEnded, undefined);
  await g.deliver(ended + 31 * MIN);
  assert.equal(g.sent.length, 4, 'the ordinary reminder');
});

test('presentations that end again before the wake is delivered share one wake, and the orchestrator’s own question is quiet again', async t => {
  const f = notifying(t, 'essential'), own = ok(as(f, 'inbox.publish', { ...question, id: 'own' }));
  const first = present(f, own.id, { expiryMs: 10 * MIN }).presentation; f.queue();
  assert.equal(deliveryOf(f, own.id).status, 'suppressed');
  endAt(f, first);
  const second = present(f, own.id, { expiryMs: 10 * MIN }).presentation, ended = endAt(f, second);
  assert.deepEqual(deliveryOf(f, own.id).presentationEnded, { id: second.id, resume: 'suppressed' }, 'the second ending keeps what the delivery was before the first');
  await f.deliver(ended); await f.deliver(ended + 31 * MIN); await f.deliver(ended + 5 * HOUR);
  assert.deepEqual(f.sent.map(body => [body.inboxId, body.event]), [[own.id, 'inbox.attention']], 'one wake for both endings; never a reminder');
  assert.equal(deliveryOf(f, own.id).status, 'suppressed'); assert.equal(deliveryOf(f, own.id).presentationEnded, undefined);
  // A never-reminding question that was delivered: the same, back to delivered.
  const quiet = ok(f.command('inbox.publish', { ...question, id: 'quiet', remind: 'never' }));
  await f.deliver(ended + 6 * HOUR);
  assert.equal(deliveryOf(f, quiet.id).status, 'delivered');
  const a = present(f, quiet.id, { expiryMs: 10 * MIN }).presentation; endAt(f, a);
  const b = present(f, quiet.id, { expiryMs: 10 * MIN }).presentation, over = Math.max(endAt(f, b), ended + 7 * HOUR), before = f.sent.length;
  await f.deliver(over); await f.deliver(over + 31 * MIN); await f.deliver(over + 5 * HOUR);
  assert.deepEqual(f.sent.slice(before).map(body => body.inboxId), [quiet.id]);
  assert.equal(deliveryOf(f, quiet.id).status, 'delivered');
});

test('an expiry racing failed sends and their retries: the wake is kept until one request that carries it is accepted, exactly once', async t => {
  const f = notifying(t, 'essential'), own = ok(as(f, 'inbox.publish', { ...question, id: 'own' }));
  const first = present(f, own.id, { expiryMs: 10 * MIN }).presentation; f.queue();
  const one = endAt(f, first);
  // The wake's first request fails.
  f.during.push(() => ({ status: 503 }));
  await f.deliver(one);
  assert.equal(deliveryOf(f, own.id).status, 'pending'); assert.equal(deliveryOf(f, own.id).presentationEnded.resume, 'suppressed');
  // A second presentation expires before the retry: sent at once, not after the backoff.
  const second = present(f, own.id, { expiryMs: 10 * MIN }).presentation, two = endAt(f, second);
  assert.equal(Date.parse(deliveryOf(f, own.id).nextAt), two);
  // A third expires while that retry is in flight, and the retry fails too.
  let three;
  f.during.push(() => { const third = present(f, own.id, { expiryMs: 10 * MIN }).presentation; three = endAt(f, third); return { status: 503 }; });
  await f.deliver(two);
  assert.equal(f.sent.length, 2); assert.equal(accepted(f), 0);
  assert.deepEqual(item(f, own.id).presentations.map(row => row.status), ['expired', 'expired', 'expired']);
  await f.deliver(three + 10 * MIN); await f.deliver(three + 41 * MIN); await f.deliver(three + 5 * HOUR);
  assert.equal(f.sent.length, 3, 'two failed requests and the one that was accepted'); assert.equal(accepted(f), 1);
  assert.equal(deliveryOf(f, own.id).status, 'suppressed'); assert.equal(deliveryOf(f, own.id).presentationEnded, undefined);
});

test('a question resolved while a request is in flight: the presenter is told once, and a wake still owed moves to the resolution', async t => {
  // An inbox answer during the first delivery: that delivery is superseded and the resolution carries the wake.
  const f = notifying(t, 'essential'), q = ok(f.command('inbox.publish', question));
  present(f, q.id);
  f.during.push(() => { ok(f.command('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'a' })); });
  await f.deliver(Date.now() + 1000); await f.deliver(Date.now() + 2000); await f.deliver(Date.now() + 3000);
  assert.deepEqual(f.sent.map(body => [body.event, body.resolution ?? null]), [['inbox.attention', null], ['inbox.resolved', 'answered']]);
  assert.equal(item(f).presentations[0].status, 'obsolete'); assert.equal(deliveryOf(f, q.id).status, 'superseded');
  assert.equal(deliveryOf(f, q.id, 'inbox.resolved').presentationEnded, undefined);
  // An expiry wake whose request fails while the operator stops the flow: the superseded resolution is
  // filtered at this level, but the wake still owed is sent once with it.
  const g = notifying(t, 'actionable', { question: true }); g.start();
  const flowQuestion = await until(() => g.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open'), { tick: () => g.engine.tick() });
  await g.deliver(Date.now() + 1000);
  const shown = present(g, flowQuestion.id, { expiryMs: 10 * MIN }).presentation, ended = endAt(g, shown);
  g.during.push(() => { ok(g.command('stop', { flowId: 'flow-1', note: 'Fictional stop by the operator' })); return { status: 503 }; });
  await g.deliver(ended);
  assert.equal(g.store.need('inbox', flowQuestion.id).status, 'superseded');
  await g.deliver(ended + 1000); await g.deliver(ended + 31 * MIN); await g.deliver(ended + 5 * HOUR);
  assert.deepEqual(g.sent.filter(body => body.inboxId === flowQuestion.id).map(body => [body.event, body.resolution ?? null]), [['inbox.attention', null], ['inbox.attention', null], ['inbox.resolved', 'superseded']]);
  assert.equal(deliveryOf(g, flowQuestion.id).presentationEnded, undefined, 'handed on, not kept on the superseded delivery');
  const resolved = deliveryOf(g, flowQuestion.id, 'inbox.resolved');
  assert.equal(resolved.status, 'suppressed'); assert.equal(resolved.presentationEnded, undefined);
});

test('an acknowledgement neither consumes nor defers a wake that is still owed', async t => {
  // Acknowledged while the wake's own request is in flight: the wake is done when that request is accepted, and the question is quiet again.
  const f = notifying(t, 'essential'), own = ok(as(f, 'inbox.publish', { ...question, id: 'own' }));
  const shown = present(f, own.id, { expiryMs: 10 * MIN }).presentation; f.queue();
  const ended = endAt(f, shown);
  f.during.push(body => { ok(as(f, 'delivery.ack', { deliveryId: body.deliveryId })); });
  await f.deliver(ended); await f.deliver(ended + 31 * MIN); await f.deliver(ended + 5 * HOUR);
  assert.equal(f.sent.length, 1); assert.equal(deliveryOf(f, own.id).status, 'suppressed'); assert.equal(deliveryOf(f, own.id).presentationEnded, undefined);
  assert.ok(deliveryOf(f, own.id).acknowledgedAt);
  // A late acknowledgement of an earlier request, after the presentation expired: the wake is not put off for four hours.
  const g = notifying(t, 'essential'), q = ok(g.command('inbox.publish', question)), start = Date.now();
  await g.deliver(start + 1000);
  const prompt = present(g, q.id, { expiryMs: 10 * MIN }).presentation, over = endAt(g, prompt);
  ok(as(g, 'delivery.ack', { deliveryId: g.sent[0].deliveryId }));
  await g.deliver(over);
  assert.equal(g.sent.length, 2, 'the wake is sent when it is due'); assert.equal(deliveryOf(g, q.id).presentationEnded, undefined);
  // Without a wake owed, an acknowledgement defers reminders as before.
  ok(as(g, 'delivery.ack', { deliveryId: g.sent[0].deliveryId }));
  await g.deliver(over + 31 * MIN);
  assert.equal(g.sent.length, 2);
  // A resolution acknowledged while the request carrying its wake is in flight ends acknowledged, with nothing owed.
  const again = present(g, q.id).presentation;
  ok(g.command('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'a' }));
  assert.equal(deliveryOf(g, q.id, 'inbox.resolved').presentationEnded.id, again.id);
  g.during.push(body => { ok(as(g, 'delivery.ack', { deliveryId: body.deliveryId })); });
  await g.deliver(over + 5 * HOUR); await g.deliver(over + 6 * HOUR); await g.deliver(over + 11 * HOUR);
  assert.deepEqual(g.sent.slice(2).map(body => [body.event, body.resolution]), [['inbox.resolved', 'answered']]);
  assert.equal(deliveryOf(g, q.id, 'inbox.resolved').status, 'acknowledged'); assert.equal(deliveryOf(g, q.id, 'inbox.resolved').presentationEnded, undefined);
});

test('a process that stops with a request in flight: the next process sends the wake, and the late reply changes nothing', async t => {
  const f = notifying(t, 'essential'), q = ok(f.command('inbox.publish', { ...question, remind: 'never' })), start = Date.now();
  const shown = present(f, q.id, { expiryMs: 10 * MIN }).presentation;
  // The first process dispatches; the presentation expires; its request gets no reply yet.
  let reply, expiry; const held = new Promise(resolve => { reply = resolve; });
  f.during.push(() => { expiry = endAt(f, shown); return held; });
  const first = f.deliver(start + 1000);
  await until(() => f.sent.length === 1 && expiry);
  // A new process, after the send lease: it sends again, this time carrying the wake.
  const second = new Store(f.stateDir); t.after(() => second.close());
  assert.equal(deliveryOf({ store: second }, q.id).status, 'sending'); assert.equal(deliveryOf({ store: second }, q.id).presentationEnded.id, shown.id);
  await f.deliver(expiry, second);
  assert.equal(f.sent.length, 2); assert.equal(deliveryOf({ store: second }, q.id).status, 'delivered'); assert.equal(deliveryOf({ store: second }, q.id).presentationEnded, undefined);
  // The first request's reply arrives late: nothing is re-opened or sent again.
  reply({ status: 202 }); await first;
  const third = new Store(f.stateDir); t.after(() => third.close());
  await f.deliver(expiry + 31 * MIN, third); await f.deliver(expiry + 5 * HOUR, third);
  assert.equal(f.sent.length, 2); assert.equal(deliveryOf({ store: third }, q.id).status, 'delivered'); assert.equal(deliveryOf({ store: third }, q.id).presentationEnded, undefined);
});
