import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { atomicJSON, digest, uid } from '../starter/factory/core/contracts.mjs';
import { supervise } from '../starter/factory/core/supervisor.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { prepareGitInvocation, withGitHubGitScope } from '../starter/factory/adapters/github/git.mjs';

const repository={slug:'fictional/demo',account:'fictional',target:'main'};
const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
const git=(root,...args)=>execFileSync(realGit,args,{cwd:root,encoding:'utf8'}).trim();

test('per-call Git maintenance overrides win over repository and ambient settings in scoped and unscoped calls',async t=>{
  const f=sandbox(t);git(f.root,'config','maintenance.auto','true');git(f.root,'config','gc.auto','37');
  const env={...process.env,GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'maintenance.auto',GIT_CONFIG_VALUE_0:'true',GIT_CONFIG_KEY_1:'gc.auto',GIT_CONFIG_VALUE_1:'99'};
  const check=async()=>{
    for(const [key,expected] of [['maintenance.auto','false'],['gc.auto','0']]){
      const prepared=await prepareGitInvocation(['config','--get',key],{cwd:f.root,env});
      assert.equal(execFileSync(realGit,prepared.args,{cwd:f.root,env:prepared.env,encoding:'utf8'}).trim(),expected);
    }
  };
  await check();
  await withGitHubGitScope(repository,check,{transport:async()=>({code:0,stdout:'fictional-token'})});
  assert.equal(git(f.root,'config','--local','maintenance.auto'),'true');assert.equal(git(f.root,'config','--local','gc.auto'),'37');
  assert.equal(env.GIT_CONFIG_VALUE_0,'true');assert.equal(env.GIT_CONFIG_VALUE_1,'99','caller environment is unchanged');
});

test('real supervised commits suppress automatic maintenance children despite enabled local configuration',async t=>{
  const f=sandbox(t),priorPath=process.env.PATH;t.after(()=>{process.env.PATH=priorPath;});
  git(f.root,'config','maintenance.auto','true');git(f.root,'config','gc.auto','1');git(f.root,'config','gc.autoDetach','false');
  const controlTrace=join(f.base,'control-trace.jsonl');
  execFileSync(realGit,['-c','core.hooksPath=/dev/null','commit','--allow-empty','-qm','Control commit'],{cwd:f.root,env:{...process.env,GIT_TRACE2_EVENT:controlTrace},stdio:'pipe'});
  const events=path=>readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const maintenance=rows=>rows.filter(row=>row.event==='child_start'&&row.argv?.includes('maintenance'));
  assert.ok(maintenance(events(controlTrace)).length,'positive control: ordinary Git invokes automatic maintenance');
  for(const mode of ['rehearsal','delivery']){
    process.env.PATH=priorPath;
    const workspace=await prepare({root:f.root,stateDir:f.stateDir,projectId:'fictional',flowId:mode,baseRef:'HEAD'});
    writeFileSync(join(workspace.path,'input.txt'),`Candidate for ${mode}\n`);
    const bin=join(f.base,`bin-${mode}`),trace=join(f.base,`trace-${mode}.jsonl`);mkdirSync(bin);
    // Instrument real Git after environment scoping, without changing its argv.
    writeFileSync(join(bin,'git'),`#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const r=spawnSync(${JSON.stringify(realGit)},process.argv.slice(2),{env:{...process.env,GIT_TRACE2_EVENT:${JSON.stringify(trace)}},stdio:'inherit'});process.exit(r.status??1);`,{mode:0o700});
    const ghPath=join(bin,'gh');writeFileSync(ghPath,`#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');`,{mode:0o700});
    process.env.PATH=`${bin}:${priorPath}`;
    const artifactDir=join(f.base,`attempt-${mode}`),intentPath=join(artifactDir,'intent.json');
    const intent={version:1,attemptId:uid(),argv:[process.execPath,join(process.cwd(),'starter/factory/workflows/dispatch.mjs'),intentPath],projectRoot:f.root,cwd:workspace.path,timeoutMs:60000,synthetic:true,maxCostMicros:0,action:{operation:'workspace.commit',workspace,projectId:'fictional',flowId:mode,stateDir:f.stateDir,artifactDir,config:{mode,repository:{...repository,ghPath}},task:{id:'task',title:'Fictional commit',acceptance:['Persist the candidate']},context:{files:[]},results:{}}};
    atomicJSON(intentPath,{...intent,intentDigest:digest(intent)});
    const receipt=await supervise(intentPath),result=JSON.parse(readFileSync(join(artifactDir,'action-result.json'),'utf8'));
    assert.equal(receipt.exitCode,0);assert.equal(receipt.reason,null);assert.equal(receipt.descendants.length,0);
    assert.equal(result.committed,true);assert.equal(result.route,'committed');
    assert.equal(git(workspace.path,'show','HEAD:input.txt'),`Candidate for ${mode}`);
    assert.deepEqual(maintenance(events(trace)),[],`${mode}: no Git maintenance child was launched`);
  }
  process.env.PATH=priorPath;
  assert.equal(git(f.root,'config','--local','maintenance.auto'),'true');assert.equal(git(f.root,'config','--local','gc.auto'),'1');
});
