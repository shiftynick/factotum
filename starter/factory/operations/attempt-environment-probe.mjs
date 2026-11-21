import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, serviceEnvironment, supervisedEnvironment } from '../core/attempt-environment.mjs';
import { now } from '../core/contracts.mjs';
import { executorDigest } from '../core/effects.mjs';
import { runProcess } from '../adapters/providers/index.mjs';
import { recordAttemptEnvironmentCheck } from './attempt-environment-record.mjs';

// An attempt unit must run checks and providers with the same `node` and `git` as the project
// service. The running project service checks this itself (dev.105), with its own environment,
// which is exactly what its engine records in each attempt's intent: at start, in the background,
// and again after a configuration change. A short transient unit (`systemd-run --user --wait`,
// about a second) builds its environment exactly as a supervisor does from an intent recording
// that environment, and writes what `node` and `git` resolve to there into a private directory.
// No provider, check or Git process is started. The result is recorded in project state
// (operations/attempt-environment-record.mjs), where doctor, status and the console read it.
//
// The unit is the user manager's, not a child of the service: it gets a runtime limit
// (RuntimeMaxSec) shorter than the service's wait, and a probe that times out or fails is stopped
// by its exact unit name. It is started without --pipe, so it never holds the service's pipes, and
// the service stops waiting at its own deadline whatever the systemd-run client does.
export const ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000, GRACE_MS = 3_000;
const COMMANDS = ['node', 'git'];
const probeScript = fileURLToPath(import.meta.url);

const resolved = path => Object.fromEntries(COMMANDS.map(name => [name, resolveCommand(name, path)]));
const shown = entry => entry ? (entry.realPath !== entry.path ? `${entry.path} (${entry.realPath})` : entry.path) : 'nothing';
// A call that cannot keep the service past its own bound: a client whose output stays open is left behind.
const bounded = (promise, ms, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not return within ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(timer)); };

// environment: the service's own allowlisted variables (serviceEnvironment(process.env) in the
// service), as its engine records them in an intent.
export async function probeAttemptEnvironment({ project, stateDir, environment, from = 'the project service', run = runProcess, timeoutMs = ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS } = {}) {
  const reasons = [], warnings = [];
  if (!environment?.PATH) {
    warnings.push(`Not verified that attempt units run the project service's node and git: ${from} has no PATH`);
    return { reasons, warnings, record: { status: 'unverified', reason: `${from} has no PATH` } };
  }
  const expected = resolved(environment.PATH);
  for (const name of COMMANDS) if (!expected[name]) warnings.push(`The project service's PATH (from ${from}) has no ${name}; checks and providers that run ${name} will fail. Reinstall the service from a shell whose PATH has it (service install project --replace)`);
  const record = { status: 'unverified', pathFrom: from, service: expected };
  // A private directory in the project's state, which attempt units can always reach (a drop-in
  // can give them a private /tmp); removed afterwards.
  const unit = `factotum-${project.projectId.slice(0, 8)}-env-probe-${randomBytes(4).toString('hex')}`;
  let dir, probed, stop = false;
  try {
    mkdirSync(join(stateDir, 'environment-probes'), { recursive: true, mode: 0o700 });
    dir = mkdtempSync(join(stateDir, 'environment-probes', 'attempt-environment-'));
    const request = join(dir, 'request.json');
    writeFileSync(request, JSON.stringify({ environment: serviceEnvironment(environment) }), { mode: 0o600 });
    const limitSec = Math.max(1, Math.floor(timeoutMs / 2000));
    stop = true;
    const result = await bounded(run('systemd-run', ['--user', '--wait', '--collect', '--quiet', `--unit=${unit}`, '--property=Type=exec', `--property=RuntimeMaxSec=${limitSec}`, process.execPath, probeScript, request], { env: process.env, timeoutMs }), timeoutMs + GRACE_MS, 'systemd-run');
    if (result.code !== 0) throw new Error(`systemd-run exited ${result.code}: ${String(result.stderr ?? '').trim().slice(0, 300)}`);
    try { probed = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')); } catch { throw new Error('the probe unit wrote no result'); }
    stop = false;
  } catch (error) {
    warnings.push(`Could not check which node and git an attempt unit runs (${error.message}); checks and providers may run a different node or git than the project service`);
    return { reasons, warnings, record: { ...record, reason: error.message } };
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
    reasons.push(`An attempt unit resolves ${name} to ${shown(got)}, but the project service resolves it to ${shown(want)} (service PATH from ${from}), so checks and providers would run a different ${name} than the service. Attempt units take PATH from the service; remove any drop-in for this project's attempt units (factotum-${project.projectId.slice(0, 8)}-*) that hides or replaces it, then restart the project service, which checks again when it starts`);
  }
  return { reasons, warnings, record };
}

// The check the running project service makes (service/project-service.mjs starts it in the
// background and never waits for it to start serving). The `process` supervisor starts attempts
// from the service process itself, which passes its own environment: nothing to probe, recorded
// as not-applicable. Under `systemd` the probe above runs with the service's own environment.
// The result is recorded unless the service is closing meanwhile.
export async function checkAttemptEnvironment(store, { trigger = 'start', source = process.env, run = runProcess, timeoutMs = ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS, executor = executorDigest(), closing = () => false } = {}) {
  const project = store.meta('project'), configDigest = store.meta('configDigest') ?? null, startedAt = now();
  let result;
  if (project.supervisor !== 'systemd') result = { status: 'not-applicable', reason: `the ${project.supervisor} supervisor starts attempts from the project service itself, with its environment` };
  else {
    const probed = await probeAttemptEnvironment({ project, stateDir: store.stateDir, environment: serviceEnvironment(source), from: 'the project service', run, timeoutMs });
    result = { ...probed.record, reasons: probed.reasons, warnings: probed.warnings };
  }
  if (closing()) return null;
  return recordAttemptEnvironmentCheck(store, { ...result, trigger, startedAt, checkedAt: now(), executorDigest: executor, configDigest, supervisor: project.supervisor });
}

// Inside the probe unit: the supervisor's environment for an intent recording the service's.
if (process.argv[1] === probeScript) {
  const request = process.argv[2], { environment } = JSON.parse(readFileSync(request, 'utf8'));
  const env = supervisedEnvironment({ synthetic: false, environment }), out = join(dirname(request), 'result.json');
  writeFileSync(`${out}.tmp`, JSON.stringify({ attempt: resolved(env.PATH), manager: resolved(process.env.PATH) }), { mode: 0o600 });
  renameSync(`${out}.tmp`, out);
}
