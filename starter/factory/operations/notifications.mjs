import { readFileSync, statSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { assert, digest } from '../core/contracts.mjs';
import { inboxVersions } from '../core/records.mjs';
import { unresolvedTaskDecisions } from '../core/decisions.mjs';
import { claimSessionSendInTransaction, countSessionDeliveryInTransaction } from './orchestrator-session.mjs';
// Problems are described without the file's path or contents: the path is private and the
// contents hold the endpoint and signing key (a JSON parse error would quote them).
export function readDeliveryConfig(path) {
  let stat;
  try { stat = statSync(path); } catch (error) { throw new Error(error.code === 'ENOENT' ? 'notification configuration file not found at notifications.configPath' : `notification configuration file cannot be read (${error.code ?? 'error'})`); }
  assert(stat.isFile() && (stat.mode & 0o777) === 0o600, 'notification configuration must be a private 0600 file');
  let config, url;
  try { config = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { throw new Error(error.code ? `notification configuration file cannot be read (${error.code})` : 'notification configuration file is not valid JSON'); }
  try { url = new URL(config?.url); } catch { throw new Error('notification configuration needs a valid url'); }
  assert(url.protocol === 'https:' && !url.username && !url.password, 'notification URL must use HTTPS without credentials');
  // A signing key, when present, must be a non-empty string (never echoed in errors).
  assert(config.signingKey === undefined || typeof config.signingKey === 'string' && config.signingKey.length > 0, 'notification signingKey must be a non-empty string');
  return config;
}
// Notification delivery is an optional integration: a problem with its configuration file
// pauses delivery and is recorded once (meta notificationHealth, event notification.paused),
// never a recovery hold or a stopped flow. Deliveries stay queued; the first tick that reads
// a valid file clears the problem (event notification.resumed) and sends them.
export const notificationHealth = store => store.meta('notificationHealth', null) ?? null;
function recordDeliveryProblem(store, problem, nowMs) {
  store.tx(() => {
    const prior = notificationHealth(store);
    if (prior?.status === 'paused' && prior.problem === problem) return;
    store.setMeta('notificationHealth', { status: 'paused', problem, since: prior?.status === 'paused' ? prior.since : new Date(nowMs).toISOString(), changedAt: new Date(nowMs).toISOString() });
    store.event('notification.paused', { problem });
  });
}
function recordDeliveryHealthy(store, nowMs) {
  if (notificationHealth(store)?.status !== 'paused') return;
  store.tx(() => {
    const prior = notificationHealth(store); if (prior?.status !== 'paused') return;
    store.setMeta('notificationHealth', null);
    store.event('notification.resumed', { problem: prior.problem, pausedSince: prior.since, resumedAt: new Date(nowMs).toISOString() });
  });
}
// For doctor: the same check the delivery loop makes, as a warning (it never blocks qualification).
export function notificationConfigWarnings(config) {
  const path = config?.notifications?.configPath; if (!path) return [];
  try { readDeliveryConfig(path); return []; }
  catch (error) { return [`notification delivery is paused: ${error.message}. Work is not affected; delivery resumes by itself once the file is valid`]; }
}
// essential (default): wake for questions, notices, approval changes and one terminal
// notice per flow, never for the consumer's own actions. all: every event.
// actionable: essential routing, without proven routine successful terminal summaries.
export const notificationLevel = config => config?.notifications?.level ?? 'essential';
// Conservative attention check: successful execution is not proof that follow-up
// work was fulfilled. Keep result-declared material even when another step passed.
// A must-fix flow (review-must-fix design 12.2; test fixtures only until the enabling release) reads
// its stored ledger: any operator item, follow-up, deferral or operator disposition, any acknowledged finding
// and any refused decision makes it non-routine, as unresolved history does today. A severity or
// shadow flow never reaches it.
function mustFixAttention(flow) {
  if (flow.reviewBar !== 'must-fix') return false;
  // The ledger the engine stores with each review (equal to a recomputation); one it could not build is attention.
  const ledger = flow.reviewLedger;
  if (ledger?.error) return true;
  return (Array.isArray(ledger?.entries) ? ledger.entries : []).some(entry => (entry.kind !== 'must-fix' && entry.status !== 'superseded') || entry.deferral || (entry.operatorDispositions?.length ?? 0) > 0)
    || (flow.operatorFindingDispositions?.length ?? 0) > 0 || (flow.reviewRowOverflow?.count ?? 0) > 0 || (flow.refusedDecisions?.length ?? 0) > 0
    || (flow.mergeAuthorization?.acknowledgedFindings?.length ?? 0) > 0 || (flow.completionDecision?.acknowledgedFindings?.length ?? 0) > 0;
}
export function flowNeedsAttention(store, flow, outcome, reason = '') {
  const fulfilled = obligation => {
    const canonical = obligation.id ? store.get('obligation', obligation.id) : null;
    return canonical?.flowId === flow.id && canonical.status === 'passed' && Boolean(canonical.evidence);
  };
  // Worker report material (top level, nested provider result, or retained reports).
  const reported = report => ['findings', 'unverified', 'questions', 'departures', 'pushback'].some(k => (report?.[k]?.length ?? 0) > 0);
  // A historical review finding counts until the latest later review that disposes of it
  // says "fixed" with evidence. "remaining", "outside-scope" or no disposition keep it open.
  const history = flow.reviewHistory ?? [];
  const latestDisposition = (finding, after) => history.slice(after + 1).flatMap(later => (later?.result?.priorFindingsDisposition ?? []).filter(d => d?.finding === finding.message)).at(-1);
  const unresolvedHistory = history.some((row, i) => (row?.result?.findings ?? []).some(finding => {
    const d = latestDisposition(finding, i);
    return !(d?.disposition === 'fixed' && typeof d.evidence === 'string' && d.evidence.trim());
  }));
  return outcome !== 'completed' || Boolean(reason) || Boolean(flow.stopRequested)
    || Object.values(flow.results ?? {}).some(row => row && (
      ['fail', 'failed', 'blocked', 'partial', 'error', 'uncertain', 'stopped'].includes(row.route)
      || row.error || row.reason || reported(row) || reported(row.result)
      // A required check that passed only after a rerun is a recovery, not a clean pass.
      || (row.rerun?.runs?.length ?? 0) > 0
      || (row.obligations?.length ?? 0) > 0 && row.obligations.some(obligation => !fulfilled(obligation))))
    || (flow.workerReports ?? []).some(reported) || unresolvedHistory || mustFixAttention(flow)
    || (flow.taskSnapshot?.postMerge?.length ?? 0) > 0
    || store.by('obligation', 'flowId', flow.id).some(row => !fulfilled(row))
    // Lifecycle status only: an attempt that settled cleanly and reported a failure (outcome
    // failed, e.g. a fast check the builder then corrected) is not attention for a completed
    // flow; the completion notice lists it under "Corrected on the way" (core/project.mjs).
    || store.by('attempt', 'flowId', flow.id).some(row => ['failed', 'uncertain', 'prepared', 'dispatching', 'launching', 'running'].includes(row.status)
      // A step whose provider stopped at its turn limit (dev.85, I2) asked a question and spent a
      // budget of turns without finishing; its flow is not routine even when a retry later finished.
      || row.outcome === 'turn-limit' || row.classification === 'turn-limit')
    // Canonical lookup (migrated projects): an unresolved or unconfirmed durable decision on
    // the flow's task is never routine. Queued deliveries reclassify on the same lookup.
    || (flow.taskId ? unresolvedTaskDecisions(store, flow.taskId).length > 0 : false)
    || (flow.authorityRaces?.length ?? 0) > 0;
}
export function routineFlowSuccess(store, flow, outcome, reason = '') {
  if (!flow || flowNeedsAttention(store, flow, outcome, reason)) return false;
  // Only typed evidence from known operations qualifies. Opaque/custom successes
  // and separate notices (including future product-choice reports) stay visible.
  if (['change', 'document'].includes(flow.kind) && !flow.integration) {
    return (flow.results?.merge?.merged === true || flow.results?.['satisfied-record']?.proven === true)
      && flow.results?.cleanup?.released === true;
  }
  const operation = flow.workflow?.nodes?.run?.action?.operation ?? (flow.jobId ? store.get('job', flow.jobId)?.operation : null);
  const result = flow.results?.run;
  return flow.kind === 'maintenance' && !flow.integration && operation === 'target.sync'
    && result?.route === 'pass' && result.sync?.contained === true && !result.sync.conflict
    && typeof result.sync.head === 'string' && /^[a-f\d]{40,64}$/i.test(result.sync.head)
    && typeof result.sync.fromHead === 'string' && /^[a-f\d]{40,64}$/i.test(result.sync.fromHead);
}
function routineTerminalItem(store, item) {
  // Restrict suppression to core-created terminal summaries, never arbitrary
  // notices merely associated with a successfully completed flow.
  if (item?.kind !== 'notice' || item.outcome !== 'completed' || item.retrospectiveId !== item.flowId
    || !item.id.startsWith(`flow-notice:${item.flowId}:completed:`)) return false;
  // Legacy summaries did not carry the reason separately. Unknown prose stays visible.
  const flow = store.get('flow', item.flowId);
  const reason = item.terminalReason ?? (item.context === `The ${flow?.kind ?? 'workflow'} finished with outcome completed. Read its retained evidence and retrospective.` ? '' : item.context || 'unknown');
  return routineFlowSuccess(store, flow, item.outcome, reason);
}
function suppressInbox(store, item, config) {
  const level = notificationLevel(config), filtered = level !== 'all', resolution = inboxResolution(item);
  return (level === 'actionable' && routineTerminalItem(store, item))
    || (resolution?.actor === 'orchestrator' && (filtered || config.notifications?.suppressSelfResolutions === true))
    || (filtered && resolution?.kind === 'superseded')
    || (filtered && item.status === 'open' && (item.causedBy ?? item.createdBy) === 'orchestrator');
}
const approvalEvents = new Set(['task.approved', 'task.revoked', 'task.approval-revoked']);
const suppressState = (config, type, actor) => notificationLevel(config) !== 'all' && (!approvalEvents.has(type) || actor === 'orchestrator');
// Who resolved an item, and how. Attribution only: consumers still read state.
export function inboxResolution(item) {
  if (item.status === 'open') return null;
  if (item.withdrawal) return { kind: 'withdrawn', actor: item.withdrawal.actor };
  if (item.status === 'answered') return { kind: 'answered', actor: item.answeredBy ?? null };
  if (item.status === 'acknowledged') return { kind: 'acknowledged', actor: item.acknowledgedBy ?? null };
  return { kind: item.status, actor: item.supersededBy ?? null };
}
// Reminder interval while an item stays open: null means deliver once. Notices
// do not remind by default; questions do.
export function reminderInterval(item, reminderMs) {
  if (!item || item.remind === 'never') return null;
  if (Number.isSafeInteger(item.remind)) return item.remind;
  if (Number.isSafeInteger(item.notificationReminderMs)) return Math.max(reminderMs, item.notificationReminderMs);
  return item.kind === 'notice' ? null : reminderMs;
}
export function queueDelivery(store, options) {
  return store.tx(() => queueDeliveryInTransaction(store, options));
}
// Operations loop: every inbox item that notifies has an operator delivery for its current
// version. Only an item without one is opened (the delivery id is a digest of the item id,
// its version and the channel, so its presence is one index probe). The pass is skipped
// while the database is unchanged since a pass that found nothing to queue: that pass
// began at the remembered change token, so nothing was written since before it looked, and
// what it looks at (inbox statuses and versions, delivery ids) does not depend on time.
const NOTIFYING = ['open', 'answered', 'expired', 'acknowledged', 'superseded'], settledPasses = new WeakMap();
export function queueInboxDeliveries(store) {
  const token = store.changeToken();
  if (settledPasses.get(store) === token) return 0;
  const present = store.db.prepare("SELECT 1 FROM records WHERE kind='delivery' AND id=?");
  let queued = 0;
  for (const row of inboxVersions(store, NOTIFYING)) {
    // An item without a version is left to the general path, which reads it.
    if (row.version !== null && present.get(digest({ inboxId: row.id, version: row.version, channel: 'operator' }))) continue;
    queueDelivery(store, { inboxId: row.id }); queued++;
  }
  if (queued) settledPasses.delete(store); else settledPasses.set(store, token);
  return queued;
}
export function queueDeliveryInTransaction(store, { inboxId, channel = 'operator', nowMs = Date.now() }) {
  const item = store.need('inbox', inboxId), id = digest({ inboxId, version: item.version, channel });
  if (store.get('delivery', id)) return store.get('delivery', id);
  // An earlier version's delivery that still owes the presenter a wake hands it to this one.
  let owed = null;
  for(const prior of store.by('delivery','inboxId',inboxId).filter(row=>row.channel===channel&&row.inboxVersion!==item.version)){
    const active=['pending','sending','accepted'].includes(prior.status);if(!active&&!prior.presentationEnded)continue;
    if(prior.presentationEnded){owed=prior.presentationEnded;delete prior.presentationEnded;}
    if(active)prior.status='superseded';store.put('delivery',prior);
  }
  assert(['open','answered','expired','acknowledged','superseded'].includes(item.status),'unsupported inbox notification status');
  const resolution = inboxResolution(item);
  // The webhook wakes the orchestrator; it need not be woken by its own resolutions.
  const suppressed = suppressInbox(store, item, store.meta('config', {}));
  const row = { id, inboxId, inboxVersion: item.version, inboxStatus:item.status, event:item.status==='open'?'inbox.attention':'inbox.resolved', ...(resolution ? { resolution } : {}), channel, status: suppressed ? 'suppressed' : 'pending', attempts: 0, nextAt: new Date(nowMs).toISOString() };
  if (owed) { row.presentationEnded = { id: owed.id, ...(suppressed ? { resume: 'suppressed' } : {}) }; row.status = 'pending'; }
  store.put('delivery', row); return row;
}
// A presentation is an external prompt channel also showing an open question (core/communication.mjs).
export const pendingPresentation = (item, nowMs) => (item?.presentations ?? []).find(row => row.status === 'pending' && Date.parse(row.expiresAt) > nowMs) ?? null;
// A presentation ended without its presenter knowing (its time passed, or someone else ended
// it or resolved the question): the presenter must take the prompt down, so the item's current
// delivery is sent once more whatever the notification level, then returns to its usual course.
// The wake is `presentationEnded {id, resume?, attempt?}` on that delivery:
// - `resume` is the status the delivery had before its first unsent wake. A later ending
//   replaces `id` and keeps `resume`, so endings before a successful send share one wake
//   and a quiet delivery is quiet again after it.
// - `attempt` is the send that carries it, set at dispatch. Only that send's success clears
//   the wake. An ending recorded while a request is in flight has no `attempt`: that
//   request's consumer may have read the prompt as still up, so it is sent once more.
export function wakePresenterInTransaction(store, item, presentation, { nowMs = Date.now() } = {}) {
  const row = queueDeliveryInTransaction(store, { inboxId: item.id, nowMs }), owed = row.presentationEnded;
  const resume = owed ? owed.resume : ['pending', 'sending'].includes(row.status) ? undefined : row.status;
  row.presentationEnded = { id: presentation.id, ...(resume ? { resume } : {}) };
  if (row.status !== 'sending') { row.status = 'pending'; row.nextAt = new Date(nowMs).toISOString(); }
  store.put('delivery', row); return row;
}
const stateEvents=new Set(['task.approved','task.revoked','task.approval-revoked','flow.admitted','planning.admitted','flow.stopped','flow.resumed','flow.finished']);
// Called inside the same transaction that records a canonical transition. No
// prose or approval authority crosses the webhook; consumers read current state.
export function queueStateDeliveryInTransaction(store,{sequence,at,type,payload}) {
  if(!stateEvents.has(type)||!store.meta('config',{}).notifications?.configPath||store.meta('config',{}).notifications?.stateEvents===false)return;
  // Essential/actionable: approval changes only (flow ends arrive once, as the flow notice), and none the orchestrator caused.
  if(suppressState(store.meta('config',{}),type,store.commandActor))return;
  const flow=payload.flowId?store.get('flow',payload.flowId):null;
  const taskId=payload.taskId??flow?.taskId,task=taskId?store.get('task',taskId):null;
  if(!taskId||flow?.kind==='maintenance'||taskId.startsWith('job:')||payload.flowId&&!flow)return;
  const projectId=store.meta('project').projectId,id=digest({projectId,sequence,kind:'state'});
  store.put('delivery',{id,kind:'state',channel:'orchestrator',event:type,causedBy:store.commandActor??null,eventSequence:sequence,eventAt:at,taskId,...(flow?{flowId:flow.id}:{}),taskRevision:flow?.taskRevision??task?.revision??null,approvalVersion:task?.approvalVersion??null,status:'pending',attempts:0,nextAt:at});
}
// Reminders: every 30 minutes by default while a question stays open; an acknowledgement defers
// the next one to at least four hours out.
export const DEFAULT_REMINDER_MS = 1800000, ACK_DEFER_MS = 4 * 3600000;
export async function deliverDue(store, { configPath, transport, nowMs = Date.now(), limit = 8, timeoutMs = 10000, reminderMs = DEFAULT_REMINDER_MS }) {
  assert(typeof transport === 'function', 'explicit notification transport required');
  let config; const outcomes = [];
  try { config = readDeliveryConfig(configPath); }
  catch (error) { recordDeliveryProblem(store, error.message, nowMs); return outcomes; }
  recordDeliveryHealthy(store, nowMs);
  for (const candidate of store.live('delivery').filter(d => ['pending', 'sending', 'accepted'].includes(d.status) && Date.parse(d.nextAt) <= nowMs).slice(0, limit)) {
    const delivery = store.tx(() => {
      const row = store.need('delivery', candidate.id), item = row.kind==='state'?null:store.get('inbox', row.inboxId);
      if (row.kind!=='state'&&(!item || item.version !== row.inboxVersion || item.status !== (row.inboxStatus??'open') || (item.status==='open' && item.expiresAt && Date.parse(item.expiresAt) <= nowMs))) { row.status = 'superseded'; store.put('delivery', row); return null; }
      if(!['pending','sending','accepted'].includes(row.status))return null;
      // Policy changes affect the next dispatch/retry, not canonical history. An
      // active send lease may already have crossed the external boundary.
      if (row.status === 'sending' && Date.parse(row.leaseUntil) > nowMs) return null;
      const currentConfig = store.meta('config', {});
      if (!row.presentationEnded && notificationLevel(currentConfig) === 'actionable' && (row.kind === 'state'
        ? suppressState(currentConfig, row.event, row.causedBy)
        : suppressInbox(store, item, currentConfig))) {
        row.status = 'suppressed'; store.put('delivery', row); return null;
      }
      // An attention delivery already accepted for an item that no longer reminds (for
      // example a notice whose reminder was scheduled before notices stopped reminding)
      // is complete; do not re-send it.
      if(row.status==='accepted'&&row.kind!=='state'&&row.event==='inbox.attention'&&reminderInterval(item,reminderMs)===null){row.status='delivered';store.put('delivery',row);return null;}
      // A prompt channel is already showing this question: hold reminders (never a first
      // delivery, a retry or a resolution) until that presentation ends.
      if(row.status==='accepted'&&row.kind!=='state'&&row.event==='inbox.attention'){const shown=pendingPresentation(item,nowMs);if(shown){row.nextAt=shown.expiresAt;store.put('delivery',row);return null;}}
      // Every wake tells the orchestrator its number in the current session, allocated here so
      // concurrent sends never share one; the session it was sent to travels with the attempt.
      const session = claimSessionSendInTransaction(store, row);
      row.status = 'sending'; row.attempts++; row.leaseUntil = new Date(nowMs + timeoutMs * 2).toISOString(); row.nextAt = row.leaseUntil;
      if (row.presentationEnded) row.presentationEnded.attempt = row.attempts;
      store.put('delivery', row); return { ...row, session };
    });
    if (!delivery) continue;
    const { session } = delivery;
    const payload = JSON.stringify({ projectId: store.meta('project').projectId, deliveryId: delivery.id, ...(delivery.kind==='state'?{kind:'state',event:delivery.event,eventSequence:delivery.eventSequence,version:delivery.eventSequence,eventAt:delivery.eventAt,taskId:delivery.taskId,...(delivery.flowId?{flowId:delivery.flowId}:{}),taskRevision:delivery.taskRevision,approvalVersion:delivery.approvalVersion}:{kind:'inbox',inboxId:delivery.inboxId,version:delivery.inboxVersion,event:delivery.event??'inbox.attention',status:delivery.inboxStatus??'open',...(delivery.resolution?{resolution:delivery.resolution.kind,actor:delivery.resolution.actor}:{}),...(delivery.presentationEnded?{presentationEnded:true,presentationId:delivery.presentationEnded.id}:{})}), ...session, observedAt:new Date(nowMs).toISOString() });
    const headers = { 'content-type': 'application/json', ...(config.signingKey ? { 'x-factotum-signature': createHmac('sha256', config.signingKey).update(payload).digest('hex') } : {}) };
    let accepted = false;
    try { const result = await transport({ url: config.url, payload, headers, signal: AbortSignal.timeout(timeoutMs) }); accepted = result.status >= 200 && result.status < 300; } catch { /* Never persist transport errors: they may contain endpoint credentials. */ }
    const result = store.tx(() => {
      const row = store.need('delivery', delivery.id);
      // Count what the endpoint accepted, even when an acknowledgment raced the request, for the
      // session the request was sent to.
      if (accepted) countSessionDeliveryInTransaction(store, row, delivery.sessionSend, { nowMs });
      if (row.status !== 'sending' || row.attempts !== delivery.attempts) { if (accepted) store.put('delivery', row); return row; }
      const interval = row.kind === 'state' || row.event === 'inbox.resolved' ? reminderMs : reminderInterval(store.get('inbox', row.inboxId), reminderMs);
      row.status = accepted ? (interval === null ? 'delivered' : 'accepted') : 'pending'; row.nextAt = new Date(nowMs + (accepted ? interval ?? 0 : Math.min(4 * 3600000, 30000 * 2 ** Math.min(row.attempts - 1, 9)))).toISOString();
      // The wake this request carried is sent: a delivery that was complete or quiet before it is so
      // again. One recorded after the request left is still owed, so the delivery is sent once more.
      const wake = row.presentationEnded;
      if (accepted && wake?.attempt === row.attempts) { delete row.presentationEnded; if (['suppressed', 'delivered', 'acknowledged'].includes(wake.resume)) row.status = wake.resume; }
      else if (accepted && wake) { row.status = 'pending'; row.nextAt = new Date(nowMs).toISOString(); }
      store.put('delivery', row); store.event('notification.delivery', { deliveryId: row.id, inboxId: row.inboxId, accepted }); return row;
    }); outcomes.push(result);
  }
  return outcomes;
}
// Delivery starts when notifications.configPath is set where it was not (or points to another
// file). Deliveries queued before then are a backlog nobody was woken for: only attention
// deliveries for items that are still open (and a wake still owed to a presenter) are kept; the
// rest (resolutions of settled items, state events, attention for items no longer open) is
// superseded and summarized in the event notification.backlog-trimmed and config.update's result.
export function deliveryStarts(before, after) {
  const path = after?.notifications?.configPath;
  return (after?.mode ?? 'rehearsal') === 'delivery' && Boolean(path) && ((before?.mode ?? 'rehearsal') !== 'delivery' || before?.notifications?.configPath !== path);
}
export function trimDeliveryBacklogInTransaction(store) {
  let kept = 0; const superseded = {};
  for (const row of store.live('delivery').filter(d => ['pending', 'sending', 'accepted'].includes(d.status))) {
    const item = row.kind === 'state' ? null : store.get('inbox', row.inboxId);
    const open = row.kind !== 'state' && row.event === 'inbox.attention' && item?.status === 'open' && item.version === row.inboxVersion;
    if (open || row.presentationEnded) { kept++; continue; }
    row.status = 'superseded'; row.supersededReason = 'backlog before notification delivery started'; store.put('delivery', row);
    const key = row.kind === 'state' ? `state:${row.event}` : `${row.event ?? 'inbox.attention'}:${item?.status ?? 'missing'}`;
    superseded[key] = (superseded[key] ?? 0) + 1;
  }
  const summary = { kept, superseded: Object.values(superseded).reduce((a, b) => a + b, 0), supersededByKind: superseded };
  store.event('notification.backlog-trimmed', summary); return summary;
}
export function acknowledgeDeliveryInTransaction(store, { deliveryId, nowMs = Date.now() }) {
  const row=store.need('delivery',deliveryId),terminal=row.kind==='state'||row.event==='inbox.resolved';
  row.acknowledgedAt=new Date(nowMs).toISOString();
  // A wake is still owed, and an acknowledgement cannot say which request it answers: it
  // neither settles nor defers the wake. The send completes or is retried as usual.
  if(row.presentationEnded&&row.status!=='superseded'){if(terminal)row.presentationEnded.resume='acknowledged';}
  else{
    // An acknowledgement defers the next reminder to at least four hours out; it never brings one
    // earlier. During a send, the reminder that send would have scheduled counts as scheduled.
    const sending=row.status==='sending',interval=sending&&!terminal?reminderInterval(store.get('inbox',row.inboxId),DEFAULT_REMINDER_MS):null;
    if(terminal&&row.status!=='superseded')row.status='acknowledged';
    else if(sending)row.status=row.event==='inbox.attention'&&reminderInterval(store.get('inbox',row.inboxId),0)===null?'delivered':'accepted'; // Preserve an ack arriving during the HTTP request.
    const scheduled=sending?(interval===null?0:nowMs+interval):Date.parse(row.nextAt);
    row.nextAt=new Date(Math.max(nowMs+ACK_DEFER_MS,Number.isFinite(scheduled)?scheduled:0)).toISOString();
  }
  store.put('delivery',row);store.event('notification.acknowledged',{deliveryId});return row;
}
export function acknowledgeDelivery(store, options) {
  return store.tx(()=>acknowledgeDeliveryInTransaction(store,options));
}
