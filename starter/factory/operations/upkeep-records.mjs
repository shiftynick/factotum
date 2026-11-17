// Knowledge upkeep: its records and the only ways it reads them (design section 4).
//
// The access rule (4.5): no upkeep code path reads every record of a kind, looks records up by a
// field without a declared index, or filters records.data with a JSON predicate outside a declared
// index. Every read here is by primary key, a meta key, or one of the declared indexes
// (core/records.mjs), each with a row limit that does not depend on history.
//
// The targeted reads of core/records.mjs fall back to parsing a whole kind when the kind is not
// verified. Upkeep must not: when a kind it needs is not verified, these reads refuse
// (UpkeepAccessUnavailable) and upkeep is suspended with a health reason instead of running.
//
// Nothing here calls a model, creates a task or runs by itself: this module only defines the
// records (operations/upkeep-runs.mjs moves a run through its states). Functions named
// …InTransaction expect the caller's transaction.
import { assert, id, now } from '../core/contracts.mjs';
import { LIVE, UPKEEP_OBSERVED_KIND, field, openUpkeepCandidatesSql } from '../core/records.mjs';
import { UPKEEP_NAMESPACE, hasUpkeepMarker } from '../core/upkeep-namespace.mjs';

// 4.1. Each kind is keyed as noted; all but upkeepObserved are read by key only.
export const UPKEEP_KINDS = Object.freeze({
  run: 'upkeepRun',               // source flow id: the pending receipt, then the run's state and outcome
  observed: UPKEEP_OBSERVED_KIND, // class key: a rule or learning class seen in one flow, not yet raised
  day: 'upkeepDay',               // UTC date: the day's counters
  window: 'upkeepWindow',         // one row: the last run outcomes and disposed outputs
  learningUse: 'learningUse',     // learning id: times selected and cited
});
export const UPKEEP_META = Object.freeze({ work: 'upkeepWork', open: 'upkeepOpen', suspended: 'upkeepSuspended', learningDelivery: 'learningDelivery', learningsStore: 'learningsStore' });
export const UPKEEP_FINDING_SOURCE = 'upkeep';

// ---- Verified access ----
// The kinds upkeep reads through an index: the live finding set, open tasks by lower-cased id,
// observed classes by time, and a flow's attempts and pushback.
export const UPKEEP_INDEXED_KINDS = Object.freeze(['finding', 'task', UPKEEP_OBSERVED_KIND, 'attempt', 'pushback']);
export class UpkeepAccessUnavailable extends Error { constructor(kinds) { super(`knowledge upkeep cannot read ${kinds.join(', ')} through ${kinds.length === 1 ? 'its index' : 'their indexes'}: the record layout has not verified ${kinds.length === 1 ? 'that kind' : 'those kinds'} (layout status lists why); upkeep does not read a whole kind instead`); this.name = 'UpkeepAccessUnavailable'; this.kinds = kinds; } }
export function upkeepAccess(store, kinds = UPKEEP_INDEXED_KINDS) {
  const unverified = kinds.filter(kind => !store.verified(kind));
  return { available: unverified.length === 0, unverified };
}
function requireVerified(store, kinds) { const { unverified } = upkeepAccess(store, kinds); if (unverified.length) throw new UpkeepAccessUnavailable(unverified); }

// ---- Suspension (8.4) ----
// meta upkeepSuspended: { [part]: { part, rule, window, reason, at } }. A suspension is recorded
// once, with one operator notice, and nothing here lifts it: only the operator does (N3).
// `learnings` (slice 8, 14.3): delivering selected learnings to later flows. It is not part of `all`.
export const UPKEEP_PARTS = Object.freeze(['model', 'docs', 'context', 'capture', 'all', 'learnings']);
export const upkeepSuspensions = store => store.meta(UPKEEP_META.suspended, {});
export const upkeepSuspended = (store, part) => { const all = upkeepSuspensions(store); return all.all ?? all[part] ?? null; };
// `quiet` records the suspension without a notice of its own: a rule that suspends two parts raises
// one notice, on the first, which names both (`title`).
const suspensionNoticeId = row => `upkeep-suspended:${row.part}:${Date.parse(row.at)}`;
export function recordUpkeepSuspensionInTransaction(store, { part, rule, window = null, reason, quiet = false, title = null }) {
  assert(UPKEEP_PARTS.includes(part) && typeof rule === 'string' && rule && typeof reason === 'string' && reason, 'an upkeep suspension names its part, its rule and a reason');
  const all = upkeepSuspensions(store); if (all[part]) return all[part];
  const row = { part, rule, window, reason, at: now() };
  store.setMeta(UPKEEP_META.suspended, { ...all, [part]: row });
  const noticeId = suspensionNoticeId(row);
  if (!quiet && !store.get('inbox', noticeId)) store.put('inbox', { id: noticeId, kind: 'notice', status: 'open', version: 1, role: 'operator', title: title ?? `Knowledge upkeep suspended (${part === 'all' ? 'everything' : part})`, context: `${reason}\n\nRule: ${rule}. A suspension is lifted only by the operator; existing candidates and tasks are untouched.`, createdAt: row.at });
  store.event('upkeep.suspended', { part, rule }); return row;
}
// Lifting a suspension (8.4, N3): the operator's command only (core/project.mjs, upkeep.lift), with
// a note. Nothing else removes a part from the meta row: not a mode change, not a repaired layout,
// not time. The part's notice, if it is still open, is closed with it.
export function liftUpkeepSuspensionInTransaction(store, { part, note, by }) {
  assert(UPKEEP_PARTS.includes(part), `an upkeep suspension is of one of ${UPKEEP_PARTS.join(', ')}`);
  assert(by === 'operator', 'a knowledge upkeep suspension is lifted only by the operator');
  assert(typeof note === 'string' && note.trim(), 'lifting a suspension needs a note');
  const all = upkeepSuspensions(store), row = all[part]; assert(row, `knowledge upkeep is not suspended for ${part === 'all' ? 'everything' : part}`);
  const { [part]: lifted, ...rest } = all; store.setMeta(UPKEEP_META.suspended, rest);
  const notice = store.get('inbox', suspensionNoticeId(row)); if (notice?.status === 'open') store.put('inbox', { ...notice, status: 'superseded', supersededBy: by, version: (notice.version ?? 1) + 1 });
  store.event('upkeep.suspension-lifted', { part, rule: row.rule, by, note }); return row;
}
// Whether upkeep may read its records. When a kind it needs is not verified, upkeep as a whole is
// suspended with that as the health reason, and the caller does not run. Call outside a transaction.
export function ensureUpkeepAccess(store) {
  const access = upkeepAccess(store); if (access.available) return true;
  store.tx(() => recordUpkeepSuspensionInTransaction(store, { part: 'all', rule: 'unverified-kind', window: { kinds: access.unverified }, reason: new UpkeepAccessUnavailable(access.unverified).message }));
  return false;
}

// ---- Meta keys ----
// upkeepWork: how many runs are pending, queued or running. One read tells an operations tick
// that there is nothing for upkeep to do.
// The same row also names those runs ({flow id: status}), because a run is read by key only: with
// it, the tick finds the receipts whose deadline or job it has to look at without reading a kind.
// It holds work in hand, never history: a run leaves it when it closes, and at most
// MAX_TRACKED_UPKEEP_RUNS are tracked at once.
export const MAX_TRACKED_UPKEEP_RUNS = 200;
const WORK_STATUSES = Object.freeze(['pending', 'queued', 'running']);
const workCounts = runs => Object.fromEntries(WORK_STATUSES.map(status => [status, Object.values(runs).filter(value => value === status).length]));
export const upkeepWork = store => workCounts(store.meta(UPKEEP_META.work, {}).runs ?? {});
export const hasUpkeepWork = store => { const work = upkeepWork(store); return work.pending + work.queued + work.running > 0; };
// The tracked runs in the order they were first tracked. One meta read.
export const upkeepWorkRuns = store => Object.entries(store.meta(UPKEEP_META.work, {}).runs ?? {}).map(([id, status]) => ({ id, status }));
// The same row also tracks the pull requests the factory is closing for follow-ups it ended
// (operations/upkeep-pr-close.mjs): `closes`, follow-up flow id -> its current close job. The tick
// reads both with its one meta read.
export function upkeepWorkState(store) {
  const stored = store.meta(UPKEEP_META.work, {});
  return { runs: Object.entries(stored.runs ?? {}).map(([id, status]) => ({ id, status })), closes: Object.entries(stored.closes ?? {}).map(([flowId, jobId]) => ({ flowId, jobId })) };
}
export function trackUpkeepCloseInTransaction(store, flowId, jobId) {
  const stored = store.meta(UPKEEP_META.work, {}), closes = { ...(stored.closes ?? {}) };
  if (jobId === null) delete closes[flowId]; else closes[flowId] = jobId;
  store.setMeta(UPKEEP_META.work, { ...stored, closes });
}
// Track a run under its status, or stop tracking it (status null: the run closed).
export function trackUpkeepRunInTransaction(store, flowId, status) {
  assert(status === null || WORK_STATUSES.includes(status), 'a tracked upkeep run is pending, queued or running');
  const stored = store.meta(UPKEEP_META.work, {}), runs = { ...(stored.runs ?? {}) };
  if (status === null) delete runs[flowId]; else runs[flowId] = status;
  store.setMeta(UPKEEP_META.work, { ...stored, ...workCounts(runs), runs });
}
// upkeepOpen: the open docs follow-up task, the open-candidate counts by kind, and how many observed
// classes exist. The counts are maintained where the rows are written (operations/upkeep-candidates.mjs),
// so a cap is checked without reading the rows.
export const UPKEEP_CANDIDATE_KINDS = Object.freeze(['docs', 'context', 'check', 'rule', 'learning', 'learning-stale']);
export function upkeepOpen(store) {
  const stored = store.meta(UPKEEP_META.open, {});
  return { docsTask: stored.docsTask ?? null, candidates: Object.fromEntries(UPKEEP_CANDIDATE_KINDS.map(kind => [kind, stored.candidates?.[kind] ?? 0])) };
}
export const upkeepObservedCount = store => { const count = store.meta(UPKEEP_META.open, {}).observed; return Number.isSafeInteger(count) && count > 0 ? count : 0; };
// candidates: {kind: change}; observed: change. A count never goes below zero.
export function addToUpkeepOpenInTransaction(store, { candidates = {}, observed = 0 } = {}) {
  const stored = store.meta(UPKEEP_META.open, {}), counts = { ...(stored.candidates ?? {}) };
  for (const [kind, change] of Object.entries(candidates)) { assert(UPKEEP_CANDIDATE_KINDS.includes(kind) && Number.isSafeInteger(change), `unknown candidate kind or change: ${kind}`); counts[kind] = Math.max(0, (counts[kind] ?? 0) + change); }
  assert(Number.isSafeInteger(observed), 'the observed-class count changes by a whole number');
  store.setMeta(UPKEEP_META.open, { ...stored, docsTask: stored.docsTask ?? null, candidates: counts, observed: Math.max(0, upkeepObservedCount(store) + observed) });
}

// ---- upkeepRun ----
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
export const UPKEEP_RUN_STATUSES = Object.freeze(['pending', 'queued', 'running', 'closed']);
export const UPKEEP_PENDING_MS = 7 * 86400000;
export const upkeepRun = (store, flowId) => store.get(UPKEEP_KINDS.run, flowId);
// One per merged flow, keyed by its id. The two deadlines are absolute and written once:
// pendingUntil never changes, and runBy, once set, is never moved later (5.3).
export function putUpkeepRunInTransaction(store, run) {
  id(run?.id, 'upkeep run id (the source flow id)');
  assert(UPKEEP_RUN_STATUSES.includes(run.status), `upkeep run status must be one of ${UPKEEP_RUN_STATUSES.join(', ')}`);
  assert(iso(run.pendingUntil), 'an upkeep run carries pendingUntil, an absolute time');
  assert(run.runBy === undefined || run.runBy === null || iso(run.runBy), 'runBy is an absolute time when set');
  const old = upkeepRun(store, run.id);
  if (old) {
    assert(run.pendingUntil === old.pendingUntil, 'pendingUntil is written once and never moved');
    assert(!old.runBy || run.runBy && Date.parse(run.runBy) <= Date.parse(old.runBy), 'runBy is never moved later (it may be shortened)');
  }
  store.put(UPKEEP_KINDS.run, run);
  trackUpkeepRunInTransaction(store, run.id, run.status === 'closed' ? null : run.status);
  return run;
}

// ---- upkeepDay ----
// Keyed by UTC date. Counters only; the rows of a window are read by key, one per day.
// tasksCreated counts every upkeep task created that day; operatorTasksCreated (dev.92, P2) the
// part of it the operator created by a direct acceptance, which the task ceilings never refuse but
// which still uses up the factory's room (operations/upkeep-tasks.mjs upkeepTaskBudget). A row
// written before dev.92 reads 0 there.
export const upkeepDayId = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
export const UPKEEP_DAY_COUNTERS = Object.freeze(['modelRunsReserved', 'modelRunsSettled', 'tasksCreated', 'operatorTasksCreated', 'invocations', 'upkeepInvocations']);
const emptyDay = dayId => ({ id: dayId, ...Object.fromEntries(UPKEEP_DAY_COUNTERS.map(name => [name, 0])), outcomes: {} });
const validDay = dayId => { const ms = typeof dayId === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayId) ? Date.parse(`${dayId}T00:00:00.000Z`) : NaN; return Number.isFinite(ms) && upkeepDayId(ms) === dayId; };
export function upkeepDay(store, dayId = upkeepDayId()) { assert(validDay(dayId), 'an upkeep day is a UTC date (YYYY-MM-DD)'); return { ...emptyDay(dayId), ...store.get(UPKEEP_KINDS.day, dayId) }; }
// counters: {name: whole-number change}; outcomes: {outcome kind: change}. No total may go below zero.
// reservations: {attempt id: row | null}: the model runs reserved on this day, by the attempt that
// reserved them (operations/upkeep-budget.mjs); null removes one. The row holds at most as many as
// the daily limit allows, so it stays small. A day with none has no such member.
export function addToUpkeepDayInTransaction(store, dayId, { counters = {}, outcomes = {}, reservations = {} } = {}) {
  const day = upkeepDay(store, dayId);
  for (const [name, change] of Object.entries(counters)) { assert(UPKEEP_DAY_COUNTERS.includes(name) && Number.isSafeInteger(change), `unknown upkeep day counter or change: ${name}`); day[name] += change; assert(day[name] >= 0, `upkeep day counter ${name} cannot go below zero`); }
  for (const [name, change] of Object.entries(outcomes)) { assert(/^[a-z][a-z:-]{0,63}$/.test(name) && Number.isSafeInteger(change), `invalid upkeep outcome or change: ${name}`); day.outcomes[name] = (day.outcomes[name] ?? 0) + change; assert(day.outcomes[name] >= 0, `upkeep outcome count ${name} cannot go below zero`); }
  if (Object.keys(reservations).length) {
    const held = { ...(day.reservations ?? {}) };
    for (const [attemptId, row] of Object.entries(reservations)) { id(attemptId, 'attempt id'); if (row === null) delete held[attemptId]; else held[attemptId] = row; }
    if (Object.keys(held).length) day.reservations = held; else delete day.reservations;
  }
  return store.put(UPKEEP_KINDS.day, day);
}
// A UTC day and the days before it, newest first: `days` rows, each read by key. The weekly task
// window is today and the six days before it.
export function upkeepDays(store, { nowMs = Date.now(), days = 7 } = {}) {
  assert(Number.isSafeInteger(days) && days >= 1 && days <= 31, 'a window of 1 to 31 days');
  const start = Date.parse(`${upkeepDayId(nowMs)}T00:00:00.000Z`);
  return Array.from({ length: days }, (_, back) => upkeepDay(store, upkeepDayId(start - back * 86400000)));
}

// ---- upkeepWindow ----
// One row: the last 50 run outcomes, per part the last 20 disposed outputs, and the last 20 merged
// upkeep changes (section 8). It also holds two things the ceilings need to read a window rightly
// (operations/upkeep-ceilings.mjs): `since`, per window, the time a suspension it caused was last
// lifted (only what was recorded after it is evaluated), and `counting`, the time from which the
// day totals have been maintained without a gap.
export const UPKEEP_WINDOW_ID = 'window', UPKEEP_WINDOW_RUNS = 50, UPKEEP_WINDOW_DISPOSED = 20, UPKEEP_WINDOW_MERGED = 20;
export const UPKEEP_DISPOSED_PARTS = Object.freeze(['docs', 'context', 'capture']);
export const UPKEEP_WINDOW_NAMES = Object.freeze(['runs', ...UPKEEP_DISPOSED_PARTS, 'share']);
export const upkeepWindow = store => { const stored = store.get(UPKEEP_KINDS.window, UPKEEP_WINDOW_ID); return { id: UPKEEP_WINDOW_ID, runs: stored?.runs ?? [], disposed: Object.fromEntries(UPKEEP_DISPOSED_PARTS.map(part => [part, stored?.disposed?.[part] ?? []])), merged: stored?.merged ?? [], since: stored?.since ?? {}, counting: stored?.counting ?? null }; };
export function addToUpkeepWindowInTransaction(store, { run, disposed, merged, since, counting } = {}) {
  const window = upkeepWindow(store);
  if (run !== undefined) { assert(run && typeof run === 'object' && typeof run.outcome === 'string', 'a run outcome entry needs its outcome'); window.runs = [...window.runs, run].slice(-UPKEEP_WINDOW_RUNS); }
  if (disposed !== undefined) { assert(disposed && UPKEEP_DISPOSED_PARTS.includes(disposed.part) && typeof disposed.outcome === 'string', 'a disposed output names its part and outcome'); window.disposed[disposed.part] = [...window.disposed[disposed.part], disposed].slice(-UPKEEP_WINDOW_DISPOSED); }
  if (merged !== undefined) { assert(merged && typeof merged.flowId === 'string' && merged.flowId, 'a merged upkeep change names its flow'); window.merged = [...window.merged.filter(row => row.flowId !== merged.flowId), merged].slice(-UPKEEP_WINDOW_MERGED); }
  if (since !== undefined) { for (const [name, at] of Object.entries(since)) assert(UPKEEP_WINDOW_NAMES.includes(name) && iso(at), `unknown window or time: ${name}`); window.since = { ...window.since, ...since }; }
  if (counting !== undefined) { assert(counting === null || iso(counting), 'counting is an absolute time, or null'); window.counting = counting; }
  return store.put(UPKEEP_KINDS.window, window);
}

// ---- Learning delivery (14.3; slice 8, after the review of b46da01, Q7) ----
// meta learningDelivery: { selected, cited, since: { selected, cited, at } }. The totals of learningUse,
// maintained where its rows are counted, so the criterion is judged without reading the rows: once
// at least LEARNING_DELIVERY_WINDOW selections have been counted since the window started, fewer
// than one in ten cited stops delivery (the `learnings` suspension). Only the operator lifts it
// (upkeep.lift), and the window then starts again from the totals at that moment.
export const LEARNING_DELIVERY_WINDOW = 20, LEARNING_DELIVERY_MIN_RATE = 0.1;
export function learningDelivery(store) {
  const stored = store.meta(UPKEEP_META.learningDelivery, {}), whole = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const selected = whole(stored.selected), cited = whole(stored.cited), since = { selected: Math.min(selected, whole(stored.since?.selected)), cited: Math.min(cited, whole(stored.since?.cited)), at: typeof stored.since?.at === 'string' ? stored.since.at : null };
  const window = { selected: selected - since.selected, cited: cited - since.cited };
  // `generation` counts the windows: each lift starts a new one. A selection is counted in the window
  // of its generation, and a citation only toward that same window (review of 004f4ab, P2-2), so a
  // citation of a learning selected before a lift never counts in the restarted window. `late` counts
  // the citations left out that way.
  return { selected, cited, since, window, generation: whole(stored.generation), late: whole(stored.late), rate: window.selected ? window.cited / window.selected : null, suspended: upkeepSuspensions(store).learnings ?? null };
}
export function addToLearningDeliveryInTransaction(store, { selected = 0, cited = 0, late = 0 }) {
  const now_ = learningDelivery(store), next = { selected: now_.selected + selected, cited: now_.cited + cited, since: now_.since, generation: now_.generation, late: now_.late + late };
  store.setMeta(UPKEEP_META.learningDelivery, next);
  const window = { selected: next.selected - next.since.selected, cited: next.cited - next.since.cited };
  if (!now_.suspended && window.selected >= LEARNING_DELIVERY_WINDOW && window.cited < LEARNING_DELIVERY_MIN_RATE * window.selected)
    recordUpkeepSuspensionInTransaction(store, { part: 'learnings', rule: 'learnings-uncited', window, title: 'Learning delivery stopped', reason: `Since ${next.since.at ?? 'counting began'}, flows were shown learnings ${window.selected} times and cited them ${window.cited} times (${Math.round(100 * window.cited / window.selected)}%), below the 10% the trial requires after ${LEARNING_DELIVERY_WINDOW} selections (knowledge-upkeep design 14.3). New plan cycles are shown no learnings until the operator lifts this; a cycle already pinned keeps what it was shown.` });
  return next;
}
// After the operator lifts the suspension: the window starts again.
export function restartLearningDeliveryInTransaction(store, { at }) {
  const now_ = learningDelivery(store);
  store.setMeta(UPKEEP_META.learningDelivery, { selected: now_.selected, cited: now_.cited, since: { selected: now_.selected, cited: now_.cited, at }, generation: now_.generation + 1, late: now_.late });
}
// meta learningsStore: what the last learnings.check read, for Health (Q2): the head, how many
// learnings were read, and each file refused with why. Bounded.
export const learningsStoreStatus = store => store.meta(UPKEEP_META.learningsStore, null);
export const putLearningsStoreStatusInTransaction = (store, status) => store.setMeta(UPKEEP_META.learningsStore, status);

// ---- learningUse ----
export const learningUse = (store, learningId) => ({ id: learningId, selected: 0, cited: 0, ...store.get(UPKEEP_KINDS.learningUse, learningId) });
export function addLearningUseInTransaction(store, learningId, { selected = 0, cited = 0 } = {}) {
  id(learningId, 'learning id'); assert(Number.isSafeInteger(selected) && selected >= 0 && Number.isSafeInteger(cited) && cited >= 0, 'learning use counts only go up');
  const use = learningUse(store, learningId); return store.put(UPKEEP_KINDS.learningUse, { ...use, selected: use.selected + selected, cited: use.cited + cited });
}

// ---- Candidates and observed classes ----
// A raised candidate is a finding row keyed by its class key (operations/upkeep-class-key.mjs).
export const upkeepCandidate = (store, classKey) => store.get('finding', classKey);
// The open candidates, through their own partial index: bounded by upkeep's caps, whatever the
// number of open audit findings (the live finding set holds those too, without a bound). Every
// upkeep path that needs the open candidates (a cap, expiry, the assessment's list) reads this.
export function openUpkeepCandidates(store) {
  requireVerified(store, ['finding']);
  return store.db.prepare(openUpkeepCandidatesSql(store)).all().map(row => JSON.parse(row.data));
}
export const observedClass = (store, classKey) => store.get(UPKEEP_KINDS.observed, classKey);
export function putObservedClassInTransaction(store, row) {
  assert(typeof row?.id === 'string' && /^[a-f0-9]{64}$/.test(row.id), 'an observed class is keyed by its class key');
  assert(iso(row.firstObservedAt), 'an observed class records when it was first observed');
  const old = observedClass(store, row.id); assert(!old || old.firstObservedAt === row.firstObservedAt, 'firstObservedAt is written once');
  return store.put(UPKEEP_KINDS.observed, row);
}
export const deleteObservedClassInTransaction = (store, classKey) => { store.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(UPKEEP_KINDS.observed, classKey); };
// Observed classes first seen before a time, oldest first: an indexed range read of at most
// OBSERVED_EXPIRY_ROWS rows. It never touches the finding set.
export const OBSERVED_EXPIRY_ROWS = 50;
export function observedBefore(store, beforeIso, limit = OBSERVED_EXPIRY_ROWS) {
  assert(iso(beforeIso) && Number.isSafeInteger(limit) && limit >= 1 && limit <= OBSERVED_EXPIRY_ROWS, `an absolute time and a limit of at most ${OBSERVED_EXPIRY_ROWS} rows`);
  requireVerified(store, [UPKEEP_KINDS.observed]);
  const first = field('firstObservedAt');
  return store.db.prepare(`SELECT data FROM records ${store.hint('records_upkeep_observed_first')} WHERE kind='${UPKEEP_KINDS.observed}' AND ${first}<? ORDER BY ${first} LIMIT ?`).all(beforeIso, limit).map(row => JSON.parse(row.data));
}

// ---- The reserved namespace: existing records that collide (7.2, 4.5) ----
// Open project tasks whose id, lower-cased, starts with upkeep: — the reservation's own
// predicate, answered by the declared index over open tasks keyed by lower(id): a range read
// from 'upkeep:' up to, but not including, 'upkeep;', of at most NAMESPACE_LOOKUP_ROWS rows.
// At most MAX_OPEN_UPKEEP_TASKS upkeep tasks are open at once, so that many rows plus one is
// enough: either one of them has no marker, or there are more than the factory can have made.
// Closed and completed tasks are not in the index and are never read.
export const MAX_OPEN_UPKEEP_TASKS = 12, NAMESPACE_LOOKUP_ROWS = MAX_OPEN_UPKEEP_TASKS + 1;
const NAMESPACE_END = `${UPKEEP_NAMESPACE.slice(0, -1)}${String.fromCharCode(UPKEEP_NAMESPACE.charCodeAt(UPKEEP_NAMESPACE.length - 1) + 1)}`;
export function openNamespaceTasks(store) {
  requireVerified(store, ['task']);
  return store.db.prepare(`SELECT data FROM records ${store.hint('records_open_task_lower_id')} WHERE kind='task' AND ${LIVE.task} AND lower(id)>=? AND lower(id)<? ORDER BY lower(id) LIMIT ${NAMESPACE_LOOKUP_ROWS}`).all(UPKEEP_NAMESPACE, NAMESPACE_END).map(row => JSON.parse(row.data));
}
// Why upkeep cannot be turned on over the records that exist: open tasks in the namespace that the
// factory did not make (no marker), naming up to five. Such a task is an ordinary task and stays
// one; it is never treated as an upkeep task. Finish or close them, and rename the source's
// namespace, first.
export function namespaceCollisionReasons(store) {
  const open = openNamespaceTasks(store), foreign = open.filter(task => !hasUpkeepMarker(task));
  if (foreign.length) return [`open task${foreign.length === 1 ? '' : 's'} in the reserved upkeep: namespace that the factory did not make: ${foreign.slice(0, 5).map(task => task.id).join(', ')}${foreign.length > 5 ? ` and ${open.length === NAMESPACE_LOOKUP_ROWS ? 'more' : `${foreign.length - 5} more`}` : ''}; finish or close ${foreign.length === 1 ? 'it' : 'them'} and rename the source namespace before turning upkeep on`];
  if (open.length > MAX_OPEN_UPKEEP_TASKS) return [`more than ${MAX_OPEN_UPKEEP_TASKS} open tasks are in the reserved upkeep: namespace, which is more than the factory can have made; inspect them before turning upkeep on`];
  return [];
}
// A task is an upkeep task only if the factory made it: an id in the namespace and a marker.
// (The candidate rows that name it in return are checked where they are written.)
export const isUpkeepTask = task => typeof task?.id === 'string' && task.id.startsWith(UPKEEP_NAMESPACE) && hasUpkeepMarker(task);
