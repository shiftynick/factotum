// Authority-bearing policy (plans 7/8, slice C): the parts of a configuration that
// decide who may approve, answer or merge. On a migrated project only the operator,
// directly, may change them; a delegated config.update or settings.update that would
// change any of them is refused. The comparison is of effective normalized policy:
// defaults applied, so omitting a key (as a replaceLive file can) is a change if it
// widens the default, and catalog question roles are compared as compiled.
import { digest } from './contracts.mjs';
import { DELEGABLE } from './delegation.mjs';
import { delegatedUpkeepChanges, upkeepAuthority } from './upkeep-config.mjs';

const QUESTION_FLAGS = ['role', 'mergeDecision', 'satisfiedDecision', 'integrationDecision', 'strictReview', 'autoMerge'];
export const UPKEEP_AUTHORITY = 'knowledge upkeep';
function questionRoles(workflow) {
  return Object.fromEntries(Object.entries(workflow?.nodes ?? {}).filter(([, node]) => node.kind === 'question').map(([step, node]) => [step, { ...Object.fromEntries(QUESTION_FLAGS.filter(k => node[k] !== undefined).map(k => [k, node[k]])), answers: Object.keys(node.answers ?? {}).sort() }]));
}
export function authorityPolicy(config, { catalog, workflow } = {}) {
  const policy = config?.policy ?? {};
  return {
    'policy.delegatedOperations': [...(policy.delegatedOperations ?? DELEGABLE)].sort(),
    'policy.delegateIntegrationDecisions': policy.delegateIntegrationDecisions === true,
    'policy.mergeDecisionRole': policy.mergeDecisionRole ?? 'operator',
    'policy.strictDecisionRole': policy.strictDecisionRole ?? 'operator',
    'policy.autoMerge': policy.autoMerge === true,
    // Recurring tasks are created already approved: their templates are approval authority.
    recurringTasks: config?.recurringTasks ?? {},
    // Integration workflows declare which decisions authorize their writes.
    integrationWorkflows: config?.integrationWorkflows ?? {},
    // What knowledge upkeep may create and how large (core/upkeep-config.mjs): its mode, docs scope,
    // caps, budgets, model role and the learnings directory.
    [UPKEEP_AUTHORITY]: upkeepAuthority(config),
    'workflow question roles': catalog ? Object.fromEntries(Object.entries(catalog.workflows ?? {}).map(([name, row]) => [name, questionRoles(row.workflow)])) : { default: questionRoles(workflow) },
  };
}
// The authority-bearing keys that differ between the current configuration and a proposed one.
export function authorityPolicyChanges(store, before, after, { catalog, workflow } = {}) {
  const current = authorityPolicy(before, { catalog: store.meta('catalog'), workflow: store.meta('workflow') });
  const proposed = authorityPolicy(after, { catalog: catalog === undefined ? store.meta('catalog') : catalog, workflow: workflow ?? store.meta('workflow') });
  // One exception: turning upkeep's mode down widens nothing, so it is not a change of authority.
  return Object.keys(current).filter(key => key === UPKEEP_AUTHORITY ? delegatedUpkeepChanges(before, after).length > 0 : digest(current[key]) !== digest(proposed[key]));
}
