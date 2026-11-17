import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { previewImage } from '../starter/factory/service/project-service.mjs';

test('the merge question carries the preview of its exact candidate, served as an image only', async t => {
  const f = sandbox(t);
  const workflow = { version: 1, start: 'decide', nodes: { decide: { kind: 'question', question: 'Merge?', role: 'operator', mergeDecision: true, answers: { merge: 'done', stop: 'stopped' } }, done: { kind: 'end', outcome: 'stopped' }, stopped: { kind: 'end', outcome: 'stopped' } } };
  f.store.put('task', { ...f.store.need('task', 'task-1'), risk: 'ordinary' });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.start();
  const identity = repositoryIdentity(f.root), flow = f.store.need('flow', 'flow-1');
  const review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Copy', threatModel: [], stopConditions: [] } } };
  f.store.put('attempt', { id: 'pv', flowId: 'flow-1', step: 'preview', status: 'passed', createdAt: new Date().toISOString() });
  f.store.put('flow', { ...flow, mode: 'delivery', kind: 'change', pool: 'document', workflow, workflowDigest: digest(workflow), step: 'decide', results: { review, preview: { route: 'pass', attemptId: 'pv', head: identity.head, files: [{ name: 'home.png', bytes: 4 }] } }, evidence: { review: { ...identity, attemptId: 'r' } } });
  await f.engine.step('flow-1');
  const item = f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open');
  assert.deepEqual(item.preview, { attemptId: 'pv', files: [{ name: 'home.png', bytes: 4 }], route: 'pass' });
  mkdirSync(join(f.store.stateDir, 'attempts', 'pv', 'preview'), { recursive: true });
  writeFileSync(join(f.store.stateDir, 'attempts', 'pv', 'preview', 'home.png'), Buffer.from('89504e47', 'hex'));
  writeFileSync(join(f.store.stateDir, 'attempts', 'pv', 'preview', 'page.html'), '<script>x</script>');
  assert.equal(previewImage(f.store, 'pv', new URLSearchParams({ name: 'home.png' })).dataUrl, 'data:image/png;base64,iVBORw==');
  assert.throws(() => previewImage(f.store, 'pv', new URLSearchParams({ name: 'page.html' })), /png, jpeg or webp/);
  assert.throws(() => previewImage(f.store, 'pv', new URLSearchParams({ name: '../x.png' })), /png, jpeg or webp/);
});
