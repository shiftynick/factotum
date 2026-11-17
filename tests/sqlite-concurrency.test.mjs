import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Each owner remains alive after its claim until ALL decisions reach the parent.
// Otherwise a fast winner could exit and make later acquisitions legitimately win.
test('four real processes create one resource database and contend for its first lease', {timeout:20000}, async t=>{
  const root=await mkdtemp(join(tmpdir(),'factotum-sqlite-race-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const moduleURL=new URL('../starter/factory/operations/resources.mjs',import.meta.url).href,path=join(root,'coordinator.sqlite');
  const script=`import {HostResources} from ${JSON.stringify(moduleURL)};
    let coordinator,lease;
    process.on('message',message=>{
      if(message==='claim') {
        try { coordinator=new HostResources(process.argv[1]);lease=coordinator.acquire({projectId:'fictional-'+process.argv[2],flowId:'flow',attemptId:'attempt'});process.send({type:'result',acquired:Boolean(lease)}); }
        catch(error) { process.send({type:'result',error:error.message}); }
      } else if(message==='finish') {
        try { if(lease)coordinator.release('heavy-work',lease.token);coordinator?.close();process.disconnect(); }
        catch { process.exitCode=1;process.disconnect(); }
      }
    });
    process.send({type:'ready'});`;
  const contenders=Array.from({length:4},(_,index)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',script,path,String(index)],{stdio:['ignore','pipe','pipe','ipc']});
    t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
    let readyResolve,resultResolve;const ready=new Promise(r=>readyResolve=r),result=new Promise(r=>resultResolve=r);
    child.on('message',message=>{if(message.type==='ready')readyResolve();if(message.type==='result')resultResolve(message);});
    child.on('error',error=>{readyResolve();resultResolve({error:error.message});});
    const exit=new Promise(r=>child.once('exit',(code,signal)=>r({code,signal})));
    return{child,ready,result,exit};
  });
  await Promise.all(contenders.map(c=>c.ready));
  for(const c of contenders)c.child.send('claim');
  const results=await Promise.all(contenders.map(c=>c.result));
  for(const c of contenders)c.child.send('finish');
  const exits=await Promise.all(contenders.map(c=>c.exit));
  assert.deepEqual(results.filter(r=>r.error),[],'first-open journal/schema setup must not fail under contention');
  assert.equal(results.filter(r=>r.acquired).length,1,'one live owner must consume the only heavy-work lease');
  assert.ok(exits.every(e=>e.code===0&&!e.signal),'all contenders close normally after the shared barrier');
});
