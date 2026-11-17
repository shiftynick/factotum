import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { usageObservation, projectUsage, totalTokens, inputTokens, usageEstimate } from '../starter/factory/operations/usage-accounting.mjs';
globalThis.document = { querySelector: () => ({ content: 'test-csrf' }) };
globalThis.localStorage = globalThis.sessionStorage = { getItem: () => null };
const { accountingRows } = await import('../starter/factory/console/ui/stats.mjs');
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/usage/qualified.json', import.meta.url)));
const at = n => new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString();
function attempt(id, n, event, { provider = 'codex', previous, resumed = !!previous, session = 'fictional-session', version = provider === 'codex' ? 'codex-cli 0.169.0' : '2.1.323', status = 'passed' } = {}) {
  const usageObservation_ = usageObservation({ provider, version, id, sessionId: session, resumedFrom: resumed ? session : null, previousObservationId: previous, startedAt: at(n), endedAt: at(n + 1), event });
  return { id, flowId: 'flow', status, createdAt: at(n), receipt: { startedAt: at(n), endedAt: at(n + 1), actionResult: { provider, model: 'fictional-model', sessionId: session, usage: event.usage, usageObservation: usageObservation_ } } };
}
const pair = () => [attempt('a', 0, fixtures.codexFirst), attempt('b', 2, fixtures.codexResume, { previous: 'a' })];

test('qualified Codex first and resumed observations have disjoint deltas, reasoning is included once', () => {
  const input = pair(), before = JSON.stringify(input), rows = projectUsage(input);
  assert.deepEqual(rows.map(r => r.tokens), [{ input: 400, cachedInput: 600, cacheWrite: 0, output: 100 }, { input: 200, cachedInput: 300, cacheWrite: 0, output: 80 }]);
  assert.equal(rows.reduce((s, r) => s + totalTokens(r.tokens), 0), 1680);
  assert.equal(rows.reduce((s, r) => s + inputTokens(r.tokens), 0), 1500);
  assert.equal(usageEstimate(rows[1], { 'fictional-model': { input: 2, cachedInput: 1, output: 10 } }), .0015);
  assert.equal(JSON.stringify(input), before, 'immutable evidence');
});
test('out-of-order arrival and replay give deterministic attribution, duplicate observation excluded', () => {
  const [a, b] = pair(), duplicate = structuredClone(b); duplicate.id = 'replay';
  const rows = projectUsage([duplicate, b, a]);
  assert.deepEqual(rows.filter(r => !r.duplicate).map(r => r.tokens), projectUsage([a, b]).map(r => r.tokens));
  assert.equal(rows.filter(r => r.duplicate).length, 1);
  assert.equal(projectUsage([a, b]).length, 2, 'settlement projection can be replayed without state');
});
test('counter reset is unknown, establishes a new baseline only for the next linked segment', () => {
  const rows = projectUsage([...pair(), attempt('c', 4, fixtures.codexReset, { previous: 'b' }), attempt('d', 6, { usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 40 } }, { previous: 'c' })]);
  assert.equal(rows[2].tokens, null); assert.equal(rows[2].reason, 'counter-reset-or-inconsistent-delta');
  assert.deepEqual(rows[3].tokens, { input: 50, cachedInput: 50, cacheWrite: 0, output: 20 });
});
test('missing/uncertain predecessor, legacy, unqualified version, invalid counters and overlapping calls are unknown', () => {
  const [a, b] = pair();
  assert.equal(projectUsage([b])[0].reason, 'missing-session-baseline');
  const missing = { id: 'missing', createdAt: at(1), status: 'uncertain', intent: { action: { operation: 'provider.build', sessions: { builder: 'fictional-session' }, results: { build: { provider: 'codex', model: 'fictional-model' } } } } };
  assert.equal(projectUsage([a, missing, b]).at(-1).tokens, null);
  const legacy = structuredClone(a); delete legacy.receipt.actionResult.usageObservation;
  assert.equal(projectUsage([legacy])[0].reason, 'legacy-attribution-unknown');
  assert.equal(projectUsage([attempt('u', 0, fixtures.codexFirst, { version: '0.999.0' })])[0].tokens, null);
  assert.equal(projectUsage([attempt('u', 0, { usage: { input_tokens: -1, cached_input_tokens: 0, output_tokens: 10 } })])[0].tokens, null);
  b.receipt.actionResult.usageObservation.startedAt = at(0);
  assert.ok(projectUsage([a, b]).every(r => r.tokens === null));
});
test('Claude invocation delta is not subtracted on resume and cumulative raw cost is not mistaken for its delta', () => {
  const rows = projectUsage([attempt('a', 0, fixtures.claudeFirst, { provider: 'claude' }), attempt('b', 2, fixtures.claudeResume, { provider: 'claude', previous: 'a' })]);
  assert.deepEqual(rows[1].tokens, { input: 50, cachedInput: 300, cacheWrite: 0, output: 20 });
  assert.equal(rows[0].estimateUsd, 1.25); assert.equal(rows[1].estimateUsd, .75);
  assert.equal(rows[1].actualMicros, null);
});
test('Claude without per-result deltas keeps token semantics unknown and differences only qualified cumulative cost', () => {
  const event = cost => ({ total_cost_usd: cost, usage: { input_tokens: 20, output_tokens: 10 } });
  const rows = projectUsage([attempt('a', 0, event(2), { provider: 'claude' }), attempt('b', 2, event(3), { provider: 'claude', previous: 'a' }), attempt('c', 4, event(.5), { provider: 'claude', previous: 'b' })]);
  assert.ok(rows.every(r => r.tokens === null)); assert.deepEqual(rows.map(r => r.estimateUsd), [2, 1, null]);
});
test('failed structured result with valid observation remains usage evidence; extra correction invocations counted', () => {
  const [a, b] = pair(); a.status = 'failed';
  const result = b.receipt.actionResult; result.protocolCorrections = [{ original: a.receipt.actionResult }];
  assert.equal(projectUsage([b]).length, 2);
  assert.equal(projectUsage([a])[0].reason, 'measured');
});
test('UI coverage formatter distinguishes missing tokens, known spend and the two populations', () => {
  const summary = { measured: 0, invocations: 2, missing: 2, duplicateObservations: 1, inputTokens: null, totalTokens: null, actualMicros: null, actualUnknown: 2 };
  const rows = accountingRows({ completionCohort: summary, attemptWindow: { ...summary, totalTokens: 1500, inputTokens: 1000, actualMicros: 10, actualUnknown: 1 } });
  assert.equal(rows[0].total, '—'); assert.match(rows[0].coverage, /2 unknown; 1 duplicates/); assert.match(rows[0].actual, /unavailable/);
  assert.equal(rows[1].input, '1.0k'); assert.equal(rows[1].total, '1.5k'); assert.match(rows[1].actual, /known; 1 unknown/);
});

test('inconsistent deltas and conflicting replay IDs cannot mint tokens or prices', () => {
  const [a, b] = pair(), conflict = structuredClone(a); conflict.id = 'replay';
  conflict.receipt.actionResult.usageObservation.raw.usage.input_tokens++;
  assert.ok(projectUsage([a, b, conflict]).every(r => r.tokens === null));
  const invalid = attempt('b', 2, { usage: { input_tokens: 1100, cached_input_tokens: 900, output_tokens: 110 } }, { previous: 'a' });
  assert.equal(projectUsage([a, invalid])[1].tokens, null, 'cache delta larger than input delta is not clamped to zero');
  const unchanged = attempt('b', 2, fixtures.codexFirst, { previous: 'a' });
  assert.equal(totalTokens(projectUsage([a, unchanged])[1].tokens), 0, 'known equal counters measure zero, unlike missing data');
});
test('a long overlapping observation invalidates subsequent overlapping intervals', () => {
  const a = attempt('a', 0, fixtures.codexFirst), b = attempt('b', 2, fixtures.codexResume, { previous: 'a' }), c = attempt('c', 4, fixtures.codexResume, { previous: 'b' });
  a.receipt.actionResult.usageObservation.endedAt = at(10);
  assert.ok(projectUsage([a, b, c]).every(r => r.tokens === null));
});

test('maintenance audit retains invocation accounting on success and validation failure', async t => {
  const { sandbox } = await import('./helpers.mjs');
  const { runMaintenanceAction } = await import('../starter/factory/workflows/maintenance.mjs');
  const f = sandbox(t), invocation = attempt('audit', 0, fixtures.codexFirst).receipt.actionResult;
  const intent = { cwd: f.root, action: { operation: 'audit', config: { mode: 'rehearsal', providers: { auditor: { provider: 'codex', model: 'fictional-model' } } }, artifactDir: f.base } };
  const result = await runMaintenanceAction(intent, { providerInvoke: async () => ({ ...invocation, result: { verdict: 'pass', summary: 'Fictional audit', findings: [] } }) });
  assert.equal(result.providerInvocations[0].usageObservation.id, 'audit');
  await assert.rejects(runMaintenanceAction(intent, { providerInvoke: async () => ({ ...invocation, result: {} }) }), error => {
    assert.equal(error.providerInvocations[0].usageObservation.id, 'audit'); return true;
  });
});

test('Claude error totals may be zeroed and are never treated as measured zero spend', () => {
  const row = projectUsage([attempt('failed', 0, { subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, usage: {}, model_usage_since_last_result: {} }, { provider: 'claude', status: 'failed' })])[0];
  assert.equal(row.tokens, null); assert.equal(row.estimateUsd, null);
  const malformed = structuredClone(fixtures.claudeFirst); malformed.model_usage_since_last_result = { fictional: null };
  assert.equal(projectUsage([attempt('invalid', 0, malformed, { provider: 'claude' })])[0].tokens, null);
});

test('Claude cumulative cost never uses a per-result delta or an error total as its baseline', () => {
  const delta = (total, cost) => ({ type: 'result', subtype: 'success', total_cost_usd: total, usage: {}, model_usage_since_last_result: { 'fictional-model': { inputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 1, costUSD: cost } } });
  const cumulative = total => ({ type: 'result', subtype: 'success', total_cost_usd: total, usage: {} });
  const mixed = projectUsage([attempt('a', 0, delta(2, 2), { provider: 'claude' }), attempt('b', 2, delta(5, 3), { provider: 'claude', previous: 'a' }), attempt('c', 4, cumulative(7), { provider: 'claude', previous: 'b' })]);
  assert.deepEqual(mixed.map(r => r.estimateUsd), [2, 3, 2], 'delta-to-cumulative transition differences session totals');
  const error = { subtype: 'error_during_execution', is_error: true, total_cost_usd: 0, usage: {} };
  const recovered = projectUsage([attempt('a', 0, cumulative(2), { provider: 'claude' }), attempt('e', 2, error, { provider: 'claude', previous: 'a', status: 'failed' }),
    attempt('c', 4, cumulative(9), { provider: 'claude', previous: 'e' }), attempt('d', 6, cumulative(10), { provider: 'claude', previous: 'c' })]);
  assert.deepEqual(recovered.map(r => r.estimateUsd), [2, null, null, 1], 'an error result is not a zero baseline; the next qualified result re-establishes one');
});
