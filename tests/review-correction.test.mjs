import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { reviewDisposition } from '../starter/factory/core/delivery-review.mjs';

const assessment={level:'strict',rationale:'Protect fictional saved data',threatModel:['Loss of records'],stopConditions:['Missing record integrity']};
const reviewReport={verdict:'pass',summary:'Pass with a low follow-up',findings:[{severity:'low',file:'input.txt',line:1,message:'Clarify the record format'}],riskAssessment:assessment,strictReview:{fullDiffInspected:true,threatModelReviewed:true,stopConditionsReviewed:true},scopeSummary:'Entire fictional change',priorFindingsDisposition:[]};
const buildResult=()=>({route:'implemented',provider:'codex',model:'fictional',family:'openai',sessionId:'builder-session',result:{status:'implemented',summary:'No further edits, commits or pushes',questions:[],departures:[],unverified:[],pushback:[]}});
const receipt=actionResult=>({exitCode:0,reason:null,costMicros:0,actionResult});

async function fixture(t) {
  const f=sandbox(t),ghPath=join(f.base,'gh');
  writeFileSync(ghPath,`#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');`,{mode:0o700});
  const effect=(operation,next,extra={})=>({kind:'effect',action:{operation},timeoutMs:60000,next,onFailure:'failed',...extra});
  const workflow={version:1,start:'inspect',nodes:{
    inspect:effect('provider.review','verify',{resultEdges:{pass:'verify',revise:'repair',defer:'done'}}),
    repair:effect('provider.build','inspect',{maxVisits:4,resultEdges:{implemented:'inspect',blocked:'question'}}),
    verify:effect('gate','done'),
    question:{kind:'question',role:'operator',question:'Builder needs guidance',answers:{retry:'repair',stop:'stopped'}},
    stopped:{kind:'end',outcome:'stopped'},done:{kind:'end',outcome:'completed'},failed:{kind:'end',outcome:'failed'},
  }};
  f.store.setMeta('workflow',workflow);f.store.setMeta('workflowDigest',digest(workflow));
  f.store.setMeta('config',{mode:'rehearsal',repository:{slug:'fictional/demo',account:'fictional',target:'main',ghPath},providers:{builder:{provider:'codex',model:'fictional'},reviewer:{provider:'claude',model:'fictional'}},policy:{planning:false},context:{files:[],maxChars:1000}});
  f.command('queue.put',{taskIds:[f.task.id]});f.start();
  const flow=f.store.need('flow','flow-1');flow.results.source={head:repositoryIdentity(f.root).head};f.store.put('flow',flow);
  await f.engine.tick();const reviewAttempt=f.store.all('attempt')[0];
  const review=await runAction(reviewAttempt.intent,{providerInvoke:async()=>({provider:'claude',family:'anthropic',result:structuredClone(reviewReport)})});
  assert.equal(review.route,'revise');assert.equal(review.result.verdict,'pass');
  f.engine.settle(flow.id,reviewAttempt,receipt(review));
  assert.equal(f.store.need('flow',flow.id).step,'repair');
  return {...f,flowId:flow.id,review,reviewAttempt};
}
async function prepare(f){await f.engine.tick();return f.store.need('attempt',f.store.need('flow',f.flowId).attemptId);}

test('strict pass with a low finding tells the builder to revise, then holds an unchanged correction without another review',async t=>{
  const f=await fixture(t),attempt=await prepare(f);let prompt;
  const result=await runAction(attempt.intent,{providerInvoke:async spec=>{prompt=spec.prompt;return buildResult();}});
  assert.match(prompt,/Factory review route: revise; disposition: correct/);assert.match(prompt,/every finding requires resolution, including low-severity findings even when the reviewer wrote pass/);assert.match(prompt,/return blocked with concrete questions/);assert.match(prompt,/Clarify the record format/);
  f.engine.settle(f.flowId,attempt,receipt(result));
  const held=f.store.need('flow',f.flowId),saved=f.store.need('attempt',attempt.id);
  assert.equal(held.state,'stopped');assert.equal(held.resumeStep,'repair');assert.match(held.stopReason,/unchanged reviewed candidate/);
  assert.equal(held.visits.repair,1);assert.equal(held.visits.inspect,1);assert.equal(held.visits.verify,undefined);
  assert.equal(saved.status,'failed');assert.match(saved.reason,/unchanged candidate/);assert.equal(saved.receipt.actionResult.result.summary,buildResult().result.summary);
  assert.equal(held.evidence.review,undefined);assert.equal(held.evidence.gate,undefined);assert.equal(f.store.need('queue',f.task.id).status,'claimed');
  const notices=f.store.all('inbox').length;
  await f.engine.tick();f.engine.settle(f.flowId,attempt,receipt(result));
  assert.equal(f.store.all('attempt').length,2);assert.equal(f.store.all('inbox').length,notices,'no repeated settlement notice');
  assert.equal(f.command('flow.note',{flowId:f.flowId,note:'Address the record-format finding; pass with findings was not acceptance.'}).status,'completed');
  assert.equal(f.command('resume',{flowId:f.flowId,note:'Authorize one deliberate correction'}).status,'completed');
  const retry=await prepare(f);
  const corrected=await runAction(retry.intent,{providerInvoke:async spec=>{assert.match(spec.prompt,/Address the record-format finding/);writeFileSync(join(f.root,'input.txt'),'Clarified record format\n');return buildResult();}});
  f.engine.settle(f.flowId,retry,receipt(corrected));
  assert.equal(f.store.need('flow',f.flowId).step,'inspect');assert.equal(f.store.need('flow',f.flowId).visits.repair,2);
  assert.deepEqual(f.store.need('attempt',attempt.id),saved,'prior unsuccessful attempt remains intact');
});

test('correction holds use actual candidate identity and only the pinned revise result, preserving other outcomes and operator stops',async t=>{
  for(const variant of ['initial','accepted','deferred','different-candidate','changed','forged-output','blocked','failed','stopped','revoked']) {
    const f=await fixture(t);let flow=f.store.need('flow',f.flowId);
    if(variant==='initial')delete flow.results.review;
    if(variant==='accepted')flow.results.review.route='pass';
    if(variant==='deferred')flow.results.review.route='defer';
    if(variant==='different-candidate')writeFileSync(join(f.root,'input.txt'),'Candidate changed before this build\n');
    f.store.put('flow',flow);const attempt=await prepare(f),result=buildResult(),r=receipt(result);
    if(variant==='changed'){writeFileSync(join(f.root,'input.txt'),'Actual correction\n');result.outputIdentity=attempt.intent.inputIdentity;}
    if(variant==='forged-output')result.outputIdentity={head:'a'.repeat(40),treeDigest:'b'.repeat(64)};
    if(variant==='blocked'){result.route='blocked';result.result.status='blocked';result.result.questions=['Clarify the finding'];}
    if(variant==='failed')r.exitCode=1;
    if(variant==='stopped')f.command('stop',{flowId:f.flowId,note:'Operator stopped this work'});
    if(variant==='revoked')f.command('task.revoke',{taskId:f.task.id,note:'Withdraw authority'});
    f.engine.settle(f.flowId,attempt,r);flow=f.store.need('flow',f.flowId);
    if(['forged-output','stopped','revoked'].includes(variant)){
      assert.equal(flow.state,'stopped',variant);assert.equal(flow.resumeStep,'repair');
      if(variant==='stopped')assert.equal(flow.stopReason,'Operator stopped this work');
      if(variant==='revoked')assert.equal(f.command('resume',{flowId:f.flowId,note:'Try stale authority'}).status,'rejected');
    }else assert.equal(flow.step,variant==='blocked'?'question':variant==='failed'?'failed':'inspect',variant);
  }
});

test('strict low findings still require revision while ordinary configured follow-ups remain deferred',()=>{
  for(const reviewProtocol of ['fresh-full','bounded-delta']){
    const config={policy:{reviewProtocol}},strict=reviewDisposition(config,{risk:'strict'},{},{result:reviewReport},'full');
    assert.equal(strict.route,'revise');
    const ordinary={...reviewReport,riskAssessment:{...assessment,level:'ordinary'}};
    assert.equal(reviewDisposition(config,{risk:'ordinary'},{},{result:ordinary},'ordinary').route,'defer');
    assert.equal(reviewDisposition(config,{risk:'strict'},{},{result:{...reviewReport,findings:[]}},'full').route,reviewProtocol==='bounded-delta'?'delta':'pass');
  }
});
