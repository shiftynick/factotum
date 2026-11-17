// Must-fix review, slice 1 (docs/designs/review-must-fix.md 15): schemas, factory ids, citation
// validation, the derivation of 4.3, legacy handling, policy.reviewBar with the shadow, pinning, and
// the severity identity golden. Slice 2 (purpose first, protocol checks, shadow v2) changed what a
// shadow review asks and records; its own tests are in review-must-fix-protocol.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox } from './helpers.mjs';
import { captureReviewScenarios, goldenView, purposeOf, SCENARIOS, SCENARIO_ACCEPTANCE } from './review-bar-scenarios.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { validateConfig, configDigest, changeWorkflow, documentWorkflow } from '../starter/factory/core/configuration.mjs';
import { authorityPolicy } from '../starter/factory/core/authority-policy.mjs';
import { pinnedReviewSettings, flowReviewBar, validateReviewPolicy } from '../starter/factory/core/review-bar.mjs';
import { validateSchema, validateSchemaDefinition, REVIEW_SCHEMA, RISK_REVIEW_SCHEMA, CHANGE_REVIEW_SCHEMA, CITATION_SCHEMA, MUST_FIX_FINDING_SCHEMA, MUST_FIX_PLAN_REVIEW_SCHEMA, MUST_FIX_CHANGE_REVIEW_SCHEMA, PURPOSE_SCHEMA } from '../starter/factory/adapters/providers/index.mjs';
import { citationStatus, citableRecords, deriveFinding, deriveReview, exclusionSupport, findingId, mustFixShaped, reviewFindingIds, shadowPlanRouteV1, shadowRouteV1, SHADOW_V2_OMITS } from '../starter/factory/workflows/must-fix.mjs';

const golden = JSON.parse(readFileSync(new URL('./fixtures/review-severity-golden.json', import.meta.url), 'utf8'));
const HEAD = 'a'.repeat(40), OTHER = 'b'.repeat(40);
const cite = (kind, extra = {}) => ({ kind, ref: '-', quote: '', head: null, check: null, result: null, covers: 'The step where the wrong result appears', ...extra });
const fileCite = (quote = 'records are read once', ref = 'src/reader.js') => cite('file', { ref, quote });
const recordCite = (extra = {}) => cite('record', { ref: 'attempt-gate', head: HEAD, check: 'unit', result: 'passed', ...extra });
const finding = (purposeImpact, status, evidence = [], extra = {}) => ({ severity: 'medium', file: 'src/reader.js', line: 3, message: `A ${purposeImpact} ${status} finding`, scenario: 'Two readers open the same record file; the second reads a stale offset and returns the first record twice.', reachable: { status, evidence, coverage: evidence.length ? 'The cited code is the only reader path, and it has no offset reset.' : '' }, purposeImpact, silent: false, origin: 'new-code', fixOf: null, ...extra });
const context = { claimHead: HEAD, files: new Map([['src/reader.js', 'function read() {\n  // records   are read\n  once\n}\n'], ['src/missing.js', null]]), facts: new Set(['single-host']), records: new Map([['attempt-gate', { head: HEAD, checks: { route: 'pass', unit: 'passed' } }], ['attempt-old', { head: OTHER, checks: { route: 'pass', unit: 'passed' } }]]) };
const derive = (row, extra = {}) => deriveFinding(row, { ...context, risk: 'ordinary', ...extra });
const kindOf = (row, extra) => { const d = derive(row, extra); return [d.kind, d.reason]; };

test('the must-fix schemas keep every current field, pass validateSchemaDefinition and accept a full finding', () => {
  for (const schema of [CITATION_SCHEMA, MUST_FIX_FINDING_SCHEMA, PURPOSE_SCHEMA, MUST_FIX_PLAN_REVIEW_SCHEMA, MUST_FIX_CHANGE_REVIEW_SCHEMA]) assert.equal(validateSchemaDefinition(schema), schema);
  // Schema version must-fix-2 adds the purpose assessment (slice 2) beside every current field.
  assert.deepEqual(Object.keys(MUST_FIX_PLAN_REVIEW_SCHEMA.properties), [...Object.keys(RISK_REVIEW_SCHEMA.properties), 'purpose']);
  assert.deepEqual(Object.keys(MUST_FIX_CHANGE_REVIEW_SCHEMA.properties), [...Object.keys(CHANGE_REVIEW_SCHEMA.properties), 'purpose']);
  const base = REVIEW_SCHEMA.properties.findings.items;
  for (const [key, value] of Object.entries(base.properties)) assert.deepEqual(MUST_FIX_FINDING_SCHEMA.properties[key], value);
  assert.deepEqual(MUST_FIX_FINDING_SCHEMA.required, Object.keys(MUST_FIX_FINDING_SCHEMA.properties));
  assert.equal(MUST_FIX_FINDING_SCHEMA.additionalProperties, false);
  const full = finding('check-trust', 'shown', [fileCite(), cite('environment', { ref: 'single-host' }), recordCite(), cite('reasoning')], { fixOf: 'R1.2', origin: 'in-fix' });
  assert.equal(validateSchema(full, MUST_FIX_FINDING_SCHEMA), full);
  const review = { verdict: 'revise', summary: 'Fictional', findings: [full], riskAssessment: { level: 'ordinary', rationale: 'Fictional', threatModel: [], stopConditions: [] }, strictReview: { fullDiffInspected: true, threatModelReviewed: false, stopConditionsReviewed: false }, scopeSummary: 'All', priorFindingsDisposition: [], learningsChecked: [], purpose: purposeOf(['Correct']) };
  assert.equal(validateSchema(review, MUST_FIX_CHANGE_REVIEW_SCHEMA), review);
  const { purpose, ...withoutPurpose } = review;
  assert.throws(() => validateSchema(withoutPurpose, MUST_FIX_CHANGE_REVIEW_SCHEMA), /purpose: required/);
  // The bounds of 5.1: at most four citations, a scenario of 1 to 1200 characters, a closed purpose impact.
  assert.throws(() => validateSchema({ ...full, reachable: { ...full.reachable, evidence: Array(5).fill(fileCite()) } }, MUST_FIX_FINDING_SCHEMA), /array length/);
  assert.throws(() => validateSchema({ ...full, scenario: '' }, MUST_FIX_FINDING_SCHEMA), /invalid length/);
  assert.throws(() => validateSchema({ ...full, purposeImpact: 'style' }, MUST_FIX_FINDING_SCHEMA), /invalid enum/);
  assert.throws(() => validateSchema({ ...full, reachable: { ...full.reachable, evidence: [{ ...fileCite(), covers: '' }] } }, MUST_FIX_FINDING_SCHEMA), /covers: invalid length/);
  // An old-shape finding is not in the must-fix shape.
  assert.throws(() => validateSchema({ severity: 'high', file: 'a', line: 1, message: 'old' }, MUST_FIX_FINDING_SCHEMA), /scenario: required/);
});

test('factory ids are R<round>.<index>; legacy history rows get stable ids from their position', () => {
  assert.equal(findingId(2, 2), 'R2.3'); assert.equal(findingId(1, 0, 'P'), 'P1.1');
  const derived = deriveReview([finding('none', 'unknown'), { severity: 'low', file: '', line: 0, message: 'Old shape' }], { ...context, round: 3, risk: 'ordinary' });
  assert.deepEqual(derived.findings.map(row => row.id), ['R3.1', 'R3.2']);
  const legacyRow = message => ({ attemptId: `attempt-${message}`, step: 'review', result: { findings: [{ severity: 'high', file: 'a', line: 1, message }, { severity: 'low', file: 'a', line: 2, message: `${message} too` }] } });
  const flow = { reviewHistory: [legacyRow('first'), legacyRow('second')] };
  const before = reviewFindingIds(flow);
  assert.deepEqual(before.map(row => row.findings.map(f => [f.id, f.bar])), [[['R1.1', 'legacy'], ['R1.2', 'legacy']], [['R2.1', 'legacy'], ['R2.2', 'legacy']]]);
  // Reading again, or after more rows, gives the same ids: nothing is stored or migrated.
  flow.reviewHistory.push(legacyRow('third'));
  assert.deepEqual(reviewFindingIds(flow).slice(0, 2), before);
  assert.deepEqual(reviewFindingIds(structuredClone(flow)), reviewFindingIds(flow));
  assert.equal(flow.reviewHistory[0].result.findings[0].id, undefined, 'no id is written into a recorded result');
});

test('citation validation: file quotes at the reviewed head, declared facts, and records bound to this flow, candidate, check and result', () => {
  const status = row => citationStatus(row, context);
  assert.equal(status(fileCite()), 'validated', 'whitespace is collapsed, as the knowledge-upkeep validator does');
  assert.equal(status(fileCite('records are written twice')), 'not-found');
  assert.equal(status(fileCite('anything', 'src/missing.js')), 'not-found', 'no such file at the head');
  assert.equal(status(fileCite('anything', 'src/unread.js')), 'not-checkable', 'a file that could not be read');
  assert.equal(status(fileCite('')), 'not-checkable', 'nothing quoted');
  for (const ref of ['/etc/passwd', '../outside.js', 'src/../../outside.js', 'src\\reader.js']) assert.equal(status(fileCite('records', ref)), 'not-found', ref);
  assert.equal(status(fileCite('records are read once', './src//reader.js')), 'validated', 'a path is normalised before it is read');
  assert.equal(status(cite('environment', { ref: 'single-host' })), 'validated');
  assert.equal(status(cite('environment', { ref: 'two-hosts' })), 'unknown-ref');
  assert.equal(status(recordCite()), 'validated');
  assert.equal(status(recordCite({ check: 'route', result: 'pass' })), 'validated');
  assert.equal(status(recordCite({ check: 'lint' })), 'unknown-ref', 'a check the record does not have');
  assert.equal(status(recordCite({ result: 'failed' })), 'unknown-ref', 'a result other than the recorded one');
  assert.equal(status(recordCite({ result: null })), 'unknown-ref');
  assert.equal(status(recordCite({ ref: 'attempt-old', head: OTHER })), 'stale', 'a passing record for another candidate');
  assert.equal(status(recordCite({ head: OTHER })), 'stale', 'the record is not at the head it is cited for');
  assert.equal(status(recordCite({ ref: 'attempt-old' })), 'stale', 'cited for the reviewed head, but recorded at another');
  assert.equal(status(recordCite({ head: null })), 'unknown-ref');
  assert.equal(status(recordCite({ ref: 'attempt-of-another-flow' })), 'unknown-ref', 'not a record of this flow');
  assert.equal(status(cite('reasoning')), 'not-checkable');
  // Records are a flow's settled attempts, at the head the engine verified before dispatch.
  const records = citableRecords([
    { id: 'b', step: 'gate', status: 'passed', createdAt: '2026-01-02', intent: { inputIdentity: { head: HEAD } }, receipt: { actionResult: { route: 'pass', checks: [{ id: 'unit', status: 'passed' }] } } },
    { id: 'a', step: 'review', status: 'failed', createdAt: '2026-01-01', intent: { inputIdentity: { head: OTHER } }, receipt: { actionResult: { route: 'revise' } } },
    { id: 'c', step: 'build', status: 'prepared', createdAt: '2026-01-03', intent: { inputIdentity: { head: HEAD } } },
  ]);
  assert.deepEqual(records, [{ id: 'a', step: 'review', head: OTHER, checks: { route: 'revise' } }, { id: 'b', step: 'gate', head: HEAD, checks: { route: 'pass', unit: 'passed' } }]);
});

test('support status of a reviewer exclusion (11.3)', () => {
  assert.equal(exclusionSupport(['validated'], 'covers it'), 'unconfirmed', 'a validated citation is not a confirmed claim');
  assert.equal(exclusionSupport(['validated'], 'covers it', { confirmed: true }), 'supported');
  assert.equal(exclusionSupport(['validated'], '  '), 'existence-only');
  assert.equal(exclusionSupport(['not-checkable', 'unknown-ref'], 'covers it'), 'unsupported');
  assert.equal(exclusionSupport(['validated', 'stale'], 'covers it', { confirmed: true }), 'contradicted');
});

test('every row of the 4.3 table', () => {
  const shown = [fileCite()], excluded = [cite('environment', { ref: 'single-host' })];
  const strict = { risk: 'strict', strictFollowups: true };
  for (const risk of [{ risk: 'ordinary' }, strict]) {
    assert.deepEqual(kindOf(finding('outcome', 'shown', shown), risk), ['must-fix', 'outcome-shown'], 'any, outcome, shown');
    assert.deepEqual(kindOf(finding('outcome', 'unknown'), risk), ['operator-item', 'unresolved-scenario'], 'any, outcome, unknown');
    assert.deepEqual(kindOf(finding('outcome', 'not-here', excluded), { ...risk, confirmed: true }), ['follow-up', 'supported-exclusion'], 'any, outcome, not-here, supported');
    assert.deepEqual(kindOf(finding('outcome', 'not-here', excluded), risk), ['operator-item', 'unconfirmed-exclusion'], 'any, outcome, not-here, not yet confirmed');
    assert.deepEqual(kindOf(finding('outcome', 'not-here', [cite('reasoning')]), risk), ['operator-item', 'unsupported-exclusion'], 'any, outcome, not-here, unsupported');
    assert.deepEqual(kindOf(finding('outcome', 'not-here', [fileCite('not in the file')]), risk), ['operator-item', 'unsupported-exclusion'], 'a contradicted exclusion is not supported');
    assert.deepEqual(kindOf({ ...finding('outcome', 'not-here', excluded), reachable: { status: 'not-here', evidence: excluded, coverage: '' } }, risk), ['operator-item', 'unsupported-exclusion'], 'existence only');
    assert.deepEqual(kindOf(finding('none', 'shown', shown), risk), ['follow-up', 'purpose-none'], 'any, none, any');
    assert.deepEqual(kindOf(finding('none', 'not-here'), risk), ['follow-up', 'purpose-none']);
  }
  for (const impact of ['security', 'data-loss', 'spending', 'check-trust']) {
    assert.deepEqual(kindOf(finding(impact, 'shown', shown), strict), ['must-fix', 'protected-class'], `strict, ${impact}, shown`);
    assert.deepEqual(kindOf(finding(impact, 'unknown'), strict), ['must-fix', 'protected-class'], `strict, ${impact}, unknown`);
    const protectedExclusion = derive(finding(impact, 'not-here', excluded), { ...strict, confirmed: true });
    assert.deepEqual([protectedExclusion.kind, protectedExclusion.reason, protectedExclusion.operatorOnly], ['operator-item', 'protected-exclusion', true], `strict, ${impact}, not-here, supported: the operator's own acceptance only`);
    assert.deepEqual(kindOf(finding(impact, 'not-here', [cite('reasoning')]), strict), ['must-fix', 'protected-class'], `strict, ${impact}, not-here, unsupported`);
    assert.deepEqual(kindOf(finding(impact, 'not-here', excluded), strict), ['must-fix', 'protected-class'], 'an unconfirmed protected exclusion is not supported');
    const escalating = derive(finding(impact, 'shown', shown));
    assert.deepEqual([escalating.kind, escalating.reason, escalating.escalates], ['must-fix', 'protected-class', true], `ordinary, ${impact}, shown escalates`);
    for (const status of ['unknown', 'not-here']) { const item = derive(finding(impact, status, status === 'not-here' ? excluded : []), { confirmed: true }); assert.deepEqual([item.kind, item.reason, item.operatorOnly], ['operator-item', 'protected-class', true], `ordinary, ${impact}, ${status}`); }
  }
  // Escalation: the ordinary flow becomes strict and every finding is derived again under strict rules.
  const review = deriveReview([finding('security', 'shown', shown), finding('outcome', 'unknown')], { ...context, round: 1, risk: 'ordinary', strictFollowups: true });
  assert.equal(review.escalated, true); assert.equal(review.risk, 'strict');
  assert.deepEqual(review.findings.map(row => [row.kind, row.reason]), [['must-fix', 'protected-class'], ['operator-item', 'unresolved-scenario']]);
});

test('rule 1: shown needs a validated citation; reasoning only, a missing quote and a record at another head are read as unknown', () => {
  const reasoning = derive(finding('outcome', 'shown', [cite('reasoning')]));
  assert.deepEqual([reasoning.kind, reasoning.reason, reasoning.reachable, reasoning.downgraded], ['operator-item', 'unresolved-scenario', { reported: 'shown', read: 'unknown' }, 'reasoning-only']);
  const none = derive(finding('outcome', 'shown', []));
  assert.deepEqual([none.reachable.read, none.downgraded], ['unknown', 'no-validated-citation']);
  const missingQuote = derive(finding('outcome', 'shown', [fileCite('records are written twice')]));
  assert.deepEqual([missingQuote.kind, missingQuote.reachable.read, missingQuote.downgraded, missingQuote.contradicted, missingQuote.citations], ['operator-item', 'unknown', 'contradicted', true, ['not-found']]);
  const otherHead = derive(finding('outcome', 'shown', [recordCite({ ref: 'attempt-old', head: OTHER })]));
  assert.deepEqual([otherHead.kind, otherHead.reachable.read, otherHead.downgraded, otherHead.citations], ['operator-item', 'unknown', 'contradicted', ['stale']]);
  // A contradicting citation wins over a validated one.
  assert.equal(derive(finding('outcome', 'shown', [fileCite(), recordCite({ head: OTHER })])).downgraded, 'contradicted');
  // A record with the wrong check or result does not validate.
  for (const wrong of [{ check: 'lint' }, { result: 'failed' }]) { const row = derive(finding('outcome', 'shown', [recordCite(wrong)])); assert.deepEqual([row.reachable.read, row.downgraded, row.citations], ['unknown', 'no-validated-citation', ['unknown-ref']]); }
  // Validated evidence keeps shown; in strict work a protected class read as unknown still blocks.
  assert.equal(derive(finding('outcome', 'shown', [recordCite()])).kind, 'must-fix');
  assert.deepEqual(kindOf(finding('check-trust', 'shown', [cite('reasoning')]), { risk: 'strict', strictFollowups: true }), ['must-fix', 'protected-class']);
});

test('rule 2: unmet purpose adds a must-fix finding unless one covers it', () => {
  const run = (findings, purpose) => deriveReview(findings, { ...context, round: 2, risk: 'ordinary', purpose }).findings.filter(row => row.added).map(row => [row.id, row.kind, row.reason]);
  assert.deepEqual(run([finding('none', 'unknown')], { outcome: 'not-met', acceptance: [] }), [['R2.2', 'must-fix', 'unmet-acceptance']]);
  assert.deepEqual(run([], { outcome: 'met', acceptance: [{ criterion: 'x', status: 'not-met' }] }), [['R2.1', 'must-fix', 'unmet-acceptance']]);
  assert.deepEqual(run([finding('outcome', 'shown', [fileCite()])], { outcome: 'not-met', acceptance: [] }), [], 'a must-fix outcome finding covers it');
  assert.deepEqual(run([], { outcome: 'met', acceptance: [], silentWrongAnswer: { answer: 'yes' } }), [['R2.1', 'must-fix', 'silent-wrong-answer']]);
  assert.deepEqual(run([finding('check-trust', 'shown', [fileCite()], { silent: true })], { outcome: 'met', acceptance: [], silentWrongAnswer: { answer: 'yes' } }), []);
  assert.deepEqual(run([], { outcome: 'unverified', acceptance: [{ criterion: 'x', status: 'unverified' }], silentWrongAnswer: { answer: 'unknown' } }), [], 'unverified and unknown never start a builder round');
  assert.deepEqual(run([finding('outcome', 'unknown')]), [], 'shadow v1 passes no purpose assessment');
});

test('rule 3: a non-must-fix critical finding is an operator item; rule 4: restrictions apply last and only tighten', () => {
  assert.deepEqual(kindOf(finding('none', 'unknown', [], { severity: 'critical' })), ['operator-item', 'critical']);
  assert.deepEqual(kindOf(finding('outcome', 'not-here', [cite('environment', { ref: 'single-host' })], { severity: 'critical' }), { confirmed: true }), ['operator-item', 'critical']);
  assert.deepEqual(kindOf(finding('outcome', 'shown', [fileCite()], { severity: 'critical' })), ['must-fix', 'outcome-shown'], 'severity never changes a must-fix finding');
  const all = { operatorDisposition: 'all' };
  const restricted = derive(finding('none', 'shown', [fileCite()]), { restriction: all });
  assert.deepEqual([restricted.kind, restricted.reason, restricted.operatorOnly], ['operator-item', 'restricted', true]);
  assert.deepEqual(kindOf(finding('outcome', 'shown', [fileCite()]), { restriction: all }), ['must-fix', 'outcome-shown'], 'a restriction never relaxes a kind');
  const noDeferral = { protectedClassDeferral: false }, excluded = [cite('environment', { ref: 'single-host' })];
  const strictExclusion = derive(finding('security', 'not-here', excluded), { risk: 'strict', strictFollowups: true, confirmed: true, restriction: noDeferral });
  assert.deepEqual([strictExclusion.kind, strictExclusion.restricted], ['must-fix', true], 'a protected not-here is read as unknown');
  assert.deepEqual(kindOf(finding('security', 'not-here', excluded), { confirmed: true, restriction: noDeferral }), ['operator-item', 'protected-class'], 'ordinary work: still an operator item');
  assert.deepEqual(kindOf(finding('outcome', 'not-here', excluded), { confirmed: true, restriction: noDeferral }), ['follow-up', 'supported-exclusion'], 'only protected classes are affected');
});

test('strict work without strictFollowups keeps today\'s bar: every reported finding blocks', () => {
  for (const row of [finding('none', 'unknown'), finding('outcome', 'unknown'), finding('outcome', 'not-here', [cite('environment', { ref: 'single-host' })])]) {
    const derived = derive(row, { risk: 'strict', confirmed: true });
    assert.equal(derived.kind, 'must-fix'); assert.ok(derived.strictBar, 'the table kind is kept as strictBar');
  }
  assert.equal(derive(finding('none', 'unknown'), { risk: 'strict', strictFollowups: true }).kind, 'follow-up');
});

test('legacy findings without the new fields are must-fix with bar legacy', () => {
  const old = { severity: 'low', file: 'a', line: 1, message: 'Old-shape finding' };
  assert.equal(mustFixShaped(old), false);
  assert.deepEqual(derive(old), { bar: 'legacy', kind: 'must-fix', reason: 'legacy-severity' });
  const partial = { ...finding('none', 'unknown'), reachable: { status: 'unknown' } };
  assert.equal(derive(partial).bar, 'legacy', 'a malformed must-fix finding is read as legacy, never as a follow-up');
  const shaped = finding('none', 'unknown');
  assert.equal(mustFixShaped(shaped), true); assert.equal(derive(shaped).bar, 'must-fix');
  assert.match(derive(shaped).claimDigest, /^[a-f\d]{64}$/);
  assert.notEqual(derive(shaped).claimDigest, derive({ ...shaped, scenario: `${shaped.scenario} Changed.` }).claimDigest);
});

test('shadow route v1 by protocol and phase (6.1, 7.3)', () => {
  const must = [{ kind: 'must-fix' }], items = [{ kind: 'operator-item' }, { kind: 'follow-up' }], none = [];
  const route = (derived, review) => shadowRouteV1(derived, review).route;
  for (const strict of [false, true]) {
    assert.deepEqual([route(must, { strict }), route(items, { strict }), route(none, { strict })], ['revise', 'defer', 'pass'], 'fresh-full');
    assert.deepEqual([route(must, { strict, satisfied: true }), route(items, { strict, satisfied: true })], ['revise', 'pass'], 'the satisfied review routes only pass and revise');
  }
  const bounded = phase => ({ strict: true, bounded: true, phase });
  assert.deepEqual([route(must, bounded('full')), route(items, bounded('full')), route(none, bounded('full'))], ['revise', 'delta', 'delta'], 'a strict full phase never defers');
  assert.deepEqual([route(must, bounded('delta')), route(items, bounded('delta')), route(none, bounded('delta'))], ['revise', 'defer', 'pass']);
  assert.deepEqual([route(must, bounded('final')), route(items, bounded('final')), route(none, bounded('final'))], ['adjudicate', 'defer', 'pass']);
  assert.equal(route(none, bounded('ordinary')), 'delta', 'an ordinary-phase review that finds strict risk');
  const ordinary = phase => ({ strict: false, bounded: true, phase });
  assert.deepEqual([route(must, ordinary('ordinary')), route(must, ordinary('final')), route(items, ordinary('final')), route(none, ordinary('final'))], ['revise', 'park', 'defer', 'pass']);
  assert.deepEqual(shadowRouteV1(none, { strict: true, incomplete: true }), { route: 'revise', disposition: 'incomplete' });
  assert.equal(route(none, { strict: true, incomplete: true, bounded: true, phase: 'final' }), 'park');
  assert.deepEqual([shadowPlanRouteV1(must).route, shadowPlanRouteV1(items), shadowPlanRouteV1(none).route], ['revise', { route: 'pass', disposition: 'accepted-with-plan-notes' }, 'pass']);
});

test('policy.reviewBar: severity by default, shadow accepted, must-fix refused as not available in this release', () => {
  const rehearsal = policy => validateConfig({ mode: 'rehearsal', policy });
  assert.doesNotThrow(() => rehearsal({}));
  assert.doesNotThrow(() => rehearsal({ reviewBar: 'severity' }));
  assert.doesNotThrow(() => rehearsal({ reviewBar: 'shadow', review: { mustFixRounds: 2, inFixEvidenceFrom: 3, maxFollowupsPerFlow: 20, strictFollowups: false, environment: [{ id: 'single-host', fact: 'Each account runs the factory on one host.' }] } }));
  assert.throws(() => rehearsal({ reviewBar: 'must-fix' }), /policy\.reviewBar must-fix is not available in this release/);
  assert.throws(() => validateReviewPolicy({ policy: { reviewBar: 'must-fix', review: { mustFixRounds: 3 } } }), /not available in this release/);
  assert.throws(() => rehearsal({ reviewBar: 'strict' }), /policy\.reviewBar must be severity or shadow/);
  assert.throws(() => rehearsal({ review: { mustFixRounds: 0 } }), /mustFixRounds must be a whole number from 1 to 11/);
  assert.throws(() => rehearsal({ review: { inFixEvidenceFrom: 1 } }), /inFixEvidenceFrom must be a whole number from 2 to 12/);
  assert.throws(() => rehearsal({ review: { maxFollowupsPerFlow: 51 } }), /maxFollowupsPerFlow must be a whole number from 1 to 50/);
  assert.throws(() => rehearsal({ review: { strictFollowups: 'yes' } }), /strictFollowups must be boolean/);
  assert.throws(() => rehearsal({ review: { deferLow: true } }), /policy\.review does not support deferLow/);
  assert.throws(() => rehearsal({ review: [] }), /policy\.review must be an object/);
  // The cap must be reachable: the first build is not a correction.
  assert.throws(() => rehearsal({ maxBuildRounds: 4, review: { mustFixRounds: 4 } }), /at most policy\.maxBuildRounds - 1 \(3\)/);
  assert.throws(() => rehearsal({ ordinaryReviewRounds: 2, review: { mustFixRounds: 3 } }), /at most policy\.ordinaryReviewRounds \(2\)/);
  assert.throws(() => rehearsal({ reviewBar: 'shadow', maxBuildRounds: 1 }), /at most policy\.maxBuildRounds - 1 \(0\)/, 'a shadow project pins the cap');
  assert.doesNotThrow(() => rehearsal({ maxBuildRounds: 1 }), 'a severity project that leaves the cap unset is not affected');
  // Environment facts: at most 40, ids unique, facts at most 300 characters, configuration only.
  const fact = (id, text = 'A fictional fact.') => ({ id, fact: text });
  assert.throws(() => rehearsal({ review: { environment: Array.from({ length: 41 }, (_, i) => fact(`f${i}`)) } }), /at most 40 facts/);
  assert.throws(() => rehearsal({ review: { environment: [fact('a'), fact('a')] } }), /declared twice/);
  assert.throws(() => rehearsal({ review: { environment: [fact('a', 'x'.repeat(301))] } }), /1 to 300 characters/);
  assert.throws(() => rehearsal({ review: { environment: [fact('../a')] } }), /environment id/);
  assert.throws(() => rehearsal({ review: { environment: [{ ...fact('a'), source: 'x' }] } }), /\{ id, fact \}/);
  // The setting is not normalised into the configuration, so its digest is unchanged when it is absent.
  const base = { mode: 'rehearsal', policy: { planning: false } };
  assert.equal(configDigest(base), configDigest(structuredClone(base)));
  assert.equal(JSON.stringify(validateConfig(base)), JSON.stringify(base));
});

test('the reference graph digests do not depend on the review bar', () => {
  for (const policy of [{ reviewBar: 'shadow' }, { reviewBar: 'shadow', review: { mustFixRounds: 2, strictFollowups: true, environment: [{ id: 'a', fact: 'b' }] } }]) {
    assert.equal(digest(changeWorkflow({ policy })), digest(changeWorkflow({ policy: {} })));
    assert.equal(digest(documentWorkflow({ policy })), digest(documentWorkflow({ policy: {} })));
  }
});

test('the review bar, strict follow-ups and environment facts are authority-bearing', () => {
  const before = authorityPolicy({ policy: {} });
  assert.equal(before['policy.reviewBar'], 'severity'); assert.equal(before['policy.review.strictFollowups'], false); assert.deepEqual(before['policy.review.environment'], []);
  const after = authorityPolicy({ policy: { reviewBar: 'shadow', review: { strictFollowups: true, environment: [{ id: 'a', fact: 'b' }] } } });
  for (const key of ['policy.reviewBar', 'policy.review.strictFollowups', 'policy.review.environment']) assert.notEqual(digest(after[key]), digest(before[key]), key);
  assert.equal(digest(authorityPolicy({ policy: { review: { mustFixRounds: 2 } } })['policy.reviewBar']), digest(before['policy.reviewBar']), 'round settings are not authority');
});

test('every behaviour-affecting review setting is pinned on each flow', () => {
  assert.deepEqual(pinnedReviewSettings({}), { reviewBar: 'severity' });
  assert.deepEqual(pinnedReviewSettings({ policy: { reviewBar: 'severity', review: { mustFixRounds: 2 } } }), { reviewBar: 'severity' }, 'a severity flow reads no must-fix setting');
  const facts = [{ id: 'single-host', fact: 'Each account runs the factory on one host.' }];
  const pinned = pinnedReviewSettings({ policy: { reviewBar: 'shadow', review: { inFixEvidenceFrom: 4, strictFollowups: true, environment: facts } } });
  assert.deepEqual(pinned, { reviewBar: 'shadow', reviewPolicy: { mustFixRounds: 3, inFixEvidenceFrom: 4, maxFollowupsPerFlow: 20, strictFollowups: true, environment: facts, schemas: { planReview: 'must-fix-2', review: 'must-fix-2', build: 'delivery-build' } } });
  assert.notEqual(pinned.reviewPolicy.environment, facts, 'the facts are copied');
  assert.equal(flowReviewBar({}), 'severity', 'a flow from before the bar is a severity flow');
});

// A rehearsal flow whose first step is a change review, admitted under `policy`.
async function reviewFlow(t, policy) {
  const f = sandbox(t), ghPath = join(f.base, 'gh');
  writeFileSync(ghPath, `#!${process.execPath}\nprocess.exit(9);`, { mode: 0o700 });
  const effect = (operation, next, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: 60000, next, onFailure: 'failed', ...extra });
  const workflow = { version: 1, start: 'inspect', nodes: { inspect: effect('provider.review', 'again', { maxVisits: 4, resultEdges: { pass: 'again', revise: 'again', defer: 'again' } }), again: effect('provider.review', 'done', { maxVisits: 4, resultEdges: { pass: 'done', revise: 'done', defer: 'done' } }), done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', ghPath }, providers: { builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { planning: false, ...policy }, context: { files: [], maxChars: 1000 } });
  f.command('task.put', { task: { id: f.task.id, title: 'Fictional feature', acceptance: ['Observed fixture behavior'], risk: 'ordinary' } });
  f.command('queue.put', { taskIds: [f.task.id] }); f.start();
  const flow = f.store.need('flow', 'flow-1'); flow.results.source = { head: execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim() }; f.store.put('flow', flow);
  writeFileSync(join(f.root, 'input.txt'), 'records are read once\n'); execFileSync('git', ['commit', '-qam', 'Fictional candidate'], { cwd: f.root });
  return f;
}
// `purpose`: the purpose assessment a must-fix-shaped result carries; none for today's shape.
const reviewReply = (findings, purpose = null) => async () => ({ provider: 'claude', model: 'fictional', family: 'anthropic', sessionId: 'fresh-review', result: { verdict: 'pass', summary: 'Fictional', findings, riskAssessment: { level: 'ordinary', rationale: 'Fictional', threatModel: [], stopConditions: [] }, strictReview: { fullDiffInspected: true, threatModelReviewed: false, stopConditionsReviewed: false }, scopeSummary: 'All', priorFindingsDisposition: [], learningsChecked: [], ...(purpose ? { purpose } : {}) } });
const fixturePurpose = purposeOf(['Observed fixture behavior']);
const receipt = actionResult => ({ exitCode: 0, reason: null, costMicros: 0, actionResult });

test('a shadow flow pins its settings, asks the must-fix questions, records shadowRoute v2 and routes as severity would', async t => {
  const facts = [{ id: 'single-host', fact: 'Each account runs the factory on one host.' }];
  const f = await reviewFlow(t, { reviewBar: 'shadow', review: { environment: facts } });
  const pinned = f.store.need('flow', 'flow-1');
  assert.equal(pinned.reviewBar, 'shadow'); assert.deepEqual(pinned.reviewPolicy.environment, facts);
  await f.engine.tick();
  const attempt = f.store.all('attempt')[0];
  assert.equal(attempt.intent.action.reviewBar, 'shadow'); assert.deepEqual(attempt.intent.action.reviewPolicy, pinned.reviewPolicy); assert.deepEqual(attempt.intent.action.reviewRecords, []);
  const head = repositoryIdentity(f.root).head;
  const findings = [
    finding('outcome', 'shown', [{ ...fileCite('records are read once', 'input.txt') }], { severity: 'low' }),
    finding('outcome', 'not-here', [cite('environment', { ref: 'single-host' })], { severity: 'low' }),
    finding('outcome', 'shown', [{ ...fileCite('records are written twice', 'input.txt') }], { severity: 'low' }),
    finding('none', 'unknown', [], { severity: 'low' }),
  ];
  let spec;
  const review = await runAction(attempt.intent, { providerInvoke: async s => { spec = s; return reviewReply(structuredClone(findings), fixturePurpose)(); } });
  assert.equal(spec.schema, MUST_FIX_CHANGE_REVIEW_SCHEMA); assert.match(spec.prompt, /Must-fix fields \(a shadow trial/); assert.match(spec.prompt, /"single-host"/);
  // Severity routing: an ordinary pass with only low findings defers. Must-fix: a shown outcome finding sends it back.
  assert.equal(review.route, 'defer'); assert.equal(review.disposition, 'followup-required');
  assert.deepEqual(review.shadowRoute, { version: 'v2', estimate: true, omits: [...SHADOW_V2_OMITS], route: 'revise', disposition: 'correct', actualRoute: 'defer', actualDisposition: 'followup-required', differs: true, verdictOverridden: true });
  assert.deepEqual(review.mustFix.findings.map(row => [row.id, row.kind, row.reason, row.citations.join()]), [['R1.1', 'must-fix', 'outcome-shown', 'validated'], ['R1.2', 'operator-item', 'unconfirmed-exclusion', 'validated'], ['R1.3', 'operator-item', 'unresolved-scenario', 'not-found'], ['R1.4', 'follow-up', 'purpose-none', '']]);
  assert.equal(review.mustFix.findings[2].downgraded, 'contradicted');
  assert.deepEqual(review.result.findings, findings, 'the reviewer\'s output is kept as returned');
  f.engine.settle('flow-1', attempt, receipt(review));
  const settled = f.store.need('flow', 'flow-1'), row = settled.reviewHistory[0];
  assert.equal(settled.step, 'again', 'the actual route was followed');
  assert.deepEqual(row.shadowRoute, review.shadowRoute); assert.deepEqual(row.mustFix, review.mustFix);
  assert.equal(row.reviewDigest, digest({ identity: review.identity, result: review.result }), 'the review digest is of what the reviewer returned');
  assert.deepEqual(reviewFindingIds(settled)[0].findings.map(row => [row.id, row.bar]), [['R1.1', 'must-fix'], ['R1.2', 'must-fix'], ['R1.3', 'must-fix'], ['R1.4', 'must-fix']], 'stored ids are the positional ids');
  // Configuration moves on (drained activation would be needed in delivery); the flow keeps its pins.
  f.store.setMeta('config', { ...f.store.meta('config'), policy: { planning: false } });
  await f.engine.tick();
  const second = f.store.need('attempt', f.store.need('flow', 'flow-1').attemptId);
  assert.equal(second.intent.action.reviewBar, 'shadow');
  assert.deepEqual(second.intent.action.reviewRecords, [{ id: attempt.id, step: 'inspect', head, checks: { route: 'defer' } }]);
  let prompt;
  const next = await runAction(second.intent, { providerInvoke: async s => { prompt = s.prompt; return reviewReply([finding('outcome', 'shown', [recordCite({ ref: attempt.id, head, check: 'route', result: 'defer' })])], fixturePurpose)(); } });
  assert.doesNotMatch(prompt.split('Trusted diff:')[0], /shadowRoute|"mustFix"/, 'earlier reviews reach the reviewer without the derived fields');
  assert.deepEqual(next.mustFix.findings.map(row => [row.id, row.kind, row.citations.join()]), [['R2.1', 'must-fix', 'validated']]);
  assert.equal(next.route, 'revise'); assert.equal(next.shadowRoute.route, 'revise');
});

test('a severity flow pins only its bar, and its intents and records carry nothing of the must-fix bar', async t => {
  for (const policy of [{}, { reviewBar: 'severity', review: { environment: [{ id: 'a', fact: 'b' }] } }]) {
    const f = await reviewFlow(t, policy);
    assert.equal(f.store.need('flow', 'flow-1').reviewBar, 'severity'); assert.equal(f.store.need('flow', 'flow-1').reviewPolicy, undefined);
    await f.engine.tick();
    const attempt = f.store.all('attempt')[0];
    for (const key of ['reviewBar', 'reviewPolicy', 'reviewRecords', 'reviewRound']) assert.equal(Object.hasOwn(attempt.intent.action, key), false, key);
    let spec;
    const review = await runAction(attempt.intent, { providerInvoke: async s => { spec = s; return reviewReply([{ severity: 'low', file: 'input.txt', line: 1, message: 'Old shape' }])(); } });
    assert.equal(spec.schema, CHANGE_REVIEW_SCHEMA); assert.doesNotMatch(spec.prompt, /Must-fix/);
    assert.equal(review.mustFix, undefined); assert.equal(review.shadowRoute, undefined);
    f.engine.settle('flow-1', attempt, receipt(review));
    assert.deepEqual(Object.keys(f.store.need('flow', 'flow-1').reviewHistory[0]), ['attemptId', 'step', 'phase', 'risk', 'identity', 'baseHead', 'disposition', 'result', 'reviewDigest']);
  }
});

test('severity identity: prompts, schemas, routes, results, review history and digests equal the golden taken before the bar existed', async () => {
  for (const [label, options] of [['unset', {}], ['severity', { policy: { reviewBar: 'severity', review: { mustFixRounds: 2, environment: [{ id: 'a', fact: 'b' }] } } }]]) {
    const capture = goldenView(await captureReviewScenarios(options));
    for (const name of Object.keys(golden)) assert.deepEqual(capture[name], golden[name], `${label}: ${name}`);
    assert.deepEqual(Object.keys(capture), Object.keys(golden));
  }
});

// A shadow prompt with the purpose block and the must-fix questions taken out: today's prompt.
const severityPart = prompt => prompt.replace(/\nPurpose first\.[\s\S]*?(?=\n(Independently review|Review this proposed plan))/u, '').replace(/\nMust-fix fields \([\s\S]*$/u, '');
test('shadow identity: the actual route always equals the severity route; the shadow only adds the purpose block, questions, its correction review and records', async () => {
  const pinned = pinnedReviewSettings({ policy: { reviewBar: 'shadow' } });
  const action = () => ({ reviewBar: 'shadow', reviewPolicy: pinned.reviewPolicy, reviewRecords: [], reviewRound: 1 });
  // Each scripted finding also in the must-fix shape: high shown with a validated quote, medium unknown, low purpose none; and a complete purpose assessment.
  const shaped = (scenario, index, step) => (step.results ?? []).map(result => ({ ...result, purpose: purposeOf(SCENARIO_ACCEPTANCE), findings: result.findings.map(row => ({ ...row, ...finding(row.severity === 'high' ? 'outcome' : row.severity === 'medium' ? 'outcome' : 'none', row.severity === 'high' ? 'shown' : 'unknown', row.severity === 'high' ? [fileCite('fictional baseline', 'records.txt')] : []), severity: row.severity, file: row.file, line: row.line, message: row.message })) }));
  // Today's shape has no purpose assessment, so every shadow review is contradictory and gets the
  // must-fix bar's correction review; the scripted reviewer answers it with each result again.
  const twice = (scenario, index, step) => (step.results ?? []).flatMap(result => [result, structuredClone(result)]);
  for (const results of [twice, shaped]) {
    const shadow = await captureReviewScenarios({ policy: { reviewBar: 'shadow' }, action, results });
    const baseline = await captureReviewScenarios({ results });
    for (const scenario of SCENARIOS) {
      const ran = shadow[scenario.name].steps, base = baseline[scenario.name].steps;
      assert.equal(ran.length, base.length);
      for (const [index, step] of ran.entries()) {
        assert.deepEqual([step.result.route, step.result.disposition ?? null], [base[index].result.route, base[index].result.disposition ?? null], `${scenario.name} step ${index}`);
        // The strict plan check's own finding carries the must-fix fields in a shadow flow; nothing else differs.
        const todayShape = row => row && { ...row, findings: row.findings?.map(({ severity, file, line, message }) => ({ severity, file, line, message })) };
        assert.deepEqual(todayShape(step.result.result), todayShape(base[index].result.result), `${scenario.name} step ${index}: the reviewed result is the one severity routes`);
        if (step.op === 'build') { assert.equal(step.calls[0].prompt, base[index].calls[0].prompt, 'the builder brief is unchanged'); continue; }
        assert.equal(severityPart(step.calls[0].prompt), base[index].calls[0].prompt, `${scenario.name} step ${index}: the shadow prompt is today's prompt with the purpose block before the material under review and the must-fix questions after it`);
        const purposeAt = step.calls[0].prompt.indexOf('\nPurpose first.');
        assert.ok(purposeAt > 0 && purposeAt < step.calls[0].prompt.indexOf(step.op === 'plan' ? 'Plan: ' : 'Trusted diff:'), 'the purpose block comes first');
        assert.equal(step.result.shadowRoute.version, 'v2'); assert.equal(step.result.shadowRoute.actualRoute, step.result.route);
        assert.equal(JSON.parse(step.calls[0].schema).properties.findings.items.properties.scenario.maxLength, 1200);
        assert.ok(JSON.parse(step.calls[0].schema).properties.purpose, 'the schema asks for the purpose assessment');
        // Today's plan review runs its own correction for a pass with findings; the shadow's correction review runs only for a contradictory result, and only for the estimate.
        const extra = step.calls.length - base[index].calls.length;
        assert.equal(extra, results === twice && !(step.op === 'plan' && base[index].calls.length > 1) ? 1 : 0, `${scenario.name} step ${index}: correction reviews`);
        if (results === twice) assert.deepEqual([step.result.shadowRoute.route, step.result.shadowRoute.disposition], [step.op === 'plan' ? 'stop' : scenario.satisfied ? 'revise' : 'park', 'protocol-failure'], `${scenario.name} step ${index}: a second contradiction`);
      }
    }
    // The plan review's own strict finding is a check-trust finding in a shadow flow.
    const strictPlan = shadow['plan-review'].steps.at(-1).result;
    assert.deepEqual(strictPlan.mustFix.findings.map(row => [row.id, row.kind, row.reason, row.purposeImpact]), [['P1.1', 'must-fix', 'protected-class', 'check-trust']]);
  }
  // With must-fix-shaped results the shadow disagrees with severity where the design says it would.
  const shadow = await captureReviewScenarios({ policy: { reviewBar: 'shadow' }, action, results: shaped });
  assert.deepEqual(shadow['fresh-full-ordinary'].steps.map(step => step.result.shadowRoute?.route ?? null), ['revise', null, 'defer', 'defer', 'pass']);
  assert.deepEqual(shadow['fresh-full-ordinary'].steps.map(step => step.result.route), ['revise', 'implemented', 'defer', 'revise', 'pass']);
});

test('a shadow derivation that fails is recorded as the shadow outcome and never fails the review', async () => {
  const broken = () => ({ reviewBar: 'shadow', reviewPolicy: { environment: 5 }, reviewRecords: [], reviewRound: 1 });
  const results = (scenario, index, step) => (step.results ?? []).map(result => ({ ...result, purpose: purposeOf(SCENARIO_ACCEPTANCE), findings: result.findings.map(row => ({ ...row, ...finding('outcome', 'not-here', [cite('environment', { ref: 'single-host' })]), severity: row.severity, message: row.message })) }));
  const shadow = await captureReviewScenarios({ policy: { reviewBar: 'shadow' }, action: broken, results }), severity = await captureReviewScenarios({ results });
  const steps = shadow['fresh-full-ordinary'].steps, base = severity['fresh-full-ordinary'].steps;
  assert.deepEqual(steps.map(step => step.result.route), base.map(step => step.result.route));
  assert.match(steps[0].result.shadowRoute.error, /not a function|is not iterable/);
  assert.equal(steps[0].result.mustFix, undefined);
  assert.deepEqual(shadow['fresh-full-ordinary'].reviewHistory[0].shadowRoute, steps[0].result.shadowRoute, 'the history row keeps the failed estimate');
  // A correction review that fails (here the scripted reviewer has no answer for it) is a failed estimate too.
  const unanswered = await captureReviewScenarios({ policy: { reviewBar: 'shadow' }, action: () => ({ ...broken(), reviewPolicy: pinnedReviewSettings({ policy: { reviewBar: 'shadow' } }).reviewPolicy }) });
  assert.deepEqual(unanswered['fresh-full-ordinary'].steps.map(step => step.result.route), (await captureReviewScenarios())['fresh-full-ordinary'].steps.map(step => step.result.route));
  assert.match(unanswered['fresh-full-ordinary'].steps[0].result.shadowRoute.error, /Cannot read properties of undefined/);
});

// Review findings on slice 1: a shadow review of a fixed one-commit repository, run through the dispatcher.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createProviderAdapter } from '../starter/factory/adapters/providers/index.mjs';
function shadowCandidate(t, policy = { reviewBar: 'shadow' }) {
  const base = mkdtempSync(join(tmpdir(), 'fct-mf-')), root = join(base, 'repo'); t.after(() => rmSync(base, { recursive: true, force: true }));
  execFileSync('mkdir', ['-p', root]);
  const git = (args, input) => execFileSync('git', args, { cwd: root, input, encoding: 'utf8' }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Fictional Evaluator']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(join(root, 'input.txt'), 'real candidate text\n'); git(['add', '.']); git(['commit', '-qm', 'Fictional candidate']);
  const head = repositoryIdentity(root).head, config = { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { reviewer: { provider: 'claude', model: 'fictional' } }, policy, context: { files: [], maxChars: 1000 } };
  const action = { operation: 'provider.review', step: 'review', binding: 'review', task: { id: 'task-1', title: 'Fictional task', acceptance: ['Correct'], risk: 'ordinary' }, config, risk: { level: 'ordinary' }, reviewHistory: [], results: { source: { head } }, context: { files: [], digest: 'fictional-context' }, artifactDir: join(base, 'artifacts'), projectId: 'project-1', flowId: 'flow-1', ...pinnedReviewSettings(config), reviewRecords: [] };
  return { base, root, git, head, config, action, intent: { cwd: root, timeoutMs: 60000, action } };
}
const severityOnly = { verdict: 'revise', summary: 'Fictional severity-only review', findings: [{ severity: 'high', file: 'input.txt', line: 1, message: 'Concrete defect' }], riskAssessment: { level: 'ordinary', rationale: 'Bounded', threatModel: [], stopConditions: [] }, strictReview: { fullDiffInspected: true, threatModelReviewed: false, stopConditionsReviewed: false }, scopeSummary: 'All', priorFindingsDisposition: [], learningsChecked: [] };
// A provider adapter whose Claude process prints `output` as its structured result; it records the schema it was asked for.
function scriptedClaude(output, asked) {
  const help = '--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config --safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts';
  return createProviderAdapter({ transport: async (binary, args) => {
    if (args.includes('--json-schema')) asked.push(JSON.parse(args[args.indexOf('--json-schema') + 1]));
    return { code: 0, stderr: '', stdout: args.includes('--version') ? '2.1.323' : args.includes('--help') ? help : args.includes('status') ? JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) : JSON.stringify({ type: 'result', subtype: 'success', session_id: 'fictional-session', usage: { input_tokens: 1, output_tokens: 1 }, structured_output: output }) };
  } });
}

test('review fix 1: a shadow review accepts a severity-only result through the real adapter and reads it as legacy', async t => {
  const f = shadowCandidate(t), asked = [];
  const adapter = scriptedClaude(structuredClone(severityOnly), asked);
  const review = await runAction(f.intent, { providerInvoke: adapter.invoke });
  // Slice 2: a result in today's shape has no purpose assessment, so the shadow runs the must-fix
  // bar's correction review, asked for the full schema again; the same answer is a second contradiction.
  assert.deepEqual(asked, [MUST_FIX_CHANGE_REVIEW_SCHEMA, MUST_FIX_CHANGE_REVIEW_SCHEMA], 'the model is still asked for the full must-fix schema');
  assert.equal(review.schemaFallback, 'legacy');
  assert.equal(review.route, 'revise', 'the severity route');
  assert.deepEqual(review.mustFix.findings.map(row => [row.id, row.bar, row.kind, row.reason]), [['R1.1', 'legacy', 'must-fix', 'legacy-severity']]);
  assert.equal(review.mustFix.schemaFallback, 'legacy');
  assert.deepEqual(review.mustFix.protocol.contradictions, ['the purpose assessment is missing']);
  assert.deepEqual([review.shadowRoute.route, review.shadowRoute.disposition], ['park', 'protocol-failure'], 'protocol failure comes before the legacy fallback, which alone would revise');
  // A result valid against neither schema is still refused, as any malformed result is.
  const mixed = { ...severityOnly, findings: [...severityOnly.findings, finding('outcome', 'unknown')] };
  await assert.rejects(runAction(f.intent, { providerInvoke: scriptedClaude(mixed, []).invoke }), error => error.code === 'INVALID_RESULT');
  await assert.rejects(runAction(f.intent, { providerInvoke: scriptedClaude({ ...severityOnly, verdict: 'maybe' }, []).invoke }), error => error.code === 'INVALID_RESULT');
  // A severity flow asks for today's schema and is offered no fallback.
  const specs = [], severityFlow = shadowCandidate(t, {});
  await runAction(severityFlow.intent, { providerInvoke: async spec => { specs.push(spec); return scriptedClaude(structuredClone(severityOnly), []).invoke(spec); } });
  assert.equal(specs[0].schema, CHANGE_REVIEW_SCHEMA); assert.equal(Object.hasOwn(specs[0], 'legacySchema'), false);
});

test('review fix 2: file citations are read from verified objects, so a replacement ref cannot make a quote validate', async t => {
  const f = shadowCandidate(t);
  const original = f.git(['rev-parse', 'HEAD:input.txt']), forged = f.git(['hash-object', '-w', '--stdin'], 'FORGED QUOTE NOT IN CANDIDATE\n');
  f.git(['replace', original, forged]);
  assert.equal(f.git(['cat-file', 'blob', 'HEAD:input.txt']), 'FORGED QUOTE NOT IN CANDIDATE', 'plain Git now shows the forged blob');
  const quoting = quote => ({ ...severityOnly, findings: [{ ...finding('outcome', 'shown', [fileCite(quote, 'input.txt')]), severity: 'high', file: 'input.txt', line: 1, message: 'Concrete defect' }] });
  const run = async quote => (await runAction(f.intent, { providerInvoke: async () => ({ provider: 'claude', model: 'fictional', family: 'anthropic', result: quoting(quote) }) })).mustFix.findings[0];
  const forgedRow = await run('FORGED QUOTE NOT IN CANDIDATE');
  assert.deepEqual([forgedRow.citations, forgedRow.reachable.read, forgedRow.downgraded, forgedRow.kind], [['not-found'], 'unknown', 'contradicted', 'operator-item']);
  const realRow = await run('real candidate text');
  assert.deepEqual([realRow.citations, realRow.reachable.read, realRow.kind], [['validated'], 'shown', 'must-fix']);
});

test('review fix 3: phase routing reads the flow\'s pinned review protocol, not the current configuration', async t => {
  const f = shadowCandidate(t, { reviewBar: 'shadow', reviewProtocol: 'fresh-full' });
  const reply = async () => ({ provider: 'claude', model: 'fictional', family: 'anthropic', result: { ...severityOnly, verdict: 'pass', findings: [] } });
  const pinned = await runAction({ ...f.intent, action: { ...f.action, reviewProtocol: 'bounded-delta' } }, { providerInvoke: reply });
  assert.equal(pinned.phase, 'ordinary', 'the pinned bounded-delta protocol');
  const fresh = await runAction({ ...f.intent, action: { ...f.action, reviewProtocol: 'fresh-full', config: { ...f.config, policy: { ...f.config.policy, reviewProtocol: 'bounded-delta' } } } }, { providerInvoke: reply });
  assert.equal(fresh.phase, 'full', 'the pinned fresh-full protocol');
  const unpinned = await runAction({ ...f.intent, action: { ...f.action, config: { ...f.config, policy: { ...f.config.policy, reviewProtocol: 'bounded-delta' } } } }, { providerInvoke: reply });
  assert.equal(unpinned.phase, 'ordinary', 'a flow without a pin reads the configuration, as before');
});
