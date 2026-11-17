import test from 'node:test';import assert from 'node:assert/strict';import {join} from 'node:path';import {sandbox} from './helpers.mjs';
import {runAction} from '../starter/factory/workflows/dispatch.mjs';import {recordRiskAssessment,effectiveRisk} from '../starter/factory/core/risk.mjs';
const ordinary={level:'ordinary',rationale:'Synthetic bounded plan',threatModel:[],stopConditions:[]};
const result=(verdict,findings=[],riskAssessment=ordinary)=>({provider:'fictional',model:'synthetic-reviewer',family:'opposing',sessionId:`fresh-session-${Math.random()}`,result:{verdict,summary:'Synthetic protocol fixture',findings,riskAssessment}});
const finding={severity:'low',file:'input.txt',line:1,message:'Synthetic optional observation'};
function fixture(t,policy={}){const f=sandbox(t);return {...f,intent:{cwd:f.root,timeoutMs:60000,action:{operation:'provider.planReview',task:{id:'fictional-task',title:'Fictional task',acceptance:['Observed fictional behavior'],risk:'ordinary',revision:'r1'},config:{mode:'rehearsal',repository:{slug:'fictional/project',account:'fictional',target:'main'},providers:{reviewer:{provider:'claude',model:'synthetic-reviewer'}},policy},risk:{level:'ordinary'},context:{files:[],digest:'fictional-context'},results:{plan:{result:{summary:'Pinned fictional plan',files:['input.txt']}}},sessions:{},artifactDir:join(f.base,'artifacts')}}};}
test('a contradictory pass receives one fresh bounded same-plan review in a separate artifact directory',async t=>{
  const f=fixture(t),calls=[],responses=[result('pass',[finding]),result('pass')];const outcome=await runAction(f.intent,{providerInvoke:async spec=>{calls.push(spec);return responses.shift();}});
  assert.equal(calls.length,2);assert.equal(outcome.providerInvocations.length,2);assert.ok(outcome.providerInvocations.every(r=>!r.result));assert.equal(outcome.route,'pass');assert.equal(outcome.protocolCorrections.length,1);assert.deepEqual(outcome.protocolCorrections[0].original.result.findings,[finding]);assert.notEqual(calls[0].artifactDir,calls[1].artifactDir);assert.equal(calls[0].sessionId,undefined);assert.equal(calls[1].sessionId,undefined);assert(calls[1].timeoutMs<=calls[0].timeoutMs);assert(calls.every(spec=>spec.prompt.includes('Pinned fictional plan')));assert.match(calls[1].prompt,/Do not assume the plan passes/);
});
test('repeated contradiction still revises and a substantive revise never gets a protocol retry',async t=>{
  const f=fixture(t);let calls=0;const repeated=await runAction(f.intent,{providerInvoke:async()=>{calls++;return result('pass',[finding]);}});assert.equal(calls,2);assert.equal(repeated.route,'revise');assert.deepEqual(repeated.result.findings,[finding]);
  calls=0;const substantive=await runAction(f.intent,{providerInvoke:async()=>{calls++;return result('revise',[{...finding,severity:'high'}]);}});assert.equal(calls,1);assert.equal(substantive.route,'revise');assert.equal(substantive.protocolCorrections.length,0);
});
test('configured zero corrections preserves contradictory evidence without another provider turn',async t=>{const f=fixture(t,{planReviewProtocolCorrections:0});let calls=0;const outcome=await runAction(f.intent,{providerInvoke:async()=>{calls++;return result('pass',[finding]);}});assert.equal(calls,1);assert.equal(outcome.route,'revise');});
test('protocol correction cannot erase a strict risk escalation from the original review',async t=>{
  const f=fixture(t),strict={level:'strict',rationale:'Synthetic saved state',threatModel:['Untrusted imports'],stopConditions:['Halt on lost records']};const responses=[result('pass',[finding],strict),result('pass')];const outcome=await runAction(f.intent,{providerInvoke:async()=>responses.shift()});assert.equal(outcome.route,'revise');const flow={};recordRiskAssessment(flow,'plan-review',outcome,'synthetic-attempt');assert.equal(effectiveRisk({risk:'ordinary'},flow),'strict');assert.equal(flow.riskAssessments.length,2);
});

test('a failed protocol correction retains the first invocation and the missing correction', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(runAction(f.intent, { providerInvoke: async () => { if (calls++) throw Object.assign(new Error('synthetic failure'), { started: true }); return result('pass', [finding]); } }), error => {
    assert.equal(error.providerInvocations.length, 2); assert.equal(error.providerInvocations[0].provider, 'fictional'); assert.equal(error.providerInvocations[1].provider, 'claude'); return true;
  });
});
