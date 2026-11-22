// Runs the test suite with its own short temporary directory, removed afterwards.
//
// Tests create temporary directories under os.tmpdir(), and some fixtures leave theirs behind
// when a test fails or is killed. Running every test with TMPDIR set to one fresh directory per
// run keeps the shared /tmp clean whatever the tests do. The directory sits directly under the
// system temporary directory with a short name, because project services in the tests listen on
// Unix sockets whose paths are limited to about 100 bytes.
//
// The run also puts stand-in `claude`, `codex`, `gemini` and `cursor-agent` commands first on
// PATH. Engine-level tests start real supervisor processes that run the real provider adapter,
// and the suite must never start a model session, whatever is installed on the host. A test
// that needs a provider command supplies its own scripted one, ahead of these on PATH.
//
// Where a systemd user manager is available, `node --test` runs in its own transient user
// service (`systemd-run --user`), not as a child of whatever started this script. A run started
// from an agent session's shell otherwise lives in that session's process tree, and on hosts
// where the agent environment kills processes in its tree (SIGKILL from outside the suite; see
// docs/changes/test-suite-external-kills.md), random test files, Git children and fixture
// processes die mid-run. The unit gets this process's environment and working directory, its
// output is this process's output, its exit status is this script's, and stopping this script
// stops the unit. Leftover test processes end with the unit. Without a user manager, or with
// FACTOTUM_TEST_DIRECT=1, the suite runs as a child process as before.
//
//   node tests/run.mjs [node --test arguments]   (default: tests/*.test.mjs)
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.FACTOTUM_TEST_TMP_BASE || '/tmp';
const dir = mkdtempSync(join(base, 'fct-run-'));
const here = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const files = args.length ? args : readdirSync(here).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(here, name));
const stubs = join(dir, 'no-provider-bin');
mkdirSync(stubs);
for (const name of ['claude', 'codex', 'gemini', 'cursor-agent']) {
  writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} is disabled in the Factotum test suite" >&2\nexit 97\n`);
  chmodSync(join(stubs, name), 0o755);
}
const PATH = `${stubs}:${process.env.PATH ?? ''}`;
const env = { ...process.env, PATH, FACTOTUM_TEST_PROVIDER_STUBS: stubs, TMPDIR: dir, TMP: dir, TEMP: dir };
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };

// systemd-run options shared by the probe and the run. Arguments are passed as written (no `$`
// expansion), the unit is removed when it ends whatever its result, and it fails to start if
// `node` cannot be executed.
const UNIT_OPTIONS = ['--user', '--wait', '--collect', '--quiet', '--expand-environment=no', '--service-type=exec'];
function unitsAvailable() {
  if (process.platform !== 'linux' || process.env.FACTOTUM_TEST_DIRECT === '1' || process.env.FACTOTUM_TEST_UNIT) return false;
  const probe = spawnSync('systemd-run', [...UNIT_OPTIONS, 'true'], { env, stdio: 'ignore', timeout: 15000 });
  return probe.status === 0;
}

let child, unit = null;
if (unitsAvailable()) {
  unit = `fct-test-run-${process.pid}-${randomBytes(3).toString('hex')}`;
  // `-E NAME` copies NAME from systemd-run's own environment, which is `env`. systemd refuses
  // names that are not plain identifiers (an exported Bash function, say); those are left out.
  const names = Object.keys(env).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  child = spawn('systemd-run', [...UNIT_OPTIONS, '--pipe', `--unit=${unit}`, `--working-directory=${process.cwd()}`, '--property=TimeoutStopSec=20',
    ...names.flatMap(name => ['-E', name]), '-E', 'FACTOTUM_TEST_UNIT', process.execPath, '--test', ...files],
  { stdio: 'inherit', env: { ...env, FACTOTUM_TEST_UNIT: unit } });
} else {
  child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', env });
}
// systemd-run exits on SIGINT or SIGTERM and leaves the unit running, so on every way out the unit
// is stopped first (SIGTERM to each process in it, SIGKILL after TimeoutStopSec; nothing to do
// once it has ended), and only then is the directory removed.
const stopUnit = () => { if (unit) spawnSync('systemctl', ['--user', 'stop', unit], { stdio: 'ignore', timeout: 30000 }); };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopUnit(); child.kill(signal); });
child.on('exit', (code, signal) => { stopUnit(); cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
