import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { digest, validateWorkflow } from '../starter/factory/core/contracts.mjs';
import { validateRequirements, requiredEvidence, bindingNode } from '../starter/factory/core/operations.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

const ends = { done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' }, stopped: { kind: 'end', outcome: 'stopped' } };
const graph = nodes => ({ version: 1, start: Object.keys(nodes)[0], nodes: { ...nodes, ...ends } });
const action = (operation, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: 60000, next: 'done', onFailure: 'failed', ...extra });
const trusted = (extra = {}) => ({ kind: 'effect', argv: ['true'], timeoutMs: 60000, next: 'done', onFailure: 'failed', ...extra });
function fixture(t, workflow, config) {
  const f = sandbox(t);
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  if (config) f.store.setMeta('config', config);
  f.start(); return f;
}

test('graph flags cannot remove inherent operation requirements or forge evidence', () => {
  assert.throws(() => validateWorkflow(graph({ check: action('gate', { heavy: false }) })), /heavy resource lease/);
  assert.throws(() => validateWorkflow(graph({ check: action('provider.review', { preserveInput: false }) })), /preserves its input/);
  assert.throws(() => validateWorkflow(graph({ ship: action('forge.merge', { requireDecision: false }) })), /current decision/);
  assert.throws(() => validateWorkflow(graph({ check: action('workspace.commit', { evidence: 'review' }) })), /cannot mint review/);
  assert.throws(() => validateWorkflow(graph({ check: trusted({ evidence: 'gate' }) })), /cannot claim kernel evidence/);
  validateWorkflow(graph({ check: trusted({ evidence: 'check:lint', next: 'ask' }), ask: { kind: 'question', role: 'operator', question: 'Ship?', requireEvidence: ['check:lint'], answers: { yes: 'done' } } }));
  assert.throws(() => validateWorkflow(graph({ check: action('gate', { binding: 'merge' }) })), /cannot bind merge/);
  assert.throws(() => validateWorkflow(graph({ a: action('provider.build', { next: 'b' }), b: action('provider.build') })), /ambiguous build binding/);
  assert.throws(() => validateWorkflow(graph({ ask: { kind: 'question', role: 'operator', question: 'Ship?', requireEvidence: ['vibes'], answers: { yes: 'done' } } })), /unknown evidence/);
  validateWorkflow(changeWorkflow({}));
});

test('commissioned requirements validate and default to the standard profile', () => {
  assert.deepEqual(requiredEvidence({}, 'merge'), ['review', 'gate']);
  assert.deepEqual(requiredEvidence({ requirements: { merge: { evidence: ['gate'] } } }, 'merge'), ['gate']);
  assert.deepEqual(requiredEvidence({ requirements: { merge: { evidence: [] } } }, 'satisfied'), ['review', 'gate']);
  assert.throws(() => validateRequirements({ deploy: { evidence: [] } }), /unsupported requirement outcome/);
  assert.throws(() => validateRequirements({ merge: { evidence: ['review', 'review'] } }), /unknown or duplicate/);
  assert.throws(() => validateRequirements({ merge: { evidence: ['review'], decision: false } }), /evidence list/);
});

test('a merge operation requires a current decision even when the graph omits requireDecision', async t => {
  const f = fixture(t, graph({ ship: action('forge.merge') }));
  await assert.rejects(f.engine.step('flow-1'), /current merge decision required/);
  assert.equal(f.store.all('attempt').length, 0);
});

test('a merge operation requires commissioned evidence even when no question asked for it', async t => {
  const f = fixture(t, graph({ ship: action('forge.merge') }));
  const flow = f.store.need('flow', 'flow-1'), identity = repositoryIdentity(f.root);
  f.store.put('flow', { ...flow, mergeAuthorization: { identity, taskRevision: flow.taskRevision, configDigest: flow.configDigest } });
  await assert.rejects(f.engine.step('flow-1'), /fresh review evidence required/);
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), evidence: { review: { ...identity }, gate: { ...identity } } });
  await assert.rejects(f.engine.step('flow-1'), /fresh review evidence required/, 'evidence without a producing attempt is not evidence');
  f.store.setMeta('config', { ...f.store.meta('config', {}), requirements: { merge: { evidence: [] } } });
  await f.engine.step('flow-1').catch(error => assert.doesNotMatch(error.message, /evidence/));
});

test('renamed nodes fill semantic slots from the operation that actually ran', async t => {
  const f = fixture(t, graph({ implement: trusted() }));
  await f.engine.tick(); const attempt = f.store.all('attempt')[0];
  attempt.intent = { ...attempt.intent, action: { operation: 'provider.build' } };
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'implemented', sessionId: 'builder-session' } });
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.results.build.sessionId, 'builder-session'); assert.equal(flow.results.implement.route, 'implemented');
  assert.equal(flow.sessions.builder, 'builder-session');
  assert.equal(bindingNode(graph({ implement: action('provider.build') }), 'build'), 'implement');
});

test('a trusted command cannot establish privileged facts by returning their field names', async t => {
  const f = fixture(t, graph({ merge: trusted() }));
  const health = f.store.meta('mainHealth', null);
  await f.engine.tick(); const attempt = f.store.all('attempt')[0];
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: { route: 'merged', merged: true, sha: 'forged', mainHealth: { status: 'green', head: 'forged' }, workspace: { path: '/forged' } } });
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.results.merge, undefined); assert.equal(flow.workspace, undefined);
  assert.deepEqual(f.store.meta('mainHealth', null), health); assert.equal(f.store.all('job').length, 0);
  assert.deepEqual(flow.evidence, {});
});
