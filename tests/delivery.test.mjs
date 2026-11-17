import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { actionSpecification } from '../starter/factory/workflows/actions.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { git } from '../starter/factory/adapters/workspace/index.mjs';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'factotum-delivery-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'root'),bin=join(directory,'bin'),artifacts=join(directory,'artifacts');
  await Promise.all([mkdir(root),mkdir(bin),mkdir(artifacts)]);
  await git(root,['init','-b','main']);await git(root,['config','user.name','Fictional Developer']);await git(root,['config','user.email','developer@example.invalid']);
  await writeFile(join(root,'app.txt'),'initial\n');await git(root,['add','.']);await git(root,['commit','-m','initial']);
  // No real forge operation is possible: this argv fixture is the only gh on PATH.
  const responses=join(bin,'responses.json');await writeFile(responses,'{}');
  const executable=join(bin,'gh');await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const dir=path.dirname(process.argv[1]);if(process.argv[2]==='auth')console.log('fictional-token');else {const endpoint=process.argv.find(a=>a.startsWith('repos/'));const values=JSON.parse(fs.readFileSync(path.join(dir,'responses.json'),'utf8'));console.log(JSON.stringify(values[endpoint]||{}));}\n`);await chmod(executable,0o700);
  const prior=process.env.PATH;process.env.PATH=`${bin}:${prior}`;t.after(()=>{process.env.PATH=prior;});
  const remote=join(directory,'remote.git');await git(root,['init','--bare',remote]);await git(root,['remote','add','origin',remote]);await git(root,['push','-u','origin','main']);
  const config={repository:{slug:'fictional/demo',account:'fictional',target:'main',remote:'origin'},policy:{planning:true},checks:[{id:'check',argv:[process.execPath,'-e','process.exit(0)'],timeoutMs:60000}],context:{files:[],maxChars:24000}};
  const task={id:'task-1',title:'Fictional change',acceptance:['Behavior works'],revision:'task-revision'};
  const intent={attemptId:'attempt-1',cwd:root,projectRoot:root,timeoutMs:60000,action:{operation:'gate',stateDir:join(directory,'state'),projectId:'project-1',flowId:'flow-1',task,config,context:{files:[],digest:'context'},artifactDir:artifacts,results:{},sessions:{}}};
  return {directory,root,artifacts,config,task,intent,responses};
}

test('delivery gate distinguishes product failure from missing verification infrastructure',async t=>{
  const f=await fixture(t);
  f.config.checks[0].argv=[process.execPath,'-e','process.exit(1)'];
  const product=await runAction(f.intent);assert.equal(product.route,'fail');assert.equal(product.checks[0].failureClass,'product');
  f.config.checks[0].argv=['/fictional/nonexistent-verifier'];
  const infra=await runAction(f.intent);assert.equal(infra.route,'blocked');assert.equal(infra.checks[0].failureClass,'infrastructure');
});

test('delivery gate rejects an uncommitted tested tree instead of publishing readiness for its HEAD',async t=>{
  const f=await fixture(t);await writeFile(join(f.root,'app.txt'),'uncommitted behavior\n');
  await assert.rejects(runAction(f.intent),/clean|dirty|uncommitted/i);
});

test('reviewed plan rejects a changed initial base before its first builder dispatch',async t=>{
  const f=await fixture(t);const identity=repositoryIdentity(f.root);
  const flow={id:'flow-1',taskId:f.task.id,results:{plan:{identity,contextDigest:null,taskRevision:f.task.revision}},sessions:{},evidence:{}};
  const store={stateDir:join(f.directory,'state'),meta:key=>key==='config'?f.config:{projectId:'project-1',root:f.root},need:()=>f.task};
  const first=actionSpecification(store, {...flow,results:{}},{action:{operation:'provider.build'}},f.artifacts);
  flow.results.plan.contextDigest=first.action.context.digest;
  await writeFile(join(f.root,'app.txt'),'different base\n');await git(f.root,['add','.']);await git(f.root,['commit','-m','advance initial base']);
  await assert.rejects(async()=>actionSpecification(store,flow,{action:{operation:'provider.build'}},f.artifacts),/plan|base|replan/i);
});

test('source verification rejects an edited remote brief before planning or building',async t=>{
  const f=await fixture(t);f.intent.action.operation='source.verify';f.intent.action.task.source={repository:'fictional/demo',issue:1,revision:'previous-revision'};
  await writeFile(f.responses,JSON.stringify({'repos/fictional/demo/issues/1':{title:'Changed task',state:'open',body:'Changed acceptance',labels:[]}}));
  await assert.rejects(runAction(f.intent),/source issue #1 changed since its approved revision/);
});

test('source verification binds green main health to the actual current remote target',async t=>{
  const f=await fixture(t);f.intent.action.operation='source.verify';
  const head=repositoryIdentity(f.root).head;
  f.intent.action.mainHealth={status:'green',head:'a'.repeat(40),checkedAt:new Date().toISOString()};
  assert.equal((await runAction(f.intent)).route,'target-unverified');
  f.intent.action.mainHealth.head=head;assert.equal((await runAction(f.intent)).route,'ready');
  f.intent.action.mainHealth.checkedAt=new Date(Date.now()-4_000_000).toISOString();
  assert.equal((await runAction(f.intent)).route,'target-unverified');
});

test('already-satisfied recording refuses target advancement after the accepted local observation',async t=>{
  const f=await fixture(t);f.intent.action.operation='outcome.satisfied';f.intent.action.task.risk='ordinary';
  f.intent.action.completionDecision={identity:repositoryIdentity(f.root),taskRevision:f.task.revision};
  assert.equal((await runAction(f.intent)).proven,true);
  const other=join(f.directory,'other');await git(f.root,['clone','--branch','main',join(f.directory,'remote.git'),other]);
  await git(other,['config','user.name','Fictional Other']);await git(other,['config','user.email','other@example.invalid']);await git(other,['commit','--allow-empty','-m','Advance target after final observation']);await git(other,['push']);
  await assert.rejects(runAction(f.intent),/target advanced/);
});

test('delivery graph exposes explicit adoption, already-satisfied, and conflict reconciliation paths',()=>{
  const graph=changeWorkflow({policy:{maxBuildRounds:2}});assert.equal(graph.start,'source');
  assert.equal(graph.nodes.source.resultEdges.candidate,'candidate');assert.equal(graph.nodes.candidate.action.operation,'workspace.adopt');
  assert.equal(graph.nodes.source.resultEdges.satisfied,'satisfied-workspace');assert.equal(graph.nodes['satisfied-decide'].role,'operator');
  assert.equal(graph.nodes.integrate.resultEdges.conflict,'conflict-question');assert.equal(graph.nodes['conflict-question'].answers.retry,'integrate');
});

test('delivery admission requires current revision and exact approved adoption identities',async t=>{
  const f=await fixture(t),stateDir=join(f.directory,'state');
  const config={...f.config,version:1,mode:'delivery',providers:{planner:{provider:'codex',model:'fictional'},builder:{provider:'codex',model:'fictional'},reviewer:{provider:'claude',model:'fictional'}}};
  const identity=initProject({stateDir,root:f.root,name:'Fictional admission test',config,supervisor:'systemd'}),store=new Store(stateDir);t.after(()=>store.close());
  store.setMeta('commissioning',{ready:true,configDigest:store.meta('configDigest')});store.setMeta('mainHealth',{status:'green',head:repositoryIdentity(f.root).head,checkedAt:new Date().toISOString()});
  let sequence=0;const invoke=(operation,payload)=>executeCommand(store,{protocolVersion:1,projectId:identity.projectId,commandId:`command-${++sequence}`,actor:'operator',operation,payload});
  const task=invoke('task.put',{task:f.task}).result;invoke('task.approve',{taskId:task.id,revision:task.revision});
  assert.equal(invoke('flow.start',{taskId:task.id}).status,'rejected');
  assert.equal(invoke('flow.start',{taskId:task.id,revision:task.revision,candidate:{number:1,head:'missing'}}).status,'rejected');
  assert.equal(invoke('flow.start',{taskId:task.id,revision:task.revision,candidate:{number:1,head:'a'.repeat(40),base:'b'.repeat(40)},alreadySatisfied:true}).status,'rejected');
  const accepted=invoke('flow.start',{taskId:task.id,revision:task.revision,candidate:{number:1,head:'a'.repeat(40),base:'b'.repeat(40)}});assert.equal(accepted.status,'completed');assert.equal(accepted.result.candidate.number,1);
});

test('orchestrated adoption retains original PR disposition and works only in a new owned branch',async t=>{
  const f=await fixture(t),base=repositoryIdentity(f.root).head;
  await git(f.root,['checkout','-b','original-candidate']);await writeFile(join(f.root,'feature.txt'),'candidate');await git(f.root,['add','.']);await git(f.root,['commit','-m','Original candidate']);const head=repositoryIdentity(f.root).head;
  await git(f.root,['push','origin','HEAD:refs/pull/1/head']);await git(f.root,['checkout','main']);
  await writeFile(f.responses,JSON.stringify({'repos/fictional/demo/pulls/1':{number:1,state:'open',draft:false,merged:false,commits:1,head:{sha:head,ref:'original-candidate'},base:{sha:base,ref:'main'},html_url:'https://example.invalid/pull/1'},'repos/fictional/demo/pulls/1/commits?per_page=100&page=1':[{sha:head,commit:{message:'Original candidate'}}]}));
  Object.assign(f.intent.action,{operation:'workspace.adopt',stateDir:join(f.directory,'state'),candidate:{number:1,head,base}});
  const adopted=await runAction(f.intent);assert.equal(adopted.route,'adopted');assert.equal(adopted.workspace.base,head);assert.equal(adopted.obligations,undefined,'the superseded-PR to-do waits until a replacement is published');
  assert.equal((await git(f.root,['rev-parse','original-candidate'])).stdout,head);assert.notEqual(adopted.workspace.branch,'original-candidate');
});

test('a missing owned workspace cannot redirect builder execution into the project root',async t=>{
  const f=await fixture(t),flow={id:'flow-1',taskId:f.task.id,workspace:{path:join(f.directory,'missing-owned-tree')},results:{},sessions:{},evidence:{},step:'build'};
  const store={stateDir:join(f.directory,'state'),meta:key=>key==='config'?f.config:{projectId:'project-1',root:f.root},need:()=>f.task};
  assert.throws(()=>actionSpecification(store,flow,{action:{operation:'provider.build'}},f.artifacts),/workspace|missing|owned/i);
});

test('governing context follows planned files and actual committed changes, not only declared task paths',async t=>{
  const f=await fixture(t),base=repositoryIdentity(f.root).head;
  await writeFile(join(f.root,'RULES.md'),'Fictional source-file governance');await git(f.root,['add','.']);await git(f.root,['commit','-m','Governance']);
  const workspaceBase=repositoryIdentity(f.root).head;
  f.config.context={maxChars:24000,files:[{id:'source-rules',path:'RULES.md',required:false,paths:['feature.txt']}]};
  const store={stateDir:join(f.directory,'state'),meta:key=>key==='config'?f.config:{projectId:'project-1',root:f.root},need:()=>f.task};
  const planned={id:'flow-1',taskId:f.task.id,results:{plan:{result:{files:['feature.txt']}}},evidence:{}};
  const planPackage=actionSpecification(store,planned,{action:{operation:'provider.planReview'}},f.artifacts);
  assert.equal(planPackage.action.context.files[0].id,'source-rules');
  await writeFile(join(f.root,'feature.txt'),'actual change');await git(f.root,['add','.']);await git(f.root,['commit','-m','Unplanned source change']);
  const actual={id:'flow-1',taskId:f.task.id,workspace:{path:f.root,base:workspaceBase},results:{},evidence:{}};
  const reviewPackage=actionSpecification(store,actual,{action:{operation:'provider.review'}},f.artifacts);
  assert.equal(reviewPackage.action.context.files[0].id,'source-rules');
});

test('a configured preview sits before the merge question and attaches the candidate’s images',async t=>{
  const preview={command:[process.execPath,'-e',"require('fs').writeFileSync(process.env.FACTOTUM_PREVIEW_DIR+'/home.png',Buffer.from('89504e47','hex'))"],timeoutMs:60000,paths:['site/']};
  const graph=changeWorkflow({...{repository:{target:'main'},checks:[]},preview});
  assert.equal(graph.nodes.gate.resultEdges.pass,'preview');assert.equal(graph.nodes.preview.next,'decide');assert.equal(graph.nodes.preview.onFailure,'decide');
  assert.equal(changeWorkflow({repository:{target:'main'},checks:[]}).nodes.preview,undefined,'no preview without configuration');
  const f=await fixture(t);const base=(await git(f.root,['rev-parse','HEAD'])).stdout.trim();
  await mkdir(join(f.root,'site'));await writeFile(join(f.root,'site/index.html'),'<p>hi</p>\n');await git(f.root,['add','.']);await git(f.root,['commit','-m','site']);
  const intent={...f.intent,action:{...f.intent.action,operation:'preview',config:{...f.config,preview},results:{integrate:{base}}}};
  const shot=await runAction(intent);assert.equal(shot.route,'pass');assert.deepEqual(shot.files,[{name:'home.png',bytes:4}]);assert.equal(shot.attemptId,'attempt-1');
  const elsewhere=await runAction({...intent,action:{...intent.action,config:{...f.config,preview:{...preview,paths:['docs/']}}}});assert.equal(elsewhere.route,'skipped');
  const broken=await runAction({...intent,action:{...intent.action,config:{...f.config,preview:{...preview,command:[process.execPath,'-e','process.exit(3)']}}}});assert.equal(broken.route,'fail');assert.match(broken.reason,/preview command failed/);
});

test('a configured preview goes before every merge question of a project-owned graph too',async()=>{
  const { compileCatalog } = await import('../starter/factory/core/catalog.mjs');
  const { mkdtempSync, mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
  const root=mkdtempSync(join(tmpdir(),'factotum-owned-'));mk(join(root,'project/workflows'),{recursive:true});
  const owned=changeWorkflow({repository:{target:'main'},checks:[]});wf(join(root,'project/workflows/change.json'),JSON.stringify(owned));
  const config={version:1,mode:'delivery',repository:{slug:'f/d',account:'f',target:'main'},providers:{planner:{provider:'codex',model:'m'},builder:{provider:'codex',model:'m'},reviewer:{provider:'claude',model:'m'}},checks:[{id:'c',argv:['true'],timeoutMs:60000}],context:{files:[],maxChars:1000},
    preview:{command:['true'],timeoutMs:60000,paths:['site/']},workflows:{definitions:{change:{path:'project/workflows/change.json'},research:{reference:'change.document'}},selection:{default:'change'}}};
  const catalog=compileCatalog(config,root),graph=catalog.workflows.change.workflow;
  assert.equal(graph.nodes.gate.resultEdges.pass,'preview');assert.equal(graph.nodes.gate.next,'preview');assert.equal(graph.nodes.preview.next,'decide');
  assert.equal(catalog.workflows.research.workflow.nodes.review.resultEdges.pass,'preview','document reference');
  assert.equal(compileCatalog({...config,preview:undefined},root).workflows.change.workflow.nodes.preview,undefined);
});

test('declared inputs are in the worktree from its creation, so the planner sees them',async t=>{
  const f=await fixture(t);f.intent.action.operation='source.verify';
  await writeFile(join(f.root,'.gitignore'),'data/\n');await git(f.root,['add','.']);await git(f.root,['commit','-m','ignore data']);await git(f.root,['push','origin','main']);
  await mkdir(join(f.root,'data/raw'),{recursive:true});await writeFile(join(f.root,'data/frame.json'),'{}\n');await writeFile(join(f.root,'data/raw/a.json'),'[]\n');
  f.intent.action.mainHealth={status:'green',head:repositoryIdentity(f.root).head,checkedAt:new Date().toISOString()};
  f.intent.action.task={...f.task,inputs:[{path:'data/frame.json'},{path:'data/raw'}]};
  const verified=await runAction(f.intent);
  assert.deepEqual(verified.inputs,['data/frame.json','data/raw']);
  assert.equal(await readFile(join(verified.workspace.path,'data/raw/a.json'),'utf8'),'[]\n');
});

test('with rerunFailedChecks a required check that still fails after its rerun holds the flow at the gate',async t=>{
  const f=await fixture(t),head=repositoryIdentity(f.root).head;f.config.repository.rerunFailedChecks=true;
  // The run concludes success because its gate job is continue-on-error; the job itself failed.
  const runs={workflow_runs:[{id:7,name:'Verify',event:'pull_request',status:'completed',conclusion:'success'},{id:8,name:'Other',event:'push',status:'completed',conclusion:'failure'},{id:9,name:'Lint',event:'pull_request',status:'completed',conclusion:'success'}]};
  const jobs=(gate)=>({[`repos/fictional/demo/actions/runs/7/jobs?per_page=100`]:{jobs:[{name:'Security gate',conclusion:gate}]},[`repos/fictional/demo/actions/runs/9/jobs?per_page=100`]:{jobs:[{name:'lint',conclusion:'success'}]}});
  await writeFile(f.responses,JSON.stringify({[`repos/fictional/demo/actions/runs?head_sha=${head}&per_page=100`]:runs,...jobs('failure'),'repos/fictional/demo/actions/runs/7':{name:'Verify',status:'completed',conclusion:'success'}}));
  const responses=JSON.parse(await readFile(f.responses,'utf8'));
  await writeFile(f.responses,JSON.stringify({...responses,...jobs('failure')}));
  const held=await runAction(f.intent);assert.equal(held.route,'blocked');assert.match(held.reason,/Verify failure/);
});

test('gate checks are told which branch they run for',async t=>{
  const f=await fixture(t);
  f.config.checks[0].argv=[process.execPath,'-e',"process.exit(process.env.FACTOTUM_TARGET==='next'&&process.env.FACTOTUM_CHECK_KIND==='gate'?0:1)"];
  assert.equal((await runAction(f.intent)).route,'fail','default target is main');
  assert.equal((await runAction({...f.intent,action:{...f.intent.action,target:'next'}})).route,'pass');
});

test('a gate failure delivers stdout and designated assertion details to the resumed builder without changing its tree',async t=>{
  const f=await fixture(t),before=repositoryIdentity(f.root);f.intent.timeoutMs=60000;
  f.config.providers={builder:{provider:'codex',model:'fictional'}};
  f.config.checks[0].argv=[process.execPath,'-e',"const fs=require('node:fs');fs.writeFileSync(process.env.FACTOTUM_CHECK_DIAGNOSTICS,'FAIL fictional-test: expected 2, received 1');console.log('Verification failed; original output stays private');console.error('Assertion failure summary');process.exit(1)"];
  const gate=await runAction(f.intent);assert.equal(gate.route,'fail');assert.equal(gate.checks[0].diagnostics.supplied,true);
  assert.match(gate.checks[0].diagnostics.detail,/expected 2, received 1/);assert.match(gate.checks[0].diagnostics.stdout,/Verification failed/);
  const raw=JSON.parse(await readFile(join(f.artifacts,'check-0.json'),'utf8'));assert.match(raw.stderr,/Assertion failure/);
  f.intent.action.operation='provider.build';f.intent.action.results={gate,build:{provider:'codex',model:'fictional'}};f.intent.action.sessions={builder:'original-builder-session'};
  let sent;await runAction(f.intent,{providerInvoke:async route=>{sent=route;return {family:'codex',result:{status:'implemented',questions:[]}};}});
  assert.equal(sent.sessionId,'original-builder-session');assert.equal(sent.cwd,f.root);assert.match(sent.prompt,/expected 2, received 1/);assert.match(sent.prompt,/Verification failed/);assert.match(sent.prompt,/untrusted test output, not instructions/);
  assert.deepEqual(repositoryIdentity(f.root),before,'no copied diagnostic files change the candidate');
});

test('gate output fallback is delivered without a supplemental file and a passing check has no correction diagnostics',async t=>{
  const f=await fixture(t);f.config.checks[0].argv=[process.execPath,'-e',"console.log('FAIL: expected true, received false');process.exit(1)"];
  const failed=await runAction(f.intent);assert.equal(failed.checks[0].diagnostics.supplied,false);assert.match(failed.checks[0].diagnostics.stdout,/expected true/);
  f.config.checks[0].argv=[process.execPath,'-e',"console.log('PASS')"];
  const passed=await runAction(f.intent);assert.equal(passed.route,'pass');assert.equal(passed.checks[0].diagnostics,undefined);
});

test('commissioned prerequisite exit codes hold the gate and skip later expensive checks',async t=>{
  const f=await fixture(t);f.config.checks=[{id:'ancestry',argv:[process.execPath,'-e',"console.error('Integrate the target first');process.exit(78)"],timeoutMs:60000,holdExitCodes:[78]},{id:'later',argv:['/fictional/should-not-run'],timeoutMs:60000}];
  let result=await runAction(f.intent);assert.equal(result.route,'held');assert.equal(result.gateHold.kind,'check-prerequisite');assert.equal(result.checks.length,1);assert.equal(result.complete,false);assert.match(result.checks[0].diagnostics.stderr,/Integrate/);
  delete f.config.checks[0].holdExitCodes;result=await runAction(f.intent);assert.notEqual(result.route,'held');assert.equal(result.checks.length,2,'ordinary failures keep their existing routing');
  f.intent.action.targetSyncHolds=[{reason:'Repair target sync'}];result=await runAction(f.intent);assert.equal(result.route,'held');assert.equal(result.gateHold.kind,'target-sync');assert.equal(result.checks,undefined,'known sync hold avoids all checks');
});
