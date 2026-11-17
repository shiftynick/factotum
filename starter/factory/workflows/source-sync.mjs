import { validNotBefore } from '../operations/not-before.mjs';
import {assert,digest,now,uid} from '../core/contracts.mjs';
import {Store} from '../core/store.mjs';
import {executeCommand} from '../core/project.mjs';
import {createGhTransport} from '../adapters/github/index.mjs';
import {importGitHubTask} from './commission.mjs';
import {runProcess} from '../adapters/providers/index.mjs';
import {sourceSettings} from '../operations/source-config.mjs';
import {assertNoReservedNamespace} from '../core/upkeep-namespace.mjs';
import {commandSourceWrite,sourceCapabilities,validateCreateBrief} from '../operations/source-adapter.mjs';
import {createGitHub} from '../adapters/github/index.mjs';

const states=new Set(['open','closed','unknown']);
const keyOK=k=>typeof k==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(k);
const labels=raw=>(raw.labels??[]).map(l=>typeof l==='string'?l:l.name);
// Why discovery ignores an issue; null when it is eligible.
const ineligibility=(raw,s)=>raw.pull_request?'pull request':raw.state!=='open'?`state ${raw.state}`:s.labels.some(l=>!labels(raw).includes(l))?`missing labels: ${s.labels.filter(l=>!labels(raw).includes(l)).join(', ')}`:s.requireBrief&&!/```factotum-task\s*\n/.test(raw.body??'')?'no fenced factotum-task brief':null;
const eligible=(raw,s)=>!ineligibility(raw,s);
// An open issue that is not a workable task but should still be visible in Tasks.
const trackable=(raw,s)=>!raw.pull_request&&raw.state==='open'&&(s.track==='all-open'||Boolean(s.track?.labels?.some(l=>labels(raw).includes(l))));
// Tracked items are read-only: no brief, no approval, closed when the issue closes.
function trackItem(store,config,s,old,raw,configDigest){
 const control=new Set([...s.labels,...(config.repository.issueProfile?.importBlockedLabels??[])]),own=labels(raw).filter(l=>!control.has(l)).sort().slice(0,16).map(l=>l.slice(0,40));
 const id=`${config.repository.issueProfile?.dependencyIdPrefix??'github:'}${raw.number}`;
 return canonicalPut(store,{id,title:raw.title,acceptance:[],tracked:true,closed:raw.state==='closed',...(own.length?{labels:own}:{}),source:{repository:config.repository.slug,issue:raw.number,url:raw.html_url??null,revision:digest({title:raw.title,state:raw.state,labels:own})}},old,configDigest);
}
function canonicalPut(store,task,prior,expectedConfig){
 assert(store.meta('configDigest')===expectedConfig,'source configuration changed during synchronization');
 const result=executeCommand(store,{protocolVersion:1,projectId:store.meta('project').projectId,commandId:`source-sync-${uid()}`,actor:'operator',operation:'task.put',payload:{task,expectedRevision:prior?.revision??null}});
 assert(result.status==='completed',result.error??'source task update rejected');return result.result;
}
function retireSourceTask(store,prior,reason,observation,configDigest){
 return canonicalPut(store,{...prior,blocked:true,closed:observation.state==='closed',source:{...prior.source,syncDisposition:{reason,identity:digest(observation)}}},prior,configDigest);
}
export async function readCommandSource(config,root,{run=runProcess,signal}={}){
 const s=sourceSettings(config);assert(s.enabled&&s.type==='command','custom issue source not enabled');
 const result=await run(s.argv[0],s.argv.slice(1),{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8'},input:JSON.stringify({version:1,operation:'read',sourceId:s.id,maxItems:s.maxItems}),timeoutMs:s.timeoutMs,signal});
 assert(result.code===0,'issue source read adapter failed');const response=JSON.parse(result.stdout);
 assert(response.version===1&&typeof response.complete==='boolean'&&Array.isArray(response.tasks)&&response.tasks.length<=s.maxItems,'invalid or oversized issue source response');
 const observed=Date.parse(response.observedAt);assert(Number.isFinite(observed)&&observed<=Date.now()&&Date.now()-observed<=60000,'issue source observation is stale');
 const rows=new Map(),facts=new Map();
 for(const row of response.tasks){assert(keyOK(row.key)&&!rows.has(row.key)&&states.has(row.state)&&typeof row.revision==='string'&&row.revision.length>0&&typeof row.eligible==='boolean','invalid or duplicate source task');assert(typeof row.title==='string'&&row.title.trim()&&(()=>{const acceptance=row.acceptance??(row.doneWhen!==undefined?[row.doneWhen].flat():undefined);return Array.isArray(acceptance)&&acceptance.length>0&&acceptance.every(x=>typeof x==='string'&&x.trim());})(),'source task needs title and acceptance (or doneWhen)');rows.set(row.key,row);}
 assert(Array.isArray(response.dependencyFacts??[])&&(response.dependencyFacts??[]).length<=s.maxItems*32,'bounded source dependency facts required');
 for(const fact of response.dependencyFacts??[]){assert(keyOK(fact.key)&&!facts.has(fact.key)&&states.has(fact.state)&&typeof fact.revision==='string'&&fact.revision,'invalid or duplicate source dependency fact');facts.set(fact.key,fact);}
 return {settings:s,response,rows,facts};
}
function commandTask(data,row,prior){
 const {settings:s,response,rows,facts}=data,dependencies=row.dependencies??[];
 assert(Array.isArray(dependencies)&&dependencies.length<=32&&dependencies.every(keyOK)&&new Set(dependencies).size===dependencies.length&&!dependencies.includes(row.key),'invalid custom source dependencies');
 const externalDependencies=dependencies.map(key=>{const fact=facts.get(key)??rows.get(key),identity={taskId:s.namespace+key,state:fact?.state??'unknown',revision:fact?.revision??null,...(typeof fact?.contentRevision==='string'&&fact.contentRevision?{contentRevision:fact.contentRevision}:{}),sourceId:s.id,provenance:'command-issue-state'},old=prior?.source?.externalDependencies?.find(f=>f.taskId===identity.taskId&&f.state===identity.state&&f.revision===identity.revision);return {...identity,observedAt:old?.observedAt??response.observedAt};});
 const brief={id:s.namespace+row.key,title:row.title,acceptance:row.acceptance??(row.doneWhen?[row.doneWhen].flat():undefined),...(typeof row.workflow==='string'&&row.workflow?{workflow:row.workflow}:{}),...(row.notBefore?{notBefore:validNotBefore(row.notBefore)}:{}),...(Array.isArray(row.inputs)?{inputs:row.inputs}:{}),...(row.originalRequest!==undefined?{originalRequest:row.originalRequest}:{}),dependencies:dependencies.map(k=>s.namespace+k),risk:row.risk??'strict',paths:row.paths??[],postMerge:row.postMerge??[],blocked:!row.eligible||row.state!=='open',closed:row.state==='closed',...(row.category?{category:row.category}:{}),...(row.area?{area:row.area}:{})};
 const revision=digest({sourceId:s.id,key:row.key,remoteRevision:row.revision,brief,dependencies:externalDependencies.map(({observedAt,...fact})=>fact)});
 // The item's own content, without dependency facts: a dependency's progress keeps a dependent's approval.
 const contentRevision=digest({sourceId:s.id,key:row.key,remoteRevision:row.revision,brief});
 // Labels group tasks and are not part of the source revision.
 const labels=Array.isArray(row.labels)?[...new Set(row.labels.filter(x=>typeof x==='string'&&x.trim()).map(x=>x.trim().slice(0,40)))].slice(0,16):[];
 return {...brief,...(labels.length?{labels}:{}),source:{kind:'command',sourceId:s.id,namespace:s.namespace,key:row.key,revision,contentRevision,externalDependencies}};
}
export async function verifyCommandSource(config,root,task,options={}){
 if(task.source?.kind!=='command')return;
 const data=await readCommandSource(config,root,options),s=data.settings;
 assert(task.source.sourceId===s.id&&task.source.namespace===s.namespace,'issue source identity changed; synchronize and renew approval');
 const row=data.rows.get(task.source.key);assert(row?.state==='open'&&row.eligible,'custom source task missing, closed or ineligible');
 const current=commandTask(data,row,task);assert(task.source.contentRevision?current.source.contentRevision===task.source.contentRevision:current.source.revision===task.source.revision,'custom source task changed; synchronize and renew approval');
 assert(current.source.externalDependencies.every(f=>f.state==='closed'),'custom source dependency is not closed');
}
export async function syncIssueSource(stateDir,{transport,run=runProcess,signal,expectedConfigDigest}={}){
 const store=new Store(stateDir),config=store.meta('config'),configDigest=store.meta('configDigest'),s=sourceSettings(config),previous=store.meta('sourceSync',{});
 assert(expectedConfigDigest===undefined||expectedConfigDigest===configDigest,'source configuration changed before synchronization');
 const report={configDigest,type:s.type,sourceId:s.id,status:'running',lastAttemptAt:now(),lastObservedAt:previous.configDigest===configDigest?(previous.lastObservedAt??null):null,lastSuccessAt:previous.configDigest===configDigest?(previous.lastSuccessAt??null):null,complete:false,imported:0,changed:0,revoked:0,unchanged:0,skipped:0,skippedItems:[],errors:0};
 const record=()=>store.tx(()=>{store.setMeta('sourceSync',report);store.event('source.sync',{...report});});
 const skip=(issue,reason)=>{report.skipped++;if(report.skippedItems.length<50)report.skippedItems.push({issue,reason});};
 const count=(old,task)=>{if(!old)report.imported++;else if(old.revision===task.revision)report.unchanged++;else{report.changed++;if(old.approvedRevision&&!task.approvedRevision)report.revoked++;}};
 try{
  assert(s.enabled,'issue source synchronization disabled');assert(!store.meta('retentionHold'),'retention prevents source synchronization');
  // A source whose items would land in the reserved upkeep: namespace is refused whole, with the
  // setting named, before any item is read: not item by item at task.put.
  assertNoReservedNamespace(config);record();
  const deadline=Date.now()+s.timeoutMs,guard=()=>{assert(!signal?.aborted&&Date.now()<deadline,'source synchronization canceled or timed out');assert(store.meta('configDigest')===configDigest,'source configuration changed during synchronization');};
  if(s.type==='github'){
   const request=transport??createGhTransport({account:config.repository.account,hostname:config.repository.hostname, ghPath: config.repository.ghPath}),base=`repos/${config.repository.slug}`,tracked=store.all('task').filter(t=>t.source?.kind!=='command'&&t.source?.repository===config.repository.slug&&Number.isSafeInteger(t.source.issue)&&!(t.tracked&&t.closed));// closed tracked items reappear through discovery if reopened
   assert(tracked.length<=s.maxItems,'tracked source tasks exceed maxItems; increase the bound');
   const candidates=new Map();let scanned=0,exhausted=false;
   for(let page=1;scanned<s.maxItems;page++){
    guard();const limit=Math.min(100,s.maxItems),rows=await request({path:`${base}/issues?state=open&sort=updated&direction=desc&per_page=${limit}&page=${page}`});assert(Array.isArray(rows)&&rows.length<=limit,'invalid issue discovery page');const selected=rows.slice(0,s.maxItems-scanned);scanned+=selected.length;
    for(const raw of selected){const reason=ineligibility(raw,s);if(!reason||trackable(raw,s))candidates.set(raw.number,raw);else if(raw.pull_request)report.skipped++;else skip(raw.number,reason);}
    if(rows.length<limit){exhausted=true;break;}
   }
   for(const task of tracked)candidates.set(task.source.issue,null);
   report.complete=exhausted;report.scanned=scanned;
   for(const [issue,cached] of candidates){
    guard();assert(Number.isSafeInteger(issue)&&issue>0,'invalid discovered issue number');const taskId=`${config.repository.issueProfile?.dependencyIdPrefix??'github:'}${issue}`,old=store.get('task',taskId);
    assert(!old||old.source?.repository===config.repository.slug&&old.source.issue===issue,'source import collides with a project-owned task');
    let observed;
    try{
     const raw=await request({path:`${base}/issues/${issue}`});guard();observed=raw;
     if(!eligible(raw,s)){
      if(trackable(raw,s)||(old?.tracked&&raw.state==='closed')){count(old,trackItem(store,config,s,old,raw,configDigest));report.tracked=(report.tracked??0)+1;continue;}
      if(old)count(old,retireSourceTask(store,old,'source closed or no longer eligible',{state:raw.state,body:raw.body??'',title:raw.title,labels:labels(raw).sort()},configDigest));else skip(issue,ineligibility(raw,s));continue;
     }
     const task=await importGitHubTask(stateDir,issue,{transport:args=>args.path===`${base}/issues/${issue}`?Promise.resolve(raw):request(args),expectedConfigDigest:configDigest,allowTrackedImportState:Boolean(old)});count(old,task);
    }catch(error){report.errors++;if(old&&(error.status===404||observed))count(old,retireSourceTask(store,old,'source unavailable or invalid',{state:observed?.state??'unknown',issue,identity:observed?digest({body:observed.body??'',title:observed.title,labels:labels(observed).sort()}):null},configDigest));}
   }
  }else{
   const data=await readCommandSource(config,store.meta('project').root,{run,signal});guard();report.complete=data.response.complete;
   for(const row of data.rows.values()){
    guard();const old=store.get('task',s.namespace+row.key);assert(!old||old.source?.kind==='command'&&old.source.sourceId===s.id,'source import collides with another task owner');
    if(!old&&(!row.eligible||row.state!=='open')){report.skipped++;continue;}
    count(old,canonicalPut(store,commandTask(data,row,old),old,configDigest));
   }
   if(data.response.complete)for(const old of store.all('task').filter(t=>t.source?.kind==='command'&&t.source.sourceId===s.id&&t.source.namespace===s.namespace&&!data.rows.has(t.source.key))){guard();count(old,retireSourceTask(store,old,'source no longer listed',{state:'unknown'},configDigest));}
  }
  report.lastObservedAt=now();report.status=report.errors?'partial':report.complete?'ok':'partial';if(report.status==='ok')report.lastSuccessAt=report.lastObservedAt;record();return report;
 }catch(error){report.status='failed';report.errors++;report.error=error.reservedNamespace?error.message:'Source synchronization failed; inspect the retained worker evidence and source configuration';record();throw error;}
 finally{store.close();}
}

// Create a task in the configured source (GitHub or a command source declaring
// `create`), then import it. The operationId makes a retried job reuse the same task.
// Turn a tracked GitHub issue into a workable task: add the source's eligibility labels and a
// drafted brief to the issue, then import it. The task still needs approval.
export async function promoteSourceTask(stateDir,{payload,transport,expectedConfigDigest}={}){
 const store=new Store(stateDir);let config,configDigest,task;
 try{config=store.meta('config');configDigest=store.meta('configDigest');task=store.get('task',payload?.taskId);}finally{store.close();}
 assert(expectedConfigDigest===undefined||expectedConfigDigest===configDigest,'source configuration changed before promotion');
 const s=sourceSettings(config);assert(s.type==='github','turning a tracked item into a task is supported for GitHub sources');
 assert(task?.tracked===true&&task.source?.issue,'a tracked GitHub item is required');
 const acceptance=payload.acceptance??(payload.doneWhen!==undefined?[payload.doneWhen].flat():undefined);
 assert(Array.isArray(acceptance)&&acceptance.length&&acceptance.every(x=>typeof x==='string'&&x.trim()),'acceptance (or doneWhen) is required');
 const brief={version:1,outcome:typeof payload.outcome==='string'&&payload.outcome.trim()?payload.outcome.trim():task.title,acceptance,...(Array.isArray(payload.paths)&&payload.paths.length?{paths:payload.paths}:{}),...(typeof payload.workflow==='string'&&payload.workflow?{workflow:payload.workflow}:{}),...(['ordinary','strict'].includes(payload.risk)?{risk:payload.risk}:{})};
 const request=transport??createGhTransport({account:config.repository.account,hostname:config.repository.hostname,ghPath:config.repository.ghPath});
 const forge=createGitHub({repository:config.repository.slug,account:config.repository.account,hostname:config.repository.hostname,issueProfile:config.repository.issueProfile,transport:request});
 const promoted=await forge.promoteTask({issue:task.source.issue,labels:s.labels,brief});
 const imported=await importGitHubTask(stateDir,task.source.issue,{transport:request,expectedConfigDigest:configDigest});
 return {...promoted,taskId:imported.id};
}
export async function createSourceTask(stateDir,{payload,operationId,transport,run=runProcess,signal,expectedConfigDigest}={}){
 const store=new Store(stateDir);let config,configDigest,root;
 try{config=store.meta('config');configDigest=store.meta('configDigest');root=store.meta('project').root;}finally{store.close();}
 assert(expectedConfigDigest===undefined||expectedConfigDigest===configDigest,'source configuration changed before task creation');
 const brief=validateCreateBrief(payload?.brief),s=sourceSettings(config),capabilities=sourceCapabilities(config);
 assert(capabilities.create,`the ${s.type} source does not support creating tasks`);
 if(s.type==='github'){
  const request=transport??createGhTransport({account:config.repository.account,hostname:config.repository.hostname,ghPath:config.repository.ghPath});
  const forge=createGitHub({repository:config.repository.slug,account:config.repository.account,hostname:config.repository.hostname,issueProfile:config.repository.issueProfile,transport:request});
  const created=await forge.createTask({operationId,title:brief.title,labels:[...s.labels,...(brief.labels??[])],brief:{version:1,outcome:brief.title,acceptance:brief.acceptance,...(brief.paths?{paths:brief.paths}:{}),...(brief.risk?{risk:brief.risk}:{}),...(brief.category?{category:brief.category}:{}),...(brief.workflow?{workflow:brief.workflow}:{}),...(brief.notBefore?{notBefore:brief.notBefore}:{}),...(brief.originalRequest?{originalRequest:brief.originalRequest}:{})}});
  const task=await importGitHubTask(stateDir,created.number,{transport:request,expectedConfigDigest:configDigest});
  return {source:'github',issue:created.number,url:created.url,taskId:task.id,reconciled:created.reconciled};
 }
 const created=await commandSourceWrite(config,root,{operation:'create',operationId,payload:{brief}},{run,signal});
 assert(typeof created.key==='string'&&created.key,'the command source must return the created task key');
 await syncIssueSource(stateDir,{run,signal,expectedConfigDigest:configDigest});
 return {source:'command',key:created.key,taskId:s.namespace+created.key,reconciled:created.reconciled===true};
}
