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
import { checkAttemptEnvironment, probeAttemptEnvironment } from '../starter/factory/operations/attempt-environment-probe.mjs';
import { NOT_YET_CHECKED, recordedAttemptEnvironment } from '../starter/factory/operations/attempt-environment-record.mjs';
import { executorDigest } from '../starter/factory/core/effects.mjs';
import { runProcess } from '../starter/factory/adapters/providers/index.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { requestProject } from '../starter/factory/console/client.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
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

// The project service's own check (dev.105). Stand-ins only: `systemctl` (for `stop`) and
// `systemd-run` (the user manager, which starts the probe with its own PATH and HOME), reached
// through an injected run that refuses any other command, so the real ones are never started.
const SERVICE_SOURCE = env => ({ PATH: env.servicePath, HOME: env.base, USER: 'fictional-service', GITHUB_TOKEN: 'ghp_fictional', LD_PRELOAD: '/fictional.so' });
function probeFixture(t) {
  const env = toolchains(t), stateDir = join(env.base, 'state'), calls = join(env.base, 'systemctl.calls'); mkdirSync(stateDir);
  writeFileSync(join(env.standIn, 'systemctl'), `#!/bin/sh\necho "$@" >> ${sh(calls)}\n[ "$2" = "stop" ] && exit 0\nexit 1\n`, { mode: 0o755 });
  const run = (command, args, options) => { assert.ok(['systemd-run', 'systemctl'].includes(command), `unexpected command ${command}`); return runProcess(join(env.standIn, command), args, options); };
  const systemctlCalls = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [];
  const runCalls = () => existsSync(join(env.base, 'systemd-run.calls')) ? readFileSync(join(env.base, 'systemd-run.calls'), 'utf8').trim().split('\n') : [];
  const probe = (options = {}) => probeAttemptEnvironment({ project: { projectId: 'fictional0123456789', root: env.base }, stateDir, environment: SERVICE_SOURCE(env), run, ...options });
  return { env, stateDir, probe, run, systemctlCalls, runCalls };
}
// The user manager stand-in for the probe: keeps a copy of the request, then runs the probe in the foreground.
function standInProbeRun(env) {
  writeFileSync(join(env.standIn, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${sh(join(env.base, 'systemd-run.calls'))}\nfor a; do last="$a"; done\ncp "$last" ${sh(join(env.base, 'request-copy.json'))}\nwhile [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done\nexec env -i PATH=${sh(env.managerPath)} HOME=${sh(env.managerHome)} "$@"\n`, { mode: 0o755 });
}
// A unit that ignores the recorded environment (as attempt units did before dev.104, or with a drop-in that replaces PATH).
function standInIgnoringRun(env) {
  const resolver = new URL('../starter/factory/core/attempt-environment.mjs', import.meta.url).href;
  writeFileSync(join(env.standIn, 'systemd-run'), `#!${process.execPath}\nconst { dirname, join } = require('node:path'), request = process.argv[process.argv.length - 1];\nimport(${JSON.stringify(resolver)}).then(({ resolveCommand }) => { const path = ${JSON.stringify(env.managerPath)}; const r = { node: resolveCommand('node', path), git: resolveCommand('git', path) }; require('node:fs').writeFileSync(join(dirname(request), 'result.json'), JSON.stringify({ attempt: r, manager: r })); });\n`, { mode: 0o755 });
}
// A systemd-run client that never returns.
function standInHangingRun(env) { writeFileSync(join(env.standIn, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${sh(join(env.base, 'systemd-run.calls'))}\nexec sleep 600\n`, { mode: 0o755 }); }
const unitOf = line => line.match(/--unit=(\S+)/)[1];

test('the probe uses the service\'s own allowlisted environment, has a runtime limit, no --pipe, and finds the same node and git', async t => {
  const f = probeFixture(t); standInProbeRun(f.env);
  const probed = await f.probe();
  assert.deepEqual(probed.reasons, []); assert.deepEqual(probed.warnings, []);
  assert.equal(probed.record.status, 'same'); assert.equal(probed.record.pathFrom, 'the project service');
  assert.equal(probed.record.service.node.path, join(f.env.serviceBin, 'node')); assert.equal(probed.record.attempt.node.realPath, realpathSync(process.execPath));
  assert.equal(probed.record.manager.node.path, join(f.env.managerBin, 'node'), 'the unit\'s own (manager) PATH would have given the shim');
  assert.deepEqual(JSON.parse(readFileSync(join(f.env.base, 'request-copy.json'), 'utf8')), { environment: { PATH: f.env.servicePath, HOME: f.env.base, USER: 'fictional-service' } }, 'no credential travels');
  assert.deepEqual(f.systemctlCalls(), [], 'nothing stopped after a probe that finished');
  const [call] = f.runCalls();
  assert.match(call, /^--user --wait --collect --quiet --unit=factotum-fictiona-env-probe-[0-9a-f]{8} --property=Type=exec --property=RuntimeMaxSec=15 \S+ \S+attempt-environment-probe\.mjs \S+\/environment-probes\/attempt-environment-[^/]+\/request\.json$/);
  assert.doesNotMatch(call, /--pipe/);
  assert.deepEqual(readdirSync(join(f.stateDir, 'environment-probes')), [], 'the private probe directory is removed');
});

test('an attempt unit that resolves a different node or git is a reason with the remedy', async t => {
  const f = probeFixture(t); standInIgnoringRun(f.env);
  const probed = await f.probe();
  assert.equal(probed.record.status, 'differs');
  assert.equal(probed.reasons.length, 2, probed.reasons.join(' | '));
  assert.match(probed.reasons[0], new RegExp(`^An attempt unit resolves node to ${join(f.env.managerBin, 'node')}, but the project service resolves it to ${join(f.env.serviceBin, 'node')} \\(`));
  assert.match(probed.reasons[0], /remove any drop-in for this project's attempt units \(factotum-fictiona-\*\)/);
  assert.match(probed.reasons[1], /resolves git to .*manager-bin\/git/);
});

test('a failed probe unit is stopped by its exact name and reported as a warning', async t => {
  const f = probeFixture(t);
  writeFileSync(join(f.env.standIn, 'systemd-run'), `#!/bin/sh\necho "$@" >> ${sh(join(f.env.base, 'systemd-run.calls'))}\necho "Failed to connect to bus" >&2\nexit 1\n`, { mode: 0o755 });
  const probed = await f.probe();
  assert.deepEqual(probed.reasons, []); assert.equal(probed.record.status, 'unverified');
  assert.match(probed.warnings.join(), /Could not check which node and git an attempt unit runs \(systemd-run exited 1: Failed to connect to bus\)/);
  assert.deepEqual(f.systemctlCalls(), [`--user stop ${unitOf(f.runCalls()[0])}`]);
  assert.deepEqual(readdirSync(join(f.stateDir, 'environment-probes')), []);
});

// The transient unit belongs to the user manager, so killing the systemd-run client does not stop
// it, and something holding the client's output open must not keep the service waiting. Here a
// process in its own session holds systemd-run's stdout and stderr open.
test('a probe that hangs with its output held open returns within the bound, and its unit is stopped by name', async t => {
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
  assert.match(call, /--property=RuntimeMaxSec=1 /, 'the unit has a runtime limit shorter than the service\'s wait');
  assert.deepEqual(f.systemctlCalls(), [`--user stop ${unitOf(call)}`], 'exactly that unit, never a pattern');
});

// The running project service makes the check itself, in the background, and records it.
function serviceFixture(t) {
  const f = probeFixture(t), s = sandbox(t);
  const providers = { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } };
  const config = validateConfig({ version: 1, mode: 'delivery', repository: { slug: 'fictional/environment', account: 'fictional', target: 'main', remote: 'origin' }, providers, mainChecks: [{ id: 'unit', argv: ['true'], timeoutMs: 60000 }], checks: [{ id: 'acceptance', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { planning: false } });
  s.store.setMeta('config', config); s.store.setMeta('configDigest', digest(config)); s.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  s.store.setMeta('project', { ...s.store.meta('project'), supervisor: 'systemd' });
  s.command('task.approve', { taskId: s.task.id, revision: s.store.need('task', s.task.id).revision });
  const checks = [];
  const environmentCheck = (options = {}) => (store, context) => { checks.push(context.trigger); return checkAttemptEnvironment(store, { ...context, source: SERVICE_SOURCE(f.env), run: f.run, ...options }); };
  const start = async (options = {}, socket = `p${checks.length}.sock`) => {
    const app = await startProjectService({ stateDir: s.stateDir, socketPath: join(s.base, socket), tickMs: 20, operationalIntervalMs: 20, operationTick: async () => {}, environmentCheck: environmentCheck(options) });
    let closed = false; const close = async () => { if (!closed) { closed = true; await app.close(); } }; t.after(close);
    return { app, close };
  };
  const held = () => ({ admission: admissionReasons(s.store, s.store.need('task', s.task.id)).filter(reason => /^attempt units resolve a different node or git/.test(reason)), queue: queueStatus(s.store).holds.filter(row => row.kind === 'attempt-environment') });
  return { ...f, s, start, checks, held };
}

test('the running service checks its attempt environment at start and records same with paths, time and executor', async t => {
  const f = serviceFixture(t); standInProbeRun(f.env);
  const { close } = await f.start();
  await until(() => f.s.store.meta('attemptEnvironmentCheck'));
  const record = f.s.store.meta('attemptEnvironmentCheck');
  assert.equal(record.status, 'same'); assert.equal(record.trigger, 'start'); assert.equal(record.supervisor, 'systemd');
  assert.equal(record.executorDigest, executorDigest()); assert.equal(record.configDigest, f.s.store.meta('configDigest'));
  assert.ok(Number.isFinite(Date.parse(record.checkedAt)));
  assert.equal(record.service.node.path, join(f.env.serviceBin, 'node')); assert.equal(record.attempt.node.realPath, realpathSync(process.execPath));
  assert.deepEqual(f.held(), { admission: [], queue: [] });
  assert.equal(snapshot(f.s.store).health.attemptEnvironment.status, 'same');
  assert.ok(f.s.store.events().some(e => e.type === 'attempt-environment.checked' && e.payload.status === 'same'));
  // After a configuration change the service checks again.
  const changed = { ...f.s.store.meta('config'), policy: { ...f.s.store.meta('config').policy, maxFlows: 2 } };
  f.s.store.setMeta('config', changed); f.s.store.setMeta('configDigest', digest(changed));
  await until(() => f.s.store.meta('attemptEnvironmentCheck').trigger === 'configuration');
  assert.deepEqual(f.checks, ['start', 'configuration']);
  assert.equal(f.s.store.meta('attemptEnvironmentCheck').configDigest, digest(changed));
  // Doctor reads that result: same, under this code.
  const read = recordedAttemptEnvironment({ store: f.s.store, executor: executorDigest() });
  assert.deepEqual(read.reasons, []); assert.deepEqual(read.warnings, []); assert.equal(read.record.status, 'same');
  await close();
});

test('a differs result holds admission while running and is shown; a later start with the drop-in gone clears it', async t => {
  const f = serviceFixture(t); standInIgnoringRun(f.env);
  const first = await f.start();
  await until(() => f.s.store.meta('attemptEnvironmentCheck'));
  assert.equal(f.s.store.meta('attemptEnvironmentCheck').status, 'differs');
  const held = f.held();
  assert.equal(held.admission.length, 1); assert.match(held.admission[0], /checked at .*: An attempt unit resolves node to .*manager-bin\/node/);
  assert.equal(held.queue.length, 1); assert.match(held.queue[0].text, /so nothing new is admitted/);
  const health = snapshot(f.s.store).health.attemptEnvironment;
  assert.equal(health.status, 'differs'); assert.equal(health.holdsAdmission, true); assert.equal(health.reasons.length, 2);
  assert.equal(dashboardSnapshot(f.s.store).health.attemptEnvironment.status, 'differs');
  // Admission itself refuses, with the reason.
  const refused = f.s.command('flow.start', { taskId: f.s.task.id, revision: f.s.store.need('task', f.s.task.id).revision });
  assert.notEqual(refused.status, 'completed'); assert.match(JSON.stringify(refused), /attempt units resolve a different node or git/);
  // Doctor under the same code blocks on it.
  assert.match(recordedAttemptEnvironment({ store: f.s.store, executor: executorDigest() }).reasons.join(), /An attempt unit resolves node to/);
  await first.close();
  // The drop-in is removed; the next start finds no difference and the hold lifts.
  standInProbeRun(f.env);
  await f.start();
  await until(() => f.s.store.meta('attemptEnvironmentCheck').status !== 'differs');
  assert.equal(f.s.store.meta('attemptEnvironmentCheck').status, 'same');
  assert.deepEqual(f.held(), { admission: [], queue: [] });
  assert.equal(snapshot(f.s.store).health.attemptEnvironment.holdsAdmission, false);
  assert.ok(f.s.store.events().some(e => e.type === 'attempt-environment.checked' && e.payload.status === 'same' && e.payload.previous === 'differs'));
});

test('a hanging probe never delays the service\'s start; it ends at its bound as unverified', async t => {
  const f = serviceFixture(t); standInHangingRun(f.env);
  const started = Date.now();
  const { app, close } = await f.start({ timeoutMs: 1500 });
  const startedIn = Date.now() - started;
  assert.ok(startedIn < 1000, `started after ${startedIn} ms`);
  const shaken = await requestProject(app.socketPath, { path: '/v1/handshake', timeoutMs: 10000 });
  assert.equal(shaken.projectId, f.s.project.projectId, 'the socket serves while the probe hangs');
  assert.equal(f.s.store.meta('attemptEnvironmentCheck', null), null, 'nothing recorded while the probe runs');
  await until(() => f.s.store.meta('attemptEnvironmentCheck'), { timeout: 30000 });
  const record = f.s.store.meta('attemptEnvironmentCheck');
  assert.equal(record.status, 'unverified'); assert.match(record.warnings.join(), /Could not check which node and git an attempt unit runs/);
  assert.deepEqual(f.systemctlCalls(), [`--user stop ${unitOf(f.runCalls()[0])}`], 'its unit is stopped by its exact name');
  assert.deepEqual(f.held(), { admission: [], queue: [] }, 'an unverified check does not hold admission');
  const closing = Date.now(); await close(); assert.ok(Date.now() - closing < 5000);
});

test('a service closing while its probe hangs closes within a short bound and records nothing', async t => {
  const f = serviceFixture(t); standInHangingRun(f.env);
  const { close } = await f.start({ timeoutMs: 20000 });
  await until(() => f.runCalls().length === 1);
  const closing = Date.now(); await close();
  assert.ok(Date.now() - closing < 5000, `closed after ${Date.now() - closing} ms`);
  assert.equal(f.s.store.meta('attemptEnvironmentCheck', null), null);
});

test('under the process supervisor the check is not applicable: no unit, no warning, no hold', async t => {
  const f = serviceFixture(t); standInProbeRun(f.env);
  f.s.store.setMeta('project', { ...f.s.store.meta('project'), supervisor: 'process' });
  await f.start();
  await until(() => f.s.store.meta('attemptEnvironmentCheck'));
  const record = f.s.store.meta('attemptEnvironmentCheck');
  assert.equal(record.status, 'not-applicable'); assert.deepEqual(record.warnings, []); assert.deepEqual(f.runCalls(), []);
  assert.deepEqual(f.held(), { admission: [], queue: [] });
  const read = recordedAttemptEnvironment({ store: f.s.store, executor: executorDigest() });
  assert.deepEqual(read.warnings, []); assert.deepEqual(read.reasons, []);
});

// During `upgrade apply` the service is stopped when doctor runs: the record, if any, is from the
// code before the upgrade. Doctor reports unverified with the new message and refuses nothing.
test('doctor reads the service\'s result: none, or one from other code, is unverified with the next-start message', async t => {
  const s = sandbox(t);
  const none = recordedAttemptEnvironment({ store: s.store, executor: executorDigest() });
  assert.deepEqual(none.reasons, []); assert.deepEqual(none.warnings, [NOT_YET_CHECKED]); assert.equal(none.record.status, 'unverified');
  assert.match(NOT_YET_CHECKED, /the project service has not checked this release yet\. It checks when it next starts/);
  s.store.setMeta('attemptEnvironmentCheck', { status: 'differs', checkedAt: '2026-11-20T10:00:00.000Z', executorDigest: 'before-the-upgrade', reasons: ['An attempt unit resolves node to /fictional/shim'], warnings: [] });
  const stale = recordedAttemptEnvironment({ store: s.store, executor: executorDigest() });
  assert.deepEqual(stale.reasons, [], 'a result from other code never blocks doctor'); assert.deepEqual(stale.warnings, [NOT_YET_CHECKED]);
  assert.deepEqual(stale.record.previous, { status: 'differs', checkedAt: '2026-11-20T10:00:00.000Z' });
});
