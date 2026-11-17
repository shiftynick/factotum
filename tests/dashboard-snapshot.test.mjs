import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {once} from 'node:events';
import {join} from 'node:path';
import {sandbox} from './helpers.mjs';
import {dashboardSnapshot} from '../starter/factory/service/dashboard.mjs';
import {snapshot,queueRevision} from '../starter/factory/core/project.mjs';
import {publicValue} from '../starter/factory/service/project-service.mjs';
import {requestProject} from '../starter/factory/console/client.mjs';
import {startConsole,registerProject} from '../starter/factory/console/console.mjs';

function history(f,count=130) {
  const text='Retained fictional evidence. '.repeat(2000),at=new Date().toISOString();
  f.store.tx(()=>{
    f.store.put('flow',{id:'old-stopped',taskId:'task-1',kind:'change',state:'stopped',step:'build',stopReason:'Inspect this older stop',createdAt:at,workspace:{path:'/never/scan/during/polling'}});
    f.store.put('attempt',{id:'old-uncertain',flowId:'old-stopped',step:'build',status:'uncertain',reason:'Unsettled outcome',reservedMicros:7});
    f.store.put('inbox',{id:'old-open',kind:'question',flowId:'old-stopped',status:'open',role:'operator',version:4,subjectVersion:'exact-subject',question:'Decide?',choices:['yes','no']});
    f.store.put('obligation',{id:'old-pending',status:'pending',title:'Retained obligation'});
    for(let i=0;i<count;i++){
      const id=`history-${i}`;
      f.store.put('flow',{id,taskId:'task-1',kind:'change',state:'completed',step:'done',createdAt:at,finishedAt:at,results:{plan:{result:{summary:text}},publish:{url:'https://example.invalid/pr/1'}},taskSnapshot:{title:'Fictional historical task',acceptance:[text]},workerReports:[{summary:text}]});
      f.store.put('attempt',{id,flowId:id,step:'plan',status:'passed',settledAt:at,costMicros:2,intent:{action:{context:{text}}},receipt:{actionResult:{summary:text}}});
      f.store.put('inbox',{id,status:'answered',kind:'question',question:'Historical question',version:2});
      f.store.put('obligation',{id,status:'passed',title:'Old obligation'});
      f.store.put('retrospective',{id,flowId:id,findings:[{evidence:text}],events:[{payload:{text}}]});
      f.store.putCommand({commandId:id,operation:'flow.start',status:'completed',result:{results:{plan:{summary:text}}}},id);
      f.store.put('task',{id,title:'Queued fictional task',acceptance:[text],revision:'r',approvedRevision:'r'});
      f.store.put('queue',{id,status:'queued',order:i,priority:0,pinned:false});
    }
  });
}

test('dashboard polling omits historical bodies and live Git while preserving all attention and queue authority',t=>{
  const f=sandbox(t);history(f);
  const legacyBytes=Buffer.byteLength(JSON.stringify(publicValue(f.store,snapshot(f.store))));assert.ok(legacyBytes>2*1024*1024);
  const expectedRevision=queueRevision(f.store);
  f.store.setMeta('config',{mode:'delivery',repository:{target:'main'},policy:{autoQueue:false}});
  const real=childProcess.execFileSync;let gitCalls=0;childProcess.execFileSync=()=>{gitCalls++;throw new Error('Polling must not run Git');};syncBuiltinESMExports();
  t.after(()=>{childProcess.execFileSync=real;syncBuiltinESMExports();});
  const result=publicValue(f.store,dashboardSnapshot(f.store)),bytes=Buffer.byteLength(JSON.stringify(result));
  assert.equal(gitCalls,0);assert.ok(bytes<250000,`${bytes} bytes`);t.diagnostic(`Fictional legacy snapshot ${legacyBytes} bytes; dashboard ${bytes} bytes.`);assert.equal(result.snapshotView,'dashboard-v1');
  assert.equal(result.flows.length,21);assert.ok(result.flows.some(f=>f.id==='old-stopped'));
  assert.ok(result.attempts.some(a=>a.id==='old-uncertain'));assert.equal(result.budget.actual,260);assert.equal(result.budget.reserved,7);
  const question=result.inbox.find(q=>q.id==='old-open');assert.equal(question.version,4);assert.equal(question.subjectVersion,'exact-subject');
  assert.ok(result.obligations.some(o=>o.id==='old-pending'));
  assert.equal(result.queueTasks.length,130);assert.equal(result.queueDispatchOrder.length,130);assert.equal(result.queueRevision,expectedRevision);assert.equal(result.queueComplete,true);
  assert.equal(result.tasks.length,100);assert.equal(result.taskCount,131);assert.equal(result.stats.flows.total,131);assert.equal(result.stats.partial,true);
  assert.equal(result.settings.activeFlows,1);assert.equal(result.queueTasks[0].admissionObserved,false);assert.match(result.queueTasks[0].admissionReasons[0],/detail/);
  assert.equal(result.retrospectives,undefined);assert.equal(result.commands,undefined);
  assert.ok(!JSON.stringify(result).includes('Retained fictional evidence.'));
  assert.ok(f.store.need('flow','history-0').results.plan.result.summary.length>50000,'canonical history is unchanged');
});

test('history-heavy service stays usable through the unchanged console transport and detail routes',async t=>{
  // Usability here is correct, bounded responses through the same client; timings are reported, not asserted,
  // so requests get a bound that only a stuck service reaches on a loaded host.
  const bound=30000;
  const f=sandbox(t);history(f);const socketPath=join(f.base,'dashboard.sock');
  const child=childProcess.fork(new URL('./fixtures/dashboard-service.mjs',import.meta.url),[f.stateDir,socketPath],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});
  t.after(async()=>{if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done;}});
  const [ready]=await once(child,'message');assert.equal(ready.type,'ready',stderr);
  const timings=[];
  for(let i=0;i<3;i++){
    const started=performance.now();
    const [view,hello]=await Promise.all([requestProject(socketPath,{path:'/v1/snapshot',timeoutMs:bound}),requestProject(socketPath,{path:'/v1/handshake',timeoutMs:bound})]);
    assert.equal(hello.projectId,f.project.projectId);assert.equal(view.queueTasks.length,130);timings.push(performance.now()-started);
  }
  t.diagnostic(`Concurrent snapshot/handshake calls: ${timings.map(n=>n.toFixed(1)).join(', ')} ms.`);
  const detail=await requestProject(socketPath,{path:'/v1/flows/history-0',timeoutMs:bound});
  assert.ok(detail.flow.results.plan.result.summary.length>50000);assert.ok(detail.retrospective.findings[0].evidence.length>50000);
  const command=await requestProject(socketPath,{path:'/v1/collections/command?order=desc&limit=1',timeoutMs:bound});assert.ok(command.items[0].result.results.plan.summary.length>50000);
  const consoleState=join(f.base,'console');await registerProject(consoleState,{socketPath},{timeoutMs:bound});const app=await startConsole({stateDir:consoleState,timeoutMs:bound});t.after(()=>app.close());
  const page=await fetch(app.url),cookie=page.headers.get('set-cookie').split(';')[0];await page.text();
  const projects=await (await fetch(app.url+'/api/projects',{headers:{cookie}})).json();assert.equal(projects[0].status,'available');assert.equal(projects[0].snapshot.queueComplete,true);
});

test('console response limit remains enforced even for a fast healthy socket',async t=>{
  const f=sandbox(t),socketPath=join(f.base,'oversized.sock'),server=http.createServer((req,res)=>res.end(JSON.stringify({padding:'x'.repeat(2*1024*1024)})));
  await new Promise(resolve=>server.listen(socketPath,resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  await assert.rejects(requestProject(socketPath,{path:'/v1/snapshot'}),/response exceeded limit/);
});

test('dashboard keeps schedule outcomes and recurring manual markers without historical execution bodies',t=>{
  const f=sandbox(t),at=new Date().toISOString();
  f.store.setMeta('config',{mode:'rehearsal',recurringTasks:{weekly:{task:{title:'Weekly fictional work',workflow:'task'}}},scheduledTasks:{check:{description:'Fictional check'}}});
  f.store.put('task',{id:'manual-task',title:'Manual occurrence',revision:'r',approvedRevision:'r',closed:false,tracked:true});
  f.store.put('schedule',{id:'recurring',recurringTask:'weekly',type:'interval',everyMs:60000,anchorMs:0,enabled:true});
  f.store.put('occurrence',{id:'manual',scheduleId:'recurring',at,commandId:'manual-task',manual:true});
  f.store.put('schedule',{id:'check',scheduledTask:'check',operation:'scheduled:check',type:'interval',everyMs:60000,anchorMs:0,enabled:true});
  f.store.put('job',{id:'job',scheduleId:'check',operation:'scheduled:check',flowId:'checked',createdAt:at,status:'completed'});
  f.store.put('flow',{id:'checked',kind:'maintenance',taskId:'job:job',state:'completed',finishedAt:at,results:{run:{route:'pass',exitCode:0,report:'x'.repeat(10000)+' tail'}}});
  let view=dashboardSnapshot(f.store);
  assert.equal(view.scheduled.find(r=>r.id==='recurring').last.manual,true);
  const task=view.tasks.find(t=>t.id==='manual-task');assert.equal(task.closed,false);assert.equal(task.tracked,true);
  const check=view.schedules.find(s=>s.id==='check');assert.equal(check.lastRun.result.route,'pass');assert.equal(check.lastRun.result.report.length,4000);assert.ok(check.lastRun.result.report.endsWith(' tail'));
  const flow=f.store.need('flow','checked');delete flow.results;f.store.put('flow',flow);view=dashboardSnapshot(f.store);
  assert.equal(view.schedules.find(s=>s.id==='check').lastRun.result,undefined,'absent outcome is not a fabricated null result');
});
