import { cliCommand } from '../core/install-layout.mjs';
import { execFileSync } from 'node:child_process';
import { NO_AUTO_MAINTENANCE, NO_PLANTED_COMMANDS } from '../core/git-options.mjs';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { matchesGlob } from '../core/globs.mjs';
import { assert, digest, now, note } from '../core/contracts.mjs';
import { Store } from '../core/store.mjs';
import { archiveAndRelease, git as workspaceGit, inspect, release, releaseArchived } from '../adapters/workspace/index.mjs';
import { withGitHubGitScope } from '../adapters/github/git.mjs';
import { operatorAuthority, validateOnBehalfOf } from '../core/delegation.mjs';

// Preserved cleanup of a failed or abandoned flow's owned workspace.
// plan (read-only) -> apply (operator, bound to the plan digest): archive the
// committed history, the complete working tree and the index; verify the archive
// restores byte-for-byte; record it; only then remove the worktree and branch.
// Remote branches and PRs are never touched.
// A completed flow whose automatic cleanup failed is also accepted: a workspace with
// no unsaved files is released exactly as the cleanup step would have released it;
// one with changed, untracked or ignored files (other than ignored files matching
// cleanup.excludeIgnored) is archived like a failed flow's.
const DEFAULT_MAX_BYTES = 2 * 1024 ** 3;
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const git = (cwd, args) => execFileSync('git', [...NO_AUTO_MAINTENANCE, ...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 600000 }).trim();
// Objects the index references (including conflict stages); staged content may
// exist in no commit, so the bundle alone would not carry it.
const indexListing = path => git(path, ['ls-files', '--stage']);
const indexObjects = listing => [...new Set(listing.split('\n').filter(Boolean).map(line => line.split(/\s+/)).filter(([mode]) => mode !== '160000').map(([, sha]) => sha))];
const syncPath = path => { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } };

// Every entry below root except the worktree's .git link: type, mode and content.
// Entries matching `exclude` (and everything below an excluded directory) are
// listed separately with their digests; they are not archived.
export function treeManifest(root, { exclude = () => false } = {}) {
  const entries = [], excluded = [], special = [];
  let bytes = 0, excludedBytes = 0;
  const walk = (relative, inExcluded) => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      if (!relative && name === '.git') continue;
      const path = relative ? `${relative}/${name}` : name, stat = lstatSync(join(root, path)), out = inExcluded || exclude(path) ? excluded : entries;
      if (stat.isSymbolicLink()) out.push({ path, type: 'symlink', target: readlinkSync(join(root, path)) });
      else if (stat.isDirectory()) { out.push({ path, type: 'dir', mode: stat.mode & 0o7777 }); walk(path, out === excluded); }
      else if (stat.isFile()) { if (out === excluded) excludedBytes += stat.size; else bytes += stat.size; out.push({ path, type: 'file', mode: stat.mode & 0o7777, size: stat.size, sha256: sha256File(join(root, path)) }); }
      else if (out === entries) special.push(path);
    }
  };
  walk('', false);
  return { entries, excluded, special, bytes, excludedBytes, digest: digest(entries), excludedDigest: digest(excluded) };
}
// cleanup.excludeIgnored globs (core/globs.mjs): wildcards match dot segments
// (node_modules/** covers node_modules/.pnpm/...), `[...]` and `{a,b}` are supported, and
// `dir/**` also matches the directory `dir` itself, as `git ls-files --directory` lists it.
const CLEANUP_GLOBS = Object.freeze({ extended: true, directory: true });
export const matchesExcludeIgnored = (path, patterns = []) => patterns.some(pattern => matchesGlob(pattern, path.replace(/\/$/, ''), CLEANUP_GLOBS));
// cleanup.excludeIgnored: a path is left out only if it matches a commissioned
// glob AND Git reports it ignored. Tracked and plain untracked files never are.
export function ignoredExcluder(root, patterns = []) {
  if (!patterns.length) return () => false;
  const ignored = new Set(execFileSync('git', [...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean).map(path => path.replace(/\/$/, '')));
  const isIgnored = path => { for (let current = path; current; current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '') if (ignored.has(current)) return true; return false; };
  return path => matchesExcludeIgnored(path, patterns) && isIgnored(path);
}
// Ignored files that are unsaved work: everything Git ignores except what the commissioned
// cleanup.excludeIgnored globs declare reproducible. Ordinary `git status` omits ignored
// files, so it alone never proves a workspace can be removed without archiving.
export function unsavedIgnored(root, patterns = []) {
  const ignored = execFileSync('git', [...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).split('\0').filter(Boolean);
  return ignored.filter(path => !matchesExcludeIgnored(path, patterns));
}

// The release a delivered flow's cleanup step performs: the owned head must be in the
// fetched target (merge method) or kept in a verified bundle (squash and rebase).
// `guard` (optional) re-checks eligibility after the fetch, immediately before removal.
export async function releaseDeliveredWorkspace({ root, stateDir, config, workspace, target, results, mergeAuthorization, guard }) {
  assert(results?.merge?.merged === true || results?.['satisfied-record']?.proven === true, 'proven outcome required before cleanup');
  const remote = config.repository?.remote ?? 'origin';
  target ??= config.repository?.target;
  await workspaceGit(root, ['fetch', remote, target]);
  await guard?.();
  // Operator decision (2026-11-15): normal cleanup still removes ignored files (usually
  // regenerable build output) but records what went, so nothing disappears unseen.
  const ignoredDeleted = deletedIgnoredSummary(workspace?.path, config.cleanup?.excludeIgnored ?? []);
  const mergeMethod = results.merge?.mergeMethod ?? config.repository?.mergeMethod ?? 'merge';
  const released = await (results.merge?.merged === true && mergeMethod !== 'merge'
    ? archiveAndRelease({ workspace, archiveDir: join(stateDir, 'archives', 'workspace-commits'), expectedHead: results.merge.expectedHead ?? mergeAuthorization?.identity.head })
    : release({ workspace, preservation: { mergedInto: `${remote}/${target}` }, dryRun: false }));
  return ignoredDeleted ? { ...released, ignoredDeleted } : released;
}
// Ignored paths (directories collapsed) outside cleanup.excludeIgnored, bounded for evidence.
const IGNORED_LIST_LIMIT = 100;
function deletedIgnoredSummary(path, patterns) {
  if (!path || !existsSync(path)) return null;
  let paths;
  try { paths = execFileSync('git', [...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { cwd: path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean); }
  catch (error) { return { count: null, paths: [], error: String(error.message).slice(0, 300) }; }
  // Git also lists a directory whose contents are all ignored and then lists those contents
  // (apps/ when apps/web/node_modules/ is all it holds); only the entries themselves count.
  const containers = new Set(paths.flatMap(entry => { const parts = entry.replace(/\/$/, '').split('/'); return parts.slice(1).map((_, at) => parts.slice(0, at + 1).join('/')); }));
  const kept = paths.filter(entry => !containers.has(entry.replace(/\/$/, '')) && !matchesExcludeIgnored(entry, patterns));
  if (!kept.length) return null;
  return { count: kept.length, paths: kept.slice(0, IGNORED_LIST_LIMIT), ...(kept.length > IGNORED_LIST_LIMIT ? { truncated: true } : {}) };
}
// Delivery-mode Git runs with the configured account's scoped credentials, as in an attempt.
const repositoryScope = (config, fn) => config.mode === 'delivery' ? withGitHubGitScope(config.repository, fn) : fn();
const releaseFlow = (root, stateDir, config, flow, guard) => repositoryScope(config, () => releaseDeliveredWorkspace({ root, stateDir, config, workspace: flow.workspace, target: flow.target, results: flow.results, mergeAuthorization: flow.mergeAuthorization, guard }));
const provenOutcome = flow => flow.results?.merge?.merged === true || flow.results?.['satisfied-record']?.proven === true;
const unsettled = (store, flowId) => store.by('attempt', 'flowId', flowId).some(a => !a.settledAt && !['passed', 'failed', 'not-dispatched', 'aborted'].includes(a.status));
export const cleanupObligationId = flowId => `${flowId}:cleanup`;
const cleanupNoticeId = flowId => `cleanup-notice:${flowId}`;
// How an operator finishes a completed flow's cleanup by hand.
// cli: the project's CLI command (cliCommand(project.root)), which names its install prefix.
export const cleanupCommand = (flowId, cli = 'node factory/cli.mjs') => `${cli} cleanup plan --state <state> --id ${flowId}, then ${cli} cleanup apply --actor operator --state <state> --id ${flowId} --digest <planDigest> --note "<why>"`;

// The cleanup a completed flow still owes is done: clear the flag and close its to-do and notice.
function settleCleanupPending(store, flowId, { actor, how }) {
  const flow = store.need('flow', flowId);
  if (flow.cleanupPending) { delete flow.cleanupPending; flow.cleanupResolved = { at: now(), actor, how }; store.put('flow', flow); store.event('flow.cleanup-resolved', { flowId, actor, how }); }
  const obligation = store.get('obligation', cleanupObligationId(flowId));
  if (obligation && obligation.status === 'pending') store.put('obligation', { ...obligation, status: 'passed', resolvedAt: now(), resolution: how });
  const notice = store.get('inbox', cleanupNoticeId(flowId));
  if (notice?.status === 'open') { store.put('inbox', { ...notice, status: 'superseded', supersededReason: `workspace cleanup finished (${how})`, supersededBy: actor, version: notice.version + 1 }); store.event('inbox.superseded', { inboxId: notice.id, flowId, reason: 'workspace cleanup finished' }); }
  // The completion notice said cleanup was outstanding; it now says it finished.
  for (const completion of store.by('inbox', 'flowId', flowId).filter(row => row.cleanupOutstanding && row.status === 'open')) {
    const at = completion.context.indexOf(CLEANUP_OUTSTANDING_HEADING);
    const context = `${at >= 0 ? completion.context.slice(0, at) : completion.context}\n\nCleanup finished: the owned workspace ${flow.workspace?.path} and branch ${flow.workspace?.branch} were released (${how}).`;
    store.put('inbox', { ...completion, title: completion.title.replace(/ \(cleanup outstanding\)$/, ''), context, cleanupOutstanding: false, version: (completion.version ?? 1) + 1, updatedAt: now() });
    store.event('inbox.updated', { inboxId: completion.id, flowId, reason: 'workspace cleanup finished' });
  }
}
// Must match the paragraph flowNotice (core/project.mjs) appends to a completion notice.
const CLEANUP_OUTSTANDING_HEADING = '\n\nCleanup is outstanding:';

// Operations loop: a completed flow whose cleanup step failed (for example a fetch that
// lost a race) is retried with bounded backoff. After the last retry fails it becomes a
// visible operator to-do and notice that name the workspace, branch and finishing command.
// Each retry takes the flow's cleanup lock, then plans exactly as `cleanup plan` does, from a
// fresh read of the store and the workspace: any refusal there (another flow or plan using
// the workspace, leases, live attempts, ownership, no proven outcome) is a failed retry. Only
// a plan in `release` mode is carried out; a workspace holding unsaved work, ignored files
// included, is never archived or deleted automatically and goes to the operator at once.
export const CLEANUP_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000, 30 * 60_000]);
class NeedsOperator extends Error {}
export async function retryPendingCleanups(store, { nowMs = Date.now(), releaseWorkspace = releaseFlow } = {}) {
  const config = store.meta('config', {}), results = [];
  for (const candidate of store.live('flow').filter(f => f.state === 'completed' && f.cleanupPending && f.workspace?.manifestPath)) {
    const retry = candidate.cleanupRetry ?? { attempts: 0 };
    if (retry.attempts >= CLEANUP_RETRY_DELAYS_MS.length) continue;
    const since = Date.parse(retry.lastAt ?? candidate.cleanupFailure?.at ?? candidate.finishedAt ?? '');
    if (Number.isFinite(since) && nowMs - since < CLEANUP_RETRY_DELAYS_MS[retry.attempts]) continue;
    if (unsettled(store, candidate.id) || !provenOutcome(candidate)) continue;
    let unlock;
    try { unlock = await exclusive(store.meta('project').projectId, candidate.id); } catch { continue; }
    try {
      const plan = await planCleanup(store, candidate.id);
      if (plan.mode !== 'release') throw new NeedsOperator(`the workspace holds unsaved work (${plan.changedOrUntracked} changed or untracked, ${plan.unsavedIgnored} ignored files), which the factory never archives or deletes automatically`);
      const flow = store.need('flow', candidate.id);
      const released = await releaseWorkspace(store.meta('project').root, store.stateDir, config, flow, () => recheckRelease(store, flow, plan));
      store.tx(() => {
        const flow = store.need('flow', candidate.id);
        flow.cleanupRetry = { ...retry, attempts: retry.attempts + 1, lastAt: new Date(nowMs).toISOString(), succeededAt: now() };
        flow.workspaceReleased = { at: now(), actor: 'factory', note: 'automatic cleanup retry', head: released.head ?? null }; store.put('flow', flow);
        store.event('cleanup.retried', { flowId: flow.id, attempt: flow.cleanupRetry.attempts, released: true });
        settleCleanupPending(store, flow.id, { actor: 'factory', how: 'automatic retry' });
      });
      results.push({ flowId: candidate.id, released: true });
    } catch (error) {
      const reason = String(error.message ?? error).slice(0, 2000), held = error instanceof NeedsOperator;
      store.tx(() => {
        const flow = store.need('flow', candidate.id);
        flow.cleanupRetry = { attempts: held ? CLEANUP_RETRY_DELAYS_MS.length : retry.attempts + 1, lastAt: new Date(nowMs).toISOString(), lastError: reason, ...(held ? { heldForOperator: true } : {}) }; store.put('flow', flow);
        store.event('cleanup.retried', { flowId: flow.id, attempt: retry.attempts + 1, released: false, reason });
        if (flow.cleanupRetry.attempts >= CLEANUP_RETRY_DELAYS_MS.length) raiseCleanupObligation(store, flow, reason, { held, failures: retry.attempts + 1 });
      });
      results.push({ flowId: candidate.id, released: false, reason, ...(held ? { held: true } : {}) });
    } finally { await unlock(); }
  }
  return results;
}
// After the fetch, immediately before removal: nothing may have started using the workspace
// and no unsaved ignored file may have appeared. release() itself re-checks leases and changes.
function recheckRelease(store, flow, plan) {
  assertNoOtherUsers(store, flow.id, flow.workspace.path);
  if (!plan.reconcile && existsSync(flow.workspace.path)) assert(!unsavedIgnored(flow.workspace.path, plan.excludeIgnored ?? []).length, 'ignored files appeared in the workspace since the cleanup plan; review a new plan');
}
function raiseCleanupObligation(store, flow, reason, { held = false, failures = CLEANUP_RETRY_DELAYS_MS.length } = {}) {
  const where = `workspace ${flow.workspace.path} and branch ${flow.workspace.branch}`, command = cleanupCommand(flow.id, cliCommand(store.meta('project')?.root));
  const text = held
    ? `The flow completed, but its owned ${where} were not released automatically: ${reason}. Nothing remote is affected. Review the workspace, then finish it with ${command}; the plan archives the unsaved files before the workspace is removed.`
    : `The flow completed, but cleanup of its owned ${where} failed ${failures + 1} times (last: ${reason}). Nothing remote is affected. Inspect the cause, then finish it with ${command}.`;
  if (!store.get('obligation', cleanupObligationId(flow.id))) store.put('obligation', { id: cleanupObligationId(flow.id), flowId: flow.id, title: `Finish cleanup of the completed flow's ${where}`, text, evidence: reason, command, status: 'pending', approved: false, owner: 'operator', createdAt: now() });
  if (!store.get('inbox', cleanupNoticeId(flow.id))) store.put('inbox', { id: cleanupNoticeId(flow.id), kind: 'notice', status: 'open', version: 1, role: 'operator', createdBy: 'factory', flowId: flow.id, taskId: flow.taskId, title: `${flow.taskSnapshot?.title ?? flow.taskId}: workspace cleanup needs an operator`, context: text, createdAt: now() });
  store.event('cleanup.escalated', { flowId: flow.id, path: flow.workspace.path, branch: flow.workspace.branch, reason, held });
}

function flowWorkspace(store, flowId) {
  const flow = store.need('flow', flowId);
  assert(['failed', 'completed'].includes(flow.state), 'only failed, abandoned or completed flows can be cleaned up here; stop and abandon the flow first');
  if (flow.state === 'completed') assert(provenOutcome(flow), 'a completed flow\'s workspace is cleaned up here only after its proven merge or recorded satisfied outcome');
  assert(flow.workspace?.manifestPath, 'flow has no owned workspace');
  assert(!flow.workspaceReleased, 'flow workspace already released');
  assert(store.by('attempt', 'flowId', flowId).every(a => a.settledAt || ['passed', 'failed', 'not-dispatched', 'aborted'].includes(a.status)), 'reconcile this flow\'s unresolved attempts first');
  assertNoOtherUsers(store, flowId, flow.workspace.path);
  return flow;
}
// Ownership may have passed to a successor flow or a planning cache.
function assertNoOtherUsers(store, flowId, path) {
  for (const other of store.live('flow')) if (other.id !== flowId && !['completed', 'failed'].includes(other.state) && [other.workspace?.path, other.preparedPlanWorkspace?.path].includes(path)) throw new Error(`workspace is in use by flow ${other.id}`);
  for (const plan of store.all('plan')) if (plan.workspace?.path === path && ['ready', 'consumed'].includes(plan.status) && plan.flowId !== flowId) throw new Error(`workspace is referenced by the ${plan.status} plan for ${plan.id}`);
}

export async function cleanupPlan(stateDir, flowId) {
  const store = new Store(stateDir);
  try { return await planCleanup(store, flowId); } finally { store.close(); }
}
// The one eligibility and mode decision, shared by `cleanup plan` and the automatic retry.
async function planCleanup(store, flowId) {
  {
    const flow = flowWorkspace(store, flowId), config = store.meta('config', {});
    // A release interrupted after the worktree was removed is finished by the same release.
    if (flow.state === 'completed' && !existsSync(flow.workspace.path)) {
      const manifest = JSON.parse(readFileSync(flow.workspace.manifestPath, 'utf8'));
      assert(['releasing', 'released'].includes(manifest.status) && manifest.cleanup?.head, 'workspace missing without a recorded release');
      const plan = { flowId, taskId: flow.taskId, outcome: 'completed', mode: 'release', reconcile: true, ownershipDigest: flow.workspace.ownershipDigest, path: flow.workspace.path, branch: manifest.branch, head: manifest.cleanup.head, dirty: false, cleanupPending: flow.cleanupPending === true, blockers: [], remote: 'left untouched' };
      return { ...plan, planDigest: digest(plan) };
    }
    const current = await inspect({ workspace: flow.workspace });
    assert(!current.released, 'workspace already released');
    assert(!current.leases?.length, 'workspace has active leases');
    const pr = flow.results?.publish?.number ?? null, excludeIgnored = config.cleanup?.excludeIgnored ?? [];
    // A completed workspace with no changed, untracked or unsaved ignored file is released as
    // the cleanup step does; ignored files matching cleanup.excludeIgnored are reproducible.
    const unsaved = flow.state === 'completed' ? unsavedIgnored(flow.workspace.path, excludeIgnored).length : 0;
    if (flow.state === 'completed' && !current.dirty && !unsaved) {
      const plan = { flowId, taskId: flow.taskId, outcome: 'completed', mode: 'release', ownershipDigest: flow.workspace.ownershipDigest, path: flow.workspace.path, branch: current.branch, head: current.head, dirty: false, unsavedIgnored: 0, excludeIgnored, cleanupPending: flow.cleanupPending === true, blockers: [], remote: pr ? `PR #${pr} and its remote branch are left untouched` : 'no published PR' };
      return { ...plan, planDigest: digest(plan) };
    }
    const tree = treeManifest(flow.workspace.path, { exclude: ignoredExcluder(flow.workspace.path, excludeIgnored) }), maxBytes = config.cleanup?.maxArchiveBytes ?? DEFAULT_MAX_BYTES;
    const ignored = git(flow.workspace.path, ['status', '--porcelain=v1', '--ignored', '--untracked-files=all']).split('\n').filter(line => line.startsWith('!! ')).length;
    const plan = {
      flowId, taskId: flow.taskId, ...(flow.state === 'completed' ? { outcome: 'completed', mode: 'archive', unsavedIgnored: unsaved } : {}), ownershipDigest: flow.workspace.ownershipDigest, path: flow.workspace.path, branch: current.branch, head: current.head,
      dirty: current.dirty, changedOrUntracked: current.status ? current.status.split('\n').length : 0, ignored, files: tree.entries.filter(e => e.type === 'file').length, bytes: tree.bytes, treeDigest: tree.digest,
      excludeIgnored, excludedFiles: tree.excluded.filter(e => e.type === 'file').length, excludedBytes: tree.excludedBytes, excludedDigest: tree.excludedDigest,
      blockers: [...(tree.special.length ? [`unsupported special files: ${tree.special.slice(0, 5).join(', ')}`] : []), ...(tree.bytes > maxBytes ? [`working tree is ${tree.bytes} bytes, above cleanup.maxArchiveBytes ${maxBytes}`] : [])],
      remote: pr ? `PR #${pr} and its remote branch are left untouched` : 'no published PR',
    };
    return { ...plan, planDigest: digest(plan) };
  }
}

async function exclusive(projectId, flowId) {
  const lock = createServer();
  await new Promise((done, reject) => { lock.once('error', () => reject(new Error('another cleanup of this flow is running'))); lock.listen(`\0factotum-cleanup-${projectId}-${flowId}`, done); });
  return () => new Promise(done => lock.close(done));
}

export async function cleanupApply(stateDir, { flowId, planDigest, note: reason, actor = 'operator', onBehalfOf }) {
  validateOnBehalfOf(onBehalfOf, actor);
  { const store = new Store(stateDir); try { operatorAuthority(store, { operation: 'cleanup.apply', actor, onBehalfOf }); } finally { store.close(); } }
  note(reason);
  const resumed = await resumeCleanup(stateDir, flowId);
  if (resumed) return resumed;
  const plan = await cleanupPlan(stateDir, flowId);
  assert(plan.planDigest === planDigest, 'workspace changed since the cleanup plan; review a new plan');
  assert(!plan.blockers.length, plan.blockers.join('; '));
  const store = new Store(stateDir), unlock = await exclusive(store.meta('project').projectId, flowId);
  try {
    if (plan.mode === 'release') {
      const flow = store.need('flow', flowId), released = await releaseFlow(store.meta('project').root, stateDir, store.meta('config', {}), flow, () => recheckRelease(store, flow, plan));
      return store.tx(() => {
        const current = store.need('flow', flowId);
        current.workspaceReleased = { at: now(), actor, note: reason, head: plan.head }; store.put('flow', current);
        const row = { id: flowId, status: 'released', mode: 'release', planDigest, actor, ...(onBehalfOf ? { onBehalfOf } : {}), note: reason, releasedAt: now(), release: released }; store.put('cleanup', row);
        store.event('cleanup.released', { flowId, head: plan.head, actor, mode: 'release' });
        settleCleanupPending(store, flowId, { actor, how: 'cleanup apply' }); return row;
      });
    }
    const flow = store.need('flow', flowId), dir = join(stateDir, 'archives', flow.state === 'completed' ? 'completed-workspaces' : 'failed-workspaces', digest({ flowId, ownership: plan.ownershipDigest }).slice(0, 32));
    store.tx(() => { store.put('cleanup', { id: flowId, status: 'archiving', planDigest, actor, ...(onBehalfOf ? { onBehalfOf } : {}), note: reason, archiveDir: dir, startedAt: now() }); store.event('cleanup.started', { flowId, planDigest, actor, ...(onBehalfOf ? { onBehalfOf } : {}) }); });
    const archive = archiveWorkspace(flow.workspace.path, dir, plan);
    store.tx(() => { store.put('cleanup', { ...store.need('cleanup', flowId), status: 'archived', archive }); store.event('cleanup.archived', { flowId, archiveDir: dir }); });
    // Nothing may have changed between archiving and removal.
    const after = treeManifest(flow.workspace.path, { exclude: ignoredExcluder(flow.workspace.path, plan.excludeIgnored) });
    assert(after.digest === plan.treeDigest && after.excludedDigest === plan.excludedDigest, 'workspace changed after archiving; the archive is kept and the workspace left in place');
    const released = await releaseArchived({ workspace: flow.workspace, expectedHead: plan.head, archive: { dir, manifestDigest: archive.manifestDigest } });
    return store.tx(() => {
      const current = store.need('flow', flowId);
      current.workspaceReleased = { at: now(), actor, note: reason, archiveDir: dir, head: plan.head }; store.put('flow', current);
      const row = { ...store.need('cleanup', flowId), status: 'released', releasedAt: now(), release: released }; store.put('cleanup', row);
      store.event('cleanup.released', { flowId, archiveDir: dir, head: plan.head, actor }); settleCleanupPending(store, flowId, { actor, how: 'cleanup apply' }); return row;
    });
  } finally { await unlock(); store.close(); }
}

// A cleanup interrupted after its archive was verified finishes the removal
// instead of planning again against a partly removed workspace.
async function resumeCleanup(stateDir, flowId) {
  const store = new Store(stateDir);
  try {
    const row = store.get('cleanup', flowId), flow = store.need('flow', flowId);
    if (!row || row.status === 'released' || !row.archive || existsSync(flow.workspace.path)) return null;
    const released = await releaseArchived({ workspace: flow.workspace, expectedHead: row.archive.head, archive: { dir: row.archiveDir, manifestDigest: row.archive.manifestDigest } });
    return store.tx(() => {
      const current = store.need('flow', flowId);
      current.workspaceReleased = { at: now(), actor: row.actor, note: row.note, archiveDir: row.archiveDir, head: row.archive.head, reconciled: true }; store.put('flow', current);
      const done = { ...row, status: 'released', releasedAt: now(), release: released, reconciled: true }; store.put('cleanup', done);
      store.event('cleanup.released', { flowId, archiveDir: row.archiveDir, head: row.archive.head, reconciled: true }); settleCleanupPending(store, flowId, { actor: row.actor, how: 'cleanup apply' }); return done;
    });
  } finally { store.close(); }
}

// Write bundle + tree archive + index, then prove a fresh restore reproduces the tree.
export function archiveWorkspace(path, dir, plan) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert(existing.head === plan.head && existing.treeDigest === plan.treeDigest, 'a different archive already exists for this workspace');
    verifyArchive(dir, existing); const { excluded = [], ...summary } = existing; return { ...summary, excludedEntries: excluded.length };
  }
  const bundle = join(dir, 'history.bundle'), tree = join(dir, 'tree.tar'), index = join(dir, 'index'), objects = join(dir, 'index-objects.pack');
  for (const file of [bundle, tree, index, objects]) rmSync(file, { force: true });
  git(path, ['bundle', 'create', bundle, `refs/heads/${plan.branch}`]);
  // Archive exactly the planned entries; excluded ignored paths are only listed.
  const contents = treeManifest(path, { exclude: ignoredExcluder(path, plan.excludeIgnored) });
  assert(contents.digest === plan.treeDigest && contents.excludedDigest === plan.excludedDigest, 'workspace changed since the cleanup plan');
  execFileSync('tar', ['--create', '--format=posix', '--numeric-owner', '--no-recursion', '--null', '--file', tree, '-C', path, '--files-from=-'], { input: contents.entries.map(entry => `./${entry.path}`).join('\0') + (contents.entries.length ? '\0' : ''), stdio: ['pipe', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  copyFileSync(git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']), index);
  const listing = indexListing(path);
  writeFileSync(objects, execFileSync('git', [...NO_AUTO_MAINTENANCE, '-c', 'core.hooksPath=/dev/null', 'pack-objects', '--stdout'], { cwd: path, input: indexObjects(listing).join('\n') + '\n', maxBuffer: 2 * 1024 ** 3, timeout: 600000 }));
  // In-progress operation markers are recorded for inspection; restore does not resume them.
  const inProgress = Object.fromEntries(['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'MERGE_MSG'].map(name => [name, git(path, ['rev-parse', '--path-format=absolute', '--git-path', name])]).filter(([, file]) => existsSync(file)).map(([name, file]) => [name, readFileSync(file, 'utf8').slice(0, 4000)]));
  const manifest = { version: 1, flowId: plan.flowId, head: plan.head, branch: plan.branch, treeDigest: plan.treeDigest, indexDigest: digest(listing), inProgress, excludeIgnored: plan.excludeIgnored ?? [], excluded: contents.excluded, files: { bundle: sha256File(bundle), tree: sha256File(tree), index: sha256File(index), objects: sha256File(objects) }, createdAt: now() };
  verifyArchive(dir, manifest);
  for (const file of [bundle, tree, index, objects]) syncPath(file);
  const temporary = `${manifestPath}.tmp`; writeFileSync(temporary, JSON.stringify({ ...manifest, manifestDigest: digest(manifest) }, null, 2)); syncPath(temporary); renameSync(temporary, manifestPath); syncPath(dir);
  const { excluded, ...summary } = manifest;
  return { ...summary, excludedEntries: excluded.length, manifestDigest: digest(manifest) };
}
function verifyArchive(dir, manifest) {
  for (const [name, file] of [['bundle', 'history.bundle'], ['tree', 'tree.tar'], ['index', 'index'], ['objects', 'index-objects.pack']]) assert(sha256File(join(dir, file)) === manifest.files[name], `archive ${file} does not match its manifest`);
  const scratch = join(dir, 'verify'); rmSync(scratch, { recursive: true, force: true });
  try {
    const restored = restoreArchive(dir, scratch, manifest);
    assert(restored.treeDigest === manifest.treeDigest, 'restored working tree differs from the workspace');
    assert(restored.indexDigest === manifest.indexDigest, 'restored index differs from the workspace');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// Restore into a new standalone repository: history from the bundle, the exact
// working tree (including untracked and ignored files) and the staged index.
export function restoreArchive(dir, target, manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))) {
  assert(!existsSync(target), 'restore target must not exist');
  mkdirSync(dirname(target), { recursive: true });
  git(dirname(target), ['clone', '--quiet', '--no-checkout', join(dir, 'history.bundle'), target]);
  git(target, ['checkout', '--quiet', '-B', manifest.branch, manifest.head]);
  for (const name of readdirSync(target)) if (name !== '.git') rmSync(join(target, name), { recursive: true, force: true });
  execFileSync('tar', ['--extract', '--file', join(dir, 'tree.tar'), '--same-permissions', '-C', target], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
  execFileSync('git', [...NO_AUTO_MAINTENANCE, '-c', 'core.hooksPath=/dev/null', 'unpack-objects', '-q'], { cwd: target, input: readFileSync(join(dir, 'index-objects.pack')), timeout: 600000 });
  copyFileSync(join(dir, 'index'), join(target, '.git', 'index'));
  const listing = indexListing(target), missing = execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'cat-file', '--batch-check'], { cwd: target, input: indexObjects(listing).join('\n') + '\n', encoding: 'utf8' }).split('\n').filter(line => line.endsWith(' missing'));
  assert(!missing.length, `restored index references missing objects: ${missing.slice(0, 3).join(', ')}`);
  const excluded = manifest.excluded?.length ?? 0;
  return { target, head: git(target, ['rev-parse', 'HEAD']), treeDigest: treeManifest(target).digest, indexDigest: digest(listing), excluded, ...(excluded ? { note: `${excluded} ignored paths matching cleanup.excludeIgnored (${manifest.excludeIgnored.join(', ')}) were not archived; rerun the project's setup step to recreate them. manifest.json lists each with its digest.` } : {}) };
}
export function restoreFlowArchive(stateDir, flowId, target) {
  const store = new Store(stateDir);
  try { const row = store.need('cleanup', flowId); assert(row.archive, 'no archive recorded for this flow'); return restoreArchive(row.archiveDir, target); } finally { store.close(); }
}
