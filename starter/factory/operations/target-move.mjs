import { execFileSync } from 'node:child_process';
import { normalizeConflictPath } from './conflicts.mjs';

// Has the target moved since a candidate integrated it, and does what it changed touch the
// candidate? Used for an open merge question (core/engine.mjs) and by the merge step itself
// (workflows/dispatch.mjs), so the card and the merge agree.
//
// Local reads only: three Git calls in the candidate's worktree, no fetch and no network. The
// caller supplies the target head it knows (the recorded target health for a question; the head
// the merge step has just read and fetched).
//
// - not moved: the known head is the integrated base; or it is an ancestor of the base and is not
//   known to be the target's current head (`live` false: a record older than the integration).
// - moved back (`rewound`): the head is an ancestor of the base and `live` says it was observed
//   after the integration (the merge step's own read, the target probe, a later verification).
//   The target was force-pushed or reset; what the candidate integrated is no longer on it.
// - moved, `overlap` listed: the head's commits are here; the files they changed are compared with
//   the candidate's own changes since the integrated base and with its declared paths.
// - moved, `overlap` null: the head's commits are not in this repository yet (a push seen only as a
//   ref), so what they changed is unknown until the merge step fetches them.
const SHA = /^[a-f\d]{40,64}$/i;
const short = sha => String(sha ?? '').slice(0, 12);
const git = (cwd, args) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], { cwd, timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const names = text => text.split('\0').filter(Boolean);
const diff = (cwd, from, to) => names(git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', from, to, '--']));
const within = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
// A declared path that cannot be read as a literal path counts as the whole repository.
const scopePath = path => { try { return normalizeConflictPath(path); } catch { return '.'; } };

export function targetMove(cwd, { base, head, scope = [], live = false } = {}) {
  if (!SHA.test(base ?? '') || !SHA.test(head ?? '') || base === head) return { moved: false };
  try { git(cwd, ['merge-base', '--is-ancestor', head, base]); return live ? { moved: true, rewound: true, from: base, to: head, changed: null, overlap: null, overlapCount: null } : { moved: false }; }
  catch { /* not an ancestor, or a commit this repository does not have: the target is elsewhere */ }
  const move = { moved: true, from: base, to: head };
  try {
    const changed = diff(cwd, base, head), own = new Set(diff(cwd, base, 'HEAD')), declared = scope.filter(path => typeof path === 'string' && path).map(scopePath);
    const touched = changed.filter(path => own.has(path) || declared.some(prefix => within(path, prefix)));
    return { ...move, changed: changed.length, overlap: touched.slice(0, 20), overlapCount: touched.length };
  } catch { return { ...move, changed: null, overlap: null, overlapCount: null }; }
}
// The declared scope a moved target is compared with: the task's paths and the reviewed plan's files.
export const mergeScope = (task, results) => [...(task?.paths ?? []), ...(results?.plan?.result?.files ?? [])];
// Whether the merge step re-integrates for this move: always, unless the new commits are known to
// touch nothing of the candidate.
export const needsReintegration = move => Boolean(move?.moved) && !(Array.isArray(move.overlap) && move.overlapCount === 0);

// What the operator reads on the merge question, and what the merge step does with the same facts.
export function targetMoveText(move, target = 'target') {
  if (!move?.moved) return '';
  if (move.rewound) return `The target ${target} was moved back from ${short(move.from)} to ${short(move.to)}, an earlier commit than this candidate integrated (a force-push or reset): commits this candidate contains are no longer on the target. Answering merge does not merge this candidate as it is: the merge step returns to integration, the checks and review run again, and a new merge question follows.`;
  const head = `The target ${target} moved from ${short(move.from)} to ${short(move.to)} after this candidate was integrated at ${short(move.from)}.`;
  if (!Array.isArray(move.overlap)) return `${head} The new commits are not in the local repository yet, so whether they touch this candidate's files is checked when merge is answered: if they do (or it cannot be told), the merge step returns to integration, the checks and review run again on the re-integrated candidate and a new merge question follows; if they do not, it merges onto the moved target without integrating again, with the review and the checks as they ran against ${short(move.from)}, and only post-merge verification checks the combined result.`;
  if (move.overlapCount > 0) return `${head} Its new commits change files this candidate also touches or declares (${move.overlap.slice(0, 5).join(', ')}${move.overlapCount > 5 ? `, and ${move.overlapCount - 5} more` : ''}). Answering merge does not merge this candidate as it is: the merge step returns to integration, the checks and review run again on the re-integrated candidate, and a new merge question follows.`;
  return `${head} Its new commits (${move.changed} file${move.changed === 1 ? '' : 's'}) touch none of this candidate's changed files or declared paths. Answering merge merges this candidate onto the moved target without integrating it again: the review and the checks ran against ${short(move.from)}, not against ${short(move.to)}, and are not repeated before the merge. Only post-merge verification checks the combined result.`;
}
