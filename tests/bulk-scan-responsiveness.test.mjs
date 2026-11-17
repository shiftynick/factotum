import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { once } from 'node:events';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { waitingOnMain, ensureMainVerification } from '../starter/factory/operations/main-freshness.mjs';
import { captureConflictScope } from '../starter/factory/operations/conflicts.mjs';
import { collection } from '../starter/factory/service/project-service.mjs';
import { requestProject } from '../starter/factory/console/client.mjs';

// One observation of the active workspace is four slow git reads in the fixture.
const WORKSPACE_OBSERVATION = 4;
async function fixture(t) {
  const f=sandbox(t);
  f.store.setMeta('config',{mode:'delivery',repository:{target:'main'},policy:{autoQueue:true}});
  f.store.setMeta('commissioning',{ready:true,configDigest:f.store.meta('configDigest')});
  f.store.setMeta('mainHealth',{status:'unknown'});
  const workspace=await prepare({root:f.root,stateDir:f.stateDir,projectId:f.project.projectId,flowId:'active'});
  f.store.put('flow',{id:'active',taskId:'active-task',kind:'change',state:'running',workspace});
  for(let i=0;i<15;i++) {
    f.store.put('task',{id:`queued-${i}`,title:'Fictional task',acceptance:['Works'],revision:'r',approvedRevision:'r',paths:['input.txt']});
    f.store.put('queue',{id:`queued-${i}`,status:'queued',order:i});
  }
  return f;
}

test('bulk health and task reads scan each active workspace once; fresh health does not scan',async t=>{
  const f=await fixture(t), real=childProcess.execFileSync;let calls=0;
  childProcess.execFileSync=(binary,args,options)=>{if(binary==='git'&&args[0]==='--no-optional-locks')calls++;return real(binary,args,options);};
  syncBuiltinESMExports();t.after(()=>{childProcess.execFileSync=real;syncBuiltinESMExports();});
  assert.equal(waitingOnMain(f.store).length,15);assert.equal(calls,4,'one workspace observation for the batch');
  calls=0;collection(f.store,'task',new URLSearchParams('limit=100'));assert.equal(calls,4);
  const conflictScope=captureConflictScope(f.store);calls=0;
  assert.ok(f.store.tx(()=>ensureMainVerification(f.store,{conflictScope})));assert.equal(calls,0,'operations passes its existing observation');
  f.store.setMeta('mainHealth',{status:'green',checkedAt:new Date().toISOString()});
  calls=0;assert.deepEqual(waitingOnMain(f.store),[]);assert.equal(calls,0);
  // Caller time, including future timestamps and stale observations, controls freshness.
  assert.equal(waitingOnMain(f.store,undefined,{nowMs:Date.now()+7200000}).length,15);assert.equal(calls,4);
});

test('socket handshake, operator command and Tasks page meet the console deadline during a slow queue scan',async t=>{
  const f=await fixture(t), socketPath=join(f.base,'service.sock');
  const child=childProcess.fork(new URL('./fixtures/slow-scan-service.mjs',import.meta.url),[f.stateDir,socketPath],{stdio:['ignore','ignore','pipe','ipc']});
  let error='';child.stderr.on('data',b=>{error+=b;});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}});
  const next=type=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{cleanup();reject(new Error(`No ${type}: ${error}`));},10000);
    const message=m=>{if(m.type===type){cleanup();resolve(m);}};
    const exit=()=>{cleanup();reject(new Error(`Service exited: ${error}`));};
    function cleanup(){clearTimeout(timer);child.off('message',message);child.off('exit',exit);}
    child.on('message',message);child.on('exit',exit);
  });
  await next('ready');const started=next('scanning'), finished=next('scanned');child.send('scan');await started;
  const begin=performance.now();
  const [handshake,command,page]=await Promise.all([
    requestProject(socketPath,{path:'/v1/handshake'}),
    requestProject(socketPath,{method:'POST',path:'/v1/commands',body:{protocolVersion:1,projectId:f.project.projectId,commandId:'during-scan',actor:'operator',operation:'pause',payload:{paused:true,note:'Pause during the slow scan'}}}),
    requestProject(socketPath,{path:'/v1/collections/task?limit=100'}),
  ]);
  assert.equal(handshake.projectId,f.project.projectId);assert.equal(command.status,'completed');assert.equal(page.items.length,16);
  assert.ok(performance.now()-begin<1500,'real client deadline stays below 1.5 seconds');
  assert.equal((await finished).scans,4);
});

// The deadline above is real time. This bounds the work behind it independently of host load:
// how many slow workspace scans the service performs while serving the same three requests.
test('serving the handshake, operator command and Tasks page during a slow queue scan costs at most one more workspace scan',async t=>{
  const f=await fixture(t), socketPath=join(f.base,'service.sock');
  const child=childProcess.fork(new URL('./fixtures/slow-scan-service.mjs',import.meta.url),[f.stateDir,socketPath],{stdio:['ignore','ignore','pipe','ipc']});
  let error='';child.stderr.on('data',b=>{error+=b;});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}});
  const next=type=>new Promise((resolve,reject)=>{
    const message=m=>{if(m.type===type){cleanup();resolve(m);}};
    const exit=()=>{cleanup();reject(new Error(`Service exited: ${error}`));};
    function cleanup(){child.off('message',message);child.off('exit',exit);}
    child.on('message',message);child.on('exit',exit);
  });
  await next('ready');const started=next('scanning'), finished=next('scanned');child.send('scan');await started;
  // Bounds only a stuck service; this test does not measure time.
  const [handshake,command,page]=await Promise.all([
    requestProject(socketPath,{path:'/v1/handshake',timeoutMs:60000}),
    requestProject(socketPath,{method:'POST',path:'/v1/commands',timeoutMs:60000,body:{protocolVersion:1,projectId:f.project.projectId,commandId:'during-scan',actor:'operator',operation:'pause',payload:{paused:true,note:'Pause during the slow scan'}}}),
    requestProject(socketPath,{path:'/v1/collections/task?limit=100',timeoutMs:60000}),
  ]);
  assert.equal(handshake.projectId,f.project.projectId);assert.equal(command.status,'completed');assert.equal(page.items.length,16);
  assert.equal((await finished).scans,WORKSPACE_OBSERVATION,'the queue scan observes the one active workspace once');
  const counted=next('count');child.send('count');
  const during=(await counted).scans-WORKSPACE_OBSERVATION;
  assert.ok(during<=WORKSPACE_OBSERVATION,`the three requests observe the active workspace at most once (${during} slow reads)`);
});
