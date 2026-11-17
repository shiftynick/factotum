# dev.82: planning converges, and a plan question carries the planner's questions

Implementation on branch `t3/planning-convergence`; not a release. Findings are numbered as in the dev.81 readiness trial report. Tests: `tests/planning-convergence.test.mjs` (15 tests) and one existing test pinned to its old bound. An independent review rejected the first version (`64224a7`); see [Review fixes](#review-fixes).

## Problem

**F15: planning did not converge on a strict task.** Six plans and three plan reviews, and two stops at the plan bound, before any build. The `change.standard` plan step allowed two visits per cycle. The observed sequence: plan 1 blocked with questions; the operator answered `replan` (visit 2); plan review `revise` with one high finding; stop at the plan bound; `flow.replan`; plan; review `revise` with one new high finding; plan; the planner asked a question it called non-blocking, which still routed to the plan question; `replan`; review `revise` with one new finding; stop at the bound again. Each plan review raised exactly one new numeric edge case per round. Over the trial, 6 of 12 plan reviews said `revise`.

Three things combined: answering the planner used a plan visit, a ready plan with non-blocking questions could only be replanned or stopped, and reviewers reported one new finding per round.

**F12: the planner's clarification question reached the inbox without the question.** When the planner returned `status: blocked` with two concrete questions, the inbox item said only "The plan needs clarification. Update the task or governing context, then choose replan." with answers `replan` and `stop`. The questions, proposed options and risk escalation were only in `attempts/<plan attempt>/action-result.json`. The suggested remedy, updating the task, would revoke the task's approval; answering `replan` with a note was not suggested.

## Decisions (operator)

1. Answering a planner question no longer uses a plan attempt.
2. A "proceed with this plan" choice exists for a ready plan whose questions the planner marks non-blocking.
3. Plan reviewers (and code reviewers) report every finding they can see in one round, scoped to the task, and do not raise out-of-scope hardening as blocking.
4. The reference graph's plan attempts per cycle rise from 2 to 3.
5. F12: the plan question's item carries the planner's questions, options and risk escalation, and suggests `replan` with a note instead of a task edit.

## Design

**Plan questions.** A plan question is any question step that the planning step's results route to (`planQuestionSteps` in `core/operations.mjs`; `plan-question` in the reference). Identification is by the graph's edges from the step bound to `plan`, not by node names, so project graphs get the same behaviour.

**Clarifications are capped, and the first three per plan cycle are not counted** (`core/project.mjs`, `answer`). An answer to a plan question that moves the flow to the planning step is a *clarification*; the flow counts them in `planClarifications`, and `inbox.answered` carries `clarification` (its number). The first three of a plan cycle (`PLAN_CLARIFICATIONS`) grow `limitExtensions[plan]` by one before the move: `visits` still records the entry (it stays cumulative), `visitBudgets.plan.used` does not change, and the event carries `uncountedVisit: "plan"`. Later clarifications count against the plan bound like any plan entry. A clarification never extends a step bound or the transition allowance, with or without a note; the note is still delivered as operator feedback. So per plan cycle at most three free clarifications plus the plan bound's own entries can happen, after which a `replan` answer is refused with `workflow visit bound exhausted at plan`. Recovery is `flow.replan`: a new plan cycle, which resets `planClarifications` and supersedes the open question (a replan now supersedes any open question of the flow), or `stop`. This applies to project graphs with their own `plan.maxVisits` too. `flow.replan` and plan review revisions count as before.

**Proceed** (`core/plan-questions.mjs`). The reference plan question's answers are `{replan: plan, proceed: plan-review, stop: stopped}`. The planner's result still routes `blocked` (no new route, so project graphs and their `resultEdges` are unaffected). When the question opens, `proceed` is kept in the item's `answers` and `transitions` only if the plan is *proceedable*: the planner returned `status: ready`, listed at least one question, and, when the flow's effective risk is strict, its risk assessment has a complete threat model and stop conditions. That is exactly the rule a ready plan without questions meets to go to plan review, so `proceed` admits nothing a question-free plan would not. An answer `proceed`:

- passes the same actor and delegation checks as any other answer (operator, the question's role, or the orchestrator on a recorded operator instruction with `answer` delegated; strict-review sign-off and integration decisions are unaffected);
- passes the same version, subject and expiry checks (`QUESTION_SUBJECT_CHANGED` when the candidate, task revision, workflow or risk changed);
- is refused if the plan differs from the one the item showed (`planQuestion.planDigest`, a digest of the flow's `results.plan`) or is no longer proceedable;
- moves to plan review with the exact plan, using no plan visit; an optional note is added to `operatorFeedback`, so it reaches the plan reviewer and the builder.

Strict work: `proceed` never skips plan review (commissioning refuses a plan question whose `proceed` goes anywhere other than where the plan step's `ready` route goes), the strict plan review still forces `revise` without a complete threat model, and the merge question's strict sign-off is unchanged.

When the flow returns to a plan question while an item about an earlier plan is still open (a `flow.replan` issued while it was open), that item is superseded and a new one opens, so the operator never answers questions they did not see.

**Should a ready plan with only non-blocking questions go to the operator at all?** Yes, with `proceed` offered. The alternative, proceeding automatically and surfacing the questions as notes, was rejected: the planner's label "non-blocking" is model output, not authority, and an answer can change what the plan reviewer and builder should do (the trial's question was about the task's own behaviour). Asking costs one operator answer, which no longer costs a plan attempt, and a delegated orchestrator can answer it within its existing delegation. The planner prompt now says to return `blocked` only when the plan cannot be carried out without an answer, and otherwise `ready` with the questions and the assumption the plan makes for each.

**The item carries the planner's questions (F12).** For a plan question, the engine adds to the item (`core/engine.mjs`, from `planQuestionItem`):

- `context`: whether the planner is blocked or marked the plan ready, the numbered questions, the plan summary, proposed changes to governing rules (`pushback` proposals), the risk level with any escalation by the planner and whether the assessment is complete, and how to answer: `replan` with a note that answers the questions (it reaches the next planner, the plan reviewer and the builder; the item says whether this replan is free or uses a plan attempt), `proceed` when offered, and that a task edit would revoke approval and stop the flow;
- `planQuestion`: the same content structured (`status`, `questions`, `omittedQuestions`, `proposals`, `risk`, `proceedable`, `freeClarifications`, `planDigest`);
- `choices`: labels for the offered answers ("Replan with my answers", "Proceed with this plan", "Stop flow").

Model text is bounded (ten questions of at most 1,000 characters, a 1,500-character summary, five proposals of 500, a 12,000-character context; the standalone inbox limit is 16,000). The opening line, the risk line and the answering guidance with the task-edit warning are always included in full; the questions, summary and proposals share the rest of the bound and are cut first, with a marker pointing to `planQuestion.questions`. Text is stripped of terminal escape sequences (7-bit and 8-bit CSI) and of C0, DEL and C1 control characters other than tab, newline and carriage return (`core/text.mjs`). The reference node's own `question` no longer says to update the task.

**Rendering.** The console shows the item's `context`, renders `replan` and `proceed` as forms titled with their labels and descriptions, with note fields "Your answers to the planner's questions" and "Answers or assumptions for the plan reviewer and builder (optional)", and `stop` as a labelled button. `answer`'s command help names the plan question's answers and their labels. Notification payloads carry no prose and no answers (unchanged); a consumer reads the item. The T3 guides say a plan question has labels and questions but stays in the console because `replan` needs a note.

**Reviewer guidance** (`workflows/dispatch.mjs`). Plan review and code review prompts gain `reviewScopeGuidance`: judge against the task's acceptance criteria, its declared paths (listed) and the governing context; report every blocking finding visible in this one review and do not hold findings back for a later round; when one missing case is found (a boundary, an empty, zero, negative or oversized input, an error path), check its neighbouring cases in the same review and report them together; hardening or improvements outside that scope go in the summary, never in findings. The existing rules stay (pass needs `findings: []`; code review does not invent hardening outside the threat model; strict rules unchanged).

**Default bound.** `changeWorkflow()` (and so `documentWorkflow()`) sets `plan.maxVisits: 3`.

## Migration and compatibility

- **Projects on the reference graph.** The compiled `change.standard` and `change.document` graphs change (plan bound 3, the plan question's text and its `proceed` answer), so their digests change at the next `config update --current` or upgrade recommissioning. That follows the normal rules: tasks approved against the old digest of a catalog workflow need approving again (`approvedWorkflow`), as with any reference graph change. Flows admitted afterwards get three plan attempts and `proceed`.
- **Projects with their own graph.** Their `plan.maxVisits` and question answers are kept. They get the clarification rules (three free per plan cycle, no bound or transition extensions), the planner's questions in the item and the reviewer guidance (these are core behaviour, not graph content). They get `proceed` only if they add it to their plan question, pointing where `ready` goes; commissioning refuses any other target.
- **Running flows.** Each flow pins its graph and its executor. A change flow admitted before the upgrade cannot step under new code (`pinned executor differs; drain with original code`), and upgrade apply requires a drain, so in practice it finishes under the old rules. If a flow pinned to the old graph is ever stepped by this code, it behaves as follows, and none of it breaks the flow: its pinned `plan.maxVisits` (2) stays; visits it already used are not refunded; answers to its plan question follow the clarification rules from then on (its `planClarifications` count starts at zero); `proceed` is not offered because its pinned node has no such answer (an attempt is refused as an invalid answer); a plan question opened from then on carries the planner's questions, while one already open keeps its old text until answered.
- **Records.** No schema or configuration change. Inbox items gain optional `choices` and `planQuestion` fields; attempt records are untouched.

## Tests

`tests/planning-convergence.test.mjs`, run on this branch (15 pass). The first twelve were run against the base commit `c84a770` with only the new test file added (12 fail); the three review regressions against `64224a7` (3 fail, 12 pass):

| Test | Fails on the base because |
| --- | --- |
| reference graph allows three plan attempts and offers proceed | `plan.maxVisits` is 2 |
| answering a plan question replans without using a plan attempt | `visitBudgets.plan` is `{allowance: 2, used: 2, remaining: 0}`, expected `{3, 1, 2}` |
| a project graph keeps its plan bound, and an answered question still does not count | with `plan.maxVisits: 1` the `replan` answer is rejected (bound exhausted) |
| one clarification and two plan review revisions do not stop at the plan bound | the flow stops at the plan bound after the first revision |
| a third plan review revision still stops at the default bound | the old bound stops the flow a round earlier (guards that the bound still holds) |
| proceed sends a ready plan with non-blocking questions to plan review | answers are `[replan, stop]` |
| proceed is neither offered nor accepted for a blocked plan or an incomplete strict assessment | no `planQuestion` on the item |
| proceed is refused for an unauthorised actor and after the subject or the plan changed | `proceed` is an invalid answer, not refused for a changed plan |
| a delegated orchestrator answers a plan question as delegation allows | `proceed` is rejected |
| the plan question item carries the planner questions, options and risk and suggests a replan note | the item has no context |
| planner and reviewer prompts ask for every in-scope finding in one round | the prompts lack the guidance |
| the console shows the planner questions and labelled replan and proceed forms | the questions are not rendered |
| repeated clarification answers stop at a bound and never extend the transition allowance (`64224a7`) | the first `replan` with a note adds 12 transitions of allowance |
| long planner text never cuts the risk, the answering guidance or the task-edit warning (`64224a7`) | the risk line is cut off |
| C1 control characters are removed from planner questions, check excerpts and forge error text (`64224a7`) | `\u009b`, `\u009d`, `\u009c` and `\u0085` survive |

`tests/repeat-stops.test.mjs` ("repeated replans grant exactly fresh bounded cycles") asserts the exhaustion of a two-visit plan bound; it now pins `plan.maxVisits = 2` on its graph, with every assertion unchanged.

Full suite: 880 tests, 880 pass, none skipped (base: 865 tests, 863 pass, 2 skipped in that run). `npm run eval` exits 0.

## Limits

- Whether reviewers actually report everything in one round depends on the models; the change is prompt guidance, and the bound and the free clarifications are what guarantee progress. A reviewer that still finds one new in-scope case per round now stops at the third revision instead of the second.
- The planner's "non-blocking" marking is its `status`: there is no per-question flag. A blocked plan whose questions are partly non-blocking offers only `replan` and `stop`.
- A reviewer's scope is the task's acceptance, declared paths and governing context. A task without declared paths is described as "none declared", so its scope rests on acceptance and context alone.
- Free clarifications apply to answers routed from a plan question to the planning step. `repair` from the conflict question (which also routes to the plan) is unchanged: it extends exhausted bounds as before.
- Notification payloads still carry no question text; a consumer reads the item.

## Review fixes

An independent review (GPT-6.1 Sol) of `64224a7` rejected it with two blocking findings and one non-blocking finding. It found no authority bypass, and accepted the proceed checks, the commissioning check, the reviewer guidance and the `repeat-stops` pin.

1. **Repeated clarification answers bypassed both bounds (blocking).** The free plan visit was granted per answer, and the existing feedback branch also added 12 transitions of allowance (and a step extension at an exhausted bound) for every `replan` with a note, while a clarification cycle uses two transitions. The review's repro: 60 cycles of a blocked plan answered `replan` with `note: "Use the default."` left the flow ready with 120 transitions against a nominal 104, 720 added allowance and one counted plan visit. The same loop was already unbounded on the base `c84a770` (60 answers accepted, allowance 720, flow ready), through the note extension alone. Fix: a clarification never extends a step bound or the transition allowance; only the first three per plan cycle are free; later ones count against the plan bound, which then refuses the answer; `flow.replan` resets the count and supersedes the open question. The design paragraph above states the cap; the earlier claim that the transition bound alone kept the loop bounded was wrong and is withdrawn. Regression: 60 attempted cycles stop after five accepted answers (three free, two counted) with the answer refused at the plan bound, no transition allowance added, every note delivered, and recovery through `flow.replan`.
2. **The context cut dropped the mandatory parts (blocking).** The context was assembled in reading order and truncated at 12,000 characters, so long planner text removed the risk escalation, the incomplete-assessment warning, the answering guidance and the task-edit warning. Fix: the opening line, the risk line and the guidance are reserved in full and the planner's text is cut to the remaining budget, with a marker. Regression: ten 1,000-character questions, a 1,500-character summary and five 500-character proposals keep all mandatory parts within 12,000 characters.
3. **C1 controls were kept (non-blocking).** The sanitiser removed C0 and DEL but kept U+0080–U+009F, which terminals obey (8-bit CSI `\u009b`, OSC `\u009d … \u009c`). Fix: `core/text.mjs` `stripControls` removes 8-bit CSI sequences and C1 controls as well; plan-question text uses it. The other sanitisers of untrusted text displayed to people had the same gap and are fixed too: check-output excerpts (`workflows/check-diagnostics.mjs`, now `stripControls`) and forge error text (`adapters/github/errors.mjs`). Standalone inbox items are published by the operator or orchestrator and are bounded but not sanitised; that is unchanged. Regression covers planner questions and context, check excerpts and forge error text.

Merging `main` into the branch was a no-op: `main` was still at `c84a770`, this branch's base, so nothing conflicted.
