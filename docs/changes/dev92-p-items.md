# dev.92: the dev.91 readiness re-test findings P2–P4

Three findings from the dev.91 readiness re-test, after P1:

- **P2 (design; operator decision 2026-11-17).** `upkeep.budget.maxTasksPerDay` (2) and `maxTasksPerWeek` (6) counted the operator's own acceptances with the factory's follow-ups. In the trial, one factory docs follow-up and one acceptance used up the UTC day. Every later acceptance by the operator was refused, while `acceptance.problems` read `[]` and Health still offered Accept.
- **P3 (docs, minor).** A hand-written learning with `paths: ["a", "b"]` (a space after the comma) was refused as "not written exactly in the learning layout". The template did not say so.
- **P4 (minor).** `status --flow` had neither `learningSelection` nor `learningUse`. The flow page showed no citations. One Health sentence ("which no flow is shown") was garbled.

**P1** (doctor's Codex sandbox probe lost its output) was fixed on `main` in `12c4f09`, before this work. This work checked it and changes nothing there: `CODEX_SANDBOX_SPAWN_PROBE` (`adapters/providers/index.mjs`) writes its result with `require('node:fs').writeSync(1, …)`, a synchronous write, and `tests/dev91-o-items.test.mjs` pins it.

This is a local implementation record, not a release, activation or live qualification claim. No model session or provider CLI was started.

## Action needed

- **Nothing to migrate.** No schema, graph or configuration key changed, and the graph digests are unchanged. `upkeepDay` rows gain a counter, `operatorTasksCreated`. A row written before dev.92 reads 0 there, so the operator's share of earlier days shows as 0, though those tasks still count in `tasksCreated`.
- **If an orchestrator integration decides whether to accept a capture candidate from `acceptance.problems`, read `acceptance.delegatedProblems` instead.** `problems` now lists what refuses *the operator's own* acceptance. The task ceilings never do, so they are not in it. `delegatedProblems` adds the ceiling, with when it resets, once it applies to a delegated acceptance.
- **`acceptance.problems` can now be non-empty where it was `[]`.** It now includes what refuses an acceptance right now: an open task of the same kind, `upkeep.mode` not `propose`, a drain hold, a suspension or the open-task limit. Each such entry starts with `not now: `. Before, these refusals came only when someone clicked Accept.

## P2: the task ceilings and the operator's acceptances

### The decision and the choice made here

The operator decided (2026-11-17): **the daily and weekly ceilings limit only tasks the factory creates on its own and acceptances made by a delegate; the operator's own direct acceptances are not refused by them.**

- **What counts as direct:** `actor` is `operator`, with no `onBehalfOf` and no cited grant. This is the test `finding.accept` already uses for "accept and approve in one command". Every acceptance of governing-context proposals and rules is direct, because it is refused to anyone else (Q2).
- **Delegated:** the orchestrator acting on an instruction or by delegation, or any command that cites a grant. These are refused at the ceiling, as before.
- **The factory's own tasks** (docs follow-ups) are refused at the ceiling, as before.

**Choice: the operator's acceptances count toward the factory's room.** The ceilings are still judged on `tasksCreated`, which counts every upkeep task, the operator's included. An operator's acceptance therefore never gives the factory or a delegate more room than it had. If the operator accepts two candidates on a UTC day, the factory makes no docs follow-up that day. This is the conservative reading: the factory's own output stays within N6 whatever the operator does. The alternative was to count only factory and delegated tasks. That would have let a busy operator day leave the factory its full room as well, so it was not chosen.

### What changed

- **Counting** (`operations/upkeep-records.mjs`). The new `upkeepDay` counter `operatorTasksCreated` holds the operator's direct acceptances. `tasksCreated` still counts every upkeep task. Stats' upkeep days carry both. The `upkeep.task-created` event gains `direct`.
- **The budget** (`operations/upkeep-tasks.mjs`, `upkeepTaskBudget`, `taskCeilingRefusal`). For the day and for the seven-day window it gives:
  - `created`, and `byOperator` (the operator's share);
  - `limit` and `remaining`;
  - `resetsAt`, set only when the window is full. For the day that is the next UTC midnight. For the week it is the first UTC midnight after which the window holds fewer than the limit, if nothing more is created. A limit of 0 has no reset.
  It reads seven `upkeepDay` rows by key. The refusal names the setting, its value and the reset, for example: "2 upkeep tasks were created today, which is the limit (upkeep.budget.maxTasksPerDay 2); it resets at 2026-11-18T00:00:00.000Z".
- **Where the ceilings are judged:**
  - Docs follow-ups (`blocked`): unchanged in effect. They return `daily-ceiling` and `weekly-ceiling` as before.
  - Context and rule acceptance (`contextBlocked`): no ceiling check, because only the operator, acting directly, reaches it. The task is counted in both `tasksCreated` and `operatorTasksCreated`.
  - Check, learning and retirement acceptance (`captureBlocked`): the ceiling applies only when `direct` is false. `core/project.mjs` passes `direct` from the command, and `createCaptureTaskInTransaction` re-derives it from `actor` and `onBehalfOf`, so a caller cannot claim it. The refusal reads "a delegated acceptance is limited by the task ceilings: …".
  - The open-task limits (one open task per kind, `maxOpenTasks`) still apply to everyone.
- **Health** (`operations/views.mjs`, `console/ui/operations.mjs`):
  - **`upkeep.taskBudget`**, present while upkeep proposes: the budget above plus `refusal`. In any other mode it is `null` and Health reads no day row, because nothing can be created or accepted then. The console shows "Upkeep tasks: N of 2 today (M by you), N of 6 in the last seven UTC days (M by you)", and either the room left or, at the limit, when it returns. It adds that your own acceptances are not limited and still count.
  - **Proposals and rules:** `acceptance.problems` now includes what refuses the acceptance now (the `contextBlocked` reason, prefixed `not now: `), so no Accept is offered that the command refuses.
  - **Check, learning and stale-learning candidates:**
    - `acceptance.problems` covers the operator's own acceptance. It is `captureProblems` plus `captureBlocked` with `direct`, judged without writing. An open task that is past its approval limit, which the acceptance itself would expire, is not counted as blocking.
    - `acceptance.delegatedProblems` covers an acceptance by the orchestrator, and adds the ceiling.
    - Where the operator may accept and the orchestrator may not, the card offers Accept and says "The orchestrator cannot accept it now: …. You can."
- **Design text.** `docs/designs/knowledge-upkeep.md` has dated notes (2026-11-17, dev.92 P2) on Q7 and N6, in 6.6 (task ceiling) and in 8.3. `docs/operations.md` describes the rule and the two problem lists.

### Reads (4.5)

- **Creating a task:** the budget reads the same seven `upkeepDay` rows by key the ceilings read before.
- **Health:** reads those seven rows by key only while upkeep proposes. While upkeep observes or is off it still reads no record, as `tests/upkeep-health.test.mjs` and the large-history test in `tests/upkeep-records.test.mjs` require. The acceptance judgements read the open context or capture task by key and the open upkeep tasks through the namespace index (at most 13 rows), only when a candidate of that kind is open.
- No SQL JSON read over `records.data` and no full scan was added. A test counts the budget's statements: seven, by key, none with `json_extract` or `json_each`.

## P3: a hand-written learning's paths list

**Choice: accept ordinary JSON or YAML flow-list spacing in `paths`, and document the layout.** Accepting it is safe and keeps the round-trip exact:

- A glob can hold no space or quote (`learningGlob`). So removing the spaces from a `paths` line that parses as JSON gives exactly the line `renderLearning` writes. Every other line must still match byte for byte.
- `parseLearning` returns the same fields for `["a", "b"]`, `[ "a", "b" ]` and `["a" , "b"]`, and `renderLearning` of those fields is the canonical file.
- Tabs, single quotes and unquoted (YAML-only) lists are still refused.
- A learning is pinned by Git blob for delivery and retirement, so the file as written is what agents are shown.

**A file the factory adds is still exact.** The candidate check of a `learning-add` task now also requires the added file to equal the accepted text byte for byte (`workflows/upkeep-enforcement.mjs`, code `frontmatter`). Before, the strict parser enforced that indirectly. So a builder that spaces the list is refused, and the message names the line to write.

**The refusal shows the expected form.**
- A `paths` line that does not parse reads "paths is not written as a JSON list of quoted globs, such as paths: ["src/example/**", "test/example.test.mjs"]".
- A file that parses but differs names the line and what it should read, for example: `line 3 should read "title: \"…\""`.
- Extra newlines at the end of the file have their own message.

**The template** (`starter/project/LEARNING.template.md`) shows a list of two with a space after the comma. Its body adds that the frontmatter is exactly those seven fields in that order, the title one JSON string, the paths a JSON list of quoted globs (a space after each comma, or none), then a blank line, the body and one final newline. The template still parses, and the existing starter test pins that.

## P4: a flow's learnings in `status --flow`, citations on the flow page, one Health sentence

- **Recording citations per role** (`operations/learnings.mjs`, `core/engine.mjs`). When a plan, build or review result is settled with a learning selection, the flow records one `learningCitations` entry: `{cycle, step, role, attemptId, at, cited: [{id, use}]}`. Only ids of the pin are kept. `use` is `applied` or `contradicted` for the planner and builder, and `followed` or `contradicted` for the reviewer. A role that cited nothing gets an entry with an empty list. The flow keeps the last 40 entries. The existing once-per-flow counters (`learningUse`) are unchanged.
- **Older flows** (settled before dev.92) have no `learningCitations`. `learningCitationsOf` reads theirs from the latest `plan`, `build` and `review` results, kept to the ids the flow was shown, with no cycle or attempt.
- **`status --flow`** (`operations/state-view.mjs`) adds, from the flow record already read by key:
  - `flow.learningSelection`: the current cycle's pin, without `chars`;
  - `flow.learningHistory`;
  - `flow.learningUse`: `{selected, cited}`, without the delivery-window bookkeeping, or `null`;
  - `flow.learningCitations`.
  Each key is always present.
- **The flow page** (`console/ui/timeline.mjs`). Under each cycle of "Learnings shown to agents" it lists what each role cited, for example "Planner (plan): learning-… applied". It shows the latest entry per role and step, using DOM text nodes only. A cycle nobody cited from says "No role has cited a learning of this cycle yet." The project service's flow detail carries `learningCitations` (`service/project-service.mjs`). The page falls back to the flow record when an older service does not send it.
- **Health sentence.** It now reads: "… read N learnings and refused M files. No flow is shown a refused file, and a refused file never becomes a retirement candidate. Fix or remove each with an ordinary task."

## Tests

| Finding | Test |
| --- | --- |
| P1 (confirmed only) | `tests/dev91-o-items.test.mjs` (existing; the probe writes with `fs.writeSync`) |
| P2, the trial repro | `tests/dev92-p-items.test.mjs`: "P2, the trial repro: a factory docs follow-up, then the operator's own acceptances, which now succeed past the daily ceiling" |
| P2, a delegated acceptance at the ceiling is refused, and Health says so | "P2: a delegated acceptance at the ceiling is refused, Health says so beside the operator's Accept, and nothing is written" |
| P2, the factory still stops; the operator's acceptances use up its room | "P2: the operator's acceptances use up the factory's room, and the factory still stops at the daily and weekly ceilings"; `tests/upkeep-docs-delivery.test.mjs` "acceptance B2" (existing) |
| P2, remaining budget and reset in Health | "P2: the weekly window in Health: what was made, by whom, and when room returns; a limit of 0 has none" |
| P2, no Accept that would be refused | "P2: Health never offers an acceptance the command would refuse: an open task of the kind, or the mode" |
| P2, reads | "P2: the budget Health shows reads seven day rows by key and nothing else"; `tests/upkeep-health.test.mjs` and `tests/upkeep-records.test.mjs` (existing, unchanged: no record read while not proposing) |
| P3, spacing accepted, exact round-trip, expected form named | "P3: a learning whose paths list carries ordinary JSON or YAML flow-list spacing reads as the same learning; anything else names the expected form"; `tests/upkeep-capture.test.mjs` "the starter: the learning template is a valid learning file" (existing, now with a spaced list) |
| P3, a factory-added learning stays exact | `tests/upkeep-capture.test.mjs` learning-add content rules (a spaced list is refused as `frontmatter`) |
| P4, `status --flow` | "P4: status --flow returns the flow's learningSelection, learningUse and what each role cited, read from the flow record by key" |
| P4, recording per role | `tests/upkeep-learnings.test.mjs` "acceptance 1" (now asserts `learningCitations` per attempt) |
| P4, flow page | "P4: the flow page shows what each role cited, as text, at 320 px; a cycle nobody cited from says so" |
| P4, Health sentence | `tests/upkeep-learnings.test.mjs` "review of b46da01, Q2" (updated wording) |

Existing expectations updated for the new counter: `tests/upkeep-records.test.mjs` (day row contract) and `tests/upkeep-budget.test.mjs` (Stats day row).

## Open questions

- **`acceptance.problems` and the ceiling.** The brief asked that `acceptance.problems` name the ceiling when it applies. The ceiling now applies only to a delegated acceptance. Putting it in `problems` would hide the operator's Accept, against the decision, so it is in `acceptance.delegatedProblems`. If the operator wants a single list, the alternative is to tag each problem with who it refuses.
- **Weekly reset wording.** For the week, "when room returns" assumes nothing more is created. If the operator accepts more before then, the date moves later. Health shows the date as computed now.

## Review

The GPT-6.1 Sol review approved P3 and P4, and the operator-direct boundary of P2. It recommended keeping ceiling refusals in `delegatedProblems`, and that is done. It found one P3.

**When both ceilings were reached, Health named the wrong reset time.** The panel and the refusal text named only tomorrow's daily reset, even when the weekly ceiling was still full past that.

**The fix (main thread).** The panel now names the later reset of every exhausted ceiling, through `budgetResumesAt`, or none for a zero limit. The refusal adds the weekly reset when both apply.

**Tests.** Two tests in `tests/dev92-p-items.test.mjs`: "P2 review: …".

The review also approved the sandbox probe fix already on main (12c4f09). The reviewer reproduced the diagnosis offline and confirmed that doctor warnings are redacted in the upgrade result.
