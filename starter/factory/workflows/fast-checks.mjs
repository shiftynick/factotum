import { assert, digest } from '../core/contracts.mjs';

// Fast checks: cheap project-owned rule checks that run on the exact built candidate before
// review. A product failure goes straight back to the builder with bounded diagnostics; it
// never costs a review and never mints gate evidence. The final gate still verifies the final
// integrated candidate.
//
// fastChecks: {checks: [{id, argv, timeoutMs, holdExitCodes?, rules?}], heavy?}
// - timeoutMs is at most FAST_CHECK_MAX_MS per check and FAST_CHECK_TOTAL_MS in total, so an
//   expensive command cannot be called "fast" to skip resource coordination; a project whose
//   fast checks need the shared heavy-work permit sets heavy: true.
// - rules: the review rules this check owns. Reviewers are told not to raise them, but only for
//   a candidate on which the current fast checks passed.
export const FAST_CHECK_MAX_MS = 300000, FAST_CHECK_TOTAL_MS = 600000;
export const FAST_HOLD_KINDS = Object.freeze(['check-prerequisite', 'resource-wait', 'infrastructure']);
const MAX_CHECKS = 8, MAX_RULES = 16, MAX_RULE_CHARS = 300;

export function validateFastChecks(fast) {
  if (fast === undefined) return;
  assert(fast && typeof fast === 'object' && !Array.isArray(fast) && Object.keys(fast).every(key => ['checks', 'heavy'].includes(key)), 'fastChecks supports checks and heavy');
  assert(fast.heavy === undefined || typeof fast.heavy === 'boolean', 'fastChecks.heavy must be boolean');
  assert(Array.isArray(fast.checks) && fast.checks.length > 0 && fast.checks.length <= MAX_CHECKS, `fastChecks.checks needs 1-${MAX_CHECKS} checks`);
  assert(new Set(fast.checks.map(check => check?.id)).size === fast.checks.length, 'fast check ids must be unique');
  for (const check of fast.checks) {
    assert(check && typeof check === 'object' && Object.keys(check).every(key => ['id', 'argv', 'timeoutMs', 'holdExitCodes', 'rules'].includes(key)), 'a fast check supports id, argv, timeoutMs, holdExitCodes and rules');
    assert(typeof check.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(check.id), 'fast check id must be a short name');
    assert(Array.isArray(check.argv) && check.argv.length && check.argv.every(x => typeof x === 'string' && x && !x.includes('\0')), `fast check ${check.id} argv must be a non-empty argv list`);
    assert(Number.isSafeInteger(check.timeoutMs) && check.timeoutMs > 0 && check.timeoutMs <= FAST_CHECK_MAX_MS, `fast check ${check.id} timeoutMs must be at most ${FAST_CHECK_MAX_MS / 60000} minutes`);
    assert(check.holdExitCodes === undefined || Array.isArray(check.holdExitCodes) && check.holdExitCodes.length > 0 && check.holdExitCodes.length <= 16 && check.holdExitCodes.every(code => Number.isSafeInteger(code) && code > 0 && code <= 255) && new Set(check.holdExitCodes).size === check.holdExitCodes.length, 'fast check holdExitCodes must be unique nonzero exit codes (1–255), at most 16');
    assert(check.rules === undefined || Array.isArray(check.rules) && check.rules.length <= MAX_RULES && check.rules.every(rule => typeof rule === 'string' && rule.trim() && rule.length <= MAX_RULE_CHARS && !/[\x00-\x1f]/.test(rule)), `fast check ${check.id} rules must be at most ${MAX_RULES} single-line descriptions of at most ${MAX_RULE_CHARS} characters`);
  }
  assert(fast.checks.reduce((sum, check) => sum + check.timeoutMs, 0) <= FAST_CHECK_TOTAL_MS, `fast checks may take at most ${FAST_CHECK_TOTAL_MS / 60000} minutes in total`);
}
// The effect bound for the whole step: every check's own bound plus start-up and permit wait.
export const fastCheckTimeoutMs = fast => fast.checks.reduce((sum, check) => sum + check.timeoutMs, 0) + 60000 + (fast.heavy ? 60000 : 0);
// The identity of the check definitions a result was produced under.
export const fastCheckDigest = config => config?.fastChecks ? digest(config.fastChecks) : null;
// A fast-check result describes the current candidate only when it ran on exactly this
// candidate, under the currently commissioned check definitions.
export function currentFastCheck(config, result, identity) {
  if (!result?.inputIdentity || !identity || !config?.fastChecks) return null;
  return digest(result.inputIdentity) === digest(identity) && result.checkDefinitionDigest === fastCheckDigest(config) ? result : null;
}
// Reviewer guidance: the rules owned by fast checks that passed on this exact candidate.
export function fastCheckReviewGuidance(config, result, identity) {
  const current = currentFastCheck(config, result, identity);
  if (current?.route !== 'pass') return '';
  const rules = config.fastChecks.checks.flatMap(check => (check.rules ?? []).map(rule => `- [${check.id}] ${rule}`));
  if (!rules.length) return '';
  return `\nThe project's fast checks passed on this exact candidate and own these rules:\n${rules.join('\n')}\nDo not raise a finding whose only basis is one of these rules. If you see a real defect, report the defect on its own merits.`;
}
// Builder correction: the bounded diagnostics of fast checks that failed on this exact candidate.
// Output from an earlier candidate or check definition is never presented as current.
export function fastCheckCorrection(config, result, identity) {
  const current = currentFastCheck(config, result, identity);
  if (current?.route !== 'fail') return '';
  return `\nFast checks failed on this exact candidate ${identity.head}, before any review. These project-owned checks enforce mechanical project rules; correct the candidate so they pass. Failed fast checks (including bounded failure excerpts): ${JSON.stringify(current.checks.filter(check => check.status !== 'passed'))}`;
}
