import {assert,digest} from './contracts.mjs';
import {effectiveRisk,assessmentComplete} from './risk.mjs';
export const boundedReview = config => config.policy?.reviewProtocol === 'bounded-delta';
export function reviewPhase(config,task,flow) {
  if(!boundedReview(config))return 'full';
  const history=flow.reviewHistory??[],strict=effectiveRisk(task,flow)==='strict';
  if(strict){const strictHistory=history.filter(row=>row.risk==='strict');return !strictHistory.some(row=>row.phase==='full')?'full':!strictHistory.some(row=>row.phase==='delta')?'delta':'final';}
  return history.filter(row=>row.risk==='ordinary').length >= (config.policy?.ordinaryReviewRounds??4)?'final':'ordinary';
}
export function reviewDisposition(config,task,flow,result,phase) {
  const strict=effectiveRisk(task,{...flow,results:{...(flow.results??{}),review:result}})==='strict';
  const findings=result.result.findings,pass=result.result.verdict==='pass'&&!findings.length;
  if(['delta','final'].includes(phase)){const previous=flow.reviewHistory?.at(-1);if((previous?.result?.findings??[]).some(finding=>!result.result.priorFindingsDisposition?.some(row=>row.finding===finding.message&&row.evidence?.trim())))return {route:phase==='final'?'park':'revise',disposition:'incomplete-prior-findings'};}

  // Ordinary risk: a reviewer's pass that only carries low-severity findings is accepted, and
  // the findings become follow-ups instead of another build round (policy.deferLowFindings, default on).
  if(!strict&&config.policy?.deferLowFindings!==false&&result.result.verdict==='pass'&&findings.length&&findings.every(row=>row.severity==='low'))return {route:'defer',disposition:'followup-required'};
  if(strict&&(!assessmentComplete(result.result.riskAssessment)||!['fullDiffInspected','threatModelReviewed','stopConditionsReviewed'].every(key=>result.result.strictReview?.[key]===true)))return {route:phase==='final'?'park':'revise',disposition:'incomplete'};
  if(!boundedReview(config))return {route:pass?'pass':'revise',disposition:pass?'accepted':'correct'};
  if(strict){
    if(phase==='ordinary')return {route:'delta',disposition:'escalated-full-review-required'};
    if(phase==='full')return {route:pass?'delta':'revise',disposition:pass?'full-reviewed':'correct'};
    if(phase==='final')return {route:pass?'pass':'adjudicate',disposition:pass?'accepted':'operator-adjudication'};
    return {route:pass?'pass':'revise',disposition:pass?'accepted':'correct'};
  }
  const round=(flow.reviewHistory??[]).filter(row=>row.risk==='ordinary').length+1;
  if(pass)return {route:'pass',disposition:'accepted'};
  if(findings.length&&findings.every(row=>['medium','low'].includes(row.severity))&&round >= (config.policy?.ordinaryFollowupAfter??3))return {route:'defer',disposition:'followup-required'};
  return {route:phase==='final'?'park':'revise',disposition:phase==='final'?'parked':'correct'};
}
export function reviewEvidenceAcceptable(result) {return result?.route==='pass'||result?.route==='adjudicate'&&result.disposition==='operator-adjudication';}
export function recordReview(flow,step,result,attemptId) {
  if(!['review','delta-review','final-review','satisfied-review'].includes(step)||!result?.provider)return;
  flow.reviewHistory??=[];flow.reviewHistory.push({attemptId,step,phase:result.phase??'full',risk:effectiveRisk(flow.taskSnapshot,flow),identity:result.identity,baseHead:result.baseHead??null,disposition:result.disposition,result:result.result,reviewDigest:digest({identity:result.identity,result:result.result})});
}
export function operatorReviewRequirement(config,task,flow,identity) {
  if(!boundedReview(config)||effectiveRisk(task,flow)!=='strict')return;
  const history=(flow.reviewHistory??[]).filter(row=>row.risk==='strict');
  assert(history.some(row=>row.phase==='full'),'strict protocol requires a full review');
  assert(history.some(row=>row.phase==='delta'),'strict protocol requires a delta review');
  const last=history.at(-1);assert(last?.identity?.head===identity.head&&last.identity.treeDigest===identity.treeDigest,'strict protocol requires final review at the exact candidate');
}
