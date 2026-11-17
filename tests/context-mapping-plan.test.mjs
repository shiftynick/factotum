import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { writeIntent, executorDigest } from '../starter/factory/core/effects.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { nodeContract } from '../starter/factory/core/operations.mjs';
import { actionSpecification } from '../starter/factory/workflows/actions.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

// Fictional governing files. ledger-rules and export-rules apply only when their paths are in scope.
const context = { maxChars: 8000, files: [
  { id: 'house-style', path: 'GUIDE.md', required: true },
  { id: 'ledger-rules', path: 'rules/ledger.md', paths: ['src/ledger/*'] },
  { id: 'export-rules', path: 'rules/export.md', paths: ['src/export/*'] },
] };
const baseConfig = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, checks: [{ id: 'verify', argv: ['true'], timeoutMs: 60000 }], context };
const effect = (operation, resultEdges, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: 60000, next: Object.values(resultEdges)[0], onFailure: 'failed', resultEdges, ...extra });
// Custom names: no step is called plan, plan-review or build.
const customGraph = { version: 1, start: 'draft-approach', nodes: {
  'draft-approach': effect('provider.plan', { ready: 'vet-approach', blocked: 'failed' }, { preserveInput: true, maxVisits: 2 }),
  'vet-approach': effect('provider.planReview', { pass: 'implement', revise: 'draft-approach' }, { preserveInput: true }),
  implement: effect('provider.build', { implemented: 'done', blocked: 'failed' }),
  done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' },
} };
const assessment = { level: 'ordinary', rationale: 'Fictional bookkeeping change', threatModel: [], stopConditions: [] };
const planned = ['src/ledger/post.txt'];
const providerInvoke = async spec => ({ provider: spec.provider, family: spec.provider === 'codex' ? 'openai' : 'anthropic', sessionId: spec.role === 'builder' ? 'fictional-builder-session' : undefined, result: { status: spec.role === 'builder' ? 'implemented' : 'ready', summary: 'Fictional', files: planned, steps: ['Post entries'], tests: ['Fictional check'], questions: [], departures: [], unverified: [], pushback: [], verdict: 'pass', findings: [], riskAssessment: assessment } });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(t, { graph = customGraph, contextConfig = context } = {}) {
  const f = sandbox(t);
  mkdirSync(join(f.root, 'rules')); mkdirSync(join(f.root, 'src'));
  writeFileSync(join(f.root, 'GUIDE.md'), 'Fictional house style: small commits.\n');
  writeFileSync(join(f.root, 'rules/ledger.md'), 'Fictional ledger rule: entries balance.\n');
  writeFileSync(join(f.root, 'rules/export.md'), 'Fictional export rule: CSV only.\n');
  writeFileSync(join(f.root, 'rules/glossary.md'), 'Fictional glossary: a posting is one entry.\n');
  writeFileSync(join(f.root, 'src/app.txt'), 'fictional app\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'Fictional governing files');
  const ghPath = join(f.base, 'gh'); writeFileSync(ghPath, `#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');\n`, { mode: 0o700 });
  const config = { ...baseConfig, repository: { ...baseConfig.repository, ghPath }, context: contextConfig };
  assert.equal(f.command('config.update', { config, note: 'Fictional delivery' }).status, 'completed');
  // The task names an unmapped path; only the plan brings the ledger path into scope.
  assert.equal(f.command('task.put', { task: { id: f.task.id, title: 'Fictional ledger posting', acceptance: ['Entries post'], risk: 'ordinary', paths: ['src/app.txt'] } }).status, 'completed');
  const revision = f.store.need('task', f.task.id).revision;
  assert.equal(f.command('task.approve', { taskId: f.task.id, revision }).status, 'completed');
  // Admission itself needs project qualification; this fixture writes the admitted flow directly.
  const task = f.store.need('task', f.task.id);
  const flow = { id: 'flow-1', taskId: task.id, taskSnapshot: structuredClone(task), taskRevision: task.revision, approvalVersion: task.approvalVersion, workflow: graph, workflowDigest: digest(graph), configDigest: f.store.meta('configDigest'), mode: 'delivery', kind: 'change', target: 'main', reviewProtocol: 'fresh-full', effectiveRisk: 'ordinary', riskAssessments: [], completionMode: 'merge', candidate: null, executorDigest: executorDigest(), step: graph.start, state: 'ready', stopRequested: false, abortRequested: false, transitions: 0, visits: { [graph.start]: 1 }, evidence: {}, results: { source: { head: repositoryIdentity(f.root).head } }, sessions: {}, attemptId: null, createdAt: new Date().toISOString() };
  f.store.setMeta('workflow', graph); f.store.setMeta('workflowDigest', digest(graph)); f.store.put('flow', flow);
  return { ...f, config, ghPath };
}
// Prepare through the engine, run the real dispatch code with a fictional provider, settle.
async function runStep(f, engine = f.engine, store = f.store) {
  await engine.step('flow-1');
  const flow = store.need('flow', 'flow-1');
  assert.ok(flow.attemptId, `no attempt prepared at ${flow.step}: ${flow.state}`);
  const attempt = store.need('attempt', flow.attemptId);
  const actionResult = await runAction({ ...attempt.intent }, { providerInvoke });
  engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult });
  return { attempt, actionResult };
}
const contextIds = intent => intent.action.context.files.map(file => file.id);
async function approvedPlan(f) {
  const plan = await runStep(f), review = await runStep(f);
  assert.deepEqual(contextIds(plan.attempt.intent), ['house-style'], 'the planner had only the task scope');
  assert.deepEqual(contextIds(review.attempt.intent), ['house-style', 'ledger-rules'], 'the plan reviewer judged the plan under the newly mapped rules');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.step, 'implement');
  return { flow, plan, review };
}
const buildSpec = (f, flow) => actionSpecification(f.store, flow, flow.workflow.nodes.implement, join(f.stateDir, 'probe'));
const reviewSpec = (f, flow) => actionSpecification(f.store, { ...flow, step: 'vet-approach' }, flow.workflow.nodes['vet-approach'], join(f.stateDir, 'review-probe'));
const setContextFiles = (f, files, extra = {}) => f.store.setMeta('config', { ...f.store.meta('config'), context: { ...f.store.meta('config').context, ...extra, files } });

test('a plan that brings a path-mapped governing file into scope can be built under custom step names, and survives restart', async t => {
  const f = fixture(t), { review } = await approvedPlan(f);
  await f.engine.step('flow-1');
  let flow = f.store.need('flow', 'flow-1');
  const prepared = f.store.need('attempt', flow.attemptId);
  assert.equal(prepared.status, 'prepared'); assert.equal(prepared.step, 'implement');
  assert.ok(flow.results.plan.contextManifest, 'the custom-named plan step recorded its governing context');
  assert.deepEqual(contextIds(prepared.intent), ['house-style', 'ledger-rules']);
  assert.equal(prepared.intent.action.context.digest, review.attempt.intent.action.context.digest, 'builder receives the context the plan reviewer approved');
  // Restart: a fresh store/engine over the same state accepts the saved intent unchanged.
  const store = new Store(f.stateDir), engine = new Engine(store);
  t.after(() => store.close());
  assert.equal(writeIntent(store, store.need('attempt', prepared.id)), join(f.stateDir, 'attempts', prepared.id, 'intent.json'));
  // Stop before dispatch, then resume: the build is prepared again from persisted state.
  flow = store.need('flow', 'flow-1'); flow.stopRequested = true; store.put('flow', flow);
  await engine.step('flow-1');
  assert.equal(store.need('attempt', prepared.id).status, 'not-dispatched');
  flow = store.need('flow', 'flow-1'); flow.stopRequested = false; flow.state = 'running'; store.put('flow', flow);
  await engine.step('flow-1');
  const again = store.need('attempt', store.need('flow', 'flow-1').attemptId);
  assert.notEqual(again.id, prepared.id); assert.equal(again.status, 'prepared');
  assert.equal(again.intent.action.context.digest, prepared.intent.action.context.digest);
  assert.ok(existsSync(join(f.stateDir, 'attempts', again.id, 'intent.json')));
});

test('the same plan under the reference graph builds; a plan recorded without a context manifest keeps the exact comparison', async t => {
  const f = fixture(t, { graph: changeWorkflow(baseConfig) }), flow = f.store.need('flow', 'flow-1');
  for (const step of ['plan', 'plan-review']) {
    flow.step = step;
    const node = flow.workflow.nodes[step], spec = actionSpecification(f.store, flow, node, join(f.stateDir, `prompt-${step}`));
    flow.results[nodeContract(step, node).binding] = await runAction({ ...spec, timeoutMs: 60000 }, { providerInvoke });
  }
  flow.step = 'build';
  const spec = actionSpecification(f.store, flow, flow.workflow.nodes.build, join(f.stateDir, 'prompt-build'));
  assert.deepEqual(spec.action.context.files.map(file => file.id), ['house-style', 'ledger-rules']);
  // The reproduced defect, kept for plans recorded before this change.
  delete flow.results.plan.contextManifest;
  assert.throws(() => actionSpecification(f.store, flow, flow.workflow.nodes.build, join(f.stateDir, 'legacy')), /reviewed plan context or task changed; replan required$/);
});

test('edits to governing files after plan approval are still rejected, including the newly mapped file', async t => {
  const f = fixture(t), { flow } = await approvedPlan(f);
  // A correction round: the builder session exists, so only the context guard stands between
  // an edited governing file and the next builder turn.
  flow.sessions = { builder: 'fictional-builder-session' };
  assert.doesNotThrow(() => buildSpec(f, flow));
  writeFileSync(join(f.root, 'rules/ledger.md'), 'Fictional ledger rule: entries may be unbalanced.\n');
  assert.throws(() => buildSpec(f, flow), /replan required: governing context ledger-rules changed since the reviewed plan/);
  git(f.root, 'checkout', '--', 'rules/ledger.md');
  writeFileSync(join(f.root, 'GUIDE.md'), 'Fictional house style: large commits.\n');
  assert.throws(() => buildSpec(f, flow), /replan required: governing context house-style changed or is no longer delivered/);
  git(f.root, 'checkout', '--', 'GUIDE.md');
  // An edit made between planning and the first build changes the planned input as before.
  delete flow.sessions.builder;
  writeFileSync(join(f.root, 'rules/ledger.md'), 'Fictional ledger rule: committed change.\n'); git(f.root, 'commit', '-qam', 'Edit governing file');
  assert.throws(() => buildSpec(f, flow), /planned input changed; replan required/);
});

test('a ledger rule edited after planning but before plan review is rejected when the review is prepared', async t => {
  const f = fixture(t);
  await runStep(f);
  writeFileSync(join(f.root, 'rules/ledger.md'), 'Fictional ledger rule: changed before review.\n');
  await assert.rejects(f.engine.step('flow-1'), /planned context changed before plan review; replan required: governing context ledger-rules changed since the reviewed plan/);
  git(f.root, 'checkout', '--', 'rules/ledger.md');
  writeFileSync(join(f.root, 'GUIDE.md'), 'Fictional house style: changed before review.\n');
  assert.throws(() => reviewSpec(f, f.store.need('flow', 'flow-1')), /planned context changed before plan review; replan required: governing context house-style changed or is no longer delivered/);
});

test('rules changed before plan review and restored before the build do not reuse the review approval', async t => {
  const f = fixture(t);
  await runStep(f);
  const flow = f.store.need('flow', 'flow-1');
  writeFileSync(join(f.root, 'rules/ledger.md'), 'Fictional ledger rule: changed before review.\n');
  assert.throws(() => reviewSpec(f, flow), /planned context changed before plan review/, 'the review preparation catches the change');
  // A passing review that nevertheless judged the plan under the changed rules (simulated by
  // preparing it without the planning manifest) is not an approval of the restored rules.
  const unguarded = structuredClone(flow); delete unguarded.results.plan.contextManifest;
  const seen = reviewSpec(f, unguarded);
  flow.results['plan-review'] = await runAction({ ...seen, timeoutMs: 60000 }, { providerInvoke });
  assert.equal(flow.results['plan-review'].contextDigest, seen.action.context.digest, 'the passing review records the package it approved');
  git(f.root, 'checkout', '--', 'rules/ledger.md');
  flow.step = 'implement'; flow.sessions = { builder: 'fictional-builder-session' };
  assert.throws(() => buildSpec(f, flow), /replan required: governing context differs from the package the plan review approved/);
  // The approved package itself, restored, builds; restart re-prepares the same pinned package.
  const review = await runStep(f);
  await f.engine.step('flow-1');
  const prepared = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  assert.equal(prepared.step, 'implement');
  assert.equal(prepared.intent.action.context.digest, review.attempt.intent.action.context.digest);
  assert.equal(f.store.need('flow', 'flow-1').results['plan-review'].contextDigest, prepared.intent.action.context.digest);
});

test('every entry definition is checked, delivered or omitted', async t => {
  const f = fixture(t), { flow } = await approvedPlan(f);
  flow.sessions = { builder: 'fictional-builder-session' };
  const change = (id, patch) => context.files.map(file => file.id === id ? { ...file, ...patch } : file);
  // An always-selected entry that stops being required.
  setContextFiles(f, change('house-style', { required: false }));
  assert.throws(() => buildSpec(f, flow), /replan required: context mapping for house-style changed since the reviewed plan/);
  assert.throws(() => reviewSpec(f, flow), /planned context changed before plan review; replan required: context mapping for house-style changed/);
  // A selected entry whose mapping changes but still selects it.
  setContextFiles(f, change('ledger-rules', { paths: ['src/ledger/*', 'src/archive/*'] }));
  assert.throws(() => buildSpec(f, flow), /replan required: context mapping for ledger-rules changed since the reviewed plan/);
  // An omitted entry whose mapping changes but keeps the same omission reason.
  setContextFiles(f, change('export-rules', { paths: ['src/reports/*'] }));
  assert.throws(() => buildSpec(f, flow), /replan required: context mapping for export-rules changed since the reviewed plan/);
  setContextFiles(f, context.files);
  assert.doesNotThrow(() => buildSpec(f, flow));
});

test('a newly selected file that exhausts the context budget names the budget, not a replan', async t => {
  const guide = 'Fictional house style: small commits.\n', glossary = 'Fictional glossary: a posting is one entry.\n';
  // The planner receives house style and glossary; the plan's ledger rules then evict the glossary.
  const tight = { maxChars: guide.length + glossary.length, files: [context.files[0], context.files[1], { id: 'glossary', path: 'rules/glossary.md' }, context.files[2]] };
  const f = fixture(t, { contextConfig: tight });
  const plan = await runStep(f);
  assert.deepEqual(contextIds(plan.attempt.intent), ['house-style', 'glossary']);
  const flow = f.store.need('flow', 'flow-1');
  const advice = /budget exhausted by newly selected context\); increase context\.maxChars, replanning does not change the budget/;
  assert.throws(() => reviewSpec(f, flow), err => advice.test(err.message) && /governing context glossary is no longer delivered/.test(err.message) && !/replan required/.test(err.message));
  flow.step = 'implement'; flow.sessions = { builder: 'fictional-builder-session' };
  assert.throws(() => buildSpec(f, flow), err => advice.test(err.message) && !/replan required/.test(err.message));
  // Raising the budget, not replanning, is the remedy.
  setContextFiles(f, tight.files, { maxChars: 8000 });
  assert.doesNotThrow(() => reviewSpec(f, flow));
});

test('mapping changes the approval did not cover require a replan', async t => {
  const f = fixture(t), { flow } = await approvedPlan(f);
  flow.sessions = { builder: 'fictional-builder-session' };
  const broadened = context.files.map(file => file.id === 'export-rules' ? { ...file, paths: ['src/export/*', 'src/ledger/*'] } : file);
  // The supported command refuses configuration changes while the change flow is live ...
  assert.match(f.command('config.update', { config: { ...f.config, context: { ...context, files: broadened } }, note: 'Fictional mapping change' }).error, /drain or abandon work/);
  // ... so the guard is also checked against configuration that changed by any other route.
  const update = files => f.store.setMeta('config', { ...f.store.meta('config'), context: { ...context, files } });
  // Broadened: export rules now also govern ledger paths, which the plan approval never covered.
  update(broadened);
  assert.throws(() => buildSpec(f, flow), /replan required: context mapping for export-rules changed since the reviewed plan/);
  // A new mapped entry, even one matching nothing, changes the governing configuration.
  update([...context.files, { id: 'audit-rules', path: 'rules/export.md', paths: ['src/audit/*'] }]);
  assert.throws(() => buildSpec(f, flow), /replan required: context configuration entries changed/);
  update(context.files);
  assert.doesNotThrow(() => buildSpec(f, flow));
});

test('governing context selected only by candidate changes outside the plan requires a replan', async t => {
  const f = fixture(t), { flow } = await approvedPlan(f);
  flow.sessions = { builder: 'fictional-builder-session' }; flow.workspace = { path: f.root, base: repositoryIdentity(f.root).head };
  mkdirSync(join(f.root, 'src/ledger')); writeFileSync(join(f.root, 'src/ledger/post.txt'), 'planned change\n');
  assert.doesNotThrow(() => buildSpec(f, flow), 'the planned path itself is covered');
  mkdirSync(join(f.root, 'src/export')); writeFileSync(join(f.root, 'src/export/report.txt'), 'unplanned change\n');
  assert.throws(() => buildSpec(f, flow), /replan required: governing context export-rules was selected by changes outside the reviewed plan/);
});
