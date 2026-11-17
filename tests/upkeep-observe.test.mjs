// Knowledge upkeep, slice 2: the deterministic observe-only job and its scheduling (design
// sections 4.5, 5, 8.5 and the slice 2 acceptance of section 15). Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scriptedModel, upkeepProject, UPKEEP, write } from './upkeep-fixtures.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { drainReasons } from '../starter/factory/operations/upgrade-apply.mjs';
import { pendingVerification } from '../starter/factory/operations/merge-hold.mjs';
import { isUpkeepFlow } from '../starter/factory/core/upkeep-config.mjs';
import { UPKEEP_PENDING_MS, hasUpkeepWork, upkeepDay, upkeepDayId, upkeepSuspended, upkeepWindow, upkeepWork, upkeepWorkRuns } from '../starter/factory/operations/upkeep-records.mjs';

const MINUTE = 60000, HOUR = 3600000, DAY = 86400000;
const unfinished = flow => !['completed', 'failed'].includes(flow.state);
const delegated = (f, operation, payload) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation, payload, onBehalfOf: { principal: 'operator', instruction: 'Fictional operator instruction' } });
const nothingWritten = f => { for (const kind of ['finding', 'upkeepObserved', 'learningUse']) assert.equal(f.store.count(kind), 0, kind); assert.equal(f.store.all('task').filter(task => task.id.toLowerCase().startsWith('upkeep:') || task.upkeep !== undefined).length, 0, 'no upkeep task'); };

// ---- 5.1: the receipt and its conversion ----
test('a merged flow gets exactly one run: the receipt at merge settlement, the job when its retrospective is recorded', async t => {
  const f = upkeepProject(t), merged = await f.merge('a');
  // Written in the transaction that settled the merge: pending, with the merge commit, the integrated base and the target.
  const receipt = f.run(merged.flowId);
  assert.deepEqual({ status: receipt.status, mergeCommit: receipt.mergeCommit, base: receipt.base, target: receipt.target, taskId: receipt.taskId }, { status: 'pending', mergeCommit: merged.sha, base: merged.base, target: 'main', taskId: 'a' });
  assert.equal(Date.parse(receipt.pendingUntil) - Date.parse(receipt.mergedAt), UPKEEP_PENDING_MS); assert.equal(receipt.runBy, undefined);
  assert.deepEqual(upkeepWork(f.store), { pending: 1, queued: 0, running: 0 }); assert.equal(f.jobs().length, 0, 'no job before the retrospective exists');
  // A replayed settlement writes nothing more.
  f.engine.settle(merged.flowId, merged.attempt, { version: 1, attemptId: merged.attempt.id, intentDigest: merged.attempt.intentDigest, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: { route: 'merged', merged: true, sha: merged.sha } });
  assert.equal(f.store.count('upkeepRun'), 1); assert.deepEqual(f.run(merged.flowId), receipt);
  // A tick before the flow has finished leaves it pending.
  await f.tick(); assert.equal(f.run(merged.flowId).status, 'pending');
  await f.finish(merged.flowId); assert.equal(f.flow(merged.flowId).state, 'completed');
  const queued = f.run(merged.flowId), [job] = f.jobs();
  assert.equal(queued.status, 'queued'); assert.equal(f.jobs().length, 1); assert.equal(queued.jobId, job.id); assert.equal(queued.pendingUntil, receipt.pendingUntil);
  assert.equal(Date.parse(queued.runBy) - Date.parse(queued.firstQueuedAt), DAY, 'runBy: the configured queue age after it was first queued');
  assert.deepEqual({ operation: job.operation, payload: job.payload, status: job.status, grant: job.grant }, { operation: 'knowledge.upkeep', payload: { flowId: merged.flowId }, status: 'queued', grant: { actor: 'operator', source: 'configuration', policy: 'upkeep.mode', note: job.grant.note, configDigest: f.store.meta('configDigest') } });
  assert.deepEqual(upkeepWork(f.store), { pending: 0, queued: 1, running: 0 });
  // Recording the retrospective again (a re-record, the retrospective job) queues nothing more.
  const { recordRetrospective } = await import('../starter/factory/operations/governance.mjs'); recordRetrospective(f.store, { flowId: merged.flowId });
  assert.equal(f.jobs().length, 1);
  const done = await f.assess();
  assert.equal(done.run.status, 'closed'); assert.equal(done.run.runs, 1); assert.equal(f.store.count('upkeepRun'), 1); assert.equal(f.jobs().length, 1); assert.equal(f.store.need('job', job.id).status, 'completed');
  assert.equal(hasUpkeepWork(f.store), false);
  // The upkeep flow is itself a maintenance flow: it gets no receipt, and its completion is quiet.
  assert.equal(f.run(done.flowId), undefined); assert.equal(f.store.all('inbox').filter(item => item.flowId === done.flowId).length, 0);
  await f.tick(); assert.equal(f.upkeepFlows().length, 1, 'nothing runs a second time');
});

test('a merged flow that then fails at a post-merge step still gets one run', async t => {
  const f = upkeepProject(t); f.failPost();
  const merged = await f.merge('a'); await f.finish(merged.flowId);
  assert.equal(f.flow(merged.flowId).state, 'failed'); assert.equal(f.flow(merged.flowId).results.merge.merged, true);
  assert.equal(f.run(merged.flowId).status, 'queued'); assert.equal(f.jobs().length, 1);
  const done = await f.assess(); assert.equal(done.run.status, 'closed'); assert.equal(f.store.count('upkeepRun'), 1); assert.equal(f.jobs().length, 1);
});

test('a merged flow that is stopped at a post-merge step still gets one run, and resuming it adds none', async t => {
  const f = upkeepProject(t), merged = await f.merge('a');
  assert.equal(f.flow(merged.flowId).step, 'post');
  assert.equal(f.command('stop', { flowId: merged.flowId, note: 'Fictional stop after the merge' }).status, 'completed');
  assert.equal(f.flow(merged.flowId).state, 'stopped'); assert.equal(f.run(merged.flowId).status, 'queued'); assert.equal(f.jobs().length, 1);
  const done = await f.assess(); assert.equal(done.run.status, 'closed');
  assert.equal(f.command('resume', { flowId: merged.flowId, note: 'Carry on' }).status, 'completed'); await f.finish(merged.flowId);
  assert.equal(f.flow(merged.flowId).state, 'completed'); assert.equal(f.jobs().length, 1, 'the later retrospective queues nothing'); assert.equal(f.run(merged.flowId).status, 'closed'); assert.equal(f.store.count('upkeepRun'), 1);
  await f.tick(); assert.equal(f.upkeepFlows().length, 1);
});

test('unmerged, task, maintenance, rehearsal and upkeep-origin flows get no run, and neither does anything with upkeep off', async t => {
  const f = upkeepProject(t);
  // A merge step that did not prove a merge.
  const stale = await f.mergedAndFinished('unmerged', undefined, { merged: false });
  // A task flow and a flow that is neither a change nor a document.
  const taskFlow = await f.mergedAndFinished('task-kind', undefined, { patch: flow => { flow.kind = 'task'; } });
  const rehearsal = await f.mergedAndFinished('rehearsal-kind', undefined, { patch: flow => { flow.kind = 'rehearsal'; } });
  // A flow whose task carries the factory's marker: upkeep does not assess its own work (7.7).
  const origin = await f.mergedAndFinished('upkeep-origin', undefined, { patch: flow => { flow.taskSnapshot = { ...flow.taskSnapshot, upkeep: { kind: 'docs' } }; } });
  for (const merged of [stale, taskFlow, rehearsal, origin]) { assert.equal(f.run(merged.flowId), undefined, merged.flowId); assert.ok(f.store.get('retrospective', merged.flowId), 'its retrospective was recorded all the same'); }
  assert.equal(f.store.count('upkeepRun'), 0); assert.equal(f.jobs().length, 0); assert.equal(f.store.meta('upkeepWork'), undefined);
  // A document flow is a change flow in the document pool: it does get one.
  const document = await f.merge('document', undefined, { patch: flow => { flow.pool = 'document'; } }); assert.equal(f.run(document.flowId).status, 'pending');
  assert.equal(f.store.count('upkeepRun'), 1);
  // A maintenance flow that ends: no receipt for it, whatever it ran.
  await f.finish(document.flowId); const done = await f.assess(); assert.equal(f.run(done.flowId), undefined); assert.equal(f.store.count('upkeepRun'), 1);
  // Upkeep off, by mode and by an absent block: nothing is written at all.
  for (const upkeep of [{ ...UPKEEP, mode: 'off' }, null]) {
    const off = upkeepProject(t, { upkeep }), merged = await off.mergedAndFinished('a');
    assert.equal(off.flow(merged.flowId).state, 'completed'); assert.equal(off.store.count('upkeepRun'), 0); assert.equal(off.store.meta('upkeepWork'), undefined); assert.equal(off.jobs().length, 0);
    await off.tick(); assert.equal(off.upkeepFlows().length, 0);
  }
});

// ---- 8.5 and 12: what a run records, and what observe mode never writes ----
test('observe mode records the outcome, the stage, the reason and bounded counters, and writes no candidate or task', async t => {
  const f = upkeepProject(t);
  // README.md names src/api/users.js, which this merge changes: the pre-filter finds a referring doc,
  // and the model (scripted here) is asked once and answers that nothing is needed.
  const merged = await f.mergedAndFinished('a'), done = await f.assess();
  assert.equal(done.outcome.providerInvocations.length, 1, 'the result always carries the list: one invocation');
  assert.deepEqual({ status: done.run.status, outcome: done.run.outcome, reason: done.run.reason, stage: done.run.stage, flags: done.run.flags }, { status: 'closed', outcome: 'nothing', reason: 'no-candidate', stage: 'model', flags: [] });
  const { inputChars, evidenceItems, ...counts } = done.run.counts; assert.ok(inputChars > 0 && inputChars <= 40000 && evidenceItems > 0);
  assert.deepEqual(counts, { touchedPaths: 1, docsFiles: 3, docCandidates: 1, contextCandidates: 0, verifiedSignals: 0, weakSignals: 0, filesRead: 4, filesShown: 1, filesTruncated: 0, docs: 0, context: 0, capture: 0, dropped: 0, flagged: 0 });
  // A merge that touches nothing any doc or rule names, on a clean flow: nothing, with no model needed.
  const quiet = await f.mergedAndFinished('b', root => write(root, { 'src/new-module.js': 'export {};\n' })), second = await f.assess();
  assert.deepEqual(second.outcome.providerInvocations, [], 'empty means no invocation');
  assert.deepEqual({ outcome: second.run.outcome, reason: second.run.reason, flags: second.run.flags }, { outcome: 'nothing', reason: 'no-referring-doc', flags: ['no-signal'] });
  // Bounded counters and enums only; the day and the window count each closed run.
  const day = upkeepDay(f.store, upkeepDayId());
  assert.deepEqual(day.outcomes, { 'nothing:no-candidate': 1, 'nothing:no-referring-doc': 1 }); assert.deepEqual([day.modelRunsReserved, day.modelRunsSettled, day.tasksCreated, day.invocations, day.upkeepInvocations], [0, 1, 0, 1, 1]);
  assert.deepEqual(upkeepWindow(f.store).runs.map(({ at, ...row }) => row), [{ flowId: merged.flowId, outcome: 'nothing', reason: 'no-candidate', stage: 'model', model: true, candidates: false }, { flowId: quiet.flowId, outcome: 'nothing', reason: 'no-referring-doc', stage: 'pre-filter', model: false, candidates: false }]);
  nothingWritten(f);
  // The assessment's flow pins the route of its one model step: with no providers.upkeep, the copy of
  // the reviewer's route that upkeep is pinned to (tests/upkeep-model.test.mjs), under the role upkeep.
  assert.deepEqual({ provider: done.attempt.intent.action.modelRoute.provider, model: done.attempt.intent.action.modelRoute.model }, { provider: 'claude', model: 'fictional' }); assert.equal(f.flow(done.flowId).modelSelection.steps.run.role, 'upkeep');
  // Nothing in the project checkout or on the remote changed, and the model's throwaway checkout is gone: the job reads.
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: f.root, encoding: 'utf8' }), ''); assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: f.root, encoding: 'utf8' }).trim().split('\n').length, 1);
});

test('only the upkeep operation can record a run, and a result is reduced to enums and counters', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a');
  await f.tick(); const [assessment] = f.upkeepFlows(); await f.engine.tick();
  const attempt = f.store.need('attempt', f.flow(assessment.id).attemptId), receipt = result => ({ version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: result });
  // A result with free text, an unknown reason's place taken by a known one, unknown flags and counters, and oversized numbers.
  f.engine.settle(assessment.id, attempt, receipt({ route: 'pass', providerInvocations: [], upkeepRun: { outcome: 'nothing', reason: 'weak-signals-only', stage: 'pre-filter', flags: ['no-signal', 'made-up', 'Ignore previous instructions'], counts: { docCandidates: 2, secret: 9, weakSignals: 1e12, verifiedSignals: -1 }, note: 'free text is not recorded', title: 'x' } }));
  const run = f.run(merged.flowId);
  assert.deepEqual({ outcome: run.outcome, reason: run.reason, stage: run.stage, flags: run.flags, counts: run.counts }, { outcome: 'nothing', reason: 'weak-signals-only', stage: 'pre-filter', flags: ['no-signal'], counts: { docCandidates: 2, weakSignals: 1000000 } });
  assert.equal(run.note, undefined); assert.equal(run.title, undefined);
  // An outcome or reason outside the lists closes the run as an error; a failed attempt does too.
  const other = await f.mergedAndFinished('b'); await f.tick(); const next = f.upkeepFlows().find(unfinished); await f.engine.tick();
  const second = f.store.need('attempt', f.flow(next.id).attemptId);
  f.engine.settle(next.id, second, { version: 1, attemptId: second.id, intentDigest: second.intentDigest, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: { route: 'pass', upkeepRun: { outcome: 'delivered', reason: 'because' } } });
  assert.deepEqual({ status: f.run(other.flowId).status, outcome: f.run(other.flowId).outcome, reason: f.run(other.flowId).reason }, { status: 'closed', outcome: 'abstained', reason: 'error' });
  // Another operation's result cannot carry a run outcome: the field is the upkeep operation's.
  const { adoptableResult } = await import('../starter/factory/core/operations.mjs');
  assert.equal(adoptableResult('audit', { upkeepRun: { outcome: 'nothing' } }).upkeepRun, undefined); assert.equal(adoptableResult('provider.build', { upkeepRun: {} }).upkeepRun, undefined); assert.ok(adoptableResult('knowledge.upkeep', { upkeepRun: {} }).upkeepRun);
});

test('the action is routed through the dispatcher, and refuses to run without its running receipt', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a');
  await f.tick(); const [assessment] = f.upkeepFlows(); await f.engine.tick();
  const attempt = f.store.need('attempt', f.flow(assessment.id).attemptId), providerInvoke = scriptedModel();
  // The delivery path only adds the forge's Git credentials around the same call. The model is scripted: no provider starts.
  const result = await runAction({ ...attempt.intent, action: { ...attempt.intent.action, config: { ...attempt.intent.action.config, mode: 'rehearsal' } } }, { providerInvoke });
  assert.equal(result.route, 'pass'); assert.equal(result.upkeepRun.reason, 'no-candidate'); assert.equal(result.upkeepRun.mergeCommit, merged.sha); assert.equal(providerInvoke.calls.length, 1);
  await assert.rejects(runAction({ ...attempt.intent, action: { ...attempt.intent.action, config: { mode: 'rehearsal' }, jobPayload: { flowId: 'no-such-flow' } } }, { providerInvoke }), /no running upkeep run/);
});

// ---- 4.5: the idle tick ----
const BASELINE = '283ba91';
async function baselineRuntime(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fct-upkeep-baseline-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  try { execFileSync('sh', ['-c', `git archive ${BASELINE} starter | tar -x -C "$1"`, 'sh', dir], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' }); }
  catch (error) { return { skip: `the baseline runtime ${BASELINE} is not in this checkout's git history (${String(error.stderr || error.message).trim().split('\n')[0]})` }; }
  const load = path => import(pathToFileURL(join(dir, 'starter/factory', path)).href);
  return { Store: (await load('core/store.mjs')).Store, operationalTick: (await load('workflows/maintenance.mjs')).operationalTick };
}
// Every statement a connection runs, with its bound values.
function statements(store) {
  let seen = []; const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { const statement = prepare(sql); for (const name of ['all', 'get', 'run']) { const call = statement[name].bind(statement); statement[name] = (...args) => { seen.push({ sql, args }); return call(...args); }; } return statement; };
  return { take() { const taken = seen; seen = []; return taken; }, restore() { store.db.prepare = prepare; } };
}
const metaReads = (taken, key) => taken.filter(row => /^\s*SELECT value FROM meta WHERE key=\?/i.test(row.sql) && (key === undefined || row.args[0] === key));
const keyed = taken => taken.map(row => `${row.sql} :: ${JSON.stringify(row.args)}`).sort();
// A `git`, `codex` and `claude` first on PATH that log each start and then run the real one.
function processLog(t, f) {
  const bin = join(f.base, 'logged-bin'), log = join(f.base, 'processes.log'), was = process.env.PATH; mkdirSync(bin);
  for (const name of ['git', 'codex', 'claude']) { const real = name === 'git' ? execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim() : '/bin/false'; writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(log)}\nexec ${real} "$@"\n`); chmodSync(join(bin, name), 0o755); }
  process.env.PATH = `${bin}:${was}`; t.after(() => { process.env.PATH = was; });
  return { take() { const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []; rmSync(log, { force: true }); return lines; } };
}

test('a tick with no upkeep work adds exactly one meta read and starts no Git or provider process for upkeep', async t => {
  const f = upkeepProject(t), probe = statements(f.store), processes = processLog(t, f);
  // A project that has used upkeep and has nothing in hand, and holds an ordinary queued task.
  const merged = await f.mergedAndFinished('a'); await f.assess(); assert.equal(hasUpkeepWork(f.store), false); assert.equal(f.run(merged.flowId).status, 'closed');
  await f.tick(); probe.take(); processes.take();
  await f.tick(); const idle = probe.take(), idleProcesses = processes.take();
  // Exactly one read of the upkeepWork meta row, and nothing else of upkeep's: no run, day, window or
  // suspension row, no open-count or suspension meta row, no job or flow read on upkeep's account.
  assert.equal(metaReads(idle, 'upkeepWork').length, 1);
  assert.deepEqual(idle.filter(row => /upkeep/i.test(`${row.sql} ${JSON.stringify(row.args)}`)).map(row => row.args), [['upkeepWork']]);
  assert.deepEqual(idle.filter(row => row.args.some(value => ['upkeepRun', 'upkeepDay', 'upkeepWindow', 'upkeepObserved', 'learningUse', 'finding', 'retrospective'].includes(value))), []);
  assert.deepEqual(idleProcesses.filter(line => /^(codex|claude) /.test(line)), [], 'no provider process');
  // The same with the block absent and with the mode off: the read does not depend on the setting.
  for (const upkeep of [null, { ...UPKEEP, mode: 'off' }]) {
    const other = upkeepProject(t, { upkeep }), watch = statements(other.store);
    await other.tick(); watch.take(); await other.tick(); const taken = watch.take();
    assert.equal(metaReads(taken, 'upkeepWork').length, 1); assert.deepEqual(taken.filter(row => /upkeep/i.test(`${row.sql} ${JSON.stringify(row.args)}`)).map(row => row.args), [['upkeepWork']]);
  }
  // Against the runtime before this change, on this same state: every statement it ran is run
  // again, and the only addition is that one meta read. The Git processes are the same, too.
  const base = await baselineRuntime(t); if (base.skip) return t.diagnostic(`absolute counts checked; ${base.skip}`);
  const old = new base.Store(f.stateDir); t.after(() => old.close());
  const before = statements(old);
  await base.operationalTick(old); before.take(); processes.take();
  await base.operationalTick(old); const baseline = before.take(), baselineProcesses = processes.take();
  await f.tick(); probe.take(); processes.take();
  await f.tick(); const now = probe.take(), nowProcesses = processes.take();
  const added = keyed(now), earlier = keyed(baseline);
  for (const row of earlier) { const at = added.indexOf(row); assert.notEqual(at, -1, `the tick no longer runs: ${row}`); added.splice(at, 1); }
  assert.deepEqual(added, ['SELECT value FROM meta WHERE key=? :: ["upkeepWork"]'], 'exactly one statement was added to an idle tick');
  assert.deepEqual(nowProcesses, baselineProcesses, 'an idle tick starts the Git processes it started before, and no other');
  t.diagnostic(`idle tick: ${baseline.length} statements before, ${now.length} now; ${nowProcesses.length} Git processes either way`);
});

test('with upkeep work in hand every read is by key, and settled history changes none of it', async t => {
  const f = upkeepProject(t), probe = statements(f.store);
  const merged = await f.mergedAndFinished('a'); f.store.setMeta('paused', true);
  // What a tick reads on upkeep's account: the meta row, and records by the ids that row names.
  const UPKEEP_READS = ['upkeepWork', 'upkeepOpen', 'upkeepSuspended', 'upkeepRun', 'upkeepDay', 'upkeepWindow', 'upkeepObserved', 'retrospective', 'job', 'finding'];
  const measure = async () => { await f.tick(); probe.take(); await f.tick(); return probe.take().filter(row => /^\s*SELECT/i.test(row.sql) && (UPKEEP_READS.includes(row.args[0]) || /upkeep|retrospective|finding/i.test(row.sql))); };
  const small = await measure();
  // Thousands of settled runs, flows, jobs and findings: none of them is in hand.
  const put = f.store.db.prepare('INSERT INTO records VALUES(?,?,?)'); f.store.db.exec('BEGIN');
  for (let i = 0; i < 3000; i++) { put.run('upkeepRun', `old-flow-${i}`, JSON.stringify({ id: `old-flow-${i}`, status: 'closed', outcome: 'nothing', reason: 'no-referring-doc', pendingUntil: new Date(0).toISOString() })); put.run('flow', `old-flow-${i}`, JSON.stringify({ id: `old-flow-${i}`, taskId: `old-${i}`, kind: 'change', state: 'completed', createdAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString() })); put.run('job', `old-job-${i}`, JSON.stringify({ id: `old-job-${i}`, operation: 'knowledge.upkeep', status: 'completed', payload: { flowId: `old-flow-${i}` }, createdAt: new Date(0).toISOString() })); put.run('finding', `old-finding-${i}`, JSON.stringify({ id: `old-finding-${i}`, status: 'declined', source: 'upkeep' })); }
  f.store.db.exec('COMMIT');
  const large = await measure();
  assert.deepEqual(keyed(large), keyed(small), 'the same statements with the same values');
  const upkeepReads = large.filter(row => /\bFROM records\b/.test(row.sql) && row.args.some(value => ['upkeepRun', 'retrospective'].includes(value)));
  assert.ok(upkeepReads.length > 0); for (const row of upkeepReads) assert.match(row.sql, /WHERE kind=\? AND id=\?/, row.sql);
  assert.deepEqual(upkeepReads.map(row => row.args[1]), [merged.flowId], 'only the run in hand is read');
  // No upkeep module reads a whole kind, looks up by an undeclared field or filters records.data with JSON.
  const factory = new URL('../starter/factory/', import.meta.url);
  const QUIET = ['core/upkeep-config.mjs', 'core/line-diff.mjs', 'core/globs.mjs', 'operations/upkeep-runs.mjs', 'operations/upkeep-prefilter.mjs', 'operations/upkeep-budget.mjs', 'operations/upkeep-assessment.mjs', 'operations/upkeep-confusables.mjs', 'operations/upkeep-evidence.mjs'];
  for (const file of [...QUIET, 'workflows/upkeep-assess.mjs']) {
    const source = readFileSync(new URL(file, factory), 'utf8');
    assert.doesNotMatch(source, /store\.(all|stored|recent|live|by|events|count)\(|json_extract|json_each|->>|FROM events/, file);
    assert.doesNotMatch(source, /store\.put\('(task|finding)'/, `${file} writes no task or candidate`);
  }
  // Only the assessment step, which runs in its own attempt, reaches a provider.
  for (const file of QUIET) assert.doesNotMatch(readFileSync(new URL(file, factory), 'utf8'), /adapters\/providers|providerInvoke|invoke\(|child_process|import\(|adapters\//, `${file}, which the tick, the engine and the commands call, reaches no provider and can start no process`);
});

// ---- 5.2: the lane ----
test('main.verify and target.sync are never delayed by upkeep: queued before or after an upkeep job has started, they start in the same tick', async t => {
  const enqueueVerify = f => f.command('job.enqueue', { operation: 'main.verify', note: 'Fictional verification' }).result;
  const maintenanceFlow = (f, job) => f.store.get('flow', `maintenance:${job.id}`);
  // Queued after an upkeep job has started (its flow is unfinished).
  const after = upkeepProject(t); await after.mergedAndFinished('a'); await after.tick();
  const [running] = after.upkeepFlows(); assert.ok(unfinished(running)); assert.equal(after.run('flow-a').status, 'running');
  const verify = enqueueVerify(after); await after.tick();
  assert.ok(maintenanceFlow(after, verify), 'main.verify was admitted while the upkeep flow was unfinished'); assert.equal(after.store.need('job', verify.id).status, 'running'); assert.ok(unfinished(after.flow(running.id)));
  assert.equal(pendingVerification(after.store, 'main').blocked, undefined);
  // Queued before the upkeep job starts, with the upkeep job older in the queue: both start in one tick.
  const before = upkeepProject(t); await before.mergedAndFinished('a'); const [upkeepJob] = before.jobs(), queuedVerify = enqueueVerify(before);
  assert.deepEqual(before.store.live('job').filter(job => job.status === 'queued').map(job => job.id), [upkeepJob.id, queuedVerify.id], 'the upkeep job is first in the queue');
  await before.tick();
  assert.equal(before.store.need('job', queuedVerify.id).status, 'running', 'main.verify started in the first tick'); assert.equal(before.store.need('job', upkeepJob.id).status, 'running', 'so did the upkeep job, in its own lane');
  // A target.sync queued after an upkeep job has started.
  const sync = upkeepProject(t); await sync.mergedAndFinished('a'); await sync.tick(); assert.equal(sync.upkeepFlows().filter(unfinished).length, 1);
  sync.store.put('job', { id: 'sync-1', operation: 'target.sync', payload: { from: 'main', into: 'next' }, grant: { actor: 'operator', note: 'Fictional sync', configDigest: sync.store.meta('configDigest') }, status: 'queued', createdAt: new Date().toISOString() });
  await sync.tick(); assert.equal(sync.store.need('job', 'sync-1').status, 'running');
  // A stopped upkeep flow is not the occupant that keeps a queued verification from starting.
  const stopped = upkeepProject(t); await stopped.mergedAndFinished('a'); await stopped.tick(); const [flow] = stopped.upkeepFlows();
  stopped.store.put('flow', { ...stopped.flow(flow.id), state: 'stopped', stopRequested: true, attemptId: 'pretend-unsettled' });
  const waiting = enqueueVerify(stopped); assert.equal(pendingVerification(stopped.store, 'main').blocked, undefined, 'the upkeep flow does not hold the built-in lane');
  await stopped.tick(); assert.equal(stopped.store.need('job', waiting.id).status, 'running');
  // And the other way round: a running verification does not hold the upkeep lane, which runs one flow at a time.
  const lanes = upkeepProject(t); const held = enqueueVerify(lanes); await lanes.tick(); assert.equal(lanes.store.need('job', held.id).status, 'running');
  await lanes.mergedAndFinished('a'); await lanes.mergedAndFinished('b'); assert.equal(lanes.jobs().length, 2);
  await lanes.tick(); assert.equal(lanes.upkeepFlows().filter(unfinished).length, 1, 'one upkeep flow at a time'); assert.deepEqual(upkeepWork(lanes.store), { pending: 0, queued: 1, running: 1 });
  await lanes.tick(); assert.equal(lanes.upkeepFlows().length, 1);
  // The upkeep flow takes no flow slot and no heavy-work permit.
  const { slots } = await import('../starter/factory/operations/capacity.mjs'), pool = slots(lanes.store).pools.change;
  assert.equal(pool.held, 0); assert.equal(lanes.upkeepFlows()[0].workflow.nodes.run.heavy, undefined);
});

// ---- 5.3: deadlines ----
test('a receipt taken through repeated configuration changes across runBy is closed at the deadline and never runs; a larger configured age does not revive it', async t => {
  const f = upkeepProject(t, { upkeep: { ...UPKEEP, budget: { maxQueueAgeMs: HOUR } } }), merged = await f.mergedAndFinished('a');
  const first = f.run(merged.flowId), T = Date.parse(first.firstQueuedAt), runBy = first.runBy; assert.equal(Date.parse(runBy), T + HOUR);
  const pause = paused => f.store.setMeta('paused', paused), reconfigure = change => f.commission(change(structuredClone(f.store.meta('config'))));
  let at = T, seenJobs = new Set([first.jobId]);
  for (let round = 1; round <= 3; round++) {
    // The configuration changes while the job waits: its grant names the old digest, so it is revoked.
    reconfigure(config => { config.context.maxChars += round; return config; });
    pause(false); await f.tick({ nowMs: at += 5 * MINUTE }); pause(true);
    assert.equal(f.store.need('job', f.run(merged.flowId).jobId).status, 'revoked', `round ${round}`); assert.equal(f.upkeepFlows().length, 0);
    // Its receipt returns to pending and is queued again under the new configuration, with the same deadline.
    await f.tick({ nowMs: at += 5 * MINUTE });
    const run = f.run(merged.flowId); assert.equal(run.status, 'queued'); assert.equal(run.queues, round + 1); assert.equal(run.runBy, runBy, 'runBy is never moved'); assert.equal(run.pendingUntil, first.pendingUntil);
    assert.ok(!seenJobs.has(run.jobId)); seenJobs.add(run.jobId); assert.equal(f.store.need('job', run.jobId).grant.configDigest, f.store.meta('configDigest'));
  }
  // A larger configured age, before the deadline: the deadline stays where it was first set.
  reconfigure(config => { config.upkeep.budget.maxQueueAgeMs = DAY; return config; });
  pause(false); await f.tick({ nowMs: at += 5 * MINUTE }); pause(true); await f.tick({ nowMs: at += 5 * MINUTE });
  assert.equal(f.run(merged.flowId).status, 'queued'); assert.equal(f.run(merged.flowId).runBy, runBy); assert.ok(at < T + HOUR);
  // It really was queued again under the larger age: a new job with the current digest, and no tick
  // that failed and rolled back (which would also leave the status and the deadline as they were).
  const requeued = f.run(merged.flowId); assert.equal(requeued.queues, 5); assert.ok(!seenJobs.has(requeued.jobId));
  assert.deepEqual({ status: f.store.need('job', requeued.jobId).status, digest: f.store.need('job', requeued.jobId).grant.configDigest }, { status: 'queued', digest: f.store.meta('configDigest') });
  assert.equal(f.store.events(500).filter(event => event.type === 'upkeep.tick-failed').length, 0);
  // At the deadline it is closed, its job revoked; it never ran.
  await f.tick({ nowMs: T + HOUR });
  const closed = f.run(merged.flowId);
  assert.deepEqual({ status: closed.status, outcome: closed.outcome, reason: closed.reason, stage: closed.stage, runs: closed.runs, runBy: closed.runBy }, { status: 'closed', outcome: 'abstained', reason: 'stale-run', stage: 'queue', runs: 0, runBy });
  assert.equal(f.store.need('job', closed.jobId).status, 'revoked'); assert.equal(hasUpkeepWork(f.store), false);
  // Nothing revives it: not an open project, not more configuration changes, not a larger age, not a run by hand.
  pause(false);
  for (const nowMs of [T + HOUR + MINUTE, T + 2 * HOUR]) { reconfigure(config => { config.context.maxChars += 100; return config; }); await f.tick({ nowMs }); await f.tick({ nowMs }); }
  assert.equal(f.upkeepFlows().length, 0, 'no upkeep flow was ever admitted'); assert.equal(f.run(merged.flowId).status, 'closed'); assert.equal(f.jobs().every(job => job.status === 'revoked'), true);
  const { enqueueManualUpkeepInTransaction } = await import('../starter/factory/operations/upkeep-runs.mjs');
  assert.throws(() => f.store.tx(() => enqueueManualUpkeepInTransaction(f.store, { flowId: merged.flowId, grant: { actor: 'operator', note: 'Try again' }, nowMs: T + 2 * HOUR })), /passed its run-by deadline .* a deadline is never moved later/);
  assert.equal(f.run(merged.flowId).status, 'closed'); assert.equal(f.run(merged.flowId).runBy, runBy);
  assert.deepEqual(upkeepDay(f.store, upkeepDayId(T + HOUR)).outcomes, { 'abstained:stale-run': 1 });
});

test('a smaller configured age shortens runBy for a run that has not started, and a run is refused at its start when the deadline passed', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a'), first = f.run(merged.flowId), T = Date.parse(first.firstQueuedAt);
  f.store.setMeta('paused', true);
  const config = structuredClone(f.store.meta('config')); config.upkeep.budget = { maxQueueAgeMs: HOUR }; f.store.setMeta('config', config);
  await f.tick({ nowMs: T + MINUTE }); assert.equal(Date.parse(f.run(merged.flowId).runBy), T + HOUR, 'shortened to the smaller age, counted from when it was first queued');
  // Raising it again does not move the deadline back.
  config.upkeep.budget = { maxQueueAgeMs: DAY }; f.store.setMeta('config', config);
  await f.tick({ nowMs: T + 2 * MINUTE }); assert.equal(Date.parse(f.run(merged.flowId).runBy), T + HOUR);
  f.store.setMeta('paused', false); await f.tick({ nowMs: T + HOUR + 1 });
  assert.equal(f.run(merged.flowId).reason, 'stale-run'); assert.equal(f.upkeepFlows().length, 0);
  // The start itself checks the deadline, in the transaction that would admit the flow.
  const { startUpkeepRunInTransaction } = await import('../starter/factory/operations/upkeep-runs.mjs');
  const other = await f.mergedAndFinished('b'), queued = f.run(other.flowId), job = f.store.need('job', queued.jobId);
  const refused = f.store.tx(() => startUpkeepRunInTransaction(f.store, job, { id: 'maintenance:x' }, { nowMs: Date.parse(queued.runBy) }));
  assert.match(refused, /run-by deadline/); assert.equal(f.run(other.flowId).reason, 'stale-run'); assert.equal(f.run(other.flowId).stage, 'start');
});

test('a receipt whose retrospective never arrives is closed after seven days; turning the mode off closes what is in hand', async t => {
  const f = upkeepProject(t), merged = await f.merge('a'), receipt = f.run(merged.flowId), mergedAt = Date.parse(receipt.mergedAt);
  // The flow sits at its post-merge step: no retrospective, so nothing is queued.
  await f.tick({ nowMs: mergedAt + 7 * DAY - 1 }); assert.equal(f.run(merged.flowId).status, 'pending'); assert.equal(f.jobs().length, 0);
  await f.tick({ nowMs: mergedAt + 7 * DAY });
  assert.deepEqual({ status: f.run(merged.flowId).status, outcome: f.run(merged.flowId).outcome, reason: f.run(merged.flowId).reason, stage: f.run(merged.flowId).stage }, { status: 'closed', outcome: 'abstained', reason: 'no-retrospective', stage: 'receipt' });
  // The flow finishing later queues nothing, and a run by hand is refused: the deadline is not moved.
  await f.finish(merged.flowId); assert.equal(f.jobs().length, 0); assert.equal(f.run(merged.flowId).pendingUntil, receipt.pendingUntil);
  const { enqueueManualUpkeepInTransaction } = await import('../starter/factory/operations/upkeep-runs.mjs');
  assert.throws(() => f.store.tx(() => enqueueManualUpkeepInTransaction(f.store, { flowId: merged.flowId, grant: { actor: 'operator', note: 'Late' }, nowMs: mergedAt + 8 * DAY })), /passed its pending deadline .* a deadline is never moved later/);
  assert.equal(f.run(merged.flowId).status, 'closed');
  // Mode off: a pending receipt and a queued run are both closed, and the queued job is revoked.
  const queued = await f.mergedAndFinished('c'), pending = await f.merge('b'); assert.equal(f.run(pending.flowId).status, 'pending'); assert.equal(f.run(queued.flowId).status, 'queued');
  assert.equal(delegated(f, 'settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Kill switch' }).status, 'completed');
  await f.tick();
  for (const id of [pending.flowId, queued.flowId]) assert.deepEqual({ status: f.run(id).status, reason: f.run(id).reason }, { status: 'closed', reason: 'mode-off' }, id);
  assert.equal(f.store.need('job', f.run(queued.flowId).jobId).status, 'revoked'); assert.equal(f.upkeepFlows().length, 0); assert.equal(hasUpkeepWork(f.store), false);
  // Turning it on again revives neither; a later merge is assessed as usual.
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On again' }).status, 'completed');
  await f.finish(pending.flowId); await f.tick(); assert.equal(f.upkeepFlows().length, 0); assert.equal(f.jobs().filter(job => job.status === 'queued').length, 0);
  await f.mergedAndFinished('d', root => write(root, { 'src/api/users.js': 'export const users = [4];\n' })); const done = await f.assess(); assert.equal(done.run.status, 'closed'); assert.equal(done.run.reason, 'no-candidate');
});

test('a deadline shortened while a receipt is pending under a drain hold stays shortened: a larger age later does not restore it', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a'), first = f.run(merged.flowId), T = Date.parse(first.firstQueuedAt);
  const reconfigure = change => f.commission(change(structuredClone(f.store.meta('config')))), age = ms => reconfigure(config => { config.upkeep.budget = { maxQueueAgeMs: ms }; return config; });
  assert.equal(Date.parse(first.runBy), T + DAY);
  // A configuration change revokes its job ...
  reconfigure(config => { config.context.maxChars += 1; return config; }); await f.tick({ nowMs: T + MINUTE });
  assert.equal(f.store.need('job', first.jobId).status, 'revoked'); assert.equal(f.upkeepFlows().length, 0);
  // ... and under a maintenance hold the receipt goes back to pending and is not queued again.
  assert.equal(f.command('pause', { paused: true, holdMaintenance: true, note: 'An upgrade waits for a drain' }).status, 'completed');
  await f.tick({ nowMs: T + 2 * MINUTE }); assert.deepEqual([f.run(merged.flowId).status, f.run(merged.flowId).runBy], ['pending', first.runBy]);
  // The age is lowered to one hour while it waits there: the deadline is shortened, and written.
  age(HOUR); await f.tick({ nowMs: T + 3 * MINUTE });
  assert.deepEqual([f.run(merged.flowId).status, Date.parse(f.run(merged.flowId).runBy)], ['pending', T + HOUR], 'the shorter deadline is persisted under the hold');
  // The age goes back up, the shortened deadline passes, the hold is released: it is closed, not run.
  age(DAY); await f.tick({ nowMs: T + 30 * MINUTE }); assert.equal(Date.parse(f.run(merged.flowId).runBy), T + HOUR, 'a larger age does not restore the longer deadline');
  assert.equal(f.command('pause', { paused: false, note: 'Released' }).status, 'completed');
  await f.tick({ nowMs: T + HOUR + MINUTE }); await f.tick({ nowMs: T + HOUR + 2 * MINUTE });
  const closed = f.run(merged.flowId);
  assert.deepEqual({ status: closed.status, reason: closed.reason, runs: closed.runs, runBy: Date.parse(closed.runBy) }, { status: 'closed', reason: 'stale-run', runs: 0, runBy: T + HOUR });
  assert.equal(f.upkeepFlows().length, 0, 'it never ran');
  // The same for a receipt that is pending because its job was revoked, with no hold at all: the
  // shortening is written by the tick that requeues it.
  const g = upkeepProject(t), other = await g.mergedAndFinished('a'), start = Date.parse(g.run(other.flowId).firstQueuedAt); g.store.setMeta('paused', true);
  const set = ms => { const config = structuredClone(g.store.meta('config')); config.upkeep.budget = { maxQueueAgeMs: ms }; g.store.setMeta('config', config); };
  set(HOUR); await g.tick({ nowMs: start + MINUTE }); set(DAY); await g.tick({ nowMs: start + 2 * MINUTE });
  assert.equal(Date.parse(g.run(other.flowId).runBy), start + HOUR);
});

// ---- 5.3: the drain rule ----
test('a drain is not held by a queued or a running assessment; the receipt returns to pending and keeps its deadline through repeated drains, then closes at it', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a'), first = f.run(merged.flowId), T = Date.parse(first.firstQueuedAt), runBy = first.runBy;
  const hold = on => assert.equal(f.command('pause', { paused: on, ...(on ? { holdMaintenance: true } : {}), note: on ? 'An upgrade waits for a drain' : 'Released' }).status, 'completed');
  // Queued under a drain hold: nothing starts, and nothing of it blocks the drain or a configuration update.
  hold(true); await f.tick({ nowMs: T + MINUTE });
  assert.equal(f.run(merged.flowId).status, 'queued'); assert.equal(f.upkeepFlows().length, 0); assert.deepEqual(drainReasons(f.store), []);
  hold(false);
  let at = T + 2 * MINUTE;
  for (const [round, prepared] of [[1, false], [2, true], [3, true]]) {
    await f.tick({ nowMs: at += MINUTE });
    const flow = f.upkeepFlows().find(unfinished); assert.ok(flow, `round ${round}: the assessment started`); assert.equal(f.run(merged.flowId).status, 'running');
    if (prepared) { await f.engine.tick(); assert.equal(f.store.need('attempt', f.flow(flow.id).attemptId).status, 'prepared'); }
    assert.notDeepEqual(drainReasons(f.store), [], 'an unfinished flow holds up a drain until it is ended');
    // The hold arrives: the running assessment is asked to stop, quietly.
    hold(true); await f.tick({ nowMs: at += MINUTE });
    assert.deepEqual({ state: f.flow(flow.id).state, stopRequested: f.flow(flow.id).stopRequested, abortRequested: f.flow(flow.id).abortRequested }, { state: 'stopped', stopRequested: true, abortRequested: true });
    await f.engine.tick();
    if (prepared) assert.equal(f.store.by('attempt', 'flowId', flow.id).at(-1).status, 'not-dispatched', 'a prepared attempt is never dispatched');
    // Once nothing runs for it, the factory ends the flow; the receipt is pending again, deadline unchanged.
    await f.tick({ nowMs: at += MINUTE });
    assert.equal(f.flow(flow.id).state, 'failed'); assert.ok(f.flow(flow.id).abandonedAt); assert.equal(f.store.need('job', flow.jobId).status, 'abandoned');
    const run = f.run(merged.flowId); assert.equal(run.status, 'pending'); assert.equal(run.runBy, runBy); assert.equal(run.pendingUntil, first.pendingUntil); assert.equal(run.outcome, undefined);
    assert.deepEqual(drainReasons(f.store), [], `round ${round}: the drain is not held`);
    assert.equal(f.store.all('inbox').filter(item => item.flowId === flow.id).length, 0, 'no notice for a stop the factory made');
    // While the hold lasts it is not queued again.
    await f.tick({ nowMs: at += MINUTE }); assert.equal(f.run(merged.flowId).status, 'pending'); assert.equal(f.jobs().filter(job => job.status === 'queued').length, 0);
    hold(false);
  }
  assert.equal(f.upkeepFlows().length, 3); assert.ok(at < T + DAY);
  // The deadline passes while it waits under one more hold: closed, and it never runs after it.
  hold(true); await f.tick({ nowMs: T + DAY });
  assert.deepEqual({ status: f.run(merged.flowId).status, reason: f.run(merged.flowId).reason, runBy: f.run(merged.flowId).runBy }, { status: 'closed', reason: 'stale-run', runBy });
  hold(false); await f.tick({ nowMs: T + DAY + MINUTE }); await f.tick({ nowMs: T + 2 * DAY });
  assert.equal(f.upkeepFlows().length, 3, 'no further assessment'); assert.equal(f.upkeepFlows().every(flow => flow.abandonedAt), true); assert.equal(hasUpkeepWork(f.store), false);
  nothingWritten(f);
});

test('an assessment whose attempt is uncertain is not abandoned: the existing rule still blocks the drain; an aborted one settles without closing the run', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a'); await f.tick(); const [flow] = f.upkeepFlows(); await f.engine.tick();
  const attempt = f.store.need('attempt', f.flow(flow.id).attemptId); f.store.put('attempt', { ...attempt, status: 'uncertain', reason: 'fictional uncertainty' });
  f.command('pause', { paused: true, holdMaintenance: true, note: 'An upgrade waits for a drain' });
  await f.tick(); await f.engine.tick(); await f.tick();
  assert.equal(f.flow(flow.id).state, 'stopped'); assert.equal(f.flow(flow.id).abandonedAt, undefined); assert.equal(f.run(merged.flowId).status, 'running');
  assert.ok(drainReasons(f.store).some(reason => /reconcile all unresolved attempts/.test(reason)));
  // Resolved by the operator, the flow is ended and the receipt returns.
  const resolved = f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'failed', costMicros: 0, quiescence: 'independently-confirmed', note: 'Inspected: nothing ran' }); assert.equal(resolved.status, 'completed', resolved.error);
  await f.tick(); assert.ok(f.flow(flow.id).abandonedAt); assert.equal(f.run(merged.flowId).status, 'pending'); assert.deepEqual(drainReasons(f.store), []);
  // An aborted attempt: settlement leaves the run to the tick.
  const g = upkeepProject(t), other = await g.mergedAndFinished('a'); await g.tick(); const [second] = g.upkeepFlows(); await g.engine.tick();
  const running = g.store.need('attempt', g.flow(second.id).attemptId);
  g.command('pause', { paused: true, holdMaintenance: true, note: 'An upgrade waits for a drain' }); await g.tick();
  g.engine.settle(second.id, running, { version: 1, attemptId: running.id, intentDigest: running.intentDigest, costMicros: 0, exitCode: null, signal: 'SIGTERM', reason: 'aborted', aborted: true, actionResult: null });
  assert.equal(g.store.need('attempt', running.id).status, 'aborted'); assert.equal(g.run(other.flowId).status, 'running');
  await g.tick(); assert.equal(g.run(other.flowId).status, 'pending'); assert.ok(g.flow(second.id).abandonedAt); assert.deepEqual(drainReasons(g.store), []);
});

test('an assessment that is stopped for a fault is ended, not retried, and frees the upkeep lane', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a'); await f.mergedAndFinished('b');
  await f.tick(); const [flow] = f.upkeepFlows();
  assert.equal(f.command('stop', { flowId: flow.id, note: 'Fictional fault' }).status, 'completed');
  await f.tick();
  assert.ok(f.flow(flow.id).abandonedAt); assert.deepEqual({ status: f.run(merged.flowId).status, outcome: f.run(merged.flowId).outcome, reason: f.run(merged.flowId).reason }, { status: 'closed', outcome: 'abstained', reason: 'stopped' });
  await f.tick(); assert.equal(f.upkeepFlows().filter(unfinished).length, 1, 'the next run has the lane'); assert.equal(f.run('flow-b').status, 'running');
});

// ---- 5.1: a run by hand ----
test('the operator, or the orchestrator where job.enqueue is delegated, runs upkeep by hand for one merged flow; no deadline moves', async t => {
  const f = upkeepProject(t, { upkeep: { ...UPKEEP, mode: 'off' } }), merged = await f.mergedAndFinished('a'), unmerged = await f.mergedAndFinished('b', undefined, { merged: false });
  const enqueue = (flowId, actor = f.command) => actor('job.enqueue', { operation: 'knowledge.upkeep', payload: { flowId }, note: 'Assess this merge' });
  assert.match(enqueue(merged.flowId).error, /knowledge upkeep is off/);
  assert.equal(f.command('settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }).status, 'completed');
  for (const [flowId, pattern] of [[unmerged.flowId, /not a change or document flow with a proven merge/], ['no-such-flow', /not a change or document flow/], [undefined, /needs payload\.flowId/]]) { const refused = enqueue(flowId); assert.equal(refused.status, 'rejected'); assert.match(refused.error, pattern); }
  assert.equal(f.command('job.enqueue', { operation: 'knowledge.upkeep', payload: { flowId: merged.flowId }, modelOverrides: {}, note: 'x' }).status, 'rejected');
  // The flow merged while upkeep was off, so it has no receipt: the run by hand writes it and queues it.
  const queued = enqueue(merged.flowId, (operation, payload) => delegated(f, operation, payload));
  assert.equal(queued.status, 'completed', queued.error); assert.equal(queued.result.operation, 'knowledge.upkeep'); assert.equal(queued.result.grant.actor, 'orchestrator'); assert.ok(queued.result.grant.onBehalfOf);
  const run = f.run(merged.flowId); assert.equal(run.status, 'queued'); assert.equal(run.jobId, queued.result.id); assert.equal(run.manualGrant, undefined);
  assert.match(enqueue(merged.flowId).error, /already queued/);
  // The orchestrator without a recorded instruction has no such authority.
  const bare = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'job.enqueue', payload: { operation: 'knowledge.upkeep', payload: { flowId: merged.flowId }, note: 'x' } }); assert.equal(bare.status, 'rejected');
  const done = await f.assess(); assert.equal(done.run.status, 'closed'); assert.equal(done.run.runs, 1);
  // Again by hand, before its deadline: the same receipt, the same deadlines, a second assessment.
  const again = enqueue(merged.flowId); assert.equal(again.status, 'completed', again.error);
  assert.deepEqual([f.run(merged.flowId).runBy, f.run(merged.flowId).pendingUntil, f.run(merged.flowId).firstQueuedAt], [run.runBy, run.pendingUntil, run.firstQueuedAt]);
  const second = await f.assess(); assert.equal(second.run.runs, 2); assert.equal(f.store.count('upkeepRun'), 1);
  // It is not a scheduled operation: a schedule cannot name it.
  assert.equal(f.command('schedule.put', { schedule: { id: 'nightly-upkeep', operation: 'knowledge.upkeep', type: 'interval', everyMs: DAY, enabled: true }, note: 'x' }).status, 'rejected');
  // An upkeep-origin flow is refused by hand as well.
  const origin = await f.mergedAndFinished('c', undefined, { patch: flow => { flow.taskSnapshot = { ...flow.taskSnapshot, upkeep: { kind: 'docs' } }; } });
  assert.match(enqueue(origin.flowId).error, /upkeep does not assess its own work/);
});

// ---- 4.5: an unverified kind ----
test('when a kind upkeep reads through an index is not verified, the run does not start: upkeep suspends itself with one notice', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a');
  f.store.db.exec('DROP INDEX records_live_finding');
  await f.tick();
  assert.equal(f.upkeepFlows().length, 0, 'no flow was admitted'); assert.deepEqual({ status: f.run(merged.flowId).status, outcome: f.run(merged.flowId).outcome, reason: f.run(merged.flowId).reason, stage: f.run(merged.flowId).stage }, { status: 'closed', outcome: 'abstained', reason: 'suspended', stage: 'start' });
  const suspension = upkeepSuspended(f.store, 'docs'); assert.equal(suspension.part, 'all'); assert.equal(suspension.rule, 'unverified-kind'); assert.deepEqual(suspension.window, { kinds: ['finding'] });
  assert.equal(f.store.need('job', f.run(merged.flowId).jobId).status, 'revoked');
  // The next run ends the same way, and there is still one notice. Only the operator lifts a suspension.
  const next = await f.mergedAndFinished('b'); await f.tick(); assert.equal(f.run(next.flowId).reason, 'suspended'); assert.equal(f.upkeepFlows().length, 0);
  assert.equal(f.store.all('inbox').filter(item => item.id.startsWith('upkeep-suspended:')).length, 1);
});

test('at most 200 runs are tracked: a receipt beyond that is recorded closed, never left untracked', async t => {
  const f = upkeepProject(t), runs = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`held-${i}`, 'pending']));
  f.store.setMeta('upkeepWork', { pending: 200, queued: 0, running: 0, runs });
  const merged = await f.merge('a');
  assert.deepEqual({ status: f.run(merged.flowId).status, outcome: f.run(merged.flowId).outcome, reason: f.run(merged.flowId).reason, stage: f.run(merged.flowId).stage }, { status: 'closed', outcome: 'abstained', reason: 'work-limit', stage: 'receipt' });
  assert.equal(upkeepWorkRuns(f.store).length, 200);
  // A tracked id with no run, or with a closed one, is dropped from the row by the next tick.
  f.store.setMeta('upkeepWork', { runs: { [merged.flowId]: 'pending', 'never-written': 'queued' } }); await f.tick();
  assert.deepEqual(upkeepWorkRuns(f.store), []);
});
