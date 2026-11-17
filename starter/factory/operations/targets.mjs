import { assert } from '../core/contracts.mjs';
import { composeTargetHealth } from './main-tiers.mjs';

// Target branches. A project has a default target (repository.target); a workflow definition
// can name another (`target`), and its flows integrate, publish and merge there. Health is
// tracked per target: the default keeps meta('mainHealth'), others live in meta('targetHealth').
export const defaultTarget = config => config?.repository?.target ?? null;
export function projectTargets(store) {
  const config = store.meta('config', {}), catalog = store.meta('catalog');
  return [...new Set([defaultTarget(config), ...Object.values(catalog?.workflows ?? {}).map(w => w.target).filter(Boolean)].filter(Boolean))];
}
// The target of a flow (pinned when it started), or of a task (through its selected workflow).
export function targetOf(store, subject) {
  const config = store.meta('config', {});
  if (subject?.target) return subject.target;
  const catalog = store.meta('catalog');
  if (catalog && subject && !subject.taskId) {
    const name = subject.workflow ?? catalog.selection?.rules?.find(r => r.label ? (subject.labels ?? []).includes(r.label) : r.category === subject.category)?.workflow ?? catalog.selection?.default;
    return catalog.workflows?.[name]?.target ?? defaultTarget(config);
  }
  if (subject?.workflowName && catalog) return catalog.workflows?.[subject.workflowName]?.target ?? defaultTarget(config);
  return defaultTarget(config);
}
const isDefault = (store, target) => !target || target === defaultTarget(store.meta('config', {}));
export function targetHealth(store, target) {
  return isDefault(store, target) ? store.meta('mainHealth', null) : store.meta('targetHealth', {})[target] ?? null;
}
// A late verifier/source observation may not overwrite newer health. Legacy
// records start at generation zero; all canonical health writes advance it.
export const targetHealthVersion = (store, target) => store.meta('targetHealthVersions', {})[target ?? defaultTarget(store.meta('config', {}))] ?? 0;
export function pendingTargetSync(store, target) {
  if (!target) return undefined;
  // Admission calls this for each queued task; do not load/parse job history.
  const row = store.db.prepare("SELECT data FROM records WHERE kind='job' AND json_extract(data,'$.operation')='target.sync' AND json_extract(data,'$.status') IN ('queued','running') AND json_extract(data,'$.payload.into')=? ORDER BY rowid LIMIT 1").get(target);
  return row ? JSON.parse(row.data) : undefined;
}
// Health checks cannot discharge an unfinished branch-integration obligation.
// Scope holds to still-commissioned pairs; a successful sync/no-op clears its pair.
export function targetSyncHolds(store, target) {
  const pairs = store.meta('config', {}).repository?.syncTargets ?? [];
  return Object.values(store.meta('targetSyncHolds', {})).filter(hold => hold.into === target && pairs.some(pair => pair.from === hold.from && pair.into === hold.into));
}
export function recordTargetSyncHold(store, { from, into, ...details }) {
  store.setMeta('targetSyncHolds', { ...store.meta('targetSyncHolds', {}), [`${from}>${into}`]: { from, into, ...details } });
}
export function clearTargetSyncHold(store, from, into) {
  const holds = store.meta('targetSyncHolds', {}); delete holds[`${from}>${into}`]; store.setMeta('targetSyncHolds', holds);
}
// The last completed verification of a target (one that recorded check results), as kept on a
// later record that has none: a verification in progress, a merge's "verification required", an
// operator exception (dev.86, J2). The console shows it, marked as the previous run, so the
// per-check results stay visible for as long as a slow verification runs. Admission never reads it.
const PREVIOUS_RUN_FIELDS = ['status', 'head', 'target', 'checkedAt', 'tier', 'tiers', 'tierStatus', 'checks', 'attemptId', 'source', 'reason', 'timedOut', 'timeout', 'timeoutOnly', 'timeoutRetry', 'failureClass'];
const previousRun = health => Array.isArray(health?.checks) ? Object.fromEntries(PREVIOUS_RUN_FIELDS.filter(field => health[field] !== undefined).map(field => [field, health[field]])) : health?.previousRun;
export function setTargetHealth(store, target, health) {
  const key = target ?? defaultTarget(store.meta('config', {}));
  const previous = targetHealth(store, target), kept = health && typeof health === 'object' && !Array.isArray(health.checks) ? previousRun(previous) : undefined;
  if (kept) health = { ...health, previousRun: kept };
  // Scheduled-tier evidence outlives writes that did not run the scheduled tier (main-tiers.mjs).
  health = composeTargetHealth(previous, health, store.meta('config', {}));
  store.setMeta('targetHealthVersions', { ...store.meta('targetHealthVersions', {}), [key]: targetHealthVersion(store, key) + 1 });
  if (isDefault(store, target)) { store.setMeta('mainHealth', health); return; }
  store.setMeta('targetHealth', { ...store.meta('targetHealth', {}), [target]: { ...health, target } });
}
// repository.syncTargets: [{from, into}] — after a merge into `from`, merge it into `into`.
// from and into must each be one of this project's targets (repository.target or a workflow's
// target), so they follow the target branch rule (core/contracts.mjs assertTargetBranch).
export function validateSyncTargets(config, targets) {
  const rows = config.repository?.syncTargets;
  if (rows === undefined) return;
  assert(Array.isArray(rows) && rows.length <= 8, 'repository.syncTargets must be a list');
  for (const row of rows) assert(row && typeof row.from === 'string' && typeof row.into === 'string' && row.from !== row.into && Object.keys(row).every(k => ['from', 'into'].includes(k)) && targets.includes(row.from) && targets.includes(row.into), 'each repository.syncTargets entry is {from, into}, two different target branches of this project');
}
