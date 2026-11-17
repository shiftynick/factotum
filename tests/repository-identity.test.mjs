import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { sandbox } from './helpers.mjs';
import { repositoryIdentity, repositoryIdentityOffThread, repositoryProbe } from '../starter/factory/core/repository.mjs';

const git = (root, args) => execFileSync('git', args, {cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
function nestedWorktree(f) {
  const path='.claude/worktrees/agent-x';
  git(f.root,['worktree','add','--detach',path,'HEAD']);
  return join(f.root,path);
}

test('untracked linked worktrees are opaque directory entries with stable path/mode identity', t => {
  const f=sandbox(t), before=repositoryIdentity(f.root), nested=nestedWorktree(f);
  assert.ok(git(f.root,['ls-files','--others','--exclude-standard','-z']).split('\0').includes('.claude/worktrees/agent-x/'));
  const first=repositoryIdentity(f.root);assert.notEqual(first.treeDigest,before.treeDigest);assert.deepEqual(repositoryIdentity(f.root),first);
  writeFileSync(join(nested,'input.txt'),'unrelated agent edit');git(nested,['add','.']);git(nested,['commit','-qm','Agent commit']);
  writeFileSync(join(nested,'private-untracked.txt'),'not a parent input');
  assert.deepEqual(repositoryIdentity(f.root),first,'nested contents and HEAD are outside the parent Git file inventory');
  const mode=lstatSync(nested).mode & 0o777;chmodSync(nested,mode===0o700?0o755:0o700);
  assert.notEqual(repositoryIdentity(f.root).treeDigest,first.treeDigest,'directory mode is bound');
  git(f.root,['worktree','remove','--force',nested]);assert.deepEqual(repositoryIdentity(f.root),before);
});

test('ordinary embedded repositories need no nested HEAD and ignored worktrees remain outside the fingerprint', t => {
  const f=sandbox(t), initial=repositoryIdentity(f.root), nested=join(f.root,'nested');mkdirSync(nested);git(nested,['init','-q']);
  assert.doesNotThrow(()=>repositoryIdentity(f.root),'an unborn nested repository is supported');
  writeFileSync(join(f.root,'.git/info/exclude'),'nested/\n.claude/worktrees/\n');nestedWorktree(f);
  assert.deepEqual(repositoryIdentity(f.root),initial);
});

test('regular files retain their previous digest encoding and odd filenames parse without ambiguity', t => {
  const f=sandbox(t), content=new Map([['input.txt','fictional baseline\n'],['? prefix','untracked'],['H prefix','cached'],['tab\tnewline\n.txt','special name']]);
  for(const [path,bytes] of content)writeFileSync(join(f.root,path),bytes);
  git(f.root,['add','H prefix','tab\tnewline\n.txt']);
  const hash=createHash('sha256');
  for(const path of [...content.keys()].sort())hash.update(path+'\0'+lstatSync(join(f.root,path)).mode+'\0'+content.get(path)+'\0');
  assert.equal(repositoryIdentity(f.root).treeDigest,hash.digest('hex'));
  const before=repositoryIdentity(f.root);writeFileSync(join(f.root,'input.txt'),'changed');assert.notEqual(repositoryIdentity(f.root).treeDigest,before.treeDigest);
  const changed=repositoryIdentity(f.root);chmodSync(join(f.root,'input.txt'),0o755);assert.notEqual(repositoryIdentity(f.root).treeDigest,changed.treeDigest);
  rmSync(join(f.root,'input.txt'));assert.doesNotThrow(()=>repositoryIdentity(f.root),'tracked deletion is represented');
});

test('directory symlinks bind the link text without reading the target', t => {
  const f=sandbox(t), outside=join(f.base,'outside');mkdirSync(outside);writeFileSync(join(outside,'data'),'first');
  symlinkSync(outside,join(f.root,'link'));const first=repositoryIdentity(f.root);
  writeFileSync(join(outside,'data'),'second');assert.deepEqual(repositoryIdentity(f.root),first);
  rmSync(join(f.root,'link'));symlinkSync('missing-target',join(f.root,'link'));assert.notEqual(repositoryIdentity(f.root).treeDigest,first.treeDigest);
});

test('tracked gitlinks fail with the relative path rather than silently omitting tracked content', t => {
  const f=sandbox(t);nestedWorktree(f);
  git(f.root,['update-index','--add','--cacheinfo',`160000,${repositoryIdentity(f.root).head},.claude/worktrees/agent-x`]);
  assert.throws(()=>repositoryIdentity(f.root),e=>e.code==='EUNSUPPORTEDTYPE'&&e.path==='.claude/worktrees/agent-x'&&/tracked directory or submodule/.test(e.message));
});

test('filesystem inspection errors retain their code/cause and identify the quoted relative path', t => {
  const f=sandbox(t),folder=join(f.root,'folder');mkdirSync(folder);writeFileSync(join(folder,'file.txt'),'tracked');git(f.root,['add','folder/file.txt']);
  rmSync(folder,{recursive:true});symlinkSync('folder',folder);
  assert.throws(()=>repositoryIdentity(f.root),e=>e.code==='ELOOP'&&e.cause?.code==='ELOOP'&&e.path==='folder/file.txt'&&e.message.includes('"folder/file.txt"'));
});

test('unsupported tracked directories and special files give useful pre-attempt notices without reading them', async t => {
  for(const type of ['directory','fifo']) {
    const f=sandbox(t);rmSync(join(f.root,'input.txt'));
    if(type==='directory')mkdirSync(join(f.root,'input.txt'));else execFileSync('mkfifo',[join(f.root,'input.txt')]);
    f.start();await f.engine.tick();
    assert.equal(f.store.all('attempt').length,0);
    const flow=f.store.need('flow','flow-1');assert.equal(flow.state,'stopped');assert.match(flow.stopReason,/Cannot fingerprint repository path "input.txt"/);
    assert.match(f.store.all('inbox').find(row=>row.kind==='notice').context,/"input.txt"/);
  }
});

test('a nested worktree does not mask parent input changes before dispatch', async t => {
  const f=sandbox(t);nestedWorktree(f);f.start();await f.engine.tick();
  assert.equal(f.store.all('attempt').length,1);assert.equal(f.store.all('attempt')[0].status,'prepared');
  writeFileSync(join(f.root,'input.txt'),'changed after preparation');await f.engine.tick();
  assert.equal(f.store.need('flow','flow-1').state,'stopped');assert.match(f.store.need('flow','flow-1').stopReason,/prepared input changed/);
  assert.equal(f.store.all('attempt')[0].status,'prepared','nothing dispatched under changed input');
});

test('a checkout whose path listing exceeds one mebibyte is fingerprinted, on and off the calling thread', async t => {
  const f=sandbox(t), dir=join(f.root,'generated'), name=n=>`fictional-generated-${'x'.repeat(100)}-${String(n).padStart(5,'0')}.txt`;
  mkdirSync(dir);for(let n=0;n<9000;n++)writeFileSync(join(dir,name(n)),'');
  assert.ok(execFileSync('git',['ls-files','--others','--exclude-standard','-z'],{cwd:f.root,maxBuffer:64*1024*1024}).length>1024*1024);
  const identity=repositoryIdentity(f.root);assert.match(identity.treeDigest,/^[0-9a-f]{64}$/);
  assert.deepEqual(await repositoryIdentityOffThread(f.root),identity,'the worker computes the same identity');
  writeFileSync(join(dir,name(4500)),'changed');assert.notEqual((await repositoryIdentityOffThread(f.root)).treeDigest,identity.treeDigest);
});

test('the off-thread fingerprint reports the same refusal as the direct one', async t => {
  const f=sandbox(t);rmSync(join(f.root,'input.txt'));execFileSync('mkfifo',[join(f.root,'input.txt')]);
  assert.throws(()=>repositoryIdentity(f.root),/unsupported filesystem entry type/);
  await assert.rejects(repositoryIdentityOffThread(f.root),error=>/Cannot fingerprint repository path "input.txt": unsupported filesystem entry type/.test(error.message)&&error.code==='EUNSUPPORTEDTYPE'&&error.path==='input.txt');
});

test('the constant-cost probe changes with Git operations, in linked worktrees too, and not with unreported edits', t => {
  const f=sandbox(t), linked=join(f.base,'linked');git(f.root,['worktree','add','-q','--detach',linked,'HEAD']);
  for(const root of [f.root,linked]){
    const initial=repositoryProbe(root);assert.equal(typeof initial,'string');
    writeFileSync(join(root,'input.txt'),'unreported edit\n');assert.equal(repositoryProbe(root),initial);
    git(root,['add','input.txt']);const staged=repositoryProbe(root);assert.notEqual(staged,initial);
    git(root,['-c','user.email=fixture@example.invalid','-c','user.name=Fictional Evaluator','commit','-qm','Fictional change']);assert.notEqual(repositoryProbe(root),staged);
  }
  assert.equal(repositoryProbe(join(f.base,'missing')),null);
});
