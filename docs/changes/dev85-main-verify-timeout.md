# dev.85: main verification timeouts

Implemented against main at `db1279f` (0.2.0-dev.20261022.84 plus its qualification record). This is a local implementation record, not a release, activation or live qualification claim.

## Problem

An adopter reported a post-merge `main.verify` killed after 10 minutes although its `mainChecks` entry set `"timeoutMs": 1800000`. The receipt showed `signal: SIGKILL, reason: timeout` with empty stdout and stderr; the check had been waiting on the project's own machine-wide `flock`. The flow then stopped as `uncertain attempt: action result missing or altered` and needed `attempt.resolve` and `flow.abandon` by hand. Target refreshes (admission-triggered `main.verify` jobs) did the same.

## Cause

`workflows/maintenance.mjs` built every maintenance flow's single effect node with `timeoutMs: config.timeouts?.[job.operation] ?? 600000`. The supervisor (`core/supervisor.mjs`) ends an effect at that limit (SIGTERM to its process group, SIGKILL a second later). The `main.verify` worker had not written `action-result.json`, so `core/effects.mjs inspect` reported the attempt uncertain. Each check's own `timeoutMs` was enforced on the check (`runProcess`), but a check allowed 30 minutes never reached it inside a 10-minute step.

The same pattern existed elsewhere:

- `target.sync` makes up to about 14 minutes of bounded Git calls (each at most 60 s, the fetch repeated on ref-lock contention) under the same 10-minute default.
- `audit` passed `timeouts.audit` both to the model call and to the step, so the step always ended first.
- An integration step's adapter ran with `intent.timeoutMs - 1000`, measured from before its heavy-work permit wait (up to 60 s), so the supervisor could end the step before the adapter's own limit. `releaseWorkflow()` gave every step a fixed `600000`.
- A main check that did reach its own `timeoutMs` was recorded as `blocked` (infrastructure), which made target health `unknown`, not red.

## Fix

1. **The step limit comes from the work.** New `operations/effect-timeouts.mjs`, used by the maintenance flow builder:
   - `main.verify`: main checks run one after another (`for (const check of selected)` in `maintenanceAction`), so the step allows the sum of `timeoutMs` of the checks in the tier being run (`checksForTier`; merge tier for post-merge and refresh jobs, every check for a full run), each counted `1 + flakePolicy.retries` times while a flake registration is current, plus `MAIN_VERIFY_OVERHEAD_MS` (3 minutes: permit wait, fetch, target reads, checkout preparation and release, closing remote read), capped at the one-hour effect limit. An explicit `timeouts["main.verify"]` still wins.
   - `target.sync`: 15 minutes, from its own Git call bounds.
   - `audit`: `timeouts.audit` (default 10 minutes) bounds the model call; the step adds 3 minutes, capped at one hour, and the model call is cut to the time left in the step.
   - `retention.archive`: its preservation discovery `timeoutMs` plus 5 minutes, at least 10 minutes.
   - Scheduled tasks keep `timeoutMs + 2 min`. Other operations keep 10 minutes: `maintenance.backup`, `retrospective` and `machine.sample` are local, and source adapters are bounded at 5 minutes by `source-config.mjs`.
   - Integrations: an adapter may declare `timeoutMs` (1,000 ms to 58.5 minutes). `releaseWorkflow({..., adapters})` and `evaluationWorkflow({..., adapters})` size each step at the adapter's `timeoutMs` plus 90 s; without it a step keeps 10 minutes. The adapter runs under its own `timeoutMs`, cut to the step's time left measured from the step's start (`deadlineAt`), so a permit wait no longer eats the margin. `validateIntegrationConfig` refuses a step whose `timeoutMs` is below its adapter's plus 90 s.
2. **Refused at commissioning.** `validateConfig` (`config update`, live setting changes, `doctor`) calls `validateMaintenanceTimeouts`: it refuses main checks whose full verification cannot fit in one step (sum plus 3 minutes over one hour), naming the sum and the 57-minute ceiling, and `timeouts` entries for maintenance operations outside 1 ms to one hour.
3. **A timed-out main check fails the verification.** In `maintenanceAction`, a check that `runProcess` stops with `TIMEOUT` after starting is recorded `status: "failed"`, `failureClass: "timeout"`, `timedOut: true`, `timeoutMs`, `limitSource` (`check` or `verification`), in its row, its `check-N.json` artifact and its `mainCheckObservation`. The remaining checks still run. With no blocked check, the route is `fail`, so health is red through the existing fail route (`resultEdges.fail → failed`) and the job fails; the flow is not stopped and nothing needs `attempt.resolve`. The result adds `timedOut: true`, `timeout: {checkId, timeoutMs, limit, stepTimeoutMs, notRun?}`, `reason` and `notice` (the sentence plus the last lines of the check's stderr and stdout through the G19 excerpt path: `outputExcerpt`/`excerptBlock` in `core/command-failure.mjs`, which share the bounds, control-sequence stripping and redaction of `commandFailure`, with `knownSecrets(config)`). `mainHealth` gains `timedOut: true` and the same `reason`. Timeouts are still never retried.
4. **Every check's own limit is enforced, and the step cannot overtake it.** `runProcess` already enforced `timeoutMs` on each check (`maintenanceAction` passes it). The verifier now also knows the step's deadline (`runMaintenanceAction` computes it from `intent.timeoutMs`; `dispatch.mjs` passes the deadline it already had). Before each check, `mainVerifyCheckLimit` gives the check its own `timeoutMs`, or the time left less a 45-second reserve for the closing read, checkout release and result. A check cut short this way fails with `limit: "verification"` and a notice saying the step's time was nearly used up and how to override it; checks with no time left are listed in `notRun` and the verification fails. Only a hang outside any check can still let the supervisor end the step (uncertain, as before).
5. **The failed-flow notice finds it.** `failedFlowNotice` (R5's `attemptNotice` path for non-change flows) now also considers an attempt that settled cleanly with `outcome: "failed"`, which is how a routed red `main.verify` settles. `attemptOutcome` reads a main verification's check rows from `mainHealth.checks`, so the attempt's `failedChecks` names the timed-out check.

## Whether a timed-out main check is safe to call a failure

Confirmed from the code, with one limit:

- The factory's own work in `main.verify` writes nothing outside the project repository and factory state: a `git fetch` into remote-tracking refs, `rev-parse`, `workspace.prepare`/`release` of an owned worktree under the state directory, `ls-remote`, and private artifacts. There is no push, forge API call or status publication. The input tree is checked unchanged afterwards (`unchanged`).
- Each check runs with `cwd` in that owned checkout and an explicit environment (`PATH`, `HOME`, `LANG`, `PYTHONDONTWRITEBYTECODE`, `FACTOTUM_TARGET`, `FACTOTUM_CHECK_KIND`): no Git credentials or forge token. `runProcess` kills its process group on timeout; descendants that escaped it are caught by the supervisor's cgroup check, which makes the attempt fail (`descendant-survival`, health unknown), not pass.
- The limit: a check is a trusted project command and is not sandboxed. It inherits `HOME` and can write anywhere the account can. The factory cannot prove it writes nothing outside the checkout; it relies on the existing trusted-command contract for main checks. That contract already applied before this change: a timed-out check already settled as a known (blocked) result, never as an uncertain attempt. This change only moves it from unknown to red health, and still never retries it.

Decisions for the other check-running and read-only effects:

| Effect | A check or command that times out | Decision |
| --- | --- | --- |
| `main.verify` (and doctor's run of it) | was `blocked`, health unknown | Now a failure, health red (above). |
| The `main.verify` step itself ended by the supervisor | uncertain | Unchanged: no result exists. Made unlikely by the derived limit and the in-step deadline. |
| Fast checks (`fastCheck`) | held at the step (`fastCheckHold: infrastructure`), a known outcome | Unchanged. Its step limit is already derived (`fastCheckTimeoutMs`), and its fail route sends the candidate back to the builder, which would spend a build round on an environmental wait. |
| Gate (`gate`) | `blocked`, gate question, a known outcome | Unchanged: the gate publishes a commit status to the forge, an external write. See open questions for its step limit. |
| Scheduled tasks | uncertain (`runProcess` rejects after start) | Unchanged: a task may declare `network: true`; `effect` is a declaration, not proof. |
| Integration adapters with `effect: "read"` | uncertain | Unchanged: the classification is the project's declaration. Only their limits changed. |
| `preview` | already `fail` (`preview command timed out`), routed to the merge question | Unchanged. |
| Source adapters, retention discovery | an error | Unchanged. |

## Compatibility

- Maintenance flows are built per job, so the new limits apply to jobs admitted after the upgrade; flows already running keep their recorded limits. No stored record is migrated.
- A project whose `mainChecks` add up to more than 57 minutes (counting current flake retries) is refused by `config update`, live setting changes and `doctor` until the checks' `timeoutMs` are lowered. Running jobs are not refused; their step is capped at one hour and the verifier stops the last check that does not fit, naming it.
- A main check timeout now turns the target red instead of unknown. Red holds admission as unknown did. A verification that failed only on timeouts is verified once more automatically after the 15-minute back-off (review round, below); after that, fix the cause (for example the lock the check waited on) and run `main.verify`.
- `timeouts.audit` keeps its meaning for the model call; the audit step is now 3 minutes longer.
- Check rows, artifacts, observations and results of checks that did not time out are unchanged (no new keys), so untiered health shapes stay as before.
- Integration adapters without `timeoutMs` and graphs built without `adapters` are unchanged.
- A settled red `main.verify` attempt (any cause, not only a timeout) now records `failedChecks` beside `outcome: "failed"`, as fast checks and gate checks already did. A red verification without a timeout has no `notice`, so its failed-flow notice falls back to the earlier text as before.

## Tests

New `tests/main-verify-timeout.test.mjs` (6 tests). Main checks are real Node subprocesses run by the real verifier against a real local bare remote; jobs are admitted by `operationalTick`, prepared by the engine and settled canonically, as in `main-check-tiers.test.mjs`. Slow checks sleep; no provider or forge is called.

1. A `main.verify` step allows the sum of its checks' `timeoutMs` plus set-up for its tier (the reported 30-minute check), counts flake retries, and an explicit `timeouts["main.verify"]` wins.
2. Commissioning refuses checks that cannot fit and maintenance `timeouts` outside one hour; a configuration exactly at the ceiling is accepted.
3. `target.sync` and `audit` steps admitted through the operations loop take their own bounds; retention and the other operations.
4. A check that sleeps past its 1.5-second `timeoutMs` between two passing checks: route `fail`, check row failed/timeout/timedOut, the others still run, notice names the check and limit with redacted stdout and stderr excerpts (a `ghp_…` value printed by the check is `[redacted]`), attempt `passed` with `outcome: failed` and `failedChecks`, flow failed with no stop reason, no uncertain attempt, target red, job failed with the reason, and the flow's inbox notice reads `Failed at run (attempt …): Main check machine-lock timed out after 1.5 s …`.
5. A check whose own `timeoutMs` (8 s) is longer than the step's time left (2.5 s after the reserve) is stopped at the step's limit, named with `limit: "verification"`, and the check after it is listed as not run.
6. An integration adapter's `timeoutMs` sizes its release step, commissioning refuses a step too short for it, and the adapter runs under its own limit or the step's time left after a wait.

`tests/main-health-audit.test.mjs` "timed out main verifier …" asserted the old contract (unknown health, `blocked`, `infrastructure`). It now asserts the new one (red, `failed`, `timeout`, one attempt despite `retrySafe` and infrastructure retries, notice with the partial output).

Fail-before evidence: the base tree (`git archive db1279f`) in a scratch directory, with the new test files and only the new, unwired `operations/effect-timeouts.mjs` added so that the test file loads:

- `main-verify-timeout.test.mjs`: 0 pass, 6 fail. 1: step `timeoutMs` `600000` instead of `3480000`. 2: `Missing expected exception`. 3: `target.sync` step `600000`. 4: route `'blocked' !== 'fail'`. 5: route `'blocked' !== 'fail'` after 8.2 s (the check ran to its own limit). 6: release step `600000` instead of `1890000`.
- `main-health-audit.test.mjs`: the updated timeout test fails (the base records `blocked`/unknown); the other 12 pass.

Results on this worktree are in the commit report.

## Review round: decisions and changes

Operator decisions on the first version's open questions, implemented after merging `main` (the dev.85 upgrade doctor work, `8b7dd9b`) as `dedd674`.

### Merge with main

Two files conflicted:

- `starter/factory/core/command-failure.mjs`: both sides added an in-memory output excerpt. Main's `outputExcerpt(text, secrets, {cut})` has the same call shape as this branch's, so main's was kept and this branch's duplicate dropped; this branch's `excerptBlock` stays.
- `docs/running.md`: both sides extended the commissioning paragraph. Both sentences were kept.

Everything else merged cleanly, including `maintenance.mjs`, `configuration.mjs` and `dispatch.mjs`. Main's renamed calls and `workspace.setupTimeoutMs` plumbing needed no change here. The merge commit alone passed `npm test` (1257/1257).

### 1. Gate step limit: follow-up, not changed

The `gate` step of the reference change workflow still has `timeouts.gate ?? 120000` whatever its checks' `timeoutMs`, so a gate check allowed more than about two minutes can be ended with the step and leave an uncertain attempt. Recorded as a follow-up. The cost of changing it, checked:

- A node `timeoutMs` change does change the graph digest: `digest(changeWorkflow(config))` differs between `timeouts.gate` unset (gate node `timeoutMs` 120000) and `780000`. `digest` covers the whole graph object.
- With a workflow catalog (`workflows`), task approval binds the selected workflow's digest (`task.approvedWorkflow`, `core/catalog.mjs approvalBinding`), and admission refuses a task whose approval names another digest: `task approval does not cover the selected workflow <name>; review and approve it again`. So every approved, not yet admitted task would need approving again.
- Without a catalog, approvals bind no digest, but `store.meta('workflowDigest')` changes: a flow already running stops with `workflow changed; revalidation required` (`core/project.mjs authorized`), and grant entries that pin the old digest (`core/grants.mjs`) no longer match.
- A configuration change is already a drained `config update` plus `doctor`, so running flows are not the main cost; re-approval of queued catalog tasks and reissued grants are.

### 2. One automatic re-verification after a timeout

New `operations/timeout-retry.mjs`. The verifier records `timeoutOnly: true` on a red result whose only failures are timed-out or unstarted checks, and `timeoutRetry: true` when the run was the automatic retry (`payload.timeoutRetry`). `verificationRequest` (`operations/main-freshness.mjs`) then requests one `main.verify` of the same tier once the existing 15-minute back-off has passed, as job `main-timeout-retry:<failed checkedAt>` with `payload.timeoutRetry: true`, a grant note naming it, and event `main.verify-timeout-retry {jobId, check, failedAt}`. `ensureMainVerification` asks for it whether or not work is queued; other refreshes still wait for queued work. A retry that times out again, or any red result with another failure, is refused as before (`main is red (its last verification failed, and timed out again on its one automatic re-verification)`), so only the operator or a moved target starts another run. The queue status's `main` hold carries `timeoutRetry {status: pending|requested|used, after, due, auto, check, jobId}`; its text (`mainHealthReason`) and the console health card ("Automatic re-verification" row, and "timed out after …" on the check row) show it. The result's notice says which applies.

Limits: the retry state lives on the target's health record. A later health write (a merge, a probe, another verification) replaces it. On a tiered project, a merge-tier pass after a scheduled-tier timeout replaces the top-level record while the scheduled red latches, so that case falls back to the scheduled tier's existing rule: verified again once the target moves.

### 3. Setup in the bound, and a check's child holding its output

- `workspace.setupTimeoutMs` (from main) is now part of the `main.verify` step limit: the setup commands' count times their limit (default 30 minutes each), within the one-hour cap. Inside the step, `mainVerifySetupTimeoutMs` gives each setup command its configured limit, or its share of the time left (less the 45-second reserve and a second for a check). A hanging setup therefore ends (health unknown, `workspace setup timed out after …`) before the step is ended. The commissioning ceiling still counts checks only: counting the setup limit would refuse almost every project that has setup and more than 27 minutes of checks, while setup usually takes a fraction of its limit.
- New `operations/check-process.mjs` runs main checks (with the same contract as `runProcess`, which is unchanged). Once the check's own process has exited, it waits at most 2 seconds for the output pipes to close. It then sends SIGKILL to the processes still in the check's process group, each verified by PID and start time so a reused PID is never signalled. It stops reading and reports `DESCENDANTS_SURVIVE` with the exit code: health unknown, not a timeout. Before, a check that left a server holding stdout open was waited on until its `timeoutMs` and then reported as timed out. With the default `runProcess`, including doctor's run of the main checks, the verifier uses the new runner; a runner a caller injects (tests do) is used as given.
- **Known limit:** a process that left the check's process group (`setsid`, or a double fork into a new session) is not in the group, so it is not found and not stopped. The verifier stops waiting for it after the grace. Under systemd supervision, the step's cgroup check finds it and the attempt fails as a containment failure (`descendant-survival`). Without systemd it keeps running.

### 4. The refusal message, and adopter notes

The refusal now says how to fix it, but not with every remedy suggested. A full verification runs every check, of every tier, one after another in one step, so moving a check to the scheduled tier or splitting it into several checks leaves the full run's sum unchanged and would not make the configuration pass. The message says so and offers what does work: lower the `timeoutMs` values (a ceiling, not the expected run time; or let a flake registration expire), or move a slow suite into a scheduled task, which runs in its own step but does not gate main health.

**Adopter notes (for the release notes).** From dev.85 a `main.verify` step is allowed as long as its checks need: the sum of their `timeoutMs`, plus workspace setup, plus 3 minutes, at most one hour, instead of a fixed 10 minutes. A check that reaches its `timeoutMs` now fails the verification (main red) with a notice naming the check and its limit, and the verification is repeated once automatically after 15 minutes; it no longer leaves an uncertain attempt to resolve by hand. If your `mainChecks` `timeoutMs` add up to more than 57 minutes (counting registered flake retries), `config update`, live setting changes and `doctor` refuse the configuration after the upgrade. Lower the limits so that they add up to at most 57 minutes, or move a slow suite into `scheduledTasks`. The scheduled tier does not help: a full verification runs every tier in one step. Running jobs are not affected; their step is capped at one hour and the last check that does not fit is stopped and named. `timeouts["main.verify"]` still overrides the derived limit.

### Tests (review round)

`tests/main-verify-timeout.test.mjs` now has 12 tests; the refusal test's expected message changed, and six are new:

7. The step limit includes `workspace.setup` at `workspace.setupTimeoutMs`, and at the default 30 minutes per command.
8. A setup command that hangs (its own limit 8 s) is stopped at the step's time left (about 2 s): blocked, `workspace setup timed out after 2 s`, within 6 s.
9. A check that starts a helper in its process group holding stdout open, then exits 0: the verifier stops waiting within 6 s, records `DESCENDANTS_SURVIVE` naming the exit code, keeps the output, and the helper is stopped.
10. The same with a helper in its own session: the verifier still stops waiting within 6 s; the helper is out of reach (the known limit) and the test stops it by its recorded PID.
11. A timeout-only red: pending state (with `after`) in queue status, its text and `mainHealthReason`; no request before the back-off; exactly one `main-timeout-retry` job after it, without queued work, with its payload, note and event; state `requested`; the retry passes and the target is green.
12. The retry times out again: health `timeoutRetry`, state `used`, "timed out again" text, no further request, refusal text. A red with a real failure beside a timeout: no `timeoutOnly`, no retry state, no request.

Fail-before on the merge commit `dedd674` (`git archive`, new test file copied in, `--test-timeout=40000`): the six first-round tests that still apply pass except the refusal test (old message); 7 fails (`780000` instead of `1380000`); 8 (`took 8044 ms`); 9 (`took 8095 ms`: the old runner waited for the check's timeout); 10 (`test timed out after 40000ms`: the old runner never stops waiting); 11 (`timeoutOnly` undefined); 12 (`unknown job: null`: no retry is requested).

## Review fixes

An independent review of `df660fb` (GPT-6.1 Sol) rejected it on four blocking findings. It upheld the safety argument for timeout-as-failure (no push or forge call on the `main.verify` path), SIGTERM-resistant termination, output limits, environment handling, excerpt redaction, the doctor merge and `NO_PLANTED_COMMANDS`. Main was merged again first (`c3d7cdc`, no conflicts: only `docs/one-factory-progress.md` changed on main).

1. **Timeout cleanup could leave processes running (high).** On `close` after a timeout, the runner skipped descendant cleanup because a reason was already set, and settling cancelled the pending SIGKILL timer. A helper with ignored stdio that ignored SIGTERM outlived the result. Fix (`operations/check-process.mjs`): every ending goes through one `conclude`. It waits for any stop already under way, then empties the check's process group: SIGTERM, up to `KILL_GRACE_MS` for the members to exit, SIGKILL to what is still in the group, and up to `KILL_GRACE_MS` more. Only then is the result settled. Members still present after SIGKILL are reported (`DESCENDANTS_SURVIVE`).
2. **Signals could reach processes outside the check's group (high).** The delayed SIGKILL went to members captured earlier, checked only by start time. A helper that called `setsid()` on SIGTERM was still killed. Fix: each signal is sent only after re-reading `/proc/<pid>/stat` immediately before it and finding the same start time and the check's process group. The group is enumerated afresh for each signal. A member found earlier that is alive in another group is skipped and reported as `escaped` (`{pid, pgid}`) on the error and in the check's evidence. In a verification, a timeout that left an escaped process is treated as not contained: blocked, health unknown, not red. Only a contained timeout settles as a failure. A small race between the re-read and the signal remains; Node offers no pidfd signalling.
3. **The automatic retry could loop after health expired (medium).** Exhaustion was honoured only while the red health was younger than `policy.mainHealthMaxAgeMs`. After that, queued work asked for an ordinary refresh, and a further timeout earned another retry. Fix (`operations/timeout-retry.mjs usedTimeoutRetry`): each retry job records `timeoutRetryHead`. A head that has had its retry has no further automatic timeout retry, whatever the health age, until the head changes or the operator enqueues a `main.verify` for the target. Schedules and factory requests do not renew it.
   - **Decision:** an expired-health refresh does not run for such a head either. `verificationRequest` refuses it before the age check (`main is red (its last verification failed, and timed out again on its one automatic re-verification of <head>)`), because a refresh would be another automatic try at the same head and the same loop with a different job name. Ordinary reds (a real failure) keep the existing expired-health refresh.
4. **Valid sub-second checks never ran (medium).** `MAIN_CHECK_MIN_MS` was compared with the selected limit even when that was the check's own `timeoutMs`, so a check with `timeoutMs: 500` was listed as not run. Fix: the one-second launch threshold applies only when the step's time left is the limit (`limitSource === 'verification'`).

### Tests (review fixes)

`tests/main-verify-timeout.test.mjs` now has 16 tests. Four are new, and one assertion changed: the exhausted-retry refusal now names the head.

13. A timed-out check whose helper (ignored stdio) ignores SIGTERM: the runner returns `TIMEOUT` and the helper is already dead when it does.
14. A helper that calls `setsid()` on SIGTERM (a Python helper): the runner returns `TIMEOUT` with `escaped: [{pid}]` and does not signal it again; it is still alive (the test stops it by its recorded PID). In a verification the same case is blocked with health unknown, and the evidence lists `escaped`.
15. The reviewer's loop repro: red health with `timeoutOnly`, `timeoutRetry` and `checkedAt` 61 minutes ago, with queued work. Neither a retry nor a `main-refresh` job is requested. A later timed-out run of the same head earns no second retry (state `used`). An operator `main.verify` renews the allowance (`pending`), and so does a new head (a `main-timeout-retry` job recording that head).
16. A passing check with `timeoutMs: 500` (`true`, so start-up time cannot exceed it) runs and passes within a 180,500 ms budget.

Fail-before on `c3d7cdc` (`git archive`, new test file copied in): 11 pass, 5 fail. 12 fails on the refusal text (no head). 13: `the SIGTERM-ignoring helper must not outlive the settled result`. 14: no `escaped` report (`Cannot read properties of undefined (reading 'map')`). 15: `main-refresh:… !== null`. 16: `'fail' !== 'pass'`.

## Review fixes, round 2

A re-check of `d2ccbcf` (GPT-6.1 Sol) confirmed that the four original repros pass. It also confirmed cleanup before settlement, escape reporting, escaped results counting as unknown, sub-second checks, no added latency for passing checks (median about 28 ms) and the exhausted state being shown with a "run main.verify" hint. It rejected the change on one blocking finding. `main` had not moved, so there was no merge.

1. **An outside fix could not renew the retry automatically (medium, blocking).** `verificationRequest` refuses every automatic run of a head whose timeout retry is used up, and `probeTargetHead` read only green targets and targets held red by the scheduled tier. A fix pushed outside the factory was therefore never noticed: with exhausted timeout-only red health two hours old, approved queued work and a probe stub returning a different remote head, the stub got zero calls and the old head stayed recorded. Fix (`operations/main-freshness.mjs probeTargetHead`): a target whose `timeoutRetryState` is `used` is probed too. The cadence is unchanged: one `git ls-remote` per `policy.mainProbeMs` while work for the target is queued, or per `MERGE_QUESTION_PROBE_MS` while a merge question is open on it, and none with `policy.mainProbeMs: 0`. A different remote head is recorded as health `unknown` with `previousHead` and a `main.moved` event, which replaces the exhausted red record. The ordinary request then verifies the new head. The same head is left as it is, and the same-head refusal stands.
2. **The escape test needed `python3` (low).** A Node helper cannot reproduce this case. A Node process has no `setsid()` or `setpgid()` for itself, and a grandchild started in a new session (`spawn` with `detached: true`) was never a member of the check's group. The runner would neither find it nor report it as escaped, so it would not test that a member which left the group is skipped and reported. The test keeps the Python helper and is skipped, with the message `python3 is not on PATH: the helper must call setsid() on itself while being stopped, which a Node process cannot do`, when `python3` cannot run. Checked with a `PATH` holding only `node` and `git`: 0 pass, 0 fail, 1 skipped.

### Tests (round 2)

`tests/main-verify-timeout.test.mjs` now has 17 tests. The new one (17) is the reviewer's repro:
- Same remote head: one read, health stays red and no verification is requested.
- A second probe within `policy.mainProbeMs`: no read.
- At the next probe a different head: health `unknown` at the new head with `previousHead`, the `timeoutOnly` marker gone, a `main.moved` event, and a `main-refresh` verification requested.

Fail-before on `d2ccbcf`: 16 pass, 17 fails (the stub's reads are `[]`, not the one `git ls-remote`).
