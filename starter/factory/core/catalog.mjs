import { upgradeOwned } from './install-layout.mjs';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { assert, assertTargetBranch, digest, id, validateWorkflow } from './contracts.mjs';
import { changeWorkflow, documentWorkflow, insertPreview } from './configuration.mjs';
import { validateStepModels, withBuiltinModelGraphs } from './step-models.mjs';
import { nodeContract } from './operations.mjs';
import { REFERENCE_KINDS, WORKFLOW_KINDS, definitionKind, referenceKind } from './workflow-kinds.mjs';

// Project-owned delivery workflows. The catalog lives in project configuration
// (so it is part of the commissioned config digest); graph files live in the
// project checkout outside factory/. Commissioning compiles every definition
// once and pins its exact source bytes. Editing a file is never a live reload.
// Workflow kinds: `change` builds and merges a candidate; `document` writes and merges a
// document, reviewed but with no check gate, in its own capacity pool; `task` is work carried
// out by a person or the orchestrator, completed by their report, with no worktree or merge.
export { WORKFLOW_KINDS, referenceKind };
// Each reference's kind is the one core/workflow-kinds.mjs gives it; a reference without one there is refused at load.
const BUILDERS = { 'change.standard': config => changeWorkflow(config), 'change.document': config => documentWorkflow(config), 'task.orchestrator': () => taskWorkflow('orchestrator'), 'task.operator': () => taskWorkflow('operator') };
const REFERENCES = Object.fromEntries(Object.entries(BUILDERS).map(([name, build]) => { assert(referenceKind(name), `reference workflow ${name} has no kind`); return [name, { kind: referenceKind(name), build }]; }));
assert(Object.keys(REFERENCE_KINDS).every(name => Object.hasOwn(BUILDERS, name)), 'a reference kind names no reference workflow');
export const referenceWorkflow = (name, config) => { assert(REFERENCES[name], `unknown workflow reference ${name}`); return REFERENCES[name].build(config); };
// Reference task workflows: one role carries the task out and reports. Done closes the
// task (and its source issue, under the project's closeTasks policy); blocked returns it
// to the operator with the note; stop ends it.
export function taskWorkflow(role) {
  const day = 86400000, ask = role === 'orchestrator' ? 'Carry out this task and report: done, blocked (add a note saying why), or stop.' : 'This task needs you. Do it, then report done, blocked (add a note), or stop.';
  return { version: 1, start: 'carry-out', maxTransitions: 40, nodes: {
    'carry-out': { kind: 'question', role, question: ask, answers: { done: 'close', blocked: 'review-blocked', stop: 'stopped' }, maxVisits: 10, expiryMs: 14 * day, ...(role === 'orchestrator' ? { remind: 'never' } : { remind: day }) },
    'review-blocked': { kind: 'question', role: 'operator', question: 'This task was reported blocked. Read the note, then send it back to be carried out, or stop it.', answers: { retry: 'carry-out', stop: 'stopped' }, expiryMs: 14 * day, remind: day },
    close: { kind: 'effect', action: { operation: 'forge.closeTask' }, timeoutMs: 120000, next: 'done', onFailure: 'done' },
    done: { kind: 'end', outcome: 'completed' }, stopped: { kind: 'end', outcome: 'stopped' },
  } };
}
const MAX_BYTES = 256 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const workflowIdentityDigest = (workflow, target) => digest(target ? { workflow, target } : workflow);

export function validateCatalogConfig(catalog) {
  if (catalog === undefined) return;
  assert(catalog && typeof catalog === 'object' && !Array.isArray(catalog) && Object.keys(catalog).every(key => ['definitions', 'selection'].includes(key)), 'workflows must contain definitions and selection');
  const names = Object.keys(catalog.definitions ?? {});
  assert(names.length > 0 && names.length <= 16, 'workflows.definitions needs 1-16 entries');
  for (const name of names) {
    id(name, 'workflow name');
    const definition = catalog.definitions[name], keys = Object.keys(definition ?? {});
    assert(keys.filter(key => ['reference', 'path'].includes(key)).length === 1 && keys.every(key => ['reference', 'path', 'kind', 'target'].includes(key)), `workflow ${name} needs exactly one of reference or path, and optionally kind and target`);
    // target: the branch this workflow's changes integrate into and merge to (default repository.target).
    if (definition.target !== undefined) assertTargetBranch(definition.target, `workflow ${name} target`);
    assert(definition.kind === undefined || WORKFLOW_KINDS.includes(definition.kind), `workflow ${name} kind must be change, document or task`);
    if (definition.reference !== undefined) { assert(REFERENCES[definition.reference], `workflow ${name} names an unknown reference`); assert(definition.kind === undefined || definition.kind === referenceKind(definition.reference), `workflow ${name} kind contradicts its reference`); }
    else projectPath(definition.path);
  }
  const selection = catalog.selection ?? {};
  assert(Object.keys(selection).every(key => ['default', 'rules'].includes(key)), 'workflows.selection supports default and rules');
  assert(selection.default === undefined || names.includes(selection.default), 'workflows.selection.default must name a definition');
  assert(selection.rules === undefined || Array.isArray(selection.rules) && selection.rules.length <= 64, 'workflows.selection.rules must be a list');
  // Rules are ordered; the first that matches a task's label or category selects its workflow.
  for (const rule of selection.rules ?? []) {
    const key = Object.keys(rule ?? {}).filter(k => k !== 'workflow');
    assert(rule && key.length === 1 && ['category', 'label'].includes(key[0]) && typeof rule[key[0]] === 'string' && rule[key[0]].trim() && names.includes(rule.workflow), 'each selection rule maps one task category or label to a defined workflow');
  }
}
function projectPath(path) {
  assert(typeof path === 'string' && path && !isAbsolute(path) && !path.includes('\0') && path.endsWith('.json'), 'workflow path must be a relative .json path');
  const parts = path.split('/');
  // Which factory/ is upgrade-owned depends on the install prefix, so readProjectFile checks that.
  assert(!parts.some(part => part === '' || part === '.' || part === '..'), 'workflow path must stay inside the project');
  return path;
}
// Read one ordinary file inside the checkout; no symlinks anywhere on the path.
function readProjectFile(root, path) {
  const rootReal = realpathSync(root), absolute = resolve(rootReal, projectPath(path)), owned = upgradeOwned(rootReal);
  assert(path !== owned.lock && !owned.files.includes(path) && !owned.dirs.some(dir => path.startsWith(dir)), `workflow path must stay outside the upgrade-owned ${owned.dirs[0]} (outside factory/ of the installation)`);
  assert(realpathSync(absolute) === absolute, `workflow ${path} must not be redirected through a symlink`);
  const stat = lstatSync(absolute);
  assert(stat.isFile() && stat.size <= MAX_BYTES, `workflow ${path} must be an ordinary file of at most ${MAX_BYTES} bytes`);
  return readFileSync(absolute);
}

// Commission-time checks beyond graph structure and operation contracts.
function validateDelivery(name, workflow, config) {
  const delegated = (config.policy?.mergeDecisionRole ?? 'operator') === 'orchestrator';
  for (const [key, node] of Object.entries(workflow.nodes)) {
    if (node.action?.operation === 'fastCheck') assert(config.fastChecks, `workflow ${name} runs fast checks at ${key}, but no fastChecks are configured`);
    if (node.kind !== 'question') continue;
    if (node.mergeDecision) assert(node.role === 'operator' || delegated, `workflow ${name} requests orchestrator merge decisions at ${key}, but policy.mergeDecisionRole does not delegate them`);
    if (node.satisfiedDecision) assert(node.role === 'operator', `workflow ${name} cannot delegate the already-satisfied decision at ${key}`);
  }
  validatePublishIntegration(name, workflow);
}

// Every way into forge.publish must start at the `integrated` result of workspace.integrate and pass
// only through steps that preserve their input (review, gate, fast checks, preview, or a node marked
// preserveInput; the engine fails such a step if the candidate changed). Then the candidate published
// is the one the factory integrated and checked against the target; forge.publish also checks that
// at run time (its HEAD must be the recorded integration's head). Anything else in between, such as
// a builder, a question (the operator may change the worktree) or a wait, could change the candidate
// after its upgrade-owned files were checked.
function validatePublishIntegration(name, workflow) {
  const nodes = workflow.nodes, contract = key => nodeContract(key, nodes[key]);
  const publishes = Object.keys(nodes).filter(key => contract(key).operation === 'forge.publish');
  if (!publishes.length) return;
  // Edges a step takes after it passes: its result routes, or `next` when it has none. Failure edges
  // (onFailure) are taken after a failed or changed attempt, so they never count as clean.
  const passEdges = node => node.resultEdges ? Object.entries(node.resultEdges) : [['next', node.next]];
  const incoming = new Map(Object.keys(nodes).map(key => [key, []]));
  for (const [from, node] of Object.entries(nodes)) {
    const labelled = node.kind === 'question' ? Object.entries(node.answers).map(([answer, to]) => [`answer ${answer}`, to])
      : ['effect', 'wait'].includes(node.kind) ? [...(node.kind === 'effect' ? passEdges(node) : [['next', node.next]]), ['onFailure', node.onFailure]] : [];
    for (const [label, to] of labelled) if (to && incoming.has(to)) incoming.get(to).push({ from, label, pass: label !== 'onFailure' && !label.startsWith('answer ') });
  }
  const integrates = key => nodes[key].kind === 'effect' && contract(key).operation === 'workspace.integrate';
  // A route out of integrate is clean only if it is taken on `integrated` (with no result routes,
  // `next` is taken on `conflict` too; forge.publish then refuses the conflicted integration at run time).
  const fromIntegration = edge => integrates(edge.from) && edge.pass && (nodes[edge.from].resultEdges ? edge.label === 'integrated' : true);
  // Greatest set of input-preserving effect steps reached only cleanly.
  const clean = new Set(Object.keys(nodes).filter(key => nodes[key].kind === 'effect' && !integrates(key) && contract(key).preserveInput));
  const edgeClean = edge => fromIntegration(edge) || (edge.pass && clean.has(edge.from));
  for (let changed = true; changed;) {
    changed = false;
    for (const key of clean) if (key === workflow.start || incoming.get(key).some(edge => !edgeClean(edge))) { clean.delete(key); changed = true; }
  }
  for (const key of publishes) {
    assert(key !== workflow.start, `workflow ${name} starts at forge.publish step ${key}; add a workspace.integrate step before it`);
    const bad = incoming.get(key).find(edge => !edgeClean(edge));
    assert(!bad, `workflow ${name} can reach forge.publish step ${key} from ${bad?.from} (${bad?.label}) without the factory's integration directly before it; every route into forge.publish must come from the integrated result of a workspace.integrate step, through input-preserving steps only (review, gate, fast checks, preview or preserveInput)`);
  }
}

// Compile the catalog for this configuration. Without a catalog the project
// uses the supplied standard reference, exactly as before catalogs existed.
export function compileCatalog(config, root) {
  const catalog = config.workflows ?? { definitions: { standard: { reference: 'change.standard' } }, selection: { default: 'standard' } };
  validateCatalogConfig(catalog);
  const compiled = {};
  for (const [name, definition] of Object.entries(catalog.definitions)) {
    let workflow, source;
    if (definition.reference) { workflow = referenceWorkflow(definition.reference, config); source = { reference: definition.reference }; }
    else {
      const bytes = readProjectFile(root, definition.path);
      try { workflow = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(`workflow ${definition.path} is not valid JSON`); }
      source = { path: definition.path, sha256: sha256(bytes) };
      // A configured preview runs before the merge question of project-owned graphs too.
      if ((definition.kind ?? 'change') !== 'task') workflow = insertPreview(workflow, config);
    }
    try { validateWorkflow(workflow); validateDelivery(name, workflow, config); }
    catch (error) { throw new Error(`workflow ${name}: ${error.message}`); }
    compiled[name] = { name, kind: definitionKind(definition), workflow, digest: workflowIdentityDigest(workflow, definition.target), source, ...(definition.target ? { target: definition.target } : {}) };
    if (compiled[name].kind === 'task') try { validateTaskWorkflow(name, workflow); } catch (error) { throw new Error(`workflow ${name}: ${error.message}`); }
  }
  validateStepModels(config, withBuiltinModelGraphs(config, Object.fromEntries(Object.entries(compiled).map(([name, row]) => [name, row.workflow]))));
  return { selection: { default: catalog.selection?.default ?? null, rules: catalog.selection?.rules ?? [] }, workflows: compiled, digest: digest(Object.fromEntries(Object.entries(compiled).map(([name, row]) => [name, row.digest]))) };
}

// Deterministic selection over the task's approved facts: an explicit brief `workflow`
// field, then the first matching label or category rule, then the default.
export function selectWorkflow(catalog, task) {
  if (task.workflow) { assert(catalog.workflows[task.workflow], `task names unknown workflow ${task.workflow}`); return { name: task.workflow, kind: catalog.workflows[task.workflow].kind ?? 'change', digest: catalog.workflows[task.workflow].digest, rule: 'brief', ...(catalog.workflows[task.workflow].target ? { target: catalog.workflows[task.workflow].target } : {}) }; }
  const rule = catalog.selection.rules.find(row => row.label ? (task.labels ?? []).includes(row.label) : row.category === task.category);
  const name = rule?.workflow ?? catalog.selection.default;
  assert(name, `no workflow selected for task ${task.id ?? ''} and no default is configured`);
  const row = catalog.workflows[name];
  return { name, kind: row.kind ?? 'change', digest: row.digest, rule: rule ? (rule.label ? { label: rule.label } : { category: rule.category }) : 'default', ...(row.target ? { target: row.target } : {}) };
}
// A task workflow has no worktree, build or merge: only questions, waits and closing the task.
function validateTaskWorkflow(name, workflow) {
  for (const [key, node] of Object.entries(workflow.nodes)) {
    if (node.kind === 'effect') assert(['forge.closeTask', 'forge.lifecycle'].includes(node.action?.operation), `task workflow step ${key} may only close or record the task, not ${node.action?.operation ?? 'run a command'}`);
    if (node.kind === 'question') assert(!node.mergeDecision && !node.satisfiedDecision, `task workflow step ${key} cannot be a merge decision`);
  }
}

// Source files changed on disk since commissioning are refused, not reloaded.
export function catalogDrift(catalog, root) {
  const drift = [];
  for (const row of Object.values(catalog?.workflows ?? {})) {
    if (!row.source.path) continue;
    try { if (sha256(readProjectFile(root, row.source.path)) !== row.source.sha256) drift.push(`${row.source.path} changed since commissioning; run config update to recommission it`); }
    catch (error) { drift.push(`${row.source.path}: ${error.message}`); }
  }
  return drift;
}

// Approval binds the selected workflow; admission rechecks that binding.
export function approvalBinding(store, task) {
  const catalog = store.meta('catalog');
  return catalog ? selectWorkflow(catalog, task) : null;
}
export function admittedWorkflow(store, task) {
  const catalog = store.meta('catalog');
  if (!catalog) return { name: null, workflow: store.meta('workflow') };
  const selected = selectWorkflow(catalog, task);
  assert(task.approvedWorkflow && task.approvedWorkflow.name === selected.name && task.approvedWorkflow.digest === selected.digest, `task approval does not cover the selected workflow ${selected.name}; review and approve it again`);
  return { name: selected.name, kind: selected.kind, digest: selected.digest, workflow: catalog.workflows[selected.name].workflow, target: catalog.workflows[selected.name].target ?? null };
}
export function commissionedDigest(store, flow) {
  const catalog = store.meta('catalog');
  return flow.workflowName && catalog ? catalog.workflows[flow.workflowName]?.digest : store.meta('workflowDigest');
}
// Authorization first checks that the commissioned identity is still current.
// Recompute it from the pinned graph and actual execution target too; a catalog
// with an explicit target binds both, while legacy/default graphs remain graph-only.
export function pinnedWorkflowDigest(store, flow) {
  const row = flow.kind !== 'maintenance' && flow.workflowName ? store.meta('catalog')?.workflows[flow.workflowName] : null;
  return workflowIdentityDigest(flow.workflow, row?.target ? flow.target : null);
}
// The default (or standard reference) graph shown as the project's workflow.
export const defaultWorkflow = (catalog, config) => catalog.selection.default ? catalog.workflows[catalog.selection.default].workflow : changeWorkflow(config);
// Advisory view for Tasks/Queue: selected workflow, whether approval covers it,
// and anything that would refuse admission.
export function workflowAdmission(store, task) {
  const catalog = store.meta('catalog');
  if (!catalog) return { selected: null, kind: 'change', approved: null, current: true, reasons: [] };
  const reasons = catalogDrift(catalog, store.meta('project').root);
  let selected = null;
  try { selected = selectWorkflow(catalog, task); } catch (error) { reasons.push(error.message); }
  const approved = task.approvedWorkflow ?? null, current = Boolean(selected && approved && approved.name === selected.name && approved.digest === selected.digest);
  // staleApproval: the reason text when the current revision's approval was given for another workflow (or an older digest of it).
  const staleApproval = selected && task.approvedRevision === task.revision && !current ? `approval does not cover selected workflow ${selected.name}; approve the task again` : null;
  if (staleApproval) reasons.push(staleApproval);
  return { selected: selected?.name ?? null, kind: selected?.kind ?? 'change', target: selected?.target ?? null, approved: approved?.name ?? null, current, reasons, ...(staleApproval ? { staleApproval } : {}) };
}
// Every graph a flow of this project can run, keyed as stepModels keys it.
export function commissionedGraphs(store) {
  const config = store.meta('config', {}), catalog = store.meta('catalog');
  if (config.mode !== 'delivery') return {};
  return withBuiltinModelGraphs(config, catalog ? Object.fromEntries(Object.entries(catalog.workflows).map(([name, row]) => [name, row.workflow])) : { standard: store.meta('workflow') });
}
