import { now } from '../core/contracts.mjs';
import { isUpkeepFlow } from '../core/upkeep-config.mjs';
import { defaultTarget, pendingTargetSync, targetHealth, targetSyncHolds } from './targets.mjs';
import { scheduledTierHold } from './main-tiers.mjs';

// A merge moves its target and makes its health unknown until the post-merge verification
// passes. Change work for that target is held at admission while a merge is decided or running,
// and a flow already admitted waits at its source step (instead of stopping there) while a merge
// is in flight or the target's verification is on its way. It proceeds by itself once the target
// is verified green again; a red verification, or a pending or held target synchronization,
// still stops it at source as before.
//
// "In flight" and "on its way" are judged from the flow that does the work, never from a job's
// status alone: a stopped, stop-requested or uncertain merge or verifier promises nothing. A
// verification that cannot proceed stops the waiting flow with a reason naming the verifier and
// its recovery, so no wait lasts without an operator-visible signal.

// The live flow and job sets, read once per database state: every source-flow check in a tick
// shares them until something is written (Store.changeToken is two constant-time reads). A store
// view without a change token (the dashboard's projecting facade) is read directly.
const cache = new WeakMap();
function liveSets(store) {
  const token = store.changeToken?.(), hit = token === undefined ? null : cache.get(store);
  if (hit && hit.token === token) return hit;
  const sets = { token, flows: store.live('flow'), jobs: store.live('job') };
  if (token !== undefined) cache.set(store, sets);
  return sets;
}
// A flow record as stored. Live sets may be projections (the dashboard's facade keeps only list
// fields), so the few flows a decision depends on are read whole by primary key.
function whole(store, flow) {
  if (!flow || flow.workflow) return flow;
  const row = store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get('flow', flow.id);
  return row ? JSON.parse(row.data) : flow;
}
// A flow that is doing work now or will by itself: not finished, stopped or asked to stop, not held
// by a decision, not waiting for a flow slot (operations/capacity.mjs: it starts only when another
// flow gives one up, so nothing may wait on it), and without an uncertain attempt.
function progressing(store, flow) {
  if (!flow || ['completed', 'failed', 'stopped'].includes(flow.state) || flow.stopRequested || flow.decisionHold || flow.slotWait) return false;
  if (!flow.attemptId) return true;
  const row = store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get('attempt', flow.attemptId);
  return !row || JSON.parse(row.data).status !== 'uncertain';
}

// Why a flow is not progressing, for an operator reason.
function notProgressing(flow) {
  if (!flow) return 'has no flow';
  if (flow.state === 'stopped' || flow.stopRequested) return `is stopped${flow.stopReason ? ` (${String(flow.stopReason).slice(0, 200)})` : ''}`;
  if (flow.decisionHold) return 'is held by a decision';
  if (flow.slotWait) return 'is waiting for a flow slot';
  if (['completed', 'failed'].includes(flow.state)) return `has ${flow.state}`;
  return 'has an uncertain attempt';
}
// Flows whose current step is a forge.merge for this target and that are progressing (answered
// `merge`, preparing or running). Reads the live flow set only (store.live), never flow history.
export function mergesInFlight(store, target) {
  const fallback = defaultTarget(store.meta('config', {}));
  return liveSets(store).flows
    .filter(flow => !['completed', 'failed', 'stopped'].includes(flow.state) && flow.step && (flow.target ?? fallback) === target)
    .map(flow => whole(store, flow))
    .filter(flow => flow.workflow?.nodes?.[flow.step]?.action?.operation === 'forge.merge' && progressing(store, flow))
    .map(flow => ({ flowId: flow.id, attemptId: flow.attemptId ?? null }));
}
// Merges into one target run one at a time (dev.84, H8). Two merges dispatched together race at
// the forge: the second is refused as out of date and goes back through integration, review and
// the merge question. So a merge step waits while another flow's merge into the same target is
// running (its forge.merge attempt is prepared, dispatched or running) or has merged and is at its
// post-merge step. When that has finished, the waiting merge step runs and does what it always
// does: it reads the target, and merges onto a move that does not touch the candidate without a
// new review, or returns the flow to integration when it does (workflows/dispatch.mjs, forge.merge).
// Only flows that are progressing count, so a stopped flow or an uncertain merge never holds
// another merge, and a flow waiting here holds no attempt, so two waits cannot hold each other.
export function mergesAhead(store, target, { exceptFlowId } = {}) {
  const fallback = defaultTarget(store.meta('config', {}));
  return liveSets(store).flows
    .filter(flow => flow.id !== exceptFlowId && !['completed', 'failed', 'stopped'].includes(flow.state) && flow.step && (flow.target ?? fallback) === target)
    .map(flow => whole(store, flow))
    .flatMap(flow => {
      const operation = flow.workflow?.nodes?.[flow.step]?.action?.operation;
      if (operation === 'forge.merge' && flow.attemptId && progressing(store, flow)) return [{ flowId: flow.id, stage: 'merge', attemptId: flow.attemptId }];
      if (operation === 'postMerge' && flow.results?.merge?.merged === true && progressing(store, flow)) return [{ flowId: flow.id, stage: 'post-merge', attemptId: flow.attemptId ?? null }];
      return [];
    });
}
export const mergeOrderReason = (target, rows) => `Waiting: ${rows.map(row => `flow ${row.flowId} is ${row.stage === 'merge' ? 'merging into' : 'finishing its post-merge step after merging into'} ${target}`).join('; ')}. Merges into one target run one at a time; this merge starts when that has finished, then reads ${target} again: it merges without a new review when ${target}'s new commits do not touch this candidate's files, and goes back to integration when they do`;
// Recorded once per wait, like a source wait: an unchanged wait writes nothing.
export function markMergeWait(store, flow, target, rows) {
  const next = { step: flow.step, target, flowIds: rows.map(row => row.flowId), reason: mergeOrderReason(target, rows) };
  if (flow.state === 'waiting' && flow.mergeWait?.reason === next.reason && flow.mergeWait.step === next.step) return true;
  flow.mergeWait = { ...next, since: flow.mergeWait?.since ?? now() }; flow.state = 'waiting'; store.put('flow', flow);
  store.event('flow.merge-wait', { flowId: flow.id, taskId: flow.taskId, ...next });
  return true;
}
export function clearMergeWait(store, flow) {
  if (!flow.mergeWait) return;
  const { step, target, since } = flow.mergeWait; delete flow.mergeWait;
  if (flow.state === 'waiting') flow.state = 'ready';
  store.put('flow', flow); store.event('flow.merge-released', { flowId: flow.id, step, target, since });
}
// The first main.verify job queued or running for the target (from the live job set), with whether
// it can actually proceed and, if not, why.
export function pendingVerification(store, target) {
  const fallback = defaultTarget(store.meta('config', {})), { flows, jobs } = liveSets(store);
  const job = jobs.find(row => row.operation === 'main.verify' && ['queued', 'running'].includes(row.status) && (row.payload?.target ?? fallback) === target);
  if (!job) return undefined;
  if (job.status === 'running') {
    const flow = job.flowId ? whole(store, { id: job.flowId }) : null, found = flow?.workflow ? flow : null;
    if (progressing(store, found)) return { job };
    const state = notProgressing(found);
    return { job, blocked: { flowId: found?.id ?? null, text: `its verifier flow ${found?.id ?? job.flowId ?? '(missing)'} ${state}` } };
  }
  // Queued: it starts when the maintenance slot is free (operations loop: one unfinished
  // non-integration maintenance flow at a time; an upkeep assessment has its own lane and never
  // occupies this one). An occupant that is not progressing (stopped,
  // decision-held, uncertain) keeps the slot until it is recovered, and a maintenance hold keeps it shut.
  if (store.meta('maintenanceHeld')) return { job, blocked: { flowId: null, text: 'maintenance is held (pause with holdMaintenance)' } };
  const occupant = flows.filter(flow => flow.kind === 'maintenance' && !['completed', 'failed'].includes(flow.state)).map(flow => whole(store, flow)).find(flow => !flow.integration && !isUpkeepFlow(flow) && !progressing(store, flow));
  if (occupant) return { job, blocked: { flowId: occupant.id, text: `it cannot start while maintenance flow ${occupant.id}, which ${notProgressing(occupant)}, holds the maintenance slot` } };
  return { job };
}
export const freshGreen = (store, health, nowMs = Date.now()) => {
  const config = store.meta('config', {}), checked = Date.parse(health?.checkedAt ?? health?.observedAt);
  return health?.status === 'green' && Number.isFinite(checked) && checked <= nowMs && nowMs - checked <= (config.policy?.mainHealthMaxAgeMs ?? 3600000) && !scheduledTierHold(config, health, nowMs);
};
export const mergeInFlightReason = (target, rows) => `${target} merge in progress (flow ${rows.map(row => row.flowId).join(', ')}); new work waits for it and its post-merge verification`;

// Why a flow at its source step should wait rather than verify (or stop): null when it should not.
export function sourceWait(store, target, { exceptFlowId, nowMs = Date.now() } = {}) {
  // Target synchronization keeps its own documented stop-and-resume handling.
  if (pendingTargetSync(store, target) || targetSyncHolds(store, target).length) return null;
  const merging = mergesInFlight(store, target).filter(row => row.flowId !== exceptFlowId);
  if (merging.length) return { target, kind: 'merge', flowIds: merging.map(row => row.flowId), reason: `Waiting: ${mergeInFlightReason(target, merging)}` };
  const health = targetHealth(store, target);
  if (freshGreen(store, health, nowMs) || health?.status === 'red') return null;
  const pending = pendingVerification(store, target);
  if (!pending) return null;
  const { job, blocked } = pending;
  if (blocked) return { target, kind: 'verification', jobId: job.id, blocked: true, verifierFlowId: blocked.flowId,
    reason: `${target} needs verification, but main.verify job ${job.id} cannot proceed: ${blocked.text}. Recover the verifier first: resume ${blocked.flowId ? `flow ${blocked.flowId}` : 'it'} (resume) or abandon it (flow.abandon) and run main.verify again (or doctor). Then resume this flow; it waits for the verification and continues when ${target} is green.` };
  return { target, kind: 'verification', jobId: job.id, reason: `Waiting: ${target} verification ${job.status === 'running' ? 'is running' : 'is queued'} (job ${job.id}); this flow continues when ${target} is verified green` };
}
// Recorded once per wait: an unchanged wait writes nothing, so parked questions are not woken.
export function markSourceWait(store, flow, wait) {
  const next = { step: flow.step, ...wait };
  if (flow.state === 'waiting' && flow.targetWait?.reason === next.reason && flow.targetWait.step === next.step) return true;
  flow.targetWait = { ...next, since: flow.targetWait?.since ?? now() }; flow.state = 'waiting'; store.put('flow', flow);
  store.event('flow.target-wait', { flowId: flow.id, taskId: flow.taskId, ...next });
  return true;
}
export function clearSourceWait(store, flow) {
  if (!flow.targetWait) return;
  const { step, kind, target } = flow.targetWait; delete flow.targetWait;
  if (flow.state === 'waiting') flow.state = 'ready';
  store.put('flow', flow); store.event('flow.target-released', { flowId: flow.id, step, kind, target });
}
