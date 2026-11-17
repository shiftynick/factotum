import { assert, digest, id, now } from '../core/contracts.mjs';

// The orchestrator session is the host conversation that receives notification deliveries.
// Factotum counts the deliveries the endpoint accepted for the current session and, at a
// configurable limit, asks the orchestrator to hand off to a fresh session. The count lives
// in project metadata (no schema), resets when a different session is bound, and never
// affects admission or any other delivery.
export const HANDOFF_DEFAULTS = Object.freeze({ afterDeliveries: 100, repeatDeliveries: 25 });
const AFTER = [10, 100000], REPEAT = [5, 100000];
export function handoffSettings(config) {
  const n = config?.notifications ?? {};
  return { afterDeliveries: n.handoffAfterDeliveries ?? HANDOFF_DEFAULTS.afterDeliveries, repeatDeliveries: n.handoffRepeatDeliveries ?? HANDOFF_DEFAULTS.repeatDeliveries };
}
const within = (value, [min, max]) => Number.isSafeInteger(value) && value >= min && value <= max;
export function validateHandoffSettings(config) {
  const n = config?.notifications ?? {};
  assert(n.handoffAfterDeliveries === undefined || n.handoffAfterDeliveries === 0 || within(n.handoffAfterDeliveries, AFTER), `notifications.handoffAfterDeliveries must be 0 (no handoff question) or a whole number from ${AFTER[0]} to ${AFTER[1]}`);
  assert(n.handoffRepeatDeliveries === undefined || within(n.handoffRepeatDeliveries, REPEAT), `notifications.handoffRepeatDeliveries must be a whole number from ${REPEAT[0]} to ${REPEAT[1]}`);
}
// Before any session is declared, deliveries count toward an undeclared session (version 0).
// deliveries: sends the endpoint accepted (drives the handoff question). dispatched: send
// ordinals handed out to distinct deliveries (the payload's sessionDeliveries).
const current = store => { const row = store.meta('orchestratorSession', null) ?? { version: 0, sessionId: null, boundAt: null, boundBy: null, deliveries: 0, lastDeliveryAt: null, handoff: null }; return { ...row, dispatched: row.dispatched ?? row.deliveries }; };
// Session resets (each binding of a different session), most recent last.
const RESET_HISTORY = 20;
// Unusually frequent resets raise one operator notice per day: RESET_BURST resets that ended
// sessions which together received fewer deliveries than one handoff limit (an orchestrator
// rebinding to dodge its own prompt), or more than RESET_DAILY resets within 24 hours.
export const RESET_NOTICE = Object.freeze({ burst: 4, daily: 10, windowMs: 86400000 });
const resetLog = store => store.meta('orchestratorSessionResets', null) ?? { history: [], lastNoticeAt: null, notices: 0 };
export function orchestratorSessionView(store) {
  const session = current(store), { afterDeliveries, repeatDeliveries } = handoffSettings(store.meta('config', {}));
  const item = session.handoff ? store.get('inbox', session.handoff.inboxId) : null;
  return { version: session.version, sessionId: session.sessionId, declared: Boolean(session.sessionId), boundAt: session.boundAt, boundBy: session.boundBy,
    deliveries: session.deliveries, lastDeliveryAt: session.lastDeliveryAt, limit: afterDeliveries || null, repeatDeliveries,
    nextHandoffAt: afterDeliveries ? nextRaiseAt(session, afterDeliveries, repeatDeliveries) : null,
    handoff: session.handoff ? { ...session.handoff, status: item?.status ?? null, version: item?.version ?? null } : null,
    dispatched: session.dispatched, resets: resetSummary(store) };
}
function resetSummary(store, nowMs = Date.now()) {
  const log = resetLog(store);
  return { recent: log.history.slice(-5).reverse(), last24h: log.history.filter(row => nowMs - Date.parse(row.at) < RESET_NOTICE.windowMs).length, lastNoticeAt: log.lastNoticeAt };
}
// After a raise, the next one waits for repeatDeliveries more deliveries, counted from the
// raise or from the answer, whichever is later.
function nextRaiseAt(session, afterDeliveries, repeatDeliveries) {
  if (!session.handoff) return afterDeliveries;
  return Math.max(session.handoff.raisedAtDeliveries, session.handoff.answeredAtDeliveries ?? 0) + repeatDeliveries;
}
// orchestrator.session: the orchestrator (or the operator) declares the session that now
// receives deliveries. The same session again changes nothing; a different one starts a new
// count and closes the previous session's open handoff question.
export function bindOrchestratorSession(store, p, actor) {
  assert(Object.keys(p).every(key => ['sessionId', 'expectedVersion'].includes(key)), 'orchestrator.session accepts sessionId and expectedVersion');
  const sessionId = id(p.sessionId, 'session id'), previous = current(store);
  if (p.expectedVersion !== undefined) assert(p.expectedVersion === previous.version, 'the orchestrator session changed; refresh before binding');
  if (previous.sessionId === sessionId) return orchestratorSessionView(store);
  const at = now(), item = previous.handoff ? store.get('inbox', previous.handoff.inboxId) : null;
  if (item?.status === 'open') {
    Object.assign(item, { status: 'superseded', supersededBy: actor, supersededAt: at, supersededReason: 'a new orchestrator session was bound' }); item.version++;
    const wait = store.get('wait', `question:${item.id}`); if (wait && !wait.endedAt) store.put('wait', { ...wait, endedAt: at, reason: 'superseded' });
    store.put('inbox', item); store.event('inbox.superseded', { inboxId: item.id, actor, reason: 'orchestrator session rebound' });
  }
  const row = { version: previous.version + 1, sessionId, boundAt: at, boundBy: actor, deliveries: 0, dispatched: 0, lastDeliveryAt: null, handoff: null };
  store.setMeta('orchestratorSession', row);
  store.event('orchestrator.session', { version: row.version, sessionId, previousSessionId: previous.sessionId, previousDeliveries: previous.deliveries, actor });
  recordReset(store, { at, actor, fromVersion: previous.version, fromSessionId: previous.sessionId, toVersion: row.version, toSessionId: sessionId, deliveries: previous.deliveries, dispatched: previous.dispatched });
  return orchestratorSessionView(store);
}
// Rebinding needs no operator authorization, but every reset is recorded with the count it
// discarded, and unusually frequent resets are reported to the operator.
function recordReset(store, reset) {
  const log = resetLog(store), nowMs = Date.parse(reset.at);
  log.history = [...log.history, reset].slice(-RESET_HISTORY);
  const limit = handoffSettings(store.meta('config', {})).afterDeliveries || HANDOFF_DEFAULTS.afterDeliveries;
  const burst = log.history.slice(-RESET_NOTICE.burst), daily = log.history.filter(row => nowMs - Date.parse(row.at) < RESET_NOTICE.windowMs);
  const reason = burst.length === RESET_NOTICE.burst && burst.reduce((sum, row) => sum + row.deliveries, 0) < limit
    ? `The last ${RESET_NOTICE.burst} orchestrator session resets ended sessions that together received ${burst.reduce((sum, row) => sum + row.deliveries, 0)} deliveries, fewer than one handoff limit (${limit}).`
    : daily.length > RESET_NOTICE.daily ? `The orchestrator session was reset ${daily.length} times in the last 24 hours.` : null;
  if (reason && (!log.lastNoticeAt || nowMs - Date.parse(log.lastNoticeAt) >= RESET_NOTICE.windowMs)) {
    log.notices += 1; log.lastNoticeAt = reset.at;
    const inboxId = `orchestrator-session-resets:${log.notices}`;
    const recent = burst.map(row => `${row.fromSessionId ?? 'undeclared'} (${row.deliveries} deliveries) → ${row.toSessionId} by ${row.actor} at ${row.at}`).join('; ');
    // Only the operator may acknowledge it: the orchestrator must not silence a report about itself.
    store.put('inbox', { id: inboxId, kind: 'notice', status: 'open', version: 1, role: 'operator', operatorAckOnly: true, createdBy: 'factory', createdAt: reset.at,
      title: 'Orchestrator sessions are being reset unusually often',
      context: `${reason} Each reset starts a new delivery count and postpones the handoff question. Recent resets: ${recent}. If these were not real handoffs, ask the orchestrator why; the history is in Stats → Orchestrator session.` });
    store.event('orchestrator.session-resets-notice', { inboxId, reason });
  }
  store.setMeta('orchestratorSessionResets', log);
}
// Called inside the transaction that claims a delivery for sending. A delivery gets a send
// ordinal in the current session when first dispatched there; a retry of a send that was not
// accepted keeps it (same delivery, same number); a later re-send of an accepted delivery (a
// reminder), or a retry after a different session was bound, gets a new one. Ordinals are
// allocated serially in the claiming transaction, so concurrent sends never share a number.
// Returns the numbers the payload carries, with the session they belong to (sessionVersion, dev.88:
// a delivery dispatched before a rebind is counted for the earlier session, so a reader can tell
// whose count it is; version 0 is the undeclared session).
export function claimSessionSendInTransaction(store, row) {
  const session = current(store), { afterDeliveries } = handoffSettings(store.meta('config', {}));
  if (!(row.sessionSend && row.sessionSend.version === session.version && !row.sessionSend.acceptedAt)) {
    session.dispatched += 1;
    row.sessionSend = { version: session.version, ordinal: session.dispatched };
    store.setMeta('orchestratorSession', session);
  }
  return { sessionVersion: row.sessionSend.version, sessionDeliveries: row.sessionSend.ordinal, sessionDeliveryLimit: afterDeliveries || null };
}
// Called inside the transaction that records an endpoint's acceptance. The acceptance counts for
// the session the send was dispatched to (send, captured at dispatch), never for a session bound
// while the request was in flight; a late acceptance for an earlier session is added to that
// session's reset record. Each send ordinal counts at most once.
export function countSessionDeliveryInTransaction(store, row, send, { nowMs = Date.now() } = {}) {
  const key = `${send.version}:${send.ordinal}`;
  if ((row.sessionCounted ?? []).includes(key)) return;
  // Keep enough history that a long-delayed earlier attempt cannot be counted twice.
  row.sessionCounted = [...(row.sessionCounted ?? []), key].slice(-256);
  if (row.sessionSend?.version === send.version && row.sessionSend.ordinal === send.ordinal) row.sessionSend = { ...row.sessionSend, acceptedAt: new Date(nowMs).toISOString() };
  const session = current(store);
  if (send.version !== session.version) {
    const log = resetLog(store), reset = log.history.find(entry => entry.fromVersion === send.version);
    if (reset) { reset.deliveries += 1; reset.lateAcceptances = (reset.lateAcceptances ?? 0) + 1; store.setMeta('orchestratorSessionResets', log); }
    return;
  }
  session.deliveries += 1; session.lastDeliveryAt = new Date(nowMs).toISOString();
  const { afterDeliveries, repeatDeliveries } = handoffSettings(store.meta('config', {}));
  if (afterDeliveries && session.deliveries >= nextRaiseAt(session, afterDeliveries, repeatDeliveries)) raiseHandoff(store, session, { nowMs, afterDeliveries, repeatDeliveries });
  store.setMeta('orchestratorSession', session);
}
const QUESTION_TTL_MS = 86400000;
function handoffText(session, afterDeliveries, repeatDeliveries) {
  return `This orchestrator session has received ${session.deliveries} notification deliveries (the handoff limit is ${afterDeliveries}). A long session carries an ever larger context into every wake. ` +
    'Start a fresh session, give it the handoff summary (open questions, current flows, decisions in progress, anything promised to the operator), ' +
    'bind it with orchestrator.session {"sessionId": "<new session id>"} and move the notification binding to it, then let this session stop. ' +
    'If a triage proxy receives the notifications and forwards them to the bound session, leave the notification binding on the proxy: binding the new session is enough. ' +
    `Binding the new session closes this question and starts a new count, so there is no need to answer it when handing off. Answering "Not yet" keeps this session; the question returns after ${repeatDeliveries} more deliveries. Nothing waits on this answer.`;
}
function raiseHandoff(store, session, { nowMs, afterDeliveries, repeatDeliveries }) {
  const at = new Date(nowMs).toISOString(), expiresAt = new Date(nowMs + QUESTION_TTL_MS).toISOString(), projectId = store.meta('project').projectId;
  const existing = session.handoff ? store.get('inbox', session.handoff.inboxId) : null, raises = (session.handoff?.raises ?? 0) + 1;
  const open = existing?.status === 'open' && Date.parse(existing.expiresAt) > nowMs;
  const fields = { title: 'Hand off to a fresh orchestrator session', context: handoffText(session, afterDeliveries, repeatDeliveries), deliveries: session.deliveries, updatedAt: at, expiresAt };
  let item;
  if (open) {
    // Still unanswered: a new version carries the current count and wakes the session once more.
    item = { ...existing, ...fields, version: existing.version + 1 };
  } else {
    item = { id: `orchestrator-handoff:${session.version}:${raises}`, standalone: true, orchestratorHandoff: true, kind: 'question', status: 'open', role: 'orchestrator', version: 1, createdBy: 'factory', createdAt: at, ...fields,
      question: 'Hand off to a fresh orchestrator session now?',
      choices: [
        { id: 'handing-off', label: 'Handing off now', description: 'A fresh session takes over: it binds itself with orchestrator.session and this session stops.' },
        { id: 'later', label: 'Not yet', description: `Keep this session; ask again after ${repeatDeliveries} more deliveries.` },
      ],
      // One wake per raise: the count, not the clock, brings the question back.
      remind: 'never' };
    item.answers = item.choices.map(choice => choice.id);
    store.put('wait', { id: `question:${item.id}`, inboxId: item.id, kind: 'question', startedAt: at, endedAt: null });
  }
  const { subjectDigest, ...subject } = item; item.subjectDigest = digest({ projectId, ...subject });
  store.put('inbox', item);
  session.handoff = { inboxId: item.id, raisedAtDeliveries: session.deliveries, raisedAt: at, raises };
  store.event('orchestrator.handoff-raised', { inboxId: item.id, version: item.version, deliveries: session.deliveries, limit: afterDeliveries, sessionVersion: session.version });
}
// An answered handoff question restarts the repeat interval from the answer.
export function noteHandoffAnswerInTransaction(store, item) {
  const session = current(store);
  if (!item.orchestratorHandoff || session.handoff?.inboxId !== item.id) return;
  session.handoff = { ...session.handoff, answeredAtDeliveries: session.deliveries, answer: item.answer };
  store.setMeta('orchestratorSession', session);
}
