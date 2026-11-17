// Must-fix review, slice 5 (docs/designs/review-must-fix.md 7.4 and 15): the strict requirement of
// a must-fix flow, end to end through real merge authorization: scripted providers, the engine, the
// real `answer` command, the effect dispatcher and a scripted forge (review-must-fix-decision-fixtures.mjs).
// A flow pinned to `must-fix` exists only in fixtures: configuration validation still refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionFlow, changeResult, severityResult, finding, fileCite, judge, defer, purpose, acks, instruction } from './review-must-fix-decision-fixtures.mjs';
import { validateReviewPolicy } from '../starter/factory/core/review-bar.mjs';
import { verifyDecision } from '../starter/factory/workflows/actions.mjs';
import { strictReviewRequirement } from '../starter/factory/core/risk.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';

const noImpact = message => ({ ...finding(message, 'none', 'shown', [fileCite()]), severity: 'medium' });

// A strict flow to the merge question with follow-ups recorded: review (defer), followups, gate.
async function strictToQuestion(t, { protocol = 'fresh-full', policy = {}, findings = [noImpact('The reader logs at debug level'), noImpact('A helper name is unclear')] } = {}) {
  const f = await decisionFlow(t, { risk: 'strict', protocol, review: { strictFollowups: true }, policy });
  await f.build();
  const first = await f.review([changeResult({ verdict: 'revise', strict: true, findings })]);
  return { f, first };
}

test('accepted when (7.4): strict fresh-full with follow-ups defers, records them, and merges after the acknowledgement; missing or changed acknowledgements are refused', async t => {
  assert.throws(() => validateReviewPolicy({ policy: { reviewBar: 'must-fix' } }), /must-fix is not available in this release/, 'must-fix stays refused by configuration');
  const { f, first } = await strictToQuestion(t);
  assert.deepEqual([first.route, first.mustFix.enforcement.reason], ['defer', 'items'], 'strict work with strictFollowups: two follow-ups, no must-fix item');
  const followups = await f.effect();
  assert.equal(followups.route, 'pass'); assert.equal(followups.recorded, 2);
  assert.equal(f.calls().filter(call => call.method === 'POST' && call.endpoint === 'repos/fictional/demo/issues').length >= 1, true, 'the follow-up issue was opened on the forge');
  assert.equal(f.current().evidence.review.head, repositoryIdentity(f.root).head, 'the follow-up step minted the review evidence');
  assert.equal((await f.gate()).route, 'pass');
  const item = await f.question();
  assert.ok(item, 'the merge question is open');
  // The strict requirement accepts a defer with its follow-ups recorded at the same identity and review digest.
  assert.equal(item.strictReview.bar, 'must-fix'); assert.equal(item.strictReview.route, 'defer'); assert.equal(item.role, 'operator');
  assert.deepEqual(item.strictReview.acknowledgements.map(row => [row.id, row.kind, row.reason, row.operatorOnly]), [['R1.1', 'follow-up', 'purpose-none', false], ['R1.2', 'follow-up', 'purpose-none', false]]);
  assert.deepEqual(item.reviewDecision.acknowledgements.map(row => row.id), ['R1.1', 'R1.2'], 'the guard shows the same list');
  assert.match(item.question, /Acknowledge each listed finding by id and claim digest/);
  const head = repositoryIdentity(f.root).head, list = item.strictReview.acknowledgements;
  // Refused: no acknowledgement, one missing, a changed claim digest, an extra id, a wrong head.
  assert.match((await f.answer('merge', { reviewedHead: head })).error, /requires acknowledgedFindings/);
  assert.match((await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(list).slice(0, 1) })).error, /missing R1\.2/);
  assert.match((await f.answer('merge', { reviewedHead: head, acknowledgedFindings: [acks(list)[0], { id: 'R1.2', claimDigest: 'a'.repeat(64) }] })).error, /changed R1\.2 \(the claim digest you named is not the current one/);
  assert.match((await f.answer('merge', { reviewedHead: head, acknowledgedFindings: [...acks(list), { id: 'R9.9', claimDigest: 'b'.repeat(64) }] })).error, /not listed R9\.9/);
  assert.match((await f.answer('merge', { reviewedHead: 'c'.repeat(40), acknowledgedFindings: acks(list) })).error, /reviewedHead must name the exact candidate/);
  assert.equal(f.current().mergeAuthorization ?? null, null, 'no refused answer authorized anything');
  // Accepted: the exact head and every listed finding.
  const answered = await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(list) });
  assert.equal(answered.status, 'completed', answered.error);
  const authorization = f.current().mergeAuthorization;
  assert.deepEqual(authorization.acknowledgedFindings, acks(list)); assert.equal(authorization.reviewedHead, head);
  assert.equal(authorization.riskAssessmentDigest, strictReviewRequirement(f.store.need('task', 'task-1'), f.current(), repositoryIdentity(f.root)).assessmentDigest);
  assert.equal(typeof authorization.reviewDecisionDigest, 'string');
  f.publishPR();
  const merged = await f.effect();
  assert.equal(merged.route, 'merged', JSON.stringify(merged));
  assert.ok(f.merges().length >= 1, 'the forge was asked to merge');
  assert.equal((await f.finish()).state, 'completed');
});

test('accepted when (7.4): strict bounded-delta goes full, delta, defer, gate and merge; a full-phase review with items routes delta, never defer', async t => {
  const { f, first } = await strictToQuestion(t, { protocol: 'bounded-delta', findings: [noImpact('The reader logs at debug level')] });
  assert.deepEqual([first.phase, first.route, first.disposition], ['full', 'delta', 'full-reviewed'], 'a defer from the full phase is impossible: it goes to the delta review');
  assert.equal(f.current().step, 'delta-review');
  assert.equal(f.current().evidence.review, undefined, 'the full phase minted no review evidence');
  const delta = await f.review([changeResult({ strict: true })]);
  assert.deepEqual([delta.phase, delta.route], ['delta', 'defer'], 'the delta review records the follow-up');
  assert.equal((await f.effect()).route, 'pass');
  assert.equal((await f.gate()).route, 'pass');
  const item = await f.question(), head = repositoryIdentity(f.root).head;
  assert.deepEqual([item.strictReview.phase, item.strictReview.route, item.strictReview.acknowledgements.map(row => row.id)], ['delta', 'defer', ['R1.1']]);
  const answered = await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(item.strictReview.acknowledgements) });
  assert.equal(answered.status, 'completed', answered.error);
  f.publishPR();
  assert.equal((await f.effect()).route, 'merged');
  assert.equal((await f.finish()).state, 'completed');
  assert.deepEqual(f.current().reviewHistory.map(row => row.phase), ['full', 'delta']);
});

test('accepted when (7.4): strictDecisionRole orchestrator cannot acknowledge a protected exclusion; the operator can', async t => {
  const f = await decisionFlow(t, { risk: 'strict', review: { strictFollowups: true }, policy: { strictDecisionRole: 'orchestrator' } });
  await f.build();
  assert.equal((await f.review([changeResult({ verdict: 'revise', strict: true, findings: [finding('A token is logged', 'security', 'shown', [fileCite()])] })])).route, 'revise');
  // The builder defers it as cant-happen-here; the next reviewer accepts with coverage: a supported protected exclusion.
  await f.build([defer('R1.1', [fileCite()])]);
  const second = await f.review([changeResult({ strict: true, ledger: [judge('R1.1', 'deferral-accepted', { coverage: 'The guard is on the only path.', relevance: ['covers'] })] })]);
  assert.equal(second.route, 'defer');
  const entry = f.ledger().entries.find(row => row.id === 'R1.1');
  assert.deepEqual([entry.kind, entry.reason, entry.operatorOnly], ['operator-item', 'protected-exclusion', true]);
  await f.effect(); await f.gate();
  const item = await f.question(), head = repositoryIdentity(f.root).head, list = item.strictReview.acknowledgements;
  assert.equal(item.role, 'operator', 'an operator-only finding makes the operator the required role');
  assert.equal(item.strictReview.requiredRole, 'operator'); assert.equal(item.strictReview.operatorOnly, true);
  assert.deepEqual(list.map(row => [row.id, row.kind, row.reason, row.operatorOnly]), [['R1.1', 'operator-item', 'protected-exclusion', true]]);
  const refused = await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(list) }, { actor: 'orchestrator' });
  assert.equal(refused.status, 'rejected');
  assert.match(refused.error, /question requires designated actor|only the operator may acknowledge it/);
  const onInstruction = await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(list) }, { actor: 'orchestrator', onBehalfOf: instruction });
  assert.equal(onInstruction.status, 'rejected', 'not on a recorded instruction either');
  const accepted = await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(list) });
  assert.equal(accepted.status, 'completed', accepted.error);
  // Before the merge, an authorization by the strict decision role is refused for an operator-only list.
  const flow = f.current();
  assert.throws(() => verifyDecision(f.store, { ...flow, mergeAuthorization: { ...flow.mergeAuthorization, actor: 'orchestrator', authority: 'strictDecisionRole' } }), /only the operator may acknowledge it/);
});

test('strictDecisionRole orchestrator may acknowledge strict items that are not operator-only (Q4)', async t => {
  const { f } = await strictToQuestion(t, { policy: { strictDecisionRole: 'orchestrator' }, findings: [noImpact('The reader logs at debug level')] });
  await f.effect(); await f.gate();
  const item = await f.question();
  assert.equal(item.role, 'orchestrator');
  const answered = await f.answer('merge', { reviewedHead: repositoryIdentity(f.root).head, acknowledgedFindings: acks(item.strictReview.acknowledgements) }, { actor: 'orchestrator' });
  assert.equal(answered.status, 'completed', answered.error);
  assert.equal(f.current().mergeAuthorization.authority, 'strictDecisionRole');
  verifyDecision(f.store, f.current());
});

test('accepted when (7.4): a ledger change between the answer and the merge is refused before the merge, and the question opens again', async t => {
  const { f } = await strictToQuestion(t, { findings: [noImpact('The reader logs at debug level')] });
  await f.effect(); await f.gate();
  const item = await f.question(), head = repositoryIdentity(f.root).head;
  assert.equal((await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(item.strictReview.acknowledgements) })).status, 'completed');
  assert.equal(f.current().step, 'merge');
  // The merge intent the dispatcher would run, prepared now: it carries what the decision is checked against.
  f.publishPR();
  const before = f.merges().length;
  // The operator disposes of the follow-up while the flow waits at the merge step: the ledger changes.
  const entry = f.ledger().entries.find(row => row.id === 'R1.1');
  assert.equal(f.send('flow.disposeFinding', { flowId: 'flow-1', findingId: 'R1.1', disposition: 'operator-accepted', note: 'Accepted as a fictional follow-up.', expectedVersion: entry.version }).status, 'completed');
  assert.throws(() => verifyDecision(f.store, f.current()), /strict change requires exact-head operator review acknowledgement|the review decision changed since the answer/);
  // The engine refuses the earlier answer before the merge and opens the question again.
  const reopened = await f.question();
  assert.equal(f.current().step, 'decide'); assert.equal(f.current().mergeAuthorization, null);
  assert.equal(f.current().refusedDecisions.at(-1).kind, 'merge');
  assert.ok(reopened && reopened.id !== item.id, 'a new merge question');
  assert.equal(f.merges().length, before, 'nothing was merged');
  assert.equal(f.store.events(50).some(event => event.type === 'flow.decision-refused'), true);
  // The new list carries the changed entry (now accepted by the operator); answering it again merges.
  assert.equal(reopened.strictReview.acknowledgements[0].status, 'operator-accepted');
  assert.notEqual(reopened.strictReview.assessmentDigest, item.strictReview.assessmentDigest, 'the requirement the earlier answer acknowledged changed');
  assert.notEqual(reopened.subjectDigest, item.subjectDigest);
  assert.equal((await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(reopened.strictReview.acknowledgements) })).status, 'completed');
  assert.equal((await f.effect()).route, 'merged');
});

test('the dispatcher refuses a merge whose recorded decision no longer matches the ledger, before asking the forge', async t => {
  const { f } = await strictToQuestion(t, { findings: [noImpact('The reader logs at debug level')] });
  await f.effect(); await f.gate();
  const item = await f.question();
  assert.equal((await f.answer('merge', { reviewedHead: repositoryIdentity(f.root).head, acknowledgedFindings: acks(item.strictReview.acknowledgements) })).status, 'completed');
  f.publishPR();
  // The engine prepares the merge; the intent it gives the dispatcher is then changed as a ledger change would change it.
  await f.engine.tick();
  const attempt = f.store.need('attempt', f.current().attemptId), action = attempt.intent.action;
  assert.equal(action.reviewBar, 'must-fix'); assert.ok(Array.isArray(action.operatorFindingDispositions));
  const changed = { ...action, operatorFindingDispositions: [{ id: 'R1.1', disposition: 'operator-required', note: 'Fix it.', version: 2, afterRound: 1, actor: 'operator', at: new Date().toISOString() }] };
  const before = f.merges().length;
  await assert.rejects(runAction({ ...attempt.intent, action: changed }), /strict change has open must-fix items|strict change requires exact-head operator review acknowledgement/);
  assert.equal(f.merges().length, before, 'the dispatcher refused before asking the forge to merge');
  // Unchanged, the same intent merges.
  assert.equal((await runAction(attempt.intent)).route, 'merged');
});

test('accepted when (7.4): a severity flow merges exactly as today; its question, answer and authorization carry nothing of the must-fix bar', async t => {
  const f = await decisionFlow(t, { risk: 'strict', bar: 'severity' });
  await f.build();
  assert.equal((await f.review([severityResult({ strict: true })])).route, 'pass');
  assert.equal((await f.gate()).route, 'pass');
  const item = await f.question(), head = repositoryIdentity(f.root).head;
  assert.equal(item.reviewDecision, undefined);
  assert.deepEqual(Object.keys(item.strictReview).sort(), ['assessmentDigest', 'head', 'level', 'phase', 'rationale', 'requiredRole', 'reviewer', 'scope', 'stopConditions', 'threatModel', 'unresolvedFindings'].sort(), 'today\'s strict requirement, field for field');
  assert.equal(item.question, `Merge this reviewed and verified candidate? Strict outcome: the designated reviewer must inspect the exact candidate ${head}, threat model and stop conditions before acknowledging.`);
  assert.match((await f.answer('merge', {})).error, /strict change requires explicit exact-head operator review acknowledgement/);
  // A relayed answer is validated as before: the acknowledgement field is not one of its fields.
  assert.match((await f.answer('merge', { reviewedHead: head, acknowledgedFindings: [], relay: { quote: 'Merge it.', channel: 'fictional-thread' } }, { actor: 'orchestrator' })).error, /a relayed answer/);
  // An acknowledgement field is ignored for a severity flow: nothing of it is recorded.
  const answered = await f.answer('merge', { reviewedHead: head, acknowledgedFindings: [{ id: 'R1.1', claimDigest: 'd'.repeat(64) }] });
  assert.equal(answered.status, 'completed', answered.error);
  assert.deepEqual(Object.keys(f.current().mergeAuthorization).sort(), ['actor', 'answeredAt', 'authority', 'configDigest', 'identity', 'inboxId', 'reviewedHead', 'riskAssessmentDigest', 'taskRevision', 'workflowDigest'].sort());
  // A restriction never reaches a severity flow.
  assert.equal(f.send('review.restrict', { operatorDisposition: 'all', expectedVersion: 0, note: 'Fictional kill criterion tripped.' }).status, 'completed');
  verifyDecision(f.store, f.current());
  f.publishPR();
  assert.equal((await f.effect()).route, 'merged');
  assert.equal((await f.finish()).state, 'completed');
});

test('accepted when (7.4): a strict already-satisfied flow on a bounded-delta project: one full satisfied review, the satisfied gate and question, acknowledged, recorded, with no delta review at any check', async t => {
  const f = await decisionFlow(t, { risk: 'strict', protocol: 'bounded-delta', review: { strictFollowups: true }, satisfied: true });
  f.targetIsHead();
  const reviewed = await f.review([changeResult({ verdict: 'pass', strict: true, findings: [finding('A record split across two reads may be read twice', 'outcome', 'unknown')] })]);
  assert.deepEqual([reviewed.phase, reviewed.route], ['full', 'pass'], 'the satisfied review is a single full review that routes pass with its operator item recorded');
  assert.deepEqual(f.ledger().entries.map(row => [row.id, row.kind, row.reason]), [['R1.1', 'operator-item', 'unresolved-scenario']]);
  assert.equal(f.store.all('finding').filter(row => row.source === 'review').length, 1, 'recorded as a row when the review settled');
  assert.equal((await f.gate()).route, 'pass');
  const item = await f.question(), head = repositoryIdentity(f.root).head;
  assert.equal(f.current().step, 'satisfied-decide');
  assert.equal(item.strictReview.bar, 'must-fix');
  assert.deepEqual(item.strictReview.acknowledgements.map(row => [row.id, row.kind]), [['R1.1', 'operator-item']]);
  assert.deepEqual(f.current().reviewHistory.map(row => row.phase), ['full'], 'no delta review exists, and none was required to open the question');
  assert.match((await f.answer('accept', { reviewedHead: head })).error, /requires acknowledgedFindings/, 'an answer without acknowledgedFindings is refused');
  const accepted = await f.answer('accept', { reviewedHead: head, acknowledgedFindings: acks(item.strictReview.acknowledgements) });
  assert.equal(accepted.status, 'completed', accepted.error);
  assert.deepEqual(f.current().completionDecision.acknowledgedFindings, acks(item.strictReview.acknowledgements));
  const recorded = await f.effect();
  assert.deepEqual([recorded.route, recorded.proven, recorded.head], ['recorded', true, head], 'outcome.satisfied records the outcome');
  assert.equal((await f.finish()).state, 'completed');
  assert.deepEqual(f.current().reviewHistory.map(row => row.phase), ['full']);
});

test('a strict bounded-delta final adjudication lists its open must-fix items for acknowledgement', async t => {
  const f = await decisionFlow(t, { risk: 'strict', protocol: 'bounded-delta' });
  const open = changeResult({ verdict: 'revise', strict: true, findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] });
  const incomplete = changeResult({ verdict: 'revise', strict: true, ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] });
  await f.build(); assert.equal((await f.review([open])).route, 'revise');
  await f.build(); assert.deepEqual([(await f.review([incomplete])).phase, f.current().step], ['delta', 'build']);
  await f.build();
  const final = await f.review([incomplete]);
  assert.deepEqual([final.phase, final.route, final.disposition], ['final', 'adjudicate', 'operator-adjudication']);
  await f.gate();
  const item = await f.question(), head = repositoryIdentity(f.root).head;
  assert.deepEqual(item.strictReview.acknowledgements.map(row => [row.id, row.kind, row.status, row.adjudicated]), [['R1.1', 'must-fix', 'open', true]]);
  assert.match((await f.answer('merge', { reviewedHead: head })).error, /requires acknowledgedFindings/);
  assert.equal((await f.answer('merge', { reviewedHead: head, acknowledgedFindings: acks(item.strictReview.acknowledgements) })).status, 'completed');
  verifyDecision(f.store, f.current());
});

test('the strict requirement of a must-fix flow: defer evidence needs its follow-ups at the same review; an open must-fix item blocks unless adjudicated', async t => {
  const { f } = await strictToQuestion(t, { findings: [noImpact('The reader logs at debug level')] });
  await f.effect();
  const task = f.store.need('task', 'task-1'), identity = repositoryIdentity(f.root), flow = f.current();
  assert.equal(strictReviewRequirement(task, flow, identity).route, 'defer');
  // A followups result for another review digest, or missing, is not accepted evidence.
  assert.throws(() => strictReviewRequirement(task, { ...flow, results: { ...flow.results, followups: { ...flow.results.followups, reviewDigest: 'e'.repeat(64) } } }, identity), /accepted review evidence/);
  const { followups, ...rest } = flow.results;
  assert.throws(() => strictReviewRequirement(task, { ...flow, results: rest }, identity), /accepted review evidence/);
  // An open must-fix item (the operator required it) blocks a pass or a defer.
  const required = { ...flow, operatorFindingDispositions: [{ id: 'R1.1', disposition: 'operator-required', note: 'Fix it.', version: 1, afterRound: 1, actor: 'operator', at: new Date().toISOString() }] };
  assert.throws(() => strictReviewRequirement(task, required, identity), /open must-fix items \(R1\.1\)/);
  // A severity flow's requirement is unchanged: a defer is not accepted evidence there.
  assert.throws(() => strictReviewRequirement(task, { ...flow, reviewBar: 'severity' }, identity), /passing independent review or explicit final adjudication/);
});
