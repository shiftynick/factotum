import { readFileSync } from 'node:fs';
import { assert, now } from '../core/contracts.mjs';
export function parseMachineSample({ loadavg, meminfo, uptime, stat }, observedAt = now()) {
  assert(Number.isFinite(Date.parse(observedAt)), 'machine observation time required');
  const loadAverage = loadavg.trim().split(/\s+/).slice(0, 3).map(Number);
  assert(loadAverage.length === 3 && loadAverage.every(n => Number.isFinite(n) && n >= 0), 'invalid Linux load averages');
  const uptimeSeconds = Number(uptime.trim().split(/\s+/)[0]); assert(Number.isFinite(uptimeSeconds) && uptimeSeconds >= 0, 'invalid Linux uptime');
  const fields = {};
  for (const line of meminfo.split('\n')) { const match = /^(MemTotal|MemAvailable|SwapTotal|SwapFree):\s+(\d+)\s+kB\s*$/.exec(line); if (match) fields[match[1]] = Number(match[2]) * 1024; }
  assert(Number.isSafeInteger(fields.MemTotal) && fields.MemTotal > 0 && Number.isSafeInteger(fields.MemAvailable) && fields.MemAvailable >= 0 && fields.MemAvailable <= fields.MemTotal, 'invalid Linux memory aggregates');
  // Cumulative CPU ticks: utilisation and disk wait come from the difference between two samples.
  const cpu = stat ? /^cpu\s+(.+)$/m.exec(stat)?.[1].trim().split(/\s+/).map(Number) : null;
  const cpuTicks = cpu?.length >= 5 && cpu.every(Number.isFinite) ? { total: cpu.slice(0, 8).reduce((a, b) => a + b, 0), idle: cpu[3], iowait: cpu[4] } : null;
  const swap = Number.isSafeInteger(fields.SwapTotal) && Number.isSafeInteger(fields.SwapFree) ? { total: fields.SwapTotal, free: fields.SwapFree } : null;
  return { observedAt, uptimeSeconds, loadAverage, memoryBytes: { total: fields.MemTotal, available: fields.MemAvailable }, ...(swap ? { swapBytes: swap } : {}), ...(cpuTicks ? { cpuTicks } : {}) };
}
export function sampleMachine({ read = readFileSync, observedAt = now() } = {}) {
  let stat = null; try { stat = read('/proc/stat', 'utf8'); } catch { /* utilisation is optional */ }
  return parseMachineSample({ loadavg: read('/proc/loadavg', 'utf8'), meminfo: read('/proc/meminfo', 'utf8'), uptime: read('/proc/uptime', 'utf8'), stat }, observedAt);
}
// Light host samples for the Timeline's machine charts, taken by the operations loop.
// Kept apart from machine.sample evidence, keyed by time, and pruned after a retention window.
export const HOST_SAMPLE_MS = 120000, HOST_SAMPLE_RETENTION_MS = 8 * 86400000;
export function recordHostSample(store, { nowMs = Date.now(), everyMs = HOST_SAMPLE_MS, sample = sampleMachine } = {}) {
  const last = store.meta('hostSampleAt');
  if (last && nowMs - Date.parse(last) < everyMs) return null;
  let row; try { row = sample({ observedAt: new Date(nowMs).toISOString() }); } catch { store.setMeta('hostSampleAt', new Date(nowMs).toISOString()); return null; }
  store.tx(() => {
    store.put('hostSample', { id: row.observedAt, ...row });
    store.db.prepare("DELETE FROM records WHERE kind='hostSample' AND id < ?").run(new Date(nowMs - HOST_SAMPLE_RETENTION_MS).toISOString());
    store.setMeta('hostSampleAt', row.observedAt);
  });
  return row;
}
export function hostSamples(store, fromIso, toIso) {
  return store.db.prepare("SELECT data FROM records WHERE kind='hostSample' AND id >= ? AND id <= ? ORDER BY id").all(fromIso, toIso).map(r => JSON.parse(r.data));
}
