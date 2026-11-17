// Knowledge upkeep, slice 1: the record kinds, indexes and meta keys of design section 4, the
// access rule of 4.5 on a large settled history, verification of the new kind, and compatibility
// with the release before (state and graph digests). Everything is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sandbox, workflow } from './helpers.mjs';
import { releaseProject } from './history-fixtures.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { referenceWorkflow } from '../starter/factory/core/catalog.mjs';
import { KIND_INDEXES, STATE_INDEXES, UPKEEP_OBSERVED_KIND, VERIFIED_META } from '../starter/factory/core/records.mjs';
import { migrateStateLayout, stateLayout } from '../starter/factory/operations/state-layout.mjs';
import { lessonSignals } from '../starter/factory/operations/lesson-signals.mjs';
import * as upkeep from '../starter/factory/operations/upkeep-records.mjs';
import * as lifecycle from '../starter/factory/operations/upkeep-candidates.mjs';
import * as ceilings from '../starter/factory/operations/upkeep-ceilings.mjs';
import { upkeepHealthView } from '../starter/factory/operations/views.mjs';
import * as followUps from '../starter/factory/operations/upkeep-tasks.mjs';
import { findingTasks } from '../starter/factory/core/project.mjs';

// Since the baseline: slice 1's two, and slice 4's three over findings (the review of fb4949c, P2-1 and P2-2).
const NEW_INDEXES = ['records_open_task_lower_id', 'records_finding_open_upkeep', 'records_finding_tasked', 'records_finding_closed', 'records_upkeep_observed_first'];
const key = n => digest({ fictional: n }), iso = ms => new Date(ms).toISOString(), DAY = 86400000, T0 = Date.parse('2026-11-01T12:00:00.000Z');
const indexNames = store => store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='records' AND sql IS NOT NULL").all().map(row => row.name).sort();

test('the kinds, indexes and meta keys are declared, and a new database has them verified', t => {
  assert.deepEqual(upkeep.UPKEEP_KINDS, { run: 'upkeepRun', observed: 'upkeepObserved', day: 'upkeepDay', window: 'upkeepWindow', learningUse: 'learningUse' });
  // Slice 8, after its review: the learning-delivery totals (14.3) and what the last learnings.check read.
  assert.deepEqual(upkeep.UPKEEP_META, { work: 'upkeepWork', open: 'upkeepOpen', suspended: 'upkeepSuspended', learningDelivery: 'learningDelivery', learningsStore: 'learningsStore' });
  for (const name of NEW_INDEXES) assert.ok(STATE_INDEXES.some(index => index.name === name), name);
  // Each new index is limited to the kind it serves, so a write to any other kind evaluates neither.
  assert.match(STATE_INDEXES.find(index => index.name === NEW_INDEXES[0]).sql, /ON records\(kind, lower\(id\)\) WHERE kind='task' AND /);
  assert.match(STATE_INDEXES.find(index => index.name === 'records_upkeep_observed_first').sql, /WHERE kind='upkeepObserved'$/);
  for (const name of ['records_finding_open_upkeep', 'records_finding_tasked', 'records_finding_closed']) { assert.match(STATE_INDEXES.find(index => index.name === name).sql, /WHERE kind='finding' AND /, name); assert.ok(KIND_INDEXES.get('finding').includes(name), name); }
  assert.deepEqual(KIND_INDEXES.get(UPKEEP_OBSERVED_KIND), ['records_upkeep_observed_first']); assert.ok(KIND_INDEXES.get('task').includes('records_open_task_lower_id'));
  const f = sandbox(t);
  for (const name of NEW_INDEXES) assert.ok(indexNames(f.store).includes(name), name);
  assert.ok(f.store.meta(VERIFIED_META).kinds.includes(UPKEEP_OBSERVED_KIND));
  assert.deepEqual(upkeep.upkeepAccess(f.store), { available: true, unverified: [] }); assert.equal(upkeep.ensureUpkeepAccess(f.store), true);
  // Nothing exists until something writes it: the defaults say "no upkeep work" and "nothing open".
  assert.equal(upkeep.hasUpkeepWork(f.store), false); assert.deepEqual(upkeep.upkeepWork(f.store), { pending: 0, queued: 0, running: 0 });
  assert.deepEqual(upkeep.upkeepOpen(f.store), { docsTask: null, candidates: { docs: 0, context: 0, check: 0, rule: 0, learning: 0, 'learning-stale': 0 } });
  assert.deepEqual(upkeep.upkeepSuspensions(f.store), {}); assert.equal(upkeep.upkeepSuspended(f.store, 'docs'), null);
  for (const kind of Object.values(upkeep.UPKEEP_KINDS)) assert.equal(f.store.count(kind), 0, kind);
});

test('record contracts: one run per flow with deadlines that are never moved later, day counters, the bounded window, observed classes, learning use', t => {
  const f = sandbox(t), store = f.store, tx = fn => store.tx(fn);
  // upkeepRun: keyed by the source flow id; pendingUntil written once, runBy never later.
  const pendingUntil = iso(T0 + upkeep.UPKEEP_PENDING_MS), run = { id: 'flow-merged', status: 'pending', mergeCommit: 'a'.repeat(40), base: 'b'.repeat(40), target: 'main', pendingUntil };
  tx(() => upkeep.putUpkeepRunInTransaction(store, run)); assert.deepEqual(upkeep.upkeepRun(store, 'flow-merged'), run); assert.equal(store.count('upkeepRun'), 1);
  const runBy = iso(T0 + DAY); tx(() => upkeep.putUpkeepRunInTransaction(store, { ...run, status: 'queued', runBy }));
  assert.throws(() => tx(() => upkeep.putUpkeepRunInTransaction(store, { ...run, status: 'queued', runBy, pendingUntil: iso(T0 + 8 * DAY) })), /pendingUntil is written once/);
  assert.throws(() => tx(() => upkeep.putUpkeepRunInTransaction(store, { ...run, status: 'queued', runBy: iso(T0 + 2 * DAY) })), /runBy is never moved later/);
  assert.throws(() => tx(() => upkeep.putUpkeepRunInTransaction(store, { ...run, status: 'pending' })), /runBy is never moved later/, 'a requeue cannot drop the deadline');
  tx(() => upkeep.putUpkeepRunInTransaction(store, { ...run, status: 'queued', runBy: iso(T0 + DAY / 2) })); assert.equal(upkeep.upkeepRun(store, 'flow-merged').runBy, iso(T0 + DAY / 2), 'a shorter age shortens it');
  for (const bad of [{ ...run, id: 'bad id' }, { ...run, id: 'x', status: 'done' }, { ...run, id: 'x', pendingUntil: 'soon' }, { ...run, id: 'x', pendingUntil: undefined }]) assert.throws(() => tx(() => upkeep.putUpkeepRunInTransaction(store, bad)));
  assert.equal(store.count('upkeepRun'), 1, 'still one row for the flow');
  // upkeepDay: keyed by UTC date.
  assert.equal(upkeep.upkeepDayId(Date.parse('2026-11-16T23:59:59.999Z')), '2026-11-16'); assert.equal(upkeep.upkeepDayId(Date.parse('2026-11-17T00:00:00.000Z')), '2026-11-17');
  tx(() => upkeep.addToUpkeepDayInTransaction(store, '2026-11-16', { counters: { tasksCreated: 1, invocations: 5, upkeepInvocations: 1, modelRunsReserved: 1 }, outcomes: { nothing: 2, 'abstained:budget': 1 } }));
  tx(() => upkeep.addToUpkeepDayInTransaction(store, '2026-11-16', { counters: { modelRunsReserved: -1, modelRunsSettled: 1 } }));
  assert.deepEqual(upkeep.upkeepDay(store, '2026-11-16'), { id: '2026-11-16', modelRunsReserved: 0, modelRunsSettled: 1, tasksCreated: 1, operatorTasksCreated: 0, invocations: 5, upkeepInvocations: 1, outcomes: { nothing: 2, 'abstained:budget': 1 } });
  assert.throws(() => tx(() => upkeep.addToUpkeepDayInTransaction(store, '2026-11-16', { counters: { modelRunsReserved: -1 } })), /cannot go below zero/);
  assert.throws(() => tx(() => upkeep.addToUpkeepDayInTransaction(store, '2026-11-16', { counters: { spend: 1 } })), /unknown upkeep day counter/);
  for (const bad of ['2026-13-01', '16-11-2026', '2026-11-31', 'today']) assert.throws(() => upkeep.upkeepDay(store, bad), /UTC date/);
  // The weekly window: today's UTC day and the six before it, each by key; days never written read as zero.
  const week = upkeep.upkeepDays(store, { nowMs: Date.parse('2026-11-18T03:00:00.000Z') });
  assert.deepEqual(week.map(day => day.id), ['2026-11-18', '2026-11-17', '2026-11-16', '2026-11-15', '2026-11-14', '2026-11-13', '2026-11-12']);
  assert.equal(week.reduce((sum, day) => sum + day.tasksCreated, 0), 1); assert.equal(store.count('upkeepDay'), 1);
  // upkeepWindow: one row; the last 50 run outcomes and the last 20 disposed outputs per part.
  tx(() => { for (let i = 0; i < 60; i++) upkeep.addToUpkeepWindowInTransaction(store, { run: { flowId: `f${i}`, outcome: 'nothing' } }); for (let i = 0; i < 25; i++) upkeep.addToUpkeepWindowInTransaction(store, { disposed: { part: 'docs', id: `c${i}`, outcome: 'delivered' } }); });
  const window = upkeep.upkeepWindow(store); assert.equal(window.runs.length, 50); assert.equal(window.runs[0].flowId, 'f10'); assert.equal(window.disposed.docs.length, 20); assert.equal(window.disposed.docs[0].id, 'c5'); assert.deepEqual(window.disposed.capture, []);
  assert.equal(store.count('upkeepWindow'), 1); assert.throws(() => tx(() => upkeep.addToUpkeepWindowInTransaction(store, { disposed: { part: 'model', outcome: 'x' } })));
  // upkeepObserved: keyed by class key, first-observed time written once.
  const observed = { id: key('rule-a'), kind: 'rule', anchor: 'src/api', topic: 'test', sourceFlow: 'flow-1', firstObservedAt: iso(T0) };
  tx(() => upkeep.putObservedClassInTransaction(store, observed)); assert.deepEqual(upkeep.observedClass(store, observed.id), observed);
  assert.throws(() => tx(() => upkeep.putObservedClassInTransaction(store, { ...observed, firstObservedAt: iso(T0 + DAY) })), /written once/);
  assert.throws(() => tx(() => upkeep.putObservedClassInTransaction(store, { ...observed, id: 'not-a-class-key' })), /class key/);
  tx(() => upkeep.deleteObservedClassInTransaction(store, observed.id)); assert.equal(upkeep.observedClass(store, observed.id), undefined);
  // learningUse: keyed by learning id; counts only go up.
  tx(() => { upkeep.addLearningUseInTransaction(store, 'api-pagination', { selected: 1 }); upkeep.addLearningUseInTransaction(store, 'api-pagination', { selected: 1, cited: 1 }); });
  assert.deepEqual(upkeep.learningUse(store, 'api-pagination'), { id: 'api-pagination', selected: 2, cited: 1 }); assert.deepEqual(upkeep.learningUse(store, 'never-used'), { id: 'never-used', selected: 0, cited: 0 });
  assert.throws(() => tx(() => upkeep.addLearningUseInTransaction(store, 'api-pagination', { selected: -1 })), /only go up/);
});

// ---- Access paths over a large settled history (4.5) ----
// Settled history is written as this release stores it (attempts without their intent), through
// the store's own connection, so every index is maintained and every kind stays verified.
function history(t, { flows, attemptsPerFlow, findings, openAudit = 0, observedOld, namespaceHistory, days }) {
  const f = sandbox(t), db = f.store.db, put = db.prepare('INSERT INTO records VALUES(?,?,?)'), row = (kind, record) => put.run(kind, record.id, JSON.stringify(record));
  db.exec('BEGIN');
  for (let i = 0; i < flows; i++) {
    const flowId = `settled-flow-${i}`, taskId = `settled-task-${i}`, at = T0 - (flows - i) * 600000;
    row('task', { id: taskId, title: `Fictional settled change ${i}`, acceptance: ['Observed'], revision: key(taskId), approvedRevision: null, approvalVersion: 2, status: 'completed' });
    row('flow', { id: flowId, taskId, kind: 'change', state: 'completed', createdAt: iso(at), finishedAt: iso(at + 500000), results: { merge: { merged: true } } });
    for (let n = 0; n < attemptsPerFlow; n++) row('attempt', { id: `settled-attempt-${i}-${n}`, flowId, step: ['plan', 'build', 'review', 'gate'][n % 4], status: 'passed', createdAt: iso(at + n * 1000), settledAt: iso(at + n * 1000 + 900), costMicros: 0, receipt: { actionResult: { route: 'pass', summary: 'fictional summary '.repeat(20) } } });
    if (i % 3 === 0) row('pushback', { id: key(`pushback-${i}`), flowId, ruleId: 'fictional-rule', reason: 'Fictional cost', evidence: '{}', actor: 'builder', status: 'proposed' });
    row('upkeepRun', { id: flowId, status: 'closed', outcome: 'nothing', pendingUntil: iso(at + upkeep.UPKEEP_PENDING_MS), runBy: iso(at + DAY) });
  }
  // Settled candidates and audit findings: none is in the live set.
  for (let i = 0; i < findings; i++) row('finding', { id: key(`settled-finding-${i}`), source: i % 2 ? 'upkeep' : 'audit', kind: 'docs', title: `Fictional settled finding ${i}`, evidence: 'x', status: ['delivered', 'declined', 'expired', 'resolved-elsewhere', 'failed'][i % 5], version: 3, createdAt: iso(T0 - i * 60000), statusAt: iso(T0 - i * 60000) });
  // An open audit backlog: audit findings have no cap and no expiry, so it is as large as the project lets it grow.
  for (let i = 0; i < openAudit; i++) row('finding', { id: `audit:${key(`open-audit-${i}`)}`, source: 'audit', title: `Fictional open audit finding ${i}`, evidence: `src/file-${i}.js:1`, status: 'unapproved', version: 1, createdAt: iso(T0 - i * 1000) });
  // Observed classes long past their limit, and the day rows of earlier months.
  for (let i = 0; i < observedOld; i++) row(UPKEEP_OBSERVED_KIND, { id: key(`observed-old-${i}`), kind: i % 2 ? 'rule' : 'learning', anchor: 'src/api', topic: 'test', sourceFlow: `settled-flow-${i}`, firstObservedAt: iso(T0 - 200 * DAY - i * 3600000) });
  for (let i = 0; i < days; i++) row('upkeepDay', { id: upkeep.upkeepDayId(T0 - (i + 30) * DAY), modelRunsReserved: 0, modelRunsSettled: 3, tasksCreated: 1, invocations: 40, upkeepInvocations: 2, outcomes: { nothing: 9 } });
  // History in the reserved namespace, in every letter case: closed and completed tasks.
  for (let i = 0; i < namespaceHistory; i++) { const id = `${['upkeep:', 'Upkeep:', 'UPKEEP:'][i % 3]}history-${i}`; row('task', { id, title: 'Fictional history', acceptance: ['Observed'], revision: key(id), approvedRevision: null, approvalVersion: 1, ...(i % 2 ? { closed: true } : { status: 'completed' }) }); }
  // Current work, the same whatever the history: open candidates, young observed classes, open tasks in
  // the namespace, the current week's day rows, the window, and one flow with corrections on record.
  for (let i = 0; i < 7; i++) row('finding', { id: key(`open-finding-${i}`), source: 'upkeep', kind: 'context', title: `Fictional open proposal ${i}`, evidence: 'x', status: 'unapproved', version: 1, createdAt: iso(T0) });
  for (let i = 0; i < 4; i++) row(UPKEEP_OBSERVED_KIND, { id: key(`observed-young-${i}`), kind: 'rule', anchor: 'src/api', topic: 'test', sourceFlow: 'flow-current', firstObservedAt: iso(T0 - i * DAY) });
  for (let i = 0; i < 3; i++) row('task', { id: `Upkeep:open-${i}`, title: 'Fictional open collision', acceptance: ['Observed'], revision: key(`open-${i}`), approvedRevision: null, approvalVersion: 1 });
  for (let i = 0; i < 7; i++) row('upkeepDay', { id: upkeep.upkeepDayId(T0 - i * DAY), modelRunsReserved: 0, modelRunsSettled: 1, tasksCreated: i === 0 ? 1 : 0, invocations: 20, upkeepInvocations: 1, outcomes: {} });
  row('upkeepWindow', { id: 'window', runs: Array.from({ length: 50 }, (_, i) => ({ flowId: `settled-flow-${i}`, outcome: 'nothing' })), disposed: { docs: [], context: [], capture: [] } });
  const nodes = { 'fast-check': { kind: 'effect', action: { operation: 'fastCheck' } }, 'plan-review': { kind: 'effect', action: { operation: 'provider.planReview' } } };
  row('flow', { id: 'flow-current', taskId: 'task-1', kind: 'change', state: 'completed', createdAt: iso(T0), finishedAt: iso(T0 + 1000), workflow: { nodes }, results: {} });
  row('attempt', { id: 'current-1', flowId: 'flow-current', step: 'plan-review', status: 'passed', settledAt: iso(T0 + 1), receipt: { actionResult: { route: 'revise' } } });
  row('attempt', { id: 'current-2', flowId: 'flow-current', step: 'fast-check', status: 'passed', outcome: 'failed', failedChecks: [{ id: 'lint', status: 'failed' }], settledAt: iso(T0 + 2), receipt: { actionResult: { route: 'fail' } } });
  row('attempt', { id: 'current-3', flowId: 'flow-current', step: 'fast-check', status: 'passed', settledAt: iso(T0 + 3), receipt: { actionResult: { route: 'pass' } } });
  row('pushback', { id: key('pushback-current'), flowId: 'flow-current', ruleId: 'fictional-rule', reason: 'Fictional cost', evidence: '{}', actor: 'builder', status: 'proposed' });
  db.exec('COMMIT');
  f.store.setMeta('upkeepWork', { pending: 0, queued: 0, running: 0 }); f.store.setMeta('upkeepOpen', { docsTask: null, candidates: { context: 7 } });
  return f;
}
// Every statement a function runs, with its query plan: counted, never timed.
function probe(store) {
  let seen = []; const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    for (const name of ['all', 'get', 'run']) { const call = statement[name].bind(statement); statement[name] = (...args) => { const out = call(...args); seen.push({ sql, rows: Array.isArray(out) ? out.length : name === 'get' && out ? 1 : 0 }); return out; }; }
    return statement;
  };
  const plan = sql => /^\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA|SAVEPOINT|RELEASE)/i.test(sql) ? [] : prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(step => step.detail);
  return { take() { const statements = seen.map(row => ({ ...row, plan: plan(row.sql) })); seen = []; return statements; }, restore() { store.db.prepare = prepare; } };
}
// What 4.5 allows a read of records to be: one row by primary key, or a search of a declared index
// that is constrained beyond the kind, or the live set's partial index. Never a scan, never every
// record of a kind, never a sort of fetched rows, and a JSON expression only as the key of the
// declared index the statement names.
const BY_KEY = /^SEARCH records USING (COVERING )?INDEX sqlite_autoindex_records_1 \(kind=\? AND id=\?\)$/;
const DECLARED = new Map([
  ['records_live_finding', /^SEARCH records USING INDEX records_live_finding \(kind=\?\)$/],
  ['records_finding_open_upkeep', /^SEARCH records USING INDEX records_finding_open_upkeep \(kind=\?\)$/],
  ['records_finding_tasked', /^SEARCH records USING INDEX records_finding_tasked \(kind=\?\)$/],
  ['records_finding_closed', /^SEARCH records USING INDEX records_finding_closed \(kind=\?\)$/],
  ['records_flow_ref', /^SEARCH records USING INDEX records_flow_ref \(kind=\? AND <expr>=\?\)$/],
  ['records_upkeep_observed_first', /^SEARCH records USING INDEX records_upkeep_observed_first \(kind=\? AND <expr><\?\)$/],
  ['records_open_task_lower_id', /^SEARCH records USING INDEX records_open_task_lower_id \(kind=\? AND <expr>>\? AND <expr><\?\)$/],
]);
// Statements on the records table itself (not the schema reads that mention its name).
const ON_RECORDS = /\b(FROM|INTO|UPDATE) records\b/;
function assertAllowed(statements, label) {
  for (const { sql, plan } of statements) {
    if (/\bFROM meta\b|\bINTO meta\b/.test(sql)) { if (/^\s*SELECT/i.test(sql)) assert.deepEqual(plan, ['SEARCH meta USING INDEX sqlite_autoindex_meta_1 (key=?)'], `${label}: ${sql}`); continue; }
    if (!ON_RECORDS.test(sql) || /^\s*INSERT/i.test(sql)) continue;
    const named = /INDEXED BY (\w+)/.exec(sql)?.[1];
    assert.equal(plan.length, 1, `${label}: one step, no sort and no second read: ${plan.join(' | ')} for ${sql}`);
    if (/json_extract|json_each|->/.test(sql)) { assert.ok(DECLARED.has(named), `${label}: a JSON expression only through a declared index: ${sql}`); assert.match(plan[0], DECLARED.get(named), `${label}: ${sql}`); }
    else assert.match(plan[0], named ? DECLARED.get(named) ?? /never/ : BY_KEY, `${label}: ${sql}`);
  }
}
const records = statements => statements.filter(row => ON_RECORDS.test(row.sql)), readsOf = (statements, kind) => records(statements).filter(row => row.sql.includes(`kind='${kind}'`));

const SMALL = { flows: 40, attemptsPerFlow: 10, findings: 30, openAudit: 10, observedOld: 60, namespaceHistory: 30, days: 10 };
const LARGE = { flows: 3000, attemptsPerFlow: 10, findings: 2500, openAudit: 1000, observedOld: 150, namespaceHistory: 900, days: 300 };
// The operations of 4.5 that this release defines, each as the reads it makes: `rows` from the
// records table and `meta` reads of the meta table. A read through an index also reads the record of
// which kinds are verified (one meta row), as every targeted read of the store does.
const OPERATIONS = {
  'an operations tick with no upkeep work: one meta read': { run: s => upkeep.hasUpkeepWork(s), rows: 0, meta: 1 },
  'the run of a flow, by key': { run: s => upkeep.upkeepRun(s, 'settled-flow-7'), rows: 1 },
  'writing a run: the row by key, and the upkeepWork meta row that tracks it': { run: s => { const run = upkeep.upkeepRun(s, 'settled-flow-7'); return s.tx(() => upkeep.putUpkeepRunInTransaction(s, { ...run, status: 'closed' })); }, rows: 2, meta: 1 },
  'the day row, by key': { run: s => upkeep.upkeepDay(s, upkeep.upkeepDayId(T0)), rows: 1 },
  'the weekly task window and the share ceiling: seven day rows by key': { run: s => upkeep.upkeepDays(s, { nowMs: T0 }), rows: 7, selects: 7 },
  'a day counter: the row by key': { run: s => s.tx(() => upkeep.addToUpkeepDayInTransaction(s, upkeep.upkeepDayId(T0), { counters: { invocations: 1 } })), rows: 1 },
  'the window, by key': { run: s => upkeep.upkeepWindow(s), rows: 1 },
  'a candidate write: the class key by key, in finding and in upkeepObserved': { run: s => [upkeep.upkeepCandidate(s, key('open-finding-1')), upkeep.observedClass(s, key('observed-young-1')), upkeep.upkeepCandidate(s, key('never-seen')), upkeep.observedClass(s, key('never-seen'))], rows: 2, selects: 4 },
  'the open candidates: their own partial index, not the open audit backlog': { run: s => upkeep.openUpkeepCandidates(s), rows: 7, meta: 1, returns: 7 },
  'expiry of observed classes: an indexed range read of at most 50 rows': { run: s => upkeep.observedBefore(s, iso(T0 - 90 * DAY)), rows: 50, meta: 1, returns: 50 },
  'the namespace collision check: at most 13 open tasks': { run: s => upkeep.openNamespaceTasks(s), rows: 3, meta: 1, returns: 3 },
  'why upkeep cannot be turned on': { run: s => upkeep.namespaceCollisionReasons(s), rows: 3, meta: 1 },
  'the open counts and the suspensions: meta reads': { run: s => [upkeep.upkeepOpen(s), upkeep.upkeepSuspensions(s), upkeep.upkeepSuspended(s, 'docs')], rows: 0, meta: 3 },
  'lesson signals: the flow by key and its attempts and pushback by flow id': { run: s => lessonSignals({ flow: s.need('flow', 'flow-current'), attempts: s.by('attempt', 'flowId', 'flow-current'), pushback: s.by('pushback', 'flowId', 'flow-current') }).signals.map(row => row.kind), rows: 5, meta: 2, returns: 3 },
};

test('on a large settled history every upkeep read is by key or through a declared index, and reads what it read on a small one', t => {
  const small = history(t, SMALL), large = history(t, LARGE);
  assert.ok(large.store.count('attempt') >= 30000 && large.store.count('flow') >= 3000 && large.store.count('finding') >= 2500, 'tens of thousands of attempts, thousands of flows and settled findings');
  assert.equal(large.store.count(UPKEEP_OBSERVED_KIND), 154); assert.equal(large.store.db.prepare("SELECT count(*) AS n FROM records WHERE kind='task' AND lower(id) LIKE 'upkeep:%'").get().n, 903);
  assert.deepEqual(upkeep.upkeepAccess(large.store), { available: true, unverified: [] });
  const measured = {};
  for (const [name, f] of [['small', small], ['large', large]]) {
    const watch = probe(f.store); measured[name] = {};
    for (const [label, operation] of Object.entries(OPERATIONS)) {
      const result = operation.run(f.store), statements = watch.take(), selects = records(statements).filter(row => /^\s*SELECT/i.test(row.sql)), rows = selects.reduce((sum, row) => sum + row.rows, 0), meta = statements.filter(row => /^\s*SELECT .* FROM meta\b/i.test(row.sql)).length;
      assertAllowed(statements, `${name}: ${label}`);
      assert.equal(rows, operation.rows, `${name}: ${label}: rows read from records`);
      assert.equal(meta, operation.meta ?? 0, `${name}: ${label}: meta reads`);
      if (operation.selects !== undefined) assert.equal(selects.length, operation.selects, `${name}: ${label}: statements`);
      if (operation.returns !== undefined) assert.equal(result.length, operation.returns, `${name}: ${label}`);
      // Statements on the records and meta tables (the schema is re-read once per connection, not per operation).
      measured[name][label] = { statements: statements.filter(row => ON_RECORDS.test(row.sql) || /\b(FROM|INTO) meta\b/.test(row.sql)).length, rows, meta };
    }
    watch.restore();
  }
  // The check itself refuses what 4.5 forbids: every record of a kind, and the general reads' fallback.
  { const watch = probe(large.store); large.store.stored('finding'); assert.throws(() => assertAllowed(watch.take(), 'a whole kind'), /a whole kind/); large.store.db.prepare("SELECT data FROM records WHERE kind='finding' AND json_extract(data,'$.source')='upkeep'").all(); assert.throws(() => assertAllowed(watch.take(), 'a JSON predicate'), /a JSON expression only through a declared index/); watch.restore(); }
  // Seventy-five times the flows and attempts: the same statements and the same rows.
  assert.deepEqual(measured.large, measured.small);
  const store = large.store, watch = probe(store);
  // The observed-class expiry reads oldest first, only observed classes, and never the finding set.
  const expired = upkeep.observedBefore(store, iso(T0 - 90 * DAY)); let statements = records(watch.take());
  assert.deepEqual(expired.map(row => row.firstObservedAt), [...expired.map(row => row.firstObservedAt)].sort()); assert.ok(expired.every(row => Date.parse(row.firstObservedAt) < T0 - 90 * DAY));
  assert.equal(expired[0].id, key('observed-old-149'), 'the oldest first'); assert.equal(readsOf(statements, 'finding').length, 0); assert.equal(statements.length, 1);
  assert.equal(upkeep.observedBefore(store, iso(T0 - 90 * DAY), 5).length, 5); assert.throws(() => upkeep.observedBefore(store, iso(T0), 51), /at most 50 rows/); watch.take();
  // The collision lookup uses the reservation's own predicate: Upkeep:open-N is in the range, and none of the 900 closed or completed tasks is read.
  const open = upkeep.openNamespaceTasks(store); statements = records(watch.take());
  assert.deepEqual(open.map(task => task.id), ['Upkeep:open-0', 'Upkeep:open-1', 'Upkeep:open-2']); assert.equal(statements[0].rows, 3); assert.match(statements[0].sql, /LIMIT 13$/);
  // With more open collisions than the bound, thirteen rows are read and no more.
  store.tx(() => { for (let i = 0; i < 40; i++) store.put('task', { id: `${['upkeep:', 'UPKEEP:'][i % 2]}many-${i}`, title: 'Fictional', acceptance: ['Observed'], revision: key(`many-${i}`), approvedRevision: null, approvalVersion: 1 }); }); watch.take();
  assert.equal(upkeep.openNamespaceTasks(store).length, 13); statements = records(watch.take()); assert.equal(statements.length, 1); assert.equal(statements[0].rows, 13); assertAllowed(statements, 'the bounded collision lookup');
  assert.equal(upkeep.namespaceCollisionReasons(store).length, 1); assert.equal(records(watch.take())[0].rows, 13);
  watch.restore();
});

// Slice 4: the candidate lifecycle, the ceilings and Health, measured the same way. Each reads rows by
// key, the window row, the day rows by key, meta rows and the two declared indexes, and nothing that
// grows with settled history.
const ON = { upkeep: { mode: 'observe' } };
const noTasks = { get: () => null, busy: () => null, started: () => false, close() { throw new Error('no task is closed here'); } };
const LIFECYCLE = {
  'raising a docs candidate below its cap: the class key by key': s => s.tx(() => lifecycle.raiseCandidatesInTransaction(s, { flowId: 'flow-source', candidates: [{ kind: 'docs', file: 'README.md', quote: 'Fictional statement', reason: 'x' }], nowMs: T0, config: ON })),
  'raising a rule from its first and second flow: by key in finding and upkeepObserved': s => s.tx(() => [lifecycle.raiseCandidatesInTransaction(s, { flowId: 'flow-one', candidates: [{ kind: 'rule', anchor: 'context:rules', topic: 'procedure', title: 'Fictional', text: 'Fictional rule.', reason: 'x' }], nowMs: T0, config: ON }), lifecycle.raiseCandidatesInTransaction(s, { flowId: 'flow-two', candidates: [{ kind: 'rule', anchor: 'context:rules', topic: 'procedure', title: 'Fictional', text: 'Fictional rule.', reason: 'x' }], nowMs: T0, config: ON })]),
  'declining an open candidate: the row by key, its window and the suspensions': s => s.tx(() => lifecycle.disposeFindingInTransaction(s, { id: key('open-finding-1'), expectedVersion: 1, disposition: 'declined', reason: 'wrong', by: { actor: 'operator' }, tasks: noTasks, nowMs: T0 })),
  'reopening it: the row by key and the open counts': s => s.tx(() => lifecycle.reopenFindingInTransaction(s, { id: key('open-finding-1'), expectedVersion: 2, note: 'Again', by: { actor: 'operator' }, nowMs: T0, config: ON })),
  'a run\'s ceilings: the window row, the suspensions, seven day rows by key': s => s.tx(() => ceilings.evaluateRunCeilingsInTransaction(s, { nowMs: T0, config: ON })),
  'expiry of observed classes: one indexed range read, no finding': s => s.tx(() => lifecycle.expireObservedClassesInTransaction(s, { nowMs: T0 })),
  'lifting a suspension: meta and the notice by key': s => s.tx(() => { upkeep.recordUpkeepSuspensionInTransaction(s, { part: 'capture', rule: 'fictional', reason: 'Fictional' }); return ceilings.liftUpkeepCeilingInTransaction(s, { part: 'capture', note: 'Fictional', by: 'operator', nowMs: T0 }); }),
  'Health: no record read of its own': s => upkeepHealthView(s, { findings: [] }),
  // dev.93 (decided after the review of e58abd1): with upkeep on, Health reads the share's window row
  // and seven day rows by key, and nothing that grows with history.
  'Health with upkeep on: the share\'s eight rows by key': s => { const before = s.meta('config'); s.setMeta('config', { ...before, ...ON }); try { return upkeepHealthView(s, { findings: [] }); } finally { s.setMeta('config', before); } },
  // Review of fb4949c, P2-1: at a cap the open candidates are read through their own index, whatever the open audit backlog.
  'raising a context candidate at its cap: the open candidates, not the open audit backlog': s => s.tx(() => lifecycle.raiseCandidatesInTransaction(s, { flowId: 'flow-cap', candidates: [{ kind: 'context', file: 'AGENTS.md', quote: 'Fictional rule text', replacement: 'Fictional replacement.', reason: 'x' }], nowMs: T0, config: { upkeep: { mode: 'observe', context: { maxOpen: 7 } } } })),
};

test('slice 4 on a large settled history: the lifecycle, the ceilings and Health read only by key or through a declared index, and read what they read on a small one', t => {
  const stores = { small: history(t, SMALL), large: history(t, LARGE) }, measured = {};
  for (const [name, f] of Object.entries(stores)) {
    f.store.tx(() => upkeep.addToUpkeepWindowInTransaction(f.store, { counting: iso(T0 - 60 * DAY) }));
    const watch = probe(f.store); measured[name] = {};
    for (const [label, run] of Object.entries(LIFECYCLE)) {
      run(f.store); const statements = watch.take(), selects = records(statements).filter(row => /^\s*SELECT/i.test(row.sql));
      assertAllowed(statements, `${name}: ${label}`);
      measured[name][label] = { statements: selects.length, rows: selects.reduce((sum, row) => sum + row.rows, 0), kinds: [...new Set(selects.map(row => /kind='([^']+)'/.exec(row.sql)?.[1] ?? 'by key'))].sort() };
    }
    watch.restore();
  }
  assert.deepEqual(measured.large, measured.small);
  // What each reads, on either history.
  const of = label => measured.large[label];
  assert.deepEqual(of('expiry of observed classes: one indexed range read, no finding').kinds, [UPKEEP_OBSERVED_KIND]);
  assert.equal(of('a run\'s ceilings: the window row, the suspensions, seven day rows by key').statements, 8, 'the window row and seven day rows');
  assert.deepEqual(of('Health: no record read of its own'), { statements: 0, rows: 0, kinds: [] });
  assert.deepEqual(of('Health with upkeep on: the share\'s eight rows by key'), { statements: 8, rows: 1, kinds: ['by key'] }, 'the window row (written above) and seven day rows, none stored');
  // At the cap: nine open candidates (seven proposals, a docs candidate and a rule raised above) and none of the 1,000 open audit findings.
  const cap = 'raising a context candidate at its cap: the open candidates, not the open audit backlog';
  assert.deepEqual(of(cap).kinds, ['by key', 'finding']); assert.ok(of(cap).rows < 30, `rows read at the cap: ${of(cap).rows}`);
  assert.equal(stores.large.store.live('finding').length, 1000 + 9, 'the open audit backlog is there, beside the nine open candidates');
  assert.equal(stores.large.store.need('finding', key('open-finding-0')).disposition.reason, 'cap', 'the oldest proposal was pushed out');
  for (const label of Object.keys(LIFECYCLE).filter(label => !/expiry of observed|at its cap/.test(label))) assert.ok(!of(label).kinds.some(kind => kind !== 'by key'), `${label}: by key only (${of(label).kinds})`);
});

// Slice 5 part B: creating a docs follow-up reads the open follow-up and its task by key, seven day
// rows by key, the open upkeep tasks through the namespace index (at most 13 rows), and the open
// candidates through their own index; the source run and flow by key. The target head is read from
// Git (here a scripted head). Nothing grows with settled history.
test('slice 5 part B on a large settled history: creating a docs follow-up, and looking for one with nothing waiting, read only by key or through a declared index', t => {
  const stores = { small: history(t, SMALL), large: history(t, LARGE) }, measured = {}, text = 'Fictional readme.\nThe user API lives in src/api/users.js.\n';
  const reader = { head: 'c'.repeat(40), reaches: () => true, file: path => path === 'README.md' ? { status: 'docs', blob: 'b'.repeat(40), text } : { status: 'missing' } };
  for (const [name, f] of Object.entries(stores)) {
    const s = f.store, config = { ...s.meta('config'), upkeep: { mode: 'propose', docs: { include: ['README.md'] } } }; s.setMeta('config', config);
    s.tx(() => lifecycle.raiseCandidatesInTransaction(s, { flowId: 'settled-flow-7', candidates: [{ kind: 'docs', file: 'README.md', quote: 'The user API lives in src/api/users.js.', reason: 'x', blob: 'b'.repeat(40) }], nowMs: T0 + 1000, config }));
    const watch = probe(s); measured[name] = {};
    const steps = {
      'creating a follow-up': () => s.tx(() => followUps.createDocsFollowUpInTransaction(s, { reader, tasks: findingTasks(s), nowMs: T0 + 2000, config })),
      'looking again while one is open': () => s.tx(() => followUps.createDocsFollowUpInTransaction(s, { reader, tasks: findingTasks(s), nowMs: T0 + 3000, config })),
      'a settlement with nothing waiting: meta reads and the open follow-up by key': () => s.tx(() => followUps.tryDocsFollowUpInTransaction(s, { tasks: findingTasks(s), nowMs: T0 + 3000, config, reader })),
    };
    for (const [label, run] of Object.entries(steps)) {
      const result = run(), statements = watch.take(), selects = records(statements).filter(row => /^\s*SELECT/i.test(row.sql));
      assertAllowed(statements, `${name}: ${label}`);
      measured[name][label] = { statements: selects.length, rows: selects.reduce((sum, row) => sum + row.rows, 0), kinds: [...new Set(selects.map(row => /kind='([^']+)'/.exec(row.sql)?.[1] ?? 'by key'))].sort(), result: result?.task ? 'created' : result?.reason ?? null };
    }
    watch.restore();
  }
  assert.deepEqual(measured.large, measured.small);
  assert.equal(measured.large['creating a follow-up'].result, 'created'); assert.deepEqual(measured.large['creating a follow-up'].kinds, ['by key', 'finding', 'task']);
  assert.equal(measured.large['looking again while one is open'].result, 'open-follow-up'); assert.deepEqual(measured.large['looking again while one is open'].kinds, ['by key']);
  assert.deepEqual(measured.large['a settlement with nothing waiting: meta reads and the open follow-up by key'].kinds, ['by key']);
});

test('an unverified kind suspends upkeep with a health reason; nothing reads the whole kind instead', t => {
  // A state as the release before the record layout wrote it, with one finding SQL and JSON.parse read differently.
  const f = releaseProject(t), raw = new DatabaseSync(join(f.stateDir, 'state.sqlite'));
  raw.prepare('INSERT INTO records VALUES(?,?,?)').run('finding', 'duplicated', '{"id":"duplicated","status":"unapproved","status":"declined","title":"Fictional","evidence":"x"}');
  for (let i = 0; i < 200; i++) raw.prepare('INSERT INTO records VALUES(?,?,?)').run('finding', key(`f-${i}`), JSON.stringify({ id: key(`f-${i}`), status: i < 3 ? 'unapproved' : 'declined', title: 'Fictional', evidence: 'x' }));
  raw.close();
  const store = new Store(f.stateDir); t.after(() => store.close());
  assert.deepEqual(Object.keys(migrateStateLayout(store).unverifiedKinds), ['finding']); assert.equal(store.verified('finding'), false);
  assert.deepEqual(upkeep.upkeepAccess(store), { available: false, unverified: ['finding'] });
  const watch = probe(store);
  assert.throws(() => upkeep.openUpkeepCandidates(store), error => error instanceof upkeep.UpkeepAccessUnavailable && /does not read a whole kind instead/.test(error.message) && error.kinds.join() === 'finding');
  assert.equal(readsOf(watch.take(), 'finding').length, 0, 'the finding kind was not read at all');
  // The general read would have parsed all 201 findings; upkeep's does not exist in that form.
  assert.equal(store.live('finding').length, 201); assert.ok(watch.take().some(row => row.rows === 201));
  // Reads of kinds that are verified still work; the suspension is for upkeep as a whole.
  assert.deepEqual(upkeep.openNamespaceTasks(store), []); assert.deepEqual(upkeep.observedBefore(store, iso(T0)), []); watch.take();
  assert.equal(upkeep.ensureUpkeepAccess(store), false);
  const suspension = upkeep.upkeepSuspended(store, 'model');
  assert.equal(suspension.part, 'all'); assert.equal(suspension.rule, 'unverified-kind'); assert.deepEqual(suspension.window, { kinds: ['finding'] }); assert.match(suspension.reason, /finding/);
  for (const part of upkeep.UPKEEP_PARTS) assert.deepEqual(upkeep.upkeepSuspended(store, part), suspension, `everything is suspended: ${part}`);
  assert.equal(readsOf(watch.take(), 'finding').length, 0);
  const notices = () => store.all('inbox').filter(item => item.id.startsWith('upkeep-suspended:'));
  assert.equal(notices().length, 1); assert.equal(notices()[0].role, 'operator');
  // Asked again, it is still suspended, with one record and one notice. Nothing here lifts it, even once the kind is repaired.
  assert.equal(upkeep.ensureUpkeepAccess(store), false); assert.equal(notices().length, 1); assert.equal(upkeep.upkeepSuspended(store, 'all').at, suspension.at);
  store.db.prepare("DELETE FROM records WHERE kind='finding' AND id='duplicated'").run(); migrateStateLayout(store);
  assert.equal(store.verified('finding'), true); assert.equal(upkeep.ensureUpkeepAccess(store), true); assert.deepEqual(upkeep.openUpkeepCandidates(store), [], 'three open findings, none of them an upkeep candidate'); assert.equal(store.live('finding').length, 3);
  assert.equal(upkeep.upkeepSuspended(store, 'docs').rule, 'unverified-kind', 'a suspension is lifted only by the operator');
  watch.restore();
});

// ---- Compatibility with the release before ----
// The release this change is built on (main at c523d2c), extracted from repository history.
// Without the history (a source archive, a shallow clone) the checks that need it are skipped
// visibly; nothing weaker is silently substituted.
const BASELINE = 'c523d2c';
async function baselineRuntime(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fct-base-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  try { execFileSync('sh', ['-c', `git archive ${BASELINE} starter | tar -x -C "$1"`, 'sh', dir], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' }); }
  catch (error) { return { skip: `the baseline runtime ${BASELINE} is not in this checkout's git history (${String(error.stderr || error.message).trim().split('\n')[0]})` }; }
  const load = path => import(pathToFileURL(join(dir, 'starter/factory', path)).href);
  return { dir, ...(await load('core/store.mjs')), ...(await load('operations/state-layout.mjs')), executeCommand: (await load('core/project.mjs')).executeCommand, records: await load('core/records.mjs'), referenceWorkflow: (await load('core/catalog.mjs')).referenceWorkflow, validateConfig: (await load('core/configuration.mjs')).validateConfig, digest: (await load('core/contracts.mjs')).digest };
}
const put = (execute, store, id, n) => execute(store, { protocolVersion: 1, projectId: store.meta('project').projectId, commandId: `put-${n}`, actor: 'operator', operation: 'task.put', payload: { task: { id, title: `Fictional ${id}`, acceptance: ['Observed'] } } });

test('a state the release before wrote: the new indexes and the new kind\'s verification arrive with the layout step, and every read answers the same meanwhile', async t => {
  const base = await baselineRuntime(t); if (base.skip) return t.skip(base.skip);
  const dir = mkdtempSync(join(tmpdir(), 'fct-up-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'), stateDir = join(dir, 'state'); mkdirSync(root); writeFileSync(join(root, 'input.txt'), 'fictional\n');
  for (const args of [['init', '-q'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['add', '.'], ['commit', '-qm', 'Fictional baseline']]) execFileSync('git', args, { cwd: root });
  base.initProject({ stateDir, root, name: 'Fictional project', workflow: workflow([process.execPath, '-e', '0']), supervisor: 'process' });
  const older = new base.Store(stateDir);
  assert.equal(put(base.executeCommand, older, 'ordinary-1', 1).status, 'completed'); assert.equal(put(base.executeCommand, older, 'Upkeep:legacy', 2).status, 'completed', 'the release before has no reservation');
  assert.equal(older.meta(VERIFIED_META).kinds.includes(UPKEEP_OBSERVED_KIND), false); older.close();
  const store = new Store(stateDir); t.after(() => store.close());
  // Before the layout step: the task and finding kinds are not verified by this release (indexes are missing), so
  // general reads parse the kind, as they do for any database without an index, and upkeep's reads refuse.
  assert.deepEqual(stateLayout(store).missingIndexes, NEW_INDEXES); assert.equal(store.verified('task'), false); assert.equal(store.verified('flow'), true);
  assert.deepEqual(store.live('task').map(task => task.id), ['ordinary-1', 'Upkeep:legacy']);
  assert.deepEqual(upkeep.upkeepAccess(store).unverified, ['finding', 'task', UPKEEP_OBSERVED_KIND]); assert.throws(() => upkeep.openNamespaceTasks(store), upkeep.UpkeepAccessUnavailable); assert.throws(() => upkeep.openUpkeepCandidates(store), upkeep.UpkeepAccessUnavailable);
  // The layout step (the project service runs it when it starts) builds the five indexes and verifies the new kind.
  const migrated = migrateStateLayout(store);
  assert.deepEqual(migrated.indexes, NEW_INDEXES); assert.equal(migrated.changed, true); assert.equal(migrated.movedIntents, 0); assert.equal(migrated.fenceInstalled, undefined);
  assert.ok(store.meta(VERIFIED_META).kinds.includes(UPKEEP_OBSERVED_KIND)); assert.equal(stateLayout(store).current, true);
  assert.deepEqual(upkeep.upkeepAccess(store), { available: true, unverified: [] });
  assert.deepEqual(store.live('task').map(task => task.id), ['ordinary-1', 'Upkeep:legacy']);
  // The task the earlier release created in the namespace is found as what it is: an ordinary open task that blocks turning upkeep on.
  assert.match(upkeep.namespaceCollisionReasons(store)[0], /Upkeep:legacy/); assert.equal(upkeep.isUpkeepTask(store.need('task', 'Upkeep:legacy')), false);
  assert.equal(migrateStateLayout(store).changed, false, 'a second run has nothing to do');
});

test('going back: the release before reads and writes a state that has the new indexes and kinds, and the indexes stay correct', async t => {
  const base = await baselineRuntime(t); if (base.skip) return t.skip(base.skip);
  const f = sandbox(t), { store, stateDir } = f;
  store.tx(() => { upkeep.putObservedClassInTransaction(store, { id: key('observed-1'), kind: 'rule', anchor: 'src', topic: 'test', firstObservedAt: iso(T0) }); upkeep.addToUpkeepDayInTransaction(store, '2026-11-16', { counters: { invocations: 3 } }); store.put('finding', { id: key('candidate-1'), source: 'upkeep', kind: 'docs', title: 'Fictional', evidence: 'x', status: 'unapproved', version: 1 }); });
  const before = indexNames(store);
  // The release before, on the same database.
  const older = new base.Store(stateDir);
  assert.equal(base.stateLayout(older).current, true); assert.deepEqual(base.stateLayout(older).missingIndexes, []);
  assert.equal(base.migrateStateLayout(older).changed, false, 'its layout step leaves the state alone');
  for (const kind of ['task', 'flow', 'attempt', 'finding']) assert.equal(older.verified(kind), true, kind);
  assert.deepEqual(older.live('task').map(task => task.id), ['task-1']); assert.deepEqual(older.live('finding').map(row => row.id), [key('candidate-1')]);
  // It writes tasks: SQLite maintains the indexes it does not know, including the one over open tasks.
  assert.equal(put(base.executeCommand, older, 'older-ordinary', 1).status, 'completed'); assert.equal(put(base.executeCommand, older, 'UPKEEP:from-older', 2).status, 'completed');
  assert.deepEqual(older.live('task').map(task => task.id), ['task-1', 'older-ordinary', 'UPKEEP:from-older']);
  assert.deepEqual(indexNames(older), before, 'it neither drops nor rebuilds an index it does not know'); older.close();
  // Back on this release: still verified, and the lookup sees the task the older runtime wrote.
  assert.deepEqual(upkeep.upkeepAccess(store), { available: true, unverified: [] });
  assert.deepEqual(upkeep.openNamespaceTasks(store).map(task => task.id), ['UPKEEP:from-older']); assert.equal(upkeep.observedBefore(store, iso(T0 + 1)).length, 1);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  // If the release before re-records verification (it names only the kinds it knows), this release
  // does not trust the new kind until its own layout step has checked it again.
  const record = store.meta(VERIFIED_META); store.setMeta(VERIFIED_META, { ...record, kinds: record.kinds.filter(kind => kind !== UPKEEP_OBSERVED_KIND) });
  assert.equal(store.verified(UPKEEP_OBSERVED_KIND), false); assert.throws(() => upkeep.observedBefore(store, iso(T0 + 1)), upkeep.UpkeepAccessUnavailable);
  const again = migrateStateLayout(store); assert.deepEqual(again.indexes, []); assert.equal(again.changed, true); assert.equal(store.verified(UPKEEP_OBSERVED_KIND), true);
  // The release before returns the state to the inline layout (its `layout inline`): the fence goes and
  // it drops the indexes it knows. The five it does not know remain, vouching for nothing: without the
  // fence this release verifies no kind, and its next layout step drops and rebuilds them.
  const inliner = new base.Store(stateDir); assert.equal(base.inlineAttemptIntents(inliner).fenceRemoved, true); inliner.close();
  assert.deepEqual(indexNames(store), [...NEW_INDEXES].sort()); assert.equal(store.verified('task'), false); assert.equal(upkeep.upkeepAccess(store).available, false);
  const plain = new DatabaseSync(join(stateDir, 'state.sqlite')); plain.prepare('INSERT INTO records VALUES(?,?,?)').run('task', 'upkeep:unfenced', JSON.stringify({ id: 'upkeep:unfenced', title: 'Fictional', acceptance: ['Observed'], revision: 'r', approvedRevision: null })); plain.close();
  const rebuilt = migrateStateLayout(store);
  assert.equal(rebuilt.fenceInstalled, true); for (const name of NEW_INDEXES) assert.ok(rebuilt.indexes.includes(name), name);
  assert.deepEqual(upkeep.openNamespaceTasks(store).map(task => task.id), ['UPKEEP:from-older', 'upkeep:unfenced']);
});

// The reference graph digests at the baseline, for the starter template and three variants of it.
// Nothing in this change may move them: approvals are pinned to them.
const DIGESTS = {
  template: { 'change.standard': '8fe93dd6307b85bbe11b84ef284ac97837d9c1bd55108a6bfb435fddf8ae9e5d', 'change.document': '6775d029b5bd63b25a39423d506442d96f0c294ddbadb921a3f46c8c7feff12e', 'task.orchestrator': '1148428f3794f06c80fad3b4a838e83e1618f8ccf2ec12d51daaf73770e9f6a6' },
  'fast checks': { 'change.standard': '9986d5af5a1ba71160fbd2a3e7443871d87c3e4f584eb239a84157b1e4b01cd9', 'change.document': '6775d029b5bd63b25a39423d506442d96f0c294ddbadb921a3f46c8c7feff12e', 'task.orchestrator': '1148428f3794f06c80fad3b4a838e83e1618f8ccf2ec12d51daaf73770e9f6a6' },
  'no planning': { 'change.standard': 'e2afda81eda4b2314b8097b155688be4bb0586dc66ff9df221353b185881eeed', 'change.document': 'c01a356c30a14f38bc3ff46fd71f96c16a8548c5189a6debb7efdbace6c20d64', 'task.orchestrator': '1148428f3794f06c80fad3b4a838e83e1618f8ccf2ec12d51daaf73770e9f6a6' },
  'upkeep and learnings blocks': { 'change.standard': '8fe93dd6307b85bbe11b84ef284ac97837d9c1bd55108a6bfb435fddf8ae9e5d', 'change.document': '6775d029b5bd63b25a39423d506442d96f0c294ddbadb921a3f46c8c7feff12e', 'task.orchestrator': '1148428f3794f06c80fad3b4a838e83e1618f8ccf2ec12d51daaf73770e9f6a6' },
};
const VARIANTS = {
  template: config => config,
  'fast checks': config => ({ ...config, fastChecks: { checks: [{ id: 'lint', argv: ['node', 'checks/lint.mjs'], timeoutMs: 60000 }] } }),
  'no planning': config => ({ ...config, policy: { ...config.policy, planning: false } }),
  'upkeep and learnings blocks': config => ({ ...config, upkeep: { mode: 'observe', docs: { include: ['README.md'] } }, learnings: { dir: 'docs/learnings' } }),
};
const graphDigests = (api, template) => Object.fromEntries(Object.entries(VARIANTS).map(([name, make]) => { const config = api.validateConfig(make(structuredClone(template))); return [name, Object.fromEntries(Object.keys(DIGESTS.template).map(reference => [reference, api.digest(api.referenceWorkflow(reference, config))]))]; }));
test('the reference graph digests are the baseline\'s, with the upkeep and learnings blocks present or absent', async t => {
  const template = JSON.parse(readFileSync(new URL('../starter/project/factotum.template.json', import.meta.url), 'utf8'));
  assert.deepEqual(graphDigests({ validateConfig, referenceWorkflow, digest }, template), DIGESTS);
  assert.deepEqual(DIGESTS['upkeep and learnings blocks'], DIGESTS.template);
  const base = await baselineRuntime(t); if (base.skip) return t.diagnostic(`pinned digests checked; ${base.skip}`);
  const baselineTemplate = JSON.parse(readFileSync(join(base.dir, 'starter/project/factotum.template.json'), 'utf8'));
  assert.deepEqual(graphDigests(base, baselineTemplate), DIGESTS, 'the pinned values are what the baseline runtime computes');
  assert.deepEqual(graphDigests({ validateConfig, referenceWorkflow, digest }, baselineTemplate), DIGESTS);
});
