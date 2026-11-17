import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildRelease,readRelease,prepareAdoption,adoptionStatus,adoptionPlan,cleanupAdoption} from '../starter/factory/distribution.mjs';
const cli=join(process.cwd(),'starter/factory/cli.mjs');
const git=(root,args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function put(root,path,bytes){mkdirSync(join(root,path,'..'),{recursive:true});writeFileSync(join(root,path),bytes);}
function commit(root){git(root,['add','.']);git(root,['commit','-qm','Fictional adoption checkpoint']);}
function repository(root){mkdirSync(root,{recursive:true});git(root,['init','-qb','main']);git(root,['config','user.email','fictional@example.invalid']);git(root,['config','user.name','Fictional Maintainer']);git(root,['config','commit.gpgsign','false']);}
function fixture(t){const base=mkdtempSync(join(tmpdir(),'factotum-distribution-'));t.after(()=>rmSync(base,{recursive:true,force:true}));const source=join(base,'reference/starter'),root=join(base,'app');repository(join(base,'reference'));put(source,'factory/cli.mjs','console.log("fictional executor one");\n');put(source,'factory/old.mjs','export const old=true;\n');put(source,'project/GOVERNANCE.md','Template governance\n');put(source,'VERSION','development\n');put(source,'compatibility.json',JSON.stringify({schemaVersion:1,configVersion:1,projectProtocolVersion:1}));commit(join(base,'reference'));repository(root);put(root,'app.txt','Existing application\n');commit(root);const releaseDir=join(base,'release-one'),release=buildRelease({sourceDir:source,outputDir:releaseDir,version:'1.0.0'});const options={root,releaseDir,expectedDigest:release.manifestDigest,branch:'chore/install',worktreeDir:join(base,'install'),initial:true};return {base,source,root,releaseDir,release,options};}
function install(f){const result=prepareAdoption(f.options);commit(result.worktree);git(f.root,['merge','--ff-only',result.branch]);return result;}
function next(f){put(f.source,'factory/cli.mjs','console.log("fictional executor two");\n');rmSync(join(f.source,'factory/old.mjs'));put(f.source,'factory/new.mjs','export const next=true;\n');chmodSync(join(f.source,'factory/new.mjs'),0o755);put(f.source,'project/GOVERNANCE.md','Upstream revised template\n');put(f.source,'project/new-template.json','{}\n');commit(join(f.base,'reference'));const releaseDir=join(f.base,'release-two'),release=buildRelease({sourceDir:f.source,outputDir:releaseDir,version:'1.1.0'});return {root:f.root,releaseDir,expectedDigest:release.manifestDigest,branch:'chore/update',worktreeDir:join(f.base,'update')};}
function command(args){const result=spawnSync(process.execPath,[cli,...args],{encoding:'utf8'});assert.equal(result.status,0,result.stderr||result.stdout);return JSON.parse(result.stdout);}

test('real CLI installs and updates on isolated review branches, preserving the live checkout and project customizations',t=>{
 const f=fixture(t);const installed=command(['adopt','install','--root',f.root,'--release',f.releaseDir,'--digest',f.release.manifestDigest,'--branch','chore/install','--worktree',f.options.worktreeDir]);
 assert.equal(existsSync(join(f.root,'factory')),false);commit(installed.worktree);git(f.root,['merge','--ff-only',installed.branch]);
 put(f.root,'project/GOVERNANCE.md','Real project rules\n');put(f.root,'project/adapters/release.mjs','export const projectOwned=true;\n');put(f.root,'private-config.example.json','{"project":"fictional"}\n');commit(f.root);
 const update=next(f),plan=command(['adopt','plan','--root',f.root,'--release',update.releaseDir,'--digest',update.expectedDigest]);assert.equal(plan.ok,true);assert.ok(plan.changes.some(c=>c.kind==='remove'&&c.path==='factory/old.mjs'));assert.ok(!plan.changes.some(c=>c.path.startsWith('project/')));
 const result=command(['adopt','update','--root',f.root,'--release',update.releaseDir,'--digest',update.expectedDigest,'--branch',update.branch,'--worktree',update.worktreeDir]);
 assert.match(readFileSync(join(f.root,'factory/cli.mjs'),'utf8'),/one/);assert.equal(JSON.parse(readFileSync(join(f.root,'factotum.lock.json'))).release.version,'1.0.0');assert.equal(git(f.root,['status','--porcelain']),'');
 assert.match(readFileSync(join(result.worktree,'factory/cli.mjs'),'utf8'),/two/);assert.equal(existsSync(join(result.worktree,'factory/old.mjs')),false);assert.equal(existsSync(join(result.worktree,'project/new-template.json')),false);assert.equal(readFileSync(join(result.worktree,'project/GOVERNANCE.md'),'utf8'),'Real project rules\n');assert.match(readFileSync(join(result.worktree,'project/adapters/release.mjs'),'utf8'),/projectOwned/);assert.equal(readFileSync(join(result.worktree,'app.txt'),'utf8'),'Existing application\n');
 assert.equal(command(['adopt','status','--root',result.worktree]).clean,true);assert.equal(result.activation.startsWith('not activated'),true);assert.equal(git(result.worktree,['rev-parse','HEAD']),result.baseHead);
 commit(result.worktree);git(f.root,['merge','--ff-only',result.branch]);assert.equal(adoptionStatus({root:f.root}).version,'1.1.0');
});
test('local core changes, missing files, mode edits and unexpected core files prevent updates before branch creation',t=>{
 for(const mutation of ['edit','remove','mode','extra']){const f=fixture(t);install(f);const update=next(f);if(mutation==='edit')put(f.root,'factory/cli.mjs','Local core patch\n');if(mutation==='remove')rmSync(join(f.root,'factory/cli.mjs'));if(mutation==='mode')chmodSync(join(f.root,'factory/cli.mjs'),0o755);if(mutation==='extra')put(f.root,'factory/custom.mjs','Keep my custom code\n');commit(f.root);const plan=adoptionPlan(update);assert.equal(plan.ok,false,mutation);assert.throws(()=>prepareAdoption(update),/adoption conflicts/);assert.equal(existsSync(update.worktreeDir),false);assert.throws(()=>git(f.root,['rev-parse','--verify','refs/heads/'+update.branch]));}
});
test('release payload tampering, unexpected files and incorrect trusted digests are rejected',t=>{
 const f=fixture(t);assert.throws(()=>readRelease(f.releaseDir,'0'.repeat(64)),/manifest checksum/);put(join(f.releaseDir,'starter'),'factory/cli.mjs','tampered\n');assert.throws(()=>prepareAdoption(f.options),/payload changed/);assert.equal(existsSync(f.options.worktreeDir),false);
 const g=fixture(t);put(join(g.releaseDir,'starter'),'factory/unlisted.mjs','unlisted');assert.throws(()=>readRelease(g.releaseDir,g.release.manifestDigest),/extra files/);
});
test('traversal and malformed ownership remain rejected even with a matching manifest digest',t=>{
 for(const path of ['../escape','factory/../escape','factory/.git/config','/absolute','factory\\escape']){const f=fixture(t),manifestPath=join(f.releaseDir,'release.json'),m=JSON.parse(readFileSync(manifestPath));m.files[0].path=path;const bytes=JSON.stringify(m);writeFileSync(manifestPath,bytes);assert.throws(()=>readRelease(f.releaseDir,createHash('sha256').update(bytes).digest('hex')),/path/);}
 const f=fixture(t),manifestPath=join(f.releaseDir,'release.json'),m=JSON.parse(readFileSync(manifestPath));m.files[0].owner='template';const bytes=JSON.stringify(m);writeFileSync(manifestPath,bytes);assert.throws(()=>readRelease(f.releaseDir,createHash('sha256').update(bytes).digest('hex')),/ownership/);
});
test('install refuses existing project files, symlinks, dirty roots and existing review branches',t=>{
 const f=fixture(t);put(f.root,'VERSION','Application version must survive\n');commit(f.root);assert.throws(()=>prepareAdoption(f.options),/overwrite existing project file/);assert.equal(readFileSync(join(f.root,'VERSION'),'utf8'),'Application version must survive\n');
 const g=fixture(t);put(g.root,'uncommitted.txt','Preserve');assert.throws(()=>prepareAdoption(g.options),/existing work/);assert.equal(existsSync(g.options.worktreeDir),false);
 const h=fixture(t);symlinkSync(h.source,join(h.base,'linked-source'));assert.throws(()=>buildRelease({sourceDir:join(h.base,'linked-source'),outputDir:join(h.base,'bad'),version:'2'}),/symlink/);symlinkSync(h.base,join(h.root,'project'));commit(h.root);assert.throws(()=>prepareAdoption(h.options),/symlink/);
 const i=fixture(t);git(i.root,['branch',i.options.branch]);assert.throws(()=>prepareAdoption(i.options));assert.equal(existsSync(i.options.worktreeDir),false);
});
test('release provenance uses exact committed bytes and marks modified or ignored source files as development artifacts',t=>{
 const f=fixture(t);assert.equal(f.release.sourceState,'clean-commit');assert.equal(f.release.sourceCommit,git(join(f.base,'reference'),['rev-parse','HEAD']));
 git(join(f.base,'reference'),['update-index','--assume-unchanged','starter/factory/cli.mjs']);put(f.source,'factory/cli.mjs','Hidden modification\n');assert.throws(()=>buildRelease({sourceDir:f.source,outputDir:join(f.base,'refused'),version:'dev.1'}),/committed starter/);const dirty=buildRelease({sourceDir:f.source,outputDir:join(f.base,'dirty'),version:'dev.1',allowWorkingTree:true});assert.equal(dirty.sourceCommit,null);assert.equal(dirty.sourceState,'working-tree');
 const g=fixture(t);put(join(g.base,'reference'),'.gitignore','starter/factory/ignored.mjs\n');commit(join(g.base,'reference'));put(g.source,'factory/ignored.mjs','Ignored extra\n');assert.equal(buildRelease({sourceDir:g.source,outputDir:join(g.base,'ignored'),version:'dev.2',allowWorkingTree:true}).sourceCommit,null);
});
test('release builder refuses in-place output and symlink contents, verifies executable modes and never edits source version',t=>{
 const f=fixture(t);assert.equal(readFileSync(join(f.source,'VERSION'),'utf8'),'development\n');assert.throws(()=>buildRelease({sourceDir:f.source,outputDir:join(f.source,'nested'),version:'bad'}),/separate/);symlinkSync(join(f.source,'VERSION'),join(f.source,'factory/link'));assert.throws(()=>buildRelease({sourceDir:f.source,outputDir:join(f.base,'bad'),version:'bad'}),/symlink/);assert.equal(existsSync(join(f.base,'bad')),false);
});

test('same-version mutation is refused and an identical release is an explicit no-op',t=>{
 const f=fixture(t);install(f);assert.throws(()=>prepareAdoption({...f.options,initial:false,branch:'chore/noop',worktreeDir:join(f.base,'noop')}),/already adopted/);
 put(f.source,'factory/cli.mjs','Changed release with reused name\n');const output=join(f.base,'reused'),other=buildRelease({sourceDir:f.source,outputDir:output,version:'1.0.0',allowWorkingTree:true});assert.throws(()=>adoptionPlan({root:f.root,releaseDir:output,expectedDigest:other.manifestDigest}),/version reused/);
});
test('a complete generated release works with existing immutable staging, activation and launcher verification',async t=>{
 const {sandbox}=await import('./helpers.mjs');const {stageUpgrade,finishUpgrade,resolveInstallation}=await import('../starter/factory/operations/upgrades.mjs');const f=sandbox(t),out=join(f.base,'full-release'),built=command(['release','build','--source',join(process.cwd(),'starter'),'--out',out,'--version','0.2.0-test','--development']),release=readRelease(out,built.manifestDigest),installRoot=join(f.base,'installed');
 const compatibility=JSON.parse(readFileSync(join(release.payload,'compatibility.json')));stageUpgrade(f.store,{sourceDir:release.payload,installRoot,version:built.version,compatibility});assert.equal(existsSync(join(installRoot,'current.json')),false);
 finishUpgrade(f.store,{version:built.version,verify:cwd=>{execFileSync(process.execPath,['factory/cli.mjs'],{cwd,stdio:'pipe'});return true;}});const selected=resolveInstallation(f.store,installRoot);assert.equal(selected.version,built.version);assert.match(execFileSync(process.execPath,[selected.entry],{encoding:'utf8'}),/adopt install/);
});

test('explicit project checkout wins over ambient Git repository and index routing',t=>{
 const f=fixture(t),foreign=join(f.base,'foreign');repository(foreign);put(foreign,'foreign.txt','Untouched');commit(foreign);const keys=['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE'],prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let result;
 try{process.env.GIT_DIR=join(foreign,'.git');process.env.GIT_WORK_TREE=foreign;process.env.GIT_INDEX_FILE=join(f.base,'foreign-index');result=prepareAdoption(f.options);}
 finally{for(const key of keys)if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}
 assert.equal(existsSync(join(result.worktree,'factotum.lock.json')),true);assert.equal(git(foreign,['status','--porcelain']),'');assert.equal(existsSync(join(foreign,'factory')),false);assert.equal(existsSync(join(f.base,'foreign-index')),false);
});

test('adopt cleanup removes only a merged, clean review worktree and its branch',t=>{
 const f=fixture(t),prepared=prepareAdoption(f.options);
 put(prepared.worktree,'factory/scratch.txt','unsaved\n');
 assert.throws(()=>cleanupAdoption({root:f.root,branch:prepared.branch,worktreeDir:prepared.worktree}),/uncommitted or untracked/);
 rmSync(join(prepared.worktree,'factory/scratch.txt'));commit(prepared.worktree);
 assert.throws(()=>cleanupAdoption({root:f.root,branch:prepared.branch,worktreeDir:prepared.worktree}),/not merged/);
 assert.throws(()=>cleanupAdoption({root:f.root,branch:'main',worktreeDir:prepared.worktree}),/not on the named branch/);
 git(f.root,['merge','--ff-only',prepared.branch]);
 const removed=command(['adopt','cleanup','--root',f.root,'--branch',prepared.branch,'--worktree',prepared.worktree]);
 assert.equal(removed.removedBranch,prepared.branch);assert.equal(existsSync(prepared.worktree),false);
 assert.equal(git(f.root,['branch','--list',prepared.branch]),'');assert.equal(adoptionStatus({root:f.root}).clean,true);
});

test('adopt cleanup accepts a review branch that was squash-merged',t=>{
 const f=fixture(t),prepared=prepareAdoption(f.options);commit(prepared.worktree);
 git(f.root,['merge','--squash',prepared.branch]);git(f.root,['-c','user.email=f@example.invalid','-c','user.name=F','commit','-qm','Squash adoption']);
 const removed=cleanupAdoption({root:f.root,branch:prepared.branch,worktreeDir:prepared.worktree});
 assert.equal(removed.removedBranch,prepared.branch);assert.equal(existsSync(prepared.worktree),false);assert.equal(git(f.root,['branch','--list',prepared.branch]),'');
});
test('the release payload carries the Apache-2.0 license as an upstream-managed file identical to the repository LICENSE',t=>{
 const base=mkdtempSync(join(tmpdir(),'factotum-license-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const repo=join(process.cwd()),license=readFileSync(join(repo,'LICENSE'));
 assert.match(license.toString('utf8'),/Apache License\s+Version 2\.0, January 2004/);assert.equal(JSON.parse(readFileSync(join(repo,'package.json'),'utf8')).license,'Apache-2.0');
 const out=join(base,'release'),built=buildRelease({sourceDir:join(repo,'starter'),outputDir:out,version:'9.9.9-license',allowWorkingTree:true});
 const {manifest}=readRelease(out,built.manifestDigest),entry=manifest.files.find(file=>file.path==='factory/LICENSE');
 assert.ok(entry,'factory/LICENSE is in the release manifest');assert.equal(entry.owner,'managed','an adopter installs it with factory/, not at its own repository root');
 assert.deepEqual(readFileSync(join(out,'starter/factory/LICENSE')),license,'the shipped license is the repository LICENSE, byte for byte');
});
