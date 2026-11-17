// Must-fix review, slice 3 (docs/designs/review-must-fix.md 15): the review ledger, later-round
// judgements with id matching and the legacy fallback, sameScenario, the in-fix rule, support of a
// reviewer's exclusion (confirmed only by a later review on a different model family), the mirrored
// priorFindingsDisposition, shadow route v3, and the omitted-judgement protocol check. A flow pinned to
// `must-fix` exists only in fixtures: configuration validation still refuses the setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { purposeOf } from './review-bar-scenarios.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runAction, LEDGER_PREPARATION_LIMITS } from '../starter/factory/workflows/dispatch.mjs';
import { recordReview } from '../starter/factory/core/delivery-review.mjs';
import { pinnedReviewSettings, validateReviewPolicy } from '../starter/factory/core/review-bar.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { validateSchema, validateSchemaDefinition, MUST_FIX_CHANGE_REVIEW_SCHEMA, SHADOW_LEDGER_CHANGE_REVIEW_SCHEMA, MUST_FIX_LEDGER_CHANGE_REVIEW_SCHEMA, LEDGER_JUDGEMENT_SCHEMA } from '../starter/factory/adapters/providers/index.mjs';
import { deriveFinding, SHADOW_V3_OMITS } from '../starter/factory/workflows/must-fix.mjs';
import { computeReviewLedger, ledgerContradictions, ledgerDigest, mirroredDispositions, replay, replayLedger, shadowRouteV3 } from '../starter/factory/workflows/review-ledger.mjs';
import { SHADOW_REVIEW_CALL } from '../starter/factory/operations/usage-accounting.mjs';

const ACCEPTANCE = ['Each record is read once', 'The reader reports a missing file'];
const FACTS = [{ id: 'single-host', fact: 'Each account runs the factory on one host.' }];
const ordinary = { level: 'ordinary', rationale: 'Bounded fictional change', threatModel: [], stopConditions: [] };
const strictAssessment = { level: 'strict', rationale: 'Fictional saved records', threatModel: ['Loss of fictional records'], stopConditions: ['Halt when integrity is unproven'] };
const cite = (kind, extra = {}) => ({ kind, ref: '-', quote: '', head: null, check: null, result: null, covers: 'The step where the wrong result appears', ...extra });
const fileCite = (quote = 'records are read once') => cite('file', { ref: 'input.txt', quote });
const finding = (message, purposeImpact, status, evidence = [], extra = {}) => ({ severity: 'high', file: 'input.txt', line: 1, message, scenario: `${message}: concrete inputs, path and wrong result.`, reachable: { status, evidence, coverage: evidence.length ? 'The cited reader path is the only one, and the evidence covers each step.' : '' }, purposeImpact, silent: false, origin: 'new-code', fixOf: null, ...extra });
const judge = (id, judgement, extra = {}) => ({ id, judgement, sameScenario: false, coverage: '', relevance: [], evidence: [], ...extra });
const changeResult = ({ verdict = 'pass', findings = [], ledger = [], strict = false, prior = [] } = {}) => ({ verdict, summary: `Fictional ${verdict} review`, findings, riskAssessment: strict ? strictAssessment : ordinary, strictReview: { fullDiffInspected: true, threatModelReviewed: strict, stopConditionsReviewed: strict }, scopeSummary: 'All', priorFindingsDisposition: prior, learningsChecked: [], purpose: purposeOf(ACCEPTANCE), ledger });
const FAMILY = { claude: 'anthropic', codex: 'openai' };
// A scripted reviewer: each call answers with the next result, as `provider` (and its family) unless the result says otherwise.
let session = 0;
const scripted = (results, provider, calls = []) => async (spec, options) => { calls.push({ spec, options }); const next = results.shift(); assert.ok(next, `no scripted answer for call ${calls.length}`); const { as = provider, result } = next.result ? next : { result: next }; return { provider: as, model: 'fictional', family: FAMILY[as], sessionId: `review-session-${++session}`, result: structuredClone(result) }; };

// A flow's change reviews run through the real dispatcher, round by round, each on a new candidate,
// recorded as the engine records them. Each round's result also runs through a severity flow, whose
// route is today's route for the same result.
function reviewRounds(t, { bar = 'shadow', risk = 'ordinary', review = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'fct-mf3-')), root = join(base, 'repo'); t.after(() => rmSync(base, { recursive: true, force: true }));
  mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fictional Evaluator']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'input.txt'), 'fictional baseline\n'); git(['add', '.']); git(['commit', '-qm', 'Fictional baseline']);
  const sourceHead = repositoryIdentity(root).head;
  const pinned = pinnedReviewSettings({ policy: { reviewBar: 'shadow', review: { environment: FACTS, ...review } } });
  const task = { id: 'task-1', title: 'Fictional reader', outcome: 'Fictional records are read once', acceptance: ACCEPTANCE, risk };
  const flow = { taskSnapshot: task, reviewHistory: [], results: { source: { head: sourceHead }, plan: { result: { summary: 'Pinned fictional plan', files: [], checks: [], risks: [] } } }, riskAssessments: [], effectiveRisk: risk, reviewBar: bar, reviewPolicy: pinned.reviewPolicy };
  const intent = (provider, reviewBar) => {
    const config = { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { reviewer: { provider, model: 'fictional' } }, policy: { reviewProtocol: 'fresh-full' }, context: { files: [], maxChars: 1000 } };
    const step = flow.reviewHistory.length ? 'delta-review' : 'review';
    return { cwd: root, timeoutMs: 600000, attemptId: `attempt-${flow.reviewHistory.length + 1}`, action: { operation: 'provider.review', step, binding: step, task, config, risk: { level: risk }, reviewHistory: flow.reviewHistory, reviewProtocol: 'fresh-full', results: flow.results, context: { files: [], digest: 'fictional-context' }, artifactDir: join(base, `artifacts-${flow.reviewHistory.length + 1}-${reviewBar}`), projectId: 'project-1', flowId: 'flow-1', ...(reviewBar === 'severity' ? {} : { reviewBar, reviewPolicy: pinned.reviewPolicy, reviewRecords: [] }), ...(reviewBar === 'must-fix' ? { mustFixBudget: { revise: { fits: true } } } : {}) } };
  };
  let edits = 0;
  // One round: a new candidate, then the review. `results`: the scripted answers in order.
  // `timeoutMs` and `options` (runAction's) apply to the reviewed flow's review only.
  async function round(results, { provider = 'claude', edit = true, calls = [], timeoutMs = null, options = {} } = {}) {
    if (edit) { writeFileSync(join(root, 'input.txt'), `records are read once\ncandidate ${++edits}\n`); git(['commit', '-qam', `Fictional candidate ${edits}`]); }
    const severity = await runAction(intent(provider, 'severity'), { providerInvoke: scripted([structuredClone(results[0])], provider) });
    const reviewed = intent(provider, bar); if (timeoutMs) reviewed.timeoutMs = timeoutMs;
    const review = await runAction(reviewed, { ...options, providerInvoke: scripted(structuredClone(results), provider, calls) });
    const step = flow.reviewHistory.length ? 'delta-review' : 'review';
    flow.results.review = review; recordReview(flow, step, review, `attempt-${flow.reviewHistory.length + 1}`);
    // A shadow flow's actual route is today's. A must-fix fixture routes by the must-fix bar (slice 4).
    if (bar === 'shadow') assert.deepEqual([review.route, review.disposition ?? null], [severity.route, severity.disposition ?? null], `round ${flow.reviewHistory.length}: the actual route is today's`);
    else assert.deepEqual([review.route, review.disposition], [review.mustFix.enforcement.route, review.mustFix.enforcement.disposition], `round ${flow.reviewHistory.length}: the must-fix route`);
    return review;
  }
  const entry = id => computeReviewLedger(flow).entries.find(row => row.id === id);
  return { root, flow, round, entry, head: () => repositoryIdentity(root).head };
}
const kinds = review => review.mustFix.findings.map(row => [row.id, row.kind, row.reason]);
const brief = entry => [entry.id, entry.kind, entry.status, entry.reason];

// ---- Schema ----

test('schema must-fix-3: the shadow change review adds ledger beside priorFindingsDisposition; the must-fix one replaces it', () => {
  for (const schema of [LEDGER_JUDGEMENT_SCHEMA, SHADOW_LEDGER_CHANGE_REVIEW_SCHEMA, MUST_FIX_LEDGER_CHANGE_REVIEW_SCHEMA]) assert.doesNotThrow(() => validateSchemaDefinition(schema));
  assert.deepEqual(Object.keys(SHADOW_LEDGER_CHANGE_REVIEW_SCHEMA.properties), [...Object.keys(MUST_FIX_CHANGE_REVIEW_SCHEMA.properties), 'ledger']);
  assert.ok(Object.hasOwn(SHADOW_LEDGER_CHANGE_REVIEW_SCHEMA.properties, 'priorFindingsDisposition'), 'today\'s routing reads it in a shadow flow');
  assert.ok(!Object.hasOwn(MUST_FIX_LEDGER_CHANGE_REVIEW_SCHEMA.properties, 'priorFindingsDisposition'), 'the factory writes it from the ledger');
  assert.deepEqual(validateSchema(changeResult({ ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] }), SHADOW_LEDGER_CHANGE_REVIEW_SCHEMA).ledger[0].id, 'R1.1');
  assert.throws(() => validateSchema(judge('R1.1', 'fixed'), LEDGER_JUDGEMENT_SCHEMA), /invalid enum/);
  assert.deepEqual(pinnedReviewSettings({ policy: { reviewBar: 'shadow' } }).reviewPolicy.schemas, { planReview: 'must-fix-2', review: 'must-fix-3', build: 'delivery-build' });
  assert.throws(() => validateReviewPolicy({ policy: { reviewBar: 'must-fix' } }), /must-fix is not available in this release/, 'must-fix stays refused');
});

// ---- Acceptance: later rounds and the in-fix rule ----

test('accepted when: the original fix holds and a corner case in that fix, with a different input, at round 3 with reasoning only, is a new in-fix finding that is not must-fix', async t => {
  for (const bar of ['shadow', 'must-fix']) {
    const r = reviewRounds(t, { bar });
    // Round 1: a shown outcome finding with a validated quote.
    const one = await r.round([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] })]);
    assert.deepEqual(kinds(one), [['R1.1', 'must-fix', 'outcome-shown']]);
    // Round 2: the same scenario still fails, with evidence: the entry stays open, so the estimate sends it back again.
    const two = await r.round([changeResult({ verdict: 'revise', ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] })]);
    assert.deepEqual(brief(r.entry('R1.1')), ['R1.1', 'must-fix', 'open', 'outcome-shown']);
    if (bar === 'shadow') assert.deepEqual([two.shadowRoute.version, two.shadowRoute.route], ['v3', 'revise'], 'v3 sees the earlier open item; v2 would have passed a review with no findings');
    // Round 3: the original fix holds; a corner case in that fix, with a different input, is reported with reasoning only.
    const corner = finding('A record split across two reads is read twice', 'outcome', 'shown', [cite('reasoning', { covers: 'The fix resets the offset only for whole records' })], { origin: 'in-fix', fixOf: 'R1.1' });
    // And one with a validated quote but no stated coverage, which the in-fix rule also reads as unknown.
    const uncovered = { ...finding('An empty read after the fix returns the last record', 'outcome', 'shown', [fileCite()], { origin: 'in-fix', fixOf: 'R1.1' }), reachable: { status: 'shown', evidence: [fileCite()], coverage: '' } };
    const three = await r.round([changeResult({ verdict: 'revise', findings: [corner, uncovered], ledger: [judge('R1.1', 'fix-holds')] })]);
    assert.deepEqual(brief(r.entry('R1.1')), ['R1.1', 'must-fix', 'fixed', 'outcome-shown'], 'the original is fix-holds');
    assert.deepEqual(kinds(three), [['R3.1', 'operator-item', 'unresolved-scenario'], ['R3.2', 'operator-item', 'unresolved-scenario']], 'new in-fix findings, not must-fix');
    assert.deepEqual(three.mustFix.findings.map(row => [row.origin, row.inFixRule, row.downgraded]), [['in-fix', true, 'reasoning-only'], ['in-fix', true, 'in-fix-evidence']]);
    assert.deepEqual([r.entry('R3.1').fixOf, r.entry('R3.1').origin], ['R1.1', 'in-fix']);
    assert.deepEqual(three.mustFix.ledger.applied, [{ id: 'R1.1', judgement: 'fix-holds', counted: true }]);
    if (bar === 'shadow') assert.deepEqual([three.shadowRoute.route, three.shadowRoute.disposition], ['defer', 'followup-required'], 'no builder round');
    if (bar === 'must-fix') assert.deepEqual(three.result.priorFindingsDisposition.map(row => [row.finding, row.disposition]), [['Records are read twice', 'fixed']], 'the mirrored disposition');
  }
  // Before round 3 the rule does not apply: the same uncovered finding with a validated quote is must-fix.
  const uncovered = { ...finding('An empty read after the fix returns the last record', 'outcome', 'shown', [fileCite()], { origin: 'in-fix', fixOf: 'R1.1' }), reachable: { status: 'shown', evidence: [fileCite()], coverage: '' } };
  const context = { files: new Map([['input.txt', 'records are read once\n']]), risk: 'ordinary' };
  assert.equal(deriveFinding(uncovered, { ...context, inFixEvidence: false }).kind, 'must-fix');
  assert.equal(deriveFinding(uncovered, { ...context, inFixEvidence: true }).kind, 'operator-item');
  assert.equal(deriveFinding({ ...uncovered, purposeImpact: 'none' }, { ...context, inFixEvidence: true }).kind, 'follow-up', 'no purpose impact: a follow-up');
  assert.equal(deriveFinding({ ...uncovered, origin: 'new-code' }, { ...context, inFixEvidence: true }).kind, 'must-fix', 'only in-fix findings');
  // policy.review.inFixEvidenceFrom moves the round.
  const late = reviewRounds(t, { review: { inFixEvidenceFrom: 4 } });
  await late.round([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] })]);
  await late.round([changeResult({ verdict: 'revise', ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] })]);
  const notYet = await late.round([changeResult({ verdict: 'revise', findings: [uncovered], ledger: [judge('R1.1', 'fix-holds')] })]);
  assert.deepEqual(kinds(notYet), [['R3.1', 'must-fix', 'outcome-shown']]);
});

test('accepted when: fix-incomplete without sameScenario is a contradiction; a must-fix review that repeats it parks, and the shadow records that', async t => {
  const r = reviewRounds(t, { bar: 'must-fix' });
  await r.round([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] })]);
  const different = changeResult({ verdict: 'revise', ledger: [judge('R1.1', 'fix-incomplete', { evidence: [fileCite()] })] });
  const calls = [], parked = await r.round([different, different], { calls });
  assert.equal(calls.length, 2, 'one correction review');
  assert.match(calls[1].spec.prompt, /ledger judges R1\.1 fix-incomplete without sameScenario: true; a failure that is not the original scenario, unchanged, is a new finding with origin in-fix and fixOf R1\.1/);
  assert.match(calls[1].spec.prompt, /Judge every ledger entry awaiting judgement exactly once/);
  assert.deepEqual([parked.route, parked.disposition], ['park', 'protocol-failure']);
  assert.deepEqual(r.entry('R1.1').judgements.map(row => [row.judgement, row.counted, row.why]), [['fix-incomplete', false, 'not-same-scenario']], 'not applied either');
  // In shadow, the same result keeps today's route; the estimate is the protocol failure.
  const s = reviewRounds(t);
  await s.round([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] })]);
  const shadowCalls = [], shadow = await s.round([different, different], { calls: shadowCalls });
  assert.deepEqual([shadow.route, shadow.shadowRoute.route, shadow.shadowRoute.disposition], ['revise', 'park', 'protocol-failure']);
  assert.equal(shadowCalls[1].spec.prompt.includes('fails the factory\'s protocol checks'), true);
  assert.deepEqual(shadow.providerInvocations.map(row => row.call ?? null), [null, SHADOW_REVIEW_CALL], 'the shadow\'s correction is the labelled, deadline-bounded call of slice 2');
  // The other ledger contradictions.
  const ledger = replayLedger(r.flow.reviewHistory.slice(0, 1), r.flow.reviewPolicy), presented = [{ entry: ledger.entries[0], awaits: ['fix'] }], view = { ledger, presented };
  const check = result => ledgerContradictions({ family: 'anthropic', result }, view);
  assert.deepEqual(check(changeResult({ ledger: [judge('R1.1', 'fix-holds')] })), []);
  assert.deepEqual(check(changeResult({ ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true })] })), ['ledger judges R1.1 fix-incomplete without evidence']);
  assert.deepEqual(check(changeResult({ ledger: [judge('R1.1', 'fix-holds'), judge('R1.1', 'fix-holds')] })), ['ledger judges R1.1 2 times instead of once']);
  assert.deepEqual(check(changeResult({ ledger: [judge('R1.1', 'fix-holds'), judge('R9.9', 'fix-holds')] })), ['ledger judges "R9.9", which is not a ledger entry']);
  assert.deepEqual(check(changeResult({ ledger: [judge('R1.1', 'deferral-accepted')] })), ['ledger judges R1.1 deferral-accepted, but no deferral of R1.1 awaits judgement']);
  assert.deepEqual(check(changeResult({ ledger: [judge('R1.1', 'exclusion-confirmed')] })), ['ledger judges R1.1 exclusion-confirmed, which does not apply to R1.1 (it can be judged fix-holds or fix-incomplete)']);
  assert.deepEqual(check(changeResult({ ledger: [judge('R1.1', 'fix-holds')], findings: [finding('Corner', 'outcome', 'unknown', [], { origin: 'in-fix', fixOf: 'R7.1' }), finding('Corner', 'outcome', 'unknown', [], { origin: 'in-fix' })] })), ['finding 1 has origin in-fix, but its fixOf "R7.1" names no ledger entry', 'finding 2 has origin in-fix, but its fixOf "null" names no ledger entry']);
});

test('accepted when: a protected-class in-fix finding in strict work still blocks, even with strictFollowups on and reasoning only at round 3', async t => {
  const r = reviewRounds(t, { risk: 'strict', review: { strictFollowups: true } });
  await r.round([changeResult({ verdict: 'revise', strict: true, findings: [finding('A stale build passes the gate', 'check-trust', 'shown', [fileCite()])] })]);
  await r.round([changeResult({ verdict: 'revise', strict: true, ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] })]);
  const trust = finding('A partial rebuild passes the gate on old output', 'check-trust', 'shown', [cite('reasoning')], { origin: 'in-fix', fixOf: 'R1.1' });
  const outcome = finding('A renamed record is read twice', 'outcome', 'shown', [cite('reasoning')], { origin: 'in-fix', fixOf: 'R1.1' });
  const three = await r.round([changeResult({ verdict: 'revise', strict: true, findings: [trust, outcome], ledger: [judge('R1.1', 'fix-holds')] })]);
  assert.deepEqual(kinds(three), [['R3.1', 'must-fix', 'protected-class'], ['R3.2', 'operator-item', 'unresolved-scenario']], 'unknown still blocks a protected class in strict work; an outcome finding does not');
  assert.deepEqual([three.shadowRoute.route, three.mustFix.risk], ['revise', 'strict']);
});

// ---- Acceptance: support of a reviewer's exclusion ----

test('accepted when: an exclusion citing a validated fact is unconfirmed and an operator item; the same family cannot confirm it; a different family can, which makes an outcome exclusion a follow-up', async t => {
  const r = reviewRounds(t);
  const excluded = (message, scenario) => ({ ...finding(message, 'outcome', 'not-here', [cite('environment', { ref: 'single-host', covers: 'Only one factory host exists for the account' })]), scenario });
  const twoProcesses = excluded('Two processes on one host race on the lock', 'Two factory processes on the same host take the lock at once and both write the record.');
  const twoHosts = excluded('Two machines with the same hostname share a checkout path', 'Two machines with the same hostname and checkout path on one account read each other\'s locks.');
  const one = await r.round([changeResult({ findings: [twoProcesses, twoHosts] })]);
  assert.deepEqual(one.mustFix.findings.map(row => [row.id, row.kind, row.reason, row.support, row.citations.join()]), [['R1.1', 'operator-item', 'unconfirmed-exclusion', 'unconfirmed', 'validated'], ['R1.2', 'operator-item', 'unconfirmed-exclusion', 'unconfirmed', 'validated']], 'the fact validates; that does not confirm the inference');
  assert.deepEqual(r.entry('R1.1').excludedBy, { provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: one.sessionId });
  // Round 2, same family: not shown as awaiting; its confirmations (one citing a passing check) do not count.
  const calls = [], record = cite('record', { ref: 'attempt-gate', head: r.head(), check: 'unit', result: 'passed', covers: 'The unit check passed' });
  const two = await r.round([changeResult({ ledger: [judge('R1.1', 'exclusion-confirmed', { coverage: 'One host per account rules this out', evidence: [record] }), judge('R1.2', 'exclusion-confirmed', { coverage: 'One host per account rules this out' })] })], { calls });
  assert.doesNotMatch(calls[0].spec.prompt, /Ledger entries awaiting your judgement/, 'nothing awaits a same-family review');
  assert.deepEqual(two.mustFix.protocol.contradictions, [], 'judging an entry that does not await judgement is allowed');
  assert.deepEqual(two.mustFix.ledger.applied, [{ id: 'R1.1', judgement: 'exclusion-confirmed', counted: false, why: 'same-family' }, { id: 'R1.2', judgement: 'exclusion-confirmed', counted: false, why: 'same-family' }]);
  for (const id of ['R1.1', 'R1.2']) assert.deepEqual([r.entry(id).kind, r.entry(id).reason, r.entry(id).support], ['operator-item', 'unconfirmed-exclusion', 'unconfirmed']);
  // Round 3, a different family in a fresh session: shown both, must judge both.
  const three = [], omitted = changeResult({ ledger: [judge('R1.2', 'exclusion-confirmed', { coverage: 'Hostnames are unique per account under the declared single host' })] });
  const answered = await r.round([omitted, changeResult({ ledger: [judge('R1.1', 'exclusion-confirmed', { coverage: '' }), judge('R1.2', 'exclusion-confirmed', { coverage: 'With one host per account no second machine exists, so no two machines can share a hostname and checkout path.' })] })], { provider: 'codex', calls: three });
  assert.match(three[0].spec.prompt, /Ledger entries awaiting your judgement: \[\{"id":"R1\.1","raisedInRound":1,"awaits":\["exclusion"\],"judgements":\["exclusion-confirmed","exclusion-rejected"\]/);
  assert.match(three[0].spec.prompt, /"excludedByFamily":"anthropic"/);
  assert.deepEqual(answered.mustFix.protocol.contradictions, ['ledger omits a judgement of R1.1, which awaits judgement (an exclusion to confirm or reject)'], 'an omitted judgement is a contradiction');
  assert.deepEqual(answered.mustFix.ledger.applied, [{ id: 'R1.1', judgement: 'exclusion-confirmed', counted: false, why: 'no-coverage' }, { id: 'R1.2', judgement: 'exclusion-confirmed', counted: true }]);
  // The two-processes exclusion stays unconfirmed: an operator item, never a plain follow-up.
  assert.deepEqual([r.entry('R1.1').kind, r.entry('R1.1').reason, r.entry('R1.1').support], ['operator-item', 'unconfirmed-exclusion', 'unconfirmed']);
  // The confirmed outcome exclusion is a follow-up, with a new claim digest.
  assert.deepEqual([r.entry('R1.2').kind, r.entry('R1.2').reason, r.entry('R1.2').support, r.entry('R1.2').confirmedBy.family], ['follow-up', 'supported-exclusion', 'supported', 'openai']);
  assert.notEqual(r.entry('R1.2').claimDigest, one.mustFix.findings[1].claimDigest);
  assert.equal(one.shadowRoute.route, 'defer', 'round 1 would have recorded both as operator items');
  assert.deepEqual([answered.route, answered.shadowRoute.route], ['pass', 'pass'], 'already recorded, so nothing new to defer; the actual route is today\'s');
  // Rejected by any later review: derived again as unknown.
  const rejected = reviewRounds(t);
  await rejected.round([changeResult({ findings: [twoProcesses] })]);
  await rejected.round([changeResult({ ledger: [judge('R1.1', 'exclusion-rejected', { evidence: [cite('reasoning', { covers: 'The fact is about hosts, not processes' })] })] })]);
  assert.deepEqual([rejected.entry('R1.1').kind, rejected.entry('R1.1').reason, rejected.entry('R1.1').reachable.read], ['operator-item', 'unresolved-scenario', 'unknown']);
});

test('support: only a different family in a fresh session, shown the entry, confirms; a provider fallback to the author\'s family is not asked to confirm; a strict protected exclusion stays the operator\'s', () => {
  const head = 'a'.repeat(40), other = 'b'.repeat(40), third = 'c'.repeat(40), policy = pinnedReviewSettings({ policy: { reviewBar: 'shadow', review: { environment: FACTS, strictFollowups: true } } }).reviewPolicy;
  const exclusion = { ...finding('Two processes on one host race', 'outcome', 'not-here', [cite('environment', { ref: 'single-host' })]) };
  const derived = (f, risk = 'ordinary') => ({ id: 'R1.1', ...deriveFinding(f, { facts: new Set(['single-host']), risk }) });
  const row = (n, h, result, reviewer, expectedFamily, mustFixFindings = [], risk = 'ordinary') => ({ step: 'review', identity: { head: h }, result, mustFix: { round: n, basis: 'original', risk, findings: mustFixFindings, reviewer, ledger: { expectedFamily, citations: (result.ledger ?? []).map(() => []) } } });
  const anthropic = { provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: 's1' }, openai = { provider: 'codex', model: 'fictional', family: 'openai', sessionId: 's2' };
  const confirm = changeResult({ ledger: [judge('R1.1', 'exclusion-confirmed', { coverage: 'Covers the whole scenario' })] });
  const first = row(1, head, changeResult({ findings: [exclusion] }), anthropic, 'anthropic', [derived(exclusion)]);
  const after = rows => replayLedger(rows, policy).entries[0];
  assert.deepEqual([after([first, row(2, other, confirm, openai, 'openai')]).kind, after([first, row(2, other, confirm, openai, 'openai')]).support], ['follow-up', 'supported']);
  // Expected on the author's family, answered by another (a fallback): it was not shown the entry, so it does not count.
  assert.deepEqual(after([first, row(2, other, confirm, openai, 'anthropic')]).judgements.map(j => j.why), ['not-awaiting']);
  // Expected on another family, answered by the author's (a fallback): same family.
  assert.deepEqual(after([first, row(2, other, confirm, anthropic, 'openai')]).judgements.map(j => j.why), ['same-family']);
  // The same session cannot confirm its own exclusion.
  assert.deepEqual(after([first, row(2, other, confirm, { ...openai, sessionId: 's1' }, 'openai')]).judgements.map(j => j.why), ['same-session']);
  // A contradicted citation in the confirmation does not count.
  const contradicted = row(2, other, confirm, openai, 'openai'); contradicted.mustFix.ledger.citations = [['not-found']];
  assert.deepEqual(after([first, contradicted]).judgements.map(j => j.why), ['contradicted']);
  // The omission check: a fallback to the author's family is not required to judge the exclusion.
  const ledger = replayLedger([first], policy), presented = [{ entry: ledger.entries[0], awaits: ['exclusion'] }];
  assert.deepEqual(ledgerContradictions({ family: 'anthropic', result: changeResult() }, { ledger, presented }), []);
  assert.equal(ledgerContradictions({ family: 'openai', result: changeResult() }, { ledger, presented }).length, 1);
  // Strict work with strictFollowups: a protected exclusion confirmed by another family is an operator item only the operator may accept.
  const leak = finding('A token is logged by a second process', 'security', 'not-here', [cite('environment', { ref: 'single-host' })]);
  const strictFirst = row(1, head, changeResult({ findings: [leak], strict: true }), anthropic, 'anthropic', [derived(leak, 'strict')], 'strict');
  assert.deepEqual([strictFirst.mustFix.findings[0].kind, strictFirst.mustFix.findings[0].reason], ['must-fix', 'protected-class'], 'unconfirmed: it blocks');
  const strictAfter = replayLedger([strictFirst, row(2, other, confirm, openai, 'openai', [], 'strict')], policy).entries[0];
  assert.deepEqual([strictAfter.kind, strictAfter.reason, strictAfter.operatorOnly], ['operator-item', 'protected-exclusion', true]);
  // Nothing becomes confirmed without a judgement: a third round on the author's family leaves it as it was.
  assert.equal(after([first, row(2, other, changeResult(), anthropic, 'anthropic'), row(3, third, changeResult(), anthropic, 'anthropic')]).support, 'unconfirmed');
});

// ---- Ids, the legacy fallback, purpose entries and the mirror ----

test('id matching with the legacy fallback: a legacy finding is judged by id, by its exact message, or through today\'s priorFindingsDisposition', () => {
  const policy = pinnedReviewSettings({ policy: { reviewBar: 'shadow' } }).reviewPolicy, h1 = 'a'.repeat(40), h2 = 'b'.repeat(40);
  const old = { severity: 'high', file: 'input.txt', line: 1, message: 'Concrete defect' };
  const raised = { step: 'review', identity: { head: h1 }, result: { ...changeResult({ verdict: 'revise' }), findings: [old] }, mustFix: { basis: 'original', risk: 'ordinary', findings: [{ id: 'R1.1', bar: 'legacy', kind: 'must-fix', reason: 'legacy-severity' }], ledger: { expectedFamily: 'anthropic', citations: [] } } };
  const later = result => ({ step: 'delta-review', identity: { head: h2 }, result, mustFix: { basis: 'original', risk: 'ordinary', findings: [], ledger: { expectedFamily: 'anthropic', citations: (result.ledger ?? []).map(() => []) } } });
  const entry = result => replayLedger([raised, later(result)], policy).entries[0];
  assert.deepEqual([entry(changeResult({ ledger: [judge('R1.1', 'fix-holds')] })).status, entry(changeResult({ ledger: [judge('R1.1', 'fix-holds')] })).judgements[0].via], ['fixed', 'id']);
  assert.deepEqual([entry(changeResult({ ledger: [judge('Concrete defect', 'fix-holds')] })).status, entry(changeResult({ ledger: [judge('Concrete defect', 'fix-holds')] })).judgements[0].via], ['fixed', 'legacy-message']);
  const viaOld = entry(changeResult({ prior: [{ finding: 'Concrete defect', disposition: 'fixed', evidence: 'input.txt line 1' }] }));
  assert.deepEqual([viaOld.status, viaOld.judgements[0].via], ['fixed', 'legacy-disposition']);
  assert.equal(entry(changeResult({ prior: [{ finding: 'Concrete defect', disposition: 'remaining', evidence: 'still there' }] })).status, 'open');
  assert.equal(entry(changeResult({ prior: [{ finding: 'Concrete defect', disposition: 'fixed', evidence: ' ' }] })).status, 'fixed-claimed', 'no evidence: not judged');
  // The protocol check accepts the legacy path for a legacy entry, and only for one.
  const ledger = replayLedger([raised], policy), presented = [{ entry: ledger.entries[0], awaits: ['fix'] }];
  assert.deepEqual(ledgerContradictions({ family: 'anthropic', result: changeResult({ prior: [{ finding: 'Concrete defect', disposition: 'fixed', evidence: 'input.txt line 1' }] }) }, { ledger, presented }), []);
  assert.equal(ledgerContradictions({ family: 'anthropic', result: changeResult() }, { ledger, presented }).length, 1);
  // The mirror, for a must-fix review: judged entries by message, and the previous review's unjudged findings as remaining.
  assert.deepEqual(mirroredDispositions(ledger, changeResult({ ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true, coverage: 'Still writes twice' })] }), 2), [{ finding: 'Concrete defect', disposition: 'remaining', evidence: 'R1.1 fix-incomplete (same scenario): Still writes twice' }]);
  assert.deepEqual(mirroredDispositions(ledger, changeResult(), 2), [{ finding: 'Concrete defect', disposition: 'remaining', evidence: 'R1.1 was not judged in round 2: it is open (must-fix, legacy-severity)' }]);
});

test('purpose entries are settled by the next purpose assessment; an unchanged candidate claims no fix; v3 records operator items once', () => {
  const policy = pinnedReviewSettings({ policy: { reviewBar: 'shadow' } }).reviewPolicy, h1 = 'a'.repeat(40), h2 = 'b'.repeat(40);
  const row = (h, findings, route, result = changeResult()) => ({ step: 'review', identity: { head: h }, result, mustFix: { basis: 'original', risk: 'ordinary', findings, ledger: { expectedFamily: 'anthropic', citations: [] } }, ...(route ? { shadowRoute: { route } } : {}) });
  const unmet = [{ id: 'R1.1', bar: 'must-fix', kind: 'must-fix', reason: 'unmet-acceptance', added: true }];
  assert.deepEqual(replayLedger([row(h1, unmet, 'revise'), row(h2, [], 'pass')], policy).entries.map(brief), [['R1.1', 'must-fix', 'fixed', 'unmet-acceptance']]);
  assert.deepEqual(replayLedger([row(h1, unmet, 'revise'), row(h2, [{ ...unmet[0], id: 'R2.1' }], 'revise')], policy).entries.map(entry => [entry.id, entry.status, entry.supersededBy ?? null]), [['R1.1', 'superseded', 'R2.1'], ['R2.1', 'open', null]]);
  // Same head: the open must-fix entry is not a claimed fix and awaits nothing.
  const mustFix = [{ id: 'R1.1', bar: 'must-fix', kind: 'must-fix', reason: 'outcome-shown', reachable: { reported: 'shown', read: 'shown' }, citations: ['validated'] }];
  const same = replayLedger([row(h1, mustFix, 'revise'), row(h1, [], null)], policy);
  assert.equal(same.entries[0].status, 'open');
  assert.deepEqual(shadowRouteV3(same, { strict: false }), { route: 'revise', disposition: 'correct' }, 'still open');
  // An operator item is recorded by the shadow route that would have deferred it, then no longer reopens a defer.
  const item = [{ id: 'R1.1', bar: 'must-fix', kind: 'operator-item', reason: 'unresolved-scenario', reachable: { reported: 'unknown', read: 'unknown' }, citations: [] }];
  assert.deepEqual(shadowRouteV3(replayLedger([row(h1, item, null)], policy), { strict: false }).route, 'defer');
  assert.deepEqual(shadowRouteV3(replayLedger([row(h1, item, 'defer'), row(h2, [], null)], policy), { strict: false }).route, 'pass');
  // A strict full phase never defers (7.3): it goes to the delta review with the items still in the ledger.
  assert.deepEqual(shadowRouteV3(replayLedger([row(h1, item, null)], policy), { strict: true, bounded: true, phase: 'full' }).route, 'delta');
  assert.deepEqual(shadowRouteV3(replayLedger([row(h1, item, null)], policy), { strict: false }, { failure: true }), { route: 'park', disposition: 'protocol-failure' });
});

// ---- Through the engine ----

// A rehearsal flow with two change reviews: `review` (revise to `again`) and `again`, each parking to a
// question; `gate` is the merge question, so `review` has a correction cycle (design 9.5).
async function twoReviews(t, bar, { reviewer = 'claude' } = {}) {
  const f = sandbox(t);
  // The reference review timeout, so ledger preparation has time to read the changed paths.
  const effect = (operation, next, edges) => ({ kind: 'effect', action: { operation }, timeoutMs: 600000, next, onFailure: 'failed', preserveInput: true, evidence: 'review', resultEdges: edges });
  const workflow = { version: 1, start: 'review', nodes: { review: effect('provider.review', 'gate', { pass: 'gate', revise: 'again', defer: 'gate', park: 'review-question' }), again: effect('provider.review', 'gate', { pass: 'gate', revise: 'gate', defer: 'gate', park: 'review-question' }), gate: { kind: 'question', role: 'operator', question: 'Fictional merge question', mergeDecision: true, answers: { stop: 'done' } }, done: { kind: 'end', outcome: 'completed' }, 'review-question': { kind: 'question', role: 'operator', question: 'Fictional park question', answers: { stop: 'failed' } }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { reviewer: { provider: reviewer, model: 'fictional' } }, policy: { planning: false, ...(bar === 'severity' ? {} : { reviewBar: 'shadow', review: { environment: FACTS } }) }, context: { files: [], maxChars: 1000 } });
  f.command('task.put', { task: { id: f.task.id, title: 'Fictional reader', acceptance: ACCEPTANCE, risk: 'ordinary' } });
  f.start();
  const flow = f.store.need('flow', 'flow-1'); flow.results.source = { head: repositoryIdentity(f.root).head }; if (bar === 'must-fix') flow.reviewBar = 'must-fix'; f.store.put('flow', flow);
  const edit = n => { writeFileSync(join(f.root, 'input.txt'), `records are read once\ncandidate ${n}\n`); execFileSync('git', ['commit', '-qam', `Fictional candidate ${n}`], { cwd: f.root }); };
  const settle = async (results, calls) => { await f.engine.tick(); const attempt = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId); const review = await runAction(attempt.intent, { providerInvoke: scripted(results, reviewer, calls) }); f.engine.settle('flow-1', attempt, { exitCode: 0, reason: null, costMicros: 0, actionResult: review }); return review; };
  return { ...f, edit, settle, flow: () => f.store.need('flow', 'flow-1') };
}

test('accepted when: an omitted ledger judgement is a contradiction: one correction, then a must-fix review parks and mints no evidence; shadow keeps today\'s route; the stored ledger equals a recomputation', async t => {
  const first = changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] });
  const silent = changeResult(); // a pass with no findings that judges nothing
  // Must-fix fixture.
  const f = await twoReviews(t, 'must-fix');
  f.edit(1); await f.settle([first]);
  assert.equal(f.flow().step, 'again');
  f.edit(2);
  const calls = [], parked = await f.settle([silent, silent], calls);
  assert.equal(calls.length, 2);
  assert.match(calls[0].spec.prompt, /\nLedger entries awaiting your judgement: \[\{"id":"R1\.1","raisedInRound":1,"awaits":\["fix"\],"judgements":\["fix-holds","fix-incomplete"\],"status":"fixed-claimed"[^\n]*"pathsChangedSince":\["input\.txt"\]\}\]\n/);
  assert.ok(calls[0].spec.prompt.indexOf('Ledger entries awaiting') < calls[0].spec.prompt.indexOf('Trusted diff:'), 'before the diff');
  assert.match(calls[0].spec.prompt, /Judge earlier findings in ledger, by id; the factory writes priorFindingsDisposition from those judgements\./);
  assert.equal(calls[0].spec.schema, MUST_FIX_LEDGER_CHANGE_REVIEW_SCHEMA);
  assert.deepEqual(parked.mustFix.protocol.contradictions, ['ledger omits a judgement of R1.1, which awaits judgement (a claimed fix)']);
  assert.deepEqual([parked.route, parked.disposition], ['park', 'protocol-failure']);
  let flow = f.flow();
  assert.deepEqual([flow.step, flow.evidence.review], ['review-question', undefined], 'parked, no review evidence');
  assert.deepEqual(flow.reviewLedger, computeReviewLedger(flow), 'the stored ledger equals a recomputation');
  assert.equal(ledgerDigest(flow.reviewLedger), flow.reviewHistory.at(-1).mustFix.ledger.digest, 'and the ledger the review computed');
  assert.deepEqual(flow.reviewLedger.entries.map(brief), [['R1.1', 'must-fix', 'fixed-claimed', 'outcome-shown']]);
  // Shadow.
  const s = await twoReviews(t, 'shadow');
  s.edit(1); await s.settle([first]);
  s.edit(2);
  const shadowCalls = [], shadow = await s.settle([silent, silent], shadowCalls);
  assert.equal(shadowCalls.length, 2);
  assert.equal(shadowCalls[0].spec.schema, SHADOW_LEDGER_CHANGE_REVIEW_SCHEMA);
  assert.match(shadowCalls[0].spec.prompt, /Report priorFindingsDisposition for every finding in the immediately previous review/, 'today\'s request is kept');
  assert.deepEqual([shadow.route, shadow.shadowRoute.route, shadow.shadowRoute.disposition], ['pass', 'park', 'protocol-failure']);
  assert.deepEqual(shadow.shadowRoute.omits, [...SHADOW_V3_OMITS]);
  flow = s.flow();
  assert.deepEqual([flow.step, Boolean(flow.evidence.review)], ['gate', true], 'today\'s route and evidence');
  assert.deepEqual(flow.reviewLedger, computeReviewLedger(flow));
  assert.equal(ledgerDigest(flow.reviewLedger), flow.reviewHistory.at(-1).mustFix.ledger.digest);
  assert.deepEqual(flow.reviewHistory.at(-1).result, silent, 'the reviewer\'s result is recorded as returned');
  // A complete judgement in shadow: the estimate passes, and the flow and its ledger agree.
  const ok = await twoReviews(t, 'shadow');
  ok.edit(1); await ok.settle([first]); ok.edit(2);
  const passed = await ok.settle([changeResult({ ledger: [judge('R1.1', 'fix-holds')], prior: [{ finding: 'Records are read twice', disposition: 'fixed', evidence: 'input.txt line 1' }] })]);
  assert.deepEqual([passed.route, passed.shadowRoute.route], ['pass', 'pass']);
  assert.deepEqual(passed.mustFix.ledger.priorFindingsDisposition, [{ finding: 'Records are read twice', disposition: 'fixed', evidence: 'R1.1 fix-holds: no evidence cited' }], 'the mirror is recorded beside the reviewer\'s own disposition');
  assert.deepEqual(ok.flow().reviewLedger.entries.map(brief), [['R1.1', 'must-fix', 'fixed', 'outcome-shown']]);
  assert.deepEqual(ok.flow().reviewLedger, computeReviewLedger(ok.flow()));
});

test('engine: a stored ledger that cannot be computed is recorded as its error and never fails the settlement', async t => {
  const s = await twoReviews(t, 'shadow');
  s.edit(1); await s.settle([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] })]);
  const flow = s.flow(); flow.reviewHistory[0].mustFix.findings = 5; s.store.put('flow', flow);
  s.edit(2);
  const review = await s.settle([changeResult()]);
  assert.equal(review.route, 'pass');
  assert.deepEqual([s.flow().step, Boolean(s.flow().evidence.review)], ['gate', true], 'today\'s route and evidence');
  assert.match(s.flow().reviewLedger.error, /filter is not a function|not iterable/);
});

test('a severity flow stores no ledger; a shadow flow carried over from dev.99 (schema must-fix-2) keeps shadow v2 with no ledger', async t => {
  const f = await twoReviews(t, 'severity');
  f.edit(1); await f.settle([{ ...changeResult({ verdict: 'revise', findings: [{ severity: 'high', file: 'input.txt', line: 1, message: 'Old shape' }] }), purpose: undefined, ledger: undefined }]);
  assert.equal(Object.hasOwn(f.flow(), 'reviewLedger'), false);
  const s = await twoReviews(t, 'shadow');
  const pinned = s.flow(); pinned.reviewPolicy = { ...pinned.reviewPolicy, schemas: { planReview: 'must-fix-2', review: 'must-fix-2', build: 'delivery-build' } }; s.store.put('flow', pinned);
  s.edit(1);
  const calls = [], v2 = await s.settle([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] })], calls);
  assert.equal(calls[0].spec.schema, MUST_FIX_CHANGE_REVIEW_SCHEMA, 'the schema it pinned');
  assert.doesNotMatch(calls[0].spec.prompt, /Ledger/);
  assert.match(calls[0].spec.prompt, /fixOf: null\./);
  assert.equal(v2.shadowRoute.version, 'v2');
  assert.equal(Object.hasOwn(v2.mustFix, 'ledger'), false);
  assert.equal(Object.hasOwn(s.flow(), 'reviewLedger'), false);
});

test('a shadow review whose ledger cannot be built keeps today\'s route and result, and records the failure as its estimate', async t => {
  const r = reviewRounds(t);
  await r.round([changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] })]);
  // A history row the replay cannot read (an entry whose finding has an unreadable message).
  r.flow.reviewHistory[0].mustFix.findings = 5;
  const review = await r.round([changeResult()]);
  assert.deepEqual([review.route, review.disposition], ['pass', 'accepted']);
  assert.match(review.shadowRoute.error, /the review ledger could not be built/);
  assert.equal(review.shadowRoute.version, 'v3');
});

test('the replay is pure: the ledger depends only on the history rows, in order, and survives a JSON round trip', () => {
  const policy = pinnedReviewSettings({ policy: { reviewBar: 'shadow' } }).reviewPolicy;
  const rows = [{ step: 'review', identity: { head: 'a'.repeat(40) }, result: changeResult({ findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] }), mustFix: { basis: 'original', risk: 'ordinary', findings: [{ id: 'R1.1', bar: 'must-fix', kind: 'must-fix', reason: 'outcome-shown', reachable: { reported: 'shown', read: 'shown' }, citations: ['validated'] }], reviewer: { provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: 's1' }, ledger: { expectedFamily: 'anthropic', citations: [] } }, shadowRoute: { route: 'revise' } }];
  const once = replay(rows, policy).ledger;
  assert.deepEqual(JSON.parse(JSON.stringify(once)), once);
  assert.deepEqual(replayLedger(structuredClone(rows), policy), once);
  assert.deepEqual(computeReviewLedger({ reviewHistory: rows, reviewPolicy: policy }), once);
  assert.deepEqual(rows[0].mustFix.findings[0].citations, ['validated'], 'the history is not changed');
});

test('configuration: must-fix is still refused with a ledger-pinned shadow project', () => {
  assert.throws(() => validateConfig({ mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: {}, policy: { reviewBar: 'must-fix' } }), /must-fix is not available in this release/);
});

// ---- Review of slice 3 ----

// A git on PATH whose `diff --name-only` (the ledger's changed paths) is slow, or fails.
function slowLedgerDiff(t, root, { delay = 2.2, fail = false } = {}) {
  const shim = mkdtempSync(join(tmpdir(), 'fct-shim-')), real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(shim, 'git'), `#!/bin/bash\nif [[ "$*" == *"diff --name-only -z --no-renames "*" HEAD --" ]]; then ${fail ? 'exit 3' : `sleep ${delay}`}; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
  const prior = process.env.PATH; process.env.PATH = `${shim}:${prior}`;
  t.after(() => { process.env.PATH = prior; rmSync(shim, { recursive: true, force: true }); });
}

test('review fix 1: ledger preparation never costs a shadow review its time: skipped when time is short, bounded otherwise, and a failure is recorded', async t => {
  const r = reviewRounds(t), raised = changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] });
  await r.round([raised]);
  slowLedgerDiff(t, r.root);
  // A 12-second attempt with a 2.2-second diff: severity succeeds, and so does shadow, without the paths.
  const calls = [], short = await r.round([changeResult({ ledger: [judge('R1.1', 'fix-holds')] })], { timeoutMs: 12000, calls });
  assert.deepEqual([short.route, short.shadowRoute.route], ['pass', 'pass']);
  assert.deepEqual(short.mustFix.ledger.preparation, { paths: 1, skipped: 'deadline' });
  assert.match(calls[0].spec.prompt, /"pathsChangedSince":null/);
  assert.equal(LEDGER_PREPARATION_LIMITS.reserveMs, 120000);
  // With time to spare the read is bounded: the review starts once the bound runs out.
  const s = reviewRounds(t);
  await s.round([raised]);
  const started = Date.now(), bounded = await s.round([changeResult({ ledger: [judge('R1.1', 'fix-holds')] })], { options: { ledgerPreparationLimits: { maxMs: 300, reserveMs: 0 } } });
  assert.ok(Date.now() - started < 2000, 'the review did not wait for the slow diff');
  assert.deepEqual([bounded.route, bounded.mustFix.ledger.preparation], ['pass', { paths: 1, skipped: 'deadline' }]);
});

test('review fix 1: a failing ledger diff is recorded as skipped and the review proceeds; a fast one fills in the paths', async t => {
  const r = reviewRounds(t), raised = changeResult({ verdict: 'revise', findings: [finding('Records are read twice', 'outcome', 'shown', [fileCite()])] });
  await r.round([raised]);
  const calls = [], fast = await r.round([changeResult({ ledger: [judge('R1.1', 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] })], { calls });
  assert.deepEqual(fast.mustFix.ledger.preparation, { paths: 1 });
  assert.match(calls[0].spec.prompt, /"pathsChangedSince":\["input\.txt"\]/);
  slowLedgerDiff(t, r.root, { fail: true });
  const failed = await r.round([changeResult({ ledger: [judge('R1.1', 'fix-holds')] })]);
  assert.deepEqual([failed.route, failed.mustFix.ledger.preparation.skipped], ['pass', 'failed']);
});

test('review fix 2: a legacy message two findings share settles neither; each needs a judgement by id', () => {
  const policy = pinnedReviewSettings({ policy: { reviewBar: 'shadow' } }).reviewPolicy, h1 = 'a'.repeat(40), h2 = 'b'.repeat(40);
  const old = file => ({ severity: 'high', file, line: 1, message: 'Missing authorization check' });
  const raised = { step: 'review', identity: { head: h1 }, result: { ...changeResult({ verdict: 'revise' }), findings: [old('read.mjs'), old('delete.mjs')] }, mustFix: { basis: 'original', risk: 'ordinary', findings: [1, 2].map(n => ({ id: `R1.${n}`, bar: 'legacy', kind: 'must-fix', reason: 'legacy-severity' })), ledger: { expectedFamily: 'anthropic', citations: [] } } };
  const later = result => ({ step: 'delta-review', identity: { head: h2 }, result, mustFix: { basis: 'original', risk: 'ordinary', findings: [], ledger: { expectedFamily: 'anthropic', citations: (result.ledger ?? []).map(() => []) } } });
  const oneFixed = changeResult({ prior: [{ finding: 'Missing authorization check', disposition: 'fixed', evidence: 'read.mjs now checks authorization' }] });
  const after = replayLedger([raised, later(oneFixed)], policy);
  assert.deepEqual(after.entries.map(entry => [entry.id, entry.status, entry.judgements.length]), [['R1.1', 'fixed-claimed', 0], ['R1.2', 'fixed-claimed', 0]], 'neither is settled');
  assert.deepEqual(shadowRouteV3(after, { strict: false }), { route: 'revise', disposition: 'correct' });
  const ledger = replayLedger([raised], policy), presented = ledger.entries.map(entry => ({ entry, awaits: ['fix'] })), view = { ledger, presented };
  assert.deepEqual(ledgerContradictions({ family: 'anthropic', result: oneFixed }, view), ['ledger omits a judgement of R1.1, which awaits judgement (a claimed fix)', 'ledger omits a judgement of R1.2, which awaits judgement (a claimed fix)']);
  // A ledger judgement naming the shared message is ambiguous too.
  assert.deepEqual(ledgerContradictions({ family: 'anthropic', result: changeResult({ ledger: [judge('Missing authorization check', 'fix-holds')] }) }, view).at(0), 'ledger judges "Missing authorization check", which is the message of 2 legacy entries; judge each by its id');
  // By id, each is settled on its own.
  const byId = replayLedger([raised, later(changeResult({ ledger: [judge('R1.1', 'fix-holds'), judge('R1.2', 'fix-incomplete', { sameScenario: true, evidence: [fileCite()] })] }))], policy);
  assert.deepEqual(byId.entries.map(entry => [entry.id, entry.status]), [['R1.1', 'fixed'], ['R1.2', 'open']]);
  assert.deepEqual(ledgerContradictions({ family: 'anthropic', result: changeResult({ ledger: [judge('R1.1', 'fix-holds'), judge('R1.2', 'fix-holds')] }) }, view), []);
});
