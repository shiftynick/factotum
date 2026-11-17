import { projectTargets, targetHealth, targetSyncHolds } from './targets.mjs';
import { mainHealthReason } from './main-health-reason.mjs';
import { scheduledTierHold } from './main-tiers.mjs';
import { timeoutRetryState } from './timeout-retry.mjs';
import { mergesInFlight, mergeInFlightReason } from './merge-hold.mjs';
import { latestJob } from '../core/records.mjs';
import { capacityView } from './capacity.mjs';
import { contextProviderHold } from './admission.mjs';
import { openContextTask } from './upkeep-tasks.mjs';
import { tickProblems } from './tick-problems.mjs';

// What stops the queue as a whole from moving, for the Queue tab: holds, qualification and
// main health, plus whether admission is automatic and the last manual dispatch's outcome.
// Per-task reasons stay with each task (admissionReasons).
// `capacity` says who holds the flow slots: per pool the slots in use and free, the flows parked
// on an answer (which hold none, up to policy.maxParkedFlows) and the answered flows waiting for
// a slot, each with its reason and place in line (operations/capacity.mjs).
export const DISPATCH_REFUSED_SHOWN = 10;
export function queueStatus(store, { nowMs = Date.now() } = {}) {
  const config = store.meta('config', {}), delivery = config.mode === 'delivery', holds = [];
  if (store.meta('paused')) holds.push({ kind: 'paused', text: 'Admission is paused. Resume it from Overview.' });
  if (store.meta('recoveryHold')) holds.push({ kind: 'recovery', text: 'A recovery hold is in place; see Operations.' });
  if (store.meta('retentionHold')) holds.push({ kind: 'retention', text: 'A retention hold is in place; see Operations.' });
  if (store.meta('moneyHold', false)) holds.push({ kind: 'money', text: 'A spending overrun hold is in place; see Operations.' });
  if (delivery && !(store.meta('commissioning')?.ready && store.meta('commissioning')?.configDigest === store.meta('configDigest'))) holds.push({ kind: 'doctor', text: 'The current configuration has not passed doctor yet; run doctor.' });
  const maxAge = config.policy?.mainHealthMaxAgeMs ?? 3600000, targets = projectTargets(store);
  for (const target of delivery ? targets : []) {
    for (const hold of targetSyncHolds(store, target)) holds.push({ kind:'target-sync', scope:'change', target, text:`${hold.from} → ${hold.into}: ${hold.reason}` });
    const merging = mergesInFlight(store, target);
    if (merging.length) holds.push({ kind: 'merge', scope: 'change', target, flowIds: merging.map(row => row.flowId), text: `${mergeInFlightReason(target, merging)}.` });
    const health = targetHealth(store, target), checked = Date.parse(health?.checkedAt ?? health?.observedAt);
    const fresh = health?.status === 'green' && Number.isFinite(checked) && checked <= nowMs && nowMs - checked <= maxAge && !scheduledTierHold(config, health, nowMs);
    const timeoutRetry = fresh ? null : timeoutRetryState(store, target, { nowMs });
    if (!fresh) {
      const text = `${targets.length > 1 ? `Work for ${target}` : 'Change and document tasks'} wait${targets.length > 1 ? 's' : ''}: ${mainHealthReason(store, { nowMs, target })}. Task workflows are not affected.`;
      // The recorded times the text embeds, as exact strings (the re-verification time, the health
      // record's check times), so the console shows each as a local time with its UTC value (dev.86, J5, J6).
      const times = [...new Set([timeoutRetry?.after, health?.checkedAt, health?.observedAt, health?.scheduled?.checkedAt].filter(value => typeof value === 'string' && value && text.includes(value)))];
      holds.push({ kind: 'main', scope: 'change', target, ...(timeoutRetry ? { timeoutRetry } : {}), ...(times.length ? { times } : {}), text });
    }
  }
  // A live supervisor that has not recorded ownership for a long time holds its flow slot until stopped.
  for (const attempt of store.live('attempt').filter(row => row.launchStalled && row.status === 'dispatching' && !row.settledAt)) holds.push({ kind: 'launch-stalled', flowId: attempt.flowId, attemptId: attempt.id, ...(typeof attempt.launchStalled.since === 'string' ? { times: [attempt.launchStalled.since] } : {}), text: `Attempt ${attempt.id} has been launching since ${attempt.launchStalled.since}: its supervisor (PID ${attempt.launchStalled.supervisorPid}) is alive but has not taken ownership. Stop the flow to abort it.` });
  // Holds on one queued task that only the operator can lift, with the task named (scope 'task'): a
  // context task whose providers are not qualified on this host (read by key; dev.91, O5).
  if (delivery) {
    // The dashboard's read view projects tasks; the context task is read whole, by key.
    const whole = typeof store.record === 'function' ? { meta: (...args) => store.meta(...args), get: (kind, id) => store.record(kind, id) } : store;
    const context = openContextTask(whole), hold = context && store.get('queue', context.id)?.status === 'queued' ? contextProviderHold(store, context) : null;
    if (hold) holds.push({ kind: 'context-provider', scope: 'task', taskId: context.id, providers: hold.providers, text: `Context task ${context.id} is not started: ${hold.reason.replace(/^admission: /, '')}.` });
  }
  // A queued task the automatic claim chose but could not start (a check only admission itself makes):
  // the claim stops there until it goes through, so the whole queue waits. Recorded once (tick-problems).
  // One hold per refused task; the claim moves on past it to the tasks behind it (operations/queue-claim.mjs).
  for (const [, claim] of Object.entries(tickProblems(store)).filter(([key]) => key.startsWith('queue-claim:'))) {
    const task = claim.taskId ?? null;
    holds.push({ kind: 'claim', ...(task ? { scope: 'task', taskId: task } : {}), times: [claim.since], text: task
      ? `Automatic admission could not start task ${task} (since ${claim.since}): ${claim.reason}. The tasks behind it are still started; it is tried again on each tick, and the reason is recorded once.`
      : `Automatic admission failed (since ${claim.since}): ${claim.reason}. It is tried again on each tick; the reason is recorded once.`});
  }
  const last = latestJob(store, 'queue.dispatch');
  let capacity = null; try { capacity = capacityView(store); } catch { /* shown as unavailable rather than failing the whole status */ }
  return { autoQueue: config.policy?.autoQueue === true, holds, capacity,
    lastDispatch: last ? { id: last.id, status: last.status, outcome: last.outcome ?? null, heldReasons: last.heldReasons ?? [], flowId: last.dispatchedFlowId ?? null, taskId: last.dispatchedTaskId ?? null, createdAt: last.createdAt ?? null,
      // Tasks the dispatch skipped because they were refused at admission, with why (review of 851fad5).
      refused: (Array.isArray(last.refused) ? last.refused : []).slice(0, DISPATCH_REFUSED_SHOWN).map(row => ({ taskId: String(row?.taskId ?? ''), reason: String(row?.reason ?? '').slice(0, 600) })), refusedCount: Array.isArray(last.refused) ? last.refused.length : 0 } : null };
}
