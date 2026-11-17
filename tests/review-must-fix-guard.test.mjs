// Must-fix review, slice 5 (docs/designs/review-must-fix.md 12.5, 13.4, 12.1, 12.2 and 15): the
// decision guard of an ordinary must-fix flow at question opening, at answering and before the merge,
// and its effect on `autoMerge` and delegated merge decisions; the `critical` rule; the review
// restriction; notifications and lesson signals. Every flow runs through the engine with the real
// dispatcher and the real `answer` command (review-must-fix-decision-fixtures.mjs). A flow pinned to
// `must-fix` exists only in fixtures: configuration validation still refuses it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { decisionFlow, changeResult, finding, fileCite, defer, purpose, acks, instruction, ACCEPTANCE } from './review-must-fix-decision-fixtures.mjs';
import { verifyDecision, actionSpecification } from '../starter/factory/workflows/actions.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { flowNeedsAttention } from '../starter/factory/operations/notifications.mjs';
import { lessonSignals } from '../starter/factory/operations/lesson-signals.mjs';
import { deferralRefusal } from '../starter/factory/workflows/review-ledger.mjs';
import { deriveFinding } from '../starter/factory/workflows/must-fix.mjs';
import { reviewDecisionGuard, restrictionOf } from '../starter/factory/core/review-decision.mjs';
import { DELEGABLE, NEVER_DELEGABLE } from '../starter/factory/core/delegation.mjs';
import { COMMANDS } from '../starter/factory/core/command-help.mjs';

const ORCHESTRATOR = { mergeDecisionRole: 'orchestrator', autoMerge: true };
const noImpact = message => ({ ...finding(message, 'none', 'shown', [fileCite()]), severity: 'medium' });
// An ordinary flow with delegated merge decisions and automatic merge configured, to its merge
// question: build, one review (and the follow-up step when it defers), the gate.
async function toQuestion(t, review, { flow = {}, before = async () => {} } = {}) {
  const f = await decisionFlow(t, { policy: ORCHESTRATOR, qualified: true, ...flow });
  await f.build();
  const reviewed = await f.review([review]);
  if (reviewed.route === 'defer') assert.equal((await f.effect()).route, 'pass');
  assert.equal((await f.gate()).route, 'pass');
  await before(f);
  return { f, reviewed, item: await f.question() };
}
// The three points of 12.5 for a condition that returns the decision to the operator, and autoMerge.
async function operatorDecision(f, item, reason) {
  assert.ok(item, 'the merge question is open: the configured automatic merge did not answer it');
  assert.deepEqual([item.role, item.autoMerge, item.reviewDecision.operator], ['operator', false, true], `${reason}: opening`);
  assert.ok(item.reviewDecision.reasons.some(row => row.reason === reason), `${reason} in ${JSON.stringify(item.reviewDecision.reasons)}`);
  const list = acks(item.reviewDecision.acknowledgements);
  // Answering: the delegated merge decision role, a recorded instruction and an answer without the acknowledgements are refused.
  assert.equal((await f.answer('merge', { acknowledgedFindings: list }, { actor: 'orchestrator' })).status, 'rejected', `${reason}: the delegated role`);
  assert.equal((await f.answer('merge', { acknowledgedFindings: list }, { actor: 'orchestrator', onBehalfOf: instruction })).status, 'rejected', `${reason}: a recorded instruction`);
  if (list.length) assert.match((await f.answer('merge', {})).error, /requires acknowledgedFindings/, `${reason}: no acknowledgement`);
  const answered = await f.answer('merge', { acknowledgedFindings: list });
  assert.equal(answered.status, 'completed', answered.error);
  const authorization = f.current().mergeAuthorization;
  assert.deepEqual([authorization.actor, authorization.authority, authorization.operatorDecision.includes(reason)], ['operator', 'operator', true]);
  verifyDecision(f.store, f.current());
  // Before the merge: a delegated or automatic decision is refused, by the engine's check and inside the dispatcher.
  for (const forged of [{ actor: 'orchestrator', authority: 'mergeDecisionRole' }, { actor: 'orchestrator', authority: 'autoMerge' }]) {
    const flow = { ...f.current(), mergeAuthorization: { ...authorization, ...forged } };
    assert.throws(() => verifyDecision(f.store, flow), /the merge decision is the operator's/, `${reason}: before the merge (${forged.authority})`);
    const spec = actionSpecification(f.store, flow, flow.workflow.nodes.merge, join(f.stateDir, `forged-${forged.authority}`));
    f.publishPR();
    const before = f.merges().length;
    await assert.rejects(runAction({ attemptId: `forged-${forged.authority}`, cwd: spec.cwd, projectRoot: f.root, timeoutMs: 60000, action: spec.action }), /the merge decision is the operator's/, `${reason}: inside the dispatcher (${forged.authority})`);
    assert.equal(f.merges().length, before, 'the forge was never asked');
  }
  f.publishPR();
  assert.equal((await f.effect()).route, 'merged');
}

test('control: an ordinary must-fix flow with nothing for the operator is answered by the configured automatic merge', async t => {
  const { f, item } = await toQuestion(t, changeResult());
  assert.equal(item, undefined, 'answered by policy as it opened');
  const authorization = f.current().mergeAuthorization;
  assert.deepEqual([authorization.actor, authorization.authority], ['orchestrator', 'autoMerge']);
  verifyDecision(f.store, f.current());
  f.publishPR();
  assert.equal((await f.effect()).route, 'merged');
});

test('accepted when (12.5): an operator item returns the decision to the operator at opening, answering and before the merge, and blocks autoMerge', async t => {
  const { f, item } = await toQuestion(t, changeResult({ verdict: 'revise', findings: [finding('A record split across two reads may be read twice', 'outcome', 'unknown')] }));
  assert.deepEqual(item.reviewDecision.acknowledgements.map(row => [row.id, row.kind, row.reason]), [['R1.1', 'operator-item', 'unresolved-scenario']]);
  await operatorDecision(f, item, 'operator-items');
});

test('accepted when (12.5, 4.3 rule 3): a non-must-fix critical finding returns the decision to the operator at all three points', async t => {
  const { f, item } = await toQuestion(t, changeResult({ verdict: 'revise', findings: [{ ...noImpact('A fictional style issue rated critical'), severity: 'critical' }] }));
  assert.deepEqual(item.reviewDecision.acknowledgements.map(row => [row.id, row.kind, row.reason, row.critical, row.operatorOnly]), [['R1.1', 'operator-item', 'critical', true, true]]);
  await operatorDecision(f, item, 'critical');
});

test('accepted when (12.5): a criterion that is not verified returns the decision to the operator', async t => {
  const { f, item } = await toQuestion(t, changeResult({ purpose: purpose({ acceptance: ACCEPTANCE.map((criterion, index) => ({ criterion, status: index ? 'unverified' : 'met', evidence: [] })) }) }));
  assert.deepEqual(item.reviewDecision.acknowledgements.map(row => [row.id, row.reason, row.unverified]), [['purpose:outcome', 'criterion-unverified', [ACCEPTANCE[1]]]]);
  await operatorDecision(f, item, 'purpose-not-met');
});

test('accepted when (12.5): an outcome other than met returns the decision to the operator', async t => {
  const { f, item } = await toQuestion(t, changeResult({ purpose: purpose({ outcome: 'partly' }) }));
  assert.equal(item.reviewDecision.acknowledgements[0].reason, 'outcome-partly');
  await operatorDecision(f, item, 'purpose-not-met');
});

test('accepted when (12.5): a silent-answer assessment other than no returns the decision to the operator', async t => {
  const { f, item } = await toQuestion(t, changeResult({ purpose: purpose({ silentWrongAnswer: { answer: 'unknown', how: '', settle: 'Run the reader against a split record.', evidence: [] } }) }));
  assert.deepEqual(item.reviewDecision.acknowledgements.map(row => [row.id, row.answer, row.settle]), [['purpose:silent-wrong-answer', 'unknown', 'Run the reader against a split record.']]);
  await operatorDecision(f, item, 'silent-wrong-answer');
});

test('accepted when (12.5): an active review.restrict with operatorDisposition all returns the decision to the operator', async t => {
  const { f, item } = await toQuestion(t, changeResult({ verdict: 'revise', findings: [noImpact('The reader logs at debug level')] }), { before: async f => {
    assert.equal(f.send('review.restrict', { operatorDisposition: 'all', expectedVersion: 0, note: 'Fictional kill criterion tripped.' }).status, 'completed');
  } });
  assert.deepEqual(item.reviewDecision.acknowledgements.map(row => [row.id, row.kind, row.reason, row.wasKind, row.operatorOnly]), [['R1.1', 'operator-item', 'restricted', 'follow-up', true]], 'a recorded follow-up becomes an operator item');
  await operatorDecision(f, item, 'restricted');
});

test('a row overflow is an operator item: it returns the decision to the operator', async t => {
  const { f, item } = await toQuestion(t, changeResult({ verdict: 'revise', findings: [noImpact('The reader logs at debug level'), noImpact('A helper name is unclear')] }), { flow: { review: { maxFollowupsPerFlow: 1 } } });
  assert.equal(f.current().reviewRowOverflow.count, 1);
  await operatorDecision(f, item, 'row-overflow');
});

test('plain follow-ups do not return an ordinary decision to the operator: the delegated role answers without acknowledgements', async t => {
  const f = await decisionFlow(t, { policy: { mergeDecisionRole: 'orchestrator' } });
  await f.build();
  assert.equal((await f.review([changeResult({ verdict: 'revise', findings: [noImpact('The reader logs at debug level')] })])).route, 'defer');
  await f.effect(); await f.gate();
  const item = await f.question();
  assert.deepEqual([item.role, item.reviewDecision.operator, item.reviewDecision.reasons], ['orchestrator', false, []]);
  assert.equal((await f.answer('merge', {}, { actor: 'orchestrator' })).status, 'completed');
  verifyDecision(f.store, f.current());
});

test('accepted when (13.4): a restriction applied with a merge question open supersedes it, and an answer given before it is refused before the merge', async t => {
  // The question is open, decided by the delegated role.
  const { f, item } = await toQuestion(t, changeResult({ verdict: 'revise', findings: [noImpact('The reader logs at debug level')] }), { flow: { policy: { mergeDecisionRole: 'orchestrator' }, qualified: false } });
  assert.deepEqual([item.role, item.reviewDecision.operator], ['orchestrator', false]);
  assert.equal(f.send('review.restrict', { operatorDisposition: 'all', expectedVersion: 0, note: 'Fictional kill criterion tripped.' }).status, 'completed');
  assert.equal(f.store.need('inbox', item.id).status, 'superseded', 'the open question is superseded');
  assert.match((await f.send('answer', { inboxId: item.id, answer: 'merge', version: item.version, subjectDigest: item.subjectDigest }, { actor: 'orchestrator' })).error, /stale or resolved question|question/);
  const reopened = await f.question();
  assert.deepEqual([reopened.role, reopened.reviewDecision.operator, reopened.reviewDecision.restriction.version], ['operator', true, 1]);
  // Lift it, answer under the lifted restriction, then restrict again before the merge.
  assert.equal(f.send('review.restrict', { operatorDisposition: 'none', expectedVersion: 1, note: 'Fictional criterion cleared.' }).status, 'completed');
  const lifted = await f.question();
  assert.deepEqual([lifted.role, lifted.reviewDecision.operator], ['orchestrator', false]);
  assert.equal((await f.answer('merge', {}, { actor: 'orchestrator' })).status, 'completed');
  assert.equal(f.current().step, 'merge');
  assert.equal(f.send('review.restrict', { protectedClassDeferral: false, expectedVersion: 2, note: 'Fictional protected-class escape.' }).status, 'completed');
  assert.throws(() => verifyDecision(f.store, f.current()), /the review decision changed since the answer/);
  f.publishPR();
  const before = f.merges().length;
  const again = await f.question();
  assert.equal(f.current().step, 'decide', 'the earlier answer was refused before the merge and the question opened again');
  assert.equal(f.current().refusedDecisions.at(-1).actor, 'orchestrator');
  assert.match(f.current().refusedDecisions.at(-1).reason, /restriction version 3/);
  assert.equal(f.merges().length, before);
  assert.equal(again.reviewDecision.restriction.version, 3);
});

test('review.restrict: operator only and never delegable; versioned, with a note; tightening and lifting both raise the version', async t => {
  const f = await decisionFlow(t);
  assert.ok(NEVER_DELEGABLE.includes('review.restrict')); assert.ok(!DELEGABLE.includes('review.restrict'));
  assert.ok(COMMANDS['review.restrict'], 'documented for command --help');
  const payload = { operatorDisposition: 'all', expectedVersion: 0, note: 'Fictional kill criterion tripped.' };
  assert.match(f.send('review.restrict', payload, { actor: 'orchestrator' }).error, /operator's own command/);
  assert.match(f.send('review.restrict', payload, { actor: 'orchestrator', onBehalfOf: instruction }).error, /operator's own command/);
  assert.match(f.send('review.restrict', { ...payload, note: undefined }).error, /note is required/);
  assert.match(f.send('review.restrict', { ...payload, expectedVersion: 3 }).error, /changed since you read it/);
  assert.match(f.send('review.restrict', { ...payload, operatorDisposition: 'some' }).error, /all or none/);
  assert.match(f.send('review.restrict', { ...payload, extra: true }).error, /accepts protectedClassDeferral/);
  assert.match(f.send('review.restrict', { expectedVersion: 0, note: 'Nothing.' }).error, /needs protectedClassDeferral or operatorDisposition/);
  assert.equal(f.send('review.restrict', payload).status, 'completed');
  assert.match(f.send('review.restrict', { ...payload, expectedVersion: 1 }).error, /already says that/);
  const record = f.store.meta('reviewRestriction');
  assert.deepEqual([record.version, record.operatorDisposition, record.protectedClassDeferral, record.actor, record.history.length], [1, 'all', true, 'operator', 1]);
  assert.equal(f.store.events(20).filter(event => event.type === 'review.restricted').length, 1);
  assert.deepEqual(restrictionOf(record), { version: 1, protectedClassDeferral: true, operatorDisposition: 'all', active: true });
  // The configuration digest is untouched: no running flow is refused.
  assert.equal(f.store.meta('configDigest'), f.current().configDigest);
});

test('review.restrict protectedClassDeferral false: builder deferrals of protected-class findings are void; a reviewer\'s not-here on a protected class is read as unknown', async t => {
  const restriction = { protectedClassDeferral: false };
  const entry = { id: 'R1.1', kind: 'must-fix', status: 'open', source: 'review', purposeImpact: 'security' };
  const shaped = finding('A token is logged', 'security', 'shown', [fileCite()]), disposition = defer('R1.1', [fileCite()]);
  assert.equal(deferralRefusal(entry, shaped, disposition, { risk: 'ordinary' }), null, 'allowed without the restriction');
  assert.match(deferralRefusal(entry, shaped, disposition, { risk: 'ordinary', restriction }), /restricted protected-class deferral/);
  assert.equal(deferralRefusal({ ...entry, purposeImpact: 'outcome' }, { ...shaped, purposeImpact: 'outcome' }, disposition, { risk: 'ordinary', restriction }), null, 'an outcome finding is not affected');
  const excluded = finding('A token could be logged on a second host', 'security', 'not-here', [cite('environment', { ref: 'single-host' })]);
  assert.deepEqual([deriveFinding(excluded, { risk: 'ordinary', facts: new Set(['single-host']), restriction }).kind, deriveFinding(excluded, { risk: 'strict', facts: new Set(['single-host']), restriction }).kind], ['operator-item', 'must-fix']);
  // Through a must-fix build: the deferral is refused, so the build reaches the build question.
  const f = await decisionFlow(t);
  await f.build();
  assert.equal((await f.review([changeResult({ verdict: 'revise', findings: [finding('A token is logged', 'security', 'shown', [fileCite()])] })])).route, 'revise');
  assert.equal(f.send('review.restrict', { protectedClassDeferral: false, expectedVersion: 0, note: 'Fictional protected-class escape.' }).status, 'completed');
  const built = await f.build([defer('R1.1', [fileCite()])]);
  assert.equal(built.route, 'blocked');
  assert.match(built.deferralRefusals[0].refusal, /restricted protected-class deferral/);
  assert.equal(f.current().step, 'build-question');
});
const cite = (kind, extra = {}) => ({ kind, ref: '-', quote: '', head: null, check: null, result: null, covers: 'The step where the wrong result appears', ...extra });

test('a severity or shadow flow has no guard: the restriction and the must-fix code never reach it', async t => {
  for (const bar of ['severity', 'shadow']) {
    const flow = { reviewBar: bar === 'severity' ? undefined : bar, results: { review: { route: 'pass', result: { verdict: 'pass', findings: [] } } } };
    assert.equal(reviewDecisionGuard(flow, { risk: 'ordinary', restriction: { version: 4, operatorDisposition: 'all' } }), null, bar);
  }
  const f = await decisionFlow(t, { bar: 'severity', policy: ORCHESTRATOR, qualified: true });
  assert.equal(f.send('review.restrict', { operatorDisposition: 'all', expectedVersion: 0, note: 'Fictional kill criterion tripped.' }).status, 'completed');
  await f.build();
  const severity = { verdict: 'pass', summary: 'Fictional pass review', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Bounded fictional change', threatModel: [], stopConditions: [] }, strictReview: { fullDiffInspected: true, threatModelReviewed: false, stopConditionsReviewed: false }, scopeSummary: 'All', priorFindingsDisposition: [], learningsChecked: [] };
  assert.equal((await f.review([severity])).route, 'pass');
  await f.gate();
  assert.equal(await f.question(), undefined, 'automatic merge still answers a severity flow under a restriction');
  assert.equal(f.current().mergeAuthorization.authority, 'autoMerge');
  assert.equal(f.current().mergeAuthorization.reviewDecisionDigest, undefined);
});

test('notifications (12.2): a must-fix flow with an operator item, follow-up, deferral, operator disposition or acknowledgement is not routine', async t => {
  const { f } = await toQuestion(t, changeResult(), { flow: { policy: {}, qualified: false } });
  const flow = f.current(), outcome = 'completed';
  const routineBefore = flowNeedsAttention(f.store, { ...flow, results: { review: flow.results.review } }, outcome);
  const withItem = { ...flow, results: { review: flow.results.review }, reviewHistory: flow.reviewHistory.map(row => ({ ...row, mustFix: { ...row.mustFix, findings: [{ id: 'R1.1', bar: 'must-fix', kind: 'follow-up', reason: 'purpose-none' }] }, result: { ...row.result, findings: [noImpact('The reader logs at debug level')] } })) };
  assert.equal(flowNeedsAttention(f.store, withItem, outcome), true);
  assert.equal(flowNeedsAttention(f.store, { ...flow, results: { review: flow.results.review }, operatorFindingDispositions: [{ id: 'R1.1' }] }, outcome), true);
  assert.equal(flowNeedsAttention(f.store, { ...flow, results: { review: flow.results.review }, mergeAuthorization: { acknowledgedFindings: [{ id: 'R1.1', claimDigest: 'x' }] } }, outcome), true);
  assert.equal(flowNeedsAttention(f.store, { ...flow, results: { review: flow.results.review }, refusedDecisions: [{ kind: 'merge' }] }, outcome), true);
  assert.equal(typeof routineBefore, 'boolean');
});

test('lesson signals (12.1): a must-fix finding judged fix-holds is a verified correction by ledger id; deferrals and fix churn are weak; follow-ups give none', async t => {
  const f = await decisionFlow(t);
  await f.build();
  await f.review([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()]), finding('A missing file is ignored', 'outcome', 'shown', [fileCite()]), noImpact('The reader logs at debug level')] })]);
  await f.build([{ id: 'R1.1', disposition: 'fixed', reason: null, evidence: [], coverage: '', note: '' }, defer('R1.2', [fileCite()])]);
  const judged = changeResult({ verdict: 'revise', findings: [{ ...finding('The fix reads a split record twice', 'outcome', 'unknown'), origin: 'in-fix', fixOf: 'R1.1' }], ledger: [{ id: 'R1.1', judgement: 'fix-holds', sameScenario: false, coverage: 'The reader now keeps an offset.', relevance: [], evidence: [] }, { id: 'R1.2', judgement: 'deferral-accepted', sameScenario: false, coverage: 'The guard is on the only path.', relevance: ['covers'], evidence: [] }] });
  await f.review([judged]);
  const { signals } = lessonSignals({ flow: f.current(), attempts: [], pushback: [] });
  const by = kind => signals.filter(row => row.kind === kind);
  assert.deepEqual(by('review-correction').map(row => [row.ledgerId, row.class]), [['R1.1', 'verified']], 'only the fix that held is verified, matched by ledger id');
  assert.deepEqual(by('review-deferral').map(row => [row.ledgerId, row.outcome, row.class]), [['R1.2', 'supported', 'weak']]);
  assert.deepEqual(by('fix-churn').map(row => [row.ledgerId, row.fixOf, row.class]), [['R2.1', 'R1.1', 'weak']]);
  assert.equal(signals.some(row => row.kind === 'review-correction' && row.ledgerId !== 'R1.1'), false, 'operator items, follow-ups and accepted deferrals give no verified signal');
  assert.equal(signals.some(row => row.kind === 'review-correction-inferred'), false, 'must-fix findings are not matched by message');
});
