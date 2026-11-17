import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { git as workspaceGit, prepare, commit, inspect } from '../starter/factory/adapters/workspace/index.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { retryRefLockedFetch, retryRefLockedFetchSync, refLockFailure } from '../starter/factory/core/git-options.mjs';
import { CLEANUP_RETRY_DELAYS_MS, cleanupApply, cleanupPlan, releaseDeliveredWorkspace, restoreFlowArchive, retryPendingCleanups } from '../starter/factory/operations/workspace-cleanup.mjs';
import { flowNotice } from '../starter/factory/core/project.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const LOCK_MESSAGE = "error: cannot lock ref 'refs/remotes/origin/main': is at 1111111 but expected 2222222\n ! 2222222..1111111  main -> origin/main  (unable to update local ref)";

// A project repository with a local bare remote, an owned workspace whose commit was merged
// into main on the remote, and a stale local origin/main (as when another fetch is pending).
async function delivered(t, { root, stateDir, projectId = 'fictional', flowId = 'delivered' }) {
  git(root, ['branch', '-M', 'main']);
  const remote = join(root, '..', 'remote.git');
  git(root, ['init', '-q', '--bare', remote]); git(root, ['remote', 'add', 'origin', remote]); git(root, ['push', '-q', '-u', 'origin', 'main']);
  const before = git(root, ['rev-parse', 'main']);
  const workspace = await prepare({ root, stateDir, projectId, flowId, baseRef: 'main' });
  writeFileSync(join(workspace.path, 'feature.txt'), 'Reviewed fictional feature\n');
  const { head } = await commit({ workspace, message: 'Fictional feature' });
  git(root, ['-c', 'user.name=Fictional Merger', '-c', 'user.email=merger@example.invalid', 'merge', '-q', '--no-ff', '-m', 'Merge fictional feature', workspace.branch]);
  git(root, ['push', '-q', 'origin', 'main']);
  git(root, ['update-ref', 'refs/remotes/origin/main', before]);
  const { head: _head, setupDigest, ...owned } = workspace;
  return { workspace, owned, head, remote };
}

test('a cleanup fetch that loses a ref-lock race to a concurrent fetch is retried and releases the workspace', async t => {
  const base = mkdtempSync(join(tmpdir(), 'fct-fetch-race-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'repo'), stateDir = join(base, 'state'); mkdirSync(root);
  git(root, ['init', '-q', '--ref-format=files']); git(root, ['config', 'user.name', 'Fictional Developer']); git(root, ['config', 'user.email', 'developer@example.invalid']);
  writeFileSync(join(root, 'base.txt'), 'Baseline\n'); git(root, ['add', '.']); git(root, ['commit', '-qm', 'Baseline']);
  const f = await delivered(t, { root, stateDir });
  // Another fetch holds the remote-tracking ref lock; it finishes (releases the lock) only
  // after this cleanup's first fetch has failed on it. A PATH shim records that failure.
  const lock = join(root, '.git', 'refs', 'remotes', 'origin', 'main.lock'), log = join(base, 'fetch-failures.log'), shims = join(base, 'shims');
  writeFileSync(lock, ''); mkdirSync(shims);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shims, 'git'), `#!/bin/sh\n"$FCT_REAL_GIT" "$@"\ncode=$?\nfor arg in "$@"; do if [ "$arg" = fetch ]; then if [ $code -ne 0 ] && [ -e "$FCT_HELD_LOCK" ]; then echo failed >> "$FCT_FETCH_LOG"; rm -f "$FCT_HELD_LOCK"; fi; break; fi; done\nexit $code\n`);
  chmodSync(join(shims, 'git'), 0o755);
  const saved = { PATH: process.env.PATH, FCT_REAL_GIT: process.env.FCT_REAL_GIT, FCT_HELD_LOCK: process.env.FCT_HELD_LOCK, FCT_FETCH_LOG: process.env.FCT_FETCH_LOG };
  Object.assign(process.env, { PATH: `${shims}:${process.env.PATH}`, FCT_REAL_GIT: realGit, FCT_HELD_LOCK: lock, FCT_FETCH_LOG: log });
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const identity = repositoryIdentity(f.workspace.path);
  const result = await runAction({ projectRoot: root, cwd: f.workspace.path, timeoutMs: 30000, action: { operation: 'workspace.release', stateDir, projectId: 'fictional', flowId: 'delivered', workspace: f.owned, task: { id: 'task', title: 'Fictional feature', acceptance: ['Released'] }, context: { files: [] }, config: { repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', mergeMethod: 'merge' } }, results: { merge: { merged: true, mergeMethod: 'merge', expectedHead: f.head } }, mergeAuthorization: { identity } } });
  assert.equal(readFileSync(log, 'utf8'), 'failed\n', 'the first fetch lost the race exactly once');
  assert.equal(result.route, 'released'); assert.equal(result.released, true);
  assert.equal(existsSync(f.workspace.path), false); assert.equal(git(root, ['branch', '--list', f.workspace.branch]), '');
  assert.equal((await inspect({ workspace: f.owned })).released, true);
});

test('fetch retry is bounded, only for fetches, and only for ref-lock failures', async () => {
  assert.ok(refLockFailure(LOCK_MESSAGE)); assert.ok(refLockFailure("Unable to create '/x/.git/refs/remotes/origin/main.lock': File exists."));
  assert.ok(!refLockFailure("fatal: couldn't find remote ref refs/heads/missing"));
  const sleeps = [], sleep = async ms => { sleeps.push(ms); };
  let calls = 0;
  const flaky = async () => (++calls < 3 ? { code: 1, stderr: LOCK_MESSAGE } : { code: 0, stdout: 'ok' });
  assert.equal((await retryRefLockedFetch(['fetch', 'origin', 'main'], flaky, { sleep })).code, 0); assert.equal(calls, 3); assert.equal(sleeps.length, 2);
  calls = 0; const always = async () => { calls++; throw Object.assign(new Error(`git fetch failed: ${LOCK_MESSAGE}`), { code: 1 }); };
  await assert.rejects(retryRefLockedFetch(['fetch', 'origin', 'main'], always, { sleep, delays: [1, 1, 1] }), /cannot lock ref/); assert.equal(calls, 4);
  calls = 0; await assert.rejects(retryRefLockedFetch(['fetch', 'origin', 'main'], async () => { calls++; throw new Error('fatal: repository not found'); }, { sleep }), /not found/); assert.equal(calls, 1);
  calls = 0; assert.equal((await retryRefLockedFetch(['push', 'origin', 'main'], async () => { calls++; return { code: 1, stderr: LOCK_MESSAGE }; }, { sleep })).code, 1); assert.equal(calls, 1);
  calls = 0; assert.equal(retryRefLockedFetchSync(['fetch', 'origin', 'main'], () => { if (++calls < 2) throw Object.assign(new Error('Command failed'), { stderr: LOCK_MESSAGE }); return 'ok'; }, { delays: [1, 1] }), 'ok'); assert.equal(calls, 2);
});

// A completed change flow whose cleanup step failed, as the engine records it.
async function pendingFlow(t, { flowId = 'delivered' } = {}) {
  const f = sandbox(t);
  f.store.setMeta('config', { repository: { remote: 'origin', target: 'main', mergeMethod: 'merge' } });
  const d = await delivered(t, { root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId });
  git(f.root, ['fetch', '-q', 'origin']);
  const failedAt = new Date(Date.now() - 1000).toISOString();
  f.store.put('flow', { id: flowId, taskId: f.task.id, kind: 'change', state: 'completed', step: 'done', target: 'main', workspace: d.owned, results: { merge: { merged: true, mergeMethod: 'merge', expectedHead: d.head } }, cleanupPending: true, cleanupFailure: { attemptId: 'attempt-cleanup', reason: `git fetch failed: ${LOCK_MESSAGE}`, at: failedAt }, finishedAt: failedAt });
  return { ...f, ...d, flowId, failedAt: Date.parse(failedAt) };
}

test('the operations loop retries a completed flow\'s failed cleanup with backoff and clears cleanupPending', async t => {
  const f = await pendingFlow(t);
  assert.deepEqual(await retryPendingCleanups(f.store, { nowMs: f.failedAt + 1000 }), [], 'not yet due');
  assert.ok(existsSync(f.workspace.path));
  const [retried] = await retryPendingCleanups(f.store, { nowMs: f.failedAt + CLEANUP_RETRY_DELAYS_MS[0] });
  assert.equal(retried.released, true);
  const flow = f.store.need('flow', f.flowId);
  assert.equal(flow.cleanupPending, undefined); assert.equal(flow.cleanupResolved.how, 'automatic retry'); assert.equal(flow.workspaceReleased.actor, 'factory');
  assert.equal(existsSync(f.workspace.path), false); assert.equal(git(f.root, ['branch', '--list', f.workspace.branch]), '');
  assert.equal(f.store.get('obligation', `${f.flowId}:cleanup`), undefined);
});

test('a cleanup that keeps failing becomes an operator to-do and notice, which cleanup plan/apply finishes', async t => {
  const f = await pendingFlow(t);
  const failing = async () => { throw new Error(`git fetch failed: ${LOCK_MESSAGE}`); };
  let at = f.failedAt;
  for (const [i, wait] of CLEANUP_RETRY_DELAYS_MS.entries()) {
    at += wait;
    assert.deepEqual(await retryPendingCleanups(f.store, { nowMs: at - 1, releaseWorkspace: failing }), [], `retry ${i + 1} waits for its backoff`);
    const [row] = await retryPendingCleanups(f.store, { nowMs: at, releaseWorkspace: failing });
    assert.equal(row.released, false);
    assert.equal(f.store.get('obligation', `${f.flowId}:cleanup`) === undefined, i < CLEANUP_RETRY_DELAYS_MS.length - 1);
  }
  assert.deepEqual(await retryPendingCleanups(f.store, { nowMs: at + 86400000, releaseWorkspace: failing }), [], 'retries are bounded');
  const obligation = f.store.need('obligation', `${f.flowId}:cleanup`), notice = f.store.need('inbox', `cleanup-notice:${f.flowId}`);
  assert.equal(obligation.status, 'pending'); assert.equal(obligation.owner, 'operator');
  for (const text of [obligation.text, notice.context]) { assert.ok(text.includes(f.workspace.path)); assert.ok(text.includes(f.workspace.branch)); assert.match(text, /cleanup plan --state <state> --id delivered/); }
  assert.equal(notice.kind, 'notice'); assert.equal(notice.status, 'open');
  // The documented commands finish it.
  const plan = await cleanupPlan(f.stateDir, f.flowId);
  assert.equal(plan.mode, 'release'); assert.equal(plan.head, f.head); assert.deepEqual(plan.blockers, []);
  const done = await cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: 'Finish the leaked cleanup' });
  assert.equal(done.status, 'released');
  assert.equal(existsSync(f.workspace.path), false); assert.equal(git(f.root, ['branch', '--list', f.workspace.branch]), '');
  const flow = f.store.need('flow', f.flowId);
  assert.equal(flow.cleanupPending, undefined); assert.ok(flow.workspaceReleased);
  assert.equal(f.store.need('obligation', `${f.flowId}:cleanup`).status, 'passed');
  assert.equal(f.store.need('inbox', `cleanup-notice:${f.flowId}`).status, 'superseded');
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /already released/);
});

test('cleanup plan accepts a completed flow only with a proven outcome, settled attempts and owned workspace; dirty work is archived', async t => {
  const f = await pendingFlow(t);
  const flow = f.store.need('flow', f.flowId);
  f.store.put('flow', { ...flow, results: {} });
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /proven merge/);
  f.store.put('flow', flow);
  f.store.put('attempt', { id: 'live-attempt', flowId: f.flowId, status: 'running' });
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /unresolved attempts/);
  f.store.put('attempt', { id: 'live-attempt', flowId: f.flowId, status: 'passed', settledAt: new Date().toISOString() });
  f.store.put('flow', { ...flow, workspace: { ...flow.workspace, ownershipDigest: 'f'.repeat(64) } });
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /ownership/);
  f.store.put('flow', flow);
  writeFileSync(join(f.workspace.path, 'unsaved.txt'), 'Unsaved fictional note\n');
  const plan = await cleanupPlan(f.stateDir, f.flowId);
  assert.equal(plan.mode, 'archive'); assert.equal(plan.dirty, true);
  const done = await cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: 'Archive unsaved work, then release' });
  assert.equal(done.status, 'released'); assert.match(done.archiveDir, /completed-workspaces/);
  assert.equal(f.store.need('flow', f.flowId).cleanupPending, undefined);
});

test('the completed-flow notice names the outstanding cleanup', async t => {
  const f = await pendingFlow(t);
  flowNotice(f.store, f.store.need('flow', f.flowId), 'completed');
  const notice = f.store.all('inbox').find(row => row.id.startsWith(`flow-notice:${f.flowId}:completed:`));
  assert.match(notice.title, /cleanup outstanding/);
  assert.ok(notice.context.includes(f.workspace.path)); assert.ok(notice.context.includes(f.workspace.branch)); assert.match(notice.context, /cannot lock ref/); assert.match(notice.context, /cleanup plan --state <state> --id delivered/);
  assert.equal(notice.terminalReason, '');
});

// Independent review fixes.
const ignore = (workspacePath, line) => writeFileSync(git(workspacePath, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']), `${line}\n`, { flag: 'a' });

test('the automatic retry refuses whatever cleanup plan refuses: a workspace another flow or plan uses is kept', async t => {
  const f = await pendingFlow(t);
  f.store.put('flow', { id: 'successor', state: 'running', preparedPlanWorkspace: { path: f.workspace.path } });
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /in use by flow successor/);
  const [row] = await retryPendingCleanups(f.store, { nowMs: f.failedAt + CLEANUP_RETRY_DELAYS_MS[0] });
  assert.equal(row.released, false); assert.match(row.reason, /in use by flow successor/);
  assert.ok(existsSync(f.workspace.path)); assert.notEqual(git(f.root, ['branch', '--list', f.workspace.branch]), '');
  assert.equal(f.store.need('flow', f.flowId).cleanupPending, true);
  f.store.put('flow', { ...f.store.need('flow', 'successor'), state: 'completed' });
  f.store.put('plan', { id: 'other-plan', flowId: 'other', status: 'ready', workspace: { path: f.workspace.path } });
  const [planned] = await retryPendingCleanups(f.store, { nowMs: f.failedAt + CLEANUP_RETRY_DELAYS_MS[0] + CLEANUP_RETRY_DELAYS_MS[1] });
  assert.equal(planned.released, false); assert.match(planned.reason, /referenced by the ready plan/);
  assert.ok(existsSync(f.workspace.path));
});

test('a flow that starts using the workspace while the retry fetches stops the release before removal', async t => {
  const f = await pendingFlow(t);
  const racing = (root, stateDir, config, flow, guard) => releaseDeliveredWorkspace({ root, stateDir, config, workspace: flow.workspace, target: flow.target, results: flow.results, guard: async () => { f.store.put('flow', { id: 'late', state: 'running', workspace: { path: flow.workspace.path } }); await guard(); } });
  const [row] = await retryPendingCleanups(f.store, { nowMs: f.failedAt + CLEANUP_RETRY_DELAYS_MS[0], releaseWorkspace: racing });
  assert.equal(row.released, false); assert.match(row.reason, /in use by flow late/);
  assert.ok(existsSync(f.workspace.path)); assert.notEqual(git(f.root, ['branch', '--list', f.workspace.branch]), '');
});

test('ignored unsaved files are archived by cleanup plan/apply and never removed by the automatic retry', async t => {
  const f = await pendingFlow(t);
  ignore(f.workspace.path, 'private-notes.txt');
  writeFileSync(join(f.workspace.path, 'private-notes.txt'), 'Unsaved fictional notes\n');
  assert.equal(git(f.workspace.path, ['status', '--porcelain']), '', 'ordinary status reports the workspace clean');
  // Automatic retry: held for the operator at once, nothing removed.
  const [row] = await retryPendingCleanups(f.store, { nowMs: f.failedAt + CLEANUP_RETRY_DELAYS_MS[0] });
  assert.equal(row.released, false); assert.equal(row.held, true); assert.match(row.reason, /1 ignored files/);
  assert.ok(existsSync(join(f.workspace.path, 'private-notes.txt')));
  const obligation = f.store.need('obligation', `${f.flowId}:cleanup`);
  assert.equal(obligation.status, 'pending'); assert.match(obligation.text, /archives the unsaved files/); assert.ok(obligation.text.includes(f.workspace.path));
  assert.equal(f.store.need('inbox', `cleanup-notice:${f.flowId}`).status, 'open');
  assert.deepEqual(await retryPendingCleanups(f.store, { nowMs: f.failedAt + 86400000 }), [], 'no further automatic attempts');
  // The operator's plan archives it.
  const plan = await cleanupPlan(f.stateDir, f.flowId);
  assert.equal(plan.mode, 'archive'); assert.equal(plan.unsavedIgnored, 1);
  const done = await cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: 'Archive the ignored notes, then release' });
  assert.equal(done.status, 'released'); assert.match(done.archiveDir, /completed-workspaces/);
  assert.equal(existsSync(f.workspace.path), false);
  const restored = join(f.base, 'restored');
  restoreFlowArchive(f.stateDir, f.flowId, restored);
  assert.equal(readFileSync(join(restored, 'private-notes.txt'), 'utf8'), 'Unsaved fictional notes\n');
  assert.equal(f.store.need('obligation', `${f.flowId}:cleanup`).status, 'passed');
});

test('ignored files covered by cleanup.excludeIgnored are reproducible: the workspace is released', async t => {
  const f = await pendingFlow(t);
  f.store.setMeta('config', { ...f.store.meta('config'), cleanup: { excludeIgnored: ['build/**'] } });
  ignore(f.workspace.path, 'build/');
  mkdirSync(join(f.workspace.path, 'build')); writeFileSync(join(f.workspace.path, 'build', 'output.txt'), 'Regenerable fictional output\n');
  const plan = await cleanupPlan(f.stateDir, f.flowId);
  assert.equal(plan.mode, 'release'); assert.equal(plan.unsavedIgnored, 0);
  const [row] = await retryPendingCleanups(f.store, { nowMs: f.failedAt + CLEANUP_RETRY_DELAYS_MS[0] });
  assert.equal(row.released, true); assert.equal(existsSync(f.workspace.path), false);
});

test('after a successful retry the completion notice no longer says cleanup is outstanding', async t => {
  const f = await pendingFlow(t);
  flowNotice(f.store, f.store.need('flow', f.flowId), 'completed');
  const [row] = await retryPendingCleanups(f.store, { nowMs: f.failedAt + CLEANUP_RETRY_DELAYS_MS[0] });
  assert.equal(row.released, true);
  const notice = f.store.all('inbox').find(n => n.id.startsWith(`flow-notice:${f.flowId}:completed:`));
  assert.equal(notice.status, 'open'); assert.equal(notice.version, 2);
  assert.doesNotMatch(notice.title, /cleanup outstanding/); assert.doesNotMatch(notice.context, /Cleanup is outstanding|cleanup plan/);
  assert.match(notice.context, /Cleanup finished/); assert.match(notice.context, /finished with outcome completed/);
});

test('a ref namespace conflict is permanent: the fetch is not retried, and partial updates are kept', async t => {
  const f = await pendingFlow(t);
  const before = git(f.root, ['rev-parse', 'origin/main']);
  writeFileSync(join(f.root, 'advance.txt'), 'Fictional remote advance\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Fictional remote advance']); git(f.root, ['push', '-q', 'origin', 'main']);
  const after = git(f.root, ['rev-parse', 'main']);
  git(f.root, ['update-ref', 'refs/remotes/origin/main', before]);
  git(f.root, ['branch', 'topic/nested']); git(f.root, ['push', '-q', 'origin', 'topic/nested']);
  git(f.root, ['update-ref', '-d', 'refs/remotes/origin/topic/nested']); git(f.root, ['update-ref', 'refs/remotes/origin/topic', before]);
  const args = ['fetch', '--prune', 'origin', 'refs/heads/main:refs/remotes/origin/main', 'refs/heads/topic/nested:refs/remotes/origin/topic/nested'];
  let calls = 0;
  await assert.rejects(retryRefLockedFetch(args, async () => { calls++; return git(f.root, args); }, { sleep: async () => {} }), /unable to update local ref/);
  assert.equal(calls, 1);
  assert.equal(git(f.root, ['rev-parse', 'origin/main']), after, 'the fetch updated origin/main before failing on the other ref');
  assert.ok(!refLockFailure("error: cannot lock ref 'refs/remotes/origin/topic/nested': 'refs/remotes/origin/topic' exists; cannot create 'refs/remotes/origin/topic/nested'"));
  assert.ok(!refLockFailure(`${LOCK_MESSAGE}\nerror: some local refs could not be updated; try running\n 'git remote prune origin' to remove any old, conflicting branches`), 'a lock race alongside a namespace conflict is not retried');
});

test('a stale lock file that outlasts every retry is named in the final failure', async t => {
  const f = await pendingFlow(t);
  writeFileSync(join(f.root, 'advance.txt'), 'Fictional remote advance\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Fictional remote advance']); git(f.root, ['push', '-q', 'origin', 'main']);
  git(f.root, ['update-ref', 'refs/remotes/origin/main', f.head]);
  const lock = join(f.root, '.git', 'refs', 'remotes', 'origin', 'main.lock'); writeFileSync(lock, '');
  let calls = 0;
  const error = await retryRefLockedFetch(['fetch', 'origin', 'main'], async () => { calls++; return git(f.root, ['fetch', 'origin', 'main']); }, { sleep: async () => {}, delays: [1, 1] }).then(() => null, caught => caught);
  assert.ok(error); assert.equal(calls, 3);
  assert.ok(error.message.includes(`The lock file ${lock} was still present after 3 fetch attempts`), error.message);
  assert.match(error.message, /stale: remove it/);
  calls = 0;
  const result = await retryRefLockedFetch(['fetch'], async () => { calls++; return { code: 1, stderr: `error: cannot lock ref 'refs/remotes/origin/main': Unable to create '${lock}': File exists.` }; }, { sleep: async () => {}, delays: [1] });
  assert.equal(calls, 2); assert.equal(result.code, 1); assert.ok(result.stderr.includes(`The lock file ${lock} was still present`));
});

test('normal post-merge cleanup still removes ignored files but records the ones not declared reproducible', async t => {
  // Operator decision 2026-11-15: delete, but list what went.
  const root = mkdtempSync(join(tmpdir(), 'factotum-ignored-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'repo'), stateDir = join(root, 'state'); mkdirSync(project); mkdirSync(stateDir);
  git(project, ['init', '-q']); git(project, ['-c', 'user.name=Fictional', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Fictional base']);
  const { workspace, owned } = await delivered(t, { root: project, stateDir });
  ignore(workspace.path, 'private-notes.txt'); ignore(workspace.path, 'build/');
  writeFileSync(join(workspace.path, 'private-notes.txt'), 'Fictional stray note\n');
  mkdirSync(join(workspace.path, 'build')); writeFileSync(join(workspace.path, 'build', 'out.txt'), 'Regenerable\n');
  const result = await releaseDeliveredWorkspace({ root: project, stateDir, config: { repository: { remote: 'origin', target: 'main' }, cleanup: { excludeIgnored: ['build/**'] } }, workspace: owned, target: 'main', results: { merge: { merged: true } } });
  assert.equal(existsSync(workspace.path), false);
  assert.deepEqual(result.ignoredDeleted, { count: 1, paths: ['private-notes.txt'] }, 'the stray note is listed; declared build output is not');
});

test('a completed flow whose only ignored files are pnpm dot paths matching excludeIgnored is released, not archived', async t => {
  const f = await pendingFlow(t);
  f.store.setMeta('config', { ...f.store.meta('config'), cleanup: { excludeIgnored: ['node_modules/**', '**/node_modules/**', '.next/**', '.artifacts/**'] } });
  ignore(f.workspace.path, 'node_modules/'); ignore(f.workspace.path, '.next/');
  for (const file of ['node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js', 'node_modules/.bin/pkg', 'apps/web/node_modules/.bin/next', '.next/cache/webpack/x.pack']) {
    mkdirSync(join(f.workspace.path, file, '..'), { recursive: true }); writeFileSync(join(f.workspace.path, file), 'Regenerable fictional dependency\n');
  }
  const plan = await cleanupPlan(f.stateDir, f.flowId);
  assert.equal(plan.mode, 'release'); assert.equal(plan.unsavedIgnored, 0);
  const done = await cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: 'Only reproducible dependencies remain' });
  assert.equal(done.mode, 'release'); assert.equal(done.archiveDir, undefined);
  assert.equal(existsSync(f.workspace.path), false);
  assert.equal(existsSync(join(f.stateDir, 'archives', 'completed-workspaces')), false, 'nothing was archived');
  assert.equal(done.release.ignoredDeleted, undefined, 'declared dependencies are not listed as deleted ignored files');
});

test('post-merge cleanup lists only ignored entries outside excludeIgnored, not the directories that hold them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'factotum-ignored-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, 'repo'), stateDir = join(root, 'state'); mkdirSync(project); mkdirSync(stateDir);
  git(project, ['init', '-q']); git(project, ['-c', 'user.name=Fictional', '-c', 'user.email=f@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Fictional base']);
  const { workspace, owned } = await delivered(t, { root: project, stateDir });
  ignore(workspace.path, 'node_modules/'); ignore(workspace.path, '*.log');
  for (const file of ['node_modules/.pnpm/pkg@1.0.0/index.js', 'apps/web/node_modules/.bin/next', 'apps/api/node_modules/.bin/tsc', 'apps/api/debug.log']) {
    mkdirSync(join(workspace.path, file, '..'), { recursive: true }); writeFileSync(join(workspace.path, file), 'Fictional\n');
  }
  const result = await releaseDeliveredWorkspace({ root: project, stateDir, config: { repository: { remote: 'origin', target: 'main' }, cleanup: { excludeIgnored: ['node_modules/**', '**/node_modules/**'] } }, workspace: owned, target: 'main', results: { merge: { merged: true } } });
  assert.equal(existsSync(workspace.path), false);
  assert.deepEqual(result.ignoredDeleted, { count: 1, paths: ['apps/api/debug.log'] });
});
