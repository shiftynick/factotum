import { assert, digest } from '../core/contracts.mjs';
import { categoryWaits, slots } from './capacity.mjs';

const timestamp = ms => new Date(ms).toISOString();
const episode = (queue, task) => digest({ queuedAt: queue.queuedAt ?? null, revision: task?.revision ?? null });

// These are observations of canonical admission checks, not proof of readiness
// between ticks. Call inside the caller's transaction when admission is atomic.
export function recordQueueEligibility(store, queue, task, reasons, { nowMs = Date.now() } = {}) {
  assert(Number.isFinite(nowMs) && Array.isArray(reasons), 'valid queue observation required');
  const at = timestamp(nowMs), key = episode(queue, task), previous = queue.eligibility?.episode === key ? queue.eligibility : null;
  const normalized = [...new Set(reasons)].sort(), ready = normalized.length === 0;
  const changed = !previous || digest(previous.reasons) !== digest(normalized);
  const eligibility = {
    episode: key, taskRevision: task?.revision ?? null, ready, reasons: normalized,
    firstObservedAt: previous?.firstObservedAt ?? at, lastObservedAt: at,
    changedAt: changed ? at : previous.changedAt,
    transitions: (previous?.transitions ?? 0) + (changed ? 1 : 0),
    firstReadyAt: previous?.firstReadyAt ?? (ready ? at : null),
    readySince: ready ? (previous?.ready ? previous.readySince : at) : null,
    lastNotReadyAt: ready ? previous?.lastNotReadyAt ?? null : at,
  };
  const row = { ...queue, eligibility }; store.put('queue', row);
  if (changed) store.event('queue.eligibility-changed', { taskId: queue.id, ...eligibility });
  return row;
}

// Returns the replacement queue row. The caller must invoke this after its last
// eligibility check and persist it together with the admitted flow and claim.
export function recordQueueAdmission(store, queue, flow, { nowMs = Date.now() } = {}) {
  const current = store.get('queue', queue.id);
  if (current?.admissionTiming?.flowId === flow.id) return current;
  const task = store.get('task', queue.id);
  const row = recordQueueEligibility(store, queue, task, [], { nowMs });
  const ready = row.eligibility;
  const timing = { observedAt: timestamp(nowMs), readySince: ready.readySince, firstReadyAt: ready.firstReadyAt,
    readyToAdmissionMs: Math.max(0, nowMs - Date.parse(ready.readySince)),
    firstReadyToAdmissionMs: Math.max(0, nowMs - Date.parse(ready.firstReadyAt)),
    basis: 'observed-eligibility', episode: ready.episode, flowId: flow.id };
  const claimed = { ...row, admissionTiming: timing }; store.put('queue', claimed);
  store.event('queue.admission-timing', { taskId: queue.id, ...timing });
  return claimed;
}

export function observeQueue(store, { reasonsForTask, nowMs = Date.now(), idleAfterMs = 1800000, repeatMs = 10800000 } = {}) {
  assert(typeof reasonsForTask === 'function', 'canonical admission reasons required');
  assert(Number.isFinite(nowMs) && Number.isSafeInteger(idleAfterMs) && idleAfterMs > 0 && Number.isSafeInteger(repeatMs) && repeatMs > 0, 'valid queue diagnostic timing required');
  return store.tx(() => {
    const rows = store.live('queue').filter(q => q.status === 'queued').sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(queue =>
      recordQueueEligibility(store, queue, store.get('task', queue.id), reasonsForTask(store.get('task', queue.id)), { nowMs }));
    const config = store.meta('config', {}), policy = config.policy ?? {};
    // Change slots a queued task could take now: flows parked on an answer hold none, and an
    // answered flow waiting for a slot is ahead of the queue (operations/capacity.mjs).
    // A slot an answered flow cannot take because its category is full is free for the queue, and
    // the notice names that flow, its category and what holds it.
    const capacity = slots(store, { policy }), freeSlots = capacity.pools.change.freeForNewWork, waits = categoryWaits(capacity);
    const summary = since => `Queued work has ${freeSlots} free project flow slot${freeSlots === 1 ? '' : 's'} since ${since}. Inspect eligibility reasons and dispatch health.${waits.length ? ` ${waits.map(row => row.text).join(' ')}` : ''}`;
    const idle = config.mode === 'delivery' && policy.autoQueue === true && store.meta('commissioning')?.ready === true && !store.meta('paused') && !store.meta('recoveryHold') && !store.meta('retentionHold') && rows.length > 0 && freeSlots > 0;
    const previous = store.meta('queueIdle'), at = timestamp(nowMs), noticeId = 'queue:idle-capacity';
    if (!idle) {
      if (previous) store.setMeta('queueIdle', null);
      const notice = store.get('inbox', noticeId);
      if (notice?.status === 'open') { store.put('inbox', { ...notice, status: 'resolved', resolvedAt: at, version: notice.version + 1 }); store.event('queue.idle-resolved', { inboxId: noticeId }); }
      return { rows, idle: false, freeSlots };
    }
    const since = previous && Date.parse(previous.since) <= nowMs ? previous.since : at;
    const state = { since, observedAt: at, freeSlots, queued: rows.length, lastNoticeAt: previous?.lastNoticeAt ?? null };
    if (nowMs - Date.parse(since) >= idleAfterMs && (!state.lastNoticeAt || nowMs - Date.parse(state.lastNoticeAt) >= repeatMs)) {
      const old = store.get('inbox', noticeId), blockers = rows.map(row => ({ taskId: row.id, reasons: row.eligibility.reasons }));
      const item = { id: noticeId, kind: 'notice', role: 'operator', status: 'open', version: (old?.version ?? 0) + 1, title: 'Queued work is not starting although slots are free',
        createdAt: old?.status === 'open' ? old.createdAt : at, updatedAt: at,
        summary: summary(since), ...(waits.length ? { categoryWaits: waits } : {}),
        idleSince: since, freeSlots, blockers, subjectDigest: digest({ since, freeSlots, blockers }), notificationReminderMs: repeatMs };
      store.put('inbox', item); store.event('queue.idle-capacity', { inboxId: noticeId, idleSince: since, freeSlots, blockers }); state.lastNoticeAt = at;
    } else {
      // Between reminders, an open notice keeps showing the current reasons (a hold extended to a
      // new deadline, say). Its version stays: the operator is not notified again for a refresh.
      const old = store.get('inbox', noticeId);
      if (old?.status === 'open') {
        const blockers = rows.map(row => ({ taskId: row.id, reasons: row.eligibility.reasons }));
        if (digest({ blockers, freeSlots, waits }) !== digest({ blockers: old.blockers ?? [], freeSlots: old.freeSlots, waits: old.categoryWaits ?? [] })) { const { categoryWaits: _, ...rest } = old; store.put('inbox', { ...rest, blockers, freeSlots,
          summary: summary(since), ...(waits.length ? { categoryWaits: waits } : {}), reasonsUpdatedAt: at }); }
      }
    }
    store.setMeta('queueIdle', state);
    return { rows, idle: true, freeSlots, since };
  });
}
