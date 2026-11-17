import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { archiveWorkspace, cleanupApply, cleanupPlan, restoreFlowArchive, treeManifest } from '../starter/factory/operations/workspace-cleanup.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, flowId = 'failed-flow') {
  const f = sandbox(t);
  writeFileSync(join(f.root, '.gitignore'), '*.log\n'); writeFileSync(join(f.root, 'remove-me.txt'), 'tracked\n'); writeFileSync(join(f.root, 'other.txt'), 'other\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Fixture files']);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId });
  const { head, setupDigest, ...owned } = workspace, path = owned.path;
  // Committed work beyond the base, then every kind of uncommitted state.
  writeFileSync(join(path, 'feature.txt'), 'committed feature\n'); git(path, ['add', 'feature.txt']); git(path, ['commit', '-qm', 'Feature work']);
  writeFileSync(join(path, 'input.txt'), 'staged change\n'); git(path, ['add', 'input.txt']); writeFileSync(join(path, 'input.txt'), 'staged then edited\n');
  writeFileSync(join(path, 'other.txt'), 'unstaged edit\n'); unlinkSync(join(path, 'remove-me.txt'));
  writeFileSync(join(path, 'notes.md'), 'untracked\n'); writeFileSync(join(path, 'build.log'), 'ignored output\n');
  writeFileSync(join(path, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(path, 'run.sh'), 0o755); symlinkSync('feature.txt', join(path, 'link-to-feature'));
  mkdirSync(join(path, 'cache', 'deep'), { recursive: true }); writeFileSync(join(path, 'cache', 'deep', 'blob.bin'), Buffer.from([0, 1, 2, 255]));
  f.store.put('flow', { ...f.store.get('flow', flowId), id: flowId, taskId: f.task.id, state: 'failed', workspace: owned });
  return { ...f, flowId, owned, path };
}
const statusOf = path => ({ status: git(path, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all']), staged: git(path, ['diff', '--cached', '--name-status']), unstaged: git(path, ['diff', '--name-status']), head: git(path, ['rev-parse', 'HEAD']) });

test('archived cleanup preserves committed, staged, unstaged, deleted, untracked, ignored, executable and symlink state, then releases', async t => {
  const f = await fixture(t), before = statusOf(f.path), tree = treeManifest(f.path);
  const plan = await cleanupPlan(f.stateDir, f.flowId);
  assert.equal(plan.dirty, true); assert.equal(plan.ignored, 1); assert.deepEqual(plan.blockers, []); assert.equal(plan.head, before.head);
  await assert.rejects(cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: '' }), /note is required/);
  await assert.rejects(cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: 'Clear it', actor: 'orchestrator' }), /operator authority required/);
  const done = await cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: 'Failed github:11 attempt; preserved before release' });
  assert.equal(done.status, 'released');
  assert.equal(existsSync(f.path), false); assert.equal(git(f.root, ['branch', '--list', f.owned.branch]), '');
  assert.ok(f.store.need('flow', f.flowId).workspaceReleased);
  const restored = restoreFlowArchive(f.stateDir, f.flowId, join(f.base, 'restored'));
  assert.equal(restored.treeDigest, tree.digest); assert.equal(restored.head, before.head);
  assert.deepEqual(statusOf(restored.target), before);
  assert.equal(readFileSync(join(restored.target, 'cache/deep/blob.bin')).toString('hex'), '000102ff');
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /already released/);
  const replan = f.command('flow.replan', { flowId: f.flowId, note: 'Try again' });
  assert.equal(replan.status, 'rejected');
});

test('cleanup refuses drift since the plan, running flows, shared ownership and special files', async t => {
  const f = await fixture(t), plan = await cleanupPlan(f.stateDir, f.flowId);
  writeFileSync(join(f.path, 'notes.md'), 'changed after the plan\n');
  await assert.rejects(cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: plan.planDigest, note: 'Clear it' }), /changed since the cleanup plan/);
  f.store.put('flow', { ...f.store.need('flow', f.flowId), state: 'stopped' });
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /abandon the flow first/);
  f.store.put('flow', { ...f.store.need('flow', f.flowId), state: 'failed' });
  f.store.put('flow', { id: 'successor', taskId: f.task.id, state: 'running', preparedPlanWorkspace: { path: f.path } });
  await assert.rejects(cleanupPlan(f.stateDir, f.flowId), /in use by flow successor/);
  f.store.put('flow', { ...f.store.need('flow', 'successor'), state: 'completed' });
  execFileSync('mkfifo', [join(f.path, 'pipe')]);
  const blocked = await cleanupPlan(f.stateDir, f.flowId);
  assert.match(blocked.blockers[0], /special files: pipe/);
  await assert.rejects(cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: blocked.planDigest, note: 'Clear it' }), /special files/);
  assert.ok(existsSync(f.path));
});

test('a cleanup interrupted after archiving and worktree removal finishes without re-archiving', async t => {
  const f = await fixture(t), plan = await cleanupPlan(f.stateDir, f.flowId), dir = join(f.stateDir, 'archives', 'interrupted');
  const archive = archiveWorkspace(f.path, dir, plan);
  f.store.put('cleanup', { id: f.flowId, status: 'archived', archive, archiveDir: dir, actor: 'operator', note: 'Interrupted run' });
  // Simulate death after the recorded removal intent and worktree removal, before branch deletion.
  const manifestPath = f.owned.manifestPath, manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, status: 'releasing', cleanup: { released: true, head: plan.head, branch: manifest.branch, ownershipDigest: manifest.ownershipDigest } }));
  git(f.root, ['worktree', 'remove', '--force', f.path]);
  assert.notEqual(git(f.root, ['branch', '--list', f.owned.branch]), '');
  const done = await cleanupApply(f.stateDir, { flowId: f.flowId, planDigest: 'unused-on-resume', note: 'Finish interrupted cleanup' });
  assert.equal(done.reconciled, true); assert.equal(git(f.root, ['branch', '--list', f.owned.branch]), '');
  assert.equal(restoreFlowArchive(f.stateDir, f.flowId, join(f.base, 'restored')).treeDigest, plan.treeDigest);
  rmSync(join(f.base, 'restored'), { recursive: true, force: true });
});

test('a workspace left mid-merge with conflicts restores its unmerged index stages', async t => {
  const f = sandbox(t);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'conflicted' });
  const { head, setupDigest, ...owned } = workspace;
  writeFileSync(join(f.root, 'input.txt'), 'target side\n'); git(f.root, ['commit', '-qam', 'Target change']);
  writeFileSync(join(owned.path, 'input.txt'), 'worker side\n'); git(owned.path, ['commit', '-qam', 'Worker change']);
  assert.throws(() => git(owned.path, ['merge', '--no-edit', git(f.root, ['rev-parse', 'HEAD'])]));
  const stages = git(owned.path, ['ls-files', '--stage']);
  assert.match(stages, / 3\tinput.txt/);
  f.store.put('flow', { id: 'conflicted', taskId: f.task.id, state: 'failed', workspace: owned });
  const plan = await cleanupPlan(f.stateDir, 'conflicted');
  await cleanupApply(f.stateDir, { flowId: 'conflicted', planDigest: plan.planDigest, note: 'Failed integration' });
  const restored = restoreFlowArchive(f.stateDir, 'conflicted', join(f.base, 'restored'));
  assert.equal(git(restored.target, ['ls-files', '--stage']), stages);
  assert.match(JSON.parse(readFileSync(join(f.store.need('cleanup', 'conflicted').archiveDir, 'manifest.json'), 'utf8')).inProgress.MERGE_HEAD, /^[a-f\d]{40}/);
  assert.equal(restored.treeDigest, plan.treeDigest);
});

test('excludeIgnored leaves out only ignored paths matching a commissioned glob, listing them with digests', async t => {
  const f = sandbox(t);
  writeFileSync(join(f.root, '.gitignore'), 'deps/cache/\n'); mkdirSync(join(f.root, 'deps')); writeFileSync(join(f.root, 'deps/tracked.txt'), 'tracked\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Deps fixture']);
  f.store.setMeta('config', { ...f.store.meta('config', {}), cleanup: { excludeIgnored: ['deps/**'] } });
  const { head, setupDigest, ...owned } = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'deps' });
  mkdirSync(join(owned.path, 'deps/cache/pkg'), { recursive: true }); writeFileSync(join(owned.path, 'deps/cache/pkg/big.js'), 'reproducible\n');
  writeFileSync(join(owned.path, 'deps/keep.txt'), 'untracked but not ignored\n'); writeFileSync(join(owned.path, 'deps/tracked.txt'), 'edited tracked\n');
  f.store.put('flow', { id: 'deps', taskId: f.task.id, state: 'failed', workspace: owned });
  const plan = await cleanupPlan(f.stateDir, 'deps');
  assert.deepEqual(plan.excludeIgnored, ['deps/**']); assert.equal(plan.excludedFiles, 1); assert.equal(plan.excludedBytes, 'reproducible\n'.length);
  await cleanupApply(f.stateDir, { flowId: 'deps', planDigest: plan.planDigest, note: 'Reproducible dependencies left out' });
  const restored = restoreFlowArchive(f.stateDir, 'deps', join(f.base, 'restored'));
  assert.equal(existsSync(join(restored.target, 'deps/cache/pkg/big.js')), false);
  assert.equal(readFileSync(join(restored.target, 'deps/keep.txt'), 'utf8'), 'untracked but not ignored\n');
  assert.equal(readFileSync(join(restored.target, 'deps/tracked.txt'), 'utf8'), 'edited tracked\n');
  assert.equal(restored.excluded, 3); assert.match(restored.note, /rerun the project's setup step/);
  const manifest = JSON.parse(readFileSync(join(f.store.need('cleanup', 'deps').archiveDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.excluded.some(entry => entry.path === 'deps/cache/pkg/big.js' && /^[a-f\d]{64}$/.test(entry.sha256)));
  assert.equal(f.store.need('cleanup', 'deps').archive.excluded, undefined, 'the store keeps a summary, not the full list');
});

// A pnpm monorepo's reproducible output: dependency stores and build caches in dot directories.
const PNPM_GLOBS = ['node_modules/**', '**/node_modules/**', '.next/**', '.artifacts/**'];
function pnpmLayout(path) {
  const files = {
    'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js': 'module.exports = pad;\n',
    'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/bin/pad': '#!/bin/sh\n',
    'node_modules/.modules.yaml': 'layoutVersion: 5\n',
    'node_modules/.bin/pad': '#!/bin/sh\nexec pad\n',
    'apps/web/node_modules/.bin/next': '#!/bin/sh\nexec next\n',
    'apps/web/node_modules/.cache/a.json': '{"cache":true}\n',
    '.next/cache/webpack/client.pack': 'x'.repeat(4096),
    '.next/.trace': 'trace\n',
    '.artifacts/report.json': '{}\n',
  };
  for (const [file, text] of Object.entries(files)) { mkdirSync(join(path, file, '..'), { recursive: true }); writeFileSync(join(path, file), text); }
  symlinkSync('.pnpm/left-pad@1.3.0/node_modules/left-pad', join(path, 'node_modules/left-pad'));
  return { files: Object.keys(files).length, bytes: Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0) };
}
test('excludeIgnored covers pnpm dot paths: the plan excludes them and the tar holds none of them', async t => {
  const f = sandbox(t);
  writeFileSync(join(f.root, '.gitignore'), 'node_modules/\n.next/\n.artifacts/\n*.env\n'); mkdirSync(join(f.root, 'apps/web'), { recursive: true }); writeFileSync(join(f.root, 'apps/web/page.js'), 'export default 1;\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Monorepo fixture']);
  f.store.setMeta('config', { ...f.store.meta('config', {}), cleanup: { excludeIgnored: PNPM_GLOBS } });
  const { head, setupDigest, ...owned } = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'pnpm' });
  const layout = pnpmLayout(owned.path);
  writeFileSync(join(owned.path, 'local.env'), 'ignored but not reproducible\n'); writeFileSync(join(owned.path, 'apps/web/page.js'), 'export default 2;\n');
  f.store.put('flow', { id: 'pnpm', taskId: f.task.id, state: 'failed', workspace: owned });
  const plan = await cleanupPlan(f.stateDir, 'pnpm');
  assert.equal(plan.excludedFiles, layout.files); assert.equal(plan.excludedBytes, layout.bytes);
  assert.equal(plan.files, 4, 'only input.txt, .gitignore, apps/web/page.js and local.env are archived');
  const done = await cleanupApply(f.stateDir, { flowId: 'pnpm', planDigest: plan.planDigest, note: 'Dependencies and build caches are reproducible' });
  const listed = execFileSync('tar', ['--list', '--file', join(done.archiveDir, 'tree.tar')], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.deepEqual(listed.filter(entry => /node_modules|\.next|\.artifacts/.test(entry)), []);
  assert.ok(listed.includes('./local.env') && listed.includes('./apps/web/page.js'));
  const manifest = JSON.parse(readFileSync(join(done.archiveDir, 'manifest.json'), 'utf8'));
  for (const directory of ['node_modules', 'apps/web/node_modules', '.next', '.artifacts']) assert.ok(manifest.excluded.some(entry => entry.path === directory && entry.type === 'dir'), directory);
  assert.ok(manifest.excluded.some(entry => entry.path === 'node_modules/left-pad' && entry.type === 'symlink'));
  const restored = restoreFlowArchive(f.stateDir, 'pnpm', join(f.base, 'restored'));
  assert.equal(existsSync(join(restored.target, 'node_modules')), false);
  assert.equal(readFileSync(join(restored.target, 'local.env'), 'utf8'), 'ignored but not reproducible\n');
});
test('excludeIgnored never leaves out a tracked or plain untracked file in a matching directory', async t => {
  const f = sandbox(t);
  writeFileSync(join(f.root, '.gitignore'), 'node_modules/.pnpm/\n'); mkdirSync(join(f.root, 'node_modules/.patched'), { recursive: true }); writeFileSync(join(f.root, 'node_modules/.patched/fix.js'), 'tracked\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Tracked patch fixture']);
  f.store.setMeta('config', { ...f.store.meta('config', {}), cleanup: { excludeIgnored: PNPM_GLOBS } });
  const { head, setupDigest, ...owned } = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'tracked' });
  mkdirSync(join(owned.path, 'node_modules/.pnpm/x'), { recursive: true }); writeFileSync(join(owned.path, 'node_modules/.pnpm/x/i.js'), 'ignored\n');
  writeFileSync(join(owned.path, 'node_modules/.local-note'), 'untracked, not ignored\n'); writeFileSync(join(owned.path, 'node_modules/.patched/fix.js'), 'edited\n');
  f.store.put('flow', { id: 'tracked', taskId: f.task.id, state: 'failed', workspace: owned });
  const plan = await cleanupPlan(f.stateDir, 'tracked');
  assert.equal(plan.excludedFiles, 1); assert.equal(plan.excludedBytes, 'ignored\n'.length);
  const done = await cleanupApply(f.stateDir, { flowId: 'tracked', planDigest: plan.planDigest, note: 'Keep tracked and untracked work' });
  const listed = execFileSync('tar', ['--list', '--file', join(done.archiveDir, 'tree.tar')], { encoding: 'utf8' }).split('\n');
  assert.ok(listed.includes('./node_modules/.patched/fix.js') && listed.includes('./node_modules/.local-note'));
  assert.ok(!listed.some(entry => entry.includes('.pnpm')));
});
