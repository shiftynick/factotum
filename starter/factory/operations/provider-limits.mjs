import { assert, note, now } from '../core/contracts.mjs';
import { flowWorkflowKey, modelRole, stepSpec } from '../core/step-models.mjs';

// Subscription usage limits (readiness G7). Provider CLIs report how much of a
// usage window is used and when it resets; an error says when a limit is reached.
// The factory keeps the latest report per provider, tells the operator once per
// window near a threshold, and holds new work that would start a provider whose
// limit is reached until the reported reset (or a conservative default). Running
// work is never interrupted. State lives in project metadata, so it survives a restart.

export const LIMIT_DEFAULTS = Object.freeze({ noticePercent: 90, holdPercent: 100, defaultHoldMs: 5 * 3600000 });
// Sanity bound on an automatic hold: the longest provider window is a week, so a reported
// reset further away than this is not trusted as is. The hold uses the bound and says so;
// the operator can extend it (provider.hold, up to 30 days).
export const MAX_AUTOMATIC_HOLD_MS = 8 * 86400000;
export function limitPolicy(config) {
  const p = config?.policy ?? {};
  return { noticePercent: p.providerLimitNoticePercent ?? LIMIT_DEFAULTS.noticePercent, holdPercent: p.providerLimitHoldPercent ?? LIMIT_DEFAULTS.holdPercent, defaultHoldMs: p.providerLimitDefaultHoldMs ?? LIMIT_DEFAULTS.defaultHoldMs };
}
export function validateLimitPolicy(policy = {}) {
  const percent = (key, value) => assert(value === undefined || Number.isSafeInteger(value) && value >= 1 && value <= 100, `policy.${key} must be a whole percentage from 1 to 100`);
  percent('providerLimitNoticePercent', policy.providerLimitNoticePercent); percent('providerLimitHoldPercent', policy.providerLimitHoldPercent);
  const { noticePercent, holdPercent, defaultHoldMs } = limitPolicy({ policy });
  assert(noticePercent <= holdPercent, 'policy.providerLimitNoticePercent cannot exceed policy.providerLimitHoldPercent');
  assert(Number.isSafeInteger(defaultHoldMs) && defaultHoldMs >= 60000 && defaultHoldMs <= 30 * 86400000, 'policy.providerLimitDefaultHoldMs must be from 60000 (one minute) to 30 days');
}

// JavaScript dates end at ±8.64e15 ms; anything outside cannot be a reset time.
const MAX_DATE_MS = 8.64e15;
const isoMs = ms => Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS ? new Date(ms).toISOString() : null;
const iso = value => {
  // Providers report epoch seconds; accept milliseconds and ISO text too. A malformed or
  // out-of-range value is "no reset reported" for that signal only; it never throws.
  const ms = typeof value === 'number' && Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : typeof value === 'string' ? Date.parse(value) : NaN;
  return isoMs(ms);
};
const fraction = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, 10) : null;
const statusOf = (status, utilization) => status === 'rejected' || (utilization !== null && utilization >= 1) ? 'exhausted' : status === 'allowed_warning' ? 'warning' : 'allowed';
// Codex and Claude usage-limit error texts (Claude's typed api_error is preferred when present).
const LIMIT_TEXT = /hit your usage limit|usage limit reached|reached your usage limit|hit your limit/i;

// Limit signals in one invocation's JSONL output: [{window, utilization (0..1) | null,
// resetsAt (ISO) | null, status: allowed | warning | exhausted, source, plan?}].
// Unparseable lines and unknown shapes are ignored: absence of a report is not "allowed".
export function limitSignals(provider, stdout) {
  if (typeof stdout !== 'string' || !stdout) return [];
  const signals = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    try { lineSignals(provider, e, signals); } catch {} // One odd line loses only its own signals.
  }
  return signals;
}
function lineSignals(provider, e, signals) {
  if (provider === 'claude') {
    if (e.type === 'rate_limit_event' && e.rate_limit_info && typeof e.rate_limit_info === 'object') {
      const info = e.rate_limit_info, windows = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? Object.entries(info.unifiedWindows) : [];
      for (const [window, w] of windows) if (w && typeof w === 'object') {
        const utilization = fraction(w.utilization);
        signals.push({ window, utilization, resetsAt: iso(w.resetsAt), status: statusOf(w.status, utilization), source: 'rate_limit_event' });
      }
      // The top-level type is the window this event is about; a rejection there is exhaustion.
      const named = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown';
      if (!windows.some(([w]) => w === named)) { const utilization = fraction(info.utilization); signals.push({ window: named, utilization, resetsAt: iso(info.resetsAt), status: statusOf(info.status, utilization), source: 'rate_limit_event' }); }
      else if (info.status === 'rejected') signals.push({ window: named, utilization: fraction(info.utilization), resetsAt: iso(info.resetsAt), status: 'exhausted', source: 'rate_limit_event' });
    }
    const apiError = e.api_error ?? e.message?.api_error;
    if (apiError === 'usage_limit_reached') {
      const info = (e.api_error_params ?? e.message?.api_error_params)?.rate_limit_info ?? {};
      signals.push({ window: typeof info.rateLimitType === 'string' ? info.rateLimitType : 'unknown', utilization: fraction(info.utilization), resetsAt: iso(info.resetsAt), status: 'exhausted', source: 'usage_limit_reached' });
    } else if (e.type === 'result' && e.is_error === true && typeof e.result === 'string' && LIMIT_TEXT.test(e.result)) {
      signals.push({ window: 'unknown', utilization: null, resetsAt: null, status: 'exhausted', source: 'result-text' });
    }
  } else if (provider === 'codex') {
    const limits = e.rate_limits ?? e.payload?.rate_limits ?? e.msg?.rate_limits;
    if (limits && typeof limits === 'object') {
      for (const name of ['primary', 'secondary']) {
        const w = limits[name]; if (!w || typeof w !== 'object') continue;
        const utilization = fraction(typeof w.used_percent === 'number' ? w.used_percent / 100 : null);
        const resetsAt = iso(w.resets_at) ?? (Number.isFinite(w.resets_in_seconds) ? isoMs(Date.now() + w.resets_in_seconds * 1000) : null);
        const window = Number.isSafeInteger(w.window_minutes) ? `${name}-${w.window_minutes}m` : name;
        signals.push({ window, utilization, resetsAt, status: statusOf(null, utilization), source: 'rate_limits', ...(typeof limits.plan_type === 'string' ? { plan: limits.plan_type } : {}) });
      }
      if (limits.rate_limit_reached_type) signals.push({ window: String(limits.rate_limit_reached_type), utilization: null, resetsAt: null, status: 'exhausted', source: 'rate_limits' });
    }
    const message = e.type === 'error' ? e.message : e.type === 'turn.failed' ? e.error?.message : null;
    if (typeof message === 'string' && LIMIT_TEXT.test(message)) signals.push({ window: 'usage', utilization: null, resetsAt: null, status: 'exhausted', source: e.type });
  }
}
export const exhausted = signals => (signals ?? []).some(s => s?.status === 'exhausted');

const state = store => store.meta('providerLimits', {});
const save = (store, all) => store.setMeta('providerLimits', all);
const ms = value => Date.parse(value ?? '');
export function providerHold(store, provider, nowMs = Date.now()) {
  const hold = state(store)[provider]?.hold;
  return hold && ms(hold.until) > nowMs ? hold : null;
}
export const heldProviders = (store, nowMs = Date.now()) => Object.keys(state(store)).filter(p => providerHold(store, p, nowMs)).sort();
export const holdReason = (provider, hold) => `${provider} usage limit hold until ${hold.until}: ${hold.reason}`;

function openHoldNotice(store, provider, hold) {
  const id = `provider-hold:${provider}`, old = store.get('inbox', id), at = now();
  store.put('inbox', { id, kind: 'notice', role: 'operator', status: 'open', version: (old?.version ?? 0) + 1, createdAt: old?.status === 'open' ? old.createdAt : at, updatedAt: at,
    title: `${provider} usage limit: new ${provider} work is held`,
    summary: `${hold.reason}. New flows and steps that would start ${provider} wait until ${hold.until}; running work continues. Clear or extend with provider.hold.`,
    provider, until: hold.until });
}
function resolveHoldNotice(store, provider, resolution) {
  const id = `provider-hold:${provider}`, item = store.get('inbox', id);
  if (item?.status === 'open') store.put('inbox', { ...item, status: 'resolved', resolvedAt: now(), resolution, version: item.version + 1 });
}
function setHold(store, all, provider, hold) {
  const row = all[provider] ??= { provider, windows: {}, notices: {} };
  row.hold = hold; row.history = [...(row.history ?? []), { at: now(), ...hold }].slice(-20);
  save(store, all); openHoldNotice(store, provider, hold);
  store.event('provider.limit-held', { provider, until: hold.until, reason: hold.reason, source: hold.source, ...(hold.attemptId ? { attemptId: hold.attemptId } : {}), ...(hold.by ? { by: hold.by } : {}) });
}

// One report's signals, normalized: each reset is validated on its own (a malformed one
// reads as not reported), and duplicate descriptions of one refusal are coalesced. A
// refusal usually arrives twice, as a typed signal with its reset and as error text without
// one; when any exhausted signal of the report carries a reset time, exhausted signals
// without one are the same refusal with less evidence and are dropped.
function normalizeSignals(signals) {
  const valid = signals.filter(s => s && typeof s === 'object' && typeof s.window === 'string')
    .map(s => ({ ...s, utilization: fraction(s.utilization), resetsAt: iso(s.resetsAt) }));
  const typedReset = valid.some(s => s.status === 'exhausted' && s.resetsAt);
  return typedReset ? valid.filter(s => !(s.status === 'exhausted' && !s.resetsAt)) : valid;
}

// Record one invocation's limit signals. Call inside the transaction that settles the attempt.
// observedAt is when the provider reported them (the process end), which can be well before
// a delayed settlement: a reset that has already passed creates no hold, and a default hold
// for a refusal without a reset time runs from when it was observed.
export function recordLimitSignals(store, { provider, signals, attemptId = null, flowId = null, observedAt = now(), nowMs = Date.now() }) {
  if (!['codex', 'claude'].includes(provider) || !Array.isArray(signals) || !signals.length) return;
  const policy = limitPolicy(store.meta('config', {})), all = structuredClone(state(store));
  const row = all[provider] ??= { provider, windows: {}, notices: {} };
  row.windows ??= {}; row.notices ??= {};
  const observedMs = Math.min(nowMs, Number.isFinite(ms(observedAt)) ? ms(observedAt) : nowMs), boundMs = nowMs + MAX_AUTOMATIC_HOLD_MS;
  let holdUntil = null, holdSignal = null, capped = false;
  for (const s of normalizeSignals(signals)) {
    if (typeof s.plan === 'string') row.plan = s.plan;
    const reset = ms(s.resetsAt), elapsed = Number.isFinite(reset) && reset <= nowMs, future = Number.isFinite(reset) && reset > nowMs;
    const prior = row.windows[s.window];
    // Attempts can settle out of order: never let an older report replace a newer one
    // (an exhaustion does, unless its window has already reset).
    if (!prior || ms(prior.observedAt) <= ms(observedAt) || s.status === 'exhausted' && !elapsed) row.windows[s.window] = { window: s.window, utilization: s.utilization, resetsAt: s.resetsAt, status: s.status, source: s.source ?? null, observedAt, attemptId };
    row.observedAt = observedAt;
    const percent = s.utilization === null ? null : Math.round(s.utilization * 100);
    // One notice per window: the window's reset time identifies it.
    const key = `${s.window}:${s.resetsAt ?? 'unknown'}`;
    if ((s.status === 'exhausted' || percent !== null && percent >= policy.noticePercent) && !row.notices[key] && !elapsed) {
      row.notices[key] = observedAt;
      const id = `provider-limit:${provider}:${key}${s.resetsAt ? '' : `:${observedAt}`}`;
      if (!store.get('inbox', id)) {
        store.put('inbox', { id, kind: 'notice', role: 'operator', status: 'open', version: 1, createdAt: now(), provider, window: s.window, resetsAt: s.resetsAt, utilization: s.utilization,
          title: `${provider} ${s.window} usage ${s.status === 'exhausted' ? 'limit reached' : `at ${percent}%`}`,
          summary: `${provider} reported ${s.status === 'exhausted' ? 'its usage limit reached' : `${percent}% of its ${s.window} usage window used`} (notice threshold ${policy.noticePercent}%, hold threshold ${policy.holdPercent}%)${s.resetsAt ? `; the window resets ${s.resetsAt}` : '; no reset time was reported'}.` });
        store.event('provider.limit-notice', { provider, window: s.window, utilization: s.utilization, resetsAt: s.resetsAt, status: s.status, attemptId, flowId });
      }
    }
    if (s.status === 'exhausted' || percent !== null && percent >= policy.holdPercent) {
      // Hold until the reported reset (bounded); a reset already passed holds nothing; without
      // one, the default hold from when the limit was observed. Distinct windows keep the latest.
      const wanted = future ? reset : elapsed ? null : observedMs + policy.defaultHoldMs;
      if (wanted === null || wanted <= nowMs) continue;
      const until = Math.min(wanted, boundMs);
      if (holdUntil === null || until > holdUntil) { holdUntil = until; holdSignal = s; capped = wanted > boundMs; }
    }
  }
  // Forget notice keys of windows that have reset.
  for (const key of Object.keys(row.notices)) { const reset = ms(key.slice(key.indexOf(':') + 1)); if (Number.isFinite(reset) && reset <= nowMs - 86400000) delete row.notices[key]; }
  save(store, all);
  if (holdUntil !== null) {
    const current = providerHold(store, provider, nowMs);
    if (current && ms(current.until) >= holdUntil) return;
    const percent = holdSignal.utilization === null ? null : Math.round(holdSignal.utilization * 100), days = MAX_AUTOMATIC_HOLD_MS / 86400000;
    const cause = holdSignal.status === 'exhausted' ? `${provider} reported its ${holdSignal.window} usage limit reached${holdSignal.resetsAt ? '' : `; no reset time was reported, so the default hold of ${Math.round(policy.defaultHoldMs / 60000)} minutes applies`}` : `${provider} ${holdSignal.window} usage at ${percent}% reached the hold threshold of ${policy.holdPercent}%`;
    setHold(store, all, provider, { since: now(), until: new Date(holdUntil).toISOString(), source: holdSignal.status === 'exhausted' ? 'exhausted' : 'threshold', window: holdSignal.window,
      resetReported: Boolean(holdSignal.resetsAt), attemptId, flowId, ...(capped ? { reportedReset: holdSignal.resetsAt, capped: true } : {}),
      reason: capped ? `${cause}; the reported reset ${holdSignal.resetsAt} is more than ${days} days away, so the automatic hold stops at the ${days}-day bound (extend it with provider.hold if the limit really lasts longer)` : cause });
  }
}

// Record every provider invocation of a terminal attempt's action result.
export function recordAttemptLimits(store, attempt, actionResult, observedAt) {
  for (const invocation of actionResult?.providerInvocations ?? []) if (Array.isArray(invocation?.limits)) recordLimitSignals(store, { provider: invocation.provider, signals: invocation.limits, attemptId: attempt.id, flowId: attempt.flowId, observedAt: observedAt ?? now() });
}
// An uncertain attempt that ended because its provider's usage limit was reached.
export function limitExhaustion(actionResult) {
  if (!actionResult?.uncertain) return null;
  const invocations = (actionResult.providerInvocations ?? []).filter(i => exhausted(i?.limits));
  if (actionResult.limitExhausted !== true && !invocations.length) return null;
  const last = invocations.at(-1), refusals = last?.limits?.filter(s => s?.status === 'exhausted') ?? [];
  // Typed evidence with a reset time describes the refusal better than error text without one.
  const signal = refusals.filter(s => iso(s.resetsAt)).at(-1) ?? refusals.at(-1) ?? null;
  return { provider: last?.provider ?? actionResult.limitProvider ?? null, model: last?.model ?? null, window: signal?.window ?? null, resetsAt: iso(signal?.resetsAt), source: signal?.source ?? null, errorCode: actionResult.limitExhausted ? 'USAGE_LIMIT' : null };
}

// A window without a reported reset is noticed once per hold; after the hold ends it may be noticed again.
const forgetUnknownWindows = row => { row.notices = Object.fromEntries(Object.entries(row.notices ?? {}).filter(([key]) => !key.endsWith(':unknown'))); };
// Clear holds whose time has passed. Called from the engine tick; cheap when nothing is held.
export function releaseExpiredHolds(store, nowMs = Date.now()) {
  const current = state(store), expired = Object.entries(current).filter(([, row]) => row.hold && ms(row.hold.until) <= nowMs);
  if (!expired.length) return [];
  return store.tx(() => {
    const all = structuredClone(state(store)), released = [];
    for (const [provider, row] of Object.entries(all)) {
      if (!row.hold || ms(row.hold.until) > nowMs) continue;
      const { until } = row.hold; row.hold = null; forgetUnknownWindows(row); row.history = [...(row.history ?? []), { at: now(), cleared: 'reset', until }].slice(-20);
      resolveHoldNotice(store, provider, { kind: 'expired', actor: 'factory', at: now() });
      store.event('provider.limit-released', { provider, until, automatic: true }); released.push(provider);
    }
    save(store, all); return released;
  });
}

// provider.hold {provider, action: clear | extend, until?, note}: the operator ends a hold
// early, or extends (or starts) one to a later time. Recorded with attribution.
export function operatorHold(store, p, { actor, onBehalfOf } = {}) {
  assert(p && typeof p === 'object' && Object.keys(p).every(k => ['provider', 'action', 'until', 'note'].includes(k)), 'provider.hold accepts provider, action, until and note');
  assert(['codex', 'claude'].includes(p.provider), 'provider must be codex or claude');
  assert(['clear', 'extend'].includes(p.action), 'action must be clear or extend');
  note(p.note);
  const all = structuredClone(state(store)), nowMs = Date.now(), current = providerHold(store, p.provider, nowMs), by = { actor, ...(onBehalfOf ? { onBehalfOf } : {}) };
  if (p.action === 'clear') {
    assert(p.until === undefined, 'clear takes no until');
    assert(current, `${p.provider} has no active usage limit hold`);
    const row = all[p.provider]; row.hold = null; forgetUnknownWindows(row); row.history = [...(row.history ?? []), { at: now(), cleared: 'operator', until: current.until, by: actor, note: p.note }].slice(-20);
    save(store, all); resolveHoldNotice(store, p.provider, { kind: 'cleared', actor, at: now() });
    store.event('provider.limit-cleared', { provider: p.provider, until: current.until, by: actor, note: p.note, ...(onBehalfOf ? { onBehalfOf } : {}) });
    return { provider: p.provider, held: false, cleared: current };
  }
  const until = ms(p.until);
  assert(typeof p.until === 'string' && Number.isFinite(until) && until > nowMs, 'extend needs until: a future ISO time');
  assert(until <= nowMs + 30 * 86400000, 'a hold extends at most 30 days ahead');
  assert(!current || until > ms(current.until), `until must be later than the current hold (${current?.until}); use clear to end it early`);
  const hold = { since: current?.since ?? now(), until: new Date(until).toISOString(), source: 'operator', window: current?.window ?? null, reason: `${current ? 'extended' : 'held'} by the ${actor}: ${p.note}`, by: by.actor, note: p.note, ...(current ? { extendedFrom: current.until } : {}) };
  setHold(store, all, p.provider, hold);
  return { provider: p.provider, held: true, hold };
}

// The providers a model step could start, in order: its pinned route (or the
// configured one), then an allowed fallback. A resumed builder session never
// changes provider, so only that provider counts.
export function stepProviders(store, flow, step = flow.step) {
  const config = store.meta('config', {}), node = flow.workflow?.nodes?.[step], role = modelRole(step, node, config);
  if (!role) return [];
  if (role === 'builder' && flow.sessions?.builder && flow.results?.build?.provider) return [flow.results.build.provider];
  const route = flow.modelRoutes?.[step] ?? (config.providers?.[role] ? stepSpec(config.providers[role], config.stepModels?.[flowWorkflowKey(flow)]?.[step]) : null);
  if (!route?.provider) return [];
  return [route.provider, ...(route.allowFallback && route.fallback ? [route.fallback.provider ?? route.provider] : [])];
}
// A step is held only when every provider it could start is held.
export function stepHold(store, flow, step = flow.step, nowMs = Date.now()) {
  const providers = stepProviders(store, flow, step);
  if (!providers.length) return null;
  const holds = providers.map(provider => [provider, providerHold(store, provider, nowMs)]);
  if (!holds.every(([, hold]) => hold)) return null;
  const [provider, hold] = holds[0];
  return { provider, until: hold.until, reason: holdReason(provider, hold) };
}
// Admission: the routes a flow would pin (or did pin). A flow is held when any
// of its model steps could only start held providers.
export function routeHoldReasons(store, routes, nowMs = Date.now()) {
  const reasons = new Set();
  for (const [step, route] of Object.entries(routes ?? {})) {
    const providers = [route.provider, ...(route.allowFallback && route.fallback ? [route.fallback.provider ?? route.provider] : [])];
    const holds = providers.map(p => [p, providerHold(store, p, nowMs)]);
    if (holds.length && holds.every(([, hold]) => hold)) reasons.add(`${holdReason(holds[0][0], holds[0][1])}; model steps such as ${step} would start it`);
  }
  // One reason per provider keeps queue diagnostics short and stable.
  const byProvider = new Map();
  for (const reason of reasons) { const provider = reason.split(' ')[0]; if (!byProvider.has(provider)) byProvider.set(provider, reason); }
  return [...byProvider.values()];
}

export function markStepHold(store, flow, hold) {
  const next = { step: flow.step, provider: hold.provider, until: hold.until, reason: hold.reason };
  if (flow.providerHold && flow.providerHold.step === next.step && flow.providerHold.provider === next.provider && flow.providerHold.until === next.until && flow.state === 'waiting') return true;
  flow.providerHold = { ...next, since: flow.providerHold?.since ?? now() }; flow.state = 'waiting'; store.put('flow', flow);
  store.event('flow.provider-held', { flowId: flow.id, taskId: flow.taskId, ...next });
  return true;
}
export function clearStepHold(store, flow) {
  if (!flow.providerHold) return;
  const { step, provider } = flow.providerHold; delete flow.providerHold;
  if (flow.state === 'waiting') flow.state = 'ready';
  store.put('flow', flow); store.event('flow.provider-released', { flowId: flow.id, step, provider });
}

export function providerLimitView(store, nowMs = Date.now()) {
  const policy = limitPolicy(store.meta('config', {}));
  const providers = Object.values(state(store)).map(row => {
    const hold = providerHold(store, row.provider, nowMs);
    return { provider: row.provider, plan: row.plan ?? null, observedAt: row.observedAt ?? null, held: Boolean(hold), hold: hold ?? null,
      windows: Object.values(row.windows ?? {}).map(w => ({ ...w, percent: w.utilization === null ? null : Math.round(w.utilization * 100), reset: Boolean(w.resetsAt && ms(w.resetsAt) <= nowMs) })).sort((a, b) => a.window.localeCompare(b.window)),
      history: (row.history ?? []).slice(-5) };
  }).sort((a, b) => a.provider.localeCompare(b.provider));
  return { policy, providers, held: providers.filter(p => p.held).map(p => p.provider) };
}
