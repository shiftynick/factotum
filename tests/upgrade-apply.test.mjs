import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { sandbox } from './helpers.mjs';
import { buildRelease, prepareAdoption, adoptionStatus } from '../starter/factory/distribution.mjs';
import { prepareUpgrade, mergeUpgrade } from '../starter/factory/operations/upgrade-apply.mjs';
import { layoutFenceIntact } from '../starter/factory/core/records.mjs';

const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
// A release of this line declares the record layouts it reads (starter/compatibility.json); pass null for an earlier one.
// Every release carries its own configuration validator (factory/core/configuration.mjs), which
// upgrade apply runs against the project's stored configuration before it touches anything.
const ACCEPTS = 'export const validateConfig = config => config;\n';
function release(f, version, marker, layouts = ['inline', 'separate-intents'], cli = `console.log(${JSON.stringify(marker)});\n`, validator = ACCEPTS) {
  const source = join(f.base, `source-${version}`);
  put(source, 'factory/cli.mjs', cli); put(source, 'VERSION', 'development\n'); if (validator !== null) put(source, 'factory/core/configuration.mjs', validator);
  put(source, 'compatibility.json', JSON.stringify({ schemaVersion: 1, configVersion: 1, projectProtocolVersion: 1, ...(layouts ? { recordLayouts: layouts } : {}) }));
  const dir = join(f.base, `release-${version}`); return { dir, ...buildRelease({ sourceDir: source, outputDir: dir, version, allowWorkingTree: true }) };
}
function fixture(t, { targetLayouts, cli, validator } = {}) {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const one = release(f, '1.0.0', 'one'), installed = prepareAdoption({ root: f.root, releaseDir: one.dir, expectedDigest: one.manifestDigest, branch: 'chore/install', worktreeDir: join(f.base, 'install'), initial: true });
  git(installed.worktree, ['add', '.']); git(installed.worktree, ['commit', '-qm', 'Adopt 1.0.0']); git(f.root, ['merge', '--ff-only', 'chore/install']);
  const two = validator !== undefined ? release(f, '1.1.0', 'two', undefined, undefined, validator) : cli ? release(f, '1.1.0', 'two', undefined, cli) : targetLayouts === undefined ? release(f, '1.1.0', 'two') : release(f, '1.1.0', 'two', targetLayouts);
  const options = { root: f.root, stateDir: f.stateDir, releaseDir: two.dir, expectedDigest: two.manifestDigest, branch: 'chore/factotum-1.1.0', worktreeDir: join(f.base, 'review-1.1.0') };
  const systemctl = [], active = new Set(['factotum-console.service']);
  const shared = {};
  const run = async (binary, args) => { if (binary === 'systemctl') { systemctl.push(args.slice(1).join(' ')); const [verb, ...rest] = args.slice(1); if (verb === 'show') return { code: 0, stdout: `{ path=/usr/bin/node ; argv[]=/usr/bin/node ${shared.consoleRoot ?? f.root}/factory/console/console.mjs }` }; if (verb === 'is-active') return { code: active.has(rest.at(-1)) ? 0 : 3 }; if (verb === 'stop') active.delete(rest[0]); if (verb === 'start') active.add(rest[0]); } return { code: 0, stdout: '', stderr: '' }; };
  const cliCalls = [], runCli = async args => { cliCalls.push(args.slice(0, 2).join(' ')); return { code: 0, stdout: '{}', stderr: '' }; };
  return { ...f, two, options, systemctl, active, run, runCli, cliCalls, shared };
}

test('apply prepares a review worktree, then merges, backs up, cleans up, recommissions and restarts', async t => {
  const f = fixture(t), prepared = prepareUpgrade(f.options);
  assert.match(prepared.next, /--merge/);
  await assert.rejects(mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli }), /commit the reviewed update|no commits/);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.ok(result.steps.every(row => row.ok === true && Number.isInteger(row.durationMs)));
  // The console that runs from this checkout comes back right after recommissioning, before doctor (dev.85 review).
  assert.deepEqual(result.steps.map(row => row.step), ['stop', 'backup', 'merge', 'verify', 'cleanup', 'recommission', 'start', 'doctor']);
  assert.deepEqual(f.cliCalls, ['config update', 'doctor --state']);
  assert.ok(f.systemctl.includes('stop factotum-console.service') && f.systemctl.includes('start factotum-console.service'));
  assert.equal(adoptionStatus({ root: f.root }).version, '1.1.0'); assert.match(readFileSync(join(f.root, 'factory/cli.mjs'), 'utf8'), /two/);
  assert.equal(existsSync(f.options.worktreeDir), false); assert.equal(git(f.root, ['branch', '--list', f.options.branch]), '');
  assert.ok(existsSync(join(f.base, 'backup', 'state.sqlite')));
});

test('apply refuses undrained work and still restarts stopped units when a later step fails', async t => {
  const f = fixture(t);
  f.store.put('obligation', { id: 'lifecycle:x', status: 'pending', requiresAuthorization: true, owner: 'operator' });
  assert.throws(() => prepareUpgrade(f.options), /drained project: resolve outstanding obligations that need authorization: lifecycle:x/);
  f.store.put('obligation', { id: 'lifecycle:x', status: 'passed', requiresAuthorization: true });
  // A human post-merge step days away carries over instead of blocking the upgrade.
  f.store.put('obligation', { id: 'flow:post:0', text: 'Operator deploys the site', owner: 'operator', status: 'pending' });
  const prepared = prepareUpgrade(f.options);
  assert.deepEqual(prepared.carriedOverObligations, [{ id: 'flow:post:0', title: 'Operator deploys the site', owner: 'operator' }]); git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const failing = async args => args[0] === 'config' ? { code: 1, stdout: '', stderr: 'invalid configuration' } : { code: 0 };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: failing });
  assert.equal(result.ok, false);
  const failed = result.steps.find(row => !row.ok);
  assert.equal(failed.step, 'recommission'); assert.match(failed.error, /config update failed: invalid configuration/);
  assert.ok(result.steps.every(row => Number.isInteger(row.durationMs)));
  assert.equal(result.steps.some(row => row.step === 'doctor'), false);
  assert.equal(result.steps.at(-1).step, 'start'); assert.ok(f.active.has('factotum-console.service'));
  assert.equal(realpathSync(f.root), f.store.meta('project').root);
});

test('the drain refusal names the flows that block it', t => {
  const f = fixture(t);
  f.store.put('flow', { id: 'maintenance:abc', kind: 'maintenance', state: 'stopped', taskId: 'job:abc' });
  assert.throws(() => prepareUpgrade(f.options), /drain or explicitly abandon all flows: maintenance:abc \(maintenance, stopped\)/);
});

test('apply catches up with work merged on the remote while it waited, then pushes cleanly', async t => {
  const f = fixture(t), prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const target = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']), remote = join(f.base, 'remote.git'), other = join(f.base, 'other');
  git(f.base, ['init', '-q', '--bare', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `HEAD:refs/heads/${target}`]);
  // A flow merged its pull request on the forge while the upgrade waited.
  git(f.base, ['clone', '-q', remote, other]); git(other, ['config', 'user.email', 'f@example.invalid']); git(other, ['config', 'user.name', 'F']); git(other, ['checkout', '-q', target]);
  put(other, 'site/style.css', 'body{}\n'); git(other, ['add', '.']); git(other, ['commit', '-qm', 'Merged PR']); git(other, ['push', '-q', 'origin', target]);
  const merged = git(other, ['rev-parse', 'HEAD']);
  f.store.setMeta('config', { ...f.store.meta('config'), repository: { remote: 'origin', target } });
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), push: true, run: f.run, runCli: f.runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  const sync = result.steps.find(row => row.step === 'sync-target'); assert.equal(sync.to, merged); assert.equal(sync.rebased, true);
  assert.equal(git(f.root, ['rev-parse', 'HEAD~1']), merged, 'the upgrade sits on top of the merged work');
  assert.equal(git(f.base, ['--git-dir', remote, 'rev-parse', target]), git(f.root, ['rev-parse', 'HEAD']), 'and was pushed');
});

test('an upgrade hold keeps new maintenance from starting, and lifting it lets it run', async t => {
  const f = sandbox(t);
  const { operationalTick } = await import('../starter/factory/workflows/maintenance.mjs');
  const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
  assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  assert.equal(f.command('pause', { paused: true, holdMaintenance: true, note: 'Holding new work so the upgrade to x can apply' }).result.maintenanceHeld, true);
  f.command('job.enqueue', { operation: 'maintenance.backup', note: 'x' });
  await operationalTick(f.store);
  assert.equal(f.store.all('flow').filter(flow => flow.kind === 'maintenance').length, 0, 'held');
  assert.equal(f.command('pause', { paused: false, note: 'done' }).result.maintenanceHeld, false);
  await operationalTick(f.store);
  assert.equal(f.store.all('flow').filter(flow => flow.kind === 'maintenance').length, 1, 'starts once lifted');
});

test('activate pulls a release already merged on the remote, recommissions, and leaves a shared console alone', async t => {
  const f = fixture(t), prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const target = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']), remote = join(f.base, 'remote.git'), other = join(f.base, 'other');
  git(f.base, ['init', '-q', '--bare', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `HEAD:refs/heads/${target}`]);
  // The reviewed adoption lands on the remote through a squash-merged pull request.
  git(f.base, ['clone', '-q', remote, other]); git(other, ['config', 'user.email', 'f@example.invalid']); git(other, ['config', 'user.name', 'F']); git(other, ['checkout', '-q', target]);
  git(other, ['fetch', '-q', f.root, `${f.options.branch}:review`]); git(other, ['merge', '--squash', 'review']); git(other, ['commit', '-qm', 'Adopt 1.1.0 (#1)']); git(other, ['push', '-q', 'origin', target]);
  f.store.setMeta('config', { ...f.store.meta('config'), repository: { remote: 'origin', target } });
  f.shared.consoleRoot = '/elsewhere/shared-console';
  const { activateUpgrade } = await import('../starter/factory/operations/upgrade-apply.mjs');
  const result = await activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map(row => row.step), ['stop', 'backup', 'pull', 'recommission', 'doctor', 'start'].filter(step => step !== 'start' || result.steps.some(r => r.step === 'start')));
  assert.equal(adoptionStatus({ root: f.root }).version, '1.1.0'); assert.ok(!f.systemctl.includes('stop factotum-console.service'), 'the shared console keeps running');
  await assert.rejects(activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: 'b'.repeat(64), backupDir: join(f.base, 'backup2'), run: f.run, runCli: f.runCli }).then(r => { if (!r.ok) throw new Error(r.steps.find(s => !s.ok).error); }), /does not hold the release/);
});

test('activate of a release that reads attempt intents only inline returns the state to that layout before the backup', async t => {
  // The release at the remote target does not declare this release's record layout: an earlier release.
  const f = fixture(t, { targetLayouts: null }), prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const target = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']), remote = join(f.base, 'remote.git'), other = join(f.base, 'other');
  git(f.base, ['init', '-q', '--bare', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `HEAD:refs/heads/${target}`]);
  git(f.base, ['clone', '-q', remote, other]); git(other, ['config', 'user.email', 'f@example.invalid']); git(other, ['config', 'user.name', 'F']); git(other, ['checkout', '-q', target]);
  git(other, ['fetch', '-q', f.root, `${f.options.branch}:review`]); git(other, ['merge', '--squash', 'review']); git(other, ['commit', '-qm', 'Adopt 1.1.0 (#1)']); git(other, ['push', '-q', 'origin', target]);
  f.store.setMeta('config', { ...f.store.meta('config'), repository: { remote: 'origin', target } });
  assert.ok(layoutFenceIntact(f.store.db));
  const { activateUpgrade } = await import('../starter/factory/operations/upgrade-apply.mjs');
  const result = await activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map(row => row.step).filter(step => step !== 'start'), ['stop', 'layout', 'backup', 'pull', 'recommission', 'doctor']);
  assert.ok(!layoutFenceIntact(f.store.db), 'the earlier release can write the state');
});

// dev.85: the upgrade's doctor step ran the doctor CLI with a fixed 600 s limit, shorter than
// doctor's own permit wait, and reported the kill as a bare "Provider timeout".
const LEASE_HOLD_BOUND_MS = 3_900_000;
const committed = f => { const prepared = prepareUpgrade(f.options); git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']); return prepared; };
const withSecret = (t, value) => { const saved = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = value; t.after(() => { if (saved === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved; }); };

test('dev.85: the doctor step gets doctor\'s own time bound, beyond its permit wait; config update keeps ten minutes', async t => {
  const f = fixture(t); committed(f);
  const calls = [], run = async (binary, args, options) => { if (binary === process.execPath) { calls.push({ args, options }); return { code: 0, stdout: '{}', stderr: '' }; } return f.run(binary, args, options); };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  const doctorCall = calls.find(call => call.args[1] === 'doctor'), configCall = calls.find(call => call.args[1] === 'config');
  assert.ok(doctorCall.options.timeoutMs > LEASE_HOLD_BOUND_MS, `doctor limit ${doctorCall.options.timeoutMs} ms must exceed the ${LEASE_HOLD_BOUND_MS} ms permit wait`);
  assert.ok(doctorCall.options.timeoutMs <= 4 * 3_600_000, 'and stays under the hard cap');
  assert.equal(configCall.options.timeoutMs, 600_000);
  // The child is named as what it is, so a timeout never reads "Provider timeout".
  assert.equal(doctorCall.options.label, 'factory CLI doctor'); assert.equal(configCall.options.label, 'factory CLI config update');
  const { doctorTimeBound } = await import('../starter/factory/workflows/commission.mjs');
  assert.equal(doctorCall.options.timeoutMs, doctorTimeBound(f.stateDir).timeoutMs);
  assert.equal(result.steps.find(row => row.step === 'doctor').limitMs, doctorCall.options.timeoutMs);
});

test('dev.91 report: a passing doctor\'s warnings appear on the doctor step and in the upgrade result', async t => {
  const f = fixture(t); committed(f);
  const warning = 'The Codex sandbox check could not run (fictional).';
  const run = async (binary, args, options) => { if (binary === process.execPath) return { code: 0, stdout: args[1] === 'doctor' ? JSON.stringify({ ready: true, warnings: [warning] }) : '{}', stderr: '' }; return f.run(binary, args, options); };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(result.steps.find(row => row.step === 'doctor').warnings, [warning]);
  assert.deepEqual(result.doctorWarnings, [warning]);
});

test('dev.85: activate gives its doctor step the same bound', async t => {
  const f = fixture(t); committed(f);
  const target = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']), remote = join(f.base, 'remote.git'), other = join(f.base, 'other');
  git(f.base, ['init', '-q', '--bare', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `HEAD:refs/heads/${target}`]);
  git(f.base, ['clone', '-q', remote, other]); git(other, ['config', 'user.email', 'f@example.invalid']); git(other, ['config', 'user.name', 'F']); git(other, ['checkout', '-q', target]);
  git(other, ['fetch', '-q', f.root, `${f.options.branch}:review`]); git(other, ['merge', '--squash', 'review']); git(other, ['commit', '-qm', 'Adopt 1.1.0 (#1)']); git(other, ['push', '-q', 'origin', target]);
  f.store.setMeta('config', { ...f.store.meta('config'), repository: { remote: 'origin', target } });
  const limits = [], runCli = async (args, options) => { limits.push([args[0], options?.timeoutMs]); return { code: 0, stdout: '{}', stderr: '' }; };
  const { activateUpgrade } = await import('../starter/factory/operations/upgrade-apply.mjs');
  const result = await activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, 'backup'), run: f.run, runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.equal(limits.find(([name]) => name === 'config')[1], 600_000);
  assert.ok(limits.find(([name]) => name === 'doctor')[1] > LEASE_HOLD_BOUND_MS, JSON.stringify(limits));
});

test('dev.85: a doctor step that times out names the step, command, elapsed time, limit and the phase doctor reported, with redacted output', async t => {
  const f = fixture(t); committed(f);
  const secret = 'sk-fictional-upgrade-secret-0123456789'; withSecret(t, secret);
  const stderr = [...Array.from({ length: 40 }, (_, i) => `noise line ${i}`),
    'doctor: [probe of planner (codex/fictional-model)] attempt 1 of 2',
    'doctor: [permit wait] waiting up to 65 min for heavy-work, held by project other-project, flow f, attempt a since 2026-11-15T00:00:00.000Z',
    `debug: key ${secret}`].join('\n');
  const runCli = async args => { if (args[0] !== 'doctor') return { code: 0, stdout: '{}', stderr: '' }; throw Object.defineProperties(Object.assign(new Error('factory CLI doctor timed out after 3900 s'), { code: 'TIMEOUT' }), { stdout: { value: '' }, stderr: { value: stderr } }); };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli });
  assert.equal(result.ok, false);
  const doctorStep = result.steps.find(row => row.step === 'doctor');
  assert.equal(doctorStep.ok, false); assert.equal(doctorStep.timedOut, true);
  assert.match(doctorStep.error, /^the doctor step \(node \S+factory\/cli\.mjs doctor --state \S+\) timed out after \d+ s \(its limit is \d+ s\) during permit wait \(waiting up to 65 min for heavy-work, held by project other-project/);
  assert.doesNotMatch(doctorStep.error, /Provider/);
  assert.equal(doctorStep.phase, 'permit wait'); assert.match(doctorStep.lastProgress, /^permit wait: waiting up to 65 min for heavy-work, held by project other-project/);
  assert.ok(Number.isInteger(doctorStep.elapsedMs) && doctorStep.limitMs > LEASE_HOLD_BOUND_MS);
  assert.match(doctorStep.command, /factory\/cli\.mjs doctor --state /);
  // The last lines of stderr, bounded and with the known secret redacted.
  assert.ok(doctorStep.stderr.split('\n').length <= 12, doctorStep.stderr); assert.match(doctorStep.stderr, /debug: key \[redacted\]$/);
  assert.ok(!JSON.stringify(result).includes(secret), 'the secret appears nowhere in the result');
  // Commissioning stays required and the units come back (the console before doctor).
  assert.deepEqual(result.steps.filter(row => row.step === 'start').map(row => row.unit), ['factotum-console.service']); assert.ok(f.active.has('factotum-console.service'));
});

test('dev.85: a doctor step that exits not ready carries doctor\'s reasons', async t => {
  const f = fixture(t); committed(f);
  const reasons = ['planner provider preflight failed for codex/fictional-model: timed out during auth status, after one retry (codex CLI preflight failed before model launch: codex auth status timed out after 15 s)'];
  const runCli = async args => args[0] === 'doctor' ? { code: 1, stdout: JSON.stringify({ ready: false, reasons }), stderr: 'doctor: [probe of planner (codex/fictional-model)] attempt 2 of 2\ndoctor: [forge check] GitHub repository fictional/project' } : { code: 0, stdout: '{}', stderr: '' };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli });
  const doctorStep = result.steps.find(row => row.step === 'doctor');
  assert.equal(doctorStep.ok, false); assert.equal(doctorStep.ready, false); assert.equal(doctorStep.exitCode, 1);
  assert.deepEqual(doctorStep.reasons, reasons);
  assert.match(doctorStep.error, /^the doctor step \(node .*doctor --state .*\) exited with code 1 after \d+ s: planner provider preflight failed for codex\/fictional-model: timed out during auth status/);
  assert.equal(doctorStep.phase, 'forge check');
});

test('dev.85: a failed config update in the upgrade names its command and keeps its output excerpt', async t => {
  const f = fixture(t); committed(f);
  const runCli = async args => args[0] === 'config' ? { code: 2, stdout: '', stderr: 'line one\nconfiguration invalid: providers.planner.model required' } : { code: 0, stdout: '{}', stderr: '' };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli });
  const failed = result.steps.find(row => !row.ok);
  assert.equal(failed.step, 'recommission'); assert.equal(failed.exitCode, 2); assert.equal(failed.limitMs, 600_000);
  assert.match(failed.error, /^config update failed: line one \/ configuration invalid: providers\.planner\.model required \(the recommission step \(node .*config update --state .* --current\) exited with code 2/);
  assert.match(failed.stderr, /configuration invalid/);
  assert.equal(result.steps.some(row => row.step === 'doctor'), false);
});

test('dev.85: lastDoctorProgress reads the line format the doctor CLI prints', async () => {
  const { doctorProgressLine } = await import('../starter/factory/workflows/commission.mjs');
  const { lastDoctorProgress } = await import('../starter/factory/operations/upgrade-apply.mjs');
  const stderr = [doctorProgressLine('probe of reviewer (claude/fictional)', 'attempt 1 of 2'), 'unrelated', doctorProgressLine('main verification', 'heavy-work acquired; verifying origin/main')].join('\n');
  assert.deepEqual(lastDoctorProgress(stderr), { phase: 'main verification', detail: 'heavy-work acquired; verifying origin/main' });
  assert.equal(lastDoctorProgress('no progress here'), null);
});

test('dev.85: through the real process runner, a merged CLI whose doctor is not ready is reported with its reasons, phase and output', async t => {
  // The merged release's CLI stands in for doctor: progress on stderr, a not-ready record on stdout.
  const cli = `const [command] = process.argv.slice(2);
if (command === 'doctor') { console.error('doctor: [probe of planner (codex/fictional-model)] attempt 1 of 2'); console.error('doctor: [forge check] GitHub repository fictional/project'); console.log(JSON.stringify({ ready: false, reasons: ['GitHub repository push permission required'] })); process.exit(1); }
console.log('{}');\n`;
  const f = fixture(t, { cli }); committed(f);
  const { runProcess } = await import('../starter/factory/adapters/providers/index.mjs');
  const run = (binary, args, options) => binary === process.execPath ? runProcess(binary, args, options) : f.run(binary, args, options);
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run });
  assert.equal(result.ok, false);
  const doctorStep = result.steps.find(row => row.step === 'doctor');
  assert.deepEqual(doctorStep.reasons, ['GitHub repository push permission required']); assert.equal(doctorStep.phase, 'forge check');
  assert.match(doctorStep.error, /^the doctor step \(node \S+\/factory\/cli\.mjs doctor --state \S+\) exited with code 1 after \d+ s: GitHub repository push permission required$/);
  assert.match(doctorStep.stderr, /doctor: \[forge check\]/);
  assert.equal(result.steps.find(row => row.step === 'recommission').ok, true);
});

// dev.85 review fixes 2 and 4.
test('dev.85 review: the console comes back after recommissioning while the project runner stays stopped until doctor has ended', async t => {
  const f = fixture(t); committed(f);
  const { unitName } = await import('../starter/factory/operations/services.mjs'), projectUnit = unitName('project', f.store.meta('project').projectId);
  f.active.add(projectUnit);
  const seen = {}, runCli = async args => {
    if (args[0] === 'doctor') { seen.duringDoctor = { console: f.active.has('factotum-console.service'), project: f.active.has(projectUnit), commissioning: f.store.meta('commissioning') }; return { code: 0, stdout: '{}', stderr: '' }; }
    // config update clears commissioning (core/project.mjs), as the real CLI does.
    f.store.setMeta('commissioning', null); seen.duringRecommission = { console: f.active.has('factotum-console.service'), project: f.active.has(projectUnit) }; return { code: 0, stdout: '{}', stderr: '' };
  };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(seen.duringRecommission, { console: false, project: false });
  assert.deepEqual({ ...seen.duringDoctor, commissioning: seen.duringDoctor.commissioning ?? null }, { console: true, project: false, commissioning: null });
  assert.deepEqual(result.steps.map(row => row.step === 'start' ? `start ${row.unit}` : row.step), ['stop', 'backup', 'merge', 'verify', 'cleanup', 'recommission', 'start factotum-console.service', 'doctor', `start ${projectUnit}`]);
  assert.ok(f.active.has(projectUnit) && f.active.has('factotum-console.service'));
  // A failed recommission brings everything back at the end, and doctor does not run.
  const g = fixture(t); committed(g); g.active.add(unitName('project', g.store.meta('project').projectId));
  const failed = await mergeUpgrade({ ...g.options, backupDir: join(g.base, 'backup'), run: g.run, runCli: async args => args[0] === 'config' ? { code: 1, stdout: '', stderr: 'bad' } : { code: 0, stdout: '{}', stderr: '' } });
  assert.deepEqual(failed.steps.map(row => row.step).slice(-3), ['recommission', 'start', 'start']); assert.equal(failed.steps.some(row => row.step === 'doctor'), false);
});

test('dev.85 review: the upgrade result is redacted whole: commands, paths and messages of every step', async t => {
  const f = fixture(t); committed(f);
  // A known secret that happens to appear in the paths the steps record (the sandbox folder's name).
  const secret = f.base.split('/').at(-1); withSecret(t, secret);
  const runCli = async args => { if (args[0] !== 'doctor') return { code: 0, stdout: '{}', stderr: '' }; throw Object.defineProperties(Object.assign(new Error('factory CLI doctor timed out after 3900 s'), { code: 'TIMEOUT' }), { stdout: { value: '' }, stderr: { value: `doctor: [main verification] verifying ${f.root}` } }); };
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli });
  const doctorStep = result.steps.find(row => row.step === 'doctor');
  assert.match(doctorStep.command, /\[redacted\]/); assert.match(doctorStep.error, /^the doctor step \(node \S*\[redacted\]\S* doctor --state \S*\[redacted\]\S*\) timed out/);
  assert.ok(!JSON.stringify(result).includes(secret), JSON.stringify(result).slice(0, 2000));
});

test('dev.85 review: workspace setup is bounded; a command that outlives its timeout is stopped and setup fails', async t => {
  const f = sandbox(t), { prepare, SETUP_TIMEOUT_MS } = await import('../starter/factory/adapters/workspace/index.mjs');
  const marker = join(f.base, 'late-marker'), started = Date.now();
  await assert.rejects(prepare({ root: f.root, stateDir: f.stateDir, projectId: f.store.meta('project').projectId, flowId: 'setup-timeout', setup: [['/bin/sh', '-c', `sleep 30; touch '${marker}'`]], setupTimeoutMs: 400 }), /^Error: workspace setup timed out after 0 s \(\/bin\/sh\)$/);
  assert.ok(Date.now() - started < 20000, 'stopped well before the command would have finished');
  await assert.rejects(prepare({ root: f.root, stateDir: f.stateDir, projectId: f.store.meta('project').projectId, flowId: 'setup-timeout', setup: [['/bin/sh', '-c', `sleep 30; touch '${marker}'`]], setupTimeoutMs: 400 }), /setup outcome uncertain; inspect before retry/);
  assert.equal(existsSync(marker), false);
  assert.equal(SETUP_TIMEOUT_MS, 1_800_000);
  await assert.rejects(prepare({ root: f.root, stateDir: f.stateDir, projectId: f.store.meta('project').projectId, flowId: 'setup-bad', setup: [], setupTimeoutMs: 0 }), /workspace setup timeout must be a positive number/);
  // A setup that finishes inside the default bound is unaffected.
  const ready = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.store.meta('project').projectId, flowId: 'setup-ok', setup: [['/bin/sh', '-c', 'true']] });
  assert.ok(ready.head);
  const { validateConfig } = await import('../starter/factory/core/configuration.mjs');
  const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
  assert.equal(validateConfig({ ...base, workspace: { setup: [], setupTimeoutMs: 3_600_000 } }).workspace.setupTimeoutMs, 3_600_000);
  assert.throws(() => validateConfig({ ...base, workspace: { setup: [], setupTimeoutMs: 5 * 3_600_000 } }), /workspace\.setupTimeoutMs must be a positive number of milliseconds, at most four hours/);
});

// ---- The stored configuration is validated by the release being adopted ----
// (docs/changes/upkeep-slice2.md, second review.) Not by the CLI that runs the command: these
// fictional releases carry validators that differ from this checkout's, and theirs decide.
const REFUSES_FLAG = 'export function validateConfig(config) { if (config.fictionalFlag) throw new Error("fictional: fictionalFlag is not accepted by this release"); return config; }\n';
const flag = (f, on) => { const { fictionalFlag, ...config } = f.store.meta('config') ?? {}; f.store.setMeta('config', on ? { ...config, fictionalFlag: true } : config); };
const worktrees = f => git(f.root, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).length;

test('upgrade apply validates the stored configuration with the release being adopted, before preparing or merging anything', async t => {
  const f = fixture(t, { validator: REFUSES_FLAG }), head = git(f.root, ['rev-parse', 'HEAD']), before = worktrees(f);
  // Refused by the release's validator: nothing is prepared.
  flag(f, true);
  assert.throws(() => prepareUpgrade(f.options), error => { assert.match(error.message, /stored configuration is not valid for the release being adopted \(1\.1\.0\), so the upgrade would leave it unable to recommission: fictional: fictionalFlag is not accepted by this release\. Nothing was changed\. Correct it first, with the release the project runs now/); return true; });
  assert.equal(existsSync(f.options.worktreeDir), false); assert.equal(git(f.root, ['branch', '--list', f.options.branch]), ''); assert.equal(worktrees(f), before);
  // Accepted: prepared. Then the configuration changes before the merge, and the merge refuses before stopping anything.
  flag(f, false); const prepared = prepareUpgrade(f.options); git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  flag(f, true);
  await assert.rejects(mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli }), /not valid for the release being adopted \(1\.1\.0\).*fictionalFlag is not accepted/);
  assert.deepEqual(f.systemctl.filter(line => line.startsWith('stop')), []); assert.deepEqual(f.cliCalls, []); assert.equal(git(f.root, ['rev-parse', 'HEAD']), head); assert.equal(existsSync(join(f.base, 'backup')), false);
  flag(f, false);
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli }); assert.equal(result.ok, true, JSON.stringify(result.steps));
});

test('it is the release\'s validator that decides, not the running CLI\'s: a configuration this checkout would refuse is accepted for a release that accepts it', async t => {
  const { validateConfig } = await import('../starter/factory/core/configuration.mjs');
  const f = fixture(t);
  f.store.setMeta('config', { ...f.store.meta('config'), upkeep: { mode: 'apply' } });
  assert.throws(() => validateConfig(f.store.meta('config')), /upkeep\.mode must be one of off, observe, propose/, 'the running validator refuses it');
  assert.match(prepareUpgrade(f.options).next, /--merge/, 'the fictional release 1.1.0 accepts it, so the upgrade is prepared');
});

test('a release whose validator is missing or cannot be loaded cannot be checked, and is refused', t => {
  for (const [validator, pattern] of [[null, /cannot be checked against the release being adopted \(1\.1\.0\): its validator \(factory\/core\/configuration\.mjs\) is not in the release\. Nothing was changed\. The upgrade is refused rather than applied unchecked/], ['export const validateConfig = ;\n', /could not be loaded \(/], ['export const somethingElse = 1;\n', /could not be loaded \(it exports no validateConfig\)/], ['import "./missing-module.mjs";\nexport const validateConfig = config => config;\n', /could not be loaded \(/]]) {
    const f = fixture(t, { validator }), before = worktrees(f);
    assert.throws(() => prepareUpgrade(f.options), pattern, JSON.stringify(validator));
    assert.equal(existsSync(f.options.worktreeDir), false); assert.equal(worktrees(f), before);
  }
});

// ---- --activate: nothing from the remote target is run before activation ----
// (Second re-check, P1 and P2.) The stored configuration is validated before activation only with a
// release directory verified against the pinned digest. No checkout of the remote target is made.

// The reviewed adoption of release 1.1.0 lands on the remote target through a squash-merged pull
// request, as in the activation test above. `tamper` edits the adoption on its way there.
// `real` adopts a release built from this checkout's own starter instead of the fictional 1.1.0.
function landed(t, { validator, tamper, real = false } = {}) {
  const f = fixture(t, { validator });
  if (real) { const dir = join(f.base, 'release-real'), built = buildRelease({ sourceDir: fileURLToPath(new URL('../starter', import.meta.url)), outputDir: dir, version: '0.2.0-dev.20261116.2', allowWorkingTree: true }); f.real = { dir, digest: built.manifestDigest }; Object.assign(f.options, { releaseDir: dir, expectedDigest: built.manifestDigest }); }
  const prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const target = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']), remote = join(f.base, 'remote.git'), other = join(f.base, 'other');
  git(f.base, ['init', '-q', '--bare', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `HEAD:refs/heads/${target}`]);
  git(f.base, ['clone', '-q', remote, other]); git(other, ['config', 'user.email', 'f@example.invalid']); git(other, ['config', 'user.name', 'F']); git(other, ['checkout', '-q', target]);
  git(other, ['fetch', '-q', f.root, `${f.options.branch}:review`]); git(other, ['merge', '-q', '--squash', 'review']); tamper?.(other, f); git(other, ['add', '-A']); git(other, ['commit', '-qm', 'Adopt 1.1.0 (#1)']); git(other, ['push', '-q', 'origin', target]);
  f.store.setMeta('config', { ...f.store.meta('config'), repository: { remote: 'origin', target } });
  return { ...f, head: git(f.root, ['rev-parse', 'HEAD']) };
}
// Every Git command this process starts, logged by a `git` first on PATH that then runs the real one.
function gitLog(t, f) {
  const bin = join(f.base, 'logged-bin'), log = join(f.base, 'git.log'), was = process.env.PATH, real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  mkdirSync(bin); writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexec ${real} "$@"\n`, { mode: 0o755 });
  process.env.PATH = `${bin}:${was}`; t.after(() => { process.env.PATH = was; });
  return () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}
const noWorktree = (f, commands, before, label) => { assert.ok(commands().length > 0, 'the log sees the Git commands'); assert.deepEqual(commands().filter(line => /\bworktree\b.*\badd\b/.test(line)), [], `${label}: no worktree was created`); assert.equal(worktrees(f), before, `${label}: none is registered`); };

test('activate without a verified release directory skips the preflight and says so; with one, the release\'s validator decides before anything is stopped', async t => {
  const f = landed(t, { validator: REFUSES_FLAG }), commands = gitLog(t, f), before = worktrees(f);
  const { activateUpgrade } = await import('../starter/factory/operations/upgrade-apply.mjs');
  let backups = 0; const activate = extra => activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, `backup-${++backups}`), run: f.run, runCli: f.runCli, ...extra });
  // The release at the target would refuse this configuration.
  flag(f, true);
  // With the verified release directory: refused before anything is stopped or pulled.
  await assert.rejects(activate({ releaseDir: f.two.dir }), /not valid for the release being adopted \(1\.1\.0\).*fictionalFlag is not accepted by this release/);
  assert.deepEqual(f.systemctl.filter(line => line.startsWith('stop')), []); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head); assert.deepEqual(f.cliCalls, []);
  // A directory that is not the pinned release is refused, not skipped: the operator named it.
  await assert.rejects(activate({ releaseDir: join(f.base, 'release-1.0.0') }), /release manifest checksum mismatch/);
  await assert.rejects(activate({ releaseDir: join(f.base, 'no-such-release') }));
  assert.deepEqual(f.systemctl.filter(line => line.startsWith('stop')), []); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head);
  noWorktree(f, commands, before, 'refused activations');
  // Without one (this checkout's code does not run from a release artifact): not refused. The
  // preflight is skipped, said to be, and activation goes on to its own steps and to doctor, as before.
  const result = await activate({});
  assert.deepEqual(Object.keys(result.configCheck), ['checked', 'reason']); assert.equal(result.configCheck.checked, false);
  assert.match(result.configCheck.reason, /^the stored configuration was not checked before activation: no release directory was given, and this CLI does not run from a release artifact\. Doctor, after activation, is the check\. To have it checked first, pass --release /);
  assert.equal(result.ok, true, JSON.stringify(result.steps)); assert.deepEqual(result.steps.map(row => row.step).filter(step => step !== 'start'), ['stop', 'backup', 'pull', 'recommission', 'doctor']); assert.equal(adoptionStatus({ root: f.root }).version, '1.1.0');
  noWorktree(f, commands, before, 'an activation with no release directory');
});

test('activate with the verified release directory and a configuration it accepts: checked, then activated; no worktree on that path either', async t => {
  const f = landed(t, { validator: REFUSES_FLAG }), commands = gitLog(t, f), before = worktrees(f);
  const { activateUpgrade } = await import('../starter/factory/operations/upgrade-apply.mjs');
  const result = await activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, 'backup'), releaseDir: f.two.dir, run: f.run, runCli: f.runCli });
  assert.deepEqual(result.configCheck, { checked: true, version: '1.1.0', source: 'the release directory given' });
  assert.equal(result.ok, true, JSON.stringify(result.steps)); assert.equal(adoptionStatus({ root: f.root }).version, '1.1.0');
  noWorktree(f, commands, before, 'a checked activation');
  // The module holds no way to make one, and no temporary directory: nothing to leave behind on a signal.
  const source = readFileSync(new URL('../starter/factory/operations/upgrade-apply.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /'worktree', *'(add|remove|prune)'|mkdtemp|tmpdir/);
});

test('P1: a validator substituted on the remote target, with its lock entry updated to match, is never run before activation', async t => {
  const marker = f => join(f.base, 'substituted-validator-ran');
  // The attacker's adoption commit: the validator replaced by one that writes a marker (when loaded
  // and when called), and its SHA-256 in the lock's managedFiles updated. The lock's manifest and
  // payload digests stay those of release 1.1.0, which is all a root installation's lock pins.
  const tamper = (checkout, f) => {
    const body = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker(f))}, 'loaded');\nexport function validateConfig(config) { writeFileSync(${JSON.stringify(marker(f))}, 'called'); return config; }\n`;
    put(checkout, 'factory/core/configuration.mjs', body);
    const lock = JSON.parse(readFileSync(join(checkout, 'factotum.lock.json'), 'utf8')), entry = lock.managedFiles.find(file => file.path === 'factory/core/configuration.mjs');
    const digests = JSON.stringify(lock.release); entry.sha256 = createHash('sha256').update(body).digest('hex');
    writeFileSync(join(checkout, 'factotum.lock.json'), JSON.stringify(lock, null, 2) + '\n'); assert.equal(JSON.stringify(lock.release), digests);
  };
  const { activateUpgrade } = await import('../starter/factory/operations/upgrade-apply.mjs');
  for (const withRelease of [false, true]) {
    const f = landed(t, { tamper }), commands = gitLog(t, f), before = worktrees(f), label = `${withRelease ? 'with' : 'without'} the release directory`;
    // Whether the marker existed when the first unit was stopped: nothing may have run before that.
    let stops = 0, beforeStop = null; const run = async (binary, args) => { if (binary === 'systemctl' && args[1] === 'stop' && !stops++) beforeStop = existsSync(marker(f)); return f.run(binary, args); };
    // dev.87: the root lock's layout evidence no longer rebuilds 1.1.0's manifest, so the activation is
    // refused before anything is stopped or pulled (see tests/root-lock-authentication.test.mjs).
    await assert.rejects(activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: f.two.manifestDigest, backupDir: join(f.base, 'backup'), run, runCli: f.runCli, ...(withRelease ? { releaseDir: f.two.dir } : {}) }), /managed files and layout do not rebuild the release manifest it names \(1\.1\.0, /, label);
    assert.equal(existsSync(marker(f)), false, `${label}: the substituted validator was never loaded or called`); assert.equal(stops, 0, `${label}: nothing was stopped`); assert.equal(beforeStop, null);
    assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head, `${label}: nothing was pulled`); assert.deepEqual(f.cliCalls, [], label);
    noWorktree(f, commands, before, label);
  }
});

test('run from the release artifact, as documented, activate validates with that release: the CLI\'s own files, verified against the pinned digest', async t => {
  const f = landed(t, { real: true }), commands = gitLog(t, f), before = worktrees(f);
  // The upgrade command of the release itself: <release>/starter/factory/…, not this checkout's.
  const own = await import(pathToFileURL(join(f.real.dir, 'starter/factory/operations/upgrade-apply.mjs')).href);
  let backups = 0; const activate = digest => own.activateUpgrade({ root: f.root, stateDir: f.stateDir, expectedDigest: digest, backupDir: join(f.base, `backup-${++backups}`), run: f.run, runCli: f.runCli });
  // A block earlier releases ignored: this release refuses it, before anything is stopped or pulled.
  const stored = f.store.meta('config'); f.store.setMeta('config', { ...stored, upkeep: { mode: 'apply' } });
  await assert.rejects(activate(f.real.digest), /not valid for the release being adopted \(0\.2\.0-dev\.20261116\.2\).*upkeep\.mode must be one of off, observe, propose.*replace it with a valid block/);
  assert.deepEqual(f.systemctl.filter(line => line.startsWith('stop')), []); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head);
  // Activating some other release with this CLI: its own files are not that release, so there is
  // nothing verified to validate with. Skipped and said, not refused; the pull step then finds the mismatch as before.
  const other = await activate(f.two.manifestDigest);
  assert.equal(other.configCheck.checked, false); assert.match(other.configCheck.reason, /no release directory was given, and the release this CLI runs from is not the one being activated \(release manifest checksum mismatch\)\. Doctor, after activation, is the check/);
  assert.equal(other.ok, false); assert.match(other.steps.find(row => !row.ok).error, /does not hold the release/);
  // Corrected, it is checked with the release's own validator and activated.
  f.store.setMeta('config', stored);
  const result = await activate(f.real.digest);
  assert.deepEqual(result.configCheck, { checked: true, version: '0.2.0-dev.20261116.2', source: 'the release this CLI runs from' });
  assert.equal(result.ok, true, JSON.stringify(result.steps)); assert.equal(adoptionStatus({ root: f.root }).version, '0.2.0-dev.20261116.2');
  noWorktree(f, commands, before, 'activation from the release artifact');
});
