import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assert, digest, now, note } from '../core/contracts.mjs';
import { NO_PLANTED_COMMANDS } from '../core/git-options.mjs';
import { Store } from '../core/store.mjs';
import { operatorAuthority, validateOnBehalfOf } from '../core/delegation.mjs';
import { git as workspaceGit } from '../adapters/workspace/index.mjs';
import { cleanupArchiveName, exclusive, provenOutcome, repositoryScope } from './workspace-cleanup.mjs';

// cleanup archive-drop: the operator removes the cleanup archives of flows whose outcome is
// proven, to reclaim disk space. plan (reads the state, fetches each target) -> apply (operator
// only, never delegated; bound to the plan digest). An archive is eligible only when:
//   - its flow is completed with a merged PR or a proven satisfied record (a failed or abandoned
//     flow's archive may be the only copy of unsaved work, and is never dropped);
//   - the flow's workspace is already released, so no live workspace is touched;
//   - the archived head is kept elsewhere: reachable from the fetched target (merge method
//     `merge`), or in a verified bundle under archives/workspace-commits/ (squash and rebase).
//     A satisfied flow's commits were never merged; its proven record is the evidence.
//   - the archive directory verifies against its manifest and the digest the cleanup recorded.
// archives/workspace-commits/ is never touched. Only the flow's own directories under
// archives/failed-workspaces/ and archives/completed-workspaces/ are removed.
const ARCHIVE_KINDS = ['failed-workspaces', 'completed-workspaces'];
const PAYLOAD = { bundle: 'history.bundle', tree: 'tree.tar', index: 'index', objects: 'index-objects.pack' };
const sha256Stream = path => new Promise((done, fail) => { const hash = createHash('sha256'); createReadStream(path).on('error', fail).on('data', chunk => hash.update(chunk)).on('end', () => done(hash.digest('hex'))); });
const gitSync = (cwd, args) => execFileSync('git', [...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trim();
class Refused extends Error {}
const refuse = message => { throw new Refused(message); };

// Every file below an archive directory, with its size and SHA-256. Anything other than a regular
// file or a directory (a symbolic link, a device) refuses the archive.
async function archiveFiles(dir) {
  const files = [];
  const walk = async relative => {
    for (const name of readdirSync(join(dir, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name, stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile()) files.push({ path, bytes: stat.size, sha256: await sha256Stream(join(dir, path)) });
      else refuse(`archive ${dir} holds ${path}, which is not a regular file`);
    }
  };
  await walk('');
  return files;
}
// The archive's manifest must be intact (its own digest), belong to this flow and archived head,
// and its payload files must match it.
async function verifiedArchive(dir, { flowId, head, manifestDigest }) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) refuse(`${dir} is not an archive directory`);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) refuse(`${dir} has no manifest.json: an unfinished archive; inspect it by hand`);
  let manifest; try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { refuse(`${dir}/manifest.json is not valid JSON`); }
  const { manifestDigest: recorded, ...body } = manifest;
  if (!recorded || digest(body) !== recorded) refuse(`${dir}/manifest.json does not match its own digest`);
  if (manifestDigest && recorded !== manifestDigest) refuse(`${dir}/manifest.json is not the archive the cleanup recorded`);
  if (manifest.flowId !== flowId || manifest.head !== head) refuse(`${dir} is not this flow's archive of ${head}`);
  const files = await archiveFiles(dir);
  for (const [key, name] of Object.entries(PAYLOAD)) if (files.find(file => file.path === name)?.sha256 !== manifest.files?.[key]) refuse(`${dir}/${name} does not match the archive manifest`);
  return { dir, manifestDigest: recorded, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}
// The flow's archive directories: its recorded one and anything at its name under either kind.
function archiveDirectories(stateDir, flow, row) {
  const name = cleanupArchiveName(flow.id, flow.workspace.ownershipDigest);
  for (const recorded of [row.archiveDir, flow.workspaceReleased?.archiveDir].filter(Boolean)) if (basename(recorded) !== name) refuse(`the recorded archive ${recorded} is not at this flow's archive name; inspect it by hand`);
  for (const parent of ['archives', ...ARCHIVE_KINDS.map(kind => `archives/${kind}`)]) if (existsSync(join(stateDir, parent)) && lstatSync(join(stateDir, parent)).isSymbolicLink()) refuse(`${join(stateDir, parent)} is a symbolic link`);
  return ARCHIVE_KINDS.map(kind => join(stateDir, 'archives', kind, name)).filter(dir => existsSync(dir));
}
// The archived head is kept elsewhere: the merged target, a verified commits bundle or a proven satisfied record.
async function keptElsewhere(store, flow, head, fetched) {
  const config = store.meta('config', {});
  if (flow.results?.merge?.merged !== true) return { outcome: 'satisfied', satisfiedHead: flow.results['satisfied-record'].head ?? null };
  const mergeMethod = flow.results.merge.mergeMethod ?? config.repository?.mergeMethod ?? 'merge';
  if (mergeMethod === 'merge') {
    const remote = config.repository?.remote ?? 'origin', target = flow.target ?? config.repository?.target, ref = `${remote}/${target}`;
    if (!target) refuse('the flow names no target to check the archived head against');
    const fetch = await fetched(remote, target);
    if (fetch.error) refuse(`could not fetch ${ref}: ${fetch.error}`);
    let reachable = false;
    try { gitSync(store.meta('project').root, ['merge-base', '--is-ancestor', head, `refs/remotes/${ref}`]); reachable = true; } catch { /* exit 1, or the commit is unknown */ }
    if (!reachable) refuse(`the archived head ${head} is not reachable from the fetched ${ref}`);
    return { outcome: 'merged', mergeMethod, check: 'head reachable from the fetched target', target: ref, reachable: true, targetHead: fetch.head };
  }
  const commits = join(store.stateDir, 'archives', 'workspace-commits');
  const receipts = existsSync(commits) ? readdirSync(commits).filter(name => name.endsWith('.bundle.json')) : [];
  for (const name of receipts) {
    let receipt; try { receipt = JSON.parse(readFileSync(join(commits, name), 'utf8')); } catch { continue; }
    if (receipt.head !== head || receipt.ownershipDigest !== flow.workspace.ownershipDigest) continue;
    const bundle = join(commits, name.slice(0, -'.json'.length));
    if (existsSync(bundle) && await sha256Stream(bundle) === receipt.archiveDigest) return { outcome: 'merged', mergeMethod, check: 'commits kept in a verified bundle, which is not dropped', commitsBundle: bundle };
  }
  refuse(`merged with ${mergeMethod}, and its commits are kept only in this archive (no verified bundle of ${head} under archives/workspace-commits/)`);
}
async function entryFor(store, flowId, fetched) {
  const flow = store.get('flow', flowId);
  if (!flow) refuse('no such flow');
  if (flow.state === 'failed') refuse('a failed or abandoned flow\'s archive may be the only copy of its unsaved work; it is never dropped');
  if (flow.state !== 'completed') refuse(`the flow is ${flow.state}, not completed`);
  if (!provenOutcome(flow)) refuse('the flow has no proven merge or recorded satisfied outcome');
  if (!flow.workspaceReleased || !flow.workspace?.path || existsSync(flow.workspace.path)) refuse('the flow\'s workspace is not released');
  const row = store.get('cleanup', flowId);
  if (!row?.archive) refuse('no cleanup archive is recorded for this flow');
  if (row.archiveDrop?.status === 'dropped') refuse(`its archive was already dropped (${row.archiveDrop.droppedAt})`);
  const dirs = archiveDirectories(store.stateDir, flow, row);
  // An apply interrupted while removing: finish removing the directories it recorded.
  if (row.archiveDrop?.status === 'dropping') {
    const remaining = dirs.filter(dir => row.archiveDrop.dirs.includes(dir));
    return { flowId, taskId: flow.taskId, resume: true, head: row.archive.head, archives: await Promise.all(remaining.map(async dir => { const files = await archiveFiles(dir); return { dir, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }; })) };
  }
  if (!dirs.length) refuse('its recorded archive directory no longer exists');
  const head = row.archive.head, evidence = await keptElsewhere(store, flow, head, fetched);
  const archives = [];
  // The recorded directory must hold the very archive the cleanup recorded; another one found at
  // the flow's name (under the other kind) must at least be this flow's intact archive of the same head.
  const recordedKind = basename(dirname(row.archiveDir));
  for (const dir of dirs) archives.push(await verifiedArchive(dir, { flowId, head, manifestDigest: basename(dirname(dir)) === recordedKind ? row.archive.manifestDigest : null }));
  return { flowId, taskId: flow.taskId, head, evidence, archives };
}
const totals = entry => ({ ...entry, files: entry.archives.reduce((sum, archive) => sum + archive.files.length, 0), bytes: entry.archives.reduce((sum, archive) => sum + archive.bytes, 0) });

async function planArchiveDrop(store, { flowIds = [], completed = false }) {
  assert(completed || flowIds.length, 'name the flows with --id (repeatable) or select every eligible completed flow with --completed');
  assert(flowIds.every(id => typeof id === 'string' && id), 'flow ids must be non-empty');
  const config = store.meta('config', {}), root = store.meta('project').root, fetches = new Map();
  // One fetch per target, with the repository's scoped credentials in delivery mode.
  const fetched = (remote, target) => {
    const key = `${remote}\0${target}`;
    if (!fetches.has(key)) fetches.set(key, (async () => {
      try { await repositoryScope(config, () => workspaceGit(root, ['fetch', remote, target])); return { head: gitSync(root, ['rev-parse', `refs/remotes/${remote}/${target}`]) }; }
      catch (error) { return { error: String(error.message ?? error).split('\n')[0].slice(0, 300) }; }
    })());
    return fetches.get(key);
  };
  const rows = store.all('cleanup').filter(row => row.archive);
  const selected = [...new Set([...flowIds, ...(completed ? rows.filter(row => store.get('flow', row.id)?.state === 'completed' && !row.archiveDrop?.droppedAt).map(row => row.id) : [])])].sort();
  const entries = [], refused = [];
  for (const flowId of selected) {
    try { entries.push(totals(await entryFor(store, flowId, fetched))); }
    catch (error) { if (!(error instanceof Refused)) throw error; refused.push({ flowId, reason: error.message }); }
  }
  // What the operator reviews and the digest binds: the selection, every directory and file to
  // remove, and why each flow is eligible. The target's current tip is shown, not bound.
  const bound = { selection: { ids: [...new Set(flowIds)].sort(), completed }, entries: entries.map(({ evidence, ...entry }) => { const { targetHead, ...kept } = evidence ?? {}; return { ...entry, ...(evidence ? { evidence: kept } : {}) }; }), refused };
  const failedArchives = completed ? rows.filter(row => store.get('flow', row.id)?.state === 'failed' && !row.archiveDrop).length : undefined;
  return {
    ...bound, entries, flows: entries.length, files: entries.reduce((sum, entry) => sum + entry.files, 0), bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    ...(failedArchives ? { keptFailedFlowArchives: failedArchives } : {}),
    note: 'archives/workspace-commits/ is never touched. Apply removes exactly the listed directories, after verifying them again.',
    planDigest: digest(bound),
  };
}

export async function archiveDropPlan(stateDir, selection) {
  const store = new Store(stateDir);
  try { return await planArchiveDrop(store, selection); } finally { store.close(); }
}

export async function archiveDropApply(stateDir, { flowIds = [], completed = false, planDigest, note: reason, actor = 'operator', onBehalfOf }) {
  validateOnBehalfOf(onBehalfOf, actor);
  const store = new Store(stateDir);
  try {
    // Operator only: cleanup.archive-drop is not in DELEGABLE, so no policy can delegate it.
    operatorAuthority(store, { operation: 'cleanup.archive-drop', actor, onBehalfOf });
    note(reason);
    const unlock = await exclusive(store.meta('project').projectId, 'archive-drop');
    try {
      const plan = await planArchiveDrop(store, { flowIds, completed });
      assert(plan.planDigest === planDigest, 'the archives or their eligibility changed since the archive-drop plan; review a new plan');
      assert(plan.entries.length, 'the plan drops no archive');
      const dropped = [];
      for (const entry of plan.entries) {
        const dirs = entry.archives.map(archive => archive.dir), at = now();
        store.tx(() => { const row = store.need('cleanup', entry.flowId); store.put('cleanup', { ...row, archiveDrop: { status: 'dropping', planDigest, actor, note: reason, dirs: entry.resume ? row.archiveDrop.dirs : dirs, startedAt: entry.resume ? row.archiveDrop.startedAt : at } }); });
        for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
        const record = { flowId: entry.flowId, dirs, files: entry.files, bytes: entry.bytes, head: entry.head, ...(entry.archives[0]?.manifestDigest ? { manifestDigests: entry.archives.map(archive => archive.manifestDigest) } : {}), ...(entry.resume ? { resumed: true } : {}) };
        store.tx(() => {
          const row = store.need('cleanup', entry.flowId);
          store.put('cleanup', { ...row, archiveDrop: { ...row.archiveDrop, status: 'dropped', droppedAt: now(), bytesFreed: entry.bytes, files: entry.files } });
          store.event('cleanup.archive-dropped', { ...record, planDigest, actor, note: reason });
        });
        dropped.push(record);
      }
      const bytesFreed = dropped.reduce((sum, entry) => sum + entry.bytes, 0);
      store.event('cleanup.archives-dropped', { planDigest, flows: dropped.map(entry => entry.flowId), bytesFreed, actor, note: reason });
      return { status: 'dropped', planDigest, flows: dropped.length, bytesFreed, dropped, refused: plan.refused };
    } finally { await unlock(); }
  } finally { store.close(); }
}
