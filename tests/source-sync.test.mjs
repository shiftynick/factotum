import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sandbox,until} from './helpers.mjs';
import {digest} from '../starter/factory/core/contracts.mjs';
import {syncIssueSource,verifyCommandSource} from '../starter/factory/workflows/source-sync.mjs';
import {sourceSettings} from '../starter/factory/operations/source-config.mjs';
import {admissionReasons} from '../starter/factory/operations/admission.mjs';
import {operationalTick} from '../starter/factory/workflows/maintenance.mjs';
const issue=(number,{state='open',body,labels=[],dependencies=[]}={})=>({number,state,title:`Fictional outcome ${number}`,labels,body:body??'```factotum-task\n'+JSON.stringify({version:1,acceptance:['Observe the outcome'],risk:'ordinary',dependencies})+'\n```'});
function setup(t,sourceSync){const f=sandbox(t),config={mode:'delivery',repository:{slug:'fictional/demo',account:'fictional',target:'main'},policy:{},...(sourceSync?{sourceSync}:{})};f.store.setMeta('config',config);f.store.setMeta('configDigest',digest(config));return {...f,config};}
function gh(rows){return async({path})=>{if(path.includes('?'))return Object.values(rows).filter(r=>r.state==='open');const n=Number(path.split('/').at(-1));if(!rows[n])throw Object.assign(Error('missing'),{status:404});return rows[n];};}
function approve(f,id){const task=f.store.need('task',id);assert.equal(f.command('task.approve',{taskId:id,revision:task.revision}).status,'completed');return f.store.need('task',id);}

test('GitHub sync discovers eligible briefs, preserves unchanged approval, revokes changed briefs and observes dependency closure',async t=>{
 const f=setup(t),rows={1:issue(1),2:issue(2,{body:'A review discussion, not a task'}),3:issue(3,{dependencies:[1]})},transport=gh(rows);
 let report=await syncIssueSource(f.stateDir,{transport});assert.equal(report.imported,2);assert.equal(f.store.get('task','github:2'),undefined);assert.equal(f.store.need('task','github:3').approvedRevision,null);const prior=approve(f,'github:3');report=await syncIssueSource(f.stateDir,{transport});assert.equal(f.store.need('task',prior.id).approvedRevision,prior.revision);assert.equal(report.revoked,0);
 rows[1].state='closed';report=await syncIssueSource(f.stateDir,{transport});const task=f.store.need('task',prior.id);const revokedBefore=f.store.events(200).filter(e=>e.type==='task.approval-revoked').length;assert.equal(task.source.externalDependencies[0].state,'closed');assert.equal(task.approvedRevision,task.revision,'a dependency closing keeps the dependent approved');assert.ok(!admissionReasons(f.store,task).includes('dependency incomplete: github:1'));assert.equal(revokedBefore,f.store.events(200).filter(e=>e.type==='task.approval-revoked').length);
 approve(f,task.id);rows[3].title='Changed outcome';await syncIssueSource(f.stateDir,{transport});assert.equal(f.store.need('task',task.id).approvedRevision,null);assert.equal(f.store.meta('sourceSync').status,'ok');assert.ok(f.store.meta('sourceSync').lastObservedAt);
});
test('eligibility label removal and invalid changed briefs block tracked tasks and revoke approval',async t=>{
 const f=setup(t,{labels:['factory-task']}),rows={1:issue(1,{labels:['factory-task']}),2:issue(2)};await syncIssueSource(f.stateDir,{transport:gh(rows)});assert.equal(f.store.get('task','github:2'),undefined);approve(f,'github:1');rows[1].labels=[];await syncIssueSource(f.stateDir,{transport:gh(rows)});assert.equal(f.store.need('task','github:1').blocked,true);assert.equal(f.store.need('task','github:1').approvedRevision,null);
 rows[1].labels=['factory-task'];await syncIssueSource(f.stateDir,{transport:gh(rows)});approve(f,'github:1');rows[1].body='```factotum-task\nnot json\n```';const r=await syncIssueSource(f.stateDir,{transport:gh(rows)});assert.equal(r.status,'partial');assert.equal(f.store.need('task','github:1').blocked,true);assert.equal(f.store.need('task','github:1').approvedRevision,null);
});
test('bounded GitHub pagination does not change page size on a partial final page',async t=>{
 const f=setup(t,{maxItems:150}),rows=Array.from({length:150},(_,i)=>issue(i+1)),pages=[];
 const transport=async({path})=>{if(path.includes('?')){const u=new URL('https://example.invalid/'+path),size=Number(u.searchParams.get('per_page')),page=Number(u.searchParams.get('page'));pages.push({size,page});return rows.slice((page-1)*size,page*size);}return rows[Number(path.split('/').at(-1))-1];};
 const report=await syncIssueSource(f.stateDir,{transport});assert.equal(report.imported,150);assert.deepEqual(pages,[{size:100,page:1},{size:100,page:2}]);assert.equal(f.store.need('task','github:150').title,'Fictional outcome 150');assert.equal(report.complete,true);
});
test('failed discovery retains existing tasks and prior successful observation',async t=>{
 const f=setup(t),rows={1:issue(1)};await syncIssueSource(f.stateDir,{transport:gh(rows)});const prior=approve(f,'github:1'),observed=f.store.meta('sourceSync').lastObservedAt;
 await assert.rejects(syncIssueSource(f.stateDir,{transport:async()=>{throw Error('private-endpoint-secret');}}));assert.equal(f.store.need('task',prior.id).approvedRevision,prior.revision);assert.equal(f.store.meta('sourceSync').lastObservedAt,observed);assert.equal(f.store.meta('sourceSync').status,'failed');assert.doesNotMatch(JSON.stringify(f.store.meta('sourceSync')),/private-endpoint-secret/);
});
test('custom read adapter imports a separate namespace, verifies freshness and refreshes closed dependency facts without approval',async t=>{
 const f=setup(t,{type:'command',id:'tracker',namespace:'tracker:',argv:['fictional-reader']}),tasks=[{key:'9',title:'Custom outcome',acceptance:['Outcome observed'],state:'open',eligible:true,revision:'r1',dependencies:['1']}],dependencyFacts=[{key:'1',state:'open',revision:'d1'}];const run=async()=>({code:0,stdout:JSON.stringify({version:1,complete:true,observedAt:new Date().toISOString(),tasks,dependencyFacts})});
 await syncIssueSource(f.stateDir,{run});let task=f.store.need('task','tracker:9');assert.equal(task.source.kind,'command');assert.equal(task.source.repository,undefined);assert.equal(task.approvedRevision,null);await assert.rejects(verifyCommandSource(f.config,f.root,task,{run}),/dependency is not closed/);
 approve(f,task.id);dependencyFacts[0]={key:'1',state:'closed',revision:'d2'};await verifyCommandSource(f.config,f.root,f.store.need('task',task.id),{run});await syncIssueSource(f.stateDir,{run});task=f.store.need('task',task.id);assert.equal(task.approvedRevision,task.revision,'dependency progress keeps approval');assert.ok(!admissionReasons(f.store,{...task,approvedRevision:task.revision}).includes('dependency incomplete: tracker:1'));await verifyCommandSource(f.config,f.root,task,{run});tasks[0].title='Changed with same external revision';await assert.rejects(verifyCommandSource(f.config,f.root,task,{run}),/source task changed/);
});
test('incomplete custom snapshots do not retire unseen tasks; complete snapshots do, without closing them by inference',async t=>{
 const f=setup(t,{type:'command',id:'tracker',namespace:'tracker:',argv:['reader']});let tasks=[{key:'1',title:'Outcome',acceptance:['Observed'],state:'open',eligible:true,revision:'r1'}],complete=true;const run=async()=>({code:0,stdout:JSON.stringify({version:1,complete,observedAt:new Date().toISOString(),tasks})});await syncIssueSource(f.stateDir,{run});const prior=approve(f,'tracker:1');tasks=[];complete=false;await syncIssueSource(f.stateDir,{run});assert.equal(f.store.need('task',prior.id).approvedRevision,prior.revision);complete=true;await syncIssueSource(f.stateDir,{run});assert.equal(f.store.need('task',prior.id).blocked,true);assert.equal(f.store.need('task',prior.id).closed,false);
});
test('custom source sync runs as an actual supervised maintenance job and never approves imported work',async t=>{
 const f=setup(t),script=join(f.base,'source.mjs');writeFileSync(script,`console.log(JSON.stringify({version:1,complete:true,observedAt:new Date().toISOString(),tasks:[{key:'7',title:'Fixture work',acceptance:['Observed'],state:'open',eligible:true,revision:'r1'}]}));`);f.config.sourceSync={type:'command',id:'tracker',namespace:'tracker:',argv:[process.execPath,script]};f.store.setMeta('config',f.config);f.store.setMeta('configDigest',digest(f.config));
 const job=f.command('job.enqueue',{operation:'source.sync',note:'Refresh fictional issue source'});assert.equal(job.status,'completed',job.error);await operationalTick(f.store);await until(()=>['completed','failed'].includes(f.store.need('job',job.result.id).status),{tick:()=>f.engine.tick()});assert.equal(f.store.need('job',job.result.id).status,'completed');assert.equal(f.store.need('task','tracker:7').approvedRevision,null);assert.equal(f.store.meta('sourceSync').status,'ok');
 const schedule=f.command('schedule.put',{schedule:{id:'source-refresh',operation:'source.sync',type:'interval',everyMs:300000,enabled:true},note:'Periodic source observation'});assert.equal(schedule.status,'completed',schedule.error);
});
test('source configuration requires bounded, deliberate eligibility and separate custom namespace',()=>{
 assert.equal(sourceSettings({}).requireBrief,true);assert.throws(()=>sourceSettings({sourceSync:{requireBrief:false}}),/eligibility labels/);assert.throws(()=>sourceSettings({sourceSync:{type:'command',namespace:'github:',argv:['reader']}}),/namespace/);assert.throws(()=>sourceSettings({sourceSync:{maxItems:501}}),/maxItems/);
});
test('skipped discovery items are reported with the reason they were not imported',async t=>{
 const f=setup(t,{labels:['factory-task']}),rows={1:issue(1,{labels:['factory-task']}),2:issue(2),3:issue(3,{labels:['factory-task'],body:'No brief here'})};
 const report=await syncIssueSource(f.stateDir,{transport:gh(rows)});
 assert.equal(report.imported,1);assert.equal(report.skipped,2);
 assert.deepEqual(report.skippedItems,[{issue:2,reason:'missing labels: factory-task'},{issue:3,reason:'no fenced factotum-task brief'}]);
});
test('imported issues carry their labels, minus the eligibility labels',async t=>{
 const f=setup(t,{labels:['factory-task']}),rows={1:issue(1,{labels:['factory-task','docs','content']})};
 await syncIssueSource(f.stateDir,{transport:gh(rows)});
 assert.deepEqual(f.store.need('task','github:1').labels,['content','docs']);
});
test('tracked items show issues that are not workable tasks, read-only, and become tasks when given a brief',async t=>{
 const f=setup(t,{labels:['factory'],track:{labels:['operator','on-hold']}});
 const rows={1:issue(1,{labels:['factory']}),2:issue(2,{labels:['operator'],body:'Set up the newsletter account'}),3:issue(3,{labels:['on-hold'],body:'Paused'}),4:issue(4,{body:'Untracked noise'})};
 rows[2].html_url='https://github.example/issues/2';
 const report=await syncIssueSource(f.stateDir,{transport:gh(rows)});
 assert.equal(report.tracked,2);assert.equal(f.store.get('task','github:4'),undefined);
 const item=f.store.need('task','github:2');assert.equal(item.tracked,true);assert.deepEqual(item.acceptance,[]);assert.deepEqual(item.labels,['operator']);assert.equal(item.source.url,'https://github.example/issues/2');
 assert.equal(f.command('task.approve',{taskId:'github:2',revision:item.revision}).status,'rejected');
 assert.equal(f.command('queue.put',{taskIds:['github:2']}).status,'rejected');
 assert.ok(admissionReasons(f.store,item).some(reason=>/tracked item/.test(reason)));
 // Closing the issue closes the tracked item; adding a brief turns another into a task.
 rows[3].state='closed';rows[2].labels=['operator','factory'];rows[2].body=issue(2).body;
 await syncIssueSource(f.stateDir,{transport:gh(rows)});
 assert.equal(f.store.need('task','github:3').closed,true);
 const task=f.store.need('task','github:2');assert.equal(task.tracked,undefined);assert.deepEqual(task.acceptance,['Observe the outcome']);
 assert.equal(f.command('task.approve',{taskId:'github:2',revision:task.revision}).status,'completed');
});
test('track all-open imports every open issue without a brief',async t=>{
 const f=setup(t,{labels:['factory'],track:'all-open'}),rows={1:issue(1,{labels:['factory']}),2:issue(2,{body:'Anything open'})};
 await syncIssueSource(f.stateDir,{transport:gh(rows)});
 assert.equal(f.store.need('task','github:2').tracked,true);assert.equal(f.store.need('task','github:1').tracked,undefined);
 assert.throws(()=>sourceSettings({sourceSync:{track:'everything'}}),/track must be/);
});
