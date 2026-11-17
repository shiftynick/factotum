import { NO_PLANTED_COMMANDS } from './git-options.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync, readlinkSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

// The path listing of a large checkout exceeds Node's default 1 MiB child output limit.
const LISTING_BYTES = 512 * 1024 * 1024;

export function repositoryIdentity(root) {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 5000 }).trim();
  // -t distinguishes opaque untracked repositories from tracked gitlinks and
  // tracked files replaced by directories, without another Git invocation.
  const entries = execFileSync('git', [...NO_PLANTED_COMMANDS, 'ls-files', '--cached', '--others', '--exclude-standard', '-t', '-z'], { cwd: root, timeout: 5000, maxBuffer: LISTING_BYTES }).toString().split('\0').filter(Boolean);
  const paths = new Map();
  for (const entry of entries) {
    const path = entry.slice(2), tracked = entry[0] !== '?';
    paths.set(path, paths.get(path) === true || tracked);
  }
  const hash = createHash('sha256');
  for (const path of [...paths.keys()].sort()) {
    hash.update(path + '\0');
    try {
      // Git adds a trailing slash for untracked repositories. Remove it for
      // lstat so a concurrent replacement by a symlink is not followed.
      const absolute = join(root, path.replace(/\/+$/, ''));
      const info = lstatSync(absolute);
      hash.update(String(info.mode) + '\0');
      if (info.isSymbolicLink()) hash.update(readlinkSync(absolute));
      else if (info.isFile()) hash.update(readFileSync(absolute));
      else if (info.isDirectory() && !paths.get(path)) hash.update('<directory>');
      else throw Object.assign(new Error(info.isDirectory() ? 'tracked directory or submodule is not supported by repository fingerprints' : 'unsupported filesystem entry type'), { code: 'EUNSUPPORTEDTYPE' });
    } catch (error) {
      if (error.code === 'ENOENT') hash.update('<deleted>');
      else throw Object.assign(new Error(`Cannot fingerprint repository path ${JSON.stringify(path)}: ${error.message}`, { cause: error }), { code: error.code, path });
    }
    hash.update('\0');
  }
  return { head, treeDigest: hash.digest('hex') };
}

// The same fingerprint, computed on a worker thread. It reads every file of the
// checkout, so callers on the service's tick path use this to keep the event loop
// free, and never call it inside a database transaction.
export function repositoryIdentityOffThread(root) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./repository-worker.mjs', import.meta.url), { workerData: { root } });
    let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    worker.once('message', message => {
      if (settled) return;
      settled = true;
      if (message.error) reject(Object.assign(new Error(message.error.message), { code: message.error.code, path: message.error.path }));
      else resolve(message.identity);
    });
    worker.once('error', fail);
    worker.once('exit', code => fail(new Error(`repository fingerprint worker exited with code ${code} before reporting`)));
  });
}

// A constant-cost change signal for a checkout: the stat identity of Git's HEAD,
// HEAD's reflog and the index of this worktree. A commit, checkout, reset, rebase,
// stash or staging changes it; an edit to a working-tree file that Git has not been
// told about does not. It only ever prompts a full fingerprint sooner: nothing is
// decided from it, and null (no readable Git directory) means "no signal".
export function repositoryProbe(root) {
  try {
    let gitDir = join(root, '.git');
    if (lstatSync(gitDir).isFile()) {
      const pointer = /^gitdir: (.+)$/m.exec(readFileSync(gitDir, 'utf8'));
      if (!pointer) return null;
      gitDir = resolve(root, pointer[1].trim());
    }
    return ['HEAD', 'logs/HEAD', 'index'].map(name => {
      try { const info = statSync(join(gitDir, name), { bigint: true }); return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`; }
      catch { return '-'; }
    }).join('|');
  } catch { return null; }
}
