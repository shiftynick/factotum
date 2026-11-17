import { assert, digest } from '../core/contracts.mjs';
import { DELEGABLE } from '../core/delegation.mjs';
import { UPKEEP_MODES } from '../core/upkeep-config.mjs';

// Live settings: admission, capacity, queue and notification knobs that do not change how a
// running flow behaves or what was authorized. They can change from the console without
// draining work or running doctor again, because a live change leaves the configuration
// digest (which running flows and commissioning are bound to) untouched. Everything else,
// including executable checks, providers and workflows, changes only through config update.
export const LIVE_SETTINGS = Object.freeze({
  'policy.autoQueue': { type: 'boolean', default: false },
  'policy.queueOnApproval': { type: 'boolean', default: false },
  'policy.maxFlows': { type: 'count', default: 1 },
  'policy.maxTaskFlows': { type: 'count', default: 5 },
  'policy.maxDocumentFlows': { type: 'count', default: 2 },
  // Change and document flows parked on an answer without holding a slot (operations/capacity.mjs).
  'policy.maxParkedFlows': { type: 'count', default: 3 },
  'policy.mainHealthMaxAgeMs': { type: 'duration', default: 3600000 },
  'policy.scheduledHealthMaxAgeMs': { type: 'duration', default: 93600000 },
  'policy.mainProbeMs': { type: 'duration', default: 60000 },
  'policy.queueRanking': { type: 'boolean', default: false },
  'policy.categoryOrder': { type: 'list', default: [] },
  'policy.categoryLimits': { type: 'limits', default: {} },
  'policy.delegatedOperations': { type: 'operations', default: DELEGABLE, operatorOnly: true },
  // Provider usage limits (readiness G7): notice and hold thresholds in percent of a usage
  // window, and the hold used when a provider reports exhaustion without a reset time.
  'policy.providerLimitNoticePercent': { type: 'count', default: 90 },
  'policy.providerLimitHoldPercent': { type: 'count', default: 100 },
  'policy.providerLimitDefaultHoldMs': { type: 'duration', default: 18000000 },
  'notifications.level': { type: 'choice', options: ['essential', 'actionable', 'all'], default: 'essential' },
  // Deliveries to one orchestrator session before it is asked to hand off (0: never asked), and
  // how many more before an unanswered or deferred question returns.
  // The orchestrator must not be able to switch off or postpone its own handoff prompt.
  'notifications.handoffAfterDeliveries': { type: 'count', default: 100, operatorOnly: true },
  'notifications.handoffRepeatDeliveries': { type: 'count', default: 25, operatorOnly: true },
  // Knowledge upkeep's mode. It is authority, not a plain knob: only the operator turns it up, and
  // anyone who may use settings.update may turn it down (core/upkeep-config.mjs; checked by every
  // writer of the configuration, so it is not listed as operatorOnly here).
  'upkeep.mode': { type: 'choice', options: UPKEEP_MODES, default: 'off' },
  // List prices for the Stats subscription estimate, USD per million tokens, by model.
  'stats.pricing': { type: 'pricing', default: {} },
});
const get = (config, path) => { const [a, b] = path.split('.'); return config?.[a]?.[b]; };
export const liveValue = (config, path) => get(config, path) ?? LIVE_SETTINGS[path].default;
// Operator-only live settings whose effective value (defaults applied) differs between two
// configurations. Every writer of the configuration checks this for a non-operator actor, so a
// delegated config.update, a replaceLive file, a file that drops the key (falling back to the
// default) or a mode change cannot change what settings.update refuses to change.
const effective = (config, path) => { const value = liveValue(config, path); return LIVE_SETTINGS[path].type === 'operations' && Array.isArray(value) ? [...value].sort() : value; };
export function operatorOnlyChanges(before, after) {
  return Object.keys(LIVE_SETTINGS).filter(path => LIVE_SETTINGS[path].operatorOnly && digest(effective(before, path) ?? null) !== digest(effective(after, path) ?? null));
}

// Apply live changes ({path: value}, null resets to the default) to a configuration copy.
export function applyLiveChanges(config, changes) {
  const next = structuredClone(config);
  for (const [path, value] of Object.entries(changes)) {
    assert(LIVE_SETTINGS[path], `${path} is not a live setting; change it with config update`);
    const [a, b] = path.split('.');
    next[a] ??= {};
    // A stored value an earlier release accepted may not be an object at all.
    assert(typeof next[a] === 'object' && !Array.isArray(next[a]), `${a} in the stored configuration is not an object, so ${path} cannot be set in it; replace ${a} with config update`);
    if (value === null) delete next[a][b]; else next[a][b] = value;
    // maxActiveFlows is an older alias of maxFlows; a live change replaces both.
    if (path === 'policy.maxFlows') delete next.policy.maxActiveFlows;
  }
  return next;
}

// Provenance of live changes (meta liveSettingChanges): {path: {by, onBehalfOf?, at, commandId,
// base}} for every live setting changed by settings.update since the last configuration commit,
// where base is the value the last committed file gave it. A configuration update keeps only
// these values; a key nobody changed live takes the file's value.
const same = (a, b) => digest(a ?? null) === digest(b ?? null);
// Projects from earlier releases have no record: rebuild it from the event log, where every
// settings.updated and config.update (with the live settings it kept) is recorded. Their base
// (what the file said) is unknown.
function provenanceFromEvents(store) {
  let changes = {}, committed = {};
  for (const row of store.db.prepare("SELECT at, type, payload FROM events WHERE type IN ('settings.updated', 'config.updated', 'config.kept-live-settings') ORDER BY sequence").all()) {
    const payload = JSON.parse(row.payload);
    if (row.type === 'settings.updated') { for (const path of Object.keys(payload.changes ?? {})) if (LIVE_SETTINGS[path]) changes[path] = { by: payload.by ?? null, at: row.at, baseUnknown: true }; }
    // A commit keeps only the live changes it lists in the kept-live-settings event recorded with it.
    else if (row.type === 'config.updated') { committed = changes; changes = {}; }
    else for (const path of payload.settings ?? []) { if (committed[path]) changes[path] = committed[path]; }
  }
  return changes;
}
export function liveSettingChanges(store) {
  const recorded = store.meta('liveSettingChanges', null);
  return recorded ?? provenanceFromEvents(store);
}
// settings.update records who changed each key; a key changed back to its committed value is
// no longer a live change.
export function recordLiveChanges(store, before, after, { actor, onBehalfOf, commandId, at = new Date().toISOString() }) {
  const changes = structuredClone(liveSettingChanges(store));
  for (const path of Object.keys(LIVE_SETTINGS)) {
    const old = get(before, path), now = get(after, path);
    if (same(old, now)) continue;
    const prior = changes[path], base = prior ? prior.base : old, baseUnknown = prior?.baseUnknown === true;
    if (!baseUnknown && same(base, now)) { delete changes[path]; continue; }
    changes[path] = { by: actor, ...(onBehalfOf ? { onBehalfOf } : {}), at, ...(commandId ? { commandId } : {}), ...(baseUnknown ? { baseUnknown: true } : { base: base ?? null }) };
  }
  store.setMeta('liveSettingChanges', changes);
}

// Configuration update keeps a stored live value only when it was changed live since the last
// configuration commit (provenance above), so a file edited for a pinned change does not quietly
// undo a console change, and a file change to a key nobody changed live is applied. Each kept key
// is reported with who changed it and when, and whether the file changed it too.
export function keepLiveValues(current, incoming, provenance = {}) {
  const next = structuredClone(incoming), kept = [], details = [], changes = {};
  if (!current || (current.mode ?? 'rehearsal') !== (incoming.mode ?? 'rehearsal')) return { config: next, kept, details, changes };
  for (const path of Object.keys(LIVE_SETTINGS)) {
    const now = get(current, path), file = get(next, path), live = provenance[path];
    if (!live || same(now, file)) continue;
    const [a, b] = path.split('.');
    next[a] ??= {};
    if (now === undefined) delete next[a][b]; else next[a][b] = structuredClone(now);
    if (path === 'policy.maxFlows') delete next.policy.maxActiveFlows;
    kept.push(path);
    details.push({ setting: path, liveValue: now ?? null, fileValue: file ?? null, changedBy: live.by ?? null, ...(live.onBehalfOf ? { onBehalfOf: live.onBehalfOf } : {}), changedAt: live.at ?? null, fileChanged: live.baseUnknown ? null : !same(file, live.base) });
    // Still a live change after this commit; the file it is now compared with is this one.
    changes[path] = { ...live, base: file ?? null }; delete changes[path].baseUnknown;
  }
  return { config: next, kept, details, changes };
}

// Every live setting whose effective value a configuration write changes, with the last live change
// to it (settings.updated, newest first) when there was one. config update reports these, so a live
// change the file reverts is named instead of silent (dev.88 M1). The scan reads only the newest
// settings.updated events, and only when a value changed.
const LAST_LIVE_SCAN = 500;
export function changedLiveSettings(store, before, after) {
  const changed = Object.keys(LIVE_SETTINGS).filter(path => !same(effective(before, path), effective(after, path)));
  if (!changed.length) return [];
  const last = {};
  for (const row of store.db.prepare("SELECT at, payload FROM events WHERE type = 'settings.updated' ORDER BY sequence DESC LIMIT ?").all(LAST_LIVE_SCAN)) {
    let payload; try { payload = JSON.parse(row.payload); } catch { continue; }
    for (const path of changed) if (!last[path] && Object.hasOwn(payload.changes ?? {}, path)) last[path] = { value: payload.changes[path], by: payload.by ?? null, ...(payload.onBehalfOf ? { onBehalfOf: payload.onBehalfOf } : {}), at: row.at };
    if (changed.every(path => last[path])) break;
  }
  return changed.map(path => ({ setting: path, from: liveValue(before, path) ?? null, to: liveValue(after, path) ?? null, ...(last[path] ? { lastLiveChange: last[path] } : {}) }));
}
