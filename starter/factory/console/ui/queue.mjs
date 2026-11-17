// Queue management and admission readiness; all commands remain project-authoritative.
import {h,card,kv,chip,notice,empty,link,time,button,short,tag} from './dom.mjs';
import {available,href,read,uiState,saveUi, detailHref} from './state.mjs';
import {commandButton} from './actions.mjs';
import {queueEditor,needsRead} from './plan.mjs';
import {admissionHolds,holdList,reapproveButton,staleApproval,reasonNodes,withFlowLinks,queueHoldNode,relativeTimeNode} from './admission.mjs';
const rerender=()=>window.dispatchEvent(new Event('factotum:render'));

// Everything that left the queue: still running (claimed), or started in the last day.
// With automatic admission a queued task can start within seconds, so this shows queueing worked.
function startedFromQueue(project){
  const s=project.snapshot,since=Date.now()-86400000;
  const rows=(s.queue??[]).filter(q=>q.status==='claimed'||q.status==='finished'&&Date.parse(q.claimedAt)>=since).sort((a,b)=>String(b.claimedAt).localeCompare(String(a.claimedAt)));
  if(!rows.length)return null;
  const title=id=>[...(s.tasks??[]),...(s.queueTasks??[])].find(t=>t.id===id)?.title??id;
  return card('Started from the queue',h('ul',{class:'plain-list'},rows.map(q=>{const flow=(s.flows??[]).find(f=>f.id===q.flowId),wait=q.admissionTiming?.readyToAdmissionMs;return h('li',{},link(detailHref({ projectId: project.projectId, task: q.id }),title(q.id)),' ',chip(flow?.state??(q.status==='claimed'?'running':'finished'),['Started ',q.claimedAt?relativeTimeNode(q.claimedAt):'at an unrecorded time',flow?` · ${flow.parked?'parked on an answer':flow.slotWait?'waiting for a slot':flow.state}`:'']),Number.isFinite(wait)?h('span',{class:'muted small',text:` · started ${Math.round(wait/1000)}s after it was ready`}):null,' ',q.flowId?link(detailHref({ projectId: project.projectId, flow: q.flowId }),'Open'):null);})),{subtitle:'Running work, and work started in the last 24 hours.'});
}
// Who holds the flow slots (service: operations/capacity.mjs). A flow waiting on an answer is parked
// and holds none, up to policy.maxParkedFlows; an answered flow that found every slot in use waits
// here with its place in line. Parked and waiting flows are labelled apart from running ones.
export function slotsCard(project){
  const s=project.snapshot,c=s.queueStatus?.capacity;
  if(!c||s.settings?.mode&&s.settings.mode!=='delivery')return null;
  const title=id=>(s.flows??[]).find(f=>f.id===id)?.taskSnapshot?.title??id,open=id=>link(detailHref({ projectId: project.projectId, flow: id }),title(id));
  // Every configured pool, idle ones included (dev.85, I1): an idle pool reads "0 of N in use".
  const POOL_LABELS={change:'Change flows',document:'Document flows'},known=Object.keys(POOL_LABELS),pools=[...known.filter(name=>c.pools?.[name]),...Object.keys(c.pools??{}).filter(name=>!known.includes(name)).sort()];
  const pool=(name,label)=>{const p=c.pools?.[name];if(!p)return null;
    return [label,`${p.inUse} of ${p.max} in use${p.stopped?` (${p.stopped} stopped)`:''}${p.parkedHoldingSlot?` (${p.parkedHoldingSlot} parked beyond the limit)`:''} · ${p.free} free for queued tasks`];};
  const free=c.parked.filter(row=>!row.holdsSlot).length;
  return card('Flow slots',h('div',{class:'stack'},
    kv([...pools.map(name=>pool(name,POOL_LABELS[name]??`${name.replace(/^\w/,ch=>ch.toUpperCase())} flows`)),...Object.entries(c.categories??{}).map(([name,p])=>[`Category ${name}`,`${p.inUse} of ${p.max} in use${p.parked-p.parkedHoldingSlot?` · ${p.parked-p.parkedHoldingSlot} parked without a place`:''} · ${p.free} free for queued tasks`]),['Parked on an answer',`${c.parkedCount} (${free} of ${c.maxParkedFlows} allowed without a slot)`],['Answered, waiting for a slot',String(c.waitingCount)]].filter(Boolean)),
    c.categoryWaits?.length?notice('info','A slot is free while an answered flow waits for its category.',h('ul',{class:'plain-list'},c.categoryWaits.map(row=>h('li',{},withFlowLinks(project,row.text))))):null,
    c.parked.length?h('div',{},h('h4',{text:'Parked on an answer'}),h('ul',{class:'plain-list'},c.parked.map(row=>h('li',{},open(row.flowId),' ',chip('waiting','Parked'),row.holdsSlot?[' ',chip('hold','Holds a slot')]:null,h('span',{class:'muted small'},` · at ${row.step}`,row.since?[' since ',relativeTimeNode(row.since)]:'',row.holdsSlot?' · beyond the parked limit, so it keeps its slot until answered':' · no slot held'))))):null,
    c.waiting.length?h('div',{},h('h4',{text:'Answered, waiting for a slot'}),h('ul',{class:'plain-list'},c.waiting.map(row=>h('li',{},open(row.flowId),' ',chip('waiting',`Position ${row.position} of ${row.of}${row.merge?' · merge':''}`),h('p',{class:'muted small'},withFlowLinks(project,row.reason)))))):null),
    {subtitle:'A flow waiting on an answer holds no slot, up to the parked limit (policy.maxParkedFlows). Answered flows take the next free slot ahead of queued tasks, merges first. Stopped flows keep theirs.'});
}
// Only when the queue cannot move on its own: why, and (with automatic admission off) a manual dispatch.
function queueBanner(project){
  const s=project.snapshot,status=s.queueStatus;
  // The tasks a dispatch skipped because they were refused at admission, each linked, with its reason
  // as text (review of 851fad5): an operator who expected one of them sees why another started.
  const title=id=>[...(s.tasks??[]),...(s.queueTasks??[])].find(t=>t.id===id)?.title??id;
  const taskLink=id=>link(detailHref({ projectId: project.projectId, task: id }),title(id));
  const flowLinkOf=(id,label='this flow')=>id?link(detailHref({ projectId: project.projectId, flow: id }),label):'a flow';
  const skipped=last=>last.refused?.length?h('div',{class:'small'},h('p',{text:last.refused.length===1?'Skipped, because it could not be admitted:':`Skipped ${last.refusedCount>last.refused.length?`${last.refusedCount} tasks (the first ${last.refused.length} shown)`:`${last.refused.length} tasks`}, because they could not be admitted:`}),
    h('ul',{class:'plain-list'},last.refused.map(row=>h('li',{},taskLink(row.taskId),': ',h('span',{text:row.reason}))))):null;
  if(!status)return null;
  const items=[];
  // Holds on the whole queue, then holds on one queued task (scope 'task': a context task whose
  // providers are not qualified, say), each with the task linked (dev.91, O5).
  const whole=status.holds.filter(row=>row.scope!=='task'),one=status.holds.filter(row=>row.scope==='task');
  if(whole.length)items.push(notice('warning','The queue is held.',h('ul',{class:'plain-list'},whole.map(row=>h('li',{},queueHoldNode(project,row))))));
  if(one.length)items.push(notice('warning',one.length===1?'A queued task is held.':'Queued tasks are held.',h('ul',{class:'plain-list'},one.map(row=>h('li',{},row.taskId?[link(detailHref({ projectId: project.projectId, task: row.taskId }),'Open the task'),': ']:null,queueHoldNode(project,row))))));
  if(!status.autoQueue){
    const last=status.lastDispatch,recent=last&&Date.now()-Date.parse(last.createdAt)<3600000;
    const result=!recent?null:['queued','running'].includes(last.status)?h('p',{class:'muted small'},'Dispatch requested ',relativeTimeNode(last.createdAt),'; waiting for the operations loop.')
      :last.outcome==='dispatched'?h('div',{class:'stack dispatch-result'},h('p',{class:'small'},'Last dispatch ',relativeTimeNode(last.createdAt),' started ',last.taskId?[taskLink(last.taskId),' (',flowLinkOf(last.flowId,'its flow'),')']:flowLinkOf(last.flowId),'.'),skipped(last))
      :last.outcome==='no-eligible-task'?h('div',{class:'stack dispatch-result'},h('p',{class:'small'},'Last dispatch ',relativeTimeNode(last.createdAt),' found nothing to start',last.refused?.length?'.':last.heldReasons.length?[': ',reasonNodes(project,null,last.heldReasons)]:' (the queue was empty)',last.refused?.length?'':'.'),skipped(last))
      :last.status==='failed'?h('p',{class:'small'},'Last dispatch ',relativeTimeNode(last.createdAt),' failed.'):null;
    items.push(notice('info','Automatic admission is off.',h('div',{class:'stack'},h('p',{text:'Queued tasks start only when you dispatch the queue here or start a task from Tasks. Set policy.autoQueue to start them automatically.'}),
      commandButton(project,{key:'queue.dispatch',label:'Dispatch now',operation:'job.enqueue',payload:{operation:'queue.dispatch',note:'Operator requested queue dispatch'},subject:{label:'queue dispatch',version:s.queueRevision??null},help:'Starts the first queued task that passes every admission check, if any. A task that passes them but is refused when its flow is admitted (a stored model choice that no longer validates, say) is skipped, and the next queued task is tried; the result below lists each skipped task and why.'}),result)));
  }
  return items.length?h('div',{class:'stack span-all'},items):null;
}
export function queueView(project,route){
  if(!available(project))return notice('warning',`${project.name} is ${project.status}.`,'The queue is unavailable until the project service responds.');
  const s=project.snapshot,rows=(s.queue??[]).filter(q=>q.status==='queued').sort((a,b)=>(a.order??0)-(b.order??0));
  const taskId=route.params.task??rows[0]?.id;
  const detail=taskId?read(project,'tasks',taskId,{}, {onDone:rerender,force:needsRead(project,'tasks',taskId,{})}):null;
  const task=detail?.data?.task??(s.queueTasks??s.tasks??[]).find(t=>t.id===taskId);
  // Why the selected queued task has not started yet, as the project last observed it.
  const selected=task?card('Admission readiness',h('div',{class:'stack'},link(detailHref({ projectId: project.projectId, task: task.id }),task.title),kv([['Task',task.id],['Revision',h('span',{text:tag(task.revision),title:task.revision})],['Approval',staleApproval(task)?'Approved for another workflow; approve again':task.approvedRevision===task.revision?'Approved':'Required']]),reapproveButton(project,task,{key:'queue-reapprove'}),
    s.settings?.mode!=='delivery'?h('p',{class:'muted',text:'Admission readiness is reported for delivery projects.'}):admissionHolds(task).length?notice('info','Not admitted yet.',holdList(project,admissionHolds(task))):h('p',{class:'muted',text:'Nothing holds this task; it starts when it reaches the front of the queue.'}))):card('Admission readiness',detail?.error?notice('warning','Could not read selected task.',detail.error):empty('Select a queued task','Use a task link to see why it has not started yet.'));
  return h('div',{class:'view'},queueBanner(project),
    h('div',{class:'two-col wide-left'},h('div',{class:'stack'},queueEditor(project),slotsCard(project),startedFromQueue(project)),selected));
}
