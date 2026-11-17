import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {git,prepare,commit,integrateTarget} from '../starter/factory/adapters/workspace/index.mjs';
import {runAction} from '../starter/factory/workflows/dispatch.mjs';

test('corrected candidate republishes one PR and distinct idempotent builder reports',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'factotum-rounds-'));const prior=process.env.PATH;
 t.after(async()=>{process.env.PATH=prior;await rm(directory,{recursive:true,force:true});});
 const root=join(directory,'project'),remote=join(directory,'remote.git'),records=join(directory,'remote.json');await mkdir(root);
 for(const args of [['init','-b','main'],['config','user.name','Fictional Developer'],['config','user.email','developer@example.invalid']])await git(root,args);
 await writeFile(join(root,'file'),'base');await git(root,['add','.']);await git(root,['commit','-m','Initial']);await git(root,['init','--bare',remote]);await git(root,['remote','add','origin',remote]);await git(root,['push','-u','origin','main']);
 await writeFile(records,JSON.stringify({prs:[],comments:[]}));
 await writeFile(join(directory,'gh'),`#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const file=${JSON.stringify(records)};if(a[0]==='auth'){process.stdout.write('fictional');process.exit(0);}const db=JSON.parse(fs.readFileSync(file));const p=a.find(x=>x.startsWith('repos/'));const method=a.includes('--method')?a[a.indexOf('--method')+1]:'GET';const rows=p.includes('/pulls')?db.prs:db.comments;if(method==='POST'){const body=JSON.parse(fs.readFileSync(0,'utf8'));rows.push({...body,...(p.includes('/pulls')?{user:{login:'fictional'},head:{ref:body.head,repo:{full_name:'fictional/demo'}}}:{}),number:rows.length+1,id:rows.length+1});fs.writeFileSync(file,JSON.stringify(db));process.stdout.write(JSON.stringify(rows.at(-1)));}else process.stdout.write(JSON.stringify(rows));\n`,{mode:0o700});process.env.PATH=directory+':'+prior;
 const workspace=await prepare({root,stateDir:join(directory,'state'),projectId:'fictional',flowId:'flow',baseRef:'main'});
 const action={operation:'forge.publish',projectId:'fictional',flowId:'flow',workspace,config:{mode:'rehearsal',repository:{slug:'fictional/demo',account:'fictional',target:'main'}},task:{id:'task',title:'Preserve records',acceptance:['Records survive reload']},context:{files:[]},results:{integrate:await integrateTarget({workspace,remote:'origin',target:'main'}),build:{result:{summary:'Initial candidate',unverified:[]}}}};
 const run=()=>runAction({cwd:workspace.path,action,timeoutMs:30000});
 const first=await run();assert.equal(first.number,1);
 await writeFile(join(workspace.path,'file'),'corrected');await commit({workspace,message:'Correct reviewed finding'});
 // forge.publish publishes only the head of the last integration, so the corrected candidate is integrated again, as the graph does.
 await assert.rejects(run(),/publishes only the candidate the factory has just integrated/);action.results.integrate=await integrateTarget({workspace,remote:'origin',target:'main'});action.results.build.result={summary:'Corrected independently reviewed finding',departures:[{from:'Initial plan',why:'Review correction'}],unverified:[]};
 const second=await run();await run();assert.equal(second.number,1);assert.notEqual(first.head,second.head);
 action.results.build.result.summary='Confirmed existing correction without additional code changes';await run();await run();
 const db=JSON.parse(await readFile(records,'utf8'));assert.equal(db.prs.length,1);assert.equal(db.comments.length,3);assert.match(db.comments[1].body,/Corrected independently/);assert.match(db.comments[1].body,new RegExp(second.head));
});
