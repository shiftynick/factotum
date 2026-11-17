// The must-fix test (docs/designs/review-must-fix.md 4, 5, 10, 11 and 14.2). Slice 1: factory
// finding ids, citation validation and the derivation of section 4.3. Slice 2: the purpose block and
// assessment (10), purpose synthesis (4.3 rule 2), the fail-closed protocol checks (5.4) and the
// shadow route, version v2.
//
// Nothing here routes a flow. A shadow flow's review records what the must-fix bar would have done
// beside the route today's severity bar took (workflows/dispatch.mjs). A severity flow never calls
// into this file. A flow pinned to `must-fix` exists only in test fixtures until the enabling
// release (core/review-bar.mjs); there the dispatcher acts on the protocol checks.
//
// What shadow route v2 can and cannot estimate (design 14.2). It is the per-finding derivation of
// 4.3 with citation validation, purpose synthesis (an unmet outcome or criterion, or a silent wrong
// answer, that no must-fix finding covers adds one) and the protocol checks with their one
// correction review, on the review that actually ran. It has no ledger (earlier findings are not
// judged, an omitted judgement and a `fixOf` naming no ledger entry are not checked, and later-round
// behaviour and the cap are not shown), no confirmation of a reviewer's exclusion (so no exclusion is
// ever `supported`) and no builder deferral. It measures the purpose catch rate; it is never used to
// decide enabling (only v3 may be, 14.2).
import { digest } from '../core/contracts.mjs';
import { validateSchema, MUST_FIX_FINDING_SCHEMA } from '../adapters/providers/index.mjs';
import { MUST_FIX_SCHEMA_VERSION } from '../core/review-bar.mjs';

export const SHADOW_ROUTE_VERSION = 'v2';
export const SHADOW_V1_OMITS = Object.freeze(['purpose-synthesis', 'protocol-failure', 'ledger', 'exclusion-confirmation', 'deferral', 'cap']);
export const SHADOW_V2_OMITS = Object.freeze(['ledger', 'exclusion-confirmation', 'deferral', 'cap']);
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
// A finding's bar is read from the finding itself: a shadow row's derived fields may describe a
// protocol correction's findings rather than the recorded ones (mustFix.basis).
export function reviewFindingIds(flow) {
  return (flow?.reviewHistory ?? []).map((row, position) => ({ round: position + 1, attemptId: row.attemptId ?? null, step: row.step ?? null, findings: (row.result?.findings ?? []).map((finding, index) => ({ id: findingId(position + 1, index), bar: mustFixShaped(finding) ? 'must-fix' : 'legacy', severity: finding?.severity ?? null, message: finding?.message ?? null })) }));
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
// finding covers adds one. `purpose` is the purpose assessment of 5.2. Outcome `partly` or
// `unverified`, an `unverified` criterion and an `unknown` silent answer name no scenario to fix, so
// they never start a builder round; they go to the decision guard and the strict acknowledgement
// list (12.5, 7.4).
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

// The route the must-fix bar would have taken on this review (6.1, 7.3) without the protocol checks:
// version v1, and the part of v2 after them. `review`: { strict, incomplete, bounded, phase,
// satisfied } as today's routing computed them.
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

// Version v2 (14.2): a protocol failure (5.4) comes first, before the legacy fallback, the strict
// checks and every other route, whatever the review reports. A change review parks; the satisfied
// review, whose only other route is revise, revises (6.5); a plan review has no park edge, so it
// stops at plan review without following any edge (6.4), recorded as the route `stop`.
export function shadowRouteV2(derived, review, { failure = false } = {}) {
  if (failure) return review.plan ? { route: 'stop', disposition: 'protocol-failure' } : { route: review.satisfied ? 'revise' : 'park', disposition: 'protocol-failure' };
  return review.plan ? shadowPlanRouteV1(derived) : shadowRouteV1(derived, review);
}

// The derived fields of one review (5.3), recorded on the review and its history row.
// `basis`: whose findings were derived, the original result or its protocol correction's.
// `protocol`: the protocol checks (5.4): the original result's contradictions, the correction
// review when one ran ({ contradictions } or { error }), and whether it failed.
export function mustFixRecord({ derivation, schema = MUST_FIX_SCHEMA_VERSION, round, prefix = 'R', schemaFallback = null, basis = 'original', protocol = null, purpose = null }) {
  return { schema, ...(schemaFallback ? { schemaFallback } : {}), round, idPrefix: prefix, basis, risk: derivation.risk, escalated: derivation.escalated, findings: derivation.findings, counts: Object.fromEntries(['must-fix', 'operator-item', 'follow-up'].map(kind => [kind, derivation.findings.filter(row => row.kind === kind).length])), legacy: derivation.findings.filter(row => row.bar === 'legacy').length, purpose, protocol };
}
// The shadow record of one review: the derived fields and shadowRoute v2, beside the route the
// review actually took. `actual` is today's { route, disposition }.
export function shadowRecord({ route, actual, verdict, ...fields }) {
  const blocking = ['revise', 'adjudicate', 'park', 'stop'].includes(route.route);
  return {
    mustFix: mustFixRecord(fields),
    shadowRoute: { version: SHADOW_ROUTE_VERSION, estimate: true, omits: SHADOW_V2_OMITS, route: route.route, disposition: route.disposition, actualRoute: actual.route ?? null, actualDisposition: actual.disposition ?? null, differs: route.route !== actual.route, verdictOverridden: (verdict === 'revise') !== blocking },
  };
}

// ---- Purpose first (10) and the protocol checks (5.4) ----

const quoted = text => JSON.stringify(String(text).length > 160 ? `${String(text).slice(0, 157)}...` : String(text));
// The contradictions in one result, as factory sentences; empty when it passes every check. A result
// with no purpose assessment (one valid only against today's schema, 5.5) is contradictory.
// Checked here: the purpose assessment is present; it lists each acceptance line of the task exactly
// as often as the task does, by exact text, and nothing else; a `yes` silent answer comes with at
// least one finding marked `silent`. The ledger checks (`fixOf` names a ledger entry, every awaiting
// entry is judged, a `relevance` for every builder citation) need the ledger and come with it.
export function protocolContradictions(result, task) {
  const purpose = result?.purpose;
  if (!purpose || typeof purpose !== 'object' || !Array.isArray(purpose.acceptance)) return ['the purpose assessment is missing'];
  const out = [], acceptance = Array.isArray(task?.acceptance) ? task.acceptance : [], listed = purpose.acceptance.map(row => row?.criterion);
  const count = (list, text) => list.filter(item => item === text).length;
  for (const [index, criterion] of acceptance.entries()) {
    if (acceptance.indexOf(criterion) !== index) continue;
    const expected = count(acceptance, criterion), found = count(listed, criterion);
    if (!found) out.push(`purpose.acceptance omits criterion ${index + 1}, ${quoted(criterion)}`);
    else if (found !== expected) out.push(`purpose.acceptance lists criterion ${index + 1}, ${quoted(criterion)}, ${found} times instead of ${expected === 1 ? 'once' : `${expected} times`}`);
  }
  for (const text of new Set(listed.filter(item => !acceptance.includes(item)))) out.push(`purpose.acceptance lists ${quoted(text ?? '')}, which is not an acceptance criterion of this task`);
  if (purpose.silentWrongAnswer?.answer === 'yes' && !(result.findings ?? []).some(finding => finding?.silent === true)) out.push('purpose.silentWrongAnswer is yes, but no finding is marked silent');
  return out;
}
// What the purpose assessment said, kept with the derived fields: whether the task has an outcome
// (a task without one is labelled, 10.1), the outcome, and the criteria that are not met or not verified.
export function purposeSummary(result, task) {
  const purpose = result?.purpose, outcomeRecorded = typeof task?.outcome === 'string' && task.outcome.trim() !== '';
  if (!purpose || typeof purpose !== 'object') return { outcomeRecorded, assessed: false };
  const criteria = status => (purpose.acceptance ?? []).filter(row => row?.status === status).map(row => row.criterion);
  return { outcomeRecorded, assessed: true, outcome: purpose.outcome ?? null, notMet: criteria('not-met'), unverified: criteria('unverified'), silentWrongAnswer: purpose.silentWrongAnswer?.answer ?? null };
}
// The correction review's instruction (5.4): the contradiction stated, then a fresh look.
export const protocolCorrectionPrompt = (contradictions, original) => `\nA previous fresh review returned a result that fails the factory's protocol checks: ${JSON.stringify(contradictions)}. Its result was: ${JSON.stringify(original ?? null)}. Independently re-examine the same work from the start. Answer the purpose questions in full: list every acceptance criterion exactly once, by its exact text, and if a silent wrong answer is possible report at least one finding with silent: true. Do not assume the previous verdict was right.`;

// The purpose block (10.1), put before the material under review so the reviewer answers it first:
// the outcome verbatim, or a label when the task has none; each criterion, numbered; for a change
// review, the reviewed plan's summary, checks and risks; and the protected classes. Declared
// environment facts follow with the must-fix fields. The ledger entries awaiting judgement join it
// with the ledger.
export function purposeBlock({ task, plan = null, subject }) {
  const outcome = typeof task?.outcome === 'string' && task.outcome.trim() ? `Outcome: ${JSON.stringify(task.outcome)}` : 'Outcome: none recorded for this task. Judge the outcome by its title and acceptance criteria.';
  const criteria = (task?.acceptance ?? []).map((criterion, index) => `${index + 1}. ${JSON.stringify(criterion)}`).join('\n') || '(none)';
  const reviewed = subject === 'change' ? `\nReviewed plan: ${JSON.stringify({ summary: plan?.summary ?? null, checks: plan?.checks ?? [], risks: plan?.risks ?? [] })}` : '';
  return `Purpose first. Answer these two questions in purpose before you look for defects.\n${outcome}\nAcceptance criteria:\n${criteria}${reviewed}\nProtected classes: security (access control, authentication, secrets, trust boundaries, injection), data-loss (loss or corruption of saved data, destructive operations, migrations that cannot be undone), spending (money or metered usage spent without authority or beyond a limit), check-trust (anything that can make a check, a review or other evidence report a pass that is not true, or attach evidence to the wrong candidate).\n1. Does ${subject === 'plan' ? 'the plan, once built, do' : 'the change do'} what its task says? Report purpose.outcome (met, partly, not-met or unverified) and purpose.acceptance: one entry for each criterion above, exactly once, with its exact text (without the number), a status (met, not-met or unverified) and up to 4 evidence citations. unverified is honest when you cannot run code.\n2. Can it give a wrong answer silently? Report purpose.silentWrongAnswer: answer no; yes, with how, and then report at least one finding with silent: true; or unknown, with settle saying what would settle it; and up to 4 evidence citations. The usual forms: a check that passes without running what it claims to, results attached to the wrong candidate or head, stale inputs read as current, an error swallowed into a default value, a fallback that hides a failure.`;
}

// The must-fix questions a shadow review is asked (5.1, 11), appended to today's prompt, which is
// otherwise unchanged. `records`: this flow's records a reviewer may cite, as citationStatus reads them.
// `enforced`: a must-fix flow (test fixtures only until the enabling release), where they are acted on.
export function mustFixGuidance({ subject, facts = [], records = [], enforced = false }) {
  const where = subject === 'plan' ? 'the current code' : 'the reviewed candidate';
  const trial = enforced ? 'the factory derives from them which findings must be fixed, and checks the purpose assessment: a result that contradicts itself is reviewed again, and a second contradiction stops for the operator' : 'a shadow trial: they are recorded beside this review and do not change how it is routed; keep verdict, severity and every other field exactly as you would without them';
  return `\nMust-fix fields (${trial}). For every finding also report: scenario, the concrete inputs, environment and state, the path taken and the wrong result; reachable, with status shown (cited evidence shows the scenario can happen in this project's real setup), unknown (you cannot tell) or not-here (evidence shows it cannot happen here), up to 4 evidence citations, and coverage, how the evidence taken together covers the complete scenario; purposeImpact: outcome (it breaks what the task is for), security, data-loss, spending or check-trust (anything that can make a check, review or other evidence report a pass that is not true, or attach evidence to the wrong candidate), or none; silent: true when the wrong result comes with no error and no failing check; origin: new-code, in-fix (in code an earlier round's fix added) or missed (in code an earlier round reviewed without reporting it); fixOf: null. Each citation has kind, ref, quote, head, check, result and covers (which part of the scenario it covers, and how). file: ref is a repository path and quote the exact text it relies on, at ${where}. environment: ref is the id of a declared environment fact. record: ref is the id of one of this flow's records, with head, check and result exactly as recorded. reasoning: ref "-". Unused values are null, or "" for quote. The factory checks every citation: a quote not in the file, or a record for another candidate, contradicts the claim, and shown without a validated citation is read as unknown. A citation that exists does not by itself show that it covers the scenario. Declared environment facts: ${JSON.stringify(facts)}. Records of this flow: ${JSON.stringify(records)}.`;
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
