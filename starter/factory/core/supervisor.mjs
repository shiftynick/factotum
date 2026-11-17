import { spawn } from 'node:child_process';
import { openSync, closeSync, fsyncSync, readFileSync, statSync, readdirSync, existsSync, readlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJSON, assert, digest, fileDigest, now } from './contracts.mjs';
import { processIdentity } from './process-identity.mjs';

// Who a surviving descendant is and what launched it: parent, process group,
// session, executable and the first few arguments (never the environment).
function survivorIdentity(pid) {
  const identity = {};
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    Object.assign(identity, { ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]) });
  } catch {}
  try { identity.exe = readlinkSync(`/proc/${pid}/exe`); } catch {}
  try { identity.args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(0, 4).map(arg => arg.slice(0, 160)); } catch {}
  return identity;
}
export async function supervise(intentPath) {
  // Listen for a stop request before anything else: one that arrives before the effect starts
  // means the effect is never started, and the receipt says so.
  let abortRequested = false;
  const early = () => { abortRequested = true; };
  process.on('SIGTERM', early);
  process.on('SIGINT', early);
  const spec = JSON.parse(readFileSync(intentPath, 'utf8'));
  const { intentDigest, ...intent } = spec;
  assert(digest(intent) === intentDigest, 'intent digest mismatch');
  assert(typeof intent.synthetic === 'boolean' && intent.maxCostMicros === 0, 'only verified zero incremental API cost modes supported');
  const dir = dirname(intentPath);
  // Exclusive claim is never removed: a second supervisor cannot repeat this intent.
  const lock = openSync(join(dir, 'claim'), 'wx', 0o600);
  closeSync(lock);
  const cgroup = ownedCgroup(intent);
  const owner = { ...processIdentity(), attemptId: intent.attemptId, intentDigest, ...(cgroup ? { cgroup } : {}) };
  atomicJSON(join(dir, 'owner.json'), owner);
  const outPath = join(dir, 'stdout.log'), errPath = join(dir, 'stderr.log');
  const stdout = openSync(outPath, 'wx', 0o600), stderr = openSync(errPath, 'wx', 0o600);
  const startedAt = now();
  let child, signalReason = null, escalation;
  const descendantEvidence = [];
  const terminate = reason => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    signalReason ??= reason;
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    escalation ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1000);
  };
  const abort = () => { abortRequested = true; terminate('abort'); };
  process.on('SIGTERM', abort);
  process.on('SIGINT', abort);
  process.off('SIGTERM', early);
  process.off('SIGINT', early);
  // Startup is synchronous, so a stop signal received during it is handled here, before the effect
  // starts. A stop requested before ownership is recorded as abort.json by the controller.
  await new Promise(resolve => setImmediate(resolve));
  if (existsSync(join(dir, 'abort.json'))) {
    try { const request = JSON.parse(readFileSync(join(dir, 'abort.json'), 'utf8')); if (request.attemptId === intent.attemptId && request.intentDigest === intentDigest) abortRequested = true; } catch {}
  }
  let result;
  try {
    if (abortRequested) {
      signalReason = 'abort';
      result = { exitCode: null, signal: null, effectStarted: false };
    } else {
      const allowed = ['HOME','USER','LOGNAME','SHELL','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','DBUS_SESSION_BUS_ADDRESS','SSH_AUTH_SOCK'];
      const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', FACTOTUM_SYNTHETIC: String(intent.synthetic), ...(!intent.synthetic ? Object.fromEntries(allowed.filter(k => process.env[k]).map(k => [k, process.env[k]])) : {}) };
      child = spawn(intent.argv[0], intent.argv.slice(1), { cwd: intent.cwd, env, detached: true, stdio: ['ignore', stdout, stderr] });
      const timeout = setTimeout(() => terminate('timeout'), intent.timeoutMs);
      const logBound = setInterval(() => {
        try { if (statSync(outPath).size + statSync(errPath).size > 1_048_576) terminate('output-limit'); } catch {}
      }, 100);
      result = await new Promise(resolve => {
        child.once('error', error => resolve({ exitCode: null, signal: null, launchError: error.message }));
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
      clearTimeout(timeout); clearInterval(logBound);
      // A CLI can exit just before its terminating children disappear from the cgroup.
      // Keep ownership and the lease until a bounded 50 ms exit grace finishes. Any
      // longer-lived descendant is still a containment failure, even after exit 0.
      const members = () => [...new Set([...(child.pid ? groupMembers(child.pid) : []), ...(cgroup ? cgroupMembers(cgroup) : [])])];
      const record = phase => {
        for(const pid of members()) {
          if(descendantEvidence.some(e=>e.pid===pid&&e.phase===phase)||descendantEvidence.length>=64)continue;
          let comm;try{comm=readFileSync(`/proc/${pid}/comm`,'utf8').trim();}catch{continue;}
          descendantEvidence.push({pid,comm,phase,...survivorIdentity(pid)});
        }
      };
      if(members().length) {
        record('leader-exited');
        const graceEnd = Date.now() + (signalReason ? 0 : 50);
        while(members().length && Date.now()<graceEnd)await new Promise(resolve=>setTimeout(resolve,5));
        if(members().length) {
          signalReason ??= 'descendant-survival';record('termination-required');
          const end=Date.now()+1500;
          while(members().length && Date.now()<end) {
            for(const pid of members()){try{process.kill(pid,Date.now()<end-1000?'SIGTERM':'SIGKILL');}catch{}}
            await new Promise(resolve=>setTimeout(resolve,20));
          }
          record('still-live');assert(members().length===0,'owned descendants remain; terminal outcome uncertain');
        }
      }
      if (escalation) clearTimeout(escalation);
    }
  } finally {
    // Stop handlers stay installed until the receipt is durable: with none, a late stop signal
    // would take the default action and kill the supervisor before it records the outcome.
    fsyncSync(stdout); fsyncSync(stderr);
    closeSync(stdout); closeSync(stderr);
  }
  const receipt = {
    version: 1, attemptId: intent.attemptId, intentDigest, owner, startedAt, endedAt: now(),
    ...result, reason: signalReason, descendants: descendantEvidence, synthetic: intent.synthetic, costMicros: 0,
    stdoutDigest: fileDigest(outPath), stderrDigest: fileDigest(errPath),
    ...(intent.action && existsSync(join(dir, 'action-result.json')) ? { resultDigest: fileDigest(join(dir, 'action-result.json')) } : {}),
  };
  atomicJSON(join(dir, 'receipt.json'), receipt);
  process.off('SIGTERM', abort); process.off('SIGINT', abort);
  return receipt;
}

function ownedCgroup(intent) {
  if (intent.containment !== 'systemd' || !intent.unit) return null;
  const relative = readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(line => line.startsWith('0::'))?.slice(3);
  assert(relative && relative.split('/').some(part => part === `${intent.unit}.service`) && !relative.split('/').includes('..'), 'supervisor is not in the intended private systemd cgroup');
  return `/sys/fs/cgroup${relative}`;
}
function cgroupMembers(root) {
  const pids = new Set(readFileSync(join(root, 'cgroup.procs'), 'utf8').trim().split('\n').filter(Boolean).map(Number));
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isDirectory()) for (const pid of cgroupMembers(join(root, entry.name))) pids.add(pid);
  return [...pids].filter(pid => {
    if (pid === process.pid) return false;
    try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return !['Z','X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]); } catch { return false; }
  });
}

function groupMembers(pgid) {
  const members = [];
  for (const pid of readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) === pgid && !['Z', 'X'].includes(fields[0])) members.push(Number(pid));
    } catch {}
  }
  return members;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  supervise(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
