# dev.83: assumptions go on, builder questions get a card, a replanning planner keeps its plan

Implementation on branch `t3/planning-builder-flow-fixes`; not a release. Findings are numbered as in the dev.82 re-test (G2, G3, G4, G16). Tests: `tests/planning-builder-flow.test.mjs` (14 tests), plus two existing assertions updated for the schema and prompt change. An independent review approved `51f8909` with fixes; see [Review fixes](#review-fixes).

## Problem

**G4: almost every flow stopped for a planner question.** On dev.82, 5 of 5 change and document flows stopped at `plan-question`; four of them had a ready plan whose only questions the planner itself called non-blocking ("Should the usage guide link back to the tags guide? … the plan assumes no"). Each needed an operator `proceed` before anything was built, so an unattended queue waited for a person on nearly every task.

**G2: a builder's `implemented` result with a question was "blocked" with an empty card.** The builder returned `status: implemented`, all checks passing, and one question (the same non-blocking question the planner had asked and the operator had answered with `proceed`). The flow went to `build-question` with the node's fixed text, answers `retry` and `stop`, and no context; the question was only in the attempt's `action-result.json`. The builder had also not been told that the operator's `proceed` settled the question, so it asked again.

**G3: after a clarification the planner did not see its earlier plan.** The operator answered four numbered questions by number ("1: approved; 2, 3, 4: your assumptions are accepted as written"). The planner's prompt had the note but not the plan it referred to; its next plan asked again and said the earlier plan was not visible.

**G16: `status --task` left out what an orchestrator needs to confirm a task change**: the per-task `models`, the schedule time `notBefore` and the acceptance criteria.

## Decision (operator, 2026-11-15)

A ready plan whose only questions are ones the planner marks non-blocking proceeds straight to plan review without stopping. The questions and the planner's assumed answers are recorded on the flow and carried to the merge card and the merge question's context, so the operator sees them before merging. Blocking questions, a plan that is not ready, and a strict plan whose risk assessment is incomplete still stop. The same treatment applies to the builder.

## Design

**How a worker marks a question non-blocking: a per-question split.** The planner's (`RISK_PLAN_SCHEMA`) and builder's (`DELIVERY_BUILD_SCHEMA`) result schemas gain `assumptions: [{question, assumption}]` (both non-empty strings). `questions` now holds only questions the worker cannot go on without. This is more precise than dev.82's rule (a `ready` status meant every listed question was non-blocking): each question is classified, and every non-blocking one carries the answer the work assumed, which is what the reviewer and the operator need to check. The field is required, like every other field, because Codex structured output requires every property to be listed in `required`; the providers are given the schema with the prompt, so their results always have it. Results recorded before dev.83 have no `assumptions`; every reader treats a missing field as an empty list.

The prompts say it (`workflows/dispatch.mjs`): the planner returns `blocked` only when the plan cannot be carried out without an answer, puts each question whose answer would not change the plan in `assumptions` with the answer assumed, and is told that a ready plan with only assumptions goes on while a ready plan that still lists questions waits for the operator (`PLANNER_QUESTION_GUIDANCE`). The builder gets the same rule (`BUILDER_QUESTION_GUIDANCE`).

**Routing: no new route.** The planner's route was already `ready` exactly when its status is `ready`, its `questions` list is empty and (strict work) its assessment is complete; the builder's was `implemented` exactly when its status is `implemented` and `questions` is empty. Neither expression changed. Moving non-blocking questions out of `questions` is what lets those results route on. So:

- a ready plan with only assumptions routes `ready` → plan review;
- a ready plan that still lists `questions` routes `blocked` → plan question, with `proceed` offered as in dev.82 (`proceedable` is unchanged);
- a blocked plan, or a strict plan without a complete threat model and stop conditions, routes `blocked` → plan question, without `proceed`;
- an implemented build with only assumptions routes `implemented` → commit, fast checks and review;
- an implemented build with `questions`, or a blocked build, routes `blocked` → build question.

**Carried questions** (`core/worker-questions.mjs`). When a plan or build attempt settles, its assumptions are recorded on the flow as `carriedQuestions` (`{from: planner|builder, attemptId, question, assumption}`), one entry per question. A later answer to the same question replaces the current one and the earlier versions stay in its `history`; a new plan archives the earlier plan's questions it no longer asks; at most 20 are kept, and what does not fit is counted, never dropped silently (all as revised in [Review fixes](#review-fixes)). A `proceed` answer adds the plan's own `questions` with `answer: "proceed"`, who answered and the note. Every entry is bounded (1,000 characters per question, assumption and note) and stripped of control and terminal characters with `core/text.mjs` (`boundedText`, a shared bounded form of `stripControls`), when recorded and again whenever shown. They reach:

- **the plan reviewer and the code reviewer**: the list, as JSON marked as untrusted worker text, with "If an assumption is wrong for this task, report it as a blocking finding" (`carriedQuestionsBrief`). The action specification carries `carriedQuestions` (`workflows/actions.mjs`);
- **the builder**: the same list as settled answers ("work on the assumed answers unless Operator feedback says otherwise, and do not ask them again"). This also fixes G2's second half: a question settled by `proceed` is now in the builder's prompt as settled;
- **the merge question**: its own structured field `carriedQuestions` (`{questions, overflow}`, each question with its `history` when its answer changed), so `status --inbox` shows them; the console renders that field as a "Went ahead without an answer" card. (The reviewed version appended a text copy to `context` and hid it in the console by matching its heading; see review fix 4.)
- **the completion notice** of a task flow: the same list after the outcome (`flowNotice`).

Notification payloads still carry no prose; a consumer reads the item.

**Build question card (G2).** A build question is a question step the build step's results route to (`resultQuestionSteps(workflow, 'build')`, generalised from dev.82's `planQuestionSteps`), so project graphs get it too. Its item (`buildQuestionItem`) carries:

- `context`: an opening line that says whether the builder reports the work implemented but asks questions it cannot settle (nothing committed or reviewed yet), is blocked with questions, or is blocked without a question; the numbered questions; "What the builder did" (its summary); the answers it assumed for other questions; departures from the plan; acceptance it could not verify; proposed rule changes; and how to answer for the answers the node offers, with the task-edit warning. The opening line and the answering guidance are always kept in full and the builder's text is cut first, within 12,000 characters (`boundedContext`, now shared with the plan question);
- `buildQuestion`: the same content structured (`status`, `attemptId`, `questions`, `omittedQuestions`, `assumptions`, `summary`, `departures`, `unverified`, `proposals`);
- `choices`: "Answer and continue the build" (`retry`) and "Stop flow"; other answers of a project graph get their readable label.

The console labels `retry`'s note "Your answers to the builder’s questions". A `retry` with a note reaches the builder in its session as operator feedback, as before. No `proceed`-like answer was added to the build question: that would change the reference graph (see Compatibility), and a builder that only has non-blocking questions now goes on without asking.

**Plan question card.** For a ready plan that still lists questions the opening line now reads "The planner marked its plan ready but left N questions open" (it said they were non-blocking, which is no longer what `questions` means), and a ready strict plan without questions says it cannot go on as it is. The card lists the plan's assumptions, and `planQuestion` gains `assumptions` and `summary` (the re-test read a `null` summary from the structured item).

**Clarifications and `proceed` stay coherent.** A ready plan with only assumptions never reaches the plan question, so it uses no clarification and no answer. When a plan does stop, `replan` (three free clarifications per plan cycle, then counted) and `proceed` (only for a proceedable plan, refused on a changed plan or subject) work exactly as in dev.82; `proceed` now also records the questions it went ahead on.

**A replanning planner revises its own plan (G3).** When the flow returns to planning with a plan on record (after a clarification or a plan review revision), the planner's prompt carries `previousPlanBrief`: its previous plan's status, summary, files, checks, risks, assumptions, departures and its questions numbered as the operator saw them ("1. …"), with "Revise this plan instead of starting over … The operator's answers are the latest entries in Operator feedback and may refer to these question numbers. Do not ask again a question the operator answered, and do not turn an accepted assumption back into a question." Context budget: the numbered questions and the operator's answers are reserved first and the other fields share the rest of a 16,000-character bound (review fix 2); the governing context keeps its own bound. `flow.replan` clears the plan as before, so a deliberate new cycle starts from nothing.

**`status --task` (G16).** The task in the narrow read adds `acceptance`, `models` and `notBefore` (null when unset), read from the one task record (`operations/state-view.mjs`); `outcome` was already there. The starter's `factotum-state.example.jq` filter gives the same fields (it lacked `outcome` too). `status --help`, `docs/running.md`, the T3 guide and the T3 notification example say what the task part contains.

## Compatibility

- **Graph digest: unchanged.** No node, route or question text of the reference graphs changed. `digest(changeWorkflow({policy:{},repository:{}}))` is `8fe93dd6…` and `documentWorkflow` `6775d029…` on both the base `159d54c` and this branch, as is a change graph with fast checks. Projects on the reference graphs re-commission with no re-approval of queued tasks.
- **Project graphs.** Unaffected in structure: the routes they already declare (`ready`/`blocked`, `implemented`/`blocked`) are the only ones used. They get assumptions-go-on, the carried questions, the build question card (for any question their build step routes to) and the previous-plan context, because those are core behaviour. A graph without a plan or build question (for example `blocked: stopped`) still works; a test commissions and runs one.
- **Running flows.** A flow pins its executor, and an upgrade requires a drain, so in practice flows admitted before the upgrade finish under the old code. If one is stepped by this code: results it already recorded have no `assumptions` and nothing is carried for them; an open plan or build question keeps its old item until answered; a `proceed` answer records the questions it went ahead on.
- **Provider results.** The planner and builder schemas gain a required `assumptions` array; an older-shaped result from a provider fails validation as any incomplete result does. The scripted recordings in `evals/recordings` use the unchanged `BUILD_SCHEMA` and `REVIEW_SCHEMA`.
- **Records.** Flows gain optional `carriedQuestions`, `carriedOverflow`, `carriedArchive` and `carriedArchiveOmitted`; `workerReports` entries gain `assumptions`; inbox items gain optional `buildQuestion` and (merge questions) `carriedQuestions`, and `planQuestion` gains `assumptions`, `omittedAssumptions` and `summary`; the action specification gains `carriedQuestions` and `carriedOverflow`; a new event `flow.carried-overflow`. `mergeContext` is unchanged. No schema migration and no configuration change. No SQL JSON reads or scans were added: the merge context and the notice read the flow already in hand, and the narrow read reads the task by key.

## Tests

`tests/planning-builder-flow.test.mjs`, 14 tests. Fail-before evidence for the first version: its 9 tests were run against a `git archive` of the base `159d54c` with only the test file added: **9 of 9 fail**. The review fixes' tests are listed under [Review fixes](#review-fixes). After: 14 of 14 pass.

| Test | Fix | Fails on the base because |
| --- | --- | --- |
| the planner marks non-blocking questions as assumptions, and a ready plan with only assumptions routes ready | G4 | the schemas have no `assumptions` |
| a ready plan with only assumptions goes to plan review without stopping and carries them, sanitised | G4 | the flow has no `carriedQuestions` |
| the plan reviewer, the builder and the code reviewer are given the carried questions | G4, G2 | the prompts do not contain them |
| proceed carries the questions it went ahead on, with the operator note, and proceed is still offered when a plan stops | G4 | the card does not show assumptions and says the questions are non-blocking |
| the merge question, the merge card and the completion notice list the carried questions | G4 | the merge question carries nothing about them |
| an implemented build that asks a blocking question opens a full build question card | G2 | the item has no context |
| an implemented build with only assumptions goes on to commit and carries them; a project graph without a build question still works | G2 | nothing is carried (`carriedQuestions` undefined) |
| a replanning planner is given its previous plan with numbered questions and told to revise it | G3 | the prompt has no previous plan |
| status --task shows the acceptance criteria, per-task models and schedule time | G16 | `acceptance` is missing from the task |

Updated existing assertions: `tests/risk.test.mjs` (a valid plan result now includes `assumptions: []`) and `tests/planning-convergence.test.mjs` (the planner guidance names `assumptions` instead of "return status ready with them in questions"). Every other dev.82 assertion is unchanged.

Full suite on this branch: 1,057 tests, 1,057 pass, none skipped; `npm run eval` exits 0. On the base `159d54c`, the full suite run in this worktree at the start had 1,048 tests, 1,038 pass, 10 fail; the failures were 60-second timeouts and fixture-timing tests while two other builders loaded the machine, and none of them recurred in later runs.

## Limits

- Whether a planner or builder classifies its questions well depends on the model. A non-blocking question it still puts in `questions` stops the flow as before (with `proceed` for a ready plan); a blocking question it wrongly puts in `assumptions` goes on, and is caught, if at all, by the plan reviewer, the code reviewer or the operator reading the merge question. That is the operator's decision of 2026-11-15.
- A build question has no `proceed` answer (operator decision: deferred, to keep the digest stable): an implemented build that still lists questions needs `retry` with a note (or `stop`). Follow-up: a future version may add one, with approval bound to the exact build result and candidate; it will change the reference graph's digest.
- At most 20 questions are carried. Going past that stops the flow; an operator who resumes accepts a list every reader is told is incomplete, and the rest is only in the attempts' `action-result.json`.
- The previous plan is given to the planner only while the flow holds it; `flow.replan` clears it deliberately.

## Release notes (proposed)

- **Ready plans with only non-blocking questions no longer wait for the operator.** The planner lists such questions in a new `assumptions` field with the answer it assumed; the plan goes to plan review, the reviewers check the assumptions, and the merge question, the console's merge card and the completion notice list them. Questions the planner lists in `questions` still stop the flow. The builder works the same way. No re-approval: the reference graphs did not change.
- **Build questions carry the builder's questions**, what it did, its assumptions, departures and unverified acceptance, with labelled answers.
- **A replanning planner sees its previous plan** with its questions numbered as you saw them.
- **`status --task` shows `acceptance`, `models` and `notBefore`.**

## Review fixes

An independent review (GPT-6.1 Sol) of `51f8909` approved it with fixes: three blocking findings and one non-blocking. It confirmed that strict handling is not bypassed, reviewers see the assumptions, build `retry` routing is right, the schema change is compatible, `flow.replan` clears the previous plan, the reference graph digests are identical on base and head, and the suite passed (1,057).

1. **A corrected assumption kept its original answer (blocking).** `recordCarriedQuestions` deduplicated by question and discarded the later answer, so `{question: "Use CSV?", assumption: "Yes"}` followed by the same question with "No, JSON per corrected plan" still carried "Yes" to builders, reviewers and the merge card. Fix: one entry per question, matched without regard to case and spacing and across planner and builder; the latest answer wins and replaces the current one; the earlier versions are kept in the entry's `history` (the last five, with a count of older ones). The merge card marks a changed answer ("Changed during the flow. Earlier: …") and the completion notice says "(changed; earlier: …)". Builders and reviewers get only the current answer.
2. **The previous-plan cap could drop every numbered question (blocking).** The brief serialised files, checks and risks before the questions and then cut the whole JSON at 16,000 characters, so a 4,000-character summary and 100 file entries of 300 characters removed the only question. Fix: the numbered questions (up to ten of 1,000 characters, with a count of any beyond) and the operator's latest three answers to plan questions (1,000 characters each; the full notes stay in Operator feedback) are placed first and never cut. The status, summary, assumptions, files, checks, risks and departures then share what is left of the bound, item by item; a cut summary is marked, and the items that did not fit are counted in `omitted`, which the prompt points to.
3. **Assumptions beyond 20 disappeared silently (blocking).** The list was sliced at 20, so a 21st planner assumption was missing from the prompts and the merge context with no marker, and builds that filled the list pushed out a later plan's assumptions. Fix: at most 20 current entries are kept (each bounded); what does not fit is counted in `carriedOverflow` (`{planner, builder, attemptIds}`, naming the attempts whose `action-result.json` has it). Settlement then stops the flow for the operator instead of going on (event `flow.carried-overflow`; `resumeStep` is where it would have gone): resume goes on with the kept list, `flow.replan` with a note asks for fewer. When the result routes to a question anyway, that question is the stop. A `proceed` answer is refused when its questions cannot all be carried, or when the plan's own assumptions already overflowed. Every view states what is missing: the reviewer and builder prompts ("This list is incomplete: …"), the merge question's field (`overflow`) and its console card, and the completion notice. The plan and build question cards, which show ten assumptions, say how many more are in the attempt's result (`omittedAssumptions`), and the completion notice's text counts entries it cannot show. A new plan resets the planner's overflow count.
4. **Duplicate suppression could hide unrelated merge context (non-blocking).** The console hid everything after the first occurrence of the carried list's heading text. Fix: the merge question's `context` no longer contains the list; the item has its own structured field `carriedQuestions` (`{questions, overflow}`), which the console renders as a card. No text is matched. `mergeContext.carriedQuestions` was removed, so the list has one source.

Decisions on the reviewed version's open questions (operator):

- **A `proceed` answer for build questions: deferred** to keep the digest stable. Recorded as a follow-up under [Limits](#limits).
- **Builder assumptions on `flow.replan`: cleared.** `flow.replan` now archives every carried question (planner and builder) to `carriedArchive` with `archivedBecause: "flow replanned"` and stops carrying them; it also clears the overflow count. A later plan that no longer asks a question archives it with `archivedBecause: "a later plan no longer asks it"`. The archive keeps the last 40 entries and counts older ones.
- **A separate item field: yes** (fix 4).

Tests, added to or rewritten in `tests/planning-builder-flow.test.mjs`, each run against a `git archive` of `51f8909` with only the test file replaced (**6 of 6 fail there**, the other 8 pass):

| Test | Fails on `51f8909` because |
| --- | --- |
| a corrected assumption replaces the earlier answer everywhere and keeps it as history | the carried entry still says "Yes" |
| the previous-plan brief keeps the numbered questions and answers however large the rest is | the reviewer's repro brief has no questions |
| assumptions beyond the bound are counted, marked everywhere and stop the flow for the operator | the flow goes on to plan review with Q21 missing |
| flow.replan archives the carried questions as history and stops carrying them | the builder's assumption is still carried |
| a merge question context that quotes the carried heading is shown whole (no text matching) | the console cuts the context at the heading text |
| the merge question, the merge card and the completion notice list the carried questions (rewritten for the item field) | the item has no `carriedQuestions` field |

Full suite after the fixes: 1,062 tests, 1,062 pass, none skipped; `npm run eval` exits 0; `git diff --check` is clean.

### Round 2

A re-check (GPT-6.1 Sol) of `1c66d7d` approved it with fixes: two blocking and two non-blocking. It confirmed that corrected answers win with history in order, an overflow resume does not loop, an overflowing `proceed` is refused, replan archiving and the structured field work, no reader is left on the removed copy, digests are unchanged, and 1,062 of 1,062 tests pass.

1. **Normalisation merged different questions (high, blocking).** Matching ignored case and collapsed inner whitespace, so ``Export `UserID`? → Yes`` and ``Export `userid`? → No`` became one entry, and the `UserID` question showed "No" with "Yes" as an earlier answer: a correction that never happened. The same could happen to spacing inside a literal. Fix: questions match exactly, ignoring only leading and trailing whitespace. A real correction (the same question, perhaps with different surrounding whitespace) still replaces the answer and keeps history; the correction test uses the identical question.
2. **The previous-plan payload could exceed 16,000 characters (medium, blocking).** The reserved questions and answers were measured before escaping, and a negative remainder was not enforced: ten questions and three notes of 1,000 double quotes each gave 26,246 characters of JSON. Fix: every budget is measured on the serialised form, and 16,000 characters of JSON is a hard limit (`PREVIOUS_PLAN_CHARS`; the function throws rather than return more, which no input reaches). The questions and answers are reserved first; when they alone are over their share (16,000 less a 600-character skeleton), the longest are cut to one common serialised length, so short items stay whole and long ones are cut evenly. Each cut item keeps its question number and the start of its text and ends with "… [cut to fit; N characters in all]", and `omitted` counts `questionsCut` and `answersCut`. The summary and the optional fields then share the measured remainder, with every key present from the start so each measurement includes it. The reviewer's repro now gives 15,956 characters with all ten numbered questions and all three answers.
3. **Overflow locations became incomplete (medium, non-blocking).** `carriedOverflow.attemptIds` names the last ten attempts; more are now counted in `omittedAttempts`, and the marker says "and of N earlier attempts not named here (every plan and build attempt of this flow is in its attempt history)". The console card says the same.
4. **The merge warning left review coverage implicit (low, non-blocking).** The console card now says that the reviewers did not see the questions that were not kept: the plan reviewer, the builder and the code reviewer were given only the kept list, marked incomplete.

Tests, run against a `git archive` of `1c66d7d` with only the test file replaced (**5 of 17 fail there**, the other 12 pass): three new tests (questions that differ in case or inner spacing are different questions; the previous-plan payload never exceeds its bound; overflow beyond the named attempts is counted and said) and two changed assertions (the review-coverage sentence on the console card, in the overflow test; the brief's new `omitted` wording, in the previous-plan test). After: 17 of 17 pass.

Full suite after round 2: 1,065 tests, 1,065 pass, none skipped; `npm run eval` exits 0; `git diff --check` is clean.
