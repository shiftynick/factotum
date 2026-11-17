// dev.85: the remaining findings of the dev.84 readiness re-test. A build that ended at its turn
// limit reads as stopped at the limit in the console (I2; the record and status --flow are tested
// in provider-turn-limit.test.mjs); the Flow slots card lists idle pools (I1, in
// console-flow-slots.test.mjs); times in "Admission held" carry their recorded UTC value (I3); a
// refused stale answer says what happened (I4); the triage proxy records the thread each forward
// was addressed to (I5b); and status --compact is one line without the fields nobody reads there
// (I5c). The starter guides are checked in starter-guides.test.mjs (I5a, I5d). Fictional fixtures
// throughout. See docs/changes/dev85-retest-items.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installDom, byTag, descendants } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { staleQuestionReason } from '../starter/factory/core/stale-question.mjs';
import { runRecorded, confirmSent, forwardsSince, verifyForward } from '../starter/project/integrations/triage.example.mjs';

installDom();
const { state } = await import('../starter/factory/console/ui/state.mjs');
const records = await import('../starter/factory/console/ui/records.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const { queueView } = await import('../starter/factory/console/ui/queue.mjs');
const { staleAnswer } = await import('../starter/factory/console/ui/inbox.mjs');

const text = node => node.textContent;
const NOW = Date.now(), ago = ms => new Date(NOW - ms).toISOString();
function project(snapshot = {}, settings = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [],
    ...snapshot, settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: { autoQueue: true }, ...settings } } };
}
const dd = (node, label) => { const terms = byTag(node, 'dt'), i = terms.findIndex(dt => text(dt) === label); return i < 0 ? null : byTag(node, 'dd')[i]; };

// ---- I2: the console reads a build out of turns as stopped at its turn limit -------------------------

const turnLimitBuild = (extra = {}) => ({ id: 'attempt-build-5007', flowId: 'flow-1', step: 'build', status: 'passed', outcome: 'turn-limit', route: 'blocked', classification: 'turn-limit',
  reason: 'provider turn limit: error_max_turns, after 4 turns, limit 3, reported cost $0.294', createdAt: ago(120000), dispatchedAt: ago(119000), settledAt: ago(60000),
  receipt: { startedAt: ago(119000), endedAt: ago(61000), exitCode: 0 }, ...extra });

test('I2: the timeline, the attempt panel and History show a build out of turns as stopped at its turn limit, not passed', () => {
  const attempt = turnLimitBuild();
  assert.equal(records.attemptStatus(attempt), 'turn-limit');
  // Older records: the overview's attempt rows carry the classification, not the outcome.
  assert.equal(records.attemptStatus({ id: 'a', status: 'passed', classification: 'turn-limit' }), 'turn-limit');
  assert.equal(records.attemptStatus({ id: 'a', status: 'failed', classification: 'turn-limit' }), 'failed', 'a reviewer settled as failed stays failed');
  assert.equal(records.attemptStatus({ id: 'a', status: 'passed', route: 'pass' }), 'passed');
  // The attempt panel's outcome rows.
  const rows = () => Object.fromEntries(records.attemptResultRows(attempt).filter(([, value]) => value !== undefined).map(([label, value]) => [label, typeof value === 'string' ? value : text(value)]));
  const shown = rows();
  assert.match(shown.Outcome, /^▲stopped at its turn limit the provider stopped at its turn limit before the step finished/);
  assert.doesNotMatch(shown.Outcome, /passed/);
  assert.equal(shown.Lifecycle, "settled cleanly (status passed); the flow followed its blocked route to the step's question");
  assert.equal(shown['Process exit'], 'code 0 (the step runner process, not the outcome)');
  // The timeline bar and its accessible text.
  const model = timeline.timelineModel({ flow: { id: 'flow-1', state: 'waiting', createdAt: ago(130000) }, attempts: [attempt], waits: [], events: [] }, { observedAt: new Date().toISOString(), stepOrder: ['build'] });
  const run = model.segments.find(s => s.kind === 'run');
  assert.equal(run.status, 'turn-limit'); assert.equal(run.label, 'build stopped at turn limit');
  // History's status column and filter value.
  const chip = records.attemptChip(attempt);
  assert.equal(text(chip), '▲stopped at turn limit'); assert.ok(chip.classList.includes('tone-warn'), 'drawn as a warning, not green');
});

// ---- I3: times in "Admission held" carry the recorded UTC value -------------------------------------

test('I3: the times inside "Admission held" are <time> elements with the recorded UTC value in their tooltip', () => {
  const observed = '2026-11-16T00:19:52.000Z', notReady = '2026-11-16T00:18:40.000Z';
  const task = { id: 'task-q', title: 'Fictional queued work', revision: 'r1', approvedRevision: 'r1', status: 'approved', admissionReasons: ['flow capacity exhausted'] };
  const queue = [{ id: 'task-q', status: 'queued', order: 1, eligibility: { ready: false, reasons: ['flow capacity exhausted'], lastObservedAt: observed, lastNotReadyAt: notReady, transitions: 2 } }];
  state.reads.clear();
  const view = queueView(project({ tasks: [task], queue, queueRevision: 'q1', queueComplete: true, queueStatus: { autoQueue: true, holds: [], capacity: null, lastDispatch: null } }), { params: { task: 'task-q' } });
  const held = descendants(view).find(node => node.tag === 'details' && /^Admission held/.test(text(node)));
  assert.ok(held, 'the queue entry has its observation');
  for (const [label, iso] of [['Observed', observed], ['Last not ready', notReady]]) {
    const [node] = byTag(dd(held, label), 'time');
    assert.ok(node, `${label} is a time element`);
    assert.equal(node.getAttribute('datetime'), iso); assert.equal(node.getAttribute('title'), `${iso} (UTC as recorded)`);
    assert.doesNotMatch(text(node), /T\d{2}:/, 'the visible text is a local time, not raw ISO');
  }
  assert.equal(text(dd(held, 'Ready since')), '—', 'a missing time is a dash, not a broken element');
});

// ---- I4: a refused stale answer says what happened -------------------------------------------------

test('I4: a stale answer is refused with what happened: already answered (with the answer and by whom), resolved otherwise, or changed since read', () => {
  const answered = { id: 'q-1', status: 'answered', version: 2, subjectDigest: 's', answer: 'green', choices: [{ id: 'green', label: 'Green' }, { id: 'blue', label: 'Blue' }], answeredBy: 'operator' };
  assert.equal(staleQuestionReason(answered, { version: 1, subjectDigest: 's' }), 'stale or resolved question: it was already answered “Green” by the operator; this answer was not applied');
  assert.equal(staleQuestionReason({ ...answered, answeredBy: 'orchestrator', relay: { relayedBy: 'orchestrator' } }, { version: 1 }), 'stale or resolved question: it was already answered “Green” by the orchestrator (relayed); this answer was not applied');
  assert.equal(staleQuestionReason({ ...answered, status: 'superseded' }, { version: 1 }), 'stale or resolved question: it is superseded and takes no answer; this answer was not applied');
  const open = { id: 'q-2', status: 'open', version: 3, subjectDigest: 's' };
  assert.equal(staleQuestionReason(open, { version: 2, subjectDigest: 's' }), 'stale or resolved question: it changed since it was read (version 2, now 3); read it again before answering');
  assert.equal(staleQuestionReason(open, { version: 3, subjectDigest: 'other' }), 'stale or resolved question: what it asks about changed since it was read; read it again before answering');
  assert.equal(staleQuestionReason(open, { version: 3, subjectDigest: 's' }), null);
  assert.match(staleQuestionReason(open, { version: undefined, subjectDigest: 's' }), /no version was given \(it is at version 3\)/, 'a missing version is still refused');
});

test('I4: answering a question another tab already answered is refused with the answer, in the receipt and on the page', t => {
  const f = sandbox(t, { question: true });
  f.start();
  const item = () => f.store.all('inbox').find(row => row.kind === 'question' && row.flowId === 'flow-1');
  return (async () => {
    for (let i = 0; i < 400 && !item(); i++) { await f.engine.step('flow-1'); await new Promise(resolve => setTimeout(resolve, 25)); }
    const q = item(); assert.ok(q, 'the fictional question opened');
    const read = { inboxId: q.id, version: q.version, subjectDigest: q.subjectDigest };
    assert.equal(f.command('answer', { ...read, answer: 'continue' }).status, 'completed', 'tab B answers first');
    const refused = f.command('answer', { ...read, answer: 'stop' });
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.error, 'stale or resolved question: it was already answered “Continue” by the operator; this answer was not applied', 'the answer by its label');
    // The page adds when and where, without repeating what the refusal says.
    const p = project({ inbox: [{ ...f.store.need('inbox', q.id) }] });
    assert.match(staleAnswer(q.id)(p, refused.error), /^It was answered .*\. It is under Inbox → Resolved\.$/);
    assert.equal(staleAnswer(q.id)(project({ inbox: [{ ...q }] }), refused.error), '', 'a page that has not refreshed yet adds nothing to the refusal');
  })();
});

// ---- I5b: the proxy records the thread each forward was addressed to --------------------------------

test('I5b: --forwards and --verify show the thread a forward was addressed to, also when it was decided before a rebind and sent after it', t => {
  const dir = mkdtempSync(join(tmpdir(), 'fct-forward-to-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = { memoryPath: join(dir, 'state.json'), logPath: join(dir, 'log.jsonl') };
  const compact = (session, extra = {}) => JSON.stringify({ snapshotView: 'dashboard-v1', projectId: 'fictional-project', flows: [], orchestratorSession: { sessionId: session }, ...extra });
  // Decided while the predecessor is bound: a recovery hold raised.
  const before = runRecorded('timer', { ...files, input: compact('thread-old', { recoveryHold: true, recoveryHoldReason: { cause: 'fictional' } }), nowMs: Date.parse('2026-11-16T00:36:00Z') });
  assert.equal(before.decision, 'forward'); assert.equal(before.forwardTo, 'thread-old');
  // The successor binds; the earlier forward is confirmed sent only now. Then a forward to the successor.
  confirmSent(before.sendId, { ...files, nowMs: Date.parse('2026-11-16T00:37:50Z') });
  const after = runRecorded('timer', { ...files, input: compact('thread-new'), nowMs: Date.parse('2026-11-16T00:38:26Z') });
  assert.equal(after.decision, 'forward'); assert.equal(after.forwardTo, 'thread-new');
  confirmSent(after.sendId, { ...files, nowMs: Date.parse('2026-11-16T00:38:30Z') });
  const log = readFileSync(files.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(log.map(e => [e.decision, e.forwardTo ?? null]), [['forward', 'thread-old'], ['sent', 'thread-old'], ['forward', 'thread-new'], ['sent', 'thread-new']]);
  assert.equal(log[0].forwardSource, 'session');
  const sent = forwardsSince(log, '2026-11-16T00:36:00Z');
  assert.deepEqual(sent.map(row => [row.sendId, row.forwardTo]), [[before.sendId, 'thread-old'], [after.sendId, 'thread-new']], 'the forward sent after the rebind still names the thread it went to');
  const check = verifyForward(log, before.sendId);
  assert.equal(check.forwardTo, 'thread-old'); assert.match(check.verdict, /It was addressed to thread thread-old; if that is not this thread, it reached another one\./);
  // A log written before dev.85 says it does not know.
  const old = verifyForward([{ at: 'x', decision: 'forward', rule: 'timer-change', sendId: 'timer:old' }, { at: 'y', decision: 'sent', what: 'timer', sendId: 'timer:old' }], 'timer:old');
  assert.equal(old.forwardTo, null); assert.match(old.verdict, /does not record which thread/);
  assert.equal(forwardsSince([{ at: 'x', decision: 'forward', rule: 'r', sendId: 's' }, { at: '2026-11-16T00:00:00Z', decision: 'sent', what: 'timer', sendId: 's' }])[0].forwardTo, null);
});

// ---- I5c: status --compact is one line without the fields nobody reads there -----------------------

test('I5c: status --compact is one line of JSON; queue entries that left the queue and resolved inbox items drop what only waiting or answering uses', t => {
  const f = sandbox(t), at = new Date().toISOString(), long = 'Fictional observation. '.repeat(40);
  const eligibility = { episode: 'e'.repeat(64), taskRevision: 'r'.repeat(64), ready: true, reasons: [long], firstObservedAt: at, lastObservedAt: at, changedAt: at, transitions: 3, firstReadyAt: at, readySince: at, lastNotReadyAt: at };
  const admissionTiming = { observedAt: at, readySince: at, firstReadyAt: at, readyToAdmissionMs: 12, firstReadyToAdmissionMs: 2014, basis: 'observed-eligibility', episode: 'e'.repeat(64), flowId: 'flow-x' };
  f.store.tx(() => {
    f.store.put('queue', { id: 'task-queued', order: 1, status: 'queued', queuedAt: at, priority: 0, pinned: false, eligibility });
    f.store.put('queue', { id: 'task-done', order: 0, status: 'finished', queuedAt: at, priority: 0, pinned: false, eligibility, admissionTiming, flowId: 'flow-x', claimedAt: at, finishedAt: at, flowState: 'completed' });
    f.store.put('queue', { id: 'task-running', order: 2, status: 'claimed', queuedAt: at, priority: 0, pinned: false, eligibility, admissionTiming, flowId: 'flow-y', claimedAt: at });
    const planQuestion = { planDigest: 'p'.repeat(64), questions: [long, long], summary: long };
    f.store.put('inbox', { id: 'q-open', kind: 'question', status: 'open', flowId: 'flow-y', role: 'operator', version: 1, question: 'Fictional plan question?', context: long, answers: ['replan', 'stop'], choices: [{ id: 'replan', label: 'Replan' }], planQuestion, createdAt: at, expiresAt: new Date(Date.now() + 3600000).toISOString() });
    f.store.put('inbox', { id: 'q-answered', kind: 'question', status: 'answered', flowId: 'flow-x', role: 'operator', version: 2, question: 'Fictional earlier question?', context: long, answers: ['replan', 'stop'], choices: [{ id: 'replan', label: 'Replan' }], answer: 'replan', answeredBy: 'operator', answeredAt: at, answerNote: 'Fictional note', planQuestion, buildQuestion: { status: 'blocked', questions: [long] }, carriedQuestions: { questions: [{ from: 'planner', question: 'Fictional carried?' }] }, createdAt: at });
  });
  const view = dashboardSnapshot(f.store), byId = (rows, id) => rows.find(row => row.id === id);
  assert.deepEqual(byId(view.queue, 'task-queued').eligibility, eligibility, 'a queued entry keeps its admission observation (the Queue editor shows it)');
  for (const id of ['task-done', 'task-running']) {
    const row = byId(view.queue, id);
    assert.equal(row.eligibility, undefined); assert.deepEqual(row.admissionTiming, { readyToAdmissionMs: 12 });
    for (const key of ['id', 'status', 'flowId', 'claimedAt', 'queuedAt']) assert.ok(row[key] !== undefined, `${id} keeps ${key}`);
  }
  assert.ok(byId(view.inbox, 'q-open').planQuestion, 'an open question keeps what answering needs');
  const answered = byId(view.inbox, 'q-answered');
  assert.equal(answered.planQuestion, undefined); assert.equal(answered.buildQuestion, undefined);
  for (const key of ['context', 'answer', 'answeredBy', 'answeredAt', 'answerNote', 'choices', 'carriedQuestions', 'question', 'version']) assert.ok(answered[key] !== undefined, `the Resolved view keeps ${key}`);
  // The consumers' fields are all still there (the triage proxy's timer check and the handling guide's paths).
  for (const key of ['snapshotView', 'projectId', 'flows', 'queueTasks', 'queueStatus', 'mainHealth', 'health', 'spending', 'orchestratorSession', 'obligations', 'paused', 'recoveryHold', 'commissioningRequired'])
    assert.ok(Object.hasOwn(view, key), `compact keeps ${key}`);
  // The command prints it on one line.
  const cli = fileURLToPath(new URL('../starter/factory/cli.mjs', import.meta.url));
  const out = execFileSync(process.execPath, [cli, 'status', '--state', f.stateDir, '--compact'], { encoding: 'utf8' });
  assert.equal(out.split('\n').length, 2, 'one line and its newline'); assert.equal(out.at(-1), '\n');
  const parsed = JSON.parse(out);
  assert.equal(parsed.snapshotView, 'dashboard-v1'); assert.equal(byId(parsed.queue, 'task-done').eligibility, undefined);
});
