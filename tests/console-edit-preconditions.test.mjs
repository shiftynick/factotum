import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';

test('a stale UI brief edit cannot overwrite a concurrent revision or revoke its renewed approval', t => {
  const f = sandbox(t); assert.deepEqual(snapshot(f.store).editPreconditions,{operatorPresenceVersion:true,taskRevision:true,scheduleGrant:true,queueOrder:true}); const old = f.store.need('task',f.task.id);
  const newer = f.command('task.put',{task:{id:old.id,title:'Newer independently edited brief',acceptance:['Preserve this newer outcome']}}).result;
  f.command('task.approve',{taskId:newer.id,revision:newer.revision});
  const before=f.store.need('task',old.id);
  const stale=f.command('task.put',{expectedRevision:old.revision,task:{id:old.id,title:'Stale browser edit',acceptance:['Old outcome']}});
  assert.equal(stale.status,'rejected');assert.match(stale.error,/revision changed/);assert.deepEqual(f.store.need('task',old.id),before);
  const fresh=f.command('task.put',{expectedRevision:newer.revision,task:{id:old.id,title:'Reviewed current brief',acceptance:['Explicitly updated outcome']}});
  assert.equal(fresh.status,'completed');assert.equal(fresh.result.approvedRevision,null);
});

test('new-task forms cannot accidentally replace an ID created after their observation',t=>{
  const f=sandbox(t);const brief={id:'new-task',title:'Fictional task',acceptance:['Original']};
  assert.equal(f.command('task.put',{expectedRevision:null,task:brief}).status,'completed');
  assert.equal(f.command('task.put',{expectedRevision:null,task:{...brief,title:'Colliding new-task form'}}).status,'rejected');
  assert.equal(f.store.need('task',brief.id).title,brief.title);
});

test('schedule edits and enable/disable controls compare the observed grant and enabled state atomically',t=>{
  const f=sandbox(t),initial={id:'periodic-main',operation:'main.verify',type:'interval',everyMs:60000};
  const first=f.command('schedule.put',{expectedSchedule:null,schedule:initial}).result;
  const expected={revision:first.revision,enabled:true};
  const newer=f.command('schedule.put',{schedule:{...initial,everyMs:120000}}).result;
  assert.equal(f.command('schedule.put',{expectedSchedule:expected,schedule:{...initial,everyMs:180000}}).status,'rejected');
  assert.equal(f.command('schedule.remove',{scheduleId:initial.id,expectedSchedule:expected}).status,'rejected');
  assert.equal(f.store.need('schedule',initial.id).everyMs,120000);
  const current={revision:newer.revision,enabled:true};
  assert.equal(f.command('schedule.remove',{scheduleId:initial.id,expectedSchedule:current}).status,'completed');
  assert.equal(f.command('schedule.put',{expectedSchedule:current,schedule:{...initial,enabled:true}}).status,'rejected','a disable must invalidate old enable authority even when its stored revision is unchanged');
  const disabled=f.store.need('schedule',initial.id);
  assert.equal(f.command('schedule.put',{expectedSchedule:{revision:disabled.revision,enabled:false},schedule:{...initial,enabled:true}}).status,'completed');
});


test('a stale queue editor cannot overwrite a concurrent queue replacement or requeue a claimed task',t=>{
  const f=sandbox(t);const second=f.command('task.put',{task:{id:'second',title:'Second fixture',acceptance:['Second outcome']}}).result;
  f.command('queue.put',{taskIds:[f.task.id,second.id]});
  const observed=[f.task.id,second.id];f.command('queue.put',{taskIds:[second.id]});
  const stale=f.command('queue.put',{expectedTaskIds:observed,taskIds:[second.id,f.task.id]});
  assert.equal(stale.status,'rejected');assert.match(stale.error,/queue changed/);
  assert.deepEqual(f.store.all('queue').filter(q=>q.status==='queued').map(q=>q.id),[second.id]);
  assert.equal(f.command('queue.put',{expectedTaskIds:[second.id],taskIds:[f.task.id,second.id]}).status,'completed');
});
