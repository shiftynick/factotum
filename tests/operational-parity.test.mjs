import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { HostResources, resourceRequest, ownerState } from '../starter/factory/operations/resources.mjs';
import { orderedQueue } from '../starter/factory/operations/queue-order.mjs';
import { claimCandidate, admissionReasons } from '../starter/factory/operations/admission.mjs';
import { runMaintenanceAction } from '../starter/factory/workflows/maintenance.mjs';
import { sandbox } from './helpers.mjs';

function host(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(),'factotum-weighted-'));
  const resources = new HostResources(join(root,'host.sqlite'), options);
  t.after(() => { resources.close(); rmSync(root,{recursive:true,force:true}); }); return resources;
}
const request = (id, extra = {}) => ({ projectId:id,flowId:'flow',attemptId:id,weight:2,capacity:4,...extra });
test('weighted pool admits bounded concurrent owners, fences exclusive clients and preserves uncertain owners',t=>{
  let state='alive'; const resources=host(t,{inspectOwner:()=>state});
  const a=resources.acquire(request('a')),b=resources.acquire(request('b'));assert.ok(a);assert.ok(b);
  assert.equal(resources.get('heavy-work').poolFence,true);assert.equal(ownerState(resources.get('heavy-work').owner),'alive');
  assert.equal(resources.acquire(request('c')),null);
  const numeric=resources.status('heavy-work');assert.equal(numeric.capacity,4);assert.equal(numeric.usedWeight,4);assert.equal(numeric.availableWeight,0);assert.equal(numeric.holders,2);assert.ok(!JSON.stringify(numeric).includes('projectId'));
  assert.equal(resources.acquire({projectId:'legacy',flowId:'f',attemptId:'legacy'}),null);
  assert.equal(resources.acquire(request('a')).token,a.token);
  state='uncertain';assert.equal(resources.reconcile('heavy-work'),'uncertain');assert.equal(resources.acquire(request('c')),null);
  assert.throws(()=>resources.acquire(request('different-policy',{capacity:8})),/configuration differs/);
  resources.release(a.resource,a.token);assert.ok(resources.acquire(request('c')));
  state='dead';assert.equal(resources.reconcile('heavy-work'),'dead');assert.equal(resources.weighted('heavy-work').length,0);
  const exclusive=resources.acquire({projectId:'legacy',flowId:'f',attemptId:'legacy'});assert.ok(exclusive);
  state='alive';assert.equal(resources.acquire(request('d')),null);resources.release(exclusive.resource,exclusive.token);
});
test('weighted load and memory gates fail closed for stale, unknown, loaded or pressured observations',t=>{
  let sample={observedAt:new Date().toISOString(),loadAverage:[2,1,1],memoryBytes:{available:1024}};
  const resources=host(t,{inspectOwner:()=> 'alive',sample:()=>sample});
  const options={maxLoadAverage:1,minAvailableMemoryBytes:512};
  assert.equal(resources.acquire(request('loaded',options)),null);
  sample={...sample,loadAverage:[0,0,0],memoryBytes:{available:128}};assert.equal(resources.acquire(request('pressured',options)),null);
  sample={...sample,memoryBytes:{available:1024},observedAt:'2020-01-01T00:00:00Z'};assert.equal(resources.acquire(request('stale',options)),null);
  sample={...sample,observedAt:new Date().toISOString()};assert.ok(resources.acquire(request('healthy',options)));
  const config={resources:{pools:{verification:{capacity:4,maxLoadAverage:2}},operations:{gate:{resource:'verification',weight:2}}}};
  assert.deepEqual(resourceRequest(config,'gate'),{resource:'verification',weight:2,capacity:4,maxLoadAverage:2});assert.deepEqual(resourceRequest(config,'unconfigured'),{});
});
test('ranked queue keeps manual pins in exact positions and category capacity uses pinned active snapshots',t=>{
  const f=sandbox(t),policy={maxFlows:4,queueRanking:true,categoryOrder:['policy','feature'],categoryLimits:{policy:1}};
  f.store.setMeta('config',{mode:'delivery',policy});f.store.setMeta('mainHealth',{status:'green',checkedAt:new Date().toISOString()});f.store.setMeta('commissioning',{ready:true,configDigest:f.store.meta('configDigest')});
  for(const [id,category,order,priority,pinned] of [['feature','feature',0,0,false],['pin','feature',1,-1,true],['policy','policy',2,0,false],['urgent','feature',3,2,false]]){
    f.store.put('task',{id,revision:'r',approvedRevision:'r',category});f.store.put('queue',{id,status:'queued',order,priority,pinned});
  }
  assert.deepEqual(orderedQueue(f.store).map(row=>row.id),['urgent','pin','policy','feature']);
  const flow=claimCandidate(f.store,{admit:(task,store)=>store.put('flow',{id:'admitted',taskId:task.id,taskSnapshot:task,state:'ready'})});assert.equal(flow.taskId,'urgent');
  f.store.put('flow',{id:'active-policy',taskId:'changed',taskSnapshot:{category:'policy'},state:'stopped'});
  assert.match(admissionReasons(f.store,f.store.get('task','policy')).join('; '),/category capacity exhausted/);
});
test('canonical queue edits retain priorities across ordinary reorders and reject invalid pin metadata atomically',t=>{
  const f=sandbox(t),id=f.task.id;
  assert.equal(f.command('queue.put',{taskIds:[id],entries:[{id,priority:5,pinned:true}]}).status,'completed');
  assert.equal(f.command('queue.put',{taskIds:[id]}).status,'completed');assert.equal(f.store.get('queue',id).priority,5);assert.equal(f.store.get('queue',id).pinned,true);
  const before=f.store.get('queue',id);
  f.store.setMeta('retentionHold',{id:'archive-in-progress'});
  assert.match(admissionReasons(f.store,f.store.need('task',id)).join('; '),/project held/);
  f.store.setMeta('retentionHold',null);assert.equal(f.command('queue.put',{taskIds:[id],entries:[{id,pinned:'yes'}]}).status,'rejected');assert.deepEqual(f.store.get('queue',id),before);
});

test('weighted pool serializes actual independent processes without exceeding configured capacity',async t=>{
  const root=mkdtempSync(join(tmpdir(),'factotum-weighted-race-')),path=join(root,'host.sqlite');t.after(()=>rmSync(root,{recursive:true,force:true}));
  const module=new URL('../starter/factory/operations/resources.mjs',import.meta.url).href;
  const code=`import {HostResources} from ${JSON.stringify(module)};const coordinator=new HostResources(process.argv[1]);const owner=process.argv[2];let lease;const end=Date.now()+10000;while(!(lease=coordinator.acquire({projectId:owner,flowId:owner,attemptId:owner,weight:1,capacity:2}))){if(Date.now()>end)throw Error('capacity wait exhausted');await new Promise(r=>setTimeout(r,10));}console.log(JSON.stringify({weight:coordinator.weighted('heavy-work').reduce((sum,l)=>sum+l.weight,0)}));await new Promise(r=>setTimeout(r,100));coordinator.release(lease.resource,lease.token);coordinator.close();`;
  const output=await Promise.all(Array.from({length:6},(_,index)=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code,path,String(index)],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('exit',code=>code?reject(Error(stderr)):resolve(JSON.parse(stdout.trim())));
  })));
  assert.equal(output.length,6);assert.ok(output.every(row=>row.weight>=1&&row.weight<=2));assert.ok(output.some(row=>row.weight===2));
  const coordinator=new HostResources(path);assert.equal(coordinator.weighted('heavy-work').length,0);assert.equal(coordinator.get('heavy-work'),undefined);coordinator.close();
});

test('machine sampling includes numeric host reservations without holder identities',async t=>{
  const resources=host(t,{inspectOwner:()=> 'alive'}),path=resources.db.prepare('PRAGMA database_list').get().file;
  const lease=resources.acquire(request('private-project'));
  const read=path=>path==='/proc/loadavg'?'0.1 0.2 0.3 1/1 1':path==='/proc/uptime'?'100 10':'MemTotal: 8192 kB\nMemAvailable: 4096 kB\n';
  const result=await runMaintenanceAction({action:{operation:'machine.sample',config:{resources:{coordinatorPath:path,pools:{'heavy-work':{capacity:4}}}}}},{machineRead:read});
  const observed=result.machineSample.hostResources;assert.equal(observed.status,'observed');assert.equal(observed.pools[0].usedWeight,2);assert.equal(observed.pools[0].availableWeight,2);assert.ok(!JSON.stringify(observed).includes('private-project'));assert.ok(!JSON.stringify(observed).includes('pid'));
  resources.release(lease.resource,lease.token);
});
