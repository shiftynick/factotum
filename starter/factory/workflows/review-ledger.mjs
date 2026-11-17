// The review ledger (docs/designs/review-must-fix.md 8, 11.3, 5.2 and 14.2), slice 3: one entry per
// finding of a flow's change reviews, by factory id, with its status and every later judgement of it.
//
// The ledger is derived, never migrated (8.1, 14.3): `replayLedger` reads a flow's review history in
// order, and the engine stores the result as `flow.reviewLedger` each time a review is recorded, so
// the stored ledger always equals a recomputation. The replay reads only what each history row
// recorded when its review ran: the reviewed head, the derived fields (`mustFix`: each finding's kind,
// the reviewer's provider, family and session, the family the review was expected to run on, and the
// validation of each judgement's citations), the result the fields were derived from, and the shadow
// route; and, in a must-fix flow (slice 4), the builder's dispositions each review row records from
// the build before it, and the operator's dispositions (`flow.disposeFinding`, stored on the flow,
// each applied after the review it followed). A missing builder disposition is read as a claimed fix (9.1).
//
// Statuses. A must-fix entry is `open` when raised or judged `fix-incomplete`; once a later review
// runs at another head it is `fixed-claimed` and awaits judgement; `fix-holds` makes it `fixed`. Every
// other entry's status is its kind, `operator-item` or `follow-up`. A finding the factory added for
// unmet purpose (4.3 rule 2) is settled by the next review's purpose assessment instead of a
// judgement: `fixed` when that review adds none for the same reason, `superseded` by the one it adds
// otherwise (a status the design does not list; it keeps one open entry per unmet purpose).
//
// Support of a reviewer's own exclusion (11.3). A `not-here` whose citations validate and whose
// coverage is stated is `unconfirmed`, and an operator item, until a later review in a fresh session
// on a different model family, shown the entry as awaiting its judgement, returns
// `exclusion-confirmed` with its own coverage and no contradicted citation. Nothing else confirms it:
// not its author, not the validated fact it cites, not a review on the same family, not a passing
// check. `exclusion-rejected` from any later review derives it again as `unknown`; a tightening needs
// no independence.
//
// Builder deferral (9, slice 4; only a must-fix flow's builder can defer). A valid `deferred`
// disposition of an open must-fix entry makes it `deferred-claimed`, awaiting the next reviewer's
// `deferral-accepted` or `deferral-rejected`, judged by the table of 9.3 (judgeDeferral). A deferral
// with a contradicted citation is void: the entry stays open. Each entry is deferred at most once.
// `contested` (a rejected deferral) and `operator-required` (the operator's disposition) are open
// must-fix entries that can no longer be deferred. `operator-accepted` is a follow-up the operator
// accepted. Every change to an entry raises its `version`, which `flow.disposeFinding` names.
import { digest } from '../core/contracts.mjs';
import { deriveFinding, mustFixShaped, openRoute, protocolFailureRoute, CONTRADICTING, PROTECTED_CLASSES } from './must-fix.mjs';

export const LEDGER_VERSION = 2;
const FIX_JUDGEMENTS = ['fix-holds', 'fix-incomplete'], EXCLUSION_JUDGEMENTS = ['exclusion-confirmed', 'exclusion-rejected'], DEFERRAL_JUDGEMENTS = ['deferral-accepted', 'deferral-rejected'];
export const DEFERRAL_REASONS = Object.freeze(['cant-happen-here', 'not-worth-mechanism']);
// An open must-fix entry: it blocks, and routes revise (or adjudicate, or park at the cap).
export const OPEN = Object.freeze(['open', 'fixed-claimed', 'contested', 'operator-required', 'deferred-claimed']);
export const STATUSES = Object.freeze([...OPEN, 'fixed', 'operator-item', 'follow-up', 'operator-accepted', 'superseded']);
const touch = entry => { entry.version = (entry.version ?? 1) + 1; };
const collapse = text => String(text ?? '').replace(/\s+/gu, ' ').trim();
const quoted = text => JSON.stringify(String(text).length > 160 ? `${String(text).slice(0, 157)}...` : String(text));
const who = reviewer => reviewer ? { provider: reviewer.provider ?? null, model: reviewer.model ?? null, family: reviewer.family ?? null, sessionId: reviewer.sessionId ?? null } : null;

// The result a history row's derived fields describe: a shadow row keeps the original result and,
// when its estimate was derived from its protocol correction, that correction's result (mustFix.basis).
export const basisResult = row => (row?.mustFix?.basis === 'correction' && row.mustFix.protocol?.correction?.result) || row?.result || {};
const isFixEntry = entry => entry.source === 'review' && entry.kind === 'must-fix';
const isExclusion = entry => entry.source === 'review' && entry.reachable?.read === 'not-here';
// An entry the operator disposed of (flow.disposeFinding) keeps that disposition: no reviewer judgement
// re-derives it. `operator-required` is settled only by a later review's fix-holds, or by the
// operator; `operator-accepted` only by the operator. So neither awaits, or admits, an exclusion judgement.
const operatorDisposed = entry => ['operator-required', 'operator-accepted'].includes(entry.status);
const awaitsConfirmation = entry => isExclusion(entry) && entry.support === 'unconfirmed' && !operatorDisposed(entry);

// What an entry awaits from the review about to run at `head`, expected on model family `family`, as
// review round `round` (8.2, 11.3): `fix`, a must-fix entry whose candidate changed since it was
// raised or last judged; `exclusion`, an unconfirmed exclusion whose author's family is known and is
// not `family`. The factory never starts a review only to confirm an exclusion.
function awaits(entry, { head, family, round }) {
  const out = [];
  if (isFixEntry(entry) && (entry.status === 'fixed-claimed' || ['open', 'contested', 'operator-required'].includes(entry.status) && entry.touchedHead !== head)) out.push('fix');
  if (isFixEntry(entry) && entry.status === 'deferred-claimed') out.push('deferral');
  if (awaitsConfirmation(entry) && entry.round < round && entry.excludedBy?.family && family && entry.excludedBy.family !== family) out.push('exclusion');
  return out;
}
export const awaitingEntries = (ledger, view) => (ledger?.entries ?? []).map(entry => ({ entry, awaits: awaits(entry, view) })).filter(row => row.awaits.length);
const allowedJudgements = entry => [...(isFixEntry(entry) ? (entry.status === 'deferred-claimed' ? DEFERRAL_JUDGEMENTS : FIX_JUDGEMENTS) : []), ...(isExclusion(entry) && !operatorDisposed(entry) ? EXCLUSION_JUDGEMENTS : [])];
// The status a fix-incomplete leaves: a contested entry, or one the operator required, stays so.
const reopened = entry => ['contested', 'operator-required'].includes(entry.status) ? entry.status : 'open';

// A judgement's entry: by id; failing that, the legacy fallback (5.5): an entry raised by a finding
// without the must-fix fields, named by its exact message, when exactly one such entry in the ledger
// has it. A message two legacy findings share (in different files, or from different rounds) names
// neither: each needs a judgement by its factory id. Neither the ledger judgement nor today's
// priorFindingsDisposition carries a file, so the message alone must be unambiguous.
const legacyNamed = (entries, message) => [...entries.values()].filter(entry => entry.bar === 'legacy' && entry.message === message);
function entryFor(entries, id) {
  if (typeof id !== 'string') return null;
  if (entries.has(id)) return { entry: entries.get(id), via: 'id' };
  const legacy = legacyNamed(entries, id);
  return legacy.length === 1 ? { entry: legacy[0], via: 'legacy-message' } : null;
}
// The legacy fallback for a reviewer that judged a legacy entry the old way: today's
// priorFindingsDisposition, matched by exact message, with evidence, under the same rule.
const legacyDisposition = (entry, result, entries) => entry.bar === 'legacy' && entry.message !== null && legacyNamed(entries, entry.message).length === 1 ? (Array.isArray(result?.priorFindingsDisposition) ? result.priorFindingsDisposition : []).find(row => row?.finding === entry.message && collapse(row.evidence)) ?? null : null;

// Why the factory refuses a builder's `deferred` disposition of `entry` (9.1), or null when it is
// valid. `finding`: the entry's finding as reported; `context`: { risk, strictFollowups }, the flow's
// effective risk and pinned setting. A must-fix flow's build checks every deferral against this
// before it routes (workflows/dispatch.mjs: a refused deferral makes the build `blocked`, so it
// reaches the operator through the build question); the replay applies only valid ones.
export function deferralRefusal(entry, finding, disposition, { risk = 'strict', strictFollowups = false } = {}) {
  if (!entry) return 'is not a ledger entry';
  if (entry.kind !== 'must-fix' || !OPEN.includes(entry.status)) return `is not an open must-fix item (it is ${entry.status})`;
  if (entry.status === 'contested') return 'is contested: its deferral was rejected, so it must be fixed, or the build returns blocked for the operator';
  if (entry.status === 'operator-required') return 'the operator required it to be fixed';
  if (entry.deferral) return 'was already deferred once; a finding can be deferred once';
  if (entry.source !== 'review' || !mustFixShaped(finding)) return 'has no scenario to defer (a legacy finding, or one the factory added for unmet purpose)';
  if (risk === 'strict' && !strictFollowups) return 'strict work without policy.review.strictFollowups has no builder deferral: every finding requires resolution';
  if (!DEFERRAL_REASONS.includes(disposition?.reason)) return 'a deferral needs reason cant-happen-here or not-worth-mechanism';
  if (disposition.reason === 'not-worth-mechanism' && (entry.purposeImpact !== 'outcome' || risk !== 'ordinary')) return 'not-worth-mechanism is allowed only for outcome findings in ordinary work';
  if (disposition.reason === 'cant-happen-here' && (!(Array.isArray(disposition.evidence) ? disposition.evidence : []).some(citation => citation?.kind && citation.kind !== 'reasoning') || !collapse(disposition.coverage))) return 'cant-happen-here needs at least one citation that is not reasoning, and stated coverage';
  return null;
}
// A builder's dispositions (9.1), as the review that followed the build recorded them (with the
// validation of each citation at the reviewed candidate, which contains the build's output). Only a
// `deferred` one changes an entry; `fixed`, or none, is a claimed fix. A refused or repeated deferral
// (one a stale build result would carry again) changes nothing.
function applyDispositions(entries, findings, dispositions, { round, risk, strictFollowups }) {
  for (const row of Array.isArray(dispositions) ? dispositions : []) {
    if (row?.disposition !== 'deferred') continue;
    const entry = entries.get(row.id);
    if (deferralRefusal(entry, findings.get(row.id), row, { risk, strictFollowups })) continue;
    const citations = Array.isArray(row.citations) ? row.citations : [];
    entry.deferral = { round, reason: row.reason, evidence: Array.isArray(row.evidence) ? row.evidence : [], coverage: collapse(row.coverage).slice(0, 1200), note: collapse(row.note).slice(0, 1200), citations };
    touch(entry);
    // A deferral with a contradicted citation is void: the item stays open, and the builder is told which citation failed.
    if (citations.some(status => CONTRADICTING.includes(status))) entry.deferral.void = { contradicted: citations.flatMap((status, index) => CONTRADICTING.includes(status) ? [index + 1] : []) };
    else entry.status = 'deferred-claimed';
  }
}
// The next reviewer's judgement of a deferral (9.3). `statuses`: the validation of the reviewer's own
// citations. Returns what the deferral became:
// - accepted: `supported` when at least one builder citation validated and is marked covers, none
//   contradicted, and the reviewer stated coverage; `existence-only` when citations validated but none
//   covers or coverage is empty; `unsupported` when none validated;
// - rejected: `contested` with a validated citation of the reviewer's, or when the builder's own
//   evidence is not supported; `disputed` when the reviewer rejected by reasoning alone a deferral
//   whose evidence is supported (a validated citation, none contradicted, coverage stated).
export function deferralOutcome(deferral, judgement, statuses) {
  const builder = deferral.citations, relevance = Array.isArray(judgement.relevance) ? judgement.relevance : [];
  if (judgement.judgement === 'deferral-accepted') {
    if (builder.some((status, index) => status === 'validated' && relevance[index] === 'covers') && collapse(judgement.coverage)) return 'supported';
    return builder.includes('validated') ? 'existence-only' : 'unsupported';
  }
  if ((statuses ?? []).includes('validated')) return 'contested';
  return builder.includes('validated') && collapse(deferral.coverage) ? 'disputed' : 'contested';
}
// What an entry becomes after its deferral is judged. A supported deferral is derived again from the
// builder's evidence, confirmed by the independent reviewer (4.3): `cant-happen-here` as reachability
// not-here, `not-worth-mechanism` as no purpose impact. Every other outcome leaves an operator item,
// or a must-fix entry that can no longer be deferred (`contested`); in strict work a protected class
// whose deferral is not supported stays must-fix (4.3), whatever 9.3 says for other classes.
function judgeDeferral(entry, finding, outcome, { risk, strictFollowups, head }) {
  const deferral = entry.deferral, protectedClass = PROTECTED_CLASSES.includes(entry.purposeImpact);
  deferral.outcome = outcome;
  const contested = () => Object.assign(entry, { kind: 'must-fix', status: 'contested', touchedHead: head });
  if (outcome === 'supported') {
    const restated = deferral.reason === 'not-worth-mechanism' ? { ...finding, purposeImpact: 'none' } : { ...finding, reachable: { status: 'not-here', evidence: deferral.evidence, coverage: deferral.coverage } };
    const derived = deriveFinding(restated, { risk, strictFollowups, confirmed: true, statuses: deferral.citations });
    if (derived.kind === 'must-fix') return contested();
    Object.assign(entry, { kind: derived.kind, status: derived.kind, reason: derived.reason === 'purpose-none' ? 'supported-deferral' : derived.reason, support: 'supported', operatorOnly: derived.operatorOnly === true, claimDigest: digest({ claim: derived.claimDigest, deferral }) });
  } else if (outcome === 'existence-only' || outcome === 'unsupported') {
    if (risk === 'strict' && protectedClass) return contested();
    Object.assign(entry, { kind: 'operator-item', status: 'operator-item', reason: 'unsupported-exclusion', support: outcome, operatorOnly: protectedClass, claimDigest: digest({ finding, deferral }) });
  } else if (outcome === 'disputed') Object.assign(entry, { kind: 'operator-item', status: 'operator-item', reason: 'disputed', support: null, operatorOnly: protectedClass, claimDigest: digest({ finding, deferral }) });
  else contested();
}
// The operator's dispositions (9.5, flow.disposeFinding), each applied after the review it followed.
// `operator-accepted` makes the entry a follow-up the operator accepted (4.3); `operator-required`
// makes it an open must-fix entry that can no longer be deferred.
function applyOperatorDispositions(entries, list, round) {
  for (const row of list) {
    if (row?.afterRound !== round) continue;
    const entry = entries.get(row.id);
    if (!entry) continue;
    entry.operatorDispositions = [...(entry.operatorDispositions ?? []), { disposition: row.disposition, note: row.note ?? null, actor: row.actor ?? null, at: row.at ?? null, version: row.version ?? null }];
    if (row.disposition === 'operator-accepted') Object.assign(entry, { kind: 'follow-up', status: 'operator-accepted' });
    else Object.assign(entry, { kind: 'must-fix', status: 'operator-required' });
    touch(entry);
  }
}

// The ledger after `rows` (a flow's review history, or it with the review being settled appended).
// `policy`: the flow's pinned review policy; `operatorDispositions`: the flow's operator dispositions.
// Returns the ledger and, apart from it, each entry's finding as reported, which the ledger block quotes.
export function replay(rows, policy = {}, { operatorDispositions = [] } = {}) {
  const entries = new Map(), findings = new Map(), strictFollowups = policy?.strictFollowups === true, disposed = Array.isArray(operatorDispositions) ? operatorDispositions : [];
  // An entry derived again after a judgement (11.3), with the judging review's risk (risk only rises).
  const rederive = (entry, risk, head, { confirmed = false, unknown = false } = {}) => {
    const finding = findings.get(entry.id);
    if (!mustFixShaped(finding) || operatorDisposed(entry)) return;
    const derived = deriveFinding(unknown ? { ...finding, reachable: { ...finding.reachable, status: 'unknown' } } : finding, { risk, strictFollowups, confirmed, statuses: entry.citations, inFixEvidence: entry.inFixRule === true });
    const wasMustFix = entry.kind === 'must-fix';
    Object.assign(entry, { kind: derived.kind, reason: derived.reason, reachable: derived.reachable, support: derived.support ?? null, claimDigest: derived.claimDigest, operatorOnly: derived.operatorOnly === true });
    if (derived.kind !== 'must-fix') entry.status = derived.kind;
    else if (!wasMustFix) Object.assign(entry, { status: 'open', touchedHead: head });
  };
  for (const [position, row] of (rows ?? []).entries()) {
    const round = position + 1, head = row?.identity?.head ?? null, record = row?.mustFix ?? null, basis = basisResult(row), risk = record?.risk ?? row?.risk ?? 'strict';
    const reviewer = who(record?.reviewer), view = { head, family: record?.ledger?.expectedFamily ?? null, round };
    // 0. The builder's dispositions from the build before this review (a must-fix flow only).
    applyDispositions(entries, findings, record?.ledger?.dispositions, { round, risk: record?.ledger?.dispositionRisk ?? row?.risk ?? risk, strictFollowups });
    // 1. What this review was shown as awaiting its judgement; a must-fix entry on a changed candidate is a claimed fix (9.1).
    const presented = new Map(awaitingEntries({ entries: [...entries.values()] }, view).map(row => [row.entry.id, row.awaits]));
    for (const entry of entries.values()) if (presented.get(entry.id)?.includes('fix') && entry.status === 'open') { entry.status = 'fixed-claimed'; touch(entry); }
    // 2. Its judgements, each entry judged once (a repeat is a protocol contradiction and is not applied).
    const judged = new Set();
    for (const [index, judgement] of (Array.isArray(basis.ledger) ? basis.ledger : []).entries()) {
      const match = entryFor(entries, judgement?.id);
      if (!match || judged.has(match.entry.id)) continue;
      judged.add(match.entry.id);
      const entry = match.entry, awaited = presented.get(entry.id) ?? [], statuses = record?.ledger?.citations?.[index] ?? [];
      const applied = { round, judgement: judgement.judgement, via: match.via, sameScenario: judgement.sameScenario === true, coverage: collapse(judgement.coverage).slice(0, 300), citations: statuses, reviewer, counted: false };
      // The evidence of a judgement that keeps an entry open, which the builder's correction brief shows (6.3).
      if (['fix-incomplete', 'deferral-rejected'].includes(judgement.judgement) && Array.isArray(judgement.evidence)) applied.evidence = judgement.evidence.slice(0, 4);
      const why = reason => { applied.why = reason; };
      if (!allowedJudgements(entry).includes(judgement.judgement)) why(String(judgement.judgement).startsWith('deferral') ? 'no-deferral' : 'not-applicable');
      else if (judgement.judgement === 'fix-holds') { if (awaited.includes('fix')) { applied.counted = true; Object.assign(entry, { status: 'fixed', touchedHead: head }); } else why('not-awaiting'); }
      else if (judgement.judgement === 'fix-incomplete') {
        // Only the original scenario, unchanged, with evidence (8.2); anything else is a new finding.
        // A contested entry, or one the operator required, stays so: it still cannot be deferred.
        if (judgement.sameScenario !== true) why('not-same-scenario');
        else if (!(judgement.evidence?.length > 0)) why('no-evidence');
        else { applied.counted = true; Object.assign(entry, { status: reopened(entry), touchedHead: head }); }
      } else if (DEFERRAL_JUDGEMENTS.includes(judgement.judgement)) {
        if (!awaited.includes('deferral')) why('not-awaiting');
        else { applied.counted = true; applied.relevance = Array.isArray(judgement.relevance) ? judgement.relevance.slice(0, 4) : []; judgeDeferral(entry, findings.get(entry.id), deferralOutcome(entry.deferral, judgement, statuses), { risk, strictFollowups, head }); applied.outcome = entry.deferral.outcome; }
      } else if (judgement.judgement === 'exclusion-confirmed') {
        if (!awaitsConfirmation(entry)) why('not-unconfirmed');
        else if (!reviewer?.family || reviewer.family === entry.excludedBy?.family) why('same-family');
        else if (!awaited.includes('exclusion')) why('not-awaiting');
        else if (reviewer.sessionId && reviewer.sessionId === entry.excludedBy.sessionId) why('same-session');
        else if (!collapse(judgement.coverage)) why('no-coverage');
        else if (statuses.some(status => CONTRADICTING.includes(status))) why('contradicted');
        else { applied.counted = true; rederive(entry, risk, head, { confirmed: true }); entry.confirmedBy = { round, ...reviewer }; }
      } else { applied.counted = true; rederive(entry, risk, head, { unknown: true }); entry.rejectedIn = round; }
      entry.judgements.push(applied); touch(entry);
    }
    // The legacy fallback, for legacy entries this review did not judge by id.
    for (const entry of entries.values()) {
      if (judged.has(entry.id) || !presented.get(entry.id)?.includes('fix')) continue;
      const old = legacyDisposition(entry, basis, entries);
      if (!old) continue;
      const fixed = old.disposition === 'fixed';
      entry.judgements.push({ round, judgement: fixed ? 'fix-holds' : 'fix-incomplete', via: 'legacy-disposition', sameScenario: !fixed, coverage: collapse(old.evidence).slice(0, 300), citations: [], reviewer, counted: true });
      Object.assign(entry, { status: fixed ? 'fixed' : reopened(entry), touchedHead: head }); touch(entry);
    }
    // 3. Unmet purpose added earlier is settled by this review's purpose assessment.
    const added = (record?.findings ?? []).filter(row => row?.added);
    if (record?.findings) for (const entry of entries.values()) {
      if (entry.source !== 'purpose' || entry.status !== 'open') continue;
      const again = added.find(row => row.reason === entry.reason);
      Object.assign(entry, again ? { status: 'superseded', supersededBy: again.id } : { status: 'fixed', touchedHead: head }); touch(entry);
    }
    // 4. This review's own findings.
    const reported = Array.isArray(basis.findings) ? basis.findings : [];
    const derivedRows = record?.findings ?? reported.map((finding, index) => ({ id: `R${round}.${index + 1}`, bar: mustFixShaped(finding) ? 'must-fix' : 'legacy', kind: 'must-fix', reason: 'not-derived' }));
    for (const [index, derived] of derivedRows.entries()) {
      const finding = derived.added ? null : reported[index] ?? null, shaped = mustFixShaped(finding);
      findings.set(derived.id, finding);
      entries.set(derived.id, {
        id: derived.id, version: 1, round, step: row?.step ?? null, head, source: derived.added ? 'purpose' : 'review', bar: derived.bar ?? null,
        kind: derived.kind, reason: derived.reason ?? null, status: derived.kind === 'must-fix' ? 'open' : derived.kind,
        message: typeof finding?.message === 'string' ? finding.message : null, scenario: shaped ? finding.scenario : null,
        severity: typeof finding?.severity === 'string' ? finding.severity : null, file: typeof finding?.file === 'string' ? finding.file : null, line: Number.isSafeInteger(finding?.line) ? finding.line : null,
        purposeImpact: derived.purposeImpact ?? null, origin: derived.origin ?? null, fixOf: shaped ? finding.fixOf : null,
        reachable: derived.reachable ?? null, citations: [...(derived.citations ?? [])], support: derived.support ?? null, claimDigest: derived.claimDigest ?? null,
        operatorOnly: derived.operatorOnly === true, inFixRule: derived.inFixRule === true,
        raisedBy: reviewer, excludedBy: derived.reachable?.read === 'not-here' ? reviewer : null, touchedHead: head, recorded: false, judgements: [],
      });
    }
    // 5. A route that recorded the operator items and follow-ups (6.1, 6.2): the shadow route, or a
    // must-fix flow's own route.
    if (['defer', 'adjudicate', 'pass'].includes(row?.shadowRoute?.route ?? record?.enforcement?.route)) for (const entry of entries.values()) if (entry.kind !== 'must-fix' && entry.status !== 'superseded' && !entry.recorded) Object.assign(entry, { recorded: true, recordedRound: round });
    // 6. The operator's dispositions made after this review.
    applyOperatorDispositions(entries, disposed, round);
  }
  const list = [...entries.values()];
  const counts = Object.fromEntries(STATUSES.map(status => [status, list.filter(entry => entry.status === status).length]));
  return { ledger: { version: LEDGER_VERSION, rounds: (rows ?? []).length, entries: list, counts }, findings };
}
// The ledger a review about to run is shown (8.2): `view` (replay's result) with the builder's
// dispositions from the build before it applied, as that review's history row will record them.
export function withDispositions(view, dispositions, context) {
  applyDispositions(new Map((view?.ledger?.entries ?? []).map(entry => [entry.id, entry])), view.findings, dispositions, context);
  return view;
}
export const replayLedger = (rows, policy, options) => replay(rows, policy, options).ledger;
// The ledger a flow stores (8.1), recomputed from its review history whenever a review is recorded.
export const computeReviewLedger = flow => replayLedger(flow?.reviewHistory ?? [], flow?.reviewPolicy ?? {}, { operatorDispositions: flow?.operatorFindingDispositions ?? [] });
// The open must-fix entries of a ledger.
export const openMustFix = ledger => (ledger?.entries ?? []).filter(entry => entry.kind === 'must-fix' && OPEN.includes(entry.status));
export const ledgerDigest = ledger => digest(ledger);

// Shadow route v3 (14.2): v2's protocol failure first; then the route of 6.1 and 7.3 (without the cap)
// from the ledger after this review: an open must-fix item from any round, including an earlier fix
// judged incomplete; and operator items or follow-ups no earlier shadow route recorded.
export function shadowRouteV3(ledger, review, { failure = false } = {}) {
  if (failure) return protocolFailureRoute(review);
  const entries = ledger?.entries ?? [];
  return openRoute({ mustFix: entries.some(entry => entry.kind === 'must-fix' && OPEN.includes(entry.status)), items: entries.some(entry => entry.kind !== 'must-fix' && entry.status !== 'superseded' && !entry.recorded) }, review);
}

// The ledger's protocol checks (5.4), for one result (a provider result: the reviewer's family is on
// it). `view`: { ledger, presented }, the ledger before this review and what the prompt showed as
// awaiting. Contradictory: an awaiting entry not judged (an exclusion only when the result really
// came from another family: a provider fallback to the author's family is not asked to confirm); an
// entry judged more than once; a judgement naming no ledger entry; a judgement that does not apply to
// its entry (a fix judgement of an entry that was never must-fix, an exclusion judgement of a finding
// that was not excluded, any deferral judgement, since no deferral exists before enforcement);
// `fix-incomplete` without `sameScenario: true` or without evidence; an `in-fix` finding whose
// `fixOf` names no ledger entry; a `deferral-accepted` without one `relevance` entry for every builder
// citation (slice 4; a deferral awaits judgement only in a must-fix flow).
export function ledgerContradictions(row, { ledger, presented }) {
  const result = row?.result ?? {}, judgements = Array.isArray(result.ledger) ? result.ledger : [], entries = new Map((ledger?.entries ?? []).map(entry => [entry.id, entry])), out = [], counts = new Map();
  for (const judgement of judgements) {
    const match = entryFor(entries, judgement?.id);
    if (!match) { const named = typeof judgement?.id === 'string' ? legacyNamed(entries, judgement.id).length : 0; out.push(named > 1 ? `ledger judges ${quoted(judgement.id)}, which is the message of ${named} legacy entries; judge each by its id` : `ledger judges ${quoted(judgement?.id ?? '')}, which is not a ledger entry`); continue; }
    const { entry } = match;
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    if (!allowedJudgements(entry).includes(judgement.judgement)) out.push(String(judgement.judgement).startsWith('deferral') ? `ledger judges ${entry.id} ${judgement.judgement}, but no deferral of ${entry.id} awaits judgement` : `ledger judges ${entry.id} ${judgement.judgement}, which does not apply to ${entry.id} (it can be judged ${allowedJudgements(entry).join(' or ') || 'by none'})`);
    if (judgement.judgement === 'fix-incomplete' && judgement.sameScenario !== true) out.push(`ledger judges ${entry.id} fix-incomplete without sameScenario: true; a failure that is not the original scenario, unchanged, is a new finding with origin in-fix and fixOf ${entry.id}`);
    if (judgement.judgement === 'fix-incomplete' && !(judgement.evidence?.length > 0)) out.push(`ledger judges ${entry.id} fix-incomplete without evidence`);
    if (judgement.judgement === 'deferral-accepted' && entry.status === 'deferred-claimed') { const want = entry.deferral?.evidence?.length ?? 0, have = Array.isArray(judgement.relevance) ? judgement.relevance.length : 0; if (have !== want) out.push(`ledger judges ${entry.id} deferral-accepted with ${have} relevance ${have === 1 ? 'entry' : 'entries'}, but the builder cited ${want}: give one relevance entry (covers, partial or irrelevant) for every builder citation, in order`); }
  }
  for (const [id, count] of counts) if (count > 1) out.push(`ledger judges ${id} ${count} times instead of once`);
  for (const { entry, awaits: what } of presented ?? []) {
    const required = what.filter(kind => kind !== 'exclusion' || row?.family && row.family !== entry.excludedBy?.family);
    if (!required.length || counts.has(entry.id) || required.every(kind => kind === 'fix') && legacyDisposition(entry, result, entries)) continue;
    out.push(`ledger omits a judgement of ${entry.id}, which awaits judgement (${required.map(kind => ({ fix: 'a claimed fix', deferral: 'a builder\'s deferral to accept or reject' })[kind] ?? 'an exclusion to confirm or reject').join(' and ')})`);
  }
  for (const [index, finding] of (Array.isArray(result.findings) ? result.findings : []).entries()) if (finding?.origin === 'in-fix' && !entries.has(finding.fixOf)) out.push(`finding ${index + 1} has origin in-fix, but its fixOf ${quoted(finding.fixOf ?? 'null')} names no ledger entry`);
  return out;
}

// The mirrored priorFindingsDisposition of a must-fix review (5.2), for readers of the old field
// (today's routing, lesson signals, notifications): each judged entry by its exact message, fix-holds
// as fixed and every other judgement as remaining; and each finding of the immediately previous
// review that was not judged, as remaining, saying why. A shadow review records it beside the
// reviewer's own field and never replaces that field.
export function mirroredDispositions(ledger, result, round) {
  const entries = new Map((ledger?.entries ?? []).map(entry => [entry.id, entry])), judged = new Map(), out = [];
  for (const judgement of Array.isArray(result?.ledger) ? result.ledger : []) { const match = entryFor(entries, judgement?.id); if (match && !judged.has(match.entry.id)) judged.set(match.entry.id, judgement); }
  for (const [id, judgement] of judged) {
    const entry = entries.get(id);
    if (entry.message === null) continue;
    const said = collapse(judgement.coverage) || (judgement.evidence ?? []).map(citation => collapse(citation?.covers)).filter(Boolean).join('; ') || 'no evidence cited';
    out.push({ finding: entry.message, disposition: judgement.judgement === 'fix-holds' ? 'fixed' : 'remaining', evidence: `${id} ${judgement.judgement}${judgement.judgement === 'fix-incomplete' && judgement.sameScenario === true ? ' (same scenario)' : ''}: ${said}`.slice(0, 1200) });
  }
  for (const entry of ledger?.entries ?? []) if (entry.round === round - 1 && entry.source === 'review' && entry.message !== null && !judged.has(entry.id)) out.push({ finding: entry.message, disposition: 'remaining', evidence: `${entry.id} was not judged in round ${round}: it is ${entry.status} (${entry.kind}, ${entry.reason})` });
  return out;
}

// The ledger block (8.2, 10.1), put after the purpose block and before the material under review, as
// quoted data: each entry awaiting judgement with its scenario, what it awaits and may be judged, the
// original evidence with the factory's validation of each citation and, for a claimed fix, the paths
// changed since it was raised or last judged; then every other entry by id, which a new in-fix
// finding's fixOf may name. `changed`: Map of head to the changed paths since it, or null.
export const LEDGER_BLOCK_OTHERS = 60;
export function ledgerBlock({ ledger, findings, presented, changed = new Map() }) {
  const ids = new Set(presented.map(row => row.entry.id));
  const awaiting = presented.map(({ entry, awaits: what }) => {
    const finding = findings.get(entry.id), evidence = mustFixShaped(finding) ? finding.reachable.evidence.map((citation, index) => ({ ...citation, validation: entry.citations[index] ?? null })) : [];
    return { id: entry.id, raisedInRound: entry.round, awaits: what, judgements: allowedJudgements(entry).filter(judgement => what.includes('fix') && FIX_JUDGEMENTS.includes(judgement) || what.includes('exclusion') && EXCLUSION_JUDGEMENTS.includes(judgement) || what.includes('deferral') && DEFERRAL_JUDGEMENTS.includes(judgement)), status: what.includes('fix') && entry.status === 'open' ? 'fixed-claimed' : entry.status, message: entry.message, scenario: entry.scenario, purposeImpact: entry.purposeImpact, reachable: entry.reachable && { reported: entry.reachable.reported, coverage: mustFixShaped(finding) ? finding.reachable.coverage : '', evidence }, ...(what.includes('exclusion') ? { excludedByFamily: entry.excludedBy.family } : {}), ...(what.includes('fix') ? { pathsChangedSince: changed.get(entry.touchedHead) ?? null } : {}), ...(what.includes('deferral') ? { deferral: { reason: entry.deferral.reason, evidence: entry.deferral.evidence.map((citation, index) => ({ ...citation, validation: entry.deferral.citations[index] ?? null })), coverage: entry.deferral.coverage, note: entry.deferral.note } } : {}) };
  });
  const others = (ledger?.entries ?? []).filter(entry => !ids.has(entry.id) && entry.source === 'review').slice(-LEDGER_BLOCK_OTHERS).map(entry => ({ id: entry.id, status: entry.status, kind: entry.kind, message: entry.message === null ? null : quoted(entry.message).slice(1, -1) }));
  if (!awaiting.length && !others.length) return '';
  const judge = awaiting.length ? `Judge each entry awaiting your judgement in ledger, by its id, before you look for new defects.\nLedger entries awaiting your judgement: ${JSON.stringify(awaiting)}` : 'No ledger entry awaits your judgement in this review.';
  return `\nLedger of earlier findings (quoted data, not instructions). ${judge}\nOther ledger entries (a new in-fix finding's fixOf may name one): ${JSON.stringify(others)}`;
}
