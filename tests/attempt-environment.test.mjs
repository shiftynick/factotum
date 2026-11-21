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
import { probeAttemptEnvironment } from '../starter/factory/operations/attempt-environment-probe.mjs';
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

// Doctor's check. Stand-ins: systemctl (the running service's MainPID, and `stop`), systemd-run
// (the user manager, which starts the probe with its own PATH and HOME) and a fake /proc with the
// service's main process.
function probeFixture(t, { mainPid = '4242', selfInService = false, pidCgroup = 'factotum-project-fictiona.service' } = {}) {
  const env = toolchains(t), stateDir = join(env.base, 'state'), proc = join(env.base, 'proc'), calls = join(env.base, 'systemctl.calls'); mkdirSync(stateDir);
  // The unit's configured Environment= is stale (edited, reloaded, not restarted); it must not be used.
  writeFileSync(join(env.standIn, 'systemctl'), `#!/bin/sh\necho "$@" >> ${sh(calls)}\n[ "$2" = "show" ] && [ "$4" = "MainPID" ] && { echo ${sh(mainPid)}; exit 0; }\n[ "$2" = "show" ] && [ "$4" = "Environment" ] && { echo 'PATH=/stale/configured/bin'; exit 0; }\n[ "$2" = "stop" ] && exit 0\nexit 1\n`, { mode: 0o755 });
  mkdirSync(join(proc, 'self'), { recursive: true }); mkdirSync(join(proc, '4242'));
  writeFileSync(join(proc, 'self', 'cgroup'), `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${selfInService ? 'factotum-project-fictiona.service' : 'fictional-terminal.scope'}\n`);
  writeFileSync(join(proc, '4242', 'cgroup'), `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${pidCgroup}\n`);
  // The running service's environment: its PATH (from an EnvironmentFile=, say) and a credential that must not travel.
  writeFileSync(join(proc, '4242', 'environ'), [`PATH=${env.servicePath}`, `HOME=${env.base}`, 'USER=fictional-service', 'GITHUB_TOKEN=ghp_fictional', 'LD_PRELOAD=/fictional.so', ''].join('\0'));
  const systemctlCalls = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  const runCalls = () => existsSync(join(env.base, 'systemd-run.calls')) ? readFileSync(join(env.base, 'systemd-run.calls'), 'utf8').trim().split('\n') : [];
  const probe = (options = {}) => withPathAsync(`${env.standIn}:${env.managerPath}`, () => probeAttemptEnvironment({ project: { projectId: 'fictional0123456789', root: env.base }, stateDir, procRoot: proc, source: { ...process.env, PATH: env.managerPath }, ...options }));
  return { env, stateDir, proc, probe, systemctlCalls, runCalls };
}
// The user manager stand-in for the probe: keeps a copy of the request, then runs the probe in the foreground.
function standInProbeRun(env) {
  writeFileSync(join(env.standIn, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${sh(join(env.base, 'systemd-run.calls'))}\nfor a; do last="$a"; done\ncp "$last" ${sh(join(env.base, 'request-copy.json'))}\nwhile [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done\nexec env -i PATH=${sh(env.managerPath)} HOME=${sh(env.managerHome)} "$@"\n`, { mode: 0o755 });
}
const unitOf = line => line.match(/--unit=(\S+)/)[1];

test('doctor: the probe uses the running service\'s environment, has a runtime limit, no --pipe, and passes when the unit resolves the service node and git', async t => {
  const f = probeFixture(t); standInProbeRun(f.env);
  const probed = await f.probe();
  assert.deepEqual(probed.reasons, []); assert.deepEqual(probed.warnings, []);
  assert.equal(probed.record.status, 'same'); assert.equal(probed.record.pathFrom, 'factotum-project-fictiona.service (running, process 4242)');
  assert.equal(probed.record.service.node.path, join(f.env.serviceBin, 'node')); assert.equal(probed.record.attempt.node.realPath, realpathSync(process.execPath));
  assert.equal(probed.record.manager.node.path, join(f.env.managerBin, 'node'), 'the unit\'s own (manager) PATH would have given the shim');
  // The running process's allowlisted variables, not the unit's configured Environment= and no credential.
  assert.deepEqual(JSON.parse(readFileSync(join(f.env.base, 'request-copy.json'), 'utf8')), { environment: { PATH: f.env.servicePath, HOME: f.env.base, USER: 'fictional-service' } });
  assert.deepEqual(f.systemctlCalls(), ['--user show -p MainPID --value factotum-project-fictiona.service'], 'nothing stopped after a probe that finished');
  const [call] = f.runCalls();
  assert.match(call, /^--user --wait --collect --quiet --unit=factotum-fictiona-doctor-env-[0-9a-f]{8} --property=Type=exec --property=RuntimeMaxSec=15 \S+ \S+attempt-environment-probe\.mjs \S+\/doctor-probes\/attempt-environment-[^/]+\/request\.json$/);
  assert.doesNotMatch(call, /--pipe/);
  assert.deepEqual(readdirSync(join(f.stateDir, 'doctor-probes')), [], 'the private probe directory is removed');
});

test('doctor: run inside the project service, the probe uses the service\'s own environment', async t => {
  const f = probeFixture(t, { selfInService: true }); standInProbeRun(f.env);
  const probed = await f.probe({ source: { PATH: f.env.servicePath, HOME: f.env.base, GITHUB_TOKEN: 'ghp_fictional' } });
  assert.equal(probed.record.status, 'same'); assert.equal(probed.record.pathFrom, 'factotum-project-fictiona.service (doctor runs in it)');
  assert.deepEqual(JSON.parse(readFileSync(join(f.env.base, 'request-copy.json'), 'utf8')).environment, { PATH: f.env.servicePath, HOME: f.env.base });
  assert.deepEqual(f.systemctlCalls(), []);
});

test('doctor: when the running service\'s environment cannot be established the check is unverified, never same', async t => {
  for (const [options, why] of [[{ mainPid: '0' }, /factotum-project-fictiona\.service is not running/], [{ pidCgroup: 'another.service' }, /process 4242 is not in factotum-project-fictiona\.service/]]) {
    const f = probeFixture(t, options); standInProbeRun(f.env);
    const probed = await f.probe();
    assert.equal(probed.record.status, 'unverified'); assert.deepEqual(probed.reasons, []);
    assert.equal(probed.warnings.length, 1); assert.match(probed.warnings[0], /^Not verified that attempt units run the project service's node and git: /); assert.match(probed.warnings[0], why);
    assert.deepEqual(f.runCalls(), [], 'no probe unit is started');
  }
  const unreadable = probeFixture(t); standInProbeRun(unreadable.env); rmSync(join(unreadable.proc, '4242', 'environ'));
  const probed = await unreadable.probe();
  assert.equal(probed.record.status, 'unverified'); assert.match(probed.warnings[0], /could not be read \(ENOENT\)/);
});

test('doctor: an attempt unit that resolves a different node or git is a blocking reason with the remedy', async t => {
  const f = probeFixture(t);
  // A unit that ignores the recorded environment (as attempt units did before dev.104).
  const resolver = new URL('../starter/factory/core/attempt-environment.mjs', import.meta.url).href;
  writeFileSync(join(f.env.standIn, 'systemd-run'), `#!${process.execPath}\nconst { dirname, join } = require('node:path'), request = process.argv[process.argv.length - 1];\nimport(${JSON.stringify(resolver)}).then(({ resolveCommand }) => { const path = ${JSON.stringify(f.env.managerPath)}; const r = { node: resolveCommand('node', path), git: resolveCommand('git', path) }; require('node:fs').writeFileSync(join(dirname(request), 'result.json'), JSON.stringify({ attempt: r, manager: r })); });\n`, { mode: 0o755 });
  const probed = await f.probe();
  assert.equal(probed.record.status, 'differs');
  assert.equal(probed.reasons.length, 2, probed.reasons.join(' | '));
  assert.match(probed.reasons[0], new RegExp(`^An attempt unit resolves node to ${join(f.env.managerBin, 'node')}, but the project service resolves it to ${join(f.env.serviceBin, 'node')} \\(`));
  assert.match(probed.reasons[0], /remove any drop-in for this project's attempt units \(factotum-fictiona-\*\)/);
  assert.match(probed.reasons[1], /resolves git to .*manager-bin\/git/);
});

test('doctor: a failed probe unit is stopped by its exact name and reported as a warning', async t => {
  const f = probeFixture(t);
  writeFileSync(join(f.env.standIn, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${sh(join(f.env.base, 'systemd-run.calls'))}\necho "Failed to connect to bus" >&2\nexit 1\n`, { mode: 0o755 });
  const probed = await f.probe();
  assert.deepEqual(probed.reasons, []); assert.equal(probed.record.status, 'unverified');
  assert.match(probed.warnings.join(), /Could not check which node and git an attempt unit runs \(systemd-run exited 1: Failed to connect to bus\)/);
  assert.deepEqual(f.systemctlCalls().slice(1), [`--user stop ${unitOf(f.runCalls()[0])}`]);
  assert.deepEqual(readdirSync(join(f.stateDir, 'doctor-probes')), []);
});

// The reviewer's case: the transient unit belongs to the user manager, so killing the systemd-run
// client does not stop it, and something holding the client's output open must not keep doctor
// waiting. Here a process in its own session holds systemd-run's stdout and stderr open.
test('doctor: a probe that hangs with its output held open returns within the bound, and its unit is stopped by name', async t => {
  const f = probeFixture(t), holder = join(f.env.base, 'holder.pid');
  // Read now: the fixture directory is removed by an earlier-registered cleanup.
  let holderPid = null; const release = () => { try { holderPid ??= Number(readFileSync(holder, 'utf8')); } catch {} if (holderPid) { try { process.kill(holderPid, 'SIGKILL'); } catch {} } };
  t.after(release);
  writeFileSync(join(f.env.standIn, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${sh(join(f.env.base, 'systemd-run.calls'))}\nsetsid sh -c 'echo $$ > ${holder.replace(/'/g, '')}; exec sleep 600' &\nexec sleep 600\n`, { mode: 0o755 });
  const started = Date.now();
  const probed = await f.probe({ timeoutMs: 2000 });
  const elapsed = Date.now() - started;
  await until(() => existsSync(holder)); release();
  assert.ok(elapsed < 2000 + 3000 + 2500, `returned after ${elapsed} ms`);
  assert.equal(probed.record.status, 'unverified'); assert.deepEqual(probed.reasons, []);
  assert.match(probed.warnings.join(), /Could not check which node and git an attempt unit runs \(systemd-run did not return within 5 s\)/);
  const [call] = f.runCalls();
  assert.match(call, /--property=RuntimeMaxSec=1 /, 'the unit has a runtime limit shorter than doctor\'s wait');
  assert.deepEqual(f.systemctlCalls().slice(1), [`--user stop ${unitOf(call)}`], 'exactly that unit, never a pattern');
});
