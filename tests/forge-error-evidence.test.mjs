import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { runGh, createGitHub, ForgeError } from '../starter/factory/adapters/github/index.mjs';
import { forgeErrorDetails } from '../starter/factory/adapters/github/errors.mjs';

test('GitHub failures retain bounded redacted stderr and process causes without stdout or credentials',async t=>{
  const f=sandbox(t),ghPath=join(f.base,'gh');
  writeFileSync(ghPath,`#!${process.execPath}\nconsole.log('PRIVATE STDOUT BODY');console.error('HTTP 503: service unavailable; '+process.env.GH_TOKEN+' Bearer bearer-secret https://user:password@host.invalid/');console.error('x'.repeat(20000));console.error('TAIL ghp_privateToken');process.exit(1);`,{mode:0o700});
  await assert.rejects(runGh(['api','fictional'],{ghPath,env:{PATH:process.env.PATH,GH_TOKEN:'selected-private-token'}}),error=>{
    const details=forgeErrorDetails(error),text=JSON.stringify(details);
    assert.equal(details.status,503);assert.equal(details.ambiguous,true);assert.equal(details.diagnostics.code,1);
    assert.match(details.diagnostics.stderr,/service unavailable/);assert.match(details.diagnostics.stderr,/TAIL/);assert.match(details.diagnostics.stderr,/truncated/);assert.ok(details.diagnostics.stderr.length<=4096);
    assert.doesNotMatch(text,/selected-private-token|bearer-secret|user:password|ghp_privateToken|PRIVATE STDOUT BODY/);return true;
  });
  await assert.rejects(runGh(['api','fictional'],{ghPath:join(f.base,'missing-gh'),env:{}}),error=>{
    assert.equal(error.ambiguous,false);assert.equal(forgeErrorDetails(error).cause.code,'ENOENT');assert.match(error.message,/ENOENT/);return true;
  });
  // A shell writes its diagnostic within milliseconds of starting, so the timeout fires after it even on a loaded host.
  writeFileSync(ghPath,`#!/bin/sh\necho 'waiting for fictional socket' >&2\nexec sleep 600\n`,{mode:0o700});
  await assert.rejects(runGh(['api','fictional'],{ghPath,env:{},timeoutMs:2000}),error=>{
    const details=forgeErrorDetails(error);assert.equal(error.ambiguous,true);assert.equal(details.cause.code,'TIMEOUT');assert.match(details.diagnostics.stderr,/waiting for fictional socket/);return true;
  });
});

test('an uncertain reviewed-plan PATCH preserves both write and reconciliation causes and never retries the write',async()=>{
  for(const reconciliationFails of [false,true]){
    let comments=[],writes=0,fail=false;
    const writeError=new ForgeError('GitHub operation failed (transport HTTP 503)',{status:503,kind:'transport',ambiguous:true,diagnostics:{code:1,stderr:'Upstream unavailable'}});
    const forge=createGitHub({repository:'fictional/demo',transport:async request=>{
      if(request.method==='GET'){
        if(fail&&writes===2&&reconciliationFails)throw new ForgeError('Lookup denied',{status:403,kind:'authorization'});
        return comments;
      }
      writes++;
      if(fail){assert.equal(request.method,'PATCH');throw writeError;}
      const comment={id:7,body:request.body.body};comments=[comment];return comment;
    }});
    await forge.publishReviewedPlan({issue:1,taskRevision:'one',operationId:'one',body:'Old plan'});fail=true;
    await assert.rejects(forge.publishReviewedPlan({issue:1,taskRevision:'two',operationId:'two',body:'New plan'}),error=>{
      assert.equal(error.ambiguous,true);assert.equal(error.cause,writeError);assert.match(error.message,/503/);
      const details=forgeErrorDetails(error);assert.equal(details.cause.status,503);assert.equal(details.cause.diagnostics.stderr,'Upstream unavailable');
      assert.equal(details.reconciliation?.status,reconciliationFails?403:undefined);return true;
    });
    assert.equal(writes,2,'one initial publication, one failed PATCH, no blind retry');
  }
});

test('the supervised publication worker retains the cause in uncertain attempt evidence without granting replay',async t=>{
  const f=sandbox(t),ghPath=join(f.base,'gh'),remotePath=join(f.base,'remote.json');
  let existing;
  const seed=createGitHub({repository:'fictional/demo',transport:async r=>r.method==='GET'?[]:(existing={id:7,body:r.body.body})});
  await seed.publishReviewedPlan({issue:1,taskRevision:'old',operationId:'old',body:'Earlier plan'});
  writeFileSync(remotePath,JSON.stringify({comment:existing,writes:0}));
  writeFileSync(ghPath,`#!${process.execPath}\nconst fs=require('node:fs'),args=process.argv.slice(2);if(args[0]==='auth'){console.log('selected-private-token');process.exit(0);}const path=${JSON.stringify(remotePath)},db=JSON.parse(fs.readFileSync(path));if(args[args.indexOf('--method')+1]==='PATCH'){db.writes++;fs.writeFileSync(path,JSON.stringify(db));console.error('HTTP 503: fictional reverse proxy unavailable '+process.env.GH_TOKEN);process.exit(1);}console.log(JSON.stringify([db.comment]));`,{mode:0o700});
  const workflow={version:1,start:'publish-plan',nodes:{'publish-plan':{kind:'effect',action:{operation:'forge.publishPlan'},timeoutMs:60000,next:'done',onFailure:'failed'},done:{kind:'end',outcome:'completed'},failed:{kind:'end',outcome:'failed'}}};
  f.store.setMeta('workflow',workflow);f.store.setMeta('workflowDigest',digest(workflow));
  f.store.setMeta('config',{mode:'rehearsal',repository:{slug:'fictional/demo',account:'fictional',ghPath},policy:{}});
  f.store.put('task',{...f.store.need('task',f.task.id),source:{repository:'fictional/demo',issue:1}});f.start();
  const flow=f.store.need('flow','flow-1');flow.results={plan:{result:{summary:'New plan'}},'plan-review':{route:'pass',result:{findings:[]}}};f.store.put('flow',flow);
  await until(()=>f.store.all('attempt').find(a=>a.status==='uncertain'),{tick:()=>f.engine.tick()});
  const attempt=f.store.all('attempt')[0],result=attempt.receipt.actionResult;
  assert.equal(attempt.receipt.exitCode,0);assert.equal(attempt.settledAt,undefined);assert.equal(result.uncertain,true);
  assert.equal(result.errorDetails.cause.status,503);assert.match(result.errorDetails.cause.diagnostics.stderr,/fictional reverse proxy unavailable/);assert.match(attempt.reason,/503/);
  assert.doesNotMatch(JSON.stringify(attempt.receipt),/selected-private-token/);
  const artifact=JSON.parse(readFileSync(join(f.stateDir,'attempts',attempt.id,'action-result.json'),'utf8'));assert.deepEqual(artifact.errorDetails,result.errorDetails);
  assert.equal(f.store.need('flow',flow.id).state,'stopped');assert.equal(f.store.need('flow',flow.id).attemptId,attempt.id);
  await f.engine.tick();assert.equal(f.store.all('attempt').length,1);assert.equal(JSON.parse(readFileSync(remotePath)).writes,1);
});
