import { prepareGitInvocation } from '../github/git.mjs';
import { retryRefLockedFetch } from '../../core/git-options.mjs';
import { VerifiedObjects, assertNoHistoryRewrites } from '../../core/verified-git.mjs';
import { adoptionRefNames } from '../../core/adoption-ref-names.mjs';
import { spawn } from 'node:child_process';
import { createReadStream, readFileSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rename, realpath, lstat, access, open, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const exists = async path => access(path).then(() => true, () => false);
// Every factory Git call in an owned workspace or the project repository goes through here;
// a fetch that loses a ref-lock race with a concurrent fetch is repeated (bounded).
export async function git(cwd, args, options = {}) {
  return retryRefLockedFetch(args, () => gitOnce(cwd, args, options));
}
// timeoutMs bounds one invocation. Git stays in the caller's process group, so whatever ends
// the caller's group (the supervisor stopping or timing out an attempt) ends Git with it. When
// the time passes, Git and its descendants (a transport helper, ssh, a credential helper) are
// terminated by process ID, then killed after GIT_KILL_GRACE_MS, so nothing of the invocation
// outlives it. The call then fails with `timedOut`, or with allowFailure resolves with code null
// and timedOut: true.
export const GIT_KILL_GRACE_MS = 1000;
// A live process's start time, which with its ID names exactly that process (IDs are reused).
const startTime = pid => { try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); return ['Z', 'X'].includes(fields[0]) ? null : fields[19]; } catch { return null; } };
// A process and everything below it, read from /proc: {pid, startTime} each. Where /proc is not
// available only the process itself is listed.
export function processTree(pid) {
  const parents = new Map();
  try { for (const entry of readdirSync('/proc')) { if (!/^\d+$/.test(entry)) continue; try { const stat = readFileSync(`/proc/${entry}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); if (!['Z', 'X'].includes(fields[0])) parents.set(Number(entry), Number(fields[1])); } catch { /* it ended meanwhile */ } } } catch { /* no /proc */ }
  const tree = [pid], seen = new Set(tree);
  for (let i = 0; i < tree.length; i++) for (const [child, parent] of parents) if (parent === tree[i] && !seen.has(child)) { seen.add(child); tree.push(child); }
  return tree.map(member => ({ pid: member, startTime: startTime(member) })).filter(member => member.pid === pid || member.startTime !== null);
}
// Signal exactly those processes: one whose ID now belongs to another process is left alone.
function signalTree(tree, signal) { for (const member of tree) { if (member.startTime !== null && startTime(member.pid) !== member.startTime) continue; try { process.kill(member.pid, signal); } catch { /* gone */ } } }
async function gitOnce(cwd, args, { allowFailure = false, timeoutMs } = {}) {
  const prepared = await prepareGitInvocation(args, { cwd, env: process.env }), bounded = Number.isFinite(timeoutMs) && timeoutMs > 0;
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', ['-C', cwd, ...prepared.args], { env: { ...prepared.env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, killTimer, tree = [];
    // The tree is read while Git is alive (its children are reparented when it exits), and again
    // before the kill, for anything started in between.
    const stop = () => { timedOut = true; tree = processTree(child.pid); signalTree(tree, 'SIGTERM'); killTimer = setTimeout(() => { const known = new Set(tree.map(member => member.pid)); tree = [...tree, ...processTree(child.pid).filter(member => !known.has(member.pid))]; signalTree(tree, 'SIGKILL'); }, GIT_KILL_GRACE_MS); };
    const timer = bounded ? setTimeout(stop, timeoutMs) : null;
    child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      // Git has ended; a helper that outlived it (and held no output pipe) is killed here rather than after the grace.
      if (timedOut) { clearTimeout(killTimer); signalTree(tree.filter(member => member.pid !== child.pid), 'SIGKILL'); if (allowFailure) resolveResult({ code: null, stdout: stdout.trimEnd(), stderr, timedOut: true }); else reject(Object.assign(new Error(`git ${args[0]} timed out after ${timeoutMs} ms`), { code: null, stderr, timedOut: true })); return; }
      code === 0 || allowFailure ? resolveResult({ code, stdout: stdout.trimEnd(), stderr }) : reject(Object.assign(new Error(`git ${args[0]} failed: ${stderr.trim()}`), { code, stderr }));
    });
  });
}
const value = async (cwd, args) => (await git(cwd, args)).stdout;
const durable = async (path, data, flags = 'w') => {
  const file = await open(path, flags, 0o600);
  try { await file.writeFile(JSON.stringify(data, null, 2)); await file.sync(); } finally { await file.close(); }
};
const syncDirectory = async path => { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } };
const atomic = async (path, data) => { const temporary = `${path}.${randomUUID()}.tmp`; await durable(temporary, data); await rename(temporary, path); await syncDirectory(path); };
const immutable = manifest => ({ version: manifest.version, projectId: manifest.projectId, flowId: manifest.flowId, root: manifest.root, path: manifest.path, branch: manifest.branch, base: manifest.base });

async function load(workspace) {
  assert(workspace?.manifestPath, 'owned workspace manifest required');
  assert(!(await lstat(workspace.manifestPath)).isSymbolicLink(), 'manifest may not be a symlink');
  const manifest = JSON.parse(await readFile(workspace.manifestPath, 'utf8'));
  assert(manifest.version === 1 && manifest.ownershipDigest === hash(immutable(manifest)), 'invalid ownership manifest');
  assert(workspace.ownershipDigest === manifest.ownershipDigest && workspace.path === manifest.path, 'workspace ownership mismatch');
  assert(resolve(manifest.path) === join(dirname(workspace.manifestPath), 'tree'), 'workspace outside ownership directory');
  if (await exists(manifest.path)) {
    assert((await realpath(manifest.path)) === manifest.path, 'workspace path redirected');
    const entries = await value(manifest.root, ['worktree', 'list', '--porcelain']);
    assert(entries.split('\n\n').some(entry => entry.includes(`worktree ${manifest.path}\n`) && entry.includes(`branch refs/heads/${manifest.branch}`)), 'Git does not confirm workspace ownership');
  }
  return manifest;
}

// Each workspace.setup command is bounded (dev.85 review): `workspace.setupTimeoutMs` from the
// project configuration, by default SETUP_TIMEOUT_MS (30 minutes), at most SETUP_TIMEOUT_MAX_MS.
// A command still running then is terminated with its descendants (SIGTERM, then SIGKILL after
// GIT_KILL_GRACE_MS, as for Git), and setup fails like a command that exited nonzero: the
// manifest stays "running", so the workspace needs inspecting before a retry.
export const SETUP_TIMEOUT_MS = 30 * 60_000, SETUP_TIMEOUT_MAX_MS = 4 * 3_600_000;
function runSetupCommand(command, cwd, timeoutMs) {
  return new Promise((done, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: 'ignore' });
    let timedOut = false, tree = [], killTimer;
    const timer = setTimeout(() => {
      timedOut = true; tree = processTree(child.pid); signalTree(tree, 'SIGTERM');
      killTimer = setTimeout(() => { const known = new Set(tree.map(member => member.pid)); tree = [...tree, ...processTree(child.pid).filter(member => !known.has(member.pid))]; signalTree(tree, 'SIGKILL'); }, GIT_KILL_GRACE_MS);
    }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) { clearTimeout(killTimer); signalTree(tree.filter(member => member.pid !== child.pid), 'SIGKILL'); reject(Object.assign(new Error(`workspace setup timed out after ${Math.round(timeoutMs / 1000)} s (${command[0]})`), { timedOut: true })); return; }
      code === 0 ? done() : reject(new Error(`workspace setup failed (${code})`));
    });
  });
}

export async function prepare({ root, stateDir, projectId, flowId, baseRef = 'HEAD', setup = [], setupTimeoutMs = SETUP_TIMEOUT_MS }) {
  assert(typeof projectId === 'string' && projectId && typeof flowId === 'string' && flowId, 'project and flow identity required');
  setupTimeoutMs ??= SETUP_TIMEOUT_MS;
  assert(Number.isSafeInteger(setupTimeoutMs) && setupTimeoutMs > 0 && setupTimeoutMs <= SETUP_TIMEOUT_MAX_MS, 'workspace setup timeout must be a positive number of milliseconds, at most four hours');
  root = await realpath(root); stateDir = resolve(stateDir);
  assert(stateDir !== root && !stateDir.startsWith(`${root}/`), 'runtime state must stay outside the project checkout');
  const key = hash({ projectId, flowId }).slice(0, 32);
  const directory = join(stateDir, 'workspaces', key), path = join(directory, 'tree'), manifestPath = join(directory, 'ownership.json');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert(await realpath(directory) === directory, 'workspace state path redirected');
  let manifest;
  if (await exists(manifestPath)) {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert(manifest.root === root && manifest.projectId === projectId && manifest.flowId === flowId, 'conflicting ownership identity');
  } else {
    const base = await value(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
    const foreignBranch = await git(root, ['show-ref', '--verify', `refs/heads/factotum/${key}`], { allowFailure: true });
    assert(foreignBranch.code !== 0 && !await exists(path), 'resources already exist without ownership manifest');
    manifest = { version: 1, projectId, flowId, root, path, branch: `factotum/${key}`, base, setupDigest: hash(setup), setupState: 'pending', status: 'preparing' };
    manifest.ownershipDigest = hash(immutable(manifest));
    // Exclusive creation fences another prepare of the same identity.
    await durable(manifestPath, manifest, 'wx'); await syncDirectory(manifestPath);
  }
  assert(manifest.setupDigest === hash(setup), 'setup changed for existing workspace');
  const workspace = { path, branch: manifest.branch, base: manifest.base, ownershipDigest: manifest.ownershipDigest, manifestPath };
  assert(!['releasing', 'released'].includes(manifest.status), 'cleanup workspace identity cannot be reused');
  if (!await exists(path)) {
    const ref = await git(root, ['show-ref', '--verify', `refs/heads/${manifest.branch}`], { allowFailure: true });
    if (ref.code === 0) {
      assert(ref.stdout.split(' ')[0] === manifest.base, 'partial preparation branch contains unaccounted work');
      await git(root, ['worktree', 'add', path, manifest.branch]);
    } else await git(root, ['worktree', 'add', '-b', manifest.branch, path, manifest.base]);
  }
  await load(workspace);
  assert(manifest.setupState !== 'running', 'setup outcome uncertain; inspect before retry');
  if (manifest.setupState !== 'complete') {
    manifest.setupState = 'running'; await atomic(manifestPath, manifest);
    for (const command of setup) {
      assert(Array.isArray(command) && command.length && command.every(item => typeof item === 'string'), 'setup must be trusted argv arrays');
      await runSetupCommand(command, path, setupTimeoutMs);
    }
    manifest.setupState = 'complete'; manifest.status = 'ready'; await atomic(manifestPath, manifest);
  }
  return { ...workspace, head: await value(path, ['rev-parse', 'HEAD']), setupDigest: manifest.setupDigest };
}

// Why an approved candidate cannot be adopted: one row per field that does not match, each with
// what the approval said, what was found and how to fix it. Thrown on `error.adoptionMismatch`.
export class AdoptionMismatch extends Error {
  constructor(number, mismatches, refs = []) {
    super(`approved PR candidate or target changed: ${mismatches.map(row => `${row.field} expected ${row.expected}, found ${row.found}`).join('; ')}`);
    this.adoptionMismatch = { number, mismatches, refs };
  }
}

// The private refs an adoption attempt fetches into the project checkout (core/adoption-ref-names.mjs;
// released after the flow ends, operations/adoption-refs.mjs).
export { adoptionRefNames } from '../../core/adoption-ref-names.mjs';

// The approved base is the target commit the operator approved the PR against. It must be in the
// target's history (equal to, or an ancestor of, the target tip fetched now from the configured
// remote), not compared with GitHub's cached `base.sha`, which lags after the author pushes; the
// flow integrates the current target and reviews and gates the result anyway. Ancestry is proven
// through hash-verified parents (core/verified-git.mjs) from the fetched target OID, in a repository
// without replace refs or grafts, so a substituted object cannot make an unrelated commit look
// like target history.
// attemptId names this attempt's private refs (a random one when not given); run replaces the Git runner (tests).
export async function adoptCandidate({ root, stateDir, projectId, flowId, attemptId = randomUUID(), number, expectedHead, expectedBase, forge, remote = 'origin', target, setup = [], run = git }) {
  const value = async (cwd, args) => (await run(cwd, args)).stdout, git_ = run;
  assert(Number.isSafeInteger(Number(number)) && Number(number) > 0, 'approved PR number required');
  assert(/^[a-f\d]{40,64}$/i.test(expectedHead || '') && /^[a-f\d]{40,64}$/i.test(expectedBase || ''), 'approved PR head and base required');
  assert(/^[a-z\d_.-]+$/i.test(remote), 'invalid approved remote');
  assert(typeof target === 'string' && target && !target.startsWith('-'), 'approved target required');
  await git_(root, ['check-ref-format', `refs/heads/${target}`]);
  const pr = await forge.readPR(Number(number));
  const mismatches = [];
  const state = pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state;
  if (state !== 'open') mismatches.push({ field: 'state', expected: 'open', found: state, fix: pr.draft ? 'mark it ready for review, then resume this flow' : 'only an open pull request can be adopted; abandon this flow (flow.abandon)' });
  const prTarget = pr.baseRef ?? pr.baseBranch;
  if (prTarget !== target) mismatches.push({ field: 'target', expected: target, found: prTarget ?? 'unknown', fix: `ask the author to retarget the pull request to ${target}, or start the flow with target ${prTarget}` });
  const { head: ref, target: targetRef } = adoptionRefNames({ projectId, flowId, attemptId }), refs = [];
  // The head row's cause is worded after the target is fetched (headCause), when it can be told.
  let headRow = null;
  if (pr.head !== expectedHead) mismatches.push(headRow = { field: 'head', expected: expectedHead, found: pr.head ?? 'unknown', fix: null });
  else {
    await git_(root, ['fetch', '--no-tags', remote, `refs/pull/${Number(number)}/head:${ref}`]);
    const fetched = await value(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    refs.push({ ref, oid: await value(root, ['rev-parse', '--verify', ref]) });
    if (fetched !== expectedHead) mismatches.push({ field: 'head', expected: expectedHead, found: `${fetched} (fetched refs/pull/${Number(number)}/head)`, fix: 'GitHub reported a different head from the one fetched; wait a moment and resume this flow' });
  }
  await git_(root, ['fetch', '--no-tags', remote, `+refs/heads/${target}:${targetRef}`]);
  const targetHead = await value(root, ['rev-parse', '--verify', targetRef]);
  refs.push({ ref: targetRef, oid: targetHead });
  if (headRow) headRow.fix = `${await headCause({ root, run, forge, number: Number(number), pr, expectedHead, target, targetHead })}; review head ${pr.head}, then abandon this flow (flow.abandon) and start a new one (flow.start) with candidate.head ${pr.head}`;
  let rewrites = null;
  try { assertNoHistoryRewrites(root, { shallow: false }); } catch (error) { rewrites = error.message; }
  if (rewrites) mismatches.push({ field: 'repository', expected: 'history Git shows as it is (no replace refs or grafts)', found: rewrites, fix: 'remove the replace refs or grafts file from the project checkout, then resume this flow' });
  else if (!new VerifiedObjects(root).reaches(targetHead, expectedBase)) mismatches.push({ field: 'base', expected: `a commit on ${target} (${expectedBase})`, found: `${target} is at ${targetHead} and ${expectedBase.slice(0, 12)} is not in its history (through verified parents)${pr.base ? `; GitHub reports base ${pr.base}` : ''}`, fix: `use a commit on ${target}, for example its current head ${targetHead} (git ls-remote ${remote} refs/heads/${target}); abandon this flow (flow.abandon) and start a new one (flow.start) with that candidate.base (in a shallow clone, the base can be on the target but below the clone's boundary: run git fetch --unshallow and resume)` });
  if (mismatches.length) throw new AdoptionMismatch(Number(number), mismatches, refs);
  const workspace = await prepare({ root, stateDir, projectId, flowId, baseRef: expectedHead, setup });
  assert(workspace.base === expectedHead, 'flow already owns a different candidate');
  return { workspace, originalPR: { number: Number(number), url: pr.url, head: pr.head, base: pr.base, approvedBase: expectedBase, targetHead }, adoptionRefs: refs };
}

// Why the approved head is not the pull request's head, as far as can be told (dev.84, H1): the
// approved commit is one of the pull request's earlier commits (said as observed, without guessing
// whether it moved after approval or an earlier commit was approved), or the approval named another commit (a commit of the target, or one the pull request never had). Only
// wording: every case is refused the same way. A read that fails gives the neutral wording.
async function headCause({ root, run, forge, number, pr, expectedHead, target, targetHead }) {
  let commits = null;
  if (typeof forge.readPRCommits === 'function' && Number.isSafeInteger(pr.commits) && pr.commits > 0 && pr.commits <= 250) {
    try { commits = await forge.readPRCommits(number, { expectedHead: pr.head, expectedCount: pr.commits }); } catch { commits = null; }
  }
  // The ancestry is observed; when the approval happened relative to the push is not (review fix 3).
  if (commits?.some(commit => commit.sha === expectedHead)) return `the approved commit ${expectedHead.slice(0, 12)} is an earlier commit of this pull request; its head is now ${String(pr.head).slice(0, 12)}`;
  let onTarget = false;
  try { await run(root, ['merge-base', '--is-ancestor', expectedHead, targetHead]); onTarget = true; } catch { onTarget = false; }
  if (onTarget) return `the approved head ${expectedHead.slice(0, 12)} is a commit on ${target}, not the pull request's head: the approval named another commit`;
  if (commits) return `the approved head ${expectedHead.slice(0, 12)} is not the pull request's head or one of its commits: the approval named another commit, or the pull request was force-pushed after approval`;
  return `the approved head is not the pull request's head (it may have moved since approval, or the approval named another commit)`;
}

export async function inspect({ workspace }) {
  const manifest = await load(workspace);
  if (manifest.status === 'released') return { owned: true, released: true, path: manifest.path };
  const head = await value(manifest.path, ['rev-parse', 'HEAD']);
  const branch = await value(manifest.path, ['symbolic-ref', '--short', 'HEAD']);
  assert(branch === manifest.branch, 'owned worktree branch changed');
  const status = await value(manifest.path, ['status', '--porcelain=v1', '--untracked-files=all']);
  const upstream = await git(manifest.path, ['rev-parse', '--verify', '@{upstream}'], { allowFailure: true });
  const unpushed = upstream.code !== 0 || (await value(manifest.path, ['rev-list', '--count', '@{upstream}..HEAD'])) !== '0';
  return { owned: true, head, branch, dirty: !!status, status, unpushed, setupState: manifest.setupState, leases: manifest.leases || [] };
}

export async function commit({ workspace, message, paths = ['.'] }) {
  const manifest = await load(workspace); await inspect({ workspace });
  assert(typeof message === 'string' && message.trim(), 'commit message required');
  assert(Array.isArray(paths) && paths.length && paths.every(path => typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..')), 'commit paths must stay in owned worktree');
  await git(manifest.path, ['add', '--', ...paths]);
  const staged = await git(manifest.path, ['diff', '--cached', '--quiet'], { allowFailure: true });
  // A merge in progress is concluded even when its resolution equals HEAD (the target's changes were
  // already there): the commit records both parents, so the integration is not left half done.
  const merging = (await git(manifest.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFailure: true })).code === 0;
  if (staged.code !== 0 || merging) await git(manifest.path, ['commit', ...(staged.code === 0 ? ['--allow-empty'] : []), '-m', message]);
  return { head: await value(manifest.path, ['rev-parse', 'HEAD']), committed: staged.code !== 0 || merging };
}

export async function integrateTarget({ workspace, remote = 'origin', target = 'main' }) {
  const manifest = await load(workspace); const before = await inspect({ workspace });
  assert(!before.dirty, 'cannot integrate with dirty worktree');
  assert(/^[a-z\d_.-]+$/i.test(remote) && typeof target === 'string' && !target.startsWith('-'), 'invalid approved remote or target');
  await git(manifest.path, ['check-ref-format', `refs/heads/${target}`]);
  await git(manifest.path, ['fetch', '--no-tags', remote, `refs/heads/${target}:refs/remotes/${remote}/${target}`]);
  const base = await value(manifest.path, ['rev-parse', `refs/remotes/${remote}/${target}`]);
  const result = await git(manifest.path, ['merge', '--no-edit', base], { allowFailure: true });
  return { base, head: await value(manifest.path, ['rev-parse', 'HEAD']), previousHead: before.head, conflicts: result.code !== 0, conflictedPaths: result.code === 0 ? [] : (await value(manifest.path, ['diff', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean) };
}

export async function push({ workspace, remote = 'origin', expectedHead }) {
  const manifest = await load(workspace); const current = await inspect({ workspace });
  assert(!current.dirty && (!expectedHead || current.head === expectedHead), 'push requires clean expected candidate');
  assert(/^[a-z\d_.-]+$/i.test(remote), 'invalid approved remote');
  await git(manifest.path, ['push', remote, `${current.head}:refs/heads/${manifest.branch}`]);
  await git(manifest.path, ['fetch', '--no-tags', remote, `refs/heads/${manifest.branch}:refs/remotes/${remote}/${manifest.branch}`]);
  await git(manifest.path, ['branch', `--set-upstream-to=${remote}/${manifest.branch}`, manifest.branch]);
  return { branch: manifest.branch, head: current.head, remote };
}

// Squash/rebase merges do not retain the original branch ancestry. Preserve the
// exact owned Git head independently before deleting its checkout or branch.
export async function archiveAndRelease({ workspace, archiveDir, expectedHead, dryRun = false }) {
  assert(/^[a-f\d]{40,64}$/i.test(expectedHead ?? ''), 'exact archived workspace head required');
  const manifest = await load(workspace), requested = resolve(archiveDir ?? '');
  assert(archiveDir && requested !== manifest.path && !requested.startsWith(manifest.path + '/'), 'archive directory must survive workspace deletion');
  await mkdir(requested, { recursive: true, mode: 0o700 });
  const directory = await realpath(requested);
  assert(directory === requested && directory !== manifest.path && !directory.startsWith(manifest.path + '/'), 'archive directory redirected');
  const archivePath = join(directory, `${hash({ ownershipDigest: manifest.ownershipDigest, expectedHead })}.bundle`), receiptPath = archivePath + '.json';
  const fileHash = async path => { const checksum=createHash('sha256');for await(const chunk of createReadStream(path))checksum.update(chunk);return checksum.digest('hex'); };
  const durableArchive = async () => {
    const file = await open(archivePath, 'r'); try { await file.sync(); } finally { await file.close(); }
    for (let current = directory;; current = dirname(current)) { const fd = await open(current, 'r'); try { await fd.sync(); } finally { await fd.close(); } if (dirname(current) === current) break; }
  };
  let receipt;
  if (await exists(receiptPath)) {
    assert(!(await lstat(receiptPath)).isSymbolicLink(), 'archive receipt redirected'); receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert(receipt.version === 1 && receipt.head === expectedHead && receipt.ownershipDigest === manifest.ownershipDigest && receipt.archivePath === archivePath && receipt.archiveDigest, 'archive receipt scope changed');
  }
  if (await exists(manifest.path)) {
    const current = await inspect({ workspace });
    assert(current.head === expectedHead && !current.dirty && !current.leases?.length, 'exact clean quiescent workspace required for archival');
  } else assert(receipt && ['releasing', 'released'].includes(manifest.status), 'missing workspace requires its durable archive receipt');
  if (!await exists(archivePath)) {
    assert(!receipt && await exists(manifest.path), 'recorded workspace archive missing');
    const temporary = `${archivePath}.${randomUUID()}.partial`;
    try { await git(manifest.path, ['bundle', 'create', temporary, manifest.branch]); await git(manifest.root, ['bundle', 'verify', temporary]); await rename(temporary, archivePath); }
    finally { await rm(temporary, { force: true }); }
  }
  assert(!(await lstat(archivePath)).isSymbolicLink(), 'workspace archive redirected');
  const headerFile=await open(archivePath,'r'),headerBuffer=Buffer.alloc(4096);let header;
  try{const {bytesRead}=await headerFile.read(headerBuffer,0,headerBuffer.length,0);header=headerBuffer.subarray(0,bytesRead).toString('utf8').split('\n\n')[0];}finally{await headerFile.close();}
  assert(!header.split('\n').some(line=>/^-[a-f\d]{40,64}(?: |$)/i.test(line)),'workspace archive must contain complete history without prerequisites');
  const archiveDigest = await fileHash(archivePath);
  if (receipt) assert(receipt.archiveDigest === archiveDigest, 'recorded workspace archive changed');
  assert((await value(manifest.root, ['bundle', 'list-heads', archivePath])).split('\n').some(line => line.split(' ')[0] === expectedHead), 'archive does not retain exact owned head');
  await git(manifest.root, ['bundle', 'verify', archivePath]);
  await durableArchive();
  if (!receipt) { receipt = { version: 1, ownershipDigest: manifest.ownershipDigest, head: expectedHead, archivePath, archiveDigest }; await atomic(receiptPath, receipt); }
  const result = await release({ workspace, preservation: { archivePath }, dryRun });
  return { ...result, archive: { ...receipt, receiptPath } };
}

export async function release({ workspace, preservation = {}, leases = [], openPR = false, unresolved = false, dryRun = true }) {
  const manifest = await load(workspace);
  if (manifest.status === 'released') return { released: true, reconciled: true };
  if (manifest.status === 'releasing' && !await exists(manifest.path)) {
    assert(!leases.length && !openPR && !unresolved, 'workspace has outstanding obligations');
    const branch = await git(manifest.root, ['show-ref', '--verify', `refs/heads/${manifest.branch}`], { allowFailure: true });
    if (branch.code === 0) {
      assert(branch.stdout.split(' ')[0] === manifest.cleanup.head, 'branch changed during cleanup');
      if (!dryRun) await git(manifest.root, ['branch', '-D', manifest.branch]);
    }
    if (!dryRun) { manifest.status = 'released'; await atomic(workspace.manifestPath, manifest); }
    return { ...manifest.cleanup, dryRun, released: !dryRun, reconciled: true };
  }
  const current = await inspect({ workspace });
  assert(!current.dirty, 'dirty workspace must be preserved');
  assert(!leases.length && !current.leases.length && !openPR && !unresolved, 'workspace has outstanding obligations');
  let preserved = false;
  if (preservation.mergedInto) {
    const merge = await git(manifest.root, ['merge-base', '--is-ancestor', current.head, preservation.mergedInto], { allowFailure: true });
    preserved = merge.code === 0;
  }
  if (preservation.archivePath) {
    const archive = await realpath(preservation.archivePath);
    assert(!archive.startsWith(`${manifest.path}/`), 'archive must survive workspace deletion');
    assert((await value(manifest.root, ['bundle', 'list-heads', archive])).split('\n').some(line => line.split(' ')[0] === current.head), 'archive does not retain workspace head');
    await git(manifest.root, ['bundle', 'verify', archive]); preserved = true;
  }
  assert(preserved, 'verified merge or durable archive required before cleanup');
  const receipt = { released: !dryRun, dryRun, head: current.head, branch: manifest.branch, ownershipDigest: manifest.ownershipDigest, preservation };
  if (dryRun) return receipt;
  // Record intent before removal; a restart can reconcile a missing tree without recreating work.
  manifest.status = 'releasing'; manifest.cleanup = receipt; await atomic(workspace.manifestPath, manifest);
  await git(manifest.root, ['worktree', 'remove', manifest.path]);
  assert(await value(manifest.root, ['rev-parse', `refs/heads/${manifest.branch}`]) === current.head, 'branch changed during cleanup');
  // Preservation was verified above; Git's -d heuristic can compare an obsolete upstream.
  await git(manifest.root, ['branch', '-D', manifest.branch]);
  manifest.status = 'released'; await atomic(workspace.manifestPath, manifest);
  return receipt;
}

// Release a workspace whose complete contents (history, working tree and index)
// were archived and verified by the caller. Removal is recorded first so a retry
// reconciles a missing tree through release() instead of recreating anything.
export async function releaseArchived({ workspace, expectedHead, archive }) {
  const manifest = await load(workspace);
  if (manifest.status === 'released') return { released: true, reconciled: true };
  if (manifest.status === 'releasing') return release({ workspace, dryRun: false });
  const current = await inspect({ workspace });
  assert(current.head === expectedHead && !current.leases?.length, 'archived workspace changed or is leased');
  manifest.status = 'releasing'; manifest.cleanup = { released: true, head: current.head, branch: manifest.branch, ownershipDigest: manifest.ownershipDigest, preservation: { archive } };
  await atomic(workspace.manifestPath, manifest);
  await git(manifest.root, ['worktree', 'remove', '--force', manifest.path]);
  return release({ workspace, dryRun: false });
}
