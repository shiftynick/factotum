import {assert} from '../core/contracts.mjs';
export function sourceSettings(config){
 const s=config.sourceSync??{},type=s.type??'github';
 assert(s.enabled===undefined||typeof s.enabled==='boolean','source enabled must be boolean');
 assert(s.requireBrief===undefined||typeof s.requireBrief==='boolean','source requireBrief must be boolean');
 assert(s.create===undefined||typeof s.create==='boolean','source create must be boolean');
 // track: also import issues that are not workable tasks, as read-only tracked items.
 assert(s.track===undefined||s.track==='all-open'||s.track&&Array.isArray(s.track.labels)&&s.track.labels.length>0&&s.track.labels.length<=32&&s.track.labels.every(x=>typeof x==='string'&&x.trim())&&Object.keys(s.track).every(k=>k==='labels'),'source track must be "all-open" or {labels:[...]}');
 assert(s.capabilities===undefined||Array.isArray(s.capabilities)&&s.capabilities.every(x=>['create','lifecycle','close'].includes(x))&&new Set(s.capabilities).size===s.capabilities.length,'source capabilities must be a unique subset of create, lifecycle and close');
 assert(['github','command'].includes(type),'unsupported issue source type');
 const maxItems=s.maxItems??100,timeoutMs=s.timeoutMs??60000;
 assert(Number.isSafeInteger(maxItems)&&maxItems>=1&&maxItems<=500,'source maxItems must be 1..500');
 assert(Number.isSafeInteger(timeoutMs)&&timeoutMs>=1000&&timeoutMs<=300000,'source timeout must be 1..300 seconds');
 const result={...s,type,maxItems,timeoutMs,enabled:s.enabled!==false,id:s.id??'issues'};
 assert(typeof result.id==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(result.id),'invalid source identity');
 if(type==='github'){
  result.labels=s.labels??config.repository?.issueProfile?.requiredLabels??[];
  result.requireBrief=s.requireBrief!==false;
  assert(Array.isArray(result.labels)&&result.labels.length<=32&&result.labels.every(x=>typeof x==='string'&&x.trim()&&x.length<=100),'source labels must be nonempty strings');
  assert(result.requireBrief||result.labels.length>0,'source discovery requires a fenced brief or explicit eligibility labels');
 }else{
  assert(Array.isArray(s.argv)&&s.argv.length>0&&s.argv.every(x=>typeof x==='string'&&x.length),'source read adapter argv required');
  assert(typeof s.namespace==='string'&&/^[a-zA-Z][a-zA-Z0-9_-]*:$/.test(s.namespace)&&!['github:','job:','maintenance:'].includes(s.namespace),'custom source requires a separate task namespace');
 }
 return result;
}
