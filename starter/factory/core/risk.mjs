import { assert, digest } from './contracts.mjs';
import { flowReviewBar } from './review-bar.mjs';
import { reviewAcknowledgements, assertAcknowledged } from './review-decision.mjs';

const assessments = flow => [...(flow.riskAssessments ?? []), ...[['plan',flow.planResult],['plan-review',flow.reviewResult]].map(([step,row]) => ({step,assessment:row?.result?.riskAssessment})), ...Object.entries(flow.results ?? {}).filter(([step]) => ['plan','plan-review','review','delta-review','final-review','satisfied-review'].includes(step)).map(([step, row]) => ({ step, assessment: row?.result?.riskAssessment }))].filter(row => row.assessment);
// Missing task classification is conservative. Escalation survives corrected or
// overwritten plans/reviews; a new task revision requires a new flow.
export function effectiveRisk(task, flow = {}) {
  return task?.risk !== 'ordinary' || flow.effectiveRisk === 'strict' || assessments(flow).some(row => row.assessment.level === 'strict') ? 'strict' : 'ordinary';
}
// Commissioned ordinary merge delegation. Strict risk and adopted external
// candidates always return to the operator (or the strict decision role).
export function mergeDecisionRole(task, flow = {}) {
  return flow.mergeDecisionRole === 'orchestrator' && !flow.candidate && effectiveRisk(task, flow) === 'ordinary' ? 'orchestrator' : 'operator';
}
export function riskSummary(task, flow = {}) {
  const rows = assessments(flow), unique = key => [...new Set(rows.flatMap(row => row.assessment[key] ?? []).filter(value => typeof value === 'string' && value.trim()))];
  return { level: effectiveRisk(task, flow), rationale: unique('rationale'), threatModel: unique('threatModel'), stopConditions: unique('stopConditions') };
}
export function recordRiskAssessment(flow, step, result, attemptId) {
  for(const [index,correction] of (result?.protocolCorrections??[]).entries())recordRiskAssessment(flow,step,correction.original,`${attemptId}:protocol-${index+1}`);
  if (!['plan','plan-review','review','delta-review','final-review','satisfied-review'].includes(step) || !result?.result?.riskAssessment) return;
  flow.riskAssessments ??= [];
  flow.riskAssessments.push({ step, attemptId, identity: result.identity, assessment: result.result.riskAssessment });
  if (result.result.riskAssessment.level === 'strict') flow.effectiveRisk = 'strict';
}
export function assessmentComplete(assessment) {
  return assessment?.level === 'strict' && typeof assessment.rationale === 'string' && assessment.rationale.trim() && ['threatModel','stopConditions'].every(key => Array.isArray(assessment[key]) && assessment[key].length && assessment[key].every(value => typeof value === 'string' && value.trim()));
}
// `options.restriction`: the project's review restriction (core/review-decision.mjs), read by a
// must-fix flow only. A severity or shadow flow's requirement is exactly today's.
export function strictReviewRequirement(task, flow, identity, options = {}) {
  if (effectiveRisk(task, flow) !== 'strict') return null;
  if (flowReviewBar(flow) === 'must-fix') return mustFixStrictRequirement(task, flow, identity, options);
  const review = flow.results?.review ?? flow.results?.['satisfied-review'];
  const adjudicated=flow.reviewProtocol==='bounded-delta'&&review?.phase==='final'&&review?.route==='adjudicate'&&review?.disposition==='operator-adjudication';
  assert(adjudicated||review?.route === 'pass' && review.result?.verdict === 'pass' && review.result?.findings?.length === 0, 'strict change requires a passing independent review or explicit final adjudication');
  if(flow.reviewProtocol==='bounded-delta'&&flow.completionMode!=='already-satisfied'){const history=(flow.reviewHistory??[]).filter(row=>row.risk==='strict');assert(history.some(row=>row.phase==='full')&&history.some(row=>row.phase==='delta'),'strict protocol requires full and delta review evidence');}
  assert(review.identity?.head === identity.head && review.identity?.treeDigest === identity.treeDigest, 'strict review must cover the exact candidate');
  assert(assessmentComplete(review.result.riskAssessment), 'strict review requires explicit threat model and stop conditions');
  assert(['fullDiffInspected','threatModelReviewed','stopConditionsReviewed'].every(key => review.result.strictReview?.[key] === true), 'strict review must attest full diff, threat model and stop conditions');
  const summary = riskSummary(task, flow);
  const scope={phase:review.phase??'full',baseHead:review.baseHead??null};
  const reviewer={provider:review.provider??null,model:review.model??null,family:review.family??null,independence:review.independence??null};
  return { reviewer, scope, requiredRole:flow.candidate?'operator':flow.strictDecisionRole??'operator', unresolvedFindings:adjudicated?review.result.findings:[], phase:review.phase??'full', head: identity.head, assessmentDigest: digest({ summary, reviewer, scope, review: review.result, identity: review.identity }), ...summary };
}
// The strict requirement of a must-fix flow (docs/designs/review-must-fix.md 7.4, slice 5; test
// fixtures only until the enabling release). Accepted review evidence: the latest review at the exact
// candidate with complete attestations and assessment, and under bounded-delta a full and a delta
// review in history, except for completionMode already-satisfied, whose single full satisfied review
// is the whole chain (6.5); its route is pass, or defer with a followups result recorded at the same
// identity and review digest, or a bounded-delta final adjudicate; no must-fix item open in the
// ledger except under adjudicate. The acknowledgement list (core/review-decision.mjs) and the digests
// of the list, the ledger and the restriction version are bound into assessmentDigest, so any change
// to a finding, a judgement, a support status or the restriction invalidates an earlier answer.
// Operator-only entries make the operator the required role, even when strictDecisionRole is orchestrator.
function mustFixStrictRequirement(task, flow, identity, { restriction = null } = {}) {
  const review = flow.results?.review ?? flow.results?.['satisfied-review'];
  const bounded = flow.reviewProtocol === 'bounded-delta';
  const adjudicated = bounded && review?.phase === 'final' && review?.route === 'adjudicate' && review?.disposition === 'operator-adjudication';
  const reviewDigest = digest({ identity: review?.identity ?? null, result: review?.result ?? null }), followups = flow.results?.followups;
  const deferred = review?.route === 'defer' && followups?.route === 'pass' && followups.reviewDigest === reviewDigest && digest(followups.outputIdentity ?? null) === digest(review.identity ?? null);
  assert(review && (adjudicated || review.route === 'pass' || deferred), 'strict change requires accepted review evidence: a passing must-fix review, a defer whose follow-ups were recorded at the same identity and review, or explicit final adjudication');
  if (bounded && flow.completionMode !== 'already-satisfied') { const history = (flow.reviewHistory ?? []).filter(row => row.risk === 'strict'); assert(history.some(row => row.phase === 'full') && history.some(row => row.phase === 'delta'), 'strict protocol requires full and delta review evidence'); }
  assert(review.identity?.head === identity.head && review.identity?.treeDigest === identity.treeDigest, 'strict review must cover the exact candidate');
  assert(assessmentComplete(review.result?.riskAssessment), 'strict review requires explicit threat model and stop conditions');
  assert(['fullDiffInspected', 'threatModelReviewed', 'stopConditionsReviewed'].every(key => review.result.strictReview?.[key] === true), 'strict review must attest full diff, threat model and stop conditions');
  const view = reviewAcknowledgements(flow, { restriction, adjudicated });
  assert(!view.open.length, `strict change has open must-fix items (${view.open.join(', ')}); they must be fixed, or adjudicated by a bounded-delta final review`);
  const summary = riskSummary(task, flow);
  const scope = { phase: review.phase ?? 'full', baseHead: review.baseHead ?? null };
  const reviewer = { provider: review.provider ?? null, model: review.model ?? null, family: review.family ?? null, independence: review.independence ?? null };
  const operatorOnly = view.items.some(item => item.operatorOnly) || view.restriction.operatorDisposition === 'all';
  const acknowledgements = view.items, bound = acknowledgements.map(item => ({ id: item.id, kind: item.kind, reason: item.reason, status: item.status, claimDigest: item.claimDigest, operatorOnly: item.operatorOnly }));
  return { bar: 'must-fix', reviewer, scope, requiredRole: flow.candidate || operatorOnly ? 'operator' : flow.strictDecisionRole ?? 'operator', operatorOnly, route: review.route, acknowledgements, unresolvedFindings: adjudicated ? review.result.findings : [], phase: review.phase ?? 'full', head: identity.head, ledgerDigest: view.ledgerDigest, restrictionVersion: view.restriction.version,
    assessmentDigest: digest({ summary, reviewer, scope, review: review.result, identity: review.identity, route: review.route, followups: deferred ? followups.reviewDigest : null, acknowledgements: bound, ledger: view.ledgerDigest, restriction: view.restriction.version }), ...summary };
}
export function verifyStrictDecision(task, flow, identity, authorization, options = {}) {
  const requirement = strictReviewRequirement(task, flow, identity, options);
  if (requirement?.bar === 'must-fix') {
    assert((authorization?.actor === 'operator' || authorization?.actor === requirement.requiredRole) && authorization.reviewedHead === identity.head && authorization.riskAssessmentDigest === requirement.assessmentDigest, requirement.requiredRole === 'operator' && authorization?.actor !== 'operator' ? 'strict change requires exact-head operator review acknowledgement: an operator-only finding (a protected class, a critical rating or a restriction) is listed, so only the operator may acknowledge it' : 'strict change requires exact-head operator review acknowledgement');
    assertAcknowledged(requirement.acknowledgements, authorization.acknowledgedFindings, 'this strict decision');
    return requirement;
  }
  if (requirement) assert((authorization?.actor === 'operator'||!flow.candidate&&authorization?.actor === (flow.strictDecisionRole??'operator')) && authorization.reviewedHead === identity.head && authorization.riskAssessmentDigest === requirement.assessmentDigest, 'strict change requires exact-head operator review acknowledgement');
  return requirement;
}
