# Test suite: intermittent failures from processes killed outside the suite

Full `npm test` runs (about 2,000 tests) often failed one to six unrelated tests, a different set each time, and the same files then passed when run alone. Earlier reports named, among others, `cleanup-archive-drop` ("git worktree failed"), `triage-proxy`, `pr-adoption-candidate`, `upkeep-learnings` ("Configured GitHub account credential unavailable"), `review-must-fix-strict`, `main-check-tiers`, `upkeep-ceilings`, `upkeep-context` ("git cat-file failed while verifying history") and `review-correction`. This records the cause, the evidence, the change and the measurements. No assertion was weakened and no test was skipped, removed or retried.

## Cause

Processes that belong to the run are killed with `SIGKILL` by something outside the suite. Those processes are test files, Git children, fake `gh` commands, validators and supervisors. It happens when the run is a descendant of the agent session that started it (the T3 Code agent's shell), or is in that session's cgroup. The kills are not timeouts, and nothing in Factotum or the tests sends them. The run is not short of memory, out of PIDs or reusing PIDs.

Every failure message in the reports above is what a killed child looks like from its caller:

- `execFileSync` in a test helper: "Command failed: git init -q" with `status: null, signal: 'SIGKILL'`.
- `verified-git.mjs`: "git cat-file failed while verifying history: " with empty stderr. `spawnSync` returned no status, and the message has no signal in it.
- `runProcess` (fake `gh auth token`): the 'close' event gives code `null`, so the scope reports "Configured GitHub account credential unavailable", or the forge reports "GitHub operation failed (transport)" with empty stderr.
- A whole test file: TAP `exitCode: ~, signal: 'SIGKILL', error: 'test failed'`, and the run reports fewer tests in total.
- A supervisor killed before it recorded ownership: the attempt becomes `uncertain` ("the launched supervisor ended before recording ownership"), and a wait for the flow times out.
- `git push`: "pack-objects died of signal 9".

## Evidence

All runs used the full `tests/*.test.mjs` set through `node tests/run.mjs`, with TAP and dot reporters writing to files, so each failure kept its exit signal and stack. The host was a 24-core machine shared with other agent sessions, another Factotum suite run from another worktree, and a VM using about seven cores. The one-minute load average was 12–60 during the runs.

| Where the run was started | Runs | Runs failed | Failures | Every failure a killed process? |
|---|---|---|---|---|
| Agent shell, agent's cgroup (as `npm test` ran before) | 8 | 7 | 18 | Yes, except 1 timing failure (below) |
| Same, with every signal traced (see below) | 3 | 2 | 6 | Yes |
| Agent shell, but moved to its own cgroup (`systemd-run --user --scope`) | 3 | 3 | 3 | Yes |
| Transient user service (`systemd-run --user`): not a descendant of the agent, own cgroup | 3 | 0 | 0 | — |

The second group added an `LD_PRELOAD` shim to every process of the run (runner, test files, supervisors, Git, fakes). It logged each `kill`, `killpg`, `tgkill`, `sigqueue` and `pidfd_send_signal` call: sender, target, signal and the target's command line. Across those 3 runs it logged 573 signals, 246 of them `SIGKILL`. Every one went to the sender's own fixture: supervisors, crash-test fixtures, `node -e` holders, process groups the test created. None reached a Git process, a test-file process or any process that died in a failing test. The shim was checked first: `ChildProcess.kill`, `process.kill` and `spawnSync` timeouts all go through it.

Other observations:

- **Kills outside the suite too.** A small `/proc` monitor I ran in the agent's process tree was killed three times in about 25 minutes. Once it was launched with exit capture and ended with status 137 (`SIGKILL`). The same monitor started as a user service ran under the same load until I stopped it. No test sent those signals.
- **Not memory.** No kernel or memory-cgroup OOM kill was logged. `/proc/pressure/memory` stayed near 0 and MemAvailable stayed at 16–20 GB. No cgroup on the path has a memory limit that was reached: the agents slice has `oom_kill 0`, and the run's cgroups have no `memory.max`. `systemd-oomd` logged nothing during the runs.
- **Not a PID, CPU-time or seccomp limit.** `pids.max` was far from reached, `RLIMIT_CPU` is unlimited, and no seccomp filter is set.
- **Not PID reuse.** The victims were freshly started (a `git init` lives for milliseconds). With `pid_max` 4,194,304 and the host allocating about 1,000–2,500 PIDs a second, numbers wrap roughly every half hour to an hour. The killer targeted live new processes, not stale numbers.
- **Not this session's own tool calls.** The three kills with known times (23:19:20, 23:27:34 and 23:29:15.6 UTC, each to within a second) fell 1–4 s away from the nearest command this investigation ran.
- **Either the agent's process tree or its cgroup is enough.** Moving the run to its own cgroup while it stayed a descendant of the agent's shell did not help (3/3 failed). The first killed monitor had been reparented to `systemd --user`, so it was not a descendant, but it was still in the agent's cgroup. Runs started as a user service, which is neither, never lost a process (0/3, then 0/6 with the change below). Canary processes that only spawned short `git --version` and `sleep` children were never killed (about 100,000 spawns). That fits a sender that picks among the agent's processes, where a test file running for seconds or minutes is a much larger target than a canary's millisecond-long children. With three canaries, this is a weak result.

**Unverified.** The sending process is not identified. Tracing signal delivery system-wide needs root, and `perf_event_paranoid` is 2, `tracefs` is unreadable and `sudo` asks for a password. The host agent application can signal processes it considers its descendants (its server bundle has a process-diagnostics signal path), but nothing found shows when it would. This matches the `SIGKILL` finding in [qualification-load-sensitive-tests.md](qualification-load-sensitive-tests.md), which reached the same conclusion with the same kind of trace, and this note supersedes its "run qualification outside the agent process tree by hand" advice for ordinary runs.

## Fix

**`tests/run.mjs` runs the suite in its own transient systemd user service.** Where `systemd-run --user` works (probed once per run with the same options), `node --test` runs as `fct-test-run-<pid>-<random>.service` instead of as a child of the runner. Everything else stays the same:

- **Environment.** It gets the runner's environment, passed name by name with `-E` (names that are not plain identifiers, such as exported Bash functions, are left out because systemd refuses them).
- **Working directory and output.** It runs in the runner's working directory, and its standard input, output and error are the runner's (`--pipe`), so reporters and TTY detection behave as before.
- **No `$` expansion.** Arguments are passed literally (`--expand-environment=no`).
- **Exit status.** The unit's exit status is the runner's: 0 on success, 1 on test failures, and 255 if `node --test` itself is killed.
- **Stopping.** `systemd-run` exits on SIGINT or SIGTERM and leaves the unit running, so the runner stops the unit (`systemctl --user stop`) on every way out, then removes the temporary directory.
- **Leftovers.** Test processes left running end with the unit (`KillMode=control-group`, `TimeoutStopSec=20`). I checked this: a hanging test file with a detached `sleep` child, sent SIGTERM through the runner, left no unit, no `sleep` and no temporary directory.

With no user manager (CI, macOS, a container), or with `FACTOTUM_TEST_DIRECT=1`, the suite runs as a child process as before. `FACTOTUM_TEST_UNIT` names the unit inside the run, and a nested `tests/run.mjs` runs directly.

This removes the run from the process tree in which processes are killed. It does not stop the sender, which is outside this repository. File-level concurrency is unchanged (`node --test` default, cores minus one). The runs above show no concurrency effect to correct: the same concurrency passed 9 of 9 times once the run was outside the agent's tree.

**`tests/main-verify-timeout.test.mjs`: the two "holder" tests no longer race the host's speed.** They asserted that the verifier finished within 6 s, against a check timeout of 8 s, to prove it stopped waiting at the 2 s exit grace and not at the timeout. One baseline run at load average 55 took longer than 6 s ("a helper that left the check's process group cannot be stopped…"). This was the only failure in any run that was not a killed process. The check timeout is now 60 s and the bound is half of it (30 s). Finishing within the bound still proves the verifier did not wait for the timeout. In the first test the 2 s grace is still proven by the recorded evidence (`DESCENDANTS_SURVIVE`, "held its output open 2 s later; it was stopped"), and `timedOut: undefined` is still asserted.

## Measurements

The same command (`node tests/run.mjs` with TAP and dot reporters to files), started the same way, from a background shell of the agent session:

| | Runs | Failed runs | Failures | Duration (median, range) |
|---|---|---|---|---|
| Before, agent's tree and cgroup | 11 | 9 (82%) | 24 | 108 s (77–274 s) |
| Before, own cgroup, agent's tree | 3 | 3 | 3 | 104 s (98–145 s) |
| Before, user service (by hand) | 3 | 0 | 0 | 106 s (94–111 s) |
| After (this change), agent's tree | 6 (consecutive) | 0 | 0 | 103 s (93–125 s) |

Durations follow the host's load, which other work drove, not the change. Baseline runs 3–5 also overlapped my canary processes, which added load. The probe adds about 0.1 s.

## Remaining

- The sender of the kills is not identified (see Unverified). The change only keeps the suite out of its reach. Anything else started from an agent shell, such as a single `node --test` or a factory check run by hand, is still exposed.
- `tests/main-verify-timeout.test.mjs` "workspace setup in a main.verify is cut to the step's time left…" asserts the same kind of 6 s bound on an 8 s setup timeout. It did not fail in any run and is unchanged, because its bound is the step's remaining time, which is what it tests.
- Failure messages from `verified-git.mjs` and `runProcess` do not name the signal that ended a child, which is why "failed while verifying history: " and "credential unavailable" were hard to read. Changing them is a production change and was not made here.
