import { targetHealth, targetOf, pendingTargetSync, targetSyncHolds } from './targets.mjs';
import { inputReasons } from './inputs.mjs';
import { mainHealthReason } from './main-health-reason.mjs';
import { scheduledTierHold } from './main-tiers.mjs';
import { mergesInFlight, mergeInFlightReason } from './merge-hold.mjs';
import { hasUpkeepMarker, upkeepMarkerRefusal } from '../core/upkeep-namespace.mjs';
import {sourceSettings} from './source-config.mjs';
import { assert, now } from '../core/contracts.mjs';
import { declaredConflictPaths, activeConflictPaths, captureConflictScope } from './conflicts.mjs';
import { orderedQueue } from './queue-order.mjs';
import { workflowAdmission, commissionedGraphs } from '../core/catalog.mjs';
import { selectFlowModels, modelDefaults } from './model-settings.mjs';
import { heldProviders, routeHoldReasons, providerHold } from './provider-limits.mjs';
import { recordQueueAdmission } from './queue-diagnostics.mjs';
import { decisionHolds, holdReason } from '../core/decisions.mjs';
import { answeredAhead, capacityReason, categoryReason, slots } from './capacity.mjs';
import { contextProviderRefusal, unqualifiedProviders } from './upkeep-context.mjs';
import { declaredProviderConfig } from './provider-config.mjs';
export const activeFlow = flow => !['completed', 'failed'].includes(flow.state);
const overlap = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
// facts (optional Map), filled beside the reasons for display: reason text -> structured fields
// ({code, at, flowId, flowIds, workflow, holds, times}), so a reader formats times and names flows
// without parsing the prose. times lists the exact ISO strings the text embeds. The reasons
// themselves, and every decision made from them, are unchanged.
export function admissionReasons(store, task, { nowMs = Date.now(), policy = store.meta('config', {}).policy ?? {}, modelOverrides, facts, ...overrides } = {}) {
  const fact = (text, fields) => { facts?.set(text, { ...facts.get(text), ...fields }); return text; };
  const seen = {}, reasons = admissionReasonList(store, task, { nowMs, policy, modelOverrides, fact, seen, ...overrides });
  if (facts) {
    // Times a reason may embed, all from records (never parsed out of the text).
    const health = seen.target === undefined ? null : targetHealth(store, seen.target), scheduled = health?.scheduled;
    const known = [task?.notBefore, health?.checkedAt, health?.observedAt, scheduled?.checkedAt, ...heldProviders(store, nowMs).map(p => providerHold(store, p, nowMs)?.until)].filter(value => typeof value === 'string' && Number.isFinite(Date.parse(value)));
    for (const text of reasons) { const times = [...new Set(known.filter(value => text.includes(value)))]; if (times.length) fact(text, { times }); }
  }
  return reasons;
}
function admissionReasonList(store, task, { nowMs, policy, modelOverrides, fact, seen, ...overrides }) {
  const { mainHealthMaxAgeMs = 3600000, recovery = false, categories, requirePaths = false } = { ...policy, ...overrides };
  // Task-kind workflows (carried out by a person or the orchestrator) use their own capacity pool and skip build-only checks.
  // Document workflows write and merge like a change, so they keep path, area and main checks,
  // but count against their own pool, policy.maxDocumentFlows.
  const selection = task && !task.tracked ? workflowAdmission(store, task) : null, taskKind = selection?.kind === 'task', documentKind = selection?.kind === 'document';
  const reasons = [], allFlows = store.live('flow').filter(activeFlow), flows=allFlows.filter(f=>!['planning','maintenance','task'].includes(f.kind)), taskFlows=allFlows.filter(f=>f.kind==='task');
  if (task?.notBefore && nowMs < Date.parse(task.notBefore)) reasons.push(fact(`scheduled: not before ${task.notBefore}`, { code: 'not-before', at: task.notBefore }));
  if (task && !task.tracked) reasons.push(...inputReasons(store.meta('project').root, task));
  if (task?.tracked) reasons.push('tracked item: add a factotum-task brief to the source issue to make it workable');
  { const refusal = upkeepMarkerRefusal(task); if (refusal) reasons.push(fact(refusal, { code: 'upkeep-kind' })); }
  if (!task || task.approvedRevision !== task.revision || task.closed || task.blocked) reasons.push('current approval and open unblocked task required');
  if (store.meta('config', {}).mode === 'delivery' && !(store.meta('commissioning')?.ready && store.meta('commissioning')?.configDigest === store.meta('configDigest'))) reasons.push(fact('project doctor qualification required; run doctor for the current configuration', { code: 'commissioning' }));
  if(task?.source&&task.source.kind!=='command'&&(task.source.repository!==store.meta('config',{}).repository?.slug||task.id!==`${store.meta('config',{}).repository?.issueProfile?.dependencyIdPrefix??'github:'}${task.source.issue}`))reasons.push('source repository or task namespace changed; synchronize before admission');
  if (store.meta('paused') || store.meta('recoveryHold') || store.meta('retentionHold')) reasons.push(fact('project held', { code: 'held', holds: [store.meta('paused') && 'paused', store.meta('recoveryHold') && 'recovery', store.meta('retentionHold') && 'retention'].filter(Boolean) }));
  if (selection) reasons.push(...selection.reasons);
  if (selection?.staleApproval) fact(selection.staleApproval, { code: 'approval-stale', workflow: selection.selected });
  // Durable decisions that hold the build boundary (migrated projects). Merge- and
  // release-only holds do not stop planning; they show on the task and stop delivery.
  if (task && !task.tracked) for (const hold of decisionHolds(store, task.id, task.revision, 'build')) reasons.push(holdReason(hold, 'build'));
  let held; const capacity = () => held ??= slots(store, { policy: { ...policy, ...overrides }, flows: allFlows });
  if (taskKind) { if (taskFlows.length >= (policy.maxTaskFlows ?? 5)) reasons.push('task flow capacity exhausted'); }
  // Change and document slots (operations/capacity.mjs): a flow parked on an answer holds none, up to
  // policy.maxParkedFlows; stopped flows hold theirs; an answered flow waiting for a slot comes first.
  else { const pool = documentKind ? 'document' : 'change', reason = capacityReason(capacity(), pool), row = capacity().pools[pool], ids = flows => flows.map(f => f.id);
    // The flows the reason names, by what they are: stopped, parked beyond the limit, or answered and first in line.
    const ahead = answeredAhead(capacity(), row);
    if (reason) reasons.push(row.stopped.length + row.overflow.length + ahead.length ? fact(reason, { code: 'capacity', pool, flowIds: ids(row.stopped), parkedFlowIds: ids(row.overflow), answeredFlowIds: ids(ahead), maxParkedFlows: capacity().maxParkedFlows }) : reason); }
  // Knowledge upkeep (design 7.6): an upkeep follow-up is admitted only while a parked place is free
  // (policy.maxParkedFlows), so that when it parks on its merge decision it never pushes requested
  // work over the allowance. Upkeep flows are also counted last in the allowance order.
  // With parking off (policy.maxParkedFlows 0) there is never a free place, so no follow-up is
  // admitted: it would hold a slot while it waits on its merge decision (review of 292d317, Q2).
  if (hasUpkeepMarker(task) && !taskKind && capacity().parked.length >= capacity().maxParkedFlows) reasons.push(fact(capacity().maxParkedFlows === 0 ? 'a knowledge upkeep follow-up is admitted only while a parked place is free, and parking is off (policy.maxParkedFlows 0): raise policy.maxParkedFlows to run follow-ups, or decline this one' : `no parked place is free for a knowledge upkeep follow-up (${capacity().parked.length} of ${capacity().maxParkedFlows} in use, policy.maxParkedFlows)`, { code: 'upkeep-parked-place', parked: capacity().parked.length, maxParkedFlows: capacity().maxParkedFlows }));
  const own = allFlows.find(f => f.taskId === task?.id);
  if (own) reasons.push(own.state === 'stopped' ? fact(`task has a stopped flow ${own.id}; resume it, or start again with task.restart`, { code: 'stopped-flow', flowId: own.id }) : 'task already active');
  if (categories && !categories.includes(task?.category)) reasons.push('category not admitted');
  // A category with a limit: flows parked on an answer hold no place in it, like a slot (operations/capacity.mjs).
  if (policy.categoryLimits?.[task?.category] !== undefined) { const reason = categoryReason(capacity(), task.category); if (reason) reasons.push(reason); }
  for (const dependency of task?.dependencies ?? []) {
    const fact=task?.source?.externalDependencies?.find(row=>row.taskId===dependency);
    const custom=task?.source?.kind==='command'?task.source.externalDependencies?.find(row=>row.taskId===dependency):null;
    const settings=task?.source?.kind==='command'?sourceSettings(store.meta('config',{})):null;
    const customClosed=settings?.enabled&&settings.type==='command'&&custom?.state==='closed'&&custom.provenance==='command-issue-state'&&custom.sourceId===settings.id&&task.source.sourceId===settings.id&&task.source.namespace===settings.namespace&&dependency.startsWith(settings.namespace)&&dependency!==task.id&&typeof custom.revision==='string'&&Number.isFinite(Date.parse(custom.observedAt))&&Date.parse(custom.observedAt)<=nowMs;
    const externallyClosed=fact?.state==='closed'&&fact.provenance==='github-issue-state'&&fact.repository===store.meta('config',{}).repository?.slug&&Number.isSafeInteger(fact.issue)&&fact.issue>0&&fact.issue!==task.source.issue&&dependency===`${store.meta('config',{}).repository?.issueProfile?.dependencyIdPrefix??'github:'}${fact.issue}`&&typeof fact.revision==='string'&&Number.isFinite(Date.parse(fact.observedAt))&&Date.parse(fact.observedAt)<=nowMs;
    if (store.get('task', dependency)?.status !== 'completed'&&!externallyClosed&&!customClosed) reasons.push(`dependency incomplete: ${dependency}`);
  }
  // Provider usage-limit hold (readiness G7): a flow whose model steps could only start a
  // held provider is not admitted until the hold clears. The routes checked are the ones the
  // flow would pin: saved defaults, the task's model choice and this run's step overrides
  // (flow.start and task.restart pass them; queue claims have none). An invalid selection or
  // override is refused by admission itself with its own reason, so it skips this check.
  if (task && !task.tracked && store.meta('config', {}).mode === 'delivery' && heldProviders(store, nowMs).length) {
    const key = selection?.selected ?? 'standard', graph = commissionedGraphs(store)[key];
    if (graph) { try { reasons.push(...routeHoldReasons(store, selectFlowModels(store.meta('config', {}), key, graph, modelDefaults(store), modelOverrides ?? {}, task.models ?? {}).modelRoutes, nowMs)); } catch {} }
  }
  // A context task (knowledge upkeep slice 6) runs no model step on a provider the operator has not
  // listed in upkeep.context.qualifiedProviders; admitFlow refuses it again. Judged here so the hold
  // is a reason like any other: on the task, in the queue's eligibility, and passed over by a claim,
  // so it is never retried and refused on every tick (dev.91, O5).
  { const hold = contextProviderHold(store, task, { selection, modelOverrides }); if (hold) reasons.push(fact(hold.reason, { code: 'context-provider', providers: hold.providers })); }
  // A declared provider-configuration change its builder's CLI refuses to write (dev.91, O3).
  { const hold = builderConfigHold(store, task, { selection, modelOverrides }); if (hold) reasons.push(fact(hold.reason, { code: 'builder-config', providers: hold.providers, paths: hold.paths })); }
  if (taskKind) return [...new Set(reasons)];
  let paths = [];
  try { paths = declaredConflictPaths(store, task); } catch { reasons.push('task or reviewed plan conflict scope invalid'); }
  if (requirePaths && !paths.length) reasons.push('planned paths required');
  for (const flow of flows) {
    const other = flow.taskSnapshot ?? store.get('task', flow.taskId);
    if (task?.area && other?.area === task.area) reasons.push(`area occupied: ${task.area}`);
    try {
      const observation = overrides.conflictScope?.get(flow.id);
      assert(!observation?.unavailable, 'conflict evidence unavailable');
      const occupied = observation?.paths ?? activeConflictPaths(store, flow);
      if (paths.some(a => occupied.some(b => overlap(a, b)))) reasons.push(fact(`paths overlap: ${flow.id}`, { code: 'paths-overlap', flowId: flow.id }));
    } catch { reasons.push(`active workspace conflict evidence unavailable: ${flow.id}`); }
  }
  // Each change waits on the health of the branch it targets.
  const target = seen.target = selection?.target ?? targetOf(store, task), health = targetHealth(store, target);
  const sync = pendingTargetSync(store, target);
  if (sync) reasons.push(`${target} health pending: target synchronization in progress (job ${sync.id})`);
  for (const hold of targetSyncHolds(store, target)) reasons.push(`${target} synchronization held: ${hold.reason}`);
  // A merge into the target is decided or running: its head is about to move (operations/merge-hold.mjs).
  const merging = mergesInFlight(store, target);
  if (merging.length) reasons.push(mergeInFlightReason(target, merging));
  if (!(recovery && task?.recovery === true) && (!health || health.status !== 'green' || !Number.isFinite(Date.parse((health.checkedAt ?? health.observedAt))) || nowMs - Date.parse((health.checkedAt ?? health.observedAt)) > mainHealthMaxAgeMs || Date.parse((health.checkedAt ?? health.observedAt)) > nowMs || scheduledTierHold(store.meta('config', {}), health, nowMs))) reasons.push(mainHealthReason(store, { target, nowMs }));
  return [...new Set(reasons)];
}
// The providers a context task would start that are not in upkeep.context.qualifiedProviders, with the
// reason (and remedy) admission gives: null for any other task, or when nothing holds it. The routes are
// the ones its flow would pin (saved defaults, the task's models and this run's overrides), fallbacks
// included, as admitFlow and the provider step check them. An invalid selection is admission's own reason.
export function contextProviderHold(store, task, { selection, modelOverrides } = {}) {
  if (task?.upkeep?.kind !== 'context') return null;
  const pinned = taskRoutes(store, task, { selection, modelOverrides }); if (!pinned) return null;
  const providers = unqualifiedProviders(store.meta('config', {}), pinned.modelRoutes);
  return providers.length ? { providers, reason: `admission: ${contextProviderRefusal(task.id, providers)}` } : null;
}
// The routes a delivery task's flow would pin, with each step's role; null when they cannot be read
// (not delivery, no commissioned graph, or a selection admission refuses with its own reason).
function taskRoutes(store, task, { selection, modelOverrides } = {}) {
  const config = store.meta('config', {});
  if (!task || task.tracked || config.mode !== 'delivery') return null;
  const chosen = selection === undefined ? workflowAdmission(store, task) : selection, key = chosen?.selected ?? 'standard', graph = commissionedGraphs(store)[key];
  if (!graph) return null;
  try { return selectFlowModels(config, key, graph, modelDefaults(store), modelOverrides ?? {}, task.models ?? {}); } catch { return null; }
}
// Provider configuration a builder's own CLI will not write in a factory step (dev.91, O3), as checked
// on Claude Code 2.1.326 and Codex 0.169.0 without a model:
//   - Claude Code under --restricted lets only a person or a permission handler approve writes to
//     tool-configuration files, and a factory step has neither: every write under a `.claude` folder
//     (any depth, any letter case) and to a `.mcp.json` is refused, whatever the allow rules say;
//   - Codex's workspace-write sandbox keeps `.codex` and `.agents` at the top of a writable root read-only.
export const BUILDER_UNWRITABLE = Object.freeze({
  claude: path => { const parts = path.split('/').filter(Boolean).map(part => part.toLowerCase()); return parts.includes('.claude') || parts.at(-1) === '.mcp.json'; },
  codex: path => ['.codex', '.agents'].includes(path.split('/').filter(Boolean)[0]),
});
const OTHER_BUILDER = { claude: 'codex', codex: 'claude' };
// A task that declares provider configuration its builder cannot write is held at admission, with the
// remedy, instead of a build round the builder's CLI refuses: route the builder to the other provider
// (task.models) or make the change by hand.
export function builderConfigHold(store, task, { selection, modelOverrides } = {}) {
  const declared = declaredProviderConfig(task); if (!declared.length) return null;
  const pinned = taskRoutes(store, task, { selection, modelOverrides }); if (!pinned) return null;
  const refused = new Map();
  for (const [step, route] of Object.entries(pinned.modelRoutes)) {
    if (pinned.modelSelection.steps[step]?.role !== 'builder') continue;
    for (const provider of [route.provider, ...(route.allowFallback && route.fallback ? [route.fallback.provider ?? route.provider] : [])]) {
      const paths = declared.filter(path => BUILDER_UNWRITABLE[provider]?.(path)); if (paths.length) refused.set(provider, [...new Set([...(refused.get(provider) ?? []), ...paths])]);
    }
  }
  if (!refused.size) return null;
  const why = { claude: 'Claude Code refuses writes under .claude and to .mcp.json in a factory step: only a person or a permission handler may approve them, and a factory step has neither', codex: 'Codex\'s sandbox keeps .codex and .agents at the top of the worktree read-only' };
  const rows = [...refused].map(([provider, paths]) => `its builder on ${provider} cannot write ${paths.join(', ')} (${why[provider]})`);
  const other = [...refused.keys()].length === 1 ? OTHER_BUILDER[[...refused.keys()][0]] : null;
  return { providers: [...refused.keys()], paths: [...new Set([...refused.values()].flat())],
    reason: `admission: task ${task.id} declares provider configuration that ${rows.join('; and ')}. ${other ? `Route this task's builder to ${other} (task.models with builder set to a configured ${other} model), or make the change yourself` : 'No builder can make this change: split the task, or make the change yourself'}` };
}
// admit must synchronously persist the new flow using the supplied Store, without opening another transaction.
// exclude: task IDs this claim must pass over (tasks refused at final admission earlier in the same tick).
export function claimCandidate(store, { taskId, exclude = new Set(), policy = store.meta('config', {}).policy ?? {}, nowMs = Date.now(), admit }) {
  assert(typeof admit === 'function', 'admission callback required');
  // Choosing a candidate observes the active workspaces (four Git reads each). That is done
  // before the transaction, so the database's write lock is not held across Git, and only
  // when a queued task needs it. The claim below still judges its task against a fresh
  // observation inside the transaction; a task queued meanwhile is observed there too.
  const conflictScope = taskId || !orderedQueue(store, policy).length ? new Map() : captureConflictScope(store);
  return store.tx(() => {
    taskId ??= orderedQueue(store, policy).find(q => !exclude.has(q.id) && admissionReasons(store, store.get('task', q.id), { policy, nowMs, conflictScope }).length === 0)?.id;
    if (!taskId) return null;
    const task = store.get('task', taskId), queue = store.get('queue', taskId);
    // A refusal names the task it was for, so the tick can say which queued task it could not start.
    let flow; try {
      assert(queue?.status === 'queued', 'task not queued');
      const reasons = admissionReasons(store, task, { policy, nowMs }); assert(!reasons.length, reasons.join('; '));
      flow = admit(task, store);
    } catch (error) { if (error && typeof error === 'object') error.taskId ??= taskId; throw error; }
    assert(flow?.id && store.get('flow', flow.id), 'admit must persist a flow');
    assert(!flow.then, 'admission callback must be synchronous');
    store.put('queue', { ...recordQueueAdmission(store, queue, flow, { nowMs }), status: 'claimed', flowId: flow.id, claimedAt: now() });
    store.event('queue.claimed', { taskId, flowId: flow.id }); return flow;
  });
}
