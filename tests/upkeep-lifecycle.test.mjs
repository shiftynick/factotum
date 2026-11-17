// Knowledge upkeep, slice 4: the candidate lifecycle and who may move it (design 4.3, 4.4).
// Every transition is allowed only to the listed actor and only at the expected version; a rule or
// a learning is raised only after two distinct flows; a closed candidate is never reopened by the
// factory; a third return expires; declining a tasked candidate closes its task; audit dispositions
// close and reopen their obligations. Everything is fictional, and no model runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sandbox } from './helpers.mjs';
import { upkeepProject } from './upkeep-fixtures.mjs';
import { executeCommand, settleFlowFindingsInTransaction } from '../starter/factory/core/project.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { DELEGABLE } from '../starter/factory/core/delegation.mjs';
import { ENFORCED_UPKEEP_KINDS } from '../starter/factory/core/upkeep-namespace.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { auditFindingsInTransaction } from '../starter/factory/operations/governance.mjs';
import { captureClassKey, quoteClassKey } from '../starter/factory/operations/upkeep-class-key.mjs';
import * as candidates from '../starter/factory/operations/upkeep-candidates.mjs';
import { observedClass, upkeepCandidate, upkeepObservedCount, upkeepOpen, upkeepWindow } from '../starter/factory/operations/upkeep-records.mjs';

const DAY = 86400000, T0 = Date.parse('2026-11-10T12:00:00.000Z'), iso = ms => new Date(ms).toISOString();
const INSTRUCTION = { principal: 'operator', instruction: 'Fictional operator instruction: deal with this finding' };
const send = (f, operation, payload, { actor = 'operator', onBehalfOf } = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), operation, payload, actor, ...(onBehalfOf ? { onBehalfOf } : {}) });
const tx = (f, fn) => f.store.tx(fn);

// One validated candidate of each kind, as the validator hands them over.
const CANDIDATE = {
  docs: (n = 1) => ({ kind: 'docs', file: 'README.md', quote: `The user API lives in src/api/users-${n}.js`, reason: 'The merge renamed the file', signals: [], flags: [] }),
  context: (n = 1) => ({ kind: 'context', file: 'AGENTS.md', quote: `Never import src/legacy-${n}.js from new code.`, replacement: 'Never import src/old.js from new code.', reason: 'The merge renamed the file', signals: [], flags: [] }),
  check: (n = 1) => ({ kind: 'check', anchor: `check:lint-${n}`, topic: 'test', title: 'Fictional check', text: 'A script can test that every handler has a test.', reason: 'Sent back twice', signals: ['S1'], flags: [] }),
  rule: (n = 1) => ({ kind: 'rule', anchor: `context:rules-${n}`, topic: 'procedure', title: 'Fictional rule', text: 'Run the schema check before changing a table.', reason: 'Sent back', signals: ['S1'], flags: [] }),
  learning: (n = 1) => ({ kind: 'learning', anchor: `dir:src/api-${n}`, topic: 'interface-use', title: 'Fictional learning', text: 'The pager counts from one.', reason: 'Sent back', signals: ['S1'], flags: [] }),
  'learning-stale': (n = 1) => ({ kind: 'learning-stale', learningId: `api-pagination-${n}`, condition: 'paths' }),
};
const UPKEEP_KINDS = Object.keys(CANDIDATE), KINDS = ['audit', ...UPKEEP_KINDS];
const raise = (f, list, flowId = 'flow-a', nowMs = T0) => tx(f, () => candidates.raiseCandidatesInTransaction(f.store, { flowId, candidates: list, nowMs }));
// An open row of a kind: an upkeep candidate (a rule or a learning from its second flow), or an audit
// finding with the pending obligation the engine opens for it.
function open(f, kind, n = 1) {
  if (kind === 'audit') {
    const [row] = tx(f, () => auditFindingsInTransaction(f.store, { findings: [{ id: `audit:${digest({ n })}`, title: `Fictional audit finding ${n}`, evidence: `src/api/users.js:${n}`, file: 'src/api/users.js' }] }));
    tx(f, () => f.store.put('obligation', { id: `finding:${row.id}`, findingId: row.id, title: row.title, evidence: row.evidence, status: 'pending', approved: false, owner: 'operator', createdAt: iso(T0) }));
    return row;
  }
  if (candidates.OBSERVED_FIRST.includes(kind)) raise(f, [CANDIDATE[kind](n)], `flow-first-${n}`);
  const [result] = raise(f, [CANDIDATE[kind](n)], `flow-second-${n}`); assert.equal(result.outcome, 'raised', kind);
  return upkeepCandidate(f.store, result.id);
}
// A stored task for a finding (as a later slice's creation path would write it), and the link.
function task(f, id, findings = []) { const record = { id, title: `Fictional task ${id}`, acceptance: ['Observed'], revision: digest({ id }), approvedRevision: null, approvalVersion: 1, findings }; tx(f, () => f.store.put('task', record)); return record; }
const tasks = (f, closed = []) => ({ get: id => f.store.get('task', id) ?? null, busy: () => null, started: () => false, close: (id, why) => { closed.push([id, why]); f.store.put('task', { ...f.store.get('task', id), closed: true }); } });
function tasked(f, kind, n = 1) {
  const row = open(f, kind, n), record = task(f, `task-${kind}-${n}`, [row.id]);
  tx(f, () => candidates.linkFindingsInTransaction(f.store, { findings: [{ id: row.id, expectedVersion: row.version }], task: record, by: candidates.taskedBy(kind), nowMs: T0 }));
  return f.store.need('finding', row.id);
}
const settle = (f, row, outcome, extra = {}) => tx(f, () => candidates.settleFindingTaskInTransaction(f.store, { taskId: row.taskId, findingIds: [row.id], outcome, closeTask: (id, why) => tasks(f).close(id, why), nowMs: T0, ...extra }));
// A row of a kind in any state, reached only by moves the design allows.
function inState(f, kind, status, n = 1) {
  if (status === 'unapproved') return open(f, kind, n);
  if (status === 'tasked') return tasked(f, kind, n);
  if (['delivered', 'failed'].includes(status)) { const row = tasked(f, kind, n); settle(f, row, status); return f.store.need('finding', row.id); }
  if (status === 'expired') { const row = tasked(f, kind, n); settle(f, row, 'expired'); return f.store.need('finding', row.id); }
  const row = open(f, kind, n);
  tx(f, () => candidates.disposeFindingInTransaction(f.store, { id: row.id, expectedVersion: row.version, disposition: status, reason: 'unnecessary', evidence: 'Fixed by hand in a fictional commit', by: { actor: 'operator' }, tasks: tasks(f), nowMs: T0 }));
  return f.store.need('finding', row.id);
}

// Take a row out of the open set once a scenario is done with it, so that the caps (tested on their
// own) never decide what a scenario of these tables sees.
function drop(f, id) {
  const row = f.store.need('finding', id);
  if (row.status === 'tasked') settle(f, row, 'failed');
  else if (row.status === 'unapproved') tx(f, () => candidates.disposeFindingInTransaction(f.store, { id, expectedVersion: row.version, disposition: 'declined', reason: 'unnecessary', by: { actor: 'operator' }, tasks: tasks(f), nowMs: T0 }));
}

// ---- The table of 4.3, written out here and compared with the code's ----
// [from, to]: who may make the move. `tasked` from `unapproved` depends on the kind.
const DESIGN = {
  'unapproved>declined': ['person'], 'tasked>declined': ['person'],
  'unapproved>expired': ['factory'], 'tasked>expired': ['factory'],
  'unapproved>resolved-elsewhere': ['factory', 'person'], 'tasked>resolved-elsewhere': ['factory', 'person'],
  'tasked>delivered': ['factory'], 'tasked>failed': ['factory'], 'tasked>unapproved': ['factory'],
  'declined>unapproved': ['person'], 'expired>unapproved': ['person'], 'failed>unapproved': ['person'], 'resolved-elsewhere>unapproved': ['person'],
};
const TASKED_BY = { docs: 'factory', check: 'person', learning: 'person', 'learning-stale': 'person', context: 'person', rule: 'person', audit: 'person' };
const AUTHORITY = { audit: 'delegable', docs: 'delegable', check: 'delegable', learning: 'delegable', 'learning-stale': 'delegable', context: 'operator', rule: 'operator' };

test('the states and the transition table are the design\'s: every pair of states, for the factory and for a person, for every kind', () => {
  assert.deepEqual(candidates.FINDING_STATUSES, ['unapproved', 'tasked', 'delivered', 'failed', 'declined', 'expired', 'resolved-elsewhere']);
  assert.deepEqual(candidates.DECLINE_REASONS, ['unnecessary', 'wrong', 'duplicate', 'later']);
  let allowed = 0;
  for (const kind of KINDS) for (const from of candidates.FINDING_STATUSES) for (const to of candidates.FINDING_STATUSES) for (const by of ['factory', 'person']) {
    const row = { id: 'x', status: from, ...(kind === 'audit' ? { source: 'audit' } : { source: 'upkeep', kind }) };
    // One move beyond 4.3's table, for audit findings only (review of fb4949c, open question 3): a later
    // proven merge of the same task at the linked revision delivers a failed audit finding.
    const expected = from === 'unapproved' && to === 'tasked' ? TASKED_BY[kind] === by : from === 'failed' && to === 'delivered' ? kind === 'audit' && by === 'factory' : (DESIGN[`${from}>${to}`] ?? []).includes(by);
    assert.equal(candidates.transitionAllowed(row, to, by), expected, `${kind}: ${from} -> ${to} by ${by}`); if (expected) allowed++;
  }
  // 13 moves between states, two of them open to both, and one way to be tasked: 16 per kind, and
  // the audit finding's late delivery.
  assert.equal(allowed, KINDS.length * 16 + 1);
  // Raising: the factory only, and only where there is no row.
  assert.equal(candidates.transitionAllowed(null, 'unapproved', 'factory'), true); assert.equal(candidates.transitionAllowed(null, 'unapproved', 'person'), false);
  for (const to of candidates.FINDING_STATUSES.filter(status => status !== 'unapproved')) for (const by of ['factory', 'person']) assert.equal(candidates.transitionAllowed(null, to, by), false, `nothing is raised as ${to}`);
  // A delivered finding is final: no move leaves it.
  for (const to of candidates.FINDING_STATUSES) for (const by of ['factory', 'person']) assert.equal(candidates.transitionAllowed({ status: 'delivered', source: 'upkeep', kind: 'docs' }, to, by), false);
  for (const kind of KINDS) { const row = kind === 'audit' ? { source: 'audit' } : { source: 'upkeep', kind }; assert.equal(candidates.findingAuthority(row), AUTHORITY[kind], kind); assert.equal(candidates.taskedBy(kind), TASKED_BY[kind], kind); }
  // A kind this release does not know is the operator's alone, and is tasked by nobody's default.
  assert.equal(candidates.findingAuthority({ source: 'upkeep', kind: 'policy' }), 'operator'); assert.equal(candidates.findingKind({ source: 'upkeep', kind: 'policy' }), 'unknown');
  assert.deepEqual(['finding.accept', 'finding.resolve', 'finding.reopen'].filter(name => !DELEGABLE.includes(name)), [], 'the three commands are delegable'); assert.equal(DELEGABLE.includes('upkeep.lift'), false);
});

test('the factory\'s moves: each is made by the factory\'s own functions, re-reading the row, and no factory function makes a person\'s move', t => {
  const f = sandbox(t);
  for (const [index, kind] of KINDS.entries()) {
    const n = index * 10;
    // tasked -> delivered, failed, expired, and the return to unapproved.
    for (const [offset, outcome, status] of [[1, 'delivered', 'delivered'], [2, 'failed', 'failed'], [3, 'expired', 'expired'], [4, 'resolved-elsewhere', 'resolved-elsewhere']]) {
      const row = tasked(f, kind, n + offset), [next] = settle(f, row, outcome);
      assert.equal(next.status, status, `${kind}: ${outcome}`); assert.equal(next.version, row.version + 1, 'a change of status raises the version');
      // Settling again finds nothing tasked: the row was re-read.
      assert.deepEqual(settle(f, row, outcome), []); assert.equal(f.store.need('finding', row.id).version, next.version);
    }
    const back = tasked(f, kind, n + 5), [returned] = settle(f, back, 'returned', { reason: 'drain' });
    assert.equal(returned.status, 'unapproved'); assert.equal(returned.returns, 1); assert.equal(returned.taskId, undefined); assert.equal(returned.lastTaskId, back.taskId);
    // unapproved -> resolved-elsewhere and tasked -> resolved-elsewhere, by the factory, with its own typed reason.
    for (const status of ['unapproved', 'tasked']) {
      const row = inState(f, kind, status, n + (status === 'tasked' ? 6 : 7));
      const { finding } = tx(f, () => candidates.resolveFindingElsewhereInTransaction(f.store, { id: row.id, reason: 'statement-gone', tasks: tasks(f) }));
      assert.equal(finding.status, 'resolved-elsewhere'); assert.equal(finding.disposition.by, 'factory');
    }
    // What the factory may not do: decline, reopen, or settle with an outcome that is a person's.
    const waiting = tasked(f, kind, n + 8);
    assert.throws(() => settle(f, waiting, 'declined'), /unknown task outcome declined/); assert.throws(() => settle(f, waiting, 'unapproved'), /unknown task outcome/);
    assert.throws(() => tx(f, () => candidates.resolveFindingElsewhereInTransaction(f.store, { id: waiting.id, reason: 'unnecessary', tasks: tasks(f) })), /the factory resolves a finding elsewhere for one of/);
    assert.throws(() => settle(f, waiting, 'returned', { reason: 'unnecessary' }), /a return names why the flow was abandoned/);
    assert.throws(() => tx(f, () => candidates.settleFindingTaskInTransaction(f.store, { taskId: waiting.taskId, findingIds: [waiting.id], outcome: 'returned', reason: 'drain' })), /closed in the same transaction/);
    // The factory tasks a docs candidate and nothing else; a person tasks everything else and never a docs candidate.
    const fresh = open(f, kind, n + 9), record = task(f, `task-other-${kind}`), other = TASKED_BY[kind] === 'factory' ? 'person' : 'factory';
    assert.throws(() => tx(f, () => candidates.linkFindingsInTransaction(f.store, { findings: [{ id: fresh.id, expectedVersion: fresh.version }], task: record, by: other })), /cannot go from unapproved to tasked by/);
    assert.equal(f.store.need('finding', fresh.id).status, 'unapproved');
    // Tasking is at the expected version, for the factory as for a person.
    assert.throws(() => tx(f, () => candidates.linkFindingsInTransaction(f.store, { findings: [{ id: fresh.id, expectedVersion: fresh.version + 1 }], task: record, by: TASKED_BY[kind] })), /changed since it was read/);
  }
  // A closed row is not reopened by any factory function: a return, a settlement or a resolution finds nothing to move.
  for (const status of candidates.FINDING_REOPENABLE) {
    const row = inState(f, 'docs', status, 900 + candidates.FINDING_REOPENABLE.indexOf(status));
    assert.deepEqual(tx(f, () => candidates.settleFindingTaskInTransaction(f.store, { taskId: row.taskId ?? 'none', findingIds: [row.id], outcome: 'returned', reason: 'drain', closeTask() {} })), []);
    assert.throws(() => tx(f, () => candidates.resolveFindingElsewhereInTransaction(f.store, { id: row.id, reason: 'statement-gone', tasks: tasks(f) })), /reopen it first/);
    assert.equal(f.store.need('finding', row.id).status, status);
  }
});

// ---- The people (4.3): operator, delegated orchestrator, and everyone else ----
const ACTORS = {
  operator: { actor: 'operator' },
  delegated: { actor: 'orchestrator', onBehalfOf: INSTRUCTION },
  'orchestrator without an instruction': { actor: 'orchestrator' },
};
const MAY = { delegable: ['operator', 'delegated'], operator: ['operator'] };
// What each person's move is as a command, from a state it applies to.
const MOVES = [
  { name: 'decline an open finding', from: 'unapproved', to: 'declined', command: row => ['finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'declined', reason: 'wrong' }] },
  { name: 'decline a tasked finding', from: 'tasked', to: 'declined', command: row => ['finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'declined', reason: 'later' }] },
  { name: 'record an open finding as resolved elsewhere', from: 'unapproved', to: 'resolved-elsewhere', command: row => ['finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'resolved-elsewhere', evidence: 'Fixed in a fictional commit' }] },
  { name: 'record a tasked finding as resolved elsewhere', from: 'tasked', to: 'resolved-elsewhere', command: row => ['finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'resolved-elsewhere', evidence: 'Fixed in a fictional commit' }] },
  ...candidates.FINDING_REOPENABLE.map(from => ({ name: `reopen a ${from} finding`, from, to: 'unapproved', command: row => ['finding.reopen', { findingId: row.id, expectedVersion: row.version, note: 'Fictional reason to look again' }] })),
];

test('every person\'s move is allowed only to the listed actor: the operator, the delegated orchestrator for the kinds that allow it, and nobody else', t => {
  const f = sandbox(t); let n = 0;
  for (const kind of KINDS) for (const move of MOVES) {
    for (const [name, who] of Object.entries(ACTORS)) {
      const row = inState(f, kind, move.from, ++n), [operation, payload] = move.command(row), receipt = send(f, operation, payload, who), after = f.store.need('finding', row.id);
      if (MAY[AUTHORITY[kind]].includes(name)) { assert.equal(receipt.status, 'completed', `${kind}: ${move.name} by ${name}: ${receipt.error}`); assert.equal(after.status, move.to); assert.equal(after.version, row.version + 1); }
      else {
        assert.equal(receipt.status, 'rejected', `${kind}: ${move.name} by ${name}`); assert.deepEqual(after, row, 'a refused command changes nothing');
        assert.match(receipt.error, AUTHORITY[kind] === 'operator' ? /is the operator's alone/ : /operator authority required/, `${kind}: ${move.name} by ${name}`);
      }
      drop(f, row.id);
    }
    // An actor the project does not know is refused before anything is read.
    const row = inState(f, kind, move.from, ++n), [operation, payload] = move.command(row);
    for (const actor of ['factory', 'builder', 'reviewer', 'planner', 'upkeep']) assert.throws(() => send(f, operation, payload, { actor }), /invalid actor/);
    assert.deepEqual(f.store.need('finding', row.id), row); drop(f, row.id);
  }
  // A delegation that does not list the command: the orchestrator's instruction is not enough.
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { delegatedOperations: ['task.put', 'task.approve'] } });
  for (const kind of KINDS) for (const move of MOVES) {
    const row = inState(f, kind, move.from, ++n), [operation, payload] = move.command(row), receipt = send(f, operation, payload, ACTORS.delegated);
    assert.equal(receipt.status, 'rejected'); assert.match(receipt.error, AUTHORITY[kind] === 'operator' ? /is the operator's alone/ : /is not delegated to the orchestrator/); assert.deepEqual(f.store.need('finding', row.id), row);
    assert.equal(send(f, operation, payload).status, 'completed', 'the operator still may'); drop(f, row.id);
  }
  // The commands cannot be listed for a kind they do not cover: a context proposal stays the operator's with every command delegated.
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { delegatedOperations: [...DELEGABLE] } });
  for (const kind of ['context', 'rule']) { const row = inState(f, kind, 'unapproved', ++n); assert.match(send(f, 'finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'declined', reason: 'wrong' }, ACTORS.delegated).error, /is the operator's alone/); }
});

test('every person\'s move names the expected version: a stale or missing version is refused and writes nothing', t => {
  const f = sandbox(t); let n = 0;
  for (const kind of KINDS) for (const move of MOVES) {
    const row = inState(f, kind, move.from, ++n), [operation, payload] = move.command(row);
    for (const [expectedVersion, pattern] of [[row.version - 1, /changed since it was read \(version \d+\); read it again/], [row.version + 1, /changed since it was read/], [undefined, /needs expectedVersion: the finding version you read/], ['1', /needs expectedVersion/]]) {
      const receipt = send(f, operation, { ...payload, expectedVersion });
      assert.equal(receipt.status, 'rejected', `${kind}: ${move.name} at ${expectedVersion}`); assert.match(receipt.error, pattern); assert.deepEqual(f.store.need('finding', row.id), row);
    }
    // The row changed between the read and the command (a second source flow does not count: it is not a new version).
    if (kind !== 'audit' && move.from === 'unapproved') { raise(f, [CANDIDATE[kind](n)], 'flow-later'); assert.equal(f.store.need('finding', row.id).version, row.version); }
    assert.equal(send(f, operation, payload).status, 'completed');
    assert.equal(send(f, operation, payload).status, 'rejected', 'the same command again: the version it names is no longer current'); drop(f, row.id);
  }
});

test('what a person may not do: record a factory state, reopen an open, tasked or delivered finding, dispose of a closed one, or raise one', t => {
  const f = sandbox(t); let n = 0;
  for (const kind of KINDS) for (const who of Object.values(ACTORS)) {
    for (const from of ['unapproved', 'tasked']) for (const disposition of ['expired', 'delivered', 'failed', 'unapproved', 'tasked', 'accepted', undefined]) {
      const row = inState(f, kind, from, ++n), receipt = send(f, 'finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition, reason: 'wrong', evidence: 'x' }, who);
      assert.equal(receipt.status, 'rejected', `${kind}: ${from} -> ${disposition}`); assert.deepEqual(f.store.need('finding', row.id), row);
      if (who.actor === 'operator') assert.match(receipt.error, /records declined or resolved-elsewhere; every other state is the factory's to record/);
      drop(f, row.id);
    }
    for (const from of ['unapproved', 'tasked', 'delivered']) {
      const row = inState(f, kind, from, ++n), receipt = send(f, 'finding.reopen', { findingId: row.id, expectedVersion: row.version, note: 'Again' }, who);
      assert.equal(receipt.status, 'rejected', `${kind}: reopen ${from}`); assert.deepEqual(f.store.need('finding', row.id), row);
      if (who.actor === 'operator') assert.match(receipt.error, { unapproved: /it is already open/, tasked: /decline it first to close the task/, delivered: /its change merged; new work is a new task/ }[from]);
      drop(f, row.id);
    }
    for (const from of ['delivered', ...candidates.FINDING_REOPENABLE]) {
      const row = inState(f, kind, from, ++n), receipt = send(f, 'finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'declined', reason: 'wrong' }, who);
      assert.equal(receipt.status, 'rejected', `${kind}: decline ${from}`); assert.deepEqual(f.store.need('finding', row.id), row);
      if (who.actor === 'operator') assert.match(receipt.error, from === 'delivered' ? /its change merged, so there is nothing left to dispose of/ : /reopen it first/);
    }
  }
  // Declining needs one of the four reasons; resolved-elsewhere needs evidence; reopening needs a note.
  const row = open(f, 'docs', ++n);
  for (const reason of [undefined, 'because', 'expired']) assert.match(send(f, 'finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'declined', reason }).error, /declining needs a reason: unnecessary, wrong, duplicate, later/);
  for (const evidence of [undefined, '', '   ', 'x'.repeat(4001)]) assert.match(send(f, 'finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'resolved-elsewhere', evidence }).error, /resolved-elsewhere needs evidence/);
  const closed = inState(f, 'docs', 'declined', ++n); assert.match(send(f, 'finding.reopen', { findingId: closed.id, expectedVersion: closed.version }).error, /note is required/);
  // There is no command that raises a finding, and the three commands name one that exists.
  for (const operation of ['finding.raise', 'finding.put', 'finding.create', 'finding.expire', 'finding.deliver']) assert.match(send(f, operation, {}).error, /unsupported operation/);
  for (const operation of ['finding.accept', 'finding.resolve', 'finding.reopen']) assert.match(send(f, operation, { findingId: 'never-raised', expectedVersion: 1 }).error, /unknown finding: never-raised/);
  for (const [operation, extra] of [['finding.accept', { approve: true }], ['finding.resolve', { status: 'delivered' }], ['finding.reopen', { status: 'unapproved' }]]) assert.match(send(f, operation, { findingId: row.id, expectedVersion: row.version, ...extra }).error, new RegExp(`^${operation.replace('.', '\\.')} accepts `));
});

// ---- finding.accept: audit findings only, until delivery exists ----
test('finding.accept records a task for an audit finding and approves nothing; for an upkeep candidate it is refused to every actor, after the actor check, and creates no task', t => {
  const f = sandbox(t), taskCount = () => f.store.count('task'); let n = 0;
  // An audit finding: the task is created in the same step, or one that exists is named.
  const audit = open(f, 'audit', ++n), brief = { id: 'finding-task-1', title: 'Fix the fictional finding', acceptance: ['The finding is resolved'], paths: ['src/api/users.js'] };
  const accepted = send(f, 'finding.accept', { findingId: audit.id, expectedVersion: audit.version, task: brief });
  assert.equal(accepted.status, 'completed', accepted.error);
  assert.deepEqual({ status: accepted.result.finding.status, taskId: accepted.result.finding.taskId, taskRevision: accepted.result.finding.taskRevision, version: accepted.result.finding.version, by: accepted.result.finding.taskedBy }, { status: 'tasked', taskId: 'finding-task-1', taskRevision: f.store.need('task', 'finding-task-1').revision, version: audit.version + 1, by: 'operator' });
  const made = f.store.need('task', 'finding-task-1');
  assert.deepEqual(made.findings, [audit.id]); assert.equal(made.approvedRevision, null, 'creating the task never approves it'); assert.equal(made.upkeep, undefined, 'an ordinary task: no marker');
  assert.equal(f.store.need('obligation', `finding:${audit.id}`).status, 'pending', 'tasked: the obligation stays pending');
  // The link is not part of the brief: an edit keeps it, and the revision is the brief's alone.
  const edited = send(f, 'task.put', { task: { ...brief, title: 'Fix the fictional finding properly', findings: ['forged'] } }).result; assert.deepEqual(edited.findings, [audit.id]); assert.notEqual(edited.revision, made.revision);
  // By the delegated orchestrator, naming a task that exists; a second finding may share the task.
  const second = open(f, 'audit', ++n), byDelegate = send(f, 'finding.accept', { findingId: second.id, expectedVersion: second.version, taskId: 'finding-task-1' }, ACTORS.delegated);
  assert.equal(byDelegate.status, 'completed', byDelegate.error); assert.deepEqual(f.store.need('task', 'finding-task-1').findings, [audit.id, second.id]); assert.equal(byDelegate.result.finding.taskedBy, 'orchestrator');
  // Refusals: the other actors; a stale version; neither or both of task and taskId; a task that is not open ordinary work; a finding that is not open.
  const third = open(f, 'audit', ++n), before = taskCount();
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, taskId: 'finding-task-1' }, ACTORS['orchestrator without an instruction']).error, /operator authority required/);
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version + 1, task: { ...brief, id: 'finding-task-2' } }).error, /changed since it was read/); assert.equal(f.store.get('task', 'finding-task-2'), undefined, 'the task made for a refused accept is not kept');
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version }).error, /either task \(a brief to create\) or taskId/);
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, task: brief, taskId: 'finding-task-1' }).error, /either task/);
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, task: brief }).error, /that task already exists; name it with taskId/);
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, taskId: 'no-such-task' }).error, /unknown task/);
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, task: { ...brief, id: 'upkeep:finding' } }).error, /reserved upkeep: namespace/);
  tx(f, () => f.store.put('task', { id: 'closed-task', title: 'Fictional', acceptance: ['x'], revision: digest('closed'), approvedRevision: null, approvalVersion: 1, closed: true }));
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, taskId: 'closed-task' }).error, /is closed; a finding is recorded against open work/);
  tx(f, () => f.store.put('task', { id: 'job:fictional', title: 'Fictional', acceptance: ['x'], revision: digest('job'), approvedRevision: null, approvalVersion: 1 }));
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, taskId: 'job:fictional' }).error, /not an ordinary project task/);
  assert.match(send(f, 'finding.accept', { findingId: audit.id, expectedVersion: audit.version + 1, taskId: 'finding-task-1' }).error, /is tasked, not open/);
  assert.deepEqual(f.store.need('finding', third.id), third); assert.equal(taskCount(), before + 2, 'only the two fixture tasks were written');
  // A delegate who may accept but may not write a task cannot create one through finding.accept.
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { delegatedOperations: ['finding.accept'] } });
  assert.match(send(f, 'finding.accept', { findingId: third.id, expectedVersion: third.version, task: { ...brief, id: 'finding-task-3' } }, ACTORS.delegated).error, /task\.put is not delegated/); assert.equal(f.store.get('task', 'finding-task-3'), undefined);
  f.store.setMeta('config', { ...f.store.meta('config'), policy: {} });

  // An upkeep candidate of every kind, open: refused to everyone. The actor is judged first.
  assert.deepEqual(ENFORCED_UPKEEP_KINDS, ['docs', 'context', 'check', 'learning-add', 'learning-retire'], 'this release enforces docs (slice 5 part A), context (slice 6), check and learning-add (slice 7) and learning-retire (slice 8); no candidate is made into a task from a brief or an existing task');
  for (const kind of UPKEEP_KINDS) {
    const row = open(f, kind, ++n), count = taskCount();
    for (const [name, who] of Object.entries(ACTORS)) for (const payload of [{ task: { ...brief, id: `accept-${kind}-${name.length}` } }, { taskId: 'finding-task-1' }]) {
      const receipt = send(f, 'finding.accept', { findingId: row.id, expectedVersion: row.version, ...payload }, who);
      assert.equal(receipt.status, 'rejected', `${kind} by ${name}`);
      // Slice 7: a check or learning candidate is accepted with its own payload (files, paths), never a brief or a task;
      // slice 8: so is a stale learning (approve only).
      assert.match(receipt.error, MAY[AUTHORITY[kind]].includes(name) ? (['check', 'learning', 'learning-stale'].includes(kind) ? /never from a brief or an existing task/ : /so none is accepted into a task by command/) : AUTHORITY[kind] === 'operator' ? /is the operator's alone/ : /operator authority required/, `${kind} by ${name}`);
    }
    assert.deepEqual(f.store.need('finding', row.id), row); assert.equal(taskCount(), count, `${kind}: no task was created`); assert.deepEqual(f.store.need('task', 'finding-task-1').findings, [audit.id, second.id]);
  }
});

// ---- Raising (4.3, Q6) ----
test('a docs, context, check or stale-learning class is raised from one flow; a rule or a learning only from a second distinct flow, and the same flow twice does not count', t => {
  const f = sandbox(t);
  for (const kind of ['docs', 'context', 'check', 'learning-stale']) {
    const [first] = raise(f, [CANDIDATE[kind]()], 'flow-a'); assert.equal(first.outcome, 'raised', kind);
    const row = upkeepCandidate(f.store, first.id);
    assert.deepEqual({ source: row.source, kind: row.kind, status: row.status, version: row.version, sourceFlows: row.sourceFlows, sourceFlowCount: row.sourceFlowCount, returns: row.returns, approved: row.approved, provenance: row.provenance }, { source: 'upkeep', kind, status: 'unapproved', version: 1, sourceFlows: ['flow-a'], sourceFlowCount: 1, returns: 0, approved: false, provenance: kind === 'learning-stale' ? 'factory' : 'assessment-model' });
    assert.equal(observedClass(f.store, first.id), undefined, `${kind} is never an observed class`);
    assert.equal(f.store.get('obligation', `finding:${row.id}`), undefined, 'an upkeep candidate has no obligation');
  }
  for (const kind of ['rule', 'learning']) {
    const candidate = CANDIDATE[kind](), [first] = raise(f, [candidate], 'flow-a');
    assert.equal(first.outcome, 'observed', kind); assert.equal(upkeepCandidate(f.store, first.id), undefined, 'one flow: no candidate');
    assert.deepEqual(observedClass(f.store, first.id), { id: first.id, kind, anchor: candidate.anchor, topic: candidate.topic, sourceFlow: 'flow-a', firstObservedAt: iso(T0) });
    // The same flow again (a manual re-run), any number of times: nothing is written.
    const before = f.store.changeToken();
    for (let i = 0; i < 3; i++) assert.deepEqual(raise(f, [candidate], 'flow-a', T0 + i * DAY), [{ id: first.id, kind, outcome: 'same-flow', status: 'observed' }]);
    assert.equal(f.store.changeToken(), before, 'not a row, a count or an event'); assert.equal(upkeepCandidate(f.store, first.id), undefined);
    // A second, distinct flow: the candidate is written and the observed row deleted, together.
    const [second] = raise(f, [candidate], 'flow-b', T0 + DAY); assert.equal(second.outcome, 'raised');
    const row = upkeepCandidate(f.store, first.id);
    assert.deepEqual({ status: row.status, version: row.version, sourceFlows: row.sourceFlows, sourceFlowCount: row.sourceFlowCount }, { status: 'unapproved', version: 1, sourceFlows: ['flow-a', 'flow-b'], sourceFlowCount: 2 });
    assert.equal(observedClass(f.store, first.id), undefined, 'the observed row is gone');
  }
  assert.deepEqual(upkeepOpen(f.store).candidates, { docs: 1, context: 1, check: 1, rule: 1, learning: 1, 'learning-stale': 1 }); assert.equal(upkeepObservedCount(f.store), 0);
  // The write is one transaction: a failure after the observed row was deleted leaves it in place.
  const pending = CANDIDATE.rule(2); raise(f, [pending], 'flow-a');
  assert.throws(() => tx(f, () => { candidates.raiseCandidatesInTransaction(f.store, { flowId: 'flow-b', candidates: [pending], nowMs: T0 }); throw new Error('fictional failure'); }), /fictional failure/);
  const key = digest({ v: 1, kind: 'rule', anchor: pending.anchor, topic: pending.topic }); assert.ok(observedClass(f.store, key)); assert.equal(upkeepCandidate(f.store, key), undefined);
  // The class key is the factory's own: a candidate that carries another is refused, and so is an unknown kind.
  assert.throws(() => raise(f, [{ ...CANDIDATE.docs(3), classKey: 'a'.repeat(64) }]), /the factory's own digest of its fields/);
  assert.throws(() => raise(f, [{ kind: 'policy', anchor: 'x', topic: 'test' }]), /unknown candidate kind/);
  // What a run's validator kept goes in as it stands, with the class keys the validator computed.
  const accepted = { docs: [{ ...CANDIDATE.docs(7), classKey: quoteClassKey({ kind: 'docs', path: 'README.md', quote: CANDIDATE.docs(7).quote }) }], context: [], capture: [{ ...CANDIDATE.check(7), classKey: captureClassKey({ form: 'check', anchor: 'check:lint-7', topic: 'test' }) }, { ...CANDIDATE.learning(7), classKey: captureClassKey({ form: 'learning', anchor: 'dir:src/api-7', topic: 'interface-use' }) }] };
  const recorded = tx(f, () => candidates.recordRunCandidatesInTransaction(f.store, { flowId: 'flow-run', accepted, nowMs: T0 }));
  assert.deepEqual(recorded.counts, { raised: 2, observed: 1 }); assert.deepEqual(recorded.results.map(row => row.id), [accepted.docs[0].classKey, accepted.capture[0].classKey, accepted.capture[1].classKey]);
});

test('a later observation never reopens a closed candidate and never raises its version: it only adds to the source flows, at most 20 with a total', t => {
  const f = sandbox(t); let n = 0;
  for (const status of ['declined', 'expired', 'failed', 'resolved-elsewhere', 'delivered', 'tasked']) for (const kind of ['docs', 'rule']) {
    const row = inState(f, kind, status, ++n), [result] = raise(f, [CANDIDATE[kind](n)], `flow-later-${n}`, T0 + DAY), after = f.store.need('finding', row.id);
    assert.deepEqual(result, { id: row.id, kind, outcome: 'observed-again', status });
    assert.equal(after.status, status, `${kind}: a ${status} candidate stays ${status}`); assert.equal(after.version, row.version, 'not a new version');
    assert.deepEqual(after.sourceFlows, [...row.sourceFlows, `flow-later-${n}`]); assert.equal(after.sourceFlowCount, row.sourceFlowCount + 1); assert.equal(after.lastObservedAt, iso(T0 + DAY));
    assert.equal(observedClass(f.store, row.id), undefined, 'and it is not recorded as observed again');
    // The same later flow again adds nothing.
    assert.equal(raise(f, [CANDIDATE[kind](n)], `flow-later-${n}`)[0].outcome, 'same-flow'); assert.deepEqual(f.store.need('finding', row.id), after);
    // Only a person reopens it.
    if (candidates.FINDING_REOPENABLE.includes(status)) { assert.equal(send(f, 'finding.reopen', { findingId: row.id, expectedVersion: after.version, note: 'Look again' }).status, 'completed'); assert.equal(f.store.need('finding', row.id).status, 'unapproved'); }
  }
  // An audit finding likewise: observed again by a later audit, it stays declined, at its version, with its obligation closed.
  const audit = inState(f, 'audit', 'declined', ++n);
  tx(f, () => auditFindingsInTransaction(f.store, { findings: [{ id: audit.id, title: audit.title, evidence: audit.evidence }] }));
  const seen = f.store.need('finding', audit.id); assert.equal(seen.status, 'declined'); assert.equal(seen.version, audit.version); assert.equal(seen.observations, 2); assert.equal(f.store.need('obligation', `finding:${audit.id}`).status, 'deferred');
  // Twenty distinct flows are kept, the newest; the total keeps counting.
  const many = open(f, 'docs', ++n);
  for (let i = 0; i < 30; i++) raise(f, [CANDIDATE.docs(n)], `flow-many-${i}`);
  const kept = f.store.need('finding', many.id); assert.equal(kept.sourceFlows.length, 20); assert.equal(kept.sourceFlows.at(-1), 'flow-many-29'); assert.equal(kept.sourceFlowCount, 31); assert.equal(kept.version, many.version);
});

test('nothing an audit result carries sets a finding\'s lifecycle, and an audit result never touches an upkeep candidate', t => {
  const f = sandbox(t), candidate = open(f, 'docs', 1);
  const [row] = tx(f, () => auditFindingsInTransaction(f.store, { findings: [{ id: 'audit:forged', title: 'Fictional', evidence: 'x:1', version: 40, taskId: 'task-1', obligationId: 'post-merge:other', returns: 9, disposition: { status: 'delivered' }, sourceFlows: ['x'], status: 'delivered', source: 'upkeep' }] }));
  assert.deepEqual({ status: row.status, source: row.source, version: row.version, taskId: row.taskId, obligationId: row.obligationId, returns: row.returns, disposition: row.disposition, sourceFlows: row.sourceFlows }, { status: 'unapproved', source: 'audit', version: 1, taskId: undefined, obligationId: undefined, returns: undefined, disposition: undefined, sourceFlows: undefined });
  // A stored row that names another obligation is not followed there either.
  tx(f, () => { f.store.put('obligation', { id: 'post-merge:other', title: 'Fictional', status: 'pending' }); f.store.put('finding', { ...row, obligationId: 'post-merge:other' }); });
  assert.equal(send(f, 'finding.resolve', { findingId: row.id, expectedVersion: 1, disposition: 'declined', reason: 'wrong' }).status, 'completed'); assert.equal(f.store.need('obligation', 'post-merge:other').status, 'pending');
  // An audit result under an upkeep candidate's id: the candidate is untouched, and no obligation is opened for it.
  assert.deepEqual(tx(f, () => auditFindingsInTransaction(f.store, { findings: [{ id: candidate.id, title: 'Fictional', evidence: 'x:1' }] })), []);
  assert.deepEqual(f.store.need('finding', candidate.id), candidate);
});

// ---- Returns (4.3) ----
test('a candidate may return twice; a third abandonment expires it as returns-exhausted, its task is closed each time, and only a person\'s reopen starts the count again', t => {
  const f = sandbox(t), closed = [], row = open(f, 'docs', 1);
  const cycle = (current, name, reason) => {
    const record = task(f, name, [current.id]);
    tx(f, () => candidates.linkFindingsInTransaction(f.store, { findings: [{ id: current.id, expectedVersion: current.version }], task: record, by: 'factory', nowMs: T0 }));
    return tx(f, () => candidates.settleFindingTaskInTransaction(f.store, { taskId: name, findingIds: [current.id], outcome: 'returned', reason, closeTask: (id, why) => tasks(f, closed).close(id, why), nowMs: T0 }))[0];
  };
  const first = cycle(row, 'upkeep-task-1', 'drain'); assert.deepEqual({ status: first.status, returns: first.returns, taskId: first.taskId, lastTaskId: first.lastTaskId, returned: first.returned.reason }, { status: 'unapproved', returns: 1, taskId: undefined, lastTaskId: 'upkeep-task-1', returned: 'drain' });
  const second = cycle(first, 'upkeep-task-2', 'base-moved'); assert.equal(second.status, 'unapproved'); assert.equal(second.returns, 2);
  const third = cycle(second, 'upkeep-task-3', 'stale'); assert.equal(third.status, 'expired'); assert.deepEqual({ status: third.disposition.status, reason: third.disposition.reason }, { status: 'expired', reason: 'returns-exhausted' }); assert.equal(third.returns, 2, 'not a third return');
  assert.deepEqual(closed.map(([id]) => id), ['upkeep-task-1', 'upkeep-task-2', 'upkeep-task-3'], 'the task is closed at every abandonment'); assert.ok(['upkeep-task-1', 'upkeep-task-2', 'upkeep-task-3'].every(id => f.store.need('task', id).closed));
  assert.deepEqual(upkeepOpen(f.store).candidates.docs, 0);
  // It stays closed: the factory does not reopen it, and a later observation only adds a source flow.
  raise(f, [CANDIDATE.docs(1)], 'flow-later'); assert.equal(f.store.need('finding', row.id).status, 'expired');
  // A person reopens it, and the count starts again: two more returns, then expiry.
  const reopened = send(f, 'finding.reopen', { findingId: row.id, expectedVersion: f.store.need('finding', row.id).version, note: 'The drain was ours' }); assert.equal(reopened.status, 'completed', reopened.error); assert.equal(reopened.result.returns, 0); assert.equal(reopened.result.status, 'unapproved');
  const again = cycle(reopened.result, 'upkeep-task-4', 'drain'); assert.equal(again.returns, 1);
  assert.equal(cycle(cycle(again, 'upkeep-task-5', 'drain'), 'upkeep-task-6', 'drain').status, 'expired');
  // The ended follow-ups: a return is not an ending; an exhausted one is recorded as expired, once.
  assert.deepEqual(upkeepWindow(f.store).disposed.docs.map(entry => [entry.outcome, entry.taskId]), [['expired', 'upkeep-task-3'], ['expired', 'upkeep-task-6']]);
});

// ---- Declining a tasked candidate (4.3) ----
test('declining a tasked candidate closes its task and declines every candidate linked to it, with the same reason; a task whose flow is running is refused', t => {
  const f = sandbox(t), rows = [1, 2, 3].map(n => open(f, 'docs', n)), other = open(f, 'docs', 4);
  const record = task(f, 'upkeep-batch', rows.map(row => row.id));
  tx(f, () => candidates.linkFindingsInTransaction(f.store, { findings: rows.map(row => ({ id: row.id, expectedVersion: row.version })), task: record, by: 'factory', nowMs: T0 }));
  const linked = rows.map(row => f.store.need('finding', row.id)); assert.ok(linked.every(row => row.status === 'tasked' && row.taskId === 'upkeep-batch'));
  // A flow of that task is working: the decline is refused, and nothing changes.
  tx(f, () => f.store.put('flow', { id: 'flow-batch', taskId: 'upkeep-batch', kind: 'rehearsal', state: 'ready', step: 'work', attemptId: null, workflow: f.store.meta('workflow'), createdAt: iso(T0) }));
  const refused = send(f, 'finding.resolve', { findingId: linked[1].id, expectedVersion: linked[1].version, disposition: 'declined', reason: 'duplicate' });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /has a task \(upkeep-batch\) that cannot be closed yet: flow flow-batch is ready; stop it first/); assert.deepEqual(rows.map(row => f.store.need('finding', row.id)), linked);
  // Stopped, with nothing running: the decline goes through, as one command on any of the three.
  tx(f, () => f.store.put('flow', { ...f.store.need('flow', 'flow-batch'), state: 'stopped', stopRequested: true }));
  const declined = send(f, 'finding.resolve', { findingId: linked[1].id, expectedVersion: linked[1].version, disposition: 'declined', reason: 'duplicate', note: 'Covered by another change' });
  assert.equal(declined.status, 'completed', declined.error); assert.equal(declined.result.closedTask, 'upkeep-batch'); assert.equal(declined.result.linked.length, 2);
  for (const row of rows) { const after = f.store.need('finding', row.id); assert.equal(after.status, 'declined'); assert.equal(after.disposition.reason, 'duplicate'); assert.equal(after.disposition.by, 'operator'); assert.equal(after.taskId, 'upkeep-batch', 'the closed task stays on record'); }
  const closed = f.store.need('task', 'upkeep-batch'); assert.equal(closed.closed, true); assert.equal(closed.approvedRevision, null); assert.notEqual(closed.revision, record.revision); assert.deepEqual(closed.findings, rows.map(row => row.id));
  assert.equal(f.store.need('finding', other.id).status, 'unapproved', 'a candidate of another task is untouched'); assert.equal(upkeepOpen(f.store).candidates.docs, 1);
  // One ended follow-up, however many candidates it carried.
  assert.deepEqual(upkeepWindow(f.store).disposed.docs.map(entry => [entry.outcome, entry.taskId]), [['declined', 'upkeep-batch']]);
  // To keep part of a batch: reopen the ones worth keeping.
  const kept = send(f, 'finding.reopen', { findingId: rows[0].id, expectedVersion: f.store.need('finding', rows[0].id).version, note: 'This one is still right' }); assert.equal(kept.status, 'completed', kept.error); assert.equal(kept.result.taskId, undefined); assert.equal(kept.result.lastTaskId, 'upkeep-batch');

  // Resolved elsewhere, for one tasked candidate of a task that has not started: the task is closed
  // and the others return to open, which is not counted as a return.
  const pair = [5, 6].map(n => open(f, 'docs', n)), next = task(f, 'upkeep-pair', pair.map(row => row.id));
  tx(f, () => candidates.linkFindingsInTransaction(f.store, { findings: pair.map(row => ({ id: row.id, expectedVersion: row.version })), task: next, by: 'factory', nowMs: T0 }));
  const resolved = send(f, 'finding.resolve', { findingId: pair[0].id, expectedVersion: pair[0].version + 1, disposition: 'resolved-elsewhere', evidence: 'The paragraph was removed by hand' });
  assert.equal(resolved.status, 'completed', resolved.error); assert.equal(resolved.result.closedTask, 'upkeep-pair'); assert.equal(f.store.need('task', 'upkeep-pair').closed, true);
  const sibling = f.store.need('finding', pair[1].id); assert.deepEqual({ status: sibling.status, returns: sibling.returns, taskId: sibling.taskId, returned: sibling.returned.reason }, { status: 'unapproved', returns: 0, taskId: undefined, returned: 'task-closed' });
  // A task that has started is left running, and so are its other candidates.
  const started = [7, 8].map(n => open(f, 'docs', n)), running = task(f, 'upkeep-started', started.map(row => row.id));
  tx(f, () => { candidates.linkFindingsInTransaction(f.store, { findings: started.map(row => ({ id: row.id, expectedVersion: row.version })), task: running, by: 'factory', nowMs: T0 }); f.store.put('flow', { id: 'flow-started', taskId: 'upkeep-started', kind: 'rehearsal', state: 'ready', step: 'work', attemptId: null, workflow: f.store.meta('workflow'), createdAt: iso(T0) }); });
  const partial = send(f, 'finding.resolve', { findingId: started[0].id, expectedVersion: started[0].version + 1, disposition: 'resolved-elsewhere', evidence: 'Fixed elsewhere' });
  assert.equal(partial.status, 'completed', partial.error); assert.equal(partial.result.closedTask, null); assert.equal(f.store.need('task', 'upkeep-started').closed, undefined); assert.equal(f.store.need('finding', started[1].id).status, 'tasked');
});

// ---- Audit findings and their obligations (4.4) ----
test('audit dispositions close and reopen the finding\'s obligation: declined defers it, resolved elsewhere passes it, a reopen opens a new one', t => {
  const f = sandbox(t), pending = () => f.store.live('obligation').filter(row => row.status === 'pending').map(row => row.id);
  // Declined: deferred, with the reason as evidence.
  const declined = open(f, 'audit', 1); assert.deepEqual(pending(), [`finding:${declined.id}`]);
  assert.equal(send(f, 'finding.resolve', { findingId: declined.id, expectedVersion: 1, disposition: 'declined', reason: 'later', note: 'After the migration' }, ACTORS.delegated).status, 'completed');
  const deferred = f.store.need('obligation', `finding:${declined.id}`); assert.deepEqual({ status: deferred.status, evidence: deferred.evidence, by: deferred.resolvedBy }, { status: 'deferred', evidence: 'Declined: later (After the migration)', by: 'finding' }); assert.deepEqual(pending(), [], 'nothing open blocks retention');
  // Reopened: a new pending obligation; the first stays as it was resolved.
  const reopened = send(f, 'finding.reopen', { findingId: declined.id, expectedVersion: 2, note: 'The migration is done' }); assert.equal(reopened.status, 'completed', reopened.error);
  assert.equal(reopened.result.obligationId, `finding:${declined.id}:3`); assert.deepEqual(pending(), [`finding:${declined.id}:3`]);
  assert.deepEqual({ status: f.store.need('obligation', reopened.result.obligationId).status, findingId: f.store.need('obligation', reopened.result.obligationId).findingId, reopened: f.store.need('obligation', reopened.result.obligationId).reopened }, { status: 'pending', findingId: declined.id, reopened: true });
  assert.equal(f.store.need('obligation', `finding:${declined.id}`).status, 'deferred');
  // Resolved elsewhere: passed, with the evidence; it closes the obligation the reopen opened.
  assert.equal(send(f, 'finding.resolve', { findingId: declined.id, expectedVersion: 3, disposition: 'resolved-elsewhere', evidence: 'Removed in fictional commit abc123' }).status, 'completed');
  assert.deepEqual({ status: f.store.need('obligation', `finding:${declined.id}:3`).status, evidence: f.store.need('obligation', `finding:${declined.id}:3`).evidence }, { status: 'passed', evidence: 'Removed in fictional commit abc123' }); assert.deepEqual(pending(), []);
  // An obligation a person already resolved is left as they resolved it.
  const byHand = open(f, 'audit', 2);
  assert.equal(send(f, 'obligation.resolve', { obligationId: `finding:${byHand.id}`, status: 'failed', evidence: 'Looked at it', note: 'Not reproducible' }).status, 'completed');
  assert.equal(send(f, 'finding.resolve', { findingId: byHand.id, expectedVersion: 1, disposition: 'declined', reason: 'wrong' }).status, 'completed'); assert.equal(f.store.need('obligation', `finding:${byHand.id}`).status, 'failed');
  // An upkeep candidate has no obligation in any state, and gets none when it is reopened.
  const candidate = inState(f, 'context', 'declined', 3); assert.equal(send(f, 'finding.reopen', { findingId: candidate.id, expectedVersion: candidate.version, note: 'Again' }).status, 'completed');
  assert.equal(f.store.need('finding', candidate.id).obligationId, undefined); assert.deepEqual(f.store.all('obligation').filter(row => row.findingId === candidate.id || row.id.includes(candidate.id)), []);
});

test('a tasked audit finding: its obligation stays pending, passes with the task id when the task merges, and fails when its flow fails', async t => {
  const f = upkeepProject(t, { upkeep: null });
  const finding = (n, extra = {}) => { const [row] = tx(f, () => auditFindingsInTransaction(f.store, { findings: [{ id: `audit:${digest({ n })}`, title: `Fictional audit finding ${n}`, evidence: `src/api/users.js:${n}`, ...extra }] })); tx(f, () => f.store.put('obligation', { id: `finding:${row.id}`, findingId: row.id, title: row.title, evidence: row.evidence, status: 'pending', approved: false, owner: 'operator', createdAt: iso(T0) })); return row; };
  // The task is made with the finding; the fixture then edits, approves and starts it, and the link survives into the flow.
  const merged = finding(1), accepted = send(f, 'finding.accept', { findingId: merged.id, expectedVersion: 1, task: { id: 'fix-one', title: 'Fictional fix', acceptance: ['The finding is resolved'] } }); assert.equal(accepted.status, 'completed', accepted.error);
  const at = await f.atMerge('fix-one'); assert.deepEqual(f.flow(at.flow.id).taskSnapshot.findings, [merged.id]);
  assert.equal(f.store.need('finding', merged.id).status, 'tasked'); assert.equal(f.store.need('obligation', `finding:${merged.id}`).status, 'pending', 'tasked, approved and running: still pending');
  // A second finding is recorded against the same task while its flow is running: the flow learns of it.
  const late = finding(2); assert.equal(send(f, 'finding.accept', { findingId: late.id, expectedVersion: 1, taskId: 'fix-one' }).status, 'completed'); assert.deepEqual(f.flow(at.flow.id).findings, [merged.id, late.id]);
  // The merge is proven: both are delivered and both obligations pass, naming the task.
  const { base, sha } = f.commitOnTarget(root => root, 'Fictional merged fix');
  f.store.put('flow', { ...f.flow(at.flow.id), results: { ...f.flow(at.flow.id).results, integrate: { base } } });
  f.engine.settle(at.flow.id, at.attempt, { version: 1, attemptId: at.attempt.id, intentDigest: at.attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: { route: 'merged', merged: true, sha, expectedHead: at.identity.head, expectedBase: base, outputIdentity: at.identity } });
  for (const row of [merged, late]) {
    const after = f.store.need('finding', row.id), obligation = f.store.need('obligation', `finding:${row.id}`);
    assert.deepEqual({ status: after.status, flowId: after.disposition.flowId }, { status: 'delivered', flowId: at.flow.id });
    assert.deepEqual({ status: obligation.status, evidence: obligation.evidence, taskId: obligation.taskId }, { status: 'passed', evidence: 'Task fix-one merged', taskId: 'fix-one' });
  }
  // The flow then fails at a post-merge step: a delivered finding stays delivered.
  f.failPost(); await f.finish(at.flow.id); assert.equal(f.flow(at.flow.id).state, 'failed'); assert.equal(f.store.need('finding', merged.id).status, 'delivered'); assert.equal(f.store.need('obligation', `finding:${merged.id}`).status, 'passed');

  // A flow that fails before any merge: the finding fails and so does its obligation.
  const failing = finding(3); assert.equal(send(f, 'finding.accept', { findingId: failing.id, expectedVersion: 1, task: { id: 'fix-two', title: 'Fictional fix', acceptance: ['The finding is resolved'] } }).status, 'completed');
  const second = await f.atMerge('fix-two');
  f.engine.settle(second.flow.id, second.attempt, { version: 1, attemptId: second.attempt.id, intentDigest: second.attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 1, signal: null, reason: 'fictional failure' });
  await f.finish(second.flow.id); assert.equal(f.flow(second.flow.id).state, 'failed');
  assert.deepEqual({ status: f.store.need('finding', failing.id).status, obligation: f.store.need('obligation', `finding:${failing.id}`).status, taskId: f.store.need('obligation', `finding:${failing.id}`).taskId }, { status: 'failed', obligation: 'failed', taskId: 'fix-two' });
  // Reopened by a person: open again, with a new pending obligation.
  const reopened = send(f, 'finding.reopen', { findingId: failing.id, expectedVersion: f.store.need('finding', failing.id).version, note: 'Try again' }); assert.equal(reopened.status, 'completed', reopened.error);
  assert.equal(f.store.need('obligation', reopened.result.obligationId).status, 'pending');
  // An abandoned flow is not a failed one: the finding stays tasked and its obligation pending.
  const waiting = finding(4); assert.equal(send(f, 'finding.accept', { findingId: waiting.id, expectedVersion: 1, task: { id: 'fix-three', title: 'Fictional fix', acceptance: ['The finding is resolved'] } }).status, 'completed');
  const third = await f.atMerge('fix-three'); tx(f, () => f.store.put('flow', { ...f.flow(third.flow.id), attemptId: null, state: 'stopped', stopRequested: true }));
  assert.equal(send(f, 'flow.abandon', { flowId: third.flow.id, note: 'Fictional abandonment' }).status, 'completed');
  assert.equal(f.store.need('finding', waiting.id).status, 'tasked'); assert.equal(f.store.need('obligation', `finding:${waiting.id}`).status, 'pending');
  // Declining it now closes its ordinary task as task.put would, and defers the obligation.
  const declined = send(f, 'finding.resolve', { findingId: waiting.id, expectedVersion: f.store.need('finding', waiting.id).version, disposition: 'declined', reason: 'unnecessary' }); assert.equal(declined.status, 'completed', declined.error);
  assert.equal(f.store.need('task', 'fix-three').closed, true); assert.equal(f.store.need('task', 'fix-three').approvedRevision, null); assert.equal(f.store.need('obligation', `finding:${waiting.id}`).status, 'deferred');
});

// Review of fb4949c, open question 3: an audit finding whose task's flow failed is delivered by a later
// proven merge of the same task at the revision it was recorded against, and its to-do then passes.
test('a failed audit finding is delivered by a later proven merge of the same task at its linked revision; not after a brief edit, and never an upkeep candidate', async t => {
  const f = upkeepProject(t, { upkeep: null });
  const finding = n => { const [row] = tx(f, () => auditFindingsInTransaction(f.store, { findings: [{ id: `audit:${digest({ late: n })}`, title: `Fictional audit finding ${n}`, evidence: `src/api/users.js:${n}` }] })); tx(f, () => f.store.put('obligation', { id: `finding:${row.id}`, findingId: row.id, title: row.title, evidence: row.evidence, status: 'pending', approved: false, owner: 'operator', createdAt: iso(T0) })); return row; };
  // The brief is the one the fixture's flows run, so the revision the flows run is the one the finding is linked to.
  const brief = name => ({ id: name, title: `Fictional change ${name}`, acceptance: ['Observed fixture behavior'] });
  const fail = async at => { f.engine.settle(at.flow.id, at.attempt, { version: 1, attemptId: at.attempt.id, intentDigest: at.attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 1, signal: null, reason: 'fictional failure' }); await f.finish(at.flow.id); assert.equal(f.flow(at.flow.id).state, 'failed'); };
  const merge = at => { const { base, sha } = f.commitOnTarget(root => root, `Fictional merge ${at.flow.id}`); f.store.put('flow', { ...f.flow(at.flow.id), results: { ...f.flow(at.flow.id).results, integrate: { base } } }); f.engine.settle(at.flow.id, at.attempt, { version: 1, attemptId: at.attempt.id, intentDigest: at.attempt.intentDigest, synthetic: false, costMicros: 0, exitCode: 0, signal: null, reason: null, actionResult: { route: 'merged', merged: true, sha, expectedHead: at.identity.head, expectedBase: base, outputIdentity: at.identity } }); };
  const row = finding(1); assert.equal(send(f, 'finding.accept', { findingId: row.id, expectedVersion: 1, task: brief('fix-late') }).status, 'completed');
  const linkedRevision = f.store.need('finding', row.id).taskRevision;
  await fail(await f.atMerge('fix-late'));
  const failed = f.store.need('finding', row.id); assert.equal(failed.status, 'failed'); assert.equal(f.store.need('obligation', `finding:${row.id}`).status, 'failed');
  // The task is restarted and its second flow, at the same revision, merges.
  const second = await f.atMerge('fix-late', { flowId: 'flow-fix-late-2' }); assert.equal(f.flow(second.flow.id).taskRevision, linkedRevision); merge(second);
  const delivered = f.store.need('finding', row.id), obligation = f.store.need('obligation', `finding:${row.id}`);
  assert.deepEqual({ status: delivered.status, version: delivered.version, flowId: delivered.disposition.flowId, earlier: delivered.disposition.afterFailure?.status }, { status: 'delivered', version: failed.version + 1, flowId: 'flow-fix-late-2', earlier: 'failed' });
  assert.deepEqual({ status: obligation.status, taskId: obligation.taskId }, { status: 'passed', taskId: 'fix-late' }); assert.match(obligation.evidence, /Task fix-late merged \(after an earlier flow of the task failed\)/);

  // After a brief edit the task is other work: its merge does not deliver the failed finding.
  const edited = finding(2); assert.equal(send(f, 'finding.accept', { findingId: edited.id, expectedVersion: 1, task: brief('fix-edited') }).status, 'completed');
  await fail(await f.atMerge('fix-edited'));
  assert.equal(send(f, 'task.put', { task: { ...brief('fix-edited'), acceptance: ['Observed fixture behavior', 'And something else'] } }).status, 'completed');
  const task = f.store.need('task', 'fix-edited'); assert.equal(send(f, 'task.approve', { taskId: task.id, revision: task.revision }).status, 'completed');
  const started = send(f, 'flow.start', { taskId: task.id, revision: task.revision, flowId: 'flow-fix-edited-2' }); assert.equal(started.status, 'completed', started.error);
  tx(f, () => candidates.settleFindingTaskInTransaction(f.store, { taskId: 'fix-edited', findingIds: [edited.id], outcome: 'delivered', flowId: 'flow-fix-edited-2', taskRevision: task.revision }));
  assert.equal(f.store.need('finding', edited.id).status, 'failed'); assert.equal(f.store.need('obligation', `finding:${edited.id}`).status, 'failed');
  // A delivery without a revision, or for another task, takes no failed finding either.
  tx(f, () => candidates.settleFindingTaskInTransaction(f.store, { taskId: 'fix-edited', findingIds: [edited.id], outcome: 'delivered' }));
  tx(f, () => candidates.settleFindingTaskInTransaction(f.store, { taskId: 'other', findingIds: [edited.id], outcome: 'delivered', taskRevision: f.store.need('finding', edited.id).taskRevision }));
  assert.equal(f.store.need('finding', edited.id).status, 'failed');
  // An upkeep candidate whose flow failed stays failed: its task kind is the factory's, and a person reopens it.
  const g = sandbox(t), candidate = tasked(g, 'docs', 1); settle(g, candidate, 'failed');
  tx(g, () => candidates.settleFindingTaskInTransaction(g.store, { taskId: candidate.taskId, findingIds: [candidate.id], outcome: 'delivered', taskRevision: candidate.taskRevision }));
  assert.equal(g.store.need('finding', candidate.id).status, 'failed');
  assert.equal(candidates.transitionAllowed(g.store.need('finding', candidate.id), 'delivered', 'factory'), false);
});

// Review of fb4949c, open question 2: a task that completes without a merge resolves its findings
// elsewhere, and says what the completion rests on.
test('a tasked audit finding whose task completes without a merge is resolved elsewhere, with what the completion rests on as its evidence', t => {
  const f = sandbox(t), rows = [1, 2].map(n => tasked(f, 'audit', n));
  const flow = (row, extra) => ({ id: `flow-done-${row.id.slice(-4)}`, taskId: row.taskId, taskRevision: row.taskRevision, state: 'completed', finishedAt: iso(T0 + 5000), taskSnapshot: { findings: [row.id] }, results: {}, ...extra });
  // Already satisfied: the accepted outcome was proven on the target.
  const satisfied = flow(rows[0], { completionMode: 'already-satisfied', results: { 'satisfied-record': { proven: true, head: 'a'.repeat(40) } }, completionDecision: { identity: { head: 'a'.repeat(40) } } });
  const [first] = tx(f, () => settleFlowFindingsInTransaction(f.store, satisfied, 'resolved-elsewhere'));
  assert.equal(first.status, 'resolved-elsewhere');
  assert.deepEqual(first.disposition.completion, { flowId: satisfied.id, taskId: rows[0].taskId, taskRevision: rows[0].taskRevision, mode: 'already-satisfied', head: 'a'.repeat(40), at: iso(T0 + 5000) });
  assert.equal(first.disposition.evidence, `Flow ${satisfied.id} of task ${rows[0].taskId} completed without a merge: its accepted outcome was proven already on the target at ${'a'.repeat(40)}`);
  const obligation = f.store.need('obligation', `finding:${rows[0].id}`); assert.deepEqual({ status: obligation.status, evidence: obligation.evidence, taskId: obligation.taskId }, { status: 'passed', evidence: first.disposition.evidence, taskId: rows[0].taskId });
  // A workflow that completed with no completion decision says so.
  const [second] = tx(f, () => settleFlowFindingsInTransaction(f.store, flow(rows[1]), 'resolved-elsewhere'));
  assert.equal(second.disposition.completion.mode, 'completed'); assert.match(second.disposition.evidence, /completed without a merge: its workflow completed$/);
});

// ---- Nothing delivers a candidate in this release ----
test('no person\'s command can make a candidate into a task or change a file; the lifecycle writes no task and starts no process; only the factory\'s follow-up path records a run\'s candidates or tasks one', t => {
  const factory = new URL('../starter/factory/', import.meta.url), read = file => readFileSync(new URL(file, factory), 'utf8');
  for (const file of ['operations/upkeep-candidates.mjs', 'operations/upkeep-ceilings.mjs']) {
    const source = read(file), imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
    assert.doesNotMatch(source, /child_process|node:fs|import\(|adapters\/|workflows\/|store\.put\('(task|flow|job|queue)'/, file);
    // 4.5: no whole kind, no lookup by an undeclared field, no JSON predicate over records.data.
    assert.doesNotMatch(source, /store\.(all|stored|recent|live|by|events|count)\(|json_extract|json_each|->>|FROM (records|events)/, file);
    for (const name of imports) assert.match(name, /^(\.\.\/core\/(contracts|upkeep-config|upkeep-namespace)\.mjs|\.\/(upkeep-records|upkeep-class-key|upkeep-ceilings)\.mjs)$/, `${file} imports ${name}`);
  }
  // Slice 5 part B: one module of the factory records what a run's validator kept and tasks it, the
  // factory's follow-up path (operations/upkeep-tasks.mjs). Slice 8: learnings.check's settlement
  // (operations/learnings-check.mjs) raises stale-learning candidates. No other module raises or tasks a candidate.
  const sources = ['core', 'operations', 'workflows', 'adapters', 'service', 'console'].flatMap(dir => readdirSync(new URL(`${dir}/`, factory), { recursive: true }).filter(name => String(name).endsWith('.mjs')).map(name => `${dir}/${name}`));
  for (const file of sources.filter(name => !['operations/upkeep-candidates.mjs', 'operations/upkeep-tasks.mjs', 'operations/learnings-check.mjs'].includes(name))) assert.doesNotMatch(read(file), /recordRunCandidatesInTransaction|raiseCandidatesInTransaction|linkFindingsInTransaction\(store, \{[^}]*by: 'factory'/, `${file} raises or tasks no candidate`);
  assert.match(read('operations/upkeep-tasks.mjs'), /linkFindingsInTransaction\(store, \{[\s\S]{0,200}?by: 'factory'/);
  validateConfig({ version: 1, upkeep: { mode: 'propose' } }); assert.deepEqual(ENFORCED_UPKEEP_KINDS, ['docs', 'context', 'check', 'learning-add', 'learning-retire']);
  // Every command a person has, on every kind of candidate in every state it accepts: the task count and the repository are unchanged.
  const f = sandbox(t), head = () => readFileSync(new URL(`file://${f.root}/input.txt`), 'utf8'), before = { tasks: f.store.count('task'), flows: f.store.count('flow'), jobs: f.store.count('job'), queue: f.store.count('queue'), file: head() }; let n = 0;
  for (const kind of UPKEEP_KINDS) {
    const row = open(f, kind, ++n);
    for (const payload of [{ task: { id: `made-${n}`, title: 'Fictional', acceptance: ['x'] } }, { taskId: 'task-1' }]) assert.equal(send(f, 'finding.accept', { findingId: row.id, expectedVersion: row.version, ...payload }).status, 'rejected');
    assert.equal(send(f, 'task.approve', { taskId: row.id, revision: 'x' }).status, 'rejected'); assert.equal(send(f, 'flow.start', { taskId: row.id }).status, 'rejected');
    assert.equal(send(f, 'finding.resolve', { findingId: row.id, expectedVersion: row.version, disposition: 'declined', reason: 'later' }).status, 'completed');
    assert.equal(send(f, 'finding.reopen', { findingId: row.id, expectedVersion: row.version + 1, note: 'Again' }).status, 'completed');
    assert.equal(send(f, 'finding.resolve', { findingId: row.id, expectedVersion: row.version + 2, disposition: 'resolved-elsewhere', evidence: 'By hand' }).status, 'completed');
  }
  assert.deepEqual({ tasks: f.store.count('task'), flows: f.store.count('flow'), jobs: f.store.count('job'), queue: f.store.count('queue'), file: head() }, before);
});
