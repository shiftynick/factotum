import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { observeQueue } from '../starter/factory/operations/queue-diagnostics.mjs';
import { projectStats } from '../starter/factory/operations/stats-view.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { createProviderAdapter } from '../starter/factory/adapters/providers/index.mjs';
import { limitSignals, recordLimitSignals, providerHold, releaseExpiredHolds, stepHold, limitExhaustion, providerLimitView, LIMIT_DEFAULTS, MAX_AUTOMATIC_HOLD_MS } from '../starter/factory/operations/provider-limits.mjs';

// Every value here is fictional: invented windows, percentages, times and identifiers.
const session = '00000000-0000-4000-8000-000000000007';
const epoch = ms => Math.floor(ms / 1000);
const help = '--ignore-user-config --ignore-rules --disable --skip-git-repo-check --output-schema --json --model --config --safe-mode --setting-sources --disable-slash-commands --strict-mcp-config --mcp-config --json-schema --tools --restricted --permission-mode --permission-prompts';
const rateEvent = (status, utilization, resetsAt, window = 'seven_day') => ({ type: 'rate_limit_event', session_id: session, rate_limit_info: { status, rateLimitType: window, resetsAt, utilization, unifiedWindows: { [window]: { status, utilization, resetsAt } } } });
const limitError = resetsAt => [
  { type: 'assistant', session_id: session, error: 'rate_limit', api_error: 'usage_limit_reached', api_error_params: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } }, message: { content: [{ type: 'text', text: 'Fictional limit text' }] } },
  { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: session, result: 'Fictional limit text' },
];
// The same refusal with an error result whose text names the limit (no reset in the text).
const limitErrorWithText = resetsAt => limitError(resetsAt).map(e => e.type === 'result' ? { ...e, result: "You've hit your usage limit. Fictional detail." } : e);
const simpleReview = { verdict: 'pass', summary: 'Checked', findings: [] };
const reviewResult = { verdict: 'pass', summary: 'Checked', findings: [], riskAssessment: { level: 'strict', rationale: 'Fictional saved data', threatModel: ['Loss of records'], stopConditions: ['Missing integrity'] }, strictReview: { fullDiffInspected: true, threatModelReviewed: true, stopConditionsReviewed: true }, scopeSummary: 'Entire fictional change', priorFindingsDisposition: [], learningsChecked: [] };
const succeed = output => [{ type: 'system', subtype: 'init', session_id: session }, { type: 'result', subtype: 'success', is_error: false, session_id: session, usage: { input_tokens: 3, output_tokens: 1 }, structured_output: output }];
const success = succeed(simpleReview);

function fakeAdapter(byProvider) {
  const calls = [];
  const transport = async (binary, args) => {
    if (args.includes('--version')) return { code: 0, stdout: binary === 'codex' ? 'codex-cli 0.169.0' : '2.1.323', stderr: '' };
    if (args.includes('--help')) return { code: 0, stdout: help, stderr: '' };
    if (args.includes('status')) return { code: 0, stdout: binary === 'codex' ? 'Logged in using ChatGPT' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }), stderr: '' };
    calls.push(binary);
    const { events, code = 0 } = byProvider[binary];
    return { code, stdout: events.map(e => JSON.stringify(e)).join('\n'), stderr: '' };
  };
  return { calls, adapter: createProviderAdapter({ transport, environment: { HOME: '/fictional', PATH: '/bin' } }) };
}
async function specFor(t, provider, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fct-limits-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'work'));
  return { provider, model: 'fictional-model', role: 'reviewer', prompt: 'Fictional review', cwd: join(dir, 'work'), artifactDir: join(dir, 'artifacts'), timeoutMs: 60000, ...extra };
}

test('limit signals are read from Claude rate-limit events and typed usage-limit errors, and from Codex rate limits and limit errors', () => {
  const reset = epoch(Date.UTC(2031, 0, 2, 12));
  const claude = limitSignals('claude', [rateEvent('allowed_warning', 0.91, reset), ...limitError(reset)].map(e => JSON.stringify(e)).join('\n') + '\nnot json');
  assert.deepEqual(claude.map(s => [s.window, s.status, s.utilization]), [['seven_day', 'warning', 0.91], ['five_hour', 'exhausted', null]]);
  assert.equal(claude[0].resetsAt, '2031-01-02T12:00:00.000Z');
  const codex = limitSignals('codex', [
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { plan_type: 'fictional-plan', primary: { used_percent: 42, window_minutes: 300, resets_at: reset }, secondary: { used_percent: 100, window_minutes: 10080, resets_at: reset } } } }),
    JSON.stringify({ type: 'error', message: "You've hit your usage limit. Fictional detail." }),
  ].join('\n'));
  assert.deepEqual(codex.map(s => [s.window, s.status]), [['primary-300m', 'allowed'], ['secondary-10080m', 'exhausted'], ['usage', 'exhausted']]);
  assert.equal(codex[0].plan, 'fictional-plan');
  assert.equal(codex[2].resetsAt, null, 'a localized reset text is not guessed');
  assert.deepEqual(limitSignals('codex', JSON.stringify({ type: 'turn.failed', error: { message: 'Selected model is at capacity.' } })), [], 'capacity is not a usage limit');
});

test('the adapter classifies a started limit failure as USAGE_LIMIT with evidence and never falls back; a held provider is refused before start so only a configured fallback runs', async t => {
  const reset = epoch(Date.now() + 3600000);
  const limited = fakeAdapter({ claude: { events: [{ type: 'system', subtype: 'init', session_id: session }, rateEvent('rejected', 1, reset, 'five_hour'), ...limitError(reset)], code: 1 }, codex: { events: [] } });
  const spec = await specFor(t, 'claude', { allowFallback: true, fallback: { provider: 'codex', model: 'fallback-model' } });
  await assert.rejects(limited.adapter.invoke(spec), error => error.code === 'USAGE_LIMIT' && error.started === true && error.safeToRetry === false && error.accountingResult.limits.some(s => s.status === 'exhausted' && s.plan === 'max'));
  assert.deepEqual(limited.calls, ['claude'], 'a started limit failure is never re-run on another provider');

  const warned = fakeAdapter({ claude: { events: [rateEvent('allowed_warning', 0.93, reset), ...success] } });
  const result = await warned.adapter.invoke(await specFor(t, 'claude'));
  assert.equal(result.limits[0].utilization, 0.93);

  const codexResult = [{ type: 'thread.started', thread_id: session }, { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(simpleReview) } }, { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 1 } }];
  const fallback = fakeAdapter({ claude: { events: success }, codex: { events: codexResult } });
  const routed = await fallback.adapter.invoke(await specFor(t, 'claude', { heldProviders: ['claude'], allowFallback: true, fallback: { provider: 'codex', model: 'fallback-model' } }));
  assert.equal(routed.provider, 'codex'); assert.deepEqual(routed.fallback, { fromProvider: 'claude', fromModel: 'fictional-model', reason: 'USAGE_LIMIT_HOLD', beforeModelStart: true });
  assert.deepEqual(fallback.calls, ['codex'], 'the held provider was never started');
  await assert.rejects(fallback.adapter.invoke(await specFor(t, 'claude', { heldProviders: ['claude'] })), error => error.code === 'USAGE_LIMIT_HOLD' && error.started === false);
});

const deliveryConfig = { version: 1, mode: 'delivery', repository: { slug: 'fictional/limits', account: 'fictional', target: 'main' },
  providers: { planner: { provider: 'claude', model: 'plan-default' }, builder: { provider: 'claude', model: 'build-default' }, reviewer: { provider: 'codex', model: 'review-default' } },
  checks: [{ id: 'fixture', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 10 } };
function delivery(t) {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: deliveryConfig, note: 'Fictional limit routing' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() });
  return f;
}
const approve = (f, id, models) => {
  const task = f.command('task.put', { task: { id, title: id, acceptance: ['Fictional result'], risk: 'ordinary', paths: [`${id}.txt`] } }).result;
  if (models) assert.equal(f.command('task.models', { taskId: id, models }).status, 'completed');
  assert.equal(f.command('task.approve', { taskId: id, revision: task.revision }).status, 'completed');
  return f.store.need('task', id);
};
const record = (f, provider, signals, nowMs = Date.now(), observedAt) => f.store.tx(() => recordLimitSignals(f.store, { provider, signals, attemptId: 'fictional-attempt', nowMs, ...(observedAt ? { observedAt } : {}) }));

test('a threshold notice is raised once per usage window, and again for the next window', t => {
  const f = delivery(t), first = new Date(Date.now() + 86400000).toISOString(), next = new Date(Date.now() + 8 * 86400000).toISOString();
  record(f, 'claude', [{ window: 'seven_day', utilization: 0.5, resetsAt: first, status: 'allowed' }]);
  assert.equal(f.store.all('inbox').filter(i => i.id.startsWith('provider-limit:')).length, 0, 'below the default 90% nothing is raised');
  for (const utilization of [0.91, 0.95, 0.97]) record(f, 'claude', [{ window: 'seven_day', utilization, resetsAt: first, status: 'allowed_warning' }]);
  const notices = f.store.all('inbox').filter(i => i.id.startsWith('provider-limit:'));
  assert.equal(notices.length, 1); assert.equal(notices[0].role, 'operator'); assert.match(notices[0].summary, /91% of its seven_day usage window used/);
  assert.equal(providerHold(f.store, 'claude'), null, 'a notice is not a hold');
  record(f, 'claude', [{ window: 'seven_day', utilization: 0.92, resetsAt: next, status: 'allowed_warning' }]);
  assert.equal(f.store.all('inbox').filter(i => i.id.startsWith('provider-limit:')).length, 2);
  assert.equal(f.store.events(50).filter(e => e.type === 'provider.limit-notice').length, 2);
});

test('exhaustion holds admission of work that would start that provider until the reported reset, with a queue reason; another provider is not held', t => {
  const f = delivery(t), resetMs = Date.now() + 2 * 3600000, reset = new Date(resetMs).toISOString();
  const ordinary = approve(f, 'uses-claude'), codexOnly = approve(f, 'codex-only', { planner: { provider: 'codex', model: 'review-default' }, builder: { provider: 'codex', model: 'review-default' } });
  record(f, 'claude', [{ window: 'five_hour', utilization: null, resetsAt: reset, status: 'exhausted' }]);
  const hold = providerHold(f.store, 'claude');
  assert.equal(hold.until, reset); assert.equal(hold.source, 'exhausted');
  const reasons = admissionReasons(f.store, f.store.need('task', ordinary.id));
  assert.ok(reasons.some(r => r.startsWith(`claude usage limit hold until ${reset}`)), reasons.join('; '));
  assert.deepEqual(admissionReasons(f.store, f.store.need('task', codexOnly.id)).filter(r => /usage limit/.test(r)), [], 'work routed to codex is not held');
  assert.equal(f.store.get('inbox', 'provider-hold:claude').status, 'open');
  // flow.start refuses with the same reason; a run override onto a held provider is refused too.
  const refused = f.command('flow.start', { taskId: ordinary.id, revision: ordinary.revision, flowId: 'held-flow' });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /claude usage limit hold/);
  assert.equal(f.command('flow.start', { taskId: codexOnly.id, revision: codexOnly.revision, flowId: 'codex-flow' }).status, 'completed');
  // The queue records the reason as an eligibility observation.
  assert.equal(f.command('queue.put', { taskIds: [ordinary.id] }).status, 'completed');
  const observed = observeQueue(f.store, { reasonsForTask: task => admissionReasons(f.store, task) });
  assert.ok(observed.rows[0].eligibility.reasons.some(r => /claude usage limit hold/.test(r)));
  // At the reset the hold clears by itself, and admission no longer names it.
  assert.deepEqual(releaseExpiredHolds(f.store, resetMs + 1), ['claude']);
  assert.equal(providerHold(f.store, 'claude'), null);
  assert.deepEqual(admissionReasons(f.store, f.store.need('task', ordinary.id)).filter(r => /usage limit/.test(r)), []);
  assert.equal(f.store.get('inbox', 'provider-hold:claude').status, 'resolved');
  assert.ok(f.store.events(50).some(e => e.type === 'provider.limit-released' && e.payload?.automatic !== false));
});

test('a hold without a reported reset uses the configured default, and a hold threshold below 100% also holds', t => {
  const f = delivery(t), at = Date.now();
  record(f, 'codex', [{ window: 'usage', utilization: null, resetsAt: null, status: 'exhausted' }], at);
  const hold = providerHold(f.store, 'codex');
  assert.ok(Math.abs(Date.parse(hold.until) - (at + LIMIT_DEFAULTS.defaultHoldMs)) < 5000); assert.match(hold.reason, /no reset time was reported/);
  assert.equal(f.command('settings.update', { changes: { 'policy.providerLimitHoldPercent': 95, 'policy.providerLimitNoticePercent': 80 }, note: 'Fictional earlier hold' }).status, 'completed');
  record(f, 'claude', [{ window: 'seven_day', utilization: 0.96, resetsAt: new Date(at + 86400000).toISOString(), status: 'allowed_warning' }]);
  assert.equal(providerHold(f.store, 'claude').source, 'threshold');
  assert.throws(() => validateConfig({ ...deliveryConfig, policy: { providerLimitNoticePercent: 95, providerLimitHoldPercent: 90 } }), /cannot exceed/);
  assert.throws(() => validateConfig({ ...deliveryConfig, policy: { providerLimitDefaultHoldMs: 10 } }), /providerLimitDefaultHoldMs/);
});

test('a reset that has already passed creates no hold, even with a matching text-only refusal; a refusal without a reset observed longer ago than the default hold creates none either', t => {
  const f = delivery(t), at = Date.now(), passed = epoch(at - 60000);
  // A delayed settlement: the typed refusal names a reset that has already passed.
  const signals = limitSignals('claude', limitErrorWithText(passed).map(e => JSON.stringify(e)).join('\n'));
  assert.deepEqual(signals.map(s => s.source), ['usage_limit_reached', 'result-text']);
  record(f, 'claude', signals, at);
  assert.equal(providerHold(f.store, 'claude', at), null, 'no fresh default hold from a limit that has already reset');
  assert.equal(f.store.all('inbox').filter(i => i.id.startsWith('provider-limit:') || i.id.startsWith('provider-hold:')).length, 0);
  // Without any reset time, the default hold runs from when the limit was observed.
  record(f, 'codex', [{ window: 'usage', utilization: null, resetsAt: null, status: 'exhausted' }], at, new Date(at - LIMIT_DEFAULTS.defaultHoldMs - 60000).toISOString());
  assert.equal(providerHold(f.store, 'codex', at), null);
  record(f, 'codex', [{ window: 'usage', utilization: null, resetsAt: null, status: 'exhausted' }], at, new Date(at - 3600000).toISOString());
  assert.equal(Date.parse(providerHold(f.store, 'codex', at).until), at - 3600000 + LIMIT_DEFAULTS.defaultHoldMs);
});

test('a typed refusal and its matching error text are one refusal: the typed reset wins over the default hold; distinct exhausted windows keep the latest reset', t => {
  const f = delivery(t), at = Date.now(), soon = epoch(at + 600000);
  const signals = limitSignals('claude', limitErrorWithText(soon).map(e => JSON.stringify(e)).join('\n'));
  assert.deepEqual(signals.map(s => s.source), ['usage_limit_reached', 'result-text']);
  record(f, 'claude', signals, at);
  assert.equal(providerHold(f.store, 'claude', at).until, new Date(soon * 1000).toISOString(), 'held until the typed reset, not for five hours');
  assert.equal(providerHold(f.store, 'claude', at).window, 'five_hour');
  assert.equal(f.store.all('inbox').filter(i => i.id.startsWith('provider-limit:')).length, 1, 'one notice for the one refusal');
  assert.deepEqual(limitExhaustion({ uncertain: true, limitExhausted: true, providerInvocations: [{ provider: 'claude', model: 'm', limits: signals }] }).resetsAt, new Date(soon * 1000).toISOString(), 'the attempt records the typed reset');
  // Two windows exhausted in one report: the later reset holds.
  const fiveHour = new Date(at + 2 * 3600000).toISOString(), weekly = new Date(at + 3 * 86400000).toISOString();
  record(f, 'codex', [{ window: 'primary-300m', utilization: 1, resetsAt: fiveHour, status: 'exhausted' }, { window: 'secondary-10080m', utilization: 1, resetsAt: weekly, status: 'exhausted' }, { window: 'usage', utilization: null, resetsAt: null, status: 'exhausted', source: 'error' }], at);
  assert.equal(providerHold(f.store, 'codex', at).until, weekly);
  // A later report of the shorter window alone does not shorten the hold.
  record(f, 'codex', [{ window: 'primary-300m', utilization: 1, resetsAt: new Date(at + 3600000).toISOString(), status: 'exhausted' }], at + 1000);
  assert.equal(providerHold(f.store, 'codex', at).until, weekly);
});

test('malformed and far-future reset dates never throw or discard valid signals; an automatic hold stops at its documented bound', async t => {
  const f = delivery(t), at = Date.now(), soon = epoch(at + 3600000);
  const lines = [rateEvent('rejected', 1, soon, 'five_hour'), rateEvent('rejected', 1, 1e30, 'seven_day'), { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: 'not a date' } }].map(e => JSON.stringify(e)).join('\n');
  const signals = limitSignals('claude', lines);
  assert.deepEqual(signals.filter(s => s.status === 'exhausted').map(s => [s.window, s.resetsAt]), [['five_hour', new Date(soon * 1000).toISOString()], ['five_hour', new Date(soon * 1000).toISOString()], ['seven_day', null], ['seven_day', null], ['seven_day_opus', null]]);
  record(f, 'claude', [...signals, { window: 'odd', status: 'exhausted', resetsAt: 1e30 }, { window: 'odd2', status: 'exhausted', resetsAt: 'garbage' }, null, { status: 'exhausted' }], at);
  assert.equal(providerHold(f.store, 'claude', at).until, new Date(soon * 1000).toISOString(), 'the valid reset holds; malformed ones read as unreported and are coalesced');
  // The adapter keeps the report and its classification.
  const limited = fakeAdapter({ claude: { events: [{ type: 'system', subtype: 'init', session_id: session }, rateEvent('rejected', 1, soon, 'five_hour'), rateEvent('rejected', 1, 1e30, 'seven_day')], code: 1 } });
  await assert.rejects(limited.adapter.invoke(await specFor(t, 'claude')), error => error.code === 'USAGE_LIMIT' && error.accountingResult.limits.some(s => s.resetsAt === new Date(soon * 1000).toISOString()));
  // A reset in the year 2200 is a valid date but not a credible window: the hold stops at the bound and says so.
  const far = Date.UTC(2200, 0, 1) / 1000;
  record(f, 'codex', limitSignals('codex', JSON.stringify({ type: 'event_msg', payload: { rate_limits: { secondary: { used_percent: 100, window_minutes: 10080, resets_at: far } } } })), at);
  const hold = providerHold(f.store, 'codex', at);
  assert.equal(Date.parse(hold.until), at + MAX_AUTOMATIC_HOLD_MS); assert.equal(MAX_AUTOMATIC_HOLD_MS, 8 * 86400000);
  assert.equal(hold.capped, true); assert.equal(hold.reportedReset, new Date(far * 1000).toISOString());
  assert.match(hold.reason, /more than 8 days away, so the automatic hold stops at the 8-day bound/);
  assert.match(f.store.get('inbox', 'provider-hold:codex').summary, /8-day bound/);
});

test('admission checks the routes the run would pin: run overrides and task model choices onto an unheld provider are admitted, on flow.start and task.restart', t => {
  const f = delivery(t);
  record(f, 'claude', [{ window: 'five_hour', utilization: null, resetsAt: new Date(Date.now() + 3600000).toISOString(), status: 'exhausted' }]);
  const onCodex = { plan: { provider: 'codex', model: 'review-default' }, build: { provider: 'codex', model: 'review-default' } };
  const overridden = approve(f, 'overridden');
  assert.ok(admissionReasons(f.store, overridden).some(r => /claude usage limit hold/.test(r)), 'the saved defaults use the held provider');
  assert.deepEqual(admissionReasons(f.store, overridden, { modelOverrides: onCodex }).filter(r => /usage limit/.test(r)), []);
  const started = f.command('flow.start', { taskId: overridden.id, revision: overridden.revision, flowId: 'override-flow', modelOverrides: onCodex });
  assert.equal(started.status, 'completed', started.error);
  assert.deepEqual([...new Set(Object.values(f.store.need('flow', 'override-flow').modelRoutes).map(r => r.provider))], ['codex']);
  // An override that leaves one model step on the held provider is still refused.
  const partial = approve(f, 'partial');
  const refused = f.command('flow.start', { taskId: partial.id, revision: partial.revision, modelOverrides: { plan: onCodex.plan } });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /claude usage limit hold.*model steps such as build/);
  // task.restart passes its run overrides to the same check.
  const restarted = f.command('task.restart', { taskId: partial.id, revision: partial.revision, note: 'Fictional restart onto codex', modelOverrides: onCodex });
  assert.equal(restarted.status, 'completed', restarted.error);
  // A task model choice reaches the queue check (no run overrides there).
  const chosen = approve(f, 'chosen', { planner: { provider: 'codex', model: 'review-default' }, builder: { provider: 'codex', model: 'review-default' } });
  assert.deepEqual(admissionReasons(f.store, chosen).filter(r => /usage limit/.test(r)), []);
  // A task choice back onto the held provider is held even when an override exists for another step.
  const back = approve(f, 'back', { builder: { provider: 'claude', model: 'build-default' } });
  assert.ok(admissionReasons(f.store, back, { modelOverrides: { plan: onCodex.plan } }).some(r => /model steps such as build/.test(r)));
});

test('a model step is held only when every provider it could start is held; a resumed builder keeps its session provider', t => {
  const f = delivery(t);
  record(f, 'claude', [{ window: 'five_hour', utilization: null, resetsAt: new Date(Date.now() + 3600000).toISOString(), status: 'exhausted' }]);
  const workflow = { nodes: { review: { kind: 'effect', action: { operation: 'provider.review' } }, build: { kind: 'effect', action: { operation: 'provider.build' } } } };
  const flow = (step, routes, extra = {}) => ({ id: 'fictional', step, workflow, modelRoutes: routes, ...extra });
  assert.match(stepHold(f.store, flow('review', { review: { provider: 'claude', model: 'm' } })).reason, /^claude usage limit hold/);
  assert.equal(stepHold(f.store, flow('review', { review: { provider: 'codex', model: 'm' } })), null);
  assert.equal(stepHold(f.store, flow('review', { review: { provider: 'claude', model: 'm', allowFallback: true, fallback: { provider: 'codex', model: 'x' } } })), null, 'an allowed fallback on another provider may run');
  assert.ok(stepHold(f.store, flow('build', { build: { provider: 'codex', model: 'm' } }, { sessions: { builder: session }, results: { build: { provider: 'claude' } } })), 'a resumed session never changes provider');
});

test('the operator can extend and clear a hold with attribution; the orchestrator needs delegation; holds survive a restart and clear at their time', async t => {
  const f = delivery(t);
  const orchestrator = executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'provider.hold', payload: { provider: 'claude', action: 'clear', note: 'Fictional' } });
  assert.equal(orchestrator.status, 'rejected'); assert.match(orchestrator.error, /operator authority required/);
  assert.match(f.command('provider.hold', { provider: 'claude', action: 'clear', note: 'Nothing held' }).error, /no active usage limit hold/);
  const later = new Date(Date.now() + 7200000).toISOString();
  const extended = f.command('provider.hold', { provider: 'claude', action: 'extend', until: later, note: 'Fictional account maintenance' });
  assert.equal(extended.status, 'completed', extended.error);
  assert.equal(providerHold(f.store, 'claude').by, 'operator'); assert.equal(providerHold(f.store, 'claude').source, 'operator');
  assert.match(f.command('provider.hold', { provider: 'claude', action: 'extend', until: new Date(Date.now() + 60000).toISOString(), note: 'Shorter' }).error, /later than the current hold/);
  const cleared = f.command('provider.hold', { provider: 'claude', action: 'clear', note: 'Fictional reset observed early' });
  assert.equal(cleared.status, 'completed', cleared.error);
  assert.equal(providerHold(f.store, 'claude'), null);
  const event = f.store.events(50).find(e => e.type === 'provider.limit-cleared');
  assert.equal(event.payload.by, 'operator'); assert.equal(event.payload.note, 'Fictional reset observed early');
  assert.equal(f.store.get('inbox', 'provider-hold:claude').status, 'resolved');

  // A short hold persists across a store reopen and is released by the next engine tick after its time.
  const soon = Date.now() + 1500;
  assert.equal(f.command('provider.hold', { provider: 'codex', action: 'extend', until: new Date(soon).toISOString(), note: 'Fictional short hold' }).status, 'completed');
  // A second connection reads only what was persisted, as a restarted service would.
  const reopened = new Store(f.stateDir), engine = new Engine(reopened); t.after(() => reopened.close());
  assert.ok(providerHold(reopened, 'codex'), 'the hold survived the restart');
  await until(() => Date.now() > soon);
  await engine.tick();
  assert.equal(reopened.meta('providerLimits').codex.hold, null);
  assert.equal(reopened.get('inbox', 'provider-hold:codex').status, 'resolved');
});

test('Stats and the console snapshot show limit state, holds and limit-exhausted attempts', async t => {
  const f = delivery(t);
  record(f, 'claude', [{ window: 'seven_day', utilization: 0.94, resetsAt: new Date(Date.now() + 86400000).toISOString(), status: 'allowed_warning', plan: 'fictional-plan' }, { window: 'five_hour', utilization: null, resetsAt: new Date(Date.now() + 3600000).toISOString(), status: 'exhausted' }]);
  const stats = projectStats(f.store, { window: '7d' }).providerLimits;
  assert.deepEqual(stats.held, ['claude']); assert.equal(stats.providers[0].plan, 'fictional-plan');
  assert.deepEqual(stats.providers[0].windows.map(w => [w.window, w.percent]), [['five_hour', null], ['seven_day', 94]]);
  assert.deepEqual(stats.policy, { noticePercent: 90, holdPercent: 100, defaultHoldMs: 18000000 });
  const snapshot = dashboardSnapshot(f.store);
  assert.deepEqual(snapshot.providerLimits.held, ['claude']); assert.deepEqual(snapshot.settings.holds.providerHolds, ['claude']);
  assert.equal(snapshot.settings.live['policy.providerLimitNoticePercent'].value, 90);
  const previous = Object.fromEntries(['document', 'localStorage', 'sessionStorage'].map(k => [k, globalThis[k]]));
  globalThis.document = { querySelector: () => ({ content: 'fictional-csrf' }) }; globalThis.localStorage = globalThis.sessionStorage = { getItem: () => null };
  try {
    const { attention } = await import('../starter/factory/console/ui/overview.mjs');
    const rows = attention({ projectId: 'fictional', status: 'available', snapshot: { providerLimits: snapshot.providerLimits, attempts: [{ id: 'a1', flowId: 'f1', step: 'review', status: 'uncertain', classification: 'limit-exhausted', reason: 'claude usage limit reached' }] } });
    assert.deepEqual(rows.map(r => r.title), ['Provider held · claude', 'Usage limit reached · review']);
  } finally { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
});

// End to end: engine, supervisor, dispatcher and the real adapter, with a fictional
// claude executable on PATH that reports usage-limit events.
async function fakeClaude(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fct-limit-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), dir = path.dirname(process.argv[1]), args = process.argv.slice(2);
if (args.includes('--version')) { console.log('2.1.323 (Fictional)'); process.exit(0); }
if (args.includes('--help')) { console.log(${JSON.stringify(help)}); process.exit(0); }
if (args.includes('auth')) { console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })); process.exit(0); }
const { events, code = 0, delayMs = 0 } = JSON.parse(fs.readFileSync(path.join(dir, 'behaviour.json'), 'utf8'));
setTimeout(() => { for (const e of events) console.log(JSON.stringify(e)); process.exit(code); }, delayMs);
`;
  await writeFile(join(dir, 'claude'), script); await chmod(join(dir, 'claude'), 0o700);
  const prior = process.env.PATH; process.env.PATH = `${dir}:${prior}`; t.after(() => { process.env.PATH = prior; });
  const behave = value => writeFileSync(join(dir, 'behaviour.json'), JSON.stringify(value));
  return { behave, dir };
}
function reviewSandbox(t) {
  const f = sandbox(t), ghPath = join(f.base, 'gh');
  writeFileSync(ghPath, `#!${process.execPath}\nif(process.argv[2]!=='auth')process.exit(9);console.log('fictional-token');`, { mode: 0o700 });
  const workflow = { version: 1, start: 'inspect', nodes: {
    inspect: { kind: 'effect', action: { operation: 'provider.review' }, timeoutMs: 60000, next: 'done', onFailure: 'failed', resultEdges: { pass: 'done', revise: 'failed' } },
    done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', ghPath }, providers: { builder: { provider: 'claude', model: 'build-default' }, reviewer: { provider: 'claude', model: 'review-default' } }, policy: { planning: false }, context: { files: [], maxChars: 1000 } });
  const startFlow = (taskId, flowId) => {
    if (!f.store.get('task', taskId)) f.command('task.put', { task: { id: taskId, title: taskId, acceptance: ['Fictional'] } });
    assert.equal(f.command('task.approve', { taskId, revision: f.store.need('task', taskId).revision }).status, 'completed');
    const started = f.command('flow.start', { taskId, flowId }); assert.equal(started.status, 'completed', started.error);
    const flow = f.store.need('flow', flowId); flow.results.source = { head: repositoryIdentity(f.root).head }; f.store.put('flow', flow);
    return flow;
  };
  return { ...f, startFlow };
}
const tick = f => () => f.engine.tick();
const review = utilization => [{ type: 'system', subtype: 'init', session_id: session }, rateEvent(utilization >= 0.9 ? 'allowed_warning' : 'allowed', utilization, epoch(Date.now() + 86400000)), ...succeed(reviewResult).slice(1)];

test('end to end: a limit-exhausted attempt is classified with evidence, holds new work, is not retried, and the hold clears by itself at the reported reset', async t => {
  const cli = await fakeClaude(t), f = reviewSandbox(t);
  // The reset is far enough away that load cannot make it pass before the assertions; the
  // test then moves the clock past it by releasing holds at an injected time.
  const resetMs = Date.now() + 3600000, reset = epoch(resetMs);
  cli.behave({ events: [{ type: 'system', subtype: 'init', session_id: session }, rateEvent('rejected', 1, reset, 'five_hour'), ...limitError(reset)], code: 1 });
  f.startFlow('task-1', 'flow-1');
  const attempt = await until(() => f.store.all('attempt').find(a => a.status === 'uncertain'), { tick: tick(f) });
  assert.equal(attempt.classification, 'limit-exhausted');
  assert.equal(attempt.limit.provider, 'claude'); assert.equal(attempt.limit.window, 'five_hour'); assert.equal(attempt.limit.resetsAt, new Date(reset * 1000).toISOString());
  assert.equal(attempt.limit.errorCode, 'USAGE_LIMIT');
  assert.match(attempt.reason, /usage limit reached after the model process started/);
  const flow = f.store.need('flow', 'flow-1');
  assert.equal(flow.state, 'stopped'); assert.match(flow.stopReason, /classified limit-exhausted and needs reconciliation/);
  assert.equal(providerHold(f.store, 'claude').until, new Date(reset * 1000).toISOString());
  for (let i = 0; i < 5; i++) await f.engine.tick();
  assert.equal(f.store.all('attempt').length, 1, 'never retried automatically');

  // Reconcile as the existing contract requires, then start new work: its model step waits on the hold.
  // The supervisor may still be exiting under load; resolution needs a quiet attempt.
  await until(() => f.command('attempt.resolve', { attemptId: attempt.id, disposition: 'failed', costMicros: 0, note: 'Fictional limit reached' }).status === 'completed', { tick: tick(f) });
  assert.equal(f.command('flow.abandon', { flowId: 'flow-1', note: 'Fictional' }).status, 'completed');
  cli.behave({ events: review(0.93) });
  f.startFlow('task-2', 'flow-2');
  await until(() => f.store.need('flow', 'flow-2').providerHold, { tick: tick(f) });
  assert.equal(f.store.need('flow', 'flow-2').state, 'waiting');
  assert.match(f.store.need('flow', 'flow-2').providerHold.reason, /^claude usage limit hold until/);
  assert.equal(f.store.all('attempt').length, 1, 'no attempt is prepared for a held provider');
  // At the reported reset the hold clears by itself (engine ticks release with the real clock;
  // here the clock is injected) and the step runs.
  assert.deepEqual(releaseExpiredHolds(f.store, reset * 1000 - 1), [], 'not before the reset');
  assert.deepEqual(releaseExpiredHolds(f.store, reset * 1000 + 1), ['claude']);
  await until(() => f.store.need('flow', 'flow-2').state === 'completed', { tick: tick(f) });
  assert.equal(f.store.need('flow', 'flow-2').providerHold, undefined);
  assert.ok(f.store.events(200).some(e => e.type === 'provider.limit-released'));
  assert.equal(f.store.get('inbox', 'provider-hold:claude').status, 'resolved');
  // The successful step reported 93% of a window: one operator notice for that window.
  assert.equal(f.store.all('inbox').filter(i => i.id.startsWith('provider-limit:claude:seven_day:')).length, 1);
});

test('end to end: running work is not interrupted by a hold, and a hold that arrives after preparation fences the dispatch', async t => {
  const cli = await fakeClaude(t), f = reviewSandbox(t);
  cli.behave({ events: review(0.5), delayMs: 1500 });
  f.startFlow('task-1', 'flow-1');
  await until(() => f.store.all('attempt').some(a => a.status === 'running'), { tick: tick(f) });
  assert.equal(f.command('provider.hold', { provider: 'claude', action: 'extend', until: new Date(Date.now() + 3600000).toISOString(), note: 'Fictional hold during work' }).status, 'completed');
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: tick(f) });
  assert.equal(f.store.all('attempt')[0].status, 'passed', 'the running attempt finished normally');

  // Clear, prepare the next step, then hold before dispatch: the prepared intent is fenced at zero cost.
  assert.equal(f.command('provider.hold', { provider: 'claude', action: 'clear', note: 'Fictional' }).status, 'completed');
  f.startFlow('task-2', 'flow-2');
  await until(() => f.store.all('attempt').some(a => a.flowId === 'flow-2' && a.status === 'prepared'), { tick: async () => { const flow = f.store.need('flow', 'flow-2'); if (!flow.attemptId) await f.engine.step('flow-2'); } });
  assert.equal(f.command('provider.hold', { provider: 'claude', action: 'extend', until: new Date(Date.now() + 3600000).toISOString(), note: 'Fictional late hold' }).status, 'completed');
  await f.engine.step('flow-2');
  const fenced = f.store.all('attempt').find(a => a.flowId === 'flow-2');
  assert.equal(fenced.status, 'not-dispatched'); assert.equal(fenced.costMicros, 0); assert.match(fenced.reason, /provider usage limit hold before dispatch/);
  assert.equal(f.store.need('flow', 'flow-2').state, 'waiting');
});
