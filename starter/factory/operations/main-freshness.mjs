import { now } from '../core/contracts.mjs';
import { remoteRefHead } from '../core/git-options.mjs';
import { runProcess } from '../adapters/providers/index.mjs';
import { admissionReasons } from './admission.mjs';
import { captureConflictScope } from './conflicts.mjs';
import { mainHealthReason } from './main-health-reason.mjs';
import { scheduledRecheckDue, scheduledTierHold, tierPayload } from './main-tiers.mjs';
import { projectTargets, targetHealth, setTargetHealth, targetOf, defaultTarget } from './targets.mjs';
import { FAILED_VERIFY_RETRY_MS, lastFailedVerification, timeoutRetryJobId, timeoutRetryState } from './timeout-retry.mjs';
export { FAILED_VERIFY_RETRY_MS };

// Keeping each target branch's health current while work waits on it. A branch can move
// outside the factory (a direct commit), and green health also expires. With policy.autoQueue,
// the operations loop notices both while change work for that branch is queued and requests
// one verification, the same configured grant a post-merge verification uses. Nothing here
// admits work.
export const TARGET_PROBE_MS = 60000;
// How often a target is read only because a merge question is open on it (no queued work, or
// automatic admission off). Five minutes: a merge question waits on a person, usually for minutes
// to hours, so the card is current well before most answers; the merge step reads the target
// itself whatever the card says, so a later notice costs nothing but the advance warning; and it
// bounds the cost at 12 remote reads an hour per target with an open question.
export const MERGE_QUESTION_PROBE_MS = 5 * 60000;

const jobTarget = (store, job) => job.payload?.target ?? defaultTarget(store.meta('config', {}));
const verifying = (store, target) => store.live('job').find(job => job.operation === 'main.verify' && ['queued', 'running'].includes(job.status) && jobTarget(store, job) === target);
// Queued tasks for this target that its health alone is holding.
export function waitingOnMain(store, target = defaultTarget(store.meta('config', {})), { nowMs = Date.now(), conflictScope } = {}) {
  const health = targetHealth(store, target), checked = Date.parse(health?.checkedAt ?? health?.observedAt);
  const config = store.meta('config', {}), maxAge = config.policy?.mainHealthMaxAgeMs ?? 3600000;
  if (health?.status === 'green' && Number.isFinite(checked) && checked <= nowMs && nowMs - checked <= maxAge && !scheduledTierHold(config, health, nowMs)) return [];
  const tasks = store.live('queue').filter(q => q.status === 'queued').map(q => store.get('task', q.id)).filter(task => task && targetOf(store, task) === target);
  if (!tasks.length) return [];
  // This is advisory observation, not admission. Never rescan the same worktree
  // once per queued task; final admission still obtains fresh conflict evidence.
  conflictScope ??= captureConflictScope(store);
  const reason = mainHealthReason(store, { target, nowMs });
  return tasks.filter(task => admissionReasons(store, task, { nowMs, conflictScope }).includes(reason));
}

// Compare each branch's verified head with its current remote head. Green branches are probed,
// and so are branches held red by a failed scheduled tier: a fix pushed outside the factory moves
// the recorded head (the scheduled red evidence stays) so that a full verification is requested.
// Two things make a target worth reading, each with its own bound (one `git ls-remote` each, never per tick):
// - queued work for it under policy.autoQueue: at most once per policy.mainProbeMs (default a minute);
// - an open merge question on it, with or without autoQueue: at most once per
//   MERGE_QUESTION_PROBE_MS (or policy.mainProbeMs when that is longer), so the question can say
//   the target moved (core/engine.mjs). Only while such a question is open.
// policy.mainProbeMs: 0 turns both off. mergeQuestionsOnly leaves out the queue's reason (the loop
// passes it while admission is paused or under a recovery hold: nothing is admitted then, but an
// open merge question can still be answered).
// The database state and the set of due targets for which none of them was last found to have a
// reason: until something is written, neither the queue nor any merge question can have appeared
// for those targets. A target that becomes due later is not in that set, so it is looked at.
const nothingToProbe = new WeakMap();
export async function probeTargetHead(store, { nowMs = Date.now(), run = runProcess, mergeQuestionsOnly = false } = {}) {
  const config = store.meta('config', {}), every = config.policy?.mainProbeMs ?? TARGET_PROBE_MS;
  // Also probed: a target red on a timeout whose one automatic retry is used up for its head. Nothing
  // automatic verifies that head again, so a fix pushed outside the factory is noticed only here:
  // a new head is recorded (health unknown) and may then be verified (operations/timeout-retry.mjs).
  const probed = (target, health) => health?.status === 'green' || scheduledTierHold(config, health, nowMs)?.kind === 'red' || timeoutRetryState(store, target, { nowMs })?.status === 'used';
  if (config.mode !== 'delivery' || every === 0) return null;
  // What makes a target worth reading is looked up only for a target whose next read is due
  // (the shorter bound first): most ticks end here without reading the queue or any flow.
  const auto = !mergeQuestionsOnly && config.policy?.autoQueue === true, questionEvery = Math.max(every, MERGE_QUESTION_PROBE_MS);
  const probes = store.meta('targetProbes', {}), last = target => Date.parse((target === defaultTarget(config) ? store.meta('targetProbeAt') : probes[target]) ?? '');
  const due = (target, interval) => { const at = last(target); return !Number.isFinite(at) || nowMs - at >= interval; };
  const candidates = projectTargets(store).filter(target => due(target, auto ? every : questionEvery) && probed(target, targetHealth(store, target)) && !verifying(store, target));
  if (!candidates.length) return null;
  const token = `${store.changeToken?.()}:${auto}:${candidates.join('\n')}`;
  if (nothingToProbe.get(store) === token) return null;
  const queued = auto ? store.live('queue').filter(q => q.status === 'queued').map(q => store.get('task', q.id)).filter(Boolean) : [];
  const deciding = new Set(store.live('flow').filter(flow => flow.state === 'waiting' && !flow.stopRequested && flow.workflow?.nodes?.[flow.step]?.mergeDecision).map(flow => flow.target ?? defaultTarget(config)));
  let result = null;
  if (!candidates.some(target => deciding.has(target) || queued.some(task => targetOf(store, task) === target))) { nothingToProbe.set(store, token); return null; }
  for (const target of candidates) {
    const forQueue = queued.some(task => targetOf(store, task) === target);
    if (!(forQueue || deciding.has(target)) || !due(target, forQueue ? every : questionEvery)) continue;
    store.tx(() => { if (target === defaultTarget(config)) store.setMeta('targetProbeAt', new Date(nowMs).toISOString()); else store.setMeta('targetProbes', { ...store.meta('targetProbes', {}), [target]: new Date(nowMs).toISOString() }); });
    let head;
    try {
      const result = await run('git', ['ls-remote', config.repository.remote ?? 'origin', `refs/heads/${target}`], { cwd: store.meta('project').root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 15000 });
      head = result.code === 0 ? remoteRefHead(result.stdout, `refs/heads/${target}`) : null;
    } catch { head = null; }
    if (!/^[a-f\d]{40,64}$/i.test(head ?? '')) continue;
    const current = targetHealth(store, target);
    if (!probed(target, current) || current.head === head) { result = { head, moved: false }; continue; }
    const label = target === defaultTarget(config) ? 'Main' : target;
    store.tx(() => {
      setTargetHealth(store, target, { status: 'unknown', head, checkedAt: now(), previousHead: current.head, reason: `${label} moved outside the factory from ${String(current.head ?? 'an unknown head').slice(0, 12)} to ${head.slice(0, 12)}; verification required` });
      store.event('main.moved', { from: current.head, to: head, ...(target === defaultTarget(config) ? {} : { target }) });
    });
    result = { head, moved: true, ...(target === defaultTarget(config) ? {} : { target }) };
  }
  return result;
}

// Ask for one verification of a target, under the configured autoQueue grant, or say why none
// may be asked for. Returns {jobId, requested} (requested: false when one is already queued or
// running) or {refused, action}: the reason, and what the operator can do about it. Call inside
// the caller's transaction. Used for queued work held by health (below) and for an admitted flow
// waiting at its source step for a target that moved (core/engine.mjs).
export function verificationRequest(store, target, { nowMs = Date.now(), cause } = {}) {
  const config = store.meta('config', {}), commissioning = store.meta('commissioning'), other = target !== defaultTarget(config), label = other ? target : 'main';
  const manual = `run main.verify for ${label} (job.enqueue {operation: "main.verify"${other ? `, payload: {target: "${target}"}` : ''}}) or doctor`;
  if (config.mode !== 'delivery') return { refused: 'verification is requested automatically for delivery projects only', action: manual };
  if (config.policy?.autoQueue !== true) return { refused: 'automatic verification is off (policy.autoQueue)', action: manual };
  if (!commissioning?.ready || commissioning.configDigest !== store.meta('configDigest')) return { refused: 'doctor has not passed for the current configuration', action: 'run doctor' };
  const running = verifying(store, target);
  if (running) return { jobId: running.id, requested: false };
  if (store.meta('paused') || store.meta('recoveryHold')) return { refused: `admission is ${store.meta('recoveryHold') ? 'under a recovery hold' : 'paused'}, so a verification would not start`, action: store.meta('recoveryHold') ? 'reconcile and release the hold (restore.release)' : 'resume admission (pause {paused: false})' };
  const health = targetHealth(store, target), checked = Date.parse(health?.checkedAt ?? health?.observedAt), maxAge = config.policy?.mainHealthMaxAgeMs ?? 3600000;
  // Missing, stale or red scheduled-tier evidence needs a full verification. A red scheduled
  // tier is verified again only once the branch has moved since it failed (a fix merged or was
  // pushed, noticed by the probe), once per new head.
  const tierHold = scheduledTierHold(config, health, nowMs);
  // A red result whose only failures were checks that ran out of time is verified once more
  // automatically (operations/timeout-retry.mjs); it runs the tier the timed-out run ran.
  const retryState = timeoutRetryState(store, target, { nowMs }), retry = retryState?.status === 'pending';
  // This head has had its one automatic timeout retry: no further automatic run of it, not even the
  // ordinary refresh of expired red health, which would be another automatic try at the same head.
  // A new head or an operator verification renews it (operations/timeout-retry.mjs).
  if (retryState?.status === 'used') return { refused: `${label} is red (its last verification failed, and timed out again on its one automatic re-verification of ${String(health.head).slice(0, 12)})`, action: `fix the cause (for example a lock or a slow host), then ${manual}` };
  const tier = tierHold || (retry && health.tier === 'all') ? 'all' : 'merge';
  if (!retry && tierHold?.kind === 'red') { if (!scheduledRecheckDue(tierHold.scheduled, health.head)) return { refused: `${label} scheduled-tier checks are red and ${label} has not moved since`, action: `fix ${label}, then ${manual}` }; }
  // A red result is a real finding: fixing the branch is the way forward, not verifying again.
  else if (!retry && health?.status === 'red' && Number.isFinite(checked) && nowMs - checked <= maxAge) return { refused: `${label} is red (its last verification failed)`, action: `fix ${label}, then ${manual}` };
  const lastFailed = lastFailedVerification(store, target);
  if (lastFailed && nowMs - lastFailed < FAILED_VERIFY_RETRY_MS) return { refused: `the last verification of ${label} failed ${Math.max(0, Math.round((nowMs - lastFailed) / 60000))} minutes ago and is not repeated automatically for ${FAILED_VERIFY_RETRY_MS / 60000} minutes${retry ? ' (then once, because it failed only on a timeout)' : ''}`, action: `inspect that verification, then ${manual}` };
  if (retry) {
    const id = timeoutRetryJobId(store, target, health);
    if (store.get('job', id)) return { jobId: id, requested: false };
    store.put('job', { id, operation: 'main.verify', payload: { ...(other ? { target } : {}), ...tierPayload(config, tier), timeoutRetry: true }, grant: { actor: 'operator', source: 'configuration', policy: 'autoQueue', note: `Configured single re-verification of ${label} after its verification failed only because main checks ran out of time`, configDigest: store.meta('configDigest') }, status: 'queued', createdAt: now(), timeoutRetryHead: health.head });
    store.event('main.verify-timeout-retry', { jobId: id, ...(other ? { target } : {}), ...(cause ? { cause } : {}), failedAt: health.checkedAt, head: health.head, check: health.timeout?.checkId ?? null });
    return { jobId: id, requested: true, timeoutRetry: true };
  }
  const id = `main-refresh:${other ? `${target}:` : ''}${new Date(nowMs).toISOString()}`;
  if (store.get('job', id)) return { jobId: id, requested: false };
  store.put('job', { id, operation: 'main.verify', payload: { ...(other ? { target } : {}), ...tierPayload(config, tier) }, grant: { actor: 'operator', source: 'configuration', policy: 'autoQueue', note: `Configured ${tier === 'all' ? 'full ' : ''}verification of stale, unknown or moved ${label} health before ${cause ? 'source admission' : 'queue admission'}`, configDigest: store.meta('configDigest') }, status: 'queued', createdAt: new Date(nowMs).toISOString() });
  store.event('main.verify-requested', { jobId: id, ...(other ? { target } : {}), ...(cause ? { cause } : {}), reason: health?.reason ?? (health ? `${label} health ${health.status} from ${health.checkedAt ?? 'an unknown time'}` : `${label} health never verified`) });
  return { jobId: id, requested: true };
}
// Request one verification per branch whose queued work is held by stale, unknown or moved health.
export function ensureMainVerification(store, { nowMs = Date.now(), conflictScope } = {}) {
  const config = store.meta('config', {}), commissioning = store.meta('commissioning');
  if (config.mode !== 'delivery' || config.policy?.autoQueue !== true || !commissioning?.ready || commissioning.configDigest !== store.meta('configDigest')) return null;
  let requested = null;
  for (const target of projectTargets(store)) {
    if (verifying(store, target)) continue;
    // The single re-verification after a timeout is due whether or not work is queued for the target.
    if (!waitingOnMain(store, target, { nowMs, conflictScope }).length && !timeoutRetryState(store, target, { nowMs })?.due) continue;
    const request = verificationRequest(store, target, { nowMs });
    if (request.requested) requested ??= request.jobId;
  }
  return requested;
}

// repository.syncTargets for merges made outside the factory: at most once per
// policy.mainProbeMs, read each `from` branch's remote head and, when it changed since the last
// sync, queue a target.sync (a no-op when `into` already contains it).
export async function ensureTargetSync(store, { nowMs = Date.now(), run = runProcess } = {}) {
  const config = store.meta('config', {}), pairs = config.repository?.syncTargets ?? [], every = config.policy?.mainProbeMs ?? TARGET_PROBE_MS;
  if (config.mode !== 'delivery' || !pairs.length || every === 0) return [];
  const last = Date.parse(store.meta('syncProbeAt') ?? '');
  if (Number.isFinite(last) && nowMs - last < every) return [];
  store.tx(() => store.setMeta('syncProbeAt', new Date(nowMs).toISOString()));
  const queued = [];
  for (const { from, into } of pairs) {
    const key = `${from}>${into}`;
    if (store.live('job').some(job => job.operation === 'target.sync' && ['queued', 'running'].includes(job.status) && job.payload?.from === from && job.payload?.into === into)) continue;
    let head;
    try { const result = await run('git', ['ls-remote', config.repository.remote ?? 'origin', `refs/heads/${from}`], { cwd: store.meta('project').root, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', GIT_TERMINAL_PROMPT: '0' }, timeoutMs: 15000 }); head = result.code === 0 ? remoteRefHead(result.stdout, `refs/heads/${from}`) : null; } catch { head = null; }
    if (!/^[a-f\d]{40,64}$/i.test(head ?? '') || store.meta('syncSeen', {})[key] === head) continue;
    const id = `target-sync:outside:${from}:${into}:${head.slice(0, 12)}`;
    store.tx(() => {
      store.setMeta('syncSeen', { ...store.meta('syncSeen', {}), [key]: head });
      if (!store.get('job', id)) store.put('job', { id, operation: 'target.sync', payload: { from, into }, grant: { actor: 'operator', source: 'configuration', policy: 'syncTargets', note: `${from} moved to ${head.slice(0, 12)}; bring ${into} up to date`, configDigest: store.meta('configDigest') }, status: 'queued', createdAt: new Date(nowMs).toISOString() });
    });
    queued.push(id);
  }
  return queued;
}
