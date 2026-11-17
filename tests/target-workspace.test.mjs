import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { git, prepare, inspect } from '../starter/factory/adapters/workspace/index.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';

const exists=path=>access(path).then(()=>true,()=>false);
async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'factotum-target-workspace-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'root'),other=join(directory,'other'),remote=join(directory,'remote.git'),stateDir=join(directory,'state');await mkdir(root);
  await git(root,['init','-b','main']);await git(root,['config','user.name','Fictional Developer']);await git(root,['config','user.email','developer@example.invalid']);
  await writeFile(join(root,'app.txt'),'old main\n');await git(root,['add','.']);await git(root,['commit','-m','Initial']);const oldHead=repositoryIdentity(root).head;
  await git(root,['init','--bare',remote]);await git(root,['remote','add','origin',remote]);await git(root,['push','-u','origin','main']);
  await git(root,['clone','--branch','main',remote,other]);await git(other,['config','user.name','Fictional Other']);await git(other,['config','user.email','other@example.invalid']);
  await writeFile(join(other,'app.txt'),'current remote main\n');await git(other,['add','.']);await git(other,['commit','-m','Advance remote without moving operator checkout']);await git(other,['push']);const head=repositoryIdentity(other).head;
  const intent={projectRoot:root,cwd:root,inputIdentity:repositoryIdentity(root),timeoutMs:30_000,action:{operation:'source.verify',stateDir,projectId:'project-1',flowId:'flow-1',task:{id:'task-1',title:'Fictional change',acceptance:['Behavior works']},config:{repository:{slug:'fictional/demo',account:'fictional',target:'main',remote:'origin'},policy:{planning:true},workspace:{setup:[]}},mainHealth:{status:'green',head,checkedAt:new Date().toISOString()},context:{files:[]},results:{},sessions:{}}};
  return {directory,root,other,remote,stateDir,oldHead,head,intent};
}

test('fresh flow uses verified current remote target while operator checkout remains on old main',async t=>{
  const f=await fixture(t);const result=await runAction(f.intent);
  assert.equal(result.route,'ready');assert.equal(result.workspace.base,f.head);assert.equal(repositoryIdentity(result.workspace.path).head,f.head);
  assert.equal(await readFile(join(result.workspace.path,'app.txt'),'utf8'),'current remote main\n');
  assert.equal(repositoryIdentity(f.root).head,f.oldHead);assert.equal(await readFile(join(f.root,'app.txt'),'utf8'),'old main\n');
  assert.equal((await git(f.root,['branch','--show-current'])).stdout,'main');
});

test('target observation and fetched target disagreement parks before workspace creation',async t=>{
  const f=await fixture(t),bin=join(f.directory,'bin');await mkdir(bin);const realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();
  const script=join(bin,'git');await writeFile(script,`#!${process.execPath}\nconst cp=require('node:child_process');const args=process.argv.slice(2);if(args.includes('ls-remote'))process.stdout.write('${f.oldHead}\\trefs/heads/main\\n');else {const r=cp.spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(r.status??1);}\n`);await chmod(script,0o700);
  const previous=process.env.PATH;process.env.PATH=`${bin}:${previous}`;t.after(()=>{process.env.PATH=previous;});f.intent.action.mainHealth.head=f.oldHead;
  const held=await runAction(f.intent);assert.equal(held.route,'target-unverified');assert.equal(held.targetHealthHold.head,f.head);assert.equal(await exists(join(f.stateDir,'workspaces')),false);
  assert.equal(repositoryIdentity(f.root).head,f.oldHead);
});

test('stale green main identity refuses a new workspace before fetching or planning',async t=>{
  const f=await fixture(t);f.intent.action.mainHealth.head=f.oldHead;
  const held=await runAction(f.intent);assert.equal(held.route,'target-unverified');assert.equal(held.targetHealthHold.head,f.head);assert.equal(await exists(join(f.stateDir,'workspaces')),false);
});

test('PR adoption source path does not allocate an ordinary target workspace',async t=>{
  const f=await fixture(t);f.intent.action.candidate={number:1,head:'a'.repeat(40),base:f.head};
  const result=await runAction(f.intent);assert.equal(result.route,'candidate');assert.equal(result.workspace,undefined);assert.equal(await exists(join(f.stateDir,'workspaces')),false);
});

test('already-satisfied and planning flows receive their own verified target trees',async t=>{
  const f=await fixture(t);f.intent.action.completionMode='already-satisfied';
  const satisfied=await runAction(f.intent);assert.equal(satisfied.route,'satisfied');assert.equal(satisfied.workspace.base,f.head);
  const other=structuredClone(f.intent);other.action.flowId='planning-1';other.action.kind='planning';other.action.completionMode='merge';
  const planning=await runAction(other);assert.notEqual(planning.workspace.path,satisfied.workspace.path);assert.equal(planning.workspace.base,f.head);assert.equal(repositoryIdentity(f.root).head,f.oldHead);
});

test('reentry validates its existing owned tree and never substitutes another workspace',async t=>{
  const f=await fixture(t);const first=await runAction(f.intent);
  f.intent.action.workspace=first.workspace;f.intent.cwd=first.workspace.path;f.intent.inputIdentity=repositoryIdentity(first.workspace.path);
  const second=await runAction(f.intent);assert.equal(second.workspace.path,first.workspace.path);
  f.intent.action.workspace={...first.workspace,ownershipDigest:'foreign'};
  await assert.rejects(runAction(f.intent),/ownership mismatch/);
});
