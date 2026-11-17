# dev.82: operations faults, configuration updates and CLI fixes from the dev.81 readiness trial

Implementation on branch `t3/fix-adopter-trial-findings`; not a release. Findings are numbered as in the dev.81 readiness trial report. Tests: `tests/ops-config-findings.test.mjs` (15 tests) and one changed test in `tests/project-service.test.mjs`.

## F30: a notification file problem put the project into a recovery hold (release gate)

**Cause.** `deliverDue` read the notification configuration file with `readDeliveryConfig`, which threw on a wrong mode, a missing file, bad JSON or a bad URL. The exception escaped `operationalTick`, and the project service's operations timer turned every operations-loop exception into `recoveryHold: true` plus an `operations.fault` event, once a second. The hold stayed after the file was fixed. A flow whose attempt then settled was stopped by `authorized()` with the fixed text "restored state requires reconciliation", whatever had placed the hold.

**Fix.**

- Notification delivery is isolated (`operations/notifications.mjs`). A file problem makes `deliverDue` send nothing and return. It records `meta('notificationHealth') = {status: "paused", problem, since, changedAt}`, with the event `notification.paused` written only when the problem changes. Deliveries stay queued. The first tick that reads a valid file clears it (event `notification.resumed`) and sends them. The problem text names neither the path nor the contents; a JSON parse error, which would quote the signing key, is reported as "not valid JSON". It is shown in `status` (`health.notifications`), in the console Overview ("Notification delivery paused") and as a `doctor` warning (not a reason).
- Operations-loop exceptions are classified (`operations/recovery-hold.mjs`, used by `service/project-service.mjs`). Only a database fault that leaves the state in doubt places a recovery hold: SQLite primary codes READONLY, IOERR, CORRUPT, FULL, CANTOPEN and NOTADB, or an error marked `integrity: true`. Any other exception is recorded once as `meta('operationsFault')` with `operations.fault {recoveryHold: false}`, shown in `status` (`health.operationsFault`) and the console, and cleared by the next tick that completes (event `operations.recovered`). Its transaction was rolled back, so it leaves no partial state.
- Every recovery hold now records its cause in `meta('recoveryHoldReason') = {cause: restore | runner-fault | operations-fault, error?, at}`. Restore, runner faults and integrity faults set it, and `restore.release` clears it and records the cause in `restore.reconciled`. The stop and refusal reason names it, for example "recovery hold: the operations loop hit a state-integrity fault (disk I/O error); reconcile unsettled attempts, stop active flows and release it with restore.release". `status` and the dashboard snapshot carry `recoveryHoldReason`, and the console shows the cause.
- `operationalTick(store, {transport})` accepts the transport (default `fetch`), so the service path can be tested without a network.
- Recovery from a real hold is documented in [operations](../operations.md#recovery-hold-and-operations-faults).

**Compatibility.** No schema or configuration change. A project held by this defect stays held after the upgrade; it has no recorded cause, and its message says so. Release it with `restore.release` as before. Code that relied on any operations-loop error placing a hold now gets a visible, self-clearing health problem instead. The runner (engine) tick fault still holds.

**Verification.** Tests cover: a 0644 file through the real project service and `operationalTick` (one event over many ticks, no hold, no `operations.fault`, nothing sent, then automatic resumption and delivery after `chmod 600`); each failure mode (mode, missing file or typo in the path, unparsable JSON, bad URL, HTTP URL), with no path or secret in the problem text and a doctor warning for each; an ordinary operations fault (one event, no hold, cleared); an integrity fault (hold with cause, stop reason, release clears the cause); and a restore recording its cause. The old service test that expected any fault to hold now uses an integrity fault.

## F19: config update discarded file changes to live-setting keys (release gate)

**Cause.** `keepLiveValues` kept the stored value of every live key that differed from the file, whether or not anyone had changed it live. Nothing recorded who had changed it live. The CLI then reported the keys as "changed from the console".

**Fix.** `settings.update` records provenance in `meta('liveSettingChanges')`: `{path: {by, onBehalfOf?, at, commandId, base}}`, where `base` is the value the last committed configuration gave the key. A change back to `base` removes the entry. `config.update` keeps a stored value only for keys with an entry; every other key takes the file's value. Each kept key is reported in `keptLiveDetails` as `{setting, liveValue, fileValue, changedBy, onBehalfOf?, changedAt, fileChanged}`. Kept keys keep their provenance, rebased on the new file, so a later update with the same stale file still keeps them. `--replace-live` takes the file's values and clears the provenance, and a mode change also clears it. The `operatorOnlyChanges` check still runs on the resulting configuration. A delegated update whose file changes an operator-only key nobody changed live is now refused rather than silently ignored. `settings.updated` events carry `onBehalfOf`.

**Compatibility.** Projects from earlier releases have no provenance record. It is rebuilt once from the event log: `settings.updated` changes survive a `config.updated` only if the `config.kept-live-settings` event recorded with it lists them. A key that an earlier release kept without any live change (the defect) is therefore applied from the file on the next update. For rebuilt entries, `fileChanged` is `null` because the earlier file is unknown. The result keeps `keptLiveSettings` (paths) and adds `keptLiveDetails`.

**Verification.** Tests cover: a file change to an untouched live key is applied (`policy.queueOnApproval`, as in the trial); live and file changes to the same key, with the actor, instruction, time and `fileChanged`; a live-only change; provenance surviving a commit; `--replace-live`; a live change reverted; the event-log rebuild, including a key kept only by the old defect; and operator-only enforcement in both directions.

## F23: import-task ignored --actor

**Cause.** The CLI called `importGitHubTask(state, issue)`, which always sent `task.put` as `actor: "operator"`. `task.approved` events also carried no actor or instruction.

**Fix.** `importGitHubTask` takes `{actor, onBehalfOf, authority}` (default operator, which source synchronization still uses). The CLI requires `--actor` and passes `--instruction`, `--reference` and `--authority`, like every other command-executing call, and the usual authority rules apply. `task.approved` events now carry `by` and `onBehalfOf`.

**Compatibility.** `import-task` without `--actor` is now refused with the same message as other commands. Add `--actor operator` (or `--actor orchestrator --instruction …`) to scripts. `docs/running.md` is updated.

**Verification.** At the function level, an orchestrator import without an instruction is refused, and with one it is recorded with `onBehalfOf`; the `task.approved` event carries both. At the CLI, `import-task` without `--actor` is refused before any network call.

## F17: config update printed text after its JSON

**Cause.** The JSON receipt went to stdout and the guidance went to stderr, so a caller that merges the streams, as agent tools usually do, could not parse the output.

**Fix.** `config update` prints one JSON document: the receipt with a `messages` list (kept live settings with who and when, the notification backlog summary, and the commissioning-cleared reminder with the doctor command). It writes nothing to stderr.

**Compatibility.** Scripts reading the stderr text should read `messages`. Stdout gains the `messages` field.

**Verification.** CLI test: stderr is empty, stdout parses, and the messages include the doctor reminder.

## F1: only `command` had `--help`

**Fix.** `core/command-help.mjs` adds `CLI_HELP` and `cliHelp`. `<subcommand> [action] --help` prints the usage, a summary and every option, then exits before anything runs. A subcommand given without its action lists its actions. The top-level banner points to it, and `command --help` now starts with its own options.

**Verification.** A test runs `--help` for all 38 entries with options that would otherwise create state (`init --state …`, `backup --out …`) and checks the usage line, the options and that nothing was created.

## F22: enabling notifications delivered the whole backlog

**Cause.** `operationalTick` queues a delivery for every inbox change even while no consumer is configured, and `deliverDue` sends everything pending once `configPath` is set.

**Choice.** Deliver only what still needs someone; summarize the rest. Starting "from now" would drop open questions that a newly wired orchestrator needs.

**Fix.** When `config.update` starts delivery (sets `notifications.configPath` on a delivery project, switches to delivery mode with one, or changes it to another file), active deliveries are trimmed. Attention deliveries for items still open at the queued version, and wakes owed to a presenter, are kept. Resolutions, attention for items no longer open, and state events are marked `superseded` with `supersededReason: "backlog before notification delivery started"`. The event `notification.backlog-trimmed {kept, superseded, supersededByKind}`, the result field `notificationBacklog` and a CLI message summarize it. Updates that do not start delivery leave deliveries alone, and delivery resuming after a file problem is not trimmed.

**Compatibility.** Only affects the update that wires a consumer. Superseded rows stay in state.

**Verification.** Test with an open question, an acknowledged notice and an answered question queued before wiring: one delivery (the open question) stays active, the rest are superseded, one summary event is recorded, and a later unrelated update trims nothing.

## F35: provider.hold refusal contradicted "not delegable"

**Cause.** `operatorAuthority` told the orchestrator that the operator "can list it in policy.delegatedOperations" for every refused operation. `validateDelegatedOperations` rejects `provider.hold`, the only operator operation outside `DELEGABLE`.

**Fix.** For operations outside `DELEGABLE`, the refusal reads "operator authority required: provider.hold is operator only and cannot be delegated (policy.delegatedOperations cannot list it); the operator must run it directly". `command --operation <op> --help` says the same for such operations, and `docs/commands.md` matches. Also from F35: `schedule.remove` and `schedule.pause` without `scheduleId` now say "needs scheduleId" instead of "unknown schedule: undefined".

**Verification.** Test of the refusal, the help text and the `schedule.remove {id}` message.

## Test results

- `npm test`: 840 tests, 840 pass (base `f2cb6d2`: 825/825). One full run had a single failure in `tests/main-check-tiers.test.mjs` ("every health writer preserves scheduled-tier red evidence…", `attempt.resolve` or `flow.abandon` rejected after a supervised crash). That file passed 3 of 3 runs alone and the next full run passed, so it looks load-sensitive and unrelated to this change.
- `npm run eval`: passes. `git diff --check`: clean.
- Fail before fix: on `f2cb6d2`, all 15 new tests and the changed service test fail (16 of 16).
- Changed existing tests: `tests/project-service.test.mjs` (an ordinary fault no longer holds, so the test uses an integrity fault) and `tests/adopter-usability.test.mjs` (`adopt --help` now prints adopt's usage instead of the generic banner).

## Not verified

- No end-to-end trial against a real webhook or GitHub; the transport and forge are faked in tests.
- The console rendering of the new health items was checked for syntax only; there is no browser test.
- `doctor`'s new warning is tested through `notificationConfigWarnings`; a full `doctor` run needs providers and GitHub.

## Independent review fixes (root)

Review of `165752e` (GPT-6.1 Sol): approve with fixes. No attribution or operator-only bypass was found. Two findings, both fixed by root with regressions that fail on `165752e`:

- **Blocking: a real database fault could bypass the recovery hold.** On `SQLITE_FULL`, SQLite rolls the transaction back itself. `Store.tx()`'s explicit `ROLLBACK` then threw "cannot rollback - no transaction is active", and that error replaced the original, so the fault was classified as ordinary. `Store.tx()` now rolls back only while a transaction is open and never lets a rollback failure replace the original error; the rollback error is kept on `error.rollbackError`. Regression: a real full-database write through `Store.tx()` is classified as an integrity fault and places the hold.
- **A malformed signing key escaped notification health.** `readDeliveryConfig` now requires `signingKey`, when present, to be a non-empty string. Its error never echoes the value. Such a file is therefore a configuration problem that pauses delivery, rather than a later exception after a delivery was claimed.

Noted, unchanged: rebuilding live-setting provenance for older projects is conservative. Without a known base it cannot tell a reverted or no-op live write from a real override, so it keeps such values and reports them.
