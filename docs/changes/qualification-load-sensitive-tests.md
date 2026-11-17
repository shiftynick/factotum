# Qualification: load-sensitive tests

Release qualification needs a full suite that passes on a busy host, not one that passes on rerun. This records why six tests failed intermittently under full-suite load, what was changed, one production defect the work found, and the stress evidence. No assertion was weakened, no test was removed, skipped or retried.

## Method

Load was generated deliberately with 48 busy-loop processes on the 24-core host (2× cores), on top of whatever other work the host was doing. Each run used the same command as `npm test` with TAP output so a file-level failure records its exit code and signal.

Two kinds of failure appeared:

1. **Timing assumptions in tests.** A child process, a timer or a short bound that is reliable on an idle host but not when Node takes seconds to start.
2. **Processes terminated by `SIGKILL`.** Test-file processes (reported only as `'test failed'`) and Git children (`git config failed:` with exit code `null`) were killed mid-run.

## The `SIGKILL` failures (#3, #6) come from outside the suite

TAP showed `signal: 'SIGKILL'` for the killed test files, and the Git errors carried `signal: 'SIGKILL'`. To find the sender:

- An `LD_PRELOAD` shim logged every `kill()` call (any signal) made by every process in the suite's tree, including the runner, test files, supervisors, dispatch workers and Node `ChildProcess.kill`/`spawnSync` timeouts (verified to go through the shim). In runs with victims, no `kill()` targeted a victim's PID or process group. Every recorded kill hit its intended fixture process.
- Canary processes that spawned Git and `sleep` continuously, run in the same shell, process group, session and cgroup as the suite during a loaded run, were never killed (≈4,600 spawns), while test files beside them were.
- No kernel or memory-cgroup OOM kill, `systemd-oomd` action or other memory kill was logged, and the relevant cgroups recorded `oom_kill 0`.
- The same tree and load run under `systemd-run --user`, outside the interactive agent session's process tree, produced no `SIGKILL` victims in any run. During the same window the host agent application's own backend process was itself logged as killed by `SIGKILL`, and one of this investigation's own shell commands exited 137.

A second, stronger trace re-injected the shim into children started with a sanitized environment (supervisor workers, Git, fake CLIs). It recorded every signal sent during 8 loaded full-suite runs, 5 inside the agent session and 3 outside: 398 signals (230 `SIGTERM`, 168 `SIGKILL`). Every one targeted the sender's own fixture: its supervisors, its long-running `node -e`/`sleep` children, its forked services, or its own descendants orphaned when their leader exited (identified by the sender's own temporary paths). None targeted Git, another file's test process or the runner. Those 8 runs had no `SIGKILL` victims.

The suite's own signalling (`runProcess`, the supervisor's group and descendant termination, test cleanups) never reaches unrelated processes. The killer is in the host environment that launched the run, not in Factotum. Without root tracing (`perf_event_paranoid=2`, no `tracefs`) the exact sending process could not be named. This is the one unverified point.

Neither failure needs a Factotum change. Release qualification runs should run where host tooling does not terminate child processes. The stress runs below used `systemd-run --user`.

## Causes and fixes

| # | Test | Cause | Fix |
|---|------|-------|-----|
| 1 | `tests/main-health-audit.test.mjs` "timed out main verifier preserves actual partial stdout and stderr…" | The check was a Node child with a 150 ms timeout. Under load, Node had not started and printed before the timeout, so no stdout was captured. | The check is a shell that writes its partial output within milliseconds and then sleeps, with a 2 s timeout. It still times out (the sleep is 600 s), and the test still proves blocked, infrastructure, partial stdout and stderr, and one attempt. |
| 2 | `tests/timer-wait.test.mjs` "stop preserves timer history and resume waits for the same result deadline" | The fixture deadline was 500 ms away. Stop, resume and step took longer under load, so the wait reached its deadline before the stop was observed. | The deadline is 30 s away (the fixture now takes `maxWaitMs`, 60 s here). The test still proves a second wait pinned to the same `dueAt`. The sibling "pins its original deadline" test had the same 150 ms race. It now uses 3 s and still waits for the deadline to pass. |
| 3 | `tests/target-workspace.test.mjs` "reentry validates its existing owned tree…" | `git config` was killed by `SIGKILL` from outside the suite (see above). | None needed in Factotum. Run qualification outside the agent process tree. |
| 4 | `tests/runtime.test.mjs` "revocation cancels owned running work…" | The `until` helper gave up after 7 s, while a detached supervisor took longer than that to start under heavy load (one occurrence at load average 160). Separately, the 2 s effect could finish before the test saw it running. Underneath both is the production launch-window defect below. | `until` (`tests/helpers.mjs:14`) bounds a stuck test at 60 s and still returns as soon as the condition holds. Per-call shorter bounds were removed. The effect now runs until revoked. The production defect is fixed. |
| 5 | `tests/notification-policy.test.mjs` "resolution wakes carry the resolving actor…" | `now = Date.now() + 1000` was read before publishing and `operationalTick`. Deliveries are queued at real time, so when setup took more than 1 s they were not yet due at that stale "now". | The delivery clock (`afterQueued()`) is read after queueing in each test of the file. |
| 6 | `starter/factory/console/console.test.mjs` file-level `'test failed'` | A test-file `SIGKILL` from outside the suite (TAP `signal: 'SIGKILL'`). | None needed for the kill. The file also had a real load risk: the console's project timeout was 100 ms, and healthy fakes had to answer within it. That bound is now 3 s. Only the never-answering fake reaches it, so the unavailable-project test is unchanged. |

Further tests failed under the same load for the same reasons and are fixed the same way:

- **Short fixture timeouts on Node children that must succeed.** Effect, check, verifier and helper timeouts of 1–10 s in test fixtures are now 60 s (`tests/helpers.mjs` workflow effect, `mainChecks`/`checks`, supervised intents, fake provider and `gh` invocations). They only bound a stuck fixture. No test relies on them firing, and the full suite still runs in about 7 s unloaded. Tests that must prove a timeout keep a short one. In `tests/providers.test.mjs` (partial output) and `tests/forge-error-evidence.test.mjs` (timeout diagnostics), the child is now a shell that writes before the timeout can fire.
- **Descendant-survival races.** `tests/providers.test.mjs` "successful leader exit with redirected surviving descendant…" and `tests/runtime.test.mjs` "supervisor rejects surviving background descendants…" assumed a 0.3–0.4 s background sleep was still alive when the leader's exit was processed. The descendant now sleeps 600 s and records its PID, and the test waits until that process is gone. Draining is proven by the process disappearing rather than by elapsed time.
- **Effects that ended before the test observed them.** `tests/runtime.test.mjs` "revocation cancels owned running work…" (a 2 s effect) and `tests/recovery-delivery.test.mjs` "operator reconciliation cannot declare a still-running owned attempt settled" (a 4 s effect) need the attempt to be running when they act. Under load the effect could finish first, so the attempt never appeared as `running` (one occurrence ran into the 60 s `until` bound). These effects now run until aborted. "late successful receipt records cost…" uses an effect that finishes only after the test has stopped the flow and created a release file.
- **Client default timeout in tests that do not test timing.** `tests/dashboard-snapshot.test.mjs` "history-heavy service stays usable…" asserts correct, bounded responses and only reports timings, but its requests used the client's 1.5 s default, which a history-heavy snapshot exceeded under load ("Project request timed out"). `tests/console-details.test.mjs` "flow, collection and artifact reads…" failed the same way. These, and the other console tests that talk to a responsive service (`console-views`, `project-service`, `tasks-queue`, `model-settings`), now pass an explicit 30 s bound. The client and console defaults are unchanged. The one test that proves an unresponsive project is reported unavailable (`console.test.mjs`) still relies on a timeout firing.
- **Diagnosable waits.** `until` accepts `explain`. The waits for a running attempt in `runtime` and `recovery-delivery` report the observed attempt, flow and recent events instead of a bare timeout.
- **Contention test.** `tests/operations.test.mjs` "resource coordinator actually serializes simultaneous processes": each contender held its lease for 400 ms, so a contender that started later found it free. Contenders now hold the lease until both have reported, then exit on stdin close.
- **Test cleanup.** The sandbox cleanup aborted attempts once and waited 3 s. A supervisor still starting at that moment was never aborted. It now re-requests abort until every attempt is quiescent, bounded at 30 s.

## Production defect: a slow-starting supervisor was declared lost

`inspect()` (`starter/factory/core/effects.mjs`) reported a dispatched attempt `uncertain` ("dispatch has no live owner or terminal receipt") once 5 s had passed without `owner.json`, even when the detached supervisor process was alive and still starting. On a busy host this stopped the flow for operator recovery, while the supervisor could still go on to run the effect. It was observed under load as `tests/forge-error-evidence.test.mjs` "the supervised publication worker retains the cause…" reading a receipt that did not exist.

Fix: in process mode, `launch()` records the launched supervisor's process identity (PID, boot ID, start time) in `launch.json`, bound to the attempt ID and intent digest. While that exact process is alive, the attempt is `launching`. When it is gone without ownership or a receipt, the attempt is `uncertain` as before. Without launch evidence (the controller stopped before writing it, or `systemd` mode, where `systemd-run` returns only after the unit has started), the 5 s window still applies. Regression tests: `tests/launch-liveness.test.mjs` (fails on the previous code).

## Stress evidence

All runs are the full `npm test` file set on the 24-core host. "48 busy loops" is the deliberate load (2× cores). The host was also running unrelated work throughout, so the load average shown is the one-minute value at the end of each run. "Outside" means started with `systemd-run --user`; "inside" means started from the agent session.

Final qualification at the code commit of this change (659 tests per run):

| Set | Added load | Load average | Runs | Result |
|-----|------------|--------------|------|--------|
| Outside | 48 busy loops | 51–95 | 6 | 6 passed, 0 failures |
| Outside | none | 75–88 (host) | 3 | 3 passed, 0 failures |
| Inside | none | 61–68 (host) | 3 | 3 passed, 0 failures |
| Inside | 48 busy loops | 80–92 | 4 | 3 passed; 1 failure: `bulk-scan-responsiveness` deadline (see below) |
| `npm run eval` | | | 1 | exit 0 |

No run had a `SIGKILL` victim.

Earlier runs of the same fixes, before the last test-only changes: 6/6 outside with 48 busy loops (load 79–117), and 8 traced loaded runs (5 inside, 3 outside), all passing.

Before the fixes, all 8 loaded runs inside the agent session failed, with 1–8 failures each at load averages 45–124. Six of them had `SIGKILL` victims.

Root-reported failures, all covered by the runs above with no failures: `commission-maintenance` "main verification preserves dirty evidence…" (1 s check bound, now 60 s), `console-details` "flow, collection and artifact reads…" (console default timeout, now an explicit bound), `operations` "resource coordinator actually serializes…" (lease handshake), `runtime` "supervisor rejects surviving background descendants…" (PID-based drain), `stats-view` "routine orchestrator merges…" (`git add` `SIGKILL`, external; see above).

## Open items

- **`tests/bulk-scan-responsiveness.test.mjs` "socket handshake, operator command and Tasks page meet the console deadline during a slow queue scan"** asserts the production console deadline: the real client, with its real 1.5 s timeout, must get answers while a slow scan runs. In one of 4 loaded runs inside the agent session (load average 92, the slowest setting measured), the service did not answer within 1.5 s. The deadline was really missed; it was not a test fault. It passed in every other run. Making it load-independent, for example by asserting the number of slow scans served during the request batch and treating wall time as a diagnostic, would change what it proves, so it is left unchanged for a decision.
- **`tests/runtime.test.mjs` "revocation cancels owned running work…"** timed out at its 60 s bound in 3 of 15 runs at one intermediate commit: the attempt was never observed `running`. It did not recur in 24 later full runs or in 48 isolated runs under load, and the cause was not identified. That wait now reports the observed attempt, flow and events, so a recurrence is diagnosable.

## Residual risk

`tests/supervisor-quiescence.test.mjs` "brief exiting children are quiescent…" depends on a 20 ms background child finishing within the supervisor's production 50 ms exit grace. On an extremely overloaded host the supervisor could correctly report that child as surviving. It never failed in the runs above, and changing the production grace is a containment-policy decision, not a test fix.

## Independent review fixes

The review approved the change with one blocking finding: a supervisor that stalled before recording ownership could not be cancelled through Factotum. Its live launch evidence kept the attempt `launching` indefinitely. `requestAbort()` signalled only `running` attempts, the effect timeout starts inside the supervisor after ownership, reconciliation accepts only `uncertain` attempts, and quiescence checks reject `launching`. A stopped (`SIGSTOP`) supervisor with its task revoked kept its capacity and reservations until someone intervened outside Factotum.

### Cancelling a launch that has not recorded ownership

`requestAbort()` (`starter/factory/core/effects.mjs`) now handles a `launching` attempt whose launch evidence names a live supervisor. It runs whenever the flow has `abortRequested` (stop with abort, task revocation, operator abort), on every engine tick.

1. **Durable request.** The first call records `launchAbort.requestedAt` on the attempt (event `attempt.launch-abort-requested`) and writes `abort.json` (attempt ID, intent digest) in the attempt directory. The supervisor now listens for `SIGTERM`/`SIGINT` before anything else, and after recording ownership and before starting the effect it yields once and reads `abort.json`. If either says stop, it does not start the effect and writes a receipt with `reason: 'abort'` and `effectStarted: false`, which settles normally. No signal is sent in this phase: a `SIGTERM` that lands while Node is still starting kills the supervisor with the default action and leaves an `uncertain` attempt, which on a loaded host would make ordinary early stops need operator reconciliation.
2. **Bounded escalation.** If the supervisor is still live without ownership `LAUNCH_ABORT_GRACE_MS` (15 s) after the request, it is frozen with `SIGSTOP` and Factotum waits (up to 1 s) until `/proc` shows it stopped. A frozen supervisor cannot record ownership or start the effect, and it starts the effect only after `owner.json` is in place, so if neither `owner.json` nor a receipt exists it is killed with `SIGKILL` (event `attempt.launch-killed`). Nothing it could have launched exists.
3. **Ownership wins the race.** If `owner.json` or a receipt exists once it is frozen, or it did not stop within the wait, it is resumed with `SIGCONT` (event `attempt.launch-abort-owned` when ownership won). It then reads `abort.json` before starting the effect; if it had already started it, the attempt is `running` and the existing owned abort path (`SIGTERM` to the owner, which terminates the effect's process group with its own escalation) stops it.

Every signal is preceded by a PID + boot ID + start-time identity check and a zombie check, so a reused PID is never signalled. Without launch evidence (systemd mode, or the controller stopped before recording it) nothing is signalled and the 5 s launch window applies as before.

Once the recorded supervisor is confirmed gone without ownership or a receipt, `inspect()` reports `uncertain` immediately ("the launched supervisor ended before recording ownership") instead of waiting out the 5 s window, after re-checking that ownership or a receipt did not appear while it looked. `assertAttemptQuiescent()` accepts that state as established quiescence without an independent attestation: launch evidence for this exact attempt, a supervisor confirmed dead (or an unreaped zombie with the same identity), and no ownership record. `attempt.resolve` can then settle it. `inspect()` also re-reads the receipt when an owner is found dead, closing a pre-existing window where a supervisor that wrote its receipt and exited between the two reads was reported `uncertain`.

### A stalled launch is reported, not declared lost

Elapsed time still never makes a live launch `uncertain`. When an attempt has been `launching` with a live supervisor for `LAUNCH_STALL_NOTICE_MS` (10 minutes) and no abort has been requested, the engine records `launchStalled` (`since`, `observedAt`, `supervisorPid`, `boundMs`) on the attempt once, with event `attempt.launch-stalled`. It appears in the attempt view, and `queueStatus()` adds a `launch-stalled` hold that the Queue tab shows: "Attempt … has been launching since …: its supervisor (PID …) is alive but has not taken ownership. Stop the flow to abort it."

### Regression tests (`tests/launch-liveness.test.mjs`)

| Test | On 9209ae9 |
|------|-----------|
| Stalled startup (real supervisor `SIGSTOP`ped before ownership) + revoke: no signal within the grace, `abort.json` written, reconciliation refused while live; after the grace `SIGSTOP` then `SIGKILL`, the attempt becomes `uncertain` and `attempt.resolve` succeeds without attestation | fails |
| A supervisor held busy just before recording ownership (preload stalls `owner.json`) reads the stop request and never starts the effect | fails |
| Abort racing ownership: ownership is recorded as the freeze lands; the supervisor is resumed (`SIGSTOP`, `SIGCONT`, never `SIGKILL`) and records an aborted receipt without starting the effect | fails |
| Stall diagnostic: a young launch is not reported; past the bound it is reported once, stays `launching`, shows in the attempt view and as a queue hold, and does not abort | fails |
| PID reuse: launch evidence whose PID now belongs to another process, at request and at escalation, never signals it | passes (guard) |
| systemd mode: `launch()` records no launch evidence, the 5 s window applies and nothing is signalled | passes (unchanged behavior) |
| Real supervisor, abort 0–400 ms after dispatch: whether the stop lands during Node startup, before the effect or after it, the effect process is gone and the attempt is settled or reconcilable | passes (invariant) |

The fail-before-fix check reverted only the five source files to 9209ae9 and added the two exported constants so the test file links. The four new-behavior tests failed: no abort request was recorded and no signal reached the stalled supervisor, the effect ran, and no stall was reported. (Their 30 s durations are the sandbox cleanup waiting on a supervisor the old code could not stop.) The race subtests also failed in that combined run, but only because the preceding failures left frozen supervisors behind; run alone on 9209ae9 they pass, as an invariant test should. Hooks that freeze supervisors are now restored before the sandbox cleanup runs, so one failure cannot cascade.

### Non-blocking items

- **Timeout diagnostics.** `until()` without an explicit `explain` now reports every open sandbox's last attempts (with the inspected effect), flows and the last 10 events. The runtime revocation helper moved to `tests/helpers.mjs` as `attemptState` and is reused by `recovery-delivery` and the new tests.
- **Sandbox cleanup** awaits the new abort path, which ends a stalled launch within the grace. If attempts are still active after its 30 s bound it now fails the test with each attempt's status, inspected effect and `launchAbort`, plus the sandbox state, instead of proceeding silently.
- **Bulk-scan responsiveness.** The real 1.5 s console-deadline test is unchanged. A separate test serves the same handshake, operator command and Tasks page during the slow scan with a 60 s stuck-service bound and asserts the work behind the deadline: the scan itself makes one workspace observation (4 slow reads), and the three requests add at most one more (4 measured).

### Evidence for these fixes

Focused files (`launch-liveness`, `runtime`, `supervisor-quiescence`, `recovery-delivery`, `main-health-audit`, `timer-wait`, `notification-policy`, `operations`, `console`, `bulk-scan-responsiveness`, plus `reconcile` and `queue-status`): 88 tests, 88 passed.

| Set | Added load | Load average | Runs | Result |
|-----|------------|--------------|------|--------|
| Outside | none | 11–13 | 2 | 675/675 each |
| Outside | 48 busy loops | 30–39 | 2 | 675/675 each |
| Inside | 48 busy loops | 48–57 | 2 | 675/675 each |
| `npm run eval` | | | 1 | exit 0 |

The host was quieter than during the earlier qualification (load 45–160), so these runs do not re-establish behavior at the heaviest loads measured above. A further unloaded `npm test` (675/675) left no supervisor processes behind. The fail-before-fix run on 9209ae9, made before the hook-ordering fix, did leave 11 frozen test supervisors; they were removed.

### Re-check fixes (root)

An independent re-check of `6e48c6b` confirmed the stalled-launch finding resolved in the normal path and that ownership is durable (fsync, rename, directory fsync) before the effect is spawned, then rejected on two findings, both fixed:

- **Frozen owner after a runner restart (P1).** If ownership appeared between inspection and SIGSTOP and the runner died before SIGCONT, the restarted runner classified the attempt as running and sent only SIGTERM to a stopped process, which cannot act on it. The owned abort path now sends SIGCONT after SIGTERM, after the same identity and zombie checks; SIGCONT is harmless to a running process. Regression: an owned, SIGSTOPped supervisor receives the stop on abort. On `6e48c6b` this test never completes (the process stays stopped).
- **Malformed launch identity (P2).** `launchEvidence()` accepted any truthy `supervisor`, so `{}` read as a dead process and granted the no-attestation reconciliation shortcut. Launch evidence now requires a positive integer PID, a boot ID and a numeric start time; otherwise it is not evidence and the attempt stays uncertain, needing attestation. Regression fails on `6e48c6b`.

Noted, not changed: sandbox cleanup's timeout path reports active work and fails the test but still removes the sandbox while processes may be live.

Second re-check (approve with fixes) found a frozen supervisor could still be left stopped when ownership and a receipt won before the freeze and the runner died before SIGCONT, since a terminal attempt was never revisited. Fixed by root: launch cancellation now records `launchAbort.frozen = true` durably before SIGSTOP and clears it after SIGKILL or SIGCONT; every engine tick (and `requestAbort`) first calls `resumeInterruptedFreeze`, which continues the identity-verified supervisor only when such a recorded freeze was never ended, whatever the attempt's state. A process stopped by anyone else is left alone. The frozen-fixture tests now continue and reap their child in `finally`, before sandbox cleanup, so they fail cleanly instead of hanging on old code.

Verification: `tests/launch-liveness.test.mjs` 20/20; the five-file focused group 50/50 in three of four runs; full suite 678/678. One focused-group run failed "a stop request received before ownership means the effect is never started" once (the test stalls the supervisor 1.5 s before ownership and assumes the engine writes the stop request within that window); it passed 5/5 alone and in the other runs. If the window is missed under load, the effect starts and the owned abort path stops it, so this is a test timing assumption rather than a safety gap; recorded as a residual load sensitivity.

Third re-check: **approve with fixes**; both prior findings resolved. Its one non-blocking finding is fixed by root: the supervisor removed its stop handlers before publishing the receipt, so a late SIGTERM took the default action and killed it, leaving no receipt and an uncertain attempt. Handlers now stay installed until the receipt is durable. Regression (stall the receipt rename, send SIGTERM) fails on the previous commit with the supervisor killed by SIGTERM and passes with the fix. The re-check noted the earlier single failure of "a stop request received before ownership…" recorded its abort request about 53 ms after dispatch, so this gap, not the 1.5 s window, is the likelier cause.
