import { h, chip, card, kv, empty, notice, time, relative, duration, between, link, plural, short, button, flowName, localizeTimes } from './dom.mjs';
import { state, href, available, openDecisions, openTodos, openItemCount, activeFlows, projectState, navigate, detailHref, commissioningRequired } from './state.mjs';
import { commandForm, projectBlockers } from './actions.mjs';
import { eventList } from './records.mjs';
import { admissionHeld } from './plan.mjs';
import { QUEUE_HOLD, listed } from './admission.mjs';

// Queued tasks held on their own (dev.93, Q3): queue status holds with scope 'task', such as a
// context task whose providers are not qualified. Each holds only its task; the rest still start.
export const heldTaskIds = s => [...new Set((s?.queueStatus?.holds ?? []).filter(row => row?.scope === 'task' && typeof row.taskId === 'string').map(row => row.taskId))];
const heldTaskText = n => `${plural(n, 'queued task is', 'queued tasks are')} held on ${n === 1 ? 'its' : 'their'} own`;
// What the rest of the queue does meanwhile (review of e58abd1, P2): it still starts only when no
// other hold stops admission. A hold on the whole queue (a pause or drain, recovery, retention,
// spending, doctor, a stalled launch, a failed claim) holds it all; a hold scoped to change work
// (main verification, a merge in flight, a target sync) holds change and document tasks; with
// automatic admission off, queued tasks start only when dispatched. An older project service
// without queue status: the snapshot's own admission hold.
export function restOfQueue(s) {
  const whole = [], change = [];
  if (Array.isArray(s?.queueStatus?.holds)) { for (const row of s.queueStatus.holds) if (row?.scope !== 'task') (row?.scope === 'change' ? change : whole).push(QUEUE_HOLD[row?.kind] ?? `the queue is held (${row?.kind ?? 'unknown'})`); }
  else { const held = s ? admissionHeld(s) : ''; if (held) whole.push(held); }
  if (whole.length) return `The rest of the queue is held too: ${listed([...new Set(whole)])}.`;
  const parts = [];
  if (change.length) parts.push(`change and document tasks in the rest of the queue wait too, because ${listed([...new Set(change)])}`);
  if ((s?.queueStatus?.autoQueue ?? s?.settings?.policy?.autoQueue) === false) parts.push('automatic admission is off, so the rest of the queue starts only when dispatched');
  return parts.length ? `${parts.join('; ').replace(/^./, c => c.toUpperCase())}.` : 'The rest of the queue still starts.';
}
/** Attention items derived from recorded state; every item names its project. */
export function attention(project) {
  const items = [], to = (tab, params, label) => ({ href: href({ projectId: project.projectId, tab, params }), label });
  if (project.status !== 'available') return [{ tone: 'warn', title: `${project.status === 'incompatible' ? 'Incompatible' : 'Unavailable'} project`, detail: `${project.error ?? 'No response'}. Its decisions, work and health are unknown, not empty.`, action: to('settings', {}, 'Connection details') }];
  const s = project.snapshot;
  if (state.unresolved.has(project.projectId)) items.push({ tone: 'warn', title: 'Unresolved command outcome', detail: 'Further console actions for this project wait for receipt reconciliation.', action: to('receipts', {}, 'Open receipts') });
  if (s.recoveryHold) items.push({ tone: 'bad', title: 'Recovery hold', detail: `${holdCause(s.recoveryHoldReason)} Reconcile evidence through the project CLI and release the hold (restore.release) before admission resumes.`, action: to('records', {}, 'Open Health') });
  // Faults that do not threaten state integrity: work continues, but the problem stays visible until it clears.
  if (s.health?.notifications?.status === 'paused') items.push({ tone: 'warn', title: 'Notification delivery paused', detail: `${s.health.notifications.problem}. Work is not affected; delivery resumes by itself once the notification configuration file is valid.`, action: to('settings', {}, 'Settings') });
  if (s.health?.operationsFault) items.push({ tone: 'warn', title: 'Operations loop fault', detail: `${s.health.operationsFault.error}. Recorded since ${s.health.operationsFault.since}; it clears when the loop next succeeds. Running work is not stopped.`, action: to('records', {}, 'Open Health') });
  // The project service's attempt-environment check (dev.105): a difference and a pending start check hold
  // new work; an unverified check is a warning; a result from an earlier service run is shown as stale.
  { const env = s.health?.attemptEnvironment;
    if (env?.status === 'differs') items.push({ tone: 'bad', title: 'Attempt environment differs', detail: `${env.reasons?.[0] ?? 'Attempt units resolve a different node or git than the project service.'} Checked at ${env.checkedAt}. No new task flow or maintenance that runs the project's tools starts until the project service next finds no difference; running work is not stopped.`, action: to('records', {}, 'Open Health') });
    else if (env?.status === 'pending') items.push({ tone: 'info', title: 'Checking the attempt environment', detail: `The project service is checking which node and git attempt units run. New work waits until it records a result, at most until ${env.pendingUntil}.`, action: to('queue', {}, 'Open Queue') });
    else if (env?.status === 'unverified') items.push({ tone: 'warn', title: 'Attempt environment not verified', detail: `${env.warnings?.[0] ?? env.reason ?? 'The project service could not check which node and git an attempt unit runs.'} Checked at ${env.checkedAt}; the project service checks again when it next starts.`, action: to('records', {}, 'Open Health') });
    else if (env?.status === 'stale') items.push({ tone: 'info', title: 'Attempt environment check is from an earlier service run', detail: `An earlier run of the project service recorded ${env.recordedStatus} at ${env.checkedAt}. It is not a current result; the project service checks again when it next starts.`, action: to('records', {}, 'Open Health') }); }
  for (const row of (s.providerLimits?.providers ?? []).filter(row => row.held)) items.push({ tone: 'warn', title: `Provider held · ${row.provider}`, detail: `${row.hold.reason}. New work that would start ${row.provider} waits until ${row.hold.until}; running work continues. Clear or extend with provider.hold.`, action: to('stats', {}, 'Provider limits') });
  for (const a of (s.attempts ?? []).filter(a => a.status === 'uncertain' && a.classification === 'limit-exhausted')) items.push({ tone: 'bad', title: `Usage limit reached · ${a.step}`, detail: `${a.reason ?? 'The provider reported its usage limit reached'}. Inspect the attempt, then reconcile it; it is not retried.`, action: to('timeline', { flow: a.flowId, attempt: a.id }, 'Inspect attempt') });
  for (const a of (s.attempts ?? []).filter(a => a.status === 'uncertain' && a.classification !== 'limit-exhausted')) items.push({ tone: 'bad', title: `Uncertain attempt · ${a.step}`, detail: `${a.reason ?? 'Settlement could not be established'}. It is not treated as failed or retried.`, action: to('timeline', { flow: a.flowId, attempt: a.id }, 'Inspect attempt') });
  for (const q of openDecisions(project)) items.push({ tone: 'info', title: q.kind === 'notice' ? 'Operational notice' : q.role === 'operator' ? 'Decision awaiting you' : `Waiting for ${q.role}`, detail: q.question ?? q.title ?? q.summary ?? q.context ?? q.id, action: to('inbox', { item: q.id }, q.kind === 'notice' ? 'Open notice' : 'Open decision') });
  for (const f of (s.flows ?? []).filter(f => f.state === 'stopped')) items.push({ tone: 'warn', title: `Stopped · ${flowName(f)}`, detail: f.stopReason ?? 'Stopped', action: to('timeline', { flow: f.id }, 'Open timeline') });
  if (s.settings?.holds?.moneyHold || s.spending?.enabled && s.spending.globalHold) items.push({ tone: 'bad', title: 'Paid integrations held', detail: 'Spending needs settlement and review before paid work runs again.', action: to('records', {}, 'Open Health') });
  if (s.mainHealth?.status === 'red') items.push({ tone: 'bad', title: 'Main verification red', detail: s.mainHealth.note ?? s.mainHealth.reason ?? 'Latest main check failed', action: to('records', {}, 'Main health') });
  { const held = heldTaskIds(s); if (held.length) items.push({ tone: 'warn', title: heldTaskText(held.length), detail: `Each hold is on that task only. ${restOfQueue(s)} Queue names each task, why it is held and how to lift it.`, action: to('queue', held.length === 1 ? { task: held[0] } : {}, 'Open Queue') }); }
  if (commissioningRequired(project)) items.push({ tone: 'warn', title: 'Commissioning required', detail: `${doctorProgress(s)} Nothing is admitted until doctor passes for the current configuration.`, action: to('settings', { section: 'status' }, 'Run doctor in Settings') });
  const pendingObligations = (s.obligations ?? []).filter(o => !['passed', 'failed', 'deferred'].includes(o.status));
  if (pendingObligations.length) items.push({ tone: 'info', title: plural(pendingObligations.length, 'to-do'), detail: pendingObligations.slice(0, 2).map(o => o.title ?? o.id).join(' · '), action: to('inbox', {}, 'Open Inbox') });
  // Upkeep candidates are findings too; they are counted with knowledge upkeep in Health, not as audit findings.
  const findings = (s.findings ?? []).filter(f => f.status === 'unapproved' && f.source !== 'upkeep');
  if (findings.length) items.push({ tone: 'info', title: plural(findings.length, 'unapproved audit finding'), detail: findings.slice(0, 2).map(f => f.title).join(' · '), action: to('records', {}, 'Review') });
  // A suspended part of knowledge upkeep stays suspended until you lift it.
  for (const row of s.upkeep?.suspensions ?? []) items.push({ tone: 'warn', title: `Knowledge upkeep suspended (${row.part === 'all' ? 'everything' : row.part === 'model' ? 'the model call' : row.part})`, detail: row.reason ?? row.rule, action: to('records', {}, 'Open Health') });
  return items;
}
// Where a console-requested doctor run is, for the commissioning hold.
export function doctorProgress(s) {
  const d = s.settings?.doctorRequest;
  if (d && d.configDigest === s.settings?.configDigest) {
    if (d.status === 'queued') return 'A doctor run was requested and is queued.';
    if (d.status === 'running') return d.waitingFor ? `Doctor is waiting for the shared ${d.waitingFor.resource} permit.` : 'Doctor is running.';
    if (d.status === 'failed') return `Doctor failed: ${(d.reasons ?? []).slice(0, 2).join('; ') || 'no reason recorded'}.`;
  }
  return 'Doctor has not passed for the current configuration.';
}
export const holdCause = reason => !reason ? 'The cause of this hold was not recorded (a restore or a fault before this release).' : `${{ restore: 'This state was restored from a backup', 'runner-fault': 'The flow runner faulted', 'operations-fault': 'The operations loop hit a state-integrity fault' }[reason.cause] ?? reason.cause}${reason.error ? `: ${reason.error}` : ''}.`;
export function attentionList(items, { showProject } = {}) {
  if (!items.length) return empty('Nothing needs attention', 'No decisions, holds, uncertain attempts or stopped flows were observed in reachable projects.');
  return h('ul', { class: 'attention' }, items.map(item => h('li', { class: `tone-${item.tone}` },
    h('div', {}, showProject ? h('span', { class: 'eyebrow', text: item.project }) : null, h('strong', { text: item.title }), h('p', { class: 'muted', text: localizeTimes(item.detail) })),
    item.action ? link(item.action.href, item.action.label, { class: 'btn btn-ghost btn-small' }) : null)));
}

function stepProgress(project, flow) {
  const steps = (project.snapshot.settings?.workflow?.steps ?? []).filter(s => s.kind !== 'end');
  const known = flow.kind !== 'planning' && steps.some(s => s.id === flow.step);
  if (!known) return h('p', { class: 'muted', text: `Current step: ${flow.step}` });
  const visited = new Set(Object.keys(flow.visits ?? {}));
  return h('ol', { class: 'steps', 'aria-label': `Workflow progress for ${flowName(flow)}` }, steps.filter(s => visited.has(s.id) || s.id === flow.step || !s.id.includes('-question')).map(step => {
    const status = step.id === flow.step ? 'current' : visited.has(step.id) ? 'visited' : 'future';
    return h('li', { class: `step step-${status}`, title: `${step.id} (${status})` }, h('span', { class: 'sr-only', text: `${status}: ` }), step.id);
  }));
}

export function flowCard(project, flow) {
  const elapsedMs = between(flow.createdAt, flow.finishedAt ?? project.observedAt);
  return h('article', { class: 'flow-card' },
    h('header', {}, h('div', {}, link(detailHref({ projectId: project.projectId, flow: flow.id }), flowName(flow), { class: 'flow-id' })), chip(flow.state)),
    h('p', { class: 'muted small', text: `${flow.kind} · step ${flow.step} · ${flow.finishedAt ? `ran ${duration(elapsedMs)}` : `${duration(elapsedMs)} since admission (as of observation)`}` }),
    // Only a stopped flow shows why; an earlier stop stays in its events after a resume.
    flow.state === 'stopped' && flow.stopReason ? h('p', { class: 'warn-text', text: `Stop reason: ${localizeTimes(flow.stopReason)}` }) : null,
    stepProgress(project, flow));
}

export function globalOverview() {
  const projects = state.projects;
  if (state.loading && !projects.length) return h('div', { class: 'skeleton', 'aria-busy': 'true', text: 'Loading registered projects…' });
  if (!projects.length) return empty('No registered projects', 'Register a project service socket with the console CLI: node factory/cli.mjs register --state <console state dir> --socket <project socket>, then reload.');
  const reachable = projects.filter(available);
  const decisions = reachable.flatMap(p => openDecisions(p).map(q => ({ p, q })));
  const items = projects.flatMap(p => attention(p).map(item => ({ ...item, project: p.name })));
  const kpis = h('div', { class: 'kpis' },
    kpi('Projects reachable', `${reachable.length} / ${projects.length}`, projects.length - reachable.length ? `${projects.length - reachable.length} unknown` : 'all reachable'),
    kpi('Open inbox items', reachable.reduce((n, p) => n + openItemCount(p), 0), `${decisions.length} questions and notices · ${reachable.reduce((n, p) => n + openTodos(p).length, 0)} to-dos${reachable.length < projects.length ? ' · reachable projects only' : ''}`),
    kpi('Active flows', reachable.reduce((n, p) => n + activeFlows(p).filter(f => f.state !== 'stopped').length, 0), 'running or waiting'),
    kpi('Unresolved commands', state.journal.filter(c => !['completed', 'rejected'].includes(c.status)).length, 'awaiting receipts'));
  const grid = h('div', { class: 'project-grid' }, projects.map(projectCard));
  return h('div', { class: 'view' }, kpis,
    h('div', { class: 'two-col wide-left' }, card('Projects', grid, { subtitle: 'Each project is independently authoritative. Select one for its scoped views.' }), card('Needs attention', attentionList(items, { showProject: true }), { subtitle: 'Derived from the last observation of each project.' })));
}
export function kpi(label, value, detail, cls = '', action = null) { return h('div', { class: `kpi ${cls}` }, h('span', { class: 'kpi-label', text: label }), h('span', { class: 'kpi-value', text: value }), detail ? h('span', { class: 'kpi-detail', text: detail }) : null, action); }

function projectCard(project) {
  const st = projectState(project), go = tab => href({ projectId: project.projectId, tab });
  const body = h('div', { class: 'project-card-body' });
  if (project.status !== 'available') body.append(notice('warning', `${st.label}:`, `${project.error ?? 'no response'}. Work, decisions and health are unknown.`));
  else {
    const s = project.snapshot, active = activeFlows(project), queued = (s.queue ?? []).filter(q => q.status === 'queued').length;
    body.append(kv([['Active flows', String(active.filter(f => f.state !== 'stopped').length)], ['Stopped', String(active.filter(f => f.state === 'stopped').length)], ['Open inbox items', String(openItemCount(project))], ['Queued tasks', String(queued)], ['Main health', chip(s.mainHealth?.status ?? 'unknown', `Main ${s.mainHealth?.status ?? 'unknown'}`)], ['Mode', s.synthetic ? 'Rehearsal (synthetic)' : 'Delivery']], 'compact'));
    for (const flow of active.slice(0, 2)) body.append(h('p', { class: 'small' }, link(detailHref({ projectId: project.projectId, flow: flow.id }), flowName(flow)), ` · ${flow.state} at ${flow.step}`));
  }
  return h('article', { class: `project-card status-${st.key}` },
    h('header', {}, h('h3', {}, link(go('overview'), project.name)), chip(st.key, st.label)),
    h('p', { class: 'muted small', text: project.observedAt ? `Observed ${relative(project.observedAt)}` : 'Not observed in this refresh' }),
    body,
    h('nav', { class: 'card-links', 'aria-label': `${project.name} views` }, ['timeline', 'tasks', 'history', 'stats'].map(tab => link(go(tab), tab[0].toUpperCase() + tab.slice(1)))));
}

export function projectOverview(project) {
  const st = projectState(project);
  if (project.status !== 'available') return h('div', { class: 'view' }, notice('warning', `${project.name} is ${project.status}.`, `${project.error ?? ''} The console does not show cached work as current; reads and commands are disabled until the project service responds.`), card('Registration', kv([['Project ID', project.projectId], ['Service ID', project.serviceId], ['Binding', project.bindingId]])));
  const s = project.snapshot, active = activeFlows(project);
  const header = h('div', { class: 'kpis' },
    kpi('State', st.label, s.synthetic ? 'rehearsal mode' : 'delivery mode', `status-${st.key}`),
    kpi('Active flows', active.filter(f => f.state !== 'stopped').length, `${active.filter(f => f.state === 'stopped').length} stopped`),
    kpi('Open inbox items', openItemCount(project), `${openDecisions(project).length} questions and notices · ${openTodos(project).length} to-dos`),
    kpi('Main health', s.mainHealth?.status ?? 'unknown', s.mainHealth?.checkedAt ? `checked ${relative(s.mainHealth.checkedAt)}` : 'not verified'),
    // The Queue figure opens Queue, at the held task when exactly one is held on its own (dev.94, R3).
    kpi('Queue', (s.queue ?? []).filter(q => q.status === 'queued').length, heldTaskIds(s).length ? `queued tasks · ${heldTaskIds(s).length} held on ${heldTaskIds(s).length === 1 ? 'its' : 'their'} own` : 'queued tasks', '',
      link(href({ projectId: project.projectId, tab: 'queue', params: heldTaskIds(s).length === 1 ? { task: heldTaskIds(s)[0] } : {} }), 'Open Queue', { class: 'kpi-link' })));
  const held = commissioningRequired(project), settingsLink = label => link(href({ projectId: project.projectId, tab: 'settings', params: { section: 'status' } }), label, { class: 'btn btn-primary' });
  const flows = active.length ? h('div', { class: 'flow-list' }, active.map(f => flowCard(project, f))) : held ? empty('No active or stopped flows', 'Nothing can start until doctor passes for the current configuration.', settingsLink('Run doctor in Settings')) : empty('No active or stopped flows', s.paused ? 'Admission is paused; resume it below before approved tasks start.' : 'Approve a task and start it from Tasks.', link(href({ projectId: project.projectId, tab: 'tasks' }), 'Open Tasks', { class: 'btn btn-secondary' }));
  const recent = (s.flows ?? []).filter(f => ['completed', 'failed'].includes(f.state)).slice(-5).reverse();
  const heldTasks = heldTaskIds(s);
  const controls = h('div', { class: 'stack' },
    heldTasks.length ? h('p', { class: 'small held-tasks' }, `${heldTaskText(heldTasks.length)}: each hold is on that task only. ${restOfQueue(s)} `, link(href({ projectId: project.projectId, tab: 'queue', params: heldTasks.length === 1 ? { task: heldTasks[0] } : {} }), 'Open Queue')) : null,
    commandForm(project, { key: 'pause', title: s.paused ? 'Resume admission' : 'Pause admission', operation: 'pause', subject: { label: s.paused ? 'Project admission is paused' : held ? 'Project admission is held until doctor passes' : 'Project admission is open', version: `paused:${Boolean(s.paused)}` }, fields: [{ name: 'note', label: 'Operator note', placeholder: 'Why this change is needed' }], payload: v => ({ paused: !s.paused, note: v.note }), variant: s.paused ? 'primary' : 'secondary', intro: s.paused ? 'Admission of new flows is paused, and so are schedules and queued maintenance, except scheduled backups, which still run. Running work continues until stopped. A schedule that misses its time raises a notice; recent missed times run when admission resumes.' : 'Pausing stops new admissions, schedules and queued maintenance; scheduled backups still run. Running flows continue until stopped individually.', reasons: s.recoveryHold && s.paused ? ['Recovery hold: restore reconciliation is required before admission can resume.'] : [] }),
    h('details', { class: 'danger-zone' }, h('summary', { text: `Stop all work in ${project.name}` }),
      commandForm(project, { key: 'stop.all', title: `Stop every flow in ${project.name}`, operation: 'stop.all', subject: { label: `${active.length} active or stopped flows`, version: `flows:${active.map(f => f.id).join(',')}` }, fields: [{ name: 'note', label: 'Stop note' }], payload: v => ({ note: v.note }), variant: 'danger', confirm: `Stop every flow and pause admission in ${project.name}? Other projects are not affected.`, intro: 'Pauses admission and stops every flow in this one project only.' })));
  return h('div', { class: 'view' }, header,
    s.recoveryHold ? notice('error', 'Recovery hold.', 'Releasing a hold does not resolve uncertain attempts. Reconcile evidence through the project CLI.') : null,
    held ? h('div', { class: 'notice notice-warning commissioning-hold', role: 'alert' }, h('strong', { text: 'Commissioning required.' }), h('span', { text: ` ${doctorProgress(s)} Nothing is admitted until doctor passes for the current configuration. Run it from Settings → Status (or the CLI: doctor).` }), ' ', settingsLink('Run doctor in Settings')) : null,
    h('div', { class: 'two-col wide-left' },
      h('div', { class: 'stack' }, card('Work in progress', flows, { subtitle: 'Progress shows visited workflow steps; times are from persisted records.' }),
        card('Recently finished', recent.length ? h('div', { class: 'flow-list' }, recent.map(f => flowCard(project, f))) : h('p', { class: 'muted', text: 'No finished flows recorded.' })),
        card('Recent activity', eventList(s.events ?? [], { limit: 15, attempts: s.attempts }), { actions: link(href({ projectId: project.projectId, tab: 'history', params: { kind: 'event' } }), 'All events', { class: 'btn btn-ghost btn-small' }) })),
      h('div', { class: 'stack' }, card('Needs attention', attentionList(attention(project))), card('Admission controls', controls))));
}
