import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';
import { inspect, attemptDir } from '../starter/factory/core/effects.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

const source = (state, revision) => ({ repository: 'fictional/demo', issue: 34, revision: 'issue-34-r1', externalDependencies: [{ repository: 'fictional/demo', issue: 33, taskId: 'github:33', state, revision, observedAt: new Date().toISOString(), provenance: 'github-issue-state' }] });

test('a dependency closing or changing keeps the dependent approved and its running flow alive', t => {
  const f = sandbox(t);
  const put = f.command('task.put', { task: { id: 'github:34', title: 'Dependent', acceptance: ['Works'], dependencies: ['github:33'], source: source('open', 'issue-33-r1') } }).result;
  assert.equal(f.command('task.approve', { taskId: put.id, revision: put.revision }).status, 'completed');
  f.store.put('flow', { id: 'running', taskId: put.id, taskRevision: put.revision, state: 'ready', kind: 'change', workflow: { nodes: {} } });
  const moved = f.command('task.put', { task: { id: 'github:34', title: 'Dependent', acceptance: ['Works'], dependencies: ['github:33'], source: source('closed', 'issue-33-r2') } }).result;
  assert.equal(moved.revision, put.revision); assert.equal(moved.approvedRevision, put.revision);
  assert.equal(moved.source.externalDependencies[0].state, 'closed', 'the new fact is still recorded');
  assert.equal(f.store.need('flow', 'running').state, 'ready', 'not stopped');
  const edited = f.command('task.put', { task: { id: 'github:34', title: 'Dependent, edited', acceptance: ['Works'], dependencies: ['github:33'], source: { ...source('closed', 'issue-33-r2'), revision: 'issue-34-r2' } } }).result;
  assert.notEqual(edited.revision, put.revision, 'its own brief changing still needs approval'); assert.equal(edited.approvedRevision, null);
});

test('an edit to a dependency’s content revokes the dependent, but its progress does not', t => {
  const f = sandbox(t), fact = (state, revision, contentRevision) => ({ ...source(state, revision), externalDependencies: [{ ...source(state, revision).externalDependencies[0], contentRevision }] });
  const put = s => f.command('task.put', { task: { id: 'github:34', title: 'Dependent', acceptance: ['Works'], dependencies: ['github:33'], source: s } }).result;
  const first = put(fact('open', 'r1', 'text-1'));
  f.command('task.approve', { taskId: first.id, revision: first.revision });
  assert.equal(put(fact('closed', 'r2', 'text-1')).approvedRevision, first.revision, 'closing and relabelling keep approval');
  const edited = put(fact('closed', 'r3', 'text-2'));
  assert.notEqual(edited.revision, first.revision); assert.equal(edited.approvedRevision, null, 'an edited dependency needs approval again');
  // A fact recorded before content was tracked has nothing to compare against.
  const g = sandbox(t), legacy = g.command('task.put', { task: { id: 'github:34', title: 'Dependent', acceptance: ['Works'], dependencies: ['github:33'], source: source('open', 'r1') } }).result;
  g.command('task.approve', { taskId: legacy.id, revision: legacy.revision });
  assert.equal(g.command('task.put', { task: { id: 'github:34', title: 'Dependent', acceptance: ['Works'], dependencies: ['github:33'], source: fact('open', 'r1', 'text-1') } }).result.approvedRevision, legacy.revision, 'upgrading revokes nothing');
});

test('an attempt stopped on request settles as aborted, and resuming reruns its step', async t => {
  const f = sandbox(t);
  assert.equal(f.start().status, 'completed');
  await f.engine.tick();
  const flow = f.store.need('flow', 'flow-1'), attempt = f.store.need('attempt', flow.attemptId);
  const dir = attemptDir(f.store, attempt); mkdirSync(dir, { recursive: true });
  for (const name of ['stdout.log', 'stderr.log']) writeFileSync(join(dir, name), '');
  const { fileDigest } = await import('../starter/factory/core/contracts.mjs');
  const withAction = { ...attempt, intent: { ...attempt.intent, action: { operation: 'provider.plan' } } };
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify({ version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: attempt.intent.synthetic, stdoutDigest: fileDigest(join(dir, 'stdout.log')), stderrDigest: fileDigest(join(dir, 'stderr.log')), costMicros: 0, exitCode: null, signal: 'SIGTERM', reason: 'abort' }));
  const effect = inspect(f.store, withAction);
  assert.equal(effect.kind, 'terminal'); assert.equal(effect.receipt.aborted, true);
});

test('a queue entry claimed by a finished flow is released', async t => {
  const f = sandbox(t);
  f.store.put('flow', { id: 'gone', taskId: f.task.id, state: 'failed', abandonedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), workflow: { nodes: {} } });
  f.store.put('queue', { id: f.task.id, status: 'claimed', flowId: 'gone', claimedAt: new Date().toISOString() });
  await operationalTick(f.store);
  assert.equal(f.store.need('queue', f.task.id).status, 'finished'); assert.equal(f.store.need('queue', f.task.id).flowState, 'abandoned');
});
