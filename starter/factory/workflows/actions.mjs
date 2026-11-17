import { NO_PLANTED_COMMANDS } from '../core/git-options.mjs';
import { targetHealth, targetHealthVersion, targetSyncHolds } from '../operations/targets.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, digest } from '../core/contracts.mjs';
import { repositoryIdentity } from '../core/repository.mjs';
import { mergeDecisionRole, riskSummary, verifyStrictDecision } from '../core/risk.mjs';
import { assembleContext, governingContextChange, governingContextMessage } from '../operations/index.mjs';
import { BEFORE_WORKSPACE, assertGoverningBoundary, assertGoverningEditsAllowed, assertGoverningEditsApproved, comparisonCommit, governingEditSnapshot, hasGoverningEdits } from '../operations/governance-edit.mjs';
import { upgradeOwned } from '../core/install-layout.mjs';
import { assertCheckScriptsApproved } from '../core/upkeep-namespace.mjs';
import { withRefusalNotice } from './refusal-notice.mjs';
import { nodeContract } from '../core/operations.mjs';
import { flowWorkflowKey, modelRole } from '../core/step-models.mjs';
import { heldProviders } from '../operations/provider-limits.mjs';
import { carriedQuestions, carriedOverflow } from '../core/worker-questions.mjs';
import { VerifiedObjects } from '../core/verified-git.mjs';
import { upkeepSuspensions } from '../operations/upkeep-records.mjs';
import { learningsSettings } from '../core/upkeep-config.mjs';
import { LEARNING_BOUNDARY_OPERATIONS, LEARNING_ROLES, learningSelection, pinnedLearningItems, readLearningStore, selectLearnings } from '../operations/learnings.mjs';
import { flowReviewBar } from '../core/review-bar.mjs';
import { citableRecords, CITABLE_RECORD_LIMIT } from './must-fix.mjs';
import { cycleBudget } from '../core/must-fix-budget.mjs';

export function workingRoot(store, flow) {
  if (flow.workspace?.path) {
    if (existsSync(flow.workspace.path)) return flow.workspace.path;
    assert((nodeContract(flow.step, flow.workflow?.nodes?.[flow.step]).operation === 'workspace.release' && (flow.results?.merge?.merged || flow.results?.['satisfied-record']?.proven)) || flow.results?.cleanup?.released === true, 'owned workspace missing; reconcile without editing the root checkout');
  }
  return store.meta('project').root;
}
// Main moved after the plan was reviewed (for example a direct commit). If none of the new
// commits touch the paths the plan or task names, the build carries on against the new main;
// if any do, or the planned paths are unknown, the flow replans with a fresh budget. Both are
// recorded. policy.followTarget: false keeps the old behaviour (stop and wait for a replan).
const overlaps = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(b.replace(/\/$/, '') + '/') || b.startsWith(a.replace(/\/$/, '') + '/');
export function followTarget(store, flow, node, { replan } = {}) {
  const config = store.meta('config', {}), plan = flow.results?.plan;
  if (node.action?.operation !== 'provider.build' || config.policy?.planning === false || config.policy?.followTarget === false || !plan) return { flow };
  // Before the first build the plan's own checkout is compared with the new workspace; after
  // it, the plan's target base with the base the latest integration brought in.
  const first = !flow.sessions?.builder, cwd = workingRoot(store, flow);
  let current; try { current = first ? repositoryIdentity(cwd) : null; } catch { return { flow }; }
  const from = first ? plan.identity?.head : plan.targetBase, base = first ? current?.head : flow.results?.integrate?.base;
  if (!from || !base || from === base) return { flow };
  let changed;
  try { changed = execFileSync('git', ['diff', '--name-only', `${from}..${base}`], { cwd, encoding: 'utf8', timeout: 10000 }).trim().split('\n').filter(Boolean); }
  catch { return { flow }; }
  // Governing context files count as planned: a change to them needs a new plan.
  const task = store.need('task', flow.taskId), planned = [...new Set([...(task.paths ?? []), ...(plan.result?.files ?? []), ...(config.context?.files ?? []).map(f => f.path)])].filter(p => typeof p === 'string' && p);
  const touched = planned.length ? changed.filter(c => planned.some(p => overlaps(c, p.replace(/\*.*$/, '').replace(/\/$/, '') || '.'))) : changed;
  return store.tx(() => {
    const latest = store.need('flow', flow.id);
    if (digest(latest.results?.plan ?? null) !== digest(plan)) return { flow: latest };
    if (!touched.length) {
      if (first) { latest.results.plan.identity = current; latest.results.plan.targetBase = base; } else latest.results.plan.targetBase = base;
      (latest.targetFollows ??= []).push({ from, to: base, changed: changed.slice(0, 50), at: new Date().toISOString() });
      store.put('flow', latest); store.event('flow.target-followed', { flowId: latest.id, from, to: base, changed: changed.length });
      return { flow: latest, followed: true };
    }
    replan(store, latest, { note: `Main moved and changed planned paths: ${touched.slice(0, 10).join(', ')}`, by: 'factory', reason: 'target-changed-planned-paths' });
    return { flow: latest, replanned: true };
  });
}
// Which tasks may change the governing file a guard found changed (operations/governance-edit.mjs).
function governingEditHint(task, governance, entry) {
  if (!entry || governance?.ids.has(entry)) return '';
  if (governance) return ` (task ${task.id} is approved to change only these governing files: ${[...governance.ids].join(', ')})`;
  return ` (task ${task.id} is not approved to change governing files: a task changes one only when its brief names it in governingEdits and the operator approves that revision directly)`;
}
function planContextGuard(flow, task, context, contextConfig, prefix, governance) {
  const plan = flow.results.plan, manifest = plan.contextManifest;
  assert(manifest.digest === plan.contextDigest, 'reviewed plan context record is inconsistent; replan required');
  const changed = governingContextChange({ planned: manifest, current: context, config: contextConfig, scope: [...(task.paths ?? []), ...(plan.result?.files ?? [])] });
  assert(!changed, changed && governingContextMessage(changed, prefix) + governingEditHint(task, governance, changed.entry));
}
// The approved governing-context snapshot of a task the operator approved to edit governing files,
// or null for every other task. Checked at every step: the approval must still be the operator's
// own approval of the current revision, and each named file project-owned and plain.
// The snapshot is read from the comparison commit recorded in flow state, never from the
// candidate: before the owned workspace (and so that commit) exists, only the operations that
// create it may run, and they send no governing context to a model.
function governanceEditScope(store, flow, task, cwd, contextConfig, operation) {
  if (!hasGoverningEdits(task)) return null;
  const where = `step ${flow.step}`;
  assertGoverningEditsApproved(task, where);
  let owned = null; try { owned = upgradeOwned(store.meta('project').root); } catch {}
  assertGoverningEditsAllowed(task, contextConfig, owned, where);
  const commit = comparisonCommit(flow);
  if (!commit) { assert(BEFORE_WORKSPACE.includes(operation), `${where}: task ${task.id} may change governing files, but the flow has no comparison commit recorded from an owned workspace; such a task runs only in an owned workspace, from its first step`); return null; }
  return governingEditSnapshot({ repository: cwd, commit, task, contextConfig, owned });
}
// The learnings a planner, plan reviewer, builder or reviewer is given (knowledge-upkeep design 11.2,
// 11.3). A plan cycle selects once, at its first model step (the plan step, or the first build of a
// flow that does not plan), from the learnings directory in the commit the flow's checkout is on,
// read through hash-verified objects and never from the working files; the selection is pinned on
// the flow by the engine when the step is prepared (core/engine.mjs). Every later step of the cycle
// is given exactly the pinned blobs, read again from the object database, so a learning edited in
// the worktree or merged since changes nothing it is given. A replan starts a new cycle
// (core/project.mjs replanFlow). Learnings are not governing context: they are not in the package
// assembled above or its digest, and no plan guard reads them.
//   { selection, fresh, items }: the pin, whether this step made it, and the evidence items.
// While learning delivery is stopped (14.3: the `learnings` suspension, or a suspension of everything,
// after the review of 004f4ab), a new cycle pins an empty
// selection that says so; a cycle already pinned keeps what it was shown.
function learningsForStep(flow, task, operation, cwd, config, stopped = null) {
  let selection = flow.learningSelection ?? null, fresh = false;
  if (!selection) {
    const settings = learningsSettings(config);
    if (!LEARNING_BOUNDARY_OPERATIONS.includes(operation) || !settings.dir) return null;
    const cycle = (flow.learningCycles ?? 0) + 1, at = new Date().toISOString();
    let store, selected = [], skipped = [];
    if (stopped) store = { dir: settings.dir, commit: null, entries: [], refused: [], problem: `learning delivery is stopped since ${stopped.at} (${stopped.rule}); only the operator lifts it (upkeep.lift, part ${stopped.part ?? 'learnings'})` };
    else try {
      store = readLearningStore({ objects: new VerifiedObjects(cwd), commit: repositoryIdentity(cwd).head, config });
      ({ selected, skipped } = selectLearnings({ store, scope: task.paths ?? [], maxSelected: settings.maxSelected, maxChars: settings.maxChars }));
    } catch (error) { store = { dir: settings.dir, commit: null, entries: [], refused: [], problem: `the learnings could not be read: ${String(error.message).slice(0, 200)}` }; }
    // Learnings are advisory: a store that cannot be read gives nothing to this cycle, and says why.
    selection = learningSelection({ store, selected, skipped, step: flow.step, cycle, at });
    fresh = true;
  }
  const items = selection.entries.length ? pinnedLearningItems({ objects: new VerifiedObjects(cwd), selection }) : [];
  return { selection, fresh, items };
}
export function actionSpecification(store, flow, node, artifactDir) {
  const config = store.meta('config'), project = store.meta('project'), task = store.need('task', flow.taskId);
  const cwd = workingRoot(store, flow);
  const paths = new Set([...(task.paths ?? []), ...(flow.results?.plan?.result?.files ?? [])]);
  if (flow.workspace?.path) {
    const base = flow.workspace.base;
    for (const path of execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], { cwd, encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean)) paths.add(path);
    for (const path of changedFiles(cwd)) paths.add(path);
    for (const path of execFileSync('git', [...NO_PLANTED_COMMANDS, 'ls-files', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean)) paths.add(path);
  }
  const operation = node.action.operation;
  // A check task runs no step without the operator's own, current approval of its scripts.
  assertCheckScriptsApproved(task, `step ${flow.step}`);
  const contextConfig = config.context ?? { files: [], maxChars: 24000 }, governance = governanceEditScope(store, flow, task, cwd, contextConfig, operation);
  const context = assembleContext({ repoRoot: cwd, config: contextConfig, changedPaths: [...paths], snapshot: governance });
  const healthTarget = operation === 'main.verify' ? flow.jobPayload?.target ?? config.repository?.target : flow.target ?? config.repository?.target;
  if (operation === 'provider.build' && flow.results?.plan && config.policy?.planning !== false) {
    if (!flow.sessions?.builder) assert(digest(repositoryIdentity(cwd)) === digest(flow.results.plan.identity), 'planned input changed; replan required');
    if (flow.sessions?.builder && flow.results.integrate) assert(flow.results.integrate.base === flow.results.plan.targetBase, 'target changed since reviewed plan; replan required');
    assert(flow.results.plan.taskRevision === task.revision, 'reviewed plan context or task changed; replan required');
    // A plan recorded before per-file manifests existed keeps the exact package comparison.
    const manifest = flow.results.plan.contextManifest;
    if (!manifest) assert(flow.results.plan.contextDigest === context.digest, 'reviewed plan context or task changed; replan required');
    else {
      planContextGuard(flow, task, context, contextConfig, 'reviewed plan context or task changed', governance);
      // The builder receives exactly the package the plan review approved. Allowed plan-scope
      // additions were already in that package, so any other difference (for example governing
      // files changed before review and restored afterwards) means the approval does not apply.
      const review = flow.results['plan-review'];
      if (review) assert(review.contextDigest === context.digest, 'reviewed plan context or task changed; replan required: governing context differs from the package the plan review approved');
    }
  }
  // A plan review judges the plan under the governing context it was made with (plus files the
  // plan's own scope selects, unchanged); a change between planning and review is caught here.
  if (operation === 'provider.planReview' && flow.results?.plan?.contextManifest && config.policy?.planning !== false) planContextGuard(flow, task, context, contextConfig, 'planned context changed before plan review', governance);
  // Every task: a governing change its approval does not cover never reaches a reviewer as rules in
  // force. The candidate is the committed HEAD (review refuses an unclean worktree); the same
  // boundary is checked inside commit, integration, publication and merge (dispatch.mjs).
  // Review needs a commit the factory recorded before any model work: the comparison commit
  // (core/engine.mjs), else the owned workspace's base or the verified source head. Without one, a
  // verdict could not say the candidate leaves governing files unchanged, so review is refused.
  if (operation === 'provider.review' && flow.kind !== 'maintenance') {
    const comparison = comparisonCommit(flow) ?? flow.workspace?.base ?? flow.results?.source?.head;
    assert(comparison, `${flow.step} (before review): flow ${flow.id} has no comparison commit recorded before its model work (no owned workspace, and no earlier model step in this checkout), so a review could not show the candidate leaves governing files unchanged; run the task in a workflow that prepares its workspace or plans or builds before review`);
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    // The refusal stops the flow; its notice says what to do (dev.90, N1; core/engine.mjs tick).
    try { assertGoverningBoundary({ repository: cwd, contextConfig, task, comparison, head, where: `${flow.step} (before review)` }); }
    catch (error) { throw withRefusalNotice(error, { task, where: `${flow.step} (before review)`, stopped: true }); }
  }
  const contract = nodeContract(flow.step, node);
  const input = { step:flow.step, binding:contract.binding, stepModel:contract.role?config.stepModels?.[flowWorkflowKey(flow)]?.[flow.step]??null:null, node:node.action, integration:flow.integration??null, integrationDecisions:flow.integrationDecisions??{}, strictDecisionRole:flow.strictDecisionRole??'operator', reviewProtocol:flow.reviewProtocol??config.policy?.reviewProtocol??'fresh-full', reviewHistory:flow.reviewHistory??[], operatorFeedback:flow.operatorFeedback??[], carriedQuestions: carriedQuestions(flow), carriedOverflow: carriedOverflow(flow), risk: riskSummary(task, flow), riskAssessments: flow.riskAssessments ?? [], operation, kind: flow.kind, preparedPlanWorkspace: flow.preparedPlanWorkspace ?? null, candidate: flow.candidate ?? null, completionMode: flow.completionMode ?? 'merge', target: flow.target ?? config.repository?.target ?? null, mainHealth: targetHealth(store, flow.target), completionDecision: flow.completionDecision ?? null, jobPayload: flow.jobPayload ?? {}, projectId: project.projectId, flowId: flow.id, task, config, configDigest: store.meta('configDigest'), workspace: flow.workspace ?? null, results: flow.results ?? {}, evidence: flow.evidence, sessions: flow.sessions ?? {}, context, governanceEdit: governance ? { commit: governance.commit, entries: governance.entries } : null, governanceBase: flow.governanceBase ?? null, stateDir: store.stateDir, artifactDir, mergeAuthorization: flow.mergeAuthorization ?? null, resource: contract.heavy || (operation === 'fastCheck' && config.fastChecks?.heavy === true) };
  // A shadow flow's reviews ask the must-fix questions and record what that bar would have done
  // (workflows/must-fix.mjs). A severity flow's intent is exactly what it was before the bar existed.
  // Attempts are stored without their intent, so each citable one is read whole.
  if (['provider.review', 'provider.planReview'].includes(operation) && flowReviewBar(flow) !== 'severity') Object.assign(input, { reviewBar: flowReviewBar(flow), reviewPolicy: flow.reviewPolicy ?? null, reviewRecords: citableRecords(store.by('attempt', 'flowId', flow.id).filter(row => ['passed', 'failed'].includes(row.status)).slice(-CITABLE_RECORD_LIMIT).map(row => store.need('attempt', row.id))), ...(operation === 'provider.planReview' ? { reviewRound: flow.visits?.[flow.step] ?? 1 } : {}) });
  // A must-fix flow (test fixtures until the enabling release; review-must-fix design 6, 9): the
  // builder and the follow-up step read the ledger too, every review step also reads the operator's
  // dispositions, and a change review reads its cap allowance and whether one more correction cycle
  // fits the flow's bounds (9.5). A severity or shadow flow's intent is unchanged.
  if (flowReviewBar(flow) === 'must-fix' && ['provider.review', 'provider.planReview', 'provider.build', 'forge.followup'].includes(operation)) Object.assign(input, { reviewBar: 'must-fix', reviewPolicy: flow.reviewPolicy ?? null, operatorFindingDispositions: flow.operatorFindingDispositions ?? [], ...(operation === 'forge.followup' ? { reviewLedger: flow.reviewLedger ?? null } : {}), ...(operation === 'provider.review' ? { mustFixAllowance: flow.mustFixAllowance ?? 0, mustFixBudget: { revise: cycleBudget(flow, node.resultEdges?.revise ?? null) } } : {}) });
  if (LEARNING_ROLES[operation] && flow.kind !== 'maintenance') { const learnings = learningsForStep(flow, task, operation, cwd, config, upkeepSuspensions(store).learnings ?? upkeepSuspensions(store).all ?? null); if (learnings) input.learnings = learnings; }
  if (modelRole(flow.step, node, config) && flow.modelRoutes) {
    assert(Object.hasOwn(flow.modelRoutes, flow.step), 'model step has no pinned route; start a new flow for the changed workflow');
    input.modelRoute = flow.modelRoutes[flow.step];
    input.modelSelectionDigest = flow.modelSelection.digest;
  }
  // Providers under a usage-limit hold when this step was prepared: the adapter refuses them
  // before starting, so only a configured fallback on another provider can run (readiness G7).
  if (modelRole(flow.step, node, config)) { const held = heldProviders(store); if (held.length) input.providerHolds = held; }
  input.targetHealthVersion = targetHealthVersion(store, healthTarget);
  if (operation === 'gate') input.targetSyncHolds = targetSyncHolds(store, healthTarget);
  // An adopted PR: the step that leads into a merge question also reads the original PR, so the
  // question can say whether commits were pushed to it after adoption (dispatch.mjs).
  if (flow.candidate && leadsToMergeQuestion(flow.workflow, node)) input.observeOriginalPR = true;
  return { argv: [process.execPath, join(dirname(fileURLToPath(import.meta.url)), 'dispatch.mjs'), join(artifactDir, 'intent.json')], action: input, cwd, synthetic: false };
}
export const leadsToMergeQuestion = (workflow, node) => [node?.next, ...Object.values(node?.resultEdges ?? {})].some(step => step && workflow?.nodes?.[step]?.kind === 'question' && workflow.nodes[step].mergeDecision === true);
export function changedFiles(root) { return execFileSync('git', [...NO_PLANTED_COMMANDS, 'diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim().split('\n').filter(Boolean); }
export function verifyDecision(store, flow) {
  const authorization = flow.mergeAuthorization;
  assert(authorization && authorization.taskRevision === flow.taskRevision && authorization.configDigest === flow.configDigest, 'current merge decision required');
  const identity = repositoryIdentity(workingRoot(store, flow));
  assert(digest(identity) === digest(authorization.identity), 'authorized candidate changed before merge');
  if (flow.mode === 'delivery') verifyStrictDecision(store.need('task', flow.taskId), flow, identity, authorization);
  // Rechecked before merge: an adopted PR's merge needs the operator's own answer.
  if (flow.candidate) assert(authorization.actor === 'operator', 'an adopted pull request merge requires the operator\'s own decision');
  if (authorization.authority === 'mergeDecisionRole') assert(mergeDecisionRole(store.need('task', flow.taskId), flow) === authorization.actor, 'delegated merge decision no longer applies to this candidate');
}
export function verifySatisfiedDecision(store, flow) {
  const decision = flow.completionDecision;
  assert(decision?.inboxId && decision.taskRevision === flow.taskRevision && decision.configDigest === flow.configDigest && decision.workflowDigest === flow.workflowDigest, 'current accepted outcome decision required');
  const identity = repositoryIdentity(workingRoot(store, flow));
  assert(digest(identity) === digest(decision.identity), 'accepted candidate changed before recording the outcome');
  if (flow.mode === 'delivery') verifyStrictDecision(store.need('task', flow.taskId), flow, identity, decision);
}
