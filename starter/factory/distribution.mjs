// Source distribution prepares reviewable changes; runtime activation is separate.
import { NO_AUTO_MAINTENANCE, NO_PLANTED_COMMANDS } from './core/git-options.mjs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,realpathSync,readdirSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,renameSync,rmSync,chmodSync} from 'node:fs';
import {resolve,join,dirname,relative,isAbsolute} from 'node:path';
import {LOCK,normalizePrefix,underPrefix,shellWord,lockHistory} from './core/install-layout.mjs';
import {NO_HISTORY_REWRITES_ENV,NO_HISTORY_REWRITES_ARGS,lockHistoryGraph,VerifiedObjects} from './core/verified-git.mjs';
import {downgradeProblem} from './core/adoption-anchor.mjs';
const check=(value,message)=>{if(!value)throw new Error(message);};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const sha=value=>/^[a-f0-9]{64}$/.test(value??'');
const within=(parent,child)=>child===parent||child.startsWith(parent+'/');
const versionOK=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value);
function safePath(value){check(typeof value==='string'&&!isAbsolute(value)&&!value.includes('\\')&&!value.includes('\0')&&value.split('/').every(part=>part&&part!=='.'&&part!=='..'&&part!=='.git'),'invalid distribution path');return value;}
function owner(path){safePath(path);if(path.startsWith('factory/')||['VERSION','compatibility.json'].includes(path))return 'managed';if(path.startsWith('project/'))return 'template';throw Error(`unsupported release path: ${path}`);}
function ordinaryPath(path){const absolute=resolve(path);let current=absolute;while(true){if(existsSync(current)||(()=>{try{lstatSync(current);return true;}catch{return false;}})())check(!lstatSync(current).isSymbolicLink(),'distribution paths must not contain symlinks');if(dirname(current)===current)break;current=dirname(current);}return absolute;}
function inventory(root,prefix=''){const rows=[];for(const name of readdirSync(join(root,prefix)).sort()){const path=prefix+name,full=join(root,path),stat=lstatSync(full);check(!stat.isSymbolicLink(),'distribution symlinks unsupported');if(stat.isDirectory())rows.push(...inventory(root,path+'/'));else{check(stat.isFile(),'distribution requires ordinary files');rows.push({path,sha256:hash(readFileSync(full)),mode:stat.mode&0o111?0o755:0o644});}}return rows;}
// Replacement objects, grafts and the commit-graph cache are off for every command here.
const gitEnvironment=()=>({...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),...NO_HISTORY_REWRITES_ENV,GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0'});
function git(root,args){return execFileSync('git',[...NO_AUTO_MAINTENANCE,...NO_PLANTED_COMMANDS,'-c','core.hooksPath=/dev/null',...NO_HISTORY_REWRITES_ARGS,...args],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:gitEnvironment(),timeout:60000,maxBuffer:32*1024*1024}).trim();}
function projectRoot(root){root=ordinaryPath(root);check(realpathSync(root)===root,'canonical project root required');check(git(root,['rev-parse','--show-toplevel'])===root,'target must be a Git checkout root');return root;}
function releaseRecord(manifest,manifestDigest){return {version:manifest.version,manifestDigest,payloadDigest:manifest.payloadDigest,sourceCommit:manifest.sourceCommit,sourceState:manifest.sourceState};}
// Test files are Factotum's own; a release never ships them into an adopting project.
const TEST_FILE=/\.(test|spec)\.[cm]?js$/;
// Every lock carries layout evidence: the release's template identities and compatibility, so its
// managed files rebuild the exact pinned manifest (layoutMatches) and no file hash in the lock can
// change without changing the digest the operator pinned. A prefixed lock keeps it under `layout`;
// a root lock under `rootLayout`, because releases before dev.87 refuse a root lock with a `layout`
// key, and a root lock this release writes must stay readable by a release it adopts (a downgrade).
// Root locks written before dev.87 have no evidence: they are read as unauthenticated (doctor and
// adopt status warn, activation needs a verified release directory) until the next adoption.
const EVIDENCE=prefix=>prefix?'layout':'rootLayout';
const evidenceOf=lock=>lock[EVIDENCE(lock.prefix??'')];
function newLock(release,prefix=''){const lock={formatVersion:1,...(prefix?{prefix}:{}),release:releaseRecord(release.manifest,release.manifestDigest),managedFiles:release.manifest.files.filter(f=>f.owner==='managed').map(({owner,...file})=>file),[EVIDENCE(prefix)]:{compatibility:release.manifest.compatibility,templateFiles:release.manifest.files.filter(f=>f.owner==='template').map(({owner,...file})=>file)},templatePolicy:'seed-on-install; project-owned thereafter'};check(layoutMatches(lock),'this release manifest is not in the canonical form release build writes; adoption needs a release built by release build, so that the lock can carry the evidence that ties its files to the release digest');return lock;}
// Inventory order: depth-first with each folder's names sorted, i.e. paths compared segment by segment.
const inventoryOrder=(a,b)=>{const x=a.path.split('/'),y=b.path.split('/');for(let i=0;i<Math.max(x.length,y.length);i++)if(x[i]!==y[i])return (x[i]??'')<(y[i]??'')?-1:1;return 0;};
// The lock's managed and template files, owners and compatibility rebuild the release manifest
// whose SHA-256 the operator pinned at adoption: nothing in the lock can change without changing it.
function layoutMatches(lock){try{const layout=evidenceOf(lock);const files=[...lock.managedFiles.map(({path,sha256,mode})=>({path,sha256,mode,owner:'managed'})),...layout.templateFiles.map(({path,sha256,mode})=>({path,sha256,mode,owner:'template'}))].sort(inventoryOrder);validateFiles(files,{ownership:true});const payloadDigest=hash(json(files));const {schemaVersions,configVersions,projectProtocolVersions,requireDrain}=layout.compatibility;const manifest={formatVersion:1,version:lock.release.version,sourceCommit:lock.release.sourceCommit,sourceState:lock.release.sourceState,compatibility:{schemaVersions,configVersions,projectProtocolVersions,requireDrain},files,payloadDigest};return payloadDigest===lock.release.payloadDigest&&hash(json(manifest))===lock.release.manifestDigest;}catch{return false;}}
// Layout continuity with Git history, read from verified objects (core/verified-git.mjs: replace
// refs, grafts and shallow clones are refused; every commit, tree and blob is hash-checked; parents
// come from the commits themselves and the walk must be complete). Anchored on adoption commits: a
// commit whose lock carries a release record none of its parents' locks carry (adopt install/update
// wrote it; builders may not touch the lock). The current lock must equal every adoption commit of
// its release, and every adoption commit must name the current prefix. A lock deleted at any commit
// (absent while a parent had it), or not a regular file or valid JSON at any commit, is tampering:
// recreating it would otherwise reset this check. A same-release edit later reverted does not matter.
function layoutHistory(root,lock){
 const {graph,blob}=lockHistoryGraph(root,LOCK),parsed=new Map();
 // Parsed once per distinct lock blob (a long history has few), not once per commit.
 const at=id=>{const row=graph.get(id);if(!row?.lock)return null;check(['100644','100755'].includes(row.lock.mode),`${LOCK} is not a regular file in ${id.slice(0,12)}; treated as tampering`);if(parsed.has(row.lock.id))return parsed.get(row.lock.id);let value;try{value=JSON.parse(blob(row.lock.id).toString('utf8'));}catch{throw new Error(`${LOCK} was not valid JSON in ${id.slice(0,12)}; a corrupted adoption lock in history is treated as tampering`);}parsed.set(row.lock.id,value);return value;};
 for(const [id,row] of graph){const own=at(id);if(!own&&row.parents.some(parent=>graph.get(parent)?.lock))throw new Error(`${LOCK} was deleted in ${id.slice(0,12)}; a deleted adoption lock is treated as tampering, even if it was recreated. Restore the history's lock from the adoption commit (an installation cannot be removed and adopted again in the same history)`);}
 const digestOf=value=>value?.release?.manifestDigest;
 for(const [id,row] of graph){const own=at(id);if(!own||row.parents.some(parent=>digestOf(at(parent))===digestOf(own)))continue;
  check((own.prefix??'')===(lock.prefix??''),digestOf(own)===lock.release.manifestDigest?`${LOCK} changed its install prefix since ${id.slice(0,12)} adopted ${lock.release.version} (${own.prefix??'repository root'} to ${lock.prefix??'repository root'}); moving an installation is not supported; restore the lock from that commit`:`${LOCK} changed its install prefix: ${id.slice(0,12)} adopted ${own.release?.version??'a release'} under ${own.prefix??'the repository root'}, the lock now says ${lock.prefix??'the repository root'}; moving an installation is not supported`);
  if(digestOf(own)===lock.release.manifestDigest)check(json(own.managedFiles)===json(lock.managedFiles)&&json(own.layout??null)===json(lock.layout??null)&&json(own.rootLayout??null)===json(lock.rootLayout??null),`${LOCK} changed its managed files since ${id.slice(0,12)} adopted ${lock.release.version}, without adopting a release; restore the lock from that commit`);}
}
function validateFiles(files,{ownership=false}={}){check(Array.isArray(files)&&files.length>0&&files.length<=20000,'invalid distribution inventory');const names=new Set();for(const file of files){const kind=owner(file.path);check(!names.has(file.path),'duplicate distribution path');names.add(file.path);check(sha(file.sha256)&&[0o644,0o755].includes(file.mode),'invalid file identity');if(ownership)check(file.owner===kind,'invalid release ownership');else check(kind==='managed','lock may own only managed files');}return names;}
export function buildRelease({sourceDir,outputDir,version,allowWorkingTree=false}){
 check(versionOK(version),'invalid release version');const source=ordinaryPath(sourceDir),out=ordinaryPath(outputDir);check(!within(source,out)&&!within(out,source),'release output must be separate from source');check(!existsSync(out),'release output already exists');
 const sourceFiles=inventory(source);for(const row of sourceFiles)owner(row.path);const tests=sourceFiles.filter(row=>TEST_FILE.test(row.path)).map(row=>row.path);check(!tests.length,`release payload must not contain test files; move them out of the starter: ${tests.slice(0,5).join(', ')}`);check(sourceFiles.some(f=>f.path==='factory/cli.mjs'),'starter layout requires factory/cli.mjs');
 let sourceCommit=null,sourceState='working-tree';
 try {
  const top=git(source,['rev-parse','--show-toplevel']),prefix=relative(top,source),head=git(source,['rev-parse','HEAD']);
  // Compare actual bytes to the committed tree, including files hidden by Git's
  // ignore/assume-unchanged machinery. A development tree has no commit claim.
  const entries=execFileSync('git',['ls-tree','-rz',head,'--',prefix||'.'],{cwd:top,encoding:'utf8',env:gitEnvironment(),timeout:60000,maxBuffer:32*1024*1024}).split('\0').filter(Boolean);
  const modes=new Map(entries.map(entry=>{const match=/^(\d+) blob [a-f0-9]+\t(.*)$/s.exec(entry);return match?[match[2],Number.parseInt(match[1],8)&0o111?0o755:0o644]:[entry,null];}));
  if(entries.length===sourceFiles.length&&sourceFiles.every(file=>{const path=prefix?prefix+'/'+file.path:file.path;return modes.get(path)===file.mode&&hash(execFileSync('git',['cat-file','blob',head+':'+path],{cwd:top,env:gitEnvironment(),timeout:60000,maxBuffer:32*1024*1024}))===file.sha256;})){sourceCommit=head;sourceState='clean-commit';}
 }catch{/* Uncommitted references are explicitly development artifacts. */}
 check(sourceState==='clean-commit'||allowWorkingTree===true,'source differs from a committed starter; use --development for an explicit development artifact');
 mkdirSync(dirname(out),{recursive:true});const staging=mkdtempSync(join(dirname(out),'.factotum-release-'));
 try{
  const payload=join(staging,'starter');mkdirSync(payload);
  for(const row of sourceFiles){const target=join(payload,row.path);mkdirSync(dirname(target),{recursive:true});const bytes=readFileSync(join(source,row.path));check(hash(bytes)===row.sha256,'source changed while building release');writeFileSync(target,bytes,{mode:row.mode});}
  writeFileSync(join(payload,'VERSION'),version+'\n');const compatibility=JSON.parse(readFileSync(join(payload,'compatibility.json'),'utf8'));compatibility.starterVersion=version;compatibility.schemaVersions=[compatibility.schemaVersion];compatibility.configVersions=[compatibility.configVersion];compatibility.requireDrain=true;writeFileSync(join(payload,'compatibility.json'),json(compatibility));
  check([compatibility.schemaVersion,compatibility.configVersion,compatibility.projectProtocolVersion].every(n=>Number.isSafeInteger(n)&&n>0),'release compatibility declarations required');
  const files=inventory(payload).map(file=>({...file,owner:owner(file.path)}));const manifest={formatVersion:1,version,sourceCommit,sourceState,compatibility:{schemaVersions:[compatibility.schemaVersion],configVersions:[compatibility.configVersion],projectProtocolVersions:[compatibility.projectProtocolVersion],requireDrain:true},files,payloadDigest:hash(json(files))};
  const bytes=json(manifest),manifestDigest=hash(bytes);writeFileSync(join(staging,'release.json'),bytes);writeFileSync(join(staging,'release.json.sha256'),manifestDigest+'  release.json\n');renameSync(staging,out);return {directory:out,version,manifestDigest,payloadDigest:manifest.payloadDigest,sourceCommit,sourceState};
 }catch(error){rmSync(staging,{recursive:true,force:true});throw error;}
}
export function readRelease(releaseDir,expectedDigest){
 const root=ordinaryPath(releaseDir);check(sha(expectedDigest),'explicit trusted --digest (release manifest SHA-256) required');const bytes=readFileSync(ordinaryPath(join(root,'release.json')));check(hash(bytes)===expectedDigest,'release manifest checksum mismatch');const manifest=JSON.parse(bytes);check(manifest.formatVersion===1&&versionOK(manifest.version),'unsupported release manifest');
 validateFiles(manifest.files,{ownership:true});check(manifest.payloadDigest===hash(json(manifest.files)),'release inventory digest mismatch');
 check(['clean-commit','working-tree'].includes(manifest.sourceState)&&(manifest.sourceState==='clean-commit'?/^[a-f0-9]{40,64}$/.test(manifest.sourceCommit??''):manifest.sourceCommit===null),'invalid release provenance');
 const c=manifest.compatibility;check(c&&['schemaVersions','configVersions','projectProtocolVersions'].every(k=>Array.isArray(c[k])&&c[k].length>0&&c[k].every(n=>Number.isSafeInteger(n)&&n>0))&&c.requireDrain===true,'invalid release compatibility');
 const payload=ordinaryPath(join(root,'starter')),actual=inventory(payload).map(file=>({...file,owner:owner(file.path)}));check(json(actual)===json(manifest.files),'release payload changed, missing or contains extra files');
 check(readFileSync(join(payload,'VERSION'),'utf8').trim()===manifest.version,'release VERSION mismatch');const compatibility=JSON.parse(readFileSync(join(payload,'compatibility.json'),'utf8'));check(compatibility.starterVersion===manifest.version&&json(compatibility.schemaVersions)===json(c.schemaVersions)&&json(compatibility.configVersions)===json(c.configVersions)&&compatibility.requireDrain===true&&c.schemaVersions.includes(compatibility.schemaVersion)&&c.configVersions.includes(compatibility.configVersion)&&c.projectProtocolVersions.includes(compatibility.projectProtocolVersion),'release compatibility mismatch');
 check(manifest.files.some(f=>f.path==='factory/cli.mjs'),'release entry point missing');return {root,payload,manifest,manifestDigest:expectedDigest};
}
// Fail closed: an unreadable, invalid or discontinuous lock stops status, plan and update.
// history:false checks only the lock itself and the files (doctor's drift check); it needs no Git history.
const readLock=(root,options)=>readLockFile(root,options).lock;
// The lock and the SHA-256 of its bytes (the project's state records which exact lock a release authenticated).
function readLockFile(root,{history=true}={}){const path=ordinaryPath(join(root,LOCK));let lock,bytes;try{bytes=readFileSync(path);lock=JSON.parse(bytes.toString('utf8'));}catch(error){if(error.code==='ENOENT'){const earlier=history?lockHistory(root):null;throw new Error(earlier?`${LOCK} is missing, but this repository's history has one (${earlier.slice(0,12)} has it); a deleted adoption lock is treated as tampering; restore it from the adoption commit`:`this project has not adopted Factotum (no ${LOCK} at its root); use adopt install`);}throw new Error(`${LOCK} is unreadable or not valid JSON (${error.code??'parse error'}); restore it from the adoption commit`);}validLock(lock);if(history)layoutHistory(root,lock);return {lock,sha256:hash(bytes)};}
// The lock on its own: its shape, and its layout evidence, which must rebuild the manifest it pins.
function validLock(lock){check(lock&&typeof lock==='object'&&!Array.isArray(lock)&&lock.formatVersion===1&&versionOK(lock.release?.version)&&sha(lock.release.manifestDigest)&&sha(lock.release.payloadDigest),'invalid adoption lock');if(Object.hasOwn(lock,'prefix')){check(typeof lock.prefix==='string'&&lock.prefix&&normalizePrefix(lock.prefix)===lock.prefix,'invalid adoption lock prefix');check(!Object.hasOwn(lock,'rootLayout'),'invalid adoption lock: root layout evidence with a prefix');check(layoutMatches(lock),`${LOCK} records install prefix ${lock.prefix}, but its managed files and layout do not rebuild the release manifest it names (${lock.release.manifestDigest.slice(0,12)}…); restore the lock from the adoption commit`);}else{check(!Object.hasOwn(lock,'layout'),'invalid adoption lock: layout without a prefix');if(Object.hasOwn(lock,'rootLayout'))check(layoutMatches(lock),`${LOCK}'s managed files and layout do not rebuild the release manifest it names (${lock.release.version}, ${lock.release.manifestDigest.slice(0,12)}…): a managed file's hash in the lock is not the release's; restore the lock from the adoption commit`);}validateFiles(lock.managedFiles);return lock;}
const fileRows=files=>json(files.map(({path,sha256,mode})=>({path,sha256,mode})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0));
// With a verified release directory at hand (readRelease checked it against the pinned digest): a lock
// that names that release must list exactly its managed files and record exactly its release. This
// authenticates a root lock written before dev.87, which carries no layout evidence. A lock that names
// another release is left to the caller, which refuses it in its own words.
function releaseMatches(lock,release){if(!release||lock.release.manifestDigest!==release.manifestDigest)return false;check(fileRows(lock.managedFiles)===fileRows(release.manifest.files.filter(f=>f.owner==='managed'))&&json(lock.release)===json(releaseRecord(release.manifest,release.manifestDigest)),`${LOCK} names release ${lock.release.version} (${lock.release.manifestDigest.slice(0,12)}…), but its managed files are not that release's: the verified release manifest lists other hashes, paths or modes; restore the lock and files from the adoption commit`);return true;}
const unauthenticatedWarning=lock=>`${LOCK} (release ${lock.release.version}) is a root lock written before dev.87, without layout evidence: nothing ties its managed files to the release digest it names, so a managed file replaced together with its hash in the lock is not detected. It stays unauthenticated until the next adoption (adopt update, or upgrade apply), which writes the evidence; activation of a release with such a lock needs that release's verified directory (--release, or the release's own CLI)`;
// Before activation, the lock at the remote target, read from Git as data (nothing there is run):
// a lock that names the pinned release must authenticate its managed files, by its layout evidence or,
// for a root lock without it, against the verified release directory. Without either it is refused.
// A lock that is unreadable or names another release is left to the pull step, which refuses it.
export function authenticateLandedLock(text,{expectedDigest,release=null}){let lock;try{lock=JSON.parse(text);}catch{return null;}if(!lock||typeof lock!=='object'||lock.release?.manifestDigest!==expectedDigest)return null;validLock(lock);const byRelease=releaseMatches(lock,release);check(byRelease||Object.hasOwn(lock,'prefix')||Object.hasOwn(lock,'rootLayout'),`${LOCK} at the target names release ${lock.release.version} (${expectedDigest.slice(0,12)}…) but is a root lock without layout evidence, so it cannot show that its managed files are that release's. Nothing was changed. Pass --release <the release directory with this digest>, or run upgrade apply with that release's own CLI (<release>/starter/factory/cli.mjs), so the files are checked against the verified manifest; or prepare the adoption again with that release's own CLI, which writes the evidence`);return {version:lock.release.version,authenticated:byRelease?'release manifest':'lock layout'};}
function currentFile(root,file,prefix=''){const target=ordinaryPath(join(root,prefix,file.path));if(!existsSync(target))return null;check(lstatSync(target).isFile(),`managed path is not a file: ${file.path}`);return {sha256:hash(readFileSync(target)),mode:lstatSync(target).mode&0o111?0o755:0o644};}
// The prefix folder must be a plain directory path inside this repository: no file, symlink or
// nested Git repository (submodule) anywhere along it. Files under it are checked one by one.
function prefixLocation(root,prefix){if(!prefix)return;
 // A submodule (gitlink) at or above the prefix would keep the installed files out of the adoption commit.
 const objects=new VerifiedObjects(root),head=git(root,['rev-parse','--verify','HEAD^{commit}']),parts=prefix.split('/');
 for(let i=1;i<=parts.length;i++){const path=parts.slice(0,i).join('/'),gitlink=objects.identity(head,path).split('\n').find(row=>row.startsWith('160000 '));check(!gitlink,`install prefix ${prefix} is inside a submodule: ${gitlink?.split(' ').slice(2).join(' ')}`);}
 let current=root;for(const part of prefix.split('/')){current=join(current,part);ordinaryPath(current);if(!existsSync(current))break;check(lstatSync(current).isDirectory(),`install prefix ${prefix} overlaps an existing project file: ${relative(root,current)}`);check(!existsSync(join(current,'.git')),`install prefix ${prefix} is inside a nested Git repository or submodule: ${relative(root,current)}`);}}
// Files Git would not add because the project ignores them; an adoption commit would silently lack them.
function ignoredPaths(root,paths){if(!paths.length)return [];try{return execFileSync('git',[...NO_AUTO_MAINTENANCE,'check-ignore','--no-index','-z','--stdin'],{cwd:root,input:paths.join('\0')+'\0',encoding:'utf8',stdio:['pipe','pipe','pipe'],env:gitEnvironment(),timeout:60000,maxBuffer:32*1024*1024}).split('\0').filter(Boolean);}catch(error){if(error.status===1)return [];throw error;}}
// history:false is the files-only drift check: the lock's own validity and every installed file, without
// the Git history walk, so it also works in a shallow clone.
// `anchor` is the project's record of its lock's authentication (core/adoption-anchor.mjs): with it, a
// root lock without evidence after one with evidence is refused unless `release` authenticates it.
export function adoptionStatus({root,history=true,release=null,anchor}){root=projectRoot(root);const {lock,sha256:lockSha256}=readLockFile(root,{history}),byRelease=releaseMatches(lock,release),evidence=Boolean(evidenceOf(lock)),authenticated=byRelease||evidence,prefix=lock.prefix??'';const downgrade=downgradeProblem(anchor,{version:lock.release.version,evidence,authenticated,lockSha256});check(!downgrade,downgrade);const managed=new Set(lock.managedFiles.map(f=>f.path)),conflicts=[];for(const file of lock.managedFiles){const current=currentFile(root,file,prefix);if(!current||current.sha256!==file.sha256||current.mode!==file.mode)conflicts.push({path:underPrefix(prefix,file.path),reason:current?'locally modified managed file':'missing managed file'});}if(existsSync(join(root,prefix,'factory')))for(const file of inventory(join(root,prefix,'factory')))if(!managed.has('factory/'+file.path))conflicts.push({path:underPrefix(prefix,'factory/'+file.path),reason:'unmanaged file inside upstream-owned factory'});return {version:lock.release.version,release:lock.release,...(prefix?{prefix}:{}),clean:conflicts.length===0,conflicts,authenticated,authenticatedBy:byRelease?'release manifest':evidence?'lock layout':null,evidence,lockSha256,...(authenticated?{}:{warning:unauthenticatedWarning(lock)})};}
// Paths in changes and conflicts are repository-relative (under the prefix, if any); release
// manifests and the lock's managedFiles stay relative to the installation folder.
// Doctor's drift check for an adopted project: the lock is valid and every installed file matches it
// (files only, no history walk, so it works in a shallow clone). No lock: nothing to check here.
// adoptionCheck also returns warnings: a root lock without layout evidence is accepted, unauthenticated.
// With `anchor`, the project's record (doctor passes it), a downgraded root lock is a reason; `status`
// is returned so the caller can record an authentication.
export const adoptionDrift=root=>adoptionCheck(root).reasons;
export function adoptionCheck(root,{anchor}={}){
 try{lstatSync(join(root,LOCK));}catch(error){if(error.code==='ENOENT')return {reasons:[],warnings:[]};}
 try{const status=adoptionStatus({root,history:false,anchor}),warnings=status.warning?[status.warning]:[];return {status,warnings,reasons:status.clean?[]:[`installed Factotum files differ from ${LOCK} (release ${status.version}): ${status.conflicts.slice(0,5).map(c=>`${c.path} (${c.reason})`).join('; ')}${status.conflicts.length>5?` and ${status.conflicts.length-5} more`:''}; restore them from the adoption commit or adopt a release (if only line endings differ, a checkout conversion such as core.autocrlf rewrote them: turn it off for these paths and check them out again)`]};}
 catch(error){return {reasons:[`adoption lock check failed: ${error.message}`],warnings:[]};}
}
export function adoptionPlan({root,releaseDir,expectedDigest,initial=false,prefix}){
 root=projectRoot(root);const release=readRelease(releaseDir,expectedDigest),conflicts=[],changes=[];
 if(initial){prefix=normalizePrefix(prefix);check(!existsSync(join(root,LOCK))&&!(()=>{try{lstatSync(join(root,LOCK));return true;}catch{return false;}})(),'already adopted; use adopt update');const earlier=lockHistory(root);check(!earlier,`this repository's history already has ${LOCK} (last changed in ${earlier?.slice(0,12)}); it was deleted, which is treated as tampering: restore it from the adoption commit and use adopt update`);prefixLocation(root,prefix);check(!existsSync(join(root,prefix,'factory')),`${underPrefix(prefix,'factory')} directory already exists; do not overwrite a previous installation`);for(const file of release.manifest.files){const path=underPrefix(prefix,file.path);ordinaryPath(join(root,path));if(existsSync(join(root,path)))conflicts.push({path,reason:'installation would overwrite existing project file'});changes.push({path,kind:'add',owner:file.owner});}}
 else {const lock=readLock(root),recorded=lock.prefix??'';check(prefix===undefined||normalizePrefix(prefix)===recorded,`this project is installed ${recorded?`under ${recorded}`:'at the repository root'} (recorded in ${LOCK}); an update cannot move it`);prefix=recorded;const next=newLock(release,prefix);check(lock.release.version!==next.release.version||lock.release.manifestDigest===next.release.manifestDigest,'release version reused with different content');conflicts.push(...adoptionStatus({root}).conflicts);const old=new Map(lock.managedFiles.map(f=>[f.path,f]));for(const file of next.managedFiles){const path=underPrefix(prefix,file.path);ordinaryPath(join(root,path));const previous=old.get(file.path);if(!previous&&existsSync(join(root,path)))conflicts.push({path,reason:'new upstream file collides with project file'});if(!previous||file.sha256!==previous.sha256||file.mode!==previous.mode)changes.push({path,kind:previous?'change':'add',owner:'managed'});old.delete(file.path);}for(const file of old.values())changes.push({path:underPrefix(prefix,file.path),kind:'remove',owner:'managed'});}
 // Under a prefix, a folder the project's ignore rules cover would leave files out of the adoption commit.
 if(prefix)for(const path of ignoredPaths(root,changes.filter(c=>c.kind==='add').map(c=>c.path)))conflicts.push({path,reason:'ignored by the project\'s Git ignore rules; the adoption commit would not include it'});
 const next=newLock(release,prefix);return {ok:conflicts.length===0,from:initial?null:readLock(root).release,to:next.release,...(prefix?{prefix}:{}),changes,conflicts,templatePolicy:next.templatePolicy};
}
// Under a prefix, the seeded configuration template's governing-context paths name the
// prefixed files, because configured paths are relative to the repository root.
function seedBytes(path,bytes,prefix){if(!prefix||path!=='project/factotum.template.json')return bytes;let config;try{config=JSON.parse(bytes.toString('utf8'));}catch{return bytes;}for(const entry of config?.context?.files??[])if(typeof entry?.path==='string'&&/^(factory|project)\//.test(entry.path))entry.path=underPrefix(prefix,entry.path);return Buffer.from(json(config));}
export function prepareAdoption({root,releaseDir,expectedDigest,branch,worktreeDir,initial=false,prefix}){
 root=projectRoot(root);check(typeof branch==='string'&&!branch.startsWith('-'),'explicit update branch required');git(root,['check-ref-format','--branch',branch]);const worktree=ordinaryPath(worktreeDir);check(!within(root,worktree)&&!within(worktree,root),'review worktree must be outside project checkout');check(!within(resolve(releaseDir),worktree)&&!within(worktree,resolve(releaseDir)),'worktree must be separate from release');check(!existsSync(worktree),'review worktree already exists');
 check(!git(root,['status','--porcelain','--untracked-files=all']),'commit or preserve existing work before preparing adoption');if(!initial)git(root,['ls-files','--error-unmatch',LOCK]);
 const plan=adoptionPlan({root,releaseDir,expectedDigest,initial,prefix});prefix=plan.prefix??'';check(initial||plan.from.manifestDigest!==plan.to.manifestDigest,'release already adopted');check(plan.ok,'adoption conflicts: '+plan.conflicts.map(c=>`${c.path} (${c.reason})`).join('; '));const head=git(root,['rev-parse','HEAD']);
 git(root,['worktree','add','-b',branch,worktree,head]);
 // Failures leave the isolated review worktree for inspection; the live checkout
 // and installation pointer are never modified, and no branch is committed/pushed.
 const copyPlan=adoptionPlan({root:worktree,releaseDir,expectedDigest,initial,prefix});check(copyPlan.ok,'review worktree differs from checked adoption inputs');const release=readRelease(releaseDir,expectedDigest);
 for(const change of copyPlan.changes){const target=ordinaryPath(join(worktree,change.path)),path=prefix?change.path.slice(prefix.length+1):change.path;if(change.kind==='remove')rmSync(target);else{mkdirSync(dirname(target),{recursive:true});const file=release.manifest.files.find(f=>f.path===path),bytes=readFileSync(join(release.payload,path));check(hash(bytes)===file.sha256,'release changed while copying');writeFileSync(target,file.owner==='template'?seedBytes(path,bytes,prefix):bytes);chmodSync(target,file.mode);}}
 writeFileSync(join(worktree,LOCK),json(newLock(release,prefix)),{flag:initial?'wx':'w',mode:0o644});check(adoptionStatus({root:worktree}).clean,'prepared adoption verification failed');
 return {branch,worktree,baseHead:head,plan:copyPlan,activation:'not activated; review, test and merge, then drain and use upgrade stage/activate plus doctor',cleanup:`after merging, remove the review worktree and branch with: adopt cleanup --root ${shellWord(root)} --branch ${shellWord(branch)} --worktree ${shellWord(worktree)}`};
}
// Remove a review worktree and branch prepared by adopt install/update once the
// branch is merged into the project checkout. Refuses anything unmerged or dirty.
export function cleanupAdoption({root,branch,worktreeDir}){
 root=projectRoot(root);check(typeof branch==='string'&&!branch.startsWith('-'),'explicit review branch required');git(root,['check-ref-format','--branch',branch]);const worktree=resolve(worktreeDir);
 const registered=git(root,['worktree','list','--porcelain']).split('\n\n').map(block=>Object.fromEntries(block.split('\n').map(line=>{const at=line.indexOf(' ');return at<0?[line,true]:[line.slice(0,at),line.slice(at+1)];})));
 const entry=registered.find(row=>row.worktree===worktree);check(entry,'review worktree is not registered with this project checkout');check(entry.branch===`refs/heads/${branch}`,'review worktree is not on the named branch');
 check(!git(worktree,['status','--porcelain','--untracked-files=all']),'review worktree has uncommitted or untracked files');
 const head=git(root,['rev-parse',`refs/heads/${branch}`]);
 // Merged when the branch is an ancestor of HEAD, or (a squash or rebase merge) when merging it
 // into HEAD would change nothing because its content is already there.
 let ancestor=false;try{git(root,['merge-base','--is-ancestor',head,'HEAD']);ancestor=true;}catch{}
 let contained=ancestor;if(!ancestor){try{contained=git(root,['merge-tree','--write-tree','HEAD',head]).trim().split('\n')[0]===git(root,['rev-parse','HEAD^{tree}']).trim();}catch{contained=false;}}
 check(contained,'review branch is not merged into the project checkout HEAD (not an ancestor, and its changes are not already there as after a squash merge)');
 git(root,['worktree','remove',worktree]);git(root,['branch',ancestor?'-d':'-D',branch]);
 return {removedWorktree:worktree,removedBranch:branch,mergedHead:head};
}
