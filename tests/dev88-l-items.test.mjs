// dev.88: findings L4 to L7 of the dev.87 readiness re-test (L1 to L3, the triage proxy, are in
// tests/triage-proxy.test.mjs). L4: no status read showed an upkeep run. L5: doctor's progress lines
// on stdout. L6: Escape inside an opened event list closed the whole flow window. L7: Queue's
// "Started … ago" had no UTC tooltip. Fictional fixtures throughout; see docs/changes/dev88-l-items.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, byTag, byClass, descendants } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';

// The console modules install their document listeners at import: record them.
installDom();
const listeners = [];
globalThis.document.addEventListener = (type, handler, capture) => listeners.push({ type, handler, capture });
globalThis.innerWidth = 1200;
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const { queueView } = await import('../starter/factory/console/ui/queue.mjs');
const { stateView } = await import('../starter/factory/operations/state-view.mjs');
const { putUpkeepRunInTransaction } = await import('../starter/factory/operations/upkeep-records.mjs');
const CLI = fileURLToPath(new URL('../starter/factory/cli.mjs', import.meta.url));

const text = node => node.textContent;
const NOW = Date.now(), ago = ms => new Date(NOW - ms).toISOString();
const utcTitle = iso => `${iso} (UTC as recorded)`;
function project(snapshot = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [],
    ...snapshot, settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: { autoQueue: true } } } };
}

// ---- L4: status --flow shows the flow's upkeep run ------------------------------------------------

test('L4: status --flow (and --inbox or --task through their flow) shows the flow\'s knowledge upkeep run, read by key', t => {
  const f = sandbox(t), at = new Date().toISOString();
  f.store.tx(() => f.store.put('flow', { id: 'flow-merged', kind: 'change', taskId: 'task-1', state: 'completed', outcome: 'completed', step: 'done', results: {} }));
  const run = { id: 'flow-merged', status: 'closed', taskId: 'task-1', mergeCommit: 'a'.repeat(40), base: 'b'.repeat(40), target: 'main', mergedAt: at, pendingUntil: new Date(Date.now() + 86400000).toISOString(), queues: 1, runs: 1,
    outcome: 'nothing', reason: 'weak-signals-only', stage: 'pre-filter', flags: ['docs-not-declared'], counts: { signals: 2 }, closedAt: at };
  f.store.tx(() => putUpkeepRunInTransaction(f.store, run));
  // The read must not scan the kind: a record that is not this flow's is never in the output.
  f.store.tx(() => putUpkeepRunInTransaction(f.store, { ...run, id: 'flow-other', outcome: 'abstained', reason: 'fictional-other' }));
  const view = stateView(f.store, { flow: 'flow-merged' });
  assert.deepEqual(view.upkeepRun, f.store.get('upkeepRun', 'flow-merged'));
  assert.deepEqual([view.upkeepRun.outcome, view.upkeepRun.reason, view.upkeepRun.stage, view.upkeepRun.flags], ['nothing', 'weak-signals-only', 'pre-filter', ['docs-not-declared']]);
  assert.ok(!JSON.stringify(view).includes('fictional-other'));
  // An upkeep assessment flow shows the run of the flow it assesses; a flow without one shows null.
  f.store.tx(() => f.store.put('flow', { id: 'flow-assess', kind: 'maintenance', state: 'completed', step: 'done', results: {}, jobPayload: { flowId: 'flow-merged' } }));
  assert.equal(stateView(f.store, { flow: 'flow-assess' }).upkeepRun.id, 'flow-merged');
  assert.equal(stateView(f.store, { task: 'task-1' }).upkeepRun, null, 'a task read with no flow named has no flow to read by');
  f.store.tx(() => f.store.put('flow', { id: 'flow-plain', kind: 'change', taskId: 'task-1', state: 'running', step: 'build', results: {} }));
  assert.equal(stateView(f.store, { flow: 'flow-plain' }).upkeepRun, null);
  // The command line prints it, and its help says so.
  const r = spawnSync(process.execPath, [CLI, 'status', '--state', f.stateDir, '--flow', 'flow-merged'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).upkeepRun.reason, 'weak-signals-only');
  const help = spawnSync(process.execPath, [CLI, 'status', '--help'], { encoding: 'utf8' });
  assert.match(help.stdout, /its knowledge upkeep run \(upkeepRun\)/);
});

// ---- L5: doctor's stdout is one JSON document ----------------------------------------------------

test('L5: doctor prints its progress lines on stderr and only its JSON result on stdout', t => {
  // A delivery project whose doctor stops at a refusal; no provider or forge is contacted.
  const f = sandbox(t), config = { ...f.store.meta('config'), mode: 'delivery' };
  f.store.setMeta('config', config);
  const r = spawnSync(process.execPath, [CLI, 'doctor', '--state', f.stateDir], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  assert.doesNotThrow(() => JSON.parse(r.stdout), `stdout is one JSON document: ${r.stdout.slice(0, 300)}`);
  assert.doesNotMatch(r.stdout, /^doctor: \[/m, 'no progress line on stdout');
});

// ---- L6: Escape closes only the innermost open layer ---------------------------------------------

function flowView() {
  const flow = { id: 'flow-1', taskId: 'task-1', kind: 'change', state: 'completed', outcome: 'completed', step: 'done', createdAt: ago(3600000), finishedAt: ago(1000), workflow: { start: 'build', nodes: { build: {} } }, results: {}, taskSnapshot: { title: 'Fictional task' } };
  const attempts = [{ id: 'att-1', flowId: 'flow-1', step: 'build', status: 'passed', route: 'implemented', createdAt: ago(3500000), dispatchedAt: ago(3499000), settledAt: ago(600000), receipt: { startedAt: ago(3499000), endedAt: ago(600000), exitCode: 0 } }];
  const events = [{ sequence: 1, type: 'flow.admitted', at: ago(3600000), payload: {} }, { sequence: 2, type: 'inbox.opened', at: ago(4000), payload: {} }, { sequence: 3, type: 'inbox.answered', at: ago(3000), payload: {} }, { sequence: 4, type: 'flow.finished', at: ago(1000), payload: { outcome: 'completed' } }];
  const p = project({ flows: [flow] });
  state.projects = [p]; state.reads.clear();
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'flows', 'flow-1', {})}`, { status: 'ready', data: { projectId: 'fictional', flow, attempts, inbox: [], events, waits: [], contexts: [], pushback: [], obligations: [], regressions: [], retrospective: null }, fetchedAt: new Date().toISOString(), revision: 1 });
  return timeline.flowDetail(p, 'flow-1', { params: {} });
}
const toggle = group => { for (const fn of group.handlers.toggle ?? []) fn({ currentTarget: group, target: group }); };
const escape = target => { const e = { key: 'Escape', target, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }; return e; };

test('L6: Escape with focus anywhere in the flow window closes the open event list first, keeps the window, and the next Escape is the window\'s', () => {
  assert.equal(typeof timeline.escapeInnermost, 'function', 'a document-level Escape handler for the innermost layer');
  assert.ok(listeners.some(l => l.type === 'keydown' && l.handler === timeline.escapeInnermost && l.capture === true), 'installed on the document in the capture phase, before the dialog turns Escape into close');
  const dialog = globalThis.document.createElement('dialog'), view = flowView(); dialog.append(view);
  const group = byClass(view, 'marker-group')[0], panel = byClass(view, 'marker-group-panel')[0], summary = byTag(group, 'summary')[0];
  group.open = true; toggle(group);
  assert.equal(panel.hidden, false);
  // The re-test: after a click on the list's title, focus is on the window (or the page), not in the panel.
  for (const target of [dialog, globalThis.document.body, byClass(panel, 'marker-group-panel-title')[0]]) {
    if (!group.open) { group.open = true; toggle(group); }
    const e = escape(target);
    assert.equal(timeline.escapeInnermost(e), true);
    assert.equal(e.defaultPrevented, true, 'the dialog does not close'); assert.equal(e.stopped, true);
    assert.equal(group.open, false); assert.equal(panel.hidden, true);
    assert.equal(globalThis.document.activeElement, summary, 'focus returns to the group\'s summary');
  }
  // Nothing open: the window's own Escape goes through.
  const next = escape(dialog);
  assert.equal(timeline.escapeInnermost(next), false); assert.equal(next.defaultPrevented, false);
  // A key in another dialog opened over the window is that dialog's.
  group.open = true; toggle(group);
  const other = globalThis.document.createElement('dialog'), input = globalThis.document.createElement('input'); other.append(input);
  const typed = escape(input);
  assert.equal(timeline.escapeInnermost(typed), false); assert.equal(group.open, true);
  // Other keys are not touched.
  assert.equal(timeline.escapeInnermost({ ...escape(dialog), key: 'Enter' }), false);
  timeline.closeMarkerGroups();
});

// ---- L7: Queue's relative times carry the recorded UTC time -----------------------------------------

test('L7: Queue\'s "Started … ago", parked-since and last-dispatch times are time elements with the recorded UTC value as tooltip', () => {
  const started = ago(24 * 60000), since = ago(5 * 60000), dispatched = ago(2 * 60000);
  const p = project({
    queue: [{ id: 'task-1', status: 'claimed', claimedAt: started, flowId: 'flow-1' }, { id: 'task-2', status: 'finished', claimedAt: ago(3600000), flowId: 'flow-2' }],
    flows: [{ id: 'flow-1', taskId: 'task-1', state: 'running', step: 'build' }, { id: 'flow-2', taskId: 'task-2', state: 'completed', step: 'done' }],
    tasks: [{ id: 'task-1', title: 'Fictional running task' }, { id: 'task-2', title: 'Fictional finished task' }],
    queueStatus: { autoQueue: false, lastDispatch: { status: 'completed', outcome: 'dispatched', flowId: 'flow-1', createdAt: dispatched, heldReasons: [] }, capacity: { pools: {}, parked: [{ flowId: 'flow-3', step: 'decide', since, holdsSlot: false }], waiting: [], categoryWaits: [], maxParkedFlows: 2, parkedCount: 1, waitingCount: 0 }, holds: [] },
  });
  state.projects = [p];
  const view = queueView(p, { params: {} });
  const chip = byClass(view, 'chip').find(n => text(n).includes('Started ') && text(n).includes('running'));
  assert.ok(chip, 'the Started chip is shown');
  const [node] = byTag(chip, 'time');
  assert.ok(node, 'the relative time is a time element');
  assert.equal(node.getAttribute('datetime'), started); assert.equal(node.getAttribute('title'), utcTitle(started));
  assert.match(text(chip), /Started .*ago · running/);
  const startedTimes = byClass(view, 'chip').filter(n => text(n).includes('Started ')).map(n => byTag(n, 'time')[0]?.getAttribute('title'));
  assert.equal(startedTimes.length, 2); assert.ok(startedTimes.every(Boolean), 'every Started chip has its tooltip');
  // The parked flow's "since" and the last manual dispatch, on the same page, the same way.
  for (const [pattern, iso] of [[/· at decide since .*ago/, since], [/^Last dispatch .*ago started this flow\.$/, dispatched]]) {
    const line = descendants(view).find(n => ['span', 'p'].includes(n.tag) && pattern.test(text(n)));
    assert.ok(line, `shown: ${pattern}`); assert.equal(byTag(line, 'time')[0]?.getAttribute('title'), utcTitle(iso));
  }
});
