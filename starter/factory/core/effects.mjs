import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, digest, fileDigest } from './contracts.mjs';
import { processIdentity, sameProcess } from './process-identity.mjs';
import { ownerState } from '../operations/resources.mjs';
const exec = promisify(execFile);
const coreDir = dirname(fileURLToPath(import.meta.url));
export function executorDigest() {
  const root = dirname(coreDir);
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() && entry.name !== 'console' ? files(join(dir, entry.name)) : entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs') && entry.name !== 'cli.mjs' ? [join(dir, entry.name)] : []);
  return digest(files(root).sort().map(p => [p.slice(root.length + 1), fileDigest(p)]));
}
export const attemptDir = (store, attempt) => join(store.stateDir, 'attempts', attempt.id);
export function writeIntent(store, attempt) {
  const path = join(attemptDir(store, attempt), 'intent.json');
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    const { intentDigest, ...intent } = saved;
    if (intentDigest !== attempt.intentDigest || digest(intent) !== attempt.intentDigest) throw new Error('existing intent differs');
    return path;
  }
  atomicJSON(path, { ...attempt.intent, intentDigest: attempt.intentDigest });
  return path;
}
export async function launch(store, attempt) {
  const path = join(attemptDir(store, attempt), 'intent.json');
  if (store.meta('project').supervisor === 'systemd') {
    await exec('systemd-run', ['--user', '--collect', `--unit=${attempt.unit}`, '--property=Type=exec', '--property=KillMode=control-group', process.execPath, join(coreDir, 'supervisor.mjs'), path], { timeout: 5000 });
  } else {
    const child = spawn(process.execPath, [join(coreDir, 'supervisor.mjs'), path], { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    // On a busy host the supervisor can take longer than the launch window to start
    // and record ownership. Its process identity keeps the attempt launching while it lives.
    try { atomicJSON(join(attemptDir(store, attempt), 'launch.json'), { attemptId: attempt.id, intentDigest: attempt.intentDigest, supervisor: processIdentity(child.pid) }); } catch {}
  }
}
export function inspect(store, attempt) {
  const dir = attemptDir(store, attempt);
  const receiptPath = join(dir, 'receipt.json');
  if (existsSync(receiptPath)) {
    try {
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
      if (receipt.version !== 1 || receipt.attemptId !== attempt.id || receipt.intentDigest !== attempt.intentDigest || receipt.synthetic !== attempt.intent.synthetic) throw new Error('receipt identity mismatch');
      if (receipt.stdoutDigest !== fileDigest(join(dir, 'stdout.log')) || receipt.stderrDigest !== fileDigest(join(dir, 'stderr.log'))) throw new Error('receipt log digest mismatch');
      if (!Number.isSafeInteger(receipt.costMicros) || receipt.costMicros < 0) throw new Error('unresolved cost');
      if (attempt.intent.action) {
        const path = join(dir, 'action-result.json');
        // An attempt stopped on request exits without a result; its receipt says so. That is a
        // known outcome (aborted), not an uncertain one.
        if (receipt.reason === 'abort' && !receipt.resultDigest && !existsSync(path)) return { kind: 'terminal', receipt: { ...receipt, aborted: true } };
        if (!receipt.resultDigest || receipt.resultDigest !== fileDigest(path)) throw new Error('action result missing or altered');
        const result = JSON.parse(readFileSync(path, 'utf8'));
        if (result.attemptId !== attempt.id || result.intentDigest !== attempt.intentDigest) throw new Error('action result identity mismatch');
        receipt.actionResult = result;
      }
      return { kind: 'terminal', receipt };
    } catch (error) { return { kind: 'uncertain', reason: error.message }; }
  }
  const ownerPath = join(dir, 'owner.json');
  if (existsSync(ownerPath)) {
    try {
      const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
      if (owner.attemptId === attempt.id && owner.intentDigest === attempt.intentDigest && sameProcess(owner)) return { kind: 'running', owner };
      // The supervisor may have written its receipt and exited after the receipt check above.
      if (existsSync(receiptPath)) return inspect(store, attempt);
      return { kind: 'uncertain', reason: 'supervisor identity missing or no longer live' };
    } catch { return { kind: 'uncertain', reason: 'invalid supervisor ownership evidence' }; }
  }
  const launched = launchEvidence(store, attempt);
  if (launched) {
    if (liveProcess(launched.supervisor)) return { kind: 'launching', supervisor: launched.supervisor };
    // It may have recorded ownership or a receipt and exited after the checks above.
    if (existsSync(ownerPath) || existsSync(receiptPath)) return inspect(store, attempt);
    // The launched supervisor is gone and never recorded ownership: no effect was started.
    return { kind: 'uncertain', reason: 'dispatch has no live owner or terminal receipt; the launched supervisor ended before recording ownership' };
  }
  // No launch evidence (systemd mode, or the controller stopped before recording it): the launch window applies.
  if (Date.now() - Date.parse(attempt.dispatchedAt) < 5000) return { kind: 'launching' };
  return { kind: 'uncertain', reason: 'dispatch has no live owner or terminal receipt' };
}
function launchEvidence(store, attempt) {
  try {
    const launched = JSON.parse(readFileSync(join(attemptDir(store, attempt), 'launch.json'), 'utf8'));
    // A usable identity has all three fields; anything less is not launch evidence, so the
    // attempt stays uncertain and reconciliation still needs independent attestation.
    const id = launched.supervisor;
    const usable = id && Number.isSafeInteger(id.pid) && id.pid > 0 && typeof id.bootId === 'string' && /^[0-9a-f-]{16,64}$/i.test(id.bootId) && typeof id.startTime === 'string' && /^\d+$/.test(id.startTime);
    if (launched.attemptId === attempt.id && launched.intentDigest === attempt.intentDigest && usable) return launched;
  } catch {}
  return null;
}
function processStatus(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
}
// The recorded process, alive and not an unreaped zombie.
function liveProcess(identity) {
  try { if (['Z', 'X'].includes(processStatus(identity.pid))) return false; } catch { return false; }
  return sameProcess(identity);
}
// True only when launch evidence for this exact attempt names a supervisor that is confirmed
// gone and no ownership was ever recorded. The supervisor starts the effect only after
// recording ownership, so nothing it launched can still be running.
export function launchEndedBeforeOwnership(store, attempt) {
  const dir = attemptDir(store, attempt), launched = launchEvidence(store, attempt);
  if (!launched || existsSync(join(dir, 'owner.json'))) return false;
  let ended = ownerState(launched.supervisor) === 'dead';
  if (!ended) { try { ended = ['Z', 'X'].includes(processStatus(launched.supervisor.pid)) && sameProcess(launched.supervisor); } catch {} }
  return ended && !existsSync(join(dir, 'owner.json'));
}
// A launching supervisor that has not recorded ownership is first asked to stop through a
// durable request (abort.json) that it reads after recording ownership and before starting the
// effect. A signal is not used here: one that lands while Node is still starting would kill the
// supervisor and leave an uncertain attempt instead of an aborted one. If it has still not
// recorded ownership after LAUNCH_ABORT_GRACE_MS it is frozen (SIGSTOP); a frozen supervisor
// cannot record ownership or start the effect, so if it still has none it is killed (SIGKILL).
// If it recorded ownership first, it is resumed (SIGCONT) and the owned abort path takes over.
// Every signal is preceded by a PID + boot + start-time check.
export const LAUNCH_ABORT_GRACE_MS = 15000;
const FREEZE_WAIT_MS = 1000;
// An attempt launching longer than this without an abort request is reported for the operator.
export const LAUNCH_STALL_NOTICE_MS = 600000;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function signalProcess(identity, signal) {
  if (!liveProcess(identity)) return false;
  try { process.kill(identity.pid, signal); return true; } catch { return false; }
}
function noteLaunchAbort(store, attempt, change, event) {
  return store.tx(() => {
    const current = store.get('attempt', attempt.id);
    if (!current || current.settledAt) return null;
    const next = change(current.launchAbort);
    if (next) { current.launchAbort = next; store.put('attempt', current); if (event) store.event(event.name, { attemptId: current.id, ...event.data }); }
    return current.launchAbort ?? null;
  });
}
// Launch cancellation freezes a supervisor only within one call; across engine ticks it is
// never meant to stay frozen. If a runner died between SIGSTOP and its SIGKILL or SIGCONT,
// continue the identity-verified supervisor recorded for this attempt's launch abort, whatever
// the attempt's state now (launching, running or already terminal).
export function resumeInterruptedFreeze(store, attempt) {
  const record = (store.get('attempt', attempt.id) ?? attempt).launchAbort, supervisor = record?.supervisor;
  // Only a freeze this code durably recorded and never ended is undone; a process stopped by
  // anyone else is left alone.
  if (!record?.frozen || !supervisor || !liveProcess(supervisor)) return false;
  let resumed = false;
  try { if (['T', 't'].includes(processStatus(supervisor.pid))) resumed = signalProcess(supervisor, 'SIGCONT'); } catch {}
  noteLaunchAbort(store, attempt, previous => ({ ...previous, frozen: false }), resumed ? { name: 'attempt.launch-freeze-recovered', data: { pid: supervisor.pid } } : null);
  return resumed;
}
export async function requestAbort(store, attempt, { graceMs = LAUNCH_ABORT_GRACE_MS } = {}) {
  resumeInterruptedFreeze(store, attempt);
  const effect = inspect(store, attempt);
  if (effect.kind === 'running') {
    // PID + boot + process start identity is checked immediately before signalling.
    // It may have been frozen by launch cancellation before a runner restart: continue it after
    // SIGTERM so it can handle the stop. SIGCONT is harmless to a running process.
    if (sameProcess(effect.owner)) { try { process.kill(effect.owner.pid, 'SIGTERM'); } catch {} signalProcess(effect.owner, 'SIGCONT'); }
    return;
  }
  if (effect.kind !== 'launching' || !effect.supervisor) return;
  const supervisor = effect.supervisor;
  const record = noteLaunchAbort(store, attempt, previous => previous ? null : { requestedAt: new Date().toISOString(), supervisor },
    { name: 'attempt.launch-abort-requested', data: { pid: supervisor.pid } });
  if (!record) return;
  const abortPath = join(attemptDir(store, attempt), 'abort.json');
  try { if (!existsSync(abortPath)) atomicJSON(abortPath, { attemptId: attempt.id, intentDigest: attempt.intentDigest, requestedAt: record.requestedAt }); } catch {}
  if (Date.now() - Date.parse(record.requestedAt) < graceMs) return;
  // Record the freeze durably first, so a runner that dies before ending it resumes it on restart.
  noteLaunchAbort(store, attempt, previous => ({ ...previous, frozen: true }));
  if (!signalProcess(supervisor, 'SIGSTOP')) { noteLaunchAbort(store, attempt, previous => ({ ...previous, frozen: false })); return; }
  let frozen = false;
  for (const end = Date.now() + FREEZE_WAIT_MS; Date.now() < end; await pause(10)) {
    try { if (['T', 't'].includes(processStatus(supervisor.pid)) && sameProcess(supervisor)) { frozen = true; break; } } catch { break; }
  }
  const dir = attemptDir(store, attempt);
  const owned = existsSync(join(dir, 'owner.json')) || existsSync(join(dir, 'receipt.json'));
  if (frozen && !owned && signalProcess(supervisor, 'SIGKILL')) {
    noteLaunchAbort(store, attempt, previous => ({ ...previous, frozen: false, killedAt: new Date().toISOString() }), { name: 'attempt.launch-killed', data: { pid: supervisor.pid, graceMs } });
    return;
  }
  // Ownership won the race, or the process did not stop in time: resume it. It reads the abort
  // request before starting the effect; if it already started it, the owned abort path stops it.
  signalProcess(supervisor, 'SIGCONT');
  noteLaunchAbort(store, attempt, previous => ({ ...previous, frozen: false }));
  if (owned) noteLaunchAbort(store, attempt, previous => previous.ownershipRecordedAt ? null : { ...previous, ownershipRecordedAt: new Date().toISOString() }, { name: 'attempt.launch-abort-owned', data: { pid: supervisor.pid } });
}
