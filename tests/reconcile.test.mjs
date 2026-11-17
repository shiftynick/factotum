import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { sandbox } from './helpers.mjs';
import { reconcileAttempt } from '../starter/factory/workflows/reconcile.mjs';
import { atomicJSON, digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { processIdentity } from '../starter/factory/core/process-identity.mjs';
import { createGitHub } from '../starter/factory/adapters/github/index.mjs';

async function uncertainFixture(t,operation,{alive=false}={}) {
  const f=sandbox(t);f.start();await f.engine.tick();
  const flow=f.store.need('flow','flow-1'),attempt=f.store.need('attempt',flow.attemptId),identity=repositoryIdentity(f.root);
  const step=operation==='forge.publish'?'publish':operation==='forge.merge'?'merge':'close-task';
  flow.workflow.nodes[step]={kind:'effect',argv:[process.execPath,'-e',''],timeoutMs:60000,next:'done',onFailure:'failed',resultEdges:{published:'done',merged:'done',closed:'done'}};
  flow.step=step;flow.state='stopped';flow.stopRequested=true;flow.stopReason='uncertain retained write';
  attempt.step=step;attempt.status='uncertain';attempt.dispatchedAt=new Date(Date.now()-10_000).toISOString();
  const config={repository:{slug:'fictional/retained',account:'fictional',target:'main'}};
  Object.assign(attempt.intent,{synthetic:false,action:{operation,projectId:f.project.projectId,flowId:flow.id,config,workspace:{path:f.root,branch:'factotum/owned'},results:{publish:{number:7},integrate:{base:identity.head}},mergeAuthorization:{identity},task:{source:{issue:3,revision:'unassigned'}}}});
  attempt.intentDigest=digest(attempt.intent);f.store.put('attempt',attempt);f.store.put('flow',flow);
  atomicJSON(join(f.stateDir,'attempts',attempt.id,'intent.json'),{...attempt.intent,intentDigest:attempt.intentDigest});
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});await once(child,'spawn');const owner={...processIdentity(child.pid),attemptId:attempt.id,intentDigest:attempt.intentDigest};
  if(!alive){const closed=once(child,'close');child.kill('SIGKILL');await closed;}else t.after(async()=>{if(child.exitCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}});
  const ownerPath=join(f.stateDir,'attempts',attempt.id,'owner.json');atomicJSON(ownerPath,owner);
  const requests=[];
  const pr={number:7,state:'open',merged:false,head:{sha:identity.head,ref:'factotum/owned'},base:{sha:identity.head,ref:'main'},html_url:'https://example.invalid/pull/7',merge_commit_sha:'c'.repeat(40),commits:1};
  const marker=`<!-- factotum:${digest(`${f.project.projectId}:${flow.id}:pr`)} -->`;
  const transport=async request=>{requests.push(request);assert.equal(request.method,'GET');assert(request.path.startsWith('repos/fictional/retained/'));if(request.path.includes('pulls?'))return[{number:7,body:marker}];if(request.path.includes('/issues/'))return{title:'Fictional source',body:'Brief',state:'closed',labels:[]};return pr;};
  return {...f,flow,attempt,identity,requests,transport,pr,ownerPath};
}

test('typed publication recovery uses only pinned read queries, persists proof and preserves stop',async t=>{
  const f=await uncertainFixture(t,'forge.publish');
  const result=await reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Inspect original publication after a lost response',transport:f.transport});
  assert.equal(result.status,'passed');assert.equal(result.flowStopped,true);assert.equal(result.next,'done');
  const flow=f.store.need('flow',f.flow.id);assert.equal(flow.state,'stopped');assert.equal(flow.attemptId,null);assert.equal(flow.results.publish.number,7);
  const proof=f.store.need('reconciliation',result.reconciliationId);assert.equal(proof.operation,'forge.publish');const {proofDigest,...content}=proof;assert.equal(proofDigest,digest(content));
  const artifact=join(f.stateDir,'reconciliations',`${proof.id}.json`);assert(existsSync(artifact));assert.equal(JSON.parse(readFileSync(artifact)).result.head,f.identity.head);
  const count=f.requests.length;assert.equal((await reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Repeat observation safely',transport:f.transport})).alreadySettled,true);assert.equal(f.requests.length,count);
});

test('typed publication recovery rejects a changed remote head without settlement',async t=>{
  const f=await uncertainFixture(t,'forge.publish');f.pr.head.sha='d'.repeat(40);
  await assert.rejects(reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Inspect candidate',transport:f.transport}),/candidate differs/);
  assert.equal(f.store.need('attempt',f.attempt.id).status,'uncertain');assert.equal(f.store.all('reconciliation').length,0);
});

test('typed merge recovery proves the original authorized head and never repeats merge',async t=>{
  const f=await uncertainFixture(t,'forge.merge');f.pr.merged=true;f.pr.state='closed';
  const result=await reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Read original merged PR',transport:f.transport});
  assert.equal(result.status,'passed');assert.equal(f.store.need('flow',f.flow.id).results.merge.expectedHead,f.identity.head);assert.equal(f.requests.length,1);
});

test('typed merge recovery rejects unmerged or wrong-head remote facts',async t=>{
  const f=await uncertainFixture(t,'forge.merge');
  await assert.rejects(reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Inspect unmerged PR',transport:f.transport}),/not proven/);
  f.pr.merged=true;f.pr.head.sha='e'.repeat(40);
  await assert.rejects(reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Inspect different merged head',transport:f.transport}),/not proven/);
  assert(!f.store.need('attempt',f.attempt.id).settledAt);
});

test('source closure recovery requires the exact unchanged closed task and records disposition',async t=>{
  const f=await uncertainFixture(t,'forge.closeTask');
  const normalized=await createGitHub({repository:'fictional/retained',transport:f.transport}).readTask(3);
  f.attempt.intent.action.task.source.revision=normalized.revision;f.attempt.intentDigest=digest(f.attempt.intent);f.store.put('attempt',f.attempt);
  atomicJSON(join(f.stateDir,'attempts',f.attempt.id,'intent.json'),{...f.attempt.intent,intentDigest:f.attempt.intentDigest});
  const owner=JSON.parse(readFileSync(f.ownerPath));owner.intentDigest=f.attempt.intentDigest;atomicJSON(f.ownerPath,owner);
  const result=await reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Verify existing closure',transport:f.transport});assert.equal(result.status,'passed');assert.equal(f.store.need('obligation','flow-1:close-task').status,'passed');
});

test('typed reconciliation refuses live or missing ownership and never queries remote state',async t=>{
  const f=await uncertainFixture(t,'forge.publish',{alive:true});
  await assert.rejects(reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Premature recovery',transport:f.transport}),/still live|quiescence/);assert.equal(f.requests.length,0);
  rmSync(f.ownerPath);
  await assert.rejects(reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Missing ownership',transport:f.transport}),/ownership evidence/);assert.equal(f.requests.length,0);
});

test('typed reconciliation refuses changed repository intent or divergent intent file before any remote query',async t=>{
  const f=await uncertainFixture(t,'forge.publish');
  const original=structuredClone(f.attempt);
  f.attempt.intent.action.config.repository.slug='fictional/other';f.store.put('attempt',f.attempt);
  await assert.rejects(reconcileAttempt(f.stateDir,f.attempt.id,{reason:'Inspect corrupt retained config',transport:f.transport}),/intent digest mismatch/);assert.equal(f.requests.length,0);
  f.store.put('attempt',original);atomicJSON(join(f.stateDir,'attempts',original.id,'intent.json'),{...f.attempt.intent,intentDigest:original.intentDigest});
  await assert.rejects(reconcileAttempt(f.stateDir,original.id,{reason:'Inspect divergent file',transport:f.transport}),/intent file differs/);assert.equal(f.requests.length,0);
});
