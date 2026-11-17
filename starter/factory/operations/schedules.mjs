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
export function dispatchSchedules(store, { nowMs = Date.now(), dispatch, trigger = dispatch, maxCatchUp = 8, windowMs = 86400000 } = {}) {
  assert(typeof trigger === 'function', 'durable trigger callback required');
  return store.tx(() => {
    const claimed = [];
    for (const schedule of store.all('schedule').filter(s => s.enabled)) {
      const afterMs = Date.parse(schedule.lastScannedAt ?? schedule.createdAt);
      assert(Number.isFinite(afterMs), 'schedule creation time required');
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
      store.put('schedule', schedule);
    }
    return claimed;
  });
}
