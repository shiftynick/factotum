# Trial R2: cleanup lost a fetch race and leaked its workspace

Implementation on branch `t3/fix-cleanup-fetch-race`; not a release. Reported from the dev.81 readiness trial (0.2.0-dev.20261022.81): observed once in three merges with `policy.autoQueue: true`.

## Cause

With `autoQueue`, a merge queues the post-merge `main.verify` at once. The flow's `cleanup` attempt and that verification were dispatched 120 ms apart, and both ran `git fetch` for the target in the project repository. Git updates a remote-tracking ref under a lock with an expected old value, so one fetch failed:

```
git fetch failed: error: cannot lock ref 'refs/remotes/origin/main': is at c0ade23… but expected 5cf853c…
 ! 5cf853c..c0ade23  main -> origin/main  (unable to update local ref)
```

That was the cleanup's fetch. The `cleanup` node's failure edge leads to `done`, so the flow completed, which is correct because delivery was proven. But three things were missing:

1. No factory fetch tolerated a concurrent fetch of the same ref.
2. The engine wrote `cleanupPending: true`, but nothing read it. There was no retry, obligation or notice, and the completed-flow notice did not mention it.
3. `cleanup plan/apply` accepted only failed flows, and a completed flow can be neither stopped nor abandoned. No documented command could finish the cleanup.

## Fix

**1. Ref-lock retry for every factory fetch (no lock).** `core/git-options.mjs` adds `retryRefLockedFetch` and `retryRefLockedFetchSync`. When a `git fetch` fails with a ref-lock error (`cannot lock ref`, `unable to update local ref`, or `Unable to create '….lock': File exists`), it is repeated up to five times with jittered backoff of 100 ms to 2 s, about 4 s in all. Other failures and other Git commands are never retried. The retry is applied where the factory's Git calls are made, so every fetch path is covered:

- the workspace adapter's `git()`: candidate adoption, target integration, push tracking, source verification, `workspace.release`, and archive retention;
- the maintenance runner's `runGit`: `main.verify`, `target.sync`, scheduled tasks, and audits;
- `upgrade apply`'s synchronous Git.

The existing invocation safeguards are unchanged: `-c maintenance.auto=false -c gc.auto=0`, scoped credentials, and remote rewriting. The retry wraps `prepareGitInvocation`.

Why retry rather than a lock: Git's ref transaction already serialises the update atomically, and the losing fetch changes nothing, so repeating it is safe and gives the correct result. A factory lock file could not cover Git processes the factory does not run, such as the project's own checks or an operator's fetch. It would also add stale-lock-after-crash and hang-while-held failure modes to every fetch, and the lost race would still need a retry.

**2. Acting on `cleanupPending`.** On a failed `workspace.release`, the engine now also records `cleanupFailure: {attemptId, reason, at}`. The completed-flow notice gets the title suffix "(cleanup outstanding)" and a paragraph naming the workspace, the branch, the failure, the automatic retry and the finishing command. `terminalReason` stays empty.

In the operations loop, `retryPendingCleanups` runs when the project is not paused or held. It retries each completed, proven flow with `cleanupPending` after 1, 5 and 30 minutes. A flow is skipped while any of its attempts is unsettled, or while its per-flow cleanup lock is held. That is the same lock `cleanup apply` takes. The retry runs `releaseDeliveredWorkspace`, the release the cleanup step performs (shared with `dispatch.mjs`). In delivery mode it runs inside the configured account's Git scope.

- **Success.** It clears `cleanupPending` and records `workspaceReleased` (actor `factory`) and `cleanupResolved`. Events: `cleanup.retried` and `flow.cleanup-resolved`.
- **Third retry fails.** It raises obligation `<flowId>:cleanup` (owner operator, pending, not authorization-gated, so it does not block drains) and operator notice `cleanup-notice:<flowId>`. Both name the workspace path, the branch, the last error and the `cleanup plan` / `cleanup apply` commands. Event: `cleanup.escalated`. Retries then stop.

**3. `cleanup plan/apply` on a completed flow.** A `completed` flow is accepted when it has a proven merge or a recorded satisfied outcome, reconciled attempts, a matching ownership manifest, no other referencing flow or plan, no leases, and a workspace that was not released. The plan reports `outcome: "completed"` and one of two modes:

- `mode: "release"` for a clean workspace. Apply runs `releaseDeliveredWorkspace`, so preservation is the same as for the cleanup step: merged into the fetched target, or kept in a verified bundle for squash and rebase. A release interrupted after worktree removal is planned with `reconcile: true` and finished.
- `mode: "archive"` for a dirty workspace. This is the existing full archive path, writing to `archives/completed-workspaces/`, so unsaved work is preserved, never discarded.

Both modes clear `cleanupPending`, mark the obligation `passed` and supersede the notice. Failed-flow behavior is unchanged.

## Compatibility

- No schema or configuration change. New flow fields (`cleanupFailure`, `cleanupRetry`, `cleanupResolved`) are optional.
- Flows left with `cleanupPending: true` by earlier releases have no `cleanupFailure`. The loop times their first retry from `finishedAt`, so the leaked workspace in the report is retried after upgrade and escalated if it cannot be released.
- The failed-flow plan format and digest are unchanged. Only completed flows gain `outcome` and `mode`.
- The `cleanup plan` refusal for flows in other states now reads "only failed, abandoned or completed flows can be cleaned up here; stop and abandon the flow first".
- A fetch that loses a race can now take up to about 4 s longer before it reports failure.

## Verification

`tests/cleanup-fetch-race.test.mjs` adds six tests:

- **Race regression (deterministic).** A local bare remote has advanced past a stale `origin/main`. The test holds `refs/remotes/origin/main.lock`, as a concurrent fetch would. A `git` shim on `PATH` releases the lock only after observing that the cleanup's first fetch failed on it. `workspace.release` must succeed, the shim must record exactly one lost fetch, and the worktree and branch must be gone. On the base commit this test fails with `git fetch failed: error: cannot lock ref 'refs/remotes/origin/main': Unable to create '…/main.lock': File exists.`
- Retry bounds: fetch only, ref-lock only, bounded, async and sync variants.
- The operations-loop retry waits for its backoff, then releases and clears `cleanupPending`.
- Three failing retries raise the obligation and notice, with path, branch and command, and stop retrying. `cleanup plan`/`apply` then finish the cleanup, pass the obligation and supersede the notice.
- `cleanup plan` on a completed flow refuses an unproven outcome, live attempts and an ownership mismatch, and archives a dirty workspace.
- The completed-flow notice names the outstanding cleanup.

Not covered by a test: the `operationalTick` call site, which needs delivery mode and GitHub credentials (the function it calls is tested directly), and the engine writing `cleanupFailure` (the tests seed it as the engine records it).

## Independent review fixes

An independent review rejected the first version with two blocking and two non-blocking findings. All four are fixed.

1. **The automatic retry could delete a workspace another flow used (blocking).** It checked only the completed flow's own attempts and proven outcome. Now `cleanup plan` and the retry share one function, `planCleanup`, and the retry calls it after taking the flow's cleanup lock, so it reads the store and the workspace fresh and refuses everything the plan refuses: another active flow or ready plan using the workspace, leases, unsettled attempts, an ownership mismatch, or no proven outcome. A refusal counts as a failed retry, so after the third one the operator gets the obligation with the reason. The retry carries out only a plan in `release` mode. `releaseDeliveredWorkspace` takes an optional `guard`, which runs after the fetch and just before removal. Both the retry and `cleanup apply` (release mode) use it to check again for other users and unsaved ignored files. `release()` itself checks leases and changes again.
2. **Ignored unsaved files were deleted without archiving (blocking).** Plain `git status` was taken as proof the workspace was clean. For a completed flow the plan now also lists ignored files (`git ls-files --others --ignored --exclude-standard`). Any ignored file that does not match the commissioned `cleanup.excludeIgnored` globs, the documented policy for reproducible content, is unsaved work. It makes the plan `mode: "archive"`, reported as `unsavedIgnored`. The automatic retry never archives or deletes: a plan in `archive` mode raises the obligation and notice at once, with text saying that `cleanup plan` archives the unsaved files first, and retries stop (`cleanupRetry.heldForOperator`).
3. **The completion notice kept saying cleanup was outstanding.** `flowNotice` marks a notice that carries the outstanding-cleanup paragraph with `cleanupOutstanding: true`. When the cleanup finishes, by retry or by `cleanup apply`, that notice stays open, but its title loses "(cleanup outstanding)" and the paragraph is replaced by "Cleanup finished: …". Its version is bumped and the event `inbox.updated` is recorded.
4. **Permanent fetch failures were retried, and the comment was wrong.** Only genuine lock contention is retried now: `cannot lock ref '…': is at … but expected …` or `Unable to create '….lock': File exists`. A bare `unable to update local ref` is not enough, because Git prints it for namespace conflicts too. A namespace conflict (`exists; cannot create`, `try running 'git remote prune'`, `cannot process … at the same time`) fails at once, even when the same fetch also lost a lock race. The comment and `docs/operations.md` now say that a fetch is not atomic across refs and may partially update or prune, and that repeating it is safe because a fetch is idempotent. When a `.lock` file is still present after the last attempt, the final error, or the returned stderr for `allowFailure` callers, names the file and says how to check that it is stale and remove it.

Tests: seven new tests in `tests/cleanup-fetch-race.test.mjs`, ported from the reviewer's probes and extended. They cover a successor flow or ready plan referencing the workspace, a flow that appears during the retry's fetch, ignored unsaved files (held by the retry, then archived and restored byte for byte by plan/apply), ignored files covered by `excludeIgnored` (released), the rewritten completion notice, a real namespace conflict (one call, partial update kept), and a real stale lock file (the final error names it). All seven fail on aa3a443 and pass with the fix.

Not covered: a flow that starts using the workspace in the milliseconds between the guard and the worktree removal. The factory creates no such reference in that window, but nothing locks against it.

Re-check of `4667320`: both retry P1s and the fetch fix were confirmed resolved. Remaining items, decided or fixed by root:

- **Normal post-merge cleanup and ignored files.** The operator decided on 2026-11-15 that normal cleanup keeps removing ignored files, which are usually regenerable build output in factory-owned worktrees, but records what was removed. `releaseDeliveredWorkspace` returns `ignoredDeleted {count, paths (first 100, directories collapsed), truncated?}` for ignored paths outside `cleanup.excludeIgnored`. That evidence is kept in the cleanup result and the flow's history. The stricter rule still applies to automatic retries (never remove; escalate) and to `cleanup apply` (archive first). Regression: a stray ignored note is listed and declared build output is not.
- **Notices created by `aa3a443`.** Not applicable: that commit was never released, so no adopter holds such notices.
- **(a) Race between the final check and removal.** Accepted: no supported path lets a flow adopt another flow's worktree.
