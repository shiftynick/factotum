// dev.93: the dev.92 readiness re-test findings Q1–Q5 (docs/changes/dev93-q-items.md).
//   Q1: the flow page reads a flow's citations from what status --flow returns, through the console.
//   Q2: a hold on one queued task is described as that task's, not the queue's.
//   Q3: Overview counts the queued tasks held on their own, linked to Queue.
//   Q4: long ids in banners wrap; axis labels never print over each other at phone width.
//   Q5: Health says what the upkeep share counts and where it stands against its 10% ceiling.
// Fictional fixtures only: no provider CLI, forge or model is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installDom, byTag, byClass } from './fake-dom.mjs';
import { upkeepProject } from './upkeep-fixtures.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { proposalDigest } from '../starter/factory/operations/upkeep-context.mjs';
import { raiseCandidatesInTransaction } from '../starter/factory/operations/upkeep-candidates.mjs';
import { addToUpkeepDayInTransaction, addToUpkeepWindowInTransaction, upkeepDayId } from '../starter/factory/operations/upkeep-records.mjs';
import { invocationShareStanding } from '../starter/factory/operations/upkeep-ceilings.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { startConsole, registerProject } from '../starter/factory/console/console.mjs';

const realFetch = globalThis.fetch;
installDom();
globalThis.innerWidth = 320;
globalThis.document.addEventListener ??= () => {}; globalThis.window.addEventListener ??= () => {};
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const plan = await import('../starter/factory/console/ui/plan.mjs');
const overview = await import('../starter/factory/console/ui/overview.mjs');
const { queueView } = await import('../starter/factory/console/ui/queue.mjs');

const DAY = 86400000, iso = ms => new Date(ms).toISOString();
const send = (f, operation, payload) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'operator', operation, payload });
const PROPOSE = Object.freeze({ mode: 'propose', docs: { include: ['README.md', 'docs/**/*.md'], exclude: ['docs/changes/**'] } });

// ======================================================================================
// Q1: the flow page and status --flow read the same citations.
// ======================================================================================
const BLOB = 'a'.repeat(40), COMMIT = 'c'.repeat(40), ID = 'learning-a1b2c3d4e5f6';
const PIN = { cycle: 1, step: 'plan', commit: COMMIT, dir: 'docs/learnings', at: '2026-11-17T00:10:00.000Z', entries: [{ id: ID, path: `docs/learnings/${ID}.md`, blob: BLOB, chars: 300 }], skipped: [], refused: [] };
const RECORDED = [
  { cycle: 1, step: 'plan', role: 'planner', attemptId: 'attempt-1', at: '2026-11-17T00:11:00.000Z', cited: [{ id: ID, use: 'applied' }] },
  { cycle: 1, step: 'build', role: 'builder', attemptId: 'attempt-2', at: '2026-11-17T00:12:00.000Z', cited: [{ id: ID, use: 'applied' }] },
  { cycle: 1, step: 'review', role: 'reviewer', attemptId: 'attempt-3', at: '2026-11-17T00:13:00.000Z', cited: [{ id: ID, use: 'followed' }] },
];
// A flow planned before its citations were recorded per attempt (it was upgraded mid-flow): its
// results carry them, and status --flow reads them from there.
const RESULTS = { plan: { route: 'ready', result: { learningsApplied: [{ id: ID, use: 'applied' }] } }, build: { route: 'pass', result: { learningsApplied: [{ id: ID, use: 'applied' }] } }, review: { route: 'pass', result: { learningsChecked: [{ id: ID, outcome: 'followed' }] } } };

function renderFlow(data) {
  const p = { projectId: data.projectId, bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: { revision: 1, flows: [{ id: data.flow.id, state: 'running', step: 'build', taskSnapshot: { title: 'Fictional change' } }], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: {} } } };
  state.reads.clear();
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'flows', data.flow.id, {})}`, { status: 'ready', data, fetchedAt: new Date().toISOString(), revision: 1 });
  return byClass(timeline.flowDetail(p, data.flow.id, { projectId: p.projectId, tab: 'timeline', params: { flow: data.flow.id } }), 'card').find(node => /^Learnings shown to agents/.test(node.textContent));
}

test('Q1: the flow page shows the citations status --flow returns, read through the project service and the console, for recorded citations and for a flow planned before they were recorded', async t => {
  const f = upkeepProject(t, { upkeep: null }); f.green();
  const task = f.command('task.put', { task: { id: 'fictional-task', title: 'Fictional change', acceptance: ['It changes'] } }).result;
  assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed');
  const started = f.command('flow.start', { taskId: task.id, revision: task.revision, flowId: 'flow-1' }); assert.equal(started.status, 'completed', started.error);
  const flow = f.store.need('flow', 'flow-1'), use = { selected: [ID], cited: [ID], windows: { [ID]: 1 } };
  const socketPath = join(f.base, 'q1.sock'), app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false }); t.after(() => app.close());
  const consoleState = join(f.base, 'console'), binding = await registerProject(consoleState, { socketPath }, { timeoutMs: 30000 });
  const web = await startConsole({ stateDir: consoleState, timeoutMs: 30000 }); t.after(() => web.close());
  const page = await realFetch(web.url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const throughConsole = async () => { const response = await realFetch(`${web.url}/api/project/${binding.projectId}/flows/flow-1?bindingId=${binding.bindingId}`, { headers: { cookie } }); assert.equal(response.status, 200); return response.json(); };
  for (const [label, record] of [['recorded per attempt', { learningCitations: RECORDED }], ['planned before the upgrade', { results: { ...(flow.results ?? {}), ...RESULTS } }]]) {
    f.store.put('flow', { ...flow, learningSelection: PIN, learningUse: use, ...record });
    const cli = stateView(f.store, { flow: 'flow-1' }).flow;
    assert.deepEqual(cli.learningUse, { selected: [ID], cited: [ID] }, label);
    assert.deepEqual(cli.learningCitations.map(row => [row.role, row.step, row.cited]), [['planner', 'plan', [{ id: ID, use: 'applied' }]], ['builder', 'build', [{ id: ID, use: 'applied' }]], ['reviewer', 'review', [{ id: ID, use: 'followed' }]]], label);
    // The console passes the service's list on: the page reads what status --flow reads.
    const data = await throughConsole();
    assert.deepEqual(data.learningCitations, cli.learningCitations, `${label}: the console's flow read carries learningCitations`);
    const card = renderFlow(data);
    assert.ok(card, label);
    assert.match(card.textContent, new RegExp(`Planner \\(plan\\): ${ID} applied`), label);
    assert.match(card.textContent, new RegExp(`Builder \\(build\\): ${ID} applied`), label);
    assert.match(card.textContent, new RegExp(`Reviewer \\(review\\): ${ID} followed`), label);
    assert.doesNotMatch(card.textContent, /No role has cited a learning of this cycle yet/, label);
  }
  // Before the fix the console dropped the list: the page fell back to the flow record, which a flow
  // planned before the upgrade does not carry, and said nobody had cited anything.
  f.store.put('flow', { ...flow, learningSelection: PIN, learningUse: use, results: RESULTS });
  const { learningCitations, ...withoutList } = await throughConsole();
  assert.equal(learningCitations.length, 3);
  assert.match(renderFlow(withoutList).textContent, /No role has cited a learning of this cycle yet/, 'the old read, reproduced');
});

// ======================================================================================
// Q2 and Q3: a hold on one queued task.
// ======================================================================================
const QUOTE = 'Never import src/legacy.js from new code.';
const gitBlob = (root, path) => execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: root, encoding: 'utf8' }).trim();
// A delivery project with automatic admission and one accepted (approved and queued) context task
// whose provider is not listed in upkeep.context.qualifiedProviders, as in tests/dev91-o-items.test.mjs.
function heldContextTask(t) {
  const f = upkeepProject(t, { upkeep: structuredClone(PROPOSE), policy: { autoQueue: true, queueOnApproval: true } });
  const workflow = { version: 1, start: 'build', nodes: { build: { kind: 'effect', action: { operation: 'provider.build' }, timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.green();
  const [raised] = f.store.tx(() => raiseCandidatesInTransaction(f.store, { flowId: 'flow-source', nowMs: Date.now(), candidates: [{ kind: 'context', file: 'AGENTS.md', quote: QUOTE, replacement: 'Never import src/legacy.js; use src/api/users.js instead.', reason: 'The merge replaced the legacy module.', signals: [], flags: [], blob: gitBlob(f.root, 'AGENTS.md'), entries: ['rules'] }] }));
  const row = f.store.need('finding', raised.id);
  const accepted = send(f, 'finding.accept', { proposals: [{ findingId: row.id, expectedVersion: row.version, digest: proposalDigest(row) }] });
  assert.equal(accepted.status, 'completed', accepted.error);
  const project = () => ({ projectId: f.project.projectId, bindingId: 'binding-1', name: 'Fictional', status: 'available', observedAt: new Date().toISOString(), snapshot: dashboardSnapshot(f.store) });
  return { ...f, task: accepted.result.task, project };
}

test('Q2: a held context task\'s page says the hold is on that task, with its remedy, not that the queue is held', t => {
  const f = heldContextTask(t), p = f.project(), task = p.snapshot.tasks.find(row => row.id === f.task.id) ?? f.store.need('task', f.task.id);
  const hold = p.snapshot.queueStatus.holds.find(row => row.kind === 'context-provider');
  assert.equal(hold.scope, 'task'); assert.equal(hold.taskId, task.id);
  const { title, detail } = plan.approvalState(p.snapshot, task);
  assert.equal(title, 'Approved — queued, not started');
  assert.doesNotMatch(detail, /Nothing is admitted while the queue is held/);
  assert.match(detail, /^This task is held on its own, not the queue: tasks queued behind it still start\. /);
  assert.ok(detail.includes(hold.text), 'the hold itself, named');
  assert.match(detail, /add it to upkeep\.context\.qualifiedProviders \(config update, operator only\)/, 'the remedy');
  assert.match(detail, /task\.models/);
  assert.match(detail, /Automatic admission starts it once this hold is lifted\.$/);
  // The task page as rendered.
  const pageText = plan.taskDetail(p, task).textContent;
  assert.match(pageText, /This task is held on its own, not the queue/); assert.doesNotMatch(pageText, /Nothing is admitted while the queue is held/);
  // Another queued task is not held by it, and says so.
  const other = { id: 'fictional-other', revision: 'r1', approvedRevision: 'r1' };
  assert.match(plan.approvalState({ ...p.snapshot, queue: [...p.snapshot.queue, { id: other.id, status: 'queued' }] }, other).detail, /Automatic admission will start queued work/);
  // With the queue held as well, both are named, each for what it holds.
  const paused = { ...p.snapshot, queueStatus: { ...p.snapshot.queueStatus, holds: [{ kind: 'paused', text: 'Admission is paused. Resume it from Overview.' }, ...p.snapshot.queueStatus.holds] } };
  const both = plan.approvalState(paused, task).detail;
  assert.match(both, /^Nothing is admitted while the queue is held: Admission is paused\. Resume it from Overview\. This task is also held on its own: Context task /);
  assert.match(both, /Automatic admission resumes once the hold clears, and starts this task once its own hold is lifted too\.$/);
});

test('Q3: Overview counts the queued tasks held on their own and links to Queue; with none it says nothing more', t => {
  const f = heldContextTask(t), p = f.project();
  assert.deepEqual(overview.heldTaskIds(p.snapshot), [f.task.id]);
  const page = overview.projectOverview(p), text = page.textContent;
  assert.match(text, /Project admission is open/);
  assert.match(text, /1 queued task is held on its own: each hold is on that task only\. The rest of the queue still starts\./);
  assert.match(text, /queued tasks · 1 held on its own/);
  const items = overview.attention(p), item = items.find(row => /held on its own/.test(row.title));
  assert.equal(item.title, '1 queued task is held on its own'); assert.equal(item.action.label, 'Open Queue');
  assert.match(item.action.href, /\/queue\?task=/); assert.ok(item.action.href.includes(encodeURIComponent(f.task.id)));
  const links = byTag(page, 'a').filter(a => a.textContent === 'Open Queue');
  assert.ok(links.length >= 2 && links.every(a => a.getAttribute('href').includes('/queue?task=')), 'the attention item and the admission controls link to Queue');
  // Two held tasks: counted, linked to the queue itself.
  const two = { ...p.snapshot, queueStatus: { ...p.snapshot.queueStatus, holds: [...p.snapshot.queueStatus.holds, { kind: 'claim', scope: 'task', taskId: 'fictional-claimed', text: 'Automatic admission could not start task fictional-claimed.' }] } };
  assert.equal(overview.attention({ ...p, snapshot: two }).find(row => /held on their own/.test(row.title)).title, '2 queued tasks are held on their own');
  assert.match(overview.projectOverview({ ...p, snapshot: two }).textContent, /2 queued tasks are held on their own/);
  // Nothing held: no count, no item.
  const none = { ...p.snapshot, queueStatus: { ...p.snapshot.queueStatus, holds: [] } };
  assert.doesNotMatch(overview.projectOverview({ ...p, snapshot: none }).textContent, /held on (its|their) own/);
  assert.equal(overview.attention({ ...p, snapshot: none }).filter(row => /held on/.test(row.title)).length, 0);
});

test('Q3 review: with any other hold that stops admission, Overview never says the rest of the queue still starts', t => {
  const f = heldContextTask(t), p = f.project(), own = p.snapshot.queueStatus.holds.filter(row => row.scope === 'task');
  const at = (snapshot) => { const q = { ...p, snapshot }; return { item: overview.attention(q).find(row => /held on (its|their) own/.test(row.title)).detail, line: overview.projectOverview(q).textContent }; };
  const withHolds = (holds, extra = {}) => ({ ...p.snapshot, ...extra, queueStatus: { ...p.snapshot.queueStatus, ...(extra.queueStatus ?? {}), holds: [...holds, ...own] } });
  // Nothing else holds the queue: it still starts.
  for (const text of Object.values(at(p.snapshot))) assert.match(text, /each hold is on that task only\.? The rest of the queue still starts\./i);
  const WHOLE = { paused: 'admission is paused', recovery: 'a recovery hold is in place', retention: 'a retention hold is in place', money: 'a spending hold is in place', doctor: 'doctor has not passed for the current configuration', 'launch-stalled': 'a flow launch has stalled', claim: 'automatic admission failed' };
  for (const [kind, words] of Object.entries(WHOLE)) {
    const shown = at(withHolds([{ kind, text: `Fictional ${kind} hold.` }], kind === 'paused' ? { paused: true } : {}));
    for (const [where, text] of Object.entries(shown)) { assert.doesNotMatch(text, /still starts/, `${kind}, ${where}`); assert.match(text, new RegExp(`The rest of the queue is held too: ${words}\\.`), `${kind}, ${where}`); }
  }
  // Holds on change work: the change and document tasks behind it wait too; a task workflow is not held.
  const CHANGE = { main: 'main is not verified green', merge: 'a merge is in flight', 'target-sync': 'a target sync is waiting' };
  for (const [kind, words] of Object.entries(CHANGE)) {
    const shown = at(withHolds([{ kind, scope: 'change', target: 'main', text: `Fictional ${kind} hold.` }]));
    for (const [where, text] of Object.entries(shown)) { assert.doesNotMatch(text, /still starts/, `${kind}, ${where}`); assert.match(text, new RegExp(`Change and document tasks in the rest of the queue wait too, because ${words}\\.`), `${kind}, ${where}`); }
  }
  // Several at once are all named; a whole-queue hold says the whole queue.
  assert.match(at(withHolds([{ kind: 'paused', text: 'x' }, { kind: 'money', text: 'x' }, { kind: 'main', scope: 'change', text: 'x' }], { paused: true })).line, /The rest of the queue is held too: admission is paused and a spending hold is in place\./);
  assert.match(overview.restOfQueue(withHolds([{ kind: 'main', scope: 'change', text: 'x' }, { kind: 'merge', scope: 'change', text: 'x' }])), /because main is not verified green and a merge is in flight\./);
  // Automatic admission off: queued tasks start only when dispatched.
  for (const [where, text] of Object.entries(at(withHolds([], { queueStatus: { autoQueue: false } })))) { assert.doesNotMatch(text, /still starts/, where); assert.match(text, /Automatic admission is off, so the rest of the queue starts only when dispatched\./, where); }
  assert.match(overview.restOfQueue(withHolds([{ kind: 'main', scope: 'change', text: 'x' }], { queueStatus: { autoQueue: false } })), /^Change and document tasks .*; automatic admission is off/);
  // An older project service without queue status: the snapshot's own pause.
  assert.equal(overview.restOfQueue({ paused: true }), 'The rest of the queue is held too: admission is paused (resume it from Overview).');
  assert.equal(overview.restOfQueue({ recoveryHold: true }), 'The rest of the queue is held too: a recovery hold needs reconciliation.');
});

// ======================================================================================
// Q4: long ids wrap, axis labels do not overlap.
// ======================================================================================
const CSS = readFileSync(new URL('../starter/factory/console/style.css', import.meta.url), 'utf8');
const rule = selector => { const at = CSS.indexOf(`\n${selector} {`); assert.ok(at >= 0, `a rule for ${selector}`); return CSS.slice(at, CSS.indexOf('}', at)); };

test('Q4: a banner, an attention item and a KPI break a long id inside themselves instead of widening the page', t => {
  for (const selector of ['.notice', '.attention li > div', '.kpi']) { const body = rule(selector); assert.match(body, /min-width: 0/, selector); assert.match(body, /overflow-wrap: anywhere/, selector); }
  // The queue's hold banner holds the task id as text inside a .notice (fake DOM: no layout; the
  // widths were measured in headless Chromium, docs/changes/dev93-q-items.md).
  const f = heldContextTask(t), p = f.project();
  const banner = byClass(queueView(p, { params: {} }), 'notice').find(node => /A queued task is held\./.test(node.textContent));
  assert.ok(banner && banner.textContent.includes(f.task.id));
  assert.match(f.task.id, /^upkeep:context:/);
});

test('Q4: the flow axis shows only as many time labels as fit side by side at the track width', () => {
  // The trial's flow: about two minutes, 20:03:00 to 20:05:00, with labels to the second.
  const start = Date.parse('2026-11-16T20:02:50.000Z'), end = Date.parse('2026-11-16T20:05:10.000Z');
  const fit = trackPx => { const { step, ticks } = timeline.axisTicks(start, end, { trackPx }); const widest = Math.max(...ticks.map(tick => tick.label.length)) * timeline.TICK_CHAR_PX + timeline.TICK_GAP_PX;
    for (let i = 1; i < ticks.length; i++) assert.ok((ticks[i].left - ticks[i - 1].left) / 100 * trackPx >= widest, `${trackPx} px: ticks ${i - 1} and ${i} are ${((ticks[i].left - ticks[i - 1].left) / 100 * trackPx).toFixed(0)} px apart, a label is ${widest} px`); return { step, ticks }; };
  for (const viewport of [320, 390, 768, 1440]) fit(timeline.trackWidth({ viewport }));
  const phone = fit(timeline.trackWidth({ viewport: 390 })), desk = fit(timeline.trackWidth({ viewport: 1440 }));
  assert.ok(phone.ticks.length >= 2 && phone.ticks.length < desk.ticks.length, `fewer labels on a phone (${phone.ticks.length}) than on a desktop (${desk.ticks.length})`);
  assert.equal(desk.step, 30000, 'a desktop keeps the step it had');
  // Zoom widens the track, so more labels fit.
  assert.ok(fit(timeline.trackWidth({ viewport: 390, zoom: 4 })).ticks.length > phone.ticks.length);
  // A very narrow track still gets at least one label.
  assert.ok(timeline.axisTicks(start, end, { trackPx: 20 }).ticks.length >= 1);
  // The review's case: three attempts over 170 s in the flow dialog, whose track was 72.5 px at 320 px.
  const from = Date.parse('2026-11-16T20:02:35.000Z'), to = from + 170000;
  const narrow = timeline.axisTicks(from, to, { trackPx: 72.5 });
  assert.equal(narrow.ticks.length, 1, `one label in 72.5 px: ${narrow.ticks.map(tick => tick.label)}`);
});

test('Q4 review: the axis is drawn for the track\'s rendered width, again on every resize, and lets go once the track has left the page', () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; this.observed = []; this.disconnected = false; observers.push(this); } observe(node) { this.observed.push(node); } disconnect() { this.disconnected = true; } };
  try {
    const track = { isConnected: true }, drawn = [];
    assert.equal(timeline.fitTicks(track, 180, px => drawn.push(px)), track);
    assert.deepEqual(drawn, [180], 'first drawn for the estimate');
    const [observer] = observers; assert.deepEqual(observer.observed, [track]);
    const resize = width => observer.callback([{ contentRect: { width } }]);
    resize(72.5); resize(72.6); resize(0); resize(400);
    assert.deepEqual(drawn, [180, 73, 400], 'redrawn for the laid-out width when it changes; never for a hidden track');
    track.isConnected = false; resize(300);
    assert.equal(observer.disconnected, true); assert.deepEqual(drawn, [180, 73, 400]);
    // The flow axis through the page: its labels are replaced for the new width.
    const start = Date.parse('2026-11-16T20:02:35.000Z'), end = start + 170000;
    const p = { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional', status: 'available', observedAt: new Date(end + 60000).toISOString(), snapshot: { revision: 1, flows: [{ id: 'flow-1', state: 'completed', step: 'done' }], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: { mode: 'delivery', holds: {}, workflow: { steps: [] }, policy: {} } } };
    const at = ms => new Date(ms).toISOString(), attempt = (id, step, a, b) => ({ id, flowId: 'flow-1', step, status: 'passed', createdAt: at(a), dispatchedAt: at(a), settledAt: at(b), receipt: { startedAt: at(a), endedAt: at(b) } });
    const data = { projectId: 'fictional', flow: { id: 'flow-1', kind: 'change', state: 'completed', step: 'done', createdAt: at(start) }, attempts: [attempt('a1', 'plan', start, start + 60000), attempt('a2', 'build', start + 65000, start + 120000), attempt('a3', 'review', start + 125000, end)], inbox: [], events: [], waits: [], contexts: [], pushback: [], obligations: [], regressions: [] };
    state.reads.clear(); state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'flows', 'flow-1', {})}`, { status: 'ready', data, fetchedAt: new Date().toISOString(), revision: 1 });
    observers.length = 0;
    const page = timeline.flowDetail(p, 'flow-1', { projectId: 'fictional', tab: 'timeline', params: { flow: 'flow-1' } });
    const axisTrack = byClass(page, 'tick')[0].parentElement, labels = () => byClass(axisTrack, 'tick').map(node => node.textContent);
    axisTrack.isConnected = true;
    const axisObserver = observers.find(o => o.observed.includes(axisTrack)); assert.ok(axisObserver, 'the axis track is observed');
    const wide = labels(); axisObserver.callback([{ contentRect: { width: 894 } }]); const desk = labels(); axisObserver.callback([{ contentRect: { width: 72.5 } }]);
    assert.equal(labels().length, 1, `72.5 px: ${labels()}`); assert.ok(desk.length >= 5, `894 px: ${desk}`); assert.ok(wide.length >= 1);
  } finally { delete globalThis.ResizeObserver; }
});

// ======================================================================================
// Q5: the upkeep share in Health.
// ======================================================================================
function shareProject(t, { countingDaysAgo, days, mode = 'propose' }) {
  const f = upkeepProject(t, { upkeep: { ...structuredClone(PROPOSE), mode } }); f.green();
  const now = Date.now(), today = Date.parse(`${upkeepDayId(now)}T00:00:00.000Z`);
  f.store.tx(() => {
    addToUpkeepWindowInTransaction(f.store, { counting: iso(today - countingDaysAgo * DAY + 3600000) });
    days.forEach(([invocations, upkeepInvocations], back) => addToUpkeepDayInTransaction(f.store, upkeepDayId(today - (back + 1) * DAY), { counters: { invocations, upkeepInvocations } }));
  });
  const card = () => byTag(operationsView({ projectId: 'fictional', bindingId: 'b', name: 'Fictional', status: 'available', snapshot: dashboardSnapshot(f.store) }), 'section').find(node => node.attributes['aria-label'] === 'Knowledge upkeep');
  return { ...f, now, today, card };
}

test('Q5: Health shows the seven-day upkeep share against its 10% ceiling, says what it counts, and that a small project may reach it', t => {
  // The trial's numbers over seven complete days: 131 invocations, 20 upkeep-attributed (about 15%).
  const f = shareProject(t, { countingDaysAgo: 10, days: [[30, 4], [25, 6], [20, 2], [16, 3], [15, 2], [15, 2], [10, 1]] });
  const share = dashboardSnapshot(f.store).upkeep.invocationShare;
  assert.equal(share.total, 131); assert.equal(share.upkeep, 20); assert.equal(share.share, 15.3); assert.equal(share.percent, 10);
  assert.equal(share.full, true); assert.equal(share.reached, true);
  assert.equal(share.newest, upkeepDayId(f.today - DAY)); assert.equal(share.oldest, upkeepDayId(f.today - 7 * DAY));
  const text = f.card().textContent;
  assert.match(text, /Upkeep share of model invocations: 20 of 131 in the last 7 complete UTC days \([\d-]+ to [\d-]+, UTC\), 15\.3%; the ceiling is 10%\./);
  assert.match(text, /This reaches the ceiling: the next upkeep run to close suspends the model call and docs follow-ups until you lift it\./);
  assert.match(text, /What counts as upkeep: each assessment’s own model call, and every planner, builder and reviewer call in the follow-up tasks upkeep creates or you accept \(docs, context, check, learning and retirement tasks\)/);
  assert.match(text, /On a project with little other work, a few follow-ups can reach 10%; that is expected\./);
  assert.match(text, /review the share and lift the suspension if it is acceptable/);
  // Below the ceiling.
  f.store.tx(() => addToUpkeepDayInTransaction(f.store, upkeepDayId(f.today - DAY), { counters: { invocations: 100 } }));
  assert.match(f.card().textContent, /20 of 231 .* 8\.7%; the ceiling is 10%\. Below the ceiling of 10%\./);
});

test('Q5: before the window is full Health shows the share so far and the day it is first judged; it reads the window row and seven day rows by key, in observe mode too, and nothing while upkeep is off', t => {
  const f = shareProject(t, { countingDaysAgo: 2, days: [[10, 3], [5, 1]] });
  const share = dashboardSnapshot(f.store).upkeep.invocationShare;
  assert.equal(share.full, false); assert.equal(share.reached, false); assert.equal(share.total, 15); assert.equal(share.upkeep, 4);
  assert.equal(share.judgedFrom, iso(f.today - 2 * DAY + 8 * DAY), 'eight UTC days after the day counting began: seven complete days counted');
  assert.match(f.card().textContent, /4 of 15 .* 26\.7%; the ceiling is 10%\. The window is not full yet, so the ceiling is not judged until /);
  // The ceiling itself still judges nothing before the window is full (unchanged).
  const prepare = f.store.db.prepare.bind(f.store.db), seen = [];
  f.store.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  try { invocationShareStanding(f.store, { nowMs: f.now }); } finally { f.store.db.prepare = prepare; }
  const reads = seen.filter(sql => /FROM records/.test(sql));
  assert.equal(reads.length, 8, 'the window row and seven day rows, each by key');
  assert.ok(!reads.some(sql => /json_extract|json_each/.test(sql)), 'no JSON read over records.data');
  // While upkeep observes the ceiling still judges the share, so Health shows it (decided after the
  // review of e58abd1); off, nothing is counted and Health reads no day row.
  const observing = shareProject(t, { countingDaysAgo: 10, days: [[10, 3]], mode: 'observe' });
  assert.equal(dashboardSnapshot(observing.store).upkeep.invocationShare.share, 30);
  assert.match(observing.card().textContent, /Upkeep share of model invocations: 3 of 10 .* 30%; the ceiling is 10%\. This reaches the ceiling/);
  observing.store.setMeta('config', { ...observing.store.meta('config'), upkeep: { ...structuredClone(PROPOSE), mode: 'off' } });
  assert.equal(dashboardSnapshot(observing.store).upkeep.invocationShare, null);
  assert.doesNotMatch(observing.card()?.textContent ?? '', /Upkeep share of model invocations/);
  // An older project service sends no share: nothing is shown.
  assert.equal(operationsView({ projectId: 'fictional', bindingId: 'b', name: 'Fictional', status: 'available', snapshot: { ...dashboardSnapshot(f.store), upkeep: { ...dashboardSnapshot(f.store).upkeep, invocationShare: undefined } } }).textContent.includes('Upkeep share of model invocations'), false);
});
