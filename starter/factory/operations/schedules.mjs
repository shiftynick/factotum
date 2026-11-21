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
// Every occurrence of a schedule due after `afterMs` (exclusive) up to `nowMs` (inclusive), whatever
// the catch-up window: a held schedule must say what it missed, even what catch-up will skip. Daily
// schedules are walked day by day (one zoned time per local day), interval ones by arithmetic, so a
// long hold costs little. Returns {count, first, latest}; claimed occurrences are not counted. The
// daily walk covers at most `maxDays` local days; `truncated` says earlier time was not walked.
export function heldOccurrences(store, schedule, { afterMs, nowMs, maxDays = 400 }) {
  const claimed = o => store.get('occurrence', digest(o.key));
  if (schedule.type === 'interval') {
    if (!(Number.isSafeInteger(schedule.everyMs) && schedule.everyMs >= 1000 && Number.isFinite(schedule.anchorMs))) return { count: 0 };
    const at = n => ({ key: `${schedule.id}:${n}`, at: new Date(schedule.anchorMs + n * schedule.everyMs).toISOString() });
    let first = Math.max(0, Math.floor((afterMs - schedule.anchorMs) / schedule.everyMs) + 1); const last = Math.floor((nowMs - schedule.anchorMs) / schedule.everyMs);
    // A bounded backlog claimed just before the hold sits at the start of the range.
    for (let i = 0; i < 1000 && first <= last && claimed(at(first)); i++) first++;
    return first > last ? { count: 0 } : { count: last - first + 1, first: at(first), latest: at(last) };
  }
  if (schedule.type !== 'daily' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.timeOfDay ?? '') || typeof schedule.timezone !== 'string') return { count: 0 };
  const [hh, mm] = schedule.timeOfDay.split(':').map(Number), end = localParts(nowMs, schedule.timezone), endDay = Date.UTC(+end.year, +end.month - 1, +end.day);
  let truncated = false, startMs = afterMs;
  if (endDay - maxDays * 86400000 > afterMs) { truncated = true; startMs = endDay - maxDays * 86400000; }
  const begin = localParts(startMs, schedule.timezone), found = [];
  for (let day = Date.UTC(+begin.year, +begin.month - 1, +begin.day); day <= endDay; day += 86400000) {
    const date = new Date(day);
    if (schedule.weekdays && !schedule.weekdays.includes(date.getUTCDay())) continue;
    const t = zonedTime(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hh, mm, schedule.timezone), p = localParts(t, schedule.timezone);
    // A time that does not exist that day (the spring DST change) is skipped, as dueOccurrences does.
    if (t <= startMs || t > nowMs || `${p.hour}:${p.minute}` !== schedule.timeOfDay) continue;
    const occurrence = { key: `${schedule.id}:${p.year}-${p.month}-${p.day}`, at: new Date(t).toISOString() };
    if (!claimed(occurrence)) found.push(occurrence);
  }
  return found.length ? { count: found.length, first: found[0], latest: found.at(-1), ...(truncated ? { truncated: true } : {}) } : { count: 0, ...(truncated ? { truncated: true } : {}) };
}
// A held notice is active for its hold while open or acknowledged: acknowledging it says the
// operator has seen it, not that the hold is over, so it is neither raised again nor left unsettled.
const ACTIVE = new Set(['open', 'acknowledged']);
// One held schedule: look for occurrences due since its last scan, whatever the catch-up window, and
// raise or refresh its notice. Returns whether the schedule record changed.
function heldScan(store, schedule, holds, { nowMs, afterMs, windowMs, at }) {
  const from = Math.max(afterMs, Date.parse(schedule.heldScannedAt ?? '') || afterMs);
  const found = heldOccurrences(store, schedule, { afterMs: from, nowMs }), moved = schedule.heldScannedAt !== at;
  schedule.heldScannedAt = at;
  const id = heldScheduleNoticeId(schedule.id), item = schedule.heldNotice ? store.get('inbox', id) : null, active = ACTIVE.has(item?.status);
  if (!found.count && !active) return moved;
  const first = active ? item.occurrence : found.first, latest = found.latest ?? item.latestOccurrence, missed = (active ? item.missed : 0) + found.count;
  const truncated = Boolean(found.truncated || (active && item.truncated));
  const what = schedule.recurringTask ? `recurring task ${schedule.recurringTask}` : schedule.operation;
  const summary = `Schedule ${schedule.id} (${what}) did not run its occurrence due ${first.at} because ${holdText(holds)}.${missed > 1 ? ` ${missed} occurrences have been missed so far, the latest due ${latest.at}.` : ''}${truncated ? ' Earlier occurrences may have been missed too: the hold is longer than the scan covers.' : ''} When the hold lifts, occurrences due within the last ${hours(windowMs)} run then (catch-up); older ones are skipped and recorded as schedule.missed. A paused project still runs its scheduled maintenance.backup; every other schedule waits for the pause to end.`;
  if (active) {
    if (item.missed !== missed || digest(item.holds) !== digest(holds) || Boolean(item.truncated) !== truncated) store.put('inbox', { ...item, holds, missed, latestOccurrence: latest, ...(truncated ? { truncated } : {}), summary, updatedAt: at });
    return moved;
  }
  const old = store.get('inbox', id);
  store.put('inbox', { id, kind: 'notice', role: 'operator', status: 'open', version: (old?.version ?? 0) + 1, createdBy: 'factory', createdAt: at, updatedAt: at,
    title: `Schedule ${schedule.id} is held: its ${what} occurrence due ${first.at} did not run (${holds.join(', ')})`,
    summary, scheduleId: schedule.id, operation: schedule.operation ?? null, occurrence: first, latestOccurrence: latest, missed, ...(truncated ? { truncated } : {}), holds });
  store.event('schedule.held', { scheduleId: schedule.id, inboxId: id, occurrenceKey: first.key, holds });
  schedule.heldNotice = id;
  return true;
}
function settleHeldNotice(store, schedule, at, released, windowMs) {
  const id = schedule.heldNotice, item = id ? store.get('inbox', id) : null;
  if (ACTIVE.has(item?.status)) {
    if (released) { store.put('inbox', { ...item, status: 'resolved', resolvedAt: at, resolution: `The hold lifted at ${at}. Occurrences due within the last ${hours(windowMs)} were triggered by the usual catch-up; any older ones were skipped and recorded as schedule.missed.`, version: item.version + 1 }); store.event('schedule.hold-released', { scheduleId: schedule.id, inboxId: id }); }
    else { store.put('inbox', { ...item, status: 'superseded', supersededReason: 'the schedule was disabled or removed', version: item.version + 1 }); store.event('inbox.superseded', { inboxId: id, reason: 'schedule disabled' }); }
  }
  delete schedule.heldNotice; delete schedule.heldScannedAt;
}
const hours = ms => ms % 3600000 ? `${Math.round(ms / 60000)} minutes` : `${ms / 3600000} hours`;
const holdText = holds => holds.length === 1 ? `the project is held: ${holds[0]}` : `the project is held: ${holds.slice(0, -1).join(', ')} and ${holds.at(-1)}`;
