import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { executeCommand, publicFlow } from '../starter/factory/core/project.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { modelSettingsVersion, modelSettingsView, selectFlowModels, configWithModelDefaults } from '../starter/factory/operations/model-settings.mjs';
import { actionSpecification } from '../starter/factory/workflows/actions.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { resolveProviderSpec } from '../starter/factory/adapters/providers/routes.mjs';
import { createProviderAdapter } from '../starter/factory/adapters/providers/index.mjs';
import { startConsole } from '../starter/factory/console/console.mjs';
import { startProjectService, publicValue } from '../starter/factory/service/project-service.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/models', account: 'fictional', target: 'main' },
  providers: { planner: { provider: 'codex', model: 'plan-small', effort: 'medium' }, builder: { provider: 'codex', model: 'build-small', effort: 'high', allowedModels: ['build-small', 'build-large'], allowFallback: true, fallback: { provider: 'claude', model: 'backup', allowedModels: ['backup'] } }, reviewer: { provider: 'claude', model: 'review-small', allowedModels: ['review-small', 'review-large'] } },
  checks: [{ id: 'fixture', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 10 } };
function setup(t, config = base) {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config, note: 'Fictional model routing' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() });
  return f;
}
const edit = (f, changes, extra = {}) => f.command('models.update', { workflow: 'standard', changes, expectedVersion: modelSettingsVersion(f.store), note: 'Choose models for new work', ...extra });
function start(f, id, extra = {}, actor = 'orchestrator') {
  const task = f.command('task.put', { task: { id, title: id, acceptance: ['Fictional result'], risk: 'ordinary', paths: [`${id}.txt`] } }).result;
  f.command('task.approve', { taskId: id, revision: task.revision });
  return f.command('flow.start', { taskId: id, revision: task.revision, flowId: id, ...extra }, { actor });
}

test('saved defaults and per-run overrides are pinned, isolated and actually reach dispatch', async t => {
  // Run overrides may only name models configured for the provider, so the planner lists them.
  const config = { ...base, providers: { ...base.providers, planner: { ...base.providers.planner, allowedModels: ['plan-small', 'plan-project', 'plan-live', 'plan-run'] } }, stepModels: { standard: { plan: { model: 'plan-project', effort: 'high' } } } };
  const f = setup(t, config);
  const first = start(f, 'first').result, configDigest = f.store.meta('configDigest');
  assert.equal(edit(f, { plan: { model: 'plan-live' }, build: { model: 'build-large', effort: null } }).status, 'completed');
  assert.equal(f.store.meta('configDigest'), configDigest);
  assert.equal(f.store.meta('commissioning').ready, true);
  assert.equal(f.store.need('flow', first.id).modelRoutes.plan.model, 'plan-project');
  const secondReceipt = start(f, 'second', { modelOverrides: { plan: { model: 'plan-run' } } });
  assert.equal(secondReceipt.status, 'completed', secondReceipt.error);
  const second = secondReceipt.result;
  assert.equal(second.modelRoutes.plan.model, 'plan-run'); assert.equal(second.modelRoutes.plan.effort, 'high');
  assert.equal(second.modelRoutes.build.model, 'build-large'); assert.equal(second.modelRoutes.build.effort, undefined);
  assert.equal(second.modelSelection.steps.plan.source, 'run'); assert.equal(second.modelSelection.by, 'orchestrator');
  assert.equal(second.modelSelection.steps.build.source, 'live');
  assert.equal(second.modelRoutes.review.model, 'review-small');
  assert.equal(modelSettingsView(f.store).find(row => row.step === 'plan').model, 'plan-live');
  const selected = { ...second, step: 'plan', results: { source: { head: repositoryIdentity(f.root).head } } };
  const spec = actionSpecification(f.store, selected, selected.workflow.nodes.plan, join(f.stateDir, 'dispatch'));
  // Exercise the real dispatcher with an injected provider; no live forge credentials.
  spec.action.config = { ...spec.action.config, mode: 'rehearsal' };
  let invoked;
  const result = await runAction({ ...spec, timeoutMs: 60000, projectRoot: f.root }, { providerInvoke: async route => {
    invoked = route; return { provider: route.provider, model: route.model, result: { status: 'ready', questions: [], riskAssessment: { level: 'ordinary' } } };
  } });
  assert.equal(result.route, 'ready'); assert.equal(invoked.model, 'plan-run'); assert.equal(invoked.effort, 'high');
  assert.equal(publicFlow(second).modelRoutes, undefined); assert.equal(publicValue(f.store, second).modelRoutes, undefined);
  assert.equal(start(f, 'third').result.modelRoutes.plan.model, 'plan-live');
});

test('defaults use CAS, canonical attribution, project scoping and the existing delegation policy', t => {
  const f = setup(t), version = modelSettingsVersion(f.store);
  const envelope = { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'models.update', payload: { workflow: 'standard', changes: { plan: { model: 'plan-live' } }, expectedVersion: version, note: 'Use the large planner for subsequent work' } };
  assert.equal(executeCommand(f.store, envelope).status, 'rejected', 'default changes require an instruction as other settings do');
  const sent = { ...envelope, commandId: uid(), onBehalfOf: { principal: 'operator', instruction: 'Choose suitable workflow model defaults as needed.' } };
  const receipt = executeCommand(f.store, sent);
  assert.equal(receipt.status, 'completed', receipt.error); assert.equal(receipt.actor, 'orchestrator');
  assert.deepEqual(executeCommand(f.store, sent), receipt, 'duplicate identity replays the receipt');
  assert.equal(f.store.events().find(event => event.type === 'models.updated').payload.by, 'orchestrator');
  assert.match(edit(f, { plan: { model: 'plan-stale' } }, { expectedVersion: version }).error, /changed since/);
  assert.throws(() => executeCommand(f.store, { ...sent, projectId: 'foreign-project', commandId: uid() }), /project/);
  f.command('settings.update', { changes: { 'policy.delegatedOperations': [] }, note: 'Restrict delegation' });
  assert.match(executeCommand(f.store, { ...sent, commandId: uid(), payload: { ...sent.payload, expectedVersion: modelSettingsVersion(f.store) } }).error, /not delegated/);
  assert.equal(edit(f, { plan: { model: 'operator-choice' } }).status, 'completed');
});

test('model selectors reject unknown steps, invalid routes, policy bypass and unsupported fields atomically', t => {
  const f = setup(t), version = modelSettingsVersion(f.store);
  for (const [changes, error] of [
    [{ gate: { model: 'x' } }, /not a model step/], [{ missing: { model: 'x' } }, /not a model step/],
    [{ plan: { model: '--unsafe' } }, /model identifier/], [{ plan: [] }, /supports only/],
    [{ plan: { model: 'x', billingMode: 'api' } }, /supports only/], [{ plan: { model: 'x', allowedModels: ['x'] } }, /supports only/],
    [{ plan: { provider: 'elsewhere', model: 'x' } }, /unsupported provider/], [{ plan: { model: 'x', effort: 'max' } }, /effort/],
    [{ build: { model: 'not-allowed' } }, /allowedModels/], [{ plan: { model: 'unlisted', provider: 'claude' } }, /allowedModels/],
  ]) { const receipt = edit(f, changes); assert.equal(receipt.status, 'rejected', JSON.stringify(changes)); assert.match(receipt.error, error); assert.equal(modelSettingsVersion(f.store), version); }
  assert.equal(edit(f, { review: { model: 'plan-small', provider: 'codex' } }).status, 'completed', 'a same-family reviewer is a valid default');
  assert.match(edit(f, { plan: { model: 'x' } }, { workflow: 'unknown' }).error, /commissioned workflow/);
  assert.equal(edit(f, { plan: { model: 'review-large', provider: 'claude', effort: 'max' } }).status, 'completed', 'a declared provider and allowed model can be selected');
  const graph = changeWorkflow(base), limited = { ...base, providers: { ...base.providers, planner: { provider: 'codex', model: 'plan-small', allowedModels: ['plan-small'] } } };
  assert.throws(() => selectFlowModels(limited, 'standard', graph, { standard: { plan: { provider: 'claude', model: 'review-large' } } }, { plan: { provider: 'codex', model: 'escape' } }), /allowedModels/, 'switching away and back cannot erase the role allowlist');
  assert.throws(() => selectFlowModels({ ...base, stepModels: { standard: { plan: { provider: 'claude', model: 'cross-approved' } } } }, 'standard', graph, {}, { plan: { model: 'escape' } }), /allowedModels/, 'a project-config provider switch does not erase destination allowlists for run overrides');
  assert.equal(start(f, 'bad-run', { modelOverrides: { gate: { model: 'x' } } }).status, 'rejected');
  assert.equal(f.store.get('flow', 'bad-run'), undefined, 'rejected admission leaves no flow');
  assert.equal(start(f, 'array-run', { modelOverrides: [] }).status, 'rejected');
});

test('default edits pin legacy flows and preserve resumed builder routes and fallback choices', t => {
  const f = setup(t), legacy = start(f, 'legacy').result;
  delete legacy.modelRoutes; delete legacy.modelSelection; f.store.put('flow', legacy);
  assert.equal(edit(f, { build: { model: 'build-large' } }).status, 'completed');
  const retained = f.store.need('flow', 'legacy');
  assert.equal(retained.modelRoutes.build.model, 'build-small');
  const resumed = resolveProviderSpec(f.store.meta('config'), 'builder', { modelRoute: retained.modelRoutes.build, sessions: { builder: 'session' }, results: { build: { provider: 'claude', model: 'backup' } } });
  assert.equal(resumed.provider, 'claude'); assert.equal(resumed.model, 'backup'); assert.equal(resumed.allowFallback, false);
  assert.throws(() => resolveProviderSpec(base, 'builder', { modelRoute: retained.modelRoutes.build, sessions: { builder: 'session' }, results: { build: { provider: 'codex', model: 'build-large' } } }), /no longer matches/);
});

test('saved and run effort overrides cannot invalidate a retained fallback', t => {
  for (const [role, step, provider, fallbackProvider, effort] of [
    ['builder', 'build', 'codex', 'claude', 'minimal'],
    ['planner', 'plan', 'claude', 'codex', 'max'],
  ]) {
    const config = structuredClone(base);
    config.providers[role] = { provider, model: 'primary', effort: 'high', allowFallback: true, fallback: { provider: fallbackProvider, model: 'backup' } };
    const f = setup(t, config), version = modelSettingsVersion(f.store), change = { [step]: { model: 'primary', effort } };
    const saved = edit(f, change);
    assert.equal(saved.status, 'rejected'); assert.match(saved.error, /fallback: unsupported .* effort/);
    assert.equal(modelSettingsVersion(f.store), version, 'rejection does not change defaults');
    const run = start(f, 'invalid-fallback', { modelOverrides: change });
    assert.equal(run.status, 'rejected'); assert.match(run.error, /fallback: unsupported .* effort/);
    assert.equal(f.store.get('flow', 'invalid-fallback'), undefined, 'rejection admits no flow');
  }
});

test('explicit fallback effort remains usable when the primary effort changes', async t => {
  const config = structuredClone(base);
  config.providers.builder.fallback.effort = 'high';
  const f = setup(t, config);
  assert.equal(edit(f, { build: { model: 'build-large', effort: 'minimal' } }).status, 'completed');
  const flow = start(f, 'usable-fallback').result, route = flow.modelRoutes.build, calls = [];
  const adapter = createProviderAdapter({ environment: {}, transport: async (provider, args) => {
    calls.push({ provider, args });
    if (provider === 'codex') return { code: 1, stdout: '', stderr: 'Fictional primary unavailable' };
    let stdout;
    if (args.includes('--version')) stdout = 'Fixture CLI';
    else if (args.includes('--help')) stdout = '--safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts --effort';
    else if (args.includes('status')) stdout = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' });
    else stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: '00000000-0000-0000-0000-000000000001', usage: { input_tokens: 1, output_tokens: 1 }, structured_output: { status: 'implemented', summary: 'Fixture result' } });
    return { code: 0, stdout, stderr: '' };
  } });
  const result = await adapter.invoke({ ...route, role: 'builder', cwd: f.root, artifactDir: join(f.stateDir, 'fallback-test'), prompt: 'Fictional task', timeoutMs: 60000 });
  assert.equal(route.effort, 'minimal'); assert.equal(result.effort, 'high');
  assert.equal(result.model, 'backup'); assert.equal(result.fallback.beforeModelStart, true);
  const invocation = calls.find(call => call.args.includes('--json-schema'));
  assert.equal(invocation.args[invocation.args.indexOf('--effort') + 1], 'high');
  const resumed = resolveProviderSpec(config, 'builder', { modelRoute: route, sessions: { builder: result.sessionId }, results: { build: result } });
  assert.equal(resumed.effort, 'high'); assert.equal(resumed.allowFallback, false);
});

test('effective fallback allowlists and billing are checked only for retained enabled fallbacks', () => {
  const graph = changeWorkflow(base), config = structuredClone(base);
  delete config.providers.builder.fallback.allowedModels;
  assert.throws(() => selectFlowModels(config, 'standard', graph), /build.fallback: model is outside allowedModels/);
  config.providers.builder.fallback.allowedModels = ['backup'];
  config.providers.builder.fallback.billingMode = 'api';
  assert.throws(() => selectFlowModels(config, 'standard', graph), /build.fallback: only subscription/);
  config.providers.builder.allowFallback = false;
  assert.doesNotThrow(() => selectFlowModels(config, 'standard', graph));
  config.providers.builder.allowFallback = true;
  const route = selectFlowModels(config, 'standard', graph, {}, { build: { provider: 'claude', model: 'review-large' } }).modelRoutes.build;
  assert.equal(route.fallback, undefined); assert.equal(route.allowFallback, false);
});

test('valid workflow and step names do not inherit selections from object prototypes', () => {
  const graph = { nodes: { constructor: { kind: 'effect', action: { operation: 'provider.plan' } } } };
  const selected = selectFlowModels(base, 'constructor', graph);
  assert.equal(selected.modelSelection.steps.constructor.source, 'role');
  assert.equal(selected.modelRoutes.constructor.model, 'plan-small');
});

test('project-owned step names are editable and overrides survive upgrades until explicitly reset', t => {
  const f = setup(t), graph = changeWorkflow(base);
  graph.nodes['editorial-review'] = graph.nodes.review; delete graph.nodes.review;
  for (const node of Object.values(graph.nodes)) {
    for (const field of ['next', 'onFailure']) if (node[field] === 'review') node[field] = 'editorial-review';
    for (const edges of [node.resultEdges, node.answers]) for (const [key, target] of Object.entries(edges ?? {})) if (target === 'review') edges[key] = 'editorial-review';
  }
  mkdirSync(join(f.root, 'project/workflows'), { recursive: true });
  writeFileSync(join(f.root, 'project/workflows/copy.json'), JSON.stringify(graph));
  const config = { ...base, workflows: { definitions: { copy: { path: 'project/workflows/copy.json' } }, selection: { default: 'copy' } } };
  assert.equal(f.command('config.update', { config, note: 'Use the project workflow' }).status, 'completed');
  assert.equal(edit(f, { 'editorial-review': { model: 'review-large' } }, { workflow: 'copy' }).status, 'completed');
  assert.equal(configWithModelDefaults(f.store).stepModels.copy['editorial-review'].model, 'review-large');
  const before = modelSettingsVersion(f.store);
  assert.equal(f.command('config.update', { config: { ...config, context: { files: [], maxChars: 2000 } }, note: 'Upgrade' }).status, 'completed');
  assert.equal(modelSettingsView(f.store).find(row => row.step === 'editorial-review').model, 'review-large');
  assert.notEqual(modelSettingsVersion(f.store), before, 'a configuration change invalidates old model edits');
  assert.match(f.command('config.update', { config: base, note: 'Remove the catalog' }).error, /unknown workflow/);
  assert.equal(f.command('config.update', { config: base, replaceLive: true, note: 'Replace all live settings from the file' }).status, 'completed');
  assert.equal(modelSettingsView(f.store).find(row => row.step === 'review').source, 'role');
  assert.equal(edit(f, { plan: { model: 'live-model' } }).status, 'completed');
  assert.equal(edit(f, { plan: null }).status, 'completed');
  assert.equal(modelSettingsView(f.store).find(row => row.step === 'plan').model, 'plan-small');
});

test('the actual console command endpoint edits models and refuses a stale editor', async t => {
  const f = setup(t), service = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'models.sock'), run: false });
  const app = await startConsole({ stateDir: join(f.base, 'console'), port: 0, timeoutMs: 30000 });
  t.after(async () => { await app.close(); await service.close(); });
  const binding = await app.registerProject({ socketPath: service.socketPath });
  const page = await fetch(app.url), cookie = page.headers.get('set-cookie').split(';')[0], csrf = (await page.text()).match(/name="factotum-csrf" content="([^"]+)"/)[1];
  const payload = { workflow: 'standard', changes: { plan: { model: 'from-console', effort: null } }, expectedVersion: modelSettingsVersion(f.store), note: 'Save from Settings' };
  const send = async () => (await fetch(`${app.url}/api/commands`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-factotum-csrf': csrf }, body: JSON.stringify({ projectId: f.project.projectId, bindingId: binding.bindingId, commandId: uid(), actor: 'operator', operation: 'models.update', payload }) })).json();
  assert.equal((await send()).status, 'completed');
  assert.equal(modelSettingsView(f.store).find(row => row.step === 'plan').model, 'from-console');
  assert.equal((await send()).status, 'rejected');
});

test('maintenance audit has defaults and per-job overrides; other maintenance is unaffected', async t => {
  const f = setup(t);
  assert.equal(edit(f, { plan: { model: 'large-planner' } }).status, 'completed');
  assert.equal(edit(f, { run: { model: 'review-large' } }, { workflow: 'maintenance/audit' }).status, 'completed');
  const receipt = f.command('job.enqueue', { operation: 'audit', modelOverrides: { run: { model: 'review-small', effort: 'max' } }, note: 'Audit this candidate' });
  assert.equal(receipt.status, 'completed', receipt.error);
  await operationalTick(f.store);
  const audit = f.store.all('flow').find(flow => flow.jobId === receipt.result.id);
  assert.equal(audit.modelRoutes.run.model, 'review-small'); assert.equal(audit.modelRoutes.run.effort, 'max');
  assert.equal(audit.modelSelection.steps.run.source, 'run');
  assert.equal(audit.modelSelection.workflow, 'maintenance/audit');
  assert.equal(f.command('job.enqueue', { operation: 'retrospective', modelOverrides: {}, note: 'Invalid selector' }).status, 'rejected');
  // A running legacy non-model maintenance job must not pick up standard.plan's override.
  const plain = { ...audit, id: 'legacy-maintenance', workflow: { version: 1, start: 'run', nodes: { run: { kind: 'effect', action: { operation: 'retrospective' } } } } };
  delete plain.modelRoutes; delete plain.modelSelection; f.store.put('flow', plain);
  assert.equal(edit(f, { plan: { model: 'another-planner' } }).status, 'completed');
  assert.deepEqual(f.store.need('flow', plain.id).modelRoutes, {});
});

// dev.84 review fix 2: a per-step turn limit survives a live model selection, the settings
// projection and config show's export, so re-importing the export does not raise the limit.
test('review fix 2: stepModels maxTurns survives a live selection, the projection and the export', t => {
  const config = { ...base, providers: { ...base.providers, builder: { ...base.providers.builder, maxTurns: 40 } }, stepModels: { standard: { build: { model: 'build-small', maxTurns: 5 } } } };
  const f = setup(t, config);
  assert.equal(edit(f, { build: { model: 'build-large' } }).status, 'completed');
  const graph = changeWorkflow(config), live = f.store.meta('modelDefaults');
  // Live selection: the pinned route keeps the step's limit.
  assert.equal(selectFlowModels(f.store.meta('config'), 'standard', graph, live).modelRoutes.build.maxTurns, 5);
  // Projection: the settings row shows it; a step without its own limit shows the role's.
  const rows = modelSettingsView(f.store);
  assert.equal(rows.find(row => row.step === 'build').maxTurns, 5); assert.equal(rows.find(row => row.step === 'build').model, 'build-large');
  // Export: the live model with the step's turn limit, not the role's 40 and not the default 60.
  const exported = configWithModelDefaults(f.store);
  assert.deepEqual(exported.stepModels.standard.build, { provider: 'codex', model: 'build-large', effort: 'high', maxTurns: 5 });
  assert.equal(selectFlowModels(exported, 'standard', graph).modelRoutes.build.maxTurns, 5, 're-importing the export keeps the limit');
  // A live default that sets its own limit wins over the project's.
  assert.equal(edit(f, { build: { model: 'build-large', maxTurns: 9 } }).status, 'completed');
  assert.equal(configWithModelDefaults(f.store).stepModels.standard.build.maxTurns, 9);
  assert.equal(selectFlowModels(f.store.meta('config'), 'standard', graph, f.store.meta('modelDefaults')).modelRoutes.build.maxTurns, 9);
});
