// Must-fix review, slice 4 (docs/designs/review-must-fix.md 9.5, 9.2, 6.2 and 15), through the
// engine: the cap, the correction cycle and the budget check with send_back semantics, the
// unchanged-candidate exemption, a second deferral reaching the build question, rows at settlement,
// and flow.disposeFinding with its authority rules. Every step runs through the real dispatcher with
// scripted providers and is settled by the engine; a flow pinned to `must-fix` exists only in
// fixtures (configuration validation still refuses the setting).
//
// The engine also launches its supervisor for each step it dispatches. Those processes find only
// stand-in provider commands on PATH that exit at once, so no provider session can start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { purposeOf } from './review-bar-scenarios.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { computeReviewLedger } from '../starter/factory/workflows/review-ledger.mjs';

const stand = mkdtempSync(join(tmpdir(), 'fct-mf4-bin-'));
for (const name of ['claude', 'codex']) { writeFileSync(join(stand, name), '#!/bin/sh\necho "fictional provider: not available in tests" >&2\nexit 1\n'); chmodSync(join(stand, name), 0o755); }
process.env.PATH = `${stand}${delimiter}${process.env.PATH}`;
process.on('exit', () => rmSync(stand, { recursive: true, force: true }));

const ACCEPTANCE = ['Each record is read once', 'The reader reports a missing file'];
const FACTS = [{ id: 'single-host', fact: 'Each account runs the factory on one host.' }];
const ordinaryAssessment = { level: 'ordinary', rationale: 'Bounded fictional change', threatModel: [], stopConditions: [] };
const strictAssessment = { level: 'strict', rationale: 'Fictional saved records', threatModel: ['Loss of fictional records'], stopConditions: ['Halt when integrity is unproven'] };
const cite = (kind, extra = {}) => ({ kind, ref: '-', quote: '', head: null, check: null, result: null, covers: 'The step where the wrong result appears', ...extra });
const fileCite = (quote = 'records are read once') => cite('file', { ref: 'input.txt', quote });
const finding = (message, purposeImpact, status, evidence = [], extra = {}) => ({ severity: 'high', file: 'input.txt', line: 1, message, scenario: `${message}: concrete inputs, path and wrong result.`, reachable: { status, evidence, coverage: evidence.length ? 'The cited reader path is the only one, and the evidence covers each step.' : '' }, purposeImpact, silent: false, origin: 'new-code', fixOf: null, ...extra });
const judge = (id, judgement, extra = {}) => ({ id, judgement, sameScenario: false, coverage: '', relevance: [], evidence: [], ...extra });
const changeResult = ({ verdict = 'pass', findings = [], ledger = [], strict = false } = {}) => ({ verdict, summary: `Fictional ${verdict} review`, findings, riskAssessment: strict ? strictAssessment : ordinaryAssessment, strictReview: { fullDiffInspected: true, threatModelReviewed: strict, stopConditionsReviewed: strict }, scopeSummary: 'All', learningsChecked: [], purpose: purposeOf(ACCEPTANCE), ledger });
const defer = (id, evidence, extra = {}) => ({ id, disposition: 'deferred', reason: 'cant-happen-here', evidence, coverage: 'The cited guard is on the only path the scenario takes.', note: '', ...extra });
const buildResult = (status, findingDispositions) => ({ status, summary: `Fictional ${status} build`, departures: [], unverified: [], pushback: [], questions: [], assumptions: [], learningsApplied: [], findingDispositions });
const receipt = actionResult => ({ exitCode: 0, reason: null, costMicros: 0, actionResult });
let session = 0;
const scripted = (results, calls = []) => async spec => { calls.push(spec); const result = results.shift(); assert.ok(result, `no scripted answer for call ${calls.length}`); return { provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: `session-${++session}`, result: structuredClone(result) }; };
const instruction = { principal: 'operator', instruction: 'Settle the fictional finding as discussed.' };

// A rehearsal flow on a graph with the reference correction loop: build (maxVisits = maxBuildRounds,
// its first visit the initial build) to review; review revises to build, defers or passes to the
// merge question, parks to the review question (send_back to build); a blocked build goes to the
// build question (retry). The cycle of `review` is build, review; its path to the merge question is decide.
async function cycleFlow(t, { risk = 'ordinary', review = {}, bar = 'must-fix', buildVisits = 4, reviewVisits = 7 } = {}) {
  const f = sandbox(t);
  const effect = (operation, next, extra) => ({ kind: 'effect', action: { operation }, timeoutMs: 600000, next, onFailure: 'failed', ...extra });
  const workflow = { version: 1, maxTransitions: 100, start: 'build', nodes: {
    build: effect('provider.build', 'review', { maxVisits: buildVisits, resultEdges: { implemented: 'review', blocked: 'build-question' } }),
    'build-question': { kind: 'question', role: 'operator', question: 'The builder is blocked. Inspect the retained result before retrying.', answers: { retry: 'build', stop: 'failed' } },
    review: effect('provider.review', 'decide', { preserveInput: true, evidence: 'review', maxVisits: reviewVisits, resultEdges: { pass: 'decide', revise: 'build', delta: 'review', defer: 'decide', adjudicate: 'decide', park: 'review-question' } }),
    'review-question': { kind: 'question', role: 'operator', question: 'Fictional review question', answers: { send_back: 'build', stop: 'failed' } },
    decide: { kind: 'question', role: 'operator', question: 'Fictional merge question', mergeDecision: true, answers: { stop: 'done' } },
    done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { builder: { provider: 'claude', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { planning: false, ...(bar === 'severity' ? {} : { reviewBar: 'shadow', review: { environment: FACTS, ...review } }) }, context: { files: [], maxChars: 1000 } });
  f.command('task.put', { task: { id: f.task.id, title: 'Fictional reader', outcome: 'Fictional records are read once', acceptance: ACCEPTANCE, risk } });
  f.start();
  // A must-fix flow is a fixture: the configuration cannot pin it.
  const flow = f.store.need('flow', 'flow-1'); flow.results.source = { head: repositoryIdentity(f.root).head }; if (bar === 'must-fix') flow.reviewBar = 'must-fix'; f.store.put('flow', flow);
  let edits = 0;
  const current = () => f.store.need('flow', 'flow-1');
  const run = async invoke => {
    await f.engine.tick();
    const flow = current(); assert.ok(flow.attemptId, `no attempt at ${flow.step} (${flow.state}): ${flow.stopReason ?? ''}`);
    const attempt = f.store.need('attempt', flow.attemptId), out = await runAction(attempt.intent, { providerInvoke: invoke });
    f.engine.settle('flow-1', attempt, receipt(out)); return out;
  };
  const build = (dispositions = [], { edit = true, status = 'implemented' } = {}) => run(async () => {
    if (edit) { writeFileSync(join(f.root, 'input.txt'), `records are read once\ncandidate ${++edits}\n`); execFileSync('git', ['commit', '-qam', `Fictional candidate ${edits}`], { cwd: f.root }); }
    return { provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: `builder-${++session}`, result: buildResult(status, dispositions) };
  });
  const reviewWith = (results, calls = []) => run(scripted(structuredClone(results), calls));
  const question = async () => { await f.engine.tick(); return f.store.all('inbox').find(item => item.flowId === 'flow-1' && item.kind === 'question' && item.status === 'open'); };
  const answer = async (choice, note) => { const item = await question(); assert.ok(item, `no open question at ${current().step}`); return f.command('answer', { inboxId: item.id, answer: choice, version: item.version, subjectDigest: item.subjectDigest, ...(note ? { note } : {}) }); };
  const send = (operation, payload, extra = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), operation, payload, actor: 'orchestrator', ...extra });
  return { ...f, current, build, review: reviewWith, question, answer, send };
}
const open = (strict = false) => changeResult({ verdict: 'revise', strict, findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] });
const incomplete = (id = 'R1.1', strict = false) => changeResult({ verdict: 'revise', strict, ledger: [judge(id, 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] });

test('accepted when: with maxBuildRounds 4 and mustFixRounds 3, the review after the third correction parks (must-fix-cap)', async t => {
  const f = await cycleFlow(t, { review: { mustFixRounds: 3 } });
  await f.build(); // build visit 1: the initial build
  assert.equal((await f.review([open()])).route, 'revise');
  for (const correction of [2, 3]) { await f.build(); const review = await f.review([incomplete()]); assert.deepEqual([review.route, review.mustFix.enforcement.cap.used], ['revise', correction - 1], `correction ${correction} is sent back`); }
  await f.build(); // build visit 4: the third correction
  const review = await f.review([incomplete()]);
  assert.deepEqual([review.route, review.disposition, review.mustFix.enforcement.cap], ['park', 'must-fix-cap', { rounds: 3, allowance: 0, reviews: 3, used: 3, limit: 3 }]);
  const flow = f.current();
  assert.deepEqual([flow.step, flow.visits.build, flow.reviewHistory.length], ['review-question', 4, 4]);
  assert.equal(flow.evidence.review, undefined, 'a park mints no review evidence');
});

test('accepted when: after send_back one more correction runs, and the next review with an open must-fix item parks rather than attempting a build visit that is not available', async t => {
  const f = await cycleFlow(t, { review: { mustFixRounds: 3 } });
  await f.build(); await f.review([open()]);
  for (let n = 0; n < 3; n++) { await f.build(); await f.review([incomplete()]); }
  assert.equal(f.current().step, 'review-question');
  // "One more round": send_back with its note. It extends the exhausted build bound by one and grants one send-back.
  assert.equal((await f.answer('send_back', 'One more correction for the fictional reader.')).status, 'completed');
  let flow = f.current();
  assert.deepEqual([flow.step, flow.mustFixAllowance, flow.limitExtensions.build, flow.visits.build], ['build', 1, 1, 5]);
  await f.build(); // the one more correction: build visit 5 of 4 + 1
  const review = await f.review([incomplete()]);
  assert.deepEqual([review.route, review.disposition], ['park', 'must-fix-cap'], 'the allowance is used: it parks again');
  assert.deepEqual([review.mustFix.enforcement.cap.used, review.mustFix.enforcement.cap.limit], [4, 4]);
  assert.deepEqual([review.mustFix.enforcement.budget.fits, review.mustFix.enforcement.budget.short], [false, [{ step: 'build', needed: 1, left: 0 }]], 'and no build visit is left for it');
  flow = f.current();
  assert.deepEqual([flow.step, flow.visits.build, f.store.all('attempt').filter(row => row.step === 'build').length], ['review-question', 5, 5], 'no build visit beyond the bound was attempted');
  assert.ok(!flow.stopReason?.includes('visit bound exhausted'));
});

test('accepted when: a build-question retry that used a build visit makes the review park with reason budget one round earlier', async t => {
  const f = await cycleFlow(t, { review: { mustFixRounds: 3 } });
  await f.build(); await f.review([open()]);
  await f.build([], { edit: false, status: 'blocked' }); // build visit 2: blocked
  assert.equal(f.current().step, 'build-question');
  assert.equal((await f.answer('retry', 'Fictional guidance for the retry.')).status, 'completed');
  await f.build(); // build visit 3
  assert.equal((await f.review([incomplete()])).route, 'revise');
  await f.build(); // build visit 4
  const review = await f.review([incomplete()]);
  assert.deepEqual([review.route, review.disposition, review.mustFix.enforcement.reason], ['park', 'budget', 'budget']);
  assert.deepEqual([review.mustFix.enforcement.cap.used, review.mustFix.enforcement.cap.limit], [2, 3], 'below the cap');
  assert.deepEqual(review.mustFix.enforcement.budget.short, [{ step: 'build', needed: 1, left: 0 }]);
  assert.deepEqual([f.current().step, f.current().visits.build], ['review-question', 4]);
});

test('accepted when: a strict send_back whose correction cycle cannot fit is refused; the same ordinary send_back is accepted', async t => {
  for (const risk of ['strict', 'ordinary']) {
    const strict = risk === 'strict', f = await cycleFlow(t, { risk, review: { mustFixRounds: 3 }, reviewVisits: 4 });
    await f.build(); await f.review([open(strict)]);
    for (let n = 0; n < 3; n++) { await f.build(); await f.review([incomplete('R1.1', strict)]); }
    const before = f.current();
    assert.deepEqual([before.step, before.visits.review, before.visits.build], ['review-question', 4, 4], risk);
    const answered = await f.answer('send_back', 'One more correction for the fictional reader.');
    if (strict) {
      assert.equal(answered.status, 'rejected');
      assert.match(answered.error, /send_back is refused: one more must-fix correction cycle cannot fit this flow even after send_back extends its exhausted bounds \(no visit left at review \(0 left, 1 needed\)\); strict review nodes are not extended by send_back\. Stop the flow, or replan/);
      const after = f.current();
      assert.deepEqual([after.step, after.mustFixAllowance, after.limitExtensions, after.transitions], [before.step, before.mustFixAllowance, before.limitExtensions, before.transitions], 'nothing changed');
      assert.equal((await f.answer('stop')).status, 'completed', 'stop stays available');
    } else {
      assert.equal(answered.status, 'completed');
      assert.deepEqual([f.current().limitExtensions.review, f.current().limitExtensions.build, f.current().mustFixAllowance], [1, 1, 1]);
    }
  }
});

test('the unchanged-candidate exemption (9.2): every open item deferred, the unchanged candidate is reviewed again for the deferrals only; a second deferral of a contested finding reaches the build question', async t => {
  const f = await cycleFlow(t);
  await f.build(); await f.review([open()]);
  await f.build([defer('R1.1', [fileCite()])], { edit: false });
  let flow = f.current();
  assert.deepEqual([flow.step, flow.state, flow.deferralExemptions], ['review', 'ready', ['R1.1']], 'reviewed again instead of stopping');
  const calls = [], review = await f.review([changeResult({ verdict: 'revise', ledger: [judge('R1.1', 'deferral-rejected', { evidence: [fileCite()] })] })], calls);
  assert.match(calls[0].prompt, /The candidate is unchanged since review round 1: the builder deferred every open must-fix item instead of changing it\. This review judges only the deferrals awaiting your judgement/);
  assert.equal(review.route, 'revise');
  assert.equal(computeReviewLedger(f.current()).entries[0].status, 'contested');
  // The builder defers the contested finding again: refused, so the build is blocked and reaches the build question.
  await f.build([defer('R1.1', [fileCite()])], { edit: false });
  flow = f.current();
  assert.deepEqual([flow.step, flow.results.build.route, flow.results.build.deferralRefusals], ['build-question', 'blocked', [{ id: 'R1.1', refusal: 'is contested: its deferral was rejected, so it must be fixed, or the build returns blocked for the operator' }]]);
  const item = await f.question();
  assert.match(JSON.stringify(item), /The factory refused the builder's deferral: R1\.1 is contested/);
  // An unchanged candidate claimed as fixed still stops for explicit recovery, as today.
  const g = await cycleFlow(t);
  await g.build(); await g.review([open()]);
  await g.build([], { edit: false });
  assert.deepEqual([g.current().state, g.current().resumeStep], ['stopped', 'build']);
  assert.match(g.current().stopReason, /Builder returned the unchanged reviewed candidate after revision was required/);
});

test('rows at settlement (6.2): operator items and follow-ups become review rows in the same transaction, at most maxFollowupsPerFlow, the overflow counted; an operator item is the operator\'s alone', async t => {
  const f = await cycleFlow(t, { review: { maxFollowupsPerFlow: 1 } });
  await f.build();
  const review = await f.review([changeResult({ findings: [finding('A record split across reads may repeat', 'outcome', 'unknown'), finding('The loop could be shorter', 'none', 'shown', [fileCite()])] })]);
  assert.equal(review.route, 'defer');
  const flow = f.current(), rows = f.store.all('finding').filter(row => row.source === 'review');
  assert.equal(flow.step, 'decide');
  assert.deepEqual(rows.map(row => [row.ledgerId, row.status, row.reviewKind, row.reason, row.needs, row.flowId]), [['R1.1', 'unapproved', 'operator-item', 'unresolved-scenario', 'operator', 'flow-1']]);
  assert.deepEqual(flow.reviewRowOverflow, { count: 1, ids: ['R1.2'], max: 1 });
  assert.match(rows[0].title, /^R1\.1 operator-item \(unresolved-scenario\): A record split across reads may repeat/);
  // Only the operator may act on an operator item's row, under any instruction.
  const refused = f.send('finding.resolve', { findingId: rows[0].id, expectedVersion: 1, disposition: 'declined', reason: 'Fictional' }, { onBehalfOf: instruction });
  assert.match(refused.error, /finding\.resolve on a review operator item is the operator's alone/);
  // A shadow flow, with the same results, records no rows and keeps today's route.
  const s = await cycleFlow(t, { bar: 'shadow' });
  await s.build();
  const shadow = await s.review([changeResult({ findings: [finding('A record split across reads may repeat', 'outcome', 'unknown')] })]);
  assert.deepEqual([shadow.route, shadow.shadowRoute.route, s.current().step], ['revise', 'defer', 'build'], 'today\'s revise; the estimate defers');
  assert.equal(s.store.all('finding').filter(row => row.source === 'review').length, 0);
});

test('flow.disposeFinding (9.5): by version; operator-required by a delegated orchestrator on an ordinary outcome item only; operator-accepted and protected classes are the operator\'s alone', async t => {
  const f = await cycleFlow(t);
  await f.build(); await f.review([open()]);
  await f.build([defer('R1.1', [fileCite()])]);
  // Rejected by reasoning alone, a supported deferral is disputed: an operator item, no further round.
  const review = await f.review([changeResult({ ledger: [judge('R1.1', 'deferral-rejected', { evidence: [cite('reasoning')] })] })]);
  assert.equal(review.route, 'defer');
  let entry = computeReviewLedger(f.current()).entries[0];
  assert.deepEqual([entry.kind, entry.reason, f.current().step], ['operator-item', 'disputed', 'decide']);
  const dispose = (disposition, extra = {}) => ({ flowId: 'flow-1', findingId: 'R1.1', disposition, note: 'Fictional disposition', expectedVersion: entry.version, ...extra });
  assert.match(f.command('flow.disposeFinding', dispose('operator-required', { expectedVersion: entry.version - 1 })).error, /ledger entry R1\.1 changed since you read it/);
  assert.match(f.send('flow.disposeFinding', dispose('operator-required')).error, /operator authority required/, 'no instruction');
  assert.match(f.send('flow.disposeFinding', dispose('operator-accepted'), { onBehalfOf: instruction }).error, /a delegated orchestrator may record only operator-required/);
  const required = f.send('flow.disposeFinding', dispose('operator-required'), { onBehalfOf: instruction });
  assert.equal(required.status, 'completed', required.error);
  const flow = f.current();
  entry = flow.reviewLedger.entries[0];
  assert.deepEqual([entry.kind, entry.status, entry.operatorDispositions.map(row => [row.disposition, row.actor])], ['must-fix', 'operator-required', [['operator-required', 'orchestrator']]]);
  assert.deepEqual(flow.reviewLedger, computeReviewLedger(flow), 'the stored ledger equals a recomputation');
  assert.deepEqual(flow.operatorFindingDispositions.map(row => [row.id, row.afterRound, row.onBehalfOf?.principal]), [['R1.1', 2, 'operator']]);
  // A protected-class item: the orchestrator is refused even operator-required; the operator accepts it.
  const p = await cycleFlow(t);
  await p.build();
  await p.review([changeResult({ findings: [finding('A token may be logged', 'security', 'unknown')] })]);
  const item = computeReviewLedger(p.current()).entries[0];
  assert.deepEqual([item.kind, item.reason, item.operatorOnly], ['operator-item', 'protected-class', true]);
  const payload = disposition => ({ flowId: 'flow-1', findingId: 'R1.1', disposition, note: 'Fictional disposition', expectedVersion: item.version });
  assert.match(p.send('flow.disposeFinding', payload('operator-required'), { onBehalfOf: instruction }).error, /protected-class item are the operator's alone|every protected-class item are the operator's alone/);
  assert.equal(p.command('flow.disposeFinding', payload('operator-accepted')).status, 'completed');
  const accepted = p.current().reviewLedger.entries[0];
  assert.deepEqual([accepted.kind, accepted.status], ['follow-up', 'operator-accepted']);
  const row = p.store.all('finding').find(r => r.source === 'review' && r.ledgerId === 'R1.1');
  assert.deepEqual([row.reviewKind, row.operatorAccepted, row.status], ['follow-up', true, 'unapproved']);
  // Not a must-fix flow: refused.
  const s = await cycleFlow(t, { bar: 'shadow' });
  assert.match(s.command('flow.disposeFinding', payload('operator-accepted')).error, /has no must-fix review ledger/);
});
