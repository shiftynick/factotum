import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { resolveProviderSpec } from '../starter/factory/adapters/providers/routes.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';

// Fictional configuration in the shape of the shipped defaults: Claude plans and builds,
// Codex reviews, and each role lists the models a task may choose.
const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/task-models', account: 'fictional', target: 'main' },
  providers: {
    planner: { provider: 'claude', model: 'plan-default', allowedModels: ['plan-default', 'deep-model'] },
    builder: { provider: 'claude', model: 'build-default', allowedModels: ['build-default', 'deep-model'] },
    reviewer: { provider: 'codex', model: 'review-default', allowedModels: ['review-default'] },
  },
  checks: [{ id: 'fixture', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 10 } };
function setup(t, config = base) {
  const f = sandbox(t);
  const updated = f.command('config.update', { config, note: 'Fictional task model routing' });
  assert.equal(updated.status, 'completed', updated.error);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() });
  return f;
}
const as = (f, actor, operation, payload, extra = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor, operation, payload, ...extra });
function approved(f, id) {
  const task = f.command('task.put', { task: { id, title: id, acceptance: ['Fictional result'], risk: 'ordinary', paths: [`${id}.txt`] } }).result;
  assert.equal(f.command('task.approve', { taskId: id, revision: task.revision }).status, 'completed');
  return f.store.need('task', id);
}
const start = (f, id, extra = {}) => f.command('flow.start', { taskId: id, revision: f.store.need('task', id).revision, flowId: `${id}-flow-${uid().slice(0, 6)}`, ...extra });

test('same-family builder and reviewer configuration is accepted without a policy exception, and the legacy flag is reported as obsolete', t => {
  const same = structuredClone(base);
  same.providers.reviewer = { provider: 'claude', model: 'review-default' };
  assert.doesNotThrow(() => validateConfig(same));
  const f = setup(t, same);
  // An older configuration that still carries the retracted exception is accepted; the key is dropped and reported.
  const legacy = f.command('config.update', { config: { ...same, policy: { ...same.policy, allowSameFamilyReview: false } }, note: 'Fictional older configuration' });
  assert.equal(legacy.status, 'completed', legacy.error);
  assert.deepEqual(legacy.result.ignoredSettings, ['policy.allowSameFamilyReview']);
  assert.match(legacy.result.ignoredReason, /same-family review is always allowed/);
  assert.equal(Object.hasOwn(f.store.meta('config').policy, 'allowSameFamilyReview'), false);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  approved(f, 'same-family');
  const flow = start(f, 'same-family').result;
  assert.equal(flow.modelSelection.steps.build.provider, 'claude');
  assert.equal(flow.modelSelection.steps.review.provider, 'claude');
});

test('a same-family review is accepted and records the builder/reviewer pairing in review evidence', async t => {
  const f = sandbox(t), ghPath = join(f.base, 'gh');
  writeFileSync(ghPath, `#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');`, { mode: 0o700 });
  const workflow = { version: 1, start: 'inspect', nodes: {
    inspect: { kind: 'effect', action: { operation: 'provider.review' }, timeoutMs: 60000, next: 'done', onFailure: 'failed', resultEdges: { pass: 'done', revise: 'failed' } },
    done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', ghPath }, providers: { builder: { provider: 'claude', model: 'build-default' }, reviewer: { provider: 'claude', model: 'review-default' } }, policy: { planning: false }, context: { files: [], maxChars: 1000 } });
  f.start();
  const flow = f.store.need('flow', 'flow-1');
  flow.results.source = { head: repositoryIdentity(f.root).head };
  flow.results.build = { route: 'implemented', provider: 'claude', model: 'build-default', family: 'anthropic', sessionId: 'builder-session', result: { status: 'implemented', summary: 'Fictional build' } };
  f.store.put('flow', flow);
  await f.engine.tick();
  const attempt = f.store.all('attempt')[0], sent = [];
  const assessment = { level: 'strict', rationale: 'Fictional saved data', threatModel: ['Loss of records'], stopConditions: ['Missing integrity'] };
  const review = await runAction(attempt.intent, { providerInvoke: async spec => { sent.push(spec); return { provider: 'claude', model: 'review-default', family: 'anthropic', result: { verdict: 'pass', summary: 'Checked', findings: [], riskAssessment: assessment, strictReview: { fullDiffInspected: true, threatModelReviewed: true, stopConditionsReviewed: true }, scopeSummary: 'Entire fictional change', priorFindingsDisposition: [] } }; } });
  assert.equal(review.route, 'pass');
  assert.equal(review.independence, 'same-family');
  assert.deepEqual(review.pairing, { builder: { provider: 'claude', model: 'build-default', family: 'anthropic' }, reviewer: { provider: 'claude', model: 'review-default', family: 'anthropic' } });
  assert.equal(sent[0].independenceFamily, undefined, 'the reviewer is no longer bound to a family');
  assert.equal(sent[0].allowSameFamilyReview, undefined);
});

test('a task model choice applies to every step of its role, below a run override, and keeps approval', t => {
  const f = setup(t), task = approved(f, 'deep');
  const chosen = f.command('task.models', { taskId: 'deep', models: { builder: { model: 'deep-model', effort: 'max' }, reviewer: { provider: 'claude', model: 'deep-model' } }, note: 'Most complex work' });
  assert.equal(chosen.status, 'completed', chosen.error);
  assert.equal(chosen.result.appliesTo, 'next-flow');
  const after = f.store.need('task', 'deep');
  assert.equal(after.revision, task.revision); assert.equal(after.approvedRevision, task.revision, 'a model choice is not part of the approved brief');
  const flow = start(f, 'deep', { modelOverrides: { review: { provider: 'codex', model: 'review-default' } } }).result;
  assert.equal(flow.modelRoutes.build.model, 'deep-model'); assert.equal(flow.modelRoutes.build.effort, 'max');
  assert.equal(flow.modelSelection.steps.build.source, 'task');
  assert.equal(flow.modelRoutes.plan.model, 'plan-default'); assert.equal(flow.modelSelection.steps.plan.source, 'role');
  // The reviewer choice covers the plan review too; the run override still wins for its one step.
  assert.equal(flow.modelRoutes['plan-review'].provider, 'claude'); assert.equal(flow.modelRoutes['plan-review'].model, 'deep-model');
  assert.equal(flow.modelSelection.steps['plan-review'].source, 'task');
  assert.equal(flow.modelRoutes.review.provider, 'codex'); assert.equal(flow.modelSelection.steps.review.source, 'run');
  assert.deepEqual(flow.modelSelection.taskModels, after.models);
  // A brief edit makes a new revision but keeps the model choice; clearing it restores the defaults.
  const edited = f.command('task.put', { task: { id: 'deep', title: 'deep, edited', acceptance: ['Fictional result'], risk: 'ordinary', paths: ['deep.txt'] } }).result;
  assert.notEqual(edited.revision, task.revision); assert.deepEqual(edited.models, after.models);
  assert.equal(f.command('task.models', { taskId: 'deep', models: null }).status, 'completed');
  assert.equal(f.store.need('task', 'deep').models, undefined);
});

test('a choice outside the configured providers or allowed models is refused as a project setting change', t => {
  const claudeOnly = structuredClone(base);
  claudeOnly.providers.reviewer = { provider: 'claude', model: 'review-default', allowedModels: ['review-default'] };
  const f = setup(t, claudeOnly);
  approved(f, 'outside');
  for (const [models, error] of [
    [{ builder: { model: 'unlisted-model' } }, /outside allowedModels.*project setting change/],
    [{ reviewer: { provider: 'codex', model: 'review-default' } }, /provider codex is not configured.*project setting change/],
    [{ auditor: { model: 'deep-model' } }, /task models map planner, builder, reviewer/],
    [{ builder: { model: 'deep-model', effort: 'minimal' } }, /unsupported claude effort/],
    [{ builder: { model: 'deep-model', billingMode: 'api' } }, /supports only/],
  ]) {
    const receipt = f.command('task.models', { taskId: 'outside', models });
    assert.equal(receipt.status, 'rejected', JSON.stringify(models)); assert.match(receipt.error, error);
  }
  assert.equal(f.store.need('task', 'outside').models, undefined, 'a refused choice changes nothing');
  assert.equal(f.command('task.put', { task: { id: 'outside', title: 'outside', acceptance: ['Fictional result'], models: { builder: { model: 'unlisted-model' } } } }).status, 'rejected');
  // A choice that was valid but no longer is (configuration changed) refuses admission rather than running another model.
  assert.equal(f.command('task.models', { taskId: 'outside', models: { builder: { model: 'deep-model' } } }).status, 'completed');
  const narrowed = structuredClone(claudeOnly); narrowed.providers.builder.allowedModels = ['build-default'];
  assert.equal(f.command('config.update', { config: narrowed, note: 'Fictional narrower allowlist' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  const refused = start(f, 'outside');
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /task builder choice.*allowedModels/);
});

test('the orchestrator chooses task models with normal command authority; resumed builders keep their session provider', t => {
  const f = setup(t);
  approved(f, 'resume');
  const flow = start(f, 'resume').result;
  assert.equal(flow.modelRoutes.build.provider, 'claude');
  const chosen = as(f, 'orchestrator', 'task.models', { taskId: 'resume', models: { builder: { model: 'deep-model' } }, note: 'Use the deeper model next time' });
  assert.equal(chosen.status, 'completed', chosen.error);
  assert.equal(f.store.events().find(event => event.type === 'task.models').payload.by, 'orchestrator');
  const pinned = f.store.need('flow', flow.id);
  assert.equal(pinned.modelRoutes.build.model, 'build-default', 'an admitted flow keeps its pinned routes');
  const resumed = resolveProviderSpec(f.store.meta('config'), 'builder', { modelRoute: pinned.modelRoutes.build, sessions: { builder: 'session' }, results: { build: { provider: 'claude', model: 'build-default' } } });
  assert.equal(resumed.provider, 'claude'); assert.equal(resumed.model, 'build-default');
  assert.throws(() => resolveProviderSpec(f.store.meta('config'), 'builder', { modelRoute: pinned.modelRoutes.build, sessions: { builder: 'session' }, results: { build: { provider: 'claude', model: 'deep-model' } } }), /no longer matches/);
  // A restart starts a new flow, which takes the current task choice.
  assert.equal(f.command('stop', { flowId: flow.id, note: 'Fictional stop' }).status, 'completed');
  const restarted = f.command('task.restart', { taskId: 'resume', revision: f.store.need('task', 'resume').revision, note: 'Start again with the chosen model' });
  assert.equal(restarted.status, 'completed', restarted.error);
  const next = f.store.need('flow', restarted.result.flowId);
  assert.equal(next.modelRoutes.build.model, 'deep-model'); assert.equal(next.modelSelection.steps.build.source, 'task');
});

test('existing tasks without a model choice admit exactly as before', t => {
  const f = setup(t);
  approved(f, 'plain');
  const flow = start(f, 'plain').result;
  assert.equal(flow.modelSelection.taskModels, undefined);
  assert.ok(Object.values(flow.modelSelection.steps).every(row => row.source === 'role'));
  assert.equal(f.store.need('task', 'plain').models, undefined);
});

test('the shipped starter defaults validate and allow Fable as a per-task choice', t => {
  const template = JSON.parse(readFileSync(new URL('../starter/project/factotum.template.json', import.meta.url), 'utf8'));
  const config = validateConfig(template);
  assert.deepEqual([config.providers.planner.model, config.providers.builder.model, config.providers.reviewer.model], ['claude-opus-5-5', 'claude-opus-5-5', 'gpt-6.1-sol']);
  assert.equal(config.providers.reviewer.provider, 'codex');
  assert.equal(Object.hasOwn(config.policy, 'allowSameFamilyReview'), false);
  const f = setup(t, { ...template, resources: undefined, backupRoot: undefined, mainChecks: undefined, checks: base.checks, context: base.context, repository: { ...template.repository, slug: 'fictional/starter' } });
  approved(f, 'important');
  assert.equal(f.command('task.models', { taskId: 'important', models: { planner: { model: 'claude-fable-5-2' }, builder: { model: 'claude-fable-5-2' }, reviewer: { provider: 'claude', model: 'claude-fable-5-2' } } }).status, 'completed');
  const flow = start(f, 'important').result;
  for (const step of ['plan', 'build', 'review']) assert.equal(flow.modelRoutes[step].model, 'claude-fable-5-2', step);
  assert.equal(f.command('task.models', { taskId: 'important', models: { reviewer: { model: 'claude-fable-5-2' } } }).status, 'rejected', 'Fable is not a Codex model: the reviewer choice must name the Claude provider');
});

test('the console task detail shows the task’s chosen models and the project defaults it falls back to', async () => {
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this._text = text; }
    append(...items) { this.children.push(...items); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(key, value) { this[key] = value; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? String(c)).join(''); }
  }
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window'], old = Object.fromEntries(keys.map(k => [k, globalThis[k]])), storage = { getItem: () => null, setItem() {} };
  Object.assign(globalThis, { Node: Element, document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) }, localStorage: storage, sessionStorage: storage, window: { dispatchEvent() {} } });
  try {
    const { taskModelsView } = await import('../starter/factory/console/ui/plan.mjs');
    const settings = { stepModels: [{ workflow: 'standard', step: 'plan', role: 'planner', provider: 'claude', model: 'plan-default' }, { workflow: 'standard', step: 'build', role: 'builder', provider: 'claude', model: 'build-default' }, { workflow: 'standard', step: 'review', role: 'reviewer', provider: 'codex', model: 'review-default' }] };
    const shown = taskModelsView({ settings }, { id: 'deep', models: { builder: { model: 'deep-model', effort: 'max' } } }).textContent;
    assert.match(shown, /builder: claude \/ deep-model · max ●Chosen for this task/);
    assert.match(shown, /planner: claude \/ plan-default \(project default\)/);
    assert.match(shown, /reviewer: codex \/ review-default \(project default\)/);
  } finally { for (const key of keys) if (old[key] === undefined) delete globalThis[key]; else globalThis[key] = old[key]; }
});

test('without an allowlist a task may choose only models already configured for that provider', t => {
  // Seen in review: a legacy config with no builder allowlist accepted any model as a task choice.
  const legacy = structuredClone(base);
  delete legacy.providers.builder.allowedModels;
  const f = setup(t, legacy);
  approved(f, 'legacy');
  const refused = as(f, 'orchestrator', 'task.models', { taskId: 'legacy', models: { builder: { model: 'not-configured-anywhere' } } });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /outside allowedModels and the models configured for provider claude.*project setting change/);
  const crossRefused = as(f, 'orchestrator', 'task.models', { taskId: 'legacy', models: { builder: { provider: 'codex', model: 'not-configured-anywhere' } } });
  assert.equal(crossRefused.status, 'rejected');
  // The provider's configured models remain choosable: the builder's own default, and another role's.
  assert.equal(as(f, 'orchestrator', 'task.models', { taskId: 'legacy', models: { builder: { model: 'build-default' } } }).status, 'completed');
  assert.equal(as(f, 'orchestrator', 'task.models', { taskId: 'legacy', models: { builder: { model: 'plan-default' } } }).status, 'completed');
  // A choice saved before the config lost a model is refused again at admission.
  const task = f.store.need('task', 'legacy'); f.store.put('task', { ...task, models: { builder: { model: 'not-configured-anywhere' } } });
  assert.equal(start(f, 'legacy').status, 'rejected');
});

test('a step route without its own provider counts for its step\'s provider, not the choosing role\'s', t => {
  // Seen in re-check: stepModels.standard.plan = {model} (a Codex planner step) was credited to the
  // Claude builder, so a builder choice of that model was saved as Claude, and the Codex choice refused.
  const config = structuredClone(base);
  config.providers.planner = { provider: 'codex', model: 'plan-codex' };
  config.providers.builder = { provider: 'claude', model: 'build-default' };
  config.stepModels = { standard: { plan: { model: 'codex-step-only' } } };
  const f = setup(t, config);
  approved(f, 'attributed');
  const wrong = as(f, 'orchestrator', 'task.models', { taskId: 'attributed', models: { builder: { model: 'codex-step-only' } } });
  assert.equal(wrong.status, 'rejected', 'a Codex-only model is not a Claude choice'); assert.match(wrong.error, /outside allowedModels and the models configured for provider claude/);
  const right = as(f, 'orchestrator', 'task.models', { taskId: 'attributed', models: { builder: { provider: 'codex', model: 'codex-step-only' } } });
  assert.equal(right.status, 'completed', right.error);
  assert.equal(start(f, 'attributed').status, 'completed');
});

test('a task choice is checked against the provider its step actually runs, and run overrides follow the same rule', t => {
  // Seen in re-check: with a Claude builder and an explicit Codex build-step route, a builder choice
  // {model: 'claude-only'} ran as Codex / claude-only.
  const config = structuredClone(base);
  config.providers.builder = { provider: 'claude', model: 'build-default', allowedModels: ['build-default', 'claude-only'] };
  config.stepModels = { standard: { build: { provider: 'codex', model: 'review-default' } } };
  delete config.providers.planner.allowedModels; // the run-override rule matters where no allowlist applies
  const f = setup(t, config);
  approved(f, 'effective');
  const refused = as(f, 'orchestrator', 'task.models', { taskId: 'effective', models: { builder: { model: 'claude-only' } } });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /standard.build \(task builder choice\).*outside allowedModels/);
  // Run overrides (operator decision 2026-11-14): only models configured for the provider.
  approved(f, 'override');
  const runRefused = start(f, 'override', { modelOverrides: { plan: { model: 'unlisted-run-model' } } });
  assert.equal(runRefused.status, 'rejected'); assert.match(runRefused.error, /run override.*outside allowedModels/);
  assert.equal(start(f, 'override', { modelOverrides: { plan: { model: 'build-default' } } }).status, 'completed');
});
