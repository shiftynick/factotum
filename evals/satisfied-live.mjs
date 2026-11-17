#!/usr/bin/env node
// Explicit live qualification. All identities and evidence are private runtime data, never fixture constants.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, cp, rm, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { Store as ReferenceStore } from '../starter/factory/core/store.mjs';
import { atomicJSON } from '../starter/factory/core/contracts.mjs';
import { executorDigest as referenceExecutorDigest } from '../starter/factory/core/effects.mjs';
import { createGhTransport } from '../starter/factory/adapters/github/index.mjs';
import { withGitHubGitScope, prepareGitInvocation } from '../starter/factory/adapters/github/git.mjs';
import { runProcess } from '../starter/factory/adapters/providers/index.mjs';
const args = process.argv.slice(2);
let runtimeArg, newRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runtime') { assert(args[i + 1], '--runtime needs a directory'); runtimeArg = args[++i]; }
  else if (args[i] === '--new') newRun = true;
  else throw new Error('Use --runtime PATH and optional explicit --new');
}
assert(runtimeArg, 'Use --runtime /absolute/private/existing-qualification');
const runtime = resolve(runtimeArg), reference = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(runtime, 'qualification.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert(manifest.version === 1 && manifest.projects?.length, 'existing private qualification manifest required');
const project = manifest.projects.find(p => p.stack === 'web');
assert(project?.passed && project.root && project.stateDir && project.slug, 'completed fictional web qualification required');
assert(project.slug === `${manifest.account}/${project.name}` && project.name.startsWith('factotum-qualification-'), 'only existing disposable qualification repository is permitted');
const request = createGhTransport({ account: manifest.account });
const remoteRepo = await request({ path: `repos/${project.slug}` });
assert(remoteRepo.private === true && remoteRepo.owner.login.toLowerCase() === manifest.account.toLowerCase(), 'private personally owned qualification repository required');
assert.equal((await request({ path: `repos/${project.slug}/actions/permissions` })).enabled, false, 'Actions must already be disabled');
const exists = path => access(path).then(() => true, () => false);
const save = () => atomicJSON(manifestPath, manifest);
const report = (event, extra = {}) => console.log(JSON.stringify({ event, ...extra }));
if (newRun) {
  const prior = project.satisfiedQualification;
  assert(prior?.passed, '--new requires a completed prior certificate; never fork uncertain work');
  assert(prior.referenceExecutorDigest !== referenceExecutorDigest(), 'same executor already qualified; no new live run needed');
  (project.satisfiedQualificationHistory ??= []).push(structuredClone(prior));
  project.satisfiedQualification = { id: randomUUID(), createdAt: new Date().toISOString(), previousCertificateId: prior.id };
}
project.satisfiedQualification ??= { id: randomUUID(), createdAt: new Date().toISOString() };
const record = project.satisfiedQualification;
record.flowId ??= `already-satisfied-${record.id.slice(0, 8)}`;
save();
if (record.passed) { report('already-satisfied.already-passed', { flowId: record.flowId }); process.exit(0); }
async function git(args, { allowFailure = false } = {}) {
  return withGitHubGitScope({ slug: project.slug, account: manifest.account, target: 'main', remote: 'origin' }, async () => {
    const prepared = await prepareGitInvocation(args, { cwd: project.root, env: process.env });
    const result = await runProcess('git', prepared.args, { cwd: project.root, env: prepared.env, timeoutMs: 60000 });
    assert(allowFailure || result.code === 0, `Git ${args[0]} failed; inspect private local repository`); return { code: result.code, stdout: result.stdout.trim() };
  });
}
function drained(store) {
  assert(store.all('flow').every(f => ['completed', 'failed'].includes(f.state)), 'drain or explicitly abandon every existing flow before refreshing its executor');
  assert(store.all('attempt').every(a => a.settledAt), 'every existing attempt must be settled before refreshing its executor');
  assert(!store.meta('paused') && !store.meta('recoveryHold'), 'existing project holds require explicit reconciliation');
}
let lock, store, service;
try {
  if (!record.refreshedHead) {
    const existing = new ReferenceStore(project.stateDir);
    try {
      lock = createServer(); await new Promise((ok, no) => { lock.once('error', () => no(new Error('existing project runner must be stopped before refreshing starter'))); lock.listen(`\0factotum-runner-${existing.meta('project').projectId}`, ok); });
      drained(existing);
      assert.equal((await git(['status', '--porcelain'])).stdout, '', 'root must be clean; do not overwrite operator work');
      assert.equal((await git(['symbolic-ref', '--short', 'HEAD'])).stdout, 'main', 'refresh only the clean main checkout');
      const beforeHead = (await git(['rev-parse', 'HEAD'])).stdout;
      const beforeRemote = (await git(['ls-remote', 'origin', 'refs/heads/main'])).stdout.split(/\s+/)[0];
      assert.equal(beforeHead, beforeRemote, 'root must equal remote main before refresh');
      record.historicalWarnings = existing.all('attempt').filter(a => a.status !== 'passed').map(a => ({ id: a.id, step: a.step, status: a.status, settledAt: a.settledAt }));
      const sourceEntries = await readdir(join(reference, 'starter'));
      assert(sourceEntries.every(name => ['factory', 'project', 'VERSION', 'compatibility.json'].includes(name)), 'inspect unexpected starter entry before copying');
      for (const name of sourceEntries) { await rm(join(project.root, name), { recursive: true, force: true }); await cp(join(reference, 'starter', name), join(project.root, name), { recursive: true }); }
      if ((await git(['status', '--porcelain'])).stdout) {
        await git(['add', ...sourceEntries]); await git(['commit', '-m', 'Pin final reviewed starter for already-satisfied qualification']); await git(['push', 'origin', 'main']);
      }
      record.refreshedHead = (await git(['rev-parse', 'HEAD'])).stdout;
      record.referenceExecutorDigest = referenceExecutorDigest(); record.refreshedAt = new Date().toISOString(); save();
    } finally { existing.close(); }
  }
  const adopted = path => import(pathToFileURL(join(project.root, 'factory', path)).href);
  const [{ Store }, { executeCommand }, { Engine }, commission, { startProjectService }, effects] = await Promise.all([
    adopted('core/store.mjs'), adopted('core/project.mjs'), adopted('core/engine.mjs'), adopted('workflows/commission.mjs'), adopted('service/project-service.mjs'), adopted('core/effects.mjs'),
  ]);
  store = new Store(project.stateDir);
  assert.equal(effects.executorDigest(), record.referenceExecutorDigest, 'copied runtime changed; preserve original pinned code');
  const invoke = (operation, payload, suffix = randomUUID()) => {
    const receipt = executeCommand(store, { protocolVersion: 1, projectId: store.meta('project').projectId, commandId: `${record.id}:${suffix}`, operation, payload, actor: 'operator' });
    assert.equal(receipt.status, 'completed', receipt.error); return receipt.result;
  };
  if (!record.commissioned) {
    drained(store);
    invoke('config.update', { config: store.meta('config'), note: 'Commission the final reviewed starter for an authorized fictional already-satisfied scenario' }, 'config');
    const result = await commission.doctor(project.stateDir);
    assert.equal(result.ready, true, `Doctor failed: ${result.reasons.join('; ')}`);
    record.commissioned = true; record.doctor = result; save();
  }
  if (!record.issue) {
    const marker = `<!-- factotum-already-satisfied:${manifest.runId}:${record.id}:${record.referenceExecutorDigest} -->`;
    const list = () => request({ path: `repos/${project.slug}/issues?state=all&per_page=100` });
    let issue = (await list()).find(row => row.body?.includes(marker));
    if (!issue) {
      const brief = { version: 1, outcome: 'Verify the existing completed-state persistence behavior', acceptance: project.scenario.acceptance, dependencies: [], risk: 'ordinary', postMerge: [] };
      try { issue = await request({ method: 'POST', path: `repos/${project.slug}/issues`, body: { title: 'Verify already-satisfied fictional task persistence', body: `The requested behavior is already present on main. Independently verify the original acceptance criteria without creating a replacement implementation or pull request.\n\n\`\`\`factotum-task\n${JSON.stringify(brief, null, 2)}\n\`\`\`\n\n${marker}` } }); }
      catch (error) { issue = (await list()).find(row => row.body?.includes(marker)); if (!issue) throw error; }
    }
    record.issue = issue.number; record.pullRequestsBefore = (await request({ path: `repos/${project.slug}/pulls?state=all&per_page=100` })).map(p => p.number).sort((a, b) => a - b); save();
  }
  if (!store.get('flow', record.flowId)) {
    const task = await commission.importGitHubTask(project.stateDir, record.issue);
    invoke('task.approve', { taskId: task.id, revision: task.revision }, 'approve');
    invoke('flow.start', { taskId: task.id, revision: task.revision, flowId: record.flowId, alreadySatisfied: true }, 'start');
    record.startedAt = new Date().toISOString(); save();
  }
  if (lock) { await new Promise(ok => lock.close(ok)); lock = null; }
  service = await startProjectService({ stateDir: project.stateDir, socketPath: join(project.stateDir, 'project.sock'), run: false });
  const engine = new Engine(store), deadline = Date.now() + 20 * 60000; let lastStep;
  while (Date.now() < deadline) {
    await engine.tick(); const flow = store.need('flow', record.flowId);
    if (flow.step !== lastStep) { report('already-satisfied.progress', { flowId: flow.id, step: flow.step, state: flow.state }); lastStep = flow.step; }
    const attempts = store.all('attempt').filter(a => a.flowId === flow.id);
    assert(!attempts.some(a => a.status === 'uncertain'), 'uncertain outcome retained; independent inspection required, no blind retry');
    assert(!['failed', 'stopped'].includes(flow.state), `flow ${flow.state}; inspect retained private evidence`);
    const question = store.all('inbox').find(q => q.flowId === flow.id && q.kind === 'question' && q.status === 'open');
    if (question) {
      assert.equal(flow.step, 'satisfied-decide', 'unexpected question requires operator inspection');
      invoke('answer', { inboxId: question.id, version: question.version, subjectDigest: question.subjectDigest, answer: 'accept', ...(question.strictReview ? {reviewedHead:question.strictReview.head} : {}) }, `accept:${question.version}`);
    }
    if (flow.state === 'completed') {
      assert(attempts.length > 0 && attempts.every(a => a.status === 'passed' && a.settledAt), 'all new flow attempts, including closure and cleanup, must pass');
      assert(!flow.postMergePending, 'post-outcome warnings remain unresolved');
      assert.equal(flow.results['satisfied-record']?.proven, true, 'target already-satisfied proof required');
      assert.equal(flow.results['satisfied-record'].head, record.refreshedHead, 'proof must bind the exact refreshed target');
      assert.equal(flow.results['satisfied-review']?.result?.verdict, 'pass', 'fresh independent reviewer must pass');
      assert.equal(flow.results['satisfied-review'].provider, 'claude', 'real configured Claude reviewer required');
      assert(flow.results['satisfied-review'].sessionId, 'fresh reviewer session receipt required');
      assert.equal(flow.results['satisfied-gate']?.route, 'pass');
      assert.equal(flow.results.cleanup?.released, true, 'owned workspace cleanup must pass');
      assert(!(await exists(flow.workspace.path)), 'owned workspace must be removed');
      assert.notEqual((await git(['show-ref', '--verify', `refs/heads/${flow.workspace.branch}`], { allowFailure: true })).code, 0, 'owned branch must be removed');
      assert.equal((await git(['status', '--porcelain'])).stdout, '', 'root must remain clean');
      assert.equal((await git(['ls-remote', 'origin', 'refs/heads/main'])).stdout.split(/\s+/)[0], record.refreshedHead, 'remote target must remain unchanged');
      assert.equal((await request({ path: `repos/${project.slug}/issues/${record.issue}` })).state, 'closed', 'new source issue must be closed');
      const pullsAfter = (await request({ path: `repos/${project.slug}/pulls?state=all&per_page=100` })).map(p => p.number).sort((a, b) => a - b);
      assert.deepEqual(pullsAfter, record.pullRequestsBefore, 'already-satisfied path must not create a pull request');
      const closure = attempts.find(a => a.step === 'close-task'); assert(closure?.status === 'passed', 'latest closure must settle cleanly');
      record.passed = true; record.completedAt = new Date().toISOString();
      record.evidence = { head: record.refreshedHead, targetUnchanged: true, noPRCreated: true, sourceIssueClosed: true, workspaceReleased: true, branchRemoved: true, attempts: attempts.map(a => ({ id: a.id, step: a.step, status: a.status })), freshReview: { provider: flow.results['satisfied-review'].provider, model: flow.results['satisfied-review'].model, sessionId: flow.results['satisfied-review'].sessionId }, allAttemptsPassed: true, closureClean: true };
      save(); report('already-satisfied.passed', { flowId: flow.id, issue: record.issue, attempts: attempts.length, noPRCreated: true, closureClean: true }); break;
    }
    await new Promise(ok => setTimeout(ok, 150));
  }
  assert(record.passed, 'qualification timed out; retain exact flow and inspect before continuing');
} catch (error) {
  record.lastFailure = { at: new Date().toISOString(), message: error.message }; save();
  console.error(JSON.stringify({ event: 'already-satisfied.failed', message: error.message, flowId: record.flowId })); process.exitCode = 1;
} finally {
  if (service) await service.close();
  if (store) store.close();
  if (lock) await new Promise(ok => lock.close(ok));
}
