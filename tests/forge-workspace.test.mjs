import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub, createGhTransport, ForgeError, runGh, assertNoClosingReferences } from '../starter/factory/adapters/github/index.mjs';
import { git, prepare, inspect, commit, integrateTarget, push, release, adoptCandidate } from '../starter/factory/adapters/workspace/index.mjs';

const H = 'a'.repeat(40), B = 'b'.repeat(40);
const rawPR = () => ({ number: 1, state: 'open', head: {sha:H,ref:'topic'}, base:{sha:B,ref:'main'}, merged:false,commits:1 });
const protection = { required_status_checks:{strict:true,contexts:['factotum/gate']},enforce_admins:{enabled:true} };

test('closing references cannot escape canonical source issue disposition', async () => {
  for(const text of ['Fixes #2','close fictional/other#3','Resolved https://github.com/fictional/demo/issues/4','Closes [#5](https://github.com/fictional/demo/issues/5)']) assert.throws(()=>assertNoClosingReferences(text),/closing references/);
  assert.doesNotThrow(()=>assertNoClosingReferences('Task: #2','Fixes the formatting of displayed titles'));
  let requests=0;
  const forge=createGitHub({repository:'fictional/demo',transport:async()=>{requests++;return[];}});
  assert.throws(()=>forge.createPR({branch:'topic',base:'main',title:'Fixes #2',body:'Task',operationId:'unsafe'}),/closing references/);assert.equal(requests,0);
});

test('merge rejects closing references hidden in existing candidate commit messages',async()=>{
  let merged=false;
  const forge=createGitHub({repository:'fictional/demo',transport:async request=>{
    if(request.path.includes('/commits?')) return [{sha:H,commit:{message:'Feature\n\nCloses fictional/other#9'}}];
    if(request.method==='PUT')merged=true;
    return rawPR();
  }});
  await assert.rejects(forge.merge({number:1,expectedHead:H,expectedBase:B}),/closing references/);assert.equal(merged,false);
});

test('GitHub credentials are account pinned and ambient tokens are removed', async () => {
  const original = process.env.GH_TOKEN; process.env.GH_TOKEN = 'ambient-fake';
  try {
    const calls = [];
    const transport = createGhTransport({account:'fictional',run:async (args, options) => { calls.push({args,options}); return args[0] === 'auth' ? 'selected-fake\n' : '{"ok":true}'; }});
    assert.deepEqual(await transport({path:'user'}),{ok:true});
    assert.deepEqual(calls[0].args,['auth','token','--hostname','github.com','--user','fictional']);
    assert.equal(calls[0].options.env.GH_TOKEN,undefined);
    assert.equal(calls[1].options.env.GH_TOKEN,'selected-fake');
    assert.ok(!calls[1].args.includes('selected-fake'));
  } finally { if (original === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = original; }
});

test('CLI failures distinguish rate limits and authorization without echoing private stderr', async t => {
  const directory=await mkdtemp(join(tmpdir(),'factotum-gh-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,'gh');await writeFile(executable,`#!${process.execPath}\nprocess.stderr.write(process.env.FAKE_ERROR);process.exit(1);\n`);await chmod(executable,0o700);
  for(const [message,kind] of [['HTTP 403: API rate limit exceeded fake-secret','rate-limit'],['HTTP 401 fake-secret','authorization'],['HTTP 403 access denied fake-secret','authorization'],['HTTP 503 fake-secret','transport']]) {
    await assert.rejects(runGh(['api','user'],{env:{...process.env,PATH:directory,FAKE_ERROR:message}}),error=>error.kind===kind&&!error.message.includes('fake-secret'));
  }
});

test('ambiguous publication reconciles stable marker and never duplicates', async () => {
  const comments = []; let posts = 0;
  const forge = createGitHub({repository:'fictional/demo',transport:async request => {
    if(request.method === 'GET') return comments;
    posts++; comments.push({id:7,body:request.body.body}); throw new ForgeError('lost response',{ambiguous:true});
  }});
  assert.equal((await forge.publishPlan({issue:1,operationId:'plan-1',body:'a plan'})).id,7);
  assert.equal((await forge.publishPlan({issue:1,operationId:'plan-1',body:'a plan'})).reconciled,true);
  assert.equal(posts,1);
  await assert.rejects(forge.publishPlan({issue:1,operationId:'plan-1',body:'changed plan'}),/different publication input/);
});

test('PR publication lost response and merge lost response reconcile original resources', async () => {
  const prs=[]; let merged=false, merges=0, posts=0;
  // A lost response is reconciled through the lookup; the pull request found is the factory's own
  // (opened by its account from its repository), so it is adopted (knowledge upkeep, review of e73ae9e).
  const forge=createGitHub({repository:'fictional/demo',account:'fictional',transport:async request=>{
    if(request.path.includes('/commits?')) return [{sha:H,commit:{message:'Safe candidate'}}];
    if(request.path.includes('/protection')) throw new ForgeError('no protection',{status:404,kind:'not-found'});
    if(request.path.includes('/pulls?')) return prs;
    if(request.method==='POST'){ posts++; prs.push({number:1,body:request.body.body,user:{login:'fictional'},head:{repo:{full_name:'fictional/demo'}}}); throw new ForgeError('lost',{ambiguous:true}); }
    if(request.method==='PUT'){ merges++; merged=true; throw new ForgeError('lost',{ambiguous:true}); }
    return {...rawPR(),merged,merge_commit_sha:'c'.repeat(40)};
  }});
  const input={branch:'topic',base:'main',title:'Feature',body:'A feature',operationId:'pr-1'};
  assert.equal((await forge.createPR(input)).number,1);await forge.createPR(input);assert.equal(posts,1);
  const result=await forge.merge({number:1,expectedHead:H,expectedBase:B});assert.equal(result.reconciled,true);assert.equal(merges,1);
  await forge.merge({number:1,expectedHead:H,expectedBase:B});assert.equal(merges,1);
});

test('automatic merge fails closed without qualified remote enforcement', async () => {
  let writes=0;
  const forge=createGitHub({repository:'fictional/demo',transport:async request => { if(request.path.includes('/commits?')) return [{sha:H,commit:{message:'Safe candidate'}}]; if(request.method==='PUT') writes++; return request.path.includes('/protection')?protection:rawPR(); }});
  await assert.rejects(forge.merge({number:1,expectedHead:H,expectedBase:B,mode:'auto',requiredContext:'factotum/gate'}),/qualified/);
  assert.equal(writes,0);
});

test('target advancing after last read is rejected by qualified remote strict checks', async () => {
  let writes=0;
  const forge=createGitHub({repository:'fictional/demo',qualification:{qualified:true,targetFreshness:'strict-status'},transport:async request => {
    if(request.path.includes('/commits?')) return [{sha:H,commit:{message:'Safe candidate'}}];
    if(request.path.includes('/protection')) return protection;
    if(request.method==='PUT'){ writes++; assert.equal(request.body.sha,H); throw new ForgeError('branch out of date',{status:405,kind:'conflict'}); }
    return rawPR();
  }});
  await assert.rejects(forge.merge({number:1,expectedHead:H,expectedBase:B,mode:'auto',requiredContext:'factotum/gate'}),/out of date/);
  assert.equal(writes,1);
});

test('GitHub task revision includes acceptance labels dependencies and never grants approval', async () => {
  let acceptance='first';
  const forge=createGitHub({repository:'fictional/demo',transport:async()=>({title:'Feature',state:'open',labels:[{name:'approved'}],body:'```factotum-task\n'+JSON.stringify({version:1,acceptance:[acceptance],dependencies:[2]})+'\n```'})});
  const before=await forge.readTask(1); acceptance='second';const after=await forge.readTask(1);
  assert.notEqual(before.revision,after.revision);assert.equal(after.approval,null);assert.equal(after.risk,'strict');
});

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'factotum-workspace-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'project'),remote=join(directory,'remote.git');await mkdir(root);
  await git(root,['init','-b','main']);await git(root,['config','user.name','Fictional Developer']);await git(root,['config','user.email','developer@example.invalid']);
  await writeFile(join(root,'file.txt'),'base\n');await git(root,['add','.']);await git(root,['commit','-m','initial']);
  await git(root,['init','--bare',remote]);await git(root,['remote','add','origin',remote]);await git(root,['push','-u','origin','main']);
  return {directory,root,stateDir:join(directory,'state')};
}

test('owned worktree restart, candidate commit, target integration, and preserved cleanup', async t => {
  const f=await fixture(t);const options={...f,projectId:'fictional',flowId:'flow-1',baseRef:'main'};
  const workspace=await prepare(options);assert.equal((await prepare(options)).path,workspace.path);
  await writeFile(join(workspace.path,'feature.txt'),'feature\n');const candidate=await commit({workspace,message:'feature'});assert.notEqual(candidate.head,workspace.base);
  await assert.rejects(release({workspace,dryRun:false}),/merge or durable archive/);
  assert.equal((await push({workspace,expectedHead:candidate.head})).head,candidate.head);
  assert.equal((await inspect({workspace})).unpushed,false);
  await assert.rejects(push({workspace,expectedHead:workspace.base}),/expected candidate/);
  await writeFile(join(f.root,'target.txt'),'target\n');await git(f.root,['add','.']);await git(f.root,['commit','-m','target advances']);await git(f.root,['push']);
  const integrated=await integrateTarget({workspace});assert.equal(integrated.conflicts,false);assert.notEqual(integrated.head,candidate.head);
  await git(f.root,['merge','--no-edit',workspace.branch]);
  assert.equal((await release({workspace,preservation:{mergedInto:'main'}})).dryRun,true);
  assert.equal((await release({workspace,preservation:{mergedInto:'main'},dryRun:false})).released,true);
  assert.equal((await release({workspace,dryRun:false})).reconciled,true);
  assert.equal((await inspect({workspace})).released,true);
});

test('workspace refuses dirty cleanup, outstanding obligations, and foreign ownership',async t=>{
  const f=await fixture(t),workspace=await prepare({...f,projectId:'fictional',flowId:'flow-2'});
  await writeFile(join(workspace.path,'dirty.txt'),'keep');
  await assert.rejects(release({workspace,preservation:{mergedInto:'main'},dryRun:false}),/dirty/);
  await rm(join(workspace.path,'dirty.txt'));
  await assert.rejects(release({workspace,preservation:{mergedInto:'main'},leases:['live']}),/obligations/);
  await assert.rejects(inspect({workspace:{...workspace,ownershipDigest:'foreign'}}),/ownership mismatch/);
});

test('interrupted cleanup removes only its recorded unchanged branch and never prepares again',async t=>{
  const f=await fixture(t),workspace=await prepare({...f,projectId:'fictional',flowId:'cleanup-crash'});
  const manifest=JSON.parse(await readFile(workspace.manifestPath,'utf8'));
  manifest.status='releasing';manifest.cleanup={head:workspace.head,branch:workspace.branch,ownershipDigest:workspace.ownershipDigest,preservation:{mergedInto:'main'}};
  await writeFile(workspace.manifestPath,JSON.stringify(manifest));await git(f.root,['worktree','remove',workspace.path]);
  await assert.rejects(prepare({...f,projectId:'fictional',flowId:'cleanup-crash'}),/cleanup workspace/);
  assert.equal((await release({workspace,dryRun:false})).reconciled,true);
  assert.equal((await inspect({workspace})).released,true);
});

test('conflicting target integration retains both versions for reconciliation',async t=>{
  const f=await fixture(t),workspace=await prepare({...f,projectId:'fictional',flowId:'conflict'});
  await writeFile(join(workspace.path,'file.txt'),'candidate\n');await commit({workspace,message:'candidate'});
  await writeFile(join(f.root,'file.txt'),'target\n');await git(f.root,['add','.']);await git(f.root,['commit','-m','target']);await git(f.root,['push']);
  const result=await integrateTarget({workspace});assert.equal(result.conflicts,true);assert.deepEqual(result.conflictedPaths,['file.txt']);
  assert.match(await readFile(join(workspace.path,'file.txt'),'utf8'),/<<<<<<< HEAD/);
  await assert.rejects(release({workspace,preservation:{mergedInto:'main'},dryRun:false}),/dirty/);
});

test('explicit PR adoption copies approved candidate to owned worktree without altering original branch',async t=>{
  const f=await fixture(t);const base=(await git(f.root,['rev-parse','HEAD'])).stdout;
  await git(f.root,['checkout','-b','original-candidate']);await writeFile(join(f.root,'candidate.txt'),'candidate\n');await git(f.root,['add','.']);await git(f.root,['commit','-m','Candidate']);
  const head=(await git(f.root,['rev-parse','HEAD'])).stdout;
  await git(f.root,['push','origin','HEAD:refs/pull/1/head']);await git(f.root,['checkout','main']);
  const pr={number:1,state:'open',draft:false,merged:false,head,base,baseRef:'main',url:'https://example.invalid/pull/1'};
  const options={...f,projectId:'fictional',flowId:'adopt-1',number:1,expectedHead:head,expectedBase:base,forge:{readPR:async()=>pr},target:'main'};
  await assert.rejects(adoptCandidate({...options,expectedBase:H}),/candidate or target changed/);
  const adopted=await adoptCandidate(options);assert.equal(adopted.workspace.base,head);assert.equal(adopted.originalPR.number,1);
  assert.equal((await git(f.root,['rev-parse','original-candidate'])).stdout,head);
  assert.equal((await git(f.root,['branch','--show-current'])).stdout,'main');
  assert.notEqual(adopted.workspace.branch,'original-candidate');
  assert.equal((await readFile(join(adopted.workspace.path,'candidate.txt'),'utf8')),'candidate\n');
});
