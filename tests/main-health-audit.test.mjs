import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../starter/factory/adapters/workspace/index.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';
import { runProcess } from '../starter/factory/adapters/providers/index.mjs';
const exists=path=>access(path).then(()=>true,()=>false);
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'factotum-main-health-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'root'),other=join(directory,'other'),remote=join(directory,'remote.git'),stateDir=join(directory,'state'),artifactDir=join(stateDir,'attempts','verification');await mkdir(root);
  await git(root,['init','-b','main']);await git(root,['config','user.name','Fictional Developer']);await git(root,['config','user.email','developer@example.invalid']);await writeFile(join(root,'app.txt'),'operator checkout before delivery\n');await git(root,['add','.']);await git(root,['commit','-m','Initial']);const oldHead=repositoryIdentity(root).head;
  await git(root,['init','--bare',remote]);await git(root,['remote','add','origin',remote]);await git(root,['push','-u','origin','main']);
  await git(root,['clone','--branch','main',remote,other]);await git(other,['config','user.name','Fictional Other']);await git(other,['config','user.email','other@example.invalid']);await writeFile(join(other,'app.txt'),'current merged target\n');await git(other,['add','.']);await git(other,['commit','-m','Merged fictional delivery']);await git(other,['push']);const head=repositoryIdentity(other).head;
  const config={repository:{target:'main',remote:'origin'},providers:{reviewer:{provider:'fictional',model:'fixture'}},mainChecks:[{id:'baseline',argv:[process.execPath,'-e','console.log("verified target")'],timeoutMs:60000}],policy:{},workspace:{setup:[]}};
  const intent={cwd:root,projectRoot:root,action:{operation:'main.verify',stateDir,artifactDir,projectId:'project-1',flowId:'verification-1',config}};
  return {directory,root,other,stateDir,artifactDir,oldHead,head,config,intent};
}

test('missing main verifier produces unknown infrastructure health with an inspectable check artifact',async t=>{
  const f=await fixture(t);f.config.mainChecks[0].argv=['/fictional/missing-verifier'];
  const result=await runMaintenanceAction(f.intent);assert.equal(result.route,'blocked');assert.equal(result.mainHealth.status,'unknown');assert.equal(result.mainHealth.head,f.head);assert.equal(result.mainHealth.checks[0].failureClass,'infrastructure');
  const evidence=JSON.parse(await readFile(join(f.artifactDir,'check-0.json'),'utf8'));assert.equal(evidence.status,'blocked');assert.equal(evidence.attempts.length,1);assert.equal(typeof evidence.stdout,'string');assert.equal(typeof evidence.stderr,'string');
  assert.equal(repositoryIdentity(f.root).head,f.oldHead);
});

test('target fetch infrastructure failure preserves its actual output and cannot retain old green health',async t=>{
  const f=await fixture(t);
  const result=await runMaintenanceAction(f.intent,{run:async(binary,args,options)=>binary==='git'&&args.includes('fetch')?{code:128,stdout:'fetch observation',stderr:'fetch service unavailable'}:runProcess(binary,args,options)});
  assert.equal(result.route,'blocked');assert.equal(result.mainHealth.status,'unknown');assert.equal(result.mainHealth.checks.length,0);
  const artifact=JSON.parse(await readFile(join(f.artifactDir,result.mainHealth.artifact),'utf8'));assert.equal(artifact.stdout,'fetch observation');assert.equal(artifact.stderr,'fetch service unavailable');
});

// dev.85: a main check stopped at its own timeoutMs fails the verification (red health, failure
// class timeout, never "product"), names the check and its limit, and is never retried.
test('timed out main verifier preserves actual partial stdout and stderr, fails as a timeout and is never retried',async t=>{
  const f=await fixture(t);f.config.policy.mainInfrastructureRetries=2;// A shell writes its partial output within milliseconds of starting, so the bounded
  // timeout still fires after that output even on a loaded host; a Node child could
  // take longer than the timeout just to start.
  f.config.mainChecks[0]={id:'timeout',argv:['/bin/sh','-c','echo "partial standard output"; echo "partial error output" >&2; exec sleep 600'],timeoutMs:2000,retrySafe:true};
  const result=await runMaintenanceAction(f.intent);assert.equal(result.route,'fail');assert.equal(result.mainHealth.status,'red');assert.equal(result.mainHealth.checks[0].status,'failed');assert.equal(result.mainHealth.checks[0].failureClass,'timeout');assert.equal(result.mainHealth.checks[0].timedOut,true);assert.equal(result.mainHealth.checks[0].attempts,1);
  assert.equal(result.timedOut,true);assert.deepEqual(result.timeout,{checkId:'timeout',timeoutMs:2000,limit:'check'});assert.match(result.notice,/Main check timeout timed out after 2 s \(its timeoutMs\)/);assert.match(result.notice,/partial error output/);
  const artifact=JSON.parse(await readFile(join(f.artifactDir,'check-0.json'),'utf8'));assert.match(artifact.stdout,/partial standard output/);assert.match(artifact.stderr,/partial error output/);assert.equal(artifact.failureClass,'timeout');assert.equal(artifact.timedOut,true);assert.equal(artifact.attempts.length,1);
});

test('normal product failure remains red and never receives an infrastructure retry',async t=>{
  const f=await fixture(t);f.config.policy.mainInfrastructureRetries=2;f.config.mainChecks[0]={id:'product',argv:[process.execPath,'-e','console.log("product observation");console.error("assertion failed");process.exit(1)'],timeoutMs:60000,retrySafe:true};
  const result=await runMaintenanceAction(f.intent);assert.equal(result.route,'fail');assert.equal(result.mainHealth.status,'red');assert.equal(result.mainHealth.checks[0].failureClass,'product');assert.equal(result.mainHealth.checks[0].attempts,1);
  const artifact=JSON.parse(await readFile(join(f.artifactDir,'check-0.json'),'utf8'));assert.match(artifact.stdout,/product observation/);assert.match(artifact.stderr,/assertion failed/);
});

test('explicit repeatable main check permits a bounded infrastructure retry and retains both attempts',async t=>{
  const f=await fixture(t);f.config.policy.mainInfrastructureRetries=1;f.config.mainChecks[0]={id:'repeatable',argv:['fictional-verifier'],timeoutMs:60000,retrySafe:true};let calls=0;
  const result=await runMaintenanceAction(f.intent,{run:async(binary,args,options)=>{if(binary!=='fictional-verifier')return runProcess(binary,args,options);calls++;if(calls===1)throw Object.assign(new Error('temporary verifier infrastructure'),{started:false,code:'TEMPORARY',stdout:'first partial output',stderr:'first partial error'});return{code:0,stdout:'observed passing result',stderr:''};}});
  assert.equal(result.route,'pass');assert.equal(result.mainHealth.status,'green');assert.equal(calls,2);assert.equal(result.mainHealth.checks[0].attempts,2);
  const artifact=JSON.parse(await readFile(join(f.artifactDir,'check-0.json'),'utf8'));assert.equal(artifact.attempts[0].status,'blocked');assert.equal(artifact.attempts[0].stdout,'first partial output');assert.equal(artifact.attempts[1].status,'passed');
});

test('infrastructure retry stays disabled for checks without an explicit repeatability declaration',async t=>{
  const f=await fixture(t);f.config.policy.mainInfrastructureRetries=2;f.config.mainChecks[0]={id:'unclassified',argv:['fictional-verifier'],timeoutMs:60000};let calls=0;
  const result=await runMaintenanceAction(f.intent,{run:async(binary,args,options)=>{if(binary!=='fictional-verifier')return runProcess(binary,args,options);calls++;throw new Error('uncertain verifier failure');}});
  assert.equal(result.mainHealth.status,'unknown');assert.equal(calls,1);
});

test('audit examines current remote target in an owned tree and preserves the old operator checkout',async t=>{
  const f=await fixture(t);f.intent.action.operation='audit';let audited;
  const result=await runMaintenanceAction(f.intent,{providerInvoke:async spec=>{audited=spec.cwd;assert.notEqual(spec.cwd,f.root);assert.equal(await readFile(join(spec.cwd,'app.txt'),'utf8'),'current merged target\n');return{provider:'fixture',result:{verdict:'revise',summary:'Observed fictional source',findings:[{severity:'low',file:'app.txt',line:1,message:'Fictional audit finding'}]}};}});
  assert.equal(result.route,'pass');assert.equal(result.targetHead,f.head);assert.equal(result.inputIdentity.head,f.head);assert.equal(result.findings[0].inputIdentity.head,f.head);assert.equal(result.findings[0].approved,false);
  assert.equal(repositoryIdentity(f.root).head,f.oldHead);assert.equal(await readFile(join(f.root,'app.txt'),'utf8'),'operator checkout before delivery\n');assert.equal(await exists(audited),false);
});

test('audit target advancement refuses to publish findings for a stale target',async t=>{
  const f=await fixture(t);f.intent.action.operation='audit';
  await assert.rejects(runMaintenanceAction(f.intent,{providerInvoke:async()=>{await git(f.other,['commit','--allow-empty','-m','Advance while read-only audit observes']);await git(f.other,['push']);return{provider:'fixture',result:{verdict:'pass',summary:'No findings',findings:[]}};}}),/audit target advanced/);
  assert.equal(repositoryIdentity(f.root).head,f.oldHead);
});

test('registered product flake retries keep every observation and report the recovered flake explicitly',async t=>{
  const f=await fixture(t);f.config.mainChecks[0]={id:'known-flake',argv:['fictional-verifier'],timeoutMs:60000,retrySafe:true,flakePolicy:{retries:1,exitCodes:[1],trackingRef:'fixture/check-tracking',expiresAt:'2099-01-01T00:00:00Z'}};let calls=0;
  const run=async(binary,args,options)=>binary==='fictional-verifier'?{code:++calls===1?1:0,stdout:'observed verifier',stderr:calls===1?'registered failure':''}:runProcess(binary,args,options);
  const result=await runMaintenanceAction(f.intent,{run});assert.equal(result.mainHealth.status,'green');assert.equal(calls,2);assert.equal(result.mainHealth.checks[0].flaked,true);
  const row=result.mainCheckObservations[0];assert.equal(row.flaked,true);assert.deepEqual(row.attempts.map(attempt=>attempt.status),['failed','passed']);assert.equal(row.trackingRef,'fixture/check-tracking');
});

test('expired flake registrations and unregistered exit codes cannot turn product failures green',async t=>{
  for (const [expiresAt,exitCode] of [['2000-01-01T00:00:00Z',1],['2099-01-01T00:00:00Z',2]]) {
    const f=await fixture(t);f.config.mainChecks[0]={id:'known-flake',argv:['fictional-verifier'],timeoutMs:60000,retrySafe:true,flakePolicy:{retries:2,exitCodes:[1],trackingRef:'fixture/check-tracking',expiresAt}};let calls=0;
    const result=await runMaintenanceAction(f.intent,{run:async(binary,args,options)=>binary==='fictional-verifier'?(calls++,{code:exitCode,stdout:'',stderr:'registered scope mismatch'}):runProcess(binary,args,options)});
    assert.equal(result.mainHealth.status,'red');assert.equal(calls,1);assert.equal(result.mainCheckObservations[0].flaked,false);
  }
});

test('exact clean main-check evidence reuses original age and missing or mismatched evidence reruns checks',async t=>{
  const f=await fixture(t);f.config.mainChecks[0]={id:'cacheable',argv:['fictional-verifier'],timeoutMs:60000,reuseMaxAgeMs:3600000};let calls=0;
  const run=async(binary,args,options)=>binary==='fictional-verifier'?(calls++,{code:0,stdout:'clean observed pass',stderr:''}):runProcess(binary,args,options);
  const first=await runMaintenanceAction(f.intent,{run});assert.equal(calls,1);assert.equal(first.mainHealth.status,'green');
  const next={...f.intent,action:{...f.intent.action,flowId:'verification-cache',artifactDir:join(f.stateDir,'attempts','verification-cache'),mainHealth:first.mainHealth}};
  const second=await runMaintenanceAction(next,{run});assert.equal(second.mainHealth.status,'green');assert.equal(calls,1);assert.equal(second.mainHealth.checks[0].reused,true);assert.equal(second.mainHealth.checks[0].verifiedAt,first.mainHealth.checks[0].verifiedAt);assert.equal(second.mainCheckObservations[0].attempts.length,0);
  await rm(join(f.stateDir,first.mainHealth.checks[0].evidencePath));
  const missing=await runMaintenanceAction({...next,action:{...next.action,flowId:'verification-missing',artifactDir:join(f.stateDir,'attempts','verification-missing')}},{run});assert.equal(missing.mainHealth.status,'green');assert.equal(calls,2);assert.equal(missing.mainHealth.checks[0].reused,false);
  const changedConfig={...f.config,policy:{changedTrustedInput:true}};
  const changed=await runMaintenanceAction({...next,action:{...next.action,config:changedConfig,flowId:'verification-changed',artifactDir:join(f.stateDir,'attempts','verification-changed'),mainHealth:second.mainHealth}},{run});assert.equal(changed.mainHealth.status,'green');assert.equal(calls,3);
});

test('recovered flaky evidence is never reused as a clean cached pass',async t=>{
  const f=await fixture(t);f.config.mainChecks[0]={id:'flaky-cache',argv:['fictional-verifier'],timeoutMs:60000,retrySafe:true,reuseMaxAgeMs:3600000,flakePolicy:{retries:1,exitCodes:[1],trackingRef:'fixture/check-tracking',expiresAt:'2099-01-01T00:00:00Z'}};let calls=0;
  const run=async(binary,args,options)=>binary==='fictional-verifier'?{code:++calls===1?1:0,stdout:'observed',stderr:''}:runProcess(binary,args,options);
  const first=await runMaintenanceAction(f.intent,{run});
  const next={...f.intent,action:{...f.intent.action,flowId:'verification-fresh',artifactDir:join(f.stateDir,'attempts','verification-fresh'),mainHealth:first.mainHealth}};
  const second=await runMaintenanceAction(next,{run});assert.equal(calls,3);assert.equal(second.mainHealth.checks[0].reused,false);
});

test('scheduled audit honors the explicitly configured independent auditor route',async t=>{
 const f=await fixture(t);f.intent.action.operation='audit';f.config.providers.auditor={provider:'claude',model:'fictional-auditor',effort:'high'};
 let observed;const result=await runMaintenanceAction(f.intent,{providerInvoke:async spec=>{observed=spec;return {provider:'fixture',result:{verdict:'pass',summary:'Read current target',findings:[]}};}});
 assert.equal(result.route,'pass');assert.equal(observed.role,'auditor');assert.equal(observed.readOnly,true);assert.equal(observed.model,'fictional-auditor');assert.equal(observed.effort,'high');
});
