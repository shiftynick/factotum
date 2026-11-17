import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {sandbox,until,attemptState} from './helpers.mjs';
import {readFileSync} from 'node:fs';
import {ownerState} from '../starter/factory/operations/resources.mjs';
import {inspect} from '../starter/factory/core/effects.mjs';
import {runAction} from '../starter/factory/workflows/dispatch.mjs';

test('operator reconciliation cannot declare a still-running owned attempt settled',async t=>{
  // The effect stays live until the sandbox cleanup aborts it, so it is still running when settlement is attempted.
  const f=sandbox(t,{argv:[process.execPath,'-e','setInterval(()=>{},1000)']});
  f.start();await f.engine.tick();await f.engine.tick();const attempt=f.store.all('attempt')[0];
  await until(()=>inspect(f.store,attempt).kind==='running',{explain:attemptState(f,attempt)});
  f.engine.uncertain(attempt,'Fictional ambiguous dispatch acknowledgement');
  const receipt=f.command('attempt.resolve',{attemptId:attempt.id,disposition:'failed',costMicros:0,note:'Inspection cannot yet establish quiescence'});
  assert.equal(receipt.status,'rejected','a matching live owner must prevent manual settlement');
  assert.equal(f.store.need('flow','flow-1').attemptId,attempt.id);
  assert.equal(f.store.need('attempt',attempt.id).settledAt,undefined);
});

test('idempotent unchanged task synchronization preserves completed dependency status',async t=>{
  const f=sandbox(t);f.start();await until(()=>f.store.need('flow','flow-1').state==='completed',{tick:()=>f.engine.tick()});
  assert.equal(f.store.need('task',f.task.id).status,'completed');
  f.command('task.put',{task:{id:f.task.id,title:f.task.title,acceptance:f.task.acceptance}});
  assert.equal(f.store.need('task',f.task.id).status,'completed');
  assert.equal(f.store.need('task',f.task.id).approvedRevision,null);
});

test('approved recovery scope can verify its current red target without pretending it is green',async t=>{
  const f=sandbox(t),remote=join(f.base,'fictional-remote.git');
  execFileSync('git',['clone','--bare','--quiet',f.root,remote]);execFileSync('git',['remote','add','origin',remote],{cwd:f.root});
  const head=execFileSync('git',['rev-parse','HEAD'],{cwd:f.root,encoding:'utf8'}).trim(),target=execFileSync('git',['symbolic-ref','--short','HEAD'],{cwd:f.root,encoding:'utf8'}).trim();
  const config={repository:{slug:'fictional/qualification',account:'fictional',remote:'origin',target},policy:{recovery:true},providers:{}};
  const result=await runAction({cwd:f.root,projectRoot:f.root,action:{operation:'source.verify',stateDir:f.stateDir,projectId:'fictional-project',flowId:'recovery-flow',results:{},config,task:{...f.task,recovery:true},mainHealth:{status:'red',head,checkedAt:new Date().toISOString()},context:{files:[]},completionMode:'merge'}});
  assert.equal(result.route,'ready');assert.equal(result.head,head);
});

test('missing settlement workspace becomes a reconcilable uncertain attempt',async t=>{
  const f=sandbox(t);f.start();await f.engine.tick();await f.engine.tick();
  const attempt=f.store.all('attempt')[0];await until(()=>inspect(f.store,attempt).kind==='terminal');
  const flow=f.store.need('flow','flow-1');flow.workspace={path:join(f.stateDir,'missing-owned-workspace')};f.store.put('flow',flow);
  await f.engine.tick();
  assert.equal(f.store.need('flow','flow-1').state,'stopped');
  assert.equal(f.store.need('attempt',attempt.id).status,'uncertain','settlement errors must leave the explicit reconciliation command usable');
  await until(()=>ownerState(JSON.parse(readFileSync(join(f.stateDir,'attempts',attempt.id,'owner.json'),'utf8')))==='dead');
  assert.equal(f.command('attempt.resolve',{attemptId:attempt.id,disposition:'failed',costMicros:0,note:'External evidence inspected; missing workspace cannot be reconstructed'}).status,'completed');
});

test('first evaluation journey crash cannot replay a potentially stateful observation',async t=>{
  const f=sandbox(t);const {spawnSync}=await import('node:child_process');
  const extensions=new URL('../starter/factory/operations/extensions.mjs',import.meta.url).href,storeModule=new URL('../starter/factory/core/store.mjs',import.meta.url).href;
  const promises=[{id:'journey',description:'Fictional stateful journey'}];
  const script=`import {Store} from ${JSON.stringify(storeModule)};import {runEvaluation} from ${JSON.stringify(extensions)};const store=new Store(${JSON.stringify(f.stateDir)});await runEvaluation(store,{id:'crash-eval',promises:${JSON.stringify(promises)},observe:async()=>{process.exit(19)}});`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});assert.equal(child.status,19);
  const {runEvaluation}=await import('../starter/factory/operations/extensions.mjs');let calls=0;
  const result=await runEvaluation(f.store,{id:'crash-eval',promises,observe:async()=>{calls++;return{status:'passed',evidence:'must not execute'}}});
  assert.equal(calls,0,'an interrupted first journey is not safe to repeat');
  assert.equal(result.judgments.at(-1).value.outcomes[0].status,'untested');
});
