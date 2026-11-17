// Lesson signals: what a flow's own records show was corrected on the way (knowledge-upkeep
// design, 10.1). Computed without a model call, from the flow record and the records already read
// by flow id (its attempts and its pushback rows). Nothing here reads the event log, the clock or
// any other record, so the result does not depend on the retrospective's bounded event sample.
//
// class 'verified': a correction attested by something other than the worker that made the
// mistake (a later review, a later check run). Only these can support a capture candidate.
// class 'weak': context. Shown beside a verified correction; never counts alone.
import { digest } from '../core/contracts.mjs';

export const MAX_LESSON_SIGNALS = 40;
const TEXT = 300;
const clip = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, TEXT) : '';
export const LESSON_SIGNAL_KINDS = Object.freeze({
  'review-correction': 'verified', 'fast-check-correction': 'verified', 'gate-correction': 'verified',
  'review-correction-inferred': 'weak', 'plan-send-back': 'weak', 'person-replan': 'weak', 'operator-note': 'weak',
  'rule-pushback': 'weak', 'plan-departure': 'weak', 'unverified-acceptance': 'weak', 'unchanged-candidate': 'weak',
  // A must-fix flow (review-must-fix design 12.1): a builder's deferral, and a corner case a fix introduced.
  'review-deferral': 'weak', 'fix-churn': 'weak',
});
const signal = (kind, ref, detail = {}) => ({ id: digest({ kind, ...ref }), kind, class: LESSON_SIGNAL_KINDS[kind], ...ref, ...detail });

// Review rounds that sent the change back. A round recorded before dispositions existed counts
// when its verdict was not a pass.
const SENT_BACK = new Set(['correct', 'incomplete', 'incomplete-prior-findings', 'parked']);
const sentBack = round => round.disposition === undefined ? round.result?.verdict !== 'pass' : SENT_BACK.has(round.disposition);
const passed = round => round.result?.verdict === 'pass';
const safeFile = file => typeof file === 'string' && file && file.length <= TEXT && !file.startsWith('/') && !/[\0\n\\]/.test(file) && !file.split('/').includes('..') ? file : null;
function reviewSignals(flow) {
  const rounds = Array.isArray(flow.reviewHistory) ? flow.reviewHistory : [], found = [], mustFix = flow.reviewBar === 'must-fix';
  rounds.forEach((round, index) => {
    if (!sentBack(round)) return;
    const later = rounds.slice(index + 1);
    for (const [at, finding] of (Array.isArray(round.result?.findings) ? round.result.findings : []).entries()) {
      // A must-fix flow's finding in the must-fix shape is matched by its ledger id instead (ledgerSignals);
      // a legacy finding keeps today's rules.
      if (mustFix && round.mustFix?.findings?.[at]?.bar === 'must-fix') continue;
      const message = typeof finding?.message === 'string' ? finding.message : null; if (!message) continue;
      // The file a finding names, when it is a repository-relative path: the directories of such
      // files are among the anchors a capture candidate may choose (4.2).
      const file = safeFile(finding.file);
      const ref = { attemptId: round.attemptId ?? null, finding: digest(message) }, shown = { step: round.step ?? null, severity: finding.severity ?? null, ...(file ? { file } : {}), message: clip(message) };
      // The later round that disposed of it, by the reviewer's own statement.
      const disposed = later.map(row => ({ row, entry: (row.result?.priorFindingsDisposition ?? []).find(entry => entry?.finding === message) })).find(found => found.entry);
      if (disposed) {
        if (disposed.entry.disposition === 'fixed' && typeof disposed.entry.evidence === 'string' && disposed.entry.evidence.trim()) found.push(signal('review-correction', ref, { ...shown, fixedBy: disposed.row.attemptId ?? null, evidence: clip(disposed.entry.evidence) }));
        continue;
      }
      // No round was required to dispose of it: absent from a later passing round, it is inferred fixed.
      const passing = later.find(row => passed(row) && !(row.result?.findings ?? []).some(other => other?.message === message));
      if (passing) found.push(signal('review-correction-inferred', ref, { ...shown, absentFrom: passing.attemptId ?? null }));
    }
  });
  return mustFix ? [...found, ...ledgerSignals(flow, rounds)] : found;
}
// A must-fix flow's findings in the must-fix shape, matched by ledger id (review-must-fix design 12.1):
// a verified review-correction only for a must-fix finding a later review judged fix-holds (marked
// contested when its deferral was rejected first); operator items, follow-ups and accepted deferrals
// give no verified signal. Weak: review-deferral (a builder's deferral, with what became of it) and
// fix-churn (a finding in code an earlier round's fix added, naming that fix's entry).
// The ledger is the one the engine stores with each review (flow.reviewLedger, equal to a recomputation
// from the history); this module reads records only and never derives it.
function ledgerSignals(flow, rounds) {
  const found = [], attemptOf = round => rounds[round - 1]?.attemptId ?? null;
  for (const entry of Array.isArray(flow.reviewLedger?.entries) ? flow.reviewLedger.entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.source !== 'review' || entry.bar !== 'must-fix') continue;
    const file = safeFile(entry.file), ref = { attemptId: attemptOf(entry.round), ledgerId: entry.id };
    const shown = { step: entry.step ?? null, severity: entry.severity ?? null, ...(file ? { file } : {}), message: clip(entry.message ?? entry.scenario ?? ''), purposeImpact: entry.purposeImpact ?? null };
    const holds = (entry.judgements ?? []).filter(row => row.counted && row.judgement === 'fix-holds').at(-1);
    if (entry.kind === 'must-fix' && entry.status === 'fixed' && holds) found.push(signal('review-correction', ref, { ...shown, fixedBy: attemptOf(holds.round), evidence: clip(holds.coverage) || `judged fix-holds in round ${holds.round}`, ...(entry.deferral?.outcome === 'contested' ? { contested: true } : {}) }));
    if (entry.deferral) found.push(signal('review-deferral', ref, { ...shown, reason: entry.deferral.reason ?? null, outcome: entry.deferral.void ? 'void' : entry.deferral.outcome ?? 'awaiting' }));
    if (entry.origin === 'in-fix' && typeof entry.fixOf === 'string') found.push(signal('fix-churn', ref, { ...shown, fixOf: entry.fixOf }));
  }
  return found;
}

// The operation each step of the flow's own pinned workflow runs: an attempt as stored does not
// carry it, and it is not read from the attempt's intent.
const operationOf = (flow, step) => flow.workflow?.nodes?.[step]?.action?.operation ?? null;
const routeOf = attempt => attempt.receipt?.actionResult?.route ?? null;
const failedRun = attempt => attempt.status === 'passed' && (attempt.outcome === 'failed' || attempt.outcome === undefined && routeOf(attempt) === 'fail');
const failedChecksOf = attempt => Array.isArray(attempt.failedChecks) ? attempt.failedChecks : (attempt.receipt?.actionResult?.checks ?? []).filter(check => check && typeof check === 'object' && check.status !== 'passed');
// A check run that failed and a later run of the same operation on this flow that passed.
function checkSignals(flow, attempts, operation, kind) {
  const runs = attempts.filter(attempt => operationOf(flow, attempt.step) === operation), found = [];
  runs.forEach((attempt, index) => {
    if (!failedRun(attempt)) return;
    const later = runs.slice(index + 1).find(row => row.status === 'passed' && row.outcome === undefined && routeOf(row) === 'pass'); if (!later) return;
    const checks = failedChecksOf(attempt).map(check => String(check.id ?? '')).filter(Boolean);
    for (const checkId of checks.length ? [...new Set(checks)] : [null]) found.push(signal(kind, { attemptId: attempt.id, checkId }, { step: attempt.step, passedBy: later.id }));
  });
  return found;
}

function weakSignals(flow, attempts, pushback) {
  const found = [];
  for (const attempt of attempts) {
    if (operationOf(flow, attempt.step) === 'provider.planReview' && attempt.status === 'passed' && routeOf(attempt) === 'revise') found.push(signal('plan-send-back', { attemptId: attempt.id }, { step: attempt.step }));
    if (typeof attempt.reason === 'string' && attempt.reason.startsWith('unchanged candidate after ')) found.push(signal('unchanged-candidate', { attemptId: attempt.id }, { step: attempt.step, reason: clip(attempt.reason) }));
  }
  // A person's replan, answer or note. The factory's own replans (the target moved under the
  // planned paths) are recorded with the actor 'factory' and are not signals.
  (Array.isArray(flow.operatorFeedback) ? flow.operatorFeedback : []).forEach((entry, index) => {
    if (!entry || entry.actor === 'factory' || entry.actor === undefined) return;
    found.push(signal(entry.answer === 'replan' ? 'person-replan' : 'operator-note', { feedback: index, at: entry.at ?? null }, { step: entry.step ?? null, answer: entry.answer ?? null, actor: entry.actor, note: clip(entry.note) }));
  });
  for (const row of pushback) found.push(signal('rule-pushback', { pushbackId: row.id }, { ruleId: clip(row.ruleId), actor: row.actor ?? null }));
  for (const report of Array.isArray(flow.workerReports) ? flow.workerReports : []) {
    const ref = { attemptId: report.attemptId ?? null }, shown = { step: report.step ?? null, binding: report.binding ?? null };
    if (Array.isArray(report.departures) && report.departures.length) found.push(signal('plan-departure', ref, { ...shown, count: report.departures.length }));
    if (Array.isArray(report.unverified) && report.unverified.length) found.push(signal('unverified-acceptance', ref, { ...shown, count: report.unverified.length }));
  }
  return found;
}

// { signals, omitted }: at most MAX_LESSON_SIGNALS, verified corrections first, each in the order
// its source records it. `omitted` counts what the bound left out.
export function lessonSignals({ flow, attempts = [], pushback = [] }) {
  const verified = [...reviewSignals(flow).filter(row => row.class === 'verified'), ...checkSignals(flow, attempts, 'fastCheck', 'fast-check-correction'), ...checkSignals(flow, attempts, 'gate', 'gate-correction')];
  const weak = [...reviewSignals(flow).filter(row => row.class === 'weak'), ...weakSignals(flow, attempts, pushback)];
  const all = [...verified, ...weak], seen = new Set(), unique = all.filter(row => !seen.has(row.id) && seen.add(row.id));
  return { signals: unique.slice(0, MAX_LESSON_SIGNALS), omitted: Math.max(0, unique.length - MAX_LESSON_SIGNALS) };
}
export const hasVerifiedCorrection = signals => signals.some(row => row.class === 'verified');
