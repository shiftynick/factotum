import { execFileSync } from 'node:child_process';
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assert, digest, now, note } from '../core/contracts.mjs';
import { Store } from '../core/store.mjs';
import { operatorAuthority, validateOnBehalfOf } from '../core/delegation.mjs';
import { archiveScratch, archiveTreeFile, cleanupArchiveName, exclusive, ignoredExcluder, inspectionRestore, sha256File, treeManifest, verifyArchive } from './workspace-cleanup.mjs';

// cleanup archive-slim: rewrite an existing cleanup archive (a failed or a completed flow's, under
// archives/failed-workspaces/ or archives/completed-workspaces/) without the paths the project's
// current cleanup.excludeIgnored globs exclude. Everything else stays restorable, and the history
// bundle, index and index objects are not rewritten. archives/workspace-commits/ is never touched.
//
// What may go: exactly what cleanup would leave out today. The archive is restored into a scratch
// directory and ignoredExcluder runs there, so a path goes only if it matches a glob AND Git, using
// the archived tree's own .gitignore files and the archived index (no global or info/exclude
// rules), reports it ignored. Tracked, modified, untracked and other ignored files stay.
//
// One archive at a time, apply writes tree-<digest>.tar and manifest.slim.json beside the old
// files, proves a fresh restore of them reproduces the slim tree, then renames manifest.slim.json
// over manifest.json. That rename is the only commit point: before it the old manifest and tar are
// untouched and valid; after it the new manifest names the new tar, which is complete. The old
// tar is removed last. What a run leaves behind (the unused tar, manifest.slim.json, a store record
// not yet updated) is found by the next plan without restoring anything; that plan holds only such
// recoveries, and its apply finishes or rolls them back, so a nearly full disk still converges.
// Scratch space (archiveScratch) is a sibling of the archive directory, on the same filesystem;
// a stale one is removed before any restore.
const ARCHIVE_KINDS = ['failed-workspaces', 'completed-workspaces'];
const SLIM_MANIFEST = 'manifest.slim.json';
const STRAY = /^(tree(-[0-9a-f]{16})?\.tar(\.partial)?|manifest\.slim\.json|manifest\.json\.tmp)$/;
const SAMPLE = 20;
class Refused extends Error {}
const refuse = message => { throw new Refused(message); };
const scratchOf = archiveScratch;
const syncPath = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

function readManifest(dir) {
  let manifest; try { manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { refuse(`${dir}/manifest.json is missing or not valid JSON`); }
  const { manifestDigest, ...body } = manifest;
  if (!manifestDigest || digest(body) !== manifestDigest) refuse(`${dir}/manifest.json does not match its own digest`);
  try { archiveTreeFile(manifest); } catch (error) { refuse(`${dir}: ${error.message}`); }
  return manifest;
}
// Files an interrupted slim left in the archive directory: whatever the current manifest does
// not name (the old tar after the commit, the new tar and manifest.slim.json before it).
const strays = (dir, manifest) => readdirSync(dir).filter(name => STRAY.test(name) && name !== archiveTreeFile(manifest)).sort();
function locate(store, row) {
  const flow = store.get('flow', row.id);
  if (!flow?.workspace?.ownershipDigest) refuse('the flow or its workspace record is missing');
  const kind = basename(dirname(row.archiveDir)), name = basename(row.archiveDir);
  if (!ARCHIVE_KINDS.includes(kind) || name !== cleanupArchiveName(flow.id, flow.workspace.ownershipDigest)) refuse(`the recorded archive ${row.archiveDir} is not a cleanup archive of this flow`);
  for (const parent of ['archives', `archives/${kind}`]) if (lstatSync(join(store.stateDir, parent), { throwIfNoEntry: false })?.isSymbolicLink()) refuse(`${join(store.stateDir, parent)} is a symbolic link`);
  const dir = join(store.stateDir, 'archives', kind, name), stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) refuse(`the archive directory ${dir} is missing`);
  return { flow, kind, dir };
}
// Restore the archive into its scratch directory and work out the slim tree. The caller removes
// the scratch directory (keep: the restore, for building the new tar).
function analyse(dir, manifest, globs) {
  // Only the archived tree's own rules: no info/exclude from a template, no global excludes file.
  const restored = inspectionRestore(dir, manifest);
  const full = treeManifest(restored);
  if (full.digest !== manifest.treeDigest || full.special.length) refuse(`${dir} does not restore to the tree its manifest records`);
  return { restored, tree: split(full, ignoredExcluder(restored, globs)) };
}
// The restored tree split as treeManifest splits a workspace: an entry is excluded when `exclude`
// says so or its directory is excluded. Entries keep their digests, so nothing is hashed twice.
function split(full, exclude) {
  const entries = [], excluded = [], dirs = new Set();
  let bytes = 0, excludedBytes = 0;
  for (const entry of full.entries) {
    const at = entry.path.lastIndexOf('/'), out = (at > 0 && dirs.has(entry.path.slice(0, at))) || exclude(entry.path);
    if (out) { excluded.push(entry); if (entry.type === 'dir') dirs.add(entry.path); if (entry.type === 'file') excludedBytes += entry.size; }
    else { entries.push(entry); if (entry.type === 'file') bytes += entry.size; }
  }
  return { entries, excluded, bytes, excludedBytes, digest: digest(entries), excludedDigest: digest(excluded) };
}
const removedRoots = excluded => { const paths = new Set(excluded.map(entry => entry.path)); return excluded.filter(entry => !entry.path.includes('/') || !paths.has(entry.path.slice(0, entry.path.lastIndexOf('/')))).map(entry => entry.path); };

// One archive, without restoring it: where it is, its manifest, and anything an earlier run left
// to finish (stray files, a store record behind a committed manifest).
function inspectArchive(store, flowId, globs) {
  const row = store.get('cleanup', flowId);
  if (!row?.archive || !row.archiveDir) refuse('no cleanup archive is recorded for this flow');
  if (row.archiveDrop) refuse(`its archive was dropped (cleanup archive-drop, ${row.archiveDrop.status})`);
  if (row.status !== 'released') refuse('the flow\'s cleanup has not finished; finish it with cleanup apply first');
  const { flow, kind, dir } = locate(store, row), manifest = readManifest(dir), scratch = scratchOf(dir);
  // The store records the manifest digest it last saw; a newer manifest is accepted only as the
  // direct successor an interrupted slim committed.
  const recordPending = manifest.manifestDigest !== row.archive.manifestDigest;
  if (recordPending && manifest.slimmedFrom?.manifestDigest !== row.archive.manifestDigest) refuse(`${dir}/manifest.json is not the archive the cleanup recorded`);
  // A stale scratch directory is only scratch: the analysis below replaces it, so it is not listed.
  const finish = { strays: strays(dir, manifest), record: recordPending };
  const pending = finish.strays.length || finish.record ? finish : null;
  return { manifest, scratch, base: { flowId, flowState: flow.state, kind, dir, manifestDigest: manifest.manifestDigest, globs, ...(pending ? { pending } : {}) } };
}
// What slimming one archive would do (it restores the archive into scratch space).
function entryFor(store, flowId, globs, { keep = false } = {}) {
  const { manifest, scratch, base } = inspectArchive(store, flowId, globs), { dir } = base;
  const tarBytes = statSync(join(dir, archiveTreeFile(manifest))).size;
  try {
    const analysis = analyse(dir, manifest, globs);
    const { tree } = analysis, roots = removedRoots(tree.excluded);
    const removedFiles = tree.excluded.filter(entry => entry.type === 'file').length;
    const entry = !tree.excluded.length ? { ...base, action: 'nothing to remove' } : {
      ...base, action: 'slim',
      current: { files: tree.entries.filter(e => e.type === 'file').length + removedFiles, bytes: tree.bytes + tree.excludedBytes, tarBytes },
      slim: { files: tree.entries.filter(e => e.type === 'file').length, bytes: tree.bytes, treeDigest: tree.digest },
      bytesFreed: tree.excludedBytes,
      removed: { entries: tree.excluded.length, files: removedFiles, digest: tree.excludedDigest, roots: roots.length, sample: roots.slice(0, SAMPLE) },
    };
    if (keep) return { entry, analysis, manifest };
    rmSync(scratch, { recursive: true, force: true });
    return { entry };
  } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
}

async function planArchiveSlim(store, { flowIds = [], all = false }) {
  assert(all || flowIds.length, 'name the flows with --id (repeatable) or select every cleanup archive with --all');
  const globs = store.meta('config', {}).cleanup?.excludeIgnored ?? [];
  assert(globs.length, 'the project commissions no cleanup.excludeIgnored globs, so there is nothing to remove');
  const rows = store.all('cleanup').filter(row => row.archive && !row.archiveDrop);
  const selected = [...new Set([...flowIds, ...(all ? rows.map(row => row.id) : [])])].sort();
  const entries = [], unchanged = [], refused = [], inspected = [];
  const attempt = (flowId, fn) => { try { return fn(); } catch (error) { if (!(error instanceof Refused)) throw error; refused.push({ flowId, reason: error.message }); return null; } };
  // First, without restoring anything: anything an interrupted run left. Recovering it needs no
  // restore and frees its space, so a plan that holds any recovery holds only recoveries; plan
  // again after applying it. A nearly full disk can always get this far.
  for (const flowId of selected) { const found = attempt(flowId, () => inspectArchive(store, flowId, globs)); if (found) inspected.push(found); }
  const recovery = inspected.filter(found => found.base.pending).map(found => ({ ...found.base, action: 'recover' }));
  if (recovery.length) {
    const bound = { selection: { ids: [...new Set(flowIds)].sort(), all }, globs, recovery: true, entries: recovery, refused };
    return { ...bound, unchanged: [], archives: 0, bytesFreed: 0, note: 'An earlier archive-slim was interrupted. Apply this plan to finish or roll back what it left (no restore is needed), then plan again.', planDigest: digest(bound) };
  }
  // Stale scratch directories go before any restore, to free their space first.
  for (const found of inspected) rmSync(found.scratch, { recursive: true, force: true });
  for (const { base } of inspected) {
    const result = attempt(base.flowId, () => entryFor(store, base.flowId, globs));
    if (result) (result.entry.action === 'slim' ? entries : unchanged).push(result.entry);
  }
  const bound = { selection: { ids: [...new Set(flowIds)].sort(), all }, globs, entries, unchanged: unchanged.map(entry => ({ flowId: entry.flowId, manifestDigest: entry.manifestDigest })), refused };
  return {
    ...bound, unchanged, archives: entries.filter(entry => entry.action === 'slim').length, bytesFreed: entries.reduce((sum, entry) => sum + (entry.bytesFreed ?? 0), 0),
    note: 'Apply restores each archive again, writes the slim tar beside the old one, proves a fresh restore, then swaps the manifest. The history bundle, index and index objects are kept byte for byte; archives/workspace-commits/ is never touched.',
    planDigest: digest(bound),
  };
}

// The plan restores into scratch directories too, so it takes the archives lock.
export async function archiveSlimPlan(stateDir, selection) {
  const store = new Store(stateDir);
  try {
    const unlock = await exclusive(store.meta('project').projectId, 'archives');
    try { return await planArchiveSlim(store, selection); } finally { await unlock(); }
  } finally { store.close(); }
}

// Finish what an earlier run left: the store record of a committed manifest and stray files.
function finishPending(store, entry, { actor, note: reason, planDigest }) {
  const { dir, pending } = entry;
  if (!pending) return null;
  let finished = null;
  if (pending.record) {
    const manifest = readManifest(dir), old = pending.strays.find(name => name === manifest.slimmedFrom.treeFile);
    finished = record(store, entry.flowId, dir, manifest, { actor, note: reason, planDigest, oldTarBytes: old ? statSync(join(dir, old)).size : null, recovered: true });
  }
  for (const name of pending.strays) rmSync(join(dir, name), { force: true });
  rmSync(scratchOf(dir), { recursive: true, force: true });
  syncPath(dir);
  return finished;
}
// The store follows the committed manifest: the cleanup record's archive summary and its history.
function record(store, flowId, dir, manifest, { actor, note: reason, planDigest, oldTarBytes, recovered = false }) {
  const newTarBytes = statSync(join(dir, archiveTreeFile(manifest))).size;
  const slim = manifest.slimmedFrom, tarBytesFreed = oldTarBytes === null ? null : oldTarBytes - newTarBytes;
  const event = { flowId, oldManifestDigest: slim.manifestDigest, newManifestDigest: manifest.manifestDigest, globs: slim.globs, removedEntries: slim.removedEntries, removedFiles: slim.removedFiles, removedBytes: slim.removedBytes, tarBytesFreed, actor, note: reason, planDigest, ...(recovered ? { recovered: true } : {}) };
  store.tx(() => {
    const row = store.need('cleanup', flowId), { excluded = [], manifestDigest, ...summary } = manifest;
    store.put('cleanup', { ...row, archive: { ...row.archive, ...summary, excludedEntries: excluded.length, manifestDigest }, archiveSlims: [...(row.archiveSlims ?? []), { at: now(), actor, note: reason, planDigest, from: slim.manifestDigest, to: manifestDigest, tarBytesFreed, ...(recovered ? { recovered: true } : {}) }] });
    store.event('cleanup.archive-slimmed', event);
  });
  return event;
}
function slimOne(store, planned, { actor, note: reason, planDigest, globs, step }) {
  const { entry, analysis, manifest } = entryFor(store, planned.flowId, globs, { keep: true });
  const { dir } = entry, scratch = scratchOf(dir);
  try {
    assert(digest(entry) === digest(planned), `the archive of ${planned.flowId} changed since the plan; review a new plan`);
    const { restored, tree } = analysis, oldTree = archiveTreeFile(manifest), oldTarBytes = statSync(join(dir, oldTree)).size;
    // 1. The new tar, beside the old one, from the restored tree; then the scratch restore goes.
    const partial = join(dir, 'tree.tar.partial');
    execFileSync('tar', ['--create', '--format=posix', '--numeric-owner', '--no-recursion', '--null', '--file', partial, '-C', restored, '--files-from=-'], { input: tree.entries.map(e => `./${e.path}`).join('\0') + (tree.entries.length ? '\0' : ''), stdio: ['pipe', 'pipe', 'pipe'], timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
    rmSync(restored, { recursive: true, force: true });
    const treeSha = sha256File(partial), treeFile = `tree-${treeSha.slice(0, 16)}.tar`;
    assert(treeFile !== oldTree, 'the slim tar is identical to the current one');
    syncPath(partial); renameSync(partial, join(dir, treeFile));
    step('tar-written');
    // 2. The new manifest: removed entries listed like excluded ones, and where it came from.
    const { manifestDigest: oldDigest, ...body } = manifest, removedFiles = tree.excluded.filter(e => e.type === 'file').length;
    const slimmedFrom = { manifestDigest: oldDigest, treeFile: oldTree, treeDigest: manifest.treeDigest, globs, excludedBefore: (manifest.excluded ?? []).length, removedEntries: tree.excluded.length, removedFiles, removedBytes: tree.excludedBytes, at: now(), actor, note: reason, planDigest, ...(manifest.slimmedFrom ? { previous: manifest.slimmedFrom } : {}) };
    const next = { ...body, treeDigest: tree.digest, treeFile, excluded: [...(manifest.excluded ?? []), ...tree.excluded], files: { ...manifest.files, tree: treeSha }, slimmedFrom };
    const written = { ...next, manifestDigest: digest(next) };
    writeFileSync(join(dir, SLIM_MANIFEST), JSON.stringify(written, null, 2)); syncPath(join(dir, SLIM_MANIFEST)); syncPath(dir);
    step('manifest-written');
    // 3. Prove a fresh restore of the new archive reproduces the slim tree and the same index.
    verifyArchive(dir, written, { scratch: join(scratch, 'verify') });
    rmSync(scratch, { recursive: true, force: true });
    step('verified');
    // 4. Commit: the new manifest replaces the old one in one rename. Then record, then remove the old tar.
    renameSync(join(dir, SLIM_MANIFEST), join(dir, 'manifest.json')); syncPath(dir);
    step('committed');
    const event = record(store, planned.flowId, dir, written, { actor, note: reason, planDigest, oldTarBytes });
    step('recorded');
    rmSync(join(dir, oldTree), { force: true }); syncPath(dir);
    return event;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// step: tests only; called at each boundary of an archive's slim, so a test can stop apply there.
export async function archiveSlimApply(stateDir, { flowIds = [], all = false, planDigest, note: reason, actor = 'operator', onBehalfOf, step = () => {} }) {
  validateOnBehalfOf(onBehalfOf, actor);
  const store = new Store(stateDir);
  try {
    // Operator only: cleanup.archive-slim is not in DELEGABLE, so no policy can delegate it.
    operatorAuthority(store, { operation: 'cleanup.archive-slim', actor, onBehalfOf });
    note(reason);
    const unlock = await exclusive(store.meta('project').projectId, 'archives');
    try {
      const plan = await planArchiveSlim(store, { flowIds, all });
      assert(plan.planDigest === planDigest, 'the archives, the globs or the selection changed since the archive-slim plan; review a new plan');
      assert(plan.entries.length, 'the plan changes no archive');
      const results = [];
      if (plan.recovery) {
        for (const planned of plan.entries) { const finished = finishPending(store, planned, { actor, note: reason, planDigest }); results.push(finished ?? { flowId: planned.flowId, recovered: true, tarBytesFreed: null }); }
        store.event('cleanup.archives-slimmed', { planDigest, recovery: true, flows: results.map(item => item.flowId), actor, note: reason });
        return { status: 'recovered', planDigest, archives: results.length, slimmed: results, refused: plan.refused, next: 'plan again to slim' };
      }
      for (const planned of plan.entries) results.push(slimOne(store, planned, { actor, note: reason, planDigest, globs: plan.globs, step }));
      const tarBytesFreed = results.reduce((sum, item) => sum + (item.tarBytesFreed ?? 0), 0);
      store.event('cleanup.archives-slimmed', { planDigest, flows: [...new Set(results.map(item => item.flowId))], tarBytesFreed, globs: plan.globs, actor, note: reason });
      return { status: 'slimmed', planDigest, archives: results.length, tarBytesFreed, slimmed: results, refused: plan.refused };
    } finally { await unlock(); }
  } finally { store.close(); }
}
