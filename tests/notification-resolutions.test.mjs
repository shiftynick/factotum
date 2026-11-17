import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHmac} from 'node:crypto';
import {sandbox} from './helpers.mjs';
import {Store} from '../starter/factory/core/store.mjs';
import {operationalTick} from '../starter/factory/workflows/maintenance.mjs';
import {queueDelivery,deliverDue,acknowledgeDelivery} from '../starter/factory/operations/notifications.mjs';
function fixture(t){const f=sandbox(t);f.store.setMeta('config',{mode:'delivery',policy:{},notifications:{level:'all'}});const configPath=join(f.base,'notifications.json');writeFileSync(configPath,JSON.stringify({url:'https://example.invalid/hook',signingKey:'fictional-signing-key'}),{mode:0o600});return {...f,configPath};}
const question={id:'decision-schedule',kind:'question',title:'Choose the schedule',context:'Fictional scheduling decision',question:'Which schedule?',choices:[{id:'weekly',label:'Weekly'},{id:'monthly',label:'Monthly'}]};

test('canonical console answer gets a durable versioned signed resolution wake and terminal delivery ack stops retries',async t=>{
 const f=fixture(t),created=f.command('inbox.publish',question).result;await operationalTick(f.store);const open=f.store.all('delivery')[0];acknowledgeDelivery(f.store,{deliveryId:open.id});
 const answered=f.command('answer',{inboxId:created.id,version:created.version,subjectDigest:created.subjectDigest,answer:'weekly'});assert.equal(answered.status,'completed',answered.error);await operationalTick(f.store);
 const resolution=f.store.all('delivery').find(d=>d.inboxVersion===2);assert.equal(resolution.event,'inbox.resolved');assert.equal(resolution.inboxStatus,'answered');assert.notEqual(open.id,resolution.id);
 // A fresh connection can deliver the persisted transition after controller loss.
 const recovered=new Store(f.stateDir);t.after(()=>recovered.close());let sends=0;const transport=async request=>{sends++;assert.equal(request.headers['x-factotum-signature'],createHmac('sha256','fictional-signing-key').update(request.payload).digest('hex'));const body=JSON.parse(request.payload);assert.equal(body.deliveryId,resolution.id);assert.equal(body.event,'inbox.resolved');assert.equal(body.status,'answered');assert.equal(body.version,2);assert.equal(recovered.need('inbox',body.inboxId).answer,'weekly');assert.equal(body.answer,undefined);return {status:202};};
 const nowMs=Date.now();await deliverDue(recovered,{configPath:f.configPath,transport,nowMs});assert.equal(sends,1);assert.equal(recovered.need('delivery',open.id).status,'superseded');assert.equal(recovered.need('delivery',resolution.id).status,'accepted');
 const receipt=f.command('delivery.ack',{deliveryId:resolution.id},{actor:'orchestrator'});assert.equal(receipt.status,'completed');assert.equal(receipt.result.status,'acknowledged');await operationalTick(f.store);await deliverDue(recovered,{configPath:f.configPath,transport,nowMs:nowMs+86400000});assert.equal(sends,1);assert.equal(f.store.need('inbox',created.id).answer,'weekly');
});
test('maintenance backfills expired and acknowledged dispositions once, with repeated notice ack retaining its version',async t=>{
 const f=fixture(t),q=f.command('inbox.publish',question).result;f.store.put('inbox',{...q,expiresAt:new Date(Date.now()-1).toISOString()});const notice=f.command('inbox.publish',{id:'issue-3',kind:'notice',title:'Review a fictional finding',context:'Recorded evidence'}).result;
 f.command('inbox.ack',{inboxId:notice.id});f.command('inbox.ack',{inboxId:notice.id});await operationalTick(f.store);await operationalTick(f.store);
 assert.equal(f.store.need('inbox',q.id).status,'expired');assert.equal(f.store.need('inbox',notice.id).version,2);const rows=f.store.all('delivery');assert.equal(rows.length,2);assert.deepEqual(rows.map(d=>d.inboxStatus).sort(),['acknowledged','expired']);
 let sent=0;await deliverDue(f.store,{configPath:f.configPath,transport:async()=>{sent++;return {status:200};},nowMs:Date.now()});assert.equal(sent,2);
});
test('resolution transport acceptance retries until consumed; old open acknowledgments do not suppress the new version',async t=>{
 const f=fixture(t);f.store.put('inbox',{id:'q',version:1,status:'open'});const old=queueDelivery(f.store,{inboxId:'q'});f.store.put('inbox',{id:'q',version:2,status:'answered',answer:'weekly'});const row=queueDelivery(f.store,{inboxId:'q'}),nowMs=Date.now();acknowledgeDelivery(f.store,{deliveryId:old.id,nowMs});let sends=0;const transport=async()=>{sends++;return {status:200};};
 await deliverDue(f.store,{configPath:f.configPath,transport,nowMs});await deliverDue(f.store,{configPath:f.configPath,transport,nowMs:nowMs+1800001});assert.equal(sends,2);assert.equal(f.store.need('delivery',row.id).status,'accepted');
 acknowledgeDelivery(f.store,{deliveryId:row.id,nowMs:nowMs+1800001});await deliverDue(f.store,{configPath:f.configPath,transport,nowMs:nowMs+86400000});assert.equal(sends,2);
});
test('acknowledgment racing HTTP completion is retained for resolution and open-reminder deliveries',async t=>{
 for(const status of ['open','answered']){const f=fixture(t);f.store.put('inbox',{id:'q',version:1,status});const row=queueDelivery(f.store,{inboxId:'q'}),nowMs=Date.now();let sends=0;const transport=async()=>{sends++;const receipt=f.command('delivery.ack',{deliveryId:row.id});assert.equal(receipt.status,'completed');return {status:200};};
 await deliverDue(f.store,{configPath:f.configPath,transport,nowMs});assert.equal(f.store.need('delivery',row.id).status,status==='open'?'accepted':'acknowledged');await deliverDue(f.store,{configPath:f.configPath,transport,nowMs:nowMs+1800001});assert.equal(sends,1,status);}
});
test('terminal delivery failures retain bounded retry and never persist private transport errors',async t=>{
 const f=fixture(t);f.store.put('inbox',{id:'q',version:2,status:'superseded'});const nowMs=Date.now(),row=queueDelivery(f.store,{inboxId:'q',nowMs});let sends=0;
 await deliverDue(f.store,{configPath:f.configPath,nowMs,transport:async()=>{sends++;throw Error('fictional-private-endpoint');}});assert.equal(f.store.need('delivery',row.id).status,'pending');await deliverDue(f.store,{configPath:f.configPath,nowMs:nowMs+1000,transport:async()=>{sends++;return {status:200};}});assert.equal(sends,1);await deliverDue(f.store,{configPath:f.configPath,nowMs:nowMs+30001,transport:async()=>{sends++;return {status:200};}});assert.equal(sends,2);assert.doesNotMatch(JSON.stringify(f.store.all('delivery'))+JSON.stringify(f.store.events()),/fictional-private-endpoint/);
});
