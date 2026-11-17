import { execFileSync } from 'node:child_process';
import { lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { NO_PLANTED_COMMANDS } from './git-options.mjs';

// `git status` does not look at index entries marked assume-unchanged or skip-worktree, so a
// changed file behind either flag looks clean. A flagged entry is hidden work when its file
// exists and its content (after the path's clean filters) differs from the index. A flagged file
// that is absent (as sparse checkouts leave them) holds nothing beyond the index and its commit.
// Returns the paths of hidden changes; an empty list when there are none.
export function hiddenIndexChanges(cwd) {
  const run = (args, input) => execFileSync('git', [...NO_PLANTED_COMMANDS, '-c', 'core.hooksPath=/dev/null', ...args], { cwd, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, timeout: 600000 });
  const hidden = [];
  for (const record of run(['ls-files', '-v', '-s', '-z']).split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'), [tag, mode, object] = record.slice(0, tab).split(' '), path = record.slice(tab + 1);
    // Lowercase tags are assume-unchanged; S (or s) is skip-worktree.
    if (!(tag !== tag.toUpperCase() || tag === 'S')) continue;
    if (mode === '160000') continue;
    let stat;
    try { stat = lstatSync(join(cwd, path)); } catch { continue; }
    let current;
    if (mode === '120000') current = stat.isSymbolicLink() ? run(['hash-object', '--stdin'], readlinkSync(join(cwd, path))).trim() : null;
    else current = stat.isFile() ? run(['hash-object', '--', path]).trim() : null;
    if (current !== object) hidden.push(path);
  }
  return hidden;
}
