# dev.83: admission and capacity

Four changes from the dev.82 re-test, all in admission and the steps around it: flows parked on an answer free their flow slot (an operator decision of 2026-11-15), and findings G5, G10 and G9. This records each problem, the decisions, the design, compatibility, the tests with their fail-before evidence, and the limits. It is a local implementation record, not a release, activation or live qualification claim. No real forge call was made: the merge step is exercised with a fictional `gh` executable and local Git repositories.

## 1. Parked flows free their slot

### Problem

Every flow that was not completed or failed held a `policy.maxFlows` slot, including one waiting on an operator answer. With the default `maxFlows: 1`, one open question stalled the queue.

### Decisions

| Question | Decision | Why |
| --- | --- | --- |
| Which waits are "parked"? | A flow waiting at any question node, with no attempt and not stopped: the plan, build, conflict, review and gate questions, the merge decision (a strict sign-off is the merge or satisfied question with `strictReview`), the satisfied-outcome decision, and any question in a project-owned graph. | All of them wait only on an answer from the operator or orchestrator; no work runs. Waits that end by themselves (a timer, a target wait, a provider usage-limit hold, a decision hold) are not parked and keep the slot. |
| Stored or derived? | Derived from the flow's step and state (`operations/capacity.mjs`, `atQuestion`). | No flag can drift, and upgrade needs no migration: a flow already waiting on an answer is parked the moment the new code reads it. |
| At the parked limit: count as active, or hold admission? | A flow parked beyond `policy.maxParkedFlows` **holds a slot in its own pool again** (the longest-parked flows use the allowance). | One formula (`in use = working + parked beyond the limit`), a hard bound of `maxFlows + maxParkedFlows` open flows, and no idle slot while the parked count is within the limit. Holding all admission at the limit would stall the queue at exactly the limit even with free slots, and would make `maxParkedFlows: 0` mean "never admit" instead of "parking off". With this choice `0` restores the dev.82 behaviour exactly. |
| One limit or one per pool? | One limit across change and document flows. | Both keep a worktree open; the limit is on waiting worktrees and waiting questions. |
| When does parking start? | When the question is open (`state: waiting`), not when the flow reaches the question step. | The engine opens the question on its next tick. A merge question that `policy.autoMerge` answers as it opens therefore never gives its slot to a queued task. |
| Stopped flows | Hold a slot, whatever they did before the stop (the operator's decision), including a flow stopped while parked (an expired question) or while waiting for a slot. | One rule for the reason text, the docs and the console. A resume that would start work without a slot waits for one (below). |
| Category limits | A parked flow frees its place in a limited category too, under the same parked limit (operator decision, 2026-11-15, after the first version of this change kept the old count). An answered flow needs a place in its category as well as a slot. | A category limited to 1 must not be held by an open question, for the same reason a slot must not. Requiring the place again on the answer keeps the limit true of flows doing work. |
| Order among answered flows | Answered merges first, then other answered flows, then queued tasks (operator decision, 2026-11-15). | A merge finishes work and frees its worktree and paths; making it wait behind a build delays everything behind it. It still never exceeds `maxFlows`. |
| Expired questions | No change (operator decision, 2026-11-15): an expired question stops its flow, and a stopped flow holds a slot. | The operator's rule for stopped flows. It is stated in `docs/operations.md`. |
| Task flows | Unchanged: `policy.maxTaskFlows` counts every open task flow. | A task flow is always at a question; its pool is the limit on open tasks. |
| Live setting? | Yes: `policy.maxParkedFlows` is live, like `maxFlows`, `maxTaskFlows` and `maxDocumentFlows`. | Precedent. It does not change what a running flow does or what was authorized. |

### Design

`operations/capacity.mjs` is the one place that says who holds a slot. `slots(store)` reads the live flow set (`store.live('flow')`) and returns, per pool, the working flows (stopped ones included), the parked flows, those parked beyond the limit, and the flows waiting for a slot. Admission (`admissionReasons`), the idle-capacity observation, queue status and the machine sample all read it.

**Answered flows.** `takeSlot(store, flow, {after})` runs inside the command's transaction after the flow has moved to its next step, in three places in `core/project.mjs`: `answer`, `flow.replan` (when the flow was parked, waiting for a slot, or stopped) and `resume`. If the next step is a question or an end node, nothing is needed. Otherwise the flow works now when `working + parked beyond the limit + flows already waiting < max` for its pool, and else gets `slotWait {since, step, after}` with `state: waiting` and the event `flow.slot-wait`. It is never stopped. A resumed flow does not queue behind waiting flows (`ahead: false`): a stopped flow held its slot, so it only waits if the pool is full without it.

**The line.** Waiting flows are ordered: answered merges first (`slotWait.merge`, set when the step the flow waits to run is `forge.merge`), then by when each wait began. `allocation` walks the line and gives each flow a free slot of its pool and, where its category has a limit, a free place in it; a flow whose category is full is passed over, so it does not hold up flows behind it. An answer joins the line at its place and works at once if the allocation reaches it: a merge answered while other answered flows wait takes a slot that has just come free; any other answer does not get ahead of flows already waiting.

**Categories.** `slots()` also tallies each category that has a limit, across both pools, by the same rules (working and stopped flows and flows parked beyond the limit hold a place; parked flows within it do not; waiting flows are owed one). Admission's category check reads it (`categoryReason`), and `takeSlot` and the engine's grant require the place as well as the slot. A flow's category is its admitted task snapshot's, as before.

**The engine** does not step a flow with `slotWait`. Each tick it asks `slotGrantable`: does the allocation over the current line reach this flow? If so it clears the wait in a transaction that checks again (`flow.slot-granted`), and the flow is stepped normally on the next tick. The check is made once per database state (`Store.changeToken`), and waiting writes nothing, so parked questions are not woken (R3).

**New tasks come last.** Admission counts waiting flows as holders, so a freed slot is never claimed by the queue while an answered flow waits: `flow capacity exhausted; answered flows take the next free slot first: <ids>`.

**No over-admission.** Every path that starts work from a slotless state (`answer`, `flow.replan`, `resume`, the engine's grant, admission) decides inside a store transaction, and SQLite serializes them, across connections and processes. Two answers arriving together: the first takes the slot, the second sees it taken and waits.

**Merge holds.** `mergesInFlight` (R5) judged a flow at its merge step as in flight unless stopped, held or uncertain. A flow answered `merge` that is waiting for a slot is now not progressing either. Without this, with one slot, a flow at source would wait for that merge while the merge waited for the flow's slot.

**What still applies to parked flows.** Path overlap (declared paths, plan files and candidate changes), area occupancy, "task already active", merge holds and main health all read every unfinished flow as before. `blocksDrain` is unchanged: a parked change or document flow still blocks `config.update`, doctor and an upgrade, because its worktree and pinned executor are in use. Workspace cleanup still refuses any unfinished flow.

**Where it shows.**

- `queueStatus(store).capacity`: `{maxParkedFlows, parkedCount, waitingCount, pools: {change, document: {max, inUse, working, stopped, parked, parkedHoldingSlot, waitingForSlot, free}}, categories: {<name>: the same counts, for categories with a limit}, parked: [{flowId, taskId, title, pool, step, since, holdsSlot}], waiting: [{flowId, taskId, pool, category, step, since, after, merge, position, of, reason}]}`. It is in the full `status`, in `status --compact` and the dashboard snapshot (which reads through a projection without workflows; the step kind of candidate flows is read by primary key).
- Flow lists (`status`, `status --compact`, the dashboard) carry `parked: true|false`; the dashboard projection also carries `slotWait`, `parkedAt`, `pool` and `stopRequested`.
- `status --flow`: `flow.parked`, `flow.parkedAt`, `flow.slotWait {position, reason, …}` and `project.capacity`.
- Console Queue tab: a **Flow slots** card (slots in use and free per pool, parked flows labelled Parked and, beyond the limit, Holds a slot; answered flows with position and reason). "Started from the queue" says "parked on an answer" or "waiting for a slot" instead of the bare state.
- A waiting flow's reason, computed when read: `Waiting for a change flow slot (1 of 1 in use, policy.maxFlows): position 1 of 1. It continues by itself, ahead of queued tasks, when one of these finishes, parks on a question or is abandoned: <flow ids>.`

### Interactions checked

| Area | Result |
| --- | --- |
| R3 parked-question wake | Unchanged. Slot waiting writes nothing; a grant is one write, which steps parked questions once, as any write does. Test: change token equal before and after stepping a waiting flow; a parked question is quiet across a tick. |
| Merge holds (R5) | A slot-waiting merge is not in flight (above). Tested. |
| Handoff and notification counts | No new inbox items or deliveries for parking, slot waits or grants (`flow.slot-wait` and `flow.slot-granted` are events, not state events for the webhook). The only new delivery in this change is one per merge question whose target first moves (item 4). |
| Doctor and upgrade drain rules | `blocksDrain` unchanged; a parked change flow blocks a configuration update. Tested. |
| Workspace cleanup | Unchanged: only failed, abandoned and completed flows; a parked flow's workspace is refused. Tested. |
| Idle-capacity notice | `freeSlots` is now the change pool's slots free for queued tasks: a parked flow's slot counts as free (so "queued work is not starting although slots are free" is raised, with the blocking reasons, for example a path overlap with the parked flow), and a slot an answered flow is waiting for does not. It also stops counting document and task flows against change slots, which it did by mistake. Tested. |
| Spending and provider holds | A flow waiting on a provider usage-limit hold is at an effect step and keeps its slot (tested). An answered flow takes its slot first and then meets a provider hold like any flow. Admission's provider-hold check is unchanged. Spending holds act on reservations and on integration questions of maintenance flows, which are not pooled flows. |
| Machine sample | `capacity.activeChanges` is slots in use, `availableChangePermits` slots free for queued tasks, and `parkedChanges` is new. |

### Compatibility

- **Upgrade.** No migration. Flows waiting on answers are parked from the first read. Flows written by dev.82 have no `parkedAt`; they are ordered by `createdAt` for the allowance, and status shows `since: null` for them.
- **Config.** New key `policy.maxParkedFlows`: a whole number 0–50, default 3, live (`settings.update`), in the starter template, the console's settings and `docs/commands.md`. A configuration without the key gets the default. To keep the dev.82 behaviour set it to `0`.
- **Behaviour an adopter will notice.** With `maxFlows: 1`, a second task starts while the first waits on a plan or merge question, so up to four change flows (and their worktrees) can be open at once by default. An answer may be followed by a wait for a slot instead of immediate work. `resume` may wait for a slot in the rare case that the flow had none.
- **New record fields.** `flow.slotWait`, `flow.parkedAt`; events `flow.slot-wait`, `flow.slot-granted`. `queueStatus` gains `capacity`.
- **Reason strings.** `flow capacity exhausted` and its stopped-flows form are unchanged; two clauses can now follow (`parked flows beyond policy.maxParkedFlows (N) hold slots: …`, `answered flows take the next free slot first: …`). `document flow capacity exhausted` can carry the same clauses, and now also the stopped-flows clause. `category capacity exhausted: <name>` can carry the parked and answered clauses, with "places" for "slots".
- **Category limits.** A project that set `policy.categoryLimits` to keep one flow of a category open at a time will now see a second one admitted while the first waits on a question. The limit still holds for flows doing work. `policy.maxParkedFlows: 0` restores the old count.
- **The triage example** (`project/integrations/triage.example.mjs`) now lists each open flow in its idle finding with what it does about a slot (`holds a slot`, `parked on an answer, holds no slot`, `parked on an answer beyond the parked limit, holds a slot`, `answered, waiting for a slot`). A snapshot without the new fields reads as before. Projects that copied the example keep their copy.

## 2. G5: integrated target files counted as the flow's own changes

**Problem.** `activeConflictPaths` listed `git diff <worktree base>`. After a flow integrates a target that moved, that diff also lists every file other work merged, so a docs-only flow at its merge question blocked a `src/` task with "paths overlap".

**Fix** (`operations/conflicts.mjs`). The diff is taken against the integrated target, `flow.results.integrate.base`, when the factory recorded an integration and the candidate really contains it (`git merge-base --is-ancestor <base> HEAD`) or is merging it (`MERGE_HEAD`, a conflicted integration). Otherwise (no integration recorded, or a candidate that does not contain the recorded one) the worktree's original base is used as before, which can only list more. Declared paths, plan files, uncommitted and untracked files count as before. Two more local Git reads per observation at most.

**Compatibility.** Narrower exclusion only where an integration is recorded and verified in the worktree. A builder that merged the target itself without a recorded integration is still read conservatively.

## 3. G10: `flow.start` just after an outside push stopped at `source`

**Problem.** The source check found the target at a head nobody had verified, nothing was verifying it yet, and the flow stopped: "main is not verified for source admission … then resume this flow". Main went green ten seconds later; the flow stayed stopped.

**Fix.** R5's wait rule is unchanged: a flow waits while a `main.verify` for its target is queued or running and can proceed, and stops when it cannot (`operations/merge-hold.mjs`). New: when nothing is verifying the target, the engine asks for the verification and then applies that same rule.

- `verificationRequest(store, target, {cause})` in `operations/main-freshness.mjs` is the per-target part of `ensureMainVerification`, now shared. It queues one `main.verify` under the existing configured grant (`{actor: operator, source: configuration, policy: autoQueue}`) or returns `{refused, action}`. It refuses when: the project is not in delivery mode; `policy.autoQueue` is off; doctor has not passed for the current configuration; admission is paused or under a recovery hold (jobs would not start); the target is red (or its scheduled tier is red and the target has not moved since); or a verification of the target failed within the last 15 minutes. These are the conditions queued work already had, plus the pause check (the operations loop only called it when not paused).
- The engine (`requestSourceVerification`, at settlement of a `source.verify` that reported `target-unverified`) calls it when `sourceWait` finds nothing on its way. A queued job is then judged by `sourceWait` like any other, so a job that cannot start (maintenance held, a stopped occupant of the maintenance slot) still stops the flow naming the verifier. A newer green verification means nothing is asked for (the earlier stop stands). Target synchronization keeps its own stop-and-resume handling.
- **Bound.** At most `SOURCE_VERIFY_REQUESTS` (3) requests per source visit; then the flow stops and says so. Each request follows a real verification, so this only ends a target that keeps moving or a persistent disagreement.
- **Otherwise it stops with the action.** For example: `main is not verified for source admission and no verification was requested: automatic verification is off (policy.autoQueue). To continue: run main.verify for main (job.enqueue {operation: "main.verify"}) or doctor; wait for current green verification, then resume this flow. Queued work remains held.`

**Compatibility.** With `policy.autoQueue`, a flow that would have stopped at source now waits and continues by itself. Without it the flow stops as before, with a longer reason. New flow field `sourceVerifyRequests`, new event `flow.verification-requested`; `main.verify-requested` gains `cause`. `ensureMainVerification` behaves as before.

## 4. G9: the target moves while a merge question is open

**Problem.** Unchanged since dev.81: a commit pushed to the target while a merge question was open was neither stated on the question nor re-checked. The merge went through with no new integration or gate run.

**What `forge.merge` already did.** It routed `stale` (back to `integrate`) when the pull request's head or `base` differed from the integrated one. But the forge's `base.sha` is what the pull request was last synchronized with; it does not change when only the target moves. So a moved target was never detected, and the forge merged onto it.

**Decision** (confirmed by the operator, 2026-11-15). The merge answer on a moved target goes back to integration **when the move touches the candidate**, and merges **when it does not**; the card says which, before the answer. For a merge that goes ahead the card says plainly that it merges onto the moved target without integrating again, that the review and the checks ran against the earlier target and are not repeated, and that only post-merge verification checks the combined result. "Touches" means: a file the target's new commits changed is a file the candidate changed since integration, or is under a path the task or reviewed plan declares. If that cannot be told, it counts as touching. Why not always re-integrate: with parked flows freeing slots, several merge questions are normally open at once, and every merge moves the target. Sending each later merge back through integration, review and the gate would double the review cost of ordinary operation, for flows that admission already keeps path-disjoint. Why not never: the trial's case was a direct push to a file in the task's paths, and the gate had not run on that combination. The rule mirrors `policy.followTarget` for plans (carry on when main's changes miss the planned paths, replan when they hit them). No graph changed, so no digest or approval is affected.

**Fix.**

- `operations/target-move.mjs`: `targetMove(cwd, {base, head, scope})` compares, with three local Git reads and no network, a known target head with the integrated base. Not moved when the head is the base or an ancestor of it. Moved with `overlap` listed when the head's commits are local. Moved with `overlap: null` when they are not. `targetMoveText` writes the paragraph for all three.
- **The card** (`core/engine.mjs`, question step). For a merge question of a flow with `results.integrate.base`, the engine compares the recorded target head (`targetHealth(...).head`) with it, only when either changes (a per-flow memo; nothing per tick). On a move it sets `item.targetMoved {target, from, to, changed, overlap, overlapCount, observedAt}` and puts the paragraph in `item.context` (after an adopted pull request's own context). The first move raises `item.version`: an answer given on the earlier card is refused (`stale or resolved question`) and the notification consumer gets one delivery for the new version. Later moves update the text only. A question that opens after the move carries the note from the start. Events `inbox.target-moved`, `inbox.target-current`. The question's subject digest is unchanged.
- **How the factory learns of an outside push.** The recorded head changes with a verification, another flow's merge, a source check, and the target probe. The probe (`probeTargetHead`) ran only under `policy.autoQueue` and only while work was queued, once per `policy.mainProbeMs`. It now also runs for a target with an open merge question, with or without `policy.autoQueue` (operator decision, 2026-11-15): one `git ls-remote` per target at most every `MERGE_QUESTION_PROBE_MS`, five minutes (or `policy.mainProbeMs` when that is longer), only while such a question is open, never per tick. `policy.mainProbeMs: 0` still turns all probing off. Why five minutes: a merge question waits on a person, usually for minutes to hours, so the card is current before most answers; the merge step reads the target itself whatever the card says, so a later notice loses only the advance warning; and it bounds the cost at 12 remote reads an hour per target. A move the probe finds makes the target's health unknown, as it always has for queued work. Without `policy.autoQueue` nothing verifies the target automatically, so admission then reports `main health unknown …: Main moved outside the factory …; run main.verify to refresh it` until someone does (before, such a project admitted the task and stopped it at source).
- **The merge step** (`workflows/dispatch.mjs`, `forge.merge`). After the existing check it reads the target's head from the remote, fetches it, and applies `targetMove`. Moved and touching (or unknown): `{route: 'stale', reason: 'target advanced before merge: …', targetMoved}`, before any forge write; the existing `stale` edge returns the flow to `integrate`. Moved and disjoint: it merges, and the merge result carries `targetMoved`. Unreadable target: it merges as dev.82 did, and the result carries `targetMoved {unknown: true, error}`.

**Compatibility.** A merge answered after an overlapping move now re-integrates and asks again instead of merging. A merge after a disjoint move behaves as before, with the move recorded. One `git ls-remote` and, when the target moved, one fetch per merge step, and at most one `git ls-remote` per five minutes per target with an open merge question (new for projects without `policy.autoQueue`, whose target health can now turn unknown from an outside push). A question's version can now rise while it is open. The race between this read and the forge's merge remains without remote branch protection (as README "Boundaries" says).

## Tests

New: `tests/admission-capacity.test.mjs` (42 tests) and `tests/console-flow-slots.test.mjs` (2), and one test in `tests/triage-proxy.test.mjs` for the idle finding's wording. Updated for intended changes: `tests/queue-status.test.mjs` (queue status has `capacity`), `tests/target-sync-health.test.mjs` (the source-drift test now expects the wait under `autoQueue`; a new one keeps the stop without it) and `tests/external-pr-adoption.test.mjs` (its "stop stands" case now sets `autoQueue: false`).

What they cover:

- **Capacity counts:** parked, working, stopped; waits that are not answers; every question step of the reference graph; a flow that reached a question not yet opened; document and task pools.
- **Parked limit:** default 3, the fourth holds a slot, a larger or smaller limit, `0`; a flow beyond the limit keeps its slot through its answer.
- **Resume ordering:** an answer with no slot waits unstopped with reason and position; the queue cannot take the freed slot; the engine grants it; FIFO among waiting flows; a later waiter stepped first does not jump the line.
- **Answered merges first:** a merge answered after two other answers goes to position 1; it gets the freed slot, then the others in order, then the queued task; a merge answered just after a slot frees takes it although another answered flow waits.
- **Category places:** a parked flow frees the category's only place; a working, stopped or over-the-limit parked flow holds it; an answered flow waits for a place although slots are free, with the reason naming the category; it does not hold up an answer in another category; the freed place goes to it before a queued task of the category.
- **No over-admission:** two answers through two connections to the same state; never more unsettled attempts or working flows than slots, however the engine steps; two slots admit two.
- **Path overlap with parked flows:** declared paths and worktree changes block, unrelated work is admitted; area, category limit and own-task checks.
- **Stop, resume, replan; upgrade; drain; cleanup; idle notice; the R3 wake; auto-merge; all four status surfaces; configuration.**
- **G5:** the report's scenario with real worktrees, the unrecorded and not-contained fallbacks, pending work, a conflicted integration.
- **G10:** request and wait, continue without resume; five refusals with their reasons; a job that cannot start; the bound.
- **G9:** the card for an overlapping move (text, version, refused stale answer), a disjoint move, a second move, an unfetched head, an older recorded head, a question opened after the move; the probe with and without `policy.autoQueue` (one read, none again within five minutes however often the loop runs, the move noticed after five, none once the question is answered, none without a merge question, off at `mainProbeMs: 0`, a longer `mainProbeMs` kept); `targetMove`; the merge step through `runAction` with a fictional `gh` and a bare remote (unchanged target merges; overlapping push returns `stale` with no merge call; disjoint push merges and records the move); a `stale` result returns the flow to `integrate`.

### Fail-before evidence

Run against an export of the base commit `159d54c` (`git archive`), with the new and updated test files copied in:

- New test files as they are: `admission-capacity.test.mjs` cannot load (`ERR_MODULE_NOT_FOUND` for `operations/capacity.mjs`) and both console tests fail: 3 fail, 0 pass.
- With the two new helper modules copied in (`operations/capacity.mjs`, `operations/target-move.mjs`; nothing at base uses them) and the engine constant inlined in the test: 39 tests, **32 fail, 7 pass**. The seven that pass assert behaviour this change keeps: the document and task pool counts (a direct test of the helper), area, category and own-task exclusion, workspace cleanup refusal, the `targetMove` unit cases, a merge with an unmoved target, the existing `stale` edge, and the auto-merge flow keeping its slot.
- The three updated existing files at base: 41 tests, 3 fail (the two source-drift tests and the queue-status test), 38 pass.

That was the first version (`2bb18a4`). The tests added for the 2026-11-15 decisions were run against the first version's source (`84c7be3`) the same way; see "After the decisions" below.

### After the decisions (2026-11-15)

The operator answered this record's five open questions (category limits, answered merges, expired questions, re-integration, the probe without `autoQueue`); the "Decisions" tables and the sections above describe the result. Main was merged first (the dev.83 planning and builder-question work): merge commit `c382767`. Two files conflicted. In `core/engine.mjs` both sides had changed the line that builds a new question item; the resolution takes main's line (its `carriedQuestions` and build-question card fields) and keeps this change's two lines after it (the target-move note and `parkedAt`). In `docs/running.md` both sides had extended the `status --flow` paragraph; both additions are kept. The full suite passed on the merge (1105 tests) before anything else changed.

Fail-before for the decision tests: the current `tests/admission-capacity.test.mjs`, `tests/console-flow-slots.test.mjs` and `tests/triage-proxy.test.mjs` run against an export of the merge commit `c382767` (the source before the decisions; the new probe constant inlined in the test): 66 tests, **10 fail, 56 pass**. The ten are the two category tests, the two merge-order tests, the two probe tests, the disjoint-move card text, the console card's category line, and the two triage idle-finding tests.

### Results

First version, at commit `2bb18a4`:

- `npm test`: 1088 tests, 1088 pass, 0 fail, 0 cancelled, 0 skipped.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

An earlier full run had one failure in `tests/launch-liveness.test.mjs` ("a stop request received before ownership means the effect is never started"), a supervisor timing test, while other test suites were running on the host (load average about 14). It passed alone and in the final full run; this change does not touch what it exercises.

After the merge of main and the decisions, at commit `c38d973`: `npm test` 1111 tests, 1111 pass; `npm run eval` exit 0; `git diff --check` clean.

After the review fixes and the second merge of main: see "Review fixes" below.

## Review fixes

An independent review (Fable 5.2) of `c38d973` approved the change with fixes: one blocking finding and five others. A 200-seed randomized admission probe held apart from finding 1; no deadlock was found; G5 stayed narrow; G9's renames, authentication and stale refusals, the merge resolution, store reads and idle cost held.

### 1. Blocking: `flow.replan` could start work without a slot

**Problem.** `flow.replan` applied the slot rule only to a flow that was parked (waiting at a question), waiting for a slot or stopped. A flow in state `ready` at a question or end node was treated as holding a slot, which it may not: a parked flow answered `stop` sits at the `stopped` end node until the engine's next tick, and a parked flow that was stopped and resumed sits at its question, not yet asked again. Replanning either sent it to the plan step beside the flow that had taken the slot. With `maxFlows: 1`: park A, admit B, answer A `stop`, `flow.replan` A (repro A); or park A, admit B, stop A, resume A, replan A (repro B). The window is one tick normally and a whole recovery hold otherwise, and the same path could break a category limit.

**Fix** (`core/project.mjs`, `flow.replan`). Only a flow at a working step that is neither stopped nor waiting for a slot is taken to hold one. Every other flow goes through `takeSlot`: a parked or waiting flow joins the line at its place (`ahead: true`, as before); a stopped flow, a flow at a question or end node in any other state, and a finished flow continue only if their pool (and category) has room without them (`ahead: false`), and otherwise wait. A flow that really held its slot passes that test, so a replan from a question the engine has not opened yet still continues at once.

**Pre-existing gap closed.** `flow.replan` also accepted a finished flow (abandoned, or failed) and returned it to the plan step with no check at all. It now takes a slot or waits like the others, and is refused when something admitted since excludes it: `admissionReasons` for its task is read, and the reasons a stopped flow would have kept others away with (the task has another open flow, its area is occupied, its paths overlap, or the conflict evidence is unavailable) reject the command: `cannot replan finished flow <id>: paths overlap: <flow>; abandon or finish that work first, or start the task again (task.restart)`. Health, approval-of-workflow, queue and schedule reasons are not applied: a replan is a recovery of admitted work, not a new admission.

**Tests.** Both repros; a flow that really holds its slot replans at once; the abandoned-flow cases (waits for a slot; refused for overlapping paths; refused when its task was started again). **A randomized regression test** is kept: 50 seeds of 60 steps over `flow.start`, reaching and opening a question, `answer`, `stop`, `resume`, `flow.replan`, `flow.abandon`, finishing and engine steps, with one to three slots, a random parked limit and a category limited to 1. After every step it checks that no more flows are at a working step than there are slots, and no more of the limited category than its limit, and it requires that at least a tenth of the steps had more open flows than slots (a first version of the walk kept only one flow open most of the time and did not find the bug). It runs in about 8 seconds. On `c38d973` it fails (first at seed 13: two flows of the limited category at work).

### 2. A waiting flow blocked on a full category held a pool slot back

**Decision (operator).** A pool slot is reserved only for a waiting flow the allocation can grant now. One waiting on a full category keeps its place in the line and reserves nothing.

**Fix** (`operations/capacity.mjs`). `slots()` runs the allocation once and records, per pool and per limited category, the waiting flows it would grant (`reserved`); `freeForNewWork` subtracts those instead of every waiting flow, and the "answered flows take the next free slot first" clause names only them. `categoryWaits(state)` lists each waiting flow that a full category holds back while its pool has a slot nobody is using, with the category, its count and the flows that hold it. It is in `queueStatus.capacity.categoryWaits`, in `status --flow` (`project.capacity.categoryWaits`), in the console's Flow slots card, and in the idle-capacity notice (`categoryWaits` on the item, and its summary).

**Tests.** The reviewer's repro (`maxFlows: 2`, `categoryLimits: {db: 1}`, park A, admit B, stop B, answer A): a queued `ui` task is admitted; queue status names the waiter, `db` and the stopped holder; when the place frees the waiter is ahead of a queued `db` task. The idle notice carries the same.

### 3. `git ls-remote` took the first matching line

`git ls-remote <remote> refs/heads/main` also lists `refs/heads/a/refs/heads/main`, and lists it first. `remoteRefHead(stdout, ref)` (`core/git-options.mjs`) returns the commit of the line whose ref is exactly the one asked for. It replaces the first-field parse at every site: the merge step, the source check and the satisfied-outcome check (`workflows/dispatch.mjs`), the target probe and the sync probe (`operations/main-freshness.mjs`), main verification and both audit checks (`workflows/maintenance.mjs`), and the operator-checkout and workflow-target checks in doctor (`workflows/commission.mjs`). Tests: the helper; the probe with the other branch's line first; the merge step against a real remote that has a branch named `a/refs/heads/main`.

### 4. The merge step's remote read had no working timeout

`exec('git', …, {timeout})` in `workflows/dispatch.mjs` passed no options to the workspace adapter, so the 30 s named there never applied and a remote that did not answer ran into the attempt's own timeout, failing the change flow where the design says "fall back". The workspace adapter's `git(cwd, args, {timeoutMs})` now terminates Git and its descendants at the timeout (SIGTERM, then SIGKILL after one second), so no transport helper or `ssh` outlives it; the call fails with `timedOut`. (As first written it ran Git in its own process group and killed the group; the re-check found that this took Git out of the attempt's group, see "Re-check fixes" 1. Main added a `timeoutMs` there at the same time, killing only the Git process; the merge keeps main's result contract.) The merge step's `ls-remote` and fetch use it (`observeMergeTarget`, 30 s each). The two end differently. A head that cannot be read (`ls-remote` fails or times out) is an unreadable target: the merge proceeds as dev.82 did and records `targetMoved.unknown`. A head that was read and differs but whose commits cannot be fetched (the fetch fails or times out) is a known move of unknown extent: `targetMove` reports it with `overlap: null` and the step returns `stale`, which is the safer of the two. (This paragraph first said a timed-out fetch also merged as dev.82 did; it never did.)

**The other `exec` Git calls.** They all dropped `timeout` the same way. The two other remote head reads (the source check and the satisfied-outcome check) now enforce their 30 s (`enforceTimeout`); they fail their step on a hang as before, only sooner. The rest are left unbounded by `exec`, and the comment there says why: the local reads (`status`, `rev-parse`, `diff`, 10 s named) finish in milliseconds, and making the source check's nominal 30 s apply to its `fetch` would fail fetches of large repositories that take longer and work today. All of them remain bounded by their attempt's timeout, at which the supervisor ends the attempt and its processes.

**Tests.** A local server that accepts and never answers: the read returns `unknown` with "timed out after 700 ms" in under five seconds and the connection it held is closed (nothing left running). A remote that cannot be read at all: the merge goes through with `targetMoved.unknown`.

### 5. Strict branch protection after a move to unrelated commits

With "require branches to be up to date", the factory would merge onto a disjoint move, GitHub refuses, and the flow failed. The forge adapter's `merge` now recognises that refusal: a definite (not ambiguous) 405, 409 or 422 whose text says so ("out of date", "not up to date", "Base branch was modified"), or, when the text does not, a pull request that reads `mergeable_state: behind` on a second read. It throws a `ForgeError` of kind `out-of-date`; the merge step returns `stale` with `outOfDate: true` (and `targetMoved` when it had seen the move), and the flow re-integrates. Other refusals (a missing review, a failed required check) and uncertain outcomes are unchanged. `readPR` now returns `mergeableState`. Not verified against the live service: the exact wording of GitHub's refusal is assumed, which is why the pull request's state is read as well.

**Tests.** The adapter with a fictional transport (said in the text; not said but `behind`; another 405; a 403; an ambiguous 502). The merge step with a fictional `gh` that enforces the rule against the real remote: up to date merges; a push of unrelated files returns `stale`, not a failure.

### 6. Smaller items

- **The probe checks the due time first.** It read the queue and every live flow each tick before looking at the time. It now filters targets by the shorter bound first, and remembers the database state in which a due target had no reason to be read (no queued work, no merge question), so an idle project reads its flows once, not every tick.
- **The probe runs while admission is paused or under a recovery hold,** for open merge questions only (`mergeQuestionsOnly`); queued work is no reason then.
- **A version bump ends a pending presentation.** `endPresentationsForChange` (`core/communication.mjs`) ends it as `obsolete` with the reason and wakes the presenter, as a resolution does; the question stays open and can be presented again at its new version. Before, an answer relayed through the prompt channel was refused as stale with nothing telling the presenter.
- **A target moved back counts as moved.** `targetMove(..., {live})`: a head that is an ancestor of the integrated base is `rewound` when it is known to be the target's current head. The merge step always knows (it has just read it) and returns `stale`. The card treats a recorded head as current only when it was observed after the question opened, by the probe (`previousHead`) or a verification (green or red); an older record is still not a move.
- **The move memo refreshes.** A result whose commits were not local (`overlap: null`) is compared again once the question's revalidation interval has passed, so the card gains the overlap after any fetch, without the head changing.
- **G10 race.** A target verified green while the source check ran no longer stops the flow: the check is repeated on the next tick (`flow.source-recheck`), counted with the verification requests, so at most three times per source visit.

### Second merge of main

Main (`7875bdd`: external pull request notices and adoption fixes, console work) was merged after the fixes: merge commit `ec4d0dd`. Three files conflicted.

- `adapters/workspace/index.mjs`: both sides gave `gitOnce` a timeout. Main's result contract is kept (`code: null`, `timedOut: true`; with `allowFailure` it resolves), with this change's process-group termination.
- `operations/admission.mjs`: main split `admissionReasons` into a wrapper that collects structured facts for display; this change had replaced the capacity counts. Main's structure and facts are kept with this change's capacity and category reasons. The capacity fact now carries the flows by what they are (`flowIds` for stopped ones, as main had; `parkedFlowIds`, `answeredFlowIds`, `maxParkedFlows`, `pool`), and `console/ui/admission.mjs` renders each clause with links.
- `workflows/dispatch.mjs`: both sides added an import; both are kept.

`core/engine.mjs`, the queue UI and queue status merged without conflict. No new failure notice was added outside main's path: an action's refusal still reaches the operator through its `notice` (`attemptNotice`), and this change's new stops (the source-step reasons) go through `stopFlow` like the stops they replace; the out-of-date refusal is a `stale` route, not a failure.

### Evidence

Fail-before, the current `tests/admission-capacity.test.mjs` and `tests/target-sync-health.test.mjs` against an export of `c38d973`: 76 tests, **20 fail, 56 pass**. Of the 19 review tests 17 fail there, the random walk among them. The two that pass assert behaviour the reviewed commit already had: a flow that really holds its slot replans at once, and an unreadable target merges as dev.82 did. The other three failures are earlier tests whose expectations changed with fixes 2 and 6 (the waiting clause names only flows that can take the slot now; the source check is repeated).

The review-fix commit `03bb4c8` was made with one assertion of its own new console test wrong (a space in the expected text); the merge commit `ec4d0dd` corrects it. Every other test passed at `03bb4c8`.

Results after the fixes and the merge, on the tree this record is committed with: `npm test` 1186 tests, 1186 pass, 0 fail, 0 cancelled, 0 skipped; `npm run eval` exit 0; `git diff --check` clean.

## Re-check fixes

The re-check (Fable 5.2) of `1ab4356` approved it with no blocking finding: a 700-seed probe found no over-admission, no stuck waiter and no deadlock; main's behaviour is intact; idle cost has not regressed; the choice not to enforce the nominal fetch timeouts was confirmed. Four small items were fixed and two recorded as limits.

1. **A time-limited Git call left the attempt's process group.** With `timeoutMs`, Git was spawned `detached` so that its group could be killed at the timeout. The supervisor stops an attempt by signalling the attempt's group, so a stopped or timed-out attempt left that Git running, under the process supervisor with nothing to end it (the merge step's two reads, and the source and satisfied-outcome head reads). Git now stays in the caller's process group. At the timeout the adapter reads Git's process tree from `/proc` (`processTree`: the process and everything below it, each with its start time), signals exactly those processes (one whose ID has since passed to another process is skipped), reads the tree again before the kill for anything started in between, and kills what is left after one second, or as soon as Git has ended. No process is ever selected by name. Test (the reviewer's repro): a worker started as the supervisor starts one (the leader of its own group) makes the bounded `ls-remote` against a remote that never answers; every process of the call is in the worker's group; one `SIGTERM` to the group, and none of them is left and the connection is closed. The earlier timeout test (a hung remote ends the read at its bound, with nothing left running) still passes.
2. **The probe's "nothing to probe" memo could suppress a due read.** It was keyed on the database state alone. With two targets, one always due with no reason and one with a merge question, the memo set while the second was not due stayed valid when it became due, as long as nothing was written: the question's target was not read again after five minutes. The key now includes the due targets, so a target that becomes due is always looked at. Test: two targets, a merge question on the second, no write in between; the second is read again at five minutes.
3. **A replanned flow could take a free slot ahead of a flow already first in line.** `flow.replan` passed `ahead: false` for a stopped, finished or question/end-node flow, which only asked whether its pool had room without it, and the comment said it would not get ahead of waiting flows. Every gated replan now joins the line in order (`takeSlot` with its default): it continues at once only if the allocation reaches it after every flow already waiting. A replanned stopped flow therefore does not keep its slot ahead of a waiting flow, unlike a resumed one; `resume` is unchanged. The comment says so. Test (the reviewer's repro): one slot, A answered and waiting, B abandoned, B replanned before a tick: B waits at position 2 and A gets the slot whichever is stepped first; and a stopped flow replanned while another waits goes behind it.
4. **The docs were wrong about fetches.** `docs/operations.md` and fix 4 above said a timed-out fetch counts as an unreadable target and merges as dev.82 did. Only a failed or timed-out `ls-remote` does; a failed fetch after a head that differs returns `stale`. Both texts and the comment in `workflows/dispatch.mjs` now say that.

Fail-before, the current `tests/admission-capacity.test.mjs` against an export of `1ab4356`: 64 tests, 3 fail (the three tests above), 61 pass.

Results on the tree this section is committed with: `npm test` 1189 tests, 1189 pass, 0 fail, 0 cancelled, 0 skipped; `npm run eval` exit 0; `git diff --check` clean.

## Limits

- **An answered flow can wait a long time.** With one slot, a flow answered while another is mid-build waits until that one finishes or parks. An answered merge goes ahead of other answered flows, but it too waits for the working flow. The wait is visible and ends by itself.
- **An expired question holds a slot.** A question unanswered for its expiry (24 hours by default) stops its flow, and a stopped flow holds a slot (and its category place). With one slot the queue then waits for a resume or an abandon. This is the operator's decision; `docs/operations.md` says so.
- **A merge onto a moved target is not re-checked when the move is elsewhere.** When the target's new commits touch none of the candidate's changed files or declared paths, the merge goes ahead and the review and gate results are those from the earlier target. "Elsewhere" is a path test, not a semantic one: a target change in another file can still break the candidate (a renamed function it calls, a changed interface, a dependency bump, a second migration with the same number). Such a conflict is found by post-merge verification, after the target already contains it, and main is then red until it is fixed. The card states this before the answer; the merge result records the move (`results.merge.targetMoved`). Projects that cannot accept it need remote branch protection that requires an up-to-date branch, or the stricter rule (`needsReintegration` in `operations/target-move.mjs`).
- **The read-to-merge race remains** without remote branch protection: a push between the merge step's read and the forge's merge is merged onto.
- **An unreadable target merges as before.** If `git ls-remote` fails at the merge step, the dev.82 behaviour applies and the result records `targetMoved.unknown`.
- **The card can lag by five minutes,** and shows only the first outside move until the target is verified again: the probe reads targets whose health is green, and a move makes it unknown. With `policy.autoQueue` the verification follows when work is queued; without it, someone has to run `main.verify`. The merge step's own read is not affected.
- **`policy.mainProbeMs: 0` turns the merge-question probe off too.** Then the card learns of a move only from verifications, merges and source checks.
- **A flow waiting on a full category can wait longer than one waiting on a slot.** It reserves no pool slot while its category is full (review fix 2), so queued work of other categories may take the free slot; when its category frees, it is first in line for the next slot, which may not be free at that moment.
- **A category shared by the change and document pools can pass over its waiter** (re-check finding 4, recorded, not fixed). Category places are counted across both pools, but each pool has its own slots. The line is walked once, in order, and a flow that cannot be given both a slot of its pool and a place in its category is passed over. So a waiting change flow of a limited category whose pool is full can see the category's one free place go to a later waiting document flow of the same category whose pool has room, and then wait for that flow as well. Nothing over-admits and the flow is not stuck; it waits longer than its place in the line says.
- **"Due time first" holds only partly while `policy.autoQueue` is on** (re-check finding 6, recorded, not fixed). The probe filters targets by the shorter bound (`policy.mainProbeMs`, a minute by default). A target with an open merge question and no queued work is read every five minutes, but counts as a candidate again after one minute, so for the other four the probe reads the queue and the live flows on each operations tick before finding that the read is not due. The reads themselves stay bounded; the cost is the lookup. Without `autoQueue` the five-minute bound is used for the filter and the lookup is skipped.

## Open questions

None from this change. The five raised by the first version were decided on 2026-11-15 and are recorded above.
