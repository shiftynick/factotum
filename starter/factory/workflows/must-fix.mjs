// The must-fix test, slice 1 (docs/designs/review-must-fix.md 4, 5, 11 and 14.2): factory finding
// ids, citation validation, the derivation of section 4.3 and the shadow route, version v1.
//
// Nothing here routes a flow. A shadow flow's review records what the must-fix bar would have done
// beside the route today's severity bar took (workflows/dispatch.mjs). A severity flow never calls
// into this file.
//
// What shadow route v1 can and cannot estimate (design 14.2). It is the per-finding derivation of
// 4.3 with citation validation, on the review that actually ran, and nothing more: no purpose
// synthesis (an unmet criterion or a silent wrong answer adds no must-fix finding, so v1 understates
// blocking), no protocol-failure check, no ledger (earlier findings are not judged, so later-round
// behaviour and the cap are not shown), no confirmation of a reviewer's exclusion (so no exclusion is
// ever `supported`) and no builder deferral. It is for schema and prompt health only and is never
// used to decide enabling.
import { digest } from '../core/contracts.mjs';
import { validateSchema, MUST_FIX_FINDING_SCHEMA } from '../adapters/providers/index.mjs';
import { MUST_FIX_SCHEMA_VERSION } from '../core/review-bar.mjs';

export const SHADOW_ROUTE_VERSION = 'v1';
export const SHADOW_V1_OMITS = Object.freeze(['purpose-synthesis', 'protocol-failure', 'ledger', 'exclusion-confirmation', 'deferral', 'cap']);
export const PROTECTED_CLASSES = Object.freeze(['security', 'data-loss', 'spending', 'check-trust']);
export const CONTRADICTING = Object.freeze(['not-found', 'stale']);
const KIND_RANK = { 'follow-up': 0, 'operator-item': 1, 'must-fix': 2 };
const collapse = text => String(text).replace(/\s+/gu, ' ').trim();

// Factory ids (5.3): R<round>.<index> for a change review, where round is the review's position in
// the flow's review history, counted from 1. Plan reviews are not in that history, so their
// findings are P<visit>.<index>, by the plan-review step's visit.
export const findingId = (round, index, prefix = 'R') => `${prefix}${round}.${index + 1}`;
// Every finding of a flow's review history with its id, derived from the row's position on read, so
// rows written before ids existed need no migration (5.5). Their findings are `legacy`.
export function reviewFindingIds(flow) {
  return (flow?.reviewHistory ?? []).map((row, position) => ({ round: position + 1, attemptId: row.attemptId ?? null, step: row.step ?? null, findings: (row.result?.findings ?? []).map((finding, index) => ({ id: findingId(position + 1, index), bar: row.mustFix?.findings?.[index]?.bar ?? 'legacy', severity: finding?.severity ?? null, message: finding?.message ?? null })) }));
}

// A finding in the must-fix shape (5.1). One without it (an old adapter, a scripted provider, a
// recorded result) is a legacy finding, and legacy findings are must-fix: today's meaning, where
// every reported finding blocks (5.5).
export function mustFixShaped(finding) { try { validateSchema(finding, MUST_FIX_FINDING_SCHEMA); return true; } catch { return false; } }

// A repository path a file citation may name: relative, inside the repository, no `..` (11.2).
export function citedPath(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 300 || ref.startsWith('/') || /[\0\\]/.test(ref)) return null;
  const parts = ref.split('/').filter(part => part && part !== '.');
  return parts.length && !parts.includes('..') ? parts.join('/') : null;
}
// The repository paths a review's file citations name, to be read at the reviewed head.
export const citedPaths = findings => [...new Set((findings ?? []).filter(mustFixShaped).flatMap(finding => finding.reachable.evidence).filter(citation => citation.kind === 'file').map(citation => citedPath(citation.ref)).filter(Boolean))];

// Citation validation, by the factory (11.2). `context`:
// - claimHead: the candidate the claim is about (the reviewed head, for a reviewer's claim);
// - files: Map of repository path to its text at claimHead, null when it is not there, absent when
//   it could not be read;
// - facts: the ids of the flow's pinned environment facts;
// - records: Map of this flow's record ids to { head, checks: { [check]: result } }.
// Validated says the cited thing exists as cited; it never says the claim is right (11.3).
export function citationStatus(citation, { claimHead = null, files = new Map(), facts = new Set(), records = new Map() } = {}) {
  switch (citation?.kind) {
    case 'file': {
      const path = citedPath(citation.ref);
      if (!path) return 'not-found';
      const quote = collapse(citation.quote ?? '');
      if (!quote || !files.has(path)) return 'not-checkable';
      const text = files.get(path);
      return text !== null && collapse(text).includes(quote) ? 'validated' : 'not-found';
    }
    case 'environment': return facts.has(citation.ref) ? 'validated' : 'unknown-ref';
    case 'record': {
      // The record belongs to this flow, was produced for the cited head, that head is the one the
      // claim is about, and the cited check's recorded result is the cited result.
      const record = records.get(citation.ref);
      if (!record || typeof citation.head !== 'string' || !citation.head) return 'unknown-ref';
      if (citation.head !== claimHead || record.head !== citation.head) return 'stale';
      return typeof citation.check === 'string' && Object.hasOwn(record.checks ?? {}, citation.check) && record.checks[citation.check] === citation.result ? 'validated' : 'unknown-ref';
    }
    default: return 'not-checkable';
  }
}

// The support status of a reviewer's own exclusion (11.3). `confirmed`: someone other than its
// author confirmed it (the operator, or a later review on a different model family). Shadow v1 has
// no confirmation, so its exclusions are never `supported`.
export function exclusionSupport(statuses, coverage, { confirmed = false } = {}) {
  if (statuses.some(status => CONTRADICTING.includes(status))) return 'contradicted';
  if (!statuses.includes('validated')) return 'unsupported';
  if (!collapse(coverage ?? '')) return 'existence-only';
  return confirmed ? 'supported' : 'unconfirmed';
}

// The table of 4.3, for a finding whose reachability has already been read under rule 1.
function tableKind(impact, reachable, support, risk) {
  if (impact === 'none') return { kind: 'follow-up', reason: 'purpose-none' };
  if (impact === 'outcome') {
    if (reachable === 'shown') return { kind: 'must-fix', reason: 'outcome-shown' };
    if (reachable === 'unknown') return { kind: 'operator-item', reason: 'unresolved-scenario' };
    if (support === 'supported') return { kind: 'follow-up', reason: 'supported-exclusion' };
    return support === 'unconfirmed' ? { kind: 'operator-item', reason: 'unconfirmed-exclusion' } : { kind: 'operator-item', reason: 'unsupported-exclusion' };
  }
  // A protected class. In strict work only a supported exclusion stops blocking, and only the
  // operator may accept it; every other exclusion status blocks.
  if (risk === 'strict') return reachable === 'not-here' && support === 'supported' ? { kind: 'operator-item', reason: 'protected-exclusion', operatorOnly: true } : { kind: 'must-fix', reason: 'protected-class' };
  return reachable === 'shown' ? { kind: 'must-fix', reason: 'protected-class', escalates: true } : { kind: 'operator-item', reason: 'protected-class', operatorOnly: true };
}

// One finding's kind (4.3). `context` adds to citationStatus's:
// - risk: the flow's effective risk, `ordinary` or `strict`;
// - strictFollowups: the pinned policy.review.strictFollowups (7.1);
// - confirmed: a reviewer's exclusion was confirmed by someone else (11.3);
// - restriction: an active review.restrict (13.4), { protectedClassDeferral, operatorDisposition }.
export function deriveFinding(finding, context = {}) {
  const { risk = 'strict', strictFollowups = false, confirmed = false, restriction = null } = context;
  if (!mustFixShaped(finding)) return { bar: 'legacy', kind: 'must-fix', reason: 'legacy-severity' };
  const evidence = finding.reachable.evidence, citations = evidence.map(citation => citationStatus(citation, context));
  const impact = finding.purposeImpact, protectedClass = PROTECTED_CLASSES.includes(impact);
  // Rule 1: `shown` needs a validated citation; a contradicting one also marks the claim.
  let reachable = finding.reachable.status, downgraded = null;
  const contradicted = citations.some(status => CONTRADICTING.includes(status));
  if (reachable === 'shown' && contradicted) { reachable = 'unknown'; downgraded = 'contradicted'; }
  else if (reachable === 'shown' && !citations.includes('validated')) { reachable = 'unknown'; downgraded = evidence.length && evidence.every(citation => citation.kind === 'reasoning') ? 'reasoning-only' : 'no-validated-citation'; }
  const support = reachable === 'not-here' ? exclusionSupport(citations, finding.reachable.coverage, { confirmed }) : null;
  let derived = tableKind(impact, reachable, support, risk);
  // Rule 3: a reviewer's `critical` is never cleared without the operator.
  if (finding.severity === 'critical' && derived.kind !== 'must-fix') derived = { kind: 'operator-item', reason: 'critical' };
  // Rule 4: restrictions apply last and only tighten.
  if (restriction?.protectedClassDeferral === false && protectedClass && reachable === 'not-here') {
    const tighter = tableKind(impact, 'unknown', null, risk);
    if (KIND_RANK[tighter.kind] > KIND_RANK[derived.kind]) derived = { ...tighter, restricted: true };
  }
  if (restriction?.operatorDisposition === 'all' && derived.kind === 'follow-up') derived = { kind: 'operator-item', reason: 'restricted', operatorOnly: true };
  // Strict work without policy.review.strictFollowups keeps today's bar (7.1): every reported finding
  // blocks. The kind the table gave is kept as the reason.
  const strictBar = risk === 'strict' && !strictFollowups && derived.kind !== 'must-fix';
  const kind = strictBar ? 'must-fix' : derived.kind;
  const record = { bar: 'must-fix', kind, reason: derived.reason, reachable: { reported: finding.reachable.status, read: reachable }, citations, purposeImpact: impact, silent: finding.silent, origin: finding.origin, ...(downgraded ? { downgraded } : {}), ...(contradicted ? { contradicted: true } : {}), ...(support ? { support } : {}), ...(derived.operatorOnly && kind !== 'must-fix' ? { operatorOnly: true } : {}), ...(derived.escalates && risk === 'ordinary' ? { escalates: true } : {}), ...(derived.restricted ? { restricted: true } : {}), ...(strictBar ? { strictBar: derived.kind } : {}) };
  return { ...record, claimDigest: digest({ finding, citations, support: support ?? null }) };
}

// Rule 2 (10.3): an unmet outcome or criterion, or a possible silent wrong answer, that no must-fix
// finding covers adds one. `purpose` is the purpose assessment of 5.2 (slice 2); shadow v1 has none.
function purposeFindings(purpose, derived) {
  if (!purpose) return [];
  const mustFix = derived.filter(row => row.kind === 'must-fix'), added = [];
  const unmet = purpose.outcome === 'not-met' || (purpose.acceptance ?? []).some(row => row.status === 'not-met');
  if (unmet && !mustFix.some(row => row.purposeImpact === 'outcome')) added.push({ bar: 'must-fix', kind: 'must-fix', reason: 'unmet-acceptance', added: true });
  if (purpose.silentWrongAnswer?.answer === 'yes' && !mustFix.some(row => row.silent === true)) added.push({ bar: 'must-fix', kind: 'must-fix', reason: 'silent-wrong-answer', added: true });
  return added;
}

// Every finding of one review, with ids. An ordinary flow with a `shown` protected-class finding
// would become strict (4.3, escalation), so its findings are derived again under strict rules.
export function deriveReview(findings, { round, prefix = 'R', purpose = null, ...context } = {}) {
  const derive = risk => (findings ?? []).map(finding => deriveFinding(finding, { ...context, risk }));
  let risk = context.risk ?? 'strict', derived = derive(risk);
  const escalated = risk === 'ordinary' && derived.some(row => row.escalates);
  if (escalated) { risk = 'strict'; derived = derive(risk).map((row, index) => derived[index].escalates ? { ...row, escalates: true } : row); }
  derived = [...derived, ...purposeFindings(purpose, derived)];
  return { risk, escalated, findings: derived.map((row, index) => ({ id: findingId(round, index, prefix), ...row })) };
}

// The route the must-fix bar would have taken on this review (6.1, 7.3), version v1.
// `review`: { strict, incomplete, bounded, phase, satisfied } as today's routing computed them.
export function shadowRouteV1(derived, { strict, incomplete = false, bounded = false, phase = 'full', satisfied = false }) {
  const mustFix = derived.some(row => row.kind === 'must-fix'), items = derived.some(row => row.kind !== 'must-fix');
  const pick = (route, disposition) => ({ route, disposition });
  if (strict && incomplete) return pick(phase === 'final' ? 'park' : 'revise', 'incomplete');
  // The satisfied review routes only pass and revise (6.5); its items are recorded, not deferred.
  if (satisfied) return mustFix ? pick('revise', 'correct') : pick('pass', 'accepted');
  const open = (pass = pick('pass', 'accepted')) => items ? pick('defer', 'followup-required') : pass;
  if (!bounded) return mustFix ? pick('revise', 'correct') : open();
  if (strict) {
    if (phase === 'ordinary') return pick('delta', 'escalated-full-review-required');
    // A strict full phase never defers, so the delta review cannot be skipped (7.3).
    if (phase === 'full') return mustFix ? pick('revise', 'correct') : pick('delta', 'full-reviewed');
    if (phase === 'final') return mustFix ? pick('adjudicate', 'operator-adjudication') : open();
    return mustFix ? pick('revise', 'correct') : open();
  }
  return mustFix ? (phase === 'final' ? pick('park', 'parked') : pick('revise', 'correct')) : open();
}

// The plan review's shadow outcome (6.4): a must-fix plan finding revises; every other finding would
// be an advisory note carried into the build brief.
export const shadowPlanRouteV1 = derived => derived.some(row => row.kind === 'must-fix') ? { route: 'revise', disposition: 'correct' } : { route: 'pass', disposition: derived.length ? 'accepted-with-plan-notes' : 'accepted' };

// The shadow record of one review: the derived fields of every finding and shadowRoute v1, beside
// the route the review actually took. `actual` is today's { route, disposition }.
export function shadowRecord({ derivation, route, actual, verdict, schema = MUST_FIX_SCHEMA_VERSION, round, prefix = 'R' }) {
  const blocking = ['revise', 'adjudicate', 'park'].includes(route.route);
  return {
    mustFix: { schema, round, idPrefix: prefix, risk: derivation.risk, escalated: derivation.escalated, findings: derivation.findings, counts: Object.fromEntries(['must-fix', 'operator-item', 'follow-up'].map(kind => [kind, derivation.findings.filter(row => row.kind === kind).length])), legacy: derivation.findings.filter(row => row.bar === 'legacy').length },
    shadowRoute: { version: SHADOW_ROUTE_VERSION, estimate: true, omits: SHADOW_V1_OMITS, route: route.route, disposition: route.disposition, actualRoute: actual.route ?? null, actualDisposition: actual.disposition ?? null, differs: route.route !== actual.route, verdictOverridden: (verdict === 'revise') !== blocking },
  };
}

// The must-fix questions a shadow review is asked (5.1, 11), appended to today's prompt, which is
// otherwise unchanged. `records`: this flow's records a reviewer may cite, as citationStatus reads them.
export function mustFixGuidance({ subject, facts = [], records = [] }) {
  const where = subject === 'plan' ? 'the current code' : 'the reviewed candidate';
  return `\nMust-fix fields (a shadow trial: they are recorded beside this review and do not change how it is routed; keep verdict, severity and every other field exactly as you would without them). For every finding also report: scenario, the concrete inputs, environment and state, the path taken and the wrong result; reachable, with status shown (cited evidence shows the scenario can happen in this project's real setup), unknown (you cannot tell) or not-here (evidence shows it cannot happen here), up to 4 evidence citations, and coverage, how the evidence taken together covers the complete scenario; purposeImpact: outcome (it breaks what the task is for), security, data-loss, spending or check-trust (anything that can make a check, review or other evidence report a pass that is not true, or attach evidence to the wrong candidate), or none; silent: true when the wrong result comes with no error and no failing check; origin: new-code, in-fix (in code an earlier round's fix added) or missed (in code an earlier round reviewed without reporting it); fixOf: null. Each citation has kind, ref, quote, head, check, result and covers (which part of the scenario it covers, and how). file: ref is a repository path and quote the exact text it relies on, at ${where}. environment: ref is the id of a declared environment fact. record: ref is the id of one of this flow's records, with head, check and result exactly as recorded. reasoning: ref "-". Unused values are null, or "" for quote. The factory checks every citation: a quote not in the file, or a record for another candidate, contradicts the claim, and shown without a validated citation is read as unknown. A citation that exists does not by itself show that it covers the scenario. Declared environment facts: ${JSON.stringify(facts)}. Records of this flow: ${JSON.stringify(records)}.`;
}

// The records of a flow a shadow review may cite (11.2): its settled attempts, newest last, each
// with the head it ran on (the input the engine verified before dispatch) and its recorded results:
// the route and each check's status.
export const CITABLE_RECORD_LIMIT = 30;
export function citableRecords(attempts) {
  return (attempts ?? []).filter(attempt => ['passed', 'failed'].includes(attempt.status) && attempt.receipt?.actionResult && /^[a-f\d]{40,64}$/i.test(attempt.intent?.inputIdentity?.head ?? ''))
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? ''))).slice(-CITABLE_RECORD_LIMIT)
    .map(attempt => { const result = attempt.receipt.actionResult; return { id: attempt.id, step: attempt.step, head: attempt.intent.inputIdentity.head, checks: { ...(typeof result.route === 'string' ? { route: result.route } : {}), ...Object.fromEntries((Array.isArray(result.checks) ? result.checks : []).filter(check => typeof check?.id === 'string' && check.id !== 'route' && typeof check.status === 'string').slice(0, 20).map(check => [check.id, check.status])) } }; });
}
