# dev.83: pull request adoption and first-adoption fixes from the dev.82 re-test

The dev.82 re-test adopted outside pull requests (report R8) and installed dev.82 under a prefix into a private copy of a large existing repository, with its own tree-wide checks, to run a model-free rehearsal there (report R11). This records, for each finding, the problem, the change, compatibility and tests. It is a local implementation record, not a release or live qualification claim. No real GitHub call was made: adoption tests use a real Git remote with a fake forge or a fake `gh` executable.

Fail-before evidence was taken by running the new test files against an export of base `159d54c` (`git archive`), with only the test files copied in. All 19 new tests fail there; each failure is quoted below.

## G6: a wrong candidate failed the flow with a generic notice

**Problem.** `flow.start` with a `candidate` whose head (or base) did not match the pull request was admitted and failed at `candidate` with "approved PR candidate or target changed" in the attempt only. The notice said "Change workflow failed; inspect retained attempt evidence".

**Fix.**

- `adoptCandidate` (workspace adapter) collects every mismatch before creating anything: the pull request's state (`open`, not `draft` or `merged`), the branch it targets, its head (and the head fetched from `refs/pull/<n>/head`), and the base (G8). Each row is `{field, expected, found, fix}`. On any mismatch it throws `AdoptionMismatch` (message still starts "approved PR candidate or target changed", so existing callers and tests that match it are unchanged), carrying the rows on `error.adoptionMismatch`.
- The `workspace.adopt` step catches it and returns `candidateMismatchHold` (`workflows/adoption.mjs`): `route: "held"`, `adoptionHold: {kind: "candidate-mismatch", number, head, mismatches: [{field, expected, found}]}`. The engine treats `candidate-mismatch` like the existing `closing-reference` and `commit-limit` holds: the flow stops at `candidate` (not failed), records `flow.adoption-held`, and the stop notice reads, for example: "Adopted pull request #1 (…) does not match the approved candidate {number 1, head eeeeeeeeeeee, base 1a2b3c4d5e6f}. head: approved eeee…, found 3c4d…. Fix: the pull request moved after it was approved; review head 3c4d…, then abandon this flow (flow.abandon) and start a new one (flow.start) with candidate.head 3c4d…. Nothing was integrated, published or reviewed. candidate.head is the pull request's head commit (gh pr view 1 --json headRefOid); candidate.base is a commit on the target branch …".
- Because it is a hold, a transient mismatch (a draft marked ready, a head GitHub had not yet updated) can be resumed; the rest need `flow.abandon` and a new `flow.start`, as the fix text says.
- `flow.start`'s command help now says what `head` and `base` are.

**Compatibility.** No schema, configuration or protocol change. `adoptionHold.kind` gains one value; `adoptionHold` was already a privileged field of `workspace.adopt` only. A flow that would have failed now stops; `flow.abandon` ends it as before. `adoptionCommitCheck` now also returns the PR's `url` when the head moved, so the notice can link it.

**Tests** (`tests/pr-adoption-candidate.test.mjs`).

- "G6: each mismatching field is named with what was approved and what was found": a draft PR targeting `release` with a different head gives exactly the `head`, `state` and `target` rows, each with expected, found and fix. Before: `TypeError: Cannot read properties of undefined (reading 'mismatches')`.
- "G6: the candidate step holds a mismatching candidate with a specific reason instead of failing" (dispatch through a fake `gh`): `route: "held"`, `kind: "candidate-mismatch"`, no workspace, the reason names expected and found heads and the fix; the same intent with the right head is adopted. Before: `Error: approved PR candidate or target changed`.
- "G6: a candidate-mismatch hold stops the flow at candidate and its notice says what to fix" (engine settlement): flow `stopped` at `candidate`, notice context carries the row, not "inspect retained attempt evidence"; `flow.adoption-held` recorded. Before: `TypeError: adoption.candidateMismatchHold is not a function`.

## G8: `candidate.base` had to equal GitHub's current `base.sha`

**Problem.** After the outside author force-pushed, `gh pr view --json baseRefOid` returned the old base for a few seconds and then the target's current head. A `flow.start` with the first value failed the flow (G6). The docs did not say which commit `base` is.

**Decision.** `base` is the target commit the operator approved the pull request against, and it is verified with Git, not against GitHub's cached field: after fetching the target branch from the configured remote (into `refs/factotum/adoption-targets/<key>`), `base` must be the target's current head or one of its ancestors. (The first version checked this with `git merge-base --is-ancestor`, which replace refs can fool; since the review it is proven through hash-verified parents, see [review fixes](#p2-blocking-g8s-ancestry-check-could-be-forged-with-replace-refs).) GitHub's reported `base.sha` is kept for the record (`originalPR.base`, next to `approvedBase` and `targetHead`) but no longer compared.

Why this rule and not a retry: an older `base` is harmless, because the flow integrates the current target and reviews and gates the integrated result anyway; what matters is that the approval was made against this target's history, not another branch's or a history the target has since lost. Git answers that exactly and at once. A retry with a short wait would still depend on GitHub's refresh timing (it was seconds in the report, with no bound), would delay every adoption on the unlucky path, and would still refuse a perfectly good older base after a later push to the target.

**Compatibility.** Strictly more permissive for valid approvals: every `base` dev.82 accepted (GitHub's current `base.sha`, which is on the target) is still accepted, unless the target was force-pushed so that it is no longer in its history, which is now refused with a reason. One extra `git fetch` of the target per adoption, into a private ref in the project checkout (the adopted head was already fetched the same way).

**Tests** (`tests/pr-adoption-candidate.test.mjs`, the report's scenario with a real remote).

- "an approved base older than GitHub's current base is accepted when it is on the target": the target moves after approval and GitHub reports the new tip; the old base is adopted. Before: `Error: approved PR candidate or target changed`.
- "after a force-push GitHub's lagging base does not refuse the current target head": the author amends and force-pushes, the operator passes the target's current head while GitHub still reports the old base; adopted. Before: `Error: approved PR candidate or target changed`.
- "a base that is not in the target's history is refused, naming the target head": the row says where the target is, that the base is not in its history, what GitHub reports, and suggests `git ls-remote origin refs/heads/main`; no worktree is created. Before: `TypeError: Cannot read properties of undefined (reading 'mismatches')` (refused, but without saying why).
- The existing "explicit PR adoption copies approved candidate…" test still refuses an unknown base with `/candidate or target changed/`.

## G7: the closing-keyword notice always suggested "Refs #11"

**Problem.** The notice for pull request #32 and issue #28 suggested rewording "with a plain reference (for example "Refs #11")". The number was fixed text.

**Fix.** `plainReference(keyword)` replaces the closing verb of the keyword actually found with `Refs` (`Fixes #28` → `Refs #28`, `closes owner/repo#7` → `Refs owner/repo#7`, URL and Markdown-link forms alike). The notice lists up to three distinct keywords as `"Refs #28" instead of "Fixes #28"`.

**Compatibility.** Text only.

**Test.** "G7: the closing-keyword notice suggests a plain reference to the issue actually found": no `#11`; both suggestions present. Before: `The input was expected to not match the regular expression /#11/`.

## G17: the shipped rehearsal template could not pass `init`

**Problem.** `project/workflow.template.json` declared `"evidence": "review"` and `"evidence": "gate"` on trusted `argv` steps and required them in its question. Trusted commands may only record namespaced observations, so `init --workflow` refused the template even with its three `CONFIGURE_…` placeholders replaced: "trusted command review cannot claim kernel evidence, decisions or result bindings".

**Fix.** The template's steps record `rehearsal:review` and `rehearsal:gate`, and its question requires those. The validation rule is unchanged. `docs/running.md` says so.

**Compatibility.** A project that already copied the template and renamed the evidence itself is unaffected; the template is project-owned and seeded only at installation, so existing copies are not overwritten.

**Tests** (`tests/rehearsal-diagnostics.test.mjs`).

- "G17: the shipped workflow template passes init once its commands are replaced (repository root)" and "(tools/factotum)": the starter is copied to the repository root and under a prefix, the copied template is filled the way the report did (`sed 's/"CONFIGURE_[A-Z_]*"/"true"/'`), and the copied CLI's `init` exits 0. Before: exit 1, "trusted command review cannot claim kernel evidence, decisions or result bindings".
- "G17: the filled template rehearses to its decision question with both observations recorded": a flow on the filled template reaches `decision` with evidence `rehearsal:gate` and `rehearsal:review`. Before: the same refusal from `initProject`.

## G18 (docs): the adopter's own tree-wide checks scanned the installed files

**Problem.** An installation adds about 150 files. On a repository with tree-wide guards, the first check run after the installation merged failed only on files under the install prefix. The adoption guide did not mention it.

**Fix.** `docs/adoption.md` has a new section, "Keep project-wide tooling off the installed files": exclude the install prefix (or, for a root installation, `factory/`, `project/`, `VERSION`, `compatibility.json`) and `factotum.lock.json` from linters, formatters, type checkers, test discovery and scanners on the installation branch before it merges; never edit managed files to satisfy a local rule (drift, refused by doctor); run the tree-wide checks on each update branch too. A table gives the exclusion for ESLint (flat and legacy), Prettier, TypeScript, Jest and Vitest, Ruff, Black and flake8, pytest, markdownlint, codespell, pre-commit and other scanners. It notes that from dev.83 the core declares and calls no React-hook-like `use<Capital>` functions (the existing `no-hook-like-names` test enforces it), which React's rules-of-hooks lint rule reported in earlier releases. `project/SETUP_CHECKLIST.md` has a matching item that links to the section. No project is named.

**Compatibility.** Documentation only.

**Test.** "G18: the adoption guide says to exclude the installation from project-wide tooling, with examples" (`tests/adoption-tooling-docs.test.mjs`): the section, the table rows, the drift warning, the hook-name note and the checklist link. Before: "section present before the core agent policy paragraph".

## G19: a failed trusted command gave no reason outside the state directory

**Problem.** In a rehearsal, `status --flow` showed the failed attempt with `reason: null` and the notice said only "failed"; the explanation was in `<state>/attempts/<id>/stdout.log`.

**Fix.** When a trusted command (a step with `argv` and no action) settles as failed and was not aborted, the engine records `attempt.failure` (`core/command-failure.mjs`): `exitCode`, `signal`, `ending` (the supervisor's reason), a `summary` ("the command exited with code 3", "was stopped after its timeout", "could not start (…)", …) and `stderr` and `stdout` excerpts. Each excerpt is read from at most the last 8 KiB of the log, without following symlinks, keeps the last 12 lines and at most 1,200 characters, has terminal control sequences stripped (`stripControls`) and credential-like text replaced (`redactSecretText`). The summary becomes the attempt's `reason` when it has none. The flow's failure notice carries "Step <step> (attempt <id>): <summary>." and both excerpts; a change flow's stop reason does the same instead of "inspect retained attempt evidence". `status --flow` lists `reason` and `failure` on each attempt, and the console's attempt panel shows "Why the command failed" with the excerpts.

**Compatibility.** Additive fields on attempts settled from now on; earlier attempts are shown as before. Action steps are unchanged (they already carry their own reasons and check diagnostics). Notice IDs include the reason, so a failed rehearsal's notice ID differs from what dev.82 would have produced for the same flow; nothing looks notices up by that ID across releases.

**Tests** (`tests/rehearsal-diagnostics.test.mjs`, `tests/command-failure-view.test.mjs`).

- "G19: a failed trusted command records how it ended and its last output, in the notice and the flow view": exit code 3, stdout and stderr excerpts, an ANSI sequence stripped and a token-shaped string redacted; the notice and `stateView(…, {flow})` carry them. Before: `Expected values to be strictly equal: actual: undefined` (no reason).
- "G19: the excerpt is bounded to the last lines and characters of each log": 5,000 lines of stderr give at most 12 lines and 1,200 characters ending at the last line. Before: `Cannot read properties of undefined (reading 'stderr')`.
- "G19: the console attempt panel shows the command failure". Before: `commandFailureView is not a function`.

## G20: "attempt requires reconciliation before resume" was unexplained

**Problem.** After `stop` on a flow whose step was still running, `resume` was refused with that phrase until the step's process ended; then the same `resume` worked. The phrase was in no document, and "reconciliation" suggested the operator had to run something.

**Fix.** `resume` builds the refusal from the attempt (`core/unsettled-attempt.mjs`; `core/project.mjs` changes by one line): "attempt <id> (step <step>) of flow <flow> has not settled, so the flow cannot resume yet:", then one of

- "its process is still running (stop does not end a running step unless it is given abort: true). Nothing needs reconciling: resume again when the step has finished, and its result is used without running it again. To end it now, stop the flow with abort: true, then resume."
- "its process has finished, but the project runner has not recorded the result yet. Nothing needs reconciling: resume again in a moment …"
- "its outcome is uncertain (<reason>). Inspect <state>/attempts/<id> and any external effect, then settle it: …", with the exact `attempt.resolve` command (the attempt's id, the project's CLI path and state directory) and, for forge publish, merge and close and integration steps, the `reconcile` command.

`docs/running.md` explains the three cases under the refusal's own words.

**Compatibility.** Message text only; the condition is unchanged. Nothing matched the old text.

**Tests** (`tests/rehearsal-diagnostics.test.mjs`).

- "G20: resume refused while the stopped step still runs names the attempt and says to resume again, then works". Before: the message was `'attempt requires reconciliation before resume'`.
- "G20: resume refused on an uncertain attempt gives the exact command to settle it" (and the running guide's entry). Before: the same old message.

## G21: a missing option value printed a stack trace

**Problem.** `status --state <dir> --inbox` (no id) ended in `TypeError [ERR_PARSE_ARGS_INVALID_OPTION_VALUE]` with a Node stack trace.

**Fix.** The CLI's one shared `parseArgs` call (all subcommands use it) is wrapped: a parse error prints `factotum <command>: <option> needs a value` (or `unknown option --x`, `--x takes no value`, or, when the next word starts with `-`, a hint to write `--x=<value>`), then the subcommand's usage line and `Run <command> --help for the options.`, and exits 2. Numeric options are checked before anything runs: `--port` (0–65535), `--issue` (a positive whole number) and `--max-wait-hours` (0–8760); dev.82 turned an invalid value into `NaN`. The starter's triage example (`project/integrations/triage.example.mjs`), the other shipped command line with options, now refuses an option without a value instead of reading it as undefined.

**Compatibility.** Exit code 2 for usage errors (previously 1 with a stack trace, or a later failure for a bad number). Valid command lines are unchanged.

**Tests** (`tests/rehearsal-diagnostics.test.mjs`).

- "G21: a missing, ambiguous or invalid option value is a usage error without a stack trace": eight command lines (missing value, ambiguous value, unknown option, value on a boolean, `--port abc`, `--max-wait-hours soon`, `--issue 0`, `adopt install --root`) each exit 2 with the expected first line and usage, and no stack, `TypeError` or `ERR_PARSE_ARGS`. Before: the first case exited 1 with the stack trace.
- "G21: the triage example refuses a missing option value with a message". Before: exit 0.

## G1: an older CLI refused by the write fence printed a raw SQLite error

**Problem.** A dev.81 CLI writing to a state that dev.82 converted printed only "no such function: factotum_attempt_intent_layout". The fence worked; the operator was not told why or what to do.

**Finding.** The fence's own `RAISE` text cannot reach an older CLI. SQLite resolves every function a trigger uses when it prepares the write that fires the trigger, so a connection that has not registered `factotum_attempt_intent_layout` fails with "no such function" before any trigger runs, even when the call sits behind a condition that is false (tested). The function name is the only text an older release would print, and it could be made readable (a quoted identifier such as `"state converted by Factotum ≥ dev.82; run layout inline with that release"()` is a valid call; checked by hand with `node:sqlite`, not in the test suite), but dev.82 registers only the current name and reads and writes this layout: a renamed function would refuse dev.82's writes, and the changed trigger text would make dev.82 treat the database as unfenced and read attempts without their intents. Rolling back from dev.83 to dev.82 must keep working, so the trigger and function are unchanged.

**Fix (docs).** `docs/running.md` has an entry under the exact message: what it means (a release before dev.82 writing to a state dev.82 or later converted), that nothing was written and reads still work, what to do (use the newer CLI, or run `layout inline` with it before going back), and why the message cannot be clearer.

**Compatibility.** None; no code change.

**Test.** "G1: an earlier runtime writing to a fenced state gets the message the running guide explains" (`tests/layout-fence-message.test.mjs`): a connection without the function can read but every write fails with exactly that message, including behind a false condition, and the running guide explains it under that text. Before: the guide entry was missing ("The input did not match the regular expression …"). The SQLite assertions pass on base too; they guard the reasoning above.

## Adopter notes

- **A workflow copied from the template before dev.83 is not repaired by the update.** Templates under `project/` are project-owned and are seeded only at installation, so an update does not change a copy already made. If a project copied `project/workflow.template.json` and `init --workflow` refused it ("trusted command review cannot claim kernel evidence, decisions or result bindings"), edit the copy by hand: change `"evidence": "review"` to `"evidence": "rehearsal:review"` and `"evidence": "gate"` to `"evidence": "rehearsal:gate"`, and the question's `"requireEvidence": ["review", "gate"]` to `["rehearsal:review", "rehearsal:gate"]`. Any namespaced names work if they match.
- **`candidate.base`** is any commit on the target the pull request was approved against (G8); a project checkout with replace refs or a grafts file can no longer adopt pull requests until they are removed.
- **Exclude the installation from project-wide tooling** (G18), on the installation or update branch.
- **Usage errors exit 2** (G21).
- **Adoption refs left by earlier releases** (`refs/factotum/adoptions/*` in the project checkout; earlier releases fetched no target refs) are not removed automatically: earlier releases recorded no OIDs to check them against. Remove them by hand for flows that have ended (`git for-each-ref refs/factotum/adoptions`, then `git update-ref -d <ref>`). Refs fetched from dev.83 on are removed by the operations loop.

## Review fixes

An independent review of `0f03492` rejected it on three blocking findings and raised three more. Fail-before evidence for this round was taken against an export of `0f03492` with the new test files copied in; `tests/pr-adoption-candidate.test.mjs` cannot import there (the new exports are missing), so for that file the missing imports were replaced with stubs that throw.

### P1 (blocking): G19 diagnostics leaked known secrets

**Problem.** `commandFailure` redacted only credential-shaped text. A configured or environment secret printed bare (for example the value of `OPENAI_API_KEY`) survived into `attempt.failure.stderr`, the failure notice, `status --flow` and the console.

**Fix.** The engine passes `knownSecrets(config)` (operations/known-secrets.mjs: credential environment variables, the scoped GitHub token, secret-named configuration values and the notification delivery file's secrets, each with its JSON-escaped, URL-encoded and base64 forms) to `commandFailure`, which redacts with it, as `prompt.txt` is redacted, before anything is recorded. It applies to every text field recorded: both excerpts, the summary (a launch error can carry the command path) and `ending`. Redaction runs before the excerpt is cut, so a cut cannot leave part of a secret.

**Tests** (`tests/rehearsal-diagnostics.test.mjs`).

- "review P1: known secrets are redacted from a failed command's output, summary, notice and flow view": a synthetic `OPENAI_API_KEY` printed bare to stderr and base64-encoded to stdout; both excerpts are `[redacted]`, and no form appears in the failure, reason, notice or flow view. Before: `Expected values to be strictly equal` (the bare value was recorded).
- "review P1: a known secret in a launch error is redacted from the summary": a command path containing the secret. Before: the summary did not match `/could not start \(.*\[redacted\]/`.

### P2 (blocking): G8's ancestry check could be forged with replace refs

**Problem.** `git merge-base --is-ancestor` follows replace refs and grafts. Replacing the target commit T with a fabricated commit whose parent is an unrelated commit U made U pass as target history, and adoption with `candidate.base = U` succeeded.

**Fix.** `adoptCandidate` refuses a checkout with replace refs or a grafts file (`assertNoHistoryRewrites`, as builder protection does; reported as a `repository` mismatch row with how to fix it) and proves ancestry with `VerifiedObjects.reaches(targetHead, base)`: parents parsed from hash-verified commits, starting at the OID the target fetch wrote. Shallow clones are not refused here, but a base below the boundary cannot be shown and is refused; the fix text says to unshallow. The fetched refs are read with `rev-parse --verify`.

**Tests** (`tests/pr-adoption-candidate.test.mjs`).

- "review P2: a replace ref cannot make an unrelated commit pass as target history": the review's repro (plain `merge-base` is fooled, `reaches` is not); adoption is refused with a `repository` row, and after `git replace -d` with a `base` row; no worktree. Before: "Missing expected rejection" (the forged base was adopted).
- "review P2: a grafts file is refused the same way". Before: "Missing expected rejection".
- The existing G8 refusal test now expects "(through verified parents)" in the row. Before: no match.

### P2 (blocking): `service install console` without `--port`

**Finding.** The review reported that an omitted `--port` reached `consoleUnit` as the string `"undefined"`. On `0f03492` this does not reproduce: the CLI's option table gives `port` the default `"0"`, so the omitted case wrote `--port 0` (checked with stand-in `systemctl` and `loginctl`). The code did depend on that default, though.

**Fix.** `service install console` passes `port` only when the option has a value, so `consoleUnit`'s own default applies otherwise, and `console` passes an explicit fallback of 0. The other early-checked options were audited: `--issue` is validated only when given (the positional issue is still accepted), and `--max-wait-hours` keeps its fallback of 72.

**Tests** (`tests/rehearsal-diagnostics.test.mjs`).

- "review P2: service install console without --port writes a unit with port 0, and with --port that port" (stand-in `systemctl`/`loginctl` on `PATH`, a temporary `XDG_CONFIG_HOME`, `--no-start`).
- "review P2: command lines accepted before still pass option checking": `console` with and without `--port` (stopped after a moment), `import-task` with a positional issue and with `--issue`, `upgrade apply` with and without `--max-wait-hours`, `status`; none is a usage error.
- Both pass on `0f03492` too, as the finding above explains; they guard the behaviour.

### P3: G20's recovery command did not quote the state path

**Fix.** Every path and value in the printed commands goes through `shellWord` (state directory, attempt directory, attempt id, flow id, payload).

**Test.** "review P3: the uncertain-attempt recovery command quotes a state path that needs it" (a state path with a space). Before: the unquoted path.

### P3: adoption refs built up per flow

**Fix.** `adoptCandidate` returns the refs it set with their OIDs (`adoptionRefs`), on success and on a mismatch hold (a privileged result field of `workspace.adopt`). Settlement records them (in one meta entry in this round; one record per flow since round 2). The operations tick (`operations/adoption-refs.mjs`) deletes a flow's refs once the flow has completed or failed (abandoned included) and its workspace, if it had one, was released (completed without pending cleanup, or `workspaceReleased`), with `git update-ref -d <ref> <oid>`: a ref that has moved is kept and reported on the flow (`adoptionRefsReleased.kept`), and one already gone counts as removed. Refs from earlier releases have no recorded OID and are left alone (adopter notes).

**Tests** (`tests/pr-adoption-candidate.test.mjs`).

- "review P3: adoption records its private refs, and a mismatch hold carries them".
- "review P3: an ended adoption's refs are deleted only at their recorded OID, after its workspace is released": nothing happens while the flow runs or while a failed flow's workspace is unreleased; then the matching ref and an already-gone ref are removed and a moved ref is kept; a non-adoption ref is never recorded.
- "review P3: an abandoned candidate hold that never created a workspace releases its refs": through engine settlement and `flow.abandon`.
- Before: the stubbed imports throw ("adoptionRefNames missing"); `0f03492` has no such records or sweep.

### Docs

`docs/running.md` (G19 redaction), `docs/adoption.md` (verified ancestry, refused rewrites, shallow clones, private refs and their removal), `docs/integrations/github.md` (`adoptCandidate`), and the adopter notes above.

## Review round 2

The re-check of `d2d9193` rejected it only for the new adoption-ref cleanup and withdrew the port finding. Fail-before evidence was taken against an export of `d2d9193` with the new test file copied in and its missing imports (`sweepAdoptionRefs`, `runningSweep`, `BATCH`, `GIT_TIMEOUT_MS`) replaced with stubs.

### P2 (blocking): the sweep could hang the operations tick

**Problem.** The sweep awaited Git with no deadline, and the workspace Git runner had none either. With a FIFO at a recorded loose-ref path, `rev-parse` blocked until the Git child was killed from outside, and the operations tick waited with it.

**Fix.**

- The workspace Git runner (`adapters/workspace/index.mjs`) takes an optional `timeoutMs`. After that long it kills the child (SIGKILL), and the call fails, or with `allowFailure` resolves `{code: null, timedOut: true}`. Every Git call in the sweep uses 2 s (`GIT_TIMEOUT_MS`).
- No Git call starts after a 5 s sweep deadline (`SWEEP_DEADLINE_MS`). The cursor stops at the first row not handled, so the next sweep resumes there.
- The operations tick calls `sweepAdoptionRefs`. It starts a sweep only if none is running for that store, and waits for it at most 250 ms (`TICK_BUDGET_MS`). A slower sweep finishes in the background, and any failure is recorded as `adoption.refs-release-failed`, never thrown into the tick.
- The FIFO case no longer reaches a blocking call at all. `for-each-ref` skips a non-regular file at a loose ref's path without a word, so when it lists nothing the sweep also checks that nothing is at that path; a FIFO there is reported and kept for a retry. A read that does block (shown with a FIFO as `packed-refs`, which every ref read opens) is killed by the timeout.

**Tests** (`tests/pr-adoption-candidate.test.mjs`).

- "round 2 P2: a FIFO at a recorded ref path is kept for a retry without blocking the sweep (the review repro)". The sweep finishes in well under the Git timeout; the FIFO's ref is kept with a reason and the other ref is removed. The Git runner's own timeout is checked on an `update-ref -d` that blocks on the FIFO. Before: the test file hung at this test, and `timeout 120` cancelled the run (exit 124, "cancelled 1").
- "round 2 P2: a Git read that blocks is killed after its timeout, and the operations tick waits only its budget" (a FIFO as `packed-refs`). `sweepAdoptionRefs` returns `{running: true}` within its budget, a second call starts no second sweep, and the background sweep ends within the timeout bound, with the ref kept for a retry, `attempts: 1` and the timeout as `lastError`. Not run before: the run had already hung.

### P2 (blocking): unbounded work per tick

**Problem.** Every pending entry was read on every tick, with one flow read each, even when none was eligible. Eligible flows also rewrote the whole pending map once each.

**Fix.** Pending refs are now one record per flow (kind `adoptionRefs`, id = flow id). The sweep reads at most `BATCH` (16) of them, by key after a cursor kept in meta (`adoptionRefsCursor`; a short page wraps to the start), and reads only those flows. Released records are deleted, as the host-sample and extension-lock records already are. All of a sweep's changes and the cursor are written in one transaction at its end. 10,000 waiting stopped flows therefore cost 16 flow reads per tick, and an eligible one is reached within ceil(pending / 16) ticks.

**Test.** "round 2 P2: each sweep reads a bounded batch of records and flows and writes once". 2,000 stopped flows with pending refs; across three sweeps each reads at most 16 flows, never reads every record (`all('adoptionRefs')` is refused), uses exactly one transaction, and advances the cursor by one batch. An eligible flow at the end of the list is reached by the cursor and released. Before: "sweep 1 read 2000 flows".

### P3: a retry orphaned refs it did not set again

**Fix.** `recordAdoptionRefs` keeps every ref recorded earlier for the flow that the new list does not name, and replaces the OID of those it does.

**Test.** "round 2 P3: a retry keeps refs recorded earlier that it did not set again". Before: on `d2d9193`, recording `[head, target]` and then `[target]` left only `[target]`, so the head ref was orphaned (checked directly against the `d2d9193` module, since the test reads the new record format).

### P3: a failed read was taken for an absent ref

**Fix.** A ref counts as absent only when `for-each-ref` lists nothing, warns nothing and exits 0, and nothing is at the loose ref's path. A broken or unreadable ref, a timeout, a non-zero exit, a warning, or any file Git does not read at that path is an error. Such a ref stays in the record with `attempts` and `lastError`, and is retried by a later sweep. The suggested `git show-ref --verify --quiet` was checked and not used: on Git 2.56 it exits 1 for an absent ref and for a broken or unreadable one alike. `git show-ref --exists` does tell them apart, but only from Git 2.43.

**Test.** "round 2 P3: a ref that cannot be read is retried, not taken for absent". A broken loose ref is retried with "broken ref" while an absent one counts as removed; after repair, the next sweep deletes it. Before: `Cannot read properties of undefined (reading 'map')` (no retry list; the broken ref was taken for absent and its record dropped).

### Merge of main

`git merge main` (main at `53e432e`, with the dev.83 planning and builder-question changes) conflicted in one file, `starter/factory/operations/state-view.mjs`: the attempts and task rows of the narrow status read. The resolution keeps main's added task fields (`acceptance`, `models`, `notBefore`) and this branch's attempt `reason` and `failure`. `docs/running.md`, `core/command-help.mjs`, `core/engine.mjs`, `core/operations.mjs`, `core/project.mjs` and `workflows/dispatch.mjs` merged without conflict. The full suite passed on the merge before it was committed.

## Review round 3

*Superseded by round 4: the claim and the replan refusal described here were removed in favour of per-attempt ref names.*

The re-check of `12218fa` rejected it for one finding, in the adoption-ref sweep.

### P2 (blocking): background cleanup could act on a reactivated flow

**Problem.** The sweep decided that a flow was eligible, then awaited Git, and its final transaction compared only the recorded refs. `flow.replan` is allowed on a failed delivery flow with no released workspace. In the reviewer's interleaving the sweep stalls in `for-each-ref` past its tick budget, `flow.replan` makes the flow `ready`, and when Git returns the sweep deletes the ref and the pending record and records `adoptionRefsReleased` on the now-active flow. This was reproduced on an export of `12218fa`: the replan completed, the flow became `ready`, then the ref and the record were gone and the active flow carried `adoptionRefsReleased`.

**Which commands reactivate an ended flow.** Every assignment of a non-terminal state in `core/`, `operations/` and `workflows/` was checked. Only `flow.replan` (through `replanFlow` and `move`) can take a `completed` or `failed` flow back to `ready`. `resume` requires `stopped`; the hold releases (decisions, merge waits, provider limits) go from `waiting` to `ready`; `rebindTaskFlow` touches only waiting task flows; `stopFlow` and `attempt.resolve` leave ended flows alone; `task.restart` starts a new flow, whose refs have a different key. `replanFlow` and `resume` both call the guard (resume as a defence).

**Fix: a claim taken with the eligibility check** (`core/adoption-ref-claims.mjs`, `operations/adoption-refs.mjs`).

1. **Claim.** In one synchronous transaction, with no await between them, the sweep reads its batch, checks each flow's eligibility and writes a claim `{token, at, expiresAt}` on each eligible pending-refs record. A record with a live claim is skipped; an expired one is taken over.
2. **Reactivation.** `replanFlow` and `resume` call `guardAdoptionRefReactivation` in their own transaction. With a live claim the command is refused with "the private adoption refs of flow <id> are being cleaned up; retry in a moment (within N s)". An expired claim is cancelled (removed, with `claimCancelled` recorded) and the command goes on. A claim lives 60 s (`CLAIM_TTL_MS`), so a crashed or stalled sweep blocks reactivation for at most that long.
3. **Deletion only under a live claim.** Right before starting each `update-ref -d`, the sweep checks synchronously that its token is still on the record, that the flow is still eligible, and that the claim has more than the Git kill timeout (2 s) plus a 5 s margin left. The Git child is killed at 2 s, so any deletion has ended before the claim expires, and while the claim is live reactivation is refused. The flow therefore cannot be active while one of its refs is being deleted.
4. **Final transaction.** A record whose claim is no longer the sweep's own (cancelled by a reactivation) is left untouched, and so is its flow. A record re-recorded meanwhile, or whose flow is no longer ended, only has the claim released. Claims on records not reached before the deadline are released too.

**What is guaranteed, and the fallback.** Point 3 rests on the wall clock not jumping forward by more than the 5 s margin, and the service process not being suspended, between the check and the end of the 2 s Git call. If that ever failed, a reactivated flow would still not use a stale ref: the only reader of these refs is `adoptCandidate`, which fetches both refs immediately before reading them (`git fetch … refs/pull/<n>/head:<ref>` and `git fetch … +refs/heads/<target>:<targetRef>`), so a reactivated flow re-fetches what it needs. The remaining effect would be a missing ref until that fetch, and a stale `refs/factotum/*` entry is never consulted for history. In that case the final transaction would also record nothing on the flow (point 4).

**Cost.** A sweep now uses two transactions, claim and apply, instead of one. The round-2 test's bound is updated to at most two; reads are still bounded by the batch.

**Tests** (`tests/pr-adoption-candidate.test.mjs`; Git calls are hooked so that `for-each-ref` waits on a promise the test releases).

- "round 3 P2: flow.replan is refused while a sweep holds the flow's cleanup claim (the review interleaving)": the sweep is claimed and stalled past its tick budget, `flow.replan` is refused and the flow stays `failed`. After release, the cleanup completes on the still-ended flow, and the retried replan then succeeds.
- "round 3 P2: a replan after the claim expired cancels it, and the stalled sweep then deletes nothing and records nothing": with a 200 ms claim, the replan after expiry succeeds and cancels the claim. When the stalled read returns, `update-ref` is never started, the ref and record remain, and the active flow has no `adoptionRefsReleased`. Later sweeps do not claim the active flow.
- "round 3 P2: a stale claim left by a crashed sweep blocks reactivation only until it expires, and a later sweep takes it over".
- "round 3 P2: an expired stale claim does not block flow.replan".
- Before (against an export of `12218fa`): all four fail, because no claim exists ("Cannot read properties of undefined (reading 'expiresAt')", and so on). The interleaving itself was reproduced there as described above.

## Review round 4

The re-check of `7ef0efa` rejected it for one race, again in the adoption-ref sweep.

### P2 (blocking): an expired claim did not fence a deletion already started

**Problem.** The claim check ran before the asynchronous `update-ref -d`. Once the claim expired, a replan cancelled it and reactivated the flow, and nothing stopped the deletion still in flight. Reviewer's repro: the sweep passes its check and its delete stalls; the clock jumps 61 s; `flow.replan` succeeds; the new attempt fetches the PR head into the same ref name; the old delete is released and removes the freshly fetched ref; the adoption's next read fails. Fetching before reading does not help, because the delete can land between the two. This was reproduced against an export of `7ef0efa` with the same steps: the replan completed, the fresh fetch created the ref, and after the old delete was released, `git rev-parse --verify <ref>^{commit}` failed with "fatal: Needed a single revision".

**Fix: per-attempt ref names; no timing involved.**

- `core/adoption-ref-names.mjs`: an attempt fetches into `refs/factotum/adoptions/<flow key>-<attempt key>` and `refs/factotum/adoption-targets/<flow key>-<attempt key>`, where the attempt key is derived from the attempt ID. The dispatch passes `intent.attemptId` to `adoptCandidate`, which uses a random ID when called without one. A replanned flow's new attempt therefore fetches into new names.
- The engine records an attempt's names, with no OID, in the flow's pending-refs record when it prepares a `workspace.adopt` attempt, before anything can be fetched. Settlement adds the OIDs and never replaces a recorded OID with null. So the refs of an attempt that crashed or never settled are cleaned up too.
- The sweep reads its batch, and visits only flows that have ended (workspace released, if any). Every name recorded for such a flow belongs to an attempt that had ended by then, and no later attempt writes that name. It deletes a name at its recorded OID with `update-ref -d <ref> <oid>`. A name recorded without an OID is deleted at the OID just read, which is safe because the name is that ended attempt's own. A moved ref is still kept and reported, and read errors are still retried.
- The final transaction removes from the record exactly the names it handled, compared by name and recorded OID, and keeps anything recorded since. An attempt that started after a reactivation and recorded its names in the meantime is untouched.

**The claim and the replan refusal are no longer needed and were removed.** A deletion can now only target a name whose attempt has ended. When it lands, early or late, after any clock jump and whether or not the flow was reactivated, it cannot affect a live adoption. `core/adoption-ref-claims.mjs` is deleted, and `replanFlow` and `resume` are back as they were. Crash safety does not depend on claims either:

- A crashed adoption attempt's names were recorded at preparation.
- A crashed sweep leaves the record as it was, so the next sweep repeats the work; deletes are idempotent, and an absent ref counts as removed.
- The bounds from round 2 still hold: a batch of 16 after a cursor, a 2 s Git kill timeout, a 5 s sweep deadline, a 250 ms tick budget, and one transaction per sweep (back from two).

**Old names.** Names without the attempt part, written by earlier releases and by rounds 2 and 3 of this branch, are still accepted by `ADOPTION_REF`. When recorded, they are cleaned exactly as before. The round-2 test "an ended adoption's refs are deleted only at their recorded OID…" still uses such names. Unrecorded refs from released earlier versions remain a manual clean-up (adopter notes).

**Tests** (`tests/pr-adoption-candidate.test.mjs`).

- "round 4 P2: an old sweep's stalled delete, released after a clock jump, a replan and a fresh fetch, cannot touch the fresh adoption", the reviewer's repro shape. Attempt A's refs are recorded, and the sweep's `update-ref` is held. `Date.now` jumps 61 s, and `flow.replan` succeeds. Attempt B's names are recorded, and `adoptCandidate` for attempt B fetches and is held at its first ref read. Then the old delete is released and the sweep finishes, and then B's read is released. The fresh adoption succeeds on B's refs, A's head ref is gone, and B's refs exist. A's target ref passed the sweep's own deadline because of the clock jump, so it is kept for a later sweep. The record keeps that ref and B's names, and the active flow is not swept.
- "round 4: names recorded without an OID (an attempt that never settled) are cleaned at the OID read; absent ones count as removed".
- The round-3 claim tests were removed with the claim. The round-2 "one transaction per sweep" assertion is back to exactly one.
- Before: against `7ef0efa` the repro test does not fail but hangs, because the older `adoptCandidate` has no injectable Git runner, so the hold on the fresh read never fires. The run was cancelled by `timeout 100` (exit 124). The race itself is shown by the direct reproduction above.

## Merge of the dev.83 console fixes

`git merge main` brought in the dev.83 console fixes (merge `497db2f`), which touch adoption.

- `workspace.adopt` no longer creates the original-PR to-do; `forge.publish` does, once a replacement is published.
- A pull request refused at integrate for changing managed files gets an action-supplied notice (`error.notice`, recorded as the result's `notice`), which `failedChangeReason` makes the failed-flow notice, and one neutral comment on the original pull request.
- An original-PR to-do left by an earlier release is retired when an adopted flow fails before publishing.

**Conflicts and resolution.** Both sides were kept.

- `core/engine.mjs`, the failed-change-flow line: this branch passed the G19 failure text into the stop reason, while main called `retireUnpublishedAdoption` and `failedChangeReason`. Main's line is kept, and G19 now goes through main's notice path (below), so the branch's own path (`lastFailedCommand`, `commandFailureText`) is removed.
- `workflows/dispatch.mjs`:
  - **Imports:** the union of both sides.
  - **The `workspace.adopt` case:** this branch's call is kept (it passes the attempt ID for per-attempt ref names and turns `AdoptionMismatch` into the G6 hold), with main's result, which no longer carries the original-PR obligation. The redundant `a.target ?? (a.target ?? …)` is not reintroduced.

**One notice mechanism.**

- `core/engine.mjs` has `attemptNotice(attempt)`. It returns the notice an action's result supplies or, for a failed trusted command, the notice recorded at settlement. `failedChangeReason` (main's) and the new `failedFlowNotice` for other kinds of flow both read it.
- **G19:** settlement of a failed trusted command records `attempt.notice` (`commandFailureNotice`: the summary followed by the stderr and stdout excerpts, already redacted). A change flow failing at such a step therefore reads "Change workflow failed at <step>: The command exited with code 3. …", and a rehearsal reads "Failed at <step> (attempt <id>): …".
- **G6:** the candidate-mismatch hold, and also the closing-keyword and commit-limit holds, supply `notice` (`reason` keeps the same text for older readers), and the engine's adoption-hold branch stops the flow with `result.notice`. A hold stops the flow rather than failing it, so it can be resumed as before; only the field it supplies is shared.

**Refs on the new refusal path.** A refusal at integrate happens after the candidate step. That attempt's names were recorded at preparation and given OIDs at settlement. The flow fails with its workspace kept for inspection, so its refs wait, as for any failed flow with a workspace, until the workspace is released (`cleanup apply`), and are then deleted.

**Tests.**

- "merge: a failed command's notice and an action's notice reach the failed-flow notice through the same path" (`tests/rehearsal-diagnostics.test.mjs`).
- The G19 notice test now asserts `attempt.notice` and the "Failed at work (attempt …)" notice.
- The G6 settlement test asserts that the hold's `notice` is the stop reason.
- "merge: refs of an adoption refused at integrate for managed files wait for its workspace, then are cleaned" (`tests/pr-adoption-candidate.test.mjs`).

## Files

| Area | Files |
| --- | --- |
| Adoption (G6, G7, G8) | `factory/adapters/workspace/index.mjs` (`adoptCandidate`, `AdoptionMismatch`, `adoptionRefNames`), `factory/operations/adoption-refs.mjs` (new; review, rounds 2 to 4), `factory/core/adoption-ref-names.mjs` (new; round 4), `factory/workflows/maintenance.mjs` (sweep), `factory/core/operations.mjs` (privileged field), `factory/workflows/adoption.mjs` (`candidateMismatchHold`, `plainReference`), `factory/workflows/dispatch.mjs` (catch in `workspace.adopt`, 3 lines), `factory/core/engine.mjs` (hold kind), `factory/core/command-help.mjs` |
| Template (G17) | `project/workflow.template.json` |
| Trusted command failures (G19) | `factory/core/command-failure.mjs` (new), `factory/core/engine.mjs`, `factory/operations/state-view.mjs`, `factory/console/ui/timeline.mjs` |
| Resume refusal (G20) | `factory/core/unsettled-attempt.mjs` (new), `factory/core/project.mjs` (one line and an import) |
| Command line (G21) | `factory/cli.mjs`, `project/integrations/triage.example.mjs` |
| Docs (G1, G6, G8, G17–G20) | `docs/adoption.md`, `docs/running.md`, `docs/integrations/github.md`, `project/SETUP_CHECKLIST.md` |
| Tests | `tests/pr-adoption-candidate.test.mjs`, `tests/rehearsal-diagnostics.test.mjs`, `tests/command-failure-view.test.mjs`, `tests/adoption-tooling-docs.test.mjs`, `tests/layout-fence-message.test.mjs` |

## Not done here

- Release notes: no dev.83 section exists yet; the adopter-facing points are G6/G8 (what `base` is, holds instead of failures), G17 (fixed template), G18 (exclude the installation from project tooling) and G21 (exit code 2 for usage errors).
- A future layout change that has to refuse earlier releases anyway could name its fence function with readable text (G1).
