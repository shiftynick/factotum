import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { atomicJSON, digest } from '../starter/factory/core/contracts.mjs';
import { inspect } from '../starter/factory/core/effects.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { doctor } from '../starter/factory/workflows/commission.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { ensureMainVerification, probeTargetHead } from '../starter/factory/operations/main-freshness.mjs';
import { scheduledTierHold } from '../starter/factory/operations/main-tiers.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { ownerState } from '../starter/factory/operations/resources.mjs';
import { projectStats } from '../starter/factory/operations/stats-view.mjs';
import { setTargetHealth, targetHealth } from '../starter/factory/operations/targets.mjs';
import { operationalTick, runMaintenanceAction, scheduleGrantDigest } from '../starter/factory/workflows/maintenance.mjs';

// Every main check here is a real subprocess. Each appends its id to a log outside the
// repository, and fails while a fail-<id> flag file exists, so tests observe what ran.
const providers = { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } };
function checkKit(base) {
  const log = join(base, 'checks.log'), flag = id => join(base, `fail-${id}`);
  const check = (id, extra = {}) => ({ id, argv: [process.execPath, '-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(`${id}\n`)});process.exit(fs.existsSync(${JSON.stringify(flag(id))})?1:0)`], timeoutMs: 60000, ...extra });
  // Fails its first run with exit 1, then passes: a recovered registered flake.
  const flaky = (id, extra = {}) => { const count = join(base, `count-${id}`); return { id, argv: [process.execPath, '-e', `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(`${id}\n`)});const n=(fs.existsSync(${JSON.stringify(count)})?Number(fs.readFileSync(${JSON.stringify(count)},'utf8')):0)+1;fs.writeFileSync(${JSON.stringify(count)},String(n));process.exit(n===1?1:0)`], timeoutMs: 60000, retrySafe: true, flakePolicy: { retries: 1, exitCodes: [1], trackingRef: 'fictional/flake-tracking', expiresAt: '2099-01-01T00:00:00Z' }, ...extra }; };
  const ran = () => { const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []; rmSync(log, { force: true }); return lines; };
  const fail = (id, on = true) => on ? writeFileSync(flag(id), '') : rmSync(flag(id), { force: true });
  return { check, flaky, ran, fail };
}
const tiered = k => [k.check('unit'), k.check('full-suite', { tier: 'scheduled' })];
const greenHealth = (head, { scheduled = true, at = new Date().toISOString(), scheduledAt = at } = {}) => ({ status: 'green', head, checkedAt: at, ...(scheduled ? { scheduled: { status: 'green', head, checkedAt: scheduledAt, checks: [], failed: [] } } : {}) });

function fixture(t, { mainChecks = tiered, policy = {}, health } = {}) {
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  const kit = checkKit(f.base), identity = repositoryIdentity(f.root);
  const config = validateConfig({ version: 1, mode: 'delivery', repository: { slug: 'fictional/tiers', account: 'fictional', target: 'main', remote: 'origin' }, providers, mainChecks: mainChecks(kit), checks: [{ id: 'acceptance', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { planning: false, autoQueue: true, maxFlows: 1, mainProbeMs: 0, ...policy } });
  const workflow = { version: 1, start: 'merge', nodes: { merge: { kind: 'effect', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config)); f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); f.store.setMeta('commissioning', { ready: true, configDigest: digest(config) });
  setTargetHealth(f.store, null, health ?? greenHealth(identity.head, { scheduled: config.mainChecks.some(c => c.tier === 'scheduled') }));
  const other = f.command('task.put', { task: { id: 'other', title: 'Another fictional change', acceptance: ['Fictional behavior'] } }).result;
  assert.equal(f.command('task.approve', { taskId: other.id, revision: other.revision }).status, 'completed');
  const mainReasons = () => admissionReasons(f.store, f.store.need('task', 'other')).filter(r => /main/.test(r));
  return { ...f, ...kit, git, identity, config, mainReasons };
}
const receipt = (attempt, actionResult) => ({ version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult });
// Merge task-1 through the canonical forge.merge settlement; only the forge boundary is substituted.
async function merge(f) {
  assert.equal(f.command('task.approve', { taskId: f.task.id, revision: f.task.revision }).status, 'completed');
  assert.equal(f.command('flow.start', { taskId: f.task.id, revision: f.task.revision, flowId: 'flow-1' }).status, 'completed');
  const flow = f.store.need('flow', 'flow-1'), identity = repositoryIdentity(f.root); flow.mergeAuthorization = { identity, taskRevision: flow.taskRevision, configDigest: flow.configDigest }; f.store.put('flow', flow);
  await f.engine.step(flow.id); const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId);
  attempt.intent = { ...attempt.intent, action: { operation: 'forge.merge' } };
  f.engine.settle(flow.id, attempt, receipt(attempt, { route: 'merged', merged: true, sha: identity.head, expectedHead: identity.head, expectedBase: identity.head, outputIdentity: identity }));
  await f.engine.step(flow.id);
}
// Admit a queued main.verify job through the operations loop, prepare its attempt, run the real
// verifier (real Git, real check processes) and settle it canonically.
async function runJob(f, jobId, { settled = {} } = {}) {
  await operationalTick(f.store);
  const job = f.store.need('job', jobId); assert.equal(job.status, 'running', job.reason ?? job.status);
  await f.engine.step(job.flowId);
  const flow = f.store.need('flow', job.flowId), attempt = f.store.need('attempt', flow.attemptId);
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } });
  f.engine.settle(flow.id, attempt, { ...receipt(attempt, outcome), ...settled });
  await f.engine.step(flow.id);
  assert.ok(['completed', 'failed'].includes(f.store.need('flow', flow.id).state));
  return outcome;
}
const enqueue = (f, payload = {}) => { const result = f.command('job.enqueue', { operation: 'main.verify', payload, note: 'Fictional verification' }); assert.equal(result.status, 'completed', result.error); return result.result; };

test('merges run only merge-tier checks; a scheduled-tier failure holds admission until a scheduled-tier pass clears it', async t => {
  const f = fixture(t);
  await merge(f);
  const job = f.store.need('job', 'post-merge-main:flow-1');
  assert.deepEqual(job.payload, { tier: 'merge' });
  let out = await runJob(f, job.id);
  assert.deepEqual(f.ran(), ['unit'], 'only the merge tier runs after a merge');
  assert.equal(out.mainHealth.tier, 'merge'); assert.deepEqual(out.mainHealth.tiers, ['merge']); assert.equal(Object.hasOwn(out.mainHealth, 'scheduled'), false);
  assert.equal(f.store.meta('mainHealth').status, 'green'); assert.equal(f.store.meta('mainHealth').scheduled.status, 'green', 'scheduled evidence is carried');
  assert.deepEqual(f.mainReasons(), []);

  f.fail('full-suite');
  out = await runJob(f, enqueue(f).id);
  assert.deepEqual(f.ran(), ['unit', 'full-suite'], 'a manual main.verify runs every tier by default');
  assert.equal(out.route, 'fail'); assert.deepEqual(out.mainHealth.tiers, ['merge', 'scheduled']);
  let health = f.store.meta('mainHealth');
  assert.equal(health.status, 'red'); assert.equal(health.scheduled.status, 'red'); assert.deepEqual(health.scheduled.failed, ['full-suite']);
  assert.equal(health.checks.find(c => c.id === 'full-suite').tier, 'scheduled');
  assert.match(f.mainReasons().join('; '), /main health is red: scheduled-tier check full-suite failed at [a-f\d]{12} .*a merge-tier pass does not clear it/);
  const held = f.command('flow.start', { taskId: 'other', revision: f.store.need('task', 'other').revision }); assert.equal(held.status, 'rejected'); assert.match(held.error, /scheduled-tier check full-suite failed/);

  out = await runJob(f, enqueue(f, { tier: 'merge' }).id);
  assert.deepEqual(f.ran(), ['unit']); assert.equal(out.mainHealth.status, 'green', 'the merge tier itself passed');
  health = f.store.meta('mainHealth');
  assert.equal(health.status, 'red', 'a merge-tier pass does not clear a scheduled-tier red'); assert.equal(health.tierStatus, 'green'); assert.equal(health.scheduled.status, 'red');
  assert.match(f.mainReasons().join('; '), /scheduled-tier check full-suite failed/);
  assert.match(queueStatus(f.store).holds.map(h => h.text).join(' '), /scheduled-tier check full-suite failed/);

  f.fail('full-suite', false);
  out = await runJob(f, enqueue(f).id);
  assert.deepEqual(f.ran(), ['unit', 'full-suite']);
  health = f.store.meta('mainHealth');
  assert.equal(health.status, 'green'); assert.equal(health.scheduled.status, 'green'); assert.equal(health.tierStatus, undefined);
  assert.deepEqual(f.mainReasons(), []);
  const stats = projectStats(f.store).checks.main;
  assert.deepEqual(stats.map(r => [r.tier, r.status, r.targetStatus, r.scheduled]), [['all', 'green', 'green', 'green'], ['merge', 'green', 'red', null], ['all', 'red', 'red', 'red'], ['merge', 'green', 'green', null]], 'a merge-tier pass under a scheduled red is not a green target');
});

test('a configured main.verify schedule runs every tier; schedules and jobs accept only merge or all', async t => {
  const f = fixture(t), createdAt = new Date(Date.now() - 5000).toISOString();
  const schedule = { id: 'nightly-main', enabled: true, type: 'interval', anchorMs: Date.now() - 2000, everyMs: 86400000, operation: 'main.verify', createdAt };
  f.store.put('schedule', { ...schedule, revision: scheduleGrantDigest(schedule) });
  await operationalTick(f.store);
  const jobs = f.store.all('job').filter(j => j.scheduleId === 'nightly-main'); assert.equal(jobs.length, 1); assert.deepEqual(jobs[0].payload, {});
  const flow = f.store.need('flow', jobs[0].flowId); await f.engine.step(flow.id);
  const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId);
  const out = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } });
  f.engine.settle(flow.id, attempt, receipt(attempt, out));
  assert.deepEqual(f.ran(), ['unit', 'full-suite']); assert.equal(out.mainHealth.tier, 'all'); assert.equal(f.store.meta('mainHealth').scheduled.flowId, flow.id);
  assert.equal(f.command('job.enqueue', { operation: 'main.verify', payload: { tier: 'scheduled' }, note: 'x' }).status, 'rejected');
  assert.equal(f.command('schedule.put', { schedule: { id: 'bad', type: 'interval', everyMs: 60000, operation: 'main.verify', payload: { tier: 'nightly' } } }).status, 'rejected');
  assert.equal(f.command('schedule.put', { schedule: { id: 'hourly-light', type: 'interval', everyMs: 3600000, operation: 'main.verify', payload: { tier: 'merge' } } }).status, 'completed');
});

test('scheduled-tier evidence expires on its own lifetime and the loop requests a full verification', async t => {
  const hour = 3600000, f = fixture(t, { policy: { scheduledHealthMaxAgeMs: 2 * hour } });
  setTargetHealth(f.store, null, greenHealth(f.identity.head, { scheduledAt: new Date(Date.now() - 3 * hour).toISOString() }));
  assert.equal(scheduledTierHold(f.config, f.store.meta('mainHealth')).kind, 'stale');
  assert.match(f.mainReasons().join('; '), /main scheduled-tier evidence is stale: last verified .*, older than policy.scheduledHealthMaxAgeMs; a full main verification \(every tier\) is requested automatically/);
  assert.equal(f.command('queue.put', { taskIds: ['other'] }).status, 'completed');
  const id = f.store.tx(() => ensureMainVerification(f.store));
  assert.deepEqual(f.store.need('job', id).payload, { tier: 'all' });
  await runJob(f, id);
  assert.deepEqual(f.ran(), ['unit', 'full-suite']);
  assert.equal(f.store.meta('mainHealth').status, 'green'); assert.deepEqual(f.mainReasons(), []);
  // Never verified: holds too, with its own words.
  setTargetHealth(f.store, null, { ...greenHealth(f.identity.head, { scheduled: false }), scheduled: null });
  assert.equal(f.store.meta('mainHealth').scheduled, undefined);
  assert.match(f.mainReasons().join('; '), /main scheduled-tier checks have not passed yet/);
  // Merge-tier freshness keeps its own one-hour rule even while scheduled evidence is fresh.
  setTargetHealth(f.store, null, greenHealth(f.identity.head, { at: new Date(Date.now() - 2 * hour).toISOString(), scheduledAt: new Date().toISOString() }));
  assert.match(f.mainReasons().join('; '), /main health is stale: .*policy.mainHealthMaxAgeMs/);
  assert.equal(f.command('settings.update', { changes: { 'policy.scheduledHealthMaxAgeMs': 4 * hour }, note: 'Longer full-suite lifetime' }).status, 'completed');
  assert.equal(f.store.meta('config').policy.scheduledHealthMaxAgeMs, 4 * hour);
});

test('a red scheduled tier is verified again automatically only once main has moved', t => {
  const f = fixture(t), OLD = 'a'.repeat(40), NEW = 'b'.repeat(40), at = new Date().toISOString();
  setTargetHealth(f.store, null, { status: 'red', head: OLD, checkedAt: at, tier: 'all', scheduled: { status: 'red', head: OLD, checkedAt: at, checks: [], failed: ['full-suite'] } });
  assert.equal(f.command('queue.put', { taskIds: ['other'] }).status, 'completed');
  assert.equal(f.store.tx(() => ensureMainVerification(f.store)), null, 'same head: fixing main comes first');
  // A merge writes unknown health for the new head; the scheduled red survives it.
  setTargetHealth(f.store, null, { status: 'unknown', head: NEW, checkedAt: at, reason: 'Post-merge baseline verification required' });
  assert.equal(f.store.meta('mainHealth').status, 'red'); assert.equal(f.store.meta('mainHealth').tierStatus, 'unknown');
  const id = f.store.tx(() => ensureMainVerification(f.store));
  assert.deepEqual(f.store.need('job', id).payload, { tier: 'all' });
  // An operator exception speaks for every tier.
  assert.equal(f.command('main.health', { status: 'green', head: NEW, note: 'Known external outage; accepted by the operator' }).status, 'completed');
  assert.equal(f.store.meta('mainHealth').status, 'green'); assert.equal(f.store.meta('mainHealth').scheduled.source, 'operator-exception');
  assert.deepEqual(f.mainReasons(), []);
});

test('legacy main checks without a tier keep today\'s behaviour: every check runs after every merge', async t => {
  const f = fixture(t, { mainChecks: k => [k.check('unit'), k.check('integration')] });
  assert.equal(f.config.mainChecks.some(c => Object.hasOwn(c, 'tier')), false);
  await merge(f);
  const job = f.store.need('job', 'post-merge-main:flow-1'); assert.deepEqual(job.payload, {}, 'payload unchanged');
  const out = await runJob(f, job.id);
  assert.deepEqual(f.ran(), ['unit', 'integration']);
  // The health record keeps exactly its pre-tier shape: no tier, tiers, scheduled or per-check tier.
  const healthKeys = ['checkedAt', 'checks', 'head', 'status', 'unchanged'];
  const rowKeys = ['artifact', 'attempts', 'cacheKey', 'endedAt', 'evidenceDigest', 'evidencePath', 'exitCode', 'flaked', 'id', 'outputDigest', 'passed', 'reused', 'startedAt', 'status', 'verifiedAt'];
  const health = f.store.meta('mainHealth');
  for (const record of [out.mainHealth, health]) { assert.deepEqual(Object.keys(record).sort(), healthKeys); for (const row of record.checks) assert.deepEqual(Object.keys(row).sort(), rowKeys); }
  assert.deepEqual(health, out.mainHealth, 'stored exactly as verified');
  assert.equal(f.store.all('mainCheckObservation').some(o => Object.hasOwn(o, 'tier')), false);
  assert.equal(health.status, 'green'); assert.equal(scheduledTierHold(f.config, health), null);
  assert.equal(f.store.need('flow', f.store.need('job', job.id).flowId).targetHealth, undefined);
  assert.deepEqual(f.mainReasons(), []);
  f.fail('integration');
  const full = await runJob(f, enqueue(f).id);
  assert.deepEqual(Object.keys(full.mainHealth).sort(), healthKeys, 'a full verification of an untiered project adds nothing either');
  assert.deepEqual(f.store.meta('mainHealth'), full.mainHealth);
  assert.equal(f.store.meta('mainHealth').status, 'red'); assert.match(f.mainReasons().join('; '), /^main health is red; fix main or use an explicit recovery task$/);
});

test('main checks reuse exact evidence and register flakes per check in either tier', async t => {
  const f = fixture(t, { mainChecks: k => [k.check('unit'), k.check('full-suite', { tier: 'scheduled', reuseMaxAgeMs: 3600000 }), k.flaky('browser-smoke', { tier: 'scheduled' })] });
  let out = await runJob(f, enqueue(f).id);
  assert.deepEqual(f.ran(), ['unit', 'full-suite', 'browser-smoke', 'browser-smoke']);
  const smoke = out.mainHealth.scheduled.checks.find(c => c.id === 'browser-smoke');
  assert.equal(out.mainHealth.scheduled.status, 'green'); assert.equal(smoke.flaked, true); assert.equal(smoke.tier, 'scheduled'); assert.equal(smoke.attempts, 2);
  const observed = f.store.all('mainCheckObservation').find(o => o.checkId === 'browser-smoke');
  assert.equal(observed.tier, 'scheduled'); assert.equal(observed.flaked, true); assert.equal(observed.trackingRef, 'fictional/flake-tracking');
  // A merge-tier verification leaves the scheduled rows in mainHealth.scheduled ...
  await runJob(f, enqueue(f, { tier: 'merge' }).id);
  assert.deepEqual(f.ran(), ['unit']); assert.equal(f.store.meta('mainHealth').checks.some(c => c.id === 'full-suite'), false);
  // ... so a later full verification on the same head still reuses the scheduled check's clean pass.
  const first = f.store.meta('mainHealth').scheduled.checks.find(c => c.id === 'full-suite');
  out = await runJob(f, enqueue(f).id);
  assert.deepEqual(f.ran(), ['unit', 'browser-smoke'], 'full-suite reused; the recovered flake is never reused');
  const reused = out.mainHealth.scheduled.checks.find(c => c.id === 'full-suite');
  assert.equal(reused.reused, true); assert.equal(reused.verifiedAt, first.verifiedAt); assert.equal(reused.tier, 'scheduled');
  assert.equal(f.store.meta('mainHealth').status, 'green');
});

test('configuration validates tiers, the scheduled lifetime, and keeps a merge-tier check', t => {
  const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/tiers', account: 'fictional', target: 'main' }, providers, checks: [{ id: 'acceptance', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
  const main = (tier, id = 'm') => ({ id, argv: ['true'], timeoutMs: 60000, ...(tier ? { tier } : {}) });
  assert.doesNotThrow(() => validateConfig({ ...base, mainChecks: [main(), main('scheduled', 'full')] }));
  assert.doesNotThrow(() => validateConfig({ ...base, mainChecks: [main('merge')], policy: { scheduledHealthMaxAgeMs: 7 * 86400000 } }));
  assert.throws(() => validateConfig({ ...base, mainChecks: [main('nightly')] }), /tier must be "merge" or "scheduled"/);
  assert.throws(() => validateConfig({ ...base, mainChecks: [main('scheduled')] }), /at least one main check must run after every merge/);
  assert.throws(() => validateConfig({ ...base, mainChecks: [main()], policy: { scheduledHealthMaxAgeMs: 60000 } }), /scheduledHealthMaxAgeMs/);
});

test('doctor qualifies the baseline with every tier and records scheduled-tier evidence', async t => {
  const base = mkdtempSync(join(tmpdir(), 'factotum-tiers-doctor-')), root = join(base, 'repo'), remote = join(base, 'remote.git'), stateDir = join(base, 'state'); mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fictional@example.invalid']); git(['config', 'user.name', 'Fictional']); writeFileSync(join(root, 'fixture.txt'), 'fictional'); git(['add', '.']); git(['commit', '-qm', 'Fictional baseline']); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  initProject({ stateDir, root, name: 'Fictional', supervisor: 'systemd', workflow: { version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } } });
  const kit = checkKit(base), store = new Store(stateDir);
  t.after(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/project', account: 'fictional', target: 'main', remote: 'origin' }, providers, policy: { maxFlows: 1 }, checks: [{ id: 'fixture', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], mainChecks: tiered(kit), context: { files: [], maxChars: 1000 }, resources: { coordinatorPath: join(base, 'host.sqlite') }, backupRoot: join(base, 'backups') };
  store.setMeta('config', config); store.setMeta('configDigest', digest(config));
  const options = { providerPreflight: async spec => ({ provider: spec.provider, version: 'fictional', billing: { mode: 'subscription' }, capabilities: { structuredOutput: true, readOnly: true } }), forgeTransport: async () => ({ permissions: { push: true } }) };
  kit.fail('full-suite');
  let result = await doctor(stateDir, options);
  assert.equal(result.ready, false); assert.match(result.reasons.join('; '), /main baseline verification failed/); assert.deepEqual(kit.ran(), ['unit', 'full-suite']);
  kit.fail('full-suite', false);
  result = await doctor(stateDir, options);
  assert.equal(result.ready, true, JSON.stringify(result)); assert.deepEqual(kit.ran(), ['unit', 'full-suite']);
  const health = store.meta('mainHealth');
  assert.equal(health.status, 'green'); assert.deepEqual(health.tiers, ['merge', 'scheduled']); assert.equal(health.scheduled.status, 'green');
});

test('each target keeps its own tier evidence: a scheduled red on one branch holds only its work', async t => {
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']); git(['push', '-q', 'origin', 'main:refs/heads/next']);
  const kit = checkKit(f.base), head = repositoryIdentity(f.root).head;
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/tiers', account: 'fictional', target: 'main', remote: 'origin' }, providers, mainChecks: tiered(kit), checks: [{ id: 'acceptance', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { autoQueue: false, mainProbeMs: 0 }, workflows: { definitions: { change: { reference: 'change.standard' }, web: { reference: 'change.standard', target: 'next' } }, selection: { default: 'change', rules: [{ label: 'web', workflow: 'web' }] } } };
  assert.equal(f.command('config.update', { config, note: 'Two targets with tiered main checks' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', greenHealth(head)); setTargetHealth(f.store, 'next', greenHealth(head));
  for (const [id, labels] of [['main-work', []], ['web-work', ['web']]]) { const task = f.command('task.put', { task: { id, title: 'Fictional work', acceptance: ['Works'], labels } }).result; assert.equal(f.command('task.approve', { taskId: id, revision: task.revision }).status, 'completed'); }
  const reasons = id => admissionReasons(f.store, f.store.need('task', id)).filter(r => /health/.test(r));
  assert.deepEqual(reasons('web-work'), []); assert.deepEqual(reasons('main-work'), []);
  kit.fail('full-suite');
  let out = await runJob(f, enqueue(f, { target: 'next' }).id);
  assert.deepEqual(kit.ran(), ['unit', 'full-suite']); assert.equal(out.mainHealth.target, 'next');
  assert.equal(targetHealth(f.store, 'next').status, 'red'); assert.equal(targetHealth(f.store, 'next').scheduled.status, 'red');
  assert.equal(targetHealth(f.store, 'main').status, 'green'); assert.equal(targetHealth(f.store, 'main').scheduled.status, 'green');
  assert.match(reasons('web-work').join('; '), /^next health is red: scheduled-tier check full-suite failed/); assert.deepEqual(reasons('main-work'), []);
  kit.fail('full-suite', false);
  await runJob(f, enqueue(f, { target: 'next', tier: 'merge' }).id);
  assert.deepEqual(kit.ran(), ['unit']); assert.equal(targetHealth(f.store, 'next').status, 'red', 'merge tier cannot clear it on this target either');
  await runJob(f, enqueue(f, { target: 'next' }).id);
  assert.equal(targetHealth(f.store, 'next').status, 'green'); assert.deepEqual(reasons('web-work'), []);
});

test('the Health card shows each tier and why admission is held; Settings lists each check\'s tier', async t => {
  const f = fixture(t), at = new Date().toISOString(), head = f.identity.head;
  setTargetHealth(f.store, null, { status: 'red', head, checkedAt: at, tier: 'all', tiers: ['merge', 'scheduled'], checks: [{ id: 'unit', tier: 'merge', status: 'passed' }, { id: 'full-suite', tier: 'scheduled', status: 'failed' }], scheduled: { status: 'red', head, checkedAt: at, checks: [], failed: ['full-suite'] } });
  setTargetHealth(f.store, null, { status: 'green', head, checkedAt: at, tier: 'merge', tiers: ['merge'], checks: [{ id: 'unit', tier: 'merge', status: 'passed' }] });
  assert.equal(f.command('queue.put', { taskIds: ['other'] }).status, 'completed');
  const { snapshot } = await import('../starter/factory/core/project.mjs');
  const project = { projectId: f.project.projectId, name: 'Fictional tiers', status: 'available', snapshot: snapshot(f.store) };
  assert.deepEqual(project.snapshot.settings.mainChecks.map(c => [c.id, c.tier ?? 'merge']), [['unit', 'merge'], ['full-suite', 'scheduled']]);
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.style = { setProperty() {} }; this._text = text; }
    append(...items) { this.children.push(...items); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(key, value) { this[key] = value; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? String(c)).join(' '); }
  }
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window'], old = Object.fromEntries(keys.map(k => [k, globalThis[k]])), storage = { getItem: () => null, setItem() {} };
  Object.assign(globalThis, { Node: Element, document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) }, localStorage: storage, sessionStorage: storage, window: { addEventListener() {}, location: { hash: '' } } });
  try {
    const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
    const shown = operationsView(project).textContent;
    assert.match(shown, /Merge tier \S+ green/); assert.match(shown, /Scheduled tier \S+ red/); assert.match(shown, /failed: full-suite/);
    assert.match(shown, /Last run\s+Merge tier only/);
    assert.match(shown, /Admission\s+Change and document tasks wait: main health is red: scheduled-tier check full-suite failed/);
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});

// Independent review fixes.

test('a full verification whose merge-tier check fails keeps the scheduled red; only an entirely green full run clears it', async t => {
  const f = fixture(t), later = Date.now() + 16 * 60000;
  f.fail('full-suite');
  await runJob(f, enqueue(f).id);
  const failed = f.store.meta('mainHealth').scheduled; f.ran();
  assert.equal(failed.status, 'red');
  // Scheduled checks now pass but a merge-tier check fails in the same full run.
  f.fail('full-suite', false); f.fail('unit');
  const full = await runJob(f, enqueue(f).id);
  assert.equal(full.route, 'fail'); assert.deepEqual(f.ran(), ['unit', 'full-suite']);
  let health = f.store.meta('mainHealth');
  assert.equal(health.status, 'red'); assert.equal(health.scheduled.status, 'red', 'a failed full run does not clear the scheduled red');
  assert.equal(health.scheduled.checkedAt, failed.checkedAt); assert.deepEqual(health.scheduled.failed, ['full-suite']);
  assert.equal(health.scheduled.stillRedAt.head, f.identity.head);
  assert.equal(f.command('queue.put', { taskIds: ['other'] }).status, 'completed');
  assert.equal(f.store.tx(() => ensureMainVerification(f.store, { nowMs: later })), null, 'never requested again for the same head');
  // A merge-tier pass afterwards still cannot reopen admission.
  f.fail('unit', false);
  await runJob(f, enqueue(f, { tier: 'merge' }).id);
  health = f.store.meta('mainHealth');
  assert.equal(health.status, 'red'); assert.equal(health.tierStatus, 'green'); assert.equal(health.scheduled.status, 'red');
  assert.match(f.mainReasons().join('; '), /scheduled-tier check full-suite failed/);
  assert.equal(f.command('flow.start', { taskId: 'other', revision: f.store.need('task', 'other').revision }).status, 'rejected');
  // An entirely green full verification clears it.
  await runJob(f, enqueue(f).id);
  health = f.store.meta('mainHealth');
  assert.equal(health.status, 'green'); assert.equal(health.scheduled.status, 'green'); assert.equal(health.scheduled.stillRedAt, undefined);
  assert.deepEqual(f.mainReasons(), []);
});

test('a fix pushed outside the factory is probed while the scheduled tier is red and requests one full verification per head', async t => {
  const f = fixture(t, { policy: { mainProbeMs: 10000 } });
  let clock = Date.now();
  const tick = ms => (clock += ms);
  const push = name => { writeFileSync(join(f.root, `${name}.txt`), name); f.git(['add', '.']); f.git(['commit', '-qm', `Fictional ${name}`]); f.git(['push', '-q', 'origin', 'main']); return repositoryIdentity(f.root).head; };
  f.fail('full-suite');
  await runJob(f, enqueue(f).id);
  const failed = f.store.meta('mainHealth').scheduled, OLD = failed.head;
  assert.equal(f.command('queue.put', { taskIds: ['other'] }).status, 'completed');
  assert.match(f.mainReasons().join(' '), /A full verification is requested automatically once for each new main head, including a fix pushed outside the factory; for the same head \(for example after fixing a transient failure\), run main\.verify \(every tier, the default\)/);
  f.fail('full-suite', false);
  const FIX = push('fix');
  const moved = await probeTargetHead(f.store, { nowMs: tick(20000) });
  assert.deepEqual(moved, { head: FIX, moved: true });
  let health = f.store.meta('mainHealth');
  assert.equal(health.head, FIX); assert.equal(health.previousHead, OLD); assert.equal(health.status, 'red'); assert.equal(health.tierStatus, 'unknown');
  assert.deepEqual(health.scheduled, failed, 'the red evidence is preserved by the probe');
  assert.equal(f.store.events(50).some(e => e.type === 'main.moved'), true);
  // Back-off after the failed verification still applies; then one full verification is requested.
  assert.equal(f.store.tx(() => ensureMainVerification(f.store, { nowMs: clock })), null);
  let id = f.store.tx(() => ensureMainVerification(f.store, { nowMs: tick(16 * 60000) }));
  assert.deepEqual(f.store.need('job', id).payload, { tier: 'all' });
  // That run fails a merge-tier check: the red stays and is not requested again for this head.
  f.fail('unit');
  await runJob(f, id);
  health = f.store.meta('mainHealth');
  assert.equal(health.status, 'red'); assert.equal(health.scheduled.head, OLD); assert.equal(health.scheduled.stillRedAt.head, FIX);
  assert.equal(f.store.tx(() => ensureMainVerification(f.store, { nowMs: tick(16 * 60000) })), null);
  // Another pushed fix is probed and verified in full.
  f.fail('unit', false);
  const FIX2 = push('fix-2');
  assert.deepEqual(await probeTargetHead(f.store, { nowMs: tick(20000) }), { head: FIX2, moved: true });
  assert.deepEqual(f.store.meta('mainHealth').scheduled.head, OLD);
  id = f.store.tx(() => ensureMainVerification(f.store, { nowMs: tick(16 * 60000) }));
  assert.deepEqual(f.store.need('job', id).payload, { tier: 'all' });
  await runJob(f, id);
  assert.deepEqual(f.ran().slice(-2), ['unit', 'full-suite']);
  health = f.store.meta('mainHealth');
  assert.equal(health.status, 'green'); assert.equal(health.head, FIX2); assert.equal(health.scheduled.head, FIX2);
  assert.deepEqual(f.mainReasons(), []);
});

test('the scheduled-red message says how recovery actually happens for this configuration', t => {
  const at = new Date().toISOString(), red = head => ({ status: 'red', head, checkedAt: at, scheduled: { status: 'red', head, checkedAt: at, checks: [], failed: ['full-suite'] } });
  const manual = fixture(t, { policy: { autoQueue: false } });
  setTargetHealth(manual.store, null, red(manual.identity.head));
  assert.match(manual.mainReasons().join(' '), /fix main or use an explicit recovery task\. After fixing main, run main\.verify \(every tier, the default\)$/);
  assert.doesNotMatch(manual.mainReasons().join(' '), /automatically|wait for/);
  const schedule = { id: 'nightly-main', enabled: true, type: 'interval', anchorMs: Date.now(), everyMs: 86400000, operation: 'main.verify', createdAt: at };
  manual.store.put('schedule', { ...schedule, revision: scheduleGrantDigest(schedule) });
  assert.match(manual.mainReasons().join(' '), /run main\.verify \(every tier, the default\), or wait for the scheduled full verification$/);
  const unprobed = fixture(t, { policy: { mainProbeMs: 0 } });
  setTargetHealth(unprobed.store, null, red(unprobed.identity.head));
  assert.match(unprobed.mainReasons().join(' '), /requested automatically after a factory merge moves main; policy\.mainProbeMs is 0, so a fix pushed outside the factory is not noticed: run main\.verify \(every tier, the default\) after it$/);
});

test('Stats counts merges since the target was last green, not since a merge-tier pass under a scheduled red', async t => {
  const f = fixture(t);
  // The change is admitted while main is green; main turns red before it merges.
  assert.equal(f.command('task.approve', { taskId: f.task.id, revision: f.task.revision }).status, 'completed');
  assert.equal(f.command('flow.start', { taskId: f.task.id, revision: f.task.revision, flowId: 'flow-1' }).status, 'completed');
  f.fail('full-suite');
  await runJob(f, enqueue(f).id);
  const flow = f.store.need('flow', 'flow-1'), identity = repositoryIdentity(f.root); flow.mergeAuthorization = { identity, taskRevision: flow.taskRevision, configDigest: flow.configDigest }; f.store.put('flow', flow);
  await f.engine.step(flow.id); const attempt = f.store.need('attempt', f.store.need('flow', flow.id).attemptId);
  attempt.intent = { ...attempt.intent, action: { operation: 'forge.merge' } };
  f.engine.settle(flow.id, attempt, receipt(attempt, { route: 'merged', merged: true, sha: identity.head, expectedHead: identity.head, expectedBase: identity.head, outputIdentity: identity }));
  await f.engine.step(flow.id);
  // The merge writer keeps the scheduled red.
  let health = f.store.meta('mainHealth');
  assert.equal(health.status, 'red'); assert.equal(health.tierStatus, 'unknown'); assert.equal(health.scheduled.status, 'red');
  await runJob(f, 'post-merge-main:flow-1');
  assert.equal(f.store.meta('mainHealth').status, 'red');
  f.fail('full-suite', false);
  await runJob(f, enqueue(f).id);
  assert.equal(f.store.meta('mainHealth').status, 'green');
  const main = projectStats(f.store).checks.main;
  assert.deepEqual(main.map(r => [r.tier, r.status, r.targetStatus, r.mergesSinceGreen]), [['all', 'green', 'green', 1], ['merge', 'green', 'red', 1], ['all', 'red', 'red', 0]]);
});

test('every health writer preserves scheduled-tier red evidence, and a blocked full run records none', async t => {
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']); git(['push', '-q', 'origin', 'main:refs/heads/next']);
  const kit = checkKit(f.base), head = repositoryIdentity(f.root).head;
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/tiers', account: 'fictional', target: 'main', remote: 'origin', syncTargets: [{ from: 'main', into: 'next' }] }, providers, mainChecks: tiered(kit), checks: [{ id: 'acceptance', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { autoQueue: false, mainProbeMs: 0 }, workflows: { definitions: { change: { reference: 'change.standard' }, web: { reference: 'change.standard', target: 'next' } }, selection: { default: 'change', rules: [{ label: 'web', workflow: 'web' }] } } };
  assert.equal(f.command('config.update', { config, note: 'Two targets with tiered main checks' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', greenHealth(head)); setTargetHealth(f.store, 'next', greenHealth(head));
  const task = f.command('task.put', { task: { id: 'web-work', title: 'Fictional work', acceptance: ['Works'], labels: ['web'] } }).result; assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed');
  kit.fail('full-suite');
  await runJob(f, enqueue(f, { target: 'next' }).id);
  const evidence = targetHealth(f.store, 'next').scheduled;
  assert.equal(evidence.status, 'red');
  const latched = (store, writer) => {
    const health = targetHealth(store, 'next');
    assert.equal(health.status, 'red', writer); assert.deepEqual(health.scheduled, evidence, writer);
    // While a verification is in flight, admission names it instead; the red stands underneath.
    const busy = store.all('job').some(job => job.operation === 'main.verify' && ['queued', 'running'].includes(job.status));
    assert.match(admissionReasons(store, store.need('task', 'web-work')).join('; '), busy ? /next health pending: next verification in progress/ : /next health is red: scheduled-tier check full-suite failed/, writer);
    return health;
  };
  const prepare = async id => { await operationalTick(f.store); const job = f.store.need('job', id); assert.equal(job.status, 'running', job.reason ?? job.status); await f.engine.step(job.flowId); const flow = f.store.need('flow', job.flowId); return { flow, attempt: f.store.need('attempt', flow.attemptId) }; };
  // Dispatch the real supervisor with a substituted worker that exits nonzero.
  const dispatchCrash = async ({ flow, attempt }, writer) => {
    attempt.intent.argv = [process.execPath, '-e', 'process.exit(19)']; attempt.intentDigest = digest(attempt.intent); f.store.put('attempt', attempt);
    atomicJSON(join(f.stateDir, 'attempts', attempt.id, 'intent.json'), { ...attempt.intent, intentDigest: attempt.intentDigest });
    await f.engine.step(flow.id);
    const written = latched(f.store, writer); assert.equal(written.tierStatus, 'unknown', writer); assert.equal(written.attemptId, attempt.id, `${writer} wrote this health`);
    await until(() => ['uncertain', 'terminal'].includes(inspect(f.store, f.store.need('attempt', attempt.id)).kind));
    // The supervisor writes its receipt before it exits, so the receipt can be read while it is
    // still alive. attempt.resolve rightly requires a dead owner (quiescence), so wait for that.
    const ownerPath = join(f.stateDir, 'attempts', attempt.id, 'owner.json');
    await until(() => !existsSync(ownerPath) || ownerState(JSON.parse(readFileSync(ownerPath, 'utf8'))) === 'dead');
    await f.engine.step(flow.id);
    const current = f.store.need('attempt', attempt.id);
    if (current.status === 'uncertain') { const resolved = f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'failed', costMicros: 0, note: 'Fictional worker exited' }); assert.equal(resolved.status, 'completed', resolved.error); }
    if (!['completed', 'failed'].includes(f.store.need('flow', flow.id).state)) assert.equal(f.command('flow.abandon', { flowId: flow.id, note: 'Fictional crash cleaned up' }).status, 'completed');
    latched(f.store, `${writer} settlement`);
  };
  kit.fail('full-suite', false);
  // Failed settlement of a real verification run.
  await runJob(f, enqueue(f, { target: 'next', tier: 'merge' }).id, { settled: { exitCode: 1 } });
  assert.match(latched(f.store, 'failed settlement').tierStatus, /unknown/);
  // Target synchronization settlement.
  const sync = await prepare(f.command('job.enqueue', { operation: 'target.sync', payload: { from: 'main', into: 'next' }, note: 'Fictional sync' }).result.id);
  f.engine.settle(sync.flow.id, sync.attempt, receipt(sync.attempt, { route: 'pass', sync: { from: 'main', into: 'next', fromHead: head, head, contained: true } }));
  await f.engine.step(sync.flow.id);
  assert.equal(latched(f.store, 'target.sync settlement').attemptId, sync.attempt.id);
  // A blocked full run records no new evidence, even when its scheduled checks passed: here the
  // merge-tier check's tool is missing on the machine while full-suite runs and passes.
  const blockedConfig = { ...config, mainChecks: [{ ...config.mainChecks[0], argv: [join(f.base, 'missing-tool')] }, config.mainChecks[1]] };
  assert.equal(f.command('config.update', { config: blockedConfig, note: 'Merge-tier check needs a missing tool' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  const blocked = await runJob(f, enqueue(f, { target: 'next' }).id);
  assert.equal(blocked.route, 'blocked'); assert.deepEqual(kit.ran().slice(-1), ['full-suite']); assert.equal(Object.hasOwn(blocked.mainHealth, 'scheduled'), false);
  latched(f.store, 'blocked full run');
  assert.equal(f.command('config.update', { config, note: 'Restore the scheduled check' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  // Dispatch-time invalidation: main.verify, then target.sync.
  await dispatchCrash(await prepare(enqueue(f, { target: 'next', tier: 'merge' }).id), 'main.verify dispatch');
  await dispatchCrash(await prepare(f.command('job.enqueue', { operation: 'target.sync', payload: { from: 'main', into: 'next' }, note: 'Fictional sync' }).result.id), 'target.sync dispatch');
  // Restart: the evidence and the hold survive reopening the store.
  const reopened = new Store(f.stateDir);
  try { latched(reopened, 'restart'); } finally { reopened.close(); }
  // Only an entirely green full verification clears it.
  await runJob(f, enqueue(f, { target: 'next' }).id);
  assert.equal(targetHealth(f.store, 'next').status, 'green'); assert.equal(targetHealth(f.store, 'next').scheduled.status, 'green');
});

test('a merge-tier pass superseded by another health write is not counted as a recovery in Stats', async t => {
  // Seen in re-check: a superseded in-flight verification fell back to its own green result.
  const f = fixture(t);
  f.fail('full-suite');
  await runJob(f, enqueue(f).id);
  assert.equal(f.store.meta('mainHealth').status, 'red');
  f.fail('full-suite', false);
  const job = enqueue(f, { tier: 'merge' });
  await operationalTick(f.store);
  const running = f.store.need('job', job.id); await f.engine.step(running.flowId);
  const flow = f.store.need('flow', running.flowId), attempt = f.store.need('attempt', flow.attemptId);
  const outcome = await runMaintenanceAction({ ...attempt.intent, action: { ...attempt.intent.action, resource: false } });
  // Another writer invalidates health while the verification is in flight (the scheduled red is kept).
  setTargetHealth(f.store, null, { ...f.store.meta('mainHealth'), checkedAt: new Date().toISOString(), reason: 'Fictional concurrent invalidation' });
  f.engine.settle(flow.id, attempt, receipt(attempt, outcome));
  await f.engine.step(flow.id);
  assert.equal(outcome.mainHealth.status, 'green', 'the run itself passed its merge tier');
  assert.equal(f.store.meta('mainHealth').scheduled.status, 'red');
  const rows = projectStats(f.store).checks.main;
  assert.equal(rows[0].status, 'green'); assert.equal(rows[0].targetStatus, 'superseded');
  assert.ok(!rows.some(r => r.targetStatus === 'green'), 'no green target is recorded while the scheduled red stands');
});
