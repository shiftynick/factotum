# Trial R3: a waiting question re-fingerprinted its checkout on every tick

The dev.81 readiness trial reported that a project service with one flow waiting on a question used about a third of a core on a 146-file repository, and that on a 20,000-file repository it used more than a whole core, answered handshakes in 145–442 ms and refused half of the concurrent CLI commands with `database is locked`. This records the cause, the change, the window in which a candidate change is now found later than before, the measurements and the tests.

## Cause

`service/project-service.mjs` runs `engine.tick()` every 75 ms. The tick stepped every flow that was not finished, including flows waiting on an open question. For a question node the step:

1. called `authorized()` twice, which re-hashes every factory module (`executorDigest()`, about 1 ms);
2. opened a write transaction (`BEGIN IMMEDIATE`);
3. inside that transaction called `repositoryIdentity()`: two synchronous Git processes and a read and SHA-256 of every tracked and non-ignored file;
4. only then looked up the existing open question and returned it.

So every waiting flow fingerprinted its whole checkout 13 times a second, on the thread that serves the project socket, while holding the database's write lock. The lock explains the `database is locked` failures: on a large checkout one fingerprint takes longer than the tick interval, the service held the lock almost continuously, and another process's command waited out its 5 s busy timeout.

## Design

**A flow waiting on its own open question is parked.** The tick does not step it until something its question depends on may have changed. The step's inputs are the store, the clock (the question's expiry), the candidate checkout, and the factory's own code. The engine keeps a small in-memory record per parked flow and per checkout, and each tick compares:

| Input | Signal checked every tick | Cost |
| --- | --- | --- |
| Store (answer, stop, resume, replan, revocation, configuration, another flow's events, a command from another process) | `PRAGMA data_version` and `total_changes()`: change whenever any connection writes anything | two constant-time reads per tick |
| Expiry | the open question's `expiresAt` against the clock | a comparison |
| Candidate checkout | stat identity of the worktree's Git `HEAD`, `logs/HEAD` and `index` (`repositoryProbe`), and the revalidation interval | three `stat` calls per checkout (4 µs measured) |

What happens when a signal fires:

- **The store changed.** The flow is stepped at that tick exactly as before (authority, workflow, evidence, risk and subject checks, in a transaction), using the candidate identity already established. No fingerprint, no Git process. A revocation or a stop therefore takes effect at the next tick, as it did.
- **The expiry time is reached.** The flow is stepped and the question expires at that tick, as before.
- **Git's metadata for the checkout changed** (a commit, checkout, reset, rebase, stash or staging). The checkout is fingerprinted again at the next tick, but not more often than ten times the duration of its last fingerprint, so a tool that rewrites the index continuously cannot recreate the busy loop.
- **An answer was refused with `question subject changed`.** The engine sees the `command.rejected` event and fingerprints the checkout again at the next tick, so the flow stops and the question is superseded immediately after a refused answer, as it did.
- **The revalidation interval elapsed.** 60 seconds after the checkout was last fingerprinted (`QUESTION_REVALIDATE_MS`), or 100 times the duration of that fingerprint if that is longer, it is fingerprinted again. The factor bounds periodic revalidation at about 1% of one core per checkout however large it is.

**The fingerprint is off the tick's thread and outside any transaction.** A question step now establishes the identity before its transaction, on a worker thread that runs the unchanged `repositoryIdentity()` (`core/repository-worker.mjs`). The socket is served while a large checkout is read, and no other process is locked out of the database. The transaction then re-reads the flow and declines to act if it was stopped, held, moved on or given a different checkout meanwhile.

**Questions parked on one checkout share one fingerprint.** Task flows wait on the project root; five of them cost one fingerprint per interval, not five.

**The tick yields between flows.** After each flow it actually steps, the tick lets the event loop run, so a store write that wakes several parked flows blocks the socket for one step at a time.

The park records are memory only. A restarted service validates every open question, with a fresh fingerprint, on its first tick.

Why not a cheaper signal for working-tree edits: detecting an edit Git has not been told about needs at least an `lstat` of every listed file (`git status` does the same). That is 20–40 ms of blocking per check on 20,000 files, which is not idle-level at any useful frequency. The interval covers that case, and the answer path covers its safety.

Why `repositoryIdentity()` itself was not made cheaper: hashing Git object IDs from the index instead of file contents would change every `treeDigest`, so identities recorded before an upgrade (evidence, review identities, merge authorizations) would no longer match, and it would trust Git's stat cache where the fingerprint today reads every byte. With this change the fingerprint no longer runs repeatedly, so the trade is not needed. One real limit was fixed: the path listing used Node's default 1 MiB child-output limit, so a checkout whose listing was larger (about 9,000 files with long names, or roughly 26,000 with short ones) failed with `spawnSync git ENOBUFS`.

## Detection window

Unchanged, at the next tick: a stop, resume, replan or revocation; an answer; expiry; any store change that alters the question's subject (task revision, workflow, risk); a candidate change made through Git (commit, checkout, reset, staging), subject to the ten-times-fingerprint throttle above (a reviewer's probe with a 150 ms fingerprint detected staging after about 1.6 s); a candidate change of any kind once an answer has been refused for it.

Later than before:

- **An edit to a working-tree file that Git has not been told about, with no answer attempted.** Found within the revalidation interval: 60 s after the last fingerprint of that checkout, or 100 × its fingerprint time if longer (the 20,000-file, 160 MB fixture fingerprints in about 0.2 s, so 60 s; a checkout that takes 2 s would be revalidated every 200 s). Before, it was found within 75 ms.
- **A change to the factory's own code on disk under a running service** (`pinned executor differs`), for a parked flow only. Found at the next store change or revalidation interval, and at any answer.

Why the delay is safe: nothing can be decided on a stale candidate. The `answer` command still fingerprints the checkout itself, inside its own transaction, and refuses a changed subject (`core/project.mjs`, `QUESTION_SUBJECT_CHANGED`); it also re-checks authority and the executor. Merge and completion re-verify the candidate against the recorded decision as before. The only effect of the window is that a question whose candidate was edited out of band stays listed as open for up to the interval before its flow is stopped. Trying to answer it is refused and stops the flow at the next tick.

## Other tick-path findings

Fixed here:

- **A pending timer wait wrote the flow record on every tick** (a write transaction and an fsync every 75 ms per waiting flow). It now opens no transaction until the timer is due.
- **The operations tick (1 s, delivery mode) observed every active change flow's workspace three times a second** (four Git processes each, 23 ms per observation on the 20,000-file fixture), even with nothing queued, and one of the three ran inside the queue-claim write transaction. Nothing is observed while the queue is empty, which is the state of a project whose only open work is a merge question. With tasks queued, the claim's advisory observation is now made before its transaction; the claim itself still re-observes inside it.

Found and not changed:

- **Any store write re-checks every parked question once** (see the last measurement). A delivery project with queued tasks writes every second, so a parked question there costs about 0.6% of a core rather than nothing. Most of that step is the two `authorized()` calls below.
- **With tasks queued, each active change flow's workspace is still observed three times a second** by the operations tick (queue eligibility twice, candidate selection once): about 70 ms of synchronous Git per second per active flow on the 20,000-file fixture. Caching an observation changes how fresh queue eligibility is and deserves its own decision.
- **`authorized()` re-hashes the factory's modules** (about 1 ms) on every tick for each flow in a timer wait, a decision hold or a provider usage-limit hold: roughly 1.5–3% of a core per such flow. No Git, no process and no transaction is involved.
- **`expireLapsedGrants` opens a write transaction every tick** on migrated (schema 2) projects, and the tick parses every flow record, finished ones included. Both are short; the second grows with history.
- **Fingerprints on progress paths stay synchronous on the service thread**, once per transition: preparing an attempt, the dispatch check, settlement and completion (about 0.2 s each on the 20,000-file fixture). `docs/qualification.md` already lists executor preparation and dispatch as latency risks.
- **The final input check before dispatch and the accepted-candidate check at completion fingerprint inside their write transaction**, once per attempt and once per flow. That is deliberate and must stay: see "Review fixes". Other writers wait on the 5 s busy timeout (about 0.2 s on the 20,000-file fixture).
- **The `answer` command fingerprints inside its command transaction**, once per answer. That exact check is the safety property this change relies on, and other writers wait on the 5 s busy timeout.

## Measurements

Fixture: a fictional rehearsal project whose flow runs one effect and then waits on a question; further waiting flows are copies of it. The repository is 2,000 files (16 MB) or 20,000 files (160 MB) of 8 kB each. The real project service runs in-process with its 75 ms tick. Over each window: the service process's CPU for all threads (`process.cpuUsage`); handshake latency sampled every 50 ms over the project socket from a separate thread; eight `cli.mjs command` calls (`task.put`) from separate processes spread over the window; one `/v1/snapshot` at the end. Host: 24 cores, Linux, Node 26.12, Git 2.56, with other work running (load average 3–10), which shows as occasional latency spikes in every configuration including idle. Before is commit `73b5d41`; after is this change.

16-second windows:

| Files | Open questions | Service CPU before | after | Handshake p50 / p99 / max before (ms) | after (ms) | CLI commands before | after | Snapshot before | after |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2,000 | 0 | 3.0% | 3.0% | 0.8 / 1.8 / 7.1 | 0.8 / 1.4 / 6.5 | 8 ok, 78–90 ms | 8 ok, 83–90 ms | 6 ms | 8 ms |
| 2,000 | 1 | 50.9% (+10% in Git children) | 3.5% | 24.8 / 32.3 / 34.5 | 0.8 / 6.0 / 16.7 | 8 ok, 83–123 ms | 8 ok, 82–128 ms | 9 ms | 16 ms |
| 2,000 | 5 | 91.3% (+24%) | 4.4% | 107.7 / 127.8 / 273 | 0.7 / 2.1 / 6.8 | 8 ok, 320–1,448 ms | 8 ok, 82–88 ms | 514 ms | 8 ms |
| 20,000 | 0 | 3.0% | 3.3% | 0.8 / 1.5 / 7.8 | 0.8 / 1.2 / 9.7 | 8 ok, 82–96 ms | 8 ok, 84–115 ms | 8 ms | 6 ms |
| 20,000 | 1 | 109.8% (+7%) | 3.4–3.8% | 133 / 345 / 373 | 0.8 / 1.2–1.6 / 6.6–6.7 (three runs); 0.9 / 20.3 / 28.0 (one run) | **4 ok, 4 `database is locked`**, 1.5–5.5 s | 8 ok in each of four runs, 77–92 ms (one 246 ms) | 590 ms | 7–9 ms |
| 20,000 | 5 | 107.4% (+6%) | 4.5% | 893 / 1,812 / 1,812 | 0.8 / 1.9 / 6.7 | **6 ok, 2 `database is locked`**, 3.7–6.6 s | 8 ok, 80–88 ms | 2,800 ms | 8 ms |

The 20,000-file, one-question case was run four times after the change. Three runs had a worst handshake of 6.6–6.7 ms. The fourth had samples up to 28 ms in the same seconds in which one CLI process took 246 ms instead of about 85 ms, and the 2,000-file one-question run shows the same kind of spike (16.7 ms); so did an idle control (below). The service CPU figures after the change include the cost of serving the eight CLI commands' store writes, each of which wakes every parked flow for one store-only step.

150-second windows, 20,000 files, which include at least two revalidations of the 160 MB checkout:

| Open questions | Service CPU | Handshake p50 / p99 / max (ms) | Worst event-loop delay | CLI commands |
| --- | --- | --- | --- | --- |
| 0 (control, run at the same time) | 1.9% | 0.6 / 1.2 / 7.4 | 7.9 ms | 8 ok |
| 5 | 2.5% | 0.6 / 1.2 / 7.2 | 11.7 ms | 8 ok |
| 1 | 2.4% | 0.6 / 1.4 / 7.6 | 15.7 ms | 8 ok |
| 0 (control, run alone, earlier) | 2.2% | 0.7 / 8.0 / 41.7 | 51.2 ms | 8 ok |

The one-question row and the earlier control were measured before the last two refinements (shared fingerprint, yielding between flows); the earlier control shows the host's own spikes with no question open. A separate trace of five questions on the 20,000-file checkout through three revalidations recorded a worst event-loop lag of 4.9 ms; each fingerprint took about 0.2 s on the worker thread.

With an unrelated store write every second (a delivery project with queued tasks rewrites their eligibility every second), 20,000 files, 60-second windows: 5.5% with five open questions against 2.3% with none, handshakes 0.7 / 1.3 / 6.7 ms, 8 of 8 CLI commands accepted. A 30-second repeat gave 5.8% against 2.7%. Each store write re-checks every parked question once against the store (no Git, no fingerprint): about 0.6% of a core per parked question per write per second in the running service. Driven in a tight loop the same step takes 1.8 ms, and a tick over five parked questions with nothing changed takes 0.04 ms.

## Verification

- `tests/waiting-question-fingerprints.test.mjs` (17 tests). Every Git process the test file starts goes through a wrapper that records it and, during engine ticks, tries to take the state database's write lock without waiting. The tests prove: 200 ticks of a parked question start no Git process, take no fingerprint, step nothing and write nothing; five parked questions cost the same and share one fingerprint; a commit and a staged change stop the flow without waiting for the interval; an unreported edit stops it within the interval; inside the interval the question stays open, its answer is refused exactly and the refusal stops the flow at the next tick; an unchanged candidate is revalidated and stays parked; expiry applies at the first tick after its time with no store write to wake it; a revocation stops the flow at the next tick with no fingerprint; a write from another connection wakes a parked flow; a question, preparation and settlement are fingerprinted with the write lock free, and exactly the final dispatch check and the completion check hold it; an input edited while the dispatch waits for the write lock is not dispatched, and a candidate edited while completion waits for it does not complete; another connection can write while a question is fingerprinted; a stop that lands during the fingerprint is not overwritten; a pending timer opens no transaction; the operations tick starts no Git process for a parked change flow with an empty queue and still observes it once a task is queued.
- `tests/repository-identity.test.mjs` (3 new tests): a listing over 1 MiB is fingerprinted, on and off the calling thread, with equal results; the worker reports the same refusal, code and path as the direct call; the probe changes with staging and commits in main and linked worktrees and not with unreported edits.
- On the base commit `73b5d41`, 16 of these 20 tests fail. The four that pass there guard behavior that must not change: a staged change stops the flow, another connection's write is seen, and the two write-lock races (which the first version of this change broke, see "Review fixes"). For the base run the new exports were stubbed so each test reports separately.
- Full suite: 831 tests, 831 pass, 0 fail, 0 skipped. `npm run eval` passes. `git diff --check` is clean.

Not verified: a live service under systemd with real adopter state (the measurements use the real service code in-process on fictional fixtures); delivery-mode CPU with a change flow parked on a merge question was tested for Git process counts, not measured for CPU; a `reftable` repository, where `logs/HEAD` does not exist and the probe sees index changes only (the interval and the answer path still apply).

## Review fixes

An independent review of the first version of this change (commit `5184dad`) rejected it for one safety regression.

**Finding.** That version moved two fingerprints to just before their write transaction: the final input check before dispatch, and the accepted-candidate check at a completed end node. The engine can wait up to 5 s for the write lock (`BEGIN IMMEDIATE` with the busy timeout). An identity taken before that wait was trusted after it, so a candidate edited while another process held the lock was dispatched, and an answered flow completed on a changed candidate. On `73b5d41` both flows stop.

**Fix.** Both checks fingerprint inside the transaction again, with the write lock held, exactly as on `73b5d41`. They run once per attempt and once per flow, not per tick, so they are not part of the reported cost. A metadata probe could not replace them: it does not see an edit Git has not been told about. The parked-question path is unchanged. Its fingerprint stays before the transaction, which is safe for a different reason: a question opened on a stale identity cannot be answered, because the `answer` command fingerprints inside its own transaction and compares subjects. The reviewer confirmed that path, the queue-claim admission checks and the reftable fallback as they are.

**Evidence.** Two regressions hold the write lock from a second connection on another thread, edit the candidate while the engine's transaction waits, then release:

| Test | `73b5d41` | `5184dad` | this commit |
| --- | --- | --- | --- |
| an input edited while the dispatch waits for the database write lock is not dispatched | pass | **fail** (attempt dispatched) | pass |
| a candidate edited while completion waits for the database write lock does not complete | pass | **fail** (flow completed) | pass |

The lock-probe test now states the rule positively: over a whole flow, exactly the dispatch check and the completion check fingerprint with the write lock held (two Git processes each), and question, preparation and settlement fingerprints find it free. It fails on `5184dad` (which held it for none) and on `73b5d41` (which held it for every question step).

**Measurements after the fix**, 20,000 files (160 MB), same method as above:

| Window | Open questions | Service CPU | Handshake p50 / p99 / max (ms) | Worst event-loop delay | CLI commands | Snapshot |
| --- | --- | --- | --- | --- | --- | --- |
| 16 s | 5 | 4.5% | 0.8 / 1.8 / 6.7 | 10.1 ms | 8 ok, 81–88 ms | 9 ms |
| 16 s | 0 | 2.9% | 0.8 / 1.4 / 6.7 | 7.3 ms | 8 ok, 80–87 ms | 6 ms |
| 150 s | 5 | 2.5% | 0.6 / 1.3 / 7.0 | 11.2 ms | 8 ok, 78–92 ms | 9 ms |
| 150 s | 0 (run at the same time) | 1.9% | 0.6 / 1.3 / 6.8 | 18.7 ms | 8 ok, 80–91 ms | 7 ms |

These match the figures above: the fix touches only the once-per-attempt and once-per-flow checks, which the parked state does not reach. On `73b5d41` the five-question 16 s window was 107% of a core, handshakes 893 / 1,812 / 1,812 ms and 2 of 8 CLI commands refused.


Re-check (GPT-6.1 Sol) of `5be2074`: approve; the lock-wait races fail on `5184dad` and pass here, and no other consequential path trusts an out-of-transaction fingerprint. Its one wording item, that Git metadata changes are detected "at the next tick" without the throttle, was fixed by root.
