import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { hiddenIndexChanges } from '../starter/factory/core/index-flags.mjs';
import { prepare, commit, inspect } from '../starter/factory/adapters/workspace/index.mjs';
import { cleanupPlan, cleanupApply } from '../starter/factory/operations/workspace-cleanup.mjs';
import { archiveDropPlan, archiveDropApply } from '../starter/factory/operations/cleanup-archive-drop.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('dev.97 review: changes behind assume-unchanged or skip-worktree flags are found; absent flagged files are not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'index-flags-'));
  try {
    git(dir, 'init', '-q');
    for (const name of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(dir, name), `${name}\n`);
    git(dir, 'add', '.'); git(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init');
    git(dir, 'update-index', '--assume-unchanged', 'a', 'b'); git(dir, 'update-index', '--skip-worktree', 'c', 'd');
    writeFileSync(join(dir, 'a'), 'hidden\n'); writeFileSync(join(dir, 'c'), 'hidden\n'); unlinkSync(join(dir, 'd'));
    writeFileSync(join(dir, 'e'), 'visible\n');
    assert.equal(git(dir, 'status', '--porcelain'), 'M e', 'status sees only the unflagged change');
    assert.deepEqual(hiddenIndexChanges(dir).sort(), ['a', 'c']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`dev.97 review: a hidden change (${flag}) makes the workspace dirty and its archive is never dropped`, async t => {
    const f = sandbox(t);
    git(f.root, 'branch', '-M', 'main');
    const remote = join(f.base, 'remote.git'); git(f.root, 'init', '-q', '--bare', remote); git(f.root, 'remote', 'add', 'origin', remote); git(f.root, 'push', '-qu', 'origin', 'main');
    f.store.setMeta('config', { ...f.store.meta('config'), repository: { remote: 'origin', target: 'main', mergeMethod: 'merge' } });
    const { head: _head, setupDigest: _setup, ...owned } = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'hidden', baseRef: 'main' });
    writeFileSync(join(owned.path, '.gitignore'), 'cache/\n'); writeFileSync(join(owned.path, 'work'), 'committed');
    await commit({ workspace: owned, message: 'work' });
    git(f.root, 'merge', '-q', '--no-ff', '-m', 'merge', owned.branch); git(f.root, 'push', '-q', 'origin', 'main');
    git(owned.path, 'update-index', flag, 'work'); writeFileSync(join(owned.path, 'work'), 'HIDDEN UNSAVED MODIFICATION');
    mkdirSync(join(owned.path, 'cache')); writeFileSync(join(owned.path, 'cache/build'), 'generated');
    const inspected = await inspect({ workspace: owned });
    assert.equal(inspected.dirty, true); assert.deepEqual(inspected.hiddenByIndexFlags, ['work']);
    f.store.put('flow', { id: 'hidden', taskId: f.task.id, state: 'completed', target: 'main', workspace: owned, results: { merge: { merged: true, mergeMethod: 'merge' } } });
    f.store.setMeta('config', { ...f.store.meta('config'), cleanup: { excludeIgnored: ['cache/**'] } });
    const plan = await cleanupPlan(f.stateDir, 'hidden');
    assert.equal(plan.mode, 'archive', 'a hidden change is archived, never released unseen');
    assert.deepEqual(plan.hiddenByIndexFlags, ['work'], 'the plan names the hidden change');
    assert.equal(plan.changedOrUntracked, 1, 'and counts it');
    const archived = await cleanupApply(f.stateDir, { flowId: 'hidden', planDigest: plan.planDigest, note: 'archive hidden work' });
    const drop = await archiveDropPlan(f.stateDir, { flowIds: ['hidden'] });
    assert.equal(drop.entries.length, 0);
    assert.match(drop.refused[0].reason, /1 hidden by index flags \(work\)/);
    await assert.rejects(archiveDropApply(f.stateDir, { flowIds: ['hidden'], planDigest: drop.planDigest, note: 'drop hidden work' }));
    assert.ok(existsSync(archived.archiveDir), 'the archive is kept');
  });
}

test('dev.97 re-test T1: archive-drop on a merged flow released by the post-merge cleanup says no archive is recorded', async t => {
  const f = sandbox(t);
  f.store.put('flow', { id: 'merged', taskId: f.task.id, state: 'completed', target: 'main', workspace: { path: join(f.base, 'gone'), branch: 'factotum/merged' }, results: { merge: { merged: true, mergeMethod: 'merge' }, cleanup: { released: true } } });
  const drop = await archiveDropPlan(f.stateDir, { flowIds: ['merged'] });
  assert.equal(drop.entries.length, 0);
  assert.equal(drop.refused[0].reason, 'no cleanup archive is recorded for this flow');
});
