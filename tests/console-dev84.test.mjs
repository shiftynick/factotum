// dev.84: console findings from the dev.83 real-browser pass. A flow's detail says where it stands in
// the flow slots (H3), a grouped Timeline marker closes like a popover (H5), browser Back from an
// attempt closes the flow window (H4), and every flow a hold names is a link (H7). Views render into
// the fake DOM from the data the project service returns; the slot derivation and the flow read run
// for real. Fictional fixtures throughout. See docs/changes/dev84-console.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installDom, byTag, byClass, descendants, click } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { requestProject } from '../starter/factory/console/client.mjs';
import * as capacity from '../starter/factory/operations/capacity.mjs';

installDom();
// Listeners the timeline module installs when it loads (outside click, change of address).
const listeners = { document: {}, window: {} };
globalThis.document.addEventListener = (name, handler) => { (listeners.document[name] ??= []).push(handler); };
globalThis.window.addEventListener = (name, handler) => { (listeners.window[name] ??= []).push(handler); };
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const admission = await import('../starter/factory/console/ui/admission.mjs');
const { queueView } = await import('../starter/factory/console/ui/queue.mjs');
const plan = await import('../starter/factory/console/ui/plan.mjs');

const text = node => node.textContent;
const NOW = Date.now(), ago = ms => new Date(NOW - ms).toISOString();
function project(snapshot = {}, settings = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [],
    ...snapshot, settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: { autoQueue: true }, ...settings } } };
}
function preload(p, kind, subject, data, query = {}) {
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, kind, subject, query)}`, { status: 'ready', data, fetchedAt: new Date().toISOString(), revision: p.snapshot.revision });
}
const route = (params = {}) => ({ projectId: 'fictional', tab: 'timeline', params });
const dd = (node, label) => { const terms = byTag(node, 'dt'), i = terms.findIndex(dt => text(dt) === label); return i < 0 ? null : byTag(node, 'dd')[i]; };

// ---- H3: the flow's own page says where it stands in the flow slots -------------------------------------
const WORKFLOW = { nodes: { decide: { kind: 'question' }, build: { kind: 'effect' }, done: { kind: 'end' } } };
const fakeStore = (flows, policy) => ({ meta: (key, fallback) => key === 'config' ? { policy } : fallback, live: () => flows, get: () => null });
const flow = (id, extra) => ({ id, kind: 'change', taskId: `task-${id}`, workflow: WORKFLOW, createdAt: ago(3600000), ...extra });

test('H3: one flow\'s slot state comes from the capacity derivation, for each case', () => {
  const flows = [
    flow('w', { state: 'running', step: 'build', attemptId: 'a1' }),
    flow('s', { state: 'stopped', step: 'build' }),
    flow('p1', { state: 'waiting', step: 'decide', parkedAt: ago(3000000) }),
    flow('p2', { state: 'waiting', step: 'decide', parkedAt: ago(2000000) }),
    flow('q', { state: 'waiting', step: 'build', slotWait: { since: ago(60000), step: 'build', after: 'answer' } }),
    flow('done', { state: 'completed', step: 'done' }),
  ];
  const store = fakeStore(flows, { maxFlows: 2, maxParkedFlows: 1 }), s = capacity.slots(store), of = id => capacity.flowSlot(s, flows.find(row => row.id === id));
  assert.deepEqual([of('w').state, of('w').holdsSlot], ['working', true]);
  assert.deepEqual([of('s').state, of('s').holdsSlot], ['stopped', true]);
  assert.deepEqual([of('p1').state, of('p1').holdsSlot], ['parked', false], 'the longest-parked flow uses the allowance');
  assert.deepEqual([of('p2').state, of('p2').holdsSlot], ['parked-holding', true], 'beyond policy.maxParkedFlows it keeps its slot');
  assert.deepEqual([of('q').state, of('q').holdsSlot, of('q').position, of('q').of], ['waiting', false, 1, 1]);
  assert.equal(of('q').reason, capacity.slotWaitView(s, flows.find(row => row.id === 'q')).reason, 'the same reason the Queue card shows');
  assert.equal(of('done'), null, 'a finished flow holds nothing');
  assert.equal(capacity.flowCapacity(store, { ...flows[0], kind: 'planning' }), null, 'a planning flow takes no change slot');
  // The parked count agrees with the Queue card's view of the same state.
  const view = capacity.capacityView(store);
  assert.deepEqual(view.parked.map(row => [row.flowId, row.holdsSlot]), [['p1', false], ['p2', true]]);
  // Waiting only on its category while its pool has a free slot.
  const categorised = [flow('c1', { state: 'running', step: 'build', taskSnapshot: { category: 'docs' } }), flow('c2', { state: 'waiting', step: 'build', slotWait: { since: ago(1000), step: 'build' }, taskSnapshot: { category: 'docs' } })];
  const surplus = fakeStore(categorised, { maxFlows: 3, categoryLimits: { docs: 1 } }), c = capacity.flowCapacity(surplus, categorised[1]);
  assert.deepEqual([c.state, c.holdsSlot, c.category, c.categoryInUse, c.categoryMax], ['category', false, 'docs', 1, 1]);
  assert.deepEqual(capacity.capacityView(surplus).categoryWaits.map(row => row.flowId), ['c2'], 'Queue lists the same category wait');
});

// Review fix: the free slot that an answered flow of another category has been granted is not free
// for the docs flow, so it waits for a slot, not only for its category, in Queue and in its detail alike.
test('H3: flow detail and Queue agree on a category-only wait when another answered flow reserves the free slot', () => {
  const flows = [
    flow('d1', { state: 'running', step: 'build', taskSnapshot: { category: 'docs' } }),
    flow('d2', { state: 'waiting', step: 'build', slotWait: { since: ago(2000), step: 'build', after: 'answer' }, taskSnapshot: { category: 'docs' } }),
    flow('o1', { state: 'waiting', step: 'build', slotWait: { since: ago(1000), step: 'build', after: 'answer' }, taskSnapshot: { category: 'other' } }),
  ];
  const store = fakeStore(flows, { maxFlows: 2, categoryLimits: { docs: 1 } }), view = capacity.capacityView(store), of = id => capacity.flowCapacity(store, flows.find(row => row.id === id));
  assert.deepEqual([view.pools.change.free, view.categoryWaits], [0, []], 'Queue: the free slot is reserved, and no category-only wait');
  assert.deepEqual([of('d2').state, of('d2').holdsSlot], ['waiting', false], 'its detail says it waits for a slot, as Queue does');
  assert.equal(of('o1').state, 'waiting', 'the flow the slot is reserved for is still waiting until the engine grants it');
  // With a slot to spare, both again say it waits only on its category.
  const spare = fakeStore(flows, { maxFlows: 3, categoryLimits: { docs: 1 } });
  assert.deepEqual(capacity.capacityView(spare).categoryWaits.map(row => row.flowId), ['d2']);
  assert.equal(capacity.flowCapacity(spare, flows[1]).state, 'category');
  // Every waiting flow: detail says "category" exactly when Queue lists it.
  for (const s of [store, spare]) { const listed = new Set(capacity.capacityView(s).categoryWaits.map(row => row.flowId)); for (const row of flows.filter(capacity.waitingForSlot)) assert.equal(capacity.flowCapacity(s, row).state === 'category', listed.has(row.id), row.id); }
});

test('H3: the project service\'s flow read carries the flow\'s slot state', async t => {
  const f = sandbox(t, { question: true }), socketPath = join(f.base, 'd84.sock');
  f.start();
  for (let i = 0; i < 400 && f.store.need('flow', 'flow-1').step !== 'decision'; i++) { await f.engine.step('flow-1'); await delay(25); }
  await f.engine.step('flow-1');
  const app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false }); t.after(() => app.close());
  const read = async () => (await requestProject(socketPath, { path: '/v1/flows/flow-1', timeoutMs: 30000 })).capacity;
  assert.equal(f.store.need('flow', 'flow-1').state, 'waiting');
  assert.deepEqual((({ state, holdsSlot, pool }) => ({ state, holdsSlot, pool }))(await read()), { state: 'parked', holdsSlot: false, pool: 'change' });
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), state: 'stopped' });
  assert.deepEqual((({ state, holdsSlot }) => ({ state, holdsSlot }))(await read()), { state: 'stopped', holdsSlot: true });
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), state: 'completed', finishedAt: new Date().toISOString() });
  assert.equal(await read(), null);
});

test('H3: the flow summary shows the slot state the project reports', () => {
  const cases = [
    [{ state: 'working', holdsSlot: true, pool: 'change', inUse: 1, max: 2 }, /Working holds a slot.*holds a change flow slot \(1 of 2 in use\)/],
    [{ state: 'parked', holdsSlot: false, pool: 'change', maxParkedFlows: 3 }, /Parked on an answer holds no slot.*within the parked limit \(3, policy\.maxParkedFlows\)/],
    [{ state: 'parked-holding', holdsSlot: true, pool: 'change', maxParkedFlows: 3, inUse: 1, max: 1 }, /Parked on an answer holds a slot.*beyond the parked limit \(3, policy\.maxParkedFlows\), so it keeps its change flow slot/],
    [{ state: 'waiting', holdsSlot: false, pool: 'change', position: 2, of: 3, reason: 'Waiting for a change flow slot (1 of 1 in use, policy.maxFlows): position 2 of 3. It continues by itself, ahead of queued tasks, when one of these finishes, parks on a question or is abandoned: flow-hold.' }, /Answered, waiting for a slot holds no slot.*position 2 of 3/],
    [{ state: 'category', holdsSlot: false, pool: 'change', category: 'docs', categoryInUse: 1, categoryMax: 1 }, /Answered, waiting on its category holds no slot.*category docs \(1 of 1 in use, policy\.categoryLimits\)/],
    [{ state: 'stopped', holdsSlot: true, pool: 'document', inUse: 2, max: 2 }, /Stopped holds a slot.*keeps its document flow slot \(2 of 2 in use\)/],
  ];
  const p = project({ revision: 3, flows: [{ id: 'flow-1', state: 'waiting', step: 'decide', taskSnapshot: { title: 'Fictional guide' } }, { id: 'flow-hold', state: 'running', step: 'build', taskSnapshot: { title: 'Fictional holder' } }] });
  for (const [slot, pattern] of cases) {
    state.reads.clear();
    preload(p, 'flows', 'flow-1', { flow: { id: 'flow-1', kind: 'change', state: 'waiting', step: 'decide', taskId: 'task-1', createdAt: ago(600000) }, attempts: [], inbox: [], events: [], waits: [], capacity: slot });
    const summary = byClass(timeline.flowDetail(p, 'flow-1', route({ flow: 'flow-1' })), 'card').find(node => /^Flow summary/.test(text(node)));
    const row = dd(summary, 'Flow slot');
    assert.ok(row, `the summary has a Flow slot row for ${slot.state}`);
    assert.match(text(row), pattern);
    assert.doesNotMatch(text(row), /Flow Flow/);
    if (slot.state === 'waiting') assert.ok(byTag(row, 'a').some(a => /flow=flow-hold/.test(a.getAttribute('href')) && /Fictional holder/.test(text(a))), 'the flow holding the slot is a link');
  }
  // A service before this change: the flow is looked up in the queue status's parked list, not recomputed.
  state.reads.clear();
  const older = project({ revision: 3, flows: p.snapshot.flows, queueStatus: { holds: [], capacity: { maxParkedFlows: 3, parked: [{ flowId: 'flow-1', pool: 'change', step: 'decide', since: ago(60000), holdsSlot: false }], waiting: [], categoryWaits: [] } } });
  preload(older, 'flows', 'flow-1', { flow: { id: 'flow-1', kind: 'change', state: 'waiting', step: 'decide', taskId: 'task-1', createdAt: ago(600000) }, attempts: [], inbox: [], events: [], waits: [] });
  assert.match(text(dd(timeline.flowDetail(older, 'flow-1', route({ flow: 'flow-1' })), 'Flow slot')), /Parked on an answer holds no slot/);
  assert.equal(timeline.flowSlotNode(null), undefined, 'nothing known: no row');
});

// ---- H5: a grouped marker's list closes with Escape, an outside click and navigation --------------------
const group = () => {
  const node = timeline.markerGroup([{ text: 'Merged #12 · 10:00', href: '#/p/fictional/timeline?flow=flow-a' }, { text: 'Merged #13 · 10:01', href: '#/p/fictional/timeline?flow=flow-b' }], { cls: 'tl-ev-cluster', pct: 50 });
  const open = () => { node.open = true; for (const handler of node.handlers.toggle ?? []) handler({ currentTarget: node }); };
  return { node, open, summary: byTag(node, 'summary')[0] };
};
const key = (node, name) => { const calls = []; for (const handler of node.handlers.keydown ?? []) handler({ key: name, currentTarget: node, target: node, preventDefault: () => calls.push('preventDefault'), stopPropagation: () => calls.push('stopPropagation') }); return calls; };

test('H5: Escape closes an open marker group and returns focus to its summary, without closing the window it is in', () => {
  const { node, open, summary } = group();
  open(); globalThis.document.activeElement = byTag(node, 'a')[1];
  const calls = key(node, 'Escape');
  assert.equal(node.open, false, 'Escape closes the list');
  assert.equal(globalThis.document.activeElement, summary, 'focus returns to the summary');
  assert.deepEqual(calls.sort(), ['preventDefault', 'stopPropagation'], 'a detail modal around it stays open');
  // Escape on a closed group, or another key, is left to the page.
  assert.deepEqual(key(node, 'Escape'), []);
  open(); assert.deepEqual(key(node, 'Enter'), []); assert.equal(node.open, true);
  assert.ok(summary.dataset.focusKey, 'its summary keeps focus across a refresh');
});

test('H5: a click outside closes an open group, a click inside does not, and a change of address closes it', () => {
  assert.equal(listeners.document.click?.length, 1, 'one outside-click listener'); assert.equal(listeners.window.hashchange?.length, 1, 'one navigation listener');
  const [outside] = listeners.document.click, [navigated] = listeners.window.hashchange;
  const a = group(), b = group();
  a.open(); outside({ target: byTag(a.node, 'a')[0] });
  assert.equal(a.node.open, true, 'a click on its own list keeps it open');
  outside({ target: globalThis.document.createElement('main') });
  assert.equal(a.node.open, false, 'a click elsewhere closes it');
  a.open(); b.open();
  assert.equal(a.node.open, false, 'opening another group closes the first');
  navigated();
  assert.equal(b.node.open, false, 'navigation closes every open group');
});

// ---- H4: browser Back from an attempt closes the flow window ----------------------------------------------
test('H4: choosing an attempt replaces the address, so browser Back closes the flow window from any attempt', async t => {
  const saved = { location: globalThis.location, history: globalThis.history, HashChangeEvent: globalThis.HashChangeEvent };
  t.after(() => { for (const [name, value] of Object.entries(saved)) if (value === undefined) delete globalThis[name]; else globalThis[name] = value; });
  const replaced = [], hashes = [];
  globalThis.location = { get hash() { return hashes.at(-1) ?? '#/p/fictional/timeline?flow=flow-1'; }, set hash(value) { hashes.push(value); } };
  globalThis.history = { replaceState: (_state, _title, target) => replaced.push(target) };
  globalThis.HashChangeEvent = class { constructor(type) { this.type = type; } };
  const p = project({ revision: 4, flows: [{ id: 'flow-1', state: 'running', step: 'build' }] });
  state.reads.clear();
  preload(p, 'flows', 'flow-1', { flow: { id: 'flow-1', kind: 'change', state: 'running', step: 'build', taskId: 'task-1', createdAt: ago(600000) }, waits: [], inbox: [], events: [],
    attempts: [{ id: 'att-1', step: 'build', status: 'settled', createdAt: ago(500000), dispatchedAt: ago(490000), settledAt: ago(400000), receipt: { startedAt: ago(490000), endedAt: ago(400000), exitCode: 0 } }] });
  const bar = descendants(timeline.flowDetail(p, 'flow-1', route({ flow: 'flow-1' }))).find(node => node.tag === 'button' && /^bar:att-1:/.test(node.dataset.focusKey ?? ''));
  assert.ok(bar, 'the attempt bar is a button');
  await click(bar);
  assert.equal(hashes.length, 0, 'no history entry is added');
  assert.equal(replaced.length, 1); assert.match(replaced[0], /flow=flow-1&attempt=att-1/);
});

// ---- H7: every flow a hold names is a link ---------------------------------------------------------------
const HOLDER = 'f0000000-0000-4000-8000-00000000000a';
const CAPACITY = `flow capacity exhausted; parked flows beyond policy.maxParkedFlows (3) hold slots: ${HOLDER} (answer their questions)`;
const linksTo = (node, id) => byTag(node, 'a').filter(a => a.getAttribute('href')?.includes(`flow=${id}`));

test('H7: a hold given as text links every flow ID the project reported, by title', () => {
  const p = project({ flows: [{ id: HOLDER, state: 'waiting', step: 'decide', parked: true, taskSnapshot: { title: 'Fictional notes' } }] });
  const parts = [admission.holdNode(p, { text: `category capacity exhausted: docs; parked flows beyond policy.maxParkedFlows (3) hold places: ${HOLDER} (answer their questions)` })].flat();
  const links = parts.filter(part => typeof part !== 'string');
  assert.equal(links.length, 1); assert.match(text(links[0]), /Fictional notes/); assert.match(links[0].getAttribute('href'), new RegExp(`flow=${HOLDER}`));
  assert.ok(!parts.filter(part => typeof part === 'string').join('').includes(HOLDER), 'the bare ID is not left in the text');
  // Only whole IDs are linked.
  assert.deepEqual(admission.withFlowLinks(p, `${HOLDER}x and x${HOLDER}`), [`${HOLDER}x and x${HOLDER}`]);
});

test('H7: Queue names the flow holding the slot as a link in the observation, the advisory holds, the dispatch result and the Start reasons', () => {
  const task = { id: 'task-q', title: 'Fictional queued work', revision: 'r1', approvedRevision: 'r1', status: 'approved', admissionReasons: [CAPACITY],
    admissionHolds: [{ text: CAPACITY, code: 'capacity', pool: 'change', flowIds: [], parkedFlowIds: [HOLDER], answeredFlowIds: [], maxParkedFlows: 3 }] };
  const flows = [{ id: HOLDER, state: 'waiting', step: 'decide', parked: true, taskSnapshot: { title: 'Fictional notes' } }];
  const queue = [{ id: 'task-q', status: 'queued', order: 1, eligibility: { ready: false, reasons: [CAPACITY, `paths overlap: ${HOLDER}`], lastObservedAt: ago(60000), transitions: 1 } }];
  const p = project({ flows, tasks: [task], queue, queueRevision: 'q1', queueComplete: true,
    queueStatus: { autoQueue: false, holds: [], capacity: null, lastDispatch: { createdAt: ago(60000), status: 'finished', outcome: 'no-eligible-task', heldReasons: [`task-q: ${CAPACITY}`] } } }, { policy: { autoQueue: false } });
  state.reads.clear();
  const view = queueView(p, { params: { task: 'task-q' } });
  const held = descendants(view).find(node => node.tag === 'details' && /^Admission held/.test(text(node)));
  assert.ok(held, 'the queue entry has its observation');
  assert.equal(linksTo(held, HOLDER).length, 2, 'the matched capacity hold and the older recorded reason both link the flow');
  assert.ok(!text(held).includes(HOLDER), `no bare flow ID: ${text(held)}`);
  const dispatch = descendants(view).find(node => node.tag === 'p' && /^Last dispatch/.test(text(node)));
  assert.equal(linksTo(dispatch, HOLDER).length, 1, 'the last dispatch names it as a link');
  // Not yet observed: the advisory holds.
  const unobserved = queueView(project({ flows, tasks: [task], queue: [{ ...queue[0], eligibility: undefined }], queueRevision: 'q1', queueComplete: true }), { params: { task: 'task-q' } });
  const advisory = descendants(unobserved).find(node => node.tag === 'p' && /^Current advisory holds/.test(text(node)));
  assert.equal(linksTo(advisory, HOLDER).length, 1);
  // The reasons Start now is disabled.
  const reasons = plan.startHints(p.snapshot, task, p), hold = reasons.find(row => Array.isArray(row));
  assert.ok(hold, 'the hold is page content, not a string');
  assert.ok(hold.some(part => typeof part === 'object' && part.getAttribute?.('href')?.includes(`flow=${HOLDER}`)));
});
