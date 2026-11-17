import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { usageObservation } from '../starter/factory/operations/usage-accounting.mjs';
import { projectStats } from '../starter/factory/operations/stats-view.mjs';
import { stopFlow } from '../starter/factory/core/project.mjs';

const at = (nowMs, minutes) => new Date(nowMs - minutes * 60000).toISOString();
const graph = { start: 'plan', nodes: { plan: { kind: 'effect', action: { operation: 'provider.plan' } }, build: { kind: 'effect', action: { operation: 'provider.build' } }, review: { kind: 'effect', action: { operation: 'provider.review' }, evidence: 'review' }, gate: { kind: 'effect', action: { operation: 'gate' }, evidence: 'gate' } } };
function change(f, id, nowMs, { reviews = ['pass'], builds = 1, pool, state = 'completed', merged = true } = {}) {
  const start = 300, flow = { id, taskId: `task-${id}`, kind: 'change', ...(pool ? { pool } : {}), state, createdAt: at(nowMs, start), finishedAt: at(nowMs, 10), workflow: graph, taskSnapshot: { title: `Task ${id}`, area: 'docs' }, results: { ...(merged ? { merge: { merged: true } } : {}), plan: {} } };
  f.store.put('flow', flow);
  let t = start - 5, n = 0;
  const attempt = (step, operation, minutes, route, status = 'passed') => { f.store.put('attempt', { id: `${id}-${n++}`, flowId: id, step, status, createdAt: at(nowMs, t), settledAt: at(nowMs, t - minutes), intent: { action: { operation } }, receipt: { startedAt: at(nowMs, t), endedAt: at(nowMs, t - minutes), actionResult: { route, provider: 'codex', model: 'm1' } } }); t -= minutes; };
  attempt('plan', 'provider.plan', 10, 'ready');
  for (let i = 0; i < builds; i++) attempt('build', 'provider.build', 30, 'implemented');
  for (const route of reviews) attempt('review', 'provider.review', 10, route);
  attempt('gate', 'gate', 20, 'pass');
  f.store.put('wait', { id: `${id}-q`, flowId: id, kind: 'question', inboxId: `${id}-i`, startedAt: at(nowMs, t), endedAt: at(nowMs, t - 60) });
  f.store.put('inbox', { id: `${id}-i`, kind: 'question', flowId: id, role: 'operator', status: 'answered', answeredBy: 'operator', createdAt: at(nowMs, t), answeredAt: at(nowMs, t - 60) });
}

test('stats count merged work per period, split its time, and measure first attempts', t => {
  // Midday UTC, so fixtures dated minutes before "now" stay in today's bucket at any wall-clock time.
  const midday = new Date(); midday.setUTCHours(12, 0, 0, 0);
  const f = sandbox(t), nowMs = midday.getTime();
  change(f, 'a', nowMs); change(f, 'b', nowMs, { reviews: ['revise', 'pass'], builds: 2 }); change(f, 'd', nowMs, { pool: 'document' });
  change(f, 'x', nowMs, { state: 'failed', merged: false });
  f.store.put('flow', { id: 'm1', taskId: 'job:1', kind: 'maintenance', state: 'completed', createdAt: at(nowMs, 30), finishedAt: at(nowMs, 29), workflow: { start: 'run', nodes: { run: { kind: 'effect', action: { operation: 'main.verify' } } } }, results: { run: { mainHealth: { status: 'green', head: 'a'.repeat(40), checks: [] } } } });
  const s = projectStats(f.store, { window: '7d', nowMs });
  const m = (list, id) => s[list].find(x => x.id === id);
  assert.equal(s.throughput.find(x => x.id === 'merged').headline, 2); assert.equal(m('throughput', 'documents').headline, 1); assert.equal(m('throughput', 'failed').headline, 1);
  assert.equal(m('throughput', 'merged').buckets.length, 7); assert.equal(m('throughput', 'merged').buckets.at(-1).value, 2, 'today');
  const duration = m('throughput', 'duration'), legend = Object.fromEntries(duration.legend.map(([k, , v]) => [k, v]));
  assert.ok(legend.building > 0 && legend['waiting-operator'] === 3600000 && legend.checks === 1200000, JSON.stringify(legend));
  assert.equal(m('quality', 'first-review').headline, 66.7); assert.equal(m('quality', 'no-fix').hits, 2);
  assert.equal(m('quality', 'review-rounds').headline, 4 / 3);
  assert.equal(m('decisions', 'answered-operator').headline, 3600000);
  assert.equal(s.models[0].model, 'codex · m1');
  assert.deepEqual(s.maintenance.rows.map(r => [r.operation, r.runs]), [['main.verify', 1]]);
  assert.equal(s.checks.main[0].status, 'green'); assert.equal(s.checks.main[0].mergesSinceGreen, 0);
  assert.equal(s.backlog.areas.names[0], 'docs');
  assert.ok(s.flows.a.title === 'Task a');
  assert.equal(projectStats(f.store, { window: '12w', nowMs }).throughput[0].buckets.length, 12);
  assert.throws(() => projectStats(f.store, { window: '1y' }));
});

test('the subscription estimate uses a reported price, else a configured one, else counts the step as unknown', t => {
  const f = sandbox(t), nowMs = Date.now();
  f.store.put('flow', { id: 'c', taskId: 'task-c', kind: 'change', state: 'completed', createdAt: at(nowMs, 60), finishedAt: at(nowMs, 5), workflow: graph, taskSnapshot: { title: 'C' }, results: { merge: { merged: true } } });
  const step = (n, step, operation, actionResult) => {
    actionResult.sessionId = `session-${n}`;
    const u = actionResult.usage;
    const event = actionResult.provider === 'claude' ? { ...actionResult, model_usage_since_last_result: { opus: { inputTokens: u.input_tokens, cacheReadInputTokens: u.cache_read_input_tokens, cacheCreationInputTokens: u.cache_creation_input_tokens, outputTokens: u.output_tokens, costUSD: actionResult.reportedCostUsd } } } : { usage: { cached_input_tokens: 0, ...u } };
    actionResult.usageObservation = usageObservation({ provider: actionResult.provider, version: actionResult.provider === 'claude' ? '2.1.323' : 'codex-cli 0.169.0', sessionId: actionResult.sessionId, id: `observation-${n}`, startedAt: at(nowMs, 50), endedAt: at(nowMs, 40), event });
    return f.store.put('attempt', { id: `c-${n}`, flowId: 'c', step, status: 'passed', createdAt: at(nowMs, 50), intent: { action: { operation } }, receipt: { startedAt: at(nowMs, 50), endedAt: at(nowMs, 40), actionResult } }); };
  step(1, 'build', 'provider.build', { provider: 'claude', model: 'opus', reportedCostUsd: 2.5, usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 500 } });
  step(2, 'review', 'provider.review', { provider: 'codex', model: 'gpt', usage: { input_tokens: 1000000, cached_input_tokens: 500000, output_tokens: 100000, reasoning_output_tokens: 0 } });
  step(3, 'plan', 'provider.plan', { provider: 'codex', model: 'unpriced', usage: { input_tokens: 10, output_tokens: 10 } });
  f.store.setMeta('config', { ...f.store.meta('config'), stats: { pricing: { gpt: { input: 2, cachedInput: 0.5, output: 10 } } } });
  const e = projectStats(f.store, { window: '7d', nowMs }).estimate;
  assert.equal(e.perChange.headline, 2.5 + (500000 * 2 + 500000 * 0.5 + 100000 * 10) / 1e6);
  const legend = Object.fromEntries(e.perPeriod.legend.map(([k, , v, unknown]) => [k, [v, unknown]]));
  assert.deepEqual(legend.builder, [2.5, 0]); assert.deepEqual(legend.reviewer, [2.25, 0]); assert.deepEqual(legend.planner, [null, 1], 'an unknown-only role is unknown, not $0');
  assert.equal(e.unknownSteps, 1); assert.equal(e.steps, 3);
  assert.equal(e.tokens.headline, 1610 + 1100000 + 20);
  const models = projectStats(f.store, { window: '7d', nowMs }).models, by = Object.fromEntries(models.map(m => [m.model, m]));
  assert.equal(by['claude · opus'].usd, 2.5); assert.deepEqual(by['claude · opus'].tokens, { input: 10, cachedInput: 1000, cacheWrite: 100, output: 500 });
  assert.equal(by['codex · gpt'].usd, 2.25); assert.equal(by['codex · gpt'].tokens.cachedInput, 500000);
  assert.equal(by['codex · unpriced'].usd, null); assert.equal(by['codex · unpriced'].unknown, 1);
  assert.deepEqual(projectStats(f.store, { window: '7d', nowMs }).estimate.byModel.names, ['claude · opus', 'codex · gpt']);
});

test('list prices are a live setting and are validated', t => {
  const f = sandbox(t);
  assert.equal(f.command('settings.update', { changes: { 'stats.pricing': { gpt: { input: 2, output: 10 } } }, note: 'Prices' }).status, 'completed');
  assert.equal(f.store.meta('config').stats.pricing.gpt.output, 10);
  assert.equal(f.command('settings.update', { changes: { 'stats.pricing': { gpt: { input: 2 } } }, note: 'x' }).status, 'rejected', 'output price required');
});

test('routine orchestrator merges are not interventions', t => {
  const f = sandbox(t), nowMs = Date.now();
  change(f, 'r', nowMs); change(f, 's', nowMs);
  f.store.put('inbox', { id: 'r-m', kind: 'question', flowId: 'r', role: 'orchestrator', answers: ['merge', 'send_back', 'stop'], status: 'answered', answer: 'merge', answeredBy: 'orchestrator', createdAt: at(nowMs, 20), answeredAt: at(nowMs, 19) });
  f.store.put('inbox', { id: 's-m', kind: 'question', flowId: 's', role: 'orchestrator', answers: ['merge', 'send_back', 'stop'], status: 'answered', answer: 'send_back', answeredBy: 'orchestrator', createdAt: at(nowMs, 20), answeredAt: at(nowMs, 19) });
  const s = projectStats(f.store, { window: '7d', nowMs }), q = id => s.quality.find(m => m.id === id);
  assert.equal(q('orchestrator').hits, 1, 'only the send-back'); assert.equal(q('routine').headline, 1);

});

test('a repeated stop counts once, names who caused it, and older stops are attributed from their command', t => {
  const f = sandbox(t), nowMs = Date.now();
  change(f, 'p', nowMs, { state: 'completed' });
  const flow = { ...f.store.need('flow', 'p'), state: 'ready', finishedAt: undefined };
  f.store.put('flow', flow);
  f.store.commandActor = 'orchestrator'; f.store.commandCause = 'orchestrator';
  f.store.tx(() => { stopFlow(f.store, f.store.need('flow', 'p'), 'checked by hand'); stopFlow(f.store, f.store.need('flow', 'p'), 'checked by hand'); });
  f.store.commandActor = null; f.store.commandCause = null;
  assert.equal(f.store.events(50).filter(e => e.type === 'flow.stopped').length, 1, 'a repeat stop writes no second event');
  // An older stop without "by", followed by the command receipt of its transaction.
  f.store.tx(() => { f.store.event('flow.stopped', { flowId: 'p', reason: 'operator reconciled uncertain attempt' }); f.store.event('command.completed', { operation: 'attempt.resolve', actor: 'orchestrator' }); });
  const s = projectStats(f.store, { window: '7d', nowMs: Date.now() });
  assert.deepEqual(s.failures.map(r => [r.reason, r.by]), [['checked by hand', 'orchestrator']], 'the second stop without a resume between is not another stop');
  f.store.tx(() => f.store.event('flow.resumed', { flowId: 'p', by: 'operator' }));
  f.store.tx(() => { f.store.event('flow.stopped', { flowId: 'p', reason: 'operator reconciled uncertain attempt' }); f.store.event('command.completed', { operation: 'attempt.resolve', actor: 'orchestrator' }); });
  const after = projectStats(f.store, { window: '7d', nowMs: Date.now() }).failures;
  assert.ok(after.some(r => r.reason === 'the orchestrator reconciled an uncertain attempt' && r.by === 'orchestrator'), JSON.stringify(after));
  // The factory's own stop, a source change, and an abandonment.
  f.store.tx(() => f.store.event('flow.resumed', { flowId: 'p', by: 'operator' }));
  f.store.tx(() => f.store.event('flow.stopped', { flowId: 'p', reason: 'workflow visit bound exhausted' }));
  f.store.tx(() => f.store.event('flow.resumed', { flowId: 'p', by: 'operator' }));
  f.store.tx(() => { f.store.event('source.sync', { status: 'running' }); });
  f.store.tx(() => { f.store.event('flow.stopped', { flowId: 'p', reason: 'task brief changed' }); f.store.event('command.completed', { operation: 'task.put', actor: 'operator' }); });
  f.store.tx(() => { f.store.event('source.sync', { status: 'ok' }); });
  f.store.put('flow', { ...f.store.need('flow', 'p'), state: 'failed', abandonedAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  f.store.tx(() => { f.store.event('flow.abandoned', { flowId: 'p', note: 'Not needed' }); f.store.event('command.completed', { operation: 'flow.abandon', actor: 'orchestrator' }); });
  const last = projectStats(f.store, { window: '7d', nowMs: Date.now() }).failures, by = reason => last.find(r => r.reason === reason)?.by;
  assert.equal(by('workflow visit bound exhausted'), 'factory'); assert.equal(by('task brief changed'), 'source'); assert.equal(by('abandoned: Not needed'), 'orchestrator');
});

test('accounting agrees across flow cohorts, invocation windows and model tables, including failed and active attempts', t => {
  const f = sandbox(t), nowMs = Date.UTC(2026, 10, 13, 12), old = nowMs - 10 * 86400000;
  for (const [id, state] of [['completed', 'completed'], ['active', 'running']]) f.store.put('flow', { id, kind: 'change', state, createdAt: at(old, 10), ...(state === 'completed' ? { finishedAt: at(nowMs, 1) } : {}), workflow: graph });
  const add = (id, flowId, stamp, input, previous) => {
    const sessionId = 'cohort-session', usage = { input_tokens: input, cached_input_tokens: input / 2, output_tokens: input / 10 };
    f.store.put('attempt', { id, flowId, step: 'build', status: 'passed', createdAt: at(stamp, 10), intent: { action: { operation: 'provider.build' } }, receipt: { startedAt: at(stamp, 10), endedAt: at(stamp, 9), actionResult: { provider: 'codex', model: 'm1', sessionId, usage, usageObservation: usageObservation({ provider: 'codex', version: '0.169.0', sessionId, id, resumedFrom: previous ? sessionId : null, previousObservationId: previous, startedAt: at(stamp, 10), endedAt: at(stamp, 9), event: { usage } }) } } });
  };
  add('first', 'completed', old, 1000); add('resume', 'completed', nowMs, 1500, 'first');
  f.store.put('attempt', { id: 'failed', flowId: 'completed', step: 'review', status: 'failed', createdAt: at(nowMs, 5), intent: { action: { operation: 'provider.review', config: { providers: { reviewer: { provider: 'claude', model: 'm2' } } } } } });
  f.store.put('attempt', { id: 'active-missing', flowId: 'active', step: 'build', status: 'uncertain', createdAt: at(nowMs, 3), intent: { action: { operation: 'provider.build' } } });
  const s = projectStats(f.store, { nowMs }), c = s.accounting.completionCohort, a = s.accounting.attemptWindow;
  assert.equal(c.invocations, 3); assert.equal(c.measured, 2); assert.equal(c.missing, 1);
  assert.equal(c.totalTokens, 1650); assert.equal(c.inputTokens, 1500);
  assert.equal(a.invocations, 3); assert.equal(a.measured, 1); assert.equal(a.missing, 2); assert.equal(a.totalTokens, 550);
  assert.equal(s.estimate.tokens.headline, c.totalTokens); assert.equal(s.estimate.inputTokens.headline, c.inputTokens);
  assert.equal(s.models.reduce((sum, m) => sum + (m.totalTokens ?? 0), 0), c.totalTokens);
  assert.equal(s.models.reduce((sum, m) => sum + m.usageUnknown, 0), c.missing);
  assert.equal(c.actualMicros, null); assert.equal(c.actualUnknown, 3);
  assert.equal(s.estimate.perPeriod.headline, null, 'no attributable prices is not zero cost');
  const period = s.estimate.perPeriod.buckets.find(b => b.n);
  assert.equal(period.value, null, 'an unknown-only period is not $0'); assert.ok(period.unknown > 0);
  assert.ok(Object.values(period.parts).every(v => v === null), 'unknown-only role parts are not $0');
});

test('stats count model invocations chosen per task or run from the flow’s pinned selection', t => {
  const f = sandbox(t), nowMs = Date.now();
  change(f, 'chosen', nowMs, { builds: 2 }); change(f, 'plain', nowMs);
  const flow = f.store.need('flow', 'chosen');
  flow.modelSelection = { workflow: 'standard', steps: { plan: { role: 'planner', source: 'role' }, build: { role: 'builder', source: 'task' }, review: { role: 'reviewer', source: 'run' } } };
  f.store.put('flow', flow);
  const s = projectStats(f.store, { window: '7d', nowMs });
  assert.equal(s.models[0].model, 'codex · m1'); assert.equal(s.models[0].chosenPerTask, 3, 'two task-chosen builds and one run-chosen review');
});
