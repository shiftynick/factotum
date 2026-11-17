import { assert, digest, note, now } from '../core/contracts.mjs';
import { commissionedGraphs } from '../core/catalog.mjs';
import { flowWorkflowKey, modelRole, MODEL_EFFORTS, stepSpec, validateStepModelShape } from '../core/step-models.mjs';
import { UPKEEP_MODEL_WORKFLOW } from '../core/upkeep-config.mjs';
import { upkeepSelectionConfig } from './upkeep-route.mjs';

// Live model defaults are an overlay on project-owned config.stepModels. They
// affect admission only; each admitted flow retains its complete provider routes.
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => value && Object.hasOwn(value, key) ? value[key] : undefined;
export const modelDefaults = store => store.meta('modelDefaults', {});
export const modelSettingsVersion = store => digest({ config: store.meta('configDigest'), graphs: commissionedGraphs(store), defaults: modelDefaults(store) });
const selection = spec => ({ provider: spec.provider, model: spec.model, effort: spec.effort ?? null });
// The step's effective turn limit, shown with its selection when the route sets one (dev.84 review fix).
const turns = spec => Number.isSafeInteger(spec.maxTurns) ? { maxTurns: spec.maxTurns } : {};

function validateRoute(config, spec, label) {
  const routes = [[spec, label]];
  // Match the adapter's effective fallback, including inherited effort and
  // allowlist. A primary edit must not leave a fallback that can never launch.
  if (spec.allowFallback && spec.fallback) routes.push([
    { ...spec, ...spec.fallback, allowedModels: spec.fallback.allowedModels ?? spec.allowedModels }, `${label}.fallback`,
  ]);
  for (const [route, name] of routes) {
    validateStepModelShape({ workflow: { [name]: selection(route) } });
    assert((route.billingMode ?? 'subscription') === 'subscription', `${name}: only subscription-backed models are enabled`);
    assert(route.effort === undefined || MODEL_EFFORTS[route.provider]?.includes(route.effort), `${name}: unsupported ${route.provider} effort`);
    assert(route.allowedModels === undefined || Array.isArray(route.allowedModels) && route.allowedModels.includes(route.model), `${name}: model is outside allowedModels`);
  }
}

// A live provider switch may use a provider already declared by the project.
// The destination's declared allowlists still apply; switching cannot erase them.
function applySelection(config, role, primary, override, label) {
  if (!override) return primary;
  const spec = stepSpec(primary, override);
  if (spec.provider !== primary.provider || spec.provider !== config.providers[role].provider) {
    const declared = [...Object.values(config.providers ?? {}), ...Object.values(config.stepModels ?? {}).flatMap(steps => Object.values(steps))].filter(row => row.provider === spec.provider);
    assert(declared.length, `${label}: provider ${spec.provider} is not configured; commission it first`);
    const providerRoles = Object.values(config.providers ?? {}).filter(row => row.provider === spec.provider);
    const allowed = providerRoles.length && providerRoles.every(row => Array.isArray(row.allowedModels))
      ? [...new Set([...providerRoles.flatMap(row => row.allowedModels), ...declared.filter(row => !providerRoles.includes(row)).map(row => row.model)])] : null;
    if (allowed) spec.allowedModels = allowed;
  }
  validateRoute(config, spec, label);
  return spec;
}

// A task choice may only name a model the project already configured for that provider:
// listed in a role's allowedModels, or used by a provider role or step route. A provider
// without an allowlist therefore allows only the models already configured for it.
// A step route without its own provider uses its step's role provider; when that step's
// workflow graph is not at hand, such an entry is not counted (conservative).
function assertConfiguredTaskModel(config, role, choice, label, graphs = {}) {
  const provider = choice.provider ?? config.providers[role].provider, model = choice.model;
  if (model === undefined) return;
  const stepRows = Object.entries(config.stepModels ?? {}).flatMap(([workflow, steps]) => Object.entries(steps ?? {}).map(([step, row]) => {
    if (!row) return null;
    if (row.provider) return row;
    const node = graphs[workflow]?.nodes?.[step], stepRole = node && modelRole(step, node, config);
    return stepRole && config.providers?.[stepRole] ? { ...row, provider: config.providers[stepRole].provider } : null;
  })).filter(Boolean);
  const rows = [...Object.values(config.providers ?? {}), ...stepRows].filter(row => row?.provider === provider);
  const configured = new Set(rows.flatMap(row => [row.model, ...(Array.isArray(row.allowedModels) ? row.allowedModels : [])]).filter(Boolean));
  assert(configured.has(model), `${label}: model ${model} is outside allowedModels and the models configured for provider ${provider}`);
}
// Per-task model choice: task.models maps a provider role to a selector. It is
// not part of the approved brief; it applies to every model step of that role
// when a flow is admitted, below a run's per-step modelOverrides.
export const TASK_MODEL_ROLES = Object.freeze(['planner', 'builder', 'reviewer']);
export function validateTaskModelShape(models) {
  assert(object(models) && Object.keys(models).length > 0 && Object.keys(models).every(role => TASK_MODEL_ROLES.includes(role)), `task models map ${TASK_MODEL_ROLES.join(', ')} to {model, provider?, effort?}`);
  validateStepModelShape({ task: models });
}

export function selectFlowModels(config, workflow, graph, defaults = {}, overrides = {}, taskModels = {}) {
  assert(object(overrides), 'modelOverrides must map step IDs to model settings');
  if (Object.keys(taskModels ?? {}).length) validateTaskModelShape(taskModels);
  const live = own(defaults, workflow) ?? {};
  validateStepModelShape({ [workflow]: live });
  validateStepModelShape({ [workflow]: overrides });
  for (const step of [...Object.keys(live), ...Object.keys(overrides)]) {
    assert(Object.hasOwn(graph.nodes, step) && modelRole(step, graph.nodes[step], config), `${workflow}.${step} is not a model step of that workflow`);
  }
  const routes = {}, steps = {};
  for (const [step, node] of Object.entries(graph.nodes)) {
    const role = modelRole(step, node, config);
    if (!role) continue;
    assert(config.providers?.[role], `${workflow}.${step}: configure the ${role} provider first`);
    const project = own(own(config.stepModels, workflow), step), saved = own(live, step), chosen = own(taskModels, role), override = own(overrides, step);
    let spec = stepSpec(config.providers[role], project);
    spec = applySelection(config, role, spec, saved, `${workflow}.${step}`);
    spec = applySelection(config, role, spec, chosen, `${workflow}.${step} (task ${role} choice)`);
    // Check the effective provider and model this step will run, not just the role's provider.
    if (chosen) assertConfiguredTaskModel(config, role, { provider: spec.provider, model: spec.model }, `${workflow}.${step} (task ${role} choice)`, { [workflow]: graph });
    spec = applySelection(config, role, spec, override, `${workflow}.${step}`);
    // A run override is a per-flow choice the orchestrator can make directly: same rule as a task choice.
    if (override) assertConfiguredTaskModel(config, role, { provider: spec.provider, model: spec.model }, `${workflow}.${step} (run override)`, { [workflow]: graph });
    if ((saved || chosen || override) && spec.provider === config.providers[role].provider && config.providers[role].allowedModels) spec = { ...spec, allowedModels: config.providers[role].allowedModels };
    validateRoute(config, spec, `${workflow}.${step}`);
    routes[step] = structuredClone(spec);
    steps[step] = { role, operation: node.action.operation, ...selection(spec), ...turns(spec), source: Object.hasOwn(overrides, step) ? 'run' : chosen ? 'task' : Object.hasOwn(live, step) ? 'live' : project ? 'step' : 'role' };
  }
  // Builder and reviewer may come from the same model family; review evidence records the pairing.
  return { modelRoutes: routes, modelSelection: { workflow, steps, overrides: structuredClone(overrides), ...(Object.keys(taskModels ?? {}).length ? { taskModels: structuredClone(taskModels) } : {}), digest: digest(routes) } };
}

// Check a task's model choice against the task's commissioned workflow when there
// is one, and against the configured provider roles otherwise. A choice outside the
// configured providers or their allowedModels is a project setting change: refused.
export function validateTaskModels(store, task, models, workflow) {
  validateTaskModelShape(models);
  const config = store.meta('config', {});
  assert(config.mode === 'delivery', 'task models need a delivery project');
  const graphs = commissionedGraphs(store);
  try {
    if (workflow && Object.hasOwn(graphs, workflow)) { selectFlowModels(config, workflow, graphs[workflow], modelDefaults(store), {}, models); return; }
    for (const [role, choice] of Object.entries(models)) {
      assert(config.providers?.[role], `configure the ${role} provider first`);
      applySelection(config, role, config.providers[role], choice, `task ${role} choice`);
      assertConfiguredTaskModel(config, role, choice, `task ${role} choice`, graphs);
    }
  } catch (error) { throw new Error(`${error.message}. A model outside the project's configured providers and allowedModels is a project setting change (config update), not a task choice`); }
}

export function validateModelDefaults(config, graphs, defaults) {
  validateStepModelShape(defaults);
  for (const workflow of Object.keys(defaults)) assert(Object.hasOwn(graphs, workflow), `model defaults name unknown workflow ${workflow}; reset its defaults before changing the catalog, or use config update --replace-live`);
  for (const [workflow, graph] of Object.entries(graphs)) selectFlowModels(config, workflow, graph, defaults);
}

export function pinFlowModels(store, flow, overrides = {}, taskModels = {}) {
  if (flow.modelRoutes) return;
  // The upkeep assessment's model is selected under its pinned route (operations/upkeep-route.mjs).
  const workflow = flowWorkflowKey(flow), config = workflow === UPKEEP_MODEL_WORKFLOW ? upkeepSelectionConfig(store) : store.meta('config', {});
  Object.assign(flow, selectFlowModels(config, workflow, flow.workflow, modelDefaults(store), overrides, taskModels));
  flow.modelSelection.defaultsVersion = modelSettingsVersion(store);
  flow.modelSelection.by = store.commandActor ?? 'factory';
}

export function updateModelDefaults(store, payload, actor) {
  assert(object(payload) && Object.keys(payload).every(key => ['workflow', 'changes', 'expectedVersion', 'note'].includes(key)), 'models.update accepts workflow, changes, expectedVersion and note');
  note(payload.note);
  assert(payload.expectedVersion === modelSettingsVersion(store), 'model settings changed since they were read; refresh and try again');
  const graphs = commissionedGraphs(store), workflow = payload.workflow;
  assert(typeof workflow === 'string' && Object.hasOwn(graphs, workflow), 'models.update needs a commissioned workflow');
  assert(object(payload.changes) && Object.keys(payload.changes).length > 0 && Object.keys(payload.changes).length <= 64, 'models.update needs changes: {step: {model, provider?, effort?} | null}');
  const defaults = structuredClone(modelDefaults(store)), steps = { ...(own(defaults, workflow) ?? {}) };
  for (const [step, value] of Object.entries(payload.changes)) {
    assert(Object.hasOwn(graphs[workflow].nodes, step) && modelRole(step, graphs[workflow].nodes[step], store.meta('config')), `${workflow}.${step} is not a model step of that workflow`);
    if (value === null) delete steps[step]; else Object.defineProperty(steps, step, { value, enumerable: true, configurable: true, writable: true });
  }
  if (Object.keys(steps).length) Object.defineProperty(defaults, workflow, { value: steps, enumerable: true, configurable: true, writable: true }); else delete defaults[workflow];
  validateModelDefaults(upkeepSelectionConfig(store), graphs, defaults);
  // Upgrades can carry waiting task flows forward. Pin legacy open flows before
  // the first live edit, too, so they never acquire a new default accidentally.
  for (const flow of store.live('flow').filter(flow => !['completed', 'failed'].includes(flow.state) && !flow.modelRoutes)) {
    pinFlowModels(store, flow); store.put('flow', flow);
  }
  store.setMeta('modelDefaults', defaults);
  store.event('models.updated', { workflow, changes: payload.changes, by: actor, note: payload.note, at: now() });
  return { workflow, defaults: own(defaults, workflow) ?? {}, version: modelSettingsVersion(store), appliesTo: 'new-flows' };
}

export function modelSettingsView(store) {
  const config = upkeepSelectionConfig(store), defaults = modelDefaults(store), rows = [];
  for (const [workflow, graph] of Object.entries(commissionedGraphs(store))) {
    const { modelSelection, modelRoutes } = selectFlowModels(config, workflow, graph, defaults);
    for (const [step, row] of Object.entries(modelSelection.steps)) rows.push({ workflow, step, ...row, override: own(own(defaults, workflow), step) ?? null, projectDefault: own(own(config.stepModels, workflow), step) ?? null, allowedModels: modelRoutes[step].allowedModels ?? null });
  }
  return rows;
}

// Export effective live defaults into an ordinary project-owned configuration.
export function configWithModelDefaults(store) {
  const config = structuredClone(store.meta('config', {}));
  for (const row of modelSettingsView(store).filter(row => row.source === 'live')) {
    config.stepModels ??= {}; if (!Object.hasOwn(config.stepModels, row.workflow)) config.stepModels[row.workflow] = {};
    // Step-level fields beyond the selection survive the export: a live default replaces the step's
    // provider, model and effort; its turn limit is the live one, else the project's (as the route has it).
    const project = own(own(config.stepModels, row.workflow), row.step) ?? {}, maxTurns = row.override?.maxTurns ?? project.maxTurns;
    config.stepModels[row.workflow][row.step] = { ...selection(row), ...(maxTurns !== undefined ? { maxTurns } : {}) };
  }
  return config;
}
