// The Health tab: main health, anything that needs recovery, knowledge upkeep (candidates and
// suspensions) and audit findings.
// Obligations are Inbox to-dos; per-flow records (retrospectives, context, rule proposals,
// obligations, regressions) are in the flow detail; logs are in History.
import { h, chip, card, kv, empty, notice, time, relative, short, raw, strings, link, duration, usd, plural } from './dom.mjs';
import { href, available, flowTitle, detailHref } from './state.mjs';
import { commandButton, commandForm } from './actions.mjs';
import { holdCause } from './overview.mjs';
import { timeNode, queueHoldNode, relativeTimeNode } from './admission.mjs';

const recordCard = (title, status, rows, item, extra) => h('article', { class: 'record' }, h('header', {}, h('h4', { text: title }), status ? chip(status) : null), kv(rows, 'compact'), extra ?? null, raw('Raw record', item));
const flowLink = (project, id) => id ? link(detailHref({ projectId: project.projectId, flow: id }), flowTitle(project, id)) : '—';

function recovery(project) {
  const s = project.snapshot, uncertain = (s.attempts ?? []).filter(a => a.status === 'uncertain');
  const items = [], cli = s.settings?.cli ?? 'node factory/cli.mjs';
  if (s.spending?.enabled && (s.spending.globalHold || !s.spending.available)) items.push(notice(s.spending.globalHold?'warning':'info','Paid integration ledger',s.spending.available?`Recorded spend $${(s.spending.actualMicros/1000000).toFixed(6)}; unresolved reservations $${(s.spending.heldMicros/1000000).toFixed(6)}.${s.spending.globalHold?' Global paid dispatch is held pending settlement and evidence review.':''}`:'Ledger unavailable; paid spending is not established.',raw('Spending evidence',s.spending)));
  if (s.recoveryHold) items.push(notice('error', 'Recovery hold is active.', `${holdCause(s.recoveryHoldReason)} Admission and dispatch are held. Reconcile every unsettled attempt, stop active flows, then release with the project CLI: ${cli} command --state <project-state> --operation restore.release --payload '{"note":"…"}'.`));
  for (const a of uncertain) items.push(recordCard(`Uncertain attempt ${short(a.id, 10)}`, 'uncertain', [['Step', a.step], ['Flow', flowLink(project, a.flowId)], ['Reason', a.reason ?? '—'], ['Prepared', timeNode(a.createdAt)], ['Dispatched', a.dispatchedAt ? timeNode(a.dispatchedAt) : '—']], a,
    h('p', { class: 'help', text: `Not failed and not retried. Inspect retained evidence, then reconcile with \`${cli} reconcile --state <project-state> --attempt <id> --note …\` (typed external effects) or an explicit attempt.resolve attestation.` })));
  const held = s.settings?.holds;
  if (held?.moneyHold) items.push(notice('error', 'Monetary overrun hold.', 'A settled spend exceeded its reservation; admission is paused until explicit reconciliation.'));
  return items.length ? h('div', { class: 'stack' }, items) : null;
}
// Whether anything needs recovery; Overview and Timeline link here when it does.
export const needsRecovery = project => { const s = project.snapshot; return Boolean(s.recoveryHold || s.settings?.holds?.moneyHold || (s.spending?.enabled && (s.spending.globalHold || !s.spending.available)) || (s.attempts ?? []).some(a => a.status === 'uncertain')); };

// Scheduled-tier main checks: their latest evidence, carried across merge-tier verifications.
function scheduledTier(project, m) {
  const s = m.scheduled, maxAge = project.snapshot.settings?.live?.['policy.scheduledHealthMaxAgeMs']?.value ?? 93600000;
  if (!(project.snapshot.settings?.mainChecks ?? []).some(c => c.tier === 'scheduled') && !s) return undefined;
  if (!s) return h('span', {}, chip('unknown', 'Not verified'), ' Run main.verify (every tier) or wait for its schedule.');
  const age = Date.now() - Date.parse(s.checkedAt);
  // The time is the dev.83 time element, with its UTC value as recorded (dev.87, K4).
  return h('span', {}, chip(s.status), Number.isFinite(age) && age > maxAge ? chip('stale', `Older than ${duration(maxAge)}`) : null, ` at ${short(s.head, 12)}, `, s.checkedAt ? timeNode(s.checkedAt) : 'never', `${s.failed?.length ? ` · failed: ${s.failed.join(', ')}` : ''}${s.source ? ` · ${s.source}` : ''}`);
}
// Scheduled-only checks a merge-tier run did not include: their latest full-verification result,
// or that they have not been verified, so every configured check is named on the card.
function scheduledOnly(project, m) {
  const listed = new Set((m.checks ?? []).map(c => c.id)), carried = m.scheduled?.checks ?? [];
  const configured = (project.snapshot.settings?.mainChecks ?? []).filter(c => c.tier === 'scheduled' && !listed.has(c.id));
  return configured.map(c => { const row = carried.find(x => x.id === c.id), status = row ? (row.passed ? 'passed' : row.status ?? 'failed') : 'unknown';
    return h('li', {}, chip(status, row ? status : 'not verified'), ` ${c.id} · scheduled tier, not part of this run`, row ? [' · last full verification ', m.scheduled.checkedAt ? [timeNode(m.scheduled.checkedAt), ' '] : '', `at ${short(m.scheduled.head, 12)}`] : ' · no full verification recorded yet'); });
}
// One recorded check of a verification, for the current run or the previous one.
const checkItem = c => h('li', {}, chip(c.status), ` ${c.id}${c.tier === 'scheduled' ? ' · scheduled tier' : ''}${c.timedOut ? ` · timed out after ${duration(c.timeoutMs)}${c.limitSource === 'verification' ? ' (the step’s time was used up)' : ''}` : ''}${c.flaked?' · recovered registered flake':''}${c.reused?' · reused exact evidence':''}`, c.verifiedAt ? [' · originally verified ', timeNode(c.verifiedAt)] : null, `${c.evidence ? ` — ${c.evidence}` : ''}${c.startedAt && c.endedAt ? ` (${duration(Date.parse(c.endedAt) - Date.parse(c.startedAt))})` : ''}`);
const checkedAt = iso => iso ? timeNode(iso) : 'never';
const tierText = m => m.tier ? (m.tiers?.includes('scheduled') ? 'Every tier (merge and scheduled)' : m.tier === 'merge' ? 'Merge tier only' : 'Every check') : undefined;
// The last completed verification while a newer record has no check results (a verification
// running, a merge waiting for one): marked as the previous run, with its checks (dev.86, J2).
function previousRun(m) {
  const p = m.previousRun;
  if (!p || typeof p !== 'object' || Array.isArray(m.checks)) return undefined;
  return h('div', { class: 'stack previous-run' }, h('p', {}, chip(p.status, `Previous run ${p.status ?? 'unknown'}`), ' at ', short(p.head, 12), ', ', ...[checkedAt(p.checkedAt)].flat(), tierText(p) ? ` · ${tierText(p)}` : ''),
    Array.isArray(p.checks) && p.checks.length ? h('ul', { class: 'bullets' }, p.checks.map(checkItem)) : h('p', { class: 'muted', text: 'It recorded no checks.' }),
    h('p', { class: 'help', text: 'The previous run’s results, shown until a newer verification records its own. Admission goes by the current result above.' }));
}
function health(project, m = project.snapshot.mainHealth ?? { status: 'unknown' }, label = 'Main', target = project.snapshot.settings?.repository?.target) {
  const maxAge = project.snapshot.settings?.policy?.mainHealthMaxAgeMs ?? 3600000, age = Date.now() - Date.parse(m.checkedAt);
  const holds = (project.snapshot.queueStatus?.holds ?? []).filter(row => row.kind === 'main' && (!row.target || row.target === target));
  // A red result that failed only on timeouts gets one automatic re-verification (dev.85).
  const retry = holds.find(row => row.timeoutRetry)?.timeoutRetry, retryText = retry ? { pending: retry.auto ? (retry.due ? 'Once, now' : ['Once, after ', timeNode(retry.after)]) : 'Off (policy.autoQueue)', requested: `In progress (job ${retry.jobId})`, used: 'Used: it timed out again; run main.verify after fixing the cause' }[retry.status] : undefined;
  // A verification in progress: recorded as running (dev.86), or by its reason on an earlier record.
  const running = m.running === true || m.reason === 'Main verification in progress; current result required';
  return h('div', { class: 'stack' }, h('div', { class: 'plan-status' }, chip(m.status, `${label} ${m.status}`), running ? chip('running', 'Verification running') : null, Number.isFinite(age) && age > maxAge ? chip('stale', `Older than ${duration(maxAge)}`) : null, m.source === 'operator-exception' ? chip('warn', 'Operator exception') : null),
    kv([['Head', short(m.head, 12)], ['Checked', checkedAt(m.checkedAt)], ['Source', m.source ?? (m.attemptId ? `attempt ${short(m.attemptId, 8)}` : '—')], ['Reason', m.reason ?? undefined], ['Note', m.note ?? undefined], ['Last run', tierText(m)], ['Merge tier', m.tierStatus ? chip(m.tierStatus) : undefined], ['Scheduled tier', scheduledTier(project, m)], ['Admission', holds.length ? h('span', {}, holds.flatMap((row, i) => [i ? ' ' : '', ...queueHoldNode(project, row)])) : undefined], ['Automatic re-verification', Array.isArray(retryText) ? h('span', {}, retryText) : retryText], ['Checks', Array.isArray(m.checks) ? h('ul', { class: 'bullets' }, m.checks.map(checkItem), scheduledOnly(project, m)) : undefined], ['Previous run', previousRun(m)]]),
    h('p', { class: 'help', text: 'Delivery admission requires current green main health, including current scheduled-tier evidence when some main checks are scheduled-only. Verification runs as scheduled or manual main.verify maintenance; operator exceptions use the project CLI.' }), raw('Raw main health', m));
}

// ---- Findings and knowledge upkeep (knowledge-upkeep design 4.3, 4.4, 8.4) ----
// Every field of a finding or a candidate was written by a model or copied from the repository.
// It is shown as text (h() never parses markup), with where it came from beside it.
const DECLINE_REASONS = [['unnecessary', 'Unnecessary'], ['wrong', 'Wrong'], ['duplicate', 'A duplicate'], ['later', 'Not now']];
const CLOSED = ['declined', 'expired', 'failed', 'resolved-elsewhere'];
const findingVersion = f => Number.isSafeInteger(f.version) && f.version > 0 ? f.version : 1;
const isCandidate = f => f.source === 'upkeep';
const subjectOf = f => ({ label: `finding ${short(f.id, 16)}`, version: findingVersion(f) });
// What a confirmation names (dev.89 N3: only the project): the finding or candidate, its title and
// version, and the task a decline would close. Shown by the browser's own dialog, as plain text.
const clipText = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
function confirmText(f, question, tail = '') {
  const noun = isCandidate(f) ? 'upkeep candidate' : 'finding', title = clipText(f.title, 120);
  const named = `${noun} ${short(f.id, 24)}${title ? ` “${title}”` : ''} (version ${findingVersion(f)})`;
  return `${question.replace('{finding}', named)}${tail ? ` ${tail}` : ''}`;
}
// Decline, or record that it was dealt with another way. Both name the version shown here, so a
// finding that changed meanwhile is refused.
function dispositionForms(project, f) {
  const subject = subjectOf(f), tasked = f.status === 'tasked';
  return [
    h('details', {}, h('summary', { text: tasked ? 'Decline, and close its task' : 'Decline' }), commandForm(project, { key: `finding-decline:${f.id}`, title: 'Decline', operation: 'finding.resolve', subject, variant: 'secondary',
      fields: [{ name: 'reason', label: 'Reason', type: 'select', options: DECLINE_REASONS, value: 'unnecessary' }, { name: 'note', label: 'Note', required: false }],
      payload: v => ({ findingId: f.id, expectedVersion: subject.version, disposition: 'declined', reason: v.reason, ...(v.note ? { note: v.note } : {}) }),
      confirm: confirmText(f, 'Decline {finding}?', tasked ? `Its task${f.taskId ? ` ${f.taskId}` : ''} is closed too.` : ''),
      intro: tasked ? 'Its task is closed, and every finding recorded against that task is declined with it. Stop the task’s flow first.' : 'It stays on record and can be reopened.' })),
    h('details', {}, h('summary', { text: 'Dealt with another way' }), commandForm(project, { key: `finding-elsewhere:${f.id}`, title: 'Record as resolved elsewhere', operation: 'finding.resolve', subject, variant: 'secondary',
      fields: [{ name: 'evidence', label: 'What dealt with it', type: 'textarea', rows: 2 }],
      payload: v => ({ findingId: f.id, expectedVersion: subject.version, disposition: 'resolved-elsewhere', evidence: v.evidence }), confirm: confirmText(f, 'Record {finding} as dealt with another way?', tasked ? `Its task${f.taskId ? ` ${f.taskId}` : ''} is closed if it has not started.` : ''), intro: tasked ? 'A task that has not started is closed.' : undefined })),
  ];
}
const reopenForm = (project, f) => h('details', {}, h('summary', { text: 'Reopen' }), commandForm(project, { key: `finding-reopen:${f.id}`, title: 'Reopen', operation: 'finding.reopen', subject: subjectOf(f), variant: 'secondary',
  fields: [{ name: 'note', label: 'Why' }], payload: v => ({ findingId: f.id, expectedVersion: findingVersion(f), note: v.note }), confirm: confirmText(f, 'Reopen {finding}?', isCandidate(f) ? 'It returns to the waiting candidates.' : 'It returns to the open findings.'), intro: 'Only a person reopens a finding. Seeing it again does not.' }));
// Times are time elements with the UTC value in their tooltip (dev.88 M9), each shown once in one
// form (dev.89 N4: a finding's status time was shown as a date under "Status changed" and as
// "1 hour ago" under "Disposition"). `shownAt` is a time the card already shows; it is not repeated.
const dispositionText = (d, shownAt = null) => !d ? undefined : h('span', {}, `${d.status}${d.reason ? `: ${d.reason}` : ''}${d.evidence ? `: ${d.evidence}` : ''}${d.note ? ` (${d.note})` : ''}${d.by ? `, by the ${d.by}` : ''}`, d.at && d.at !== shownAt ? [', ', timeNode(d.at)] : null);

// An audit finding becomes work only through a task you create and approve. Creating the task
// records it against the finding in the same step.
const findingTaskId = f => `finding-${String(f.id).replace(/^audit:/, '').slice(0, 12)}`;
function findings(project) {
  const all = (project.snapshot.findings ?? []).filter(f => !isCandidate(f)), rows = all.filter(f => ['unapproved', 'tasked'].includes(f.status)), closed = all.filter(f => CLOSED.includes(f.status));
  if (!rows.length && !closed.length) return null;
  const tasks = new Set((project.snapshot.tasks ?? []).map(t => t.id));
  const facts = f => [['Evidence', f.evidence ?? '—'], ['Seen', h('span', {}, `${String(f.observations ?? 1)} time(s), last `, f.lastObservedAt || f.createdAt ? relativeTimeNode(f.lastObservedAt ?? f.createdAt) : '—')], ['Status changed', f.statusAt ? timeNode(f.statusAt) : undefined], ['Severity', f.severity ?? undefined], ['Task', f.taskId ? link(detailHref({ projectId: project.projectId, task: f.taskId }), f.taskId) : undefined], ['Disposition', dispositionText(f.disposition, f.statusAt)],
    // A must-fix review's row (review-must-fix design 6.2, 12.3): its flow and ledger id, kind, reason and support.
    ...(f.source === 'review' ? [['Review finding', `${f.ledgerId ?? '—'} · ${f.reviewKind ?? '—'}${f.reason ? ` (${f.reason})` : ''}${f.operatorAccepted ? ' · accepted by the operator' : ''}`], ['From flow', f.flowId ? link(detailHref({ projectId: project.projectId, flow: f.flowId }), f.flowId) : undefined], ['Support', f.support ?? undefined], ['Who may act', f.operatorOnly || f.needs === 'operator' ? 'The operator only' : undefined], ['Claim digest', f.claimDigest ? short(f.claimDigest, 16) : undefined]] : [])];
  return h('div', { class: 'record-grid single' }, rows.slice().reverse().map(f => {
    // A task made for the finding before findings were recorded against tasks: record it now.
    const taskId = findingTaskId(f), made = f.status === 'unapproved' && tasks.has(taskId), subject = subjectOf(f);
    return recordCard(f.title ?? f.id, f.status === 'tasked' ? 'tasked' : made ? 'task created' : f.status, facts(f), f, [
      f.status === 'tasked' ? null : made ? commandButton(project, { key: `finding-link:${f.id}`, label: 'Record that task against this finding', operation: 'finding.accept', subject, payload: { findingId: f.id, expectedVersion: subject.version, taskId } })
        : h('details', {}, h('summary', { text: 'Create a task from this finding' }), commandForm(project, { key: `finding-task:${f.id}`, title: 'Create task', operation: 'finding.accept', subject,
          fields: [{ name: 'title', label: 'Title', value: f.title ?? '' }, { name: 'acceptance', label: 'Done when (one per line)', type: 'textarea', value: `${f.title ?? 'The finding'} is resolved${f.evidence ? ` (${f.evidence})` : ''}` }],
          payload: v => ({ findingId: f.id, expectedVersion: subject.version, task: { id: taskId, title: v.title, acceptance: v.acceptance.split('\n').map(x => x.trim()).filter(Boolean), ...(f.file ? { paths: [f.file] } : {}) } }), variant: 'secondary', intro: 'The task still needs your approval before any work starts.' })),
      ...dispositionForms(project, f)]);
  }), closed.length ? h('details', {}, h('summary', { text: plural(closed.length, 'closed finding') }), h('div', { class: 'record-grid single' }, closed.slice().reverse().map(f => recordCard(f.title ?? f.id, f.status, facts(f), f, reopenForm(project, f))))) : null);
}

const PART_LABEL = { model: 'The model call', docs: 'Docs follow-ups', context: 'Governing-context proposals', capture: 'Capture candidates', all: 'Everything', learnings: 'Learning delivery' };
const KIND_LABEL = { docs: 'Docs correction', context: 'Governing-context proposal', check: 'Check', rule: 'Governing rule', learning: 'Learning', 'learning-stale': 'Stale learning' };
const PROVENANCE = { 'assessment-model': 'Written by the upkeep assessment model' };
// Knowledge upkeep: what is suspended and why (only you lift a suspension), and the candidates
// that are waiting. Invocation totals are in Stats.
// Governing-context proposals (slice 6): only you accept them. Accepting names each proposal's
// version and the digest of what is shown here, so a proposal that changed meanwhile is refused;
// one command makes one task, approved by you, that changes those governing files.
const proposalPayload = list => ({ proposals: list.map(c => ({ findingId: c.id, expectedVersion: c.version, digest: c.acceptance.digest })) });
const acceptable = c => ['context', 'rule'].includes(c.kind) && c.status === 'unapproved' && c.acceptance?.digest && !(c.acceptance.problems ?? []).length;
// A check or learning candidate (slice 7): accepted into an unapproved task by you, or by the
// orchestrator on your instruction; you may also approve it in the same step.
const captureAcceptable = c => ['check', 'learning', 'learning-stale'].includes(c.kind) && c.status === 'unapproved' && c.acceptance && !(c.acceptance.problems ?? []).length;
// What refuses the orchestrator's acceptance beyond what refuses yours: the task ceilings (dev.92, P2).
const delegateRefusal = c => { const own = new Set(c.acceptance?.problems ?? []), extra = (c.acceptance?.delegatedProblems ?? []).filter(p => !own.has(p)); return extra.length ? extra.join('; ') : null; };
const CANDIDATE_HELP = {
  docs: 'The factory makes a docs follow-up from waiting docs candidates when upkeep proposes and the limits allow; the follow-up then needs your approval.',
  context: 'Only you can accept it. Read the quoted statement and the replacement: accepting makes a task, approved by you, that replaces exactly that statement with exactly that text.',
  rule: 'Only you can accept it. Read the rule text: accepting makes a task, approved by you, that adds exactly that text to the governing file shown.',
  check: 'Accepting makes a task that changes only the fast-check scripts named below, keeping their modes, so that they test this rule. It needs approval before it runs, and its merge is never automatic.',
  learning: 'Accepting makes a task that adds exactly one learning file, with this title and text, to the learnings directory. It needs approval before it runs. A learning is advisory and grants nothing.',
  'learning-stale': 'learnings.check found that this condition fires for the learning. Nothing has been deleted. Accepting makes a task that deletes exactly that learning file, with the content it has now, and changes nothing else. It needs approval before it runs. To correct a learning instead, decline this and write an ordinary task.',
};
function captureAccept(project, c) {
  const subject = subjectOf(c), check = c.kind === 'check';
  // A stale learning: nothing to name; its task deletes exactly the one learning file (slice 8).
  if (c.kind === 'learning-stale') return h('details', {}, h('summary', { text: 'Accept: make a task that deletes the learning' }), commandForm(project, { key: `upkeep-capture:${c.id}`, title: 'Accept', operation: 'finding.accept', subject,
    fields: [{ name: 'approve', label: 'Approval', type: 'select', options: [['no', 'Accept only; approve the task later'], ['yes', 'Accept and approve now (you only)']], value: 'no' }],
    payload: v => ({ findingId: c.id, expectedVersion: subject.version, ...(v.approve === 'yes' ? { approve: true } : {}) }),
    confirm: 'Make a task that deletes this learning file?', intro: 'The file is read again at the target head when you accept, and only that exact content may be deleted, checked on the exact candidate at commit, integration, publication and merge.' }));
  return h('details', {}, h('summary', { text: check ? 'Accept: make a task that changes the fast check' : 'Accept: make a task that adds the learning' }), commandForm(project, { key: `upkeep-capture:${c.id}`, title: 'Accept', operation: 'finding.accept', subject,
    fields: [{ name: 'list', label: check ? 'Scripts to change (blank: the script of the check it is anchored to)' : 'Paths it applies to (blank: the directory it is anchored to)', required: false, placeholder: check ? 'checks/verify.mjs' : 'src/api/**' },
      { name: 'approve', label: 'Approval', type: 'select', options: [['no', 'Accept only; approve the task later'], ['yes', 'Accept and approve now (you only)']], value: 'no' }],
    payload: v => { const list = String(v.list ?? '').split(/[,\s]+/u).map(item => item.trim()).filter(Boolean); return { findingId: c.id, expectedVersion: subject.version, ...(list.length ? { [check ? 'files' : 'paths']: list } : {}), ...(v.approve === 'yes' ? { approve: true } : {}) }; },
    confirm: check ? 'Make a task that changes these fast-check scripts?' : 'Make a task that adds this learning?', intro: 'What may change is checked again at the target head when you accept, and on the exact candidate at commit, integration, publication and merge.' }));
}
// Learnings (slice 8, after the review of b46da01): how often flows cite what they are shown (14.3),
// and what the last learnings.check refused in the store, each file with why (Q2). Text only.
function learningsPanel(view) {
  const d = view.delivery, checked = view.store, refused = checked?.refused ?? [];
  const rate = d.rate === null || d.rate === undefined ? 'no selections yet' : `${Math.round(100 * d.rate)}%`;
  return h('div', { class: 'stack' },
    d.stopped ? null : h('p', { class: 'help', text: `Learnings${view.dir ? ` (${view.dir})` : ''}: shown ${plural(d.selected, 'time')} and cited ${plural(d.cited, 'time')}${d.since ? ` since ${time(d.since)}` : ''} (${rate}). Delivery stops if fewer than ${Math.round(100 * d.minimumRate)}% are cited after ${d.window} selections; only you can restart it.` }),
    d.stopped ? h('p', { class: 'help', text: `Learning delivery is stopped: ${d.selected} selections and ${d.cited} citations since the window began. Lift the suspension above to restart it; the count then starts again.` }) : null,
    checked ? h('p', { class: 'help', text: checked.problem ? `The last learnings.check (${time(checked.at)}) could not read the store: ${checked.problem}` : `The last learnings.check (${time(checked.at)}${checked.head ? `, at ${short(checked.head, 12)}` : ''}) read ${plural(checked.learnings, 'learning')}${refused.length ? ` and refused ${plural(refused.length, 'file')}. No flow is shown a refused file, and a refused file never becomes a retirement candidate. Fix or remove each with an ordinary task` : ''}.` }) : view.dir ? h('p', { class: 'muted', text: 'No learnings.check has run yet; enqueue or schedule one to see what the store holds.' }) : null,
    refused.length ? h('ul', { class: 'plain-list' }, refused.map(row => h('li', {}, h('code', { text: row.path }), h('span', { class: 'muted small', text: ` · ${row.reason}` })))) : null);
}
// The upkeep task ceilings (dev.92, P2): what was made today and in the last seven UTC days, how much
// room the factory and the orchestrator have left, and when it returns. Your own acceptances are
// never refused by these limits; they are counted, and they use up the factory's room.
// When the factory's room returns: the later reset of every exhausted ceiling (a day can reset while
// the week is still full), or never while an exhausted ceiling has no reset (a zero limit).
export function budgetResumesAt(budget) {
  const exhausted = [budget.day, budget.week].filter(w => w && w.remaining <= 0);
  if (!exhausted.length || exhausted.some(w => !w.resetsAt)) return null;
  return exhausted.map(w => w.resetsAt).sort().at(-1);
}
function taskBudgetPanel(budget) {
  if (!budget?.day || !budget?.week) return null;
  const by = w => w.byOperator ? ` (${w.byOperator} by you)` : '';
  const room = budget.refusal ? null : `The factory and the orchestrator may make ${plural(Math.min(budget.day.remaining, budget.week.remaining), 'more task')} today.`;
  return h('div', { class: 'stack' },
    h('p', { class: 'help', text: `Upkeep tasks: ${budget.day.created} of ${budget.day.limit} today${by(budget.day)}, ${budget.week.created} of ${budget.week.limit} in the last seven UTC days${by(budget.week)}.${room ? ` ${room}` : ''}` }),
    budget.refusal ? h('p', { class: 'help' }, `The limit is reached: the factory makes no docs follow-up, and the orchestrator cannot accept a candidate, until `, (at => at ? timeNode(at) : 'the limit is raised')(budgetResumesAt(budget)), '. Your own acceptances are not limited; they still count.') : null);
}
// The share-of-invocations ceiling (dev.93, Q5): what it counts, where it stands over the last seven
// complete UTC days, and that a small project may reach it by design. Older services send nothing.
export function sharePanel(share) {
  if (!share || !Number.isSafeInteger(share.total) || !Number.isSafeInteger(share.upkeep)) return null;
  const range = `${share.oldest} to ${share.newest}, UTC`, percent = share.share === null || share.share === undefined ? 'no model invocation was counted' : `${share.share}%`;
  const standing = !share.counting ? 'Counting starts at the next upkeep run; nothing is judged before seven complete UTC days have been counted.'
    : !share.full ? ['The window is not full yet, so the ceiling is not judged until ', share.judgedFrom ? timeNode(share.judgedFrom) : 'seven complete UTC days have been counted', '.']
    : share.reached ? 'This reaches the ceiling: the next upkeep run to close suspends the model call and docs follow-ups until you lift it.'
    : `Below the ceiling of ${share.percent}%.`;
  return h('div', { class: 'stack upkeep-share' },
    h('p', { class: 'help' }, `Upkeep share of model invocations: ${share.upkeep} of ${share.total} in the last ${share.days} complete UTC days (${range}), ${percent}; the ceiling is ${share.percent}%. `, ...[standing].flat()),
    h('p', { class: 'help', text: `What counts as upkeep: each assessment’s own model call, and every planner, builder and reviewer call in the follow-up tasks upkeep creates or you accept (docs, context, check, learning and retirement tasks), against every model invocation of the project. On a project with little other work, a few follow-ups can reach ${share.percent}%; that is expected. When it does, the model call and docs follow-ups are suspended and shown above: review the share and lift the suspension if it is acceptable.` }));
}
function contextIntro(view) {
  const qualified = view.qualifiedProviders ?? [];
  return h('div', { class: 'stack' },
    view.reviewedPlans === null || view.reviewedPlans === undefined ? null : h('p', { class: 'help', text: `${plural(view.reviewedPlans, 'unfinished flow has', 'unfinished flows have')} a reviewed plan. Once a context change merges, such a flow replans if it needs another build round after it takes in the new target; one past its last build carries on.` }),
    h('p', { class: 'help', text: qualified.length ? `A context task runs its model steps only on ${qualified.join(' and ')} (upkeep.context.qualifiedProviders).` : 'No provider is recorded in upkeep.context.qualifiedProviders, so an accepted context task is not started until you record one whose instruction-loading check passed on this host (docs/qualification/provider-instructions.md).' }));
}
// The open context task, with where it stands (dev.91, O5): held by an unqualified provider (with
// the remedy), running, or queued, and what starts it. Older project services send none of these.
function contextTaskNotice(project, task) {
  const hold = task.providerHold ?? null, taskLink = link(detailHref({ projectId: project.projectId, task: task.taskId }), task.taskId);
  const where = task.flow ? `Its flow is ${task.flow.state === 'waiting' ? 'waiting' : task.flow.state}.`
    : hold ? 'It is not started while a provider it would run on is not qualified on this host.'
    : task.queued ? (task.autoQueue ? 'It is queued; automatic admission starts it when policy and capacity allow.' : 'It is queued; dispatch the queue, or start it from the task.')
    : task.approved ? 'Start it from the task.' : 'Approve it from the task to let it run.';
  return notice(hold ? 'warning' : 'info', hold ? 'Context task held' : 'Context task open', `${task.title} (${plural(task.candidates, 'proposal')}; ${task.files.join(', ')})`, h('div', { class: 'stack' },
    kv([['Task', taskLink], ['Approved', task.approved ? 'By you, when you accepted it' : 'No'], ['Flow', task.flow ? flowLink(project, task.flow.id) : undefined], ['Held by', hold ? hold.providers.join(', ') : undefined]], 'compact'),
    hold ? h('p', { text: `Why: ${hold.reason}.` }) : null,
    h('p', { class: 'help', text: `${where} Its merge question comes to you or the merge decision role and is never answered by policy. One batch of proposals is delivered at a time.` })));
}
function upkeep(project) {
  const view = project.snapshot.upkeep; if (!view) return null;
  const suspensions = view.suspensions ?? [], candidates = view.candidates ?? [], tasked = view.tasked ?? [], closed = view.closed ?? [], followUp = view.followUp ?? null, contextTask = view.contextTask ?? null, captureTasks = view.captureTasks ?? [];
  if (view.mode === 'off' && !suspensions.length && !candidates.length && !tasked.length && !closed.length && !followUp && !contextTask && !captureTasks.length && !view.learnings) return null;
  const ready = candidates.filter(acceptable), proposals = candidates.filter(c => ['context', 'rule'].includes(c.kind));
  const flows = c => c.sourceFlows?.length ? h('span', {}, c.sourceFlows.slice(-3).flatMap((flowId, i) => [i ? ', ' : '', flowLink(project, flowId)]), c.sourceFlowCount > 3 ? ` and ${c.sourceFlowCount - 3} more` : '') : undefined;
  return h('div', { class: 'stack' },
    suspensions.map(row => notice('warning', `${PART_LABEL[row.part] ?? row.part}: suspended`, row.reason, h('div', { class: 'stack' },
      kv([['Rule', row.rule], ['Since', row.at ? timeNode(row.at) : undefined]], 'compact'),
      h('details', {}, h('summary', { text: 'Lift this suspension' }), commandForm(project, { key: `upkeep-lift:${row.part}`, title: 'Lift suspension', operation: 'upkeep.lift', subject: { label: PART_LABEL[row.part] ?? row.part, version: row.at ?? null },
        fields: [{ name: 'note', label: 'Why it is safe to continue' }], payload: v => ({ part: row.part, expectedAt: row.at, note: v.note }), intro: 'Only you can lift a suspension. Turning upkeep off and on does not. The ceiling is then judged on what is recorded from now on.' })), raw('Raw suspension', row)))),
    followUp ? notice(followUp.approved ? 'info' : 'warning', `Docs follow-up ${followUp.approved ? 'approved' : 'waiting for your approval'}`, `${followUp.title} (${plural(followUp.candidates, 'candidate')}; ${followUp.files.join(', ')})`, h('div', { class: 'stack' },
      kv([['Task', link(detailHref({ projectId: project.projectId, task: followUp.taskId }), followUp.taskId)], ['Created', followUp.createdAt ? timeNode(followUp.createdAt) : undefined], ['Expires unless approved', followUp.expiresAt ? timeNode(followUp.expiresAt) : undefined]], 'compact'),
      h('p', { class: 'help', text: followUp.approved ? 'It runs through the project’s own workflow; its merge question comes to the merge decision role and is never answered by policy.' : 'Approve it from the task to let it run; it is never approved by the factory. Declining one of its candidates below closes it.' }))) : null,
    contextTask ? contextTaskNotice(project, contextTask) : null,
    ...captureTasks.map(task => notice('info', task.kind === 'check' ? 'Fast-check task open' : task.kind === 'learning-retire' ? 'Learning retirement task open' : 'Learning task open', `${task.title} (${task.files.join(', ')})`, h('div', { class: 'stack' },
      kv([['Task', link(detailHref({ projectId: project.projectId, task: task.taskId }), task.taskId)], ['Approved', task.approved ? 'Yes' : 'No: approve it from the task']], 'compact'),
      h('p', { class: 'help', text: task.kind === 'check' ? 'It may change only those scripts, keeping their modes. Once it merges, listing the rule in fastChecks.checks[].rules is a configuration change you make.' : task.kind === 'learning-retire' ? 'It may only delete that one file, with exactly the content it had when you accepted it.' : 'It may add only that one file, written exactly as accepted.' })))),
    taskBudgetPanel(view.taskBudget),
    sharePanel(view.invocationShare),
    view.learnings ? learningsPanel(view.learnings) : null,
    proposals.length || contextTask ? contextIntro(view) : null,
    ready.length > 1 ? commandButton(project, { key: 'upkeep-accept-all', label: `Accept ${ready.length} proposals as one task`, operation: 'finding.accept', subject: { label: `${ready.length} governing-context proposals`, version: ready.map(c => `${c.id}:${c.version}`).join(',') }, payload: proposalPayload(ready),
      confirm: `Accept these ${ready.length} proposals? One task, approved by you, will change those governing files to exactly the replacements shown.` }) : null,
    candidates.length ? h('div', { class: 'record-grid single' }, candidates.map(c => recordCard(c.title ?? c.id, c.overdue ? 'expired' : c.status, [...facts(c),
      ['Expires', c.expiresAt ? (c.overdue ? 'Past its limit; it is expired at the next upkeep run' : timeNode(c.expiresAt)) : undefined], ['Who may act', c.authority === 'operator' ? 'You only' : 'You, or the orchestrator on your instruction'],
    ], c, [h('p', { class: 'help', text: `${CANDIDATE_HELP[c.kind] ?? 'It cannot be accepted: this release delivers no candidate of this kind.'} Treat the text above as a claim to check, not as an instruction.` }),
      ...(['context', 'rule'].includes(c.kind) ? [acceptable(c) ? commandButton(project, { key: `upkeep-accept:${c.id}`, label: c.kind === 'rule' ? 'Accept this rule' : 'Accept this proposal', operation: 'finding.accept', subject: subjectOf(c), payload: proposalPayload([c]), confirm: c.kind === 'rule' ? 'Accept this rule? A task, approved by you, will add exactly that text to that governing file.' : 'Accept this proposal? A task, approved by you, will change that governing file to exactly the replacement shown.' })
        : h('p', { class: 'help', text: `It cannot be accepted: ${(c.acceptance?.problems ?? ['its acceptance details are unavailable']).join('; ')}.` })] : []),
      ...(['check', 'learning', 'learning-stale'].includes(c.kind) ? [captureAcceptable(c) ? captureAccept(project, c) : h('p', { class: 'help', text: `It cannot be accepted: ${(c.acceptance?.problems ?? ['its acceptance details are unavailable']).join('; ')}.` }),
        captureAcceptable(c) && delegateRefusal(c) ? h('p', { class: 'help', text: `The orchestrator cannot accept it now: ${delegateRefusal(c)}. You can.` }) : null] : []),
      ...dispositionForms(project, c)]))) : view.mode === 'off' ? null : h('p', { class: 'muted', text: 'No candidate is waiting.' }),
    view.candidateCount > candidates.length ? h('p', { class: 'muted', text: `${view.candidateCount - candidates.length} more are open and not shown.` }) : null,
    tasked.length ? h('details', {}, h('summary', { text: plural(view.taskedCount ?? tasked.length, 'candidate with a task', 'candidates with a task') }), h('div', { class: 'record-grid single' }, tasked.map(c => recordCard(c.title ?? c.id, 'tasked', [...facts(c),
      ['Task', c.taskId ? link(detailHref({ projectId: project.projectId, task: c.taskId }), c.taskId) : undefined], ['Who may act', c.authority === 'operator' ? 'You only' : 'You, or the orchestrator on your instruction']], c, dispositionForms(project, c))))) : null,
    closed.length ? h('details', {}, h('summary', { text: plural(view.closedCount ?? closed.length, 'closed candidate') }), h('div', { class: 'record-grid single' }, closed.map(c => recordCard(c.title ?? c.id, c.status, [...facts(c),
      ['Last task', c.lastTaskId ?? c.taskId ?? undefined], ['Disposition', dispositionText(c.disposition)]], c, reopenForm(project, c))))) : null);
  function facts(c) {
    const withheld = field => c.withheld?.includes(field) ? 'Withheld: it fails the text rules' : undefined;
    return [['Kind', KIND_LABEL[c.kind] ?? c.kind], ['File', c.file ?? undefined], ['Context entries', c.entries?.length ? c.entries.join(', ') : undefined], ['Quoted statement', c.quote ?? undefined], ['Proposed replacement', c.replacement ?? withheld('replacement')], ['Text', c.text ?? withheld('text')],
      ['Where', c.anchor ? `${c.anchor}${c.topic ? ` · ${c.topic}` : ''}` : undefined], ['Reason given', c.reason ?? withheld('reason')], ['Flagged for', c.flags?.length ? c.flags.join(', ') : undefined], ['File version', ['context', 'rule'].includes(c.kind) && c.blob ? short(c.blob, 12) : undefined], ['Fast-check scripts', c.kind === 'check' && c.acceptance?.scripts?.length ? c.acceptance.scripts.map(row => row.script ? `${row.checkId}: ${row.script}` : `${row.checkId}: none (${row.why})`).join('; ') : undefined], ['Reclassified from', c.reclassifiedFrom ? `docs candidate ${short(c.reclassifiedFrom, 16)}` : undefined],
      ['Written by', PROVENANCE[c.provenance] ?? c.provenance ?? 'Not recorded'], ['Source flows', flows(c)], ['Returned', c.returns ? plural(c.returns, 'time') : undefined]];
  }
}

export function operationsView(project) {
  if (!available(project)) return notice('warning', `${project.name} is ${project.status}.`, 'Health records are unavailable until the project service responds.');
  const attention = recovery(project), audit = findings(project), knowledge = upkeep(project);
  return h('div', { class: 'view' },
    attention ? card('Needs recovery', attention, { level: 'h2', cls: 'span-all', subtitle: 'Work is held or uncertain until this is resolved.' }) : null,
    card(project.snapshot.targets?.length > 1 ? `Main health (${project.snapshot.settings?.repository?.target ?? 'main'})` : 'Main health', health(project), { level: 'h2', cls: 'span-all' }),
    ...(project.snapshot.targets ?? []).slice(1).map(target => card(`${target} health`, health(project, project.snapshot.targetHealth?.[target] ?? { status: 'unknown' }, target, target), { level: 'h2', cls: 'span-all', subtitle: `Work whose workflow targets ${target} waits on this.` })),
    knowledge ? card('Knowledge upkeep', knowledge, { level: 'h2', cls: 'span-all', subtitle: 'Candidates the upkeep assessment raised, the docs follow-up made from them, governing-context proposals only you accept, and anything suspended. Nothing runs without your approval.' }) : null,
    audit ? card('Audit findings', audit, { level: 'h2', cls: 'span-all', subtitle: 'Found by the audit job. Nothing runs unless you create and approve a task.' }) : null,
    h('p', { class: 'muted small span-all' }, 'Post-merge obligations are to-dos in the ', link(href({ projectId: project.projectId, tab: 'inbox' }), 'Inbox'), '. Retrospectives, context given to agents, rule proposals and regressions are in each flow’s detail; notification and other logs are in ', link(href({ projectId: project.projectId, tab: 'history' }), 'History'), '.'));
}
