import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { catalogDrift, compileCatalog, selectWorkflow, validateCatalogConfig } from '../starter/factory/core/catalog.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/catalog', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: {} };
const content = { version: 1, start: 'edit', nodes: { edit: { kind: 'effect', argv: ['true'], timeoutMs: 60000, evidence: 'check:links', next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
const catalog = { definitions: { standard: { reference: 'change.standard' }, content: { path: 'project/workflows/content.json' } }, selection: { default: 'standard', rules: [{ category: 'content', workflow: 'content' }] } };
function projectRoot(graph = content) {
  const root = mkdtempSync(join(tmpdir(), 'fct-catalog-')); mkdirSync(join(root, 'project/workflows'), { recursive: true });
  writeFileSync(join(root, 'project/workflows/content.json'), JSON.stringify(graph)); return root;
}

test('catalog configuration rejects unsafe paths, unknown references and ambiguous selection', () => {
  const bad = definitions => () => validateCatalogConfig({ definitions, selection: {} });
  // Which factory/ is upgrade-owned depends on the recorded install prefix, so it is refused when read.
  const unprefixed = projectRoot(); mkdirSync(join(unprefixed, 'factory/workflows'), { recursive: true }); writeFileSync(join(unprefixed, 'factory/workflows/x.json'), JSON.stringify(content));
  assert.throws(() => compileCatalog({ ...base, workflows: { definitions: { a: { path: 'factory/workflows/x.json' } }, selection: { default: 'a' } } }, unprefixed), /outside factory/);
  assert.throws(bad({ a: { path: '../elsewhere.json' } }), /inside the project/);
  assert.throws(bad({ a: { path: '/abs.json' } }), /relative/);
  assert.throws(bad({ a: { reference: 'change.yolo' } }), /unknown reference/);
  assert.throws(bad({ a: { reference: 'change.standard', path: 'x.json' } }), /exactly one/);
  validateCatalogConfig({ definitions: { a: { reference: 'change.standard' } }, selection: { rules: [{ category: 'x', workflow: 'a' }, { category: 'x', workflow: 'a' }] } }); // ordered: the first rule wins
  assert.throws(() => validateCatalogConfig({ definitions: { a: { reference: 'change.standard' } }, selection: { rules: [{ category: 'x', label: 'y', workflow: 'a' }] } }), /one task category or label/);
  assert.throws(() => validateCatalogConfig({ definitions: { a: { reference: 'change.standard' } }, selection: { default: 'b' } }), /must name a definition/);
});

test('compilation pins project file bytes, selects deterministically and detects drift', () => {
  const root = projectRoot(), compiled = compileCatalog({ ...base, workflows: catalog }, root);
  assert.equal(compiled.workflows.content.digest, digest(content));
  assert.match(compiled.workflows.content.source.sha256, /^[a-f\d]{64}$/);
  assert.deepEqual(compiled.workflows.standard.workflow, changeWorkflow({ ...base, workflows: catalog }));
  assert.equal(selectWorkflow(compiled, { category: 'content' }).name, 'content');
  assert.equal(selectWorkflow(compiled, { category: 'other' }).name, 'standard');
  assert.equal(selectWorkflow(compiled, {}).rule, 'default');
  assert.deepEqual(catalogDrift(compiled, root), []);
  writeFileSync(join(root, 'project/workflows/content.json'), JSON.stringify({ ...content, maxTransitions: 9 }));
  assert.match(catalogDrift(compiled, root)[0], /changed since commissioning/);
  const noDefault = compileCatalog({ ...base, workflows: { ...catalog, selection: { rules: catalog.selection.rules } } }, root);
  assert.throws(() => selectWorkflow(noDefault, { category: 'other' }), /no workflow selected/);
});

test('project graphs are validated with operation contracts and delegation policy at commissioning', () => {
  const forged = { ...content, nodes: { ...content.nodes, edit: { ...content.nodes.edit, evidence: 'review' } } };
  assert.throws(() => compileCatalog({ ...base, workflows: catalog }, projectRoot(forged)), /workflow content: .*kernel evidence/);
  const delegated = { version: 1, start: 'decide', nodes: { decide: { kind: 'question', role: 'orchestrator', mergeDecision: true, question: 'Merge?', answers: { merge: 'done' } }, done: { kind: 'end', outcome: 'completed' } } };
  assert.throws(() => compileCatalog({ ...base, workflows: catalog }, projectRoot(delegated)), /does not delegate/);
  compileCatalog({ ...base, policy: { mergeDecisionRole: 'orchestrator' }, workflows: catalog }, projectRoot(delegated));
  const root = projectRoot(); symlinkSync(join(root, 'project/workflows/content.json'), join(root, 'project/linked.json'));
  assert.throws(() => compileCatalog({ ...base, workflows: { definitions: { a: { path: 'project/linked.json' } }, selection: { default: 'a' } } }, root), /symlink/);
});

test('approval binds the selected workflow and admission refuses a changed selection or drifted source', async t => {
  const f = sandbox(t);
  mkdirSync(join(f.root, 'project/workflows'), { recursive: true }); writeFileSync(join(f.root, 'project/workflows/content.json'), JSON.stringify(content));
  const update = config => f.command('config.update', { config, note: 'Commission catalog' });
  const config = { ...base, workflows: catalog };
  assert.equal(update(config).status, 'completed');
  const put = f.command('task.put', { task: { id: 'copy', title: 'Fix copy', acceptance: ['Copy reads well'], category: 'content', risk: 'ordinary' } }).result;
  const approved = f.command('task.approve', { taskId: put.id, revision: put.revision }).result;
  assert.equal(approved.approvedWorkflow.name, 'content'); assert.equal(approved.approvedWorkflow.digest, digest(content));

  const commission = () => f.store.tx(() => f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') }));
  // Recommissioning a changed graph leaves the old approval behind.
  writeFileSync(join(f.root, 'project/workflows/content.json'), JSON.stringify({ ...content, maxTransitions: 9 }));
  assert.equal(update(config).status, 'completed'); commission();
  const stale = f.command('flow.start', { taskId: put.id, revision: put.revision, flowId: 'flow-copy' });
  assert.equal(stale.status, 'rejected'); assert.match(stale.error, /approve it again|approve the task again/);

  // Re-approval covers the newly commissioned graph; a later uncommissioned edit is refused.
  f.command('task.approve', { taskId: put.id, revision: put.revision });
  writeFileSync(join(f.root, 'project/workflows/content.json'), JSON.stringify({ ...content, maxTransitions: 7 }));
  const drifted = f.command('flow.start', { taskId: put.id, revision: put.revision, flowId: 'flow-copy' });
  assert.equal(drifted.status, 'rejected'); assert.match(drifted.error, /changed since commissioning/);

  // Restoring the commissioned bytes admits the task into its approved project workflow.
  writeFileSync(join(f.root, 'project/workflows/content.json'), JSON.stringify({ ...content, maxTransitions: 9 }));
  f.store.tx(() => f.store.setMeta('mainHealth', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() }));
  const started = f.command('flow.start', { taskId: put.id, revision: put.revision, flowId: 'flow-copy' });
  assert.equal(started.status, 'completed', started.error);
  const flow = f.store.need('flow', 'flow-copy');
  assert.equal(flow.workflowName, 'content'); assert.equal(flow.workflowDigest, digest({ ...content, maxTransitions: 9 }));
});
