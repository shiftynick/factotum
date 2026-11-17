import { assert } from './contracts.mjs';

// Operator actions the orchestrator may carry out on a recorded operator
// instruction, when the commissioned policy lists them. The instruction is
// attribution for the audit trail, not proof: the authority comes from the
// operator commissioning policy.delegatedOperations.
export const DELEGABLE = Object.freeze(['answer', 'cleanup.apply', 'config.update', 'settings.update', 'models.update', 'doctor.request', 'task.restart', 'attempt.resolve', 'restore.release', 'spending.reconcile', 'task.put', 'task.label', 'task.schedule', 'schedule.pause', 'recurring.run', 'task.approve', 'task.revoke', 'regression.record', 'pause', 'stop', 'resume', 'stop.all', 'queue.put', 'main.health', 'schedule.put', 'schedule.remove', 'obligation.resolve', 'flow.replan', 'flow.note', 'flow.abandon', 'job.enqueue', 'operator.presence', 'finding.accept', 'finding.resolve', 'finding.reopen', 'flow.disposeFinding']);
// Operator and orchestrator work as a team: most operator commands are delegable.
// Strict-review sign-off stays human; deploy and spending approvals (integration
// decisions) need policy.delegateIntegrationDecisions; both are enforced where
// questions are answered. Operator authority itself is never delegable: issuing or
// revoking grants and directly disposing of, revoking or ratifying a durable
// decision (slice C). On a migrated project, task.approve and decision answers also
// need either the operator directly or a stored grant entry covering their exact
// scope (core/grants.mjs); listing them here is operational delegation only.
export const NEVER_DELEGABLE = Object.freeze(['grant.issue', 'grant.revoke', 'decision.dispose', 'decision.revoke', 'decision.ratify']);
// Without an explicit list every delegable operation is delegated; [] turns delegation off.
export const delegatedOperations = config => config?.policy?.delegatedOperations ?? DELEGABLE;

export function validateDelegatedOperations(list) {
  if (list === undefined) return;
  assert(Array.isArray(list) && new Set(list).size === list.length, 'policy.delegatedOperations must be a list of unique operations');
  for (const operation of list) assert(DELEGABLE.includes(operation), NEVER_DELEGABLE.includes(operation) ? `${operation} cannot be delegated` : `unknown or non-operator operation ${operation}`);
}
export function validateOnBehalfOf(onBehalfOf, actor) {
  if (onBehalfOf === undefined) return;
  assert(actor === 'orchestrator', 'only the orchestrator acts on behalf of the operator');
  assert(onBehalfOf && typeof onBehalfOf === 'object' && Object.keys(onBehalfOf).every(key => ['principal', 'instruction', 'reference'].includes(key)), 'onBehalfOf supports principal, instruction and reference');
  assert(onBehalfOf.principal === 'operator', 'onBehalfOf.principal must be operator');
  assert(typeof onBehalfOf.instruction === 'string' && onBehalfOf.instruction.trim() && onBehalfOf.instruction.length <= 2000, 'onBehalfOf.instruction must quote or summarize the operator instruction (at most 2000 characters)');
  assert(onBehalfOf.reference === undefined || typeof onBehalfOf.reference === 'string' && onBehalfOf.reference.length <= 500, 'onBehalfOf.reference must be at most 500 characters');
}
// Operator authority: the operator itself, or a commissioned delegation used with a recorded instruction.
export function operatorAuthority(store, { operation, actor, onBehalfOf }) {
  if (actor === 'operator') return 'operator';
  const delegated = delegatedOperations(store.meta('config', {}));
  if (onBehalfOf && delegated.includes(operation) && !NEVER_DELEGABLE.includes(operation)) return 'delegated';
  // Only an operation that can be delegated (DELEGABLE) can be listed; the others stay with the operator.
  if (!DELEGABLE.includes(operation)) throw new Error(`operator authority required: ${operation} is operator only and cannot be delegated (policy.delegatedOperations cannot list it); the operator must run it directly`);
  throw new Error(onBehalfOf
    ? `${operation} is not delegated to the orchestrator; the operator can list it in policy.delegatedOperations`
    : 'operator authority required; the orchestrator can act on a recorded operator instruction (onBehalfOf) only for operations in policy.delegatedOperations');
}
// One rule for manual maintenance job grants, used at enqueue-check, admission and every engine step:
// the operator, or the orchestrator acting on a recorded operator instruction.
export const manualJobGrant = grant => grant?.actor === 'operator' || grant?.actor === 'orchestrator' && Boolean(grant.onBehalfOf);
