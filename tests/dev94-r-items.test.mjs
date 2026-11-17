// dev.94: the dev.93 readiness re-test findings R1–R3 (docs/changes/dev94-r-items.md).
//   R1: on the project Timeline at phone width, a tap on one flow's bar opened another flow.
//   R2: in a flow's execution timeline at phone width, about a quarter of the attempt bars could
//       not be tapped: a neighbouring bar took the tap.
//   R3: Overview's Queue figure links to Queue, and a queue entry names the project-wide hold
//       behind "project held" in Overview's words.
// The bars are drawn, and a layer of tap targets laid out for the track's width takes the taps
// (timeline.mjs, tapTargets). The fake DOM has no layout: the taps were measured in headless
// Chromium at 390, 320 and 1440 px (docs/changes/dev94-r-items.md). Fictional fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, byTag, byClass, descendants } from './fake-dom.mjs';

installDom();
globalThis.innerWidth = 390;
globalThis.document.addEventListener ??= () => {}; globalThis.window.addEventListener ??= () => {};
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const overview = await import('../starter/factory/console/ui/overview.mjs');
const admission = await import('../starter/factory/console/ui/admission.mjs');
const { queueEditor } = await import('../starter/factory/console/ui/plan.mjs');

const at = ms => new Date(ms).toISOString();
const EPS = 0.01;
// Every target holds the visible centre of each bar it stands for; targets that are not a wide bar's
// own never overlap one another; each is at least minPx wide; a wide bar's centre is its own.
function checkTargets(units, trackPx, minPx) {
  const targets = timeline.tapTargets(units, trackPx, minPx), px = v => (v / 100) * trackPx;
  const seen = targets.flatMap(t => t.units.map(u => u.key));
  assert.deepEqual([...seen].sort(), units.map(u => u.key).sort(), 'every bar has exactly one target');
  for (const t of targets) {
    const a = px(t.left), b = px(t.left + t.width);
    assert.ok(a >= -EPS && b <= trackPx + EPS, `target ${a}–${b} inside the ${trackPx} px track`);
    assert.ok(b - a >= Math.min(minPx, trackPx) - EPS, `target ${t.units.map(u => u.key)} is ${(b - a).toFixed(2)} px, under ${minPx}`);
    for (const u of t.units) { const x0 = px(u.start), x1 = Math.max(x0 + Math.min(u.minPx ?? 0, trackPx - x0), px(u.end)), c = (x0 + x1) / 2; assert.ok(c >= a - EPS && c <= b + EPS, `bar ${u.key} centre ${c} outside its target ${a}–${b}`); }
  }
  const small = targets.filter(t => !t.wide);
  for (let i = 1; i < small.length; i++) assert.ok(px(small[i].left) >= px(small[i - 1].left + small[i - 1].width) - EPS, `targets ${small[i - 1].units.map(u => u.key)} and ${small[i].units.map(u => u.key)} overlap`);
  for (const wall of targets.filter(t => t.wide)) {
    const c = px(wall.left + wall.width / 2);
    for (const other of small) assert.ok(!(c > px(other.left) + EPS && c < px(other.left + other.width) - EPS), `the wide bar ${wall.units[0].key} has its centre covered by ${other.units.map(u => u.key)}`);
  }
  return targets;
}

test('R1/R2: bars a pixel apart share one target at phone width, and each has its own when there is room', () => {
  // The trial's 12 h window on a 250 px track: flows minutes apart are a pixel apart.
  const minute = 100 / (12 * 60);
  const units = [{ key: 'a', start: 50, end: 50 + 3 * minute }, { key: 'b', start: 50 + 10 * minute, end: 50 + 10.1 * minute }, { key: 'c', start: 80, end: 80 + minute }];
  const phone = checkTargets(units, 250, timeline.TAP_PX);
  assert.deepEqual(phone.map(t => t.units.map(u => u.key)), [['a', 'b'], ['c']]);
  // With a mouse (8 px) on a desktop track, the two flows (7 minutes apart, 11 px) get a target each.
  const desk = checkTargets(units, 1130, timeline.POINTER_PX);
  assert.deepEqual(desk.map(t => t.units.map(u => u.key)), [['a'], ['b'], ['c']]);
  // Bars at the edges keep their targets inside the track.
  checkTargets([{ key: 'first', start: 0, end: 0.1 }, { key: 'last', start: 99.9, end: 100 }], 200, 44);
  // A track narrower than one target: everything shares it.
  assert.equal(checkTargets([{ key: 'x', start: 10, end: 11 }, { key: 'y', start: 80, end: 81 }], 30, 44).length, 1);
});

test('R2: a wide bar keeps its own target and centre; short bars beside it reach into it by less than a target', () => {
  // A long build between two quick checks with little room on either side.
  const units = [{ key: 'check-1', start: 9.5, end: 10 }, { key: 'build', start: 10, end: 70 }, { key: 'check-2', start: 70, end: 70.4 }, { key: 'check-3', start: 70.5, end: 70.9 }];
  const targets = checkTargets(units, 300, 44);
  const wall = targets.find(t => t.wide);
  assert.deepEqual(wall.units.map(u => u.key), ['build']);
  assert.deepEqual(targets.filter(t => !t.wide).map(t => t.units.map(u => u.key)), [['check-1'], ['check-2', 'check-3']]);
  // A gap between two wide bars narrower than a target: the target is centred on the gap.
  checkTargets([{ key: 'w1', start: 0, end: 45 }, { key: 'tiny', start: 45.2, end: 45.4 }, { key: 'w2', start: 45.6, end: 100 }], 400, 44);
  // Bars drawn wider than their time (a minimum width) are judged by what is drawn.
  checkTargets([{ key: 'p', start: 50, end: 50.01, minPx: 4 }, { key: 'q', start: 50.02, end: 50.03, minPx: 4 }], 1000, 8);
});

test('R1/R2: tap targets hold their invariants for any arrangement of bars and widths', () => {
  let seed = 94; const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 400; round++) {
    const count = 1 + Math.floor(random() * 45), units = [];
    let cursor = random() * 5;
    for (let i = 0; i < count && cursor < 100; i++) {
      const len = random() < 0.15 ? random() * 40 : random() * 1.5, start = cursor, end = Math.min(100, start + len);
      units.push({ key: `u${i}`, start, end, minPx: random() < 0.5 ? 4 : 0 });
      cursor = end + (random() < 0.3 ? 0 : random() * 6);
    }
    const trackPx = [72.5, 160, 180, 250, 311, 980, 1130][round % 7], minPx = round % 3 ? timeline.TAP_PX : timeline.POINTER_PX;
    checkTargets(units, trackPx, minPx);
  }
});

// ---- R1: the project Timeline ----------------------------------------------------------------------
const P = 'fictional';
function project(snapshot = {}) {
  return { projectId: P, bindingId: 'binding-1', name: 'Fictional', status: 'available', observedAt: new Date().toISOString(),
    snapshot: { revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: { mode: 'delivery', holds: {}, workflow: { steps: [] }, policy: {} }, ...snapshot } };
}
const preload = (p, kind, subject, data) => state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, kind, subject, {})}`, { status: 'ready', data, fetchedAt: new Date().toISOString(), revision: p.snapshot.revision });

test('R1: on the project Timeline, flows too close to tap apart share a target that lists and links each; the bars are only drawn', () => {
  const to = Date.parse('2026-11-17T03:51:29.927Z'), from = to - 12 * 3600000, flow = (id, title, a, b, state = 'completed') => ({ id, title, state, start: at(a), end: at(b), segments: [] });
  const flows = [flow('flow-named', 'First fictional change', to - 400 * 60000, to - 397 * 60000), flow('flow-queued', 'Second fictional change', to - 396 * 60000, to - 395.9 * 60000, 'failed'), flow('flow-later', 'Third fictional change', to - 50 * 60000, to - 48 * 60000)];
  const data = { projectId: P, window: { from: at(from), to: at(to), hours: 12 }, pools: [{ kind: 'change', label: 'Change slots', capacity: 1, lanes: [{ index: 1, current: null, flows }] }], events: [], machine: [], stats: { merged: 0, completed: 3, idleSlotMs: 0, slotMs: 0 } };
  const p = project({ revision: 3 });
  state.reads.clear(); preload(p, 'timeline', '12', data);
  const view = timeline.timelineView(p), track = byClass(view, 'slot-track')[0];
  // The bars are drawn, hidden from assistive technology, and carry no link: the targets do.
  const bars = byClass(track, 'slot-flow');
  assert.deepEqual(bars.map(b => b.dataset.flow), ['flow-named', 'flow-queued', 'flow-later']);
  for (const bar of bars) { assert.equal(bar.tag, 'span'); assert.equal(bar.getAttribute('aria-hidden'), 'true'); }
  const layer = byClass(track, 'tap-layer')[0];
  const [group, single] = layer.children;
  assert.equal(group.tag, 'details'); assert.ok(group.classList.includes('bar-group') && group.classList.includes('slot-cluster'));
  assert.equal(byTag(group, 'summary')[0].getAttribute('aria-label'), '2 flows close together; show them below the track');
  assert.equal(single.tag, 'a'); assert.equal(single.dataset.flow, 'flow-later'); assert.match(single.getAttribute('href'), /flow=flow-later/);
  assert.match(single.getAttribute('aria-label'), /^Third fictional change: completed/);
  // Opening the group fills the panel below the track with a link to each flow, by title.
  group.open = true; for (const handler of group.handlers.toggle) handler({ currentTarget: group });
  const panel = byClass(view, 'marker-group-panel').find(node => !node.hidden);
  assert.ok(panel, 'the list shows below the track');
  const links = byTag(panel, 'a');
  assert.deepEqual(links.map(a => a.dataset.flow), ['flow-named', 'flow-queued']);
  assert.ok(links[0].getAttribute('href').includes('flow=flow-named') && links[1].getAttribute('href').includes('flow=flow-queued'));
  assert.match(links[0].textContent, /^First fictional change: completed/);
  timeline.closeMarkerGroups();
});

// ---- R2: a flow's execution timeline ---------------------------------------------------------------
test('R2: attempts too close to tap apart share a target whose list selects each; the rest get a button each', async () => {
  const start = Date.parse('2026-11-16T23:21:39.000Z'), s = 1000;
  const attempt = (id, step, a, b) => ({ id, step, status: 'settled', outcome: 'passed', createdAt: at(start + a * s), dispatchedAt: at(start + a * s), settledAt: at(start + b * s), receipt: { startedAt: at(start + a * s), endedAt: at(start + b * s), exitCode: 0 } });
  // Two quick plan attempts a second apart in a 40-minute flow, then one far later.
  const attempts = [attempt('att-plan-1', 'plan', 60, 61), attempt('att-plan-2', 'plan', 62, 63), attempt('att-plan-3', 'plan', 2000, 2400)];
  const flow = { id: 'flow-busy', kind: 'change', state: 'completed', step: 'done', createdAt: at(start), finishedAt: at(start + 2400 * s), taskId: 'task-1' };
  const p = project({ revision: 4, flows: [{ ...flow }] });
  state.reads.clear(); preload(p, 'flows', 'flow-busy', { projectId: P, flow, attempts, inbox: [], events: [], waits: [], contexts: [], pushback: [], obligations: [], regressions: [], retrospective: null });
  const replaced = [];
  globalThis.location = { hash: '#/p/fictional/timeline?flow=flow-busy' };
  globalThis.history = { replaceState: (_state, _title, target) => replaced.push(target) };
  globalThis.HashChangeEvent = class { constructor(type) { this.type = type; } };
  const view = timeline.flowDetail(p, 'flow-busy', { projectId: P, tab: 'timeline', params: { flow: 'flow-busy' } });
  const row = byClass(view, 'gantt-row').find(node => node.textContent.startsWith('plan'));
  const layer = byClass(row, 'tap-layer')[0];
  assert.deepEqual(layer.children.map(n => n.tag), ['details', 'button']);
  const [group, button] = layer.children;
  assert.equal(byTag(group, 'summary')[0].getAttribute('aria-label'), '2 attempts close together; show them below the track');
  assert.equal(button.dataset.attempt, 'att-plan-3'); assert.match(button.dataset.focusKey, /^bar:att-plan-3:/); assert.equal(button.getAttribute('aria-pressed'), 'false');
  // The drawn bars carry no handler and are hidden from assistive technology.
  for (const bar of byClass(row, 'bar')) { assert.equal(bar.tag, 'span'); assert.equal(bar.getAttribute('aria-hidden'), 'true'); assert.equal(bar.handlers.click, undefined); }
  // The group lists each attempt as a button that selects it, in the panel below the chart.
  group.open = true; for (const handler of group.handlers.toggle) handler({ currentTarget: group });
  const panel = byClass(view, 'marker-group-panel').find(node => !node.hidden);
  const choices = byTag(panel, 'button');
  assert.deepEqual(choices.map(b => b.dataset.attempt), ['att-plan-1', 'att-plan-2']);
  assert.match(choices[1].textContent, /^plan attempt att-plan/);
  for (const handler of choices[1].handlers.click) await handler({ currentTarget: choices[1] });
  assert.equal(replaced.length, 1); assert.match(replaced[0], /flow=flow-busy&attempt=att-plan-2/);
  timeline.closeMarkerGroups();
  // The selected attempt's group says which one is selected.
  const chosen = timeline.flowDetail(p, 'flow-busy', { projectId: P, tab: 'timeline', params: { flow: 'flow-busy', attempt: 'att-plan-2' } });
  const again = byClass(byClass(chosen, 'gantt-row').find(node => node.textContent.startsWith('plan')), 'tap-layer')[0].children[0];
  again.open = true; for (const handler of again.handlers.toggle) handler({ currentTarget: again });
  const pressed = byTag(byClass(chosen, 'marker-group-panel').find(node => !node.hidden), 'button').map(b => b.getAttribute('aria-pressed'));
  assert.deepEqual(pressed, ['false', 'true']);
  assert.ok(byClass(chosen, 'bar').some(bar => bar.dataset.attempt === 'att-plan-2' && bar.classList.includes('selected')));
  timeline.closeMarkerGroups();
});

test('R1/R2: the layer is laid out again for the track\'s measured width, and an open group stays open', () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe(node) { this.node = node; } disconnect() {} };
  try {
    // On a phone (44 px targets): a and b are 2% apart, c 10% further on.
    const units = [{ key: 'a', start: 50, end: 50.1 }, { key: 'b', start: 52, end: 52.1 }, { key: 'c', start: 62, end: 62.1 }];
    const make = { single: u => Object.assign(globalThis.document.createElement('a'), { tapKey: u.key }), group: us => Object.assign(globalThis.document.createElement('details'), { tapKey: us.map(u => u.key).join(','), open: false }) };
    const layer = timeline.tapLayer(units, { track: 'test-resize', estimatePx: 3000, ...make }), keys = () => layer.children.map(n => n.tapKey);
    layer.isConnected = true;
    const resize = width => observers.at(-1).callback([{ contentRect: { width } }]);
    assert.deepEqual(keys(), ['a', 'b', 'c'], '3000 px: 60 px apart, a target each');
    resize(1000);
    assert.deepEqual(keys(), ['a,b', 'c'], '1000 px: a and b 20 px apart share a target');
    const group = layer.children[0]; group.open = true;
    resize(990);
    assert.equal(layer.children[0], group, 'the same targets are moved, not rebuilt'); assert.equal(group.open, true);
    resize(300);
    assert.deepEqual(keys(), ['a,b,c']); assert.equal(layer.children[0].open, true, 'the open group stays open as the group that holds its bars');
    // A rebuilt page starts from the width last measured for this kind of track.
    const again = timeline.tapLayer(units, { track: 'test-resize', estimatePx: 3000, ...make });
    assert.deepEqual(again.children.map(n => n.tapKey), ['a,b,c'], 'laid out for the measured 300 px, not the 3000 px estimate');
  } finally { delete globalThis.ResizeObserver; }
});

test('R1/R2: the bars take no taps, the targets do; targets are 44 px tall on a phone', () => {
  const css = readFileSync(new URL('../starter/factory/console/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.slot-flow \{[^}]*pointer-events: none/);
  assert.match(css, /\.gantt-rows \.bar\[data-attempt\] \{ pointer-events: none; \}/);
  assert.match(css, /\.bar-group-count \{[^}]*pointer-events: none/, 'a count wider than its target does not take its neighbour\'s taps');
  assert.match(css, /\.bar:empty \{ padding: 0; \}/, 'an unlabelled bar is drawn as wide as its time');
  const phone = css.slice(css.indexOf('.tap-layer { position'));
  assert.match(phone, /\.slot-track:not\(\.events\) \{ height: 44px; \}/);
  assert.match(phone, /\.gantt-scroll \.gantt-rows \.gantt-row \{ min-height: 45px; \}/);
  assert.equal(timeline.TAP_PX, 44);
});

// ---- R3 --------------------------------------------------------------------------------------------
test('R3: Overview\'s Queue figure links to Queue, at the held task when one is held on its own', () => {
  const queue = [{ id: 'task-held', status: 'queued', order: 1 }];
  const held = project({ queue, queueStatus: { holds: [{ kind: 'context-provider', scope: 'task', taskId: 'task-held', text: 'Context task task-held is not started.' }] } });
  const figure = byClass(overview.projectOverview(held), 'kpi').find(node => node.textContent.startsWith('Queue'));
  const link = byTag(figure, 'a')[0];
  assert.equal(link.textContent, 'Open Queue'); assert.match(link.getAttribute('href'), /\/queue\?task=task-held$/);
  const plain = byClass(overview.projectOverview(project({ queue, queueStatus: { holds: [] } })), 'kpi').find(node => node.textContent.startsWith('Queue'));
  assert.match(byTag(plain, 'a')[0].getAttribute('href'), /\/queue$/);
});

test('R3: a queue entry\'s "project held" names the project-wide hold in Overview\'s words', () => {
  const reasons = ['admission: task task-held is held for its providers (task.models)', 'project held'];
  const queue = [{ id: 'task-held', status: 'queued', order: 1, eligibility: { ready: false, reasons, lastObservedAt: at(Date.now()), transitions: 1 } }];
  const tasks = [{ id: 'task-held', title: 'A held task', revision: 'r1', approvedRevision: 'r1' }];
  const paused = project({ paused: true, queue, tasks, queueStatus: { holds: [{ kind: 'paused', text: 'Admission is paused. Resume it from Overview.' }] } });
  const entry = text => descendants(queueEditor(text)).find(node => node.tag === 'details' && /Admission held/.test(node.textContent)).textContent;
  const shown = entry(paused);
  assert.match(shown, /\(task\.models\); the whole queue is held: admission is pausedObserved/);
  assert.doesNotMatch(shown, /; project held/);
  // The same words as Overview's "The rest of the queue is held too: admission is paused."
  assert.match(overview.restOfQueue(paused.snapshot), /held too: admission is paused\./);
  // Several, and an older project service that reports only its flags.
  assert.equal(admission.projectHeldText({ queueStatus: { holds: [{ kind: 'paused' }, { kind: 'recovery' }, { kind: 'retention' }, { kind: 'money' }] } }), 'the whole queue is held: admission is paused, a recovery hold is in place and a retention hold is in place');
  assert.equal(admission.projectHeldText({ recoveryHold: true }), 'the whole queue is held: a recovery hold is in place');
  // Observed held, but nothing holds the project now: said as the past.
  assert.match(entry(project({ queue, tasks, queueStatus: { holds: [] } })), /; the whole queue was held then \(no project-wide hold is in place now\)Observed/);
});

// ---- Review of 3e4fdda, P2: a refresh lost focus inside an open group -----------------------------
// A refresh rebuilds the page and restores what was open and focused (ui.mjs, restore). It set an
// open group's `open` and then looked for the focused entry, but a group with its list in a panel
// filled the panel only in its toggle handler, which the browser runs later: the entry did not exist
// yet and focus fell to the page. A group now fills its panel as soon as it is opened, the later
// toggle event leaves the panel (and the focused entry) as it is, and restore reopens sections before
// it restores focus, which an entry inside a closed group could not take.
function busyFlow() {
  const start = Date.parse('2026-11-16T23:21:39.000Z'), s = 1000;
  const attempt = (id, step, a, b) => ({ id, step, status: 'settled', outcome: 'passed', createdAt: at(start + a * s), dispatchedAt: at(start + a * s), settledAt: at(start + b * s), receipt: { startedAt: at(start + a * s), endedAt: at(start + b * s), exitCode: 0 } });
  const attempts = [attempt('att-plan-1', 'plan', 60, 61), attempt('att-plan-2', 'plan', 62, 63), attempt('att-plan-3', 'plan', 2000, 2400)];
  const event = (type, sec) => ({ type, at: at(start + sec * s) });
  const flow = { id: 'flow-busy', kind: 'change', state: 'completed', step: 'done', createdAt: at(start), finishedAt: at(start + 2400 * s), taskId: 'task-1' };
  const p = project({ revision: 5, flows: [{ ...flow }] });
  state.reads.clear(); preload(p, 'flows', 'flow-busy', { projectId: P, flow, attempts, inbox: [], events: [event('flow.stopped', 100), event('flow.resumed', 101)], waits: [], contexts: [], pushback: [], obligations: [], regressions: [], retrospective: null });
  return timeline.flowDetail(p, 'flow-busy', { projectId: P, tab: 'timeline', params: { flow: 'flow-busy' } });
}
// Shown: its group set hidden = false and filled it (in the fake DOM a fresh panel carries only the attribute).
const shownPanel = view => byClass(view, 'marker-group-panel').find(node => node.hidden === false && node.children.length > 0);
const fire = group => { for (const handler of group.handlers.toggle ?? []) handler({ currentTarget: group }); };

test('Review P2: opening a group as a refresh does fills its panel at once, and the later toggle keeps the entries', () => {
  const groups = [];
  // Attempts grouped in a flow's execution timeline.
  { const view = busyFlow(); groups.push(['attempts', view, byClass(view, 'bar-cluster')[0], panel => byTag(panel, 'button')[0]]); }
  // Events grouped in the same chart (their list is in the same panel).
  { const view = busyFlow(); groups.push(['events', view, byClass(view, 'marker-cluster')[0], panel => byTag(panel, 'li')[0]]); }
  // Flows grouped on the project Timeline.
  { const to = Date.parse('2026-11-17T03:51:29.927Z'), from = to - 12 * 3600000, flow = (id, a, b) => ({ id, title: `Fictional ${id}`, state: 'completed', start: at(a), end: at(b), segments: [] });
    const p = project({ revision: 6 }); state.reads.clear();
    preload(p, 'timeline', '12', { projectId: P, window: { from: at(from), to: at(to), hours: 12 }, pools: [{ kind: 'change', label: 'Change slots', capacity: 1, lanes: [{ index: 1, current: null, flows: [flow('flow-a', to - 400 * 60000, to - 397 * 60000), flow('flow-b', to - 396 * 60000, to - 395.9 * 60000)] }] }], events: [], machine: [], stats: { merged: 0, completed: 2, idleSlotMs: 0, slotMs: 0 } });
    const view = timeline.timelineView(p); groups.push(['flows', view, byClass(view, 'slot-cluster')[0], panel => byTag(panel, 'a')[0]]); }
  for (const [name, view, group, entryOf] of groups) {
    assert.ok(group, `${name}: a group`);
    assert.equal(shownPanel(view), undefined, `${name}: closed at first`);
    group.open = true; // what restore does; the toggle event comes later
    const panel = shownPanel(view);
    assert.ok(panel, `${name}: the panel is shown as soon as the group is opened`);
    const entry = entryOf(panel);
    assert.ok(entry, `${name}: its entries exist before any toggle event`);
    if (entry.dataset.focusKey) assert.match(entry.dataset.focusKey, /^marker-item:/, `${name}: the entry keeps its focus key`);
    fire(group); // the browser's toggle event, after restore has focused the entry
    assert.ok(panel.contains(entry) && !panel.hidden, `${name}: the toggle event leaves the focused entry in place`);
    group.open = false;
    assert.equal(shownPanel(view), undefined, `${name}: closing it empties the panel`);
    fire(group); timeline.closeMarkerGroups();
  }
});

test('Review P2: a refresh reopens sections before it restores focus', () => {
  const ui = readFileSync(new URL('../starter/factory/console/ui.mjs', import.meta.url), 'utf8');
  const body = ui.slice(ui.indexOf('function restore('), ui.indexOf('\n}', ui.indexOf('function restore(')));
  const sections = body.indexOf('snapshot.sections'), focus = body.indexOf('.focus(');
  assert.ok(sections > 0 && focus > 0, 'restore reopens sections and restores focus');
  assert.ok(sections < focus, 'sections first, so an entry inside an open group exists and can take focus');
});

test('Review P2: a flow\'s own target on the Timeline has a focus key, so a refresh can give its focus back', () => {
  const to = Date.parse('2026-11-17T03:51:29.927Z'), from = to - 12 * 3600000;
  const p = project({ revision: 7 }); state.reads.clear();
  preload(p, 'timeline', '12', { projectId: P, window: { from: at(from), to: at(to), hours: 12 }, pools: [{ kind: 'change', label: 'Change slots', capacity: 1, lanes: [{ index: 1, current: null, flows: [{ id: 'flow-alone', title: 'Fictional alone', state: 'completed', start: at(to - 300 * 60000), end: at(to - 200 * 60000), segments: [] }] }] }], events: [], machine: [], stats: { merged: 0, completed: 1, idleSlotMs: 0, slotMs: 0 } });
  const [target] = byClass(timeline.timelineView(p), 'slot-hit');
  assert.equal(target.dataset.focusKey, 'slot-flow:flow-alone');
});
