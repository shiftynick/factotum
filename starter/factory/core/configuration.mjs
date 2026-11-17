import { validateSyncTargets } from '../operations/targets.mjs';
import { validateHandoffSettings } from '../operations/orchestrator-session.mjs';
import {sourceSettings} from '../operations/source-config.mjs';
import { assertNoReservedNamespace } from './upkeep-namespace.mjs';
import { validateUpkeepConfig } from './upkeep-config.mjs';
import {lifecycleEnabled} from '../operations/source-adapter.mjs';
import {validateModelCoauthor} from '../operations/attribution.mjs';
import { validateMainCheckPolicy } from '../operations/main-checks.mjs';
import { validateMainCheckTiers } from '../operations/main-tiers.mjs';
import { validateMaintenanceTimeouts } from '../operations/effect-timeouts.mjs';
import { validateResourceConfig } from '../operations/resources.mjs';
import { validateQueuePolicy } from '../operations/queue-order.mjs';
import { validateLimitPolicy } from '../operations/provider-limits.mjs';
import {validateIntegrationConfig} from '../workflows/integrations.mjs';
import { validateFastChecks, fastCheckTimeoutMs } from '../workflows/fast-checks.mjs';
import { assert, assertTargetBranch, digest, validateWorkflow } from './contracts.mjs';
import { validateRequirements } from './operations.mjs';
import { validateScheduledTasks } from '../operations/scheduled-tasks.mjs';
import { validateRecurringTasks } from '../operations/recurring-tasks.mjs';
import { validateDelegatedOperations } from './delegation.mjs';
import { validateCatalogConfig } from './catalog.mjs';
import { MAX_TURNS_LIMIT, usableProviderRole, validMaxTurns, validateStepModelShape, validateStepModels, withBuiltinModelGraphs } from './step-models.mjs';

// stats.pricing: {"<model>": {input, cachedInput, cacheWrite, output}} in USD per million tokens.
const PRICE_KEYS = ['input', 'cachedInput', 'cacheWrite', 'output'];
function validatePricing(stats) {
  assert(stats === undefined || stats && typeof stats === 'object' && !Array.isArray(stats) && Object.keys(stats).every(k => k === 'pricing'), 'stats supports pricing only');
  const pricing = stats?.pricing;
  assert(pricing === undefined || pricing && typeof pricing === 'object' && !Array.isArray(pricing) && Object.keys(pricing).length <= 32, 'stats.pricing must map models to prices');
  for (const [model, row] of Object.entries(pricing ?? {})) assert(model.trim() && row && typeof row === 'object' && Object.keys(row).every(k => PRICE_KEYS.includes(k)) && ['input', 'output'].every(k => Number.isFinite(row[k])) && Object.values(row).every(v => Number.isFinite(v) && v >= 0 && v <= 10000), `stats.pricing.${model} needs input and output prices (USD per million tokens), and optionally cachedInput and cacheWrite`);
}
// preview: an optional project command run before the merge question, whose screenshots are
// attached to it. {command: [argv], timeoutMs, paths?: ["site/"]}: it runs only when the change
// touches one of the paths (or always without paths) and writes images to $FACTOTUM_PREVIEW_DIR.
function validatePreview(preview) {
  if (preview === undefined) return;
  assert(preview && typeof preview === 'object' && Object.keys(preview).every(k => ['command', 'timeoutMs', 'paths'].includes(k)), 'preview supports command, timeoutMs and paths');
  assert(Array.isArray(preview.command) && preview.command.length && preview.command.every(x => typeof x === 'string' && x && !x.includes('\0')), 'preview.command must be a non-empty argv list');
  assert(Number.isSafeInteger(preview.timeoutMs) && preview.timeoutMs > 0 && preview.timeoutMs <= 1800000, 'preview.timeoutMs must be at most 30 minutes');
  assert(preview.paths === undefined || Array.isArray(preview.paths) && preview.paths.every(p => typeof p === 'string' && p && !p.startsWith('/')), 'preview.paths must be relative paths');
}
// Put a preview step in front of every merge question of a change or document graph, reference
// or project-owned: every effect edge into the question goes through it first. A graph that
// already has a preview step is left as it is.
export function insertPreview(workflow, config) {
  if (!config.preview || Object.values(workflow.nodes).some(n => n.action?.operation === 'preview')) return workflow;
  const nodes = workflow.nodes, merges = Object.keys(nodes).filter(k => nodes[k].kind === 'question' && nodes[k].mergeDecision);
  merges.forEach((merge, i) => {
    const key = i === 0 && !nodes.preview ? 'preview' : `preview-${merge}`;
    for (const [k, node] of Object.entries(nodes)) {
      if (node.kind !== 'effect' || k === key) continue;
      if (node.next === merge) node.next = key;
      for (const [edge, target] of Object.entries(node.resultEdges ?? {})) if (target === merge) node.resultEdges[edge] = key;
    }
    nodes[key] = { kind: 'effect', action: { operation: 'preview' }, timeoutMs: Math.min(3600000, config.preview.timeoutMs + 60000), next: merge, onFailure: merge, preserveInput: true, heavy: true, resultEdges: { pass: merge, skipped: merge, fail: merge } };
  });
  if (merges.length) workflow.maxTransitions = (workflow.maxTransitions ?? 100) + 20;
  return workflow;
}
export function changeWorkflow(config, { preview = true, fastChecks = true } = {}) {
  const rounds = config.policy?.maxBuildRounds ?? 4, reviewRounds=config.policy?.ordinaryReviewRounds??4, reviewVisits=Math.max(rounds+3,reviewRounds+2);
  const effect = (operation, next, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: config.timeouts?.[operation] ?? (operation.startsWith('provider.') ? 600000 : 120000), next, onFailure: 'failed', ...extra });
  const nodes = {
    source: effect('source.verify', 'admitted', { maxVisits: rounds + 4, resultEdges: { ready:'admitted', planned:'admitted', candidate:'admitted', satisfied:'admitted' } }),
    admitted:effect('forge.lifecycle','plan',{resultEdges:{ready:config.policy?.planning===false?'workspace':'plan',planned:'workspace',candidate:'candidate',satisfied:'satisfied-workspace'}}),
    candidate: effect('workspace.adopt', 'integrate'),
    'satisfied-workspace': effect('workspace.prepare', 'satisfied-review'),
    'satisfied-review': effect('provider.review', 'satisfied-gate', { preserveInput: true, evidence: 'review', resultEdges: { pass: 'satisfied-gate', revise: 'failed' } }),
    'satisfied-gate': effect('gate', 'satisfied-decide', { preserveInput: true, evidence: 'gate', heavy: true, resultEdges: { pass: 'satisfied-decide', fail: 'failed', blocked: 'failed' } }),
    'satisfied-decide': { kind: 'question', role: 'operator', question: 'The target already satisfies this task. Accept the reviewed and verified outcome without a code change?', requireEvidence: ['review', 'gate'], satisfiedDecision: true, answers: { accept: 'satisfied-record', stop: 'stopped' } },
    'satisfied-record': effect('outcome.satisfied', 'post-merge'),
    // Three plan attempts per cycle (dev.82; two before). A replan after an answer to a plan question is not counted.
    plan: effect('provider.plan', 'plan-review', { preserveInput: true, maxVisits: 3, resultEdges: { ready: 'plan-review', blocked: 'plan-question' } }),
    'plan-review': effect('provider.planReview', 'publish-plan', { preserveInput: true, resultEdges: { pass: 'publish-plan', revise: 'plan' } }),
    'publish-plan':effect('forge.publishPlan','workspace',{preserveInput:true}),
    // The item lists the planner's questions; proceed is offered only for a plan the planner marked ready (core/plan-questions.mjs).
    'plan-question': { kind: 'question', role: 'operator', question: 'The planner has questions about this task. Answer replan with a note that answers them, or proceed with the plan as it is when that is offered.', answers: { replan: 'plan', proceed: 'plan-review', stop: 'stopped' } },
    workspace: effect('workspace.prepare', 'build'),
    build: effect('provider.build', 'commit', { maxVisits: rounds, resultEdges: { implemented: 'commit', blocked: 'build-question' } }),
    'build-question': { kind: 'question', role: 'operator', question: 'The builder is blocked. Inspect the retained result before retrying.', answers: { retry: 'build', stop: 'stopped' } },
    commit: effect('workspace.commit', 'integrate'),
    integrate: effect('workspace.integrate', 'publish', { maxVisits: rounds + 2, resultEdges: { integrated: 'publish', conflict: 'conflict-question' } }),
    'conflict-question': { kind: 'question', role: 'operator', question: 'Target integration conflicted. Send the retained conflict to the builder with a note, or resolve and commit it before retrying integration.', answers: { repair:config.policy?.planning===false?'build':'plan', retry: 'integrate', stop: 'stopped' } },
    publish: effect('forge.publish', 'review'),
    review: effect('provider.review', 'gate', { preserveInput: true, evidence: 'review', maxVisits:reviewVisits, resultEdges: { pass:'gate', revise:'build', delta:'delta-review', defer:'followups', adjudicate:'gate', park:'review-question' } }),
    'delta-review':effect('provider.review','gate',{preserveInput:true,evidence:'review',maxVisits:reviewVisits,resultEdges:{pass:'gate',revise:'build',delta:'delta-review',defer:'followups',adjudicate:'gate',park:'review-question'}}),
    followups:effect('forge.followup','gate',{preserveInput:true,evidence:'review'}),
    'review-question':{kind:'question',role:'operator',question:'The bounded final review could not establish readiness. Inspect the retained findings before deciding whether to authorize another correction.',answers:{send_back:'build',stop:'stopped'}},
    gate: effect('gate', 'decide', { preserveInput: true, evidence: 'gate', heavy: true, maxVisits: rounds + 4, resultEdges: { pass: 'decide', fail: 'build', blocked: 'gate-question' } }),
    'gate-question': { kind: 'question', role: 'operator', question: 'Verification could not establish a product result. Inspect infrastructure evidence before retrying.', answers: { retry: 'gate', stop: 'stopped' } },
    decide: { kind: 'question', role: config.policy?.mergeDecisionRole ?? 'operator', question: 'Merge this reviewed and verified candidate?', requireEvidence: ['review', 'gate'], mergeDecision: true, answers: { merge: 'merge', send_back:'build', stop: 'stopped' } },
    merge: effect('forge.merge', 'post-merge', { requireDecision: true, resultEdges: { merged: 'post-merge', stale: 'integrate' } }),
    'post-merge': effect('postMerge', 'close-task', { onFailure: 'cleanup' }),
    'close-task': effect('forge.closeTask', 'cleanup', { onFailure: 'cleanup' }),
    cleanup: effect('workspace.release', 'done', { onFailure: 'done' }),
    done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' }, stopped: { kind: 'end', outcome: 'stopped' },
  };
  if(!lifecycleEnabled(config)){nodes.source.resultEdges={ready:config.policy?.planning===false?'workspace':'plan',planned:'workspace',candidate:'candidate',satisfied:'satisfied-workspace'};}
  // Configured fast checks run on the integrated candidate before it is published for review.
  // A product failure goes back to the builder; it never reaches review or mints gate evidence.
  // Without fastChecks the graph is exactly the one commissioned before this step existed.
  const fast = fastChecks && config.fastChecks;
  if (fast) {
    nodes['fast-check'] = effect('fastCheck', 'publish', { preserveInput: true, evidence: 'fast-check:passed', timeoutMs: fastCheckTimeoutMs(fast), maxVisits: rounds + 4, ...(fast.heavy ? { heavy: true } : {}), resultEdges: { pass: 'publish', fail: 'build' } });
    nodes.integrate = { ...nodes.integrate, next: 'fast-check', resultEdges: { ...nodes.integrate.resultEdges, integrated: 'fast-check' } };
  }
  const graph = { version: 1, maxTransitions: Math.max(rounds,reviewRounds) * 16 + 40 + (fast ? 20 : 0), start: 'source', nodes };
  return preview ? insertPreview(graph, config) : graph;
}
// The document reference: the change workflow for work that produces a document (research,
// a proposal, a guide) instead of code. It plans (under policy.planning), writes in a worktree,
// is reviewed and merges, with no check gate: a passing review is the evidence a merge needs.
const DOCUMENT_GUIDANCE = {
  plan: 'This task produces a document, not code. Plan its location, structure and sources; checks are not run for it.',
  build: 'This task produces a document, not code. Write or revise the document in the repository; do not add tests or change code unless the task asks for it.',
  review: 'This task produces a document, not code, and no checks are run for it. Review it for accuracy against its sources, completeness against the acceptance criteria, and clarity. Do not ask for tests.',
};
export function documentWorkflow(config) {
  // Documents run no checks: neither the gate nor fast checks.
  const graph = changeWorkflow(config, { preview: false, fastChecks: false }), nodes = graph.nodes;
  for (const key of ['gate', 'gate-question', 'satisfied-gate']) delete nodes[key];
  for (const key of ['review', 'delta-review']) nodes[key] = { ...nodes[key], next: 'decide', resultEdges: { ...nodes[key].resultEdges, pass: 'decide', adjudicate: 'decide' } };
  nodes.followups = { ...nodes.followups, next: 'decide' };
  nodes['satisfied-review'] = { ...nodes['satisfied-review'], next: 'satisfied-decide', resultEdges: { pass: 'satisfied-decide', revise: 'failed' } };
  nodes['satisfied-decide'] = { ...nodes['satisfied-decide'], question: 'The target already satisfies this task. Accept the reviewed outcome without a change?', requireEvidence: ['review'] };
  nodes.decide = { ...nodes.decide, question: 'Merge this reviewed document?', requireEvidence: ['review'] };
  for (const [key, guidance] of [['plan', DOCUMENT_GUIDANCE.plan], ['plan-review', DOCUMENT_GUIDANCE.plan], ['build', DOCUMENT_GUIDANCE.build], ['review', DOCUMENT_GUIDANCE.review], ['delta-review', DOCUMENT_GUIDANCE.review], ['satisfied-review', DOCUMENT_GUIDANCE.review]]) nodes[key] = { ...nodes[key], action: { ...nodes[key].action, guidance } };
  return insertPreview(graph, config);
}
// Settings of removed features. They have no effect; validation drops them so older
// configurations still commission, and config update reports them with the reason.
// policy.allowSameFamilyReview: same-family review is always allowed (readiness G8).
export const OBSOLETE_SETTING_REASONS = Object.freeze({ 'policy.autoPlanQueue': 'planning ahead was removed', 'policy.planningWindow': 'planning ahead was removed', 'policy.planMaxAgeMs': 'planning ahead was removed', 'stepModels.planning': 'planning ahead was removed', 'policy.allowSameFamilyReview': 'same-family review is always allowed' });
export const OBSOLETE_SETTINGS = Object.freeze(Object.keys(OBSOLETE_SETTING_REASONS));
export function obsoleteSettings(config = {}) { return OBSOLETE_SETTINGS.filter(path => { const [a, b] = path.split('.'); return config?.[a] && Object.hasOwn(config[a], b); }); }
export function validateConfig(input = {}) {
  const config = structuredClone(input);
  for (const path of obsoleteSettings(config)) { const [a, b] = path.split('.'); delete config[a][b]; }
  assert(config.notifications?.stateEvents===undefined||typeof config.notifications.stateEvents==='boolean','notifications.stateEvents must be boolean');
  assert(config.cleanup===undefined||config.cleanup&&typeof config.cleanup==='object'&&Object.keys(config.cleanup).every(key=>['maxArchiveBytes','excludeIgnored'].includes(key))&&(config.cleanup.maxArchiveBytes===undefined||Number.isSafeInteger(config.cleanup.maxArchiveBytes)&&config.cleanup.maxArchiveBytes>0),'cleanup supports a positive maxArchiveBytes and excludeIgnored');
  assert(config.cleanup?.excludeIgnored===undefined||Array.isArray(config.cleanup.excludeIgnored)&&config.cleanup.excludeIgnored.length<=64&&config.cleanup.excludeIgnored.every(pattern=>typeof pattern==='string'&&pattern&&!pattern.startsWith('/')&&!pattern.split('/').includes('..')&&!pattern.includes('\0')),'cleanup.excludeIgnored must be a list of relative globs');
  validatePricing(config.stats); validatePreview(config.preview);
  // Each workspace.setup command's limit (adapters/workspace prepare); 30 minutes when absent.
  assert(config.workspace?.setupTimeoutMs===undefined||Number.isSafeInteger(config.workspace.setupTimeoutMs)&&config.workspace.setupTimeoutMs>0&&config.workspace.setupTimeoutMs<=14_400_000,'workspace.setupTimeoutMs must be a positive number of milliseconds, at most four hours');
  assert(config.notifications?.level===undefined||['essential','actionable','all'].includes(config.notifications.level),'notifications.level must be essential, actionable or all');
  validateHandoffSettings(config);
  assert(config.notifications?.suppressSelfResolutions===undefined||typeof config.notifications.suppressSelfResolutions==='boolean','notifications.suppressSelfResolutions must be boolean');
  // Knowledge upkeep (core/upkeep-config.mjs): the optional upkeep and learnings blocks. No reference
  // graph reads them, so the compiled graphs and their digests are the same with or without them.
  validateUpkeepConfig(config);
  if (!config.mode || config.mode === 'rehearsal') return config;
  sourceSettings(config);
  // The upkeep: task namespace is the factory's (core/upkeep-namespace.mjs): no source may import into it.
  // Checked here, at every configuration write and at commissioning, and not in sourceSettings, which
  // read models call on the stored configuration of a project that may already use the namespace.
  assertNoReservedNamespace(config);
  assert(config.version === 1 && config.mode === 'delivery', 'unsupported project configuration');
  assert(/^[a-z\d_.-]+\/[a-z\d_.-]+$/i.test(config.repository?.slug ?? ''), 'repository slug required');
  assert(config.repository.ghPath===undefined||typeof config.repository.ghPath==='string'&&config.repository.ghPath.startsWith('/')&&!config.repository.ghPath.includes('\0'),'repository.ghPath must be an absolute path to the gh binary');
  assert(['merge','squash','rebase'].includes(config.repository.mergeMethod??'merge'),'invalid repository merge method');
  assert(config.repository.rerunFailedChecks===undefined||typeof config.repository.rerunFailedChecks==='boolean','repository.rerunFailedChecks must be boolean');
  assert(config.repository.adoptionNotice===undefined||typeof config.repository.adoptionNotice==='boolean','repository.adoptionNotice must be boolean');
  assert(config.repository.rerunWaitMs===undefined||Number.isSafeInteger(config.repository.rerunWaitMs)&&config.repository.rerunWaitMs>0&&config.repository.rerunWaitMs<=1800000,'repository.rerunWaitMs must be at most 30 minutes');
  assert(typeof config.repository.account === 'string' && config.repository.account, 'explicit GitHub account required');
  assert(typeof config.repository.target === 'string' && config.repository.target, 'target branch required: set repository.target to the branch work merges into');
  // The same rule as a workflow's target (dev.86): generated record ids embed target names.
  assertTargetBranch(config.repository.target, 'repository.target');
  for (const role of ['planner', 'builder', 'reviewer']) {
    const provider = config.providers?.[role];
    assert(['codex', 'claude'].includes(provider?.provider) && typeof provider.model === 'string' && provider.model, `${role} provider/model required`);
    assert((provider.billingMode ?? 'subscription') === 'subscription', 'only subscription-backed provider modes are enabled');
  }
  // The optional role of knowledge upkeep's assessment (design 6.3); absent, the reviewer runs it.
  if (config.providers?.upkeep !== undefined) {
    assert(usableProviderRole(config.providers.upkeep), 'providers.upkeep needs a provider (codex or claude) and a model, subscription-backed; remove it to let the reviewer run the upkeep assessment');
  }
  // Provider turns per model step (dev.84, H9); unset uses the default for the role (adapters/providers/routes.mjs).
  for (const [role, provider] of Object.entries(config.providers ?? {})) assert(validMaxTurns(provider?.maxTurns), `providers.${role}.maxTurns must be a whole number from 1 to ${MAX_TURNS_LIMIT}`);
  assert(Number.isSafeInteger(config.policy?.maxBuildRounds ?? 4) && (config.policy?.maxBuildRounds ?? 4) > 0 && (config.policy?.maxBuildRounds ?? 4) <= 12, 'invalid build round bound');
  const policy=config.policy??(config.policy={});
  assert(Number.isSafeInteger(policy.planReviewProtocolCorrections??1)&&(policy.planReviewProtocolCorrections??1)>=0&&(policy.planReviewProtocolCorrections??1)<=1,'invalid plan review protocol correction bound');
  assert(['fresh-full','bounded-delta'].includes(policy.reviewProtocol??'fresh-full'),'invalid review protocol');
  for(const key of ['ordinaryReviewRounds','ordinaryFollowupAfter'])assert(Number.isSafeInteger(policy[key]??(key==='ordinaryReviewRounds'?4:3))&&(policy[key]??(key==='ordinaryReviewRounds'?4:3))>=1&&(policy[key]??(key==='ordinaryReviewRounds'?4:3))<=12,`invalid ${key}`);
  assert((policy.ordinaryFollowupAfter??3)<=(policy.ordinaryReviewRounds??4),'followup threshold exceeds review round bound');
  const maxFlows=policy.maxFlows??policy.maxActiveFlows??1;
  assert(Number.isSafeInteger(maxFlows)&&maxFlows>0,'invalid active change flow capacity');
  assert(policy.maxDocumentFlows===undefined||Number.isSafeInteger(policy.maxDocumentFlows)&&policy.maxDocumentFlows>0&&policy.maxDocumentFlows<=20,'invalid document flow capacity');
  assert(policy.maxTaskFlows===undefined||Number.isSafeInteger(policy.maxTaskFlows)&&policy.maxTaskFlows>0&&policy.maxTaskFlows<=50,'invalid task flow capacity');
  // Flows parked on an answer that hold no flow slot (operations/capacity.mjs); 0 makes every parked flow hold its slot.
  assert(policy.maxParkedFlows===undefined||Number.isSafeInteger(policy.maxParkedFlows)&&policy.maxParkedFlows>=0&&policy.maxParkedFlows<=50,'policy.maxParkedFlows must be a whole number from 0 to 50');
  assert(policy.maxActiveFlows===undefined||(Number.isSafeInteger(policy.maxActiveFlows)&&policy.maxActiveFlows>0&&policy.maxActiveFlows===maxFlows),'conflicting or invalid maxActiveFlows alias');
  policy.maxFlows=maxFlows;
  validateQueuePolicy(policy); validateResourceConfig(config.resources ?? {}); validateLimitPolicy(policy);
  assert(Number.isSafeInteger(policy.mainHealthMaxAgeMs??3600000)&&(policy.mainHealthMaxAgeMs??3600000)>0,'invalid main health lifetime');
  // How often the loop checks whether main moved outside the factory; 0 turns the check off.
  assert(policy.mainProbeMs===undefined||Number.isSafeInteger(policy.mainProbeMs)&&(policy.mainProbeMs===0||policy.mainProbeMs>=10000&&policy.mainProbeMs<=86400000),'policy.mainProbeMs must be 0 (off) or 10000-86400000');
  for(const key of ['followTarget','deferLowFindings','delegateIntegrationDecisions','queueOnApproval','planning','autoQueue','autoMerge','allowFactoryEdits','recovery'])assert(policy[key]===undefined||typeof policy[key]==='boolean',`${key} must be boolean`);
  assert(Number.isSafeInteger(policy.mainInfrastructureRetries??0)&&(policy.mainInfrastructureRetries??0)>=0&&(policy.mainInfrastructureRetries??0)<=2,'invalid main infrastructure retry bound');
  assert(Array.isArray(config.checks) && config.checks.length > 0 && new Set(config.checks.map(c => c.id)).size === config.checks.length, 'nonempty unique verification checks required');
  for (const check of config.checks) assert(typeof check.id === 'string' && Array.isArray(check.argv) && check.argv.length && check.argv.every(x => typeof x === 'string') && Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0, 'invalid verification check');
  for (const check of config.checks) assert(check.holdExitCodes === undefined || Array.isArray(check.holdExitCodes) && check.holdExitCodes.length > 0 && check.holdExitCodes.length <= 16 && check.holdExitCodes.every(code => Number.isSafeInteger(code) && code > 0 && code <= 255) && new Set(check.holdExitCodes).size === check.holdExitCodes.length, 'check holdExitCodes must be unique nonzero exit codes (1–255), at most 16');
  validateFastChecks(config.fastChecks);
  for (const check of config.mainChecks ?? []) validateMainCheckPolicy(check);
  validateMainCheckTiers(config);
  // A full main verification must fit in one main.verify step (operations/effect-timeouts.mjs).
  validateMaintenanceTimeouts(config);
  validateModelCoauthor(config);
  validateIntegrationConfig(config);
  validateRequirements(config.requirements);
  validateScheduledTasks(config.scheduledTasks);
  validateRecurringTasks(config.recurringTasks);
  validateDelegatedOperations(config.policy?.delegatedOperations);
  validateCatalogConfig(config.workflows);
  validateSyncTargets(config, [config.repository.target, ...Object.values(config.workflows?.definitions ?? {}).map(d => d.target).filter(Boolean)]);
  assert(['operator','orchestrator'].includes(policy.strictDecisionRole??'operator'),'invalid strict decision role');
  assert(['operator','orchestrator'].includes(policy.mergeDecisionRole??'operator'),'invalid merge decision role');
  validateWorkflow(changeWorkflow(config));
  validateStepModelShape(config.stepModels);
  // With a catalog, step models are checked against the compiled project graphs at commissioning.
  if(!config.workflows)validateStepModels(config,withBuiltinModelGraphs(config,{standard:changeWorkflow(config)}));
  return config;
}
export const configDigest = config => digest(validateConfig(config));
