import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {sandbox} from './helpers.mjs';
import {digest} from '../starter/factory/core/contracts.mjs';
import {repositoryIdentity} from '../starter/factory/core/repository.mjs';
import {runIntegrationAction} from '../starter/factory/workflows/integrations.mjs';
import {SpendingLedger} from '../starter/factory/operations/spending.mjs';
function fixture(t){
 const f=sandbox(t),config={integrationAdapters:{publish:{argv:['fictional'],effect:'write',schema:{type:'object',properties:{route:{enum:['pass']}},required:['route']}}}},candidate={head:repositoryIdentity(f.root).head};const artifactDir=join(f.stateDir,'adapter');mkdirSync(artifactDir);
 const authority={actor:'operator',answer:'approve',candidateDigest:digest(candidate),configDigest:digest(config),resultDigests:{check:digest({route:'pass',proof:'approved'})}};
 const action={projectId:f.project.projectId,flowId:'flow',step:'publish',artifactDir,config,node:{adapter:'publish',authorization:'approve',requireResults:['check']},integration:{id:'fictional',payload:{candidate},workflowDigest:'graph',grant:authority},integrationDecisions:{approve:authority},results:{check:{route:'pass',proof:'approved'}}};
 const intent={cwd:f.root,timeoutMs:60000,action};let calls=0;const run=async()=>{calls++;return {code:0,stdout:'{"route":"pass"}',stderr:''};};return {...f,intent,run,calls:()=>calls};
}
test('installed grant may authorize nonpaid writes and explicitly delegated decisions remain scoped',async t=>{
 const f=fixture(t),a=f.intent.action;a.node.authorization='grant';delete a.integration.grant.resultDigests;assert.equal((await runIntegrationAction(f.intent,{run:f.run})).route,'pass');
 a.integrationDecisions.approve.resultDigests={check:digest(a.results.check)};a.node.authorization='approve';a.integrationDecisions.approve.actor='orchestrator';await assert.rejects(runIntegrationAction(f.intent,{run:f.run}),/candidate-bound/);a.node.authorizedRole='orchestrator';assert.equal((await runIntegrationAction(f.intent,{run:f.run})).route,'pass');
 a.integrationDecisions.approve.candidateDigest='foreign';await assert.rejects(runIntegrationAction(f.intent,{run:f.run}),/candidate-bound/);assert.equal(f.calls(),2);
});
test('write approval binds exact required evidence and grants cannot authorize spending',async t=>{
 const f=fixture(t),a=f.intent.action;a.results.check.proof='changed';await assert.rejects(runIntegrationAction(f.intent,{run:f.run}),/evidence changed/);assert.equal(f.calls(),0);
 a.results.check.proof='approved';a.node.authorization='grant';a.config.integrationAdapters.publish.effect='paid';a.integration.grant.configDigest=digest(a.config);await assert.rejects(runIntegrationAction(f.intent,{run:f.run}),/separate operator cap/);assert.equal(f.calls(),0);
});
test('canonical spending recovery requires operator, owned stopped flow and quiescent attempt',t=>{
 const f=sandbox(t);f.start();const flow=f.store.need('flow','flow-1');const ledgerPath=join(f.stateDir,'spending.sqlite');f.store.setMeta('config',{spending:{coordinatorPath:ledgerPath}});
 f.store.put('attempt',{id:'paid-attempt',flowId:flow.id,step:'work',status:'prepared'});const ledger=new SpendingLedger(ledgerPath);t.after(()=>ledger.close());ledger.reserve({id:'reservation',attemptId:'paid-attempt',projectId:f.project.projectId,flowId:flow.id,budgetId:'budget',ceilingMicros:5,capMicros:5,authorityDigest:'approval',enforcement:{enforceableCeiling:true,qualificationDigest:'fictional'}});ledger.settle('reservation',{actualMicros:null});
 const payload={id:'reservation',actualMicros:3,receiptDigest:'receipt',reviewDigest:'independent-review',note:'Inspected fictional receipts after stopping'};
 assert.equal(f.command('spending.reconcile',payload,{actor:'orchestrator'}).status,'rejected');assert.equal(f.command('spending.reconcile',payload).status,'rejected');
 f.command('stop',{flowId:flow.id,note:'Stop fictional paid flow'});const receipt=f.command('spending.reconcile',{...payload,quiescence:'independently-confirmed'});assert.equal(receipt.status,'completed',receipt.error);assert.equal(ledger.get('reservation').actualMicros,3);assert.equal(ledger.get('reservation').status,'settled');assert.equal(f.store.need('attempt','paid-attempt').status,'prepared');
});
