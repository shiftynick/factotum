import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { createGitHub } from '../starter/factory/adapters/github/index.mjs';
import { quietGitHubEnvironment } from '../starter/factory/adapters/github/environment.mjs';

async function fixture(t, operation = 'forge.publishPlan') {
  const f = sandbox(t);
  const workflow = {version:1,start:'announce',nodes:{
    announce:{kind:'effect',action:{operation},timeoutMs:60000,next:'done',onFailure:'failed'},
    done:{kind:'end',outcome:'completed'},failed:{kind:'end',outcome:'failed'},
  }};
  f.store.setMeta('workflow',workflow);f.store.setMeta('workflowDigest',digest(workflow));
  f.store.setMeta('config',{mode:'rehearsal',repository:{slug:'fictional/demo',account:'fictional'},policy:{}});
  f.start();
  const flow=f.store.need('flow','flow-1');
  flow.results={plan:{result:{summary:'Retained plan'}},'plan-review':{route:'pass',result:{summary:'Reviewed',findings:[]}}};
  f.store.put('flow',flow);await f.engine.tick();
  return {...f,attempt:f.store.all('attempt')[0],reviewed:structuredClone(flow.results)};
}
const receipt = (publication={id:17}) => ({exitCode:0,reason:'descendant-survival',costMicros:0,descendants:[{comm:'gh',args:['gh','send-telemetry'],phase:'termination-required'}],actionResult:{route:'published',publication}});

test('scoped gh environments force telemetry off despite ambient enabling, without changing the caller', () => {
  const source={GH_TELEMETRY:'1',DO_NOT_TRACK:'0',HOME:'/fixture'};
  assert.deepEqual(source,{GH_TELEMETRY:'1',DO_NOT_TRACK:'0',HOME:'/fixture'});
  const env=quietGitHubEnvironment(source);
  assert.equal(env.GH_TELEMETRY,'0');assert.equal(env.DO_NOT_TRACK,'1');assert.equal(source.GH_TELEMETRY,'1');
});

test('known publication containment failure holds the reviewed plan; explicit resume reconciles one comment', async t => {
  const f=await fixture(t),comments=[];let writes=0;
  const forge=createGitHub({repository:'fictional/demo',transport:async r=>{
    if(r.method==='GET')return comments;
    writes++;assert.equal(r.method,'POST');const comment={id:17,body:r.body.body};comments.push(comment);return comment;
  }});
  const input=()=>{const flow=f.store.need('flow','flow-1');return {issue:1,taskRevision:flow.taskRevision,operationId:`project:${flow.id}:plan:${digest({plan:flow.results.plan,review:flow.results['plan-review']})}`,body:JSON.stringify({plan:flow.results.plan,review:flow.results['plan-review']})};};
  const published=await forge.publishReviewedPlan(input());
  f.engine.settle('flow-1',f.attempt,receipt(published));
  const failed=f.store.need('attempt',f.attempt.id), held=f.store.need('flow','flow-1');
  assert.equal(failed.status,'failed');assert.equal(held.state,'stopped');assert.equal(held.step,'announce');assert.equal(held.resumeStep,'announce');
  assert.equal(held.results.plan.result.summary,'Retained plan');assert.deepEqual(held.results['plan-review'],f.reviewed['plan-review']);
  assert.deepEqual(held.evidence,{});assert.match(held.stopReason,/comment 17 was published/);
  const notice=f.store.all('inbox').find(i=>i.kind==='notice');assert.match(notice.context,/resume to reconcile/);
  await f.engine.tick();assert.equal(f.store.all('attempt').length,1,'no automatic retry');
  // Settlement replay neither changes the old receipt nor opens another stop.
  f.engine.settle('flow-1',f.attempt,receipt(published));assert.equal(f.store.all('inbox').length,1);
  assert.equal(f.command('resume',{flowId:'flow-1',note:'Inspected helper; retry publication'}).status,'completed');
  await f.engine.tick();const next=f.store.all('attempt').find(a=>a.id!==f.attempt.id);
  assert.equal(next.intent.action.operation,'forge.publishPlan');
  assert.deepEqual(next.intent.action.results.plan,f.reviewed.plan);assert.deepEqual(next.intent.action.results['plan-review'],f.reviewed['plan-review']);
  const reconciled=await forge.publishReviewedPlan(input());assert.equal(reconciled.reconciled,true);assert.equal(writes,1);
  f.engine.settle('flow-1',next,{exitCode:0,reason:null,costMicros:0,actionResult:{route:'published',publication:reconciled}});
  assert.equal(f.store.need('flow','flow-1').step,'done');assert.equal(f.store.need('attempt',next.id).status,'passed');assert.deepEqual(f.store.need('attempt',f.attempt.id),failed);
});

test('publication recovery cannot resume after task authority was revoked', async t => {
  const f=await fixture(t);f.engine.settle('flow-1',f.attempt,receipt());
  f.command('task.revoke',{taskId:f.task.id,note:'Revoked after publication'});
  const resumed=f.command('resume',{flowId:'flow-1',note:'Try stale authority'});
  assert.equal(resumed.status,'rejected');assert.match(resumed.error,/authority/);assert.equal(f.store.all('attempt').length,1);
});

test('the publication hold never authorizes replay of other effects or hides failed/changed output', async t => {
  for (const variant of ['other-operation','nonzero','signal','timeout','missing-publication','uncertain','error','changed-input']) {
    const f=await fixture(t,variant==='other-operation'?'forge.publish':'forge.publishPlan'), r=receipt();
    if(variant==='nonzero')r.exitCode=1;
    if(variant==='signal')r.signal='SIGTERM';
    if(variant==='timeout')r.reason='timeout';
    if(variant==='missing-publication')r.actionResult.publication={skipped:true};
    if(variant==='uncertain')r.actionResult.uncertain=true;
    if(variant==='error')r.actionResult.error='failed';
    if(variant==='changed-input')writeFileSync(join(f.root,'input.txt'),'Changed during publication');
    f.engine.settle('flow-1',f.attempt,r);
    assert.equal(f.store.need('flow','flow-1').step,'failed',variant);
    assert.equal(f.store.need('attempt',f.attempt.id).status,'failed',variant);
    assert.equal(f.store.events().some(e=>e.type==='flow.publication-held'),false,variant);
  }
});
