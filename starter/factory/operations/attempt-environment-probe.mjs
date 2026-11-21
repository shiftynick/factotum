import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCommand, serviceEnvironment, supervisedEnvironment } from '../core/attempt-environment.mjs';
import { runProcess } from '../adapters/providers/index.mjs';
import { unitName } from './services.mjs';

// Doctor: an attempt unit must run checks and providers with the same `node` and `git` as the
// project service. A short transient unit (`systemd-run --user --wait`, about a second; well
// inside doctor's margin) builds its environment exactly as a supervisor does from an intent
// that records the service's environment, and reports what `node` and `git` resolve to there.
// No provider, check or Git process is started.
export const ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS = 30_000;
const COMMANDS = ['node', 'git'];
const probeScript = fileURLToPath(import.meta.url);

// `systemctl show -p Environment --value` prints NAME=value words, quoting a word with spaces.
export function parseUnitEnvironment(text = '') {
  const values = {};
  for (const match of String(text).trim().matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const word = match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2], at = word.indexOf('=');
    if (at > 0) values[word.slice(0, at)] = word.slice(at + 1);
  }
  return values;
}
const resolved = path => Object.fromEntries(COMMANDS.map(name => [name, resolveCommand(name, path)]));
const shown = entry => entry ? (entry.realPath !== entry.path ? `${entry.path} (${entry.realPath})` : entry.path) : 'nothing';

export async function probeAttemptEnvironment({ project, stateDir, run = runProcess, source = process.env, timeoutMs = ATTEMPT_ENVIRONMENT_PROBE_TIMEOUT_MS } = {}) {
  const reasons = [], warnings = [], service = unitName('project', project.projectId);
  // The service's own environment: its unit's Environment= lines, drop-ins included. Doctor may
  // run from a shell whose PATH is neither the service's nor the user manager's.
  let unitValues = {};
  try { const result = await run('systemctl', ['--user', 'show', '-p', 'Environment', '--value', service], { env: process.env, timeoutMs: 10_000 }); if (result.code === 0) unitValues = parseUnitEnvironment(result.stdout); } catch {}
  const from = unitValues.PATH ? service : 'doctor (the project service unit sets no PATH or is not installed)';
  const environment = serviceEnvironment({ ...source, ...unitValues });
  const expected = resolved(environment.PATH);
  for (const name of COMMANDS) if (!expected[name]) warnings.push(`The project service's PATH (from ${from}) has no ${name}; checks and providers that run ${name} will fail. Reinstall the service from a shell whose PATH has it (service install project --replace)`);
  const record = { status: 'unprobed', pathFrom: from, service: expected };
  const dir = join(stateDir, 'doctor-probes'), file = join(dir, `attempt-environment-${randomBytes(6).toString('hex')}.json`);
  let probed;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify({ environment }), { mode: 0o600 });
    const unit = `factotum-${project.projectId.slice(0, 8)}-doctor-env-${randomBytes(4).toString('hex')}`;
    const result = await run('systemd-run', ['--user', '--wait', '--pipe', '--collect', '--quiet', `--unit=${unit}`, '--property=Type=exec', process.execPath, probeScript, file], { env: process.env, timeoutMs });
    if (result.code !== 0) throw new Error(`systemd-run exited ${result.code}: ${String(result.stderr ?? '').trim().slice(0, 300)}`);
    probed = JSON.parse(String(result.stdout ?? '').trim().split('\n').pop());
  } catch (error) {
    warnings.push(`Could not check which node and git an attempt unit runs (${error.message}); checks and providers may run a different node or git than the project service`);
    return { reasons, warnings, record };
  } finally { try { rmSync(file, { force: true }); } catch {} }
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
  const { environment } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const env = supervisedEnvironment({ synthetic: false, environment });
  console.log(JSON.stringify({ attempt: resolved(env.PATH), manager: resolved(process.env.PATH) }));
}
