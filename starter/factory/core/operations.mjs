import { assert } from './contracts.mjs';

// Core operation contracts. Guards, evidence and privileged result fields come
// from the operation a node runs, never from its name or optional graph flags.
// A graph may add preserveInput/heavy; it cannot remove an inherent requirement.
//
// bindings: semantic result slots the operation may fill (first is the default).
// mints:    the only evidence kind its successful, validated result may create.
// privileged: result fields the kernel adopts as canonical facts.
// role: the provider role an LLM operation runs as (its default model).
const contract = (bindings, extra = {}) => ({ bindings, role: null, mints: null, preserveInput: false, heavy: false, requiresDecision: false, privileged: [], ...extra });
export const OPERATIONS = Object.freeze({
  'source.verify': contract(['source'], { privileged: ['workspace', 'targetHealthHold'] }),
  'forge.lifecycle': contract(['admitted']),
  'workspace.adopt': contract(['candidate'], { privileged: ['workspace', 'adoptionHold', 'adoptionRefs'] }),
  'workspace.prepare': contract(['workspace', 'satisfied-workspace'], { privileged: ['workspace'] }),
  // turnLimit: the step's provider stopped at its turn limit (dev.84, H9); the kernel holds the flow at the step.
  'provider.plan': contract(['plan'], { preserveInput: true, role: 'planner', privileged: ['turnLimit'] }),
  'provider.planReview': contract(['plan-review'], { preserveInput: true, role: 'reviewer', privileged: ['turnLimit'] }),
  'forge.publishPlan': contract(['publish-plan'], { preserveInput: true }),
  'provider.build': contract(['build'], { role: 'builder', privileged: ['turnLimit'] }),
  'workspace.commit': contract(['commit']),
  'workspace.integrate': contract(['integrate']),
  'forge.publish': contract(['publish']),
  'provider.review': contract(['review', 'satisfied-review', 'delta-review', 'final-review'], { mints: 'review', preserveInput: true, role: 'reviewer', privileged: ['turnLimit'] }),
  'forge.followup': contract(['followups'], { mints: 'review', preserveInput: true }),
  'gate': contract(['gate', 'satisfied-gate'], { mints: 'gate', preserveInput: true, heavy: true, privileged: ['gateHold'] }),
  'preview': contract(['preview'], { preserveInput: true, heavy: true }),
  // Fast checks produce named observations at most, never gate evidence.
  'fastCheck': contract(['fast-check'], { preserveInput: true, privileged: ['fastCheckHold'] }),
  'forge.merge': contract(['merge'], { requiresDecision: true, privileged: ['merged'] }),
  'outcome.satisfied': contract(['satisfied-record'], { requiresDecision: true, privileged: ['proven'] }),
  'postMerge': contract(['post-merge']),
  'forge.closeTask': contract(['close-task']),
  'workspace.release': contract(['cleanup'], { privileged: ['workspace'] }),
  'main.verify': contract([], { heavy: true, privileged: ['mainHealth'] }),
  'target.sync': contract([]),
  'maintenance.backup': contract([]),
  'audit': contract([], { privileged: ['findings'] }),
  'retrospective': contract([]),
  // Knowledge upkeep's assessment: only its own result may record a run's outcome (operations/upkeep-runs.mjs).
  // Its one model call may stop at its turn limit; the run then records that as its reason. The
  // contract names no role, so the kernel does not hold the flow at the step: an assessment is not retried.
  // In propose mode its result also carries the docs candidates the validator kept (`proposed`).
  'knowledge.upkeep': contract([], { privileged: ['upkeepRun', 'turnLimit', 'proposed'] }),
  // learnings.check (knowledge-upkeep design 11.4): read-only; only its own result raises stale-learning candidates.
  'learnings.check': contract([], { privileged: ['learningsCheck'] }),
  // Closing the pull request of a knowledge-upkeep follow-up the factory ended (operations/upkeep-pr-close.mjs).
  'forge.closeFollowUp': contract([]),
  'machine.sample': contract([], { privileged: ['machineSample'] }),
  'retention.archive': contract([]),
  'integration.run': contract([]),
});
const RESERVED = new Map(Object.entries(OPERATIONS).flatMap(([operation, row]) => row.bindings.map(binding => [binding, operation])));
const PRIVILEGED = new Set(Object.values(OPERATIONS).flatMap(row => row.privileged));
export const EVIDENCE_KINDS = Object.freeze(['review', 'gate']);
// Project observations (e.g. `check:lint`) can gate project questions but never
// satisfy a kernel evidence kind.
export const isObservation = tag => typeof tag === 'string' && /^[a-z][a-z\d-]*:[a-z\d][a-z\d.-]*$/.test(tag);

// Installed project operations are extensions: they run, but own no slot,
// evidence or privileged fact.
const EXTENSION = Object.freeze(contract([]));
export const operationContract = operation => OPERATIONS[operation] ?? EXTENSION;
// A node name that matches another operation's slot must not fill that slot.
export const ownsStepSlot = (key, operation) => !RESERVED.has(key) || RESERVED.get(key) === operation;
// Legacy pinned graphs carry no explicit binding; their node names were the
// standard slots, and validation reserves those names for matching operations.
export function nodeBinding(key, node, operation = node?.action?.operation) {
  if (!operation) return null;
  const { bindings } = operationContract(operation);
  return node?.binding ?? (bindings.includes(key) ? key : bindings[0] ?? null);
}
// Settlement passes the operation pinned in the attempt intent, which is what ran.
export const nodeContract = (key, node, operation = node?.action?.operation) => {
  if (!operation) return { operation: null, binding: null, mints: isObservation(node?.evidence) ? node.evidence : null, preserveInput: node?.preserveInput === true, heavy: node?.heavy === true, requiresDecision: false, privileged: [] };
  const row = operationContract(operation);
  return { ...row, operation, mints: row.mints ?? (isObservation(node?.evidence) ? node.evidence : null), binding: nodeBinding(key, node, operation), preserveInput: row.preserveInput || node?.preserveInput === true, heavy: row.heavy || node?.heavy === true };
};
export function bindingNode(workflow, binding) {
  const matches = Object.entries(workflow.nodes).filter(([key, node]) => node.kind === 'effect' && node.action && nodeBinding(key, node) === binding).map(([key]) => key);
  return matches.length === 1 ? matches[0] : null;
}
// Fields a result may carry only when its operation owns them.
export function adoptableResult(operation, result) {
  if (!result || typeof result !== 'object') return result;
  const allowed = new Set(operation ? operationContract(operation).privileged : []);
  return Object.fromEntries(Object.entries(result).filter(([field]) => !PRIVILEGED.has(field) || allowed.has(field)));
}

// Static checks layered on validateWorkflow(): known operations, owned slots,
// no contradictory or forged guard declarations.
export function validateOperations(workflow) {
  for (const [key, node] of Object.entries(workflow.nodes)) {
    if (node.kind !== 'effect') continue;
    if (!node.action) {
      assert((node.evidence === undefined || isObservation(node.evidence)) && !node.requireDecision && !node.binding, `trusted command ${key} cannot claim kernel evidence, decisions or result bindings`);
      continue;
    }
    const row = operationContract(node.action.operation);
    assert(node.binding === undefined || row.bindings.includes(node.binding), `operation ${node.action.operation} cannot bind ${node.binding}`);
    assert(node.evidence === undefined || node.evidence === row.mints || (!row.mints && isObservation(node.evidence)), `operation ${node.action.operation} cannot mint ${node.evidence} evidence`);
    for (const flag of ['preserveInput', 'heavy', 'requireDecision']) assert(node[flag] === undefined || typeof node[flag] === 'boolean', `${flag} must be boolean`);
    assert(node.preserveInput !== false || !row.preserveInput, `operation ${node.action.operation} always preserves its input`);
    assert(node.heavy !== false || !row.heavy, `operation ${node.action.operation} always requires a heavy resource lease`);
    assert(node.requireDecision !== false || !row.requiresDecision, `operation ${node.action.operation} always requires a current decision`);
    // A failed fast check must never fall through to the step after a pass (normally review).
    if (node.action.operation === 'fastCheck') assert(['pass', 'fail'].every(route => typeof node.resultEdges?.[route] === 'string'), `fast check ${key} must route pass and fail explicitly`);
  }
  const slots = Object.entries(workflow.nodes).filter(([, node]) => node.action).map(([key, node]) => nodeBinding(key, node)).filter(Boolean);
  for (const slot of ['plan', 'build', 'merge', 'cleanup', 'integrate', 'publish', 'source']) assert(slots.filter(value => value === slot).length <= 1, `ambiguous ${slot} binding`);
  for (const [key, node] of Object.entries(workflow.nodes)) if (node.kind === 'question') for (const tag of node.requireEvidence ?? []) assert(EVIDENCE_KINDS.includes(tag) || isObservation(tag), `question ${key} requires unknown evidence ${tag}`);
  // "Proceed with this plan" sends the plan where a ready plan goes (normally plan review), never past it.
  const plan = bindingNode(workflow, 'plan');
  for (const key of planQuestionSteps(workflow)) {
    const target = workflow.nodes[key].answers?.[PLAN_PROCEED];
    if (target !== undefined) assert(target === (workflow.nodes[plan].resultEdges?.ready ?? workflow.nodes[plan].next), `plan question ${key} must send ${PLAN_PROCEED} to the step a ready plan goes to`);
  }
}
// The answer that sends a ready plan carrying the planner's non-blocking questions on as it is.
export const PLAN_PROCEED = 'proceed';
// The question steps a bound step's results route to: plan questions (binding plan), build questions (binding build).
export function resultQuestionSteps(workflow, binding) {
  const step = workflow?.nodes ? bindingNode(workflow, binding) : null; if (!step) return [];
  return [...new Set(Object.values(workflow.nodes[step].resultEdges ?? {}))].filter(key => workflow.nodes[key]?.kind === 'question');
}
export const planQuestionSteps = workflow => resultQuestionSteps(workflow, 'plan');

// Commissioned requirement profile. The standard profile reproduces the
// reference safeguards; a project relaxes or adds them only through configuration.
export const STANDARD_REQUIREMENTS = Object.freeze({ merge: Object.freeze({ evidence: Object.freeze(['review', 'gate']) }), satisfied: Object.freeze({ evidence: Object.freeze(['review', 'gate']) }) });
export function validateRequirements(input) {
  if (input === undefined) return;
  assert(input && typeof input === 'object' && !Array.isArray(input), 'requirements must be an object');
  for (const [outcome, value] of Object.entries(input)) {
    assert(['merge', 'satisfied'].includes(outcome), `unsupported requirement outcome: ${outcome}`);
    assert(value && Array.isArray(value.evidence) && Object.keys(value).every(key => key === 'evidence'), `${outcome} requirements need an evidence list`);
    assert(value.evidence.every(tag => EVIDENCE_KINDS.includes(tag)) && new Set(value.evidence).size === value.evidence.length, `${outcome} requirements name unknown or duplicate evidence`);
  }
}
// Document flows merge on a passing review alone; their graph may still ask for more.
export const requiredEvidence = (config, outcome, flow) => flow?.pool === 'document' ? ['review'] : [...(config?.requirements?.[outcome]?.evidence ?? STANDARD_REQUIREMENTS[outcome].evidence)];

// Fresh evidence must match the exact candidate and come from a passed attempt.
export function assertEvidence(flow, identity, tags) {
  for (const tag of tags) {
    const row = flow.evidence?.[tag];
    if (row?.treeDigest !== identity.treeDigest || row?.head !== identity.head || !row?.attemptId) throw new Error(`fresh ${tag} evidence required`);
  }
}
