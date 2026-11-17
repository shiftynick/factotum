import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMANDS, commandHelp } from '../starter/factory/core/command-help.mjs';
import { sandbox } from './helpers.mjs';

test('every command has help, and help covers only real commands', () => {
  const source = readFileSync(new URL('../starter/factory/core/project.mjs', import.meta.url), 'utf8');
  const cases = new Set([...source.matchAll(/case '([a-z.]+)'/g)].map(m => m[1]));
  assert.deepEqual([...cases].filter(c => !COMMANDS[c]), [], 'commands without help');
  assert.deepEqual(Object.keys(COMMANDS).filter(c => !cases.has(c)), [], 'help for commands that do not exist');
  assert.match(commandHelp('task.approve').text, /revision \(required\)/);
  assert.equal(commandHelp('source.sync').routed, true);
});

test('errors name the missing note and route maintenance operations', t => {
  const f = sandbox(t);
  assert.match(f.command('flow.replan', { flowId: 'x' }).error, /note is required/);
  assert.match(f.command('source.sync', {}).error, /maintenance operation; send job.enqueue/);
});

test('task.restart settles an uncertain attempt, abandons the old flow, approves and starts again in one receipt', async t => {
  const f = sandbox(t);
  assert.equal(f.start().status, 'completed');
  const flow = f.store.need('flow', 'flow-1');
  f.store.put('attempt', { id: 'u', flowId: flow.id, step: flow.step, status: 'uncertain', createdAt: new Date().toISOString(), intent: {} });
  f.store.put('flow', { ...flow, attemptId: 'u', state: 'stopped' });
  f.store.put('inbox', { id: 'q-old', kind: 'question', status: 'open', flowId: 'flow-1', version: 1, createdAt: new Date().toISOString() });
  f.store.put('inbox', { id: 'n-old', kind: 'notice', status: 'open', flowId: 'flow-1', version: 1, createdAt: new Date().toISOString() });
  const edited = f.command('task.put', { task: { ...f.task, title: 'Changed brief' } }).result;
  assert.notEqual(edited.approvedRevision, edited.revision, 'the brief change revoked approval');
  assert.equal(f.command('task.restart', { taskId: f.task.id, revision: 'old', note: 'x' }).status, 'rejected', 'stale revision');
  const restart = f.command('task.restart', { taskId: f.task.id, revision: edited.revision, note: 'Brief changed; start again' });
  assert.equal(restart.status, 'completed', restart.error);
  assert.deepEqual(restart.result.settled, ['u']); assert.deepEqual(restart.result.abandoned, ['flow-1']);
  assert.equal(f.store.need('attempt', 'u').status, 'failed'); assert.equal(f.store.need('flow', 'flow-1').state, 'failed');
  assert.equal(f.store.need('inbox', 'q-old').status, 'superseded'); assert.equal(f.store.need('inbox', 'n-old').status, 'superseded', 'the old flow leaves nothing to answer or acknowledge');
  assert.equal(f.store.need('task', f.task.id).approvedRevision, edited.revision);
  assert.equal(f.store.need('flow', restart.result.flowId).taskRevision, edited.revision);
  const { publicFlow } = await import('../starter/factory/core/project.mjs');
  assert.equal(publicFlow(f.store.need('flow', 'flow-1')).outcome, 'abandoned');
});

test('approving a new revision retires the flow its brief change stopped, requeues the task and links the next flow', async t => {
  const f = sandbox(t);
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { queueOnApproval: true } });
  assert.equal(f.start().status, 'completed');
  f.store.put('queue', { id: f.task.id, status: 'claimed', flowId: 'flow-1', claimedAt: new Date().toISOString() });
  const edited = f.command('task.put', { task: { ...f.task, title: 'Edited brief' } }).result;
  assert.equal(f.store.need('flow', 'flow-1').state, 'stopped', 'the brief change stopped it');
  const approved = f.command('task.approve', { taskId: f.task.id, revision: edited.revision });
  assert.equal(approved.status, 'completed', approved.error); assert.deepEqual(approved.result.retiredFlows, ['flow-1']);
  assert.equal(f.store.need('flow', 'flow-1').state, 'failed'); assert.ok(f.store.need('flow', 'flow-1').abandonedAt);
  assert.equal(f.store.need('queue', f.task.id).status, 'queued', 'requeued');
  const started = f.command('flow.start', { taskId: f.task.id, revision: edited.revision, flowId: 'flow-2' });
  assert.equal(started.status, 'completed', started.error);
  assert.equal(f.store.need('flow', 'flow-1').replacedBy, 'flow-2'); assert.deepEqual(f.store.need('flow', 'flow-2').replaces, ['flow-1']);
});

test('the orchestrator can stop a flow for the operator, and an over-long timeout says the limit', async t => {
  const f = sandbox(t); f.start();
  const { executeCommand } = await import('../starter/factory/core/project.mjs');
  const { uid, validateWorkflow } = await import('../starter/factory/core/contracts.mjs');
  const stop = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'stop', payload: { flowId: 'flow-1', note: 'Drain for a config change' }, onBehalfOf: { principal: 'operator', instruction: 'Enable notifications' } });
  assert.equal(stop.status, 'completed', stop.error);
  assert.throws(() => validateWorkflow({ version: 1, start: 'gate', nodes: { gate: { kind: 'effect', argv: ['true'], timeoutMs: 5400000, next: 'done', onFailure: 'done' }, done: { kind: 'end', outcome: 'completed' } } }), /from 1 to 3600000 \(one hour\); got 5400000/);
});
