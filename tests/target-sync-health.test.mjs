import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {sandbox,until} from './helpers.mjs';
import {atomicJSON,digest} from '../starter/factory/core/contracts.mjs';
import {admitFlow} from '../starter/factory/core/project.mjs';
import {inspect} from '../starter/factory/core/effects.mjs';
import {claimCandidate,admissionReasons} from '../starter/factory/operations/admission.mjs';
import {setTargetHealth,targetHealth,targetHealthVersion} from '../starter/factory/operations/targets.mjs';
import {operationalTick} from '../starter/factory/workflows/maintenance.mjs';
import {ensureMainVerification} from '../starter/factory/operations/main-freshness.mjs';
import {adoptableResult} from '../starter/factory/core/operations.mjs';

const OLD='a'.repeat(40),NEW='b'.repeat(40),green=head=>({status:'green',head,checkedAt:new Date().toISOString()});
function fixture(t,{count=7}={}) {
  const f=sandbox(t),config={version:1,mode:'delivery',repository:{slug:'fictional/demo',account:'fictional',target:'main',syncTargets:[{from:'main',into:'next'}]},providers:{planner:{provider:'codex',model:'m'},builder:{provider:'codex',model:'m'},reviewer:{provider:'claude',model:'m'}},checks:[{id:'test',argv:['true'],timeoutMs:60000}],context:{files:[],maxChars:1000},policy:{autoQueue:true,mainProbeMs:0},workflows:{definitions:{change:{reference:'change.standard'},web:{reference:'change.standard',target:'next'}},selection:{default:'web'}}};
  assert.equal(f.command('config.update',{config,note:'Two targets'}).status,'completed');
  f.store.setMeta('commissioning',{ready:true,configDigest:f.store.meta('configDigest')});
  setTargetHealth(f.store,'main',green(OLD));setTargetHealth(f.store,'next',green(OLD));
  for(let i=0;i<count;i++){const task=f.command('task.put',{task:{id:`task-${i+10}`,title:'Fictional queued work',acceptance:['Works']}}).result;assert.equal(f.command('task.approve',{taskId:task.id,revision:task.revision,queue:true}).status,'completed');}
  return f;
}
const claim=f=>claimCandidate(f.store,{admit:(task,s)=>admitFlow(s,task,{revision:task.revision})});
async function prepareJob(f,id){const job=f.store.need('job',id);assert.equal(job.status,'running');await f.engine.step(job.flowId);const flow=f.store.need('flow',job.flowId);return {flow,attempt:f.store.need('attempt',flow.attemptId)};}
const settle=(f,r,result,extra={})=>f.engine.settle(r.flow.id,r.attempt,{exitCode:0,reason:null,costMicros:0,actionResult:result,...extra});
async function source(f){const flow=claim(f);await f.engine.step(flow.id);return {flow,attempt:f.store.need('attempt',f.store.need('flow',flow.id).attemptId)};}
const hold={route:'target-unverified',targetHealthHold:{target:'next',head:NEW}};

test('seven queued tasks stay queued through sync and admit only after fresh destination verification',async t=>{
  const f=fixture(t),job=f.command('job.enqueue',{operation:'target.sync',payload:{from:'main',into:'next'},note:'Sync after merge'}).result;
  assert.match(admissionReasons(f.store,f.store.need('task','task-10')).join(';'),/next health pending: target synchronization/);
  assert.equal(claim(f),null);assert.equal(f.command('flow.start',{taskId:'task-10',revision:f.store.need('task','task-10').revision}).status,'rejected');
  await operationalTick(f.store);const sync=await prepareJob(f,job.id);
  assert.equal(claim(f),null,'running sync also holds admission');
  settle(f,sync,{route:'pass',sync:{from:'main',into:'next',fromHead:OLD,head:NEW,contained:true}});await f.engine.step(sync.flow.id);
  assert.equal(targetHealth(f.store,'next').status,'unknown');assert.equal(targetHealth(f.store,'next').head,NEW);assert.equal(targetHealth(f.store,'main').status,'green');
  for(let i=0;i<7;i++)assert.equal(claim(f),null,'cannot drain queued work into source failures');
  await operationalTick(f.store);
  const jobs=f.store.all('job').filter(j=>j.operation==='main.verify');assert.equal(jobs.length,1);assert.equal(jobs[0].payload.target,'next');
  const verify=await prepareJob(f,jobs[0].id);settle(f,verify,{route:'pass',mainHealth:{...green(NEW),target:'next'}});await f.engine.step(verify.flow.id);
  assert.equal(targetHealth(f.store,'next').status,'green');assert.ok(claim(f));
  assert.equal(f.store.all('queue').filter(q=>q.status==='queued').length,6);assert.equal(f.store.all('queue').filter(q=>q.status==='finished').length,0);
});

test('sync dispatch invalidates green before a worker runs and a crash cannot restore it',async t=>{
  const f=fixture(t),job=f.command('job.enqueue',{operation:'target.sync',payload:{from:'main',into:'next'},note:'Controlled sync crash'}).result;
  await operationalTick(f.store);const sync=await prepareJob(f,job.id),a=sync.attempt;
  // Substitute only the worker while retaining the actual dispatch transaction and supervisor.
  a.intent.argv=[process.execPath,'-e','process.exit(19)'];a.intentDigest=digest(a.intent);f.store.put('attempt',a);
  atomicJSON(join(f.stateDir,'attempts',a.id,'intent.json'),{...a.intent,intentDigest:a.intentDigest});
  await f.engine.step(sync.flow.id);
  assert.equal(targetHealth(f.store,'next').status,'unknown');assert.equal(targetHealth(f.store,'main').status,'green');
  await until(()=>['uncertain','terminal'].includes(inspect(f.store,f.store.need('attempt',a.id)).kind));
  await f.engine.step(sync.flow.id);assert.equal(claim(f),null);assert.equal(targetHealth(f.store,'next').status,'unknown');
});

// dev.83 (G10): with policy.autoQueue the flow asks for the verification its target needs and waits
// for it at source instead of stopping; it continues without a resume once the target is green.
test('source-observed target drift holds one flow at source, preserves queue ownership and invalidates stale green',async t=>{
  const f=fixture(t),r=await source(f);settle(f,r,hold);
  let flow=f.store.need('flow',r.flow.id);assert.equal(flow.state,'waiting');assert.equal(flow.step,'source');assert.equal(flow.targetWait.kind,'verification');assert.equal(flow.stopReason??null,null);
  assert.equal(f.store.need('queue',flow.taskId).status,'claimed');assert.equal(f.store.all('queue').filter(q=>q.status==='queued').length,6);
  assert.equal(targetHealth(f.store,'next').status,'unknown');assert.equal(targetHealth(f.store,'next').head,NEW);assert.equal(claim(f),null);
  const jobs=f.store.all('job').filter(j=>j.operation==='main.verify');assert.equal(jobs.length,1,'the flow requested the verification it waits for');assert.equal(jobs[0].payload.target,'next');assert.equal(flow.targetWait.jobId,jobs[0].id);
  assert.equal(f.store.tx(()=>ensureMainVerification(f.store)),null,'queued work does not request a second one');
  f.store.tx(()=>{setTargetHealth(f.store,'next',green(NEW));f.store.put('job',{...f.store.need('job',jobs[0].id),status:'completed'});});await f.engine.step(flow.id);
  flow=f.store.need('flow',flow.id);assert.equal(flow.targetWait,undefined);
  const fresh=f.store.need('attempt',flow.attemptId);assert.notEqual(fresh.id,r.attempt.id);assert.equal(fresh.intent.action.mainHealth.head,NEW);
  assert.equal(f.store.need('attempt',r.attempt.id).status,'failed','the held source check is retained');
});
test('without policy.autoQueue source-observed target drift still stops the flow, and the reason names the verification to run',async t=>{
  const f=fixture(t),r=await source(f);
  f.store.setMeta('config',{...f.store.meta('config'),policy:{...f.store.meta('config').policy,autoQueue:false}});
  settle(f,r,hold);
  const flow=f.store.need('flow',r.flow.id);assert.equal(flow.state,'stopped');assert.equal(flow.step,'source');assert.equal(flow.resumeStep,'source');
  assert.match(flow.stopReason,/next is not verified for source admission and no verification was requested: automatic verification is off \(policy\.autoQueue\)\. To continue: run main\.verify for next \(job\.enqueue \{operation: "main\.verify", payload: \{target: "next"\}\}\) or doctor; wait for current green verification, then resume this flow/);
  assert.equal(f.store.all('job').filter(j=>j.operation==='main.verify').length,0);
  assert.equal(f.store.need('queue',flow.taskId).status,'claimed');assert.equal(targetHealth(f.store,'next').status,'unknown');
  setTargetHealth(f.store,'next',green(NEW));assert.equal(f.command('resume',{flowId:flow.id,note:'Verified the new target'}).status,'completed');await f.engine.step(flow.id);
  assert.equal(f.store.need('attempt',f.store.need('flow',flow.id).attemptId).intent.action.mainHealth.head,NEW);
});

// dev.83 review: the target turned green while the source check ran, so the check is repeated
// against the current record instead of stopping the flow.
test('a late source observation cannot downgrade a newer green verification, and the source check is repeated',async t=>{
  const f=fixture(t),r=await source(f);setTargetHealth(f.store,'next',green(NEW));const version=targetHealthVersion(f.store,'next');
  settle(f,r,hold);assert.equal(targetHealth(f.store,'next').status,'green');assert.equal(targetHealthVersion(f.store,'next'),version);
  let flow=f.store.need('flow',r.flow.id);assert.equal(flow.state,'ready');assert.equal(flow.step,'source');assert.equal(flow.stopReason??null,null);assert.equal(flow.attemptId,null);
  assert.equal(f.store.events(200).filter(e=>e.type==='flow.source-recheck').length,1);assert.equal(f.store.all('job').filter(j=>j.operation==='main.verify').length,0,'nothing was requested: the target is verified');
  await f.engine.step(flow.id);flow=f.store.need('flow',flow.id);
  const fresh=f.store.need('attempt',flow.attemptId);assert.notEqual(fresh.id,r.attempt.id);assert.equal(fresh.intent.action.mainHealth.head,NEW);
});

test('a prepared source cannot dispatch across intervening sync or health changes',async t=>{
  for(const change of ['sync','health']){
    const f=fixture(t),r=await source(f);
    if(change==='sync')f.command('job.enqueue',{operation:'target.sync',payload:{from:'main',into:'next'},note:'Sync before source dispatch'});
    else setTargetHealth(f.store,'next',{status:'unknown',head:NEW});
    await f.engine.tick();assert.equal(f.store.need('flow',r.flow.id).state,'stopped');assert.equal(f.store.need('attempt',r.attempt.id).status,'prepared');
    await f.engine.tick();assert.equal(f.store.need('attempt',r.attempt.id).status,'not-dispatched');assert.equal(f.store.need('flow',r.flow.id).attemptId,null);
  }
});

test('late verification cannot restore green after a target invalidation',async t=>{
  const f=fixture(t,{count:0}),job=f.command('job.enqueue',{operation:'main.verify',payload:{target:'next'},note:'Verify'}).result;
  await operationalTick(f.store);const r=await prepareJob(f,job.id);
  setTargetHealth(f.store,'next',{status:'unknown',head:NEW,reason:'Concurrent target movement'});
  settle(f,r,{route:'pass',mainHealth:{...green(OLD),target:'next'}});
  assert.equal(targetHealth(f.store,'next').status,'unknown');assert.equal(targetHealth(f.store,'next').head,NEW);assert.ok(f.store.events().some(e=>e.type==='main.verification-superseded'));
});

test('supervised verifier settlement binds the dispatch generation and respects later operator health decisions',async t=>{
  for(const change of ['none','target-moved','operator']){
    const f=fixture(t,{count:0}),target=change==='operator'?'main':'next';
    const job=f.command('job.enqueue',{operation:'main.verify',payload:{target},note:'Exercise supervised health settlement'}).result;
    await operationalTick(f.store);const r=await prepareJob(f,job.id),a=r.attempt;
    const result={route:'pass',mainHealth:{...green(OLD),target}};
    a.intent.argv=[process.execPath,'-e',"const fs=require('node:fs'),path=require('node:path'),i=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.writeFileSync(path.join(path.dirname(process.argv[1]),'action-result.json'),JSON.stringify({...JSON.parse(process.argv[2]),attemptId:i.attemptId,intentDigest:i.intentDigest}))",join(f.stateDir,'attempts',a.id,'intent.json'),JSON.stringify(result)];
    a.intentDigest=digest(a.intent);f.store.put('attempt',a);atomicJSON(join(f.stateDir,'attempts',a.id,'intent.json'),{...a.intent,intentDigest:a.intentDigest});
    const preparedVersion=targetHealthVersion(f.store,target);await f.engine.step(r.flow.id);
    assert.equal(targetHealthVersion(f.store,target),preparedVersion+1);
    assert.equal(f.store.need('attempt',a.id).targetHealthVersion,preparedVersion+1);
    if(change==='target-moved')setTargetHealth(f.store,target,{status:'unknown',head:NEW,reason:'Sync invalidation'});
    if(change==='operator')assert.equal(f.command('main.health',{status:'red',head:NEW,note:'Operator observed a newer broken target'}).status,'completed');
    const effect=await until(()=>{const result=inspect(f.store,f.store.need('attempt',a.id));return ['terminal','uncertain'].includes(result.kind)&&result;});
    assert.equal(effect.kind,'terminal',effect.reason);await f.engine.step(r.flow.id);
    assert.equal(f.store.need('attempt',a.id).status,'passed','the original successful observation remains in history');
    assert.equal(targetHealth(f.store,target).status,change==='none'?'green':change==='operator'?'red':'unknown');
    assert.equal(targetHealth(f.store,target).head,change==='none'?OLD:NEW);
  }
});

test('a source health hold preserves an intervening revocation and cannot restore authority',async t=>{
  const f=fixture(t),r=await source(f);
  assert.equal(f.command('task.revoke',{taskId:r.flow.taskId,note:'Operator withdrew this task'}).status,'completed');
  const stopped=f.store.need('flow',r.flow.id);settle(f,r,hold);
  const current=f.store.need('flow',r.flow.id);
  assert.equal(current.state,'stopped');assert.equal(current.stopReason,stopped.stopReason);assert.equal(current.stopSequence,stopped.stopSequence);
  assert.equal(current.resumeStep,'source');assert.equal(targetHealth(f.store,'next').status,'unknown');
  assert.equal(f.command('resume',{flowId:r.flow.id,note:'Try resuming without new approval'}).status,'rejected');
});

test('no-op and failed syncs remain unverified; failed verification cannot publish green',async t=>{
  for(const result of [{route:'pass',sync:{from:'main',into:'next',upToDate:true}},{route:'fail',sync:{from:'main',into:'next',conflict:true}}]){
    const f=fixture(t),job=f.command('job.enqueue',{operation:'target.sync',payload:{from:'main',into:'next'},note:'Sync'}).result;
    await operationalTick(f.store);const r=await prepareJob(f,job.id);settle(f,r,result);assert.equal(targetHealth(f.store,'next').status,'unknown');assert.equal(claim(f),null);
  }
  const f=fixture(t,{count:0}),job=f.command('job.enqueue',{operation:'main.verify',payload:{target:'next'},note:'Verify'}).result;
  await operationalTick(f.store);const r=await prepareJob(f,job.id);settle(f,r,{route:'pass',mainHealth:{...green(NEW),target:'next'}},{reason:'descendant-survival'});assert.equal(targetHealth(f.store,'next').status,'unknown');
});

test('only source verification owns target-hold evidence',()=>{
  assert.equal(adoptableResult('provider.build',hold).targetHealthHold,undefined);
  assert.deepEqual(adoptableResult('source.verify',hold).targetHealthHold,hold.targetHealthHold);
});

async function dispatchResult(f,r,result){
  const a=r.attempt;
  a.intent.argv=[process.execPath,'-e',"const fs=require('node:fs'),path=require('node:path'),i=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));fs.writeFileSync(path.join(path.dirname(process.argv[1]),'action-result.json'),JSON.stringify({...JSON.parse(process.argv[2]),attemptId:i.attemptId,intentDigest:i.intentDigest}))",join(f.stateDir,'attempts',a.id,'intent.json'),JSON.stringify(result)];
  a.intentDigest=digest(a.intent);f.store.put('attempt',a);atomicJSON(join(f.stateDir,'attempts',a.id,'intent.json'),{...a.intent,intentDigest:a.intentDigest});
  await f.engine.step(r.flow.id);
  const effect=await until(()=>{const result=inspect(f.store,f.store.need('attempt',a.id));return ['terminal','uncertain'].includes(result.kind)&&result;});
  assert.equal(effect.kind,'terminal',effect.reason);await f.engine.step(r.flow.id);await f.engine.step(r.flow.id);
}

test('a sync conflict fails its job, reports the reason, and holds admission despite later green health until a proven no-op',async t=>{
  const f=fixture(t),reason='next conflicts with main in fictional.txt; merge by hand';
  const job=f.command('job.enqueue',{operation:'target.sync',payload:{from:'main',into:'next'},note:'Sync'}).result;
  await operationalTick(f.store);const r=await prepareJob(f,job.id);
  await dispatchResult(f,r,{route:'fail',sync:{from:'main',into:'next',fromHead:OLD,head:NEW,conflict:true,files:['fictional.txt']},reason});
  assert.equal(f.store.need('job',job.id).status,'failed');assert.equal(f.store.need('job',job.id).reason,reason);
  const notice=f.store.all('inbox').find(i=>i.flowId===r.flow.id);assert.match(notice.title,/failed/);assert.equal(notice.context,reason);
  setTargetHealth(f.store,'next',green(NEW));assert.equal(claim(f),null);assert.match(admissionReasons(f.store,f.store.need('task','task-10')).join(';'),/synchronization held.*fictional.txt/);
  const recovery={...f.store.need('task','task-10'),recovery:true};assert.match(admissionReasons(f.store,recovery,{recovery:true}).join(';'),/synchronization held/);
  const main=f.command('task.put',{task:{id:'main-task',title:'Default target',workflow:'change',acceptance:['Works']}}).result;f.command('task.approve',{taskId:main.id,revision:main.revision});assert.ok(!admissionReasons(f.store,f.store.need('task',main.id)).some(r=>r.includes('synchronization held')));
  const repair=f.command('job.enqueue',{operation:'target.sync',payload:{from:'main',into:'next'},note:'Observe repaired ancestry'}).result;
  await operationalTick(f.store);const rerun=await prepareJob(f,repair.id);
  await dispatchResult(f,rerun,{route:'pass',sync:{from:'main',into:'next',fromHead:OLD,head:NEW,contained:true,upToDate:true}});
  assert.equal(f.store.need('job',repair.id).status,'completed');assert.deepEqual(f.store.meta('targetSyncHolds'),{});
  assert.equal(claim(f),null,'successful sync still needs a current target verification');setTargetHealth(f.store,'next',green(NEW));assert.ok(claim(f));
});

test('a failed sync discovered after source preparation prevents dispatch even if health is green',async t=>{
  const f=fixture(t),r=await source(f);f.store.setMeta('targetSyncHolds',{'main>next':{from:'main',into:'next',status:'failed',reason:'Unresolved conflict'}});
  await f.engine.tick();assert.equal(f.store.need('flow',r.flow.id).state,'stopped');assert.equal(f.store.need('attempt',r.attempt.id).status,'prepared');
});

test('gate prerequisite holds retain the candidate and builder visit budget; late sync failures also hold a passing gate',async t=>{
  for(const mode of ['check','sync']){
    const f=fixture(t),r=await source(f),flow=f.store.need('flow',r.flow.id);
    // Inject settlement at the real graph's gate to exercise disposition, not model execution.
    flow.step='gate';flow.visits.build=4;flow.visits.gate=1;f.store.put('flow',flow);
    const attempt={...r.attempt,step:'gate',intent:{...r.attempt.intent,action:{...r.attempt.intent.action,operation:'gate'}}};f.store.put('attempt',attempt);
    if(mode==='sync')f.store.setMeta('targetSyncHolds',{'main>next':{from:'main',into:'next',status:'failed',reason:'Unresolved integration'}});
    f.engine.settle(flow.id,attempt,{exitCode:0,costMicros:0,actionResult:mode==='check'?{route:'held',gateHold:{kind:'check-prerequisite'},reason:'ancestry (exit 78)'}:{route:'pass',complete:true,checks:[{id:'test',status:'passed'}]}});
    const held=f.store.need('flow',flow.id);assert.equal(held.state,'stopped');assert.equal(held.resumeStep,'gate');assert.equal(held.visits.build,4);assert.equal(held.evidence.gate,undefined);assert.equal(f.store.need('queue',flow.taskId).status,'claimed');assert.match(held.stopReason,/builder was not retried/);
  }
  assert.equal(adoptableResult('provider.build',{gateHold:{kind:'check-prerequisite'}}).gateHold,undefined);
});

test('configuration validates explicit prerequisite exit codes',t=>{
  const f=fixture(t,{count:0});for(const codes of [[0],[-1],[256],[78,78],[],['78'],null]){const config=structuredClone(f.store.meta('config'));config.checks[0].holdExitCodes=codes;assert.equal(f.command('config.update',{config,note:'Invalid classification'}).status,'rejected');}
  const config=structuredClone(f.store.meta('config'));config.checks[0].holdExitCodes=[78];assert.equal(f.command('config.update',{config,note:'Commission prerequisite refusal'}).status,'completed');
});
