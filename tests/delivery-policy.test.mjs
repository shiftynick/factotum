import test from 'node:test';
import assert from 'node:assert/strict';
import {sandbox,until} from './helpers.mjs';
import {digest} from '../starter/factory/core/contracts.mjs';
import {repositoryIdentity} from '../starter/factory/core/repository.mjs';
import {changeWorkflow,validateConfig} from '../starter/factory/core/configuration.mjs';
import {reviewPhase,reviewDisposition} from '../starter/factory/core/delivery-review.mjs';
import {strictReviewRequirement} from '../starter/factory/core/risk.mjs';
const config={policy:{reviewProtocol:'bounded-delta'},repository:{}};
const assessment={level:'strict',rationale:'Fictional persisted state boundary',threatModel:['Untrusted imports must not replace existing state'],stopConditions:['Halt on lost state']};
const finding=(severity='high')=>({severity,file:'src/store.js',line:1,message:'Fictional data-loss reproduction'});
function review(identity,phase,{findings=[],verdict=findings.length?'revise':'pass',risk='strict',prior=[]}={}){return {provider:'fictional',identity,phase,result:{verdict,summary:'Synthetic protocol fixture',findings,riskAssessment:{...assessment,level:risk},strictReview:{fullDiffInspected:true,threatModelReviewed:true,stopConditionsReviewed:true},scopeSummary:`Synthetic ${phase} scope`,priorFindingsDisposition:prior}};}
const history=(phase,result={findings:[]},risk='strict')=>({phase,risk,identity:{head:'a'.repeat(40),treeDigest:'tree'},result});
test('strict protocol progresses full, delta, then final for a correction beyond its review rounds',()=>{
  const task={risk:'strict'},flow={reviewHistory:[]},identity={head:'a'.repeat(40),treeDigest:'tree'};
  assert.equal(reviewPhase(config,task,flow),'full');assert.equal(reviewDisposition(config,task,flow,review(identity,'full'),'full').route,'delta');
  flow.reviewHistory.push(history('full'));assert.equal(reviewPhase(config,task,flow),'delta');
  flow.reviewHistory.push(history('delta'));assert.equal(reviewPhase(config,task,flow),'final');
  const final=review(identity,'final',{findings:[finding()]});assert.deepEqual(reviewDisposition(config,task,flow,final,'final'),{route:'adjudicate',disposition:'operator-adjudication'});
});
test('ordinary escalation requires a real full review before delta review',()=>{
  const task={risk:'ordinary'},flow={reviewHistory:[]},identity={head:'a'.repeat(40),treeDigest:'tree'},result=review(identity,'ordinary');
  assert.equal(reviewDisposition(config,task,flow,result,'ordinary').route,'delta');
  flow.effectiveRisk='strict';flow.reviewHistory.push(history('ordinary'));assert.equal(reviewPhase(config,task,flow),'full');
});
test('ordinary medium and low findings defer only at the configured threshold and high findings never defer',()=>{
  const task={risk:'ordinary'},flow={reviewHistory:[history('ordinary',{},'ordinary')]},identity={};
  assert.equal(reviewDisposition(config,task,flow,review(identity,'ordinary',{findings:[finding('medium')],risk:'ordinary'}),'ordinary').route,'revise');
  flow.reviewHistory.push(history('ordinary',{},'ordinary'));assert.equal(reviewDisposition(config,task,flow,review(identity,'ordinary',{findings:[finding('low')],risk:'ordinary'}),'ordinary').route,'defer');
  assert.equal(reviewDisposition(config,task,flow,review(identity,'final',{findings:[finding('high')],risk:'ordinary'}),'final').route,'park');
});
test('delta review cannot omit disposition evidence for a prior finding',()=>{
  const task={risk:'strict'},flow={reviewHistory:[history('full',{findings:[finding()]})]},result=review({},'delta');
  assert.equal(reviewDisposition(config,task,flow,result,'delta').route,'revise');
  result.result.priorFindingsDisposition=[{finding:finding().message,disposition:'fixed',evidence:'Synthetic regression test and changed line'}];assert.equal(reviewDisposition(config,task,flow,result,'delta').route,'pass');
});
function fixture(t){const f=sandbox(t);f.start();const flow=f.store.need('flow','flow-1'),workflow=changeWorkflow(config);Object.assign(flow,{workflow,workflowDigest:digest(workflow),reviewProtocol:'bounded-delta',mode:'delivery',kind:'change',step:'review',reviewHistory:[]});f.store.setMeta('workflow',workflow);f.store.setMeta('workflowDigest',digest(workflow));f.store.put('flow',flow);return {...f,identity:repositoryIdentity(f.root)};}
function settle(f,step,result){const flow=f.store.need('flow','flow-1'),id=`synthetic-${step}-${f.store.all('attempt').length}`,attempt={id,flowId:flow.id,step,status:'running',intent:{action:{operation:step==='gate'?'gate':'provider.review'},inputIdentity:f.identity},intentDigest:digest(id)};flow.step=step;flow.attemptId=id;f.store.put('flow',flow);f.store.put('attempt',attempt);f.engine.settle(flow.id,attempt,{exitCode:0,costMicros:0,actionResult:result});return f.store.need('flow',flow.id);}
test('canonical full/delta/final history pins identities and carries unresolved final findings into the exact-head decision',async t=>{
  const f=fixture(t);let flow=settle(f,'review',{...review(f.identity,'full'),route:'delta',disposition:'full-reviewed'});assert.equal(flow.step,'delta-review');
  flow=settle(f,'delta-review',{...review(f.identity,'delta',{findings:[finding()]}),route:'revise',disposition:'correct'});assert.equal(flow.step,'build');
  flow=settle(f,'review',{...review(f.identity,'final',{findings:[finding()],prior:[{finding:finding().message,disposition:'remaining',evidence:'Synthetic still-red reproduction'}]}),route:'adjudicate',disposition:'operator-adjudication'});assert.equal(flow.step,'gate');assert.equal(flow.reviewHistory.length,3);assert.equal(flow.evidence.review.head,f.identity.head);
  flow=settle(f,'gate',{route:'pass'});await f.engine.step(flow.id);const question=f.store.all('inbox').find(row=>row.kind==='question');assert.deepEqual(question.strictReview.unresolvedFindings,[finding()]);
  assert.equal(f.command('answer',{inboxId:question.id,version:question.version,subjectDigest:question.subjectDigest,answer:'merge',reviewedHead:f.identity.head}).status,'completed');
});
test('operator send-back requires a note, retains builder session and explicitly extends exhausted build bounds',async t=>{
  const f=fixture(t);settle(f,'review',{...review(f.identity,'full'),route:'delta'});settle(f,'delta-review',{...review(f.identity,'delta'),route:'pass'});let flow=settle(f,'gate',{route:'pass'});flow.sessions={builder:'synthetic-persistent-session'};flow.visits.build=flow.workflow.nodes.build.maxVisits;f.store.put('flow',flow);await f.engine.step(flow.id);const q=f.store.all('inbox').find(row=>row.kind==='question'),payload={inboxId:q.id,version:q.version,subjectDigest:q.subjectDigest,answer:'send_back'};
  assert.equal(f.command('answer',payload).status,'rejected');assert.equal(f.command('answer',{...payload,note:'Add the missing synthetic regression proof'}).status,'completed');flow=f.store.need('flow',flow.id);assert.equal(flow.step,'build');assert.equal(flow.sessions.builder,'synthetic-persistent-session');assert.equal(flow.limitExtensions.build,1);assert.equal(flow.mergeAuthorization,null);assert.equal(flow.operatorFeedback[0].note,'Add the missing synthetic regression proof');
});
test('strict bounded adjudication requires both full and delta receipts and an exact-head final review',()=>{
  const identity={head:'a'.repeat(40),treeDigest:'tree'},task={risk:'strict'},last={...review(identity,'final',{findings:[finding()]}),route:'adjudicate',disposition:'operator-adjudication'},flow={reviewProtocol:'bounded-delta',results:{review:last},reviewHistory:[history('full'),history('delta')]};
  assert.deepEqual(strictReviewRequirement(task,flow,identity).unresolvedFindings,[finding()]);flow.reviewHistory.pop();assert.throws(()=>strictReviewRequirement(task,flow,identity),/full and delta/);
});
test('conflict repair graph preserves the same owned builder path through a fresh reviewed plan',()=>{const graph=changeWorkflow(config);assert.equal(graph.nodes['conflict-question'].answers.repair,'plan');assert.equal(graph.nodes['plan-review'].resultEdges.pass,'publish-plan');assert.equal(graph.nodes['publish-plan'].next,'workspace');assert.equal(graph.nodes.workspace.next,'build');});
test('stopping a delivery queues one pinned lifecycle outbox job and maintenance failures do not recurse',t=>{
  const f=fixture(t),config={mode:'delivery',repository:{issueProfile:{lifecycle:{labels:{stopped:'blocked'}}}}};f.store.setMeta('config',config);f.store.setMeta('configDigest',digest(config));let flow=f.store.need('flow','flow-1');flow.configDigest=digest(config);flow.taskSnapshot.source={issue:7,revision:'fictional-source-revision'};f.store.put('flow',flow);
  assert.equal(f.command('stop',{flowId:flow.id,note:'Synthetic stopped change'}).status,'completed');assert.equal(f.command('stop',{flowId:flow.id,note:'Repeated synthetic stop'}).status,'completed');
  const jobs=f.store.all('job');assert.equal(jobs.length,1);assert.equal(jobs[0].operation,'forge.lifecycle');assert.equal(jobs[0].payload.source.revision,'fictional-source-revision');assert.equal(jobs[0].grant.configDigest,digest(config));
  flow=f.store.need('flow',flow.id);flow.kind='maintenance';flow.id='maintenance-synthetic';f.store.put('flow',flow);assert.equal(f.command('stop',{flowId:flow.id,note:'Synthetic maintenance stopped'}).status,'completed');assert.equal(f.store.all('job').length,1);
});
test('structured worker reports and rule pushback persist once per flow and rule identity',t=>{
  const f=fixture(t),flow=f.store.need('flow','flow-1');flow.step='plan';f.store.put('flow',flow);
  const result={route:'ready',identity:f.identity,result:{departures:[{from:'Original fixture helper',why:'Actual source uses another boundary'}],unverified:['External fictional service'],questions:[],pushback:[{ruleId:'rule-1',ruleText:'Fictional governing rule',cost:'Extra conversion layer',proposal:'Review the boundary rule'}]}};
  for(let n=0;n<2;n++){const current=f.store.need('flow',flow.id),id=`worker-report-${n}`,attempt={id,flowId:flow.id,step:'plan',status:'running',intent:{action:{operation:'provider.plan'},inputIdentity:f.identity},intentDigest:id};current.step='plan';current.attemptId=id;f.store.put('flow',current);f.store.put('attempt',attempt);f.engine.settle(flow.id,attempt,{exitCode:0,costMicros:0,actionResult:result});}
  assert.equal(f.store.need('flow',flow.id).workerReports.length,2);assert.equal(f.store.all('pushback').length,1);assert.equal(f.store.all('inbox').filter(row=>row.kind==='notice').length,1);
});
test('stop and terminal notices retain outcome and retrospective links, while notice acknowledgement never answers questions',async t=>{
  const f=sandbox(t);f.start();assert.equal(f.command('stop',{flowId:'flow-1',note:'Synthetic operator pause'}).status,'completed');const notice=f.store.all('inbox').find(row=>row.kind==='notice');assert.equal(notice.outcome,'stopped');assert.equal(notice.retrospectiveId,'flow-1');assert.ok(f.store.get('retrospective','flow-1'));assert.equal(f.command('inbox.ack',{inboxId:notice.id}).status,'completed');assert.equal(f.store.need('inbox',notice.id).status,'acknowledged');
  const q={id:'synthetic-question',flowId:'flow-1',kind:'question',status:'open',version:1};f.store.put('inbox',q);assert.equal(f.command('inbox.ack',{inboxId:q.id}).status,'completed');assert.equal(f.store.need('inbox',q.id).status,'open');
  const completed=sandbox(t);completed.start();await until(()=>completed.store.need('flow','flow-1').state==='completed',{tick:()=>completed.engine.tick()});const result=completed.store.all('inbox').find(row=>row.kind==='notice');assert.equal(result.outcome,'completed');assert.ok(completed.store.get('retrospective',result.retrospectiveId));
});
