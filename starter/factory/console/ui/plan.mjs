// Tasks, queue order and approval. Eligibility shown here is an observation, not authority.
import { h, chip, card, kv, empty, notice, time, relative, short, raw, segmented, button, link, strings, flowName, tag, plural, safeUrl, externalLink } from './dom.mjs';
import { href, available, state, read, uiState, saveUi, patchRoute, detailHref } from './state.mjs';
import { localInput, notBeforeValue } from './scheduled.mjs';
import { commandButton, commandForm } from './actions.mjs';
import { admissionHolds, holdList, holdNode, holdText, reasonNodes, reapproveButton, staleApproval, timeNode } from './admission.mjs';
// A time in the admission observation: local, with the recorded UTC value in its tooltip (dev.85, I3).
const heldAt = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? timeNode(value) : '—';

const rerender = () => window.dispatchEvent(new Event('factotum:render'));
const lines = value => value.split('\n').map(x => x.trim()).filter(Boolean);
const done = f => ['completed', 'failed'].includes(f.state);

// Why the queue admits nothing at the moment, in words for the task detail; '' when it may admit.
export const admissionHeld = s => s.recoveryHold ? 'a recovery hold needs reconciliation' : (s.commissioningRequired ?? s.settings?.commissioningRequired) ? 'doctor has not passed for the current configuration' : s.paused ? 'admission is paused (resume it from Overview)' : '';
// Everything that holds the queue as a whole now (Queue → holds): pause, recovery, retention and
// spending holds, doctor, target health and merges in flight. Falls back to admissionHeld for an
// older project service without queue status.
// With a task, holds scoped to change work (or to another target) that do not apply to it are left out.
// The holds that apply to a task, as { text, scope }: queue-wide ones, those on its kind of work or
// target, and those on this task alone (scope 'task': a context task whose providers are not
// qualified, say). Without queue status, the snapshot's own admission hold, which is queue-wide.
export const queueHoldRows = (s, task) => {
  const kind = task?.workflowSelection?.kind, target = task?.workflowSelection?.target;
  if (s.queueStatus?.holds) return s.queueStatus.holds.filter(row => !(row.scope === 'change' && (kind === 'task' || (target && row.target && row.target !== target))) && !(row.scope === 'task' && row.taskId !== task?.id)).map(row => ({ text: String(row.text ?? row.kind), scope: row.scope ?? null }));
  const held = admissionHeld(s);
  return held ? [{ text: `${held[0].toUpperCase()}${held.slice(1)}.`, scope: null }] : [];
};
export const queueHolds = (s, task) => queueHoldRows(s, task).map(row => row.text);
/** Advisory hints derived from the last observation. The project re-validates every admission. */
// A hold as one sentence of page content, its flows linked (with the project) or as text.
const holdSentence = (project, hold) => { if (!project) return `Project reports: ${holdText(hold).replace(/\.$/, '')}.`; const parts = [holdNode(project, hold)].flat(), last = parts.at(-1); return ['Project reports: ', ...parts, typeof last === 'string' && last.endsWith('.') ? '' : '.']; };
export function startHints(snapshot, task, project = null) {
  const reasons = [];
  if (task.approvedRevision !== task.revision) reasons.push('Current task revision is not approved.');
  if (snapshot.paused) reasons.push('Project admission is paused.');
  if (snapshot.recoveryHold) reasons.push('Recovery hold requires reconciliation.');
  if ((snapshot.flows ?? []).some(f => f.taskId === task.id && !done(f))) reasons.push('This task already has an active or stopped flow.');
  if (snapshot.synthetic && (snapshot.flows ?? []).some(f => !done(f))) reasons.push('Rehearsal projects run one flow at a time; another active or stopped flow owns capacity.');
  for (const hold of admissionHolds(task)) reasons.push(holdSentence(project, hold));
  if (snapshot.settings?.commissioningRequired) reasons.push('Delivery admission is held until doctor passes for the current configuration (Settings → Status → Run doctor, or the CLI).');
  return [...new Set(reasons)];
}
/** A queue draft remains attached to the registration on which editing began. */
export function resetQueueDraft(ui, queued, bindingId) {
  Object.assign(ui, { order: [...queued], base: queued.join(','), bindingId, dirty: false });
  return ui;
}
export function syncQueueDraft(ui, queued, bindingId) {
  if (!ui.order || (!ui.dirty && (ui.base !== queued.join(',') || ui.bindingId !== bindingId))) resetQueueDraft(ui, queued, bindingId);
  return ui;
}

export function queueEditor(project) {
  const s=project.snapshot, tasks=[...(s.tasks??[]),...(s.queueTasks??[])];
  const rows=(s.queue??[]).filter(q=>q.status==='queued').sort((a,b)=>(a.order??0)-(b.order??0)), queued=rows.map(q=>q.id);
  const ui=uiState(`queue:${project.projectId}`,{}), baseKey=JSON.stringify([queued,s.queueRevision??null]);
  const savedMatches=ui.dirty&&ui.bindingId===project.bindingId&&JSON.stringify(ui.order.map(id=>({id,priority:ui.entries?.[id]?.priority??0,pinned:ui.entries?.[id]?.pinned??false})))===JSON.stringify(rows.map(q=>({id:q.id,priority:q.priority??0,pinned:q.pinned??false})));
  if(savedMatches)ui.dirty=false;
  if(!ui.order||!ui.dirty&&(ui.baseKey!==baseKey||ui.bindingId!==project.bindingId)) {
    resetQueueDraft(ui,queued,project.bindingId);Object.assign(ui,{baseKey,entries:Object.fromEntries(rows.map(q=>[q.id,{id:q.id,pinned:q.pinned??false,priority:q.priority??0}]))});
  }
  ui.entries??=Object.fromEntries(rows.map(q=>[q.id,{id:q.id,pinned:q.pinned??false,priority:q.priority??0}]));
  const staleBinding=ui.bindingId!==project.bindingId, order=[...ui.order]; // Never intersect authoritative queue IDs with the bounded task snapshot.
  const dirty=()=>{ui.dirty=true;saveUi();rerender();};
  const move=(i,d)=>{[ui.order[i],ui.order[i+d]]=[ui.order[i+d],ui.order[i]];dirty();};
  const taskFor=id=>tasks.find(t=>t.id===id), title=id=>taskFor(id)?.title??id;
  const listEl=order.length?h('ol',{class:'queue'},order.map((id,i)=>{
    const task=taskFor(id),row=rows.find(q=>q.id===id),observation=row?.eligibility,entry=ui.entries?.[id]??{id,pinned:false,priority:0};
    return h('li',{},h('span',{class:'queue-pos',text:i+1}),h('div',{class:'queue-main'},link(detailHref({ projectId: project.projectId, task: id }),title(id)),link(href({projectId:project.projectId,tab:'queue',params:{task:id}}),'Admission readiness',{class:'small'}),h('p',{class:'muted small',text:`${id}${s.queueDispatchOrder?.includes(id)?` · dispatch position ${s.queueDispatchOrder.indexOf(id)+1}`:''}`}),task?chip(task.approvedRevision===task.revision?'approved':'unapproved',task.approvedRevision===task.revision?'Approved':'Needs approval'):h('p',{class:'muted small',text:'Task detail is outside the current snapshot; this queue entry is preserved.'}),
      observation?h('details',{},h('summary',{text:observation.ready?'Observed ready':'Admission held'}),h('p',{class:'small'},observation.reasons.length?reasonNodes(project,task,observation.reasons):'No blockers at last observation.'),kv([['Observed',heldAt(observation.lastObservedAt)],['Ready since',heldAt(observation.readySince)],['Last not ready',heldAt(observation.lastNotReadyAt)],['Transitions',String(observation.transitions)]],'compact')):h('div',{},h('p',{class:'muted small',text:'Admission has not been observed yet.'}),task?.admissionReasons?.length?h('p',{class:'small'},'Current advisory holds: ',admissionHolds(task).flatMap((hold,i)=>[i?'; ':'',holdNode(project,hold)])):null),
      h('div',{class:'queue-metadata'},h('label',{},h('input',{type:'checkbox',checked:entry.pinned,on:{change:e=>{ui.entries[id]={...(ui.entries[id]??entry),pinned:e.target.checked};dirty();}}}),' Pin position'),h('label',{},'Priority ',h('input',{type:'number',min:-1000000,max:1000000,value:entry.priority,'aria-label':`Priority for ${title(id)}`,dataset:{focusKey:`queue-priority:${id}`},on:{input:e=>{ui.entries[id]={...(ui.entries[id]??entry),priority:Number(e.target.value)};dirty();}}})))),
      h('div',{class:'queue-actions'},button('↑',()=>move(i,-1),{disabled:i===0,'aria-label':`Move ${title(id)} up`,variant:'ghost'}),button('↓',()=>move(i,1),{disabled:i===order.length-1,'aria-label':`Move ${title(id)} down`,variant:'ghost'}),button('Dequeue',()=>{ui.order=ui.order.filter(x=>x!==id);dirty();},{variant:'ghost','aria-label':`Dequeue ${title(id)}`})));
  })):empty('Queue is empty','Add tasks from Tasks. Queueing does not approve a task.');
  const reasons=s.queueComplete!==true||!s.queueRevision?['Upgrade the project service to obtain a complete queue and conditional metadata edits.']:staleBinding?['This queue draft belongs to an earlier registration. Discard it and review the current queue.']:ui.baseKey!==baseKey?['The queue changed since editing began. Discard this draft, review the current queue, then reapply changes.']:!ui.dirty?['No unsaved changes.']:[];
  const save=commandForm(project,{key:'queue.put',title:'Save queue changes',operation:'queue.put',subject:{label:`${order.length} queued`,version:ui.baseKey},fields:[],payload:()=>({taskIds:order,entries:order.map(id=>ui.entries[id]??{id}),expectedTaskIds:queued,expectedQueueRevision:s.queueRevision}),reasons,intro:ui.dirty?'Reorder, priority, pin and dequeue edits apply together. Claimed work is unaffected.':undefined});
  return card('Queued tasks',h('div',{class:'stack'},staleBinding?notice('warning','Queue draft target changed.','It cannot be applied to a replacement registration.'):null,listEl,ui.dirty?button('Discard draft and reload queue',()=>{delete state.ui[`queue:${project.projectId}`];saveUi();rerender();},{variant:'ghost'}):null,save),{subtitle:'Manual order and pins are distinct from dispatch order when queue ranking is enabled.'});
}

export function taskDetail(project, task) {
  // Tracked items mirror source issues for the full picture; they have nothing to approve or run.
  if (task.tracked) return h('div', { class: 'stack' }, card(task.title, h('div', { class: 'stack' },
    h('div', { class: 'plan-status' }, chip(task.closed ? 'closed' : 'tracked', task.closed ? 'Closed' : 'Tracked')),
    kv([['Task ID', task.id], ['Labels', task.labels?.length ? h('span', { class: 'task-chips' }, task.labels.map(label => h('span', { class: 'label-chip', text: label }))) : 'None'], ['Source', task.source?.url ? externalLink(safeUrl(task.source.url), `Issue #${task.source.issue}`, { target: undefined }) : task.source?.issue ? `Issue #${task.source.issue}` : '—'], ['State', task.closed ? 'Closed' : 'Open']]),
    notice('info', 'Tracked item, not a factory task.', 'It is shown for the full picture and closes when its issue closes.'),
    !task.closed && task.source?.issue && project.snapshot.sourceSync?.type === 'github' ? h('details', {}, h('summary', { text: 'Make it a task' }), commandForm(project, { key: `source.promote:${task.id}`, title: 'Make it a task', operation: 'job.enqueue', subject: { label: `tracked ${task.id}`, version: task.revision ?? null },
      fields: [{ name: 'outcome', label: 'Outcome', value: task.title }, { name: 'doneWhen', label: 'Done when (one per line)', type: 'textarea' }, { name: 'paths', label: 'Paths it changes (one per line)', type: 'textarea', required: false }, { name: 'risk', label: 'Risk', type: 'select', options: [['ordinary', 'Ordinary'], ['strict', 'Strict (strict review and your sign-off)']], value: 'ordinary' }, ...workflowField(project)],
      payload: v => ({ operation: 'source.promote', note: `Make ${task.id} a task`, payload: { taskId: task.id, outcome: v.outcome, acceptance: v.doneWhen.split('\n').map(x => x.trim()).filter(Boolean), ...(v.paths.trim() ? { paths: v.paths.split('\n').map(x => x.trim()).filter(Boolean) } : {}), ...(v.workflow ? { workflow: v.workflow } : {}), risk: v.risk } }),
      intro: 'Adds the eligibility labels and this brief to the issue, then imports it as a task. It still needs your approval.', variant: 'secondary' })) : null), { subtitle: `Tracked ${task.id}` }));
  const s = project.snapshot, approved = task.approvedRevision === task.revision;
  const flows = (s.flows ?? []).filter(f => f.taskId === task.id).slice(-5).reverse();
  const subject = { label: `task ${task.id}`, version: task.revision };
  const actions = h('div', { class: 'action-grid' });
  const approval=approvalState(s,task),queued=(s.queue??[]).filter(q=>q.status==='queued').sort((a,b)=>(a.order??0)-(b.order??0)).map(q=>q.id);
  const running=(s.flows??[]).some(f=>f.taskId===task.id&&!done(f)), workable=task.status!=='completed'&&!task.closed&&!task.blocked&&!running, autoQueue=s.settings?.policy?.autoQueue===true;
  // Work runs from the queue: approve and queue in one step, or queue an approved task.
  if (!approved&&workable) actions.append(commandButton(project, { key: `approve:${task.id}`, label: queued.includes(task.id) ? 'Approve' : 'Approve and queue', operation: 'task.approve', payload: { taskId: task.id, revision: task.revision, queue: true }, subject, variant: 'primary', confirm: `Approve “${task.title}”${queued.includes(task.id) ? '' : ' and add it to the end of the queue'}.`, help: admissionHeld(s) ? `It is queued, but nothing is admitted now: ${admissionHeld(s)}.` : autoQueue ? 'The queue admits it automatically when capacity and main health allow.' : 'Automatic queue admission is off: start it from the queue, or with Start now.' }));
  // Approved, but for another workflow: the queue refuses it until approved again (the CLI's task.approve).
  if (approved&&workable) actions.append(reapproveButton(project, task) ?? '');
  if (approved&&workable&&!queued.includes(task.id)) actions.append(commandButton(project,{key:`queue-task:${task.id}`,label:'Queue',operation:'queue.put',payload:{taskIds:[...queued,task.id],expectedTaskIds:queued,expectedQueueRevision:s.queueRevision},subject:{label:'queue order',version:JSON.stringify(queued)},variant:'primary',reasons:s.queueComplete&&s.queueRevision?[]:['Upgrade this project service for conditional queue edits.'],help:admissionHeld(s)?`Appends it to the queue; nothing is admitted now: ${admissionHeld(s)}.`:autoQueue?'Appends it to the queue; admission is automatic.':'Appends it to the queue.'}));
  if (approved&&queued.includes(task.id)) actions.append(h('p', { class: 'muted small', text: `Queued, position ${queued.indexOf(task.id) + 1} of ${queued.length}.` }));
  // With automatic admission on, Start would only bypass the queue order.
  // A stopped flow, or one whose task changed under it: settle it and start again in one step.
  const stuck = flows.find(f => ['stopped', 'ready', 'waiting'].includes(f.state) && (f.state === 'stopped' || f.taskRevision !== task.revision));
  if (stuck && !task.tracked && !task.closed) actions.append(commandForm(project, { key: `restart:${task.id}`, title: 'Start again', operation: 'task.restart', subject, fields: [{ name: 'note', label: 'Why' }], payload: v => ({ taskId: task.id, revision: task.revision, note: v.note }), variant: 'secondary', intro: 'Records an uncertain step as failed at no cost, abandons the open flow, approves this revision and starts a new flow.' }));
  if (!autoQueue&&approved&&workable) actions.append(commandButton(project, { key: `start:${task.id}`, label: 'Start now', operation: 'flow.start', payload: { taskId: task.id, revision: task.revision }, subject, variant: 'secondary', reasons: startHints(s, task, project), confirm: `Start “${task.title}” now, ahead of the queue`, help: 'Automatic queue admission is off, so queued work waits for a start.' }));
  const revoke = approved ? commandForm(project, { key: `revoke:${task.id}`, title: 'Revoke approval', operation: 'task.revoke', subject, fields: [{ name: 'note', label: 'Revocation note' }], payload: v => ({ taskId: task.id, note: v.note }), variant: 'danger', intro: 'Revoking stops this task’s flows.' }) : null;
  const edit = h('details', { class: 'edit-task' }, h('summary', { text: 'Edit brief (creates a new revision)' }), taskForm(project, task));
  const modelEdit = taskModelsEdit(project, task);
  const labelEdit = h('details', { class: 'edit-task' }, h('summary', { text: 'Edit labels' }), commandForm(project, { key: `task.label:${task.id}`, title: 'Save labels', operation: 'task.label', subject: { label: `task ${task.id}`, version: (task.labels ?? []).join(',') }, fields: [{ name: 'labels', label: 'Labels (comma separated)', required: false, value: task.labels?.join(', ') ?? '' }], payload: v => ({ taskId: task.id, labels: labelList(v.labels) }), intro: 'Labels group and filter tasks. They do not change the brief or its approval.', variant: 'secondary' }));
  return h('div', { class: 'stack' },
    card(task.title, h('div', { class: 'stack' },
      h('div', { class: 'plan-status' }, staleApproval(task) ? chip('approval-required', 'Approved for another workflow') : chip(approved ? 'approved' : 'unapproved', approved ? 'Approved revision' : 'Approval required'), task.status ? chip(task.status) : null, task.risk ? chip(task.risk === 'strict' ? 'warn' : 'none', `Risk: ${task.risk}`) : null),
      approval?notice('info',approval.title,approval.detail):null,
      // Why an approved task has not started, as the project last observed it.
      approved&&workable&&admissionHolds(task).length?notice('info','Not started yet.',holdList(project,admissionHolds(task))):null,
      kv([['Task ID', task.id], ['Workflow', task.workflowSelection?.selected ?? task.workflow ?? 'Standard'], ['Not before', task.notBefore ? timeNode(task.notBefore) : undefined], ['Recurring', task.recurring ? `${task.recurring.name}${task.recurring.manual ? ' (Run now)' : ''}` : undefined], ['Labels', task.labels?.length ? h('span', { class: 'task-chips' }, task.labels.map(label => h('span', { class: 'label-chip', text: label }))) : 'None'], ['Models for the next flow', taskModelsView(s, task)], ['Revision', h('span', { text: tag(task.revision), title: task.revision })], ['Source state', task.closed?'Closed':task.blocked?'Blocked / ineligible':'Open'], ['Approval history', approvalLabel(task)], ['Acceptance', strings(task.acceptance)], ['Paths', task.paths ? strings(task.paths) : undefined], ['Area', task.area ?? undefined], ['Dependencies', task.dependencies ? strings(task.dependencies) : undefined], ['Category', task.category ?? undefined], ['Original request', task.originalRequest ? undefined : 'Not recorded'], ['Source', task.source ? (typeof task.source === 'string' ? task.source : JSON.stringify(task.source)) : undefined], ['Approved at', task.approvedAt ? timeNode(task.approvedAt) : undefined]]),
      originalRequestView(task.originalRequest),
      h('h4', { text: 'Actions' }), actions, h('p', { class: 'help', text: 'Reasons are from the latest observation; the project decides when you submit.' }), revoke, modelEdit, labelEdit, edit, raw('Raw task record', task)), { subtitle: `Task ${task.id}` }),
    card('Flows for this task', flows.length ? h('ul', { class: 'plain-list' }, flows.map(f => h('li', {}, link(detailHref({ projectId: project.projectId, flow: f.id }), flowName(f)), ' ', chip(f.state), h('span', { class: 'muted small', text: ` ${f.kind} · ${relative(f.createdAt)}` })))) : h('p', { class: 'muted', text: 'No flows yet.' })));
}

// The models the task's next flow would use, role by role: the task's own choice, or the
// project default from Settings (the first model step of that role in the task's workflow).
const MODEL_ROLES = ['planner', 'builder', 'reviewer'];
const modelText = row => `${row.provider ?? '—'} / ${row.model}${row.effort ? ` · ${row.effort}` : ''}`;
export function taskModelsView(s, task) {
  const workflow = task.workflowSelection?.selected ?? task.workflow ?? 'standard', rows = (s.settings?.stepModels ?? []).filter(row => row.workflow === workflow);
  return h('ul', { class: 'plain-list' }, MODEL_ROLES.map(role => {
    const chosen = task.models?.[role], fallback = rows.find(row => row.role === role);
    if (!chosen && !fallback) return null;
    return h('li', {}, h('strong', { text: `${role}: ` }), chosen ? h('span', {}, `${modelText({ provider: chosen.provider ?? fallback?.provider, ...chosen })} `, chip('tracked', 'Chosen for this task')) : h('span', { class: 'muted', text: `${modelText(fallback)} (project default)` }));
  }));
}
function taskModelsEdit(project, task) {
  if (task.tracked || task.closed) return null;
  const subject = { label: `task ${task.id} models`, version: JSON.stringify(task.models ?? null) };
  return h('details', { class: 'edit-task' }, h('summary', { text: 'Choose models for this task' }),
    commandForm(project, { key: `task.models:${task.id}`, title: 'Save model choice', operation: 'task.models', subject,
      fields: [
        { name: 'role', label: 'Role', type: 'select', options: MODEL_ROLES.map(role => [role, role[0].toUpperCase() + role.slice(1)]), value: 'builder' },
        { name: 'provider', label: 'Provider', type: 'select', options: [['', 'Same as the project default'], ['claude', 'Claude CLI'], ['codex', 'Codex CLI']], value: '', required: false },
        { name: 'model', label: 'Model identifier', help: 'For example claude-fable-5-2 for the most important or complex work. It must be a configured provider and within its allowed models.' },
        { name: 'effort', label: 'Reasoning effort', type: 'select', value: '', required: false, options: [['', 'Inherited'], ...['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(effort => [effort, effort])] },
      ],
      payload: v => ({ taskId: task.id, models: { ...(task.models ?? {}), [v.role]: { model: v.model, ...(v.provider ? { provider: v.provider } : {}), ...(v.effort ? { effort: v.effort } : {}) } }, note: `Chose the ${v.role} model from the console` }),
      intro: 'Applies to this task’s next flow; a running flow keeps its pinned models. It does not change the brief or its approval.', variant: 'secondary' }),
    button('Cancel', event => { const details = event.currentTarget.closest('details'); if (details) details.open = false; }, { variant: 'ghost' }),
    task.models ? commandButton(project, { key: `task.models-reset:${task.id}`, label: 'Use project defaults', operation: 'task.models', payload: { taskId: task.id, models: null }, subject, variant: 'ghost', confirm: 'Clear this task’s model choice?' }) : null);
}

// Where the task came from, shown apart from its acceptance list. Provenance only: nothing here
// approves the task, grants anything or answers a decision.
export function originalRequestView(request) {
  if (!request) return null;
  return h('section', { class: 'original-request stack' }, h('h4', { text: 'Original request' }),
    h('p', { class: 'help', text: 'Provenance, not approval: where this task came from and, for an operator request, their exact words. It does not approve the task, grant anything or answer any decision. The acceptance list is what the task must meet.' }),
    kv([['Origin', request.origin], ['Source', request.source], ['Date', request.date]]),
    request.text !== undefined ? h('blockquote', { class: 'verbatim', text: request.text }) : h('p', { class: 'muted', text: `No operator quotation: this task's origin is ${request.origin}.` }));
}

// A task's full detail by ID, for the shared detail modal.
export function taskDetailById(project, taskId) {
  const s = project.snapshot, entry = read(project, 'tasks', taskId, {}, { onDone: rerender, force: needsRead(project, 'tasks', taskId, {}) });
  if (!entry.data) return entry.status === 'error' ? notice('warning', 'Task detail unavailable.', entry.error) : h('div', { class: 'skeleton', 'aria-busy': 'true', text: 'Loading task…' });
  const d = entry.data, scoped = { ...project, snapshot: { ...s, flows: [...(s.flows ?? []).filter(f => !d.flows.some(x => x.id === f.id)), ...d.flows] } };
  return taskDetail(scoped, d.task);
}
export function approvalState(snapshot,task){
  if(task.approvedRevision!==task.revision||task.status==='completed')return null;
  const active=(snapshot.flows??[]).find(f=>f.taskId===task.id&&f.kind!=='planning'&&!done(f));
  if(active)return {title:active.state==='stopped'?'Approved — work stopped':'Approved — work started',detail:'See the task’s flow for its current progress and required decisions.',canQueue:false};
  const queued=(snapshot.queue??[]).some(q=>q.id===task.id&&q.status==='queued');
  // A queued task is promised automatic admission only when nothing holds the queue or the task itself.
  // dev.93, Q2: a hold on this task alone (scope 'task') holds only it; the tasks behind it still start.
  const rows=queueHoldRows(snapshot,task),holds=rows.filter(row=>row.scope!=='task').map(row=>row.text),taskHolds=rows.filter(row=>row.scope==='task').map(row=>row.text),own=admissionHolds(task).length&&task.admissionObserved!==false;
  if(staleApproval(task))return {title:'Approved for another workflow — not started',detail:`This revision was approved for another workflow (or an earlier version of “${task.workflowSelection.selected}”). Nothing starts it until it is approved again: use Approve again.`,canQueue:!queued};
  const detail=!queued?'Approval permits work on this revision. Use Start to begin, or Queue task to add it to the queue. Queuing starts work automatically only when automatic admission is enabled.'
    :!snapshot.settings?.policy?.autoQueue?'Automatic queue admission is off. Use Start now to begin work, or have the orchestrator dispatch the queue.'
    :holds.length?`Nothing is admitted while the queue is held: ${holds.join(' ')}${taskHolds.length?` This task is also held on its own: ${taskHolds.join(' ')}`:''} Automatic admission resumes once the hold clears${taskHolds.length?', and starts this task once its own hold is lifted too':''}.`
    :taskHolds.length?`This task is held on its own, not the queue: tasks queued behind it still start. ${taskHolds.join(' ')} Automatic admission starts it once this hold is lifted.`
    :own?'Automatic admission will start it once the reasons below clear.':'Automatic admission will start queued work when policy and capacity allow.';
  return {title:queued?'Approved — queued, not started':'Approved — not started',detail,canQueue:!queued};
}

// Create a task in the issue source (for example a GitHub issue); it is imported once created.
export function sourceTaskForm(project, { onCompleted } = {}) {
  const source = project.snapshot.sourceSync, name = source?.type === 'github' ? 'GitHub' : 'the task source';
  return commandForm(project, { onCompleted,
    key: 'source.create', title: `Create in ${name}`, operation: 'job.enqueue', subject: { label: `new ${name} task`, version: project.snapshot.settings?.configDigest ?? null },
    fields: [
      { name: 'title', label: 'Title' },
      { name: 'acceptance', label: 'Acceptance criteria (one per line)', type: 'textarea', rows: 4 },
      { name: 'paths', label: 'Expected paths (one per line)', type: 'textarea', rows: 2, required: false },
      { name: 'labels', label: 'Labels (comma separated)', required: false, help: source?.type === 'github' ? 'Added to the issue with the eligibility labels.' : undefined },
      ...workflowField(project),
      { name: 'notBefore', label: 'Not before (optional, your browser’s time zone)', type: 'datetime-local', required: false },
      { name: 'risk', label: 'Risk', type: 'select', options: [['', 'Not specified'], ['ordinary', 'Ordinary'], ['strict', 'Strict']], required: false },
    ],
    payload: v => ({ operation: 'source.create', note: `Create “${v.title}” in ${name}`, payload: { brief: { title: v.title, acceptance: lines(v.acceptance), ...(lines(v.paths).length ? { paths: lines(v.paths) } : {}), ...(labelList(v.labels).length ? { labels: labelList(v.labels) } : {}), ...(v.risk ? { risk: v.risk } : {}), ...(v.workflow ? { workflow: v.workflow } : {}), ...(v.notBefore ? { notBefore: notBeforeValue(v.notBefore) } : {}) } } }),
    intro: `Creates the task in ${name}, then imports it here. It still needs approval before it runs.`,
  });
}
// Optional workflow choice; empty lets labels, category or the default choose.
const workflowField = (project, value = '') => { const rows = project.snapshot.settings?.workflows ?? []; return rows.length > 1 ? [{ name: 'workflow', label: 'Workflow', type: 'select', required: false, value, options: [['', 'Automatic (labels, category or default)'], ...rows.map(row => [row.name, `${row.name}${row.kind === 'task' ? ' (carried out, no build)' : row.kind === 'document' ? ' (document, review only)' : ''}`])] }] : []; };
const labelList = text => [...new Set(String(text ?? '').split(',').map(label => label.trim()).filter(Boolean))];
// Original request fields for a task the factory owns; a source-backed task keeps the source's.
const ORIGIN_OPTIONS = [['', 'Not recorded'], ['operator', 'Operator request'], ['incident', 'Incident'], ['schedule', 'Schedule or maintenance'], ['review', 'Review follow-up'], ['other', 'Other']];
export const requestFields = request => [
  { name: 'requestOrigin', label: 'Original request: origin', type: 'select', options: ORIGIN_OPTIONS, required: false, value: request?.origin ?? '', help: 'Provenance, not approval. Record the true origin; for anything but an operator request, do not write an operator quotation.' },
  { name: 'requestSource', label: 'Original request: where it was received', required: false, value: request?.source ?? '', placeholder: 'conversation, issue, incident record…' },
  { name: 'requestDate', label: 'Original request: date (YYYY-MM-DD or ISO date-time)', required: false, value: request?.date ?? '' },
  { name: 'requestText', label: 'Original request: verbatim text', type: 'textarea', rows: 3, required: false, raw: true, value: request?.text ?? '', help: 'The operator’s exact words, not a summary. Required for an operator request. Part of the approved brief: changing it needs approval again.' },
];
export function requestValue(v, prior) {
  const text = v.requestText ?? '', hasText = Boolean(text.trim());
  if (!v.requestOrigin) { if (v.requestSource || v.requestDate || hasText) throw new Error('Choose the original request’s origin, or clear its other fields.'); return {}; }
  // The verbatim text is submitted untrimmed. Each field is compared with the recorded one on its
  // own, so a metadata-only edit never rewrites the quotation; a textarea only normalizes line endings.
  const sameText = prior?.text !== undefined && prior.text.replace(/\r\n?/g, '\n') === text.replace(/\r\n?/g, '\n');
  const request = { origin: v.requestOrigin, source: prior?.source?.trim() === v.requestSource ? prior.source : v.requestSource, date: v.requestDate, ...(hasText ? { text: sameText ? prior.text : text } : {}) };
  const same = prior && ['origin', 'source', 'date', 'text'].every(k => prior[k] === request[k]);
  return { originalRequest: same ? prior : request };
}
export function taskForm(project, task, { onCompleted } = {}) {
  return commandForm(project, { onCompleted,
    reasons: project.snapshot.editPreconditions?.taskRevision ? [] : ['This project service must be upgraded before task edits can be saved with a revision precondition.'],
    key: task ? `task.put:${task.id}` : 'task.put:new', title: task ? 'Save new revision' : 'Create task', operation: 'task.put',
    subject: task ? { label: `task ${task.id}`, version: task.revision } : { label: 'new task', version: null },
    fields: [
      ...(task ? [] : [{ name: 'id', label: 'Task ID', placeholder: 'letters, digits, . _ : -', help: 'Stable identifier. To change an existing task, use its Edit brief control.' }]),
      { name: 'title', label: 'Title', value: task?.title ?? '' },
      { name: 'acceptance', label: 'Acceptance criteria (one per line)', type: 'textarea', rows: 4, value: task?.acceptance?.join('\n') ?? '' },
      { name: 'paths', label: 'Expected paths (one per line)', type: 'textarea', rows: 2, required: false, value: task?.paths?.join('\n') ?? '' },
      { name: 'inputs', label: 'Offline inputs (one per line: path, then optionally " — note")', type: 'textarea', rows: 2, required: false, value: (task?.inputs ?? []).map(i => `${i.path}${i.note ? ` — ${i.note}` : ''}`).join('\n'), help: 'Files the work needs that are not fetched during it. The task waits until they exist; git-ignored ones are copied into the worktree.' },
      { name: 'labels', label: 'Labels (comma separated)', required: false, value: task?.labels?.join(', ') ?? '', help: 'For grouping and filtering. Changing labels does not affect approval.' },
      ...workflowField(project, task?.workflow),
      ...(task?.source ? [] : [{ name: 'notBefore', label: 'Not before (optional, your browser’s time zone)', type: 'datetime-local', required: false, value: task?.notBefore ? localInput(task.notBefore) : '', help: 'An approved, queued task waits until this time. Changing it later keeps approval.' }]),
      { name: 'risk', label: 'Risk', type: 'select', options: [['', 'Not specified'], ['ordinary', 'Ordinary'], ['strict', 'Strict']], required: false, value: task?.risk ?? '' },
      ...(task?.source ? [] : requestFields(task?.originalRequest)),
    ],
    payload: v => ({ expectedRevision: task?.revision ?? null, task: { ...(task ? Object.fromEntries(['source', 'dependencies', 'area', 'postMerge', 'category', 'blocked', 'closed', 'recovery', ...(task.source ? ['originalRequest'] : [])].filter(k => task[k] !== undefined).map(k => [k, task[k]])) : {}), id: task?.id ?? v.id, title: v.title, acceptance: lines(v.acceptance), ...(lines(v.paths).length ? { paths: lines(v.paths) } : {}), ...(lines(v.inputs).length ? { inputs: lines(v.inputs).map(line => { const [path, ...note] = line.split(' — '); const prior = task?.inputs?.find(i => i.path === path.trim()); return { path: path.trim(), ...(prior?.sha256 ? { sha256: prior.sha256 } : {}), ...(note.length ? { note: note.join(' — ').trim() } : {}) }; }) } : {}), ...(v.risk ? { risk: v.risk } : {}), labels: labelList(v.labels), ...(v.workflow ? { workflow: v.workflow } : {}), ...(task?.source ? {} : requestValue(v, task?.originalRequest)), ...(task?.source ? {} : { notBefore: notBeforeValue(v.notBefore) }) } }),
    intro: task ? 'A changed brief needs fresh approval and stops existing flows for this task.' : 'New tasks need explicit approval before they can start.',
    variant: task ? 'secondary' : 'primary',
  });
}

export function tasksView(project, route) {
  if (!available(project)) return notice('warning', `${project.name} is ${project.status}.`, 'Tasks are unavailable until the project service responds.');
  const s = project.snapshot;
  const pageUi=uiState(`tasks-page:${project.projectId}`,{cursor:0});
  const page=read(project,'collections','task',{cursor:String(pageUi.cursor),limit:'50',order:'desc'},{onDone:rerender,force:needsRead(project,'collections','task',{cursor:String(pageUi.cursor),limit:'50',order:'desc'})});
  const tasks=page.data?.items??[];
  const ui = uiState(`tasks:${project.projectId}`, { filter: 'open' });
  const open=t=>!t.closed&&t.status!=='completed';
  const matches=t=>(!ui.label||(t.labels??[]).includes(ui.label))&&(ui.filter==='all'||(ui.filter==='tracked'?t.tracked&&open(t):ui.filter==='approval'?!t.tracked&&t.approvedRevision!==t.revision&&open(t):ui.filter==='ready'?t.approvedRevision===t.revision:open(t)));
  const shown = tasks.filter(matches);
  let selected=tasks.find(t=>t.id===route.params.task)??(!route.params.task?shown[0]:null);
  const detail=route.params.task?read(project,'tasks',route.params.task,{}, {onDone:rerender,force:needsRead(project,'tasks',route.params.task,{})}):null;
  if(detail?.status==='ready')selected=detail.data.task;
  const detailProject=detail?.status==='ready'?{...project,snapshot:{...s,flows:[...(s.flows??[]).filter(f=>!detail.data.flows.some(d=>d.id===f.id)),...detail.data.flows]}}:project;
  // Each row links to the task; open unapproved tasks also get an inline Approve.
  const needs=t=>!t.tracked&&t.approvedRevision!==t.revision&&!t.closed&&!t.blocked&&t.status!=='completed';
  const listEl = h('div', { class: 'task-list', role: 'list' }, shown.map(t => h('div', { role: 'listitem', class: ['task-row-wrap', selected?.id === t.id ? 'active' : ''] },
    h('a', { class: 'task-row', href: detailHref({ projectId: project.projectId, task: t.id }), 'aria-current': selected?.id === t.id ? 'true' : undefined },
      h('span', { class: 'task-title', text: t.title }), h('span', { class: 'muted small', text: [t.workflowSelection?.selected ?? t.category, t.id, t.closed?'closed':t.blocked?'blocked / ineligible':'open'].filter(Boolean).join(' · ') }),
      h('span', { class: 'task-chips' }, t.tracked ? chip(t.closed ? 'closed' : 'tracked', t.closed ? 'Closed' : 'Tracked') : staleApproval(t) ? chip('approval-required', 'Approve again: workflow changed') : chip(t.approvedRevision === t.revision ? 'approved' : needs(t) ? 'approval-required' : 'unapproved', approvalLabel(t)), ...(t.labels ?? []).map(label => h('span', { class: 'label-chip', text: label })), t.status ? chip(t.status) : null)))));
  const left = h('div', { class: 'stack' },
    card('Tasks', h('div', { class: 'stack' }, h('div', { class: 'task-filters' },
        h('label', { class: 'label-filter' }, 'Show ', h('select', { on: { change: e => { ui.filter = e.target.value; saveUi(); rerender(); } } }, [['open', 'Open', tasks.filter(open).length], ['approval', 'Needs approval', tasks.filter(t=>!t.tracked&&t.approvedRevision!==t.revision&&open(t)).length], ['ready', 'Approved', tasks.filter(t => t.approvedRevision === t.revision).length], ...(tasks.some(t => t.tracked) ? [['tracked', 'Tracked', tasks.filter(t => t.tracked && open(t)).length]] : []), ['all', 'All', tasks.length]].map(([value, label, count]) => h('option', { value, text: `${label} (${count})`, selected: ui.filter === value })))),
        (()=>{const all=[...new Set(tasks.flatMap(t=>t.labels??[]))].sort();return all.length?h('label',{class:'label-filter'},'Label ',h('select',{on:{change:e=>{ui.label=e.target.value||null;saveUi();rerender();}}},h('option',{value:'',text:'All labels'}),all.map(label=>h('option',{value:label,text:label,selected:ui.label===label})))):null;})()), shown.length?listEl:empty(page.status==='loading'?'Loading tasks…':page.status==='error'?'Task collection unavailable':'No tasks in this filter'))),
    h('p',{class:'muted small',text:`${shown.length} shown of ${plural(tasks.length,'task')} on this page · ${page.data?.total??s.taskCount??'?'} total. Filters apply to this page.`}),
    h('div',{class:'button-row'},button('Previous page',()=>{pageUi.cursor=Math.max(0,pageUi.cursor-50);saveUi();rerender();},{disabled:!pageUi.cursor,variant:'ghost'}),button('Next page',()=>{pageUi.cursor=page.data.nextCursor;saveUi();rerender();},{disabled:page.status!=='ready'||page.data.nextCursor===null,variant:'ghost'})),
    page.error?notice('warning','Task collection could not be refreshed.',page.error):null);
  const source=s.sourceSync;
  // One compact line: source state, last observation and a refresh action.
  const refreshBlocked=source?.enabled?null:s.settings?.mode==='rehearsal'?'runs in delivery mode':'disabled or needs a newer project service';
  const sourcePanel=h('div',{class:'source-bar'},h('strong',{text:'Task source'}),h('span',{class:'muted small',text:source?[source.type,source.status,source.lastObservedAt?`observed ${relative(source.lastObservedAt)}`:'never observed',source.lastObservedAt?`${source.imported??0} imported · ${source.changed??0} changed${source.errors?` · ${source.errors} errors`:''}${source.complete?'':' · incomplete'}`:null,source.configurationCurrent===false?'configuration changed; refresh required':null].filter(Boolean).join(' · '):'unavailable'}),
    refreshBlocked?h('span',{class:'muted small',text:`Refresh ${refreshBlocked}.`}):commandButton(project,{key:'source.sync',label:'Refresh',operation:'job.enqueue',payload:{operation:'source.sync',note:'Operator requested task source refresh from Tasks'},subject:{label:'task source',version:s.settings?.configDigest??null},variant:'ghost'}));
  return h('div', { class: 'view' },sourcePanel,h('div',{class:'two-col wide-right'}, left, selected ? taskDetail(detailProject,selected) : card('Task detail',detail?.status==='error'?notice('warning','Task detail unavailable.',detail.error):empty(route.params.task?'Loading selected task…':'No tasks yet','Create a task to describe the outcome and its acceptance criteria.'))));
}

// Compatibility export for older integrations; routing maps /plan to Tasks.
export const planView=tasksView;
export function needsRead(project,kind,subject,query){
  const suffix=`/${kind}/${encodeURIComponent(subject)}?${new URLSearchParams({bindingId:project.bindingId,...query})}`;
  const entry=[...state.reads.entries()].find(([key])=>key.startsWith(`${project.projectId}|${project.bindingId}|`)&&key.endsWith(suffix))?.[1];
  return !!entry?.stale&&entry.status!=='loading';
}
export function approvalLabel(task){
  if(task.approvedRevision===task.revision)return 'Approved';
  if(task.approvalHistory?.event==='task.revoked')return 'Approval revoked';
  if(task.approvalHistory?.event==='task.approval-revoked')return 'Approval invalidated by changed brief';
  return 'Approval required';
}
