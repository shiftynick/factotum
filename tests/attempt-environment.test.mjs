import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox, until } from './helpers.mjs';
import { atomicJSON, digest, uid } from '../starter/factory/core/contracts.mjs';
import { attemptDir, launch } from '../starter/factory/core/effects.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { ATTEMPT_ENVIRONMENT_KEYS, serviceEnvironment, supervisedEnvironment } from '../starter/factory/core/attempt-environment.mjs';
import { parseUnitEnvironment, probeAttemptEnvironment } from '../starter/factory/operations/attempt-environment-probe.mjs';
import { setTargetHealth } from '../starter/factory/operations/targets.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

// Reported by the third adopter: an attempt unit started with `systemd-run --user` inherits the
// user manager's environment, not the project service's. The manager's PATH started with a
// version manager's shims, which resolved `node` to a different Node than the service's pinned
// one, so main checks ran the wrong Node and main.verify went falsely red. Builders got the same
// PATH. Here the "user manager" is a stand-in `systemd-run` on PATH that starts its command with a
// different PATH and HOME; the real user manager is never used.
const supervisorScript = fileURLToPath(new URL('../starter/factory/core/supervisor.mjs', import.meta.url));
const providersModule = new URL('../starter/factory/adapters/providers/index.mjs', import.meta.url).href;
const sh = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

// A service PATH whose `node` is this Node (through a symlink), and a manager PATH whose `node`
// and `git` are shims that fail.
function toolchains(t) {
  const base = mkdtempSync(join(tmpdir(), 'fct-env-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const serviceBin = join(base, 'service-bin'), managerBin = join(base, 'manager-bin'), standIn = join(base, 'stand-in'), managerHome = join(base, 'manager-home');
  for (const dir of [serviceBin, managerBin, standIn, managerHome]) mkdirSync(dir);
  symlinkSync(process.execPath, join(serviceBin, 'node'));
  for (const name of ['node', 'git']) writeFileSync(join(managerBin, name), `#!/bin/sh\necho "manager ${name} shim" >&2\nexit 7\n`, { mode: 0o755 });
  const prior = process.env.PATH;
  return { base, serviceBin, managerBin, standIn, managerHome, servicePath: `${serviceBin}:${prior}`, managerPath: `${managerBin}:${prior}`, prior };
}
// The stand-in user manager: drops systemd-run's options and starts the command with its own
// environment, detached (an attempt launch) or in the foreground with its output (a --wait probe).
function standInSystemdRun(env, { wait = false } = {}) {
  const start = `env -i PATH=${sh(env.managerPath)} HOME=${sh(env.managerHome)} SSH_AUTH_SOCK=/fictional/manager-agent "$@"`;
  writeFileSync(join(env.standIn, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${sh(join(env.base, 'systemd-run.calls'))}\nwhile [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done\n${wait ? `exec ${start}` : `${start} >/dev/null 2>&1 &`}\n`, { mode: 0o755 });
}
async function withPathAsync(path, fn) {
  const prior = process.env.PATH; process.env.PATH = path;
  try { return await fn(); } finally { process.env.PATH = prior; }
}
const writeIntent = (dir, intent) => { const path = join(dir, 'intent.json'); atomicJSON(path, { ...intent, intentDigest: digest(intent) }); return path; };
// Runs a supervisor the way the user manager would: with the manager's PATH and HOME, not the service's.
const superviseAsManager = (env, path) => spawnSync(process.execPath, [supervisorScript, path], { env: { PATH: env.managerPath, HOME: env.managerHome, SSH_AUTH_SOCK: '/fictional/manager-agent' }, encoding: 'utf8', timeout: 60000 });

test('an attempt intent records the service environment under its digest; a changed one is refused before anything starts', async t => {
  const env = toolchains(t), f = sandbox(t); f.start();
  await withPathAsync(env.servicePath, () => f.engine.tick());
  const attempt = f.store.all('attempt')[0];
  assert.deepEqual(attempt.intent.environment, { PATH: env.servicePath }, 'a synthetic attempt records PATH alone');
  const saved = JSON.parse(readFileSync(join(attemptDir(f.store, attempt), 'intent.json'), 'utf8'));
  assert.deepEqual(saved.environment, { PATH: env.servicePath }); assert.equal(saved.intentDigest, attempt.intentDigest);
  // A real attempt records exactly the variables a supervisor passed on before, nothing more.
  const source = { PATH: '/service/bin', HOME: '/service/home', USER: 'fictional', GITHUB_TOKEN: 'ghp_fictional', ANTHROPIC_API_KEY: 'fictional', LD_PRELOAD: '/fictional.so', SSH_AUTH_SOCK: '/fictional/agent' };
  assert.deepEqual(serviceEnvironment(source), { PATH: '/service/bin', HOME: '/service/home', USER: 'fictional', SSH_AUTH_SOCK: '/fictional/agent' });
  assert.deepEqual(ATTEMPT_ENVIRONMENT_KEYS, ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'DBUS_SESSION_BUS_ADDRESS', 'SSH_AUTH_SOCK']);
  // Swapping the recorded PATH after preparation breaks the digest.
  const dir = join(env.base, 'swapped'); mkdirSync(dir);
  atomicJSON(join(dir, 'intent.json'), { ...saved, environment: { PATH: env.managerPath } });
  const swapped = superviseAsManager(env, join(dir, 'intent.json'));
  assert.notEqual(swapped.status, 0); assert.match(swapped.stderr, /intent digest mismatch/); assert.equal(existsSync(join(dir, 'claim')), false);
  // A digest-valid intent may not carry anything outside the allowlist.
  const smuggled = join(env.base, 'smuggled'); mkdirSync(smuggled);
  const result = superviseAsManager(env, writeIntent(smuggled, { version: 1, attemptId: uid(), argv: ['/bin/true'], cwd: env.base, timeoutMs: 10000, synthetic: false, maxCostMicros: 0, environment: { PATH: env.servicePath, GITHUB_TOKEN: 'ghp_fictional' } }));
  assert.notEqual(result.status, 0); assert.match(result.stderr, /intent environment may only carry/); assert.equal(existsSync(join(smuggled, 'claim')), false, 'refused before the claim');
});

test('the supervisor gives the attempt the recorded service environment, not its own (the user manager\'s)', async t => {
  const env = toolchains(t), dir = join(env.base, 'attempt'), out = join(env.base, 'seen.json'); mkdirSync(dir);
  const script = `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, node: require('node:child_process').execSync('command -v node', { encoding: 'utf8' }).trim() }))`;
  const recorded = serviceEnvironment({ PATH: env.servicePath, HOME: env.base, USER: 'fictional-service', LOGNAME: 'fictional-service' });
  superviseAsManager(env, writeIntent(dir, { version: 1, attemptId: uid(), argv: [process.execPath, '-e', script], cwd: env.base, timeoutMs: 30000, synthetic: false, maxCostMicros: 0, environment: recorded }));
  const seen = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(seen.env.PATH, env.servicePath); assert.equal(seen.env.HOME, env.base); assert.equal(seen.env.USER, 'fictional-service');
  assert.equal(seen.env.SSH_AUTH_SOCK, undefined, 'a variable the service does not have is not taken from the manager');
  assert.equal(seen.node, join(env.serviceBin, 'node'));
  assert.deepEqual(Object.keys(seen.env).sort(), ['FACTOTUM_SYNTHETIC', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'PYTHONDONTWRITEBYTECODE', 'USER']);
  // An intent prepared before dev.104 records no environment and keeps reading the supervisor's own.
  assert.deepEqual(supervisedEnvironment({ synthetic: false }, { PATH: '/old', HOME: '/home/old', GITHUB_TOKEN: 'ghp_fictional' }), { PATH: '/old', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', FACTOTUM_SYNTHETIC: 'false', HOME: '/home/old' });
  assert.deepEqual(supervisedEnvironment({ synthetic: true, environment: { PATH: '/service' } }, { PATH: '/manager', HOME: '/home/manager' }), { PATH: '/service', LANG: 'C.UTF-8', PYTHONDONTWRITEBYTECODE: '1', FACTOTUM_SYNTHETIC: 'true' });
});

// main.verify, prepared by the engine in the "service" (this process, with the service PATH) and
// launched through systemd-run (the stand-in, with the manager PATH): the main check sees the
// service's PATH, HOME and node.
test('a main check launched in a systemd attempt unit runs with the service PATH and HOME', async t => {
  const env = toolchains(t), seen = join(env.base, 'check.txt'); standInSystemdRun(env);
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  const ghPath = join(f.base, 'gh'); writeFileSync(ghPath, `#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');`, { mode: 0o700 });
  const providers = { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } };
  const check = { id: 'toolchain', argv: ['sh', '-c', `printf '%s\\n%s\\n%s\\n' "$PATH" "$HOME" "$(command -v node)" > ${sh(seen)}; node -e 'process.exit(0)'`], timeoutMs: 60000 };
  const config = validateConfig({ version: 1, mode: 'delivery', repository: { slug: 'fictional/environment', account: 'fictional', target: 'main', remote: 'origin', ghPath }, providers, mainChecks: [check], checks: [{ id: 'acceptance', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { planning: false, autoQueue: true, maxFlows: 1 } });
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  setTargetHealth(f.store, null, { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() });
  const job = f.command('job.enqueue', { operation: 'main.verify', payload: {}, note: 'Fictional verification' }); assert.equal(job.status, 'completed', job.error);
  // The service prepares the attempt.
  const prepared = await withPathAsync(env.servicePath, async () => {
    await operationalTick(f.store); const flowId = f.store.need('job', job.result.id).flowId;
    await f.engine.step(flowId); return f.store.need('attempt', f.store.need('flow', flowId).attemptId);
  });
  assert.equal(prepared.intent.environment.PATH, env.servicePath); assert.equal(prepared.intent.environment.HOME, process.env.HOME);
  // Without the shared heavy permit (it needs a contained cgroup) or the GitHub account scope (the
  // remote is a local fixture): the environment is what is under test.
  const intent = { ...prepared.intent, action: { ...prepared.intent.action, resource: false, config: { ...prepared.intent.action.config, mode: 'rehearsal' } } }, attempt = { ...prepared, intent, intentDigest: digest(intent), unit: 'factotum-fixture-environment' };
  writeIntent(attemptDir(f.store, attempt), intent);
  f.store.setMeta('project', { ...f.store.meta('project'), supervisor: 'systemd' });
  await withPathAsync(`${env.standIn}:${env.prior}`, () => launch(f.store, attempt));
  assert.match(readFileSync(join(env.base, 'systemd-run.calls'), 'utf8'), /--user --collect --unit=factotum-fixture-environment/);
  const dir = attemptDir(f.store, attempt);
  await until(() => existsSync(join(dir, 'receipt.json')));
  const result = JSON.parse(readFileSync(join(dir, 'action-result.json'), 'utf8'));
  if (!existsSync(seen)) console.error('DEBUG', JSON.stringify(result).slice(0, 3000), readFileSync(join(dir, 'stderr.log'), 'utf8').slice(0, 2000));
  const [path, home, node] = readFileSync(seen, 'utf8').trim().split('\n');
  assert.equal(path, env.servicePath, 'the check ran with the service PATH, not the manager PATH');
  assert.equal(home, process.env.HOME); assert.notEqual(home, env.managerHome);
  assert.equal(node, join(env.serviceBin, 'node'));
  assert.equal(result.mainHealth.status, 'green', JSON.stringify(result.mainHealth));
});

// Builders (and every provider role) take their environment from the dispatcher's, through the
// adapter's subscriptionEnvironment: a provider CLI resolved by name is the service's.
test('a provider CLI started inside a systemd attempt unit is resolved from the service PATH and gets the service HOME', async t => {
  const env = toolchains(t), log = join(env.base, 'claude.log'), dir = join(env.base, 'attempt'); mkdirSync(dir);
  const fake = (who, code) => `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ who: ${JSON.stringify(who)}, PATH: process.env.PATH, HOME: process.env.HOME, args: process.argv.slice(2) }) + '\\n');\nif (process.argv.includes('--version')) console.log('2.1.323 (Fictional)');\nprocess.exit(${code});\n`;
  writeFileSync(join(env.serviceBin, 'claude'), fake('service', 0), { mode: 0o755 });
  writeFileSync(join(env.managerBin, 'claude'), fake('manager', 7), { mode: 0o755 });
  standInSystemdRun(env, { wait: true });
  // The dispatcher's own provider adapter (the module's default one, as dispatch.mjs uses it).
  const script = `const { preflight, subscriptionEnvironment } = await import(${JSON.stringify(providersModule)}); console.log(JSON.stringify(subscriptionEnvironment())); try { await preflight({ provider: 'claude', model: 'fictional', role: 'builder', cwd: process.cwd(), artifactDir: process.cwd(), prompt: 'Fictional', timeoutMs: 10000 }); } catch {}`;
  const recorded = serviceEnvironment({ PATH: env.servicePath, HOME: env.base, USER: 'fictional-service' });
  const path = writeIntent(dir, { version: 1, attemptId: uid(), argv: [process.execPath, '--input-type=module', '-e', script], cwd: env.base, timeoutMs: 60000, synthetic: false, maxCostMicros: 0, environment: recorded });
  const run = spawnSync('systemd-run', ['--user', '--wait', '--collect', '--unit=factotum-fixture-provider', process.execPath, supervisorScript, path], { env: { ...process.env, PATH: `${env.standIn}:${env.prior}` }, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 0, run.stderr);
  const providerEnv = JSON.parse(readFileSync(join(dir, 'stdout.log'), 'utf8').trim().split('\n')[0]);
  assert.equal(providerEnv.PATH, env.servicePath); assert.equal(providerEnv.HOME, env.base); assert.equal(providerEnv.USER, 'fictional-service');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.length > 0, 'the provider CLI was started');
  for (const call of calls) { assert.equal(call.who, 'service', 'never the manager PATH\'s claude'); assert.equal(call.PATH, env.servicePath); assert.equal(call.HOME, env.base); }
});

test('the service unit environment is read from systemctl show, quoted words included', () => {
  assert.deepEqual(parseUnitEnvironment('PATH=/opt/node24/bin:/usr/bin "NOTE=two words" HOME=/home/fictional\n'), { PATH: '/opt/node24/bin:/usr/bin', NOTE: 'two words', HOME: '/home/fictional' });
  assert.deepEqual(parseUnitEnvironment(''), {});
});

// Doctor's check, with stand-in systemctl (the service unit's Environment=) and systemd-run.
function probeFixture(t) {
  const env = toolchains(t), stateDir = join(env.base, 'state'); mkdirSync(stateDir);
  writeFileSync(join(env.standIn, 'systemctl'), `#!/bin/sh\n[ "$3" = "-p" ] && [ "$4" = "Environment" ] && { echo ${sh(`PATH=${env.servicePath}`)}; exit 0; }\nexit 1\n`, { mode: 0o755 });
  return { env, stateDir, project: { projectId: 'fictional0123456789', root: env.base } };
}
test('doctor: an attempt unit that resolves the service node and git passes, and the probe starts no provider', async t => {
  const { env, stateDir, project } = probeFixture(t); standInSystemdRun(env, { wait: true });
  // Doctor itself runs from a shell whose PATH is the manager's: the service's comes from its unit.
  const probed = await withPathAsync(`${env.standIn}:${env.managerPath}`, () => probeAttemptEnvironment({ project, stateDir, source: { ...process.env, PATH: env.managerPath } }));
  assert.deepEqual(probed.reasons, []); assert.deepEqual(probed.warnings, []);
  assert.equal(probed.record.status, 'same'); assert.equal(probed.record.pathFrom, 'factotum-project-fictiona.service');
  assert.equal(probed.record.service.node.path, join(env.serviceBin, 'node')); assert.equal(probed.record.attempt.node.realPath, realpathSync(process.execPath));
  assert.equal(probed.record.manager.node.path, join(env.managerBin, 'node'), 'the unit\'s own (manager) PATH would have given the shim');
  const call = readFileSync(join(env.base, 'systemd-run.calls'), 'utf8');
  assert.match(call, /^--user --wait --pipe --collect --quiet --unit=factotum-fictiona-doctor-env-[0-9a-f]{8} --property=Type=exec /);
  assert.match(call, /attempt-environment-probe\.mjs /);
  assert.deepEqual(readdirSync(join(stateDir, 'doctor-probes')), [], 'the probe file is removed');
});

test('doctor: an attempt unit that resolves a different node or git is a blocking reason with the remedy; an unrunnable probe is a warning', async t => {
  const { env, stateDir, project } = probeFixture(t);
  // A unit that ignores the recorded environment (as attempt units did before dev.104).
  const resolver = new URL('../starter/factory/core/attempt-environment.mjs', import.meta.url).href;
  writeFileSync(join(env.standIn, 'systemd-run'), `#!${process.execPath}\nimport(${JSON.stringify(resolver)}).then(({ resolveCommand }) => { const path = ${JSON.stringify(env.managerPath)}; const r = { node: resolveCommand('node', path), git: resolveCommand('git', path) }; console.log(JSON.stringify({ attempt: r, manager: r })); });\n`, { mode: 0o755 });
  const probed = await withPathAsync(`${env.standIn}:${env.prior}`, () => probeAttemptEnvironment({ project, stateDir }));
  assert.equal(probed.record.status, 'differs');
  assert.equal(probed.reasons.length, 2, probed.reasons.join(' | '));
  assert.match(probed.reasons[0], new RegExp(`^An attempt unit resolves node to ${join(env.managerBin, 'node')}, but the project service resolves it to ${join(env.serviceBin, 'node')} \\(`));
  assert.match(probed.reasons[0], /remove any drop-in for this project's attempt units \(factotum-fictiona-\*\)/);
  assert.match(probed.reasons[1], /resolves git to .*manager-bin\/git/);
  writeFileSync(join(env.standIn, 'systemd-run'), '#!/bin/sh\necho "Failed to connect to bus" >&2\nexit 1\n', { mode: 0o755 });
  const failed = await withPathAsync(`${env.standIn}:${env.prior}`, () => probeAttemptEnvironment({ project, stateDir }));
  assert.deepEqual(failed.reasons, []); assert.equal(failed.record.status, 'unprobed');
  assert.match(failed.warnings.join(), /Could not check which node and git an attempt unit runs \(systemd-run exited 1: Failed to connect to bus\)/);
});
