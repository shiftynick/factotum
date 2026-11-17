import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {sandbox} from './helpers.mjs';
import {snapshot,taskView} from '../starter/factory/core/project.mjs';
import {startProjectService} from '../starter/factory/service/project-service.mjs';
import {requestProject} from '../starter/factory/console/client.mjs';
import {startConsole,registerProject} from '../starter/factory/console/console.mjs';

function manyTasks(f,count=125){
 const ids=[];for(let i=0;i<count;i++){const id=`fixture-${String(i).padStart(3,'0')}`;ids.push(id);f.command('task.put',{task:{id,title:`Fictional task ${i}`,acceptance:['Verified outcome']}});}return ids;
}

test('complete queue projection and conditional metadata save preserve tasks beyond the bounded snapshot',t=>{
 const f=sandbox(t),ids=manyTasks(f);f.command('queue.put',{taskIds:ids});
 const before=snapshot(f.store);assert.equal(before.tasks.length,100);assert.equal(before.queueComplete,true);assert.equal(before.queueTasks.length,125);assert.equal(before.queue.length,125);assert.equal(before.taskCount,126);
 const order=[...ids];[order[0],order[1]]=[order[1],order[0]];
 const saved=f.command('queue.put',{taskIds:order,expectedTaskIds:ids,expectedQueueRevision:before.queueRevision,entries:[{id:ids[0],pinned:true,priority:9}]});assert.equal(saved.status,'completed');
 const current=snapshot(f.store),row=f.store.need('queue',ids[0]);assert.equal(row.pinned,true);assert.equal(row.priority,9);assert.equal(current.queue.filter(q=>q.status==='queued').length,125);
 assert.notEqual(current.queueRevision,before.queueRevision);
 const stale=f.command('queue.put',{taskIds:order.filter(id=>id!==ids[2]),expectedTaskIds:order,expectedQueueRevision:before.queueRevision});assert.equal(stale.status,'rejected');assert.match(stale.error,/metadata or order changed/);assert.equal(f.store.need('queue',ids[2]).status,'queued');
});

test('task approval labels derive from retained approval and revocation events across source changes',t=>{
 const f=sandbox(t),id=f.task.id;
 assert.equal(taskView(f.store,f.store.need('task',id)).approvalHistory,null);
 f.command('task.approve',{taskId:id,revision:f.task.revision});f.command('task.revoke',{taskId:id,note:'Operator changed direction'});
 assert.equal(taskView(f.store,f.store.need('task',id)).approvalHistory.event,'task.revoked');
 f.command('task.approve',{taskId:id,revision:f.task.revision});f.command('task.put',{task:{id,title:'Changed fictional brief',acceptance:['New outcome']}});
 const task=taskView(f.store,f.store.need('task',id));assert.equal(task.approvalHistory.event,'task.approval-revoked');assert.match(task.approvalHistory.reason,/brief or source/);assert.equal(task.approved,false);
});

test('paginated Tasks and direct old-task reads retain advisory facts and are proxy-bound to project registration',async t=>{
 const f=sandbox(t),ids=manyTasks(f),socketPath=join(f.base,'tasks.sock');
 f.command('task.approve',{taskId:ids[0],revision:f.store.need('task',ids[0]).revision});
 const service=await startProjectService({stateDir:f.stateDir,socketPath,run:false});t.after(()=>service.close());
 const read=path=>requestProject(socketPath,{path,timeoutMs:30000});
 const page=await read('/v1/collections/task?limit=50&order=desc');assert.equal(page.total,126);assert.equal(page.nextCursor,50);assert.equal(page.items[0].id,ids.at(-1));assert.ok(Array.isArray(page.items[0].admissionReasons));
 const detail=await read(`/v1/tasks/${ids[0]}`);assert.equal(detail.task.id,ids[0]);assert.equal(detail.task.approvalHistory.event,'task.approved');assert.deepEqual(detail.flows,[]);assert.equal(detail.plan,undefined);
 const registry=join(f.base,'console'),binding=await registerProject(registry,{socketPath},{timeoutMs:30000}),app=await startConsole({stateDir:registry,timeoutMs:30000});t.after(()=>app.close());
 const response=await fetch(app.url),cookie=response.headers.get('set-cookie').split(';')[0];await response.text();
 const get=path=>fetch(app.url+path,{headers:{cookie}}),base=`/api/project/${binding.projectId}/tasks/${ids[0]}`;
 const proxy=await get(`${base}?bindingId=${binding.bindingId}`);assert.equal(proxy.status,200);assert.equal((await proxy.json()).task.id,ids[0]);
 assert.equal((await get(`${base}?bindingId=stale-binding`)).status,409);assert.equal((await get(`${base}?bindingId=${binding.bindingId}&unexpected=1`)).status,400);
 assert.equal((await fetch(app.url+'/ui/queue.mjs')).status,200);
});

// A minimal DOM exercises the real queue editor handlers and command payload; no browser substitute for visual QA.
class Element {
 constructor(tag,text=''){this.tag=tag;this.children=[];this.handlers={};this.dataset={};this.style={setProperty(){}};this.disabled=false;this.checked=false;this.value='';this._text=text;}
 append(...items){this.children.push(...items);}
 addEventListener(name,handler){this.handlers[name]=handler;}
 setAttribute(key,value){this[key]=value;}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(c=>c.textContent??String(c)).join('');}
 reportValidity(){return true;}
}
const descendants=node=>[node,...node.children.flatMap(child=>child instanceof Element?descendants(child):[])];

test('Tasks aliases and real queue editing preserve hidden rows, reject stale metadata and keep dirty registration bindings',async()=>{
 const keys=['Node','document','localStorage','sessionStorage','window','fetch'];const old=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));
 const storage={getItem:()=>null,setItem(){}};
 Object.assign(globalThis,{Node:Element,document:{querySelector:()=>({content:'fixture-csrf'}),createElement:tag=>new Element(tag),createTextNode:text=>new Element('#text',text)},localStorage:storage,sessionStorage:storage,window:{dispatchEvent(){}}});
 try{
  const {parseRoute,TABS,state}=await import('../starter/factory/console/ui/state.mjs'),{queueEditor,approvalLabel}=await import('../starter/factory/console/ui/plan.mjs');
  assert.deepEqual(parseRoute('#/p/fictional/plan?task=github%3A1'),{projectId:'fictional',tab:'tasks',params:{task:'github:1'}});assert.equal(parseRoute('#/all/plan').tab,'tasks');assert.ok(TABS.some(t=>t.id==='queue'));assert.ok(!TABS.some(t=>t.id==='plan'));
  assert.equal(approvalLabel({revision:'a',approvedRevision:null,approvalHistory:{event:'task.revoked'}}),'Approval revoked');
  const project={projectId:'queue-fixture',bindingId:'original-binding',name:'Fictional queue',status:'available',snapshot:{queueComplete:true,queueRevision:'observed-revision',queue:[{id:'hidden',status:'queued',order:0},{id:'visible',status:'queued',order:1}],tasks:[{id:'visible',title:'Visible task'}]}};
  state.projects=[project];let payload;
  globalThis.fetch=async(_url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({status:'completed'})};};
  let tree=queueEditor(project);assert.ok(tree.textContent.includes('hidden'));const priority=descendants(tree).find(n=>n['aria-label']==='Priority for hidden'),pin=descendants(tree).find(n=>n.type==='checkbox');priority.handlers.input({target:{value:'7'}});pin.handlers.change({target:{checked:true}});assert.deepEqual(state.ui['queue:queue-fixture'].entries.hidden,{id:'hidden',priority:7,pinned:true});const dequeue=descendants(tree).find(n=>n['aria-label']==='Dequeue Visible task');dequeue.handlers.click();
  tree=queueEditor(project);const form=descendants(tree).find(n=>n.tag==='form');await form.handlers.submit({preventDefault(){}});assert.deepEqual(payload.payload.taskIds,['hidden']);assert.deepEqual(payload.payload.expectedTaskIds,['hidden','visible']);assert.equal(payload.payload.expectedQueueRevision,'observed-revision');assert.equal(payload.bindingId,'original-binding');assert.equal(payload.actor,'operator');assert.deepEqual(payload.payload.entries,[{id:'hidden',priority:7,pinned:true}]);
  project.bindingId='replacement-binding';tree=queueEditor(project);assert.match(tree.textContent,/earlier registration/);assert.equal(descendants(tree).find(n=>n.type==='submit').disabled,true);
  project.bindingId='original-binding';project.snapshot.queueRevision='new-metadata';tree=queueEditor(project);assert.match(tree.textContent,/queue changed since editing began/);assert.equal(descendants(tree).find(n=>n.type==='submit').disabled,true);
 }finally{for(const [key,value]of Object.entries(old))if(value===undefined)delete globalThis[key];else globalThis[key]=value;}
});
