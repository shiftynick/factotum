// Fixtures for the knowledge-upkeep job tests. Everything is fictional.
//
// A commissioned delivery project with a real repository and a bare remote. Only the forge
// boundary is substituted: a merge is a real commit pushed to the remote from a scratch clone, and
// its forge.merge result is settled through the engine, so receipts, retrospectives, jobs, lanes
// and the assessment's own Git reads all run as they do in service.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { operationalTick, runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';
import { isUpkeepFlow } from '../starter/factory/core/upkeep-config.mjs';
import { upkeepRun } from '../starter/factory/operations/upkeep-records.mjs';

export const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const write = (root, files) => { for (const [path, text] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); } };
export const FILES = Object.freeze({
  'README.md': 'Fictional project.\n\nThe user API lives in src/api/users.js and is loaded by src/server.js.\n',
  'docs/guide.md': 'A fictional guide that names no source file.\n',
  'docs/api/overview.md': 'An overview of the fictional API.\n',
  'docs/changes/2026-11-01.md': 'Dated record: src/api/users.js was added.\n',
  'AGENTS.md': 'Fictional rules.\n\nNever import src/legacy.js from new code.\n',
  'src/api/users.js': 'export const users = [];\n',
  'src/server.js': 'import "./api/users.js";\n',
  'src/legacy.js': 'export const legacy = true;\n',
});
export const UPKEEP = Object.freeze({ mode: 'observe', docs: { include: ['README.md', 'docs/**/*.md'], exclude: ['docs/changes/**'] } });
const node = code => [process.execPath, '-e', code];
// A scripted model: no provider process starts. `answer` is the structured result, or a function of
// the invocation's spec that returns it (or throws). Every spec it was called with is kept in `calls`.
export const EMPTY_RESULT = Object.freeze({ docs: [], context: [], capture: [], abstention: 'none' });
export function scriptedModel(answer = EMPTY_RESULT, calls = []) {
  const model = async spec => { calls.push(spec); const result = typeof answer === 'function' ? await answer(spec) : answer; return { provider: spec.provider, model: spec.model, sessionId: `00000000-0000-4000-8000-${String(calls.length).padStart(12, '0')}`, result, usage: {}, started: true, final: true }; };
  model.calls = calls; return model;
}

// `extra` is merged into the configuration: providers by role, everything else by key.
export function upkeepProject(t, { upkeep = UPKEEP, context = { files: [{ id: 'rules', path: 'AGENTS.md', required: true }], maxChars: 4000 }, learnings, files = FILES, policy = {}, setup, extra = {} } = {}) {
  const f = sandbox(t);
  write(f.root, files); setup?.(f.root);
  git(f.root, ['add', '-A']); git(f.root, ['commit', '-qm', 'Fictional project files']); git(f.root, ['branch', '-M', 'main']);
  const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', '-b', 'main', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', 'main']);
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/upkeep', account: 'fictional', target: 'main', remote: 'origin' }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, mainChecks: [{ id: 'baseline', argv: node('process.exit(0)'), timeoutMs: 60000 }], checks: [{ id: 'acceptance', argv: node('process.exit(0)'), timeoutMs: 60000 }], context, policy: { planning: false, autoQueue: false, maxFlows: 4, mainProbeMs: 0, ...policy }, ...(upkeep ? { upkeep: structuredClone(upkeep) } : {}), ...(learnings ? { learnings } : {}) };
  Object.assign(config, structuredClone(extra), { providers: { ...config.providers, ...structuredClone(extra.providers ?? {}) } });
  // merge, then one post-merge step whose exit code the test chooses (flow.postExit), then the end.
  const workflow = { version: 1, start: 'merge', nodes: { merge: { kind: 'effect', argv: node('process.exit(0)'), timeoutMs: 60000, next: 'post', onFailure: 'failed' }, post: { kind: 'effect', argv: node(`process.exit(require('node:fs').existsSync(${JSON.stringify(join(f.base, 'post-fails'))}) ? 1 : 0)`), timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  const commission = next => { f.store.setMeta('config', next); f.store.setMeta('configDigest', digest(next)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(next) }); };
  commission(config); f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  const green = () => f.store.setMeta('mainHealth', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() });
  let counter = 0;
  // A real commit on the remote target, made in a scratch clone: the project checkout does not hold it yet.
  function commitOnTarget(edit, message = 'Fictional merged change') {
    const scratch = join(f.base, `scratch-${++counter}`); execFileSync('git', ['clone', '-q', remote, scratch]);
    for (const args of [['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['config', 'commit.gpgsign', 'false']]) git(scratch, args);
    const base = git(scratch, ['rev-parse', 'HEAD']); edit(scratch); git(scratch, ['add', '-A']); git(scratch, ['commit', '-qm', message, '--allow-empty']); git(scratch, ['push', '-q', 'origin', 'HEAD:main']);
    const sha = git(scratch, ['rev-parse', 'HEAD']); rmSync(scratch, { recursive: true, force: true }); return { base, sha };
  }
  // Start a flow for a new task and bring it to its merge step, prepared and not yet dispatched.
  async function atMerge(name, { patch, flowId = `flow-${name}` } = {}) {
    green();
    const task = f.command('task.put', { task: { id: name, title: `Fictional change ${name}`, acceptance: ['Observed fixture behavior'] } }).result;
    assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed');
    const started = f.command('flow.start', { taskId: task.id, revision: task.revision, flowId }); assert.equal(started.status, 'completed', started.error);
    const identity = repositoryIdentity(f.root), flow = f.store.need('flow', flowId);
    flow.mergeAuthorization = { identity, taskRevision: flow.taskRevision, configDigest: flow.configDigest }; patch?.(flow); f.store.put('flow', flow);
    await f.engine.tick();
    const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId);
    attempt.intent = { ...attempt.intent, action: { operation: 'forge.merge' } };
    return { flow, attempt, identity };
  }
  // Settle the merge step as a proven merge of a real commit. `edit` changes the scratch clone.
  async function merge(name, edit = root => write(root, { 'src/api/users.js': 'export const users = [1];\n' }), options = {}) {
    const at = await atMerge(name, options), { base, sha } = commitOnTarget(edit, `Fictional merged change ${name}`);
    const current = f.store.need('flow', at.flow.id); current.results = { ...current.results, integrate: { base } }; f.store.put('flow', current);
    const result = { route: 'merged', merged: options.merged ?? true, sha, expectedHead: at.identity.head, expectedBase: base, outputIdentity: at.identity };
    f.engine.settle(at.flow.id, at.attempt, { version: 1, attemptId: at.attempt.id, intentDigest: at.attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: result });
    return { flowId: at.flow.id, base, sha, attempt: at.attempt };
  }
  const flow = id => f.store.need('flow', id), finished = id => ['completed', 'failed'].includes(flow(id).state);
  // Run the engine until a flow ends (its post-merge step is a real process).
  const finish = id => until(() => finished(id), { tick: () => f.engine.tick() });
  // A merge step that proved no merge cannot complete: its flow stops, and is abandoned here.
  const mergedAndFinished = async (name, edit, options = {}) => {
    const merged = await merge(name, edit, options);
    if (options.merged !== false) { await finish(merged.flowId); return merged; }
    await until(() => flow(merged.flowId).state === 'stopped', { tick: () => f.engine.tick() });
    assert.equal(f.command('flow.abandon', { flowId: merged.flowId, note: 'Fictional unmerged flow' }).status, 'completed'); return merged;
  };
  const upkeepFlows = () => f.store.all('flow').filter(isUpkeepFlow), tick = options => operationalTick(f.store, options);
  // Run the queued assessment the way service does, without a supervisor: prepare its attempt, run
  // the action in this process, settle it through the engine, and let the flow end.
  // The model is scripted: by default it answers that nothing is needed.
  async function prepared() {
    await tick(); const assessment = upkeepFlows().find(row => !['completed', 'failed'].includes(row.state)); assert.ok(assessment, 'an upkeep flow was admitted');
    await f.engine.tick(); const attempt = f.store.need('attempt', f.store.need('flow', assessment.id).attemptId); assert.equal(attempt.intent.action.operation, 'knowledge.upkeep');
    return { assessment, attempt };
  }
  async function assess({ run, providerInvoke = scriptedModel() } = {}) {
    const { assessment, attempt } = await prepared();
    const outcome = await runMaintenanceAction(attempt.intent, { ...(run ? { run } : {}), providerInvoke });
    f.engine.settle(assessment.id, attempt, { version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: outcome });
    await f.engine.tick(); assert.equal(f.store.need('flow', assessment.id).state, 'completed');
    return { outcome, attempt, flowId: assessment.id, run: upkeepRun(f.store, assessment.jobPayload.flowId) };
  }
  return { ...f, remote, config, workflow, commission, green, commitOnTarget, atMerge, merge, finish, mergedAndFinished, flow, upkeepFlows, tick, assess, prepared, run: id => upkeepRun(f.store, id), jobs: () => f.store.all('job').filter(job => job.operation === 'knowledge.upkeep'), failPost: () => writeFileSync(join(f.base, 'post-fails'), '') };
}
