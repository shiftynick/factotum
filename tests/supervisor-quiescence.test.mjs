import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {supervise} from '../starter/factory/core/supervisor.mjs';
import {atomicJSON,digest,uid} from '../starter/factory/core/contracts.mjs';
import {sandbox,delay} from './helpers.mjs';
async function run(f,script){const path=join(f.base,uid(),'intent.json'),intent={version:1,attemptId:uid(),argv:['/bin/sh','-c',script],cwd:f.root,timeoutMs:60000,synthetic:true,maxCostMicros:0};atomicJSON(path,{...intent,intentDigest:digest(intent)});return supervise(path);}
test('brief exiting children are quiescent before successful receipt',async t=>{const f=sandbox(t);const receipt=await run(f,'(sleep 0.02) >/dev/null 2>&1 &');assert.equal(receipt.exitCode,0);assert.equal(receipt.reason,null);assert.ok(Array.isArray(receipt.descendants));for(const row of receipt.descendants){assert.equal(typeof row.comm,'string');assert.ok(Number.isSafeInteger(row.pid));assert.equal(row.phase,'leader-exited');assert.equal(row.env,undefined);}});
test('persistent background writer is failed and cannot change evidence after terminal receipt',async t=>{
  const f=sandbox(t);
  const receipt=await run(f,"(while :; do printf x >> heartbeat; sleep 0.02; done) >/dev/null 2>&1 &");
  assert.equal(receipt.reason,'descendant-survival');
  assert.ok(receipt.descendants.some(row=>row.phase==='termination-required'));
  assert.ok(receipt.descendants.every(row=>typeof row.comm==='string'&&Number.isSafeInteger(row.pid)));
  // Identity says who survived and what launched it, without the environment.
  assert.ok(receipt.descendants.some(row=>Number.isSafeInteger(row.ppid)&&Number.isSafeInteger(row.pgid)&&Number.isSafeInteger(row.sid)&&typeof row.exe==='string'&&Array.isArray(row.args)&&row.args.length<=4));
  const heartbeat=join(f.root,'heartbeat'),snapshot=()=>{try{return readFileSync(heartbeat,'utf8');}catch(error){if(error.code==='ENOENT')return '';throw error;}};
  const before=snapshot();await delay(150);assert.equal(snapshot(),before,'owned work must be quiescent before the terminal receipt becomes visible');
});
