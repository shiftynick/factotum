// dev.87 review: upgrade apply --merge and --activate stop units only on a checkout that verifies,
// move it once, after the units stop, and start them again only when the checkout verifies from the
// files on disk. The record in the project's state names the units until they all run again; the
// commit it names is only a hint for the instructions. A run that did not finish is finished by the
// next one or by upgrade apply --recover, and every message that leaves units stopped gives commands
// that work when run as written. Every project, path and release here is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareUpgrade, mergeUpgrade, recoverUpgrade } from '../starter/factory/operations/upgrade-apply.mjs';
import { adoptionStatus } from '../starter/factory/distribution.mjs';
import { git, put, SUBSTITUTE, substitute, fixture, landed, remoteTarget, activate, adoptStatus } from './adoption-fixtures.mjs';
import { readRelease } from '../starter/factory/distribution.mjs';

const CONSOLE = 'factotum-console.service';
const recoveryRecord = f => f.store.meta('upgradeRecovery', null);
const realGit = () => execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
// A `git` first on PATH that runs the real one, and can: refuse `reset` (FACTOTUM_TEST_FAIL_RESET);
// append to a file right after a successful `merge --ff-only`, as a checkout filter rewriting it would
// (FACTOTUM_TEST_CORRUPT); or send SIGTERM to the process that ran it right after its Nth successful
// `merge --ff-only` (FACTOTUM_TEST_KILL_ON_FF): an upgrade interrupted right after it moved the checkout.
function gitWrapper(f) {
  const bin = join(f.base, 'wrapped-bin'); mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'git'), `#!/bin/sh
case " $* " in *" reset "*) if [ -n "$FACTOTUM_TEST_FAIL_RESET" ]; then echo "fictional: reset refused" >&2; exit 1; fi;; esac
${JSON.stringify(realGit())} "$@"; code=$?
case " $* " in *" merge --ff-only "*) if [ $code = 0 ]; then
  if [ -n "$FACTOTUM_TEST_CORRUPT" ]; then printf 'filtered\\n' >> "$FACTOTUM_TEST_CORRUPT"; fi
  if [ -n "$FACTOTUM_TEST_KILL_ON_FF" ]; then n=$(cat "$FACTOTUM_TEST_FF_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$FACTOTUM_TEST_FF_COUNT"; if [ "$n" = "$FACTOTUM_TEST_KILL_ON_FF" ]; then kill -TERM $PPID; sleep 1; fi; fi
fi;; esac
exit $code
`, { mode: 0o755 });
  return bin;
}
function withPath(t, bin, env = {}) {
  const was = { PATH: process.env.PATH, ...Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])) };
  process.env.PATH = `${bin}:${process.env.PATH}`; Object.assign(process.env, env);
  const restore = () => { for (const [key, value] of Object.entries(was)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
  t.after(restore); return restore;
}
// Run --merge or --activate in a child process that is killed (SIGTERM) right after its Nth
// fast-forward. Its units are stubs whose calls go to a log; the parent's stub then continues from
// what the child left (a stopped unit stays stopped).
function interrupted(f, operation, options, killOn) {
  const script = join(f.base, `interrupted-${operation}.mjs`), log = join(f.base, `interrupted-${operation}.log`);
  writeFileSync(script, `import { appendFileSync } from 'node:fs';
const module = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'starter/factory/operations/upgrade-apply.mjs')).href)});
const options = JSON.parse(process.argv[2]), active = new Set(${JSON.stringify([...f.active])});
const run = async (binary, args) => { if (binary === 'systemctl') { appendFileSync(${JSON.stringify(log)}, args.slice(1).join(' ') + '\\n'); const [verb, ...rest] = args.slice(1); if (verb === 'show') return { code: 0, stdout: '{ path=/usr/bin/node ; argv[]=/usr/bin/node ${f.root}/factory/console/console.mjs }' }; if (verb === 'is-active') return { code: active.has(rest.at(-1)) ? 0 : 3 }; if (verb === 'stop') active.delete(rest[0]); if (verb === 'start') active.add(rest[0]); } return { code: 0, stdout: '', stderr: '' }; };
const result = await module[${JSON.stringify(operation === 'merge' ? 'mergeUpgrade' : 'activateUpgrade')}]({ ...options, run, runCli: async () => ({ code: 0, stdout: '{}', stderr: '' }) });
console.log(JSON.stringify(result));
`);
  const ran = spawnSync(process.execPath, [script, JSON.stringify(options)], { encoding: 'utf8', env: { ...process.env, PATH: `${gitWrapper(f)}:${process.env.PATH}`, FACTOTUM_TEST_KILL_ON_FF: String(killOn), FACTOTUM_TEST_FF_COUNT: join(f.base, `ff-count-${operation}`) } });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  for (const line of calls) { const [verb, name] = line.split(' '); if (verb === 'stop') f.active.delete(name); if (verb === 'start') f.active.add(name); }
  return { signal: ran.signal, status: ran.status, stdout: ran.stdout, stderr: ran.stderr, calls };
}
// A `systemctl` first on PATH for commands an operator runs (and the CLI they run): it keeps unit
// state as files and logs every call.
function fakeSystemctl(f) {
  const bin = join(f.base, 'systemctl-bin'), units = join(f.base, 'systemctl-units'); mkdirSync(bin, { recursive: true }); mkdirSync(units, { recursive: true });
  writeFileSync(join(bin, 'systemctl'), `#!/bin/sh
[ "$1" = "--user" ] && shift
verb=$1; shift; [ "$1" = "--quiet" ] && shift
echo "$verb $1" >> ${JSON.stringify(join(units, 'log'))}
case $verb in is-active) [ -f ${JSON.stringify(units)}/"$1" ];; start) touch ${JSON.stringify(units)}/"$1";; stop) rm -f ${JSON.stringify(units)}/"$1";; *) exit 0;; esac
`, { mode: 0o755 });
  return { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, log: () => existsSync(join(units, 'log')) ? readFileSync(join(units, 'log'), 'utf8').split('\n').filter(Boolean) : [] };
}
// Run, as written and in order, the commands a message gives after "To finish, run in order:".
function follow(message, env) {
  const at = message.indexOf('To finish, run in order:'); assert.ok(at >= 0, `no commands in: ${message}`);
  const commands = [...message.slice(at).matchAll(/`([^`]+)`/g)].map(match => match[1]); assert.ok(commands.length, message);
  for (const command of commands) { const ran = spawnSync('sh', ['-c', command], { encoding: 'utf8', env }); assert.equal(ran.status, 0, `${command}\n${ran.stdout}\n${ran.stderr}`); }
  return commands;
}
// A prepared, committed upgrade to 1.1.0, with the checkout following a remote target.
function reviewed(t) {
  const f = fixture(t), remote = remoteTarget(f), prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  return { ...f, ...remote, head: git(f.root, ['rev-parse', 'HEAD']) };
}
const pushToTarget = (f, path, text, message) => { put(f.other, path, text); git(f.other, ['add', '-A']); git(f.other, ['commit', '-qm', message]); git(f.other, ['push', '-q', 'origin', f.target]); return git(f.other, ['rev-parse', 'HEAD']); };
const merge = (f, extra = {}) => mergeUpgrade({ ...f.options, backupDir: join(f.base, `backup-${Math.random().toString(36).slice(2)}`), run: f.run, runCli: f.runCli, ...extra });
const prepareAgain = f => prepareUpgrade({ ...f.options, branch: 'chore/again', worktreeDir: join(f.base, 'review-again') });

// Every Git object's bytes in a repository, to find a file that should never have entered one.
const objectBytes = root => execFileSync('git', ['cat-file', '--batch-all-objects', '--batch'], { cwd: root, encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
const SECRET = 'FICTIONAL_TOKEN=not-a-real-secret-4711\n';
const activateKilled = f => interrupted(f, 'activate', { root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, 'backup-interrupted') }, 1);
const failingStart = f => async (binary, args) => binary === 'systemctl' && args[1] === 'start' ? { code: 1, stdout: '', stderr: 'fictional: start failed' } : f.run(binary, args);
// A record as an attacker with write access to the state, or an earlier release, could leave: it names
// the commit the checkout holds (under both key names this branch has used) and the stopped console.
function plantRecord(f) { const head = git(f.root, ['rev-parse', 'HEAD']); f.store.setMeta('upgradeRecovery', { operation: 'activate', trusted: head, hint: head, target: null, units: [CONSOLE], at: '2026-11-16T00:00:00.000Z' }); f.active.delete(CONSOLE); }

test('the sync: a substituted file pushed to the target stops --merge before any unit stops or the checkout moves, even under SIGTERM', async t => {
  const f = reviewed(t), reviewedCommit = git(f.root, ['rev-parse', f.options.branch]);
  pushToTarget(f, 'factory/core/configuration.mjs', SUBSTITUTE, 'Edit a managed file');
  const run = interrupted(f, 'merge', { ...f.options, backupDir: join(f.base, 'backup-interrupted') }, 1);
  assert.equal(run.signal, null, 'no fast-forward happened, so nothing was there to interrupt'); assert.notEqual(run.status, 0);
  assert.match(run.stderr, /after its rebase onto origin\/[^ ]+ \([0-9a-f]{12}\): a commit there changed the installed files\. Nothing was stopped and the project checkout did not move; the review branch is back on the reviewed commit\./);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head); assert.equal(git(f.root, ['rev-parse', f.options.branch]), reviewedCommit);
  assert.deepEqual(run.calls.filter(line => /^(stop|start)/.test(line)), [], 'no unit was stopped'); assert.ok(f.active.has(CONSOLE));
  assert.equal(recoveryRecord(f), null);
});

test('P2-2: a rebase that would drop or change a reviewed project change stops --merge for a new review', async t => {
  const f = fixture(t), remote = remoteTarget(f), prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  // The reviewed branch also restricts the project's governance.
  const RESTRICT = 'Fictional governance: changes need two reviews.\n';
  put(prepared.worktree, 'project/GOVERNANCE.md', RESTRICT); git(prepared.worktree, ['commit', '-qam', 'Restrict governance']);
  const reviewedCommit = git(prepared.worktree, ['rev-parse', 'HEAD']), head = git(f.root, ['rev-parse', 'HEAD']);
  // The target applies the identical patch, then replaces it with a permissive rule.
  Object.assign(f, remote); pushToTarget(f, 'project/GOVERNANCE.md', RESTRICT, 'Same restriction'); pushToTarget(f, 'project/GOVERNANCE.md', 'Fictional governance: anything goes.\n', 'Permissive rule');
  await assert.rejects(merge(f), /the review branch's changes are not the reviewed ones after its rebase onto origin\/[^ ]+ \([0-9a-f]{12}\): a commit there touched a path the review changed, or a reviewed commit was skipped as already applied\. Nothing was stopped and the project checkout did not move; the review branch is back on the reviewed commit\. Prepare the upgrade again/);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), head); assert.equal(git(prepared.worktree, ['rev-parse', 'HEAD']), reviewedCommit);
  assert.equal(readFileSync(join(prepared.worktree, 'project/GOVERNANCE.md'), 'utf8'), RESTRICT);
  assert.deepEqual(f.systemctl.filter(line => /^(stop|start)/.test(line)), []); assert.ok(f.active.has(CONSOLE)); assert.equal(recoveryRecord(f), null);
});

test('a --merge interrupted right after its only fast-forward has recorded the stopped console; recovery starts it once the merged checkout verifies', async t => {
  const f = reviewed(t), merged = pushToTarget(f, 'site/style.css', 'body{}\n', 'Merged pull request');
  assert.equal(interrupted(f, 'merge', { ...f.options, backupDir: join(f.base, 'backup-interrupted') }, 1).signal, 'SIGTERM');
  const tip = git(f.root, ['rev-parse', f.options.branch]);
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), tip, 'the one fast-forward is the merge, after the stop'); assert.equal(git(f.root, ['rev-parse', 'HEAD~1']), merged);
  assert.equal(f.active.has(CONSOLE), false);
  assert.deepEqual({ ...recoveryRecord(f), at: undefined }, { operation: 'merge', hint: f.head, units: [CONSOLE], at: undefined });
  const recovered = await recoverUpgrade({ root: f.root, stateDir: f.stateDir, run: f.run, runCli: f.runCli });
  assert.deepEqual(recovered, { recovered: true, step: 'recover', ok: true, durationMs: 0, operation: 'merge', checkout: tip, units: [CONSOLE], recommissioned: true });
  assert.ok(f.active.has(CONSOLE)); assert.equal(recoveryRecord(f), null);
  // What is left is the documented case of a merged branch: clean up, recommission and run doctor.
  await assert.rejects(merge(f), /is already merged into the project checkout, which holds 1\.1\.0: there is nothing to merge/);
});

test('P2-1: recovery trusts nothing in the record: a planted record over a substituted checkout starts nothing', async t => {
  const f = fixture(t, { tamper: substitute }); plantRecord(f);
  await assert.rejects(recoverUpgrade({ root: f.root, stateDir: f.stateDir, run: f.run }), /did not finish and left the units factotum-console\.service stopped\. They stay stopped, and nothing else was done: the checkout does not verify: .*do not rebuild the release manifest/);
  assert.equal(f.active.has(CONSOLE), false); assert.deepEqual(f.systemctl.filter(line => line.startsWith('start')), []);
  assert.ok(recoveryRecord(f), 'the record stays');
});

test('P2-1: recovery reads the files, not Git: a managed file changed behind --assume-unchanged keeps the units stopped until it is restored', async t => {
  const f = fixture(t); plantRecord(f);
  git(f.root, ['update-index', '--assume-unchanged', 'factory/core/configuration.mjs']); put(f.root, 'factory/core/configuration.mjs', SUBSTITUTE);
  assert.equal(git(f.root, ['status', '--porcelain']), '', 'Git sees nothing');
  let message; await assert.rejects(recoverUpgrade({ root: f.root, stateDir: f.stateDir, run: f.run }), error => { message = error.message; return /the checkout does not verify: installed files differ from factotum\.lock\.json \(release 1\.0\.0\): factory\/core\/configuration\.mjs \(locally modified managed file\)/.test(message); });
  assert.equal(f.active.has(CONSOLE), false);
  const units = fakeSystemctl(f), commands = follow(message, units.env);
  assert.deepEqual(commands.slice(0, 1), [`git -C ${f.root} checkout -- factory/core/configuration.mjs`]);
  assert.notEqual(readFileSync(join(f.root, 'factory/core/configuration.mjs'), 'utf8'), SUBSTITUTE);
  assert.deepEqual(units.log().filter(line => line.startsWith('start')), [`start ${CONSOLE}`]); assert.equal(recoveryRecord(f), null);
});

test('a unit that does not start during recovery keeps the record, the message gives the restart commands, and a retry finishes it', async t => {
  const f = landed(t); assert.equal(activateKilled(f).signal, 'SIGTERM');
  await assert.rejects(activate(f, { run: failingStart(f) }), new RegExp(`The checkout verifies and was recommissioned, and doctor passed, but ${CONSOLE} \\(systemctl --user start ${CONSOLE} failed: fictional: start failed\\) did not start; the record stays in the project's state until every unit runs\\. To finish, run in order: \`systemctl --user start ${CONSOLE}\`, then \`node .*upgrade apply --recover --actor operator --root .* --state .*\`\\.`));
  assert.equal(f.active.has(CONSOLE), false); assert.deepEqual(recoveryRecord(f).units, [CONSOLE]);
  assert.throws(() => prepareAgain(f), /did not finish .* Finish it first: `node .*upgrade apply --recover --actor operator --root /);
  // A retry still knows the console ran, starts it, and then does its own work (the target verifies: it activates).
  const result = await activate(f);
  assert.equal(result.steps[0].step, 'recover'); assert.deepEqual(result.steps[0].units, [CONSOLE]); assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.ok(f.active.has(CONSOLE)); assert.equal(recoveryRecord(f), null);
});

test('an activation whose checkout already holds a target that does not verify is refused before anything stops, and nothing blocks the way back', async t => {
  // The previous release's lock is in the earlier shape.
  const f = landed(t, { legacy: true, tamper: checkout => put(checkout, 'factory/core/configuration.mjs', SUBSTITUTE) });
  git(f.root, ['fetch', '-q', 'origin', f.target]); git(f.root, ['merge', '-q', '--ff-only', 'FETCH_HEAD']);
  await assert.rejects(activate(f, { releaseDir: f.two.dir }), /the project checkout does not verify, so nothing was stopped or changed: installed files differ from factotum\.lock\.json \(release 1\.1\.0\): factory\/core\/configuration\.mjs \(locally modified managed file\)/);
  assert.deepEqual(f.systemctl.filter(line => /^(stop|start)/.test(line)), []); assert.ok(f.active.has(CONSOLE)); assert.equal(recoveryRecord(f), null);
  git(f.root, ['reset', '-q', '--keep', f.head]);
  const status = adoptStatus(f.root, '--state', f.stateDir); assert.equal(status.code, 0, status.err); assert.equal(JSON.parse(status.out).clean, true);
  assert.doesNotThrow(() => prepareAgain(f), 'preparing an upgrade is not blocked');
});

test('every message that leaves units stopped gives commands that, run as written, finish the recovery; nothing is stashed', async t => {
  // 1. --merge's verify finds a file a checkout filter rewrote, and the reset back is refused by that change: a hold.
  //    An untracked secret sits in the checkout; following the message must not put it into any Git object.
  {
    const f = reviewed(t), restore = withPath(t, gitWrapper(f), { FACTOTUM_TEST_CORRUPT: join(f.root, 'factory/cli.mjs') });
    const result = await merge(f); restore();
    const hold = result.steps.find(row => row.step === 'hold'); assert.ok(hold, result.steps.map(row => row.step).join(', '));
    assert.equal(result.steps.find(row => row.step === 'verify').ok, false); assert.equal(result.steps.some(row => row.step === 'start'), false); assert.equal(f.active.has(CONSOLE), false);
    assert.doesNotMatch(hold.error, /stash push/); assert.match(hold.error, /copy anything you want to keep to a private backup outside the repository \(do not stash it/);
    assert.match(hold.error, /git reset --keep refuses rather than overwrite a changed file .*back that file up outside the repository, restore it with git -C .* checkout -- <path>/);
    writeFileSync(join(f.root, 'fictional-secret.env'), SECRET);
    const units = fakeSystemctl(f), commands = follow(hold.error, units.env);
    assert.deepEqual(commands.map(command => command.split(' ').slice(3, 5).join(' ')), ['checkout --', 'reset --keep', 'apply --recover']);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head); assert.equal(adoptionStatus({ root: f.root }).clean, true);
    assert.deepEqual(units.log().filter(line => line.startsWith('start')), [`start ${CONSOLE}`]); assert.equal(recoveryRecord(f), null);
    assert.equal(git(f.root, ['stash', 'list']), ''); assert.equal(objectBytes(f.root).includes(SECRET.trim()), false, 'the secret is in no Git object');
    assert.equal(readFileSync(join(f.root, 'fictional-secret.env'), 'utf8'), SECRET);
  }
  // 2. An activation killed after its fast-forward onto a target that does not verify: the next run's recovery refuses.
  {
    const f = landed(t, { tamper: checkout => put(checkout, 'factory/core/configuration.mjs', SUBSTITUTE) });
    assert.equal(activateKilled(f).signal, 'SIGTERM'); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.remoteHead);
    let message; await assert.rejects(activate(f), error => { message = error.message; return /They stay stopped, and nothing else was done: the checkout does not verify: installed files differ/.test(message); });
    assert.equal(f.active.has(CONSOLE), false);
    const units = fakeSystemctl(f), commands = follow(message, units.env);
    assert.match(commands.join('\n'), new RegExp(`reset --keep ${f.head}`));
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head); assert.deepEqual(units.log().filter(line => line.startsWith('start')), [`start ${CONSOLE}`]); assert.equal(recoveryRecord(f), null);
    assert.doesNotThrow(() => prepareAgain(f));
  }
  // 3. A recovery whose unit does not start.
  {
    const f = landed(t); assert.equal(activateKilled(f).signal, 'SIGTERM');
    let message; await assert.rejects(activate(f, { run: failingStart(f) }), error => { message = error.message; return true; });
    const units = fakeSystemctl(f), commands = follow(message, units.env);
    assert.equal(commands[0], `systemctl --user start ${CONSOLE}`);
    assert.equal(recoveryRecord(f), null); assert.deepEqual(units.log().filter(line => line.startsWith('start')), [`start ${CONSOLE}`]);
    // Not blocked by a recovery any more: the checkout holds the activated release, so there is nothing to prepare.
    assert.throws(() => prepareAgain(f), /^Error: release already adopted$/);
  }
});

// ---- Fourth re-check (1357eb5) ----

test('item 1: units start again only on an authenticated lock: a legacy forgery stays stopped, and --release authenticates a genuine legacy lock', async t => {
  // Recovery: a root lock without evidence, a substituted validator with its hash in the lock, a planted record.
  const forged = fixture(t, { legacy: true, tamper: substitute }); plantRecord(forged);
  await assert.rejects(recoverUpgrade({ root: forged.root, stateDir: forged.stateDir, run: forged.run, runCli: forged.runCli }), new RegExp(`the checkout does not verify: factotum\\.lock\\.json \\(release 1\\.0\\.0\\) carries no layout evidence .* --release <the directory of release 1\\.0\\.0> --digest ${forged.one.manifestDigest} with upgrade apply --recover`));
  await assert.rejects(recoverUpgrade({ root: forged.root, stateDir: forged.stateDir, releaseDir: forged.one.dir, expectedDigest: forged.one.manifestDigest, run: forged.run, runCli: forged.runCli }), /its managed files are not that release's/);
  assert.equal(forged.active.has(CONSOLE), false); assert.deepEqual(forged.cliCalls, []); assert.ok(recoveryRecord(forged));
  // A genuine legacy lock: refused without the release, started with it.
  const genuine = fixture(t, { legacy: true }); plantRecord(genuine);
  await assert.rejects(recoverUpgrade({ root: genuine.root, stateDir: genuine.stateDir, run: genuine.run, runCli: genuine.runCli }), /carries no layout evidence/);
  assert.equal(genuine.active.has(CONSOLE), false);
  const recovered = await recoverUpgrade({ root: genuine.root, stateDir: genuine.stateDir, releaseDir: genuine.one.dir, expectedDigest: genuine.one.manifestDigest, run: genuine.run, runCli: genuine.runCli });
  assert.equal(recovered.recovered, true); assert.ok(genuine.active.has(CONSOLE)); assert.equal(recoveryRecord(genuine), null);
  // The end of a run: an activation of a substituted target from a legacy install is returned, but not started on the unauthenticated lock.
  const f = landed(t, { legacy: true, tamper: checkout => put(checkout, 'factory/core/configuration.mjs', SUBSTITUTE) });
  const result = await activate(f, { releaseDir: f.two.dir });
  assert.ok(result.steps.some(row => row.step === 'rollback')); const hold = result.steps.find(row => row.step === 'hold');
  assert.ok(hold, result.steps.map(row => row.step).join(', ')); assert.match(hold.error, /carries no layout evidence/); assert.match(hold.error, new RegExp(`upgrade apply --recover .*--release <the directory of release 1\\.0\\.0> --digest ${f.one.manifestDigest}`));
  assert.equal(f.active.has(CONSOLE), false); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head);
  await recoverUpgrade({ root: f.root, stateDir: f.stateDir, releaseDir: f.one.dir, expectedDigest: f.one.manifestDigest, run: f.run, runCli: f.runCli });
  assert.ok(f.active.has(CONSOLE)); assert.equal(recoveryRecord(f), null);
});

test('item 2: recovery recommissions and runs doctor before it starts any unit, and keeps them stopped when doctor fails', async t => {
  for (const doctorPasses of [true, false]) {
    const f = reviewed(t); pushToTarget(f, 'site/style.css', 'body{}\n', 'Merged pull request');
    assert.equal(interrupted(f, 'merge', { ...f.options, backupDir: join(f.base, 'backup-interrupted') }, 1).signal, 'SIGTERM');
    // The interrupted run left the old release's commissioning in place.
    f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
    const order = [], run = async (binary, args) => { if (binary === 'systemctl' && args[1] === 'start') order.push(`start ${args[2]}`); return f.run(binary, args); };
    const runCli = async args => { order.push(args.slice(0, 2).join(' ')); return args[0] === 'doctor' && !doctorPasses ? { code: 1, stdout: JSON.stringify({ reasons: ['fictional: doctor reason'] }), stderr: '' } : { code: 0, stdout: '{}', stderr: '' }; };
    if (doctorPasses) {
      const recovered = await recoverUpgrade({ root: f.root, stateDir: f.stateDir, run, runCli });
      assert.equal(recovered.recommissioned, true); assert.deepEqual(order, ['config update', 'doctor --state', `start ${CONSOLE}`]); assert.ok(f.active.has(CONSOLE));
    } else {
      await assert.rejects(recoverUpgrade({ root: f.root, stateDir: f.stateDir, run, runCli }), /The checkout verifies, but its doctor step failed, so they stay stopped: .*fictional: doctor reason.*Fix what it names, then run `node .*upgrade apply --recover --actor operator --root /);
      assert.deepEqual(order, ['config update', 'doctor --state']); assert.equal(f.active.has(CONSOLE), false); assert.ok(recoveryRecord(f));
    }
  }
});

test('item 3: a target that changed .gitattributes or .gitmodules, at any depth, stops --merge for a new review before anything moves', async t => {
  for (const [path, text] of [['.gitattributes', 'project/GOVERNANCE.md filter=gov\n'], ['project/deep/.gitattributes', '*.md filter=gov\n'], ['.gitmodules', '[submodule "fictional"]\n\tpath = fictional\n\turl = ./fictional\n']]) {
    const f = reviewed(t), reviewedCommit = git(f.root, ['rev-parse', f.options.branch]);
    // An existing, reversible filter the operator configured; the target only names it.
    git(f.root, ['config', 'filter.gov.clean', 'cat']); git(f.root, ['config', 'filter.gov.smudge', 'cat']);
    pushToTarget(f, path, text, `Change ${path}`);
    await assert.rejects(merge(f), new RegExp(`changed ${path.replace(/\./g, '\\.')} since the review branch was prepared: they change how Git checks files out .* Nothing was stopped and the project checkout and review branch did not move\\. Prepare the upgrade again`), path);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head, path); assert.equal(git(f.root, ['rev-parse', f.options.branch]), reviewedCommit, path);
    assert.deepEqual(f.systemctl.filter(line => /^(stop|start)/.test(line)), [], path); assert.equal(recoveryRecord(f), null, path);
  }
});
