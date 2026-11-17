import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { compileCatalog, selectWorkflow } from '../starter/factory/core/catalog.mjs';
import { requiredEvidence } from '../starter/factory/core/operations.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 },
  policy: { maxDocumentFlows: 1 },
  workflows: { definitions: { change: { reference: 'change.standard' }, research: { reference: 'change.document' } }, selection: { default: 'change', rules: [{ label: 'research', workflow: 'research' }] } } };

function setup(t) {
  const f = sandbox(t);
  const update = f.command('config.update', { config: base, note: 'Add the document workflow' });
  assert.equal(update.status, 'completed', update.error);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', { status: 'green', head: 'a'.repeat(40), checkedAt: new Date().toISOString() });
  return f;
}
const approved = (f, id, labels = []) => { const put = f.command('task.put', { task: { id, title: id, acceptance: ['Written'], labels } }).result; assert.equal(f.command('task.approve', { taskId: id, revision: put.revision }).status, 'completed'); return f.store.need('task', id); };

test('the document reference writes, reviews and merges with no check gate', () => {
  const catalog = compileCatalog(base, process.cwd()), graph = catalog.workflows.research.workflow;
  assert.equal(catalog.workflows.research.kind, 'document');
  assert.equal(selectWorkflow(catalog, { labels: ['research'] }).name, 'research');
  for (const step of ['gate', 'gate-question', 'satisfied-gate']) assert.equal(graph.nodes[step], undefined);
  assert.equal(graph.nodes.review.resultEdges.pass, 'decide'); assert.equal(graph.nodes.followups.next, 'decide');
  assert.deepEqual(graph.nodes.decide.requireEvidence, ['review']); assert.ok(graph.nodes.decide.mergeDecision);
  assert.match(graph.nodes.review.action.guidance, /document, not code/); assert.match(graph.nodes.build.action.guidance, /do not add tests/);
  assert.ok(graph.nodes.plan, 'plans under policy.planning');
  assert.deepEqual(requiredEvidence(base, 'merge', { pool: 'document' }), ['review']);
  assert.deepEqual(requiredEvidence(base, 'merge', { kind: 'change' }), ['review', 'gate'], 'change flows keep the gate');
});

test('document flows use their own capacity pool but keep main health checks', t => {
  const f = setup(t);
  const code = approved(f, 'code'), doc = approved(f, 'doc', ['research']), second = approved(f, 'doc-2', ['research']);
  assert.equal(f.command('flow.start', { taskId: 'code', revision: code.revision, flowId: 'code-flow' }).status, 'completed');
  assert.deepEqual(admissionReasons(f.store, f.store.need('task', 'doc')), [], 'a running change does not hold a document');
  const start = f.command('flow.start', { taskId: 'doc', revision: doc.revision, flowId: 'doc-flow' });
  assert.equal(start.status, 'completed', start.error);
  const flow = f.store.need('flow', 'doc-flow');
  assert.equal(flow.kind, 'change'); assert.equal(flow.pool, 'document'); assert.equal(flow.workflowName, 'research');
  assert.ok(admissionReasons(f.store, second).includes('document flow capacity exhausted'));
  assert.ok(admissionReasons(f.store, approved(f, 'code-2')).includes('flow capacity exhausted'), 'and a document does not free a change slot');
  f.store.setMeta('mainHealth', { status: 'red', head: 'a'.repeat(40), checkedAt: new Date().toISOString() });
  f.command('flow.stop', { flowId: 'doc-flow', reason: 'x' }); f.store.put('flow', { ...f.store.need('flow', 'doc-flow'), state: 'failed' });
  assert.ok(admissionReasons(f.store, second).some(reason => /main/.test(reason)), 'red main still holds a document');
  assert.equal(f.command('config.update', { config: { ...base, policy: { maxDocumentFlows: 0 } }, note: 'x' }).status, 'rejected');
});

test('a document flow is asked to merge on review evidence alone; a change flow still needs the gate', async t => {
  const workflow = { version: 1, start: 'decide', nodes: {
    decide: { kind: 'question', question: 'Merge?', role: 'operator', mergeDecision: true, answers: { merge: 'done', stop: 'stopped' } },
    done: { kind: 'end', outcome: 'stopped' }, stopped: { kind: 'end', outcome: 'stopped' } } };
  for (const pool of ['document', undefined]) {
    const f = sandbox(t);
    f.store.put('task', { ...f.store.need('task', 'task-1'), risk: 'ordinary' });
    f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.start();
    const identity = repositoryIdentity(f.root), flow = f.store.need('flow', 'flow-1');
    const review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Copy', threatModel: [], stopConditions: [] } } };
    f.store.put('flow', { ...flow, mode: 'delivery', kind: 'change', ...(pool ? { pool } : {}), workflow, workflowDigest: digest(workflow), step: 'decide', results: { review }, evidence: { review: { ...identity, attemptId: 'review-attempt' } } });
    await f.engine.step('flow-1').catch(() => {});
    const item = f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.status === 'open');
    if (pool) assert.ok(item, 'merge question opened'); else assert.equal(item, undefined, 'no gate evidence, no question');
  }
});
