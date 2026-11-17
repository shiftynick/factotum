import test from 'node:test';
import assert from 'node:assert/strict';
import {sandbox} from './helpers.mjs';
import {retrospective} from '../starter/factory/operations/governance.mjs';
test('passing configured checks preserve builder-reported unverified acceptance',t=>{
  const f=sandbox(t);f.start();const flow=f.store.need('flow','flow-1');flow.results={gate:{route:'pass',complete:true,checks:[{status:'passed'}]},build:{result:{unverified:['External delivery was not observed']}}};f.store.put('flow',flow);
  const report=retrospective(f.store,{flowId:flow.id});assert.equal(report.acceptance.configuredGatePassed,true);assert.deepEqual(report.acceptance.unverifiedCriteria,['External delivery was not observed']);assert.deepEqual(report.acceptance.reportedUnverified,['External delivery was not observed']);assert.match(report.acceptance.coverage,/project-defined/);
});
test('latest durable worker report supplies unverified items and failed checks retain all original criteria',t=>{
  const f=sandbox(t);f.start();const flow=f.store.need('flow','flow-1');flow.results={gate:{route:'fail',complete:true,checks:[{status:'failed'}]}};flow.workerReports=[{step:'build',unverified:['Old uncertainty']},{step:'build',unverified:['Current unverified observation']}];f.store.put('flow',flow);
  const report=retrospective(f.store,{flowId:flow.id});assert.deepEqual(report.acceptance.unverifiedCriteria,[...f.task.acceptance,'Current unverified observation']);assert(!report.acceptance.unverifiedCriteria.includes('Old uncertainty'));
});
