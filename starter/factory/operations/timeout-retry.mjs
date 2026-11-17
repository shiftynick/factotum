import { defaultTarget, targetHealth } from './targets.mjs';

// One automatic re-verification after a main verification that failed only because main checks
// ran out of time (dev.85). A timed-out check usually means a transient wait (a lock held by
// another job, a slow host), not a broken target, so the target stays red but is verified once
// more after the usual back-off. If that run times out again, or anything fails for a real
// reason, it stays red and only the operator (main.verify, doctor) or a moved target starts
// another run.
//
// The verifier records `timeoutOnly: true` on a red result whose only failures are timed-out or
// unstarted checks, and `timeoutRetry: true` when the run was itself the automatic retry (its job
// payload says so). Both live on the target health record written by that run; any later health
// write (a merge, a probe, another verification) replaces them.
export const FAILED_VERIFY_RETRY_MS = 15 * 60000;
export const TIMEOUT_RETRY_PREFIX = 'main-timeout-retry';
const jobTarget = (store, job) => job.payload?.target ?? defaultTarget(store.meta('config', {}));
export const timeoutRetryJobId = (store, target, health) => `${TIMEOUT_RETRY_PREFIX}:${target === defaultTarget(store.meta('config', {})) ? '' : `${target}:`}${health.checkedAt}`;
// The newest failed main.verify of this target (ms), for the back-off.
export function lastFailedVerification(store, target) {
  return store.by('job', 'operation', 'main.verify').filter(job => job.status === 'failed' && jobTarget(store, job) === target).map(job => Date.parse(job.finishedAt ?? job.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0];
}
// The automatic timeout retry already used for this head of the target: the newest
// main-timeout-retry job recorded for the head (`timeoutRetryHead`), unless the operator has since
// asked for a verification of the target themselves (a job.enqueue main.verify, not a schedule or
// a factory request). The allowance is one per head, whatever the age of the health record: a new
// head (a merge, a fix) or an operator verification renews it.
export function usedTimeoutRetry(store, target, head) {
  if (!head) return null;
  const jobs = store.by('job', 'operation', 'main.verify').filter(job => jobTarget(store, job) === target);
  const retry = jobs.filter(job => job.id.startsWith(`${TIMEOUT_RETRY_PREFIX}:`) && job.timeoutRetryHead === head).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1);
  if (!retry) return null;
  const operator = jobs.some(job => !job.scheduleId && job.grant && job.grant.source !== 'configuration' && String(job.createdAt) > String(retry.createdAt));
  return operator ? null : retry;
}
// The retry's state for this target's current health, or null when no timeout is involved:
// - pending: due at `after` (the back-off from the failed run), with `auto` false when policy.autoQueue is off;
// - requested: its job is queued or running (`jobId`);
// - used: this head's one retry has run (it timed out again, or its job ended without a new result).
export function timeoutRetryState(store, target, { nowMs = Date.now() } = {}) {
  const health = targetHealth(store, target);
  if (health?.status !== 'red' || health.timeoutOnly !== true) return null;
  const check = health.timeout?.checkId ?? null, used = usedTimeoutRetry(store, target, health.head);
  if (used) return ['queued', 'running'].includes(used.status) ? { status: 'requested', jobId: used.id, check } : { status: 'used', jobId: used.id, check };
  if (health.timeoutRetry === true) return { status: 'used', check };
  const failed = lastFailedVerification(store, target), at = Math.max(Number.isFinite(failed) ? failed + FAILED_VERIFY_RETRY_MS : 0, Date.parse(health.checkedAt) + FAILED_VERIFY_RETRY_MS);
  return { status: 'pending', after: new Date(Number.isFinite(at) ? at : nowMs).toISOString(), due: !(at > nowMs), auto: store.meta('config', {}).policy?.autoQueue === true, check };
}
// The sentence the queue status and target health show for it.
export function timeoutRetryText(state, label = 'main') {
  if (!state) return '';
  const check = state.check ? `main check ${state.check} timed out` : 'main checks ran out of time';
  if (state.status === 'requested') return `${check}; its one automatic re-verification is in progress (job ${state.jobId})`;
  if (state.status === 'used') return `${check} again on its one automatic re-verification, so it is not verified again automatically; fix the cause (for example a lock or a slow host), then run main.verify for ${label}`;
  if (!state.auto) return `${check}; automatic re-verification is off (policy.autoQueue): fix the cause, then run main.verify for ${label}`;
  return `${check}; one automatic re-verification is requested ${state.due ? 'now' : `after ${state.after}`} (the back-off after a failed verification)`;
}
