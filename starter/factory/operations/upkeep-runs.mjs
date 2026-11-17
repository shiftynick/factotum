// Knowledge upkeep: the life of one run (knowledge-upkeep design, section 5).
//
//   merge settled        -> a pending receipt, with pendingUntil (5.1)
//   retrospective exists -> a queued job, with runBy (5.1, 5.3)
//   the upkeep lane      -> a one-node maintenance flow that runs the assessment (5.2)
//   settlement           -> closed, with the outcome the run recorded (8.5)
//
// Every read here is by primary key or a meta key (4.5). Nothing here starts a process: the
// assessment itself runs in the flow's own attempt (workflows/upkeep-assess.mjs). This module
// imports no adapter and nothing from core/project.mjs, so the engine, the project commands, the
// retrospective and the operations tick can all call it.
import { assert, digest, now } from '../core/contracts.mjs';
import { UPKEEP_OPERATION, isUpkeepFlow, isUpkeepJob, upkeepMode, upkeepSettings } from '../core/upkeep-config.mjs';
import { hasUpkeepMarker } from '../core/upkeep-namespace.mjs';
import { VALIDATOR_RULES } from './upkeep-assessment.mjs';
import { settleUpkeepReservationInTransaction, upkeepRunReachedModel } from './upkeep-budget.mjs';
import { expireObservedClassesInTransaction } from './upkeep-candidates.mjs';
import { evaluateRunCeilingsInTransaction } from './upkeep-ceilings.mjs';
import { MAX_TRACKED_UPKEEP_RUNS, UPKEEP_PENDING_MS, addToUpkeepDayInTransaction, addToUpkeepWindowInTransaction, putUpkeepRunInTransaction, recordUpkeepSuspensionInTransaction, trackUpkeepRunInTransaction, upkeepAccess, upkeepDayId, upkeepRun, upkeepSuspended, upkeepWorkRuns, UpkeepAccessUnavailable } from './upkeep-records.mjs';

export const UPKEEP_JOB_POLICY = 'upkeep.mode';
export { isUpkeepFlow, isUpkeepJob };
const finished = flow => ['completed', 'failed'].includes(flow?.state);
const iso = ms => new Date(ms).toISOString();
// Whether a record exists, without reading it: a retrospective carries its flow's events.
const exists = (store, kind, key) => Boolean(store.db.prepare('SELECT 1 FROM records WHERE kind=? AND id=?').get(kind, key));

// ---- What a run records (8.5): bounded enums and counters, never text ----
// The outcome: `nothing`, `abstained`, `invalid` (everything the model returned was dropped by the
// validator) or `candidates` (what it produced, counted by kind; in observe mode no row is written).
export const UPKEEP_OUTCOMES = Object.freeze(['nothing', 'abstained', 'invalid', 'candidates']);
// The stage that decided.
export const UPKEEP_STAGES = Object.freeze(['receipt', 'queue', 'start', 'pre-filter', 'reservation', 'model', 'validator']);
// Why a run ended as it did. The first eight are the design's reasons for ending without a model
// call (6.2, 5.3); then the ways a run can end before or without its pre-filter; then the model's
// own abstentions (6.3) and what the model stage and the validator decide.
// `assessment-unavailable`: the pre-filter found something to assess and no model could be started
// (every provider the step could start is held). No model ran: it is not a run that reached a model.
export const UPKEEP_REASONS = Object.freeze(['no-referring-doc', 'weak-signals-only', 'suspended', 'budget', 'backlog-full', 'governing-unresolvable', 'no-retrospective', 'stale-run', 'assessment-unavailable', 'learnings-unresolvable', 'mode-off', 'work-limit', 'merge-commit-unavailable', 'error', 'stopped',
  'insufficient-evidence', 'not-repeatable', 'already-covered', 'no-candidate', 'all-dropped', 'observed', 'proposed', 'model-failed', 'turn-limit']);
// What was truncated is among the flags: `input-truncated` (a candidate file's excerpts were cut,
// so nothing is accepted for it), `diff-truncated`, `signals-truncated`, `lists-truncated`.
export const UPKEEP_FLAGS = Object.freeze(['no-signal', 'governing-unresolvable', 'learnings-unresolvable', 'backlog-full', 'docs-suspended', 'context-suspended', 'capture-suspended', 'model-suspended', 'docs-scan-truncated', 'docs-not-declared', 'input-truncated', 'diff-truncated', 'signals-truncated', 'lists-truncated']);
export const UPKEEP_COUNTS = Object.freeze(['touchedPaths', 'docsFiles', 'docCandidates', 'contextCandidates', 'verifiedSignals', 'weakSignals', 'filesRead', 'inputChars', 'evidenceItems', 'filesShown', 'filesTruncated', 'docs', 'context', 'capture', 'dropped', 'flagged']);
// The counts the validator dropped, by the rule that dropped them (operations/upkeep-assessment.mjs).
export const UPKEEP_DROP_RULES = VALIDATOR_RULES;
const counters = (names, source) => Object.fromEntries(names.filter(name => Number.isSafeInteger(source?.[name]) && source[name] >= 0).map(name => [name, Math.min(source[name], 1_000_000)]));
// The outcome an assessment reported, reduced to what a run may record. Anything else is dropped.
export function upkeepOutcome(report) {
  if (!report || typeof report !== 'object' || !UPKEEP_OUTCOMES.includes(report.outcome) || !UPKEEP_REASONS.includes(report.reason)) return null;
  const dropped = counters(UPKEEP_DROP_RULES, report.dropped);
  return { outcome: report.outcome, reason: report.reason, stage: UPKEEP_STAGES.includes(report.stage) ? report.stage : 'pre-filter',
    flags: UPKEEP_FLAGS.filter(flag => Array.isArray(report.flags) && report.flags.includes(flag)),
    counts: counters(UPKEEP_COUNTS, report.counts), ...(Object.keys(dropped).length ? { dropped } : {}) };
}

// ---- Deadlines (5.3) ----
// runBy is fixed when a receipt is first queued. A smaller configured age shortens it for a run
// that has not started; a larger one never moves it later (putUpkeepRunInTransaction refuses that).
function effectiveRunBy(run, config) {
  if (!run.runBy) return null;
  const configured = Date.parse(run.firstQueuedAt ?? run.runBy) + upkeepSettings(config).budget.maxQueueAgeMs;
  return Math.min(Date.parse(run.runBy), configured);
}
function withRunBy(run, config) { const at = effectiveRunBy(run, config); return at !== null && at < Date.parse(run.runBy) ? { ...run, runBy: iso(at) } : run; }

function close(store, run, { outcome, reason, stage, flags = [], counts = {}, dropped }, nowMs) {
  const { dropped: before, ...rest } = run, at = iso(nowMs), closed = { ...rest, status: 'closed', outcome, reason, stage, flags, counts, ...(dropped ? { dropped } : {}), closedAt: at };
  putUpkeepRunInTransaction(store, closed);
  addToUpkeepDayInTransaction(store, upkeepDayId(nowMs), { outcomes: { [`${outcome}:${reason}`]: 1 } });
  // The window entry says whether the run reached a model and whether it produced a candidate: the
  // two rates of 8.3 are read from it.
  addToUpkeepWindowInTransaction(store, { run: { flowId: run.id, outcome, reason, stage, at, model: upkeepRunReachedModel(closed), candidates: outcome === 'candidates' } });
  store.event('upkeep.run-closed', { flowId: run.id, outcome, reason, stage });
  // 8.3: the ceilings are evaluated here, when a run is recorded, and nowhere on a timer. A count
  // that reaches one suspends its part, with one notice.
  evaluateRunCeilingsInTransaction(store, { nowMs });
  // 4.5: observed classes past their age go here, once per run settlement, through their own index.
  expireObservedClassesInTransaction(store, { nowMs });
  return closed;
}
const abstain = (store, run, reason, stage, nowMs) => close(store, run, { outcome: 'abstained', reason, stage }, nowMs);
function revokeJob(store, jobId, reason) {
  const job = jobId ? store.get('job', jobId) : null;
  if (!job || job.status !== 'queued') return;
  store.put('job', { ...job, status: 'revoked', reason, finishedAt: now() }); store.event('maintenance.revoked', { jobId: job.id, reason });
}

// ---- The pending receipt (5.1) ----
// Called inside the transaction that settles a forge.merge result as merged. One receipt per
// source flow; a flow whose task carries the upkeep marker gets none (7.7: no recursion), and
// neither does anything that is not a change or document flow.
export function writeUpkeepReceiptInTransaction(store, flow, result, { nowMs = Date.now(), config = store.meta('config', {}) } = {}) {
  if (upkeepMode(config) === 'off' || flow.kind !== 'change' || hasUpkeepMarker(flow.taskSnapshot)) return null;
  if (!/^[a-f\d]{40,64}$/i.test(result?.sha ?? '') || upkeepRun(store, flow.id)) return null;
  const base = flow.results?.integrate?.base ?? result.expectedBase ?? null;
  const run = { id: flow.id, status: 'pending', taskId: flow.taskId, mergeCommit: result.sha, base: /^[a-f\d]{40,64}$/i.test(base ?? '') ? base : null, target: flow.target ?? config.repository?.target ?? null, mergedAt: iso(nowMs), pendingUntil: iso(nowMs + UPKEEP_PENDING_MS), queues: 0, runs: 0 };
  // More receipts in hand than the tick will track: this one is recorded and closed, not left untracked.
  if (upkeepWorkRuns(store).length >= MAX_TRACKED_UPKEEP_RUNS) { putUpkeepRunInTransaction(store, run); return abstain(store, run, 'work-limit', 'receipt', nowMs); }
  putUpkeepRunInTransaction(store, run); store.event('upkeep.receipt', { flowId: flow.id, mergeCommit: run.mergeCommit });
  return run;
}

// ---- Pending -> queued, or closed (5.1, 5.3) ----
// A pending receipt is looked at when its flow's retrospective is recorded and on every tick that
// has upkeep work. It is closed at a deadline or when the mode is off; it is queued once the
// retrospective exists and the flow has finished or stopped, unless maintenance is held for a drain.
function advancePending(store, run, { nowMs, config, held }) {
  if (upkeepMode(config) === 'off') return abstain(store, run, 'mode-off', 'queue', nowMs);
  // Queued once already: the run-by deadline it was given then still governs.
  if (run.runBy) { if (nowMs >= effectiveRunBy(run, config)) return abstain(store, withRunBy(run, config), 'stale-run', 'queue', nowMs); }
  else if (nowMs >= Date.parse(run.pendingUntil)) return abstain(store, run, 'no-retrospective', 'receipt', nowMs);
  // A smaller configured age shortens the deadline for good, whatever happens next: it is written
  // now, before any return, so a hold (or a flow that is not ready) cannot let a later, larger age
  // restore the longer one.
  const shortened = withRunBy(run, config);
  if (shortened !== run) { putUpkeepRunInTransaction(store, shortened); store.event('upkeep.deadline-shortened', { flowId: run.id, runBy: shortened.runBy }); run = shortened; }
  if (held) return run;
  const flow = store.get('flow', run.id);
  if (!flow || !(finished(flow) || flow.state === 'stopped') || !exists(store, 'retrospective', run.id)) return run;
  const queues = (run.queues ?? 0) + 1, jobId = digest({ operation: UPKEEP_OPERATION, flowId: run.id, queued: queues });
  const firstQueuedAt = run.firstQueuedAt ?? iso(nowMs), runBy = run.runBy ?? iso(nowMs + upkeepSettings(config).budget.maxQueueAgeMs);
  const grant = run.manualGrant ?? { actor: 'operator', source: 'configuration', policy: UPKEEP_JOB_POLICY, note: 'Assess a proven merge for knowledge upkeep (configured upkeep.mode)' };
  if (!store.get('job', jobId)) store.put('job', { id: jobId, operation: UPKEEP_OPERATION, payload: { flowId: run.id }, grant: { ...grant, configDigest: store.meta('configDigest') }, status: 'queued', createdAt: iso(nowMs) });
  const { manualGrant, ...rest } = run, queued = withRunBy({ ...rest, status: 'queued', jobId, queues, firstQueuedAt, runBy }, config);
  putUpkeepRunInTransaction(store, queued); store.event('upkeep.queued', { flowId: run.id, jobId, runBy: queued.runBy });
  return queued;
}
const toPending = (store, run, why) => { const { jobId, assessmentFlowId, startedAt, ...rest } = run, pending = { ...rest, status: 'pending' }; putUpkeepRunInTransaction(store, pending); store.event('upkeep.returned', { flowId: run.id, reason: why }); return pending; };

// The retrospective hook: called in the transaction that records a flow's retrospective, when the
// flow finishes and when it stops. With no receipt for the flow this is one read by key.
export function upkeepAfterRetrospectiveInTransaction(store, flowId, { nowMs = Date.now() } = {}) {
  const run = upkeepRun(store, flowId);
  if (run?.status !== 'pending') return run ?? null;
  return advancePending(store, run, { nowMs, config: store.meta('config', {}), held: Boolean(store.meta('maintenanceHeld')) });
}

// ---- The tick (5.2, 5.3) ----
// Ends an upkeep flow that is stopped with nothing running: the factory abandons it, as
// flow.abandon would (no attempt, no merge). It raises no notice.
function abandonFlow(store, flow, reason) {
  const at = now(); Object.assign(flow, { state: 'failed', stopRequested: true, abandonedAt: at, finishedAt: at, abandonReason: reason }); store.put('flow', flow);
  const job = flow.jobId ? store.get('job', flow.jobId) : null;
  if (job && !['completed', 'failed', 'revoked', 'abandoned'].includes(job.status)) { store.put('job', { ...job, status: 'abandoned', finishedAt: at, reason }); store.event('job.settled', { jobId: job.id, flowId: flow.id, status: 'abandoned' }); }
  store.event('flow.abandoned', { flowId: flow.id, note: reason, by: 'factory', workspaceRetained: false });
}
export const UPKEEP_DRAIN_STOP = 'Knowledge upkeep assessment stopped: maintenance is held for a drain. Its receipt returns to pending and keeps its deadline.';
// Called by the operations tick only when the upkeepWork meta row names a run. `held` is the
// maintenance hold a drain sets (pause with holdMaintenance). Returns what it did, for the caller's log.
export function upkeepTickInTransaction(store, tracked, { nowMs = Date.now(), config = store.meta('config', {}), held = Boolean(store.meta('maintenanceHeld')) } = {}) {
  const done = [];
  for (const { id } of tracked) {
    let run = upkeepRun(store, id);
    // Tracked, but closed or never written: it is not work in hand.
    if (!run || run.status === 'closed') { trackUpkeepRunInTransaction(store, id, null); continue; }
    if (run.status === 'running') {
      const flow = run.assessmentFlowId ? store.get('flow', run.assessmentFlowId) : null;
      if (flow && !finished(flow)) {
        const settledAttempt = !flow.attemptId;
        // A drain is not held up by an assessment: it is asked to stop, quietly, and ended once nothing runs.
        if (held && !flow.stopRequested) { Object.assign(flow, { stopRequested: true, abortRequested: true, state: 'stopped', stopReason: UPKEEP_DRAIN_STOP, stopSequence: (flow.stopSequence ?? 0) + 1 }); store.put('flow', flow); store.event('flow.stopped', { flowId: flow.id, reason: UPKEEP_DRAIN_STOP, abort: true, stopSequence: flow.stopSequence, by: 'factory' }); done.push({ id, action: 'stop-requested' }); continue; }
        // Stopped with nothing running (after the abort settled, or stopped for a fault): ended by the
        // factory. An unsettled attempt is left for the existing reconciliation; nothing is weakened.
        if (flow.state === 'stopped' && settledAttempt) { abandonFlow(store, flow, held ? 'ended for a drain; the receipt returns to pending' : 'a stopped assessment is ended, not retried'); }
        else continue;
      }
      const ended = run.assessmentFlowId ? store.get('flow', run.assessmentFlowId) : null;
      // Ended for a drain (by the factory under a hold, or by an abandon while held): back to pending,
      // unless the run had already reached a model. An assessment is never retried by itself (6.6),
      // so a run whose model call a drain cut short is closed with the model run it used.
      if (ended?.abandonedAt && held && !upkeepRunReachedModel(run)) run = toPending(store, run, 'drain');
      else { done.push({ id, action: 'closed' }); abstain(store, run, ended?.abandonedAt ? 'stopped' : 'error', upkeepRunReachedModel(run) ? 'model' : 'start', nowMs); continue; }
    }
    if (run.status === 'queued') {
      const job = run.jobId ? store.get('job', run.jobId) : null;
      if (upkeepMode(config) === 'off') { revokeJob(store, run.jobId, 'knowledge upkeep was turned off'); abstain(store, run, 'mode-off', 'queue', nowMs); done.push({ id, action: 'closed' }); continue; }
      if (nowMs >= effectiveRunBy(run, config)) { revokeJob(store, run.jobId, 'the run-by deadline of this upkeep run passed'); abstain(store, withRunBy(run, config), 'stale-run', 'queue', nowMs); done.push({ id, action: 'closed' }); continue; }
      if (job?.status === 'queued') { const shortened = withRunBy(run, config); if (shortened !== run) putUpkeepRunInTransaction(store, shortened); continue; }
      // Its job was revoked (a configuration change) or is gone: the receipt returns to pending.
      run = toPending(store, run, job ? `job ${job.status}` : 'job missing');
    }
    if (run.status === 'pending') { const next = advancePending(store, run, { nowMs, config, held }); if (next.status !== 'pending') done.push({ id, action: next.status }); }
  }
  return done;
}

// ---- Starting a run (the upkeep lane, 5.2) ----
// Called in the transaction that admits the job's flow. Returns null when the run may start, or
// the reason it may not; then the job is revoked and no flow is created.
export function startUpkeepRunInTransaction(store, job, flow, { nowMs = Date.now(), config = store.meta('config', {}) } = {}) {
  const run = upkeepRun(store, job.payload?.flowId ?? '');
  if (!run || run.status !== 'queued' || run.jobId !== job.id) return 'this job is not the queued job of an upkeep run';
  if (upkeepMode(config) === 'off') { abstain(store, run, 'mode-off', 'start', nowMs); return 'knowledge upkeep is off'; }
  if (nowMs >= effectiveRunBy(run, config)) { abstain(store, withRunBy(run, config), 'stale-run', 'start', nowMs); return 'the run-by deadline of this upkeep run passed'; }
  // Upkeep never reads a whole kind in place of an index (4.5): it suspends itself instead of running.
  const access = upkeepAccess(store);
  if (!access.available) recordUpkeepSuspensionInTransaction(store, { part: 'all', rule: 'unverified-kind', window: { kinds: access.unverified }, reason: new UpkeepAccessUnavailable(access.unverified).message });
  if (upkeepSuspended(store, 'all')) { abstain(store, run, 'suspended', 'start', nowMs); return 'knowledge upkeep is suspended'; }
  putUpkeepRunInTransaction(store, { ...withRunBy(run, config), status: 'running', assessmentFlowId: flow.id, startedAt: iso(nowMs), runs: (run.runs ?? 0) + 1 });
  store.event('upkeep.started', { flowId: run.id, jobId: job.id, assessmentFlowId: flow.id });
  return null;
}

// ---- Settlement (8.5) ----
// Called in the transaction that settles the assessment's attempt, with the attempt as it is being
// settled. The model run it reserved, if any, is moved to settled first: a failed or stopped
// attempt stays counted against the day (6.6). Then a passed attempt closes the run with the
// outcome it reported. An aborted one (a drain) leaves the run to the tick, which returns it to
// pending. Anything else closes it: an assessment is never retried by itself.
export function settleUpkeepRunInTransaction(store, flow, { passed, aborted, result, attempt = null, turnLimit = false, nowMs = Date.now() }) {
  if (attempt) settleUpkeepReservationInTransaction(store, attempt, flow, { nowMs });
  const run = upkeepRun(store, flow.jobPayload?.flowId ?? '');
  if (!run || run.status !== 'running' || run.assessmentFlowId !== flow.id || aborted) return null;
  const outcome = passed ? upkeepOutcome(result?.upkeepRun) : null;
  // A run whose attempt failed after it reserved a model run ended at the model, not before it.
  const failed = upkeepRunReachedModel(run) ? { outcome: 'abstained', reason: turnLimit ? 'turn-limit' : 'model-failed', stage: 'model' } : { outcome: 'abstained', reason: 'error', stage: 'pre-filter' };
  return close(store, run, outcome ?? failed, nowMs);
}

// ---- A run by hand (5.1) ----
// job.enqueue {operation: knowledge.upkeep, payload: {flowId}}: the operator, or the orchestrator
// where job.enqueue is delegated, runs upkeep for one merged flow. It moves no deadline: a receipt
// keeps the ones it has, and a run past them is refused, not revived.
export function enqueueManualUpkeepInTransaction(store, { flowId, grant, nowMs = Date.now() }) {
  const config = store.meta('config', {});
  assert(typeof flowId === 'string' && flowId, 'knowledge.upkeep needs payload.flowId: the merged flow to assess');
  assert(upkeepMode(config) !== 'off', 'knowledge upkeep is off (upkeep.mode); the operator turns it on');
  const flow = store.get('flow', flowId);
  assert(flow && flow.kind === 'change' && flow.results?.merge?.merged === true && /^[a-f\d]{40,64}$/i.test(flow.results.merge.sha ?? ''), `flow ${flowId} is not a change or document flow with a proven merge`);
  assert(!hasUpkeepMarker(flow.taskSnapshot), `flow ${flowId} delivered an upkeep task; upkeep does not assess its own work`);
  assert(finished(flow) || flow.state === 'stopped', `flow ${flowId} has not finished or stopped yet; its run is queued when its retrospective is recorded`);
  assert(exists(store, 'retrospective', flowId), `flow ${flowId} has no retrospective; record it first (job.enqueue retrospective with payload.flowId)`);
  assert(!store.meta('maintenanceHeld'), 'maintenance is held (pause with holdMaintenance); no upkeep run is queued until it is released');
  let run = upkeepRun(store, flowId);
  if (run) {
    assert(run.status !== 'queued' && run.status !== 'running', `the upkeep run of flow ${flowId} is already ${run.status}`);
    if (run.runBy) assert(nowMs < effectiveRunBy(run, config), `the upkeep run of flow ${flowId} passed its run-by deadline (${run.runBy}); a deadline is never moved later, so it cannot run again`);
    else assert(nowMs < Date.parse(run.pendingUntil), `the upkeep receipt of flow ${flowId} passed its pending deadline (${run.pendingUntil}); a deadline is never moved later, so it cannot be queued`);
    // A run by hand is a new run of the receipt: what the last one recorded, its model run included, is not carried into it.
    const { outcome, reason, stage, flags, counts, dropped, usage, modelRun, closedAt, jobId, assessmentFlowId, startedAt, ...rest } = run;
    run = { ...rest, status: 'pending', manualGrant: grant }; putUpkeepRunInTransaction(store, run);
  } else {
    run = { id: flow.id, status: 'pending', taskId: flow.taskId, mergeCommit: flow.results.merge.sha, base: flow.results.integrate?.base ?? flow.results.merge.expectedBase ?? null, target: flow.target ?? config.repository?.target ?? null, mergedAt: iso(nowMs), pendingUntil: iso(nowMs + UPKEEP_PENDING_MS), queues: 0, runs: 0, manualGrant: grant };
    assert(upkeepWorkRuns(store).length < MAX_TRACKED_UPKEEP_RUNS, `${MAX_TRACKED_UPKEEP_RUNS} upkeep runs are already in hand; wait for them`);
    putUpkeepRunInTransaction(store, run);
  }
  const queued = advancePending(store, run, { nowMs, config, held: false });
  assert(queued.status === 'queued', `the upkeep run of flow ${flowId} could not be queued (${queued.reason ?? queued.status})`);
  return store.need('job', queued.jobId);
}
