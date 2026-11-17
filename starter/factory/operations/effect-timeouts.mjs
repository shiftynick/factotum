import { assert } from '../core/contracts.mjs';
import { FETCH_LOCK_RETRY_DELAYS_MS } from '../core/git-options.mjs';
import { checksForTier, verifyTier } from './main-tiers.mjs';
import { SETUP_TIMEOUT_MS } from '../adapters/workspace/index.mjs';
import { upkeepSettings } from '../core/upkeep-config.mjs';

// How long a built-in maintenance step may run (its effect timeout), taken from the bounds of the
// work the step does. When a step outlives its effect timeout the supervisor kills it and the
// attempt is uncertain (no result), which needs attempt.resolve and flow.abandon by hand. So a
// step's own bounds, such as each main check's timeoutMs, must fit inside it with room to spare.
//
// An explicit `timeouts[operation]` in the project configuration still sets the step's limit
// (for audit it bounds the model call; see below). Every limit stays within the workflow
// contract's one-hour cap on an effect (core/contracts.mjs validateWorkflow).
export const EFFECT_TIMEOUT_CAP_MS = 3_600_000;
export const MAINTENANCE_DEFAULT_TIMEOUT_MS = 600_000;
// Set-up and wrap-up around main checks: the heavy-work permit wait (at most 60 s), the target
// fetch (60 s), target reads, preparing and releasing the owned checkout, and the closing remote
// read (30 s). A slow repeated fetch or slow workspace set-up draws on the checks' time; the
// verifier then stops the check that no longer fits and names it (see mainVerifyCheckLimit).
export const MAIN_VERIFY_OVERHEAD_MS = 180_000;
// Kept back from the step's time once checks are done: the closing remote read, releasing the
// checkout and writing the result.
export const MAIN_VERIFY_RESERVE_MS = 45_000;
// A check is not started with less time than this left.
export const MAIN_CHECK_MIN_MS = 1_000;
// target.sync runs only bounded Git calls (each at most 60 s): the fetch, repeated on ref-lock
// contention, then at most eight more calls (two head reads, merge-base, worktree add, merge,
// a conflict listing or head read, the abort or push, worktree remove), plus a minute's slack.
const GIT_CALL_MS = 60_000;
export const TARGET_SYNC_TIMEOUT_MS = (FETCH_LOCK_RETRY_DELAYS_MS.length + 1) * GIT_CALL_MS + 8 * GIT_CALL_MS + GIT_CALL_MS;
// audit: `timeouts.audit` (default 10 minutes) bounds the model call; the step adds its target
// fetch and reads, the owned checkout, and the closing target read.
export const AUDIT_DEFAULT_PROVIDER_MS = 600_000, AUDIT_OVERHEAD_MS = 180_000, AUDIT_RESERVE_MS = 60_000;
// knowledge.upkeep: one fetch of the target when the merge commit is not held yet (repeated on
// ref-lock contention), bounded reads of Git objects, and, when the pre-filter finds something to
// assess, a throwaway checkout of the merge commit (added and removed) around one model call. The
// model call is bounded by upkeep.budget.timeoutMs and cut short to the step's time left less
// UPKEEP_RESERVE_MS, so the checkout is removed and the result written before the step ends.
export const UPKEEP_GIT_MS = (FETCH_LOCK_RETRY_DELAYS_MS.length + 1) * GIT_CALL_MS + 6 * GIT_CALL_MS, UPKEEP_RESERVE_MS = 90_000;
export const upkeepAssessmentTimeoutMs = config => Math.min(EFFECT_TIMEOUT_CAP_MS, UPKEEP_GIT_MS + upkeepSettings(config).budget.timeoutMs + UPKEEP_RESERVE_MS);
// How long the assessment's model call may run: the configured budget, or less when the step's
// time is nearly used up. Below a second there is no time to start one.
export function upkeepProviderTimeoutMs(config, deadlineAt, nowMs = Date.now()) {
  const budget = upkeepSettings(config).budget.timeoutMs;
  return Number.isFinite(deadlineAt) ? Math.min(budget, Math.floor(deadlineAt - UPKEEP_RESERVE_MS - nowMs)) : budget;
}
// retention.archive: its preservation discovery command's own timeoutMs, plus time for the archive.
const RETENTION_ARCHIVE_MARGIN_MS = 300_000;
// Built-in maintenance operations whose limit `timeouts` may set.
export const MAINTENANCE_TIMEOUT_OPERATIONS = Object.freeze(['main.verify', 'target.sync', 'maintenance.backup', 'audit', 'retrospective', 'machine.sample', 'retention.archive', 'source.sync', 'source.create', 'source.promote', 'knowledge.upkeep', 'learnings.check']);

const minutes = ms => `${Math.round(ms / 6000) / 10} min`;
// A main check runs once, and again for each registered flake retry while its registration is current.
export function mainCheckRounds(check, nowMs = Date.now()) {
  const flake = check.flakePolicy;
  return 1 + (check.retrySafe === true && flake && Number.isSafeInteger(flake.retries) && Date.parse(flake.expiresAt) > nowMs ? flake.retries : 0);
}
// Main checks run one after another, so a verification needs the sum of their limits.
export function mainChecksBudgetMs(config, tier = 'all', nowMs = Date.now()) {
  return checksForTier(config, tier).reduce((sum, check) => sum + check.timeoutMs * mainCheckRounds(check, nowMs), 0);
}
// The verifier prepares a fresh owned checkout, so every workspace.setup command runs first, each
// bounded by workspace.setupTimeoutMs (default SETUP_TIMEOUT_MS).
export function setupBudgetMs(config) {
  const setup = Array.isArray(config.workspace?.setup) ? config.workspace.setup.length : 0, each = config.workspace?.setupTimeoutMs;
  return setup * (Number.isSafeInteger(each) && each > 0 ? each : SETUP_TIMEOUT_MS);
}
export const derivedMainVerifyTimeoutMs = (config, tier = 'all', nowMs = Date.now()) => mainChecksBudgetMs(config, tier, nowMs) + setupBudgetMs(config) + MAIN_VERIFY_OVERHEAD_MS;
// Each setup command's limit inside a main.verify step: workspace.setupTimeoutMs, or less, so that
// setup ends (and fails, naming itself) before the step does and a check could still start.
export function mainVerifySetupTimeoutMs(config, deadlineAt, nowMs = Date.now()) {
  const configured = Number.isSafeInteger(config.workspace?.setupTimeoutMs) && config.workspace.setupTimeoutMs > 0 ? config.workspace.setupTimeoutMs : SETUP_TIMEOUT_MS;
  const count = Array.isArray(config.workspace?.setup) ? config.workspace.setup.length : 0;
  if (!Number.isFinite(deadlineAt) || !count) return configured;
  return Math.max(1000, Math.min(configured, Math.floor((deadlineAt - MAIN_VERIFY_RESERVE_MS - MAIN_CHECK_MIN_MS - nowMs) / count)));
}

// The effect timeout of a built-in maintenance step (scheduled tasks and installed integration
// workflows have their own; see workflows/maintenance.mjs and workflows/integrations.mjs).
export function maintenanceTimeoutMs(config, operation, payload = {}, { nowMs = Date.now() } = {}) {
  const explicit = config.timeouts?.[operation];
  if (operation === 'audit') return Math.min(EFFECT_TIMEOUT_CAP_MS, (explicit ?? AUDIT_DEFAULT_PROVIDER_MS) + AUDIT_OVERHEAD_MS);
  if (explicit !== undefined) return explicit;
  if (operation === 'main.verify') {
    // Malformed checks keep the default here; the verifier refuses them with its own message.
    const derived = derivedMainVerifyTimeoutMs(config, verifyTier(payload), nowMs);
    return Number.isSafeInteger(derived) && derived > 0 ? Math.min(EFFECT_TIMEOUT_CAP_MS, derived) : MAINTENANCE_DEFAULT_TIMEOUT_MS;
  }
  if (operation === 'target.sync') return TARGET_SYNC_TIMEOUT_MS;
  if (operation === 'knowledge.upkeep') return upkeepAssessmentTimeoutMs(config);
  if (operation === 'retention.archive') {
    const discovery = config.retention?.preservation?.timeoutMs;
    return Number.isSafeInteger(discovery) && discovery > 0 ? Math.min(EFFECT_TIMEOUT_CAP_MS, Math.max(MAINTENANCE_DEFAULT_TIMEOUT_MS, discovery + RETENTION_ARCHIVE_MARGIN_MS)) : MAINTENANCE_DEFAULT_TIMEOUT_MS;
  }
  return MAINTENANCE_DEFAULT_TIMEOUT_MS;
}

// How long the next main check may run: its own timeoutMs, or less when the step's time is
// nearly used up (`deadlineAt`, the step's effect deadline). `source` says which limit applies.
export function mainVerifyCheckLimit(check, deadlineAt, nowMs = Date.now()) {
  if (!Number.isFinite(deadlineAt)) return { limitMs: check.timeoutMs, source: 'check' };
  const left = Math.floor(deadlineAt - MAIN_VERIFY_RESERVE_MS - nowMs);
  return left >= check.timeoutMs ? { limitMs: check.timeoutMs, source: 'check' } : { limitMs: Math.max(0, left), source: 'verification' };
}
// The model call's limit inside an audit step: timeouts.audit, or less when the step's time is nearly used up.
export function auditProviderTimeoutMs(config, deadlineAt, nowMs = Date.now()) {
  const configured = config.timeouts?.audit ?? AUDIT_DEFAULT_PROVIDER_MS;
  return Number.isFinite(deadlineAt) ? Math.max(1000, Math.min(configured, Math.floor(deadlineAt - AUDIT_RESERVE_MS - nowMs))) : configured;
}

// Commissioning (validateConfig) refuses limits that cannot work: a `timeouts` entry for a
// maintenance step outside 1 ms to one hour, and main checks whose full verification cannot fit
// in one main.verify step.
export function validateMaintenanceTimeouts(config) {
  const timeouts = config.timeouts;
  assert(timeouts === undefined || timeouts && typeof timeouts === 'object' && !Array.isArray(timeouts), 'timeouts must map step operations to milliseconds');
  for (const operation of MAINTENANCE_TIMEOUT_OPERATIONS) {
    const value = timeouts?.[operation];
    assert(value === undefined || Number.isSafeInteger(value) && value > 0 && value <= EFFECT_TIMEOUT_CAP_MS, `timeouts["${operation}"] must be a whole number of milliseconds from 1 to ${EFFECT_TIMEOUT_CAP_MS} (one hour); got ${JSON.stringify(value)}`);
  }
  const checks = config.mainChecks;
  // Malformed checks are refused by doctor and the verifier with their own message.
  if (!Array.isArray(checks) || !checks.length || !checks.every(check => check && Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0)) return;
  // Only the checks are counted here. Setup commands are usually far quicker than their limit
  // (30 minutes each by default), so counting the limit would refuse most projects with setup;
  // the step's limit includes it (capped at one hour) and the verifier cuts setup to the time left.
  const needed = mainChecksBudgetMs(config, 'all') + MAIN_VERIFY_OVERHEAD_MS, retried = checks.some(check => mainCheckRounds(check) > 1);
  assert(needed <= EFFECT_TIMEOUT_CAP_MS, `mainChecks cannot fit in one main.verify step: a full verification runs every check (every tier) one after another in one step, and these may take ${minutes(needed - MAIN_VERIFY_OVERHEAD_MS)} (the sum of their timeoutMs${retried ? ', counting registered flake retries' : ''}), plus ${minutes(MAIN_VERIFY_OVERHEAD_MS)} for set-up, which is more than the one-hour limit on a step (${EFFECT_TIMEOUT_CAP_MS} ms). To fix it, lower the checks' timeoutMs so that they add up to at most ${minutes(EFFECT_TIMEOUT_CAP_MS - MAIN_VERIFY_OVERHEAD_MS)} (a timeoutMs is a ceiling, not the expected run time${retried ? '; or let a flake registration expire or lower its retries' : ''}), or move a slow suite out of mainChecks into a scheduled task (scheduledTasks: it runs in its own step of up to an hour and reports its result, but does not gate main health). Moving a check to the scheduled tier ("tier": "scheduled") or splitting it into several checks does not help: a full verification still runs them all in one step`);
}
