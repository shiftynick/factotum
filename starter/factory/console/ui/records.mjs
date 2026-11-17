// Readable presentations of canonical records. Raw JSON stays available as a secondary view.
import { h, chip, kv, raw, time, ms, duration, between, short, usd, strings, link, json, relative, tone } from './dom.mjs';
import { href, flowTitle, detailHref } from './state.mjs';

// An attempt's result as shown everywhere (timeline, attempt panel, History rows, filters and
// detail). A step that ran cleanly and reported a failure (a failed fast check or gate check) is
// failed; its lifecycle status stays passed and routing is unchanged (core/attempt-outcome.mjs).
// A step whose provider stopped at its turn limit before the step finished (a builder out of
// turns, routed to the build question) is turn-limit, never passed (dev.85, I2).
// An attempt recorded before the outcome field is recognised by its result's route, or by its
// turn-limit classification (the overview's attempt rows carry the classification, not the outcome).
const turnLimited = attempt => attempt?.outcome === 'turn-limit' || (attempt?.status === 'passed' && attempt?.classification === 'turn-limit');
export const attemptStatus = attempt => turnLimited(attempt) ? 'turn-limit' : attempt?.outcome === 'failed' || (attempt?.status === 'passed' && attempt?.route === 'fail') ? 'failed' : attempt?.status;
// The words for an attempt's result: "stopped at turn limit" rather than the bare value.
const STATUS_LABELS = { 'turn-limit': 'stopped at turn limit' };
export const attemptStatusLabel = status => STATUS_LABELS[status] ?? status;
export const attemptChip = attempt => { const status = attemptStatus(attempt); return chip(status, attemptStatusLabel(status)); };
// Outcome, lifecycle and the process exit as separate rows: the exit code is the step runner's.
export function attemptResultRows(a) {
  const status = attemptStatus(a), reported = status !== a.status, limited = status === 'turn-limit';
  const toQuestion = a.route === 'blocked' ? `its ${a.route} route to the step's question` : `its ${a.route ?? 'result'} route`;
  return [
    ['Outcome', limited ? h('span', {}, chip('turn-limit', 'stopped at its turn limit'), h('span', { class: 'muted small', text: ' the provider stopped at its turn limit before the step finished; the step returned no result' }))
      : reported ? h('span', {}, chip('failed', 'failed'), h('span', { class: 'muted small', text: ` the step ran to completion and reported a failure (route ${a.route ?? 'fail'})` })) : chip(a.status)],
    ['Lifecycle', limited ? `settled cleanly (status ${a.status}); the flow followed ${toQuestion}` : reported ? `settled cleanly (status ${a.status}); the flow followed the step's fail route` : undefined],
    ['Failed checks', reported && !limited && a.failedChecks?.length ? a.failedChecks.map(c => `${c.id} (${c.status}${c.failureClass ? `, ${c.failureClass}` : ''})`).join(', ') : undefined],
    ['Process exit', a.receipt ? `code ${a.receipt.exitCode ?? '—'}${a.receipt.signal ? ` · signal ${a.receipt.signal}` : ''} (the step runner process${reported ? ', not the outcome' : ''})` : undefined],
  ];
}

const EVENTS = {
  'project.initialized': 'Project initialized', 'task.updated': 'Task brief saved', 'task.approved': 'Task approved', 'task.revoked': 'Task approval revoked',
  'flow.admitted': 'Flow admitted', 'planning.admitted': 'Planning flow admitted', 'flow.moved': 'Moved to step', 'flow.stopped': 'Flow stopped', 'flow.resumed': 'Flow resumed',
  'flow.finished': 'Flow finished', 'flow.replan': 'Replan requested', 'flow.abandoned': 'Flow abandoned',
  'attempt.prepared': 'Attempt prepared', 'attempt.dispatching': 'Attempt dispatching', 'attempt.running': 'Attempt running', 'attempt.settled': 'Attempt settled',
  'attempt.uncertain': 'Attempt outcome uncertain', 'attempt.not-dispatched': 'Attempt not dispatched', 'attempt.reconciled': 'Attempt reconciled by operator',
  'inbox.opened': 'Question opened', 'inbox.answered': 'Question answered', 'inbox.expired': 'Question expired', 'inbox.read': 'Question read', 'inbox.ack': 'Question acknowledged', 'inbox.presented': 'Question shown on a prompt channel', 'inbox.presentation-ended': 'Prompt presentation ended',
  'command.completed': 'Command completed', 'command.rejected': 'Command rejected', 'admission.paused': 'Admission pause changed', 'queue.updated': 'Queue order saved', 'queue.claimed': 'Queue item claimed', 'queue.held': 'Queue admission held',
  'main.health': 'Main health recorded', 'schedule.updated': 'Schedule saved', 'schedule.revoked': 'Schedule disabled', 'notification.delivery': 'Notification delivery', 'notification.acknowledged': 'Notification acknowledged',
  'rule.pushback': 'Rule change proposed', 'regression.reported': 'Regression reported', 'audit.finding': 'Audit finding recorded', 'audit.observed': 'Audit finding observed again',
  'finding.raised': 'Upkeep candidate raised', 'finding.observed': 'Finding observed again', 'finding.tasked': 'Finding given a task', 'finding.declined': 'Finding declined', 'finding.resolved': 'Finding resolved elsewhere', 'finding.reopened': 'Finding reopened',
  'finding.expired': 'Finding expired', 'finding.delivered': 'Finding delivered', 'finding.failed': 'Finding failed', 'finding.returned': 'Finding returned to open', 'upkeep.suspended': 'Knowledge upkeep suspended', 'upkeep.suspension-lifted': 'Knowledge upkeep suspension lifted',
  'obligation.resolved': 'Obligation resolved', 'retrospective.recorded': 'Retrospective recorded', 'retrospective.failed': 'Retrospective failed', 'plan.ready': 'Reviewed plan ready',
  'config.updated': 'Configuration updated', 'settings.updated': 'Settings updated', 'config.kept-live-settings': 'Live settings kept by a configuration update', 'config.live-settings-changed': 'Live settings changed by a configuration update', 'project.doctor': 'Commissioning check', 'restore.reconciled': 'Recovery hold released', 'runner.fault': 'Runner fault', 'operations.fault': 'Operations fault',
  'job.enqueued': 'Maintenance job queued', 'money.reserved': 'Spend reserved', 'money.settled': 'Spend settled',
};
export const eventLabel = type => EVENTS[type] ?? type;
// What an "Attempt settled" event says the attempt came to (dev.86, J3): the attempt's derived
// result when the page has the attempt (attemptStatus: a turn-limited build, a failed check), else
// the outcome the event recorded, else whether its effect passed. Never "passed" for a step whose
// routed outcome was a failure or its turn limit.
const attemptOf = (attempts, id) => !id || !attempts ? null : attempts instanceof Map ? attempts.get(id) ?? null : Array.isArray(attempts) ? attempts.find(row => row?.id === id) ?? null : null;
export function settledResult(event, attempts) {
  const p = event?.payload ?? {}, attempt = attemptOf(attempts, p.attemptId);
  if (attempt?.settledAt || attempt?.outcome) return attemptStatus(attempt);
  if (['turn-limit', 'failed'].includes(p.outcome)) return p.outcome;
  return p.passed === true ? 'passed' : p.passed === false ? 'did not pass' : null;
}
export function eventDetail(event, attempts) {
  const p = event.payload ?? {};
  const parts = [];
  const settled = event.type === 'attempt.settled' ? settledResult(event, attempts) : undefined;
  if (p.step) parts.push(`step ${p.step}`);
  if (settled) parts.push(attemptStatusLabel(settled));
  else if (p.outcome && settled === undefined) parts.push(p.outcome);
  if (p.answer) parts.push(`answer “${p.answer}”`);
  if (p.relayed) parts.push(`relayed by the ${p.relayedBy} from ${p.channel}`);
  if (p.presentationId) parts.push(`${p.status ?? 'shown'} on ${p.channel}`);
  if (p.operation) parts.push(p.operation);
  if (p.passed !== undefined && settled === undefined) parts.push(p.passed ? 'passed' : 'did not pass');
  if (p.reason) parts.push(String(p.reason));
  if (p.note) parts.push(`note: ${p.note}`);
  if (p.error) parts.push(String(p.error));
  if (p.paused !== undefined) parts.push(p.paused ? 'paused' : 'admission open');
  // Live settings (dev.89, M1): which, with what value and by whom, so a lost live change can be found here.
  if (event.type === 'settings.updated' && p.changes && typeof p.changes === 'object') parts.push(`${Object.entries(p.changes).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ')}${p.by ? `, by the ${p.by}` : ''}`);
  if (event.type === 'config.live-settings-changed' && Array.isArray(p.details)) parts.push(p.details.map(row => `${row.setting}: ${JSON.stringify(row.from)} to ${JSON.stringify(row.to)}`).join(', '));
  else if (event.type.startsWith('config.') && Array.isArray(p.settings)) parts.push(p.settings.join(', '));
  if (p.taskId) parts.push(`task ${p.taskId}`);
  if (p.attemptId) parts.push(`attempt ${short(p.attemptId, 8)}`);
  return parts.join(' · ');
}
export const eventTone = type => /fault|rejected|uncertain|failed/.test(type) ? 'bad' : /stopped|expired|revoked|held|abandon/.test(type) ? 'warn' : /finished|completed|approved|answered|ready|settled/.test(type) ? 'good' : 'info';

// An event's tone; a settled attempt's follows what it came to, not the word "settled".
export const eventToneOf = (event, attempts) => { if (event.type !== 'attempt.settled') return eventTone(event.type); const settled = settledResult(event, attempts); return !settled ? eventTone(event.type) : settled === 'did not pass' ? 'bad' : tone(settled); };

// `attempts`: the attempts the page has (an array or a Map by id), for settled events' results.
export function eventList(events, { limit = 50, attempts } = {}) {
  if (!events?.length) return h('p', { class: 'muted', text: 'No recorded events.' });
  return h('ol', { class: 'event-list' }, events.slice(0, limit).map(event => h('li', { class: `ev tone-${eventToneOf(event, attempts)}` },
    h('time', { datetime: event.at, title: time(event.at), text: time(event.at, { date: false }) }),
    h('span', { class: 'ev-dot', 'aria-hidden': 'true' }),
    h('div', {}, h('strong', { text: eventLabel(event.type) }), eventDetail(event, attempts) ? h('span', { class: 'muted', text: ` — ${eventDetail(event, attempts)}` }) : null))));
}

/** Readable detail for any history record kind. */
export function recordDetail(kind, item, project) {
  const flowLink = id => id ? link(detailHref({ projectId: project.projectId, flow: id }), flowTitle(project, id)) : '—';
  const rows = {
    flow: () => [['State', chip(item.state)], ['Step', item.step], ['Kind', item.kind], ['Mode', item.mode], ['Task', item.taskId], ['Task revision', short(item.taskRevision, 12)], ['Created', time(item.createdAt)], ['Finished', item.finishedAt ? time(item.finishedAt) : null], ['Elapsed', duration(between(item.createdAt, item.finishedAt))], [item.state === 'stopped' ? 'Stop reason' : 'Last stop reason (no longer stopped)', item.stopReason ?? undefined], ['Timeline', flowLink(item.id)]],
    task: () => [['Title', item.title], ['Outcome', item.outcome ?? undefined], ['Approval', chip(item.approvedRevision === item.revision ? 'approved' : 'unapproved', item.approvedRevision === item.revision ? 'Approved' : 'Approval required')], ['Status', item.status ?? undefined], ['Revision', short(item.revision, 12)], ['Acceptance', strings(item.acceptance)], ['Paths', item.paths ? strings(item.paths) : undefined], ['Risk', item.risk ?? undefined], ['Dependencies', item.dependencies ? strings(item.dependencies) : undefined], ['Approved', item.approvedAt ? time(item.approvedAt) : undefined]],
    inbox: () => [['Status', chip(item.status)], ['Question', item.question ?? item.summary], ['Role', item.role], ['Answers', item.answers ? strings(item.answers) : undefined], ['Answer', item.answer ?? undefined], ['Answered by', item.answeredBy ?? undefined], ['Answer note', item.answerNote ?? undefined], ['Relayed answer', item.relay ? `Entered by the ${item.relay.relayedBy}, relaying words received on ${item.relay.channel}: “${item.relay.quote}”` : undefined], ['Prompt presentations', item.presentations?.length ? strings(item.presentations.map(row => `${row.channel}: ${row.status} (shown by the ${row.presentedBy} ${time(row.presentedAt)}${row.endedAt ? `, ended ${time(row.endedAt)}` : `, until ${time(row.expiresAt)}`})`)) : undefined], ['Flow', flowLink(item.flowId)], ['Opened', time(item.createdAt)], ['Expires', item.expiresAt ? time(item.expiresAt) : undefined], ['Answered', item.answeredAt ? time(item.answeredAt) : undefined], ['Version', item.version], ['Subject digest', short(item.subjectDigest, 16)]],
    attempt: () => [...attemptResultRows(item), ['Step', item.step], ['Flow', flowLink(item.flowId)], ['Prepared', time(item.createdAt)], ['Dispatched', item.dispatchedAt ? time(item.dispatchedAt) : undefined], ['Started', item.receipt?.startedAt ? time(item.receipt.startedAt) : undefined], ['Ended', item.receipt?.endedAt ? time(item.receipt.endedAt) : undefined], ['Run time', duration(between(item.receipt?.startedAt, item.receipt?.endedAt))], ['Settled', item.settledAt ? time(item.settledAt) : 'Not settled'], ['Reason', item.reason ?? item.receipt?.reason ?? undefined], ['Cost', Number.isSafeInteger(item.costMicros) ? usd(item.costMicros) : 'Not settled'], ['Reconciliation', item.reconciliation ? `${item.reconciliation.actor}: ${item.reconciliation.note}` : undefined]],
    event: () => [['Type', eventLabel(item.type)], ['At', time(item.at)], ['Sequence', item.sequence], ['Detail', eventDetail(item) || null]],
    command: () => [['Operation', item.operation], ['Status', chip(item.status)], ['Actor', item.actor], ['Accepted', time(item.acceptedAt)], ['Completed', item.completedAt ? time(item.completedAt) : undefined], ['Error', item.error ?? undefined], ['Command ID', item.commandId]],
    wait: () => [['Kind', item.kind], ['Flow', flowLink(item.flowId)], ['Started', time(item.startedAt)], ['Ended', item.endedAt ? time(item.endedAt) : 'Open'], ['Duration', item.endedAt ? duration(between(item.startedAt, item.endedAt)) : `open since ${relative(item.startedAt)}`], ['Reason', item.reason ?? undefined]],
    // An audit finding or upkeep candidate (dev.88 M9: its detail showed createdAt and statusAt as raw ISO values).
    finding: () => [['Title', item.title ?? item.message ?? undefined], ['Status', chip(item.status)], ['Source', item.source ?? undefined], ['Severity', item.severity ?? undefined], ['Evidence', item.evidence ?? undefined], ['File', item.file ?? undefined], ['Seen', item.observations ? `${item.observations} time(s)` : undefined], ['Task', item.taskId ?? undefined], ['Version', item.version ?? undefined], ['Created', timeOf(item.createdAt)], ['Status changed', timeOf(item.statusAt)], ['Last observed', timeOf(item.lastObservedAt)]],
    schedule: () => [['Operation', item.operation], ['Enabled', chip(item.enabled ? 'enabled' : 'disabled', item.enabled ? 'Enabled' : 'Disabled')], ['Type', item.type], ['Every', item.everyMs ? duration(item.everyMs) : undefined], ['Daily at', item.timeOfDay ? `${item.timeOfDay} ${item.timezone}` : undefined], ['Last scan', item.lastScannedAt ? time(item.lastScannedAt) : undefined], ['Note', item.note ?? undefined]],
  };
  const body = h('div', { class: 'record-detail' }, kv((rows[kind] ?? (() => genericRows(item)))()));
  body.append(raw('Raw canonical record', item));
  return body;
}
// A recorded time as a time element: local time, with the UTC value as recorded in its tooltip.
const timeOf = value => typeof value === 'string' && ms(value) !== null ? h('time', { datetime: value, title: `${value} (UTC as recorded)` }, time(value)) : undefined;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export function genericRows(item) {
  return Object.entries(item ?? {}).filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)).slice(0, 18).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'string' && ISO.test(v) ? timeOf(v) : String(v ?? '—')]);
}
export { json };
