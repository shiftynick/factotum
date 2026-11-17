#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { atomicJSON } from '../starter/factory/core/contracts.mjs';
import { createGhTransport, cleanGitHubEnvironment } from '../starter/factory/adapters/github/index.mjs';

const reference = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let runtime, create = false, provisionOnly = false, inject = true, advanced = false, newSeries = false;
for (let i=0;i<args.length;i++) {
  if(args[i]==='--runtime') { assert(args[i+1], '--runtime needs a directory'); runtime=resolve(args[++i]); }
  else if(args[i]==='--create') create=true;
  else if(args[i]==='--provision-only') provisionOnly=true;
  else if(args[i]==='--no-inject') inject=false;
  else if(args[i]==='--advanced') advanced=true;
  else if(args[i]==='--new-series') newSeries=true;
  else throw new Error(`Unknown option: ${args[i]}`);
}
assert(runtime || create, 'Use --create for new private qualification repositories, or --runtime PATH to resume');
runtime ||= await mkdtemp(join(tmpdir(),'factotum-live-'));
await mkdir(runtime,{recursive:true,mode:0o700});
const manifestPath=join(runtime,'qualification.json');
const exists=path=>access(path).then(()=>true,()=>false);
let manifest=await exists(manifestPath)?JSON.parse(await readFile(manifestPath,'utf8')):null;
function save(){atomicJSON(manifestPath,manifest);}
function log(event, details={}) { console.log(JSON.stringify({event,...details})); }
function command(argv,cwd,{allowFailure=false,env=process.env}={}) {
  const result=spawnSync(argv[0],argv.slice(1),{cwd,env:{...env,GIT_TERMINAL_PROMPT:'0'},encoding:'utf8',timeout:60_000,maxBuffer:2*1024*1024});
  assert(!result.error,`${argv[0]} failed to launch`);
  if(!allowFailure) assert.equal(result.status,0,`${argv[0]} failed (${result.status}): ${(result.stderr||result.stdout).slice(-2000)}`);
  return {exitCode:result.status,stdout:result.stdout.trim()};
}
if(!manifest) {
  assert(create,'No qualification manifest; --create is required');
  const account=command(['gh','api','user','--jq','.login'],reference,{env:cleanGitHubEnvironment()}).stdout;
  assert(/^[a-z\d-]+$/i.test(account),'Unable to determine active personal account');
  const runId=randomUUID().slice(0,8);
  manifest={version:1,runId,account,createdAt:new Date().toISOString(),runtime,projects:[],inject};
  for(const [file,stack] of [['web-completion-persistence.json','web'],['cli-completed-filter.json','python']]) {
    const scenario=JSON.parse(await readFile(join(reference,'evals','scenarios',file),'utf8'));
    const name=`factotum-qualification-${stack}-${runId}`;
    manifest.projects.push({stack,scenario,name,slug:`${account}/${name}`,status:'planned'});
  }
  save();
}
assert(manifest.version===1,'Unsupported qualification manifest');
if(advanced&&manifest.profile!=='advanced'){assert(manifest.projects.every(project=>!project.commissioned&&!project.passed),'cannot change qualification profile beneath commissioned work');manifest.profile='advanced';save();}
const request=createGhTransport({account:manifest.account});
if(newSeries)for(const project of manifest.projects.filter(p=>!p.passed&&p.stateDir)) {
  if(!await exists(join(project.stateDir,'state.sqlite')))continue;
  assert(!project.pr,'A published qualification must recover its existing flow; new-series is prepublication only');
  const cli=join(project.root,'factory','cli.mjs'),snapshot=JSON.parse(command([process.execPath,cli,'status','--state',project.stateDir],project.root).stdout);
  assert(snapshot.attempts.every(a=>a.settledAt||['passed','failed','not-dispatched','aborted'].includes(a.status)),'reconcile every attempt before a new series');
  assert(snapshot.flows.every(f=>['stopped','failed','completed'].includes(f.state)),'stop active work before a new series');
  for(const flow of snapshot.flows.filter(f=>f.state==='stopped'))command([process.execPath,cli,'command','--actor','operator','--state',project.stateDir,'--operation','flow.abandon','--payload',JSON.stringify({flowId:flow.id,note:'Preserve this stopped prepublication qualification; begin an explicitly separate series with the current reference'})],project.root);
  const number=(project.seriesHistory?.length??0)+1,archive=join(runtime,'prior-executors',`${project.stack}-${number}`);await mkdir(dirname(archive),{recursive:true,mode:0o700});await cp(join(project.root,'factory'),archive,{recursive:true});
  (project.seriesHistory??=[]).push({stateDir:project.stateDir,executorArchive:archive,flows:snapshot.flows.map(f=>({id:f.id,state:f.state,step:f.step,reason:f.stopReason,executorDigest:f.executorDigest})),preservedAt:new Date().toISOString()});
  project.stateDir=join(runtime,'state',`${project.stack}-series-${number+1}`);project.commissioned=false;delete project.identity;save();
}
const active=[];
try {
  for(const project of manifest.projects) {
    if(!project.remoteCreated) {
      let remote;
      try { remote=await request({path:`repos/${project.slug}`}); } catch(error) { if(error.status!==404) throw error; }
      if(!remote) {
        assert(create,`Repository not yet provisioned: rerun --create --runtime ${runtime}`);
        project.status='creating';save();
        try { remote=await request({method:'POST',path:'user/repos',body:{name:project.name,private:true,has_issues:true,has_wiki:false,auto_init:false,description:'Disposable fictional Factotum qualification fixture'}}); }
        catch(error) {
          // Never choose a new name after a lost create response.
          try { remote=await request({path:`repos/${project.slug}`}); } catch { throw error; }
        }
      }
      assert(remote.private===true && remote.owner?.login?.toLowerCase()===manifest.account.toLowerCase(),'Qualification repository must be private and personally owned');
      project.remoteCreated=true;project.url=remote.html_url;project.sshUrl=remote.ssh_url;save();
      log('repository.created',{stack:project.stack,url:project.url});
    }
    // Repeat on every invocation: no checkout is ever pushed before Actions is disabled.
    await request({method:'PUT',path:`repos/${project.slug}/actions/permissions`,body:{enabled:false}});
    const actions=await request({path:`repos/${project.slug}/actions/permissions`});
    assert.equal(actions.enabled,false,'Actions must be disabled before fixture push');
    project.actionsDisabled=true;save();
    const root=join(runtime,'projects',project.stack);project.root=root;project.stateDir??=join(runtime,'state',project.stack);
    if(!await exists(join(root,'.git'))) {
      await mkdir(dirname(root),{recursive:true,mode:0o700});
      await cp(join(reference,project.scenario.example),root,{recursive:true});
      await cp(join(reference,'starter'),root,{recursive:true});
      command(['git','init','-b','main'],root);
      command(['git','config','user.name','Fictional Qualification Operator'],root);
      command(['git','config','user.email','qualification@example.invalid'],root);
      command(['git','config','commit.gpgsign','false'],root);
      command(['git','config','core.hooksPath','/dev/null'],root);
      command(['git','remote','add','origin',project.sshUrl],root);
      command(['git','add','.'],root);command(['git','commit','-m','Initial fictional qualification project'],root);
      save();
    }
    if(!project.fixturePushed) {
      assert.equal(command(project.scenario.baseline.argv,root).exitCode,0);
      assert.equal(command(project.scenario.check.argv,root,{allowFailure:true}).exitCode,1,'Feature must fail normally before implementation');
      command(['git','push','--set-upstream','origin','main'],root);project.fixturePushed=true;save();
    }
    if(!project.issue) {
      const marker=`<!-- factotum-qualification:${manifest.runId}:${project.stack} -->`;
      const issues=await request({path:`repos/${project.slug}/issues?state=all&per_page=100`});
      let issue=issues.find(row=>row.body?.includes(marker));
      if(!issue) {
        const brief={version:1,outcome:project.scenario.title,acceptance:project.scenario.acceptance,dependencies:[],risk:'ordinary',postMerge:[]};
        try { issue=await request({method:'POST',path:`repos/${project.slug}/issues`,body:{title:project.scenario.title,body:`Implement the requested behavior in this fictional project. Preserve the existing acceptance and baseline tests.\n\n\`\`\`factotum-task\n${JSON.stringify(brief,null,2)}\n\`\`\`\n\n${marker}`}}); }
        catch(error) { const after=await request({path:`repos/${project.slug}/issues?state=all&per_page=100`});issue=after.find(row=>row.body?.includes(marker));if(!issue)throw error; }
      }
      project.issue=issue.number;save();
    }
    project.status='provisioned';save();
    log('repository.provisioned',{stack:project.stack,url:project.url,actionsDisabled:true,issue:project.issue,runtimeDir:runtime});
  }
  if(!provisionOnly) await runQualification();
  log('qualification.saved',{runtimeDir:runtime,manifest:manifestPath,provisionOnly});
} catch(error) {
  manifest.lastFailure={at:new Date().toISOString(),message:error.message};save();
  console.error(JSON.stringify({event:'qualification.failed',error:error.message,runtimeDir:runtime}));process.exitCode=1;
} finally { for(const item of active){if(item.service)await item.service.close();item.store.close();} }

async function runQualification() {
  // Runtime execution is intentionally separate from private repository provisioning.
  for(const project of manifest.projects) {
    if(project.passed) { log('qualification.already-passed',{stack:project.stack});continue; }
    const adopted=path=>import(pathToFileURL(join(project.root,'factory',path)).href);
    if(!await exists(join(project.stateDir,'state.sqlite'))) {
      // Provisioning can precede implementation completion. Pin the final adopted copy
      // before initialization; never replace an executor underneath an existing flow.
      await cp(join(reference,'starter'),project.root,{recursive:true});
      const changed=command(['git','status','--porcelain'],project.root).stdout;
      if(changed) {command(['git','add','factory','project','VERSION','compatibility.json'],project.root);command(['git','commit','-m','Pin starter for live qualification'],project.root);command(['git','push','origin','main'],project.root);}
    }
    const [{Store,initProject},{executeCommand},{Engine},commission,{startProjectService},workspace]=await Promise.all([
      adopted('core/store.mjs'),adopted('core/project.mjs'),adopted('core/engine.mjs'),adopted('workflows/commission.mjs'),adopted('service/project-service.mjs'),adopted('adapters/workspace/index.mjs'),
    ]);
    const primary=project.stack==='web'?{provider:'codex',model:'gpt-6.1-sol'}:{provider:'claude',model:'sonnet'};
    const reviewer=project.stack==='web'?{provider:'claude',model:'sonnet'}:{provider:'codex',model:'gpt-6.1-sol'};
    const config={version:1,mode:'delivery',repository:{slug:project.slug,account:manifest.account,target:'main',remote:'origin',checkContext:'factotum/gate',closeTasks:true},providers:{planner:primary,builder:primary,reviewer},checks:[{id:'acceptance',argv:project.scenario.check.argv,timeoutMs:30_000}],mainChecks:[{id:'baseline',argv:project.scenario.baseline.argv,timeoutMs:30_000}],context:{files:[],maxChars:24_000},policy:{planning:true,reviewProtocol:manifest.profile==='advanced'?'bounded-delta':'fresh-full',maxBuildRounds:4,autoMerge:false,mainHealthMaxAgeMs:3_600_000},resources:{coordinatorPath:join(runtime,'resources.sqlite')}};
    if(!await exists(join(project.stateDir,'state.sqlite'))) project.identity=initProject({stateDir:project.stateDir,root:project.root,name:`Fictional ${project.stack} qualification`,config,supervisor:'systemd'});
    const store=new Store(project.stateDir);const current={store};active.push(current);
    project.identity=store.meta('project');save();
    const invoke=(operation,payload)=>{const receipt=executeCommand(store,{protocolVersion:1,projectId:project.identity.projectId,commandId:randomUUID(),operation,payload,actor:'operator'});assert.equal(receipt.status,'completed',receipt.error);return receipt;};
    if(!project.commissioned) { const result=await commission.doctor(project.stateDir);assert.equal(result.ready,true,`Doctor failed: ${result.reasons.join('; ')}`);project.commissioned=true;save(); }
    const taskId=`github:${project.issue}`;
    if(!store.get('task',taskId)) await commission.importGitHubTask(project.stateDir,project.issue);
    let task=store.need('task',taskId);
    if(manifest.profile==='advanced'&&project.stack==='python'&&!store.get('flow','qualification-1')&&task.risk!=='strict'){invoke('task.put',{task:{...task,risk:'strict'}});task=store.need('task',taskId);}
    if(!store.get('flow','qualification-1')) {invoke('task.approve',{taskId,revision:task.revision});invoke('flow.start',{taskId,revision:task.revision,flowId:'qualification-1'});}
    current.service=await startProjectService({stateDir:project.stateDir,socketPath:join(project.stateDir,'project.sock'),run:false});
    const engine=new Engine(store),deadline=Date.now()+20*60_000;
    while(Date.now()<deadline) {
      let flow=store.need('flow','qualification-1');
      const delivery=flow.delivery||{};
      const prNumber=flow.results?.publish?.number || delivery.pr?.number || delivery.prNumber || flow.pr?.number;
      if(prNumber && !project.pr) {
        project.pr={number:prNumber,url:`${project.url}/pull/${prNumber}`};save();
        log('pull-request.needs-link',{stack:project.stack,url:project.pr.url,ackPath:join(runtime,`${project.stack}.pr-linked`)});
      }
      // The supervising T3 agent links the PR immediately, then acknowledges via this private file.
      if(project.pr && !project.prLinked) {if(!await exists(join(runtime,`${project.stack}.pr-linked`))){await delay(100);continue;}project.prLinked=true;save();}
      if(manifest.inject && project.stack==='web' && !project.mutation && flow.step==='review' && !flow.attemptId) {
        const owned=flow.workspace||delivery.workspace;assert(owned?.path,'Workspace required for controlled qualification mutation');
        const file=join(owned.path,'src','tasks.js');const source=await readFile(file,'utf8');
        const mutated=source.replace('completed: task.completed === true','completed: false');
        assert.notEqual(mutated,source,'Seeded mutation location changed; inspect before continuing');
        const {writeFile}=await import('node:fs/promises');await writeFile(file,mutated);
        const committed=await workspace.commit({workspace:owned,message:'Controlled qualification mutation: discard completion when loading'});await workspace.push({workspace:owned,expectedHead:committed.head});
        store.tx(()=>{store.event('qualification.mutation',{flowId:flow.id,origin:'controlled-fault-injection',head:committed.head,description:'Discard completion state on load to exercise independent review and persistent correction'});});
        project.mutation={head:committed.head,origin:'controlled-fault-injection'};save();
      }
      await engine.tick();flow=store.need('flow','qualification-1');
      const question=store.all('inbox').find(item=>item.flowId===flow.id&&item.kind==='question'&&item.status==='open');
      if(question) {
        assert.equal(flow.step,'decide',`Unexpected operator blocker: ${question.question||question.text}`);
        assert(Object.hasOwn(flow.workflow.nodes.decide.answers,'merge'),'Merge answer not available');
        invoke('answer',{inboxId:question.id,version:question.version,subjectDigest:question.subjectDigest,answer:'merge',...(question.strictReview?{reviewedHead:question.strictReview.head}:{})});
      }
      assert(!['failed','stopped'].includes(flow.state),`Flow ${flow.state}: ${flow.stopReason||'inspect retained evidence'}`);
      if(flow.state==='completed') {
        const remote=await request({path:`repos/${project.slug}/pulls/${project.pr.number}`});assert.equal(remote.merged,true,'Remote PR must be merged');
        command(['git','fetch','origin','main'],project.root);command(['git','checkout','main'],project.root);command(['git','merge','--ff-only','origin/main'],project.root);
        assert.equal(command(project.scenario.check.argv,project.root).exitCode,0);
        if(project.mutation) {
          const reviews=[],builds=[];
          for(const attempt of store.all('attempt')) {
            const path=join(project.stateDir,'attempts',attempt.id,'action-result.json');
            if(!await exists(path)) continue;
            const result=JSON.parse(await readFile(path,'utf8'));
            if(attempt.step==='review') reviews.push(result);
            if(attempt.step==='build') builds.push(result);
          }
          assert(reviews.some(result=>result.result?.verdict==='revise'),'Seeded defect must be found by independent review');
          assert(builds.length>=2,'Seeded defect must lead to a builder correction');
          assert(builds[0].sessionId && builds.every(result=>result.sessionId===builds[0].sessionId),'Builder corrections must resume the original session');
          project.mutation.reviewDetected=true;project.mutation.persistentCorrection=true;
        }
        project.passed=true;project.status='passed';project.completedAt=new Date().toISOString();save();
        log('qualification.passed',{stack:project.stack,url:project.pr.url,runtimeDir:runtime,controlledMutation:!!project.mutation,manualMerge:true});break;
      }
      await delay(150);
    }
    assert(project.passed,'Live qualification timed out; preserve existing attempts and resume same runtime');
    await current.service.close();current.service=null;store.close();active.splice(active.indexOf(current),1);
  }
}
function delay(ms){return new Promise(resolveDelay=>setTimeout(resolveDelay,ms));}
