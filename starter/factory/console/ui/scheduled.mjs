// Everything with a time ahead of it, soonest first: tasks held until a not-before time,
// recurring tasks, scheduled tasks and maintenance schedules. Commands stay project-authoritative.
import { h, card, chip, notice, empty, link, time, relative, duration, table, titleCase, segmented } from './dom.mjs';
import { available, href, uiState, saveUi, detailHref } from './state.mjs';
import { commandButton, commandForm } from './actions.mjs';
const rerender = () => window.dispatchEvent(new Event('factotum:render'));

// The fields schedule.put accepts, from a stored schedule.
const SCHEDULE_FIELDS = r => Object.fromEntries(['id', 'operation', 'type', 'everyMs', 'timeOfDay', 'timezone', 'weekdays', 'payload'].filter(k => r[k] !== undefined && r[k] !== null).map(k => [k, r[k]]));
const OPS = [['main.verify', 'Verify main'], ['source.sync', 'Refresh task source'], ['queue.dispatch', 'Dispatch queue'], ['maintenance.backup', 'Backup'], ['audit', 'Audit'], ['retrospective', 'Retrospective']];
const KINDS = { task: 'Task', recurring: 'Recurring task', 'scheduled-task': 'Scheduled task', maintenance: 'Maintenance' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const cadence = r => r.kind === 'task' ? 'Once' : r.type === 'interval' ? `Every ${duration(r.everyMs)}` : `${r.weekdays ? r.weekdays.map(d => DAYS[d]).join(', ') : 'Daily'} ${r.timeOfDay} ${r.timezone}`;
// datetime-local works in the browser's zone; the project stores an absolute time.
export const localInput = iso => { const d = new Date(iso), p = n => String(n).padStart(2, '0'); return Number.isFinite(d.getTime()) ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}` : ''; };
export const notBeforeValue = value => value ? new Date(value).toISOString() : null;

function when(r) {
  if (r.kind === 'task') return h('span', {}, h('strong', { text: time(r.at, { seconds: false }) }), h('br'), h('span', { class: 'muted small', text: r.due ? 'Due now' : relative(r.at) }));
  if (r.paused) return h('span', {}, chip('paused', 'Paused'), h('br'), h('span', { class: 'muted small', text: `by ${r.paused.by} ${relative(r.paused.at)}${r.paused.note ? ` · ${r.paused.note}` : ''}` }));
  if (!r.enabled) return chip('disabled', 'Disabled');
  return r.at ? h('span', {}, h('strong', { text: time(r.at, { seconds: false }) }), h('br'), h('span', { class: 'muted small', text: relative(r.at) })) : '—';
}
function state(project, r) {
  if (r.kind === 'task') {
    const label = r.flow ? `Started · ${r.flow.state}` : !r.approved ? 'Needs approval' : r.queued ? (r.due ? 'Queued, due' : 'Queued, held until then') : 'Approved, not queued';
    return chip(r.flow ? r.flow.state : !r.approved ? 'warn' : r.queued ? 'wait' : 'idle', label);
  }
  if (!r.last) return h('span', { class: 'muted', text: 'Not run yet' });
  const outcome = r.last.outcome === 'pass' ? 'passed' : r.last.outcome === 'fail' ? 'failed' : r.last.outcome;
  return h('span', {}, chip(outcome, titleCase(outcome)), ' ', h('span', { class: 'muted small', text: `${r.last.manual ? 'Run now ' : ''}${relative(r.last.at)}` }),
    r.last.report ? h('details', {}, h('summary', { text: 'Last report' }), h('pre', { class: 'code', text: r.last.report })) : null,
    r.last.taskId ? h('div', {}, link(detailHref({ projectId: project.projectId, task: r.last.taskId }), 'Open task')) : r.last.flowId ? h('div', {}, link(detailHref({ projectId: project.projectId, flow: r.last.flowId }), 'See Timeline')) : null);
}
function actions(project, r, editReasons) {
  const subject = { label: `${KINDS[r.kind].toLowerCase()} ${r.name ?? r.id}`, version: r.revision ?? null };
  if (r.kind === 'task') return h('details', { class: 'edit-task' }, h('summary', { text: 'Edit time' }), commandForm(project, {
    key: `task.schedule:${r.id}`, title: 'Change the time', operation: 'task.schedule', subject: { label: `task ${r.id}`, version: r.at },
    fields: [{ name: 'notBefore', label: 'Not before (your browser’s time zone)', type: 'datetime-local', required: false, value: localInput(r.at) }],
    payload: v => ({ taskId: r.id, notBefore: notBeforeValue(v.notBefore) }), intro: 'Leave empty to remove the time. Approval is kept.', variant: 'secondary' }));
  const runNow = r.kind === 'recurring'
    ? commandButton(project, { key: `recurring.run:${r.name}`, label: 'Run now', operation: 'recurring.run', payload: { name: r.name }, subject, variant: 'ghost', confirm: `Create “${r.title}” now? It is approved and queued.` })
    : commandButton(project, { key: `run-now:${r.id}`, label: 'Run now', operation: 'job.enqueue', payload: { operation: r.operation, note: `Run ${r.name} now from Scheduled` }, subject, variant: 'ghost', confirm: `Run ${r.name} now?` });
  const toggle = r.source === 'config'
    ? commandButton(project, { key: `schedule.pause:${r.id}`, label: r.paused ? 'Resume' : 'Pause', operation: 'schedule.pause', payload: { scheduleId: r.id, paused: !r.paused }, subject: { ...subject, version: `${r.revision}:${r.paused ? 'paused' : 'running'}` }, variant: 'ghost', confirm: r.paused ? `Resume ${r.name}? Missed times are not made up.` : `Pause ${r.name}? It stays paused across configuration updates until resumed.` })
    : r.enabled
      ? commandButton(project, { key: `schedule.remove:${r.id}`, label: 'Disable', reasons: editReasons, operation: 'schedule.remove', payload: { scheduleId: r.id, expectedSchedule: { revision: r.revision ?? null, enabled: true } }, subject, variant: 'ghost', confirm: `Disable schedule ${r.id}? Flows it authorized are stopped.`, showReasons: false })
      : (() => { const full = (project.snapshot.schedules ?? []).find(x => x.id === r.id); return full ? commandButton(project, { key: `schedule.enable:${r.id}`, label: 'Enable', reasons: editReasons, operation: 'schedule.put', payload: { expectedSchedule: { revision: full.revision ?? null, enabled: false }, schedule: Object.fromEntries(Object.entries({ ...SCHEDULE_FIELDS(full), enabled: true })) }, subject, variant: 'ghost', confirm: `Enable schedule ${r.id}?`, showReasons: false }) : null; })();
  return h('div', { class: 'button-row' }, runNow, toggle);
}

export function scheduledView(project) {
  if (!available(project)) return notice('warning', `${project.name} is ${project.status}.`, 'Scheduled work is unavailable until the project service responds.');
  const s = project.snapshot, all = s.scheduled ?? [], ui = uiState(`scheduled:${project.projectId}`, { kind: 'all' });
  const editReasons = s.editPreconditions?.scheduleGrant ? [] : ['This project service must be upgraded before schedule grants can be edited conditionally.'];
  const rows = all.filter(r => ui.kind === 'all' || r.kind === ui.kind);
  const filter = segmented([['all', 'All', all.length], ...Object.entries(KINDS).filter(([k]) => all.some(r => r.kind === k)).map(([k, label]) => [k, `${label}s`, all.filter(r => r.kind === k).length])], ui.kind, value => { ui.kind = value; saveUi(); rerender(); }, 'Show');
  const body = rows.length ? table([
    { label: 'When', render: r => when(r) },
    { label: 'What', render: r => h('span', {}, h('span', { class: 'muted small', text: KINDS[r.kind] }), h('br'), r.kind === 'task' ? link(detailHref({ projectId: project.projectId, task: r.id }), r.title) : h('strong', { text: r.title }), r.kind !== 'task' && r.title !== r.name ? h('span', { class: 'muted small', text: ` · ${r.name}` }) : null) },
    { label: 'Repeats', render: r => h('span', {}, cadence(r), r.source === 'config' ? h('div', { class: 'muted small', text: 'Time set in the configuration' }) : null) },
    { label: 'Last outcome', render: r => state(project, r) },
    { label: 'Actions', render: r => actions(project, r, editReasons) },
  ], rows, { caption: 'Scheduled work, soonest first' }) : empty('Nothing scheduled', 'Give a task a not-before time, or add recurringTasks or scheduledTasks to the project configuration.');
  const own = (s.schedules ?? []).filter(r => r.source !== 'config');
  const addForm = h('details', {}, h('summary', { text: 'Add a maintenance schedule' }), commandForm(project, {
    key: 'schedule.put', reasons: editReasons, title: 'Save schedule', operation: 'schedule.put', subject: { label: 'maintenance schedules', version: JSON.stringify(own.map(r => [r.id, r.revision ?? null, r.enabled === true]).sort((a, b) => a[0].localeCompare(b[0]))) },
    fields: [{ name: 'id', label: 'Name' }, { name: 'operation', label: 'Runs', type: 'select', options: OPS, value: 'main.verify' }, { name: 'type', label: 'Repeats', type: 'select', options: [['interval', 'Every so many minutes'], ['daily', 'Daily at a time']], value: 'interval' }, { name: 'everyMinutes', label: 'Every (minutes)', type: 'number', required: false, value: '60' }, { name: 'timeOfDay', label: 'Time of day, HH:MM', required: false, placeholder: '06:30' }, { name: 'timezone', label: 'Time zone', required: false, value: Intl.DateTimeFormat().resolvedOptions().timeZone }],
    payload: v => { const prior = own.find(r => r.id === v.id), expectedSchedule = prior ? { revision: prior.revision ?? null, enabled: prior.enabled === true } : null; if (v.type === 'interval') { const m = Number(v.everyMinutes); if (!Number.isFinite(m) || m < 1) throw Error('Repeat at least every minute.'); return { expectedSchedule, schedule: { id: v.id, operation: v.operation, type: 'interval', everyMs: Math.round(m * 60000), payload: {} } }; } if (!/^\d\d:\d\d$/.test(v.timeOfDay)) throw Error('Daily schedules need a time as HH:MM.'); return { expectedSchedule, schedule: { id: v.id, operation: v.operation, type: 'daily', timeOfDay: v.timeOfDay, timezone: v.timezone, payload: {} } }; },
    intro: 'Runs a built-in maintenance operation. Saving an existing name replaces it.', variant: 'secondary' }));
  return h('div', { class: 'view' }, card('Scheduled', h('div', { class: 'stack' }, filter, body, addForm,
    h('p', { class: 'help', text: 'Tasks with a not-before time stay queued until then. Recurring and scheduled tasks are defined in the project configuration; change their times there. Pause holds one until it is resumed, across configuration updates.' })), { level: 'h2', cls: 'span-all' }));
}
