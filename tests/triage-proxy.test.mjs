import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';
import { flowNotice } from '../starter/factory/core/project.mjs';
import { expireStandaloneQuestions } from '../starter/factory/core/communication.mjs';
import { deliverDue, queueDelivery, wakePresenterInTransaction } from '../starter/factory/operations/notifications.mjs';
import { placeRecoveryHold } from '../starter/factory/operations/recovery-hold.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import * as triage from '../starter/project/integrations/triage.example.mjs';
import { decide, normalizePayload, validatePayload, timerCheck, counts, digestText, runRecorded, confirmSent, acquireLock, releaseLock, withLock, readLockFile, verifyForward, forwardsSince, FORWARD_CHARS, BUDGET, CARRIED_HEADING as CARRIED, parseSince } from '../starter/project/integrations/triage.example.mjs';

// The triage proxy's starter rules, run against payloads made by the real notification code and
// the real narrow and compact reads, so a change to any of them shows here. The principle under
// test: the proxy is never the reason an item a person needs goes quiet.
const SCRIPT = fileURLToPath(new URL('../starter/project/integrations/triage.example.mjs', import.meta.url));
const MIN = 60000, head = 'a'.repeat(40);
function fixture(t, level = 'essential', extra = {}) {
  const f = sandbox(t), configPath = join(f.base, 'notifications.json'), sent = [];
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level, configPath, ...extra } });
  let clock = Date.now() + 1000;
  const deliver = async (advanceMs = 1000) => {
    clock += advanceMs;
    for (const row of f.store.all('inbox')) queueDelivery(f.store, { inboxId: row.id });
    const before = sent.length;
    await deliverDue(f.store, { configPath, nowMs: clock, limit: 100, transport: async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; } });
    return sent.slice(before);
  };
  const ok = (operation, payload, options) => { const r = f.command(operation, payload, options); assert.equal(r.status, 'completed', JSON.stringify(r)); return r.result; };
  const dir = mkdtempSync(join(tmpdir(), 'fct-triage-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { memoryPath: join(dir, 'state.json'), logPath: join(dir, 'log.jsonl'), statePath: join(dir, 'read.json') };
  // One recorded wake, as the proxy runs it: the narrow read to a file, then the script.
  const wake = (body, ids = body.inboxId ? { inbox: body.inboxId } : { task: body.taskId }) => {
    writeFileSync(files.statePath, JSON.stringify(stateView(f.store, ids)));
    return runRecorded('wake', { ...files, input: JSON.stringify(body), projectId: f.project.projectId });
  };
  return { ...f, sent, deliver, ok, projectId: f.project.projectId, view: ids => stateView(f.store, ids), dir, files, wake };
}
const question = { kind: 'question', title: 'Fictional choice', context: 'A fictional product choice.', question: 'Which fictional behaviour?', choices: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }] };
const only = (bodies, predicate = () => true) => { const rows = bodies.filter(predicate); assert.equal(rows.length, 1, JSON.stringify(bodies)); return rows[0]; };
function finish(f, flow, outcome = 'completed', reason = '') {
  f.store.tx(() => { f.store.put('flow', flow); f.store.event('flow.finished', { flowId: flow.id, outcome }); flowNotice(f.store, flow, outcome, reason); });
  return f.store.all('inbox').find(row => row.flowId === flow.id && row.kind === 'notice');
}
const change = (id, extra = {}) => ({ id, kind: 'change', taskId: 'task-1', taskRevision: 'revision', step: 'done', state: 'completed', results: { merge: { merged: true, expectedHead: head }, cleanup: { released: true } }, ...extra });
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '']); assert.equal(r.status, 0); return r.pid; };
const logOf = f => readFileSync(f.files.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('an open operator question is forwarded as a stand-alone message, and every reminder of it is forwarded again with no action', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  const first = f.wake(body);
  assert.equal(first.decision, 'forward'); assert.equal(first.rule, 'operator-question'); assert.deepEqual(first.actions, [], 'a forward acknowledges nothing');
  assert.equal(first.sendId, `${body.deliveryId}:1`, 'each forward of a delivery is its own send attempt (dev.85 review fix)');
  for (const text of [q.id, body.deliveryId, f.projectId, `v${q.version}`, 'Which fictional behaviour?', 'Option A (a)', 'Option B (b)', 'Do not answer it for them', `delivery.ack {"deliveryId":"${body.deliveryId}"}`, `session delivery ${body.sessionDeliveries}/`])
    assert.ok(first.forward.includes(text), `forward names ${text}:\n${first.forward}`);
  // Not confirmed as sent: the re-send is decided afresh.
  const reminder = only(await f.deliver(31 * MIN), b => b.inboxId === q.id);
  assert.equal(reminder.deliveryId, body.deliveryId, 'a reminder carries the same delivery id');
  assert.equal(f.wake(reminder).rule, 'operator-question');
  confirmSent(body.deliveryId, f.files);
  // Confirmed: still open, so each reminder is forwarded again and nothing is acknowledged.
  for (let n = 0; n < 3; n++) {
    const again = only(await f.deliver(31 * MIN), b => b.inboxId === q.id);
    const result = f.wake(again);
    assert.equal(result.decision, 'forward'); assert.equal(result.rule, 'reminder'); assert.deepEqual(result.actions, []);
    assert.match(result.forward, /still open/); assert.match(result.forward, /First forwarded /); assert.ok(result.forward.includes(q.id));
  }
  assert.equal(f.store.need('inbox', q.id).status, 'open');
  assert.equal(f.store.all('delivery').find(row => row.inboxId === q.id).acknowledgedAt, undefined, 'the proxy never acknowledged it');
});

test('a re-send is absorbed only once the narrow read shows the item closed', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  f.wake(body); confirmSent(body.deliveryId, f.files);
  f.ok('answer', { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest, answer: 'a' });
  // The old attention delivery arriving late: the item is answered, so it is stale.
  const stale = f.wake(body);
  assert.equal(stale.rule, 'stale-version'); assert.deepEqual(stale.actions, [{ operation: 'delivery.ack', payload: { deliveryId: body.deliveryId } }]);
  // The answer's resolution is forwarded once; its re-sends are absorbed without an ack, and forwarded again every fourth.
  const resolved = only(await f.deliver(), b => b.inboxId === q.id && b.event === 'inbox.resolved');
  assert.equal(f.wake(resolved).rule, 'answered'); confirmSent(resolved.deliveryId, f.files);
  const rules = [1, 2, 3, 4].map(() => f.wake(resolved));
  assert.deepEqual(rules.map(r => r.rule), ['resend-closed', 'resend-closed', 'resend-closed', 'resend']);
  assert.deepEqual(rules.map(r => r.actions.length), [0, 0, 0, 0], 'a re-send of a forward never proposes an ack');
});

test('resolutions: superseded, the orchestrator role\'s own and an operator-acknowledged notice are absorbed; answers, expiries and withdrawals by the operator are forwarded', async t => {
  const f = fixture(t, 'all');
  const notice = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional notice', context: 'Nothing to do.' });
  const mine = f.ok('inbox.publish', { ...question, id: 'withdrawn-by-orchestrator' }, { actor: 'orchestrator' });
  const theirs = f.ok('inbox.publish', { ...question, id: 'withdrawn-by-operator' });
  const answered = f.ok('inbox.publish', { ...question, id: 'answered-by-operator' });
  const expiring = f.ok('inbox.publish', { ...question, id: 'expiring', expiryMs: MIN });
  const replaced = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional replaced notice', context: 'Replaced.' });
  await f.deliver();
  f.ok('inbox.ack', { inboxId: notice.id });
  f.ok('inbox.withdraw', { inboxId: mine.id, expectedVersion: mine.version, reason: 'Fictional: no longer needed' }, { actor: 'orchestrator' });
  f.ok('inbox.withdraw', { inboxId: theirs.id, expectedVersion: theirs.version, reason: 'Fictional: operator withdrew it' });
  f.ok('answer', { inboxId: answered.id, version: answered.version, subjectDigest: answered.subjectDigest, answer: 'b', note: 'Fictional note' });
  f.store.tx(() => expireStandaloneQuestions(f.store, { nowMs: Date.now() + 2 * MIN }));
  f.store.tx(() => { const item = f.store.need('inbox', replaced.id); Object.assign(item, { status: 'superseded', supersededBy: 'factory', version: item.version + 1 }); f.store.put('inbox', item); });
  const bodies = (await f.deliver(3 * MIN)).filter(b => b.event === 'inbox.resolved');
  const rule = id => decide({ payload: only(bodies, b => b.inboxId === id), state: f.view({ inbox: id }) }, { projectId: f.projectId });
  assert.equal(rule(notice.id).rule, 'operator-acknowledged-notice');
  assert.equal(rule(mine.id).rule, 'own-resolution');
  assert.equal(rule(replaced.id).rule, 'superseded-resolution');
  assert.equal(rule(theirs.id).rule, 'withdrawn');
  const answer = rule(answered.id);
  assert.equal(answer.rule, 'answered'); assert.match(answer.forward, /answer b by operator/); assert.match(answer.forward, /Fictional note/);
  assert.equal(rule(expiring.id).rule, 'expired');
  assert.equal(decide({ payload: only(bodies, b => b.inboxId === replaced.id) }).decision, 'absorb', 'payload-only rules hold without a read');
});

test('flow notices: failed and stopped are forwarded; a clean completion is absorbed only when the project opts in', async t => {
  const f = fixture(t);
  const failed = finish(f, change('flow-failed', { state: 'failed', results: { gate: { route: 'fail', checks: [{ id: 'unit', status: 'failed' }] } } }), 'failed', 'Fictional gate failure');
  const stopped = finish(f, change('flow-stopped', { state: 'stopped', stopReason: 'Fictional operator stop' }), 'stopped', 'Fictional operator stop');
  const clean = finish(f, change('flow-clean'));
  const findings = finish(f, change('flow-findings', { results: { ...change('x').results, review: { route: 'pass', result: { verdict: 'pass', findings: [{ severity: 'low', file: 'a.js', line: 1, message: 'Fictional finding' }] } } } }));
  const bodies = await f.deliver();
  const run = (item, options = {}) => decide({ payload: only(bodies, b => b.inboxId === item.id), state: f.view({ inbox: item.id }) }, { projectId: f.projectId, ...options });
  for (const item of [failed, stopped]) {
    const result = run(item, { absorbCleanCompletions: true });
    assert.equal(result.rule, 'flow-notice'); assert.ok(result.forward.includes(item.flowId)); assert.ok(result.forward.includes('Fictional'));
  }
  assert.equal(run(clean).decision, 'forward', 'off by default: actionable does this with the stronger core check');
  const absorbed = run(clean, { absorbCleanCompletions: true });
  assert.equal(absorbed.rule, 'clean-completion');
  assert.deepEqual(absorbed.actions.map(a => a.operation), ['delivery.ack', 'inbox.ack']);
  assert.equal(run(findings, { absorbCleanCompletions: true }).decision, 'forward', 'a completion with findings is never absorbed');
});

test('operator notices, handoff questions and presentation-end wakes are always forwarded, to the bound session', async t => {
  const f = fixture(t, 'essential', { handoffAfterDeliveries: 10 });
  f.store.setMeta('orchestratorSession', { version: 1, sessionId: 'fictional-main-thread', boundAt: new Date().toISOString(), boundBy: 'orchestrator', deliveries: 9, dispatched: 9, lastDeliveryAt: null, handoff: null });
  const notice = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional operator notice', context: 'For the operator.' });
  const first = await f.deliver();
  const operatorNotice = decide({ payload: only(first, b => b.inboxId === notice.id), state: f.view({ inbox: notice.id }) }, { projectId: f.projectId });
  assert.equal(operatorNotice.rule, 'operator-notice'); assert.match(operatorNotice.forward, /Do not inbox\.ack it/);
  const handoff = f.store.all('inbox').find(row => row.orchestratorHandoff);
  assert.ok(handoff, 'the tenth accepted delivery raised the handoff question');
  const handoffBody = only(await f.deliver(), b => b.inboxId === handoff.id);
  const state = f.view({ inbox: handoff.id });
  assert.equal(state.project.session.sessionId, 'fictional-main-thread', 'the narrow read names the bound orchestrator session');
  const result = decide({ payload: handoffBody, state }, { projectId: f.projectId });
  assert.equal(result.rule, 'handoff'); assert.equal(result.forwardTo, 'fictional-main-thread');
  assert.match(result.forward, /webhook stays on the triage proxy/);
  assert.equal(decide({ payload: handoffBody }, { projectId: f.projectId }).forwardTo, null, 'no read and no remembered thread: the proxy must find it');
  assert.equal(decide({ payload: handoffBody, memory: { mainThreadId: 'remembered-thread' } }).forwardTo, 'remembered-thread');
  const q = f.ok('inbox.publish', question);
  const qBody = only(await f.deliver(), b => b.inboxId === q.id);
  const shown = f.ok('inbox.present', { inboxId: q.id, expectedVersion: q.version, channel: 't3-ask', expiryMs: MIN }, { actor: 'orchestrator' }).presentation;
  f.store.tx(() => wakePresenterInTransaction(f.store, f.store.need('inbox', q.id), shown));
  const wake = only(await f.deliver(), b => b.inboxId === q.id);
  assert.equal(wake.presentationEnded, true); assert.equal(wake.deliveryId, qBody.deliveryId);
  assert.equal(decide({ payload: wake, state: f.view({ inbox: q.id }), memory: { deliveries: { [wake.deliveryId]: { decision: 'forward', sent: true } } } }).rule, 'presentation-ended');
});

test('state events: an approval already queued is absorbed; a revocation is re-checked, then forwarded or absorbed if restored; re-sends are forwarded; ruleless known events are unsure', async t => {
  const f = fixture(t, 'all');
  f.ok('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision });
  const approved = only(await f.deliver(), b => b.kind === 'state' && b.event === 'task.approved');
  assert.equal(decide({ payload: approved, state: f.view({ task: f.task.id }) }, { projectId: f.projectId }).rule, 'approval');
  f.ok('queue.put', { taskIds: [f.task.id] });
  assert.equal(decide({ payload: approved, state: f.view({ task: f.task.id }) }, { projectId: f.projectId }).rule, 'approval-queued');
  f.ok('task.revoke', { taskId: f.task.id, note: 'Fictional revocation' });
  const revoked = only(await f.deliver(), b => b.kind === 'state' && b.event === 'task.revoked');
  const first = f.wake(revoked);
  assert.equal(first.decision, 'recheck'); assert.equal(first.delaySeconds, 60); assert.deepEqual(first.actions, []); assert.equal(first.forward, null);
  assert.throws(() => confirmSent(revoked.deliveryId, f.files), /no pending forward/, 'a re-check is not a forward');
  const result = f.wake(revoked);
  assert.equal(result.rule, 'approval-revoked'); assert.ok(result.forward.includes(f.task.id)); assert.match(result.forward, /Re-checked after 60 s/);
  confirmSent(revoked.deliveryId, f.files);
  const again = f.wake(revoked);
  assert.equal(again.rule, 'resend'); assert.deepEqual(again.actions, [], 'a state re-send is forwarded, never acknowledged by the proxy');
  // Revoked by an edit, then approved again before the re-check: absorbed.
  f.ok('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision });
  f.ok('task.revoke', { taskId: f.task.id, note: 'Fictional second revocation' });
  const second = only(await f.deliver(), b => b.kind === 'state' && b.event === 'task.revoked' && b.deliveryId !== revoked.deliveryId);
  assert.equal(f.wake(second).decision, 'recheck');
  f.ok('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision });
  const restored = f.wake(second);
  assert.equal(restored.rule, 'approval-restored'); assert.deepEqual(restored.actions, [{ operation: 'delivery.ack', payload: { deliveryId: second.deliveryId } }]);
  const admitted = { ...revoked, event: 'flow.admitted', flowId: 'flow-1', deliveryId: 'fictional-admitted' };
  const unsure = decide({ payload: admitted });
  assert.equal(unsure.decision, 'unsure'); assert.deepEqual(unsure.actions, []); assert.ok(unsure.forward.includes('fictional-admitted'));
});

test('malformed and unknown input is forwarded with no actions and never throws', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const body = only(await f.deliver(), b => b.inboxId === q.id), state = f.view({ inbox: q.id });
  const cases = {
    'superseded without inbox id or version': { projectId: 'fictional', deliveryId: 'd', kind: 'inbox', event: 'inbox.resolved', resolution: 'superseded' },
    'unknown resolution by the orchestrator': { projectId: 'fictional', deliveryId: 'd', kind: 'inbox', event: 'inbox.resolved', inboxId: 'x', version: 2, status: 'superseded', resolution: 'vanished', actor: 'orchestrator' },
    'object-valued version': { projectId: 'fictional', deliveryId: 'd', kind: 'inbox', event: 'inbox.resolved', inboxId: 'x', version: { toString: 1 }, status: 'superseded', resolution: 'superseded' },
    'resolution that disagrees with status': { projectId: 'fictional', deliveryId: 'd', kind: 'inbox', event: 'inbox.resolved', inboxId: 'x', version: 2, status: 'answered', resolution: 'superseded' },
    'attention with a resolution': { ...body, resolution: 'superseded' },
    'unknown kind': { ...body, kind: 'fictional' },
    'unknown inbox event': { ...body, event: 'inbox.fictional' },
    'unknown state event': { projectId: 'fictional', deliveryId: 'd', kind: 'state', event: 'flow.fictional', eventSequence: 3, taskId: 't' },
    'state without a task': { projectId: 'fictional', deliveryId: 'd', kind: 'state', event: 'task.approved', eventSequence: 3 },
    'state event with an unknown resolution': { projectId: 'fictional', deliveryId: 'd', kind: 'state', event: 'task.approved', eventSequence: 3, taskId: 't', taskRevision: 'r', resolution: 'future-resolution' },
    'state event with an inbox status': { projectId: 'fictional', deliveryId: 'd', kind: 'state', event: 'task.approved', eventSequence: 3, taskId: 't', status: 'open' },
    'shell text in an id': { ...body, inboxId: "x'; rm -rf /" },
    'array': [body], 'null': null, 'string': 'fictional',
  };
  for (const [name, payload] of Object.entries(cases)) {
    let result; assert.doesNotThrow(() => { result = decide({ payload, state }); }, name);
    assert.equal(result.decision, 'forward', name); assert.deepEqual(result.actions, [], name);
    assert.ok(validatePayload(normalizePayload(payload)) !== null, `${name} fails validation`);
  }
  assert.doesNotMatch(decide({ payload: cases['shell text in an id'], state }).forward, /rm -rf/, 'an unreadable payload is not repeated');
  assert.equal(decide({ payload: body, state }, { projectId: 'another-project' }).rule, 'invalid-payload');
  assert.equal(validatePayload(normalizePayload(body)), null, 'the real payload passes');
  // Payloads grow additively: unknown fields are ignored, known fields from the other kind are checked, not refused.
  for (const extra of [{ fictional: 'x' }, { fictionalNested: { a: 1 } }, { taskId: 'task-1' }]) {
    assert.equal(validatePayload(normalizePayload({ ...body, ...extra })), null, JSON.stringify(extra));
    assert.equal(decide({ payload: { ...body, ...extra }, state }).rule, decide({ payload: body, state }).rule, JSON.stringify(extra));
  }
  assert.equal(decide({ payload: { ...body, taskId: 'bad id!' }, state }).rule, 'invalid-payload', 'a known field is still checked');
  const { kind, ...withoutKind } = body; void kind;
  assert.equal(decide({ payload: withoutKind, state }).rule, 'operator-question', 'an older payload without kind is an inbox payload');
  // Odd shapes of state never throw and never absorb an open item.
  for (const odd of [{ item: 'x' }, { item: { id: q.id } }, { item: { id: q.id, version: '1', status: 'open' } }, [], 7]) {
    const result = decide({ payload: body, state: odd });
    assert.equal(result.decision, 'forward', JSON.stringify(odd)); assert.deepEqual(result.actions, []);
  }
  // The proxy's webhook prompt renders every field as text, and absent ones as empty text.
  const rendered = Object.fromEntries(['projectId', 'deliveryId', 'kind', 'event', 'status', 'inboxId', 'version', 'resolution', 'actor', 'presentationEnded', 'presentationId', 'taskId', 'flowId', 'eventSequence', 'taskRevision', 'approvalVersion', 'sessionVersion', 'sessionDeliveries', 'sessionDeliveryLimit', 'observedAt']
    .map(key => [key, body[key] === undefined ? '' : String(body[key])]));
  assert.deepEqual(normalizePayload(rendered), normalizePayload(body));
  assert.equal(decide({ payload: rendered, state }).rule, decide({ payload: body, state }).rule);
});

test('timer checks over the real compact view: the first run reports what is wrong, every hold kind and fault identity is compared', async t => {
  const f = fixture(t), now = Date.now();
  const compact = () => JSON.parse(JSON.stringify(dashboardSnapshot(f.store)));
  for (const bad of [null, {}, { flows: {} }, { snapshotView: 'dashboard-v1', projectId: 'p', flows: {} }, [], 'x']) {
    let r; assert.doesNotThrow(() => { r = timerCheck(bad, {}, { nowMs: now }); }, JSON.stringify(bad));
    assert.equal(r.decision, 'forward', JSON.stringify(bad)); assert.equal(r.rule, 'timer-unreadable');
  }
  let r = timerCheck(compact(), {}, { nowMs: now });
  assert.equal(r.decision, 'absorb', 'a healthy first run is quiet');
  let memory = { timer: r.timer };
  // A recovery hold already in place on the first run is reported, not baselined.
  f.store.tx(() => placeRecoveryHold(f.store, { cause: 'operations-fault', error: 'fictional fault' }));
  const first = timerCheck(compact(), {}, { nowMs: now });
  assert.equal(first.decision, 'forward'); assert.match(first.forward, /first run/); assert.match(first.forward, /Recovery hold: operations-fault/);
  // Retention, money, provider, spending, commissioning, notification and main health conditions.
  f.store.tx(() => {
    f.store.setMeta('retentionHold', { operationId: 'retention-1' }); f.store.setMeta('moneyHold', true);
    f.store.setMeta('notificationHealth', { status: 'paused', problem: 'not a private 0600 file', since: new Date().toISOString() });
    f.store.setMeta('operationsFault', { error: 'fictional fault one', since: '2026-11-15T10:00:00.000Z' });
    f.store.setMeta('mainHealth', { status: 'red', head });
  });
  r = timerCheck(compact(), memory, { nowMs: now + MIN });
  assert.equal(r.decision, 'forward');
  for (const text of [/Recovery hold/, /retention/, /money/, /Notification delivery paused/, /fictional fault one/, /Main health is red/]) assert.match(r.forward, text);
  memory = { timer: r.timer };
  assert.equal(timerCheck(compact(), memory, { nowMs: now + 2 * MIN }).decision, 'absorb', 'unchanged conditions are reported once');
  // A different fault is a new condition, though a fault was already present.
  f.store.tx(() => f.store.setMeta('operationsFault', { error: 'fictional fault two', since: '2026-11-15T11:00:00.000Z' }));
  r = timerCheck(compact(), memory, { nowMs: now + 3 * MIN });
  assert.equal(r.decision, 'forward'); assert.match(r.forward, /Raised: Operations fault .*fictional fault two/); assert.match(r.forward, /Cleared: Operations fault .*fictional fault one/);
});

test('timer findings and digests count as reported only once --sent confirms them', async t => {
  const f = fixture(t), compact = () => JSON.stringify(dashboardSnapshot(f.store)), now = Date.now();
  const timer = nowMs => runRecorded('timer', { ...f.files, input: compact(), nowMs });
  assert.equal(timer(now).decision, 'absorb', 'healthy baseline');
  f.store.tx(() => placeRecoveryHold(f.store, { cause: 'operations-fault', error: 'fictional fault' }));
  const found = timer(now + MIN);
  assert.equal(found.decision, 'forward'); assert.match(found.sendId, /^timer:/);
  // Not sent: the next unchanged run reports it again.
  const again = timer(now + 2 * MIN);
  assert.equal(again.decision, 'forward'); assert.match(again.forward, /Recovery hold/);
  assert.throws(() => confirmSent(found.sendId, f.files), /no pending forward/, 'a superseded finding cannot be confirmed');
  confirmSent(again.sendId, f.files);
  assert.equal(timer(now + 3 * MIN).decision, 'absorb', 'confirmed: reported once');
  // Digest: generating it does not consume it.
  const q = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional dismissed notice', context: 'Dismissed.' });
  await f.deliver(); f.ok('inbox.ack', { inboxId: q.id });
  const resolved = only(await f.deliver(), b => b.inboxId === q.id && b.event === 'inbox.resolved');
  assert.equal(f.wake(resolved).rule, 'operator-acknowledged-notice');
  const digest = runRecorded('digest', { ...f.files, input: '' });
  assert.equal(digest.decision, 'forward'); assert.ok(digest.forward.includes(q.id));
  const digestAgain = runRecorded('digest', { ...f.files, input: '' });
  assert.equal(digestAgain.decision, 'forward', 'an unconfirmed digest is produced again');
  confirmSent(digestAgain.sendId, f.files);
  assert.equal(runRecorded('digest', { ...f.files, input: '' }).decision, 'absorb', 'confirmed: nothing new');
});

test('a flow stalled at the same step and attempt is reported once, after confirmation', () => {
  const base = { snapshotView: 'dashboard-v1', projectId: 'fictional', paused: false, recoveryHold: false, health: { notifications: null, operationsFault: null }, mainHealth: { status: 'green' } };
  const view = state => ({ ...base, flows: [{ id: 'flow-1', taskId: 'task-1', state, step: state === 'waiting' ? 'decision' : 'build', attemptId: 'attempt-1' }] });
  const now = Date.parse('2026-11-15T10:00:00Z');
  let r = timerCheck(view('running'), {}, { nowMs: now }), memory = { timer: r.timer };
  r = timerCheck(view('running'), memory, { nowMs: now + 121 * MIN });
  assert.equal(r.rule, 'timer-stall'); assert.match(r.forward, /flow flow-1 \(task task-1\) running at step build/);
  assert.equal(timerCheck(view('running'), memory, { nowMs: now + 150 * MIN }).rule, 'timer-stall', 'not confirmed: reported again');
  memory = { timer: r.timer };
  assert.equal(timerCheck(view('running'), memory, { nowMs: now + 180 * MIN }).decision, 'absorb', 'confirmed: once');
  assert.equal(timerCheck(view('waiting'), {}, { nowMs: now }).decision, 'absorb', 'a flow waiting on a question is not a stall');
});

test('the command line serialises concurrent runs and recovers from a corrupt state file and a stale lock', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: q.id })));
  // dev.89 (M4): a reset publishes an operator notice, through --factory-state.
  const args = ['--project', f.projectId, '--state', f.files.statePath, '--memory', f.files.memoryPath, '--log', f.files.logPath, '--factory-state', f.stateDir];
  const run = (extra, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...extra, '--protocol', '90'], { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
    child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}: ${err}`)));
    child.stdin.end(input);
  });
  const results = await Promise.all(Array.from({ length: 60 }, (_, i) => run(args, JSON.stringify({ ...body, deliveryId: `fictional-delivery-${i}` }))));
  assert.ok(results.every(r => r.decision === 'forward' && r.rule === 'operator-question'));
  const memory = JSON.parse(readFileSync(f.files.memoryPath, 'utf8'));
  assert.equal(Object.keys(memory.deliveries).length, 60, 'every run was remembered');
  assert.equal(logOf(f).length, 60, 'every run was logged');
  assert.deepEqual(readdirSync(f.dir).filter(name => name.endsWith('.tmp') || name.endsWith('.lock')), [], 'no temporary or lock file left');
  // A stale lock (its holder gone, old) is taken over.
  writeFileSync(`${f.files.logPath}.lock`, JSON.stringify({ host: hostname(), pid: deadPid(), token: 'abandoned' })); utimesSync(`${f.files.logPath}.lock`, new Date(0), new Date(0));
  assert.equal((await run(args, JSON.stringify(body))).rule, 'operator-question');
  // A corrupt state file: forwarded with a note, kept aside, and a fresh state written.
  writeFileSync(f.files.memoryPath, '{ not json');
  const reset = await run(args, JSON.stringify(body));
  assert.equal(reset.decision, 'forward'); assert.equal(reset.rule, 'state-reset'); assert.deepEqual(reset.actions, []);
  assert.match(reset.forward, /could not be read and was reset/); assert.equal(reset.stateResetNotice?.[0]?.published, true);
  assert.ok(readdirSync(f.dir).some(name => name.startsWith('state.json.corrupt-')), 'the corrupt copy is kept');
  assert.ok(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).deliveries[body.deliveryId], 'a fresh state was written');
  // Garbage on stdin still yields a decision.
  const garbage = await run(args, 'not json at all');
  assert.equal(garbage.decision, 'forward'); assert.deepEqual(garbage.actions, []);
  assert.ok(existsSync(f.files.memoryPath));
});

test('counts, misses and the digest read the log the orchestrator can see', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), n = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional dismissed notice', context: 'Dismissed.' });
  await f.deliver(); f.ok('inbox.ack', { inboxId: n.id });
  const bodies = await f.deliver(), qBody = f.sent.find(b => b.inboxId === q.id), nBody = only(bodies, b => b.inboxId === n.id);
  f.wake(qBody); confirmSent(qBody.deliveryId, f.files);
  assert.equal(f.wake(nBody).rule, 'operator-acknowledged-notice');
  const cli = args => { const r = spawnSync(process.execPath, [SCRIPT, ...args, '--protocol', '90'], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  cli(['--missed', '--log', f.files.logPath, '--note', 'Fictional: needed the dismissed notice', '--ref', n.id]);
  assert.deepEqual(cli(['--counts', '--log', f.files.logPath]), { forwarded: 1, unconfirmed: 0, absorbed: 1, unsure: 0, rechecks: 0, missed: 1, undelivered: 0, received: 0, lookups: 0, sendFailures: 0, escalations: 0, obsolete: 0, handled: 0, timerRuns: 0, byRule: { 'operator-question': 1, 'operator-acknowledged-notice': 1 } });
  const entries = logOf(f);
  assert.equal(counts(entries).absorbed, 1); assert.equal(digestText([], null), null);
  assert.match(digestText(entries, null), /absorbed 1, forwarded 1, unsure 0, missed 1/);
});

// ---- round 2 of the independent review --------------------------------------------------------

test('the lock is never taken over on age, and only from an owner on this host that has exited', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fct-lock-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'log.jsonl'), lock = `${path}.lock`;
  // A live owner whose lock is days old: never taken over.
  writeFileSync(lock, JSON.stringify({ host: hostname(), pid: process.pid, token: 'live-owner' })); utimesSync(lock, new Date(0), new Date(0));
  let entered = false;
  assert.throws(() => withLock(path, () => { entered = true; }, { waitMs: 150 }), /timed out/);
  assert.equal(entered, false); assert.equal(readLockFile(lock).token, 'live-owner');
  // An exited owner on another host, and an unreadable lock: never taken over either.
  for (const content of [JSON.stringify({ host: 'another-host', pid: deadPid(), token: 'elsewhere' }), 'not json']) {
    writeFileSync(lock, content);
    assert.throws(() => withLock(path, () => { entered = true; }, { waitMs: 100 }), /timed out/);
    assert.equal(entered, false);
  }
  // An exited owner on this host: taken over.
  writeFileSync(lock, JSON.stringify({ host: hostname(), pid: deadPid(), token: 'abandoned' }));
  assert.equal(withLock(path, () => 'entered', { waitMs: 1000 }), 'entered');
  assert.equal(existsSync(lock), false, 'released');
  assert.deepEqual(readdirSync(dir), [], 'no temporary or takeover file left');
});

test('a waiter that inspected an abandoned lock never removes the lock of the owner that replaced it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fct-lock-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'log.jsonl'), lock = `${path}.lock`;
  writeFileSync(lock, JSON.stringify({ host: hostname(), pid: deadPid(), token: 'abandoned' }));
  // Waiter A inspects the abandoned lock; before it acts, waiter B takes it over and now owns it.
  let bToken = null;
  const hooks = { afterInspect: seen => { if (!bToken && seen?.token === 'abandoned') bToken = acquireLock(path, { waitMs: 1000 }); } };
  assert.throws(() => acquireLock(path, { waitMs: 200, hooks }), /timed out/, 'A waits: the lock now has a live owner');
  assert.ok(bToken); assert.equal(readLockFile(lock).token, bToken, "B's lock survived A's takeover attempt");
  releaseLock(path, bToken);
  const aToken = acquireLock(path, { waitMs: 1000 });
  assert.equal(readLockFile(lock).token, aToken); releaseLock(path, aToken);
});

test('takeovers are serialised, and release removes only the caller\'s own lock', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fct-lock-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'log.jsonl'), lock = `${path}.lock`;
  writeFileSync(lock, JSON.stringify({ host: hostname(), pid: deadPid(), token: 'abandoned' }));
  // While A holds the takeover lock, C also finds the abandoned lock: C cannot take over and does not enter.
  let cResult = null;
  const hooks = { underTakeover: () => { try { acquireLock(path, { waitMs: 0 }); cResult = 'entered'; } catch (error) { cResult = error.message; } } };
  const aToken = acquireLock(path, { waitMs: 1000, hooks });
  assert.match(cResult, /timed out/); assert.equal(readLockFile(lock).token, aToken);
  // Someone else's lock in place at release time (it cannot happen through acquireLock): left alone.
  writeFileSync(lock, JSON.stringify({ host: hostname(), pid: process.pid, token: 'someone-else' }));
  releaseLock(path, aToken);
  assert.equal(readLockFile(lock).token, 'someone-else');
});

test('main holds are forwarded unless a verification in progress will clear them; merges in progress stay quiet', async t => {
  const f = fixture(t);
  const config = f.store.meta('config');
  f.store.setMeta('config', { ...config, mode: 'delivery', repository: { ...(config.repository ?? {}), target: 'main' }, policy: { ...(config.policy ?? {}), autoQueue: false } });
  f.store.setMeta('catalog', { workflows: { secondary: { target: 'next' } } });
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', { status: 'green', head, checkedAt: new Date().toISOString() });
  f.store.setMeta('targetHealth', { next: { status: 'green', head, checkedAt: new Date().toISOString(), target: 'next' } });
  const compact = () => JSON.parse(JSON.stringify(dashboardSnapshot(f.store))), now = Date.now();
  let r = timerCheck(compact(), {}, { nowMs: now });
  assert.equal(r.decision, 'absorb', JSON.stringify(r.findings)); const memory = { timer: r.timer };
  // Repro 1: the secondary target is red. The queue asks for repair; the timer must say so.
  f.store.setMeta('targetHealth', { next: { status: 'red', head, checkedAt: new Date().toISOString(), target: 'next' } });
  r = timerCheck(compact(), memory, { nowMs: now + MIN });
  assert.equal(r.decision, 'forward'); assert.match(r.forward, /Raised: Queue hold \(main, next\): Work for next waits: next health is red/);
  // Repro 2: main green but last checked in 2020, automatic queueing off: the queue says to run main.verify.
  f.store.setMeta('targetHealth', { next: { status: 'green', head, checkedAt: new Date().toISOString(), target: 'next' } });
  f.store.setMeta('mainHealth', { status: 'green', head, checkedAt: '2020-01-01T00:00:00.000Z' });
  r = timerCheck(compact(), memory, { nowMs: now + 2 * MIN });
  assert.equal(r.decision, 'forward'); assert.match(r.forward, /Queue hold \(main, main\): .*main health is stale.*run main\.verify/);
  // A verification in progress for main: a wait, quiet unless it lasts past the stall limit.
  f.store.put('job', { id: 'job-verify', operation: 'main.verify', status: 'running', payload: {}, createdAt: new Date().toISOString() });
  r = timerCheck(compact(), memory, { nowMs: now + 3 * MIN });
  assert.equal(r.decision, 'absorb', JSON.stringify(r.findings));
  const waiting = { timer: r.timer };
  r = timerCheck(compact(), waiting, { nowMs: now + 3 * MIN + 121 * MIN });
  assert.equal(r.rule, 'timer-stall'); assert.match(r.forward, /a main verification for main has been in progress since/);
});

test('an unsent timer finding is delivered even if its condition clears before the next run', async t => {
  const f = fixture(t), compact = () => JSON.stringify(dashboardSnapshot(f.store)), now = Date.now();
  const timer = nowMs => runRecorded('timer', { ...f.files, input: compact(), nowMs });
  assert.equal(timer(now).decision, 'absorb');
  f.store.tx(() => placeRecoveryHold(f.store, { cause: 'operations-fault', error: 'fictional fault' }));
  const found = timer(now + MIN);
  assert.equal(found.decision, 'forward');
  // Not sent; the hold clears before the next run.
  f.store.tx(() => { f.store.setMeta('recoveryHold', false); f.store.setMeta('recoveryHoldReason', null); });
  for (const n of [2, 3]) {
    const again = timer(now + n * MIN);
    assert.equal(again.decision, 'forward', `run ${n}`);
    assert.match(again.forward, /Recovery hold: operations-fault.*cleared again before delivery/);
  }
  const last = timer(now + 4 * MIN);
  confirmSent(last.sendId, f.files);
  assert.equal(timer(now + 5 * MIN).decision, 'absorb', 'confirmed: delivered once');
  assert.equal(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending && Object.keys(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending).length, 0);
});

test('approved queued work with nothing running is reported once after the idle limit, naming the flow that holds the slot', async t => {
  const f = fixture(t);
  f.ok('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision });
  f.ok('queue.put', { taskIds: [f.task.id] });
  f.store.put('flow', change('flow-held', { state: 'stopped', stopReason: 'Fictional operator stop', step: 'build' }));
  const compact = () => JSON.parse(JSON.stringify(dashboardSnapshot(f.store))), now = Date.now();
  let r = timerCheck(compact(), {}, { nowMs: now });
  assert.equal(r.decision, 'absorb'); let memory = { timer: r.timer };
  r = timerCheck(compact(), memory, { nowMs: now + 11 * MIN });
  assert.equal(r.rule, 'timer-stall'); assert.match(r.forward, /1 approved queued task\(s\) \(task-1\) and no running or ready flow since/); assert.match(r.forward, /flow-held stopped \(Fictional operator stop\), holds a slot/);
  memory = { timer: r.timer };
  assert.equal(timerCheck(compact(), memory, { nowMs: now + 30 * MIN }).decision, 'absorb', 'once per episode');
});

// dev.83: a flow parked on an answer holds no flow slot; the idle finding says which open flows do.
test('the idle finding tells parked flows, answered flows waiting for a slot and slot holders apart', async t => {
  const f = fixture(t);
  f.ok('task.approve', { taskId: f.task.id, revision: f.store.need('task', f.task.id).revision });
  f.ok('queue.put', { taskIds: [f.task.id] });
  const workflow = { version: 1, start: 'build', nodes: { build: { kind: 'effect', argv: ['true'], timeoutMs: 1000, next: 'decide', onFailure: 'done' }, decide: { kind: 'question', question: 'Merge?', role: 'operator', answers: { merge: 'build' } }, done: { kind: 'end', outcome: 'completed' } } };
  const open = (id, extra) => f.store.put('flow', change(id, { workflow, results: {}, state: 'waiting', attemptId: null, createdAt: new Date().toISOString(), ...extra }));
  open('flow-parked', { step: 'decide', parkedAt: '2026-01-01T00:00:00.000Z' });
  open('flow-beyond', { step: 'decide', parkedAt: '2026-01-01T00:01:00.000Z' });
  open('flow-answered', { step: 'build', slotWait: { since: new Date().toISOString(), step: 'build', after: 'answer' } });
  open('flow-timer', { step: 'build' });
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { ...f.store.meta('config').policy, maxParkedFlows: 1 } });
  const compact = () => JSON.parse(JSON.stringify(dashboardSnapshot(f.store))), now = Date.now();
  const memory = { timer: timerCheck(compact(), {}, { nowMs: now }).timer };
  const r = timerCheck(compact(), memory, { nowMs: now + 11 * MIN });
  assert.equal(r.rule, 'timer-stall');
  assert.match(r.forward, /flow-parked waiting, parked on an answer, holds no slot/);
  assert.match(r.forward, /flow-beyond waiting, parked on an answer beyond the parked limit, holds a slot/);
  assert.match(r.forward, /flow-answered waiting, answered, waiting for a slot/);
  assert.match(r.forward, /flow-timer waiting, holds a slot/);
  // A snapshot from an earlier release (no parked field, no capacity) reads as before.
  const earlier = compact(); delete earlier.queueStatus.capacity; for (const flow of earlier.flows) { delete flow.parked; delete flow.slotWait; }
  assert.match(timerCheck(earlier, memory, { nowMs: now + 11 * MIN }).forward, /flow-parked waiting, holds a slot/);
});

test('a flow notice read while its flow still runs is re-checked once, then forwarded or decided on the second read', async t => {
  const f = fixture(t);
  const notice = finish(f, change('flow-racing', { state: 'running', step: 'cleanup' }), 'completed');
  const body = only(await f.deliver(), b => b.inboxId === notice.id);
  const first = f.wake(body);
  assert.equal(first.decision, 'recheck'); assert.equal(first.rule, 'flow-still-active'); assert.deepEqual(first.actions, []);
  const second = f.wake(body);
  assert.equal(second.decision, 'forward'); assert.equal(second.rule, 'flow-still-active'); assert.match(second.forward, /Re-checked after 60 s/);
  // The same race resolved by the second read: the ordinary rule applies.
  const other = finish(f, change('flow-settling', { state: 'running', step: 'cleanup' }), 'completed');
  const otherBody = only(await f.deliver(), b => b.inboxId === other.id);
  assert.equal(f.wake(otherBody).decision, 'recheck');
  f.store.put('flow', { ...f.store.need('flow', 'flow-settling'), state: 'completed' });
  assert.equal(f.wake(otherBody).rule, 'flow-notice');
});

test('a merge question forward carries what the decision needs, and names what the narrow read lacks', async t => {
  const f = fixture(t);
  f.store.tx(() => {
    f.store.put('flow', change('flow-merge', { state: 'waiting', step: 'decide', effectiveRisk: 'ordinary', results: {
      review: { route: 'pass', attemptId: 'attempt-review', identity: { head }, result: { verdict: 'pass', findings: [{ severity: 'low', file: 'a.js', line: 1, message: 'Fictional finding' }] } },
      gate: { route: 'pass', attemptId: 'attempt-gate', inputIdentity: { head: 'b'.repeat(40) }, checks: [{ id: 'unit', status: 'passed' }, { id: 'lint', status: 'failed' }] } } }));
    f.store.put('inbox', { id: 'merge-question', kind: 'question', status: 'open', flowId: 'flow-merge', taskId: 'task-1', version: 1, role: 'orchestrator', subjectDigest: 'fictional-digest', question: 'Merge this candidate?', answers: ['merge', 'send_back', 'stop'], choices: [{ id: 'merge', label: 'Merge' }, { id: 'send_back', label: 'Send back' }, { id: 'stop', label: 'Stop' }], createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  });
  const body = only(await f.deliver(), b => b.inboxId === 'merge-question');
  const result = f.wake(body);
  assert.equal(result.rule, 'orchestrator-question');
  for (const text of [/Merge decision open/, /subject digest fictional-digest/, /verdict pass, 1 finding/, /1 of 2 check\(s\) passed; not passed: lint failed/, /same head: no \(review aaaaaaaaaaaa, gate bbbbbbbbbbbb\)/, /Not in the narrow read: the pull request link and its forge check state/, /merge conditions/])
    assert.match(result.forward, text);
});

test('with no session declared, forwards go to the configured thread, and say where the target came from', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const body = only(await f.deliver(), b => b.inboxId === q.id), state = f.view({ inbox: q.id });
  assert.equal(state.project.session.sessionId, null, 'no session declared');
  assert.deepEqual([decide({ payload: body, state }).forwardTo, decide({ payload: body, state }).forwardSource], [null, null]);
  const configured = decide({ payload: body, state }, { forwardTo: 'fictional-configured-thread' });
  assert.deepEqual([configured.forwardTo, configured.forwardSource], ['fictional-configured-thread', 'configured']);
  f.ok('orchestrator.session', { sessionId: 'fictional-bound-thread' }, { actor: 'orchestrator' });
  const bound = decide({ payload: body, state: f.view({ inbox: q.id }) }, { forwardTo: 'fictional-configured-thread' });
  assert.deepEqual([bound.forwardTo, bound.forwardSource], ['fictional-bound-thread', 'session'], 'the bound session wins');
});

// ---- dev.84: gaps from the first live trial of the proxy ------------------------------------------

// Every command passes the protocol version, as the guides' TRIAGE shorthands do (review of dev.87).
const cli = (args, options = {}) => spawnSync(process.execPath, [SCRIPT, ...args, '--protocol', '90'], { encoding: 'utf8', ...options });
const json = r => { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
const carried = n => Array.from({ length: n }, (_, i) => ({ question: `Fictional question ${i + 1}: ${'which behaviour should the fictional widget have when '.repeat(3)}?`, from: i % 2 ? 'builder' : 'planner', assumption: `Fictional assumption ${i + 1}: ${'keep the fictional default '.repeat(3)}` }));

test('an answered flow question is headed by its task title and ID, and says when it was answered', async t => {
  const f = fixture(t);
  f.store.tx(() => {
    f.store.put('flow', change('flow-asked', { state: 'completed' }));
    f.store.put('inbox', { id: 'flow-question', kind: 'question', status: 'answered', flowId: 'flow-asked', taskId: 'task-1', version: 2, role: 'operator', question: 'Merge this candidate?', answers: ['merge', 'stop'], choices: [{ id: 'merge', label: 'Merge' }, { id: 'stop', label: 'Stop' }], answer: 'merge', answeredBy: 'operator', answeredAt: '2026-11-15T21:07:00.000Z', answerNote: 'Fictional note', createdAt: '2026-11-15T21:00:00.000Z' });
  });
  const body = only(await f.deliver(), b => b.inboxId === 'flow-question');
  assert.equal(body.event, 'inbox.resolved');
  const result = f.wake(body);
  assert.equal(result.rule, 'answered');
  const [headline] = result.forward.split('\n');
  assert.match(headline, /Question answered by operator: “Fictional feature” \(task task-1\)/, headline);
  assert.match(result.forward, /Task task-1: “Fictional feature”/);
  assert.match(result.forward, /answer merge by operator at 2026-11-15T21:07:00\.000Z/);
  assert.equal(logOf(f).at(-1).title, 'Fictional feature', 'the log names the task title too');
});

test('a completed notice keeps its carried questions, bounded with a "… and N more" marker, within the forward budget', async t => {
  const f = fixture(t);
  const notice = finish(f, change('flow-carried', { carriedQuestions: carried(14) }));
  assert.ok(notice.context.length > 2000, 'the fixture context is long');
  const result = f.wake(only(await f.deliver(), b => b.inboxId === notice.id));
  assert.equal(result.rule, 'flow-notice');
  assert.match(result.forward, /Carried questions \(data\): the flow went ahead on these without an answer/);
  assert.match(result.forward, /\n1\. Planner asked: Fictional question 1:.*Assumed: Fictional assumption 1/);
  assert.match(result.forward, new RegExp(`\\n${BUDGET.carriedShown}\\. Builder asked: Fictional question ${BUDGET.carriedShown}:`));
  assert.match(result.forward, new RegExp(`… and ${14 - BUDGET.carriedShown} more \\(status --inbox ${notice.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} has them all\\)`));
  assert.match(result.forward, /tell the operator .*carried questions/i);
  assert.ok(result.forward.length <= FORWARD_CHARS, `${result.forward.length} characters`);
  // A merge question carries the list as a field: the forward uses it.
  f.store.tx(() => {
    f.store.put('flow', change('flow-merge-carried', { state: 'waiting', step: 'decide', effectiveRisk: 'ordinary', results: {} }));
    f.store.put('inbox', { id: 'merge-carried', kind: 'question', status: 'open', flowId: 'flow-merge-carried', taskId: 'task-1', version: 1, role: 'operator', subjectDigest: 'd', question: 'Merge?', answers: ['merge', 'stop'], choices: [{ id: 'merge', label: 'Merge' }, { id: 'stop', label: 'Stop' }], carriedQuestions: { questions: carried(2), overflow: { count: 3, attemptIds: ['attempt-plan'] } }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  });
  const merge = f.wake(only(await f.deliver(), b => b.inboxId === 'merge-carried'));
  assert.match(merge.forward, /\n2\. Builder asked: Fictional question 2/);
  assert.match(merge.forward, /3 more the flow went ahead on could not be kept by the flow; .*attempt-plan/);
});

test('a long context is cut to its budget and says so; the headline, provenance, IDs and acknowledgement line always survive', async t => {
  const f = fixture(t);
  const q = f.ok('inbox.publish', { ...question, title: 'Fictional long notice', context: `Start. ${'Fictional detail sentence. '.repeat(500)}End.` });
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  const result = f.wake(body);
  const length = f.view({ inbox: q.id }).item.context.length;
  assert.match(result.forward, new RegExp(`context cut: ${BUDGET.context} of ${length} characters shown; status --inbox ${q.id} has it all`));
  assert.ok(result.forward.length <= FORWARD_CHARS);
  const lines = result.forward.split('\n');
  assert.match(lines[0], /^\[Factotum via triage\] Operator question open: “Fictional long notice”/);
  assert.match(lines[1], /^Provenance: /);
  assert.ok(lines.some(line => line.includes(`delivery ${body.deliveryId}`)));
  // Every section at its budget at once: optional parts are cut to fit, the kept ones stay whole.
  const huge = 'x'.repeat(5000), state = f.view({ inbox: q.id });
  const item = { ...state.item, title: huge, question: huge, answerNote: huge, context: `${huge}\n\n${CARRIED}\n${Array.from({ length: 20 }, (_, i) => `${i + 1}. Planner asked: ${huge}`).join('\n')}\n\nCorrected on the way: ${huge}\n\nCleanup is outstanding: ${huge}`,
    choices: Array.from({ length: 40 }, (_, i) => ({ id: `choice-${i}`, label: huge })) };
  const capped = decide({ payload: body, state: { ...state, item } }, { projectId: f.projectId });
  assert.ok(capped.forward.length <= FORWARD_CHARS, `${capped.forward.length} characters`);
  assert.match(capped.forward, /cut to fit the forward/);
  assert.match(capped.forward.split('\n').at(-1), /^Triage did: .*delivery\.ack/);
  assert.match(lines.at(-1), new RegExp(`delivery\\.ack \\{"deliveryId":"${body.deliveryId}"\\}\\. Absorbed since the last forward: 0 \\(log: ${f.files.logPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`), 'the count is shown even when it is zero');
});

test('a failed or stopped flow\'s forward names its attempts and their reasons, and says when the notice is older than the flow', async t => {
  const f = fixture(t);
  f.store.tx(() => {
    f.store.put('attempt', { id: 'attempt-build-1', flowId: 'flow-uncertain', step: 'build', status: 'uncertain', reason: 'Provider did not produce a complete validated result' });
    f.store.event('attempt.prepared', { attemptId: 'attempt-build-1', flowId: 'flow-uncertain' });
    f.store.put('attempt', { id: 'attempt-check-1', flowId: 'flow-uncertain', step: 'check', status: 'passed', settledAt: '2026-11-15T21:00:00.000Z' });
    f.store.event('attempt.prepared', { attemptId: 'attempt-check-1', flowId: 'flow-uncertain' });
  });
  const notice = finish(f, change('flow-uncertain', { state: 'stopped', step: 'build', stopReason: 'uncertain attempt' }), 'stopped', 'uncertain attempt: inspect private artifacts');
  const body = only(await f.deliver(), b => b.inboxId === notice.id);
  const stopped = f.wake(body);
  assert.equal(stopped.rule, 'flow-notice');
  assert.match(stopped.forward, /Attempt attempt-build-1: step build, status uncertain, not settled; reason “Provider did not produce a complete validated result”\. Files: attempts\/attempt-build-1\/ in the state directory\./);
  assert.doesNotMatch(stopped.forward, /attempt-check-1/, 'a passed attempt is not listed');
  assert.doesNotMatch(stopped.forward, /older than the flow/);
  // The operator settles the attempt as failed: the flow now reads failed, the stop notice is older.
  f.store.put('flow', { ...f.store.need('flow', 'flow-uncertain'), state: 'failed', outcome: 'failed', step: 'failed' });
  const later = decide({ payload: body, state: f.view({ inbox: notice.id }) }, { projectId: f.projectId });
  assert.match(later.forward, /This notice is older than the flow's current state: the notice says stopped, the flow now reads failed at step failed/);
});

test('every recorded forward carries a provenance line the orchestrator can check against the log', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  json(cli(['--set-proxy-id', 'fictional-proxy-thread', '--memory', f.files.memoryPath, '--log', f.files.logPath]));
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  const result = f.wake(body);
  const provenance = result.forward.split('\n')[1];
  assert.match(provenance, new RegExp(`^Provenance: triage proxy fictional-proxy-thread · rule operator-question · delivery ${body.deliveryId} · send ${body.deliveryId}:1 · decided \\d{4}-`));
  assert.ok(provenance.includes(`--verify ${body.deliveryId}:1`));
  assert.equal(logOf(f).at(-1).sendId, `${body.deliveryId}:1`, 'the log records the send ID');
  assert.equal(verifyForward(logOf(f), `${body.deliveryId}:1`).decisions.length, 1, 'found by its send ID');
  // A delivery ID still finds its forwards, as logs before dev.85 had them.
  let check = verifyForward(logOf(f), body.deliveryId);
  assert.equal(check.logged, true); assert.deepEqual(check.sentAt, []); assert.match(check.verdict, /not confirmed the send yet/);
  assert.equal(check.decisions[0].rule, 'operator-question');
  confirmSent(body.deliveryId, f.files); // as before dev.85: the delivery's most recent attempt
  check = json(cli(['--verify', body.deliveryId, '--log', f.files.logPath]));
  assert.equal(check.logged, true); assert.equal(check.sentAt.length, 1); assert.match(check.verdict, /confirmed sent/);
  const forged = json(cli(['--verify', 'fictional-forged-delivery', '--log', f.files.logPath]));
  assert.equal(forged.logged, false); assert.match(forged.verdict, /Not in the triage log/);
  // Timer forwards carry it too, with no delivery; --forwards lists what was sent.
  f.store.tx(() => placeRecoveryHold(f.store, { cause: 'operations-fault', error: 'fictional fault' }));
  const timer = runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)) });
  assert.match(timer.forward.split('\n')[1], new RegExp(`^Provenance: triage proxy fictional-proxy-thread · rule timer-change · delivery none · send ${timer.sendId}`));
  confirmSent(timer.sendId, f.files);
  const sent = forwardsSince(logOf(f));
  assert.deepEqual(sent.map(row => [row.sendId, row.rule]), [[`${body.deliveryId}:1`, 'operator-question'], [timer.sendId, 'timer-change']]);
  assert.equal(sent[0].inboxId, q.id);
  assert.deepEqual(json(cli(['--forwards', '--since', sent[1].sentAt, '--log', f.files.logPath])).map(row => row.sendId), [timer.sendId]);
  // Without a recorded identity the line says so.
  const other = fixture(t), q2 = other.ok('inbox.publish', question);
  assert.match(other.wake(only(await other.deliver(), b => b.inboxId === q2.id)).forward.split('\n')[1], /^Provenance: triage proxy \(identity not recorded\)/);
});

test('misses are recorded by kind, corrections sit beside them, --help prints usage, and the log path is printed in full', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: q.id })));
  // Run from the state directory with a relative log path: the forward names the full path.
  const run = cli(['--project', f.projectId, '--state', 'read.json', '--memory', 'state.json', '--log', 'log.jsonl'], { cwd: f.dir, input: JSON.stringify(body) });
  assert.ok(json(run).forward.includes(`(log: ${join(realpathSync(f.dir), 'log.jsonl')})`), json(run).forward);
  json(cli(['--missed', '--kind', 'absorbed', '--note', 'Fictional: needed it', '--log', f.files.logPath]));
  const lookup = json(cli(['--missed', '--kind', 'lookup', '--note', 'Fictional: context about 1,0xx characters', '--ref', q.id, '--log', f.files.logPath]));
  assert.deepEqual(lookup, { recorded: 'missed', kind: 'lookup' });
  const c = json(cli(['--counts', '--log', f.files.logPath]));
  assert.equal(c.missed, 1); assert.equal(c.lookups, 1);
  const at = logOf(f).at(-1).at;
  assert.deepEqual(json(cli(['--correct', at, '--note', 'Fictional: the context was 987 characters', '--log', f.files.logPath])), { recorded: 'correction', corrects: at });
  assert.deepEqual(json(cli(['--counts', '--log', f.files.logPath])), c, 'a correction changes no count');
  assert.notEqual(cli(['--correct', '2000-01-01T00:00:00.000Z', '--note', 'x', '--log', f.files.logPath]).status, 0, 'a correction must name an entry');
  assert.notEqual(cli(['--missed', '--kind', 'fictional', '--log', f.files.logPath]).status, 0);
  const help = cli(['--help']);
  assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /--verify <sendId>/); assert.match(help.stdout, /--set-proxy-id/);
  assert.match(cli(['--log']).stderr, /--log needs a value/);
});

test('the proxy guide sets itself up from its first message, with the same webhook prompt as the integration guide', () => {
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), guide = read('../docs/integrations/t3.md');
  // The proxy guide is a template: its installation path is the placeholder [[install-root]] (dev.85), which the integration guide writes <install-root>.
  const prompt = text => text.match(/```text\n(Factotum webhook for the triage proxy[^\n]*)/)[1].replaceAll('[[install-root]]', '<install-root>');
  assert.equal(prompt(brief), prompt(guide), 'the two webhook prompts are identical');
  const setup = brief.slice(brief.indexOf('## First run: setup'), brief.indexOf('## Any other message'));
  for (const text of ['--set-proxy-id', '`bindToCurrentThread: true`', '`freshSession: true`', 'Never pass `schedule`', 'list_scheduled_tasks', '`clientRequestId', '"fixed_time"', '[Factotum triage setup]'])
    assert.ok(setup.includes(text), `setup names ${text}`);
  // The guide's first message points at that section; the webhook stays on the proxy at a handoff.
  assert.match(guide, /Set up as the Factotum triage proxy: follow <install-root>\/project\/integrations\/t3-triage\.md, section "First run: setup"/);
  const handoff = guide.slice(guide.indexOf('## Ordinary threads and orchestrator handoff'), guide.indexOf('## Pull requests'));
  assert.match(handoff, /With a \[triage proxy\]\(#triage-proxy-thread-recommended\), the webhook stays on the proxy and only the session binding moves/);
  const handling = read('../starter/project/integrations/t3-notifications.example.md');
  const step = handling.slice(handling.indexOf('- **Hand off to a fresh orchestrator session**'), handling.indexOf('If now is the wrong moment'));
  assert.match(step, /\*\*With a triage proxy\*\* .*the webhook stays on the proxy; only the session binding moves\. The successor does not call `schedule_task`/);
});

// ---- review of 61709fc --------------------------------------------------------------------------

test('--since is compared as an instant, and a cutoff that is not an ISO time is refused', async t => {
  const f = fixture(t);
  const entries = [{ at: '2026-11-15T21:29:59.000Z', decision: 'sent', what: 'timer', sendId: 'timer:early' }, { at: '2026-11-15T21:31:01.000Z', decision: 'sent', what: 'timer', sendId: 'timer:late' },
    { at: '2026-11-15T21:31:02.000Z', decision: 'missed', kind: 'lookup', note: 'Fictional' }];
  for (const cutoff of ['2026-11-15T21:30:00Z', '2026-11-15T22:30:00+01:00', '2026-11-15T16:30:00-05:00', '2026-11-15T21:30:00.000Z']) {
    assert.deepEqual(forwardsSince(entries, cutoff).map(row => row.sendId), ['timer:late'], cutoff);
    assert.equal(counts(entries, cutoff).forwarded, 1, cutoff); assert.equal(counts(entries, cutoff).lookups, 1, cutoff);
  }
  assert.deepEqual(forwardsSince(entries).map(row => row.sendId), ['timer:early', 'timer:late']);
  for (const bad of ['garbage', '', 'yesterday', '15/11/2026', '2026-13-45T00:00:00Z', 1700000000000]) {
    assert.throws(() => forwardsSince(entries, bad), /--since must be an ISO time/, String(bad));
    assert.throws(() => counts(entries, bad), /--since must be an ISO time/, String(bad));
  }
  assert.equal(parseSince('2026-11-15'), Date.parse('2026-11-15'));
  writeFileSync(f.files.logPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual(json(cli(['--forwards', '--since', '2026-11-15T22:30:00+01:00', '--log', f.files.logPath])).map(row => row.sendId), ['timer:late']);
  for (const args of [['--forwards', '--since', 'garbage'], ['--counts', '--since', 'garbage']]) {
    const r = cli([...args, '--log', f.files.logPath]);
    assert.notEqual(r.status, 0, args.join(' ')); assert.equal(r.stdout, ''); assert.match(r.stderr, /--since must be an ISO time/);
  }
});

test('recorded forwards stay within the cap with their provenance line, from the script and the command line', async t => {
  const f = fixture(t), long = text => `${text} ${'with a fictional long explanation '.repeat(40)}`;
  const proxy = `fictional-proxy-${'p'.repeat(180)}`;
  json(cli(['--set-proxy-id', proxy, '--memory', f.files.memoryPath, '--log', f.files.logPath]));
  f.store.tx(() => {
    f.store.put('flow', change('flow-merge-long', { state: 'waiting', step: 'decide', effectiveRisk: 'ordinary', results: {} }));
    f.store.put('inbox', { id: 'merge-long', kind: 'question', status: 'open', flowId: 'flow-merge-long', taskId: 'task-1', version: 1, role: 'operator', subjectDigest: 'd', title: long('Fictional title'), question: long('Merge?'),
      context: long('Fictional context').repeat(10), answers: ['merge', 'stop'], choices: [{ id: 'merge', label: 'Merge' }, { id: 'stop', label: 'Stop' }],
      carriedQuestions: { questions: Array.from({ length: 20 }, (_, i) => ({ question: long(`Fictional question ${i + 1}`), from: 'planner', assumption: long('Fictional assumption') })), overflow: null },
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() });
  });
  const body = only(await f.deliver(), b => b.inboxId === 'merge-long');
  const check = forward => {
    assert.ok(forward.length <= FORWARD_CHARS, `${forward.length} characters`);
    const lines = forward.split('\n');
    assert.match(lines[0], /^\[Factotum via triage\] Merge decision open/); assert.match(lines[1], new RegExp(`^Provenance: triage proxy ${proxy} · rule operator-question`));
    assert.match(lines[2], new RegExp(`delivery ${body.deliveryId}`)); assert.match(lines.at(-1), /^Triage did: .*delivery\.ack/);
    assert.match(forward, /Asked of you: A merge decision/); assert.match(forward, /Carried questions/);
  };
  check(f.wake(body).forward);
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: 'merge-long' })));
  check(json(cli(['--project', f.projectId, '--state', f.files.statePath, '--memory', f.files.memoryPath, '--log', f.files.logPath], { input: JSON.stringify(body) })).forward);
  // A timer forward is not built by the section budgets; the last guard still keeps it within the cap.
  const compact = { snapshotView: 'dashboard-v1', projectId: 'fictional', flows: [], providerLimits: { held: Array.from({ length: 400 }, (_, i) => `fictional-provider-${i}-${'x'.repeat(40)}`) } };
  const timer = runRecorded('timer', { ...f.files, input: JSON.stringify(compact) });
  assert.ok(timer.forward.length <= FORWARD_CHARS, `${timer.forward.length} characters`);
  const lines = timer.forward.split('\n');
  assert.match(lines[1], /^Provenance: /); assert.match(timer.forward, /characters cut to fit the forward/); assert.match(lines.at(-1), /^Asked of you: /);
});

test('a reset forward is logged with its send ID, so --verify and --forwards find it', async t => {
  const f = fixture(t), compact = () => JSON.stringify(dashboardSnapshot(f.store));
  assert.equal(runRecorded('timer', { ...f.files, input: compact() }).decision, 'absorb');
  writeFileSync(f.files.memoryPath, '{ not json');
  const reset = runRecorded('timer', { ...f.files, input: compact() });
  assert.equal(reset.rule, 'state-reset'); assert.match(reset.sendId, /^notice:/);
  assert.match(reset.forward.split('\n')[1], new RegExp(`^Provenance: .* rule state-reset · delivery none · send ${reset.sendId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const check = verifyForward(logOf(f), reset.sendId);
  assert.equal(check.logged, true); assert.equal(check.decisions[0].rule, 'state-reset');
  assert.equal(logOf(f).filter(e => e.sendId === reset.sendId).length, 1, 'the absorbed timer decision itself carries no send ID');
  confirmSent(reset.sendId, f.files);
  assert.equal(verifyForward(logOf(f), reset.sendId).sentAt.length, 1);
  assert.deepEqual(forwardsSince(logOf(f)).map(row => [row.sendId, row.rule]), [[reset.sendId, 'state-reset']]);
});

test('--missed and --correct require a note', async t => {
  const f = fixture(t);
  json(cli(['--missed', '--kind', 'lookup', '--note', 'Fictional: needed the attempt', '--log', f.files.logPath]));
  const at = logOf(f).at(-1).at, lines = logOf(f).length;
  for (const args of [['--missed'], ['--missed', '--kind', 'lookup'], ['--missed', '--note', '   '], ['--missed', '--note', ''], ['--correct', at], ['--correct', at, '--note', ' ']]) {
    const r = cli([...args, '--log', f.files.logPath]);
    assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stderr, /--note is required|needs a value/, args.join(' '));
  }
  assert.equal(logOf(f).length, lines, 'nothing was recorded');
});

test('review fix (dev.85): two forwards of one delivery decided for different threads keep their own send IDs and destinations; once either is confirmed the other is closed as delivered (dev.88)', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const bind = sessionId => f.ok('orchestrator.session', { sessionId }, { actor: 'orchestrator' });
  bind('thread-old');
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  // 1. Decided while thread-old is bound; the proxy keeps this forward to send.
  const first = f.wake(body);
  assert.equal(first.forwardTo, 'thread-old'); assert.equal(first.sendId, `${body.deliveryId}:1`);
  // 2. The successor binds. 3. The same delivery comes back and is decided again, for thread-new.
  bind('thread-new');
  const reminder = only(await f.deliver(31 * MIN), b => b.inboxId === q.id);
  assert.equal(reminder.deliveryId, body.deliveryId);
  const second = f.wake(reminder);
  assert.equal(second.forwardTo, 'thread-new'); assert.equal(second.sendId, `${body.deliveryId}:2`, 'a send ID of its own');
  assert.match(second.forward.split('\n')[1], new RegExp(` · send ${body.deliveryId}:2 · `));
  // 4. The first send is confirmed only now: it went to thread-old, and the log and --forwards say so.
  // The orchestrator has the delivery: the other attempt is closed as delivered, never sent again or escalated (review P2-1 of 44a3127).
  confirmSent(first.sendId, f.files);
  assert.equal(confirmSent(second.sendId, f.files).recorded, 'already-sent');
  const log = logOf(f).filter(e => e.deliveryId === body.deliveryId);
  assert.deepEqual(log.map(e => [e.decision, e.sendId, e.forwardTo]), [
    ['forward', first.sendId, 'thread-old'], ['forward', second.sendId, 'thread-new'], ['delivered', second.sendId, undefined], ['sent', first.sendId, 'thread-old']]);
  assert.deepEqual(forwardsSince(logOf(f)).map(row => [row.sendId, row.deliveryId, row.forwardTo]), [[first.sendId, body.deliveryId, 'thread-old']]);
  assert.deepEqual(json(cli(['--forwards', '--log', f.files.logPath])).map(row => row.forwardTo), ['thread-old']);
  assert.equal(verifyForward(logOf(f), first.sendId).forwardTo, 'thread-old');
  assert.equal(verifyForward(logOf(f), second.sendId).forwardTo, 'thread-new');
  assert.deepEqual(triage.unconfirmedForwards(logOf(f)), []);
  // The successor's rule (handle each forward not addressed to itself) finds the one sent to its predecessor.
  assert.deepEqual(forwardsSince(logOf(f)).filter(row => row.forwardTo !== 'thread-new').map(row => row.sendId), [first.sendId]);
  // Confirmed the other way round, too.
  const g = fixture(t), r = g.ok('inbox.publish', question);
  g.ok('orchestrator.session', { sessionId: 'thread-old' }, { actor: 'orchestrator' });
  const b = only(await g.deliver(), x => x.inboxId === r.id), a1 = g.wake(b);
  g.ok('orchestrator.session', { sessionId: 'thread-new' }, { actor: 'orchestrator' });
  const a2 = g.wake(only(await g.deliver(31 * MIN), x => x.inboxId === r.id));
  confirmSent(a2.sendId, g.files); assert.equal(confirmSent(a1.sendId, g.files).recorded, 'already-sent');
  assert.deepEqual(forwardsSince(logOf(g)).map(row => [row.sendId, row.forwardTo]), [[a2.sendId, 'thread-new']]);
});

test('review fix (dev.85): --sent with a delivery ID confirms its most recent attempt, and a log or state file from before dev.85 still reads', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: 'thread-old' }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id), first = f.wake(body);
  f.ok('orchestrator.session', { sessionId: 'thread-new' }, { actor: 'orchestrator' });
  const second = f.wake(only(await f.deliver(31 * MIN), b => b.inboxId === q.id));
  assert.deepEqual(json(cli(['--sent', body.deliveryId, '--to', 'thread-new', '--memory', f.files.memoryPath, '--log', f.files.logPath])), { recorded: 'sent', sendId: second.sendId, to: 'thread-new' });
  assert.deepEqual(logOf(f).at(-1), { ...logOf(f).at(-1), decision: 'sent', what: 'delivery', deliveryId: body.deliveryId, sendId: second.sendId, forwardTo: 'thread-new' });
  // The earlier attempt was closed as delivered: confirming it too changes nothing (dev.88).
  assert.equal(confirmSent(first.sendId, f.files).recorded, 'already-sent');
  assert.deepEqual(logOf(f).slice(-2).map(e => [e.decision, e.sendId]), [['delivered', first.sendId], ['sent', second.sendId]]);
  // A log written before dev.85 (send ID = delivery ID, no forwardTo) still lists and verifies.
  const legacy = [{ at: '2026-11-15T10:00:00.000Z', decision: 'forward', rule: 'operator-question', deliveryId: 'd-old', inboxId: 'i-old', sendId: 'd-old' }, { at: '2026-11-15T10:00:05.000Z', decision: 'sent', what: 'delivery', deliveryId: 'd-old' }];
  assert.deepEqual(forwardsSince(legacy).map(row => [row.sendId, row.deliveryId, row.rule, row.forwardTo]), [['d-old', 'd-old', 'operator-question', null]]);
  const check = verifyForward(legacy, 'd-old');
  assert.equal(check.logged, true); assert.equal(check.sentAt.length, 1); assert.match(check.verdict, /does not record which thread/);
  // A state file from before dev.85: an unsent forward remembered under its delivery ID only.
  const memory = JSON.parse(readFileSync(f.files.memoryPath, 'utf8'));
  memory.deliveries['d-legacy'] = { decision: 'forward', rule: 'operator-question', at: '2026-11-15T10:00:00.000Z', sent: false, forwardTo: 'thread-old' };
  writeFileSync(f.files.memoryPath, JSON.stringify(memory));
  assert.deepEqual(confirmSent('d-legacy', f.files), { recorded: 'sent', sendId: 'd-legacy', to: 'thread-old' });
  assert.deepEqual([logOf(f).at(-1).deliveryId, logOf(f).at(-1).sendId, logOf(f).at(-1).forwardTo], ['d-legacy', undefined, 'thread-old']);
});

// ---- dev.86: J7 (a forward the proxy fails to send goes quiet) and J9 ------------------------------
// Exported names are read from the module object, so on a base without them a test fails on its
// assertion rather than the whole file failing to load.

const THREAD = `mcp:launch:${'f0e1'.repeat(16)}`;
const wakeAt = (f, body, nowMs, extra = {}) => {
  writeFileSync(f.files.statePath, JSON.stringify(f.view(body.inboxId ? { inbox: body.inboxId } : { task: body.taskId })));
  return runRecorded('wake', { ...f.files, input: JSON.stringify(body), projectId: f.projectId, nowMs, ...extra });
};
// The notice the proxy publishes for a forward marked escalateDue, asked for after the run's sends (dev.87, K1).
const escalateAt = (f, sendId, nowMs) => triage.escalateNow(sendId, { ...f.files, nowMs }).escalate;
// A digest run reads status --compact (dev.88, L2), so its re-sends are checked against the open items.
const digestAt = (f, nowMs) => runRecorded('digest', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)), nowMs });

test('J7: a forward is printed with ready-made t3_thread_send arguments that carry the thread ID exactly, prefix included', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: q.id })));
  const out = json(cli(['--project', f.projectId, '--state', f.files.statePath, '--memory', f.files.memoryPath, '--log', f.files.logPath], { input: JSON.stringify(body) }));
  assert.equal(out.forwardTo, THREAD);
  assert.deepEqual(out.send, { threadId: THREAD, message: out.forward, mode: 'queue' }, 'pass this object to t3_thread_send as it is');
  assert.deepEqual(out.retries, [], 'every run lists earlier unconfirmed forwards, here none');
  // An absorb has nothing to send.
  f.ok('inbox.ack', { inboxId: f.ok('inbox.publish', { kind: 'notice', title: 'Fictional notice', context: 'Fictional.' }).id });
  const absorbed = f.wake(only(await f.deliver(), b => b.event === 'inbox.resolved'));
  assert.equal(absorbed.decision, 'absorb'); assert.equal(absorbed.send, undefined);
});

test('J7: a failed send is sent again at once with the exact arguments, then escalated to the operator; every later run re-sends it under the same send ID until --sent', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', { ...question, title: 'Fictional merge-like decision' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), body = only(await f.deliver(), b => b.inboxId === q.id);
  const first = wakeAt(f, body, t0);
  assert.equal(first.sendId, `${body.deliveryId}:1`);
  assert.equal(typeof triage.sendFailed, 'function', 'the script records a failed send (--send-failed)');
  // The repro: the proxy mangled the thread ID and got thread_not_found. It records the failure.
  const failed = triage.sendFailed(first.sendId, { ...f.files, error: 'thread_not_found', read: f.view({ inbox: q.id }), nowMs: t0 + 10000 });
  assert.equal(failed.failures, 1);
  assert.equal(failed.next.sendId, first.sendId, 'the same send ID, so --sent still matches');
  assert.deepEqual([failed.next.send.threadId, failed.next.send.mode], [THREAD, 'queue'], 'sent again at once, to the thread exactly as printed');
  assert.match(failed.next.send.message, /^\[Factotum via triage\] Re-sent \(decided /);
  assert.ok(failed.next.send.message.includes(`send ${first.sendId}`), 'the provenance line is kept');
  assert.equal(failed.next.escalateDue, null, 'one failure is not escalated yet');
  // It fails again: the only thread known has failed twice, so the operator is told.
  const twice = triage.sendFailed(first.sendId, { ...f.files, error: 'thread_not_found', read: f.view({ inbox: q.id }), nowMs: t0 + 20000 });
  assert.equal(twice.next.send, null, 'no thread is left to try at once');
  assert.match(twice.next.escalateDue, new RegExp(`the orchestrator session ${THREAD} failed 2 send\\(s\\) of it .*forwards wait until a send there works or another session is bound`));
  const notice = escalateAt(f, first.sendId, t0 + 21000);
  assert.equal(notice.operation, 'inbox.publish');
  assert.equal(notice.payload.kind, 'notice'); assert.match(notice.payload.id, /^triage-undelivered-[0-9a-f]{12}-[0-9a-f]{8}$/);
  assert.ok(notice.payload.context.includes(q.id), 'the notice names the item'); assert.match(notice.payload.context, /thread_not_found/);
  assert.match(notice.payload.context, /answered, approved, merged and acknowledged nothing/);
  assert.doesNotMatch(JSON.stringify(notice.payload), /'/, 'the payload fits a single-quoted --payload');
  // The proxy publishes it as the orchestrator role: the operator sees it; it wakes nobody.
  const published = f.ok('inbox.publish', notice.payload, { actor: 'orchestrator' });
  assert.deepEqual([published.role, published.status], ['operator', 'open']);
  assert.deepEqual((await f.deliver()).filter(b => b.inboxId === published.id), [], 'no webhook wake for it at essential');
  assert.equal(triage.markEscalated(first.sendId, { ...f.files, read: f.view({ inbox: published.id }) }).recorded, 'escalated');
  // The next run of any kind (a timer run here) re-sends it first, under the same send ID, and does not escalate again.
  const timer = runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)), nowMs: t0 + 5 * MIN });
  const retry = only(timer.retries, r => r.sendId === first.sendId);
  assert.equal(retry.send.threadId, THREAD); assert.equal(retry.escalateDue, null);
  assert.deepEqual(logOf(f).filter(e => e.sendId === first.sendId).map(e => e.decision), ['forward', 'send-failed', 'retry', 'send-failed', 'escalated', 'retry']);
  confirmSent(first.sendId, f.files);
  assert.deepEqual(forwardsSince(logOf(f)).map(row => [row.sendId, row.forwardTo]), [[first.sendId, THREAD]]);
  assert.deepEqual(triage.unconfirmedForwards(logOf(f)), [], 'confirmed: no longer unconfirmed');
  assert.deepEqual(runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)), nowMs: t0 + 10 * MIN }).retries, [], 'and no longer re-sent');
});

test('J7: an unconfirmed forward with no failure recorded is re-sent by the next run after the grace period, oldest first and bounded, and escalated if it stays unconfirmed', async t => {
  const f = fixture(t);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), ids = [];
  for (let n = 0; n < 5; n++) ids.push(f.ok('inbox.publish', { ...question, title: `Fictional question ${n}` }).id);
  const bodies = await f.deliver();
  // Five forwards decided a second apart; the proxy sent none of them (it went quiet).
  const decided = ids.map((id, n) => wakeAt(f, only(bodies, b => b.inboxId === id), t0 + n * 1000));
  const later = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional later notice', context: 'Fictional.' });
  const laterBody = only(await f.deliver(), b => b.inboxId === later.id);
  assert.deepEqual(wakeAt(f, laterBody, t0 + 60000).retries, [], 'within the grace period nothing is re-sent');
  const laterForward = wakeAt(f, laterBody, t0 + 61000);
  assert.match(laterForward.forward, /Earlier forwards not yet confirmed sent when this was decided: 5 \(the current list: triage\.mjs --forwards --unconfirmed\)/, 'a new forward says how many are unconfirmed');
  const run = digestAt(f, t0 + 3 * MIN);
  assert.deepEqual(run.retries.map(r => r.sendId), decided.slice(0, 3).map(d => d.sendId), 'oldest first, at most three a run');
  for (const r of run.retries) { assert.equal(r.send.threadId, THREAD); assert.equal(r.escalateDue, null); }
  const next = digestAt(f, t0 + 3 * MIN + 1000);
  assert.deepEqual(next.retries.map(r => r.sendId), [...decided.slice(3).map(d => d.sendId), laterForward.sendId], 'the rest on the next run (the notice by its newest attempt); the first three wait out the grace period again');
  // Still unconfirmed ten minutes after it was decided: the operator is told.
  const late = digestAt(f, t0 + 11 * MIN);
  const oldest = only(late.retries, r => r.sendId === decided[0].sendId);
  assert.ok(oldest.send, 'it is still re-sent'); assert.match(oldest.escalateDue ?? '', /still not confirmed sent 11 minutes after it was decided/);
  assert.match(escalateAt(f, oldest.sendId, t0 + 11 * MIN + 5000).payload.context, /still not confirmed sent 11 minutes after it was decided/, 'not sent meanwhile: --escalate gives the notice');
  assert.equal(triage.counts(logOf(f)).unconfirmed, 6, 'five questions and the notice, counted once by its newest attempt');
  // A forward with no thread to go to is escalated at once.
  const g = fixture(t), r = g.ok('inbox.publish', question);
  const orphan = g.wake(only(await g.deliver(), b => b.inboxId === r.id));
  assert.equal(orphan.forwardTo, null); assert.equal(orphan.send, null);
  assert.equal(orphan.escalateDue, 'there is no orchestrator thread to send it to');
  assert.match(triage.escalateNow(orphan.sendId, g.files).escalate.payload.context, /there is no orchestrator thread to send it to/);
});

test('J7 (dev.88): a failed send goes to the bound session read again, not to the thread it was decided for, and that is not a fallback', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  const body = only(await f.deliver(), b => b.inboxId === q.id), t0 = Date.now();
  // Decided for the configured thread (no session seen yet); a later read sees a bound session.
  const first = wakeAt(f, body, t0, { forwardTo: 'fictional-configured-thread' });
  assert.deepEqual([first.forwardTo, first.forwardSource], ['fictional-configured-thread', 'configured']);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const other = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional notice', context: 'Fictional.' });
  wakeAt(f, only(await f.deliver(), b => b.inboxId === other.id), t0 + 1000);
  // dev.86 to dev.87: after two failures of the configured thread. dev.88: after the first, since THREAD is the bound session the re-read shows.
  const second = triage.sendFailed(first.sendId, { ...f.files, error: 'fictional failure', read: f.view({ inbox: q.id }), nowMs: t0 + 2000 });
  assert.deepEqual([second.next.send?.threadId, second.next.forwardSource, second.next.fallback], [THREAD, 'session', undefined]);
  assert.doesNotMatch(second.next.send.message, /Fallback/);
  assert.equal(second.next.escalateDue, null, 'the bound session is not down, so nobody else needs telling yet');
  confirmSent(first.sendId, f.files);
  assert.deepEqual(forwardsSince(logOf(f)).filter(row => row.sendId === first.sendId).map(row => row.forwardTo), [THREAD], 'the sent line records where it went');
});

test('J7: --forwards --unconfirmed lists forwards decided and never sent, and --counts includes them', async t => {
  const f = fixture(t);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const sent = f.ok('inbox.publish', { ...question, title: 'Fictional sent' }), lost = f.ok('inbox.publish', { ...question, title: 'Fictional lost' });
  const bodies = await f.deliver();
  const a = f.wake(only(bodies, b => b.inboxId === sent.id)); confirmSent(a.sendId, f.files);
  const b = f.wake(only(bodies, x => x.inboxId === lost.id));
  json(cli(['--send-failed', b.sendId, '--to', THREAD, '--error', 'thread_not_found', '--memory', f.files.memoryPath, '--log', f.files.logPath]));
  const listed = json(cli(['--forwards', '--unconfirmed', '--log', f.files.logPath]));
  assert.deepEqual(listed.map(row => [row.sendId, row.inboxId, row.rule, row.failures, row.lastError]), [[b.sendId, lost.id, 'operator-question', 1, 'thread_not_found']]);
  assert.deepEqual(json(cli(['--forwards', '--log', f.files.logPath])).map(row => row.sendId), [a.sendId], 'plain --forwards still lists confirmed forwards only');
  const c = json(cli(['--counts', '--log', f.files.logPath]));
  assert.deepEqual([c.forwarded, c.unconfirmed, c.sendFailures, c.byRule['operator-question']], [1, 1, 1, 2], 'forwarded counts sends; byRule counts decisions; unconfirmed is the difference');
  // A delivery whose newer attempt was confirmed, or that was absorbed since, is not listed.
  const reminder = only(await f.deliver(31 * MIN), x => x.inboxId === lost.id);
  confirmSent(f.wake(reminder).sendId, f.files);
  assert.deepEqual(triage.unconfirmedForwards(logOf(f)), []);
  // Superseded timer findings: only the newest unconfirmed timer forward is listed.
  f.store.tx(() => placeRecoveryHold(f.store, { cause: 'operations-fault', error: 'fictional fault' }));
  const t1 = runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)) });
  const t2 = runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)), nowMs: Date.now() + 1000 });
  assert.notEqual(t1.sendId, t2.sendId);
  assert.deepEqual(triage.unconfirmedForwards(logOf(f)).map(row => row.sendId), [t2.sendId]);
  assert.match(cli(['--help']).stdout, /--forwards --unconfirmed/);
});

test('J9: no-state forwards go to the last bound session before the configured thread, say that no state was read and why, and the timer run removes old wake directories', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  f.wake(body); // the proxy has now seen the bound session
  const other = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional maintenance notice', context: 'Fictional.' });
  const otherBody = only(await f.deliver(), b => b.inboxId === other.id);
  const blind = runRecorded('wake', { ...f.files, statePath: null, input: JSON.stringify(otherBody), projectId: f.projectId, forwardTo: 'fictional-retired-thread', readError: 'invalid inbox id' });
  assert.equal(blind.rule, 'no-state');
  assert.deepEqual([blind.forwardTo, blind.forwardSource], [THREAD, 'last-seen'], 'the last bound session wins over a configured thread that may be retired');
  assert.match(blind.forward.split('\n')[0], /No canonical state was read for .* \(the narrow read failed: invalid inbox id\)/);
  assert.match(blind.forward, /Triage did: read no canonical state;/);
  assert.doesNotMatch(blind.forward, /Triage did: read canonical state/);
  assert.match(blind.forward, /status --compact under \.inbox\[\]/);
  // --absorbed lists what moved the session count with no forward; --missed has a kind for a forward that never arrived.
  f.ok('inbox.ack', { inboxId: other.id });
  f.wake(only(await f.deliver(), b => b.inboxId === other.id && b.event === 'inbox.resolved'));
  assert.deepEqual(json(cli(['--absorbed', '--log', f.files.logPath])).map(row => [row.rule, row.inboxId]), [['operator-acknowledged-notice', other.id]]);
  assert.deepEqual(json(cli(['--missed', '--kind', 'undelivered', '--note', 'Fictional: never arrived', '--log', f.files.logPath])), { recorded: 'missed', kind: 'undelivered' });
  assert.equal(json(cli(['--counts', '--log', f.files.logPath])).undelivered, 1);
  // A wake directory a run left behind is removed by a timer run once it is a day old.
  const { mkdirSync } = await import('node:fs');
  const stale = join(f.dir, 'wake.AbC123'), fresh = join(f.dir, 'wake.XyZ789');
  mkdirSync(stale); writeFileSync(join(stale, 'payload.json'), '{}'); mkdirSync(fresh);
  const old = (Date.now() - 25 * 3600000) / 1000; utimesSync(stale, old, old);
  const timer = runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)) });
  assert.equal(timer.removedWakeDirs, 1); assert.equal(existsSync(stale), false); assert.equal(existsSync(fresh), true);
});

test('J7 and J9: the brief sends forwards exactly as printed and says what happens on a failed send; the handling guide checks the count and lists unconfirmed forwards', () => {
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), handling = read('../starter/project/integrations/t3-notifications.example.md'), guide = read('../docs/integrations/t3.md');
  const body = brief.replace(/<!-- template note: start -->[\s\S]*?<!-- template note: end -->\n/, '');
  // Note 10: once the placeholders are filled in, no double bracket is left for the proxy to stop on.
  assert.doesNotMatch(body.replace(/\[\[[a-z0-9-]+\]\]/g, 'FILLED'), /\[\[|\]\]/);
  const sending = brief.slice(brief.indexOf('## Sending a forward'), brief.indexOf('## A timer run'));
  for (const text of ['the `send` object as its arguments', 'character for character', 'prefix such as `mcp:launch:`', '`thread_not_found`', 'TRIAGE --send-failed <sendId> --to <threadId> --error', '`next.send`', '`next.escalateDue`', 'TRIAGE --escalated <sendId>', 'every later run (webhook, timer or digest) prints it again in `retries`'])
    assert.ok(sending.includes(text), `the brief's sending section says ${text}`);
  assert.match(brief, /\*\*First, `retries` and `closed`:\*\*/); assert.match(brief, /--read-error/); assert.match(brief, /Send no separate message about it/);
  assert.doesNotMatch(brief, /it is forwarded again later/, 'no promise without a time');
  for (const text of ['Check the count on every forward', 'expect n = n0 + a + 1', 'TRIAGE --forwards --unconfirmed', '--kind undelivered', 'triage-undelivered-', 'Standing down and resuming', '`orchestratorThreadId`', '`sessionVersion`', 'mergeContext', '`t3_thread_launch`', 'Check that the successor bound', 'send it on unchanged to the bound session', 'standing instructions'])
    assert.ok(handling.includes(text), `the handling guide says ${text}`);
  assert.doesNotMatch(handling, /\(see “Asking through the ask prompt”\)/, 'no reference that dangles once the optional section is deleted');
  assert.match(guide, /\*\*Escalation: who sees it\.\*\*/); assert.match(guide, /An attention delivery for a notice is sent once/);
  assert.doesNotMatch(guide, /A launch has no idempotency key/);
});

// ---- review of 9a3bae4 (GPT-6.1 Sol): P2-1, P2-2, P2-3 -------------------------------------------

const TIMER_MS = 1800000; // the brief's timer: schedule {"type": "interval", "everyMs": 1800000}
const timerAt = (f, nowMs) => runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)), nowMs });

test('review P2-1: with more unconfirmed forwards than the per-run budget, re-sends rotate and every overdue forward is escalated in the same run', async t => {
  const f = fixture(t);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), ids = [0, 1, 2, 3].map(n => f.ok('inbox.publish', { ...question, title: `Fictional question ${n}` }).id);
  const bodies = await f.deliver();
  const sendIds = ids.map((id, n) => wakeAt(f, only(bodies, b => b.inboxId === id), t0 + n * 1000).sendId);
  // Timer runs every 30 minutes; the proxy never confirms anything.
  const first = timerAt(f, t0 + TIMER_MS);
  assert.deepEqual(first.retries.filter(r => r.send).map(r => r.sendId), sendIds.slice(0, 3), 'three re-sends, oldest first');
  assert.deepEqual(first.retries.filter(r => r.escalateDue).map(r => r.sendId).sort(), [...sendIds].sort(), 'all four overdue forwards are escalated, the fourth too');
  const second = timerAt(f, t0 + 2 * TIMER_MS);
  assert.equal(second.retries.filter(r => r.send)[0].sendId, sendIds[3], 'the forward left out last time is re-sent first');
  const sentEver = new Set([...first.retries, ...second.retries].filter(r => r.send).map(r => r.sendId));
  assert.deepEqual([...sentEver].sort(), [...sendIds].sort(), 'within two runs every forward was re-sent');
});

test('review P2-2: on the default 30-minute timer, a forward nobody confirms or reports failed is escalated by the first timer run, without needing an earlier re-send', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  // No --sent, no --send-failed, no more webhooks: the next run is the timer, 30 minutes on.
  const run = timerAt(f, t0 + TIMER_MS);
  const step = only(run.retries, r => r.sendId === decided.sendId);
  assert.ok(step.send, 're-sent'); assert.ok(step.escalateDue, 'and escalated in the same run, the first one after the threshold');
  // The re-send is not confirmed (the proxy recorded nothing): --escalate, after the run's sends, gives the notice.
  assert.match(escalateAt(f, decided.sendId, t0 + TIMER_MS + 5000).payload.context, /still not confirmed sent 30 minutes after it was decided/);
});

test('review P2-3: an escalation ID cannot be predicted, an unrelated item under it does not count as the notice, and a lost --escalated finds its own notice', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  // Someone publishes the ID the dev.86 script would have used, before the proxy escalates.
  const { createHash } = await import('node:crypto');
  const predictable = `triage-undelivered-${createHash('sha256').update(decided.sendId).digest('hex').slice(0, 12)}`;
  f.ok('inbox.publish', { kind: 'notice', id: predictable, title: 'Fictional unrelated notice', context: 'Fictional.' });
  // Two failed sends to the only thread: the escalation is offered (independent of P2-2's timing).
  triage.sendFailed(decided.sendId, { ...f.files, error: 'thread_not_found', nowMs: t0 + 10000 });
  assert.ok(triage.sendFailed(decided.sendId, { ...f.files, error: 'thread_not_found', nowMs: t0 + 20000 }).next.escalateDue);
  const offer = escalateAt(f, decided.sendId, t0 + 21000);
  assert.notEqual(offer.payload.id, predictable, 'the ID has a random part');
  assert.match(offer.payload.id, /^triage-undelivered-[0-9a-f]{12}-[0-9a-f]{8}$/);
  // Even so, suppose another item holds it (the ID leaked): the publish fails, and --escalated with the read refuses it.
  f.ok('inbox.publish', { kind: 'notice', id: offer.payload.id, title: 'Fictional squatter', context: 'Fictional.' }, { actor: 'orchestrator' });
  assert.notEqual(f.command('inbox.publish', offer.payload, { actor: 'orchestrator' }).status, 'completed', 'inbox id already exists');
  const refused = triage.markEscalated(decided.sendId, { ...f.files, read: f.view({ inbox: offer.payload.id }) });
  assert.equal(refused.recorded, 'not-escalated'); assert.match(refused.reason, /another item holds the ID/);
  assert.notEqual(refused.escalate.payload.id, offer.payload.id, 'offered again under a new ID');
  assert.deepEqual([refused.escalate.payload.title, refused.escalate.payload.context], [offer.payload.title, offer.payload.context]);
  assert.ok(only(timerAt(f, t0 + TIMER_MS + 1000).retries, r => r.sendId === decided.sendId).escalateDue, 'still offered: not escalated');
  // The real notice is published; the proxy's --escalated is lost; the next run offers the same notice, the publish says it exists, and the read matches.
  f.ok('inbox.publish', refused.escalate.payload, { actor: 'orchestrator' });
  assert.ok(only(timerAt(f, t0 + TIMER_MS + 2000).retries, r => r.sendId === decided.sendId).escalateDue);
  const again = escalateAt(f, decided.sendId, t0 + TIMER_MS + 2500);
  assert.deepEqual(again, refused.escalate, 'the same notice under the same ID: re-runs are idempotent');
  assert.notEqual(f.command('inbox.publish', again.payload, { actor: 'orchestrator' }).status, 'completed');
  assert.deepEqual(triage.markEscalated(decided.sendId, { ...f.files, read: f.view({ inbox: again.payload.id }) }), { recorded: 'escalated', sendId: decided.sendId, inboxId: again.payload.id, covers: [decided.sendId] });
  const later = only(timerAt(f, t0 + TIMER_MS + 3 * MIN).retries, r => r.sendId === decided.sendId);
  assert.ok(later.send, 'still re-sent'); assert.equal(later.escalateDue, null, 'but the notice is not offered again');
  assert.equal(escalateAt(f, decided.sendId, t0 + TIMER_MS + 3 * MIN + 1000), null, '--escalate agrees');
  // A notice the operator could have published with the same title and context is not ours either (published by the operator role).
  assert.equal(triage.noticeMatches({ item: { ...f.store.need('inbox', again.payload.id), createdBy: 'operator' } }, again.payload), false);
  // The command line requires the read.
  const r = cli(['--escalated', decided.sendId, '--memory', f.files.memoryPath, '--log', f.files.logPath]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /--escalated needs --state/);
  assert.equal(triage.counts(logOf(f)).escalations, 1);
});

// ---- J8 follow-up: record IDs up to 640 characters, with `/` --------------------------------------

test('J8: delivery payloads with generated IDs up to 640 characters and a `/` are accepted, and nothing the proxy makes from them is a path or an over-long ID', async t => {
  const f = fixture(t);
  // A post-merge notice for a flow named after a branch: a 243-character inbox ID with slashes.
  const flowId = `post-merge:feature/fictional-branch/${'x'.repeat(60)}`;
  const inboxId = `flow-notice:${flowId}:failed:${'a'.repeat(64)}`.padEnd(243, '0');
  assert.equal(inboxId.length, 243);
  const deliveryId = `delivery/${'d'.repeat(290)}`;
  const body = { projectId: f.projectId, deliveryId, kind: 'inbox', event: 'inbox.attention', status: 'open', inboxId, version: 1, sessionDeliveries: 3, sessionDeliveryLimit: 100 };
  assert.equal(validatePayload(normalizePayload(body), f.projectId), null, 'a long generated ID with / is valid');
  // The longest generated notice ID: a target-sync flow between two 200-character branch names, 533 characters.
  const branch = side => `${side}/${'b'.repeat(199 - side.length)}`;
  const longest = `flow-notice:target-sync:${branch('release')}..${branch('feature')}:failed:${'c'.repeat(64)}`.padEnd(533, 'e');
  assert.equal(longest.length, 533); assert.ok(longest.includes('/'));
  assert.equal(validatePayload(normalizePayload({ ...body, inboxId: longest }), f.projectId), null, 'a 533-character generated ID with / is valid');
  assert.equal(validatePayload(normalizePayload({ ...body, inboxId: 'x'.repeat(640) }), f.projectId), null, '640 characters is the limit');
  for (const [key, value, why] of [['inboxId', 'x'.repeat(641), 'over 640'], ['inboxId', '-leading-dash', 'not starting with a letter or digit'], ['flowId', 'a b', 'a space'], ['deliveryId', '../etc', 'a dot first']])
    assert.equal(validatePayload(normalizePayload({ ...body, [key]: value }), f.projectId), `${key === 'deliveryId' ? 'projectId or deliveryId missing or malformed' : `${key} malformed`}`, why);
  // The run forwards it, logs the full IDs, and keeps every file at its fixed name.
  const state = { project: { session: { sessionId: THREAD } }, item: { id: inboxId, kind: 'notice', role: 'orchestrator', status: 'open', version: 1, flowId, title: 'Fictional post-merge check failed' } };
  writeFileSync(f.files.statePath, JSON.stringify(state));
  const before = new Set(readdirSync(f.dir));
  const t0 = Date.now(), result = runRecorded('wake', { ...f.files, input: JSON.stringify(body), projectId: f.projectId, nowMs: t0 });
  assert.equal(result.decision, 'forward'); assert.notEqual(result.rule, 'invalid-payload');
  assert.equal(result.sendId, `${deliveryId}:1`); assert.ok(result.forward.includes(inboxId));
  assert.deepEqual([logOf(f).at(-1).inboxId, logOf(f).at(-1).deliveryId, logOf(f).at(-1).flowId], [inboxId, deliveryId, flowId]);
  // An escalation made from it has an ID a caller may choose: at most 128 characters, no slash.
  triage.sendFailed(result.sendId, { ...f.files, error: 'thread_not_found', nowMs: t0 + 1000 });
  triage.sendFailed(result.sendId, { ...f.files, error: 'thread_not_found', nowMs: t0 + 2000 });
  const notice = escalateAt(f, result.sendId, t0 + 3000);
  assert.ok(notice.payload.id.length <= 128); assert.doesNotMatch(notice.payload.id, /\//);
  assert.ok(notice.payload.context.includes(inboxId), 'the notice still names the full item ID');
  f.ok('inbox.publish', notice.payload, { actor: 'orchestrator' });
  json(cli(['--forwards', '--unconfirmed', '--log', f.files.logPath])).forEach(row => assert.equal(row.inboxId, inboxId));
  const added = readdirSync(f.dir).filter(name => !before.has(name));
  assert.deepEqual(added.filter(name => name.includes('/') || name.includes('fictional-branch') || name.includes('ddd')), [], 'no file is named after an ID');
});

// ---- re-check of b41d6ca (GPT-6.1 Sol): the bound depends on the timer's phase -------------------

test('re-check P2: a forward decided 5 minutes before a timer run is escalated by the next one, within threshold + interval, and every guide states that bound', async t => {
  for (const intervalMs of [TIMER_MS, 600000]) {
    const f = fixture(t), q = f.ok('inbox.publish', question);
    f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
    // Decided at 00:25; the timer runs at 00:30 and then one interval later. Nothing is confirmed or recorded.
    const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
    const early = only(timerAt(f, t0 + 5 * MIN).retries, r => r.sendId === decided.sendId);
    assert.ok(early.send, 're-sent'); assert.equal(early.escalateDue, null, 'five minutes old: not yet escalated');
    const next = only(timerAt(f, t0 + 5 * MIN + intervalMs).retries, r => r.sendId === decided.sendId);
    const waited = (5 * MIN + intervalMs) / MIN;
    assert.ok(next.escalateDue, `escalated by the next timer run, ${waited} minutes after the decision`);
    assert.match(escalateAt(f, decided.sendId, t0 + 5 * MIN + intervalMs).payload.context, new RegExp(`still not confirmed sent ${waited} minutes after it was decided`));
    assert.ok(waited < 10 + intervalMs / MIN, 'within threshold + interval');
  }
  // The stated bound is threshold + interval, not the interval alone.
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), handling = read('../starter/project/integrations/t3-notifications.example.md');
  const guide = read('../docs/integrations/t3.md'), script = read('../starter/project/integrations/triage.example.mjs'), record = read('../docs/changes/dev86-proxy-j7-j9.md');
  assert.match(brief, /within 10 minutes plus the timer interval: under 40 minutes with the default 30-minute timer, under 20 minutes with `"everyMs": 600000`/);
  assert.match(handling, /within ten minutes plus the timer interval \(under 40 minutes with the default 30-minute timer\)/);
  assert.match(guide, /within the threshold plus the timer interval: under 40 minutes with the default 30-minute timer/);
  assert.match(guide, /within 10 minutes plus the interval, so under 40 minutes/);
  assert.match(script, /within ESCALATE_MINUTES \+ the timer interval/);
  assert.match(record, /within threshold \+ timer interval/);
  for (const [name, text] of Object.entries({ brief, handling, guide, script })) assert.doesNotMatch(text, /at most 30 minutes/, `${name} no longer states the interval alone`);
});

// ---- dev.87: findings K1 and K5 of the dev.86 readiness re-test ------------------------------------

test('K1 repro: a forward re-sent and confirmed in the same run is never escalated; a notice already published stays for the operator, and the next forward says it is moot', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  // Left unconfirmed for hours (as across the dev.86 upgrade). The next run re-sends it and marks it due for escalation.
  const step = only(digestAt(f, t0 + 643 * MIN).retries, r => r.sendId === decided.sendId);
  assert.ok(step.send); assert.match(step.escalateDue, /still not confirmed sent 643 minutes after it was decided/);
  assert.equal(step.escalate, undefined, 'no notice is printed beside a send');
  // The trial's order: the send is confirmed 17 s later; the escalation, asked for after it, is not given.
  confirmSent(decided.sendId, { ...f.files, nowMs: t0 + 643 * MIN + 17000 });
  const asked = json(cli(['--escalate', decided.sendId, '--memory', f.files.memoryPath, '--log', f.files.logPath]));
  assert.equal(asked.escalate, null); assert.match(asked.reason, /confirmed sent or closed/);
  assert.equal(triage.counts(logOf(f)).escalations, 0);
  assert.deepEqual(f.store.all('inbox').filter(row => String(row.id).startsWith('triage-undelivered-')), [], 'no notice reached the operator');

  // Escalated and published first, then the forwards are confirmed. One notice covers both forwards of the session (dev.88); it stays, and is moot once both are delivered.
  const g = fixture(t), r = g.ok('inbox.publish', { ...question, title: 'Fictional second' }), s = g.ok('inbox.publish', { ...question, title: 'Fictional third' });
  g.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const bodies = await g.deliver(), d2 = wakeAt(g, only(bodies, b => b.inboxId === r.id), t0), d3 = wakeAt(g, only(bodies, b => b.inboxId === s.id), t0 + 1000);
  digestAt(g, t0 + 11 * MIN);
  const notice = escalateAt(g, d2.sendId, t0 + 11 * MIN + 1000);
  assert.match(notice.payload.context, /This notice is informational, and it stays until you dismiss it: the proxy never withdraws it/);
  assert.ok(notice.payload.context.includes(`triage.mjs --verify ${d2.sendId} (it shows when the proxy confirmed sending it) or triage.mjs --forwards --unconfirmed`), 'it says how to check delivery since');
  assert.match(notice.payload.title, / and 1 more forward\(s\)$/); assert.ok(notice.payload.context.includes(`send ${d3.sendId}`), 'it lists the other forward');
  const published = g.ok('inbox.publish', notice.payload, { actor: 'orchestrator' });
  assert.deepEqual(triage.markEscalated(d2.sendId, { ...g.files, read: g.view({ inbox: published.id }) }).covers, [d2.sendId, d3.sendId]);
  assert.equal(escalateAt(g, d3.sendId, t0 + 11 * MIN + 2000), null, 'covered: not published again');
  const sent = confirmSent(d2.sendId, { ...g.files, to: THREAD, nowMs: t0 + 12 * MIN });
  assert.deepEqual(sent, { recorded: 'sent', sendId: d2.sendId, to: THREAD }, 'nothing to withdraw: the proxy withdraws nothing');
  assert.equal(g.store.need('inbox', published.id).status, 'open', 'the notice stays for the operator');
  // The send reached THREAD: the outage is over, and the next delivery forward says its notice is moot, once (dev.88).
  const u = g.ok('inbox.publish', { kind: 'notice', title: 'Fictional later notice', context: 'Fictional.' });
  const next = wakeAt(g, only(await g.deliver(), b => b.inboxId === u.id), t0 + 13 * MIN);
  assert.match(next.forward, new RegExp(`Escalation notices now moot \\(data\\): ${published.id} \\(a send to ${THREAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} was confirmed at `));
  assert.match(next.forward, /Tell the operator they can dismiss them; the proxy withdraws nothing\./);
  const w = g.ok('inbox.publish', { kind: 'notice', title: 'Fictional last notice', context: 'Fictional.' });
  assert.doesNotMatch(wakeAt(g, only(await g.deliver(), b => b.inboxId === w.id), t0 + 15 * MIN).forward, /now moot/, 'said once');
  assert.equal(escalateAt(g, d3.sendId, t0 + 15 * MIN + 1000) === null, false, 'd3 is still undelivered and its outage notice is gone: a later escalation is a new outage');
  // The trial's exact order with an older brief: the notice was made, the send confirmed, and only then the notice published.
  const h = fixture(t), x = h.ok('inbox.publish', { ...question, title: 'Fictional fourth' });
  h.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const d4 = wakeAt(h, only(await h.deliver(), b => b.inboxId === x.id), t0);
  digestAt(h, t0 + 11 * MIN);
  const late = escalateAt(h, d4.sendId, t0 + 12 * MIN + 1000);
  confirmSent(d4.sendId, { ...h.files, to: THREAD, nowMs: t0 + 12 * MIN + 2000 });
  const stale = h.ok('inbox.publish', late.payload, { actor: 'orchestrator' });
  const marked = triage.markEscalated(d4.sendId, { ...h.files, read: h.view({ inbox: stale.id }) });
  assert.match(marked.note, /the outage it was about ended before its read-back: it covers nothing, stays for the operator to dismiss/);
  const y = h.ok('inbox.publish', { kind: 'notice', title: 'Fictional later', context: 'Fictional.' });
  assert.match(wakeAt(h, only(await h.deliver(), b => b.inboxId === y.id), t0 + 13 * MIN).forward, new RegExp(`Escalation notices now moot \\(data\\): ${stale.id} \\(its outage had ended before it was published`));
  assert.ok(!JSON.stringify([sent, marked, next]).includes('inbox.withdraw'));
});

test('K1: an unconfirmed forward whose item is no longer open is closed as obsolete by the next run that reads the open items; it is neither re-sent nor escalated, and its notice is moot once the destination is reached again', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), n = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional operator notice', context: 'Fictional.' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), bodies = await f.deliver();
  const qd = wakeAt(f, only(bodies, b => b.inboxId === q.id), t0), nd = wakeAt(f, only(bodies, b => b.inboxId === n.id), t0 + 1000);
  digestAt(f, t0 + 11 * MIN);
  const notice = escalateAt(f, qd.sendId, t0 + 11 * MIN + 1000), published = f.ok('inbox.publish', notice.payload, { actor: 'orchestrator' });
  triage.markEscalated(qd.sendId, { ...f.files, read: f.view({ inbox: published.id }) });
  // The operator answers the question and dismisses the notice in the console.
  const item = f.store.need('inbox', q.id);
  f.ok('answer', { inboxId: q.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'a' });
  f.ok('inbox.ack', { inboxId: n.id });
  const answered = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id && b.event === 'inbox.resolved'), t0 + 12 * MIN);
  assert.equal(answered.rule, 'answered', 'the answer itself is forwarded');
  assert.deepEqual(answered.closed.map(c => [c.sendId, c.closed]).sort(), [[qd.sendId, 'obsolete'], [nd.sendId, 'obsolete']].sort());
  assert.deepEqual(answered.retries, [], 'neither is re-sent');
  const closedQ = answered.closed.find(c => c.sendId === qd.sendId);
  assert.match(closedQ.reason, new RegExp(`inbox item ${q.id} is no longer open`)); assert.match(closedQ.about, /^Operator question: “Fictional choice”/);
  assert.equal(closedQ.resolve, undefined, 'the proxy withdraws nothing'); assert.equal(f.store.need('inbox', published.id).status, 'open');
  assert.equal(triage.escalateNow(qd.sendId, f.files).escalate, null);
  assert.deepEqual(triage.unconfirmedForwards(logOf(f)).map(row => row.sendId), [answered.sendId], 'closed forwards are no longer listed');
  assert.equal(triage.counts(logOf(f)).obsolete, 2);
  // A timer run reads the open items too; a resolution forward (the answer) is never obsolete.
  const later = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional later notice', context: 'Fictional.' });
  const ld = wakeAt(f, only(await f.deliver(), b => b.inboxId === later.id), t0 + 13 * MIN);
  // Closing forwards does not end the outage (dev.88): its notice is moot once a send to THREAD is confirmed.
  assert.doesNotMatch(ld.forward, /now moot/);
  f.ok('inbox.ack', { inboxId: later.id });
  const timer = timerAt(f, t0 + 16 * MIN);
  assert.deepEqual(timer.closed.map(c => c.sendId), [ld.sendId]);
  assert.deepEqual(timer.retries.map(r => r.sendId), [answered.sendId]);
  confirmSent(answered.sendId, { ...f.files, to: THREAD, nowMs: t0 + 17 * MIN });
  const after = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional notice after that', context: 'Fictional.' });
  assert.match(wakeAt(f, only(await f.deliver(), b => b.inboxId === after.id), t0 + 18 * MIN).forward, new RegExp(`Escalation notices now moot \\(data\\): ${published.id} \\(a send to `));
  // An item open at a newer version than the forward was about is obsolete too.
  assert.match(triage.obsoleteBy({ event: 'inbox.attention', inboxId: 'x-1', version: 1, rule: 'operator-question' }, [{ id: 'x-1', version: 2 }]), /open at version 2, newer than the version 1/);
  assert.equal(triage.obsoleteBy({ event: 'inbox.attention', inboxId: 'x-1', version: 1, rule: 'operator-question' }, [{ id: 'x-1', version: 1 }]), null);
  assert.equal(triage.obsoleteBy({ event: 'inbox.attention', inboxId: 'x-1', version: 1 }, null), null, 'no read of the open items: nothing is closed');
});

test('K1 and K5: a forward kept before dev.86 (no text) is re-sent and escalated under what the log has, never a raw send ID, and closed once its item has moved on', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', { ...question, title: 'Fictional ledger name question' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), body = only(await f.deliver(), b => b.inboxId === q.id), decided = wakeAt(f, body, t0);
  // The pending row as a dev.85 proxy kept it: no text, rule, item or event.
  const kept = JSON.parse(readFileSync(f.files.memoryPath, 'utf8'));
  kept.pending[decided.sendId] = { kind: 'delivery', at: kept.pending[decided.sendId].at, deliveryId: body.deliveryId, forwardTo: THREAD, forwardSource: 'session' };
  writeFileSync(f.files.memoryPath, JSON.stringify(kept));
  const step = only(digestAt(f, t0 + 643 * MIN).retries, r => r.sendId === decided.sendId);
  const [headline] = step.send.message.split('\n');
  assert.match(headline, /^\[Factotum via triage\] Re-sent \(decided [^)]*, not confirmed sent since; its facts are from then, so read the item before acting\): Operator question: “Fictional ledger name question”/);
  assert.match(step.send.message, /Its full text was not kept/); assert.match(step.send.message, /rule operator-question/);
  assert.ok(step.send.message.includes(`inbox ${q.id} v1`)); assert.ok(step.send.message.includes(`status --inbox ${q.id}`));
  assert.equal(step.about, 'Operator question: “Fictional ledger name question”');
  const notice = escalateAt(f, decided.sendId, t0 + 643 * MIN + 1000);
  assert.equal(notice.payload.title, 'Not delivered to the orchestrator: Operator question: “Fictional ledger name question”');
  assert.ok(!notice.payload.title.includes(body.deliveryId.slice(0, 12)), 'the title is not a raw send ID');
  assert.match(notice.payload.context, /its full text was not kept: a forward decided before dev\.86/);
  // A re-send of a forward with text also says its facts are from when it was decided.
  const r = f.ok('inbox.publish', { ...question, title: 'Fictional newer question' });
  const newer = wakeAt(f, only(await f.deliver(), b => b.inboxId === r.id), t0 + 643 * MIN + 2000);
  const again = only(digestAt(f, t0 + 646 * MIN).retries, x => x.sendId === newer.sendId);
  assert.match(again.send.message, /^\[Factotum via triage\] Re-sent \(decided [^)]*; its facts are from then, so read the item before acting\): Operator question open: “Fictional newer question”/);
  // The question was answered long ago: the next run that reads the open items closes it.
  const item = f.store.need('inbox', q.id);
  f.ok('answer', { inboxId: q.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'b' });
  assert.deepEqual(timerAt(f, t0 + 650 * MIN).closed.map(c => [c.sendId, c.closed]), [[decided.sendId, 'obsolete']]);
});

test('K5: a forward of a notice only the operator may acknowledge does not ask the orchestrator to run delivery.ack, which Factotum refuses', async t => {
  const f = fixture(t), n = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional session reset notice', context: 'Fictional.' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  f.store.tx(() => f.store.put('inbox', { ...f.store.need('inbox', n.id), operatorAckOnly: true }));
  const body = only(await f.deliver(), b => b.inboxId === n.id), out = f.wake(body), last = out.forward.split('\n').at(-1);
  assert.doesNotMatch(last, /After handling, run delivery\.ack/);
  assert.match(last, /Only the operator can acknowledge this notice and its delivery: do not run delivery\.ack or inbox\.ack for it/);
  assert.match(out.forward, /Asked of you: A notice for the operator\. Tell them in one line what it is\. Only the operator can acknowledge it and its delivery/);
  // What the line says matches what Factotum does.
  assert.notEqual(f.command('delivery.ack', { deliveryId: body.deliveryId }, { actor: 'orchestrator' }).status, 'completed');
  // An ordinary notice still asks for it.
  const m = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional ordinary notice', context: 'Fictional.' });
  assert.match(f.wake(only(await f.deliver(), b => b.inboxId === m.id)).forward.split('\n').at(-1), /After handling, run delivery\.ack/);
});

test('K5 (dev.88): a destination that failed two other forwards is down for the next one after its first failure; the operator is told, and nothing goes to another thread', async t => {
  const f = fixture(t), DEAD = `mcp:launch:${'0'.repeat(56)}dead0087`;
  const a = f.ok('inbox.publish', { ...question, title: 'Fictional first' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), first = wakeAt(f, only(await f.deliver(), b => b.inboxId === a.id), t0);
  confirmSent(first.sendId, f.files);
  // The session is bound to a thread that does not exist (the dev.86 J7 test).
  f.ok('orchestrator.session', { sessionId: DEAD }, { actor: 'orchestrator' });
  const b = f.ok('inbox.publish', { ...question, title: 'Fictional second' });
  const second = wakeAt(f, only(await f.deliver(), x => x.inboxId === b.id), t0 + 1000);
  assert.equal(second.forwardTo, DEAD);
  const read = () => f.view({ inbox: b.id });
  assert.equal(triage.sendFailed(second.sendId, { ...f.files, to: DEAD, error: 'thread_not_found', read: read(), nowMs: t0 + 2000 }).next.send.threadId, DEAD, 'the bound session once more');
  const next = triage.sendFailed(second.sendId, { ...f.files, to: DEAD, error: 'thread_not_found', read: read(), nowMs: t0 + 3000 }).next;
  assert.equal(next.send, null, 'no other thread, ever (THREAD reached the orchestrator a second ago)');
  assert.match(next.escalateDue, new RegExp(`the orchestrator session ${DEAD} failed 2 send\\(s\\) of it`));
  const c = f.ok('inbox.publish', { ...question, title: 'Fictional third' });
  const third = wakeAt(f, only(await f.deliver(), x => x.inboxId === c.id), t0 + 4000);
  const after = triage.sendFailed(third.sendId, { ...f.files, to: DEAD, error: 'thread_not_found', read: f.view({ inbox: c.id }), nowMs: t0 + 5000 }).next;
  assert.equal(after.send, null); assert.match(after.escalateDue, /failed 1 send\(s\) of it/);
  // Later runs keep sending to the bound session only.
  assert.deepEqual(timerAt(f, t0 + 4 * MIN).retries.map(r => r.send?.threadId), [DEAD, DEAD]);
  assert.ok(!logOf(f).some(e => e.decision === 'retry' && e.forwardTo === THREAD));
  assert.equal(memoryOf(f).lastConfirmedThread, undefined, 'no record of other threads to send to');
});

test('K5: a forward the orchestrator handled from state and recorded is closed as handled, not re-sent; the guides say to wake the proxy after a rebind', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now() - 5 * MIN, decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  json(cli(['--missed', '--kind', 'undelivered', '--note', 'Fictional: handled from state after the rebind', '--ref', decided.sendId, '--for', THREAD, '--log', f.files.logPath]));
  const run = digestAt(f, t0 + 6 * MIN);
  assert.deepEqual(run.closed.map(c => [c.sendId, c.closed]), [[decided.sendId, 'handled']]);
  assert.deepEqual(run.retries, []); assert.equal(triage.counts(logOf(f)).handled, 1);
  // The guides.
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), handling = read('../starter/project/integrations/t3-notifications.example.md'), guide = read('../docs/integrations/t3.md');
  for (const text of ['`TRIAGE --escalate <sendId>`', 'a send confirmed in this run is never escalated', '`escalateDue`', 'never withdraw or dismiss an escalation notice, even your own'])
    assert.ok(brief.includes(text), `the brief says ${text}`);
  for (const text of ['**After binding**', 'run_scheduled_task_now {"taskId":"<triageTimerTaskId>"}', 'Either record closes the forward: the proxy does not send it again', '`operatorAckOnly: true`', '`superseded` (a newer delivery', '`triageTimerDisabledAt`', 'Read state first', '`unknown` (for example while a main verification is in progress) is not green', 'Earlier forwards not yet confirmed sent when this was decided', 'the proxy never withdraws it', 'Escalation notices now moot'])
    assert.ok(handling.includes(text), `the handling guide says ${text}`);
  for (const text of ['**A rebind wakes nothing by itself.**', '**Forwards closed without a send**', '**The notice stays for the operator.**', '**No fallback**'])
    assert.ok(guide.includes(text), `the integration guide says ${text}`);
  assert.doesNotMatch(handling, /main health \(`mainHealth`\) is not `red`/);
});

// ---- review of 55fccf4 (GPT-6.1 Sol): P2-1, P2-2 and the protocol version --------------------------

test('re-check P2-1: the proxy cannot prove it published a notice, so it withdraws nothing, even one with the offered ID and exact content published by someone else', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  digestAt(f, t0 + 11 * MIN);
  const offer = escalateAt(f, decided.sendId, t0 + 11 * MIN + 1000);
  // The repro: another orchestrator-role publisher publishes the offered ID, kind, title and context first, with links.
  const lookalike = f.ok('inbox.publish', { ...offer.payload, links: [{ label: 'Fictional link', url: 'https://example.invalid/x' }] }, { actor: 'orchestrator' });
  // Its read-back matches the content, so it is recorded as the escalation (the proxy cannot tell the difference)...
  assert.equal(triage.markEscalated(decided.sendId, { ...f.files, read: f.view({ inbox: lookalike.id }) }).recorded, 'escalated');
  // ...but nothing the proxy prints ever withdraws it.
  const outputs = [confirmSent(decided.sendId, { ...f.files, to: THREAD, nowMs: t0 + 12 * MIN }), triage.markEscalated(decided.sendId, { ...f.files, read: f.view({ inbox: lookalike.id }) }), timerAt(f, t0 + 13 * MIN)];
  assert.ok(!JSON.stringify(outputs).includes('inbox.withdraw'), 'no withdrawal is ever offered');
  assert.ok(outputs.every(out => out.resolve === undefined));
  assert.equal(f.store.need('inbox', lookalike.id).status, 'open');
  assert.equal(triage.withdrawNotice, undefined, 'no --withdraw command'); assert.doesNotMatch(triage.USAGE, /--withdraw/);
  // A mismatched holder of an offered ID still makes the proxy offer the notice again under a new ID.
  const g = fixture(t), r = g.ok('inbox.publish', question);
  g.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const d2 = wakeAt(g, only(await g.deliver(), b => b.inboxId === r.id), t0);
  digestAt(g, t0 + 11 * MIN);
  const offered = escalateAt(g, d2.sendId, t0 + 11 * MIN + 1000);
  const squatter = g.ok('inbox.publish', { kind: 'notice', id: offered.payload.id, title: 'Fictional squatter', context: 'Fictional.' }, { actor: 'orchestrator' });
  const again = triage.markEscalated(d2.sendId, { ...g.files, read: g.view({ inbox: squatter.id }) });
  assert.equal(again.recorded, 'not-escalated'); assert.notEqual(again.escalate.payload.id, squatter.id);
  // The guides: the brief allows no withdrawal at all, and the integration guide says why.
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), guide = read('../docs/integrations/t3.md');
  assert.doesNotMatch(brief, /inbox\.withdraw|TRIAGE --withdraw|`resolve`/);
  assert.match(brief, /present or withdraw anything;/);
  assert.match(guide, /\*\*The notice stays for the operator\.\*\*/);
});

test('review P2-2: a delayed confirmation is credited to the thread that send reached, not to where a rebind moved the send', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), B = 'fictional-thread-b';
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  // Run A sent it to THREAD and pauses before --sent. The operator rebinds to B; a later run sends it to B, which fails twice.
  f.ok('orchestrator.session', { sessionId: B }, { actor: 'orchestrator' });
  assert.equal(only(timerAt(f, t0 + 3 * MIN).retries, r => r.sendId === decided.sendId).send.threadId, B);
  const read = () => f.view({ inbox: q.id });
  triage.sendFailed(decided.sendId, { ...f.files, to: B, error: 'fictional failure', read: read(), nowMs: t0 + 3 * MIN + 1000 });
  triage.sendFailed(decided.sendId, { ...f.files, to: B, error: 'fictional failure', read: read(), nowMs: t0 + 3 * MIN + 2000 });
  // Run A's delayed --sent, naming the thread it used.
  const confirmed = confirmSent(decided.sendId, { ...f.files, to: THREAD, nowMs: t0 + 3 * MIN + 3000 });
  const state = memoryOf(f);
  assert.equal(state.failedThreads[B].failures, 2, 'B keeps its failures'); assert.equal(state.failedThreads[THREAD], undefined);
  assert.equal(confirmed.to, THREAD);
  assert.equal(logOf(f).at(-1).forwardTo, THREAD);
  // A thread the send ID was never handed out for is refused, by the function and the command line.
  const r = f.ok('inbox.publish', { ...question, title: 'Fictional second' });
  const other = wakeAt(f, only(await f.deliver(), b => b.inboxId === r.id), t0 + 6000);
  assert.throws(() => confirmSent(other.sendId, { ...f.files, to: 'fictional-never-used' }), /was never handed out for thread fictional-never-used .*Do not send it again/);
  const missing = cli(['--sent', other.sendId, '--memory', f.files.memoryPath, '--log', f.files.logPath]);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /--to is required: the threadId of the send object/);
  // The brief passes it from the send object.
  const brief = readFileSync(fileURLToPath(new URL('../starter/project/integrations/t3-triage.example.md', import.meta.url)), 'utf8');
  assert.ok(brief.includes('`TRIAGE --sent <sendId> --to <threadId>`, with the `threadId` of the `send` object you just used'));
  assert.ok(brief.includes('`TRIAGE --send-failed <sendId> --to <threadId> --error'));
});

test('review: a missing or different protocol version fails loudly and tells the orchestrator to copy the guides again', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: q.id })));
  f.wake(body); // the proxy has seen the bound session
  const raw = (args, input = '') => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', input });
  const wake = ['--project', f.projectId, '--state', f.files.statePath, '--memory', f.files.memoryPath, '--log', f.files.logPath];
  const before = readFileSync(f.files.logPath, 'utf8');
  for (const version of [null, '87']) {
    const r = raw(version ? [...wake, '--protocol', version] : wake, JSON.stringify(body));
    assert.equal(r.status, 1, 'fails loudly'); assert.match(r.stderr, /copy the brief and handling guide again/);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.decision, out.rule, out.forwardTo], ['forward', 'protocol-mismatch', THREAD], 'a run still reaches the orchestrator');
    assert.match(out.forward, /copy the brief and handling guide again/); assert.deepEqual(out.send, { threadId: THREAD, message: out.forward, mode: 'queue' });
  }
  assert.equal(readFileSync(f.files.logPath, 'utf8'), before, 'nothing recorded');
  for (const args of [['--sent', 'x:1', '--to', THREAD, '--memory', f.files.memoryPath, '--log', f.files.logPath, '--protocol', '87'], ['--counts', '--log', f.files.logPath], ['--escalate', 'x:1', '--memory', f.files.memoryPath, '--log', f.files.logPath]]) {
    const r = raw(args);
    assert.equal(r.status, 1, args.join(' ')); assert.match(r.stderr, /expects protocol 90 .*copy the brief and handling guide again/);
  }
  assert.equal(raw(['--counts', '--log', f.files.logPath, '--protocol', '90']).status, 0);
  // Both guides pass it.
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  assert.match(read('../starter/project/integrations/t3-triage.example.md'), /--forward-to \[\[orchestrator-thread-id\]\] --factory-state \[\[state-dir\]\] --protocol 90`, always exactly this/);
  assert.match(read('../starter/project/integrations/t3-notifications.example.md'), /log\.jsonl --protocol 90`/);
  assert.equal(triage.PROTOCOL, 90);
});

// ---- re-check of 2ca04f9 (GPT-6.1 Sol): P2-2 and P2-3 ---------------------------------------------

test('re-check P2-2: --sent checks the thread on every path; a send already confirmed is a no-op that changes nothing, and a thread it never went to is refused', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id), decided = f.wake(body);
  confirmSent(decided.sendId, { ...f.files, to: THREAD });
  const memoryBefore = readFileSync(f.files.memoryPath, 'utf8'), logBefore = readFileSync(f.files.logPath, 'utf8');
  // The repro: a confirmation by delivery ID naming a thread the send never went to.
  const attack = cli(['--sent', body.deliveryId, '--to', 'attacker-never-used', '--memory', f.files.memoryPath, '--log', f.files.logPath]);
  assert.equal(attack.status, 1, 'refused'); assert.match(attack.stderr, /was never handed out for thread attacker-never-used/);
  // The same send confirmed again, by delivery ID or send ID, for the thread it reached: a no-op.
  for (const id of [body.deliveryId, decided.sendId]) {
    const again = json(cli(['--sent', id, '--to', THREAD, '--memory', f.files.memoryPath, '--log', f.files.logPath]));
    assert.equal(again.recorded, 'already-sent');
  }
  assert.equal(readFileSync(f.files.memoryPath, 'utf8'), memoryBefore, 'the state file is unchanged, lastConfirmedThread included');
  assert.equal(readFileSync(f.files.logPath, 'utf8'), logBefore, 'nothing logged');
});

test('re-check P2-3: a pending row kept before dev.87 keeps the thread it was addressed to when a retry goes elsewhere, so a delayed confirmation for it is accepted', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), B = `mcp:launch:${'b0'.repeat(32)}`;
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  // The row as dev.86 kept it: addressed to THREAD, with no list of destinations.
  const kept = JSON.parse(readFileSync(f.files.memoryPath, 'utf8'));
  delete kept.pending[decided.sendId].sentTo;
  writeFileSync(f.files.memoryPath, JSON.stringify(kept));
  // B is bound; a timer run retries the forward to B.
  f.ok('orchestrator.session', { sessionId: B }, { actor: 'orchestrator' });
  const retry = only(timerAt(f, t0 + 3 * MIN).retries, r => r.sendId === decided.sendId);
  assert.equal(retry.send.threadId, B);
  assert.deepEqual(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending[decided.sendId].sentTo, [THREAD, B], 'the list starts from the thread it was addressed to');
  // The first send, to THREAD, is confirmed late: accepted and credited to THREAD.
  assert.equal(confirmSent(decided.sendId, { ...f.files, to: THREAD, nowMs: t0 + 3 * MIN + 5000 }).to, THREAD);
});

test('re-check of 81f35f1: many retries to one thread list it once, so the thread a legacy row was addressed to stays accepted', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), B = `mcp:launch:${'b1'.repeat(32)}`;
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  const kept = JSON.parse(readFileSync(f.files.memoryPath, 'utf8'));
  delete kept.pending[decided.sendId].sentTo;
  writeFileSync(f.files.memoryPath, JSON.stringify(kept));
  f.ok('orchestrator.session', { sessionId: B }, { actor: 'orchestrator' });
  for (let i = 1; i <= 55; i += 1) timerAt(f, t0 + i * 3 * MIN);
  assert.deepEqual(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).pending[decided.sendId].sentTo, [THREAD, B], 'each thread once, the original kept');
  assert.equal(confirmSent(decided.sendId, { ...f.files, to: THREAD, nowMs: t0 + 170 * MIN }).to, THREAD);
});

// ---- dev.88: L1, L2 and L3 of the dev.87 readiness re-test -----------------------------------------
// The trial's round two: the bound session named a thread that did not exist, and the live
// orchestrator thread was the last thread a send had reached. See docs/changes/dev88-l-items.md.

const DEAD88 = `mcp:launch:${'0'.repeat(56)}dead0088`;
// A project whose orchestrator thread THREAD has received a forward, then bound to a missing thread.
async function roundTwo(t) {
  const f = fixture(t), a = f.ok('inbox.publish', { ...question, title: 'Fictional earlier question' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), first = wakeAt(f, only(await f.deliver(), b => b.inboxId === a.id), t0, { forwardTo: THREAD });
  confirmSent(first.sendId, { ...f.files, to: THREAD });
  f.ok('orchestrator.session', { sessionId: DEAD88 }, { actor: 'orchestrator' });
  const notice = async (title, at) => {
    const n = f.ok('inbox.publish', { kind: 'notice', title, context: 'Fictional: the bound session does not exist.' });
    const out = wakeAt(f, only(await f.deliver(), b => b.inboxId === n.id), at, { forwardTo: THREAD });
    assert.equal(out.forwardTo, DEAD88); return { n, out };
  };
  return { f, t0, notice };
}

test('L2 repro: a notice the operator acknowledges after a failed send is closed as obsolete by the re-read before the next send, never delivered', async t => {
  const { f, t0, notice } = await roundTwo(t), { n, out } = await notice('Fictional notice c', t0 + 1000);
  assert.equal(out.reread, `--inbox ${n.id}`, 'the step names the read to make after a failed send');
  const read = () => f.view({ inbox: n.id });
  const once = triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, forwardTo: THREAD, error: 'thread_not_found', read: read(), nowMs: t0 + 15000 });
  assert.equal(once.next.send.threadId, DEAD88, 'the bound session once more'); assert.equal(once.next.reread, `--inbox ${n.id}`);
  // The operator acknowledges the notice between the failure and the next send (the trial: 17:36:20).
  f.ok('inbox.ack', { inboxId: n.id });
  const twice = triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, forwardTo: THREAD, error: 'thread_not_found', read: read(), nowMs: t0 + 25000 });
  assert.equal(twice.next, null, 'nothing is sent: in dev.87 the same run delivered it to the last thread a send reached, saying "status open"');
  assert.deepEqual([twice.closed?.sendId, twice.closed?.closed], [out.sendId, 'obsolete']);
  assert.match(twice.closed.reason, new RegExp(`inbox item ${n.id} is no longer open`));
  assert.equal(triage.counts(logOf(f)).obsolete, 1);
  assert.deepEqual(triage.unconfirmedForwards(logOf(f)).map(r => r.sendId), []);
  assert.equal(triage.escalateNow(out.sendId, f.files).escalate, null, 'nothing to tell the operator');
  assert.ok(!logOf(f).some(e => e.decision === 'retry' && e.forwardTo === THREAD), 'never offered to a thread that is not the bound session');
});

test('L2 (dev.88): when the bound session is down the operator is told; the forward goes nowhere else, and waits for a send there to work or a rebind', async t => {
  const { f, t0, notice } = await roundTwo(t), { n, out } = await notice('Fictional notice a', t0 + 1000);
  const read = () => f.view({ inbox: n.id }), failed = at => triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  failed(t0 + 15000);
  const down = failed(t0 + 25000).next;
  assert.equal(down.send, null, 'no send to another thread');
  assert.match(down.escalateDue, new RegExp(`^the orchestrator session ${DEAD88} failed 2 send\\(s\\) of it \\(last error: thread_not_found\\); forwards wait until a send there works or another session is bound$`));
  const asked = escalateAt(f, out.sendId, t0 + 30000);
  assert.ok(asked, 'escalated (dev.87: escalations 0)'); assert.match(asked.payload.context, /check it \(status --compact, orchestratorSession\) and bind the right orchestrator thread/);
  assert.match(asked.payload.context, /The proxy sends forwards only to the bound session: they wait until a send there works or another session is bound/);
  const published = f.ok('inbox.publish', asked.payload, { actor: 'orchestrator' });
  assert.deepEqual(triage.markEscalated(out.sendId, { ...f.files, read: f.view({ inbox: published.id }) }).covers, [out.sendId]);
  // The next runs send it to the bound session only, without escalating again.
  const retry = only(timerAt(f, t0 + 4 * MIN).retries, r => r.sendId === out.sendId);
  assert.deepEqual([retry.send.threadId, retry.escalateDue, retry.reread], [DEAD88, null, `--inbox ${n.id}`]);
  assert.doesNotMatch(retry.send.message, /Fallback/);
  assert.equal(failed(t0 + 4 * MIN + 10000).next, null, 'down: nothing more this run');
  // The operator rebinds to the live thread: the next run sends it there, and the old notice is moot.
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const rebound = only(timerAt(f, t0 + 8 * MIN).retries, r => r.sendId === out.sendId);
  assert.deepEqual([rebound.send.threadId, rebound.forwardSource], [THREAD, 'session']);
  assert.deepEqual(confirmSent(out.sendId, { ...f.files, to: THREAD }), { recorded: 'sent', sendId: out.sendId, to: THREAD });
  assert.match(memoryOf(f).mootEscalations.map(m => m.why).join(' '), new RegExp(`rebound from ${DEAD88} to ${THREAD}`));
  const c = triage.counts(logOf(f)); assert.deepEqual([c.escalations, c.forwarded >= 2], [1, true]);
});

test('L2: an attention forward is never sent again without a fresh read; a forward about nothing open needs none, and a digest run reads the compact view', async t => {
  const { f, t0, notice } = await roundTwo(t), { n, out } = await notice('Fictional notice b', t0 + 1000);
  // --send-failed with no read: recorded, but not sent again in this run.
  const blind = triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, forwardTo: THREAD, error: 'thread_not_found', nowMs: t0 + 15000 });
  assert.equal(blind.next, null); assert.match(blind.note, new RegExp(`not sent again in this run: the item was not read again \\(run status --inbox ${n.id} and pass it with --state\\)`));
  // A run that read nothing offers no re-send of it; one that read the open items does.
  assert.deepEqual(runRecorded('digest', { ...f.files, input: '', nowMs: t0 + 4 * MIN }).retries, []);
  assert.deepEqual(digestAt(f, t0 + 4 * MIN + 1000).retries.map(r => [r.sendId, r.send.threadId]), [[out.sendId, DEAD88]]);
  // A resolution forward reports something closed: its step names no read, and its failed send is planned without one.
  f.ok('inbox.ack', { inboxId: n.id });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const q = f.ok('inbox.publish', { ...question, title: 'Fictional answered question' }); await f.deliver();
  const item = f.store.need('inbox', q.id); f.ok('answer', { inboxId: q.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'a' });
  const answered = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id && b.event === 'inbox.resolved'), t0 + 5 * MIN);
  assert.equal(answered.rule, 'answered'); assert.equal(answered.reread, undefined);
  assert.equal(triage.sendFailed(answered.sendId, { ...f.files, to: THREAD, error: 'fictional failure', nowMs: t0 + 5 * MIN + 1000 }).next.send.threadId, THREAD);
});

test('L1 repro (dev.88): a forward the proxy sent outside its send object is refused at --sent with exact instructions, and recorded as misdirected, never sent elsewhere', async t => {
  const { f, t0, notice } = await roundTwo(t), { n, out } = await notice('Fictional notice j7r2-a', t0 + 1000);
  const once = triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: f.view({ inbox: n.id }), nowMs: t0 + 15000 });
  assert.equal(once.next.send.threadId, DEAD88);
  // The proxy model sent it to the configured orchestrator thread instead, then confirmed with that thread.
  const refused = cli(['--sent', out.sendId, '--to', THREAD, '--forward-to', THREAD, '--memory', f.files.memoryPath, '--log', f.files.logPath]);
  assert.equal(refused.status, 1, 'not the destination: refused, whatever --forward-to says');
  assert.match(refused.stderr, new RegExp(`was never handed out for thread ${THREAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*Do not send it again\\. If you sent the send object as printed, run --sent \\S+ --to <the threadId of that send object>\\. If you sent it to ${THREAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, the orchestrator session did not get it: run --send-failed \\S+ --to ${THREAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --error`));
  // Recording that is a misdirected send: no thread is charged with a failure, and it goes to the bound session again.
  writeFileSync(join(f.dir, 'reread.json'), JSON.stringify(f.view({ inbox: n.id })));
  const mis = json(cli(['--send-failed', out.sendId, '--to', THREAD, '--error', 'sent to a thread that was not in the send object', '--state', join(f.dir, 'reread.json'), '--memory', f.files.memoryPath, '--log', f.files.logPath]));
  assert.deepEqual([mis.misdirected, mis.next.send.threadId], [THREAD, DEAD88]);
  assert.equal(memoryOf(f).failedThreads?.[THREAD], undefined);
});

test('L3: the orchestrator lists and closes only forwards addressed to it and no longer in progress; --kind received records one that reached it unconfirmed', async t => {
  const f = fixture(t), qs = [0, 1, 2].map(i => f.ok('inbox.publish', { ...question, title: `Fictional question ${i}` }));
  f.ok('orchestrator.session', { sessionId: DEAD88 }, { actor: 'orchestrator' });
  const bodies = await f.deliver(), old = Date.now() - 5 * MIN;
  const forDead = wakeAt(f, only(bodies, b => b.inboxId === qs[0].id), old);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const mine = wakeAt(f, only(bodies, b => b.inboxId === qs[1].id), old + 500), arrived = wakeAt(f, only(bodies, b => b.inboxId === qs[2].id), old + 1000);
  const list = thread => json(cli(['--forwards', '--unconfirmed', '--for', thread, '--log', f.files.logPath]));
  assert.deepEqual(list(THREAD).map(r => [r.sendId, r.addressedTo, r.inProgress]), [[mine.sendId, THREAD, false], [arrived.sendId, THREAD, false]]);
  assert.deepEqual(list(DEAD88).map(r => r.sendId), [forDead.sendId], 'a forward decided for another session is not this thread\'s');
  assert.equal(triage.unconfirmedForwards(logOf(f), null, { forThread: THREAD, nowMs: old + 30000 })[0].inProgress, true, 'within two minutes of its send it may still arrive');
  const missed = (ref, extra, kind = 'undelivered') => cli(['--missed', '--kind', kind, '--note', 'Fictional: handled from state', '--ref', ref, ...extra, '--log', f.files.logPath]);
  assert.match(missed(forDead.sendId, []).stderr, /needs --for <this thread's ID>/);
  assert.match(missed(forDead.sendId, ['--for', THREAD]).stderr, new RegExp(`is addressed to ${DEAD88}, not ${THREAD}: leave it to the proxy`));
  assert.match(missed(forDead.sendId, ['--for', THREAD], 'received').stderr, new RegExp(`was never sent to ${THREAD} \\(only to ${DEAD88}\\), so it cannot have reached it`));
  assert.deepEqual(json(missed(mine.sendId, ['--for', THREAD])), { recorded: 'missed', kind: 'undelivered', closes: mine.sendId, note: 'the proxy closes it at its next run and does not send it again' });
  // A forward that reached this thread although the proxy lists it unconfirmed.
  assert.equal(json(missed(arrived.sendId, ['--for', THREAD], 'received')).closes, arrived.sendId);
  assert.match(missed('fictional-unknown:1', ['--for', THREAD], 'received').stderr, /is not an unconfirmed forward/);
  const run = timerAt(f, Date.now());
  assert.deepEqual(run.closed.map(c => [c.sendId, c.closed]).sort(), [[mine.sendId, 'handled'], [arrived.sendId, 'handled']].sort());
  assert.match(only(run.closed, c => c.sendId === arrived.sendId).reason, /recorded it as received/);
  // The rest is re-sent to the bound session; while that send may be in progress, it is not closed.
  assert.deepEqual(run.retries.map(r => [r.sendId, r.send.threadId]), [[forDead.sendId, THREAD]]);
  assert.match(missed(forDead.sendId, ['--for', THREAD]).stderr, /its send may be in progress\. Check again in two minutes/);
  const c = triage.counts(logOf(f)); assert.deepEqual([c.undelivered, c.received, c.handled], [1, 1, 2]);
});

test('L1 to L3: the brief, the handling guide and the integration guide say what the script now does', () => {
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), handling = read('../starter/project/integrations/t3-notifications.example.md'), guide = read('../docs/integrations/t3.md');
  for (const text of ['You send a forward only to the `threadId` of the `send` object', 'not even the orchestrator thread named in `TRIAGE`', 'If `--sent` is refused (it exits 1), never send the forward again', 'If the step you sent has `reread`, read the item again first', '--state WAKE/reread.json', 'do not look for another thread yourself', '`TRIAGE --digest --state WAKE/compact.json`', '--for <its thread id>'])
    assert.ok(brief.includes(text), `the brief says ${text}`);
  for (const text of ['**Unconfirmed forwards addressed to this thread.**', 'Only when this thread is the bound session', '`TRIAGE --forwards --unconfirmed --for <this thread id>`', '`inProgress: false`', '--kind received', 'never to another thread', 'A broken binding then waits for the operator', 'if a read shows another session bound, skip this step', 'skip step 3 until this thread is the bound session'])
    assert.ok(handling.includes(text), `the handling guide says ${text}`);
  for (const text of ['**A failed send** (dev.88)', '**No fallback**', '**One notice per outage** (dev.88)', '**A send outside its `send` object** (dev.88)', '`TRIAGE --forwards --unconfirmed --for <its thread id>`'])
    assert.ok(guide.includes(text), `the integration guide says ${text}`);
  assert.doesNotMatch(handling, /each listed forward was decided and never reached this thread/, 'the unscoped instruction is gone');
  for (const [name, text] of Object.entries({ brief, handling, guide })) assert.doesNotMatch(text.replace('as a fallback for a missing', ''), /--resend|offTarget|as a fallback|Fallback: you are not/, `${name}: no fallback path is described`);
  assert.match(brief, /when the bound session cannot be reached, forwards wait for it, or for the operator to bind another/);
});

// ---- review of 44a3127 (GPT-6.1 Sol): P2-1 to P2-5, P3, fallback speed, one notice per session, counts ----

test('review P2-1 of 44a3127: once one attempt of a delivery is confirmed, its other attempts are closed as delivered and never escalated', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id), t0 = Date.now();
  const a1 = wakeAt(f, body, t0), a2 = wakeAt(f, body, t0 + 1000);
  assert.deepEqual([a1.sendId, a2.sendId], [`${body.deliveryId}:1`, `${body.deliveryId}:2`]);
  confirmSent(a2.sendId, { ...f.files, to: THREAD, nowMs: t0 + 2000 });
  // The repro: two failures recorded for the first attempt, then --escalate.
  for (const at of [t0 + 3000, t0 + 4000]) assert.throws(() => triage.sendFailed(a1.sendId, { ...f.files, to: THREAD, error: 'thread_not_found', read: f.view({ inbox: q.id }), nowMs: at }), /no pending forward with that send ID/);
  assert.equal(triage.escalateNow(a1.sendId, { ...f.files, nowMs: t0 + 11 * MIN }).escalate, null);
  assert.deepEqual(logOf(f).filter(e => e.sendId === a1.sendId).map(e => e.decision), ['forward', 'delivered']);
  assert.deepEqual(triage.unconfirmedForwards(logOf(f)), []); assert.equal(triage.counts(logOf(f)).escalations, 0);
  // A state from before the fix, with the other attempt still pending: --escalate checks the delivery, and closes it.
  const g = fixture(t), r = g.ok('inbox.publish', question);
  g.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const rb = only(await g.deliver(), b => b.inboxId === r.id), b1 = wakeAt(g, rb, t0), b2 = wakeAt(g, rb, t0 + 1000);
  const kept = JSON.parse(readFileSync(g.files.memoryPath, 'utf8'));
  confirmSent(b2.sendId, { ...g.files, to: THREAD, nowMs: t0 + 2000 });
  const after = JSON.parse(readFileSync(g.files.memoryPath, 'utf8')); after.pending[b1.sendId] = kept.pending[b1.sendId];
  writeFileSync(g.files.memoryPath, JSON.stringify(after));
  const asked = triage.escalateNow(b1.sendId, { ...g.files, nowMs: t0 + 11 * MIN });
  assert.equal(asked.escalate, null); assert.equal(asked.closed.closed, 'delivered'); assert.match(asked.reason, /another send of delivery .* was confirmed/);
});

test('review P2-2 of 44a3127: a forward no run could re-read is still escalated, and never expires before the operator is told', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  // Runs that read nothing (an older digest brief, a failed read): no send, but the escalation is marked.
  const blind = at => runRecorded('digest', { ...f.files, input: '', nowMs: at });
  const step = only(blind(t0 + 11 * MIN).retries, r => r.sendId === decided.sendId);
  assert.equal(step.send, null); assert.match(step.escalateDue, /still not confirmed sent 11 minutes after it was decided/);
  // Past 24 hours it is not dropped while the operator has not been told.
  const late = only(blind(t0 + 25 * 60 * MIN).retries, r => r.sendId === decided.sendId);
  assert.equal(late.send, null); assert.ok(late.escalateDue);
  assert.ok(!logOf(f).some(e => e.decision === 'retry-expired'));
  assert.equal(triage.unconfirmedForwards(logOf(f)).length, 1);
  const notice = f.ok('inbox.publish', escalateAt(f, decided.sendId, t0 + 25 * 60 * MIN + 1000).payload, { actor: 'orchestrator' });
  triage.markEscalated(decided.sendId, { ...f.files, read: f.view({ inbox: notice.id }) });
  // Once told, the next run drops it, and says so in the log.
  assert.deepEqual(blind(t0 + 25 * 60 * MIN + 2000).retries, []);
  assert.match(only(logOf(f), e => e.decision === 'retry-expired').note, /and the operator was told of its current outage at /);
});

test('review P2-3 of 44a3127 (dev.88): however old the forward, and even after a verified notice, nothing goes to another thread', async t => {
  const { f, t0, notice } = await roundTwo(t), { n, out } = await notice('Fictional notice d', t0 + 1000);
  const read = () => f.view({ inbox: n.id }), late = t0 + 11 * MIN;
  triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: late });
  const down = triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: late + 1000 }).next;
  assert.equal(down.send, null); assert.ok(down.escalateDue);
  const published = f.ok('inbox.publish', escalateAt(f, out.sendId, late + 2000).payload, { actor: 'orchestrator' });
  assert.equal(triage.markEscalated(out.sendId, { ...f.files, read: f.view({ inbox: published.id }) }).resend, undefined, 'no fallback list');
  assert.equal(triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: late + 3000 }).next, null);
  assert.equal(typeof triage.resendNow, 'undefined', '--resend is gone');
  assert.ok(!logOf(f).some(e => e.forwardTo === THREAD && e.decision === 'retry'));
});

test('review P2-4 of 44a3127: a confirmation for a thread the send was not handed to is refused, whatever --forward-to says', async t => {
  const { f, t0, notice } = await roundTwo(t), { out } = await notice('Fictional notice f', t0 + 1000);
  const sent = (to, configured) => cli(['--sent', out.sendId, '--to', to, '--forward-to', configured, '--memory', f.files.memoryPath, '--log', f.files.logPath]);
  for (const [to, configured] of [['fictional-stranger', 'fictional-stranger'], [THREAD, THREAD]]) {
    const r = sent(to, configured);
    assert.equal(r.status, 1, `${to} refused`); assert.match(r.stderr, /was never handed out for thread/);
  }
  assert.equal(JSON.parse(sent(DEAD88, 'fictional-other').stdout).to, DEAD88, 'the thread it was handed to is accepted');
});

test('review P2-5 of 44a3127: --kind received closes only a forward that was handed to that thread', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), Date.now() - 5 * MIN);
  const received = thread => cli(['--missed', '--kind', 'received', '--note', 'Fictional', '--ref', decided.sendId, '--for', thread, '--log', f.files.logPath]);
  const r = received('fictional-stranger');
  assert.equal(r.status, 1); assert.match(r.stderr, /was never sent to fictional-stranger/);
  assert.ok(!logOf(f).some(e => e.decision === 'missed'), 'nothing recorded'); assert.equal(triage.unconfirmedForwards(logOf(f)).length, 1);
  assert.equal(json(received(THREAD)).closes, decided.sendId);
  assert.deepEqual(digestAt(f, Date.now()).closed.map(c => c.closed), ['handled']);
});

test('review P3 of 44a3127: the brief says digest runs read the open items, and its undelivered example passes --for', () => {
  const brief = readFileSync(fileURLToPath(new URL('../starter/project/integrations/t3-triage.example.md', import.meta.url)), 'utf8');
  assert.doesNotMatch(brief, /a digest run reads none, so it closes nothing this way/);
  assert.match(brief, /a digest run reads `status --compact` too/);
  for (const example of brief.match(/--kind undelivered --ref <sendId>[^`]*`/g) ?? []) assert.match(example, /--for /, example);
  assert.match(brief, /TRIAGE --missed --kind undelivered --ref <sendId> --for <its thread id>/);
});

test('one operator notice per outage: it lists the forwards due, later ones are covered without a new notice, and a new outage gets a new one', async t => {
  const { f, t0, notice } = await roundTwo(t);
  const items = [];
  for (const [i, title] of ['g', 'h', 'i'].entries()) items.push(await notice(`Fictional notice ${title}`, t0 + 1000 + i * 1000));
  const fail = ({ n, out }, at) => triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: f.view({ inbox: n.id }), nowMs: at });
  for (const item of items) { fail(item, t0 + 10000); fail(item, t0 + 11000); }
  const first = triage.escalateNow(items[0].out.sendId, { ...f.files, nowMs: t0 + 12000 });
  assert.deepEqual(first.covers, [items[1].out.sendId, items[2].out.sendId]);
  assert.match(first.escalate.payload.title, / and 2 more forward\(s\)$/); assert.match(first.escalate.payload.context, /This notice also covers 2 other forward\(s\)/);
  const published = f.ok('inbox.publish', first.escalate.payload, { actor: 'orchestrator' });
  assert.deepEqual(triage.markEscalated(items[0].out.sendId, { ...f.files, read: f.view({ inbox: published.id }) }).covers, items.map(i => i.out.sendId));
  for (const item of items.slice(1)) assert.equal(triage.escalateNow(item.out.sendId, { ...f.files, nowMs: t0 + 13000 }).escalate, null);
  // A later forward to the same destination is covered, with its own record, and no new notice.
  const later = await notice('Fictional notice j', t0 + 14000);
  fail(later, t0 + 15000);
  const covered = triage.escalateNow(later.out.sendId, { ...f.files, nowMs: t0 + 16000 });
  assert.deepEqual([covered.escalate, covered.coveredBy], [null, published.id]);
  assert.ok(logOf(f).some(e => e.decision === 'escalation-covered' && e.sendId === later.out.sendId));
  assert.equal(triage.counts(logOf(f)).escalations, 1, 'one notice');
  assert.ok(triage.unconfirmedForwards(logOf(f)).every(r => r.escalatedAt), 'every forward records that the operator was told');
  assert.equal(f.store.all('inbox').filter(row => String(row.id).startsWith('triage-undelivered-')).length, 1);
  // The destination is reached again, then lost again: that outage gets its own notice.
  confirmSent(items[0].out.sendId, { ...f.files, to: DEAD88 });
  const again = await notice('Fictional notice k', t0 + 20000);
  fail(again, t0 + 21000); fail(again, t0 + 22000);
  const fresh = triage.escalateNow(again.out.sendId, { ...f.files, nowMs: t0 + 23000 });
  assert.ok(fresh.escalate); assert.notEqual(fresh.escalate.payload.id, published.id);
});

test('counts: an absorbed delivery is reported on one forward only, and released again if that forward never arrives', async t => {
  const f = fixture(t), n = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional dismissed notice', context: 'Fictional.' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  await f.deliver(); f.ok('inbox.ack', { inboxId: n.id });
  const t0 = Date.now(); assert.equal(wakeAt(f, only(await f.deliver(), b => b.inboxId === n.id && b.event === 'inbox.resolved'), t0).decision, 'absorb');
  const qa = f.ok('inbox.publish', { ...question, title: 'Fictional a' }), qb = f.ok('inbox.publish', { ...question, title: 'Fictional b' }), qc = f.ok('inbox.publish', { ...question, title: 'Fictional c' });
  const bodies = await f.deliver();
  const a = wakeAt(f, only(bodies, b => b.inboxId === qa.id), t0 + 1000);
  assert.match(a.forward, /Absorbed since the last forward: 1 /);
  // A is never confirmed (the trial's j7r2-a): B does not report the same delivery again.
  const b = wakeAt(f, only(bodies, x => x.inboxId === qb.id), t0 + 2000);
  assert.match(b.forward, /Absorbed since the last forward: 0 /, 'dev.87 said 1 here too');
  // A is closed without reaching anyone: what it claimed is reported by the next forward.
  const item = f.store.need('inbox', qa.id); f.ok('answer', { inboxId: qa.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'a' });
  assert.deepEqual(digestAt(f, t0 + 3000).closed.map(c => c.sendId), [a.sendId]);
  assert.match(wakeAt(f, only(bodies, x => x.inboxId === qc.id), t0 + 4000).forward, /Absorbed since the last forward: 1 /);
  // A legacy counter is carried over once.
  assert.equal(triage.unreported({ absorbedSinceForward: 3 }), 3);
});

test('counts: each forward names the session its count belongs to, and says when another session is bound now', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: 'thread-one' }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  assert.equal(body.sessionVersion, 1, 'the payload names the session it was counted for');
  assert.ok(f.wake(body).forward.includes(`session delivery ${body.sessionDeliveries}/100 (session 1)`));
  // Dispatched for session 1, forwarded after session 2 was bound (the trial's 7/100 for session 11).
  const r = f.ok('inbox.publish', { ...question, title: 'Fictional later' });
  const later = only(await f.deliver(), b => b.inboxId === r.id);
  f.ok('orchestrator.session', { sessionId: 'thread-two' }, { actor: 'orchestrator' });
  assert.ok(f.wake(later).forward.includes(`session delivery ${later.sessionDeliveries}/100 (counted for session 1; the bound session is now 2, so this count is not part of its count)`));
  // A webhook prompt that does not pass it yet.
  const { sessionVersion, ...old } = later; void sessionVersion;
  assert.match(decide({ payload: old, state: f.view({ inbox: r.id }) }).forward, /\(session not named: this webhook prompt does not pass sessionVersion\)/);
  // Both prompts pass it.
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  for (const text of [read('../starter/project/integrations/t3-triage.example.md'), read('../docs/integrations/t3.md')]) assert.ok(text.includes('"sessionVersion":"{{body.sessionVersion}}"'));
});

// ---- re-check of c95fdde (GPT-6.1 Sol): P2-1, P2-2 and P3 ----------------------------------------

test('re-check P2-1 of c95fdde (dev.88): no command adds a destination; a forward goes only to the bound session, whatever --forward-to a later command names', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: DEAD88 }, { actor: 'orchestrator' });
  const t0 = Date.now(), decided = wakeAt(f, only(await f.deliver(), b => b.inboxId === q.id), t0);
  const read = () => f.view({ inbox: q.id });
  for (const at of [t0 + 1000, t0 + 2000]) triage.sendFailed(decided.sendId, { ...f.files, to: DEAD88, forwardTo: 'never-verified', error: 'thread_not_found', read: read(), nowMs: at });
  const notice = f.ok('inbox.publish', escalateAt(f, decided.sendId, t0 + 3000).payload, { actor: 'orchestrator' });
  triage.markEscalated(decided.sendId, { ...f.files, read: f.view({ inbox: notice.id }) });
  const run = runRecorded('timer', { ...f.files, input: JSON.stringify(dashboardSnapshot(f.store)), forwardTo: 'never-verified', nowMs: t0 + 4 * MIN });
  assert.equal(only(run.retries, r => r.sendId === decided.sendId).send.threadId, DEAD88);
  assert.ok(!logOf(f).some(e => e.forwardTo === 'never-verified'));
  assert.equal(memoryOf(f).pending[decided.sendId].configured, null, 'the recorded null is kept');
});

test('re-check P2-2 of c95fdde (dev.88): after a rebind from A to B, B\'s failures get their own notice, A\'s notice is moot, and nothing goes to another thread', async t => {
  const { f, t0, notice } = await roundTwo(t);
  const { n, out } = await notice('Fictional notice for A', t0 + 1000);
  const read = () => f.view({ inbox: n.id }), fail = (to, at) => triage.sendFailed(out.sendId, { ...f.files, to, error: 'thread_not_found', read: read(), nowMs: at });
  fail(DEAD88, t0 + 2000); fail(DEAD88, t0 + 3000);
  const noticeA = f.ok('inbox.publish', escalateAt(f, out.sendId, t0 + 4000).payload, { actor: 'orchestrator' });
  triage.markEscalated(out.sendId, { ...f.files, read: f.view({ inbox: noticeA.id }) });
  f.ok('orchestrator.session', { sessionId: DEADB88 }, { actor: 'orchestrator' });
  assert.equal(only(timerAt(f, t0 + 4 * MIN).retries, r => r.sendId === out.sendId).send.threadId, DEADB88);
  assert.match(memoryOf(f).mootEscalations.map(m => `${m.noticeId} ${m.why}`).join(' '), new RegExp(`${noticeA.id} the orchestrator session was rebound from ${DEAD88} to ${DEADB88}`));
  fail(DEADB88, t0 + 4 * MIN + 1000);
  const down = fail(DEADB88, t0 + 4 * MIN + 2000).next;
  assert.equal(down.send, null);
  assert.match(down.escalateDue ?? '', new RegExp(`the orchestrator session ${DEADB88} failed 2 send\\(s\\) of it`), 'B gets its own escalation');
  const asked = escalateAt(f, out.sendId, t0 + 4 * MIN + 3000);
  assert.ok(asked); assert.notEqual(asked.payload.id, noticeA.id);
  assert.equal(triage.counts(logOf(f)).escalations, 1, 'B\'s notice is not published yet');
});

test('re-check P3 of c95fdde: judging a forwarded delivery absorbed releases what its forward claimed in the absorbed count', async t => {
  const f = fixture(t), n = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional dismissed notice', context: 'Fictional.' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  await f.deliver(); f.ok('inbox.ack', { inboxId: n.id });
  const t0 = Date.now(); assert.equal(wakeAt(f, only(await f.deliver(), b => b.inboxId === n.id && b.event === 'inbox.resolved'), t0).decision, 'absorb');
  // A known state event no rule covers: forwarded as unsure, claiming the one absorbed delivery.
  const unsure = { projectId: f.projectId, deliveryId: 'fictional-unsure-delivery', kind: 'state', event: 'flow.admitted', eventSequence: 7, taskId: 'task-1' };
  const u = wakeAt(f, unsure, t0 + 1000);
  assert.equal(u.decision, 'unsure'); assert.match(u.forward, /Absorbed since the last forward: 1 /);
  // The proxy judges it routine instead of sending it.
  json(cli(['--judged-absorb', unsure.deliveryId, '--note', 'Fictional: routine', '--memory', f.files.memoryPath, '--log', f.files.logPath]));
  const m = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional next notice', context: 'Fictional.' });
  assert.match(wakeAt(f, only(await f.deliver(), b => b.inboxId === m.id), t0 + 2000).forward, /Absorbed since the last forward: 2 /, 'the earlier absorbed delivery and the judged one (c95fdde: 1)');
});

// ---- second re-check of bc8a93d (GPT-6.1 Sol): P2-1 and P2-2 ---------------------------------------

const DEADB88 = `mcp:launch:${'0'.repeat(56)}deadb088`;
const memoryOf = f => JSON.parse(readFileSync(f.files.memoryPath, 'utf8'));
const editMemory = (f, change) => { const m = memoryOf(f); change(m); writeFileSync(f.files.memoryPath, JSON.stringify(m)); };

test('second re-check P2-1 of bc8a93d: a forward escalated under dev.87 is not covered for any outage now, and offering a notice never covers it; only its verified read-back does', async t => {
  const { f, t0, notice } = await roundTwo(t), { n, out } = await notice('Fictional notice escalated under dev.87', t0 + 1000);
  // The row as a dev.87 proxy kept it: failed twice for the bound session, its own per-forward notice verified, no outage anywhere.
  editMemory(f, m => {
    const row = m.pending[out.sendId];
    for (const key of ['configured', 'toldIn', 'escalationNotice']) delete row[key];
    Object.assign(row, { failedBy: { [DEAD88]: 2 }, failures: 2, lastError: 'thread_not_found', escalatedAt: new Date(t0 + 2000).toISOString(),
      escalation: { operation: 'inbox.publish', payload: { kind: 'notice', id: 'triage-undelivered-0123456789ab-01234567', title: 'Fictional', context: 'Fictional.' } } });
    m.failedThreads = { [DEAD88]: { failures: 2 } }; delete m.outages; delete m.mainSessionVersion;
  });
  const read = () => f.view({ inbox: n.id });
  // The dev.87 notice does not stand for this outage: a run marks it due again.
  const due = only(timerAt(f, t0 + 4 * MIN).retries, r => r.sendId === out.sendId);
  assert.equal(due.send.threadId, DEAD88); assert.match(due.escalateDue, /failed 2 send\(s\) of it/);
  for (const at of [t0 + 4 * MIN + 1000, t0 + 4 * MIN + 2000]) triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  const asked = escalateAt(f, out.sendId, t0 + 4 * MIN + 3000);
  assert.ok(asked); assert.notEqual(asked.payload.id, 'triage-undelivered-0123456789ab-01234567');
  // Offering it covers nothing: the next run still marks it due.
  assert.equal(memoryOf(f).pending[out.sendId].toldIn, undefined);
  assert.ok(only(timerAt(f, t0 + 8 * MIN).retries, r => r.sendId === out.sendId).escalateDue);
  const published = f.ok('inbox.publish', asked.payload, { actor: 'orchestrator' });
  triage.markEscalated(out.sendId, { ...f.files, read: f.view({ inbox: published.id }) });
  assert.equal(memoryOf(f).pending[out.sendId].toldIn, memoryOf(f).outages[DEAD88].id, 'written by the verified read-back only');
  const covered = only(timerAt(f, t0 + 12 * MIN).retries, r => r.sendId === out.sendId);
  assert.deepEqual([covered.send.threadId, covered.escalateDue], [DEAD88, null]);
});

async function recovered(t) {
  const { f, t0, notice } = await roundTwo(t), F = await notice('Fictional forward F', t0 + 1000);
  const read = () => f.view({ inbox: F.n.id }), fail = at => triage.sendFailed(F.out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  fail(t0 + 2000); fail(t0 + 3000);
  const first = f.ok('inbox.publish', escalateAt(f, F.out.sendId, t0 + 4000).payload, { actor: 'orchestrator' });
  triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: first.id }) });
  const G = await notice('Fictional forward G', t0 + 5000);
  confirmSent(G.out.sendId, { ...f.files, to: DEAD88, nowMs: t0 + 6000 });
  return { f, t0, F, first, fail };
}
const afterRecovery = async ({ f, t0, F, first, fail }) => {
  assert.equal(only(timerAt(f, t0 + 5 * MIN).retries, r => r.sendId === F.out.sendId).send.threadId, DEAD88);
  const once = fail(t0 + 5 * MIN + 1000).next;
  assert.equal(once.send?.threadId, DEAD88, 'the bound session once more: its earlier failures belonged to an outage that ended (bc8a93d: an immediate fallback)');
  const twice = fail(t0 + 5 * MIN + 2000).next;
  assert.equal(twice.send, null); assert.match(twice.escalateDue, new RegExp(`the orchestrator session ${DEAD88} failed 2 send`));
  const asked = escalateAt(f, F.out.sendId, t0 + 5 * MIN + 3000);
  assert.ok(asked, 'a new outage gets a new notice'); assert.notEqual(asked.payload.id, first.id, 'not the old notice');
};

test('second re-check P2-2 of bc8a93d: after recovery, a rebind to B and back to A, a failure of A is a new outage with its own notice', async t => {
  const r = await recovered(t);
  r.f.ok('orchestrator.session', { sessionId: DEADB88 }, { actor: 'orchestrator' });
  r.f.ok('orchestrator.session', { sessionId: DEAD88 }, { actor: 'orchestrator' });
  await afterRecovery(r);
});

test('second re-check P2-2 of bc8a93d: a session reused after recovery, with no rebind, starts a new outage too', async t => {
  const r = await recovered(t), row = memoryOf(r.f).pending[r.F.out.sendId];
  await afterRecovery(r);
  assert.equal(row.failedBy[DEAD88], undefined, 'the confirmed send ended the outage: F\'s failure counts for it were cleared');
  assert.equal(memoryOf(r.f).pending[r.F.out.sendId].toldIn === memoryOf(r.f).outages?.[DEAD88]?.id && memoryOf(r.f).outages?.[DEAD88]?.status === 'published', false, 'and its coverage lapsed with the outage');
});

test('second re-check P2-2 of bc8a93d: a rebind to a different session starts a new episode for the session bound after it', async t => {
  const { f, t0, notice } = await roundTwo(t), F = await notice('Fictional forward H', t0 + 1000);
  const read = () => f.view({ inbox: F.n.id });
  for (const at of [t0 + 2000, t0 + 3000]) triage.sendFailed(F.out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  const first = f.ok('inbox.publish', escalateAt(f, F.out.sendId, t0 + 4000).payload, { actor: 'orchestrator' });
  triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: first.id }) });
  // B, then A again, with no confirmed send in between: the run that reads the new binding starts A's new episode.
  f.ok('orchestrator.session', { sessionId: DEADB88 }, { actor: 'orchestrator' });
  f.ok('orchestrator.session', { sessionId: DEAD88 }, { actor: 'orchestrator' });
  timerAt(f, t0 + 5 * MIN);
  const row = memoryOf(f).pending[F.out.sendId];
  assert.equal(row.failedBy[DEAD88], undefined);
  assert.equal(memoryOf(f).outages?.[DEAD88], undefined, 'the old outage, and its notice, no longer stand for this session');
  assert.equal(only(timerAt(f, t0 + 9 * MIN).retries, r => r.sendId === F.out.sendId).escalateDue, null, 'not covered, and not due either until it fails or ages');
});

// ---- third re-check of 0933596 (GPT-6.1 Sol), with the decision to drop thread fallback -------------

// F fails twice to DEAD88; its outage notice is offered (and verified when `verify`); then another delivery is confirmed to DEAD88.
async function outageThenRecovery(t, { verify }) {
  const { f, t0, notice } = await roundTwo(t), F = await notice('Fictional forward F', t0 + 1000);
  const read = () => f.view({ inbox: F.n.id });
  for (const at of [t0 + 2000, t0 + 3000]) triage.sendFailed(F.out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  const offered = escalateAt(f, F.out.sendId, t0 + 4000), published = f.ok('inbox.publish', offered.payload, { actor: 'orchestrator' });
  if (verify) triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: published.id }) });
  const G = await notice('Fictional forward G', t0 + 5000);
  confirmSent(G.out.sendId, { ...f.files, to: DEAD88, nowMs: t0 + 6000 });
  return { f, t0, F, read, published };
}

test('third re-check of 0933596, late verification: a notice verified after its outage ended covers nothing, and is reported moot', async t => {
  const { f, t0, F, read, published } = await outageThenRecovery(t, { verify: false });
  const marked = triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: published.id }) });
  assert.deepEqual(marked.covers, []); assert.match(marked.note, /ended before its read-back: it covers nothing/);
  // F fails again: a new outage, due again, and a new notice (0933596: the late read-back restored coverage, so nothing was due).
  for (const at of [t0 + 7000, t0 + 8000]) triage.sendFailed(F.out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  assert.ok(only(timerAt(f, t0 + 4 * MIN).retries, r => r.sendId === F.out.sendId).escalateDue, 'not covered by the late notice');
  const fresh = escalateAt(f, F.out.sendId, t0 + 4 * MIN + 1000);
  assert.ok(fresh); assert.notEqual(fresh.payload.id, published.id);
  const m = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional later', context: 'Fictional.' });
  assert.match(wakeAt(f, only(await f.deliver(), b => b.inboxId === m.id), t0 + 5 * MIN).forward, new RegExp(`Escalation notices now moot \\(data\\): ${published.id} \\(its outage had ended before it was published`));
});

test('third re-check of 0933596, expiry: a forward is never dropped while the operator has not been told about the outage it is in now', async t => {
  const { f, t0, F, read } = await outageThenRecovery(t, { verify: true });
  // The first outage was reported and has ended. F is still unconfirmed; it fails again, a new outage, not yet reported.
  for (const at of [t0 + 7000, t0 + 8000]) triage.sendFailed(F.out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  const day = t0 + 25 * 60 * MIN, late = only(timerAt(f, day).retries, r => r.sendId === F.out.sendId);
  assert.equal(late.send, null, 'past 24 hours: not sent'); assert.ok(late.escalateDue, 'but due');
  assert.ok(!logOf(f).some(e => e.decision === 'retry-expired'), 'not dropped (0933596: dropped on the old escalatedAt)');
  const notice = f.ok('inbox.publish', escalateAt(f, F.out.sendId, day + 1000).payload, { actor: 'orchestrator' });
  triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: notice.id }) });
  assert.deepEqual(timerAt(f, day + 2000).retries, []);
  assert.match(only(logOf(f), e => e.decision === 'retry-expired').note, /told of its current outage at/);
});

test('third re-check of 0933596, stale reads: a read older than one already seen neither rewinds the session version nor clears the newer outage, nor redirects a forward', async t => {
  const { f, t0, notice } = await roundTwo(t);
  // A read taken while DEAD88 is bound (version 2), used by an overlapping run after the rebind to B.
  const m = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional notice read early', context: 'Fictional.' });
  const early = only(await f.deliver(), b => b.inboxId === m.id), staleRead = JSON.stringify(f.view({ inbox: m.id }));
  f.ok('orchestrator.session', { sessionId: DEADB88 }, { actor: 'orchestrator' });
  const fn = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional forward for B', context: 'Fictional.' });
  const F = { n: fn, out: wakeAt(f, only(await f.deliver(), b => b.inboxId === fn.id), t0 + 1000) };
  assert.equal(F.out.forwardTo, DEADB88); void notice;
  for (const at of [t0 + 2000, t0 + 3000]) triage.sendFailed(F.out.sendId, { ...f.files, to: DEADB88, error: 'thread_not_found', read: f.view({ inbox: F.n.id }), nowMs: at });
  const published = f.ok('inbox.publish', escalateAt(f, F.out.sendId, t0 + 4000).payload, { actor: 'orchestrator' });
  triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: published.id }) });
  const before = memoryOf(f);
  // The overlapping run with the older read.
  writeFileSync(f.files.statePath, staleRead);
  const run = runRecorded('wake', { ...f.files, input: JSON.stringify(early), projectId: f.projectId, nowMs: t0 + 5000 });
  assert.equal(run.forwardTo, DEADB88, 'its forward goes to the newest bound session, not the one in its read');
  const after = memoryOf(f);
  assert.deepEqual([after.mainThreadId, after.mainSessionVersion], [DEADB88, before.mainSessionVersion], 'not rewound (0933596: rewound to the older version)');
  assert.deepEqual(after.outages[DEADB88], before.outages[DEADB88], 'B\'s outage is intact');
  assert.equal(only(timerAt(f, t0 + 4 * MIN).retries, r => r.sendId === F.out.sendId).escalateDue, null, 'and F stays covered');
});

// ---- review of 615f5a5 (GPT-6.1 Sol): P2-1, P2-2 and P3 -----------------------------------------------

test('review P2-1 of 615f5a5: every error path sends to the known binding, never to a configured thread it has replaced, and to no thread when the state cannot be read', { skip: process.getuid?.() === 0 && 'file modes do not bind root' }, async t => {
  const { chmodSync, mkdirSync, copyFileSync } = await import('node:fs');
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  f.wake(body); // the state file now records THREAD as the bound session
  // The repro: the run cannot complete (here its state file cannot be written, as with a lock timeout), called with a retired configured thread.
  const locked = join(f.dir, 'locked'); mkdirSync(locked); copyFileSync(f.files.memoryPath, join(locked, 'state.json')); chmodSync(locked, 0o500);
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: q.id })));
  const failed = cli(['--project', f.projectId, '--state', f.files.statePath, '--memory', join(locked, 'state.json'), '--log', f.files.logPath, '--forward-to', 'fictional-retired-thread'], { input: JSON.stringify(body) });
  chmodSync(locked, 0o700);
  const out = JSON.parse(failed.stdout);
  assert.equal(out.rule, 'triage-error');
  assert.equal(out.send?.threadId, THREAD, '615f5a5: the retired configured thread');
  assert.match(failed.stderr, /the wake run failed/);
  // A state file that cannot be read: no destination at all, and stderr says so.
  writeFileSync(f.files.memoryPath, '{ not json');
  assert.deepEqual(triage.knownTarget(f.files.memoryPath, 'fictional-retired-thread'), { forwardTo: null, forwardSource: null });
  const mismatch = spawnSync(process.execPath, [SCRIPT, '--memory', f.files.memoryPath, '--log', f.files.logPath, '--forward-to', 'fictional-retired-thread', '--protocol', '87'], { encoding: 'utf8', input: JSON.stringify(body) });
  assert.equal(JSON.parse(mismatch.stdout).send, null, '615f5a5: sent to the configured thread');
  assert.match(mismatch.stderr, /no orchestrator thread is known for this message/);
  // A state file reset because it could not be read: the run uses only a binding it reads, not the configured thread.
  const reset = runRecorded('wake', { ...f.files, statePath: null, input: JSON.stringify(body), projectId: f.projectId, forwardTo: 'fictional-retired-thread', readError: 'fictional read failure' });
  assert.equal(reset.rule, 'state-reset'); assert.equal(reset.forwardTo, null); assert.equal(reset.escalateDue, 'there is no orchestrator thread to send it to');
  // A proxy that has never seen a session (no state file yet) still uses its configured thread.
  assert.equal(triage.knownTarget(join(f.dir, 'missing.json'), 'fictional-first-thread').forwardTo, 'fictional-first-thread');
});

test('review P2-2 of 615f5a5: the cap on pending forwards never drops one the operator has not been told about; over it, they are escalated at once, and at the hard limit new ones are refused loudly', async t => {
  const f = fixture(t), t0 = Date.now();
  const stateBody = n => JSON.stringify({ projectId: f.projectId, deliveryId: `fictional-delivery-${n}`, kind: 'state', event: 'flow.admitted', eventSequence: n + 1, taskId: 'task-1' });
  const wake = (n, at, limits) => runRecorded('wake', { ...f.files, statePath: null, input: stateBody(n), projectId: f.projectId, forwardTo: THREAD, nowMs: at, ...(limits ? { limits } : {}) });
  // The repro, at the real limit: F, then 500 more forwards before F's re-send grace ends.
  const F = wake(0, t0);
  for (let n = 1; n <= 500; n++) wake(n, t0 + n * 100);
  assert.ok(memoryOf(f).pending[F.sendId], 'F is kept (615f5a5: evicted)');
  assert.equal(memoryOf(f).overflow.limit, triage.MAX_PENDING_SENDS);
  const asked = triage.escalateNow(F.sendId, { ...f.files, nowMs: t0 + 51000 });
  assert.ok(asked.escalate, '615f5a5: null'); assert.match(asked.reason, /holds 501 unconfirmed forwards, more than its limit of 500/);
  assert.equal(asked.covers.length, 19, 'one notice, listing the first of the others; the rest join it');
  // Once the operator is told, forwards it covers may be evicted, oldest first; others are not.
  const g = fixture(t), wakeG = (n, at) => runRecorded('wake', { ...g.files, statePath: null, input: JSON.stringify({ projectId: g.projectId, deliveryId: `fictional-g-${n}`, kind: 'state', event: 'flow.admitted', eventSequence: n + 1, taskId: 'task-1' }), projectId: g.projectId, forwardTo: THREAD, nowMs: at, limits: { pending: 3, unreported: 6 } });
  const first = [0, 1, 2, 3].map(n => wakeG(n, t0 + n * 1000));
  assert.equal(Object.keys(memoryOf(g).pending).length, 4, 'over the cap, nothing told yet: all kept');
  const offer = triage.escalateNow(first[0].sendId, { ...g.files, nowMs: t0 + 5000 });
  const published = g.ok('inbox.publish', offer.escalate.payload, { actor: 'orchestrator' });
  assert.deepEqual(triage.markEscalated(first[0].sendId, { ...g.files, read: g.view({ inbox: published.id }) }).covers.length, 4);
  wakeG(4, t0 + 6000);
  assert.deepEqual(Object.keys(memoryOf(g).pending).sort(), [first[2].sendId, first[3].sendId, `fictional-g-4:1`].sort(), 'the two oldest told-about forwards were evicted, the new one kept');
  assert.equal(logOf(g).filter(e => e.decision === 'retry-expired' && /^evicted:/.test(e.note)).length, 2);
  // The hard limit on forwards nobody has been told about: a new one is refused with an error, and nothing is dropped.
  const h = fixture(t), wakeH = n => runRecorded('wake', { ...h.files, statePath: null, input: JSON.stringify({ projectId: h.projectId, deliveryId: `fictional-h-${n}`, kind: 'state', event: 'flow.admitted', eventSequence: n + 1, taskId: 'task-1' }), projectId: h.projectId, forwardTo: THREAD, nowMs: t0 + n * 1000, limits: { pending: 3, unreported: 6 } });
  for (let n = 0; n < 6; n++) wakeH(n);
  const before = readFileSync(h.files.memoryPath, 'utf8');
  assert.throws(() => wakeH(6), /already holds 6 unconfirmed forwards nobody has been told about .*refuses to record delivery fictional-h-6/);
  assert.equal(readFileSync(h.files.memoryPath, 'utf8'), before, 'nothing changed, nothing dropped');
  assert.deepEqual([triage.MAX_PENDING_SENDS, triage.MAX_UNREPORTED_SENDS], [500, 2000]);
});

test('review P3 of 615f5a5: a late read-back of an ended outage\'s notice is matched to that outage, not to the forward\'s current one', async t => {
  const { f, t0, notice } = await roundTwo(t), F = await notice('Fictional forward F', t0 + 1000);
  const read = () => f.view({ inbox: F.n.id }), fail = at => triage.sendFailed(F.out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: read(), nowMs: at });
  fail(t0 + 2000); fail(t0 + 3000);
  const n1 = f.ok('inbox.publish', escalateAt(f, F.out.sendId, t0 + 4000).payload, { actor: 'orchestrator' }); // published; its read-back not yet recorded
  const G = await notice('Fictional forward G', t0 + 5000);
  confirmSent(G.out.sendId, { ...f.files, to: DEAD88, nowMs: t0 + 6000 }); // that outage ends
  fail(t0 + 7000); fail(t0 + 8000);
  const n2 = escalateAt(f, F.out.sendId, t0 + 9000);
  assert.notEqual(n2.payload.id, n1.id);
  // N1's read-back arrives now.
  const late = triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: n1.id }) });
  assert.equal(late.recorded, 'escalated', '615f5a5: N2 reported missing'); assert.deepEqual(late.covers, []);
  assert.ok(memoryOf(f).mootEscalations.some(m => m.noticeId === n1.id), 'N1 is announced as moot');
  // N2 is still offered, and its own read-back covers F.
  const n2published = f.ok('inbox.publish', n2.payload, { actor: 'orchestrator' });
  assert.deepEqual(triage.markEscalated(F.out.sendId, { ...f.files, read: f.view({ inbox: n2published.id }) }).covers, [F.out.sendId]);
});

// ---- re-check of b693894 (GPT-6.1 Sol): an operator notice whenever the proxy cannot handle a delivery or a run ----

const { createHash } = await import('node:crypto');
const failedNoticeId = deliveryId => `triage-failed-${createHash('sha256').update(String(deliveryId)).digest('hex').slice(0, 12)}`;

test('re-check P2-1 of b693894: a delivery refused at the limit is published as an operator notice naming it, once, so a notice delivery is not lost', async t => {
  const f = fixture(t), n = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional notice delivered once', context: 'Fictional.' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === n.id);
  // A state file already holding the limit of forwards nobody has been told about.
  const pending = Object.fromEntries(Array.from({ length: triage.MAX_UNREPORTED_SENDS }, (_, i) => [`fictional-old-${i}:1`, { kind: 'delivery', at: new Date().toISOString(), deliveryId: `fictional-old-${i}`, decidedFor: THREAD, forwardTo: THREAD, sentTo: [THREAD] }]));
  writeFileSync(f.files.memoryPath, JSON.stringify({ version: 1, mainThreadId: THREAD, pending }));
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: n.id })));
  const run = () => cli(['--project', f.projectId, '--state', f.files.statePath, '--memory', f.files.memoryPath, '--log', f.files.logPath, '--factory-state', f.stateDir], { input: JSON.stringify(body) });
  const first = run(), out = JSON.parse(first.stdout);
  assert.equal(out.rule, 'triage-error'); assert.match(out.reason, /refuses to record delivery/);
  assert.deepEqual(out.operatorNotice, { id: failedNoticeId(body.deliveryId), published: true }, 'b693894: no notice');
  const notice = f.store.need('inbox', out.operatorNotice.id);
  assert.deepEqual([notice.kind, notice.role, notice.status, notice.createdBy], ['notice', 'operator', 'open', 'orchestrator']);
  assert.equal(notice.title, `Triage proxy could not handle a delivery (the webhook payload names ${body.deliveryId})`);
  for (const text of [body.deliveryId, `inbox item ${n.id}`, 'refuses to record', 'If that item is a notice, Factotum delivers it once and does not send it again', 'unverified claims from the webhook payload']) assert.ok(notice.context.includes(text), text);
  assert.equal(first.status, 0);
  // The same delivery refused again: the same notice, not a second one.
  assert.deepEqual(JSON.parse(run().stdout).operatorNotice, { id: notice.id, published: true });
  assert.equal(f.store.all('inbox').filter(row => String(row.id).startsWith('triage-failed-')).length, 1);
});

test('re-check P2-2 of b693894: a state file that cannot be read or reset publishes an operator notice for the delivery or the timer run, and if even that fails the command exits nonzero', { skip: process.getuid?.() === 0 && 'file modes do not bind root' }, async t => {
  const { chmodSync, mkdirSync } = await import('node:fs');
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  // The repro: the state file is mode 000 and its directory mode 0500, so it can be neither read nor set aside.
  const dir = join(f.dir, 'unreadable'); mkdirSync(dir); const memoryPath = join(dir, 'state.json');
  writeFileSync(memoryPath, '{}'); chmodSync(memoryPath, 0o000); chmodSync(dir, 0o500);
  try {
    writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: q.id })));
    const wake = cli(['--project', f.projectId, '--state', f.files.statePath, '--memory', memoryPath, '--log', f.files.logPath, '--forward-to', 'fictional-retired-thread', '--factory-state', f.stateDir], { input: JSON.stringify(body) });
    const out = JSON.parse(wake.stdout);
    assert.equal(out.send, null, 'no destination: the state cannot be read');
    assert.deepEqual(out.operatorNotice, { id: failedNoticeId(body.deliveryId), published: true }, 'b693894: only stderr');
    assert.match(f.store.need('inbox', out.operatorNotice.id).context, /EACCES/);
    // A timer run: one notice for the hour.
    const timer = spawnSync(process.execPath, [SCRIPT, '--timer', '--memory', memoryPath, '--log', f.files.logPath, '--factory-state', f.stateDir, '--protocol', '90'], { encoding: 'utf8', input: JSON.stringify(dashboardSnapshot(f.store)) });
    const hour = new Date().toISOString().slice(0, 13);
    const timerNotice = JSON.parse(timer.stdout).operatorNotice;
    assert.deepEqual(timerNotice, { id: `triage-failed-timer-${hour}`, published: true });
    assert.match(f.store.need('inbox', timerNotice.id).title, new RegExp(`Triage proxy could not handle the timer run of ${hour}:00 UTC`));
    // The floor: inbox.publish itself fails. stderr, and a nonzero exit.
    const floor = cli(['--project', f.projectId, '--state', f.files.statePath, '--memory', memoryPath, '--log', f.files.logPath, '--factory-state', join(f.dir, 'no-such-state')], { input: JSON.stringify(body) });
    assert.equal(floor.status, 1); assert.match(floor.stderr, /could not publish the operator notice triage-failed-/);
  } finally { chmodSync(dir, 0o700); chmodSync(memoryPath, 0o600); }
  // A protocol mismatch is a run the proxy cannot handle too.
  const mismatch = spawnSync(process.execPath, [SCRIPT, '--project', f.projectId, '--memory', f.files.memoryPath, '--log', f.files.logPath, '--factory-state', f.stateDir, '--protocol', '87'], { encoding: 'utf8', input: JSON.stringify(body) });
  assert.equal(mismatch.status, 1);
  const protocolNotice = JSON.parse(mismatch.stdout).operatorNotice;
  assert.equal(protocolNotice.published, true); assert.match(f.store.need('inbox', protocolNotice.id).context, /copy the brief and the handling guide again/);
});

test('re-check P2-3 of b693894: after a reset, no run falls back to --forward-to until one reads a binding', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), r = f.ok('inbox.publish', { ...question, title: 'Fictional second' });
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const bodies = await f.deliver(), first = only(bodies, b => b.inboxId === q.id), second = only(bodies, b => b.inboxId === r.id);
  writeFileSync(f.files.memoryPath, '{ not json');
  const blind = body => runRecorded('wake', { ...f.files, statePath: null, input: JSON.stringify(body), projectId: f.projectId, forwardTo: 'fictional-retired-thread', readError: 'fictional read failure' });
  assert.equal(blind(first).forwardTo, null, 'the reset run');
  assert.equal(blind(second).forwardTo, null, 'and the next run too (b693894: the retired thread)');
  assert.ok(memoryOf(f).bindingLost, 'the marker is kept');
  assert.equal(triage.knownTarget(f.files.memoryPath, 'fictional-retired-thread').forwardTo, null, 'error paths too');
  // A run that reads the binding clears it.
  const third = f.ok('inbox.publish', { kind: 'notice', title: 'Fictional third', context: 'Fictional.' });
  assert.equal(wakeAt(f, only(await f.deliver(), b => b.inboxId === third.id), Date.now(), { forwardTo: 'fictional-retired-thread' }).forwardTo, THREAD);
  assert.equal(memoryOf(f).bindingLost, undefined);
});

test('re-check of b693894: the guides state the operator-notice rule, the floor and the corrected no-loss claim', () => {
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), handling = read('../starter/project/integrations/t3-notifications.example.md'), guide = read('../docs/integrations/t3.md');
  assert.ok(brief.includes('--factory-state [[state-dir]] --protocol 90`')); assert.match(brief, /the script has already published an operator notice about it \(`operatorNotice`/);
  assert.match(brief, /If the command exited nonzero saying it could not publish the operator notice, reply in one line with that message and stop/);
  assert.match(handling, /the proxy also publishes an operator notice `triage-failed-<id>`/);
  for (const text of ['**When the proxy cannot handle a delivery or a run**', '**The floor:**', 'publishes an operator notice naming the refused delivery (its ID, its item and why), so the refusal loses nothing'])
    assert.ok(guide.includes(text), text);
  assert.doesNotMatch(guide, /Error forwards \(`triage-error`, `protocol-mismatch`\) are not tracked or re-sent themselves\./, 'the old limit is restated, with the notice');
});

// ---- re-check of 338c3dd (GPT-6.1 Sol): the operator-notice path ----------------------------------------

// A proxy whose state file can be neither read nor set aside, so every wake fails and publishes an error notice.
async function failingProxy(t, f) {
  const { chmodSync, mkdirSync } = await import('node:fs');
  const dir = join(f.dir, 'broken'); mkdirSync(dir); const memoryPath = join(dir, 'state.json');
  writeFileSync(memoryPath, '{}');
  // The fixture's own cleanup runs first, so the modes are restored at once after each call.
  return body => {
    chmodSync(memoryPath, 0o000); chmodSync(dir, 0o500);
    try {
      writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: body.inboxId })));
      const r = cli(['--project', f.projectId, '--state', f.files.statePath, '--memory', memoryPath, '--log', f.files.logPath, '--factory-state', f.stateDir], { input: JSON.stringify(body) });
      return { ...r, out: JSON.parse(r.stdout) };
    } finally { chmodSync(dir, 0o700); chmodSync(memoryPath, 0o600); }
  };
}
const noRoot = { skip: process.getuid?.() === 0 && 'file modes do not bind root' };

test('re-check P2-1 of 338c3dd: at notifications.level "all", the error notice\'s own webhook is absorbed, so the chain stops after one generation', noRoot, async t => {
  const f = fixture(t, 'all'), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const wake = await failingProxy(t, f);
  const first = wake(only(await f.deliver(), b => b.inboxId === q.id));
  assert.equal(first.out.operatorNotice.published, true);
  const ownNotices = () => f.store.all('inbox').filter(row => /^triage-(failed|protocol)-/.test(row.id));
  assert.equal(ownNotices().length, 1);
  // The notice produces a webhook at level "all"; that wake fails too.
  const echo = only(await f.deliver(), b => b.inboxId === first.out.operatorNotice.id);
  const second = wake(echo);
  assert.deepEqual([second.out.decision, second.out.rule, second.out.send], ['absorb', 'own-error-notice', null]);
  assert.deepEqual(second.out.actions, [], 'never acknowledged: the payload\'s IDs are unverified claims');
  assert.equal(ownNotices().length, 1, '338c3dd: a notice about the notice');
  assert.ok(logOf(f).some(e => e.rule === 'own-error-notice' && e.deliveryId === echo.deliveryId), 'logged');
  assert.deepEqual((await f.deliver()).filter(b => /^triage-(failed|protocol)-/.test(b.inboxId ?? '') && b.inboxId !== first.out.operatorNotice.id), [], 'no further generation');
  // An item with the prefix that the orchestrator role did not publish is not taken for one of the proxy's.
  assert.equal(triage.ownNoticeDelivery({ ...echo }, { item: { id: echo.inboxId, createdBy: 'operator' } }), false);
});

test('final re-check of bcc1e21: a payload that pairs a real delivery with a prefixed item ID is never acknowledged', noRoot, async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const wake = await failingProxy(t, f);
  const real = only(await f.deliver(), b => b.inboxId === q.id);
  const crafted = wake({ ...real, inboxId: 'triage-failed-000000000000' });
  assert.equal(crafted.out.rule, 'own-error-notice');
  assert.deepEqual(crafted.out.actions, [], 'the real question\'s delivery is not acknowledged');
  assert.equal(f.store.get('inbox', q.id).status, 'open');
});

test('re-check P2-2 and P2-3 of 338c3dd: the read-back checks the context too; a collision moves to <id>-2 and <id>-3, and the same failure published again finds its own notice', noRoot, async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question);
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const body = only(await f.deliver(), b => b.inboxId === q.id), id = failedNoticeId(body.deliveryId);
  // A notice by the orchestrator role under the ID, with the same title and another context (planted, or an older failure).
  const expected = triage.failureNotice({ kind: 'wake', payload: body, error: 'fictional' });
  f.ok('inbox.publish', { kind: 'notice', id, title: expected.title, context: 'Fictional other context.' }, { actor: 'orchestrator' });
  const wake = await failingProxy(t, f);
  const first = wake(body);
  assert.deepEqual(first.out.operatorNotice, { id: `${id}-2`, published: true }, '338c3dd: the planted notice was taken for the proxy\'s own (title only)');
  // The same failure again, and again: no new notice (338c3dd: a fresh random ID each time).
  for (let i = 0; i < 2; i++) assert.deepEqual(wake(body).out.operatorNotice, { id: `${id}-2`, published: true });
  assert.equal(f.store.all('inbox').filter(row => row.id.startsWith(id)).length, 2, 'the planted one and the proxy\'s one');
  // All three IDs held by something else: the floor.
  const g = fixture(t), r = g.ok('inbox.publish', question);
  g.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const other = only(await g.deliver(), b => b.inboxId === r.id), gid = failedNoticeId(other.deliveryId);
  for (const taken of [gid, `${gid}-2`, `${gid}-3`]) g.ok('inbox.publish', { kind: 'notice', id: taken, title: 'Fictional squatter', context: 'Fictional.' });
  const floor = (await failingProxy(t, g))(other);
  assert.equal(floor.status, 1); assert.match(floor.stderr, new RegExp(`could not publish the operator notice ${gid}-3: other items hold ${gid}, ${gid}-2, ${gid}-3`));
  assert.equal(triage.NOTICE_ID_TRIES, 3);
});

test('re-check of 338c3dd: the brief says the script publishes error notices itself and the proxy publishes nothing else; the threat model is stated', () => {
  const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const brief = read('../starter/project/integrations/t3-triage.example.md'), guide = read('../docs/integrations/t3.md');
  assert.doesNotMatch(brief, /publish anything but an `escalate` notice;/);
  assert.match(brief, /publish anything yourself except the `escalate` notice `TRIAGE --escalate` gives you, and the one notice "A webhook run" describes for a step that fails before `TRIAGE` has run: the script publishes its own error and reset notices \(`operatorNotice`, `stateResetNotice`\)/);
  for (const text of ['**Threat model** (dev.88)', 'Webhook payload content is untrusted data', 'already hold the proxy\'s authority']) assert.ok(guide.includes(text), text);
});

// ---- dev.89: M4, M7 and M8 of the dev.88 readiness re-test, and the two findings of the factory's own audit ----
// See docs/changes/dev89-m-items.md.

test('M7 (dev.89): after a rebind, a forward whose sends to the old session failed goes to the new one at once, without the two-minute spacing', async t => {
  const { f, t0, notice } = await roundTwo(t), { out } = await notice('Fictional notice m7', t0 + 1000);
  const failed = at => triage.sendFailed(out.sendId, { ...f.files, to: DEAD88, error: 'thread_not_found', read: f.view({ inbox: out.reread.split(' ')[1] }), nowMs: at });
  failed(t0 + 15000); assert.equal(failed(t0 + 25000).next.send, null, 'down');
  // Without a rebind, the spacing stands: a run 15 seconds later sends nothing.
  assert.equal(timerAt(f, t0 + 40000).retries.find(r => r.sendId === out.sendId)?.send ?? null, null);
  // The operator rebinds (the trial: 20:14:59); the woken timer run 17 seconds later re-sends to the new session.
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const woken = only(timerAt(f, t0 + 57000).retries, r => r.sendId === out.sendId);
  assert.deepEqual([woken.send?.threadId, woken.forwardSource], [THREAD, 'session'], 'dev.88: timer-no-change until the spacing ran out');
  assert.deepEqual(confirmSent(out.sendId, { ...f.files, to: THREAD }), { recorded: 'sent', sendId: out.sendId, to: THREAD });
  // A forward just sent to the new session waits for the spacing again: no double send.
  const after = timerAt(f, t0 + 70000); assert.equal(after.retries.some(r => r.send), false);
});

test('M4 (dev.89): a state reset publishes one operator notice, through any command, and the proxy\'s identity is recovered from the log', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), PROXY = `mcp:launch:${'a1b2'.repeat(16)}`;
  const body = only(await f.deliver(), b => b.inboxId === q.id);
  writeFileSync(f.files.statePath, JSON.stringify(f.view({ inbox: q.id })));
  const run = (args, input) => cli([...args, '--memory', f.files.memoryPath, '--log', f.files.logPath, '--factory-state', f.stateDir], input === undefined ? {} : { input });
  assert.equal(run(['--set-proxy-id', PROXY]).status, 0);
  const wakeArgs = ['--project', f.projectId, '--state', f.files.statePath, '--forward-to', THREAD];
  const first = JSON.parse(run(wakeArgs, JSON.stringify(body)).stdout);
  // The state file becomes unreadable (the trial: chmod 000; here, not JSON, which reads the same way).
  writeFileSync(f.files.memoryPath, '{ not json');
  const reset = run(wakeArgs, JSON.stringify({ ...body, deliveryId: `${body.deliveryId}-again` })), out = JSON.parse(reset.stdout);
  assert.equal(reset.status, 0, reset.stderr); assert.equal(out.rule, 'state-reset');
  assert.equal(out.stateResetNotice.length, 1); assert.equal(out.stateResetNotice[0].published, true);
  const notice = f.store.need('inbox', out.stateResetNotice[0].id);
  assert.match(notice.id, /^triage-reset-[0-9a-f]{12}$/); assert.equal(notice.kind, 'notice'); assert.equal(notice.createdBy, 'orchestrator');
  assert.match(notice.context, /What the proxy remembered is gone: forwards not yet confirmed sent/); assert.match(notice.context, /identity \(mcp:launch:a1b2/);
  assert.ok(out.forward.includes(`Provenance: triage proxy ${PROXY} `), 'not "identity not recorded" (dev.88)');
  assert.equal(JSON.parse(readFileSync(f.files.memoryPath, 'utf8')).proxyThreadId, PROXY);
  // The proxy's own notice is absorbed, never the subject of another notice.
  assert.equal(triage.ownNoticeDelivery({ deliveryId: 'fictional-delivery', inboxId: notice.id, kind: 'notice' }, { item: notice }), true);
  // A reset by another command (here --sent) publishes its own notice too, and the run's next forward needs none.
  writeFileSync(f.files.memoryPath, '{ still not json');
  const sent = run(['--sent', first.sendId, '--to', THREAD]);
  assert.equal(sent.status, 1, 'the send is unknown to the fresh state'); assert.equal(f.store.all('inbox').filter(row => row.id.startsWith('triage-reset-')).length, 2, 'a command that fails after the reset still publishes its notice');
  writeFileSync(f.files.memoryPath, '{ again not json');
  const counted = JSON.parse(run(['--set-proxy-id', PROXY]).stdout);
  assert.equal(counted.stateResetNotice[0].published, true); assert.equal(f.store.all('inbox').filter(row => row.id.startsWith('triage-reset-')).length, 3);
  // Without --factory-state: the floor, stderr and exit 1, and the result is still printed.
  writeFileSync(f.files.memoryPath, '{ once more');
  const floor = cli(['--set-proxy-id', PROXY, '--memory', f.files.memoryPath, '--log', f.files.logPath]);
  assert.equal(floor.status, 1); assert.match(floor.stderr, /could not publish the operator notice triage-reset-[0-9a-f]{12} about the state reset: no --factory-state was given/);
  assert.equal(JSON.parse(floor.stdout).stateResetNotice[0].published, false);
});

test('M8 (dev.89): a forward names a stop reason only for a stopped flow', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), body = only(await f.deliver(), b => b.inboxId === q.id);
  const forward = flow => decide({ payload: body, state: { ...f.view({ inbox: q.id }), flow }, memory: {} }, { projectId: f.projectId, forwardTo: THREAD }).forward;
  const flow = { id: 'flow-resumed', kind: 'change', step: 'decide', stopReason: 'Builder returned the unchanged reviewed candidate after revision was required.' };
  // A narrow read from an older factory still carries the old reason on a resumed flow.
  assert.doesNotMatch(forward({ ...flow, state: 'waiting' }), /stop reason/);
  assert.doesNotMatch(forward({ ...flow, state: 'completed' }), /stop reason/);
  assert.match(forward({ ...flow, state: 'stopped' }), /stop reason “Builder returned the unchanged reviewed candidate/);
});

test('audit of dev.88, line 1303: a re-send of an attention forward needs a read at least as new as the one it was decided from', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), body = only(await f.deliver(), b => b.inboxId === q.id);
  const stale = dashboardSnapshot(f.store);
  f.ok('inbox.publish', { kind: 'notice', title: 'Fictional later notice', context: 'Moves the revision on.' });
  const t0 = Date.now(), out = wakeAt(f, body, t0, { forwardTo: THREAD });
  assert.ok(memoryOf(f).pending[out.sendId].readRevision > stale.revision);
  // An overlapping run whose read is older than the forward's: no send (its item may have closed since), as closeSends already treats such a read.
  const old = runRecorded('timer', { ...f.files, input: JSON.stringify(stale), nowMs: t0 + 3 * MIN });
  assert.equal(old.retries.find(r => r.sendId === out.sendId)?.send ?? null, null, 'dev.88 re-sent it on the stale read');
  // A current read sends it.
  assert.equal(only(timerAt(f, t0 + 4 * MIN).retries, r => r.sendId === out.sendId).send.threadId, THREAD);
});

test('audit of dev.88, line 1111: the outage of forwards with no destination ends when a session is bound, and its notice is reported moot', async t => {
  const f = fixture(t), q = f.ok('inbox.publish', question), body = only(await f.deliver(), b => b.inboxId === q.id);
  const t0 = Date.now(), out = wakeAt(f, body, t0);
  assert.equal(out.forwardTo, null); assert.match(out.escalateDue, /there is no orchestrator thread/);
  const asked = escalateAt(f, out.sendId, t0 + 1000), published = f.ok('inbox.publish', asked.payload, { actor: 'orchestrator' });
  assert.deepEqual(triage.markEscalated(out.sendId, { ...f.files, read: f.view({ inbox: published.id }) }).covers, [out.sendId]);
  assert.equal(memoryOf(f).outages['(no orchestrator thread)'].status, 'published');
  f.ok('orchestrator.session', { sessionId: THREAD }, { actor: 'orchestrator' });
  const run = timerAt(f, t0 + 3 * MIN);
  assert.equal(only(run.retries, r => r.sendId === out.sendId).send.threadId, THREAD);
  const memory = memoryOf(f);
  assert.equal(memory.outages['(no orchestrator thread)'], undefined, 'dev.88: kept for ever');
  assert.ok(memory.mootEscalations.some(m => m.noticeId === published.id && /orchestrator session .* is bound/.test(m.why)));
  // A later period with no destination is a new outage, not covered by the old notice.
  assert.equal(triage.coveredNow({ toldIn: memory.outageSeq }, memory, null), false);
});
