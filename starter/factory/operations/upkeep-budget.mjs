// Knowledge upkeep: the daily model limit and the maintained invocation totals (knowledge-upkeep
// design, 6.6 and 4.5). Everything here reads and writes by primary key: the day's upkeepDay row
// and the run. Functions named …InTransaction expect the caller's transaction.
//
// The daily limit. Before the provider starts, one transaction reads the day's row, refuses when
// reserved plus settled has reached the limit, and records a reservation under the attempt's id,
// so the same attempt never reserves twice. Settlement moves the reservation to settled. A failed,
// stopped or uncertain attempt stays counted; only an attempt settled as not dispatched, whose
// receipt names no invocation, is given back. An uncertain attempt keeps its reservation until
// attempt.resolve settles it.
//
// The invocation totals. While upkeep is not off, each attempt settlement adds the attempt's
// invocations to the day's row, counted by the one function the usage projection uses
// (operations/usage-accounting.mjs attemptInvocations), and records on the attempt that it was
// counted, so that it is never counted twice.
import { assert, id } from '../core/contracts.mjs';
import { isUpkeepFlow, upkeepMode } from '../core/upkeep-config.mjs';
import { hasUpkeepMarker } from '../core/upkeep-namespace.mjs';
import { attemptInvocations, projectUsage } from './usage-accounting.mjs';
import { addToUpkeepDayInTransaction, putUpkeepRunInTransaction, upkeepDay, upkeepDayId, upkeepRun } from './upkeep-records.mjs';

const iso = ms => new Date(ms).toISOString();

// ---- The daily reservation (6.6) ----
// Reserve one model run for an attempt, on the UTC day it is when the reservation is made. The
// clock (`now`) is read here, inside the transaction, and never earlier: a step that began before
// midnight and reserves after it is counted against the new day, whose limit it must respect.
// `flowId` is the source flow whose run the attempt assesses; the run then names its reservation,
// which is how settlement finds the day it was made on. Returns { reserved, repeated, day, used, limit }.
export function reserveUpkeepModelRunInTransaction(store, { attemptId, flowId = null, limit, now = Date.now }) {
  id(attemptId, 'attempt id');
  // The read and the write are one transaction, or the limit is not exact under concurrent starts.
  assert(store.db.isTransaction !== false, 'a model run is reserved inside a transaction');
  assert(typeof now === 'function', 'the reservation reads the clock itself: pass a clock, not a time');
  const nowMs = now(), run = flowId ? upkeepRun(store, flowId) : null, dayId = upkeepDayId(nowMs), day = upkeepDay(store, dayId), used = day.modelRunsReserved + day.modelRunsSettled;
  // The same attempt never reserves twice, whichever day it asks again on.
  if (run?.modelRun?.attemptId === attemptId) return { reserved: run.modelRun.status !== 'released', repeated: true, day: run.modelRun.day, used, limit };
  if (day.reservations?.[attemptId]) return { reserved: true, repeated: true, day: dayId, used, limit };
  if (!Number.isSafeInteger(limit) || used >= limit) return { reserved: false, repeated: false, day: dayId, used, limit };
  addToUpkeepDayInTransaction(store, dayId, { counters: { modelRunsReserved: 1 }, reservations: { [attemptId]: { ...(flowId ? { flowId } : {}), at: iso(nowMs) } } });
  if (run) putUpkeepRunInTransaction(store, { ...run, modelRun: { attemptId, day: dayId, status: 'reserved', reservedAt: iso(nowMs) } });
  store.event('upkeep.model-run-reserved', { attemptId, flowId, day: dayId, used: used + 1, limit });
  return { reserved: true, repeated: false, day: dayId, used: used + 1, limit };
}
// What the settled attempt's receipt shows was used: how many invocations, and their measured
// tokens where the provider's observation can be read. Counters only.
function observedUsage(attempt) {
  const entries = projectUsage([attempt]).filter(entry => !entry.duplicate), measured = entries.filter(entry => entry.tokens), tokens = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  for (const entry of measured) for (const name of Object.keys(tokens)) tokens[name] += entry.tokens[name];
  return { invocations: entries.length, tokens: measured.length ? tokens : null };
}
// The reservation an attempt holds, moved to settled, or given back. It is given back only when
// the attempt was settled as not dispatched and its receipt names no invocation: a receipt that
// names one is evidence that a model ran, whatever the attempt was reconciled as, and the run it
// used stays counted against the day (the counting function below counts it for the same reason).
// `flow` is the upkeep job's own flow. Without a reservation of this attempt (the run ended at its
// pre-filter, or it is not an upkeep flow) nothing is written.
export function settleUpkeepReservationInTransaction(store, attempt, flow, { nowMs = Date.now() } = {}) {
  const run = isUpkeepFlow(flow) && flow.jobPayload?.flowId ? upkeepRun(store, flow.jobPayload.flowId) : null, held = run?.modelRun;
  if (!held || held.attemptId !== attempt.id || held.status !== 'reserved') return null;
  const givenBack = attempt.status === 'not-dispatched' && attemptInvocations(attempt).length === 0, row = upkeepDay(store, held.day).reservations?.[attempt.id] ?? {};
  addToUpkeepDayInTransaction(store, held.day, { counters: { modelRunsReserved: -1, ...(givenBack ? {} : { modelRunsSettled: 1 }) }, reservations: { [attempt.id]: givenBack ? null : { ...row, settled: true } } });
  const { usage: previous, ...rest } = run, next = { ...rest, modelRun: { ...held, status: givenBack ? 'released' : 'settled', settledAt: iso(nowMs) }, ...(givenBack ? {} : { usage: observedUsage(attempt) }) };
  putUpkeepRunInTransaction(store, next);
  store.event(givenBack ? 'upkeep.model-run-released' : 'upkeep.model-run-settled', { attemptId: attempt.id, flowId: run.id, day: held.day });
  return next;
}
// Whether a run reached a model: it holds a reservation that was not given back. A run that ended
// at its pre-filter, at the daily limit or as `assessment-unavailable` did not.
export const upkeepRunReachedModel = run => ['reserved', 'settled'].includes(run?.modelRun?.status);

// ---- The invocation totals (4.5) ----
// An invocation is upkeep-attributed when its attempt belongs to the upkeep job's own flow or to a
// flow whose task snapshot carries a factory-written upkeep marker.
export const upkeepAttributed = flow => isUpkeepFlow(flow) || hasUpkeepMarker(flow?.taskSnapshot);
// Called in the transaction that settles an attempt (the engine's settlement, attempt.resolve),
// with the attempt as it is being settled: its new status and the receipt it keeps. It marks the
// attempt, which the caller then writes, and adds the count to the settlement day's row. With
// upkeep off nothing is read or written beyond the configuration in hand.
export function countAttemptInvocationsInTransaction(store, attempt, flow, { config = store.meta('config', {}), nowMs = Date.now() } = {}) {
  if (attempt.invocationsCounted || upkeepMode(config) === 'off') return null;
  const count = attemptInvocations(attempt).length, upkeep = upkeepAttributed(flow), day = upkeepDayId(nowMs);
  attempt.invocationsCounted = { day, count, upkeep };
  if (count) addToUpkeepDayInTransaction(store, day, { counters: { invocations: count, ...(upkeep ? { upkeepInvocations: count } : {}) } });
  return attempt.invocationsCounted;
}
