// dev.89: the dev.88 readiness re-test findings M1–M9 (docs/changes/dev89-m-items.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';
import { buildRelease, prepareAdoption } from '../starter/factory/distribution.mjs';
import { prepareUpgrade, mergeUpgrade } from '../starter/factory/operations/upgrade-apply.mjs';
import { liveSettingChanges } from '../starter/factory/operations/live-settings.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(ROOT, path), 'utf8');
const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 1 } };
const delivery = t => { const f = sandbox(t); assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed'); return f; };

// ---------------------------------------------------------------- M1
test('M1: config update with current keeps every live change and its provenance, and a later update from the file keeps them', t => {
  const f = delivery(t);
  assert.equal(f.command('settings.update', { changes: { 'policy.autoQueue': true, 'notifications.handoffAfterDeliveries': 80 }, note: 'Live' }).status, 'completed');
  const before = liveSettingChanges(f.store);
  const current = f.command('config.update', { current: true, note: 'Recommission' });
  assert.equal(current.status, 'completed', current.error);
  assert.deepEqual(liveSettingChanges(f.store), before, 'provenance unchanged');
  assert.deepEqual(current.result.preservedLiveSettings.sort(), ['notifications.handoffAfterDeliveries', 'policy.autoQueue']);
  assert.equal(current.result.changedLiveSettings, undefined, 'nothing changed');
  // The event log agrees, so a project without the meta record rebuilds the same provenance.
  f.store.setMeta('liveSettingChanges', null);
  assert.deepEqual(Object.keys(liveSettingChanges(f.store)).sort(), ['notifications.handoffAfterDeliveries', 'policy.autoQueue']);
  f.store.setMeta('liveSettingChanges', before);
  const later = f.command('config.update', { config: { ...base, context: { files: [], maxChars: 2000 } }, note: 'File' });
  assert.deepEqual(later.result.keptLiveSettings.sort(), ['notifications.handoffAfterDeliveries', 'policy.autoQueue']);
  assert.equal(f.store.meta('config').policy.autoQueue, true); assert.equal(f.store.meta('config').notifications.handoffAfterDeliveries, 80);
  // current takes neither a file nor replaceLive.
  for (const payload of [{ current: true, config: base }, { current: true, replaceLive: true }]) assert.match(f.command('config.update', { ...payload, note: 'x' }).error, /pass neither config nor replaceLive/);
});

test('M1: a file update that reverts a live value names it, with the last live change, in its result and an event', t => {
  const f = delivery(t);
  f.command('settings.update', { changes: { 'policy.autoQueue': true }, note: 'Live' });
  // The state a dev.88 recommission left: the value stored, its provenance erased.
  f.store.setMeta('liveSettingChanges', {});
  const reverted = f.command('config.update', { config: { ...base, policy: { maxFlows: 2 } }, note: 'File' });
  assert.equal(reverted.status, 'completed', reverted.error);
  assert.deepEqual(reverted.result.keptLiveSettings, []);
  assert.deepEqual(reverted.result.changedLiveSettings, ['policy.autoQueue', 'policy.maxFlows']);
  const row = reverted.result.changedLiveDetails.find(r => r.setting === 'policy.autoQueue');
  assert.equal(row.from, true); assert.equal(row.to, false); assert.equal(row.lastLiveChange.value, true); assert.equal(row.lastLiveChange.by, 'operator');
  assert.equal(reverted.result.changedLiveDetails.find(r => r.setting === 'policy.maxFlows').lastLiveChange, undefined, 'a file-only change has no live change to name');
  assert.ok(f.store.events(50).some(e => e.type === 'config.live-settings-changed'));
});

test('M1: through a real upgrade apply, the recommission keeps live changes, and the next config update from the file keeps them', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const build = (version, dir) => ({ dir, ...buildRelease({ sourceDir: join(ROOT, 'starter'), outputDir: dir, version, allowWorkingTree: true }) });
  const one = build('0.2.0-dev.20261116.1', join(f.base, 'release-1')), two = build('0.2.0-dev.20261116.2', join(f.base, 'release-2'));
  const installed = prepareAdoption({ root: f.root, releaseDir: one.dir, expectedDigest: one.manifestDigest, branch: 'chore/install', worktreeDir: join(f.base, 'install'), initial: true });
  git(installed.worktree, ['add', '.']); git(installed.worktree, ['commit', '-qm', 'Adopt 1']); git(f.root, ['merge', '--ff-only', 'chore/install']);
  assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed');
  // The two settings the trial lost: a flag and an operator-only handoff limit.
  assert.equal(f.command('settings.update', { changes: { 'policy.autoQueue': true, 'notifications.handoffAfterDeliveries': 80 }, note: 'Live' }).status, 'completed');
  const options = { root: f.root, stateDir: f.stateDir, releaseDir: two.dir, expectedDigest: two.manifestDigest, branch: 'chore/factotum-2', worktreeDir: join(f.base, 'review-2') };
  const prepared = prepareUpgrade(options); git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 2']);
  const { runProcess } = await import('../starter/factory/adapters/providers/index.mjs');
  // The merged release's real CLI recommissions; systemctl is faked, and doctor (no providers here) is not ready.
  const run = (binary, args, opts) => binary === process.execPath && args.includes('config') ? runProcess(binary, args, opts) : Promise.resolve(binary === process.execPath ? { code: 1, stdout: JSON.stringify({ ready: false, reasons: ['fictional'] }), stderr: '' } : { code: binary === 'systemctl' && args.includes('is-active') ? 3 : 0, stdout: '', stderr: '' });
  const result = await mergeUpgrade({ ...options, backupDir: join(f.base, 'backup'), run });
  const recommission = result.steps.find(row => row.step === 'recommission');
  assert.equal(recommission.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(Object.keys(liveSettingChanges(f.store)).sort(), ['notifications.handoffAfterDeliveries', 'policy.autoQueue'], 'the recommission kept the live changes');
  const later = f.command('config.update', { config: { ...base, context: { files: [], maxChars: 2000 } }, note: 'The operator\'s file, after the upgrade' });
  assert.equal(later.status, 'completed', later.error);
  assert.deepEqual(later.result.keptLiveSettings.sort(), ['notifications.handoffAfterDeliveries', 'policy.autoQueue']);
  assert.equal(f.store.meta('config').policy.autoQueue, true); assert.equal(f.store.meta('config').notifications.handoffAfterDeliveries, 80);
  assert.equal(later.result.changedLiveSettings, undefined);
});

// ---------------------------------------------------------------- M3
// The review-correction fixture (tests/review-correction.test.mjs) with a plan step to replan to.
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { replanFlow } from '../starter/factory/core/project.mjs';
const reviewReport = { verdict: 'revise', summary: 'The plan does not list CHANGELOG.md', findings: [{ severity: 'medium', file: 'input.txt', line: 1, message: 'The reviewed plan does not list CHANGELOG.md' }], scopeSummary: 'Entire fictional change' };
const buildResult = () => ({ route: 'implemented', provider: 'codex', model: 'fictional', family: 'openai', sessionId: 'builder-session', result: { status: 'implemented', summary: 'Nothing to change', questions: [], departures: [], unverified: [], pushback: [] } });
const receipt = actionResult => ({ exitCode: 0, reason: null, costMicros: 0, actionResult });
async function reviewFixture(t, { setup } = {}) {
  const f = sandbox(t), ghPath = join(f.base, 'gh'); setup?.(f.root);
  writeFileSync(ghPath, `#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');`, { mode: 0o700 });
  const effect = (operation, next, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: 60000, next, onFailure: 'failed', ...extra });
  const workflow = { version: 1, start: 'inspect', nodes: {
    plan: effect('provider.plan', 'repair'),
    inspect: effect('provider.review', 'verify', { resultEdges: { pass: 'verify', revise: 'repair', defer: 'done' } }),
    repair: effect('provider.build', 'inspect', { maxVisits: 4, resultEdges: { implemented: 'inspect', blocked: 'question' } }),
    verify: effect('gate', 'done'),
    question: { kind: 'question', role: 'operator', question: 'Builder needs guidance', answers: { retry: 'repair', stop: 'stopped' } },
    stopped: { kind: 'end', outcome: 'stopped' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' },
  } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', ghPath }, providers: { builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { planning: false }, context: { files: [], maxChars: 1000 } });
  f.command('queue.put', { taskIds: [f.task.id] }); f.start();
  const flow = f.store.need('flow', 'flow-1'); flow.results.source = { head: repositoryIdentity(f.root).head }; flow.results.plan = planned({ files: ['input.txt'] }, 'planner-session-1'); f.store.put('flow', flow);
  await f.engine.tick(); const reviewAttempt = f.store.all('attempt')[0];
  const review = await runAction(reviewAttempt.intent, { providerInvoke: async () => ({ provider: 'claude', family: 'anthropic', result: structuredClone(reviewReport) }) });
  assert.equal(review.route, 'revise');
  f.engine.settle(flow.id, reviewAttempt, receipt(review));
  assert.equal(f.store.need('flow', flow.id).step, 'repair');
  return { ...f, flowId: flow.id };
}
// A planner result as dispatch records it: the plan report, what it was planned against, and how it was produced.
const planned = (result, sessionId, extra = {}) => ({ provider: 'codex', model: 'fictional', family: 'openai', sessionId, usage: { inputTokens: 1000 + sessionId.length, outputTokens: 50 }, costMicros: sessionId.length, durationMs: 1234 * sessionId.length, attemptId: `attempt-${sessionId}`,
  route: 'ready', result: { status: 'ready', summary: 'Add one line', questions: [], ...result }, contextDigest: 'c'.repeat(64), taskRevision: 'fictional-revision', identity: { head: 'a'.repeat(40), treeDigest: 'b'.repeat(64) }, targetBase: 'a'.repeat(40), ...extra });
// Replan, then the planner's new plan (the plan step's own run is not what this tests), then the build.
async function replanThenBuild(f, plan) {
  f.store.tx(() => replanFlow(f.store, f.store.need('flow', f.flowId), { note: 'List CHANGELOG.md in the plan', by: 'operator' }));
  const flow = f.store.need('flow', f.flowId); assert.equal(flow.step, 'plan');
  flow.results.plan = plan; flow.step = 'repair'; f.store.put('flow', flow);
  await f.engine.tick(); const attempt = f.store.need('attempt', f.store.need('flow', f.flowId).attemptId);
  assert.equal(attempt.step, 'repair');
  f.engine.settle(f.flowId, attempt, receipt(buildResult()));
  return f.store.need('flow', f.flowId);
}

test('M3: after a replan that changed the plan, the unchanged candidate goes to review again', async t => {
  const f = await reviewFixture(t);
  const flow = await replanThenBuild(f, planned({ files: ['input.txt', 'CHANGELOG.md'] }, 'planner-session-2'));
  assert.notEqual(flow.state, 'stopped', flow.stopReason);
  assert.equal(flow.step, 'inspect', 'reviewed again, against the new plan');
});

test('M3: after a replan that left the plan as it was, the unchanged candidate is still held, and the stop names flow.note', async t => {
  const f = await reviewFixture(t);
  const flow = await replanThenBuild(f, planned({ files: ['input.txt'] }, 'planner-session-1'));
  assert.equal(flow.state, 'stopped'); assert.equal(flow.resumeStep, 'repair');
  assert.match(flow.stopReason, /unchanged reviewed candidate/); assert.match(flow.stopReason, /guidance with flow\.note \(a resume note is only the reason and does not reach the builder\)/); assert.match(flow.stopReason, /flow\.replan/);
});

// ---- M6
import { upkeepProject, UPKEEP } from './upkeep-fixtures.mjs';
test('M6: while admission is paused (without holdMaintenance), a hand-queued knowledge.upkeep job waits exactly like an audit job, and both start once admission resumes', async t => {
  const f = upkeepProject(t, { upkeep: { ...UPKEEP, mode: 'off' } }), merged = await f.mergedAndFinished('a');
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }).status, 'completed');
  const paused = f.command('pause', { paused: true, note: 'Fictional pause' }); assert.equal(paused.result.maintenanceHeld, false);
  const upkeep = f.command('job.enqueue', { operation: 'knowledge.upkeep', payload: { flowId: merged.flowId }, note: 'Assess this merge' });
  const audit = f.command('job.enqueue', { operation: 'audit', note: 'Audit now' });
  assert.equal(upkeep.status, 'completed', upkeep.error); assert.equal(audit.status, 'completed', audit.error);
  const started = () => f.store.all('flow').filter(flow => flow.kind === 'maintenance').length;
  for (let i = 0; i < 2; i++) await f.tick();
  assert.deepEqual([f.store.need('job', upkeep.result.id).status, f.store.need('job', audit.result.id).status], ['queued', 'queued'], 'neither starts while paused');
  assert.equal(started(), 0);
  assert.equal(f.command('pause', { paused: false, note: 'Resume' }).status, 'completed');
  await f.tick();
  assert.deepEqual([f.store.need('job', upkeep.result.id).status, f.store.need('job', audit.result.id).status], ['running', 'running'], 'both start once admission resumes (separate lanes)');
  // Recorded where holdMaintenance is described, and in the command's help.
  assert.match(read('docs/operations.md'), /\*\*Paused admission\.\*\* A pause holds the start of every queued maintenance job, knowledge upkeep included/);
  assert.match(read('starter/factory/core/command-help.mjs'), /While paused, no queued maintenance job starts either, knowledge upkeep included/);
});

// ---- M8
import { stateView } from '../starter/factory/operations/state-view.mjs';
test('M8: a resumed flow has no stop reason; the stop event keeps it, and the narrow read shows one only for a stopped flow', t => {
  const f = sandbox(t);
  assert.equal(f.start().status, 'completed');
  assert.equal(f.command('stop', { flowId: 'flow-1', note: 'Fictional operator stop' }).status, 'completed');
  assert.equal(f.store.need('flow', 'flow-1').stopReason, 'Fictional operator stop');
  assert.equal(stateView(f.store, { flow: 'flow-1' }).flow.stopReason, 'Fictional operator stop', 'a stopped flow shows it');
  const resumed = f.command('resume', { flowId: 'flow-1', note: 'Go on' });
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.equal(f.store.need('flow', 'flow-1').stopReason, undefined);
  assert.equal(stateView(f.store, { flow: 'flow-1' }).flow.stopReason, null);
  assert.ok(f.store.events(50).some(e => e.type === 'flow.stopped'), 'the stop stays in the events');
  // A flow resumed before dev.89 still carries one: the read leaves it out.
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), state: 'waiting', stopReason: 'An old reason' });
  assert.equal(stateView(f.store, { flow: 'flow-1' }).flow.stopReason, null);
});

// ---- M2
import { delegatedOperations } from '../starter/factory/core/delegation.mjs';
test('M2: with no policy.delegatedOperations list the finding commands are delegated, and the docs say so', () => {
  for (const operation of ['finding.accept', 'finding.resolve', 'finding.reopen']) {
    assert.ok(delegatedOperations({ policy: {} }).includes(operation), operation);
    assert.ok(!delegatedOperations({ policy: { delegatedOperations: ['answer'] } }).includes(operation), operation);
  }
  const notes = read('docs/release-notes.md'), dev88 = notes.slice(notes.indexOf('## 0.2.0-dev.20261022.88'), notes.indexOf('\n## ', notes.indexOf('## 0.2.0-dev.20261022.88') + 5));
  assert.doesNotMatch(dev88, /the orchestrator if you list them in `policy\.delegatedOperations`/);
  assert.match(dev88, /With no list, every delegable operation is delegated, these three included; an explicit list delegates them only if it names them/);
  assert.match(dev88, /A project with no list needs nothing here/);
  assert.match(read('docs/operations.md'), /with no `policy\.delegatedOperations` list every delegable operation is delegated, these three included/);
  // The slice 4 record no longer reads as opt-in, and points to the design (the operator's decision, dev.89).
  const slice4 = read('docs/changes/upkeep-slice4.md');
  assert.doesNotMatch(slice4, /`policy\.delegatedOperations` may list `finding\.accept`/);
  assert.match(slice4, /\*\*Three commands are delegable, and delegated by default\.\*\*.*\(\.\.\/designs\/knowledge-upkeep\.md\)/);
  assert.match(read('docs/designs/knowledge-upkeep.md'), /The operator confirmed this default in dev\.89\./);
});

// ---- M1 docs, M3 help, M4 brief
test('M1, M4: the repair guidance and the brief\'s first step are written down', () => {
  const ops = read('docs/operations.md');
  assert.match(ops, /### Live settings after an upgrade/);
  for (const text of ['History → Events lists every "Settings updated" event', 'is at risk: the next `config update` from your file reverts it. Put its value in your file first', 'The upgrade to dev.89 cannot rebuild a record an earlier upgrade erased']) assert.ok(ops.includes(text), text);
  const brief = read('starter/project/integrations/t3-triage.example.md');
  assert.ok(brief.includes('`mkdir -p -m 700 DIR && mktemp -d DIR/wake.XXXXXX`'));
  assert.ok(brief.includes('use `mktemp -d` alone instead'));
  assert.match(brief, /\*\*If a step fails before `TRIAGE` has run\*\*.*`CLI command STATE --actor orchestrator --operation inbox\.publish --payload '<notice>'`.*"id":"triage-failed-start-/s);
  assert.match(brief, /`--protocol 9\d`/, 'the protocol moves with later releases (90 since dev.90)');
});

test('M3, review of 10cd727: a replan that returns the same plan from a new planner session is not a changed plan; the unchanged candidate is still held', async t => {
  // The reviewer's repro: review revise; the replan returns the same plan with only invocation metadata changed (session, usage, cost, timing, attempt); the builder returns the unchanged candidate.
  const f = await reviewFixture(t);
  const flow = await replanThenBuild(f, planned({ files: ['input.txt'] }, 'planner-session-after-replan'));
  assert.equal(flow.state, 'stopped', 'dev.89 before the review: reached review again'); assert.equal(flow.resumeStep, 'repair');
  assert.match(flow.stopReason, /unchanged reviewed candidate/);
  // What the plan was planned against does count: a new base identity is a changed plan.
  const g = await reviewFixture(t);
  assert.equal((await replanThenBuild(g, planned({ files: ['input.txt'] }, 'planner-session-1', { identity: { head: 'd'.repeat(40), treeDigest: 'e'.repeat(64) } }))).step, 'inspect');
});

import { assembleContext, contextManifest } from '../starter/factory/operations/context.mjs';
test('M3, re-check of 0208a44: a changed governing file the plan\'s scope delivers is a changed plan, though the package digest is the same', async t => {
  // The reviewer's repro: a governing file Git ignores, mapped to input.txt. The planner's context
  // leaves it out (nothing it read matched), but the plan names input.txt, so review and build receive it.
  const RULES = 'RULES.local.md', contextConfig = { files: [{ id: 'local-rules', path: RULES, paths: ['input.txt'] }], maxChars: 4000 };
  const setup = root => { writeFileSync(join(root, '.git', 'info', 'exclude'), `${RULES}\n`); writeFileSync(join(root, RULES), 'Fictional rule: one line per change.\n'); };
  const manifest = root => contextManifest(assembleContext({ repoRoot: root, config: contextConfig }));
  for (const changed of [true, false]) {
    let before;
    const f = await reviewFixture(t, { setup: root => { setup(root); before = manifest(root); } });
    assert.deepEqual(before.omitted, [{ id: 'local-rules', reason: 'path mapping did not match' }]);
    const flow = f.store.need('flow', f.flowId); flow.results.plan = planned({ files: ['input.txt'] }, 'planner-session-1', { contextManifest: before, contextDigest: before.digest }); f.store.put('flow', flow);
    // After the revise, the rule changes (or not); Git ignores it, so the candidate is unchanged.
    if (changed) writeFileSync(join(f.root, RULES), 'Fictional rule: every change needs a changelog line.\n');
    const after = manifest(f.root);
    assert.equal(after.digest, before.digest, 'the package digest does not see the omitted file');
    assert.equal(after.entries['local-rules'].digest !== before.entries['local-rules'].digest, changed);
    // The replan returns the same report, under the manifest it was made with.
    const result = await replanThenBuild(f, planned({ files: ['input.txt'] }, 'planner-session-2', { contextManifest: after, contextDigest: after.digest }));
    if (changed) assert.equal(result.step, 'inspect', '0208a44: stopped instead of reviewed under the changed rules');
    else { assert.equal(result.state, 'stopped', 'the same rules and the same report: still held'); assert.match(result.stopReason, /unchanged reviewed candidate/); }
  }
});
