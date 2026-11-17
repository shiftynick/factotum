import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { assert } from '../core/contracts.mjs';

export function normalizeConflictPath(path) {
  assert(typeof path === 'string' && path.length && !path.startsWith('/') && !path.includes('\\') && !path.includes('\0') && !/[?*]/.test(path), 'literal repository-relative path required');
  const parts = path.split('/');
  assert(!parts.includes('..'), 'conflict path escapes repository');
  return parts.filter(part => part && part !== '.').join('/') || '.';
}
const unique = paths => [...new Set(paths.filter(path => path !== '').map(normalizeConflictPath))];
// Reuse a single bounded observation within a snapshot or queue scan. Admission
// still takes a new observation immediately before its atomic claim.
export function captureConflictScope(store) {
  return new Map(store.live('flow').filter(flow => !['completed', 'failed'].includes(flow.state) && !['planning', 'maintenance'].includes(flow.kind)).map(flow => {
    try { return [flow.id, { paths: activeConflictPaths(store, flow) }]; }
    catch { return [flow.id, { unavailable: true }]; }
  }));
}
export function declaredConflictPaths(store, task) {
  return unique([...(task?.paths ?? [])]);
}

// Local observation only: never fetch, run setup, execute a diff driver or mutate
// the operator's checkout. A running builder can change its files after this read.
export function activeConflictPaths(store, flow) {
  const task = flow.taskSnapshot ?? store.get('task', flow.taskId);
  const paths = [...(task?.paths ?? []), ...(flow.results?.plan?.result?.files ?? [])];
  if (!flow.workspace) return unique(paths);
  const workspace = flow.workspace;
  assert(workspace.manifestPath && !lstatSync(workspace.manifestPath).isSymbolicLink(), 'owned workspace manifest required');
  const manifest = JSON.parse(readFileSync(workspace.manifestPath, 'utf8'));
  const immutable = { version: manifest.version, projectId: manifest.projectId, flowId: manifest.flowId, root: manifest.root, path: manifest.path, branch: manifest.branch, base: manifest.base };
  const hash = createHash('sha256').update(JSON.stringify(immutable)).digest('hex');
  assert(manifest.version === 1 && manifest.ownershipDigest === hash && workspace.ownershipDigest === hash, 'workspace ownership mismatch');
  assert(manifest.projectId === store.meta('project')?.projectId && manifest.flowId === flow.id, 'workspace flow mismatch');
  assert(manifest.path === workspace.path && resolve(manifest.path) === join(dirname(workspace.manifestPath), 'tree') && realpathSync(manifest.path) === manifest.path, 'workspace path redirected');
  assert(/^[a-f\d]{40,64}$/i.test(manifest.base), 'workspace base missing');
  const git = args => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd: manifest.path, timeout: 5000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert(git(['symbolic-ref', '--short', 'HEAD']).trim() === manifest.branch, 'workspace branch changed');
  assert(realpathSync(git(['rev-parse', '--show-toplevel']).trim()) === manifest.path, 'workspace root changed');
  // The flow's own changes are what its worktree differs in from the target it last integrated.
  // Compared with the original base instead, a candidate that has integrated a moved target also
  // lists every file other work merged meanwhile, and would exclude unrelated tasks until it
  // finished. The integrated target is used only when the factory recorded the integration
  // (results.integrate.base) and the candidate really contains it or is merging it; otherwise
  // (no integration yet, or a candidate that no longer contains it) the original base is used,
  // as before, which can only list more.
  const integrated = flow.results?.integrate?.base, quiet = args => { try { return git(args).trim(); } catch { return null; } };
  const contained = /^[a-f\d]{40,64}$/i.test(integrated ?? '') && integrated !== manifest.base
    && (quiet(['merge-base', '--is-ancestor', integrated, 'HEAD']) !== null || quiet(['rev-parse', '-q', '--verify', 'MERGE_HEAD^{commit}']) === integrated);
  // No rename collapsing: both the old and new path must exclude concurrent work.
  paths.push(...git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', contained ? integrated : manifest.base, '--']).split('\0'));
  paths.push(...git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0'));
  return unique(paths);
}
