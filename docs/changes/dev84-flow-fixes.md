# dev.84: flow fixes from the dev.83 readiness re-test

Six findings from the dev.83 re-test: H9 (a build that runs out of provider turns ends the flow and discards the reviewed plan), H8 (two merges answered together race at the forge), H13 (doctor fails after factory merges until the operator checkout is pulled), H10 (a queued task does not name the answered flows ahead of it), H1 (the wrong-candidate notice assumes the pull request moved) and H12 (`triage.mjs --help`). For each: the problem, the fix, compatibility and the tests with their fail-before evidence. This is a local implementation record, not a release, activation or live qualification claim. No real provider or forge call was made: provider behaviour is exercised with a fictional Claude transport and synthetic results, merges with the engine and the existing fictional `gh` tests.

**The reference graph is unchanged.** No node, edge or answer was added or changed, so no workflow digest changes and no task needs approving again. H9 uses the build step's existing `blocked` edge and the build question's existing `retry` answer.

**Fail-before evidence** for every item was taken the same way: the new and updated test files were copied into an export of the base commit `be3f9d0` (`git archive`) and run there. Two imports that do not exist at base were replaced with stubs that throw (`mergesAhead` in `tests/admission-capacity.test.mjs`, `defaultMaxTurns` in `tests/provider-turn-limit.test.mjs`), so the rest of each file could run. Result: 98 tests, **18 fail, 80 pass**. The 18 are all 16 new tests and 2 existing tests updated for an intended change; the 80 that pass are existing tests (one of them updated, "F20 round 2", which passes at base too). Each failure is quoted under its item.

## H9: a build that runs out of provider turns ends the flow and discards the reviewed plan

### Problem

Claude ended a strict build with `subtype: error_max_turns` after 17 turns (`is_error: true`, cost $0.856, worktree edits uncommitted). The adapter reported it as the generic `INVALID_RESULT` ("Provider did not produce a complete validated result; inspect private artifacts"), the attempt became `uncertain` and the flow stopped. The documented recovery, `attempt.resolve` (failed) then `resume`, follows the build step's failure route to `failed`: the flow fails, and the reviewed plan, the plan comment and the plan-review cost are thrown away. Nothing said so before the operator acted. The cause was only in `provider/stdout.jsonl`, which no guide mentioned.

### Where the 17-turn limit came from

From Factotum itself. `workflows/dispatch.mjs` called the provider with `maxTurns: selected.maxTurns ?? 16` for every model step, builders included, and the Claude adapter passes a set `maxTurns` as `--max-turns 16`. The report's "Factotum passes no `--max-turns`" was mistaken: the flag is added only to the model invocation (not to `--help` or `auth status`), and the configuration sets none, so the default applied. Claude counts the turn on which it stops, hence "after 17 turns". `providers.<role>.maxTurns` was already read (the console's Settings showed a "Turn limit" column) but neither documented nor validated.

Codex has no equivalent: `codex exec` takes no turn cap and this adapter passes none, so a Codex step is bounded only by its timeout. A failed Codex turn arrives as `turn.failed` or `error` and stays `INVALID_RESULT`.

### Fix

- **The limit is configurable and builds get more.** `adapters/providers/routes.mjs` defines `DEFAULT_MAX_TURNS = {builder: 60}` and 16 for every other role; dispatch uses the route's `maxTurns`, else that default. `providers.<role>.maxTurns` and, per step, `stepModels.<workflow>.<step>.maxTurns` (next to the step's `model`) are validated as whole numbers from 1 to 500 (`core/step-models.mjs`, `core/configuration.mjs`). The flow's pinned routes carry the configured value, so a changed limit applies to flows admitted after the change; a route without one gets the role default at dispatch, which is how existing flows pick up 60 for builds. Why 60: the trial's builds used 3 to 13 turns and the strict one needed more than 16; 60 leaves room for a larger repository while a runaway build is still bounded by the step's timeout (10 minutes by default). Planners and reviewers keep 16: they are read-only and the trial gave no evidence they need more.
- **A turn-limit end is its own, known outcome.** The adapter reads the final result: `error_max_turns` (with no usage-limit signal, which still wins) is raised as `ProviderError` code `MAX_TURNS`, `started: true` (so never a fallback), with `turnLimit {provider, model, subtype, turns, maxTurns, costUsd, sessionId}` and the usage it reported for accounting. The message: "claude stopped at its turn limit (error_max_turns, after 17 turns, limit 16, reported cost $0.856); the step did not finish and returned no result". Every other unsuccessful Claude end stays `INVALID_RESULT`, and its message now names the subtype, turn count and cost and where the output is ("… inspect private artifacts (claude ended with error_during_execution after 5 turns, reported cost $0.120; its output is in the attempt's provider stdout.jsonl)").
- **A builder out of turns goes to the build question with the plan intact.** `provider.build` catches `MAX_TURNS` and returns a result with `route: "blocked"`, `turnLimit` (plus role, step and artifact), the session, provider and model, the usage observation, and `notice` ("The builder (claude …) stopped at its turn limit at step build: … Nothing was committed; its edits so far stay in the worktree, and the reviewed plan is kept."). The graph's existing `blocked` edge takes it to `build-question`. The card (`core/worker-questions.mjs`) says what happened instead of "the builder is blocked and asked no question": "The builder ran out of turns: claude ended the build with error_max_turns after 17 turns (limit 16), reported cost $0.856. Nothing was committed; its edits so far stay in the worktree. The reviewed plan is kept.", where the output is, that a retry resumes the session with the reviewed plan and another full budget of turns, and which setting raises the limit. `retry` is labelled "Retry the build" (a note is optional), `stop` as before; `buildQuestion.status` is `turn-limit` with the facts. The attempt settles `passed` with `classification: "turn-limit"`, `turnLimit` and a reason, and the flow parks at the question (so it frees its slot like any question).
- **Partial edits are kept, following the existing build-retry semantics.** A build question's `retry` has always resumed the builder's session on the worktree as it is (`flow.sessions.builder`, set from the result's session, and no reset). A resumed session knows what it already edited, so keeping its edits is coherent; resetting would leave the resumed session describing edits that no longer exist. The worktree is still uncommitted and nothing external happened, so the commit, integration, review and gate that follow are unchanged.
- **A planner or reviewer out of turns stops at the same step.** Dispatch writes its result as a failure (`route: "error"`, `turnLimit`, `notice`), not as uncertain. `turnLimit` is a privileged field of the model operations (`core/operations.mjs`), so only they can set it. Settlement (`core/engine.mjs`) marks the attempt `failed` with `classification: "turn-limit"`, keeps the step's earlier result (a plan, a review) instead of overwriting it, records `flow.turn-limit-held`, sets `resumeStep` to the same step and stops the flow with the notice ("The reviewer (claude …) stopped at its turn limit at step plan-review: … It is read-only, so nothing changed; the attempt is settled as failed (turn-limit) and the flow stopped at plan-review. Resume runs the step again with the same limit; to give it more turns, raise providers.reviewer.maxTurns, or stepModels.<workflow>.plan-review.maxTurns for this step (it applies to flows started after the change)."). The notice goes through the action `notice` path and `attemptNotice`.
- **Settling an uncertain attempt is warned about first.** `failureRouteWarning` (`core/unsettled-attempt.mjs`) says where `resume` goes after `attempt.resolve`. When the failure route ends the flow as failed: "Settling it (attempt.resolve, failed or not-dispatched) makes resume follow step build's failure route to failed: the flow ends failed and its reviewed plan is not reused, so the task needs a new flow (task.restart)". It is appended to the uncertain attempt's stop notice, to the resume refusal (after the exact `attempt.resolve` command) and, as "Resume will follow …", to the stop reason `attempt.resolve` records. The command help for `attempt.resolve` says the same.
- **Docs.** `docs/running.md` (build questions: the turn-limit card; recovering from an uncertain model step, including `provider/stdout.jsonl`), `docs/integrations/providers.md` (turn limits, defaults, `MAX_TURNS`, Codex), `docs/project-workflows.md` (`stepModels.….maxTurns`).

### Compatibility

- No graph, digest, approval or schema change. One new privileged result field (`turnLimit`) for `provider.plan`, `provider.planReview`, `provider.build` and `provider.review`.
- Builds may now take up to 60 Claude turns instead of 16 unless configured; more turns can cost more per build. Set `providers.builder.maxTurns` to keep the old bound.
- A `maxTurns` outside 1–500, or of the wrong type, is now refused by `config update` and `init` instead of failing at the first model step.
- `stepModels` entries (and the live model defaults and task model choices that share their shape) accept `maxTurns`.
- An uncertain attempt's stop reason, the resume refusal and the reconciled stop reason have an added sentence; their beginnings are unchanged.
- The audit maintenance step calls the provider itself and still passes only a configured `maxTurns` (no default); unchanged.

### Tests (`tests/provider-turn-limit.test.mjs`, 9 new)

| Test | Fail-before (base `be3f9d0`) |
| --- | --- |
| Claude ending with `error_max_turns` is a known turn-limit end with its turns, limit and cost (and `--max-turns 16` reaches the CLI) | `actual: 'INVALID_RESULT', expected: 'MAX_TURNS'` |
| Another unsuccessful Claude end names its subtype and turns | `actual: 'Provider did not produce a complete validated result; inspect private artifacts'` |
| Builds get a larger default turn limit; a configured limit wins (60, then 90, through `runAction`) | `defaultMaxTurns missing at base` (stub) |
| A builder out of turns returns a blocked build with the turn limit, its session and the notice; a reviewer's is an error with its own notice | `Error: claude stopped at its turn limit` (thrown, not returned) |
| A builder out of turns stops at the build question with the reviewed plan kept; the card; retry resumes its session | `actual: undefined, expected: 'turn-limit'` |
| A reviewer out of turns is settled as failed and the flow stops at the same step, keeping the earlier review; resume runs it again | `not failed: actual: 'ready', expected: 'stopped'` (the flow was on its way to `failed`) |
| Before an uncertain build is settled, the stop notice, the resume refusal and the resolve's stop reason say that resume would then fail the flow | the stop reason without the warning |
| `maxTurns` is configurable per role and per step, within bounds, and pinned into the flow's routes | `Missing expected exception` (0 accepted) |
| The warning for a failure route that does not end the flow, before and after the resolve (added after the fail-before run, with a wording fix to the resolve's stop reason) | not run at base; `failureRouteWarning` does not exist there |

## H8: two merges answered together ran at once

### Problem

With `maxFlows: 2`, `merge` answered on two flows half a second apart dispatched both merge steps at once. The first merged; GitHub refused the second as out of date (HTTP 405), and dev.83 routed that to integration: fast checks, publication, a full review and the gate again, then the merge question again. Safe, but one model review and one more operator answer per collision.

### Fix

Merges into one target run one at a time (`operations/merge-hold.mjs`, `core/engine.mjs`). Before a `forge.merge` step prepares its attempt, the engine reads `mergesAhead(target)`: other flows of the same target whose merge attempt is prepared, dispatched or running, or that have merged and are at their post-merge step. If there are any, the flow waits: `state: waiting`, `mergeWait {step, target, flowIds, reason, since}`, event `flow.merge-wait` once (an unchanged wait writes nothing). The reason: "Waiting: flow F is merging into main. Merges into one target run one at a time; this merge starts when that has finished, then reads main again: it merges without a new review when main's new commits do not touch this candidate's files, and goes back to integration when they do" (or "is finishing its post-merge step after merging into main"). When nothing is ahead, the wait is cleared (`flow.merge-released`) and the step prepares as before. The merge step itself is unchanged: it reads the moved target and applies dev.83's move rule (G9), so a disjoint move merges without a new review. `status --flow` and the narrow reads show `mergeWait`.

Only flows that are progressing count (not stopped, not asked to stop, no uncertain attempt, not waiting for a slot): an uncertain merge does not hold others, since the next merge reads the target itself. A waiting merge has no attempt, so two waits cannot hold each other. Merges into other targets do not wait.

Why wait rather than retry once after a disjoint refusal: waiting avoids the forge refusal altogether, costs nothing while it waits (the first merge and its post-merge step take seconds), and keeps the decision about a moved target in one place, the merge step's existing check. A retry would still race a third merge.

### Compatibility

No graph or digest change. A second merge into the same target now starts a few seconds later, after the first and its post-merge step. A waiting merge keeps its flow slot and counts as a merge in flight for admission, as an answered merge always did once it had its slot. The post-merge `main.verify` job is not waited for; the merge step's own target read covers what it would protect.

### Tests (`tests/admission-capacity.test.mjs`, 2 new)

| Test | Fail-before |
| --- | --- |
| Merges answered together into one target run one at a time: the second waits visibly (reason, `mergeWait`, one event, `status --flow`, no write when unchanged) through the first merge and its post-merge step, then is dispatched | `the second merge is not dispatched beside the first: actual: '<attempt id>', expected: null` |
| A stopped or uncertain merge, a merge into another target, and a waiting merge hold no other merge | `mergesAhead missing at base` (stub) |

The merge step's behaviour after the wait (a disjoint move merges, an overlapping one returns `stale`) is covered by the existing G9 tests through `runAction` with a fictional `gh`.

## H13: doctor fails after factory merges until someone pulls the operator checkout

### Problem

Doctor refused a checkout behind on "files the configuration runs as commands" (dev.81 F20), but most of those commands do not run from the checkout. Every factory merge put the checkout further behind, so on a busy project any configuration change needed a manual `git pull` first.

### Fix

`configuredCommandLocations(config, root)` (`workflows/commission.mjs`) classifies each configured command by where it actually runs, checked against the code path of each kind:

| Command | Runs in | Code |
| --- | --- | --- |
| `checks` (gate) | the flow's worktree (candidate) | `dispatch.mjs` `gate`: `runChecks(…, {cwd})`, `cwd` the attempt's working root |
| `fastChecks` | the flow's worktree | `dispatch.mjs` `fastCheck` |
| `mainChecks` | an owned checkout of the target's remote head | `maintenance.mjs` main verification: `cwd: owned.path` |
| `scheduledTasks.*.command` | an owned checkout of the target's remote head | `maintenance.mjs` `runScheduledTask` |
| `preview.command` | the candidate | `dispatch.mjs` `preview` |
| `workspace.setup` | each new worktree | `adapters/workspace/index.mjs` `prepare` |
| `sourceSync.argv` (command source) | the operator checkout | `operations/source-adapter.mjs`: `cwd: root` |
| `integrationAdapters.*` and their `files` | the flow's worktree when it has one, otherwise the operator checkout (`workingRoot`); `files` are read from there | `workflows/integrations.mjs`, `workflows/actions.mjs` |
| `retention.preservation.argv` | the operator checkout | `maintenance.mjs`: `cwd: root` |
| commands in project-owned workflow definitions, any other section | taken as the operator checkout (fail safe) | |

A path written absolute, or starting with a variable or `~`, may name the checkout's own copy whatever the section, so it counts as run from the checkout; a file named in both places too. Doctor refuses only files run from the checkout ("… including files the configuration runs as commands from the operator checkout (…: source or integration adapters, or other commands that run there) …"). For files run only in workspaces from the target it warns with the count: "the local root is 3 commit(s) behind origin/main; no factory files or files the configuration runs from the checkout differ, so commissioning does not need it current; 2 changed file(s) are run by the configuration only in factory workspaces created from the target (gate, fast and main checks, preview, scheduled tasks, workspace.setup), which use the target's current copy (…)". The refusal for installed factory files is unchanged. `configuredCommandPaths` remains, as the union.

**`doctor --pull` was not added.** The refusal that remains most often is for factory files, which needs work drained before pulling; a flag that pulls would make that easy to skip. The running guide now says when doctor still asks for a pull.

### Compatibility

Doctor passes, with a warning, where it refused before: a checkout behind only on files the gate, fast or main checks, preview, scheduled tasks or `workspace.setup` run. Everything it refused before for source and integration adapters, the retention adapter, project workflow commands and unknown sections it still refuses. `docs/running.md` has the classification table.

### Tests (`tests/trial-code-items.test.mjs`: 1 new, 2 updated for the intended change)

| Test | Fail-before |
| --- | --- |
| New: doctor refuses only files run from the operator checkout; commands run in workspaces from the target warn with a count (the classification of every section, absolute and variable-led paths, a file in both places; end to end, the report's case with gate and main-check scripts changed on the target) | `TypeError: configuredCommandLocations is not a function` |
| Updated "F20 review": a fast-check script changed on the target now warns with the count; a source adapter script is refused | `actual: false, expected: true` (base refused the fast-check script) |
| Updated "F20 round 2": the path-resolution repros are now asserted through a source adapter, where they are still refused | passes at base too (base refused them in a gate check as well) |

## H10: a queued task's reason did not name the answered flows ahead of it

### Problem

With answered flows waiting for the only slot, held by a working flow, a queued task showed only "flow capacity exhausted". The "answered flows take the next free slot first: <ids>" clause named only the waiting flows a slot was free for now, so it was absent exactly while every slot was held.

### Fix

`answeredAhead(state, row)` (`operations/capacity.mjs`) lists the answered flows ahead of queued work in line order: those a slot is free for now, and those waiting while all slots are held. A waiting flow whose own category is full is left out, since the allocation passes it over until the category frees (dev.83's review decision). The reason names them ("flow capacity exhausted; answered flows take the next free slot first: f1, f2, f3"), and the structured fact's `answeredFlowIds` carries them, which the console already renders as links wherever it lists a task's admission holds (task detail and Queue, through `holdList` in `console/ui/admission.mjs`; no console change was needed).

### Compatibility

Text and fact only: the clause now appears while slots are held. Who gets the next slot is unchanged.

### Tests (`tests/admission-capacity.test.mjs`: 1 new, 1 assertion updated)

| Test | Fail-before |
| --- | --- |
| New: three answered flows waiting while a working flow holds the only slot are named in order, in the reason and the fact; one whose category is full is not | `actual: [ 'flow capacity exhausted' ]` |
| Updated assertion in "concurrent answers never start more flows than there are slots": the queued task now names the waiting flow | `actual: [ 'flow capacity exhausted' ]` |

## H1: the wrong-candidate notice said the pull request moved when the head was simply wrong

### Fix

`adoptCandidate`'s `head` row (`adapters/workspace/index.mjs`) is worded after the target is fetched, from what can be told (`headCause`):

- the approved head is one of the pull request's commits (read with the bounded PR commit list, at most 250): "the approved commit <a> is an earlier commit of this pull request; its head is now <b>" (as worded since the review: see [review fixes](#review-fixes), 3);
- the approved head is on the target (`git merge-base --is-ancestor` against the fetched target; wording only, so no verified walk is needed): "the approved head <a> is a commit on main, not the pull request's head: the approval named another commit";
- the commit list was read and does not contain it: "… is not the pull request's head or one of its commits: the approval named another commit, or the pull request was force-pushed after approval";
- the commit list cannot be read: "the approved head is not the pull request's head (it may have moved since approval, or the approval named another commit)".

Each continues with "; review head <b>, then abandon this flow (flow.abandon) and start a new one (flow.start) with candidate.head <b>", as before. The refusal itself is unchanged.

**Compatibility.** Text only, plus at most one PR commit-list read on a head mismatch.

**Tests** (`tests/dev84-flow-fixes.test.mjs`, 3 new): moved; named a target commit (the report's case); never had, unreadable list and failed read. Fail-before: each got "the pull request moved after it was approved; review head …" (the first test also fails, since the old text lacks the earlier-commit detail).

## H12: `triage.mjs --help` answered "--help needs a value"

**Fix.** `starter/project/integrations/triage.example.mjs` prints a usage listing every mode and its options and exits 0 when `--help` or `-h` appears anywhere on the command line, before the options are parsed. A real missing value is still refused (dev.83 G21).

**Compatibility.** None beyond the help. The file is a project-owned example, so a copy an adopter already made is not updated; copy the `USAGE` block and the first line of `main()` to get it.

**Test** (`tests/dev84-flow-fixes.test.mjs`): `--help`, `-h`, `--counts --help` and `--log --help` exit 0 with the usage on stdout and nothing on stderr; `--counts --since` still exits 1. Fail-before: `--help: triage: --help needs a value`, exit 1.

## Results

With the docs and this record, before the last wording fix: `npm test` 1205 tests, 1205 pass, 0 fail; `npm run eval` exit 0. After the wording fix and its test: `npm test` 1206 tests, 1206 pass, 0 fail. `git diff --check` clean.

The first full run on the base (before any change) had 1189 tests, 1188 passing; the one failure ("a candidate edited while completion waits for the database write lock does not complete": "pinned executor differs; drain with original code") was caused by this change's first edits landing in `starter/factory/` while that run was in progress, which changes the executor digest. It passes in every later run.

## Review fixes

An independent review (GPT-6.1 Sol) of `578305d` approved it with fixes: two blocking findings and one minor one. It confirmed the source of the 16-turn default, the role defaults and bounds, pinned routes, the unchanged graph, H8's bounded reads, absence of mutual waits, released holds, post-merge timeouts and merge-first order, H13's classification, no new SQL JSON reads or scans, `attemptNotice`, the updated tests and 1206 of 1206 tests passing. Fail-before for this round was taken by copying the new and changed test files onto an export of `578305d`: 27 tests, **4 fail, 23 pass**; the 4 are the new tests below.

### 1. High, blocking: turn-limit recovery bypassed session binding

**Problem.** The adapter raised `MAX_TURNS` from the final result's `session_id` without checking it against the invocation. Invoked to resume session A, an `error_max_turns` result naming session B gave `MAX_TURNS` carrying B, although accounting had refused B; the builder's result adopted B and settlement saved it in `flow.sessions.builder` for the next retry. A result without a session was still classified as a known turn-limit end.

**Fix.** The adapter treats an `error_max_turns` end as a turn limit only when it is bound to the invocation: the final names a session, accounting accepted that session under its own rules (a unique final, and the resumed session when the invocation resumed one), and it equals the resumed session if there is one. Otherwise the end stays `INVALID_RESULT` (started, so uncertain), its message saying "…, in a session other than the one this invocation resumed" or "…, without a session", and accounting keeps the invocation's own session. Dispatch checks again before a builder's session can be kept (a valid session id, and the resumed one when resuming); an unbound `MAX_TURNS` is turned back into `INVALID_RESULT` without `turnLimit` or notice, so it is written as an uncertain result. The builder's turn-limit result takes its session only from the bound turn limit, never from the flow's earlier session.

**Test** (`tests/provider-turn-limit.test.mjs`): "review fix 1: a turn-limit end in a session not bound to the invocation, or without one, stays an uncertain invalid result": both repros through the adapter, the bound case still `MAX_TURNS`, and both through dispatch with a resumed builder. Fail-before: `actual: 'MAX_TURNS', expected: 'INVALID_RESULT'`.

### 2. Medium, blocking: the configuration export dropped per-step turn limits

**Problem.** With `stepModels.standard.build = {model: "m", maxTurns: 5}` and a live model selection for `build`, `config show` (`configWithModelDefaults`) exported `{provider, model, effort}` for that step, without `maxTurns`; re-importing it raised the step's limit to the role's (or the default 60).

**Fix** (`operations/model-settings.mjs`). The export writes the live selection with the step's turn limit: the live default's `maxTurns` when it sets one, else the project's, which is what the pinned route has. The projection rows (`modelSelection.steps`, the settings view's model steps, `stepModelView`) carry the effective `maxTurns` when the route has one. Other paths that build routes were checked: live selection, task model choices and run overrides go through `stepSpec`, which keeps every field (a provider switch drops only the fallback, allowance and effort); the step's dispatch, usage accounting, provider-limit holds and doctor's per-step preflight spread the whole route. `stepModels` fields are `provider`, `model`, `effort` and `maxTurns`, so no other route field can be lost on export.

**Test** (`tests/model-settings.test.mjs`): "review fix 2: stepModels maxTurns survives a live selection, the projection and the export": the reviewer's repro with a role limit of 40, the pinned route, the settings row, the exported entry and the routes from re-importing it, and a live default with its own limit. Fail-before: the projection row's `maxTurns` `undefined`, expected 5.

### 3. Low: H1 still guessed when the approval happened

**Problem.** An earlier commit approved by mistake while the pull request already pointed at its current head read as "the pull request moved after it was approved".

**Fix.** The case is described as observed, neutral about the cause: "the approved commit <a> is an earlier commit of this pull request; its head is now <b>; review head <b>, …". The GitHub guide says the cause is not guessed.

**Test** (`tests/dev84-flow-fixes.test.mjs`): the first H1 test, renamed, now also asserts that neither "moved" nor "after it was approved" appears. Fail-before: the old text.

### Also: the console's Settings "Turn limit" column

It showed `—` when a role set no `maxTurns`. The settings view now gives each provider role its `defaultMaxTurns` (60 for builders, 16 otherwise), and the column shows the configured limit, else the default marked "(default)", and "None (Codex has no turn limit)" for a Codex role, whose limit would not apply. Limited to the Settings view (`operations/views.mjs`, `console/ui/settings.mjs`). Test: `tests/console-turn-limit.test.mjs`, new. Fail-before: `defaultMaxTurns` absent from the view (`[null, undefined]` for every role).

### Merge of main

After the review fixes (`0c4be1f`), main (`0598cf9`: the dev.84 console items H3–H7, with their review fixes) was merged: merge commit `4837090`. Nothing conflicted. Both sides changed `operations/capacity.mjs`: main added `waitsOnCategoryOnly` (a waiting flow held back only by a full category while its pool has an unreserved slot, used by Queue and the new flow-detail slot state) and `flowSlot`; this change added `answeredAhead` (H10). They agree: `answeredAhead` leaves out a waiting flow whose category is full, which is passed over for slots, and `waitsOnCategoryOnly` names such a flow when a slot stands free because of it. `console/ui/admission.mjs` (main: links for the parked-limit hold, H7) renders H10's `answeredFlowIds` unchanged.

### Results of the review round

On the merge commit: `npm test` 1218 tests, 1218 pass, 0 fail (1206 before, plus 4 new here and 8 from main); `npm run eval` exit 0; `git diff --check` clean.

## Adopter notes

- **Builds may take more Claude turns** (60 by default instead of 16). Set `providers.builder.maxTurns` to bound them differently; `stepModels.<workflow>.<step>.maxTurns` for one step.
- **A builder that runs out of turns asks a build question** ("Retry the build") instead of stopping the flow; retry keeps the reviewed plan and the edits so far.
- **Do not settle an uncertain model step without reading the warning**: in the reference graph `attempt.resolve` then `resume` fails the flow.
- **Doctor no longer needs a pull** when factory merges changed only files your gate, fast or main checks (or preview, scheduled tasks, `workspace.setup`) run. It still refuses when they changed installed factory files or a file run from the checkout (source and integration adapters).
- **Merges into one target run one at a time**; a second answered merge shows `mergeWait` for the few seconds the first takes.
- **`triage.mjs --help`**: copy the help into an existing copy of the example if wanted.

## Open questions

- **Live qualification.** The `error_max_turns` stream shape is the one the report quoted (`subtype`, `is_error`, `num_turns`, `total_cost_usd`, `session_id`); it was not re-observed with a live Claude CLI, and whether `--resume` of a session that ended at its turn limit continues cleanly was not exercised live.
- **The default of 60** is a judgement from one trial; an adopter at a larger scale may want it per task risk (strict builds took the most turns). Per-step configuration covers a project-wide choice, not a per-task one.
- **Uncertain build attempts other than turn limits** still end the flow when settled, with the warning. A `retry`-from-uncertain option (settle and run the same step again, keeping the plan) would need a graph or command change and a rule for partial edits without a recorded session; not done here.
