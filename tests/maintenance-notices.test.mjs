import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sandbox,until} from './helpers.mjs';
import {flowNotice} from '../starter/factory/core/project.mjs';
import {digest} from '../starter/factory/core/contracts.mjs';
import {operationalTick} from '../starter/factory/workflows/maintenance.mjs';
function flow(operation,result,extra={}){return {id:'fictional-maintenance',kind:'maintenance',jobId:'fictional-job',taskId:'job:fictional-job',step:'done',taskSnapshot:{title:`Maintenance: ${operation}`},workflow:{nodes:{run:{action:{operation}}}},results:{run:result},...extra};}
const clean={status:'ok',complete:true,errors:0,imported:0,changed:0,revoked:0};
function notice(f,row,outcome='completed'){f.store.tx(()=>flowNotice(f.store,row,outcome));return f.store.all('inbox');}
test('routine successful built-ins retain history without creating attention notices',t=>{const f=sandbox(t);for(const operation of ['main.verify','maintenance.backup','machine.sample','audit','retrospective','forge.lifecycle'])assert.equal(notice(f,flow(operation,{route:operation==='forge.lifecycle'?'ready':'pass',mainHealth:{status:'green'},findings:[]})).length,0,operation);assert.equal(notice(f,flow('source.sync',{route:'pass',sourceSync:clean})).length,0);});
test('source changes, partial scans and unknown evidence remain attention-worthy',t=>{const f=sandbox(t);for(const [i,sourceSync] of [{...clean,imported:1},{...clean,changed:1},{...clean,revoked:1},{...clean,status:'partial'},{...clean,complete:false},{...clean,errors:1},undefined].entries())assert.equal(notice(f,flow('source.sync',{route:'pass',sourceSync},{id:`scan-${i}`})).length,i+1);});
test('failed and stopped maintenance and actionable successful observations retain notices',t=>{const f=sandbox(t);const rows=[flow('source.sync',{route:'fail'}),flow('main.verify',{route:'pass',mainHealth:{status:'red'}}),flow('audit',{route:'pass',findings:[{title:'Finding'}]}),flow('main.verify',{route:'pass',mainHealth:{status:'green'},obligations:[{title:'Retained workspace'}]}),flow('machine.sample',{route:'blocked'})];for(const [i,row] of rows.entries())assert.equal(notice(f,{...row,id:`action-${i}`}).length,i+1);assert.equal(notice(f,flow('maintenance.backup',{route:'pass'},{id:'failed'}),'failed').length,6);assert.equal(notice(f,flow('source.sync',{route:'pass',sourceSync:clean},{id:'stopped'}),'stopped').length,7);});
test('development and custom integration completions keep existing notifications',t=>{const f=sandbox(t);assert.equal(notice(f,flow('source.sync',{route:'pass',sourceSync:clean},{kind:'change'})).length,1);assert.equal(notice(f,flow('integration.release',{route:'pass'},{id:'custom',integration:{id:'release'}})).length,2);assert.equal(notice(f,flow('unknown.operation',{route:'pass'},{id:'unknown'})).length,3);});
test('scheduled no-op source sync completes with evidence and retrospective but no inbox or delivery',async t=>{
 const f=sandbox(t),script=join(f.base,'reader.mjs');writeFileSync(script,"console.log(JSON.stringify({version:1,complete:true,observedAt:new Date().toISOString(),tasks:[]}));");
 const config={mode:'delivery',repository:{slug:'fictional/demo',account:'fictional',target:'main'},policy:{},sourceSync:{type:'command',id:'issues',namespace:'tracker:',argv:[process.execPath,script]}};f.store.setMeta('config',config);f.store.setMeta('configDigest',digest(config));
 assert.equal(f.command('schedule.put',{expectedSchedule:null,schedule:{id:'source-timer',operation:'source.sync',type:'interval',everyMs:900000,anchorMs:Date.now()-1000}}).status,'completed');
 f.store.tx(()=>{const scheduled=f.store.need('schedule','source-timer');scheduled.createdAt=new Date(Date.now()-2000).toISOString();f.store.put('schedule',scheduled);});
 await operationalTick(f.store);const job=f.store.all('job')[0];assert.ok(job?.scheduleId);await until(()=>f.store.need('job',job.id).status==='completed',{tick:()=>f.engine.tick()});await operationalTick(f.store);
 const completed=f.store.need('flow',f.store.need('job',job.id).flowId);assert.equal(completed.state,'completed');assert.equal(completed.results.run.sourceSync.unchanged,0);assert.ok(f.store.get('retrospective',completed.id));assert.ok(f.store.all('attempt').some(a=>a.flowId===completed.id&&a.settledAt));assert.equal(f.store.all('inbox').length,0);assert.equal(f.store.all('delivery').length,0);
});
