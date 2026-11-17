import { cliCommand } from '../core/install-layout.mjs';
import { LIVE_SETTINGS, applyLiveChanges, liveValue } from './live-settings.mjs';
import { DELEGABLE } from '../core/delegation.mjs';
import { delegatedOperations } from '../core/delegation.mjs';
import { nodeContract } from '../core/operations.mjs';
import { modelSettingsVersion, modelSettingsView } from './model-settings.mjs';
const hint = compute => { try { return compute(); } catch { return []; } };
import { digest } from '../core/contracts.mjs';
import { orchestratorSessionView } from './orchestrator-session.mjs';
import { heldProviders } from './provider-limits.mjs';
import { defaultMaxTurns } from '../adapters/providers/routes.mjs';
import { UPKEEP_MODES, learningsSettings, upkeepAuthorityChanges, upkeepBlockProblem, upkeepMode, upkeepOn, upkeepSettings } from '../core/upkeep-config.mjs';
import { LEARNING_DELIVERY_MIN_RATE, LEARNING_DELIVERY_WINDOW, learningDelivery, learningsStoreStatus, namespaceCollisionReasons, upkeepSuspensions } from './upkeep-records.mjs';
import { FINDING_REOPENABLE, candidateView, isUpkeepCandidate } from './upkeep-candidates.mjs';
import { CAPTURE_TASK_KINDS, UPKEEP_TASK_APPROVAL_MS, captureBlocked, captureProblems, contextBlocked, openCaptureTask, openContextTask, openDocsFollowUp, taskCeilingRefusal, upkeepTaskBudget } from './upkeep-tasks.mjs';
import { checkScripts } from './upkeep-capture.mjs';
import { proposalAcceptanceView, withheldText } from './upkeep-context.mjs';
import { upgradeOwned } from '../core/install-layout.mjs';
import { upkeepRouteView } from './upkeep-route.mjs';
import { contextProviderHold } from './admission.mjs';
import { invocationShareStanding } from './upkeep-ceilings.mjs';
// What the Health tab shows of knowledge upkeep: what is suspended and why, and the open
// candidates with the limits they wait under. Invocation totals are in Stats. `findings` is the
// open findings the caller has already read for its own list (the dashboard's open and recent
// findings, the snapshot's live set), so the view reads no finding itself and answers the same
// whatever the record layout: both callers read the whole kind only where they already did
// before upkeep existed. The candidates are bounded by the caps. Its own reads are by key and
// bounded: while upkeep is on, the window row and seven upkeepDay rows for the share (dev.93, Q5);
// while it proposes, seven more for the task budget; and the open upkeep tasks by key.
export const UPKEEP_HEALTH_CANDIDATES = 60, UPKEEP_HEALTH_CLOSED = 20;
export function upkeepHealthView(store, { nowMs = Date.now(), findings } = {}) {
  if (!Array.isArray(findings)) throw new Error('upkeepHealthView takes the open findings its caller read');
  const settings = upkeepSettings(store.meta('config', {}));
  // Model-written text that fails the text rules (6.5, confusables included) is withheld, never shown
  // (slice 6 precondition): a row recorded before a rule existed may hold some. `withheld` names it.
  const shown = row => withheldText(candidateView(row, nowMs));
  const open = findings.filter(row => row?.status === 'unapproved' && isUpkeepCandidate(row)).map(shown);
  // Slice 5 part B: tasked candidates, with their task, and closed ones that a person may reopen,
  // as far as the caller read them (the dashboard reads the recently tasked and closed findings).
  const newest = list => list.sort((a, b) => String(b.statusAt ?? '').localeCompare(String(a.statusAt ?? '')));
  const tasked = newest(findings.filter(row => row?.status === 'tasked' && isUpkeepCandidate(row))).map(shown);
  const closed = newest(findings.filter(row => FINDING_REOPENABLE.includes(row?.status) && isUpkeepCandidate(row))).map(shown);
  // The open docs follow-up, read by key, with when it expires if it is still not approved (4.3).
  const task = openDocsFollowUp(store), created = Date.parse(task?.createdAt ?? '');
  const followUp = task ? { taskId: task.id, title: task.title, revision: task.revision, approved: task.approvedRevision === task.revision, createdAt: task.createdAt ?? null, expiresAt: task.approvedRevision !== task.revision && Number.isFinite(created) ? new Date(created + UPKEEP_TASK_APPROVAL_MS).toISOString() : null, candidates: (task.findings ?? []).length, files: task.paths ?? [] } : null;
  // Slice 6: each open governing-context proposal with the digest the operator signs when accepting
  // it and why it cannot be accepted now; the open context task; and, before accepting, how many
  // unfinished flows have a reviewed plan (10.2): a merged context change makes such a flow replan
  // if it needs another build round once it integrates the new target (10.4). The flows are read
  // through their live set only while a proposal is open.
  // Slice 7: a rule is accepted as a proposal is, with its digest; a check or learning candidate shows
  // why it cannot be accepted under this configuration, and for a check the scripts the fast checks
  // name (from their argv; the files are read at the target head when a person accepts).
  const config = store.meta('config', {}), proposals = open.filter(row => ['context', 'rule'].includes(row.kind));
  const rowsOf = kinds => new Map(findings.filter(row => row?.status === 'unapproved' && isUpkeepCandidate(row) && kinds.includes(row.kind)).map(row => [row.id, row]));
  if (proposals.length) {
    let owned = null; try { owned = upgradeOwned(store.meta('project')?.root); } catch { owned = null; }
    const rows = rowsOf(['context', 'rule']);
    // What refuses the acceptance now (dev.92, P2), as the command judges it: an open context task,
    // the mode, a hold, a suspension, the open-task limit. Never the task ceilings: only the operator
    // accepts a proposal, directly, and they do not limit that.
    const now = { context: blockedNow(() => contextBlocked(store, { settings, nowMs })), rule: blockedNow(() => contextBlocked(store, { settings, nowMs, rules: true })) };
    for (const view of proposals) { const shown = proposalAcceptanceView(rows.get(view.id), { config, owned }), why = now[view.kind]; Object.assign(view, { acceptance: { ...shown, problems: [...shown.problems, ...(why ? [`not now: ${why}`] : [])] } }); }
  }
  // Slice 8: a stale learning (raised by learnings.check) is accepted the same way, into a task
  // that deletes exactly that learning file.
  const captures = open.filter(row => ['check', 'learning', 'learning-stale'].includes(row.kind));
  if (captures.length) {
    const rows = rowsOf(['check', 'learning', 'learning-stale']), scripts = checkScripts(config).map(row => ({ checkId: row.checkId ?? null, script: row.script ?? null, why: row.why ?? null }));
    // dev.92, P2: `problems` is what refuses the operator's own direct acceptance, which the task
    // ceilings never limit; `delegatedProblems` what refuses an acceptance by the orchestrator (on an
    // instruction, by delegation or under a grant), which names the ceiling, with when it resets,
    // once the factory's room is used up. Judged as the command judges it, without writing.
    const KIND = { check: 'check', learning: 'learning-add', 'learning-stale': 'learning-retire' };
    for (const view of captures) {
      const kind = KIND[view.kind], own = captureProblems(rows.get(view.id), { config }), direct = blockedNow(() => captureBlocked(store, { kind, settings, nowMs, direct: true })), delegated = blockedNow(() => captureBlocked(store, { kind, settings, nowMs }));
      const problems = [...own, ...(direct ? [`not now: ${direct}`] : [])];
      Object.assign(view, { acceptance: { problems, delegatedProblems: [...problems, ...(delegated && delegated !== direct ? [`not now: ${delegated}`] : [])], ...(view.kind === 'check' ? { scripts } : {}) } });
    }
  }
  let reviewedPlans = null;
  if (proposals.length) { try { reviewedPlans = store.live('flow').filter(flow => !['completed', 'failed'].includes(flow.state) && flow.kind !== 'maintenance' && flow.results?.plan && flow.results?.['plan-review']).length; } catch { reviewedPlans = null; } }
  // Where the open context task stands (dev.91, O5): queued or running, and, while it waits, the
  // providers that hold it (the same reason admission gives), so Health never reads as if it were free.
  const contextTask = openContextTask(store), contextView = contextTask ? { taskId: contextTask.id, title: contextTask.title, revision: contextTask.revision, approved: contextTask.approvedRevision === contextTask.revision, candidates: (contextTask.findings ?? []).length, files: contextTask.paths ?? [], ...contextTaskState(store, contextTask) } : null;
  const captureTasks = CAPTURE_TASK_KINDS.map(kind => openCaptureTask(store, kind)).filter(Boolean).map(task => ({ kind: task.upkeep.kind, taskId: task.id, title: task.title, revision: task.revision, approved: task.approvedRevision === task.revision, files: task.paths ?? [] }));
  return { mode: settings.mode, suspensions: Object.values(upkeepSuspensions(store)).sort((a, b) => String(a.at).localeCompare(String(b.at))), candidates: open.slice(0, UPKEEP_HEALTH_CANDIDATES), candidateCount: open.length,
    tasked: tasked.slice(0, UPKEEP_HEALTH_CANDIDATES), taskedCount: tasked.length, closed: closed.slice(0, UPKEEP_HEALTH_CLOSED), closedCount: closed.length, followUp,
    contextTask: contextView, captureTasks, reviewedPlans, qualifiedProviders: settings.context.qualifiedProviders, learnings: learningsView(store, config),
    limits: { docs: settings.docs.maxWaiting, context: settings.context.maxOpen, capture: settings.capture.maxOpen }, taskBudget: settings.mode === 'propose' ? taskBudgetView(store, { settings, nowMs }) : null,
    invocationShare: settings.mode === 'off' ? null : shareView(store, { nowMs }) };
}
// Why an acceptance is refused now, or null; a reason that cannot be judged is one.
const blockedNow = judge => { try { return judge(); } catch (error) { return `it cannot be judged now (${error.message})`; } };
// The upkeep task ceilings (dev.92, P2): per window what was created and by the operator, the room
// left, and when it returns. `refusal` says why a factory-made task or a delegated acceptance is
// refused now; an operator's direct acceptance never is. Seven upkeepDay rows by key, read only while
// upkeep proposes: in any other mode nothing is created or accepted, so the budget reads none.
function taskBudgetView(store, { settings, nowMs }) {
  try { const budget = upkeepTaskBudget(store, { settings, nowMs }); return { ...budget, refusal: taskCeilingRefusal(budget) }; } catch { return null; }
}
// Where the share-of-invocations ceiling stands (dev.93, Q5), while upkeep is on: the ceiling
// judges it in observe mode too. The window row and seven upkeepDay rows, each by key (eight bounded
// reads, decided after the review of e58abd1). Off, nothing is counted and nothing is read. Null when
// it cannot be read.
function shareView(store, { nowMs }) { try { return invocationShareStanding(store, { nowMs }); } catch { return null; } }
function contextTaskState(store, task) {
  const flow = store.by('flow', 'taskId', task.id).find(row => !['completed', 'failed'].includes(row.state)) ?? null, queued = store.get('queue', task.id)?.status === 'queued';
  let hold = null; if (!flow) { try { hold = contextProviderHold(store, task); } catch { hold = null; } }
  return { queued, flow: flow ? { id: flow.id, state: flow.state } : null, autoQueue: store.meta('config', {}).policy?.autoQueue === true, providerHold: hold ? { providers: hold.providers, reason: hold.reason.replace(/^admission: /, '') } : null };
}
// What the project would answer to each change of knowledge upkeep's mode, so that the console
// refuses exactly what the project refuses and offers what it accepts. Each answer is judged on the
// configuration that would result, with the functions settings.update itself uses: the live change
// applied, the blocks validated, and, where the result turns upkeep on, the reserved namespace
// looked at (a bounded read of a declared index). `problem` says why the stored block is not one
// this release accepts; upkeep then reads as off, and a change that leaves it invalid is refused.
// A read model answers the same whatever the record layout, and upkeep never reads a whole kind in
// place of its index: while the task kind is not verified this view names no namespace blocker,
// and the project itself still refuses to turn upkeep on, with that reason.
// Slice 8, after the review of b46da01: the learnings store as the last learnings.check read it,
// with each refused file and why (Q2), and the delivery measurements of 14.3 with its suspension
// (Q7). Two meta reads. Null when no learnings directory is configured and nothing was recorded.
function learningsView(store, config) {
  const dir = learningsSettings(config).dir, delivery = learningDelivery(store), checked = learningsStoreStatus(store);
  if (!dir && !checked && !delivery.selected && !delivery.suspended) return null;
  return { dir, delivery: { selected: delivery.window.selected, cited: delivery.window.cited, rate: delivery.rate, since: delivery.since.at, total: { selected: delivery.selected, cited: delivery.cited }, window: LEARNING_DELIVERY_WINDOW, minimumRate: LEARNING_DELIVERY_MIN_RATE, stopped: delivery.suspended }, store: checked };
}
function upkeepView(store, config) {
  let collisions;
  const blocked = () => { if (collisions === undefined) { try { collisions = namespaceCollisionReasons(store).map(reason => `knowledge upkeep cannot be turned on: ${reason}`); } catch { collisions = []; } } return collisions; };
  const refusal = value => {
    let next; try { next = applyLiveChanges(config, { 'upkeep.mode': value }); } catch (error) { return [error.message]; }
    const invalid = upkeepBlockProblem(next); if (invalid) return [invalid];
    return upkeepOn(next) && upkeepAuthorityChanges(config, next).turnedUp ? blocked() : [];
  };
  // The route the assessment runs on, pinned when upkeep was turned on (operations/upkeep-route.mjs).
  return { mode: upkeepMode(config), problem: upkeepBlockProblem(config), route: upkeepRouteView(store, config), refused: { ...Object.fromEntries(UPKEEP_MODES.map(value => [value, refusal(value)])), reset: refusal(null) } };
}

// Read-only presentation projections for the project service. They describe
// canonical records; they never grant authority or replace command validation.

const elapsed = (start, end) => {
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : null;
};
const finished = flow => ['completed', 'failed'].includes(flow.state) || (flow.state === 'stopped' && flow.finishedAt);
export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b), count = sorted.length;
  if (!count) return { count: 0, totalMs: 0, meanMs: null, medianMs: null, p90Ms: null, minMs: null, maxMs: null };
  const rank = q => sorted[Math.min(count - 1, Math.max(0, Math.ceil(q * count) - 1))];
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return { count, totalMs, meanMs: totalMs / count, medianMs: rank(0.5), p90Ms: rank(0.9), minMs: sorted[0], maxMs: sorted[count - 1] };
}
const countBy = (rows, key) => rows.reduce((out, row) => { const value = key(row) ?? 'unknown'; out[value] = (out[value] ?? 0) + 1; return out; }, {});
const primitive = value => ['string', 'number', 'boolean'].includes(typeof value);
const policyFields = new Set(['delegateIntegrationDecisions','queueOnApproval','planning','autoQueue','maxBuildRounds','maxFlows','maxActiveFlows','maxParkedFlows','autoMerge','allowFactoryEdits','mainHealthMaxAgeMs','scheduledHealthMaxAgeMs','mainProbeMs','deferLowFindings','followTarget','mainInfrastructureRetries','recovery','requirePaths','queueRanking','reviewProtocol','ordinaryReviewRounds','ordinaryFollowupAfter','strictDecisionRole','mergeDecisionRole','planReviewProtocolCorrections']);

/** Workflow node order by first reachability from the start node; unreachable nodes follow in declaration order. */
export function workflowOrder(workflow) {
  const nodes = workflow?.nodes ?? {}, order = [], seen = new Set(), queue = [workflow?.start].filter(Boolean);
  while (queue.length) {
    const key = queue.shift();
    if (seen.has(key) || !Object.hasOwn(nodes, key)) continue;
    seen.add(key); order.push(key);
    const node = nodes[key];
    queue.push(...[node.next, ...Object.values(node.resultEdges ?? {}), ...Object.values(node.answers ?? {}), node.onFailure].filter(Boolean));
  }
  for (const key of Object.keys(nodes)) if (!seen.has(key)) order.push(key);
  // Terminal nodes read best after the working path.
  order.sort((a, b) => (nodes[a].kind === 'end') - (nodes[b].kind === 'end'));
  return order.map(key => {
    const node = nodes[key];
    return { id: key, kind: node.kind, ...(node.action?.operation ? { operation: node.action.operation } : {}), ...(node.outcome ? { outcome: node.outcome } : {}), ...(node.kind === 'question' ? { question: node.question, role: node.role } : {}), ...(nodeContract(key, node).heavy ? { heavy: true } : {}) };
  });
}

const providerSettings=(value,{fallback=true}={})=>({
  provider:typeof value?.provider==='string'?value.provider:null,model:typeof value?.model==='string'?value.model:null,billingMode:value?.billingMode==='subscription'||value?.billingMode===undefined?'subscription':'unsupported',
  ...(Number.isSafeInteger(value?.maxTurns)?{maxTurns:value.maxTurns}:{}),...(typeof value?.effort==='string'?{effort:value.effort}:{}),
  ...(Array.isArray(value?.allowedModels)?{allowedModels:value.allowedModels.filter(item=>typeof item==='string')}:{}),
  ...(typeof value?.allowFallback==='boolean'?{allowFallback:value.allowFallback}:{}),
  ...(fallback&&value?.fallback?{fallback:providerSettings(value.fallback,{fallback:false})}:{})
});
// Pinned policy settings (changed through config update) and their defaults when unset.
const PINNED_POLICY = { planning: true, followTarget: true, maxBuildRounds: 4, reviewProtocol: 'fresh-full', ordinaryReviewRounds: 4, ordinaryFollowupAfter: 3, deferLowFindings: true, planReviewProtocolCorrections: 1, mergeDecisionRole: 'operator', strictDecisionRole: 'operator', autoMerge: false, delegateIntegrationDecisions: false, allowFactoryEdits: false, requirePaths: false, recovery: false, mainInfrastructureRetries: 0 };
/** Settings without credentials, private endpoints or absolute paths. Check commands are shown read-only. */
export function settingsView(store) {
  const project = store.meta('project'), config = store.meta('config', {}), configDigest = store.meta('configDigest'), commissioning = store.meta('commissioning');
  const repository = config.repository;
  const check = ({ id, timeoutMs, argv, retrySafe, reuseMaxAgeMs, flakePolicy, holdExitCodes, tier }) => ({ id, timeoutMs, ...(typeof tier === 'string' ? { tier } : {}), commandDigest: Array.isArray(argv) ? digest(argv) : null, ...(Array.isArray(argv) ? { command: argv.filter(x => typeof x === 'string') } : {}), ...(typeof retrySafe==='boolean'?{retrySafe}:{}), ...(Number.isSafeInteger(reuseMaxAgeMs)?{reuseMaxAgeMs}:{}), ...(holdExitCodes?{holdExitCodes:[...holdExitCodes]}:{}),...(flakePolicy?{flakePolicy:{retries:flakePolicy.retries,expiresAt:flakePolicy.expiresAt,exitCodes:flakePolicy.exitCodes,trackingDigest:digest(flakePolicy.trackingRef)}}:{}) });
  const flows = store.live('flow');
  return {
    mode: config.mode ?? 'rehearsal', supervisor: project.supervisor, createdAt: project.createdAt ?? null,
    // The project's CLI as typed from its repository root, under its install prefix.
    cli: cliCommand(project.root),
    configDigest: configDigest ?? null, workflowDigest: store.meta('workflowDigest') ?? null,
    repository: repository ? Object.fromEntries(['slug', 'account', 'hostname', 'target', 'remote', 'checkContext', 'closeTasks', 'adoptionNotice', 'mergeMethod', 'rerunFailedChecks', 'rerunWaitMs'].filter(key => primitive(repository[key])).map(key => [key, repository[key]])) : null,
    // defaultMaxTurns: the turn limit a Claude step of this role gets when its route sets none (dev.84).
    providers:Object.fromEntries(Object.entries(config.providers??{}).map(([role,value])=>[role,{...providerSettings(value),defaultMaxTurns:defaultMaxTurns(role)}])),
    stepModels:hint(()=>modelSettingsView(store)), modelSettingsVersion:modelSettingsVersion(store),
    workflows:Object.values(store.meta('catalog')?.workflows??{}).map(({name,kind,source,workflow,target})=>({name,kind:kind??'change',source:source?.reference??source?.path??null,target:target??repository?.target??null,steps:workflowOrder(workflow)})),
    syncTargets:(repository?.syncTargets??[]).map(({from,into})=>({from,into})),
    workflowSelection:store.meta('catalog')?.selection??null,
    live:Object.fromEntries(Object.entries(LIVE_SETTINGS).map(([path,row])=>{const [a,b]=path.split('.'),set=config?.[a]?.[b]!==undefined;return [path,{value:liveValue(config,path),isDefault:!set,type:row.type,...(row.options?{options:row.options}:{}),...(row.operatorOnly?{operatorOnly:true}:{})}];})),
    pinned:Object.fromEntries(Object.entries(PINNED_POLICY).map(([key,value])=>[key,{value:config.policy?.[key]??value,isDefault:config.policy?.[key]===undefined}])),
    delegable:[...DELEGABLE],
    upkeep: upkeepView(store, config),
    doctorRequest:store.meta('doctorRequest')??null,
    delegatedOperations:delegatedOperations(config),delegationDefault:config.policy?.delegatedOperations===undefined,
    modelCoauthor:config.workspace?.modelCoauthor?{name:typeof config.workspace.modelCoauthor.name==='string'?config.workspace.modelCoauthor.name:null,email:typeof config.workspace.modelCoauthor.email==='string'?config.workspace.modelCoauthor.email:null}:null,
    checks: (config.checks ?? []).map(check), mainChecks: (config.mainChecks ?? []).map(check),
    ...(config.fastChecks ? { fastChecks: { heavy: config.fastChecks.heavy === true, checks: config.fastChecks.checks.map(row => ({ ...check(row), rules: [...(row.rules ?? [])] })) } } : {}),
    contextFiles: config.context ? { maxChars: config.context.maxChars ?? null, files: (config.context.files ?? []).map(file => ({ id: file.id, path: file.path, required: file.required === true, ...(Array.isArray(file.paths) ? { paths: file.paths.filter(primitive) } : {}) })) } : null,
    policy: Object.fromEntries(Object.entries(config.policy ?? {}).filter(([key, value]) => policyFields.has(key) && primitive(value))),
    queuePolicy: { ranking:config.policy?.queueRanking===true, categoryOrder:config.policy?.categoryOrder??[], categoryLimits:config.policy?.categoryLimits??{} },
    qualification: config.qualification ? Object.fromEntries(Object.entries(config.qualification).filter(([key, value]) => ['qualified','targetFreshness'].includes(key) && primitive(value))) : null,
    resources: { pools:Object.fromEntries(Object.entries(config.resources?.pools??{}).map(([name,pool])=>[name,Object.fromEntries(['capacity','maxLoadAverage','minAvailableMemoryBytes'].filter(key=>primitive(pool[key])).map(key=>[key,pool[key]]))])), operations:Object.fromEntries(Object.entries(config.resources?.operations??{}).map(([name,request])=>[name,{resource:request.resource,weight:request.weight}])), coordinatorConfigured: Boolean(config.resources?.coordinatorPath), backupConfigured: Boolean(config.backupRoot), workspaceSetupSteps: config.workspace?.setup?.length ?? 0 },
    commissioning: commissioning ? {
      ready: commissioning.ready === true, checkedAt: commissioning.checkedAt ?? null, current: commissioning.configDigest === configDigest,
      reasons: (commissioning.reasons ?? []).filter(primitive),
      providers: Object.fromEntries(Object.entries(commissioning.providers ?? {}).map(([role, value]) => [role, { provider: value?.provider ?? null, model: value?.model ?? null, version: value?.version ?? null, ready: value?.ready === true }])),
    } : null,
    commissioningRequired: (config.mode ?? 'rehearsal') === 'delivery' && !(commissioning?.ready && commissioning.configDigest === configDigest),
    activeFlows: flows.filter(flow => !['completed', 'failed'].includes(flow.state)).length,
    holds: { paused: store.meta('paused') === true, recoveryHold: store.meta('recoveryHold') === true, moneyHold: store.meta('moneyHold', false) === true, retentionHold:Boolean(store.meta('retentionHold')), providerHolds:heldProviders(store) },
    workflow: { start: store.meta('workflow')?.start ?? null, steps: workflowOrder(store.meta('workflow')) },
  };
}

/** Observed delivery statistics with explicit sample counts and coverage. Absence is never treated as zero time. */
export function observedStats(store, { nowMs = Date.now() } = {}) {
  const flows = store.all('flow'), attempts = store.stored('attempt'), waits = store.all('wait'), inbox = store.all('inbox');
  const config = store.meta('config', {});
  const times = [...flows.flatMap(f => [f.createdAt, f.finishedAt]), ...attempts.flatMap(a => [a.createdAt, a.settledAt]), ...waits.flatMap(w => [w.startedAt, w.endedAt])].filter(value => Number.isFinite(Date.parse(value))).sort();
  const eventCounts = Object.fromEntries(store.db.prepare("SELECT type, count(*) AS count FROM events WHERE type IN ('flow.stopped','flow.resumed','attempt.reconciled','attempt.external-observation','flow.replan','inbox.answered','inbox.expired','command.rejected','command.completed') GROUP BY type").all().map(row => [row.type, row.count]));
  const ended = flows.filter(finished), timed = ended.filter(flow => elapsed(flow.createdAt, flow.finishedAt) !== null);
  const steps = [...new Set(attempts.map(attempt => attempt.step))];
  const attemptTime = attempt => elapsed(attempt.receipt?.startedAt, attempt.receipt?.endedAt);
  const perFlowStep = countBy(attempts, attempt => `${attempt.flowId}\u0000${attempt.step}`);
  const retries = Object.entries(perFlowStep).filter(([, count]) => count > 1);
  const samples = store.all('machineSample');
  const permits = samples.map(row => row.capacity?.availableChangePermits).filter(Number.isFinite);
  const latestSample = samples.map(row => ({ observedAt: row.observedAt ?? row.capacity?.observedAt, loadAverage: row.loadAverage, memoryBytes: row.memoryBytes, capacity: row.capacity })).filter(row => row.observedAt).sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))[0] ?? null;
  const money = store.all('money'), regressions = store.all('regression');
  const day = value => new Date(value).toISOString().slice(0, 10);
  const daily = {};
  for (const flow of ended) if (Number.isFinite(Date.parse(flow.finishedAt))) { const key = day(flow.finishedAt); daily[key] ??= { completed: 0, failed: 0, stopped: 0 }; daily[key][flow.state] = (daily[key][flow.state] ?? 0) + 1; }
  const providerModes = Object.values(config.providers ?? {}).map(value => value?.billingMode ?? 'subscription');
  return {
    observedAt: new Date(nowMs).toISOString(), synthetic: (config.mode ?? 'rehearsal') !== 'delivery',
    range: { from: times[0] ?? null, to: times.at(-1) ?? null },
    flows: { total: flows.length, byState: countBy(flows, flow => flow.state), byKind: countBy(flows, flow => flow.kind), finished: ended.length, active: flows.length - ended.length },
    outcomes: { completed: flows.filter(f => f.state === 'completed').length, failed: flows.filter(f => f.state === 'failed').length, stopped: flows.filter(f => f.state === 'stopped').length, mergedChanges: flows.filter(f => f.kind === 'change' && f.state === 'completed' && f.results?.merge?.merged).length, acceptedExistingOutcomes: flows.filter(f => f.kind === 'change' && f.state === 'completed' && f.results?.['satisfied-record']?.proven).length },
    flowDuration: { ...distribution(timed.map(flow => elapsed(flow.createdAt, flow.finishedAt))), missing: ended.length - timed.length, byKind: Object.fromEntries([...new Set(timed.map(f => f.kind))].map(kind => [kind, distribution(timed.filter(f => f.kind === kind).map(f => elapsed(f.createdAt, f.finishedAt)))])) },
    phases: steps.map(step => { const rows = attempts.filter(a => a.step === step), values = rows.map(attemptTime).filter(v => v !== null); return { step, attempts: rows.length, missing: rows.length - values.length, byStatus: countBy(rows, a => a.status), ...distribution(values) }; }),
    attempts: { total: attempts.length, byStatus: countBy(attempts, a => a.status), unsettled: attempts.filter(a => !a.settledAt).length, uncertain: attempts.filter(a => a.status === 'uncertain').length },
    retries: { repeatedSteps: retries.length, extraAttempts: retries.reduce((sum, [, count]) => sum + count - 1, 0), flowsWithRetries: new Set(retries.map(([key]) => key.split('\u0000')[0])).size, byStep: countBy(retries.flatMap(([key, count]) => Array(count - 1).fill(key.split('\u0000')[1])), step => step) },
    waits: Object.fromEntries([...new Set(waits.map(w => w.kind))].map(kind => { const rows = waits.filter(w => w.kind === kind), closed = rows.filter(w => elapsed(w.startedAt, w.endedAt) !== null); return [kind, { ...distribution(closed.map(w => elapsed(w.startedAt, w.endedAt))), open: rows.filter(w => !w.endedAt).length, oldestOpenAt: rows.filter(w => !w.endedAt).map(w => w.startedAt).sort()[0] ?? null, byReason: countBy(closed, w => w.reason ?? 'ended') }]; })),
    intervention: { questions: inbox.length, answered: inbox.filter(i => i.status === 'answered').length, answeredByPolicy: inbox.filter(i => i.status === 'answered' && i.autoMerge).length, expired: inbox.filter(i => i.status === 'expired').length, open: inbox.filter(i => i.status === 'open').length, stops: eventCounts['flow.stopped'] ?? 0, resumes: eventCounts['flow.resumed'] ?? 0, replans: eventCounts['flow.replan'] ?? 0, reconciliations: (eventCounts['attempt.reconciled'] ?? 0) + (eventCounts['attempt.external-observation'] ?? 0), rejectedCommands: eventCounts['command.rejected'] ?? 0, completedCommands: eventCounts['command.completed'] ?? 0 },
    orchestratorSession: orchestratorSessionView(store),
    capacity: { samples: samples.length, meanAvailableChangePermits: permits.length ? permits.reduce((a, b) => a + b, 0) / permits.length : null, latest: latestSample, buildLimit: config.policy?.maxFlows ?? 1 },
    cost: { unit: 'USD_MICRO', attemptActualMicros: attempts.reduce((sum, a) => sum + (a.costMicros ?? 0), 0), attemptsWithRecordedCost: attempts.filter(a => Number.isSafeInteger(a.costMicros)).length, attemptsWithoutSettlement: attempts.filter(a => !a.settledAt).length, reservations: { total: money.length, byStatus: countBy(money, row => row.status), actualMicros: money.reduce((sum, row) => sum + (row.actualMicros ?? 0), 0) }, billingModes: countBy(providerModes, mode => mode), subscriptionSemantics: 'Subscription-backed provider runs record zero incremental metered cost; this is not the subscription price or a share of it.' },
    regressions: { reported: regressions.length, affectedFlows: new Set(regressions.map(row => row.flowId)).size, mergedFlows: flows.filter(f => f.results?.merge?.merged).length, attribution: 'Operator reports linked to a known merged flow; never inferred from later failures.' },
    daily: Object.entries(daily).sort(([a], [b]) => a.localeCompare(b)).slice(-30).map(([date, counts]) => ({ date, ...counts })),
    coverage: { flowsWithoutTimestamps: ended.length - timed.length, attemptsWithoutReceiptTiming: attempts.filter(a => a.settledAt && attemptTime(a) === null).length, events: store.db.prepare('SELECT count(*) AS count FROM events').get().count },
    limitations: ['Durations are wall-clock spans between persisted timestamps, including waits; they are not productive time.', 'Missing timing is reported as missing, never as zero.', 'Counts are correlations of recorded outcomes; they do not establish causes.'],
  };
}
