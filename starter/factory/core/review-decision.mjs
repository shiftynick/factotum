// The must-fix merge decision (docs/designs/review-must-fix.md 7.4, 12.5 and 13.4, slice 5): the
// acknowledgement list, the decision guard and the review restriction.
//
// Only a flow pinned to `must-fix` reads this file, and configuration validation still refuses that
// setting (core/review-bar.mjs), so until the enabling release only test fixtures reach it. A
// severity or shadow flow's guard is empty (null): its questions, answers, strict requirement and
// merge authorization are exactly what they were before the bar existed.
//
// - The acknowledgement list (7.4): every finding of the flow that is not judged fixed: adjudicated
//   must-fix items, operator items, follow-ups (the operator's accepted ones too), and the purpose
//   assessment of the review the decision rests on when it is not settled (an outcome or a criterion
//   that is not `met`, a silent-answer assessment other than `no`). Each entry carries its id, kind,
//   reason, claim digest and whether it is operator-only: protected-class items, anything under a
//   restriction and, as a tightening this release adds, a reviewer's `critical` rating (4.3 rule 3).
// - The decision guard (12.5): whether an ordinary must-fix flow's merge or satisfied decision must be
//   the operator's, and why: an operator item of any reason, a `critical` finding that is not
//   must-fix, an outcome or criterion that is not `met`, a silent-answer assessment other than `no`,
//   a row overflow, or an active `review.restrict` with `operatorDisposition: all`. The operator's
//   answer then names every listed item by id and claim digest. An open must-fix item blocks a merge
//   outright (it is sent back, or adjudicated in strict work). Its digest is part of the question's
//   subject and of the merge authorization, so any change reopens the question and refuses an
//   earlier answer before the merge.
// - The restriction (13.4): an operator-only, versioned record in project meta, never configuration,
//   that only tightens: `protectedClassDeferral: false` and `operatorDisposition: all`. Its version is
//   part of the guard's and the strict requirement's digests.
import { assert, digest } from './contracts.mjs';
import { flowReviewBar } from './review-bar.mjs';
import { computeReviewLedger, ledgerDigest, OPEN } from '../workflows/review-ledger.mjs';
import { PROTECTED_CLASSES } from '../workflows/must-fix.mjs';

export const REVIEW_RESTRICTION_META = 'reviewRestriction';
export const RESTRICTION_HISTORY_LIMIT = 20;
// What a review restriction record says, with every field present. No record: version 0, nothing active.
export function restrictionOf(record) {
  const protectedClassDeferral = record?.protectedClassDeferral !== false, operatorDisposition = record?.operatorDisposition === 'all' ? 'all' : 'none';
  return { version: Number.isSafeInteger(record?.version) ? record.version : 0, protectedClassDeferral, operatorDisposition, active: !protectedClassDeferral || operatorDisposition === 'all' };
}
// The form deriveFinding and deferralRefusal read (workflows/must-fix.mjs, review-ledger.mjs), or null.
export function restrictionContext(record) {
  const r = restrictionOf(record);
  return r.active ? { ...(r.protectedClassDeferral ? {} : { protectedClassDeferral: false }), ...(r.operatorDisposition === 'all' ? { operatorDisposition: 'all' } : {}), version: r.version } : null;
}

const clip = (text, length = 300) => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim().slice(0, length) : null;
const SETTLED = Object.freeze(['fixed', 'superseded']);
export const PURPOSE_OUTCOME_ID = 'purpose:outcome', PURPOSE_SILENT_ID = 'purpose:silent-wrong-answer';
// The review a merge or satisfied decision rests on: the latest review the flow recorded.
export const decisionReview = flow => flow?.results?.review ?? flow?.results?.['satisfied-review'] ?? null;
const reviewDigestOf = review => digest({ identity: review?.identity ?? null, result: review?.result ?? null });

// One ledger entry as an acknowledgement item. A restriction turns a follow-up into an operator item
// (operatorDisposition all; protectedClassDeferral false for a protected class); it never lowers a kind.
function ledgerItem(entry, restriction) {
  const protectedClass = PROTECTED_CLASSES.includes(entry.purposeImpact), openMustFix = entry.kind === 'must-fix' && OPEN.includes(entry.status);
  const restricted = !openMustFix && entry.kind !== 'operator-item' && (restriction.operatorDisposition === 'all' || !restriction.protectedClassDeferral && protectedClass);
  const critical = entry.severity === 'critical';
  const claimDigest = entry.claimDigest ?? digest({ id: entry.id, source: entry.source ?? null, reason: entry.reason ?? null, message: entry.message ?? null, severity: entry.severity ?? null, file: entry.file ?? null, line: entry.line ?? null, head: entry.head ?? null });
  return {
    id: entry.id, kind: restricted ? 'operator-item' : entry.kind, reason: restricted ? 'restricted' : entry.reason ?? null, status: entry.status, claimDigest,
    operatorOnly: entry.operatorOnly === true || protectedClass || critical || restricted || restriction.operatorDisposition === 'all',
    ...(restricted ? { restricted: true, wasKind: entry.kind } : {}), ...(critical ? { critical: true } : {}), ...(openMustFix ? { adjudicated: true } : {}),
    round: entry.round ?? null, severity: entry.severity ?? null, purposeImpact: entry.purposeImpact ?? null, message: clip(entry.message), scenario: clip(entry.scenario, 600),
    reachable: entry.reachable ? { reported: entry.reachable.reported ?? null, read: entry.reachable.read ?? null } : null, citations: Array.isArray(entry.citations) ? entry.citations.slice(0, 4) : [], support: entry.support ?? null,
    raisedByFamily: entry.raisedBy?.family ?? null, ...(entry.excludedBy ? { excludedByFamily: entry.excludedBy.family ?? null } : {}), ...(entry.confirmedBy ? { confirmedByFamily: entry.confirmedBy.family ?? null } : {}),
    ...(entry.deferral ? { deferral: { round: entry.deferral.round ?? null, reason: entry.deferral.reason ?? null, outcome: entry.deferral.outcome ?? null, void: Boolean(entry.deferral.void) } } : {}),
    judgements: (entry.judgements ?? []).filter(row => row.counted).slice(-4).map(row => ({ round: row.round, judgement: row.judgement, family: row.reviewer?.family ?? null })),
    ...((entry.operatorDispositions ?? []).length ? { operatorDisposition: entry.operatorDispositions.at(-1).disposition } : {}),
  };
}
// The purpose assessment of the review a decision rests on, as acknowledgement items (10.3): an outcome
// or criterion that is not `met`, and a silent-answer assessment other than `no`. Missing: none, and `missing`.
function purposeItems(review) {
  const purpose = review?.result?.purpose;
  if (!purpose || typeof purpose !== 'object' || !Array.isArray(purpose.acceptance)) return { missing: true, items: [] };
  const items = [], reviewDigest = reviewDigestOf(review), criteria = status => purpose.acceptance.filter(row => row?.status === status).map(row => clip(row.criterion));
  const unverified = criteria('unverified'), notMet = criteria('not-met');
  if (purpose.outcome !== 'met' || unverified.length || notMet.length) items.push({ id: PURPOSE_OUTCOME_ID, kind: 'purpose', reason: purpose.outcome !== 'met' ? `outcome-${purpose.outcome ?? 'missing'}` : notMet.length ? 'criterion-not-met' : 'criterion-unverified', status: 'assessed', claimDigest: digest({ review: reviewDigest, outcome: purpose.outcome ?? null, acceptance: purpose.acceptance }), operatorOnly: false, outcome: purpose.outcome ?? null, unverified, notMet });
  const silent = purpose.silentWrongAnswer;
  if (silent?.answer !== 'no') items.push({ id: PURPOSE_SILENT_ID, kind: 'purpose', reason: `silent-wrong-answer-${silent?.answer ?? 'missing'}`, status: 'assessed', claimDigest: digest({ review: reviewDigest, silentWrongAnswer: silent ?? null }), operatorOnly: false, answer: silent?.answer ?? null, how: clip(silent?.how, 600), settle: clip(silent?.settle, 600) });
  return { missing: false, items };
}

// The acknowledgement list of a must-fix flow (7.4) with what it was computed from. `adjudicated`:
// the decision rests on a strict bounded-delta final adjudication, whose open must-fix items join the
// list; otherwise they are `open` and block. Operator items come first, then protected-class items,
// then the rest (11.5).
export function reviewAcknowledgements(flow, { restriction = null, adjudicated = false } = {}) {
  const r = restrictionOf(restriction ?? flow?.reviewRestriction), ledger = computeReviewLedger(flow), review = decisionReview(flow);
  const entries = (ledger.entries ?? []).filter(entry => !SETTLED.includes(entry.status));
  const open = entries.filter(entry => entry.kind === 'must-fix' && OPEN.includes(entry.status)).map(entry => entry.id);
  const order = item => item.kind === 'operator-item' ? 0 : PROTECTED_CLASSES.includes(item.purposeImpact) ? 1 : item.kind === 'purpose' ? 3 : 2;
  const listed = entries.filter(entry => adjudicated || !(entry.kind === 'must-fix' && OPEN.includes(entry.status))).map(entry => ledgerItem(entry, r));
  const purpose = purposeItems(review);
  const items = [...listed, ...purpose.items.map(item => r.operatorDisposition === 'all' ? { ...item, operatorOnly: true } : item)].map((item, index) => ({ item, index })).sort((a, b) => order(a.item) - order(b.item) || a.index - b.index).map(row => row.item);
  return { ledger, ledgerDigest: ledgerDigest(ledger), review, items, open: adjudicated ? [] : open, purposeMissing: purpose.missing, restriction: r };
}
// The pairs an answer names, and the digest the list is bound by.
export const acknowledgementPairs = items => items.map(item => ({ id: item.id, claimDigest: item.claimDigest }));
const listDigest = items => digest(items.map(item => ({ id: item.id, kind: item.kind, reason: item.reason, status: item.status, claimDigest: item.claimDigest, operatorOnly: item.operatorOnly })));

// The decision guard (12.5). `risk`: the flow's effective risk. Null for a severity or shadow flow.
// { operator, reasons, blocked, acknowledgements, digest, restriction }: `operator` says the decision
// must be the operator's own and `autoMerge` does not answer; `blocked` names open must-fix items,
// which no merge or acceptance may pass; `acknowledgements` are what an answer must name when
// `operator` holds (in strict work the strict requirement asks for the same list).
export function reviewDecisionGuard(flow, { risk = 'strict', restriction = null } = {}) {
  if (flowReviewBar(flow) !== 'must-fix') return null;
  const review = decisionReview(flow), adjudicated = review?.route === 'adjudicate' && review?.disposition === 'operator-adjudication';
  const view = reviewAcknowledgements(flow, { restriction, adjudicated }), reasons = [];
  const add = (reason, extra = {}) => reasons.push({ reason, ...extra });
  if (risk !== 'strict') {
    const operatorItems = view.items.filter(item => item.kind === 'operator-item');
    if (operatorItems.length) add('operator-items', { ids: operatorItems.map(item => item.id), reasons: [...new Set(operatorItems.map(item => item.reason))] });
    const critical = view.items.filter(item => item.critical && item.kind !== 'must-fix');
    if (critical.length) add('critical', { ids: critical.map(item => item.id) });
    if (view.purposeMissing) add('purpose-missing');
    const outcome = view.items.find(item => item.id === PURPOSE_OUTCOME_ID), silent = view.items.find(item => item.id === PURPOSE_SILENT_ID);
    if (outcome) add('purpose-not-met', { outcome: outcome.outcome, unverified: outcome.unverified.length, notMet: outcome.notMet.length });
    if (silent) add('silent-wrong-answer', { answer: silent.answer });
    if ((flow.reviewRowOverflow?.count ?? 0) > 0) add('row-overflow', { count: flow.reviewRowOverflow.count });
  }
  if (view.restriction.operatorDisposition === 'all') add('restricted', { version: view.restriction.version });
  const blocked = view.open;
  const body = { risk, reasons, blocked, items: listDigest(view.items), ledger: view.ledgerDigest, restriction: view.restriction.version, overflow: flow.reviewRowOverflow?.count ?? 0, review: review ? reviewDigestOf(review) : null };
  return { bar: 'must-fix', risk, operator: reasons.length > 0, reasons, blocked, acknowledgements: view.items, counts: ledgerCounts(view), restriction: view.restriction, ledgerDigest: view.ledgerDigest, digest: digest(body) };
}
// The counts a merge question shows in place of severity counts (12.3).
function ledgerCounts(view) {
  const entries = view.ledger.entries ?? [];
  return { mustFixOpen: entries.filter(entry => entry.kind === 'must-fix' && OPEN.includes(entry.status)).length, operatorItems: view.items.filter(item => item.kind === 'operator-item').length, followUps: view.items.filter(item => item.kind === 'follow-up').length, deferrals: entries.filter(entry => entry.deferral).length, fixed: entries.filter(entry => entry.status === 'fixed').length };
}
// What a question carries of the guard (bounded): the reasons, the counts and the list to acknowledge.
export const ACKNOWLEDGEMENT_LIMIT = 80;
export function publicGuard(guard) {
  if (!guard) return null;
  return { bar: guard.bar, risk: guard.risk, operator: guard.operator, reasons: guard.reasons, blocked: guard.blocked, counts: guard.counts, restriction: { version: guard.restriction.version, protectedClassDeferral: guard.restriction.protectedClassDeferral, operatorDisposition: guard.restriction.operatorDisposition }, acknowledgements: guard.acknowledgements.slice(0, ACKNOWLEDGEMENT_LIMIT), ...(guard.acknowledgements.length > ACKNOWLEDGEMENT_LIMIT ? { acknowledgementsOmitted: guard.acknowledgements.length - ACKNOWLEDGEMENT_LIMIT } : {}), digest: guard.digest };
}

// An answer's acknowledgedFindings: exactly the listed items, each once, by id and claim digest.
// Returns the normalized pairs. `what` names the decision in the refusal.
export function assertAcknowledged(items, acknowledged, what = 'this decision') {
  const want = acknowledgementPairs(items);
  if (!want.length && (acknowledged === undefined || Array.isArray(acknowledged) && !acknowledged.length)) return [];
  assert(Array.isArray(acknowledged) && acknowledged.every(row => row && typeof row === 'object' && !Array.isArray(row) && typeof row.id === 'string' && typeof row.claimDigest === 'string' && Object.keys(row).every(key => ['id', 'claimDigest'].includes(key))), `${what} requires acknowledgedFindings: [{ id, claimDigest }] naming each listed finding exactly once (${want.length} listed: ${want.map(row => row.id).slice(0, 12).join(', ')}${want.length > 12 ? ', ...' : ''})`);
  const named = new Map(), repeated = [];
  for (const row of acknowledged) { if (named.has(row.id)) repeated.push(row.id); named.set(row.id, row.claimDigest); }
  const missing = want.filter(row => !named.has(row.id)).map(row => row.id), changed = want.filter(row => named.has(row.id) && named.get(row.id) !== row.claimDigest).map(row => row.id), extra = [...named.keys()].filter(id => !want.some(row => row.id === id));
  assert(!repeated.length && !missing.length && !changed.length && !extra.length, `acknowledgedFindings does not match the findings listed for ${what}: ${[missing.length ? `missing ${missing.join(', ')}` : '', changed.length ? `changed ${changed.join(', ')} (the claim digest you named is not the current one; read the question again)` : '', extra.length ? `not listed ${extra.join(', ')}` : '', repeated.length ? `named twice ${repeated.join(', ')}` : ''].filter(Boolean).join('; ')}`);
  return want;
}

// Before the effect (12.5): the guard again, against the decision recorded with the answer. A must-fix
// flow's authorization always records the guard digest it was given under; a different digest (a
// ledger change, a restriction, a new review) refuses it, as does an open must-fix item, and an
// operator decision taken by anyone but the operator. `decision`: the merge authorization or the
// accepted outcome decision. Returns the guard, or null for a severity or shadow flow.
export const REVIEW_DECISION_CHANGED = 'the review decision changed since the answer';
export function verifyReviewDecision(flow, decision, { risk = 'strict', restriction = null } = {}) {
  const guard = reviewDecisionGuard(flow, { risk, restriction });
  if (!guard) return null;
  assert(!guard.blocked.length, `a must-fix item is open (${guard.blocked.join(', ')}): it must be fixed (send it back) before a merge or an accepted outcome`);
  assert(decision?.reviewDecisionDigest === guard.digest, `${REVIEW_DECISION_CHANGED} (its findings, the ledger, the restriction or the review it rests on): answer the reopened question again`);
  if (guard.operator) {
    assert(decision.actor === 'operator' && (decision.authority ?? 'operator') === 'operator', `the merge decision is the operator's (${guard.reasons.map(row => row.reason).join(', ')}): a delegated or automatic answer does not apply`);
    if (risk !== 'strict') assertAcknowledged(guard.acknowledgements, decision.acknowledgedFindings, 'this decision');
  }
  return guard;
}
// Whether a recorded decision of a must-fix flow no longer matches its guard or its strict requirement
// (a restriction, a ledger change or a new review since the answer). The engine then refuses it before
// the effect and reopens the question rather than stopping the flow. `requirement`: the current strict
// requirement, or null. Returns the reason, or null.
export function staleDecision(flow, decision, guard, requirement) {
  if (!guard || !decision) return null;
  if (decision.reviewDecisionDigest !== guard.digest) return `${REVIEW_DECISION_CHANGED}: the guard digest it was given under no longer matches (restriction version ${guard.restriction.version})`;
  if (requirement?.bar === 'must-fix' && decision.riskAssessmentDigest !== requirement.assessmentDigest) return `${REVIEW_DECISION_CHANGED}: the strict requirement it acknowledged no longer matches`;
  return null;
}
