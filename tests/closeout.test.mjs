import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { backupProject, restoreProject } from '../starter/factory/core/backup.mjs';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

test('a known source closure with a containment failure retains an explicit closeout warning', async t => {
  const f = sandbox(t);
  const workflow = { version: 1, start: 'close-task', nodes: {
    'close-task': { kind: 'effect', argv: ['true'], timeoutMs: 60000, next: 'cleanup', onFailure: 'cleanup' },
    cleanup: { kind: 'end', outcome: 'completed' },
  } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.start(); await f.engine.tick(); const attempt = f.store.all('attempt')[0];
  attempt.intent = { ...attempt.intent, action: { operation: 'forge.closeTask' } };
  f.engine.settle('flow-1', attempt, { exitCode: 0, reason: 'descendant-survival', costMicros: 0, actionResult: { route: 'closed', obligations: [{ id: 'source-closure', status: 'passed', evidence: 'known remote result' }] } });
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(f.store.need('attempt', attempt.id).status, 'failed');
  assert.equal(flow.step, 'cleanup'); assert.equal(flow.postMergePending, true);
  assert.deepEqual(flow.closeoutWarnings, [{ attemptId: attempt.id, step: 'close-task', reason: 'descendant-survival' }]);
  assert.equal(f.store.need('obligation', 'source-closure').status, 'passed');
});

test('backup and held restore retain read-only external reconciliation proof files', t => {
  const f = sandbox(t), proof = { operation: 'forge.merge', result: { merged: true }, fictional: true };
  mkdirSync(join(f.stateDir, 'reconciliations')); writeFileSync(join(f.stateDir, 'reconciliations', 'proof.json'), JSON.stringify(proof));
  const backup = join(f.base, 'backup'), restored = join(f.base, 'restored');
  backupProject(f.stateDir, backup); restoreProject(backup, restored);
  assert.deepEqual(JSON.parse(readFileSync(join(restored, 'reconciliations', 'proof.json'))), proof);
});
