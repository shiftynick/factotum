# Knowledge upkeep, slice 2: the observe-only job, its scheduling, and settings authority

Design: [knowledge-upkeep.md](../designs/knowledge-upkeep.md), section 15, slice 2. Base: `main` at `283ba91` (slice 1). Built in `0ff0777`; `main` at `cb9a351` (dev.86) merged in `2e3d9f3`, without conflicts. Review fixes in `0ae7737`, see [Review](#review-of-abe0aa1); the re-checks' in `6953526` and in the commit that carries this revision of the record, see [Re-check](#re-check-of-8e32247) and [Second re-check](#second-re-check-of-50da357). Slice 1: [upkeep-slice1.md](upkeep-slice1.md).

This slice makes upkeep run for the first time, in its deterministic part only. With `upkeep.mode: "observe"`, each merged change or document flow gets one run that records what the pre-filter found. **No model is called, no candidate row is written and no task is created**; those arrive with slices 3 to 5. Upkeep stays off unless the operator turns it on.

**Two existing behaviours change.** The `upkeep` and `learnings` configuration blocks are now validated, so a block the last release ignored can be refused. And `upkeep.mode: "propose"` is refused, because this release has nothing behind it. See [compatibility](#compatibility-and-adopter-notes).

## What was built

| Piece | Where |
| --- | --- |
| The settings: blocks, defaults, validation, the mode, the upkeep authority value | `core/upkeep-config.mjs` (imports only `contracts` and `workflow-kinds`) |
| The kind of a catalog definition, shared by the catalog compiler and the validator | `core/workflow-kinds.mjs` (imports nothing) |
| The life of a run: receipt, queueing, deadlines, the tick, start, settlement, a run by hand | `operations/upkeep-runs.mjs` |
| Classification with governing subtraction, and the pre-filter (pure functions) | `operations/upkeep-prefilter.mjs` |
| The assessment a run makes: Git through verified objects, records by key | `workflows/upkeep-assess.mjs` |
| The run ids in the `upkeepWork` meta row | `operations/upkeep-records.mjs` |
| The receipt at merge settlement; the run closed at attempt settlement | `core/engine.mjs` (`settle`) |
| Conversion when the retrospective is recorded | `operations/governance.mjs` (`recordRetrospective`), `core/project.mjs` (`stopFlow`) |
| The upkeep lane and the tick | `workflows/maintenance.mjs`, `operations/merge-hold.mjs` |
| Authority on both schemas; the live setting | `core/project.mjs` (`config.update`, `settings.update`), `core/authority-policy.mjs`, `operations/live-settings.mjs` |
| Turning upkeep on over an existing collision | `core/project.mjs`, `workflows/commission.mjs` (doctor) |
| The operation in the lists of 12 | `core/operations.mjs`, `core/command-help.mjs`, `workflows/dispatch.mjs`, `operations/effect-timeouts.mjs`, `core/project.mjs` (`job.enqueue`, quiet completion) |
| The starter block, off, and the checklist entry | `starter/project/factotum.template.json`, `starter/project/SETUP_CHECKLIST.md` |

### The pending receipt and its conversion (5.1)

- **Written at merge settlement.** In the transaction that settles a `forge.merge` result as merged, the engine writes `upkeepRun` for the flow as `pending`, with the merge commit, the integrated base, the target and `pendingUntil` (seven days later). Conditions: the mode is not `off`, the flow's kind is `change` (document flows are change flows in the document pool), and its task snapshot carries no upkeep marker. One per flow: a replayed settlement writes nothing.
- **Queued when the retrospective is recorded**, at both places a retrospective is written: `recordRetrospective` (the flow finished) and `stopFlow` (it stopped). The receipt becomes a queued `knowledge.upkeep` job whose grant is `{actor: operator, source: configuration, policy: upkeep.mode}` with the current configuration digest, and gets `runBy`. A merged flow that then fails or is stopped at a post-merge step is therefore not missed, and a later resume and finish queue nothing more.
- **Nothing for** flows without a proven merge, task flows, maintenance flows (the upkeep flow included), rehearsal flows, and flows whose task carries the marker. With the mode off or the block absent nothing is written at all.
- **By hand.** `job.enqueue {operation: "knowledge.upkeep", payload: {flowId}}`, by the operator or a delegated orchestrator. It writes the receipt if the flow has none (it merged while upkeep was off), keeps the deadlines of one that exists, and is refused once they have passed.

### The lane and the tick (5.2, 4.5)

- The tick reads the `upkeepWork` meta row once. It now also names the runs in hand (`{flow id: status}`), because a run is read by key only. With none, upkeep does nothing more in the tick.
- **Lanes.** The built-in pick ignores upkeep jobs, so a `main.verify` or `target.sync` is chosen exactly as it would be without them. The upkeep lane admits one upkeep flow at a time, after the built-in pick, in the same tick. An upkeep flow is not counted as the occupant of the built-in lane, in the tick and in `pendingVerification` (which decides whether a queued verification is "blocked"). It takes no flow slot and no heavy-work permit.
- **With work in hand**, the tick reads each tracked run by key and then its job or flow by key. It closes receipts at their deadlines, queues pending ones whose retrospective exists, returns a receipt to pending when its job was revoked, and handles a drain. This part runs while the project is paused too.

### Deadlines and the drain rule (5.3)

- `pendingUntil` is written once. `runBy` is set when the receipt is first queued (`upkeep.budget.maxQueueAgeMs` later) and kept through every later change. A smaller configured age shortens it, counted from the first queueing; a larger one changes nothing. The store's own invariant from slice 1 refuses a write that would move either later.
- **Configuration change.** The existing revocation loop revokes the queued job. On the next tick the receipt returns to pending and is queued again under the new digest with the same `runBy`; if that has passed, it is closed `abstained:stale-run`.
- **Drain.** Under `maintenanceHeld` no upkeep job starts and no receipt is queued. A running assessment is asked to stop (with an abort request, and no notice). Once nothing runs for it, the factory ends the flow as `flow.abandon` would, and the receipt returns to pending with the same `runBy`. A flow whose attempt is uncertain is not ended: the existing rule keeps blocking the drain until `attempt.resolve`.
- The start itself checks the deadline in the transaction that admits the flow, and the action checks it again before it reads Git.

### Classification and the pre-filter (6.1, 6.2)

The assessment runs in the upkeep flow's own attempt. It reads the run, the source flow's retrospective and three meta rows by key, and Git through `VerifiedObjects`: no worktree, no `git diff`, no attributes or filters.

1. **Tree comparison.** The merge commit's tree against the integrated base, descending only where the trees differ. A rename is a removal and an addition.
2. **The docs set.** Regular files matching `upkeep.docs.include` less `exclude`; then, in order, governing paths (`governingInTree` from slice 1, so a governing file reached through any link is subtracted), upgrade-owned paths and the learnings directory (resolved in the tree like a governing path). A governing entry the tree cannot place leaves no docs set, recorded as `governing-unresolvable`.
3. **Context files.** Each `context.files` entry that reaches a regular file in the tree, unless upgrade-owned.
4. **Candidates.** A file whose text contains a touched path, or that is mapped to one (`upkeep.docs.map` for a doc, the entry's own `paths` for a context file, matched as the context loader matches them). A file the merge itself edited is a candidate only through a path the merge removed.
5. **Decision.** `nothing` (`no-referring-doc` with `no-signal`, or `weak-signals-only`), or `abstained` with `suspended`, `backlog-full`, `governing-unresolvable`, or `assessment-unavailable` when a model call would follow.

### The run record (8.5)

`upkeepRun` (keyed by the source flow id): `status`, `outcome`, `stage`, `reason`, `flags`, `counts`, the deadlines, the job and flow that ran it. Enums and counters only: a result is reduced to the known lists before it is recorded, and the result field (`upkeepRun`) is privileged to the `knowledge.upkeep` operation. Each closed run adds one to the day's outcome counter (`<outcome>:<reason>`) and one entry to the window. The result always carries `providerInvocations: []`.

### Authority (9.2)

The normalised upkeep authority value has one entry per field, defaults applied: the mode; `upkeep.docs` (`include`, `exclude`, `map`, the three limits, `workflow`); `upkeep.context.maxOpen` and `upkeep.capture.maxOpen`; every `upkeep.budget` field; `providers.upkeep`; `stepModels["maintenance/knowledge.upkeep"]`; and `learnings` (`dir` and the three caps).

- **Both schemas.** `config.update` and `settings.update` refuse a writer who is not the operator when any entry changes, comparing effective values (so `replaceLive`, a dropped key that widens back to a default, and a dropped block are all changes).
- **Schema 2.** The value is also an entry of `authorityPolicy`.
- **The exception, on both.** The mode turned down is not a change of authority. It covers the mode only: down together with another field is refused whole.
- **A stored block this release refuses** (review, P2-2) is read field by field: a field it cannot read is kept in the value as a digest of what is stored, and a refused block is itself an entry. Any change away from such a block is therefore a change of authority, which the operator may make and a delegate may not, not even as "turning the mode down". The comparison never fails on stored data.
- **`upkeep.mode` is a live setting** with the options `off` and `observe`. It is not marked `operatorOnly`, because the rule is directional; the check above enforces it for every writer.
- **Turning it on** (the mode moving up) is refused, by both commands, while an open task the factory did not make is in the reserved namespace. Doctor reports the same for a stored configuration that already has it on. With upkeep on, `task.put` no longer changes a task that was already in the namespace.

## Decisions taken where the design was silent or ambiguous

Each is the conservative reading. Those marked **(Q)** were open questions, now [settled after review](#settled-after-review).

| # | Point | What this slice does |
| --- | --- | --- |
| 1 | The mode has three values in 12; `propose` creates candidates and tasks, which do not exist yet. **(Q1)** | `propose` is refused by validation. A stored `propose` reads as `off`. |
| 2 | 6.2 has no reason for "the pre-filter found something" before the model exists. **(Q2)** | The run ends `abstained` with the new reason `assessment-unavailable`, and records what would have been assessed in its counters. |
| 3 | 12 shows the limits as settings; Q7 and N6 call their values budgets and ceilings. **(Q3)** | Every limit may be lowered; none may be raised above the design's value. |
| 4 | Which commit the merge is compared with. **(Q4)** | The integrated base the receipt records, as 5.1 implies. |
| 5 | "A file the merge changed, renamed or deleted." **(Q5)** | Added paths count as touched. A rename is a removal and an addition, as in 7.4. The edited-file rule is applied to governing files too. |
| 6 | What happens to work in hand when the mode is turned off. | Pending and queued runs are closed `abstained:mode-off`; a queued job is revoked. Turning it on again revives nothing. |
| 7 | "When the retrospective is recorded". | The flow must also have finished or stopped. A retrospective recorded mid-flight (the `retrospective` job) queues nothing. |
| 8 | A fresh receipt under a drain hold. | It is not queued until the hold lifts. A queued job would not block the drain either; this keeps a hold from spending the receipt's 24 hours. |
| 9 | How the tick finds pending receipts when a run is read by key only. | The `upkeepWork` meta row names the runs in hand. At most 200; a receipt beyond that is recorded closed (`work-limit`). |
| 10 | An assessment stopped for a fault (an engine error, an operator stop). | The factory ends the flow and closes the run `abstained:stopped`. It is not retried. Its stop notice stays open. |
| 11 | 12 says the operation is added to each hard-coded list, which includes `schedule.put`. **(Q6)** | Not added there: a run belongs to one merged flow, so a schedule has nothing to name. |
| 12 | A run by hand for a flow with no receipt, and after a deadline. | It writes the receipt with `pendingUntil` counted from now. Past `runBy` (or `pendingUntil` for one never queued) it is refused. |
| 13 | The design gives no bound for the pre-filter's Git reads. | 5,000 touched paths, 20,000 listed files, 2,000 files read, 1 MiB per file. Past them the run records `docs-scan-truncated`. |
| 14 | A merge commit the project repository does not hold yet. | One fetch of the target. Still missing: `abstained:merge-commit-unavailable`. |
| 15 | The learnings directory reached through a link, or unresolvable. | Resolved in the tree like a governing path. Unresolvable: no docs set, recorded `learnings-unresolvable`. |
| 16 | `upkeep.docs.workflow` (7.3 is slice 5's acceptance). | Checked now, so that a slice 2 configuration cannot hold a value slice 5 refuses: it must name a catalog definition that is not of kind `task`. |
| 17 | A repository with replacement refs or a grafts file. | The assessment fails, as every verified read does there, and its run closes `abstained:error`. |

Smaller points, each following the code:

- **`upgrade apply --when-drained`** abandons stopped maintenance runs and queues the same operation after the upgrade. It no longer does that for `knowledge.upkeep`: the receipt returns to pending and the tick queues it again.
- **Doctor, like any command that needs drained flows, is refused while an assessment is running**, as it is during a `main.verify`. An assessment takes seconds.
- **The console's Settings tab shows `upkeep.mode`** (Settings → Policy → Knowledge upkeep), added in the review round. It sends the operator's `settings.update`. The project's settings view says, for each mode and for a reset, why the project would refuse it, judged on the configuration that would result and computed with the functions `settings.update` uses; the row offers the modes it would accept and refuses the form, with those reasons, when none is a change. One case is left to the project's own refusal, shown when the change is sent: while the record layout has not verified the task kind the view cannot look for a namespace collision without reading the whole kind, and a read model must answer the same before and after the layout step (`tests/state-layout.test.mjs`). Runs are still shown only in History; Health is slice 4.
- **`timeouts["knowledge.upkeep"]`** sets the step's limit like any maintenance step (default 10 minutes). It bounds a read-only step and is not part of the authority value.
- **`store.event`** is called for each transition (`upkeep.receipt`, `upkeep.queued`, `upkeep.started`, `upkeep.run-closed`, `upkeep.returned`).

## Not in this slice

- The model call, evidence blocks, the validator, the daily reservation and the `budget` reason, the maintained invocation totals and the counting function (slice 3). `providers.upkeep` and the step model entry are protected now but nothing reads them; `maintenance/knowledge.upkeep` is not yet a model graph, so `stepModels` and `models.update` cannot name it. **Slice 3 must put `models.update` for that step under the same operator-only rule when it adds the graph.**
- Candidate rows, observed classes, the windows' evaluation, suspension by ceiling and lifting a suspension, Health (slice 4).
- Task creation, enforcement on the candidate, the automatic-merge exclusion (slice 5).
- `learnings.dir` against governing paths at commissioning (11.1, slice 8). The block is validated in shape only.
- Release notes. The adopter notes below are written for the release step to carry over.

## Compatibility and adopter notes

### The `upkeep` and `learnings` blocks are validated

The last release ignored both blocks. This one refuses, at `config update`, `settings update`, `init` and doctor:

- `upkeep.mode` other than `off` or `observe` (`propose` included);
- a key the design does not define, in either block;
- a limit above its default, or not a whole number;
- `include`, `exclude` or `map` entries that are absolute, contain `..`, or are not strings;
- `upkeep.docs.workflow` without a catalog, naming no definition, or naming a `task` workflow;
- a `learnings.dir` that is absolute, contains `..` or a wildcard.

A project that copied the design's example block must remove `"workflow": "docs"` unless its catalog has a change or document workflow of that name. A project with no block is unaffected.

### A project that already stores such a block (for the release notes)

The release before accepted anything in the two blocks, so a project may store values this release refuses.

**What it sees after adopting this release.**

- It keeps running. Upkeep reads as off, and every field this release cannot read is taken as its default. Nothing fails on the stored data: not a tick, a merge settlement, the console or a comparison.
- `config update --current`, a `settings update` of `upkeep.mode`, and doctor are refused with the validator's reason, which names the setting (for example `upkeep.docs.include must be a list of at most 64 distinct repository-relative globs`).
- **`upgrade apply` refuses first, on the word of the release being adopted.** Before it prepares, stops or merges anything, it validates the stored configuration and stops with the reason and the fix. The validator is the release's own (`factory/core/configuration.mjs`), loaded in a separate process from a release directory that `readRelease` has just verified against the pinned manifest digest. Which CLI runs the command does not matter. Preparing and `--merge` always have that directory, and refuse a release whose validator is missing or cannot be loaded. `--activate` has none of its own: it checks with the directory given as `--release` (refused if it is not the pinned release), or with the release artifact the CLI runs from; with neither it skips the check, says so in its result (`configCheck`), and doctor after activation is the check, as before this slice. Nothing from the remote target is read or run before activation. Without the check the upgrade would land and its recommission step would then fail, leaving the project on the new code with its old commissioning record. The check is the whole validator, so it also catches the reserved namespace of slice 1 before the upgrade instead of after it.

**Recovery.** Replace the block with a valid one, by the operator, with `config update`:

1. `config show --state <state> > factotum.json`.
2. In it, replace the `upkeep` block with `"upkeep": {"mode": "off"}` (or remove it), and correct or remove `learnings` likewise.
3. `config update --state <state> --config factotum.json --note "Replace the upkeep block the last release ignored"`.
4. Doctor. Then run the upgrade again if it was refused.

Do step 3 with the release the project runs: before the upgrade that is the old release, which ignores the block; after an upgrade that already landed it is the new one, which accepts the corrected block. A delegated orchestrator cannot do it: a change away from a refused block is a change of authority. If the mode was the only thing wrong (`"propose"`), the operator's `settings update {"upkeep.mode": "off"}` is enough.

### Graph digests

Unchanged. No reference graph reads either block. `tests/upkeep-authority.test.mjs` compares the digests of the four reference graphs with the blocks absent, with the mode off, observing, and with every setting given; `tests/upkeep-records.test.mjs` still pins them against the baseline runtime. The configuration digest does change when the block changes, as for any configuration change.

### State

- **No schema change, no layout change, no new index.** `upkeepRun`, `upkeepDay` and `upkeepWindow` rows are written for the first time; they are ordinary rows read by key.
- **The `upkeepWork` meta row** now holds `{pending, queued, running, runs}`. No release wrote it before.
- **Jobs and flows.** An upkeep job is a `job` row with the operation `knowledge.upkeep`; its flow is a one-node maintenance flow.

### Going back to an earlier release

Turn `upkeep.mode` off first and let one tick close what is in hand. An earlier release refuses a queued `knowledge.upkeep` job as an unsupported maintenance job at its next tick, which faults that tick's transaction. `upkeepRun` rows are data it does not read.

### Turning it on

1. `config update` with the block: list the docs in `upkeep.docs.include`, keep dated records in `exclude`. Doctor.
2. `settings.update {"upkeep.mode": "observe"}` by the operator (or set it in the file).
3. Read the outcomes: `upkeepRun` rows per flow, the day's counters in `upkeepDay`.

Refused while an open task whose id starts `upkeep:` (in any letter case) exists that the factory did not make; the slice 1 record has the rename steps.

## Tests

`npm test`: 1423 tests, 1423 pass, 0 fail, 0 skipped, after the three review rounds and with `main` at `21132c6` merged in (1368 there, and 55 new: 36 from the first round, 10 from the review, 6 from the re-check, 3 from the second re-check). `npm run eval`: exit 0. `git diff --check`: clean.

| File | Tests | Covers |
| --- | --- | --- |
| `tests/upkeep-observe.test.mjs` | 20 | The receipt and its conversion; flows that get none; what a run records and what observe mode never writes; the idle tick against the runtime before this change; reads by key with work in hand; the lane; deadlines through configuration changes and through drains; a smaller and a larger configured age; the seven-day closure; the mode turned off; uncertain and aborted attempts; a run by hand; an unverified kind; the tracking limit. |
| `tests/upkeep-prefilter.test.mjs` | 11 | Globs; the docs set and each subtraction; governing files reached through links in both directions, the worked example of 7.1 and each fail-closed shape; candidates by reference, by map and by an entry's own paths; the edited-file rule; every reason the decision can give; the same through real Git trees, with a governing file behind a linked parent directory; the fetch. |
| `tests/upkeep-authority.test.mjs` | 8 | The blocks' validation; graph digests; the authority value; on schema 1 and on schema 2, a delegated `config.update` for each of 22 authority fields (every one but the mode, `upkeep.docs.workflow` and the step model entry, which are checked in the value) and a delegated `settings.update`, with the turn-down exception; turning upkeep on over a collision, in both commands and in doctor. |
| `tests/upkeep-upgrade.test.mjs` | 5 | Review P2-2 and the re-check's P2. Fourteen blocks the release before accepted and this one refuses: read without failing, upkeep off, the comparison in both directions; a project the baseline runtime commissioned with each, through `config update --current`, the three forms of `upgrade apply`, a delegated change, and recovery; an operator update straight to a valid observing block. |
| `tests/upkeep-console.test.mjs` | 4 | The Settings row (and the re-check's P3: recovery from a stored `propose`, value by value): the two modes, the command it sends and the project accepting it; refusing to turn upkeep on over a task in the reserved namespace; the unverified lookup left to the project; a refused stored block shown as text, with the form and the reset disabled. |
| `tests/upkeep-fixtures.mjs` | — | A commissioned delivery project with a real repository and a bare remote. Only the forge boundary is substituted: a merge is a real commit pushed from a scratch clone and settled through the engine. |
| `tests/upgrade-apply.test.mjs` | 7 added | Re-checks: the release's own validator decides, for prepare and merge; a release that accepts what this checkout refuses; a missing or unloadable validator; `--activate` with a verified release directory, with a wrong one, with none (skipped and said), and run from a release artifact built from this checkout; the P1 repro; no worktree on any `--activate` path. Its fictional releases, and those of `tests/install-prefix.test.mjs` and `tests/state-layout.test.mjs`, now carry a validator. |
| `tests/upkeep-namespace.test.mjs`, `tests/upkeep-records.test.mjs` | 2 changed | The slice 1 test "nothing in this slice runs" now states what exists (one operation, one setting, no model role, no task writer). Writing a run now also reads the `upkeepWork` meta row. The digest variant uses `observe`. |

**How the idle tick is measured.** The test extracts the runtime at `283ba91` from Git history, opens the same state with it, and records every SQL statement with its bound values for one idle tick of each runtime. Every statement the old tick ran is run again, and the difference is exactly `SELECT value FROM meta WHERE key=?` with `upkeepWork`: 81 statements before, 82 now. A logging `git`, `codex` and `claude` first on `PATH` show the same Git processes either way (none in this fixture) and no provider process. Without the history (a source archive) that comparison is skipped with a diagnostic and the absolute checks remain: one read of `upkeepWork`, and no other statement that names an upkeep kind or key.

### Acceptance (section 15, slice 2)

| Acceptance item | Test (`tests/upkeep-observe.test.mjs` unless named) |
| --- | --- |
| A merged flow that later fails or stops at a post-merge step still gets one run | "a merged flow that then fails at a post-merge step…", "a merged flow that is stopped at a post-merge step…", "a merged flow gets exactly one run…" |
| Unmerged, task, maintenance and upkeep-origin flows get none | "unmerged, task, maintenance, rehearsal and upkeep-origin flows get no run…" |
| A tick with no upkeep work adds one meta read and starts no Git or provider process for upkeep | "a tick with no upkeep work adds exactly one meta read…" |
| A `main.verify` queued before or after an upkeep job starts is not delayed | "main.verify and target.sync are never delayed by upkeep…" |
| A receipt taken through repeated configuration changes and repeated drains across `runBy` is closed and never runs; a larger configured age does not revive it | "a receipt taken through repeated configuration changes across runBy…", "a drain is not held by a queued or a running assessment…", "a smaller configured age shortens runBy…" |
| A drain is not held by a queued or running assessment | "a drain is not held by a queued or a running assessment…", "an assessment whose attempt is uncertain is not abandoned…" |
| Graph digests are identical with the block present and absent | `tests/upkeep-authority.test.mjs` "graph digests are identical…"; `tests/upkeep-records.test.mjs` "the reference graph digests are the baseline's…" |
| A delegated configuration or settings change that alters any upkeep authority field is refused on schema 1 and on schema 2, except turning the mode down | `tests/upkeep-authority.test.mjs` "schema 1: …config.update…", "schema 1: …settings.update…", "schema 2: …config.update…", "schema 2: …settings.update…" |
| Classification with governing subtraction; the pre-filter | `tests/upkeep-prefilter.test.mjs`, all nine |
| The run record and `mode` | "observe mode records the outcome…", "only the upkeep operation can record a run…" |
| 4.5 read limits | "with upkeep work in hand every read is by key…", "when a kind upkeep reads through an index is not verified…" |

### Fail-before evidence

On the base, the three new files fail to load (the modules do not exist). Each row below is one partial revert of the committed source, with the new tests run against it.

| Source state | Result |
| --- | --- |
| No receipt at merge settlement (`core/engine.mjs`) | observe file: 19 run, 18 fail |
| No conversion when a stop records the retrospective (`core/project.mjs`) | 1 fails: the flow stopped at a post-merge step |
| No conversion when a finish records the retrospective (`operations/governance.mjs`) | 6 fail |
| A receipt for every flow kind and for marked tasks | 1 fails: the flows that get none |
| The tick makes no upkeep read (the base behaviour) | 19 fail; the idle-tick test finds 0 reads where it requires 1 |
| The tick makes a second upkeep meta read | 1 fails: the idle tick |
| One lane: upkeep shares the built-in maintenance lane | 1 fails: `main.verify` is delayed |
| A stopped upkeep flow counts as the occupant of the verification lane (`operations/merge-hold.mjs`) | 1 fails: the same test |
| A queued run is not closed at `runBy` | 1 fails: the configuration-change deadline test |
| A running assessment is not stopped under a maintenance hold | 2 fail: both drain tests |
| The reference change graph reads the upkeep block | 2 fail: both digest tests |
| No upkeep check in `config.update` and `settings.update` | authority file: 4 fail, schema 1 and schema 2 (the schema 2 policy entry is reached only after the direct check) |
| The same, and no entry in the schema 2 authority policy | 5 fail |
| Turning the mode down is not excepted | 5 fail |
| Governing paths are not subtracted from the docs set | pre-filter file: 4 fail |
| Weak signals alone reach the assessment | 2 fail |
| `runBy` set afresh at every queueing | 1 fails (since the review round): the configuration-change test now requires the receipt to be queued again under a larger age, which the record invariant refuses when the deadline was recomputed. At `abe0aa1` no test failed. |

## Review of `abe0aa1`

Independent review (GPT-6.1 Sol): changes requested, three P2 findings and one P3. It found no authority bypass for valid configurations, the acceptance assertions substantive, the idle tick exactly one added meta read and the digests unchanged. Fixed in `0ae7737`; each P2 has a test that fails without its fix.

**P2-1. A pending receipt could lose a shortened deadline under a drain hold.** `advancePending` computed the shorter effective deadline and returned under the hold without writing it, so raising the age later restored the longer one, and the receipt ran after the shorter deadline had passed. *Fix:* the shortened `runBy` is written before any return (a hold, or a flow that is not ready), with an `upkeep.deadline-shortened` event. *Test:* "a deadline shortened while a receipt is pending under a drain hold stays shortened…" follows the review's five steps and ends `closed`, `stale-run`, zero assessments; it also covers a receipt pending with no hold.

**P2-2. Stricter validation had no safe upgrade transition.** A block the base accepted could make `config update --current` fail after the upgrade had landed, and a malformed `docs.map` made the authority comparison throw (`(docs.map ?? []).map is not a function`), which also refused the operator's own corrected configuration. *Fix:* stored blocks are read field by field and never assumed valid (see [Authority](#authority-92)); a refused block reads as off; `upgrade apply` validates the stored configuration with the release being adopted before anything else and names the fix; the recovery is in the [adopter notes](#a-project-that-already-stores-such-a-block-for-the-release-notes) and `docs/updates.md`. *Tests:* `tests/upkeep-upgrade.test.mjs`.

**P2-3. Deduplicating governing files dropped valid path mappings.** Two entries that reach one file, each with its own `paths`, kept only the first entry's mapping, so a change selected by the second produced no candidate and the answer depended on the order. *Fix:* the file is listed once with every entry's id and the union of their mappings. *Tests:* "several governing entries that reach one file…" and "the job: two governing entries map one file to different paths…", each in both orders.

**P3.** Trailing whitespace in `docs/release-notes.md`, fixed on `main` (`b5f0394`) and picked up by the merge.

**Also in the round:** the `upkeep.mode` row in the console's Settings tab, and a test that fails for the seventeenth revert (see [fail-before evidence](#fail-before-evidence)).

Fail-before, one partial revert each:

| Source state | Result |
| --- | --- |
| The shortened deadline is not written before returning under a hold | observe file: 20 run, 1 fails: the new test |
| A stored value this release refuses is used as it is | upgrade file: 4 run, 3 fail |
| A refused block still reads as its stored mode | 3 fail |
| A refused block is not itself an authority entry | 2 fail: a delegate could leave a block with an unknown key |
| `upgrade apply` does not validate the stored configuration first | 1 fails: the upgrade regression |
| The first entry that reaches a file wins | pre-filter file: 11 run, 2 fail |
| The console row does not refuse what the project refuses | console file: 3 run, 2 fail |

## Re-check of `8e32247`

Re-check (GPT-6.1 Sol): the earlier repros fixed, no delegate bypass, read limits and digests holding, the console row fitting at 320 px. Two findings and one note, each fixed with a test that fails without the fix.

**P2. A refused workflow selector still enabled upkeep.** `upkeep: {mode: "observe", docs: {workflow: "chore"}}` with `chore: {reference: "task.orchestrator"}` was refused by the full validator, but the check behind `upkeepMode` did not resolve a reference to its kind, so the block read as observing and a merged change wrote a pending receipt. *Fix:* there is one resolution, `definitionKind` in the new `core/workflow-kinds.mjs` (it imports nothing): the catalog compiler takes its reference kinds from it, and `validateUpkeepConfig` uses it directly instead of being handed a resolver. `validateConfig` and `upkeepBlockProblem` now run the same function with the same inputs, so they cannot drift. *Test:* "a workflow selector is judged as the catalog compiles it…" (the repro, no receipt, and for every selector and definition shape the block's problem equal to the full validator's message); the block is also one of the legacy cases of the upgrade regression.

**P3. The console blocked a valid recovery from a legacy mode.** With `{upkeep: {mode: "propose"}}` stored, Save and Reset were disabled although the operator's `settings.update` to `off` succeeds. *Fix:* the guard judges the configuration that would result. The settings view gives, per mode and for a reset, the project's answer computed with `applyLiveChanges`, the block validator and the turn-on check, and the row offers what is accepted. `applyLiveChanges` now refuses a stored block that is not an object with a plain reason instead of a `TypeError`. *Test:* "a stored mode this release does not have is recovered from the row…".

**Note. The preflight used the invoking CLI's validator.** The record and `docs/updates.md` said it validates with the target release; nothing enforced that. *Fix:* enforced. The validator is loaded from the release being adopted, in a separate process (see the [adopter notes](#a-project-that-already-stores-such-a-block-for-the-release-notes)). For `--activate`, which takes no release directory, this round read it from a detached checkout of the remote target; that was wrong and is withdrawn, see [the second re-check](#second-re-check-of-50da357). *Tests:* `tests/upgrade-apply.test.mjs`.

| Source state | Result |
| --- | --- |
| The upkeep validator does not resolve a reference to its kind | upgrade file: 5 run, 3 fail |
| The view judges the stored problem, not the result | console file: 4 run, 1 fails |
| The preflight loads the running CLI's validator | `tests/upgrade-apply.test.mjs`: 21 run, 4 fail |

## Second re-check of `50da357`

Second re-check (GPT-6.1 Sol): the selector and console fixes confirmed, the catalog graphs and digests identical to `283ba91`, no new failure from a network outage or a shallow clone. Two problems, both in the `--activate` preflight added in the round before.

**P1. `--activate` ran code that was not bound to the trusted manifest digest.** The preflight checked out the remote target, required `adoptionStatus` to find its files as locked, and then ran its validator. For a root installation the lock does not bind its file hashes to the pinned manifest, so a validator substituted on the target, with its lock entry updated to match, ran before any backup or stop, in a child process with no file-system or Git isolation.

**P2. A SIGTERM during that preflight left the temporary checkout on disk and registered as a worktree.**

**Fix, as directed: the remote-checkout preflight is removed.** Nothing from the remote target is read or run before activation.

- `--activate` validates only with a release directory that `readRelease` verifies against the pinned digest: the one given as `--release` (new, optional), or the release artifact the CLI runs from (`<release>/starter/factory/cli.mjs`, which is how `docs/updates.md` says to run it). A `--release` that is not the pinned release is refused: the operator named it.
- With no verified directory the check is skipped, not refused. The result carries `configCheck: {checked: false, reason}`, which says that doctor after activation is the check and how to have it checked first. Activation then proceeds exactly as before this slice.
- No temporary directory and no worktree are made on any `--activate` path, so there is nothing to leave behind on a signal.
- Preparing and `--merge` keep the fail-closed rule: their release directory is verified, and a validator that is missing or cannot be loaded refuses the upgrade.

**Tests** (`tests/upgrade-apply.test.mjs`): the P1 repro, with and without `--release` (the substituted validator is never loaded or called; no marker exists when the first unit is stopped); `--activate` with a verified directory that refuses and one that accepts, with a directory that is not the pinned release, with none, and run from a release artifact built from this checkout; on each path a logging `git` shows no `worktree add` and the worktree list is unchanged, and the module's source holds no worktree or temporary-directory call. Run against the preflight of `50da357`, three of them fail, the repro on "the substituted validator was never loaded or called".

### Pre-existing finding, not fixed here: a root installation's lock does not authenticate its files

Found by the reviewer through the preflight; it is older than this slice and not limited to it. Recorded for scheduling.

**What.** `factotum.lock.json` pins a release by `manifestDigest` and `payloadDigest` and lists each managed file's SHA-256. For a **prefixed** installation `readLock` requires the lock's files, owners and layout to rebuild the pinned manifest (`layoutMatches`, `distribution.mjs`), so no hash can change without the digest changing. For a **root** installation there is no such check: nothing ties `managedFiles` to `payloadDigest` or `manifestDigest`. `adoptionStatus` then compares the installed files with the lock only.

**Repro** (`tests/upgrade-apply.test.mjs`, "P1: …", whose diagnostic reports the outcome):

1. Prepare a root-install adoption of release B.
2. In the adoption commit, replace `factory/core/configuration.mjs` (any managed file) and write its new SHA-256 into `managedFiles` in `factotum.lock.json`. Leave `release.manifestDigest` and `release.payloadDigest` as they are.
3. Push to the remote target and run `upgrade apply --activate` with B's digest.

**Observed at this head, with and without `--release`:** the `pull` step accepts the target ("holds the release with this digest", files "as locked"). The upgrade then runs the checkout's own CLI for `config update --current` and doctor, and restarts the units on it: the substituted code runs. By reading the code, the same holds for everything that reads the lock through `adoptionStatus`: doctor's drift check (`adoptionDrift`), `upgrade apply --merge` (`liveAdoption`) and `adopt status`. Only the activation was run. So the weakness lets tampered code run in a normal activation and pass doctor, not only in the withdrawn preflight.

**Who can do it.** Someone who can write the lock and a managed file to the target branch outside the factory: a direct push, or a pull request merged by hand. The factory's own flows cannot: commit, integration and publication refuse a candidate that changes the lock or an upgrade-owned path, read through verified objects, and an adopted pull request that changes managed files is refused.

**Assessment.** Medium. It needs write access to the target that already allows other harm, but it defeats the one control meant to hold against exactly that: the operator's pinned digest. `--activate` says it "refuses unless that holds the release with this digest", and for a root installation it only checks that the lock says so. Prefixed installations are not affected.

**Possible fixes, for whoever takes it.** (1) Give root locks the same layout evidence prefixed locks have and require `layoutMatches` for every lock; existing root locks gain it at their next `adopt update`, so a transition rule is needed. (2) Where a verified release directory is at hand (`--merge` always, `--activate` with `--release` or from the artifact), compare the lock's `managedFiles` with the verified manifest's managed files before recommissioning; this closes the upgrade paths but not doctor's drift check.

**Fixed in dev.87** ([dev87-root-lock.md](dev87-root-lock.md)): option (1), with option (2) for root locks written before it. The P1 test now expects the activation to be refused before anything is stopped.

## Settled after review

The eight questions the first version of this record raised. Seven are settled by the reviewer's recommendations, as built; the console row is added. One part of the fifth went to the operator, who has decided it.

| # | Question | Settled |
| --- | --- | --- |
| 1 | `propose` before slice 5 | **Kept refused.** A stored `propose` reads as off. |
| 2 | Does `assessment-unavailable` count as reaching a model? | **No.** No model ran. When slice 4 evaluates the 8.3 windows, runs with this reason are not "runs that reach the model". |
| 3 | Limits as ceilings | **Conservative maxima kept**: every limit may be lowered, none raised. *Settled ceilings* (operator decisions): `docs.maxFiles` 3, `docs.maxChangedLines` 40, `docs.maxWaiting` 10, `context.maxOpen` 10, `capture.maxOpen` 10 (Q7); `budget.maxTasksPerDay` 2, `maxTasksPerWeek` 6, `maxFlowInvocations` 8, `maxQueueAgeMs` 24 hours (N6); `budget.maxOpenTasks` 12 (it bounds the namespace lookup); `learnings.maxEntries` 40 (Q3). *Provisional defaults*, held as maxima until the slices that use them decide whether a project may raise them: `budget.maxInputChars` 40,000, `maxTurns` 6, `timeoutMs` 5 minutes, `maxModelRunsPerDay` 30 (slice 3); `learnings.maxSelected` 5, `maxChars` 6,000 (slice 8). The same lists are in `core/upkeep-config.mjs` and `docs/operations.md`. |
| 4 | The comparison base | **The recorded integrated base is kept.** When the target moved between a flow's integration and its merge, the comparison also lists what the merges in between changed, which widens the candidate set (more candidates, never fewer). |
| 5 | Added paths | **Additions count as touched**, for references and for maps. The edited-file exception covers governing files too: the operator's decision, see below. |
| 6 | Scheduling | **`knowledge.upkeep` stays out of `schedule.put`.** |
| 7 | An unresolvable `learnings.dir` | **Keeps failing closed**: no docs set, recorded `learnings-unresolvable`. |
| 8 | The console | **Done**: the `upkeep.mode` row. |

## Operator decision: the edited-file exception covers governing files

**Q5, settled by the operator on 2026-11-16: (a), as slice 2 does.** Design 6.2 now says so: a governing file the merge itself edited is a candidate only through a reference to a deleted or renamed path, not through its entry's `paths` or a reference to another touched path. Nothing changes in the code. The question as it was put:

> Design 6.2 says: "A doc the merge itself edited is a candidate only through a reference to a deleted or renamed path." It says "doc" and is silent on governing files. When the merged change itself edited a governing file (a `context.files` entry), should the pre-filter treat that file (a) exactly as it treats an edited doc, a candidate only if its text names a path the merge removed, or (b) by the ordinary rules, as if the merge had not edited it: a candidate whenever its text names any path the merge touched, or the entry's own `paths` match one?

What (a) misses, as recorded with the recommendation: a merge that edits one statement in a governing file and makes another statement in the same file false without removing a path. That is the miss the design already accepts for docs, and the trial has a row for what the pre-filter misses (14.2).
