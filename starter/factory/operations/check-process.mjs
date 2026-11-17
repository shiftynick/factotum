import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

// Runs one main check (dev.85). The same contract as runProcess (adapters/providers/index.mjs):
// its own process group, `timeoutMs` and `maxBytes` enforced, {stdout, stderr, code, started} on a
// clean exit, otherwise an error with `code` (TIMEOUT, OUTPUT_LIMIT, DESCENDANTS_SURVIVE, CANCELLED,
// SPAWN_FAILED), `started`, and the output so far.
//
// Differences from runProcess:
// - Once the check's own process has exited, the runner waits at most EXIT_GRACE_MS for its output
//   pipes to close. A process it started that holds them open (a server left running) no longer
//   keeps the verifier waiting until the check's timeout, and the check is not reported as timed out.
// - Every ending (a clean exit with processes left in the group, the exit grace, a timeout, the
//   output limit, cancellation) first empties the check's process group: SIGTERM to every member,
//   up to KILL_GRACE_MS for them to exit, then SIGKILL to whatever is still in the group, then up
//   to KILL_GRACE_MS for that. Only then is the result settled.
// - Each signal is sent only to a process that, read from /proc immediately before the signal, is
//   still in the check's process group with the start time it had when it was found, so a reused
//   PID or a process that has left the group is never signalled.
// A process that left the group (setsid) is not signalled: it is reported in `escaped` (PID and
// its new group), and the caller treats the check as not contained. Under systemd supervision the
// step's cgroup check also finds it and the attempt fails as a containment failure.
export const EXIT_GRACE_MS = 2000, KILL_GRACE_MS = 1000;
const POLL_MS = 20;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function stat(pid) {
  try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(' '); return { state: fields[0], pgid: Number(fields[2]), start: fields[19] }; } catch { return null; }
}
const live = row => row && !['Z', 'X'].includes(row.state);
// Live members of process group `pgid`, with their start times.
function groupMembers(pgid) {
  const members = [];
  try { for (const entry of readdirSync('/proc')) { if (!/^\d+$/.test(entry)) continue; const row = stat(entry); if (live(row) && row.pgid === pgid) members.push({ pid: Number(entry), start: row.start }); } } catch {}
  return members;
}

// Empties process group `pgid` (see above). `seen` collects every member found (PID and start
// time), so a member that later turns up in another group is reported as escaped. Returns the
// members still in the group at the end (an uninterruptible process, say).
async function emptyGroup(pgid, seen) {
  const look = () => { const members = groupMembers(pgid); for (const member of members) seen.set(`${member.pid}:${member.start}`, member); return members; };
  const send = sig => { for (const member of look()) { const now = stat(member.pid); if (!live(now) || now.pgid !== pgid || now.start !== member.start) continue; try { process.kill(member.pid, sig); } catch {} } };
  const wait = async () => { for (const end = Date.now() + KILL_GRACE_MS; look().length && Date.now() < end;) await pause(POLL_MS); };
  if (!look().length) return [];
  send('SIGTERM'); await wait();
  if (look().length) { send('SIGKILL'); await wait(); }
  return look();
}
// Members found earlier that are alive now in another process group: they left and were not signalled.
function escapedFrom(pgid, seen) {
  return [...seen.values()].flatMap(member => { const now = stat(member.pid); return live(now) && now.start === member.start && now.pgid !== pgid ? [{ pid: member.pid, pgid: now.pgid }] : []; });
}

export function runCheckProcess(binary, args, { cwd, env, signal: abort, timeoutMs = 30_000, maxBytes = 16 * 1024 * 1024, exitGraceMs = EXIT_GRACE_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (abort?.aborted) return reject(Object.assign(new Error('Check cancelled before launch'), { code: 'CANCELLED', started: false }));
    const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', spawned = false, exited = false, exitCode = null, reason = null, detail = '', concluding = false, stopping = null;
    const seen = new Map(), timers = new Set(), later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; };
    const clear = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); abort?.removeEventListener('abort', onAbort); };
    const stop = why => { if (reason) return; reason = why; stopping ??= emptyGroup(child.pid, seen); };
    // The single way a run ends: stop waiting, empty the group (after any stop already under way),
    // then settle. `held` says the check's own process exited but its output pipes stayed open.
    const conclude = async held => {
      if (concluding) return; concluding = true; clear();
      if (held && !reason) { reason = 'DESCENDANTS_SURVIVE'; detail = `exited${exitCode === null ? '' : ` with code ${exitCode}`}, but a process it started still held its output open ${Math.round(exitGraceMs / 100) / 10} s later; it was stopped`; }
      if (stopping) await stopping;
      if (groupMembers(child.pid).length) { if (!reason) reason = 'DESCENDANTS_SURVIVE'; stopping = emptyGroup(child.pid, seen); await stopping; }
      if (held) { child.stdout.destroy(); child.stderr.destroy(); }
      const remaining = groupMembers(child.pid), escaped = escapedFrom(child.pid, seen);
      if (remaining.length) { reason ??= 'DESCENDANTS_SURVIVE'; detail = `${detail || 'left processes running after it exited'}; ${remaining.length} process(es) were still in its process group after SIGKILL`; }
      if (escaped.length) detail = `${detail || (reason === 'DESCENDANTS_SURVIVE' ? 'left processes running after it exited' : '')}${detail || reason === 'DESCENDANTS_SURVIVE' ? '; ' : ''}${escaped.length} process(es) it started left its process group and were not stopped (PID ${escaped.map(row => row.pid).join(', ')})`;
      if (reason) {
        const text = reason === 'DESCENDANTS_SURVIVE' ? detail || 'left processes running after it exited' : `${reason.toLowerCase()}${detail ? `; ${detail}` : ''}`;
        const error = Object.assign(new Error(`Check ${text}`), { code: reason, started: spawned, ...(exited ? { exitCode } : {}), ...(escaped.length ? { escaped } : {}) });
        Object.defineProperties(error, { stdout: { value: stdout }, stderr: { value: stderr } }); reject(error);
      } else resolvePromise({ stdout, stderr, code: exitCode, started: spawned });
    };
    const onAbort = () => stop('CANCELLED'); abort?.addEventListener('abort', onAbort, { once: true });
    // The limit applies to the check's own process: once it has exited, the exit grace decides.
    later(() => { if (!exited) stop('TIMEOUT'); }, timeoutMs);
    child.on('spawn', () => { spawned = true; });
    const read = stream => { stream.setEncoding('utf8'); stream.on('data', chunk => { if (reason) return; if (stream === child.stdout) stdout += chunk; else stderr += chunk; if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBytes) stop('OUTPUT_LIMIT'); }); };
    read(child.stdout); read(child.stderr);
    child.on('error', error => { if (spawned || concluding) return; concluding = true; clear(); reject(Object.assign(new Error('Check executable could not start'), { code: error.code ?? 'SPAWN_FAILED', started: false })); });
    child.on('exit', code => { exited = true; exitCode = code; if (!concluding) later(() => conclude(true), exitGraceMs); });
    child.on('close', () => { if (spawned) conclude(false); });
  });
}
