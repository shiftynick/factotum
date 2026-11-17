// dev.95: the dev.94 re-test finding S1, and the same layout on the project Timeline's events track.
//   S1: in a busy flow's execution timeline at phone width, the closed event-marker groups overlapped
//       each other and single markers: at 390 px "7 events close together" covered "2 events close
//       together" by 2.2 px and the single "Flow admitted" marker by 14.8 px; at 320 px "8 events"
//       covered "2 events" by 12.7 px. Desktop was clean.
// Markers were grouped when closer than a fixed 14 px, but a group is drawn 44 px wide on a phone,
// centred on its first event. The lane is now laid out from the boxes as drawn (timeline.mjs,
// markerBoxes). The fake DOM has no layout, so the boxes are measured here from style.css: a single
// marker is a .7rem square turned 45 degrees (16 px across), a group's count is at least 1.4rem wide
// and 44 px on a phone. Fictional fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag, byClass } from './fake-dom.mjs';

installDom();
globalThis.innerWidth = 390;
globalThis.document.addEventListener ??= () => {}; globalThis.window.addEventListener ??= () => {};
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const { eventLabel } = await import('../starter/factory/console/ui/records.mjs');
const { time } = await import('../starter/factory/console/ui/dom.mjs');

const at = ms => new Date(ms).toISOString();
const EPS = 0.01;
// The drawn width of a box in CSS px, from style.css (independent of the code under test).
const SINGLE_PX = 16;
const groupPx = (count, phone) => Math.max(phone ? 44 : 22.4, String(count).length * 8 + 12);

// Every unit is in exactly one box; no two boxes overlap (each ends before the next begins); a group
// is at least as wide as drawn and stays inside the track.
function checkBoxes(units, trackPx, minPx) {
  const boxes = timeline.markerBoxes(units, trackPx, minPx), px = v => (v / 100) * trackPx;
  assert.deepEqual(boxes.flatMap(b => b.units.map(u => u.key)).sort(), units.map(u => u.key).sort(), 'every event is in exactly one box');
  for (const box of boxes) {
    const drawn = box.units.length === 1 ? box.units[0].px ?? SINGLE_PX : groupPx(box.units.length, minPx >= 44);
    assert.ok(px(box.width) >= drawn - EPS, `box of ${box.units.length} is ${px(box.width)} px, drawn ${drawn} px`);
    assert.ok(Math.abs(px(box.left + box.width / 2) - px(box.centre)) < EPS, 'the box is centred where it is drawn');
    if (box.units.length > 1 && trackPx >= px(box.width)) assert.ok(px(box.left) >= -EPS && px(box.left + box.width) <= trackPx + EPS, 'a group stays inside the track');
  }
  for (let i = 1; i < boxes.length; i++) {
    const end = px(boxes[i - 1].left + boxes[i - 1].width), begin = px(boxes[i].left);
    assert.ok(begin >= end - EPS, `boxes ${i - 1} and ${i} overlap by ${(end - begin).toFixed(2)} px at ${trackPx} px`);
  }
  return boxes;
}

// A busy flow: 43 attempts over 40 minutes, and its events bunched as in the re-test: the flow is
// admitted, then a run of stops, resumes and replans, two inbox events, and more later.
const START = Date.parse('2026-11-16T23:21:39.000Z'), S = 1000;
const EVENT_SECONDS = [
  ['flow.admitted', 0],
  ...[160, 170, 180, 190, 200, 210, 220].map((sec, i) => [['flow.stopped', 'flow.resumed', 'flow.replan'][i % 3], sec]),
  ['inbox.opened', 400], ['inbox.answered', 410],
  ['attempt.uncertain', 1200],
  ...[2000, 2010, 2020, 2030].map(sec => ['attempt.reconciled', sec]),
  ['command.rejected', 2380], ['flow.finished', 2400],
];
function busyFlow({ revision = 7 } = {}) {
  const attempt = (i, a, b) => ({ id: `att-${String(i).padStart(2, '0')}`, step: ['plan', 'build', 'check'][i % 3], status: 'settled', outcome: 'passed', createdAt: at(START + a * S), dispatchedAt: at(START + a * S), settledAt: at(START + b * S), receipt: { startedAt: at(START + a * S), endedAt: at(START + b * S), exitCode: 0 } });
  const attempts = Array.from({ length: 43 }, (_, i) => attempt(i, i * 55, i * 55 + 20));
  const events = EVENT_SECONDS.map(([type, sec]) => ({ type, at: at(START + sec * S) }));
  const flow = { id: 'flow-busy', kind: 'change', state: 'completed', step: 'done', createdAt: at(START), finishedAt: at(START + 2400 * S), taskId: 'task-1' };
  const p = { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional', status: 'available', observedAt: new Date().toISOString(),
    snapshot: { revision, flows: [{ ...flow }], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: { mode: 'delivery', holds: {}, workflow: { steps: [] }, policy: {} } } };
  state.reads.clear();
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'flows', 'flow-busy', {})}`, { status: 'ready', data: { projectId: p.projectId, flow, attempts, inbox: [], events, waits: [], contexts: [], pushback: [], obligations: [], regressions: [], retrospective: null }, fetchedAt: new Date().toISOString(), revision });
  return { view: timeline.flowDetail(p, 'flow-busy', { projectId: p.projectId, tab: 'timeline', params: { flow: 'flow-busy' } }), events };
}
// The marker lane's boxes as drawn: [{ a, b, texts }] in px on a track trackPx wide.
function drawnBoxes(view, trackPx, phone) {
  const lane = byClass(view, 'markers')[0];
  assert.ok(lane, 'the chart has an event-marker lane');
  const nodes = [...byClass(lane, 'marker'), ...byClass(lane, 'marker-cluster')];
  return nodes.map(node => {
    const centre = (parseFloat(node.style.left) / 100) * trackPx, texts = node.getAttribute('title').split('\n');
    const width = node.tag === 'details' ? groupPx(texts.length, phone) : SINGLE_PX;
    if (node.tag === 'details') assert.equal(byTag(node, 'summary')[0].textContent, String(texts.length), 'the group shows its count');
    return { a: centre - width / 2, b: centre + width / 2, texts, group: node.tag === 'details' };
  }).sort((p, q) => p.a - q.a);
}

for (const [viewport, trackPx] of [[390, 250], [320, 180]]) {
  test(`S1: at ${viewport} px the event markers of a busy flow are drawn as disjoint boxes, and every event is reachable`, () => {
    globalThis.innerWidth = viewport;
    try {
      assert.equal(timeline.trackWidth(), trackPx, 'the track width the chart is first laid out for');
      const { view, events } = busyFlow();
      const boxes = drawnBoxes(view, trackPx, true);
      assert.ok(boxes.some(box => box.group), 'the dense run is grouped');
      for (let i = 1; i < boxes.length; i++) {
        const overlap = boxes[i - 1].b - boxes[i].a;
        assert.ok(overlap <= EPS, `"${boxes[i - 1].texts.length > 1 ? `${boxes[i - 1].texts.length} events close together` : boxes[i - 1].texts[0]}" overlaps "${boxes[i].texts.length > 1 ? `${boxes[i].texts.length} events close together` : boxes[i].texts[0]}" by ${overlap.toFixed(1)} px`);
      }
      // Each event is a single marker or is listed by exactly one counted group.
      const listed = boxes.flatMap(box => box.texts);
      assert.equal(listed.length, events.length, 'every event is drawn exactly once');
      for (const event of events) assert.equal(listed.filter(text => text.startsWith(`${eventLabel(event.type)} · ${time(event.at)}`)).length, 1, `${event.type} at ${event.at} is reachable once`);
      // A group's list, opened below the chart, names each of its events.
      const group = byClass(view, 'marker-cluster')[0];
      group.open = true;
      const panel = byClass(view, 'marker-group-panel').find(node => node.hidden === false && node.children.length > 0);
      assert.deepEqual(byTag(panel, 'li').map(li => li.textContent), group.getAttribute('title').split('\n'));
      timeline.closeMarkerGroups();
    } finally { globalThis.innerWidth = 390; }
  });
}

test('S1: the reported clusters are laid out as disjoint boxes at phone chart widths, with every event in one box', () => {
  const span = 2400 * 1.04, pctOf = sec => ((sec + 2400 * 0.02) / span) * 100;
  const units = EVENT_SECONDS.map(([type, sec], i) => ({ key: `${i}:${type}`, at: pctOf(sec) }));
  // The widths first estimated at 390 and 320 px, and the narrower tracks of the flow's window there.
  for (const trackPx of [250, 210, 180, 140, 100]) {
    const boxes = checkBoxes(units, trackPx, timeline.TAP_PX);
    assert.ok(boxes.length >= 2, `${trackPx} px: the lane still separates distant events`);
  }
  // On a desktop (8 px pointer targets) nothing is grouped that has room.
  const desk = checkBoxes(units, 1130, timeline.POINTER_PX);
  assert.deepEqual(desk.filter(box => box.units.length === 1).map(box => box.units[0].key), ['0:flow.admitted', '10:attempt.uncertain'], 'distant events keep their own markers on a desktop');
  // The box widths follow style.css.
  assert.equal(timeline.markerBoxPx(1, timeline.TAP_PX), SINGLE_PX);
  assert.equal(timeline.markerBoxPx(7, timeline.TAP_PX), 44);
  assert.ok(timeline.markerBoxPx(2, timeline.POINTER_PX) >= 22.4);
  assert.ok(timeline.markerBoxPx(120, timeline.TAP_PX) >= 3 * 8 + 12);
});

test('S1: event-marker boxes are disjoint for any arrangement of events and track widths', () => {
  let seed = 95; const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 500; round++) {
    const count = 1 + Math.floor(random() * 60), units = [];
    let cursor = random() * 3;
    for (let i = 0; i < count && cursor <= 100; i++) {
      units.push({ key: `e${i}`, at: cursor });
      cursor += random() < 0.4 ? random() * 0.5 : random() < 0.7 ? random() * 8 : random() * 30;
    }
    const trackPx = [30, 72.5, 100, 140, 180, 210, 250, 311, 980, 1130][round % 10], minPx = round % 3 ? timeline.TAP_PX : timeline.POINTER_PX;
    checkBoxes(units, trackPx, minPx);
  }
});

test('S1: the marker lane is laid out again for the track\'s measured width', () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe(node) { this.node = node; } disconnect() {} };
  globalThis.innerWidth = 1440;
  try {
    const { view } = busyFlow({ revision: 8 });
    const lane = byClass(view, 'markers')[0], layer = byClass(lane, 'marker-layer')[0];
    const observer = observers.find(o => o.node === layer);
    assert.ok(observer, 'the marker lane watches its width');
    layer.isConnected = true;
    const wide = layer.children.length;
    observer.callback([{ contentRect: { width: 180 } }]);
    assert.ok(layer.children.length < wide, 'a narrow track groups more events');
    const boxes = drawnBoxes(view, 180, false);
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].a >= boxes[i - 1].b - EPS, 'the boxes laid out for 180 px do not overlap');
  } finally { delete globalThis.ResizeObserver; globalThis.innerWidth = 390; }
});

// ---- The same on the project Timeline's events track -----------------------------------------------
// Its events were grouped when closer than 40 px of a track estimated 330 px wide at 390 px, and a
// group was centred on its first event; an event alone is its glyph and short reference. A single
// event is measured from style.css (.tl-ev): a .95rem glyph (16 px), a .15rem gap and the reference
// at about 8 px a character.
const eventPx = event => 16 + (event.ref ? 3 + event.ref.length * 8 : 0);
const FROM = Date.parse('2026-11-15T00:00:00Z'), TO = FROM + 12 * 3600000, atMin = minutes => at(FROM + minutes * 60000);
// A busy twelve hours: a burst of merges, stops and questions, then a merge with a long reference
// a little over an hour and a half later, a pair, another long reference nearly two hours after it,
// and an upgrade alone.
const TIMELINE_EVENTS = [
  ...[120, 123, 126, 129, 132].map((m, i) => ({ type: ['merged', 'stopped', 'question-operator', 'merged', 'failed'][i], at: atMin(m), label: `Burst ${i + 1}`, ref: i % 3 === 0 ? `#${120 + i}` : null, flowId: `flow-burst-${i}` })),
  { type: 'merged', at: atMin(230), label: 'Long reference', ref: '#12345', flowId: 'flow-long' },
  { type: 'merged', at: atMin(400), label: 'Pair 1', ref: '#7', flowId: 'flow-pair-1' }, { type: 'question-orchestrator', at: atMin(405), label: 'Pair 2', ref: null, flowId: 'flow-pair-2' },
  { type: 'merged', at: atMin(520), label: 'Second long reference', ref: '#54321', flowId: 'flow-long-2' },
  { type: 'upgrade', at: atMin(700), label: 'Upgrade alone', ref: null },
];
function projectTimeline(events = TIMELINE_EVENTS, revision = 9) {
  const p = { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional', status: 'available', observedAt: new Date().toISOString(),
    snapshot: { revision, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: { mode: 'delivery', holds: {}, workflow: { steps: [] }, policy: {} } } };
  state.reads.clear();
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'timeline', '12', {})}`, { status: 'ready', data: { projectId: p.projectId, window: { from: at(FROM), to: at(TO), hours: 12 }, stats: { merged: 3, completed: 3, idleSlotMs: 0, slotMs: 1 }, pools: [], events, machine: [] }, fetchedAt: new Date().toISOString(), revision });
  return timeline.timelineView(p);
}
// The events track's boxes as drawn: [{ a, b, texts }] in px on a track trackPx wide.
function drawnEventBoxes(view, trackPx, phone) {
  const track = byClass(view, 'events').find(node => node.classList.includes('slot-track'));
  assert.ok(track, 'the Timeline has an events track');
  return [...byClass(track, 'tl-ev'), ...byClass(track, 'tl-ev-cluster')].map(node => {
    const centre = (parseFloat(node.style.left) / 100) * trackPx, texts = node.getAttribute('title').split('\n'), group = node.tag === 'details';
    const ref = group ? null : byClass(node, 'tl-ev-ref')[0]?.textContent ?? null;
    const width = group ? groupPx(texts.length, phone) : eventPx({ ref });
    return { a: centre - width / 2, b: centre + width / 2, texts, group };
  }).sort((p, q) => p.a - q.a);
}

for (const [viewport, trackPx] of [[390, 250], [320, 180]]) {
  test(`S1: at ${viewport} px the project Timeline's events are drawn as disjoint boxes, each event shown exactly once`, () => {
    globalThis.innerWidth = viewport;
    try {
      assert.equal(timeline.trackWidth(), trackPx, 'the track width the Timeline is first laid out for');
      const boxes = drawnEventBoxes(projectTimeline(), trackPx, true);
      assert.ok(boxes.some(box => box.group), 'the burst is grouped');
      const name = box => box.group ? `${box.texts.length} events close together` : box.texts[0];
      for (let i = 1; i < boxes.length; i++) {
        const overlap = boxes[i - 1].b - boxes[i].a;
        assert.ok(overlap <= EPS, `"${name(boxes[i - 1])}" overlaps "${name(boxes[i])}" by ${overlap.toFixed(1)} px`);
      }
      const lines = boxes.flatMap(box => box.texts);
      assert.equal(lines.length, TIMELINE_EVENTS.length, 'every event is drawn exactly once');
      for (const event of TIMELINE_EVENTS) assert.equal(lines.filter(line => line.includes(`${event.label} · `)).length, 1, `${event.label} is shown exactly once`);
    } finally { globalThis.innerWidth = 390; }
  });
}

test('S1: Timeline events with references of any length are laid out as disjoint boxes at phone and desktop widths', () => {
  const units = TIMELINE_EVENTS.map((e, i) => ({ key: `${i}:${e.label}`, at: ((Date.parse(e.at) - FROM) / (TO - FROM)) * 100, px: eventPx(e) }));
  for (const trackPx of [250, 210, 180, 140, 100]) checkBoxes(units, trackPx, timeline.TAP_PX);
  const desk = checkBoxes(units, 980, timeline.POINTER_PX);
  assert.deepEqual(desk.filter(box => box.units.length === 1).map(box => box.units[0].key), ['5:Long reference', '8:Second long reference', '9:Upgrade alone'], 'events with room keep their own marker on a desktop');
  for (const e of TIMELINE_EVENTS) assert.equal(timeline.timelineEventPx(e), eventPx(e), `${e.label}: the drawn width follows style.css`);
  let seed = 195; const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let round = 0; round < 500; round++) {
    const count = 1 + Math.floor(random() * 40), randomUnits = [];
    let cursor = random() * 3;
    for (let i = 0; i < count && cursor <= 100; i++) {
      randomUnits.push({ key: `t${i}`, at: cursor, px: 16 + (random() < 0.6 ? 3 + Math.floor(1 + random() * 6) * 8 : 0) });
      cursor += random() < 0.4 ? random() * 0.5 : random() < 0.7 ? random() * 8 : random() * 30;
    }
    checkBoxes(randomUnits, [72.5, 100, 140, 180, 250, 330, 980, 1020][round % 8], round % 3 ? timeline.TAP_PX : timeline.POINTER_PX);
  }
});

test('S1: the Timeline events track is laid out again for its measured width', () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe(node) { this.node = node; } disconnect() {} };
  globalThis.innerWidth = 1440;
  try {
    const view = projectTimeline(TIMELINE_EVENTS, 10);
    const track = byClass(view, 'events').find(node => node.classList.includes('slot-track')), layer = byClass(track, 'marker-layer')[0];
    const observer = observers.find(o => o.node === layer);
    assert.ok(observer, 'the events track watches its width');
    layer.isConnected = true;
    const wide = layer.children.length;
    observer.callback([{ contentRect: { width: 180 } }]);
    assert.ok(layer.children.length < wide, 'a narrow track groups more events');
    const boxes = drawnEventBoxes(view, 180, false);
    for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].a >= boxes[i - 1].b - EPS, 'the boxes laid out for 180 px do not overlap');
    assert.equal(boxes.flatMap(box => box.texts).length, TIMELINE_EVENTS.length);
  } finally { delete globalThis.ResizeObserver; globalThis.innerWidth = 390; }
});
