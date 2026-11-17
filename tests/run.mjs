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
//   node tests/run.mjs [node --test arguments]   (default: tests/*.test.mjs)
import { spawn } from 'node:child_process';
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
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, PATH, FACTOTUM_TEST_PROVIDER_STUBS: stubs, TMPDIR: dir, TMP: dir, TEMP: dir } });
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('exit', (code, signal) => { cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
