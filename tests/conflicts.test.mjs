import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { activeConflictPaths, captureConflictScope } from '../starter/factory/operations/conflicts.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { executorDigest } from '../starter/factory/core/effects.mjs';

function setup(t) {
  const f = sandbox(t);
  f.store.setMeta('mainHealth', { status: 'green', checkedAt: new Date().toISOString() });
  const task = { id: 'next', revision: 'v1', approvedRevision: 'v1', paths: ['input.txt'] };
  f.store.put('task', task);
  return { ...f, task };
}
test('admission uses pinned active task scope and the brief paths', t => {
  const f = setup(t);
  f.store.put('task', { id: 'other', paths: [] });
  f.store.put('flow', { id: 'active', taskId: 'other', state: 'ready', taskSnapshot: { paths: ['old-scope'] }, results: { plan: { result: { files: ['input.txt'] } } } });
  assert.match(admissionReasons(f.store, f.task, { maxFlows: 2 }).join(), /paths overlap/);
  assert.match(admissionReasons(f.store, { ...f.task, paths: ['old-scope/file'] }, { maxFlows: 2 }).join(), /paths overlap/);
  // A plan record no longer widens a queued task's scope: only its brief paths count.
  const candidate = { ...f.task, risk: 'ordinary', paths: [], approvalVersion: 1 };
  f.store.put('plan', { id: candidate.id, status: 'ready', planResult: { result: { files: ['input.txt'] } } });
  assert.ok(admissionReasons(f.store, candidate, { maxFlows: 2, requirePaths: true }).includes('planned paths required'));
});
test('actual owned worktree edits, renames and untracked files block undeclared conflicts', async t => {
  const f = setup(t);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'active' });
  const flow = { id: 'active', taskId: 'other', state: 'ready', taskSnapshot: { paths: [] }, workspace };
  f.store.put('flow', flow);
  writeFileSync(join(workspace.path, 'input.txt'), 'edited');
  writeFileSync(join(workspace.path, 'new.txt'), 'untracked');
  assert.match(admissionReasons(f.store, f.task, { maxFlows: 2 }).join(), /paths overlap/);
  assert.match(admissionReasons(f.store, { ...f.task, paths: ['new.txt'] }, { maxFlows: 2 }).join(), /paths overlap/);
  renameSync(join(workspace.path, 'input.txt'), join(workspace.path, 'renamed.txt'));
  assert.deepEqual(activeConflictPaths(f.store, flow).sort(), ['input.txt', 'new.txt', 'renamed.txt']);
  unlinkSync(workspace.manifestPath);
  assert.match(admissionReasons(f.store, { ...f.task, paths: ['unrelated.txt'] }, { maxFlows: 2 }).join(), /conflict evidence unavailable/);
});
test('an assigned workspace with another flow identity never supplies conflict evidence', async t => {
  const f = setup(t);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'owner' });
  f.store.put('flow', { id: 'imposter', taskId: 'other', state: 'stopped', workspace });
  assert.match(admissionReasons(f.store, f.task, { maxFlows: 2 }).join(), /conflict evidence unavailable/);
});
test('relative path aliases and root scopes conflict; invalid scope holds admission', t => {
  const f = setup(t);
  f.store.put('flow', { id: 'active', taskId: 'other', state: 'ready', results: { plan: { result: { files: ['./src//'] } } } });
  assert.match(admissionReasons(f.store, { ...f.task, paths: ['./src/file.mjs'] }, { maxFlows: 2 }).join(), /paths overlap/);
  assert.match(admissionReasons(f.store, { ...f.task, paths: ['.'] }, { maxFlows: 2 }).join(), /paths overlap/);
  for (const path of ['../src', '/src', 'src/../file', 'src/**']) assert.match(admissionReasons(f.store, { ...f.task, paths: [path] }, { maxFlows: 2 }).join(), /scope invalid/);
});
test('bulk observation reuses one captured worktree scope but final admission reads fresh evidence', async t => {
  const f = setup(t);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'active' });
  writeFileSync(join(workspace.path, 'input.txt'), 'edited');
  f.store.put('flow', { id: 'active', taskId: 'other', state: 'ready', workspace });
  const conflictScope = captureConflictScope(f.store);
  unlinkSync(workspace.manifestPath);
  for (let i = 0; i < 100; i++) assert.deepEqual(admissionReasons(f.store, f.task, { maxFlows: 2, conflictScope }), ['paths overlap: active']);
  assert.match(admissionReasons(f.store, f.task, { maxFlows: 2 }).join(), /conflict evidence unavailable/);
});
