import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';

const instruction = { principal: 'operator', instruction: 'Operator in thread: "set the sync to every six hours"', reference: 't3-thread://v1/example' };
function setup(t, delegatedOperations) {
  const f = sandbox(t);
  f.store.setMeta('config', { ...f.store.meta('config', {}), policy: { ...(delegatedOperations ? { delegatedOperations } : {}) } });
  const send = (operation, payload, extra = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation, payload, ...extra });
  return { ...f, send };
}
const schedule = { schedule: { id: 'issue-source', operation: 'source.sync', type: 'interval', everyMs: 6 * 3600000, enabled: true } };

test('an empty delegation list turns delegation off, even with an instruction', t => {
  const f = setup(t, []);
  const plain = f.send('schedule.put', schedule);
  assert.equal(plain.status, 'rejected'); assert.match(plain.error, /policy.delegatedOperations/);
  const instructed = f.send('schedule.put', schedule, { onBehalfOf: instruction });
  assert.equal(instructed.status, 'rejected'); assert.match(instructed.error, /not delegated/);
});

test('a delegated operation runs with a recorded instruction and is attributed to the orchestrator', t => {
  const f = setup(t, ['schedule.put', 'operator.presence']);
  assert.equal(f.send('schedule.put', schedule).status, 'rejected', 'an instruction is still required');
  const receipt = f.send('schedule.put', schedule, { onBehalfOf: instruction });
  assert.equal(receipt.status, 'completed', receipt.error);
  assert.equal(receipt.actor, 'orchestrator'); assert.deepEqual(receipt.onBehalfOf, instruction);
  const event = f.store.events(50).find(row => row.type === 'command.completed' && row.payload.commandId === receipt.commandId);
  assert.equal(event.payload.actor, 'orchestrator'); assert.equal(event.payload.onBehalfOf.instruction, instruction.instruction);
  assert.equal(f.send('operator.presence', { state: 'away' }, { onBehalfOf: instruction }).status, 'completed');
  assert.equal(f.send('task.approve', { taskId: f.task.id, revision: f.task.revision }, { onBehalfOf: instruction }).status, 'rejected', 'only listed operations are delegated');
});

test('every operator command is delegable, and only the orchestrator acts on behalf with a real instruction', t => {
  const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/x', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
  validateConfig({ ...base, policy: { delegatedOperations: ['config.update', 'attempt.resolve', 'spending.reconcile', 'restore.release', 'answer'] } });
  assert.throws(() => validateConfig({ ...base, policy: { delegatedOperations: ['made.up'] } }), /unknown or non-operator/);
  const f = setup(t, ['schedule.put']);
  assert.throws(() => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'operator', operation: 'pause', payload: {}, onBehalfOf: instruction }), /only the orchestrator/);
  assert.throws(() => f.send('schedule.put', schedule, { onBehalfOf: { principal: 'operator', instruction: '' } }), /instruction/);
});

test('by default every delegable operation is delegated, still requiring a recorded instruction', t => {
  const f = setup(t);
  assert.equal(f.send('schedule.put', schedule).status, 'rejected');
  assert.equal(f.send('schedule.put', schedule, { onBehalfOf: instruction }).status, 'completed');
  assert.equal(f.send('task.approve', { taskId: f.task.id, revision: f.task.revision }, { onBehalfOf: instruction }).status, 'completed');
  assert.equal(f.send('config.update', { config: {}, note: 'Operator asked to reset to rehearsal' }, { onBehalfOf: instruction }).status, 'completed');
  f.store.setMeta('recoveryHold', true);
  assert.equal(f.send('restore.release', { note: 'Hold from a known dispatch fault' }, { onBehalfOf: instruction }).status, 'completed');
});

test('routine operator questions can be answered on instruction; merge decisions cannot', async t => {
  const f = setup(t);
  const item = f.command('inbox.publish', { id: 'pick', kind: 'question', title: 'Pick', context: 'Two options', question: 'Which?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }, { actor: 'orchestrator' }).result;
  const answer = extra => f.send('answer', { inboxId: item.id, version: item.version, subjectDigest: item.subjectDigest, answer: 'a' }, extra);
  assert.equal(answer().status, 'rejected');
  const done = answer({ onBehalfOf: instruction });
  assert.equal(done.status, 'completed', done.error); assert.equal(done.onBehalfOf.principal, 'operator');
});

test('queueOnApproval appends an approved open task and drops it when approval is lost', t => {
  const f = setup(t);
  f.store.setMeta('config', { ...f.store.meta('config', {}), policy: { queueOnApproval: true } });
  const queued = () => f.store.all('queue').filter(row => row.status === 'queued').map(row => row.id);
  f.command('task.put', { task: { id: 'other', title: 'Other', acceptance: ['x'] } });
  f.command('task.approve', { taskId: 'other', revision: f.store.need('task', 'other').revision });
  f.command('task.approve', { taskId: f.task.id, revision: f.task.revision });
  assert.deepEqual(queued(), ['other', f.task.id]);
  f.command('task.revoke', { taskId: 'other', note: 'Not now' });
  assert.deepEqual(queued(), [f.task.id]);
  const current = f.store.need('task', f.task.id);
  f.command('task.put', { task: { id: current.id, title: 'Changed brief', acceptance: ['y'] }, expectedRevision: current.revision });
  assert.deepEqual(queued(), [], 'a changed brief loses approval and leaves the queue');
});

test('a delegated maintenance enqueue records the orchestrator and its instruction in the grant', t => {
  const f = setup(t);
  const receipt = f.send('job.enqueue', { operation: 'source.sync', note: 'Refresh issues as asked' }, { onBehalfOf: instruction });
  assert.equal(receipt.status, 'completed', receipt.error);
  assert.equal(receipt.result.grant.actor, 'orchestrator'); assert.equal(receipt.result.grant.onBehalfOf.instruction, instruction.instruction);
});

test('deploy and spending approvals record a delegated orchestrator answer only when policy allows it', async () => {
  const { recordIntegrationDecision } = await import('../starter/factory/workflows/integrations.mjs');
  const flow = () => ({ step: 'approve', integration: { payload: { candidate: { head: 'abc' } } }, results: {} }), node = { integrationDecision: true, role: 'operator' }, identity = { head: 'abc' };
  assert.throws(() => recordIntegrationDecision(flow(), node, { answer: 'approve' }, 'orchestrator', identity), /designated integration authority/);
  const approved = flow(); recordIntegrationDecision(approved, node, { answer: 'approve' }, 'orchestrator', identity, { delegated: true, onBehalfOf: instruction });
  assert.equal(approved.integrationDecisions.approve.actor, 'orchestrator'); assert.equal(approved.integrationDecisions.approve.onBehalfOf.instruction, instruction.instruction);
});

test('approve with queue appends the task in the same step, without the policy', t => {
  const f = setup(t);
  const receipt = f.command('task.approve', { taskId: f.task.id, revision: f.task.revision, queue: true });
  assert.equal(receipt.status, 'completed', receipt.error);
  assert.deepEqual(f.store.all('queue').filter(row => row.status === 'queued').map(row => row.id), [f.task.id]);
});

test('labels group tasks without changing the approved brief', t => {
  const f = setup(t);
  f.command('task.approve', { taskId: f.task.id, revision: f.task.revision });
  const labeled = f.command('task.label', { taskId: f.task.id, labels: [' docs ', 'docs', 'content'] }).result;
  assert.deepEqual(labeled.labels, ['docs', 'content']); assert.equal(labeled.approvedRevision, labeled.revision, 'still approved');
  const current = f.store.need('task', f.task.id);
  const put = f.command('task.put', { task: { id: current.id, title: current.title, acceptance: current.acceptance, labels: ['ops'] }, expectedRevision: current.revision }).result;
  assert.deepEqual(put.labels, ['ops']); assert.equal(put.revision, current.revision); assert.equal(put.approvedRevision, current.revision);
  assert.equal(f.command('task.put', { task: { id: current.id, title: current.title, acceptance: current.acceptance, labels: [] } }).result.labels, undefined);
  assert.equal(f.command('task.label', { taskId: f.task.id, labels: ['x'.repeat(41)] }).status, 'rejected');
  assert.equal(f.send('task.label', { taskId: f.task.id, labels: ['agent'] }, { onBehalfOf: instruction }).status, 'completed');
});
