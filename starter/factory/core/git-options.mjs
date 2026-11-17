// Automatic maintenance may detach after a successful write. Run it separately
// from supervised effects rather than letting it outlive their containment.
export const NO_AUTO_MAINTENANCE = Object.freeze(['-c', 'maintenance.auto=false', '-c', 'gc.auto=0']);
// Builder worktrees share the project's Git directory, whose config a builder can write. A planted
// file-system monitor is a command Git runs during status, add and commit; Factotum's own Git calls
// switch it off. (Hooks are switched off separately where Factotum does not want them.)
export const NO_PLANTED_COMMANDS = Object.freeze(['-c', 'core.fsmonitor=false']);

// A trusted project check that runs git directly keeps the factory's non-credential Git
// safeguards (no automatic maintenance, no hooks, no signing, no system/global config, no
// prompts) but never receives the factory's scoped GitHub credentials.
export const CHECK_GIT_OPTIONS = Object.freeze([...NO_AUTO_MAINTENANCE, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false']);
export const CHECK_GIT_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false' });

// Two fetches into one repository (a flow's cleanup and the post-merge verification, say,
// or the project's own checks) race on the same remote-tracking ref. Git locks each ref it
// updates and checks its expected old value, so the loser fails on that ref. A fetch is not
// atomic across refs: other refs in the same fetch may already have been updated, and
// --prune may already have deleted some. Repeating the fetch is still safe because it is
// idempotent: refs already updated stay, and the rest are updated again.
// Only genuine lock contention is retried: a held lock file or a ref that moved under the
// fetch. A ref namespace (directory/file) conflict is permanent and fails at once, even when
// the same fetch also lost a lock race, and so is every other failure and Git command.
// No cross-process lock: it could not cover Git processes the factory does not run, and a
// lock file would add stale-lock and hang failure modes to every fetch.
const LOCK_CONTENTION = /cannot lock ref '[^']*': is at [0-9a-f]+ but expected [0-9a-f]+|Unable to create '[^']*\.lock': File exists/i;
const PERMANENT_REF_CONFLICT = /exists; cannot create|cannot process '[^']*' and '[^']*' at the same time|try running\s+'git remote prune|there are still refs under|blocking reference/i;
export const refLockFailure = text => LOCK_CONTENTION.test(String(text ?? '')) && !PERMANENT_REF_CONFLICT.test(String(text ?? ''));
export const FETCH_LOCK_RETRY_DELAYS_MS = Object.freeze([100, 250, 500, 1000, 2000]);
const jittered = ms => ms + Math.floor(Math.random() * ms / 2);
const failureText = (result, error) => error ? `${error.message ?? ''}\n${error.stderr ?? ''}` : result && result.code !== 0 && result.code !== undefined ? String(result.stderr ?? '') : '';
// A lock file still present after every retry is most likely stale (left by a Git process that
// crashed); the final failure names it so the operator can check for a running Git and remove it.
const LOCK_FILE = /Unable to create '([^']*\.lock)': File exists/i;
export function staleLockDiagnostic(text, attempts) {
  const lock = String(text ?? '').match(LOCK_FILE)?.[1];
  return lock ? `\nThe lock file ${lock} was still present after ${attempts} fetch attempts. If no Git process is running in this repository, it is stale: remove it and run the fetch again.` : '';
}
const finalFailure = (result, error, attempts) => {
  const extra = staleLockDiagnostic(failureText(result, error), attempts);
  if (!extra) { if (error) throw error; return result; }
  if (error) { error.message = `${error.message ?? ''}${extra}`; if (typeof error.stderr === 'string') error.stderr += extra; throw error; }
  return { ...result, stderr: `${result.stderr ?? ''}${extra}` };
};
// run() either returns {code, stderr} or throws an error carrying the message or stderr.
export async function retryRefLockedFetch(args, run, { delays = FETCH_LOCK_RETRY_DELAYS_MS, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (args?.[0] !== 'fetch') return run();
  for (let attempt = 0; ; attempt++) {
    let result, error;
    try { result = await run(); } catch (caught) { error = caught; }
    if (!refLockFailure(failureText(result, error))) { if (error) throw error; return result; }
    if (attempt >= delays.length) return finalFailure(result, error, attempt + 1);
    await sleep(jittered(delays[attempt]));
  }
}
export function retryRefLockedFetchSync(args, run, { delays = FETCH_LOCK_RETRY_DELAYS_MS } = {}) {
  if (args?.[0] !== 'fetch') return run();
  for (let attempt = 0; ; attempt++) {
    let result, error;
    try { result = run(); } catch (caught) { error = caught; }
    if (!refLockFailure(failureText(result, error))) { if (error) throw error; return result; }
    if (attempt >= delays.length) return finalFailure(result, error, attempt + 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, jittered(delays[attempt]));
  }
}

// The commit `git ls-remote <remote> refs/heads/<branch>` reports for exactly that ref. Git matches
// the pattern against the end of ref names, so a branch named `x/refs/heads/main` is listed as
// well (refs/heads/x/refs/heads/main), and it sorts before refs/heads/main. Only the line whose
// ref is exactly the one asked for counts; null when there is none.
export function remoteRefHead(stdout, ref) {
  for (const line of String(stdout ?? '').split('\n')) {
    const [sha, name, ...rest] = line.trim().split(/\s+/);
    if (name === ref && !rest.length && /^[a-f\d]{40,64}$/i.test(sha ?? '')) return sha;
  }
  return null;
}
