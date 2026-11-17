import { ACCOUNTING_VERSION, isModelOperation, projectUsage, usageEstimate, emptyTokens, inputTokens, totalTokens } from './usage-accounting.mjs';
import { assert } from '../core/contracts.mjs';
import { stepCategory } from './timeline-view.mjs';
import { nodeContract } from '../core/operations.mjs';
import { providerLimitView } from './provider-limits.mjs';
import { attemptOperations } from '../core/records.mjs';
import { upkeepMode } from '../core/upkeep-config.mjs';
import { upkeepDayId, upkeepWindow } from './upkeep-records.mjs';

// Project statistics over a window, per period. Read on demand by the console; nothing here
// is authority. A flow counts in the period it ended (merged, completed or failed); a stop
// counts when it happened. Every figure carries its sample size, and a period resting on
// fewer than FEW samples is marked so it is not read as a trend.
export const STATS_WINDOWS = Object.freeze({ '7d': { unit: 'day', count: 7, label: 'By day, last 7 days' }, '30d': { unit: 'day', count: 30, label: 'By day, last 30 days' }, '12w': { unit: 'week', count: 12, label: 'By week, last 12 weeks' } });
export const FEW = 5;
const DAY = 86400000, MAX_IDS = 60;
const ended = f => ['completed', 'failed'].includes(f.state);
const ms = v => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : null; };
const span = (a, b) => { const x = ms(a), y = ms(b); return x !== null && y !== null && y >= x ? y - x : null; };
const median = values => { const v = values.filter(Number.isFinite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
const mean = values => { const v = values.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const pct = (hits, total) => total ? Math.round(hits / total * 1000) / 10 : null;
export const poolOf = f => f.kind === 'task' ? 'task' : f.kind === 'maintenance' ? 'maintenance' : f.kind === 'planning' ? null : f.pool === 'document' ? 'document' : 'change';
const operationOf = f => f.workflow?.nodes?.[f.workflow?.start]?.action?.operation ?? f.taskSnapshot?.title?.replace(/^Maintenance: /, '') ?? 'maintenance';
// Compatibility exports now require a qualified observation; raw legacy records are unknown.
export function tokens(usage, observation) {
  return projectUsage([{ id: 'single', receipt: { actionResult: { provider: observation?.provider, sessionId: observation?.sessionId, usage, usageObservation: observation } } }])[0]?.tokens ?? null;
}
export function stepEstimate(result, pricing = {}) {
  const entry = projectUsage([{ id: 'single', receipt: { actionResult: result } }])[0];
  return entry ? usageEstimate(entry, pricing) : null;
}
export const BREAKDOWN = [['planning', 'Planning'], ['building', 'Building'], ['review', 'Review'], ['checks', 'Checks'], ['waiting-machine', 'Waiting for the machine'], ['waiting-operator', 'Waiting on you'], ['waiting-orchestrator', 'Waiting on the orchestrator'], ['other', 'Other steps']];

// Period boundaries ending now: whole UTC days, or weeks starting Monday.
function periods(window, nowMs) {
  const w = STATS_WINDOWS[window], today = Math.floor(nowMs / DAY) * DAY;
  const end = w.unit === 'day' ? today + DAY : today + DAY * (7 - ((new Date(today).getUTCDay() + 6) % 7));
  const size = w.unit === 'day' ? DAY : 7 * DAY;
  return Array.from({ length: w.count }, (_, i) => { const start = end - (w.count - i) * size; return { start, end: start + size, label: new Date(start).toISOString().slice(5, 10) }; });
}

export function projectStats(store, { window = '7d', nowMs = Date.now() } = {}) {
  assert(STATS_WINDOWS[window], `stats window must be one of ${Object.keys(STATS_WINDOWS).join(', ')}`);
  const buckets = periods(window, nowMs), from = buckets[0].start, to = buckets.at(-1).end;
  const inWindow = t => t !== null && t >= from && t < to, bucketOf = t => buckets.findIndex(b => t >= b.start && t < b.end);
  const flows = store.all('flow'), attemptsByFlow = new Map(), waitsByFlow = new Map(), inbox = store.all('inbox');
  // Attempts are read without their dispatch intents. The operation each ran comes from the
  // intent index; a whole intent is loaded only to attribute a model step whose receipt names no invocation.
  const allAttempts = store.stored('attempt'), operations = attemptOperations(store);
  // The model operations are the counting function's own (operations/usage-accounting.mjs), so Stats
  // counts an upkeep assessment as it counts any model step.
  const modelStep = isModelOperation;
  // An attempt whose own record has an intent member has that intent (core/records.mjs), whatever the index says.
  const inline = a => Object.hasOwn(a, 'intent');
  // A whole intent is loaded only for a model step whose receipt names no invocation. An upkeep
  // assessment's receipt always carries the list, and an empty one needs only the operation.
  const listed = a => Array.isArray(a.receipt?.actionResult?.providerInvocations);
  const intentOf = a => inline(a) ? a.intent : modelStep(operations(a.id)) && !(operations(a.id) === 'knowledge.upkeep' && listed(a)) ? store.intent(a.id) : { action: { operation: operations(a.id) } };
  const usage = projectUsage(allAttempts, { intentOf }), usageByAttempt = new Map();
  for (const entry of usage) { if (!usageByAttempt.has(entry.attemptId)) usageByAttempt.set(entry.attemptId, []); usageByAttempt.get(entry.attemptId).push(entry); }
  for (const a of allAttempts) { if (!attemptsByFlow.has(a.flowId)) attemptsByFlow.set(a.flowId, []); attemptsByFlow.get(a.flowId).push(a); }
  for (const w of store.all('wait')) { if (!waitsByFlow.has(w.flowId)) waitsByFlow.set(w.flowId, []); waitsByFlow.get(w.flowId).push(w); }
  const events = (types) => store.db.prepare(`SELECT at, type, payload FROM events WHERE at >= ? AND at < ? AND type IN (${types.map(() => '?').join(',')})`).all(new Date(from).toISOString(), new Date(to).toISOString(), ...types).map(e => ({ ...e, payload: JSON.parse(e.payload) }));
  // Who caused each flow event. Events record it from dev.53 on (by); for older ones, the command
  // receipt written in the same transaction, right after them, names its actor.
  // An older event with no command right after it was the factory's own; a task update the
  // source sync made (while a sync was running) was a source change, not the operator.
  const flowEvents = store.db.prepare("SELECT sequence, at, type, payload FROM events WHERE type IN ('flow.stopped','flow.resumed','flow.replan','flow.abandoned','attempt.reconciled','source.sync') OR type LIKE 'command.%' ORDER BY sequence").all().map(e => ({ ...e, payload: JSON.parse(e.payload) }));
  let syncing = false;
  for (const e of flowEvents) { if (e.type === 'source.sync') syncing = e.payload.status === 'running'; else if (e.type.startsWith('command.')) e.duringSync = syncing; }
  for (let i = 0; i < flowEvents.length; i++) {
    const e = flowEvents[i]; if (e.type.startsWith('command.') || e.type === 'source.sync' || e.payload.by !== undefined) continue;
    // The receipt of the same transaction comes next, within moments, with nothing from another
    // actor or a sync in between; otherwise the event was the factory's own.
    let next = null;
    for (const x of flowEvents.slice(i + 1, i + 12)) { if (x.type.startsWith('command.')) { next = x; break; } if (x.type === 'source.sync' || x.payload.by !== undefined && !['attempt.reconciled'].includes(x.type)) break; }
    const command = next && next.type === 'command.completed' && next.sequence - e.sequence < 50 && Math.abs(ms(next.at) - ms(e.at)) < 500 ? next : null;
    e.payload.by = !command ? 'factory' : command.payload.operation === 'task.put' && command.duringSync ? 'source' : command.payload.actor;
  }
  const abandonedBy = new Map(flowEvents.filter(e => e.type === 'flow.abandoned').map(e => [e.payload.flowId, e.payload]));
  // The orchestrator stepping in: anything it did on a flow beyond the routine answer its
  // configured role asks of it (merging or accepting the candidate it was asked about).
  const routine = q => q.answeredBy === 'orchestrator' && q.role === 'orchestrator' && ['merge', 'accept'].includes(q.answer);
  const interventions = new Map(), routineAnswers = [];
  for (const q of inbox.filter(q => q.status === 'answered' && q.answeredBy === 'orchestrator' && q.flowId)) { if (routine(q)) routineAnswers.push(q); else interventions.set(q.flowId, [...(interventions.get(q.flowId) ?? []), q.answer]); }
  for (const e of flowEvents.filter(e => !e.type.startsWith('command.') && e.payload.by === 'orchestrator')) { const id = e.payload.flowId ?? store.get('attempt', e.payload.attemptId)?.flowId; if (id) interventions.set(id, [...(interventions.get(id) ?? []), e.type.replace(/^flow\./, '')]); }
  const answeredOrchestrator = new Set(interventions.keys());
  const replans = new Map(); for (const e of store.db.prepare("SELECT payload FROM events WHERE type = 'flow.replan'").all()) { const id = JSON.parse(e.payload).flowId; replans.set(id, (replans.get(id) ?? 0) + 1); }
  const referenced = new Map(), ref = f => { referenced.set(f.id, { title: f.taskSnapshot?.title ?? f.taskId ?? f.id, pool: poolOf(f), state: f.state }); return f.id; };

  // The subscription estimate of a flow's model steps, by role; unknown steps are counted, not priced.
  const pricing = store.meta('config', {}).stats?.pricing ?? {}, ROLES = ['planner', 'builder', 'reviewer'];
  const costOf = (f, attempts) => {
    const byRole = { planner: 0, builder: 0, reviewer: 0, other: 0 }, unknownByRole = { planner: 0, builder: 0, reviewer: 0, other: 0 }, knownByRole = { planner: 0, builder: 0, reviewer: 0, other: 0 }; let steps = 0, unknown = 0, tokensTotal = 0, tokensInput = 0, tokensKnown = 0;
    for (const a of attempts) for (const entry of usageByAttempt.get(a.id) ?? []) {
      if (entry.duplicate) continue;
      let role = 'other'; try { role = nodeContract(a.step, f.workflow?.nodes?.[a.step] ?? {}).role ?? 'other'; } catch {}
      if (!ROLES.includes(role)) role = 'other';
      const usd = usageEstimate(entry, pricing), t = entry.tokens; steps++; if (t) { tokensTotal += totalTokens(t); tokensInput += inputTokens(t); tokensKnown++; }
      if (usd === null) { unknown++; unknownByRole[role]++; } else { byRole[role] += usd; knownByRole[role]++; }
    }
    return { cost: steps ? Object.values(byRole).reduce((a, b) => a + b, 0) : null, costByRole: byRole, unknownByRole, knownByRole, costSteps: steps, costUnknown: unknown, tokensTotal, tokensInput, tokensKnown };
  };
  // Facts for each flow that ended in the window.
  const fact = f => {
    const attempts = attemptsByFlow.get(f.id) ?? [], waits = waitsByFlow.get(f.id) ?? [], op = a => (inline(a) ? a.intent?.action?.operation : operations(a.id)) ?? f.workflow?.nodes?.[a.step]?.action?.operation;
    const run = a => span(a.receipt?.startedAt, a.receipt?.endedAt), settled = a => ['passed', 'failed'].includes(a.status);
    const parts = Object.fromEntries(BREAKDOWN.map(([k]) => [k, 0]));
    for (const a of attempts) { const t = run(a); if (t === null) continue; const c = stepCategory(f, a.step); parts[['planning', 'building', 'review', 'checks'].includes(c) ? c : 'other'] += t; }
    for (const w of waits) { const t = span(w.startedAt, w.endedAt ?? f.finishedAt); if (t === null) continue; const role = w.kind === 'question' ? inbox.find(q => q.id === w.inboxId)?.role : null; parts[w.kind === 'heavy-resource' ? 'waiting-machine' : role === 'orchestrator' ? 'waiting-orchestrator' : w.kind === 'question' ? 'waiting-operator' : 'other'] += t; }
    const total = span(f.createdAt, f.finishedAt ?? f.abandonedAt);
    if (total !== null) parts.other += Math.max(0, total - Object.values(parts).reduce((a, b) => a + b, 0));
    const reviews = attempts.filter(a => op(a) === 'provider.review' && settled(a)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const builds = attempts.filter(a => op(a) === 'provider.build' && a.status === 'passed'), gates = attempts.filter(a => op(a) === 'gate' && settled(a));
    return { flow: f, pool: poolOf(f), at: ms(f.finishedAt ?? f.abandonedAt), total, parts, merged: f.results?.merge?.merged === true, planned: Boolean(f.results?.plan),
      reviewRounds: reviews.length, firstReviewPass: reviews.length ? ['pass', 'defer'].includes(reviews[0].receipt?.actionResult?.route) : null, buildRounds: builds.length,
      gateRuns: gates.length, gateFailures: gates.filter(a => a.receipt?.actionResult?.route === 'fail').length, gateInfra: gates.filter(a => a.receipt?.actionResult?.route === 'blocked').length,
      checkTime: gates.reduce((sum, a) => sum + (run(a) ?? 0), 0), gates, ...costOf(f, attempts), orchestrator: answeredOrchestrator.has(f.id), replans: replans.get(f.id) ?? 0, operation: operationOf(f) };
  };
  const finished = flows.filter(f => ended(f) && inWindow(ms(f.finishedAt ?? f.abandonedAt)) && poolOf(f)).map(fact);
  const of = pool => finished.filter(x => x.pool === pool), delivered = finished.filter(x => ['change', 'document'].includes(x.pool) && x.merged);
  const work = finished.filter(x => x.pool !== 'maintenance');

  // Build one metric: a headline over the window and a value per period.
  const metric = (id, title, rows, { kind, value, note, sampleUnit = 'changes', at = r => r.at, parts, headline }) => {
    const per = buckets.map(b => rows.filter(r => { const t = at(r); return t !== null && t >= b.start && t < b.end; }));
    const reduce = list => kind === 'count' ? list.length : kind === 'usd' ? mean(list.map(value)) : kind === 'percent' ? pct(list.filter(value).length, list.length) : kind === 'mean' ? mean(list.map(value)) : median(list.map(value));
    const row = (list, b) => ({ label: b.label, value: reduce(list), n: list.length, flowIds: list.slice(0, MAX_IDS).map(r => r.flow ? ref(r.flow) : r.id).filter(Boolean), ...(parts ? { parts: Object.fromEntries(parts.map(([k]) => [k, mean(list.map(r => r.parts[k])) ?? 0])) } : {}) });
    return { id, title, kind, note, sampleUnit, headline: headline ?? reduce(rows), n: rows.length, hits: kind === 'percent' ? rows.filter(value).length : rows.length, ...(parts ? { legend: parts.map(([k, l]) => [k, l, mean(rows.map(r => r.parts[k])) ?? 0]) } : {}), buckets: per.map((list, i) => row(list, buckets[i])) };
  };
  const changeLike = finished.filter(x => ['change', 'document'].includes(x.pool));
  // A stop counts once until the flow is resumed; a repeated stop of a stopped flow is not another stop.
  const lastStop = new Map(), distinctStops = [];
  for (const e of flowEvents) { const id = e.payload.flowId; if (e.type === 'flow.resumed') lastStop.delete(id); else if (e.type === 'flow.stopped' && !lastStop.has(id)) { lastStop.set(id, e); distinctStops.push(e); } }
  const stops = distinctStops.filter(e => inWindow(ms(e.at))).map(e => ({ id: e.payload.flowId, flow: flows.find(f => f.id === e.payload.flowId), at: ms(e.at), by: e.payload.by, reason: String(e.payload.reason ?? 'stopped').replace(/^operator reconciled uncertain attempt$/, `the ${e.payload.by ?? 'operator'} reconciled an uncertain attempt`) })).filter(s => s.flow && poolOf(s.flow) && poolOf(s.flow) !== 'maintenance');

  const throughput = [
    metric('merged', 'Changes merged', of('change').filter(x => x.merged), { kind: 'count' }),
    metric('documents', 'Documents merged', of('document').filter(x => x.merged), { kind: 'count', sampleUnit: 'documents' }),
    metric('tasks', 'Tasks completed', of('task').filter(x => x.flow.state === 'completed'), { kind: 'count', sampleUnit: 'tasks' }),
    metric('failed', 'Failed or abandoned', work.filter(x => x.flow.state === 'failed'), { kind: 'count', sampleUnit: 'flows', note: 'Changes, documents and tasks that ended without completing.' }),
    metric('duration', 'Start of work to merge', delivered, { kind: 'duration', value: r => r.total, parts: BREAKDOWN, note: 'The bar splits the average merged change, from the start of work to the end of its flow; the number is the median.' }),
  ];
  const queueWaits = store.all('queue').filter(q => q.admissionTiming && inWindow(ms(q.claimedAt))).map(q => ({ id: q.flowId ?? q.id, flow: flows.find(f => f.id === q.flowId), at: ms(q.claimedAt), wait: span(q.queuedAt, q.claimedAt) })).filter(q => q.wait !== null);
  throughput.push(metric('queue', 'Time in the queue', queueWaits, { kind: 'duration', value: r => r.wait, at: r => r.at, sampleUnit: 'starts', note: 'From being queued to the start of work; not part of the time above.' }));

  const quality = [
    metric('first-review', 'Passed their first review', delivered.filter(x => x.firstReviewPass !== null), { kind: 'percent', value: r => r.firstReviewPass }),
    metric('no-fix', 'Merged with one build', delivered.filter(x => x.buildRounds > 0), { kind: 'percent', value: r => r.buildRounds === 1, note: 'Merged without a second build round for review findings or failed checks.' }),
    metric('review-rounds', 'Review rounds per merged change', delivered, { kind: 'mean', value: r => r.reviewRounds }),
    metric('build-rounds', 'Build rounds per merged change', delivered, { kind: 'mean', value: r => r.buildRounds }),
    metric('stopped', 'Stops', stops, { kind: 'count', sampleUnit: 'stops', note: 'Work stopped by a person, a failure or a changed brief. Click a bar for the flows.' }),
    metric('orchestrator', 'The orchestrator stepped in', changeLike, { kind: 'percent', value: r => r.orchestrator, note: 'Changes and documents where the orchestrator sent work back, retried, replanned, resumed, stopped, abandoned, reconciled a step, or answered for you. Its routine merge answers are not counted.' }),
    metric('routine', 'Routine orchestrator decisions', routineAnswers.map(q => ({ flow: flows.find(f => f.id === q.flowId), at: ms(q.answeredAt) })).filter(r => r.flow && inWindow(r.at)), { kind: 'count', sampleUnit: 'answers', note: 'Merge or accept answers the orchestrator gave as the configured decision role.' }),
    metric('replans', 'Replans per change', changeLike, { kind: 'mean', value: r => r.replans }),
  ];
  if (changeLike.some(x => x.planned) && changeLike.some(x => !x.planned)) quality.push(
    metric('planned-reviews', 'Review rounds, planned changes', delivered.filter(x => x.planned), { kind: 'mean', value: r => r.reviewRounds }),
    metric('unplanned-reviews', 'Review rounds, unplanned changes', delivered.filter(x => !x.planned), { kind: 'mean', value: r => r.reviewRounds }));

  // Must-fix flows (review-must-fix design 12.3 and 16.1; test fixtures only until the enabling release),
  // only when the window has one, so a severity project's stats are unchanged: parks at the cap or on a
  // protocol failure, operator items, follow-ups, deferrals and acknowledgements per flow, verdict
  // overrides, and findings in earlier fixes or missed by earlier rounds. From the records each flow
  // keeps (its review history, its stored ledger and its decision); shadow estimates are not counted here.
  const mustFixFlows = changeLike.filter(x => x.flow.reviewBar === 'must-fix');
  if (mustFixFlows.length) {
    const entries = f => Array.isArray(f.reviewLedger?.entries) ? f.reviewLedger.entries : [], enforced = f => (f.reviewHistory ?? []).map(row => row?.mustFix?.enforcement).filter(Boolean);
    const reviewRows = mustFixFlows.flatMap(x => enforced(x.flow).map(row => ({ flow: x.flow, at: x.at, overridden: row.verdictOverridden === true })));
    quality.push(
      metric('mustfix-parked', 'Must-fix flows parked at the cap or on a protocol failure', mustFixFlows, { kind: 'percent', value: r => enforced(r.flow).some(row => ['must-fix-cap', 'budget', 'protocol-failure'].includes(row.disposition)), note: 'Parked for the operator by the must-fix cap, the budget check or a second contradictory review.' }),
      metric('mustfix-operator-items', 'Operator items per must-fix flow', mustFixFlows, { kind: 'mean', value: r => entries(r.flow).filter(e => e.kind === 'operator-item').length }),
      metric('mustfix-follow-ups', 'Follow-ups per must-fix flow', mustFixFlows, { kind: 'mean', value: r => entries(r.flow).filter(e => e.kind === 'follow-up').length }),
      metric('mustfix-deferrals', 'Builder deferrals per must-fix flow', mustFixFlows, { kind: 'mean', value: r => entries(r.flow).filter(e => e.deferral).length }),
      metric('mustfix-acknowledgements', 'Acknowledgements per must-fix flow', mustFixFlows, { kind: 'mean', value: r => (r.flow.mergeAuthorization ?? r.flow.completionDecision)?.acknowledgedFindings?.length ?? 0, note: 'Findings the operator (or the strict decision role) acknowledged by id and claim digest at the merge or satisfied question.' }),
      metric('mustfix-overrides', 'Reviews whose verdict the must-fix route overrode', reviewRows, { kind: 'percent', value: r => r.overridden, sampleUnit: 'reviews' }),
      metric('mustfix-late', 'In-fix and missed findings per must-fix flow', mustFixFlows, { kind: 'mean', value: r => entries(r.flow).filter(e => ['in-fix', 'missed'].includes(e.origin)).length, note: 'Findings in code an earlier round\'s fix added, or in code an earlier round reviewed without reporting them.' }));
  }

  // Checks: per change, and per configured check.
  const gated = changeLike.filter(x => x.gateRuns);
  const checksMetrics = [
    metric('check-time', 'Check time per change', gated, { kind: 'duration', value: r => r.checkTime, note: 'All gate runs of a change, not counting the wait for the machine.' }),
    metric('check-runs', 'Gate runs', gated.flatMap(x => x.gates.map(a => ({ flow: x.flow, at: x.at }))), { kind: 'count', sampleUnit: 'runs' }),
    metric('check-fail', 'Gate runs that failed', gated, { kind: 'percent', value: r => r.gateFailures > 0, note: 'Changes with at least one failed gate run.' }),
    metric('check-infra', 'Failed on the machine', gated, { kind: 'percent', value: r => r.gateInfra > 0, note: 'A gate run blocked for machine reasons (a missing tool, a timeout), not the change.' }),
  ];
  const checkRows = new Map();
  for (const x of gated) for (const a of x.gates) for (const c of a.receipt?.actionResult?.checks ?? []) {
    const row = checkRows.get(c.id) ?? { id: c.id, runs: 0, failed: 0, times: [], flows: new Set() }; row.runs++; if (c.status !== 'passed') row.failed++;
    const t = span(c.startedAt, c.endedAt); if (t !== null) row.times.push(t); row.flows.add(ref(x.flow)); checkRows.set(c.id, row);
  }
  const checks = [...checkRows.values()].map(r => ({ id: r.id, runs: r.runs, failed: r.failed, medianMs: median(r.times), flowIds: [...r.flows].slice(0, MAX_IDS) })).sort((a, b) => (b.medianMs ?? 0) - (a.medianMs ?? 0));

  // Main verification history, newest first, with the merges since the previous green.
  const verifications = flows.filter(f => f.kind === 'maintenance' && operationOf(f) === 'main.verify' && ended(f)).map(f => ({ f, at: ms(f.finishedAt), health: f.results?.run?.mainHealth })).filter(v => v.at !== null).sort((a, b) => a.at - b.at);
  const mergedAt = flows.filter(f => f.results?.merge?.merged).map(f => ms(f.finishedAt)).filter(t => t !== null);
  let lastGreen = null; const main = [];
  for (const v of verifications) {
    const status = v.health?.status ?? (v.f.state === 'completed' ? 'green' : 'unknown');
    // The target's effective health after this run (tiered projects record it at settlement): a
    // merge-tier pass while a scheduled-tier red stands is not a green target.
    const targetStatus = v.f.targetHealth?.status ?? status;
    main.push({ flowId: ref(v.f), at: new Date(v.at).toISOString(), head: v.health?.head ?? null, status, targetStatus, tier: v.health?.tier ?? null, tiers: v.health?.tiers ?? null, scheduled: v.health?.scheduled?.status ?? null, failedChecks: (v.health?.checks ?? []).filter(c => c.status !== 'passed').map(c => c.id), mergesSinceGreen: mergedAt.filter(t => (lastGreen === null || t > lastGreen) && t <= v.at).length });
    if (targetStatus === 'green') lastGreen = v.at;
  }
  const mainHistory = main.filter(v => inWindow(ms(v.at))).reverse().slice(0, 30);

  // Decisions: how long questions waited, by who answered.
  const questions = inbox.filter(q => q.kind === 'question' && inWindow(ms(q.answeredAt ?? q.createdAt))).map(q => ({ id: q.flowId, flow: flows.find(f => f.id === q.flowId), at: ms(q.answeredAt ?? q.createdAt), role: q.answeredBy ?? q.role, wait: q.status === 'answered' ? span(q.createdAt, q.answeredAt) : null, status: q.status }));
  const decisions = [
    metric('answered-operator', 'Your response time', questions.filter(q => q.wait !== null && q.role === 'operator'), { kind: 'duration', value: r => r.wait, sampleUnit: 'answers', note: 'From a question opening to your answer.' }),
    metric('answered-orchestrator', 'Orchestrator response time', questions.filter(q => q.wait !== null && q.role === 'orchestrator'), { kind: 'duration', value: r => r.wait, sampleUnit: 'answers' }),
    metric('expired', 'Questions that expired', questions.filter(q => q.status === 'expired'), { kind: 'count', sampleUnit: 'questions' }),
  ];

  // List-price estimate: per change, and the total per period by role.
  const priced = changeLike.filter(x => x.costSteps > 0), spent = finished.filter(x => x.costSteps > 0);
  const roleParts = [['builder', 'Builder'], ['reviewer', 'Reviewer'], ['planner', 'Planner'], ['other', 'Other']];
  const estimate = {
    perChange: metric('cost-change', 'List-price estimate per change', priced.filter(x => x.costUnknown < x.costSteps), { kind: 'usd', value: r => r.cost, sampleUnit: 'changes', note: 'Mean list-price estimate of a change’s model steps. Steps with no reported or configured price count as unknown and add nothing.' }),
    perPeriod: (() => { const m = metric('cost-period', 'List-price estimate per period, by role', spent, { kind: 'usd-total', value: r => r.cost, sampleUnit: 'flows' });
      // An amount with no priced step is unknown (null), never $0; unknown step counts travel with it.
      const total = (list, k) => list.some(x => x.knownByRole[k]) ? list.reduce((s, x) => s + x.costByRole[k], 0) : null;
      m.buckets = m.buckets.map((b, i) => { const list = spent.filter(x => x.at >= buckets[i].start && x.at < buckets[i].end);
        return { ...b, value: list.some(x => x.costUnknown < x.costSteps) ? list.reduce((s, x) => s + x.cost, 0) : null, unknown: list.reduce((s, x) => s + x.costUnknown, 0), parts: Object.fromEntries(roleParts.map(([k]) => [k, total(list, k)])) }; });
      m.headline = spent.some(x => x.costUnknown < x.costSteps) ? spent.reduce((s, x) => s + x.cost, 0) : null; m.legend = roleParts.map(([k, l]) => [k, l, total(spent, k) ?? (spent.some(x => x.unknownByRole[k]) ? null : 0), spent.reduce((s, x) => s + x.unknownByRole[k], 0)]); return m; })(),
    unknownSteps: spent.reduce((s, x) => s + x.costUnknown, 0), steps: spent.reduce((s, x) => s + x.costSteps, 0), priced: Object.keys(pricing),
    tokens: metric('tokens', 'Measured total tokens per period', spent, { kind: 'count', sampleUnit: 'flows' }),
  };
  estimate.tokens.buckets = estimate.tokens.buckets.map((b, i) => ({ ...b, value: spent.filter(x => x.at >= buckets[i].start && x.at < buckets[i].end).reduce((s, x) => s + x.tokensTotal, 0) }));
  estimate.tokens.headline = spent.reduce((s, x) => s + x.tokensTotal, 0); estimate.tokens.kind = 'tokens';

  estimate.inputTokens = { ...estimate.tokens, id: 'input-tokens', title: 'Measured input tokens per period',
    headline: spent.reduce((s, x) => s + x.tokensInput, 0), buckets: estimate.tokens.buckets.map((b, i) => ({ ...b, value: spent.filter(x => x.at >= buckets[i].start && x.at < buckets[i].end).reduce((s, x) => s + x.tokensInput, 0) })) };
  const summary = entries => {
    const rows = entries.filter(e => !e.duplicate), measured = rows.filter(e => e.tokens), sums = emptyTokens();
    for (const e of measured) for (const [k, v] of Object.entries(e.tokens)) sums[k] += v;
    const priced = rows.map(e => usageEstimate(e, pricing)).filter(v => v !== null), actual = rows.filter(e => e.actualMicros !== null);
    return { attempts: new Set(entries.map(e => e.attemptId)).size, invocations: rows.length, duplicateObservations: entries.length - rows.length,
      measured: measured.length, missing: rows.length - measured.length, tokens: measured.length ? sums : null,
      inputTokens: measured.length ? inputTokens(sums) : null, totalTokens: measured.length ? totalTokens(sums) : null,
      estimateUsd: priced.length ? priced.reduce((s, n) => s + n, 0) : null, estimateUnknown: rows.length - priced.length,
      actualMicros: actual.length ? actual.reduce((s, e) => s + e.actualMicros, 0) : null, actualUnknown: rows.length - actual.length,
      currency: 'USD', moneyUnit: 'micros', accountCreditCost: 'unavailable', reasons: Object.fromEntries([...new Set(rows.map(e => e.reason))].map(reason => [reason, rows.filter(e => e.reason === reason).length])) };
  };
  const completedIds = new Set(finished.map(x => x.flow.id));
  const accounting = { version: ACCOUNTING_VERSION, windowBasis: 'flow-completion', interval: '[from,to)', timezone: 'UTC',
    completionCohort: summary(usage.filter(e => completedIds.has(e.flowId))),
    attemptWindow: { basis: 'invocation-start (attempt start when missing)', ...summary(usage.filter(e => inWindow(Number.isFinite(e.start) ? e.start : null))) } };
  if (!accounting.completionCohort.measured) { estimate.tokens.headline = null; estimate.inputTokens.headline = null; }
  for (let i = 0; i < buckets.length; i++) if (!spent.some(x => x.at >= buckets[i].start && x.at < buckets[i].end && x.tokensKnown)) {
    estimate.tokens.buckets[i].value = null; estimate.inputTokens.buckets[i].value = null;
  }

  // Models: invocations belonging to flows that ended in the window.
  const models = new Map();
  for (const x of finished) for (const a of attemptsByFlow.get(x.flow.id) ?? []) for (const entry of usageByAttempt.get(a.id) ?? []) {
    if (entry.duplicate) continue;
    const r = entry.result;
    const key = `${r.provider} · ${r.model ?? 'default'}`, row = models.get(key) ?? { model: key, steps: 0, failed: 0, times: [], roles: new Set(), chosen: 0, tokens: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 }, usd: 0, unknown: 0, usageUnknown: 0, byPeriod: buckets.map(() => 0), knownByPeriod: buckets.map(() => 0) };
    row.steps++; if (a.status === 'failed') row.failed++; const t = span(a.receipt?.startedAt, a.receipt?.endedAt); if (t !== null) row.times.push(t); row.roles.add(a.step);
    // How the model was selected: a per-task choice or a run override, from the flow's pinned selection.
    if (['task', 'run'].includes(x.flow.modelSelection?.steps?.[a.step]?.source)) row.chosen++;
    if (entry.tokens) { for (const [k, v] of Object.entries(entry.tokens)) row.tokens[k] += v; } else row.usageUnknown++;
    const usd = usageEstimate(entry, pricing); if (usd === null) row.unknown++; else { row.usd += usd; const i = bucketOf(x.at); if (i >= 0) { row.byPeriod[i] += usd; row.knownByPeriod[i]++; } }
    models.set(key, row);
  }
  const modelRows = [...models.values()].map(r => ({ model: r.model, steps: r.steps, failed: r.failed, medianMs: median(r.times), usedFor: [...r.roles].sort(), chosenPerTask: r.chosen, tokens: r.tokens, usageUnknown: r.usageUnknown, inputTokens: r.steps > r.usageUnknown ? inputTokens(r.tokens) : null, totalTokens: r.steps > r.usageUnknown ? totalTokens(r.tokens) : null, usd: r.steps > r.unknown ? r.usd : null, unknown: r.unknown, perStepUsd: r.steps > r.unknown ? r.usd / (r.steps - r.unknown) : null })).sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1) || b.steps - a.steps);
  // The estimate per period, stacked by model: the six costliest by name, the rest together.
  const named = modelRows.filter(r => r.usd).slice(0, 6).map(r => r.model);
  estimate.byModel = { names: [...named, ...(modelRows.some(r => r.usd && !named.includes(r.model)) ? ['Other models'] : [])], buckets: buckets.map((b, i) => ({ label: b.label, parts: Object.fromEntries([...named.map(n => [n, models.get(n).knownByPeriod[i] ? models.get(n).byPeriod[i] : null]), ['Other models', (others => others.some(r => r.knownByPeriod[i]) ? others.reduce((s, r) => s + r.byPeriod[i], 0) : null)([...models.values()].filter(r => !named.includes(r.model)))]].filter(([n]) => n !== 'Other models' || modelRows.some(r => r.usd && !named.includes(r.model)))) })) };

  // Maintenance, by operation.
  const maintenance = of('maintenance'), ops = new Map();
  for (const x of maintenance) { const row = ops.get(x.operation) ?? { operation: x.operation, runs: 0, failed: 0, times: [] }; row.runs++; if (x.flow.state === 'failed') row.failed++; if (x.total !== null) row.times.push(x.total); ops.set(x.operation, row); }
  const maintenanceMetric = metric('maintenance', 'Maintenance runs', maintenance, { kind: 'count', sampleUnit: 'runs' });
  const maintenanceRows = [...ops.values()].map(r => ({ operation: r.operation, runs: r.runs, failed: r.failed, medianMs: median(r.times) })).sort((a, b) => b.runs - a.runs);

  // Tasks: created and finished per period, what is open now, and how old approved work is.
  const tasks = store.all('task').filter(t => !String(t.id).startsWith('job:') && !['schedule', 'job'].includes(t.approvalKind));
  const firstSeen = new Map(store.db.prepare("SELECT json_extract(payload,'$.taskId') AS id, MIN(at) AS at FROM events WHERE type = 'task.updated' GROUP BY id").all().map(r => [r.id, ms(r.at)]));
  const created = tasks.filter(t => !t.tracked && inWindow(firstSeen.get(t.id) ?? null)).map(t => ({ id: null, at: firstSeen.get(t.id) }));
  const closed = work.filter(x => x.flow.state === 'completed').map(x => ({ flow: x.flow, at: x.at }));
  const flowFor = id => flows.filter(f => f.taskId === id && !ended(f))[0];
  const open = tasks.filter(t => !t.closed && t.status !== 'completed' && !t.tracked);
  const stateOf = t => flowFor(t.id) ? 'running' : store.get('queue', t.id)?.status === 'queued' ? 'queued' : t.approvedRevision === t.revision ? 'approved' : 'needs-approval';
  const approvedAges = open.filter(t => t.approvedRevision === t.revision && !flowFor(t.id)).map(t => nowMs - (ms(t.approvedAt) ?? nowMs));
  const areaOf = x => x.flow.taskSnapshot?.area ?? x.flow.taskSnapshot?.category ?? null;
  const areas = [...new Set(delivered.map(areaOf).filter(Boolean))].sort();
  const backlog = {
    created: metric('created', 'Tasks added', created, { kind: 'count', sampleUnit: 'tasks' }),
    closed: metric('closed', 'Work completed', closed, { kind: 'count', sampleUnit: 'flows' }),
    openNow: Object.fromEntries(['needs-approval', 'approved', 'queued', 'running'].map(s => [s, open.filter(t => stateOf(t) === s).length])),
    tracked: tasks.filter(t => t.tracked && !t.closed).length,
    approvedAge: { count: approvedAges.length, medianMs: median(approvedAges), oldestMs: approvedAges.length ? Math.max(...approvedAges) : null },
    areas: areas.length ? { names: areas, buckets: buckets.map(b => ({ label: b.label, parts: Object.fromEntries(areas.map(a => [a, delivered.filter(x => x.at >= b.start && x.at < b.end && areaOf(x) === a).length])) })) } : null,
  };

  // Knowledge upkeep (design 4.5, 8.5): the maintained day rows of the window, each read by key, and
  // the last recorded runs. The totals are the ones the share-of-invocations ceiling uses; they are
  // counted by the function this projection uses (operations/usage-accounting.mjs attemptInvocations).
  const upkeepDays = [];
  for (let day = from; day < to; day += DAY) { const row = store.get('upkeepDay', upkeepDayId(day)); if (row) upkeepDays.push({ day: row.id, invocations: row.invocations ?? 0, upkeepInvocations: row.upkeepInvocations ?? 0, modelRunsReserved: row.modelRunsReserved ?? 0, modelRunsSettled: row.modelRunsSettled ?? 0, tasksCreated: row.tasksCreated ?? 0, operatorTasksCreated: row.operatorTasksCreated ?? 0, outcomes: row.outcomes ?? {} }); }
  const upkeepOutcomes = {}; for (const row of upkeepDays) for (const [name, count] of Object.entries(row.outcomes)) upkeepOutcomes[name] = (upkeepOutcomes[name] ?? 0) + count;
  const upkeepSum = name => upkeepDays.reduce((sum, row) => sum + row[name], 0), lastRuns = upkeepWindow(store).runs;
  const upkeep = { mode: upkeepMode(store.meta('config', {})), days: upkeepDays.map(({ outcomes, ...row }) => row), invocations: upkeepSum('invocations'), upkeepInvocations: upkeepSum('upkeepInvocations'), modelRuns: upkeepSum('modelRunsSettled') + upkeepSum('modelRunsReserved'), runs: Object.values(upkeepOutcomes).reduce((sum, count) => sum + count, 0), outcomes: upkeepOutcomes,
    lastRuns: { count: lastRuns.length, reachedModel: lastRuns.filter(row => row.model === true).length, producedCandidates: lastRuns.filter(row => row.candidates === true).length } };

  return {
    upkeep,
    window: { key: window, ...STATS_WINDOWS[window], from: new Date(from).toISOString(), to: new Date(to).toISOString() }, observedAt: new Date(nowMs).toISOString(), few: FEW,
    synthetic: (store.meta('config', {}).mode ?? 'rehearsal') !== 'delivery',
    throughput, quality, estimate, accounting, checks: { metrics: checksMetrics, rows: checks, main: mainHistory }, decisions, models: modelRows,
    maintenance: { metric: maintenanceMetric, rows: maintenanceRows }, backlog,
    // Current provider usage limits and holds (readiness G7): a present-tense view, not windowed history.
    providerLimits: providerLimitView(store, nowMs),
    failures: work.filter(x => x.flow.state === 'failed').map(x => { const a = x.flow.abandonedAt ? abandonedBy.get(x.flow.id) : null; return { flow: x.flow, at: x.at, reason: x.flow.abandonedAt ? `abandoned${a?.note ? `: ${a.note}` : ''}` : `failed${x.flow.stopReason ? `: ${x.flow.stopReason}` : ''}`, by: x.flow.abandonedAt ? a?.by ?? 'operator' : 'factory' }; }).concat(stops.map(s => ({ flow: s.flow, at: s.at, reason: s.reason, by: s.by }))).map(x => ({ flowId: ref(x.flow), at: new Date(x.at).toISOString(), by: x.by ?? null, reason: x.reason ?? x.flow.stopReason ?? x.flow.abandonReason ?? 'failed' })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40),
    flows: Object.fromEntries(referenced),
  };
}
