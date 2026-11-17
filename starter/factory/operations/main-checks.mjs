import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { assert, digest, fileDigest } from '../core/contracts.mjs';
export function validateMainCheckPolicy(check) {
  assert(check.reuseMaxAgeMs === undefined || Number.isSafeInteger(check.reuseMaxAgeMs) && check.reuseMaxAgeMs > 0 && check.reuseMaxAgeMs <= 7 * 86400000, 'main check reuse lifetime must be positive and at most seven days');
  if (check.flakePolicy !== undefined) {
    const policy = check.flakePolicy;
    assert(check.retrySafe === true && policy && Number.isSafeInteger(policy.retries) && policy.retries >= 1 && policy.retries <= 2, 'known flaky checks require repeatability and one or two retries');
    assert(typeof policy.trackingRef === 'string' && policy.trackingRef.trim() && Number.isFinite(Date.parse(policy.expiresAt)), 'flake policy needs a tracking reference and expiry');
    assert(Array.isArray(policy.exitCodes) && policy.exitCodes.length && policy.exitCodes.every(code => Number.isSafeInteger(code) && code > 0 && code <= 255), 'flake policy needs explicit product exit codes');
  }
}
export function reusableMainCheck({ action, check, head, input, executor, nowMs = Date.now() }) {
  if (!check.reuseMaxAgeMs || action.mainHealth?.status !== 'green' || action.mainHealth?.unchanged !== true || action.mainHealth.head !== head) return null;
  const cacheKey = digest({ check, config: action.config, head, input, executor });
  // Scheduled-tier rows survive merge-tier verifications in mainHealth.scheduled; reuse them
  // only from green scheduled evidence on this same head.
  const scheduled = action.mainHealth.scheduled?.status === 'green' && action.mainHealth.scheduled.head === head ? action.mainHealth.scheduled.checks ?? [] : [];
  const previous = [...(action.mainHealth.checks ?? []), ...scheduled].find(row => row.id === check.id && row.cacheKey === cacheKey && row.status === 'passed' && !row.flaked);
  const age = nowMs - Date.parse(previous?.verifiedAt);
  if (!previous || !Number.isFinite(age) || age < 0 || age > check.reuseMaxAgeMs || !previous.evidencePath || !previous.evidenceDigest) return null;
  try {
    const state = realpathSync(action.stateDir), path = resolve(state, previous.evidencePath), rel = relative(state, path);
    assert(rel && !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'), 'cache artifact outside state');
    assert(existsSync(path) && realpathSync(path) === path && fileDigest(path) === previous.evidenceDigest, 'cache evidence unavailable');
    const evidence = JSON.parse(readFileSync(path, 'utf8'));
    assert(evidence.id === check.id && evidence.status === 'passed' && evidence.attempts?.length > 0 && evidence.attempts.every(attempt => attempt.status === 'passed'), 'cache evidence not a clean pass');
    return { previous, evidence };
  } catch { return null; } // Missing, changed or unsafe cache evidence requires a fresh run.
}
