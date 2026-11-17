import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { authorized } from '../starter/factory/core/project.mjs';

test('retention recovery bypasses unrelated queued maintenance and rebinds only the matching hold',async t=>{
  const f=sandbox(t),config={mode:'delivery',policy:{},repository:{slug:'fictional/retention',account:'fictional',target:'main'}};
  f.store.setMeta('config',config);f.store.setMeta('configDigest',digest(config));
  const unrelated=f.command('job.enqueue',{operation:'retrospective',payload:{},note:'Previously approved unrelated maintenance'}).result;
  f.store.setMeta('retentionHold',{operationId:'retention-one',flowId:'old-retention'});
  assert.equal(f.command('job.enqueue',{operation:'retention.archive',payload:{operationId:'different'},note:'Wrong recovery'}).status,'rejected');
  assert.equal(f.command('task.put',{task:{id:'new-task',title:'New work',acceptance:['Observed outcome']}}).status,'rejected');
  const recovery=f.command('job.enqueue',{operation:'retention.archive',payload:{operationId:'retention-one'},note:'Reconcile the original archive operation'});assert.equal(recovery.status,'completed');
  await operationalTick(f.store);
  assert.equal(f.store.need('job',unrelated.id).status,'queued');assert.equal(f.store.need('job',recovery.result.id).status,'running');
  const flow=f.store.need('flow',f.store.need('job',recovery.result.id).flowId);
  assert.equal(f.store.meta('retentionHold').flowId,flow.id);assert.doesNotThrow(()=>authorized(f.store,flow));
});
test('retention owner can reconcile a quiescent uncertain attempt and abandon without releasing the hold',async t=>{
  const f=sandbox(t);f.start();await f.engine.tick();const flow=f.store.need('flow','flow-1'),attempt=f.store.need('attempt',flow.attemptId);
  f.store.put('attempt',{...attempt,status:'uncertain'});f.command('stop',{flowId:flow.id,note:'Independently inspected before dispatch'});
  f.store.setMeta('retentionHold',{operationId:'retention-one',flowId:flow.id});
  const resolved=f.command('attempt.resolve',{attemptId:attempt.id,disposition:'not-dispatched',costMicros:0,quiescence:'independently-confirmed',note:'Prepared invocation never launched'});assert.equal(resolved.status,'completed');
  assert.equal(f.command('flow.abandon',{flowId:flow.id,note:'Preserve records; recover archive through a new scoped job'}).status,'completed');assert.equal(f.store.meta('retentionHold').operationId,'retention-one');
});
