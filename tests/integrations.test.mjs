import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { releaseWorkflow, validateIntegrationConfig, runIntegrationAction, reconcileIntegrationAction } from '../starter/factory/workflows/integrations.mjs';
import { SpendingLedger } from '../starter/factory/operations/spending.mjs';

const schema={type:'object',properties:{route:{enum:['pass','fail','unknown','waiting']}},required:['route'],additionalProperties:true};
const stages=['rehearsal','probeBefore','deploy','probeAfter','smoke','journey','judge','publish'];
function configFor(argv) {
  const adapters=Object.fromEntries(stages.map(name=>[name,{argv,effect:['deploy','publish'].includes(name)?'write':'read',schema}]));
  const workflow=releaseWorkflow({rehearsal:'rehearsal',probeBefore:'probeBefore',deploy:'deploy',probeAfter:'probeAfter',smoke:'smoke',journeys:['journey'],judge:'judge',publish:'publish'});
  return {mode:'delivery',repository:{slug:'fictional/integration',account:'fictional',target:'main'},integrationAdapters:adapters,integrationWorkflows:{release:{kind:'release',singleton:'release',workflow}},context:{files:[],maxChars:1000}};
}
function actionFixture(t,{effect='read',node={},result={route:'pass'}}={}) {
  const f=sandbox(t),artifactDir=join(f.stateDir,'adapter-test');mkdirSync(artifactDir);
  const config=configFor(['fictional-adapter']);config.integrationAdapters.rehearsal.effect=effect;
  const candidate={head:repositoryIdentity(f.root).head},authorization={actor:'operator',answer:'approve',candidateDigest:digest(candidate),configDigest:digest(config),capMicros:100};
  const intent={cwd:f.root,timeoutMs:60000,action:{projectId:f.project.projectId,flowId:'release-1',step:'stage',artifactDir,config,node:{adapter:'rehearsal',...node},integration:{id:'release',workflowDigest:'graph',payload:{candidate,capMicros:100}},integrationDecisions:{approve:authorization},results:{}}};
  return {...f,intent,run:async()=>({code:0,stdout:JSON.stringify(result),stderr:''})};
}
test('installed integrations reject write loops and unapproved mutating stages',t=>{
  const config=configFor(['node','fixture.mjs']);assert.doesNotThrow(()=>validateIntegrationConfig(config));
  const unsafe=structuredClone(config);delete unsafe.integrationWorkflows.release.workflow.nodes.deploy.action.authorization;assert.throws(()=>validateIntegrationConfig(unsafe),/authorization/);
  const cycle=structuredClone(config);cycle.integrationWorkflows.release.workflow.nodes.smoke.next='rehearse';cycle.integrationWorkflows.release.workflow.nodes.rehearse.maxVisits=2;assert.throws(()=>validateIntegrationConfig(cycle),/replayed|acyclic/);
});
test('rehearsal must prove exact graph and candidate',async t=>{
  const f=actionFixture(t,{node:{stage:'rehearsal'},result:{route:'pass',candidateDigest:'other',workflowDigest:'graph'}});
  await assert.rejects(runIntegrationAction(f.intent,{run:f.run}),/exact candidate/);
});
test('saved-state loss stops the release and infrastructure cannot become a product pass',async t=>{
  const f=actionFixture(t,{node:{compareSavedWith:'before'},result:{route:'pass',savedItems:[]}});f.intent.action.results.before={savedItems:[{id:'saved-one',digest:'original'}]};
  assert.equal((await runIntegrationAction(f.intent,{run:f.run})).route,'fail');
  const g=actionFixture(t,{node:{observationsFrom:['journey']},result:{route:'pass',outcomes:[{id:'one',status:'passed'}]}});g.intent.action.results.journey={observations:[{id:'one',status:'infra'}]};
  await assert.rejects(runIntegrationAction(g.intent,{run:g.run}),/infrastructure/);
});
test('ambiguous write is uncertain, and no write runs without candidate-bound approval',async t=>{
  const f=actionFixture(t,{effect:'write',node:{authorization:'approve'}});
  const result=await runIntegrationAction(f.intent,{run:async()=>{throw new Error('lost response');}});assert.equal(result.uncertain,true);
  f.intent.action.integrationDecisions.approve.candidateDigest='changed';let called=false;
  await assert.rejects(runIntegrationAction(f.intent,{run:async()=>{called=true;}}),/candidate-bound/);assert.equal(called,false);
});
test('global spending ledger holds unknown costs, enforces scoped caps and records overruns',t=>{
  const f=sandbox(t),ledger=new SpendingLedger(join(f.stateDir,'spending.sqlite'));t.after(()=>ledger.close());
  const input={id:'paid-1',projectId:'one',flowId:'release',budgetId:'budget',ceilingMicros:60,capMicros:100,authorityDigest:'approval',enforcement:{enforceableCeiling:true,qualificationDigest:'qualified-fixture'}};
  ledger.reserve(input);ledger.settle(input.id,{actualMicros:null});assert.throws(()=>ledger.reserve({...input,id:'paid-2',projectId:'two'}),/global/);
  ledger.settle(input.id,{actualMicros:50,receiptDigest:'receipt-1'});assert.throws(()=>ledger.reserve({...input,id:'paid-2'}),/exhausted/);
  ledger.reserve({...input,id:'paid-2',ceilingMicros:40});assert.equal(ledger.reserve({...input,id:'paid-2',ceilingMicros:40}).existing,true);
  ledger.settle('paid-2',{actualMicros:41,receiptDigest:'receipt-2'});assert.throws(()=>ledger.reserve({...input,id:'paid-3'}),/global/);
});
test('paid adapters remain disabled without explicit configuration and approval',async t=>{
  const f=actionFixture(t,{effect:'paid',node:{authorization:'approve'}});f.intent.action.config.integrationAdapters.rehearsal.ceilingMicros=10;f.intent.action.integrationDecisions.approve.configDigest=digest(f.intent.action.config);
  let called=false;await assert.rejects(runIntegrationAction(f.intent,{run:async()=>{called=true;}}),/disabled/);assert.equal(called,false);
});
test('adapter output remains evidence and cannot issue built-in factory state updates',async t=>{
  const f=actionFixture(t,{result:{route:'pass',mainHealth:{status:'green'},workspace:{path:'/foreign'},outputIdentity:{head:'forged'},machineSample:{load1:0},obligations:[{id:'forged',status:'passed'}]}});
  const result=await runIntegrationAction(f.intent,{run:f.run});
  for(const key of ['mainHealth','workspace','outputIdentity','machineSample','obligations'])assert.equal(result[key],undefined);
  assert.equal(result.adapterResult.mainHealth.status,'green');
});
test('paid business failures retain settled cost and review identity; allocations and evidence gate global dispatch',async t=>{
  const f=actionFixture(t,{effect:'paid',node:{authorization:'approve',observationsFrom:['journey']},result:{route:'pass',outcomes:[{id:'one',status:'untested'}],actualMicros:5,enforcedCeilingMicros:10,costReceipt:{id:'fictional-cost'}}});
  const config=f.intent.action.config;config.spending={enabled:true,coordinatorPath:join(f.stateDir,'paid.sqlite')};Object.assign(config.integrationAdapters.rehearsal,{ceilingMicros:10,enforcement:{enforceableCeiling:true,qualificationDigest:'fictional-enforcement'}});f.intent.action.integrationDecisions.approve.configDigest=digest(config);f.intent.action.results.journey={observations:[{id:'one',status:'untested'}]};
  const result=await runIntegrationAction(f.intent,{run:f.run});assert.equal(result.route,'fail');assert.ok(result.spendingReservationId);
  const ledger=new SpendingLedger(config.spending.coordinatorPath);t.after(()=>ledger.close());const row=ledger.get(result.spendingReservationId);assert.equal(row.actualMicros,5);assert.equal(row.status,'awaiting-review');
  const another={id:'another',projectId:'two',flowId:'other',budgetId:'other-budget',ceilingMicros:1,capMicros:100,authorityDigest:'new',enforcement:{enforceableCeiling:true,qualificationDigest:'fixture'}};
  assert.throws(()=>ledger.reserve(another),/global/);
  ledger.confirmReview(row.id,'independent-inspection');ledger.reserve({...another,allocation:{id:'alpha',capMicros:1}});ledger.settle('another',{actualMicros:1,receiptDigest:'receipt'});assert.throws(()=>ledger.reserve({...another,id:'next',allocation:{id:'alpha',capMicros:1}}),/allocation/);
});
test('spending reconciliation preserves known costs and requires increased authority for overruns',t=>{
  const f=sandbox(t),ledger=new SpendingLedger(join(f.stateDir,'reconcile.sqlite'));t.after(()=>ledger.close());
  ledger.reserve({id:'one',projectId:'one',flowId:'flow',budgetId:'budget',ceilingMicros:5,capMicros:5,authorityDigest:'approval',enforcement:{enforceableCeiling:true,qualificationDigest:'fixture'}});
  ledger.settle('one',{actualMicros:7,receiptDigest:'receipt'});
  assert.throws(()=>ledger.reconcile('one',{actualMicros:6,receiptDigest:'receipt',reviewDigest:'review',note:'Inspect'}),/cannot be rewritten/);
  assert.throws(()=>ledger.reconcile('one',{actualMicros:7,receiptDigest:'receipt',reviewDigest:'review',note:'Inspect'}),/integer/);
  const proof={actualMicros:7,receiptDigest:'receipt',reviewDigest:'review',note:'Explicit recovery authority',newCapMicros:7};
  assert.equal(ledger.reconcile('one',proof).overrun,true);assert.equal(ledger.reconcile('one',proof).status,'settled');assert.throws(()=>ledger.reconcile('one',{...proof,note:'changed'}),/proof changed/);
});
test('external lookup proves the original operation without invoking its mutating adapter',async t=>{
  const f=actionFixture(t,{effect:'write',node:{authorization:'approve'}}),a=f.intent.action;
  a.config.integrationAdapters.lookup={argv:['read-only-lookup'],effect:'read',schema};a.config.integrationAdapters.rehearsal.lookupAdapter='lookup';
  const operationId=`${a.projectId}:${a.flowId}:${a.step}`;let calls=0;
  const run=async(binary,args,options)=>{calls++;assert.equal(binary,'read-only-lookup');assert.equal(JSON.parse(options.input).operationId,operationId);return{code:0,stderr:'',stdout:JSON.stringify({route:'pass',status:'applied',operationId,candidateDigest:digest(a.integration.payload.candidate),result:{route:'pass',mainHealth:{status:'green'}}})};};
  const result=await reconcileIntegrationAction(f.intent,{run});assert.equal(result.reconciled,true);assert.equal(result.mainHealth,undefined);assert.equal(calls,1);
  a.config.integrationAdapters.rehearsal.effect='read';await assert.rejects(reconcileIntegrationAction(f.intent,{run}),/mutating effect/);assert.equal(calls,1);
});
test('release helper supports bounded wait followed by separate reassessment without a journey replay',()=>{
  const config=configFor(['fictional']);config.integrationAdapters.reassess={argv:['fictional'],effect:'read',schema};
  config.integrationWorkflows.release.workflow=releaseWorkflow({rehearsal:'rehearsal',probeBefore:'probeBefore',deploy:'deploy',probeAfter:'probeAfter',smoke:'smoke',journeys:[{adapter:'journey',reader:'judge',wait:{reassess:'reassess',maxWaitMs:1000}}],judge:'judge',publish:'publish'});
  assert.doesNotThrow(()=>validateIntegrationConfig(config));const nodes=config.integrationWorkflows.release.workflow.nodes;assert.equal(nodes['wait-0'].next,'reassess-0');assert.equal(nodes['reassess-0'].action.adapter,'reassess');assert.equal(nodes['read-0'].resultEdges.waiting,'wait-0');
});
test('release graph runs in canonical supervised attempts with separate operator decisions',async t=>{
  const f=sandbox(t),script=join(f.base,'adapter.mjs'),external=join(f.base,'deployment.json');
  if(process.env.FACTOTUM_INTEGRATION_SUPERVISOR==='systemd')f.store.setMeta('project',{...f.store.meta('project'),supervisor:'systemd'});
  writeFileSync(script,`import{readFileSync,writeFileSync}from'node:fs';const x=JSON.parse(readFileSync(0,'utf8'));if(x.stage==='deploy')writeFileSync(x.payload.external,JSON.stringify({operationId:x.operationId,head:x.candidate.head}));console.log(JSON.stringify({route:'pass',candidateDigest:x.candidateDigest,workflowDigest:x.workflowDigest,savedItems:[{id:'saved-one',digest:'unchanged'}],observations:x.stage==='journey'?[{id:'journey-one',status:'passed'}]:[],outcomes:['judge','read-journey'].includes(x.stage)?[{id:'journey-one',status:'passed'}]:[]}));`);
  const config=configFor([process.execPath,script]);
  if(process.env.FACTOTUM_INTEGRATION_HEAVY==='1')config.resources={coordinatorPath:join(f.stateDir,'resources.sqlite'),pools:{integration:{capacity:1}},operations:{'integration.run':{resource:'integration',weight:1}}};
  validateIntegrationConfig(config);f.store.setMeta('config',config);f.store.setMeta('configDigest',digest(config));f.store.setMeta('commissioning',{ready:true,configDigest:digest(config)});
  const queued=f.command('job.enqueue',{operation:'workflow:release',payload:{candidate:{head:repositoryIdentity(f.root).head},capMicros:0,external},note:'Approve fictional release workflow admission'});assert.equal(queued.status,'completed');
  await operationalTick(f.store);const flow=f.store.all('flow').find(row=>row.integration);assert.ok(flow);
  const question=()=>{const current=f.store.need('flow',flow.id);if(['failed','stopped'].includes(current.state))throw new Error(JSON.stringify({flow:current,attempts:f.store.all('attempt').map(a=>({step:a.step,status:a.status,receipt:a.receipt,reason:a.reason})),events:f.store.events(3)}));return f.store.all('inbox').find(row=>row.flowId===flow.id&&row.status==='open');};
  await until(question,{tick:()=>f.engine.tick()});let q=question();assert.ok(q.integration?.candidate);assert.equal(f.store.need('flow',flow.id).step,'approve');
  assert.equal(f.command('answer',{inboxId:q.id,version:q.version,subjectDigest:q.subjectDigest,answer:'approve'}).status,'completed');
  await until(question,{tick:()=>f.engine.tick()});q=question();assert.equal(f.store.need('flow',flow.id).step,'report');assert.equal(JSON.parse(readFileSync(external)).head,repositoryIdentity(f.root).head);
  assert.equal(f.command('answer',{inboxId:q.id,version:q.version,subjectDigest:q.subjectDigest,answer:'approve'}).status,'completed');
  await until(()=>f.store.need('flow',flow.id).state==='completed',{tick:()=>f.engine.tick()});
  assert.equal(f.store.all('attempt').filter(a=>a.flowId===flow.id).length,9);assert.equal(f.store.need('job',queued.result.id).status,'completed');
});
test('deferred reader policy cannot advance infrastructure, untested or waiting observations as a pass',async t=>{
  for(const status of ['infra','untested','waitingUntil']){
    const f=actionFixture(t,{node:{observationsFrom:['journey'],allowDeferred:true},result:{route:'pass',outcomes:[{id:'one',status}]}});f.intent.action.results.journey={observations:[{id:'one',status}]};
    const result=await runIntegrationAction(f.intent,{run:f.run});assert.equal(result.route,'fail',status);
  }
});
test('deferred observations require a pinned explicit timer path and cannot wait on infrastructure',async t=>{
  const make=status=>{
    const f=actionFixture(t,{node:{observationsFrom:['journey'],allowDeferred:true},result:{route:'waiting',until:new Date(Date.now()+1000).toISOString(),outcomes:[{id:'one',status}]}});
    f.intent.action.results.journey={observations:[{id:'one',status}]};return f;
  };
  const noTimer=make('waitingUntil');await assert.rejects(runIntegrationAction(noTimer.intent,{run:noTimer.run}),/explicit pinned timer/);
  const waiting=make('waitingUntil'),a=waiting.intent.action,workflow={version:1,start:'stage',nodes:{stage:{kind:'effect',action:{...a.node},timeoutMs:60000,next:'done',onFailure:'failed',resultEdges:{waiting:'wait'}},wait:{kind:'wait',untilFrom:{step:'stage',field:'until'},maxWaitMs:1000,next:'reassess',onFailure:'failed'},reassess:{kind:'effect',action:{operation:'integration.run',adapter:'judge'},timeoutMs:60000,next:'done',onFailure:'failed'},done:{kind:'end',outcome:'completed'},failed:{kind:'end',outcome:'failed'}}};
  a.config.integrationWorkflows.release.workflow=workflow;a.integration.workflowDigest=digest(workflow);assert.equal((await runIntegrationAction(waiting.intent,{run:waiting.run})).route,'waiting');
  workflow.nodes.wait.next='done';a.integration.workflowDigest=digest(workflow);await assert.rejects(runIntegrationAction(waiting.intent,{run:waiting.run}),/read-only reassessment/);workflow.nodes.wait.next='reassess';a.integration.workflowDigest=digest(workflow);
  await assert.rejects(runIntegrationAction(waiting.intent,{run:async()=>({code:0,stdout:JSON.stringify({route:'waiting',until:new Date(Date.now()+10000).toISOString(),outcomes:[{id:'one',status:'waitingUntil'}]}),stderr:''})}),/bounded wake-up date/);
  const infra=make('infra');assert.equal((await runIntegrationAction(infra.intent,{run:infra.run})).route,'fail');
});
test('duplicate observation identities cannot hide an unmatched judgment',async t=>{
  const f=actionFixture(t,{node:{observationsFrom:['journey']},result:{route:'pass',outcomes:[{id:'duplicate',status:'passed'},{id:'unmatched',status:'passed'}]}});f.intent.action.results.journey={observations:[{id:'duplicate',status:'passed'},{id:'duplicate',status:'passed'}]};await assert.rejects(runIntegrationAction(f.intent,{run:f.run}),/unique observation/);
});
test('infrastructure classification cannot clear a prior paid evidence hold through deferred-reader policy',async t=>{
  const f=actionFixture(t,{node:{observationsFrom:['journey'],allowDeferred:true},result:{route:'pass',outcomes:[{id:'one',status:'infra'}]}}),path=join(f.stateDir,'held-spending.sqlite'),ledger=new SpendingLedger(path);t.after(()=>ledger.close());
  ledger.reserve({id:'synthetic-paid-journey',projectId:f.project.projectId,flowId:'release-1',budgetId:'synthetic-budget',ceilingMicros:10,capMicros:100,authorityDigest:'synthetic-operator-proof',enforcement:{enforceableCeiling:true,qualificationDigest:'synthetic-qualified-ceiling'},reviewRequired:true});ledger.settle('synthetic-paid-journey',{actualMicros:5,receiptDigest:'synthetic-cost-receipt'});
  f.intent.action.config.spending={enabled:true,coordinatorPath:path};f.intent.action.results.journey={spendingReservationId:'synthetic-paid-journey',observations:[{id:'one',status:'infra'}]};
  assert.equal((await runIntegrationAction(f.intent,{run:f.run})).route,'fail');assert.equal(ledger.get('synthetic-paid-journey').status,'awaiting-review');
});
