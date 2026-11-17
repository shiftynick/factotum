# Plan 16a/b: usage attribution and Stats accounting v1

Implementation against dev.78; not a release or a live qualification. No billing route, paid adapter, credit hold, project policy or host supervision is enabled by this change.

## Evidence and limits

Read-only inspection on 2026-11-13 established the following; no model invocation was launched for qualification and no transcript content, project identifiers or actual usage amounts are included here.

- Installed `codex --version`: `codex-cli 0.169.0`. Binary SHA-256: `b452ca20f838a8855a88a41050ee4a694033fff4ea3ecdad5633e6e0e8d13f2b`.
- Existing Codex CLI `turn.completed.usage` observations were compared, by session identity, with the numeric `token_count.info.total_token_usage` and `last_token_usage` fields in local rollout metadata. All 178 observations across 71 resumed sessions matched cumulative totals; only one also matched the last-response counter. Version coverage: 0.163.0 (2 observations), 0.164.0 (21), 0.166.0 (150), 0.167.2 (3), 0.169.0 (2). This qualifies those exact versions empirically, not every Codex release. The audit's cumulative-session finding is confirmed. A sampled rollout's `total_tokens = input_tokens + output_tokens`; reasoning was within output. The exec usage schema provides input inclusive of cached input and output; it has no separate cache-write counter in the qualified observations. Unknown nonzero cache-write extensions are refused rather than guessed.
- Installed `claude --version`: `2.1.323 (Claude Code)`. Binary SHA-256: `604d29a6869409106b6a1110bdadcc8b72e8654a5a865d23258f938a696e348e`. Read-only inspection of its embedded JavaScript/schema descriptions identified `total_cost_usd` as a cumulative estimate, with transcript-restored totals on resume, possible reset on clear, and possible zeroed error results. Its `model_usage_since_last_result` contract describes disjoint per-process result deltas, including query-pipeline calls across models. The implementation prefers that field for tokens and cost; it does not subtract it. `inputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `outputTokens` and `costUSD` are read from each model row. Thinking/reasoning is not added to output a second time.
- Claude's embedded raw `usage` description and implementation are not a sufficiently consistent accounting source: the description calls it main-loop/per-turn while the inspected implementation aggregates model usage. Therefore raw `usage` alone is retained but token attribution is unknown. With no delta field, a successful qualified result's cumulative cost can still be differenced against a linked predecessor. Error results remain unknown, even if they report zero. Other Claude versions remain unknown pending qualification. This is local implementation evidence, not an end-to-end live provider test.

Future CLI versions require explicit evidence and fixtures before the qualified version set changes. Version strings are compatibility evidence, not cryptographic authentication of a binary. The hashes above identify inspected installations; runtime does not pin their hashes.

## Normalized contract

`operations/usage-accounting.mjs` exports `ACCOUNTING_VERSION = 1`, `usageObservation`, `projectUsage`, `inputTokens`, `totalTokens`, and `usageEstimate`. It is the shared contract for Stats and external audit consumers. Tests use invented usage in `tests/fixtures/usage/qualified.json`.

Every measured segment has four disjoint counters:

| Field | Meaning |
| --- | --- |
| `input` | Uncached input, excluding cache reads and cache writes |
| `cachedInput` | Cache-read input |
| `cacheWrite` | Cache-creation input, when independently reported; zero for the qualified Codex exec schema |
| `output` | Output including provider-accounted reasoning/thinking; never add an overlapping reasoning field |

`inputTokens = input + cachedInput + cacheWrite`; `totalTokens = inputTokens + output`. These are model token counters, not context-window sizes or money. Unknown normalization is `null`, not four zeroes. Explicit equal cumulative counters can establish a measured zero delta. Negative, fractional, missing required, inconsistent or overflowing counters do not become measured zero through coercion/clamping.

Codex differences the raw inclusive input, cached input and output counters first, then subtracts cache reads from that segment's input. This matters because differencing a normalized uncached cumulative counter can give misleading reset detection. A cache delta greater than the inclusive input delta is inconsistent and remains unknown.

Claude per-result model deltas sum disjoint input/cache/output counters. Reported delta cost includes the models in that invocation. Stats groups these under the requested provider/model, so its Models table is an invocation-route grouping, not a claim that auxiliary calls all used the requested model. A missing multi-model cost is not priced using the main model's configured rate.

## Observations, resume and replay

The adapter retains the original `usage` and `reportedCostUsd` compatibility fields, plus additive `usageObservation` metadata: schema version, random observation ID, CLI version, session ID, explicit resume origin, predecessor observation ID, invocation timestamps, independent token/cost semantics, format, and raw usage/cost/model fields. Private stdout/stderr remain artifacts; partial transport output is retained when available. Structured task validity and accounting validity are separate: a unique completed turn with malformed task output can still supply usage. Ambiguous/partial output is unknown.

Dispatch records a small `providerInvocations` array, including protocol-correction calls and calls followed by task validation failures. Maintenance audit results preserve the same accounting subset; previously they dropped it. A thrown provider failure without usable observation records a missing invocation. Existing supervisor settlement already binds results to immutable receipts and settles an attempt once; it is unchanged. The projection is pure and repeatable and needs no mutable session ledger or receipt rewrite.

`projectUsage(allAttempts)` orders observations by invocation start, then stable attempt/index identity. It must see predecessor attempts outside the reporting window. Session groups are provider-qualified. A fresh session can attribute its first cumulative total. A resume needs the immediately preceding session observation, an explicit predecessor-ID link, compatible CLI version, and nonoverlapping timestamps. Missing links, legacy predecessors, intervening missing attempts, changed versions, uncertain ordering or malformed counters produce explicit unknown coverage. A reset/decreasing counter makes that segment unknown; its valid new raw snapshot may become the next linked segment's baseline. No pre-reset work is reconstructed.

Repeated observation IDs count once. Conflicting observations sharing an ID invalidate that observation and dependent cumulative attribution. Replaying settlement or reading Stats again produces no extra usage. Late arrival is projected in invocation order rather than settlement order; newly available evidence can change a projection without changing receipts. Overlapping observations are conservatively excluded.

Sessions are factory-owned under the existing launch contract. These CLI counters cannot prove that an unrelated actor did not use the same session between factory turns, or detect a counter reset that catches up beyond the previous total. Such external use must be reconciled separately; do not interpret this implementation as independent proof of exclusive session access. Tokens lost with missing/error observations are not reconstructed or assigned to the next successful attempt.

## Money and window populations

- `estimateUsd` is a provider list-price estimate when attributable, or a configured price applied to attributable single-model counters. It is not known spend. The raw `reportedCostUsd` compatibility field is no longer automatically a per-attempt estimate.
- New subscription receipts carry `billing.actualMicros: null` and `accountCreditCost: 'unavailable'`. No account credit price, subscription allocation or zero incremental bill is inferred from authentication. Actual USD micros require explicit `actualCostEvidence`; the current subscription adapter does not provide it. Historical `billing.actualMicros: 0` without that evidence and supervisor `costMicros: 0` do not establish known account spending. Existing paid-integration ledgers and budget controls are separate and unchanged.
- Stats keeps existing metric IDs/endpoints and adds `accounting.version`, coverage summaries and `estimate.inputTokens`. The existing `estimate.tokens` is explicitly total tokens. Model rows add input-only totals and `usageUnknown`. The exported compatibility helpers `tokens`/`stepEstimate` return unknown for unqualified raw records; new consumers should use the whole-attempt projection.
- Existing charts use **completed-flow cohorts**: all provider invocations of non-planning flows that completed/failed in the window, including invocations started earlier. Maintenance audits are included. Prepared, failed, aborted or uncertain provider attempts lacking observations contribute unknown coverage; the population is not successful attempts only. Some missing placeholders may not actually have launched, so the coverage denominator is not a billable-call count.
- `accounting.attemptWindow` separately reports invocation-start population, including active and planning flows. Missing observations use receipt/attempt start. This is neither an admission cohort nor a completion cohort. There is no category/goal report here.
- Boundaries are UTC, half-open `[from,to)`, using the same existing calendar-day/Monday-week windows returned by Stats. The last bucket is the current calendar period, not an exact rolling duration ending at observation time. `observedAt` records when the data was read. Compare audits using identical returned boundaries, provider populations and coverage, not a dashboard total against a differently scoped session total.
- Summaries expose attempts, invocations, duplicates excluded, measured/missing counts, reasons, input-only/total tokens, estimate coverage and actual-spend coverage. Amounts with some known observations are partial sums; all-unknown totals are null. Token/price fields must be read with coverage, not presented as complete bills.

## Compatibility and performance

There is no data migration and no rewrite of historical receipts. Unversioned records remain `legacy-attribution-unknown`; their raw numbers are preserved. They are not silently grandfathered into corrected totals, even if their session IDs look plausible. This deliberately reduces apparent historical coverage. Upgrading mid-session leaves the first new resumed segment unknown until a trustworthy new baseline exists. Any future historical repair should be an additive, separately evidenced projection.

Stats performs one projection over the attempt records it already reads, with an in-memory sort and session/observation maps. It does not scan private stdout, rollout transcripts, historical artifact bodies or external account state during console polling. Work remains on-demand through the existing Stats service; no snapshot polling scan was added. This preserves existing retention/read boundaries, though the existing attempt-history scan itself is not constant-time.

Only accounting-related audit result capture was added to `workflows/maintenance.mjs`; notification policy and flow-notice code are untouched. Root-owned strategy/progress/release/version/qualification files are unchanged.

## Verification

Final commands (2026-11-13):

- `node --test tests/usage-accounting.test.mjs tests/providers.test.mjs tests/stats-view.test.mjs tests/provider-routes.test.mjs tests/plan-review-protocol.test.mjs`: 47 tests passed. Covers first/resumed turns, version gating, reset, equal counters, inconsistent deltas, duplicate/conflicting IDs, ordering/overlap, missing/failed/uncertain and legacy observations, reasoning overlap, Claude deltas/cumulative cost/error zeroes, protocol-correction accounting, audit accounting, Stats cohort/window consistency effective failed fallback identity, and UI coverage formatting without browser tools.
- `node --test tests/plan-review-protocol.test.mjs tests/usage-accounting.test.mjs tests/stats-view.test.mjs tests/main-health-audit.test.mjs`: earlier focused integration run, 32 passed, including the unmodified health-audit test file.
- `npm test`: 591/591 passed in the latest completed run. An earlier 590-test run passed 589/590: the untouched `tests/timer-wait.test.mjs` 500 ms stop/resume fixture reached its deadline before the stop assertion under suite load; an isolated rerun passed 4/4. This timing sensitivity remains an unresolved root qualification issue. The previously known main-health-audit 150 ms partial-output test remains root-owned and unchanged; a passing run does not resolve its prior suite-load sensitivity.
- `git diff --check`: passed.

Independent review, full evaluation, release qualification and live adoption remain root-owned. No PR, push, release, live state mutation, browser action or live model qualification was performed.

## Independent review fixes

An independent review of `01e24e8` approved with three blocking findings, all fixed with regression tests that fail on the reviewed commit:

- **Claude cumulative baseline.** Session-cumulative cost is now differenced only against another qualified successful Claude result's session total. A per-result delta is never used as a baseline, and an error result (whose total may be zeroed) never establishes one; the following result is unknown and the next qualified result re-establishes the baseline.
- **Partial-trace capture.** Writing partial stdout/stderr after a transport failure is best effort. A write failure no longer replaces a started `TIMEOUT` or `UNCERTAIN` provider failure or its accounting metadata.
- **Unknown-only Stats periods.** Period buckets, role parts, role legend totals and per-model period parts are `null` when no step in them is priced, and buckets carry their unknown step count. The chart labels such periods as unknown rather than `$0.00`.

Verification after the fixes: focused provider, Stats, accounting, plan-review-protocol and provider-route tests 49/49; `npm test` 593/593; `git diff --check` clean. Browser rendering was not exercised.
