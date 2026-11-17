// dev.87: a root installation's lock authenticates its managed files against the pinned manifest
// digest, as a prefixed one already did. The finding (docs/changes/upkeep-slice2.md, "a root
// installation's lock does not authenticate its files"): a managed file replaced together with its
// SHA-256 in factotum.lock.json, digests unchanged, passed activation, --merge, doctor and adopt
// status. Every project, path and release here is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
// Namespace imports, so that on a release without these exports the tests fail on their assertions.
import * as distribution from '../starter/factory/distribution.mjs';
import { prepareUpgrade, mergeUpgrade } from '../starter/factory/operations/upgrade-apply.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { adoptionCheck, git, put, readLock, writeLock, adoptStatus, release, SUBSTITUTE, substitute, earlierShape, fixture, landed, activate, stops } from './adoption-fixtures.mjs';

const { prepareAdoption, adoptionStatus } = distribution;
const sha256Of = root => createHash('sha256').update(readFileSync(join(root, 'factotum.lock.json'))).digest('hex');

test('the repro is refused at activation, with and without the release directory, before anything is stopped or pulled', async t => {
  for (const withRelease of [false, true]) {
    const f = landed(t, { tamper: substitute }), label = withRelease ? 'with --release' : 'without --release';
    await assert.rejects(activate(f, withRelease ? { releaseDir: f.two.dir } : {}), /managed files and layout do not rebuild the release manifest it names \(1\.1\.0, /, label);
    assert.deepEqual(stops(f), [], label); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head, label); assert.deepEqual(f.cliCalls, [], label);
  }
});

test('the repro is refused by upgrade apply --merge before anything is stopped, also with the lock\'s evidence stripped', async t => {
  for (const [label, edit] of [['evidence kept', substitute], ['evidence stripped', checkout => { substitute(checkout); earlierShape(checkout); }]]) {
    const f = fixture(t), prepared = prepareUpgrade(f.options);
    git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
    edit(prepared.worktree); git(prepared.worktree, ['add', '-A']); git(prepared.worktree, ['commit', '-q', '--amend', '--no-edit']);
    const head = git(f.root, ['rev-parse', 'HEAD']);
    await assert.rejects(mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli }), label === 'evidence kept' ? /do not rebuild the release manifest it names \(1\.1\.0, / : /names release 1\.1\.0 \([0-9a-f]{12}…\), but its managed files are not that release's/, label);
    assert.deepEqual(stops(f), [], label); assert.equal(git(f.root, ['rev-parse', 'HEAD']), head, label); assert.deepEqual(f.cliCalls, [], label);
  }
});

test('the repro is refused by doctor\'s drift check and by adopt status, with or without the history walk', t => {
  const f = fixture(t, { tamper: substitute });
  const check = adoptionCheck(f.root);
  assert.equal(check.reasons.length, 1, JSON.stringify(check)); assert.match(check.reasons[0], /^adoption lock check failed: factotum\.lock\.json's managed files and layout do not rebuild the release manifest it names \(1\.0\.0, /);
  assert.throws(() => adoptionStatus({ root: f.root, history: false }), /do not rebuild the release manifest/);
  assert.throws(() => adoptionStatus({ root: f.root }), /do not rebuild the release manifest/);
  const status = adoptStatus(f.root); assert.notEqual(status.code, 0); assert.match(status.err, /do not rebuild the release manifest it names \(1\.0\.0, /);
});

const lockReasons = result => result.reasons.filter(reason => /adoption lock|factotum\.lock\.json/.test(reason)), lockWarnings = result => (result.warnings ?? []).filter(warning => /factotum\.lock\.json/.test(warning));
// Doctor for a fixture's checkout: a remote target, a systemd project state of its own, and stub
// providers and forge. Each call runs doctor once.
async function doctorFor(f) {
  const { doctor } = await import('../starter/factory/workflows/commission.mjs'), { Store, initProject } = await import('../starter/factory/core/store.mjs'), { digest } = await import('../starter/factory/core/contracts.mjs');
  const options = { providerPreflight: async spec => ({ provider: spec.provider, version: 'fictional', billing: { mode: 'subscription' }, capabilities: { structuredOutput: true, readOnly: true } }), forgeTransport: async () => ({ permissions: { push: true } }) };
  put(f.root, 'fixture.txt', 'fictional\n'); git(f.root, ['add', '.']); git(f.root, ['commit', '-qm', 'Fixture']);
  const remote = join(f.base, 'remote.git'); git(f.base, ['init', '--bare', '-q', remote]); git(f.root, ['remote', 'add', 'origin', remote]); const branch = git(f.root, ['rev-parse', '--abbrev-ref', 'HEAD']); git(f.root, ['push', '-q', 'origin', branch]);
  const stateDir = join(f.base, 'doctor-state'); initProject({ stateDir, root: f.root, name: 'Fictional', supervisor: 'systemd', workflow: { version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } } });
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/project', account: 'fictional', target: branch, remote: 'origin' }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { maxFlows: 1 }, checks: [{ id: 'fixture', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], mainChecks: [{ id: 'main', argv: [process.execPath, '-e', "require('node:fs').readFileSync('fixture.txt')"], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, resources: { coordinatorPath: join(f.base, 'host.sqlite') }, backupRoot: join(f.base, 'backups') };
  const store = new Store(stateDir); store.setMeta('config', config); store.setMeta('configDigest', digest(config)); store.close();
  return { stateDir, run: () => doctor(stateDir, options), anchor: () => { const opened = new Store(stateDir); try { return opened.meta('adoptionAnchor', null); } finally { opened.close(); } } };
}

test('doctor itself reports the repro as a reason, and an earlier root lock as a warning only', async t => {
  const results = {};
  for (const [label, shape] of [['substituted', { tamper: substitute }], ['earlier lock', { legacy: true }], ['genuine', {}]]) results[label] = await (await doctorFor(fixture(t, shape))).run();
  assert.equal(lockReasons(results.substituted).length, 1, JSON.stringify(results.substituted.reasons)); assert.match(lockReasons(results.substituted)[0], /do not rebuild the release manifest it names \(1\.0\.0, /);
  assert.deepEqual(lockReasons(results['earlier lock']), [], 'an earlier root lock does not stop doctor');
  assert.equal(lockWarnings(results['earlier lock']).length, 1); assert.match(lockWarnings(results['earlier lock'])[0], /root lock written before dev\.87, without layout evidence.*unauthenticated until the next adoption/);
  assert.deepEqual(lockReasons(results.genuine), []); assert.deepEqual(lockWarnings(results.genuine), []);
});

test('a genuine root installation and a prefixed one are authenticated and pass every check', async t => {
  const f = fixture(t);
  assert.ok(readLock(f.root).rootLayout, 'a root lock carries its layout evidence');
  assert.equal(adoptionStatus({ root: f.root }).authenticated, true); assert.equal('warning' in adoptionStatus({ root: f.root }), false);
  assert.deepEqual(adoptionCheck(f.root), { reasons: [], warnings: [] });
  const status = adoptStatus(f.root); assert.equal(status.code, 0, status.err); assert.equal(status.err, ''); assert.equal(JSON.parse(status.out).authenticated, true);
  // Prefixed: unchanged, and reported as authenticated.
  const p = sandbox(t); git(p.root, ['config', 'commit.gpgsign', 'false']);
  const one = release(p, '1.0.0', 'one'), installed = prepareAdoption({ root: p.root, releaseDir: one.dir, expectedDigest: one.manifestDigest, branch: 'chore/install', worktreeDir: join(p.base, 'install'), initial: true, prefix: 'tools/factotum' });
  git(installed.worktree, ['add', '-A']); git(installed.worktree, ['commit', '-qm', 'Adopt 1.0.0']); git(p.root, ['merge', '--ff-only', 'chore/install']);
  assert.ok(readLock(p.root).layout && !('rootLayout' in readLock(p.root)));
  assert.equal(adoptionStatus({ root: p.root }).authenticated, true); assert.deepEqual(adoptionCheck(p.root), { reasons: [], warnings: [] });
  // A genuine landed root adoption activates without a release directory: its lock authenticates itself.
  const g = landed(t), result = await activate(g);
  assert.equal(result.ok, true, JSON.stringify(result.steps)); assert.equal(adoptionStatus({ root: g.root }).version, '1.1.0'); assert.equal(adoptionStatus({ root: g.root }).authenticated, true);
});

test('an earlier root lock without evidence is accepted, unauthenticated, with a warning; doctor and adopt status keep working', t => {
  const f = fixture(t, { legacy: true });
  assert.equal('rootLayout' in readLock(f.root), false);
  const status = adoptionStatus({ root: f.root });
  assert.equal(status.clean, true); assert.equal(status.authenticated, false);
  assert.match(status.warning, /^factotum\.lock\.json \(release 1\.0\.0\) is a root lock written before dev\.87, without layout evidence: .* unauthenticated until the next adoption/);
  assert.deepEqual(adoptionCheck(f.root), { reasons: [], warnings: [status.warning] });
  const shown = adoptStatus(f.root); assert.equal(shown.code, 0, shown.err); assert.match(shown.err, /^warning: factotum\.lock\.json \(release 1\.0\.0\) is a root lock written before dev\.87/);
  assert.equal(JSON.parse(shown.out).authenticated, false);
  // Evidence cannot be added by hand: only an adoption writes it (the history walk refuses the edit).
  const genuine = fixture(t), lock = readLock(f.root); lock.rootLayout = readLock(genuine.root).rootLayout; writeLock(f.root, lock); git(f.root, ['commit', '-qam', 'Hand-added evidence']);
  assert.throws(() => adoptionStatus({ root: f.root }), /changed its managed files since [0-9a-f]{12} adopted 1\.0\.0/);
});

test('activating a release whose landed root lock has no evidence needs the verified release, which then authenticates it', async t => {
  // An adoption prepared with an earlier release's CLI (adopt update) writes the earlier lock shape.
  const f = landed(t, { tamper: earlierShape });
  await assert.rejects(activate(f), /root lock without layout evidence, so it cannot show that its managed files are that release's\. Nothing was changed\. Pass --release/);
  assert.deepEqual(stops(f), []); assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head);
  const result = await activate(f, { releaseDir: f.two.dir });
  assert.equal(result.ok, true, JSON.stringify(result.steps)); assert.equal(adoptionStatus({ root: f.root, release: distribution.readRelease(f.two.dir, f.two.manifestDigest) }).authenticated, true);
  // The same, substituted: the verified manifest refuses it before anything is stopped.
  const s = landed(t, { tamper: checkout => { earlierShape(checkout); substitute(checkout); } });
  await assert.rejects(activate(s, { releaseDir: s.two.dir }), /names release 1\.1\.0 \([0-9a-f]{12}…\), but its managed files are not that release's/);
  await assert.rejects(activate(s), /root lock without layout evidence/);
  assert.deepEqual(stops(s), []); assert.equal(git(s.root, ['rev-parse', 'HEAD']), s.head);
});

test('an upgrade from an earlier root lock writes the evidence, and the warning goes away', async t => {
  const f = fixture(t, { legacy: true }); assert.equal(adoptionStatus({ root: f.root }).authenticated, false);
  const prepared = prepareUpgrade(f.options), lock = readLock(prepared.worktree);
  assert.ok(lock.rootLayout?.templateFiles?.length && lock.rootLayout.compatibility, 'the new lock carries its layout evidence'); assert.equal('layout' in lock, false);
  assert.equal(adoptionStatus({ root: prepared.worktree }).authenticated, true);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const result = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.equal(adoptionStatus({ root: f.root }).version, '1.1.0'); assert.equal(adoptionStatus({ root: f.root }).authenticated, true);
  assert.deepEqual(adoptionCheck(f.root), { reasons: [], warnings: [] });
});

test('a pull the activation refuses returns the checkout, so the restarted units run the code they ran before', async t => {
  // The lock is genuine; a managed file is replaced without touching it.
  const f = landed(t, { tamper: checkout => put(checkout, 'factory/core/configuration.mjs', SUBSTITUTE) });
  const result = await activate(f);
  assert.equal(result.ok, false); const failed = result.steps.find(row => !row.ok);
  assert.equal(failed.step, 'pull'); assert.match(failed.error, /installed files differ from 1\.1\.0's lock: factory\/core\/configuration\.mjs \(locally modified managed file\)/);
  // The rollback is recorded, and comes before any unit is started.
  const names = result.steps.map(row => row.step), rollback = result.steps.find(row => row.step === 'rollback');
  assert.ok(rollback, JSON.stringify(result.steps)); assert.deepEqual([rollback.from, rollback.to], [f.remoteHead, f.head]); assert.ok(names.indexOf('rollback') < names.indexOf('start'), names.join(', '));
  assert.equal(git(f.root, ['rev-parse', 'HEAD']), f.head); assert.equal(git(f.root, ['status', '--porcelain']), '');
  assert.equal(adoptionStatus({ root: f.root }).version, '1.0.0'); assert.ok(f.systemctl.includes('start factotum-console.service')); assert.deepEqual(f.cliCalls, []);
});

// ---- Decision (b), dev.87 review: no authentication downgrade ----
// Once the project's lock has verified with its evidence, the project's state (outside the checkout)
// records it, and a later root lock without evidence is refused unless a verified release directory
// authenticated that exact lock.
const DOWNGRADE = /factotum\.lock\.json \(release [0-9.]+\) is a root lock without layout evidence, but this project's lock was authenticated by its evidence before \(release 1\.[01]\.0, recorded in the project's state on [^)]+\)\. From then on a lock in that earlier shape is refused: .* Prepare the adoption with the release's own CLI \(node <release>\/starter\/factory\/cli\.mjs upgrade apply …\), which writes the evidence, or apply it with --release/;
const anchorOf = f => f.store.meta('adoptionAnchor', null);
// An adoption commit of `version` whose lock is in the earlier shape and whose validator is substituted, its hash in the lock.
function downgradedAdoption(f, version) {
  const next = release(f, version, `release ${version}`), prepared = prepareAdoption({ root: f.root, releaseDir: next.dir, expectedDigest: next.manifestDigest, branch: `chore/${version}`, worktreeDir: join(f.base, `review-${version}`) });
  earlierShape(prepared.worktree); substitute(prepared.worktree);
  git(prepared.worktree, ['add', '-A']); git(prepared.worktree, ['commit', '-qm', `Adopt ${version}`]); git(f.root, ['merge', '-q', '--ff-only', `chore/${version}`]);
  return next;
}

test('after --merge verifies a lock by its evidence, a later adoption in the earlier shape is refused by adopt status and the drift check, and needs --release to activate', async t => {
  const f = fixture(t), prepared = prepareUpgrade(f.options);
  git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.1.0']);
  const merged = await mergeUpgrade({ ...f.options, backupDir: join(f.base, 'backup'), run: f.run, runCli: f.runCli });
  assert.equal(merged.ok, true, JSON.stringify(merged.steps));
  assert.deepEqual({ ...anchorOf(f)?.evidence, at: undefined }, { manifestDigest: f.two.manifestDigest, version: '1.1.0', at: undefined }, 'the state records the first lock verified by its evidence');
  downgradedAdoption(f, '1.2.0');
  const anchor = anchorOf(f);
  // The drift check doctor runs, with the project's record.
  const check = adoptionCheck(f.root, { anchor });
  assert.equal(check.reasons.length, 1, JSON.stringify(check)); assert.match(check.reasons[0], /^adoption lock check failed: /); assert.match(check.reasons[0], DOWNGRADE);
  // adopt status with the project's state: refused, with the recovery named.
  const refused = adoptStatus(f.root, '--state', f.stateDir); assert.notEqual(refused.code, 0); assert.match(refused.err, DOWNGRADE);
  // Without the state it cannot know: the transition behaviour, and the warning says what was not checked.
  const unchecked = adoptStatus(f.root); assert.equal(unchecked.code, 0, unchecked.err);
  assert.match(unchecked.err, /^warning: factotum\.lock\.json \(release 1\.2\.0\) is a root lock written before dev\.87.* \(pass --state <the project's state directory> to check it against the project's record of its authentication\)/);
  const missing = adoptStatus(f.root, '--state', join(f.base, 'no-such-state')); assert.equal(missing.code, 0, missing.err); assert.match(missing.err, /could not be read .*so the lock was not checked against the project's record/);
  assert.deepEqual(adoptionCheck(f.root, { anchor: null }).reasons, [], 'a state with no record (a fresh machine) keeps the transition behaviour');
});

test('doctor records the first lock it verifies by its evidence, and refuses a lock stripped of it afterwards', async t => {
  const f = fixture(t), d = await doctorFor(f);
  assert.equal(d.anchor(), null);
  const first = await d.run(); assert.deepEqual(lockReasons(first), []); assert.deepEqual(lockWarnings(first), []);
  assert.equal(d.anchor()?.evidence?.manifestDigest, f.one.manifestDigest);
  // The evidence stripped and a file substituted with its hash: doctor reads no history, only the lock and files.
  earlierShape(f.root); substitute(f.root); git(f.root, ['commit', '-qam', 'Strip the evidence']);
  const second = await d.run();
  assert.equal(lockReasons(second).length, 1, JSON.stringify(second.reasons)); assert.match(lockReasons(second)[0], DOWNGRADE);
  assert.deepEqual(lockWarnings(second), []);
});

test('a lock in the earlier shape that a verified release authenticated is accepted after the evidence anchor, and recorded', async t => {
  // An adoption prepared with an earlier release's CLI lands without evidence; this project's lock had evidence before.
  const f = landed(t, { tamper: earlierShape });
  f.store.setMeta('adoptionAnchor', { evidence: { manifestDigest: f.one.manifestDigest, version: '1.0.0', at: '2026-11-16T00:00:00.000Z' } });
  await assert.rejects(activate(f), /root lock without layout evidence, so it cannot show that its managed files are that release's\. Nothing was changed\. Pass --release .* or prepare the adoption again with that release's own CLI, which writes the evidence/);
  const result = await activate(f, { releaseDir: f.two.dir });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  const anchor = anchorOf(f), lockSha256 = sha256Of(f.root);
  assert.deepEqual({ ...anchor.releaseVerified, at: undefined }, { manifestDigest: f.two.manifestDigest, version: '1.1.0', lockSha256, at: undefined });
  assert.equal(anchor.evidence.manifestDigest, f.one.manifestDigest, 'the evidence anchor stays');
  // That exact lock passes the drift check and adopt status with the state (as unauthenticated by itself: the warning stays).
  const check = adoptionCheck(f.root, { anchor }); assert.deepEqual(check.reasons, []); assert.equal(check.warnings.length, 1);
  const shown = adoptStatus(f.root, '--state', f.stateDir); assert.equal(shown.code, 0, shown.err);
  // Any other lock in that shape is not: one more managed file substituted with its hash.
  substitute(f.root); git(f.root, ['commit', '-qam', 'Substitute']);
  assert.match(adoptionCheck(f.root, { anchor }).reasons[0] ?? '', DOWNGRADE);
});

test('a project that never had evidence keeps the transition behaviour, with and without its state', t => {
  const f = fixture(t, { legacy: true });
  const shown = adoptStatus(f.root, '--state', f.stateDir); assert.equal(shown.code, 0, shown.err);
  assert.match(shown.err, /^warning: factotum\.lock\.json \(release 1\.0\.0\) is a root lock written before dev\.87, without layout evidence: .*\n$/); assert.doesNotMatch(shown.err, /pass --state/);
  assert.equal(f.store.meta('adoptionAnchor', null), null);
  // A state of another project is refused rather than read.
  const other = sandbox(t), wrong = adoptStatus(f.root, '--state', other.stateDir); assert.notEqual(wrong.code, 0); assert.match(wrong.err, /the project root does not match this state directory/);
});
