// Runs the test suite with its own short temporary directory, removed afterwards.
//
// Tests create temporary directories under os.tmpdir(), and some fixtures leave theirs behind
// when a test fails or is killed. Running every test with TMPDIR set to one fresh directory per
// run keeps the shared /tmp clean whatever the tests do. The directory sits directly under the
// system temporary directory with a short name, because project services in the tests listen on
// Unix sockets whose paths are limited to about 100 bytes.
//
//   node tests/run.mjs [node --test arguments]   (default: tests/*.test.mjs)
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const base = process.env.FACTOTUM_TEST_TMP_BASE || '/tmp';
const dir = mkdtempSync(join(base, 'fct-run-'));
const here = new URL('.', import.meta.url).pathname;
const args = process.argv.slice(2);
const files = args.length ? args : readdirSync(here).filter(name => name.endsWith('.test.mjs')).sort().map(name => join(here, name));
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', env: { ...process.env, TMPDIR: dir, TMP: dir, TEMP: dir } });
const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } };
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('exit', (code, signal) => { cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
