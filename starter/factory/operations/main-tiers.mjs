import { assert } from '../core/contracts.mjs';

// Main-check tiers. Each `mainChecks` entry runs after every merge (`tier: "merge"`, the
// default) or only in a full verification (`tier: "scheduled"`): a main.verify schedule,
// doctor, or a manual main.verify. A verification runs either the merge tier ("merge") or
// every check ("all"). Merge-tier evidence keeps the one-hour freshness of
// policy.mainHealthMaxAgeMs; scheduled-tier evidence is carried across later writes of the
// target's health and has its own lifetime, policy.scheduledHealthMaxAgeMs.
export const MAIN_CHECK_TIERS = Object.freeze(['merge', 'scheduled']);
export const VERIFY_TIERS = Object.freeze(['merge', 'all']);
export const SCHEDULED_HEALTH_MAX_AGE_MS = 26 * 3600000;
export const checkTier = check => check?.tier ?? 'merge';
export const hasScheduledTier = config => (config?.mainChecks ?? []).some(check => checkTier(check) === 'scheduled');
export const scheduledHealthMaxAgeMs = config => config?.policy?.scheduledHealthMaxAgeMs ?? SCHEDULED_HEALTH_MAX_AGE_MS;
export function validateMainCheckTier(check) {
  assert(check.tier === undefined || MAIN_CHECK_TIERS.includes(check.tier), 'main check tier must be "merge" or "scheduled"');
}
export function validateMainCheckTiers(config) {
  for (const check of config.mainChecks ?? []) validateMainCheckTier(check);
  const maxAge = config.policy?.scheduledHealthMaxAgeMs;
  assert(maxAge === undefined || Number.isSafeInteger(maxAge) && maxAge >= 3600000 && maxAge <= 7 * 86400000, 'policy.scheduledHealthMaxAgeMs must be one hour to seven days');
  if (config.mainChecks?.length) assert(config.mainChecks.some(check => checkTier(check) === 'merge'), 'at least one main check must run after every merge (tier "merge")');
}
// The tier a main.verify job asks for: payload.tier, default every check.
export function verifyTier(payload) {
  const tier = payload?.tier ?? 'all';
  assert(VERIFY_TIERS.includes(tier), 'main.verify payload.tier must be "merge" or "all"');
  return tier;
}
export const checksForTier = (config, tier) => (config.mainChecks ?? []).filter(check => tier === 'all' || checkTier(check) === 'merge');
// The payload tier for a factory-requested verification. Projects without scheduled checks keep
// their payload unchanged: every check is a merge-tier check.
export const tierPayload = (config, tier) => hasScheduledTier(config) ? { tier } : {};

// Health writes carry the latest scheduled-tier evidence forward unless the write itself
// records a full verification (which sets `scheduled`). A failing scheduled tier latches the
// whole target red: only a full verification that passed entirely (every tier green in one
// run) or an explicit operator exception clears it. A merge-tier pass, a merge, a probe, or a
// full run whose scheduled checks passed while another check failed cannot. Such a full run is
// remembered on the latched evidence (`stillRedAt`) so it is not requested again for that
// head. Projects without scheduled-tier checks store no scheduled-tier evidence at all.
export function composeTargetHealth(previous, health, config) {
  if (!health || typeof health !== 'object') return health;
  const { scheduled: own, ...rest } = health;
  if (!hasScheduledTier(config)) return rest;
  const prior = previous?.scheduled;
  let scheduled = Object.hasOwn(health, 'scheduled') ? own : prior;
  if (prior?.status === 'red' && Object.hasOwn(health, 'scheduled') && own?.status !== 'red' && health.status !== 'green' && health.source !== 'operator-exception') {
    scheduled = { ...prior, stillRedAt: { head: health.head ?? null, checkedAt: health.checkedAt ?? null, status: health.status, ...(own?.flowId ? { flowId: own.flowId } : {}) } };
  }
  const next = scheduled ? { ...rest, scheduled } : rest;
  if (scheduled?.status === 'red' && next.status !== 'red') return { ...next, status: 'red', tierStatus: next.status, reason: scheduledRedText(scheduled) };
  return next;
}
// A red scheduled tier is verified again automatically only for a head that no full
// verification has run on since it failed.
export const scheduledRecheckDue = (scheduled, head) => !!head && head !== scheduled?.head && head !== scheduled?.stillRedAt?.head;
const ids = rows => rows.slice(0, 6).join(', ') + (rows.length > 6 ? ` and ${rows.length - 6} more` : '');
export const scheduledRedText = scheduled => `${scheduled.failed?.length ? `scheduled-tier check${scheduled.failed.length === 1 ? '' : 's'} ${ids(scheduled.failed)} failed` : `the scheduled tier was recorded red${scheduled.source ? ` (${scheduled.source})` : ''}`} at ${String(scheduled.head ?? '').slice(0, 12)} (${scheduled.checkedAt}); a merge-tier pass does not clear it`;

// Why the scheduled tier holds admission for this health record, or null. Only projects with
// scheduled-tier checks are held: red, never verified, or older than its lifetime.
export function scheduledTierHold(config, health, nowMs = Date.now()) {
  if (!hasScheduledTier(config)) return null;
  const scheduled = health?.scheduled, maxAge = scheduledHealthMaxAgeMs(config);
  if (!scheduled) return { kind: 'missing', maxAge };
  if (scheduled.status === 'red') return { kind: 'red', scheduled, maxAge };
  const at = Date.parse(scheduled.checkedAt);
  if (scheduled.status !== 'green' || !Number.isFinite(at) || at > nowMs || nowMs - at > maxAge) return { kind: 'stale', scheduled, maxAge };
  return null;
}
