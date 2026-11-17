import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { sandbox } from './helpers.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { executeCommand, replanFlow } from '../starter/factory/core/project.mjs';
import { actionSpecification } from '../starter/factory/workflows/actions.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { commandHelp } from '../starter/factory/core/command-help.mjs';

const config = {version:1,mode:'delivery',repository:{slug:'fictional/demo',account:'fictional',target:'main'},providers:{planner:{provider:'codex',model:'fictional'},builder:{provider:'codex',model:'fictional'},reviewer:{provider:'claude',model:'fictional'}},checks:[{id:'verify',argv:['true'],timeoutMs:60000}],context:{files:[],maxChars:1000}};
function fixture(t) {
  const f = sandbox(t);
  const ghPath=join(f.base,'gh');writeFileSync(ghPath,`#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');\n`,{mode:0o700});
  assert.equal(f.command('config.update',{config:{...config,repository:{...config.repository,ghPath}},note:'Fictional delivery'}).status,'completed');
  const task = f.store.need('task',f.task.id);
  f.command('task.approve',{taskId:task.id,revision:task.revision});
  const gate = {route:'fail',checks:[{id:'verify',status:'failed',diagnostics:{stderr:'STALE ANCESTRY REFUSAL'}}]};
  const flow = {id:'replanning',kind:'change',mode:'delivery',taskId:task.id,taskRevision:task.revision,workflow:changeWorkflow(config),step:'build',state:'stopped',stopRequested:true,transitions:10,visits:{plan:2,build:4},results:{source:{head:repositoryIdentity(f.root).head},gate},evidence:{gate:{attemptId:'old-gate'}},sessions:{builder:'old-session'},attemptId:null,operatorFeedback:[{answer:'note',actor:'operator',note:'Keep earlier guidance'}]};
  const attempt = {id:'old-gate',flowId:flow.id,step:'gate',status:'passed',settledAt:new Date().toISOString(),receipt:{actionResult:structuredClone(gate)}};
  f.store.put('flow',flow);f.store.put('attempt',attempt);
  return {...f,flow,attempt,gate};
}

test('replan delivers attributed guidance to planner, plan reviewer and builder, superseding gate feedback without rewriting history',async t=>{
  const f=fixture(t),onBehalfOf={principal:'operator',instruction:'Replan with the operator ruling'},note='RULING: integration was repaired; implement the feature without merging branches.';
  assert.equal(f.command('flow.replan',{flowId:f.flow.id,note},{actor:'orchestrator'}).status,'rejected','delegation still needs attribution');
  assert.equal(f.store.need('flow',f.flow.id).operatorFeedback.length,1);
  const command={protocolVersion:1,projectId:f.project.projectId,commandId:'replan-guidance',operation:'flow.replan',actor:'orchestrator',onBehalfOf,payload:{flowId:f.flow.id,note}};
  assert.equal(executeCommand(f.store,command).status,'completed');
  assert.equal(executeCommand(f.store,command).status,'completed','idempotent replay');
  const flow=f.store.need('flow',f.flow.id);
  assert.equal(flow.operatorFeedback.length,2);assert.deepEqual(flow.operatorFeedback[1].onBehalfOf,onBehalfOf);
  assert.equal(flow.operatorFeedback[1].actor,'orchestrator');assert.equal(flow.operatorFeedback[1].answer,'replan');assert.equal(flow.operatorFeedback[1].step,'build');
  assert.equal(flow.results.gate,undefined);assert.deepEqual(flow.evidence,{});assert.deepEqual(flow.sessions,{});
  assert.deepEqual(f.store.need('attempt',f.attempt.id),f.attempt);
  const event=f.store.events().find(row=>row.type==='flow.replan');assert.deepEqual(event.payload.supersededGateResults,['gate']);
  const sent=[],providerInvoke=async spec=>{sent.push(spec);return {provider:spec.provider,family:spec.provider==='codex'?'openai':'anthropic',result:{status:'ready',questions:[],verdict:'pass',findings:[],riskAssessment:{level:'ordinary',rationale:'Fictional',threatModel:[],stopConditions:[]}}};};
  for (const step of ['plan','plan-review','build']) {
    flow.step=step;
    const specification=actionSpecification(f.store,flow,flow.workflow.nodes[step],join(f.stateDir,`prompt-${step}`));
    const result=await runAction({...specification,timeoutMs:60000},{providerInvoke});
    if(step==='plan')flow.results.plan=result;
  }
  assert.equal(sent.length,3);
  for(const spec of sent){assert.ok(spec.prompt.includes(note));assert.match(spec.prompt,/Keep earlier guidance/);assert.doesNotMatch(spec.prompt,/STALE ANCESTRY REFUSAL/);}
  assert.equal(sent[2].sessionId,undefined,'new planning cycle starts a fresh builder session');
  assert.match(commandHelp('flow.replan').text,/guidance delivered/);
});

test('automatic replan notes retain factory attribution and clear custom gate slots, while later correction evidence remains current',t=>{
  const f=fixture(t),flow=f.store.need('flow',f.flow.id);
  flow.workflow.nodes.verify=flow.workflow.nodes.gate;delete flow.workflow.nodes.gate;
  // Only the reset helper is under test: give its renamed graph valid edges.
  for(const node of Object.values(flow.workflow.nodes)){if(node.next==='gate')node.next='verify';for(const key of Object.keys(node.resultEdges??{}))if(node.resultEdges[key]==='gate')node.resultEdges[key]='verify';}
  flow.results.verify=structuredClone(flow.results.gate);
  const before=structuredClone(flow.results.source);
  replanFlow(f.store,flow,{note:'Target moved in planned paths',by:'factory',reason:'target-changed-planned-paths'});
  assert.equal(flow.operatorFeedback.at(-1).actor,'factory');assert.equal(flow.operatorFeedback.at(-1).note,'Target moved in planned paths');
  assert.equal(flow.results.verify,undefined);assert.equal(flow.results.gate,undefined);assert.deepEqual(flow.results.source,before);
  flow.results.gate={route:'fail',checks:[{diagnostics:{stderr:'CURRENT TEST FAILURE'}}]};flow.step='build';
  const spec=actionSpecification(f.store,flow,flow.workflow.nodes.build,join(f.stateDir,'new-correction'));
  assert.match(JSON.stringify(spec.action.results.gate),/CURRENT TEST FAILURE/);
  assert.deepEqual(f.store.need('attempt',f.attempt.id),f.attempt);
});
