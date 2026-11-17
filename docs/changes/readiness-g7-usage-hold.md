# Readiness G7: provider usage-limit hold

Implementation on branch `t3/provider-usage-limit-hold`; not a release and not a live qualification. Operator decision: read subscription usage and limits where the provider reports them, notify the operator near a threshold, and hold admission of new work for that provider until the limit resets. Background: an adopter's builds were held for days after a subscription limit ran out mid-step and left attempts `uncertain`.

## What the CLIs expose

Checked on 2026-11-14 against the installed Claude Code 2.1.325 and Codex CLI 0.169.0, by reading retained factory traces (read-only; event types and key names only, no content copied) and strings in the installed binaries. No CLI was run with a prompt.

**Verified**

- Claude `stream-json` emits `rate_limit_event` messages during ordinary model steps (seen in 477 retained traces). `rate_limit_info` carries `status` (`allowed`, `allowed_warning`, and `rejected` per the CLI's own schema), `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_overage_included`, `overage`), `resetsAt` (epoch seconds), `utilization` (0 to 1, present on warnings), `surpassedThreshold`, overage fields and `unifiedWindows` (per-window `status`, `utilization`, `resetsAt`).
- The Claude binary defines `api_error: "usage_limit_reached"` with `api_error_params.rate_limit_info` ("the request was refused by the account's own usage limit, a plan limit (session, weekly or per-model) or a spend cap … says which and when it resets"), attached to messages with `error: "rate_limit"`.
- Claude `auth status --json` reports `subscriptionType` (already read by preflight).
- Codex `exec --json` emits only `thread.started`, `turn.started`, `item.*`, `turn.completed` (with `usage` only), `turn.failed` and `error` in 492 retained traces: no usage percentages or reset times.
- Codex's session rollout files (`$CODEX_HOME/sessions/…/rollout-…-<thread_id>.jsonl`, written for factory exec runs too) contain `token_count` events with `rate_limits` (`primary`/`secondary` with `used_percent`, `window_minutes`, `resets_at`; `plan_type`; `rate_limit_reached_type`). The factory does not read these files (see design questions).
- The Codex binary contains the usage-limit texts "You've hit your usage limit…" and "Usage limit reached. You've reached your usage limit…", and a reset phrased as "…or try again at <localized time>".

**Assumed (not observed in a real limit event)**

- That a Claude refusal on the limit reaches `stream-json` stdout as a message with `api_error: "usage_limit_reached"` (top level or under `message`) or a `rate_limit_event` with `status: "rejected"`, and that `resetsAt` is epoch seconds as in ordinary events. As a fallback, an error `result` whose text matches a limit phrase counts too, without a reset time.
- That Codex reports the limit as an `error` or `turn.failed` event with the texts above. Its localized reset time is not parsed; the default hold applies.
- That one CLI login per provider serves the host, so per-provider state is per-account. The Codex plan is recorded only if a `rate_limits` object ever appears in the stream.

## Contract

- **Capture.** The provider adapter parses limit signals from each invocation's stdout (also from partial stdout of a timeout or transport failure) and attaches them to the invocation record as `limits: [{window, utilization, resetsAt, status, source, plan?}]`. Usage accounting is unchanged and ignores the field.
- **Classification.** A started failure whose output reports the limit reached raises `ProviderError` code `USAGE_LIMIT` (`started: true`, `safeToRetry: false`); dispatch writes `limitExhausted: true` in the action result. The engine keeps the attempt `uncertain` (the existing reconciliation contract: `attempt.resolve`, `task.restart`, upgrade and retention checks all key on it) and adds `classification: "limit-exhausted"` and `limit: {provider, model, window, resetsAt, source, errorCode}`. The flow stops with a reason naming the classification and the hold. It is never retried automatically; started failures never fall back (unchanged rule).
- **State.** `meta('providerLimits')[provider]`: latest report per window, notice keys, current `hold`, short history. Project metadata, so it survives restarts. No schema migration.
- **Notice.** At or above the notice percentage (or on exhaustion), one operator notice per window, identified by the window's reset time: `provider-limit:<provider>:<window>:<resetsAt>`.
- **Hold.** On exhaustion, or at the hold percentage, the provider is held until the reported reset (the latest one if several), or for the default hold when none was reported. A hold notice `provider-hold:<provider>` is opened and resolved when the hold ends.
  - Admission (`admissionReasons`, so queue diagnostics, automatic queueing and `flow.start`): a task whose selected routes (saved defaults and task model choice) have a model step that could only start held providers gets the reason `<provider> usage limit hold until <time>: <reason>; model steps such as <step> would start it`. `admitFlow` also checks the pinned routes, so run overrides are covered.
  - Running flows: before preparing a model step, the step waits (`flow.state: waiting`, `flow.providerHold`) when every provider it could start is held. A resumed builder counts only its session provider.
  - Dispatch fence: a step prepared before a hold arrived is recorded `not-dispatched` at zero cost.
  - Fallback: a step with a configured fallback on a provider that is not held is not held. The prepared intent lists the held providers; the adapter refuses the held primary before anything starts (`USAGE_LIMIT_HOLD`, positively unstarted), so the existing fallback rule applies.
  - Running work is never interrupted.
- **Clearing.** Each engine tick releases expired holds (event `provider.limit-released`, notice resolved). `provider.hold {provider, action: clear | extend, until?, note}` (operator only, not delegable) ends a hold early, or extends one (or starts one) to a later time; events `provider.limit-cleared` / `provider.limit-held` record the actor and note.
- **Shown in.** Stats → Provider limits (windows, used %, status, reset, hold); the console overview's attention list (held providers, limit-exhausted attempts); `snapshot.providerLimits`, `settings.holds.providerHolds`; Settings → Provider usage limits.

## Settings and defaults (live settings)

| Setting | Default | Meaning |
| --- | --- | --- |
| `policy.providerLimitNoticePercent` | 90 | Notice once per window from this percentage used |
| `policy.providerLimitHoldPercent` | 100 | Hold from this percentage used (exhaustion always holds) |
| `policy.providerLimitDefaultHoldMs` | 18000000 (5 hours) | Hold when exhaustion is reported without a reset time |

Validated: percentages 1–100 with notice ≤ hold; default hold one minute to 30 days. Projects that configure nothing get these defaults.

## Limitations

- Codex threshold notices do not fire in practice: its exec stream reports no percentages (exhaustion is still detected and held).
- Reports arrive only with model steps; usage by other clients of the same login is unseen until the next step reports it.
- A provider may refuse work before any threshold; that attempt is then classified as above.
- Admission checks the routes of the task's selected workflow; a catalog selection error is reported by its own reason and skips this check.
- Notices for a window are not resolved automatically when the window resets; hold notices are.

## Verification

Run on 2026-11-14 in this worktree:

- Focused: `node --test tests/provider-limits.test.mjs`: 10 tests, 10 passed. Related files (`providers`, `task-models`, `model-settings`, `live-settings`, `command-help`, `delegation`, `operation-contracts`, `console-views`, `console-wiring`, `usage-accounting`, `dashboard-snapshot`): 98 tests, 98 passed.
- Full suite, `npm test`: 776 tests, 776 passed, 0 failed, 0 cancelled, 0 skipped. No reruns were needed.
- `npm run eval`: exit 0, `"passed": true`.
- `git diff --check`: clean.

New tests (`tests/provider-limits.test.mjs`), all with fictional events: signal parsing for both CLIs; the adapter classifies a started limit failure as `USAGE_LIMIT` with evidence and does not fall back; a held provider is refused before start and a configured fallback runs; threshold notice once per window and again for the next; exhaustion holds admission with a queue reason, `flow.start` is refused, a task routed to Codex is not held, and the hold clears at its reset; default hold without reset time and a hold threshold below 100%; step hold only when every possible provider is held, resumed builder keeps its provider; operator extend and clear with attribution, orchestrator refused, persistence across a store reopen and release by the next tick; Stats, snapshot and console attention. End to end through the engine, supervisor, dispatcher and real adapter with a fictional `claude` executable on `PATH`: a limit-exhausted attempt is classified, holds new work, is not retried, and after reconciliation the next flow's model step waits until the reported reset, then runs (one 93% notice for its window); a hold during a running step does not interrupt it; a hold after preparation fences the dispatch at zero cost.

Not verified: a real limit event from either CLI (no subscription was exhausted); the console rendering in a real browser.

## Independent review fixes

The independent review rejected the first implementation (8b9a180) on three blocking findings and one test finding. Fixed on this branch:

- **Known resets became five-hour holds (P1).** A reset that has already passed is now distinct from a missing one: an elapsed reset creates no hold and no notice (a delayed settlement after the limit reset holds nothing). The default hold for a refusal without any reset time runs from when the limit was observed (the invocation's end), not from settlement. Signals of one report are coalesced: when any exhausted signal carries a reset time, exhausted signals without one (Claude's error-result text, Codex's error text, malformed resets) are the same refusal with less evidence and are dropped, so a typed refusal 10 minutes ahead plus matching text holds 10 minutes. Distinct exhausted windows (a five-hour and a weekly window) still hold until the latest reset, and a later report of the shorter window does not shorten a hold. The attempt's `limit` evidence prefers the typed signal with a reset.
- **Admission ignored run overrides (P2).** `admissionReasons` takes the run's `modelOverrides` and checks the routes the flow would pin (saved defaults, `task.models`, run overrides); `admitFlow` passes them, so `flow.start` and `task.restart` with overrides onto an unheld provider are admitted, and an override that leaves a step on the held provider is refused naming that step. Queue claims (manual dispatch, `autoQueue`, recurring occurrences) have no run overrides and use the task's model choice. Maintenance and audit jobs are not admitted through task admission: their flows pin routes with the job's `modelOverrides` and their model step waits on a hold of every provider it could start (unchanged).
- **Malformed reset dates discarded valid signals (P2).** Each date is validated on its own: a finite number outside the JavaScript date range, or unparseable text, reads as "no reset reported" for that signal only, and each output line is parsed independently, so nothing throws and valid signals are kept. Sanity bound: an automatic hold lasts at most 8 days (`MAX_AUTOMATIC_HOLD_MS`; the longest provider window is a week). A reported reset further away (for example the year 2200) holds to the bound; the hold records `capped: true` and `reportedReset`, and its reason and notice tell the operator, who can extend with `provider.hold` (up to 30 days, unchanged).
- **Load-sensitive reset test (P3).** The end-to-end test reports a reset one hour ahead and moves the clock past it by releasing holds at an injected time, so load cannot expire the hold before the assertions. Release by the engine tick with the real clock stays covered by the store-reopen test.

Unchanged, as the review found no problem there: running work is never interrupted, the retry and fallback rules are not bypassed, and Codex agent messages are not read as limit signals.

New regressions in `tests/provider-limits.test.mjs`: elapsed reset with matching text-only refusal (no hold, no notice) and the observed-time default hold; typed plus text refusal (held to the typed reset, one notice, typed evidence on the attempt) and two exhausted windows keeping the latest reset; malformed and far-future dates (valid signals kept in the parser and the adapter's classification, year-2200 reset capped at 8 days with the operator told); admission with run overrides on `flow.start` and `task.restart`, a partial override refused, a task model choice on the queue check, and a task choice back onto the held provider.

Verification of the fixes, run on 2026-11-14 in this worktree:

- Fail before fix: with the source files of 8b9a180 restored and the new tests kept, `tests/provider-limits.test.mjs` ran 14 tests, 10 passed and 4 failed (exactly the four new tests). The P3 change is test-only and passes either way.
- Focused and related: `provider-limits`, `providers`, `provider-routes`, `queue-status`, `runtime`, `reconcile`, `stats-view`, `model-settings`, `delegation`, `task-models`: 102 tests, 102 passed.
- Full suite, `npm test`: 780 tests, 780 passed, 0 failed, 0 cancelled, 0 skipped. No reruns were needed.
- `npm run eval`: exit 0, `"passed": true`.
- `git diff --check`: clean.

Still not verified: a real limit event from either CLI.
