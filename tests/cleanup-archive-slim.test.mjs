import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { commit, prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { cleanupApply, cleanupPlan, restoreFlowArchive } from '../starter/factory/operations/workspace-cleanup.mjs';
import { archiveSlimApply, archiveSlimPlan } from '../starter/factory/operations/cleanup-archive-slim.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const GLOBS = ['node_modules/**', '**/node_modules/**', '.next/**', '.artifacts/**'];
const slim = (f, selection, plan, extra = {}) => archiveSlimApply(f.stateDir, { ...selection, planDigest: plan.planDigest, note: 'Remove reproducible dependencies from old archives', actor: 'operator', ...extra });
const commission = (f, globs = GLOBS) => f.store.setMeta('config', { ...f.store.meta('config', {}), cleanup: { excludeIgnored: globs } });

// A monorepo whose .gitignore ignores dependency stores, build caches and logs.
function monorepo(t) {
  const f = sandbox(t);
  writeFileSync(join(f.root, '.gitignore'), 'node_modules/\n.next/\n*.log\n');
  mkdirSync(join(f.root, 'apps/web'), { recursive: true }); writeFileSync(join(f.root, 'apps/web/page.js'), 'export default 1;\n');
  git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Monorepo fixture']);
  return f;
}
const PNPM = {
  'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js': 'module.exports = pad;\n',
  'node_modules/.modules.yaml': 'layoutVersion: 5\n',
  'node_modules/.bin/pad': '#!/bin/sh\n',
  'apps/web/node_modules/.bin/next': '#!/bin/sh\nexec next\n',
  '.next/cache/webpack/client.pack': 'x'.repeat(8192),
};
const PNPM_BYTES = Object.values(PNPM).reduce((sum, text) => sum + text.length, 0);
// A failed flow archived the way dev.95 archived it: no glob reached the dot paths, so the tar
// holds the whole pnpm store. It also holds unpublished commits and every kind of unsaved work.
async function oversizedArchive(f, flowId, { pnpm = true } = {}) {
  const { head: _h, setupDigest, ...owned } = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId });
  writeFileSync(join(owned.path, 'feature.txt'), `Unpublished work of ${flowId}\n`); const { head } = await commit({ workspace: owned, message: `Unpublished ${flowId}` });
  writeFileSync(join(owned.path, 'apps/web/page.js'), 'export default 2;\n');
  writeFileSync(join(owned.path, 'staged.txt'), 'staged\n'); git(owned.path, ['add', 'staged.txt']);
  writeFileSync(join(owned.path, 'notes.md'), 'untracked notes\n');
  writeFileSync(join(owned.path, 'debug.log'), 'ignored, matches no glob\n');
  if (pnpm) {
    for (const [file, text] of Object.entries(PNPM)) { mkdirSync(join(owned.path, dirname(file)), { recursive: true }); writeFileSync(join(owned.path, file), text); }
    symlinkSync('.pnpm/left-pad@1.3.0/node_modules/left-pad', join(owned.path, 'node_modules/left-pad'));
  }
  f.store.put('flow', { id: flowId, taskId: f.task.id, state: 'failed', workspace: owned });
  const plan = await cleanupPlan(f.stateDir, flowId);
  const done = await cleanupApply(f.stateDir, { flowId, planDigest: plan.planDigest, note: 'Archive the failed work' });
  return { flowId, head, dir: done.archiveDir };
}
const tarList = (dir, name) => execFileSync('tar', ['--list', '--file', join(dir, name)], { encoding: 'utf8' }).split('\n').filter(Boolean);

test('archive-slim removes only the pnpm paths the globs exclude, keeps the failed work restorable and the history byte for byte', async t => {
  const f = monorepo(t), archive = await oversizedArchive(f, 'failed-pnpm');
  assert.ok(tarList(archive.dir, 'tree.tar').some(path => path.includes('.pnpm')), 'the old archive holds the pnpm store');
  const commits = join(f.stateDir, 'archives', 'workspace-commits'); mkdirSync(commits, { recursive: true }); writeFileSync(join(commits, 'kept.bundle'), 'fictional bundle\n');
  const kept = Object.fromEntries(['history.bundle', 'index', 'index-objects.pack'].map(name => [name, sha256(join(archive.dir, name))]));
  const oldManifest = JSON.parse(readFileSync(join(archive.dir, 'manifest.json'), 'utf8'));
  commission(f);
  const plan = await archiveSlimPlan(f.stateDir, { flowIds: ['failed-pnpm'] });
  assert.deepEqual(plan.refused, []); assert.equal(plan.archives, 1);
  const [entry] = plan.entries;
  assert.equal(entry.flowState, 'failed'); assert.equal(entry.kind, 'failed-workspaces'); assert.deepEqual(entry.globs, GLOBS);
  assert.equal(entry.manifestDigest, oldManifest.manifestDigest);
  assert.equal(entry.removed.files, Object.keys(PNPM).length); assert.equal(entry.bytesFreed, PNPM_BYTES);
  assert.equal(entry.current.files - entry.slim.files, Object.keys(PNPM).length); assert.equal(entry.current.bytes - entry.slim.bytes, PNPM_BYTES);
  assert.deepEqual([...entry.removed.sample].sort(), ['.next', 'apps/web/node_modules', 'node_modules']);
  assert.equal(entry.current.tarBytes, statSync(join(archive.dir, 'tree.tar')).size);
  assert.equal(existsSync(join(dirname(archive.dir), `.${basename(archive.dir)}.slim`)), false, 'the plan removed its scratch restore');
  await assert.rejects(slim(f, { flowIds: ['failed-pnpm'] }, plan, { actor: 'orchestrator', onBehalfOf: { principal: 'operator', instruction: 'Slim the archives' } }), /cleanup\.archive-slim is operator only and cannot be delegated/);
  await assert.rejects(slim(f, { flowIds: ['failed-pnpm'] }, plan, { note: ' ' }), /note is required/);
  const done = await slim(f, { flowIds: ['failed-pnpm'] }, plan);
  assert.equal(done.archives, 1); assert.ok(done.tarBytesFreed > PNPM_BYTES);
  // The archive directory: new tar and manifest, the old tar gone, the rest byte-identical, no scratch.
  const manifest = JSON.parse(readFileSync(join(archive.dir, 'manifest.json'), 'utf8'));
  assert.match(manifest.treeFile, /^tree-[0-9a-f]{16}\.tar$/);
  assert.deepEqual(readdirSync(archive.dir).sort(), ['history.bundle', 'index', 'index-objects.pack', 'manifest.json', manifest.treeFile].sort());
  for (const [name, digest] of Object.entries(kept)) assert.equal(sha256(join(archive.dir, name)), digest, `${name} is byte-identical`);
  assert.equal(manifest.slimmedFrom.manifestDigest, oldManifest.manifestDigest); assert.deepEqual(manifest.slimmedFrom.globs, GLOBS); assert.equal(manifest.slimmedFrom.actor, 'operator');
  assert.ok(manifest.excluded.some(row => row.path === 'node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js' && /^[0-9a-f]{64}$/.test(row.sha256)));
  const listed = tarList(archive.dir, manifest.treeFile);
  assert.deepEqual(listed.filter(path => /node_modules|\.next/.test(path)), []);
  for (const path of ['./feature.txt', './apps/web/page.js', './staged.txt', './notes.md', './debug.log', './.gitignore']) assert.ok(listed.includes(path), path);
  assert.equal(readFileSync(join(commits, 'kept.bundle'), 'utf8'), 'fictional bundle\n');
  assert.equal(existsSync(join(dirname(archive.dir), `.${basename(archive.dir)}.slim`)), false);
  // Restore: the commits, the modified, staged and untracked files and the non-matching ignored file.
  const restored = restoreFlowArchive(f.stateDir, 'failed-pnpm', join(f.base, 'restored')), target = restored.target;
  assert.equal(restored.head, archive.head);
  assert.equal(git(target, ['log', '-1', '--format=%s']), 'Unpublished failed-pnpm');
  assert.equal(readFileSync(join(target, 'apps/web/page.js'), 'utf8'), 'export default 2;\n');
  assert.equal(git(target, ['diff', '--cached', '--name-only']), 'staged.txt');
  assert.equal(readFileSync(join(target, 'notes.md'), 'utf8'), 'untracked notes\n');
  assert.equal(readFileSync(join(target, 'debug.log'), 'utf8'), 'ignored, matches no glob\n');
  assert.equal(existsSync(join(target, 'node_modules')), false); assert.equal(existsSync(join(target, '.next')), false);
  assert.match(restored.note, /removed afterwards by cleanup archive-slim/); assert.match(restored.note, /rerun the project's setup step/);
  // Records: the cleanup row follows the new manifest, with an event per archive and one for the run.
  const row = f.store.need('cleanup', 'failed-pnpm');
  assert.equal(row.archive.manifestDigest, manifest.manifestDigest); assert.equal(row.archiveSlims.length, 1);
  const events = f.store.events(50), one = events.find(item => item.type === 'cleanup.archive-slimmed'), run = events.find(item => item.type === 'cleanup.archives-slimmed');
  assert.deepEqual([one.payload.oldManifestDigest, one.payload.newManifestDigest, one.payload.actor, one.payload.note, one.payload.tarBytesFreed], [oldManifest.manifestDigest, manifest.manifestDigest, 'operator', 'Remove reproducible dependencies from old archives', done.tarBytesFreed]);
  assert.deepEqual(run.payload.flows, ['failed-pnpm']);
  // Nothing more to remove now.
  const again = await archiveSlimPlan(f.stateDir, { flowIds: ['failed-pnpm'] });
  assert.deepEqual(again.entries, []); assert.equal(again.unchanged[0].action, 'nothing to remove');
});

test('apply is bound to the plan digest: changed globs or selection are refused, and nothing changes', async t => {
  const f = monorepo(t), archive = await oversizedArchive(f, 'failed-pnpm');
  commission(f);
  const plan = await archiveSlimPlan(f.stateDir, { flowIds: ['failed-pnpm'] });
  commission(f, ['node_modules/**']);
  await assert.rejects(slim(f, { flowIds: ['failed-pnpm'] }, plan), /changed since the archive-slim plan/);
  commission(f);
  await assert.rejects(slim(f, { all: true }, plan), /changed since the archive-slim plan/);
  assert.deepEqual(readdirSync(archive.dir).sort(), ['history.bundle', 'index', 'index-objects.pack', 'manifest.json', 'tree.tar']);
  commission(f, []);
  await assert.rejects(archiveSlimPlan(f.stateDir, { all: true }), /no cleanup.excludeIgnored globs/);
});

test('an interrupted apply leaves a valid archive, and the next plan and apply roll it back or finish it', async t => {
  const f = monorepo(t), archive = await oversizedArchive(f, 'failed-pnpm'), oldRow = f.store.need('cleanup', 'failed-pnpm');
  commission(f);
  const scratch = join(dirname(archive.dir), `.${basename(archive.dir)}.slim`);
  // Interrupted before the commit: a partial new tar, a new manifest and the scratch restore are left.
  writeFileSync(join(archive.dir, 'tree-0123456789abcdef.tar'), 'partial'); writeFileSync(join(archive.dir, 'manifest.slim.json'), '{"partial":');
  mkdirSync(join(scratch, 'restore'), { recursive: true });
  assert.equal(restoreFlowArchive(f.stateDir, 'failed-pnpm', join(f.base, 'before')).head, archive.head, 'the old archive is still valid');
  const rollBack = await archiveSlimPlan(f.stateDir, { flowIds: ['failed-pnpm'] });
  assert.deepEqual(rollBack.entries[0].pending, { strays: ['manifest.slim.json', 'tree-0123456789abcdef.tar'], record: false });
  const oldTar = join(f.base, 'old-tree.tar'); copyFileSync(join(archive.dir, 'tree.tar'), oldTar);
  await slim(f, { flowIds: ['failed-pnpm'] }, rollBack);
  const manifest = JSON.parse(readFileSync(join(archive.dir, 'manifest.json'), 'utf8'));
  assert.deepEqual(readdirSync(archive.dir).sort(), ['history.bundle', 'index', 'index-objects.pack', 'manifest.json', manifest.treeFile].sort());
  assert.equal(existsSync(scratch), false);
  // Interrupted after the commit, before the record and the old tar's removal.
  const newRow = f.store.need('cleanup', 'failed-pnpm');
  copyFileSync(oldTar, join(archive.dir, 'tree.tar')); f.store.put('cleanup', oldRow);
  assert.equal(restoreFlowArchive(f.stateDir, 'failed-pnpm', join(f.base, 'between')).head, archive.head, 'the new archive is already valid');
  const finish = await archiveSlimPlan(f.stateDir, { flowIds: ['failed-pnpm'] });
  assert.deepEqual(finish.entries[0].pending, { strays: ['tree.tar'], record: true }); assert.equal(finish.entries[0].action, 'nothing to remove');
  const done = await slim(f, { flowIds: ['failed-pnpm'] }, finish);
  assert.equal(done.slimmed[0].recovered, true); assert.equal(done.slimmed[0].newManifestDigest, manifest.manifestDigest);
  assert.equal(f.store.need('cleanup', 'failed-pnpm').archive.manifestDigest, newRow.archive.manifestDigest);
  assert.equal(existsSync(join(archive.dir, 'tree.tar')), false);
  // A manifest that is neither the recorded one nor its direct successor is refused.
  f.store.put('cleanup', { ...newRow, archive: { ...newRow.archive, manifestDigest: '0'.repeat(64) } });
  assert.match((await archiveSlimPlan(f.stateDir, { flowIds: ['failed-pnpm'] })).refused[0].reason, /not the archive the cleanup recorded/);
});

test('--all slims every archive that holds removable paths under one digest', async t => {
  const f = monorepo(t);
  const a = await oversizedArchive(f, 'flow-a'), b = await oversizedArchive(f, 'flow-b'), plain = await oversizedArchive(f, 'flow-plain', { pnpm: false });
  commission(f);
  const plan = await archiveSlimPlan(f.stateDir, { all: true });
  assert.deepEqual(plan.entries.map(entry => entry.flowId), ['flow-a', 'flow-b']);
  assert.deepEqual(plan.unchanged.map(entry => entry.flowId), ['flow-plain']);
  assert.equal(plan.bytesFreed, 2 * PNPM_BYTES);
  const cli = JSON.parse(execFileSync(process.execPath, [new URL('../starter/factory/cli.mjs', import.meta.url).pathname, 'cleanup', 'archive-slim', 'plan', '--state', f.stateDir, '--id', 'flow-a', '--id', 'flow-b'], { encoding: 'utf8' }));
  assert.deepEqual(cli.entries.map(entry => entry.flowId), ['flow-a', 'flow-b']);
  const done = await slim(f, { all: true }, plan);
  assert.deepEqual(done.slimmed.map(item => item.flowId), ['flow-a', 'flow-b']);
  for (const archive of [a, b]) assert.equal(existsSync(join(archive.dir, 'tree.tar')), false);
  assert.ok(existsSync(join(plain.dir, 'tree.tar')), 'an archive with nothing to remove is left as it is');
  assert.deepEqual(f.store.events(50).find(item => item.type === 'cleanup.archives-slimmed').payload.flows, ['flow-a', 'flow-b']);
  for (const archive of [a, b]) assert.equal(restoreFlowArchive(f.stateDir, archive.flowId, join(f.base, `restored-${archive.flowId}`)).head, archive.head);
});
