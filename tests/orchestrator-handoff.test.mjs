import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { deliverDue, queueDelivery } from '../starter/factory/operations/notifications.mjs';
import { admissionReasons } from '../starter/factory/operations/index.mjs';
import { observedStats } from '../starter/factory/operations/views.mjs';
import { orchestratorSessionView } from '../starter/factory/operations/orchestrator-session.mjs';

function fixture(t, notifications = {}, mode = 'delivery') {
  const f = sandbox(t);
  f.store.setMeta('config', { ...(mode === 'delivery' ? { mode: 'delivery', policy: {} } : {}), notifications: { handoffAfterDeliveries: 10, handoffRepeatDeliveries: 5, ...notifications } });
  const configPath = join(f.base, 'notifications.json');
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook', signingKey: 'fictional-signing-key' }), { mode: 0o600 });
  const sent = [];
  let status = 200, count = 0;
  const transport = async request => { sent.push(JSON.parse(request.payload)); return { status }; };
  // Real delivery path: publish notices, let maintenance queue them, then send what is due.
  const deliver = async (n, { actor = 'operator', store = f.store } = {}) => {
    for (let i = 0; i < n; i++) f.command('inbox.publish', { kind: 'notice', title: `Fictional notice ${++count}`, context: 'Fictional context' }, { actor });
    return flush(store);
  };
  // Rehearsal projects skip the maintenance queueing step, so queue the inbox the same way it does.
  const flush = async (store = f.store) => { await operationalTick(store); for (const item of store.all('inbox')) queueDelivery(store, { inboxId: item.id }); return deliverDue(store, { configPath, transport, limit: 200 }); };
  return { ...f, configPath, sent, deliver, flush, failNext: value => { status = value; } };
}
const handoffs = store => store.all('inbox').filter(item => item.orchestratorHandoff);

test('deliveries the endpoint accepted count per session and every payload carries the count and limit', async t => {
  const f = fixture(t);
  await f.deliver(3);
  assert.deepEqual(f.sent.map(body => [body.sessionDeliveries, body.sessionDeliveryLimit]), [[1, 10], [2, 10], [3, 10]]);
  assert.equal(orchestratorSessionView(f.store).deliveries, 3);
  // A refused send reached no session: not counted, and the retry carries the same ordinal.
  f.failNext(500); await f.deliver(1); f.failNext(200);
  assert.equal(orchestratorSessionView(f.store).deliveries, 3);
  assert.equal(f.sent.at(-1).sessionDeliveries, 4);
  const s = snapshot(f.store);
  assert.equal(s.orchestratorSession.deliveries, 3); assert.equal(s.orchestratorSession.limit, 10); assert.equal(s.orchestratorSession.declared, false);
  assert.equal(observedStats(f.store).orchestratorSession.deliveries, 3);
});

test('binding a different session resets the count; the same session or a stale version does not', async t => {
  const f = fixture(t);
  await f.deliver(2);
  const bound = f.command('orchestrator.session', { sessionId: 'session-a', expectedVersion: 0 }, { actor: 'orchestrator' });
  assert.equal(bound.status, 'completed', bound.error);
  assert.equal(bound.result.deliveries, 0); assert.equal(bound.result.version, 1); assert.equal(bound.result.sessionId, 'session-a');
  await f.deliver(2);
  assert.equal(f.command('orchestrator.session', { sessionId: 'session-a' }, { actor: 'orchestrator' }).result.deliveries, 2);
  assert.equal(f.command('orchestrator.session', { sessionId: 'session-b', expectedVersion: 0 }, { actor: 'orchestrator' }).status, 'rejected');
  assert.equal(f.command('orchestrator.session', { sessionId: 'not a valid id' }, { actor: 'orchestrator' }).status, 'rejected');
  const next = f.command('orchestrator.session', { sessionId: 'session-b', expectedVersion: 1 }).result;
  assert.equal(next.deliveries, 0); assert.equal(next.version, 2); assert.equal(next.boundBy, 'operator');
  await f.deliver(1);
  assert.equal(f.sent.at(-1).sessionDeliveries, 1);
});

test('the handoff question is raised once at the limit and re-raised only after the repeat interval', async t => {
  const f = fixture(t);
  f.command('orchestrator.session', { sessionId: 'session-a' }, { actor: 'orchestrator' });
  await f.deliver(9);
  assert.equal(handoffs(f.store).length, 0);
  await f.deliver(1);
  const [raised] = handoffs(f.store);
  assert.equal(raised.status, 'open'); assert.equal(raised.role, 'orchestrator'); assert.equal(raised.kind, 'question'); assert.equal(raised.version, 1); assert.equal(raised.remind, 'never');
  assert.match(raised.context, /received 10 notification deliveries/); assert.match(raised.context, /orchestrator\.session/);
  // With a triage proxy the webhook stays on the proxy; the text says so, and that handing off needs no answer.
  assert.match(raised.context, /If a triage proxy receives the notifications and forwards them to the bound session, leave the notification binding on the proxy/);
  assert.match(raised.context, /no need to answer it when handing off/);
  assert.deepEqual(raised.answers, ['handing-off', 'later']);
  // Its own wake is delivered once and counts; deliveries up to the interval do not raise it again.
  await f.deliver(3);
  assert.equal(f.sent.filter(body => body.inboxId === raised.id).length, 1);
  assert.equal(handoffs(f.store).length, 1); assert.equal(f.store.need('inbox', raised.id).version, 1);
  assert.equal(orchestratorSessionView(f.store).deliveries, 14);
  // Unanswered at limit + interval: one new version with the current count wakes the session again.
  await f.deliver(1);
  const again = f.store.need('inbox', raised.id);
  assert.equal(handoffs(f.store).length, 1); assert.equal(again.version, 2); assert.match(again.context, /received 15 notification deliveries/);
  await f.flush();
  assert.equal(f.sent.filter(body => body.inboxId === raised.id && body.version === 2).length, 1);
  assert.equal(f.store.events().filter(e => e.type === 'orchestrator.handoff-raised').length, 2);
});

test('answering clears the question quietly; a deferral returns only after the interval from the answer', async t => {
  const f = fixture(t);
  await f.deliver(10);
  const item = handoffs(f.store)[0];
  await f.deliver(2); // count 13 (the question's own wake included)
  const answered = f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'later' }, { actor: 'orchestrator' });
  assert.equal(answered.status, 'completed', answered.error);
  const sends = f.sent.length;
  await f.flush();
  // The orchestrator's own answer does not wake it at the default level.
  assert.equal(f.sent.length, sends);
  assert.equal(f.store.all('delivery').find(d => d.inboxId === item.id && d.inboxStatus === 'answered').status, 'suppressed');
  assert.equal(orchestratorSessionView(f.store).nextHandoffAt, 18);
  await f.deliver(4);
  assert.equal(handoffs(f.store).length, 1);
  await f.deliver(1);
  const fresh = handoffs(f.store).find(row => row.id !== item.id);
  assert.equal(fresh.status, 'open'); assert.equal(fresh.version, 1); assert.equal(f.store.need('inbox', item.id).status, 'answered');
  // The operator may also answer it.
  assert.equal(f.command('answer', { inboxId: fresh.id, version: fresh.version, subjectDigest: fresh.subjectDigest, answer: 'handing-off' }).status, 'completed');
});

test('binding a new session closes the open question without a wake and starts a new count', async t => {
  const f = fixture(t);
  f.command('orchestrator.session', { sessionId: 'session-a' }, { actor: 'orchestrator' });
  await f.deliver(10);
  const item = handoffs(f.store)[0];
  const bound = f.command('orchestrator.session', { sessionId: 'session-b' }, { actor: 'orchestrator' });
  assert.equal(bound.status, 'completed', bound.error);
  assert.equal(f.store.need('inbox', item.id).status, 'superseded');
  assert.equal(f.store.need('wait', `question:${item.id}`).reason, 'superseded');
  assert.equal(bound.result.deliveries, 0); assert.equal(bound.result.handoff, null); assert.equal(bound.result.nextHandoffAt, 10);
  const sends = f.sent.length;
  await f.flush();
  assert.equal(f.sent.length, sends, 'a superseded handoff question is not delivered at the default level');
  assert.equal(f.command('answer', { inboxId: item.id, version: 2, subjectDigest: item.subjectDigest, answer: 'later' }, { actor: 'orchestrator' }).status, 'rejected');
  await f.deliver(9);
  assert.equal(handoffs(f.store).filter(row => row.status === 'open').length, 0);
});

test('an open handoff question never holds admission or other deliveries', async t => {
  const f = fixture(t);
  const task = f.store.need('task', f.task.id);
  const before = admissionReasons(f.store, task);
  await f.deliver(10);
  assert.equal(handoffs(f.store)[0].status, 'open');
  assert.deepEqual(admissionReasons(f.store, f.store.need('task', f.task.id)), before);
  await f.deliver(2);
  assert.equal(f.sent.filter(body => !body.inboxId.startsWith('orchestrator-handoff:')).length, 12);
  // In a rehearsal project the same open question leaves flow.start untouched.
  const r = fixture(t, {}, 'rehearsal');
  await r.deliver(10);
  assert.equal(handoffs(r.store)[0].status, 'open');
  const started = r.start();
  assert.equal(started.status, 'completed', started.error);
});

test('quiet levels: suppressed deliveries are not sent and not counted', async t => {
  const f = fixture(t, { level: 'essential' });
  await f.deliver(2, { actor: 'orchestrator' });
  assert.equal(f.sent.length, 0);
  assert.equal(f.store.all('delivery').filter(d => d.status === 'suppressed').length, 2);
  assert.equal(orchestratorSessionView(f.store).deliveries, 0);
  await f.deliver(1);
  assert.equal(f.sent.at(-1).sessionDeliveries, 1);
  assert.equal(orchestratorSessionView(f.store).deliveries, 1);
});

test('the count, the raise and the binding survive a restart', async t => {
  const f = fixture(t);
  f.command('orchestrator.session', { sessionId: 'session-a' }, { actor: 'orchestrator' });
  await f.deliver(8);
  const reopened = new Store(f.stateDir); t.after(() => reopened.close());
  const view = orchestratorSessionView(reopened);
  assert.equal(view.sessionId, 'session-a'); assert.equal(view.deliveries, 8);
  await f.deliver(2, { store: reopened });
  assert.equal(handoffs(reopened).length, 1);
  const again = new Store(f.stateDir); t.after(() => again.close());
  assert.equal(orchestratorSessionView(again).handoff.raisedAtDeliveries, 10);
});

test('the limit is a validated live setting; 0 keeps counting without asking', async t => {
  // settings.update validates the whole configuration; a rehearsal project keeps the fixture small.
  const f = fixture(t, { handoffAfterDeliveries: undefined, handoffRepeatDeliveries: undefined }, 'rehearsal');
  assert.equal(orchestratorSessionView(f.store).limit, 100);
  assert.equal(orchestratorSessionView(f.store).repeatDeliveries, 25);
  const set = changes => f.command('settings.update', { changes, note: 'Fictional tuning' });
  for (const value of [5, 100001, 1.5, -1, '20']) assert.equal(set({ 'notifications.handoffAfterDeliveries': value }).status, 'rejected', String(value));
  for (const value of [4, 0]) assert.equal(set({ 'notifications.handoffRepeatDeliveries': value }).status, 'rejected', String(value));
  assert.equal(set({ 'notifications.handoffAfterDeliveries': 0 }).status, 'completed');
  await f.deliver(12);
  assert.equal(handoffs(f.store).length, 0);
  assert.equal(orchestratorSessionView(f.store).deliveries, 12);
  assert.equal(f.sent.at(-1).sessionDeliveryLimit, null);
  // Turning it back on at a limit already passed raises once, at the next delivery.
  assert.equal(set({ 'notifications.handoffAfterDeliveries': 10 }).status, 'completed');
  await f.deliver(1);
  assert.equal(handoffs(f.store).length, 1);
});

test('only the operator can change the handoff settings', async t => {
  const { sandbox } = await import('./helpers.mjs');
  const f = sandbox(t);
  const { executeCommand } = await import('../starter/factory/core/project.mjs'), { uid } = await import('../starter/factory/core/contracts.mjs');
  const delegated = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', onBehalfOf: { principal: 'operator', instruction: 'Fictional operator instruction' }, operation: 'settings.update', payload: { changes: { 'notifications.handoffAfterDeliveries': 0 }, note: 'Stop asking me to hand off' } });
  assert.equal(delegated.status, 'rejected'); assert.match(delegated.error, /can only be changed by the operator/);
  assert.equal(f.command('settings.update', { changes: { 'notifications.handoffAfterDeliveries': 200 }, note: 'Operator raises the limit' }).status, 'completed');
});

// A transport that holds each request until released, to interleave sends with other commands.
function heldTransport() {
  const held = [], waiters = [];
  const transport = request => new Promise(resolve => { held.push({ body: JSON.parse(request.payload), release: (status = 200) => resolve({ status }) }); waiters.splice(0).forEach(wake => wake()); });
  const until = async n => { while (held.length < n) await new Promise(resolve => waiters.push(resolve)); return held; };
  return { transport, held, until };
}
const publish = (f, n, actor = 'operator') => { for (let i = 0; i < n; i++) f.command('inbox.publish', { kind: 'notice', title: `Fictional held notice ${i}`, context: 'Fictional context' }, { actor }); };

test('an acceptance that arrives after a new session was bound counts for the session it was sent to', async t => {
  const f = fixture(t);
  f.command('orchestrator.session', { sessionId: 'session-a' }, { actor: 'orchestrator' });
  await f.deliver(2);
  publish(f, 1); await operationalTick(f.store);
  const hold = heldTransport();
  const sending = deliverDue(f.store, { configPath: f.configPath, transport: hold.transport, limit: 200 });
  const [request] = await hold.until(1);
  assert.equal(request.body.sessionDeliveries, 3);
  // The successor is bound while the request for session-a is in flight.
  assert.equal(f.command('orchestrator.session', { sessionId: 'session-b' }, { actor: 'orchestrator' }).status, 'completed');
  request.release(200); await sending;
  const view = orchestratorSessionView(f.store);
  assert.equal(view.sessionId, 'session-b'); assert.equal(view.deliveries, 0, 'the old session’s acceptance never reaches the new count');
  const reset = view.resets.recent.find(row => row.fromSessionId === 'session-a');
  assert.equal(reset.deliveries, 3); assert.equal(reset.lateAcceptances, 1);
  await f.deliver(1);
  assert.equal(f.sent.at(-1).sessionDeliveries, 1); assert.equal(orchestratorSessionView(f.store).deliveries, 1);
});

test('concurrent sends carry distinct ordered numbers; a retry keeps its number, the accepted count stays separate', async t => {
  const f = fixture(t);
  publish(f, 2); await operationalTick(f.store);
  const hold = heldTransport();
  // Two runners dispatch at once: each claims a different delivery before either response arrives.
  const first = deliverDue(f.store, { configPath: f.configPath, transport: hold.transport, limit: 1 });
  const second = deliverDue(f.store, { configPath: f.configPath, transport: hold.transport, limit: 1 });
  const [a, b] = await hold.until(2);
  assert.notEqual(a.body.deliveryId, b.body.deliveryId);
  assert.deepEqual([a.body.sessionDeliveries, b.body.sessionDeliveries], [1, 2]);
  // The second is refused, the first accepted: one accepted delivery, two numbers handed out.
  b.release(503); a.release(200); await Promise.all([first, second]);
  let view = orchestratorSessionView(f.store);
  assert.equal(view.deliveries, 1); assert.equal(view.dispatched, 2);
  // A third delivery is sent before the refused one is retried; the retry keeps number 2.
  publish(f, 1); await operationalTick(f.store);
  const third = deliverDue(f.store, { configPath: f.configPath, transport: hold.transport, limit: 1 });
  const [, , c] = await hold.until(3);
  assert.equal(c.body.sessionDeliveries, 3);
  const retry = deliverDue(f.store, { configPath: f.configPath, transport: hold.transport, limit: 8, nowMs: Date.now() + 120000 });
  const [, , , d] = await hold.until(4);
  assert.equal(d.body.deliveryId, b.body.deliveryId); assert.equal(d.body.sessionDeliveries, 2, 'a retry of the same delivery is not a new number');
  c.release(200); d.release(200); await Promise.all([third, retry]);
  view = orchestratorSessionView(f.store);
  assert.equal(view.deliveries, 3); assert.equal(view.dispatched, 3);
  // A retry after a new session was bound is that session's delivery and gets its number.
  publish(f, 1); await operationalTick(f.store);
  f.failNext(500); await f.flush(); f.failNext(200);
  const refused = f.sent.at(-1);
  assert.equal(refused.sessionDeliveries, 4);
  f.command('orchestrator.session', { sessionId: 'session-c' }, { actor: 'orchestrator' });
  await deliverDue(f.store, { configPath: f.configPath, transport: async request => { f.sent.push(JSON.parse(request.payload)); return { status: 200 }; }, limit: 8, nowMs: Date.now() + 120000 });
  assert.equal(f.sent.at(-1).deliveryId, refused.deliveryId); assert.equal(f.sent.at(-1).sessionDeliveries, 1);
  assert.equal(orchestratorSessionView(f.store).deliveries, 1);
});

test('session resets are recorded with the count they ended; unusually frequent resets notify the operator once', async t => {
  const f = fixture(t);
  await f.deliver(3);
  // Normal rebinding needs no operator authorization.
  for (const sessionId of ['session-a', 'session-b', 'session-c']) { assert.equal(f.command('orchestrator.session', { sessionId }, { actor: 'orchestrator' }).status, 'completed'); await f.deliver(2); }
  const notices = () => f.store.all('inbox').filter(item => item.id.startsWith('orchestrator-session-resets:'));
  assert.equal(notices().length, 0, 'three resets are not unusual');
  assert.equal(f.command('orchestrator.session', { sessionId: 'session-d' }, { actor: 'orchestrator' }).status, 'completed');
  const [notice] = notices();
  assert.equal(notice.role, 'operator'); assert.equal(notice.kind, 'notice'); assert.equal(notice.createdBy, 'factory');
  assert.match(notice.context, /last 4 orchestrator session resets ended sessions that together received 9 deliveries/);
  // Only the operator can acknowledge it: the orchestrator cannot silence a report about itself
  // before it is delivered (seen in re-check).
  const ack = f.command('inbox.ack', { inboxId: notice.id }, { actor: 'orchestrator' });
  assert.equal(ack.status, 'rejected'); assert.match(ack.error, /only the operator can acknowledge this notice/);
  assert.equal(f.store.need('inbox', notice.id).status, 'open');
  // Nor can a delivery acknowledgement postpone or settle its delivery.
  queueDelivery(f.store, { inboxId: notice.id });
  const pending = f.store.all('delivery').filter(row => row.inboxId === notice.id);
  assert.ok(pending.length > 0, 'the notice has a queued delivery');
  for (const row of pending) { const refused = f.command('delivery.ack', { deliveryId: row.id }, { actor: 'orchestrator' }); assert.equal(refused.status, 'rejected'); assert.match(refused.error, /only the operator can acknowledge delivery of this notice/); }
  // The notice is delivered (it is not the orchestrator's own action).
  await f.flush();
  assert.ok(f.sent.some(body => body.inboxId === notice.id));
  const view = snapshot(f.store).orchestratorSession;
  assert.equal(view.resets.last24h, 4); assert.ok(view.resets.lastNoticeAt);
  assert.deepEqual(view.resets.recent.map(row => [row.fromSessionId, row.toSessionId, row.deliveries]), [['session-c', 'session-d', 2], ['session-b', 'session-c', 2], ['session-a', 'session-b', 2], [null, 'session-a', 3]]);
  assert.equal(observedStats(f.store).orchestratorSession.resets.last24h, 4);
  // At most one notice a day.
  for (const sessionId of ['session-e', 'session-f', 'session-g', 'session-h']) f.command('orchestrator.session', { sessionId }, { actor: 'orchestrator' });
  assert.equal(notices().length, 1);
  assert.deepEqual(orchestratorSessionView(f.store).resets.recent.slice(0, 2).map(row => [row.fromSessionId, row.toSessionId, row.deliveries]), [['session-g', 'session-h', 0], ['session-f', 'session-g', 0]]);
  // The console Stats section shows the history.
  const textOf = await renderSection(view);
  assert.match(textOf, /Resets in 24 hours/); assert.match(textOf, /session-c → session-d by orchestrator · ended at 2 deliveries/); assert.match(textOf, /operator notified/);
});

// A minimal DOM, enough to render one console section to text.
async function renderSection(view) {
  class Node { constructor(text = '') { this.children = []; this.textContent = text; this.dataset = {}; this.style = { setProperty() {} }; } append(...nodes) { this.children.push(...nodes); } appendChild(node) { this.children.push(node); return node; } setAttribute() {} addEventListener() {} get text() { return [this.textContent, ...this.children.map(child => child.text)].join(' '); } }
  globalThis.Node = Node;
  globalThis.document = { createElement: () => new Node(), createTextNode: text => new Node(text), querySelector: () => ({ content: 'test-csrf' }) };
  globalThis.localStorage = globalThis.sessionStorage = { getItem: () => null, setItem() {} };
  globalThis.window ??= { addEventListener() {}, dispatchEvent() {} };
  const { orchestratorSessionSection } = await import('../starter/factory/console/ui/stats.mjs');
  return orchestratorSessionSection(view).text;
}
