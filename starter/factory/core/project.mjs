import { cliCommand } from './install-layout.mjs';
import { failureRouteWarning, unsettledAttemptMessage } from './unsettled-attempt.mjs';
import { projectTargets, setTargetHealth } from '../operations/targets.mjs';
import { hasScheduledTier, verifyTier } from '../operations/main-tiers.mjs';
import { modelDefaults, pinFlowModels, selectFlowModels, updateModelDefaults, validateModelDefaults, validateTaskModels } from '../operations/model-settings.mjs';
import { withBuiltinModelGraphs } from './step-models.mjs';
import { validateInputs } from '../operations/inputs.mjs';
import { validateOriginalRequest } from '../operations/original-request.mjs';
import { MAINTENANCE_OPERATIONS } from './command-help.mjs';
import { LIVE_SETTINGS, liveValue, applyLiveChanges, keepLiveValues, operatorOnlyChanges, liveSettingChanges, recordLiveChanges, changedLiveSettings } from '../operations/live-settings.mjs';
import { queueStatus } from '../operations/queue-status.mjs';
import {sourceSettings} from '../operations/source-config.mjs';
import { bindingNode, PLAN_PROCEED } from './operations.mjs';
import { isPlanQuestion, planDigest, planContentDigest, proceedable, PLAN_CLARIFICATIONS } from './plan-questions.mjs';
import { carryProceededQuestions, carriedQuestionsText, archiveCarriedQuestions, MAX_CARRIED } from './worker-questions.mjs';
import { isScheduledOperation, scheduledTaskName, syncScheduledTaskRecords } from '../operations/scheduled-tasks.mjs';
import { recurringAcceptance, validateRecurringWorkflows } from '../operations/recurring-tasks.mjs';
import { nextOccurrence } from '../operations/schedules.mjs';
import { validNotBefore } from '../operations/not-before.mjs';
import { lifecycleEnabled, sourceCapabilities } from '../operations/source-adapter.mjs';
const hintCapabilities = config => { try { return config.mode === 'delivery' ? sourceCapabilities(config) : null; } catch { return null; } };
import { notificationLevel, flowNeedsAttention, notificationHealth, deliveryStarts, trimDeliveryBacklogInTransaction } from '../operations/notifications.mjs';
import { recoveryHoldMessage, recoveryHoldReason, clearRecoveryHold } from '../operations/recovery-hold.mjs';
import { manualJobGrant, operatorAuthority, validateDelegatedOperations, validateOnBehalfOf } from './delegation.mjs';
import { admittedWorkflow, approvalBinding, catalogDrift, commissionedDigest, compileCatalog, defaultWorkflow, pinnedWorkflowDigest, workflowAdmission } from './catalog.mjs';
import {acknowledgeDeliveryInTransaction} from '../operations/notifications.mjs';
import { bindOrchestratorSession, noteHandoffAnswerInTransaction, orchestratorSessionView } from '../operations/orchestrator-session.mjs';
import {operatorPresence,setOperatorPresence,publishStandaloneInbox,withdrawStandaloneInbox,answerStandaloneInbox,presentInbox,withdrawPresentation,settlePresentations,relayedAnswerInput,answerPresentation,recordRelay} from './communication.mjs';
import { assert, digest, id, note, now, PROTOCOL_VERSION, uid, validateWorkflow } from './contracts.mjs';
import { assertCheckScriptsApproved, assertUpkeepEnforced, checkApprovalFiles, hasUpkeepMarker, inUpkeepNamespace, isCheckTask } from './upkeep-namespace.mjs';
import { LEARNINGS_CHECK_OPERATION, UPKEEP_MODEL_WORKFLOW, UPKEEP_OPERATION, delegatedUpkeepChanges, upkeepAuthorityChanges, upkeepOn, withUpkeepRoute } from './upkeep-config.mjs';
import { ensureUpkeepRoutePinnedInTransaction, upkeepRouteAfter, writeUpkeepRouteInTransaction } from '../operations/upkeep-route.mjs';
import { enqueueManualUpkeepInTransaction, upkeepAfterRetrospectiveInTransaction } from '../operations/upkeep-runs.mjs';
import { namespaceCollisionReasons } from '../operations/upkeep-records.mjs';
import { countAttemptInvocationsInTransaction, settleUpkeepReservationInTransaction } from '../operations/upkeep-budget.mjs';
import { captureHeadReader, createCaptureTaskInTransaction, createContextTaskInTransaction, docsFollowUpEndedInTransaction, settleEndedFollowUpInTransaction, tryDocsFollowUpInTransaction } from '../operations/upkeep-tasks.mjs';
import { contextProviderRefusal, contextWaitingNoticeInTransaction, unqualifiedProviders } from '../operations/upkeep-context.mjs';
import { UPKEEP_CLOSE_OPERATION, requestFollowUpCloseInTransaction } from '../operations/upkeep-pr-close.mjs';
import { MAX_TASK_FINDINGS, disposeFindingInTransaction, findingAuthority, findingKind, isUpkeepCandidate, linkFindingsInTransaction, reopenFindingInTransaction, settleFindingTaskInTransaction } from '../operations/upkeep-candidates.mjs';
import { liftUpkeepCeilingInTransaction, noteUpkeepCountingInTransaction, recordUpkeepRegressionInTransaction } from '../operations/upkeep-ceilings.mjs';
import { upkeepSuspensions } from '../operations/upkeep-records.mjs';
import { attemptCostMicros, lastOccurrence, projectTaskCount, recentProjectTasks, scheduleRuns } from './records.mjs';
import { authorityLedgerEnabled, authorityStatus, noteTaskRevision } from './decision-authority.mjs';
import { answerDecisionCard, assertNoDecisionHold, carryDecisionsForward, decisionViews, disposeDecision, lapseClearance, openDecision, presentDecision, ratifyDecision, relayDecision, revokeDecision, taskDecisionSummary } from './decisions.mjs';
import { approvalAuthority, approvalAuthorityReasons, approvalPins, assertTaskRecordsSound, expireGrants, grantViews, issueGrant, revokeGrant, validateAuthorityReference } from './grants.mjs';
import { authorityPolicyChanges } from './authority-policy.mjs';
import { repositoryIdentity } from './repository.mjs';
import { upgradeOwned } from './install-layout.mjs';
import { assertGoverningEditsAllowed, assertGoverningEditsApproved, hasGoverningEdits } from '../operations/governance-edit.mjs';
import { attemptOutcome } from './attempt-outcome.mjs';
import { assertCurrentQuestion } from './stale-question.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerState } from '../operations/resources.mjs';
import { operatorHold, routeHoldReasons } from '../operations/provider-limits.mjs';
import { executorDigest, inspect, attemptDir, launchEndedBeforeOwnership } from './effects.mjs';
import { admissionReasons, metrics, retrospective, recordPushbackInTransaction } from '../operations/index.mjs';
import { validateConfig, changeWorkflow, obsoleteSettings, OBSOLETE_SETTING_REASONS } from './configuration.mjs';
import { observedStats, settingsView, upkeepHealthView } from '../operations/views.mjs';
import { effectiveRisk, mergeDecisionRole, riskSummary, strictReviewRequirement } from './risk.mjs';
import { validateQueueMetadata } from '../operations/queue-order.mjs';
import { recordQueueAdmission } from '../operations/queue-diagnostics.mjs';
import { workingRoot } from '../workflows/actions.mjs';
import {orderedQueue} from '../operations/queue-order.mjs';
import { captureConflictScope } from '../operations/conflicts.mjs';
import { installedOperation, integrationWorkflow, recordIntegrationDecision, readOnlyMaintenance } from '../workflows/integrations.mjs';
import { spendingSnapshot, SpendingLedger } from '../operations/spending.mjs';
import { atQuestion, pooled, takeSlot, waitingForSlot } from '../operations/capacity.mjs';

export function handshake(store) {
  const p = store.meta('project');
  return { protocolVersion: PROTOCOL_VERSION, projectId: p.projectId, serviceId: p.serviceId, name: p.name, stateRevision: store.meta('revision', 0), capabilities: ['snapshot', 'command', 'commandStatus', ...(authorityLedgerEnabled(store) ? ['decisionAuthority.v1', 'standaloneQuestion.v2', 'operatorGrants.v1'] : [])] };
}
export function snapshot(store) {
  const p = store.meta('project');
  const conflictScope = store.meta('config', {}).mode === 'delivery' ? captureConflictScope(store) : undefined;
  return {
    spending: spendingSnapshot(store.meta('config',{}), p.projectId),
    operatorPresence:operatorPresence(store), orchestratorSession: orchestratorSessionView(store),
    sourceSync:{...store.meta('sourceSync',{}),capabilities:hintCapabilities(store.meta('config',{})),type:sourceSettings(store.meta('config',{})).type,enabled:store.meta('config',{}).mode==='delivery'&&sourceSettings(store.meta('config',{})).enabled,configurationCurrent:store.meta('sourceSync',{}).configDigest?store.meta('sourceSync',{}).configDigest===store.meta('configDigest'):null},
    editPreconditions: { operatorPresenceVersion:true,taskRevision: true, scheduleGrant: true, queueOrder: true },
    projectId: p.projectId, name: p.name, revision: store.meta('revision', 0), paused: store.meta('paused'), recoveryHold: store.meta('recoveryHold'), recoveryHoldReason: recoveryHoldReason(store),
    health: { operationsFault: store.meta('operationsFault', null) ?? null, notifications: notificationHealth(store) },
    commissioningRequired: store.meta('config', {}).mode === 'delivery' && !(store.meta('commissioning')?.ready && store.meta('commissioning')?.configDigest === store.meta('configDigest')),
    tasks: recentProjectTasks(store, 100).map(t => taskView(store, t, { conflictScope })), taskCount: projectTaskCount(store), maintenanceTaskCount: store.count('task') - projectTaskCount(store), approvalNeededCount: store.live('task').filter(t => !isMaintenanceTask(t) && needsApproval(t)).length,
    flows: store.recent('flow', 100).map(publicFlow), inbox: store.recent('inbox', 100),
    attempts: store.recent('attempt', 100).map(publicAttempt),
    events: store.events(), commands: store.commandHistory(),
    budget: { unit: 'USD_MICRO', actual: attemptCostMicros(store), reserved: store.live('attempt').filter(a => !a.settledAt).reduce((sum, a) => sum + a.reservedMicros, 0) },
    queueComplete:true, queueRevision:queueRevision(store), queueTasks:store.live('queue').filter(q=>q.status==='queued').map(q=>store.get('task',q.id)).filter(Boolean).map(t=>taskView(store,t,{conflictScope})), queueDispatchOrder:orderedQueue(store).map(row=>row.id), queueStatus: hint(() => queueStatus(store), () => null), queue: store.all('queue'), schedules: store.all('schedule').map(schedule => scheduleView(store, schedule)), scheduled: hint(() => scheduledRows(store), () => []), mainHealth: store.meta('mainHealth', { status: 'unknown' }), targets: hint(() => projectTargets(store), () => []), targetHealth: store.meta('targetHealth', {}),
    machineSamples: store.recent('machineSample', 100), regressions: store.recent('regression', 100),
    findings: store.recent('finding', 100), pushback: store.recent('pushback', 100),
    // Knowledge upkeep in Health: suspensions and open candidates (design 8.4), from the live
    // finding set as the dashboard reads it. Totals are in Stats.
    upkeep: upkeepHealthView(store, { findings: store.live('finding') }),
    metrics: metrics(store), retrospectives: store.recent('retrospective', 50), obligations: store.recent('obligation', 100), deliveries: store.recent('delivery', 100), context: store.recent('context', 20),
    waits: store.recent('wait', 100), settings: settingsView(store), stats: observedStats(store),
    synthetic: store.meta('config', {}).mode !== 'delivery',
    ...(authorityLedgerEnabled(store) ? { authority: authorityStatus(store), decisions: decisionViews(store), grants: grantViews(store) } : {}),
  };
}
// Shared advisory read model for snapshot, paginated Tasks and selected-task detail.
export function taskView(store, task, { conflictScope } = {}) {
  const latest = store.db.prepare("SELECT type,at,payload FROM events WHERE type IN ('task.approved','task.revoked','task.approval-revoked') AND json_extract(payload,'$.taskId')=? ORDER BY sequence DESC LIMIT 1").get(task.id);
  const approvalHistory = latest ? { event:latest.type, at:latest.at, ...JSON.parse(latest.payload) } : null;
  const workflowSelection = hint(() => workflowAdmission(store, task), reasons => ({ selected: null, approved: task.approvedWorkflow?.name ?? null, current: false, reasons }));
  // admissionHolds: the same reasons with structured fields (operations/admission.mjs), for display.
  const facts = new Map(), reasons = store.meta('config',{}).mode==='delivery'?hint(()=>admissionReasons(store,task,{conflictScope,facts})):[];
  return { ...task, approvalHistory, approved:task.approvedRevision===task.revision, workflowSelection,
    admissionReasons:reasons, admissionHolds:reasons.map(text=>({ text, ...facts.get(text) })),
    // Migrated projects: the durable decision holds on this revision, by boundary.
    ...(authorityLedgerEnabled(store) ? { decisionHolds: hint(() => taskDecisionSummary(store, task), reasons => reasons.map(summary => ({ summary }))),
      // The exact pins an approval grant entry for this task needs now, shown before any grant is issued,
      // and whether the current approval's provenance still authorizes work.
      grantPins: approvalPins(store, task), approvalAuthorityReasons: approvalAuthorityReasons(store, task) } : {}),
  };
}
export function queueRevision(store) {
  return digest(store.live('queue').filter(q=>q.status==='queued').sort((a,b)=>(a.order??0)-(b.order??0)).map(q=>({id:q.id,priority:q.priority??0,pinned:q.pinned??false})));
}
// Eligibility hints are advisory presentation; a failure to compute one is shown, never treated as eligible.
function hint(compute, wrap = reasons => reasons) { try { return compute(); } catch (error) { return wrap([`eligibility unavailable: ${error.message}`]); } }
export function publicFlow({ workflow, workspace, modelRoutes, ...flow }) {
  // outcome tells an abandoned flow apart from one that failed; both have state failed.
  const visitBudgets = Object.fromEntries(Object.entries(workflow?.nodes ?? {}).filter(([,node]) => node.maxVisits).map(([step,node]) => {
    const cumulative = flow.visits?.[step] ?? 0, baseline = flow.limitExtensions?.[step] ?? 0, used = Math.max(0, cumulative - baseline);
    return [step, { allowance: node.maxVisits, used, remaining: Math.max(0, node.maxVisits - used), cumulative }];
  }));
  // parked: waiting on an answer and, within policy.maxParkedFlows, holding no flow slot (operations/capacity.mjs).
  return { ...flow, visitBudgets, parked: pooled(flow) && atQuestion(null, { ...flow, workflow }), outcome: flow.abandonedAt ? 'abandoned' : flow.state, ...(workspace ? { workspace: { branch: workspace.branch, base: workspace.base, head: workspace.head, ownershipDigest: workspace.ownershipDigest } } : {}) };
}
export function publicAttempt({ intent, receipt, ...attempt }) {
  // The routed outcome (core/attempt-outcome.mjs): recorded at settlement, or derived from the
  // receipt for an attempt settled before it was recorded.
  const routed = attempt.outcome ? {} : attemptOutcome(attempt.status, receipt?.actionResult) ?? {};
  // The operation name (not its inputs) says which evidence files the attempt can have: provider logs exist only for model steps.
  return { ...attempt, ...(typeof intent?.action?.operation === 'string' ? { operation: intent.action.operation } : {}), ...routed, ...(typeof receipt?.actionResult?.route === 'string' ? { route: receipt.actionResult.route } : {}), ...(receipt ? { receipt: { startedAt: receipt.startedAt, endedAt: receipt.endedAt, exitCode: receipt.exitCode, signal: receipt.signal, reason: receipt.reason, descendants: receipt.descendants, synthetic: receipt.synthetic, costMicros: receipt.costMicros, stdoutDigest: receipt.stdoutDigest, stderrDigest: receipt.stderrDigest, resultDigest: receipt.resultDigest } } : {}) };
}
export function assertAttemptQuiescent(store, attempt, p = {}) {
  const effect = inspect(store, attempt);
  assert(!['running','launching'].includes(effect.kind), 'owned attempt is still live or launching');
  const ownerPath = join(attemptDir(store, attempt), 'owner.json');
  if (existsSync(ownerPath)) {
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    assert(owner.attemptId === attempt.id && owner.intentDigest === attempt.intentDigest && ownerState(owner) === 'dead', 'owned process or cgroup quiescence is not established');
  } else assert(p.quiescence === 'independently-confirmed' || launchEndedBeforeOwnership(store, attempt), 'missing ownership evidence requires explicit independent quiescence attestation');
}
export function authorized(store, flow) {
  const task = store.need('task', flow.taskId);
  assert(!store.meta('recoveryHold'), recoveryHoldMessage(store));
  assert(!store.meta('retentionHold') || store.meta('retentionHold').flowId===flow.id, 'retention hold fences other dispatch');
  assert(!flow.stopRequested, 'flow is stopped');
  assert(task.revision === flow.taskRevision && task.approvedRevision === flow.taskRevision, 'current task approval required');
  // Migrated projects: an approval resting on a revoked or expired grant authorizes nothing more.
  const lapsed = approvalAuthorityReasons(store, task); assert(!lapsed.length, lapsed.join('; '));
  assert(flow.kind !== 'planning', 'planning flows were removed; abandon this flow');
  assert(flow.kind === 'maintenance' ? digest(flow.workflow) === flow.workflowDigest : commissionedDigest(store, flow) === flow.workflowDigest, 'workflow changed; revalidation required');
  assert(pinnedWorkflowDigest(store, flow) === flow.workflowDigest, 'pinned workflow digest mismatch');
  if (flow.kind === 'maintenance') {
    if (flow.integration) assert(digest(integrationWorkflow(store.meta('config'), flow.integration.id)) === flow.workflowDigest, 'installed integration workflow changed');
    if (task.approvalKind === 'schedule') {
      const schedule = store.need('schedule', task.scheduleId);
      assert(schedule.enabled && schedule.revision === task.scheduleRevision, 'scheduled authority changed or revoked');
    } else {
      const job = store.need('job', task.jobId);
      assert(manualJobGrant(job.grant) && job.grant.configDigest === flow.configDigest, 'manual maintenance grant invalid');
    }
  }
  assert(!flow.configDigest || store.meta('configDigest') === flow.configDigest, 'project configuration changed; revalidation required');
  assert(executorDigest() === flow.executorDigest, 'pinned executor differs; drain with original code');
  return task;
}
// The refusal of an answer whose candidate, risk or task changed since the question opened.
// The engine fingerprints parked questions again when it sees one (core/engine.mjs).
export const QUESTION_SUBJECT_CHANGED = 'question subject changed';
export function subject(store, flow, identity = repositoryIdentity(workingRoot(store, flow))) {
  // A task flow's questions are about the task, not the checkout: other merges must not invalidate them.
  if (flow.kind === 'task') return digest({ projectId: store.meta('project').projectId, flowId: flow.id, taskRevision: store.need('task', flow.taskId).revision, workflowDigest: commissionedDigest(store, flow), step: flow.step });
  return digest({ ...(flow.integration ? {integration:flow.integration,integrationResults:flow.results??{},integrationDecisions:flow.integrationDecisions??{},pinnedWorkflow:flow.workflowDigest}:{}), projectId: store.meta('project').projectId, flowId: flow.id, taskRevision: store.need('task', flow.taskId).revision, workflowDigest: ['maintenance','planning'].includes(flow.kind) ? flow.workflowDigest : commissionedDigest(store, flow), step: flow.step, ...(flow.mode === 'delivery' ? {risk:effectiveRisk(store.need('task', flow.taskId),flow), riskAssessments:flow.riskAssessments ?? [], riskAssessmentDigest:digest({summary:riskSummary(store.need('task',flow.taskId),flow),review:flow.results?.review??flow.results?.['satisfied-review']??null})} : {}), ...identity });
}
// Scheduled and manual maintenance runs each carry a synthetic task record. They are
// retained as history but are not project work, so Tasks and counts leave them out.
// Open work whose current revision has not been approved.
export const needsApproval = task => !task.tracked && task.approvedRevision !== task.revision && !task.closed && !task.blocked && task.status !== 'completed';
// policy.queueOnApproval: approving an open, unblocked task appends it to the queue;
// losing approval removes it again. Queueing never approves anything.
export function queueApprovedTask(store, task) {
  if (task.closed || task.blocked || task.status === 'completed' || isMaintenanceTask(task)) return;
  if (store.get('queue', task.id)?.status === 'queued' || store.by('flow', 'taskId', task.id).some(f => !['completed', 'failed'].includes(f.state))) return;
  const order = Math.max(-1, ...store.live('queue').filter(row => row.status === 'queued').map(row => row.order ?? 0)) + 1;
  store.put('queue', { id: task.id, order, status: 'queued', queuedAt: now(), source: 'approval' }); store.event('queue.updated', { taskIds: [task.id], reason: 'queued on approval' });
}
function dequeueUnapproved(store, taskId, reason) {
  if (store.meta('config', {}).policy?.queueOnApproval !== true) return;
  const row = store.get('queue', taskId); if (row?.status !== 'queued') return;
  store.put('queue', { ...row, status: 'removed', removedAt: now(), removalReason: reason }); store.event('queue.updated', { taskIds: [], removed: [taskId], reason: 'approval revoked' });
}
// What grant revocation and expiry do to derived work (core/grants.mjs decides what is derived).
export function grantHooks(store) {
  return {
    // A withdrawn approval: like task.revoke, but recorded as the grant's consequence.
    withdrawApproval(task, reason, stop) {
      const current = store.need('task', task.id);
      current.approvedRevision = null; current.approvalVersion++; delete current.approvalAuthority; store.put('task', current);
      dequeueUnapproved(store, current.id, reason);
      if (stop) for (const flow of store.by('flow', 'taskId', current.id)) stopFlow(store, flow, reason, true);
      store.event('task.approval-revoked', { taskId: current.id, revision: current.revision, reason });
    },
    lapseDisposition: (d, reason) => lapseClearance(store, d, reason),
  };
}
// Record grants that expired with derived approvals or clearances still active (each engine tick).
export function expireLapsedGrants(store) { return authorityLedgerEnabled(store) ? store.tx(() => expireGrants(store, grantHooks(store))) : []; }
// One occurrence of a recurring task: a new task, approved by the commissioned
// configuration and queued. A still-open previous occurrence skips it with one notice.
export function createRecurringOccurrence(store, config, name, { key, at }, { manual = false } = {}) {
  const definition = config.recurringTasks?.[name]; assert(definition, `recurring task ${name} is not in the configuration`);
  const open = store.all('task').find(t => t.recurring?.name === name && !t.closed && t.status !== 'completed' && (store.get('queue', t.id)?.status === 'queued' || store.all('flow').some(f => f.taskId === t.id && !['completed', 'failed'].includes(f.state))));
  if (open) {
    assert(!manual, `the previous occurrence ${open.id} is still open; finish or stop it first`);
    const noticeId = `recurring-skipped:${key}`;
    if (!store.get('inbox', noticeId)) store.put('inbox', { id: noticeId, kind: 'notice', status: 'open', version: 1, role: definition.notify ?? 'orchestrator', title: `Recurring task ${name} skipped`, context: `The occurrence due ${at} was not created because the previous one, ${open.id} (“${open.title}”), is still open. Finish or stop it; the next occurrence is created as usual.`, taskId: open.id, createdAt: now() });
    store.event('recurring.skipped', { name, key, openTaskId: open.id }); return { key, skipped: true, openTaskId: open.id, taskId: null };
  }
  const t = definition.task, taskId = id(key, 'recurring task id');
  // A recurring id is recurring:<name>…, so it cannot be in the reserved namespace; kept as a refusal.
  assert(!inUpkeepNamespace(taskId), `recurring occurrence id ${taskId} is in the reserved upkeep: namespace`);
  const brief = { id: taskId, title: (t.title ?? t.outcome).trim(), acceptance: recurringAcceptance(t).map(x => x.trim()), workflow: t.workflow };
  const revision = digest(brief), labels = t.labels?.length ? normalizeLabels(t.labels) : null;
  const task = { ...brief, ...(labels ? { labels } : {}), ...(t.description ? { description: t.description } : {}), recurring: { name, at, manual }, revision, approvedRevision: revision, approvalVersion: 1, approvedAt: now(), approvalKind: 'recurring' };
  task.approvedWorkflow = approvalBinding(store, task);
  store.put('task', task); noteTaskRevision(store, task, { brief, recordedBy: 'recurring' }); queueApprovedTask(store, task);
  store.event('task.updated', { taskId, revision }); store.event('task.approved', { taskId, revision, by: 'recurring task configuration' });
  store.event('recurring.created', { name, key, taskId, manual }); return { key, taskId, skipped: false };
}
// originalRequest is provenance, not authority, but it is part of the brief the operator approves:
// editing it changes the revision and needs approval again, like any other brief change.
// `upkeep` is the marker the factory writes on an upkeep task (knowledge-upkeep design 7.2): it is
// part of the brief, so it is in the revision digest, the flow's task snapshot and, on a migrated
// project, the immutable revision snapshot, and an approval covers exactly the marker that will be
// enforced. A field that is absent is not in the brief at all, so no other task's revision changes.
// `governingEdits` names the governing context entries a task may change (operations/governance-edit.mjs):
// part of the brief, so the approval of a revision covers exactly the files it names.
export const BRIEF_FIELDS = Object.freeze(['outcome','source','dependencies','area','paths','risk','recovery','postMerge','category','blocked','closed','parent','followup','tracked','workflow','inputs','originalRequest','governingEdits','upkeep']);
// Upgrade-owned paths of the project checkout, or null when its lock cannot be read.
function projectOwned(store) { try { return upgradeOwned(store.meta('project').root); } catch { return null; } }
export const briefOf = task => ({ id: task.id, title: task.title, acceptance: task.acceptance, ...Object.fromEntries(BRIEF_FIELDS.filter(k => task[k] !== undefined).map(k => [k, task[k]])) });
// The brief without dependency progress: which dependencies there are and, where the source
// reports it, their content, but not their state or progress labels.
export function stableBrief(brief) {
  if (!brief.source) return brief;
  const { externalDependencies, contentRevision, revision, ...source } = brief.source;
  return { ...brief, source: { ...source, revision: contentRevision ?? revision, externalDependencies: (externalDependencies ?? []).map(fact => ({ taskId: fact.taskId ?? null, repository: fact.repository ?? null, issue: fact.issue ?? null, sourceId: fact.sourceId ?? null })) } };
}
// Only dependency progress moved: the stable briefs match and no dependency's content changed.
// A fact recorded before content was tracked has nothing to compare against, so it counts as unchanged.
function onlyDependencyProgress(old, brief) {
  if (digest(stableBrief(old)) !== digest(stableBrief(brief))) return false;
  const before = new Map((old.source?.externalDependencies ?? []).map(fact => [fact.taskId ?? fact.issue, fact.contentRevision]));
  return (brief.source?.externalDependencies ?? []).every(fact => { const was = before.get(fact.taskId ?? fact.issue); return !was || !fact.contentRevision || was === fact.contentRevision; });
}
// Up to 16 unique, trimmed labels of at most 40 characters.
export function normalizeLabels(labels) {
  assert(Array.isArray(labels) && labels.length <= 16 && labels.every(label => typeof label === 'string' && label.trim() && label.trim().length <= 40), 'labels must be up to 16 non-empty strings of at most 40 characters');
  return [...new Set(labels.map(label => label.trim()))];
}
// An attempt settled by a person's command (attempt.resolve, task.restart): the same two things
// the engine's settlement does for knowledge upkeep. The caller writes the attempt afterwards.
function settleAttemptForUpkeepInTransaction(store, attempt, flow) {
  countAttemptInvocationsInTransaction(store, attempt, flow);
  settleUpkeepReservationInTransaction(store, attempt, flow);
}
// Knowledge upkeep cannot be turned on (its mode moved up from off) while an open task the factory
// did not make sits in the reserved upkeep: namespace (operations/upkeep-records.mjs). The lookup is
// a bounded read of a declared index; when that index is not verified, the answer is a refusal.
function assertUpkeepMayTurnOn(store, before, after) {
  if (!upkeepOn(after) || !upkeepAuthorityChanges(before, after).turnedUp) return;
  let reasons; try { reasons = namespaceCollisionReasons(store); } catch (error) { reasons = [error.message]; }
  assert(!reasons.length, `knowledge upkeep cannot be turned on: ${reasons.join('; ')}`);
}
export const isMaintenanceTask = task => ['schedule', 'job'].includes(task?.approvalKind) || task?.id?.startsWith('job:');
// ---- Findings and their tasks (knowledge-upkeep design 4.3, 4.4) ----
// Who may act on a finding. A governing-context proposal and a rule are the operator's alone, under
// any instruction or delegation; every other kind, and an audit finding, may also be acted on by
// the orchestrator on a recorded instruction where the command is in policy.delegatedOperations.
function findingActor(store, row, { operation, actor, onBehalfOf }) {
  if (findingAuthority(row) === 'operator') assert(actor === 'operator', `${operation} on a ${findingKind(row)} candidate is the operator's alone: a governing-context proposal or a rule is not accepted, declined, resolved or reopened on a recorded instruction or by delegation`);
  else operatorAuthority(store, { operation, actor, onBehalfOf });
}
// Close a task as task.put {closed: true} does: a new revision, no approval, its flows stopped.
// It also closes a task task.put will not edit (one that carries an upkeep marker), keeping the
// marker (part of the brief) and the findings it is linked to.
export function closeLinkedTaskInTransaction(store, taskId, reason) {
  const old = store.get('task', taskId); if (!old || old.closed || old.status === 'completed') return old ?? null;
  const brief = { ...briefOf(old), closed: true }, revision = digest(brief);
  for (const flow of store.by('flow', 'taskId', old.id)) stopFlow(store, flow, 'task brief changed', true);
  const task = { ...brief, ...(old.labels?.length ? { labels: old.labels } : {}), ...(old.notBefore ? { notBefore: old.notBefore } : {}), ...(old.models ? { models: old.models } : {}), ...(old.findings?.length ? { findings: old.findings } : {}), revision, approvedRevision: null, approvalVersion: (old.approvalVersion ?? 0) + 1, closedReason: reason };
  store.put('task', task);
  noteTaskRevision(store, task, { previousRevision: old.revision, brief, recordedBy: 'finding' }); carryDecisionsForward(store, task, old.revision);
  if (old.approvedRevision) { store.event('task.approval-revoked', { taskId: task.id, previousRevision: old.revision, revision, reason }); dequeueUnapproved(store, task.id, reason); }
  if (hasUpkeepMarker(old)) docsFollowUpEndedInTransaction(store, task.id);
  store.event('task.updated', { taskId: task.id, revision, closed: true, reason }); return task;
}
// The factory ends an upkeep follow-up's flow (knowledge-upkeep design 7.6), as flow.abandon would,
// with its conditions: no attempt in hand and no proven merge. Its candidates return (a drain) or
// fail, its task is closed, and the time it held a slot without working is recorded. A published
// pull request is left for the operator: the notice names it.
export function abandonUpkeepFlowInTransaction(store, flow, { end, returns = null, retainedMs = 0 }) {
  assert(!flow.attemptId && !flow.results?.merge?.merged && !['completed', 'failed'].includes(flow.state), `flow ${flow.id} cannot be ended now: it has an attempt in hand, a proven merge, or has finished`);
  const at = now(), why = { drain: 'maintenance is held for a drain', stale: 'a declared file is no longer the version it was validated at (stale)', 'base-moved': 'the target moved under it and changed a declared file',  question: 'it reached a question other than its merge decision', invocations: 'it used its model invocations (upkeep.budget.maxFlowInvocations)', stopped: `it was stopped${flow.stopReason ? ` (${flow.stopReason})` : ''}`, 'parked-beyond-allowance': 'it was parked beyond policy.maxParkedFlows' }[end] ?? end;
  const note = `Knowledge upkeep follow-up ended by the factory: ${why}. Its candidates ${returns ? 'return to waiting' : 'are recorded as failed; a person may reopen them'}.`;
  Object.assign(flow, { state: 'failed', stopRequested: true, abandonedAt: at, finishedAt: at, abandonReason: note, upkeepEnded: { reason: end, returns, retainedSlotMs: retainedMs, at } });
  store.put('flow', flow); settleFlowJob(store, flow, 'abandoned', note); closeAbandonedInbox(store, flow, 'flow abandoned');
  store.event('flow.abandoned', { flowId: flow.id, note, by: 'factory', workspaceRetained: !!flow.workspace, upkeep: { reason: end, returns, retainedSlotMs: retainedMs } });
  if (retainedMs > 0) store.event('upkeep.slot-retained', { flowId: flow.id, taskId: flow.taskId, reason: end, retainedSlotMs: retainedMs });
  settleEndedFollowUpInTransaction(store, flow, { reason: end, returns, closeTask: (taskId, reason) => closeLinkedTaskInTransaction(store, taskId, reason) });
  // The pull request it published, if any, is closed with a comment by a recorded, retried job,
  // outside this transaction (operations/upkeep-pr-close.mjs).
  const closing = requestFollowUpCloseInTransaction(store, flow, { reason: end });
  store.put('inbox', { id: `upkeep-ended:${flow.id}`, kind: 'notice', status: 'open', flowId: flow.id, version: 1, role: 'orchestrator', title: `${flow.taskSnapshot?.title ?? flow.taskId}: ended by the factory`, context: `${note}${closing ? ` The factory is closing its pull request #${closing.number}, with a comment; if it cannot, an operator to-do says so.` : ''}${flow.workspace ? ' Its workspace is kept for the usual failed-flow cleanup.' : ''}`, taskId: flow.taskId, createdAt: at });
  // The next follow-up, if candidates are waiting and the limits allow.
  tryDocsFollowUpInTransaction(store, { tasks: findingTasks(store) });
  return flow;
}
// One notice for an upkeep follow-up whose attempt is uncertain: it is not ended; the existing
// reconciliation (attempt.resolve) applies, and the slot it holds meanwhile is unwanted retention.
export function noteUncertainUpkeepFlowInTransaction(store, flow) {
  const noticeId = `upkeep-uncertain:${flow.id}:${flow.attemptId}`; if (store.get('inbox', noticeId)) return null;
  return store.put('inbox', { id: noticeId, kind: 'notice', status: 'open', flowId: flow.id, version: 1, role: 'operator', title: `${flow.taskSnapshot?.title ?? flow.taskId}: an uncertain attempt holds a slot`, context: `Knowledge upkeep follow-up ${flow.id} cannot be ended while attempt ${flow.attemptId} is uncertain. Reconcile it (attempt.resolve); the factory then ends the flow and its candidates are recorded as failed.`, taskId: flow.taskId, createdAt: now() });
}
// What the finding lifecycle (operations/upkeep-candidates.mjs) needs to know about tasks. It writes
// no task itself.
export const findingTasks = store => ({
  get: taskId => taskId ? store.get('task', taskId) ?? null : null,
  // A task with an unfinished flow is stopped first, as for any task.
  busy: task => { const flow = store.by('flow', 'taskId', task.id).find(f => !['completed', 'failed'].includes(f.state) && (f.state !== 'stopped' || f.attemptId)); return flow ? `flow ${flow.id} is ${flow.attemptId ? 'running a step' : flow.state}; stop it first` : null; },
  started: task => store.by('flow', 'taskId', task.id).length > 0,
  close: (taskId, reason) => closeLinkedTaskInTransaction(store, taskId, reason),
});
// The findings a flow's task is linked to, moved when the flow's fate is known: its merge is
// proven (delivered), it failed (failed), or it completed with nothing to merge (resolved
// elsewhere, with what the completion rests on as its evidence). The ids are on the flow in hand;
// with none, nothing is read. A delivery names the revision the flow ran, so that an audit finding
// an earlier failed flow of the same task revision left `failed` is delivered too.
export function flowCompletionEvidence(flow) {
  const satisfied = flow.completionMode === 'already-satisfied', head = satisfied ? flow.results?.['satisfied-record']?.head : flow.completionDecision?.identity?.head;
  const completion = { flowId: flow.id, taskId: flow.taskId, taskRevision: flow.taskRevision ?? null, mode: satisfied ? 'already-satisfied' : flow.completionDecision ? 'accepted-outcome' : 'completed', head: head ?? null, at: flow.finishedAt ?? null };
  const how = satisfied ? `its accepted outcome was proven already on the target${head ? ` at ${head}` : ''}` : flow.completionDecision ? `its outcome was accepted${head ? ` at ${head}` : ''}` : 'its workflow completed';
  return { completion, evidence: `Flow ${flow.id} of task ${flow.taskId} completed without a merge: ${how}` };
}
export function settleFlowFindingsInTransaction(store, flow, outcome) {
  const findingIds = [...new Set([...(flow.findings ?? []), ...(flow.taskSnapshot?.findings ?? [])])];
  if (!findingIds.length) return [];
  // 10.3: a merged check task's completion notice says that listing the rule in
  // fastChecks.checks[].rules, so that reviewers stop raising it, is the operator's configuration edit.
  if (outcome === 'delivered' && flow.taskSnapshot?.upkeep?.kind === 'check') checkDeliveredNoticeInTransaction(store, flow);
  return settleFindingTaskInTransaction(store, { taskId: flow.taskId, findingIds, outcome, flowId: flow.id, taskRevision: flow.taskRevision ?? null, upkeepTask: hasUpkeepMarker(flow.taskSnapshot), ...(outcome === 'resolved-elsewhere' ? flowCompletionEvidence(flow) : {}) });
}
function checkDeliveredNoticeInTransaction(store, flow) {
  const id = `upkeep-check-delivered:${flow.taskId}`; if (store.get('inbox', id)) return;
  const checks = [...new Set((flow.taskSnapshot.upkeep.files ?? []).flatMap(file => file.checks ?? []))];
  store.put('inbox', { id, kind: 'notice', status: 'open', version: 1, role: 'operator', title: 'A fast-check change from knowledge upkeep merged',
    context: `Task ${flow.taskId} changed the script of fast check ${checks.join(', ')}. Reviewers are told not to raise a rule only when it is listed in fastChecks.checks[].rules. Listing it there is a configuration change you make (config update); nothing does it for you. The rule as accepted is in the task's evidence.`, taskId: flow.taskId, flowId: flow.id, createdAt: now() });
  store.event('inbox.created', { inboxId: id });
}
// One row per schedule: how often it has run and how its latest run ended.
// A maintenance flow's job ends with its flow; an abandoned flow leaves no job "running".
export function settleFlowJob(store, flow, status, reason) {
  const job = flow.jobId ? store.get('job', flow.jobId) : null;
  if (!job || ['completed', 'failed', 'revoked', 'abandoned'].includes(job.status)) return;
  if (status === 'failed') reason ??= flow.results?.run?.reason ?? flow.results?.run?.error;
  store.put('job', { ...job, status, finishedAt: now(), ...(reason ? { reason } : {}) }); store.event('job.settled', { jobId: job.id, flowId: flow.id, status });
}
export function scheduleView(store, schedule) {
  // A scheduled task's manual runs (Run now) count as its runs too.
  const { runs, last } = scheduleRuns(store, schedule), flow = last?.flowId ? store.get('flow', last.flowId) : null;
  const outcome = flow?.results?.run, definition = schedule.scheduledTask ? store.meta('config', {}).scheduledTasks?.[schedule.scheduledTask] : null;
  return { ...schedule, ...(definition ? { description: definition.description ?? null, network: definition.network, notify: definition.notify ?? 'orchestrator' } : {}), runs, lastRun: last ? { jobId: last.id, flowId: last.flowId ?? null, status: last.status, startedAt: last.createdAt ?? null, finishedAt: last.finishedAt ?? flow?.finishedAt ?? null,
    ...(schedule.scheduledTask && outcome ? { result: { route: outcome.route, exitCode: outcome.exitCode ?? null, head: outcome.head ?? null, report: String(outcome.report ?? '').slice(-4000) } } : {}) } : null };
}
// Everything with a time ahead of it, soonest first: tasks held until a not-before time,
// recurring tasks, scheduled tasks and maintenance schedules.
export function scheduledRows(store, { nowMs = Date.now() } = {}) {
  const config = store.meta('config', {}), rows = [];
  const flowOf = taskId => store.by('flow', 'taskId', taskId).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).at(-1) ?? null;
  for (const task of store.live('task').filter(t => t.notBefore && !t.closed && t.status !== 'completed' && !isMaintenanceTask(t))) {
    const flow = flowOf(task.id);
    if (flow && ['completed', 'failed'].includes(flow.state)) continue;
    rows.push({ kind: 'task', id: task.id, title: task.title, at: task.notBefore, due: Date.parse(task.notBefore) <= nowMs, approved: task.approvedRevision === task.revision, queued: store.get('queue', task.id)?.status === 'queued', flow: flow ? { id: flow.id, state: flow.state } : null, revision: task.revision });
  }
  for (const schedule of store.all('schedule').filter(s => !s.removedAt)) {
    const view = scheduleView(store, schedule), base = { id: schedule.id, at: nextOccurrence(schedule, { nowMs }), enabled: schedule.enabled, paused: schedule.paused ?? null, source: schedule.source ?? 'console', type: schedule.type, everyMs: schedule.everyMs ?? null, timeOfDay: schedule.timeOfDay ?? null, timezone: schedule.timezone ?? null, weekdays: schedule.weekdays ?? null, revision: schedule.revision ?? null };
    if (schedule.recurringTask) {
      const definition = config.recurringTasks?.[schedule.recurringTask], last = lastOccurrence(store, schedule.id) ?? undefined;
      const task = last?.commandId ? store.get('task', last.commandId) : null, flow = task ? flowOf(task.id) : null;
      rows.push({ ...base, kind: 'recurring', name: schedule.recurringTask, title: definition?.task.title ?? definition?.task.outcome ?? schedule.recurringTask, workflow: definition?.task.workflow ?? null, last: last ? { at: last.at, manual: last.manual === true, taskId: task?.id ?? null, outcome: !last.commandId ? 'skipped' : task?.status === 'completed' ? 'completed' : flow ? flow.state : store.get('queue', task?.id)?.status === 'queued' ? 'queued' : 'created' } : null });
    } else rows.push({ ...base, kind: schedule.scheduledTask ? 'scheduled-task' : 'maintenance', name: schedule.scheduledTask ?? schedule.operation, operation: schedule.operation, title: view.description ?? schedule.scheduledTask ?? schedule.operation, last: view.lastRun ? { at: view.lastRun.finishedAt ?? view.lastRun.startedAt, outcome: view.lastRun.result ? view.lastRun.result.route : view.lastRun.status, flowId: view.lastRun.flowId, ...(typeof view.lastRun.result?.report === 'string' ? { report: view.lastRun.result.report.slice(0, 20000) } : {}) } : null });
  }
  return rows.sort((a, b) => (a.at ? Date.parse(a.at) : Infinity) - (b.at ? Date.parse(b.at) : Infinity) || a.id.localeCompare(b.id));
}
export function flowNotice(store,flow,outcome,reason='') {
  const keepAttention = notificationLevel(store.meta('config', {})) === 'actionable' && flowNeedsAttention(store, flow, outcome, reason);
  if (outcome === 'failed' && !reason && flow.kind === 'maintenance') reason = flow.results?.run?.reason ?? flow.results?.run?.error ?? '';
  // The orchestrator does not need a notice about a flow end its own command caused.
  if(notificationLevel(store.meta('config',{}))==='essential'&&store.commandActor==='orchestrator')return;
  // Maintenance the orchestrator enqueued itself: success is quiet, failure still notifies.
  if(notificationLevel(store.meta('config',{}))==='essential'&&flow.kind==='maintenance'&&outcome==='completed'&&flow.jobId&&store.get('job',flow.jobId)?.grant?.actor==='orchestrator')return;
  // A task the orchestrator itself reported done needs no notice back to it.
  if(notificationLevel(store.meta('config',{}))==='essential'&&flow.kind==='task'&&outcome==='completed'&&store.by('inbox','flowId',flow.id).filter(row=>row.status==='answered').sort((a,b)=>String(a.answeredAt).localeCompare(String(b.answeredAt))).at(-1)?.answeredBy==='orchestrator')return;
  if(!keepAttention&&flow.kind==='maintenance'&&flow.jobPayload?.phase==='stopped')return;
  // Routine observations retain their flow, job, events and retrospective without
  // turning an uneventful timer tick into an operator attention request.
  // Read-only maintenance workflows: a pass completes quietly; a failure carries the adapter's evidence.
  if(flow.kind==='maintenance'&&flow.integration&&readOnlyMaintenance(store.meta('config',{}),flow.integration.id)){
    if(outcome==='completed'&&!keepAttention)return;
    if(outcome==='failed'&&!reason){const failed=Object.entries(flow.results??{}).filter(([,row])=>row?.route==='fail').at(-1);if(failed){const [step,row]=failed,evidence=JSON.stringify(row.observations??row.outcomes??row.adapterResult??{});reason=`${step} reported a failure${row.summary?`: ${String(row.summary).slice(0,500)}`:''}${evidence&&evidence!=='{}'?`\n\nEvidence: ${evidence.slice(0,3500)}`:''}`;}}
  }
  // Scheduled tasks: exit 0 is quiet; anything else is one notice with the report.
  const scheduledName=flow.kind==='maintenance'?scheduledTaskName(flow.workflow?.nodes?.run?.action?.operation??(flow.jobId?store.get('job',flow.jobId)?.operation:null)):null;
  let noticeRole='orchestrator',noticeTitle=null;
  if(scheduledName){
    if(outcome==='completed'&&!keepAttention)return;
    const definition=store.meta('config',{}).scheduledTasks?.[scheduledName]??{},row=flow.results?.run;
    noticeRole=definition.notify??'orchestrator';noticeTitle=`Scheduled task ${scheduledName} ${row?.route==='fail'?`failed (exit ${row.exitCode})`:'could not run'}`;
    if(outcome==='completed'){
      noticeTitle=`Scheduled task ${scheduledName} completed with follow-up`;
      if(!reason)reason=`The command completed, but retained evidence requires attention. Read its obligations and retrospective.\n\n${row?.report||'(no output)'}`;
    }
    if(!reason)reason=row?.route==='fail'?`${definition.description?`${definition.description}\n\n`:''}Exit ${row.exitCode} on ${String(row.head??'').slice(0,12)}.${row.wroteFiles?' The command also wrote files in its checkout.':''}\n\n${row.report||'(no output)'}${row.reportTruncated?'\n\n(report truncated; the full report is in the run’s report.json)':''}`:`The scheduled task could not run: ${row?.error??'see the attempt receipt'}.`;
  }
  if(!keepAttention&&flow.kind==='maintenance'&&outcome==='completed'&&!flow.integration){
    const operation=flow.workflow?.nodes?.run?.action?.operation??store.get('job',flow.jobId)?.operation;
    const result=flow.results?.run;
    const actionable=Object.values(flow.results??{}).some(row=>['fail','failed','blocked','partial'].includes(row?.route)||(row?.findings?.length??0)>0||(row?.obligations?.length??0)>0);
    if(!actionable&&operation==='source.sync'){
      const report=result?.sourceSync;
      if(report?.status==='ok'&&report.complete===true&&report.errors===0&&['imported','changed','revoked'].every(key=>report[key]===0))return;
    }else if(!actionable&&['main.verify','maintenance.backup','machine.sample','audit','retrospective','forge.lifecycle',UPKEEP_OPERATION,UPKEEP_CLOSE_OPERATION,LEARNINGS_CHECK_OPERATION].includes(operation)){
      const successful=result?.route==='pass'||operation==='forge.lifecycle'&&['ready','candidate','planned','satisfied'].includes(result?.route)||operation===UPKEEP_CLOSE_OPERATION&&['closed','already-closed'].includes(result?.route);
      if(successful&&(operation!=='main.verify'||result.mainHealth?.status==='green'))return;
    }
  }
  // A finished action whose only fault was a surviving descendant is a containment
  // failure, not a failed operation: say so, so it can be triaged without the receipt.
  let label=outcome;
  if(outcome==='failed'&&!reason){
    const attempt=store.by('attempt','flowId',flow.id).filter(row=>row.status==='failed').at(-1),receipt=attempt?.receipt;
    if(receipt?.reason==='descendant-survival'&&receipt.exitCode===0&&receipt.actionResult&&!receipt.actionResult.error&&receipt.actionResult.route!=='error'){
      const survivors=[...new Set((receipt.descendants??[]).map(row=>row.comm))].join(', ')||'a child process';
      label='containment failed';
      reason=`The action finished and its results were recorded, but ${survivors} was still running after it exited, so the supervisor terminated it and recorded attempt ${attempt.id} as failed. Its receipt lists the surviving processes.${flow.kind==='maintenance'&&store.get('job',flow.jobId)?.scheduleId?' The next scheduled run will retry.':''}`;
    }
  }
  // Deduplicate observations within a stop, not a later stop after recovery.
  // Legacy stopped records keep their old notice ID until their next stop episode.
  const id=`flow-notice:${flow.id}:${outcome}:${digest({step:flow.step,reason,...(flow.stopSequence && ['stopped','failed'].includes(outcome) ? {stopSequence:flow.stopSequence} : {})})}`;
  // A completed flow whose cleanup failed says so: the workspace and branch remain until a retry or the operator releases them.
  // When the cleanup finishes, settleCleanupPending (operations/workspace-cleanup.mjs) rewrites this paragraph.
  // Steps that reported a failure and were corrected before the flow completed (a failed fast check
  // sent back to the builder) are part of the completion summary, not a request for attention.
  const recovered=outcome==='completed'&&flow.kind!=='maintenance'?recoveredFailures(store,flow):[];
  const recoveredNote=recovered.length?`\n\nCorrected on the way: ${recovered.join('; ')}. Each time the flow went back to the builder and the step later passed; nothing is outstanding from it.`:'';
  // A build that stopped at its turn limit and was retried from the build question (dev.85, I2).
  const limited=outcome==='completed'&&flow.kind!=='maintenance'?recoveredFailures(store,flow,'turn-limit'):[];
  const limitedNote=limited.length?`\n\nStopped at the turn limit on the way: ${limited.join('; ')}. Each time the step did not finish, the flow asked how to continue, and a later attempt finished it.`:'';
  // The questions a completed task flow went ahead on without an answer, with the answers assumed (dev.83).
  const carried=outcome==='completed'&&flow.kind!=='maintenance'?carriedQuestionsText(flow):'';
  const carriedNote=carried?`\n\n${carried}`:'';
  const cleanupNote=outcome==='completed'&&flow.cleanupPending&&flow.workspace?`\n\nCleanup is outstanding: the owned workspace ${flow.workspace.path} and branch ${flow.workspace.branch} were not released (${flow.cleanupFailure?.reason??'cleanup failed'}). The factory retries it automatically and raises an operator to-do if that fails; to finish it now, run ${cliCommand(store.meta('project')?.root)} cleanup plan --state <state> --id ${flow.id}, then cleanup apply with the plan digest.`:'';
  if(!store.get('inbox',id))store.put('inbox',{id,kind:'notice',status:'open',flowId:flow.id,version:1,role:noticeRole,title:noticeTitle??`${flow.taskSnapshot?.title??flow.taskId}: ${label}${cleanupNote?' (cleanup outstanding)':''}`,context:(reason||`The ${flow.kind??'workflow'} finished with outcome ${outcome}. Read its retained evidence and retrospective.`)+recoveredNote+limitedNote+carriedNote+cleanupNote,...(cleanupNote?{cleanupOutstanding:true}:{}),outcome,terminalReason:reason,taskId:flow.taskId,taskRevision:flow.taskRevision,retrospectiveId:flow.id,createdAt:now()});
}
// A flow's attempts whose step ran and reported a failure (core/attempt-outcome.mjs), by step:
// "fast-check reported a failure 2 times (verify-step)". Older attempts are read from their receipts.
export function recoveredFailures(store, flow, kind = 'failed') {
  const steps = new Map();
  for (const attempt of store.by('attempt', 'flowId', flow.id)) {
    const outcome = attempt.outcome ? attempt : attemptOutcome(attempt.status, attempt.receipt?.actionResult);
    if (outcome?.outcome !== kind) continue;
    const row = steps.get(attempt.step) ?? { count: 0, checks: new Set() }; row.count++;
    for (const check of outcome.failedChecks ?? []) row.checks.add(check.id);
    steps.set(attempt.step, row);
  }
  const times = n => n === 1 ? 'once' : `${n} times`;
  return [...steps].map(([step, row]) => kind === 'turn-limit' ? `${step} stopped at its provider turn limit ${times(row.count)}` : `${step} reported a failure ${times(row.count)}${row.checks.size ? ` (${[...row.checks].join(', ')})` : ''}`);
}
// An abandoned flow's open questions and notices are resolved: nothing is left to answer or act on.
function closeAbandonedInbox(store, flow, reason) {
  supersedeOpenQuestions(store, flow, reason);
  for (const item of store.by('inbox', 'flowId', flow.id).filter(q => q.kind === 'notice' && q.status === 'open')) { item.status = 'superseded'; item.supersededReason = reason; item.supersededBy = store.commandActor ?? null; item.version++; store.put('inbox', item); store.event('inbox.superseded', { inboxId: item.id, flowId: flow.id, reason }); }
}
// A finished flow's questions can no longer be answered; resolve them so they stop waking anyone.
export function supersedeOpenQuestions(store, flow, reason) {
  for (const item of store.by('inbox', 'flowId', flow.id).filter(q => q.kind === 'question' && q.status === 'open')) {
    item.status = 'superseded'; item.supersededBy = store.commandActor ?? null; item.supersededReason = reason; item.version++; store.put('inbox', item);
    const wait = store.get('wait', `question:${item.id}`); if (wait && !wait.endedAt) store.put('wait', { ...wait, endedAt: now(), reason });
    store.event('inbox.superseded', { inboxId: item.id, flowId: flow.id, reason });
  }
}
// A task flow parked on an open question holds no worktree or running attempt, so it may
// stay open across an upgrade; recommissioning rebinds it to the new code and config.
// A task flow at a question step, with no attempt, holds nothing an upgrade could break:
// either its question is open, or (just after a rebind) the engine has yet to reopen it.
export function carriesOverUpgrade(store, flow) {
  return flow.kind === 'task' && ['waiting', 'ready'].includes(flow.state) && !flow.attemptId && flow.workflow?.nodes?.[flow.step]?.kind === 'question';
}
// A finished flow always has finishedAt. Flows abandoned before that rule have only
// abandonedAt; repair them from it, or from their last recorded event.
export function backfillFinishedAt(store) {
  for (const flow of store.live('flow').filter(f => ['completed', 'failed'].includes(f.state) && !f.finishedAt)) {
    const last = store.db.prepare("SELECT max(at) AS at FROM events WHERE json_extract(payload,'$.flowId')=?").get(flow.id)?.at;
    store.put('flow', { ...flow, finishedAt: flow.abandonedAt ?? last ?? flow.createdAt, finishedAtRepaired: true }); store.event('flow.finish-repaired', { flowId: flow.id });
  }
}
// Planning ahead was removed. Plan records it left behind are retired; a retained planning
// worktree becomes an operator obligation, the same disposition it always required.
export function retireLeftoverPlans(store) {
  for (const row of store.all('plan').filter(r => r.status === 'ready')) {
    const updated = { ...row, status: 'retired', retiredAt: now(), retirementReason: 'Planning ahead was removed from Factotum' };
    if (row.workspace?.path && existsSync(row.workspace.path)) {
      const obligationId = digest({ kind: 'retained-planning-cache', planId: row.id, flowId: row.flowId, workspace: row.workspace.ownershipDigest ?? row.workspace.path });
      updated.cleanupObligationId = obligationId;
      if (!store.get('obligation', obligationId)) store.put('obligation', { id: obligationId, kind: 'planning-cache-cleanup', planId: row.id, flowId: row.flowId, workspace: row.workspace, title: 'Inspect the retained planning workspace and authorize its cleanup', status: 'pending', owner: 'operator', requiresAuthorization: true, evidence: updated.retirementReason, createdAt: now() });
    }
    store.put('plan', updated); store.event('plan.retired', { planId: row.id, flowId: row.flowId, status: 'retired', reason: updated.retirementReason });
  }
}
export const blocksDrain = (store, flow) => !['completed', 'failed'].includes(flow.state) && !carriesOverUpgrade(store, flow);
// Rebind a carried-over task flow after a configuration change. If the step it waits on
// changed meaning, stop it with a reason rather than continue under a different definition.
function rebindTaskFlow(store, flow, config, catalog) {
  const row = catalog?.workflows?.[flow.workflowName];
  if (!row || !row.workflow.nodes[flow.step] || digest(row.workflow.nodes[flow.step]) !== digest(flow.workflow.nodes[flow.step])) { stopFlow(store, flow, 'The upgrade changed this task workflow; start the task again'); return; }
  const open = store.by('inbox', 'flowId', flow.id).filter(q => q.kind === 'question' && q.status === 'open');
  Object.assign(flow, { workflow: row.workflow, workflowDigest: row.digest, target: row.target ?? config.repository?.target ?? null, configDigest: digest(config), executorDigest: executorDigest() });
  // The step is unchanged; if the question's subject is too, it stays open as it is: no new question, no new wake.
  if (flow.state === 'waiting' && open.length === 1 && open[0].subjectDigest === subject(store, flow)) {
    store.put('flow', flow); store.event('flow.rebound', { flowId: flow.id, workflowDigest: row.digest, keptInboxId: open[0].id }); return;
  }
  supersedeOpenQuestions(store, flow, 'reopened after an upgrade');
  // A reopened question records who caused it, so the orchestrator is not woken by its own recommission.
  Object.assign(flow, { state: 'ready', reopenCausedBy: store.commandActor ?? null });
  store.put('flow', flow); store.event('flow.rebound', { flowId: flow.id, workflowDigest: row.digest });
}
export const ADOPTED_MERGE_OPERATOR_ONLY = 'an adopted pull request\'s merge question is answered by the operator only; a recorded instruction or delegated operation does not apply. The question stays open for the operator';
export function stopFlow(store, flow, reason, abort = false, {noticeOutcome='stopped'} = {}) {
  if (['completed', 'failed'].includes(flow.state)) return flow;
  const repeat = flow.state === 'stopped' && flow.stopReason === reason;
  if (!repeat) flow.stopSequence = (flow.stopSequence ?? 0) + 1;
  // An upkeep follow-up records when it stopped: the time it then holds a slot without working is
  // recorded when the factory ends it (knowledge-upkeep design 7.6).
  if (!repeat && hasUpkeepMarker(flow.taskSnapshot)) flow.stoppedAt = now();
  flow.stopRequested = true; flow.abortRequested ||= abort; flow.state = 'stopped'; flow.stopReason = reason;
  // A stopped flow holds a slot (operations/capacity.mjs); a resume asks for one again if none is free.
  delete flow.slotWait;
  if(flow.kind==='change'&&flow.taskSnapshot?.source&&lifecycleEnabled(store.meta('config',{}))){
    const source=flow.taskSnapshot.source,jobId=`lifecycle-stop:${flow.id}`;
    if(!store.get('job',jobId))store.put('job',{id:jobId,operation:'forge.lifecycle',payload:{phase:'stopped',source:structuredClone(source),originalFlowId:flow.id,reason,operationId:`${store.meta('project').projectId}:${flow.id}:stopped`},grant:{actor:'operator',source:'configuration',policy:'issueProfile.lifecycle',note:'Publish configured stopped lifecycle for this exact admitted source task',configDigest:store.meta('configDigest')},status:'queued',createdAt:now()});
  }

  let closedTimer=false;for(const wait of store.by('wait','flowId',flow.id).filter(row=>row.kind==='timer'&&!row.endedAt)){store.put('wait',{...wait,endedAt:now(),reason:'flow stopped'});closedTimer=true;}if(closedTimer)flow.timerWaitGeneration=(flow.timerWaitGeneration??0)+1;
  for (const item of store.by('inbox', 'flowId', flow.id).filter(q => q.kind === 'question' && q.status === 'open')) {
    item.status = 'superseded'; item.supersededBy = store.commandActor ?? null; item.version++; store.put('inbox', item);
    const wait=store.get('wait',`question:${item.id}`);if(wait&&!wait.endedAt)store.put('wait',{...wait,endedAt:now(),reason:'stopped'});
  }
  store.put('flow', flow); if (!repeat) store.event('flow.stopped', { flowId: flow.id, reason, abort, stopSequence: flow.stopSequence, by: store.commandCause ?? 'factory' });
  flowNotice(store,flow,noticeOutcome,reason);
  let recorded=false;
  try{const report=retrospective(store,{flowId:flow.id});store.put('retrospective',{id:flow.id,...report,contentDigest:digest(report),recordedAt:now()});recorded=true;}catch{store.event('retrospective.failed',{flowId:flow.id,reason:'Stopped retrospective could not be assembled'});}
  // Knowledge upkeep: a merged flow that stops at a post-merge step still gets its one run. One read
  // by key when the flow has no receipt; it never fails the stop.
  if(recorded)try{upkeepAfterRetrospectiveInTransaction(store,flow.id);}catch(error){store.event('upkeep.queue-failed',{flowId:flow.id,reason:error.message});}
  return flow;
}
// Every node reachable from a step through its edges and answers.
export function reachableSteps(workflow, from) {
  const seen = new Set(), queue = [from];
  while (queue.length) {
    const step = queue.shift(), node = workflow.nodes[step];
    if (!node || seen.has(step)) continue; seen.add(step);
    queue.push(...[node.next, node.onFailure, ...Object.values(node.resultEdges ?? {}), ...Object.values(node.answers ?? {})].filter(Boolean));
  }
  return seen;
}
// Operator guidance reaches every model step of the flow through its operator feedback.
function addFlowNote(flow, row) { flow.operatorFeedback ??= []; flow.operatorFeedback.push({ ...row, at: now() }); }
export function move(store, flow, next) {
  assert(next && Object.hasOwn(flow.workflow.nodes, next), 'missing transition');
  const transitions = flow.transitions + 1, visits = (flow.visits[next] ?? 0) + 1;
  assert(transitions <= (flow.workflow.maxTransitions ?? 100) + (flow.transitionAllowance??0), `workflow transition bound exhausted before ${next}; inspect the flow before authorizing another cycle`);
  const limit = flow.workflow.nodes[next].maxVisits;
  assert(!limit || visits <= limit + (flow.limitExtensions?.[next]??0), `workflow visit bound exhausted at ${next} (${flow.visits[next] ?? 0}/${limit + (flow.limitExtensions?.[next]??0)} cumulative visits used; cycle allowance ${limit}); inspect findings before recovery (flow.replan where supported) or abandon`);
  flow.transitions = transitions; flow.visits[next] = visits;
  flow.step = next; flow.state = 'ready';
  // When the flow reached a question: the order in which parked flows use the parked allowance.
  if (flow.workflow.nodes[next].kind === 'question') flow.parkedAt = now(); else delete flow.parkedAt;
  delete flow.slotWait;
  store.put('flow', flow); store.event('flow.moved', { flowId: flow.id, step: next });
}

export function executeCommand(store, envelope) {
  assert(envelope?.protocolVersion === PROTOCOL_VERSION, 'unsupported protocol');
  assert(envelope.projectId === store.meta('project').projectId, 'wrong project identity');
  id(envelope.commandId, 'command id');
  assert(['operator', 'orchestrator'].includes(envelope.actor), 'invalid actor');
  assert(typeof envelope.operation === 'string' && envelope.payload && typeof envelope.payload === 'object', 'invalid command');
  validateOnBehalfOf(envelope.onBehalfOf, envelope.actor);
  // A grant reference is part of what the command asked for: it is in the digest and the
  // receipt, so the same command id with a different reference is refused.
  validateAuthorityReference(envelope.authority, { operation: envelope.operation, ledger: authorityLedgerEnabled(store) });
  const inputDigest = digest({ operation: envelope.operation, payload: envelope.payload, actor: envelope.actor, ...(envelope.onBehalfOf ? { onBehalfOf: envelope.onBehalfOf } : {}), ...(envelope.authority ? { authority: envelope.authority } : {}) });
  return store.tx(() => {
    const existing = store.command(envelope.commandId);
    if (existing) { assert(store.commandDigest(envelope.commandId) === inputDigest, 'command id reused with different content'); return existing; }
    const receipt = { projectId: envelope.projectId, commandId: envelope.commandId, operation: envelope.operation, actor: envelope.actor, ...(envelope.onBehalfOf ? { onBehalfOf: envelope.onBehalfOf } : {}), ...(envelope.authority ? { authority: envelope.authority } : {}), acceptedAt: now(), status: 'accepted' };
    store.putCommand(receipt, inputDigest);
    store.db.exec('SAVEPOINT application');
    // Notifications use the commanding actor to skip wakes for the consumer's own actions.
    store.commandActor = envelope.actor; store.commandId = envelope.commandId; store.commandCause = envelope.commandId.startsWith('source-sync-') ? 'source' : envelope.actor;
    // The command's shared authority context: nested operations (task.restart's approval)
    // consume the one cited grant entry at most once, and an unused reference is refused.
    store.commandAuthority = envelope.authority ? { ref: envelope.authority, used: false } : null;
    try {
      receipt.result = applyOperationInTransaction(store, envelope);
      // Whatever this command resolved, a prompt channel still showing that question is now obsolete.
      settlePresentations(store);
      assert(!store.commandAuthority || store.commandAuthority.used, `${envelope.operation} did not use the cited grant entry ${envelope.authority?.grantId}/${envelope.authority?.entryId}; send a grant reference only with the protected operation it authorizes`);
      receipt.status = 'completed';
      store.db.exec('RELEASE application');
    } catch (error) {
      store.db.exec('ROLLBACK TO application; RELEASE application');
      store.markRolledBack?.();
      receipt.status = 'rejected'; receipt.error = error.message;
    } finally { store.commandActor = null; store.commandId = null; store.commandCause = null; store.commandAuthority = null; }
    receipt.completedAt = now();
    store.putCommand(receipt, inputDigest);
    store.event(`command.${receipt.status}`, { commandId: receipt.commandId, operation: receipt.operation, actor: receipt.actor, ...(receipt.onBehalfOf ? { onBehalfOf: receipt.onBehalfOf } : {}), ...(receipt.authority ? { authority: receipt.authority } : {}), error: receipt.error });
    return receipt;
  });
}
export function admitFlow(store, task, p = {}) {
  assert(!store.meta('paused') && !store.meta('recoveryHold') && !store.meta('retentionHold'), 'admission paused or retention held');
  assert(task.approvedRevision === task.revision, 'current task approval required');
  // A task whose upkeep marker names a kind this release does not enforce is never admitted.
  assertUpkeepEnforced(task, 'admission');
  const lapsed = approvalAuthorityReasons(store, task); assert(!lapsed.length, lapsed.join('; '));
  // A check task needs the operator's own approval of this revision and its declared scripts.
  assertCheckScriptsApproved(task, 'admission');
  // A task that may change governing files needs the operator's own approval of this revision.
  if (hasGoverningEdits(task)) {
    assertGoverningEditsApproved(task, 'admission'); assertGoverningEditsAllowed(task, store.meta('config', {}).context, projectOwned(store), 'admission');
    // Its approved governing context is read from the owned workspace's recorded base, which only a
    // delivery flow that prepares its own workspace has (operations/governance-edit.mjs).
    assert(store.meta('config', {}).mode === 'delivery' && !p.candidate && p.alreadySatisfied !== true, `admission: task ${task.id} may change governing files (governingEdits); it runs only as a delivery flow in its own workspace, never in rehearsal, as an adopted pull request or as an already-satisfied outcome`);
  }
  // A durable decision that holds the build boundary keeps new work from starting (migrated projects only).
  assertNoDecisionHold(store, task.id, task.revision, 'build', 'admission');
  const config = store.meta('config', {});
  if (p.revision !== undefined || config.mode === 'delivery') assert(p.revision === task.revision, 'current task revision required for admission');
  if (config.mode === 'delivery') {
    assert(store.meta('commissioning')?.configDigest === store.meta('configDigest') && store.meta('commissioning')?.ready, 'project doctor qualification required');
    // The usage-limit hold check uses the routes this run would pin, run overrides included.
    const reasons = admissionReasons(store, task, { modelOverrides: p.modelOverrides }); assert(!reasons.length, reasons.join('; '));
  } else assert(!store.live('flow').some(f => !['completed', 'failed'].includes(f.state)), 'one active or stopped flow already owns capacity');
  assert(!store.by('flow', 'taskId', task.id).some(f => !['completed', 'failed'].includes(f.state)), 'task already owned by active or stopped flow');
  if (config.mode === 'delivery' && store.meta('catalog')) { const drift = catalogDrift(store.meta('catalog'), store.meta('project').root); assert(!drift.length, drift.join('; ')); }
  const { name: workflowName, workflow, digest: selectedWorkflowDigest, kind: workflowKind, target: workflowTarget } = config.mode === 'delivery' ? admittedWorkflow(store, task) : { name: null, workflow: store.meta('workflow') }; validateWorkflow(workflow);
  assert(!(p.candidate && p.alreadySatisfied), 'choose one completion path');
  // 7.3, 7.4: an upkeep task is delivered by a change or document workflow, never one of kind task.
  assert(!hasUpkeepMarker(task) || workflowKind !== 'task', `admission: task ${task.id} is an upkeep task and would run through workflow ${workflowName}, of kind task; an upkeep task is delivered by a change or document workflow`);
  // An upkeep task is delivered only as the factory's own change, checked on its candidate
  // (knowledge-upkeep design, 7.2): never by adopting a pull request, never as already satisfied.
  assert(!hasUpkeepMarker(task) || !(p.candidate || p.alreadySatisfied), `admission: task ${task.id} is an upkeep task; it cannot be started as an adopted pull request or as an already-satisfied outcome`);
  if (p.candidate) assert(config.mode === 'delivery' && Number.isSafeInteger(p.candidate.number) && p.candidate.number > 0 && /^[a-f0-9]{40,64}$/i.test(p.candidate.head) && /^[a-f0-9]{40,64}$/i.test(p.candidate.base), 'exact approved PR number/head/base required');
  const flow = { ...(workflowName ? { workflowName } : {}), strictDecisionRole:config.policy?.strictDecisionRole??'operator', mergeDecisionRole:config.policy?.mergeDecisionRole??'operator', reviewProtocol:config.policy?.reviewProtocol??'fresh-full', effectiveRisk: effectiveRisk(task, {}), riskAssessments: [], candidate: p.candidate ?? null, completionMode: p.alreadySatisfied === true ? 'already-satisfied' : 'merge', id: p.flowId ? id(p.flowId, 'flow id') : uid(), taskId: task.id, taskSnapshot: structuredClone(task), taskRevision: task.revision, approvalVersion: task.approvalVersion, workflow, workflowDigest: selectedWorkflowDigest ?? digest(workflow), configDigest: store.meta('configDigest'), mode: config.mode ?? 'rehearsal', kind: config.mode === 'delivery' ? (workflowKind === 'task' ? 'task' : 'change') : 'rehearsal', ...(config.mode === 'delivery' && workflowKind === 'document' ? { pool: 'document' } : {}), ...(config.mode === 'delivery' ? { target: workflowTarget ?? config.repository?.target ?? null } : {}), executorDigest: executorDigest(), step: workflow.start, state: 'ready', stopRequested: false, abortRequested: false, transitions: 0, visits: { [workflow.start]: 1 }, evidence: {}, results: {}, sessions: {}, attemptId: null, createdAt: now() };
  assert(!store.get('flow', flow.id), 'flow id already exists');
  // The task's model choice is read now and pinned with the flow; later changes to it
  // affect only the next flow, never this one's retries, replans or resumed sessions.
  if (config.mode === 'delivery') pinFlowModels(store, flow, p.modelOverrides, task.models);
  // The pinned routes are checked again (the same routes admission checked above).
  if (config.mode === 'delivery') { const held = routeHoldReasons(store, flow.modelRoutes); assert(!held.length, held.join('; ')); }
  else assert(p.modelOverrides === undefined, 'modelOverrides require a delivery workflow');
  // A context task (knowledge-upkeep slice 6) runs no model step on a provider whose instruction
  // suppression the operator has not recorded as checked on this host (upkeep.context.qualifiedProviders).
  if (task.upkeep?.kind === 'context') { const unqualified = unqualifiedProviders(config, flow.modelRoutes); assert(!unqualified.length, `admission: ${contextProviderRefusal(task.id, unqualified)}`); }
  store.put('flow', flow);
  const queue = store.get('queue', task.id); if (queue) store.put('queue', {...recordQueueAdmission(store, queue, flow), status:'claimed', flowId:flow.id, claimedAt:now()});
  // Link the abandoned flows this one replaces (a restart, a re-approval or a manual abandon),
  // so whoever opens the old flow finds the work that continued.
  const replaced = store.by('flow', 'taskId', task.id).filter(f => f.id !== flow.id && f.abandonedAt && !f.replacedBy);
  for (const old of replaced) store.put('flow', { ...old, replacedBy: flow.id });
  if (replaced.length) { flow.replaces = replaced.map(f => f.id); store.put('flow', flow); }
  store.event('flow.admitted', { flowId: flow.id, taskId: task.id, ...(replaced.length ? { replaces: flow.replaces } : {}) }); return flow;
}
// Return a flow to its plan step. A replan starts the plan → build → review cycle again: every
// step reachable from the plan step gets its full visit budget back (history is kept), and so
// do transitions. Used by flow.replan and when the target moved under the planned paths.
export function replanFlow(store, flow, { note, by = 'factory', onBehalfOf, reason } = {}) {
  const planStep = bindingNode(flow.workflow, 'plan'); assert(planStep, 'workflow has no planning step to return to');
  if (note) addFlowNote(flow, { step: flow.step, answer: 'replan', note, actor: by, ...(onBehalfOf ? { onBehalfOf } : {}) });
  // A new plan must not present an earlier cycle's checks as current repair work.
  // Their immutable attempt results remain in History, including custom gate steps.
  const gateSlots = new Set(['gate', 'fast-check', ...Object.entries(flow.workflow.nodes).filter(([, node]) => ['gate', 'fastCheck'].includes(node.action?.operation)).map(([step]) => step)]);
  // The review verdict this replan answers was given against the current plan: if the new plan differs,
  // an unchanged candidate goes to review again instead of being held (core/engine.mjs; dev.88 M3).
  // A second replan before that review keeps the plan the review actually saw.
  if (flow.results?.review) { const reviewDigest = digest(flow.results.review); if (flow.reviewReplanned?.reviewDigest !== reviewDigest) flow.reviewReplanned = { reviewDigest, planDigest: planContentDigest(flow.results.plan) }; }
  const supersededGateResults = [...gateSlots].filter(step => flow.results?.[step] != null);
  for (const step of supersededGateResults) delete flow.results[step];
  flow.stopRequested = false; flow.abortRequested = false; flow.evidence = {}; flow.mergeAuthorization = null; flow.sessions = {}; flow.results.plan = null; flow.results['plan-review'] = null; flow.results[planStep] = null;
  delete flow.resumeStep; delete flow.stopReason;
  const fresh = {}; flow.limitExtensions ??= {};
  for (const step of reachableSteps(flow.workflow, planStep)) if (flow.workflow.nodes[step].maxVisits) { flow.limitExtensions[step] = flow.visits[step] ?? 0; fresh[step] = flow.visits[step] ?? 0; }
  flow.transitionAllowance = flow.transitions; flow.planClarifications = 0;
  // The new plan cycle starts without the earlier cycle's assumptions; they stay on the flow as history (dev.83).
  archiveCarriedQuestions(flow);
  // A replan starts a new plan cycle, which selects its learnings again at its first model step
  // (knowledge-upkeep design 11.2; workflows/actions.mjs). The ended cycle's pin is kept, without text.
  if (flow.learningSelection) { flow.learningHistory = [...(flow.learningHistory ?? []), { cycle: flow.learningSelection.cycle, step: flow.learningSelection.step, commit: flow.learningSelection.commit, at: flow.learningSelection.at, learnings: (flow.learningSelection.entries ?? []).map(entry => ({ id: entry.id, blob: entry.blob })) }].slice(-10); delete flow.learningSelection; }
  // A question the flow was waiting on (for example a plan question whose clarifications ran out) is settled by the replan.
  supersedeOpenQuestions(store, flow, 'flow replanned');
  move(store, flow, planStep); store.event('flow.replan', { flowId: flow.id, note, freshBudget: fresh, by, supersededGateResults, ...(onBehalfOf ? { onBehalfOf } : {}), ...(reason ? { reason } : {}) }); return flow;
}
export function applyOperationInTransaction(store, { operation, payload: p, actor, onBehalfOf, authority }) {
  const operator = () => operatorAuthority(store, { operation, actor, onBehalfOf });
  const retentionHold=store.meta('retentionHold');
  if(retentionHold)assert(['stop','stop.all','pause','inbox.read','inbox.ack'].includes(operation)||(operation==='job.enqueue'&&p.operation==='retention.archive'&&p.payload?.operationId===retentionHold.operationId)||(operation==='attempt.resolve'&&store.get('attempt',p.attemptId)?.flowId===retentionHold.flowId)||(operation==='flow.abandon'&&p.flowId===retentionHold.flowId),'retention owns the mutation fence; inspect or enqueue the same retention operation for reconciliation');
  switch (operation) {
    case 'operator.presence':return setOperatorPresence(store,p,actor,{delegated:actor!=='operator'&&operatorAuthority(store,{operation,actor,onBehalfOf})==='delegated'});
    case 'inbox.publish':
      // Publication v2: a decision-bound card is presented from its decision, at the exact version named.
      if(authorityLedgerEnabled(store)&&p.purpose==='decision'){
        const extra=Object.keys(p).filter(k=>!['purpose','decision','id','title','context','expiryMs','remind','links','discuss'].includes(k));assert(!extra.length,`a decision card takes its question and choices from the decision; remove ${extra.join(', ')}`);
        const binding=p.decision??{};assert(binding&&typeof binding==='object'&&Object.keys(binding).every(k=>['decisionId','expectedDecisionVersion','taskId','taskRevision','scopeDigest'].includes(k)),'decision is {decisionId, expectedDecisionVersion, taskId, taskRevision, scopeDigest}');
        const {purpose,decision,...presentation}=p;return presentDecision(store,{...presentation,...binding},{actor});
      }
      return publishStandaloneInbox(store,p,actor);
    case 'decision.open':return openDecision(store,p,{actor,onBehalfOf});
    case 'decision.present':return presentDecision(store,p,{actor,onBehalfOf});
    case 'decision.dispose':return disposeDecision(store,p,{actor,onBehalfOf});
    case 'decision.relay':return relayDecision(store,p,{actor,onBehalfOf});
    case 'grant.issue':return issueGrant(store,p,{actor,onBehalfOf,authority});
    case 'grant.revoke':return revokeGrant(store,p,{actor,onBehalfOf,authority},grantHooks(store));
    case 'decision.revoke':return revokeDecision(store,p,{actor,onBehalfOf});
    case 'decision.ratify':return ratifyDecision(store,p,{actor,onBehalfOf});
    case 'inbox.withdraw':return withdrawStandaloneInbox(store,p,actor);
    case 'inbox.present':return presentInbox(store,p,actor);
    case 'inbox.unpresent':return withdrawPresentation(store,p,actor);
    case 'orchestrator.session':return bindOrchestratorSession(store,p,actor);
    case 'task.put': {
      operator(); id(p.task?.id, 'task id');
      assert(typeof p.task.title === 'string' && p.task.title.trim(), 'task title required');
      // Tracked items mirror source issues that are not workable tasks; they have no acceptance criteria.
      assert(p.task.tracked === undefined || p.task.tracked === true, 'tracked must be true when set');
      assert(Array.isArray(p.task.acceptance) && (p.task.tracked === true || p.task.acceptance.length > 0) && p.task.acceptance.every(x => typeof x === 'string' && x.trim()), 'task acceptance required');
      const old = store.get('task', p.task.id);
      // The upkeep: namespace and the upkeep marker are the factory's (core/upkeep-namespace.mjs).
      // Nothing is created in the namespace here, whatever its letter case; no task gains the
      // marker here; and a task that carries one is not edited here, which would strip it. A task
      // that was in the namespace before the reservation has no marker and stays an ordinary task.
      assert(!Object.hasOwn(p.task, 'upkeep'), 'the upkeep field is written by the factory only; remove it from the task');
      assert(old || !inUpkeepNamespace(p.task.id), `task id ${p.task.id} is in the reserved upkeep: namespace (compared without regard to case), which only the factory writes; choose another id`);
      assert(!hasUpkeepMarker(old), `task ${p.task.id} carries an upkeep marker; its brief cannot be edited (decline it and write an ordinary task instead)`);
      // With upkeep on, a task that was already in the namespace can no longer be changed here (it
      // can still be labelled, scheduled, revoked and restarted). With upkeep off it stays editable,
      // so that it can be closed before upkeep is turned on.
      assert(!(old && inUpkeepNamespace(p.task.id) && upkeepOn(store.meta('config', {}))), `task ${p.task.id} is in the reserved upkeep: namespace and knowledge upkeep is on, so it cannot be changed here; turn upkeep.mode off to edit or close it`);
      if (Object.hasOwn(p, 'expectedRevision')) assert((old?.revision ?? null) === p.expectedRevision, 'task revision changed; refresh and review the current brief before saving');
      const extra = Object.fromEntries(BRIEF_FIELDS.filter(k => p.task[k] !== undefined).map(k => [k, p.task[k]]));
      for (const key of ['dependencies','paths','postMerge']) if (extra[key] !== undefined) assert(Array.isArray(extra[key]) && extra[key].every(x => typeof x === 'string'), `invalid ${key}`);
      if(extra.category!==undefined)assert(typeof extra.category==='string'&&extra.category.trim(),'invalid task category');
      if(extra.outcome!==undefined)assert(typeof extra.outcome==='string'&&extra.outcome.trim()&&extra.outcome.length<=4000,'invalid task outcome: a non-empty string of at most 4000 characters');
      validateInputs(extra.inputs);
      validateOriginalRequest(extra.originalRequest);
      if(extra.workflow!==undefined)assert(typeof extra.workflow==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(extra.workflow),'invalid task workflow');
      if(extra.parent!==undefined)assert(Number.isSafeInteger(extra.parent)&&extra.parent>0,'invalid task parent');
      if(extra.followup!==undefined)assert(extra.followup&&typeof extra.followup==='object'&&(extra.followup.parent==null||Number.isSafeInteger(extra.followup.parent)&&extra.followup.parent>0)&&Array.isArray(extra.followup.labels)&&extra.followup.labels.every(x=>typeof x==='string'&&x.trim()),'invalid followup metadata');
      if (extra.risk !== undefined) assert(['ordinary','strict'].includes(extra.risk), 'invalid task risk');
      const brief = { id: p.task.id, title: p.task.title, acceptance: p.task.acceptance, ...extra };
      // Naming governing files a task may change is the operator's own act, never delegated: the
      // orchestrator can still put the task without the field (which removes the permission).
      if (hasGoverningEdits(brief)) {
        assert(actor === 'operator' && !onBehalfOf, `governingEdits (governing files task ${brief.id} may change) is set by the operator directly, never on an instruction; put the task without it`);
        assertGoverningEditsAllowed(brief, store.meta('config', {}).context, projectOwned(store), 'task.put');
      }
      // A dependency's progress (its state or labels) is what this task waits for, not a change to
      // this task: when only that moved, the revision and its approval stay. An edit to a
      // dependency's content still needs this task approved again.
      let revision = digest(brief);
      if (old && old.revision !== revision && onlyDependencyProgress(briefOf(old), brief)) revision = old.revision;
      if (old && old.revision !== revision) for (const flow of store.by('flow', 'taskId', old.id)) stopFlow(store, flow, 'task brief changed', true);
      // Labels group tasks; they are not part of the approved brief, so changing them keeps approval.
      const labels = p.task.labels !== undefined ? normalizeLabels(p.task.labels) : old?.labels;
      // The not-before time is scheduling, not part of the brief: changing it keeps approval.
      // A source re-import only sets it when the source item itself changed, so a time set here survives routine syncs.
      const sourceUnchanged = p.task.source && old?.source?.revision === p.task.source.revision;
      const notBefore = p.task.source && !sourceUnchanged ? validNotBefore(p.task.notBefore ?? null) : p.task.notBefore !== undefined && !p.task.source ? validNotBefore(p.task.notBefore) : old?.notBefore ?? null;
      // The model choice is not part of the brief either: it survives brief edits and needs no approval.
      if (p.task.models != null) validateTaskModels(store, brief, p.task.models, approvalBinding(store, brief)?.name ?? 'standard');
      const models = p.task.models !== undefined ? p.task.models : old?.models;
      // The findings a task is linked to (finding.accept) are not part of the brief either: they stay with the task.
      const task = { ...(old?.revision === revision ? old : {}), ...brief, ...(labels?.length ? { labels } : {}), ...(notBefore ? { notBefore } : {}), ...(old?.findings?.length ? { findings: old.findings } : {}), revision, approvedRevision: old?.revision === revision ? old.approvedRevision : null, approvalVersion: (old?.approvalVersion ?? 0) + (old?.revision === revision ? 0 : 1) };
      if (!labels?.length) delete task.labels;
      if (!notBefore) delete task.notBefore;
      if (models) task.models = structuredClone(models); else delete task.models;
      store.put('task', task);
      // Migrated databases keep an immutable snapshot of each new revision (no-op on schema 1).
      noteTaskRevision(store, task, { previousRevision: old?.revision ?? null, brief, recordedBy: 'task.put' });
      // Migrated databases: decisions that applied to the previous revision follow it, never cleared by the edit.
      carryDecisionsForward(store, task, old?.revision ?? null);
      if(old?.approvedRevision&&old.revision!==revision)store.event('task.approval-revoked',{taskId:task.id,previousRevision:old.revision,revision,reason:'Task brief or source evidence changed'});
      if(old?.approvedRevision&&old.revision!==revision)dequeueUnapproved(store,task.id,'Task brief or source evidence changed');
      store.event('task.updated', { taskId: task.id, revision }); return task;
    }
    case 'task.approve': {
      // Migrated projects: approving a brief is semantic authority. The operator approves
      // directly; the orchestrator only by consuming an exact grant entry (approvalAuthority).
      const ledger = authorityLedgerEnabled(store);
      if (!ledger) operator();
      const task = store.need('task', p.taskId);
      assert(!task.tracked, 'tracked items cannot be approved; make it a task first (Make it a task in the console, or job.enqueue source.promote {taskId, acceptance})');
      assert(task.revision === p.revision, 'stale task revision');
      // A brief that names governing files the task may change is approved by the operator
      // directly, never by delegation or a grant, under the current configuration.
      if (hasGoverningEdits(task)) {
        assert(actor === 'operator' && !onBehalfOf, `task ${task.id} names governing files it may change (governingEdits); only the operator approves it, directly`);
        assertGoverningEditsAllowed(task, store.meta('config', {}).context, projectOwned(store), 'task.approve');
      }
      // A check task (knowledge upkeep) changes fast-check scripts the factory runs on every later
      // candidate: the operator approves it directly, never by delegation, an instruction or a grant,
      // on either schema (operator decision after the review of 6f83d54).
      if (isCheckTask(task)) assert(actor === 'operator' && !onBehalfOf && !store.commandAuthority, `task ${task.id} changes fast-check scripts the factory runs on every candidate; only the operator approves it, directly, never by delegation, an instruction or a grant`);
      const binding = approvalBinding(store, task);
      if (ledger) { const { provenance } = approvalAuthority(store, task, binding, { actor, onBehalfOf }); task.approvalAuthority = provenance; }
      task.approvedRevision = task.revision; task.approvalVersion++; task.approvedAt = now(); task.approvedWorkflow = binding;
      // Bound to this approval: any later approval change moves approvalVersion, and it lapses.
      if (hasGoverningEdits(task)) task.governingEditsApproval = { revision: task.revision, approvalVersion: task.approvalVersion, approvedAt: task.approvedAt }; else delete task.governingEditsApproval;
      if (isCheckTask(task)) task.checkScriptsApproval = { revision: task.revision, approvalVersion: task.approvalVersion, approvedAt: task.approvedAt, files: checkApprovalFiles(task) }; else delete task.checkScriptsApproval;
      // A flow stopped because its brief changed can never resume: its revision is no longer the
      // approved one. Approving the new revision retires it (abandoned, its queue claim released),
      // so the task can be queued and started again. A flow with an unsettled attempt needs task.restart.
      const retired = [];
      for (const flow of store.by('flow', 'taskId', task.id).filter(f => f.state === 'stopped' && f.taskRevision !== task.revision && !f.attemptId && !f.results?.merge?.merged)) {
        flow.state = 'failed'; flow.stopRequested = true; flow.abandonedAt = now(); flow.finishedAt = flow.abandonedAt; flow.retiredBy = 'approval of a new revision'; store.put('flow', flow);
        settleFlowJob(store, flow, 'abandoned', 'a new revision was approved'); closeAbandonedInbox(store, flow, 'a new revision was approved');
        const claim = store.get('queue', task.id); if (claim?.status === 'claimed' && claim.flowId === flow.id) store.put('queue', { ...claim, status: 'finished', flowState: 'abandoned' });
        store.event('flow.abandoned', { flowId: flow.id, note: 'retired: a new revision of its task was approved', by: actor, workspaceRetained: !!flow.workspace }); retired.push(flow.id);
      }
      // payload.queue appends it to the queue in the same step ("Approve and queue").
      if (p.queue === true || store.meta('config', {}).policy?.queueOnApproval === true) queueApprovedTask(store, task);
      store.put('task', task);
      // The approval's use (and any grant consumption) commits only if the task's authority
      // records still pass the scoped audit; this covers task.restart's nested approval too.
      if (ledger) assertTaskRecordsSound(store, task.id, 'task.approve');
      store.event('task.approved', { taskId: task.id, revision: task.revision, by: actor, ...(onBehalfOf ? { onBehalfOf } : {}), ...(retired.length ? { retired } : {}), ...(task.approvalAuthority && ledger ? { authority: task.approvalAuthority.source, authorityUseId: task.approvalAuthority.authorityUseId, ...(task.approvalAuthority.grantId ? { grantId: task.approvalAuthority.grantId, entryId: task.approvalAuthority.entryId } : {}) } : {}) }); return retired.length ? { ...task, retiredFlows: retired } : task;
    }
    case 'task.label': {
      operator(); const task = store.need('task', p.taskId);
      const labels = normalizeLabels(p.labels), updated = { ...task }; if (labels.length) updated.labels = labels; else delete updated.labels;
      store.put('task', updated); store.event('task.labeled', { taskId: task.id, labels }); return updated;
    }
    case 'task.models': {
      // Per-task model choice, by provider role. Not part of the approved brief: changing it
      // keeps approval and applies to the task's next flow. Within the configured providers
      // and allowedModels it needs only normal command authority, like flow.start's modelOverrides.
      assert(Object.keys(p).every(key => ['taskId', 'models', 'note'].includes(key)), 'task.models accepts taskId, models and note');
      if (p.note !== undefined) note(p.note);
      const task = store.need('task', p.taskId), updated = { ...task };
      assert(!task.tracked, 'tracked items have no model choice');
      if (p.models === null) delete updated.models;
      else { validateTaskModels(store, task, p.models, approvalBinding(store, task)?.name ?? 'standard'); updated.models = structuredClone(p.models); }
      store.put('task', updated); store.event('task.models', { taskId: task.id, models: updated.models ?? null, by: actor, ...(onBehalfOf ? { onBehalfOf } : {}), ...(p.note !== undefined ? { note: p.note } : {}) });
      return { ...updated, appliesTo: 'next-flow' };
    }
    case 'task.schedule': {
      operator(); const task = store.need('task', p.taskId), notBefore = validNotBefore(p.notBefore ?? null), updated = { ...task };
      if (notBefore) updated.notBefore = notBefore; else delete updated.notBefore;
      store.put('task', updated); store.event('task.scheduled', { taskId: task.id, notBefore }); return updated;
    }
    case 'task.revoke': {
      operator(); const task = store.need('task', p.taskId); note(p.note);
      task.approvedRevision = null; task.approvalVersion++; delete task.approvalAuthority; store.put('task', task);
      dequeueUnapproved(store, task.id, p.note);
      for (const flow of store.by('flow', 'taskId', task.id)) stopFlow(store, flow, p.note, true);
      store.event('task.revoked', { taskId: task.id, note: p.note }); return task;
    }
    case 'regression.record': {
      operator();note(p.reason);note(p.evidence);const flow=store.need('flow',p.flowId);assert(flow.results?.merge?.merged===true,'known merged flow required');
      const key=p.id?id(p.id,'regression id'):digest({flowId:flow.id,reason:p.reason,evidence:p.evidence});
      const row={id:key,flowId:flow.id,reason:p.reason,evidence:p.evidence,source:'operator-report',status:'reported',mergeCommit:flow.results.merge.mergeCommit??flow.results.merge.sha??null,observedAt:now()};
      const old=store.get('regression',key);if(old){assert(old.flowId===row.flowId&&old.reason===row.reason&&old.evidence===row.evidence,'regression identity reused with different report');return old;}
      store.put('regression',row);store.event('regression.reported',{id:key,flowId:flow.id});
      // Knowledge upkeep (8.3): a regression recorded against a change upkeep delivered suspends everything.
      if(hasUpkeepMarker(flow.taskSnapshot))recordUpkeepRegressionInTransaction(store,{flowId:flow.id,kind:'regression'});
      return row;
    }
    case 'flow.start': {
      // Every field counts: an unknown one (a misspelt note, say) is refused rather than dropped.
      const fields = ['taskId', 'revision', 'flowId', 'candidate', 'alreadySatisfied', 'note', 'modelOverrides'];
      assert(Object.keys(p).every(key => fields.includes(key)), `flow.start accepts ${fields.join(', ')}`);
      const flow = admitFlow(store, store.need('task', p.taskId), p);
      // A start note is operator guidance for this flow's agents, exactly like an answer note.
      if (p.note !== undefined) { addFlowNote(flow, { step: 'start', answer: 'start', note: note(p.note), actor, ...(onBehalfOf ? { onBehalfOf } : {}) }); store.put('flow', flow); store.event('flow.noted', { flowId: flow.id, step: 'start' }); }
      return flow;
    }
    case 'flow.note': {
      // Guidance for a running flow's planner, builder and reviewer, from their next step on.
      operator(); const flow = store.need('flow', p.flowId);
      assert(!['completed', 'failed'].includes(flow.state), 'flow already finished');
      addFlowNote(flow, { step: flow.step, answer: 'note', note: note(p.note), actor, ...(onBehalfOf ? { onBehalfOf } : {}) });
      store.put('flow', flow); store.event('flow.noted', { flowId: flow.id, step: flow.step }); return flow;
    }
    case 'pause': {
      operator(); note(p.note); assert(typeof p.paused === 'boolean', 'paused must be boolean');
      assert(p.paused || !store.meta('recoveryHold'), 'restore reconciliation still required');
      // holdMaintenance: also hold new maintenance jobs (an upgrade waiting for a drain); running ones finish.
      assert(p.holdMaintenance === undefined || typeof p.holdMaintenance === 'boolean', 'holdMaintenance must be boolean');
      store.setMeta('paused', p.paused); store.setMeta('maintenanceHeld', p.paused && p.holdMaintenance === true);
      store.event('admission.paused', { paused: p.paused, note: p.note, ...(p.holdMaintenance ? { holdMaintenance: true } : {}) }); return { paused: p.paused, maintenanceHeld: p.paused && p.holdMaintenance === true };
    }
    case 'stop': {
      note(p.note); return stopFlow(store, store.need('flow', p.flowId), p.note, p.abort === true);
    }
    case 'stop.all': {
      operator(); note(p.note); store.setMeta('paused', true);
      for (const flow of store.all('flow')) stopFlow(store, flow, p.note, p.abort === true);
      return { paused: true };
    }
    case 'resume': {
      operator(); note(p.note); const flow = store.need('flow', p.flowId);
      assert(!store.meta('retentionHold'), 'retention hold requires reconciliation before resume');
      assert(flow.state === 'stopped', 'flow is not stopped');
      if (flow.attemptId) throw new Error(unsettledAttemptMessage(store, flow));
      const task = store.need('task', flow.taskId);
      assert(task.revision === flow.taskRevision && task.approvedRevision === flow.taskRevision, 'new valid authority required');
      // The stop reason belongs to the stop; it stays in the flow.stopped event (dev.88 M8).
      flow.stopRequested = false; flow.abortRequested = false; delete flow.stopReason;
      authorized(store, flow);
      flow.approvalVersion = task.approvalVersion;
      if (flow.resumeStep) { const next = flow.resumeStep; delete flow.resumeStep; move(store, flow, next); }
      else { flow.state = 'ready'; store.put('flow', flow); }
      // A stopped flow held its slot, so it normally continues at once. One that had none (stopped
      // while parked or while waiting for a slot) waits for one if its pool is full.
      takeSlot(store, flow, { after: 'resume', ahead: false });
      store.event('flow.resumed', { flowId: flow.id, note: p.note, by: actor }); return flow;
    }
    case 'inbox.read': case 'inbox.ack': {
      const item = store.need('inbox', p.inboxId);
      assert(operation !== 'inbox.ack' || !item.operatorAckOnly || actor === 'operator', 'only the operator can acknowledge this notice');
      item[operation === 'inbox.read' ? 'readAt' : 'acknowledgedAt'] = now();
      if(operation==='inbox.ack'&&item.kind==='notice'&&item.status==='open'){item.status='acknowledged';item.acknowledgedBy=actor;item.version++;}
      store.put('inbox', item); store.event(operation, { inboxId: item.id }); return item;
    }
    case 'answer': {
      const item = store.need('inbox', p.inboxId);
      // An answer entered for the operator by someone else (always so through a presentation) is
      // stored as relayed. That is provenance only: every authority check below is unchanged.
      const relayed = relayedAnswerInput(item, p, actor);
      // A decision-bound card: an option is a direct operator disposition; "discuss" leaves the decision unresolved.
      if (item.purpose === 'decision') {
        let delegated = false; try { delegated = actor === 'orchestrator' && operatorAuthority(store, { operation, actor, onBehalfOf }) === 'delegated'; } catch { /* not delegated */ }
        const { presentationId, ...card } = p, answered = answerDecisionCard(store, item, card, { actor, onBehalfOf, delegated });
        if (!relayed?.presentationId) return answered;
        // The relay follows the migrated relayedAnswer rules (it may leave the card open); the presentation it came through is settled either way.
        const current = store.need('inbox', item.id); answerPresentation(store, current, relayed, actor, answered.relayedAnswerId ? { relayedAnswerId: answered.relayedAnswerId } : {}); store.put('inbox', current);
        return { ...answered, presentations: current.presentations };
      }
      // An operator question may be answered by the orchestrator on a recorded instruction,
      // except merge, already-satisfied and strict-review decisions, which keep their role policies.
      const node=item.standalone?null:store.get('flow',item.flowId)?.workflow?.nodes?.[store.get('flow',item.flowId)?.step];
      // An adopted pull request's merge question is the operator's alone (its builder is unknown): no
      // recorded instruction, delegated operation, merge or strict decision role widens it.
      assert(actor==='operator'||!(node?.mergeDecision&&store.get('flow',item.flowId)?.candidate),ADOPTED_MERGE_OPERATOR_ONLY);
      // Strict-review sign-off stays with a human; deploy and spending approvals need an explicit policy.
      const delegatedAnswer=actor==='orchestrator'&&item.role==='operator'&&!item.strictReview&&(!node?.integrationDecision||store.meta('config',{}).policy?.delegateIntegrationDecisions===true)&&operatorAuthority(store,{operation,actor,onBehalfOf})==='delegated';
      if(item.standalone){const answered=answerStandaloneInbox(store,item,p,actor,{delegated:delegatedAnswer,relayed});noteHandoffAnswerInTransaction(store,answered);return answered;}
      const flow = store.need('flow', item.flowId);
      assert(actor === 'operator' || actor === item.role || delegatedAnswer, 'question requires designated actor');
      assertCurrentQuestion(item, { version: p.version, subjectDigest: p.subjectDigest });
      assert(Date.parse(item.expiresAt) > Date.now(), 'question expired');
      authorized(store, flow);
      const identity = repositoryIdentity(workingRoot(store, flow));
      assert(subject(store, flow, identity) === item.subjectDigest, QUESTION_SUBJECT_CHANGED);
      assert(Object.hasOwn(item.transitions, p.answer), 'invalid answer');
      const next = item.transitions[p.answer];
      // A plan question (the step a planner's result routed to). "Proceed" sends the plan the
      // operator read on as it is: refused once the plan changed or is no longer proceedable.
      const planQuestion = isPlanQuestion(flow.workflow, flow.step), planStep = planQuestion ? bindingNode(flow.workflow, 'plan') : null;
      if (planQuestion && p.answer === PLAN_PROCEED) {
        assert(item.planQuestion?.planDigest === planDigest(flow), 'the plan changed since this question opened; read the current question');
        assert(proceedable(store.need('task', flow.taskId), flow), 'this plan cannot proceed as it is: the planner did not mark it ready, or strict work lacks a complete threat model and stop conditions; answer replan with a note');
      }
      // A clarification: an answer that sends the flow from a plan question back to planning.
      // The first PLAN_CLARIFICATIONS of a plan cycle do not use a plan attempt (cumulative visits
      // still record them); later ones count against the plan bound as any plan entry does. A
      // clarification never extends a bound or the transition allowance, so its loop stays capped.
      const clarification = planQuestion && next === planStep;
      const clarificationsUsed = clarification ? (flow.planClarifications ?? 0) + 1 : flow.planClarifications ?? 0;
      const uncountedVisit = clarification && clarificationsUsed <= PLAN_CLARIFICATIONS && Boolean(flow.workflow.nodes[planStep]?.maxVisits);
      if (clarification) flow.planClarifications = clarificationsUsed;
      if (uncountedVisit) { flow.limitExtensions ??= {}; flow.limitExtensions[planStep] = (flow.limitExtensions[planStep] ?? 0) + 1; }
      recordIntegrationDecision(flow, flow.workflow.nodes[flow.step], p, actor, identity, { delegated: delegatedAnswer, onBehalfOf });
      // Any answer may carry a note (for example why a task is blocked); the next question shows it.
      if(p.note!==undefined){flow.answerNotes??=[];flow.answerNotes.push({inboxId:item.id,step:flow.step,answer:p.answer,note:note(p.note),actor,...(onBehalfOf?{onBehalfOf}:{}),at:now()});}
      if(['send_back','repair'].includes(p.answer)||['retry','replan'].includes(p.answer)&&p.note) {
        const feedback=note(p.note);flow.operatorFeedback??=[];flow.operatorFeedback.push({inboxId:item.id,step:flow.step,answer:p.answer,note:feedback,actor,identity,at:now()});
        flow.limitExtensions??={};
        if(!clarification){
          for(const [step,definition] of Object.entries(flow.workflow.nodes))if(definition.maxVisits&&(flow.visits[step]??0)>=definition.maxVisits+(flow.limitExtensions[step]??0)&&!(['review','delta-review'].includes(step)&&effectiveRisk(store.need('task',flow.taskId),flow)==='strict'))flow.limitExtensions[step]=(flow.limitExtensions[step]??0)+1;
          flow.transitionAllowance=(flow.transitionAllowance??0)+12;
        }
        flow.mergeAuthorization=null;flow.evidence={};
        store.event('flow.feedback',{flowId:flow.id,inboxId:item.id,answer:p.answer,note:feedback});
      }
      // A note sent with "proceed" (answers or assumptions) reaches the plan reviewer and the builder.
      if(planQuestion&&p.answer===PLAN_PROCEED&&p.note){const feedback=note(p.note);flow.operatorFeedback??=[];flow.operatorFeedback.push({inboxId:item.id,step:flow.step,answer:p.answer,note:feedback,actor,identity,at:now()});store.event('flow.feedback',{flowId:flow.id,inboxId:item.id,answer:p.answer,note:feedback});}
      // The questions it went ahead without answering are carried to the reviewers, the builder and the merge question (dev.83).
      // If they cannot all be carried, proceeding would hide some: the answer is refused (replan asks for fewer).
      if(planQuestion&&p.answer===PLAN_PROCEED)assert(!carryProceededQuestions(flow,{actor,note:p.note,inboxId:item.id}),`this plan goes ahead on more questions than the flow carries (at most ${MAX_CARRIED}); answer replan with a note asking the planner for fewer`);

      if (flow.workflow.nodes[flow.step].satisfiedDecision && p.answer === 'accept') {
        const requirement = flow.mode === 'delivery' ? strictReviewRequirement(store.need('task',flow.taskId),flow,identity) : null;
        if (requirement) assert((actor === 'operator'||actor === (flow.strictDecisionRole??'operator')) && p.reviewedHead === identity.head, 'strict outcome requires explicit exact-head operator review acknowledgement');
        flow.completionDecision = { identity, taskRevision: flow.taskRevision, workflowDigest: flow.workflowDigest, configDigest: flow.configDigest, inboxId: item.id, actor, at: now(), ...(requirement ? {reviewedHead:p.reviewedHead,riskAssessmentDigest:requirement.assessmentDigest} : {}) };
      }
      if (flow.workflow.nodes[flow.step].mergeDecision && p.answer === 'merge') {
        const requirement = flow.mode === 'delivery' ? strictReviewRequirement(store.need('task',flow.taskId),flow,identity) : null;
        // Re-derive delegation at answer time: risk may have escalated since the question opened.
        const authority = actor === 'operator' ? 'operator' : item.autoMerge ? 'autoMerge' : requirement ? 'strictDecisionRole' : delegatedAnswer ? 'delegated' : 'mergeDecisionRole';
        if (authority === 'mergeDecisionRole') assert(mergeDecisionRole(store.need('task',flow.taskId),flow) === actor, 'merge decision is not delegated to this role for the current candidate');
        if (requirement) assert((actor === 'operator'||actor === (flow.strictDecisionRole??'operator')) && p.reviewedHead === identity.head, 'strict change requires explicit exact-head operator review acknowledgement');
        flow.mergeAuthorization = { identity, taskRevision: flow.taskRevision, workflowDigest: flow.workflowDigest, configDigest: flow.configDigest, inboxId: item.id, actor, authority, ...(delegatedAnswer ? { onBehalfOf } : {}), answeredAt: now(), ...(requirement ? {reviewedHead:p.reviewedHead,riskAssessmentDigest:requirement.assessmentDigest} : {}) };
      }
      if (flow.workflow.nodes[next].kind === 'end' && flow.workflow.nodes[next].outcome === 'completed') flow.completionDecision = { identity, taskRevision: flow.taskRevision, workflowDigest: flow.workflowDigest, inboxId: item.id };
      item.status = 'answered'; item.answer = p.answer; item.answeredBy = actor; item.answeredAt = now(); item.version++;
      // An orchestrator answering for the operator: the operator's instruction it acted on stays with the answer.
      if (actor === 'orchestrator' && onBehalfOf) item.onBehalfOf = onBehalfOf;
      // The note is on the answered item too, as on a standalone question (flow.answerNotes keeps the history).
      if (p.note !== undefined) item.answerNote = note(p.note);
      recordRelay(store, item, relayed, actor);
      const wait=store.get('wait',`question:${item.id}`);if(wait&&!wait.endedAt)store.put('wait',{...wait,endedAt:now(),reason:'answered'});
      store.put('inbox', item); move(store, flow, next);
      // The flow was parked without a slot: it works now if its pool has a free one, and otherwise
      // waits for the next, ahead of queued tasks (operations/capacity.mjs). It is never stopped for this.
      takeSlot(store, flow, { after: 'answer' });
      store.event('inbox.answered', { inboxId: item.id, flowId: flow.id, answer: p.answer, ...(clarification ? { clarification: clarificationsUsed } : {}), ...(uncountedVisit ? { uncountedVisit: planStep } : {}), ...(relayed ? { relayed: true, relayedBy: actor, channel: relayed.channel } : {}) }); return item;
    }
    case 'queue.put': {
      operator(); if(Object.hasOwn(p,'expectedQueueRevision'))assert(p.expectedQueueRevision===queueRevision(store),'queue metadata or order changed; refresh and review before saving'); assert(Array.isArray(p.taskIds) && new Set(p.taskIds).size === p.taskIds.length, 'unique task IDs required');
      if (Object.hasOwn(p, 'expectedTaskIds')) assert(digest(store.all('queue').filter(q => q.status === 'queued').sort((a,b) => (a.order ?? 0) - (b.order ?? 0)).map(q => q.id)) === digest(p.expectedTaskIds), 'queue changed; refresh and review the current order before saving');
      for (const key of p.taskIds) { id(key); assert(!store.need('task', key).tracked, `${key} is a tracked item and cannot be queued`); }
      const metadata = validateQueueMetadata(p.entries, p.taskIds), previousQueue = new Map(store.all('queue').map(row => [row.id,row]));
      for (const row of store.all('queue').filter(q => q.status === 'queued')) store.put('queue', { ...row, status: 'removed' });
      p.taskIds.forEach((key, order) => { const previous = previousQueue.get(key), entry = metadata.get(key); store.put('queue', { ...(previous?.status==='queued'?previous:{}), id: key, order, status: 'queued', queuedAt: previous?.status==='queued'?previous.queuedAt:now(), priority: entry?.priority ?? previous?.priority ?? 0, pinned: entry?.pinned ?? previous?.pinned ?? false }); });
      store.event('queue.updated', { taskIds: p.taskIds }); return { taskIds: p.taskIds };
    }
    case 'main.health': {
      operator(); note(p.note); assert(['green','red','unknown'].includes(p.status) && typeof p.head === 'string', 'main status and head required');
      // An operator exception speaks for every tier, including scheduled-tier evidence.
      const checkedAt = now(), health = { status: p.status, head: p.head, checkedAt, note: p.note, source: 'operator-exception', ...(hasScheduledTier(store.meta('config', {})) ? { scheduled: { status: p.status, head: p.head, checkedAt, checks: [], failed: [], source: 'operator-exception' } } : {}) };
      setTargetHealth(store, null, health); store.event('main.health', health); return health;
    }
    case 'schedule.put': {
      operator(); const schedule = p.schedule; id(schedule?.id, 'schedule id');
      const prior = store.get('schedule', schedule.id);
      assert(prior?.source !== 'config' && !/^(task|recurring):/.test(schedule.id), 'scheduled and recurring tasks are managed in the project configuration');
      if (Object.hasOwn(p, 'expectedSchedule')) assert(digest(prior ? { revision: prior.revision ?? null, enabled: prior.enabled === true } : null) === digest(p.expectedSchedule), 'schedule changed; refresh and review its current grant before saving');
      const type = schedule.type ?? (schedule.kind === 'interval' ? 'interval' : schedule.kind);
      assert(['interval','daily'].includes(type), 'invalid schedule type');
      assert(installedOperation(store.meta('config'),schedule.operation)||['main.verify','queue.dispatch','maintenance.backup','audit','retrospective','machine.sample','retention.archive','source.sync',LEARNINGS_CHECK_OPERATION].includes(schedule.operation), 'unsupported scheduled operation');
      if (schedule.operation === 'main.verify') verifyTier(schedule.payload);
      if (type === 'interval') assert(Number.isSafeInteger(schedule.everyMs) && schedule.everyMs >= 1000, 'invalid interval');
      else { assert(typeof schedule.timezone === 'string' && /^\d\d:\d\d$/.test(schedule.timeOfDay), 'timezone and time required'); new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }); }
      const record = { ...schedule, type, enabled: schedule.enabled !== false, anchorMs: schedule.anchorMs ?? Date.now(), createdAt: store.get('schedule', schedule.id)?.createdAt ?? now() };
      record.revision = digest({ ...record, lastScannedAt: null, revision: null });
      if (store.get('schedule', record.id)?.revision !== record.revision) for (const flow of store.all('flow')) { const task = store.get('task', flow.taskId); if (task?.approvalKind === 'schedule' && task.scheduleId === record.id) stopFlow(store, flow, 'scheduled authority replaced', true); }
      store.put('schedule', record); store.event('schedule.updated', { scheduleId: record.id }); return record;
    }
    case 'schedule.remove': { operator(); assert(typeof p.scheduleId === 'string' && p.scheduleId, 'schedule.remove needs scheduleId (the schedule id)'); const schedule = store.need('schedule', p.scheduleId); assert(schedule.source !== 'config', 'scheduled tasks are managed by scheduledTasks in the project configuration'); if (Object.hasOwn(p, 'expectedSchedule')) assert(digest({ revision: schedule.revision ?? null, enabled: schedule.enabled === true }) === digest(p.expectedSchedule), 'schedule changed; refresh and review its current grant before disabling'); schedule.enabled = false; store.put('schedule', schedule); for (const flow of store.all('flow')) { const task = store.get('task', flow.taskId); if (task?.approvalKind === 'schedule' && task.scheduleId === schedule.id) stopFlow(store, flow, 'scheduled authority revoked', true); } store.event('schedule.revoked', { scheduleId: schedule.id }); return schedule; }
    case 'schedule.pause': {
      // Pausing a configuration-owned schedule is console state that survives config updates.
      operator(); assert(typeof p.scheduleId === 'string' && p.scheduleId, 'schedule.pause needs scheduleId (the schedule id)'); const schedule = store.need('schedule', p.scheduleId);
      assert(schedule.source === 'config', 'pause applies to scheduled and recurring tasks; use schedule.put or schedule.remove for other schedules');
      assert(typeof p.paused === 'boolean', 'paused must be true or false');
      if (p.paused) { schedule.paused = { at: now(), by: actor, ...(typeof p.note === 'string' && p.note.trim() ? { note: p.note.trim().slice(0, 500) } : {}) }; schedule.enabled = false; }
      else { delete schedule.paused; schedule.enabled = schedule.configEnabled !== false && !schedule.removedAt; schedule.lastScannedAt = now(); }
      store.put('schedule', schedule); store.event(p.paused ? 'schedule.paused' : 'schedule.resumed', { scheduleId: schedule.id }); return schedule;
    }
    case 'recurring.run': {
      operator(); const schedule = store.need('schedule', `recurring:${p.name}`);
      assert(schedule.recurringTask && !schedule.removedAt, 'unknown recurring task');
      const at = now(), result = createRecurringOccurrence(store, store.meta('config', {}), p.name, { key: `recurring:${p.name}:manual-${Date.parse(at)}`, at }, { manual: true });
      store.put('occurrence', { id: digest(result.key), scheduleId: schedule.id, key: result.key, at, manual: true, commandId: result.taskId }); return result;
    }
    case 'delivery.ack': {
      // A delivery acknowledgement cannot postpone or settle a notice only the operator may acknowledge.
      const row = store.need('delivery', p.deliveryId), item = row.inboxId ? store.get('inbox', row.inboxId) : null;
      assert(!item?.operatorAckOnly || actor === 'operator', 'only the operator can acknowledge delivery of this notice');
      return acknowledgeDeliveryInTransaction(store,{deliveryId:p.deliveryId});
    }
    case 'rule.pushback': {
      if (p.flowId !== undefined) store.need('flow', p.flowId);
      id(p.ruleId, 'rule id');
      return recordPushbackInTransaction(store, { ruleId: p.ruleId, flowId: p.flowId, reason: note(p.reason), evidence: note(p.evidence), actor });
    }
    case 'finding.accept': {
      // Knowledge-upkeep design 4.3, 4.4: a task for a finding, at the version that was read. For an
      // audit finding the task is an ordinary one: created here from a brief (as task.put creates
      // it), or one that exists. Nothing is approved. A docs candidate's task is the factory's to
      // create (4.3).
      //
      // A check or learning candidate (slice 7): the operator, or the orchestrator where finding.accept
      // is delegated, writes one task of kind check or learning-add from the stored row, unapproved
      // (createCaptureTaskInTransaction). `files` names the fast-check scripts a check task may change,
      // from those the factory offers; `paths` the globs a learning applies to. `approve: true`
      // approves it in the same command, and only the operator acting directly may ask for that
      // (4.3: "The operator may accept and approve in one command"); otherwise approval is
      // task.approve under 9.1. The upkeep task ceilings refuse a delegated acceptance at the limit and
      // never the operator acting directly (dev.92, P2; operator 2026-11-17).
      //
      // Governing-context proposals (slice 6, design 9.4) are accepted by the operator alone, acting
      // directly: never on an instruction, by delegation or under a grant, whatever
      // policy.delegatedOperations says (Q2). One command names each proposal's id, the version
      // displayed and the digest of what was displayed; in this one transaction it writes the
      // context task from the stored rows, approves that revision as the operator's own approval
      // (task.approve, which records governingEditsApproval), and marks each proposal tasked. Any
      // refusal rolls the whole command back, so it writes nothing.
      if (p.proposals !== undefined) {
        assert(actor === 'operator' && !onBehalfOf && !store.commandAuthority, 'accepting governing-context proposals is the operator\'s alone, acting directly: it is refused to the orchestrator under any instruction, delegation or grant, and to any command that cites a grant');
        assert(Object.keys(p).every(key => key === 'proposals') && Array.isArray(p.proposals), 'finding.accept of governing-context proposals takes proposals: [{findingId, expectedVersion, digest}], each the version and the digest shown');
        const accepted = createContextTaskInTransaction(store, { proposals: p.proposals, owned: projectOwned(store), approve: task => applyOperationInTransaction(store, { operation: 'task.approve', payload: { taskId: task.id, revision: task.revision }, actor, onBehalfOf }) });
        assert(accepted.task.approvedRevision === accepted.task.revision && accepted.task.governingEditsApproval?.revision === accepted.task.revision, `context task ${accepted.task.id} was not approved by this command`);
        return accepted;
      }
      const peek = typeof p.findingId === 'string' ? store.get('finding', p.findingId) : null;
      // A stale-learning candidate (slice 8) is accepted the same way into a learning-retire task, which
      // may delete exactly the one learning file, with the content it has at the target head now.
      if (isUpkeepCandidate(peek) && ['check', 'learning', 'learning-stale'].includes(peek.kind)) {
        findingActor(store, peek, { operation, actor, onBehalfOf });
        assert(Object.keys(p).every(key => ['findingId', 'expectedVersion', 'files', 'paths', 'approve'].includes(key)), `finding.accept of a ${peek.kind} candidate accepts findingId, expectedVersion, ${peek.kind === 'check' ? 'files and ' : peek.kind === 'learning' ? 'paths and ' : ''}approve: the task is made by the factory from the stored candidate, never from a brief or an existing task`);
        assert(Number.isSafeInteger(p.expectedVersion), 'finding.accept needs expectedVersion: the finding version you read');
        assert(p.approve === undefined || typeof p.approve === 'boolean', 'approve must be true or false');
        if (p.approve) assert(actor === 'operator' && !onBehalfOf && !store.commandAuthority, 'accepting and approving in one command is the operator\'s own, acting directly; the orchestrator accepts, and the task is approved by task.approve under its own rules');
        const config = store.meta('config', {});
        const made = createCaptureTaskInTransaction(store, { findingId: peek.id, expectedVersion: p.expectedVersion, files: p.files, paths: p.paths, reader: () => captureHeadReader(store, { config }), tasks: findingTasks(store), by: { actor, onBehalfOf, direct: actor === 'operator' && !onBehalfOf && !store.commandAuthority }, config });
        if (!p.approve) return made;
        applyOperationInTransaction(store, { operation: 'task.approve', payload: { taskId: made.task.id, revision: made.task.revision }, actor, onBehalfOf });
        const task = store.need('task', made.task.id); assert(task.approvedRevision === task.revision, `task ${task.id} was not approved by this command`);
        return { ...made, task };
      }
      assert(Object.keys(p).every(key => ['findingId', 'expectedVersion', 'task', 'taskId'].includes(key)), 'finding.accept accepts findingId, expectedVersion and either task or taskId (or, for governing-context proposals and rules, proposals; for a check or learning candidate, files, paths and approve)');
      const row = store.need('finding', p.findingId); findingActor(store, row, { operation, actor, onBehalfOf });
      assert(Number.isSafeInteger(p.expectedVersion), 'finding.accept needs expectedVersion: the finding version you read');
      assert(!isUpkeepCandidate(row), `finding ${row.id} is a knowledge upkeep candidate (${findingKind(row)}); ${findingKind(row) === 'docs' ? 'the factory creates docs follow-ups itself, from the waiting docs candidates (knowledge upkeep in propose mode)' : ['context', 'rule'].includes(findingKind(row)) ? `a ${findingKind(row) === 'rule' ? 'rule' : 'governing-context proposal'} is accepted by the operator with proposals: [{findingId, expectedVersion, digest}], which creates and approves its task in one step` : 'this release delivers no candidate of that kind'}, so none is accepted into a task by command naming findingId. It can be declined or recorded as resolved elsewhere (finding.resolve)`);
      assert((p.task === undefined) !== (p.taskId === undefined), 'finding.accept takes either task (a brief to create) or taskId (a task that exists)');
      if (p.task !== undefined) { assert(p.task && typeof p.task === 'object' && !store.get('task', p.task.id), 'that task already exists; name it with taskId'); applyOperationInTransaction(store, { operation: 'task.put', payload: { task: p.task }, actor, onBehalfOf }); }
      const task = store.need('task', p.task?.id ?? p.taskId);
      assert(!isMaintenanceTask(task) && !hasUpkeepMarker(task) && !inUpkeepNamespace(task.id), `task ${task.id} is not an ordinary project task; an audit finding is recorded against an ordinary task`);
      assert(!task.closed && task.status !== 'completed' && !task.tracked, `task ${task.id} is ${task.closed ? 'closed' : task.tracked ? 'a tracked item' : 'completed'}; a finding is recorded against open work`);
      const findings = [...new Set([...(task.findings ?? []), row.id])]; assert(findings.length <= MAX_TASK_FINDINGS, `a task carries at most ${MAX_TASK_FINDINGS} findings`);
      const [finding] = linkFindingsInTransaction(store, { findings: [{ id: row.id, expectedVersion: p.expectedVersion }], task, by: 'person', actor });
      const linked = { ...task, findings }; store.put('task', linked);
      // A flow already working on the task learns of the finding, so that its merge delivers it.
      for (const flow of store.by('flow', 'taskId', task.id).filter(f => !['completed', 'failed'].includes(f.state))) store.put('flow', { ...flow, findings });
      return { finding, task: linked };
    }
    case 'finding.resolve': {
      // Decline a finding, with a reason, or record that it was dealt with another way, with
      // evidence; at the version that was read. Declining a tasked finding closes its task and
      // declines every finding linked to it.
      assert(Object.keys(p).every(key => ['findingId', 'expectedVersion', 'disposition', 'reason', 'evidence', 'note'].includes(key)), 'finding.resolve accepts findingId, expectedVersion, disposition, reason, evidence and note');
      const row = store.need('finding', p.findingId); findingActor(store, row, { operation, actor, onBehalfOf });
      assert(Number.isSafeInteger(p.expectedVersion), 'finding.resolve needs expectedVersion: the finding version you read');
      if (p.note !== undefined) note(p.note);
      const disposed = disposeFindingInTransaction(store, { id: row.id, expectedVersion: p.expectedVersion, disposition: p.disposition, reason: p.reason, evidence: p.evidence, note: p.note, by: { actor, onBehalfOf }, tasks: findingTasks(store) });
      // A docs follow-up a decline closed, or a docs candidate that left the open set: the next
      // follow-up may be made from what is waiting now (knowledge upkeep in propose mode; review of 292d317, Q4).
      if (isUpkeepCandidate(row) && row.kind === 'docs') tryDocsFollowUpInTransaction(store, { tasks: findingTasks(store) });
      // The one waiting notice for governing-context proposals follows the open count (slice 6).
      if (isUpkeepCandidate(row) && row.kind === 'context') contextWaitingNoticeInTransaction(store);
      return disposed;
    }
    case 'finding.reopen': {
      // A closed finding (declined, expired, failed, resolved elsewhere) back to open, by a person only.
      assert(Object.keys(p).every(key => ['findingId', 'expectedVersion', 'note'].includes(key)), 'finding.reopen accepts findingId, expectedVersion and note');
      const row = store.need('finding', p.findingId); findingActor(store, row, { operation, actor, onBehalfOf });
      assert(Number.isSafeInteger(p.expectedVersion), 'finding.reopen needs expectedVersion: the finding version you read');
      const reopened = reopenFindingInTransaction(store, { id: row.id, expectedVersion: p.expectedVersion, note: note(p.note), by: { actor, onBehalfOf } });
      // A reopened docs candidate waits again: a follow-up may be made from it now (Q4).
      if (isUpkeepCandidate(row) && row.kind === 'docs') tryDocsFollowUpInTransaction(store, { tasks: findingTasks(store) });
      if (isUpkeepCandidate(row) && row.kind === 'context') contextWaitingNoticeInTransaction(store);
      return reopened;
    }
    case 'upkeep.lift': {
      // 8.4, N3: a suspension is lifted only by the operator, with a note. It is not delegable
      // (core/delegation.mjs does not list it), and nothing else lifts one.
      operator(); assert(actor === 'operator', 'a knowledge upkeep suspension is lifted only by the operator');
      assert(Object.keys(p).every(key => ['part', 'expectedAt', 'note'].includes(key)), 'upkeep.lift accepts part, expectedAt and note');
      note(p.note);
      if (p.expectedAt !== undefined) assert(upkeepSuspensions(store)[p.part]?.at === p.expectedAt, 'that suspension changed since it was read; refresh and read why it is suspended now');
      return liftUpkeepCeilingInTransaction(store, { part: p.part, note: p.note, by: actor });
    }
    case 'obligation.resolve': {
      operator(); note(p.note); const row = store.need('obligation', p.obligationId); assert(['passed','failed','deferred'].includes(p.status) && typeof p.evidence === 'string' && p.evidence.trim(), 'status and evidence required');
      const updated = { ...row, status: p.status, evidence: p.evidence, note: p.note, resolvedAt: now() }; store.put('obligation', updated); store.event('obligation.resolved', updated); return updated;
    }
    case 'flow.replan': {
      operator(); note(p.note); const flow = store.need('flow', p.flowId); assert(!flow.attemptId, 'resolve current attempt first');
      assert(flow.mode === 'delivery' && !flow.results?.merge?.merged, 'cannot replan completed merge');
      assert(!flow.workspaceReleased, 'this flow\'s workspace was archived and released; start a new flow');
      const task = store.need('task', flow.taskId); assert(task.revision === flow.taskRevision && task.approvedRevision === flow.taskRevision, 'matching valid authority required');
      // A replan starts work again. Only a flow that is at a working step, not stopped and not
      // waiting for a slot certainly holds one. Every other flow takes a slot or waits for one
      // (operations/capacity.mjs), like an answer or a resume:
      // - parked on a question, or already waiting for a slot (it keeps the time its wait began);
      // - stopped, or at a question or end node in any other state (answered `stop` a moment ago,
      //   resumed and not asked again yet), or finished: it may or may not have had a slot.
      // Each joins the line in order: it continues at once only if its pool has room for it after
      // every flow already waiting, and otherwise waits behind them. (Unlike a resume, a replanned
      // stopped flow does not keep a slot ahead of flows that are waiting.)
      const node = flow.workflow?.nodes?.[flow.step], finished = ['completed', 'failed'].includes(flow.state);
      const inLine = atQuestion(store, flow) || waitingForSlot(flow), since = flow.slotWait?.since;
      const unsure = flow.state === 'stopped' || finished || !node || ['question', 'end'].includes(node.kind);
      // A finished flow (abandoned, or failed) stopped excluding other work when it finished. Bringing
      // it back must not put it beside work admitted since: the exclusions a stopped flow would
      // have kept (its task, its area, its paths) are checked as admission checks them.
      if (finished) {
        const blocked = admissionReasons(store, task).filter(reason => /^(task already active|task has a stopped flow|area occupied|paths overlap|active workspace conflict evidence unavailable|task or reviewed plan conflict scope invalid)/.test(reason));
        assert(!blocked.length, `cannot replan finished flow ${flow.id}: ${blocked.join('; ')}; abandon or finish that work first, or start the task again (task.restart)`);
      }
      replanFlow(store, flow, { note: p.note, by: actor, onBehalfOf });
      if (inLine || unsure) { if (since) flow.slotWait = { since }; takeSlot(store, flow, { after: 'replan' }); }
      return flow;
    }
    case 'task.restart': {
      // Settle what is left of the task's last flow and start again from its current revision,
      // in one command: uncertain attempts are recorded failed at no cost, open flows abandoned,
      // the current revision approved and a new flow started.
      operator(); note(p.note); const task = store.need('task', p.taskId);
      assert(task.revision === p.revision, 'stale task revision; read the task again');
      const settled = [], abandoned = [];
      for (const flow of store.by('flow', 'taskId', task.id).filter(f => !['completed', 'failed'].includes(f.state))) {
        assert(!flow.results?.merge?.merged, `flow ${flow.id} already merged; close it out instead`);
        if (flow.attemptId) {
          const attempt = store.need('attempt', flow.attemptId);
          assert(attempt.status === 'uncertain' && !attempt.settledAt, `flow ${flow.id} has a step still running; stop it first`);
          attempt.status = 'failed'; attempt.costMicros = 0; attempt.settledAt = now(); attempt.reconciliation = { actor, note: p.note, at: now(), by: 'task.restart' }; settleAttemptForUpkeepInTransaction(store, attempt, flow); store.put('attempt', attempt);
          store.event('attempt.reconciled', { attemptId: attempt.id, flowId: flow.id, by: actor, disposition: 'failed', costMicros: 0, note: p.note }); flow.attemptId = null; settled.push(attempt.id);
        }
        flow.state = 'failed'; flow.stopRequested = true; flow.abandonedAt = now(); flow.finishedAt = flow.abandonedAt; store.put('flow', flow); settleFlowJob(store, flow, 'abandoned', p.note); closeAbandonedInbox(store, flow, 'flow abandoned');
        store.event('flow.abandoned', { flowId: flow.id, note: p.note, by: actor, workspaceRetained: !!flow.workspace }); abandoned.push(flow.id);
      }
      if (task.approvedRevision !== task.revision) applyOperationInTransaction(store, { operation: 'task.approve', payload: { taskId: task.id, revision: task.revision }, actor, onBehalfOf });
      const started = applyOperationInTransaction(store, { operation: 'flow.start', payload: { taskId: task.id, revision: task.revision, note: p.note, ...(p.modelOverrides !== undefined ? { modelOverrides: p.modelOverrides } : {}) }, actor, onBehalfOf });
      store.event('task.restarted', { taskId: task.id, by: actor, settled, abandoned, flowId: started.id });
      return { taskId: task.id, settled, abandoned, flowId: started.id };
    }
    case 'flow.abandon': {
      operator(); note(p.note); const flow = store.need('flow', p.flowId); assert(!flow.attemptId && !flow.results?.merge?.merged, 'resolve attempt or close out completed merge first');
      flow.state = 'failed'; flow.stopRequested = true; flow.abandonedAt = now(); flow.finishedAt = flow.abandonedAt; store.put('flow', flow); settleFlowJob(store, flow, 'abandoned', p.note); closeAbandonedInbox(store, flow, 'flow abandoned'); store.event('flow.abandoned', { flowId: flow.id, note: p.note, by: actor, workspaceRetained: !!flow.workspace }); return flow;
    }
    case 'attempt.resolve': {
      operator(); note(p.note); const attempt = store.need('attempt', p.attemptId), flow = store.need('flow', attempt.flowId);
      assert(attempt.status === 'uncertain' && !attempt.settledAt, 'only uncertain attempts can be reconciled');
      assert(['not-dispatched','failed'].includes(p.disposition) && Number.isSafeInteger(p.costMicros) && p.costMicros >= 0, 'explicit disposition and actual cost required');
      assertAttemptQuiescent(store, attempt, p);
      // This is an operator attestation after external inspection, never automatic retry evidence.
      attempt.status = p.disposition; attempt.costMicros = p.costMicros; attempt.settledAt = now(); attempt.reconciliation = { actor, note: p.note, at: now() };
      // Knowledge upkeep (design 4.5, 6.6), in this command's own transaction: the attempt's
      // invocations are added to the day's totals under its new status and the receipt it kept, and
      // an upkeep assessment's model run is settled, or given back when it was not dispatched.
      settleAttemptForUpkeepInTransaction(store, attempt, flow);
      store.put('attempt', attempt);
      const warning = failureRouteWarning(flow, attempt.step);
      flow.attemptId = null; flow.resumeStep = flow.workflow.nodes[attempt.step].onFailure; stopFlow(store, flow, `${actor === 'operator' ? 'the operator' : `the ${actor}`} reconciled an uncertain attempt${warning ? `. ${warning.replace(/^Settling it \(attempt\.resolve[^)]*\) makes resume/, 'Resume will')}` : ''}`);
      store.event('attempt.reconciled', { attemptId: attempt.id, flowId: flow.id, by: actor, disposition: p.disposition, costMicros: p.costMicros, note: p.note }); return attempt;
    }
    case 'restore.release': {
      operator(); note(p.note); assert(store.meta('recoveryHold'), 'no restore/recovery hold');
      assert(!store.live('attempt').some(a => !a.settledAt), 'all attempts need explicit reconciliation');
      assert(store.live('flow').every(f => ['stopped','failed','completed'].includes(f.state)), 'active flows must be stopped before release');
      const reason = store.meta('recoveryHoldReason', null); clearRecoveryHold(store); store.event('restore.reconciled', { note: p.note, ...(reason ? { cause: reason.cause } : {}) }); return { recoveryHold: false, paused: store.meta('paused') };
    }
    case 'models.update': {
      operator();
      // The model of knowledge upkeep's assessment decides what runs, so it is upkeep authority
      // (design 9.2), on both schemas: only the operator sets or resets its live default. Every
      // other workflow's live defaults stay as delegable as they were.
      assert(actor === 'operator' || p?.workflow !== UPKEEP_MODEL_WORKFLOW, `models.update for ${UPKEEP_MODEL_WORKFLOW} can only be made by the operator (the model of the knowledge upkeep assessment is authority)`);
      return updateModelDefaults(store, p, actor);
    }
    case 'settings.update': {
      // Live settings change without draining work or running doctor again: the configuration
      // digest that flows and commissioning are bound to stays the same.
      operator(); note(p.note);
      assert(p.changes && typeof p.changes === 'object' && !Array.isArray(p.changes) && Object.keys(p.changes).length > 0 && Object.keys(p.changes).length <= 16, 'settings.update needs changes: {setting: value}');
      assert(Object.keys(p).every(k => ['changes', 'expected', 'note'].includes(k)), 'settings.update accepts changes, expected and note');
      const current = store.meta('config', {});
      for (const path of Object.keys(p.changes)) {
        assert(LIVE_SETTINGS[path], `${path} is not a live setting; change it with config update`);
        // The orchestrator cannot widen its own delegation.
        if (LIVE_SETTINGS[path].operatorOnly) assert(actor === 'operator', `${path} can only be changed by the operator`);
        if (p.expected && Object.hasOwn(p.expected, path)) assert(digest(liveValue(current, path)) === digest(p.expected[path]), `${path} changed since it was read; refresh and try again`);
      }
      const config = validateConfig(applyLiveChanges(current, p.changes));
      if (actor !== 'operator') { const changed = operatorOnlyChanges(current, config); assert(!changed.length, `${changed.join(', ')} can only be changed by the operator`); }
      // Knowledge upkeep's settings are authority (what the factory may create, and how much), on
      // both schemas: only the operator changes them, except that anyone who may use this command
      // may turn the mode down. Turning it up is refused while the reserved namespace holds a
      // task the factory did not make.
      if (actor !== 'operator') { const changed = delegatedUpkeepChanges(current, config); assert(!changed.length, `${changed.join(', ')} can only be changed by the operator (knowledge upkeep settings are authority; a delegate may only turn upkeep.mode down)`); }
      assertUpkeepMayTurnOn(store, current, config);
      // The route of the upkeep assessment is pinned when upkeep is turned on, and cleared when it is
      // turned off (operations/upkeep-route.mjs). A project that observed before routes were pinned
      // is pinned first, from the configuration as it is before this change.
      const upkeepRoute = upkeepRouteAfter(ensureUpkeepRoutePinnedInTransaction(store, current), current, config, actor);
      // Migrated projects: operator authority is never delegable, whatever the project mode.
      if (authorityLedgerEnabled(store)) validateDelegatedOperations(config.policy?.delegatedOperations);
      // Migrated projects: authority-bearing policy changes only by the operator directly.
      if (authorityLedgerEnabled(store) && actor !== 'operator') { const changed = authorityPolicyChanges(store, current, config); assert(!changed.length, `settings.update by the ${actor} cannot change authority-bearing policy (${changed.join(', ')}); the operator must change it directly`); }
      recordLiveChanges(store, current, config, { actor, onBehalfOf, commandId: store.commandId });
      writeUpkeepRouteInTransaction(store, upkeepRoute); noteUpkeepCountingInTransaction(store, current, config);
      store.setMeta('config', config);
      store.event('settings.updated', { changes: p.changes, note: p.note, by: actor, ...(onBehalfOf ? { onBehalfOf } : {}) });
      return { changed: Object.keys(p.changes), values: Object.fromEntries(Object.keys(p.changes).map(path => [path, liveValue(config, path)])), configDigest: store.meta('configDigest') };
    }
    case 'doctor.request': {
      // The operations loop runs doctor for the current configuration and records the outcome.
      operator(); note(p.note);
      const commissioning = store.meta('commissioning');
      assert(store.meta('config', {}).mode === 'delivery', 'doctor applies to delivery projects');
      assert(!(commissioning?.ready && commissioning.configDigest === store.meta('configDigest')), 'doctor has already passed for this configuration; re-qualifying needs the runner stopped, from the CLI');
      const running = store.meta('doctorRequest');
      assert(!running || running.status !== 'queued' && running.status !== 'running', 'doctor is already requested');
      const request = { id: uid(), status: 'queued', requestedAt: now(), by: actor, note: p.note, configDigest: store.meta('configDigest') };
      store.setMeta('doctorRequest', request); store.event('doctor.requested', { id: request.id, by: actor }); return request;
    }
    case 'config.update': {
      operator(); note(p.note); assert(!store.live('flow').some(f => blocksDrain(store, f)), 'drain or abandon work before changing configuration');
      // current: re-apply the stored configuration (config update --current, the upgrade's
      // recommission). The stored values are the live values, so every live change keeps its
      // provenance exactly; recomputing it against the stored configuration would erase it, and the
      // next update from the operator's file would then revert those changes (dev.88 M1).
      assert(p.current !== true || (p.config === undefined && p.replaceLive !== true), 'config.update with current re-applies the stored configuration: pass neither config nor replaceLive');
      const previous = store.meta('config', {}), provenance = liveSettingChanges(store);
      const live = p.current === true ? { config: structuredClone(previous), kept: [], details: [], changes: provenance } : p.replaceLive === true ? { config: p.config, kept: [], details: [], changes: {} } : keepLiveValues(previous, p.config, provenance);
      const config = validateConfig(live.config), catalog = config.mode === 'delivery' && config.workflows ? compileCatalog(config, store.meta('project').root) : null, workflow = config.mode === 'delivery' ? (catalog ? defaultWorkflow(catalog, config) : changeWorkflow(config)) : store.meta('workflow');
      // Migrated projects: a delegated replacement cannot change effective authority-bearing policy,
      // compared after normalization (defaults, replaceLive, catalog question roles, recurrence
      // approval templates, integration authorization and delegation settings).
      // Operator-only live settings: compared by effective value, whatever path the file takes
      // (kept live values, replaceLive, a dropped key that falls back to its default, a mode change).
      if (actor !== 'operator') { const changed = operatorOnlyChanges(store.meta('config', {}), config); assert(!changed.length, `config.update by the ${actor} cannot change operator-only settings (${changed.join(', ')}); the operator must change them directly`); }
      // Knowledge upkeep's settings are authority on both schemas (see settings.update): a delegated
      // replacement may change none of them, except turning the mode down.
      if (actor !== 'operator') { const changed = delegatedUpkeepChanges(store.meta('config', {}), config); assert(!changed.length, `config.update by the ${actor} cannot change knowledge upkeep settings (${changed.join(', ')}); they are authority, and the operator must change them directly (a delegate may only turn upkeep.mode down)`); }
      assertUpkeepMayTurnOn(store, store.meta('config', {}), config);
      if (authorityLedgerEnabled(store)) validateDelegatedOperations(config.policy?.delegatedOperations);
      if (authorityLedgerEnabled(store) && actor !== 'operator') { const changed = authorityPolicyChanges(store, store.meta('config', {}), config, { catalog, workflow }); assert(!changed.length, `config.update by the ${actor} cannot change authority-bearing policy (${changed.join(', ')}); the operator must make this change directly`); }
      // The pinned route of the upkeep assessment (operations/upkeep-route.mjs): pinned from the
      // configuration in force before this write when the project has none yet, then re-pinned only
      // when this write turns upkeep on or changes providers.upkeep, which only the operator can do.
      // A change to providers.reviewer leaves it as it is.
      const upkeepRoute = upkeepRouteAfter(ensureUpkeepRoutePinnedInTransaction(store, previous), previous, config, actor);
      const defaults = p.replaceLive === true ? {} : modelDefaults(store);
      // The same authority reaches the live model default of the upkeep assessment: a delegated
      // replacement may not discard the one the operator set.
      assert(actor === 'operator' || p.replaceLive !== true || !Object.hasOwn(modelDefaults(store), UPKEEP_MODEL_WORKFLOW), `config.update by the ${actor} cannot reset the live model default of ${UPKEEP_MODEL_WORKFLOW} (replaceLive); it is knowledge upkeep authority, and the operator must change it directly`);
      validateModelDefaults(withUpkeepRoute(config, upkeepRoute.pin), withBuiltinModelGraphs(config, config.mode !== 'delivery' ? {} : catalog ? Object.fromEntries(Object.entries(catalog.workflows).map(([name, row]) => [name, row.workflow])) : { standard: workflow }), defaults);
      for (const flow of store.live('flow').filter(flow => carriesOverUpgrade(store, flow) && !flow.modelRoutes)) { pinFlowModels(store, flow); store.put('flow', flow); }
      if (p.replaceLive === true) store.setMeta('modelDefaults', {});
      if (config.mode === 'delivery') validateRecurringWorkflows(config, catalog);
      retireLeftoverPlans(store);
      writeUpkeepRouteInTransaction(store, upkeepRoute); noteUpkeepCountingInTransaction(store, previous, config);
      store.setMeta('config', config); store.setMeta('configDigest', digest(config)); store.setMeta('workflow', workflow); store.setMeta('workflowDigest', digest(workflow)); store.setMeta('catalog', catalog); store.setMeta('commissioning', null); syncScheduledTaskRecords(store, config);
      // Live changes that survive this commit keep their provenance; every other key now follows the file.
      store.setMeta('liveSettingChanges', live.changes);
      // Every live setting whose value this write changes is reported, with the last live change to
      // it, so a live change the file reverts is never silent (dev.88 M1).
      const changedLive = changedLiveSettings(store, previous, config), preserved = p.current === true ? Object.keys(live.changes) : [];
      // Delivery starting now: send only what still needs someone, not the backlog (F22).
      const backlog = deliveryStarts(previous, config) ? trimDeliveryBacklogInTransaction(store) : null;
      for (const flow of store.live('flow').filter(f => carriesOverUpgrade(store, f))) rebindTaskFlow(store, flow, config, catalog); store.event('config.updated', { digest: digest(config), note: p.note }); const ignored = obsoleteSettings(p.current === true ? previous : p.config); if (ignored.length) store.event('config.ignored-settings', { settings: ignored }); if (live.kept.length || preserved.length) store.event('config.kept-live-settings', { settings: [...live.kept, ...preserved], details: live.details, ...(preserved.length ? { preserved } : {}) }); if (changedLive.length) store.event('config.live-settings-changed', { settings: changedLive.map(row => row.setting), details: changedLive }); return { keptLiveSettings: live.kept, ...(live.details.length ? { keptLiveDetails: live.details } : {}), ...(p.current === true ? { preservedLiveSettings: preserved } : {}), ...(changedLive.length ? { changedLiveSettings: changedLive.map(row => row.setting), changedLiveDetails: changedLive } : {}), ...(backlog ? { notificationBacklog: backlog } : {}), configDigest: digest(config), qualificationRequired: true, ...(ignored.length ? { ignoredSettings: ignored, ignoredReason: `${[...new Set(ignored.map(path => OBSOLETE_SETTING_REASONS[path]))].join('; ')}; these settings have no effect` } : {}) };
    }
    case 'provider.hold': {
      operator(); return operatorHold(store, p, { actor, onBehalfOf });
    }
    case 'spending.reconcile': {
      operator();note(p.note);assert(store.meta('config')?.spending?.coordinatorPath,'configured shared spending ledger required');
      const ledger=new SpendingLedger(store.meta('config').spending.coordinatorPath);
      try {
        const row=ledger.get(p.id);assert(row?.projectId===store.meta('project').projectId&&row.attemptId,'owned canonical paid reservation required');
        const attempt=store.need('attempt',row.attemptId),flow=store.need('flow',row.flowId);assert(attempt.flowId===flow.id&&flow.stopRequested,'stop the paid flow before reconciliation');
        assertAttemptQuiescent(store,attempt,p);
        const result=ledger.reconcile(p.id,{actualMicros:p.actualMicros,receiptDigest:p.receiptDigest,reviewDigest:p.reviewDigest,note:p.note,...(p.newCapMicros===undefined?{}:{newCapMicros:p.newCapMicros})});
        store.event('spending.reconciled',{reservationId:p.id,attemptId:row.attemptId,proofDigest:result.reconciliationDigest,actor});return result;
      } finally {ledger.close();}
    }
    case 'job.enqueue': {
      operator(); note(p.note); assert(installedOperation(store.meta('config'),p.operation)||['main.verify','queue.dispatch','maintenance.backup','audit','retrospective','machine.sample','retention.archive','source.sync','source.create','source.promote','target.sync',UPKEEP_OPERATION,LEARNINGS_CHECK_OPERATION].includes(p.operation)||isScheduledOperation(store.meta('config'),p.operation), 'unsupported maintenance operation');
      // Knowledge upkeep by hand, for one merged flow: the run keeps its receipt and its deadlines (operations/upkeep-runs.mjs).
      if (p.operation === UPKEEP_OPERATION) {
        assert(p.modelOverrides === undefined, 'modelOverrides on maintenance jobs require the audit workflow');
        const job = enqueueManualUpkeepInTransaction(store, { flowId: p.payload?.flowId, grant: { actor, ...(onBehalfOf ? { onBehalfOf } : {}), note: p.note } });
        store.event('job.enqueued', { jobId: job.id, operation: job.operation }); return job;
      }
      if (p.modelOverrides !== undefined) {
        assert(p.operation === 'audit', 'modelOverrides on maintenance jobs require the audit workflow');
        const config = store.meta('config'), key = 'maintenance/audit';
        selectFlowModels(config, key, withBuiltinModelGraphs(config, {})[key], modelDefaults(store), p.modelOverrides);
      }
      if (p.operation === 'main.verify') verifyTier(p.payload);
      const job = { id: uid(), operation: p.operation, payload: p.payload ?? {}, ...(p.modelOverrides !== undefined ? { modelOverrides: p.modelOverrides } : {}), grant: { actor, ...(onBehalfOf ? { onBehalfOf } : {}), note: p.note, configDigest: store.meta('configDigest') }, status: 'queued', createdAt: now() };
      store.put('job', job); store.event('job.enqueued', { jobId: job.id, operation: job.operation }); return job;
    }
    default: throw new Error(MAINTENANCE_OPERATIONS.includes(operation) ? `${operation} is a maintenance operation; send job.enqueue {operation: "${operation}", payload, note} (or maintenance enqueue)` : `unsupported operation ${operation}; command --help lists them`);
  }
}
