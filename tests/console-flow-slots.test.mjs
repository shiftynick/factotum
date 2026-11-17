// The console Queue tab shows who holds the flow slots: parked flows and answered flows waiting
// for a slot are labelled apart from running ones (dev.83, docs/changes/dev83-admission.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, withText } from './fake-dom.mjs';

const restore = installDom();
test.after(restore);
const { slotsCard, queueView } = await import('../starter/factory/console/ui/queue.mjs');

const capacity = {
  maxParkedFlows: 3, parkedCount: 2, waitingCount: 1,
  categories: { feature: { max: 1, inUse: 1, working: 1, stopped: 0, parked: 1, parkedHoldingSlot: 0, waitingForSlot: 0, free: 0 } },
  pools: { change: { max: 1, inUse: 1, working: 1, stopped: 0, parked: 2, parkedHoldingSlot: 0, waitingForSlot: 1, free: 0 }, document: { max: 2, inUse: 0, working: 0, stopped: 0, parked: 0, parkedHoldingSlot: 0, waitingForSlot: 0, free: 2 } },
  parked: [{ flowId: 'flow-a', taskId: 'task-a', title: null, pool: 'change', step: 'decide', since: new Date(Date.now() - 600000).toISOString(), holdsSlot: false }, { flowId: 'flow-b', taskId: 'task-b', title: null, pool: 'change', step: 'plan-question', since: null, holdsSlot: true }],
  categoryWaits: [{ flowId: 'flow-c', category: 'feature', inUse: 1, max: 1, heldBy: [{ flowId: 'flow-d', state: 'stopped' }], text: 'Flow flow-c was answered and waits for a place in category feature (1 of 1 in use, policy.categoryLimits), held by flow-d (stopped). A change flow slot is free meanwhile; queued tasks of other categories can take it.' }],
  waiting: [{ flowId: 'flow-c', taskId: 'task-c', pool: 'change', step: 'build', since: new Date().toISOString(), after: 'answer', position: 1, of: 1, reason: 'Waiting for a change flow slot (1 of 1 in use, policy.maxFlows): position 1 of 1. It continues by itself, ahead of queued tasks, when one of these finishes, parks on a question or is abandoned: flow-d.' }],
};
const project = (queueStatus = { autoQueue: true, holds: [], capacity, lastDispatch: null }) => ({ projectId: 'p1', name: 'Fictional', status: 'available', snapshot: {
  settings: { mode: 'delivery' }, queueStatus, queue: [], tasks: [], queueTasks: [],
  flows: [{ id: 'flow-a', state: 'waiting', parked: true, taskSnapshot: { title: 'Fictional guide' } }, { id: 'flow-b', state: 'waiting', parked: true, taskSnapshot: { title: 'Fictional plan' } }, { id: 'flow-c', state: 'waiting', parked: false, slotWait: { after: 'answer' }, taskSnapshot: { title: 'Fictional build' } }],
} });

test('the Queue tab lists slots in use, parked flows and answered flows waiting for a slot', () => {
  const card = slotsCard(project()), text = card.textContent;
  assert.match(text, /Flow slots/);
  assert.match(text, /Change flows1 of 1 in use · 0 free for queued tasks/);
  // Every configured pool is listed, an idle one too (dev.85 I1; it was hidden before).
  assert.match(text, /Document flows0 of 2 in use · 2 free for queued tasks/, 'an idle pool is listed');
  assert.match(text, /Category feature1 of 1 in use · 1 parked without a place · 0 free for queued tasks/);
  assert.match(text, /Parked on an answer2 \(1 of 3 allowed without a slot\)/);
  assert.match(text, /Answered, waiting for a slot1/);
  // The flows it names are links, by title (dev.84 H7), and "Flow <id>" is not shown as "Flow Flow · …".
  assert.match(text, /A slot is free while an answered flow waits for its category\. Flow · Fictional build #flow-c was answered and waits for a place in category feature .* held by Flow #flow-d \(stopped\)/);
  assert.doesNotMatch(text, /Flow Flow/);
  // Each parked flow is named and labelled; one beyond the limit says it holds a slot.
  const rows = byTag(card, 'li').map(row => row.textContent);
  assert.equal(rows.length, 4);
  rows.shift();
  assert.match(rows[0], /^Fictional guide .*Parked · at decide since .* · no slot held$/);
  assert.match(rows[1], /^Fictional plan .*Parked .*Holds a slot · at plan-question · beyond the parked limit, so it keeps its slot until answered$/);
  assert.match(rows[2], /^Fictional build .*Position 1 of 1Waiting for a change flow slot \(1 of 1 in use, policy\.maxFlows\): position 1 of 1\./);
  assert.ok(withText(card, 'a', 'Fictional guide').length, 'each links to its flow');
});

test('the card is part of the Queue view, and absent when the service reports no capacity', () => {
  assert.match(queueView(project(), { params: {} }).textContent, /Flow slots/);
  assert.equal(slotsCard(project({ autoQueue: true, holds: [], lastDispatch: null })), null, 'an older service');
  assert.doesNotMatch(queueView(project({ autoQueue: true, holds: [], lastDispatch: null }), { params: {} }).textContent, /Flow slots/);
});

// Admission readiness (main's structured holds): the capacity hold names stopped, parked and
// answered flows separately, each with a link.
test('a capacity hold names stopped flows, flows parked beyond the limit and answered flows separately', async () => {
  const { holdNode } = await import('../starter/factory/console/ui/admission.mjs');
  const text = hold => { const node = holdNode(project(), hold); return (Array.isArray(node) ? node : [node]).map(part => typeof part === 'string' ? part : part.textContent).join(''); };
  assert.equal(text({ code: 'capacity', pool: 'change', flowIds: ['flow-a'], parkedFlowIds: [], answeredFlowIds: [], maxParkedFlows: 3 }), 'Flow capacity is used up; stopped flows still hold slots: Flow · Fictional guide #flow-a (resume, abandon, or start their tasks again).');
  assert.equal(text({ code: 'capacity', pool: 'change', flowIds: [], parkedFlowIds: ['flow-b'], answeredFlowIds: ['flow-c'], maxParkedFlows: 1 }), 'Flow capacity is used up; flows waiting on an answer beyond the parked limit (1) hold slots: Flow · Fictional plan #flow-b (answer their questions); answered flows take the next free slot first: Flow · Fictional build #flow-c.');
  assert.equal(text({ code: 'capacity', pool: 'document', flowIds: [], parkedFlowIds: [], answeredFlowIds: ['flow-c'], maxParkedFlows: 3 }), 'Document flow capacity is used up; answered flows take the next free slot first: Flow · Fictional build #flow-c.');
  // A hold from a service before dev.83 (stopped flows only) reads as it did.
  assert.equal(text({ code: 'capacity', flowIds: ['flow-a'] }), 'Flow capacity is used up; stopped flows still hold slots: Flow · Fictional guide #flow-a (resume, abandon, or start their tasks again).');
});
