import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATTEMPT_ENVIRONMENT_KEYS, resolveCommand, serviceEnvironment, supervisedEnvironment } from '../core/attempt-environment.mjs';
import { runProcess } from '../adapters/providers/index.mjs';
import { unitName } from './services.mjs';

// Doctor: an attempt unit must run checks and providers with the same `node` and `git` as the
// project service. A short transient unit (`systemd-run --user --wait`, about a second; well
// inside doctor's margin) builds its environment exactly as a supervisor does from an intent
// that records the running service's environment, and writes what `node` and `git` resolve to
// there into a private directory. No provider, check or Git process is started.
//
// The unit is the user manager's, not a child of doctor: it gets a runtime limit (RuntimeMaxSec)
// shorter than doctor's wait, and a probe that times out or fails is stopped by its exact unit
// name. It is started without --pipe, so it never holds doctor's pipes, and doctor stops waiting
// at its own deadline whatever the systemd-run client does.
export const ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000, SHOW_TIMEOUT_MS = 10_000, GRACE_MS = 3_000;
const COMMANDS = ['node', 'git'];
const probeScript = fileURLToPath(import.meta.url);

const resolved = path => Object.fromEntries(COMMANDS.map(name => [name, resolveCommand(name, path)]));
const shown = entry => entry ? (entry.realPath !== entry.path ? `${entry.path} (${entry.realPath})` : entry.path) : 'nothing';
// A call that cannot keep doctor past its own bound: a client whose output stays open is left behind.
const bounded = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not return within ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(timer)); };
const inUnit = (cgroupText, unit) => String(cgroupText).split('\n').find(line => line.startsWith('0::'))?.slice(3).split('/').includes(unit) ?? false;
const environFrom = text => Object.fromEntries(String(text).split('\0').filter(Boolean).map(entry => [entry.slice(0, entry.indexOf('=')), entry.slice(entry.indexOf('=') + 1)]).filter(([key]) => ATTEMPT_ENVIRONMENT_KEYS.includes(key)));

// The environment the running project service has, which is what its engine records in each
// attempt's intent: doctor's own when doctor runs inside the service (a console-requested doctor),
// otherwise the service's main process's, read from /proc (same account). The unit's configured
// Environment= is not used: it misses EnvironmentFile= and an edit reloaded but not restarted.
// Only the allowlisted variables are kept. Null, with why, when it cannot be established.
export async function runningServiceEnvironment({ service, run = runProcess, source = process.env, procRoot = '/proc' }) {
  try { if (inUnit(readFileSync(join(procRoot, 'self', 'cgroup'), 'utf8'), service)) return { environment: serviceEnvironment(source), from: `${service} (doctor runs in it)` }; } catch {}
  let pid;
  try {
    const result = await bounded(run('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', service], { env: process.env, timeoutMs: SHOW_TIMEOUT_MS }), SHOW_TIMEOUT_MS + GRACE_MS, 'systemctl show');
    pid = result.code === 0 ? Number(String(result.stdout).trim()) : NaN;
  } catch (error) { return { environment: null, why: `systemctl --user show ${service} failed (${error.message})` }; }
  if (!Number.isSafeInteger(pid) || pid <= 0) return { environment: null, why: `${service} is not running` };
  try {
    if (!inUnit(readFileSync(join(procRoot, String(pid), 'cgroup'), 'utf8'), service)) return { environment: null, why: `process ${pid} is not in ${service}` };
    const environment = serviceEnvironment(environFrom(readFileSync(join(procRoot, String(pid), 'environ'))));
    if (!environment.PATH) return { environment: null, why: `${service} (process ${pid}) has no PATH` };
    return { environment, from: `${service} (running, process ${pid})` };
  } catch (error) { return { environment: null, why: `the environment of ${service} (process ${pid}) could not be read (${error.code ?? error.message})` }; }
}

export async function probeAttemptEnvironment({ project, stateDir, run = runProcess, source = process.env, procRoot = '/proc', timeoutMs = ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS } = {}) {
  const reasons = [], warnings = [], service = unitName('project', project.projectId);
  const running = await runningServiceEnvironment({ service, run, source, procRoot });
  if (!running.environment) {
    warnings.push(`Not verified that attempt units run the project service's node and git: ${running.why}. Start the project service and run doctor again`);
    return { reasons, warnings, record: { status: 'unverified', reason: running.why } };
  }
  const { environment, from } = running, expected = resolved(environment.PATH);
  for (const name of COMMANDS) if (!expected[name]) warnings.push(`The project service's PATH (from ${from}) has no ${name}; checks and providers that run ${name} will fail. Reinstall the service from a shell whose PATH has it (service install project --replace)`);
  const record = { status: 'unverified', pathFrom: from, service: expected };
  // A private directory in the project's state, which attempt units can always reach (a drop-in
  // can give them a private /tmp); removed afterwards.
  const unit = `factotum-${project.projectId.slice(0, 8)}-doctor-env-${randomBytes(4).toString('hex')}`;
  let dir, probed, stop = false;
  try {
    mkdirSync(join(stateDir, 'doctor-probes'), { recursive: true, mode: 0o700 });
    dir = mkdtempSync(join(stateDir, 'doctor-probes', 'attempt-environment-'));
    const request = join(dir, 'request.json');
    writeFileSync(request, JSON.stringify({ environment }), { mode: 0o600 });
    const limitSec = Math.max(1, Math.floor(timeoutMs / 2000));
    stop = true;
    const result = await bounded(run('systemd-run', ['--user', '--wait', '--collect', '--quiet', `--unit=${unit}`, '--property=Type=exec', `--property=RuntimeMaxSec=${limitSec}`, process.execPath, probeScript, request], { env: process.env, timeoutMs }), timeoutMs + GRACE_MS, 'systemd-run');
    if (result.code !== 0) throw new Error(`systemd-run exited ${result.code}: ${String(result.stderr ?? '').trim().slice(0, 300)}`);
    try { probed = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); } catch { throw new Error('the probe unit wrote no result'); }
    stop = false;
  } catch (error) {
    warnings.push(`Could not check which node and git an attempt unit runs (${error.message}); checks and providers may run a different node or git than the project service`);
    return { reasons, warnings, record };
  } finally {
    // A probe that timed out or failed is stopped by its own name, never by a pattern.
    if (stop) { try { await bounded(run('systemctl', ['--user', 'stop', unit], { env: process.env, timeoutMs: STOP_TIMEOUT_MS }), STOP_TIMEOUT_MS + GRACE_MS, 'systemctl stop'); } catch {} }
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
  }
  Object.assign(record, { status: 'same', attempt: probed.attempt, manager: probed.manager });
  for (const name of COMMANDS) {
    const want = expected[name], got = probed.attempt?.[name];
    if ((want?.realPath ?? null) === (got?.realPath ?? null)) continue;
    record.status = 'differs';
    reasons.push(`An attempt unit resolves ${name} to ${shown(got)}, but the project service resolves it to ${shown(want)} (service PATH from ${from}), so checks and providers would run a different ${name} than the service. Attempt units take PATH from the service; remove any drop-in for this project's attempt units (factotum-${project.projectId.slice(0, 8)}-*) that hides or replaces it, then run doctor again`);
  }
  return { reasons, warnings, record };
}

// Inside the probe unit: the supervisor's environment for an intent recording the service's.
if (process.argv[1] === probeScript) {
  const request = process.argv[2], { environment } = JSON.parse(readFileSync(request, 'utf8'));
  const env = supervisedEnvironment({ synthetic: false, environment }), out = join(dirname(request), 'result.json');
  writeFileSync(`${out}.tmp`, JSON.stringify({ attempt: resolved(env.PATH), manager: resolved(process.env.PATH) }), { mode: 0o600 });
  renameSync(`${out}.tmp`, out);
}
