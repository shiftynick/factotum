// Read-only, versioned projection. Raw receipts are evidence and are never corrected in place.
export const ACCOUNTING_VERSION = 1;
const codexVersions = new Set(['0.163.0', '0.164.0', '0.166.0', '0.167.2', '0.169.0']);
const count = n => Number.isSafeInteger(n) && n >= 0;
const money = n => Number.isFinite(n) && n >= 0;
export const emptyTokens = () => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0 });
export const inputTokens = t => t.input + t.cachedInput + t.cacheWrite;
export const totalTokens = t => inputTokens(t) + t.output;

// Exact versions are deliberately qualified, not a promise about future CLI releases.
export function usageObservation({ provider, version, sessionId, resumedFrom, previousObservationId, id, startedAt, endedAt, event }) {
  const cliVersion = version.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? version;
  const codex = provider === 'codex' && codexVersions.has(cliVersion);
  const claude = provider === 'claude' && cliVersion === '2.1.323' && event.is_error !== true && (!event.subtype || event.subtype === 'success');
  const delta = claude && event.model_usage_since_last_result;
  return { version: ACCOUNTING_VERSION, id, provider, cliVersion, sessionId, resumedFrom: resumedFrom ?? null,
    previousObservationId: previousObservationId ?? null, startedAt, endedAt,
    tokenSemantics: codex ? 'session-cumulative' : delta ? 'invocation' : 'unknown',
    costSemantics: delta ? 'invocation' : claude ? 'session-cumulative' : 'unknown',
    format: codex ? 'codex-inclusive' : delta ? 'claude-model-delta' : 'unknown',
    raw: { usage: event.usage ?? null, ...(event.subtype ? { subtype: event.subtype, isError: event.is_error ?? null } : {}), ...(event.total_cost_usd === undefined ? {} : { totalCostUsd: event.total_cost_usd }),
      ...(event.modelUsage === undefined ? {} : { modelUsage: event.modelUsage }),
      ...(delta ? { modelUsageSinceLastResult: delta } : {}) } };
}

function counters(o) {
  if (o.format === 'codex-inclusive') {
    const u = o.raw?.usage;
    if (!u || !count(u.input_tokens) || !count(u.cached_input_tokens) || !count(u.output_tokens)) return null;
    // The qualified exec schema has no cache-write field. Nonzero future extensions need qualification.
    if (u.cache_write_input_tokens && u.cache_write_input_tokens !== 0) return null;
    if (u.reasoning_output_tokens !== undefined && (!count(u.reasoning_output_tokens) || u.reasoning_output_tokens > u.output_tokens)) return null;
    if (u.cached_input_tokens > u.input_tokens) return null;
    return { input: u.input_tokens, cachedInput: u.cached_input_tokens, cacheWrite: 0, output: u.output_tokens };
  }
  if (o.format === 'claude-model-delta') {
    const rows = o.raw?.modelUsageSinceLastResult;
    if (!rows || typeof rows !== 'object' || Array.isArray(rows)) return null;
    const sum = emptyTokens();
    for (const r of Object.values(rows)) {
      if (!r || ![r.inputTokens, r.cacheReadInputTokens, r.cacheCreationInputTokens, r.outputTokens].every(count)) return null;
      sum.input += r.inputTokens; sum.cachedInput += r.cacheReadInputTokens; sum.cacheWrite += r.cacheCreationInputTokens; sum.output += r.outputTokens;
    }
    return Object.values(sum).every(count) ? sum : null;
  }
  return null;
}
// Per-result delta cost; only present on qualified Claude delta observations.
function invocationCost(o) {
  if (o.format !== 'claude-model-delta') return null;
  const rows = o.raw?.modelUsageSinceLastResult;
  if (!rows || typeof rows !== 'object' || Array.isArray(rows) || !Object.values(rows).every(r => r && money(r.costUSD))) return null;
  return Object.values(rows).reduce((s, r) => s + r.costUSD, 0);
}
// Session-cumulative cost snapshot. Only a qualified successful Claude result carries one (delta or not);
// error and unqualified observations never establish a baseline, so their zeroed totals cannot mint spend.
function cumulativeCost(o) {
  const qualified = o?.provider === 'claude' && (o.format === 'claude-model-delta' || o.costSemantics === 'session-cumulative');
  return qualified && money(o.raw?.totalCostUsd) ? o.raw.totalCostUsd : null;
}
function subtract(current, previous) {
  if (!current || !previous) return null;
  const delta = Object.fromEntries(Object.keys(current).map(k => [k, current[k] - previous[k]]));
  return Object.values(delta).every(count) ? delta : null;
}
function normalized(c, format) {
  if (!c || !count(totalTokens(c))) return null;
  if (format === 'codex-inclusive') {
    if (c.cachedInput > c.input) return null;
    return { ...c, input: c.input - c.cachedInput };
  }
  return c;
}

export function accountingResult(result) {
  return Object.fromEntries(['provider', 'model', 'sessionId', 'usage', 'usageObservation', 'reportedCostUsd', 'billing'].filter(k => result[k] !== undefined).map(k => [k, result[k]]));
}

// The model operations: the ones whose attempt starts a provider.
export const isModelOperation = operation => String(operation).startsWith('provider.') || operation === 'audit' || operation === 'knowledge.upkeep';
// The invocations of one attempt. This is the one counting function (knowledge-upkeep design, 4.5):
// the projection below and the maintained daily totals (operations/upkeep-budget.mjs) both use it,
// so they count the same thing. For one attempt it returns:
//   1. the invocations its receipt names, when the action result carries the list. For
//      knowledge.upkeep the result always carries it, and an empty list means none: the run ended
//      at its pre-filter;
//   2. otherwise, when the action result is itself a provider result, that result and the originals
//      of its protocol corrections;
//   3. otherwise, with no usable receipt: none when the attempt was not dispatched or its operation
//      is not a model operation, and one (the route it would have started) when it is;
//   4. with an observation id that repeats inside the attempt counted once.
// A not-dispatched attempt whose receipt names invocations still counts them: the receipt is
// evidence that they ran. intentOf supplies the dispatch intent of an attempt read without it; it
// is asked only when the receipt does not already name the invocations.
export function attemptInvocations(attempt, intentOf = row => row.intent) {
  const result = attempt.receipt?.actionResult, listed = Array.isArray(result?.providerInvocations) ? result.providerInvocations : null;
  const named = listed?.length ? listed : result?.provider ? [...(result.protocolCorrections ?? []).map(x => x.original), result] : null;
  if (named) { const seen = new Set(); return named.filter(row => { const observation = row?.usageObservation?.id; if (!observation) return true; if (seen.has(observation)) return false; seen.add(observation); return true; }); }
  const a = intentOf(attempt)?.action ?? {};
  if (listed && a.operation === 'knowledge.upkeep') return [];
  if (attempt.status === 'not-dispatched' || !isModelOperation(a.operation)) return [];
  const role = a.operation === 'audit' ? (a.config?.providers?.auditor ? 'auditor' : 'reviewer') : a.operation === 'knowledge.upkeep' ? (a.config?.providers?.upkeep ? 'upkeep' : 'reviewer') : a.operation === 'provider.build' ? 'builder' : a.operation === 'provider.plan' ? 'planner' : 'reviewer';
  const route = role === 'builder' && a.sessions?.builder ? a.results?.build : a.modelRoute ?? (a.stepModel ? { ...a.config?.providers?.[role], ...a.stepModel } : a.config?.providers?.[role]);
  return [{ provider: route?.provider ?? 'unknown', model: route?.model ?? 'unknown', sessionId: role === 'builder' ? a.sessions?.builder : null }];
}

export function projectUsage(attempts, { intentOf } = {}) {
  const entries = attempts.flatMap(a => attemptInvocations(a, intentOf).map((r, i) => ({ attemptId: a.id, flowId: a.flowId, index: i, result: r,
    observation: r.usageObservation, start: Date.parse(r.usageObservation?.startedAt ?? a.receipt?.startedAt ?? a.createdAt),
    end: Date.parse(r.usageObservation?.endedAt ?? a.receipt?.endedAt), status: a.status })));
  entries.sort((a, b) => ((Number.isFinite(a.start) ? a.start : Infinity) - (Number.isFinite(b.start) ? b.start : Infinity) || a.attemptId.localeCompare(b.attemptId) || a.index - b.index));
  const sessions = new Map(), latestEnd = new Map(), seen = new Map();
  for (const e of entries) {
    const o = e.observation, r = e.result;
    e.accountingVersion = ACCOUNTING_VERSION; e.tokens = null; e.estimateUsd = null; e.reason = o ? 'unsupported-semantics' : r.usage ? 'legacy-attribution-unknown' : 'missing-observation';
    e.actualMicros = r.billing?.actualCostEvidence && count(r.billing?.actualMicros) ? r.billing.actualMicros : null;
    const key = r.sessionId ? `${r.provider}:${r.sessionId}` : null;
    const prev = key ? sessions.get(key) : null;
    if (o?.version === ACCOUNTING_VERSION && o.id && seen.has(o.id)) {
      const original = seen.get(o.id);
      e.reason = 'duplicate-observation'; e.duplicate = true;
      if (JSON.stringify(original.observation) !== JSON.stringify(o)) {
        original.tokens = null; original.estimateUsd = null; original.reason = 'conflicting-observation-id';
      }
      continue;
    }
    if (o?.id) seen.set(o.id, e);
    const valid = o?.version === ACCOUNTING_VERSION && typeof o.id === 'string' && !!o.id && typeof o.sessionId === 'string' && !!o.sessionId && (!o.resumedFrom || o.resumedFrom === o.sessionId) && o.provider === r.provider && o.sessionId === r.sessionId && Number.isFinite(e.start) && Number.isFinite(e.end) && e.end >= e.start;
    e.validObservation = valid;
    const overlap = prev && ((latestEnd.get(key) ?? 0) > e.start || !Number.isFinite(prev.end) || !Number.isFinite(e.start) || prev.end > e.start);
    if (overlap) { prev.tokens = null; prev.estimateUsd = null; prev.reason = 'overlapping-observations'; }
    const linked = valid && prev?.validObservation && !overlap && !['overlapping-observations', 'conflicting-observation-id'].includes(prev?.reason) && prev?.observation?.version === ACCOUNTING_VERSION && o.previousObservationId === prev.observation.id && prev.observation.cliVersion === o.cliVersion;
    if (valid && !overlap) {
      const c = counters(o);
      if (o.tokenSemantics === 'invocation') { e.tokens = normalized(c, o.format); e.reason = e.tokens ? 'measured' : 'invalid-counters'; }
      else if (o.tokenSemantics === 'session-cumulative') {
        const fresh = !o.resumedFrom && !prev;
        const delta = fresh ? c : linked ? subtract(c, counters(prev.observation)) : null;
        e.tokens = normalized(delta, o.format);
        e.reason = e.tokens ? 'measured' : !c ? 'invalid-counters' : linked ? 'counter-reset-or-inconsistent-delta' : 'missing-session-baseline';
      }
      if (o.costSemantics === 'invocation') e.estimateUsd = invocationCost(o);
      else if (o.costSemantics === 'session-cumulative' && cumulativeCost(o) !== null) {
        const cost = cumulativeCost(o), prior = linked ? cumulativeCost(prev.observation) : null;
        e.estimateUsd = !o.resumedFrom && !prev ? cost : prior !== null && cost >= prior ? cost - prior : null;
      }
    } else if (overlap) e.reason = 'overlapping-observations';
    if (key) { sessions.set(key, e); if (Number.isFinite(e.end)) latestEnd.set(key, Math.max(latestEnd.get(key) ?? 0, e.end)); }
  }
  const invalid = new Set(entries.filter(e => e.reason === 'conflicting-observation-id').map(e => e.observation.id));
  for (const e of entries) if ((e.observation?.tokenSemantics === 'session-cumulative' || e.observation?.costSemantics === 'session-cumulative') && invalid.has(e.observation.previousObservationId)) {
    e.tokens = null; e.estimateUsd = null; e.reason = 'conflicting-predecessor';
  }
  return entries;
}

export function usageEstimate(entry, pricing = {}) {
  if (entry.duplicate) return null;
  if (entry.estimateUsd !== null) return entry.estimateUsd;
  const r = entry.result, t = entry.tokens, p = pricing[r.model] ?? pricing[`${r.provider}/${r.model}`];
  if (!t || !p || ![p.input, p.output, p.cachedInput ?? p.input, p.cacheWrite ?? p.input].every(money)) return null;
  // A multi-model provider delta cannot be priced as the requested main model.
  if (entry.observation?.format === 'claude-model-delta') return null;
  return (t.input * p.input + t.cachedInput * (p.cachedInput ?? p.input) + t.cacheWrite * (p.cacheWrite ?? p.input) + t.output * p.output) / 1e6;
}
