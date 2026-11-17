import { existsSync, lstatSync, realpathSync, readdirSync, readSync, mkdirSync, copyFileSync, renameSync, rmSync, chmodSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { resolve, relative, join, dirname, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assert, digest, now } from '../core/contracts.mjs';
import { assertAuthorityRecordsSound, authorityRetentionRoots } from '../core/decision-authority.mjs';
import * as workspace from '../adapters/workspace/index.mjs';
import { INTENT_KIND } from '../core/records.mjs';
const exec = promisify(execFile);
function sha(path) {
  const hash=createHash('sha256'), buffer=Buffer.allocUnsafe(1024*1024),fd=openSync(path,'r');
  try {let bytes;while((bytes=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,bytes));return hash.digest('hex');}
  finally{closeSync(fd);}
}
const inside = (root,path) => path === root || path.startsWith(root + '/');
const terminal = flow => ['completed','failed','stopped'].includes(flow.state);
function tree(path) {
  const out = []; let newest = 0;
  const walk = (current, name) => { const stat=lstatSync(current); newest=Math.max(newest,stat.mtimeMs); assert(!stat.isSymbolicLink(), 'retention does not follow or archive symlinks');
    if(stat.isDirectory()){out.push({path:name,type:'directory',mode:stat.mode});for(const child of readdirSync(current).sort())walk(join(current,child),join(name,child));}
    else {assert(stat.isFile(), 'retention supports ordinary files and directories');out.push({path:name,type:'file',mode:stat.mode,size:stat.size,sha256:sha(current)});}
  };walk(path,'.');return {digest:digest(out),newest,files:out};
}
function stateGuard(store,{flowId,operationId,signal}) {
  assert(!signal?.aborted,'archive retention canceled; retained hold requires reconciliation');
  const own=store.get('flow',flowId);assert(!own?.stopRequested&&!own?.abortRequested&&own?.state!=='stopped'&&!store.meta('paused'),'archive retention stopped or paused; retained hold requires reconciliation');
  const hold=store.meta('retentionHold');assert(!hold||hold.operationId===operationId,'another retention operation owns the hold');
  assert(!store.live('flow').some(f=>f.id!==flowId&&!terminal(f)),'active flow protects retention');
  assert(!store.live('attempt').some(a=>a.flowId!==flowId&&!a.settledAt&&!['passed','failed','aborted','not-dispatched'].includes(a.status)),'unsettled attempt protects retention');
  assert(!store.live('inbox').some(i=>i.status==='open'&&i.kind==='question'&&i.flowId!==flowId),'open question protects retention');
  assert(!store.live('obligation').some(o=>!['passed','failed','deferred'].includes(o.status)),'unresolved obligation protects retention');
  // Decision-authority records are retention roots: an unresolved decision holds retention like any
  // unresolved obligation, and unsound authority records fail closed (no-op before migration).
  assertAuthorityRecordsSound(store,'archive retention');
  assert(!authorityRetentionRoots(store).unresolved.length,'unresolved decision obligation protects retention');
}
function proofPaths(store,proof,nowMs) {
  assert(proof?.complete===true&&Array.isArray(proof.protectedPaths)&&proof.protectedPaths.every(p=>typeof p==='string'),'complete current preservation discovery required');
  const observed=Date.parse(proof.observedAt);assert(Number.isFinite(observed)&&observed<=nowMs&&nowMs-observed<=60000,'preservation discovery is stale');
  const paths=proof.protectedPaths.map(p=>resolve(store.stateDir,p));
  paths.push(join(store.stateDir,'attempts'));
  for(const flow of store.all('flow'))if(flow.workspace){paths.push(flow.workspace.manifestPath);}

  const ownershipKeys = new Set(['version','projectId','flowId','root','path','branch','base','head','ownershipDigest','manifestPath','setupDigest']);
  const collect = (value,owned,address=[]) => {
    if(typeof value==='string'){
      if(address.join('.')==='intent.action.stateDir' && resolve(value)===resolve(store.stateDir))return;
      if(owned && address.join('.')==='intent.cwd' && value===owned.path)return;
      const path=resolve(store.stateDir,value);if(existsSync(path))paths.push(path);
    }else if(Array.isArray(value))value.forEach((item,index)=>collect(item,owned,[...address,index]));
    else if(value&&typeof value==='object'){
      if(address.join('.')==='intent.action.config')return;
      // Only the exact known ownership pointer is structural metadata. Extra
      // fields and arbitrary evidence paths under that tree remain citations.
      const pointer=owned&&value.path===owned.path&&value.manifestPath===owned.manifestPath&&value.ownershipDigest===owned.ownershipDigest;
      for(const [key,item] of Object.entries(value))if(!pointer||!ownershipKeys.has(key))collect(item,owned,[...address,key]);
    }
  };
  const attemptRecord=store.db.prepare("SELECT data FROM records WHERE kind='attempt' AND id=?"),attemptFlow={get:id=>{const found=attemptRecord.get(id);return found?JSON.parse(found.data):undefined;}};
  for(const row of store.db.prepare('SELECT kind,data FROM records').all()) {
    if(['archiveRetention','artifact'].includes(row.kind))continue;
    const data=JSON.parse(row.data);
    if(row.kind==='flow'&&terminal(data))collect(data,data.workspace);
    else if(row.kind==='attempt'){const owner=store.get('flow',data.flowId);collect(data,owner&&terminal(owner)?owner.workspace:undefined);}
    // A separately stored intent is read as part of its attempt: same addresses, same owning flow.
    else if(row.kind===INTENT_KIND){const flowId=attemptFlow.get(data.id)?.flowId,owner=flowId?store.get('flow',flowId):undefined;collect(data,owner&&terminal(owner)?owner.workspace:undefined);}
    else collect(data);
  }
  for(const artifact of store.all('artifact'))if(artifact.referenced||artifact.preserved||artifact.flowId||artifact.attemptId)collect(artifact);
  return paths;
}
function protectedBy(paths,candidate){return paths.some(path=>inside(candidate,path)||inside(path,candidate));}
export function syncArchive(path) {
  assert(!lstatSync(path).isSymbolicLink() && lstatSync(path).isFile(), 'archive file must be ordinary');
  const syncPath = target => { const fd=openSync(target,'r');try{fsyncSync(fd);}finally{closeSync(fd);} };
  syncPath(path);
  // Recursive mkdir may have created the project directory and its ancestors.
  // Persist each directory entry up to the filesystem root before deleting the
  // only original. Filesystems that reject directory fsync fail closed.
  for(let current=dirname(path);;current=dirname(current)){syncPath(current);if(dirname(current)===current)break;}
}
async function copyVerified(source,destination,copy=copyFileSync,archiveSync=syncArchive) {
  const hash=sha(source);mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  if(existsSync(destination)){assert(!lstatSync(destination).isSymbolicLink(),'archive destination redirected');assert(sha(destination)===hash,'archive destination contains different evidence');archiveSync(destination);return hash;}
  assert(!existsSync(destination+'.partial')||!lstatSync(destination+'.partial').isSymbolicLink(),'archive partial path redirected');
  const staging=destination+'.partial';copy(source,staging);chmodSync(staging,0o600);assert(sha(staging)===hash,'external archive checksum mismatch');renameSync(staging,destination);assert(sha(destination)===hash,'external archive verification failed');archiveSync(destination);return hash;
}
// Only supervised maintenance calls this with a live preservation command. Tests
// may inject discovery/copy failure; neither supplies authority to ordinary tasks.
export async function runArchiveRetention(store,{config,flowId,operationId,discover,forge,nowMs=Date.now(),dryRun=false,copy,archiveSync=syncArchive,signal,releaseWorkspace=workspace.release}={}) {
  assert(config&&typeof discover==='function'&&flowId&&operationId,'retention scope and preservation adapter required');
  assert(Number.isFinite(nowMs),'retention observation time required');
  assert(config.allowConcurrent !== true, 'concurrent retention is not supported; drain development flows first');
  const root=realpathSync(store.stateDir),archiveRoot=resolve(config.archiveRoot??'');
  assert(config.archiveRoot&&isAbsolute(config.archiveRoot)&&!inside(root,archiveRoot)&&!inside(archiveRoot,root),'archive root must be outside project state');
  mkdirSync(archiveRoot,{recursive:true,mode:0o700});const realArchive=realpathSync(archiveRoot);assert(!inside(root,realArchive)&&!inside(realArchive,root),'archive root redirected into project state');
  const projectArchive=join(realArchive,store.meta('project').projectId);assert(inside(realArchive,projectArchive)&&projectArchive!==realArchive,'archive project identity escapes root');mkdirSync(projectArchive,{recursive:true,mode:0o700});assert(realpathSync(projectArchive)===projectArchive,'archive project directory redirected');chmodSync(projectArchive,0o700);
  for(const key of ['artifactAgeMs','worktreeAgeMs'])if(config[key]!==undefined)assert(Number.isSafeInteger(config[key])&&config[key]>0,`positive ${key} required`);
  assert(Array.isArray(config.artifactRoots??[])&&(config.artifactRoots??[]).every(p=>typeof p==='string'&&p.length&&!isAbsolute(p)&&p!=='.'&&!p.split('/').includes('..')&&!['attempts','workspaces','retention-staging'].includes(p.split('/')[0])),'private artifact subroots required');
  const scope={flowId,operationId,signal},results=[];
  store.tx(()=>{stateGuard(store,scope);if(!dryRun)store.setMeta('retentionHold',{flowId,operationId,createdAt:now()});});
  let success=false;
  try {
    const proof=await discover();const protectedPaths=proofPaths(store,proof,Date.now());
    const staging=join(root,'retention-staging',digest(operationId));if(!dryRun)mkdirSync(staging,{recursive:true,mode:0o700});
    // A crash can remove an artifact after its durable archive intent but before
    // SQLite commits the removal receipt. Missing originals are reconciled only
    // against that exact verified and fsynced archive, never silently forgotten.
    for(const pending of store.all('archiveRetention').filter(row=>row.operationId===operationId&&['intent','archived'].includes(row.status)&&row.destination?.endsWith('.tar.gz')&&!existsSync(row.path))){
      assert((config.artifactRoots??[]).some(scope=>inside(resolve(root,scope),pending.path))&&dirname(pending.destination)===projectArchive,'interrupted artifact outside approved scope');
      assert(pending.archiveDigest&&existsSync(pending.destination)&&sha(pending.destination)===pending.archiveDigest,'interrupted artifact archive missing or corrupt');archiveSync(pending.destination);
      if(dryRun){results.push({path:pending.path,status:'eligible-reconciliation',destination:pending.destination});continue;}
      const freshProof=await discover();store.tx(()=>{stateGuard(store,scope);proofPaths(store,freshProof,Date.now());assert(sha(pending.destination)===pending.archiveDigest,'interrupted archive changed');store.put('archiveRetention',{...pending,status:'removed',reconciled:true,originalAbsent:true,removedAt:now()});store.event('retention.archive-reconciled',{id:pending.id,path:pending.path,destination:pending.destination,archiveDigest:pending.archiveDigest});});results.push({path:pending.path,status:'archived-removed',destination:pending.destination,reconciled:true});
    }
    const candidates=[];
    if(config.artifactAgeMs)for(const configured of config.artifactRoots??[]){const path=resolve(root,configured);assert(inside(root,path)&&path!==root,'artifact root escapes private state');if(!existsSync(path))continue;assert(realpathSync(path)===path&&!lstatSync(path).isSymbolicLink(),'artifact root redirected');for(const name of readdirSync(path))candidates.push(join(path,name));}
    for(const path of candidates){
      if(protectedBy(protectedPaths,path)||store.all('flow').some(flow=>flow.workspace&&(inside(path,flow.workspace.path)||inside(flow.workspace.path,path)))){results.push({path,status:'protected'});continue;}
      let snapshot;try{snapshot=tree(path);}catch{results.push({path,status:'protected',reason:'nonordinary or unavailable path'});continue;}
      if(nowMs-snapshot.newest<config.artifactAgeMs){results.push({path,status:'young'});continue;}
      const id=digest({path,content:snapshot.digest}),destination=join(projectArchive,`${id}.tar.gz`);
      if(dryRun){results.push({path,status:'eligible',destination});continue;}
      const previous=store.get('archiveRetention',id);
      const row={...previous,id,operationId,path,status:'intent',contentDigest:snapshot.digest,destination,createdAt:now()};store.tx(()=>{stateGuard(store,scope);store.put('archiveRetention',row);store.event('retention.archive-intent',{id,path});});
      const local=join(staging,`${id}.tar.gz`);let archiveDigest=previous?.archiveDigest;
      if(!archiveDigest||!existsSync(destination)||sha(destination)!==archiveDigest){await exec('tar',['-czf',local,'-C',dirname(path),'--',basename(path)],{timeout:120000,maxBuffer:1024*1024,env:{PATH:process.env.PATH,LANG:'C.UTF-8'}});archiveDigest=sha(local);store.tx(()=>store.put('archiveRetention',{...row,archiveDigest}));await copyVerified(local,destination,copy,archiveSync);}
      archiveSync(destination);
      const freshProof=await discover();
      store.tx(()=>{stateGuard(store,scope);const fresh=proofPaths(store,freshProof,Date.now());assert(!protectedBy(fresh,path),'artifact became cited');assert(tree(path).digest===snapshot.digest,'artifact changed during archival');assert(sha(destination)===archiveDigest,'archive changed before deletion');store.put('archiveRetention',{...row,status:'archived',archiveDigest,archivedAt:now()});rmSync(path,{recursive:true});store.put('archiveRetention',{...row,status:'removed',archiveDigest,removedAt:now()});store.event('retention.archived-removed',{id,path,destination,archiveDigest});});
      rmSync(local,{force:true});results.push({path,status:'archived-removed',destination,archiveDigest});
    }
    if(config.worktreeAgeMs)for(const flow of store.all('flow').filter(f=>f.id!==flowId&&terminal(f)&&f.workspace)){
      const owned=flow.workspace,path=owned.path;
      if(!existsSync(path)){
        const pending=store.all('archiveRetention').find(row=>row.path===path&&row.archiveDigest&&row.destination&&['intent','deleting'].includes(row.status));
        if(!pending)continue;
        assert(existsSync(pending.destination)&&sha(pending.destination)===pending.archiveDigest,'interrupted workspace archive missing or corrupt');
        archiveSync(pending.destination);const freshProof=await discover();
        if(flow.results?.publish?.number){assert(forge,'current PR discovery required');assert((await forge.readPR(flow.results.publish.number)).state!=='open','open PR protects interrupted cleanup');}
        if(dryRun){results.push({path,status:'eligible',destination:pending.destination});continue;}
        store.tx(()=>{stateGuard(store,scope);const fresh=proofPaths(store,freshProof,Date.now());assert(!protectedBy(fresh,path),'interrupted workspace became cited');store.put('archiveRetention',{...pending,status:'deleting',deletionAuthorizedAt:now()});});
        const release=await releaseWorkspace({workspace:owned,preservation:{archivePath:pending.destination},dryRun:false});
        store.tx(()=>{stateGuard(store,scope);store.put('archiveRetention',{...pending,status:'removed',removedAt:now(),release});store.event('retention.workspace-archived',{flowId:flow.id,path,destination:pending.destination,archiveDigest:pending.archiveDigest,reconciled:true});});results.push({path,status:'archived-removed',destination:pending.destination,reconciled:true});continue;
      }
      const ended=flow.finishedAt??flow.endedAt??flow.stoppedAt??store.db.prepare("SELECT at FROM events WHERE json_extract(payload,'$.flowId')=? AND type IN ('flow.finished','flow.stopped','flow.completed','flow.failed') ORDER BY sequence DESC LIMIT 1").get(flow.id)?.at;
      const endedMs=Date.parse(ended);
      if(!Number.isFinite(endedMs)||endedMs>nowMs||nowMs-endedMs<config.worktreeAgeMs||protectedBy(protectedPaths,path)){results.push({path,status:'protected'});continue;}
      if(authorityRetentionRoots(store).flowIds.has(flow.id)){results.push({path,status:'protected',reason:'cited by decision-authority evidence'});continue;}
      assert(inside(root,path),'owned worktree escapes private state');const inspected=await workspace.inspect({workspace:owned});
      if(inspected.released||inspected.dirty||inspected.leases?.length){results.push({path,status:'protected',reason:'workspace dirty, released or leased'});continue;}
      const prNumber=flow.results?.publish?.number;
      if(prNumber){assert(forge,'current PR discovery required');const pr=await forge.readPR(prNumber);if(pr.state==='open'){results.push({path,status:'protected',reason:'open pull request'});continue;}}
      const id=digest({workspace:owned.ownershipDigest,head:inspected.head}),destination=join(projectArchive,`${id}.bundle`);
      if(dryRun){results.push({path,status:'eligible',destination});continue;}
      const local=join(staging,`${id}.bundle`),previous=store.get('archiveRetention',id);let archiveDigest=previous?.archiveDigest;
      if(!archiveDigest||!existsSync(destination)||sha(destination)!==archiveDigest){await workspace.git(path,['bundle','create',local,owned.branch]);archiveDigest=sha(local);store.tx(()=>{stateGuard(store,scope);store.put('archiveRetention',{id,operationId,path,destination,archiveDigest,status:'intent',createdAt:now()});});await copyVerified(local,destination,copy,archiveSync);}
      archiveSync(destination);const freshProof=await discover();
      // The short writer transaction validates current citations and commits the
      // deletion intent. retentionHold fences canonical citation mutations for
      // the entire asynchronous cleanup; do not hold SQLite across Git waits.
      store.tx(()=>{stateGuard(store,scope);const fresh=proofPaths(store,freshProof,Date.now());assert(!protectedBy(fresh,path),'workspace became cited');assert(sha(destination)===archiveDigest,'workspace archive changed');store.put('archiveRetention',{id,operationId,path,destination,archiveDigest,status:'deleting',deletionAuthorizedAt:now()});});
      const release=await releaseWorkspace({workspace:owned,preservation:{archivePath:destination},dryRun:false});
      store.tx(()=>{stateGuard(store,scope);store.put('archiveRetention',{id,operationId,path,destination,archiveDigest,status:'removed',removedAt:now(),release});store.event('retention.workspace-archived',{flowId:flow.id,path,destination,archiveDigest});});rmSync(local,{force:true});results.push({path,status:'archived-removed',destination,archiveDigest});
    }
    success=true;return {results,dryRun};
  } finally {
    // A failed copy/discovery/deletion leaves originals and the durable hold for
    // inspection. Re-running this same operation may reconcile and release it.
    if(success&&!dryRun)store.tx(()=>{assert(store.meta('retentionHold')?.operationId===operationId,'retention hold changed');store.setMeta('retentionHold',null);});
  }
}
