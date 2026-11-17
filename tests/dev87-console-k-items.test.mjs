// dev.87: console findings K2, K3 and K4 of the dev.86 readiness re-test. A grouped marker in a
// flow's execution timeline opened its list inside the chart's scrolling box, which clipped it (K2);
// the Inbox was 680 px wide on a 390 px phone because a card's longest unbroken word set its width
// (K3); Health's scheduled-tier time had no UTC tooltip (K4). Fictional fixtures throughout. See
// docs/changes/dev87-k-items.md, which also records the real-browser measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDom, byTag, byClass, descendants } from './fake-dom.mjs';

installDom();
globalThis.innerWidth = 390;
const { state, readPath, uiState } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const { inboxView } = await import('../starter/factory/console/ui/inbox.mjs');
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const css = readFileSync(new URL('../starter/factory/console/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const text = node => node.textContent;
const NOW = Date.now(), ago = ms => new Date(NOW - ms).toISOString();
const utcTitle = iso => `${iso} (UTC as recorded)`;
function project(snapshot = {}, settings = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [],
    ...snapshot, settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: { autoQueue: true }, ...settings } } };
}
// The declarations of every rule whose selector list includes exactly `selector`.
const declarations = selector => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => sel.split(',').map(s => s.trim()).includes(selector)).map(([, , body]) => body).join(';');
const declares = (selector, property, value) => new RegExp(`(^|;)\\s*${property}\\s*:\\s*${value}\\s*(;|$)`).test(declarations(selector));

// ---- K2: a grouped marker's list in the flow's execution timeline --------------------------------

function flowView() {
  const flow = { id: 'flow-1', taskId: 'task-1', kind: 'change', state: 'completed', outcome: 'completed', step: 'done', createdAt: ago(3600000), finishedAt: ago(1000), workflow: { start: 'build', nodes: { build: {} } }, results: {}, taskSnapshot: { title: 'Fictional task' } };
  const attempts = [{ id: 'att-1', flowId: 'flow-1', step: 'build', status: 'passed', route: 'implemented', createdAt: ago(3500000), dispatchedAt: ago(3499000), settledAt: ago(600000), receipt: { startedAt: ago(3499000), endedAt: ago(600000), exitCode: 0 } }];
  // The trial's case: three events seconds apart at the end of an hour-long flow.
  const events = [{ sequence: 1, type: 'flow.admitted', at: ago(3600000), payload: {} }, { sequence: 2, type: 'inbox.opened', at: ago(4000), payload: {} }, { sequence: 3, type: 'inbox.answered', at: ago(3000), payload: {} }, { sequence: 4, type: 'flow.finished', at: ago(1000), payload: { outcome: 'completed' } }];
  const p = project({ flows: [flow] });
  state.projects = [p]; state.reads.clear();
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'flows', 'flow-1', {})}`, { status: 'ready', data: { projectId: 'fictional', flow, attempts, inbox: [], events, waits: [], contexts: [], pushback: [], obligations: [], regressions: [], retrospective: null }, fetchedAt: new Date().toISOString(), revision: 1 });
  return timeline.flowDetail(p, 'flow-1', { params: {} });
}
const toggle = group => { for (const fn of group.handlers.toggle ?? []) fn({ currentTarget: group, target: group }); };
const key = (node, k) => { let prevented = false; for (const fn of node.handlers.keydown ?? []) fn({ key: k, currentTarget: node, target: node, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; };

test('K2: a grouped marker in the flow\'s execution timeline shows its list below the chart, outside the box that scrolls, and closes from the keyboard', () => {
  const view = flowView();
  const scroll = byClass(view, 'gantt-scroll')[0], group = byClass(scroll, 'marker-group')[0];
  assert.ok(group, 'the three events are one group'); assert.equal(byTag(group, 'summary')[0].textContent, '3');
  assert.ok(group.classList.includes('lists-below'));
  assert.deepEqual(byTag(scroll, 'ul').filter(ul => ul.classList.includes('marker-group-list')), [], 'no list is placed inside the chart, whose overflow clipped it');
  // The panel is the chart's sibling, after it, in the page's flow; the summary names it.
  const block = byClass(view, 'gantt-block')[0], panel = byClass(block, 'marker-group-panel')[0];
  assert.deepEqual(block.children.map(n => n.className), ['gantt-scroll', 'marker-group-panel']);
  assert.equal(scroll.contains(panel), false);
  assert.equal(panel.getAttribute('hidden'), '', 'empty and hidden until a group opens');
  const summary = byTag(group, 'summary')[0];
  assert.equal(summary.getAttribute('aria-controls'), panel.getAttribute('id')); assert.match(summary.getAttribute('aria-label'), /3 events close together; show them below the chart/);
  // Opening it fills the panel with every event.
  group.open = true; toggle(group);
  assert.equal(panel.hidden, false);
  assert.deepEqual(byTag(panel, 'li').map(li => text(li).split(' · ')[0]), ['Question opened', 'Question answered', 'Flow finished']);
  assert.match(text(panel), /^3 events close together:/);
  // A click inside the panel keeps it open; Escape there closes the group and returns focus to its summary.
  timeline.outsideClick({ target: byTag(panel, 'li')[0] });
  assert.equal(group.open, true);
  assert.equal(key(panel, 'Escape'), true);
  assert.equal(group.open, false); assert.equal(panel.hidden, true); assert.deepEqual(panel.children, []);
  assert.equal(globalThis.document.activeElement, summary);
  // Escape on the group itself, and a click outside, close it too.
  group.open = true; toggle(group); key(group, 'Escape');
  assert.equal(panel.hidden, true);
  group.open = true; toggle(group); timeline.outsideClick({ target: scroll });
  assert.equal(group.open, false); assert.equal(panel.hidden, true);
  // The list in the panel is laid out in the flow, not placed over the chart.
  assert.ok(declares('.marker-group-panel .marker-group-list', 'position', 'static'));
  assert.ok(declares('.marker-group-panel', 'overflow-wrap', 'anywhere'));
  assert.ok(declares('.marker-group-panel[hidden]', 'display', 'none'));
});

test('K2: the Timeline tab\'s groups keep their own list, which its track does not clip (dev.84)', () => {
  const group = timeline.markerGroup([{ text: 'Merged #12 · 10:00' }, { text: 'Merged #13 · 10:01' }], { cls: 'tl-ev-cluster', pct: 50 });
  assert.ok(group.classList.includes('opens-center')); assert.equal(byTag(group, 'ul').length, 1);
  assert.ok(declares('.slot-track.events', 'overflow', 'visible'));
});

// ---- K3: the Inbox fits a phone -------------------------------------------------------------------

test('K3: an Inbox card with a long unbroken title and context wraps them, so the Inbox fits a 320 px screen', () => {
  const send = `${'8b4502d61e65b3ffb26ddb57381d479211cd5ff8099d2f706a0cf0600cd9bcd1'}:1`, thread = `mcp:launch:${'0'.repeat(56)}dead0086`;
  const notice = { id: 'triage-undelivered-a4fbac464a27-8f8e8997', standalone: true, kind: 'notice', role: 'operator', status: 'open', version: 1, createdBy: 'orchestrator', createdAt: ago(60000),
    title: `Not delivered to the orchestrator: forward ${send}`, context: `Every orchestrator thread known failed 2 sends (${thread}).\n\nSend ID ${send}.` };
  const p = project({ inbox: [notice] }); state.projects = [p]; uiState('inbox').filter = 'open';
  const view = inboxView(p, { params: {} }), card = byTag(view, 'article').find(n => n.attributes.id === `decision-${notice.id}`);
  // The tokens are shown whole (not cut): the page wraps them.
  assert.ok(text(byTag(card, 'h3')[0]).includes(send)); assert.ok(descendants(card).some(n => n.tag === 'p' && n.classList.includes('preline') && text(n).includes(thread)));
  // The cause: an Inbox card is a grid item, so without min-width: 0 its width is its longest unbroken word
  // (the 66-character send ID alone made it 680 px, the 75-character thread ID alone 675 px, in Chromium at 390 px).
  for (const cls of ['decision-list', 'decision']) assert.ok(byClass(view, cls).length, cls);
  assert.ok(declares('.decision', 'min-width', '0'), '.decision may shrink below its longest word');
  assert.ok(declares('.decision', 'overflow-wrap', 'anywhere'), 'and every text in it may break anywhere (inherited), which also lowers its min-content width');
  assert.ok(declares('.decision-list', 'min-width', '0'));
  assert.ok(declares('.view', 'display', 'grid'), 'the view is the grid the list sits in');
  // Nothing in the card turns wrapping off again.
  const classes = new Set(descendants(card).flatMap(n => n.classList));
  for (const cls of classes) assert.ok(!/white-space\s*:\s*(nowrap|pre)\s*(;|$)/.test(declarations(`.${cls}`)) || ['chip', 'btn'].some(c => cls.startsWith(c)), `.${cls} does not stop long words wrapping`);
});

// ---- K4: Health's scheduled-tier time ---------------------------------------------------------------

test('K4: Health shows the scheduled tier\'s time as the dev.83 time element, with its UTC value as recorded', () => {
  const at = ago(3600000), head = 'f79ae0bff3ea'.padEnd(40, '0');
  const p = project({ mainHealth: { status: 'green', head, checkedAt: ago(60000), tier: 'merge', checks: [{ id: 'unit', status: 'passed' }], scheduled: { status: 'green', head, checkedAt: at, checks: [{ id: 'full', passed: true }] } } },
    { mainChecks: [{ id: 'unit', tier: 'merge' }, { id: 'full', tier: 'scheduled' }] });
  const view = operationsView(p);
  const terms = byTag(view, 'dt'), i = terms.findIndex(dt => text(dt) === 'Scheduled tier'), value = byTag(view, 'dd')[i];
  const [node] = byTag(value, 'time');
  assert.ok(node, 'Scheduled tier has a time element');
  assert.equal(node.getAttribute('datetime'), at); assert.equal(node.getAttribute('title'), utcTitle(at));
  assert.match(text(value), /green at f79ae0bff3ea…, /);
  // The scheduled-only check's line under Checks names the same time the same way.
  const line = byTag(view, 'li').find(li => /full · scheduled tier, not part of this run · last full verification/.test(text(li)));
  assert.equal(byTag(line, 'time')[0].getAttribute('title'), utcTitle(at));
});
