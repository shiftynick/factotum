import { assert, digest } from '../core/contracts.mjs';
function localParts(time, zone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}
export function dueOccurrences(schedule, { nowMs = Date.now(), afterMs = nowMs - 60000, maxCatchUp = 8, windowMs = 86400000 } = {}) {
  assert(Number.isSafeInteger(maxCatchUp) && maxCatchUp > 0 && maxCatchUp <= 1000, 'invalid catch-up bound');
  assert(Number.isSafeInteger(windowMs) && windowMs > 0 && windowMs <= 7 * 86400000, 'invalid missed window');
  const start = Math.max(afterMs, nowMs - windowMs), result = [];
  if (schedule.type === 'interval') {
    assert(Number.isSafeInteger(schedule.everyMs) && schedule.everyMs >= 1000, 'invalid interval');
    assert(Number.isFinite(schedule.anchorMs), 'interval anchor required');
    const first = Math.max(0, Math.floor((start - schedule.anchorMs) / schedule.everyMs) + 1), last = Math.floor((nowMs - schedule.anchorMs) / schedule.everyMs);
    for (let n = first; n <= last && result.length < maxCatchUp; n++) result.push({ key: `${schedule.id}:${n}`, at: new Date(schedule.anchorMs + n * schedule.everyMs).toISOString() });
  } else {
    assert(schedule.type === 'daily' && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.timeOfDay), 'invalid daily schedule');
    assert(typeof schedule.timezone === 'string' && schedule.timezone.length > 0, 'explicit schedule timezone required');
    assert(!schedule.weekdays || (Array.isArray(schedule.weekdays) && schedule.weekdays.length > 0 && schedule.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)), 'invalid schedule weekdays');
    const seen = new Set(), weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let t = Math.floor(start / 60000) * 60000 + 60000; t <= nowMs && result.length < maxCatchUp; t += 60000) {
      const p = localParts(t, schedule.timezone), day = `${p.year}-${p.month}-${p.day}`, key = `${schedule.id}:${day}`;
      if (`${p.hour}:${p.minute}` === schedule.timeOfDay && (!schedule.weekdays || schedule.weekdays.includes(weekdays.indexOf(p.weekday))) && !seen.has(key)) { seen.add(key); result.push({ key, at: new Date(t).toISOString() }); }
    }
  }
  return result;
}
// The UTC instant of a wall-clock time in a zone (two passes settle any offset change).
function zonedTime(y, m, d, hh, mm, zone) {
  const wanted = Date.UTC(y, m - 1, d, hh, mm); let t = wanted;
  for (let i = 0; i < 2; i++) { const p = localParts(t, zone); t += wanted - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute); }
  return t;
}
// When an enabled schedule next fires, or null.
export function nextOccurrence(schedule, { nowMs = Date.now() } = {}) {
  if (!schedule?.enabled) return null;
  if (schedule.type === 'interval') return new Date(schedule.anchorMs + Math.max(1, Math.floor((nowMs - schedule.anchorMs) / schedule.everyMs) + 1) * schedule.everyMs).toISOString();
  const [hh, mm] = schedule.timeOfDay.split(':').map(Number), today = localParts(nowMs, schedule.timezone);
  for (let i = 0; i <= 8; i++) {
    const day = new Date(Date.UTC(+today.year, +today.month - 1, +today.day + i));
    if (schedule.weekdays && !schedule.weekdays.includes(day.getUTCDay())) continue;
    const t = zonedTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, schedule.timezone);
    if (t > nowMs) return new Date(t).toISOString();
  }
  return null;
}
// Claim and durable trigger creation commit together. Callback must not execute external effects.
// `holdsFor(schedule)` names the project holds that keep a schedule from firing now (dev.103; none:
// it fires). A held schedule keeps its cursor, so it catches up within `windowMs` once the hold
// lifts, exactly as a schedule that was not scanned; meanwhile it is never missed silently: the
// first occurrence that falls due while it is held raises one operator notice,
// `schedule-held:<id>`, naming the schedule, that occurrence and the holds. While the hold lasts the
// same notice is kept current (later occurrences, a changed hold) without a new version, so the
// operator is told once per schedule per hold. The first scan after the hold lifts (which has just
// run the usual catch-up) resolves it; a schedule disabled or removed meanwhile supersedes it. The
// notice and its own scan cursor are named on the schedule record (heldNotice, heldScannedAt), so a
// tick with nothing held reads nothing more than it did, and a long hold scans its window once.
export const heldScheduleNoticeId = scheduleId => `schedule-held:${scheduleId}`;
export function dispatchSchedules(store, { nowMs = Date.now(), dispatch, trigger = dispatch, maxCatchUp = 8, windowMs = 86400000, holdsFor = () => [] } = {}) {
  assert(typeof trigger === 'function', 'durable trigger callback required');
  return store.tx(() => {
    const claimed = [], at = new Date(nowMs).toISOString();
    for (const schedule of store.all('schedule')) {
      if (!schedule.enabled) { if (schedule.heldNotice) { settleHeldNotice(store, schedule, at, false); store.put('schedule', schedule); } continue; }
      const afterMs = Date.parse(schedule.lastScannedAt ?? schedule.createdAt);
      assert(Number.isFinite(afterMs), 'schedule creation time required');
      const holds = holdsFor(schedule);
      if (holds.length) { if (heldScan(store, schedule, holds, { nowMs, afterMs, windowMs, at })) store.put('schedule', schedule); continue; }
      if (afterMs < nowMs - windowMs) store.event('schedule.missed', { scheduleId: schedule.id, from: new Date(afterMs).toISOString(), until: new Date(nowMs - windowMs).toISOString() });
      const occurrences = dueOccurrences(schedule, { nowMs, afterMs, maxCatchUp, windowMs });
      for (const occurrence of occurrences) {
        const id = digest(occurrence.key); if (store.get('occurrence', id)) continue;
        const result = trigger(schedule, occurrence, store); assert(!result?.then, 'schedule trigger must be synchronous');
        store.put('occurrence', { id, scheduleId: schedule.id, ...occurrence, commandId: result?.commandId ?? null });
        store.event('schedule.triggered', { scheduleId: schedule.id, occurrenceKey: occurrence.key }); claimed.push(occurrence);
      }
      // Continue a bounded backlog on the next tick; otherwise advance through the scanned window.
      schedule.lastScannedAt = occurrences.length === maxCatchUp ? occurrences.at(-1).at : new Date(nowMs).toISOString();
      if (schedule.heldNotice || schedule.heldScannedAt) settleHeldNotice(store, schedule, at, true, windowMs);
      store.put('schedule', schedule);
    }
    return claimed;
  });
}
// One held schedule: look for occurrences due since its last scan and raise or refresh its notice.
// Returns whether the schedule record changed.
function heldScan(store, schedule, holds, { nowMs, afterMs, windowMs, at }) {
  const from = Math.max(afterMs, Date.parse(schedule.heldScannedAt ?? '') || afterMs);
  const occurrences = dueOccurrences(schedule, { nowMs, afterMs: from, maxCatchUp: 1000, windowMs }).filter(o => !store.get('occurrence', digest(o.key)));
  const scannedAt = occurrences.length === 1000 ? occurrences.at(-1).at : at, moved = schedule.heldScannedAt !== scannedAt;
  schedule.heldScannedAt = scannedAt;
  const id = heldScheduleNoticeId(schedule.id), item = schedule.heldNotice ? store.get('inbox', id) : null, open = item?.status === 'open';
  if (!occurrences.length && !open) return moved;
  const first = open ? item.occurrence : occurrences[0], latest = occurrences.at(-1) ?? item.latestOccurrence, missed = (open ? item.missed : 0) + occurrences.length;
  const what = schedule.recurringTask ? `recurring task ${schedule.recurringTask}` : schedule.operation;
  const summary = `Schedule ${schedule.id} (${what}) did not run its occurrence due ${first.at} because ${holdText(holds)}.${missed > 1 ? ` ${missed} occurrences have been missed so far, the latest due ${latest.at}.` : ''} When the hold lifts, occurrences due within the last ${hours(windowMs)} run then (catch-up); older ones are skipped and recorded as schedule.missed. A paused project still runs its scheduled maintenance.backup; every other schedule waits for the pause to end.`;
  if (open) {
    if (item.missed !== missed || digest(item.holds) !== digest(holds)) store.put('inbox', { ...item, holds, missed, latestOccurrence: latest, summary, updatedAt: at });
    return moved;
  }
  const old = store.get('inbox', id);
  store.put('inbox', { id, kind: 'notice', role: 'operator', status: 'open', version: (old?.version ?? 0) + 1, createdBy: 'factory', createdAt: at, updatedAt: at,
    title: `Schedule ${schedule.id} is held: its ${what} occurrence due ${first.at} did not run (${holds.join(', ')})`,
    summary, scheduleId: schedule.id, operation: schedule.operation ?? null, occurrence: first, latestOccurrence: latest, missed, holds });
  store.event('schedule.held', { scheduleId: schedule.id, inboxId: id, occurrenceKey: first.key, holds });
  schedule.heldNotice = id;
  return true;
}
function settleHeldNotice(store, schedule, at, released, windowMs) {
  const id = schedule.heldNotice, item = id ? store.get('inbox', id) : null;
  if (item?.status === 'open') {
    if (released) { store.put('inbox', { ...item, status: 'resolved', resolvedAt: at, resolution: `The hold lifted at ${at}. Occurrences due within the last ${hours(windowMs)} were triggered by the usual catch-up; any older ones were skipped and recorded as schedule.missed.`, version: item.version + 1 }); store.event('schedule.hold-released', { scheduleId: schedule.id, inboxId: id }); }
    else { store.put('inbox', { ...item, status: 'superseded', supersededReason: 'the schedule was disabled or removed', version: item.version + 1 }); store.event('inbox.superseded', { inboxId: id, reason: 'schedule disabled' }); }
  }
  delete schedule.heldNotice; delete schedule.heldScannedAt;
}
const hours = ms => ms % 3600000 ? `${Math.round(ms / 60000)} minutes` : `${ms / 3600000} hours`;
const holdText = holds => holds.length === 1 ? `the project is held: ${holds[0]}` : `the project is held: ${holds.slice(0, -1).join(', ')} and ${holds.at(-1)}`;
