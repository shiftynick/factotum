import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { assert } from './contracts.mjs';

// The environment an attempt runs with comes from the project service, never from whatever
// started the supervisor. A systemd attempt unit is started by the user manager and inherits
// its environment, which can differ from the service's (a version manager's shims first on
// the manager's PATH, a pinned toolchain first on the service's). So the service records the
// values here in the attempt's intent, where the intent digest binds them, and the supervisor
// uses only those values. Nothing is added: these are exactly the variables a supervisor
// passed on before (PATH, and for a real attempt the account and session variables below);
// checks still get only PATH and HOME from them, and providers their own subset.
export const ATTEMPT_ENVIRONMENT_KEYS = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK']);
const usable = value => typeof value === 'string' && value !== '' && !value.includes('\0');

// What the service records for an attempt: PATH alone for a synthetic one, which never gets more.
export function serviceEnvironment(source = process.env, { synthetic = false } = {}) {
  const keys = synthetic ? ['PATH'] : ATTEMPT_ENVIRONMENT_KEYS;
  return Object.fromEntries(keys.filter(key => usable(source[key])).map(key => [key, source[key]]));
}

// The environment the supervisor gives the attempt's process. An intent that records its
// environment gets exactly that; one prepared before dev.104 records none and keeps the old
// behaviour of reading the supervisor's own environment.
export function supervisedEnvironment(intent, source = process.env) {
  const recorded = intent.environment;
  if (recorded !== undefined) {
    assert(recorded && typeof recorded === 'object' && !Array.isArray(recorded), 'intent environment must be an object');
    for (const [key, value] of Object.entries(recorded)) assert(ATTEMPT_ENVIRONMENT_KEYS.includes(key) && usable(value), `intent environment may only carry ${ATTEMPT_ENVIRONMENT_KEYS.join(', ')} as non-empty strings`);
  }
  const from = recorded ?? source, passed = intent.synthetic ? [] : ATTEMPT_ENVIRONMENT_KEYS.filter(key => key !== 'PATH');
  return { PATH: from.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', FACTOTUM_SYNTHETIC: String(intent.synthetic), ...Object.fromEntries(passed.filter(key => from[key]).map(key => [key, from[key]])) };
}

// The executable a bare command name runs under this PATH, as a process lookup finds it:
// the first absolute entry holding an executable regular file. Its real path says which
// binary that is (a version manager's shim and the pinned binary differ there).
export function resolveCommand(name, path = '') {
  for (const entry of String(path).split(':')) {
    if (!isAbsolute(entry)) continue;
    const candidate = join(entry, name);
    try { if (!statSync(candidate).isFile()) continue; accessSync(candidate, constants.X_OK); } catch { continue; }
    let real = candidate; try { real = realpathSync(candidate); } catch {}
    return { path: candidate, realPath: real };
  }
  return null;
}
