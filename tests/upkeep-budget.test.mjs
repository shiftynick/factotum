// Knowledge upkeep, slice 3: the daily reservation and the maintained invocation totals (design
// 6.6 and 4.5, and the slice 3 acceptance of section 15). The model is scripted. Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { EMPTY_RESULT, scriptedModel, upkeepProject, UPKEEP, write } from './upkeep-fixtures.mjs';
import { ProviderError } from '../starter/factory/adapters/providers/index.mjs';
import { runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';
import { attemptInvocations, isModelOperation, projectUsage } from '../starter/factory/operations/usage-accounting.mjs';
import { projectStats } from '../starter/factory/operations/stats-view.mjs';
import { countAttemptInvocationsInTransaction, reserveUpkeepModelRunInTransaction, upkeepRunReachedModel } from '../starter/factory/operations/upkeep-budget.mjs';
import { hasUpkeepWork, putUpkeepRunInTransaction, upkeepDay, upkeepDayId, upkeepRun, upkeepWindow } from '../starter/factory/operations/upkeep-records.mjs';

const DAY = 86400000, T0 = Date.parse('2026-11-16T10:00:00.000Z');
const today = f => upkeepDay(f.store, upkeepDayId());
const totals = f => { const day = today(f); return [day.invocations, day.upkeepInvocations]; };
const budget = f => { const day = today(f); return [day.modelRunsReserved, day.modelRunsSettled]; };
const limited = (maxModelRunsPerDay, extra = {}) => ({ upkeep: { ...UPKEEP, budget: { maxModelRunsPerDay, ...extra } } });
const receipt = (attempt, actionResult, exitCode = 0) => ({ version: 1, attemptId: attempt.id, intentDigest: attempt.intentDigest, synthetic: false, costMicros: 0, exitCode, signal: null, reason: null, ...(actionResult === undefined ? {} : { actionResult }) });
const invocation = (n, observation) => ({ provider: 'claude', model: 'fictional', sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, ...(observation ? { usageObservation: { version: 1, id: observation, provider: 'claude', sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, startedAt: new Date(T0 + n * 1000).toISOString(), endedAt: new Date(T0 + n * 1000 + 500).toISOString(), tokenSemantics: 'unknown', costSemantics: 'unknown', format: 'unknown', raw: {} } } : {}) });
// Every SQL statement run through the store, with its bound values.
function statements(store) {
  let seen = []; const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { const statement = prepare(sql); for (const name of ['all', 'get', 'run']) { const call = statement[name].bind(statement); statement[name] = (...args) => { seen.push({ sql, args }); return call(...args); }; } return statement; };
  return { take() { const taken = seen; seen = []; return taken; }, restore() { store.db.prepare = prepare; } };
}
// A prepared attempt of a model step on a new flow of the fixture project (the step itself is a
// fixture command; only its recorded operation matters to the counting function).
async function modelAttempt(f, name, operation = 'provider.review') {
  const at = await f.atMerge(name), stored = f.store.need('attempt', at.attempt.id);
  stored.intent = { ...stored.intent, action: { operation, config: f.store.meta('config') } }; f.store.put('attempt', stored);
  return { flowId: at.flow.id, attempt: f.store.need('attempt', stored.id) };
}
const uncertain = (f, a, invocations) => f.engine.uncertain(a.attempt, 'fictional uncertainty', invocations ? receipt(a.attempt, { uncertain: true, reason: 'fictional', providerInvocations: invocations }) : undefined);
function resolve(f, a, disposition) {
  const done = f.command('attempt.resolve', { attemptId: a.attempt.id, disposition, costMicros: 0, note: 'Fictional reconciliation', quiescence: 'independently-confirmed' }); assert.equal(done.status, 'completed', done.error);
  assert.equal(f.command('flow.abandon', { flowId: a.flowId, note: 'Fictional: free the slot' }).status, 'completed'); return f.store.need('attempt', a.attempt.id);
}

// ---- 6.6: the daily reservation ----
test('a reservation: refused at the limit, made once per attempt id, and never negative', t => {
  const f = sandbox(t), reserve = (attemptId, limit, nowMs = T0) => f.store.tx(() => reserveUpkeepModelRunInTransaction(f.store, { attemptId, limit, now: () => nowMs }));
  // The read and the write are one transaction: outside one, nothing is reserved.
  assert.throws(() => reserveUpkeepModelRunInTransaction(f.store, { attemptId: 'attempt-a', limit: 2, now: () => T0 }), /inside a transaction/); assert.equal(f.store.count('upkeepDay'), 0);
  // It reads the clock itself, inside that transaction: a time read earlier is not accepted in its place.
  assert.throws(() => f.store.tx(() => reserveUpkeepModelRunInTransaction(f.store, { attemptId: 'attempt-a', limit: 2, now: T0 })), /reads the clock itself/); assert.equal(f.store.count('upkeepDay'), 0);
  assert.deepEqual(reserve('attempt-a', 2), { reserved: true, repeated: false, day: '2026-11-16', used: 1, limit: 2 });
  // The same attempt asks again: it holds its reservation, and nothing more is reserved.
  for (let again = 0; again < 3; again++) assert.deepEqual(reserve('attempt-a', 2), { reserved: true, repeated: true, day: '2026-11-16', used: 1, limit: 2 });
  assert.equal(reserve('attempt-b', 2).reserved, true);
  assert.deepEqual(reserve('attempt-c', 2), { reserved: false, repeated: false, day: '2026-11-16', used: 2, limit: 2 }, 'reserved plus settled has reached the limit');
  const day = upkeepDay(f.store, '2026-11-16'); assert.equal(day.modelRunsReserved, 2); assert.deepEqual(Object.keys(day.reservations), ['attempt-a', 'attempt-b']);
  // Settled runs count against the limit as reserved ones do; a limit of zero admits nothing.
  f.store.put('upkeepDay', { ...day, modelRunsReserved: 0, modelRunsSettled: 2 }); assert.equal(reserve('attempt-d', 2).reserved, false); assert.equal(reserve('attempt-d', 3).reserved, true);
  assert.equal(reserve('attempt-e', 0, T0 + DAY).reserved, false); assert.equal(reserve('attempt-e', undefined, T0 + DAY).reserved, false, 'no limit given is not no limit');
  // The next UTC day has its own row.
  assert.deepEqual(reserve('attempt-f', 1, T0 + DAY), { reserved: true, repeated: false, day: '2026-11-17', used: 1, limit: 1 }); assert.equal(upkeepDay(f.store, '2026-11-16').modelRunsReserved, 1);
  // With a run, the reservation is found again by the attempt on any later day.
  f.store.tx(() => putUpkeepRunInTransaction(f.store, { id: 'flow-r', status: 'running', pendingUntil: new Date(T0 + 7 * DAY).toISOString() }));
  const held = f.store.tx(() => reserveUpkeepModelRunInTransaction(f.store, { attemptId: 'attempt-r', flowId: 'flow-r', limit: 5, now: () => T0 + 2 * DAY }));
  assert.equal(held.reserved, true); assert.deepEqual(upkeepRun(f.store, 'flow-r').modelRun, { attemptId: 'attempt-r', day: '2026-11-18', status: 'reserved', reservedAt: new Date(T0 + 2 * DAY).toISOString() });
  const later = f.store.tx(() => reserveUpkeepModelRunInTransaction(f.store, { attemptId: 'attempt-r', flowId: 'flow-r', limit: 5, now: () => T0 + 3 * DAY }));
  assert.deepEqual([later.reserved, later.repeated, later.day], [true, true, '2026-11-18']); assert.equal(upkeepDay(f.store, '2026-11-19').modelRunsReserved, 0);
});

test('the daily limit is exact under concurrent starts in separate processes, and a repeated attempt id reserves once', { timeout: 60000 }, async t => {
  const f = sandbox(t), store = new URL('../starter/factory/core/store.mjs', import.meta.url).href, module = new URL('../starter/factory/operations/upkeep-budget.mjs', import.meta.url).href;
  const script = `import { Store } from ${JSON.stringify(store)}; import { reserveUpkeepModelRunInTransaction } from ${JSON.stringify(module)};
    const [stateDir, attemptId, limit, nowMs] = process.argv.slice(1), opened = new Store(stateDir);
    process.on('message', message => {
      if (message !== 'reserve') return;
      try { process.send({ type: 'result', ...opened.tx(() => reserveUpkeepModelRunInTransaction(opened, { attemptId, limit: Number(limit), now: () => Number(nowMs) })) }); }
      catch (error) { process.send({ type: 'result', error: error.message }); }
      opened.close(); process.disconnect();
    });
    process.send({ type: 'ready' });`;
  // Every process has the database open before any of them is told to reserve.
  async function race(ids, limit, nowMs) {
    const contenders = ids.map(attemptId => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.stateDir, attemptId, String(limit), String(nowMs)], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
      let ready, result; const isReady = new Promise(done => { ready = done; }), outcome = new Promise(done => { result = done; });
      child.on('message', message => { if (message.type === 'ready') ready(); if (message.type === 'result') result(message); }); child.on('error', error => { ready(); result({ error: error.message }); });
      child.on('exit', code => { ready(); result({ error: `exited ${code} before answering` }); });
      return { child, isReady, outcome };
    });
    await Promise.all(contenders.map(row => row.isReady)); for (const row of contenders) row.child.send('reserve');
    return Promise.all(contenders.map(row => row.outcome));
  }
  // Twelve attempts start at once against a limit of five: exactly five reserve.
  const results = await race(Array.from({ length: 12 }, (_, at) => `attempt-${at}`), 5, T0);
  assert.deepEqual(results.filter(row => row.error), []); assert.equal(results.filter(row => row.reserved).length, 5); assert.equal(results.filter(row => !row.reserved).length, 7);
  const day = upkeepDay(f.store, '2026-11-16'); assert.equal(day.modelRunsReserved, 5); assert.equal(Object.keys(day.reservations).length, 5);
  assert.deepEqual(Object.keys(day.reservations).sort(), results.map((row, at) => row.reserved ? `attempt-${at}` : null).filter(Boolean).sort());
  // The same attempt id from eight processes at once: one reservation, and each is told it holds it.
  const same = await race(Array(8).fill('attempt-same'), 30, T0 + DAY);
  assert.deepEqual(same.filter(row => row.error), []); assert.equal(same.filter(row => row.reserved).length, 8); assert.equal(same.filter(row => !row.repeated).length, 1);
  assert.equal(upkeepDay(f.store, '2026-11-17').modelRunsReserved, 1); assert.deepEqual(Object.keys(upkeepDay(f.store, '2026-11-17').reservations), ['attempt-same']);
});

test('settlement moves a reservation to settled with the observed usage, and a failed attempt stays counted', async t => {
  const f = upkeepProject(t), usage = { input_tokens: 0 };
  // A model run that passes: reserved while it runs, settled when its attempt settles.
  const seen = []; const first = await (await f.mergedAndFinished('a'), f.assess({ providerInvoke: scriptedModel(spec => { seen.push(budget(f)); return EMPTY_RESULT; }) }));
  assert.deepEqual(seen, [[1, 0]], 'reserved before the provider starts'); assert.deepEqual(budget(f), [0, 1]);
  assert.deepEqual({ status: first.run.modelRun.status, day: first.run.modelRun.day, attemptId: first.run.modelRun.attemptId }, { status: 'settled', day: upkeepDayId(), attemptId: first.attempt.id });
  assert.deepEqual(first.run.usage, { invocations: 1, tokens: null }, 'counters only; tokens where the observation can be read'); assert.equal(first.outcome.modelRun.day, upkeepDayId());
  assert.deepEqual(today(f).reservations, { [first.attempt.id]: { flowId: first.run.id, at: first.run.modelRun.reservedAt, settled: true } }); assert.ok(usage);
  // A model that fails in a known way (its turn limit): the attempt fails, the run closes at the
  // model stage, and its model run stays counted. Nothing is retried.
  await f.mergedAndFinished('b', root => write(root, { 'src/api/users.js': 'export const users = [2];\n' }));
  const { assessment, attempt } = await f.prepared(), limit = { provider: 'claude', model: 'fictional', turns: 6, maxTurns: 6 };
  const failing = scriptedModel(() => { throw Object.assign(new ProviderError('claude stopped at its turn limit', { started: true, code: 'MAX_TURNS' }), { turnLimit: limit, accountingResult: invocation(7) }); });
  const error = await runMaintenanceAction(attempt.intent, { providerInvoke: failing }).then(() => null, caught => caught);
  assert.equal(error.code, 'MAX_TURNS'); assert.deepEqual(error.providerInvocations, [invocation(7)], 'the failed result names its one invocation'); assert.deepEqual(budget(f), [1, 1]);
  f.engine.settle(assessment.id, attempt, receipt(attempt, { route: 'error', error: error.message, providerInvocations: error.providerInvocations, turnLimit: limit }, 1));
  await f.engine.tick(); assert.equal(f.flow(assessment.id).state, 'failed');
  const failed = f.run('flow-b'); assert.deepEqual({ status: failed.status, outcome: failed.outcome, reason: failed.reason, stage: failed.stage, modelRun: failed.modelRun.status }, { status: 'closed', outcome: 'abstained', reason: 'turn-limit', stage: 'model', modelRun: 'settled' });
  assert.deepEqual(budget(f), [0, 2]); assert.deepEqual(totals(f), [2, 2]); assert.equal(hasUpkeepWork(f.store), false);
  await f.tick(); assert.equal(f.upkeepFlows().filter(flow => !['completed', 'failed'].includes(flow.state)).length, 0, 'an assessment is never retried by itself');
  // Any other failure after the reservation closes the run as model-failed.
  await f.mergedAndFinished('c', root => write(root, { 'src/api/users.js': 'export const users = [3];\n' }));
  const next = await f.prepared(), broken = await runMaintenanceAction(next.attempt.intent, { providerInvoke: scriptedModel(() => { throw new Error('fictional failure'); }) }).then(() => null, caught => caught);
  f.engine.settle(next.assessment.id, next.attempt, receipt(next.attempt, { route: 'error', error: broken.message, providerInvocations: broken.providerInvocations }, 1));
  assert.deepEqual([f.run('flow-c').outcome, f.run('flow-c').reason, f.run('flow-c').stage], ['abstained', 'model-failed', 'model']); assert.deepEqual(budget(f), [0, 3]);
  assert.deepEqual(upkeepWindow(f.store).runs.map(row => [row.reason, row.model]), [['no-candidate', true], ['turn-limit', true], ['model-failed', true]]);
});

test('at the limit a run that needs the model abstains with the reason budget and is not queued for the next day', async t => {
  const f = upkeepProject(t, limited(1)), model = scriptedModel();
  await f.mergedAndFinished('a'); assert.equal((await f.assess({ providerInvoke: model })).run.reason, 'no-candidate'); assert.deepEqual(budget(f), [0, 1]);
  // The second run of the day needs the model too: it abstains, before any provider starts.
  const second = await (await f.mergedAndFinished('b', root => write(root, { 'src/api/users.js': 'export const users = [2];\n' })), f.assess({ providerInvoke: model }));
  assert.deepEqual({ status: second.run.status, outcome: second.run.outcome, reason: second.run.reason, stage: second.run.stage }, { status: 'closed', outcome: 'abstained', reason: 'budget', stage: 'reservation' });
  assert.equal(model.calls.length, 1, 'no provider was started'); assert.deepEqual(second.outcome.providerInvocations, []); assert.equal(second.run.modelRun, undefined); assert.equal(upkeepRunReachedModel(second.run), false);
  assert.deepEqual(budget(f), [0, 1]); assert.deepEqual(totals(f), [1, 1]); assert.equal(today(f).outcomes['abstained:budget'], 1);
  // It is closed, not waiting: nothing is queued or tracked, and a tick on the next day starts nothing for it.
  assert.equal(hasUpkeepWork(f.store), false); assert.equal(f.jobs().filter(job => ['queued', 'running'].includes(job.status)).length, 0);
  const flows = f.upkeepFlows().length; await f.tick({ nowMs: Date.now() + DAY }); await f.tick({ nowMs: Date.now() + 2 * DAY });
  assert.equal(f.upkeepFlows().length, flows); assert.equal(f.run('flow-b').status, 'closed'); assert.equal(model.calls.length, 1);
  // A run that ends at its pre-filter needs no model run and is not refused by the limit.
  const quiet = await (await f.mergedAndFinished('c', root => write(root, { 'src/quiet.js': 'export {};\n' })), f.assess({ providerInvoke: model })); assert.equal(quiet.run.reason, 'no-referring-doc');
  // A limit of zero: no run reaches the model.
  const none = upkeepProject(t, limited(0)), never = scriptedModel();
  await none.mergedAndFinished('a'); assert.equal((await none.assess({ providerInvoke: never })).run.reason, 'budget'); assert.equal(never.calls.length, 0); assert.deepEqual(budget(none), [0, 0]);
  // The model's throwaway checkout is removed on this path too.
  const { execFileSync } = await import('node:child_process'); assert.equal(execFileSync('git', ['worktree', 'list'], { cwd: none.root, encoding: 'utf8' }).trim().split('\n').length, 1);
});

// A provider whose end is not known: it started and was stopped at its time limit.
const stoppedProvider = (receiptNames = true) => scriptedModel(() => { throw Object.assign(new ProviderError('claude provider timed out after 300 s', { started: true, code: 'TIMEOUT' }), receiptNames ? { accountingResult: invocation(1) } : {}); });
test('an uncertain attempt keeps its reservation until it is resolved; it is given back only when no receipt shows that a model ran', async t => {
  // [how it is resolved, whether the attempt kept a receipt that names its invocation, whether the model run stays counted]
  for (const [disposition, named, counted] of [['failed', true, true], ['not-dispatched', true, true], ['not-dispatched', false, false]]) {
    const label = `${disposition}, receipt ${named ? 'names an invocation' : 'missing'}`, f = upkeepProject(t, limited(1)); await f.mergedAndFinished('a');
    const { assessment, attempt } = await f.prepared();
    // The provider started and how it ended is not known: the action reports an uncertain outcome.
    const error = await runMaintenanceAction(attempt.intent, { providerInvoke: stoppedProvider() }).then(() => null, caught => caught);
    assert.equal(error.started, true); assert.equal(error.providerInvocations.length, 1);
    f.engine.uncertain(attempt, error.message, named ? receipt(attempt, { uncertain: true, reason: error.message, providerInvocations: error.providerInvocations }) : undefined);
    assert.equal(f.store.need('attempt', attempt.id).status, 'uncertain'); assert.deepEqual(budget(f), [1, 0], label);
    // It holds the day's one model run for as long as it is unresolved: ticks change nothing, and another run waits behind it.
    await f.tick(); await f.tick(); assert.deepEqual(budget(f), [1, 0]); assert.equal(f.run('flow-a').status, 'running'); assert.equal(f.run('flow-a').modelRun.status, 'reserved'); assert.deepEqual(totals(f), [0, 0], 'not settled: not counted yet');
    const other = await f.mergedAndFinished('b', root => write(root, { 'src/api/users.js': 'export const users = [2];\n' })); await f.tick();
    assert.equal(f.run(other.flowId).status, 'queued', 'the upkeep lane is held by the unresolved assessment');
    // attempt.resolve corrects the day row in its own transaction.
    const probe = statements(f.store);
    const done = f.command('attempt.resolve', { attemptId: attempt.id, disposition, costMicros: 0, note: 'Fictional reconciliation', quiescence: 'independently-confirmed' }); assert.equal(done.status, 'completed', done.error);
    const writes = probe.take().filter(row => /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(row.sql) && row.args.includes('upkeepDay')); probe.restore(); assert.ok(writes.length >= 1, 'the day row is written by the command');
    // A receipt that names an invocation is evidence that a model ran: the run it used stays counted
    // whatever the attempt is resolved as. Only an attempt with no such evidence, settled as not
    // dispatched, gives its model run back.
    assert.deepEqual(budget(f), counted ? [0, 1] : [0, 0], label); assert.equal(f.run('flow-a').modelRun.status, counted ? 'settled' : 'released', label);
    assert.deepEqual(totals(f), named ? [1, 1] : disposition === 'failed' ? [1, 1] : [0, 0], label); assert.deepEqual(f.store.need('attempt', attempt.id).invocationsCounted, { day: upkeepDayId(), count: named ? 1 : 0, upkeep: true });
    assert.equal(today(f).modelRunsSettled >= today(f).upkeepInvocations, true, `${label}: never more invocations than model runs counted`);
    assert.deepEqual(today(f).reservations, counted ? { [attempt.id]: { flowId: 'flow-a', at: f.run('flow-a').modelRun.reservedAt, settled: true } } : undefined);
    // The stopped assessment is then ended by the factory, and its run closes; it is not retried.
    await f.tick(); assert.equal(f.flow(assessment.id).state, 'failed'); const closed = f.run('flow-a');
    assert.deepEqual({ status: closed.status, outcome: closed.outcome, reason: closed.reason, stage: closed.stage }, { status: 'closed', outcome: 'abstained', reason: 'stopped', stage: counted ? 'model' : 'start' });
    assert.equal(upkeepRunReachedModel(closed), counted); assert.equal(upkeepWindow(f.store).runs.at(-1).model, counted);
    // The run that waited behind it: refused by the limit when the run stayed counted, admitted when it was given back.
    const model = scriptedModel(), next = await f.assess({ providerInvoke: model });
    assert.equal(next.run.reason, counted ? 'budget' : 'no-candidate', label); assert.equal(model.calls.length, counted ? 0 : 1);
  }
});

test('review P2-2: a model run that a receipt proves is not returned to the budget by resolving its attempt as not dispatched', async t => {
  // 29 of the day's 30 model runs are used. The thirtieth ends uncertain, with its invocation on the receipt.
  const f = upkeepProject(t); f.store.put('upkeepDay', { id: upkeepDayId(), modelRunsReserved: 0, modelRunsSettled: 29, tasksCreated: 0, invocations: 29, upkeepInvocations: 29, outcomes: {} });
  await f.mergedAndFinished('a'); const { attempt } = await f.prepared();
  const error = await runMaintenanceAction(attempt.intent, { providerInvoke: stoppedProvider() }).then(() => null, caught => caught);
  f.engine.uncertain(attempt, error.message, receipt(attempt, { uncertain: true, reason: error.message, providerInvocations: error.providerInvocations })); assert.deepEqual(budget(f), [1, 29]);
  assert.equal(f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'not-dispatched', costMicros: 0, note: 'Fictional reconciliation', quiescence: 'independently-confirmed' }).status, 'completed');
  assert.deepEqual(budget(f), [0, 30], 'the run the model used stays counted'); assert.deepEqual(totals(f), [30, 30]);
  // Another assessment the same day is the thirty-first: it is refused, and no model starts.
  await f.tick(); await f.mergedAndFinished('b', root => write(root, { 'src/api/users.js': 'export const users = [2];\n' }));
  const model = scriptedModel(), next = await f.assess({ providerInvoke: model });
  assert.equal(next.run.reason, 'budget'); assert.equal(model.calls.length, 0);
  assert.deepEqual(budget(f), [0, 30]); assert.deepEqual(totals(f), [30, 30], 'thirty invocations against thirty model runs, not thirty-one');
});

test('review P2-1: the reservation reads the clock in its own transaction, so a step that crosses midnight is counted against the new day', async t => {
  const { runProcess } = await import('../starter/factory/adapters/providers/index.mjs');
  // The step begins five seconds before a UTC midnight; the clock passes midnight while the checkout is made.
  const midnight = (Math.floor(Date.now() / DAY) + 1) * DAY, before = upkeepDayId(midnight - 5000), after = upkeepDayId(midnight + 1000); assert.notEqual(before, after);
  const crossing = () => { let clock = midnight - 5000; return { clock: () => clock, deadlineAt: midnight + 900000, run: async (command, args, options) => { const done = await runProcess(command, args, options); if (args.includes('worktree') && args.includes('add')) clock = midnight + 1000; return done; } }; };
  // The new day already holds its 30 runs: no model starts, and yesterday is not charged in its place.
  const full = upkeepProject(t), fullModel = scriptedModel(); full.store.put('upkeepDay', { id: after, modelRunsReserved: 0, modelRunsSettled: 30, tasksCreated: 0, invocations: 30, upkeepInvocations: 30, outcomes: {} });
  await full.mergedAndFinished('a'); let { attempt } = await full.prepared(), outcome = await runMaintenanceAction(attempt.intent, { ...crossing(), providerInvoke: fullModel });
  assert.deepEqual([outcome.upkeepRun.outcome, outcome.upkeepRun.reason, outcome.upkeepRun.stage], ['abstained', 'budget', 'reservation']); assert.equal(fullModel.calls.length, 0, 'the model did not start'); assert.deepEqual(outcome.providerInvocations, []);
  assert.deepEqual([upkeepDay(full.store, before).modelRunsReserved, upkeepDay(full.store, before).modelRunsSettled], [0, 0], 'nothing was charged to the day the step began on');
  assert.deepEqual([upkeepDay(full.store, after).modelRunsReserved, upkeepDay(full.store, after).modelRunsSettled], [0, 30]); assert.equal(full.run('flow-a').modelRun, undefined);
  // With room on the new day, the run is reserved on the new day, not on the day the step began.
  const open = upkeepProject(t), openModel = scriptedModel(); await open.mergedAndFinished('a'); ({ attempt } = await open.prepared());
  outcome = await runMaintenanceAction(attempt.intent, { ...crossing(), providerInvoke: openModel });
  assert.equal(openModel.calls.length, 1); assert.equal(outcome.modelRun.day, after); assert.equal(open.run('flow-a').modelRun.day, after);
  assert.equal(upkeepDay(open.store, after).modelRunsReserved, 1); assert.equal(upkeepDay(open.store, before).modelRunsReserved, 0);
});

test('review Q6: a model call that conclusively ended without a usable result fails the attempt; an end that is not known stays uncertain', async t => {
  const f = upkeepProject(t); await f.mergedAndFinished('a'); const { assessment, attempt } = await f.prepared();
  // The provider process exited and its output did not validate: a known end of a read-only step.
  const invalid = scriptedModel(() => { throw Object.assign(new ProviderError('Provider did not produce a complete validated result', { started: true, code: 'INVALID_RESULT' }), { accountingResult: invocation(1) }); });
  const error = await runMaintenanceAction(attempt.intent, { providerInvoke: invalid }).then(() => null, caught => caught);
  assert.deepEqual([error.code, Boolean(error.started), Boolean(error.ambiguous)], ['UPKEEP_INVALID_RESULT', false, false], 'the dispatcher records a failure, not an uncertain outcome'); assert.deepEqual(error.providerInvocations, [invocation(1)]);
  f.engine.settle(assessment.id, attempt, receipt(attempt, { route: 'error', error: error.message, providerInvocations: error.providerInvocations }, 1)); await f.engine.tick();
  assert.equal(f.store.need('attempt', attempt.id).status, 'failed'); assert.equal(f.flow(assessment.id).state, 'failed');
  assert.deepEqual([f.run('flow-a').status, f.run('flow-a').reason, f.run('flow-a').stage, f.run('flow-a').modelRun.status], ['closed', 'model-failed', 'model', 'settled']); assert.deepEqual(budget(f), [0, 1]); assert.deepEqual(totals(f), [1, 1]);
  assert.equal(hasUpkeepWork(f.store), false, 'nothing is left to reconcile');
  // A timeout, a cancellation, a transport failure and a usage limit are ends that are not known: still uncertain.
  for (const code of ['TIMEOUT', 'CANCELLED', 'UNCERTAIN', 'OUTPUT_LIMIT', 'DESCENDANTS_SURVIVE', 'USAGE_LIMIT']) {
    const g = upkeepProject(t); await g.mergedAndFinished('a'); const next = await g.prepared();
    const unknown = await runMaintenanceAction(next.attempt.intent, { providerInvoke: scriptedModel(() => { throw Object.assign(new ProviderError(`fictional ${code}`, { started: true, code }), { accountingResult: invocation(1) }); }) }).then(() => null, caught => caught);
    assert.deepEqual([unknown.code, unknown.started], [code, true], code);
  }
});

test('review Q5: a drain closes an assessment that already reached a model, and returns to pending one that did not', async t => {
  const f = upkeepProject(t), merged = await f.mergedAndFinished('a'), hold = on => assert.equal(f.command('pause', { paused: on, ...(on ? { holdMaintenance: true } : {}), note: on ? 'An upgrade waits for a drain' : 'Released' }).status, 'completed');
  const { assessment, attempt } = await f.prepared();
  // The hold arrives while the model is running: the step is asked to stop, and the provider is cancelled.
  const cancelled = scriptedModel(async () => { hold(true); await f.tick(); throw Object.assign(new ProviderError('claude provider was cancelled', { started: true, code: 'CANCELLED' }), { accountingResult: invocation(1) }); });
  const error = await runMaintenanceAction(attempt.intent, { providerInvoke: cancelled }).then(() => null, caught => caught);
  assert.equal(f.flow(assessment.id).abortRequested, true); assert.deepEqual(budget(f), [1, 0]);
  f.engine.settle(assessment.id, attempt, { ...receipt(attempt, { uncertain: true, reason: error.message, providerInvocations: error.providerInvocations }, 1), aborted: true });
  assert.equal(f.store.need('attempt', attempt.id).status, 'aborted'); assert.deepEqual(budget(f), [0, 1], 'a stopped attempt stays counted'); assert.equal(f.run(merged.flowId).status, 'running');
  // Once nothing runs for it the factory ends the flow. The run is closed with the model run it used: it is not queued again.
  await f.tick(); assert.ok(f.flow(assessment.id).abandonedAt); const closed = f.run(merged.flowId);
  assert.deepEqual({ status: closed.status, outcome: closed.outcome, reason: closed.reason, stage: closed.stage, modelRun: closed.modelRun.status }, { status: 'closed', outcome: 'abstained', reason: 'stopped', stage: 'model', modelRun: 'settled' });
  const { drainReasons } = await import('../starter/factory/operations/upgrade-apply.mjs'); assert.deepEqual(drainReasons(f.store), [], 'the drain is not held');
  hold(false); await f.tick(); await f.tick();
  assert.equal(f.run(merged.flowId).status, 'closed'); assert.equal(f.jobs().filter(job => ['queued', 'running'].includes(job.status)).length, 0); assert.equal(f.upkeepFlows().length, 1, 'no second assessment'); assert.equal(cancelled.calls.length, 1);
  assert.deepEqual(budget(f), [0, 1]); assert.deepEqual(totals(f), [1, 1]); assert.equal(hasUpkeepWork(f.store), false);
  // An assessment that a drain stops before it reached a model still returns to pending and runs after the hold
  // (tests/upkeep-observe.test.mjs follows that through repeated drains): here, stopped during its pre-filter.
  const g = upkeepProject(t), other = await g.mergedAndFinished('a'), early = await g.prepared();
  g.command('pause', { paused: true, holdMaintenance: true, note: 'An upgrade waits for a drain' }); await g.tick(); await g.engine.tick(); await g.tick();
  assert.equal(g.store.need('attempt', early.attempt.id).status, 'not-dispatched'); assert.deepEqual([g.run(other.flowId).status, g.run(other.flowId).modelRun], ['pending', undefined]);
  g.command('pause', { paused: false, note: 'Released' }); const model = scriptedModel(); const done = await g.assess({ providerInvoke: model });
  assert.equal(done.run.reason, 'no-candidate'); assert.equal(done.run.runs, 2); assert.equal(model.calls.length, 1);
});

// ---- 4.5: the one counting function, the totals and the projection ----
test('the counting function: named invocations, a provider result, a missing receipt, not-dispatched, the upkeep list, and one observation counted once', () => {
  const intent = operation => ({ action: { operation, config: { providers: { reviewer: { provider: 'claude', model: 'fictional' } } } } }), count = attempt => attemptInvocations(attempt).length;
  assert.deepEqual(['provider.plan', 'provider.review', 'audit', 'knowledge.upkeep', 'gate', 'fastCheck', 'main.verify', undefined].map(isModelOperation), [true, true, true, true, false, false, false, false]);
  // 1. The receipt names them.
  assert.equal(count({ status: 'failed', intent: intent('provider.review'), receipt: { actionResult: { providerInvocations: [invocation(1), invocation(2), invocation(3)] } } }), 3);
  assert.equal(count({ status: 'not-dispatched', intent: intent('provider.review'), receipt: { actionResult: { providerInvocations: [invocation(1), invocation(2), invocation(3)] } } }), 3, 'the receipt is evidence that they ran');
  // 2. The action result is itself a provider result, with the originals of its protocol corrections.
  assert.equal(count({ status: 'passed', intent: intent('provider.planReview'), receipt: { actionResult: { provider: 'claude', model: 'fictional', protocolCorrections: [{ original: invocation(1) }] } } }), 2);
  // 3. No usable receipt: one for a model operation unless it was not dispatched; none otherwise.
  for (const operation of ['provider.build', 'audit', 'knowledge.upkeep']) { assert.equal(count({ status: 'failed', intent: intent(operation) }), 1, operation); assert.equal(count({ status: 'uncertain', intent: intent(operation) }), 1, operation); assert.equal(count({ status: 'not-dispatched', intent: intent(operation) }), 0, operation); }
  for (const operation of ['gate', 'main.verify', 'forge.merge']) assert.equal(count({ status: 'failed', intent: intent(operation) }), 0, operation);
  assert.deepEqual(attemptInvocations({ status: 'failed', intent: intent('knowledge.upkeep') }), [{ provider: 'claude', model: 'fictional', sessionId: null }], 'the route it would have started');
  // An upkeep result always carries the list, and an empty one means none, whatever the status.
  for (const status of ['passed', 'failed', 'aborted']) assert.equal(count({ status, intent: intent('knowledge.upkeep'), receipt: { actionResult: { route: 'pass', providerInvocations: [] } } }), 0, status);
  assert.equal(count({ status: 'failed', intent: intent('provider.review'), receipt: { actionResult: { providerInvocations: [] } } }), 1, 'for any other model step an empty list is not a statement');
  // 4. An observation id that repeats inside the attempt is counted once.
  assert.equal(count({ status: 'passed', intent: intent('provider.review'), receipt: { actionResult: { providerInvocations: [invocation(1, 'obs-1'), invocation(1, 'obs-1'), invocation(2, 'obs-2'), invocation(3)] } } }), 3);
  // intentOf is asked only when the receipt does not already name the invocations.
  let asked = 0; const intentOf = () => { asked++; return intent('provider.review'); };
  attemptInvocations({ status: 'passed', receipt: { actionResult: { providerInvocations: [invocation(1)] } } }, intentOf); assert.equal(asked, 0); attemptInvocations({ status: 'failed' }, intentOf); assert.equal(asked, 1);
});

test('the maintained totals: reconciled attempts with several invocations, a missing receipt, not-dispatched, a run that ended at the pre-filter; equal to the projection', async t => {
  const f = upkeepProject(t), three = [invocation(1, 'obs-1'), invocation(2, 'obs-2'), invocation(3, 'obs-3')]; let name = 0;
  const reconciled = async (disposition, invocations) => { const a = await modelAttempt(f, `m${++name}`); uncertain(f, a, invocations); const before = totals(f); const settled = resolve(f, a, disposition); return { added: totals(f)[0] - before[0], settled }; };
  // An uncertain attempt whose receipt names three invocations, resolved as failed and as not dispatched, adds three.
  let done = await reconciled('failed', three); assert.equal(done.added, 3); assert.deepEqual(done.settled.invocationsCounted, { day: upkeepDayId(), count: 3, upkeep: false });
  done = await reconciled('not-dispatched', three.map((row, at) => ({ ...row, usageObservation: { ...row.usageObservation, id: `obs-nd-${at}` } }))); assert.equal(done.added, 3);
  // A model attempt with no receipt adds one when failed and none when not dispatched.
  assert.equal((await reconciled('failed')).added, 1); done = await reconciled('not-dispatched'); assert.equal(done.added, 0); assert.deepEqual(done.settled.invocationsCounted, { day: upkeepDayId(), count: 0, upkeep: false });
  // The engine's own settlement counts too: a failed model step whose receipt names two.
  const failed = await modelAttempt(f, 'engine-failed'); f.engine.settle(failed.flowId, failed.attempt, receipt(failed.attempt, { route: 'error', error: 'fictional', providerInvocations: [invocation(10, 'obs-10'), invocation(11, 'obs-11')] }, 1));
  assert.deepEqual(totals(f), [3 + 3 + 1 + 0 + 2, 0]); assert.equal(f.store.need('attempt', failed.attempt.id).invocationsCounted.count, 2);
  // A replayed settlement, and a second call for the same attempt, add nothing: counted once.
  f.engine.settle(failed.flowId, failed.attempt, receipt(failed.attempt, { route: 'error', error: 'fictional', providerInvocations: [invocation(10, 'obs-10'), invocation(11, 'obs-11')] }, 1));
  assert.equal(f.store.tx(() => countAttemptInvocationsInTransaction(f.store, f.store.need('attempt', failed.attempt.id), f.flow(failed.flowId))), null); assert.equal(totals(f)[0], 9);
  await f.finish(failed.flowId);
  // A step that is not a model operation adds nothing, with or without a receipt (the fixture's merge and post-merge steps).
  const merged = await f.mergedAndFinished('quiet', root => write(root, { 'src/quiet.js': 'export {};\n' })); assert.equal(totals(f)[0], 9);
  // An upkeep run that ended at its pre-filter adds none; one that asked the model adds one, upkeep-attributed.
  const quiet = await f.assess(); assert.equal(quiet.run.reason, 'no-referring-doc'); assert.deepEqual(totals(f), [9, 0]); assert.deepEqual(f.store.need('attempt', quiet.attempt.id).invocationsCounted, { day: upkeepDayId(), count: 0, upkeep: true });
  await f.mergedAndFinished('asked'); const asked = await f.assess(); assert.equal(asked.run.reason, 'no-candidate'); assert.deepEqual(totals(f), [10, 1]);
  // A flow whose task snapshot carries the factory's upkeep marker is upkeep-attributed too.
  const marked = await modelAttempt(f, 'marked'), flow = f.flow(marked.flowId); f.store.put('flow', { ...flow, taskSnapshot: { ...flow.taskSnapshot, upkeep: { kind: 'docs' } } });
  f.engine.settle(marked.flowId, marked.attempt, receipt(marked.attempt, { route: 'error', error: 'fictional', providerInvocations: [invocation(20, 'obs-20')] }, 1)); assert.deepEqual(totals(f), [11, 2]);
  assert.equal(merged.flowId, 'flow-quiet');
  // Over these attempts, none of which shares an observation, the day's total equals the projection's count.
  const attempts = f.store.all('attempt'), projected = projectUsage(attempts).filter(entry => !entry.duplicate);
  assert.equal(projected.length, 11); assert.equal(today(f).invocations, projected.length);
  assert.equal(attempts.reduce((sum, attempt) => sum + (attempt.invocationsCounted?.count ?? 0), 0), 11, 'each attempt records what it was counted as');
  // Stats counts the same thing, the upkeep assessment included, as a model step.
  const stats = projectStats(f.store, { window: '7d' }); assert.equal(stats.accounting.attemptWindow.invocations, 11); assert.equal(stats.accounting.attemptWindow.duplicateObservations, 0);
  assert.deepEqual(stats.upkeep.days.find(row => row.day === upkeepDayId()), { day: upkeepDayId(), invocations: 11, upkeepInvocations: 2, modelRunsReserved: 0, modelRunsSettled: 1, tasksCreated: 0, operatorTasksCreated: 0 });

  // The one stated difference: the same recorded result stored under two attempts. The totals count
  // per attempt and count it twice; the projection leaves the second out. Nothing else differs.
  for (const label of ['dup-1', 'dup-2']) { const a = await modelAttempt(f, label); f.engine.settle(a.flowId, a.attempt, receipt(a.attempt, { route: 'error', error: 'fictional', providerInvocations: [invocation(30, 'obs-shared')] }, 1)); await f.finish(a.flowId); }
  const all = projectUsage(f.store.all('attempt')); assert.equal(all.filter(entry => entry.duplicate).length, 1); assert.equal(all.filter(entry => !entry.duplicate).length, 12);
  assert.equal(today(f).invocations, 13); assert.equal(today(f).invocations - all.filter(entry => !entry.duplicate).length, all.filter(entry => entry.duplicate).length, 'the difference is exactly the duplicated observation');
  const again = projectStats(f.store, { window: '7d' }); assert.equal(again.accounting.attemptWindow.invocations, 12); assert.equal(again.accounting.attemptWindow.duplicateObservations, 1);
});

test('with upkeep off nothing is counted, and a settlement reads and writes one day row by key when it is on', async t => {
  // Off: no day row, no mark on the attempt, and no statement that names an upkeep kind.
  const off = upkeepProject(t, { upkeep: null }), a = await modelAttempt(off, 'off'), probe = statements(off.store);
  off.engine.settle(a.flowId, a.attempt, receipt(a.attempt, { route: 'error', error: 'fictional', providerInvocations: [invocation(1), invocation(2)] }, 1));
  const quiet = probe.take(); probe.restore();
  assert.equal(off.store.count('upkeepDay'), 0); assert.equal(off.store.need('attempt', a.attempt.id).invocationsCounted, undefined); assert.equal(quiet.filter(row => row.args.some(value => /^upkeep/.test(String(value)))).length, 0);
  // On, with a large settled history: the same settlement, plus one read and one write of the day's row, both by key.
  const on = upkeepProject(t), put = on.store.db.prepare('INSERT INTO records VALUES(?,?,?)'); on.store.db.exec('BEGIN');
  for (let i = 0; i < 4000; i++) put.run('attempt', `old-attempt-${i}`, JSON.stringify({ id: `old-attempt-${i}`, flowId: `old-flow-${i % 400}`, step: 'review', status: 'passed', settledAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(), invocationsCounted: { day: '2026-01-01', count: 1, upkeep: false } }));
  for (let i = 0; i < 60; i++) put.run('upkeepDay', upkeepDayId(Date.now() - (i + 1) * DAY), JSON.stringify({ id: upkeepDayId(Date.now() - (i + 1) * DAY), invocations: 50, upkeepInvocations: 1 }));
  on.store.db.exec('COMMIT');
  const b = await modelAttempt(on, 'on'), watch = statements(on.store);
  on.engine.settle(b.flowId, b.attempt, receipt(b.attempt, { route: 'error', error: 'fictional', providerInvocations: [invocation(1), invocation(2)] }, 1));
  const busy = watch.take(); watch.restore();
  const shape = rows => rows.map(row => row.sql.replace(/\s+/g, ' ').trim()), added = shape(busy); for (const sql of shape(quiet)) { const at = added.indexOf(sql); assert.notEqual(at, -1, `the settlement no longer runs: ${sql}`); added.splice(at, 1); }
  const upkeepRows = busy.filter(row => row.args.includes('upkeepDay'));
  assert.deepEqual(upkeepRows.map(row => [/^\s*SELECT/i.test(row.sql) ? 'read' : 'write', row.args[0], row.args[1]]), [['read', 'upkeepDay', upkeepDayId()], ['write', 'upkeepDay', upkeepDayId()]]);
  assert.match(upkeepRows[0].sql, /WHERE kind=\? AND id=\?/); assert.deepEqual(added.filter(sql => /^SELECT/i.test(sql) && !/FROM meta/.test(sql)).length, 1, `one record read was added: ${added.join(' | ')}`);
  for (const sql of added) assert.doesNotMatch(sql, /json_extract|json_each|->>/, sql);
  assert.deepEqual(totals(on), [2, 0]);
});
