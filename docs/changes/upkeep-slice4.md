# Knowledge upkeep, slice 4: candidate lifecycle and command authority

Design: [knowledge-upkeep.md](../designs/knowledge-upkeep.md), section 15, slice 4. Base: `main` at `f990c82` (slices 1 to 3 and the dev.87 re-test record). The first builder's interrupted work is `7cef337` (cherry-picked from `6f56f6f`); it was reviewed, completed and fixed in `7f9ea4e`, and this record and one more read-limit test are in `fb4949c`. The independent review of `fb4949c` and its fixes are in [Review of `fb4949c`](#review-of-fb4949c), in the commit that carries this revision of the record.

Slice 4 adds what a candidate is once it exists: the `finding` row's states and who may move it, the commands `finding.accept`, `finding.resolve` and `finding.reopen`, the caps and expiry, the ceilings of 8.3 with suspension and its lifting, and the Knowledge upkeep card in Health. **No candidate is written in this release, and none can create a task or change a file.** `upkeep.mode` still has only `off` and `observe`, and an observing run still only counts what the validator kept. What changes for every project is the audit finding: it can now be declined, recorded as dealt with another way, given a task and reopened, and its to-do follows.

**Three existing behaviours change.**

- **Audit findings have a lifecycle.** Creating a task from one in Health records the task against it (`finding.accept`) instead of only writing a task. Its to-do (`finding:<id>`) passes when that task merges and fails when its flow fails.
- **An observing project can now be suspended.** The ceilings of 8.3 are judged when a run closes. Six of the last 20 runs reaching the model, or four of 20 producing a candidate, suspends the model call; only the operator lifts it.
- **Three commands are delegable, and delegated by default.** `finding.accept`, `finding.resolve` and `finding.reopen` join the delegable operations. A project with no `policy.delegatedOperations` list delegates every delegable operation, so the orchestrator may use them on a recorded instruction; an explicit list delegates them only if it names them. A release before this one refuses a list that names them. (Corrected in dev.89: this line first read as if they had to be listed. The operator confirmed the default; see the knowledge-upkeep design, "Who may do what" ([`docs/designs/knowledge-upkeep.md`](../designs/knowledge-upkeep.md)).)

The record layout gains three indexes over findings, built by the layout step when the project service starts.

## What was built

| Piece | Where |
| --- | --- |
| The states, the transition table, who may act, raising, linking, settling, dispositions, reopening, expiry, the caps, the Health row | `operations/upkeep-candidates.mjs` |
| The ceilings, their windows, suspension by ceiling, lifting, the seven-day share | `operations/upkeep-ceilings.mjs` |
| The open counts (with observed classes), the window's `merged`, `since` and `counting`, lifting a suspension, one notice for two parts | `operations/upkeep-records.mjs` |
| The three commands and `upkeep.lift`; closing a linked task; the findings of a flow's task; regression hook; counting start | `core/project.mjs` |
| Delivered at a proven merge; failed, or resolved elsewhere, at a flow's end | `core/engine.mjs` |
| An audit result never touches a row of another source, and sets no lifecycle field | `operations/governance.mjs` |
| Run settlement judges the run ceilings and expires observed classes | `operations/upkeep-runs.mjs` |
| The assessment expires overdue candidates where it reads the open set | `workflows/upkeep-assess.mjs` |
| The Health view (reads nothing itself); the findings Health lists | `operations/views.mjs`, `core/project.mjs` (`snapshot`), `service/dashboard.mjs` (`healthFindings`) |
| Three indexes: open upkeep candidates; tasked findings and closed findings, each by status time | `core/records.mjs`, `operations/upkeep-records.mjs` (`openUpkeepCandidates`) |
| The Health card, audit finding forms, the Overview item, event names, 320 px layout | `console/ui/operations.mjs`, `console/ui/overview.mjs`, `console/ui/records.mjs`, `console/style.css`, `console/console.mjs` |
| Help, delegation, contracts | `core/command-help.mjs`, `core/delegation.mjs`, `contracts/README.md` |

### States and who may act (4.3)

Every `finding` row, audit or upkeep, is in one of `unapproved` (open), `tasked`, `delivered`, `failed`, `declined`, `expired`, `resolved-elsewhere`. A row has a `version`, raised on every change of status and never by a repeat observation. A row written by an earlier release has none and reads as version 1.

| From | To | By |
| --- | --- | --- |
| (none) | `unapproved` | The factory. A `rule` or `learning` class only from its second distinct source flow |
| `unapproved` | `tasked` | The factory for `docs` (slice 5); a person's `finding.accept` for every other kind. In this release only for audit findings |
| `unapproved`, `tasked` | `declined` | A person, with `unnecessary`, `wrong`, `duplicate` or `later` |
| `unapproved`, `tasked` | `expired` | The factory: age, a cap, a task not approved in time, returns exhausted |
| `unapproved`, `tasked` | `resolved-elsewhere` | The factory (statement gone, source reverted, learning gone, condition cleared), or a person with evidence |
| `tasked` | `delivered`, `failed` | The factory, from the linked flow |
| `tasked` | `unapproved` | The factory: a return. The third expires instead (`returns-exhausted`) |
| `declined`, `expired`, `failed`, `resolved-elsewhere` | `unapproved` | A person, `finding.reopen`. The return count starts again |

The people: the operator; the orchestrator on a recorded instruction where the command is delegated (with no `policy.delegatedOperations` list, by default; with a list, only if it names the command), for audit findings and the `docs`, `check`, `learning` and `learning-stale` kinds; nobody but the operator for `context` and `rule`, whatever is delegated. A kind this release does not know is the operator's. Every person's command names `expectedVersion` and is refused, writing nothing, if the row changed. The factory's functions re-read the row in their transaction.

`finding.accept` exists for audit findings only (design, slice 4): an upkeep candidate is refused to every actor after the actor check, and no task is written.

**Declining a tasked finding** closes its task (as `task.put {closed: true}` would: a new revision, no approval, its flows stopped) and declines every finding linked to it with the same reason. A task with an unfinished flow is refused until the flow is stopped.

### Audit findings (4.4)

| Disposition | The to-do `finding:<id>` |
| --- | --- |
| Declined | `deferred`, with the reason as evidence |
| Tasked | Stays pending. `passed` with the task id when the task merges; `failed` when its flow fails |
| Resolved elsewhere | `passed`, with the evidence |
| Reopened | A new pending to-do, `finding:<id>:<version>` |

A to-do a person already resolved is left as they resolved it. An upkeep candidate has no to-do in any state.

### Caps and expiry (8.3)

| Part | Cap | Age |
| --- | --- | --- |
| Waiting docs candidates | 10 (`docs.maxWaiting`); the next one is not recorded | 14 days |
| Open context proposals | 10 (`context.maxOpen`); the next one pushes out the oldest, which expires (`cap`) | 30 days |
| Open capture candidates (`check`, `rule`, `learning`) | 10 (`capture.maxOpen`), one cap across the three | 30 days |
| Stale-learning candidates | none of their own (the learnings store holds 40) | 30 days |
| Observed classes | 200; the next one pushes out the oldest | 90 days |

The counts are kept in the `upkeepOpen` meta row, so a cap is checked without reading rows. A part at its cap reads the open candidates once, through their own index (never the open audit findings, which nothing bounds), expires what is past its age, and only then refuses or pushes out. Open candidates also expire where the assessment reads the open set for its prompt. Observed classes expire at every run settlement through their own index, at most 50 at a time, without reading the finding set. A reopen into a full part is refused.

### Ceilings and suspension (8.3, 8.4)

| Measure | Window | Suspends at | Part |
| --- | --- | --- | --- |
| Runs that reach the model | The last 20 runs | 6 | The model call |
| Runs that produce any candidate | The last 20 runs | 4 | The model call |
| Docs follow-ups ended rejected, failed, declined or expired | The last 10 ended | 3, or 3 in a row | Docs |
| Context, or capture, candidates declined or expired | The last 10 disposed of that part | 5 | That part |
| A revert or regression of an upkeep change | The last 20 merged | 1 | Everything |
| Upkeep-attributed share of all invocations | The last 7 complete UTC days | 10% | The model call and docs |

A window is judged only once full, except "3 in a row" and the revert rule. Judged when a run closes or a disposition is recorded; nothing polls. A run that ended `assessment-unavailable` is a run and did not reach the model; a run entry written before slice 3 has no `model` member and did not either.

A suspension records the part, the rule, the window's entries and counts, the reason and the time, with one operator notice (one for both parts of the share rule). It is lifted only by `upkeep.lift {part, note, expectedAt?}`, the operator's alone and not delegable, or by the Health form that sends it. Turning the mode down and up does not lift it. After a lift, the windows that feed that part are judged only on what is recorded afterwards. The unverified-kind suspension of slice 1 (part `all`) can now be lifted.

**The share uses complete days only.** It reads seven `upkeepDay` rows by key, yesterday and the six days before; today is never read. The window counts as full only when the day totals were being maintained before its oldest day began: the start is recorded when upkeep is turned on, and for a project already on, at the first evaluation after adopting this release. Turning upkeep off forgets it.

### Health

The Knowledge upkeep card appears when upkeep is on or a part is suspended. It shows each suspension with its rule, reason and time and the lift form, and each open candidate as text: kind, file and quote, proposed replacement or text, anchor and topic, the model's reason, flags, who wrote it, its source flows, returns, when it expires and who may act. It offers Decline and Dealt with another way, and says that none can be accepted in this release. Audit findings: open and tasked ones with Create a task (now `finding.accept`), Decline and Dealt with another way; recently closed ones with Reopen. Every form names the version it showed. Totals stay in Stats. Overview lists each suspension.

The view reads no record itself: the dashboard gives it the open and recent findings it already reads, and the status snapshot the live finding set, so both answer the same whatever the record layout.

## Decisions taken where the design was silent or ambiguous

Each is the conservative reading.

| # | Point | What this slice does |
| --- | --- | --- |
| 1 | Whether slice 4 may write candidate rows. | No. `propose` stays refused and nothing calls the raising function; the machinery is reached only by tests. Health's candidate list is empty in practice until slice 5. Settled in review: deferred to slice 5. |
| 2 | An audit finding whose task's flow completes without a merge (already satisfied). | `resolved-elsewhere`, and its to-do passes. The disposition keeps what the completion rests on (`completion`: flow, task, revision, mode, head, time) and the evidence says it, for example "its accepted outcome was proven already on the target at `<head>`". Settled in review. |
| 3 | An audit finding whose task's flow is abandoned or stopped. | Stays `tasked`, to-do pending: the task can be restarted. 4.3's "abandoned for a fault" and "returns" are about upkeep delivery flows (slice 5). |
| 4 | An audit finding whose task's flow failed, and the task is restarted and merges. | Delivered by that merge if it still names the task and the merged flow ran the revision it was recorded against; its to-do, failed by this lifecycle, passes. After a brief edit it stays `failed`. One move beyond 4.3's table, `failed → delivered`, by the factory, for audit findings only. Changed in review. |
| 5 | Ages, caps and the 14-day approval limit for audit findings. | None apply. 8.3's limits name upkeep parts; audit tasks are ordinary tasks. |
| 6 | The age of a returned or reopened candidate. | Counted again from its return to open. |
| 7 | Resolving one tasked finding elsewhere when its task has other findings. | The task is closed only if it has not started; the others return to open, which is not counted as a return. A started task is left running with its other findings. |
| 8 | Observe-mode runs and the "produce any candidate" ceiling. | Counted: in `observe` a run whose validator kept something ended `candidates`, as slice 3 recorded for this purpose. Neither run ceiling is judged before 20 runs; the share ceiling, judged by days, can suspend an observe trial earlier, and the operator reviews and lifts it. Settled in review. |
| 9 | "Reaches" a ceiling. | Inclusive: 6 of 20, 4 of 20, 3 of 10, 5 of 10, one revert, 10.0%. |
| 10 | A day on which counting began. | Not complete, at whatever time it began. |
| 11 | Which disposals feed a part's window. | Context and capture: accepted, declined, expired, resolved elsewhere, one entry per candidate; only declined and expired count against it. Docs: one entry per ended follow-up task, not per candidate; a docs candidate declined before it had a task is not a follow-up. |
| 12 | Reverts. | The function takes `revert` and `regression`. Only `regression.record` against a flow whose task carries the upkeep marker calls it in this release; no upkeep change can merge yet. Revert detection comes with delivery. |
| 13 | A push-out at a cap reads the open candidates (4.5 lists only by-key reads for a candidate write). | Only at a cap, once per call, through the open candidates' own index, bounded by the caps. |
| 14 | A `rule` is a capture candidate for its cap and suspension, and the operator's alone for its actions. | As the design's two tables say. |
| 15 | Two parts suspended by one rule. | One notice, on the first part, naming both; lifting that part closes it. |
| 16 | Overdue candidates. | Expired where upkeep reads the open set (the assessment, a cap). Health, a read model, marks them as past their limit. |
| 17 | A class key that an audit finding already holds, or the reverse. | Neither source touches the other's row; an audit result sets no lifecycle field. |
| 18 | How many findings a task may carry. | 20. |
| 19 | What "the window's contents" holds (8.4). | The entries the rule judged, with the fields it read, and the counts; at most 20 entries. |

## Not in this slice

- Writing candidates from a run, `propose`, and creating any upkeep task (slice 5 onward). The triggers for `tasked → expired` (14 days unapproved), `tasked → unapproved` (a return), the factory's `resolved-elsewhere` and the revert rule exist as functions with tests and have no caller.
- Health lists open candidates only. Tasked and closed upkeep candidates are not listed, so a candidate is reopened from the command line. None can be tasked yet; their controls come with delivery in slice 5 (settled in review).
- The confusable-text follow-up (`docs/runtime-followups.md`) is for slice 6; nothing here accepts model text into governing context.
- No real browser was run; the 320 px fit and safe text are checked on the rendered DOM and the stylesheet.

## Changes to the interrupted work

The WIP (`7cef337`) was complete in code and tests; the docs had stopped at operations, commands and the contract reference. Its 1,536-test suite passed. Changed in `7f9ea4e` and this commit:

| Change | Why |
| --- | --- |
| `upkeepHealthView` reads no record; `snapshot()` passes the live finding set | The snapshot's view listed no candidate while the finding kind was unverified, so it disagreed with the dashboard's, which reads the open findings either way. A read model must answer the same before and after the layout step. Test: Health, first test |
| A part at its cap expires overdue candidates first | Ten overdue docs candidates kept every new one out (`backlog-full`) until an assessment happened to read the open set; a full context part pushed out a fresh proposal by `cap` while an overdue one stayed. Test: "a candidate past its age never holds a place at a cap…" |
| Several candidates in one call at a cap | Rewritten with one read of the live set kept up to date in the call, so the part stays at its cap. Same test |
| A suspension records the window's entries | 8.4 says the window's contents; it recorded only counts. Tests: the ceiling tests |
| Read limits of the slice 4 functions on the large history | Not measured. Test: `upkeep-records`, "slice 4 on a large settled history…" |
| Docs: console guide, browser qualification, running guide, `expectedAt` in commands, the cap rule in operations | Missing or still describing the old Health |
| Two imports from one module in `views.mjs` | Merged |

## Compatibility and adopter notes

### For the release notes

**Audit findings can be declined, dealt with and reopened.** Health's audit findings now offer *Decline* (unnecessary, wrong, a duplicate, not now), *Dealt with another way* (with evidence) and, for closed ones, *Reopen*. *Create a task from this finding* records the task against the finding: the finding becomes tasked, and its to-do passes when the task merges and fails if the task's flow fails. Declining closes the to-do as deferred; dealt with passes it; reopening opens a new one. The commands are `finding.accept`, `finding.resolve` and `finding.reopen`, each naming the finding version you read. The operator may use them, and the orchestrator on your instruction if you list them in `policy.delegatedOperations`. Declining a finding that has a task closes that task and declines every finding recorded against it; stop the task's flow first. A task created from a finding before this release is offered as *Record that task against this finding*.

**Knowledge upkeep (observe mode) can suspend itself.** If `upkeep.mode` is `observe`, the factory now judges the ceilings of the design when a run closes. When 6 of the last 20 runs asked the model, or 4 of the last 20 had something the validator kept, or upkeep made 10% of the model invocations of the last seven complete UTC days, the model call is suspended (the share rule also suspends docs). One notice is raised. Runs then end `abstained:suspended` without a model call. Only you can lift it: Health → Knowledge upkeep → *Lift this suspension*, or `upkeep.lift {part, note}`. Turning the mode off and on does not lift it. The share is judged only once seven complete days have been counted since upkeep was turned on, or since you adopted this release if it was already on. The suspension slice 1 records when a record kind is not verified can now be lifted the same way (part `all`).

**Health shows Knowledge upkeep** when it is on or something is suspended: each suspension with its reason, and any open candidates. This release writes no candidate, so the list stays empty. Invocation totals stay in Stats.

**Health keeps tasked and recently closed findings.** It lists every open finding, the 100 most recently tasked and the 20 most recently closed, however many findings were recorded since, so a tasked finding keeps its controls and a closed one its Reopen.

**A failed audit finding can still be delivered.** If its task's flow failed and a later flow of the same task, at the same revision, merges, the finding is delivered and its to-do passes.

**Going back to an earlier release.** If your `policy.delegatedOperations` list names `finding.accept`, `finding.resolve` or `finding.reopen`, remove them first: an earlier release refuses the configuration. A project with no list needs nothing here. The three new indexes stay, unknown to it, and SQLite keeps them up to date; this release checks them again at its next start. A finding that is tasked, declined or otherwise closed is outside the earlier release's open set, so its Health no longer lists it; its to-dos are ordinary obligations. A suspension stays recorded, and an earlier release has no command to lift it.

### State

- **No schema change.** Three new partial indexes over findings: `records_finding_open_upkeep` (open upkeep candidates), `records_finding_tasked` and `records_finding_closed` (by `statusAt`). The layout step builds them when the project service starts; until then the finding kind is not verified, so upkeep's reads refuse and general reads parse the kind, as for slice 1's indexes.
- `finding` rows gain `version`, `statusAt`, `openedAt`, and as they move `taskId`, `taskRevision`, `taskedAt`, `taskedBy`, `lastTaskId`, `returns`, `returned`, `disposition`, `previousDisposition`, `reopened`, `obligationId`. Upkeep candidates (none written yet) also carry `kind`, `sourceFlows`, `sourceFlowCount` and their content.
- Tasks and flows gain `findings` (ids, at most 20), kept out of the brief: an edit keeps it, and it does not change the revision.
- `upkeepOpen` gains `observed`; the `upkeepWindow` row gains `merged`, `since` and `counting`. Suspensions gain `entries` in their window.
- New obligations `finding:<id>:<version>` for reopened audit findings.

### Graph digests and the idle tick

Unchanged. No reference graph reads the new code; the digest tests of slices 1 and 2 pass. The idle tick adds nothing: the ceilings and the observed-class expiry run in a run's settlement, and the Health view runs only when a client reads.

## Tests

`npm test`: 1542 tests, 1542 pass, 0 fail, 0 skipped, after the review (1502 at the base, 40 new: 36 in the first round, 4 from the review). `npm run eval`: exit 0. `git diff --check f990c82..HEAD`: clean.

| File | Tests | Covers |
| --- | --- | --- |
| `tests/upkeep-lifecycle.test.mjs` | 16 | The states and transition table for every kind; the factory's moves; every person's move by every actor and at the expected version; what a person may not do; `finding.accept` for audit findings and its refusal for candidates; raising and the two-flow rule; later observations; audit results; returns; declining a tasked candidate; audit obligations, by command and through the engine; nothing creates a task or changes a file |
| `tests/upkeep-ceilings.test.mjs` | 18 | Caps; overdue candidates at a cap; reads of a candidate write; age expiry, directly and through the job; observed classes; every ceiling at its count and one under; the share's days and fullness; lifting, by whom, and what is judged after; suspension through the job |
| `tests/upkeep-health.test.mjs` | 5 | The card, safe text, forms and the commands they send; suspensions and the lift; audit finding forms; 320 px |
| `tests/upkeep-records.test.mjs` | 1 added, 3 changed | The slice 4 functions' reads on the large history, with an open audit backlog of 1,000; the new indexes against the baseline release |
| `tests/upkeep-namespace.test.mjs` | changed | The two new modules join the list of modules that reach no provider and write no task |

The model is scripted everywhere; no test starts a provider process.

### Acceptance (section 15, slice 4)

| Acceptance item | Test |
| --- | --- |
| Every transition in 4.3 only to its listed actor | `upkeep-lifecycle`: "the states and the transition table are the design's…", "the factory's moves…", "every person's move is allowed only to the listed actor…" (operator, delegated orchestrator, orchestrator without an instruction, a delegation that does not list the command, every command delegated for `context` and `rule`, and every other actor name refused), "what a person may not do…", "finding.accept … for an upkeep candidate it is refused to every actor…" |
| …and only at the expected version | "every person's move names the expected version…" (stale, ahead, missing, wrong type, repeated); "the factory's moves…" (factory tasking at a stale version) |
| A rule or learning class is raised only after two distinct flows; the same flow twice does not count | "a docs, context, check or stale-learning class is raised from one flow; a rule or a learning only from a second distinct flow…" |
| Observed classes expire through their indexed path without reading the finding set | `upkeep-ceilings`: "observed classes expire through their indexed path…"; `upkeep-records`: "slice 4 on a large settled history…" |
| A declined candidate is not reopened by a later observation | `upkeep-lifecycle`: "a later observation never reopens a closed candidate…" |
| A third return expires the candidate | "a candidate may return twice; a third abandonment expires it…" |
| Declining a tasked candidate closes its task and declines every linked candidate | "declining a tasked candidate closes its task and declines every candidate linked to it…" |
| Audit dispositions close and reopen obligations as in 4.4 | "audit dispositions close and reopen the finding's obligation…", "a tasked audit finding: its obligation stays pending, passes with the task id when the task merges, and fails when its flow fails" |
| Each ceiling suspends its part at exactly the stated count | `upkeep-ceilings`: "runs that reach the model…", "runs that produce any candidate…", "docs follow-ups that end…", "context and capture candidates…", "a revert or regression…", "the seven-day share…", "through the job…" |
| …and only the operator lifts it | "only the operator lifts a suspension…", "after a lift the ceiling is judged only on what is recorded afterwards…" |
| The seven-day share uses complete days only | "the seven-day share uses complete days only…", "the share window is full only when counting began before its oldest day…" |
| No candidate creates a task or changes a file | `upkeep-lifecycle`: "no candidate can create a task or change a file…" |
| Health shows candidates and suspensions; safe text; 320 px | `upkeep-health`: all four |
| 4.5 read limits; the idle tick | `upkeep-records`: "slice 4 on a large settled history…"; `upkeep-ceilings`: "a candidate write reads each class key by key…"; `upkeep-observe`: "a tick with no upkeep work adds exactly one meta read…", unchanged |
| Graph digests | `upkeep-records`: "the reference graph digests are the baseline's…"; `upkeep-authority`: "graph digests are identical…"; both unchanged |

### Fail-before evidence

At the base the three new test files fail to load (the modules do not exist). Each row is one partial revert of the committed source, run against the three new files (35 tests), plus `upkeep-records` for the last two.

| Source state | Result |
| --- | --- |
| The actor is not checked: any move by anyone | 1 fails |
| A context proposal or a rule may be acted on by a delegate | 4 fail |
| `finding.resolve` does not check the expected version | 2 fail |
| `finding.reopen` does not check the expected version | 1 fails |
| A rule or a learning is raised from its first flow | 4 fail |
| The same flow counts as a second flow | 1 fails |
| A later observation reopens a closed candidate | 2 fail |
| Observed classes are not expired at run settlement | 1 fails |
| A third return does not expire the candidate | 1 fails |
| Declining a tasked candidate leaves the other linked candidates | 1 fails |
| Declining a tasked candidate leaves its task open | 3 fail |
| A disposition does not close an audit obligation | 4 fail |
| A reopen opens no new audit obligation | 2 fail |
| A merge does not deliver the findings of its task | 1 fails |
| A failed flow does not fail the findings of its task | 1 fails |
| The model ceiling suspends at 7 of 20 | 4 fail |
| The candidate ceiling suspends at 5 of 20 | 1 fails |
| The run windows are judged before they are full | 2 fail |
| The docs window has no "in a row" rule | 1 fails |
| The docs ceiling suspends at 4 of 10 | 1 fails |
| The context and capture ceiling suspends at 6 of 10 | 1 fails |
| A regression of an upkeep change does not suspend everything | 1 fails |
| The share reads today as one of its days | 1 fails |
| The share window counts as full whenever counting started | 1 fails |
| After a lift, the windows are judged on what caused the suspension | 1 fails |
| `upkeep.lift` accepts the orchestrator | 1 fails |
| The lift function accepts anyone | 1 fails |
| A suspension records counts, not the window's entries | 3 fail |
| A part at its cap does not expire overdue candidates first | 1 fails |
| The status snapshot lists no candidate while the finding kind is unverified | 1 fails |
| `finding.accept` accepts an upkeep candidate | 2 fail |
| The observed-class expiry also reads the live finding set | 2 fail (with `upkeep-records`) |
| Every candidate write reads the live finding set | 3 fail (with `upkeep-records`) |

## Review of `fb4949c`

Independent review (GPT-6.1 Sol): changes requested, two P2 findings. It confirmed the acceptance assertions, command-route authority, version checks, atomic linked declines, the ceilings, complete UTC days, suspension evidence, the idle tick, the digests and safe DOM. Each fix has a test that fails without it.

**P2-1. A cap read every open audit finding.** The cap lookup (and the assessment's list of open candidates, and expiry) read the whole live finding set and filtered it to upkeep candidates. Audit findings have no cap and no expiry, so the read grew with the audit backlog: 10 open candidates and 1,000 open audit findings read 1,010 rows. *Fix:* a declared partial index over open upkeep candidates (`records_finding_open_upkeep`), read by `openUpkeepCandidates`; every upkeep path that needs the open candidates uses it, and the function that read the whole live set is gone. The design's 4.5 table says so now (two rows, marked). *Tests:* `upkeep-ceilings`, "review P2-1: …" (the reviewer's repro: 10 rows read, through the index); `upkeep-records`, the large-history fixture now has 1,000 open audit findings (10 on the small one) and a raise at the cap reads the same on both.

**P2-2. Tasked findings fell out of Health.** The dashboard listed open findings and the 20 most recently recorded. A finding accepted into a task after 20 newer ones were recorded left both, so Health lost its controls while its to-do stayed pending; likewise a finding declined long after it was recorded lost its Reopen. *Fix:* two declared partial indexes, tasked findings and closed findings, each keyed by `statusAt`; Health lists every open finding, the 100 most recently tasked, the 20 most recently closed and, as before, the 20 most recently recorded. Each read is one index search with a limit and no sort, and the same findings are listed with the kind unverified. *Test:* `upkeep-health`, "review P2-2: …".

**The open questions, settled by the reviewer's recommendations.**

| # | Question | Settled |
| --- | --- | --- |
| 1 | Candidate writing in slice 4 | **Deferred to slice 5.** `propose` stays refused. |
| 2 | An audit task that completes without a merge | **Resolved elsewhere, with explicit completion evidence.** The disposition keeps `completion` and the evidence names the flow and what its completion rests on. *Test:* `upkeep-lifecycle`, "a tasked audit finding whose task completes without a merge…" |
| 3 | A failed audit finding whose task later merges | **Delivered**, when it still names the task and the merged flow ran the revision it was recorded against; its to-do passes. *Test:* `upkeep-lifecycle`, "a failed audit finding is delivered by a later proven merge…" (also: not after a brief edit, not without a revision, not for another task, never an upkeep candidate) |
| 4 | Observe-mode runs and the candidate ceiling | **The full-window rule stays.** The question's premise was wrong: four producing runs cannot suspend anything before the 20th run, because a run window is judged only when full. What can interrupt the observe trial of 14.1 is the seven-day share ceiling, which is judged by days; `docs/operations.md` now says so, and that the operator reviews and lifts it. |
| 5 | Tasked and closed upkeep candidates in Health | **Slice 5**, with delivery. |

Fail-before, one partial revert each, with the four test files that hold the new tests (47 tests):

| Source state | Result |
| --- | --- |
| Upkeep reads the whole live finding set and filters it | 4 fail |
| Health lists open findings and the last 20 recorded (the reviewed read) | 1 fails: the P2-2 test |
| Closed findings are taken by insertion, not by status time | 1 fails |
| Tasked findings are unbounded | 1 fails |
| A later merge does not deliver a failed audit finding | 1 fails |
| Any revision of the task delivers it | 1 fails |
| The failed to-do is not passed by the late delivery | 1 fails |
| No completion evidence | 1 fails |

## Open questions

None. The five the first version raised are settled above.
