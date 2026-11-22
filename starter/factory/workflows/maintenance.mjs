import { accountingResult } from '../operations/usage-accounting.mjs';
import { sweepAdoptionRefs } from '../operations/adoption-refs.mjs';
import { runDoctorRequest } from '../operations/doctor-request.mjs';
import { pinFlowModels } from '../operations/model-settings.mjs';
import { createOperationId } from '../operations/source-adapter.mjs';
import { readOnlyMaintenance } from './integrations.mjs';
import { manualJobGrant } from '../core/delegation.mjs';
import { isScheduledOperation, scheduledTaskName } from '../operations/scheduled-tasks.mjs';
import { recordHostSample } from '../operations/sampling.mjs';
import { ensureMainVerification, probeTargetHead, ensureTargetSync } from '../operations/main-freshness.mjs';
import { backfillFinishedAt, createRecurringOccurrence, supersedeOpenQuestions, settleFlowJob } from '../core/project.mjs';
import {expireStandaloneQuestions,settlePresentations} from '../core/communication.mjs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { prepareGitInvocation } from '../adapters/github/git.mjs';
import { retryRefLockedFetch, remoteRefHead } from '../core/git-options.mjs';
import { runArchiveRetention } from '../operations/archive-retention.mjs';
import { createGitHub } from '../adapters/github/index.mjs';
import { sampleMachine } from '../operations/sampling.mjs';
import { Store } from '../core/store.mjs';
import { assert, atomicJSON, digest, now, uid, fileDigest, validateWorkflow } from '../core/contracts.mjs';
import { executorDigest } from '../core/effects.mjs';
import { repositoryIdentity } from '../core/repository.mjs';
import { backupProject } from '../core/backup.mjs';
import { admitFlow } from '../core/project.mjs';
import { queueInboxDeliveries } from '../operations/notifications.mjs';
import { claimCandidate, dispatchSchedules, queueDelivery, deliverDue, metrics, recordRetrospective, HostResources, admissionReasons, observeQueue, recordQueueAdmission, orderedQueue, resourceRequest } from '../operations/index.mjs';
import { runProcess, invoke, REVIEW_SCHEMA, validateSchema } from '../adapters/providers/index.mjs';
import * as workspace from '../adapters/workspace/index.mjs';
import { validateMainCheckPolicy, reusableMainCheck } from '../operations/main-checks.mjs';
import { checkTier, checksForTier, hasScheduledTier, validateMainCheckTier, verifyTier } from '../operations/main-tiers.mjs';
import { captureConflictScope } from '../operations/conflicts.mjs';
import { retryPendingCleanups } from '../operations/workspace-cleanup.mjs';
import { installedOperation, integrationWorkflow } from './integrations.mjs';
import { auditProviderTimeoutMs, mainVerifyCheckLimit, mainVerifySetupTimeoutMs, maintenanceTimeoutMs, MAIN_CHECK_MIN_MS } from '../operations/effect-timeouts.mjs';
import { runCheckProcess } from '../operations/check-process.mjs';
import { knownSecrets } from '../operations/known-secrets.mjs';
import { excerptBlock, outputExcerpt } from '../core/command-failure.mjs';
import { LEARNINGS_CHECK_OPERATION, UPKEEP_OPERATION, isUpkeepFlow, isUpkeepJob } from '../core/upkeep-config.mjs';
import { upkeepWorkState } from '../operations/upkeep-records.mjs';
import { UPKEEP_CLOSE_OPERATION, upkeepCloseTickInTransaction } from '../operations/upkeep-pr-close.mjs';
import { routeHoldReasons } from '../operations/provider-limits.mjs';
import { clearTickProblem, recordTickProblem } from '../operations/tick-problems.mjs';
import { attemptEnvironmentHold, environmentFreeOperation } from '../operations/attempt-environment-record.mjs';
import { claimQueue } from '../operations/queue-claim.mjs';
import { ensureUpkeepRoutePinnedInTransaction } from '../operations/upkeep-route.mjs';
import { startUpkeepRunInTransaction, upkeepTickInTransaction } from '../operations/upkeep-runs.mjs';
const allowed = new Set(['forge.lifecycle', UPKEEP_CLOSE_OPERATION, 'main.verify', 'queue.dispatch', 'maintenance.backup', 'audit', 'retrospective', 'machine.sample', 'retention.archive', 'source.sync', 'source.create', 'source.promote', 'target.sync', UPKEEP_OPERATION, LEARNINGS_CHECK_OPERATION]);
export function scheduleGrantDigest(schedule) { return schedule.revision ?? digest(Object.fromEntries(['id','operation','payload','type','everyMs','anchorMs','timeOfDay','timezone','weekdays','enabled'].filter(key => schedule[key] !== undefined).map(key => [key,schedule[key]]))); }
// What keeps a schedule from firing now, by name (none: it fires). Admission pause, recovery hold and
// retention hold hold every schedule, as before dev.103. A maintenance.backup is held by the holds
// that make a backup unsafe or unwanted, whether or not admission is paused: recovery, retention, a
// drain (maintenanceHeld) and an upgrade in progress (upgradeRecovery, which an interrupted upgrade
// leaves set); a pause alone does not hold it.
export const runsWhilePaused = schedule => schedule?.operation === 'maintenance.backup' && !schedule.recurringTask;
// Read fresh on every call: the admission transaction asks again just before a backup job starts.
export function backupHolds(store) {
  return [store.meta('recoveryHold') && 'recovery hold', store.meta('retentionHold') && 'retention hold', store.meta('maintenanceHeld') && 'maintenance hold (drain)', store.meta('upgradeRecovery', null) && 'upgrade in progress'].filter(Boolean);
}
// `paused` and `recoveryHold` are the values the caller has just read, when it has. The backup holds
// are read only when a backup schedule is looked at, so a tick with no backup schedule and nothing
// held reads no more than it did.
export function scheduleHolds(store, { paused = store.meta('paused'), recoveryHold = store.meta('recoveryHold') } = {}) {
  const retention = store.meta('retentionHold') && 'retention hold';
  let backup = null; const backupNow = () => backup ??= backupHolds(store);
  if (!paused && !recoveryHold && !retention) return schedule => runsWhilePaused(schedule) ? backupNow() : [];
  const recovery = (recoveryHold || paused && store.meta('recoveryHold')) && 'recovery hold', drain = paused && store.meta('maintenanceHeld');
  const general = [recovery, retention, paused && (drain ? 'admission paused with maintenance held (drain)' : 'admission paused')].filter(Boolean);
  return schedule => runsWhilePaused(schedule) ? backupNow() : general;
}
const fetchTransport = async ({ url, payload, headers, signal }) => fetch(url, { method: 'POST', body: payload, headers, signal });
export async function operationalTick(store, { transport = fetchTransport, nowMs } = {}) {
  store.tx(() => backfillFinishedAt(store));
  // Repair: a queue entry still claimed by a flow that has finished (failed, abandoned or completed).
  store.tx(() => { for (const row of store.live('queue').filter(q => q.status === 'claimed' && q.flowId)) { const flow = store.get('flow', row.flowId); if (flow && ['completed', 'failed'].includes(flow.state)) { store.put('queue', { ...row, status: 'finished', finishedAt: flow.finishedAt ?? now(), flowState: flow.abandonedAt ? 'abandoned' : flow.state }); store.event('queue.released', { taskId: row.id, flowId: flow.id, flowState: flow.abandonedAt ? 'abandoned' : flow.state }); } } });
  recordHostSample(store);
  runDoctorRequest(store);
  store.tx(()=>expireStandaloneQuestions(store));
  // Repair: a job left "running" after its flow finished (for example an abandoned maintenance flow).
  store.tx(() => { for (const job of store.live('job').filter(row => row.status === 'running' && row.flowId)) { const flow = store.get('flow', job.flowId); if (flow && ['completed', 'failed'].includes(flow.state)) settleFlowJob(store, flow, flow.abandonedAt ? 'abandoned' : flow.state, flow.abandonedAt ? 'flow abandoned' : undefined); } });
  // Repair: questions stranded open on a finished flow (for example by an earlier answer/tick race).
  store.tx(() => { for (const flowId of new Set(store.live('inbox').filter(q => q.flowId && q.kind === 'question' && q.status === 'open').map(q => q.flowId))) { const flow = store.get('flow', flowId); if (flow && ['completed', 'failed'].includes(flow.state)) supersedeOpenQuestions(store, flow, 'flow already finished'); } });
  // A prompt channel's presentation of a question ends on its own timer; the question stays open.
  store.tx(()=>settlePresentations(store));
  const config = store.meta('config'); if (config?.mode !== 'delivery') return { skipped: 'not delivery mode' };
  const paused = store.meta('paused'), recoveryHold = !paused && store.meta('recoveryHold'), held = paused || recoveryHold;
  // Knowledge upkeep (operations/upkeep-runs.mjs). One meta read says whether any run is pending,
  // queued or running; with none, upkeep does nothing more in this tick and starts no process.
  // With some, receipts are closed at their deadlines, queued once their retrospective exists and
  // returned to pending when their job was revoked; under a maintenance hold (a drain) a running
  // assessment is asked to stop. This runs while paused too: a drain must not wait on it.
  // The same row names the pull requests being closed for follow-ups the factory ended
  // (operations/upkeep-pr-close.mjs): a revoked, failed or abandoned close job is queued again here.
  const { runs: upkeepRuns, closes: upkeepCloses } = upkeepWorkState(store), tickNow = () => nowMs ?? Date.now();
  // A failure that repeats on every tick is recorded once, and again only when its reason changes (dev.91, O5).
  // With no work of a kind left, its problem is over too, so a later failure is a new event (review of 56d49a9, P3).
  if (upkeepRuns.length) { try { store.tx(() => upkeepTickInTransaction(store, upkeepRuns, { nowMs: tickNow(), config })); clearTickProblem(store, 'upkeep-runs'); } catch (error) { recordTickProblem(store, 'upkeep-runs', 'upkeep.tick-failed', error.message); } }
  else clearTickProblem(store, 'upkeep-runs');
  if (upkeepCloses.length) { try { store.tx(() => upkeepCloseTickInTransaction(store, upkeepCloses)); clearTickProblem(store, 'upkeep-closes'); } catch (error) { recordTickProblem(store, 'upkeep-closes', 'upkeep.tick-failed', error.message); } }
  else clearTickProblem(store, 'upkeep-closes');
  // Observing the active workspaces costs four Git reads per flow, and only queued tasks are
  // judged against them: with nothing queued (a merge question held open, say) none are made.
  // A task queued after this point is judged against a fresh observation of its own.
  const observeWorkspaces = () => store.live('queue').some(q => q.status === 'queued') ? captureConflictScope(store) : new Map();
  let conflictScope = observeWorkspaces();
  observeQueue(store, { reasonsForTask: task => admissionReasons(store, task, { conflictScope }) });
  // Paused or under a recovery hold nothing is admitted, but an open merge question can still be
  // answered: its target is still read (one bounded remote read; it only records a moved head).
  if (held) await probeTargetHead(store, { mergeQuestionsOnly: true });
  // Schedules (dev.103). A pause, a recovery hold or a retention hold keeps a schedule from firing, as
  // before, with one exception: while admission is only paused, a scheduled maintenance.backup still
  // fires and its job starts. A backup copies the project's own state to backupRoot (VACUUM INTO and a
  // copy of attempt and reconciliation files): no provider, forge, Git or network effect. It is still
  // held by a recovery hold (the state is in doubt), a retention hold (archive retention moves the
  // files it copies), a maintenance hold (a drain: it would be new work the drain waits for) and an
  // upgrade in progress (upgradeRecovery; the upgrade takes its own backup). A held schedule that
  // misses an occurrence raises one notice until the hold lifts (operations/schedules.mjs).
  const holdsFor = scheduleHolds(store, { paused, recoveryHold });
  dispatchSchedules(store, { nowMs: tickNow(), holdsFor, dispatch: (schedule, occurrence) => {
    if (schedule.recurringTask) return { commandId: createRecurringOccurrence(store, config, schedule.recurringTask, occurrence).taskId };
    assert(allowed.has(schedule.operation) || installedOperation(config,schedule.operation) || isScheduledOperation(config,schedule.operation), 'unsupported scheduled maintenance operation');
    const id = digest(occurrence.key), scheduleRevision = scheduleGrantDigest(schedule);
    store.put('job', { id, operation: schedule.operation, payload: schedule.payload ?? {}, scheduleId: schedule.id, scheduleRevision, status: 'queued', createdAt: now() }); return { commandId: id };
  } });
  // Revoke stale grants, then start at most one queued job per lane. `only` limits both to the jobs
  // it accepts: while paused, scheduled backups alone; any other queued job is left as it is.
  // The project service's attempt-environment check (dev.105): while it found another node or git,
  // or its start check is still pending, new maintenance that runs the project's tools (main.verify,
  // target.sync, audits, scheduled tasks, integrations, ...) stays queued; running work continues.
  // Each held job says why (job.held, event maintenance.held, once per reason), and the hold is
  // cleared from the job when it starts. Read once per tick, only when a job is looked at.
  let environment; const environmentHeld = () => environment === undefined ? (environment = attemptEnvironmentHold(store)) : environment;
  const markEnvironmentHeld = jobs => {
    const dependent = jobs.filter(row => !environmentFreeOperation(row.operation)); if (!dependent.length) return;
    const reason = environmentHeld(); if (!reason) return;
    for (const job of dependent.filter(row => row.held?.reason !== reason)) store.tx(() => {
      const current = store.get('job', job.id); if (current?.status !== 'queued') return;
      store.put('job', { ...current, held: { kind: 'attempt-environment', reason, since: now() } }); store.event('maintenance.held', { jobId: job.id, operation: job.operation, hold: 'attempt-environment', reason });
    });
  };
  const startMaintenance = (only, { upkeep = upkeepRuns.length > 0 } = {}) => {
    // Revoke stale grants rather than letting one stale head poison every later tick.
    for (const pending of store.live('job').filter(j => j.status === 'queued' && only(j))) {
      const schedule = pending.scheduleId ? store.get('schedule', pending.scheduleId) : null;
      const valid = pending.scheduleId ? schedule?.enabled && scheduleGrantDigest(schedule) === pending.scheduleRevision : manualJobGrant(pending.grant) && pending.grant.note && pending.grant.configDigest === store.meta('configDigest');
      if (!valid) store.tx(() => { pending.status = 'revoked'; pending.reason = 'approved scope changed or was revoked'; store.put('job', pending); store.event('maintenance.revoked', { jobId: pending.id }); });
    }
    // Lanes: built-in maintenance jobs share one (one unfinished non-integration maintenance flow at
    // a time), each installed integration workflow has its own, and knowledge upkeep has its own
    // (5.2): at most one upkeep flow at a time, never counted against the built-in lane.
    const canStart = job => (job.operation !== 'maintenance.backup' || !backupHolds(store).length) && (environmentFreeOperation(job.operation) || !environmentHeld()) && !store.meta('maintenanceHeld') && (!store.meta('retentionHold') || job.operation==='retention.archive' && job.payload?.operationId===store.meta('retentionHold').operationId) && !store.live('flow').some(f => f.kind === 'maintenance' && !['completed','failed'].includes(f.state) && (isUpkeepJob(job) ? isUpkeepFlow(f) : installedOperation(config,job.operation) ? f.integration && (config.integrationWorkflows[f.integration.id]?.singleton ?? f.integration.id) === (config.integrationWorkflows[job.operation.slice(9)]?.singleton ?? job.operation.slice(9)) : !f.integration && !isUpkeepFlow(f)));
    // The built-in pick ignores upkeep jobs entirely, so a main.verify or target.sync queued before
    // or after an upkeep job is chosen exactly as it would be without one. The upkeep lane is looked
    // at only when the meta row read above names a run, and its job starts after the built-in one.
    const queuedJobs = store.live('job').filter(j => j.status === 'queued');
    markEnvironmentHeld(queuedJobs.filter(only));
    const candidates = [queuedJobs.find(j => !isUpkeepJob(j) && only(j) && canStart(j)), upkeep ? queuedJobs.find(j => isUpkeepJob(j) && only(j) && canStart(j)) : null].filter(Boolean);
    for (const candidate of candidates) store.tx(() => {
      const job = store.need('job', candidate.id); assert(allowed.has(job.operation) || installedOperation(config,job.operation) || isScheduledOperation(config,job.operation), 'unsupported maintenance job');
      // A backup hold placed since the job was picked (an upgrade starting, say) leaves it queued.
      if (job.operation === 'maintenance.backup' && backupHolds(store).length) return;
      assert(canStart(job), 'maintenance capacity changed');
      delete job.held;
      let schedule;
      if (job.scheduleId) { schedule = store.need('schedule', job.scheduleId); assert(schedule.enabled && (scheduleGrantDigest(schedule)) === job.scheduleRevision, 'schedule grant changed'); }
      else assert(manualJobGrant(job.grant) && job.grant.note && job.grant.configDigest === store.meta('configDigest'), 'explicit scoped operator (or delegated) job grant required');
      if (job.operation === 'queue.dispatch') {
        // Claim directly within this existing transaction: no nested claimCandidate transaction.
        const conflictScope = captureConflictScope(store);
        // An ineligible queue completes the job with its reasons; it never faults the operations loop.
        // A task refused at final admission is undone to a savepoint and recorded on the job (refused),
        // and the dispatch moves on to the next eligible task (review of 56d49a9, decision 4).
        const queued = orderedQueue(store), refused = [];
        let pending = null;
        for (const q of queued) {
          if (admissionReasons(store, store.get('task', q.id), { conflictScope }).length) continue;
          store.db.exec('SAVEPOINT queue_dispatch');
          try { const task = store.need('task', q.id); const admitted = admitFlow(store, task, { revision: task.revision }); const observed = recordQueueAdmission(store, q, admitted); store.put('queue', { ...observed, status: 'claimed', flowId: admitted.id, claimedAt: now() }); job.dispatchedFlowId = admitted.id; job.dispatchedTaskId = q.id; store.db.exec('RELEASE queue_dispatch'); pending = q; break; }
          catch (error) { store.db.exec('ROLLBACK TO queue_dispatch'); store.db.exec('RELEASE queue_dispatch'); refused.push({ taskId: q.id, reason: String(error?.message ?? error).slice(0, 2000) }); }
        }
        if (refused.length) job.refused = refused;
        if (!pending && queued.length) job.heldReasons = refused.length ? refused.map(row => `task ${row.taskId} refused at admission: ${row.reason}`) : admissionReasons(store, store.get('task', queued[0].id), { conflictScope });
        job.status = 'completed'; job.outcome = pending ? 'dispatched' : 'no-eligible-task'; store.put('job', job); return;
      }
      const taskId = `job:${job.id}`, taskRevision = digest({ operation: job.operation, payload: job.payload, scheduleRevision: job.scheduleRevision ?? null, configDigest: store.meta('configDigest') });
      const task = { id: taskId, title: `Maintenance: ${job.operation}`, acceptance: [`Execute approved ${job.operation} scope and retain evidence`], revision: taskRevision, approvedRevision: taskRevision, approvalVersion: 1, approvalKind: schedule ? 'schedule' : 'job', ...(schedule ? { scheduleId: schedule.id, scheduleRevision: job.scheduleRevision } : { jobId: job.id }), paths: [], risk: 'strict' };
      const integrationId = installedOperation(config,job.operation) ? job.operation.slice(9) : null;
      if (integrationId) {
        // A job that cannot be admitted fails with its reason; it never faults the operations loop.
        const refuse = reason => { job.status = 'failed'; job.reason = reason; job.finishedAt = now(); store.put('job', job); store.event('maintenance.refused', { jobId: job.id, reason }); };
        if (!(store.meta('commissioning')?.ready && store.meta('commissioning')?.configDigest===store.meta('configDigest'))) return refuse('commission installed integration workflows before admission');
        // A read-only maintenance workflow observes the checkout as it is: bind the current head when none is given.
        if (!job.payload?.candidate && readOnlyMaintenance(config, integrationId)) job.payload = { ...(job.payload ?? {}), candidate: { head: repositoryIdentity(store.meta('project').root).head } };
        if (!(job.payload?.candidate && /^[a-f\d]{40,64}$/i.test(job.payload.candidate.head ?? ''))) return refuse('exact integration candidate head required');
        if (!(Number.isSafeInteger(job.payload.capMicros ?? 0) && (job.payload.capMicros ?? 0) >= 0)) return refuse('nonnegative integration spending cap required');
      }
      // A scheduled task's command exit maps to pass/fail; its node budget adds time to prepare the checkout.
      const scheduledTask = isScheduledOperation(config, job.operation) ? config.scheduledTasks[scheduledTaskName(job.operation)] : null;
      const workflow = integrationId ? integrationWorkflow(config,integrationId) : { version: 1, start: 'run', nodes: { run: { kind: 'effect', action: { operation: job.operation }, ...(job.operation === 'main.verify' ? { heavy: true } : {}), timeoutMs: scheduledTask ? Math.min(3_600_000, (scheduledTask.timeoutMs ?? 600000) + 120000) : maintenanceTimeoutMs(config, job.operation, job.payload), next: 'done', onFailure: 'failed', ...(scheduledTask || job.operation === 'target.sync' ? { resultEdges: { pass: 'done', fail: 'failed' } } : job.operation === 'main.verify' ? { resultEdges: { pass: 'done', fail: 'failed', blocked: 'failed' } } : {}) }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } }; validateWorkflow(workflow);
      const flow = { ...(integrationId ? {integration:{id:integrationId,kind:config.integrationWorkflows[integrationId].kind,adapterIdentity:repositoryIdentity(store.meta('project').root),payload:structuredClone(job.payload),workflowDigest:digest(workflow),grant:{actor:'operator',answer:'approve',candidateDigest:digest(job.payload.candidate),configDigest:store.meta('configDigest'),workflowDigest:digest(workflow),capMicros:0,source:schedule?'schedule':'job'}}} : {}), id: `maintenance:${job.id}`, taskId, taskRevision, taskSnapshot: structuredClone(task), approvalVersion: 1, kind: 'maintenance', jobId: job.id, jobPayload: job.payload ?? {}, workflow, workflowDigest: digest(workflow), configDigest: store.meta('configDigest'), mode: 'delivery', executorDigest: executorDigest(), step: workflow.start, state: 'ready', stopRequested: false, abortRequested: false, transitions: 0, visits: { [workflow.start]: 1 }, evidence: {}, results: {}, sessions: {}, attemptId: null, createdAt: now() };
      // A project that was observing before this release pinned routes has none yet: pin the route in
      // force now, before this job selects its model (operations/upkeep-route.mjs).
      if (isUpkeepJob(job)) ensureUpkeepRoutePinnedInTransaction(store, config);
      try { pinFlowModels(store, flow, job.modelOverrides); }
      catch (error) { job.status = 'failed'; job.reason = error.message; job.finishedAt = now(); store.put('job', job); store.event('maintenance.refused', { jobId: job.id, reason: error.message }); return; }
      // A provider usage hold does not start an upkeep job and does not move it to another provider:
      // it waits in the queue until its run-by deadline (design 5.3). Nothing is written.
      if (isUpkeepJob(job) && routeHoldReasons(store, flow.modelRoutes, tickNow()).length) return;
      // An upkeep job starts only as the queued job of its run, before its run-by deadline.
      if (isUpkeepJob(job)) { const refused = startUpkeepRunInTransaction(store, job, flow, { nowMs: tickNow(), config }); if (refused) { job.status = 'revoked'; job.reason = refused; job.finishedAt = now(); store.put('job', job); store.event('maintenance.revoked', { jobId: job.id, reason: refused }); return; } }
      flow.modelSelection.by = job.grant?.actor ?? 'schedule';
      store.put('task', task); store.put('flow', flow); if(job.operation==='retention.archive'&&store.meta('retentionHold')?.operationId===job.payload?.operationId)store.setMeta('retentionHold',{...store.meta('retentionHold'),flowId:flow.id}); job.status = 'running'; job.flowId = flow.id; store.put('job', job); store.event('maintenance.admitted', { jobId: job.id, flowId: flow.id });
    });
  };
  if (!held) {
    // Keep main health current while queued work waits on it, and tell open merge questions when their target moved.
    await probeTargetHead(store);
    store.tx(() => ensureMainVerification(store, { conflictScope }));
    // Keep synced branches up to date after merges made outside the factory too.
    await ensureTargetSync(store);
    // A completed flow whose cleanup failed is retried, then raised as an operator to-do.
    await retryPendingCleanups(store);
    // An ended adoption's private refs are deleted once nothing of the flow keeps them.
    // Bounded and never waited on for long: see operations/adoption-refs.mjs.
    await sweepAdoptionRefs(store);
    startMaintenance(() => true);
    // A claim refused after its task passed every admission reason (a check only admitFlow makes) is
    // a hold: recorded once with the task, and again only when the reason changes, never on every
    // tick (dev.91, O5). Queue status shows it until a claim goes through.
    // It moves past a task refused at final admission to the next eligible one (operations/queue-claim.mjs).
    if (config.policy?.autoQueue && store.meta('commissioning')?.ready) claimQueue(store, { admit: (task, s) => admitFlow(s, task, { revision: task.revision }) });
  }
  // Paused: a scheduled backup still starts, with its grant and schedule revision checked as usual.
  else if (!holdsFor({ operation: 'maintenance.backup' }).length) startMaintenance(job => job.operation === 'maintenance.backup' && Boolean(job.scheduleId), { upkeep: false });
  conflictScope = observeWorkspaces();
  observeQueue(store, { reasonsForTask: task => admissionReasons(store, task, { conflictScope }) });
  queueInboxDeliveries(store);
  // A notification configuration problem pauses delivery (recorded as notificationHealth); it never faults this loop.
  if (config.notifications?.configPath) await deliverDue(store, { configPath: config.notifications.configPath, transport });
  return { held: Boolean(held) };
}
export async function runMaintenanceAction(intent, options = {}) {
  const action = intent.action;
  // The step's effect deadline: the supervisor ends the step at its timeout, so the verifier
  // fits each check (and audit its model call) into the time left. Doctor runs without one.
  options = { ...options, deadlineAt: options.deadlineAt ?? (Number.isSafeInteger(intent.timeoutMs) && intent.timeoutMs > 0 ? Date.now() + intent.timeoutMs : undefined) };
  if (action.operation !== 'main.verify' || !action.resource) return maintenanceAction(intent, options);
  assert(action.config.resources?.coordinatorPath, 'shared coordinator required for heavy main verification');
  const owner = JSON.parse(readFileSync(join(action.artifactDir, 'owner.json'), 'utf8'));
  assert(owner.attemptId === intent.attemptId && owner.intentDigest && typeof owner.cgroup === 'string', 'contained supervisor ownership required for heavy main verification');
  const coordinator = new HostResources(action.config.resources.coordinatorPath); let lease; const started = Date.now();
  try {
    while (!(lease = coordinator.acquire({ ...resourceRequest(action.config, action.operation), projectId: action.projectId, flowId: action.flowId, attemptId: intent.attemptId, owner }))) {
      assert(!options.signal?.aborted && Date.now() - started < Math.min((intent.timeoutMs ?? 120000) / 2, 60000), 'main verification resource wait exhausted');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const acquired = Date.now(), resourceWaitMs = acquired - started; const resourceWait = { startedAt: new Date(started).toISOString(), endedAt: new Date(acquired).toISOString() };
    const result = await maintenanceAction(intent, options); return { ...result, resourceWaitMs, resourceWait };
  } finally {
    // Worker completion is not proof that the supervisor cgroup has drained.
    // The next contender reclaims only after ownerState proves every contained process exited.
    coordinator.close();
  }
}
// Run a scheduled task's command in a clean, owned checkout of the target's remote head.
async function runScheduledTask(intent, { run, runGit, root, config, action }) {
  const name = scheduledTaskName(action.operation), task = config.scheduledTasks[name], remote = config.repository.remote ?? 'origin', target = config.repository.target;
  const artifactDir = action.artifactDir ?? join(action.stateDir, 'maintenance', action.flowId);
  const fetched = await runGit(['fetch', remote, target], { cwd: root, env: process.env, timeoutMs: 60000 });
  assert(fetched.code === 0, `could not fetch ${remote}/${target}: ${(fetched.stderr ?? '').trim().slice(0, 300)}`);
  const head = (await runGit(['rev-parse', '--verify', `${remote}/${target}^{commit}`], { cwd: root, env: process.env, timeoutMs: 10000 })).stdout.trim();
  assert(/^[a-f\d]{40,64}$/i.test(head), 'target head unavailable');
  const owned = await workspace.prepare({ root, stateDir: action.stateDir, projectId: action.projectId, flowId: action.flowId, baseRef: head, setup: config.workspace?.setup ?? [], setupTimeoutMs: config.workspace?.setupTimeoutMs });
  let result, preserved = false;
  try {
    const started = now(), outcome = await run(task.command[0], task.command.slice(1), { cwd: owned.path, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' }, timeoutMs: task.timeoutMs ?? 600000, maxBytes: 4 * 1024 * 1024 });
    const report = `${outcome.stdout ?? ''}${outcome.stderr ? `\n${outcome.stderr}` : ''}`.trim();
    atomicJSON(join(artifactDir, 'report.json'), { task: name, head, exitCode: outcome.code, startedAt: started, endedAt: now(), stdout: outcome.stdout ?? '', stderr: outcome.stderr ?? '' });
    const dirty = (await workspace.inspect({ workspace: owned })).dirty;
    result = { route: outcome.code === 0 ? 'pass' : 'fail', scheduledTask: name, head, exitCode: outcome.code, report: report.slice(-6000), reportTruncated: report.length > 6000, reportArtifact: 'report.json', network: task.network, wroteFiles: dirty };
  } finally {
    try { await workspace.release({ workspace: owned, preservation: { mergedInto: `${remote}/${target}` }, dryRun: false }); } catch { preserved = true; }
  }
  // A task that wrote into its checkout keeps it for inspection; scheduled tasks are expected to be read-only.
  return preserved ? { ...result, obligations: [{ title: `Inspect files written by scheduled task ${name}`, evidence: owned.path, approved: false, status: 'pending', owner: 'operator' }] } : result;
}
const duration = ms => ms >= 60000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 100) / 10} s`;
// What a main verification that ran out of time records: the check stopped at its limit (its own
// timeoutMs, or the time left in the step), any checks that could not start, and a notice with a
// bounded, redacted excerpt of the stopped check's output.
function mainVerifyTimeout({ timedOut, notRun, target, head, stepTimeoutMs, secrets, retry }) {
  const step = Number.isSafeInteger(stepTimeoutMs) ? ` (this main.verify step may run ${duration(stepTimeoutMs)}; timeouts["main.verify"] overrides it)` : '';
  const sentences = [];
  if (timedOut) sentences.push(timedOut.limitSource === 'check'
    ? `Main check ${timedOut.checkId} timed out after ${duration(timedOut.timeoutMs)} (its timeoutMs) and was stopped.`
    : `Main check ${timedOut.checkId} was stopped after ${duration(timedOut.timeoutMs)}, before its own timeoutMs of ${duration(timedOut.checkTimeoutMs)}, because the main.verify step's time was nearly used up${step}.`);
  if (notRun.length) sentences.push(`Main check${notRun.length > 1 ? 's' : ''} ${notRun.join(', ')} did not run: the main.verify step's time was used up${timedOut ? '' : step}.`);
  const next = { once: ' It is verified once more automatically after the back-off that follows a failed verification.', used: ' This was its one automatic re-verification after an earlier timeout, so it is not verified again automatically: fix the cause (for example a lock or a slow host), then run main.verify.', off: ' Automatic verification is off (policy.autoQueue): fix the cause, then run main.verify.' }[retry] ?? '';
  const reason = `${sentences.join(' ')} Main verification of ${target} at ${String(head ?? 'unknown').slice(0, 12)} failed; its health is red until a verification passes.${next}`;
  const output = timedOut ? excerptBlock({ stderr: outputExcerpt(timedOut.stderr, secrets), stdout: outputExcerpt(timedOut.stdout, secrets) }) : '';
  const record = { checkId: timedOut?.checkId ?? notRun[0], timeoutMs: timedOut?.timeoutMs ?? null, limit: timedOut?.limitSource ?? 'verification', ...(Number.isSafeInteger(stepTimeoutMs) ? { stepTimeoutMs } : {}), ...(notRun.length ? { notRun } : {}) };
  return { record, reason, notice: `${reason}${timedOut ? (output ? `\n${output}` : ' It wrote no output.') : ''}`.slice(0, 2000) };
}
// Limit reports travel with the invocation record; usage accounting ignores them.
const invocationRecord = r => ({ ...accountingResult(r), ...(r.limits?.length ? { limits: r.limits } : {}) });
// `clock` is the time source of an upkeep assessment (tests replace it); nothing else here reads it.
async function maintenanceAction(intent, { run = runProcess, providerInvoke = invoke, machineRead, signal, deadlineAt, clock } = {}) {
  const action = intent.action, config = action.config, root = intent.projectRoot ?? intent.cwd;
  const runGit = (args, options) => retryRefLockedFetch(args, async () => { const prepared = await prepareGitInvocation(args, { cwd: options.cwd, env: options.env }); return run('git', prepared.args, { ...options, env: prepared.env }); });
  if (isScheduledOperation(config, action.operation)) return runScheduledTask(intent, { run, runGit, root, config, action });
  assert(allowed.has(action.operation) && action.operation !== 'queue.dispatch', 'unsupported maintenance action');
  // Create a task in the issue source, then import it through the normal read path.
  if(action.operation==='source.promote')return {route:'pass',promoted:await (await import('./source-sync.mjs')).promoteSourceTask(action.stateDir,{payload:action.jobPayload,expectedConfigDigest:action.configDigest})};
  if(action.operation==='source.create')return {route:'pass',created:await (await import('./source-sync.mjs')).createSourceTask(action.stateDir,{payload:action.jobPayload,operationId:createOperationId(action.projectId,action.flowId,action.jobPayload?.brief??{}),expectedConfigDigest:digest(config),run,signal})};
  if(action.operation==='source.sync')return {route:'pass',sourceSync:await (await import('./source-sync.mjs')).syncIssueSource(action.stateDir,{signal,expectedConfigDigest:action.configDigest??digest(config),run})};
  if (action.operation === UPKEEP_OPERATION) return (await import('./upkeep-assess.mjs')).runUpkeepAssessment(intent, { runGit, providerInvoke, signal, deadlineAt, ...(clock ? { now: clock } : {}) });
  // learnings.check (knowledge-upkeep design 11.4): read-only; it reads the learnings store at the
  // target head the factory last recorded, through hash-verified objects, and starts no model.
  if (action.operation === LEARNINGS_CHECK_OPERATION) return (await import('../operations/learnings-check.mjs')).runLearningsCheck({ root, config, head: action.mainHealth?.head ?? null });
  if (action.operation === 'retention.archive') {
    const retention=config.retention;assert(retention?.enabled===true&&Array.isArray(retention.preservation?.argv)&&retention.preservation.argv.length,'archive retention requires an enabled preservation adapter');
    const store=new Store(action.stateDir);
    try {
      const discover=async()=>{const command=retention.preservation;const result=await run(command.argv[0],command.argv.slice(1),{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8'},timeoutMs:command.timeoutMs??60000});assert(result.code===0,'retention preservation discovery failed');return JSON.parse(result.stdout);};
      const forge=createGitHub({repository:config.repository.slug,account:config.repository.account,hostname:config.repository.hostname, ghPath: config.repository.ghPath,issueProfile:config.repository.issueProfile});
      const result=await runArchiveRetention(store,{config:retention,flowId:action.flowId,operationId:action.jobPayload?.operationId??action.flowId,discover,forge,signal,dryRun:action.jobPayload?.dryRun===true});
      return {route:'pass',retention:result};
    } finally {store.close();}
  }
  if (action.operation === 'machine.sample') {
    const machineSample = sampleMachine({ ...(machineRead ? { read: machineRead } : {}) });
    if (config.resources?.coordinatorPath) {
      let coordinator;
      try {
        assert(existsSync(config.resources.coordinatorPath), 'coordinator unavailable'); coordinator = new HostResources(config.resources.coordinatorPath);
        machineSample.hostResources = { status:'observed', pools:[...new Set(['heavy-work',...Object.keys(config.resources.pools??{})])].map(resource=>coordinator.status(resource,config.resources.pools?.[resource])) };
      } catch { machineSample.hostResources = { status:'unknown' }; }
      finally { coordinator?.close(); }
    }
    return { route:'pass',machineSample };
  }
  // Bring one target branch up to date with another (repository.syncTargets) in a throwaway
  // worktree: nothing changes when it already contains it; a conflict stops without pushing.
  if (action.operation === 'target.sync') {
    const remote = config.repository.remote ?? 'origin', { from, into } = action.jobPayload ?? {}, env = process.env;
    assert((config.repository.syncTargets ?? []).some(row => row.from === from && row.into === into), 'target.sync needs a configured repository.syncTargets entry');
    const git = async (args, cwd = root, timeoutMs = 60000) => { const result = await runGit(args, { cwd, env, timeoutMs }); return result; };
    const fetched = await git(['fetch', '--no-tags', remote, `+refs/heads/${from}:refs/remotes/${remote}/${from}`, `+refs/heads/${into}:refs/remotes/${remote}/${into}`]);
    assert(fetched.code === 0, `could not fetch ${from} and ${into}: ${fetched.stderr}`);
    const fromHead = (await git(['rev-parse', '--verify', `${remote}/${from}^{commit}`])).stdout.trim(), intoHead = (await git(['rev-parse', '--verify', `${remote}/${into}^{commit}`])).stdout.trim();
    assert(/^[a-f\d]{40,64}$/i.test(fromHead) && /^[a-f\d]{40,64}$/i.test(intoHead), 'sync source and destination heads required');
    const contained = await git(['merge-base', '--is-ancestor', fromHead, intoHead]);
    if (contained.code === 0) return { route: 'pass', sync: { from, into, fromHead, head: intoHead, contained: true, upToDate: true } };
    const dir = join(action.stateDir, 'maintenance', action.flowId, 'sync');
    assert((await git(['worktree', 'add', '--detach', dir, intoHead])).code === 0, 'could not prepare the sync worktree');
    try {
      const merged = await git(['merge', '--no-edit', '-m', `Merge ${from} into ${into} (Factotum)`, fromHead], dir);
      if (merged.code !== 0) {
        const files = (await git(['diff', '--name-only', '--diff-filter=U'], dir)).stdout.split('\n').filter(Boolean);
        await git(['merge', '--abort'], dir);
        return { route: 'fail', sync: { from, into, fromHead, head: intoHead, conflict: true, files: files.slice(0, 50) }, reason: `${into} could not be updated from ${from}: conflicts in ${files.slice(0, 10).join(', ') || 'unknown files'}. Merge ${from} into ${into} by hand.` };
      }
      const head = (await git(['rev-parse', 'HEAD'], dir)).stdout.trim(), pushed = await git(['push', remote, `HEAD:refs/heads/${into}`], dir);
      assert(pushed.code === 0, `could not push ${into}: ${pushed.stderr}`);
      return { route: 'pass', sync: { from, into, fromHead, head, contained: true } };
    } finally { await git(['worktree', 'remove', '--force', dir]); }
  }
  if (action.operation === 'main.verify') {
    const remote = config.repository.remote ?? 'origin', target = action.jobPayload?.target ?? config.repository.target;
    const ref = `${remote}/${target}`, checks = [], mainCheckObservations = [];
    const executor = executorDigest();
    const artifactDir = action.artifactDir ?? join(action.stateDir, 'maintenance', action.flowId);
    let head = null, owned, cleanupPreserved = false, unchanged = false, infrastructureError, infrastructureArtifact, timedOut = null;
    // Checks run under operations/check-process.mjs, which stops waiting shortly after a check's own
    // process exits even if something it started holds its output open. An injected runner is used as given.
    const runCheck = run === runProcess ? runCheckProcess : run;
    // Checks the step's time ran out for before they could start (operations/effect-timeouts.mjs).
    const notRun = [];
    // Post-merge and admission-triggered verifications ask for the merge tier; schedules,
    // doctor and manual runs default to every check (merge and scheduled tiers).
    const tier = verifyTier(action.jobPayload), selected = Array.isArray(config.mainChecks) ? checksForTier(config, tier) : [];
    // Tier metadata is recorded only by projects that use tiers; untiered health keeps its shape.
    const tagged = hasScheduledTier(config), tierOf = check => tagged ? { tier: checkTier(check) } : {};
    try {
      assert(Array.isArray(config.mainChecks) && config.mainChecks.length > 0 && new Set(config.mainChecks.map(c => c.id)).size === config.mainChecks.length, 'nonempty unique main checks required');
      assert(selected.length > 0, 'at least one merge-tier main check required');
      const retries = config.policy?.mainInfrastructureRetries ?? 0;
      assert(Number.isSafeInteger(retries) && retries >= 0 && retries <= 2, 'main infrastructure retries must be bounded from zero to two');
      const fetched = await runGit(['fetch', remote, target], { cwd: root, env: process.env, timeoutMs: 60000 });
      if (fetched.code !== 0) throw Object.assign(new Error('main fetch failed'), { code: fetched.code, stdout: fetched.stdout, stderr: fetched.stderr });
      const base = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, env: process.env, timeoutMs: 10000 }); assert(base.code === 0 && /^[a-f\d]{40,64}$/i.test(base.stdout.trim()), 'main target missing');
      head = base.stdout.trim();
      // Setup runs under workspace.setupTimeoutMs, cut short to the step's time left (operations/effect-timeouts.mjs).
      owned = await workspace.prepare({ root, stateDir: action.stateDir, projectId: action.projectId, flowId: action.flowId, baseRef: head, setup: config.workspace?.setup ?? [], setupTimeoutMs: mainVerifySetupTimeoutMs(config, deadlineAt) });
      assert(!(await workspace.inspect({ workspace: owned })).dirty, 'main verification requires a clean prepared target');
      const before = repositoryIdentity(owned.path);
      for (const check of selected) {
        assert(check.id && Array.isArray(check.argv) && check.argv.length && Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0, 'invalid main check');
        validateMainCheckPolicy(check); validateMainCheckTier(check);
        const cacheKey = digest({ check, config, head, input: before, executor }), artifact = `check-${checks.length}.json`;
        const cached = reusableMainCheck({ action, check, head, input: before, executor });
        if (cached) {
          atomicJSON(join(artifactDir, artifact), { ...cached.evidence, reused: true, reusedFrom: cached.previous.evidencePath });
          const evidencePath = relative(action.stateDir, join(artifactDir, artifact));
          const row = { ...cached.previous, ...tierOf(check), artifact, evidencePath, evidenceDigest: fileDigest(join(artifactDir, artifact)), reused: true };
          checks.push(row);
          mainCheckObservations.push({ id: digest({ flowId: action.flowId, attemptId: intent.attemptId ?? null, checkId: check.id, cacheKey }), checkId: check.id, ...tierOf(check), head, status: 'passed', flaked: false, reused: true, observedAt: now(), verifiedAt: row.verifiedAt, source: cached.previous.evidencePath, artifact, attempts: [] });
          continue;
        }
        const attempts = [], flake = check.flakePolicy;
        const flakeRetries = flake && Date.parse(flake.expiresAt) > Date.now() ? flake.retries : 0;
        let infrastructureRetries = 0, productRetries = 0;
        for (let round = 0; round <= retries + flakeRetries; round++) {
          // Each check runs under its own timeoutMs, cut short only when the step's time is nearly used up.
          const { limitMs, source: limitSource } = mainVerifyCheckLimit(check, deadlineAt);
          // A short configured timeoutMs is valid; the launch threshold applies only when the step's time left is the limit.
          if (limitSource === 'verification' && limitMs < MAIN_CHECK_MIN_MS) break;
          const startedAt = now(); let observation;
          try {
            const result = await runCheck(check.argv[0], check.argv.slice(1), { cwd: owned.path, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', FACTOTUM_TARGET: target, FACTOTUM_CHECK_KIND: 'main' }, timeoutMs: limitMs });
            if (!Number.isSafeInteger(result.code) || result.code < 0) throw Object.assign(new Error('verification process has no known exit code'), { started: true, code: 'UNKNOWN_EXIT', stdout: result.stdout, stderr: result.stderr });
            observation = { startedAt, endedAt: now(), status: result.code === 0 ? 'passed' : 'failed', ...(result.code === 0 ? {} : { failureClass: 'product' }), exitCode: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
          } catch (error) {
            // A check stopped at its time limit is a failed check (red main), named with its limit, not
            // an infrastructure block: it ran only in this owned checkout, with no credentials, and
            // the factory writes nothing outside the checkout for it (docs/changes/dev85-main-verify-timeout.md).
            // A process that left the check's process group was not stopped: not contained, so not a plain timeout (see check-process.mjs).
            if (error.code === 'TIMEOUT' && error.started !== false && !error.escaped?.length) observation = { startedAt, endedAt: now(), status: 'failed', failureClass: 'timeout', timedOut: true, timeoutMs: limitMs, limitSource, exitCode: null, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
            else observation = { startedAt, endedAt: now(), status: 'blocked', failureClass: 'infrastructure', retryable: error.started === false && !['TIMEOUT','CANCELLED','OUTPUT_LIMIT','DESCENDANTS_SURVIVE','UNCERTAIN','UNKNOWN_EXIT'].includes(error.code), error: error.message, code: error.code ?? null, ...(error.escaped?.length ? { escaped: error.escaped } : {}), stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
          }
          attempts.push(observation);
          if (observation.status === 'blocked' && observation.retryable === true && check.retrySafe === true && infrastructureRetries < retries) { infrastructureRetries++; continue; }
          if (observation.status === 'failed' && flake?.exitCodes.includes(observation.exitCode) && check.retrySafe === true && productRetries < flakeRetries) { productRetries++; continue; }
          break;
        }
        // The step's time ran out before this check (or its flake retry) could start: the remaining
        // checks are not run, and the verification fails, naming them.
        if (!attempts.length) { notRun.push(...selected.slice(selected.indexOf(check)).map(c => c.id)); break; }
        const final = attempts.at(-1), flaked = final.status === 'passed' && attempts.some(attempt => attempt.status === 'failed');
        if (final.timedOut && !timedOut) timedOut = { checkId: check.id, timeoutMs: final.timeoutMs, limitSource: final.limitSource, checkTimeoutMs: check.timeoutMs, stdout: final.stdout, stderr: final.stderr };
        atomicJSON(join(artifactDir, artifact), { id: check.id, ...final, attempts, flaked, ...(flake ? { trackingRef: flake.trackingRef } : {}) });
        checks.push({ id: check.id, ...tierOf(check), status: final.status, passed: final.status === 'passed', ...(final.failureClass ? { failureClass: final.failureClass } : {}), ...(final.timedOut ? { timedOut: true, timeoutMs: final.timeoutMs, limitSource: final.limitSource } : {}), startedAt: attempts[0].startedAt, endedAt: final.endedAt, verifiedAt: final.endedAt, exitCode: final.exitCode ?? null, outputDigest: digest({ stdout: final.stdout, stderr: final.stderr }), artifact, attempts: attempts.length, flaked, reused: false, cacheKey, evidencePath: relative(action.stateDir, join(artifactDir, artifact)), evidenceDigest: fileDigest(join(artifactDir, artifact)) });
        mainCheckObservations.push({ id: digest({ flowId: action.flowId, attemptId: intent.attemptId ?? null, checkId: check.id, cacheKey }), checkId: check.id, ...tierOf(check), head, status: final.status, ...(final.timedOut ? { timedOut: true, timeoutMs: final.timeoutMs } : {}), flaked, reused: false, observedAt: now(), verifiedAt: final.endedAt, artifact, ...(flake ? { trackingRef: flake.trackingRef, flakePolicyExpired: Date.parse(flake.expiresAt) <= Date.now() } : {}), attempts: attempts.map(attempt => ({ status: attempt.status, exitCode: attempt.exitCode ?? null, startedAt: attempt.startedAt, endedAt: attempt.endedAt, outputDigest: digest({ stdout: attempt.stdout, stderr: attempt.stderr }) })) });
      }
      unchanged = digest(before) === digest(repositoryIdentity(owned.path));
      const refreshed = await runGit(['ls-remote', remote, `refs/heads/${target}`], { cwd: root, env: process.env, timeoutMs: 30000 });
      if (refreshed.code !== 0 || remoteRefHead(refreshed.stdout, `refs/heads/${target}`) !== head) {
        unchanged = false; infrastructureError = 'target advanced or became unavailable during verification'; infrastructureArtifact = `check-${checks.length}.json`;
        atomicJSON(join(artifactDir, infrastructureArtifact), { id: 'main-infrastructure', status: 'blocked', failureClass: 'infrastructure', error: infrastructureError, stdout: refreshed.stdout ?? '', stderr: refreshed.stderr ?? '', exitCode: refreshed.code, observedAt: now() });
      }
      if (!unchanged && !infrastructureError) infrastructureError = 'verification changed its input tree';
    } catch (error) {
      infrastructureError = error.message;
      infrastructureArtifact = `check-${checks.length}.json`;
      atomicJSON(join(artifactDir, infrastructureArtifact), { id: 'main-infrastructure', status: 'blocked', failureClass: 'infrastructure', error: error.message, code: error.code ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '', observedAt: now() });
    } finally {
      if (owned) { try { await workspace.release({ workspace: owned, preservation: { mergedInto: ref }, dryRun: false }); } catch { cleanupPreserved = true; } }
    }
    const blocked = !!infrastructureError || checks.some(c => c.status === 'blocked') || !unchanged;
    const passed = !blocked && checks.length > 0 && checks.length === selected.length && checks.every(c => c.passed);
    const checkedAt = now(), tiers = [...new Set(selected.map(checkTier))];
    // A full verification on a tiered project records the scheduled tier's own evidence, carried
    // across later merge-tier writes. A blocked run (any blocked check, an infrastructure error,
    // a moved target or changed input) records none, so earlier scheduled evidence stands.
    let scheduled;
    if (tagged && tier === 'all' && !blocked) {
      const rows = checks.filter(c => c.tier === 'scheduled');
      if (rows.length === selected.filter(c => checkTier(c) === 'scheduled').length && rows.every(c => c.status !== 'blocked')) scheduled = { status: rows.every(c => c.passed) ? 'green' : 'red', head, checkedAt, checks: rows, failed: rows.filter(c => !c.passed).map(c => c.id), ...(action.flowId ? { flowId: action.flowId } : {}) };
    }
    // A check stopped at its time limit, or checks the step's time ran out for, fail the verification
    // (route fail, red health) with a notice naming the check and the limit (engine attemptNotice).
    // Failed only because checks ran out of time: the target stays red but is verified once more
    // automatically, unless this run was that retry (operations/timeout-retry.mjs).
    const timeoutOnly = !!(timedOut || notRun.length) && checks.every(c => c.passed || c.failureClass === 'timeout'), timeoutRetry = action.jobPayload?.timeoutRetry === true;
    const timeout = !blocked && (timedOut || notRun.length) ? mainVerifyTimeout({ timedOut, notRun, target, head, stepTimeoutMs: intent.timeoutMs, secrets: knownSecrets(config), retry: timeoutOnly ? (timeoutRetry ? 'used' : config.policy?.autoQueue === true ? 'once' : 'off') : null }) : null;
    return { route: blocked ? 'blocked' : passed ? 'pass' : 'fail', mainCheckObservations, mainHealth: { status: blocked ? 'unknown' : passed ? 'green' : 'red', head, ...(target !== config.repository.target ? { target } : {}), checkedAt, ...(tagged ? { tier, tiers } : {}), checks, unchanged, ...(scheduled !== undefined ? { scheduled } : {}), ...(infrastructureError ? { failureClass: 'infrastructure', reason: infrastructureError, ...(infrastructureArtifact ? { artifact: infrastructureArtifact } : {}) } : {}), ...(timeout ? { timedOut: true, timeout: timeout.record, ...(timeoutOnly ? { timeoutOnly: true } : {}), ...(timeoutRetry ? { timeoutRetry: true } : {}), reason: timeout.reason } : {}) }, ...(timeout ? { timedOut: true, timeout: timeout.record, reason: timeout.reason, notice: timeout.notice } : {}), ...(cleanupPreserved ? { obligations: [{ title: 'Inspect preserved main-verification workspace', evidence: owned.path, approved: false, status: 'pending', owner: 'operator' }] } : {}) };
  }
  if (action.operation === 'maintenance.backup') {
    assert(config.backupRoot, 'external backupRoot required'); const destination = join(resolve(config.backupRoot), digest({ projectId: action.projectId, flowId: action.flowId }));
    if (existsSync(destination)) { const manifest = JSON.parse(readFileSync(join(destination, 'backup.json'), 'utf8')); assert(manifest.projectId === action.projectId && manifest.files.every(f => resolve(destination, f.path).startsWith(destination + '/') && fileDigest(join(destination, f.path)) === f.digest), 'existing backup is incomplete or corrupt'); return { route: 'pass', backup: { destination, reconciled: true, files: manifest.files.length } }; }
    return { route: 'pass', backup: backupProject(action.stateDir, destination) };
  }
  if (action.operation === 'audit') {
    const auditRole = config.providers.auditor ? 'auditor' : 'reviewer';
    const selected = action.modelRoute ?? config.providers[auditRole];
    const schema = { ...REVIEW_SCHEMA, properties: { ...REVIEW_SCHEMA.properties, findings: { ...REVIEW_SCHEMA.properties.findings, maxItems: 8 } } };
    let owned, auditRoot = root, targetHead, targetRef, cleanupPreserved = false, result, observation, invoked = false;
    try {
      if (config.repository?.target) {
        const remote = config.repository.remote ?? 'origin', target = config.repository.target;
        targetRef = `${remote}/${target}`;
        const fetched = await runGit(['fetch', remote, target], { cwd: root, env: process.env, timeoutMs: 60000 }); assert(fetched.code === 0, 'audit target fetch failed');
        const base = await runGit(['rev-parse', '--verify', `${targetRef}^{commit}`], { cwd: root, env: process.env, timeoutMs: 10000 });
        assert(base.code === 0 && /^[a-f\d]{40,64}$/i.test(base.stdout.trim()), 'audit target missing'); targetHead = base.stdout.trim();
        const observed = await runGit(['ls-remote', remote, `refs/heads/${target}`], { cwd: root, env: process.env, timeoutMs: 30000 }); assert(observed.code === 0 && remoteRefHead(observed.stdout, `refs/heads/${target}`) === targetHead, 'audit target advanced during preparation');
        owned = await workspace.prepare({ root, stateDir: action.stateDir, projectId: action.projectId, flowId: action.flowId, baseRef: targetHead, setup: config.workspace?.setup ?? [], setupTimeoutMs: config.workspace?.setupTimeoutMs });
        assert(!(await workspace.inspect({ workspace: owned })).dirty, 'audit requires a clean prepared target'); auditRoot = owned.path;
      } else assert(config.mode !== 'delivery', 'delivery audit requires a configured target');
      const before = repositoryIdentity(auditRoot);
      invoked = true;
      observation = await providerInvoke({ ...selected, role: auditRole, readOnly:true, ...(action.providerHolds?.length ? { heldProviders: action.providerHolds } : {}), cwd: auditRoot, artifactDir: action.artifactDir, prompt: `Read-only bounded audit of the recorded project target ${before.head}. Do not edit or publish. Return at most eight concrete findings with exact file/line evidence. No finding authorizes work.`, schema, timeoutMs: auditProviderTimeoutMs(config, deadlineAt) });
      validateSchema(observation.result, schema);
      assert(digest(repositoryIdentity(auditRoot)) === digest(before), 'audit changed project input');
      if (targetHead) {
        const current = await runGit(['ls-remote', config.repository.remote ?? 'origin', `refs/heads/${config.repository.target}`], { cwd: root, env: process.env, timeoutMs: 30000 });
        assert(current.code === 0 && remoteRefHead(current.stdout, `refs/heads/${config.repository.target}`) === targetHead, 'audit target advanced before publication of findings');
      }
      const findings = observation.result.findings.map(finding => {
        const path = realpathSync(resolve(auditRoot, finding.file)), file = relative(realpathSync(auditRoot), path);
        assert(file && file !== '..' && !file.startsWith('../') && !isAbsolute(file), 'audit finding outside project');
        const contents = readFileSync(path, 'utf8');
        assert(finding.line > 0 && finding.line <= contents.split('\n').length, 'audit finding has invalid source line');
        const evidenceDigest = digest(contents), fingerprint = digest({ source: 'audit', file, line: finding.line, message: finding.message, evidenceDigest });
        return { ...finding, id: `audit:${fingerprint}`, source: 'audit', file, title: finding.message, evidence: `${file}:${finding.line}`, evidenceDigest, inputIdentity: before, status: 'unapproved', approved: false };
      });
      result = { route: 'pass', inputIdentity: before, ...(targetHead ? { targetHead } : { scope: 'explicit-local-fixture' }), findings, provider: observation.provider, providerInvocations: [invocationRecord(observation)] };
    } catch (error) {
      if (invoked) error.providerInvocations = [invocationRecord(observation ?? error.accountingResult ?? { provider: selected.provider, model: selected.model })];
      throw error;
    } finally {
      if (owned) { try { await workspace.release({ workspace: owned, preservation: { mergedInto: targetRef }, dryRun: false }); } catch { cleanupPreserved = true; } }
      if (cleanupPreserved && result) result.obligations = [{ title: 'Inspect preserved audit workspace', evidence: owned.path, approved: false, status: 'pending', owner: 'operator' }];
    }
    return result;
  }
  const store = new Store(action.stateDir); try { return { route: 'pass', metrics: metrics(store), ...(action.jobPayload?.flowId ? { retrospective: recordRetrospective(store, { flowId: action.jobPayload.flowId }) } : {}) }; } finally { store.close(); }
}
