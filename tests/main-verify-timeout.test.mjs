import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { setTargetHealth, targetHealth } from '../starter/factory/operations/targets.mjs';
import { auditProviderTimeoutMs, maintenanceTimeoutMs, TARGET_SYNC_TIMEOUT_MS, MAIN_VERIFY_OVERHEAD_MS, MAIN_VERIFY_RESERVE_MS } from '../starter/factory/operations/effect-timeouts.mjs';
import { operationalTick, runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';
import { ensureMainVerification, probeTargetHead, verificationRequest } from '../starter/factory/operations/main-freshness.mjs';
import { mainHealthReason } from '../starter/factory/operations/main-health-reason.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { releaseWorkflow, runIntegrationAction, validateIntegrationConfig } from '../starter/factory/workflows/integrations.mjs';
import { runCheckProcess } from '../starter/factory/operations/check-process.mjs';

// dev.85: a post-merge main.verify was killed at the ten-minute default although its check allowed
// 30 minutes, and the flow stopped as an uncertain attempt. Checks here are real subprocesses; the
// slow ones sleep. No provider or forge is called.
const providers = { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } };
const node = (script, extra = {}) => ({ argv: [process.execPath, '-e', script], timeoutMs: 60000, ...extra });
const quick = (id, extra = {}) => ({ id, ...node('process.exit(0)'), ...extra });
// Prints a line on each stream (one with a credential-shaped value), then sleeps far past any limit here.
const sleeper = (id, timeoutMs, extra = {}) => ({ id, ...node("console.log('waiting for the machine lock'); console.error('lock held by another job; token ghp_' + 'fictional0123456789abcdefghij'); setTimeout(() => {}, 600000)", { timeoutMs }), ...extra });
const baseConfig = mainChecks => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/timeouts', account: 'fictional', target: 'main', remote: 'origin' }, providers, mainChecks, checks: [{ id: 'acceptance', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { planning: false, autoQueue: true, maxFlows: 1 } });

function fixture(t, mainChecks, configure = config => config) {
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  const config = validateConfig(configure(baseConfig(mainChecks)));
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  const head = repositoryIdentity(f.root).head;
  setTargetHealth(f.store, null, { status: 'green', head, checkedAt: new Date().toISOString() });
  return { ...f, config, head };
}
const enqueue = (f, operation = 'main.verify', payload = {}) => { const result = f.command('job.enqueue', { operation, payload, note: 'Fictional verification' }); assert.equal(result.status, 'completed', result.error); return result.result; };
const receipt = (attempt, actionResult) => ({ version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult });
// Admit the job through the operations loop and prepare its attempt; return the flow and attempt.
async function admit(f, jobId) {
  await operationalTick(f.store);
  const job = f.store.need('job', jobId); assert.equal(job.status, 'running', job.reason ?? job.status);
  await f.engine.step(job.flowId);
  const flow = f.store.need('flow', job.flowId);
  return { job, flow, attempt: f.store.need('attempt', flow.attemptId) };
}

test('a main.verify step allows the sum of its main checks\' timeoutMs plus set-up, for the tier it runs', async t => {
  const checks = [quick('unit', { timeoutMs: 600000 }), quick('slow', { timeoutMs: 1800000 }), quick('nightly', { timeoutMs: 900000, tier: 'scheduled' })];
  const f = fixture(t, checks);
  // The reported case: the check allows 30 minutes, the step was given the ten-minute default.
  const { flow } = await admit(f, enqueue(f).id);
  assert.equal(flow.workflow.nodes.run.timeoutMs, 600000 + 1800000 + 900000 + MAIN_VERIFY_OVERHEAD_MS);
  assert.equal(flow.workflow.nodes.run.heavy, true);
  // A post-merge verification runs the merge tier only, and is sized for it.
  assert.equal(maintenanceTimeoutMs(f.config, 'main.verify', { tier: 'merge' }), 600000 + 1800000 + MAIN_VERIFY_OVERHEAD_MS);
  // A registered flake retry may run the check again, so it counts while the registration is current.
  const flaky = { ...f.config, mainChecks: [quick('unit', { timeoutMs: 600000, retrySafe: true, flakePolicy: { retries: 2, trackingRef: 'fictional#1', expiresAt: new Date(Date.now() + 86400000).toISOString(), exitCodes: [1] } })] };
  assert.equal(maintenanceTimeoutMs(flaky, 'main.verify', {}), 3 * 600000 + MAIN_VERIFY_OVERHEAD_MS);
  // An explicit timeouts["main.verify"] still wins.
  assert.equal(maintenanceTimeoutMs({ ...f.config, timeouts: { 'main.verify': 1234567 } }, 'main.verify', {}), 1234567);
});

test('commissioning refuses main checks that cannot fit in one main.verify step, and maintenance limits outside one hour', () => {
  const fits = [quick('unit', { timeoutMs: 600000 }), quick('full-suite', { timeoutMs: 3_600_000 - MAIN_VERIFY_OVERHEAD_MS - 600000, tier: 'scheduled' })];
  assert.doesNotThrow(() => validateConfig(baseConfig(fits)));
  const tooLong = [quick('unit', { timeoutMs: 600000 }), quick('full-suite', { timeoutMs: 2_900_000, tier: 'scheduled' })];
  assert.throws(() => validateConfig(baseConfig(tooLong)), /mainChecks cannot fit in one main\.verify step: a full verification runs every check \(every tier\) one after another in one step, and these may take 58\.3 min \(the sum of their timeoutMs\), plus 3 min for set-up, which is more than the one-hour limit on a step \(3600000 ms\)\. To fix it, lower the checks' timeoutMs so that they add up to at most 57 min .*or move a slow suite out of mainChecks into a scheduled task .*Moving a check to the scheduled tier \("tier": "scheduled"\) or splitting it into several checks does not help/);
  // Setup commands are not counted against the ceiling: their limit (30 minutes each by default) is rarely what they take.
  assert.doesNotThrow(() => validateConfig({ ...baseConfig(fits), workspace: { setup: [['npm', 'ci']], setupTimeoutMs: 1_800_000 } }));
  // Counting registered flake retries.
  const retried = [quick('unit', { timeoutMs: 1_200_000, retrySafe: true, flakePolicy: { retries: 2, trackingRef: 'fictional#2', expiresAt: new Date(Date.now() + 86400000).toISOString(), exitCodes: [1] } })];
  assert.throws(() => validateConfig(baseConfig(retried)), /counting registered flake retries/);
  assert.throws(() => validateConfig({ ...baseConfig(fits), timeouts: { 'main.verify': 3_600_001 } }), /timeouts\["main\.verify"\] must be a whole number of milliseconds from 1 to 3600000/);
  assert.throws(() => validateConfig({ ...baseConfig(fits), timeouts: { 'target.sync': '10m' } }), /timeouts\["target\.sync"\]/);
});

test('target.sync, audit and retention steps take their limits from their own bounds', async t => {
  // Admitted through the operations loop: the step's limit is the operation's own bound, not the ten-minute default.
  const sync = fixture(t, [quick('unit')], config => ({ ...config, repository: { ...config.repository, syncTargets: [{ from: 'main', into: 'next' }] }, workflows: { definitions: { change: { reference: 'change.standard' }, web: { reference: 'change.standard', target: 'next' } }, selection: { default: 'change' } } }));
  assert.equal((await admit(sync, enqueue(sync, 'target.sync', { from: 'main', into: 'next' }).id)).flow.workflow.nodes.run.timeoutMs, TARGET_SYNC_TIMEOUT_MS);
  const audit = fixture(t, [quick('unit')]), auditJob = enqueue(audit, 'audit');
  await operationalTick(audit.store);
  assert.equal(audit.store.need('flow', audit.store.need('job', auditJob.id).flowId).workflow.nodes.run.timeoutMs, 600000 + 180000);
  const config = validateConfig(baseConfig([quick('unit')]));
  // target.sync: its bounded Git calls (each at most 60 s, the fetch repeated on lock contention).
  assert.equal(maintenanceTimeoutMs(config, 'target.sync', { from: 'main', into: 'next' }), TARGET_SYNC_TIMEOUT_MS);
  assert.ok(TARGET_SYNC_TIMEOUT_MS > 600000 && TARGET_SYNC_TIMEOUT_MS <= 3_600_000);
  // audit: timeouts.audit bounds the model call; the step adds its own set-up instead of sharing the same number.
  assert.equal(maintenanceTimeoutMs(config, 'audit'), 600000 + 180000);
  assert.equal(maintenanceTimeoutMs({ ...config, timeouts: { audit: 3_600_000 } }, 'audit'), 3_600_000);
  const deadlineAt = Date.now() + 3_600_000;
  assert.ok(auditProviderTimeoutMs({ ...config, timeouts: { audit: 3_600_000 } }, deadlineAt) <= 3_600_000 - 60000);
  assert.equal(auditProviderTimeoutMs(config, undefined), 600000);
  // retention.archive: its preservation discovery command's own limit plus room for the archive.
  assert.equal(maintenanceTimeoutMs({ ...config, retention: { preservation: { timeoutMs: 900000 } } }, 'retention.archive'), 1_200_000);
  assert.equal(maintenanceTimeoutMs(config, 'retention.archive'), 600000);
  for (const operation of ['maintenance.backup', 'retrospective', 'machine.sample', 'source.sync']) assert.equal(maintenanceTimeoutMs(config, operation), 600000);
});

test('a main check that times out fails the verification with its name and limit: red target, failed job, a notice, no uncertain attempt', async t => {
  const f = fixture(t, [quick('unit'), sleeper('machine-lock', 1500), quick('after')]);
  const { job, flow, attempt } = await admit(f, enqueue(f).id);
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } });
  assert.equal(outcome.route, 'fail');
  assert.equal(outcome.timedOut, true);
  assert.deepEqual(outcome.timeout, { checkId: 'machine-lock', timeoutMs: 1500, limit: 'check', stepTimeoutMs: attempt.intent.timeoutMs });
  const row = outcome.mainHealth.checks.find(check => check.id === 'machine-lock');
  assert.equal(row.status, 'failed'); assert.equal(row.failureClass, 'timeout'); assert.equal(row.timedOut, true); assert.equal(row.timeoutMs, 1500); assert.equal(row.attempts, 1);
  // The other checks still ran under their own limits.
  assert.deepEqual(outcome.mainHealth.checks.map(check => [check.id, check.status]), [['unit', 'passed'], ['machine-lock', 'failed'], ['after', 'passed']]);
  assert.match(outcome.notice, /^Main check machine-lock timed out after 1\.5 s \(its timeoutMs\) and was stopped\. Main verification of main at [0-9a-f]{12} failed; its health is red until a verification passes\./);
  assert.match(outcome.notice, /stderr \(last lines\):\nlock held by another job; token \[redacted\]/);
  assert.match(outcome.notice, /stdout \(last lines\):\nwaiting for the machine lock/);
  assert.doesNotMatch(outcome.notice, /ghp_fictional/);
  const evidence = JSON.parse(readFileSync(join(attempt.intent.action.artifactDir, row.artifact), 'utf8'));
  assert.equal(evidence.timedOut, true); assert.equal(evidence.limitSource, 'check'); assert.match(evidence.stdout, /waiting for the machine lock/);

  f.engine.settle(flow.id, attempt, receipt(attempt, outcome));
  await f.engine.step(flow.id);
  const settled = f.store.need('attempt', attempt.id), finished = f.store.need('flow', flow.id);
  assert.equal(settled.status, 'passed'); assert.equal(settled.outcome, 'failed');
  assert.deepEqual(settled.failedChecks, [{ id: 'machine-lock', status: 'failed', failureClass: 'timeout' }]);
  assert.equal(finished.state, 'failed'); assert.equal(finished.stopReason ?? null, null);
  assert.ok(!f.store.all('attempt').some(row => row.status === 'uncertain'));
  assert.equal(targetHealth(f.store, null).status, 'red');
  const settledJob = f.store.need('job', job.id);
  assert.equal(settledJob.status, 'failed'); assert.match(settledJob.reason, /Main check machine-lock timed out after 1\.5 s/);
  // The failed flow's notice (R5/G19 path) carries the check, its limit and the redacted excerpt.
  const notice = JSON.stringify(f.store.all('inbox').filter(row => row.flowId === flow.id));
  assert.match(notice, new RegExp(`Failed at run \\(attempt ${attempt.id}\\): Main check machine-lock timed out after 1\\.5 s`));
  assert.match(notice, /token \[redacted\]/); assert.doesNotMatch(notice, /ghp_fictional/);
});

test('a check cut short by the step\'s time left fails with its name; checks after it are not run', async t => {
  const f = fixture(t, [sleeper('slow', 8000), quick('later')]);
  const { attempt } = await admit(f, enqueue(f).id);
  // The step has ~2.5 s left for checks once its closing reserve is kept back.
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } }, { deadlineAt: Date.now() + MAIN_VERIFY_RESERVE_MS + 2500 });
  assert.equal(outcome.route, 'fail'); assert.equal(outcome.mainHealth.status, 'red');
  assert.equal(outcome.timeout.checkId, 'slow'); assert.equal(outcome.timeout.limit, 'verification'); assert.ok(outcome.timeout.timeoutMs < 2500);
  assert.deepEqual(outcome.timeout.notRun, ['later']);
  assert.deepEqual(outcome.mainHealth.checks.map(check => check.id), ['slow']);
  assert.match(outcome.notice, /Main check slow was stopped after [\d.]+ s, before its own timeoutMs of 8 s, because the main\.verify step's time was nearly used up \(this main\.verify step may run [\d.]+ min; timeouts\["main\.verify"\] overrides it\)\. Main check later did not run: the main\.verify step's time was used up\./);
});

test('an integration adapter\'s own timeoutMs sizes its step and bounds the adapter, after any permit wait', async t => {
  const adapters = { probe: { argv: ['probe'], effect: 'read', schema: { type: 'object' }, timeoutMs: 1_800_000 } };
  const workflow = releaseWorkflow({ rehearsal: 'probe', probeBefore: 'probe', deploy: 'probe', probeAfter: 'probe', smoke: 'probe', judge: 'probe', publish: 'probe', adapters });
  assert.equal(workflow.nodes.rehearse.timeoutMs, 1_800_000 + 90000);
  assert.equal(releaseWorkflow({ rehearsal: 'x', probeBefore: 'x', deploy: 'x', probeAfter: 'x', smoke: 'x', judge: 'x', publish: 'x' }).nodes.rehearse.timeoutMs, 600000);
  const short = { version: 1, start: 'check', nodes: { check: { kind: 'effect', action: { operation: 'integration.run', adapter: 'probe' }, timeoutMs: 600000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  assert.throws(() => validateIntegrationConfig({ integrationAdapters: adapters, integrationWorkflows: { probe: { kind: 'maintenance', workflow: short } } }), /integration workflow probe runs adapter probe \(timeoutMs 1800000\) in a step that allows only 600000 ms; give the step timeoutMs of at least 1890000/);
  // The adapter's run limit: its own timeoutMs, cut to the step's time left.
  const f = sandbox(t), seen = [];
  const run = async (binary, args, options) => { seen.push(options.timeoutMs); return { code: 0, stdout: JSON.stringify({ route: 'pass' }), stderr: '' }; };
  const config = { integrationAdapters: { probe: { argv: ['probe'], effect: 'read', schema: { type: 'object' }, timeoutMs: 1000 } } };
  const intent = { cwd: f.root, timeoutMs: 600000, attemptId: 'attempt-1', action: { config, node: { adapter: 'probe', stage: 'probe' }, step: 'probe', projectId: 'p', flowId: 'flow-1', artifactDir: f.base, integration: { id: 'probe', payload: { candidate: { head: 'a'.repeat(40) } } }, results: {} } };
  await runIntegrationAction(intent, { run });
  await runIntegrationAction({ ...intent, action: { ...intent.action, config: { integrationAdapters: { probe: { ...config.integrationAdapters.probe, timeoutMs: undefined } } } } }, { run, deadlineAt: Date.now() + 3000 });
  assert.equal(seen[0], 1000);
  assert.ok(seen[1] <= 2000, `adapter limit ${seen[1]} ms should fit in the 3 s left`);
});

// ---- Review round (dev.85): setup in the bound, a check whose child holds its output, one retry after a timeout.

test('the main.verify step limit includes workspace setup at workspace.setupTimeoutMs', () => {
  const config = validateConfig({ ...baseConfig([quick('unit', { timeoutMs: 600000 })]), workspace: { setup: [['npm', 'ci'], ['npm', 'run', 'build']], setupTimeoutMs: 300000 } });
  assert.equal(maintenanceTimeoutMs(config, 'main.verify', {}), 600000 + 2 * 300000 + MAIN_VERIFY_OVERHEAD_MS);
  // The default setup limit (30 minutes per command) counts too, within the one-hour cap.
  const defaults = validateConfig({ ...baseConfig([quick('unit', { timeoutMs: 600000 })]), workspace: { setup: [['npm', 'ci']] } });
  assert.equal(maintenanceTimeoutMs(defaults, 'main.verify', {}), 600000 + 1_800_000 + MAIN_VERIFY_OVERHEAD_MS);
});

test('workspace setup in a main.verify is cut to the step\'s time left, so a hanging setup ends before the step does', async t => {
  const f = fixture(t, [quick('unit')], config => ({ ...config, workspace: { setup: [[process.execPath, '-e', 'setTimeout(() => {}, 600000)']], setupTimeoutMs: 8000 } }));
  const { attempt } = await admit(f, enqueue(f).id);
  const started = Date.now();
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } }, { deadlineAt: Date.now() + MAIN_VERIFY_RESERVE_MS + 1000 + 2000 });
  assert.ok(Date.now() - started < 6000, `setup should stop within the step's ~2 s left, took ${Date.now() - started} ms`);
  assert.equal(outcome.route, 'blocked'); assert.equal(outcome.mainHealth.status, 'unknown');
  assert.match(outcome.mainHealth.reason, /workspace setup timed out after 2 s/);
});

// A check that starts a process holding its stdout open, then exits: `kind` 'group' stays in the
// check's process group, 'escaped' starts its own session (setsid), out of the runner's reach.
// Its timeout is far above the bound the tests assert (half of it), so finishing within the bound
// proves the verifier did not wait for the timeout however slowly the host starts Node. The 2 s exit
// grace itself is proven by the recorded evidence.
const HOLDER_TIMEOUT_MS = 60000, HOLDER_BOUND_MS = HOLDER_TIMEOUT_MS / 2;
const holder = (id, kind, pidFile) => ({ id, ...node(`const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: ${kind === 'escaped'} }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); console.log('started a helper'); process.exit(0);`, { timeoutMs: HOLDER_TIMEOUT_MS }) });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('a check whose own process exited is not kept waiting by a child holding its output: the child is stopped and the check is named', async t => {
  const f = fixture(t, [quick('unit')]), pidFile = join(f.base, 'helper.pid');
  f.config.mainChecks[0] = holder('server', 'group', pidFile);
  const { attempt } = await admit(f, enqueue(f).id);
  const started = Date.now();
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, config: f.config, resource: false } });
  const elapsed = Date.now() - started, pid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert.ok(elapsed < HOLDER_BOUND_MS, `the verifier should stop waiting about 2 s after the check exited, not at its ${HOLDER_TIMEOUT_MS} ms timeout; took ${elapsed} ms`);
  // It finished; a process it left behind is a containment problem (unknown health), not a timeout (red).
  assert.equal(outcome.route, 'blocked'); assert.equal(outcome.timedOut, undefined);
  const evidence = JSON.parse(readFileSync(join(attempt.intent.action.artifactDir, outcome.mainHealth.checks[0].artifact), 'utf8'));
  assert.equal(evidence.code, 'DESCENDANTS_SURVIVE'); assert.match(evidence.error, /exited with code 0, but a process it started still held its output open 2 s later; it was stopped/);
  assert.match(evidence.stdout, /started a helper/);
  const end = Date.now() + 3000; while (alive(pid) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(pid), false, 'the helper in the check\'s process group is stopped');
});

test('a helper that left the check\'s process group cannot be stopped, but the verifier still stops waiting for it', async t => {
  const f = fixture(t, [quick('unit')]), pidFile = join(f.base, 'escaped.pid');
  f.config.mainChecks[0] = holder('daemon', 'escaped', pidFile);
  const { attempt } = await admit(f, enqueue(f).id);
  const started = Date.now();
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, config: f.config, resource: false } });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  // This test started it, so this test stops it (by its recorded PID).
  t.after(() => { if (alive(pid)) process.kill(pid, 'SIGKILL'); });
  assert.ok(Date.now() - started < HOLDER_BOUND_MS, `the verifier should not wait for the escaped helper or the check's ${HOLDER_TIMEOUT_MS} ms timeout; took ${Date.now() - started} ms`);
  assert.equal(outcome.route, 'blocked');
  assert.equal(alive(pid), true, 'a process in another session is out of reach (documented known limit)');
});

// A check that sleeps past its limit while `flag` exists, and passes otherwise.
const lockWait = (id, flag, extra = {}) => ({ id, ...node(`if (require('node:fs').existsSync(${JSON.stringify(flag)})) { console.error('waiting for the machine lock'); setTimeout(() => {}, 600000); }`, { timeoutMs: 1500 }), ...extra });
async function verify(f, jobId) {
  const { flow, attempt } = await admit(f, jobId);
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } });
  f.engine.settle(flow.id, attempt, receipt(attempt, outcome)); await f.engine.step(flow.id);
  return outcome;
}
const later = 16 * 60000;

test('a verification that failed only on a timeout is verified once more automatically, shown as pending, then clears when it passes', async t => {
  const flag = join(tmpFlag(t), 'held'), f = fixture(t, [quick('unit'), lockWait('locked', flag)]);
  writeFileSync(flag, '');
  const first = await verify(f, enqueue(f).id);
  assert.equal(first.route, 'fail'); assert.equal(first.mainHealth.timeoutOnly, true);
  assert.match(first.notice, /It is verified once more automatically after the back-off that follows a failed verification\./);
  const health = targetHealth(f.store, null);
  assert.equal(health.status, 'red'); assert.equal(health.timeoutOnly, true); assert.equal(health.timeout.checkId, 'locked');
  // Pending: queue status and target health say when.
  const hold = queueStatus(f.store).holds.find(row => row.kind === 'main');
  assert.equal(hold.timeoutRetry.status, 'pending'); assert.equal(hold.timeoutRetry.due, false); assert.equal(hold.timeoutRetry.check, 'locked');
  assert.match(hold.text, /main health is red: main check locked timed out; one automatic re-verification is requested after \d{4}-\d\d-\d\dT/);
  assert.match(mainHealthReason(f.store), /one automatic re-verification is requested after/);
  // Not before the back-off, then once, with no queued work needed.
  assert.equal(f.store.tx(() => ensureMainVerification(f.store)), null);
  const jobId = f.store.tx(() => ensureMainVerification(f.store, { nowMs: Date.now() + later }));
  assert.equal(jobId, `main-timeout-retry:${health.checkedAt}`);
  const job = f.store.need('job', jobId);
  assert.deepEqual(job.payload, { timeoutRetry: true }); assert.match(job.grant.note, /single re-verification of main after its verification failed only because main checks ran out of time/);
  const recorded = f.store.events(20).find(event => event.type === 'main.verify-timeout-retry');
  assert.equal(recorded.payload.jobId, jobId); assert.equal(recorded.payload.check, 'locked'); assert.equal(recorded.payload.failedAt, health.checkedAt);
  assert.equal(queueStatus(f.store).holds.find(row => row.kind === 'main').timeoutRetry.status, 'requested');
  assert.equal(f.store.tx(() => ensureMainVerification(f.store, { nowMs: Date.now() + later })), null, 'requested once');
  // The lock is gone: the retry passes and the target is green.
  rmSync(flag);
  const second = await verify(f, jobId);
  assert.equal(second.route, 'pass'); assert.equal(targetHealth(f.store, null).status, 'green');
});

test('after the one retry times out too, or when a check really failed, the target stays red until the operator acts', async t => {
  const dir = tmpFlag(t), flag = join(dir, 'held');
  const f = fixture(t, [quick('unit'), lockWait('locked', flag)]);
  writeFileSync(flag, '');
  await verify(f, enqueue(f).id);
  const jobId = f.store.tx(() => ensureMainVerification(f.store, { nowMs: Date.now() + later }));
  const retried = await verify(f, jobId);
  assert.equal(retried.route, 'fail'); assert.equal(retried.mainHealth.timeoutRetry, true);
  assert.match(retried.notice, /This was its one automatic re-verification after an earlier timeout, so it is not verified again automatically: fix the cause/);
  const health = targetHealth(f.store, null);
  assert.equal(health.timeoutRetry, true);
  assert.equal(queueStatus(f.store).holds.find(row => row.kind === 'main').timeoutRetry.status, 'used');
  assert.match(mainHealthReason(f.store), /main check locked timed out again on its one automatic re-verification, so it is not verified again automatically; fix the cause \(for example a lock or a slow host\), then run main\.verify for main/);
  assert.equal(f.store.tx(() => ensureMainVerification(f.store, { nowMs: Date.now() + 2 * later })), null);
  assert.match(f.store.tx(() => verificationRequest(f.store, 'main', { nowMs: Date.now() + 2 * later })).refused, /main is red \(its last verification failed, and timed out again on its one automatic re-verification of [0-9a-f]{12}\)/);

  // A real failure beside a timeout gets no automatic retry.
  const g = fixture(t, [{ id: 'broken', ...node('process.exit(1)') }, lockWait('locked', flag)]);
  const mixed = await verify(g, enqueue(g).id);
  assert.equal(mixed.route, 'fail'); assert.equal(mixed.mainHealth.timeoutOnly, undefined);
  assert.equal(queueStatus(g.store).holds.find(row => row.kind === 'main').timeoutRetry, undefined);
  assert.equal(g.store.tx(() => ensureMainVerification(g.store, { nowMs: Date.now() + later })), null);
  assert.match(g.store.tx(() => verificationRequest(g.store, 'main', { nowMs: Date.now() + later })).refused, /^main is red \(its last verification failed\)$/);
});
function tmpFlag(t) { const dir = mkdtempSync(join(tmpdir(), 'fct-lock-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

// ---- Review fixes (dev.85, second review).

const groupOf = pid => { try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return Number(text.slice(text.lastIndexOf(')') + 2).split(' ')[2]); } catch { return null; } };
const running = pid => { try { const text = readFileSync(`/proc/${pid}/stat`, 'utf8'); return !['Z', 'X'].includes(text.slice(text.lastIndexOf(')') + 2)[0]); } catch { return false; } };
// A check that starts `helper` (argv) with ignored stdio, waits until it has written its PID, then sleeps past its limit.
const helperCheck = (pidFile, helper) => [process.execPath, '-e', `const { spawn } = require('node:child_process'), fs = require('node:fs'); spawn(${JSON.stringify(helper[0])}, ${JSON.stringify(helper.slice(1))}, { stdio: 'ignore' }); const end = Date.now() + 5000; while (!fs.existsSync(${JSON.stringify(pidFile)}) && Date.now() < end) {} setTimeout(() => {}, 600000);`];

test('a timed-out check\'s helper that ignores SIGTERM is killed before the result is settled', async t => {
  const dir = tmpFlag(t), pidFile = join(dir, 'stubborn.pid');
  const stubborn = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`];
  const error = await runCheckProcess(helperCheck(pidFile, stubborn)[0], helperCheck(pidFile, stubborn).slice(1), { cwd: dir, env: process.env, timeoutMs: 1500 }).then(() => null, error => error);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => { if (running(pid)) process.kill(pid, 'SIGKILL'); });
  assert.equal(error?.code, 'TIMEOUT');
  // Settled only after the group is empty: the helper is already gone, with no wait here.
  assert.equal(running(pid), false, 'the SIGTERM-ignoring helper must not outlive the settled result');
  assert.equal(error.escaped, undefined);
});

// A Node process cannot leave its own process group (no setsid or setpgid), and a grandchild started
// in a new session was never a member, so it would not test what this does: skip without python3.
const python = spawnSync('python3', ['-c', 'import os; os.setsid'], { stdio: 'ignore' }).status === 0;
test('a helper that leaves the check\'s process group while being stopped is not signalled again, and is reported as escaped', { skip: python ? false : 'python3 is not on PATH: the helper must call setsid() on itself while being stopped, which a Node process cannot do' }, async t => {
  const dir = tmpFlag(t), pidFile = join(dir, 'escaper.pid');
  // On SIGTERM it starts its own session (leaves the group), then keeps running.
  const escaper = ['python3', '-c', `import os, signal, time\nopen(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))\nsignal.signal(signal.SIGTERM, lambda *a: os.setsid())\nwhile True: time.sleep(0.05)`];
  const argv = helperCheck(pidFile, escaper);
  const error = await runCheckProcess(argv[0], argv.slice(1), { cwd: dir, env: process.env, timeoutMs: 1500 }).then(() => null, error => error);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  t.after(() => { if (running(pid)) process.kill(pid, 'SIGKILL'); });
  assert.equal(error?.code, 'TIMEOUT');
  assert.equal(running(pid), true, 'a process outside the check\'s group must not be signalled');
  assert.notEqual(groupOf(pid), null);
  assert.deepEqual(error.escaped.map(row => row.pid), [pid]);
  assert.match(error.message, new RegExp(`1 process\\(es\\) it started left its process group and were not stopped \\(PID ${pid}\\)`));

  // In a verification, a timeout that left a process behind is not contained: unknown, not red.
  const f = fixture(t, [quick('unit')]), escaped = join(dir, 'escaper2.pid');
  f.config.mainChecks[0] = { id: 'escaping', argv: helperCheck(escaped, ['python3', '-c', `import os, signal, time\nopen(${JSON.stringify(escaped)}, 'w').write(str(os.getpid()))\nsignal.signal(signal.SIGTERM, lambda *a: os.setsid())\nwhile True: time.sleep(0.05)`]), timeoutMs: 1500 };
  const { attempt } = await admit(f, enqueue(f).id);
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, config: f.config, resource: false } });
  const second = Number(readFileSync(escaped, 'utf8'));
  t.after(() => { if (running(second)) process.kill(second, 'SIGKILL'); });
  assert.equal(outcome.route, 'blocked'); assert.equal(outcome.mainHealth.status, 'unknown'); assert.equal(outcome.timedOut, undefined);
  const evidence = JSON.parse(readFileSync(join(attempt.intent.action.artifactDir, outcome.mainHealth.checks[0].artifact), 'utf8'));
  assert.equal(evidence.code, 'TIMEOUT'); assert.deepEqual(evidence.escaped.map(row => row.pid), [second]);
});

test('one automatic timeout retry per head, whatever the health age: expired red health starts no further automatic run until the head changes or the operator verifies', async t => {
  const f = fixture(t, [quick('unit')]), head = f.head, hour = 61 * 60000;
  assert.equal(f.command('task.put', { task: { id: 'other', title: 'Another fictional change', acceptance: ['Fictional behavior'] } }).status, 'completed');
  const other = f.store.need('task', 'other');
  assert.equal(f.command('task.approve', { taskId: other.id, revision: other.revision }).status, 'completed');
  assert.equal(f.command('queue.put', { taskIds: ['other'] }).status, 'completed');
  const old = new Date(Date.now() - hour).toISOString();
  // The reviewer's repro: the retry already ran on this head and timed out again, 61 minutes ago.
  f.store.tx(() => {
    f.store.put('job', { id: `main-timeout-retry:${new Date(Date.now() - hour - 20 * 60000).toISOString()}`, operation: 'main.verify', payload: { timeoutRetry: true }, grant: { actor: 'operator', source: 'configuration', policy: 'autoQueue', note: 'retry' }, status: 'failed', createdAt: new Date(Date.now() - hour - 60000).toISOString(), finishedAt: old, timeoutRetryHead: head });
    setTargetHealth(f.store, null, { status: 'red', head, checkedAt: old, timeoutOnly: true, timeoutRetry: true, timedOut: true, timeout: { checkId: 'locked' } });
  });
  assert.equal(f.store.tx(() => ensureMainVerification(f.store)), null);
  assert.deepEqual(f.store.live('job').filter(job => job.id.startsWith('main-refresh:')).map(job => job.id), [], 'no ordinary refresh of the expired red health either');
  // A later automatic run of the same head that timed out (without the retry marker) earns no second retry.
  f.store.tx(() => setTargetHealth(f.store, null, { status: 'red', head, checkedAt: old, timeoutOnly: true, timedOut: true, timeout: { checkId: 'locked' } }));
  assert.equal(f.store.tx(() => ensureMainVerification(f.store)), null);
  assert.equal(queueStatus(f.store).holds.find(row => row.kind === 'main').timeoutRetry.status, 'used');
  // The operator verifies: the allowance is renewed for that head.
  enqueue(f); f.store.tx(() => { for (const job of f.store.live('job').filter(row => row.status === 'queued')) { job.status = 'failed'; job.finishedAt = old; f.store.put('job', job); } });
  assert.equal(queueStatus(f.store).holds.find(row => row.kind === 'main').timeoutRetry.status, 'pending');
  // A new head renews it too.
  f.store.tx(() => setTargetHealth(f.store, null, { status: 'red', head: 'b'.repeat(40), checkedAt: old, timeoutOnly: true, timedOut: true, timeout: { checkId: 'locked' } }));
  const renewed = f.store.tx(() => ensureMainVerification(f.store));
  assert.match(renewed, /^main-timeout-retry:/); assert.equal(f.store.need('job', renewed).timeoutRetryHead, 'b'.repeat(40));
});

test('a passing check with a sub-second timeoutMs runs', async t => {
  // `true` starts at once, so the 500 ms limit cannot be met by start-up time on a loaded host.
  const f = fixture(t, [{ id: 'short', argv: ['true'], timeoutMs: 500 }, quick('unit')]);
  const { attempt } = await admit(f, enqueue(f).id);
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } }, { deadlineAt: Date.now() + 180500 });
  assert.equal(outcome.route, 'pass'); assert.equal(outcome.timeout, undefined);
  assert.deepEqual(outcome.mainHealth.checks.map(check => [check.id, check.status]), [['short', 'passed'], ['unit', 'passed']]);
});

// ---- Review fixes, round 2 (dev.85).

test('an exhausted timeout retry is still probed: a fix pushed outside the factory records the new head and gets a verification; the same head does not', async t => {
  const f = fixture(t, [quick('unit')]), head = f.head, moved = 'c'.repeat(40), twoHours = 2 * 3600000, old = new Date(Date.now() - twoHours).toISOString();
  assert.equal(f.command('task.put', { task: { id: 'other', title: 'Another fictional change', acceptance: ['Fictional behavior'] } }).status, 'completed');
  const other = f.store.need('task', 'other');
  assert.equal(f.command('task.approve', { taskId: other.id, revision: other.revision }).status, 'completed');
  assert.equal(f.command('queue.put', { taskIds: ['other'] }).status, 'completed');
  // The reviewer's repro: timeout-only red health, two hours old, whose one retry for this head is used.
  f.store.tx(() => {
    f.store.put('job', { id: `main-timeout-retry:${new Date(Date.now() - twoHours - 20 * 60000).toISOString()}`, operation: 'main.verify', payload: { timeoutRetry: true }, grant: { actor: 'operator', source: 'configuration', policy: 'autoQueue', note: 'retry' }, status: 'failed', createdAt: new Date(Date.now() - twoHours - 60000).toISOString(), finishedAt: old, timeoutRetryHead: head });
    setTargetHealth(f.store, null, { status: 'red', head, checkedAt: old, timeoutOnly: true, timeoutRetry: true, timedOut: true, timeout: { checkId: 'locked' } });
  });
  const reads = [], stub = remote => async (binary, args) => { reads.push([binary, ...args].join(' ')); return { code: 0, stdout: `${remote}\trefs/heads/main\n`, stderr: '' }; };
  // Same head: read once, nothing changes, and the same-head refusal stands.
  await probeTargetHead(f.store, { run: stub(head) });
  assert.deepEqual(reads, ['git ls-remote origin refs/heads/main']);
  assert.equal(targetHealth(f.store, null).status, 'red'); assert.equal(f.store.tx(() => ensureMainVerification(f.store)), null);
  // Within policy.mainProbeMs it is not read again (the existing bounded cadence).
  await probeTargetHead(f.store, { run: stub(moved) });
  assert.equal(reads.length, 1);
  // At the next probe the remote head differs: the new head is recorded and may be verified.
  await probeTargetHead(f.store, { run: stub(moved), nowMs: Date.now() + 61000 });
  assert.equal(reads.length, 2);
  const health = targetHealth(f.store, null);
  assert.equal(health.status, 'unknown'); assert.equal(health.head, moved); assert.equal(health.previousHead, head);
  assert.equal(health.timeoutOnly, undefined);
  assert.ok(f.store.events(10).some(event => event.type === 'main.moved' && event.payload.to === moved));
  const requested = f.store.tx(() => ensureMainVerification(f.store, { nowMs: Date.now() + 61000 }));
  assert.match(requested, /^main-refresh:/);
});
