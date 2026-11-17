// Knowledge upkeep: the rates of design 8.3, as ceilings, and what crossing one does (8.4).
//
// There is no target for how much upkeep should produce: zero output over any period is a pass.
// Each rate is a ceiling, and a count that reaches it suspends a part. Nothing polls: a ceiling is
// evaluated when a run closes or a disposition is recorded, from the one window row and the day
// rows, each read by key (4.5).
//
//   runs that reach the model            last 20 runs              6    the model call
//   runs that produce any candidate      last 20 runs              4    the model call
//   docs follow-ups that end badly       last 10 ended             3    docs (or 3 in a row)
//   candidates declined or expired       last 10 disposed, a part  5    that part
//   reverts or regressions               last 20 merged            1    everything
//   upkeep's share of all invocations    last 7 complete UTC days  10%  the model call and docs
//
// A window is evaluated only once it is full, except the "3 in a row" rule and the revert rule,
// which apply from the first event. After the operator lifts a suspension, the windows that feed
// that part are evaluated only on what was recorded after the lift, so a lift is not undone by the
// entries that caused the suspension.
//
// A suspension is recorded once, with one notice, and is lifted only by the operator
// (operations/upkeep-records.mjs). Functions named …InTransaction expect the caller's transaction.
import { assert } from '../core/contracts.mjs';
import { upkeepMode } from '../core/upkeep-config.mjs';
import { addToUpkeepWindowInTransaction, liftUpkeepSuspensionInTransaction, restartLearningDeliveryInTransaction, recordUpkeepSuspensionInTransaction, upkeepDayId, upkeepDays, upkeepSuspensions, upkeepWindow, UPKEEP_DISPOSED_PARTS } from './upkeep-records.mjs';

const DAY = 86400000, iso = ms => new Date(ms).toISOString();
export const UPKEEP_CEILINGS = Object.freeze({
  model: Object.freeze({ rule: 'runs-reaching-the-model', window: 20, ceiling: 6 }),
  candidates: Object.freeze({ rule: 'runs-producing-candidates', window: 20, ceiling: 4 }),
  docs: Object.freeze({ rule: 'docs-follow-ups-ended-badly', window: 10, ceiling: 3 }),
  docsInARow: Object.freeze({ rule: 'docs-follow-ups-ended-badly-in-a-row', ceiling: 3 }),
  disposed: Object.freeze({ rule: 'candidates-declined-or-expired', window: 10, ceiling: 5 }),
  reverts: Object.freeze({ rule: 'revert-or-regression', window: 20, ceiling: 1 }),
  share: Object.freeze({ rule: 'invocation-share', days: 7, percent: 10 }),
});
// How a docs follow-up ended, and how a context or capture candidate was disposed of. `merged` and
// `accepted` are the outcomes that are not counted against a ceiling; `resolved-elsewhere` is a
// disposal that counts neither way.
export const DOCS_ENDINGS = Object.freeze(['merged', 'rejected', 'failed', 'declined', 'expired']);
export const CANDIDATE_DISPOSALS = Object.freeze(['accepted', 'declined', 'expired', 'resolved-elsewhere']);
const badDocs = entry => entry.outcome !== 'merged', badCandidate = entry => ['declined', 'expired'].includes(entry.outcome);
// The windows a lifted part is evaluated afresh on.
const WINDOWS_OF_PART = Object.freeze({ model: ['runs', 'share'], docs: ['docs', 'share'], context: ['context'], capture: ['capture'], all: [], learnings: [] });
// Entries recorded after the last lift. An entry without a time was written before lifts existed.
const after = (entries, since) => since ? entries.filter(entry => typeof entry.at === 'string' && entry.at > since) : entries;
// What a suspension records of the window that caused it (8.4): the entries themselves, bounded by
// the window, with only the fields the rule read.
const runEntries = runs => runs.map(run => ({ flowId: run.flowId, outcome: run.outcome, reason: run.reason, model: run.model === true, candidates: run.candidates === true, at: run.at ?? null }));
const disposedEntries = entries => entries.map(entry => ({ outcome: entry.outcome, ...(entry.id ? { id: entry.id } : {}), ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.taskId ? { taskId: entry.taskId } : {}), at: entry.at ?? null }));
const partsText = parts => parts.map(part => part === 'model' ? 'the model call' : part === 'all' ? 'everything' : part).join(' and ');

// Suspend each part that is not suspended yet; one notice, on the first, naming them all.
function suspend(store, parts, rule, window, reason) {
  const held = upkeepSuspensions(store), fresh = parts.filter(part => !held[part]);
  return fresh.map((part, index) => recordUpkeepSuspensionInTransaction(store, { part, rule, window, reason, quiet: index > 0, title: `Knowledge upkeep suspended (${partsText(fresh)})` }));
}

// ---- The share of invocations (the last seven complete UTC days) ----
// Today's day is not complete and is never read. The window is full when the totals were being
// maintained, and no suspension it caused was lifted, before the oldest of the seven days began:
// counting that began or was lifted during a day leaves that day incomplete.
export function invocationShare(store, { nowMs = Date.now(), window = upkeepWindow(store) } = {}) {
  const today = Date.parse(`${upkeepDayId(nowMs)}T00:00:00.000Z`), oldest = upkeepDayId(today - UPKEEP_CEILINGS.share.days * DAY);
  const from = [window.counting, window.since.share].filter(Boolean).sort().at(-1) ?? null;
  const full = Boolean(window.counting) && upkeepDayId(Date.parse(from)) < oldest;
  if (!full) return { full, from, days: [], total: 0, upkeep: 0 };
  // Seven rows, each by key: yesterday and the six days before it.
  const days = upkeepDays(store, { nowMs: today - 1, days: UPKEEP_CEILINGS.share.days });
  return { full, from, days: days.map(day => day.id), perDay: days.map(day => ({ day: day.id, invocations: day.invocations, upkeepInvocations: day.upkeepInvocations })), total: days.reduce((sum, day) => sum + day.invocations, 0), upkeep: days.reduce((sum, day) => sum + day.upkeepInvocations, 0) };
}
// Where the share stands now, for Health (dev.93, Q5): the last seven complete UTC days as the
// ceiling reads them, whether that window is full yet, and from which UTC day it is judged if not.
// Counted as the ceiling counts (4.5): every invocation of the upkeep job's own flows and of every
// flow whose task carries the factory-written upkeep marker (docs follow-ups, context, check and
// learning tasks), against every model invocation of the project. The window row and seven day rows,
// each by key. Nothing here judges or suspends.
export function invocationShareStanding(store, { nowMs = Date.now(), window = upkeepWindow(store) } = {}) {
  const today = Date.parse(`${upkeepDayId(nowMs)}T00:00:00.000Z`), oldest = upkeepDayId(today - UPKEEP_CEILINGS.share.days * DAY);
  const from = [window.counting, window.since.share].filter(Boolean).sort().at(-1) ?? null;
  const full = Boolean(window.counting) && upkeepDayId(Date.parse(from)) < oldest;
  const days = upkeepDays(store, { nowMs: today - 1, days: UPKEEP_CEILINGS.share.days });
  const total = days.reduce((sum, day) => sum + day.invocations, 0), upkeep = days.reduce((sum, day) => sum + day.upkeepInvocations, 0), { percent } = UPKEEP_CEILINGS.share;
  // The first UTC day on which the window is full: the day after counting began (or the last lift), plus seven.
  const judgedFrom = full || !from ? null : `${upkeepDayId(Date.parse(`${upkeepDayId(Date.parse(from))}T00:00:00.000Z`) + (UPKEEP_CEILINGS.share.days + 1) * DAY)}T00:00:00.000Z`;
  return { percent, days: UPKEEP_CEILINGS.share.days, oldest: days.at(-1).id, newest: days[0].id, total, upkeep, share: total ? Math.round(upkeep * 1000 / total) / 10 : null,
    full, counting: Boolean(window.counting), judgedFrom, reached: full && total > 0 && upkeep * 100 >= total * percent };
}
function evaluateShare(store, { nowMs, config, window }) {
  if (upkeepMode(config) === 'off') return [];
  // A project that was already on when this release was adopted has no start recorded: it starts now.
  if (!window.counting) { addToUpkeepWindowInTransaction(store, { counting: iso(nowMs) }); return []; }
  const held = upkeepSuspensions(store); if (held.all || held.model && held.docs) return [];
  const share = invocationShare(store, { nowMs, window }), { percent } = UPKEEP_CEILINGS.share;
  if (!share.full || !share.total || share.upkeep * 100 < share.total * percent) return [];
  return suspend(store, ['model', 'docs'], UPKEEP_CEILINGS.share.rule, { days: share.days, invocations: share.total, upkeepInvocations: share.upkeep, entries: share.perDay }, `Knowledge upkeep made ${share.upkeep} of the ${share.total} model invocations of the last ${UPKEEP_CEILINGS.share.days} complete UTC days (${share.days.at(-1)} to ${share.days[0]}), which reaches the ceiling of ${percent}%.`);
}

// ---- When a run closes ----
// Called after the run's entry was added to the window. Returns the suspensions it recorded.
export function evaluateRunCeilingsInTransaction(store, { nowMs = Date.now(), config = store.meta('config', {}) } = {}) {
  // With upkeep off the only runs that close are the ones being closed because it is off.
  if (upkeepMode(config) === 'off') return [];
  const window = upkeepWindow(store), held = upkeepSuspensions(store), recorded = [];
  if (!held.all && !held.model) {
    const { model, candidates } = UPKEEP_CEILINGS, runs = after(window.runs, window.since.runs).slice(-model.window);
    // A run entry written before the model stage existed has no `model` member: it reached none.
    const reached = runs.filter(run => run.model === true).length, produced = runs.filter(run => run.candidates === true).length;
    if (runs.length === model.window && reached >= model.ceiling) recorded.push(...suspend(store, ['model'], model.rule, { runs: runs.length, reached, entries: runEntries(runs) }, `${reached} of the last ${runs.length} upkeep runs reached the model, which reaches the ceiling of ${model.ceiling}. The pre-filter is meant to end most runs without a model call.`));
    else if (runs.length === candidates.window && produced >= candidates.ceiling) recorded.push(...suspend(store, ['model'], candidates.rule, { runs: runs.length, produced, entries: runEntries(runs) }, `${produced} of the last ${runs.length} upkeep runs produced a candidate, which reaches the ceiling of ${candidates.ceiling}. Nothing is the expected answer.`));
  }
  recorded.push(...evaluateShare(store, { nowMs, config, window }));
  return recorded;
}

// ---- When a disposition is recorded ----
// One entry per ended docs follow-up (not per candidate), or per disposed context or capture
// candidate. Returns the suspensions it recorded.
export function recordUpkeepDisposalInTransaction(store, { part, outcome, id = null, kind = null, taskId = null, nowMs = Date.now(), config = store.meta('config', {}) }) {
  assert(UPKEEP_DISPOSED_PARTS.includes(part) && (part === 'docs' ? DOCS_ENDINGS : CANDIDATE_DISPOSALS).includes(outcome), `unknown disposal: ${part} ${outcome}`);
  addToUpkeepWindowInTransaction(store, { disposed: { part, outcome, ...(id ? { id } : {}), ...(kind ? { kind } : {}), ...(taskId ? { taskId } : {}), at: iso(nowMs) } });
  const window = upkeepWindow(store), held = upkeepSuspensions(store), entries = after(window.disposed[part], window.since[part]), recorded = [];
  if (!held.all && !held[part]) {
    if (part === 'docs') {
      const { docs, docsInARow } = UPKEEP_CEILINGS, row = entries.slice(-docsInARow.ceiling), last = entries.slice(-docs.window), bad = last.filter(badDocs).length;
      if (row.length === docsInARow.ceiling && row.every(badDocs)) recorded.push(...suspend(store, ['docs'], docsInARow.rule, { ended: row.map(entry => entry.outcome), entries: disposedEntries(row) }, `The last ${row.length} docs follow-ups ended ${row.map(entry => entry.outcome).join(', ')}: ${docsInARow.ceiling} in a row that were not merged.`));
      else if (last.length === docs.window && bad >= docs.ceiling) recorded.push(...suspend(store, ['docs'], docs.rule, { ended: last.length, bad, entries: disposedEntries(last) }, `${bad} of the last ${last.length} docs follow-ups ended rejected, failed, declined or expired, which reaches the ceiling of ${docs.ceiling}.`));
    } else {
      const { disposed } = UPKEEP_CEILINGS, last = entries.slice(-disposed.window), bad = last.filter(badCandidate).length;
      if (last.length === disposed.window && bad >= disposed.ceiling) recorded.push(...suspend(store, [part], disposed.rule, { disposed: last.length, bad, entries: disposedEntries(last) }, `${bad} of the last ${last.length} ${part} candidates were declined or expired, which reaches the ceiling of ${disposed.ceiling}.`));
    }
  }
  recorded.push(...evaluateShare(store, { nowMs, config, window }));
  return recorded;
}

// ---- Reverts and regressions (from the first event) ----
// A merged upkeep change, kept for the revert rule: the last 20.
export function recordUpkeepMergeInTransaction(store, { flowId, taskId = null, nowMs = Date.now() }) {
  addToUpkeepWindowInTransaction(store, { merged: { flowId, ...(taskId ? { taskId } : {}), at: iso(nowMs) } });
}
// A revert of an upkeep change, or a regression recorded against one: one is the ceiling, and it
// suspends everything. `flowId` is the upkeep flow that delivered the change. A change that is
// not among the last 20 merged is outside the window; while fewer than 20 are on record, every
// upkeep change is inside it.
export function recordUpkeepRegressionInTransaction(store, { flowId, kind = 'regression' }) {
  assert(['regression', 'revert'].includes(kind) && typeof flowId === 'string' && flowId, 'a revert or a regression of one upkeep flow');
  const { merged } = upkeepWindow(store), { reverts } = UPKEEP_CEILINGS;
  if (!merged.some(row => row.flowId === flowId) && merged.length >= reverts.window) return [];
  return suspend(store, ['all'], reverts.rule, { flowId, kind }, `A ${kind} was recorded against the upkeep change that flow ${flowId} delivered. One is the ceiling: everything upkeep does is suspended until the operator has looked.`);
}

// ---- Lifting (the operator only) ----
export function liftUpkeepCeilingInTransaction(store, { part, note, by, nowMs = Date.now() }) {
  const lifted = liftUpkeepSuspensionInTransaction(store, { part, note, by }), windows = WINDOWS_OF_PART[part];
  // Learning delivery (14.3): its window starts again from now.
  if (part === 'learnings') restartLearningDeliveryInTransaction(store, { at: iso(nowMs) });
  if (windows.length) addToUpkeepWindowInTransaction(store, { since: Object.fromEntries(windows.map(name => [name, iso(nowMs)])) });
  return { ...lifted, liftedAt: iso(nowMs), evaluatedAfresh: windows };
}

// ---- The day totals have a start ----
// The share is only meaningful over days on which every settlement was counted, and the totals are
// maintained only while upkeep is on. Called where a configuration is written: turning upkeep on
// records when counting began, and turning it off forgets it.
export function noteUpkeepCountingInTransaction(store, before, after_, { nowMs = Date.now() } = {}) {
  const was = upkeepMode(before) !== 'off', is = upkeepMode(after_) !== 'off';
  if (was !== is) addToUpkeepWindowInTransaction(store, { counting: is ? iso(nowMs) : null });
}
