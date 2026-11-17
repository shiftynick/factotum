# Project-owned workflows

A project can run its own delivery graphs instead of, or alongside, the supplied standard graph. Graph files live in the project checkout outside `factory/`, so upstream updates never overwrite them. The project decides the process; Factotum still enforces the operation contracts described in the [design](project-workflows-design.md#operation-contracts-implemented).

## 1. Start from the reference

Export the standard graph compiled for your current configuration:

```sh
node factory/cli.mjs workflow export --state /private/state/project --out project/workflows/change.json
```

Edit the copy. Nodes can be renamed and reordered; behaviour comes from each node's `action.operation`, not its name. Use `"binding"` when one operation could fill more than one slot, for example a second `provider.review` node with `"binding": "satisfied-review"`. Trusted command nodes (`argv`) may declare only prefixed observations such as `"evidence": "check:links"`, which questions can require with `requireEvidence`.

Commit the file through the project's normal reviewed process.

## 2. Declare the catalog

Add `workflows` to the project configuration:

```json
{
  "workflows": {
    "definitions": {
      "standard": {"reference": "change.standard"},
      "change": {"path": "project/workflows/change.json"},
      "content": {"path": "project/workflows/content.json"}
    },
    "selection": {
      "default": "change",
      "rules": [{"category": "content", "workflow": "content"}]
    }
  }
}
```

- A definition is either a supplied `reference` or a `path`: a relative `.json` file inside the checkout, outside `factory/`, not reached through a symlink, at most 256 KiB.
- Selection uses the task's `category`. Each category may appear in only one rule. A task with no matching rule uses `default`. Without a default, approval and admission fail with a reason.

## 3. Commission

Apply the configuration with `config update` (work must be drained), then run `doctor`. `config update` compiles every definition once: it validates the graph and its operation contracts, and pins the file's SHA-256 bytes. Commissioning fails if a graph:

- uses an operation's guard flag to switch off an inherent requirement, or claims evidence it cannot mint;
- requests `role: "orchestrator"` on a `mergeDecision` question while `policy.mergeDecisionRole` is `operator`;
- delegates the already-satisfied decision;
- can reach `forge.publish` other than from the `integrated` result of a `workspace.integrate` step (its `next` when it has no `resultEdges`) through input-preserving steps only (review, gate, fast checks, preview, or a trusted command with `"preserveInput": true`). A builder, a question (the operator may change the worktree there), a wait or an ordinary command between them, a `conflict` or `onFailure` route into publish, a graph that starts at publish, and publish with no integration are refused, with the step and route named. At run time `forge.publish` also requires the workspace `HEAD` to be the head of the last integration that did not conflict.

`node factory/cli.mjs workflow list --state ...` shows the commissioned definitions, their digests and sources, the selection rules and any drift.

## 4. Approval and admission

Approving a task records the workflow selected for it (`approvedWorkflow`: name and digest). Admission recomputes the selection and refuses the task if:

- the selected workflow or its commissioned digest differs from what was approved (approve the task again);
- a commissioned graph file has changed on disk since `config update` (recommission it).

Editing a graph file therefore never changes running or approved work silently. Each flow pins the graph it started with. Tasks show the selected and approved workflow and any of these reasons.

When a catalog is first added, existing approvals have no workflow binding, so those tasks need approving again.

## Loop budgets and recovery

A node's `maxVisits` limits how many times a flow may enter it; the graph's `maxTransitions` limits total transitions. The standard change and document references allow three entries to `plan` per cycle (two before dev.82). Its `plan-review` node has no separate visit limit: a review asking for revision attempts to return to `plan`, and that return can exhaust the plan limit. This stops the flow for inspection; it does not accept a failing review or silently raise the limit.

### Plan questions

A plan question is a question step that the planning step's result routes to (`plan-question` in the reference). From dev.82:

- **Its item carries the planner's questions.** The inbox item's `context` lists the planner's questions, the plan summary, any proposed changes to governing rules (`pushback` proposals) and a strict-risk escalation, bounded (ten questions of at most 1,000 characters, 12,000 characters in all) and stripped of control and terminal characters. The same content is structured in `planQuestion` (`questions`, `proposals`, `risk`, `status`, `proceedable`, `planDigest`). `choices` gives each answer a label. The operator can decide from the item alone; the plan attempt's `action-result.json` is no longer needed.
- **Answer `replan` with a note that answers the questions.** The note reaches the next planner, the plan reviewer and the builder. Do not edit the task to answer: a task edit revokes its approval and stops the flow.
- **The first three replans after an answer in a plan cycle do not use a plan attempt.** Moving from a plan question back to the planning step (a *clarification*) is recorded in `visits`; the first three of a plan cycle are not counted against `maxVisits` (`limitExtensions` grows by one and the `inbox.answered` event carries `uncountedVisit`), and later ones count like any plan entry. The count is the flow's `planClarifications`, and each answer's event carries `clarification` (its number); the item says how many free ones are left. A clarification never extends a step bound or the transition allowance, even with a note (before dev.82 a `replan` with a note did both, so repeated answers could loop without limit). When the plan bound is reached, a further `replan` answer is refused; recover with `flow.replan`, which starts a new plan cycle, restores the three free clarifications and supersedes the open question, or answer `stop`. This holds for every graph, including project-owned graphs with their own `plan.maxVisits`.
- **`proceed` sends a ready plan on as it is.** When the planner marks its plan `ready` but lists questions it does not consider blocking, the item also offers `proceed` ("Proceed with this plan"). It goes to the step a ready plan goes to (plan review in the reference) with the exact plan the item showed. An optional note reaches the plan reviewer and the builder. It is offered and accepted only under the rule a ready plan without questions meets: for strict work, the plan's risk assessment must have a complete threat model and stop conditions. Plan review still runs, and a strict merge still needs its sign-off. `proceed` is refused when the question's subject changed (candidate, task revision, workflow, risk) or the plan changed since the item opened (`planQuestion.planDigest`); an item about an earlier plan is superseded when the flow returns to the question. Who may answer is unchanged: the operator, or the orchestrator on a recorded operator instruction when `answer` is delegated.
- **A project graph may offer `proceed`** by adding `"proceed": "<step>"` to its plan question's answers. Commissioning refuses it unless `<step>` is where the plan step's `ready` route goes.

**Assumptions go on (dev.83).** The planner's and the builder's result schemas have an `assumptions` list: questions whose answer would not change the work, each with the answer assumed. `questions` holds only questions the worker cannot go on without. A plan routes `ready` when its status is `ready`, its `questions` are empty and (strict work) its risk assessment is complete, whatever its assumptions; a build routes `implemented` when its status is `implemented` and its `questions` are empty. No route was added, so project graphs need no change and the reference graphs' digests did not change. The flow keeps the assumptions in `carriedQuestions`, one entry per question, matched exactly (only leading and trailing whitespace is ignored, since case and spacing can matter, as in `UserID` and `userid`): a later answer to the same question (from either worker) replaces the current one and the earlier versions stay in the entry's `history`; a new plan archives the earlier plan's questions it no longer asks; questions a `proceed` answer went ahead on are added with the answer and its note; `flow.replan` archives all of them (`carriedArchive`). At most 20 are kept: what does not fit is counted in `carriedOverflow` with the attempts whose results hold it, the flow stops for the operator instead of going on (resume goes on with the list marked incomplete), and a `proceed` that could not carry its questions is refused. They are given to the plan reviewer and code reviewer, who report a wrong assumption as a blocking finding, and to the builder as settled answers, with an incompleteness marker when anything overflowed; they are listed in the merge question's own `carriedQuestions` field (questions, history, overflow), which the console shows as a card, and in the completion notice.

Why a ready plan that still lists questions asks the operator (dev.82), and why assumptions no longer do (dev.83): with a per-question split the planner states which answers it went ahead on, the plan reviewer can refuse a wrong one, and the operator reads them all before the merge decision, which is where an operator answer is still required. A question the worker puts in `questions` still stops the flow.

**A replanning planner revises its own plan (dev.83).** When a flow returns to planning after a clarification or a plan review revision, the planner's prompt carries its previous plan with its questions numbered as the operator saw them and the operator's latest answers (these two are reserved first; the payload is at most 16,000 characters of serialised JSON, a hard limit: if the questions and answers alone are over their share the longest are cut to one common length, each keeping its number and the start of its text with a marker; the other fields share what is left, and everything cut or left out is counted in `omitted`), and asks it to revise that plan rather than start over. `flow.replan` still starts from nothing: it clears the plan.

### Build questions

A build question is a question step that the build step's result routes to (`build-question` in the reference). From dev.83 its item carries the builder's questions, its summary of what it did, its assumptions, departures from the plan and unverified acceptance in `context` (bounded and stripped of control characters like a plan question's), the same content in `buildQuestion`, and labelled `choices`. Answers are the graph's own; the reference offers `retry` (with a note, it reaches the builder in its session) and `stop`.

**Reviewers report everything in one round.** Plan and code reviewer prompts ask for every blocking finding the reviewer can see in one review, judged against the task's acceptance criteria, declared paths and governing context, with neighbouring cases of a missing case reported together. Hardening outside that scope goes in the summary, not in findings. The planner is told to return `blocked` only when the plan cannot be carried out without an answer, and to put questions whose answer would not change the plan in `assumptions` with the answer assumed (dev.83).

`flow.replan` grants a new bounded cycle starting at the planning node. Each reachable bounded node gets its full allowance again, and the graph gets a fresh transition allowance. Entering the planning node consumes the first visit of that new cycle. From dev.69, `visits` remains cumulative for every node, while the public flow's `visitBudgets` shows `allowance`, `used`, `remaining` and `cumulative` for each bounded node. `limitExtensions` and the replan event retain the cycle baselines. Refused transitions do not consume counters. Existing historical counters are preserved.

From dev.76, the required replan note is also delivered as flow guidance to subsequent agents. It retains the issuing actor and any delegated operator instruction (`onBehalfOf`); automatic target-follow replans identify the factory as their actor. Previous guidance remains available. A replay of the same command does not append it again. Before this release, the note existed only in the replan event. Historical notes are not backfilled; use `flow.note` to restate guidance needed by an already-running flow.

Replan also supersedes the previous cycle's gate results, including custom gate node names, so an obsolete check refusal is not sent to the new builder as current correction work. Attempt receipts and logs remain in History, and the event lists the superseded result slots. A normal correction within the same cycle still receives its gate failure diagnostics. Replan does not itself integrate branches or repair an ancestry prerequisite; use the [prerequisite hold and recovery path](#gate-prerequisites-that-builders-cannot-repair). Review, verification and exact-candidate authorization still need to be established for the resulting candidate.

After a bound stop, inspect the retained findings and provide a note with a deliberate `flow.replan`, or abandon/restart the task. `resume` alone does not grant more visits. A stopped flow continues to hold its capacity and workspace until recovered or explicitly abandoned. Each new stop after recovery generates a new notice, even when its reason is identical; observing the same stop repeatedly remains quiet.

From dev.77, an unchanged builder result after a review's `revise` route stops after that correction attempt instead of spending subsequent visits on automatic re-review. The check uses the actual candidate and the review pinned in the attempt, independent of project step names. Guidance and explicit recovery are required; see [review correction holds](risk-review.md).

For larger planning cycles, export a project-owned graph and change its `plan.maxVisits` (and any relevant transition bound), then review, commission and reapprove through the normal workflow update process. This changes future admitted workflows, not a running flow's pinned graph. An unbounded automatic retry is not implied by a replan. A project-owned graph keeps its own `plan.maxVisits` across upgrades; dev.82's default of three applies to projects on the reference graph, from the next commissioning, to flows admitted after it.

## Workflow kinds: change, document and task

Not every task is a code change. A catalog definition has a **kind**:

- `change` (the default): builds a candidate in a worktree, reviews, verifies and merges it.
- `document`: work that produces a document (research, a proposal, a guide) instead of code. It plans, writes in a worktree, is reviewed and merges like a change, but has no check gate: a passing review is the evidence its merge needs.
- `task`: work carried out by a person or the orchestrator and completed by their report. There is no worktree, build or merge. A task workflow may only contain questions, waits, `forge.closeTask` and `forge.lifecycle`.

Two task references ship:

| Reference | What happens |
| --- | --- |
| `task.orchestrator` | The orchestrator is asked to carry the task out and report **done**, **blocked** (with a note) or **stop**. Done closes the task and its source issue (under `repository.closeTasks`). Blocked returns it to the operator with the note, who can send it back or stop it. The orchestrator gets one wake; the question doesn't remind. |
| `task.operator` | The same, asked of the operator, for things only a person can do, such as accounts or billing. Its question reminds daily. |

Questions stay open for 14 days. `workflow export --from task.orchestrator` writes either one out as a starting point for a project-owned copy (declare `"kind": "task"` for a copied file).

One document reference ships, `change.document`. It is the change workflow with these differences:

- **No check gate.** A review pass goes straight to the merge decision, which requires review evidence only. Merge decisions follow `policy.mergeDecisionRole` as for changes, and strict-risk documents still need the strict review and decision.
- **Planning** follows `policy.planning`, as for changes.
- **Step guidance.** The planner, builder and reviewer are told the task produces a document, not code, and the reviewer checks accuracy, completeness against the acceptance criteria and clarity instead of asking for tests. Any effect node can carry its own `action.guidance` (up to 4000 characters), added to that step's brief; a project-owned copy can change it.
- **Its own capacity:** `policy.maxDocumentFlows` (default 2), separate from `policy.maxFlows`. Document flows still need green main, and their paths and area can't overlap a running change (or another document). A document flow waiting on an answer is parked like a change flow and holds no slot, up to `policy.maxParkedFlows` ([flow slots](operations.md#flow-slots-and-parked-flows)).
- **Branch protection:** without a gate, no `factotum/gate` status is published for the document's pull request. If the target branch requires that status, the forge refuses the merge.

Where the document goes is up to the task brief (its acceptance criteria and `paths`) or the project's governing context. `workflow export --from change.document` writes it out for a project-owned copy (declare `"kind": "document"`).

```json
"workflows": {
  "definitions": {
    "change": {"reference": "change.standard"},
    "orchestrator-task": {"reference": "task.orchestrator"},
    "operator-task": {"reference": "task.operator"},
    "research": {"reference": "change.document"}
  },
  "selection": {"default": "change", "rules": [{"label": "orchestrator", "workflow": "orchestrator-task"}, {"label": "operator", "workflow": "operator-task"}, {"label": "research", "workflow": "research"}]}
}
```

**Selection:**
- A task's own `workflow` field (in its brief, or chosen in the console) wins.
- Otherwise the **first** rule whose `label` or `category` matches selects the workflow.
- Otherwise `default` applies.

**Capacity:** task flows don't use build capacity (`policy.maxFlows`). They have their own pool, `policy.maxTaskFlows` (default 5), which counts every open task flow (parking does not apply to them). They also skip build-only admission checks: green main, path conflicts and area occupancy. Approve and queue them as usual.

**Lightweight briefs:** a brief can give `"doneWhen": "…"` (or a list) instead of an `acceptance` list, and can name a `workflow`. Imported from a GitHub issue, the task is the issue title plus the acceptance (or `doneWhen`) list, and a brief `outcome` that says more than the title becomes the task's `outcome`, which agents see as `Outcome: …` under the title (see [the GitHub guide](integrations/github.md#tasks-and-publications)). `task.put` accepts `outcome` too. In `recurringTasks`, `outcome` is accepted as the task's title:

````
```factotum-task
{"version": 1, "outcome": "Newsletter account exists", "doneWhen": "The account is live and the login is in the vault", "workflow": "operator-task"}
```
````

A brief can declare **offline inputs**, files the work needs that are not fetched during it (model steps have no network): `"inputs": [{"path": "data/survey.csv", "sha256": "…", "note": "export from the survey tool"}]`. The task isn't admitted until each exists in the project checkout (and matches its `sha256`, when given). Git-ignored inputs are copied into the flow's worktree and never committed; tracked ones are already there; an input that is neither is refused. Every model step's brief lists them.

A brief can record its **original request**, kept apart from the acceptance list it was turned into: `"originalRequest": {"origin": "operator", "source": "planning conversation", "date": "2026-11-10", "text": "the operator's exact words"}`. `origin` is one of `operator`, `incident`, `schedule`, `review` or `other`; `source` (at most 500 characters) says where it was received; `date` is an ISO date or date-time; `text` is verbatim (at most 20000 characters), required for an operator request and optional for other origins, where it holds the origin record's own words rather than an invented operator quotation. Unknown keys are refused. It is provenance, not authority: nothing treats it as approval, a grant or an answer to a decision. It is part of the brief and its revision, so adding or editing it needs approval again. Every planner, builder and reviewer brief shows it under a heading that says so, and the console shows it on the task. A task without one stays without one; nothing fills in an origin.

A brief can name **governing files the task may change**: `"governingEdits": ["project-governance"]`, a list of at most 8 `context.files` entry ids. Each must be a configured entry that is `required: true` and has no `paths` mapping (so it is always delivered), whose path is a plain repository path listed in the task's `paths`, reaches an ordinary file at exactly that path with no symbolic link on the way, and is not upgrade-owned: the factory's own instructions under `factory/` can never be named. Only the operator, directly, may put the field on a task, and only the operator, directly, may approve a revision that has it (never on an instruction or through a grant); the approval is recorded as `governingEditsApproval` and lapses with any later approval change. Such a task runs only as a delivery flow in its own workspace (not in rehearsal, as an adopted pull request or as an already-satisfied outcome). Every step receives the named files as they are at the flow's comparison commit (the workspace base the engine recorded when the workspace was created, or the integrated target), not as the candidate has them: the candidate's version is a proposal, reviewed as a change against the rules in force, so correction rounds do not invalidate the reviewed plan. Prompts say which files are approved for editing, and providers are started without reading instruction files from the worktree. Since [provider worktree isolation](changes/provider-worktree-isolation.md) that holds for every task: no model step loads configuration, skills, hooks or instructions from its worktree, and a candidate changes `.codex/`, `.agents/`, `.claude/` or `.mcp.json` content only when its task's `paths` name it. Such a task also needs a builder whose CLI will write those paths: Claude Code refuses `.claude/` and `.mcp.json`, and Codex refuses `.codex/` and `.agents/` at the top of the worktree, so admission holds the task with the remedy (route the builder with `task.models`, or make the change yourself; see [running](running.md#builders-and-provider-configuration)). A model step can still read any worktree file with its tools, as data; isolation stops loading, not reading. **For every task**, a candidate that changes a governing file its approval does not cover (any governing file, for a task without `governingEdits`) is refused before review and in commit, integration, publication and merge. Refused before review, the flow stops; refused in one of those operations, it fails. Either way its notice (and `status --flow`'s `failure` or stop reason) names the file and the two remedies: name it in `governingEdits` and approve that revision directly, then start the task again, or undo the change (dev.90). See [governance-edit context](changes/governance-edit-context.md).

A brief can also give `"notBefore": "2026-10-26T09:00:00-04:00"`: the task stays queued until then. For work that repeats, see [recurring tasks](advanced-workflows.md#not-before-times-and-recurring-tasks).

A tracked item becomes runnable by adding the eligibility labels and a brief like this.

## Target branches

A workflow definition can name the branch its changes go to: `"web": {"reference": "change.standard", "target": "next"}`. Its flows prepare from that branch, integrate it, open their pull requests against it and merge into it. Every other workflow uses `repository.target`. Choose the workflow by label as usual (`{"label": "web", "workflow": "web"}`). Every target branch name, `repository.target` included, must be at most 200 characters of letters, digits, `.`, `_`, `/` and `-`, start with a letter or digit, and contain no `..`; Factotum builds record ids from target names, and configuration validation and doctor refuse any other name.

Approval and flow admission bind the graph together with its explicit target. The engine verifies the pinned graph and execution target against that identity before dispatch; changing the commissioned target requires reapproval. Dev.68 corrects an admission digest mismatch in earlier releases. An affected flow stopped before its first attempt must be explicitly abandoned and replaced after the drained upgrade, preserving its history; changing project workflows or editing retained digests is unnecessary.

- **Health per branch.** Each target branch has its own health. Work waits on the health of the branch it targets ("next health is stale…"); a merge makes that branch's health unknown and, with `autoQueue`, queues a verification of that branch; following direct commits and the main-moved check work per branch. Health shows each branch.
- **Keeping branches in sync.** `repository.syncTargets: [{"from": "main", "into": "next"}]` merges `main` into `next` after every merge into `main` (a `target.sync` maintenance job, in a throwaway worktree, then a push). If it is already contained, nothing happens; a conflict stops without pushing and notifies, so someone merges by hand. Merges into `from` made outside the factory are covered too: the operations loop checks `from`'s remote head every `policy.mainProbeMs` and queues a sync when it moved.
- **Admission around a sync.** Queued/running syncs hold destination tasks. Dispatch and settlement invalidate destination health; queued work waits for fresh verification. From dev.75, a failed or unresolved sync additionally leaves a durable hold that green health cannot clear. Repair the branch, run an explicit successful sync/no-op, then verify the destination. Late verification cannot restore an older green result. If source verification catches another head change, it stops one flow at source and retains its queue claim; explicitly resume after fresh verification. See [target recovery](operations.md#target-synchronization-and-source-holds).
- **Checks know their branch.** Gate checks, main verification checks and the preview command get `FACTOTUM_TARGET` (the branch the candidate or verification is for) and, for checks, `FACTOTUM_CHECK_KIND` (`gate` or `main`), next to `PATH`, `HOME` and `LANG`. Use it when a check's rules differ by branch.
- **Doctor** checks that every target branch exists on the remote.
- Releases between branches (for example `next` into `main`) stay a person's decision; the factory only reacts to the branch moving.

## Gate prerequisites that builders cannot repair

From dev.75, a project-owned gate wrapper can reserve nonzero exit codes for prerequisites requiring operator or orchestrator repair, such as a missing branch ancestor. Commission them on the check:

```json
{
  "id": "verify",
  "argv": ["bash", "project/integrations/gate.sh"],
  "timeoutMs": 600000,
  "holdExitCodes": [78]
}
```

The wrapper must deliberately return the reserved code for that condition and a different code for ordinary test failures. The optional list accepts 1–16 unique integers from 1 to 255. Factotum does not infer authority or prerequisite status from log text. Unconfigured nonzero exits retain the workflow's existing failure routing; timeouts and launch failures are not classified as prerequisites.

A reserved exit stops later checks, retains diagnostics and stops the flow at that gate without spending another builder visit or minting gate evidence. A known synchronization hold also prevents gate execution; settlement rechecks for holds that appeared while the gate ran. Resume repeats the gate under current authority. It does not merge branches or grant the builder Git metadata access. If the candidate must incorporate a repaired target, preserve needed work and explicitly restart from that target. See [recovery and queue ownership](operations.md#target-synchronization-and-source-holds). This setting applies to `checks`, not baseline `mainChecks`.

## Gate failure diagnostics for builders

From dev.74, failed or blocked gate checks carry bounded stdout/stderr/error excerpts in `checks[].diagnostics`. The next builder prompt receives these alongside the check's status, candidate identity and artifact reference. They are untrusted test output, not instructions or merge authority. Successful checks do not add correction excerpts. Full raw stdout/stderr remain in the attempt's `check-N.json`; canonical receipts bind the result as usual.

If a project verifier writes detailed failures only to a separate log, its project-owned wrapper must expose the relevant test names, assertions and stack frames. Gate commands receive `FACTOTUM_CHECK_DIAGNOSTICS`, an absolute path to a per-check text file owned by the current attempt. Write a concise failure report there before returning the original nonzero exit code. For example, when the verifier already produces a small text failure summary:

```sh
if [ "$verify_status" -ne 0 ] && [ -n "${FACTOTUM_CHECK_DIAGNOSTICS:-}" ]; then
  cat "$failure_summary" > "$FACTOTUM_CHECK_DIAGNOSTICS"
fi
exit "$verify_status"
```

The wrapper owns extraction of the summary from its verifier's format. Include concrete failures, not only totals or an external filename; exclude credentials and irrelevant logs. This variable is supplied for gate checks, not baseline `mainChecks`. No diagnostics setting or factory-code edit is required. Changes to the project-owned check integration still follow normal project review/commissioning requirements.

The factory reads only that designated regular file, never paths mentioned in stdout, and refuses symlinks, directories and special files. It reads at most 64 KiB from the file's beginning/end. Embedded text is bounded to 12,000 characters per failed check and 24,000 per gate, prioritizing supplied details, stderr, stdout and error text; truncation and missing/unreadable supplemental output are explicit. Checks beyond the shared budget still retain their status and original artifacts. The provider's sandbox is unchanged, and no diagnostic files are copied into the candidate tree. A large log may still require a better project-generated summary or explicit operator feedback.

This fixes a longstanding metadata-only correction path; it was not introduced by the dashboard snapshot change. Previously retained gate results are not rewritten. Already-blocked flows still need deliberate recovery or operator feedback; the release does not reset their visit budgets or automatically rerun expensive checks.

## Fast checks before review

A review that sends work back over a rule a script could have checked costs a full build, check and review round. `fastChecks` moves such rules into cheap project-owned scripts that run on the built candidate before review. A violation goes straight back to the builder with the script's diagnostics; the reviewer is told not to raise the rules those checks own.

```json
"fastChecks": {
  "checks": [
    {
      "id": "verify-step",
      "argv": ["node", "project/integrations/fast-check.mjs"],
      "timeoutMs": 30000,
      "holdExitCodes": [78],
      "rules": ["A change to behaviour updates its verify step"]
    }
  ],
  "heavy": false
}
```

- `checks`: 1–8 checks with unique short ids. Each `timeoutMs` is at most 5 minutes and their sum at most 10 minutes. `holdExitCodes` works as for gate checks. `rules` lists up to 16 single-line descriptions (at most 300 characters each) of the rules the check owns.
- `heavy: true` makes the step take the shared heavy-work permit, through `resources.coordinatorPath` and `resources.operations.fastCheck` like other heavy work. Use it for anything that is not cheap. With `heavy: false` the project is declaring its checks light: nothing but the per-check and total time bounds limits them, so an expensive command marked light would run without the shared permit. The time bounds apply either way.
- Commands get `FACTOTUM_CHECK_KIND=fast`, `FACTOTUM_TARGET`, the task's [declared paths](adoption.md) (`FACTOTUM_TASK_PATHS`, `FACTOTUM_TASK_PATHS_FILE`; gate checks get them too) and `FACTOTUM_CHECK_DIAGNOSTICS` (the same [diagnostics file](#gate-failure-diagnostics-for-builders) and bounds as gate checks), next to `PATH`, `HOME` and `LANG`. They must not change the checkout. Child processes they start should have stdin ignored. [`project/integrations/fast-check.example.mjs`](../starter/project/integrations/fast-check.example.mjs) in the starter is a template.

**Where it runs.** With `fastChecks` configured, the `change.standard` reference gains a `fast-check` step between `integrate` and `publish`: it runs on the exact integrated candidate that will be published and reviewed. `change.document` does not run it. Without `fastChecks`, every reference graph is exactly as before. Project-owned graphs are not changed automatically: add a node with `"action": {"operation": "fastCheck"}` (any name). It must route `pass` and `fail` explicitly in `resultEdges`, and commissioning refuses it if no `fastChecks` are configured. Adding, removing or changing `fastChecks` changes the reference graph's digest, so it follows the normal `config update` and reapproval rules.

**Results and routing.**

| Outcome | Route | Effect |
| --- | --- | --- |
| Every check passes | `pass` | On to publication and review. The flow records the observation `fast-check:passed` for this candidate. |
| A check exits nonzero (not a reserved code) | `fail` | Back to the builder in the same build cycle, with the failed checks' bounded diagnostics. No review runs. The attempt's status stays `passed` (the step ran and settled cleanly); it also records `outcome: "failed"` and `failedChecks`, and the console draws it as failed. |
| A reserved `holdExitCodes` exit | held | The flow stops at the fast check with `fastCheckHold.kind: check-prerequisite`. Later checks are skipped. No builder visit. Resume repeats the fast checks. |
| Timeout or launch failure | held | `fastCheckHold.kind: infrastructure`, as above. |
| Heavy permit not free within the bounded wait | held | `fastCheckHold.kind: resource-wait`, naming the holder. No check runs. |
| A check changed the candidate | failed | The step fails, as for the gate. |

Fast checks never produce `gate` or `review` evidence; a graph that declares either on a `fastCheck` node fails commissioning, and the final gate still verifies the final candidate. A result records the candidate identity it ran on (`inputIdentity`) and the digest of the check definitions (`checkDefinitionDigest`). The builder receives fast-check diagnostics only when both match its current candidate and the commissioned checks, and the reviewer is told about owned rules only when the checks passed on exactly the candidate under review. Output from an earlier candidate or definition is never shown as current. A replan supersedes the previous cycle's fast-check results with its gate results (`supersededGateResults` in the replan event).

**Bounds.** The `fast-check` step's `maxVisits` is `maxBuildRounds + 4`, and each failure spends a `build` visit, so repeated failures stop the flow at the existing build bound (`workflow visit bound exhausted at build`). A builder that returns the unchanged candidate after a fast-check failure stops for guidance, as after a review revision, without rerunning the checks.

**Reviewer guidance.** When the checks passed on the reviewed candidate, the review prompt lists each owned rule as `[check-id] rule` and says not to raise a finding whose only basis is one of them. A real defect is still reported on its own merits. Rules are guidance; they do not restrict what a reviewer may report.

## Preview before merge

For changes someone should see before merging (a site, a design, rendered output), configure a preview command:

```json
"preview": {"command": ["node", "scripts/preview.mjs"], "timeoutMs": 600000, "paths": ["site/"]}
```

When it's set, every change and document workflow, reference or project-owned, runs a `preview` step in front of its merge question (each step that led to the question leads to the preview first), on the exact candidate in its worktree:

- It runs only when the change touches one of `paths` (always, without `paths`). Otherwise it is skipped.
- The command gets `FACTOTUM_PREVIEW_DIR` and writes screenshots there (PNG, JPEG or WebP; other files are kept with the attempt's evidence but not shown). It runs without network credentials and must not change the candidate.
- The images are kept with the preview attempt's evidence, in the project's state directory at `attempts/<attemptId>/preview/`. The merge question shows them in the Inbox, and clicking one opens it full screen. A failed preview doesn't block the question; it says it failed, so you decide whether to send the change back.
- The command is executable configuration, so it changes through `config update`. A project-owned workflow that already has a `preview` step keeps its own placement.

## Per-step models

Settings → Models lists the model-using steps of every commissioned project workflow. Each step has **Change model** (provider, model identifier and reasoning effort) and, when a saved default exists, **Use project default**. The built-in audit appears as `maintenance/audit`, step `run`, and the knowledge-upkeep assessment as `maintenance/knowledge.upkeep`, step `run`. The model of the upkeep assessment is upkeep authority: only the operator changes it, here or in the configuration (see [knowledge upkeep](operations.md#knowledge-upkeep)). Questions, waits, checks and arbitrary project commands do not have a factory-selected model; a command that launches its own model owns that integration.

Selections resolve in this order, field by field:

1. A run's `modelOverrides`.
2. The task's own model choice (`task.models`), by role.
3. Saved defaults from Settings or `models.update`.
4. Project configuration `stepModels`.
5. The operation's provider role in `providers`.

Every selector requires `model`; `provider` and `effort` are optional. Omitted fields inherit; `effort: null` uses the provider's default effort. A provider switch clears inherited effort and disables the previous provider's fallback. Same-provider selections retain the commissioned fallback. Actual attempt results show whether a fallback ran.

Selection also validates the retained fallback's effective model, effort, billing mode and allowlist. A fallback inherits the primary's effort unless its project configuration sets an explicit effort. For example, a Codex primary with `minimal` effort needs an explicit supported effort on a Claude fallback, such as `fallback.effort: "high"`; otherwise the default edit or run override is rejected before work starts. Fallback configuration remains project-owned and uses the normal configuration/commissioning process.

**Each flow pins its complete routes at admission.** Changing defaults never changes an active flow, including retries, replans and resumed builder sessions. A new flow uses the current defaults. A task waiting in the queue has not yet pinned its models. Changing defaults neither approves a task nor starts work.

### Saved defaults and orchestrator commands

Read `settings.stepModels` and `settings.modelSettingsVersion` from `status --state <dir>`. Use the exact workflow and step IDs shown there. For example, this command sets the default for a project's `final-review` step:

```sh
node factory/cli.mjs command --state <project-state> \
  --actor orchestrator --instruction 'Choose suitable model defaults for our workflows.' \
  --operation models.update \
  --payload '{"workflow":"change","changes":{"final-review":{"model":"review-large","effort":"high"}},"expectedVersion":"<settings.modelSettingsVersion>","note":"Use the larger model for future final reviews"}'
```

`models.update` follows the existing operator delegation policy. An orchestrator uses its own actor with a recorded instruction (which can be a standing instruction), and `policy.delegatedOperations` must include `models.update`; the default delegation includes it. The operator can always edit defaults in Settings. The version is required and is checked transactionally, so an old browser draft or orchestrator read cannot overwrite a newer choice or target a changed workflow silently. A single command can change several steps of one workflow atomically. Set a step to `null` to restore its project-config/role default.

Defaults live in private project state, survive backups and upgrades, and require neither a drain nor another doctor run. They cannot introduce arbitrary providers, change billing, relax review policy, or change model allowlists. A provider switch must target a provider already declared in the configuration. The destination provider's configured model allowlists apply; returning to a role's original provider restores that role's own allowlist. Only subscription CLI routes are supported. Builder and reviewer may come from the same model family; each review records the actual builder and reviewer provider, model and family, and marks a same-family pairing.

Before each invocation, the adapter still checks CLI capabilities and subscription authentication. Saving a syntactically valid model identifier does not prove that the subscription can run that model. Doctor also checks saved defaults when it runs, and refuses a result if defaults changed during its checks.

### Per-task models

An operator or orchestrator can choose models for one task, by role, without editing project settings:

```sh
node factory/cli.mjs command --state <project-state> --actor orchestrator \
  --operation task.models \
  --payload '{"taskId":"task-42","models":{"builder":{"model":"claude-fable-5-2","effort":"high"},"reviewer":{"provider":"claude","model":"claude-fable-5-2"}},"note":"Most complex work this week"}'
```

- `models` maps `planner`, `builder` and `reviewer` to `{model, provider?, effort?}`; `null` clears the choice. A role choice applies to every model step of that role in the task's workflow: `reviewer` covers the plan review and every code review.
- **Not part of the approved brief.** Setting or changing it keeps the task's revision and approval, needs no re-approval and no grant, and is allowed to the operator and the orchestrator alike (the same authority as `flow.start`'s `modelOverrides`). A brief edit keeps it. The reasoning: the brief is what is built and how it is accepted; the model choice only selects among routes the project already allows, and it is pinned with the flow and recorded in its evidence. Putting it in the brief would turn each model change into a re-approval, which would defeat the easy per-task choice this feature is meant to give.
- **Within the project's providers only.** A choice must use a provider already configured for a role, and stay within that provider's `allowedModels`. Anything else is refused with a reason that says it is a project setting change (`config update`). The check runs when the choice is saved and again at admission; a choice that a later configuration change made invalid refuses admission rather than running another model.
- **Applies to the next flow.** Admission (Start now, the queue, automatic queueing, `task.restart`) pins the routes. A running flow keeps its routes, including retries, replans and a resumed builder session, which never changes provider. Change it and restart the task to use it.
- `task.put` accepts the same `models` field. Flow detail → **Models pinned for this flow** shows each step's source as *task choice*; the task detail shows the next flow's models and has **Choose models for this task**. Stats → Models counts invocations chosen per task or run.

The starter template lists Claude Fable 5.2 (`claude-fable-5-2`) in the Claude roles' `allowedModels` for the most important or complex planning, building or review; the defaults stay Claude Opus 5.5 for planning and building and GPT-6.1 Sol for review.

### Per-run overrides

An operator or orchestrator may select models when starting an approved task, without changing defaults:

```sh
node factory/cli.mjs command --state <project-state> --actor orchestrator \
  --operation flow.start \
  --payload '{"taskId":"task-42","revision":"<approved-revision>","modelOverrides":{"plan":{"model":"planner-large","effort":"high"},"final-review":{"model":"review-large"}},"note":"Use larger models for this run"}'
```

Overrides name steps of the task's selected, approved workflow; there is no second workflow-selection mechanism in this payload. Unknown steps, non-model steps, unsupported effort/provider combinations and disallowed models are rejected before the flow is admitted. `task.restart` accepts the same `modelOverrides` for its replacement flow. `job.enqueue` accepts them for the built-in audit (`operation: "audit", modelOverrides: {run: {model: "review-large"}}`). Other maintenance jobs do not choose a model.

The retained `modelSelection` records effective selections, their source, the requesting actor and a route digest. Flow detail → **Models pinned for this flow** shows them; attempt results report the model actually used. Existing flows keep their choices. To change those choices, stop/abandon the old flow as appropriate and start a new one through the normal admission path.

### Versioned project defaults

Projects can still set reviewed defaults in their own configuration:

```json
"stepModels": {"change": {"final-review": {"model": "review-large", "effort": "high"}}}
```

Keys are catalog workflow names (`standard` without a catalog), then step IDs. An entry may also set `maxTurns` (1 to 500), the Claude turn limit for that step, which otherwise comes from `providers.<role>.maxTurns` or the role's default (60 for builders, 16 for the others; see [provider turn limits](integrations/providers.md#permissions-and-process-ownership)), for example `"build": {"model": "claude-opus-5-5", "maxTurns": 120}`. File changes use normal `config update` and commissioning. `config show` exports effective settings, including saved model defaults as `stepModels`. `config update` preserves saved defaults; `--replace-live` explicitly clears that overlay along with replacing other live values. Removing or renaming a workflow/step with a saved default requires resetting that default first or using `--replace-live`; stale defaults are never silently retargeted.

## Delegated merge decisions

To let the orchestrator decide ordinary-risk merges, both are required:

1. `"policy": {"mergeDecisionRole": "orchestrator"}` in the configuration (the commissioned maximum), and
2. `"role": "orchestrator"` on the graph's `mergeDecision` question (the request). The supplied reference sets this from the policy.

Strict risk and adopted external PRs still go to the operator. A knowledge-upkeep flow (a task carrying the factory's upkeep marker) is never merged by `policy.autoMerge`; its merge question goes to the merge decision role as for any flow. An adopted PR's merge question is answered by the operator only: the orchestrator is refused even on a recorded instruction, and no delegation setting widens that (`policy.strictDecisionRole` does not apply to it either). See [risk review](risk-review.md) for attribution and rechecks, and [adoption](adoption.md#task-to-delivery-commissioning) for the adopted-PR path.
