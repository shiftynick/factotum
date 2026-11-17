// dev.92: the dev.91 re-test items P2 to P4.
//   P2 (operator decision 2026-11-17): the upkeep task ceilings limit only the tasks the factory
//      creates on its own and the acceptances a delegate makes; the operator's own direct acceptance
//      is never refused by them, is counted, and uses up the factory's room. Health shows the room
//      and when it returns, and never offers an acceptance that would be refused.
//   P3: a hand-written learning may space its paths list; the refusal names the expected form.
//   P4: status --flow carries learningSelection and learningUse; the flow page shows what each role
//      cited; one Health sentence reads plainly.
// Every project, path and model here is fictional; no provider process is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { installDom, byTag, byClass } from './fake-dom.mjs';
import { FILES, upkeepProject } from './upkeep-fixtures.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { executeCommand, findingTasks } from '../starter/factory/core/project.mjs';
import { LEARNING_PATHS_EXAMPLE, parseLearning, renderLearning } from '../starter/factory/core/upkeep-namespace.mjs';
import { raiseCandidatesInTransaction } from '../starter/factory/operations/upkeep-candidates.mjs';
import { createDocsFollowUpInTransaction, upkeepTaskBudget } from '../starter/factory/operations/upkeep-tasks.mjs';
import { addToUpkeepDayInTransaction, upkeepDay, upkeepDayId } from '../starter/factory/operations/upkeep-records.mjs';
import { proposalDigest } from '../starter/factory/operations/upkeep-context.mjs';
import { upkeepSettings } from '../starter/factory/core/upkeep-config.mjs';
import { learningCitationsOf } from '../starter/factory/operations/learnings.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';

installDom();
globalThis.innerWidth = 320;
globalThis.document.addEventListener ??= () => {}; globalThis.window.addEventListener ??= () => {};
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');

const DAY = 86400000;
const blobOf = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const send = (f, operation, payload, { actor = 'operator', onBehalfOf } = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor, operation, payload, ...(onBehalfOf ? { onBehalfOf } : {}) });
const INSTRUCTED = { actor: 'orchestrator', onBehalfOf: { principal: 'operator', instruction: 'Fictional operator instruction: accept the capture candidate' } };

// ======================================================================================
// P2: the task ceilings.
// ======================================================================================
const PROPOSE = Object.freeze({ mode: 'propose', docs: { include: ['README.md', 'docs/**/*.md'], exclude: ['docs/changes/**', 'docs/learnings/**'] } });
const FAST = { checks: [{ id: 'verify', argv: ['checks/verify.mjs'], timeoutMs: 30000 }, { id: 'lint', argv: ['node', 'checks/lint.mjs'], timeoutMs: 30000 }] };
const QUOTE = 'The user API lives in src/api/users.js and is loaded by src/server.js.';
const CHECK = Object.freeze({ kind: 'check', anchor: 'check:verify', topic: 'test', title: 'Schema fields are documented', text: 'Every field in src/schema.json has a doc string.', reason: 'A script can read the schema.', signals: [], flags: [] });
const RULE = Object.freeze({ kind: 'rule', anchor: 'context:rules', topic: 'procedure', title: 'Schema documentation', text: 'A schema field is documented in the same change.', reason: 'Every agent reads AGENTS.md.', signals: [], flags: [] });
function project(t) {
  const f = upkeepProject(t, { upkeep: structuredClone(PROPOSE), files: { ...FILES, 'checks/verify.mjs': '#!/usr/bin/env node\nprocess.exit(0);\n', 'checks/lint.mjs': 'process.exit(0);\n', 'src/schema.json': '{"fields": []}\n' }, learnings: { dir: 'docs/learnings' }, setup: root => chmodSync(join(root, 'checks/verify.mjs'), 0o755), extra: { fastChecks: FAST } });
  f.green();
  const row = id => f.store.need('finding', id);
  const raise = (candidate, flows = ['flow-source']) => { let out; for (const flowId of flows) out = f.store.tx(() => raiseCandidatesInTransaction(f.store, { flowId, candidates: [candidate] })); return row(out[0].id); };
  const accept = (id, who) => send(f, 'finding.accept', { findingId: id, expectedVersion: row(id).version }, who);
  const decline = id => assert.equal(send(f, 'finding.resolve', { findingId: id, expectedVersion: row(id).version, disposition: 'declined', reason: 'later' }).status, 'completed');
  // The factory's own docs follow-up, as a proposing run makes it, from one waiting docs candidate.
  const text = FILES['README.md'], reader = { head: 'c'.repeat(40), reaches: () => true, file: path => path === 'README.md' ? { status: 'docs', blob: blobOf(text), text } : { status: 'missing' } };
  const followUp = (nowMs = Date.now()) => { raise({ kind: 'docs', file: 'README.md', quote: QUOTE, blob: blobOf(text), reason: 'The API moved.', signals: [] }, [`flow-docs-${uid()}`]); return f.store.tx(() => createDocsFollowUpInTransaction(f.store, { reader, tasks: findingTasks(f.store), nowMs })); };
  const health = () => JSON.parse(JSON.stringify(dashboardSnapshot(f.store))).upkeep;
  const card = () => byClass(operationsView({ projectId: 'fictional', bindingId: 'b', name: 'Fictional', status: 'available', snapshot: dashboardSnapshot(f.store) }), 'card').find(node => /^Knowledge upkeep/.test(node.textContent));
  const today = () => upkeepDay(f.store, upkeepDayId());
  return { ...f, row, raise, accept, decline, followUp, health, card, today };
}
const tomorrow = () => new Date(Date.parse(`${upkeepDayId()}T00:00:00.000Z`) + DAY).toISOString();

test('P2, the trial repro: a factory docs follow-up, then the operator\'s own acceptances, which now succeed past the daily ceiling', t => {
  const f = project(t);
  // 00:00:29 in the trial: the factory makes a docs follow-up by itself.
  const made = f.followUp(); assert.ok(made.task, JSON.stringify(made));
  assert.deepEqual([f.today().tasksCreated, f.today().operatorTasksCreated], [1, 0]);
  // 00:05: the operator accepts one candidate.
  const a = f.raise(CHECK); assert.equal(f.accept(a.id).status, 'completed');
  assert.deepEqual([f.today().tasksCreated, f.today().operatorTasksCreated], [2, 1]);
  // The limit is reached for the factory and a delegate; Health says so, with when it resets.
  const budget = f.health().taskBudget;
  assert.deepEqual(budget.day, { created: 2, byOperator: 1, limit: 2, remaining: 0, resetsAt: tomorrow() });
  assert.equal(budget.refusal, `2 upkeep tasks were created today, which is the limit (upkeep.budget.maxTasksPerDay 2); it resets at ${tomorrow()}`);
  // Every later acceptance by the operator succeeds: a capture candidate and a rule (a governing proposal).
  f.decline(a.id);
  const b = f.raise({ ...CHECK, anchor: 'check:lint' }, ['flow-b']);
  const shownB = f.health().candidates.find(row => row.id === b.id);
  assert.deepEqual(shownB.acceptance.problems, [], 'Health offers it to the operator');
  const second = f.accept(b.id); assert.equal(second.status, 'completed', second.error);
  const rule = f.raise({ ...RULE, file: 'AGENTS.md', blob: blobOf(FILES['AGENTS.md']), entries: ['rules'] }, ['flow-r1', 'flow-r2']);
  assert.deepEqual(f.health().candidates.find(row => row.id === rule.id).acceptance.problems, [], 'the rule is offered too: the ceiling does not apply to the operator');
  const accepted = send(f, 'finding.accept', { proposals: [{ findingId: rule.id, expectedVersion: rule.version, digest: proposalDigest(rule) }] });
  assert.equal(accepted.status, 'completed', accepted.error);
  // All recorded, for visibility: four tasks today, three of them the operator's.
  assert.deepEqual([f.today().tasksCreated, f.today().operatorTasksCreated], [4, 3]);
  const events = f.store.events(400).filter(event => event.type === 'upkeep.task-created').sort((x, y) => x.sequence - y.sequence).map(event => [event.payload.kind, event.payload.by, event.payload.direct]);
  assert.deepEqual(events.slice(-3), [['check', 'operator', true], ['check', 'operator', true], ['context', 'operator', true]]);
  // Health: the counts, and that the operator's own acceptances are not limited.
  const text = f.card().textContent;
  assert.match(text, /Upkeep tasks: 4 of 2 today \(3 by you\), 4 of 6 in the last seven UTC days \(3 by you\)\./);
  assert.match(text, /The limit is reached: the factory makes no docs follow-up, and the orchestrator cannot accept a candidate, until .*\. Your own acceptances are not limited; they still count\./);
});

test('P2: the operator\'s acceptances use up the factory\'s room, and the factory still stops at the daily and weekly ceilings', t => {
  const f = project(t);
  const a = f.raise(CHECK); assert.equal(f.accept(a.id).status, 'completed'); f.decline(a.id);
  const b = f.raise({ ...CHECK, anchor: 'check:lint' }, ['flow-b']); assert.equal(f.accept(b.id).status, 'completed');
  assert.deepEqual([f.today().tasksCreated, f.today().operatorTasksCreated], [2, 2]);
  // Conservative: the factory gets no room from them.
  const refused = f.followUp(); assert.equal(refused.reason, 'daily-ceiling'); assert.equal(refused.task, undefined);
  assert.equal(f.today().tasksCreated, 2);
  // The weekly ceiling, on the same counts: six over the last seven UTC days.
  const g = project(t), nowMs = Date.now(), start = Date.parse(`${upkeepDayId(nowMs)}T00:00:00.000Z`);
  g.store.tx(() => { for (const back of [1, 2, 3]) addToUpkeepDayInTransaction(g.store, upkeepDayId(start - back * DAY), { counters: { tasksCreated: 2, operatorTasksCreated: back === 3 ? 2 : 0 } }); });
  assert.equal(g.followUp(nowMs).reason, 'weekly-ceiling');
});

test('P2: a delegated acceptance at the ceiling is refused, Health says so beside the operator\'s Accept, and nothing is written', t => {
  const f = project(t);
  assert.ok(f.followUp().task);
  const a = f.raise(CHECK); assert.equal(f.accept(a.id).status, 'completed'); f.decline(a.id);
  const b = f.raise({ ...CHECK, anchor: 'check:lint' }, ['flow-b']);
  // Health: nothing refuses the operator; the delegated list names the ceiling and its reset.
  const shown = f.health().candidates.find(row => row.id === b.id);
  assert.deepEqual(shown.acceptance.problems, []);
  assert.deepEqual(shown.acceptance.delegatedProblems, [`not now: a delegated acceptance is limited by the task ceilings: 2 upkeep tasks were created today, which is the limit (upkeep.budget.maxTasksPerDay 2); it resets at ${tomorrow()}`]);
  // The console offers the operator's Accept and says the orchestrator cannot, at phone width, as text.
  const card = f.card(), summaries = byTag(card, 'summary').map(node => node.textContent);
  assert.ok(summaries.includes('Accept: make a task that changes the fast check'), summaries.join(' | '));
  assert.match(card.textContent, /The orchestrator cannot accept it now: not now: a delegated acceptance is limited by the task ceilings: 2 upkeep tasks were created today, which is the limit \(upkeep\.budget\.maxTasksPerDay 2\); it resets at \S+\. You can\./);
  // The orchestrator, on an instruction, is refused with the same reason; nothing is written.
  const tasks = f.store.count('task'), before = f.today();
  const refused = f.accept(b.id, INSTRUCTED);
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error, /cannot be accepted now: a delegated acceptance is limited by the task ceilings: 2 upkeep tasks were created today, which is the limit \(upkeep\.budget\.maxTasksPerDay 2\); it resets at /);
  assert.equal(f.store.count('task'), tasks); assert.deepEqual(f.today(), before); assert.equal(f.row(b.id).status, 'unapproved');
  // The operator, directly, is not.
  const done = f.accept(b.id); assert.equal(done.status, 'completed', done.error);
  // Below the ceiling the orchestrator accepts as before, and it is counted as the factory's own room.
  const g = project(t), c = g.raise(CHECK), delegated = g.accept(c.id, INSTRUCTED);
  assert.equal(delegated.status, 'completed', delegated.error); assert.deepEqual([g.today().tasksCreated, g.today().operatorTasksCreated], [1, 0]);
  assert.deepEqual(g.health().candidates, []);
});

test('P2: the weekly window in Health: what was made, by whom, and when room returns; a limit of 0 has none', t => {
  const f = project(t), settings = upkeepSettings(f.store.meta('config')), nowMs = Date.parse('2026-11-17T00:05:00.000Z'), start = Date.parse('2026-11-17T00:00:00.000Z');
  // Six over the window: two six days back, one each on three other days, one today by the operator.
  f.store.tx(() => {
    addToUpkeepDayInTransaction(f.store, '2026-11-11', { counters: { tasksCreated: 2 } });
    for (const day of ['2026-11-13', '2026-11-14', '2026-11-15']) addToUpkeepDayInTransaction(f.store, day, { counters: { tasksCreated: 1 } });
    addToUpkeepDayInTransaction(f.store, '2026-11-17', { counters: { tasksCreated: 1, operatorTasksCreated: 1 } });
  });
  const budget = upkeepTaskBudget(f.store, { settings, nowMs });
  assert.deepEqual(budget.day, { created: 1, byOperator: 1, limit: 2, remaining: 1, resetsAt: null });
  // 2026-11-11 leaves the window at the first midnight: room returns then.
  assert.deepEqual(budget.week, { created: 6, byOperator: 1, limit: 6, remaining: 0, resetsAt: new Date(start + DAY).toISOString() });
  const zero = upkeepTaskBudget(f.store, { settings: { ...settings, budget: { ...settings.budget, maxTasksPerDay: 0, maxTasksPerWeek: 0 } }, nowMs });
  assert.deepEqual([zero.day.remaining, zero.day.resetsAt, zero.week.resetsAt], [0, null, null]);
  // Outside propose, nothing is created or accepted: Health reads no day row and shows no budget.
  f.store.setMeta('config', { ...f.store.meta('config'), upkeep: { ...PROPOSE, mode: 'observe' } });
  assert.equal(f.health().taskBudget, null);
});

test('P2: Health never offers an acceptance the command would refuse: an open task of the kind, or the mode', t => {
  const f = project(t);
  const a = f.raise(CHECK); assert.equal(f.accept(a.id).status, 'completed');
  const b = f.raise({ ...CHECK, anchor: 'check:lint' }, ['flow-b']);
  const shown = f.health().candidates.find(row => row.id === b.id);
  assert.equal(shown.acceptance.problems.length, 1); assert.match(shown.acceptance.problems[0], /^not now: check task upkeep:check:[a-f0-9]{32} is still open; one check task is delivered at a time$/);
  const card = f.card();
  assert.ok(!byTag(card, 'summary').some(node => node.textContent === 'Accept: make a task that changes the fast check'), 'no Accept is offered');
  assert.match(card.textContent, /It cannot be accepted: not now: check task upkeep:check:[a-f0-9]{32} is still open/);
  assert.match(f.accept(b.id).error, /is still open; one check task is delivered at a time/);
  // A rule while upkeep only observes.
  const rule = f.raise({ ...RULE, file: 'AGENTS.md', blob: blobOf(FILES['AGENTS.md']), entries: ['rules'] }, ['flow-r1', 'flow-r2']);
  f.store.setMeta('config', { ...f.store.meta('config'), upkeep: { ...PROPOSE, mode: 'observe' } });
  const problems = f.health().candidates.find(row => row.id === rule.id).acceptance.problems;
  assert.deepEqual(problems, ['not now: upkeep.mode is not propose; proposals are accepted only while upkeep proposes']);
  assert.match(send(f, 'finding.accept', { proposals: [{ findingId: rule.id, expectedVersion: rule.version, digest: proposalDigest(rule) }] }).error, /upkeep\.mode is not propose/);
});

test('P2: the budget Health shows reads seven day rows by key and nothing else', t => {
  const f = project(t);
  assert.ok(dashboardSnapshot(f.store).upkeep.taskBudget);
  const prepare = f.store.db.prepare.bind(f.store.db), seen = [];
  f.store.db.prepare = sql => { seen.push(sql); return prepare(sql); };
  try { upkeepTaskBudget(f.store, { nowMs: Date.now() }); } finally { f.store.db.prepare = prepare; }
  const reads = seen.filter(sql => /FROM records/.test(sql));
  assert.equal(reads.length, 7, 'one by-key read per day');
  assert.ok(!reads.some(sql => /json_extract|json_each/.test(sql)), 'no JSON read over records.data');
});

// ======================================================================================
// P3: a hand-written learning with a spaced paths list.
// ======================================================================================
const FIELDS = Object.freeze({ id: 'learning-0123456789ab', title: 'Totals are rounded once', paths: ['src/totals.mjs', 'test/totals.test.mjs'], kind: 'procedure', enforced_by: 'none', last_verified: '2026-11-16', retire_when: 'none', body: 'Round a fictional total once, at the end.' });
test('P3: a learning whose paths list carries ordinary JSON or YAML flow-list spacing reads as the same learning; anything else names the expected form', () => {
  const canonical = renderLearning(FIELDS);
  assert.ok(canonical.includes('paths: ["src/totals.mjs","test/totals.test.mjs"]\n'));
  for (const line of ['paths: ["src/totals.mjs", "test/totals.test.mjs"]', 'paths: [ "src/totals.mjs", "test/totals.test.mjs" ]', 'paths: ["src/totals.mjs" , "test/totals.test.mjs"]']) {
    const parsed = parseLearning(canonical.replace('paths: ["src/totals.mjs","test/totals.test.mjs"]', line));
    assert.equal(parsed.problems, undefined, line); assert.deepEqual(parsed.fields, { ...FIELDS }, line);
    // Read back and written again, it is the canonical file: nothing else moved.
    assert.equal(renderLearning(parsed.fields), canonical);
  }
  // Not JSON: unquoted (YAML-only), single quotes, a tab.
  for (const line of ['paths: [src/totals.mjs, test/totals.test.mjs]', "paths: ['src/totals.mjs']", 'paths: ["src/totals.mjs",\t"test/totals.test.mjs"]']) {
    const parsed = parseLearning(canonical.replace('paths: ["src/totals.mjs","test/totals.test.mjs"]', line));
    assert.ok(parsed.problems, line);
    assert.ok(parsed.problems.some(problem => problem.includes(LEARNING_PATHS_EXAMPLE)), `${line}: ${parsed.problems}`);
  }
  // Every other line is still exact, and the refusal says which line and what it should read.
  const escaped = parseLearning(canonical.replace('title: "Totals are rounded once"', 'title: "Totals are rounded \\u006fnce"'));
  assert.deepEqual(escaped.problems, ['the file is not written exactly in the learning layout: line 3 should read "title: \\"Totals are rounded once\\""']);
  assert.deepEqual(parseLearning(`${canonical}\n`).problems, ['the file is not written exactly in the learning layout: it ends with more than one newline after the body; end it with exactly one']);
  // The starter template shows a list of two, written the ordinary way, and says so.
  assert.equal(LEARNING_PATHS_EXAMPLE, 'paths: ["src/example/**", "test/example.test.mjs"]');
});

// ======================================================================================
// P4: status --flow and the flow page.
// ======================================================================================
const BLOB = 'a'.repeat(40), COMMIT = 'c'.repeat(40);
const PIN = { cycle: 1, step: 'plan', commit: COMMIT, dir: 'docs/learnings', at: '2026-11-17T00:10:00.000Z', entries: [{ id: 'learning-5e1ec7ed0c1d', path: 'docs/learnings/learning-5e1ec7ed0c1d.md', blob: BLOB, chars: 300 }], skipped: [], refused: [] };
const CITED = [
  { cycle: 1, step: 'plan', role: 'planner', attemptId: 'attempt-1', at: '2026-11-17T00:11:00.000Z', cited: [{ id: 'learning-5e1ec7ed0c1d', use: 'applied' }] },
  { cycle: 1, step: 'build', role: 'builder', attemptId: 'attempt-2', at: '2026-11-17T00:12:00.000Z', cited: [{ id: 'learning-5e1ec7ed0c1d', use: 'applied' }] },
  { cycle: 1, step: 'review', role: 'reviewer', attemptId: 'attempt-3', at: '2026-11-17T00:13:00.000Z', cited: [{ id: 'learning-5e1ec7ed0c1d', use: 'followed' }] },
];
test('P4: status --flow returns the flow\'s learningSelection, learningUse and what each role cited, read from the flow record by key', t => {
  const f = upkeepProject(t, { upkeep: null }); f.green();
  const task = f.command('task.put', { task: { id: 'fictional-task', title: 'Fictional change', acceptance: ['It changes'] } }).result;
  assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed');
  const started = f.command('flow.start', { taskId: task.id, revision: task.revision, flowId: 'flow-1' }); assert.equal(started.status, 'completed', started.error);
  const flow = f.store.need('flow', 'flow-1');
  f.store.put('flow', { ...flow, learningSelection: PIN, learningUse: { selected: ['learning-5e1ec7ed0c1d'], cited: ['learning-5e1ec7ed0c1d'], windows: { 'learning-5e1ec7ed0c1d': 1 } }, learningCitations: CITED });
  const shown = stateView(f.store, { flow: 'flow-1' }).flow;
  assert.deepEqual(shown.learningSelection, { cycle: 1, step: 'plan', commit: COMMIT, dir: 'docs/learnings', at: PIN.at, entries: [{ id: 'learning-5e1ec7ed0c1d', path: 'docs/learnings/learning-5e1ec7ed0c1d.md', blob: BLOB }], skipped: [], refused: [] });
  assert.deepEqual(shown.learningUse, { selected: ['learning-5e1ec7ed0c1d'], cited: ['learning-5e1ec7ed0c1d'] }, 'without the delivery-window bookkeeping');
  assert.deepEqual(shown.learningCitations.map(row => [row.role, row.cited]), [['planner', [{ id: 'learning-5e1ec7ed0c1d', use: 'applied' }]], ['builder', [{ id: 'learning-5e1ec7ed0c1d', use: 'applied' }]], ['reviewer', [{ id: 'learning-5e1ec7ed0c1d', use: 'followed' }]]]);
  assert.deepEqual(shown.learningHistory, []);
  // A flow with no learnings: null and empty, never missing keys.
  f.store.put('flow', flow);
  const bare = stateView(f.store, { flow: 'flow-1' }).flow;
  assert.deepEqual([bare.learningSelection, bare.learningUse, bare.learningCitations], [null, null, []]);
  // A flow settled before dev.92 has no learningCitations: they come from its plan, build and review results, kept to what it was shown.
  const older = { learningSelection: PIN, results: { plan: { route: 'ready', result: { learningsApplied: [{ id: 'learning-5e1ec7ed0c1d', use: 'applied' }, { id: 'learning-ffffffffffff', use: 'applied' }] } }, review: { route: 'pass', result: { learningsChecked: [{ id: 'learning-5e1ec7ed0c1d', outcome: 'contradicted' }] } } } };
  assert.deepEqual(learningCitationsOf(older).map(row => [row.role, row.cited]), [['planner', [{ id: 'learning-5e1ec7ed0c1d', use: 'applied' }]], ['reviewer', [{ id: 'learning-5e1ec7ed0c1d', use: 'contradicted' }]]]);
});

test('P4: the flow page shows what each role cited, as text, at 320 px; a cycle nobody cited from says so', () => {
  const render = (flow, extra = {}) => {
    const p = { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: { revision: 1, flows: [{ id: flow.id, state: 'running', step: 'build', taskSnapshot: { title: 'Fictional change' } }], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [], settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: {} } } };
    state.reads.clear();
    state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, 'flows', flow.id, {})}`, { status: 'ready', data: { flow, attempts: [], inbox: [], events: [], waits: [], contexts: [], pushback: [], obligations: [], regressions: [], ...extra }, fetchedAt: new Date().toISOString(), revision: 1 });
    return byClass(timeline.flowDetail(p, flow.id, { projectId: 'fictional', tab: 'timeline', params: { flow: flow.id } }), 'card').find(node => /^Learnings shown to agents/.test(node.textContent));
  };
  const flow = { id: 'flow-1', kind: 'change', state: 'running', step: 'build', taskId: 'task-1', createdAt: new Date().toISOString(), learningSelection: PIN };
  const hostile = [...CITED, { cycle: 1, step: 'build', role: 'builder', attemptId: 'attempt-4', cited: [{ id: '<img src=x onerror=alert(1)>', use: 'applied' }] }];
  const card = render(flow, { learningCitations: hostile });
  assert.match(card.textContent, /What each role cited:/);
  assert.match(card.textContent, /Planner \(plan\): learning-5e1ec7ed0c1d applied/);
  assert.match(card.textContent, /Reviewer \(review\): learning-5e1ec7ed0c1d followed/);
  // The latest entry per role and step; ids are text, never markup.
  assert.match(card.textContent, /Builder \(build\): <img src=x onerror=alert\(1\)> applied/);
  assert.equal(byTag(card, 'img').length, 0);
  assert.equal(globalThis.innerWidth, 320);
  // From the flow record when the service sends no list (an older service).
  assert.match(render({ ...flow, learningCitations: CITED }).textContent, /Builder \(build\): learning-5e1ec7ed0c1d applied/);
  assert.match(render(flow, { learningCitations: [] }).textContent, /No role has cited a learning of this cycle yet\./);
});

test('P2 review: Health names the later reset when both ceilings are reached, and none for a zero limit', async () => {
  const { budgetResumesAt } = await import('../starter/factory/console/ui/operations.mjs');
  const day = { remaining: 0, resetsAt: '2026-11-18T00:00:00.000Z' }, weekFull = { remaining: 0, resetsAt: '2026-11-21T00:00:00.000Z' };
  assert.equal(budgetResumesAt({ day, week: weekFull }), weekFull.resetsAt, 'two today and four yesterday: the week is still full tomorrow');
  assert.equal(budgetResumesAt({ day, week: { remaining: 3, resetsAt: null } }), day.resetsAt);
  assert.equal(budgetResumesAt({ day: { remaining: 2, resetsAt: null }, week: weekFull }), weekFull.resetsAt);
  assert.equal(budgetResumesAt({ day: { remaining: 0, resetsAt: null }, week: weekFull }), null, 'a zero limit never resets');
});
test('P2 review: a delegated refusal names the weekly reset too when both ceilings are reached', async () => {
  const { taskCeilingRefusal } = await import('../starter/factory/operations/upkeep-tasks.mjs');
  const text = taskCeilingRefusal({ day: { created: 2, limit: 2, remaining: 0, resetsAt: '2026-11-18T00:00:00.000Z' }, week: { created: 6, limit: 6, remaining: 0, resetsAt: '2026-11-21T00:00:00.000Z' } });
  assert.match(text, /resets at 2026-11-18/); assert.match(text, /seven-day limit .* reached too: room returns at 2026-11-21/);
});
