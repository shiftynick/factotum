import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { move, reachableSteps } from '../starter/factory/core/project.mjs';
import { reviewDisposition } from '../starter/factory/core/delivery-review.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };

test('a replan gives every step after the plan its full visit budget back', t => {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed');
  const task = f.store.need('task', f.task.id); f.command('task.approve', { taskId: task.id, revision: task.revision });
  const workflow = changeWorkflow(base), limit = workflow.nodes.review.maxVisits;
  assert.ok(reachableSteps(workflow, 'plan').has('review'));
  f.store.put('flow', { id: 'stuck', kind: 'change', mode: 'delivery', taskId: task.id, taskRevision: task.revision, approvalVersion: 2, workflow, step: 'review', state: 'stopped', stopRequested: true, transitions: 60, visits: { plan: 1, build: 5, review: limit }, results: {}, evidence: {}, sessions: {}, attemptId: null, createdAt: new Date().toISOString() });
  const replan = f.command('flow.replan', { flowId: 'stuck', note: 'Main moved outside the factory' });
  assert.equal(replan.status, 'completed', replan.error);
  const flow = f.store.need('flow', 'stuck');
  assert.equal(flow.step, 'plan'); assert.equal(flow.limitExtensions.review, limit); assert.equal(flow.limitExtensions.build, 5); assert.equal(flow.transitionAllowance, 60);
  assert.equal(flow.visits.review, limit, 'history is kept');
  for (let i = 0; i < limit; i++) move(f.store, flow, 'review');
  assert.throws(() => move(f.store, flow, 'review'), /visit bound exhausted/, 'still bounded');
});

test('an ordinary pass with only low findings defers them as follow-ups; anything more still revises', () => {
  const config = { policy: {}, repository: {} }, task = { risk: 'ordinary' }, flow = { results: {}, riskAssessments: [] };
  const review = (findings, verdict = 'pass') => ({ provider: 'fictional', result: { verdict, findings, summary: 'x', riskAssessment: { level: 'ordinary' } } });
  const low = { severity: 'low', file: 'a.md', line: 1, message: 'Cosmetic' }, medium = { ...low, severity: 'medium' };
  assert.deepEqual(reviewDisposition(config, task, flow, review([low, low]), 'full'), { route: 'defer', disposition: 'followup-required' });
  assert.equal(reviewDisposition(config, task, flow, review([low, medium]), 'full').route, 'revise');
  assert.equal(reviewDisposition(config, task, flow, review([low], 'revise'), 'full').route, 'revise', 'the reviewer asked for changes');
  assert.equal(reviewDisposition(config, task, flow, review([]), 'full').route, 'pass');
  assert.notEqual(reviewDisposition(config, { risk: 'strict' }, flow, review([low]), 'full').route, 'defer', 'strict findings are never deferred');
  assert.equal(reviewDisposition({ ...config, policy: { deferLowFindings: false } }, task, flow, review([low]), 'full').route, 'revise', 'a project can send them back instead');
});
