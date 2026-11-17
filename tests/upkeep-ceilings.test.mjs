// Knowledge upkeep, slice 4: caps and expiry (design 8.3), the windows and suspension (8.3, 8.4).
// Each ceiling suspends its part at exactly the stated count, a suspension is lifted only by the
// operator, the seven-day share uses complete days only, and observed classes expire through their
// own index without reading the finding set. Everything is fictional; the model is scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { upkeepProject, scriptedModel, write } from './upkeep-fixtures.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { UPKEEP_OBSERVED_KIND } from '../starter/factory/core/records.mjs';
import { auditFindingsInTransaction } from '../starter/factory/operations/governance.mjs';
import * as candidates from '../starter/factory/operations/upkeep-candidates.mjs';
import * as ceilings from '../starter/factory/operations/upkeep-ceilings.mjs';
import * as records from '../starter/factory/operations/upkeep-records.mjs';

const DAY = 86400000, T0 = Date.parse('2026-11-10T12:00:00.000Z'), iso = ms => new Date(ms).toISOString(), key = n => digest({ fictional: n });
const INSTRUCTION = { principal: 'operator', instruction: 'Fictional operator instruction' };
const send = (f, operation, payload, { actor = 'operator', onBehalfOf } = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), operation, payload, actor, ...(onBehalfOf ? { onBehalfOf } : {}) });
const tx = (f, fn) => f.store.tx(fn);
const ON = { upkeep: { mode: 'observe' } };
const docs = n => ({ kind: 'docs', file: 'README.md', quote: `The user API lives in src/api/users-${n}.js`, reason: 'Renamed' });
const context = n => ({ kind: 'context', file: 'AGENTS.md', quote: `Never import src/legacy-${n}.js`, replacement: 'Never import src/old.js', reason: 'Renamed' });
const check = n => ({ kind: 'check', anchor: `check:lint-${n}`, topic: 'test', title: 'Fictional check', text: 'A script can test it.', reason: 'Sent back' });
const rule = n => ({ kind: 'rule', anchor: `context:rules-${n}`, topic: 'procedure', title: 'Fictional rule', text: 'Run the schema check first.', reason: 'Sent back' });
const learning = n => ({ kind: 'learning', anchor: `dir:src/api-${n}`, topic: 'data', title: 'Fictional learning', text: 'The pager counts from one.', reason: 'Sent back' });
const stale = n => ({ kind: 'learning-stale', learningId: `learning-${n}`, condition: 'paths' });
const raise = (f, list, flowId = 'flow-a', nowMs = T0) => tx(f, () => candidates.raiseCandidatesInTransaction(f.store, { flowId, candidates: list, nowMs }));
// A rule or a learning as an open candidate: its second distinct flow.
const raiseTwice = (f, candidate, nowMs = T0) => { raise(f, [candidate], 'flow-first', nowMs); return raise(f, [candidate], 'flow-second', nowMs)[0]; };
const suspended = f => Object.keys(records.upkeepSuspensions(f.store)).sort();
const notices = f => f.store.all('inbox').filter(item => item.id.startsWith('upkeep-suspended:'));
// Every statement a function runs on the records table.
function probe(store) {
  let seen = []; const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => { const statement = prepare(sql); for (const name of ['all', 'get', 'run']) { const call = statement[name].bind(statement); statement[name] = (...args) => { const out = call(...args); seen.push({ sql, rows: Array.isArray(out) ? out.length : name === 'get' && out ? 1 : 0, plan: /^\s*(SELECT|DELETE)/i.test(sql) ? prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(step => step.detail) : [] }); return out; }; } return statement; };
  return { take() { const out = seen.filter(row => /\b(FROM|INTO|UPDATE) records\b/.test(row.sql)); seen = []; return out; }, restore() { store.db.prepare = prepare; } };
}
const BY_KEY = /^SEARCH records USING (COVERING )?INDEX sqlite_autoindex_records_1 \(kind=\? AND id=\?\)$/;

// ---- Caps (8.3, 7.2) ----
test('caps: an eleventh waiting docs candidate is not recorded; an eleventh context or capture candidate pushes out the oldest of its part, which expires', t => {
  const f = sandbox(t);
  // Docs: at most 10 wait. The eleventh is not recorded, and nothing is pushed out for it.
  for (let n = 1; n <= 10; n++) assert.equal(raise(f, [docs(n)], 'flow-a', T0 + n * 1000)[0].outcome, 'raised');
  const eleventh = raise(f, [docs(11)], 'flow-a', T0 + DAY)[0]; assert.equal(eleventh.outcome, 'backlog-full'); assert.equal(f.store.get('finding', eleventh.id), undefined);
  assert.equal(records.upkeepOpen(f.store).candidates.docs, 10); assert.equal(f.store.live('finding').length, 10);
  // A place opens when one leaves the open set.
  const first = f.store.live('finding')[0]; assert.equal(send(f, 'finding.resolve', { findingId: first.id, expectedVersion: 1, disposition: 'declined', reason: 'wrong' }).status, 'completed');
  assert.equal(raise(f, [docs(11)], 'flow-a', T0 + DAY)[0].outcome, 'raised');
  // Reopening into a full part is refused: nothing is pushed out for a reopen.
  assert.match(send(f, 'finding.reopen', { findingId: first.id, expectedVersion: 2, note: 'Again' }).error, /10 docs candidates are open, which is the limit \(10\)/);

  // Context: at most 10 open. The eleventh is raised and the oldest expires with the reason cap.
  const proposals = []; for (let n = 1; n <= 10; n++) proposals.push(raise(f, [context(n)], 'flow-a', T0 + n * 1000)[0].id);
  const pushed = raise(f, [context(11)], 'flow-a', T0 + DAY)[0]; assert.equal(pushed.outcome, 'raised');
  const out = f.store.need('finding', proposals[0]); assert.deepEqual({ status: out.status, reason: out.disposition.reason, version: out.version }, { status: 'expired', reason: 'cap', version: 2 });
  assert.ok(proposals.slice(1).every(id => f.store.need('finding', id).status === 'unapproved')); assert.equal(records.upkeepOpen(f.store).candidates.context, 10);
  // Capture: one cap of 10 across checks, rules and learnings. A stale learning is not counted in it.
  const captured = []; let n = 0;
  for (let i = 0; i < 4; i++) captured.push(raise(f, [check(++n)], 'flow-a', T0 + n * 1000)[0].id);
  for (let i = 0; i < 3; i++) captured.push(raiseTwice(f, rule(++n), T0 + n * 1000).id);
  for (let i = 0; i < 3; i++) captured.push(raiseTwice(f, learning(++n), T0 + n * 1000).id);
  for (let i = 0; i < 12; i++) assert.equal(raise(f, [stale(i)], 'flow-a')[0].outcome, 'raised');
  assert.deepEqual(records.upkeepOpen(f.store).candidates, { docs: 10, context: 10, check: 4, rule: 3, learning: 3, 'learning-stale': 12 });
  assert.equal(raiseTwice(f, learning(++n), T0 + DAY).outcome, 'raised');
  assert.equal(f.store.need('finding', captured[0]).status, 'expired', 'the oldest capture candidate, a check, made room for a learning');
  assert.deepEqual(records.upkeepOpen(f.store).candidates, { docs: 10, context: 10, check: 3, rule: 3, learning: 4, 'learning-stale': 12 });
  // A cap that was lowered: the next candidate leaves the part at the new cap.
  f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), upkeep: { capture: { maxOpen: 3 }, context: { maxOpen: 0 }, docs: { maxWaiting: 2 } } }));
  assert.equal(raise(f, [check(++n)], 'flow-a', T0 + 2 * DAY)[0].outcome, 'raised');
  const open = records.upkeepOpen(f.store).candidates; assert.equal(open.check + open.rule + open.learning, 3);
  // A cap of zero records nothing; a rule seen in a second flow stays observed.
  assert.equal(raise(f, [context(99)], 'flow-a')[0].outcome, 'cap'); assert.equal(records.upkeepOpen(f.store).candidates.context, 10, 'existing open candidates are untouched');
  assert.equal(raise(f, [docs(99)], 'flow-a')[0].outcome, 'backlog-full');
  f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), upkeep: { capture: { maxOpen: 0 } } }));
  const waiting = rule(++n); raise(f, [waiting], 'flow-first'); const second = raise(f, [waiting], 'flow-second')[0];
  assert.equal(second.outcome, 'cap'); assert.ok(records.observedClass(f.store, second.id), 'still an observed class'); assert.equal(f.store.get('finding', second.id), undefined);
  // The counts follow the rows.
  const live = f.store.live('finding'), counted = Object.fromEntries(records.UPKEEP_CANDIDATE_KINDS.map(kind => [kind, live.filter(row => row.kind === kind).length])); assert.deepEqual(records.upkeepOpen(f.store).candidates, counted);
});

test('a candidate past its age never holds a place at a cap: a part at its cap first expires what is overdue, by age, and only then refuses or pushes out', t => {
  const f = sandbox(t);
  // Ten docs candidates wait from T0. Fourteen days on they are overdue: an eleventh is raised, and the ten expire by age.
  const waiting = []; for (let n = 1; n <= 10; n++) waiting.push(raise(f, [docs(n)], 'flow-a', T0 + n)[0].id);
  assert.equal(raise(f, [docs(11)], 'flow-a', T0 + 14 * DAY - 1)[0].outcome, 'backlog-full', 'not yet overdue: the backlog is full');
  const later = raise(f, [docs(11)], 'flow-b', T0 + 14 * DAY + 10)[0]; assert.equal(later.outcome, 'raised');
  assert.deepEqual(waiting.map(id => [f.store.need('finding', id).status, f.store.need('finding', id).disposition.reason]), waiting.map(() => ['expired', 'age']));
  assert.equal(records.upkeepOpen(f.store).candidates.docs, 1);
  // Context: nine fresh and one overdue. The eleventh pushes nothing out by cap: the overdue one expires by age.
  const proposals = [raise(f, [context(1)], 'flow-a', T0)[0].id]; for (let n = 2; n <= 10; n++) proposals.push(raise(f, [context(n)], 'flow-a', T0 + 20 * DAY + n)[0].id);
  assert.equal(raise(f, [context(11)], 'flow-a', T0 + 31 * DAY)[0].outcome, 'raised');
  assert.deepEqual({ status: f.store.need('finding', proposals[0]).status, reason: f.store.need('finding', proposals[0]).disposition.reason }, { status: 'expired', reason: 'age' });
  assert.ok(proposals.slice(1).every(id => f.store.need('finding', id).status === 'unapproved'), 'no fresh proposal was pushed out');
  // Two proposals in one call at the cap: each pushes out one, the live set is read once, and the part stays at its cap.
  const watch = probe(f.store), two = raise(f, [context(12), context(13)], 'flow-c', T0 + 32 * DAY);
  const reads = watch.take().filter(row => /^\s*SELECT/i.test(row.sql) && !BY_KEY.test(row.plan.join('|'))); watch.restore();
  assert.deepEqual(two.map(row => row.outcome), ['raised', 'raised']); assert.equal(reads.length, 1, 'one read of the live finding set');
  assert.equal(records.upkeepOpen(f.store).candidates.context, 10);
  assert.deepEqual(proposals.slice(1, 3).map(id => f.store.need('finding', id).disposition.reason), ['cap', 'cap']);
  // A cap lowered below what is open, with several candidates in one call: each new one leaves the part at the cap.
  f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), upkeep: { context: { maxOpen: 1 } } }));
  assert.deepEqual(raise(f, [context(20), context(21), context(22)], 'flow-d', T0 + 33 * DAY).map(row => row.outcome), ['raised', 'raised', 'raised']);
  assert.equal(records.upkeepOpen(f.store).candidates.context, 1); assert.equal(f.store.need('finding', raise(f, [context(22)], 'flow-e', T0 + 33 * DAY)[0].id).status, 'unapproved', 'the newest is the one left open');
  const live = f.store.live('finding'); assert.deepEqual(records.upkeepOpen(f.store).candidates, Object.fromEntries(records.UPKEEP_CANDIDATE_KINDS.map(kind => [kind, live.filter(row => row.kind === kind).length])));
});

test('a candidate write reads each class key by key in finding and in upkeepObserved; only a push-out at a cap reads the open candidates, through their own index', t => {
  const f = sandbox(t);
  for (let n = 1; n <= 9; n++) raise(f, [context(n)], 'flow-a', T0 + n * 1000);
  const watch = probe(f.store);
  const selects = () => watch.take().filter(row => /^\s*SELECT/i.test(row.sql));
  // Below the cap: a docs candidate, a context candidate, a rule in its first and its second flow, a repeat.
  for (const run of [() => raise(f, [docs(1)]), () => raise(f, [context(10)]), () => raise(f, [rule(1)], 'flow-first'), () => raise(f, [rule(1)], 'flow-second'), () => raise(f, [docs(1)], 'flow-b'), () => raise(f, [docs(1)], 'flow-b')]) {
    run(); const reads = selects();
    assert.ok(reads.length >= 1 && reads.every(row => BY_KEY.test(row.plan.join('|'))), `every read is by key: ${reads.map(row => row.plan.join('|')).join('; ')}`);
    assert.ok(reads.every(row => /kind=\? AND id=\?/.test(row.sql)));
  }
  // At the cap: one read of the open candidates, through their own partial index, not the live finding set.
  raise(f, [context(11)]); const atCap = selects().filter(row => !BY_KEY.test(row.plan.join('|')));
  assert.equal(atCap.length, 1); assert.match(atCap[0].sql, /INDEXED BY records_finding_open_upkeep/); assert.deepEqual(atCap[0].plan, ['SEARCH records USING INDEX records_finding_open_upkeep (kind=?)']);
  watch.restore();
});

// Review of fb4949c, P2-1: audit findings have no cap and no expiry, so the open audit backlog can
// grow without bound. Nothing upkeep reads may grow with it.
test('review P2-1: at a cap, and for the assessment, upkeep reads its ten open candidates and none of a thousand open audit findings', t => {
  const f = sandbox(t);
  for (let n = 1; n <= 10; n++) raise(f, [context(n)], 'flow-a', T0 + n);
  tx(f, () => { for (let i = 0; i < 1000; i++) f.store.put('finding', { id: `audit:${key(`backlog-${i}`)}`, source: 'audit', title: `Fictional audit finding ${i}`, evidence: `src/file-${i}.js:1`, status: 'unapproved', version: 1, createdAt: iso(T0) }); });
  assert.equal(f.store.live('finding').length, 1010);
  const watch = probe(f.store), eleventh = raise(f, [context(11)], 'flow-a', T0 + DAY)[0];
  const reads = watch.take().filter(row => /^\s*SELECT/i.test(row.sql) && !BY_KEY.test(row.plan.join('|')));
  assert.equal(eleventh.outcome, 'raised'); assert.equal(reads.length, 1);
  assert.equal(reads[0].rows, 10, 'the ten open candidates, not 1,010 live findings'); assert.deepEqual(reads[0].plan, ['SEARCH records USING INDEX records_finding_open_upkeep (kind=?)']);
  // The open candidates the assessment lists, and the expiry it runs, read the same ten.
  const open = records.openUpkeepCandidates(f.store), [read] = watch.take(); watch.restore();
  assert.equal(open.length, 10); assert.equal(read.rows, 10); assert.ok(open.every(row => row.source === 'upkeep'));
  assert.equal(tx(f, () => candidates.expireOpenCandidatesInTransaction(f.store, { nowMs: T0 + 400 * DAY })).expired.length, 10); assert.equal(f.store.live('finding').length, 1000, 'no audit finding expired');
});

// ---- Expiry by age (8.3) ----
test('an open candidate expires at its age limit, evaluated on the open candidates: docs after 14 days, the others after 30; an audit finding never does', t => {
  const f = sandbox(t), ids = {};
  for (const [name, candidate] of Object.entries({ docs: docs(1), context: context(1), check: check(1), 'learning-stale': stale(1) })) ids[name] = raise(f, [candidate], 'flow-a', T0)[0].id;
  ids.rule = raiseTwice(f, rule(1), T0).id; ids.learning = raiseTwice(f, learning(1), T0).id;
  const [audit] = tx(f, () => auditFindingsInTransaction(f.store, { findings: [{ id: 'audit:old', title: 'Fictional', evidence: 'x:1' }] }));
  tx(f, () => f.store.put('finding', { ...audit, createdAt: iso(T0 - 400 * DAY) }));
  const expire = nowMs => tx(f, () => candidates.expireOpenCandidatesInTransaction(f.store, { nowMs })), status = name => f.store.need('finding', ids[name]).status;
  // The limits themselves.
  assert.deepEqual(candidates.OPEN_AGE_MS, { docs: 14 * DAY, context: 30 * DAY, check: 30 * DAY, rule: 30 * DAY, learning: 30 * DAY, 'learning-stale': 30 * DAY }); assert.equal(candidates.OBSERVED_AGE_MS, 90 * DAY);
  // A millisecond before fourteen days nothing has expired; at fourteen days the docs candidate has, alone.
  assert.deepEqual(expire(T0 + 14 * DAY - 1).expired, []);
  const first = expire(T0 + 14 * DAY); assert.deepEqual(first.expired.map(row => row.id), [ids.docs]); assert.equal(first.open.length, 5, 'the five other candidates; the open audit finding is not read');
  assert.deepEqual({ status: status('docs'), reason: f.store.need('finding', ids.docs).disposition.reason, version: f.store.need('finding', ids.docs).version }, { status: 'expired', reason: 'age', version: 2 });
  assert.deepEqual(expire(T0 + 30 * DAY - 1).expired, []);
  const second = expire(T0 + 30 * DAY); assert.deepEqual(second.expired.map(row => row.id).sort(), [ids.context, ids.check, ids['learning-stale'], ids.rule, ids.learning].sort());
  // The audit finding is still open, however old: it is not even read.
  assert.deepEqual(second.open.map(row => row.id), []); assert.equal(f.store.need('finding', 'audit:old').status, 'unapproved');
  // Given every open finding, an audit finding is still never expired.
  assert.deepEqual(tx(f, () => candidates.expireOpenCandidatesInTransaction(f.store, { nowMs: T0 + 400 * DAY, rows: f.store.live('finding') })).open.map(row => row.id), ['audit:old']);
  assert.deepEqual(records.upkeepOpen(f.store).candidates, { docs: 0, context: 0, check: 0, rule: 0, learning: 0, 'learning-stale': 0 });
  // An expiry is a disposal of its part: one entry each for the context proposal and the three capture candidates.
  assert.deepEqual(records.upkeepWindow(f.store).disposed.context.map(entry => entry.outcome), ['expired']); assert.deepEqual(records.upkeepWindow(f.store).disposed.capture.map(entry => entry.outcome), ['expired', 'expired', 'expired']);
  // Reopened by a person, the clock starts again from the reopening.
  const reopened = send(f, 'finding.reopen', { findingId: ids.docs, expectedVersion: 2, note: 'Still wrong' }); assert.equal(reopened.status, 'completed', reopened.error);
  const since = Date.parse(reopened.result.openedAt); assert.deepEqual(expire(since + 14 * DAY - 1).expired, []); assert.deepEqual(expire(since + 14 * DAY).expired.map(row => row.id), [ids.docs]);
  // Health shows when each expires, and says so once it is overdue.
  const row = f.store.need('finding', raise(f, [docs(2)], 'flow-a', T0)[0].id);
  assert.deepEqual({ expiresAt: candidates.candidateView(row, T0).expiresAt, overdue: candidates.candidateView(row, T0).overdue, later: candidates.candidateView(row, T0 + 14 * DAY).overdue }, { expiresAt: iso(T0 + 14 * DAY), overdue: false, later: true });
});

test('through the job: an overdue candidate expires where the assessment reads the open candidates, and its title is not shown to the model', async t => {
  const f = upkeepProject(t);
  const old = raise(f, [docs(1)], 'flow-old', Date.now() - 15 * DAY)[0], young = raise(f, [docs(2)], 'flow-young', Date.now() - DAY)[0];
  const merged = await f.mergedAndFinished('change-1'), model = scriptedModel(), assessed = await f.assess({ providerInvoke: model });
  assert.equal(assessed.run.outcome, 'nothing'); assert.equal(model.calls.length, 1);
  assert.equal(f.store.need('finding', old.id).status, 'expired'); assert.equal(f.store.need('finding', old.id).disposition.reason, 'age'); assert.equal(f.store.need('finding', young.id).status, 'unapproved');
  const prompt = model.calls[0].prompt; assert.ok(prompt.includes('src/api/users-2.js'), 'the open candidate is evidence'); assert.equal(prompt.includes('src/api/users-1.js'), false, 'the expired one is not');
  assert.equal(merged.flowId, 'flow-change-1');
});

// ---- Observed classes (4.5, 8.3) ----
test('observed classes expire through their indexed path, oldest first, at most 50 per run settlement, without reading the finding set; at 200 the oldest makes room', async t => {
  const f = upkeepProject(t), store = f.store, now = Date.now();
  // A settled history: thousands of settled findings, and observed classes of every age.
  const put = store.db.prepare('INSERT INTO records VALUES(?,?,?)'), row = (kind, record) => put.run(kind, record.id, JSON.stringify(record));
  store.db.exec('BEGIN');
  for (let i = 0; i < 2500; i++) row('finding', { id: key(`settled-${i}`), source: i % 2 ? 'upkeep' : 'audit', kind: 'docs', title: `Fictional settled finding ${i}`, evidence: 'x', status: ['delivered', 'declined', 'expired'][i % 3], version: 3, createdAt: iso(now - 200 * DAY) });
  for (let i = 0; i < 120; i++) row(UPKEEP_OBSERVED_KIND, { id: key(`old-${i}`), kind: 'rule', anchor: 'src/api', topic: 'test', sourceFlow: `flow-${i}`, firstObservedAt: iso(now - 91 * DAY - i * 3600000) });
  for (let i = 0; i < 30; i++) row(UPKEEP_OBSERVED_KIND, { id: key(`young-${i}`), kind: 'learning', anchor: 'src/api', topic: 'test', sourceFlow: `flow-y${i}`, firstObservedAt: iso(now - 89 * DAY + i * 3600000) });
  store.db.exec('COMMIT');
  store.setMeta('upkeepOpen', { docsTask: null, candidates: {}, observed: 150 });
  // Directly: one indexed range read of 50 rows, then those rows by key. Nothing names the finding kind.
  const watch = probe(store), expired = tx(f, () => candidates.expireObservedClassesInTransaction(store, { nowMs: now })), statements = watch.take(); watch.restore();
  assert.equal(expired, 50); assert.equal(store.count(UPKEEP_OBSERVED_KIND), 100); assert.equal(records.upkeepObservedCount(store), 100);
  const reads = statements.filter(entry => /^\s*SELECT/i.test(entry.sql));
  assert.equal(reads.length, 1); assert.match(reads[0].sql, /INDEXED BY records_upkeep_observed_first/); assert.equal(reads[0].rows, 50);
  assert.deepEqual(reads[0].plan, ['SEARCH records USING INDEX records_upkeep_observed_first (kind=? AND <expr><?)'], 'an indexed range read: no scan and no sort');
  assert.equal(statements.filter(entry => /finding/.test(entry.sql)).length, 0, 'the finding set is not read');
  assert.ok(statements.filter(entry => /^\s*DELETE/i.test(entry.sql)).every(entry => /WHERE kind=\? AND id=\?/.test(entry.sql)), 'each row goes by key');
  // The oldest went first.
  assert.equal(store.get(UPKEEP_OBSERVED_KIND, key('old-119')), undefined); assert.ok(store.get(UPKEEP_OBSERVED_KIND, key('old-0')));
  // Through the job: each run settlement expires the next 50, and never a class younger than 90 days.
  await f.mergedAndFinished('change-1', root => write(root, { 'src/unrelated.js': 'export const x = 1;\n' }));
  const first = await f.assess(); assert.equal(first.run.status, 'closed'); assert.equal(store.count(UPKEEP_OBSERVED_KIND), 50);
  await f.mergedAndFinished('change-2', root => write(root, { 'src/unrelated.js': 'export const x = 2;\n' }));
  await f.assess(); assert.equal(store.count(UPKEEP_OBSERVED_KIND), 30);
  assert.ok(store.all(UPKEEP_OBSERVED_KIND).every(entry => entry.id !== key('old-0') && Date.parse(entry.firstObservedAt) > now - 90 * DAY)); assert.equal(records.upkeepObservedCount(store), 30);
  assert.equal(store.count('finding'), 2500, 'no finding was touched');
  // With the kind unverified nothing is read in its place.
  store.db.exec('DROP INDEX records_upkeep_observed_first'); assert.equal(tx(f, () => candidates.expireObservedClassesInTransaction(store, { nowMs: now + 400 * DAY })), 0); assert.equal(store.count(UPKEEP_OBSERVED_KIND), 30);
});

test('at most 200 observed classes: a new one pushes out the oldest, and an observed class is neither open nor shown', t => {
  const f = sandbox(t);
  for (let n = 0; n < 200; n++) assert.equal(raise(f, [rule(n)], 'flow-a', T0 + n * 1000)[0].outcome, 'observed');
  assert.equal(f.store.count(UPKEEP_OBSERVED_KIND), 200); assert.equal(records.upkeepObservedCount(f.store), 200);
  const oldest = digest({ v: 1, kind: 'rule', anchor: 'context:rules-0', topic: 'procedure' }); assert.ok(records.observedClass(f.store, oldest));
  assert.equal(raise(f, [rule(200)], 'flow-a', T0 + DAY)[0].outcome, 'observed');
  assert.equal(f.store.count(UPKEEP_OBSERVED_KIND), 200); assert.equal(records.observedClass(f.store, oldest), undefined); assert.equal(records.upkeepObservedCount(f.store), 200);
  // Observed classes are not candidates: not counted as open, not in the live finding set, and no command acts on one.
  assert.deepEqual(records.upkeepOpen(f.store).candidates, { docs: 0, context: 0, check: 0, rule: 0, learning: 0, 'learning-stale': 0 }); assert.equal(f.store.count('finding'), 0);
  const seen = digest({ v: 1, kind: 'rule', anchor: 'context:rules-5', topic: 'procedure' });
  for (const operation of ['finding.accept', 'finding.resolve', 'finding.reopen']) assert.match(send(f, operation, { findingId: seen, expectedVersion: 1 }).error, /unknown finding/);
});

// ---- The ceilings (8.3): each at exactly the stated count ----
const runs = (f, entries, at = T0) => tx(f, () => { for (const [index, entry] of entries.entries()) records.addToUpkeepWindowInTransaction(f.store, { run: { flowId: `flow-${index}`, outcome: entry.candidates ? 'candidates' : 'nothing', reason: 'fictional', stage: 'model', at: iso(at + index), model: Boolean(entry.model), candidates: Boolean(entry.candidates) } }); });
const evaluate = (f, nowMs = T0 + DAY) => tx(f, () => ceilings.evaluateRunCeilingsInTransaction(f.store, { nowMs, config: ON }));
const mix = (total, count, entry) => Array.from({ length: total }, (_, index) => index < count ? entry : {});

test('runs that reach the model: 6 of the last 20 runs suspend the model call, 5 do not, and the window is not judged until it holds 20', t => {
  assert.deepEqual(ceilings.UPKEEP_CEILINGS.model, { rule: 'runs-reaching-the-model', window: 20, ceiling: 6 }); assert.deepEqual(ceilings.UPKEEP_CEILINGS.candidates, { rule: 'runs-producing-candidates', window: 20, ceiling: 4 });
  const cases = [
    ['5 of 20', mix(20, 5, { model: true }), []], ['6 of 20', mix(20, 6, { model: true }), ['model']], ['20 of 20', mix(20, 20, { model: true }), ['model']],
    ['19 runs, every one reaching the model: the window is not full', mix(19, 19, { model: true }), []],
    ['6 of the last 20, with older runs before them', [...mix(30, 0, {}), ...mix(20, 6, { model: true })], ['model']],
    ['6 that have left the last 20', [...mix(6, 6, { model: true }), ...mix(20, 5, { model: true })], []],
  ];
  for (const [name, entries, expected] of cases) {
    const f = sandbox(t); runs(f, entries); const recorded = evaluate(f);
    assert.deepEqual(suspended(f), expected, name); assert.equal(recorded.length, expected.length, name);
    if (expected.length) {
      const { entries: kept, ...counts } = recorded[0].window;
      assert.deepEqual({ part: recorded[0].part, rule: recorded[0].rule, window: counts }, { part: 'model', rule: 'runs-reaching-the-model', window: { runs: 20, reached: entries.slice(-20).filter(entry => entry.model).length } }); assert.equal(notices(f).length, 1);
      // 8.4: the suspension records the window's contents, the twenty runs it judged.
      assert.deepEqual(kept.map(entry => [entry.flowId, entry.model]), records.upkeepWindow(f.store).runs.slice(-20).map(run => [run.flowId, run.model === true]));
    }
  }
  // A run that ended assessment-unavailable started no model: it is a run, and not one that reached the model.
  const f = sandbox(t);
  tx(f, () => { for (let i = 0; i < 20; i++) records.addToUpkeepWindowInTransaction(f.store, { run: { flowId: `f${i}`, outcome: 'abstained', reason: i < 15 ? 'assessment-unavailable' : 'no-candidate', stage: 'reservation', at: iso(T0 + i), model: i >= 15, candidates: false } }); });
  assert.deepEqual(evaluate(f), []); assert.deepEqual(suspended(f), [], '5 reached the model; the 15 that could not start one are not counted');
  // An entry written before the model stage existed has no `model` member and reached none.
  const g = sandbox(t); tx(g, () => { for (let i = 0; i < 20; i++) records.addToUpkeepWindowInTransaction(g.store, { run: { flowId: `f${i}`, outcome: 'nothing', at: iso(T0 + i) } }); }); assert.deepEqual(evaluate(g), []);
});

test('runs that produce any candidate: 4 of the last 20 runs suspend the model call, 3 do not', t => {
  for (const [count, expected] of [[3, []], [4, ['model']], [5, ['model']]]) {
    const f = sandbox(t); runs(f, mix(20, count, { model: true, candidates: true })); const recorded = evaluate(f);
    assert.deepEqual(suspended(f), expected, `${count} of 20`);
    if (expected.length) { const { entries: kept, ...counts } = recorded[0].window; assert.deepEqual({ rule: recorded[0].rule, window: counts }, { rule: 'runs-producing-candidates', window: { runs: 20, produced: count } }); assert.equal(kept.filter(entry => entry.candidates).length, count); }
  }
  const f = sandbox(t); runs(f, mix(19, 19, { model: false, candidates: true })); assert.deepEqual(evaluate(f), [], '19 runs: not full');
});

const dispose = (f, part, outcome, index = 0) => tx(f, () => ceilings.recordUpkeepDisposalInTransaction(f.store, { part, outcome, id: key(`${part}-${index}`), taskId: `task-${index}`, nowMs: T0 + index, config: ON }));
test('docs follow-ups that end rejected, failed, declined or expired: 3 of the last 10 ended suspend docs, and so do 3 in a row from the first', t => {
  const cases = [
    ['2 in a row', ['failed', 'declined'], []], ['3 in a row, from the first event', ['failed', 'declined', 'expired'], ['docs']], ['3 in a row after a merge', ['merged', 'rejected', 'rejected', 'rejected'], ['docs']],
    ['2, a merge, then 1: not in a row, and the window of 10 is not full', ['failed', 'failed', 'merged', 'failed'], []],
    ['2 of 10, never three in a row', ['failed', 'merged', 'merged', 'merged', 'failed', 'merged', 'merged', 'merged', 'merged', 'merged'], []],
    ['3 of the last 10, never three in a row', ['failed', 'merged', 'merged', 'declined', 'merged', 'merged', 'expired', 'merged', 'merged', 'merged'], ['docs']],
    ['3 of 9, never three in a row: not full', ['failed', 'merged', 'merged', 'declined', 'merged', 'merged', 'expired', 'merged', 'merged'], []],
    ['3 that have left the last 10', ['failed', 'merged', 'failed', 'merged', 'failed', 'merged', 'merged', 'merged', 'merged', 'merged', 'merged', 'merged', 'merged', 'merged'], ['docs']],
  ];
  for (const [name, outcomes, expected] of cases) {
    const f = sandbox(t); let at = null; outcomes.forEach((outcome, index) => { if (dispose(f, 'docs', outcome, index).length && at === null) at = index; });
    assert.deepEqual(suspended(f), expected, name);
    // Suspended at exactly the entry that reaches the count, and not before.
    if (name === '3 of the last 10, never three in a row') assert.equal(at, 9); if (name === '3 in a row, from the first event') assert.equal(at, 2); if (name === '3 that have left the last 10') assert.equal(at, 9);
    // The suspension records the entries it judged: the ten ended, or the three in a row.
    if (expected.length) { const window = records.upkeepSuspended(f.store, 'docs').window; assert.deepEqual(window.entries.map(entry => entry.outcome), window.ended.length ? window.ended : outcomes.slice(0, at + 1).slice(-10)); assert.ok(window.entries.every(entry => entry.taskId)); }
  }
  assert.deepEqual(ceilings.DOCS_ENDINGS, ['merged', 'rejected', 'failed', 'declined', 'expired']); assert.throws(() => dispose(sandbox(t), 'docs', 'accepted'), /unknown disposal/);
});

test('context and capture candidates declined or expired: 5 of the last 10 disposed suspend that part and only that part', t => {
  for (const part of ['context', 'capture']) {
    const other = part === 'context' ? 'capture' : 'context';
    for (const [name, outcomes, expected] of [
      ['4 of 10', ['declined', 'expired', 'declined', 'expired', 'accepted', 'accepted', 'accepted', 'accepted', 'resolved-elsewhere', 'accepted'], []],
      ['5 of 10', ['declined', 'expired', 'declined', 'expired', 'accepted', 'accepted', 'accepted', 'accepted', 'resolved-elsewhere', 'declined'], [part]],
      ['9 declined: the window is not full', Array(9).fill('declined'), []],
      ['10 declined', Array(10).fill('declined'), [part]],
    ]) {
      const f = sandbox(t); let at = null; outcomes.forEach((outcome, index) => { if (dispose(f, part, outcome, index).length && at === null) at = index; });
      assert.deepEqual(suspended(f), expected, `${part}: ${name}`); if (expected.length) assert.equal(at, 9);
      assert.deepEqual(records.upkeepWindow(f.store).disposed[other], [], 'the other part has its own window');
    }
  }
  // Through the commands: the fifth decline of ten disposed context proposals suspends context proposals.
  const f = sandbox(t); f.store.setMeta('config', validateConfig({ ...f.store.meta('config'), ...ON }));
  for (let n = 0; n < 10; n++) {
    const id = raise(f, [context(n)], 'flow-a')[0].id, receipt = send(f, 'finding.resolve', n < 5 ? { findingId: id, expectedVersion: 1, disposition: 'resolved-elsewhere', evidence: 'By hand' } : { findingId: id, expectedVersion: 1, disposition: 'declined', reason: n % 2 ? 'later' : 'wrong' });
    assert.equal(receipt.status, 'completed', receipt.error); assert.deepEqual(suspended(f), n < 9 ? [] : ['context'], `after ${n + 1} disposed`);
  }
  assert.equal(records.upkeepSuspended(f.store, 'context').rule, 'candidates-declined-or-expired'); assert.equal(records.upkeepSuspended(f.store, 'capture'), null);
  assert.deepEqual(records.upkeepSuspended(f.store, 'context').window.entries.map(entry => entry.outcome), [...Array(5).fill('resolved-elsewhere'), ...Array(5).fill('declined')]);
  // An audit finding's disposition is in no window.
  const g = sandbox(t); for (let n = 0; n < 12; n++) { tx(g, () => auditFindingsInTransaction(g.store, { findings: [{ id: `audit:${n}`, title: 'Fictional', evidence: 'x:1' }] })); assert.equal(send(g, 'finding.resolve', { findingId: `audit:${n}`, expectedVersion: 1, disposition: 'declined', reason: 'wrong' }).status, 'completed'); }
  assert.deepEqual(suspended(g), []); assert.deepEqual(records.upkeepWindow(g.store).disposed, { docs: [], context: [], capture: [] });
});

test('a revert or regression of an upkeep change: one suspends everything, from the first event', t => {
  const f = sandbox(t), marker = { kind: 'docs', sourceFlow: 'flow-source' };
  const flow = (id, upkeep) => tx(f, () => f.store.put('flow', { id, taskId: `task-${id}`, kind: 'change', state: 'completed', results: { merge: { merged: true, sha: 'a'.repeat(40) } }, taskSnapshot: { id: `task-${id}`, title: 'Fictional', ...(upkeep ? { upkeep: marker } : {}) }, createdAt: iso(T0), finishedAt: iso(T0) }));
  flow('ordinary', false); flow('upkeep-1', true); tx(f, () => ceilings.recordUpkeepMergeInTransaction(f.store, { flowId: 'upkeep-1', taskId: 'task-upkeep-1', nowMs: T0 }));
  // A regression against an ordinary change suspends nothing.
  assert.equal(send(f, 'regression.record', { flowId: 'ordinary', reason: 'Fictional break', evidence: 'Fictional report' }).status, 'completed'); assert.deepEqual(suspended(f), []);
  // One regression against the change an upkeep flow delivered: everything, with one notice.
  assert.equal(send(f, 'regression.record', { flowId: 'upkeep-1', reason: 'Fictional break', evidence: 'Fictional report' }, { actor: 'orchestrator', onBehalfOf: INSTRUCTION }).status, 'completed');
  assert.deepEqual(suspended(f), ['all']); assert.deepEqual({ rule: records.upkeepSuspended(f.store, 'docs').rule, window: records.upkeepSuspended(f.store, 'docs').window }, { rule: 'revert-or-regression', window: { flowId: 'upkeep-1', kind: 'regression' } }, 'every part reads as suspended');
  assert.equal(notices(f).length, 1); assert.match(notices(f)[0].title, /suspended \(everything\)/);
  // The same report again, and a second one, add nothing.
  send(f, 'regression.record', { flowId: 'upkeep-1', reason: 'Fictional break', evidence: 'Fictional report' }); send(f, 'regression.record', { flowId: 'upkeep-1', reason: 'Another', evidence: 'Another' }); assert.equal(notices(f).length, 1);
  // The window is the last 20 merged upkeep changes: one that has left it is outside the rule, and a revert counts as a regression does.
  const g = sandbox(t);
  tx(g, () => { for (let i = 0; i < 21; i++) ceilings.recordUpkeepMergeInTransaction(g.store, { flowId: `upkeep-${i}`, nowMs: T0 + i }); });
  assert.equal(records.upkeepWindow(g.store).merged.length, 20); assert.deepEqual(tx(g, () => ceilings.recordUpkeepRegressionInTransaction(g.store, { flowId: 'upkeep-0', kind: 'revert' })), []); assert.deepEqual(suspended(g), []);
  assert.equal(tx(g, () => ceilings.recordUpkeepRegressionInTransaction(g.store, { flowId: 'upkeep-20', kind: 'revert' })).length, 1); assert.deepEqual(suspended(g), ['all']); assert.equal(records.upkeepSuspended(g.store, 'all').window.kind, 'revert');
});

// ---- The share of invocations: the last seven complete UTC days ----
test('the seven-day share uses complete days only: today and the eighth day back are not read, and the window is judged only once seven complete days were counted', t => {
  const NOW = Date.parse('2026-11-20T15:00:00.000Z'), day = back => records.upkeepDayId(NOW - back * DAY);
  const project = (totals, counting = iso(NOW - 30 * DAY)) => { const f = sandbox(t); tx(f, () => { records.addToUpkeepWindowInTransaction(f.store, { counting }); for (const [back, [invocations, upkeepInvocations]] of Object.entries(totals)) records.addToUpkeepDayInTransaction(f.store, day(Number(back)), { counters: { invocations, upkeepInvocations } }); }); return f; };
  const week = (invocations, upkeep) => Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map(back => [back, [invocations, upkeep]]));
  const judge = (f, nowMs = NOW) => tx(f, () => ceilings.evaluateRunCeilingsInTransaction(f.store, { nowMs, config: ON }));
  // The seven days read: yesterday back to the seventh day before today.
  const read = ceilings.invocationShare(project(week(10, 0)).store, { nowMs: NOW });
  assert.deepEqual(read.days, ['2026-11-19', '2026-11-18', '2026-11-17', '2026-11-16', '2026-11-15', '2026-11-14', '2026-11-13']); assert.deepEqual({ full: read.full, total: read.total, upkeep: read.upkeep }, { full: true, total: 70, upkeep: 0 });
  // Exactly 10% suspends the model call and docs, with one notice; just under does not.
  const at = project(week(100, 10)); assert.equal(judge(at).length, 2); assert.deepEqual(suspended(at), ['docs', 'model']); assert.equal(notices(at).length, 1); assert.match(notices(at)[0].title, /suspended \(the model call and docs\)/);
  assert.deepEqual(records.upkeepSuspended(at.store, 'model').window, { days: read.days, invocations: 700, upkeepInvocations: 70, entries: read.days.map(day => ({ day, invocations: 100, upkeepInvocations: 10 })) }); assert.equal(records.upkeepSuspended(at.store, 'docs').rule, 'invocation-share');
  const under = project({ ...week(100, 10), 7: [100, 9] }); assert.deepEqual(judge(under), []); assert.deepEqual(suspended(under), [], '69 of 700');
  // Today is not complete: an upkeep-heavy today does not count, and neither does a quiet today dilute a week at the ceiling.
  const today = project({ ...week(100, 9), 0: [100, 100] }); assert.deepEqual(judge(today), [], 'today is not read'); assert.deepEqual(suspended(today), []);
  const diluted = project({ ...week(100, 10), 0: [100000, 0] }); assert.equal(judge(diluted).length, 2);
  // The eighth day back is outside the window, either way.
  const eighth = project({ ...week(100, 9), 8: [100, 100] }); assert.deepEqual(judge(eighth), []);
  const eighthQuiet = project({ ...week(100, 10), 8: [100000, 0] }); assert.equal(judge(eighthQuiet).length, 2);
  // The window moves by whole days: the same rows a day later are days two to eight, and the eighth has left it.
  const moving = project({ ...week(100, 9), 7: [100, 16] }); assert.equal(judge(moving).length, 2, '70 of 700');
  const moved = project({ ...week(100, 9), 7: [100, 16] }); assert.deepEqual(judge(moved, NOW + DAY), [], 'a day later that day is the eighth back: 54 of 600');
});

test('the share window is full only when counting began before its oldest day; no invocations is no share; and nothing is judged with upkeep off', t => {
  const NOW = Date.parse('2026-11-20T15:00:00.000Z'), day = back => records.upkeepDayId(NOW - back * DAY);
  const project = counting => { const f = sandbox(t); tx(f, () => { if (counting !== undefined) records.addToUpkeepWindowInTransaction(f.store, { counting }); for (let back = 0; back <= 9; back++) records.addToUpkeepDayInTransaction(f.store, day(back), { counters: { invocations: 10, upkeepInvocations: 10 } }); }); return f; };
  const judge = (f, config = ON, nowMs = NOW) => tx(f, () => ceilings.evaluateRunCeilingsInTransaction(f.store, { nowMs, config }));
  // Counting began during the oldest of the seven days (2026-11-13): that day is not complete, so the window is not full.
  for (const [counting, full] of [['2026-11-13T00:00:00.001Z', false], ['2026-11-13T23:59:59.999Z', false], ['2026-11-14T08:00:00.000Z', false], ['2026-11-12T23:59:59.999Z', true], ['2026-10-01T00:00:00.000Z', true]]) {
    const f = project(counting); assert.equal(ceilings.invocationShare(f.store, { nowMs: NOW }).full, full, counting); assert.equal(judge(f).length, full ? 2 : 0, counting);
  }
  // A project that was already on when this release was adopted has no start recorded: it starts at the first evaluation, and is judged eight days on.
  const adopted = project(undefined); assert.deepEqual(judge(adopted), []); assert.equal(records.upkeepWindow(adopted.store).counting, iso(NOW)); assert.deepEqual(suspended(adopted), []);
  assert.deepEqual(judge(adopted, ON, NOW + 7 * DAY), [], 'seven days on, the day it began is still in the window');
  tx(adopted, () => { for (let back = -8; back < 0; back++) records.addToUpkeepDayInTransaction(adopted.store, day(back), { counters: { invocations: 10, upkeepInvocations: 10 } }); });
  assert.equal(judge(adopted, ON, NOW + 8 * DAY).length, 2);
  // With upkeep off no run ceiling is judged either: the runs that close then are the ones turning it off closes.
  const offRuns = sandbox(t); runs(offRuns, mix(20, 20, { model: true })); assert.deepEqual(tx(offRuns, () => ceilings.evaluateRunCeilingsInTransaction(offRuns.store, { nowMs: NOW, config: {} })), []); assert.deepEqual(suspended(offRuns), []);
  // With upkeep off nothing is judged; with no invocation at all there is no share to judge.
  assert.deepEqual(judge(project('2026-10-01T00:00:00.000Z'), { upkeep: { mode: 'off' } }), []); assert.deepEqual(judge(project('2026-10-01T00:00:00.000Z'), {}), []);
  const quiet = sandbox(t); tx(quiet, () => records.addToUpkeepWindowInTransaction(quiet.store, { counting: '2026-10-01T00:00:00.000Z' })); assert.deepEqual(judge(quiet), []);
  // The reads: with the window not full, no day row; with it full, seven day rows by key.
  const partial = project('2026-11-14T08:00:00.000Z'), whole = project('2026-10-01T00:00:00.000Z');
  for (const [f, rows] of [[partial, 0], [whole, 7]]) { const watch = probe(f.store); ceilings.invocationShare(f.store, { nowMs: NOW }); const reads = watch.take().filter(entry => /^\s*SELECT/i.test(entry.sql)); watch.restore(); assert.equal(reads.length, rows + 1, 'the window row, and the day rows'); assert.ok(reads.every(entry => BY_KEY.test(entry.plan.join('|')))); }
  // Turning upkeep on records when counting began, and turning it off forgets it.
  const f = sandbox(t), delivery = upkeep => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 1 }, upkeep });
  assert.equal(send(f, 'config.update', { config: delivery({ mode: 'off' }), note: 'Delivery' }).status, 'completed'); assert.equal(records.upkeepWindow(f.store).counting, null);
  const before = Date.now(); assert.equal(send(f, 'settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }).status, 'completed');
  const began = Date.parse(records.upkeepWindow(f.store).counting); assert.ok(began >= before && began <= Date.now());
  assert.equal(send(f, 'settings.update', { changes: { 'policy.maxFlows': 2 }, note: 'Unrelated' }).status, 'completed'); assert.equal(Date.parse(records.upkeepWindow(f.store).counting), began, 'an unrelated change does not move it');
  assert.equal(send(f, 'settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' }).status, 'completed'); assert.equal(records.upkeepWindow(f.store).counting, null);
  assert.equal(send(f, 'config.update', { config: delivery({ mode: 'observe' }), note: 'On again' }).status, 'completed'); assert.ok(Date.parse(records.upkeepWindow(f.store).counting) >= began);
});

// ---- Suspension (8.4) ----
test('only the operator lifts a suspension, with a note; nothing else does: not the orchestrator, not a delegation, not the mode turned down and up, not time', t => {
  const f = sandbox(t), delivery = (upkeep, policy = { maxFlows: 1 }) => ({ version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy, upkeep });
  assert.equal(send(f, 'config.update', { config: delivery({ mode: 'observe' }), note: 'Delivery' }).status, 'completed');
  runs(f, mix(20, 6, { model: true })); assert.equal(evaluate(f).length, 1); assert.deepEqual(suspended(f), ['model']);
  const row = records.upkeepSuspended(f.store, 'model'), [notice] = notices(f); assert.equal(notice.status, 'open'); assert.equal(notice.role, 'operator'); assert.match(notice.context, /A suspension is lifted only by the operator/);
  // The orchestrator: with an instruction, without one, and with a delegation list that tries to name the command.
  for (const who of [{ actor: 'orchestrator', onBehalfOf: INSTRUCTION }, { actor: 'orchestrator' }]) { const receipt = send(f, 'upkeep.lift', { part: 'model', note: 'Looks fine' }, who); assert.equal(receipt.status, 'rejected'); assert.match(receipt.error, /upkeep\.lift is operator only and cannot be delegated/); }
  assert.throws(() => validateConfig(delivery({ mode: 'observe' }, { maxFlows: 1, delegatedOperations: ['upkeep.lift'] })), /unknown or non-operator operation upkeep\.lift/);
  for (const actor of ['factory', 'reviewer']) assert.throws(() => send(f, 'upkeep.lift', { part: 'model', note: 'x' }, { actor }), /invalid actor/);
  // The mode turned down and up again, by the operator and by a delegate; a configuration change; more runs; time.
  assert.equal(send(f, 'settings.update', { changes: { 'upkeep.mode': 'off' }, note: 'Off' }, { actor: 'orchestrator', onBehalfOf: INSTRUCTION }).status, 'completed');
  assert.equal(send(f, 'settings.update', { changes: { 'upkeep.mode': 'observe' }, note: 'On' }).status, 'completed');
  assert.equal(send(f, 'config.update', { config: delivery({ mode: 'off' }), note: 'Off' }).status, 'completed'); assert.equal(send(f, 'config.update', { config: delivery({ mode: 'observe', budget: { maxModelRunsPerDay: 5 } }), note: 'On' }).status, 'completed');
  runs(f, mix(20, 0, {}), T0 + DAY); evaluate(f, T0 + 400 * DAY);
  assert.deepEqual(records.upkeepSuspended(f.store, 'model'), row, 'the same suspension, untouched'); assert.equal(notices(f).length, 1);
  // The operator: a part, and a note; a part that is not suspended, a stale read and an unknown part are refused.
  for (const [payload, pattern] of [[{ part: 'model' }, /note is required/], [{ part: 'model', note: '' }, /note is required/], [{ part: 'docs', note: 'x' }, /not suspended for docs/], [{ part: 'everything', note: 'x' }, /one of model, docs, context, capture, all/], [{ part: 'model', note: 'x', expectedAt: iso(T0) }, /that suspension changed since it was read/], [{ part: 'model', note: 'x', force: true }, /upkeep\.lift accepts part, expectedAt and note/]]) assert.match(send(f, 'upkeep.lift', payload).error, pattern);
  assert.deepEqual(suspended(f), ['model']);
  const lifted = send(f, 'upkeep.lift', { part: 'model', expectedAt: row.at, note: 'The docs map was too wide; narrowed' }); assert.equal(lifted.status, 'completed', lifted.error);
  assert.deepEqual(suspended(f), []); assert.deepEqual({ rule: lifted.result.rule, evaluatedAfresh: lifted.result.evaluatedAfresh }, { rule: 'runs-reaching-the-model', evaluatedAfresh: ['runs', 'share'] });
  assert.equal(f.store.need('inbox', notice.id).status, 'superseded', 'its notice is closed with it');
  assert.equal(f.store.events(20).filter(event => event.type === 'upkeep.suspension-lifted').length, 1);
});

test('after a lift the ceiling is judged only on what is recorded afterwards: the entries that caused the suspension do not cause it again', t => {
  const f = sandbox(t), liftedAt = T0 + DAY;
  runs(f, mix(20, 20, { model: true })); assert.deepEqual(evaluate(f).map(row => row.part), ['model']);
  tx(f, () => ceilings.liftUpkeepCeilingInTransaction(f.store, { part: 'model', note: 'Fictional', by: 'operator', nowMs: liftedAt }));
  // The same window, read again: nothing. Nineteen new runs that all reach the model: still not a full window.
  assert.deepEqual(evaluate(f), []);
  runs(f, mix(19, 19, { model: true }), liftedAt + 1000); assert.deepEqual(evaluate(f), []);
  // The twentieth run after the lift fills it.
  runs(f, [{ model: true }], liftedAt + 2000); assert.deepEqual(evaluate(f).map(row => row.rule), ['runs-reaching-the-model']);
  // A part's own window likewise, and one part's lift does not reset another's.
  const g = sandbox(t); for (let i = 0; i < 10; i++) dispose(g, 'context', 'declined', i); for (let i = 0; i < 9; i++) dispose(g, 'capture', 'declined', i);
  assert.deepEqual(suspended(g), ['context']);
  tx(g, () => ceilings.liftUpkeepCeilingInTransaction(g.store, { part: 'context', note: 'Fictional', by: 'operator', nowMs: T0 + DAY }));
  tx(g, () => ceilings.recordUpkeepDisposalInTransaction(g.store, { part: 'context', outcome: 'declined', id: key('after'), nowMs: T0 + 2 * DAY, config: ON })); assert.deepEqual(suspended(g), [], 'one disposal after the lift is not a full window');
  tx(g, () => ceilings.recordUpkeepDisposalInTransaction(g.store, { part: 'capture', outcome: 'declined', id: key('tenth'), nowMs: T0 + 2 * DAY, config: ON })); assert.deepEqual(suspended(g), ['capture'], 'the capture window kept its nine');
  // The function itself refuses anyone but the operator.
  assert.throws(() => tx(g, () => ceilings.liftUpkeepCeilingInTransaction(g.store, { part: 'capture', note: 'x', by: 'orchestrator' })), /lifted only by the operator/);
  assert.throws(() => tx(g, () => ceilings.liftUpkeepCeilingInTransaction(g.store, { part: 'capture', note: 'x', by: 'factory' })), /lifted only by the operator/);
});

test('through the job: the run that brings the count to 6 of 20 suspends the model call, and the next run that would ask the model ends suspended without one', async t => {
  const f = upkeepProject(t), model = scriptedModel();
  // Nineteen runs on record, five of which reached the model.
  tx(f, () => { for (let i = 0; i < 19; i++) records.addToUpkeepWindowInTransaction(f.store, { run: { flowId: `earlier-${i}`, outcome: 'nothing', reason: i < 5 ? 'no-candidate' : 'no-referring-doc', stage: i < 5 ? 'model' : 'pre-filter', at: iso(Date.now() - (20 - i) * 60000), model: i < 5, candidates: false } }); });
  await f.mergedAndFinished('change-1'); const first = await f.assess({ providerInvoke: model });
  assert.equal(first.run.outcome, 'nothing'); assert.equal(first.run.reason, 'no-candidate'); assert.equal(model.calls.length, 1);
  assert.deepEqual(suspended(f), ['model']); assert.equal(records.upkeepSuspended(f.store, 'model').rule, 'runs-reaching-the-model'); assert.deepEqual({ runs: records.upkeepSuspended(f.store, 'model').window.runs, reached: records.upkeepSuspended(f.store, 'model').window.reached, entries: records.upkeepSuspended(f.store, 'model').window.entries.length }, { runs: 20, reached: 6, entries: 20 });
  assert.equal(notices(f).length, 1); assert.equal(notices(f)[0].title, 'Knowledge upkeep suspended (the model call)');
  // The next merge that refers to a declared doc: the run ends at its pre-filter, suspended, and no model starts.
  await f.mergedAndFinished('change-2', root => write(root, { 'src/api/users.js': 'export const users = [2];\n' })); const second = await f.assess({ providerInvoke: model });
  assert.deepEqual({ outcome: second.run.outcome, reason: second.run.reason, stage: second.run.stage, flags: second.run.flags }, { outcome: 'abstained', reason: 'suspended', stage: 'pre-filter', flags: ['model-suspended'] }); assert.equal(model.calls.length, 1, 'no model call');
  assert.equal(notices(f).length, 1, 'one notice, not one per run');
  // Lifted by the operator, the next such run asks the model again.
  assert.equal(send(f, 'upkeep.lift', { part: 'model', note: 'Fictional: the docs set was narrowed' }).status, 'completed');
  await f.mergedAndFinished('change-3', root => write(root, { 'src/api/users.js': 'export const users = [3];\n' })); const third = await f.assess({ providerInvoke: model });
  assert.equal(third.run.reason, 'no-candidate'); assert.equal(model.calls.length, 2); assert.deepEqual(suspended(f), []);
});
