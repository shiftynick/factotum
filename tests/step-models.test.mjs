import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateConfig, changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { compileCatalog } from '../starter/factory/core/catalog.mjs';
import { stepModelView, stepSpec } from '../starter/factory/core/step-models.mjs';
import { resolveProviderSpec } from '../starter/factory/adapters/providers/routes.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/models', account: 'fictional', target: 'main' }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 },
  providers: { planner: { provider: 'codex', model: 'plan-m' }, builder: { provider: 'codex', model: 'build-m', fallback: { model: 'build-fallback' }, allowFallback: true }, reviewer: { provider: 'claude', model: 'review-m', allowedModels: ['review-m', 'review-large'] } } };

test('step models must name an LLM step and stay within the role allowlist', () => {
  validateConfig({ ...base, stepModels: { standard: { review: { model: 'review-large', effort: 'high' }, plan: { model: 'plan-large' } } } });
  // The removed planning-ahead graph's key is dropped, not rejected, so older configurations still commission.
  assert.equal(validateConfig({ ...base, stepModels: { planning: { plan: { model: 'plan-large' } } } }).stepModels.planning, undefined);
  assert.throws(() => validateConfig({ ...base, stepModels: { standard: { review: { model: 'review-xl' } } } }), /allowedModels/);
  assert.throws(() => validateConfig({ ...base, stepModels: { standard: { gate: { model: 'x' } } } }), /not a model step/);
  assert.throws(() => validateConfig({ ...base, stepModels: { standard: { missing: { model: 'x' } } } }), /not a model step/);
  assert.throws(() => validateConfig({ ...base, stepModels: { other: { review: { model: 'x' } } } }), /unknown workflow/);
  assert.throws(() => validateConfig({ ...base, stepModels: { standard: { review: { model: 'review-m', temperature: 1 } } } }), /supports only/);
  assert.throws(() => validateConfig({ ...base, stepModels: { standard: { review: { provider: 'gpt', model: 'x' } } } }), /unsupported provider/);
});

test('step models are validated against project graphs at commissioning', () => {
  const root = mkdtempSync(join(tmpdir(), 'fct-models-')); mkdirSync(join(root, 'project/workflows'), { recursive: true });
  const graph = changeWorkflow(base); graph.nodes['final-check'] = graph.nodes.review; delete graph.nodes.review;
  for (const node of Object.values(graph.nodes)) for (const key of ['next', 'onFailure']) if (node[key] === 'review') node[key] = 'final-check';
  for (const node of Object.values(graph.nodes)) for (const edges of [node.resultEdges, node.answers]) for (const [k, v] of Object.entries(edges ?? {})) if (v === 'review') edges[k] = 'final-check';
  writeFileSync(join(root, 'project/workflows/change.json'), JSON.stringify(graph));
  const workflows = { definitions: { change: { path: 'project/workflows/change.json' } }, selection: { default: 'change' } };
  const compiled = compileCatalog({ ...base, workflows, stepModels: { change: { 'final-check': { model: 'review-large' } } } }, root);
  const view = stepModelView({ ...base, stepModels: { change: { 'final-check': { model: 'review-large' } } } }, { change: compiled.workflows.change.workflow });
  assert.deepEqual(view.find(row => row.step === 'final-check'), { workflow: 'change', step: 'final-check', operation: 'provider.review', role: 'reviewer', provider: 'claude', model: 'review-large', effort: null, source: 'step' });
  assert.equal(view.find(row => row.workflow === 'change' && row.step === 'plan').source, 'role');
  assert.throws(() => compileCatalog({ ...base, workflows, stepModels: { change: { review: { model: 'review-large' } } } }, root), /not a model step/);
});

test('a step model overrides only that step, and changing provider drops the role fallback', () => {
  assert.equal(resolveProviderSpec(base, 'reviewer', { stepModel: { model: 'review-large' } }).model, 'review-large');
  assert.equal(resolveProviderSpec(base, 'reviewer', {}).model, 'review-m');
  const switched = stepSpec(base.providers.builder, { provider: 'claude', model: 'claude-build' });
  assert.equal(switched.provider, 'claude'); assert.equal(switched.fallback, undefined); assert.equal(switched.allowFallback, false);
  assert.equal(stepSpec(base.providers.builder, { model: 'build-large' }).fallback.model, 'build-fallback');
  // A resumed builder must still match the step's own effective route.
  const resumed = { results: { build: { provider: 'codex', model: 'build-large' } }, sessions: { builder: 's' }, stepModel: { model: 'build-large' } };
  assert.equal(resolveProviderSpec(base, 'builder', resumed).model, 'build-large');
  assert.throws(() => resolveProviderSpec(base, 'builder', { ...resumed, stepModel: null }), /no longer matches/);
});
