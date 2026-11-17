import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { effectiveRisk, recordRiskAssessment, riskSummary, strictReviewRequirement, verifyStrictDecision } from '../starter/factory/core/risk.mjs';
import { validateSchema, RISK_PLAN_SCHEMA, CHANGE_REVIEW_SCHEMA } from '../starter/factory/adapters/providers/index.mjs';
const assessment = {level:'strict',rationale:'Saved state crosses a trust boundary',threatModel:['An untrusted imported identifier must not overwrite existing records'],stopConditions:['Halt if a migration cannot preserve existing records']};
const attestation = {fullDiffInspected:true,threatModelReviewed:true,stopConditionsReviewed:true};
function reviewed(identity) {return {route:'pass',identity,result:{verdict:'pass',summary:'Entire candidate inspected',findings:[],riskAssessment:structuredClone(assessment),strictReview:{...attestation},scopeSummary:'Entire assigned diff',priorFindingsDisposition:[],learningsChecked:[]}};}
test('risk escalations are monotonic across corrections and conservative when task classification is absent',()=>{
  const task={risk:'ordinary'},flow={results:{}};
  assert.equal(effectiveRisk({},flow),'strict');assert.equal(effectiveRisk(task,flow),'ordinary');
  recordRiskAssessment(flow,'plan',{result:{riskAssessment:assessment}},'plan-1');
  flow.results.plan={result:{riskAssessment:{level:'ordinary',rationale:'Later correction',threatModel:[],stopConditions:[]}}};
  recordRiskAssessment(flow,'plan',flow.results.plan,'plan-2');assert.equal(effectiveRisk(task,flow),'strict');assert.ok(riskSummary(task,flow).threatModel.includes(assessment.threatModel[0]));
});
test('strict review requires exact candidate, explicit assessment and every full-review attestation',()=>{
  const identity={head:'a'.repeat(40),treeDigest:'tree'},task={risk:'strict'},flow={results:{review:reviewed(identity)}};
  assert.equal(strictReviewRequirement(task,flow,identity).head,identity.head);
  assert.throws(()=>strictReviewRequirement(task,flow,{...identity,head:'b'.repeat(40)}),/exact candidate/);
  for(const key of Object.keys(attestation)){flow.results.review=reviewed(identity);flow.results.review.result.strictReview[key]=false;assert.throws(()=>strictReviewRequirement(task,flow,identity),/attest/);}
  flow.results.review=reviewed(identity);flow.results.review.result.riskAssessment.stopConditions=[];assert.throws(()=>strictReviewRequirement(task,flow,identity),/threat model and stop conditions/);
});
test('merge dispatch rechecks operator identity, exact head and bound assessment',()=>{
  const identity={head:'a'.repeat(40),treeDigest:'tree'},task={risk:'ordinary'},flow={effectiveRisk:'strict',results:{review:reviewed(identity)}};
  const requirement=strictReviewRequirement(task,flow,identity),authorization={actor:'operator',reviewedHead:identity.head,riskAssessmentDigest:requirement.assessmentDigest};
  assert.ok(verifyStrictDecision(task,flow,identity,authorization));
  for(const change of [{actor:'orchestrator'},{reviewedHead:'stale'},{riskAssessmentDigest:'stale'}])assert.throws(()=>verifyStrictDecision(task,flow,identity,{...authorization,...change}),/operator review acknowledgement/);
  flow.results.review.result.riskAssessment.threatModel.push('Additional boundary');assert.throws(()=>verifyStrictDecision(task,flow,identity,authorization),/operator review acknowledgement/);
});
function decisionFixture(t){
  const f=sandbox(t);f.start();const flow=f.store.need('flow','flow-1'),identity=repositoryIdentity(f.root);
  const workflow={version:1,start:'decide',nodes:{decide:{kind:'question',question:'Merge?',role:'operator',mergeDecision:true,requireEvidence:['review','gate'],answers:{merge:'merge',stop:'stopped'}},merge:{kind:'effect',argv:[process.execPath,'-e','process.exit(0)'],timeoutMs:60000,next:'done',onFailure:'failed'},done:{kind:'end',outcome:'completed'},failed:{kind:'end',outcome:'failed'},stopped:{kind:'end',outcome:'stopped'}}};
  Object.assign(flow,{mode:'delivery',kind:'change',workflow,workflowDigest:digest(workflow),step:'decide',results:{review:reviewed(identity)},evidence:{review:{...identity,attemptId:'review-attempt'},gate:{...identity,attemptId:'gate-attempt'}}});
  f.store.setMeta('workflow',workflow);f.store.setMeta('workflowDigest',digest(workflow));f.store.put('flow',flow);return {...f,identity};
}
test('canonical strict merge exposes assessment and rejects acknowledgement omission or wrong head',async t=>{
  const f=decisionFixture(t);await f.engine.step('flow-1');const item=f.store.all('inbox')[0];assert.deepEqual(item.strictReview.threatModel,assessment.threatModel);assert.equal(item.role,'operator');
  const payload={inboxId:item.id,version:item.version,subjectDigest:item.subjectDigest,answer:'merge'};
  assert.equal(f.command('answer',payload).status,'rejected');assert.equal(f.command('answer',{...payload,reviewedHead:'wrong'}).status,'rejected');
  assert.equal(f.command('answer',{...payload,reviewedHead:f.identity.head}).status,'completed');assert.equal(f.store.need('flow','flow-1').mergeAuthorization.reviewedHead,f.identity.head);
});
test('changing strict assessment invalidates the question even when the candidate head is unchanged',async t=>{
  const f=decisionFixture(t);await f.engine.step('flow-1');const item=f.store.all('inbox')[0],flow=f.store.need('flow','flow-1');flow.results.review.result.riskAssessment.stopConditions.push('Newly discovered halt condition');f.store.put('flow',flow);
  const answer=f.command('answer',{inboxId:item.id,version:item.version,subjectDigest:item.subjectDigest,answer:'merge',reviewedHead:f.identity.head});assert.equal(answer.status,'rejected');assert.match(answer.error,/question subject changed/);
});
test('change provider schemas require structured risk and explicit review attestations',()=>{
  const plan={status:'ready',summary:'Plan',files:['src/store.js'],checks:['tests'],risks:[],questions:[],assumptions:[],departures:[],unverified:[],pushback:[],riskAssessment:assessment,learningsApplied:[]};assert.equal(validateSchema(plan,RISK_PLAN_SCHEMA),plan);
  const result=reviewed({}).result;assert.equal(validateSchema(result,CHANGE_REVIEW_SCHEMA),result);const partial={...result};delete partial.strictReview;assert.throws(()=>validateSchema(partial,CHANGE_REVIEW_SCHEMA),/strictReview/);
});

test('canonical settlement retains planner escalation even when a later result replaces the plan',t=>{
  const f=sandbox(t);f.start();const flow=f.store.need('flow','flow-1'),identity=repositoryIdentity(f.root);
  const workflow={version:1,start:'plan',nodes:{plan:{kind:'effect',argv:[process.execPath,'-e','process.exit(0)'],timeoutMs:60000,next:'done',onFailure:'failed'},done:{kind:'end',outcome:'completed'},failed:{kind:'end',outcome:'failed'}}};
  Object.assign(flow,{workflow,workflowDigest:digest(workflow),step:'plan',attemptId:'risk-attempt'});f.store.setMeta('workflow',workflow);f.store.setMeta('workflowDigest',digest(workflow));f.store.put('flow',flow);
  const attempt={id:'risk-attempt',flowId:flow.id,step:'plan',intent:{inputIdentity:identity},intentDigest:'fixture',status:'running'};f.store.put('attempt',attempt);
  f.engine.settle(flow.id,attempt,{exitCode:0,costMicros:0,actionResult:{route:'ready',identity,result:{riskAssessment:assessment}}});
  const updated=f.store.need('flow',flow.id);assert.equal(updated.effectiveRisk,'strict');assert.equal(updated.riskAssessments[0].attemptId,attempt.id);
  updated.results.plan={result:{riskAssessment:{level:'ordinary',rationale:'Correction',threatModel:[],stopConditions:[]}}};assert.equal(effectiveRisk({risk:'ordinary'},updated),'strict');
});
test('cached planning escalation remains effective without relying on the task label',()=>{
  assert.equal(effectiveRisk({risk:'ordinary'},{planResult:{result:{riskAssessment:assessment}}}),'strict');
});

test('strict-review sign-off stays with the operator even on a recorded instruction',async t=>{
  const f=decisionFixture(t);await f.engine.step('flow-1');const item=f.store.all('inbox')[0];
  const receipt=executeCommand(f.store,{protocolVersion:1,projectId:f.project.projectId,commandId:uid(),actor:'orchestrator',operation:'answer',payload:{inboxId:item.id,version:item.version,subjectDigest:item.subjectDigest,answer:'merge',reviewedHead:f.identity.head},onBehalfOf:{principal:'operator',instruction:'Operator: "ship it"'}});
  assert.equal(receipt.status,'rejected');assert.equal(f.store.need('flow','flow-1').mergeAuthorization,undefined);
});
