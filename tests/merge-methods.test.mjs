import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub, ForgeError } from '../starter/factory/adapters/github/index.mjs';
import { git, prepare, inspect, commit, release, archiveAndRelease } from '../starter/factory/adapters/workspace/index.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
const H='a'.repeat(40),B='b'.repeat(40);

test('GitHub sends configured merge, squash and rebase methods with the exact reviewed SHA',async()=>{
  for(const method of ['merge','squash','rebase']){
    let body;
    const forge=createGitHub({repository:'fictional/demo',transport:async request=>{
      if(request.path.includes('/commits?'))return[{sha:H,commit:{message:'Safe candidate'}}];
      if(request.path.includes('/protection'))throw new ForgeError('not configured',{status:404});
      if(request.method==='PUT'){body=request.body;return{merged:true,sha:'c'.repeat(40)};}
      return{number:1,state:'open',head:{sha:H,ref:'feature'},base:{sha:B,ref:'main'},merged:false,commits:1};
    }});
    const result=await forge.merge({number:1,expectedHead:H,expectedBase:B,mergeMethod:method,commitTitle:'Reviewed delivery',commitMessage:'Qualified evidence'});
    assert.equal(result.merged,true);assert.equal(body.merge_method,method);assert.equal(body.sha,H);
    assert.equal(body.commit_title,method==='rebase'?undefined:'Reviewed delivery');
  }
  const forge=createGitHub({repository:'fictional/demo',transport:async()=>{throw Error('invalid method must not call GitHub');}});
  await assert.rejects(forge.merge({number:1,expectedHead:H,expectedBase:B,mergeMethod:'unexpected'}),/invalid merge method/);
});

test('repository merge method is validated and conservative default remains merge',async()=>{
  const template=JSON.parse(await readFile(new URL('../starter/project/factotum.template.json',import.meta.url),'utf8'));
  for(const mergeMethod of ['merge','squash','rebase'])assert.equal(validateConfig({...structuredClone(template),repository:{...template.repository,mergeMethod}}).repository.mergeMethod,mergeMethod);
  assert.throws(()=>validateConfig({...structuredClone(template),repository:{...template.repository,mergeMethod:'unexpected'}}),/merge method/);
});
async function fixture(t){
  const directory=await mkdtemp(join(tmpdir(),'factotum-merge-method-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const root=join(directory,'repo'),remote=join(directory,'remote.git'),stateDir=join(directory,'state');await mkdir(root);
  await git(root,['init','-b','main']);await git(root,['config','user.name','Fictional Developer']);await git(root,['config','user.email','developer@example.invalid']);await writeFile(join(root,'base.txt'),'Baseline\n');await git(root,['add','.']);await git(root,['commit','-m','Baseline']);await git(root,['init','--bare',remote]);await git(root,['remote','add','origin',remote]);await git(root,['push','-u','origin','main']);
  const workspace=await prepare({root,stateDir,projectId:'fictional',flowId:'reviewed',baseRef:'main'});await writeFile(join(workspace.path,'feature.txt'),'Reviewed candidate\n');const candidate=await commit({workspace,message:'Original reviewed candidate'});
  return{directory,root,remote,stateDir,workspace,head:candidate.head,archiveDir:join(stateDir,'archives','workspace-commits')};
}
for(const method of ['squash','rebase'])test(`${method} target cleanup preserves exact original head in a durable independently recoverable bundle`,async t=>{
  const f=await fixture(t);
  if(method==='squash'){await git(f.root,['merge','--squash',f.workspace.branch]);await git(f.root,['commit','-m','Squashed delivery']);}
  else{
    await writeFile(join(f.root,'target.txt'),'Target advanced\n');await git(f.root,['add','.']);await git(f.root,['commit','-m','Independent target change']);
    await git(f.root,['switch','-c','replayed',f.workspace.branch]);await git(f.root,['rebase','main']);await git(f.root,['switch','main']);await git(f.root,['merge','--ff-only','replayed']);
  }
  await git(f.root,['push','origin','main']);
  assert.notEqual((await git(f.root,['rev-parse','origin/main'])).stdout,f.head);
  assert.equal((await git(f.root,['merge-base','--is-ancestor',f.head,'origin/main'],{allowFailure:true})).code,1);
  await assert.rejects(release({workspace:f.workspace,preservation:{mergedInto:'origin/main'},dryRun:false}),/verified merge or durable archive/);
  const identity=repositoryIdentity(f.workspace.path);
  const result=await runAction({projectRoot:f.root,cwd:f.workspace.path,timeoutMs:30000,action:{operation:'workspace.release',stateDir:f.stateDir,projectId:'fictional',flowId:'reviewed',workspace:f.workspace,task:{id:'task',title:'Reviewed feature',acceptance:['Retain reviewed outcome']},context:{files:[]},config:{repository:{slug:'fictional/demo',account:'fictional',target:'main',mergeMethod:method}},results:{merge:{merged:true,mergeMethod:method,expectedHead:f.head}},mergeAuthorization:{identity}}});assert.equal(result.route,'released');assert.equal(result.released,true);assert.equal(result.archive.head,f.head);assert.equal((await inspect({workspace:f.workspace})).released,true);
  assert.notEqual((await git(f.root,['show-ref','--verify',`refs/heads/${f.workspace.branch}`],{allowFailure:true})).code,0);
  const recovered=join(f.directory,'recovered');await git(f.root,['clone','--branch',f.workspace.branch,result.archive.archivePath,recovered]);assert.equal((await git(recovered,['rev-parse','HEAD'])).stdout,f.head);assert.equal(await readFile(join(recovered,'feature.txt'),'utf8'),'Reviewed candidate\n');
  const repeated=await archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:f.head});assert.equal(repeated.reconciled,true);assert.equal(repeated.archive.archiveDigest,result.archive.archiveDigest);
});

test('changed archive or wrong expected head cannot remove the owned checkout',async t=>{
  const f=await fixture(t);await assert.rejects(archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:'f'.repeat(40)}),/exact clean quiescent/);
  const preserved=await archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:f.head,dryRun:true});assert.equal(preserved.released,false);
  await writeFile(preserved.archive.archivePath,'corrupted archive');await assert.rejects(archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:f.head}),/recorded workspace archive changed/);assert.equal((await inspect({workspace:f.workspace})).released,undefined);
});

test('archive cleanup reconciles removal interrupted before the owned branch was deleted',async t=>{
  const f=await fixture(t),preserved=await archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:f.head,dryRun:true});
  const manifest=JSON.parse(await readFile(f.workspace.manifestPath,'utf8'));manifest.status='releasing';manifest.cleanup={head:f.head,branch:f.workspace.branch,ownershipDigest:f.workspace.ownershipDigest,preservation:{archivePath:preserved.archive.archivePath}};await writeFile(f.workspace.manifestPath,JSON.stringify(manifest));await git(f.root,['worktree','remove',f.workspace.path]);
  const recovered=await archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:f.head});assert.equal(recovered.reconciled,true);assert.equal(recovered.released,true);assert.equal(recovered.archive.archiveDigest,preserved.archive.archiveDigest);assert.notEqual((await git(f.root,['show-ref','--verify',`refs/heads/${f.workspace.branch}`],{allowFailure:true})).code,0);
});

test('bundle durability failure prevents branch deletion and verified retry completes cleanup',async t=>{
  const f=await fixture(t),fs=await import('node:fs/promises'),{readlinkSync}=await import('node:fs');
  const probe=await fs.open(join(f.directory,'probe'),'w'),prototype=Object.getPrototypeOf(probe),original=prototype.sync;await probe.close();
  let barrier=false;prototype.sync=async function(){if(readlinkSync(`/proc/self/fd/${this.fd}`).endsWith('.bundle')){barrier=true;throw Error('simulated bundle durability failure');}return original.call(this);};
  try{await assert.rejects(archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:f.head}),/durability failure/);}finally{prototype.sync=original;}
  assert.equal(barrier,true);assert.equal((await inspect({workspace:f.workspace})).head,f.head);assert.equal((await git(f.root,['rev-parse',`refs/heads/${f.workspace.branch}`])).stdout,f.head);
  const result=await archiveAndRelease({workspace:f.workspace,archiveDir:f.archiveDir,expectedHead:f.head});assert.equal(result.released,true);assert.equal((await inspect({workspace:f.workspace})).released,true);
});
