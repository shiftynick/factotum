import { assert } from '../core/contracts.mjs';
import { hostSamples } from './sampling.mjs';
import { flowsSince, inboxSince } from '../core/records.mjs';

// The project timeline: what each slot did over a window, the events that mattered and
// how the machine was doing. Read on demand by the console; nothing here is authority.
export const TIMELINE_HOURS = Object.freeze([6, 12, 24, 72]);
const OPERATION_CATEGORY = { 'provider.build': 'building', 'provider.review': 'review', 'provider.planReview': 'review', 'forge.followup': 'review', 'provider.plan': 'planning', gate: 'checks', fastCheck: 'checks' };
const POOLS = [['change', 'Change slots'], ['document', 'Document flows'], ['task', 'Task flows'], ['maintenance', 'Maintenance']];
// Where a flow's bar ends: its finish, its abandonment, or now while it is still active.
const finished = flow => ['completed', 'failed'].includes(flow.state);
const flowEnd = (flow, nowMs) => Date.parse(flow.finishedAt ?? flow.abandonedAt) || (finished(flow) ? Date.parse(flow.createdAt) : nowMs);
// Flows of the removed planning-ahead feature have no lane.
const poolOf = flow => flow.kind === 'planning' ? null : ['task', 'maintenance'].includes(flow.kind) ? flow.kind : flow.pool === 'document' ? 'document' : 'change';
const iso = t => new Date(t).toISOString();

// What a step does, from the operation its node runs.
export function stepCategory(flow, step) {
  const node = flow.workflow?.nodes?.[step], operation = node?.action?.operation;
  if (OPERATION_CATEGORY[operation]) return OPERATION_CATEGORY[operation];
  if (node?.evidence === 'gate' || /^check:/.test(node?.evidence ?? '')) return 'checks';
  if (node?.evidence === 'review') return 'review';
  return 'other';
}

function flowSegments(store, flow, attempts, waits, { from, to, nowMs }) {
  const start = Date.parse(flow.createdAt), end = flowEnd(flow, nowMs), segments = [];
  const add = (a, b, category, extra = {}) => { const s = Math.max(a, from), e = Math.min(b, to); if (Number.isFinite(s) && Number.isFinite(e) && e > s) segments.push({ start: iso(s), end: iso(e), category, ...extra }); };
  for (const attempt of attempts) {
    const a = Date.parse(attempt.receipt?.startedAt ?? attempt.dispatchedAt ?? attempt.createdAt), b = Date.parse(attempt.receipt?.endedAt ?? attempt.settledAt) || (attempt.settledAt ? a : Math.min(nowMs, end));
    add(a, b, stepCategory(flow, attempt.step), { step: attempt.step, attemptId: attempt.id, status: attempt.status });
  }
  for (const wait of waits) {
    const a = Date.parse(wait.startedAt), b = Date.parse(wait.endedAt) || Math.min(nowMs, end);
    const role = wait.kind === 'question' ? store.get('inbox', wait.inboxId)?.role ?? 'operator' : null;
    add(a, b, wait.kind === 'question' ? `waiting-${role === 'orchestrator' ? 'orchestrator' : 'operator'}` : wait.kind === 'heavy-resource' ? 'waiting-machine' : 'waiting', { wait: wait.kind });
  }
  if (flow.state === 'stopped' && !finished(flow)) {
    const last = Math.max(start, ...segments.map(s => Date.parse(s.end)));
    add(last, nowMs, 'stopped');
  }
  return segments.sort((a, b) => a.start.localeCompare(b.start));
}

export function projectTimeline(store, { hours = 12, nowMs = Date.now() } = {}) {
  assert(TIMELINE_HOURS.includes(hours), `timeline window must be one of ${TIMELINE_HOURS.join(', ')} hours`);
  const to = nowMs, from = nowMs - hours * 3600000, policy = store.meta('config', {}).policy ?? {};
  // Candidates: unfinished flows and those finished within a day before the window; the filter is exact.
  const since = iso(from - 86400000), flows = flowsSince(store, since).filter(f => Number.isFinite(Date.parse(f.createdAt)) && Date.parse(f.createdAt) < to && (flowEnd(f, nowMs)) > from);
  const ids = new Set(flows.map(f => f.id));
  const attempts = flows.flatMap(f => store.by('attempt', 'flowId', f.id)), waits = flows.flatMap(f => store.by('wait', 'flowId', f.id));
  const capacity = { change: policy.maxFlows ?? policy.maxActiveFlows ?? 1, document: 0, task: 0, maintenance: 0 };
  const pools = POOLS.map(([kind, label]) => {
    const members = flows.filter(f => poolOf(f) === kind).sort((a, b) => a.createdAt.localeCompare(b.createdAt)), ends = [], lanes = [];
    // Each flow takes the first slot free when it was admitted.
    for (const flow of members) {
      const start = Date.parse(flow.createdAt), end = flowEnd(flow, nowMs);
      let lane = ends.findIndex(e => e <= start); if (lane < 0) { lane = ends.length; ends.push(0); lanes.push([]); }
      ends[lane] = end; lanes[lane].push(flow);
    }
    while (lanes.length < capacity[kind]) lanes.push([]);
    return { kind, label, capacity: capacity[kind], lanes: lanes.map((row, index) => {
      const current = row.find(f => !['completed', 'failed'].includes(f.state));
      return { index: index + 1, current: current ? { flowId: current.id, taskId: current.taskId, title: current.taskSnapshot?.title ?? current.taskId, state: current.state, step: current.step, category: current.state === 'stopped' ? 'stopped' : current.state === 'waiting' ? 'waiting' : stepCategory(current, current.step) } : null,
        flows: row.map(f => ({ id: f.id, taskId: f.taskId, title: f.taskSnapshot?.title ?? f.taskId, kind: f.kind ?? 'change', state: f.state, start: iso(Math.max(Date.parse(f.createdAt), from)), end: iso(Math.min(flowEnd(f, nowMs), to)), open: !finished(f), segments: flowSegments(store, f, attempts.filter(a => a.flowId === f.id), waits.filter(w => w.flowId === f.id), { from, to, nowMs }) })) };
    }) };
  }).filter(pool => pool.kind === 'change' || pool.lanes.some(lane => lane.flows.length));

  const events = [];
  for (const f of flows) {
    const endAt = f.finishedAt ?? f.abandonedAt, at = Date.parse(endAt);
    if (!(at >= from && at <= to)) continue;
    const title = f.taskSnapshot?.title ?? f.taskId;
    if (poolOf(f) === 'change' && f.state === 'completed' && f.results?.merge?.merged) events.push({ at: endAt, type: 'merged', flowId: f.id, label: `Merged: ${title}`, ref: f.taskSnapshot?.source?.issue ?? null });
    else if (f.state === 'failed') events.push({ at: endAt, type: 'failed', flowId: f.id, label: `${f.abandonedAt ? 'Abandoned' : 'Failed'}: ${title}` });
  }
  for (const item of inboxSince(store, since).filter(q => q.kind === 'question' && Date.parse(q.createdAt) >= from && Date.parse(q.createdAt) <= to)) events.push({ at: item.createdAt, type: `question-${item.role === 'orchestrator' ? 'orchestrator' : 'operator'}`, flowId: item.flowId ?? null, label: `Question for the ${item.role ?? 'operator'}: ${String(item.question ?? item.title ?? '').slice(0, 120)}` });
  for (const row of store.db.prepare("SELECT at, type, payload FROM events WHERE at >= ? AND at <= ? AND type IN ('flow.stopped','upgrade.activated','config.updated')").all(iso(from), iso(to))) {
    const payload = JSON.parse(row.payload);
    events.push(row.type === 'flow.stopped' ? { at: row.at, type: 'stopped', flowId: payload.flowId ?? null, label: `Stopped${payload.reason ? `: ${payload.reason}` : ''}` } : { at: row.at, type: row.type === 'upgrade.activated' ? 'upgrade' : 'config', flowId: null, label: row.type === 'upgrade.activated' ? 'Upgrade activated' : `Configuration updated${payload.note ? `: ${payload.note}` : ''}` });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  // Machine: utilisation and disk wait from consecutive CPU counters; at most ~360 points.
  const samples = hostSamples(store, iso(from - 600000), iso(to)), machine = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i], prev = samples[i - 1], dt = prev?.cpuTicks && s.cpuTicks ? s.cpuTicks.total - prev.cpuTicks.total : 0;
    if (Date.parse(s.observedAt) < from) continue;
    machine.push({ at: s.observedAt, cpu: dt > 0 ? Math.max(0, 1 - (s.cpuTicks.idle - prev.cpuTicks.idle + s.cpuTicks.iowait - prev.cpuTicks.iowait) / dt) : null, iowait: dt > 0 ? Math.max(0, (s.cpuTicks.iowait - prev.cpuTicks.iowait) / dt) : null,
      memoryUsed: s.memoryBytes.total - s.memoryBytes.available, memoryTotal: s.memoryBytes.total, swapUsed: s.swapBytes ? s.swapBytes.total - s.swapBytes.free : null, swapTotal: s.swapBytes?.total ?? null, load1: s.loadAverage?.[0] ?? null });
  }
  const stride = Math.max(1, Math.ceil(machine.length / 360));

  const changeLanes = pools.find(p => p.kind === 'change').lanes, slotMs = changeLanes.length * (to - from);
  const busyMs = changeLanes.reduce((sum, lane) => sum + lane.flows.reduce((n, f) => n + (Date.parse(f.end) - Date.parse(f.start)), 0), 0);
  return {
    window: { from: iso(from), to: iso(to), hours },
    pools, events, machine: machine.filter((_, i) => i % stride === 0 || i === machine.length - 1),
    stats: { merged: events.filter(e => e.type === 'merged').length, completed: flows.filter(f => f.state === 'completed' && Date.parse(f.finishedAt) >= from).length, idleSlotMs: Math.max(0, slotMs - busyMs), slotMs },
  };
}
