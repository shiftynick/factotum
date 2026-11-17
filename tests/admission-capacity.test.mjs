// dev.83 admission and capacity: flows parked on an answer free their slot (up to
// policy.maxParkedFlows), an answered flow takes the next free slot ahead of queued tasks, and
// stopped flows keep theirs (operations/capacity.mjs). Also: a flow's own changes are compared
// with the target it integrated (G5), a flow at source asks for the verification a moved target
// needs and waits for it (G10), and an open merge question says when its target moved (G9).
// See docs/changes/dev83-admission.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { admitFlow, blocksDrain, executeCommand, snapshot } from '../starter/factory/core/project.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { admissionReasons, claimCandidate } from '../starter/factory/operations/admission.mjs';
import { capacityView, slots } from '../starter/factory/operations/capacity.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { observeQueue } from '../starter/factory/operations/queue-diagnostics.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { settingsView } from '../starter/factory/operations/views.mjs';
import { mergesAhead, mergesInFlight, sourceWait } from '../starter/factory/operations/merge-hold.mjs';
import { setTargetHealth, targetHealth } from '../starter/factory/operations/targets.mjs';
import { probeTargetHead, MERGE_QUESTION_PROBE_MS } from '../starter/factory/operations/main-freshness.mjs';
import { targetMove, targetMoveText } from '../starter/factory/operations/target-move.mjs';
import { cleanupPlan } from '../starter/factory/operations/workspace-cleanup.mjs';
import { activeConflictPaths } from '../starter/factory/operations/conflicts.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { git, prepare, integrateTarget } from '../starter/factory/adapters/workspace/index.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { SOURCE_VERIFY_REQUESTS } from '../starter/factory/core/engine.mjs';

const H = c => c.repeat(40), iso = () => new Date().toISOString();
const base = policy => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { mainProbeMs: 0, autoQueue: true, maxFlows: 1, ...policy } });

// A commissioned fictional delivery project with green main. Flows are admitted through the real
// admission path and then placed at the step a test needs, as an earlier step would have left them.
function delivery(t, policy = {}, extra = {}) {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: { ...base(policy), ...extra }, note: 'Commission fictional delivery' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: iso() });
  const ok = receipt => { assert.equal(receipt.status, 'completed', receipt.error); return receipt.result; };
  const task = (id, extra = {}) => { ok(f.command('task.put', { task: { id, title: `Fictional ${id}`, acceptance: ['Observed'], risk: 'ordinary', ...extra } })); ok(f.command('task.approve', { taskId: id, revision: f.store.need('task', id).revision })); return f.store.need('task', id); };
  const reasons = id => admissionReasons(f.store, f.store.need('task', id));
  // Admission exactly as flow.start does it; returns the flow id.
  const admit = id => { const flow = ok(f.command('flow.start', { taskId: id, revision: f.store.need('task', id).revision, flowId: `flow-${id}` })); return flow.id; };
  const at = (flowId, step, extra = {}) => { const flow = { ...f.store.need('flow', flowId), step, state: 'ready', attemptId: null, ...extra }; f.store.put('flow', flow); return flow; };
  // The flow reaches a question (the builder is blocked) and the engine opens it.
  const park = async (flowId, step = 'build-question') => { at(flowId, step); await f.engine.step(flowId); return question(flowId); };
  const question = flowId => f.store.all('inbox').find(row => row.flowId === flowId && row.kind === 'question' && row.status === 'open');
  const answer = (item, value, { store = f.store, extra = {} } = {}) => executeCommand(store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'operator', operation: 'answer', payload: { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: value, ...extra } });
  const limit = changes => ok(f.command('settings.update', { changes, note: 'Fictional capacity change' }));
  const finish = flowId => f.store.put('flow', { ...f.store.need('flow', flowId), state: 'completed', finishedAt: iso(), attemptId: null });
  const events = type => f.store.events(500).filter(event => event.type === type);
  // Flows that may run an effect now: not finished, stopped, parked or waiting for a slot.
  const working = () => slots(f.store).pools.change.working.filter(flow => flow.state !== 'stopped').map(flow => flow.id).sort();
  return { ...f, ok, task, reasons, admit, at, park, question, answer, limit, finish, events, working };
}
const claim = f => claimCandidate(f.store, { admit: (task, s) => admitFlow(s, task, { revision: task.revision }) });
const queue = (f, ...ids) => f.ok(f.command('queue.put', { taskIds: ids }));

// ---- 1. Parked flows free their slot ----

test('a flow parked on a question holds no flow slot; working and stopped flows hold theirs', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2'); f.task('task-3');
  const a = f.admit('task-1');
  assert.deepEqual(f.reasons('task-2'), ['flow capacity exhausted'], 'a working flow holds the only slot');
  const item = await f.park(a);
  assert.ok(item, 'the question opened'); assert.equal(f.store.need('flow', a).state, 'waiting');
  assert.deepEqual(f.reasons('task-2'), [], 'parked on an answer: the slot is free');
  const view = capacityView(f.store);
  assert.deepEqual(view.pools.change, { max: 1, inUse: 0, working: 0, stopped: 0, parked: 1, parkedHoldingSlot: 0, waitingForSlot: 0, free: 1 });
  assert.deepEqual(view.parked.map(row => [row.flowId, row.step, row.holdsSlot]), [[a, 'build-question', false]]);
  const b = f.admit('task-2');
  assert.deepEqual(f.reasons('task-3'), ['flow capacity exhausted'], 'the second flow now holds the slot');
  // Stopped flows keep holding their slot.
  f.ok(f.command('stop', { flowId: b, note: 'Fictional stop' }));
  assert.deepEqual(f.reasons('task-3'), [`flow capacity exhausted; stopped flows still hold slots: ${b} (resume, abandon, or task.restart their tasks)`]);
  f.ok(f.command('flow.abandon', { flowId: b, note: 'Fictional abandon' }));
  assert.deepEqual(f.reasons('task-3'), [], 'abandoning the stopped flow frees its slot; the parked flow never held one');
});

test('a flow waiting on something other than an answer keeps its slot', t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1');
  // A provider usage-limit hold, a target wait and a timer leave the flow `waiting` at an effect step.
  f.at(a, 'build', { state: 'waiting', providerHold: { step: 'build', provider: 'codex', until: iso(), reason: 'usage limit' } });
  assert.deepEqual(f.reasons('task-2'), ['flow capacity exhausted'], 'a provider hold is not an answer');
  f.at(a, 'source', { state: 'waiting', targetWait: { step: 'source', kind: 'verification', reason: 'Waiting' } });
  assert.deepEqual(f.reasons('task-2'), ['flow capacity exhausted'], 'a target wait is not an answer');
  // At a question but with an attempt, or asked to stop: not parked.
  f.at(a, 'build-question', { state: 'waiting', attemptId: 'attempt-x' });
  assert.deepEqual(f.reasons('task-2'), ['flow capacity exhausted']);
  f.at(a, 'build-question', { state: 'waiting', stopRequested: true });
  assert.deepEqual(f.reasons('task-2'), ['flow capacity exhausted']);
  // Arrived at the question, not asked yet: it keeps the slot until the engine opens the question,
  // so a merge question that policy answers as it opens (autoMerge) never gives its slot away.
  f.at(a, 'build-question', { state: 'ready', stopRequested: false });
  assert.deepEqual(f.reasons('task-2'), ['flow capacity exhausted']);
  f.at(a, 'build-question', { state: 'waiting', stopRequested: false });
  assert.deepEqual(f.reasons('task-2'), [], 'waiting at the question: parked');
  assert.equal(capacityView(f.store).pools.change.parked, 1);
});

test('every question step parks: plan, build, conflict, review and gate questions, the merge decision and the satisfied decision', t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1'), questions = Object.entries(f.store.need('flow', a).workflow.nodes).filter(([, node]) => node.kind === 'question').map(([step]) => step).sort();
  assert.deepEqual(questions, ['build-question', 'conflict-question', 'decide', 'gate-question', 'plan-question', 'review-question', 'satisfied-decide']);
  for (const step of questions) { f.at(a, step, { state: 'waiting' }); assert.deepEqual(f.reasons('task-2'), [], step); }
  for (const step of ['source', 'plan', 'build', 'integrate', 'review', 'gate', 'merge', 'cleanup']) { f.at(a, step, { state: 'ready' }); assert.ok(f.reasons('task-2').includes('flow capacity exhausted'), step); }
});

test('policy.maxParkedFlows caps the flows parked without a slot; later ones hold their slot again', t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3, 4, 5]) f.task(`task-${n}`);
  const ids = [1, 2, 3, 4].map(n => f.admit(`task-${n}`));
  // Parked one after another: the longest-parked use the allowance.
  ids.forEach((id, i) => f.at(id, 'build-question', { state: 'waiting', parkedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
  f.limit({ 'policy.maxFlows': 1 });
  assert.equal(f.store.meta('config').policy.maxParkedFlows, undefined, 'default');
  assert.deepEqual(f.reasons('task-5'), [`flow capacity exhausted; parked flows beyond policy.maxParkedFlows (3) hold slots: ${ids[3]} (answer their questions)`], 'the fourth parked flow counts as active again');
  let view = capacityView(f.store);
  assert.equal(view.maxParkedFlows, 3); assert.equal(view.parkedCount, 4);
  assert.deepEqual(view.parked.map(row => row.holdsSlot), [false, false, false, true]);
  assert.deepEqual(view.pools.change, { max: 1, inUse: 1, working: 0, stopped: 0, parked: 4, parkedHoldingSlot: 1, waitingForSlot: 0, free: 0 });
  // A larger allowance, or a second slot, admits the task.
  f.limit({ 'policy.maxParkedFlows': 4 }); assert.deepEqual(f.reasons('task-5'), []);
  f.limit({ 'policy.maxParkedFlows': 3, 'policy.maxFlows': 2 }); assert.deepEqual(f.reasons('task-5'), []);
  // A smaller one moves the newest parked flows back onto slots.
  f.limit({ 'policy.maxParkedFlows': 2, 'policy.maxFlows': 2 });
  assert.deepEqual(f.reasons('task-5'), [`flow capacity exhausted; parked flows beyond policy.maxParkedFlows (2) hold slots: ${ids[2]}, ${ids[3]} (answer their questions)`]);
  // 0 turns parking off: every waiting flow holds its slot, as before dev.83.
  f.limit({ 'policy.maxParkedFlows': 0, 'policy.maxFlows': 4 });
  assert.deepEqual(f.reasons('task-5'), [`flow capacity exhausted; parked flows beyond policy.maxParkedFlows (0) hold slots: ${ids.join(', ')} (answer their questions)`]);
  f.limit({ 'policy.maxFlows': 5 }); assert.deepEqual(f.reasons('task-5'), []);
});

test('document flows park in their own pool; task flows keep their own capacity rule', t => {
  const f = delivery(t, { maxFlows: 10, maxDocumentFlows: 1 });
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1');
  f.at(a, 'build', { pool: 'document' });
  let pools = slots(f.store).pools;
  assert.equal(pools.document.held, 1); assert.equal(pools.document.freeForNewWork, 0); assert.equal(pools.change.held, 0);
  f.at(a, 'decide', { pool: 'document', state: 'waiting' });
  pools = slots(f.store).pools;
  assert.equal(pools.document.held, 0); assert.equal(pools.document.freeForNewWork, 1); assert.equal(pools.document.parked.length, 1);
  // A task flow is always at a question; it is not in the parked set and its pool counts it as before.
  f.at(a, 'decide', { kind: 'task', pool: undefined, state: 'waiting' });
  const view = capacityView(f.store);
  assert.equal(view.parkedCount, 0); assert.equal(view.pools.change.inUse, 0);
});

// ---- 2. An answered flow takes a slot or waits for one, ahead of queued tasks ----

test('an answered flow with no free slot waits, visibly and unstopped, and resumes ahead of queued tasks', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2'); f.task('task-3');
  const a = f.admit('task-1'), item = await f.park(a), b = f.admit('task-2');
  queue(f, 'task-3');
  // Answered while the other flow holds the only slot.
  const receipt = f.answer(item, 'retry');
  assert.equal(receipt.status, 'completed', receipt.error);
  let flow = f.store.need('flow', a);
  assert.equal(flow.step, 'build'); assert.equal(flow.state, 'waiting'); assert.equal(flow.slotWait.after, 'answer'); assert.equal(flow.stopRequested, false); assert.equal(flow.stopReason ?? null, null);
  assert.equal(f.events('flow.stopped').length, 0, 'never stopped for want of a slot');
  assert.deepEqual(f.working(), [b], 'one flow doing work');
  // Queue status: the reason and the position.
  const status = queueStatus(f.store), waiting = status.capacity.waiting;
  assert.equal(waiting.length, 1); assert.equal(waiting[0].flowId, a); assert.equal(waiting[0].position, 1); assert.equal(waiting[0].of, 1); assert.equal(waiting[0].step, 'build');
  assert.match(waiting[0].reason, new RegExp(`^Waiting for a change flow slot \\(1 of 1 in use, policy\\.maxFlows\\): position 1 of 1\\. It continues by itself, ahead of queued tasks, when one of these finishes, parks on a question or is abandoned: ${b}\\.$`));
  assert.deepEqual(status.capacity.pools.change, { max: 1, inUse: 1, working: 1, stopped: 0, parked: 0, parkedHoldingSlot: 0, waitingForSlot: 1, free: 0 });
  // Stepping the waiting flow starts nothing and writes nothing (parked questions are not woken).
  const token = f.store.changeToken();
  await f.engine.step(a); await f.engine.step(a);
  assert.equal(f.store.changeToken(), token); assert.equal(f.store.need('flow', a).attemptId, null);
  // The other flow finishes: the slot is the answered flow's, not the queue's.
  f.finish(b);
  assert.deepEqual(f.reasons('task-3'), [`flow capacity exhausted; answered flows take the next free slot first: ${a}`]);
  assert.equal(claim(f), null, 'the queued task is not admitted into the freed slot');
  await f.engine.step(a);
  flow = f.store.need('flow', a);
  assert.equal(flow.slotWait, undefined); assert.equal(flow.state, 'ready'); assert.equal(f.events('flow.slot-granted').length, 1);
  await f.engine.step(a);
  assert.ok(f.store.need('flow', a).attemptId, 'it works again');
  assert.deepEqual(f.reasons('task-3'), ['flow capacity exhausted']); assert.equal(claim(f), null);
  assert.equal(queueStatus(f.store).capacity.waitingCount, 0);
});

test('an answer with a free slot continues at once; an answer that parks again or ends takes none', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1'), item = await f.park(a);
  f.ok(f.answer(item, 'retry'));
  let flow = f.store.need('flow', a);
  assert.equal(flow.state, 'ready'); assert.equal(flow.slotWait, undefined); assert.equal(flow.step, 'build');
  // Parked again while another flow takes the slot; `stop` goes to an end node and needs no slot.
  const again = await f.park(a), b = f.admit('task-2');
  f.ok(f.answer(again, 'stop'));
  flow = f.store.need('flow', a);
  assert.equal(flow.step, 'stopped'); assert.equal(flow.slotWait, undefined); assert.equal(flow.state, 'ready');
  assert.deepEqual(f.working().includes(b), true);
});

test('concurrent answers never start more flows than there are slots, and waiting flows resume in order', async t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3, 4]) f.task(`task-${n}`);
  const [a, b, c] = [1, 2, 3].map(n => f.admit(`task-${n}`));
  const items = [await f.park(a), await f.park(b), await f.park(c)];
  f.limit({ 'policy.maxFlows': 1 });
  // Two answers through two connections to the same state, as two processes would send them.
  const other = new Store(f.stateDir); t.after(() => other.close());
  const first = f.answer(items[0], 'retry'), second = f.answer(items[1], 'retry', { store: other });
  assert.equal(first.status, 'completed', first.error); assert.equal(second.status, 'completed', second.error);
  assert.deepEqual(f.working(), [a], 'one slot, one flow working');
  assert.equal(f.store.need('flow', b).slotWait.after, 'answer'); assert.equal(f.store.need('flow', b).state, 'waiting');
  // A third answer queues behind the second.
  f.ok(f.answer(items[2], 'retry', { store: other }));
  let waiting = queueStatus(f.store).capacity.waiting;
  assert.deepEqual(waiting.map(row => [row.flowId, row.position, row.of]), [[b, 1, 2], [c, 2, 2]]);
  // However often the engine steps them, only the slot holder prepares work.
  for (let i = 0; i < 3; i++) for (const id of [c, b, a]) await f.engine.step(id);
  assert.deepEqual(f.working(), [a]);
  assert.deepEqual(f.store.all('attempt').filter(row => !row.settledAt).map(row => row.flowId), [a]);
  // The holder parks again: the first waiter gets the slot, the second still waits, and stepping the
  // second first does not let it jump the line.
  const attempt = f.store.need('attempt', f.store.need('flow', a).attemptId);
  f.store.tx(() => { f.store.put('attempt', { ...attempt, status: 'not-dispatched', settledAt: iso(), costMicros: 0 }); f.at(a, 'build-question'); });
  await f.engine.step(a);
  await f.engine.step(c); assert.ok(f.store.need('flow', c).slotWait, 'not its turn');
  await f.engine.step(b); assert.equal(f.store.need('flow', b).slotWait, undefined);
  await f.engine.step(c); assert.ok(f.store.need('flow', c).slotWait, 'the slot is taken again');
  assert.deepEqual(f.working(), [b]);
  waiting = queueStatus(f.store).capacity.waiting;
  assert.deepEqual(waiting.map(row => [row.flowId, row.position, row.of]), [[c, 1, 1]]);
  // A queued task never gets ahead of a waiting flow, and with two slots both fit.
  // dev.84 (H10): the queued task is told that the answered flow is ahead of it.
  assert.deepEqual(f.reasons('task-4'), [`flow capacity exhausted; answered flows take the next free slot first: ${c}`], 'the only slot is in use, and the answered flow is ahead');
  f.limit({ 'policy.maxFlows': 2 });
  assert.deepEqual(f.reasons('task-4'), [`flow capacity exhausted; answered flows take the next free slot first: ${c}`], 'the second slot is the waiting flow’s');
  await f.engine.step(c); assert.equal(f.store.need('flow', c).slotWait, undefined);
  assert.deepEqual(f.working(), [b, c].sort());
});

test('with several slots, as many answered flows continue as slots are free', async t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3]) f.task(`task-${n}`);
  const ids = [1, 2, 3].map(n => f.admit(`task-${n}`)), items = [];
  for (const id of ids) items.push(await f.park(id));
  f.limit({ 'policy.maxFlows': 2 });
  for (const item of items) f.ok(f.answer(item, 'retry'));
  assert.deepEqual(f.working(), ids.slice(0, 2).sort());
  assert.deepEqual(queueStatus(f.store).capacity.waiting.map(row => row.flowId), [ids[2]]);
});

test('a parked flow beyond the allowance keeps its slot through its answer', async t => {
  const f = delivery(t, { maxFlows: 10, maxParkedFlows: 1 });
  for (const n of [1, 2, 3]) f.task(`task-${n}`);
  const [a, b] = [1, 2].map(n => f.admit(`task-${n}`));
  await f.park(a); const item = await f.park(b);
  f.limit({ 'policy.maxFlows': 1 });
  assert.deepEqual(capacityView(f.store).parked.map(row => [row.flowId, row.holdsSlot]), [[a, false], [b, true]]);
  assert.match(f.reasons('task-3')[0], /parked flows beyond policy\.maxParkedFlows \(1\) hold slots/);
  f.ok(f.answer(item, 'retry'));
  assert.equal(f.store.need('flow', b).slotWait, undefined, 'it held the slot while parked, so it works at once');
  assert.deepEqual(f.working(), [b]);
});

// ---- 3. Exclusions still apply between parked flows and new work ----

test('a parked flow’s declared paths and candidate changes still block overlapping tasks', async t => {
  const f = delivery(t, { maxFlows: 2 });
  f.task('task-1', { paths: ['src/a'] }); f.task('task-2', { paths: ['src/a/x.js'] }); f.task('task-3', { paths: ['docs'] }); f.task('task-4', { paths: ['notes.txt'] });
  const a = f.admit('task-1');
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: a });
  writeFileSync(join(workspace.path, 'notes.txt'), 'candidate change\n');
  f.at(a, 'decide', { state: 'waiting', workspace });
  assert.equal(capacityView(f.store).pools.change.inUse, 0, 'parked: no slot held');
  assert.deepEqual(f.reasons('task-2'), [`paths overlap: ${a}`], 'declared paths');
  assert.deepEqual(f.reasons('task-4'), [`paths overlap: ${a}`], 'candidate changes');
  assert.deepEqual(f.reasons('task-3'), [], 'unrelated work is admitted beside the parked flow');
  // The same holds with one slot: the parked flow frees the slot, not the paths.
  f.limit({ 'policy.maxFlows': 1 });
  assert.deepEqual(f.reasons('task-2'), [`paths overlap: ${a}`]); assert.deepEqual(f.reasons('task-3'), []);
});

test('area and the task’s own open flow still count parked flows', t => {
  const f = delivery(t, { maxFlows: 5 });
  f.task('task-1', { area: 'billing' }); f.task('task-2', { area: 'billing' });
  const a = f.admit('task-1');
  f.at(a, 'decide', { state: 'waiting' });
  assert.deepEqual(f.reasons('task-2'), ['area occupied: billing']);
  assert.ok(f.reasons('task-1').includes('task already active'));
});

// Decision 1 (2026-11-15): a parked flow frees its place in a limited category, under the same parked cap.
test('a parked flow frees its place in a limited category; working, stopped and over-the-limit parked flows hold theirs', async t => {
  const f = delivery(t, { maxFlows: 5, categoryLimits: { feature: 1 } });
  for (const n of [1, 2, 3, 4]) f.task(`task-${n}`, { category: 'feature' });
  f.task('task-5', { category: 'chore' });
  const a = f.admit('task-1');
  assert.deepEqual(f.reasons('task-2'), ['category capacity exhausted: feature'], 'a working flow holds the category’s only place');
  assert.deepEqual(f.reasons('task-5'), [], 'another category is not affected');
  await f.park(a);
  assert.deepEqual(f.reasons('task-2'), [], 'an open question does not hold the category');
  assert.deepEqual(capacityView(f.store).categories, { feature: { max: 1, inUse: 0, working: 0, stopped: 0, parked: 1, parkedHoldingSlot: 0, waitingForSlot: 0, free: 1 } });
  const b = f.admit('task-2');
  assert.deepEqual(f.reasons('task-3'), ['category capacity exhausted: feature']);
  // The same parked cap: with no allowance the parked flow holds its place (and its slot) again.
  f.finish(b); f.limit({ 'policy.maxParkedFlows': 0 });
  assert.deepEqual(f.reasons('task-3'), [`category capacity exhausted: feature; parked flows beyond policy.maxParkedFlows (0) hold places: ${a} (answer their questions)`]);
  f.limit({ 'policy.maxParkedFlows': null });
  assert.deepEqual(f.reasons('task-3'), []);
  // A stopped flow holds its place, like its slot.
  f.ok(f.command('stop', { flowId: a, note: 'Fictional stop' }));
  assert.ok(f.reasons('task-3').includes('category capacity exhausted: feature'));
});

test('an answered flow needs a place in its limited category as well as a slot, and does not hold up other categories', async t => {
  const f = delivery(t, { maxFlows: 5, categoryLimits: { feature: 1 } });
  for (const n of [1, 2, 3]) f.task(`task-${n}`, { category: 'feature' });
  f.task('task-4', { category: 'chore' }); f.task('task-5', { category: 'chore' });
  const a = f.admit('task-1'), item = await f.park(a), b = f.admit('task-2');
  const c = f.admit('task-4'), other = await f.park(c);
  // Slots are free (2 of 5 in use at most), but the category's one place is taken by the second flow.
  f.ok(f.answer(item, 'retry'));
  let flow = f.store.need('flow', a);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.slotWait.after, 'answer'); assert.equal(flow.stopRequested, false);
  assert.deepEqual(f.working(), [b], 'never two flows of a category limited to one');
  const waiting = queueStatus(f.store).capacity.waiting;
  assert.equal(waiting[0].category, 'feature');
  assert.equal(waiting[0].reason, `Waiting for a place in category feature (1 of 1 in use, policy.categoryLimits): position 1 of 1. It continues by itself, ahead of queued tasks, when one of these finishes, parks on a question or is abandoned: ${b}.`);
  assert.deepEqual(f.reasons('task-3'), ['category capacity exhausted: feature'], 'the place is in use');
  // A flow of another category answered behind it is not held up by it.
  f.ok(f.answer(other, 'retry'));
  assert.equal(f.store.need('flow', c).slotWait, undefined); assert.deepEqual(f.working(), [b, c].sort());
  // The place frees: the waiting flow gets it, not the queued task of the same category.
  f.finish(b);
  assert.deepEqual(f.reasons('task-3'), [`category capacity exhausted: feature; answered flows take the next free place first: ${a}`]);
  await f.engine.step(a);
  assert.equal(f.store.need('flow', a).slotWait, undefined);
  assert.deepEqual(f.reasons('task-3'), ['category capacity exhausted: feature']);
});

// Decision 2 (2026-11-15): answered merges, then other answered flows, then new tasks.
test('an answered merge waiting for a slot goes ahead of other answered flows, and both ahead of queued tasks', async t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3, 4, 5]) f.task(`task-${n}`);
  const [a, b, m, w] = [1, 2, 3, 4].map(n => f.admit(`task-${n}`));
  const first = await f.park(a), second = await f.park(b);
  // A third flow at its merge question, opened as the engine opens it.
  const identity = repositoryIdentity(f.root), review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Docs change', threatModel: [], stopConditions: [] } } };
  f.at(m, 'decide', { results: { review }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
  await f.engine.step(m);
  const decide = f.question(m); assert.ok(decide, 'merge question open');
  f.at(w, 'build'); f.limit({ 'policy.maxFlows': 1 });
  queue(f, 'task-5');
  // Two ordinary answers wait, in order; the merge answered last goes to the front.
  f.ok(f.answer(first, 'retry')); await new Promise(resolve => setTimeout(resolve, 3));
  f.ok(f.answer(second, 'retry')); await new Promise(resolve => setTimeout(resolve, 3));
  f.ok(f.answer(decide, 'merge'));
  const merging = f.store.need('flow', m);
  assert.equal(merging.step, 'merge'); assert.equal(merging.slotWait.merge, true); assert.equal(merging.state, 'waiting');
  let line = queueStatus(f.store).capacity.waiting;
  assert.deepEqual(line.map(row => [row.flowId, row.position, row.merge]), [[m, 1, true], [a, 2, false], [b, 3, false]]);
  assert.match(line[0].reason, /position 1 of 3 \(an answered merge goes ahead of other waiting flows\)/);
  assert.match(line[1].reason, /position 2 of 3 \(answered merges go first\)/);
  assert.deepEqual(f.working(), [w]);
  // The slot frees: stepping the others first gives them nothing; the merge takes it.
  f.finish(w);
  await f.engine.step(a); await f.engine.step(b);
  assert.ok(f.store.need('flow', a).slotWait); assert.ok(f.store.need('flow', b).slotWait);
  assert.equal(claim(f), null, 'nor does the queued task take it');
  await f.engine.step(m);
  assert.equal(f.store.need('flow', m).slotWait, undefined); assert.deepEqual(f.working(), [m]);
  assert.deepEqual(mergesInFlight(f.store, 'main').map(row => row.flowId), [m], 'with its slot the merge is in flight');
  // Then the other answered flows in the order they were answered, then the queue.
  f.finish(m);
  await f.engine.step(b); assert.ok(f.store.need('flow', b).slotWait);
  await f.engine.step(a); assert.equal(f.store.need('flow', a).slotWait, undefined);
  f.finish(a); await f.engine.step(b); assert.equal(f.store.need('flow', b).slotWait, undefined);
  assert.equal(claim(f), null); f.finish(b);
  assert.ok(claim(f), 'the queued task starts last');
});

test('an answered merge takes a slot that has just come free even while other answered flows wait for it', async t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3]) f.task(`task-${n}`);
  const [a, m, w] = [1, 2, 3].map(n => f.admit(`task-${n}`));
  const first = await f.park(a);
  const identity = repositoryIdentity(f.root), review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Docs change', threatModel: [], stopConditions: [] } } };
  f.at(m, 'decide', { results: { review }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
  await f.engine.step(m);
  f.at(w, 'build'); f.limit({ 'policy.maxFlows': 1 });
  f.ok(f.answer(first, 'retry'));
  // The slot frees, and before the engine's next tick the merge is answered: it is first in line, so it works at once.
  f.finish(w);
  f.ok(f.answer(f.question(m), 'merge'));
  assert.equal(f.store.need('flow', m).slotWait, undefined); assert.equal(f.store.need('flow', m).state, 'ready');
  await f.engine.step(a);
  assert.ok(f.store.need('flow', a).slotWait, 'the earlier answer still waits: one slot');
  assert.deepEqual(f.working(), [m]);
});

test('an answered merge waiting for a slot is not a merge in flight: nothing waits on it', async t => {
  const f = delivery(t, { maxFlows: 2 });
  f.task('task-1'); f.task('task-2'); f.task('task-3');
  const a = f.admit('task-1'), b = f.admit('task-2');
  f.at(a, 'merge', { state: 'waiting', slotWait: { since: iso(), step: 'merge', after: 'answer' } });
  assert.deepEqual(mergesInFlight(f.store, 'main'), []);
  assert.equal(sourceWait(f.store, 'main', { exceptFlowId: b }), null, 'a flow at source does not wait for a merge that cannot start');
  assert.ok(!f.reasons('task-3').some(reason => /merge in progress/.test(reason)));
  assert.equal(queueStatus(f.store).holds.some(hold => hold.kind === 'merge'), false);
  // With its slot it is in flight, and holds admission as before.
  f.at(a, 'merge', { slotWait: undefined });
  assert.deepEqual(mergesInFlight(f.store, 'main').map(row => row.flowId), [a]);
  assert.ok(f.reasons('task-3').some(reason => /main merge in progress/.test(reason)));
});

// ---- 4. Stop, resume and replan ----

test('stopping a parked flow makes it hold a slot; resuming it asks the question again', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1');
  await f.park(a);
  assert.deepEqual(f.reasons('task-2'), []);
  f.ok(f.command('stop', { flowId: a, note: 'Fictional stop' }));
  assert.deepEqual(f.reasons('task-2'), [`flow capacity exhausted; stopped flows still hold slots: ${a} (resume, abandon, or task.restart their tasks)`]);
  f.ok(f.command('resume', { flowId: a, note: 'Fictional resume' }));
  const flow = f.store.need('flow', a);
  assert.equal(flow.step, 'build-question'); assert.equal(flow.slotWait, undefined);
  // Until the engine opens the question again the flow still holds the slot.
  assert.deepEqual(f.reasons('task-2'), ['flow capacity exhausted']);
  await f.engine.step(a); assert.ok(f.question(a), 'the question is asked again');
  assert.deepEqual(f.reasons('task-2'), [], 'back at its open question: parked again');
});

test('a resumed flow that had no slot waits for one; a stopped flow that held its slot resumes at once', async t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3]) f.task(`task-${n}`);
  const [a, b, s] = [1, 2, 3].map(n => f.admit(`task-${n}`));
  const item = await f.park(a);
  // b works and s is stopped while working: two slots, both held.
  f.at(b, 'build'); f.at(s, 'build'); f.ok(f.command('stop', { flowId: s, note: 'Fictional stop' }));
  f.limit({ 'policy.maxFlows': 2 });
  f.ok(f.answer(item, 'retry'));
  assert.ok(f.store.need('flow', a).slotWait, 'answered: both slots are held (one by the stopped flow)');
  assert.match(queueStatus(f.store).capacity.waiting[0].reason, new RegExp(`${s} \\(stopped\\)`));
  // The stopped flow resumes into its own slot, not behind the waiting flow.
  f.ok(f.command('resume', { flowId: s, note: 'Fictional resume' }));
  assert.equal(f.store.need('flow', s).slotWait, undefined); assert.equal(f.store.need('flow', s).state, 'ready');
  assert.deepEqual(f.working(), [b, s].sort());
  // The waiting flow is stopped and resumed: it still has no slot, so it waits again.
  f.ok(f.command('stop', { flowId: a, note: 'Fictional stop' }));
  assert.equal(f.store.need('flow', a).slotWait, undefined, 'a stopped flow is not in the line');
  f.ok(f.command('resume', { flowId: a, note: 'Fictional resume' }));
  const resumed = f.store.need('flow', a);
  assert.equal(resumed.slotWait.after, 'resume'); assert.equal(resumed.state, 'waiting'); assert.equal(resumed.stopRequested, false);
  await f.engine.step(a); assert.equal(f.store.need('flow', a).attemptId, null);
  assert.deepEqual(f.working(), [b, s].sort(), 'never three flows working on two slots');
  f.finish(b); await f.engine.step(a); await f.engine.step(a);
  assert.ok(f.store.need('flow', a).attemptId, 'it continues when a slot is free');
});

test('replanning a parked flow starts work only with a slot', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1');
  await f.park(a, 'plan-question');
  const b = f.admit('task-2');
  f.ok(f.command('flow.replan', { flowId: a, note: 'Fictional replan' }));
  let flow = f.store.need('flow', a);
  assert.equal(flow.step, 'plan'); assert.equal(flow.slotWait.after, 'replan'); assert.equal(flow.state, 'waiting');
  assert.deepEqual(f.working(), [b]);
  f.finish(b); await f.engine.step(a);
  flow = f.store.need('flow', a);
  assert.equal(flow.slotWait, undefined); assert.equal(flow.state, 'ready');
  // A replan of a flow that already holds its slot is not made to wait.
  f.ok(f.command('flow.replan', { flowId: a, note: 'Fictional replan again' }));
  assert.equal(f.store.need('flow', a).slotWait, undefined);
});

// ---- 5. Upgrade, drain, cleanup, idle notice, wake ----

test('flows already waiting on answers when the release is upgraded are parked at once', t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3]) f.task(`task-${n}`);
  const [a, b] = [1, 2].map(n => f.admit(`task-${n}`));
  // Records as dev.82 wrote them: waiting at a question, no parkedAt, no slotWait.
  for (const [id, step] of [[a, 'decide'], [b, 'plan-question']]) { const { parkedAt, slotWait, ...flow } = f.store.need('flow', id); f.store.put('flow', { ...flow, step, state: 'waiting', attemptId: null }); }
  f.limit({ 'policy.maxFlows': 1 });
  assert.deepEqual(f.reasons('task-3'), [], 'both are parked: the only slot is free');
  const view = capacityView(f.store);
  assert.deepEqual(view.parked.map(row => [row.flowId, row.since, row.holdsSlot]), [[a, null, false], [b, null, false]]);
  // A parked change flow still owns a worktree and a pinned executor: it blocks a drain as before.
  assert.equal(blocksDrain(f.store, f.store.need('flow', a)), true);
  const update = f.command('config.update', { config: base({ maxFlows: 2 }), note: 'Fictional upgrade' });
  assert.equal(update.status, 'rejected'); assert.match(update.error, /drain or abandon work before changing configuration/);
});

test('a parked flow’s workspace is not cleaned up, and it still counts as open work', async t => {
  const f = delivery(t);
  f.task('task-1');
  const a = f.admit('task-1');
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: a });
  f.at(a, 'decide', { state: 'waiting', workspace });
  await assert.rejects(cleanupPlan(f.stateDir, a), /only failed, abandoned or completed flows can be cleaned up here/);
  assert.ok(existsSync(workspace.path));
  assert.equal(settingsView(f.store).activeFlows, 1, 'Settings still counts it as an open flow');
});

test('the idle-capacity observation counts the slot a parked flow frees, and not one an answered flow is owed', async t => {
  const f = delivery(t);
  f.task('task-1', { paths: ['src'] }); f.task('task-2', { paths: ['src/x'] }); f.task('task-3');
  const a = f.admit('task-1'), item = await f.park(a);
  queue(f, 'task-2');
  const observe = () => observeQueue(f.store, { reasonsForTask: task => admissionReasons(f.store, task) });
  let seen = observe();
  assert.equal(seen.freeSlots, 1); assert.equal(seen.idle, true, 'queued work is not starting although a slot is free: its paths overlap the parked flow');
  assert.deepEqual(seen.rows[0].eligibility.reasons, [`paths overlap: ${a}`]);
  // Another flow takes the slot and the parked one is answered: the slot that frees next is spoken for.
  const b = f.admit('task-3');
  f.ok(f.answer(item, 'retry'));
  f.finish(b);
  seen = observe();
  assert.equal(seen.freeSlots, 0); assert.equal(seen.idle, false);
});

test('a parked question stays quiet for the engine', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1');
  await f.park(a);
  await f.engine.step(a);
  assert.equal(f.engine.quiet(a, f.store.changeToken()), true, 'nothing its question depends on changed');
  assert.equal(f.store.need('flow', a).parkedAt, f.question(a).createdAt, 'when it parked is recorded with the question');
  const steps = f.engine.stats.steps; await f.engine.tick();
  assert.equal(f.engine.stats.steps, steps, 'a tick does not step it');
});

// ---- 6. Status views and configuration ----

test('queue status, the dashboard, the full snapshot and the narrow status reads show parked and waiting flows apart from active ones', async t => {
  const f = delivery(t, { maxFlows: 10 });
  for (const n of [1, 2, 3]) f.task(`task-${n}`);
  const [a, b, c] = [1, 2, 3].map(n => f.admit(`task-${n}`));
  const item = await f.park(a); await f.park(b); f.at(c, 'build');
  f.limit({ 'policy.maxFlows': 1 });
  f.ok(f.answer(item, 'retry'));
  const expected = { max: 1, inUse: 1, working: 1, stopped: 0, parked: 1, parkedHoldingSlot: 0, waitingForSlot: 1, free: 0 };
  // Queue status.
  const status = queueStatus(f.store);
  assert.deepEqual(status.capacity.pools.change, expected); assert.equal(status.capacity.parkedCount, 1); assert.equal(status.capacity.waitingCount, 1);
  assert.deepEqual(status.capacity.parked.map(row => [row.flowId, row.taskId, row.title, row.pool, row.step, row.holdsSlot]), [[b, 'task-2', 'Fictional task-2', 'change', 'build-question', false]]);
  // Dashboard (what the console and `status --compact` read): a projecting view without workflows.
  const dashboard = dashboardSnapshot(f.store);
  assert.deepEqual(dashboard.queueStatus.capacity.pools.change, expected);
  assert.deepEqual(dashboard.queueStatus.capacity.parked.map(row => row.flowId), [b]);
  assert.deepEqual(dashboard.queueStatus.capacity.waiting.map(row => [row.flowId, row.position]), [[a, 1]]);
  const listed = id => dashboard.flows.find(flow => flow.id === id);
  assert.equal(listed(b).parked, true); assert.equal(listed(c).parked, false); assert.equal(listed(a).parked, false);
  assert.equal(listed(a).slotWait.after, 'answer'); assert.equal(listed(c).slotWait, null);
  // Full snapshot.
  const full = snapshot(f.store);
  assert.deepEqual(full.queueStatus.capacity.pools.change, expected);
  assert.equal(full.flows.find(flow => flow.id === b).parked, true); assert.equal(full.flows.find(flow => flow.id === c).parked, false);
  // Narrow reads.
  const parked = stateView(f.store, { flow: b }), waiting = stateView(f.store, { flow: a }), active = stateView(f.store, { flow: c });
  assert.equal(parked.flow.parked, true); assert.equal(parked.flow.slotWait, null); assert.ok(parked.flow.parkedAt);
  assert.equal(active.flow.parked, false);
  assert.equal(waiting.flow.parked, false); assert.equal(waiting.flow.slotWait.position, 1); assert.match(waiting.flow.slotWait.reason, /Waiting for a change flow slot \(1 of 1 in use/);
  assert.deepEqual(parked.project.capacity.pools.change, expected);
  assert.deepEqual(parked.project.capacity.parked, [{ flowId: b, step: 'build-question', since: f.store.need('flow', b).parkedAt, holdsSlot: false }]);
  assert.deepEqual(parked.project.capacity.waiting.map(row => [row.flowId, row.position]), [[a, 1]]);
});

test('policy.maxParkedFlows is validated, defaults to 3, is in the starter template and is a live setting', async t => {
  const config = base();
  for (const value of [-1, 51, 1.5, '3', null]) assert.throws(() => validateConfig({ ...structuredClone(config), policy: { ...config.policy, maxParkedFlows: value } }), /policy\.maxParkedFlows must be a whole number from 0 to 50/, String(value));
  for (const value of [0, 3, 50]) assert.equal(validateConfig({ ...structuredClone(config), policy: { ...config.policy, maxParkedFlows: value } }).policy.maxParkedFlows, value);
  const template = JSON.parse(await readFile(new URL('../starter/project/factotum.template.json', import.meta.url), 'utf8'));
  assert.equal(template.policy.maxParkedFlows, 3);
  const f = delivery(t);
  let live = settingsView(f.store).live['policy.maxParkedFlows'];
  assert.deepEqual([live.value, live.isDefault, live.type], [3, true, 'count']);
  const digest = f.store.meta('configDigest');
  assert.deepEqual(f.limit({ 'policy.maxParkedFlows': 5 }).values, { 'policy.maxParkedFlows': 5 });
  assert.equal(f.store.meta('configDigest'), digest, 'a live change: no drain, no doctor');
  assert.equal(f.command('settings.update', { changes: { 'policy.maxParkedFlows': -1 }, note: 'x' }).status, 'rejected');
  assert.equal(f.limit({ 'policy.maxParkedFlows': null }).values['policy.maxParkedFlows'], 3, 'null resets to the default');
  assert.equal(snapshot(f.store).settings.policy.maxParkedFlows, undefined);
  f.limit({ 'policy.maxParkedFlows': 2 });
  assert.equal(snapshot(f.store).settings.policy.maxParkedFlows, 2);
});

// ---- 7. G5: a flow's own changes are compared with the target it integrated ----

const commitFile = async (cwd, path, text, message) => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', message]); return (await git(cwd, ['rev-parse', 'HEAD'])).stdout; };

test('G5: files the target brought into an integrated candidate do not count as the flow’s own changes', async t => {
  const f = delivery(t, { maxFlows: 2 });
  // The report's scenario: a document flow at its merge question, and a source-code task.
  f.task('task-1', { paths: ['docs/handbook.md'] }); f.task('task-2', { paths: ['src', 'test', 'README.md', 'CHANGELOG.md'] }); f.task('task-3', { paths: ['docs'] });
  const a = f.admit('task-1');
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: a });
  await commitFile(workspace.path, 'docs/handbook.md', 'Handbook\n', 'Write the handbook');
  // Other work merges to the target meanwhile.
  await commitFile(f.root, 'src/app.mjs', 'export const app = 1;\n', 'Other work: app');
  const moved = await commitFile(f.root, 'README.md', 'Readme\n', 'Other work: readme');
  setTargetHealth(f.store, 'main', { status: 'green', head: moved, checkedAt: iso() });
  f.at(a, 'build', { workspace });
  assert.deepEqual(activeConflictPaths(f.store, f.store.need('flow', a)).sort(), ['docs/handbook.md'], 'before integration: only its own file');
  // The flow integrates the moved target on its way to the merge question.
  await git(workspace.path, ['merge', '--no-edit', moved]);
  const head = (await git(workspace.path, ['rev-parse', 'HEAD'])).stdout;
  // Without a recorded integration the earlier, more conservative reading stands (a builder may have merged it).
  f.at(a, 'decide', { state: 'waiting', workspace });
  assert.deepEqual(activeConflictPaths(f.store, f.store.need('flow', a)).sort(), ['README.md', 'docs/handbook.md', 'src/app.mjs']);
  assert.deepEqual(f.reasons('task-2'), [`paths overlap: ${a}`]);
  // With the integration the factory recorded, only the flow's own change counts.
  const integrated = { base: moved, head, previousHead: head, conflicts: false, conflictedPaths: [], route: 'integrated' };
  f.at(a, 'decide', { state: 'waiting', workspace, results: { ...f.store.need('flow', a).results, integrate: integrated } });
  assert.deepEqual(activeConflictPaths(f.store, f.store.need('flow', a)).sort(), ['docs/handbook.md']);
  assert.deepEqual(f.reasons('task-2'), [], 'the source-code task is admitted beside the document flow');
  assert.deepEqual(f.reasons('task-3'), [`paths overlap: ${a}`], 'its own file still excludes overlapping work');
  // Uncommitted and untracked work in the candidate still counts.
  writeFileSync(join(workspace.path, 'CHANGELOG.md'), 'pending\n');
  assert.deepEqual(f.reasons('task-2'), [`paths overlap: ${a}`]);
  await rm(join(workspace.path, 'CHANGELOG.md'));
  // A recorded integration the candidate does not contain is not trusted: the original base is used.
  const later = await commitFile(f.root, 'test/app.test.mjs', 'test\n', 'Other work: test');
  f.at(a, 'decide', { state: 'waiting', workspace, results: { ...f.store.need('flow', a).results, integrate: { ...integrated, base: later } } });
  assert.deepEqual(activeConflictPaths(f.store, f.store.need('flow', a)).sort(), ['README.md', 'docs/handbook.md', 'src/app.mjs']);
  assert.deepEqual(f.reasons('task-2'), [`paths overlap: ${a}`]);
});

test('G5: an integration that conflicted is compared with the target being merged', async t => {
  const f = delivery(t, { maxFlows: 2 });
  f.task('task-1', { paths: ['docs/handbook.md'] }); f.task('task-2', { paths: ['src'] });
  const a = f.admit('task-1');
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: a });
  await commitFile(workspace.path, 'docs/handbook.md', 'Handbook\n', 'Write the handbook');
  await commitFile(f.root, 'src/app.mjs', 'export const app = 1;\n', 'Other work: app');
  const moved = await commitFile(f.root, 'docs/handbook.md', 'Another handbook\n', 'Other work: the same document');
  const merge = await git(workspace.path, ['merge', '--no-edit', moved], { allowFailure: true });
  assert.notEqual(merge.code, 0, 'the fictional merge conflicts');
  f.at(a, 'conflict-question', { state: 'waiting', workspace, results: { integrate: { base: moved, conflicts: true, conflictedPaths: ['docs/handbook.md'], route: 'conflict' } } });
  assert.deepEqual(activeConflictPaths(f.store, f.store.need('flow', a)).sort(), ['docs/handbook.md']);
  assert.deepEqual(f.reasons('task-2'), []);
});

// ---- 8. G10: a flow at source asks for the verification a moved target needs ----

const unverified = head => ({ exitCode: 0, costMicros: 0, actionResult: { route: 'target-unverified', targetHealthHold: { target: 'main', head }, reason: 'main needs current verification' } });
async function sourceFlow(t, policy) {
  const f = delivery(t, policy);
  f.task('task-1');
  const a = f.admit('task-1');
  await f.engine.step(a);
  const attempt = () => f.store.need('attempt', f.store.need('flow', a).attemptId);
  return { ...f, a, attempt };
}

test('G10: a flow started just after an outside push requests the target’s verification and waits for it', async t => {
  const f = await sourceFlow(t);
  // The source check finds the target at a head nobody verified; nothing is verifying it.
  f.engine.settle(f.a, f.attempt(), unverified(H('e')));
  let flow = f.store.need('flow', f.a);
  assert.equal(flow.state, 'waiting'); assert.equal(flow.step, 'source'); assert.equal(flow.stopReason ?? null, null); assert.equal(flow.stopRequested, false);
  assert.equal(flow.targetWait.kind, 'verification');
  const jobs = f.store.all('job').filter(job => job.operation === 'main.verify');
  assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'queued'); assert.equal(jobs[0].id, flow.targetWait.jobId);
  assert.deepEqual([jobs[0].grant.actor, jobs[0].grant.source, jobs[0].grant.policy, jobs[0].grant.configDigest], ['operator', 'configuration', 'autoQueue', f.store.meta('configDigest')]);
  assert.match(flow.targetWait.reason, /^Waiting: main verification is queued \(job main-refresh:.*\); this flow continues when main is verified green$/);
  assert.equal(f.events('flow.verification-requested').length, 1);
  assert.equal(f.events('main.verify-requested')[0].payload.cause, `flow ${f.a} at its source step`);
  assert.equal(targetHealth(f.store, 'main').status, 'unknown'); assert.equal(targetHealth(f.store, 'main').head, H('e'));
  // Waiting again writes nothing and asks for nothing more.
  const token = f.store.changeToken();
  await f.engine.step(f.a);
  assert.equal(f.store.changeToken(), token); assert.equal(f.store.all('job').filter(job => job.operation === 'main.verify').length, 1);
  // Verified green: the flow repeats its source check by itself.
  f.store.tx(() => { setTargetHealth(f.store, 'main', { status: 'green', head: H('e'), checkedAt: iso() }); f.store.put('job', { ...f.store.need('job', jobs[0].id), status: 'completed' }); });
  await f.engine.step(f.a);
  flow = f.store.need('flow', f.a);
  assert.equal(flow.targetWait, undefined); assert.ok(flow.attemptId, 'source verification prepared again without a resume');
  assert.equal(f.attempt().intent.action.mainHealth.head, H('e'));
  assert.equal(f.events('flow.stopped').length, 0);
});

test('G10: where no verification may be requested the flow stops and the reason names what to do', async t => {
  const stopped = async (prepare, pattern, policy) => {
    const f = await sourceFlow(t, policy);
    prepare(f);
    f.engine.settle(f.a, f.attempt(), unverified(H('e')));
    const flow = f.store.need('flow', f.a);
    assert.equal(flow.state, 'stopped', pattern); assert.equal(flow.resumeStep, 'source'); assert.match(flow.stopReason, pattern);
    assert.match(flow.stopReason, /then resume this flow/);
    assert.equal(f.store.all('job').filter(job => job.operation === 'main.verify' && job.status === 'queued').length, 0, 'nothing was queued');
    return f;
  };
  await stopped(() => {}, /main is not verified for source admission and no verification was requested: automatic verification is off \(policy\.autoQueue\)\. To continue: run main\.verify for main \(job\.enqueue \{operation: "main\.verify"\}\) or doctor/, { autoQueue: false });
  await stopped(f => f.ok(f.command('pause', { paused: true, note: 'Fictional pause' })), /no verification was requested: admission is paused, so a verification would not start\. To continue: resume admission \(pause \{paused: false\}\)/);
  await stopped(f => f.store.setMeta('commissioning', null), /no verification was requested: doctor has not passed for the current configuration\. To continue: run doctor/);
  await stopped(f => f.store.put('job', { id: 'earlier-verify', operation: 'main.verify', payload: {}, status: 'failed', createdAt: iso(), finishedAt: iso() }), /no verification was requested: the last verification of main failed 0 minutes ago and is not repeated automatically for 15 minutes\. To continue: inspect that verification, then run main\.verify for main/);
  // A newer red result is a finding: nothing is verified again, the branch needs fixing.
  await stopped(f => setTargetHealth(f.store, 'main', { status: 'red', head: H('e'), checkedAt: iso() }), /no verification was requested: main is red \(its last verification failed\)\. To continue: fix main, then run main\.verify for main/);
});

test('G10: a verification that cannot start stops the flow naming it, and repeated requests are bounded', async t => {
  // Maintenance is held: the requested job cannot start, so the flow does not wait on it.
  const held = await sourceFlow(t);
  held.ok(held.command('pause', { paused: true, holdMaintenance: true, note: 'Fictional upgrade hold' }));
  held.store.setMeta('paused', false);
  held.engine.settle(held.a, held.attempt(), unverified(H('e')));
  assert.equal(held.store.need('flow', held.a).state, 'stopped');
  assert.match(held.store.need('flow', held.a).stopReason, /main needs verification, but main\.verify job main-refresh:.* cannot proceed: maintenance is held/);
  // The target keeps moving: after SOURCE_VERIFY_REQUESTS requests in one source visit the flow stops.
  const f = await sourceFlow(t);
  for (let i = 1; i <= SOURCE_VERIFY_REQUESTS; i++) {
    f.engine.settle(f.a, f.attempt(), unverified(H(String(i))));
    const flow = f.store.need('flow', f.a);
    assert.equal(flow.state, 'waiting', `request ${i}`); assert.equal(flow.sourceVerifyRequests.count, i);
    // The verification passes for the head it saw; the next source check finds another one.
    await new Promise(resolve => setTimeout(resolve, 3));
    f.store.tx(() => { setTargetHealth(f.store, 'main', { status: 'green', head: H(String(i)), checkedAt: iso() }); f.store.put('job', { ...f.store.need('job', flow.targetWait.jobId), status: 'completed' }); });
    await f.engine.step(f.a);
    assert.ok(f.store.need('flow', f.a).attemptId);
  }
  f.engine.settle(f.a, f.attempt(), unverified(H('f')));
  const flow = f.store.need('flow', f.a);
  assert.equal(flow.state, 'stopped');
  assert.match(flow.stopReason, new RegExp(`main is not verified for source admission: ${SOURCE_VERIFY_REQUESTS} verifications were requested for this flow and main is still not current`));
  assert.equal(f.store.all('job').filter(job => job.operation === 'main.verify').length, SOURCE_VERIFY_REQUESTS);
});

// ---- 9. G9: the target moves while a merge question is open ----

async function mergeQuestion(t, { paths = ['docs'], policy, before, integratedAfter = false, open = true } = {}) {
  const f = delivery(t, policy);
  f.task('task-1', { paths });
  const a = f.admit('task-1'), integratedAt = repositoryIdentity(f.root).head;
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: a });
  await commitFile(workspace.path, 'docs/guide.md', 'Guide\n', 'Write the guide');
  const identity = repositoryIdentity(workspace.path);
  const review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Docs change', threatModel: [], stopConditions: [] } } };
  if (before) await before(f);
  // integratedAfter: the candidate integrated the target as `before` left it.
  f.at(a, 'decide', { workspace, results: { integrate: { base: integratedAfter ? repositoryIdentity(f.root).head : integratedAt, head: identity.head, conflicts: false, route: 'integrated' }, review }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
  await f.engine.step(a);
  const item = f.question(a); if (open) assert.ok(item, 'merge question open');
  // The target moves: a commit on the target branch, and the head the factory records for it (as
  // a verification, another flow's merge or the target probe does).
  const move = async (path, text = 'moved\n') => { const head = await commitFile(f.root, path, text, `Outside change to ${path}`); setTargetHealth(f.store, 'main', { status: 'unknown', head, checkedAt: iso(), reason: 'moved outside the factory' }); return head; };
  return { ...f, a, integratedAt, workspace, identity, item, move };
}
const short = sha => sha.slice(0, 12);

test('G9: an open merge question says when the target moved onto files the candidate touches, and what merge then does', async t => {
  const f = await mergeQuestion(t);
  assert.equal(f.item.targetMoved, undefined); assert.equal(f.item.context, undefined); assert.equal(f.item.version, 1);
  const head = await f.move('docs/other.md');
  await f.engine.tick();
  const item = f.question(f.a);
  assert.equal(item.id, f.item.id); assert.equal(item.status, 'open'); assert.equal(item.subjectDigest, f.item.subjectDigest, 'the candidate is the same');
  assert.equal(item.version, 2, 'the card changed: an answer on the earlier card is refused');
  assert.deepEqual({ ...item.targetMoved, observedAt: null }, { target: 'main', from: f.integratedAt, to: head, changed: 1, overlap: ['docs/other.md'], overlapCount: 1, observedAt: null, baseContext: null });
  assert.equal(item.context, `The target main moved from ${short(f.integratedAt)} to ${short(head)} after this candidate was integrated at ${short(f.integratedAt)}. Its new commits change files this candidate also touches or declares (docs/other.md). Answering merge does not merge this candidate as it is: the merge step returns to integration, the checks and review run again on the re-integrated candidate, and a new merge question follows.`);
  assert.equal(f.events('inbox.target-moved').length, 1);
  // Nothing more is written while nothing changes.
  const token = f.store.changeToken(); await f.engine.tick(); await f.engine.tick();
  assert.equal(f.store.changeToken(), token);
  // The answer given on the card that did not say so is refused; the current card is answerable.
  const stale = f.answer(f.item, 'merge');
  assert.equal(stale.status, 'rejected'); assert.match(stale.error, /stale or resolved question/);
  assert.equal(f.store.need('flow', f.a).step, 'decide');
  f.ok(f.answer(item, 'merge'));
  assert.equal(f.store.need('flow', f.a).step, 'merge');
});

test('G9: a move that touches nothing of the candidate is stated too, and later moves update the same card', async t => {
  const f = await mergeQuestion(t);
  const first = await f.move('src/app.mjs');
  await f.engine.tick();
  let item = f.question(f.a);
  assert.equal(item.version, 2); assert.equal(item.targetMoved.overlapCount, 0);
  assert.equal(item.context, `The target main moved from ${short(f.integratedAt)} to ${short(first)} after this candidate was integrated at ${short(f.integratedAt)}. Its new commits (1 file) touch none of this candidate's changed files or declared paths. Answering merge merges this candidate onto the moved target without integrating it again: the review and the checks ran against ${short(f.integratedAt)}, not against ${short(first)}, and are not repeated before the merge. Only post-merge verification checks the combined result.`);
  // It moves again, now onto the candidate's own file: the text changes, the version does not.
  const second = await f.move('docs/guide.md', 'Someone else\n');
  await f.engine.tick();
  item = f.question(f.a);
  assert.equal(item.version, 2); assert.equal(item.targetMoved.to, second); assert.deepEqual(item.targetMoved.overlap, ['docs/guide.md']);
  assert.match(item.context, new RegExp(`moved from ${short(f.integratedAt)} to ${short(second)} .* integrated at ${short(f.integratedAt)}\\. Its new commits change files this candidate also touches or declares \\(docs/guide\\.md\\)`));
  assert.equal(f.events('inbox.target-moved').length, 2);
});

test('G9: a recorded head whose commits are not local yet, an older recorded head, and a question opened after the move', async t => {
  // The head is known only as a ref (a push the probe saw): what it changed is not known yet.
  const f = await mergeQuestion(t);
  setTargetHealth(f.store, 'main', { status: 'unknown', head: H('e'), checkedAt: iso() });
  await f.engine.tick();
  let item = f.question(f.a);
  assert.equal(item.version, 2); assert.equal(item.targetMoved.overlap, null);
  assert.match(item.context, /The new commits are not in the local repository yet, so whether they touch this candidate's files is checked when merge is answered/);
  // The recorded head is older than what the candidate integrated: not a move.
  const g = await mergeQuestion(t, { integratedAfter: true, before: async f => { await commitFile(f.root, 'src/earlier.mjs', 'x\n', 'Earlier target commit'); } });
  assert.notEqual(targetHealth(g.store, 'main').head, g.store.need('flow', g.a).results.integrate.base);
  await g.engine.tick();
  assert.equal(g.question(g.a).targetMoved, undefined); assert.equal(g.question(g.a).version, 1);
  // The target moved between integration and the question: the first card already says so.
  let moved;
  const h = await mergeQuestion(t, { before: async f => { moved = await commitFile(f.root, 'docs/late.md', 'x\n', 'Late target commit'); setTargetHealth(f.store, 'main', { status: 'unknown', head: moved, checkedAt: iso() }); } });
  // (integratedAt was read before the late commit.)
  assert.equal(h.item.version, 1); assert.equal(h.item.targetMoved.to, moved); assert.match(h.item.context, /returns to integration/);
});

// Decision 5 (2026-11-15): the probe runs for an open merge question with or without policy.autoQueue, bounded.
test('G9: the target is probed for an open merge question, without policy.autoQueue too, at most once per five minutes', async t => {
  for (const autoQueue of [false, true]) {
    const f = await mergeQuestion(t, { policy: { mainProbeMs: 60000, autoQueue } });
    const outside = await commitFile(f.root, 'docs/pushed.md', 'x\n', 'Pushed outside the factory');
    let head = targetHealth(f.store, 'main').head;
    const calls = [], run = async (binary, args) => { calls.push(args); return { code: 0, stdout: `${head}\trefs/heads/main\n` }; };
    assert.equal(f.store.all('queue').filter(row => row.status === 'queued').length, 0, 'nothing is queued');
    const start = Date.now();
    // Unmoved so far: one read, nothing changes.
    assert.deepEqual(await probeTargetHead(f.store, { run, nowMs: start }), { head, moved: false }); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['ls-remote', 'origin', 'refs/heads/main']);
    // Not again within five minutes, however often the loop runs (policy.mainProbeMs is one minute here).
    head = outside;
    for (const later of [1000, 61000, MERGE_QUESTION_PROBE_MS - 1]) assert.equal(await probeTargetHead(f.store, { run, nowMs: start + later }), null);
    assert.equal(calls.length, 1); assert.equal(targetHealth(f.store, 'main').status, 'green');
    // After five minutes: the push is noticed, recorded and stated on the question.
    assert.deepEqual(await probeTargetHead(f.store, { run, nowMs: start + MERGE_QUESTION_PROBE_MS }), { head: outside, moved: true }); assert.equal(calls.length, 2);
    assert.equal(targetHealth(f.store, 'main').head, outside); assert.equal(targetHealth(f.store, 'main').status, 'unknown');
    assert.equal(f.events('main.moved').length, 1);
    await f.engine.tick();
    assert.equal(f.question(f.a).targetMoved.to, outside); assert.equal(f.question(f.a).version, 2);
    // The question is answered: no more reads for it.
    f.ok(f.answer(f.question(f.a), 'stop'));
    setTargetHealth(f.store, 'main', { status: 'green', head: outside, checkedAt: iso() });
    assert.equal(await probeTargetHead(f.store, { run, nowMs: start + 3 * MERGE_QUESTION_PROBE_MS }), null); assert.equal(calls.length, 2);
  }
});

test('G9: no merge question and no queued work means no probe; policy.mainProbeMs 0 turns it off; a longer policy.mainProbeMs is kept', async t => {
  const calls = [], run = async (binary, args) => { calls.push(args); return { code: 0, stdout: `${H('e')}\trefs/heads/main\n` }; };
  const idle = delivery(t, { mainProbeMs: 60000, autoQueue: false });
  assert.equal(await probeTargetHead(idle.store, { run }), null);
  // A flow parked at another question is not a reason to read the target.
  idle.task('task-1'); const a = idle.admit('task-1'); await idle.park(a);
  assert.equal(await probeTargetHead(idle.store, { run }), null); assert.equal(calls.length, 0);
  // Queued work without autoQueue is not one either (as before).
  idle.task('task-2'); queue(idle, 'task-2');
  assert.equal(await probeTargetHead(idle.store, { run }), null); assert.equal(calls.length, 0);
  const off = await mergeQuestion(t, { policy: { mainProbeMs: 0, autoQueue: false } });
  assert.equal(await probeTargetHead(off.store, { run }), null); assert.equal(calls.length, 0);
  const slow = await mergeQuestion(t, { policy: { mainProbeMs: 900000, autoQueue: false } }), start = Date.now();
  await probeTargetHead(slow.store, { run, nowMs: start }); assert.equal(calls.length, 1);
  setTargetHealth(slow.store, 'main', { status: 'green', head: H('e'), checkedAt: iso() });
  assert.equal(await probeTargetHead(slow.store, { run, nowMs: start + MERGE_QUESTION_PROBE_MS }), null, 'the longer configured interval applies');
  assert.notEqual(await probeTargetHead(slow.store, { run, nowMs: start + 900000 }), null); assert.equal(calls.length, 2);
});

test('G9: targetMove reads only the local repository and tells the three cases apart', async t => {
  const f = await mergeQuestion(t);
  const cwd = f.workspace.path, base = f.integratedAt;
  assert.deepEqual(targetMove(cwd, { base, head: base }), { moved: false });
  assert.deepEqual(targetMove(cwd, { base, head: null }), { moved: false });
  const head = await commitFile(f.root, 'src/a.mjs', 'x\n', 'Target change');
  assert.deepEqual(targetMove(cwd, { base, head, scope: ['docs'] }), { moved: true, from: base, to: head, changed: 1, overlap: [], overlapCount: 0 });
  assert.deepEqual(targetMove(cwd, { base, head, scope: ['src/'] }).overlap, ['src/a.mjs'], 'a declared path');
  assert.deepEqual(targetMove(cwd, { base, head, scope: ['../odd'] }).overlap, ['src/a.mjs'], 'an unreadable declared path counts as everything');
  assert.deepEqual(targetMove(cwd, { base: head, head: base }), { moved: false }, 'the known head is behind the integration');
  assert.equal(targetMove(cwd, { base, head: H('e') }).overlap, null);
  assert.equal(targetMoveText({ moved: false }), '');
});

// ---- 10. G9: the merge step reads the target itself ----

async function mergeFixture(t, { strict = false, ahead = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dev83-merge-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'), gh = join(bin, 'gh'); await mkdir(bin);
  // A fictional gh: answers from responses.json and records every call.
  await writeFile(gh, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),dir=path.dirname(process.argv[1]),args=process.argv.slice(2);
if(args[0]==='auth'){console.log('fictional-token');process.exit(0);}
const method=args[args.indexOf('--method')+1],endpoint=args.find(a=>a.startsWith('repos/'));
fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({method,endpoint})+'\\n');
const values=JSON.parse(fs.readFileSync(path.join(dir,'responses.json'),'utf8'));let value=values[method+' '+endpoint]??values[endpoint];
if(value===undefined){process.stderr.write('gh: Not Found (HTTP 404)');process.exit(1);}
// A forge that requires branches to be up to date before merging: the pull request is behind
// when the target's head is not the base it integrated, and the merge is refused (no reason given).
if(values.__strict){
  const head=require('node:child_process').execFileSync('git',['--git-dir',values.__strict.remote,'rev-parse','refs/heads/main'],{encoding:'utf8'}).trim(),behind=head!==values.__strict.base;
  if(behind&&method==='PUT'){process.stderr.write('gh: Pull Request is not mergeable (HTTP 405)');process.exit(1);}
  if(method!=='PUT'&&endpoint==='repos/fictional/demo/pulls/7')value={...value,mergeable_state:behind?'behind':'clean'};
}
console.log(JSON.stringify(value));
`); await chmod(gh, 0o700);
  const root = join(directory, 'root'), remote = join(directory, 'remote.git'), outside = join(directory, 'outside'); await mkdir(root);
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fictional Developer']); await git(root, ['config', 'user.email', 'developer@example.invalid']);
  await writeFile(join(root, 'app.txt'), 'initial\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  const earlier = repositoryIdentity(root).head;
  // ahead: the candidate integrated a later target commit, and the target is then force-pushed back.
  if (ahead) { await writeFile(join(root, 'later.txt'), 'later\n'); await git(root, ['add', '.']); await git(root, ['commit', '-m', 'later target commit']); }
  await git(root, ['init', '--bare', remote]); await git(root, ['remote', 'add', 'origin', remote]); await git(root, ['push', '-u', 'origin', 'main']);
  const integratedAt = repositoryIdentity(root).head;
  const workspace = await prepare({ root, stateDir: join(directory, 'state'), projectId: 'project-1', flowId: 'flow-1', baseRef: integratedAt });
  if (ahead) execFileSync('git', ['--git-dir', remote, 'update-ref', 'refs/heads/main', earlier]);
  const head = await commitFile(workspace.path, 'docs/guide.md', 'Guide\n', 'Write the guide');
  await writeFile(join(bin, 'responses.json'), JSON.stringify({
    'repos/fictional/demo/pulls/7': { number: 7, state: 'open', draft: false, merged: false, commits: 1, head: { sha: head, ref: workspace.branch }, base: { sha: integratedAt, ref: 'main' }, html_url: 'https://example.invalid/pull/7', title: 'Guide', body: '' },
    'repos/fictional/demo/pulls/7/commits?per_page=100&page=1': [{ sha: head, commit: { message: 'Write the guide' } }],
    'PUT repos/fictional/demo/pulls/7/merge': { merged: true, sha: H('f') },
    ...(strict ? { __strict: { remote, base: integratedAt } } : {}),
  }));
  // Another branch on the remote, created from the target with one more commit.
  const branch = async (name, path) => { await push; if (!existsSync(outside)) execFileSync('git', ['clone', '-q', '-b', 'main', remote, outside]); await git(outside, ['config', 'user.name', 'Outside Developer']); await git(outside, ['config', 'user.email', 'outside@example.invalid']); await git(outside, ['switch', '-q', '-c', name]); await commitFile(outside, path, 'branch\n', `Branch change to ${path}`); await git(outside, ['push', 'origin', name]); await git(outside, ['switch', '-q', 'main']); };
  // Someone else pushes to the target from another clone, after the candidate integrated it.
  const push = async path => { if (!existsSync(outside)) { execFileSync('git', ['clone', '-q', '-b', 'main', remote, outside]); await git(outside, ['config', 'user.name', 'Outside Developer']); await git(outside, ['config', 'user.email', 'outside@example.invalid']); } const sha = await commitFile(outside, path, 'outside\n', `Outside change to ${path}`); await git(outside, ['push', 'origin', 'main']); return sha; };
  const calls = async () => existsSync(join(bin, 'calls.jsonl')) ? (await readFile(join(bin, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const identity = repositoryIdentity(workspace.path);
  const merge = ({ remote: remoteName = 'origin' } = {}) => runAction({ attemptId: uid(), cwd: workspace.path, projectRoot: root, timeoutMs: 60000, action: { operation: 'forge.merge', stateDir: join(directory, 'state'), projectId: 'project-1', flowId: 'flow-1', workspace, target: 'main',
    task: { id: 'task-1', title: 'Fictional guide', acceptance: ['Guide exists'], revision: 'r1', risk: 'ordinary', paths: ['docs'] }, context: { files: [], digest: 'context' }, artifactDir: join(directory, 'artifacts'), sessions: {},
    config: { repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: remoteName, ghPath: gh }, checks: [{ id: 'check', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 24000 } },
    results: { publish: { number: 7 }, integrate: { base: integratedAt, head, conflicts: false, route: 'integrated' } }, mergeAuthorization: { identity, actor: 'operator', authority: 'operator' } } });
  const merged = async () => (await calls()).some(call => call.method === 'PUT');
  return { integratedAt, earlier, head, push, branch, merge, merged, workspace, remote };
}

test('G9: the merge step merges when the target has not moved', async t => {
  const f = await mergeFixture(t), result = await f.merge();
  assert.equal(result.route, 'merged', JSON.stringify(result)); assert.equal(result.merged, true); assert.equal(result.targetMoved, undefined);
  assert.equal(await f.merged(), true);
});

test('G9: a target that moved onto the candidate’s files sends the merge back to integration, with nothing merged', async t => {
  const f = await mergeFixture(t), outside = await f.push('docs/readme.md');
  const result = await f.merge();
  assert.equal(result.route, 'stale', JSON.stringify(result));
  assert.deepEqual(result.targetMoved, { moved: true, from: f.integratedAt, to: outside, changed: 1, overlap: ['docs/readme.md'], overlapCount: 1 });
  assert.match(result.reason, new RegExp(`^target advanced before merge: The target main moved from ${short(f.integratedAt)} to ${short(outside)} after this candidate was integrated at ${short(f.integratedAt)}\\.`));
  assert.equal(await f.merged(), false, 'the forge was not asked to merge');
});

test('G9: a target that moved elsewhere is merged onto, and the move is recorded with the merge', async t => {
  const f = await mergeFixture(t), outside = await f.push('src/other.mjs');
  const result = await f.merge();
  assert.equal(result.route, 'merged', JSON.stringify(result));
  assert.deepEqual(result.targetMoved, { moved: true, from: f.integratedAt, to: outside, changed: 1, overlap: [], overlapCount: 0 });
  assert.equal(await f.merged(), true);
});

test('dev.84 H8: merges answered together into one target run one at a time; the second waits visibly through the first merge and its post-merge step', async t => {
  const f = delivery(t, { maxFlows: 2 });
  f.task('task-1', { paths: ['docs'] }); f.task('task-2', { paths: ['src'] });
  const [a, b] = ['task-1', 'task-2'].map(id => f.admit(id)), integratedAt = repositoryIdentity(f.root).head;
  for (const [flowId, file] of [[a, 'docs/guide.md'], [b, 'src/app.mjs']]) {
    const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId });
    await commitFile(workspace.path, file, 'Fictional\n', `Write ${file}`);
    const identity = repositoryIdentity(workspace.path), review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Fictional change', threatModel: [], stopConditions: [] } } };
    f.at(flowId, 'decide', { workspace, results: { integrate: { base: integratedAt, head: identity.head, conflicts: false, route: 'integrated' }, review }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
    await f.engine.step(flowId);
  }
  // Both answered within a moment of each other, as in the report.
  f.ok(f.answer(f.question(a), 'merge')); f.ok(f.answer(f.question(b), 'merge'));
  await f.engine.step(a);
  const first = f.store.need('attempt', f.store.need('flow', a).attemptId);
  assert.equal(first.step, 'merge');
  await f.engine.step(b);
  let flow = f.store.need('flow', b);
  assert.equal(flow.attemptId, null, 'the second merge is not dispatched beside the first');
  assert.equal(flow.step, 'merge'); assert.equal(flow.state, 'waiting'); assert.deepEqual(flow.mergeWait.flowIds, [a]); assert.equal(flow.mergeWait.target, 'main');
  assert.match(flow.mergeWait.reason, new RegExp(`^Waiting: flow ${a} is merging into main\\. Merges into one target run one at a time; this merge starts when that has finished, then reads main again: it merges without a new review when main's new commits do not touch this candidate's files, and goes back to integration when they do$`));
  assert.equal(f.events('flow.merge-wait').length, 1);
  assert.deepEqual(stateView(f.store, { flow: b }).flow.mergeWait.flowIds, [a], 'status --flow shows the wait');
  // An unchanged wait writes nothing.
  const token = f.store.changeToken(); await f.engine.step(b); assert.equal(f.store.changeToken(), token);
  // The first merges; the second still waits for its post-merge step.
  f.engine.settle(a, first, { exitCode: 0, costMicros: 0, actionResult: { route: 'merged', merged: true, sha: H('f') } });
  assert.equal(f.store.need('flow', a).step, 'post-merge');
  await f.engine.step(b);
  flow = f.store.need('flow', b);
  assert.equal(flow.attemptId, null); assert.match(flow.mergeWait.reason, new RegExp(`flow ${a} is finishing its post-merge step after merging into main`));
  await f.engine.step(a);
  const post = f.store.need('attempt', f.store.need('flow', a).attemptId); assert.equal(post.step, 'post-merge');
  await f.engine.step(b); assert.equal(f.store.need('flow', b).attemptId, null, 'still waiting while the post-merge step runs');
  f.engine.settle(a, post, { exitCode: 0, costMicros: 0, actionResult: { route: 'recorded', obligations: [] } });
  assert.equal(f.store.need('flow', a).step, 'close-task');
  // Now the second merge runs (its own step reads the moved target: G9).
  await f.engine.step(b);
  flow = f.store.need('flow', b);
  assert.equal(flow.mergeWait, undefined); assert.ok(flow.attemptId, 'the second merge is dispatched'); assert.equal(f.store.need('attempt', flow.attemptId).step, 'merge');
  assert.deepEqual(f.events('flow.merge-released').map(event => event.payload.flowId), [b]);
});

test('dev.84 H8: a stopped or uncertain merge, and a merge into another target, hold no other merge', async t => {
  const f = delivery(t, { maxFlows: 3 });
  for (const n of [1, 2]) f.task(`task-${n}`);
  const [a, b] = [1, 2].map(n => f.admit(`task-${n}`));
  f.store.put('attempt', { id: 'merge-a', flowId: a, step: 'merge', status: 'running', reservedMicros: 0 });
  f.at(a, 'merge', { attemptId: 'merge-a', state: 'running' });
  assert.deepEqual(mergesAhead(f.store, 'main', { exceptFlowId: b }).map(row => [row.flowId, row.stage]), [[a, 'merge']]);
  assert.deepEqual(mergesAhead(f.store, 'release', { exceptFlowId: b }), [], 'another target is not held');
  f.store.put('attempt', { ...f.store.need('attempt', 'merge-a'), status: 'uncertain' });
  assert.deepEqual(mergesAhead(f.store, 'main', { exceptFlowId: b }), [], 'an uncertain merge promises nothing; the next merge reads the target itself');
  f.at(a, 'merge', { attemptId: 'merge-a', state: 'stopped', stopRequested: true });
  assert.deepEqual(mergesAhead(f.store, 'main', { exceptFlowId: b }), []);
  // A flow waiting at its merge step holds no attempt, so two waits never hold each other.
  f.at(a, 'merge', { attemptId: null, state: 'waiting', stopRequested: false, mergeWait: { flowIds: [b] } });
  assert.deepEqual(mergesAhead(f.store, 'main', { exceptFlowId: b }), []);
});

test('G9: a stale merge result returns the flow to integration, and the next merge question is a new one', async t => {
  const f = await mergeQuestion(t);
  f.ok(f.answer(f.item, 'merge'));
  await f.engine.step(f.a);
  const attempt = f.store.need('attempt', f.store.need('flow', f.a).attemptId);
  assert.equal(attempt.step, 'merge');
  const moved = { moved: true, from: f.integratedAt, to: H('e'), changed: 1, overlap: ['docs/guide.md'], overlapCount: 1 };
  f.engine.settle(f.a, attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'stale', reason: 'target advanced before merge', targetMoved: moved } });
  const flow = f.store.need('flow', f.a);
  assert.equal(flow.step, 'integrate'); assert.equal(flow.state, 'ready'); assert.deepEqual(flow.results.merge.targetMoved, moved);
  assert.equal(f.store.need('inbox', f.item.id).status, 'answered', 'the earlier question stays answered');
});

test('a merge question answered by policy as it opens keeps its slot: the merge is not made to wait', async t => {
  const f = await mergeQuestion(t, { open: false, before: async f => {
    // autoMerge as a qualified project has it; the configuration digest flows are bound to is unchanged.
    const config = f.store.meta('config'); f.store.setMeta('config', { ...config, policy: { ...config.policy, autoMerge: true }, qualification: { qualified: true, targetFreshness: 'strict-status' } });
    f.task('task-2'); queue(f, 'task-2');
  } });
  const flow = f.store.need('flow', f.a), item = f.store.all('inbox').find(row => row.flowId === f.a && row.kind === 'question');
  assert.equal(item.autoMerge, true); assert.equal(item.status, 'answered'); assert.equal(item.answeredBy, 'orchestrator');
  assert.equal(flow.step, 'merge'); assert.equal(flow.slotWait, undefined); assert.equal(flow.state, 'ready');
  assert.deepEqual(f.working(), [f.a]);
  assert.ok(f.reasons('task-2').some(reason => /flow capacity exhausted/.test(reason)), 'the queued task did not take the slot');
});

// ======== Review fixes (docs/changes/dev83-admission.md, "Review fixes") ========

// ---- 1. flow.replan never starts work without a slot ----

test('review: a flow answered stop and replanned before the engine ends it waits for a slot (repro A)', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1'), item = await f.park(a), b = f.admit('task-2');
  f.ok(f.answer(item, 'stop'));
  assert.equal(f.store.need('flow', a).step, 'stopped'); assert.equal(f.store.need('flow', a).state, 'ready');
  // Before the next engine tick (a window that lasts a whole recovery hold): replan.
  f.ok(f.command('flow.replan', { flowId: a, note: 'Fictional change of mind' }));
  const flow = f.store.need('flow', a);
  assert.equal(flow.step, 'plan'); assert.equal(flow.state, 'waiting'); assert.equal(flow.slotWait.after, 'replan');
  assert.deepEqual(f.working(), [b], 'one slot, one flow working');
  await f.engine.step(a); assert.equal(f.store.need('flow', a).attemptId, null);
  f.finish(b); await f.engine.step(a); await f.engine.step(a);
  assert.ok(f.store.need('flow', a).attemptId, 'it plans once the slot is free');
});

test('review: a parked flow stopped, resumed and replanned before its question is asked again waits for a slot (repro B)', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1');
  await f.park(a);
  const b = f.admit('task-2');
  f.ok(f.command('stop', { flowId: a, note: 'Fictional stop' }));
  f.ok(f.command('resume', { flowId: a, note: 'Fictional resume' }));
  assert.equal(f.store.need('flow', a).state, 'ready'); assert.equal(f.store.need('flow', a).step, 'build-question');
  f.ok(f.command('flow.replan', { flowId: a, note: 'Fictional replan' }));
  assert.equal(f.store.need('flow', a).slotWait.after, 'replan');
  assert.deepEqual(f.working(), [b]);
});

test('review: a flow that really holds its slot replans at once, from a question it has just reached too', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1');
  // Reached a question, not asked yet: it still holds the only slot, so the replan continues.
  f.at(a, 'build-question');
  f.ok(f.command('flow.replan', { flowId: a, note: 'Fictional replan' }));
  assert.equal(f.store.need('flow', a).slotWait, undefined); assert.equal(f.store.need('flow', a).state, 'ready');
  assert.deepEqual(f.working(), [a]);
  f.ok(f.command('flow.replan', { flowId: a, note: 'Fictional replan from a working step' }));
  assert.equal(f.store.need('flow', a).slotWait, undefined);
});

test('review: replanning an abandoned flow goes through capacity and the exclusions it stopped holding', async t => {
  const f = delivery(t);
  f.task('task-1', { paths: ['src'] }); f.task('task-2', { paths: ['docs'] }); f.task('task-3', { paths: ['src/app'] });
  const a = f.admit('task-1');
  f.ok(f.command('flow.abandon', { flowId: a, note: 'Fictional abandon' }));
  // Another flow has the slot since: the revived flow waits.
  const b = f.admit('task-2');
  f.ok(f.command('flow.replan', { flowId: a, note: 'Fictional revival' }));
  assert.equal(f.store.need('flow', a).slotWait.after, 'replan'); assert.deepEqual(f.working(), [b]);
  // Work admitted on its paths since it was abandoned: the revival is refused.
  f.ok(f.command('flow.abandon', { flowId: a, note: 'Fictional abandon again' })); f.finish(b);
  const c = f.admit('task-3');
  const refused = f.command('flow.replan', { flowId: a, note: 'Fictional revival' });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, new RegExp(`cannot replan finished flow ${a}: paths overlap: ${c}`));
  // Its task started again meanwhile: refused too.
  f.finish(c);
  const again = f.ok(f.command('flow.start', { taskId: 'task-1', revision: f.store.need('task', 'task-1').revision, flowId: 'flow-task-1-again' }));
  const owned = f.command('flow.replan', { flowId: a, note: 'Fictional revival' });
  assert.equal(owned.status, 'rejected'); assert.match(owned.error, /cannot replan finished flow .*: task already active/);
  assert.deepEqual(f.working(), [again.id]);
});

// A seeded random walk over every command that can start work. After each step no more flows may
// be at a working step than there are slots, nor more of a limited category than its limit.
const SEEDS = 50, STEPS = 60;
test('review: random sequences of start, park, answer, stop, resume, replan, abandon and engine steps never over-admit', async t => {
  const f = delivery(t, { maxFlows: 1, categoryLimits: { db: 1 } });
  const random = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const kindOf = flow => flow.workflow.nodes[flow.step]?.kind, open = flow => !['completed', 'failed'].includes(flow.state);
  const atWork = flow => open(flow) && flow.kind === 'change' && flow.state !== 'stopped' && !flow.stopRequested && !flow.slotWait && !['question', 'end'].includes(kindOf(flow));
  // The questions are opened by an engine that fingerprints the checkout on this thread (the walk opens thousands).
  const { Engine } = await import('../starter/factory/core/engine.mjs'), engine = new Engine(f.store, { fingerprint: async root => repositoryIdentity(root) });
  let steps = 0, crowded = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const next = random(seed), pick = list => list[Math.floor(next() * list.length)];
    // A clean start for the seed: earlier flows finished, limits set while nothing runs.
    for (const flow of f.store.live('flow').filter(open)) f.store.put('flow', { ...flow, state: 'failed', attemptId: null, finishedAt: iso(), abandonedAt: iso() });
    // Mostly one slot, where an extra working flow is easiest to produce; sometimes two or three.
    const maxFlows = pick([1, 1, 1, 2, 2, 3]), tasks = [0, 1, 2, 3, 4, 5].map(n => `s${seed}-t${n}`);
    f.limit({ 'policy.maxFlows': maxFlows, 'policy.maxParkedFlows': Math.floor(next() * 3) });
    for (const id of tasks) f.task(id, { category: pick(['db', 'db', 'ui', undefined]) });
    const flows = () => f.store.live('flow').filter(flow => flow.taskId.startsWith(`s${seed}-`));
    const log = [];
    for (let i = 0; i < STEPS; i++) {
      // With fewer than two flows open the walk starts another: over-admission needs company.
      const all = flows(), live = all.filter(open), op = live.length < 2 && next() < 0.6 ? 'start' : pick(['start', 'start', 'start', 'park', 'park', 'park', 'park', 'engine', 'engine', 'answer', 'answer', 'answer', 'answer', 'stop', 'resume', 'resume', 'replan', 'replan', 'replan', 'abandon', 'finish']);
      let done = op;
      if (op === 'start') { const id = pick(tasks); f.command('flow.start', { taskId: id, revision: f.store.need('task', id).revision, flowId: `f-${id}-${i}` }); done += ` ${id}`; }
      // A working flow reaches a question; usually the engine opens it at once, sometimes only later.
      else if (op === 'park') { const flow = pick(live.filter(atWork)); if (flow) { f.at(flow.id, pick(['build-question', 'plan-question']), { parkedAt: iso() }); if (next() < 0.8) await engine.step(flow.id); done += ` ${flow.id}`; } }
      else if (op === 'engine') { const flow = pick(live.filter(flow => flow.slotWait || ['question', 'end'].includes(kindOf(flow)))); if (flow) { await engine.step(flow.id); done += ` ${flow.id}`; } }
      else if (op === 'answer') { const item = pick(f.store.live('inbox').filter(row => row.kind === 'question' && row.status === 'open' && live.some(flow => flow.id === row.flowId))); if (item) { const answer = pick(item.answers); f.answer(item, answer, { extra: answer === 'replan' ? { note: 'Fictional answer' } : {} }); done += ` ${item.flowId} ${answer}`; } }
      else if (op === 'stop') { const flow = pick(live); if (flow) { f.command('stop', { flowId: flow.id, note: 'Fictional stop' }); done += ` ${flow.id}`; } }
      else if (op === 'resume') { const flow = pick(live.filter(flow => flow.state === 'stopped')); if (flow) { f.command('resume', { flowId: flow.id, note: 'Fictional resume' }); done += ` ${flow.id}`; } }
      else if (op === 'replan') { const flow = pick(next() < 0.8 && live.length ? live : all); if (flow) { f.command('flow.replan', { flowId: flow.id, note: 'Fictional replan' }); done += ` ${flow.id}`; } }
      else if (op === 'abandon') { const flow = pick(live); if (flow) { f.command('flow.abandon', { flowId: flow.id, note: 'Fictional abandon' }); done += ` ${flow.id}`; } }
      else if (op === 'finish') { const flow = pick(live.filter(atWork)); if (flow) { f.finish(flow.id); done += ` ${flow.id}`; } }
      log.push(done); steps++; if (flows().filter(open).length > maxFlows) crowded++;
      const working = flows().filter(atWork), trace = () => `seed ${seed}, maxFlows ${maxFlows}: ${log.join(' | ')}`;
      assert.ok(working.length <= maxFlows, `${working.length} flows at work on ${maxFlows} slot(s): ${working.map(flow => `${flow.id}@${flow.step}`).join(', ')}\n${trace()}`);
      const db = working.filter(flow => flow.taskSnapshot.category === 'db');
      assert.ok(db.length <= 1, `${db.length} db flows at work with a limit of 1: ${db.map(flow => flow.id).join(', ')}\n${trace()}`);
      assert.deepEqual(f.store.all('attempt').filter(row => !row.settledAt).length, 0, 'the walk never prepares an attempt');
    }
  }
  assert.equal(steps, SEEDS * STEPS);
  // The walk is only a test if it often has more open flows than slots.
  assert.ok(crowded > steps / 10, `${crowded} of ${steps} steps had more open flows than slots`);
});

// ---- 2. A waiter blocked on a full category reserves no pool slot ----

test('review: an answered flow waiting on a full category does not hold a pool slot back from other categories', async t => {
  const f = delivery(t, { maxFlows: 2, categoryLimits: { db: 1 } });
  f.task('task-1', { category: 'db' }); f.task('task-2', { category: 'db' }); f.task('task-3', { category: 'ui' }); f.task('task-4', { category: 'db' });
  const a = f.admit('task-1'), item = await f.park(a), b = f.admit('task-2');
  f.ok(f.command('stop', { flowId: b, note: 'Fictional stop' }));
  f.ok(f.answer(item, 'retry'));
  assert.ok(f.store.need('flow', a).slotWait, 'the db place is held by the stopped flow');
  queue(f, 'task-3');
  // One of two slots is in use; the waiting flow cannot use the other, so the ui task may.
  const status = queueStatus(f.store), pool = status.capacity.pools.change;
  assert.deepEqual([pool.inUse, pool.waitingForSlot, pool.free], [1, 1, 1]);
  assert.deepEqual(f.reasons('task-3'), []);
  assert.deepEqual(f.reasons('task-4'), ['category capacity exhausted: db'], 'the db place is still taken');
  // Queue status names the waiter, the category and what holds it.
  assert.deepEqual(status.capacity.categoryWaits.map(row => [row.flowId, row.category, row.inUse, row.max, row.heldBy]), [[a, 'db', 1, 1, [{ flowId: b, state: 'stopped' }]]]);
  assert.equal(status.capacity.categoryWaits[0].text, `Flow ${a} was answered and waits for a place in category db (1 of 1 in use, policy.categoryLimits), held by ${b} (stopped). A change flow slot is free meanwhile; queued tasks of other categories can take it.`);
  assert.equal(dashboardSnapshot(f.store).queueStatus.capacity.categoryWaits.length, 1);
  const ui = claim(f);
  assert.ok(ui, 'the queued ui task is admitted'); assert.equal(ui.taskId, 'task-3');
  assert.deepEqual(queueStatus(f.store).capacity.categoryWaits, [], 'no slot stands idle any more');
  // The waiter kept its place in line: when the db place frees it is first, ahead of the queued db task.
  queue(f, 'task-4');
  f.ok(f.command('flow.abandon', { flowId: b, note: 'Fictional abandon' })); f.finish(ui.id);
  assert.deepEqual(f.reasons('task-4'), [`category capacity exhausted: db; answered flows take the next free place first: ${a}`]);
  assert.equal(claim(f), null);
  await f.engine.step(a); assert.equal(f.store.need('flow', a).slotWait, undefined);
});

test('review: the idle-capacity notice says which answered flow a full category holds back', async t => {
  const f = delivery(t, { maxFlows: 2, categoryLimits: { db: 1 } });
  f.task('task-1', { category: 'db' }); f.task('task-2', { category: 'db' }); f.task('task-3', { category: 'db' });
  const a = f.admit('task-1'), item = await f.park(a), b = f.admit('task-2');
  f.ok(f.command('stop', { flowId: b, note: 'Fictional stop' })); f.ok(f.answer(item, 'retry'));
  queue(f, 'task-3');
  const start = Date.now(), observe = nowMs => observeQueue(f.store, { nowMs, reasonsForTask: task => admissionReasons(f.store, task) });
  assert.equal(observe(start).freeSlots, 1);
  observe(start + 1800000);
  const notice = f.store.need('inbox', 'queue:idle-capacity');
  assert.equal(notice.status, 'open'); assert.deepEqual(notice.categoryWaits.map(row => [row.flowId, row.category]), [[a, 'db']]);
  assert.match(notice.summary, new RegExp(`Flow ${a} was answered and waits for a place in category db \\(1 of 1 in use, policy\\.categoryLimits\\), held by ${b} \\(stopped\\)`));
});

// ---- 3. ls-remote: only the exact ref ----

test('review: a remote head is read from the line of exactly the ref asked for', async t => {
  const { remoteRefHead } = await import('../starter/factory/core/git-options.mjs');
  const lines = `${H('a')}\trefs/heads/a/refs/heads/main\n${H('b')}\trefs/heads/main\n`;
  assert.equal(remoteRefHead(lines, 'refs/heads/main'), H('b'));
  assert.equal(remoteRefHead(`${H('a')}\trefs/heads/a/refs/heads/main\n`, 'refs/heads/main'), null);
  assert.equal(remoteRefHead('not-a-sha\trefs/heads/main\n', 'refs/heads/main'), null);
  assert.equal(remoteRefHead('', 'refs/heads/main'), null);
  // The target probe: the other branch's line comes first and is not the target's head.
  const f = await mergeQuestion(t, { policy: { mainProbeMs: 60000, autoQueue: false } }), head = targetHealth(f.store, 'main').head;
  const run = async () => ({ code: 0, stdout: `${H('a')}\trefs/heads/a/refs/heads/main\n${head}\trefs/heads/main\n` });
  assert.deepEqual(await probeTargetHead(f.store, { run }), { head, moved: false });
  assert.equal(targetHealth(f.store, 'main').status, 'green');
});

test('review: the merge step is not fooled by a branch whose name ends in refs/heads/<target>', async t => {
  const f = await mergeFixture(t);
  await f.branch('a/refs/heads/main', 'docs/elsewhere.md');
  const listed = execFileSync('git', ['ls-remote', f.remote, 'refs/heads/main'], { encoding: 'utf8' }).trim().split('\n');
  assert.equal(listed.length, 2, 'Git lists both refs'); assert.match(listed[0], /refs\/heads\/a\/refs\/heads\/main$/);
  const result = await f.merge();
  assert.equal(result.route, 'merged', JSON.stringify(result)); assert.equal(result.targetMoved, undefined, 'the target itself did not move');
});

// ---- 4. The merge step's remote read is bounded ----

test('review: a remote that never answers ends the target read at its timeout, with nothing left running', async t => {
  const net = await import('node:net'), sockets = new Set();
  // It accepts, reads and never replies. (Reading is what lets it notice the client going away.)
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.resume(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const f = await mergeFixture(t);
  await git(f.workspace.path, ['remote', 'add', 'hung', `http://127.0.0.1:${server.address().port}/fictional.git`]);
  const { observeMergeTarget } = await import('../starter/factory/workflows/dispatch.mjs');
  const started = Date.now();
  const observed = await observeMergeTarget({ cwd: f.workspace.path, remote: 'hung', target: 'main', base: f.integratedAt, scope: [], timeoutMs: 700 });
  const elapsed = Date.now() - started;
  assert.equal(observed.moved, false); assert.equal(observed.unknown, true); assert.match(observed.error, /git ls-remote timed out after 700 ms/);
  assert.ok(elapsed >= 650 && elapsed < 5000, `returned after ${elapsed} ms`);
  // Git and its transport helper are gone: the connection they held is closed.
  const end = Date.now() + 5000; while (sockets.size && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(sockets.size, 0, 'no process still holds the connection');
});

test('review: a target that cannot be read leaves the merge as dev.82 made it, and says so on the result', async t => {
  const f = await mergeFixture(t);
  const result = await f.merge({ remote: 'missing' });
  assert.equal(result.route, 'merged', JSON.stringify(result));
  assert.equal(result.targetMoved.unknown, true); assert.equal(result.targetMoved.moved, false); assert.ok(result.targetMoved.error);
});

// ---- 5. A forge that requires an up-to-date branch ----

test('review: the forge adapter recognises an out-of-date refusal, by its text or by the pull request’s state', async () => {
  const { createGitHub, ForgeError } = await import('../starter/factory/adapters/github/index.mjs');
  const HEAD = H('a'), BASE = H('b');
  const forge = ({ refusal, state }) => createGitHub({ repository: 'fictional/demo', transport: async request => {
    if (request.path.includes('/commits?')) return [{ sha: HEAD, commit: { message: 'Safe candidate' } }];
    if (request.path.includes('/protection')) throw new ForgeError('not configured', { status: 404 });
    if (request.method === 'PUT') throw refusal;
    return { number: 1, state: 'open', head: { sha: HEAD, ref: 'feature' }, base: { sha: BASE, ref: 'main' }, merged: false, commits: 1, mergeable_state: state };
  } });
  const merge = options => forge(options).merge({ number: 1, expectedHead: HEAD, expectedBase: BASE });
  const refused = (message, status = 405) => new ForgeError(message, { status, kind: 'transport' });
  // Said in the refusal.
  await assert.rejects(merge({ refusal: refused('GitHub operation failed: Base branch was modified. Review and try the merge again.'), state: 'clean' }), error => error.kind === 'out-of-date' && error.status === 405 && /out of date with main/.test(error.message));
  // Not said: the pull request, read again, is behind its base.
  await assert.rejects(merge({ refusal: refused('GitHub operation failed (transport HTTP 405)'), state: 'behind' }), error => error.kind === 'out-of-date');
  // Another refusal stays what it was.
  await assert.rejects(merge({ refusal: refused('GitHub operation failed (transport HTTP 405)'), state: 'blocked' }), error => error.kind === 'transport' && error.status === 405);
  await assert.rejects(merge({ refusal: refused('GitHub operation failed (authorization HTTP 403)', 403), state: 'behind' }), error => error.kind === 'transport' && error.status === 403);
  // An uncertain outcome is still reconciled, never read as out of date.
  await assert.rejects(merge({ refusal: new ForgeError('out of date?', { status: 502, ambiguous: true }), state: 'behind' }), /Merge outcome uncertain/);
});

test('review: with a forge that requires an up-to-date branch, a move to unrelated files re-integrates instead of failing', async t => {
  const f = await mergeFixture(t, { strict: true });
  // Up to date: the strict forge merges.
  const current = await f.merge();
  assert.equal(current.route, 'merged', JSON.stringify(current));
  // Someone pushes unrelated files: the factory would merge onto them, the forge refuses.
  const g = await mergeFixture(t, { strict: true }), outside = await g.push('src/other.mjs');
  const result = await g.merge();
  assert.equal(result.route, 'stale', JSON.stringify(result)); assert.equal(result.outOfDate, true);
  assert.match(result.reason, /^target advanced before merge: GitHub refused the merge: the pull request's branch is out of date with main \(HTTP 405\)/);
  assert.deepEqual(result.targetMoved, { moved: true, from: g.integratedAt, to: outside, changed: 1, overlap: [], overlapCount: 0 });
  assert.equal(result.merged, undefined, 'the forge refused: nothing was merged');
  assert.equal(await g.merged(), true, 'the forge was asked, as it would be without the rule');
});

// ---- 6. Smaller items ----

test('review: the probe looks for reasons only when a read is due, and runs for merge questions while admission is paused', async t => {
  const f = await mergeQuestion(t, { policy: { mainProbeMs: 60000, autoQueue: true } }), head = targetHealth(f.store, 'main').head;
  const run = async () => ({ code: 0, stdout: `${head}\trefs/heads/main\n` }), start = Date.now();
  let reads = 0; const live = f.store.live.bind(f.store); f.store.live = kind => { if (kind === 'flow') reads++; return live(kind); };
  assert.deepEqual(await probeTargetHead(f.store, { run, nowMs: start }), { head, moved: false });
  assert.ok(reads >= 1); reads = 0;
  // Not due: neither the queue nor the flows are read.
  for (const later of [100, 30000, 59000]) assert.equal(await probeTargetHead(f.store, { run, nowMs: start + later }), null);
  assert.equal(reads, 0, 'no live-flow read while no probe is due');
  // Due, with nothing to probe for and nothing written since: looked up once, then not again.
  const idle = delivery(t, { mainProbeMs: 60000, autoQueue: true });
  let idleReads = 0; const idleLive = idle.store.live.bind(idle.store); idle.store.live = kind => { if (kind === 'flow') idleReads++; return idleLive(kind); };
  for (let i = 0; i < 5; i++) assert.equal(await probeTargetHead(idle.store, { run }), null);
  assert.equal(idleReads, 1);
  // Paused: the queue is not a reason, the open merge question still is.
  f.store.live = live;
  f.ok(f.command('pause', { paused: true, note: 'Fictional pause' }));
  f.task('task-9'); queue(f, 'task-9');
  assert.deepEqual(await probeTargetHead(f.store, { run, nowMs: start + MERGE_QUESTION_PROBE_MS, mergeQuestionsOnly: true }), { head, moved: false });
  const paused = delivery(t, { mainProbeMs: 60000, autoQueue: true });
  paused.task('task-1'); queue(paused, 'task-1');
  assert.equal(await probeTargetHead(paused.store, { run, mergeQuestionsOnly: true }), null, 'queued work alone is no reason while paused');
  // The operations loop makes that call while paused: the read is stamped.
  const { operationalTick } = await import('../starter/factory/workflows/maintenance.mjs');
  const g = await mergeQuestion(t, { policy: { mainProbeMs: 60000, autoQueue: false } });
  g.ok(g.command('pause', { paused: true, note: 'Fictional pause' }));
  assert.equal(g.store.meta('targetProbeAt') ?? null, null);
  await operationalTick(g.store);
  assert.ok(g.store.meta('targetProbeAt'), 'the target was read for the open merge question while paused');
});

test('review: a moved target ends a pending presentation of the merge question and tells its presenter', async t => {
  const f = await mergeQuestion(t);
  const presented = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'inbox.present', payload: { inboxId: f.item.id, expectedVersion: f.item.version, channel: 'fictional prompt' } });
  assert.equal(presented.status, 'completed', presented.error);
  await f.move('docs/other.md');
  await f.engine.tick();
  const item = f.question(f.a), row = item.presentations[0];
  assert.equal(item.version, 2); assert.equal(item.status, 'open');
  assert.equal(row.status, 'obsolete'); assert.equal(row.endedBy, 'factory'); assert.equal(row.notify, true);
  assert.match(row.reason, /^the question changed: the target main moved after the candidate was integrated, .* it stays open in the inbox at version 2$/);
  assert.equal(f.events('inbox.presentation-ended').length, 1);
  // The presenter is owed a wake on the current version's delivery, and can present the current card.
  const delivery = f.store.all('delivery').find(entry => entry.inboxId === item.id && entry.inboxVersion === 2);
  assert.equal(delivery.presentationEnded.id, row.id);
  const again = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'inbox.present', payload: { inboxId: item.id, expectedVersion: 2, channel: 'fictional prompt' } });
  assert.equal(again.status, 'completed', again.error);
});

test('review: a target moved back behind the integrated base counts as moved', async t => {
  // The merge step reads the target itself: a force-push back is a move.
  const f = await mergeFixture(t, { ahead: true });
  const result = await f.merge();
  assert.equal(result.route, 'stale', JSON.stringify(result));
  assert.equal(result.targetMoved.rewound, true); assert.equal(result.targetMoved.from, f.integratedAt); assert.equal(result.targetMoved.to, f.earlier);
  assert.match(result.reason, /was moved back from .* an earlier commit than this candidate integrated/);
  assert.equal(await f.merged(), false);
  // The card: only for a head observed after the question opened (the probe, a verification), not for an older record.
  const g = await mergeQuestion(t, { integratedAfter: true, before: async g => { await commitFile(g.root, 'src/earlier.mjs', 'x\n', 'Target commit the candidate integrated'); } });
  const earlier = targetHealth(g.store, 'main').head;
  await g.engine.tick();
  assert.equal(g.question(g.a).targetMoved, undefined, 'an older record is not a move');
  await new Promise(resolve => setTimeout(resolve, 5));
  setTargetHealth(g.store, 'main', { status: 'unknown', head: earlier, previousHead: g.store.need('flow', g.a).results.integrate.base, checkedAt: iso(), reason: 'moved outside the factory' });
  await g.engine.tick();
  const item = g.question(g.a);
  assert.equal(item.targetMoved.rewound, true); assert.equal(item.targetMoved.to, earlier); assert.equal(item.version, 2);
  assert.match(item.context, /^The target main was moved back from .* \(a force-push or reset\): commits this candidate contains are no longer on the target\. Answering merge does not merge this candidate as it is/);
});

test('review: a move whose commits were not local is looked at again once they are fetched', async t => {
  const f = await mergeQuestion(t);
  const { Engine } = await import('../starter/factory/core/engine.mjs');
  const engine = new Engine(f.store, { revalidateMs: 20 });
  await engine.step(f.a);
  // A push known only by its head: the commit is in another clone, not in this repository.
  const elsewhere = join(f.base, 'elsewhere');
  execFileSync('git', ['clone', '-q', f.root, elsewhere]);
  await git(elsewhere, ['config', 'user.name', 'Outside Developer']); await git(elsewhere, ['config', 'user.email', 'outside@example.invalid']);
  const outside = await commitFile(elsewhere, 'docs/pushed.md', 'x\n', 'Pushed outside the factory');
  setTargetHealth(f.store, 'main', { status: 'unknown', head: outside, checkedAt: iso() });
  await engine.step(f.a);
  assert.equal(f.question(f.a).targetMoved.overlap, null);
  // Stepped again at once (any store write does that): not compared again yet.
  f.store.setMeta('fictionalWrite', 1); await engine.step(f.a);
  assert.equal(f.question(f.a).targetMoved.overlap, null);
  // The commits arrive with a fetch; the recorded head is the same.
  await git(f.root, ['fetch', '-q', elsewhere, 'HEAD']);
  await new Promise(resolve => setTimeout(resolve, 30));
  await engine.step(f.a);
  const item = f.question(f.a);
  assert.deepEqual(item.targetMoved.overlap, ['docs/pushed.md']); assert.equal(item.version, 2, 'the same card, updated');
  assert.match(item.context, /Its new commits change files this candidate also touches or declares \(docs\/pushed\.md\)/);
});

test('review: a target verified green while the source check ran repeats the check, a bounded number of times', async t => {
  const f = await sourceFlow(t);
  for (let i = 1; i <= SOURCE_VERIFY_REQUESTS; i++) {
    // Verified green (for another head than the check saw) between dispatch and settlement.
    setTargetHealth(f.store, 'main', { status: 'green', head: H(String(i)), checkedAt: iso() });
    f.engine.settle(f.a, f.attempt(), unverified(H('e')));
    const flow = f.store.need('flow', f.a);
    assert.equal(flow.state, 'ready', `recheck ${i}`); assert.equal(flow.step, 'source'); assert.equal(flow.stopReason ?? null, null);
    assert.equal(targetHealth(f.store, 'main').status, 'green', 'the newer verification stands');
    await f.engine.step(f.a);
    assert.ok(f.store.need('flow', f.a).attemptId, 'the source check is prepared again without a resume');
  }
  assert.equal(f.events('flow.source-recheck').length, SOURCE_VERIFY_REQUESTS); assert.equal(f.store.all('job').filter(job => job.operation === 'main.verify').length, 0);
  setTargetHealth(f.store, 'main', { status: 'green', head: H('9'), checkedAt: iso() });
  f.engine.settle(f.a, f.attempt(), unverified(H('e')));
  assert.equal(f.store.need('flow', f.a).state, 'stopped');
  assert.match(f.store.need('flow', f.a).stopReason, /the source check was repeated 3 times for this flow and main is still not current/);
});

test('review: the structured capacity hold says which flows are stopped, parked beyond the limit or answered', async t => {
  const f = delivery(t, { maxFlows: 10, maxParkedFlows: 1 });
  for (const n of [1, 2, 3, 4, 5]) f.task(`task-${n}`);
  const [a, b, c, s] = [1, 2, 3, 4].map(n => f.admit(`task-${n}`));
  const item = await f.park(a); await f.park(b); f.at(c, 'build'); f.at(s, 'build'); f.ok(f.command('stop', { flowId: s, note: 'Fictional stop' }));
  f.limit({ 'policy.maxFlows': 3 });
  const facts = new Map(), reasons = admissionReasons(f.store, f.store.need('task', 'task-5'), { facts });
  assert.deepEqual(reasons, [`flow capacity exhausted; stopped flows still hold slots: ${s} (resume, abandon, or task.restart their tasks); parked flows beyond policy.maxParkedFlows (1) hold slots: ${b} (answer their questions)`]);
  assert.deepEqual(facts.get(reasons[0]), { code: 'capacity', pool: 'change', flowIds: [s], parkedFlowIds: [b], answeredFlowIds: [], maxParkedFlows: 1 });
  // An answered flow that is first in line for a slot that has just come free.
  f.limit({ 'policy.maxFlows': 2 });
  f.ok(f.answer(item, 'retry')); assert.ok(f.store.need('flow', a).slotWait); f.finish(c);
  const later = new Map(), after = admissionReasons(f.store, f.store.need('task', 'task-5'), { facts: later });
  assert.deepEqual(after, [`flow capacity exhausted; stopped flows still hold slots: ${s} (resume, abandon, or task.restart their tasks); answered flows take the next free slot first: ${a}`]);
  assert.deepEqual(later.get(after[0]), { code: 'capacity', pool: 'change', flowIds: [s], parkedFlowIds: [], answeredFlowIds: [a], maxParkedFlows: 1 });
});

test('dev.84 H10: a queued task names the answered flows ahead of it while a working flow holds the only slot', async t => {
  const f = delivery(t);
  for (const n of [1, 2, 3, 4, 5]) f.task(`task-${n}`);
  // Three flows park on questions (within the parked allowance), a fourth works in the only slot.
  const items = [];
  for (const n of [1, 2, 3]) { const id = f.admit(`task-${n}`); items.push([id, await f.park(id)]); }
  const busy = f.admit('task-4');
  // All three are answered while the slot is held: each waits for it, in the order answered.
  for (const [id, item] of items) { f.ok(f.answer(item, 'retry')); assert.ok(f.store.need('flow', id).slotWait, `${id} waits for the slot`); }
  assert.deepEqual(f.working(), [busy]);
  const ids = items.map(([id]) => id), facts = new Map(), reasons = admissionReasons(f.store, f.store.need('task', 'task-5'), { facts });
  assert.deepEqual(reasons, [`flow capacity exhausted; answered flows take the next free slot first: ${ids.join(', ')}`]);
  assert.deepEqual(facts.get(reasons[0]), { code: 'capacity', pool: 'change', flowIds: [], parkedFlowIds: [], answeredFlowIds: ids, maxParkedFlows: 3 });
  // A waiting flow whose own category is full is passed over for slots, so it is not named as ahead.
  f.limit({ 'policy.categoryLimits': { db: 1 } });
  f.store.put('flow', { ...f.store.need('flow', busy), taskSnapshot: { ...f.store.need('flow', busy).taskSnapshot, category: 'db' } });
  f.store.put('flow', { ...f.store.need('flow', ids[0]), taskSnapshot: { ...f.store.need('flow', ids[0]).taskSnapshot, category: 'db' } });
  assert.deepEqual(f.reasons('task-5'), [`flow capacity exhausted; answered flows take the next free slot first: ${ids.slice(1).join(', ')}`]);
});

// ======== Re-check fixes (docs/changes/dev83-admission.md, "Re-check fixes") ========

test('re-check: a bounded Git call stays in the attempt’s process group, so stopping the attempt leaves no git behind', async t => {
  const { spawn } = await import('node:child_process'), net = await import('node:net'), { readFileSync } = await import('node:fs');
  const { processTree } = await import('../starter/factory/adapters/workspace/index.mjs');
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.resume(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const directory = await mkdtemp(join(tmpdir(), 'dev83-group-')), repo = join(directory, 'repo'); await mkdir(repo);
  execFileSync('git', ['init', '-q', repo]);
  // The attempt's worker: it makes the bounded remote read (far from its timeout) against a remote that never answers.
  const script = join(directory, 'worker.mjs');
  await writeFile(script, `import { git } from ${JSON.stringify(new URL('../starter/factory/adapters/workspace/index.mjs', import.meta.url).href)};
git(${JSON.stringify(repo)}, ['ls-remote', 'http://127.0.0.1:${server.address().port}/fictional.git', 'refs/heads/main'], { timeoutMs: 600000 }).then(() => process.exit(0), () => process.exit(3));
`);
  // Started as the supervisor starts an attempt: the leader of its own process group.
  const worker = spawn(process.execPath, [script], { detached: true, stdio: 'ignore' });
  const stat = pid => { try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' '); return ['Z', 'X'].includes(fields[0]) ? null : { pgid: Number(fields[2]), startTime: fields[19], comm: text.slice(text.indexOf('(') + 1, text.lastIndexOf(')')) }; } catch { return null; } };
  let tree = [];
  // Whatever happens, this test's own processes are ended by their IDs, then its files removed.
  t.after(async () => { for (const member of tree) if (stat(member.pid)?.startTime === member.startTime) { try { process.kill(member.pid, 'SIGKILL'); } catch {} } for (const socket of sockets) socket.destroy(); server.close(); await rm(directory, { recursive: true, force: true }); });
  const wait = async (condition, ms) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 25)); return condition(); };
  assert.ok(await wait(() => sockets.size > 0, 20000), 'git connected to the remote');
  tree = processTree(worker.pid);
  const members = tree.map(member => ({ ...member, ...stat(member.pid) }));
  assert.ok(members.some(member => member.comm === 'git'), `git runs below the worker: ${members.map(member => member.comm).join(', ')}`);
  assert.deepEqual(members.filter(member => member.pgid !== worker.pid).map(member => member.comm), [], 'every process of the call is in the worker’s process group');
  // The supervisor stops the attempt: one signal to the group.
  process.kill(-worker.pid, 'SIGTERM');
  const alive = () => tree.filter(member => stat(member.pid)?.startTime === member.startTime);
  assert.ok(await wait(() => alive().length === 0, 10000), `still running: ${alive().map(member => `${member.pid} ${stat(member.pid)?.comm}`).join(', ')}`);
  assert.ok(await wait(() => sockets.size === 0, 5000), 'nothing holds the connection any more');
});

test('re-check: a target that becomes due later is read although nothing was written since the probe found nothing to do', async t => {
  const f = delivery(t, { mainProbeMs: 60000, autoQueue: false }, { workflows: { definitions: { change: { reference: 'change.standard' }, release: { reference: 'change.standard', target: 'release' } }, selection: { default: 'change' } } });
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  const head = repositoryIdentity(f.root).head;
  setTargetHealth(f.store, 'main', { status: 'green', head, checkedAt: iso() }); setTargetHealth(f.store, 'release', { status: 'green', head, checkedAt: iso() });
  f.task('task-1');
  const a = f.admit('task-1');
  // A merge question open on the second target only.
  f.at(a, 'decide', { state: 'waiting', target: 'release' });
  const reads = [], run = async (binary, args) => { reads.push(args[2]); return { code: 0, stdout: `${head}\t${args[2]}\n` }; }, start = Date.now();
  assert.deepEqual(await probeTargetHead(f.store, { run, nowMs: start }), { head, moved: false });
  assert.deepEqual(reads, ['refs/heads/release'], 'only the target with the question is read');
  // Meanwhile main is always due and has no reason: found once, then remembered. Nothing is written.
  const token = f.store.changeToken();
  for (const later of [60000, 120000, MERGE_QUESTION_PROBE_MS - 1]) assert.equal(await probeTargetHead(f.store, { run, nowMs: start + later }), null);
  assert.equal(f.store.changeToken(), token); assert.equal(reads.length, 1);
  // Five minutes on, with the database unchanged, the question's target is due again and is read.
  assert.deepEqual(await probeTargetHead(f.store, { run, nowMs: start + MERGE_QUESTION_PROBE_MS }), { head, moved: false });
  assert.deepEqual(reads, ['refs/heads/release', 'refs/heads/release']);
});

test('re-check: a replanned flow joins the line behind a flow that is already first for a free slot', async t => {
  const f = delivery(t);
  f.task('task-1'); f.task('task-2');
  const a = f.admit('task-1'), item = await f.park(a), b = f.admit('task-2');
  f.ok(f.answer(item, 'retry'));
  assert.ok(f.store.need('flow', a).slotWait, 'answered while the other flow holds the slot');
  // The other flow is abandoned: the slot is free and the answered flow is first in line. Before
  // the engine's next tick the abandoned flow is replanned.
  f.ok(f.command('flow.abandon', { flowId: b, note: 'Fictional abandon' }));
  f.ok(f.command('flow.replan', { flowId: b, note: 'Fictional revival' }));
  const revived = f.store.need('flow', b);
  assert.equal(revived.step, 'plan'); assert.equal(revived.state, 'waiting'); assert.equal(revived.slotWait.after, 'replan');
  assert.deepEqual(queueStatus(f.store).capacity.waiting.map(row => [row.flowId, row.position]), [[a, 1], [b, 2]]);
  assert.deepEqual(f.working(), []);
  // Whichever is stepped first, the slot goes to the flow that was waiting first.
  await f.engine.step(b); assert.ok(f.store.need('flow', b).slotWait);
  await f.engine.step(a); assert.equal(f.store.need('flow', a).slotWait, undefined);
  await f.engine.step(b); assert.ok(f.store.need('flow', b).slotWait, 'one slot');
  assert.deepEqual(f.working(), [a]);
  // The same for a stopped flow that is replanned while another waits: unlike a resume, it does
  // not keep the slot ahead of the flow already in line.
  const g = delivery(t, { maxFlows: 10 });
  g.task('task-1'); g.task('task-2');
  const [p, s] = [1, 2].map(n => g.admit(`task-${n}`));
  const question = await g.park(p); g.at(s, 'build');
  g.ok(g.command('stop', { flowId: s, note: 'Fictional stop' })); g.limit({ 'policy.maxFlows': 1 });
  g.ok(g.answer(question, 'retry')); assert.ok(g.store.need('flow', p).slotWait, 'the stopped flow holds the only slot');
  g.ok(g.command('flow.replan', { flowId: s, note: 'Fictional replan of the stopped flow' }));
  assert.equal(g.store.need('flow', s).slotWait.after, 'replan', 'behind the flow already waiting');
  assert.deepEqual(queueStatus(g.store).capacity.waiting.map(row => row.flowId), [p, s]);
  await g.engine.step(s); assert.ok(g.store.need('flow', s).slotWait);
  await g.engine.step(p); assert.equal(g.store.need('flow', p).slotWait, undefined);
  assert.deepEqual(g.working(), [p]);
  g.finish(p); await g.engine.step(s); assert.equal(g.store.need('flow', s).slotWait, undefined);
});
