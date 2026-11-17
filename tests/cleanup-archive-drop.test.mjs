import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { commit, prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { cleanupApply, cleanupPlan, restoreFlowArchive } from '../starter/factory/operations/workspace-cleanup.mjs';
import { archiveDropApply, archiveDropPlan } from '../starter/factory/operations/cleanup-archive-drop.mjs';
import { archiveSlimApply, archiveSlimPlan } from '../starter/factory/operations/cleanup-archive-slim.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const ignore = (path, line) => writeFileSync(git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']), `${line}\n`, { flag: 'a' });

// A project with a local bare remote. Each flow below is merged (or squashed) into main on the
// remote, holds an unsaved ignored file, and is archived and released by cleanup plan/apply.
function project(t) {
  const f = sandbox(t);
  git(f.root, ['branch', '-M', 'main']);
  const remote = join(f.base, 'remote.git');
  git(f.root, ['init', '-q', '--bare', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', '-u', 'origin', 'main']);
  f.store.setMeta('config', { ...f.store.meta('config', {}), repository: { remote: 'origin', target: 'main', mergeMethod: 'merge' } });
  return f;
}
async function archivedFlow(f, flowId, { method = 'merge', state = 'completed', unmergedCommit = false, commitsBundle = false, tree = () => {} } = {}) {
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId, baseRef: 'main' });
  const { head: _base, setupDigest, ...owned } = workspace;
  writeFileSync(join(workspace.path, `${flowId}.txt`), `Fictional work for ${flowId}\n`);
  let { head } = await commit({ workspace, message: `Fictional ${flowId}` });
  if (state === 'completed') {
    if (method === 'merge') git(f.root, ['merge', '-q', '--no-ff', '-m', `Merge ${flowId}`, workspace.branch]);
    else { git(f.root, ['merge', '-q', '--squash', workspace.branch]); git(f.root, ['commit', '-qm', `Squashed ${flowId}`]); }
    git(f.root, ['push', '-q', 'origin', 'main']);
  }
  if (unmergedCommit) { writeFileSync(join(workspace.path, 'later.txt'), 'Committed after the merge\n'); ({ head } = await commit({ workspace, message: 'Fictional later work' })); }
  if (commitsBundle) {
    const dir = join(f.stateDir, 'archives', 'workspace-commits'), bundle = join(dir, `${flowId}.bundle`);
    mkdirSync(dir, { recursive: true }); git(workspace.path, ['bundle', 'create', bundle, workspace.branch]);
    writeFileSync(`${bundle}.json`, JSON.stringify({ version: 1, ownershipDigest: owned.ownershipDigest, head, archivePath: bundle, archiveDigest: sha256(bundle) }));
  }
  ignore(workspace.path, 'notes.txt'); writeFileSync(join(workspace.path, 'notes.txt'), 'Unsaved fictional notes\n');
  tree(workspace.path);
  f.store.put('flow', { id: flowId, taskId: f.task.id, kind: 'change', state, step: 'done', target: 'main', workspace: owned, results: state === 'completed' ? { merge: { merged: true, mergeMethod: method, expectedHead: head } } : {} });
  const plan = await cleanupPlan(f.stateDir, flowId);
  if (state === 'completed') assert.equal(plan.mode, 'archive');
  const done = await cleanupApply(f.stateDir, { flowId, planDigest: plan.planDigest, note: 'Archive, then release' });
  assert.equal(done.status, 'released');
  return { flowId, head, archiveDir: done.archiveDir, owned };
}
const drop = (f, selection, plan, extra = {}) => archiveDropApply(f.stateDir, { ...selection, planDigest: plan.planDigest, note: 'Reclaim space from merged flows', actor: 'operator', ...extra });

test('archive-drop removes a merged flow\'s verified archive, records it, and keeps everything else', async t => {
  const f = project(t), merged = await archivedFlow(f, 'merged');
  assert.match(merged.archiveDir, /archives\/completed-workspaces\//);
  const plan = await archiveDropPlan(f.stateDir, { flowIds: ['merged'] });
  assert.deepEqual(plan.refused, []); assert.equal(plan.flows, 1);
  const [entry] = plan.entries;
  assert.equal(entry.head, merged.head);
  assert.equal(entry.evidence.reachable, true); assert.equal(entry.evidence.target, 'origin/main'); assert.equal(entry.evidence.targetHead, git(f.root, ['rev-parse', 'main']));
  assert.deepEqual(entry.archives.map(archive => archive.dir), [merged.archiveDir]);
  assert.ok(['history.bundle', 'tree.tar', 'index', 'index-objects.pack', 'manifest.json'].every(name => entry.archives[0].files.some(file => file.path === name)));
  assert.equal(plan.bytes, entry.archives[0].files.reduce((sum, file) => sum + file.bytes, 0)); assert.ok(plan.bytes > 0);
  assert.equal(entry.archives[0].manifestDigest, f.store.need('cleanup', 'merged').archive.manifestDigest);
  // Operator only, never delegated, and a note is required.
  await assert.rejects(drop(f, { flowIds: ['merged'] }, plan, { actor: 'orchestrator', onBehalfOf: { principal: 'operator', instruction: 'Drop the archives' } }), /cleanup\.archive-drop is operator only and cannot be delegated/);
  await assert.rejects(drop(f, { flowIds: ['merged'] }, plan, { note: '' }), /note is required/);
  const done = await drop(f, { flowIds: ['merged'] }, plan);
  assert.equal(done.flows, 1); assert.equal(done.bytesFreed, plan.bytes);
  assert.equal(existsSync(merged.archiveDir), false);
  const row = f.store.need('cleanup', 'merged');
  assert.equal(row.archiveDrop.status, 'dropped'); assert.equal(row.archiveDrop.bytesFreed, plan.bytes); assert.equal(row.archiveDrop.actor, 'operator');
  const event = f.store.events(50).find(item => item.type === 'cleanup.archive-dropped');
  assert.deepEqual([event.payload.flowId, event.payload.bytes, event.payload.actor, event.payload.note, event.payload.dirs], ['merged', plan.bytes, 'operator', 'Reclaim space from merged flows', [merged.archiveDir]]);
  assert.throws(() => restoreFlowArchive(f.stateDir, 'merged', join(f.base, 'restored')), /archive was dropped/);
  const again = await archiveDropPlan(f.stateDir, { flowIds: ['merged'] });
  assert.deepEqual(again.entries, []); assert.match(again.refused[0].reason, /already dropped/);
});

test('archive-drop refuses failed flows, unproven merges, unreleased workspaces and unmerged heads', async t => {
  const f = project(t);
  const failed = await archivedFlow(f, 'failed', { state: 'failed' });
  assert.match(failed.archiveDir, /archives\/failed-workspaces\//);
  await archivedFlow(f, 'unproven'); f.store.put('flow', { ...f.store.need('flow', 'unproven'), results: { merge: { merged: false } } });
  await archivedFlow(f, 'unreleased'); const { workspaceReleased, ...unreleased } = f.store.need('flow', 'unreleased'); f.store.put('flow', unreleased);
  await archivedFlow(f, 'later', { unmergedCommit: true });
  const plan = await archiveDropPlan(f.stateDir, { flowIds: ['failed', 'unproven', 'unreleased', 'later', 'missing'] });
  assert.deepEqual(plan.entries, []);
  const reasons = Object.fromEntries(plan.refused.map(row => [row.flowId, row.reason]));
  assert.match(reasons.failed, /only copy of its unsaved work/);
  assert.match(reasons.unproven, /no proven merge/);
  assert.match(reasons.unreleased, /workspace is not released/);
  assert.match(reasons.later, /is not reachable from the fetched origin\/main/);
  assert.match(reasons.missing, /no such flow/);
  await assert.rejects(drop(f, { flowIds: ['failed'] }, await archiveDropPlan(f.stateDir, { flowIds: ['failed'] })), /drops no archive/);
  assert.ok(existsSync(failed.archiveDir));
});

test('a squash-merged flow is dropped only when its commits are kept in workspace-commits, which is never touched', async t => {
  const f = project(t);
  const kept = await archivedFlow(f, 'squash-kept', { method: 'squash', commitsBundle: true });
  await archivedFlow(f, 'squash-only', { method: 'squash' });
  const commits = join(f.stateDir, 'archives', 'workspace-commits', 'squash-kept.bundle'), before = sha256(commits);
  const plan = await archiveDropPlan(f.stateDir, { flowIds: ['squash-kept', 'squash-only'] });
  assert.deepEqual(plan.entries.map(entry => entry.flowId), ['squash-kept']);
  assert.equal(plan.entries[0].evidence.commitsBundle, commits);
  assert.match(plan.refused[0].reason, /merged with squash, and its commits are kept only in this archive/);
  await drop(f, { flowIds: ['squash-kept', 'squash-only'] }, plan);
  assert.equal(existsSync(kept.archiveDir), false);
  assert.equal(sha256(commits), before); assert.ok(existsSync(`${commits}.json`));
});

test('apply is bound to the plan digest: a changed archive or selection is refused', async t => {
  const f = project(t), merged = await archivedFlow(f, 'merged');
  const plan = await archiveDropPlan(f.stateDir, { flowIds: ['merged'] });
  await assert.rejects(drop(f, { completed: true }, plan), /changed since the archive-drop plan/);
  writeFileSync(join(merged.archiveDir, 'stray.txt'), 'Added after the plan\n');
  await assert.rejects(drop(f, { flowIds: ['merged'] }, plan), /changed since the archive-drop plan/);
  assert.ok(existsSync(join(merged.archiveDir, 'tree.tar')));
  writeFileSync(join(merged.archiveDir, 'tree.tar'), 'tampered\n');
  const tampered = await archiveDropPlan(f.stateDir, { flowIds: ['merged'] });
  assert.deepEqual(tampered.entries, []); assert.match(tampered.refused[0].reason, /tree\.tar does not match the archive manifest/);
});

test('one plan covers several flows by --completed or repeated ids, and failed flows\' archives are kept', async t => {
  const f = project(t);
  const a = await archivedFlow(f, 'flow-a'), b = await archivedFlow(f, 'flow-b'), failed = await archivedFlow(f, 'flow-failed', { state: 'failed' });
  const byIds = await archiveDropPlan(f.stateDir, { flowIds: ['flow-b', 'flow-a'] });
  const all = await archiveDropPlan(f.stateDir, { completed: true });
  const cli = args => JSON.parse(execFileSync(process.execPath, [new URL('../starter/factory/cli.mjs', import.meta.url).pathname, 'cleanup', 'archive-drop', 'plan', '--state', f.stateDir, ...args], { encoding: 'utf8' }));
  assert.equal(cli(['--id', 'flow-a', '--id', 'flow-b']).planDigest, byIds.planDigest, 'the CLI takes repeated --id');
  assert.equal(cli(['--completed']).planDigest, all.planDigest);
  assert.deepEqual(all.entries.map(entry => entry.flowId), ['flow-a', 'flow-b']); assert.deepEqual(all.refused, []);
  assert.equal(all.keptFailedFlowArchives, 1);
  assert.equal(all.bytes, all.entries[0].bytes + all.entries[1].bytes);
  assert.notEqual(byIds.planDigest, all.planDigest, 'the selection is bound');
  await assert.rejects(archiveDropPlan(f.stateDir, {}), /--id .* or .* --completed/);
  const done = await drop(f, { completed: true }, all);
  assert.deepEqual(done.dropped.map(entry => entry.flowId), ['flow-a', 'flow-b']); assert.equal(done.bytesFreed, all.bytes);
  assert.equal(existsSync(a.archiveDir), false); assert.equal(existsSync(b.archiveDir), false); assert.ok(existsSync(failed.archiveDir));
  const summary = f.store.events(50).find(item => item.type === 'cleanup.archives-dropped');
  assert.deepEqual(summary.payload.flows, ['flow-a', 'flow-b']); assert.equal(summary.payload.bytesFreed, all.bytes);
  assert.deepEqual((await archiveDropPlan(f.stateDir, { completed: true })).entries, []);
});

test('an apply interrupted while removing is finished by the next plan and apply', async t => {
  const f = project(t), merged = await archivedFlow(f, 'merged');
  const row = f.store.need('cleanup', 'merged');
  f.store.put('cleanup', { ...row, archiveDrop: { status: 'dropping', actor: 'operator', note: 'Interrupted', dirs: [merged.archiveDir], startedAt: new Date().toISOString() } });
  execFileSync('rm', ['-f', join(merged.archiveDir, 'tree.tar')]);
  const plan = await archiveDropPlan(f.stateDir, { flowIds: ['merged'] });
  assert.equal(plan.entries[0].resume, true);
  await drop(f, { flowIds: ['merged'] }, plan);
  assert.equal(existsSync(merged.archiveDir), false); assert.equal(f.store.need('cleanup', 'merged').archiveDrop.status, 'dropped');
});

test('a slimmed archive verifies for archive-drop, and a dropped archive cannot be slimmed', async t => {
  const f = project(t);
  const merged = await archivedFlow(f, 'merged', { tree: path => { writeFileSync(join(path, '.gitignore'), 'node_modules/\n'); mkdirSync(join(path, 'node_modules/.pnpm/x'), { recursive: true }); writeFileSync(join(path, 'node_modules/.pnpm/x/i.js'), 'reproducible\n'); } });
  f.store.setMeta('config', { ...f.store.meta('config'), cleanup: { excludeIgnored: ['node_modules/**'] } });
  const slimPlan = await archiveSlimPlan(f.stateDir, { flowIds: ['merged'] });
  assert.equal(slimPlan.entries[0].removed.files, 1);
  await archiveSlimApply(f.stateDir, { flowIds: ['merged'], planDigest: slimPlan.planDigest, note: 'Slim first', actor: 'operator' });
  const plan = await archiveDropPlan(f.stateDir, { flowIds: ['merged'] });
  assert.deepEqual(plan.refused, []); assert.ok(plan.entries[0].archives[0].files.some(file => /^tree-[0-9a-f]{16}\.tar$/.test(file.path)));
  await drop(f, { flowIds: ['merged'] }, plan);
  assert.equal(existsSync(merged.archiveDir), false);
  assert.match((await archiveSlimPlan(f.stateDir, { flowIds: ['merged'] })).refused[0].reason, /archive was dropped/);
});
