// Must-fix review, slice 5, after review (docs/designs/review-must-fix.md 12.5 and 13.4): a decision
// that changes between the preparation of its merge (or satisfied record) and the dispatch of that
// step. The prepared intent carries a snapshot of the restriction; the engine's final dispatch
// transaction, the only path that launches a prepared intent (after a restart too), rechecks the
// current authorization, restriction and ledger against the live state. On a mismatch the prepared
// attempt is recorded not dispatched, the forge is never asked, and the question opens again.
// A flow pinned to `must-fix` exists only in fixtures (review-must-fix-decision-fixtures.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionFlow, changeResult, finding, fileCite, acks } from './review-must-fix-decision-fixtures.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { decisionDispatchRefusal } from '../starter/factory/workflows/actions.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

const noImpact = () => ({ ...finding('The reader logs at debug level', 'none', 'shown', [fileCite()]), severity: 'medium' });
// An ordinary must-fix flow with a follow-up, its merge decided by the delegated role, and its merge
// step prepared (not dispatched).
async function prepared(t, flow = { policy: { mergeDecisionRole: 'orchestrator' } }, review = changeResult({ verdict: 'revise', findings: [noImpact()] })) {
  const f = await decisionFlow(t, flow);
  await f.build(); const reviewed = await f.review([review]); if (reviewed.route === 'defer') await f.effect(); await f.gate();
  return f;
}
const prepare = async f => { f.publishPR(); await f.engine.tick(); const attempt = f.store.need('attempt', f.current().attemptId); assert.equal(attempt.status, 'prepared'); assert.equal(attempt.step, 'merge'); return attempt; };
const restrict = (f, version = 0) => assert.equal(f.send('review.restrict', { operatorDisposition: 'all', expectedVersion: version, note: 'Fictional escape found before dispatch.' }).status, 'completed');

test('review fix (high): a restriction applied after the merge was prepared is refused at dispatch; the forge is never asked and the question opens again', async t => {
  const f = await prepared(t);
  assert.equal((await f.answer('merge', {}, { actor: 'orchestrator' })).status, 'completed');
  const attempt = await prepare(f), before = f.merges().length;
  restrict(f);
  await f.engine.step('flow-1');
  const fenced = f.store.need('attempt', attempt.id);
  assert.equal(fenced.status, 'not-dispatched', 'the prepared intent is never launched');
  assert.equal(fenced.costMicros, 0);
  assert.match(fenced.reason, /decision changed before dispatch: the review decision changed since the answer/);
  assert.equal(f.store.events(30).some(event => event.type === 'attempt.dispatching' && event.payload.attemptId === attempt.id), false);
  assert.deepEqual([f.current().step, f.current().attemptId, f.current().mergeAuthorization], ['decide', null, null]);
  assert.equal(f.current().refusedDecisions.at(-1).actor, 'orchestrator');
  // The question opens again under the restriction: the operator's own answer, with the acknowledgement.
  const item = await f.question();
  assert.deepEqual([item.role, item.reviewDecision.operator, item.reviewDecision.restriction.version], ['operator', true, 1]);
  assert.equal(f.merges().length, before, 'nothing was merged');
  assert.equal((await f.answer('merge', { acknowledgedFindings: acks(item.reviewDecision.acknowledgements) })).status, 'completed');
  assert.equal((await f.effect()).route, 'merged');
});

test('review fix (high): after a crash at the prepared boundary, the restarted engine takes the same path', async t => {
  const f = await prepared(t);
  assert.equal((await f.answer('merge', {}, { actor: 'orchestrator' })).status, 'completed');
  const attempt = await prepare(f), before = f.merges().length;
  restrict(f);
  // A new engine over the same store: nothing in memory from before the restart.
  const restarted = new Engine(f.store);
  await restarted.step('flow-1');
  assert.equal(f.store.need('attempt', attempt.id).status, 'not-dispatched');
  assert.equal(f.current().step, 'decide');
  await restarted.tick();
  assert.equal(f.store.all('inbox').find(row => row.flowId === 'flow-1' && row.kind === 'question' && row.status === 'open').reviewDecision.operator, true);
  assert.equal(f.merges().length, before);
});

test('review fix (high): the same holds for a strict merge and for an already-satisfied record', async t => {
  // Strict: the strict decision role signed; a restriction after preparation makes the operator required.
  const s = await prepared(t, { risk: 'strict', review: { strictFollowups: true }, policy: { strictDecisionRole: 'orchestrator' } }, changeResult({ verdict: 'revise', strict: true, findings: [noImpact()] }));
  const item = await s.question();
  assert.equal((await s.answer('merge', { reviewedHead: repositoryIdentity(s.root).head, acknowledgedFindings: acks(item.strictReview.acknowledgements) }, { actor: 'orchestrator' })).status, 'completed');
  const strictAttempt = await prepare(s);
  restrict(s);
  await s.engine.step('flow-1');
  assert.equal(s.store.need('attempt', strictAttempt.id).status, 'not-dispatched');
  assert.equal(s.current().step, 'decide');
  assert.equal((await s.question()).role, 'operator');
  // Already satisfied: the outcome record is refused the same way.
  const f = await decisionFlow(t, { risk: 'strict', protocol: 'bounded-delta', review: { strictFollowups: true }, satisfied: true, policy: { strictDecisionRole: 'orchestrator' } });
  f.targetIsHead();
  await f.review([changeResult({ strict: true, findings: [noImpact()] })]); await f.gate();
  const question = await f.question();
  assert.equal((await f.answer('accept', { reviewedHead: repositoryIdentity(f.root).head, acknowledgedFindings: acks(question.strictReview.acknowledgements) }, { actor: 'orchestrator' })).status, 'completed');
  await f.engine.tick();
  const record = f.store.need('attempt', f.current().attemptId);
  assert.deepEqual([record.status, record.step], ['prepared', 'satisfied-record']);
  restrict(f);
  await f.engine.step('flow-1');
  assert.equal(f.store.need('attempt', record.id).status, 'not-dispatched');
  assert.deepEqual([f.current().step, f.current().completionDecision], ['satisfied-decide', null]);
});

test('review fix (high): an unchanged decision dispatches as before, and the check reads only must-fix flows', async t => {
  const f = await prepared(t);
  assert.equal((await f.answer('merge', {}, { actor: 'orchestrator' })).status, 'completed');
  const attempt = await prepare(f);
  assert.equal(decisionDispatchRefusal(f.store, f.current(), attempt), null);
  await f.engine.step('flow-1');
  assert.equal(f.store.need('attempt', attempt.id).status, 'dispatching', 'nothing changed: dispatched');
  // A severity flow is never refused by it, whatever the restriction says.
  const severity = await decisionFlow(t, { bar: 'severity' });
  restrict(severity);
  assert.equal(decisionDispatchRefusal(severity.store, severity.current(), { step: 'merge', intent: { action: { operation: 'forge.merge' } } }), null);
});

test('review fix (high): an intent prepared under another restriction version is not dispatched even when the decision still matches', async t => {
  const f = await prepared(t);
  assert.equal((await f.answer('merge', {}, { actor: 'orchestrator' })).status, 'completed');
  const attempt = await prepare(f);
  // The intent's snapshot says version 3; the live state (and the decision) say none: re-prepared, not reopened.
  const refusal = decisionDispatchRefusal(f.store, f.current(), { ...attempt, intent: { ...attempt.intent, action: { ...attempt.intent.action, reviewRestriction: { version: 3, operatorDisposition: 'all' } } } });
  assert.deepEqual([refusal.reopen, /restriction changed since the step was prepared \(version 3 then, 0 now\)/.test(refusal.reason)], [false, true]);
});
