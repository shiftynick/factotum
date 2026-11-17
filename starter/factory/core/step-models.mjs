import { assert } from './contracts.mjs';
import { nodeContract } from './operations.mjs';
import { UPKEEP_MODEL_WORKFLOW, UPKEEP_OPERATION, usableProviderRoute } from './upkeep-config.mjs';

// Per-step model defaults: config.stepModels[workflow][step] overrides the
// provider role's provider/model/effort (and maxTurns, dev.84) for that LLM step only. Workflow keys
// are catalog names, or 'standard' without a catalog.
const FIELDS = ['provider', 'model', 'effort', 'maxTurns'];
// The provider turns a model step may take (Claude --max-turns). Shared by providers.<role> and stepModels.
export const MAX_TURNS_LIMIT = 500;
export const validMaxTurns = value => value === undefined || Number.isSafeInteger(value) && value >= 1 && value <= MAX_TURNS_LIMIT;
export const flowWorkflowKey = flow => flow.kind === 'maintenance' ? `maintenance/${flow.workflow.nodes[flow.workflow.start]?.action?.operation ?? 'custom'}` : flow.workflowName ?? 'standard';
// Built-in maintenance has two model-using workflows: the audit, and the knowledge-upkeep assessment
// (knowledge-upkeep design, 6.3). Their namespace contains a slash, which cannot collide with a
// project catalog name. Both are present for every delivery project, whatever upkeep's mode: a
// stored step model for the assessment must stay valid when the mode is turned down.
const builtinGraph = (operation, timeoutMs) => ({ version: 1, start: 'run', nodes: { run: { kind: 'effect', action: { operation }, timeoutMs, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } });
export const withBuiltinModelGraphs = (config, graphs) => config.mode !== 'delivery' ? graphs : { ...graphs, 'maintenance/audit': builtinGraph('audit', config.timeouts?.audit ?? 600000), [UPKEEP_MODEL_WORKFLOW]: builtinGraph(UPKEEP_OPERATION, config.timeouts?.[UPKEEP_OPERATION] ?? 600000) };
// The assessment's role is the optional providers.upkeep, falling back to the reviewer (Q5). A
// stored providers.upkeep that is not a usable route (an earlier release ignored the key) is not
// used: the role falls back, and validateConfig refuses the value at the next configuration write.
// Where a model is selected for the step, the configuration passed in carries the pinned route as
// providers.upkeep (operations/upkeep-route.mjs), so the fallback is to the reviewer's route as it
// was when upkeep was turned on, not as it is now.
export const usableProviderRole = usableProviderRoute;
export const upkeepModelRole = config => usableProviderRole(config?.providers?.upkeep) ? 'upkeep' : 'reviewer';
export const modelRole = (step, node, config) => node?.kind !== 'effect' ? null : node.action?.operation === 'audit' ? (config.providers?.auditor ? 'auditor' : 'reviewer') : node.action?.operation === UPKEEP_OPERATION ? upkeepModelRole(config) : nodeContract(step, node).role;
export const MODEL_EFFORTS = Object.freeze({ codex: ['minimal', 'low', 'medium', 'high', 'xhigh'], claude: ['low', 'medium', 'high', 'xhigh', 'max'] });

export function validateStepModelShape(stepModels) {
  if (stepModels === undefined) return;
  assert(stepModels && typeof stepModels === 'object' && !Array.isArray(stepModels), 'stepModels must map workflows to steps');
  for (const [workflow, steps] of Object.entries(stepModels)) {
    assert(steps && typeof steps === 'object' && !Array.isArray(steps), `stepModels.${workflow} must map step IDs to models`);
    for (const [step, spec] of Object.entries(steps)) {
      assert(spec && typeof spec === 'object' && !Array.isArray(spec) && Object.keys(spec).every(key => FIELDS.includes(key)), `stepModels.${workflow}.${step} supports only ${FIELDS.join(', ')}`);
      assert(typeof spec.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(spec.model) && spec.model.length <= 200, `stepModels.${workflow}.${step} needs a model identifier`);
      assert(spec.provider === undefined || ['codex', 'claude'].includes(spec.provider), `stepModels.${workflow}.${step} has an unsupported provider`);
      assert(spec.effort === undefined || spec.effort === null || typeof spec.effort === 'string' && spec.effort, `stepModels.${workflow}.${step} has an invalid effort`);
      assert(validMaxTurns(spec.maxTurns), `stepModels.${workflow}.${step}.maxTurns must be a whole number from 1 to ${MAX_TURNS_LIMIT}`);
    }
  }
}
// Every override must name an LLM step of a commissioned graph, and stay within
// the role's model allowlist.
export function validateStepModels(config, graphs) {
  for (const [workflow, steps] of Object.entries(config.stepModels ?? {})) {
    const graph = Object.hasOwn(graphs, workflow) ? graphs[workflow] : null;
    assert(graph, `stepModels names unknown workflow ${workflow}`);
    for (const [step, spec] of Object.entries(steps)) {
      const role = modelRole(step, Object.hasOwn(graph.nodes, step) ? graph.nodes[step] : null, config);
      assert(role, `stepModels.${workflow}.${step} is not a model step of that workflow`);
      const effective = stepSpec(config.providers?.[role], spec);
      assert(!Array.isArray(effective.allowedModels) || effective.allowedModels.includes(effective.model), `stepModels.${workflow}.${step} model is outside the ${role} allowedModels list`);
      assert(effective.effort === undefined || MODEL_EFFORTS[effective.provider]?.includes(effective.effort), `stepModels.${workflow}.${step} has an unsupported ${effective.provider} effort`);
    }
  }
}
// Changing provider drops the role's fallback and allowlist, which describe the
// role's own provider.
export function stepSpec(primary, override) {
  if (!override) return primary;
  let base = primary;
  if (override.provider && override.provider !== primary.provider) { const { fallback, allowFallback, allowedModels, effort, ...rest } = primary; base = { ...rest, allowFallback: false }; }
  const result = { ...base, ...override };
  if (result.effort === null) delete result.effort;
  return result;
}
// Settings projection: each model step with its effective provider/model.
export function stepModelView(config, graphs) {
  return Object.entries(graphs).flatMap(([workflow, graph]) => Object.entries(graph.nodes).flatMap(([step, node]) => {
    const role = modelRole(step, node, config), operation = node.action?.operation;
    if (!role || !config.providers?.[role]) return [];
    const override = config.stepModels?.[workflow]?.[step], spec = stepSpec(config.providers[role], override);
    return [{ workflow, step, operation, role, provider: spec.provider ?? null, model: spec.model ?? null, effort: spec.effort ?? null, ...(Number.isSafeInteger(spec.maxTurns) ? { maxTurns: spec.maxTurns } : {}), source: override ? 'step' : 'role' }];
  }));
}
