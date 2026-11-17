import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { verifyDecision } from '../starter/factory/workflows/actions.mjs';
import { mergeDecisionRole } from '../starter/factory/core/risk.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';

const workflow = { version: 1, start: 'decide', nodes: {
  decide: { kind: 'question', question: 'Merge?', role: 'orchestrator', mergeDecision: true, answers: { merge: 'merge', stop: 'stopped' } },
  merge: { kind: 'effect', action: { operation: 'forge.merge' }, timeoutMs: 60000, next: 'done', onFailure: 'failed' },
  done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' }, stopped: { kind: 'end', outcome: 'stopped' } } };

async function fixture(t, { role = 'orchestrator', candidate = null, risk = 'ordinary' } = {}) {
  const f = sandbox(t);
  const task = f.store.need('task', 'task-1'); f.store.put('task', { ...task, risk });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.start();
  const identity = repositoryIdentity(f.root), flow = f.store.need('flow', 'flow-1');
  const review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Copy change', threatModel: [], stopConditions: [] } } };
  f.store.put('flow', { ...flow, mode: 'delivery', kind: 'change', workflow, workflowDigest: digest(workflow), step: 'decide', mergeDecisionRole: role, candidate, results: { review }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
  await f.engine.step('flow-1');
  const item = f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open');
  const answer = (actor, extra = {}) => f.command('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'merge', ...extra }, { actor });
  return { ...f, identity, item, answer };
}

test('merge decision role must be operator or orchestrator', () => {
  const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/x', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
  validateConfig({ ...base, policy: { mergeDecisionRole: 'orchestrator' } });
  assert.throws(() => validateConfig({ ...base, policy: { mergeDecisionRole: 'builder' } }), /invalid merge decision role/);
});

test('a commissioned orchestrator decides an ordinary merge under its own attribution, per exact candidate', async t => {
  const f = await fixture(t);
  assert.equal(f.item.role, 'orchestrator'); assert.equal(f.item.autoMerge, false);
  assert.equal(f.item.status, 'open', 'delegation is not automatic merge: someone must still answer');
  assert.equal(f.answer('orchestrator').status, 'completed');
  const authorization = f.store.need('flow', 'flow-1').mergeAuthorization;
  assert.equal(authorization.actor, 'orchestrator'); assert.equal(authorization.authority, 'mergeDecisionRole');
  assert.equal(authorization.identity.head, f.identity.head);
  verifyDecision(f.store, f.store.need('flow', 'flow-1'));
});

test('the operator can still answer a delegated merge question', async t => {
  const f = await fixture(t);
  assert.equal(f.answer('operator').status, 'completed');
  assert.equal(f.store.need('flow', 'flow-1').mergeAuthorization.authority, 'operator');
});

test('without delegation the orchestrator cannot answer a merge question', async t => {
  const f = await fixture(t, { role: 'operator' });
  assert.equal(f.item.role, 'operator'); assert.equal(f.answer('orchestrator').status, 'rejected');
});

test('strict risk and adopted external candidates are never delegated', async t => {
  const grant = { mergeDecisionRole: 'orchestrator' };
  assert.equal(mergeDecisionRole({ risk: 'ordinary' }, grant), 'orchestrator');
  assert.equal(mergeDecisionRole({ risk: 'strict' }, grant), 'operator');
  assert.equal(mergeDecisionRole({ risk: 'ordinary' }, { ...grant, effectiveRisk: 'strict' }), 'operator');
  assert.equal(mergeDecisionRole({ risk: 'ordinary' }, { ...grant, riskAssessments: [{ assessment: { level: 'strict' } }] }), 'operator');
  const adopted = await fixture(t, { candidate: { number: 4, head: 'a'.repeat(40), base: 'b'.repeat(40) } });
  assert.equal(adopted.item.role, 'operator'); assert.equal(adopted.answer('orchestrator').status, 'rejected');
});

test('a delegated authorization is rechecked before merge if the candidate escalates to strict', async t => {
  const f = await fixture(t);
  assert.equal(f.answer('orchestrator').status, 'completed');
  const flow = f.store.need('flow', 'flow-1'); f.store.put('flow', { ...flow, effectiveRisk: 'strict' });
  assert.throws(() => verifyDecision(f.store, f.store.need('flow', 'flow-1')));
});

test('on an operator instruction the orchestrator can decide an ordinary merge, attributed to itself', async t => {
  const f = await fixture(t, { role: 'operator' });
  const receipt = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'answer', payload: { inboxId: f.item.id, version: f.item.version, subjectDigest: f.item.subjectDigest, answer: 'merge' }, onBehalfOf: { principal: 'operator', instruction: 'Operator in thread: "merge it"' } });
  assert.equal(receipt.status, 'completed', receipt.error);
  const authorization = f.store.need('flow', 'flow-1').mergeAuthorization;
  assert.equal(authorization.actor, 'orchestrator'); assert.equal(authorization.authority, 'delegated'); assert.match(authorization.onBehalfOf.instruction, /merge it/);
});
