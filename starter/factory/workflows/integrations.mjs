import { assert, digest, id, validateWorkflow, atomicJSON, fileDigest } from '../core/contracts.mjs';
import { runProcess, validateSchema, validateSchemaDefinition } from '../adapters/providers/index.mjs';
import { SpendingLedger } from '../operations/spending.mjs';
import { join, resolve } from 'node:path';
import { repositoryIdentity } from '../core/repository.mjs';
import { readFileSync } from 'node:fs';
import { HostResources, resourceRequest } from '../operations/resources.mjs';
// Adapter payloads are evidence, never kernel commands. Only this protocol's
// fields leave the namespace; workspace/main-health/output-identity keys cannot
// masquerade as results of built-in factory operations.
const integrationResult = result => ({...Object.fromEntries(['route','summary','savedItems','observations','outcomes','until','actualMicros','enforcedCeilingMicros','costReceipt','candidateDigest','workflowDigest','invariantFailure','reason'].filter(key=>Object.hasOwn(result,key)).map(key=>[key,result[key]])),adapterResult:result});

// An integration step's effect timeout. An adapter may declare its own `timeoutMs`; the step then
// allows that plus INTEGRATION_OVERHEAD_MS (the heavy-work permit wait of at most 60 s and start-up),
// within the one-hour effect cap. Without one, the reference graphs keep the ten-minute default.
export const INTEGRATION_DEFAULT_TIMEOUT_MS = 600000, INTEGRATION_OVERHEAD_MS = 90000, INTEGRATION_CAP_MS = 3_600_000;
export const integrationStepTimeoutMs = adapter => Number.isSafeInteger(adapter?.timeoutMs) ? Math.min(INTEGRATION_CAP_MS, adapter.timeoutMs + INTEGRATION_OVERHEAD_MS) : INTEGRATION_DEFAULT_TIMEOUT_MS;
export function integrationWorkflow(config, name) {
  id(name, 'integration workflow');
  const definition = config.integrationWorkflows?.[name]; assert(definition?.workflow, 'installed integration workflow required');
  validateWorkflow(definition.workflow); return structuredClone(definition.workflow);
}
// A maintenance workflow whose every step is a read-only adapter: it observes, never writes or spends.
export const readOnlyMaintenance = (config, name) => { const definition = config.integrationWorkflows?.[name]; return definition?.kind === 'maintenance' && Object.values(definition.workflow?.nodes ?? {}).filter(node => node.kind === 'effect').every(node => config.integrationAdapters?.[node.action?.adapter]?.effect === 'read'); };
export const installedOperation = (config, operation) => typeof operation === 'string' && operation.startsWith('workflow:') && Boolean(config.integrationWorkflows?.[operation.slice(9)]);
export function validateIntegrationConfig(config) {
  const adapters = config.integrationAdapters ?? {}, workflows = config.integrationWorkflows ?? {};
  assert(Object.keys(adapters).length <= 64 && Object.keys(workflows).length <= 32, 'bounded integration installation required');
  for (const [name, adapter] of Object.entries(adapters)) {
    id(name, 'adapter'); assert(Array.isArray(adapter.argv) && adapter.argv.length && adapter.argv.every(value => typeof value === 'string' && !value.includes('\0')), 'adapter argv required');
    assert(['read', 'write', 'paid'].includes(adapter.effect), 'adapter effect classification required');
    validateSchemaDefinition(adapter.schema); assert(adapter.schema.type === 'object', 'adapter output object schema required');
    for (const file of adapter.files ?? []) assert(typeof file.path==='string' && /^[a-f\d]{64}$/i.test(file.digest ?? ''), 'adapter implementation files need pinned SHA-256 digests');
    if (adapter.effect === 'paid') assert(Number.isSafeInteger(adapter.ceilingMicros) && adapter.ceilingMicros > 0, 'paid adapter requires bounded micro-unit ceiling');
    if(adapter.lookupAdapter)assert(adapters[adapter.lookupAdapter]?.effect==='read','external effect lookup must use an installed read-only adapter');
    assert(adapter.timeoutMs===undefined||Number.isSafeInteger(adapter.timeoutMs)&&adapter.timeoutMs>=1000&&adapter.timeoutMs<=INTEGRATION_CAP_MS-INTEGRATION_OVERHEAD_MS,`integration adapter ${name} timeoutMs must be a whole number of milliseconds from 1000 to ${INTEGRATION_CAP_MS-INTEGRATION_OVERHEAD_MS}`);
  }
  for (const [name, definition] of Object.entries(workflows)) {
    id(name, 'integration workflow'); const workflow = integrationWorkflow(config, name);
    assert(['release','evaluation','maintenance'].includes(definition.kind), 'integration workflow kind required');
    for (const node of Object.values(workflow.nodes)) {
      if (node.kind === 'effect') {
        assert(node.action?.operation === 'integration.run' && adapters[node.action.adapter], 'integration effects require installed adapters');
        assert(!node.argv && node.maxVisits === undefined, 'integration mutations cannot be replayed in graph loops');
        if (adapters[node.action.adapter].effect !== 'read') assert(node.action.authorization, 'mutating adapter requires named operator authorization');
        // A step must leave its adapter's own limit room to run: otherwise the step is ended first and its outcome is uncertain.
        const needed = integrationStepTimeoutMs(adapters[node.action.adapter]);
        if (adapters[node.action.adapter].timeoutMs !== undefined) assert(node.timeoutMs >= needed, `integration workflow ${name} runs adapter ${node.action.adapter} (timeoutMs ${adapters[node.action.adapter].timeoutMs}) in a step that allows only ${node.timeoutMs} ms; give the step timeoutMs of at least ${needed}`);
      }
      if (node.kind === 'question') assert(['operator','orchestrator'].includes(node.role) && node.integrationDecision === true, 'integration questions require canonical role-bound decisions');
    }
    // Even explicitly bounded cycles can repeat external writes. Integration
    // workflows are finite DAGs; another execution needs a new scoped grant.
    const active = new Set(), seen = new Set();
    const visit = key => { if (seen.has(key)) return; assert(!active.has(key), 'integration workflow must be acyclic'); active.add(key); const n = workflow.nodes[key]; for (const next of n.kind === 'question' ? Object.values(n.answers) : ['effect','wait'].includes(n.kind) ? [n.next,n.onFailure,...Object.values(n.resultEdges ?? {})] : []) visit(next); active.delete(key); seen.add(key); };
    Object.keys(workflow.nodes).forEach(visit);
  }
  return config;
}
export function integrationQuestion(flow, node) {
  if (!node.integrationDecision) return undefined;
  return { workflowId: flow.integration.id, candidate: flow.integration.payload.candidate, capMicros: flow.integration.payload.capMicros ?? 0, allocationsMicros: flow.integration.payload.allocationsMicros ?? {}, evidenceDigest: digest(flow.results ?? {}), evidence: flow.results ?? {} };
}
export function recordIntegrationDecision(flow, node, payload, actor, identity, { delegated = false, onBehalfOf } = {}) {
  if (!node.integrationDecision) return;
  assert(actor === 'operator'||actor===node.role||delegated, 'designated integration authority required');
  flow.integrationDecisions ??= {};
  flow.integrationDecisions[flow.step] = { answer: payload.answer, actor, ...(delegated ? { onBehalfOf } : {}), head: identity.head, candidateDigest: digest(flow.integration.payload.candidate), evidenceDigest: digest(flow.results ?? {}), resultDigests:Object.fromEntries(Object.entries(flow.results??{}).map(([key,result])=>[key,digest(result)])), configDigest: flow.configDigest, workflowDigest: flow.workflowDigest, capMicros: node.role==='operator'?(flow.integration.payload.capMicros ?? 0):0, actor };
}

export async function runIntegrationAction(intent, options = {}) {
  const a=intent.action,key=`integration.run:${a.node?.stage??a.step}`,resources=a.config.resources;
  if(!a.resource&&!resources?.operations?.[key]&&!resources?.operations?.['integration.run'])return runIntegrationStage(intent,options);
  assert(resources?.coordinatorPath,'shared coordinator required for heavy integration work');
  const owner=JSON.parse(readFileSync(join(a.artifactDir,'owner.json'),'utf8'));
  assert(owner.attemptId===intent.attemptId&&owner.intentDigest&&typeof owner.cgroup==='string','contained integration resource ownership required');
  const coordinator=new HostResources(resources.coordinatorPath),start=Date.now();let lease;
  try {
    const request=resourceRequest(a.config,resources.operations?.[key]?key:'integration.run');
    while(!(lease=coordinator.acquire({...request,projectId:a.projectId,flowId:a.flowId,attemptId:intent.attemptId,owner}))){assert(!options.signal?.aborted&&Date.now()-start<Math.min(intent.timeoutMs/2,60000),'integration resource wait exhausted');await new Promise(resolve=>setTimeout(resolve,100));}
    const acquired=Date.now(),result=await runIntegrationStage(intent,options);
    return {...result,resourceWaitMs:acquired-start,resourceWait:{startedAt:new Date(start).toISOString(),endedAt:new Date(acquired).toISOString()}};
  } finally {coordinator.close();}
}
async function runIntegrationStage(intent, { signal, run = runProcess, deadlineAt } = {}) {
  const a = intent.action, node = a.node, adapter = a.config.integrationAdapters?.[node.adapter];
  assert(adapter && a.integration?.id && a.integration.payload?.candidate, 'pinned integration input required');
  if(a.integration.adapterIdentity)assert(digest(repositoryIdentity(intent.cwd))===digest(a.integration.adapterIdentity),'integration checkout changed since admission');
  for(const file of adapter.files??[])assert(fileDigest(resolve(intent.cwd,file.path))===file.digest,'adapter implementation changed; reconfigure and recommission');
  const candidate = a.integration.payload.candidate, candidateDigest = digest(candidate), operationId = `${a.projectId}:${a.flowId}:${a.step}`;
  const authorization = node.authorization==='grant'?a.integration.grant:node.authorization && a.integrationDecisions?.[node.authorization];
  if (adapter.effect !== 'read') assert((authorization?.actor === 'operator'||adapter.effect==='write'&&authorization?.actor===node.authorizedRole&&node.authorizedRole==='orchestrator') && authorization.answer === (node.authorizedAnswer ?? 'approve') && authorization.candidateDigest === candidateDigest && authorization.configDigest === digest(a.config), 'candidate-bound operator or explicitly delegated write authorization required');
  if(adapter.effect==='paid')assert(node.authorization!=='grant'&&authorization.actor==='operator','paid dispatch requires a separate operator cap decision');
  if (node.requireResults) for (const key of node.requireResults) {assert(a.results[key]?.route === 'pass', `successful ${key} evidence required`);if(adapter.effect!=='read'&&node.authorization!=='grant')assert(authorization.resultDigests?.[key]===digest(a.results[key]),`approved ${key} evidence changed`);}
  let ledger, reservation;
  if (adapter.effect === 'paid') {
    const spending = a.config.spending;
    assert(spending?.enabled === true && spending.coordinatorPath && authorization?.capMicros > 0, 'paid adapters disabled or missing approved cap');
    ledger = new SpendingLedger(spending.coordinatorPath);
    reservation = ledger.reserve({ id: operationId, attemptId:intent.attemptId, projectId: a.projectId, flowId: a.flowId, budgetId: a.integration.payload.budgetId ?? a.flowId, ceilingMicros: adapter.ceilingMicros, capMicros: Math.min(authorization.capMicros, a.integration.payload.capMicros), authorityDigest: digest(authorization), enforcement: adapter.enforcement, reviewRequired:true, ...(node.budgetKey ? {allocation:{id:node.budgetKey,capMicros:a.integration.payload.allocationsMicros?.[node.budgetKey]}} : {}) });
    if (reservation.existing || reservation.status !== 'reserved') { ledger.close(); throw new Error('paid reservation already dispatched; reconcile before a new grant'); }
  }
  const input = { version: 1, operationId, candidate, candidateDigest, workflowDigest: a.integration.workflowDigest, stage: node.stage ?? a.step, payload: a.integration.payload, results: a.results, authorization, ...(reservation ? { spending: { ceilingMicros: reservation.ceilingMicros, reservationId: reservation.id } } : {}) };
  try {
    // The adapter runs under its own timeoutMs, cut short to the step's time left (after any permit
    // wait) so that its own limit, not the supervisor, ends it.
    const left = (Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + intent.timeoutMs) - Date.now() - 1000;
    const response = await run(adapter.argv[0], adapter.argv.slice(1), { cwd: intent.cwd, env: process.env, input: JSON.stringify(input), signal, timeoutMs: Math.max(1, Math.floor(Math.min(adapter.timeoutMs ?? Infinity, left))), maxBytes: 4 * 1024 * 1024 });
    atomicJSON(join(a.artifactDir, 'integration-output.json'), { stdout: response.stdout, stderr: response.stderr, code: response.code });
    assert(response.code === 0, 'integration adapter failed');
    const result = JSON.parse(response.stdout); validateSchema(result, adapter.schema);
    let disposition;
    assert(['pass','fail','unknown','waiting'].includes(result.route), 'adapter route required');
    if (node.stage === 'rehearsal' && result.route === 'pass') assert(result.candidateDigest === candidateDigest && result.workflowDigest === a.integration.workflowDigest, 'rehearsal must cover the exact candidate and workflow');
    if (node.compareSavedWith && result.route === 'pass') {
      const before = a.results[node.compareSavedWith]?.savedItems;
      assert(Array.isArray(before) && Array.isArray(result.savedItems) && before.length <= 10000 && result.savedItems.length <= 10000, 'bounded saved-state inventories required');
      assert([before,result.savedItems].every(items=>items.every(item=>typeof item.id==='string'&&item.id&&typeof item.digest==='string'&&item.digest)&&new Set(items.map(item=>item.id)).size===items.length), 'unique saved-state identities and digests required');
      if (!before.every(item => result.savedItems.some(after => after.id === item.id && after.digest === item.digest))) disposition={route:'fail',invariantFailure:'saved-state inventory changed'};
    }
    if (node.observationsFrom) {
      const sources=node.observationsFrom.map(source=>typeof source==='string'?source:source.firstOf.find(key=>a.results[key]));
      assert(sources.every(key=>typeof key==='string'&&a.results[key]),'required observation source unavailable');
      const observations = sources.flatMap(key => a.results[key]?.observations ?? []);
      assert(Array.isArray(result.outcomes) && result.outcomes.length === observations.length, 'judgment must cover observations');
      assert([observations,result.outcomes].every(rows=>rows.every(row=>typeof row.id==='string'&&row.id)&&new Set(rows.map(row=>row.id)).size===rows.length),'unique observation and judgment identities required');
      assert(observations.every(o => result.outcomes.filter(j => j.id === o.id).length === 1), 'judgment observation identities changed');
      for (const observed of observations) if (['infra','untested','waitingUntil'].includes(observed.status)) assert(!['passed','failed'].includes(result.outcomes.find(o => o.id === observed.id).status), 'infrastructure cannot establish a product outcome');
      if(observations.some(o=>['infra','untested'].includes(o.status)))disposition={route:'fail',reason:'Observation infrastructure or untested outcome must stop the series'};
      else if(observations.some(o=>o.status==='waitingUntil')&&(!node.allowDeferred||!['waiting','fail','unknown'].includes(result.route)))disposition={route:'fail',reason:'Deferred observations require an explicit timer and read-only reassessment before continuing'};
    }
    if (ledger) {
      assert(Number.isSafeInteger(result.actualMicros) && result.actualMicros >= 0 && result.costReceipt && result.enforcedCeilingMicros === adapter.ceilingMicros, 'paid adapter needs actual cost receipt and enforced ceiling');
      const settled = ledger.settle(operationId, { actualMicros: result.actualMicros, receiptDigest: digest(result.costReceipt) });
      assert(settled.status !== 'overrun', 'adapter exceeded enforced ceiling; global spending held');
    }
    if(result.route==='waiting'&&disposition?.route!=='fail'){
      const compiled=a.config.integrationWorkflows?.[a.integration.id]?.workflow,current=compiled?.nodes[a.step],target=compiled?.nodes[current?.resultEdges?.waiting];
      assert(compiled&&digest(compiled)===a.integration.workflowDigest&&current?.action?.adapter===node.adapter&&target?.kind==='wait'&&target.untilFrom?.step===a.step&&target.untilFrom?.field==='until','waiting result requires an explicit pinned timer transition');
      const reassess=compiled.nodes[target.next];
      assert(reassess?.kind==='effect'&&reassess.action?.operation==='integration.run'&&a.config.integrationAdapters[reassess.action.adapter]?.effect==='read','waiting timer must lead to a read-only reassessment');
      const due=typeof result.until==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(result.until)?Date.parse(result.until):NaN;
      assert(Number.isFinite(due)&&due-Date.now()<=target.maxWaitMs, 'waiting adapter needs a bounded wake-up date');
    }
    if (node.observationsFrom && ['pass','waiting'].includes(disposition?.route??result.route) && a.config.spending?.coordinatorPath) {
      const reviewed=new SpendingLedger(a.config.spending.coordinatorPath);
      try { for(const source of node.observationsFrom){const key=typeof source==='string'?source:source.firstOf.find(key=>a.results[key]);if(a.results[key]?.spendingReservationId)reviewed.confirmReview(a.results[key].spendingReservationId,digest({stage:a.step,result,observation:a.results[key]}));} } finally {reviewed.close();}
    }
    return { ...integrationResult(result), ...disposition, operationId, candidateDigest, adapterDigest: digest(adapter), ...(reservation?{spendingReservationId:reservation.id}:{}), ...(result.route === 'unknown' ? { uncertain: true, reason: 'Integration result requires independent reconciliation or a new grant' } : {}) };
  } catch (error) {
    if (ledger && ['reserved','unknown'].includes(ledger.get(operationId)?.status)) ledger.settle(operationId, { actualMicros: null });
    if (adapter.effect !== 'read') return { uncertain: true, route: 'unknown', reason: 'External adapter outcome requires independent inspection', operationId };
    throw error;
  } finally { ledger?.close(); }
}

// Query the external operation; never invoke the original mutating command.
export async function reconcileIntegrationAction(intent,{run=runProcess,signal}={}) {
  const a=intent.action,original=a.config.integrationAdapters?.[a.node.adapter],lookup=original?.lookupAdapter&&a.config.integrationAdapters[original.lookupAdapter];
  assert(['write','paid'].includes(original?.effect)&&lookup?.effect==='read','mutating effect and installed read-only lookup adapter required');
  const operationId=`${a.projectId}:${a.flowId}:${a.step}`,candidateDigest=digest(a.integration.payload.candidate);
  for(const file of lookup.files??[])assert(fileDigest(resolve(intent.cwd,file.path))===file.digest,'lookup adapter implementation changed');
  const response=await run(lookup.argv[0],lookup.argv.slice(1),{cwd:intent.cwd,env:process.env,input:JSON.stringify({version:1,operationId,candidate:a.integration.payload.candidate,candidateDigest,stage:'lookup',originalStage:a.node.stage,payload:a.integration.payload}),signal,timeoutMs:Math.min(intent.timeoutMs,60000),maxBytes:4*1024*1024});
  assert(response.code===0,'external lookup failed');const proof=JSON.parse(response.stdout);validateSchema(proof,lookup.schema);
  assert(proof.operationId===operationId&&proof.candidateDigest===candidateDigest&&proof.status==='applied'&&proof.result?.route==='pass','matching applied external operation not proven');
  validateSchema(proof.result,original.schema);
  atomicJSON(join(a.artifactDir,'integration-reconciliation.json'),{operationId,lookupDigest:digest(lookup),proof});
  return {...integrationResult(proof.result),operationId,candidateDigest,adapterDigest:digest(original),...(original.effect==='paid'?{spendingReservationId:operationId}:{}),reconciled:true};
}

// Projects select their own adapters; this graph owns sequencing and decisions.
// `adapters` (the project's integrationAdapters) sizes each step from its adapter's own timeoutMs.
export function releaseWorkflow({ rehearsal, probeBefore, deploy, probeAfter, smoke, journeys = [], judge, publish, rollback, rollbackCompatible = false, adapters = {} }) {
  const effect = (adapter, next, action = {}, extra = {}) => ({ kind:'effect', action:{operation:'integration.run',adapter,...action}, timeoutMs:integrationStepTimeoutMs(adapters[adapter]), preserveInput:true, next, onFailure:'failed', resultEdges:{pass:next,fail:'failed'}, ...extra });
  const nodes = {
    rehearse:effect(rehearsal,'before',{stage:'rehearsal'}),
    before:effect(probeBefore,'approve',{stage:'probe-before'}),
    approve:{kind:'question',role:'operator',integrationDecision:true,question:'Approve this rehearsed release candidate and its bounded spending cap?',answers:{approve:'deploy',stop:'stopped'}},
    deploy:effect(deploy,'after',{stage:'deploy',authorization:'approve',requireResults:['rehearse','before']},{resultEdges:{pass:'after',fail:'failed'}}),
    after:effect(probeAfter,'smoke',{stage:'probe-after',compareSavedWith:'before'},{resultEdges:{pass:'smoke',fail:'preservation'}}),
    smoke:effect(smoke,journeys.length?'journey-0':'judge',{stage:'smoke'},{resultEdges:{pass:journeys.length?'journey-0':'judge',fail:'preservation'}}),
    preservation:{kind:'question',role:'operator',integrationDecision:true,question:'Release preservation or smoke checks failed. Inspect evidence before keeping or rolling back.',answers:{stop:'stopped',...(rollback && rollbackCompatible?{rollback:'rollback'}:{})}},
    judge:effect(judge,'report',{stage:'judge',observationsFrom:journeys.map((entry,i)=>typeof entry==='object'&&entry.wait?{firstOf:[`reassess-${i}`,`journey-${i}`]}:`journey-${i}`)}),
    report:{kind:'question',role:'operator',integrationDecision:true,question:'Read the release observations and independent judgment. Publish the reviewed report?',answers:{approve:'publish',stop:'stopped'}},
    publish:effect(publish,'done',{stage:'publish',authorization:'report',requireResults:['judge']}),
    ...(rollback && rollbackCompatible?{rollback:effect(rollback,'stopped',{stage:'rollback',authorization:'preservation',authorizedAnswer:'rollback'})}:{}),
    done:{kind:'end',outcome:'completed'},failed:{kind:'end',outcome:'failed'},stopped:{kind:'end',outcome:'stopped'},
  };
  journeys.forEach((entry,i)=>{
    const adapter=typeof entry==='string'?entry:entry.adapter;
    const next=i+1<journeys.length?`journey-${i+1}`:'judge';
    nodes[`journey-${i}`]=effect(adapter,`read-${i}`,{stage:'journey',authorization:'approve',...(typeof entry==='object'&&entry.budgetKey?{budgetKey:entry.budgetKey}:{})},{resultEdges:{pass:`read-${i}`,fail:`read-${i}`}});
    const reader=typeof entry==='object'&&entry.reader?entry.reader:judge;
    nodes[`read-${i}`]=effect(reader,next,{stage:'read-journey',observationsFrom:[`journey-${i}`],...(typeof entry==='object'&&entry.wait?{allowDeferred:true}:{})},{resultEdges:{pass:next,fail:'failed',...(typeof entry==='object'&&entry.wait?{waiting:`wait-${i}`}:{})}});
    if(typeof entry==='object'&&entry.wait){
      assert(entry.wait.reassess,'waiting journeys require a separate read-only reassessment adapter');
      nodes[`wait-${i}`]={kind:'wait',untilFrom:{step:`read-${i}`,field:'until'},maxWaitMs:entry.wait.maxWaitMs??36*3600000,next:`reassess-${i}`,onFailure:'failed'};
      nodes[`reassess-${i}`]=effect(entry.wait.reassess,`reread-${i}`,{stage:'reassess'});
      nodes[`reread-${i}`]=effect(reader,next,{stage:'read-journey',observationsFrom:[`reassess-${i}`]});
    }
  });
  const workflow = {version:1,start:'rehearse',nodes,maxTransitions:64}; validateWorkflow(workflow); return workflow;
}
export function evaluationWorkflow({controls,journeys,judge,publish,adapters={}}) {
  assert(Array.isArray(journeys)&&journeys.length,'evaluation journeys required');
  const workflow=releaseWorkflow({rehearsal:controls,probeBefore:controls,deploy:controls,probeAfter:controls,smoke:controls,journeys,judge,publish,adapters});
  for(const key of ['before','deploy','after','smoke','preservation'])delete workflow.nodes[key];
  Object.assign(workflow.nodes.rehearse,{next:'approve',resultEdges:{pass:'approve',fail:'failed'}});workflow.nodes.rehearse.action.stage='controls';
  workflow.nodes.approve.question='Approve these controlled evaluation journeys and their bounded spending cap?';workflow.nodes.approve.answers.approve='journey-0';
  validateWorkflow(workflow);return workflow;
}
