// Execution timeline drawn only from persisted timestamps. Open spans end at the observation time and say so.
import { h, chip, card, kv, empty, notice, time, duration, between, relative, short, raw, segmented, button, link, usd, strings, ms, tone, flowName, plural, localizeTimes, forgePull, forgeUrl, externalLink } from './dom.mjs';
import { state, href, available, read, readEntry, uiState, saveUi, patchRoute, detailHref, flowTitle } from './state.mjs';
import { commandForm } from './actions.mjs';
import { eventList, eventLabel, eventDetail, attemptStatus, attemptStatusLabel, attemptResultRows } from './records.mjs';
export { attemptStatus };
import { needsRecovery } from './operations.mjs';
import { withFlowLinks } from './admission.mjs';

const MARKERS = new Set(['flow.admitted', 'planning.admitted', 'flow.stopped', 'flow.resumed', 'flow.replan', 'inbox.opened', 'inbox.answered', 'inbox.expired', 'attempt.uncertain', 'attempt.reconciled', 'flow.finished', 'command.rejected']);
const ARTIFACTS = ['stdout.log', 'stderr.log', 'action-result.json', 'provider/result.json', 'provider/prompt.txt', 'provider/stdout.jsonl', 'provider/stderr.txt'];
// The flow detail read lists the files each attempt actually has (attempt.artifacts): only those are
// offered, so a fast check offers no provider logs. Without that list (an older project service),
// provider logs are offered only for model steps.
export const artifactNames = attempt => Array.isArray(attempt?.artifacts) ? ARTIFACTS.filter(name => attempt.artifacts.includes(name))
  : typeof attempt?.operation === 'string' && !attempt.operation.startsWith('provider.') ? ARTIFACTS.filter(name => !name.startsWith('provider/')) : ARTIFACTS;

const rerender = () => window.dispatchEvent(new Event('factotum:render'));

const NICE_STEPS = [50, 100, 200, 250, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5, 6048e5];
function niceStep(spanMs, target = 6) {
  return NICE_STEPS.find(s => spanMs / s <= target) ?? NICE_STEPS.at(-1);
}
// The width of a timeline track in CSS pixels, estimated from the viewport: reserved is the page
// width that is not track (sidebar or modal margins, lane labels, padding); zoom widens the track.
export const trackWidth = ({ viewport = globalThis.innerWidth || 1440, reserved = viewport <= 780 ? 140 : 460, zoom = 1 } = {}) => Math.max(160, (viewport - reserved) * zoom);
// The axis ticks and their labels: the finest nice step (at most six ticks) whose labels fit side by
// side on the track, so labels never print over each other at phone width (dev.93, Q4: "20:03:00" …
// "20:05:00" overlapped at 390 px). A label is judged at TICK_CHAR_PX per character plus a gap.
export const TICK_CHAR_PX = 8, TICK_GAP_PX = 16;
const flowTickLabel = (start, end) => { const showDate = end - start > 864e5 || new Date(start).toDateString() !== new Date(end).toDateString(); return (t, step) => time(new Date(t).toISOString(), { date: showDate && step >= 864e5, seconds: step < 6e4, fraction: step < 100 ? 2 : step < 1000 ? 1 : 0, zone: false }); };
export function axisTicks(start, end, { trackPx = trackWidth(), target = 6, label = flowTickLabel(start, end) } = {}) {
  const span = Math.max(1, end - start);
  const layout = step => {
    const ticks = []; for (let t = Math.ceil(start / step) * step; t <= end; t += step) ticks.push(t);
    const labels = ticks.map(t => label(t, step));
    const widest = Math.max(0, ...labels.map(label => label.length)) * TICK_CHAR_PX + TICK_GAP_PX;
    return { step, ticks: ticks.map((t, i) => ({ t, label: labels[i], left: ((t - start) / span) * 100 })), fits: ticks.length < 2 || (step / span) * trackPx >= widest };
  };
  // The first step whose labels fit; a coarser step with no tick in the span shows none, so a track
  // too narrow for two labels keeps one: the first tick of the finest step that has any.
  const first = NICE_STEPS.indexOf(niceStep(span, target));
  let last = null;
  for (const step of NICE_STEPS.slice(first)) { const chosen = layout(step); if (!chosen.ticks.length) break; if (chosen.fits) return chosen; last ??= chosen; }
  return last ? { ...last, ticks: last.ticks.slice(0, 1), fits: true } : layout(NICE_STEPS[first]);
}
// Draws a track's ticks for the width the track really has (review of e58abd1, P3): first for the
// width estimated from the viewport, then again whenever the track's laid-out width changes (its
// first layout, a resize, a zoom), so the labels fit in every container: the flow dialog, whose
// track is far narrower than the viewport suggests at phone width, and the project timeline.
// The observer lets go once the track has left the page. Without ResizeObserver (tests), the estimate stays.
export function fitTicks(track, estimatePx, draw) {
  draw(estimatePx);
  if (typeof globalThis.ResizeObserver !== 'function') return track;
  let drawn = estimatePx;
  const observer = new globalThis.ResizeObserver(([entry]) => {
    if (!track.isConnected) { observer.disconnect(); return; }
    const px = Math.round(entry.contentRect.width);
    if (px > 0 && px !== drawn) { drawn = px; draw(px); }
  });
  observer.observe(track);
  return track;
}
function axis(start, end, zoom = 1) {
  const startLabel = h('span', { class: 'muted small' }), track = h('div', { class: 'track' });
  fitTicks(track, trackWidth({ zoom }), px => {
    const { step, ticks } = axisTicks(start, end, { trackPx: px });
    startLabel.textContent = time(new Date(start).toISOString(), { date: true, seconds: step < 6e4 });
    track.replaceChildren(...ticks.map(tick => h('span', { class: 'tick', style: { left: `${tick.left}%` }, text: tick.label })));
  });
  return h('div', { class: 'gantt-row gantt-axis', 'aria-hidden': 'true' }, h('div', { class: 'lane-label' }, startLabel), track);
}
const pct = (t, start, end) => Math.max(0, Math.min(100, ((t - start) / (end - start)) * 100));
// A group of markers too close to tell apart: a disclosure whose summary shows the count, opening a
// list of every event (with a link when it has one). Keyboard and touch reach it; the tooltip only repeats it.
// items: [{ text, href? }]. The list opens toward the middle of the track, so it stays on screen.
// It behaves like a popover: Escape closes it and returns focus to its summary (without closing a
// detail modal it sits in), a click or tap outside it closes it, and so does any navigation (a
// change of address, including following a link in its list). A refresh keeps it as it was.
const openGroups = new Set();
// A group whose list is shown below its chart (dev.87, K2) fills or empties that panel as it opens or closes.
// Opening fills it once: the browser's toggle event, which comes after a group opened from script
// (a refresh restoring it), finds the panel already its own and leaves the entries, and the one
// that has focus, in place (review of 3e4fdda, P2).
function showBelow(group) {
  const panel = group.markerPanel;
  if (!panel) return;
  if (group.open && panel.markerOwner === group && panel.hidden === false) return;
  if (group.open) { panel.replaceChildren(h('p', { class: 'marker-group-panel-title', text: `${group.markerLabel}:` }), group.markerList()); panel.hidden = false; panel.markerOwner = group; }
  else if (panel.markerOwner === group) { panel.replaceChildren(); panel.hidden = true; panel.markerOwner = null; }
}
function closeGroup(group) { group.open = false; openGroups.delete(group); showBelow(group); }
export function closeMarkerGroups({ except = null } = {}) {
  for (const group of [...openGroups]) if (group !== except) closeGroup(group);
}
const summaryOf = group => group.querySelector ? group.querySelector(':scope > summary') : [...group.children].find(child => child.tagName === 'SUMMARY');
export function markerGroupKeydown(event) {
  const group = event.currentTarget;
  if (event.key !== 'Escape' || !group.open) return;
  event.preventDefault(); event.stopPropagation();
  closeGroup(group);
  summaryOf(group)?.focus();
}
// Escape inside a panel below the chart closes the group shown there and returns focus to it.
export function markerPanelKeydown(event) {
  const group = event.currentTarget.markerOwner;
  if (event.key !== 'Escape' || !group?.open) return;
  event.preventDefault(); event.stopPropagation();
  closeGroup(group);
  summaryOf(group)?.focus();
}
// Escape closes only the innermost open layer (dev.88, L6). An open group's list is the innermost
// layer of the window or page it is in, wherever focus is: on its summary, inside the panel below
// the chart, or on the window itself after a click on the list's text (the dev.87 re-test: focus
// left the panel, and the native dialog turned Escape into closing the whole flow window). So this
// runs on the document in the capture phase, before the dialog sees the key: it closes the list
// and returns focus to its summary, and the window stays open. The next Escape closes the window.
// A key pressed in another dialog, opened over the group's window, is that dialog's.
export function escapeInnermost(event) {
  if (event.key !== 'Escape' || event.defaultPrevented) return false;
  for (const stale of [...openGroups]) if (stale.isConnected === false) openGroups.delete(stale);
  const group = [...openGroups].at(-1);
  if (!group?.open) return false;
  const host = group.closest?.('dialog') ?? null, other = event.target?.closest?.('dialog') ?? null;
  if (other && other !== host) return false;
  event.preventDefault(); event.stopPropagation();
  closeGroup(group); summaryOf(group)?.focus();
  return true;
}
globalThis.document?.addEventListener?.('keydown', escapeInnermost, true);
const trackToggle = event => { const group = event.currentTarget; if (group.open) { closeMarkerGroups({ except: group }); openGroups.add(group); } else openGroups.delete(group); showBelow(group); };
// A group opened or closed from script (a refresh restoring it, a resize carrying it over, closeGroup)
// does at once what its toggle handler does: the browser fires the toggle event only later, after
// the refresh has looked for the entry that had focus (review of 3e4fdda, P2: focus fell to the
// page). Clicks and keys on the summary still go through the toggle event; doing it twice is harmless.
const NATIVE_OPEN = globalThis.HTMLDetailsElement ? Object.getOwnPropertyDescriptor(globalThis.HTMLDetailsElement.prototype, 'open') : null;
function openAtOnce(group) {
  let shadow = Boolean(group.open);
  Object.defineProperty(group, 'open', { configurable: true, enumerable: true,
    get() { return NATIVE_OPEN ? NATIVE_OPEN.get.call(this) : shadow; },
    set(value) { const was = Boolean(this.open); if (NATIVE_OPEN) NATIVE_OPEN.set.call(this, value); else shadow = Boolean(value); if (Boolean(this.open) !== was) trackToggle({ currentTarget: this }); } });
  return group;
}
// Installed once, when this module loads (before the console's own route handler, which imports it):
// a click outside every open group closes it, and a change of address closes them all first, so the
// page that is rebuilt for the new address does not reopen them. The click listener runs in the
// capture phase, before a control's own handler re-renders the page (a window or zoom choice), so
// the rebuilt page does not restore the group as open either.
export function outsideClick(event) { for (const group of [...openGroups]) if (!group.contains(event.target) && !group.markerPanel?.contains(event.target)) closeGroup(group); }
globalThis.document?.addEventListener?.('click', outsideClick, true);
globalThis.window?.addEventListener?.('hashchange', () => closeMarkerGroups());
// panel: inside a chart that scrolls (overflow: auto clips anything placed outside its box, so the
// flow's execution timeline cut the list off: dev.87, K2), the list is shown in that panel below
// the chart instead, in the page's own flow: never clipped, as wide as the card, readable on a phone.
let panelIds = 0;
export const markerPanel = (label = 'Events close together') => h('div', { class: 'marker-group-panel', id: `marker-group-panel-${++panelIds}`, role: 'region', 'aria-label': label, 'aria-live': 'polite', hidden: true, on: { keydown: markerPanelKeydown } });
// items: [{ text, href?, select?, dataset?, pressed? }]: a link, a button (select: what choosing it does,
// such as selecting an attempt), or plain text. span: { left, width } in percent draws the group over
// the bars it stands for (a group of bars too close to tap apart, dev.94 R1/R2) instead of at a point.
export function markerGroup(items, { cls, pct, panel = null, span = null, noun = 'events' }) {
  const label = `${items.length} ${noun} close together`;
  const entry = item => {
    const dataset = { ...(item.dataset ?? {}), focusKey: `marker-item:${cls ?? ''}:${item.text}` };
    if (item.select) return h('button', { type: 'button', class: 'link-button', 'aria-pressed': item.pressed === undefined ? undefined : String(item.pressed), dataset, on: { click: item.select } }, item.text);
    return item.href ? link(item.href, item.text, { dataset }) : item.text;
  };
  const list = () => h('ul', { class: 'marker-group-list', 'aria-label': label }, items.map(item => h('li', {}, entry(item))));
  const summary = h('summary', { 'aria-label': `${label}; show them${panel ? ` below the ${span ? 'track' : 'chart'}` : ''}`, ...(panel ? { 'aria-controls': panel.id || panel.getAttribute('id') } : {}), text: span ? null : String(items.length), dataset: { focusKey: `marker-group:${cls ?? ''}:${items[0]?.text ?? ''}` } },
    span ? h('span', { class: 'bar-group-count', text: String(items.length) }) : null);
  const group = h('details', { class: ['marker-group', span ? 'bar-group' : '', cls, panel ? 'lists-below' : pct > 67 ? 'opens-left' : pct >= 33 ? 'opens-center' : ''], style: span ? { left: `${span.left}%`, width: `${span.width}%` } : { left: `${pct}%` }, title: items.map(item => item.text).join('\n'), on: { keydown: markerGroupKeydown, toggle: trackToggle } },
    summary, panel ? null : list());
  if (panel) Object.assign(group, { markerPanel: panel, markerList: list, markerLabel: label });
  return openAtOnce(group);
}
// ---- Tap targets for bars (dev.94, R1, R2) ---------------------------------------------------------
// A bar is drawn at its true place and width, which on a phone can be a pixel or two (twelve hours
// on a 250 px track: a minute is a third of a pixel). Tapping one then reached whichever neighbour
// lay on top: the project Timeline opened another flow, and a flow's execution timeline could not
// select about a quarter of its attempts. So the bars are only drawn, and a separate layer of
// targets takes the taps, laid out for the track's real width in pixels: every target at least
// minPx wide (44 px on a phone or touch screen, 8 px with a mouse), no two overlapping, each
// containing the visible centre of every bar it stands for. Bars too close to get a target each
// share one: a group that opens a list naming each of them (as grouped markers do).
export const TAP_PX = 44, POINTER_PX = 8;
export const tapPx = () => { const query = globalThis.matchMedia?.('(max-width: 780px), (pointer: coarse)'); return (query ? query.matches : (globalThis.innerWidth || 1440) <= 780) ? TAP_PX : POINTER_PX; };
// units: [{ key, start, end }], start and end in percent of the track. Returns the targets left to
// right as [{ units, left, width }] in percent. A bar at least three targets wide that overlaps no
// other keeps its own extent as its target (a "wall"); the rest are widened to minPx about their
// centre, and those whose widened extents meet are grouped. A target beside a wall that has too
// little room between walls reaches into the wall by less than minPx, so the wall's centre stays its own.
export function tapTargets(units, trackPx, minPx = tapPx()) {
  const W = Math.max(1, trackPx), T = Math.min(minPx + 0.5, W); // half a pixel over, so rounding never leaves a target short
  const boxes = units.map(unit => { const x0 = Math.max(0, Math.min(W, (unit.start / 100) * W)); return { unit, x0, x1: Math.max(x0 + Math.min(unit.minPx ?? 0, W - x0), Math.min(W, (Math.max(unit.start, unit.end) / 100) * W)) }; }).sort((a, b) => a.x0 - b.x0 || a.x1 - b.x1);
  const overlaps = (p, q) => Math.min(p.x1, q.x1) - Math.max(p.x0, q.x0) > 1;
  const walls = boxes.filter(p => p.x1 - p.x0 >= 3 * T && !boxes.some(q => q !== p && overlaps(p, q))), rest = boxes.filter(p => !walls.includes(p));
  const clusters = [];
  for (const p of rest) {
    const w = Math.max(T, p.x1 - p.x0), a = Math.max(0, Math.min(W - w, (p.x0 + p.x1) / 2 - w / 2));
    clusters.push({ members: [p], a, b: a + w });
    while (clusters.length > 1 && clusters.at(-1).a < clusters.at(-2).b - 0.01) {
      const last = clusters.pop(), prev = clusters.at(-1);
      prev.members.push(...last.members); prev.a = Math.min(prev.a, last.a); prev.b = Math.max(prev.b, last.b);
    }
  }
  const targets = walls.map(p => ({ units: [p.unit], a: p.x0, b: p.x1, wide: true }));
  for (const k of clusters) {
    const lo = Math.min(...k.members.map(m => m.x0)), hi = Math.max(...k.members.map(m => m.x1));
    const left = Math.max(0, ...walls.filter(p => p.x1 <= lo + 1).map(p => p.x1)), right = Math.min(W, ...walls.filter(p => p.x0 >= hi - 1).map(p => p.x0));
    let a = Math.max(k.a, left), b = Math.min(k.b, right);
    if (b - a < T) {
      if (a > k.a && b < k.b) { const mid = (left + right) / 2; a = mid - T / 2; b = mid + T / 2; }
      else if (a > k.a) a = b - T; else b = a + T;
    }
    targets.push({ units: k.members.sort((p, q) => p.x0 - q.x0).map(m => m.unit), a, b, wide: false });
  }
  return targets.sort((p, q) => p.a - q.a).map(t => ({ units: t.units, wide: t.wide, left: (t.a / W) * 100, width: ((t.b - t.a) / W) * 100 }));
}
// The layer of targets over a track's drawn bars, laid out again whenever the track's width changes
// (as its ticks are). single(unit, target) and group(units, target) build a target's element.
// track names the kind of track: the width last measured for it is where a rebuilt page (the
// refresh every few seconds) starts, so the targets come out as they were and a group the operator
// opened is still there to be restored open. A group open when the width changes stays open as the
// new group that holds the same bars, or the first that holds one of them.
const measuredWidths = new Map();
// layout (tapTargets by default) and place (a moved target's left and width) let the event-marker lane
// share this: its boxes are laid out by markerBoxes and placed by their centre (dev.95, S1).
const placeTarget = (node, t) => { node.style.setProperty('left', `${t.left}%`); node.style.setProperty('width', `${t.width}%`); };
export function tapLayer(units, { track = '', estimatePx, single, group, layout = tapTargets, place = placeTarget, cls = 'tap-layer' }) {
  const layer = h('div', { class: cls });
  if (!units.length) return layer;
  let shape = null, nodes = [];
  fitTicks(layer, measuredWidths.get(track) ?? estimatePx, px => {
    if (shape !== null) measuredWidths.set(track, px);
    const targets = layout(units, px), keys = targets.map(t => t.units.map(u => u.key).join(',')), key = keys.join('|');
    if (key === shape) { targets.forEach((t, i) => place(nodes[i], t)); return; }
    const opened = nodes.find(node => node.open)?.tapKeys ?? null;
    for (const node of nodes) if (node.open) closeGroup(node);
    shape = key; nodes = targets.map((t, i) => Object.assign(t.units.length === 1 ? single(t.units[0], t) : group(t.units, t), { tapKeys: keys[i], tapGroup: t.units.length > 1 }));
    layer.replaceChildren(...nodes);
    if (opened) {
      const groups = nodes.filter(node => node.tapGroup), mine = opened.split(',');
      const next = groups.find(node => node.tapKeys === opened) ?? groups.find(node => node.tapKeys.split(',').some(k => mine.includes(k)));
      if (next) next.open = true;
    }
  });
  return layer;
}
// ---- Event markers in a flow's execution timeline (dev.95, S1) --------------------------------------
// Markers were grouped when they lay closer than a fixed 14 px, but a group is drawn as a count at
// least 44 px wide on a phone, centred on its first event: at 390 and 320 px the groups printed over
// each other and over single markers. So the lane is laid out from the boxes as drawn, for the
// track's real width: a single marker is a .7rem square turned 45 degrees (16 px across); a group is
// a count at least 1.4rem wide, at least as wide as a tap target (tapPx: 44 px on a phone or touch
// screen), wider with more digits. Neighbours are merged until no two boxes overlap or touch.
export const MARKER_PX = 16, MARKER_GROUP_PX = 23, MARKER_DIGIT_PX = 8, MARKER_PAD_PX = 12, MARKER_SPACE_PX = 2;
export const markerBoxPx = (count, minPx = tapPx()) => count === 1 ? MARKER_PX : Math.max(minPx, MARKER_GROUP_PX, String(count).length * MARKER_DIGIT_PX + MARKER_PAD_PX);
// units: [{ key, at, px? }], at in percent of the track, px the unit's drawn width alone (MARKER_PX if
// not given). Returns the boxes left to right as
// [{ units, centre, left, width }] in percent: a single marker stays at its time; a group is centred
// on the events it holds and kept inside the track. Every unit is in exactly one box, and each box
// ends at least MARKER_SPACE_PX before the next begins.
export function markerBoxes(units, trackPx, minPx = tapPx()) {
  const W = Math.max(1, trackPx), boxes = [];
  const place = (members, lo, hi) => {
    const w = members.length === 1 ? members[0].px ?? MARKER_PX : markerBoxPx(members.length, minPx), half = Math.min(w, W) / 2;
    const c = members.length === 1 ? lo : Math.max(half, Math.min(W - half, (lo + hi) / 2));
    return { members, lo, hi, w, a: c - w / 2, b: c + w / 2, c };
  };
  for (const unit of [...units].sort((p, q) => p.at - q.at)) {
    const x = Math.max(0, Math.min(W, (unit.at / 100) * W));
    boxes.push(place([unit], x, x));
    while (boxes.length > 1 && boxes.at(-1).a < boxes.at(-2).b + MARKER_SPACE_PX) {
      const last = boxes.pop(), prev = boxes.pop();
      boxes.push(place([...prev.members, ...last.members], prev.lo, last.hi));
    }
  }
  return boxes.map(box => ({ units: box.members, centre: (box.c / W) * 100, left: (box.a / W) * 100, width: (box.w / W) * 100 }));
}

/** Builds lane segments from attempts, waits and events. Returns untimed records separately. */
export function timelineModel(detail, { observedAt, stepOrder = [] }) {
  const flow = detail.flow, attempts = [...(detail.attempts ?? [])].sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0));
  const observed = ms(observedAt) ?? Date.now();
  const segments = [], untimed = [];
  for (const a of attempts) {
    const prepared = ms(a.createdAt), dispatched = ms(a.dispatchedAt), started = ms(a.receipt?.startedAt) ?? dispatched, ended = ms(a.receipt?.endedAt) ?? ms(a.settledAt);
    const settled = Boolean(a.settledAt);
    if (prepared === null) { untimed.push(a); continue; }
    const base = { lane: a.step, attempt: a, status: attemptStatus(a) };
    if (a.status === 'not-dispatched' || (started === null && !settled)) {
      const end = ms(a.settledAt) ?? observed;
      segments.push({ ...base, kind: 'prepared', start: prepared, end, open: !settled, label: a.status === 'not-dispatched' ? 'Prepared, never dispatched' : 'Prepared, awaiting dispatch' });
      continue;
    }
    if (started !== null && started > prepared) segments.push({ ...base, kind: 'prepared', start: prepared, end: started, label: 'Prepared before dispatch' });
    const runEnd = ended ?? (settled ? null : observed);
    if (started !== null && runEnd !== null) segments.push({ ...base, kind: 'run', start: started, end: Math.max(runEnd, started), open: ended === null && !settled, label: `${a.step} ${attemptStatusLabel(base.status)}` });
    else untimed.push(a);
  }
  for (const w of detail.waits ?? []) {
    const start = ms(w.startedAt); if (start === null) continue;
    const end = ms(w.endedAt);
    segments.push({ lane: w.kind === 'question' ? 'Decision wait' : w.kind === 'heavy-resource' ? 'Resource wait' : `${w.kind} wait`, wait: w, kind: 'wait', waitKind: w.kind, status: end === null ? 'waiting' : w.reason ?? 'ended', start, end: end ?? observed, open: end === null, label: `${w.kind} wait${w.reason ? ` · ${w.reason}` : ''}` });
  }
  const markers = (detail.events ?? []).filter(e => MARKERS.has(e.type) && ms(e.at) !== null).map(e => ({ at: ms(e.at), event: e }));
  const lanesFromAttempts = [...new Set(attempts.map(a => a.step))];
  const order = [...stepOrder.filter(s => lanesFromAttempts.includes(s)), ...lanesFromAttempts.filter(s => !stepOrder.includes(s))];
  const waitLanes = [...new Set(segments.filter(s => s.kind === 'wait').map(s => s.lane))];
  const points = [ms(flow.createdAt), ms(flow.finishedAt), ...segments.flatMap(s => [s.start, s.end]), ...markers.map(m => m.at)].filter(v => v !== null);
  const active = !['completed', 'failed'].includes(flow.state) && !flow.finishedAt;
  if (active) points.push(observed);
  let start = Math.min(...points), end = Math.max(...points);
  if (!Number.isFinite(start)) return { empty: true, untimed };
  if (end - start < 1000) end = start + 1000;
  const pad = (end - start) * 0.02;
  return { start: start - pad, end: end + pad, lanes: [...order, ...waitLanes], segments, markers, untimed, active, observed };
}

function barClass(segment) {
  if (segment.kind === 'wait') return `bar bar-wait wait-${segment.waitKind === 'question' ? 'question' : 'resource'}${segment.open ? ' open' : ''}`;
  if (segment.kind === 'prepared') return `bar bar-prepared${segment.open ? ' open' : ''}`;
  return `bar tone-${tone(segment.status)}${segment.open ? ' open' : ''}${segment.status === 'uncertain' ? ' hatched' : ''}`;
}
function segmentText(s) {
  const what = s.kind === 'wait' ? s.label : s.kind === 'prepared' ? `${s.lane}: ${s.label}` : `${s.lane} attempt ${short(s.attempt.id, 8)}: ${attemptStatusLabel(s.status)}`;
  return `${what}. From ${time(new Date(s.start).toISOString())} to ${s.open ? `at least ${time(new Date(s.end).toISOString())} (still open at observation)` : time(new Date(s.end).toISOString())}, ${duration(s.end - s.start)}.`;
}

function gantt(project, model, selectedAttempt, zoom) {
  const { start, end } = model;
  // Grouped events and grouped attempts open their list in a panel below the chart, outside its
  // scrolling box (dev.87, K2).
  const panel = markerPanel('Events or attempts close together');
  // Choosing an attempt replaces the address rather than adding to history: the attempt is a selection
  // inside the flow's window, so browser Back closes the window from any attempt (checklist B-07, D-04).
  const choose = id => () => patchRoute({ attempt: id }, { replace: true });
  const rows = model.lanes.map(lane => {
    const segs = model.segments.filter(s => s.lane === lane);
    const units = new Map();
    const bars = segs.map(s => {
      const left = pct(s.start, start, end), width = Math.max(0.35, pct(s.end, start, end) - left);
      const selected = Boolean(s.attempt && s.attempt.id === selectedAttempt);
      const attrs = { class: `${barClass(s)}${selected ? ' selected' : ''}`, style: { left: `${left}%`, width: `${width}%` } };
      if (!s.attempt) return h('span', { ...attrs, role: 'img', 'aria-label': segmentText(s), title: segmentText(s) }, width > 9 ? h('span', { class: 'bar-label', text: s.open ? `${s.waitKind ?? ''} open` : duration(s.end - s.start) }) : null);
      // An attempt's bars (prepared, then running) are drawn here and tapped through the layer above
      // them: one target per attempt, or a group of attempts too close to tap apart (dev.94, R2).
      const unit = units.get(s.attempt.id) ?? { key: s.attempt.id, start: left, end: left + width, minPx: 4, selected, kind: s.kind, text: segmentText(s) };
      unit.start = Math.min(unit.start, left); unit.end = Math.max(unit.end, left + width);
      if (s.kind === 'run') Object.assign(unit, { kind: s.kind, text: segmentText(s) });
      units.set(s.attempt.id, unit);
      return h('span', { ...attrs, 'aria-hidden': 'true', dataset: { attempt: s.attempt.id, kind: s.kind } }, width > 7 ? h('span', { class: 'bar-label', text: s.kind === 'prepared' ? 'prep' : `${attemptStatusLabel(s.status)} · ${duration(s.end - s.start)}` }) : null);
    });
    const at = t => ({ left: `${t.left}%`, width: `${t.width}%` });
    const layer = tapLayer([...units.values()], { track: `flow:${zoom}`, estimatePx: trackWidth({ zoom }),
      single: (u, t) => h('button', { type: 'button', class: ['bar-hit', 'tap-target', t.wide ? 'tap-wide' : '', u.selected ? 'selected' : ''], style: at(t), 'aria-label': u.text, title: u.text, 'aria-pressed': String(u.selected), dataset: { focusKey: `bar:${u.key}:${u.kind}`, attempt: u.key }, on: { click: choose(u.key) } }),
      group: (us, t) => markerGroup(us.map(u => ({ text: u.text, select: choose(u.key), pressed: u.selected, dataset: { attempt: u.key } })), { cls: 'bar-cluster tap-target', span: t, panel, noun: 'attempts' }) });
    return h('div', { class: 'gantt-row', role: 'listitem' },
      h('div', { class: 'lane-label' }, h('span', { text: lane }), units.size ? h('span', { class: 'muted small', text: ` ${units.size}×` }) : null),
      h('div', { class: 'track' }, bars, layer));
  });
  const markers = h('div', { class: 'gantt-row', role: 'listitem' }, h('div', { class: 'lane-label' }, h('span', { text: 'Events' })),
    h('div', { class: 'track markers' }, markerLane(model, panel, zoom)));
  const now = model.active ? h('div', { class: 'now-line', style: { left: `calc(var(--lane-width) + (100% - var(--lane-width)) * ${pct(model.observed, start, end) / 100})` }, 'aria-hidden': 'true' }, h('span', { text: 'observed' })) : null;
  const inner = h('div', { class: 'gantt-inner', style: { width: `${zoom * 100}%` } }, axis(start, end, zoom), h('div', { role: 'list', class: 'gantt-rows' }, rows, markers), now);
  return h('div', { class: 'gantt-block' }, h('div', { class: 'gantt-scroll', tabindex: '0', 'aria-label': 'Timeline chart; scroll horizontally when zoomed' }, inner), panel);
}

// The event-marker lane: boxes laid out for the track's width (markerBoxes), again whenever it changes.
function markerLane(model, panel, zoom) {
  const { start, end } = model, text = m => `${eventLabel(m.event.type)} · ${time(m.event.at)}${eventDetail(m.event) ? ` · ${eventDetail(m.event)}` : ''}`;
  const units = [...model.markers].sort((a, b) => a.at - b.at).map((m, i) => ({ key: `${i}:${m.event.type}:${m.at}`, at: pct(m.at, start, end), marker: m }));
  return tapLayer(units, { track: `flow-markers:${zoom}`, estimatePx: trackWidth({ zoom }), layout: markerBoxes, cls: 'marker-layer', place: (node, t) => node.style.setProperty('left', `${t.centre}%`),
    single: ({ marker: m }, t) => h('span', { class: `marker ev-${m.event.type.replace(/\./g, '-')}`, role: 'img', style: { left: `${t.centre}%` }, 'aria-label': `${eventLabel(m.event.type)} at ${time(m.event.at)}`, title: text(m) }),
    group: (us, t) => markerGroup(us.map(u => ({ text: text(u.marker) })), { cls: 'marker-cluster', pct: t.centre, panel }) });
}

function legend() {
  const item = (cls, label) => h('li', {}, h('span', { class: `swatch ${cls}`, 'aria-hidden': 'true' }), label);
  return h('ul', { class: 'legend', 'aria-label': 'Legend' }, item('tone-good', 'Passed / completed'), item('tone-bad', 'Failed'), item('tone-info', 'Running'), item('tone-warn hatched', 'Uncertain / stopped'), item('bar-prepared', 'Prepared, not yet running'), item('wait-question', 'Waiting for a decision'), item('wait-resource', 'Waiting for a shared resource'), item('open-sample', 'Open at observation'), item('marker-sample', 'Recorded event'));
}

function segmentTable(model) {
  const rows = [...model.segments].sort((a, b) => a.start - b.start);
  return h('details', { class: 'timeline-table' }, h('summary', { text: `Timeline as a table (${rows.length} spans, ${model.markers.length} events)` }),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Lane', 'What', 'Start', 'End', 'Duration', 'Status'].map(l => h('th', { scope: 'col', text: l })))),
      h('tbody', {}, rows.map(s => h('tr', {}, h('th', { scope: 'row', text: s.lane }), h('td', { text: s.kind === 'run' ? `Attempt ${short(s.attempt.id, 8)}` : s.label }), h('td', { text: time(new Date(s.start).toISOString()) }), h('td', { text: s.open ? 'open (observation time shown)' : time(new Date(s.end).toISOString()) }), h('td', { text: `${s.open ? '≥ ' : ''}${duration(s.end - s.start)}` }), h('td', {}, chip(s.status, attemptStatusLabel(s.status)))))))),
    model.untimed.length ? h('p', { class: 'muted small', text: `${model.untimed.length} attempt(s) lack persisted timing and are listed only in the attempt list.` }) : null);
}

function artifactViewer(project, attempt) {
  const ui = uiState('artifact', { name: 'stdout.log' }), names = artifactNames(attempt);
  if (!names.length) return h('div', { class: 'artifact-viewer' }, h('p', { class: 'muted', text: attempt.settledAt ? 'This attempt wrote no evidence files.' : 'No evidence files yet; use Reload evidence once the attempt has written them.' }));
  if (!names.includes(ui.name)) ui.name = names[0];
  const entry = read(project, 'artifacts', attempt.id, { name: ui.name }, { onDone: rerender });
  const body = entry.status === 'loading' && !entry.data ? h('p', { class: 'muted', text: 'Loading evidence from the project…' })
    : entry.status === 'error' ? h('p', { class: 'muted', text: /not available/.test(entry.error) ? `${ui.name} is not available for this attempt.` : entry.error })
      : entry.data.available === false ? h('p', { class: 'muted', text: `${ui.name} was not written for this attempt.` })
      : h('div', {}, h('pre', { class: 'code log', tabindex: '0', 'aria-label': `${ui.name} contents`, text: entry.data.text || '(empty)' }), entry.data.truncated ? notice('info', 'Preview truncated.', 'Inspect the complete private artifact with the project CLI.') : null, h('p', { class: 'muted small', text: `Read ${relative(entry.fetchedAt)}; untrusted text, never executed.` }));
  return h('div', { class: 'artifact-viewer' }, h('div', { class: 'toolbar' }, segmented(names.map(n => [n, n]), ui.name, name => { ui.name = name; saveUi(); rerender(); }, 'Evidence file'), button('Reload', () => { read(project, 'artifacts', attempt.id, { name: ui.name }, { force: true, onDone: rerender }); rerender(); }, { variant: 'ghost', class: 'btn btn-ghost btn-small' })), body);
}

// Bounded diagnostics the check runner kept for one check (workflows/check-diagnostics.mjs).
function diagnosticsView(d) {
  if (!d || typeof d !== 'object') return null;
  const parts = [['Diagnostics', d.detail], ['Standard error', d.stderr], ['Standard output', d.stdout], ['Error', d.error]].filter(([, value]) => typeof value === 'string' && value);
  return h('div', { class: 'stack' }, parts.map(([label, value], index) => h('details', { open: index === 0 }, h('summary', { text: label }), h('pre', { class: 'code log', tabindex: '0', text: value }))),
    d.unavailable ? h('p', { class: 'muted small', text: `No designated diagnostics file: ${d.unavailable}.` }) : null,
    d.truncated ? h('p', { class: 'muted small', text: 'Excerpts are truncated; the complete output is in the check’s artifact.' }) : null);
}
// A failed trusted command: how it ended and the last lines of its output, recorded at settlement.
export function commandFailureView(attempt) {
  const f = attempt?.failure;
  if (!f || typeof f !== 'object') return null;
  return h('div', { class: 'stack command-failure' }, h('h4', { text: 'Why the command failed' }), h('p', { text: `${String(f.summary ?? 'The command failed')}.` }),
    diagnosticsView({ stderr: f.stderr, stdout: f.stdout }),
    h('p', { class: 'muted small', text: f.stderr || f.stdout ? 'The last lines of each log, with control sequences and credential-like text removed; the complete logs are below.' : 'The command wrote no output.' }));
}
// The checks a failed fast-check or gate attempt reported, with the rules each owns and its diagnostics.
export function failedChecksView(project, attempt) {
  if (attemptStatus(attempt) !== 'failed' || attempt.status !== 'passed') return null;
  const rows = (attempt.checks ?? []).filter(c => c.status !== 'passed'), listed = rows.length ? rows : attempt.failedChecks ?? [];
  const rules = id => (project.snapshot?.settings?.fastChecks?.checks ?? []).filter(c => c.id === id).flatMap(c => c.rules ?? []);
  return h('div', { class: 'stack failed-checks' }, h('h4', { text: 'Failed checks' }),
    h('p', { class: 'help', text: 'The step ran to completion and reported a failure, so the flow followed its fail route (a failed fast check returns the work to the builder). The process exit code is that of the step runner, not of the check.' }),
    listed.length ? h('ul', { class: 'plain-list' }, listed.map(c => h('li', { class: 'stack' },
      h('p', {}, chip('failed', c.id), ` ${c.status}${c.failureClass ? ` · ${c.failureClass} failure` : ''}${Number.isInteger(c.exitCode) ? ` · exit ${c.exitCode}` : ''}`),
      rules(c.id).length ? h('div', {}, h('p', { class: 'muted small', text: 'Rules this check enforces:' }), strings(rules(c.id))) : null,
      diagnosticsView(c.diagnostics)))) : h('p', { class: 'muted', text: 'No check list was recorded; open action-result.json below for the step’s result.' }));
}

// A main verification's checks (dev.86, J4), from the rows the verification recorded
// (mainHealth.checks; the attempt read projects them as mainVerification with each check's
// timeoutMs from the configuration the attempt ran with): each check's result, how long it ran and
// its limit, and the checks the step's time ran out for ("not run"). A project service that sends
// no per-check limit leaves the limit to Settings' current configuration, said to be current.
export function mainVerificationView(project, attempt) {
  const v = attempt?.mainVerification;
  if (!v || !Array.isArray(v.checks)) return null;
  const current = id => (project?.snapshot?.settings?.mainChecks ?? []).find(c => c?.id === id)?.timeoutMs;
  const own = c => Number.isFinite(c.checkTimeoutMs) ? `limit ${duration(c.checkTimeoutMs)}` : Number.isFinite(current(c.id)) ? `limit ${duration(current(c.id))} (current configuration)` : 'limit not recorded';
  const limit = c => !c.timedOut || !Number.isFinite(c.timeoutMs) ? own(c)
    : c.limitSource === 'verification' ? `stopped after ${duration(c.timeoutMs)}, the time left in the step${Number.isFinite(c.checkTimeoutMs) ? ` (its own limit ${duration(c.checkTimeoutMs)})` : ''}`
      : `timed out at its limit of ${duration(c.timeoutMs)}`;
  const ran = c => { const d = between(c.startedAt, c.endedAt); return d === null ? 'run time not recorded' : `ran ${duration(d)}`; };
  const rows = v.checks.map(c => h('li', {}, chip(c.timedOut ? 'failed' : c.status, c.timedOut ? 'timed out' : c.status),
    ` ${c.id}${c.tier === 'scheduled' ? ' · scheduled tier' : ''} · ${ran(c)} · ${limit(c)}${Number.isInteger(c.exitCode) && c.status !== 'passed' ? ` · exit ${c.exitCode}` : ''}${c.attempts > 1 ? ` · ${c.attempts} runs` : ''}${c.flaked ? ' · recovered registered flake' : ''}${c.reused ? ' · reused exact evidence' : ''}`));
  const notRun = (v.notRun ?? []).map(row => typeof row === 'string' ? { id: row } : row).map(c => h('li', {}, chip('none', 'not run'), ` ${c.id} · did not start: the step’s time was used up · ${own(c)}`));
  return h('div', { class: 'stack main-checks' }, h('h4', { text: 'Main checks' }),
    rows.length || notRun.length ? h('ul', { class: 'plain-list' }, rows, notRun) : h('p', { class: 'muted', text: 'No check ran.' }),
    Number.isFinite(v.stepTimeoutMs) ? h('p', { class: 'muted small', text: `This main.verify step could run ${duration(v.stepTimeoutMs)} in all.` }) : null);
}

function attemptPanel(project, detail, attempt) {
  const result = detail.flow.results?.[attempt.step];
  const latestForStep = [...detail.attempts].filter(a => a.step === attempt.step).sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0))[0]?.id === attempt.id;
  return card(`Attempt ${short(attempt.id, 10)} · ${attempt.step}`, h('div', { class: 'stack' },
    kv([...attemptResultRows(attempt), ['Operation', attempt.operation ?? undefined], ['Prepared', time(attempt.createdAt)], ['Dispatched', attempt.dispatchedAt ? time(attempt.dispatchedAt) : 'Not dispatched'], ['Process started', attempt.receipt?.startedAt ? time(attempt.receipt.startedAt) : '—'], ['Process ended', attempt.receipt?.endedAt ? time(attempt.receipt.endedAt) : '—'], ['Run time', duration(between(attempt.receipt?.startedAt, attempt.receipt?.endedAt))], ['Settled', attempt.settledAt ? time(attempt.settledAt) : 'Not settled'], ['Reason', attempt.reason ?? attempt.receipt?.reason ?? undefined], ['Recorded cost', Number.isSafeInteger(attempt.costMicros) ? usd(attempt.costMicros) : 'Not settled (unknown)'], ['Output digests', attempt.receipt?.stdoutDigest ? `stdout ${short(attempt.receipt.stdoutDigest, 10)} · stderr ${short(attempt.receipt.stderrDigest, 10)}` : undefined]]),
    // A main verification lists every check (passed, failed, timed out, not run) instead of only the failed ones.
    attempt.mainVerification ? mainVerificationView(project, attempt) : failedChecksView(project, attempt), commandFailureView(attempt),
    attempt.status === 'uncertain' ? notice('error', 'Outcome uncertain.', 'The project could not establish settlement. Inspect evidence, then reconcile with the project CLI (reconcile, or command --operation attempt.resolve). The console never retries it.') : null,
    result && latestForStep ? h('div', {}, h('h4', { text: 'Recorded step result' }), kv([['Route', result.route ?? '—'], ['Provider', result.provider ? `${result.provider}${result.model ? ` · ${result.model}` : ''}` : undefined], ['Summary', result.result?.summary ?? result.summary ?? undefined], ['Findings', Array.isArray(result.result?.findings) ? strings(result.result.findings.map(f => `${f.severity ?? ''} ${f.file ?? ''}:${f.line ?? ''} ${f.message ?? ''}`.trim()), 'No findings') : undefined]])) : null,
    h('h4', { text: 'Evidence and logs' }), artifactViewer(project, attempt), raw('Raw attempt record', attempt)), { cls: 'attempt-panel', id: 'attempt-panel' });
}

// The commit the flow's decisions are about: the head its gate and review evidence were minted
// for, else the head it published or adopted. Not the workspace's starting point.
export function candidateCommit(f) {
  const sha = value => typeof value === 'string' && /^[a-f\d]{40,64}$/i.test(value) ? value : null;
  const evidence = f?.evidence ?? {}, results = f?.results ?? {};
  const head = sha(evidence.gate?.head) ?? sha(evidence.review?.head), published = sha(results.publish?.head), adopted = sha(f?.candidate?.head);
  if (head) return { head, basis: evidence.gate?.head && evidence.review?.head ? 'gated and reviewed' : evidence.gate?.head ? 'gated' : 'reviewed' };
  if (published) return { head: published, basis: 'published' };
  if (adopted) return { head: adopted, basis: 'adopted' };
  return null;
}

// The flow's place in the flow slots, as the project derives it (operations/capacity.mjs, flowSlot):
// the flow detail read carries it. A project service without it still lists parked and waiting
// flows in its queue status, which is looked up here, not recomputed; otherwise nothing is shown.
export function flowSlotState(project, detail) {
  if (detail?.capacity !== undefined) return detail.capacity;
  const c = project?.snapshot?.queueStatus?.capacity, flowId = detail?.flow?.id;
  if (!c || !flowId) return null;
  const parked = (c.parked ?? []).find(row => row.flowId === flowId);
  if (parked) return { flowId, pool: parked.pool ?? 'change', state: parked.holdsSlot ? 'parked-holding' : 'parked', holdsSlot: Boolean(parked.holdsSlot), since: parked.since ?? null, maxParkedFlows: c.maxParkedFlows };
  const waiting = (c.waiting ?? []).find(row => row.flowId === flowId);
  if (waiting) return { flowId, pool: waiting.pool ?? 'change', state: (c.categoryWaits ?? []).some(row => row.flowId === flowId) ? 'category' : 'waiting', holdsSlot: false, position: waiting.position, of: waiting.of, category: waiting.category ?? null, reason: waiting.reason };
  return null;
}
const SLOT_STATES = {
  working: ['active', 'Working', 'holds a slot'],
  parked: ['waiting', 'Parked on an answer', 'holds no slot'],
  'parked-holding': ['hold', 'Parked on an answer', 'holds a slot'],
  waiting: ['waiting', 'Answered, waiting for a slot', 'holds no slot'],
  category: ['waiting', 'Answered, waiting on its category', 'holds no slot'],
  stopped: ['stopped', 'Stopped', 'holds a slot'],
};
export function flowSlotNode(slot, project = null) {
  const known = slot && SLOT_STATES[slot.state];
  if (!known) return undefined;
  const [tone, label, holds] = known, pool = slot.pool === 'document' ? 'document flow slot' : 'change flow slot', inUse = Number.isFinite(slot.inUse) && Number.isFinite(slot.max) ? ` (${slot.inUse} of ${slot.max} in use)` : '';
  const detail = {
    working: `It holds a ${pool}${inUse} until it finishes, parks on a question or is stopped.`,
    parked: `It waits for an answer and holds no ${pool}: it is within the parked limit${Number.isFinite(slot.maxParkedFlows) ? ` (${slot.maxParkedFlows}, policy.maxParkedFlows)` : ''}. Once answered it takes the next free slot.`,
    'parked-holding': `It waits for an answer beyond the parked limit${Number.isFinite(slot.maxParkedFlows) ? ` (${slot.maxParkedFlows}, policy.maxParkedFlows)` : ''}, so it keeps its ${pool}${inUse} until it is answered.`,
    waiting: `Position ${slot.position} of ${slot.of} for a ${pool}${slot.merge ? ' (a merge, so ahead of other waiting flows)' : ''}. It continues by itself, ahead of queued tasks.`,
    category: `It waits for a place in category ${slot.category ?? 'its category'}${Number.isFinite(slot.categoryInUse) && Number.isFinite(slot.categoryMax) ? ` (${slot.categoryInUse} of ${slot.categoryMax} in use, policy.categoryLimits)` : ''}${Number.isFinite(slot.position) ? `; position ${slot.position} of ${slot.of} in line` : ''}. It continues by itself when a place frees.`,
    stopped: `It keeps its ${pool}${inUse} until it is resumed, abandoned or its task is started again.`,
  }[slot.state];
  // A flow waiting for a slot has the project's own reason, with its place in line and what holds the slots.
  const why = slot.reason && ['waiting', 'category'].includes(slot.state) ? withFlowLinks(project, slot.reason) : detail;
  return h('div', { class: 'flow-slot' }, h('p', {}, chip(tone, label), ' ', h('strong', { text: holds })), h('p', { class: 'muted small' }, why));
}

function flowSummary(project, detail) {
  const f = detail.flow, candidate = candidateCommit(f), pr = f.results?.publish;
  const results = Object.entries(f.results ?? {}).filter(([, v]) => v);
  return h('div', { class: 'stack' },
    kv([['State', chip(f.outcome ?? f.state)], ['Flow slot', flowSlotNode(flowSlotState(project, detail), project)], ['Current step', f.step], ['Kind', `${f.kind}${f.mode ? ` · ${f.mode}` : ''}`], ['Task', `${f.taskSnapshot?.title ?? f.taskId} (${f.taskId})`], ['Admitted', time(f.createdAt)], ['Finished', f.finishedAt ? time(f.finishedAt) : 'Not finished'], ['Elapsed', f.finishedAt ? duration(between(f.createdAt, f.finishedAt)) : `${duration(between(f.createdAt, project.observedAt))} as of observation`], ['Transitions', String(f.transitions ?? 0)], // A stop reason describes the current stop only; earlier stops stay in Flow events.
    ['Stop reason', f.state === 'stopped' ? localizeTimes(f.stopReason ?? 'Stopped') : undefined],
    ['Workspace branch', f.workspace ? f.workspace.branch ?? '—' : undefined], ['Created from', f.workspace && (f.workspace.base ?? f.workspace.head) ? `${short(f.workspace.base ?? f.workspace.head, 10)} (target head when the workspace was made)` : undefined],
    ['Candidate commit', candidate ? h('span', {}, h('code', { text: candidate.head.slice(0, 12) }), h('span', { class: 'muted small', text: ` ${candidate.basis}` })) : undefined],
    ['Pull request', pr?.url || pr?.number ? externalLink(forgePull(project.snapshot.settings?.repository, pr.number) ?? forgeUrl(project.snapshot.settings?.repository, pr.url), pr.number ? `#${pr.number} on the forge` : 'On the forge') : undefined],
    ['Adopted pull request', f.candidate ? `#${f.candidate.number} · head ${short(f.candidate.head, 10)}` : undefined]]),
    Object.keys(f.evidence ?? {}).length ? h('div', {}, h('h4', { text: 'Fresh evidence used for decisions' }), h('ul', { class: 'bullets' }, Object.entries(f.evidence).map(([tag, e]) => h('li', { text: `${tag}: attempt ${short(e.attemptId, 8)} · tree ${short(e.treeDigest, 10)}${e.provider ? ` · ${e.provider}/${e.model}` : ''}` })))) : null,
    results.length ? h('details', {}, h('summary', { text: `Step results (${results.length})` }), h('ul', { class: 'bullets' }, results.map(([step, r]) => h('li', { text: `${step}: ${r.route ?? (r.merged ? 'merged' : 'recorded')}${r.result?.summary || r.summary ? ` — ${r.result?.summary ?? r.summary}` : ''}` })))) : null,
    f.modelSelection && Object.keys(f.modelSelection.steps).length ? h('details', {}, h('summary', { text: 'Models pinned for this flow' }), h('p', { class: 'help', text: 'Chosen at admission. Later default changes do not affect these routes. Attempt results record the model actually used, including any fallback.' }), h('ul', { class: 'bullets' }, Object.entries(f.modelSelection.steps).map(([step, row]) => h('li', { text: `${step}: ${row.provider} / ${row.model} · ${row.effort ?? 'provider default'} effort · ${row.source === 'run' ? 'run override' : row.source === 'task' ? 'task choice' : row.source === 'live' ? 'saved default' : row.source === 'step' ? 'project config' : 'role default'}` })))) : null,
    raw('Raw flow record (pinned authority)', f));
}

// Why Resume is not offered while the stopped flow still owns an attempt: a running attempt is
// finishing (not a fault); an uncertain one needs reconciliation.
export function resumeBlockers(f, attempts = []) {
  if (!f.attemptId) return [];
  const a = attempts.find(row => row.id === f.attemptId);
  if (a?.status === 'uncertain') return ['The current attempt is uncertain and needs reconciliation first (project CLI: reconcile, or command --operation attempt.resolve).'];
  if (a && !a.settledAt) return ['The attempt that was running when the flow stopped is still finishing. Resume becomes available once it settles; use Reload evidence to check.'];
  return ['The flow still records its last attempt; reload evidence, then resume once it is released.'];
}
function flowActions(project, f, attempts = []) {
  const forms = [];
  if (['completed', 'failed'].includes(f.state)) {
    if (f.results?.merge?.merged) forms.push(commandForm(project, { key: `regression:${f.id}`, title: 'Report a regression', operation: 'regression.record', subject: { label: `merged ${flowName(f)}`, version: f.results.merge.mergeCommit ?? f.results.merge.sha ?? 'merged' }, fields: [{ name: 'reason', label: 'Observed regression', type: 'textarea' }, { name: 'evidence', label: 'Evidence (reproduction, check, report)' }], payload: v => ({ flowId: f.id, reason: v.reason, evidence: v.evidence }), intro: 'Records an operator report linked to this merge. It does not infer cause.', variant: 'secondary' }));
    return forms.length ? h('div', { class: 'stack' }, forms) : h('p', { class: 'muted', text: 'Finished flows accept no control actions.' });
  }
  if (f.state === 'stopped') forms.push(commandForm(project, { key: `resume:${f.id}`, title: 'Resume flow', operation: 'resume', subject: { label: flowName(f), version: `${f.state}:${f.step}:${f.attemptId ?? ''}` }, fields: [{ name: 'note', label: 'Resume note' }], payload: v => ({ flowId: f.id, note: v.note }), reasons: resumeBlockers(f, attempts), intro: 'The project re-checks task approval, workflow, configuration and executor before resuming.' }));
  else forms.push(commandForm(project, { key: `stop:${f.id}`, title: 'Stop flow', operation: 'stop', subject: { label: flowName(f), version: `${f.state}:${f.step}` }, fields: [{ name: 'note', label: 'Stop note' }], payload: v => ({ flowId: f.id, note: v.note }), variant: 'danger', intro: 'Stopping supersedes open questions. A running attempt finishes or is reconciled; it is never silently retried.' }));
  forms.push(commandForm(project, { key: `note:${f.id}`, title: 'Add a note for the agents', operation: 'flow.note', subject: { label: flowName(f), version: `${f.state}:${f.step}` }, fields: [{ name: 'note', label: 'Note', type: 'textarea', rows: 3 }], payload: v => ({ flowId: f.id, note: v.note }), intro: 'The planner, builder and reviewer see it from their next step, like a note on an answer.', variant: 'secondary' }));
  if (f.mode === 'delivery' && f.kind === 'change' && !f.results?.merge?.merged) forms.push(commandForm(project, { key: `replan:${f.id}`, title: 'Replan from the plan step', operation: 'flow.replan', subject: { label: flowName(f), version: `${f.state}:${f.step}` }, fields: [{ name: 'note', label: 'Replan note' }], payload: v => ({ flowId: f.id, note: v.note }), reasons: f.attemptId ? ['Resolve the current attempt first.'] : [], variant: 'secondary', intro: 'Clears plan and review results and evidence; requires matching approval.' }));
  return h('div', { class: 'stack' }, forms);
}

function retrospective(r) {
  if (!r) return null;
  return card('Retrospective', h('div', { class: 'stack' },
    kv([['Recorded', r.recordedAt ? time(r.recordedAt) : undefined], ['Outcome', chip(r.state)], ['Retry rounds', String(r.retryRounds ?? 0)], ['Answered questions', String(r.intervention?.answeredQuestions ?? 0)], ['Stops / resumes', `${r.intervention?.stops ?? 0} / ${r.intervention?.resumes ?? 0}`], ['Configured gate passed', r.acceptance ? (r.acceptance.configuredGatePassed ? 'Yes' : 'No') : undefined], ['Criteria not verified by gate', r.acceptance ? strings(r.acceptance.unverifiedCriteria, 'None') : undefined], ['Recorded cost', r.cost ? `${usd(r.cost.actualMicros)}${r.cost.unknownAttempts ? ` · ${r.cost.unknownAttempts} unsettled` : ''}` : undefined]]),
    r.phases ? h('table', { class: 'data compact' }, h('thead', {}, h('tr', {}, ['Step', 'Samples', 'Total', 'Mean'].map(l => h('th', { scope: 'col', text: l })))), h('tbody', {}, Object.entries(r.phases).map(([step, p]) => h('tr', {}, h('th', { scope: 'row', text: step }), h('td', { text: p.count }), h('td', { text: duration(p.totalMs) }), h('td', { text: duration(p.meanMs) }))))) : null,
    r.limitations ? h('div', {}, h('h4', { text: 'Limitations' }), strings(r.limitations)) : null, raw('Raw retrospective', r)));
}

// ---- Project timeline: slots, events and machine ------------------------------------------------
export const CATEGORIES = [['building', 'building'], ['planning', 'planning'], ['review', 'review'], ['checks', 'checks'], ['waiting-machine', 'waiting for the machine slot'], ['waiting-operator', 'waiting on the operator'], ['waiting-orchestrator', 'waiting on the orchestrator'], ['waiting', 'waiting'], ['stopped', 'stopped'], ['other', 'other steps']];
const categoryLabel = key => CATEGORIES.find(([k]) => k === key)?.[1] ?? key;
const EVENT_KINDS = { merged: ['◆', 'merged'], failed: ['✕', 'failed'], stopped: ['×', 'stopped'], 'question-operator': ['?', 'question for the operator'], 'question-orchestrator': ['?', 'question for the orchestrator'], upgrade: ['▲', 'upgrade activated'], config: ['▽', 'configuration updated'] };
const WINDOWS = [['6', '6 h'], ['12', '12 h'], ['24', '24 h'], ['72', '3 d']];
const svg = (tag, attrs, ...children) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v)); for (const child of children.flat()) if (child) node.append(child); return node; };
const gb = bytes => `${(bytes / 1073741824).toFixed(bytes >= 10 * 1073741824 ? 0 : 1)} GB`;

function slotAxis(from, to) {
  // As the flow axis (dev.93, Q4): as many ticks as fit side by side at this width, at most seven.
  const label = (t, step) => time(new Date(t).toISOString(), { date: to - from > 864e5 && step >= 864e5, seconds: false, zone: false });
  const axisNode = h('div', { class: 'slot-axis', 'aria-hidden': 'true' });
  return fitTicks(axisNode, trackWidth(), px => {
    axisNode.replaceChildren(...axisTicks(from, to, { trackPx: px, target: 7, label }).ticks.map(tick => h('span', { class: 'slot-tick', style: { left: `${pct(tick.t, from, to)}%` }, text: tick.label })));
  });
}
// A slot's flows: each drawn as a bar, and opened through the layer of tap targets above the bars
// (dev.94, R1: at 390 px a tap on one flow's bar opened its neighbour). Flows too close to tap apart
// share a target that lists them in a panel below the track.
function slotLane(project, lane, label, from, to) {
  const now = lane.current ? h('span', {}, ' · now: ', link(detailHref({ flow: lane.current.flowId }), lane.current.title), h('span', { class: 'muted', text: ` (${categoryLabel(lane.current.category)})` })) : h('span', { class: 'muted', text: ' · idle now' });
  const name = `${label} ${lane.index}`, panel = markerPanel(`${name}: flows close together`), units = [];
  const bars = lane.flows.map(f => {
    const left = pct(ms(f.start), from, to), width = Math.max(0.3, pct(ms(f.end), from, to) - left);
    const text = `${f.title}: ${f.state}, ${time(f.start, { seconds: false })} to ${f.open ? 'now' : time(f.end, { seconds: false })}`;
    const steps = (f.segments ?? []).map(seg => `${seg.step ?? categoryLabel(seg.category)}: ${time(seg.start, { seconds: false })}–${time(seg.end, { seconds: false })}`);
    units.push({ key: f.id, start: left, end: left + width, text, title: [text, ...steps].join('\n') });
    return h('span', { class: ['slot-flow', f.open ? 'open' : ''], 'aria-hidden': 'true', dataset: { flow: f.id }, style: { left: `${left}%`, width: `${width}%` } },
      (f.segments ?? []).map(seg => { const a = pct(ms(seg.start), from, to), b = pct(ms(seg.end), from, to); return h('span', { class: `seg seg-${seg.category}`, style: { left: `${((a - left) / width) * 100}%`, width: `${Math.max(0.15, ((b - a) / width) * 100)}%` } }); }));
  });
  const at = t => ({ left: `${t.left}%`, width: `${t.width}%` });
  const layer = tapLayer(units, { track: 'slots', estimatePx: trackWidth(),
    single: (u, t) => h('a', { class: ['slot-hit', 'tap-target', t.wide ? 'tap-wide' : ''], href: detailHref({ flow: u.key }), title: u.title, 'aria-label': u.text, dataset: { flow: u.key, focusKey: `slot-flow:${u.key}` }, style: at(t) }),
    group: (us, t) => markerGroup(us.map(u => ({ text: u.text, href: detailHref({ flow: u.key }), dataset: { flow: u.key } })), { cls: 'slot-cluster tap-target', span: t, panel, noun: 'flows' }) });
  return h('div', { class: 'slot-lane' }, h('div', { class: 'slot-label' }, h('span', { text: name }), now),
    h('div', { class: 'slot-track', role: 'group', 'aria-label': name }, bars, layer), panel);
}
// The drawn width of a project Timeline event alone (style.css, .tl-ev): its glyph, and its short
// reference after a small gap, judged at TL_EV_CHAR_PX per character.
export const TL_EV_GLYPH_PX = 16, TL_EV_GAP_PX = 3, TL_EV_CHAR_PX = 8;
export const timelineEventPx = event => TL_EV_GLYPH_PX + (event.ref ? TL_EV_GAP_PX + String(event.ref).length * TL_EV_CHAR_PX : 0);
function eventTrack(project, events, from, to) {
  // Events whose drawn boxes would overlap at the track's width are drawn as one counted marker
  // (markerBoxes, as in a flow's execution timeline: dev.95, S1), listed one by one in its list and
  // tooltip; each stays a separate link in the flows it belongs to.
  const units = events.filter(e => ms(e.at) !== null).sort((a, b) => ms(a.at) - ms(b.at)).map((e, i) => ({ key: `${i}:${e.type}:${e.at}`, at: pct(ms(e.at), from, to), px: timelineEventPx(e), event: e }));
  const lane = tapLayer(units, { track: 'timeline-events', estimatePx: trackWidth(), layout: markerBoxes, cls: 'marker-layer', place: (node, t) => node.style.setProperty('left', `${t.centre}%`),
    group: (us, t) => markerGroup(us.map(({ event: e }) => ({ text: `${(EVENT_KINDS[e.type] ?? ['•'])[0]} ${e.label} · ${time(e.at, { seconds: false })}`, href: e.flowId ? detailHref({ flow: e.flowId }) : null })), { cls: 'tl-ev-cluster', pct: t.centre }),
    single: ({ event: e }, t) => {
      const [glyph] = EVENT_KINDS[e.type] ?? ['•'], attrs = { class: `tl-ev tl-ev-${e.type}`, style: { left: `${t.centre}%` }, title: `${e.label} · ${time(e.at, { seconds: false })}`, 'aria-label': `${e.label} at ${time(e.at)}` };
      const body = [h('span', { class: 'tl-ev-glyph', text: glyph }), e.ref ? h('span', { class: 'tl-ev-ref', text: e.ref }) : null];
      return e.flowId ? h('a', { ...attrs, href: detailHref({ flow: e.flowId }) }, body) : h('span', { ...attrs, role: 'img' }, body);
    } });
  return h('div', { class: 'slot-lane' }, h('div', { class: 'slot-track events' }, lane));
}
function chart(title, points, series, from, to, { max, format }) {
  const path = key => { const pts = points.filter(p => Number.isFinite(p[key])); return pts.map((p, i) => `${i ? 'L' : 'M'}${(pct(ms(p.at), from, to) * 10).toFixed(1)},${(100 - (p[key] / max) * 96).toFixed(1)}`).join(''); };
  const peak = key => Math.max(...points.map(p => p[key]).filter(Number.isFinite));
  return h('figure', { class: 'machine-chart' }, h('figcaption', { text: title }),
    h('div', { class: 'chart-frame' }, svg('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none', role: 'img', 'aria-label': title }, svg('line', { x1: 0, x2: 1000, y1: 52, y2: 52, class: 'grid' }), series.map(([key, cls]) => svg('path', { d: path(key), class: `line line-${cls}`, 'vector-effect': 'non-scaling-stroke' })))),
    h('ul', { class: 'legend' }, series.map(([key, cls, label]) => h('li', {}, h('span', { class: `swatch line-${cls}`, 'aria-hidden': 'true' }), `${label} `, h('strong', { text: Number.isFinite(peak(key)) ? `peak ${format(peak(key))}` : 'no data' })))));
}
function machine(data, from, to) {
  const points = data.machine ?? [];
  if (!points.length) return h('p', { class: 'muted', text: 'No machine samples in this window yet. The operations loop records one every two minutes while the project service runs.' });
  const memoryMax = Math.max(...points.map(p => Math.max(p.memoryTotal ?? 0, p.swapTotal ?? 0))) || 1;
  return h('div', { class: 'machine' },
    chart('CPU in use and time waiting on the disk', points, [['cpu', 'cpu', 'CPU'], ['iowait', 'iowait', 'waiting on disk (iowait)']], from, to, { max: 1, format: v => `${Math.round(v * 100)}%` }),
    chart('Memory and swap in use', points, [['memoryUsed', 'memory', 'memory'], ['swapUsed', 'swap', 'swap']], from, to, { max: memoryMax, format: gb }));
}
function openWork(project) {
  const s = project.snapshot, active = (s.flows ?? []).filter(f => !['completed', 'failed'].includes(f.state)).sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0));
  // One full-width row per flow: what it is, where it is and how long it has been running.
  return card(`Active (${active.length})`, active.length ? h('ul', { class: 'active-list', role: 'list' }, active.map(f => h('li', {}, h('a', { class: 'active-row', href: detailHref({ flow: f.id }) },
    h('strong', { class: 'active-title', text: f.taskSnapshot?.title ?? flowName(f), title: f.id }),
    h('span', { class: 'muted small', text: f.kind === 'change' || !f.kind ? 'change' : f.kind }),
    h('span', { class: 'muted small', text: f.step ? `at ${f.step}` : '' }),
    h('span', { class: 'muted small', text: `started ${relative(f.createdAt)}` }),
    chip(f.state))))) : h('p', { class: 'muted', text: 'Nothing is running. Finished work is on the timeline below and in History.' }),
    { cls: 'span-all', level: 'h2' });
}
export function timelineView(project) {
  if (!available(project)) return notice('warning', `${project.name} is ${project.status}.`, 'Timelines are read from the project service and are unavailable until it responds.');
  const s = project.snapshot, ui = uiState(`timeline:${project.projectId}`, { hours: '12' });
  if (!WINDOWS.some(([k]) => k === ui.hours)) ui.hours = '12';
  // Re-read when the project changed, and at least every minute for machine samples.
  let entry = readEntry(project, 'timeline', ui.hours);
  if (!entry || (entry.status === 'ready' && (entry.revision !== s.revision || Date.now() - ms(entry.fetchedAt) > 60000))) { entry = read(project, 'timeline', ui.hours, {}, { force: Boolean(entry), onDone: rerender }); entry.revision = s.revision; }
  const data = entry.data;
  const head = h('div', { class: 'toolbar' }, h('div', {}, h('h2', { class: 'view-title', text: 'Timeline' }), h('p', { class: 'muted small', text: `The last ${WINDOWS.find(([k]) => k === ui.hours)[1]}, ending ${data ? time(data.window.to, { seconds: false }) : 'now'}` })),
    segmented(WINDOWS, ui.hours, v => { ui.hours = v; saveUi(); rerender(); }, 'Window'));
  let body;
  if (!data) body = entry.status === 'error' ? notice('error', 'Timeline unavailable.', entry.error, button('Retry', () => { read(project, 'timeline', ui.hours, {}, { force: true, onDone: rerender }); rerender(); })) : h('div', { class: 'skeleton', 'aria-busy': 'true', text: 'Loading the timeline…' });
  else {
    const from = ms(data.window.from), to = ms(data.window.to), st = data.stats;
    const tiles = h('div', { class: 'stat-tiles' }, [['Changes merged', st.merged], ['Completed', st.completed], ['Idle slot time', `${duration(st.idleSlotMs)} of ${duration(st.slotMs)}`]].map(([label, value]) => h('div', { class: 'stat-tile' }, h('span', { class: 'muted small', text: label }), h('strong', { text: value }))));
    const laneLabel = { change: 'Slot', document: 'Document', task: 'Task', maintenance: 'Maintenance' };
    body = h('div', { class: 'stack' }, tiles, h('div', { class: 'slot-timeline' }, slotAxis(from, to),
      data.pools.map(pool => h('section', { class: 'slot-pool' }, h('h3', { text: pool.label }), pool.lanes.map(lane => slotLane(project, lane, laneLabel[pool.kind], from, to)))),
      h('section', { class: 'slot-pool' }, h('h3', { text: 'Events' }), data.events.length ? eventTrack(project, data.events, from, to) : h('p', { class: 'muted', text: 'No merges, questions, stops or upgrades in this window.' }),
        h('ul', { class: 'legend' }, Object.entries(EVENT_KINDS).map(([k, [glyph, label]]) => h('li', { class: `tl-ev-${k}` }, h('span', { class: 'tl-ev-glyph', text: glyph }), ` ${label}`)))),
      h('section', { class: 'slot-pool' }, h('h3', { text: 'Machine' }), machine(data, from, to)),
      h('ul', { class: 'legend' }, CATEGORIES.map(([k, label]) => h('li', {}, h('span', { class: `swatch seg-${k}`, 'aria-hidden': 'true' }), label)), h('li', {}, h('span', { class: 'swatch slot-idle', 'aria-hidden': 'true' }), 'idle slot'))),
      h('p', { class: 'muted small', text: 'Select a bar, marker or open item to see that flow’s detail.' }));
  }
  const recovery = needsRecovery(project) ? notice('error', 'Work needs recovery.', 'A hold or an uncertain step is stopping work until it is resolved. ', link(href({ projectId: project.projectId, tab: 'records' }), 'Open Health')) : null;
  return h('div', { class: 'view stack' }, recovery, openWork(project), card('', h('div', { class: 'stack' }, head, body), { cls: 'span-all' }));
}

// ---- Flow detail, shown in the shared detail modal -----------------------------------------------
export function flowDetail(project, flowId, route) {
  const s = project.snapshot, selected = (s.flows ?? []).find(f => f.id === flowId);
  const ui = uiState(`timeline:${project.projectId}`, { hours: '12', zoom: 1 });
  // Re-read flow evidence when the project's state revision has advanced since it was fetched.
  let entry = readEntry(project, 'flows', flowId);
  if (!entry || (entry.status === 'ready' && entry.revision !== s.revision)) { entry = read(project, 'flows', flowId, {}, { force: Boolean(entry), onDone: rerender }); entry.revision = s.revision; }
  const main = h('div', { class: 'stack' });
  if (!entry.data) { main.append(entry.status === 'error' ? notice('error', 'Flow evidence unavailable.', entry.error, button('Retry', () => { read(project, 'flows', flowId, {}, { force: true, onDone: rerender }).revision = s.revision; rerender(); })) : h('div', { class: 'skeleton', 'aria-busy': 'true', text: 'Loading canonical flow evidence…' })); return main; }
  const detail = entry.data, flow = detail.flow;
  if (flow.replacedBy) main.append(notice('info', 'This flow was replaced.', h('span', {}, `It was abandoned${flow.retiredBy ? ` (${flow.retiredBy})` : ''}; the work continued in `, link(detailHref({ projectId: project.projectId, flow: flow.replacedBy }), flowTitle(project, flow.replacedBy)), '.')));
  if (flow.replaces?.length) main.append(h('p', { class: 'muted small' }, 'Replaces ', ...flow.replaces.flatMap((id, i) => [i ? ', ' : '', link(detailHref({ projectId: project.projectId, flow: id }), `abandoned flow ${id.slice(0, 8)}`)]), '.'));
  const stepOrder = (s.settings?.workflow?.steps ?? []).map(x => x.id);
  const model = timelineModel(detail, { observedAt: project.observedAt, stepOrder });
  const attemptId = route.params.attempt && detail.attempts.some(a => a.id === route.params.attempt) ? route.params.attempt : null;
  main.append(h('div', { class: 'toolbar' }, h('p', { class: 'muted small' }, `${flow.kind ?? 'change'} · ${flowName(selected ?? flow)} · evidence read ${relative(entry.fetchedAt)}${entry.status === 'loading' ? ' · refreshing…' : ''} · `, flow.taskId ? link(detailHref({ task: flow.taskId }), 'Task details') : null),
    h('div', { class: 'button-row' }, segmented([[1, '1×'], [2, '2×'], [4, '4×'], [8, '8×']].map(([z, l]) => [String(z), l]), String(ui.zoom ?? 1), z => { ui.zoom = Number(z); saveUi(); rerender(); }, 'Zoom'), button('Reload evidence', () => { read(project, 'flows', flowId, {}, { force: true, onDone: rerender }); rerender(); }, { variant: 'ghost' }))));
  if (model.empty) main.append(empty('No timed records for this flow', 'The flow has no persisted timestamps to place on a timeline.'));
  else {
    const summary = `${plural(detail.attempts.length, 'attempt')} across ${plural(model.lanes.length, 'lane')} from ${time(new Date(model.start).toISOString())} to ${model.active ? 'the observation time' : time(new Date(model.end).toISOString())}.`;
    main.append(card('Execution timeline', h('div', { class: 'stack' }, h('p', { class: 'sr-only', text: summary }), legend(), gantt(project, model, attemptId, ui.zoom ?? 1), segmentTable(model),
      model.active ? h('p', { class: 'muted small', text: `This flow is still open. Spans marked open end at the observation time (${time(project.observedAt)}), not at a recorded end.` }) : null), { subtitle: 'Bars use persisted attempt, wait and event times. Select an attempt to inspect its receipt and logs.' }));
  }
  if (attemptId) main.append(attemptPanel(project, detail, detail.attempts.find(a => a.id === attemptId)));
  else if (detail.attempts.length) main.append(h('p', { class: 'muted', text: 'Select an attempt bar to see its receipt, recorded result and log evidence.' }));
  const decisions = detail.inbox ?? [];
  main.append(h('div', { class: 'two-col' },
    card('Flow summary', flowSummary(project, detail)),
    h('div', { class: 'stack' }, card('Controls', flowActions(project, flow, detail.attempts)),
      card(`Decisions (${decisions.length})`, decisions.length ? h('ul', { class: 'plain-list decisions' }, decisions.map(q => h('li', {}, decisionEntry(project, flow, q)))) : h('p', { class: 'muted', text: 'No questions for this flow.' })))));
  if (detail.retrospective) main.append(retrospective(detail.retrospective));
  main.append(...flowRecords(project, detail));
  main.append(card(`Flow events (${detail.events.length})`, eventList(detail.events, { limit: 200, attempts: detail.attempts }), { subtitle: 'Newest first; includes attempt lifecycle events.' }));
  return main;
}
// One flow question as decided: the answer, who gave it (the operator, or the orchestrator on the
// operator's behalf with the words it relayed), when, the note sent with it, and for a merge or an
// accepted outcome who signed off and on which commit.
const AUTHORITY = { operator: 'the operator', delegated: 'the orchestrator on behalf of the operator', autoMerge: 'the configured automatic-merge policy', strictDecisionRole: 'the designated strict reviewer', mergeDecisionRole: 'the delegated merge role' };
const actorName = actor => ({ operator: 'the operator', orchestrator: 'the orchestrator' })[actor] ?? (actor ? `the ${actor}` : 'an unrecorded actor');
export function decisionEntry(project, flow, q) {
  const label = answer => q.choices?.find(choice => choice.id === answer)?.label ?? answer;
  const notes = (flow.answerNotes ?? []).filter(row => row.inboxId === q.id), last = notes.at(-1);
  const note = q.answerNote ?? last?.note, onBehalfOf = q.onBehalfOf ?? last?.onBehalfOf;
  const by = q.relay ? `the ${q.relay.relayedBy}, relaying the operator’s words` : q.answeredBy === 'orchestrator' && onBehalfOf ? 'the orchestrator on behalf of the operator' : actorName(q.answeredBy);
  const lines = [h('p', {}, chip(q.status), ' ', h('span', { text: q.title ?? q.question ?? q.id }))];
  if (q.status === 'answered') {
    lines.push(h('p', { class: 'small' }, h('strong', { text: `Answered “${label(q.answer)}”` }), ` by ${by}`, q.answeredAt ? h('span', { class: 'muted', text: ` · ${time(q.answeredAt)}` }) : null));
    if (q.relay) lines.push(h('p', { class: 'small', text: `Relayed from ${q.relay.channel}: “${q.relay.quote}”` }));
    if (onBehalfOf?.instruction) lines.push(h('p', { class: 'small', text: `Operator instruction it acted on: “${onBehalfOf.instruction}”${onBehalfOf.reference ? ` (${onBehalfOf.reference})` : ''}` }));
    if (note) lines.push(h('p', { class: 'small preline', text: `Note: ${note}` }));
    const sign = [flow.mergeAuthorization, flow.completionDecision].find(row => row?.inboxId === q.id && row.actor);
    if (sign) {
      const head = sign.reviewedHead ?? sign.identity?.head, merge = sign === flow.mergeAuthorization;
      lines.push(h('p', { class: 'small' }, h('strong', { text: `${merge ? 'Merge' : 'Outcome'} signed off by ${AUTHORITY[sign.authority] ?? actorName(sign.actor)}` }), sign.authority && !['operator', 'delegated'].includes(sign.authority) ? ` (${sign.actor})` : '',
        head ? [' for commit ', h('code', { text: String(head).slice(0, 12) })] : null, sign.reviewedHead ? ' after an exact-head strict review' : '', (sign.answeredAt ?? sign.at) ? h('span', { class: 'muted', text: ` · ${time(sign.answeredAt ?? sign.at)}` }) : null));
    }
  } else if (q.withdrawal) lines.push(h('p', { class: 'muted small', text: `Withdrawn by ${actorName(q.withdrawal.actor)} ${time(q.withdrawal.at)}: ${q.withdrawal.reason}` }));
  else if (q.status === 'open') lines.push(link(href({ projectId: project.projectId, tab: 'inbox', params: { item: q.id } }), 'Answer in Inbox'));
  else if (q.reason || q.supersededReason) lines.push(h('p', { class: 'muted small', text: q.reason ?? q.supersededReason }));
  return h('div', { class: 'decision-entry' }, lines);
}

// What each role cited of a cycle's learnings (dev.92, P4): the planner and builder applied or
// contradicted, the reviewer followed or contradicted. Text only; the latest entry per role and step.
const CITING_ROLE = { planner: 'Planner', builder: 'Builder', reviewer: 'Reviewer' }, CITED_USE = { applied: 'applied', contradicted: 'contradicted', followed: 'followed' };
function citationList(rows) {
  const latest = new Map(); for (const row of rows) if (row && CITING_ROLE[row.role]) latest.set(`${row.role}:${row.step}`, row);
  if (!latest.size) return h('p', { class: 'muted small', text: 'No role has cited a learning of this cycle yet.' });
  return h('div', { class: 'stack' }, h('p', { class: 'small', text: 'What each role cited:' }), h('ul', { class: 'plain-list' }, [...latest.values()].map(row => h('li', { class: 'small' },
    h('strong', { text: CITING_ROLE[row.role] }), row.step && row.step !== row.role ? h('span', { class: 'muted', text: ` (${row.step})` }) : null, ': ',
    (row.cited ?? []).length ? (row.cited ?? []).flatMap((item, at) => [at ? ', ' : '', h('code', { text: String(item.id ?? '') }), ` ${CITED_USE[item.use] ?? 'cited'}`]) : 'cited none'))));
}
// A must-fix flow's review ledger (review-must-fix design 12.3, 8.1): one row per finding, by its
// factory id, with its kind, status, reason, class, reachability, support and counted judgements.
export function reviewLedgerCard(flow) {
  const ledger = flow?.reviewBar === 'must-fix' ? flow.reviewLedger : null;
  if (ledger?.error) return card('Review ledger', notice('warning', 'The review ledger could not be built.', String(ledger.error)));
  if (!ledger?.entries?.length) return null;
  const OPEN = ['open', 'contested', 'operator-required', 'fixed-claimed', 'deferred-claimed'];
  const row = e => h('tr', {}, h('td', {}, h('code', { text: e.id })), h('td', { text: e.kind ?? '' }), h('td', {}, chip(e.status === 'fixed' ? 'passed' : OPEN.includes(e.status) ? 'revise' : 'held', e.status)), h('td', { text: e.reason ?? '' }), h('td', { text: e.purposeImpact ?? '' }),
    h('td', { text: e.reachable ? `${e.reachable.reported}${e.reachable.read !== e.reachable.reported ? ` → ${e.reachable.read}` : ''}` : '' }),
    h('td', { text: e.support ?? (e.deferral ? `deferral ${e.deferral.void ? 'void' : e.deferral.outcome ?? 'awaiting'}` : '') }),
    h('td', { text: (e.judgements ?? []).filter(j => j.counted).map(j => `${j.judgement} (R${j.round}${j.reviewer?.family ? `, ${j.reviewer.family}` : ''})`).join('; ') }),
    h('td', { class: 'small', text: String(e.message ?? e.scenario ?? e.reason ?? '').slice(0, 200) }));
  const table = h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, ['Id', 'Kind', 'Status', 'Reason', 'Class', 'Reachable', 'Support', 'Judgements', 'Finding'].map(text => h('th', { text })))), h('tbody', {}, ledger.entries.slice(-LEDGER_ROWS).map(row))));
  const omitted = ledger.entries.length > LEDGER_ROWS ? h('p', { class: 'muted small', text: `The ${ledger.entries.length - LEDGER_ROWS} earliest entries are not shown; status --flow lists every one.` }) : null;
  const counts = Object.entries(ledger.counts ?? {}).filter(([, n]) => n).map(([status, n]) => `${n} ${status}`).join(', ');
  return card(`Review ledger (${ledger.entries.length})`, h('div', { class: 'stack' }, table, omitted), { subtitle: `${counts}. Validated citations exist as cited; they do not by themselves support a claim.` });
}
// Records about this flow that used to live on the Operations tab.
const LEDGER_ROWS = 60;
function flowRecords(project, detail) {
  const cards = [], obligations = detail.obligations ?? [], pushback = detail.pushback ?? [], regressions = detail.regressions ?? [], contexts = detail.contexts ?? [];
  if (obligations.length) cards.push(card(`To-dos (${obligations.length})`, h('ul', { class: 'plain-list' }, obligations.map(o => h('li', {}, chip(o.status), ' ', o.title ?? o.text ?? o.id, o.evidence ? h('span', { class: 'muted small', text: ` · ${o.evidence}` }) : null))), { subtitle: 'Owed after this flow. Resolve open ones from the Inbox.' }));
  if (pushback.length) cards.push(card(`Rule proposals (${pushback.length})`, h('ul', { class: 'plain-list' }, pushback.map(p => h('li', {}, h('strong', { text: p.ruleId }), ` · ${p.reason}`, p.evidence ? h('span', { class: 'muted small', text: ` · ${p.evidence}` }) : null))), { subtitle: 'An agent objected to a project rule. Nothing changes unless you change the rule.' }));
  const ledgerCard = reviewLedgerCard(detail.flow);
  if (ledgerCard) cards.push(ledgerCard);
  if (regressions.length) cards.push(card(`Regression reports (${regressions.length})`, h('ul', { class: 'plain-list' }, regressions.map(r => h('li', {}, chip(r.status), ` ${r.reason}`, r.evidence ? h('span', { class: 'muted small', text: ` · ${r.evidence}` }) : null)))));
  // The learnings each plan cycle pinned (knowledge-upkeep slice 8, after the review of b46da01, Q8):
  // ids, paths, blob ids and flags, and what was skipped, refused or could not be read. Text only.
  const citations = Array.isArray(detail.learningCitations) ? detail.learningCitations : Array.isArray(detail.flow?.learningCitations) ? detail.flow.learningCitations : [];
  const cycles = [...(detail.flow?.learningHistory ?? []).map(row => ({ ...row, entries: row.learnings ?? [], ended: true })), ...(detail.flow?.learningSelection ? [detail.flow.learningSelection] : [])];
  if (cycles.length) cards.push(card(`Learnings shown to agents (${cycles.length} ${cycles.length === 1 ? 'cycle' : 'cycles'})`, h('ul', { class: 'plain-list' }, cycles.map(c => h('li', {},
    h('p', { class: 'small' }, h('strong', { text: `Cycle ${c.cycle ?? '?'}${c.ended ? ' (ended by a replan)' : ''}` }), ` · selected at ${c.step ?? 'an unrecorded step'}`, c.commit ? [' from ', h('code', { text: short(c.commit, 12) })] : null),
    c.problem ? h('p', { class: 'small', text: `Not read: ${c.problem}` }) : null,
    (c.entries ?? []).length ? h('ul', { class: 'plain-list' }, c.entries.map(e => h('li', { class: 'small' }, h('code', { text: e.id }), `${e.path ? ` · ${e.path}` : ''} · blob `, h('code', { text: short(e.blob ?? '', 12) }), e.flags?.length ? h('span', { class: 'muted', text: ` · flagged: ${e.flags.join(', ')}` }) : null))) : h('p', { class: 'muted small', text: 'No learning was selected.' }),
    (c.skipped ?? []).length ? h('p', { class: 'muted small', text: `Not selected: ${c.skipped.map(row => `${row.id} (${row.reason === 'chars' ? 'character budget' : row.reason === 'count' ? 'count limit' : row.reason})`).join(', ')}` }) : null,
    (c.refused ?? []).length ? h('details', {}, h('summary', { text: `${c.refused.length} refused in the store` }), h('ul', { class: 'plain-list' }, c.refused.map(row => h('li', { class: 'small' }, h('code', { text: row.path }), h('span', { class: 'muted', text: ` · ${row.reason}` }))))) : null,
    citationList(citations.filter(row => row.cycle === null || row.cycle === undefined ? !c.ended : row.cycle === c.cycle))))),
    { subtitle: 'Advisory evidence, pinned by Git blob for each plan cycle. It carries no authority.' }));
  if (contexts.length) {
    const step = id => detail.attempts.find(a => a.id === id)?.step ?? short(id, 8);
    cards.push(card(`Context given to agents (${contexts.length})`, h('details', {}, h('summary', { text: 'Show the project files each step received' }), h('ul', { class: 'plain-list' }, contexts.map(c => h('li', {}, h('strong', { text: step(c.attemptId ?? c.id) }), ` · ${c.files?.length ? c.files.map(f => f.path).join(', ') : 'no files'}`, c.omitted?.length ? h('span', { class: 'muted small', text: ` · left out: ${c.omitted.map(o => `${o.id} (${o.reason})`).join(', ')}` }) : null)))), { subtitle: 'Governing files delivered to each model step.' }));
  }
  return cards;
}
export const flowDetailTitle = (project, flowId) => { const f = (project.snapshot.flows ?? []).find(row => row.id === flowId); return f ? `${f.taskSnapshot?.title ?? flowName(f)}` : `Flow ${flowId}`; };
