# dev.82: protection of managed files, follow-ups (F1 to F3)

Implementation on its own branch from `main` (which includes the install-prefix and builder-protection work recorded in [dev82-install-prefix.md](dev82-install-prefix.md)); not a release. Builders work in factory-prepared worktrees: `workspace.commit` → `workspace.integrate` → `forge.publish` → review and gate → `forge.merge`. They must not change `factotum.lock.json` or the managed `<prefix>/factory/`, `VERSION` and `compatibility.json`, except as the recorded target brings them. Tests are in `tests/install-prefix.test.mjs` (the protection fixtures live there), named "(follow-up F…)".

## F1: publish checked against a recorded integration that could be stale

**Problem.** `forge.publish` compared the candidate with `results.integrate.base`, the target of the last integration, whatever had happened since. In a custom graph: integrate T1 and publish; the target moves to T2 (a second upgrade) and T2 is fetched into the shared repository; the builder merges T2 itself, checks T1's lock and core back out and commits. Publishing without a new integration compared that candidate with T1, found it equal, and pushed it; merging it into T2 would revert the second upgrade. The reference graphs were safe only because `commit` always goes to `integrate`.

**Fix.**

- (a) Run time (`workflows/dispatch.mjs`, `forge.publish`). The workspace `HEAD` must equal `results.integrate.head`, and that integration must not have conflicted. Otherwise: "forge.publish publishes only the candidate the factory has just integrated: HEAD … is not the head of the last non-conflicting integration (…). Integrate the target again before publishing". The upgrade-owned comparison with the recorded target still runs after it.
- (b) Commissioning (`core/catalog.mjs`, `validateDelivery` → `validatePublishIntegration`). Every route into a `forge.publish` step must come from the `integrated` result of a `workspace.integrate` step (its `next` when it has no `resultEdges`, where `next` also carries `conflict`, which (a) then refuses), through input-preserving steps only. "Input-preserving" is the operation contract's or the node's `preserveInput` (review, gate, fast checks, preview, or a trusted command marked `"preserveInput": true`); the engine fails such a step when the candidate changed, so only its pass routes (`resultEdges`, or `next` without them) count, never `onFailure`. Questions and waits do not preserve the input (the operator may change the worktree during a question). The set of clean steps is the greatest fixed point: a preserving step stays clean only if every route into it is clean and it is not the start. A violation names the publish step, the step it can be reached from and the route: "workflow flow can reach forge.publish step publish from polish (next) without the factory's integration directly before it; every route into forge.publish must come from the integrated result of a workspace.integrate step, through input-preserving steps only (review, gate, fast checks, preview or preserveInput)". A graph that starts at publish gets its own message.
- `tests/publication-rounds.test.mjs` now records a real integration (`integrateTarget`) before publishing, and integrates again after the correction commit; publishing the corrected candidate on the old integration is refused.

**Tests.**

- "forge.publish refuses a candidate a builder changed after a stale integration, and a conflicted one (follow-up F1a)": the scenario above through the real `workspace.commit`, `workspace.integrate` and `forge.publish`, with T2 pushed from a second clone and fetched into the shared repository; then a conflicted integration recorded at the current head.
- "commissioning refuses a graph that can reach forge.publish without the integration directly before it (follow-up F1b)". Accepted: `change.standard` and `change.document`, with and without `fastChecks` and `preview`; a typical project graph (prepare → build → commit → integrate → publish → review → gate → decide → merge, `stale` back to integrate, integrate routing with `next` only); `workspace.adopt` → integrate → publish; integrate with `integrated → publish, conflict → question`; integrate → a renamed `fastCheck` → a trusted command with `preserveInput` → publish. Refused, each with the step and route checked: a builder step between integrate and publish; a question; a trusted command without `preserveInput`; `conflict → publish`; an `onFailure` route into publish; commit straight to publish; a graph starting at publish; publish with no integration.
- Existing adopter-shaped graphs: the whole suite passes unchanged apart from the files named here, including `tests/fast-checks.test.mjs`'s project graph that renames the fast check and the build step.

**Fail before.** On the base commit: F1a fails with "The input did not match the regular expression … Input: 'ForgeError: GitHub operation failed (transport)'": the stale candidate passed the owned-file check and was pushed, failing only at the fictional forge. F1b fails with "Missing expected exception: polish (next)" (the builder-between graph was commissioned). `tests/publication-rounds.test.mjs` fails with "Missing expected rejection" (the corrected candidate was published on the old integration).

## F2: a builder could neutralise an upgrade that was not on the target yet

**Problem** (predates the install-prefix branch). An upgrade review branch exists locally, unmerged. A builder merges it, reverts its lock and core and commits. `workspace.commit`, `workspace.integrate` and `forge.publish` all compared only the candidate's tip, which matched the target, so all three accepted it. Once the candidate merged with merge method `merge` or `rebase`, merging the upgrade branch reported "Already up to date" and the target kept the old lock and core.

**Fix** (`core/verified-git.mjs` `ownCommits`, `ownChanges`, `identities`; `workflows/dispatch.mjs` `committedOwnedChanges`, `refuseOwnedChanges`).

- A candidate's own commits are those reachable from it but not from the trusted commit: the recorded target once integrated, the workspace base before. None of them may change an upgrade-owned path. A commit changes a path when its content there differs from every parent's (a root commit: when it has the path at all). So the factory's merge of the target, whose owned content equals the target's (one of its parents), changes nothing, and neither does any commit reachable from the target; the commit that first brought new owned content, and a later one that undid it, both do.
- The split is verified, linear and independent of `rev-list` order. `rev-list head --not <trusted>` proposes the own commits; the walk from the candidate follows verified parents through proposed commits only, and every commit it reaches outside the proposal is a claim that the commit is trusted history. One walk from the trusted commit proves the claims (its proposals stop at the claimed commits for three rounds, so the common case reads only the history between the base and the target). A claim it cannot prove makes that commit, and what it reaches outside the trusted history, the candidate's own. Before refusing, the offending commits are shown outside the trusted history by one more walk, so a proposal that lists trusted commits as the candidate's own cannot refuse the target's own changes. Owned content is compared per root tree with batched, level-by-level tree reads (`identities`), which `committedOwnedChanges` now also uses for its tip comparison (one Git process per tree level instead of one per object).
- Messages: "factotum.lock.json is changed only by adopt install/update, never by a builder: commit …, which is not in the workspace base (or recorded target), changes factotum.lock.json (…); upgrade-owned files reach a candidate only from the target, even when a later commit undoes the change: … Rebuild the candidate without that commit". `policy.allowFactoryEdits` lifts the rule for the core, never for the lock (an upgrade always changes the lock).
- **Behaviour change.** A builder's committed-then-reverted edit of the core, which round 2 of the install-prefix work allowed, is now refused unless `allowFactoryEdits`. Builders do not commit in normal use (the factory commits each round, and the status check refuses an owned change before that), so only hand-made commits are affected. The round-6 B2 scenario (a builder merges a target that carries an upgrade before the first integration and reverts it) is now refused at `workspace.commit`, earlier than before; its test was updated.
- **`upgrade apply --merge`** (`operations/upgrade-apply.mjs`). Before, an upgrade branch already contained in the checkout failed with a misleading message: "the review branch is not a fast-forward of the project checkout", or, after catching up with the remote target (whose rebase drops the contained commits), "the review branch has no commits beyond the checkout". Neither said the upgrade had been undone. It never reported success, because the `verify` step would have caught the old lock, but the operator could not tell what happened. Now the reviewed commit is recorded before the catch-up, and if the checkout contains it, `--merge` stops before stopping anything: with "already merged into the project checkout, which holds X: there is nothing to merge" when the checkout holds the release, and otherwise "the review branch … is already contained in the project checkout, but the checkout does not hold release X (its lock names Y): the upgrade was merged and then undone … Merging the branch again changes nothing". `docs/updates.md` describes both.

**Tests.**

- "a builder cannot neutralise an upgrade branch that is not on the target yet (follow-up F2)": the scenario through the real `workspace.commit`, `workspace.integrate` and `forge.publish` (each refused, naming the upgrade branch's commit); then it shows why: after merging that candidate, `git merge <upgrade branch>` says "Already up to date" and the target keeps the old core.
- "the candidate's own-history check accepts the factory's merges and an upgrade arriving through integration (follow-up F2 normal use)": an ordinary merge of a target that carries an upgrade, a second builder round and re-integration; a conflicted integration resolved by the builder, concluded by `workspace.commit` with both parents, and integrated again.
- "upgrade apply --merge says plainly when the upgrade branch is already contained in the checkout (follow-up F2)": a real 1.0.0 adoption and 1.1.0 review branch; a change merges the branch and restores 1.0.0's lock and core; `mergeUpgrade` refuses with the new message and runs nothing (no `systemctl`, no CLI). A branch already fast-forwarded gets the "nothing to merge" message.
- "the walk and the own-commit split never depend on what rev-list proposes (follow-up F3, F2)": `reaches` and `ownChanges` give the same answers with honest, empty, partial and over-claiming proposals (one that ignores the exclusions and lists the target's history).
- The round-4 conflicted-merge and undo tests, and the round-5 hidden-target tests, still pass.

**Fail before.** The new tests were run against an export of the base commit (`ecacb6c`) with the final test files copied in: 7 follow-up tests, 1 pass (F2 normal use, a regression guard), 6 fail. For F2: the scenario test fails with "Missing expected rejection" at `workspace.commit` (the neutralising candidate was committed); the `upgrade apply` test fails with "The input did not match the regular expression" (the message was "the review branch is not a fast-forward of the project checkout"); the proposal-independence test fails with "touched.ownChanges is not a function". The normal-use test passes there too (it is a regression guard).

## F3: the single proposal could stop early, and the walk then cost one process per generation

**Problem.** `VerifiedObjects.reaches` (round 6) read 64 generations directly, then made exactly one `rev-list` proposal of everything reachable from the frontier, and read whatever the walk reached outside it one generation at a time. With the repository's shallow file ignored, `rev-list` stops with an error at the first missing parent it meets in date order. In the reviewer's shape (a main line with a merge 70 commits below its tip whose second parent is future-dated and has an absent parent) the proposal stopped almost at once and the rest of the main line cost one Git process per commit. The round-6 record's claim that "one proposal, and each commit verified at most once, make the work linear in commits whatever the shape" was wrong: the verification was linear, the process count was not.

**Fix** (`core/verified-git.mjs`). One walker, `walk(starts, { enter, done, exclude })`, serves `reaches`, `ownCommits` and `ownChanges`:

1. The first 64 generations are read directly (one batched read each), as before.
2. After that, whenever the frontier holds commits not yet read, the walk proposes again from exactly those, in batches: `rev-list --stdin` of the unread frontier with `^<oid>` exclusions for already-verified history. The exclusions are the verified commits whose whole ancestry is verified ("closed"), taking only those no other closed commit has as a parent; excluding them cannot hide anything still to be read. The listing is loaded (verified) 4,000 objects per `cat-file` batch.
3. Proposals do not stop at gaps. `rev-list` runs with `--missing=print` (Git 2.44 and later list missing commits instead of stopping), and with `GIT_SHALLOW_FILE` pointing at a file of our own: the commits already verified to have an absent parent, so a known gap never stops a listing. (As first committed, the repository's own shallow file was also added to that list unverified, which let a planted file stop every listing; see review fix B1.) A Git older than 2.44 stops at the first unknown gap and names the commit in its error; that commit and its parents are verified, the commit joins the list, and the next proposal passes it. An option Git does not know (exit 129) makes the walk fall back to plain `rev-list` for the rest of the process.
4. A proposal that brings nothing new pauses proposing (as first committed it ended proposing for the walk; review fixes N1, N2 and round 2's N7 changed that): the walk reads generations directly and proposes again when it verifies a new gap, and in any case after 1, 2, 4, … further generations. Correctness never depends on any of this: every answer comes from verified parents, and a commit that is genuinely absent ends its branch.

**Measurements** (`node evals/history-walk-cost.mjs <shape> <n>`, each in a fresh process with a short `TMPDIR`, this machine; "before" is the same script run against an export of the base commit, which has round 6's `reaches`; the 2ed6f44 column is the reviewer's, given in the review request). The eval now counts the Git processes the walk starts and has the shapes `--linear`, `--absent`, `--quadratic`, `--shallow-two` and an `--old-git` flag (walk as with a Git older than 2.44). All are ancestry refusals: the target is not in the history, so everything is walked.

| Shape | Commits | 2ed6f44 (reviewer) | Before (base commit) | After | Git processes before → after |
|---|---|---|---|---|---|
| Linear | 20,001 | | 695 ms | 429 ms | 70 → 71 |
| Absent-parent shape | 2,002 | 0.40 s | 6.8 s (reviewer: 4.2 s) | 210 ms | 1,997 → 67 |
| Absent-parent shape | 20,002 | 0.64 s | 60.5 s (reviewer: 40.3 s) | 425 ms | 19,997 → 71 |
| Quadratic: 20,000-commit future-dated chain, 1,000 merges | 21,001 | | 422 ms | 597 ms | 71 → 72 |
| Quadratic: 20,000-commit future-dated chain, 5,000 merges | 25,001 | | 478 ms | 627 ms | 72 → 73 |
| One-line shallow clone, depth 2,000 | 2,000 | | 215 ms | 250 ms | 68 → 70 |
| Two-line shallow clone, depth 2,000 (one line older) | 3,999 | 13.7 s | 6.2 s (reviewer: 6.1 s) | 284 ms | 2,003 → 70 |
| Two-line shallow clone, depth 20,000 (one line older) | 39,999 | | 90.5 s | 809 ms | 20,007 → 79 |
| `--merges 1000 25` (round 6's shape) | 26,001 | | | 571 ms | 73 |
| Absent-parent, 20,002, as an older Git | 20,002 | | | 511 ms | 75 |
| Two-line shallow, depth 2,000, as an older Git | 3,999 | | | 282 ms | 70 |
| Two-line shallow, depth 20,000, as an older Git | 39,999 | | | 726 ms | 79 |
| Quadratic, 5,000 merges, as an older Git | 25,001 | | | 497 ms | 73 |

Peak memory after: 66–145 MB (two-line shallow at 20,000 is the largest). Sixty-four of the processes are the direct generations of step 1; the rest are one or two proposals, the batched reads of what they list, and a `rev-parse` for the shallow file. Timings vary by about ±20% between runs on this machine (the quadratic and shallow rows are slightly slower after because of the second, exclusion-aware proposal machinery and the shallow-file lookup; the process count, not the time, is what had grown with the shape). My first two-line construction (both lines with the same dates) did not reproduce the reviewer's 6.1 s on the base commit (230 ms, 68 processes): `rev-list` met both boundaries last. Making one line older than the other, so the listing meets the newer line's boundary first and stops, reproduced it, and the eval and test now use that shape.

While measuring, the older-Git fallback was still unbounded in the two-line shallow clone (2,005 processes): with `^` exclusions, an older `rev-list` fails while marking them ("revision walk setup failed") and names no commit. Two changes fixed it (the older-Git rows above are after them): the repository's own shallow boundary seeds the gap list (as a hint only; commits verified to have every parent are dropped from it), and a failed listing that named nothing is retried once without exclusions.

**Tests.** "the verified ancestry walk costs a bounded number of Git processes for every history shape (follow-up F3)" counts the Git processes `reaches` starts (through a counting `git` first on `PATH`) and requires at most 100 for: a linear history of 3,000 commits; the absent-parent shape at 3,000 (also as an older Git, and with a target 2,500 commits down that is found); the quadratic shape (a 3,000-commit future-dated chain and 300 merges); a real two-line shallow clone at depth 1,000 whose older line's boundary is listed last (also as an older Git, and a target inside the clone that is found). "the walk and the own-commit split never depend on what rev-list proposes" is listed under F2.

**Fail before.** On the base commit the process test fails at the absent-parent shape: "absent parent: 2997 Git processes" (the linear shape before it passes).

## Results

- `npm test` (short `TMPDIR`): 964 tests, 964 pass, 0 fail, 0 skipped. The base commit has 957; the 7 new tests are in `tests/install-prefix.test.mjs` (now 41 tests). Changed existing tests: `tests/publication-rounds.test.mjs` (records a real integration, integrates again after the correction); in `tests/install-prefix.test.mjs`, round 2's committed-then-reverted core edit is now refused (and allowed under `allowFactoryEdits`), round 6's B2 test expects the refusal at `workspace.commit` and passes the integrated head to `forge.publish`.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Limits

- Whenever an own commit changes an owned path, the check walks the whole trusted history once more to show that commit is not in it (linear). That happens on every refusal, and also on candidates that are accepted under `policy.allowFactoryEdits` because an own commit edits only the core (review fix N6).
- Gaps that stop a listing make the walk linear in their number. A gap is an absent parent the walk meets first in a listing on a Git older than 2.44, or, on any Git, an unreadable object stored under a parent's ID. Each costs a few Git processes: the stopped listing (and its retry without exclusions), the generations read directly until the walk reaches and verifies the gap or its backoff runs out, and the next proposal. Measured on 20,000 commits with evenly spaced unreadable gaps: 10 gaps cost 128 processes, 100 cost 668, and 1,000 cost 6,063 (30 s). That is about six per gap, and never more than about one per generation read. (An earlier version of this limit said "at most one more proposal" per gap; the reviewer measured about five processes per gap.) Only a builder that writes absent or garbage objects can make many gaps, which is accepted. As first committed, one such gap ended proposing for the whole walk, so the walk fell back to one Git process per generation (review fixes N1 and N2, and N7 in round 2).
- An own commit whose parent cannot be read (absent) is refused as uncheckable rather than compared.
- `forge.publish` requires the head of the last non-conflicting integration; a project graph that published after a step that changes the candidate now fails commissioning and must integrate again before publishing.

## Review fixes

A Fable 5.2 re-check of `4a7d4f5` approved F1 and F2 against every variant it tried (octopus merges, `-s ours`, evil merges, renames away and back, case variants, adopted PRs, seven planted shallow files on both Git paths, every legitimate path), found the `preserveInput` bypass impossible and reproduced F3's numbers exactly. It asked for two blocking and seven non-blocking fixes. `main` (R5 external PR adoption, R6 console fixes and the idle-history fix) was merged first, as `af7775a`; nothing conflicted.

### B1 (blocking): a builder-written shallow file cost about three Git processes per commit

**Cause.** Late in F3 (to bound the older-Git two-line shallow clone) `propose` added every commit of the repository's own shallow file to the gap list it gives `rev-list`, unverified. A planted file that names every commit therefore made each listing stop at the next commit, and the walk proposed once per commit: 8,875 processes and 32 s at 3,000 commits (the reviewer's figures reproduced exactly).

**Fix.** The hint is verified before use: the first proposal of a walker reads the shallow file's commits and their parents in two batched reads, and only commits with a parent that is really absent become gaps. A planted file naming present commits adds nothing; a real clone's boundary is still known from the start, on any Git.

### B2 (blocking at merge): main's R5 test fixture had no integrated head

`tests/external-pr-adoption.test.mjs`'s `publishFixture` recorded `results.integrate` as `{ base, route }`. It now also records `head` (the workspace HEAD after the outside commit) and `conflicts: false`, as a real integration does. With it, all 25 tests in that file pass.

### N1: an unreadable object at a gap ended proposing for good

A garbage loose object stored under an absent parent's ID reads as missing in `cat-file`, but `rev-list` stops at it without naming a commit. The listing then brought nothing new and the walk stopped proposing permanently. Now a proposal that brings nothing only pauses proposing; the walk resumes as soon as it verifies a new gap (here, the garbage ID read as absent), with that gap in the list.

### N2: an absent ID as a proposal start

On an older Git, an absent parent 63 commits below the head was in the frontier when proposing began, and `rev-list` refused it as a start ("bad object"), so proposing ended. The walk now reads the frontier first and proposes only from commits it has read and verified whose parents are not all read yet; an absent ID is never a start. The limit's wording above is corrected.

### N3: a real shallow clone can refuse falsely

A candidate (for example an adopted pull request) that forked from the target below a real clone's boundary cannot be shown to share that history with the target, so the target's older commits count as its own, and one that changed the lock or core refuses it. The refusal now says so when the repository has a shallow boundary and suggests `git fetch --unshallow`, and `docs/updates.md` (Shallow clones) documents it.

### N4: a drifted checkout that holds the release

`upgrade apply --merge` on a branch already merged, where installed files differ from that release's lock (as after a failed `verify`), said "does not hold release 1.1.0 (its lock names 1.1.0): the upgrade was merged and then undone". It now says "already merged into the project checkout, which holds 1.1.0, but its installed files differ from the lock (verify failed): <paths>", with the recovery from `docs/updates.md` (whose `verify` paragraph now quotes this message).

### N5: one head for the check and the push

`forge.publish` read HEAD for the checks and the workspace adapter read it again to push. The push now passes `expectedHead` (the checked head), and the adapter refuses a different one.

### N6: record wording

The limit on the extra trusted-history walk now says it also runs on accepted candidates under `allowFactoryEdits` whenever an own commit edits the core.

### Adopted flows: the remedy

A refusal for a commit that came from an adopted pull request no longer says "rebuild the candidate": it says the factory delivers an adopted pull request's commits unchanged, so its contributor must squash or rebase that commit away (or drop the change), and the pull request is then adopted again. Whether the commit came from the pull request is decided by verified ancestry from the adopted head (the workspace base). Refusing at `workspace.adopt` instead was not straightforward: the only trusted commit available there is the pull request's recorded base SHA, and checking against it would refuse a pull request whose contributor merged a newer target that carries an upgrade; checking against the current target would need `workspace.adopt` to fetch it, which `workspace.integrate` does next anyway. The refusal therefore stays at integration (and publish).

### Tests

- The F3 process test gains the shapes: an absent parent 64 generations down (current and older Git), an absent parent stored as a garbage object (both), and a shallow file naming every commit (both, plus a target 2,900 commits down that is found). Each needs at most 100 Git processes.
- The F2 `upgrade apply` test adds the drifted case (N4).
- New: "an adopted pull request that carries an undone upgrade is refused with the contributor remedy, and a shallow clone suggests --unshallow (review fixes (b), N3)".

**Fail before** (the final tests against an export of `4a7d4f5`): the F3 process test fails at "absent parent 64 generations down, Git without --missing=print for commits: 2967 Git processes" (the current-Git variant before it passes; the later shapes are measured below instead); the `upgrade apply` test fails at the drifted case with the old "does not hold release 1.1.0 (its lock names 1.1.0): the upgrade was merged and then undone"; the adopted-flow test fails because the refusal said "Rebuild the candidate without that commit". The F2 scenario test passes there (unchanged). B2 is the merge fixture; N5 is a pinning change with no deterministic race to test (the adapter's `expectedHead` refusal is existing, tested behaviour).

**Measurements** (`evals/history-walk-cost.mjs`, which gains `--shallow-all`, `--garbage` and `--absent-near`):

| Shape | Commits | `4a7d4f5` | After | Git processes before → after |
|---|---|---|---|---|
| A shallow file naming every commit (B1) | 3,001 | 32.0 s (reviewer: 33 s) | 224 ms | 8,875 → 68 |
| A shallow file naming every commit (B1) | 6,001 | 84.4 s (reviewer: 84 s) | 276 ms | 17,875 → 69 |
| The same, as an older Git | 6,001 | | 263 ms | 69 |
| Absent parent stored as a garbage object (N1) | 3,002 | 8.2 s | 238 ms | 3,000 → 73 |
| Absent parent 64 generations down, as an older Git (N2) | 3,065 | 8.7 s | 220 ms | 3,067 → 68 |
| Absent parent 64 generations down, current Git | 3,065 | 231 ms | 231 ms | 67 → 68 |
| Absent-parent shape (F3) | 20,002 | | 425 ms | 72 |
| Two-line shallow clone, depth 20,000 (F3) | 39,999 | | 630 ms | 79 |
| The same, as an older Git | 39,999 | | 635 ms | 79 |
| Quadratic, 5,000 merges (F3) | 25,001 | | 473 ms | 74 |

### Results after the review fixes

- `npm test` (short `TMPDIR`, after merging `main`): 1,022 tests, 1,022 pass, 0 fail, 0 skipped. `tests/install-prefix.test.mjs` has 42 tests (1 added in the review fixes; the F3 and F2 `upgrade apply` tests were extended).
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Review fixes, round 2

A Fable 5.2 re-check of `4904e51` approved it with fixes. B1, B2, N2, N3, N5, N6 and (b) held; the merge with `main` was faithful; F1 and F2 refused seven neutralising variants; the suite passed 1,022 of 1,022. `main` has not moved since, so nothing was merged.

### B3 (blocking): an honest stale flow cost one Git process per commit the target had moved

**Cause** (present since `4a7d4f5`). `ownCommits` proves that each commit the candidate's side claims as trusted is reachable from the trusted tip, with a walk from that tip whose proposals exclude the claimed commits (so they list only the history between the tip and the claims). The trusted tip is itself claimed: it is a parent of the factory's merge. So every proposal was `<frontier> ^<target> …`, which lists nothing; the walk paused and read one generation per process down to the fork point. A flow more than 64 commits behind the target at integration (a stale flow, a stale adopted pull request) paid one process per commit of difference, at integrate, at each later commit (twice) and at publish.

**Fix.** The trusted walk excludes only the claims it has not reached yet, never a trusted tip (`exclude(round, seen)` now receives the IDs reached). In addition, `workspace.commit` shares one verified reader between its check before and after the factory's commit (its cache holds hash-verified objects only, keyed by ID), so the second check reads almost nothing again.

**Measurements.** `evals/history-walk-cost.mjs --behind <n>` times `ownChanges` of a factory merge whose target is n commits ahead of the fork point; `--behind-absent` adds a future-dated side commit with an absent parent merged into the target 70 commits below its tip (N7's second shape). The new test drives the real dispatch path.

| Shape | `4904e51` | After |
|---|---|---|
| `ownChanges`, 500 behind | 505 processes, 1.4 s | 71, 257 ms |
| `ownChanges`, 10,000 behind | 10,005 processes, 38.2 s | 73, 461 ms |
| `ownChanges`, 3,000 behind with an absent side parent, older Git | 3,006, 8.3 s | 75, 263 ms |
| The same, current Git | 3,006, 8.4 s | 71, 238 ms |
| Real dispatch, 600 behind: `workspace.commit` (before integration) | 37 | 35 |
| `workspace.integrate` | 628 | 93 |
| next `workspace.commit` (two checks) | 1,251 | 109 |
| re-integration | 629 | 94 |
| `forge.publish` | 628 | 93 |

The dispatch counts include the workspace adapter's own Git calls (status, fetch, merge, push). While building the eval I found that a base commit dated after the target's commits (clock skew) makes `rev-list head --not target` list the base as the candidate's own. That over-claim is handled (a listed commit is only refused after the trusted walk shows it outside the trusted history), but it hid B3, so the eval now dates its base before everything else.

### N7: fruitless proposals could still pause for good

(1) One unreadable object named as a parent by two commits, one near the head and one a merge 70 below it: the gap was counted when the first was read, before proposing paused, so the "new gap" trigger never fired (3,071 processes at 3,000 commits, both Git paths). (2) The `--behind-absent` shape above on an older Git. A fruitless proposal now also retries after 1, 2, 4, … further generations (the backoff resets after a fruitful one), besides on a newly verified gap. Shared unreadable parent: 3,002 → 75 processes (both Git paths, eval) and 3,071 → within the test's 100 (test); (2): 3,006 → 75.

### N8: the shallow hint had no limits

A shallow file of 1,000,000 absent IDs cost every check 302 processes and 6.7 s, and one naming large blobs read them in full (the reviewer saw checks fail at 2.1 GB). The hint is now ignored when the file is larger than 660,000 bytes (`SHALLOW_HINT_BYTES`) or names more than 10,000 distinct IDs (`SHALLOW_HINT_LIMIT`); otherwise its IDs are typed with one `cat-file --batch-check` (type and size, never content), and only commits are read, with their parents. It is only a hint, so ignoring it never changes an answer.

### N9: record wording

Step 4 of F3 and the gap limit above now describe the pause and backoff and give the measured per-gap cost (about six processes per unreadable gap, linear in gaps).

### Pre-existing, not fixed here

In a real shallow clone, a pull request that forked below the clone's boundary and has not merged the target makes `workspace.integrate` return route `conflict` with no conflicted paths and no hint (reported by the reviewer; not reproduced or diagnosed here). The operator sees a conflict question with nothing to resolve; `git fetch --unshallow` is the remedy, as for N3.

### Tests

- The F3 process test gains the shared unreadable parent (both Git paths).
- New: "the own-commit split and the dispatch path of a flow far behind its target cost a bounded number of Git processes (review fixes B3, N7)": `ownChanges` of the factory's merge with a target 600 commits ahead (both Git paths, at most 100 processes), the same with an absent-parent side commit in the target (both), and the real `workspace.commit`, `workspace.integrate`, `workspace.commit`, `workspace.integrate` and `forge.publish` for a flow 600 behind (at most 150 processes each, including the adapter's; publish passes its checks and pushes the integrated head, and only the fictional forge fails).
- New: "the shallow-file hint is bounded in size and entries and reads only commits (review fix N8)": 200,000 absent IDs and 10,001 absent IDs are ignored without reading any; three 8 MiB blobs in the hint are never read, while a real commit in it is.

**Fail before** (these tests against an export of `4904e51`): the F3 test fails with "one unreadable parent shared by two commits: 3071 Git processes"; the B3 test with "600 behind, current Git: 607 Git processes" (with its `ownChanges` bounds relaxed, the dispatch counts were 37, 628, 1,251, 629 and 628); the N8 test with "200,000 absent IDs: 118 Git processes".

### Results after round 2

- `npm test` (short `TMPDIR`): 1,024 tests, 1,024 pass, 0 fail, 0 skipped (2 new; the F3 test was extended).
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Round-3 re-check and root fix

Re-check (Fable 5.2) of `d928314`: **approve**. B3 held through real dispatch at 3,000 behind (93–111 processes per step, a stale adopted PR 93–109); N7 and N8 held; 4,864 `reaches` and 2,432 `ownChanges` checks matched a brute-force verified walk; F1 and F2 refused eight neutralising variants; 1,024/1,024. Four non-blocking findings:

- **N13 (fixed by root).** The byte limit did not apply to non-regular files: a shallow file that is a FIFO hung the check, and a link to `/dev/zero` read until allocation failed. Both shallow readers (`shallowHint` and `shallowBoundary`) now share `readShallowFile`, which opens the file with `O_NOFOLLOW | O_NONBLOCK`, requires a regular file and reads at most `SHALLOW_HINT_BYTES`. The hint ignores anything else; the boundary read refuses it (fail closed). Test: "a shallow file that is a FIFO or a link to a device neither hangs nor floods a check" (on the previous code the FIFO case blocks indefinitely, so it was not run there).
- **N10 (accepted, follow-up).** One unreadable object under a future-dated side chain merged by every later commit costs one process per generation (3,018 at 3,000 commits; 5.5 s through `workspace.commit` at 1,500), then refuses. The earlier "linear in their number" statement for unreadable gaps is wrong for this shape. Accepted: the cost falls only on the hostile flow, each action is killed at its step timeout, and the candidate is refused. Follow-up: refuse as soon as a listing dies on a corrupt object (`rev-list` names it).
- **N11 (accepted, follow-up).** With unreadable parents in trusted history, `ownChanges` can refuse (throw) before applying the trusted-history filter, with a shared or fresh reader. Fail closed; follow-up: apply the trusted filter before failing. The "hash-verified objects only" wording omits the gap list and cached absences.
- **N12 (accepted, follow-up).** On Git older than 2.44, a commit Git cannot parse (tree line not first) costs about three processes per generation, because the parser here accepts what Git rejects. Follow-up: parse as strictly as Git and fail closed.
