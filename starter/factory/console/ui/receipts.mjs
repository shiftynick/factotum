// Console command journal and canonical receipts. Unknown outcomes are never resubmitted.
import { h, chip, card, empty, notice, time, short, raw, segmented, json } from './dom.mjs';
import { state, findProject, uiState, saveUi, read, readEntry, available } from './state.mjs';

const rerender = () => window.dispatchEvent(new Event('factotum:render'));
const resolved = c => ['completed', 'rejected'].includes(c.status);
// A command whose completion only records a request (doctor.request, job.enqueue): the canonical
// receipt is complete when the request is recorded, and the work it asked for is followed separately
// to its real outcome. The receipt's badge shows that outcome, so nothing reads "completed" while the
// requested work is still queued or running; the canonical status stays in the raw receipt.
const DOCTOR_RUN = { queued: ['pending', 'Doctor queued'], running: ['running', 'Doctor running'], passed: ['passed', 'Doctor passed'], failed: ['failed', 'Doctor failed'] };
const JOB_RUN = { queued: ['pending', 'queued'], running: ['running', 'running'], completed: ['passed', 'finished'], failed: ['failed', 'failed'] };
const JOB_OUTCOME = { dispatched: 'started a queued task', 'no-eligible-task': 'found no task it could start', abandoned: 'its flow was abandoned' };
const rerenderLater = () => window.dispatchEvent(new Event('factotum:render'));
// { tone, label, detail?, reasons?, settled } for a request receipt, or null for an ordinary command.
export function requestFollowUp(c, project) {
  if (c.status !== 'completed') return null;
  if (c.operation === 'doctor.request') {
    const requestId = c.receipt?.result?.id, d = project?.snapshot?.settings?.doctorRequest;
    if (!requestId || !d || d.id !== requestId) return { tone: 'unknown', label: 'Doctor run not visible', detail: 'This console no longer sees that doctor run; Settings → Status shows the latest doctor result.', settled: true };
    const [tone, label] = DOCTOR_RUN[d.status] ?? ['unknown', `Doctor ${d.status}`];
    return { tone, label, detail: d.finishedAt ? `finished ${time(d.finishedAt)}` : d.startedAt ? `started ${time(d.startedAt)}` : '', reasons: d.status === 'failed' ? d.reasons ?? [] : [], settled: ['passed', 'failed'].includes(d.status) };
  }
  if (c.operation === 'job.enqueue') {
    const jobId = c.receipt?.result?.id, name = c.receipt?.result?.operation ?? c.payload?.operation ?? 'job';
    if (typeof jobId !== 'string' || !project || !available(project)) return { tone: 'unknown', label: `${name} requested`, detail: 'Its progress is not visible from this console now.', settled: false };
    // The job is read by ID and read again whenever the project's records change.
    let entry = readEntry(project, 'jobs', jobId);
    if (!entry || (entry.stale && entry.status !== 'loading')) entry = read(project, 'jobs', jobId, {}, { force: Boolean(entry), onDone: rerenderLater });
    const job = entry.data?.job;
    if (!job) return { tone: entry.status === 'error' ? 'unknown' : 'pending', label: `${name} requested`, detail: entry.status === 'error' ? `Its progress could not be read: ${entry.error}` : 'Reading its progress…', settled: false };
    const [tone, word] = JOB_RUN[job.status] ?? ['unknown', job.status];
    return { tone: job.status === 'completed' && job.outcome === 'abandoned' ? 'stopped' : tone, label: `${job.operation ?? name} ${word}`, detail: [job.outcome ? JOB_OUTCOME[job.outcome] ?? job.outcome : '', job.finishedAt ? `finished ${time(job.finishedAt)}` : ''].filter(Boolean).join(' · '), reasons: job.reason ? [job.reason] : [], settled: ['completed', 'failed'].includes(job.status) };
  }
  return null;
}
export function requestOutcome(c, project, follow = requestFollowUp(c, project)) {
  if (!follow) return null;
  return h('div', { class: 'stack' }, h('p', { class: 'small' }, 'Request accepted · ', chip(follow.tone, follow.label), follow.detail ? h('span', { class: 'muted', text: ` · ${follow.detail}` }) : null),
    follow.reasons?.length ? h('ul', { class: 'bullets small' }, follow.reasons.map(reason => h('li', { text: reason }))) : null);
}
const receiptTone = (c, follow) => !resolved(c) ? 'warn' : c.status === 'rejected' ? 'bad' : !follow || follow.settled && follow.tone === 'passed' ? 'good' : follow.tone === 'failed' ? 'bad' : 'info';

export function receiptsView(project) {
  const ui = uiState('receipts', { filter: 'all' });
  const rows = [...state.journal].filter(c => !project || c.projectId === project.projectId).reverse();
  const shown = rows.filter(c => ui.filter === 'all' || (ui.filter === 'unresolved' ? !resolved(c) : c.status === ui.filter));
  const unresolvedCount = rows.filter(c => !resolved(c)).length;
  return h('div', { class: 'view' },
    unresolvedCount ? notice('warning', `${unresolvedCount} unresolved command outcome(s).`, 'The console queried each project for its canonical receipt and will keep checking. Further console actions for the affected project are held. Inspect the project’s command history with the CLI before issuing a replacement action.') : null,
    h('div', { class: 'toolbar' }, segmented([['all', 'All', rows.length], ['unresolved', 'Unresolved', unresolvedCount], ['completed', 'Completed', rows.filter(c => c.status === 'completed').length], ['rejected', 'Rejected', rows.filter(c => c.status === 'rejected').length]], ui.filter, v => { ui.filter = v; saveUi(); rerender(); }, 'Receipt status')),
    shown.length ? h('div', { class: 'receipt-list' }, shown.map(c => {
      const p = findProject(c.projectId);
      const error = c.receipt?.error, follow = requestFollowUp(c, p);
      return h('article', { class: `receipt tone-${receiptTone(c, follow)}` },
        h('header', {}, h('div', {}, h('strong', { text: c.operation ?? 'command' }), h('span', { class: 'muted', text: ` → ${p?.name ?? c.projectId}${p ? '' : ' (unregistered)'}` })), follow ? chip(follow.tone, follow.label) : chip(c.status)),
        h('p', { class: 'muted small', text: `Submitted ${time(c.submittedAt)} · command ${short(c.commandId, 12)} · binding ${short(c.bindingId, 8)}${c.checkedAt ? ` · last checked ${time(c.checkedAt, { date: false })}` : ''}` }),
        error ? h('p', { class: 'error-text', text: typeof error === 'string' ? error : json(error) }) : null,
        c.detail ? h('p', { text: c.detail }) : null,
        requestOutcome(c, p, follow),
        raw('Canonical receipt', c.receipt ?? { status: c.status }));
    })) : empty(rows.length ? 'No receipts in this filter' : 'No submitted commands', 'Commands sent from this console are journaled here with their canonical receipts.'));
}
