# Readiness G3: orchestrator handoff prompt

Implementation on branch `t3/orchestrator-handoff-count`; not a release and not a live qualification. It carries out the operator-accepted decision that the runner counts the deliveries made to the current orchestrator session, reports the count in each delivery, and raises a handoff question at a limit.

## Why

A project's orchestrator is a long-lived host session that receives Factotum's notification deliveries. Each wake adds to its context, and a written rule to hand off to a fresh session was not followed without a human prompt. Factotum now does the counting and asks.

## Contract

**Session identity.** Nothing existing fit: operator presence is operator-only and time-bound, and the T3 "successor rebinding" is host-side guidance with no Factotum record. A new command, `orchestrator.session {sessionId, expectedVersion?}`, records the session that now receives deliveries, in project metadata (`meta('orchestratorSession')`, no schema change). The orchestrator or the operator may issue it. The identifier is the host's own (for T3, the orchestrator thread's ID), validated like other IDs. The same identifier again is a no-op. A different one increments `version`, resets the count and supersedes the previous session's open handoff question. Before any declaration, deliveries count toward an undeclared session (version 0).

**Counting.** `deliverDue` counts a delivery in the transaction that records the endpoint's 2xx acceptance. That includes reminders, resolution and state wakes, and the handoff question's own wake, and it still counts when a `delivery.ack` races the request. Suppressed deliveries (notification level) are never sent and are not counted. Refused or failed sends are not counted.

**Payload.** Every delivery carries `sessionDeliveries` (this delivery's number in the current session; a retry of a refused send carries the same number) and `sessionDeliveryLimit` (`null` when the question is off). The session identifier is not sent.

**Handoff question.** When the count reaches the limit, Factotum records one standalone inbox question `orchestrator-handoff:<sessionVersion>:<n>`, `role: "orchestrator"`, `createdBy: "factory"`, `remind: "never"`, a one-day expiry, and choices `handing-off` / `later`. Its context gives the count and the steps: start a fresh session, give it the handoff summary, bind it with `orchestrator.session`, move the notification binding, let the old session stop. Standalone questions with `role: "orchestrator"` are now answerable by the orchestrator, and the operator can still answer them. Other standalone questions are unchanged.

**Re-raise rule.** At most one handoff question is open at a time. While it is open and unanswered, every further `handoffRepeatDeliveries` deliveries give it a new version with the current count, so it is delivered once more. After an answer, expiry or withdrawal, a new question is raised once the count passes the later of the last raise and the answer by the same interval. No hard ceiling: the count-based re-raise already brings the question back at a bounded rate, and a second rule would only add noise.

**Clearing.** Binding a new session supersedes the open question (no wake at `essential`/`actionable`, since superseded resolutions are filtered) and starts a new count. Answering closes it. The orchestrator's own answer does not wake it at the default level.

**No holds.** The question gates nothing. Admission reasons, `flow.start`, other deliveries and answers are unaffected (tested).

**Visibility.** `snapshot.orchestratorSession` and `stats.orchestratorSession` give `{version, sessionId, declared, boundAt, boundBy, deliveries, lastDeliveryAt, limit, repeatDeliveries, nextHandoffAt, handoff}`. The console's Stats tab has an "Orchestrator session" section, and Settings → Notifications lists both settings.

## Settings and defaults

| Setting | Default | Bounds | Live |
| --- | --- | --- | --- |
| `notifications.handoffAfterDeliveries` | 100 | 0 (count, never ask) or 10–100000 | yes |
| `notifications.handoffRepeatDeliveries` | 25 | 5–100000 | yes |

## Compatibility

The feature is on by default with a limit of 100, because the operator asked for it and the field failure was exactly that nobody turned it on. A project that does nothing gets its count started from the first accepted delivery after upgrade. Its first question arrives after 100 deliveries even if its orchestrator never declares a session, and the question's text tells it how to declare one. Projects that want the old behaviour set `handoffAfterDeliveries: 0`. Projects without `notifications.configPath` send nothing, so nothing is counted or raised. No schema migration. Payload consumers gain two fields; existing fields are unchanged. On a project later migrated to the authority ledger, an open handoff question is inventoried like any other schema-1 standalone question (informational, held for review).

## Changed files

- Runtime: `starter/factory/operations/orchestrator-session.mjs` (new), `operations/notifications.mjs` (count on acceptance, payload fields), `core/project.mjs` (command, snapshot, answer hook), `core/communication.mjs` (role-matched standalone answers), `core/configuration.mjs` (validation), `operations/live-settings.mjs`, `operations/views.mjs`, `core/command-help.mjs`.
- Console: `console/ui/stats.mjs` (Orchestrator session section), `console/ui/settings.mjs` (two settings).
- Docs and starter: `docs/communication.md` (contract and host-neutral handoff guidance), `docs/operations.md`, `docs/commands.md`, `docs/integrations/t3.md` (T3 steps, webhook prompt fields), `starter/project/integrations/t3-notifications.example.md`, `starter/project/SETUP_CHECKLIST.md`.
- Tests: `tests/orchestrator-handoff.test.mjs` (9 tests through `inbox.publish` → `operationalTick` → `deliverDue` with an injected transport).

## Verification

Run on 2026-11-14 (local time; UTC was already 2026-11-15).

- `node --test tests/orchestrator-handoff.test.mjs`: 9 pass, 0 fail. Covers per-session counting and payload fields, refused sends, reset on rebinding, same-session and stale-version binding, the raise at the limit, no repeat inside the interval, the re-raise as a new version, answering (orchestrator and operator) with a quiet resolution, a deferral returning after the interval from the answer, rebinding superseding the question, no admission hold (delivery and rehearsal), quiet-level suppression not counted, restart persistence, and the settings' bounds and off value.
- Focused existing suites (notification, state, actionable, live settings, command help, communication, console, operation contracts): 73 pass, 0 fail.
- `npm test`: 754 tests, 753 pass, 1 fail: `tests/stats-view.test.mjs` "stats count merged work per period…" (`today`). It fails alone too (6 pass, 1 fail), and it fails identically on an untouched checkout of the base commit `e8a7c72`. This is a day-boundary dependency (UTC had passed midnight), not this change.
- `npm run eval`: passed (`"passed": true`).
- `git diff --check`: clean.

Not verified: the console section was not looked at in a browser. Nothing was exercised against a live T3 webhook or a real orchestrator thread handoff.

**Root decision (before review).** `notifications.handoffAfterDeliveries` and `notifications.handoffRepeatDeliveries` are operator-only live settings: the orchestrator cannot switch off or postpone its own handoff prompt, even through delegated `settings.update`. Regression: a delegated change is refused, and an operator change succeeds.

## Independent review fixes

The independent review rejected the change with three blocking findings; all are fixed, with the two non-blocking items.

1. **Operator-only settings could be changed through `config.update` (P1).** `operatorOnly` was enforced only in `settings.update`. Now `operatorOnlyChanges(before, after)` (`operations/live-settings.mjs`) compares the effective value (defaults applied; `policy.delegatedOperations` compared as a set) of every operator-only live setting, and both writers that a non-operator can reach refuse a change: `config.update` with and without `replaceLive`, a file that drops the key, and a mode change (which does not keep live values), plus `settings.update` as a second check. The project initializer is the only other writer and is operator-only. `policy.delegatedOperations` had the same hole: on a project without the authority ledger a delegated `config.update` with `replaceLive` could widen it (the ledger check covered only migrated projects). It is fixed by the same rule.
2. **In-flight acceptance counted for the successor (P2).** The claiming transaction records the session (version) and send number on the delivery (`sessionSend`), and the acceptance is attributed to that captured session. An acceptance for an earlier session never touches the current count; it is added to that session's reset record (`lateAcceptances`). Each send number counts at most once per delivery.
3. **Concurrent payloads shared a number (P2).** Send numbers are allocated in the transaction that claims the delivery (`dispatched` in the session record), so concurrent sends get distinct numbers in dispatch order. `sessionDeliveries` is defined as the send number, not the accepted count, which stays separate (`deliveries`) and alone drives the handoff question. A retry of a send that was not accepted keeps its number (same delivery); a reminder re-send of an accepted delivery, or a retry after rebinding, gets a new number. Unaccepted numbers are not reused, so the latest number can exceed the accepted count. Documented in `docs/communication.md`.

Non-blocking:

- **Resets are visible.** Each rebinding is recorded (`meta('orchestratorSessionResets')`, last 20) with the ended session's id, accepted count, send numbers, actor and time. `snapshot`/`stats.orchestratorSession.resets` give the 5 most recent, the count in the last 24 hours and the last notice; the console's Stats → Orchestrator session lists them. One operator notice (`orchestrator-session-resets:<n>`, `createdBy: "factory"`, so it is delivered) is raised at most once a day when the last 4 resets ended sessions that together received fewer deliveries than one handoff limit (the default limit when the question is off), or when there were more than 10 resets in 24 hours. Rebinding still needs no operator authorization.
- **Durability limit documented.** An acceptance followed by a crash before the recording transaction is not counted; the delivery is retried and counts then.

Tests (each fails on `71be00f` with the source reverted and passes with the fix): `tests/live-settings.test.mjs` "a delegated config.update cannot change operator-only live settings by any route; the operator can" (replaceLive set and drop, mode change, `policy.delegatedOperations`, kept values, same-set reorder allowed, operator allowed); `tests/orchestrator-handoff.test.mjs` "an acceptance that arrives after a new session was bound…", "concurrent sends carry distinct ordered numbers; a retry keeps its number…" (two concurrent runners, a refused send retried after a later send, a retry after rebinding) and "session resets are recorded with the count they ended…" (history, notice once, snapshot, stats, console section rendered with a minimal DOM).

Verification on 2026-11-14: `node --test tests/orchestrator-handoff.test.mjs tests/live-settings.test.mjs`: 19 pass (4 new fail before the fix); focused suites with notification, communication, delegation, config, operator grants, command help and operation contracts: 97 pass, 0 fail; `npm test`: 759 pass, 0 fail; `npm run eval`: passed; `git diff --check`: clean. Not verified: the console section in a real browser, and a live webhook.

Re-check of `0cde08c`: all three findings confirmed resolved, including the `policy.delegatedOperations` hole. Two further items, fixed by root:

- **Blocking: the orchestrator could silence the reset notice.** It could acknowledge the operator notice before maintenance queued it, so no webhook was ever sent. The notice is now marked `operatorAckOnly`, and `inbox.ack` refuses anyone but the operator for such items. The notice stays open until the operator acknowledges it, and is delivered like other notices (once by default). The regression fails on `0cde08c`.
- **Non-blocking: bounded deduplication.** A delivery kept only 8 counted send keys, so an original request held past its retry and nine later reminders could be counted twice. That needs a transport that ignores abort, which the built-in fetch honours. The history is now 256 keys.

Second re-check of `d691703`: the direct `inbox.ack` bypass is closed. A remaining path is now fixed by root: an orchestrator `delivery.ack` could postpone the unsent notice by four hours, repeatedly, or mark an in-flight send delivered so that a later failure was never retried. `delivery.ack` now refuses non-operators for deliveries of `operatorAckOnly` items. The regression queues the notice and checks that the orchestrator's delivery acknowledgement is refused; it fails on `d691703`. Inbox read, withdrawal, answering and session rebinding were confirmed not to suppress the notice. The documented limit remains: per-delivery deduplication keeps 256 keys, so an attempt held past 256 later acceptances on the same delivery could count twice. That needs a transport that ignores abort.
