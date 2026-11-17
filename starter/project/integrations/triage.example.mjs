#!/usr/bin/env node
// Triage rules for a T3 triage proxy thread (project-owned example; copy to
// project/integrations/triage.mjs and adapt). Node only, no dependencies.
//
// The proxy thread receives Factotum's webhook wakes and its own timers instead of the
// orchestrator. This script decides, in code, whether a wake is provably routine (absorb),
// goes to the orchestrator (forward), or should be read again after a short wait (recheck). The
// principle: the proxy must never be the reason an item a person needs goes quiet. Anything
// open, anything malformed or unknown, and anything not confirmed as received is forwarded, and
// a forward proposes no action.
//
//   Decide one wake (stdin: the webhook payload as JSON):
//     node triage.mjs --project <projectId> --forward-to <orchestrator thread id> --state <narrow-read.json> --memory <state.json> --log <log.jsonl>
//   where <narrow-read.json> is the output of `status --inbox <inboxId>` (inbox wake) or
//   `status --task <taskId> [--flow <flowId>]` (state wake). On `recheck`, wait `delaySeconds`,
//   read state again and run the same command once more.
//   Timer check (stdin: `status --compact`): node triage.mjs --timer [--stall-minutes 120] [--idle-minutes 10] --memory … --log …
//   Digest of what was absorbed since the last confirmed digest: node triage.mjs --digest --state <status --compact read> --memory … --log …
//   Confirm that a forward reached the orchestrator thread: node triage.mjs --sent <sendId> --to <send.threadId> --memory … --log …
//   The proxy judged an `unsure` delivery routine (after delivery.ack): node triage.mjs --judged-absorb <deliveryId> --note '<why>' --memory … --log …
//   Counts (forwarded, absorbed, unsure, missed, lookups): node triage.mjs --counts --log <log.jsonl> [--since <ISO time>]
//   The orchestrator records something the proxy dropped (absorbed) or a forward lacked (lookup):
//     node triage.mjs --missed --kind absorbed|lookup --log <log.jsonl> --note '<what>' [--ref <id>]
//   …or closes a forward addressed to it that it handled from state (undelivered) or found unconfirmed in its thread (received):
//     node triage.mjs --missed --kind undelivered|received --ref <sendId> --for <its thread id> --note '<what>' --log <log.jsonl>
//   The orchestrator checks a forward against the log: node triage.mjs --verify <sendId> --log <log.jsonl>
//   Confirmed forwards since a time (for a successor): node triage.mjs --forwards --since <ISO time> --log <log.jsonl>
//   Forwards decided and never confirmed sent: node triage.mjs --forwards --unconfirmed [--since <ISO time>] [--for <thread id>] --log <log.jsonl>
//   Deliveries absorbed since a time: node triage.mjs --absorbed [--since <ISO time>] --log <log.jsonl>
//   A send failed (prints what to do next): node triage.mjs --send-failed <sendId> --to <send.threadId> --error '<the error>' [--state <status reread>] --memory … --log …
//   After the run's sends are recorded, the operator notice for a forward marked escalateDue (or null
//   if it no longer applies): node triage.mjs --escalate <sendId> --memory … --log …
//   The operator was told of an undelivered forward: node triage.mjs --escalated <sendId> --state <status --inbox read of the notice> --memory … --log …
//   Setup: node triage.mjs --set-proxy-id <proxy thread id> --memory … --log …   (`--help` lists everything)
//
// Every recorded forward carries a provenance line (the proxy's thread ID, the rule, the delivery,
// the send ID and when it was decided) that the orchestrator can check with --verify. T3 does not
// authenticate senders, so the line is a claim to check, not proof.
//
// Output: one JSON object {decision, rule, reason, actions, forward, forwardTo, forwardSource,
// sendId, send, retries, closed, delaySeconds?, escalateDue?}. `actions` (absorb only) are commands the proxy
// runs as `CLI command STATE --actor orchestrator --operation <operation> --payload '<payload>'`.
// `forward` is the stand-alone message for the orchestrator thread `forwardTo`, and `send` is the
// ready-made `t3_thread_send` arguments object for it ({threadId, message, mode}), passed as it is
// so the thread ID is never retyped; after sending it the proxy confirms with `--sent <sendId>`.
// Nothing a forward reports counts as reported until it is confirmed: an unconfirmed timer finding
// or digest is produced again by the next run (even if its condition has cleared meanwhile), and an
// unconfirmed delivery forward is re-sent by every later run (`retries`, oldest first, after a
// grace period), under the same send ID, always to the one destination: the orchestrator session
// bound now, else the configured thread. A forward about an open item is re-sent only after a fresh
// read of the open items: the run's own, or the `reread` a failed send passes to `--send-failed
// --state` (dev.88, L2). A failed send is recorded with `--send-failed`, which says what to do next:
// send it once more, or, when the destination is down for it, tell the operator (`escalateDue`), one
// notice per outage. There is no fallback to another thread: a broken binding waits for a rebind or
// the operator (dev.88). Once the run's sends are recorded, --escalate checks again and prints the
// notice to publish only if the forward is still unconfirmed (dev.87, K1).
// (by the run's read of every open item), or that the orchestrator recorded as handled, is closed
// (`closed`) instead of re-sent. An escalation notice stays for the operator to dismiss: the proxy
// cannot prove it published a given notice, so it withdraws nothing; when the forward is later
// confirmed or closed, its next delivery forward says the notice is moot. The proxy never answers,
// approves, withdraws or merges anything (dev.86, J7; dev.87).
//
// Webhook, timer and digest runs share the state file and the log. Each run holds a lock file
// for its whole read-decide-write, so runs that overlap are serialised (see withLock).
import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, unlinkSync, linkSync, readdirSync, statSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';

// Off by default: Factotum's own `notifications.level: "actionable"` already drops proven clean
// completions and target syncs, with a stronger check than the narrow read allows (it also sees
// obligations, post-merge checks, worker reports and unresolved decisions). Turn this on only at
// `essential`, accepting that narrower check.
export const ABSORB_CLEAN_COMPLETIONS = false;
// The version of the brief and handling guide this script expects (dev.88). Every command passes
// it as `--protocol 90` (the guides' TRIAGE shorthands do); a missing or different one fails loudly,
// so a script copied without its guides, or guides without the script, never silently skips a step
// such as escalation or the read before a re-send.
export const PROTOCOL = 90;
export const STALL_MINUTES = 120;
// Approved queued work with no running or ready flow for this long is reported by the timer.
export const IDLE_MINUTES = 10;
// A re-send of a forwarded resolution (its item is closed) is forwarded again every this many
// re-sends. Open items and state deliveries are forwarded on every re-send.
export const REFORWARD_EVERY = 4;
// Race-prone notices are read again after this many seconds before deciding.
export const RECHECK_SECONDS = 60;
// Forwards decided and not confirmed sent (dev.86, J7). A run re-sends each one this long after it
// was decided or last re-sent (a send and its --sent take 10 to 25 seconds), at most RETRIES_PER_RUN
// per run, oldest first. A thread that failed FAILURES_PER_THREAD sends is not tried again at once;
// the forward goes to the next thread (the bound session read now, the thread it was decided for,
// the last bound session seen). When none is left, or the forward is still unconfirmed
// ESCALATE_MINUTES after it was decided, the run also returns `escalate`: an operator notice. A
// forward nobody confirms or reports failed is escalated by the first run at least ESCALATE_MINUTES
// after it was decided. With no webhooks the runs are the timer's, at a phase unrelated to the
// decision, so the operator hears of it within ESCALATE_MINUTES + the timer interval (just under 40
// minutes with the brief's 30-minute timer, under 20 with a 10-minute one), plus the run's own time.
// A forward unconfirmed after RETRY_HOURS is no longer re-sent (it
// stays listed by --forwards --unconfirmed). A timer run removes wake directories older than WAKE_DIR_HOURS.
export const RETRY_GRACE_SECONDS = 120;
export const RETRIES_PER_RUN = 3;
export const FAILURES_PER_THREAD = 2;
export const ESCALATE_MINUTES = 10;
export const RETRY_HOURS = 24;
export const WAKE_DIR_HOURS = 24;
// Thread IDs (T3's) and other short names: letters, digits and -:._, at most 200.
const ID = /^[A-Za-z0-9_.:-]{1,200}$/;
// Record IDs Factotum generates (inbox items, deliveries, tasks, flows, attempts, presentations):
// as core's recordId (core/contracts.mjs), up to 640 characters, starting with a letter or digit,
// and `/` allowed, since a flow ID can name a branch (dev.86, J8). The longest generated inbox ID is
// 533 characters (a target-sync flow's notice between two 200-character branch names). The proxy never uses a record ID as a path segment or in a file name: its files are
// fixed names in its directory, wake directories come from mktemp, and an ID it makes from one
// (the escalation notice's) is a fixed-length digest.
export const RECORD_ID_MAX = 640;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_.:\/-]*$/;
const NUMERIC = ['version', 'eventSequence', 'sessionVersion', 'sessionDeliveries', 'sessionDeliveryLimit', 'approvalVersion'];
const INBOX_EVENTS = ['inbox.attention', 'inbox.resolved'];
const INBOX_STATUSES = ['open', 'answered', 'expired', 'acknowledged', 'superseded'];
// Resolution kind and the item status it comes with (notifications.mjs inboxResolution; a withdrawal leaves status superseded).
const RESOLUTIONS = { answered: 'answered', acknowledged: 'acknowledged', withdrawn: 'superseded', expired: 'expired', superseded: 'superseded' };
const STATE_EVENTS = ['task.approved', 'task.revoked', 'task.approval-revoked', 'flow.admitted', 'planning.admitted', 'flow.stopped', 'flow.resumed', 'flow.finished'];
const FAILING_ROUTES = ['fail', 'failed', 'blocked', 'partial', 'error', 'uncertain', 'stopped'];
const UNSETTLED_ATTEMPTS = ['failed', 'uncertain', 'prepared', 'dispatching', 'launching', 'running'];
const IN_FLIGHT_ATTEMPTS = ['prepared', 'dispatching', 'launching', 'running'];
const TERMINAL_FLOWS = ['completed', 'failed', 'stopped'];
const clip = (text, n) => { const s = String(text ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isId = value => typeof value === 'string' && ID.test(value);
export const isRecordId = value => typeof value === 'string' && value.length <= RECORD_ID_MAX && RECORD_ID.test(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;
const isTime = value => typeof value === 'string' && !Number.isNaN(Date.parse(value));

// A webhook prompt renders absent fields as empty text: drop them and restore numbers and booleans.
export function normalizePayload(raw) {
  if (!isObject(raw)) return null;
  const p = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null || value === '' || value === 'undefined' || value === 'null') continue;
    if (NUMERIC.includes(key) && typeof value === 'string' && /^\d{1,15}$/.test(value)) p[key] = Number(value);
    else if (key === 'presentationEnded' && (value === 'true' || value === 'false')) p[key] = value === 'true';
    else p[key] = value;
  }
  // Payloads from releases before state events carry no kind; they are inbox payloads.
  if (p.kind === undefined && p.inboxId !== undefined) p.kind = 'inbox';
  return p;
}
// The schema per kind and event. Payloads grow additively and carry no schema version, so fields
// the script does not know are ignored; every field it knows is checked strictly when present.
// Anything that fails is forwarded, with no actions.
export function validatePayload(p, projectId = null) {
  if (!p) return 'not a JSON object';
  if (!isRecordId(p.projectId) || !isRecordId(p.deliveryId)) return 'projectId or deliveryId missing or malformed';
  if (projectId && p.projectId !== projectId) return 'payload names another project';
  for (const key of ['inboxId', 'taskId', 'flowId', 'presentationId']) if (p[key] !== undefined && !isRecordId(p[key])) return `${key} malformed`;
  if (p.actor !== undefined && !isId(p.actor)) return 'actor malformed';
  for (const key of ['sessionVersion', 'sessionDeliveries', 'sessionDeliveryLimit', 'approvalVersion']) if (p[key] !== undefined && !isCount(p[key])) return `${key} is not a whole number`;
  for (const key of ['version', 'eventSequence']) if (p[key] !== undefined && !(Number.isSafeInteger(p[key]) && p[key] >= 1)) return `${key} is not a positive whole number`;
  for (const key of ['observedAt', 'eventAt']) if (p[key] !== undefined && !isTime(p[key])) return `${key} is not a time`;
  if (p.presentationEnded !== undefined && typeof p.presentationEnded !== 'boolean') return 'presentationEnded is not a boolean';
  if (p.taskRevision !== undefined && !(['string', 'number'].includes(typeof p.taskRevision) && isId(String(p.taskRevision)))) return 'taskRevision malformed';
  for (const key of ['kind', 'event', 'status', 'resolution']) if (p[key] !== undefined && typeof p[key] !== 'string') return `${key} is not text`;
  if (p.kind === 'inbox') {
    if (p.inboxId === undefined) return 'inboxId missing';
    if (p.version === undefined) return 'version missing';
    if (!INBOX_EVENTS.includes(p.event)) return 'unknown inbox event';
    if (!INBOX_STATUSES.includes(p.status)) return 'unknown inbox status';
    if (p.presentationEnded === true && p.presentationId === undefined) return 'presentationId missing';
    if (p.presentationEnded !== true && p.presentationId !== undefined) return 'presentationId without presentationEnded';
    if (p.event === 'inbox.attention') {
      if (p.status !== 'open') return 'attention for an item that is not open';
      if (p.resolution !== undefined || p.actor !== undefined) return 'attention payload carries a resolution';
    } else {
      if (!Object.hasOwn(RESOLUTIONS, p.resolution)) return 'unknown or missing resolution';
      if (RESOLUTIONS[p.resolution] !== p.status) return 'resolution does not match status';
    }
    return null;
  }
  if (p.kind === 'state') {
    if (!STATE_EVENTS.includes(p.event)) return 'unknown state event';
    if (p.eventSequence === undefined) return 'eventSequence missing';
    if (p.version !== undefined && p.version !== p.eventSequence) return 'version differs from eventSequence';
    if (p.taskId === undefined) return 'taskId missing';
    // Factotum's state payloads carry no inbox fields; one that does is not a payload this script knows.
    for (const key of ['resolution', 'actor', 'status', 'inboxId', 'presentationEnded', 'presentationId']) if (p[key] !== undefined) return `state payload carries ${key}`;
    return null;
  }
  return 'unknown payload kind';
}

// A completion notice whose visible evidence is clean (only with ABSORB_CLEAN_COMPLETIONS).
export function cleanCompletion(item, state) {
  const flow = state?.flow;
  if (!isObject(item) || !isObject(flow) || item.kind !== 'notice' || item.status !== 'open' || item.role !== 'orchestrator') return false;
  if (!String(item.id).startsWith(`flow-notice:${item.flowId}:completed:`) || item.outcome !== 'completed' || item.terminalReason || item.cleanupOutstanding || item.retrospectiveId !== item.flowId) return false;
  // Exactly the default sentence: no "Corrected on the way", no cleanup note, no scheduled-task report.
  if (item.context !== `The ${flow.kind ?? 'workflow'} finished with outcome completed. Read its retained evidence and retrospective.`) return false;
  if (flow.id !== item.flowId || !['change', 'document'].includes(flow.kind) || flow.outcome !== 'completed') return false;
  const evidence = isObject(flow.evidence) ? flow.evidence : {};
  if (evidence.merge?.merged !== true || evidence.cleanup?.released !== true) return false;
  const dirty = Object.values(evidence).some(row => !isObject(row) || FAILING_ROUTES.includes(row.route) || (row.findings?.length ?? 0) > 0
    || (Array.isArray(row.checks) && row.checks.some(check => check?.status !== 'passed')));
  return !dirty && Array.isArray(state.attempts) && !state.attempts.some(row => UNSETTLED_ATTEMPTS.includes(row?.status));
}
// An open flow question that decides a merge (its answers include merge). The narrow read has no
// workflow, so this is a heuristic; core's isMergeQuestion uses the workflow node.
export const isMergeQuestion = item => isObject(item) && item.kind === 'question' && !item.standalone && isRecordId(item.flowId)
  && ((Array.isArray(item.answers) && item.answers.includes('merge')) || (Array.isArray(item.choices) && item.choices.some(c => c?.id === 'merge')));
// What a merge decision needs, from the narrow read. Fields the narrow read lacks are named.
export function mergeFacts(item, flow) {
  const evidence = isObject(flow?.evidence) ? flow.evidence : {}, rows = Object.entries(evidence).filter(([, row]) => isObject(row));
  const [reviewStep, review] = rows.find(([step, row]) => step === 'review' && row.verdict) ?? rows.find(([, row]) => typeof row.verdict === 'string') ?? [];
  const [gateStep, gate] = rows.find(([step, row]) => step === 'gate' && Array.isArray(row.checks)) ?? rows.find(([, row]) => Array.isArray(row.checks)) ?? [];
  const short = head => typeof head === 'string' ? head.slice(0, 12) : 'unknown';
  const checks = Array.isArray(gate?.checks) ? gate.checks : [], failed = checks.filter(c => c?.status !== 'passed');
  const heads = review?.head && gate?.head ? (review.head === gate.head ? 'yes' : `no (review ${short(review.head)}, gate ${short(gate.head)})`) : 'unknown (a head is missing)';
  return [`Merge decision: answer with inbox ${item.id} version ${item.version} subject digest ${item.subjectDigest ?? 'missing'}; risk ${clip(flow?.effectiveRisk ?? 'unknown', 30)}.`,
    review ? `Review (${reviewStep}): verdict ${clip(review.verdict, 30)}, ${Array.isArray(review.findings) ? review.findings.length : 'unknown'} finding(s), head ${short(review.head)}.` : 'Review: no review verdict in the narrow read.',
    gate ? `Gate (${gateStep}): ${checks.length - failed.length} of ${checks.length} check(s) passed${failed.length ? `; not passed: ${failed.map(c => `${clip(c?.id, 40)} ${clip(c?.status, 20)}`).join(', ')}` : ''}, head ${short(gate.head)}.` : 'Gate: no gate checks in the narrow read.',
    `Review and gate on the same head: ${heads}.`,
    'Not in the narrow read: the pull request link and its forge check state (see the console, or mergeContext in status --compact); read the PR diff before deciding.'].join('\n');
}

// Forward budgets. A forward must stand alone, so each section has its own budget and the parts the
// orchestrator needs most (the headline, provenance, IDs, the ask, the task, the carried questions,
// the attempts, the acknowledgement line) survive a long context. The whole forward stays under
// FORWARD_CHARS; whatever is cut says so and where the rest is.
export const FORWARD_CHARS = 8000;
export const BUDGET = { title: 200, question: 600, note: 1000, context: 2000, section: 500, carriedShown: 10, carriedLine: 400, attempts: 3, attemptText: 400 };
// Core's heading for the questions a completed flow went ahead on (core/worker-questions.mjs carriedQuestionsText).
export const CARRIED_HEADING = 'Questions this flow went ahead on without an answer, with the answers assumed:';
const NOT_SETTLED_OK = ['failed', 'uncertain', 'aborted', ...IN_FLIGHT_ATTEMPTS];

// A completion notice's context is the reason (or the default sentence), then optional paragraphs:
// "Corrected on the way: …", the carried questions (a heading and numbered lines), "Cleanup is
// outstanding: …" (core/project.mjs flowNotice). Split it so each part has its own budget.
export function contextSections(context) {
  const main = [], other = []; let carried = null;
  for (const para of String(context ?? '').split(/\n\s*\n/)) {
    const lines = para.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (lines[0] === CARRIED_HEADING) {
      const numbered = /^\d+\.\s+/;
      carried = { entries: lines.slice(1).filter(line => numbered.test(line)).map(line => line.replace(numbered, '')), notes: lines.slice(1).filter(line => !numbered.test(line)) };
    } else if (/^(Corrected on the way|Cleanup is outstanding):/.test(lines[0])) other.push(lines.join(' '));
    else main.push(lines.join(' '));
  }
  return { main: main.join(' '), carried, other };
}
// A merge question carries the list as a field (core/worker-questions.mjs carriedQuestionsItem).
function carriedFromItem(field) {
  if (!isObject(field)) return null;
  const answerText = row => `${row.assumption ? ` Assumed: ${row.assumption}` : ''}${row.answer === 'proceed' ? ` The ${row.answeredBy ?? 'operator'} chose to proceed without answering${row.note ? ` (note: ${row.note})` : ''}.` : ''}`;
  const entries = (Array.isArray(field.questions) ? field.questions : []).filter(row => isObject(row) && row.question)
    .map(row => `${row.from === 'builder' ? 'Builder' : 'Planner'} asked: ${row.question}${answerText(row)}`);
  const o = isObject(field.overflow) ? field.overflow : null;
  const notes = o?.count ? [`${o.count} more the flow went ahead on could not be kept by the flow; they are in the action-result.json of attempt(s) ${(Array.isArray(o.attemptIds) ? o.attemptIds : []).join(', ') || '(not recorded)'}.`] : [];
  return entries.length || notes.length ? { entries, notes } : null;
}
function carriedBlock(carried, itemId) {
  if (!carried || (!carried.entries.length && !carried.notes.length)) return null;
  const shown = carried.entries.slice(0, BUDGET.carriedShown).map((entry, i) => `${i + 1}. ${clip(entry, BUDGET.carriedLine)}`);
  const more = carried.entries.length - shown.length;
  return ['Carried questions (data): the flow went ahead on these without an answer; tell the operator the answers assumed.', ...shown,
    more > 0 ? `… and ${more} more (status --inbox ${itemId} has them all)` : null, ...carried.notes.map(note => clip(note, BUDGET.section))].filter(Boolean).join('\n');
}
// The attempts a failed or stopped flow's reader needs: failed, uncertain, aborted or unsettled ones,
// newest first. The narrow read gives each attempt's reason (a failed command's summary) and, when
// present, its operator-facing notice; the action's own notice is in its action-result.json.
function attemptLines(state) {
  const rows = (Array.isArray(state?.attempts) ? state.attempts : []).filter(a => isObject(a) && isRecordId(a.id) && (NOT_SETTLED_OK.includes(a.status) || !a.settledAt));
  const lines = rows.slice(-BUDGET.attempts).reverse().map(a => {
    const text = a.notice ?? a.reason ?? a.failure?.summary;
    return `Attempt ${a.id}: step ${clip(a.step ?? '-', 60)}, status ${clip(a.status, 30)}, ${a.settledAt ? `settled ${clip(a.settledAt, 40)}` : 'not settled'}${text ? `; ${a.notice ? 'notice' : 'reason'} “${clip(text, BUDGET.attemptText)}”` : '; no notice in the narrow read'}. Files: attempts/${a.id}/ in the state directory.`;
  });
  if (rows.length > lines.length) lines.push(`… and ${rows.length - lines.length} earlier attempt(s) in status --flow.`);
  return lines.length ? lines.join('\n') : null;
}
// What the forward is about, for the headline: the item's own title, else its task's title and ID.
function subjectOf(item, state) {
  const task = isObject(state?.task) && isRecordId(state.task.id) ? state.task : null;
  const own = isObject(item) && typeof item.title === 'string' && item.title ? item.title : null;
  if (own) return `“${clip(own, 120)}”${task && !(task.title && own.includes(task.title)) ? ` (task ${task.id}: “${clip(task.title, 80)}”)` : ''}`;
  if (task) return `“${clip(task.title ?? task.id, 120)}” (task ${task.id})`;
  if (isObject(item) && item.question) return `“${clip(item.question, 120)}”`;
  return isObject(item) ? `item ${clip(item.id, 120)}` : 'an item';
}
// Fit the parts into FORWARD_CHARS: `keep` parts always stay whole; the others are cut in priority order (lower first kept).
function fit(parts, cap = FORWARD_CHARS) {
  let used = parts.filter(p => p.keep).reduce((n, p) => n + p.text.length + 1, 0);
  for (const p of parts.filter(p => !p.keep).sort((a, b) => a.priority - b.priority)) {
    const room = cap - used - 1;
    if (room < 80) { p.text = ''; continue; }
    if (p.text.length > room) p.text = `${p.text.slice(0, room - 40)}… (cut to fit the forward)`;
    used += p.text.length + 1;
  }
  return parts.filter(p => p.text).map(p => p.text).join('\n');
}
// The last guard on any recorded forward (timer findings and reset notes are not built by fit):
// keep the first three lines (headline, provenance, IDs) and the last (the acknowledgement or the
// ask), and cut the middle, saying so.
export function capForward(text, cap = FORWARD_CHARS) {
  const whole = String(text);
  if (whole.length <= cap) return whole;
  const lines = whole.split('\n'), head = lines.slice(0, 3), tail = lines.length > 3 ? [lines.at(-1)] : [];
  const middle = lines.slice(3, lines.length > 3 ? -1 : undefined).join('\n');
  const fixed = [...head, ...tail].reduce((n, line) => n + line.length + 1, 0);
  const note = n => `… (${n} characters cut to fit the forward; read the item, state or the triage log for the rest)`;
  const room = cap - fixed - note(middle.length).length - 2;
  const kept = room > 0 ? middle.slice(0, room) : '';
  const out = [...head, ...(kept ? [kept] : []), note(middle.length - kept.length), ...tail].join('\n');
  return out.length <= cap ? out : `${out.slice(0, cap - 1)}…`;
}

// The ask for each forwarded case. The orchestrator's handling guide says how; this says what.
function ask(rule, item) {
  switch (rule) {
    case 'presentation-ended': return 'A prompt presentation for this item ended: take the prompt down per the ask procedure (cancel the asking child) and say so in one line.';
    case 'operator-question': return isMergeQuestion(item) ? 'A merge decision for the operator is open. Summarise the candidate for them (facts below). Do not answer it for them.' : 'An operator question is open. Tell the operator what it asks and where to answer (the console, or their reply to you). Do not answer it for them.';
    case 'handoff': return 'Factotum asks for a handoff to a fresh orchestrator session. Follow the handoff section of your handling guide: the successor binds itself with orchestrator.session; the webhook stays on the triage proxy (if the question\'s text says to move the notification binding, that does not apply with a proxy). Do not answer the question: the successor\'s binding closes it.';
    case 'orchestrator-question': return isMergeQuestion(item) ? 'A merge decision delegated to you is open. Decide it under your handling guide\'s merge conditions (facts below; read the PR diff), or summarise it for the operator.' : 'An orchestrator question is open (for example an orchestrator task). Decide it under your handling guide and project policy, or summarise it for the operator.';
    case 'operator-notice': return item?.operatorAckOnly === true ? 'A notice for the operator. Tell them in one line what it is. Only the operator can acknowledge it and its delivery: run neither inbox.ack nor delivery.ack.' : 'A notice for the operator. Tell them in one line what it is. Do not inbox.ack it.';
    case 'flow-notice': return item?.outcome === 'completed'
      ? 'A flow completed. Tell the operator the task, its outcome and any carried questions with the answers assumed (below); then acknowledge the notice with inbox.ack per your handling guide.'
      : `A flow ended${item?.outcome ? ` with outcome ${item.outcome}` : ''}. Summarise the cause from the notice and the attempts named below (read an attempt's files only if they are not enough); then acknowledge the notice with inbox.ack per your handling guide.`;
    case 'flow-still-active': return 'A flow notice arrived while its flow still reads as active, also after a re-check. Read the flow and handle the notice per your handling guide.';
    case 'notice': return 'A notice for the orchestrator. Handle it per your handling guide.';
    case 'reminder': return 'This item is still open. Factotum re-sent it because the delivery was not acknowledged. Handle it, or if you already have, acknowledge the delivery.';
    case 'resend': return 'Factotum keeps re-sending this delivery because it was not acknowledged. Handle it if you have not, then acknowledge the delivery.';
    case 'answered': return 'A question was answered. Read the answer (and answerNote) and act within policy; an answer by itself authorizes nothing more.';
    case 'expired': return 'A question expired unanswered. Say so; its flow may have stopped.';
    case 'withdrawn': return 'An item was withdrawn by someone other than the orchestrator. Say so in one line.';
    case 'approval-revoked': return 'A task approval was revoked or invalidated and was still not restored after a re-check. Say in one line that it needs re-approval.';
    case 'approval': return 'A task was approved but is not queued or running. Check it first: if its last flow failed, was abandoned or is stopped, diagnose that flow before anything else and do not queue or restart the task until the cause is understood and fixed (or the operator says to). Otherwise queue it under your handling guide if it is open, unblocked and approved at its current revision.';
    case 'flow-stopped': return 'A flow stopped. Read it and summarise why.';
    case 'invalid-payload': return 'A webhook payload failed validation. Triage read nothing and acknowledged nothing; check notification health and the webhook task.';
    case 'no-state': return 'Triage could not read this item\'s state, so it applied no rule. Read the item yourself (if status --inbox refuses its ID, find it in status --compact under .inbox[]) and handle it per your handling guide.';
    case 'item-missing': return 'The narrow read did not find this item. Look for it in status --compact (.inbox[]) and handle it per your handling guide.';
    default: return 'Triage has no rule for this. Read it and handle it per your handling guide.';
  }
}
// Which session a count belongs to (dev.88): Factotum counts a delivery for the session bound when
// it dispatched it (the payload's sessionVersion), so a forward sent after a rebind can carry the
// earlier session's count. The forward names that session, and says so when another is bound now.
function sessionNote(p, state) {
  const now = Number.isSafeInteger(state?.project?.session?.version) ? state.project.session.version : null;
  if (p.sessionVersion === undefined) return ' (session not named: this webhook prompt does not pass sessionVersion)';
  if (now !== null && now !== p.sessionVersion) return ` (counted for session ${p.sessionVersion}; the bound session is now ${now}, so this count is not part of its count)`;
  return ` (session ${p.sessionVersion})`;
}
function forwardText({ p, rule, reason, state, item, memory, logPath, prior, rechecked, reserve = 0 }) {
  if (rule === 'invalid-payload') return `[Factotum via triage] Unreadable webhook payload (${reason}).\nAsked of you: ${ask(rule)}\nTriage did: nothing; the payload is not repeated here.`;
  const ids = [`project ${p.projectId}`, `delivery ${p.deliveryId}`, `${p.kind} ${p.event}`,
    p.inboxId && `inbox ${p.inboxId} v${p.version}`, (p.taskId ?? item?.taskId) && `task ${p.taskId ?? item.taskId}`, (p.flowId ?? item?.flowId) && `flow ${p.flowId ?? item.flowId}`,
    p.resolution && `resolution ${p.resolution}${p.actor ? ` by ${p.actor}` : ''}`, p.presentationEnded && `presentation ${p.presentationId} ended`,
    p.sessionDeliveries !== undefined && `session delivery ${p.sessionDeliveries}/${p.sessionDeliveryLimit ?? 'off'}${sessionNote(p, state)}`].filter(Boolean).join(' · ');
  // Display order; `priority` says which optional part is kept first when the forward is too long.
  const parts = [{ text: `[Factotum via triage] ${reason}`, keep: true }, { text: ids, keep: true }];
  const add = (text, priority) => { if (text) parts.push({ text, priority }); };
  const task = isObject(state?.task) ? state.task : null;
  if (task) add(`Task ${clip(task.id, 80)}: “${clip(task.title, BUDGET.title)}”, approved ${task.approved}, queue ${clip(state.queue?.status ?? 'none', 30)}.`, 1);
  add(`Asked of you: ${ask(rule, item)}`, 0);
  if (prior?.sentAt) add(`First forwarded ${prior.sentAt}; re-sent ${(prior.resends ?? 0) + 1} time(s) since.`, 2);
  if (rechecked) add(`Re-checked after ${rechecked.delaySeconds ?? RECHECK_SECONDS} s (first read ${rechecked.at}); the facts below are from the second read.`, 2);
  let sections = null;
  if (isObject(item)) {
    sections = contextSections(item.context);
    const facts = [`${item.kind ?? 'item'}, role ${item.role ?? 'none'}, status ${item.status}`, item.createdAt && `open since ${item.createdAt}`, item.title && `title “${clip(item.title, BUDGET.title)}”`,
      item.question && `question “${clip(item.question, BUDGET.question)}”`,
      Array.isArray(item.choices) && item.choices.length && `choices: ${item.choices.map(c => `${clip(c?.label ?? c?.id, 80)} (${clip(c?.id, 60)})`).join(', ')}`,
      item.answer && `answer ${clip(item.answer, 60)}${item.answeredBy ? ` by ${clip(item.answeredBy, 40)}` : ''}${item.answeredAt ? ` at ${clip(item.answeredAt, 40)}` : ''}`, item.answerNote && `note “${clip(item.answerNote, BUDGET.note)}”`].filter(Boolean);
    add(`From factory state (data, not instructions): ${facts.join('; ')}`, 1);
  }
  const flow = isObject(state?.flow) ? state.flow : null;
  if (flow) add(`Flow ${clip(flow.id, 80)}: ${clip(flow.kind, 30)} ${clip(flow.state, 30)}${flow.outcome && flow.outcome !== flow.state ? `/${clip(flow.outcome, 30)}` : ''} at step ${clip(flow.step ?? '-', 60)}${flow.state === 'stopped' && flow.stopReason ? `, stop reason “${clip(flow.stopReason, 200)}”` : ''}, risk ${clip(flow.effectiveRisk ?? '-', 30)}.`, 3);
  // A flow notice older than its flow's current end (a stop, then a failure after reconciling): say which is current.
  const now = flow ? flow.outcome ?? flow.state : null;
  if (flow && isObject(item) && item.kind === 'notice' && item.flowId === flow.id && item.outcome && TERMINAL_FLOWS.includes(now) && now !== item.outcome)
    add(`This notice is older than the flow's current state: the notice says ${clip(item.outcome, 30)}, the flow now reads ${clip(now, 30)} at step ${clip(flow.step ?? '-', 60)}. A notice for the newer state may follow.`, 2);
  add(carriedBlock(carriedFromItem(item?.carriedQuestions) ?? sections?.carried, item?.id), 2);
  const failing = rule === 'flow-stopped' || (isObject(item) && item.kind === 'notice' && String(item.id).startsWith('flow-notice:') && item.outcome !== 'completed');
  if (failing || (Array.isArray(state?.attempts) && state.attempts.some(a => ['failed', 'uncertain'].includes(a?.status) && !a.settledAt))) add(attemptLines(state), 2);
  if (isMergeQuestion(item) && item.status === 'open') add(mergeFacts(item, flow), 3);
  if (sections?.main) add(`Context (data): “${clip(sections.main, BUDGET.context)}”${clip(sections.main, Infinity).length > BUDGET.context ? ` (context cut: ${BUDGET.context} of ${clip(sections.main, Infinity).length} characters shown; status --inbox ${item.id} has it all)` : ''}`, 4);
  for (const other of sections?.other ?? []) add(clip(other, BUDGET.section), 5);
  const absorbed = unreported(memory);
  // Forwards decided earlier and still not confirmed sent (other deliveries): the orchestrator can list them (dev.86, J7).
  // The number is a snapshot taken when this forward was decided (dev.87, K5): the listing is current.
  const unconfirmed = openSends(memory).filter(([, row]) => row.deliveryId !== p.deliveryId).length;
  // Escalation notices whose forward has since been confirmed or closed: the operator may dismiss them.
  add(mootLine(memory), 2);
  // A notice only the operator may acknowledge refuses delivery.ack from the orchestrator too (dev.87, K5).
  const ack = item?.operatorAckOnly === true ? 'Only the operator can acknowledge this notice and its delivery: do not run delivery.ack or inbox.ack for it (Factotum refuses both for the orchestrator).' : `After handling, run delivery.ack {"deliveryId":"${p.deliveryId}"}.`;
  parts.push({ text: `Triage did: ${state ? 'read canonical state' : 'read no canonical state'}; acknowledged nothing. ${ack} Absorbed since the last forward: ${absorbed} (log: ${logPath ? resolve(logPath) : 'not recorded'}).${unconfirmed ? ` Earlier forwards not yet confirmed sent when this was decided: ${unconfirmed} (the current list: triage.mjs --forwards --unconfirmed).` : ''}`, keep: true });
  return fit(parts, FORWARD_CHARS - reserve);
}

// Where forwards go: the orchestrator session Factotum has bound (orchestrator.session, declared
// with the orchestrator's own thread ID), so a handoff moves them with no edit here; else the
// bound session last seen (a run that read no state, a digest); else the thread configured with
// --forward-to (no session has been seen yet). forwardSource says which. The last-seen session
// comes before the configured thread (dev.86, J9): after a handoff the configured ID names the
// retired first thread, which no longer handles forwards.
export function forwardTarget(sessionId, memory = {}, configured = null) {
  if (isId(sessionId)) return { forwardTo: sessionId, forwardSource: 'session' };
  if (isId(memory?.mainThreadId)) return { forwardTo: memory.mainThreadId, forwardSource: 'last-seen' };
  if (isId(configured) && !isObject(memory?.bindingLost)) return { forwardTo: configured, forwardSource: 'configured' };
  return { forwardTo: null, forwardSource: null };
}

// The destination of a forward printed on an error path, from the state file on disk, read without
// the lock (it is only ever replaced whole, by rename, so a read sees one version): the newest bound
// session the proxy knows, else the configured thread when it has never seen one. If the state file
// exists but cannot be read, there is no destination: the error goes to stderr, and the delivery is
// left to the next run's retry and escalation (review of 615f5a5, P2-1: a lock timeout sent the error
// to the configured thread, retired since the binding moved).
// A state file reset since (bindingLost) has no binding history: no configured thread either.
export function knownTarget(memoryPath, configured = null) {
  if (!memoryPath || !existsSync(memoryPath)) return forwardTarget(null, {}, configured);
  let memory = null; try { memory = JSON.parse(readFileSync(memoryPath, 'utf8')); } catch { memory = null; }
  return isObject(memory) ? forwardTarget(null, memory, configured) : { forwardTo: null, forwardSource: null };
}
// ---- operator notices on failure (review of b693894) -------------------------------------------
// The rule: whenever the proxy cannot handle a delivery or a run (a run that fails, a delivery refused
// at the limit, a state file it cannot read or reset, a protocol mismatch), it publishes an operator
// notice itself, through Factotum's CLI (`inbox.publish`, then `status --inbox` to read it back). This
// path never touches the proxy's state file: the Inbox is the durable channel. The notice ID comes
// from the delivery ID (or, for a timer or digest run, the run and the UTC date and hour), so a
// repeated failure of the same delivery, or of one run kind in one hour, publishes it once; each other
// delivery that fails gets its own notice. The read-back must show a notice published by the orchestrator role with
// the expected title; an item under that ID that is not it makes the proxy publish under a new ID.
// If even that fails, the caller prints to stderr and exits nonzero: that is the floor.
// `--factory-state` names Factotum's state directory (the brief's TRIAGE passes it); the CLI is the
// installation's factory/cli.mjs, beside this script's project/integrations/ (or `--factory-cli`).
export const defaultFactoryCli = () => resolve(dirname(fileURLToPath(import.meta.url)), '../../factory/cli.mjs');
// Webhook-supplied IDs and associations are untrusted data: the notice names them as claims of the
// webhook payload, not as facts the proxy checked (re-check of 338c3dd, P3).
// What becomes of a delivery the proxy could not handle depends on its kind (dev.89 N2: the notice
// called every delivery "a notice delivery" with an item to look for, also a task.approved state
// event, which has no item). From Factotum's delivery rules (operations/notifications.mjs): a state
// event and a resolution are sent again until acknowledged (every 30 minutes by default); an
// attention delivery of a question is sent again while the question stays open and unacknowledged;
// one of a notice is delivered once. The payload does not say whether an item is a notice or a
// question, so an attention delivery names both. Every value shown is a plain ID or a known event.
export function deliveryKindText(p) {
  const event = typeof p.event === 'string' && isId(p.event) ? p.event : null, item = isRecordId(p.inboxId) ? p.inboxId : null, task = isRecordId(p.taskId) ? p.taskId : null;
  if (p.kind === 'state' && event) return `It is a state event (${event}${task ? ` for task ${task}` : ''}), not an Inbox item, so there is no item to look for. Factotum sends a state event again until it is acknowledged (every 30 minutes by default), so a later proxy run handles it. If it cannot wait, read the task${task ? ` (status --task ${task})` : ''} and act on it there, or tell the orchestrator.`;
  if (p.kind === 'inbox' && event === 'inbox.resolved') return `It is a resolution delivery: inbox item ${item ?? '(not named)'} was ${typeof p.status === 'string' && INBOX_STATUSES.includes(p.status) ? p.status : 'closed'}. Factotum sends a resolution again until it is acknowledged (every 30 minutes by default), so a later proxy run handles it; nothing is needed unless the orchestrator must hear of it sooner.`;
  if (p.kind === 'inbox' && item) return `It is an attention delivery for inbox item ${item}. If that item is a notice, Factotum delivers it once and does not send it again, so it may never reach the orchestrator; if it is a question, Factotum sends it again while it stays open and unacknowledged. Look for item ${item} in the Inbox and act on it there if it needs you, or tell the orchestrator.`;
  return 'Its kind is not one the proxy knows, so Factotum may not send it again: look for it in the Inbox or the project\'s state, and tell the orchestrator.';
}
export function failureNotice({ kind, payload = null, error, protocol = false, nowMs = Date.now() }) {
  const p = normalizePayload(payload) ?? {}, deliveryId = isRecordId(p.deliveryId) ? p.deliveryId : null, hour = new Date(nowMs).toISOString().slice(0, 13);
  // Times in an error message would make each failure's notice differ: the same failure must find its own notice.
  error = String(error ?? '').replace(/\d{4}-\d{2}-\d{2}T[\d:.-]+Z?/g, '<time>');
  const id = `triage-${protocol ? 'protocol' : 'failed'}-${deliveryId ? digestOf(deliveryId) : `${kind}-${hour.replace(/[^0-9T-]/g, '')}`}`;
  const claims = [deliveryId && `delivery ${deliveryId}`, isRecordId(p.inboxId) && `inbox item ${p.inboxId}${Number.isSafeInteger(p.version) ? ` (version ${p.version})` : ''}`, isRecordId(p.taskId) && `task ${p.taskId}`, isRecordId(p.flowId) && `flow ${p.flowId}`, typeof p.event === 'string' && isId(p.event) && `event ${p.event}`].filter(Boolean).join(', ');
  const title = plain(clip(deliveryId ? `Triage proxy could not handle a delivery (the webhook payload names ${deliveryId})` : `Triage proxy could not handle the ${kind === 'wake' ? 'webhook' : kind} run of ${hour}:00 UTC`, 240));
  const context = plain(keepNewlines([
    `The triage proxy could not ${deliveryId ? 'handle a delivery' : `complete its ${kind} run`}: ${clip(error, 600)}.`,
    deliveryId ? `The webhook payload names ${claims}. These are unverified claims from the webhook payload: the proxy could not check them against the project's state. The proxy did not forward or acknowledge the delivery. ${deliveryKindText(p)}` : 'Its checks and re-sends did not run. The next run tries again; if this keeps happening, check the proxy thread.',
    protocol ? 'The triage script and its brief are from different releases: copy the brief and the handling guide again from the release that has this script.' : `The proxy keeps nothing about this in its own state; this notice is the record. ${deliveryId ? 'A repeated failure of the same delivery does not publish another notice; each other delivery that fails gets its own.' : `Another failure of the ${kind} run in the same UTC hour does not publish another notice.`}`,
    'This notice is informational and stays until you dismiss it.'].join('\n\n'), 4000));
  return { kind: 'notice', id, title, context };
}
// The IDs the notice may take, in order (re-check of 338c3dd, P2-3): the first that is free or that
// already holds exactly this notice is used, so the same failure published again finds its own
// notice. Another item under all three is the floor: stderr and a nonzero exit.
export const NOTICE_ID_TRIES = 3;
const noticeIds = id => Array.from({ length: NOTICE_ID_TRIES }, (_, i) => (i ? `${id}-${i + 1}` : id));
// Exactly this notice: the ID, a notice published by the orchestrator role, the same title and the
// same context (re-check of 338c3dd, P2-2, as for escalation notices: noticeMatches).
const exactly = (item, payload) => isObject(item) && item.id === payload.id && item.kind === 'notice' && item.createdBy === 'orchestrator' && item.title === payload.title && item.context === payload.context;
export function publishOperatorNotice(notice, { factoryState, cli = defaultFactoryCli(), run = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 }) } = {}) {
  if (!factoryState) return { published: false, id: notice.id, error: 'no --factory-state was given, so the proxy cannot publish an operator notice' };
  const readBack = id => { const r = run([cli, 'status', '--state', factoryState, '--inbox', id]); try { return JSON.parse(r.stdout)?.item ?? null; } catch { return null; } };
  let publishError = null;
  for (const id of noticeIds(notice.id)) {
    const payload = { ...notice, id };
    const held = readBack(id);
    if (exactly(held, payload)) return { published: true, id, existing: true };
    if (held) continue; // another item, or another notice, holds this ID: the next one
    const r = run([cli, 'command', '--state', factoryState, '--actor', 'orchestrator', '--operation', 'inbox.publish', '--payload', JSON.stringify(payload)]);
    if (r.status !== 0) publishError = clip(`${r.stderr || r.stdout || r.error?.message || 'inbox.publish failed'}`, 300);
    const item = readBack(id);
    if (exactly(item, payload)) return { published: true, id };
    if (!item) return { published: false, id, error: publishError ?? 'the notice could not be read back' };
  }
  return { published: false, id: noticeIds(notice.id).at(-1), error: `other items hold ${noticeIds(notice.id).join(', ')}` };
}
// The proxy's own notices: escalation (triage-undelivered-) and error notices (triage-failed-,
// triage-protocol-, and the reset notice triage-reset-). At notifications.level "all" each produces a webhook; if that run fails too, an
// error notice about it would produce another, without end (re-check of 338c3dd, P2-1). A delivery
// whose item has one of these prefixes and was published by the orchestrator role (from the run's
// narrow read; by the prefix alone when the run read nothing) is absorbed instead: acknowledged, and
// logged, never the subject of another notice. It is never acknowledged: the payload's delivery and
// item IDs are unverified claims, and an acknowledgement could reach another item's delivery.
const OWN_NOTICE = /^triage-(undelivered|failed|protocol|reset)-/;
export function ownNoticeDelivery(payload, read = null) {
  const p = normalizePayload(payload) ?? {};
  if (!isRecordId(p.inboxId) || !OWN_NOTICE.test(p.inboxId) || !isRecordId(p.deliveryId)) return false;
  const item = isObject(read?.item) && read.item.id === p.inboxId ? read.item : null;
  return item ? item.createdBy === 'orchestrator' : true;
}
function reportFailure({ kind, input, error, protocol, factoryState, cli, statePath = null, logPath = null }) {
  let payload = null; try { payload = kind === 'wake' && input ? JSON.parse(input) : null; } catch { payload = null; }
  let read = null; try { read = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : null; } catch { read = null; }
  if (payload && ownNoticeDelivery(payload, read)) {
    const p = normalizePayload(payload), reason = `delivery of the proxy's own notice ${p.inboxId}: absorbed, so a failure cannot publish notices about notices (${clip(error, 200)})`;
    try { if (logPath) append(logPath, { at: new Date().toISOString(), decision: 'absorb', rule: 'own-error-notice', deliveryId: p.deliveryId, inboxId: p.inboxId, reason: clip(reason, 300) }); } catch { /* the log may be what failed */ }
    return { absorbed: { decision: 'absorb', rule: 'own-error-notice', reason, actions: [] } };
  }
  const notice = failureNotice({ kind, payload, error, protocol });
  const result = publishOperatorNotice(notice, { factoryState, ...(cli ? { cli } : {}) });
  if (!result.published) { process.stderr.write(`triage: could not publish the operator notice ${result.id}: ${result.error}\n`); process.exitCode = 1; }
  return { notice: { id: result.id, published: result.published, ...(result.published ? {} : { error: result.error }) } };
}
// A state reset is an operator notice too (dev.88 M4), one per reset: its ID comes from the set-aside
// file's name, which is unique to the reset. What the proxy remembered is gone, and only the
// operator can tell whether anything it was holding still needs someone.
export function resetNotice({ path, aside, error, proxyThreadId = null }) {
  const title = plain(clip('Triage proxy state was reset: its state file could not be read', 240));
  const context = plain(keepNewlines([
    `The triage proxy could not read its state file ${clip(path, 300)} (${clip(error, 200)}), set it aside as ${clip(aside, 400)} and started a fresh one.`,
    'What the proxy remembered is gone: forwards not yet confirmed sent (it no longer re-sends them), outages and their escalation notices (it no longer reports them moot), which deliveries it had already handled (a delivery may be forwarded again), and the absorbed deliveries the next forward was to report. Nothing was acknowledged. Its log is kept.',
    `${proxyThreadId ? `The proxy's identity (${clip(proxyThreadId, 120)}) was recovered from its log.` : 'The proxy\'s identity was not in its log: until the proxy runs --set-proxy-id again, its forwards say "identity not recorded".'} Until a run reads a binding, no forward goes to the thread the brief configures.`,
    'What to do: check the Inbox for open items that may not have reached the orchestrator, and ask the orchestrator to list the forwards the log shows as never confirmed (TRIAGE --forwards --unconfirmed) and handle them from state. If the file was damaged, fix the cause; the proxy keeps working with the fresh state.',
    'This notice is informational and stays until you dismiss it.'].join('\n\n'), 4000));
  return { kind: 'notice', id: `triage-reset-${digestOf(aside)}`, title, context };
}
// One notice for each reset this process made; the floor (stderr, exit 1) when one cannot be published.
function reportResets({ factoryState, cli }) {
  const out = [];
  for (const reset of stateResets.splice(0)) {
    let proxyThreadId = null; try { proxyThreadId = JSON.parse(readFileSync(reset.path, 'utf8'))?.proxyThreadId ?? null; } catch { proxyThreadId = null; }
    const result = publishOperatorNotice(resetNotice({ ...reset, proxyThreadId: isId(proxyThreadId) ? proxyThreadId : null }), { factoryState, ...(cli ? { cli } : {}) });
    if (!result.published) { process.stderr.write(`triage: could not publish the operator notice ${result.id} about the state reset: ${result.error}\n`); process.exitCode = 1; }
    out.push({ id: result.id, published: result.published, ...(result.published ? {} : { error: result.error }) });
  }
  return out;
}
// decide({payload, state, memory}, options) -> {decision, rule, reason, actions, forward, forwardTo, forwardSource, sendId, delaySeconds?}. Never throws.
export function decide({ payload, state = null, memory = {} } = {}, options = {}) {
  const opts = { projectId: null, absorbCleanCompletions: ABSORB_CLEAN_COMPLETIONS, logPath: null, reforwardEvery: REFORWARD_EVERY, recheckSeconds: RECHECK_SECONDS, forwardTo: null, reserve: 0, readError: null, ...options };
  const mem = isObject(memory) ? memory : {};
  try { return decideUnsafe({ payload, state: isObject(state) ? state : null, memory: mem }, opts); }
  catch (error) { return { decision: 'forward', rule: 'triage-error', reason: clip(error?.message, 200), actions: [], forward: `[Factotum via triage] Triage failed on a webhook payload (${clip(error?.message, 200)}). Nothing was acknowledged; handle it from the inbox.`, ...forwardTarget(null, mem, opts.forwardTo), sendId: null }; }
}
function decideUnsafe({ payload, state, memory }, { projectId, absorbCleanCompletions, logPath, reforwardEvery, recheckSeconds, forwardTo: configured, reserve, readError, boundNow }) {
  const p = normalizePayload(payload), bad = validatePayload(p, projectId);
  if (bad) return { decision: 'forward', rule: 'invalid-payload', reason: bad, actions: [], forward: forwardText({ p, rule: 'invalid-payload', reason: bad }), ...forwardTarget(null, memory, configured), sendId: null };
  const prior = isObject(memory.deliveries?.[p.deliveryId]) ? memory.deliveries[p.deliveryId] : null;
  const item = isObject(state?.item) && state.item.id === p.inboxId ? state.item : null;
  // boundNow: the newest bound session known (runRecorded's observeSession), so a read older than one already seen never redirects a forward.
  const target = forwardTarget(boundNow !== undefined ? boundNow : state?.project?.session?.sessionId, memory, configured);
  // A delivery read once already and re-checked: decide finally, never re-check twice.
  const rechecked = prior?.decision === 'recheck' ? { at: prior.at, delaySeconds: prior.delaySeconds } : null;
  const absorb = (rule, reason, actions = [{ operation: 'delivery.ack', payload: { deliveryId: p.deliveryId } }]) => ({ decision: 'absorb', rule, reason, actions, forward: null, forwardTo: null, forwardSource: null, sendId: null });
  const send = (decision, rule, reason) => ({ decision, rule, reason, actions: [], forward: forwardText({ p, rule, reason, state, item, memory, logPath, prior: ['reminder', 'resend'].includes(rule) ? prior : null, rechecked, reserve }), ...target, sendId: p.deliveryId });
  const forward = (rule, reason) => send('forward', rule, reason);
  const recheck = (rule, reason) => ({ decision: 'recheck', rule, reason, actions: [], forward: null, forwardTo: null, forwardSource: null, sendId: null, delaySeconds: recheckSeconds });
  const forwarded = prior?.decision === 'forward' && prior.sent === true;

  // The presenter must take its prompt down: always forward, before anything else.
  if (p.presentationEnded) return forward('presentation-ended', 'A prompt presentation ended');

  if (p.kind === 'state') {
    // No item to check: a re-send of a forwarded state delivery is forwarded again (no ack proposed).
    if (forwarded) return forward('resend', `State event ${p.event} for task ${p.taskId} re-sent; not yet acknowledged`);
    if (p.event === 'task.approved') {
      const task = state?.task, queued = ['queued', 'claimed'].includes(state?.queue?.status);
      if (isObject(task) && task.id === p.taskId && task.approved === true && p.taskRevision !== undefined && String(task.approvedRevision) === String(p.taskRevision) && queued)
        return absorb('approval-queued', `Task ${p.taskId} approved and already ${state.queue.status}`);
      return forward('approval', `Task ${p.taskId} approved, not queued or running`);
    }
    if (['task.revoked', 'task.approval-revoked'].includes(p.event)) {
      // A revocation is often followed at once by a re-approval (an edit, then approval again).
      if (!rechecked) return recheck('approval-may-return', `Task ${p.taskId} approval revoked; read again in case it is restored`);
      const task = state?.task;
      if (isObject(task) && task.id === p.taskId && task.approved === true && task.approvedRevision !== undefined && String(task.approvedRevision) === String(task.revision))
        return absorb('approval-restored', `Task ${p.taskId} approval revoked and restored at its current revision`);
      return forward('approval-revoked', `Task ${p.taskId} approval revoked`);
    }
    if (p.event === 'flow.stopped') return forward('flow-stopped', `Flow ${p.flowId ?? '(none)'} stopped`);
    // Known events that no rule covers (they arrive only at notifications.level "all").
    return send('unsure', 'state-event-no-rule', `State event ${p.event} has no rule`);
  }

  // Inbox. The narrow read decides whether the item is still open; without it, forward.
  const readable = isObject(item) && Number.isSafeInteger(item.version) && typeof item.status === 'string';
  const open = readable && item.status === 'open';
  if (p.event === 'inbox.resolved') {
    // A re-send of a forwarded resolution: the item is closed (the payload and, when read, state say so).
    if (forwarded && !open) {
      const resends = (prior.resends ?? 0) + 1;
      if (resends % reforwardEvery === 0) return forward('resend', `Resolution of ${p.inboxId} (${p.resolution}) still not acknowledged`);
      return { ...absorb('resend-closed', `Re-send ${resends} of a forwarded resolution of ${p.inboxId}; the orchestrator's acknowledgement ends them`, []), resends };
    }
    if (open) return forward('state-disagrees', `Resolution of ${p.inboxId} arrived but the item reads as open`);
    if (p.resolution === 'superseded') return absorb('superseded-resolution', `Item ${p.inboxId} was superseded`);
    if (p.actor === 'orchestrator') return absorb('own-resolution', `Item ${p.inboxId} ${p.resolution} by the orchestrator role`);
    // Only notices become acknowledged; the operator dismissed one in the console.
    if (p.resolution === 'acknowledged' && p.actor === 'operator') return absorb('operator-acknowledged-notice', `Notice ${p.inboxId} acknowledged by the operator`);
    // The orchestrator's first news of a question may be its answer: name what it was about.
    const about = readable ? `: ${subjectOf(item, state)}` : ` ${p.inboxId}`;
    if (p.resolution === 'answered') return forward('answered', `Question answered${p.actor ? ` by ${p.actor}` : ''}${about}`);
    if (p.resolution === 'expired') return forward('expired', `Question expired${about}`);
    return forward('withdrawn', `Item withdrawn${p.actor ? ` by ${p.actor}` : ''}${about}`);
  }
  // inbox.attention
  if (!state) return forward('no-state', `No canonical state was read for ${p.inboxId}${readError ? ` (the narrow read failed: ${clip(readError, 200)})` : ''}`);
  if (!readable) return forward('item-missing', `Item ${p.inboxId} not found in canonical state`);
  if (item.version > p.version || !open) return absorb('stale-version', `Item ${p.inboxId} has moved on (now v${item.version}, ${item.status}); its newer delivery decides`);
  if (item.version < p.version) return forward('state-disagrees', `Item ${p.inboxId} reads as v${item.version}, older than the payload's v${p.version}`);
  // Open at this version. A re-send of something already forwarded is a reminder: forward it again.
  if (forwarded) return forward('reminder', `Reminder: ${subjectOf(item, state)} is still open`);
  if (item.kind === 'question') {
    if (item.orchestratorHandoff === true) return forward('handoff', 'Handoff to a fresh orchestrator session requested');
    return item.role === 'operator' ? forward('operator-question', `${isMergeQuestion(item) ? 'Merge decision' : 'Operator question'} open: ${subjectOf(item, state)}`)
      : forward('orchestrator-question', `${isMergeQuestion(item) ? 'Merge decision' : 'Orchestrator question'} open: ${subjectOf(item, state)}`);
  }
  if (item.kind === 'notice') {
    // A flow notice read while its flow still runs or cleans up (or an attempt is in flight) is a
    // race with in-flight work: read again before deciding.
    const flow = isObject(state.flow) && state.flow.id === item.flowId ? state.flow : null;
    const active = flow && (!TERMINAL_FLOWS.includes(flow.state) || (Array.isArray(state.attempts) && state.attempts.some(a => IN_FLIGHT_ATTEMPTS.includes(a?.status))));
    if (active && String(item.id).startsWith('flow-notice:')) {
      if (!rechecked) return recheck('flow-still-active', `Flow ${flow.id} still reads as ${flow.state}; read again before deciding`);
      return forward('flow-still-active', `Flow notice ${subjectOf(item, state)} for flow ${flow.id}, which still reads as ${flow.state}`);
    }
    if (absorbCleanCompletions && cleanCompletion(item, state))
      return absorb('clean-completion', `Clean completion: ${clip(item.title, 120)}`, [{ operation: 'delivery.ack', payload: { deliveryId: p.deliveryId } }, { operation: 'inbox.ack', payload: { inboxId: item.id } }]);
    if (item.role === 'operator') return forward('operator-notice', `Operator notice: ${subjectOf(item, state)}`);
    if (String(item.id).startsWith('flow-notice:')) return forward('flow-notice', `Flow notice: ${subjectOf(item, state)}`);
    return forward('notice', `Notice: ${subjectOf(item, state)}`);
  }
  return forward('unknown-item-kind', `Item kind ${clip(item.kind, 40)} has no rule`);
}

// Timer check over `status --compact`. Forwards what webhooks do not report: every hold and
// health condition the compact view exposes, each fault by identity, a running flow unchanged at
// the same step and attempt for longer than the stall limit, a main verification in progress for
// that long, and approved queued work that has had no running or ready flow for the idle limit.
// The first run reports whatever is already wrong. Flow ends and questions arrive by webhook.
// Returns `timer`: the baseline to commit once the forward is confirmed (or at once, on absorb),
// and `findings`: what this forward reports, kept with it until --sent confirms it.
const digestOf = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
// "main verification in progress (job …)" is core's own wording (operations/main-health-reason.mjs)
// for a main hold that a queued or running main.verify job is expected to clear.
const VERIFYING = /verification in progress \(job [^)]+\)/;
export function healthConditions(compact) {
  const conditions = {}, verifying = [];
  const add = (key, text) => { conditions[key] = clip(text, 300); };
  if (compact.paused === true) add('paused', 'Admission is paused');
  if (compact.recoveryHold === true) add(`recovery-hold:${compact.recoveryHoldReason?.cause ?? 'unknown'}`, `Recovery hold: ${compact.recoveryHoldReason?.cause ?? 'cause not recorded'}${compact.recoveryHoldReason?.error ? ` (${compact.recoveryHoldReason.error})` : ''}`);
  const fault = compact.health?.operationsFault;
  if (fault) add(`operations-fault:${digestOf(`${fault.since ?? ''}|${fault.error ?? JSON.stringify(fault)}`)}`, `Operations fault since ${fault.since ?? 'unknown'}: ${fault.error ?? 'no message'}`);
  const notifications = compact.health?.notifications;
  if (notifications && notifications.status !== 'ok') add(`notifications:${notifications.status}:${digestOf(notifications.problem ?? '')}`, `Notification delivery ${notifications.status}: ${notifications.problem ?? 'no problem recorded'}`);
  if (compact.commissioningRequired === true) add('commissioning-required', 'Commissioning (doctor) is required for the current configuration');
  const main = compact.mainHealth?.status;
  if (main && !['green', 'unknown'].includes(main)) add(`main-health:${main}`, `Main health is ${main}${compact.mainHealth?.head ? ` at ${String(compact.mainHealth.head).slice(0, 12)}` : ''}`);
  if (compact.spending?.globalHold === true) add('spending-hold', `Spending hold${compact.spending.reason ? `: ${compact.spending.reason}` : ''}`);
  for (const provider of Array.isArray(compact.providerLimits?.held) ? compact.providerLimits.held : []) add(`provider-hold:${provider}`, `Provider usage hold: ${provider}`);
  for (const hold of Array.isArray(compact.queueStatus?.holds) ? compact.queueStatus.holds : []) {
    if (!isObject(hold)) continue;
    // A merge hold is listed only while the merge is making progress (operations/merge-hold.mjs mergesInFlight).
    if (hold.kind === 'merge') continue;
    // A main hold that a verification in progress will clear is a wait, reported only if it lasts.
    if (hold.kind === 'main' && VERIFYING.test(String(hold.text ?? ''))) { verifying.push(String(hold.target ?? 'main')); continue; }
    add(`queue-hold:${hold.kind}:${hold.target ?? hold.flowId ?? ''}:${hold.kind === 'launch-stalled' ? hold.attemptId ?? '' : ''}`, `Queue hold (${hold.kind}${hold.target ? `, ${hold.target}` : ''}): ${hold.text ?? ''}`);
  }
  return { conditions, verifying };
}
// Something that has to last before it is reported: tracked with its start, reported once.
function lasting(prior, key, position, nowMs, limitMinutes) {
  const row = isObject(prior?.[key]) ? prior[key] : null;
  const since = row?.position === position && isTime(row.since) ? row.since : new Date(nowMs).toISOString();
  const reported = row?.position === position && row.reported === true;
  const due = nowMs - Date.parse(since) >= limitMinutes * 60000;
  return { since, report: due && !reported, row: { position, since, reported: reported || due } };
}
export function timerCheck(compact, memory = {}, { nowMs = Date.now(), stallMinutes = STALL_MINUTES, idleMinutes = IDLE_MINUTES, forwardTo: configured = null } = {}) {
  const at = new Date(nowMs).toISOString();
  const target = forwardTarget(isObject(compact) ? compact.orchestratorSession?.sessionId : null, memory, configured);
  // Findings an earlier forward carried that --sent has not confirmed: never dropped.
  const carried = Object.values(isObject(memory?.pending) ? memory.pending : {}).filter(row => isObject(row) && row.kind === 'timer' && Array.isArray(row.findings)).flatMap(row => row.findings.map(f => ({ ...f, at: f.at ?? row.at })));
  const unreadable = reason => {
    const findings = [{ key: `unreadable:${at}`, type: 'unreadable', text: `Timer check could not read project state (${reason})`, at }, ...carried];
    return { decision: 'forward', rule: 'timer-unreadable', reason, forward: [`[Factotum via triage] Timer check could not read project state (${reason}). Nothing was compared or recorded; check the service and status --compact.`, ...carried.map(f => `Earlier, not yet delivered (${f.at}): ${f.text}`)].join('\n'), ...target, sendId: `timer:${at}`, timer: null, findings };
  };
  try {
    if (!isObject(compact)) return unreadable('not a JSON object');
    if (compact.snapshotView !== 'dashboard-v1' || !isRecordId(compact.projectId)) return unreadable('not a status --compact view');
    if (!Array.isArray(compact.flows)) return unreadable('flows is not a list');
    const base = isObject(memory?.timer) ? memory.timer : null;
    const { conditions, verifying } = healthConditions(compact), before = isObject(base?.conditions) ? base.conditions : {};
    const findings = [
      ...Object.entries(conditions).filter(([key]) => !(key in before)).map(([key, text]) => ({ key: `raised:${key}`, type: 'raised', text })),
      ...Object.entries(before).filter(([key]) => !(key in conditions)).map(([key, text]) => ({ key: `cleared:${key}`, type: 'cleared', text })),
    ];
    // Waits that become findings only when they last: stalled flows, slow verifications, idle queue.
    const waits = {}, prior = isObject(base?.waits) ? base.waits : (isObject(base?.flows) ? Object.fromEntries(Object.entries(base.flows).map(([k, v]) => [`flow:${k}`, v])) : {});
    for (const flow of compact.flows) {
      if (!isObject(flow) || !['running', 'ready'].includes(flow.state) || !isRecordId(flow.id)) continue;
      const w = lasting(prior, `flow:${flow.id}`, `${flow.state}:${flow.step}:${flow.attemptId ?? ''}`, nowMs, stallMinutes); waits[`flow:${flow.id}`] = w.row;
      if (w.report) findings.push({ key: `stalled:flow:${flow.id}:${w.row.position}`, type: 'stalled', text: `flow ${flow.id} (task ${clip(flow.taskId, 80)}) ${flow.state} at step ${clip(flow.step, 60)}, attempt ${clip(flow.attemptId ?? 'none', 80)}, unchanged since ${w.since}` });
    }
    for (const name of verifying) {
      const w = lasting(prior, `verifying:${name}`, 'verifying', nowMs, stallMinutes); waits[`verifying:${name}`] = w.row;
      if (w.report) findings.push({ key: `stalled:verifying:${name}`, type: 'stalled', text: `a main verification for ${name} has been in progress since ${w.since}, and work for ${name} waits on it` });
    }
    // Approved queued work and nothing running: for example a stopped flow holding the only slot.
    // Factotum's own idle notice needs a free slot and automatic queueing, so it does not see that.
    // Each open flow is named with what it does about a flow slot: a stopped flow holds one; a flow
    // parked on an answer holds none (unless it is beyond policy.maxParkedFlows); an answered flow
    // waits for one; any other waiting flow (a timer, a target or provider wait) holds one.
    const queued = (Array.isArray(compact.queueTasks) ? compact.queueTasks : []).filter(task => isObject(task) && task.approved === true && isRecordId(task.id));
    const running = compact.flows.some(flow => isObject(flow) && ['running', 'ready'].includes(flow.state));
    if (queued.length && !running && !Object.keys(conditions).length) {
      const w = lasting(prior, 'idle', 'idle', nowMs, idleMinutes); waits.idle = w.row;
      const capacity = isObject(compact.queueStatus) && isObject(compact.queueStatus.capacity) ? compact.queueStatus.capacity : {};
      const beyond = new Set((Array.isArray(capacity.parked) ? capacity.parked : []).filter(row => isObject(row) && row.holdsSlot === true).map(row => row.flowId));
      const slot = flow => flow.state === 'stopped' ? 'holds a slot' : flow.parked === true ? (beyond.has(flow.id) ? 'parked on an answer beyond the parked limit, holds a slot' : 'parked on an answer, holds no slot') : isObject(flow.slotWait) ? 'answered, waiting for a slot' : 'holds a slot';
      const holding = compact.flows.filter(flow => isObject(flow) && ['waiting', 'stopped'].includes(flow.state)).map(flow => `${flow.id} ${flow.state}${flow.stopReason ? ` (${clip(flow.stopReason, 80)})` : ''}, ${slot(flow)}`);
      if (w.report) findings.push({ key: `stalled:idle:${w.since}`, type: 'stalled', text: `${queued.length} approved queued task(s) (${queued.slice(0, 5).map(t => t.id).join(', ')}) and no running or ready flow since ${w.since}${holding.length ? `; open flows: ${holding.slice(0, 5).join(', ')}` : ''}` });
    }
    const next = { at, conditions, waits };
    // Earlier unconfirmed findings this run does not report again: still delivered, with what happened since.
    const current = new Set(findings.map(f => f.key)), rest = carried.filter(f => !current.has(f.key));
    const later = rest.map(f => ({ ...f, text: f.type === 'raised' && !(f.key.slice('raised:'.length) in conditions) ? `${f.text} (raised at ${f.at}, cleared again before delivery)` : f.type === 'cleared' && f.key.slice('cleared:'.length) in conditions ? `${f.text} (cleared at ${f.at}, raised again before delivery)` : `${f.text} (found at ${f.at})` }));
    const all = [...findings.map(f => ({ ...f, at })), ...later];
    if (!all.length) return { decision: 'absorb', rule: 'timer-no-change', reason: base ? 'No change that webhooks do not report' : 'First run: nothing wrong', forward: null, forwardTo: null, forwardSource: null, sendId: null, timer: next, findings: [] };
    const label = { raised: 'Raised', cleared: 'Cleared', stalled: 'Stalled', unreadable: 'Unreadable' };
    const counts = ['raised', 'cleared', 'stalled'].map(type => [type, all.filter(f => f.type === type).length]).filter(([, n]) => n).map(([type, n]) => `${n} ${type}`).join(', ');
    const text = [`[Factotum via triage] Timer check${base ? '' : ' (first run)'}: ${counts || 'earlier findings'}`, `project ${compact.projectId}`,
      ...findings.map(f => `${label[f.type]}: ${f.text}`), ...later.map(f => `Earlier, not yet delivered — ${label[f.type] ?? f.type}: ${f.text}`),
      'Asked of you: read the project state (status --compact, or the flow) and tell the operator if they must act. Triage acknowledged nothing.'].join('\n');
    return { decision: 'forward', rule: all.some(f => f.type === 'stalled') ? 'timer-stall' : 'timer-change', reason: clip(all.map(f => f.key).join('; '), 300), forward: text, ...target, sendId: `timer:${at}`, timer: next, findings: all };
  } catch (error) { return unreadable(clip(error?.message, 200)); }
}

// Counts from the log. forwarded: messages confirmed as received by the orchestrator thread
// (deliveries, timer findings, digests); unconfirmed: forwards decided and never confirmed sent,
// as --forwards --unconfirmed lists them; absorbed: deliveries absorbed by a rule or by the
// proxy's judgement; unsure: deliveries no rule covered; byRule: delivery decisions per rule,
// whether or not a forward among them was sent (dev.86: forwarded counts sends, byRule counts
// decisions); missed: absorbed items the orchestrator needed (the measure of a rule that absorbs
// too much); undelivered: forwards the orchestrator found were never delivered; lookups: things a
// forward should have carried and the orchestrator had to read (the measure of a forward that says
// too little); sendFailures and escalations: failed sends the proxy recorded, and operator notices
// it published about an undelivered forward; obsolete and handled: unconfirmed forwards closed
// without a send, because their item was no longer open or the orchestrator recorded handling them
// from state (dev.87, K1).
// --since: an ISO time, compared as an instant (so "…T22:30:00+01:00" and "…T21:30:00Z" are the
// same cutoff). Anything else is refused rather than read as "nothing since".
export function parseSince(since) {
  if (since === null || since === undefined) return null;
  const ms = typeof since === 'string' && /^\d{4}-\d{2}-\d{2}(T|$)/.test(since) ? Date.parse(since) : NaN;
  if (!Number.isFinite(ms)) throw new Error(`--since must be an ISO time such as 2026-11-15T21:30:00Z, not ${JSON.stringify(clip(since, 60))}`);
  return ms;
}
const before = (e, sinceMs) => sinceMs !== null && !(Date.parse(e.at) >= sinceMs);
export function counts(entries, since = null) {
  const out = { forwarded: 0, unconfirmed: unconfirmedForwards(entries, since).length, absorbed: 0, unsure: 0, rechecks: 0, missed: 0, undelivered: 0, received: 0, lookups: 0, sendFailures: 0, escalations: 0, obsolete: 0, handled: 0, timerRuns: 0, byRule: {} }, sinceMs = parseSince(since);
  for (const e of entries) {
    if (!isObject(e) || before(e, sinceMs)) continue;
    if (e.decision === 'missed') { if (e.kind === 'lookup') out.lookups++; else if (e.kind === 'undelivered') out.undelivered++; else if (e.kind === 'received') out.received++; else out.missed++; }
    else if (e.decision === 'sent') out.forwarded++;
    else if (e.decision === 'send-failed') out.sendFailures++;
    else if (e.decision === 'escalated' && !e.note) out.escalations++;
    else if (e.decision === 'obsolete') out.obsolete++;
    else if (e.decision === 'handled') out.handled++;
    else if (RETRY_LINES.includes(e.decision)) continue;
    else if (e.decision === 'recheck') out.rechecks++;
    else if (String(e.rule).startsWith('timer-')) out.timerRuns++;
    else if (e.rule === 'digest' || ['state-reset', 'correction', 'proxy-id'].includes(e.decision)) continue;
    else {
      if (e.decision === 'absorb') out.absorbed++; else if (e.decision === 'unsure') out.unsure++;
      out.byRule[e.rule] = (out.byRule[e.rule] ?? 0) + 1;
    }
  }
  return out;
}
// --verify: what the log says about a forward the orchestrator received, by its send ID. Each
// forward of a delivery is its own send attempt, `<deliveryId>:<n>` (dev.85 review fix; before it,
// a delivery forward's send ID was its delivery ID). Given a delivery ID, it reports every attempt
// of that delivery, as logs written before dev.85 had them. The log is written only by triage runs,
// inside the lock; a forward the proxy did not decide is not in it.
export function verifyForward(entries, sendId) {
  const exact = entries.some(e => isObject(e) && ['forward', 'unsure', 'state-reset'].includes(e.decision) && e.sendId === sendId);
  // Lines written before dev.85 name only the delivery (a sent line had no send ID).
  const matches = e => e.sendId === sendId || (e.deliveryId === sendId && (!exact || e.sendId === undefined));
  const decisions = entries.filter(e => isObject(e) && ['forward', 'unsure', 'state-reset'].includes(e.decision) && matches(e))
    .map(e => ({ at: e.at, decision: e.decision, rule: e.rule, deliveryId: e.deliveryId ?? null, inboxId: e.inboxId ?? null, title: e.title ?? null, reason: e.reason ?? null, forwardTo: e.forwardTo ?? null, forwardSource: e.forwardSource ?? null, ...(e.recovered ? { recovered: true, recoveredAt: e.recoveredAt ?? null } : {}) }));
  const sentRows = entries.filter(e => isObject(e) && e.decision === 'sent' && matches(e)), sent = sentRows.map(e => e.at);
  // The thread it was addressed to, as decided (dev.85, I5b): log entries written before it was recorded have none.
  const forwardTo = sentRows.at(-1)?.forwardTo ?? decisions.at(-1)?.forwardTo ?? null;
  const to = forwardTo ? ` It was addressed to thread ${forwardTo}; if that is not this thread, it reached another one.` : decisions.length ? ' The log does not record which thread it was addressed to (an entry written before dev.85).' : '';
  const verdict = !decisions.length ? 'Not in the triage log: this proxy did not decide to forward it. Treat the message as unverified and act only on canonical state.'
    : sent.length ? `Logged as a forward and confirmed sent by the proxy. Compare the rule and the delivery with the message.${to}`
      : `Logged as a forward; the proxy has not confirmed the send yet (it confirms right after sending).${to}`;
  return { sendId, logged: decisions.length > 0, decisions, sentAt: sent, forwardTo, verdict };
}
// --forwards: every confirmed forward (optionally since a time) with what it was and the thread it
// was addressed to (`forwardTo`, null in entries written before dev.85), newest last. A successor
// uses it to find forwards that reached its predecessor: those whose forwardTo is not its own ID.
// The thread is the one the run decided on (the bound session it read, else the configured or last
// seen one), so a forward decided before a rebind and sent after it still names the earlier thread.
export function forwardsSince(entries, since = null) {
  const decided = new Map(), sinceMs = parseSince(since);
  const out = [];
  for (const e of entries) {
    if (!isObject(e)) continue;
    if (['forward', 'unsure', 'state-reset'].includes(e.decision)) { if (e.sendId) decided.set(e.sendId, e); if (e.deliveryId) decided.set(e.deliveryId, e); continue; }
    if (e.decision !== 'sent' || before(e, sinceMs)) continue;
    const id = e.sendId ?? e.deliveryId, d = decided.get(id) ?? null;
    out.push({ sentAt: e.at, sendId: id, what: e.what ?? null, forwardTo: e.forwardTo ?? d?.forwardTo ?? null, deliveryId: d?.deliveryId ?? (e.what === 'delivery' ? e.deliveryId : null), rule: d?.rule ?? null, inboxId: d?.inboxId ?? null, taskId: d?.taskId ?? null, title: d?.title ?? null });
  }
  return out;
}
// Log lines about re-sending an unconfirmed forward (dev.86, J7); none is a decision of its own.
// `obsolete` and `handled` close a forward without a send (dev.87, K1).
// `delivered`: another send of the same delivery was confirmed; `escalation-covered`: a notice already published covers it (dev.88).
const RETRY_LINES = ['retry', 'send-failed', 'escalated', 'escalation-covered', 'escalation-retry', 'retry-expired', 'obsolete', 'handled', 'delivered'];
// --forwards --unconfirmed: forwards decided and never confirmed sent, oldest first. Per delivery
// only its newest attempt counts (an earlier attempt is covered by it, and a delivery is not listed
// once any later attempt was confirmed or it was absorbed since); of timer findings and digests only
// the newest of each, since each run's forward carries or replaces the earlier ones. Each row says
// how often it was re-sent, how many sends failed, the last error, whether the operator was told
// (escalatedAt) and whether re-sending stopped (expiredAt). --since compares the decision time.
// Each row also says where its latest send went (`addressedTo`: the last retry's thread, else the
// thread it was decided for), when (`lastTriedAt`), and whether that send may still be in progress
// (`inProgress`: under RETRY_GRACE_SECONDS ago, so not yet confirmable). `forThread` (--for) lists
// only the forwards addressed to that thread (dev.88, L3): the orchestrator handles from state only
// forwards meant for it, never one decided for another session or still being sent.
const noteRow = () => ({ retries: 0, failures: 0, lastError: null, lastTriedTo: null, lastTriedAt: null, escalatedAt: null, expiredAt: null, closedAt: null, handedTo: [] });
export function unconfirmedForwards(entries, since = null, { forThread = null, nowMs = Date.now() } = {}) {
  const sinceMs = parseSince(since), sent = new Set(), decided = new Map(), notes = new Map(), absorbedAt = new Map(), latest = new Map();
  entries.forEach((e, i) => {
    if (!isObject(e)) return;
    if (e.decision === 'sent') { if (e.sendId) sent.add(e.sendId); if (e.deliveryId && !e.sendId) sent.add(`delivery:${e.deliveryId}`); return; }
    // A published notice's line names every forward it covers.
    if (e.decision === 'escalated' && !e.note && Array.isArray(e.covers)) for (const id of e.covers) if (id !== e.sendId) { const n = notes.get(id) ?? noteRow(); n.escalatedAt = e.at; notes.set(id, n); }
    if (RETRY_LINES.includes(e.decision) && e.sendId) {
      const n = notes.get(e.sendId) ?? noteRow();
      if (e.decision === 'retry') { n.retries++; n.lastTriedTo = e.forwardTo ?? n.lastTriedTo; n.lastTriedAt = e.at; if (e.forwardTo) n.handedTo.push(e.forwardTo); }
      if (e.decision === 'escalation-covered') n.escalatedAt = e.at;
      if (e.decision === 'send-failed') { n.failures++; n.lastError = e.error ?? n.lastError; }
      if (e.decision === 'escalated' && !e.note) n.escalatedAt = e.at;
      if (e.decision === 'retry-expired') n.expiredAt = e.at;
      if (['obsolete', 'handled', 'delivered'].includes(e.decision)) n.closedAt = e.at;
      notes.set(e.sendId, n); return;
    }
    if (e.decision === 'absorb' && e.deliveryId) { absorbedAt.set(e.deliveryId, i); return; }
    if (!['forward', 'unsure', 'state-reset'].includes(e.decision) || !e.sendId) return;
    // A reset line and the decision it replaced share a send ID: merge them, the decision's fields first.
    const prior = decided.get(e.sendId)?.e ?? {};
    decided.set(e.sendId, { i, e: e.decision === 'state-reset' ? { ...e, ...prior } : { ...prior, ...e } });
  });
  for (const [sendId, { e }] of [...decided].sort((a, b) => a[1].i - b[1].i))
    latest.set(sendId.startsWith('timer:') ? 'timer' : sendId.startsWith('digest:') ? 'digest' : e.deliveryId ? `delivery:${e.deliveryId}` : `notice:${sendId}`, sendId);
  const out = [];
  for (const [group, sendId] of latest) {
    const { i, e } = decided.get(sendId);
    if (sent.has(sendId) || (e.deliveryId && sendId === e.deliveryId && sent.has(`delivery:${e.deliveryId}`))) continue;
    if (group.startsWith('delivery:') && (absorbedAt.get(e.deliveryId) ?? -1) > i) continue;
    if (sinceMs !== null && !(Date.parse(e.at) >= sinceMs)) continue;
    const n = notes.get(sendId) ?? {};
    if (n.closedAt) continue;
    const addressedTo = n.lastTriedTo ?? e.forwardTo ?? null, lastTriedAt = n.lastTriedAt ?? e.at;
    if (forThread !== null && addressedTo !== forThread) continue;
    out.push({ decidedAt: e.at, sendId, deliveryId: e.deliveryId ?? null, rule: e.rule ?? null, inboxId: e.inboxId ?? null, taskId: e.taskId ?? null, title: e.title ?? null,
      forwardTo: e.forwardTo ?? null, forwardSource: e.forwardSource ?? null, lastTriedTo: n.lastTriedTo ?? null, retries: n.retries ?? 0, failures: n.failures ?? 0, lastError: n.lastError ?? null, escalatedAt: n.escalatedAt ?? null, expiredAt: n.expiredAt ?? null,
      addressedTo, handedTo: [...new Set([e.forwardTo, ...(n.handedTo ?? [])].filter(Boolean))], lastTriedAt, inProgress: nowMs - Date.parse(lastTriedAt) < RETRY_GRACE_SECONDS * 1000 });
  }
  return out.sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));
}
// --missed --kind undelivered|received --ref <sendId> --for <this thread>: the orchestrator closes a
// forward it handled from state (undelivered) or found in its own thread unconfirmed (received).
// Both close the forward (`handled`), so the check is the script's, not only the guide's (dev.88,
// L3): the forward must be unconfirmed, addressed to this thread, and not sent in the last
// RETRY_GRACE_SECONDS (its send may be in progress). A forward recorded as received must have been
// handed out for this thread by some send (its decision or a retry): it cannot have reached a thread
// it was never sent to (review P2-5: any --for closed a forward addressed to the bound session).
export function missedRefCheck(entries, { kind, ref, forThread, nowMs = Date.now() }) {
  if (!HANDLED_KINDS.includes(kind) || ref === null || ref === undefined) return null;
  if (!isId(forThread)) throw new Error(`--kind ${kind} with --ref needs --for <this thread's ID>: it closes the forward, so it says which thread handled it`);
  const row = unconfirmedForwards(entries, null, { nowMs }).find(r => r.sendId === ref || r.deliveryId === ref);
  if (!row) throw new Error(`${ref} is not an unconfirmed forward (confirmed, closed or unknown; see --verify ${ref}): nothing to record`);
  if (row.inProgress) throw new Error(`forward ${row.sendId} was sent to ${row.addressedTo ?? 'a thread'} at ${row.lastTriedAt}, under ${RETRY_GRACE_SECONDS} s ago: its send may be in progress. Check again in two minutes`);
  if (kind === 'undelivered' && row.addressedTo !== forThread) throw new Error(`forward ${row.sendId} is addressed to ${row.addressedTo ?? 'no thread'}, not ${forThread}: leave it to the proxy, which sends it to the bound session and tells the operator if it stays undelivered`);
  if (kind === 'received' && !row.handedTo.includes(forThread)) throw new Error(`forward ${row.sendId} was never sent to ${forThread} (only to ${row.handedTo.join(', ') || 'no thread'}), so it cannot have reached it: leave it to the proxy`);
  return row;
}
// --absorbed: every delivery absorbed (optionally since a time), with its rule and item, oldest
// first: what moved the session count without a forward, for example while the orchestrator was away.
export function absorbedSince(entries, since = null) {
  const sinceMs = parseSince(since);
  return entries.filter(e => isObject(e) && e.decision === 'absorb' && e.deliveryId && !before(e, sinceMs))
    .map(e => ({ at: e.at, rule: e.rule ?? null, deliveryId: e.deliveryId, inboxId: e.inboxId ?? null, version: e.version ?? null, taskId: e.taskId ?? null, flowId: e.flowId ?? null, title: e.title ?? null, reason: e.reason ?? null }));
}
// entries: the log lines the digest covers; since: when the last digest was confirmed, for the heading.
export function digestText(entries, since = null, logPath = null) {
  const absorbed = entries.filter(e => isObject(e) && e.decision === 'absorb' && e.deliveryId);
  if (!absorbed.length) return null;
  const c = counts(entries), list = absorbed.slice(-20).map(e => `- ${e.at} ${e.rule}: ${[e.inboxId && `inbox ${e.inboxId} v${e.version}`, e.taskId && `task ${e.taskId}`, e.flowId && `flow ${e.flowId}`].filter(Boolean).join(', ')}${e.title ? ` “${e.title}”` : ''}`);
  return [`[Factotum via triage] Digest since ${since ?? 'the start'}: absorbed ${c.absorbed}, forwarded ${c.forwarded}, unsure ${c.unsure}, missed ${c.missed}, lookups ${c.lookups}.`,
    `By rule: ${Object.entries(c.byRule).map(([rule, n]) => `${rule} ${n}`).join(', ')}.`, ...list,
    absorbed.length > 20 ? `(${absorbed.length - 20} earlier entries are in the log${logPath ? ` ${logPath}` : ''}.)` : null,
    'Nothing here needs action. If something you needed was absorbed, record it with triage --missed --kind absorbed.'].filter(Boolean).join('\n');
}

// ---- lock -----------------------------------------------------------------------------------
// The lock is a file `<log>.lock` holding {host, pid, token}. Correctness argument:
// - It is only ever created whole and exclusively: written to a unique temporary file, then
//   hard-linked into place (link fails if the name exists).
// - It is only ever removed in two ways. Its owner removes it on release, after reading it and
//   finding its own token. A waiter removes it only while holding the takeover lock
//   (`<log>.lock.takeover`, made the same way), after reading it again under that lock and
//   finding the same token it first inspected, recorded on this host by a process that no
//   longer exists. Age never counts.
// - So between a reader's check and its unlink the file cannot change: a live owner's lock is
//   never removed by anyone else, a dead owner cannot release, and takeovers are serialised.
// - The takeover lock is never taken over. It is held for a read and an unlink; if its holder
//   dies inside that window, runs wait waitMs and then forward with no actions until the
//   operator removes the file (the guide says how). A lock recorded on another host, or one
//   that cannot be read, is never taken over either.
const HOST = hostname();
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
function createExclusive(path, token) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ host: HOST, pid: process.pid, token, at: new Date().toISOString() })}\n`, { mode: 0o600 });
  try { linkSync(tmp, path); return true; } catch (error) { if (error.code === 'EEXIST') return false; throw error; } finally { unlinkSync(tmp); }
}
export function readLockFile(path) { try { const info = JSON.parse(readFileSync(path, 'utf8')); return isObject(info) && typeof info.token === 'string' ? info : null; } catch { return null; } }
const ownerGone = info => Boolean(info) && info.host === HOST && Number.isSafeInteger(info.pid) && info.pid > 0 && !alive(info.pid);
function releaseIfMine(path, token) { const info = readLockFile(path); if (info?.token === token) unlinkSync(path); }
// Returns the token; throws after waitMs. hooks (tests only) observe the interleavings.
export function acquireLock(path, { waitMs = 30000, hooks = {} } = {}) {
  const lock = `${path}.lock`, takeover = `${lock}.takeover`, token = randomBytes(12).toString('hex'), deadline = Date.now() + waitMs;
  for (;;) {
    if (createExclusive(lock, token)) return token;
    const seen = readLockFile(lock);
    hooks.afterInspect?.(seen);
    if (ownerGone(seen)) {
      const mine = randomBytes(12).toString('hex');
      if (createExclusive(takeover, mine)) {
        try {
          const now = readLockFile(lock);
          hooks.underTakeover?.(now);
          if (now?.token === seen.token && ownerGone(now)) unlinkSync(lock);
        } finally { releaseIfMine(takeover, mine); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for the triage lock ${lock}`);
    sleep(20 + Math.floor(Math.random() * 40));
  }
}
export function releaseLock(path, token) { releaseIfMine(`${path}.lock`, token); }
export function withLock(path, fn, options = {}) {
  const token = acquireLock(path, options);
  try { return fn(); } finally { releaseLock(path, token); }
}

// ---- state and log --------------------------------------------------------------------------
// Missing: a fresh state. Unreadable: kept aside and replaced, and the caller says so.
// Every reset this process made, by any command: main publishes one operator notice for each
// (dev.88 M4: a reset was told only to the orchestrator, and only by a run's forward).
export const stateResets = [];
// The proxy's thread ID as --set-proxy-id last recorded it in the log, which a reset does not touch
// (dev.88 M4: the fresh state had none, so every later forward said "identity not recorded").
export function loggedProxyId(logPath) {
  let id = null;
  for (const entry of readLog(logPath)) if (isObject(entry) && entry.decision === 'proxy-id' && isId(entry.proxyThreadId)) id = entry.proxyThreadId;
  return id;
}
// Every command that reads the state goes through here, so this is the gate for decisions saved but
// not logged (re-check of 766c23e: --send-failed offered a send for a row still undecided). With the
// log known, any row marked `undecided` has its decision logged (or found logged) and the mark cleared,
// and the state is saved, before the caller sees a single row. If the append or that save fails, the
// command fails: no command offers, sends, closes, escalates or counts a row whose decision is not
// in the log. A state file that cannot be read is reset as before; a fresh state has no such rows.
export function loadMemory(path, { logPath = null, nowMs = Date.now() } = {}) {
  if (!path || !existsSync(path)) return { memory: { version: 1 }, reset: null, recovered: [] };
  let memory;
  try { memory = JSON.parse(readFileSync(path, 'utf8')); if (!isObject(memory)) throw new Error('not an object'); }
  // The fresh state keeps a marker (bindingLost) until a run reads a binding: until then no forward
  // falls back to --forward-to, which may name a thread the lost binding had replaced (review of
  // b693894, P2-3: the reset run alone ignored it, and the next run sent there again).
  catch (readError) {
    const at = new Date().toISOString(), aside = `${path}.corrupt-${at.replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`;
    // A stable message (no time or random part), so the operator notice for it is the same each time.
    try { renameSync(path, aside); } catch (error) { throw new Error(`the triage state file ${path} cannot be read (${readError.code ?? readError.message}) or set aside (${error.code ?? error.message})`); }
    stateResets.push({ path, aside, at, error: String(readError.code ?? readError.message) });
    let proxyThreadId = null; try { proxyThreadId = logPath ? loggedProxyId(logPath) : null; } catch { proxyThreadId = null; }
    return { memory: { version: 1, bindingLost: { since: at, aside }, ...(proxyThreadId ? { proxyThreadId } : {}) }, reset: aside, recovered: [] };
  }
  return { memory, reset: null, recovered: settleUndecided(path, memory, logPath, nowMs) };
}
// The gate itself: log what is undecided, then save the cleared marks. Callers hold the lock.
function settleUndecided(path, memory, logPath, nowMs = Date.now()) {
  if (!logPath || !Object.values(isObject(memory.pending) ? memory.pending : {}).some(row => isObject(row) && row.undecided)) return [];
  const recovered = recoverDecisions(memory, logPath, new Date(nowMs).toISOString());
  saveMemory(path, memory);
  return recovered;
}
// The gate for a command that reads only the log (--forwards, --verify, --counts, --missed, --absorbed,
// --correct), when it is also given --memory: decisions saved but not logged are logged first, so the
// listing includes them. Without --memory such a command sees only the log, where an undecided row is
// not yet a forward at all: it is not listed, counted or closable until a command that holds the state logs it.
export function settleState(memoryPath, logPath, options = {}) {
  if (!memoryPath || !logPath || !existsSync(memoryPath)) return [];
  return withLock(logPath, () => {
    let memory; try { memory = JSON.parse(readFileSync(memoryPath, 'utf8')); } catch { return []; }
    return isObject(memory) ? settleUndecided(memoryPath, memory, logPath, options.nowMs) : [];
  }, options.lock ?? {});
}
export function saveMemory(path, memory) {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(memory, null, 1)}\n`, { mode: 0o600 }); renameSync(tmp, path);
}
const append = (path, entry) => appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
const readLog = path => path && existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
// Pending delivery forwards (review of 615f5a5, P2-2). Over MAX_PENDING_SENDS, only forwards the
// operator has been told about (covered by their destination's current outage notice) are evicted,
// oldest first; every other one is kept and becomes due for escalation at once, the notice naming
// the overflow. A forward nobody has been told about is never dropped: at MAX_UNREPORTED_SENDS of
// them the run refuses the new forward with an error, which the error path forwards (and the
// delivery stays unacknowledged in Factotum). So memory stays bounded, and nothing is lost unseen.
export const MAX_PENDING_SENDS = 500, MAX_UNREPORTED_SENDS = 2000;
const MAX_REMEMBERED = 2000;
function remember(memory, deliveryId, row) {
  memory.deliveries = { ...(isObject(memory.deliveries) ? memory.deliveries : {}), [deliveryId]: row };
  const keys = Object.keys(memory.deliveries);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_REMEMBERED))) delete memory.deliveries[key];
}
const resetNote = aside => `[Factotum via triage] The triage state file could not be read and was reset (the unreadable copy is kept at ${aside}). This run treated every delivery as new. The script publishes an operator notice about the reset.\n`;

// The provenance line every recorded forward carries, second after its headline. T3 does not
// authenticate who sent a message, so this proves nothing by itself: it names what the orchestrator
// checks against the proxy's log (--verify) and Factotum's own records (the delivery and the item).
export function provenanceLine({ proxyId, rule, deliveryId, sendId, at, logPath }) {
  return `Provenance: triage proxy ${isId(proxyId) ? proxyId : '(identity not recorded)'} · rule ${rule} · delivery ${isRecordId(deliveryId) ? deliveryId : 'none'} · send ${sendId === deliveryId ? '(the delivery ID)' : sendId} · decided ${at} · check: triage.mjs --log ${logPath ? resolve(logPath) : '<log>'} --verify ${sendId}`;
}
const withProvenance = (forward, fields) => { const [first, ...rest] = String(forward).replace(/\n$/, '').split('\n'); return [first, provenanceLine(fields), ...rest].join('\n'); };

// ---- unconfirmed forwards: re-send, fall back, escalate, close (dev.86, J7; dev.87, K1 and K5) ----
// The ready-made t3_thread_send arguments: the proxy passes this object as it is, so the thread ID
// (with any prefix such as `mcp:launch:`) is never retyped.
export const sendArgs = (threadId, message) => isId(threadId) && typeof message === 'string' && message ? { threadId, message, mode: 'queue' } : null;
// Pending sends a later run re-sends: each unconfirmed forward of a delivery that is still that
// delivery's newest attempt and still a forward, and each notice forward (an unreadable payload, a
// reset). Timer findings and digests are not listed: every timer or digest run produces them again.
function openSends(memory) {
  const pending = isObject(memory?.pending) ? memory.pending : {};
  return Object.entries(pending).filter(([key, row]) => {
    if (!isObject(row)) return false;
    // A forward whose decision is not yet in the log is never closed, sent again or escalated.
    if (row.undecided) return false;
    if (row.kind === 'notice') return true;
    if (row.kind !== 'delivery') return false;
    const d = isObject(memory.deliveries?.[row.deliveryId]) ? memory.deliveries[row.deliveryId] : null;
    return d?.decision === 'forward' && (d.lastSendId ?? key) === key;
  }).sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at));
}
// Decisions saved but not logged (review of 8441ff4, P2-1). A run writes its forward's pending row
// marked `undecided`, then the decision line, then clears the mark. A row still marked means a run
// failed between those writes. Before anything is closed or sent again, every run settles them: a
// row whose decision line is in the log just loses the mark; any other gets its decision line now,
// from what the row recorded when it was decided, marked `recovered`, with its original time. If
// that append fails, the run fails and sends nothing. So every forward the proxy can send is one
// --verify finds in the log as decided by the proxy. Returns the send IDs whose lines were written.
const DECIDED = ['forward', 'unsure', 'state-reset'];
export function recoverDecisions(memory, logPath, nowIso) {
  const open = Object.entries(isObject(memory?.pending) ? memory.pending : {}).filter(([, row]) => isObject(row) && row.undecided);
  if (!open.length) return [];
  const logged = new Set(readLog(logPath).filter(e => isObject(e) && DECIDED.includes(e.decision) && e.sendId).map(e => e.sendId)), out = [];
  for (const [key, row] of open) {
    if (!logged.has(key)) {
      append(logPath, { at: isTime(row.decidedAt) ? row.decidedAt : isTime(row.at) ? row.at : nowIso, decision: row.decision === 'unsure' ? 'unsure' : 'forward', rule: row.rule ?? null, sendId: key, deliveryId: row.deliveryId ?? null,
        event: row.event ?? null, inboxId: row.inboxId ?? null, version: row.version ?? null, taskId: row.taskId ?? null, flowId: row.flowId ?? null, title: row.title ?? null,
        reason: 'recovered: the run that decided it saved its state but could not log the decision; nothing was sent before this line', ...(isId(row.decidedFor) ? { forwardTo: row.decidedFor } : {}), forwardSource: row.forwardSource ?? null, recovered: true, recoveredAt: nowIso });
      out.push(key);
    }
    delete row.undecided;
  }
  return out;
}
// A thread that failed FAILURES_PER_THREAD sends with none confirmed since, for any forward: a
// later forward to it is down after its own first failure (dev.87, K5).
const threadFailed = (memory, thread) => (isObject(memory?.failedThreads?.[thread]) ? memory.failedThreads[thread].failures ?? 0 : 0) >= FAILURES_PER_THREAD;
// Where a send goes: one destination (dev.88, the operator's decision after the third re-check of
// 0933596). It is the orchestrator session bound now (the latest read; a rebind changes it for later
// sends), else the configured thread recorded when the forward was planned (no session bound yet).
// There is no other-thread fallback: a broken binding waits for a rebind or for the operator, who is
// told (see the outages below). Fallbacks to other threads were built and reviewed four times in
// dev.88 and each round found another way for them to deliver where nobody had agreed; see
// docs/changes/dev88-l-items.md.
export const destinationOf = (row, memory, sessionNow = null) => [sessionNow, memory?.mainThreadId, row?.configured, row?.decidedFor ?? row?.forwardTo].find(isId) ?? null;
const failuresFor = (row, thread) => (isObject(row?.failedBy) ? row.failedBy[thread] ?? 0 : 0);
// The destination is down for this forward: it failed FAILURES_PER_THREAD sends of it, or one after
// failing FAILURES_PER_THREAD sends of other forwards with none confirmed since.
const destDown = (row, memory, dest) => { const n = failuresFor(row, dest); return n >= FAILURES_PER_THREAD || (n >= 1 && threadFailed(memory, dest)); };
// Re-sends of an attention forward need a fresh read of the open items first, so a forward whose
// item has moved on is closed instead of sent (dev.88, L2: a notice the operator had acknowledged was
// delivered ten seconds later by a same-run send that read nothing). The read is the run's own, or,
// after a failed send, the `reread` the step names (`--send-failed --state`).
export const needsRead = row => row?.event === 'inbox.attention' && isRecordId(row.inboxId) && row.rule !== 'presentation-ended';
const rereadOf = row => needsRead(row) ? `--inbox ${row.inboxId}` : null;
// A complete list of the open inbox items, from a narrow read (`openItems`) or the compact view (`inbox`).
export function openItemsOf(read) {
  if (!isObject(read)) return null;
  if (Array.isArray(read.openItems)) return read.openItems;
  if (read.snapshotView === 'dashboard-v1' && Array.isArray(read.inbox)) return read.inbox.filter(item => isObject(item) && item.status === 'open');
  return null;
}
const sessionOf = read => [read?.project?.session?.sessionId, read?.orchestratorSession?.sessionId].find(isId) ?? null;
// Every thread a send ID was handed out for, in order, never rewritten (review P2-2): --sent and
// --send-failed name the thread the proxy actually used, and are credited to it only if it is here.
// A row kept before dev.87 has no list: it starts from the thread it was addressed to (re-check P2-3 of 2ca04f9).
// Each thread is listed once, so repeated retries to one thread never push the original out of the bound (re-check of 81f35f1).
const sentToWith = (row, thread) => {
  const before = [...new Set(Array.isArray(row.sentTo) ? row.sentTo.filter(isId) : [row.decidedFor, row.forwardTo].filter(isId))];
  return before.includes(thread) ? before : [...before, thread].slice(-50);
};
const targetSource = (thread, row, memory, sessionNow) => thread === sessionNow ? 'session' : thread === memory?.mainThreadId ? 'last-seen' : thread === row.configured ? 'configured' : 'as-decided';
const keepNewlines = (text, n) => { const s = String(text ?? ''); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
// Payloads go into ACT's single-quoted --payload: no single quotes.
const plain = text => String(text).replaceAll("'", '’');
// What a forward was about, for a person: its kind and title, else its item, flow or task. Never
// only a send ID (dev.87, K1: escalation titles were raw send IDs for rows kept before dev.86).
const RULE_LABELS = { 'operator-question': 'Operator question', 'orchestrator-question': 'Orchestrator question', handoff: 'Handoff question', 'operator-notice': 'Operator notice', 'flow-notice': 'Flow notice', 'flow-still-active': 'Flow notice', notice: 'Notice', reminder: 'Reminder of an open item', resend: 'Re-sent delivery', answered: 'Question answered', expired: 'Question expired', withdrawn: 'Item withdrawn', 'presentation-ended': 'Prompt presentation ended', approval: 'Task approved, not queued', 'approval-revoked': 'Task approval revoked', 'flow-stopped': 'Flow stopped', 'state-disagrees': 'Item state disagrees', 'no-state': 'Item not read', 'item-missing': 'Item not found', 'invalid-payload': 'Unreadable webhook payload', 'state-event-no-rule': 'State event with no rule', 'state-reset': 'Triage state reset' };
export function aboutForward(row) {
  const label = RULE_LABELS[row?.rule] ?? (row?.rule ? `Forward (rule ${clip(row.rule, 40)})` : 'Forward');
  const what = row?.title ? `“${clip(row.title, 120)}”` : isRecordId(row?.inboxId) ? `inbox item ${clip(row.inboxId, 80)}` : isRecordId(row?.flowId) ? `flow ${clip(row.flowId, 80)}` : isRecordId(row?.taskId) ? `task ${clip(row.taskId, 80)}` : null;
  const task = what && isRecordId(row.taskId) && !what.startsWith('task ') ? ` (task ${clip(row.taskId, 80)})` : '';
  return what ? `${label}: ${what}${task}` : `${label} decided at ${row?.decidedAt ?? row?.at ?? 'an unknown time'}`;
}
// A pending row kept before dev.86 has no text, and one kept before dev.87 no item version or
// event: fill them in from the forward's decision line in the log, once (dev.87, K1 and K5).
function hydrate(key, row, entries) {
  if (row.hydrated || (row.event !== undefined && row.rule)) return;
  const matches = entries.filter(e => isObject(e) && ['forward', 'unsure'].includes(e.decision) && (e.sendId === key || (!e.sendId && row.deliveryId && e.deliveryId === row.deliveryId && key === row.deliveryId)));
  const e = matches.at(-1);
  if (e) {
    for (const field of ['rule', 'inboxId', 'version', 'event', 'title', 'taskId', 'flowId']) if (row[field] === undefined && e[field] !== undefined && e[field] !== null) row[field] = e[field];
    row.decidedFor = row.decidedFor ?? (isId(e.forwardTo) ? e.forwardTo : null);
    row.decidedAt = row.decidedAt ?? e.at;
  }
  row.hydrated = true;
}
// The orchestrator handled it from state and recorded so, after it was decided:
// --missed --kind undelivered --ref <sendId or deliveryId> (dev.87, K5).
// --kind received (dev.88, L1): the forward reached the orchestrator, which says so, although the proxy never confirmed it.
const HANDLED_KINDS = ['undelivered', 'received'];
const handledBy = (key, row, entries) => entries.findLast(e => isObject(e) && e.decision === 'missed' && HANDLED_KINDS.includes(e.kind) && (e.ref === key || (row.deliveryId && e.ref === row.deliveryId)) && Date.parse(e.at) >= Date.parse(row.decidedAt ?? row.at)) ?? null;
// Whether the item an attention forward is about has moved on, judged from a complete list of open
// items (the narrow read's `openItems`, the compact view's open `inbox` items): no longer open, or
// open at a newer version, so the forward asks about something that is no longer so (dev.87, K1).
// readRevision: the project revision of the read the open items come from. A read older than the one
// the forward was decided from (an overlapping run's) may not list an item opened since, so it closes
// nothing (third re-check of 0933596, stale reads).
export function obsoleteBy(row, openItems, readRevision = null) {
  if (!Array.isArray(openItems) || row?.event !== 'inbox.attention' || !isRecordId(row.inboxId) || row.rule === 'presentation-ended') return null;
  if (Number.isSafeInteger(row.readRevision) && !(Number.isSafeInteger(readRevision) && readRevision >= row.readRevision)) return null;
  const now = openItems.find(item => isObject(item) && item.id === row.inboxId);
  if (!now) return `inbox item ${row.inboxId} is no longer open`;
  if (Number.isSafeInteger(row.version) && Number.isSafeInteger(now.version) && now.version > row.version) return `inbox item ${row.inboxId} is open at version ${now.version}, newer than the version ${row.version} the forward was about`;
  return null;
}
// Escalation notices are left for the operator to dismiss (re-check P2-1 of 2ca04f9). Core lets
// any orchestrator-role caller withdraw a notice the orchestrator role published, and actor names
// are declared by the caller, so the proxy cannot prove it published a given notice: another
// publisher could publish the same ID, title and context first. It therefore withdraws nothing.
// When a notice's outage ends, the next delivery forward says it is moot, once, and the
// orchestrator can tell the operator.
const MAX_MOOT = 20, MAX_ENDED = 20;
// Outages (dev.88). An outage of a destination starts the first time a forward to it is due for
// escalation (it failed there, or it is ESCALATE_MINUTES old, or there is no destination), and ends
// when a send to it is confirmed, or when it is bound anew after another session. memory.outages,
// keyed by the destination, holds each current outage: a unique `id`, and its one notice (`status`
// none, offered or published, `noticeId`, the `escalation` offered, the forwards it lists or
// covers). A forward is covered (`toldIn`, the outage id) only by its destination's current outage,
// and only once that notice's read-back was verified. Ending an outage clears every forward's
// failure counts for it, and any coverage lapses with the outage id. So a notice cannot outlive its
// outage: a read-back that arrives after the outage ended covers nothing (third re-check of
// 0933596), and a forward is dropped at expiry only if the operator was told about its current outage.
const NO_THREAD = '(no orchestrator thread)';
const outageKey = dest => dest ?? NO_THREAD;
const outagesOf = memory => (memory.outages = isObject(memory.outages) ? memory.outages : {});
function currentOutage(memory, dest, nowIso) {
  const all = outagesOf(memory), key = outageKey(dest);
  if (!isObject(all[key])) { memory.outageSeq = (Number.isSafeInteger(memory.outageSeq) ? memory.outageSeq : 0) + 1; all[key] = { id: memory.outageSeq, startedAt: nowIso, status: 'none', sendIds: [] }; }
  return all[key];
}
export const coveredNow = (row, memory, dest) => {
  const outage = isObject(memory?.outages) ? memory.outages[outageKey(dest)] : null;
  return Boolean(isObject(outage) && outage.status === 'published' && Number.isSafeInteger(row?.toldIn) && row.toldIn === outage.id);
};
function noteMoot(memory, noticeId, why) {
  memory.mootEscalations = [...(Array.isArray(memory.mootEscalations) ? memory.mootEscalations : []), { noticeId, why: clip(why, 200) }].slice(-MAX_MOOT);
}
const mootLine = memory => { const rows = Array.isArray(memory?.mootEscalations) ? memory.mootEscalations.filter(isObject) : [];
  return rows.length ? `Escalation notices now moot (data): ${rows.map(row => `${clip(row.noticeId, 80)} (${row.why})`).join('; ')}. Tell the operator they can dismiss them; the proxy withdraws nothing.` : null; };
// The outage of a destination ends. Its published notice is moot (said once, by the next delivery
// forward); one offered and not yet verified is kept aside, so a late read-back of it finds it,
// covers nothing, and is reported moot. Every forward's failure counts for it are cleared.
// dest null is the outage of forwards with no destination (NO_THREAD): it ends when a session is bound
// or a send is confirmed, since from then on those forwards have a destination. Before dev.89 it never
// ended (the factory's own audit of dev.88), so its notice was never reported moot, and a later
// period with no thread was covered by that old notice, which the operator may have dismissed long ago.
function endOutage(memory, dest, why, nowIso) {
  if (dest !== null && !isId(dest)) return;
  if (isId(dest)) {
    for (const row of Object.values(isObject(memory.pending) ? memory.pending : {})) if (isObject(row) && isObject(row.failedBy)) delete row.failedBy[dest];
    if (isObject(memory.failedThreads)) delete memory.failedThreads[dest];
  }
  const all = outagesOf(memory), key = outageKey(dest), outage = all[key];
  if (!isObject(outage)) return;
  delete all[key];
  if (outage.status === 'published') noteMoot(memory, outage.noticeId, why);
  else if (outage.status === 'offered') memory.endedNotices = [...(Array.isArray(memory.endedNotices) ? memory.endedNotices : []), { noticeId: outage.noticeId, payload: outage.escalation?.payload ?? null, sendIds: outage.sendIds, endedAt: nowIso, why: clip(why, 200) }].slice(-MAX_ENDED);
}
// What a read says about the bound session. Session versions are compared by number and never go
// back: a read older than the newest one seen (from an overlapping run) changes nothing (third
// re-check of 0933596). A newer version is a rebind: the outage of the session bound before ends
// (its forwards now go elsewhere) and the session bound now starts afresh (A, then B, then A again).
// Returns the bound session to use: the newest one known.
function observeSession(memory, read, nowIso) {
  const sessionId = sessionOf(read), session = isObject(read?.project?.session) ? read.project.session : isObject(read?.orchestratorSession) ? read.orchestratorSession : null;
  const known = Number.isSafeInteger(memory.mainSessionVersion) ? memory.mainSessionVersion : null, version = Number.isSafeInteger(session?.version) ? session.version : null;
  if (!sessionId || (known !== null && (version === null || version < known))) return isId(memory.mainThreadId) ? memory.mainThreadId : null;
  const before = isId(memory.mainThreadId) ? memory.mainThreadId : null;
  if (known !== null ? version > known : before !== null && before !== sessionId) {
    if (before && before !== sessionId) endOutage(memory, before, `the orchestrator session was rebound from ${before} to ${sessionId}`, nowIso);
    endOutage(memory, sessionId, `${sessionId} was bound anew`, nowIso);
  }
  memory.mainThreadId = sessionId;
  endOutage(memory, null, `orchestrator session ${sessionId} is bound`, nowIso);
  if (version !== null) memory.mainSessionVersion = version;
  delete memory.bindingLost;
  return sessionId;
}
// Absorbed deliveries and the forward that reports each (dev.88). A delivery forward says how many
// were absorbed since the last forward and claims them; the claim is released if that forward is
// closed without reaching the orchestrator, and dropped once it is confirmed. So each absorbed
// delivery is reported on one forward only: in dev.87 a counter reset only by a confirmation made a
// forward that was never confirmed and the next one report the same delivery.
const MAX_ABSORBED = 2000;
function absorbedLedger(memory) {
  if (!Array.isArray(memory.absorbed)) {
    const n = Number.isSafeInteger(memory.absorbedSinceForward) ? Math.min(memory.absorbedSinceForward, MAX_ABSORBED) : 0;
    memory.absorbed = Array.from({ length: n }, () => ({ deliveryId: null, at: null, by: null }));
  }
  delete memory.absorbedSinceForward;
  return memory.absorbed;
}
export const unreported = memory => Array.isArray(memory?.absorbed) ? memory.absorbed.filter(row => isObject(row) && !row.by).length : (Number.isSafeInteger(memory?.absorbedSinceForward) ? memory.absorbedSinceForward : 0);
function recordAbsorbed(memory, deliveryId, at) { memory.absorbed = [...absorbedLedger(memory), { deliveryId, at, by: null }].slice(-MAX_ABSORBED); }
function claimAbsorbed(memory, sendId) { for (const row of absorbedLedger(memory)) if (isObject(row) && !row.by) row.by = sendId; }
function settleAbsorbed(memory, sendId, reported) {
  const ledger = absorbedLedger(memory);
  memory.absorbed = reported ? ledger.filter(row => row?.by !== sendId) : ledger.map(row => row?.by === sendId ? { ...row, by: null } : row);
}
// Another send of the same delivery was confirmed after this one was decided (dev.88, review P2-1):
// the orchestrator has the delivery, so this attempt is closed as delivered, never escalated.
function deliveredElsewhere(memory, row) {
  if (row?.kind !== 'delivery' || !row.deliveryId) return null;
  const d = isObject(memory.deliveries?.[row.deliveryId]) ? memory.deliveries[row.deliveryId] : null, at = d?.lastSentAt ?? d?.sentAt;
  return d?.sent === true && isTime(at) && Date.parse(at) >= Date.parse(row.decidedAt ?? row.at) ? `another send of delivery ${row.deliveryId} was confirmed at ${at}` : null;
}
// The log's confirmation of this send, after it was decided, or null.
const sentInLog = (key, row, entries) => entries.findLast(e => isObject(e) && e.decision === 'sent' && e.sendId === key && isTime(e.at) && Date.parse(e.at) >= Date.parse(row.decidedAt ?? row.at)) ?? null;
// Close the unconfirmed forwards that no longer need a send: those the orchestrator recorded as
// handled, and attention forwards whose item has moved on (when this run read a complete list of
// open items). Neither is re-sent or escalated; an escalation notice already published is noted as moot.
function closeSends(memory, { entries, openItems, readRevision = null, nowMs, logPath, skip }) {
  const out = [];
  for (const [key, row] of openSends(memory)) {
    if (key === skip) continue;
    hydrate(key, row, entries);
    // --sent wrote its line but not the state (the state write failed after it, dev.89 N2): the
    // forward reached the orchestrator, so it is closed as delivered, never re-sent or escalated.
    const logged = sentInLog(key, row, entries);
    if (logged) {
      const d = row.kind === 'delivery' && isObject(memory.deliveries?.[row.deliveryId]) ? memory.deliveries[row.deliveryId] : null;
      if (d?.decision === 'forward') remember(memory, row.deliveryId, { ...d, sent: true, sentAt: d.sentAt ?? logged.at, lastSentAt: logged.at });
      out.push(closeSend(memory, key, row, 'delivered', `its send was confirmed at ${logged.at} (the log has the confirmation; the state write after it failed)`, { nowMs, logPath, reported: true })); continue;
    }
    const elsewhere = deliveredElsewhere(memory, row);
    // Its text did not reach the orchestrator, so what it claimed is reported again by the next forward.
    if (elsewhere) { out.push(closeSend(memory, key, row, 'delivered', elsewhere, { nowMs, logPath })); continue; }
    const handled = handledBy(key, row, entries), obsolete = handled ? null : obsoleteBy(row, openItems, readRevision);
    if (!handled && !obsolete) continue;
    out.push(closeSend(memory, key, row, handled ? 'handled' : 'obsolete', handled ? `the orchestrator recorded it as ${handled.kind === 'received' ? 'received' : 'handled from state'} at ${handled.at}` : obsolete, { nowMs, logPath, reported: handled?.kind === 'received' }));
  }
  return out;
}
// reported: the forward reached the orchestrator (received), so the absorbed deliveries it claimed are reported.
function closeSend(memory, key, row, closed, reason, { nowMs, logPath, reported = false }) {
  delete memory.pending[key];
  settleAbsorbed(memory, key, reported);
  append(logPath, { at: new Date(nowMs).toISOString(), decision: closed, sendId: key, deliveryId: row.deliveryId ?? null, inboxId: row.inboxId ?? null, note: clip(reason, 300) });
  return { sendId: key, closed, about: aboutForward(row), reason };
}
// The operator notice for forwards nobody received. The proxy asks for it with --escalate, which
// checks again at that moment that the forward is still unconfirmed (dev.87, K1), publishes it with
// ACT (as the orchestrator role, so it wakes nobody at essential or actionable), reads it back with
// status --inbox and runs --escalated with that read. It answers, approves and acknowledges
// nothing; the operator sees it in the console's Inbox. One notice per outage of a destination
// (dev.88): it is made once and kept with the outage, so every later offer is the same notice under
// the same ID (a re-run after a lost --escalated finds its own notice). The ID ends in a random
// part, so it cannot be predicted and taken first by someone else (review fix P2-3); --escalated
// still checks the notice.
const escalationId = sendId => `triage-undelivered-${digestOf(sendId)}-${randomBytes(4).toString('hex')}`;
const RESENT = /^\[Factotum via triage\]\s*(Re-sent \([^)]*\):\s*)?/;
// others: [[sendId, row, reason]] further forwards to the same destination, due at the same time.
export function escalation(sendId, row, reason, others = []) {
  const headline = (typeof row.forward === 'string' && row.forward ? row.forward.split('\n')[0].replace(RESENT, '') : '') || aboutForward(row);
  const tried = Object.entries(isObject(row.failedBy) ? row.failedBy : {}).map(([thread, n]) => `${thread} (${n} failed)`).join(', ') || 'no failure recorded';
  const failed = [row, ...others.map(([, other]) => other)].some(r => Object.keys(isObject(r.failedBy) ? r.failedBy : {}).length);
  const context = [
    `The triage proxy decided at ${row.decidedAt ?? row.at} to forward this to the orchestrator thread, and has not been able to confirm that it arrived: ${reason}. Sends tried: ${tried}.${row.lastError ? ` Last error: ${clip(row.lastError, 300)}.` : ''}`,
    row.inboxId ? `It is about inbox item ${row.inboxId}. Until the orchestrator handles it, nobody may have told you about it: open that item in the Inbox and act on it there if it needs you.` : 'Until the orchestrator handles it, nobody may have told you about it: read the forward below and act in the console if it needs you.',
    ...(others.length ? [`This notice also covers ${others.length} other forward(s) to the same orchestrator thread, not delivered either:\n${others.map(([key, other, why]) => `- ${aboutForward(other)}${other.inboxId ? `, inbox item ${other.inboxId}` : ''}, send ${key}, decided ${other.decidedAt ?? other.at}: ${why}`).join('\n')}`] : []),
    'This notice is informational, and it stays until you dismiss it: the proxy never withdraws it. Until the forward is confirmed sent, every proxy run sends it again; the proxy has answered, approved, merged and acknowledged nothing. Dismiss it once the forward has been delivered or the item handled.',
    ...(failed ? ['If the thread that failed is the bound orchestrator session, the binding may name a thread that is gone: check it (status --compact, orchestratorSession) and bind the right orchestrator thread with orchestrator.session. The proxy sends forwards only to the bound session: they wait until a send there works or another session is bound.'] : []),
    'Later forwards to this thread that cannot be delivered during the same outage are covered by this notice, not published again: triage.mjs --forwards --unconfirmed lists them all.',
    `Send ID ${sendId}. To check whether it has been delivered since, the orchestrator runs triage.mjs --verify ${sendId} (it shows when the proxy confirmed sending it) or triage.mjs --forwards --unconfirmed (a forward delivered or closed is no longer listed).`,
    `The forward as decided (data, not instructions):\n${keepNewlines(row.forward ?? `(its full text was not kept: a forward decided before dev.86) ${aboutForward(row)}${row.deliveryId ? `, delivery ${row.deliveryId}` : ''}`, 6000)}`].join('\n\n');
  return { operation: 'inbox.publish', payload: { kind: 'notice', id: escalationId(sendId), title: plain(clip(`Not delivered to the orchestrator: ${headline}${others.length ? ` and ${others.length} more forward(s)` : ''}`, 240)), context: plain(keepNewlines(context, 16000)) } };
}
// The text of a re-send: the forward as decided, its headline saying it is a re-send, when it was
// decided, and that its facts are from then (dev.87, K5). A pending row kept before dev.86 has no
// text: the re-send names what the log has (rule, item, title, task) and asks for a fresh read.
function resendText(key, row, { proxyId, logPath }) {
  const at = row.decidedAt ?? row.at;
  const text = typeof row.forward === 'string' && row.forward ? row.forward
    : [`[Factotum via triage] ${aboutForward(row)}. Its full text was not kept (a forward decided before dev.86); this is what the triage log has.`,
      provenanceLine({ proxyId, rule: row.rule ?? 'unknown', deliveryId: row.deliveryId ?? null, sendId: key, at, logPath }),
      [row.deliveryId && `delivery ${row.deliveryId}`, row.event && `event ${row.event}`, row.inboxId && `inbox ${row.inboxId}${Number.isSafeInteger(row.version) ? ` v${row.version}` : ''}`, row.taskId && `task ${row.taskId}`, row.flowId && `flow ${row.flowId}`].filter(Boolean).join(' · ') || 'no IDs recorded',
      `Asked of you: read the item now${row.inboxId ? ` (status --inbox ${row.inboxId})` : ''} and handle it per your handling guide if it still needs you; it may have been handled long ago.${row.deliveryId ? ` After handling, run delivery.ack {"deliveryId":"${row.deliveryId}"}, unless only the operator may acknowledge it.` : ''}`].join('\n');
  const [first, ...rest] = text.split('\n');
  return capForward([first.replace(RESENT, `[Factotum via triage] Re-sent (decided ${at}, not confirmed sent since; its facts are from then, so read the item before acting): `), ...rest].join('\n'));
}
// Keeps the pending delivery forwards under maxPending by evicting only forwards the operator has
// been told about, oldest first (see MAX_PENDING_SENDS). If that is not enough, memory.overflow
// records it and every unreported forward is due for escalation (dueNow).
function boundPending(memory, { maxPending, sessionNow, nowMs, logPath }) {
  const nowIso = new Date(nowMs).toISOString(), keys = Object.keys(memory.pending).filter(key => memory.pending[key]?.kind === 'delivery');
  let count = keys.length;
  for (const key of keys) {
    if (count <= maxPending) break;
    const row = memory.pending[key];
    if (!coveredNow(row, memory, destinationOf(row, memory, sessionNow))) continue;
    delete memory.pending[key]; settleAbsorbed(memory, key, false); count--;
    append(logPath, { at: nowIso, decision: 'retry-expired', sendId: key, deliveryId: row.deliveryId ?? null, note: `evicted: more than ${maxPending} unconfirmed forwards are kept, and the operator was told of its current outage at ${row.escalatedAt}` });
  }
  if (count > maxPending) memory.overflow = { since: memory.overflow?.since ?? nowIso, count, limit: maxPending };
  else delete memory.overflow;
}
// Why the operator should be told about an unconfirmed forward now, or null, with its destination:
// there is no destination, the destination is down for it, or it is ESCALATE_MINUTES old. Never how
// often it was re-sent (review fix P2-2).
function dueNow(row, memory, nowMs, sessionNow = null) {
  const dest = destinationOf(row, memory, sessionNow), down = dest ? destDown(row, memory, dest) : true, ageMs = nowMs - Date.parse(row.decidedAt ?? row.at);
  const why = !dest ? 'there is no orchestrator thread to send it to'
    : down ? `the orchestrator session ${dest} failed ${failuresFor(row, dest)} send(s) of it${row.lastError ? ` (last error: ${clip(row.lastError, 120)})` : ''}; forwards wait until a send there works or another session is bound`
      : ageMs >= ESCALATE_MINUTES * 60000 ? `it is still not confirmed sent ${Math.floor(ageMs / 60000)} minutes after it was decided`
        : isObject(memory?.overflow) ? `the proxy holds ${memory.overflow.count} unconfirmed forwards, more than its limit of ${memory.overflow.limit}; none the operator has not been told about is dropped` : null;
  return { dest, down, why };
}
// The next step for one unconfirmed forward.
// - A run (no `failedTo`) sends it to its destination, whatever happened before: it may be back.
// - After a failed send (`failedTo`, from --send-failed): the destination once more, unless it is
//   down for this forward; then `send` is null, and later runs send it again.
// - `send: false`: offer no send (the run's budget is spent, the item was not read again, or the
//   forward is past RETRY_HOURS), only an escalation that is due.
// `escalateDue` (the reason) is set when an escalation is due and the forward is not covered by its
// destination's current outage notice. An escalation is never a payload here: the proxy asks
// --escalate for the notice after this run's sends are recorded, so a forward a send has just
// delivered is never escalated (dev.87, K1). Mutates `row` when it offers a send, and returns null
// when there is nothing to do.
function planSend(key, row, memory, { nowMs, sessionNow = null, failedTo = undefined, send: sending = true, proxyId = null, logPath = null }) {
  const immediate = failedTo !== undefined, { dest, down, why } = dueNow(row, memory, nowMs, sessionNow);
  const thread = sending && dest && (!immediate || !down) ? dest : null, escalateDue = why && !coveredNow(row, memory, dest) ? why : null;
  if (!thread && !escalateDue) return null;
  let send = null, forwardSource = null;
  if (thread) {
    forwardSource = targetSource(thread, row, memory, sessionNow);
    row.decidedFor = row.decidedFor ?? row.forwardTo ?? null;
    Object.assign(row, { retries: (row.retries ?? 0) + 1, lastRetryAt: new Date(nowMs).toISOString(), forwardTo: thread, forwardSource, sentTo: sentToWith(row, thread) });
    send = sendArgs(thread, resendText(key, row, { proxyId, logPath }));
  }
  return { sendId: key, about: aboutForward(row), retry: row.retries ?? 0, decidedAt: row.decidedAt ?? row.at, deliveryId: row.deliveryId ?? null, failures: row.failures ?? 0, forwardTo: thread, forwardSource, send, ...(send && rereadOf(row) ? { reread: rereadOf(row) } : {}), escalateDue };
}
const retryLine = (key, row, step, nowIso) => ({ at: nowIso, decision: 'retry', sendId: key, deliveryId: row.deliveryId ?? null, retry: step.retry, forwardTo: step.forwardTo, forwardSource: step.forwardSource });
// The re-sends a run makes: unconfirmed forwards decided at least RETRY_GRACE_SECONDS ago and not
// re-sent within that time, those whose last attempt is oldest first, at most RETRIES_PER_RUN, so
// the budget rotates through all of them (review fix P2-1). Every forward whose escalation is due
// says so in the same run (`escalateDue`), whether or not it is re-sent.
// An attention forward is sent only by a run that read the open items (`openItems`; closeSends has
// already closed those whose item moved on). A run that read nothing sends it nothing but still
// marks its escalation (review P2-2 of 44a3127: it used to skip such a forward until it expired).
// Past RETRY_HOURS a forward is no longer sent; it is dropped only once the verified notice of its
// destination's current outage covers it (third re-check of 0933596: an older escalation, about an
// outage that has since ended, does not count).
// A read older than the one a forward was decided from (an overlapping run's) does not count as a read
// for it: it cannot show that the item is still open, so the forward is not sent in that run (the
// factory's own audit of dev.88: closeSends already refused to close on such a read, but the re-send went ahead).
// A forward whose last send failed and whose destination has changed since (a rebind) is sent at once,
// without the two-minute spacing, which is there for a send to the same thread that may still be in
// progress (dev.88 M7: the "After binding" wake re-sent nothing).
const staleFor = (row, readRevision) => Number.isSafeInteger(row?.readRevision) && !(Number.isSafeInteger(readRevision) && readRevision >= row.readRevision);
const movedAfterFailure = (row, memory, sessionNow, lastMs) => { const dest = destinationOf(row, memory, sessionNow);
  return isId(dest) && isId(row.forwardTo) && dest !== row.forwardTo && isTime(row.lastFailedAt) && Date.parse(row.lastFailedAt) >= lastMs; };
function dueResends(memory, { nowMs, skip, logPath, openItems = null, readRevision = null, sessionNow = null, ...rest }) {
  const rows = [], quiet = new Set(), lastOf = row => Math.max(Date.parse(row.decidedAt ?? row.at), isTime(row.lastRetryAt) ? Date.parse(row.lastRetryAt) : 0);
  const moved = row => movedAfterFailure(row, memory, sessionNow, lastOf(row));
  for (const [key, row] of openSends(memory)) {
    if (key === skip) continue;
    const expired = nowMs - Date.parse(row.decidedAt ?? row.at) >= RETRY_HOURS * 3600000;
    if (expired && coveredNow(row, memory, destinationOf(row, memory, sessionNow))) {
      delete memory.pending[key]; settleAbsorbed(memory, key, false);
      append(logPath, { at: new Date(nowMs).toISOString(), decision: 'retry-expired', sendId: key, deliveryId: row.deliveryId ?? null, note: `not confirmed sent within ${RETRY_HOURS} hours, and the operator was told of its current outage at ${row.escalatedAt}; no longer re-sent` });
      continue;
    }
    if (expired || (needsRead(row) && (!Array.isArray(openItems) || staleFor(row, readRevision)))) quiet.add(key);
    rows.push([key, row]);
  }
  const sending = new Set(rows.filter(([key, row]) => !quiet.has(key) && (moved(row) || nowMs - lastOf(row) >= RETRY_GRACE_SECONDS * 1000))
    .sort((a, b) => Number(moved(b[1])) - Number(moved(a[1])) || lastOf(a[1]) - lastOf(b[1]) || Date.parse(a[1].decidedAt ?? a[1].at) - Date.parse(b[1].decidedAt ?? b[1].at)).slice(0, RETRIES_PER_RUN).map(([key]) => key));
  const out = [], nowIso = new Date(nowMs).toISOString();
  for (const [key, row] of [...rows].sort((a, b) => Number(sending.has(b[0])) - Number(sending.has(a[0])) || lastOf(a[1]) - lastOf(b[1]))) {
    const step = planSend(key, row, memory, { nowMs, logPath, sessionNow, send: sending.has(key), ...rest });
    if (!step) continue;
    if (step.send) append(logPath, retryLine(key, row, step, nowIso));
    out.push(step);
  }
  return out;
}
// A timer run removes wake directories a run left behind (the brief removes its own; one that
// stopped early may not have).
function removeOldWakeDirs(memoryPath, nowMs) {
  let removed = 0;
  try {
    const dir = dirname(resolve(memoryPath));
    for (const name of readdirSync(dir)) {
      if (!/^wake\.[A-Za-z0-9]{6,}$/.test(name)) continue;
      const path = join(dir, name), info = statSync(path);
      if (info.isDirectory() && nowMs - info.mtimeMs >= WAKE_DIR_HOURS * 3600000) { rmSync(path, { recursive: true, force: true }); removed++; }
    }
  } catch { /* best effort: a run never fails over its scratch directories */ }
  return removed;
}

// One wake, timer or digest run, inside the lock. Pending outbound messages are kept in
// memory.pending until --sent confirms them; only then do they count as reported.
export function runRecorded(kind, { memoryPath, logPath, input, statePath = null, projectId = null, forwardTo = null, proxyId = null, stallMinutes = STALL_MINUTES, idleMinutes = IDLE_MINUTES, reforwardEvery = REFORWARD_EVERY, readError = null, nowMs = Date.now(), lock = {}, limits = {} }) {
  const maxPending = limits.pending ?? MAX_PENDING_SENDS, maxUnreported = limits.unreported ?? MAX_UNREPORTED_SENDS;
  return withLock(logPath, () => {
    const { memory, reset, recovered } = loadMemory(memoryPath, { logPath, nowMs }), nowIso = new Date(nowMs).toISOString(), shownLog = resolve(logPath);
    // A state file that could not be read is an error path (review of 615f5a5, P2-1): the configured
    // thread may be long retired, so this run uses only a binding it reads itself.
    if (reset || isObject(memory.bindingLost)) forwardTo = null;
    memory.pending = isObject(memory.pending) ? memory.pending : {};
    // A forward an earlier run saved but could not log was logged by loadMemory, before anything is
    // closed or sent again; if that failed, this run failed and sends nothing (review of 8441ff4, P2-1).
    // openItems: a complete list of the open inbox items this run read, if it read one (dev.87, K1).
    // readRevision: the project revision of that read, kept with the run's own forward (see obsoleteBy).
    let result, entry, deliveryId = null, sessionNow = null, removedWakeDirs = 0, openItems = null, readRevision = null;
    if (kind === 'timer') {
      let compact = null; try { compact = JSON.parse(input); } catch { compact = null; }
      sessionNow = isObject(compact) && isId(compact.orchestratorSession?.sessionId) ? observeSession(memory, compact, nowIso) : null;
      // The compact view lists every open inbox item (and recent closed ones).
      if (isObject(compact) && compact.snapshotView === 'dashboard-v1') { openItems = openItemsOf(compact); readRevision = Number.isSafeInteger(compact.revision) ? compact.revision : null; }
      removedWakeDirs = removeOldWakeDirs(memoryPath, nowMs);
      const { timer, findings, ...checked } = timerCheck(compact, memory, { nowMs, stallMinutes, idleMinutes, forwardTo });
      // A compact view older than one already seen does not redirect the forward.
      const out = checked.forwardSource === 'session' && sessionNow && checked.forwardTo !== sessionNow ? { ...checked, forwardTo: sessionNow } : checked;
      if (out.decision === 'absorb') memory.timer = timer;
      else {
        // The new forward carries every earlier unconfirmed finding, so it replaces them.
        for (const key of Object.keys(memory.pending)) if (key.startsWith('timer:')) delete memory.pending[key];
        memory.pending[out.sendId] = { kind: 'timer', at: nowIso, timer: timer ?? null, findings };
      }
      entry = { at: nowIso, decision: out.decision, rule: out.rule, reason: clip(out.reason, 300) };
      result = out;
    } else if (kind === 'digest') {
      // A digest run reads status --compact too (dev.88, L2), so its re-sends are checked against the
      // open items and go to the bound session. Without it (an older brief) it re-sends no attention forward.
      let compact = null; try { compact = input ? JSON.parse(input) : statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : null; } catch { compact = null; }
      if (isObject(compact) && compact.snapshotView === 'dashboard-v1') { openItems = openItemsOf(compact); readRevision = Number.isSafeInteger(compact.revision) ? compact.revision : null; sessionNow = observeSession(memory, compact, nowIso); }
      // The digest covers log lines after the last confirmed digest (by position: runs are serialised).
      const entries = readLog(logPath), from = Number.isSafeInteger(memory.lastDigestLine) ? memory.lastDigestLine : 0;
      const text = digestText(entries.slice(from), memory.lastDigestAt ?? null, shownLog);
      for (const key of Object.keys(memory.pending)) if (key.startsWith('digest:')) delete memory.pending[key];
      if (text) memory.pending[`digest:${nowIso}`] = { kind: 'digest', at: nowIso, until: nowIso, line: entries.length };
      result = { decision: text ? 'forward' : 'absorb', rule: 'digest', reason: text ? 'absorbed entries since the last digest' : 'nothing absorbed since the last digest', actions: [], forward: text, ...(text ? forwardTarget(sessionNow, memory, forwardTo) : { forwardTo: null, forwardSource: null }), sendId: text ? `digest:${nowIso}` : null };
      entry = { at: nowIso, decision: result.decision, rule: 'digest', reason: result.reason };
    } else {
      let payload; try { payload = JSON.parse(input); } catch { payload = null; }
      let state = null; try { state = statePath ? JSON.parse(readFileSync(statePath, 'utf8')) : null; } catch { state = null; }
      // Room for the provenance line (and a reset note) inside FORWARD_CHARS, sized for the longest rule and send ID.
      const known = normalizePayload(payload) ?? {};
      const reserve = provenanceLine({ proxyId: proxyId ?? memory.proxyThreadId, rule: 'r'.repeat(40), deliveryId: known.deliveryId, sendId: 's'.repeat(Math.max(48, String(known.deliveryId ?? '').length + 8)), at: nowIso, logPath }).length + 1 + (reset ? resetNote(reset).length : 0);
      sessionNow = sessionOf(state) ? observeSession(memory, state, nowIso) : null;
      result = decide({ payload, state, memory }, { projectId, logPath: shownLog, forwardTo, reforwardEvery, reserve, readError, ...(sessionNow ? { boundNow: sessionNow } : {}) });
      // Every narrow read lists all open inbox items (operations/state-view.mjs openItems).
      openItems = openItemsOf(state); readRevision = openItems && Number.isSafeInteger(state.revision) ? state.revision : null;
      const p = known, item = isObject(state?.item) && state.item.id === p.inboxId ? state.item : null;
      if (isRecordId(p.deliveryId) && result.rule !== 'invalid-payload') {
        deliveryId = p.deliveryId;
        const prior = isObject(memory.deliveries?.[p.deliveryId]) ? memory.deliveries[p.deliveryId] : null;
        // Each forward of a delivery is its own send attempt with its own send ID, `<deliveryId>:<n>`,
        // and destination (dev.85 review fix): two forwards of one delivery decided for different
        // threads, the first confirmed after the second was decided, each keep where they went.
        const forwarding = ['forward', 'unsure'].includes(result.decision);
        const attempts = (Number.isSafeInteger(prior?.sendAttempts) ? prior.sendAttempts : 0) + (forwarding ? 1 : 0);
        if (forwarding) result = { ...result, sendId: `${p.deliveryId}:${attempts}` };
        const sends = attempts ? { sendAttempts: attempts, lastSendId: forwarding ? result.sendId : prior?.lastSendId ?? null } : {};
        // A forward the orchestrator received stays recorded as such; its re-sends are counted.
        if (prior?.decision === 'forward' && prior.sent) remember(memory, p.deliveryId, { ...prior, ...sends, resends: (prior.resends ?? 0) + 1, lastResendAt: nowIso });
        else if (result.decision === 'recheck') remember(memory, p.deliveryId, { decision: 'recheck', rule: result.rule, at: nowIso, delaySeconds: result.delaySeconds, sent: false, ...sends });
        else remember(memory, p.deliveryId, { decision: result.decision === 'absorb' ? 'absorb' : 'forward', rule: result.rule, at: nowIso, sent: false, ...sends, ...(prior?.decision === 'recheck' ? { recheckedAt: prior.at } : {}) });
        if (forwarding) {
          const unreported = Object.values(memory.pending).filter(row => isObject(row) && row.kind === 'delivery' && !coveredNow(row, memory, destinationOf(row, memory, sessionNow))).length;
          if (unreported >= maxUnreported) throw new Error(`the proxy already holds ${unreported} unconfirmed forwards nobody has been told about (its limit is ${maxUnreported}), so it refuses to record delivery ${p.deliveryId}: escalate them (TRIAGE --forwards --unconfirmed lists them) before it records more; the delivery stays unacknowledged`);
          memory.pending[result.sendId] = { kind: 'delivery', at: nowIso, deliveryId: p.deliveryId };
          boundPending(memory, { maxPending, sessionNow, nowMs, logPath });
        }
        if (result.decision === 'absorb') recordAbsorbed(memory, p.deliveryId, nowIso);
        // This forward reports the absorbed deliveries no other forward has claimed (dev.88).
        else if (forwarding && result.forward?.includes('Absorbed since the last forward:')) claimAbsorbed(memory, result.sendId);
        // The forward built in this run carries the moot escalations; they are not repeated.
        if (forwarding && mootLine(memory) && result.forward?.includes('Escalation notices now moot')) memory.mootEscalations = [];
      }
      const task = isObject(state?.task) && isRecordId(state.task.id) ? state.task : null;
      entry = { at: nowIso, decision: result.decision, rule: result.rule, deliveryId: isRecordId(p.deliveryId) ? p.deliveryId : null, kind: typeof p.kind === 'string' ? clip(p.kind, 20) : null, event: typeof p.event === 'string' ? clip(p.event, 40) : null,
        inboxId: isRecordId(p.inboxId) ? p.inboxId : null, version: Number.isSafeInteger(p.version) ? p.version : null, taskId: isRecordId(p.taskId) ? p.taskId : isRecordId(item?.taskId) ? item.taskId : task?.id ?? null, flowId: isRecordId(p.flowId) ? p.flowId : isRecordId(item?.flowId) ? item.flowId : null,
        title: item?.title ? clip(item.title, 120) : task?.title ? clip(task.title, 120) : null, reason: clip(result.reason, 300) };
    }
    if (reset) {
      result = { ...result, decision: 'forward', rule: 'state-reset', reason: `state reset; ${result.reason}`, actions: [], forward: resetNote(reset) + (result.forward ?? `This run's own decision was ${result.decision} (${result.rule}); nothing was acknowledged.`), ...(result.forwardTo ? {} : forwardTarget(null, memory, forwardTo)), sendId: result.sendId, delaySeconds: undefined };
    }
    // A forward with nothing of its own to commit (an unreadable payload, a reset) still gets a send ID, so it is counted.
    if (result.decision === 'forward' || result.decision === 'unsure') {
      if (!result.sendId) { result = { ...result, sendId: `notice:${nowIso}:${randomBytes(3).toString('hex')}` }; memory.pending[result.sendId] = { kind: 'notice', at: nowIso }; }
      result = { ...result, forward: capForward(withProvenance(result.forward, { proxyId: proxyId ?? memory.proxyThreadId, rule: result.rule, deliveryId, sendId: result.sendId, at: nowIso, logPath })) };
    }
    // The log records the effective forward with its send ID, so --verify finds it: the reset when
    // there was one, and the run's own decision when that was itself a forward.
    // Where the forward goes is recorded with it (dev.85, I5b): on the decision line, and in that
    // send attempt's pending row, so the --sent line for it repeats it. A later forward of the same
    // delivery is another attempt with its own row; it never changes this one's destination.
    const addressed = ['forward', 'unsure'].includes(result.decision) && result.sendId && isId(result.forwardTo) ? { forwardTo: result.forwardTo, forwardSource: result.forwardSource ?? null } : null;
    if (addressed && isObject(memory.pending[result.sendId])) Object.assign(memory.pending[result.sendId], addressed);
    // The pending row keeps the forward as sent, so a later run or a failed send can send it again
    // under the same send ID, and the thread it was decided for (dev.86, J7).
    const own = (result.decision === 'forward' || result.decision === 'unsure') && result.sendId && isObject(memory.pending[result.sendId]) ? memory.pending[result.sendId] : null;
    // It also keeps what the forward was about (item, version, event, title, task, flow), so a later
    // run can tell when its item has moved on and an escalation can name it (dev.87, K1).
    // The configured thread is kept with it: only that one, never one a later command names, counts as known (review P2-4).
    if (own) Object.assign(own, { forward: result.forward, rule: result.rule, decidedAt: nowIso, decidedFor: isId(result.forwardTo) ? result.forwardTo : null, configured: isId(forwardTo) ? forwardTo : null, readRevision, event: entry.event ?? null, sentTo: isId(result.forwardTo) ? [result.forwardTo] : [],
      ...Object.fromEntries(['inboxId', 'version', 'title', 'taskId', 'flowId'].filter(field => entry[field] !== undefined && entry[field] !== null).map(field => [field, entry[field]])) });
    if (['forward', 'unsure'].includes(entry.decision) && result.sendId) Object.assign(entry, { sendId: result.sendId }, addressed ?? {});
    // Then every earlier forward still unconfirmed. First those that no longer need a send: the
    // orchestrator recorded handling them, or their item moved on (dev.87, K1). The log is read only
    // when there are some. Then the rest are re-sent, oldest first (dev.86, J7).
    const entries = openSends(memory).some(([key]) => key !== result.sendId) ? readLog(logPath) : [];
    const closed = closeSends(memory, { entries, openItems, readRevision, nowMs, logPath, skip: result.sendId });
    const retries = dueResends(memory, { nowMs, skip: result.sendId, sessionNow, openItems, readRevision, proxyId: proxyId ?? memory.proxyThreadId, logPath });
    // A forward with no thread to go to is for the operator at once (through --escalate).
    const escalateDue = own && !isId(result.forwardTo) ? 'there is no orchestrator thread to send it to' : null;
    // The decision is recorded in two phases (dev.90; see recoverDecisions):
    //   1. the state, with this run's forward marked `undecided`;
    //   2. the decision line in the log;
    //   3. the state again, with the mark cleared.
    // A run that fails at 1 logs and sends nothing (dev.89 N2: the line used to come first, and a
    // failed state write left a logged forward no run ever sent, escalated or closed). One that fails
    // at 2 or 3 sends nothing either, and the next run logs the decision (or finds it logged) before
    // anything is sent again, so nothing is ever sent that --verify cannot find.
    if (own) Object.assign(own, { undecided: true, decision: result.decision });
    saveMemory(memoryPath, memory);
    if (reset) append(logPath, { at: nowIso, decision: 'state-reset', rule: 'state-reset', reason: `unreadable state kept at ${reset}`, ...(result.sendId ? { sendId: result.sendId } : {}), ...(addressed ?? {}) });
    append(logPath, entry);
    if (own) { delete own.undecided; saveMemory(memoryPath, memory); }
    const sending = result.forward && (result.decision === 'forward' || result.decision === 'unsure');
    return { retries, closed, ...(recovered.length ? { recovered } : {}), ...result, ...(sending ? { send: sendArgs(result.forwardTo, result.forward) } : {}), ...(sending && own && rereadOf(own) ? { reread: rereadOf(own) } : {}), ...(escalateDue ? { escalateDue } : {}), ...(removedWakeDirs ? { removedWakeDirs } : {}) };
  }, lock);
}
// --sent: the orchestrator thread received a forward. A delivery is marked sent; a timer finding
// or digest commits its baseline. Unknown IDs (for example one superseded by a newer run) are refused.
// `to` is the thread the proxy actually sent it to (the `threadId` of the `send` object it used).
// Overlapping runs can send one send ID to different threads (after a rebind), so the confirmation is
// credited to that thread, and only if the send ID was handed out for it (review P2-2 of 55fccf4);
// without `to` (a caller from before dev.87) it falls back to the last thread planned. `to` is
// checked on every path (re-check P2-2 of 2ca04f9): a send already confirmed is a no-op that changes
// nothing. A send with no recorded destination at all (state from before dev.85) is confirmed but
// credits no thread. Any other thread is refused, and the refusal says exactly what to run instead;
// it never asks for the forward to be sent again (dev.88, L1).
const destinationsOf = row => Array.isArray(row?.sentTo) ? row.sentTo.filter(isId) : [row?.forwardTo, row?.decidedFor].filter(isId);
export class Refused extends Error { constructor(message) { super(message); this.name = 'Refused'; } }
const refusal = (sendId, to, sentTo) => new Refused(`send ${sendId} was never handed out for thread ${to} (it was for ${sentTo.join(', ')}). Do not send it again. If you sent the send object as printed, run --sent ${sendId} --to <the threadId of that send object>. If you sent it to ${to}, the orchestrator session did not get it: run --send-failed ${sendId} --to ${to} --error 'sent to a thread that was not in the send object' and follow its next.`);
function creditedThread(key, row, to) {
  if (to === null || to === undefined) return isId(row?.forwardTo) ? row.forwardTo : null;
  if (!isId(to)) throw new Error('--to must be the threadId of the send object you used');
  const sentTo = destinationsOf(row);
  if (!sentTo.length) return null;
  if (sentTo.includes(to)) return to;
  throw refusal(key, to, sentTo);
}
// The delivery a send ID belongs to: the ID itself (a delivery ID, as before dev.85) or `<deliveryId>:<n>`.
const deliveryOfSend = (memory, sendId) => isObject(memory.deliveries?.[sendId]) ? sendId : /:\d+$/.test(sendId) && isObject(memory.deliveries?.[sendId.replace(/:\d+$/, '')]) ? sendId.replace(/:\d+$/, '') : null;
export function confirmSent(sendId, { memoryPath, logPath, to = null, nowMs = Date.now(), lock = {} }) {
  return withLock(logPath, () => {
    const { memory } = loadMemory(memoryPath, { logPath, nowMs }), nowIso = new Date(nowMs).toISOString(), pending = isObject(memory.pending) ? memory.pending : {};
    // A delivery ID given as the send ID (as before dev.85, when they were the same) confirms that
    // delivery's most recent send attempt.
    const latest = !pending[sendId] && isObject(memory.deliveries?.[sendId]) ? memory.deliveries[sendId].lastSendId : null;
    const key = pending[sendId] ? sendId : isObject(pending[latest]) ? latest : null;
    if (!key) {
      // Nothing pending under this ID. A delivery already confirmed: a no-op, nothing written, and
      // only for a thread it was sent to.
      const id = deliveryOfSend(memory, sendId), done = id ? memory.deliveries[id] : null;
      if (done?.decision === 'forward' && done.sent === true) {
        if (to !== null && to !== undefined) creditedThread(sendId, done, to);
        return { recorded: 'already-sent', sendId, note: `confirmed sent at ${done.sentAt ?? 'an earlier time'}; nothing changed` };
      }
    }
    let reached = null;
    if (key && pending[key].kind !== 'delivery') {
      const row = pending[key]; reached = creditedThread(key, row, to);
      if (row.kind === 'timer' && row.timer) memory.timer = row.timer;
      if (row.kind === 'digest') { memory.lastDigestAt = row.until; memory.lastDigestLine = row.line; }
      delete pending[key]; memory.pending = pending;
      append(logPath, { at: nowIso, decision: 'sent', what: row.kind, sendId: key, ...(isId(reached) ? { forwardTo: reached } : {}) });
    } else {
      // A delivery: the attempt's own row says where it went; a state file from before dev.85 has none.
      const attempt = key ? pending[key] : null, id = attempt?.deliveryId ?? sendId;
      const row = isObject(memory.deliveries?.[id]) ? memory.deliveries[id] : null;
      if (row?.decision !== 'forward') throw new Error('no pending forward with that send ID');
      reached = creditedThread(key ?? id, attempt ?? row, to);
      // The delivery keeps every thread its attempts were sent to, so a repeated --sent can be checked.
      const sentTo = [...new Set([...destinationsOf(row), ...destinationsOf(attempt)])].slice(-50);
      remember(memory, id, { ...row, decision: 'forward', sent: true, sentAt: row.sentAt ?? nowIso, lastSentAt: nowIso, ...(sentTo.length ? { sentTo } : {}) });
      if (key) { delete pending[key]; memory.pending = pending; settleAbsorbed(memory, key, true); }
      // Every other pending attempt of this delivery is closed as delivered (review P2-1 of 44a3127):
      // the orchestrator has the delivery, so none of them is sent again or escalated.
      for (const [other, otherRow] of Object.entries(pending)) if (isObject(otherRow) && otherRow.kind === 'delivery' && otherRow.deliveryId === id) closeSend(memory, other, otherRow, 'delivered', `another send of delivery ${id} (${key ?? id}) was confirmed at ${nowIso}`, { nowMs, logPath });
      append(logPath, { at: nowIso, decision: 'sent', what: 'delivery', deliveryId: id, ...(key ? { sendId: key } : {}), ...(isId(reached) ? { forwardTo: reached } : {}) });
    }
    // A send reached that thread: its outage is over, and its notice moot (said once by the next forward).
    if (isId(reached)) { endOutage(memory, reached, `a send to ${reached} was confirmed at ${nowIso}`, nowIso); endOutage(memory, null, `a send to ${reached} was confirmed at ${nowIso}`, nowIso); }
    saveMemory(memoryPath, memory);
    return { recorded: 'sent', sendId: key ?? sendId, ...(isId(reached) ? { to: reached } : {}) };
  }, lock);
}

// The pending row a send ID names: the send ID itself, or (as for --sent) a delivery ID naming its newest attempt.
function pendingKey(memory, sendId) {
  const pending = isObject(memory.pending) ? memory.pending : {};
  if (isObject(pending[sendId])) return sendId;
  const latest = isObject(memory.deliveries?.[sendId]) ? memory.deliveries[sendId].lastSendId : null;
  return latest && isObject(pending[latest]) ? latest : null;
}
// --send-failed: t3_thread_send failed for this send ID (dev.86, J7). Records the failure against
// the thread it was sent to and returns `next`: the same send once more (the thread is often fine
// and the arguments were not), until the destination is down for it; then `next.send` is null and
// `escalateDue` says why, and later runs send it again. `read` is a fresh `status --inbox` read of
// the item, taken after the failure (the step's `reread`): an attention forward whose item is no
// longer open, or open at a newer version, is closed as obsolete instead (`closed`, `next: null`);
// without such a read it is not sent again in this run. A `to` the send ID was not handed out for
// is recorded as a misdirected send, credited to no thread (dev.88, L1). Never acknowledges anything.
export function sendFailed(sendId, { memoryPath, logPath, error = '', to = null, proxyId = null, read = undefined, nowMs = Date.now(), lock = {} }) {
  return withLock(logPath, () => {
    const { memory } = loadMemory(memoryPath, { logPath, nowMs }), nowIso = new Date(nowMs).toISOString(), key = pendingKey(memory, sendId);
    if (!key) throw new Error('no pending forward with that send ID (it may have been confirmed already)');
    // The failure is the thread the proxy actually used (`to`, review P2-2), not wherever another run moved the send since.
    const row = memory.pending[key], sentTo = destinationsOf(row);
    const misdirected = isId(to) && sentTo.length > 0 && !sentTo.includes(to) ? to : null;
    const failedTo = misdirected ? null : creditedThread(key, row, to), thread = isId(failedTo) ? failedTo : '(none)';
    if (!row.hydrated && (row.event === undefined || !row.rule)) hydrate(key, row, readLog(logPath));
    if (!misdirected) row.failedBy = { ...(isObject(row.failedBy) ? row.failedBy : {}), [thread]: failuresFor(row, thread) + 1 };
    Object.assign(row, { failures: (row.failures ?? 0) + 1, lastError: clip(error || 'not given', 300), lastFailedAt: nowIso });
    // Failures per thread across forwards (dev.87, K5).
    if (isId(failedTo)) {
      const seen = isObject(memory.failedThreads?.[failedTo]) ? memory.failedThreads[failedTo] : {};
      memory.failedThreads = { ...(isObject(memory.failedThreads) ? memory.failedThreads : {}), [failedTo]: { failures: (seen.failures ?? 0) + 1, lastError: row.lastError, at: nowIso } };
    }
    append(logPath, { at: nowIso, decision: 'send-failed', sendId: key, deliveryId: row.deliveryId ?? null, forwardTo: isId(failedTo) ? failedTo : null, ...(misdirected ? { misdirected } : {}), error: row.lastError });
    const out = nextSend(memory, key, row, { read, nowMs, failedTo: failedTo ?? null, proxyId, logPath });
    saveMemory(memoryPath, memory);
    return { recorded: 'send-failed', sendId: key, failures: row.failures, ...(misdirected ? { misdirected } : {}), ...out };
  }, lock);
}
// What to send next after a failed send: closed when another send of its delivery was confirmed or
// the fresh read shows its item moved on; nothing in this run without a fresh read of an attention
// forward; otherwise planSend's step.
function nextSend(memory, key, row, { read, nowMs, failedTo, proxyId, logPath }) {
  const nowIso = new Date(nowMs).toISOString(), elsewhere = deliveredElsewhere(memory, row);
  if (elsewhere) return { closed: closeSend(memory, key, row, 'delivered', elsewhere, { nowMs, logPath }), next: null };
  const openItems = read === undefined ? null : openItemsOf(read), sessionNow = openItems && sessionOf(read) ? observeSession(memory, read, nowIso) : null;
  const obsolete = openItems ? obsoleteBy(row, openItems, Number.isSafeInteger(read?.revision) ? read.revision : null) : null;
  if (obsolete) return { closed: closeSend(memory, key, row, 'obsolete', obsolete, { nowMs, logPath }), next: null };
  const unread = needsRead(row) && !openItems;
  const next = planSend(key, row, memory, { nowMs, sessionNow, failedTo, send: !unread, proxyId: proxyId ?? memory.proxyThreadId, logPath: resolve(logPath) });
  if (next?.send) append(logPath, retryLine(key, row, next, nowIso));
  return { ...(unread ? { note: `not sent again in this run: the item was not read again (run status ${rereadOf(row)} and pass it with --state); a later run reads it and sends it` } : {}), next };
}
// A forward joins the verified notice of its destination's current outage: its own diagnostic record.
function cover(memory, key, row, outage, nowIso, logPath) {
  Object.assign(row, { toldIn: outage.id, escalatedAt: nowIso, escalationNotice: outage.noticeId });
  if (!outage.sendIds.includes(key)) outage.sendIds.push(key);
  append(logPath, { at: nowIso, decision: 'escalation-covered', sendId: key, deliveryId: row.deliveryId ?? null, inboxId: outage.noticeId });
}
// --escalate: the operator notice for an unconfirmed forward, asked for after this run's sends are
// recorded. It checks again, under the lock, that the forward is still pending (not confirmed, not
// closed, no other send of its delivery confirmed: review P2-1 of 44a3127), not covered by its
// destination's current outage notice, and that an escalation is due now; only then does it print
// `escalate` (dev.87, K1: two forwards confirmed sent were escalated 10 and 21 seconds later,
// because the notice was decided in the run that re-sent them). Otherwise `escalate` is null, with
// the reason. One notice per outage (dev.88): a forward whose destination's outage already has a
// verified notice is covered by it (`coveredBy`); one whose outage has a notice offered and not yet
// verified gets that same notice; otherwise a new notice lists every forward to that destination
// due now.
export function escalateNow(sendId, { memoryPath, logPath, nowMs = Date.now(), lock = {} }) {
  return withLock(logPath, () => {
    const { memory } = loadMemory(memoryPath, { logPath, nowMs }), nowIso = new Date(nowMs).toISOString(), key = pendingKey(memory, sendId), row = key ? memory.pending[key] : null;
    if (!row) return { sendId, escalate: null, reason: 'no pending forward with that send ID: it was confirmed sent or closed, so there is nothing to tell the operator' };
    const elsewhere = deliveredElsewhere(memory, row);
    if (elsewhere) { const closed = closeSend(memory, key, row, 'delivered', elsewhere, { nowMs, logPath }); saveMemory(memoryPath, memory); return { sendId: key, escalate: null, closed, reason: `${elsewhere}: the orchestrator has it, so there is nothing to tell the operator` }; }
    if (!row.hydrated && (row.event === undefined || !row.rule)) hydrate(key, row, readLog(logPath));
    const { dest, why } = dueNow(row, memory, nowMs);
    if (coveredNow(row, memory, dest)) return { sendId: key, escalate: null, reason: `already escalated for this outage (notice ${row.escalationNotice})` };
    if (!why) { saveMemory(memoryPath, memory); return { sendId: key, escalate: null, reason: 'not due: the destination is not down for it and it is not yet old enough to escalate' }; }
    const outage = currentOutage(memory, dest, nowIso);
    if (outage.status === 'published') {
      cover(memory, key, row, outage, nowIso, logPath); saveMemory(memoryPath, memory);
      return { sendId: key, escalate: null, coveredBy: outage.noticeId, reason: `covered by notice ${outage.noticeId}, already published for this outage: nothing more to publish` };
    }
    if (outage.status === 'offered') {
      if (!outage.sendIds.includes(key)) outage.sendIds.push(key);
      saveMemory(memoryPath, memory);
      return { sendId: key, escalate: outage.escalation, reason: why };
    }
    const others = openSends(memory).filter(([other, r]) => other !== key && !deliveredElsewhere(memory, r))
      .map(([other, r]) => [other, r, dueNow(r, memory, nowMs)]).filter(([, r, d]) => d.why && d.dest === dest && !coveredNow(r, memory, dest)).slice(0, 19).map(([other, r, d]) => [other, r, d.why]);
    const offered = escalation(key, row, why, others);
    Object.assign(outage, { status: 'offered', noticeId: offered.payload.id, escalation: offered, offeredAt: nowIso, sendIds: [key, ...others.map(([other]) => other)] });
    saveMemory(memoryPath, memory);
    return { sendId: key, escalate: offered, reason: why, ...(others.length ? { covers: others.map(([other]) => other) } : {}) };
  }, lock);
}
// --escalated: after publishing the operator notice (or being told its ID exists), the proxy reads
// it back with status --inbox and passes that read. Only the notice offered counts: the ID, a
// notice, published by the orchestrator role, with exactly the title and context offered (review
// fix P2-3). Then every pending forward it lists is covered for that outage (`covers`). A notice
// whose outage ended before its read-back covers nothing, and is reported moot (third re-check of
// 0933596: it used to restore coverage). Anything else (an unrelated item under that ID, or no
// item) is not success: a notice that is missing is offered again as it was; one whose ID another
// item holds is offered again under a new ID, and it says so.
export function noticeMatches(read, payload) {
  const item = isObject(read?.item) ? read.item : null;
  return Boolean(item && isObject(payload) && item.id === payload.id && item.kind === 'notice' && item.createdBy === 'orchestrator' && item.title === payload.title && item.context === payload.context);
}
export function markEscalated(sendId, { memoryPath, logPath, read, nowMs = Date.now(), lock = {} }) {
  return withLock(logPath, () => {
    const { memory } = loadMemory(memoryPath, { logPath, nowMs }), nowIso = new Date(nowMs).toISOString(), key = pendingKey(memory, sendId), id = key ?? sendId;
    const row = key ? memory.pending[key] : null, item = isObject(read?.item) ? read.item : null;
    // The read-back names a notice: find the outage that notice belongs to first, current or ended, and
    // only then fall back to the send ID (a notice that was not found at all). A forward can be listed
    // by an ended outage's notice and by its current outage's (review of 615f5a5, P3: a late read-back
    // of the old notice was taken for the new one, reported missing, and never announced as moot).
    const currentOutages = Object.values(outagesOf(memory)).filter(o => isObject(o) && o.status !== 'none'), endedList = Array.isArray(memory.endedNotices) ? memory.endedNotices.filter(isObject) : [];
    const byNotice = item ? { outage: currentOutages.find(o => o.noticeId === item.id) ?? null, ended: endedList.find(n => n.noticeId === item.id) ?? null } : { outage: null, ended: null };
    const outage = byNotice.outage ?? (byNotice.ended ? null : currentOutages.find(o => Array.isArray(o.sendIds) && o.sendIds.includes(id)) ?? null);
    const ended = outage ? null : byNotice.ended ?? endedList.find(n => n.sendIds?.includes(id)) ?? null;
    if (ended) {
      const matched = noticeMatches(read, ended.payload);
      if (matched) {
        memory.endedNotices = memory.endedNotices.filter(n => n !== ended);
        noteMoot(memory, ended.noticeId, `its outage had ended before it was published (${ended.why})`);
      }
      append(logPath, { at: nowIso, decision: 'escalated', sendId: id, deliveryId: row?.deliveryId ?? null, inboxId: ended.noticeId, note: 'its outage had ended: it covers nothing' });
      saveMemory(memoryPath, memory);
      return { recorded: 'escalated', sendId: id, inboxId: matched ? ended.noticeId : null, covers: [], note: 'the outage it was about ended before its read-back: it covers nothing, stays for the operator to dismiss, and the next forward says it is moot' };
    }
    if (!outage) {
      // Confirmed or closed meanwhile, or never offered: nothing to mark; the log says so.
      append(logPath, { at: nowIso, decision: 'escalated', sendId: id, deliveryId: row?.deliveryId ?? null, inboxId: item ? item.id ?? null : null, note: row ? 'no escalation was offered' : 'no pending forward' });
      return { recorded: 'escalated', sendId: id, inboxId: null, note: row ? 'no escalation was offered for this send ID' : 'no pending forward with that send ID (it may have been confirmed); the notice stays for the operator to dismiss' };
    }
    if (outage.status === 'published') return { recorded: 'escalated', sendId: id, inboxId: outage.noticeId, note: 'already recorded' };
    if (noticeMatches(read, outage.escalation?.payload)) {
      const covers = outage.sendIds.filter(other => isObject(memory.pending[other]));
      append(logPath, { at: nowIso, decision: 'escalated', sendId: id, deliveryId: row?.deliveryId ?? null, inboxId: outage.noticeId, covers });
      if (!covers.length) {
        // Every forward it lists was confirmed or closed before the notice was published: it is moot already.
        noteMoot(memory, outage.noticeId, 'every forward it covers was delivered or closed before it was published');
        Object.assign(outage, { status: 'none', sendIds: [], noticeId: undefined, escalation: undefined });
        saveMemory(memoryPath, memory);
        return { recorded: 'escalated', sendId: id, inboxId: outage.noticeId ?? item?.id ?? null, covers, note: 'no pending forward with that send ID (it may have been confirmed); the notice stays for the operator to dismiss, and the next forward says it is moot' };
      }
      Object.assign(outage, { status: 'published', publishedAt: nowIso });
      for (const other of covers) Object.assign(memory.pending[other], { toldIn: outage.id, escalatedAt: nowIso, escalationNotice: outage.noticeId });
      saveMemory(memoryPath, memory);
      return { recorded: 'escalated', sendId: id, inboxId: outage.noticeId, covers };
    }
    const taken = item?.id === outage.escalation.payload.id, was = outage.escalation.payload.id;
    if (taken) { outage.escalation = { ...outage.escalation, payload: { ...outage.escalation.payload, id: escalationId(outage.sendIds[0]) } }; outage.noticeId = outage.escalation.payload.id; }
    append(logPath, { at: nowIso, decision: 'escalation-retry', sendId: id, deliveryId: row?.deliveryId ?? null, inboxId: was, note: taken ? `another item holds ${was}; offered again as ${outage.noticeId}` : `${was} was not found; offered again` });
    saveMemory(memoryPath, memory);
    return { recorded: 'not-escalated', sendId: id, reason: taken ? `inbox item ${was} is not this notice (another item holds the ID); publish the notice under its new ID` : `inbox item ${was} was not found; publish the notice again`, escalate: outage.escalation };
  }, lock);
}
// ---- command line --------------------------------------------------------------------------
export const USAGE = `Triage rules for a T3 triage proxy thread. Each command below prints one JSON object.
  Decide one wake (stdin: the webhook payload):
    triage.mjs --project <projectId> --state <narrow-read.json> --memory <state.json> --log <log.jsonl> [--forward-to <thread id>] [--proxy-id <thread id>] [--read-error '<why the read failed>']
  Every wake, timer and digest run prints "send" (the t3_thread_send arguments, passed as they are) for its own forward,
  "retries": earlier forwards not confirmed sent, each with its own "send" and sometimes "escalateDue";
  and "closed": earlier forwards closed without a send (item no longer open, or handled).
  Timer check (stdin: status --compact):  triage.mjs --timer [--stall-minutes 120] [--idle-minutes 10] --memory … --log …
  Digest of what was absorbed:            triage.mjs --digest [--state <status --compact read>] --memory … --log …
  Every command needs --protocol ${PROTOCOL}, the version of the brief and handling guide it was written for.
  A wake, timer or digest run that cannot complete (or a protocol mismatch) publishes an operator notice through Factotum's CLI:
  pass --factory-state <Factotum state dir> (and --factory-cli <cli.mjs> if it is not ../../factory/cli.mjs from this script); without it, or if
  the publish fails, the command prints why on stderr and exits nonzero.
  Confirm a forward was sent:             triage.mjs --sent <sendId> --to <send.threadId> --memory … --log …
  A send failed (prints next):            triage.mjs --send-failed <sendId> --to <send.threadId> --error '<the error>' [--state <status reread>] --memory … --log …
                                          (a step with "reread": read the item again first, status <reread>, and pass it with --state)
  Escalate, after the run's sends:        triage.mjs --escalate <sendId> --memory … --log …   (prints the notice, or null if it was confirmed or closed meanwhile)
  The operator notice was published:      triage.mjs --escalated <sendId> --state <status --inbox read of the notice> --memory … --log …   (prints "covers")
  Absorb an unsure delivery on judgement: triage.mjs --judged-absorb <deliveryId> --note '<why>' --memory … --log …
  Record this proxy's thread ID (setup):  triage.mjs --set-proxy-id <thread id> --memory … --log …
  Orchestrator, with --log only:
    --counts [--since <ISO time>]                      forwarded, unconfirmed, absorbed, unsure, rechecks, missed, undelivered, received, lookups, send failures, escalations, obsolete, handled, timer runs, per rule
    --missed --kind absorbed|lookup|undelivered|received --note '<what>' [--ref <id> --for <your thread id>]   absorbed: the proxy absorbed something you needed; lookup: a forward lacked something you had to read; undelivered: a forward addressed to you never reached you (you handled it from state); received: a forward reached you that the proxy lists as unconfirmed. With --ref, undelivered and received close the forward.
    --correct <at of an earlier entry> --note '<correction>'      the log is append-only; this records a correction beside it
    --verify <sendId>                                  is this forward in the proxy's log, was it confirmed sent, and to which thread?
    --forwards [--since <ISO time>]                    every confirmed forward, with its rule, delivery and the thread it was sent to (forwardTo)
    --forwards --unconfirmed [--since <ISO time>] [--for <thread id>]   every forward decided and never confirmed sent, with its re-sends, failures, escalation, where its latest send went and whether it may still be in progress; --for: only those addressed to that thread
    --absorbed [--since <ISO time>]                    every delivery absorbed, with its rule and item
  --help prints this.`;
const FLAGS = ['timer', 'digest', 'counts', 'missed', 'forwards', 'unconfirmed', 'absorbed', 'help'];
function argsOf(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (FLAGS.includes(key)) out[key] = true;
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`--${key} needs a value`);
    else out[key] = argv[++i];
  }
  return out;
}
const positive = (value, fallback) => { const n = Number(value ?? fallback); return Number.isSafeInteger(n) && n > 0 ? n : fallback; };
async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(`${USAGE}\n`); return; }
  const a = argsOf(argv); resetOptions = { factoryState: a['factory-state'], cli: a['factory-cli'] };
  const out = value => process.stdout.write(`${JSON.stringify(value, null, 1)}\n`);
  // Any command that reset the state file publishes one operator notice per reset, and its output names it (dev.88 M4).
  const print = value => { const notices = stateResets.length ? reportResets(resetOptions) : []; out(notices.length && isObject(value) ? { ...value, stateResetNotice: notices } : value); };
  const stdin = async () => { let text = ''; for await (const chunk of process.stdin) text += chunk; return text; };
  // The protocol check comes first (review of dev.87). A wake, timer or digest run still prints a
  // forward, so the orchestrator hears of it even through an old brief; any other command fails.
  if (String(a.protocol ?? '') !== String(PROTOCOL)) {
    const why = `this triage.mjs expects protocol ${PROTOCOL} but was called with ${a.protocol === undefined ? 'no --protocol' : `--protocol ${clip(a.protocol, 20)}`}: copy the brief and handling guide again (t3-triage.md and t3-notifications.md from the templates of the release that has this script), so their TRIAGE shorthands pass --protocol ${PROTOCOL}`;
    const run = Boolean(a.memory) && !['sent', 'send-failed', 'escalate', 'escalated', 'judged-absorb', 'set-proxy-id', 'missed', 'correct', 'verify', 'forwards', 'absorbed', 'counts'].some(k => a[k] !== undefined);
    if (!run) throw new Error(why);
    const forward = `[Factotum via triage] The triage proxy cannot run: ${why}. Nothing was decided, acknowledged or recorded; handle this wake from the inbox, and have the guides copied again.\nProvenance: none recorded (the run stopped before reading or writing anything).`, target = knownTarget(a.memory, a['forward-to'] ?? null);
    process.stderr.write(`triage: ${why}\n`); process.exitCode = 1;
    if (!target.forwardTo) process.stderr.write('triage: no orchestrator thread is known for this message (the state file cannot be read)\n');
    const kind = a.timer ? 'timer' : a.digest ? 'digest' : 'wake', failed = reportFailure({ kind, input: kind === 'wake' ? await stdin() : '', error: why, protocol: true, factoryState: a['factory-state'], cli: a['factory-cli'], statePath: a.state, logPath: a.log });
    process.exitCode = 1;
    if (failed.absorbed) return print({ retries: [], closed: [], ...failed.absorbed, forward: null, forwardTo: null, forwardSource: null, sendId: null, send: null });
    return print({ retries: [], closed: [], decision: 'forward', rule: 'protocol-mismatch', reason: why, actions: [], forward, ...target, sendId: null, send: sendArgs(target.forwardTo, forward), operatorNotice: failed.notice });
  }
  // Commands that read only the log settle undecided decisions first when they know the state (re-check of 766c23e).
  if (a.memory && a.log && ['counts', 'verify', 'forwards', 'absorbed', 'missed', 'correct'].some(k => a[k] !== undefined)) settleState(a.memory, a.log);
  if (a.counts) return print(counts(readLog(a.log), a.since ?? null));
  if (!a.log) throw new Error('--log is required (see --help)');
  if (a.verify) return print(verifyForward(readLog(a.log), a.verify));
  if (a.for !== undefined && !isId(a.for)) throw new Error('--for is a thread ID: letters, digits and -:._');
  if (a.forwards) return print(a.unconfirmed ? unconfirmedForwards(readLog(a.log), a.since ?? null, { forThread: a.for ?? null }) : forwardsSince(readLog(a.log), a.since ?? null));
  if (a.absorbed) return print(absorbedSince(readLog(a.log), a.since ?? null));
  const note = () => { if (typeof a.note !== 'string' || !a.note.trim()) throw new Error('--note is required and may not be empty: say what was missing or what the correction is'); return a.note; };
  if (a.missed) {
    const kind = a.kind ?? 'absorbed';
    if (!['absorbed', 'lookup', 'undelivered', 'received'].includes(kind)) throw new Error('--kind is absorbed, lookup, undelivered or received');
    if (kind === 'received' && a.ref === undefined) throw new Error('--kind received needs --ref <sendId> and --for <your thread id>');
    const text = note();
    return print(withLock(a.log, () => {
      const row = missedRefCheck(readLog(a.log), { kind, ref: a.ref, forThread: a.for ?? null });
      append(a.log, { at: new Date().toISOString(), decision: 'missed', kind, ref: a.ref ?? null, ...(row ? { by: a.for, closes: row.sendId } : {}), note: clip(text, 500) });
      return { recorded: 'missed', kind, ...(row ? { closes: row.sendId, note: 'the proxy closes it at its next run and does not send it again' } : {}) };
    }));
  }
  if (a.correct) {
    note();
    if (!readLog(a.log).some(e => isObject(e) && e.at === a.correct)) throw new Error('no log entry at that time');
    return print(withLock(a.log, () => { append(a.log, { at: new Date().toISOString(), decision: 'correction', corrects: a.correct, note: clip(a.note, 500) }); return { recorded: 'correction', corrects: a.correct }; }));
  }
  if (!a.memory) throw new Error('--memory is required (see --help)');
  if (a['set-proxy-id']) {
    if (!isId(a['set-proxy-id'])) throw new Error('the thread ID may contain only letters, digits and -:._');
    return print(withLock(a.log, () => {
      const { memory } = loadMemory(a.memory, { logPath: a.log }); memory.proxyThreadId = a['set-proxy-id']; saveMemory(a.memory, memory);
      append(a.log, { at: new Date().toISOString(), decision: 'proxy-id', proxyThreadId: a['set-proxy-id'] });
      return { recorded: 'proxy-id', proxyThreadId: a['set-proxy-id'] };
    }));
  }
  // The thread actually used is required: it is credited with the confirmation or the failure (review P2-2).
  const usedThread = () => { if (!isId(a.to)) throw new Error('--to is required: the threadId of the send object you passed to t3_thread_send'); return a.to; };
  if (a.sent) return print(confirmSent(a.sent, { memoryPath: a.memory, logPath: a.log, to: usedThread() }));
  if (a.escalate) return print(escalateNow(a.escalate, { memoryPath: a.memory, logPath: a.log }));
  let read; if (a.state !== undefined) { try { read = JSON.parse(readFileSync(a.state, 'utf8')); } catch { read = null; } }
  if (a['send-failed']) {
    return print(sendFailed(a['send-failed'], { memoryPath: a.memory, logPath: a.log, to: usedThread(), error: a.error ?? '', proxyId: a['proxy-id'] ?? null, read }));
  }
  if (a.escalated) {
    if (!a.state) throw new Error('--escalated needs --state: the status --inbox read of the notice, so the script can check it is the notice it asked for');
    let read = null; try { read = JSON.parse(readFileSync(a.state, 'utf8')); } catch { read = null; }
    return print(markEscalated(a.escalated, { memoryPath: a.memory, logPath: a.log, read }));
  }
  if (a['judged-absorb']) return print(withLock(a.log, () => {
    const { memory } = loadMemory(a.memory, { logPath: a.log }), id = a['judged-absorb'], row = isObject(memory.deliveries?.[id]) ? memory.deliveries[id] : null;
    if (!row || row.rule !== 'state-event-no-rule') throw new Error('only an unsure delivery can be absorbed on judgement');
    remember(memory, id, { ...row, decision: 'absorb', rule: 'judged' }); recordAbsorbed(memory, id, new Date().toISOString());
    // Its forwards are dropped; what they claimed in the absorbed ledger goes back to the next forward (re-check of c95fdde, P3).
    for (const [key, pendingRow] of Object.entries(isObject(memory.pending) ? memory.pending : {})) if (pendingRow?.kind === 'delivery' && pendingRow.deliveryId === id) { settleAbsorbed(memory, key, false); delete memory.pending[key]; }
    append(a.log, { at: new Date().toISOString(), decision: 'absorb', rule: 'judged', deliveryId: id, reason: clip(a.note, 300) }); saveMemory(a.memory, memory);
    return { recorded: 'judged-absorb' };
  }));
  const kind = a.timer ? 'timer' : a.digest ? 'digest' : 'wake', input = kind === 'digest' ? '' : await stdin();
  // A wake, timer or digest run always prints a decision: on any failure, forward with no actions.
  try {
    print(runRecorded(kind, { memoryPath: a.memory, logPath: a.log, input, statePath: a.state ?? null, projectId: a.project ?? null, forwardTo: a['forward-to'] ?? null, proxyId: a['proxy-id'] ?? null,
      stallMinutes: positive(a['stall-minutes'], STALL_MINUTES), idleMinutes: positive(a['idle-minutes'], IDLE_MINUTES), reforwardEvery: positive(a['reforward-every'], REFORWARD_EVERY), readError: a['read-error'] ?? null }));
  } catch (error) {
    const forward = `[Factotum via triage] Triage could not complete a ${kind} run (${clip(error?.message, 200)}). Nothing was acknowledged or recorded; handle it from the inbox.\nProvenance: none recorded (the run failed before writing the log).`, target = knownTarget(a.memory, a['forward-to'] ?? null);
    process.stderr.write(`triage: the ${kind} run failed: ${clip(error?.message, 300)}${target.forwardTo ? '' : '; no orchestrator thread is known for this message (the state file cannot be read)'}\n`);
    const failed = reportFailure({ kind, input, error: error?.message ?? String(error), factoryState: a['factory-state'], cli: a['factory-cli'], statePath: a.state, logPath: a.log });
    if (failed.absorbed) print({ retries: [], closed: [], ...failed.absorbed, forward: null, forwardTo: null, forwardSource: null, sendId: null, send: null });
    else print({ retries: [], closed: [], decision: 'forward', rule: 'triage-error', reason: clip(error?.message, 200), actions: [], forward, ...target, sendId: null, send: sendArgs(target.forwardTo, forward), operatorNotice: failed.notice });
  }
}
// A command that fails after resetting the state file still publishes the reset's notice (dev.88 M4).
let resetOptions = null;
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main().catch(error => { process.stderr.write(`triage: ${error.message}\n`); if (stateResets.length && resetOptions) reportResets(resetOptions); process.exit(1); });
