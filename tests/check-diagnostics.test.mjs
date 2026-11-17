import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,symlinkSync,mkdirSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {checkDiagnostics,excerpt} from '../starter/factory/workflows/check-diagnostics.mjs';
const fixture=t=>{const dir=mkdtempSync(join(tmpdir(),'factotum-check-diagnostics-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};

test('failure excerpts retain head and tail, remove terminal controls, and share a gate-wide budget',t=>{
  const dir=fixture(t),path=join(dir,'diagnostics.txt');writeFileSync(path,'FIRST ASSERTION\n'+'x'.repeat(100000)+'\nLAST ASSERTION');
  const collect=checkDiagnostics(),rows=Array.from({length:8},()=>collect({path,stdout:'s'.repeat(20000),stderr:'e'.repeat(20000),error:'failure'}));
  assert.match(rows[0].detail,/FIRST ASSERTION/);assert.match(rows[0].detail,/LAST ASSERTION/);assert.equal(rows[0].truncated,true);
  let total=0;for(const row of rows){const chars=['detail','stdout','stderr','error'].reduce((sum,k)=>sum+(row[k]?.length??0),0);assert.ok(chars<=12000);total+=chars;}assert.ok(total<=24000);assert.equal(rows.at(-1).truncated,true);
  assert.equal(excerpt('\x1b[31mFAIL\x1b[0m\x00',100).text,'FAIL');
});

test('diagnostics refuse symlinks and special files and never follow paths printed in output',t=>{
  const dir=fixture(t),outside=join(dir,'other-log'),path=join(dir,'diagnostics.txt');writeFileSync(outside,'PRIVATE SENTINEL');
  symlinkSync(outside,path);let row=checkDiagnostics()({path,stdout:`See ${outside}`});assert.equal(row.supplied,false);assert.ok(!JSON.stringify(row).includes('PRIVATE SENTINEL'));
  rmSync(path);mkdirSync(path);row=checkDiagnostics()({path});assert.equal(row.supplied,false);assert.match(row.unavailable,/regular/);
  rmSync(path,{recursive:true});execFileSync('mkfifo',[path]);row=checkDiagnostics()({path});assert.equal(row.supplied,false);assert.match(row.unavailable,/regular/);
  rmSync(path);row=checkDiagnostics()({path,stdout:'Failed test visible without supplemental output'});assert.equal(row.supplied,false);assert.match(row.unavailable,/did not supply/);assert.match(row.stdout,/Failed test visible/);
});
