import { assert, digest } from './contracts.mjs';

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
export function strictReviewRequirement(task, flow, identity) {
  if (effectiveRisk(task, flow) !== 'strict') return null;
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
export function verifyStrictDecision(task, flow, identity, authorization) {
  const requirement = strictReviewRequirement(task, flow, identity);
  if (requirement) assert((authorization?.actor === 'operator'||!flow.candidate&&authorization?.actor === (flow.strictDecisionRole??'operator')) && authorization.reviewedHead === identity.head && authorization.riskAssessmentDigest === requirement.assessmentDigest, 'strict change requires exact-head operator review acknowledgement');
  return requirement;
}
