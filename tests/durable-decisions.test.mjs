// Plans 7/8 slice B: durable decisions, direct operator first. Fictional fixtures,
// real command paths, the real engine and a fake merge adapter (a trusted command
// whose prepared intent is labeled forge.merge); no live forge or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { migrated } from './authority-fixtures.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { executeCommand, flowNotice, handshake, snapshot, taskView } from '../starter/factory/core/project.mjs';
import { expireStandaloneQuestions } from '../starter/factory/core/communication.mjs';
import { auditAuthorityRecords, taskAuthorityRevision } from '../starter/factory/core/decision-authority.mjs';
import { decisionHolds } from '../starter/factory/core/decisions.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { deliverDue, queueDelivery } from '../starter/factory/operations/notifications.mjs';
import { collection } from '../starter/factory/service/project-service.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';

const ok = receipt => { assert.equal(receipt.status, 'completed', receipt.error); return receipt.result; };
const refused = (receipt, pattern) => { assert.equal(receipt.status, 'rejected', `expected a refusal matching ${pattern}`); assert.match(receipt.error, pattern); return receipt; };
const rev = f => f.store.need('task', 'task-1').revision;
const decision = (f, decisionId) => f.store.need('decisionObligation', decisionId);
const holds = (f, boundary) => decisionHolds(f.store, 'task-1', rev(f), boundary).map(h => h.decisionId);
const sound = f => assert.deepEqual(auditAuthorityRecords(f.store), []);
const as = (f, operation, payload, { actor = 'orchestrator', onBehalfOf, commandId = `cmd-${Math.random().toString(16).slice(2)}` } = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId, operation, payload, actor, ...(onBehalfOf ? { onBehalfOf } : {}) });
const instruction = { principal: 'operator', instruction: 'Fictional operator said: pick JSON.' };
const open = (f, decisionId, extra = {}) => ok(f.command('decision.open', { decisionId, taskId: 'task-1', expectedRevision: rev(f), question: `Which storage format should fictional ${decisionId} use?`, choiceId: `choice-${decisionId}`, options: [{ id: 'json', label: 'Keep the fictional JSON file' }, { id: 'yaml', label: 'Switch to fictional YAML' }], ...extra }));
const answer = (f, decisionId, optionId = 'json', extra = {}) => f.command('decision.dispose', { decisionId, expectedDecisionVersion: decision(f, decisionId).version, kind: 'answer', optionId, rationale: `The fictional operator chose ${optionId}.`, ...extra });
const present = (f, decisionId, extra = {}) => ok(f.command('decision.present', { decisionId, expectedDecisionVersion: decision(f, decisionId).version, ...extra }));
const reply = (f, card, choice, options) => as(f, 'answer', { inboxId: card.id, version: card.version, subjectDigest: card.subjectDigest, answer: choice }, { actor: 'operator', ...options });
const edit = (f, changes) => ok(f.command('task.put', { task: { id: 'task-1', title: 'Fictional feature', acceptance: ['Observed fixture behavior'], ...changes } }));
const approveAndStart = (f, flowId = 'flow-1') => { ok(f.command('task.approve', { taskId: 'task-1', revision: rev(f) })); return f.command('flow.start', { taskId: 'task-1', flowId }); };
const ends = { done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } };
const useWorkflow = (f, nodes) => { const workflow = { version: 1, start: Object.keys(nodes)[0], nodes: { ...nodes, ...ends } }; f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow)); };
const heldAtCompletion = f => until(() => { const flow = f.store.get('flow', 'flow-1'); return flow?.decisionHold?.boundary === 'complete' && flow.state === 'waiting' && flow; }, { tick: () => f.engine.tick() });

test('a schema-1 project behaves as before: decision commands refuse and v2 fields stay unsupported', async t => {
  const f = sandbox(t), revision = rev(f);
  for (const [operation, payload] of [['decision.open', { taskId: 'task-1', expectedRevision: revision, question: 'Fictional?', choiceId: 'c', options: [{ id: 'a', label: 'A' }] }], ['decision.present', { decisionId: 'd', expectedDecisionVersion: 1 }], ['decision.dispose', { decisionId: 'd', expectedDecisionVersion: 1, kind: 'answer', optionId: 'a', rationale: 'r' }], ['decision.revoke', { decisionId: 'd', expectedDecisionVersion: 1, dispositionId: 'x', reason: 'r' }], ['decision.ratify', { decisionId: 'd', expectedDecisionVersion: 1, inactiveDispositionId: 'x', rationale: 'r' }]]) refused(f.command(operation, payload), /migrated authority ledger/);
  const question = { kind: 'question', title: 'Fictional', context: 'Fictional context', question: 'Which?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  refused(f.command('inbox.publish', { ...question, purpose: 'informational' }), /unsupported standalone inbox field/);
  refused(f.command('inbox.publish', { ...question, purpose: 'decision' }), /unsupported standalone inbox field/);
  assert.deepEqual(handshake(f.store).capabilities, ['snapshot', 'command', 'commandStatus']);
  assert.equal(Object.hasOwn(snapshot(f.store), 'decisions'), false); assert.equal(Object.hasOwn(dashboardSnapshot(f.store), 'decisions'), false);
  assert.equal(Object.hasOwn(taskView(f.store, f.store.need('task', 'task-1')), 'decisionHolds'), false);
  assert.throws(() => collection(f.store, 'decision', new URLSearchParams()), /migrated authority ledger/);
  assert.deepEqual(decisionHolds(f.store, 'task-1', revision), []);
  ok(f.start());
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  assert.equal(f.store.need('flow', 'flow-1').decisionHold, undefined);
});

test('an exact answer clears only the decision it names, in one audited command', async t => {
  const f = await migrated(t), before = taskAuthorityRevision(f.store, 'task-1');
  const a = open(f, 'decision-a'), b = open(f, 'decision-b', { requiredAt: ['build'] });
  assert.deepEqual(a.requiredAt, ['merge', 'complete']); assert.deepEqual(b.requiredAt, ['build', 'merge', 'complete']);
  assert.equal(taskAuthorityRevision(f.store, 'task-1'), before + 2);
  assert.deepEqual(holds(f, 'complete'), ['decision-a', 'decision-b']); assert.deepEqual(holds(f, 'build'), ['decision-b']);
  refused(answer(f, 'decision-a', 'toml'), /not one of decision decision-a's options/);
  refused(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 1, kind: 'approve', rationale: 'r' }), /answer, cancel or supersede/);
  refused(f.command('decision.open', { taskId: 'task-1', expectedRevision: 'stale', question: 'q', choiceId: 'c', options: [{ id: 'a', label: 'A' }] }), /task revision changed/);
  refused(f.command('decision.open', { taskId: 'task-1', expectedRevision: rev(f), question: 'q', choiceId: 'c', options: [{ id: 'discuss', label: 'A' }] }), /reserved/);
  const settled = ok(answer(f, 'decision-a'));
  assert.equal(settled.decision.status, 'resolved'); assert.equal(settled.disposition.kind, 'answer'); assert.equal(settled.authorityUse.source, 'direct-operator');
  assert.deepEqual(settled.decision.applicability, [{ taskId: 'task-1', revision: rev(f), state: 'covered', dispositionId: settled.disposition.id }]);
  assert.deepEqual(holds(f, 'complete'), ['decision-b'], 'the other decision still holds');
  assert.equal(decision(f, 'decision-b').version, 1);
  refused(answer(f, 'decision-a', 'yaml'), /already resolved .* revoke its disposition first/);
  sound(f);
});

test('presentation never resolves: read, acknowledgment, discuss, withdrawal and expiry leave the hold', async t => {
  const f = await migrated(t);
  open(f, 'decision-a');
  const card = present(f, 'decision-a');
  assert.equal(card.purpose, 'decision'); assert.equal(card.decision.version, 1); assert.deepEqual(card.answers, ['json', 'yaml', 'discuss']);
  refused(f.command('decision.present', { decisionId: 'decision-a', expectedDecisionVersion: 1 }), /already presented/);
  ok(f.command('inbox.read', { inboxId: card.id })); ok(f.command('inbox.ack', { inboxId: card.id }));
  assert.equal(f.store.need('inbox', card.id).status, 'open');
  const discussed = ok(reply(f, f.store.need('inbox', card.id), 'discuss'));
  assert.equal(discussed.status, 'answered'); assert.equal(discussed.decisionRemains, 'decision-a');
  const second = present(f, 'decision-a');
  const withdrawn = ok(f.command('inbox.withdraw', { inboxId: second.id, expectedVersion: second.version, reason: 'Fictional: asked in person instead' }));
  assert.equal(withdrawn.withdrawal.decisionRemains, 'decision-a');
  const third = present(f, 'decision-a', { expiryMs: 1000 });
  f.store.tx(() => expireStandaloneQuestions(f.store, { nowMs: Date.parse(third.expiresAt) }));
  assert.equal(f.store.need('inbox', third.id).status, 'expired');
  assert.equal(decision(f, 'decision-a').status, 'unresolved'); assert.equal(decision(f, 'decision-a').version, 1);
  assert.deepEqual(holds(f, 'merge'), ['decision-a']);
  assert.equal(f.store.all('decisionDisposition').length, 0);
  // A presented option, answered by the operator, is the exact disposition; the card records it.
  const fourth = present(f, 'decision-a');
  const answered = ok(reply(f, fourth, 'yaml'));
  assert.equal(decision(f, 'decision-a').status, 'resolved'); assert.equal(f.store.need('decisionDisposition', answered.dispositionId).answer.optionId, 'yaml');
  sound(f);
});

test('only the operator disposes directly; delegated and orchestrator dispositions are refused and write nothing', async t => {
  const f = await migrated(t);
  const opened = ok(as(f, 'decision.open', { decisionId: 'decision-a', taskId: 'task-1', expectedRevision: rev(f), question: 'Fictional?', choiceId: 'c', options: [{ id: 'json', label: 'JSON' }, { id: 'yaml', label: 'YAML' }] }));
  assert.equal(opened.source.kind, 'orchestrator', 'the orchestrator may open a hold');
  const card = ok(as(f, 'decision.present', { decisionId: 'decision-a', expectedDecisionVersion: 1 }));
  refused(reply(f, card, 'json', { actor: 'orchestrator', onBehalfOf: instruction }), /needs the operator directly/);
  refused(reply(f, card, 'json', { actor: 'orchestrator' }), /needs the operator directly/);
  for (const [operation, payload] of [['decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 1, kind: 'answer', optionId: 'json', rationale: 'r' }], ['decision.revoke', { decisionId: 'decision-a', expectedDecisionVersion: 1, dispositionId: 'x', reason: 'r' }], ['decision.ratify', { decisionId: 'decision-a', expectedDecisionVersion: 1, inactiveDispositionId: 'x', rationale: 'r' }]]) {
    refused(as(f, operation, payload, { onBehalfOf: instruction }), /needs the operator directly/);
    refused(as(f, operation, payload), /needs the operator directly/);
  }
  assert.equal(f.store.all('decisionDisposition').length, 0); assert.equal(f.store.all('authorityUse').length, 0);
  assert.equal(f.store.need('inbox', card.id).status, 'open', 'a refused answer leaves the card open');
  // "Discuss" is not a disposition: a delegated reply is recorded and the decision stays unresolved.
  ok(reply(f, card, 'discuss', { actor: 'orchestrator', onBehalfOf: instruction }));
  assert.equal(decision(f, 'decision-a').status, 'unresolved');
});

test('stale card and decision versions are rejected; a replayed command returns its canonical receipt', async t => {
  const f = await migrated(t);
  open(f, 'decision-a');
  const card = present(f, 'decision-a');
  refused(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 0, kind: 'answer', optionId: 'json', rationale: 'r' }), /changed; expected version 0, found 1/);
  refused(reply(f, { ...card, version: card.version + 1 }, 'json'), /stale or resolved question/);
  // A task edit moves the decision to a new version; the old card is retired and cannot answer it.
  edit(f, { title: 'Fictional feature, revised' });
  assert.equal(decision(f, 'decision-a').version, 2);
  assert.equal(f.store.need('inbox', card.id).status, 'superseded');
  refused(reply(f, card, 'json'), /stale or resolved question/);
  const fresh = present(f, 'decision-a');
  assert.equal(fresh.decision.version, 2); assert.equal(fresh.decision.taskRevision, rev(f));
  // Replay: same command id and content returns the first receipt; nothing is applied twice.
  const payload = { decisionId: 'decision-a', expectedDecisionVersion: 2, kind: 'answer', optionId: 'json', rationale: 'Fictional replay' };
  const first = f.command('decision.dispose', payload, { commandId: 'cmd-dispose-1' });
  ok(first);
  assert.deepEqual(f.command('decision.dispose', payload, { commandId: 'cmd-dispose-1' }), first);
  assert.equal(f.store.all('decisionDisposition').length, 1); assert.equal(f.store.all('authorityUse').length, 1);
  assert.throws(() => f.command('decision.dispose', { ...payload, optionId: 'yaml' }, { commandId: 'cmd-dispose-1' }), /command id reused with different content/);
  assert.equal(f.store.need('inbox', fresh.id).status, 'superseded', 'a card for a settled decision is retired');
  refused(reply(f, fresh, 'yaml'), /stale or resolved question/);
  // A rejected command replays its rejection, even though the same payload would now be refused for another reason.
  const stale = f.command('decision.revoke', { decisionId: 'decision-a', expectedDecisionVersion: 2, dispositionId: first.result.disposition.id, reason: 'Fictional' }, { commandId: 'cmd-stale-revoke' });
  refused(stale, /changed; expected version 2, found 3/);
  assert.deepEqual(f.command('decision.revoke', { decisionId: 'decision-a', expectedDecisionVersion: 2, dispositionId: first.result.disposition.id, reason: 'Fictional' }, { commandId: 'cmd-stale-revoke' }), stale);
  assert.equal(decision(f, 'decision-a').status, 'resolved');
  sound(f);
});

test('task edits, close and reopen carry the hold forward; task.revoke leaves decision evidence untouched', async t => {
  const f = await migrated(t), r1 = rev(f);
  open(f, 'decision-a');
  const r2 = edit(f, { title: 'Fictional feature, second brief' }).revision;
  assert.deepEqual(decision(f, 'decision-a').applicability.map(a => [a.revision, a.state]), [[r1, 'pending'], [r2, 'pending']]);
  assert.deepEqual(holds(f, 'merge'), ['decision-a']);
  const closed = edit(f, { title: 'Fictional feature, second brief', closed: true }).revision;
  assert.deepEqual(holds(f, 'merge'), ['decision-a'], 'closing the task keeps the hold on the closed revision');
  const reopened = edit(f, { title: 'Fictional feature, second brief' }).revision;
  assert.equal(reopened, r2); assert.deepEqual(holds(f, 'merge'), ['decision-a'], 'reopening returns to a revision that still holds');
  assert.equal(decision(f, 'decision-a').applicability.length, 3);
  // An answer covers the revisions of the version it answered; a later edit needs confirmation.
  ok(answer(f, 'decision-a'));
  assert.deepEqual(holds(f, 'merge'), []);
  const r4 = edit(f, { title: 'Fictional feature, third brief' }).revision;
  const carried = decision(f, 'decision-a');
  assert.equal(carried.status, 'resolved'); assert.equal(carried.applicability.find(a => a.revision === r4).state, 'requires-confirmation');
  assert.deepEqual(holds(f, 'merge'), ['decision-a'], 'an answer never silently follows a changed brief');
  assert.match(taskView(f.store, f.store.need('task', 'task-1')).decisionHolds[0].summary, /needs confirmation/);
  assert.ok([r1, r2, closed].every(r => carried.applicability.some(a => a.revision === r)));
  const confirmed = ok(answer(f, 'decision-a'));
  assert.equal(confirmed.decision.status, 'resolved'); assert.deepEqual(holds(f, 'merge'), []);
  assert.equal(f.store.all('decisionDisposition').filter(d => d.status === 'inactive').length, 1, 'the earlier answer is inactive history');
  // task.revoke withdraws task approval only.
  ok(f.command('task.approve', { taskId: 'task-1', revision: rev(f) }));
  const evidence = () => ['decisionObligation', 'decisionDisposition', 'authorityUse'].map(kind => f.store.all(kind));
  const before = evidence();
  ok(f.command('task.revoke', { taskId: 'task-1', note: 'Fictional: pause this task' }));
  assert.deepEqual(evidence(), before); assert.equal(f.store.need('task', 'task-1').approvedRevision, null);
  sound(f);
});

test('a build hold blocks admission and a whole restart; merge-only holds admit planning but stop completion', async t => {
  const f = await migrated(t);
  open(f, 'decision-b', { requiredAt: ['build'] });
  const task = f.store.need('task', 'task-1');
  assert.ok(admissionReasons(f.store, task).some(reason => /decision-held: decision decision-b .* blocks build/.test(reason)));
  refused(f.command('task.restart', { taskId: 'task-1', revision: task.revision, note: 'Fictional restart' }), /admission refused: decision-held/);
  assert.equal(f.store.need('task', 'task-1').approvedRevision, null, 'the nested approval rolled back with the refused restart');
  refused(approveAndStart(f), /admission refused: decision-held/);
  assert.equal(f.store.all('flow').length, 0);
  ok(answer(f, 'decision-b'));
  open(f, 'decision-m');
  assert.ok(!admissionReasons(f.store, f.store.need('task', 'task-1')).some(reason => /decision-held/.test(reason)));
  ok(f.command('flow.start', { taskId: 'task-1', flowId: 'flow-1' }));
  const held = await heldAtCompletion(f);
  assert.deepEqual(held.decisionHold.decisions.map(d => d.decisionId), ['decision-m']);
  assert.notEqual(f.store.need('task', 'task-1').status, 'completed');
});

test('failure, stop, resume, abandon, restart and replan keep the hold; the operator answer releases completion', async t => {
  const f = await migrated(t);
  open(f, 'decision-a');
  ok(approveAndStart(f));
  await heldAtCompletion(f);
  assert.ok(f.store.events().some(e => e.type === 'flow.decision-held'));
  assert.equal(f.store.all('inbox').filter(i => i.id.startsWith('flow-notice:flow-1:completed')).length, 0, 'a held flow has not completed');
  ok(f.command('stop', { flowId: 'flow-1', note: 'Fictional stop' }));
  ok(f.command('resume', { flowId: 'flow-1', note: 'Fictional resume' }));
  await heldAtCompletion(f);
  ok(f.command('stop', { flowId: 'flow-1', note: 'Fictional stop' }));
  ok(f.command('flow.abandon', { flowId: 'flow-1', note: 'Fictional abandon' }));
  assert.deepEqual(holds(f, 'complete'), ['decision-a']);
  // A replan returns a flow to planning; decisions are not flow state.
  const restarted = ok(f.command('task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional restart' }));
  ok(f.command('stop', { flowId: restarted.flowId, note: 'Fictional stop before replan' }));
  const flow = f.store.need('flow', restarted.flowId);
  f.store.put('flow', { ...flow, mode: 'delivery', workflow: { ...flow.workflow, nodes: { ...flow.workflow.nodes, plan: { kind: 'effect', action: { operation: 'provider.plan' }, timeoutMs: 1000, next: 'done', onFailure: 'failed' } } } });
  ok(f.command('flow.replan', { flowId: restarted.flowId, note: 'Fictional replan' }));
  assert.equal(f.store.need('flow', restarted.flowId).step, 'plan');
  ok(f.command('flow.abandon', { flowId: restarted.flowId, note: 'Fictional abandon after replan' }));
  // A failing run keeps it too.
  useWorkflow(f, { work: { kind: 'effect', argv: [process.execPath, '-e', 'process.exit(3)'], timeoutMs: 4000, next: 'done', onFailure: 'failed' } });
  const failing = ok(f.command('task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional failing run' }));
  await until(() => f.store.need('flow', failing.flowId).state === 'failed', { tick: () => f.engine.tick() });
  assert.deepEqual(holds(f, 'complete'), ['decision-a']);
  assert.equal(decision(f, 'decision-a').status, 'unresolved'); assert.equal(decision(f, 'decision-a').version, 1);
  // A passing run held at completion finishes once the operator answers.
  useWorkflow(f, { work: { kind: 'effect', argv: [process.execPath, '-e', '0'], timeoutMs: 4000, next: 'done', onFailure: 'failed' } });
  const last = ok(f.command('task.restart', { taskId: 'task-1', revision: rev(f), note: 'Fictional final run' }));
  await until(() => f.store.need('flow', last.flowId).decisionHold, { tick: () => f.engine.tick() });
  const card = present(f, 'decision-a');
  ok(reply(f, card, 'json'));
  await until(() => f.store.need('flow', last.flowId).state === 'completed', { tick: () => f.engine.tick() });
  assert.equal(f.store.need('flow', last.flowId).decisionHold, undefined); assert.equal(f.store.need('task', 'task-1').status, 'completed');
  assert.ok(f.store.events().some(e => e.type === 'flow.decision-released' && e.payload.flowId === last.flowId));
  sound(f);
});

test('the hold survives a process restart', async t => {
  const f = await migrated(t);
  open(f, 'decision-a');
  ok(approveAndStart(f));
  await heldAtCompletion(f);
  // Restart: a new connection and engine read the same canonical state.
  f.store.close();
  const fresh = new Store(f.stateDir); f.store.db = fresh.db;
  const engine = new Engine(f.store);
  for (let i = 0; i < 3; i++) await engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'waiting'); assert.deepEqual(holds(f, 'complete'), ['decision-a']);
  ok(answer(f, 'decision-a'));
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => engine.tick() });
  sound(f);
});

test('cancel prevents delivery of the removed scope; supersession needs a valid successor or a revised removal', async t => {
  const f = await migrated(t), r1 = rev(f);
  open(f, 'decision-a');
  ok(approveAndStart(f));
  await heldAtCompletion(f);
  const canceled = ok(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 1, kind: 'cancel', reason: 'Fictional: drop the storage switch', rationale: 'Not needed for the fictional release' })).decision;
  assert.equal(canceled.status, 'canceled');
  assert.deepEqual(decisionHolds(f.store, 'task-1', r1).map(h => [h.decisionId, h.boundaries]), [['decision-a', ['merge', 'complete', 'release']]]);
  assert.deepEqual(holds(f, 'build'), [], 'a cancellation does not stop work; it stops delivery');
  for (let i = 0; i < 3; i++) await f.engine.tick();
  assert.equal(f.store.need('flow', 'flow-1').state, 'waiting'); assert.match(f.store.need('flow', 'flow-1').decisionHold.reasons[0], /canceled/);
  refused(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 2, kind: 'supersede', removedScope: 'x', rationale: 'r' }), /already canceled/);
  // The revised brief removes the scope; superseding on it records the removal and clears the hold.
  const r2 = edit(f, { title: 'Fictional feature without the storage switch' }).revision;
  assert.equal(decision(f, 'decision-a').applicability.find(a => a.revision === r2).state, 'requires-confirmation');
  refused(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 3, kind: 'supersede', rationale: 'r' }), /replacement decisions, or removedScope/);
  const superseded = ok(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 3, kind: 'supersede', removedScope: 'The storage switch is out of this task', rationale: 'Brief revised' }));
  assert.equal(superseded.decision.status, 'superseded'); assert.equal(superseded.disposition.supersession.revisedRevision, r2);
  assert.deepEqual(holds(f), []);
  const run = ok(f.command('task.restart', { taskId: 'task-1', revision: r2, note: 'Fictional run on the revised brief' }));
  await until(() => f.store.need('flow', run.flowId).state === 'completed', { tick: () => f.engine.tick() });
  // Replacement rules: existing, same task and revision, not itself superseded, not self, no cycle.
  open(f, 'decision-c'); open(f, 'decision-d');
  const supersede = (decisionId, extra) => f.command('decision.dispose', { decisionId, expectedDecisionVersion: decision(f, decisionId).version, kind: 'supersede', rationale: 'Fictional replacement', ...extra });
  refused(supersede('decision-c', { removedScope: 'x' }), /tied to a revised brief/);
  refused(supersede('decision-c', { replacements: ['decision-missing'] }), /does not exist/);
  refused(supersede('decision-c', { replacements: ['decision-c'] }), /cannot supersede itself/);
  refused(supersede('decision-c', { replacements: ['decision-a'] }), /itself superseded|must apply/);
  const replaced = ok(supersede('decision-c', { replacements: ['decision-d'] }));
  assert.deepEqual(replaced.decision.supersededBy, ['decision-d']);
  assert.deepEqual(holds(f, 'merge'), ['decision-d'], 'the replacement carries the hold');
  refused(supersede('decision-d', { replacements: ['decision-c'] }), /itself superseded/);
  refused(f.command('decision.revoke', { decisionId: 'decision-c', expectedDecisionVersion: decision(f, 'decision-c').version, dispositionId: replaced.disposition.id, reason: 'r' }), /superseded, which is final/);
  sound(f);
});

// The fake merge adapter: the prepared trusted step's intent is labeled forge.merge
// and runs a command that writes a merged action result after a delay.
function labelFakeMerge(f, delayMs) {
  const attempt = f.store.all('attempt').at(-1), dir = join(f.stateDir, 'attempts', attempt.id);
  const script = `setTimeout(()=>{const fs=require('fs');const i=JSON.parse(fs.readFileSync(${JSON.stringify(join(dir, 'intent.json'))},'utf8'));fs.writeFileSync(${JSON.stringify(join(dir, 'action-result.json'))},JSON.stringify({attemptId:i.attemptId,intentDigest:i.intentDigest,route:'merged',merged:true,sha:'${'b'.repeat(40)}'}))},${delayMs})`;
  const intent = { ...attempt.intent, argv: [process.execPath, '-e', script], action: { operation: 'forge.merge' } };
  rmSync(join(dir, 'intent.json'), { force: true });
  f.store.put('attempt', { ...attempt, intent, intentDigest: digest(intent) });
  return { attempt: f.store.need('attempt', attempt.id), dir };
}
const shipWorkflow = f => useWorkflow(f, { ship: { kind: 'effect', argv: [process.execPath, '-e', '0'], timeoutMs: 8000, next: 'done', onFailure: 'failed' } });

test('decision.revoke before dispatch reopens the hold and blocks preparation and new work', async t => {
  const f = await migrated(t);
  useWorkflow(f, { ship: { kind: 'effect', action: { operation: 'forge.merge' }, timeoutMs: 1000, next: 'done', onFailure: 'failed' } });
  const a = open(f, 'decision-a'), b = open(f, 'decision-b', { requiredAt: ['build'] });
  const answered = ok(answer(f, a.id)); ok(answer(f, b.id));
  ok(approveAndStart(f));
  const revoked = ok(f.command('decision.revoke', { decisionId: a.id, expectedDecisionVersion: 2, dispositionId: answered.disposition.id, reason: 'Fictional: reconsider the format' }));
  assert.equal(revoked.decision.status, 'unresolved'); assert.deepEqual(revoked.authorityRaces, []);
  assert.equal(f.store.need('decisionDisposition', answered.disposition.id).status, 'inactive'); assert.equal(f.store.need('authorityUse', answered.authorityUse.id).status, 'inactive');
  await f.engine.step('flow-1');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.state, 'waiting'); assert.equal(flow.attemptId, null); assert.equal(flow.decisionHold.boundary, 'merge');
  assert.equal(f.store.all('attempt').length, 0, 'no merge intent was prepared');
  ok(answer(f, a.id));
  await assert.rejects(f.engine.step('flow-1'), /current merge decision required/, 'once released, the existing merge checks apply');
  // A revoked build decision blocks new work.
  ok(f.command('stop', { flowId: 'flow-1', note: 'Fictional stop' })); ok(f.command('flow.abandon', { flowId: 'flow-1', note: 'Fictional abandon' }));
  const bDisposition = decision(f, b.id).activeDispositionId;
  ok(f.command('decision.revoke', { decisionId: b.id, expectedDecisionVersion: 2, dispositionId: bDisposition, reason: 'Fictional: reconsider' }));
  refused(f.command('flow.start', { taskId: 'task-1', flowId: 'flow-2' }), /admission refused: decision-held: decision decision-b/);
  sound(f);
});

test('decision.revoke after preparation fails the dispatch fence: zero launches, a recorded not-dispatched attempt', async t => {
  const f = await migrated(t);
  shipWorkflow(f);
  const a = open(f, 'decision-a'), answered = ok(answer(f, a.id));
  ok(approveAndStart(f));
  await f.engine.step('flow-1');
  const { attempt, dir } = labelFakeMerge(f, 0);
  assert.equal(attempt.status, 'prepared');
  ok(f.command('decision.revoke', { decisionId: a.id, expectedDecisionVersion: 2, dispositionId: answered.disposition.id, reason: 'Fictional: reconsider' }));
  await f.engine.tick();
  const fenced = f.store.need('attempt', attempt.id), flow = f.store.need('flow', 'flow-1');
  assert.equal(fenced.status, 'not-dispatched'); assert.equal(fenced.costMicros, 0); assert.match(fenced.reason, /decision hold before dispatch/);
  assert.equal(fenced.dispatchedAt, undefined);
  assert.equal(existsSync(join(dir, 'owner.json')), false, 'the supervisor never launched'); assert.equal(existsSync(join(dir, 'receipt.json')), false);
  assert.equal(flow.attemptId, null); assert.equal(flow.state, 'waiting'); assert.equal(flow.decisionHold.boundary, 'merge');
  // Direct ratification restores the unchanged answer; the step prepares a fresh intent.
  const ratified = ok(f.command('decision.ratify', { decisionId: a.id, expectedDecisionVersion: 3, inactiveDispositionId: answered.disposition.id, rationale: 'Fictional: the original answer stands' }));
  assert.equal(ratified.disposition.ratifiesDispositionId, answered.disposition.id);
  await f.engine.tick();
  const next = f.store.all('attempt').at(-1);
  assert.notEqual(next.id, attempt.id); assert.ok(['prepared', 'dispatching', 'running', 'passed'].includes(next.status));
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  sound(f);
});

test('decision.revoke after a dispatched effect records an authority race without undoing it', async t => {
  const f = await migrated(t);
  shipWorkflow(f);
  const a = open(f, 'decision-a'), answered = ok(answer(f, a.id));
  ok(approveAndStart(f));
  await f.engine.step('flow-1');
  const { attempt } = labelFakeMerge(f, 900);
  await f.engine.step('flow-1');
  assert.equal(f.store.need('attempt', attempt.id).status, 'dispatching');
  const revoked = ok(f.command('decision.revoke', { decisionId: a.id, expectedDecisionVersion: 2, dispositionId: answered.disposition.id, reason: 'Fictional: too late' }));
  assert.equal(revoked.authorityRaces.length, 1); assert.equal(revoked.authorityRaces[0].attemptId, attempt.id); assert.equal(revoked.authorityRaces[0].operation, 'forge.merge');
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.stopRequested, false); assert.equal(flow.abortRequested, false); assert.equal(flow.authorityRaces.length, 1);
  assert.ok(f.store.all('inbox').some(i => i.id.startsWith(`authority-race:${attempt.id}`) && i.status === 'open'));
  // The effect completes and is recorded as fact; the decision stays unresolved and holds completion.
  await until(() => f.store.need('attempt', attempt.id).settledAt, { tick: () => f.engine.tick(), timeout: 15000 });
  assert.equal(f.store.need('attempt', attempt.id).status, 'passed');
  assert.equal(f.store.need('flow', 'flow-1').results.merge.merged, true);
  await heldAtCompletion(f);
  assert.equal(decision(f, a.id).status, 'unresolved');
  assert.equal(f.store.all('attempt').length, 1, 'nothing was retried');
  sound(f);
});

test('decision.ratify restores clearance only while revision, scope and options are unchanged', async t => {
  const f = await migrated(t);
  open(f, 'decision-a');
  const first = ok(answer(f, 'decision-a')).disposition;
  refused(f.command('decision.ratify', { decisionId: 'decision-a', expectedDecisionVersion: 2, inactiveDispositionId: first.id, rationale: 'r' }), /only an unresolved decision can be ratified/);
  ok(f.command('decision.revoke', { decisionId: 'decision-a', expectedDecisionVersion: 2, dispositionId: first.id, reason: 'Fictional revoke' }));
  refused(f.command('decision.ratify', { decisionId: 'decision-a', expectedDecisionVersion: 2, inactiveDispositionId: first.id, rationale: 'r' }), /changed; expected version 2, found 3/);
  const second = ok(f.command('decision.ratify', { decisionId: 'decision-a', expectedDecisionVersion: 3, inactiveDispositionId: first.id, rationale: 'Fictional ratify' }));
  assert.equal(second.authorityUse.operation, 'decision.ratify'); assert.equal(second.decision.status, 'resolved'); assert.deepEqual(holds(f), []);
  ok(f.command('decision.revoke', { decisionId: 'decision-a', expectedDecisionVersion: 4, dispositionId: second.disposition.id, reason: 'Fictional revoke again' }));
  refused(f.command('decision.ratify', { decisionId: 'decision-a', expectedDecisionVersion: 5, inactiveDispositionId: first.id, rationale: 'r' }), /already ratified once/);
  // A changed task revision: the earlier answer cannot be restored; answer anew.
  edit(f, { title: 'Fictional feature, changed brief' });
  refused(f.command('decision.ratify', { decisionId: 'decision-a', expectedDecisionVersion: 6, inactiveDispositionId: second.disposition.id, rationale: 'r' }), /answer anew/);
  refused(as(f, 'decision.ratify', { decisionId: 'decision-a', expectedDecisionVersion: 6, inactiveDispositionId: second.disposition.id, rationale: 'r' }, { onBehalfOf: instruction }), /needs the operator directly/);
  assert.deepEqual(holds(f, 'merge'), ['decision-a']);
  ok(answer(f, 'decision-a'));
  sound(f);
});

test('under actionable notifications an unresolved decision keeps a terminal summary from being suppressed as routine', async t => {
  const f = await migrated(t), configPath = join(f.base, 'notifications.json'), sent = [];
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 });
  f.store.setMeta('config', { ...f.store.meta('config'), notifications: { level: 'actionable', configPath } });
  const deliver = () => deliverDue(f.store, { configPath, nowMs: Date.now() + 1000, limit: 100, transport: async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; } });
  const finish = flowId => f.store.tx(() => {
    const flow = { id: flowId, kind: 'change', taskId: 'task-1', taskRevision: rev(f), step: 'done', state: 'completed', results: { merge: { merged: true, expectedHead: 'a'.repeat(40) }, cleanup: { released: true } } };
    f.store.put('flow', flow); flowNotice(f.store, flow, 'completed');
    return f.store.all('inbox').find(row => row.flowId === flowId);
  });
  const routine = finish('routine');
  assert.equal(queueDelivery(f.store, { inboxId: routine.id }).status, 'suppressed', 'without a decision a clean delivery is routine');
  // Queued as routine before the decision arrived: the decision reclassifies it.
  open(f, 'decision-a');
  assert.equal(f.store.all('delivery').find(d => d.inboxId === routine.id).status, 'pending');
  const later = finish('later');
  assert.equal(queueDelivery(f.store, { inboxId: later.id }).status, 'pending');
  await deliver();
  assert.deepEqual(sent.map(row => row.inboxId).sort(), [later.id, routine.id].sort());
  ok(answer(f, 'decision-a'));
  const quiet = finish('quiet');
  assert.equal(queueDelivery(f.store, { inboxId: quiet.id }).status, 'suppressed', 'a settled decision is no longer attention material');
});

test('service, snapshot and publication v2 project durable decisions apart from their cards', async t => {
  const f = await migrated(t);
  assert.deepEqual(handshake(f.store).capabilities, ['snapshot', 'command', 'commandStatus', 'decisionAuthority.v1', 'standaloneQuestion.v2', 'operatorGrants.v1']);
  const a = open(f, 'decision-a', { requiredAt: ['build'] });
  const informational = ok(f.command('inbox.publish', { kind: 'question', purpose: 'informational', title: 'Fictional', context: 'Fictional context', question: 'Which?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }));
  assert.equal(informational.purpose, 'informational'); assert.equal(informational.publicationVersion, 2);
  refused(f.command('inbox.publish', { kind: 'question', purpose: 'decision', title: 'T', context: 'C', question: 'Q?', decision: { decisionId: a.id, expectedDecisionVersion: 1 } }), /takes its question and choices from the decision/);
  refused(f.command('inbox.publish', { purpose: 'decision', title: 'T', decision: { decisionId: a.id, expectedDecisionVersion: 1, taskRevision: 'f'.repeat(64) } }), /taskRevision does not match/);
  const card = ok(f.command('inbox.publish', { purpose: 'decision', title: 'Fictional storage decision', decision: { decisionId: a.id, expectedDecisionVersion: 1, taskId: 'task-1', taskRevision: rev(f), scopeDigest: a.scopeDigest } }));
  assert.equal(card.decision.decisionId, a.id); assert.deepEqual(card.decision.requiredAt, ['build', 'merge', 'complete']);
  const listed = collection(f.store, 'decision', new URLSearchParams()), view = listed.items[0];
  assert.equal(listed.total, 1); assert.deepEqual(view.blocks, ['build', 'merge', 'complete']); assert.equal(view.cards[0].id, card.id); assert.equal(view.appliesToCurrentRevision, true);
  assert.deepEqual(snapshot(f.store).decisions.map(d => d.id), [a.id]); assert.deepEqual(dashboardSnapshot(f.store).decisions.map(d => d.id), [a.id]);
  assert.match(taskView(f.store, f.store.need('task', 'task-1')).decisionHolds[0].summary, /decision-held: decision decision-a/);
  // Withdrawing the card leaves the projection holding.
  ok(f.command('inbox.withdraw', { inboxId: card.id, expectedVersion: card.version, reason: 'Fictional: discussed elsewhere' }));
  assert.deepEqual(collection(f.store, 'decision', new URLSearchParams()).items[0].blocks, ['build', 'merge', 'complete']);
  const answered = ok(answer(f, a.id));
  const settled = collection(f.store, 'decision', new URLSearchParams()).items[0];
  assert.deepEqual(settled.blocks, []); assert.equal(settled.dispositions[0].id, answered.disposition.id);
  ok(f.command('decision.revoke', { decisionId: a.id, expectedDecisionVersion: 2, dispositionId: answered.disposition.id, reason: 'Fictional' }));
  assert.deepEqual(collection(f.store, 'decision', new URLSearchParams()).items[0].ratifiable, [answered.disposition.id]);
});

test('the console shows a durable decision with substantive dispositions only, bound to its exact version', async t => {
  const f = await migrated(t);
  const a = open(f, 'decision-a'), view = collection(f.store, 'decision', new URLSearchParams()).items[0];
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.children = []; this.handlers = {}; this.dataset = {}; this.style = { setProperty() {} }; this.value = ''; this._text = text; }
    append(...items) { this.children.push(...items.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false)); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    setAttribute(key, value) { this[key] = value; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(c => c.textContent ?? String(c)).join(''); }
    reportValidity() { return true; }
  }
  const keys = ['Node', 'document', 'localStorage', 'sessionStorage', 'window', 'fetch'], old = Object.fromEntries(keys.map(k => [k, globalThis[k]])), storage = { getItem: () => null, setItem() {} };
  Object.assign(globalThis, { Node: Element, document: { querySelector: () => ({ content: 'fixture-csrf' }), createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) }, localStorage: storage, sessionStorage: storage, window: { dispatchEvent() {}, confirm: () => true } });
  try {
    const { durableDecisionCard } = await import('../starter/factory/console/ui/inbox.mjs'), { state } = await import('../starter/factory/console/ui/state.mjs');
    const project = { projectId: f.project.projectId, bindingId: 'binding', name: 'Fictional', status: 'available', snapshot: { tasks: [{ id: 'task-1', title: 'Fictional feature' }], decisions: [view] } };
    state.projects = [project];
    const descendants = node => [node, ...node.children.flatMap(child => child instanceof Element ? descendants(child) : [])];
    const card = durableDecisionCard(project, view), text = card.textContent;
    assert.match(text, /Holds merge, complete/); assert.match(text, /Keep the fictional JSON file/); assert.match(text, /Switch to fictional YAML/);
    const sent = [];
    globalThis.fetch = async (_url, options) => { sent.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ status: 'completed' }) }; };
    const forms = descendants(card).filter(n => n.tag === 'form');
    for (const form of forms) { for (const field of descendants(form).filter(n => n.name)) field.value = 'Fictional rationale'; await form.handlers.submit({ preventDefault() {} }); }
    const operations = sent.map(row => row.operation);
    assert.ok(operations.includes('decision.dispose')); assert.ok(!operations.includes('obligation.resolve'), 'no generic resolution for a decision');
    for (const row of sent.filter(r => r.operation === 'decision.dispose')) { assert.equal(row.payload.decisionId, a.id); assert.equal(row.payload.expectedDecisionVersion, 1); assert.equal(row.actor, 'operator'); }
    assert.deepEqual(new Set(sent.filter(r => r.operation === 'decision.dispose').map(r => r.payload.kind)), new Set(['answer', 'cancel']));
  } finally { for (const [key, value] of Object.entries(old)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});

// Independent review fixes: scope removal never clears a brief it was removed from.
const base = { title: 'Fictional feature', acceptance: ['Observed fixture behavior'] };
const reopenings = (f, decisionId) => f.store.all('decisionObligation').filter(o => o.reopens === decisionId);
const removal = (f, decisionId, extra = {}) => f.command('decision.dispose', { decisionId, expectedDecisionVersion: decision(f, decisionId).version, kind: 'supersede', removedScope: 'The fictional storage switch is out of this task', rationale: 'Brief revised without it', ...extra });

test('restoring the exact brief a scope was removed from reopens the choice as a fresh decision that holds completion', async t => {
  const f = await migrated(t), r1 = rev(f);
  open(f, 'decision-a');
  ok(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 1, kind: 'cancel', reason: 'Fictional: drop the storage switch', rationale: 'Operator removed it' }));
  const r2 = edit(f, { title: 'Fictional feature without the storage switch' }).revision;
  ok(removal(f, 'decision-a'));
  assert.deepEqual(holds(f), []);
  const supersededRecord = decision(f, 'decision-a'), dispositions = f.store.all('decisionDisposition');
  // Revision digests are content-addressed: the restored brief is r1 again, with its first snapshot.
  assert.equal(edit(f, base).revision, r1);
  const [reopened] = reopenings(f, 'decision-a');
  assert.ok(reopened, 'restoring the brief reopens the choice');
  assert.deepEqual([reopened.status, reopened.originRevision, reopened.applicability, reopened.scopeDigest, reopened.optionSetDigest], ['unresolved', r1, [{ taskId: 'task-1', revision: r1, state: 'pending' }], supersededRecord.scopeDigest, supersededRecord.optionSetDigest]);
  assert.deepEqual(decision(f, 'decision-a'), supersededRecord, 'the superseded decision is untouched');
  assert.deepEqual(f.store.all('decisionDisposition'), dispositions, 'no disposition changes');
  assert.deepEqual(decisionHolds(f.store, 'task-1', r1).map(h => [h.decisionId, h.boundaries]), [[reopened.id, ['merge', 'complete']]]);
  assert.deepEqual(decisionHolds(f.store, 'task-1', r2), [], 'the removed brief stays cleared');
  sound(f);
  // The reviewer's graph: approve the restored brief and end directly in completed.
  useWorkflow(f, { finish: { kind: 'end', outcome: 'completed' } });
  ok(approveAndStart(f));
  const flow = await heldAtCompletion(f);
  assert.match(flow.decisionHold.reasons[0], new RegExp(reopened.id));
  ok(answer(f, reopened.id, 'yaml'));
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  sound(f);
});

test('after a scope removal, edits from the removed brief stay cleared; leaving that lineage reopens once, and the reopening follows later edits', async t => {
  const f = await migrated(t);
  const r1 = edit(f, { title: 'Fictional feature with a storage switch' }).revision, r0brief = base;
  open(f, 'decision-a');
  const r2 = edit(f, { title: 'Fictional feature, storage switch removed' }).revision;
  ok(removal(f, 'decision-a'));
  const a = decision(f, 'decision-a');
  // A later edit made from the removed brief stays cleared.
  edit(f, { title: 'Fictional feature, storage switch removed, wording tidied' });
  assert.deepEqual(holds(f), []); assert.equal(reopenings(f, 'decision-a').length, 0);
  // Leaving that lineage for a brief it does not clear (here the brief before the decision) reopens.
  const r0 = edit(f, r0brief).revision;
  const [y0] = reopenings(f, 'decision-a');
  assert.ok(y0); assert.deepEqual(holds(f), [y0.id]);
  // Returning to a pre-removal revision while the reopening applies does not reopen again: it carries.
  assert.equal(edit(f, { title: 'Fictional feature with a storage switch' }).revision, r1);
  assert.equal(reopenings(f, 'decision-a').length, 1); assert.deepEqual(holds(f), [y0.id]);
  const r4 = edit(f, { title: 'Fictional feature with a storage switch, restored and extended' }).revision;
  assert.equal(reopenings(f, 'decision-a').length, 1); assert.deepEqual(holds(f), [y0.id]);
  assert.deepEqual(decision(f, y0.id).applicability.map(x => [x.revision, x.state]), [[r0, 'pending'], [r1, 'pending'], [r4, 'pending']]);
  // The reopening is removed again on the removed brief; restoring r1 then reopens the reopening, once.
  assert.equal(edit(f, { title: 'Fictional feature, storage switch removed' }).revision, r2);
  assert.deepEqual(holds(f), [y0.id], 'the reopening applies to the removed brief now too, so it must be settled there');
  ok(removal(f, y0.id));
  assert.deepEqual(holds(f), []);
  assert.equal(edit(f, { title: 'Fictional feature with a storage switch' }).revision, r1);
  const [y1] = reopenings(f, y0.id);
  assert.ok(y1); assert.equal(reopenings(f, 'decision-a').length, 1);
  assert.deepEqual(holds(f), [y1.id]);
  assert.deepEqual(decision(f, 'decision-a'), a, 'the first superseded decision never changed');
  sound(f);
});

test('a removal beside replacements is tied to a revised brief: refused at the origin with nothing written, and audit-clean once accepted', async t => {
  const f = await migrated(t), r1 = rev(f);
  open(f, 'decision-a'); open(f, 'decision-b');
  const before = ['decisionObligation', 'decisionDisposition', 'authorityUse', 'taskAuthority'].map(kind => f.store.all(kind));
  refused(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: 1, kind: 'supersede', replacements: ['decision-b'], removedScope: 'Part of the fictional scope', rationale: 'The rest goes to decision-b' }), /tied to a revised brief/);
  assert.deepEqual(['decisionObligation', 'decisionDisposition', 'authorityUse', 'taskAuthority'].map(kind => f.store.all(kind)), before, 'the refusal rolled back every write');
  sound(f);
  const r2 = edit(f, { title: 'Fictional feature, part of the storage switch removed' }).revision;
  const mixed = ok(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: decision(f, 'decision-a').version, kind: 'supersede', replacements: ['decision-b'], removedScope: 'Part of the fictional scope', rationale: 'The rest goes to decision-b' }));
  assert.deepEqual(mixed.disposition.supersession, { replacements: ['decision-b'], removedScope: 'Part of the fictional scope', revisedRevision: r2 });
  sound(f);
  assert.deepEqual(holds(f), ['decision-b'], 'the replacement carries the hold');
  const reopened = new Store(f.stateDir); t.after(() => reopened.close());
  assert.deepEqual(auditAuthorityRecords(reopened), []);
  // The removed part comes back with the restored brief.
  assert.equal(edit(f, base).revision, r1);
  assert.equal(reopenings(f, 'decision-a').length, 1);
  sound(f);
});

test('decision commands run the task-scoped audit before commit and roll back when it fails', async t => {
  const f = await migrated(t), r1 = rev(f);
  open(f, 'decision-a');
  edit(f, { title: 'Fictional feature, revised' });
  // Damage the evidence: the snapshot of a revision the decision applies to disappears.
  f.store.db.prepare('DELETE FROM records WHERE kind=? AND json_extract(data,\'$.revision\')=?').run('taskRevision', r1);
  assert.ok(auditAuthorityRecords(f.store, { taskId: 'task-1' }).length);
  const version = decision(f, 'decision-a').version, uses = f.store.all('authorityUse').length;
  refused(answer(f, 'decision-a'), /would leave decision-authority records of task task-1 that fail the audit: .*unrecorded revision/);
  assert.equal(decision(f, 'decision-a').version, version); assert.equal(f.store.all('authorityUse').length, uses);
  assert.deepEqual(auditAuthorityRecords(f.store, { taskId: 'task-2' }), [], 'the scoped audit reads only the named task');
});

test('an edit past the applicability limit is refused with its recovery route, and that route works', async t => {
  const f = await migrated(t);
  open(f, 'decision-a');
  for (let i = 1; i < 64; i++) edit(f, { title: `Fictional feature, draft ${i}` });
  assert.equal(decision(f, 'decision-a').applicability.length, 64);
  const before = rev(f);
  refused(f.command('task.put', { task: { ...base, id: 'task-1', title: 'Fictional feature, draft 64' } }), /decision decision-a already applies to 64 task revisions.*decision\.open.*supersede decision-a with it/);
  assert.equal(rev(f), before, 'the refused edit changed nothing');
  open(f, 'decision-b');
  ok(f.command('decision.dispose', { decisionId: 'decision-a', expectedDecisionVersion: decision(f, 'decision-a').version, kind: 'supersede', replacements: ['decision-b'], rationale: 'Fictional: continue the choice in a fresh decision' }));
  edit(f, { title: 'Fictional feature, draft 64' });
  assert.deepEqual(holds(f), ['decision-b']);
  sound(f);
});

// Second re-check: corrupt evidence must not suppress holds, and the scoped safeguard
// must see a use shared with another task's disposition.
{
  const base = { id: 'task-1', title: 'Fictional feature', acceptance: ['Observed fixture behavior'] };
  const rev = f => f.store.need('task', 'task-1').revision;
  const cmd = (f, op, p) => { const r = f.command(op, p); assert.equal(r.status, 'completed', r.error); return r.result; };
  const edit = (f, title) => cmd(f, 'task.put', { task: { ...base, title } });
  const open = (f, id) => cmd(f, 'decision.open', { decisionId: id, taskId: 'task-1', expectedRevision: rev(f), question: 'Choice?', choiceId: 'same-scope', options: [{ id: 'yes', label: 'Yes' }] });
  const remove = (f, id) => cmd(f, 'decision.dispose', { decisionId: id, expectedDecisionVersion: f.store.need('decisionObligation', id).version, kind: 'supersede', removedScope: 'Scope removed', rationale: 'Revised brief' });

  test('a cyclic reopening chain is refused by the audit and never suppresses the backstop hold', async t => {
    const f = await migrated(t), a = rev(f);
    open(f, 'd1'); open(f, 'd2'); edit(f, 'B without scope'); remove(f, 'd1'); remove(f, 'd2');
    for (const [id, other] of [['d1', 'd2'], ['d2', 'd1']]) f.store.put('decisionObligation', { ...f.store.need('decisionObligation', id), reopens: other });
    assert.match(auditAuthorityRecords(f.store, { limit: 200 }).map(p => p.reason).join('\n'), /reopening chain is cyclic/);
    // Restoring A with the corrupt chain in place: the scoped safeguard refuses the edit,
    // and even read directly the corrupt reopenings own nothing, so both decisions still hold A.
    assert.equal(f.command('task.put', { task: { ...base } }).status, 'rejected');
    assert.equal(decisionHolds(f.store, 'task-1', a).length, 2);
    // A chain ending at a missing record, or through a decision of another scope, owns nothing either.
    f.store.put('decisionObligation', { ...f.store.need('decisionObligation', 'd1'), reopens: 'missing-decision' });
    f.store.put('decisionObligation', { ...f.store.need('decisionObligation', 'd2'), reopens: 'd1' });
    assert.equal(decisionHolds(f.store, 'task-1', a).length, 2);
  });

  test('the scoped safeguard counts dispositions on other tasks that share this task\'s authority use', async t => {
    const f = await migrated(t); open(f, 'd');
    const settled = cmd(f, 'decision.dispose', { decisionId: 'd', expectedDecisionVersion: f.store.need('decisionObligation', 'd').version, kind: 'answer', optionId: 'yes', rationale: 'yes' });
    const other = cmd(f, 'task.put', { task: { ...base, id: 'task-2' } });
    cmd(f, 'decision.open', { decisionId: 'other', taskId: 'task-2', expectedRevision: other.revision, question: 'Choice?', choiceId: 'other', options: [{ id: 'yes', label: 'Yes' }] });
    const os = cmd(f, 'decision.dispose', { decisionId: 'other', expectedDecisionVersion: 1, kind: 'answer', optionId: 'yes', rationale: 'yes' });
    f.store.put('decisionDisposition', { ...os.disposition, authorityUseId: settled.authorityUse.id, commandId: settled.disposition.commandId });
    assert.match(auditAuthorityRecords(f.store, { taskId: 'task-1' }).map(p => p.reason).join('\n'), /authorizes 2 dispositions/);
    assert.equal(f.command('decision.revoke', { decisionId: 'd', expectedDecisionVersion: 2, dispositionId: settled.disposition.id, reason: 'reconsider' }).status, 'rejected');
  });
}
