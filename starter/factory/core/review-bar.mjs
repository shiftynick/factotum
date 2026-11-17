// The review bar (docs/designs/review-must-fix.md 13): which test a review's findings are held to,
// and the review settings a flow pins when it starts.
//
// - `severity` (the default) is today's review: its schemas, prompts, routing and strict
//   requirement, byte for byte. A flow admitted before the setting existed has no pinned bar and is
//   a severity flow.
// - `shadow` asks the must-fix questions and records what the must-fix bar would have done
//   (workflows/must-fix.mjs). It changes no route.
// - `must-fix` is refused by configuration validation until the release that ships the ledger, the
//   strict changes, the decision guard and the console evidence together (design 15, slice 6).
//   Until then a flow pinned to it exists only in test fixtures, which exercise the enforcement
//   code as it is built (design 15): from slice 2, the fail-closed protocol checks of 5.4 and 6.4.
//
// None of these is a live setting: they change through config.update, which waits for running
// flows to drain (13.2), and each flow reads only the values it pinned (13.3).
import { assert } from './contracts.mjs';

export const REVIEW_BARS = Object.freeze(['severity', 'shadow']);
// The schema version a must-fix or shadow review uses (design 13.3). Version 1 (dev.98) was the
// finding fields of section 5.1; version 2 adds the purpose assessment of 5.2. The ledger comes with
// its own version.
export const MUST_FIX_SCHEMA_VERSION = 'must-fix-2';
export const REVIEW_SETTING_DEFAULTS = Object.freeze({ mustFixRounds: 3, inFixEvidenceFrom: 3, maxFollowupsPerFlow: 20, strictFollowups: false });
const REVIEW_KEYS = Object.freeze([...Object.keys(REVIEW_SETTING_DEFAULTS), 'environment']);
export const ENVIRONMENT_FACT_LIMIT = 40, ENVIRONMENT_FACT_LENGTH = 300;
const FACT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

// Checked for every configuration, rehearsal included, so must-fix is refused wherever it is written.
export function validateReviewPolicy(config) {
  const policy = config?.policy ?? {}, bar = policy.reviewBar ?? 'severity';
  assert(bar !== 'must-fix', 'policy.reviewBar must-fix is not available in this release: use severity (the default) or shadow');
  assert(REVIEW_BARS.includes(bar), 'policy.reviewBar must be severity or shadow');
  const review = policy.review;
  if (review !== undefined) {
    assert(review && typeof review === 'object' && !Array.isArray(review), 'policy.review must be an object');
    const unknown = Object.keys(review).filter(key => !REVIEW_KEYS.includes(key));
    assert(!unknown.length, `policy.review does not support ${unknown.join(', ')}; it takes ${REVIEW_KEYS.join(', ')}`);
    for (const [key, min, max] of [['mustFixRounds', 1, 11], ['inFixEvidenceFrom', 2, 12], ['maxFollowupsPerFlow', 1, 50]]) assert(review[key] === undefined || Number.isSafeInteger(review[key]) && review[key] >= min && review[key] <= max, `policy.review.${key} must be a whole number from ${min} to ${max}`);
    assert(review.strictFollowups === undefined || typeof review.strictFollowups === 'boolean', 'policy.review.strictFollowups must be boolean');
    validateEnvironmentFacts(review.environment);
  }
  // The cap must be reachable before the build budget runs out (design 9.5): the initial build is
  // build visit 1, so at most maxBuildRounds - 1 corrections fit. Checked when the cap is set, and
  // for a shadow project, which pins it; a severity project that leaves it unset never reads it.
  if (review?.mustFixRounds !== undefined || bar !== 'severity') {
    const rounds = review?.mustFixRounds ?? REVIEW_SETTING_DEFAULTS.mustFixRounds, build = policy.maxBuildRounds ?? 4, ordinary = policy.ordinaryReviewRounds ?? 4;
    assert(rounds <= build - 1, `policy.review.mustFixRounds (${rounds}) must be at most policy.maxBuildRounds - 1 (${build - 1}): the first build round is not a correction`);
    assert(rounds <= ordinary, `policy.review.mustFixRounds (${rounds}) must be at most policy.ordinaryReviewRounds (${ordinary})`);
  }
}
function validateEnvironmentFacts(facts) {
  if (facts === undefined) return;
  assert(Array.isArray(facts) && facts.length <= ENVIRONMENT_FACT_LIMIT, `policy.review.environment must be a list of at most ${ENVIRONMENT_FACT_LIMIT} facts`);
  const ids = new Set();
  for (const fact of facts) {
    assert(fact && typeof fact === 'object' && !Array.isArray(fact) && Object.keys(fact).every(key => ['id', 'fact'].includes(key)), 'each policy.review.environment entry is { id, fact }');
    assert(typeof fact.id === 'string' && FACT_ID.test(fact.id), 'a policy.review.environment id is 1 to 64 letters, digits, dots, hyphens or underscores, starting with a letter or digit');
    assert(!ids.has(fact.id), `policy.review.environment id ${fact.id} is declared twice`); ids.add(fact.id);
    assert(typeof fact.fact === 'string' && fact.fact.trim() && fact.fact.length <= ENVIRONMENT_FACT_LENGTH, `policy.review.environment fact ${fact.id} must be 1 to ${ENVIRONMENT_FACT_LENGTH} characters`);
  }
}

// What a flow pins when it starts (design 13.3), beside reviewProtocol. Every flow pins its bar. A
// shadow flow also pins the must-fix settings, a copy of the environment facts and the schema
// versions it uses, so its records read correctly after the configuration has moved on. A severity
// flow reads none of them, so it pins none.
export function pinnedReviewSettings(config) {
  const policy = config?.policy ?? {}, reviewBar = policy.reviewBar ?? 'severity';
  if (reviewBar === 'severity') return { reviewBar };
  const review = policy.review ?? {};
  return { reviewBar, reviewPolicy: {
    mustFixRounds: review.mustFixRounds ?? REVIEW_SETTING_DEFAULTS.mustFixRounds,
    inFixEvidenceFrom: review.inFixEvidenceFrom ?? REVIEW_SETTING_DEFAULTS.inFixEvidenceFrom,
    maxFollowupsPerFlow: review.maxFollowupsPerFlow ?? REVIEW_SETTING_DEFAULTS.maxFollowupsPerFlow,
    strictFollowups: review.strictFollowups === true,
    environment: (review.environment ?? []).map(({ id, fact }) => ({ id, fact })),
    schemas: { planReview: MUST_FIX_SCHEMA_VERSION, review: MUST_FIX_SCHEMA_VERSION, build: 'delivery-build' },
  } };
}
// A flow without a pinned bar started before the bar existed: it is a severity flow.
export const flowReviewBar = flow => flow?.reviewBar ?? 'severity';
// The authority-bearing review settings (design 13.1): operator-only on a migrated project.
export function reviewAuthority(config) {
  const policy = config?.policy ?? {};
  return { 'policy.reviewBar': policy.reviewBar ?? 'severity', 'policy.review.strictFollowups': policy.review?.strictFollowups === true, 'policy.review.environment': policy.review?.environment ?? [] };
}
