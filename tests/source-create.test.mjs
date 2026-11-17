import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { createSourceTask, syncIssueSource } from '../starter/factory/workflows/source-sync.mjs';
import { commandSourceWrite, sourceCapabilities, lifecycleEnabled } from '../starter/factory/operations/source-adapter.mjs';
import { sourceSettings } from '../starter/factory/operations/source-config.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';

function setup(t, sourceSync) {
  const f = sandbox(t), config = { mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, policy: {}, ...(sourceSync ? { sourceSync } : {}) };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); return { ...f, config };
}
// A fake GitHub issues API with list, read and create.
function fakeGitHub() {
  const issues = {}, posts = [];
  const transport = async ({ path, method = 'GET', body }) => {
    if (method === 'POST' && path.endsWith('/issues')) { const number = Object.keys(issues).length + 1; posts.push(body); issues[number] = { number, state: 'open', title: body.title, body: body.body, labels: body.labels.map(name => ({ name })), html_url: `https://github.example/issues/${number}` }; return issues[number]; }
    if (path.includes('?')) return path.includes('page=1') || !path.includes('page=') ? Object.values(issues) : [];
    const n = Number(path.split('/').at(-1)); if (!issues[n]) throw Object.assign(Error('missing'), { status: 404 }); return issues[n];
  };
  return { issues, posts, transport };
}
const brief = { title: 'Fictional: document the export', acceptance: ['The export format is documented'], labels: ['docs'], risk: 'ordinary' };

test('creating a GitHub task opens one issue with a brief and eligibility labels, then imports it unapproved', async t => {
  const f = setup(t, { labels: ['factory'] }), gh = fakeGitHub();
  const created = await createSourceTask(f.stateDir, { payload: { brief }, operationId: 'op-1', transport: gh.transport });
  assert.equal(created.taskId, 'github:1'); assert.equal(gh.posts.length, 1);
  assert.deepEqual(gh.posts[0].labels, ['factory', 'docs']); assert.match(gh.posts[0].body, /```factotum-task\n/);
  const task = f.store.need('task', 'github:1');
  assert.equal(task.title, brief.title); assert.deepEqual(task.acceptance, brief.acceptance); assert.deepEqual(task.labels, ['docs']); assert.equal(task.approvedRevision, null);
  const again = await createSourceTask(f.stateDir, { payload: { brief }, operationId: 'op-1', transport: gh.transport });
  assert.equal(again.issue, 1); assert.equal(again.reconciled, true); assert.equal(gh.posts.length, 1, 'a retried job reuses the issue it created');
  await assert.rejects(createSourceTask(f.stateDir, { payload: { brief: { title: 'x', acceptance: [] } }, operationId: 'op-2', transport: gh.transport }), /acceptance criteria/);
});

test('GitHub creation can be turned off, and command sources declare their capabilities', t => {
  assert.equal(sourceCapabilities({ sourceSync: { create: false } }).create, false);
  assert.deepEqual(sourceCapabilities({ sourceSync: { type: 'command', namespace: 'tracker:', argv: ['true'], capabilities: ['create', 'close'] } }), { type: 'command', create: true, lifecycle: false, close: true });
  assert.throws(() => sourceSettings({ sourceSync: { type: 'command', namespace: 'tracker:', argv: ['true'], capabilities: ['delete'] } }), /subset of create, lifecycle and close/);
  const lifecycle = { mode: 'delivery', sourceSync: { type: 'command', namespace: 'tracker:', argv: ['true'], capabilities: ['lifecycle'] } };
  assert.equal(lifecycleEnabled(lifecycle), true);
  assert.equal(changeWorkflow(lifecycle).nodes.source.resultEdges.ready, 'admitted', 'a lifecycle-capable command source publishes admission');
});

// A command source backed by a JSON file: read, create, lifecycle, close and lookup.
function commandSource(f) {
  const state = join(f.base, 'tracker.json'), script = join(f.base, 'tracker.mjs');
  writeFileSync(state, JSON.stringify({ tasks: [], applied: {} }));
  writeFileSync(script, `import { readFileSync, writeFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8')), file = ${JSON.stringify(state)}, db = JSON.parse(readFileSync(file, 'utf8'));
const out = value => { process.stdout.write(JSON.stringify(value)); };
if (request.operation === 'read') out({ version: 1, complete: true, observedAt: new Date().toISOString(), tasks: db.tasks });
else if (request.operation === 'lookup') out({ version: 1, operationId: request.operationId, ...(db.applied[request.operationId] ? { status: 'applied', result: db.applied[request.operationId] } : { status: 'absent' }) });
else {
  let result;
  if (request.operation === 'create') { const key = String(db.tasks.length + 1); db.tasks.push({ key, title: request.brief.title, acceptance: request.brief.acceptance, state: 'open', eligible: true, revision: 'r1', labels: request.brief.labels ?? [], risk: request.brief.risk ?? 'strict' }); result = { key }; }
  else if (request.operation === 'lifecycle') result = { phase: request.phase };
  else if (request.operation === 'close') { db.tasks.find(row => row.key === request.key).state = 'closed'; result = { closed: true }; }
  db.applied[request.operationId] = result; writeFileSync(file, JSON.stringify(db)); out({ version: 1, operationId: request.operationId, status: 'applied', result });
}
`);
  return { state, argv: [process.execPath, script] };
}

test('a command source can create, record lifecycle and close tasks, applying each operation once', async t => {
  const f = sandbox(t), source = commandSource(f);
  const config = { mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, policy: {}, sourceSync: { type: 'command', id: 'tracker', namespace: 'tracker:', argv: source.argv, capabilities: ['create', 'lifecycle', 'close'] } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  const created = await createSourceTask(f.stateDir, { payload: { brief }, operationId: 'create-1' });
  assert.equal(created.taskId, 'tracker:1');
  const task = f.store.need('task', 'tracker:1'); assert.deepEqual(task.labels, ['docs']); assert.equal(task.approvedRevision, null);
  assert.equal((await createSourceTask(f.stateDir, { payload: { brief }, operationId: 'create-1' })).reconciled, true);
  assert.equal(JSON.parse(readFileSync(source.state, 'utf8')).tasks.length, 1, 'retry reused the created task');
  const phase = await commandSourceWrite(config, f.root, { operation: 'lifecycle', operationId: 'life-1', payload: { key: '1', phase: 'review' } });
  assert.equal(phase.phase, 'review');
  await commandSourceWrite(config, f.root, { operation: 'close', operationId: 'close-1', payload: { key: '1' } });
  await syncIssueSource(f.stateDir, {});
  assert.equal(f.store.need('task', 'tracker:1').closed, true);
  await assert.rejects(commandSourceWrite({ ...config, sourceSync: { ...config.sourceSync, capabilities: [] } }, f.root, { operation: 'close', operationId: 'x', payload: {} }), /does not declare the close capability/);
});

test('an unanswerable command write is reported as uncertain, never retried blindly', async t => {
  const f = sandbox(t), config = { sourceSync: { type: 'command', id: 'tracker', namespace: 'tracker:', argv: [process.execPath, '-e', 'process.exit(3)'], capabilities: ['close'] } };
  await assert.rejects(commandSourceWrite(config, f.root, { operation: 'close', operationId: 'close-x', payload: { key: '1' } }), error => error.ambiguous === true && /uncertain/.test(error.message));
});

test('source.create runs as a supervised maintenance job and imports the created task', async t => {
  const f = sandbox(t), source = commandSource(f);
  const config = { mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, policy: {}, sourceSync: { type: 'command', id: 'tracker', namespace: 'tracker:', argv: source.argv, capabilities: ['create'] } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  const job = f.command('job.enqueue', { operation: 'source.create', note: 'Create a fictional task', payload: { brief } });
  assert.equal(job.status, 'completed', job.error);
  await operationalTick(f.store);
  await until(() => ['completed', 'failed'].includes(f.store.need('job', job.result.id).status), { tick: () => f.engine.tick()});
  assert.equal(f.store.need('job', job.result.id).status, 'completed');
  assert.equal(f.store.need('task', 'tracker:1').title, brief.title);
});

test('a delegated manual maintenance job is admitted and runs, not revoked', async t => {
  const f = sandbox(t), source = commandSource(f);
  const config = { mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, policy: {}, sourceSync: { type: 'command', id: 'tracker', namespace: 'tracker:', argv: source.argv } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  const { executeCommand } = await import('../starter/factory/core/project.mjs');
  const { uid } = await import('../starter/factory/core/contracts.mjs');
  const receipt = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'job.enqueue', payload: { operation: 'source.sync', note: 'Refresh as asked' }, onBehalfOf: { principal: 'operator', instruction: 'Operator: refresh the issues' } });
  assert.equal(receipt.status, 'completed', receipt.error);
  await operationalTick(f.store);
  await until(() => ['completed', 'failed', 'revoked'].includes(f.store.need('job', receipt.result.id).status), { tick: () => f.engine.tick()});
  assert.equal(f.store.need('job', receipt.result.id).status, 'completed');
});
