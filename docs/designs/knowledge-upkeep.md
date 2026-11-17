# Knowledge upkeep: design

Status: design only, revised three times (2026-11-15 and 2026-11-16) after independent design reviews. Implemented since in eight slices (`docs/changes/upkeep-slice1.md` to `upkeep-slice8.md`); dated notes in the text record the decisions made during them. Baseline: `main` at `5dd6de9` (after dev.85).

Every statement about current behaviour cites a file and line at that commit. Citations that start `core/`, `operations/`, `workflows/`, `adapters/`, `service/` or `console/` are under `starter/factory/`.

This design answers the operator decisions of 2026-11-15 (`docs/one-factory-progress.md:160`): a post-merge step that updates documentation and context only when the merged work made something false or incomplete, and that applies the compound-engineering capture rule in the same pass. The research input is a compound-engineering review of the same date (not kept in this repository; cited here as "the research", recommendations R1 to R8).

**History of this document**

- First version: commit `c50b337`, with 13 open questions.
- Second version: commit `c5c8d85`. The operator accepted all 13 recommendations as written. The first independent review (verdict: rework; approach sound, digests confirmed unchanged) raised four high and six medium points and six accuracy corrections. That version raised six new questions (N1 to N6).
- Third version: commit `34d2a3e`. The operator accepted N1 to N6 as written. The second review found the first review substantially answered and asked for six further items, two slice requirements and one scope reduction. That version raised three questions (P1 to P3).
- This version: the operator accepted P1 to P3 as written, so all 22 decisions are recorded in [section 2](#2-settled-decisions) and no question is open. The focused re-check confirmed the second review's points answered and found four precise issues and two citation errors, fixed here. [Section 17](#17-review-points-and-where-they-are-addressed) maps every point of all three reviews to its answer.

## 1. The design in one page

When a change or document flow's merge is proven, the factory writes a small pending record for it. Once the flow's retrospective exists, that record becomes one maintenance job, `knowledge.upkeep`, which stops at the first stage that says "nothing":

1. **A deterministic pre-filter.** From records and Git only, it lists the existing docs and governing-context files that refer to what the merge touched, and the verified corrections the flow recorded. If both are empty the job ends. No model runs.
2. **One small read-only model call.** It sees the merged diff, the matching excerpts and the signals as labelled evidence, and is told that "nothing" is the expected answer.
3. **A deterministic validator.** A candidate whose quote is not found verbatim, whose file is not allowed, or whose signal does not exist is dropped. Nothing is repaired by a second model call.

What survives becomes one of three things:

| Outcome | What it is | Who approves it | How it lands |
| --- | --- | --- | --- |
| Docs follow-up | An ordinary task that corrects quoted statements in existing, non-governing docs, within a diff budget | Explicit task approval, then review and a merge decision | A separate flow through the project's own workflow |
| Context proposal | An unapproved candidate against a governing-context file. Never an edit | The operator only | Accepted proposals are batched into one reviewed task |
| Capture candidate | An unapproved candidate for a fast-check rule, a governing rule or a short learning, in that order | A rule as a context proposal; a check or learning by accepting it and then approving its task | A reviewed task limited to what its kind permits |

The main choices:

- **A maintenance job, not a graph node.** The reference graphs and their digests do not change (section 13.1).
- **Governing files are never docs.** Every configured governing path, resolved through any links on the way, is subtracted from the docs set, and that is re-checked when the task is created and on the candidate (section 7.1).
- **The limits are enforced on the exact candidate that is published and merged**, inside the publish and merge operations, where the upgrade-owned file check already lives. Each task kind has its own explicit permissions (section 7.4).
- **Candidates are `finding` rows** with a deterministic class key and a full disposition state machine (section 4).
- **Everything a model or the repository wrote is delivered as labelled evidence**, apart from the factory's own instructions (section 6.5).
- **Learnings live outside governing context**, pinned by Git blob id per plan cycle, capped and advisory (section 11).
- **Off by default.** Output rates are ceilings and zero output is a pass (section 8).

## 2. Settled decisions

Decided by the operator, accepting each recommendation as written. Q1 to Q13 are the first version's questions and N1 to N6 the second version's (both 2026-11-15); P1 to P3 are the third version's (2026-11-16).

| # | Decision | Where it applies |
| --- | --- | --- |
| Q1 | A docs follow-up task needs explicit approval. Approval by commissioned configuration may be considered after the trial, for projects whose follow-ups are approved at least 80% of the time; it is not part of this design's slices (section 12). | 4.3, 9.1 |
| Q2 | Accepting a governing-context proposal is operator-only, with no delegation. **Extended (operator, 2026-11-16):** as of the governance-edit fix ([governance-edit context](../changes/governance-edit-context.md)), every task that edits a governing file needs the operator's own approval naming that file in `governingEdits`, and an adopted pull request that touches a governing file is refused. ~~The rule is not extended to every task that touches a context file in this work.~~ (superseded) | 4.3, 9.4 |
| Q3 | One file per learning, capped at 40 entries of at most 1,500 characters. | 11.1 |
| Q4 | Failed and stopped flows are not lesson sources in the first version. | 5.1 |
| Q5 | A new optional `providers.upkeep` role on the smallest model the project allows, falling back to the reviewer role. | 6.3 |
| Q6 | One flow is enough to raise a check candidate; a rule or a learning needs two flows. | 4.3, 10.3 |
| Q7 | Budgets: 3 files and 40 changed lines per docs follow-up, 600 characters per proposal, one open follow-up, 10 open proposals, 10 open capture candidates. **Note (operator, 2026-11-17, dev.92 P2):** these budgets bound what each task may change and how much may be open, whoever accepts it; they are unchanged by the amendment of N6. | 7.4, 8 |
| Q8 | The "task editing its own governing context" defect is fixed before the context-proposal slice. | slice 6 |
| Q9 | The kill criteria are confirmed for the trial, as revised in section 14.3. | 14.3 |
| Q10 | No no-planning workflow for follow-ups yet; measure follow-up cost in the trial first. | 7.3 |
| Q11 | Follow-up tasks stay local in the first version; they are not filed in the issue source. | 7.2 |
| Q12 | The project must state which files are its docs; there is no default. Dated records are excluded in the starter example. | 6.1 |
| Q13 | The disposition commands also apply to audit findings. | 4.4 |
| N1 | An upkeep-origin flow is never merged by `policy.autoMerge` in the first version. | 7.5 |
| N2 | A docs follow-up that reaches any question other than its merge decision is ended, not put to the operator. | 7.6 |
| N3 | A suspension is lifted only by the operator. | 8.4 |
| N4 | On a schema 1 project, upkeep's authority-bearing settings are operator-only, although other configuration there can be changed by a delegated orchestrator. | 9.2 |
| N5 | Weak signals alone never cause a model call. Revisit with trial data. | 6.2, 10.1 |
| N6 | Ceilings: 2 upkeep tasks a day and 6 a week, 8 model invocations per upkeep flow, a 24-hour maximum queue age, a 14-day docs backlog. **Amended (operator, 2026-11-17, dev.92 P2):** the daily and weekly task ceilings limit only the tasks the factory creates on its own and the acceptances a delegate makes. The operator's own direct acceptance is never refused by them; it is counted, and it uses up the factory's room (6.6, 8.3). | 5.3, 6.6, 7.2 |
| P1 | Retiring a learning through upkeep only deletes it. Correcting one in place is an ordinary task. | 7.4, 11.4 |
| P2 | The `upkeep:` task namespace is reserved as a breaking refusal for any project that already uses it, with rename steps in the release notes. | 7.2 |
| P3 | A check task is limited to existing fast-check script files, 2 files and 80 changed lines; a governing edit is limited to 12 changed lines per accepted proposal. | 7.4 |

## 3. Current behaviour this design builds on

| Fact | Where |
| --- | --- |
| The change reference ends `merge`, `post-merge`, `close-task`, `cleanup`, `done`. `postMerge` only records obligations. | `core/configuration.mjs:89-93`; `workflows/dispatch.mjs:667-674` |
| The document reference is the change graph without the gate. | `core/configuration.mjs:110-126` |
| The gate and fast checks run configured project commands. Neither has a provider role. | `core/operations.mjs:27,30` |
| When a merge is proven, the engine queues follow-on jobs with no graph node (`target.sync`, post-merge `main.verify`), each with a configuration grant. The hook keys on the operation, and the result is stored under the binding `merge`. | `core/engine.mjs:616,667-680`; `core/operations.mjs:31` |
| A retrospective is recorded when a flow finishes, and when it stops. It reads the latest 10,000 events and filters them in memory. | `core/engine.mjs:379-388`; `core/project.mjs:434`; `operations/governance.mjs:54` |
| A maintenance job becomes a one-node maintenance flow. One built-in maintenance flow runs at a time; the first queued job that can start is taken. A job whose grant names an older configuration digest is revoked. Queued jobs have no maximum age. | `workflows/maintenance.mjs:80-86,102-121` |
| A pause can also hold new maintenance jobs; running ones finish. `upgrade apply --when-drained` sets that hold. | `core/project.mjs:718-720`; `cli.mjs:139-149` |
| An unfinished flow of any kind except a carried-over task flow blocks a drain, and so does any unsettled attempt. | `core/project.mjs:373-375,397`; `operations/upgrade-apply.mjs:129-137` |
| Maintenance flows are outside the slot pools. A working or stopped change or document flow holds a slot. Parked flows hold none up to `policy.maxParkedFlows`, longest-parked first; later ones hold a slot again. | `operations/capacity.mjs:36,62-75`; `docs/operations.md:11-18` |
| A question that expires stops its flow; a stopped flow holds a slot. | `core/engine.mjs:447`; `core/project.mjs:415-421` |
| `flow.abandon` is refused while the flow has an attempt or after its merge. | `core/project.mjs:962-964` |
| The audit job is the existing model-using maintenance job. Its model workflow key is `maintenance/audit`; the key of any maintenance flow is `maintenance/<operation>`. | `workflows/maintenance.mjs:323-365`; `core/step-models.mjs:11,14-15` |
| `finding` rows have one status, `unapproved`, which is also the kind's live set and partial index. A repeat only raises `observations`. The engine opens a pending obligation per audit finding. | `operations/governance.mjs:26-41`; `core/records.mjs:84`; `core/engine.mjs:681-684` |
| `store.live` and `store.by` use partial indexes only for a verified kind; otherwise they read the whole kind and filter in memory. `store.all` always reads the whole kind. | `core/store.mjs:116-131,157-158` |
| Record lookups exist by primary key, by live set, and by `flowId`, `taskId`, `inboxId` and `operation` for named kinds. | `core/records.mjs:73-96` |
| `task.put` computes the revision from the brief fields. On a brief edit, fields outside the brief are not carried over. | `core/project.mjs:218,592-632` (the merge at `:620`) |
| Task ids may contain `:`. Tasks are created by `task.put` (which source sync and task import also use), by recurring occurrences (ids start `recurring:`) and by maintenance jobs (ids start `job:`). | `core/contracts.mjs:22-25`; `core/project.mjs:586-624,198-212`; `workflows/source-sync.mjs:28`; `workflows/commission.mjs:409`; `workflows/maintenance.mjs:103,121`; recurring ids as in 7.2 |
| A custom source's namespace may be any `name:` except `github:`, `job:` and `maintenance:`. The GitHub task-id prefix may be any `name:`. `task.put` itself accepts any valid id. | `operations/source-config.mjs:23`; `adapters/github/issue-profile.mjs:10`; `workflows/source-sync.mjs:23,88` |
| The primary key of a record is its kind and id. | `core/store.mjs:65` |
| A grant entry can be issued only for a task that exists, at its exact current revision; maintenance tasks carry no grantable authority. | `core/grants.mjs:62-65` |
| On schema 1, `task.approve` is the operator's, or the orchestrator's by operational delegation. On a migrated (schema 2) project the orchestrator needs a stored grant entry that pins the exact task id, revision and workflow digest; operational delegation does not approve a brief. | `core/project.mjs:633-643`; `core/grants.mjs:141-183`; `core/delegation.mjs:7` |
| On schema 2, a delegated `config.update` or `settings.update` may not change authority-bearing policy. Recurring-task templates are part of that policy because their tasks are created already approved. On both schemas, operator-only live settings cannot be changed by a delegate. | `core/authority-policy.mjs:14-34`; `core/project.mjs:996-1004,1030-1032`; `operations/live-settings.mjs:23,45` |
| Model invocations are a projection computed from attempt receipts when asked for; no daily total is maintained. It counts the invocations a receipt names; without them it counts one for any `provider.*` or `audit` attempt, whatever the attempt's status, and none for other operations. It then leaves out an entry whose usage observation was already seen. Observation ids are random per invocation. | `operations/usage-accounting.mjs:82-93,105-113`; `operations/stats-view.mjs:212-215`; `adapters/providers/index.mjs:180` |
| `attempt.resolve` sets an uncertain attempt's status to `failed` or `not-dispatched` and keeps whatever receipt it has. | `core/project.mjs:966-972` |
| Task ids, source namespaces and the GitHub id prefix are restricted to ASCII letters, digits and a few punctuation marks. | `core/contracts.mjs:23`; `operations/source-config.mjs:23`; `adapters/github/issue-profile.mjs:10` |
| The operations tick already reads remote targets on its own timers (target probes, branch syncs) and retries cleanups. | `workflows/maintenance.mjs:61-78`; `operations/main-freshness.mjs:42-47` |
| A candidate must have no uncommitted or untracked changes before review, checks and merge. | `workflows/dispatch.mjs:324-327` |
| A merge question is answered by policy when `policy.autoMerge` is on, the project is qualified, the risk is ordinary and the flow is not an adopted pull request. | `core/engine.mjs:451,463` |
| Workflow selection: the task's own `workflow` field first, then the first matching label or category rule, then the default. Without a catalog there is one workflow. | `core/catalog.mjs:156-164,188-190` |
| Governing context is assembled from the flow's own worktree at every step, resolving each entry's real path. A reviewed plan pins it; a changed governing file means "replan required" at the next build or plan review. | `workflows/actions.mjs:64-93`; `operations/context.mjs:6-34,45-68` |
| When the target moves, a running flow replans if the new commits touch its task paths, plan files or context files. Paths match by prefix. | `workflows/actions.mjs:27,40-54` |
| A task that edits its own governing file fails at the next build if review sends it back (open defect). | `docs/runtime-followups.md:9-17` |
| Upgrade-owned files are checked on the candidate through hash-verified Git objects at commit, at integration and at publication, against the workspace base or the integrated target, including the candidate's own commits. `forge.publish` is the only way a candidate leaves the workspace and publishes only the head the factory just integrated. | `workflows/dispatch.mjs:124-150,468-533` |
| Commissioning refuses a graph that can reach `forge.publish` other than from a clean integration. | `core/catalog.mjs:91-127` |
| `forge.merge` requires the candidate to equal the authorized identity and the pull request head. | `workflows/dispatch.mjs:641-646` |
| Acceptance criteria are written into every model brief and into the pull request body as plain text. | `workflows/dispatch.mjs:330,534` |
| Check output is already delivered as untrusted data, not instructions. | `workflows/check-diagnostics.mjs:4`; `docs/project-workflows.md:194` |
| Model roles are subscription-backed; no paid adapter is qualified. | `README.md:59`; `core/configuration.mjs:159` |
| Design #10 (delta review and finding ledger) is "design pending". | `docs/one-factory-progress.md:20` |
| Field evidence: a substantial share of review send-backs rested on one procedural rule. | `docs/one-factory-progress.md:62` |

## 4. Records and access paths

### 4.1 Records

| Record | Key | Purpose |
| --- | --- | --- |
| `upkeepRun` | Source flow id | The pending receipt written at merge settlement, then the run's state and outcome. It carries two absolute deadlines that are set once and never moved later: `pendingUntil` and `runBy` (5.3). One per merged flow. |
| `finding` (existing kind) | Class key (4.2) | A raised candidate, with `source: 'upkeep'`. Audit findings keep their rows. |
| `upkeepObserved` | Class key | A `rule` or `learning` class seen in one flow and not yet raised (Q6). Indexed by first-observed time. At most 200. |
| `upkeepDay` | UTC date | Daily counters: model runs reserved and settled, tasks created, outcomes by kind, and the day's model invocations in total and upkeep-attributed. |
| `upkeepWindow` (one row) | Fixed | The last 50 run outcomes and the last 20 disposed outputs per part, for the rates in section 8. |
| `learningUse` | Learning id | Times selected and cited. |
| Meta keys | `upkeepWork`, `upkeepOpen`, `upkeepSuspended` | Whether any run is pending, queued or running; the open docs follow-up and the open-candidate counts by kind; suspensions. |

Candidates are written under their own result field, not `findings`, so the engine does not open an obligation for each (`core/engine.mjs:681-684`).

### 4.2 The class key

A candidate's id is a digest computed by the factory from fields the model cannot phrase freely:

| Kind | Key fields |
| --- | --- |
| `docs`, `context` | Kind, resolved file path (7.1), and the quote after whitespace collapsing |
| `check`, `rule`, `learning` | Form, an **anchor** and a **topic** |
| `learning-stale` | The learning id and the typed condition that fired (11.4) |

For capture candidates the model must choose the anchor from a closed list the factory offers in the prompt (the ids of existing fast checks, the ids of governing-context entries, and the directories of the files the signals name, to a depth of two), and the topic from a fixed list (`procedure`, `test`, `documentation`, `interface-use`, `build`, `data`, `style`, `other`). The validator rejects any other value. This is deliberately coarse: two different lessons about tests in one directory share a key. Starting exact and widening only with evidence is what the research recommends for recurrence (R3), and the key should be reconciled with design #10's finding identities when that design exists.

### 4.3 Candidate lifecycle

**States.** A raised candidate is a `finding` row in one of:

| Status | Meaning |
| --- | --- |
| `unapproved` | Open: raised and waiting. This is the existing open status, kept so the live set and its index mean what they mean today (`core/records.mjs:84`). |
| `tasked` | A task exists for it and is linked (`taskId`, `taskRevision`). The task may or may not be approved yet. |
| `delivered` | The linked task's flow merged. |
| `failed` | The linked flow failed, or was abandoned for a fault (7.6). |
| `declined` | A person declined it, with a reason from `unnecessary`, `wrong`, `duplicate`, `later`. |
| `expired` | It passed an age or count limit (8.3), or ran out of returns. |
| `resolved-elsewhere` | The statement is gone, the source merge was reverted, or a person recorded that it was dealt with another way. |

A row also has `version` (raised on every change of content or status, never by a repeat observation) and `sourceFlows` (distinct source flow ids, at most 20, with a total count). The same flow observed twice, or a manual re-run, adds nothing. A candidate has at most one live task.

Before it is raised, a `rule` or `learning` class seen in only one flow is an `upkeepObserved` row. It is not shown in Health, is not counted as open and cannot be acted on. When a second, distinct source flow produces the same class key, the factory writes the `finding` row as `unapproved` and deletes the observed row in the same transaction (Q6).

**How a task comes to exist, by kind.** One sequence per kind, with no alternatives:

| Candidate kind | Task kind (7.4) | The task is created by | The task is approved by |
| --- | --- | --- | --- |
| `docs` | `docs` | The factory, automatically and unapproved, when validated candidates exist and the limits allow (7.2). The candidates become `tasked`. | `task.approve`, under the rules of 9.1 |
| `check` | `check` | `finding.accept`, unapproved. The candidate becomes `tasked`. | `task.approve`, under the rules of 9.1. The operator may accept and approve in one command. |
| `learning` | `learning-add` | As for `check` | As for `check` |
| `learning-stale` | `learning-retire` | As for `check` | As for `check` |
| `context`, `rule` | `context` | `finding.accept`, by the operator only | The same command, atomically (9.4) |

Creating a task never approves it, except in the last row, where the operator has just read the exact edits.

**Every governing-file edit (Q2, extended by the operator 2026-11-16).** Beyond this table, any task, upkeep or not, may change a governing file only when its brief names that file's context entry in `governingEdits` and the operator approved that revision directly; any other governing change is refused before review and in commit, integration, publication and merge, and an adopted pull request that touches a governing file is refused ([governance-edit context](../changes/governance-edit-context.md)). The accept command below writes `governingEdits` for the files its proposals name. This supersedes Q2's original "not extended to every task that touches a context file". On a migrated project a grant can only name a task that exists (`core/grants.mjs:62-65`), which is why creation and approval are separate steps wherever the orchestrator may approve.

**Who may do what.** "Delegated" means the orchestrator on a recorded operator instruction, where the command is in `policy.delegatedOperations`; the three commands below are added to the delegable list. With no list, every delegable operation is delegated (`core/delegation.mjs`), so these three are too; an explicit list delegates them only if it names them. The operator confirmed this default in dev.89.

| Action | `docs` | `check`, `learning`, `learning-stale` | `context`, `rule` |
| --- | --- | --- | --- |
| Raise; mark `expired`, `resolved-elsewhere`, `delivered`, `failed`; return to `unapproved` | Factory | Factory | Factory |
| Create the task | Factory | Operator or delegated (`finding.accept`) | Operator only (`finding.accept`) |
| Approve the task | 9.1 | 9.1 (a `check` task: operator only, directly; see 9.1) | Operator only, in the accept command |
| Decline an open candidate (`finding.resolve`) | Operator or delegated | Operator or delegated | Operator only |
| Decline a tasked candidate | Operator or delegated | Operator or delegated | Operator only |
| Record `resolved-elsewhere` with evidence (`finding.resolve`) | Operator or delegated | Operator or delegated | Operator only |
| Reopen a closed candidate (`finding.reopen`) | Operator or delegated | Operator or delegated | Operator only |

Every person's command names the candidate's expected version and is refused if the row changed. The factory's own transitions re-read the row in the transaction that writes it.

**Declining a tasked candidate** acts on its task: the task is closed, and every candidate linked to it is declined with the given reason. Upkeep tasks cannot be edited (7.2), so there is no partial decline; to keep part of a batch, decline it and reopen the candidates worth keeping. A task that has an unfinished flow must be stopped first, as for any task.

**Transitions.**

| From | To | By | Condition |
| --- | --- | --- | --- |
| (none) | `unapproved` | Factory | A `docs`, `context`, `check` or `learning-stale` class seen once; a `rule` or `learning` class seen in a second distinct flow |
| `unapproved` | `tasked` | Per the sequence table | Expected version; the task is written and linked in the same transaction |
| `unapproved`, `tasked` | `declined` | Per the actor table | Expected version; a reason |
| `unapproved` | `expired` | Factory | Older than its limit, or pushed out by a cap (8.3) |
| `tasked` | `expired` | Factory | Its task was not approved within 14 days (the task is closed), or its returns are exhausted |
| `unapproved`, `tasked` | `resolved-elsewhere` | Factory, or a person per the actor table | The quoted statement is no longer in the file at the target head; the source merge was reverted; the learning file is gone or its condition no longer fires; or a person's evidence. A linked task that has not started is closed |
| `tasked` | `delivered` | Factory | The linked flow merged |
| `tasked` | `failed` | Factory | The linked flow failed, or was abandoned for a fault |
| `tasked` | `unapproved` | Factory | The linked flow was abandoned for a reason that is not the candidate's fault (a drain, a base that moved under it, a stale pinned file). The task is closed. Counted as a **return** |
| `declined`, `expired`, `failed`, `resolved-elsewhere` | `unapproved` | A person per the actor table | `finding.reopen`, expected version. The return count starts again |

**When returns run out.** A candidate may return twice. On a third abandonment that would return it, it becomes `expired` with the reason `returns-exhausted` instead. It stays closed unless a person reopens it. The factory never reopens a closed candidate; a later observation only adds to `sourceFlows`.

**Stale learnings.** A `learning-stale` candidate is raised by the retirement job (11.4). It is accepted into a `learning-retire` task, declined, expired after 30 days, or resolved elsewhere when its file is gone or its condition no longer fires at the next check. (Operator, 2026-11-16, after the second review of slice 8: a later check that reads the learning differently while the condition still fires gives an open candidate the current blob at a new version, and raises again one the factory resolved, an exception to "the factory never reopens a closed candidate" for this kind only; a person's reopen takes what the latest check read. A suspension of everything also stops learning delivery to new plan cycles.)

### 4.4 Audit findings

The same states and the commands `finding.resolve` and `finding.reopen` apply to audit findings (Q13), with the middle column of the actor table. An audit finding becomes `tasked` when a person records the ordinary task created for it; the console does both in one step, as it creates the task today (`console/ui/operations.mjs:50-60`). Audit tasks are ordinary tasks, not upkeep tasks.

An audit finding has a pending obligation `finding:<id>` (`core/engine.mjs:683`), and open obligations block retention (`operations/governance.mjs:92`), so its disposition closes it:

| Disposition | Obligation |
| --- | --- |
| `declined` | Resolved `deferred`, with the reason as evidence |
| `tasked` | Stays pending; `passed` with the task id when the task merges, `failed` if its flow fails |
| `resolved-elsewhere` | `passed`, with the evidence |
| Reopened | A new pending obligation |

Upkeep candidates have no obligation in any state.

### 4.5 Access paths

The rule: no upkeep code path calls `store.all`, uses `store.by` on a kind without a declared reference index, or filters `records.data` with a JSON predicate outside a declared index (`core/records.mjs:73-110`). New kinds get their indexes in the same declaration so the verified-kind rule covers them. If a kind upkeep needs is not verified, `live` and `by` would read the whole kind (`core/store.mjs:125,129`); upkeep then suspends itself with a health reason instead of running.

| Operation | Database reads | Database writes | Git or provider |
| --- | --- | --- | --- |
| Merge settlement (inside the existing transaction) | None beyond the flow already loaded | `upkeepRun` by key; `upkeepWork` meta | None |
| Retrospective recorded (finish or stop) | The flow in hand; attempts and pushback by `flowId` (indexed) | `upkeepRun` by key; the job by key | None |
| Any attempt settlement while upkeep is not `off` | The attempt and flow already in hand | `upkeepDay` by key: the day's invocation totals | None |
| Operations tick with no upkeep work | One meta read (`upkeepWork`) added to the tick | None | **None added** |
| Job selection | The live job set, already read every tick (`workflows/maintenance.mjs:86`) | — | None |
| Job start | Job, run, source flow and retrospective by key; `upkeepDay` by key | Run by key | — |
| Pre-filter | Configuration; `upkeepOpen` meta | — | One tree comparison and one text search at the merge commit |
| Model call | `upkeepDay` by key (reservation) | `upkeepDay` by key | One provider invocation |
| Candidate write | Each class key by key, in `finding` and `upkeepObserved` | The rows; `upkeepOpen` counts | None |
| Open candidates (prompt, Health) | The open candidates' own partial index (open upkeep findings only), bounded by the caps. Not the live finding set, which also holds the open audit backlog, which nothing bounds (slice 4 review, 2026-11-16) | — | None |
| Expiry of open candidates | Evaluated when the open candidates are read anyway | Rows by key | None |
| Expiry of observed classes | An indexed range read of `upkeepObserved` by first-observed time, oldest first, at most 50 rows, once per run settlement | Those rows by key | None |
| Task creation | The linked rows by key; today's and the six previous `upkeepDay` rows by key | Task, rows, queue entry, `upkeepDay` | One read of the target head (quote re-check) |
| Follow-up flow settlement | The flow in hand; its candidate ids are on its task snapshot | Rows by key; `upkeepDay`; `upkeepWindow` | None |
| Disposition command | The rows, the task and the obligation by key | The same | None |
| Share-of-invocations ceiling | Seven `upkeepDay` rows by key | — | None |
| Namespace collision check (commissioning, 7.2) | A range read of a declared index over **open** tasks keyed by the lower-cased id, from `upkeep:`, of at most 13 rows | — | None |
| Stats | `upkeepDay` rows by key for the window; `upkeepWindow` | — | None |
| Learning selection | The pinned selection on the flow | The flow | The learnings directory tree at one commit (at most 40 small files) |

**The idle guarantee is about what upkeep adds.** The operations tick already reads remote targets on its own timers and retries cleanups (`workflows/maintenance.mjs:61-78`; `operations/main-freshness.mjs:42-47`). Upkeep adds one meta read to a tick with no upkeep work, and no Git or provider read.

**The collision lookup is bounded and uses the reservation's own predicate.** The reservation (7.2) is "the id, lower-cased, starts `upkeep:`". The lookup uses a new declared index over open tasks only (the existing open-task condition, `core/records.mjs:78`) keyed by `lower(id)`, and reads the range from `upkeep:` up to, but not including, `upkeep;`. Ids are ASCII (`core/contracts.mjs:23`), so SQLite's ASCII `lower` and the reservation's lower-casing agree, and `Upkeep:legacy` is in the range. At most 12 upkeep tasks are open at once (7.2), so 13 rows are enough: either one of them has no marker, or there are more open tasks in the namespace than the factory can have made. Closed and completed tasks are not in the index.

**Invocation totals.** The share-of-invocations ceiling (8.3) needs a denominator covering every model invocation the factory makes, and no such total exists: usage is a projection over attempt receipts (`operations/usage-accounting.mjs:82-93`). The totals and the projection must count the same thing, so there is **one counting function**, used by the projection in place of today's and by both write hooks. For one attempt it returns:

1. the invocations its receipt names, if the action result carries the list. For `knowledge.upkeep` the result always carries it, and an empty list means none: the run ended at the pre-filter;
2. otherwise, if the action result is itself a provider result, that result and the originals of its protocol corrections (as `operations/usage-accounting.mjs:85`);
3. otherwise, with no usable receipt: **none** if the attempt's status is `not-dispatched` or its operation is not a model operation, and **one** if it is. The model operations are `provider.*`, `audit` and `knowledge.upkeep`;
4. with an observation id that repeats inside the attempt counted once.

Two things change for the existing projection, both deliberately. `knowledge.upkeep` becomes a model operation, where today only `provider.*` and `audit` are (`operations/usage-accounting.mjs:86`). And a `not-dispatched` attempt with no recorded invocation counts none, where today it counts one (`operations/usage-accounting.mjs:86-90` has no status test): a provider that was never started made no invocation. A `not-dispatched` attempt whose receipt does name invocations still counts them, because the receipt is evidence that they ran.

An invocation is **upkeep-attributed** when its attempt belongs to the upkeep job's own flow (a maintenance flow whose operation is `knowledge.upkeep`, `core/step-models.mjs:11`) or to a flow whose task snapshot carries a factory-written upkeep marker (7.2).

While upkeep is not `off`, two hooks add the function's count to the day's `upkeepDay` row, each in the transaction that already settles the attempt, and record on the attempt that it was counted so that it is never counted twice:

- the engine's attempt settlement (`core/engine.mjs:596-610`). The engine's own `not-dispatched` settlements (`core/engine.mjs:233-278`) have no receipt and add nothing;
- `attempt.resolve` (`core/project.mjs:966-972`), applied to the attempt with its new status and the receipt it kept, which may name several invocations or none.

**One stated difference.** The projection also leaves out an entry whose usage observation id was already seen under another attempt (`operations/usage-accounting.mjs:105-113`). Observation ids are random per invocation (`adapters/providers/index.mjs:180`), so that only happens when one recorded result is stored under two attempts, which is a data fault the projection hides. The totals count per attempt and would count it twice. Making them exact would need a permanent record per observation id; the numerator and denominator of the ceiling come from the same totals, so the share is consistent either way. A fixture pins this difference.

Tests: an uncertain attempt whose receipt names three invocations, resolved as failed and as not dispatched, adds three; a model attempt with no receipt adds one when failed and none when not dispatched; an upkeep run that ended at the pre-filter adds none; over a fixture without duplicated observations the day's totals equal the projection's count for the same attempts; the duplicated-observation fixture shows the stated difference and nothing else.

**The weekly task window** is today's UTC day and the six before it: seven `upkeepDay` rows read by key in the transaction that creates the task.

The lesson signals (10.1) are computed from the flow record and the indexed by-flow reads only. They do not use the retrospective's event sample (`operations/governance.mjs:54`), which is bounded but not indexed by flow.

Tests for this section run against a fixture with a large settled history (tens of thousands of attempts, thousands of flows, settled findings and old observed classes) and assert, by query plan or row-read counts, that each operation reads only what the table says, and that a tick with no upkeep work starts no Git or provider process on upkeep's account.

## 5. Triggering and scheduling

### 5.1 The pending receipt

When a `forge.merge` result is settled as merged (`core/engine.mjs:667`), the same transaction writes `upkeepRun` for the flow as `pending`, with the merge commit, the integrated base and the target, if:

- upkeep's mode is not `off`;
- the flow is a change or document flow (`core/project.mjs:521`);
- its task carries no upkeep marker (7.7).

Writing at merge settlement closes a gap in the first version, which queued the job only when the flow completed: a flow whose merge is proven but which then fails or is stopped at a post-merge step would have been missed.

The receipt becomes a queued job when the flow's retrospective is recorded, which happens when the flow finishes and when it stops (`core/engine.mjs:388`; `core/project.mjs:434`). A receipt still pending after 7 days is closed as `abstained:no-retrospective`.

An already-satisfied outcome has no merge and gets no receipt. Flows that end without a proven merge are not lesson sources (Q4). The operator, or the orchestrator where `job.enqueue` is delegated (`core/delegation.mjs:7`), can run upkeep by hand for one merged flow.

### 5.2 The lane

Built-in maintenance jobs share one lane (`workflows/maintenance.mjs:85`), and queued work waits on `main.verify` (`operations/admission.mjs:104`). The upkeep job has its own lane: at most one upkeep flow at a time, never counted against the built-in lane, taking no heavy-work permit and no flow slot. A `main.verify` or `target.sync` that is queued before or after an upkeep job has started is never delayed by it.

### 5.3 Maximum age, holds and drain

A receipt carries two absolute deadlines, written once and kept through every later change:

- **`pendingUntil`**: seven days after the merge was settled. A receipt that has not been queued by then is closed as `abstained:no-retrospective`.
- **`runBy`**: 24 hours (`upkeep.budget.maxQueueAgeMs`) after the receipt was first queued. A run that has not started its assessment by then is closed as `abstained:stale-run`. Reasons it may wait that long: a paused project, a provider usage hold, the daily limit, repeated configuration changes.

Neither deadline is ever moved later: not by a revocation, a drain, a requeue, a manual re-run of the same receipt or a larger configured age. A smaller configured age shortens `runBy` for receipts not yet started.

- **Configuration change.** A queued job's grant names the configuration digest, so a configuration change revokes it (`workflows/maintenance.mjs:80-84`). Its receipt returns to `pending` and is queued again under the new configuration if upkeep is still on. It keeps its `runBy`; if that has passed, it is closed instead of queued.
- **Provider hold.** The job waits in the queue until `runBy`. It never falls back to another provider unasked.
- **Drain.** An upkeep assessment does not hold up a drain. When maintenance is held for a drain (`core/project.mjs:718-720`), no upkeep job starts, and a running one is asked to stop; its receipt returns to `pending` with the same `runBy`, unless the run had already reserved its model run: such a run is closed (`abstained:stopped`) with the model run it used, because an assessment is never retried automatically (6.6; slice 3 review, 2026-11-16). If stopping leaves the attempt uncertain, the drain is blocked as for any uncertain attempt (`operations/upgrade-apply.mjs:133`); that is the existing rule and upkeep does not weaken it. Upkeep delivery flows under a drain hold are covered in 7.6.

Tests: a receipt taken through repeated configuration changes, and through repeated drain holds, across its `runBy` is closed at the deadline and never runs after it; raising `maxQueueAgeMs` does not revive it.

## 6. Assessment

### 6.1 Classification

The project declares its docs: `upkeep.docs.include`, with `exclude` (Q12). From that set the factory subtracts, in this order:

1. every governing path, resolved as section 7.1 defines;
2. upgrade-owned paths (`workflows/dispatch.mjs:124-150`);
3. the learnings directory.

What is left is the docs set. A file in both `upkeep.docs.include` and `context.files` is a context file and only a context file. If a governing entry cannot be resolved in the merge commit's tree, the factory cannot say what is protected there: the run produces no docs candidates and records `governing-unresolvable`.

Dated records (changelogs, change records, release notes, decision logs) are excluded in the starter example, and the prompt forbids rewriting dated entries.

### 6.2 The pre-filter

It needs no worktree. A file is a candidate when:

- **it refers to a touched path**: its text contains the repository-relative path of a file the merge changed, renamed or deleted; or
- **it is mapped to a touched path**: for a doc, an `upkeep.docs.map` entry; for a context entry, its own `paths` globs (`operations/context.mjs:20`).

A doc the merge itself edited is a candidate only through a reference to a deleted or renamed path. The same holds for a governing file the merge itself edited: it is a candidate only through such a reference, not through its entry's `paths` or a reference to another touched path (operator, 2026-11-16). An upgrade-owned context file is never a candidate.

The run ends without a model call, with a recorded reason, when:

| Reason | Meaning |
| --- | --- |
| `no-referring-doc`, with `no-signal` | No candidate file and no signal at all |
| `weak-signals-only` | No candidate file, and the only signals are weak ones (10.1) |
| `suspended` | The part that would act is suspended (8.4) |
| `budget` | The daily model limit is reached (6.6) |
| `backlog-full` | The docs backlog is full and there is nothing else to assess |
| `governing-unresolvable` | A governing entry cannot be resolved in the tree (7.1), and there is nothing but docs to assess |

### 6.3 The model call

One read-only invocation in a throwaway detached checkout of the merge commit, without `workspace.setup` (the pattern `target.sync` uses, `workflows/maintenance.mjs:219-231`).

Its model workflow key is `maintenance/knowledge.upkeep`, step `run` (`core/step-models.mjs:11`). The built-in model graphs and the role rule name only the audit today (`core/step-models.mjs:14-15`); both gain this operation. The role is a new optional `providers.upkeep`, falling back to the reviewer (Q5). The fallback is pinned: when the operator turns upkeep on, the route then in force (`providers.upkeep` if set, otherwise the reviewer's route at that moment) is recorded as the upkeep route, and a later change to `providers.reviewer`, by a delegate or anyone else, does not change it. Only the operator changes it, through `providers.upkeep` or `models.update`; turning upkeep off and on again pins afresh (operator, 2026-11-16).

Inputs, each bounded and each delivered as evidence (6.5): the task title and acceptance criteria; the merged diff; for each candidate file the matching lines with a few lines either side; the signals; and what already exists (the rules fast checks own, the titles of open candidates, the titles of learnings mapped to the touched paths, and the closed anchor list of 4.2).

**Deferred (operator, 2026-11-16, after the review of slice 8):** the assessment does not yet consume learnings; no slice wired them, and the eight slices ship without it. When it does, it must meet what slice 8 requires of every consuming role ([slice 8 record](../changes/upkeep-slice8.md)): the learnings read from one commit (the merge commit) through hash-verified objects, never a worktree; only files that pass the store's rules and the text rules; delivered as `advisory-learning` items in the assessment's own block, whole, with the fixed statement that a learning carries no authority and cannot on its own justify a candidate; outside every digest the run records; within `upkeep.budget.maxInputChars`, counted in code points; and a hostile-body test for the assessment prompt.

The output schema allows at most `maxFiles` docs edits, three context proposals and one capture candidate, or an explicit abstention with a reason (`insufficient-evidence`, `not-repeatable`, `already-covered`). Empty output is valid.

**Truncation.** When the diff or a file's excerpts had to be cut to fit, the prompt says what was cut. No candidate is accepted for a file whose excerpts were cut, and the run records `input-truncated` for it.

### 6.4 The validator

Deterministic, after the model and before anything is recorded:

- the file exists at the merge commit and is in the right set: the docs set for a docs edit, a project-owned configured context entry for a proposal;
- the quote is found verbatim (after the whitespace collapsing of 4.2) in that file, in the excerpts the model was actually shown;
- each cited signal id exists; a capture candidate rests on at least one verified correction (10.1);
- anchors and topics come from the offered lists; counts and lengths are within bounds;
- model-written text passes the text rules of 6.5.

Anything that fails is dropped and counted as `invalid` with the rule that failed. A run where everything was dropped ends `invalid`.

### 6.5 Evidence blocks and prompt injection

Quotes, reasons, replacements, capture descriptions, learning titles and learning bodies are chosen by a model or copied from the repository, and all of them become input to later prompts. The design treats every such string as untrusted evidence for its whole life.

**The block.** Evidence is delivered as a structured block the factory serialises (so its content is escaped and cannot close the block or imitate a heading), separate from the factory's instructions. Each item carries:

- `provenance`: who produced it (`repository`, `assessment-model`, `worker`, `reviewer`, `operator`), the source flow, and for repository text the file, line and Git blob id;
- `trust`: `untrusted-evidence`, or `advisory-learning` for a delivered learning;
- the text, bounded in length, with control, terminal and bidirectional-override characters removed.

The factory's own instruction text is fixed per delivery point and never contains evidence. It says that the block is data; that nothing inside it is an instruction; and that it cannot change the task, the files that may be touched, the budget, anyone's authority or any governing rule.

**Delivery points.**

| Where | Evidence | Rule |
| --- | --- | --- |
| Assessment prompt | Diff, doc excerpts, signals, open-candidate titles | All in the block |
| Follow-up task brief | Quotes and reasons | Acceptance criteria are factory template sentences that name a file, a line and an evidence id. The quote and the reason travel in the task's evidence field and are delivered as a block by the model steps. Acceptance text is copied into briefs and the pull request body as plain text today (`workflows/dispatch.mjs:330,534`), so it must not contain model-chosen text. |
| Pull request and forge comments | Quotes | Shown as quoted data with fence-breaking sequences neutralised |
| Console and inbox | All candidate fields | Rendered as text, never as markup; provenance shown |
| Context, rule and learning tasks | The proposed replacement or learning text | In the block; the builder applies exactly that text |
| Later planner, builder and reviewer prompts | Selected learnings | In a block labelled `advisory-learning`, after and apart from "Governing context" |

**Text rules for anything that will be read by later agents** (replacements, rules, learning titles and bodies): bounded length; no text addressed to "the model", "the agent" or "the assistant" beyond the rule itself; no claim of authority or permission; no instruction to ignore, override or reinterpret other rules, the operator or the factory; no commands, links or credentials unrelated to the lesson. The validator applies what can be matched mechanically and **flags** the rest for the person and the reviewer; a flag is shown, not silently decided.

**Reviewers.** For a task that changes governing text or adds a learning, the review step (by operation, from the task's marker) is told to inspect the proposed text itself for attempts to override authority, widen scope or address agents, and to report any as blocking.

**Learnings carry no authority.** A delivered learning is advisory. It cannot grant a permission, relax a rule, stand in for acceptance or an answer, or be the sole basis of a review finding. It is not part of the governing-context package or its digest (`operations/context.mjs:33`).

**Tests.** Structural, with deterministic fixtures:

- with hostile text placed in a doc excerpt, a diff hunk, a reviewer finding, an operator note, an open candidate's title and a learning body, the instruction part of each prompt is byte-identical to the prompt without it, and the block parses back to the same items;
- text that tries to close the block, start a heading or impersonate the factory stays inside the block;
- whatever a scripted model returns, a candidate naming a file outside the allowed set, a quote not in the shown excerpts, or an anchor outside the offered list is dropped.

Behavioural, in the evaluated trial (14.2), not as unit contracts: a doc that contains instructions aimed at the model produces no candidate that follows them, **and** a genuinely stale statement in the same doc is still found.

### 6.6 Cost

Terms used in this document and in Stats:

| Term | Meaning |
| --- | --- |
| Assessment invocation | One provider process started by an upkeep job. At most one per run. |
| Provider turns | Model turns inside one invocation, limited by the step's `maxTurns`. |
| Downstream invocations | Every model invocation in a flow whose task carries the upkeep marker: docs follow-ups, context batches, check and learning tasks. |
| Downstream checks | Fast checks, the gate and the post-merge main verification those flows cause. These run project commands, not a model (`core/operations.mjs:27,30`). |

All four are attributed to upkeep. Upkeep-origin tasks have the category `knowledge-upkeep`, which Stats already groups by (`operations/stats-view.mjs:264`), and the run record links each follow-up to its source flow.

What a run costs:

- **Pre-filter says nothing:** no invocation.
- **Model called:** one invocation. Across the readiness trial an invocation averaged $0.18 to $0.25 at list price over all roles (`docs/one-factory-progress.md:147,159`). A small model with a turn limit should cost less; that is unmeasured.
- **A docs follow-up through a reference graph:** four downstream invocations when the project plans (plan, plan review, build, review), two when it does not, plus two for each review send-back. The change reference adds the gate and any fast checks, which are checks. Every follow-up merge causes one main verification, during which queued work waits (`docs/running.md:300`).

Limits:

- **Daily model limit** (`maxModelRunsPerDay`, default 30). Before the provider starts, one transaction reads the day's `upkeepDay` row, refuses if reserved plus settled has reached the limit, and records a reservation under the attempt's id, so the same attempt never reserves twice. Settlement moves the reservation to settled with the observed usage. A failed, stopped or uncertain attempt stays counted; only an attempt settled as not dispatched whose receipt names no invocation is given back, since a receipt that names one is evidence that a model ran (4.5; slice 3 review, 2026-11-16). The day is the UTC day at the moment of the reservation, read inside that transaction. There is no automatic retry of an assessment: a second attempt happens only through a manual run, which reserves again. An uncertain attempt keeps its reservation until it is resolved (`docs/running.md:152`), and that command corrects the day row in its own transaction.
- **At the limit**, runs that need the model end `abstained:budget`. They do not queue for the next day.
- **Task ceiling.** At most 2 upkeep-origin tasks are created per UTC day and 6 in any seven consecutive UTC days (`maxTasksPerDay`, `maxTasksPerWeek`; N6), counted in the same rows (4.5).
  - **Amended (operator, 2026-11-17, dev.92 P2).** In the readiness trial a factory docs follow-up and one acceptance by the operator used up a day, and every later acceptance by the operator was refused until the next UTC day, while Health still offered it. The ceilings now limit only what the factory creates on its own (docs follow-ups) and acceptances by a delegate (the orchestrator on an instruction, by delegation or under a grant). The operator's own direct acceptance (a context batch, a rule, a check, a learning or a retirement) is never refused by them.
  - It is still counted: `tasksCreated` holds every upkeep task, and `operatorTasksCreated` the operator's share, for Health and Stats.
  - It uses up the factory's room. The ceilings are judged on `tasksCreated`, so an acceptance by the operator never gives the factory or a delegate more room than it had. This is the conservative choice: the factory's output stays bounded by N6 whatever the operator does.
  - Health shows, while upkeep proposes, what was made today and in the window, by whom, the room left, and when room returns (the next UTC midnight; for the week, the first midnight after which the window holds fewer than the limit). A candidate's `acceptance.problems` lists what refuses the operator's own acceptance, including an open task of its kind, the mode, a hold, a suspension and the open-task limit, so Health never offers an Accept the command refuses. `acceptance.delegatedProblems` lists what refuses the orchestrator's, and names the ceiling and its reset once the room is used up.
  - The open-task limits (one open task per kind, `maxOpenTasks`) still apply to everyone.
- **Per-flow ceiling.** An upkeep delivery flow that has used 8 model invocations (`maxFlowInvocations`) is abandoned at its next step boundary (7.6). For the reference graphs the visit bounds already stop a flow (`core/configuration.mjs:70,76,82`), but later than this.
- **Spending.** Model roles are subscription-backed (`README.md:59`), so there is no monetary reservation to make; the ceilings are counts. Stats shows a list-price estimate where `stats.pricing` is set.

**No universal bound for project workflows.** A follow-up runs through whatever workflow the project selects. The factory bounds how many follow-ups it creates, how many are open, and how many model invocations each may use. It does not bound what a project graph's own command steps, checks or integrations cost.

## 7. Docs follow-ups

### 7.1 Governing files are not docs

Context is loaded through the file system's full real path (`operations/context.mjs:7`), so a governing file may be reached through a link anywhere on its path. For example, with `context.files.path = rules/current/AGENTS.md` and `rules/current` a link to `../docs`, the governing file is `docs/AGENTS.md`. Comparing configured paths as written would let that file pass as a doc.

**Resolution.** The factory resolves a path in a Git tree, not in a working directory, the way the file system does: one component at a time, resolving each component before any `..` that follows it is applied. Nothing is normalised in advance, neither the path nor a link's target, because cancelling `name/..` as text skips `name`, and `name` may be a link.

The state is a **resolved** list of directory names, each known to be a real directory in the tree, starting empty at the repository root, and a **pending** list of components, starting as the path split on `/`.

Take the first pending component, until none is left:

- **empty or `.`**: drop it.
- **`..`**: remove the last name from the resolved list. If the list is already empty, the path leaves the repository: unresolvable.
- **a name**: look it up, by its exact name, in the directory the resolved list names.
  - **A directory**: append the name to the resolved list.
  - **A symbolic link**: count one hop; more than 40 hops, which covers a cycle, is unresolvable. Read the target. An absolute target is unresolvable. Otherwise split the target on `/` and put its components at the **front** of the pending list, in place of the link's name. The resolved list is unchanged, so the target is walked from the link's own directory, component by component, by these same rules.
  - **A submodule entry**: unresolvable.
  - **An ordinary file**: if it is the last pending component, the result is the resolved list followed by this name. If components remain, treat it as missing.
  - **Missing**: the path does not exist. If no remaining component is `..`, the result is the resolved list, this name and the remaining components, marked as not existing. If one is, the path is unresolvable.

If the pending list empties on a directory, the result is the resolved list.

Worked on the case that defeats early normalisation: `rules` is a link to `docs/jump/..`, `docs/jump` is a link to `../private/subdir`, and the governing entry is `rules/AGENTS.md`. Pending becomes `docs`, `jump`, `..`, `AGENTS.md`; `docs` is a directory; `jump` is a link, so pending becomes `..`, `private`, `subdir`, `..`, `AGENTS.md` with the resolved list still `docs`; `..` leaves the root; `private` and `subdir` are directories; `..` leaves `private`; the result is `private/AGENTS.md`, which is what the file system reaches. Cancelling `jump/..` as text would have given `docs/AGENTS.md`.

Lookups use exact names, as the supported file system does (Linux, `README.md:3`). Resolved paths are then **compared** without regard to case, which is the conservative direction and is how the upgrade-owned check compares paths (`workflows/dispatch.mjs:129-130`; `core/verified-git.mjs:107,295-297`). No Unicode normalisation is applied.

**The protected set** of a tree, under a configuration, is the resolved path of every `context.files` entry, including entries whose file does not exist.

**A path is governing in a tree** when its resolved path equals one in that tree's protected set, compared as above, or when it cannot be resolved. This covers both directions: a governing entry that reaches a doc's real location through links, and a doc path that reaches a governing file through links, whether the link is the file itself or any directory above it, in one hop or several.

**Fail closed.** If any governing entry is unresolvable in a tree, nothing in that tree can be shown to be outside the protected set: classification produces no docs candidates (6.1), and a candidate check on that tree fails.

**Where it is applied**, each time with the configuration current at that point:

| Point | Trees | Effect |
| --- | --- | --- |
| Classification (6.1) | The merge commit | A governing file is a context candidate, never a docs candidate, whatever `include` or `map` says |
| Task creation | The current target head | A declared path now governing removes that candidate from the task and reclassifies it as a context proposal |
| The candidate (7.4), at each of its four operations | **Both** the comparison commit's tree and the candidate's tree | A changed path that is governing in either tree is refused for every task kind except `context`, which requires it in both |

Both trees are needed. The comparison tree shows what the path is today. The candidate's tree shows what it would be after the merge: a candidate that changed which file a link or a governing entry leads to would otherwise make an ordinary doc governing, or the reverse, in the same change that edits it.

Resolution reads Git trees because that is what is published and merged. Worktrees are prepared by the factory from commits, and a candidate must have no untracked or uncommitted files before review, checks and merge (`workflows/dispatch.mjs:324-327`), so a link that is not in the tree cannot reach those steps. Context loading separately refuses a real path outside the project root (`operations/context.mjs:8`).

Fixture tests. Each is run in both directions (a governing entry that leads to a doc's location, and a doc path that leads to a governing file), with the link present in the comparison tree, in the candidate's tree and in both, and at every point of the table above: classification, task creation, and commit, integration, publication and merge.

- a file listed in both `include` and `context.files`; a `map` whose docs glob covers a governing file;
- the same file written as `./README.md`, `docs/../README.md` and in another letter case;
- a file that is itself a link; a link in a parent directory (the first example above); a link in a grandparent directory;
- a chain of two and of three links; a relative target that uses `..`; a link to a directory containing a link;
- **a target whose `..` follows a link** (the worked example): the result must be `private/AGENTS.md`, and `docs/AGENTS.md` must not be treated as the governing file on that account;
- **an escape hidden by early cancellation**: `rules` is a link to `sub/hop/../x` and `sub/hop` is a link to `../..`. Walking it leaves the repository at `hop`, so the entry is unresolvable and everything fails closed; cancelling `hop/..` as text would have given `sub/x`;
- a cycle; a target that is absolute; a target that leaves the repository root directly; a submodule on the path (each: fail closed);
- a context entry added by a configuration change after the task was created and before it builds.

### 7.2 The task

When validated docs candidates exist, no upkeep docs follow-up is open, and the task ceilings allow, the factory writes one local task (Q11), unapproved:

- **Id:** in the reserved `upkeep:` namespace, derived from the candidate ids and versions.
- **Title:** a factory template naming the source task's id.
- **Acceptance:** factory template sentences only (6.5), one per candidate, then the fixed criteria: no other statement changes; no file is added, renamed or deleted; the change stays within the limits; a statement that is no longer present is left alone and reported as unverified.
- **Paths:** the named files. **Risk:** ordinary. **Category:** `knowledge-upkeep`. **Original request:** origin `other`, no operator quotation (`docs/project-workflows.md:156`).
- **Marker:** the `upkeep` field, holding the task kind (7.4), the source flow and merge commit, the candidate ids and versions, the evidence items, the limits in force when it was created, and the Git blob id of each named file at the head it was validated against.

Tasks for the other kinds are written the same way by `finding.accept` (4.3), with their own kind, paths and limits.

**The marker is part of the brief.** `upkeep` is added to the brief fields (`core/project.mjs:218-219`), so it is in the revision digest (`core/project.mjs:604-608`), in the flow's task snapshot (`core/project.mjs:521`) and, on a migrated project, in the immutable revision snapshot (`core/project.mjs:626`). The factory's creation path computes the revision with the same function. The limits applied are the task's own or the current configuration's, whichever is tighter.

**The namespace is reserved everywhere a task can be created.** Nothing reserves a task namespace against `task.put` today: source configuration refuses three namespaces for custom sources (`operations/source-config.mjs:23`), and `core/project.mjs:239` only classifies maintenance tasks. The reservation therefore has to be made at each route.

**One predicate, everywhere.** An id, a source namespace or an id prefix is in the reserved namespace when, lower-cased, it starts with `upkeep:`. All three are ASCII (`core/contracts.mjs:23`; `operations/source-config.mjs:23`; `adapters/github/issue-profile.mjs:10`), so lower-casing is ASCII lower-casing. `Upkeep:x` and `UPKEEP:x` are reserved exactly as `upkeep:x` is. Ids the factory generates are lower-case. A task's identity is still its exact id.

| Route | Rule |
| --- | --- |
| `task.put`, and with it source sync and task import, which call it (`workflows/source-sync.mjs:28`; `workflows/commission.mjs:409`) | Refuses to create or change a task whose id is in the reserved namespace, and refuses the `upkeep` field on any task |
| Custom source configuration | A `namespace` in the reserved namespace is refused, beside the three refused today (`operations/source-config.mjs:23`). Today's list is compared exactly; this one is compared lower-cased, so `Upkeep:` is refused too. The conflict is reported at commissioning, not item by item during a sync |
| GitHub task-id prefix | A `dependencyIdPrefix` in the reserved namespace is refused, lower-cased likewise (`adapters/github/issue-profile.mjs:10`) |
| Recurring occurrences | Cannot collide. A recurring schedule's id is `recurring:` and the task's name, which may not contain a colon (`operations/scheduled-tasks.mjs:61`; `operations/recurring-tasks.mjs:17`). An occurrence's key is that id with a counter or a date (`operations/schedules.mjs:13,20`) or, for a manual run, `recurring:<name>:manual-<time>` (`core/project.mjs:893`), and the key is the task id (`core/project.mjs:207`; `workflows/maintenance.mjs:64`). A test pins that |
| Maintenance jobs | Their ids start `job:` (`workflows/maintenance.mjs:103`) |
| Upkeep creation (the factory for `docs`, `finding.accept` for the rest) | The only writer in the namespace. At most 12 upkeep tasks are open at once (`upkeep.budget.maxOpenTasks`); a creation beyond that is refused and the candidates stay as they were |

`task.label`, `task.models` and `task.schedule` still apply to an upkeep task: labels, model choice and the not-before time are not part of a brief (`core/project.mjs:611-618`). The brief itself cannot be edited; to want something different is to decline the task and write an ordinary one.

**A task is an upkeep task only if the factory made it.** That means both an id in the namespace and a marker written by the creation path, which the linked candidate rows name in return. An id in the namespace is not enough.

**Existing records that already collide.** A project may already have tasks whose ids start `upkeep:`, from a custom source with that namespace or from `task.put`. They have no marker, so they are ordinary tasks and stay ordinary: no limits apply to them, they do not suppress upkeep receipts, and nothing treats them as factory-made.

- Commissioning a configuration with upkeep on looks for open tasks in the reserved namespace without a marker, with the same lower-cased predicate through a declared index (4.5). If there is one, upkeep cannot be turned on, and the reason names up to five of them. Finish or close them, and rename the source's namespace, first. This is a breaking refusal for a project that already uses the namespace (P2); the release notes carry the rename steps.
- Completed and closed tasks in the namespace are history. They do not block anything and are never rewritten.
- With upkeep on, such a task can no longer be changed through `task.put`; it can still be labelled, scheduled, revoked and restarted.
- **How the `task.put` rule in the table above is read (operator, 2026-11-16, with slice 1).** Creating a task in the namespace is always refused, and a task that carries a marker is never editable. A task that was already in the namespace, without a marker, stays editable so that it can be closed: `task.put` is the only way to close a task, and the step above needs it. "Refuses to change" applies to such a task only once upkeep is on.
- If a generated id is ever already taken by a record without a matching marker, the creation is refused and counted. It is not retried under another id.

Tests, each with the id or namespace written as `upkeep:`, `Upkeep:` and `UPKEEP:`: `task.put` cannot create, edit or strip a task in the namespace, or add the field to another task; a custom source namespace and a GitHub id prefix in the namespace are refused at commissioning; a source sync and a task import whose items would land in it are refused with a reason that names the configuration; an open historical task such as `Upkeep:legacy` blocks turning upkeep on, a closed one does not, and neither ever gets upkeep treatment; a recurring occurrence cannot produce an id in the namespace.

An upkeep task cannot be started as an adopted pull request or as an already-satisfied outcome.

**Batching and backlog.** While a docs follow-up is open, new docs candidates wait as `unapproved` rows. At most 10 wait (`docs.maxWaiting`); a new one beyond that is not recorded and the run notes `backlog-full`. A waiting candidate expires after 14 days (N6). When the open follow-up ends, the next task takes waiting candidates oldest first, up to the limits, after re-checking each quote against the target head.

### 7.3 Workflow selection

Selection is unchanged (`core/catalog.mjs:156-164`):

- If `upkeep.docs.workflow` is set, the factory writes that name into the task's `workflow` field. That is the explicit selector, so it wins over any rule. Commissioning refuses a name that is not a catalog definition, a definition of kind `task`, or the setting at all on a project without a catalog.
- Otherwise the task has no `workflow` field and no labels, so the first rule matching its category `knowledge-upkeep` applies, then the default.
- Without a catalog the task runs through the project's one workflow.

On a branch that requires the gate status the workflow must be a change workflow (`starter/project/SETUP_CHECKLIST.md:28`). A no-planning reference is deferred (Q10).

### 7.4 Enforcement on the exact candidate

A guard at the commit step is not enough: a commit node proves nothing about routes that reach publication another way, and the candidate changes again at integration. The limits are enforced **inside the operations**, at the four places the upgrade-owned check is or can be made, so no graph can route around them:

| Operation | Check | On failure |
| --- | --- | --- |
| `workspace.commit` | Early, against the workspace base, so the refusal is readable (`workflows/dispatch.mjs:468-500`) | The commit is undone and the step fails |
| `workspace.integrate` | On a non-conflicting result, against the integrated target (`:502-515`) | The step fails |
| `forge.publish` | **Decisive.** On the head the factory just integrated, which is the only head it will push (`:516-533`) | Nothing is pushed |
| `forge.merge` | Again, on the authorized candidate (`:641-646`) | Nothing is merged |

A merge needs a publication, and commissioning already refuses any graph that reaches `forge.publish` other than from a clean integration (`core/catalog.mjs:91-127`), so every delivery route of every graph passes the decisive check. Commissioning also refuses to route upkeep tasks to a workflow of kind `task`.

**What is compared.** The candidate head's tree against the tree of the comparison commit, entry by entry, read through hash-verified objects (`core/verified-git.mjs`) and not through `git diff` under the repository's configuration, attributes or filters.

- **Comparison commit.** Before integration, the commit the factory prepared the workspace from. After integration, the integrated target commit, which the candidate must contain through verified parents (as `workflows/dispatch.mjs:138`). After integration the comparison is therefore exactly what the merge would change on the target.
- **Own commits.** The candidate's own commits, those not reachable from the comparison commit, may not touch a path the task kind does not permit, even when a later commit undoes it. Changes a builder committed itself are counted like uncommitted ones.

**Rules for every kind.**

| Case | Rule |
| --- | --- |
| Renames | Not detected as such: a rename is a deletion and an addition, and each is judged as that. A new path that differs from an existing one only by case is an addition |
| Links and submodules | A symbolic link or submodule entry may not be added, changed or removed, and no changed path may have a link in any directory above it, in either tree |
| Binary content | A changed blob that is not valid UTF-8 text, contains a NUL byte or is larger than 1 MiB is refused |
| Size | Changed lines are the added plus removed lines of a line comparison of the two blobs, computed by the factory. Whitespace and line-ending changes count. An added or deleted file counts all its lines |
| Path sets | The governing set is the one of 7.1, computed in both trees. The upgrade-owned set and the learnings directory are read the same way |
| Pinned files | Before the first build, each pinned blob must match (see the table below), or the flow fails as `stale` and its candidates return |
| Unknown kind | A task whose marker names a kind this release does not enforce is refused at admission and at each of the four operations |

**What each kind may do.** The kind is in the task's immutable marker (7.2). Everything not permitted here is refused.

| | `docs` | `context` | `check` | `learning-add` | `learning-retire` |
| --- | --- | --- | --- | --- | --- |
| Made from | Docs candidates | Context and rule proposals | Check candidates | Learning candidates | Stale-learning candidates |
| Paths that may change | The declared files, each in the docs set | The declared files, each the resolved path of a project-owned configured governing file | The declared files, each the **script** of a configured fast check, identified as below | The one declared file, directly inside the learnings directory | The one declared learning file |
| Governing paths | Never | **Required**: every changed path must be governing in both trees | Never | Never | Never |
| Learnings directory | Never | Never | Never | Required | Required |
| Upgrade-owned paths | Never | Never | Never | Never | Never |
| Additions | None | None | None | Exactly one: the declared file | None |
| Deletions | None | None | None | None | Exactly one: the declared file |
| File mode | Ordinary, not executable, unchanged | Ordinary, not executable, unchanged | Ordinary or executable regular file, **unchanged** | The new file: ordinary, not executable | The file was ordinary, not executable |
| Budget | 3 files, 40 changed lines | The files the accepted proposals name; 12 changed lines per accepted proposal | 2 files, 80 changed lines | One file of at most 1,500 characters in all, whose frontmatter passes the schema and whose `id` and `paths` equal the marker's | One file |
| Pinned blobs | Each declared file as validated | Each declared file as last validated (9.4) | Each declared file as offered | The path must not exist in the comparison tree | The file's blob: only that exact content may be deleted |

Notes on the matrix:

- **`check`.** The declared files come from a list the factory offers: the script of each configured fast check. Being named somewhere in a check's command is not enough: in `["python", "checks/verify.py", "src/schema.json"]` the second file is an input, not the script. The script of a check is identified from its `argv` by exactly one of two rules:
  1. `argv[0]` is a repository path (it contains a `/`, is not absolute and has no `..`): the script is `argv[0]`.
  2. `argv[0]` is the bare name of a known interpreter, one of `node`, `deno`, `bun`, `python`, `python3`, `bash` or `sh`: the script is `argv[1]`, or `argv[2]` when the interpreter is `deno` or `bun` and `argv[1]` is `run`. That argument must not start with `-`.

  In either case the script must resolve (7.1) to itself as a tracked ordinary or executable file that is not governing, not upgrade-owned and not in the learnings directory. Every other shape is **ambiguous and offers nothing**: any option before the script (`node --require ./hook.js check.mjs`), inline code (`sh -c …`, `python -c …`, `python -m …`), a wrapper (`npm`, `make`, `env`), an absolute or versioned interpreter path, or a script that is not a tracked file. No argument after the script is ever eligible. A check candidate whose scripts cannot be identified cannot be accepted into an upkeep task, and the refusal says why; it is ordinary work for the operator. The same holds on a project with no configured fast checks, and for any check that needs a new file (P3). A script that is already executable stays executable; nothing may change a mode.
- **`learning-retire`** deletes. It does not edit. Correcting a learning in place is not an upkeep kind; an ordinary task does it (P1).
- **`context`** is the only kind that may touch a governing file, and it may touch nothing else.
- **Conflicts.** A `docs` follow-up whose integration conflicts is ended, not repaired (7.6): the doc changed under it. For the other kinds, a commit that concludes the factory's merge is compared with the target like any other, so only the candidate's own difference counts.

A failure is fail-closed and counts against the output (8.2). The reviewer still judges the change against the acceptance criteria and declared paths as today (`workflows/dispatch.mjs:224`).

**Fixtures.** For every kind, at each of the four operations:

- a delivery that succeeds: a docs correction; a governing-file edit through a `context` task, including one whose file is reached through a linked directory; a change to an executable fast-check script that keeps its mode; one new learning file; one learning deleted;
- a refusal for each cell of the matrix that says "never", "none" or "unchanged", and for each rule in the first table, including an own commit that is later undone;
- for `check`: a command that names both its script and an input file, where only the script is offered and a task that changes the input file is refused; and one command of each ambiguous shape, which offers nothing.

### 7.5 Merge decisions and automatic merge

An upkeep flow's merge question goes to `policy.mergeDecisionRole`, and a strict escalation to the operator, as for any flow (`docs/project-workflows.md:345-352`).

What it would otherwise inherit: an upkeep flow is ordinary risk and not an adopted pull request, so on a project with `policy.autoMerge` on and qualified, its merge question would be answered by policy as it opens (`core/engine.mjs:451,463`).

Upkeep-origin flows are excluded from automatic merge (N1). The exclusion is one more condition where the engine decides `autoMerge`, keyed on the task's marker.

### 7.6 Slots, parking and abandonment

A docs follow-up is an ordinary flow. While it is working it holds a slot, like any flow (`operations/capacity.mjs:62-75`); that is wanted. What must not happen is an upkeep flow holding a slot, or a parked allowance, while nothing is running for it.

- **It queues last.** `queueApprovedTask` appends (`core/project.mjs:169-174`). A project that ranks its queue can put the category last (`policy.categoryOrder`).
- **Parked allowance.** An upkeep flow is admitted only when a parked place is free, and upkeep flows are counted last in the allowance order, so requested work is never pushed over the limit by one.
- **Questions.** A docs follow-up that reaches any question other than its merge decision (a plan, build, conflict, review or gate question) is ended (N2). Such a question means the candidate was not as simple as claimed.
- **Unwanted retention.** An upkeep flow that is stopped, or parked beyond the allowance, holds a slot without working. It is ended as soon as that is safe, and the time it held the slot is recorded.
- **Drain.** Under a drain hold, a parked upkeep flow is ended at once and a working one at its next step boundary; their candidates return to `unapproved`.

**Ending an upkeep flow safely** uses the existing abandonment, with its conditions (`core/project.mjs:962-964`):

| State | Action |
| --- | --- |
| No attempt, not merged | Abandoned by the factory, with the reason recorded. The pull request, if published, is closed with a comment; the workspace goes through the normal failed-flow cleanup |
| An attempt is running | The flow is stopped with an abort request; it is abandoned when the attempt settles |
| The attempt is uncertain | **Not abandoned.** The flow stays stopped, one notice is raised, and the existing reconciliation applies. The slot it holds meanwhile is counted as unwanted retention |
| The merge is proven | Never abandoned. It is a merged flow to close out as usual |

Evidence kept: the flow, its attempts, receipts and prompts, the candidate rows with the reason, and the archived workspace, all under the existing retention rules.

Tests: a `main.verify` queued after an upkeep job has started is not delayed; an upkeep flow is not admitted when the parked allowance is full and is counted last when it is; a merge question left to expire leaves no slot held once the flow is abandoned; a flow with an uncertain attempt is not abandoned; an upgrade waiting for a drain is not held by a queued or running assessment, nor by a parked upkeep flow.

### 7.7 Merge queue, main checks and recursion

- The assessment reads the merge commit, not the target head; it neither depends on nor changes main health.
- A follow-up needs green main to be admitted (`operations/admission.mjs:104`). If the source change is reverted, the revert's own run finds the waiting follow-up's quotes changed and closes its candidates as `resolved-elsewhere`.
- A follow-up's merge triggers a main verification like any merge (`core/engine.mjs:669-679`).
- **No recursion.** A flow whose task carries the upkeep marker gets no receipt. The marker is on the task, so this holds for project-owned graphs. There is one receipt per source flow.

## 8. A cheap "nothing needed"

### 8.1 Rules

1. **Existing files only**, apart from an approved learning (11.1).
2. **A quote, or nothing.** Every docs edit and proposal quotes the statement the merge made false. Every capture candidate rests on a verified correction.
3. **A diff budget** (Q7): 3 files and 40 changed lines per follow-up; 600 characters per proposal; 1,500 characters per learning file.
4. **No tidying, no restating the code.**
5. **One open docs follow-up; capped backlogs.**
6. **Nothing is the default.** An empty result is valid at every stage and is never retried.

### 8.2 What "unnecessary" means, and who judges

An output is unnecessary when the validator drops it; when the candidate check or the reviewer rejects the follow-up; when it is declined as `unnecessary`, `wrong` or `duplicate`; when it expires; when it is reverted or a regression is recorded against it (`core/project.mjs:692-698`); or when a later sample review finds that a merged follow-up was not needed (14.2). The judges are a script, an independent reviewer and a person. No model grades its own output.

### 8.3 Rates are ceilings

There is no target for how much upkeep should produce. Zero output over any period is a pass. Each rate below is a **ceiling**; crossing one suspends a part.

| Measure | Window | Ceiling | Suspends |
| --- | --- | --- | --- |
| Runs that reach the model | Last 20 runs | 6 (30%) | The model call |
| Runs that produce any candidate | Last 20 runs | 4 (20%) | The model call |
| Docs follow-ups that end rejected, failed, declined or expired | Last 10 ended | 3; or 3 in a row | Docs |
| Context and capture candidates declined or expired | Last 10 disposed, per part | 5 | That part |
| Reverts or regressions of upkeep changes | Last 20 merged | 1 | Everything |
| Upkeep-attributed invocations as a share of all invocations | The last 7 complete UTC days, from the maintained totals (4.5) | 10% | The model call and docs |

**Task ceilings and the operator (2026-11-17, dev.92 P2).** The rates above, and the daily and weekly task ceilings of 6.6, bound what the factory produces on its own. An acceptance the operator makes directly is a person's decision, not factory output: the task ceilings never refuse it. It is counted with the factory's tasks and uses up their room, so the factory's own output stays within N6. Its outcomes still enter every window above, like any other upkeep task's.

A window is evaluated only once it is full, except the "3 in a row" rule and the revert rule, which apply from the first event. Evaluation happens when a run or a disposition is recorded, from `upkeepWindow` and `upkeepDay`; nothing polls.

Limits on age and count: waiting docs candidates 10 and 14 days; open context proposals 10 and 30 days; open capture candidates 10 and 30 days; observed classes 200 and 90 days, expired through their own indexed path (4.5).

### 8.4 Suspension

Suspension is recorded with the part, the rule, the window's contents and the time. A suspended part produces nothing: runs end `suspended` before the model is called, or candidates are still recorded but no task is created, as the table says. One notice is raised. Existing open candidates and tasks are untouched.

A suspension is lifted only by the operator, with a note (N3). It never lifts by itself, and turning the mode down and up again does not clear it.

### 8.5 What every run records

The outcome (`nothing`, `abstained`, `invalid` or what it produced), the stage that decided, the abstention reason (6.2, 6.3), what was truncated, the counts dropped by the validator with the rule that dropped them, and the usage. These are bounded counters and enums, not transcripts; the prompt itself is kept with the attempt as for any model step (`docs/running.md:154`).

## 9. Authority

### 9.1 Approving an upkeep task

Approval is explicit (Q1). It applies to `docs`, `check`, `learning-add` and `learning-retire` tasks; a `context` task is approved by its acceptance (9.4).

| | Schema 1 | Schema 2 (migrated) |
| --- | --- | --- |
| Operator | `task.approve` directly | `task.approve` directly; an authority use is recorded (`core/grants.mjs:180-183`) |
| Orchestrator | By operational delegation with a recorded instruction, where `task.approve` is delegated (`core/delegation.mjs:7`; `core/project.mjs:637`) | Only by citing a stored grant entry that pins this task id, this revision and this workflow digest (`core/grants.mjs:141-178`). A grant can only name a task that exists (`core/grants.mjs:62-65`), so the operator issues it after the task is created. This design adds no standing grant for "any upkeep task" |
| The factory | Never | Never |

**A `check` task (operator, 2026-11-16, after the review of slice 7).** The orchestrator row does not apply to it. A check script is code the factory runs on every later candidate, so a `check` task is approved only by the operator, acting directly, on both schemas, never by delegation, an instruction or a grant, and the approval is bound to the exact revision and to each declared script's blob and mode, as a governing edit's is (Q2, extended). Admission, every step and the four operations of 7.4 require it. The orchestrator may still accept a check candidate into an unapproved task (4.3). Strict risk may be added on top; it does not replace this approval.

### 9.2 Upkeep configuration is authority-bearing

What upkeep may create and how large is authority, in the same way recurring-task templates are (`core/authority-policy.mjs:22-23`). The normalised upkeep authority value, with defaults applied, is:

- the mode;
- the docs scope: `include`, `exclude`, `map`, the limits and `workflow`;
- the context and capture caps and thresholds;
- the budgets: daily model runs, task ceilings, the per-flow invocation ceiling, the queue age;
- the upkeep model role and its step defaults, since they decide what runs;
- the learnings directory and caps, since they bound what later agents are shown.

Rules:

- **Schema 2.** The value is added to `authorityPolicy`, so a delegated `config.update` or `settings.update` that changes any of it is refused (`core/authority-policy.mjs:30-34`; `core/project.mjs:1004,1032`).
- **Schema 1.** The authority-policy comparison does not run there. The same value is therefore also compared through the operator-only check, which runs on both schemas (`core/project.mjs:996-1000,1030`) (N4).
- **One exception, on both schemas.** Anyone who may use `settings.update` may turn the mode **down** (toward `off`). Turning it down never widens what the factory does, and a kill switch should not need the operator.

This protection ships before any setting that can cause a model call is exposed (slice 2).

### 9.3 Other actions

Candidate actions are in the actor table of 4.3. The rest:

| Action | Who |
| --- | --- |
| Write a receipt, queue a job | The factory, under the commissioned configuration (as `core/engine.mjs:674,678`) |
| Run upkeep by hand for one merged flow | Operator, or delegated orchestrator (`job.enqueue`) |
| Merge an upkeep flow | `policy.mergeDecisionRole`; never automatic (7.5) |
| Lift a suspension; turn the mode up; change any other upkeep authority setting | The operator only |
| Turn the mode down | Anyone who may use `settings.update` |

No model step and no builder writes a candidate, a disposition, a task or an approval.

### 9.4 Accepting context proposals

Acceptance is one operator command naming, for each proposal, its id, the version the console displayed, and a digest of what was displayed (file, quote, replacement, reason, file blob id). It is refused to the orchestrator under any instruction or grant (Q2). In one transaction it:

(As of the governance-edit fix, operator 2026-11-16: the task it writes carries `governingEdits`, the entry ids of the files its proposals name, and step 3 records `governingEditsApproval` with the approval. The same operator-only approval now applies to every task that edits a governing file, not only to `context` tasks; Q2 originally said it was "not extended to every task that touches a context file", which is superseded.)


1. checks that each row is `unapproved`, at that version, and that the digest of its **stored** fields equals the displayed digest, and refuses the whole command otherwise;
2. writes one task of kind `context` in the `upkeep:` namespace, built from the stored fields, not from the command's payload: one template criterion per proposal, the context files as paths, `governingEdits` naming their context entries, and a marker holding each proposal's id and version, the exact replacement text, and the blob id of each file as last validated;
3. approves that task revision, bound to its workflow digest: on schema 1 as an operator approval, on schema 2 through the direct-operator authority use (`core/grants.mjs:180-183`), so the approval provenance names this command;
4. marks each row `tasked` with the task id and revision.

Nothing else can approve that task: it cannot be edited (7.2), and its approval follows its revision.

"The current file digest" is bound, not assumed. The blob id in the marker is the file as it was when the proposal was last validated. Before the task's first build the candidate check requires each named file to have exactly that blob (7.4). If the file changed in between, the flow fails as `stale`, the proposals return to `unapproved` at a new version, and the operator sees the current text before accepting again.

## 10. Governing-context proposals and capture

### 10.1 Signals

The retrospective gains a bounded `lessonSignals` list, computed without a model call from the flow record and the indexed by-flow reads (4.5).

**Verified corrections** are attested by something other than the worker that made the mistake. Only these can support a capture candidate, and only these or a candidate file cause a model call.

| Signal | Source |
| --- | --- |
| A review sent the change back and a later review marked the finding fixed | `flow.reviewHistory` and `priorFindingsDisposition` (`core/delivery-review.mjs:32-35`; `adapters/providers/index.mjs:24`). Where the protocol does not require dispositions, a finding absent from the passing round is recorded as inferred and is weak |
| A fast check failed and later passed on the same flow | Attempts with `outcome: 'failed'` and `failedChecks` (`core/attempt-outcome.mjs:10-22`) |
| The gate failed and later passed | Gate attempts by flow |

**Weak signals** are context. They are shown to the model beside a verified correction and never count alone.

| Signal | Source |
| --- | --- |
| A plan review sent the plan back | Plan-review attempts with a `revise` verdict |
| A replan with a note, by a person | `flow.operatorFeedback` entries with answer `replan` whose actor is not the factory (`core/project.mjs:448,541-543`) |
| A plain operator answer or note | `flow.operatorFeedback` (`core/project.mjs:807`) |
| A worker challenged a rule | `pushback` rows by flow (`core/engine.mjs:621-624`) |
| A departure from the plan, or unverified acceptance | `flow.workerReports` (`core/engine.mjs:619`) |
| An unchanged candidate after a send-back | The attempt's recorded reason (`core/engine.mjs:606`) |

A plan send-back or an operator's answer shows that something was unclear to one agent once; it does not show a mistake a later agent would repeat (N5).

### 10.2 What a proposal is

A `finding` row of kind `context` (a false statement) or `rule` (a capture candidate in its governing-rule form), holding the context entry id and path, the file's blob id, the quoted statement and line (or, for a new rule, the signals and where it belongs), a replacement of at most 600 characters, a one-line reason, the evidence, and its source flows.

It is never an edit. It may target only an existing, project-owned, configured context file, never a new file or a new `context.files` entry.

Proposals wait in the console's Health tab. At most one notice says how many are waiting, raised when three are open or the oldest is seven days old. Acceptance is section 9.4; it produces one task per batch, so one merge and one context digest change.

Before accepting, the console shows how many unfinished flows have a reviewed plan.

### 10.3 The capture rule

For one flow's verified corrections the model answers: **given the code, tests, checks, governing context and docs after this merge, would a future agent plausibly repeat this mistake?** If not, it abstains (`not-repeatable` or `already-covered`).

If so, it proposes the first form that works and says why each cheaper one does not:

1. **A check**: a rule a script can test, for the project's fast-check script.
2. **A governing rule**: one condition in the nearest existing governing file. This is a context proposal.
3. **A learning**: what a check or rule cannot hold.

At most one capture candidate per flow. A check is raised from one flow; a rule or a learning is recorded as `observed` from the first flow and raised only when a second, distinct source flow produces the same class key (Q6; 4.3).

A capture candidate becomes a task by the sequence for its kind (4.3), and that task may change only what its kind permits (7.4):

- **Check:** a `check` task changes an existing project-owned fast-check script, which runs from the flow's worktree and so changes by merge (`docs/running.md:186`). Listing the rule in `fastChecks.checks[].rules` is a configuration edit the operator makes; the completion notice says so. On a project with no configured fast checks the candidate cannot become an upkeep task: a first check needs a new script and a configuration change that adds a graph node (`docs/project-workflows.md:234`), which is ordinary work for the operator to commission.
- **Rule:** a `context` task, by the operator's acceptance (9.4).
- **Learning:** a `learning-add` task adds one new file from the template (11.1).

The starter ships `LEARNING.template.md` and an optional `factotum-compound` skill for the orchestrator. In-flow agents do not load skills; they get the gate through the task.

### 10.4 Effect of a context change on running flows

A flow's context is read from its own worktree (`workflows/actions.mjs:64-72`), so a merged context change does nothing to a running flow until that flow integrates the new target. Then:

- a flow that needs another build round replans with a fresh budget, or stops if `policy.followTarget` is off (`workflows/actions.mjs:40-54`);
- a flow past its last build carries on, and its reviewer receives the new context (only build and plan review are guarded, `workflows/actions.mjs:75,93`);
- a flow admitted later plans under the new context.

Applying a batch depends on the open defect in `docs/runtime-followups.md:9-17`; that fix comes first (Q8).

## 11. Learnings

### 11.1 The store

One project-owned directory (`learnings.dir`), one small Markdown file per learning, not listed in `context.files` (Q3). Commissioning refuses a directory that contains a governing path or is contained in one.

Each file has frontmatter (`id`, `title`, `paths`, `kind`, `enforced_by`, `last_verified`, `retire_when`) and a body. **The whole file, frontmatter and title included, is at most 1,500 characters.** The store holds at most 40 entries; at the cap a new learning cannot be accepted until a retirement has merged (11.4).

### 11.2 Selection and pinning

- **Boundary.** Learnings are selected once per plan cycle, at the cycle's first model step: the plan step where the graph has one, otherwise the first build. A replan starts a new cycle and selects again.
- **What is read.** The learnings directory as it is in the commit the flow's worktree is on at that step. Not the working files.
- **Selection.** Entries whose `paths` match the flow's scope at that step (task paths; `workflows/actions.mjs:65`), ranked by the most specific match and then the most recent `last_verified`, at most five, within `learnings.maxChars`. The character budget counts each entry as delivered, with its title and provenance. (Slice 8, after its review: characters are code points throughout, and an entry is delivered whole or not at all; it is never cut.)
- **Pinning.** The flow records each selected entry's id, path and **Git blob id**, and the commit. Every later step of the cycle is given the content of exactly those blobs, read from the object database. A builder editing a learning file in its worktree, or a learning merged meanwhile, changes nothing delivered to that cycle.
- **Without planning.** A flow on a graph with no plan step uses the same rule with its first build as the boundary, and its scope is the task's declared paths. A flow with neither a plan nor declared paths selects nothing.

### 11.3 Delivery and citation

Selected learnings reach the planner, plan reviewer, builder and code reviewer as an `advisory-learning` evidence block (6.5), with the instruction that current code and governing context win and that any entry applied or contradicted is cited by id. The plan and build results gain `learningsApplied` and the review result `learningsChecked`. As with `assumptions`, this changes result schemas, not graphs (`docs/project-workflows.md:76`).

**What is and is not guaranteed.** Delivering learnings never invalidates governing context: they are outside the context package and its digest (`operations/context.mjs:33`), and no plan guard reads them (`operations/context.mjs:45-68`). A merged learning can still cause a replan the ordinary way: when the target moves, a running flow replans if the new commits touch its task paths or plan files, and those match by prefix (`workflows/actions.mjs:27,41-42`). A task that declares a broad path containing the learnings directory will see a learning merge as a change to its planned paths. Keep the learnings directory outside the paths tasks normally declare.

### 11.4 Retirement

A scheduled, read-only job, `learnings.check`, raises a `learning-stale` candidate. It deletes nothing. The conditions are a small typed set, each checkable from the tree and the counters:

| Condition | Fires when |
| --- | --- |
| Built in: paths | The entry's `paths` match no file at the target head |
| Built in: enforcement | `enforced_by` names a fast-check id or a context entry id that no longer exists |
| Built in: unused | Selected in at least ten flows and never cited (`learningUse`) |
| `retire_when: path-absent:<glob>` | No file matches |
| `retire_when: file-present:<path>` | The file exists |
| `retire_when: check-present:<id>` | A fast check with that id is configured |

`retire_when` accepts only those three forms, or `none` (operator, 2026-11-16, after the review of slice 7: a learning with no typed condition relies on the built-in ones); anything else is refused when the learning is reviewed. Deciding that a check or rule now "covers" a learning in meaning is deferred: it needs a model and is not part of this design. Age alone is not staleness. A stale candidate that a person accepts becomes a `learning-retire` task (4.3), which may delete exactly that file with exactly that content (7.4); Git history is the archive. (Operator, 2026-11-16, after the review of slice 8: acceptance is refused unless the file at the target head is still the blob `learnings.check` read and the condition still fires there with the current counters; the retire flow checks both again before its first model step, and a check resolves a tasked candidate whose task has not started.) Correcting a learning in place is not an upkeep kind: it is an ordinary task. At the store's cap, a new learning can be accepted only after a retirement has merged; the two are never combined in one task.

## 12. Configuration surface

Two optional top-level blocks. Absent means off.

```json
"upkeep": {
  "mode": "off",
  "docs": {
    "include": ["README.md", "docs/**/*.md"],
    "exclude": ["docs/changes/**", "docs/release-notes.md"],
    "map": [{"docs": "docs/api/**", "paths": ["src/api/**"]}],
    "maxFiles": 3,
    "maxChangedLines": 40,
    "maxWaiting": 10,
    "workflow": "docs"
  },
  "context": {"maxOpen": 10},
  "capture": {"maxOpen": 10},
  "budget": {
    "maxInputChars": 40000, "maxTurns": 6, "timeoutMs": 300000,
    "maxModelRunsPerDay": 30, "maxTasksPerDay": 2, "maxTasksPerWeek": 6,
    "maxFlowInvocations": 8, "maxOpenTasks": 12, "maxQueueAgeMs": 86400000
  }
},
"learnings": {"dir": "docs/learnings", "maxSelected": 5, "maxChars": 6000, "maxEntries": 40}
```

- **`mode`** has three values: `off`; `observe` (the pre-filter and the model run and outcomes are recorded, but no candidate row or task is written); `propose` (candidates are visible, and tasks are created and approved as section 4.3 says). `mode` would be a live, operator-only setting (`operations/live-settings.mjs:9,23`), with the turn-down exception of 9.2.
- **Model**: `providers.upkeep`, and step defaults under `maintenance/knowledge.upkeep`.
- **`learnings`** is independent of `upkeep`.

**Deferred, and not part of the eight slices:** approval of docs follow-ups by commissioned configuration (Q1), a fourth mode that would turn it on, and the approval provenance and compatibility rules it would need. If the trial supports it, that is a separate design: it must say how such approvals are recorded and lapse, and whether they are allowed at all on a migrated project.

The operation name has to be added to each hard-coded list of maintenance operations (`workflows/maintenance.mjs:35`; `core/command-help.mjs:6`; `core/project.mjs:871,1061`; `workflows/dispatch.mjs:311,700`), to the operation contracts (`core/operations.mjs:36-43`), to the built-in model graphs and role rule (`core/step-models.mjs:14-15`), to the commissioning probes (`workflows/commission.mjs:197`) and to the quiet-completion list (`core/project.mjs:312`).

## 13. Compatibility

### 13.1 Reference graphs and approvals

No node is added to `changeWorkflow` or `documentWorkflow`, and neither reads these settings, so the compiled graphs and their digests are identical with the feature on or off (`core/configuration.mjs:57-126`; `core/catalog.mjs:147`). Approved tasks stay approved (`core/catalog.mjs:188-193`). The review confirmed this.

Turning the feature on is a configuration change: a drained `config update` and doctor (`docs/running.md:208-216`).

### 13.2 Projects with their own graphs

- The receipt keys on a proven `forge.merge` result under its binding (`core/engine.mjs:616,667`).
- The limits are enforced in the publish and merge operations, which every delivery graph must use to deliver (7.4), not in a node a project graph might omit.
- Learnings and evidence blocks are delivered by operation, not node name.

### 13.3 Older releases

Narrower than the first version claimed:

- **The two top-level blocks** are ignored by an older release: `validateConfig` has no list of allowed top-level keys (`core/configuration.mjs:133-204`).
- **`providers.upkeep`** is tolerated but unused: an older release checks only the three required roles and each role's turn limit (`core/configuration.mjs:156-162`) and probes only the roles it knows (`workflows/commission.mjs:197`).
- **A `stepModels` entry for `maintenance/knowledge.upkeep` is refused** by an older release as an unknown workflow (`core/step-models.mjs:34-37`). A saved model default for that step has the same effect and must be reset before going back (`docs/project-workflows.md:343`).
- **Records.** New kinds and new `finding` statuses are data an older release does not read. Open candidates keep the status `unapproved`, so the existing live set and index mean the same thing (`core/records.mjs:84`); but an older console would list open upkeep candidates beside audit findings and offer to create a task from them. New indexes follow the existing layout rules and need a downgrade test.
- **Upkeep-origin tasks** already created would, on an older release, be ordinary tasks with no limits enforced. Going back therefore means declining or finishing them first; the release notes must say so.

## 14. Rollout and evaluation

### 14.1 Default

**Off.** Recommended path: `observe` until 20 runs are recorded, then `propose`. The starter template carries the block with `"mode": "off"` and a setup-checklist entry.

### 14.2 Trial on the readiness-trial project

Seeded tasks, with the expected result known in advance. Structural rows are also deterministic fixtures in the test suite; the rows marked *model* can only be judged in the trial.

| Seeded case | Expected |
| --- | --- |
| No doc or rule impact, clean first-pass review | No model call |
| A change renames a command a doc names | *Model:* one docs candidate quoting the stale line; the follow-up changes only that line |
| A change alters behaviour a doc describes without naming a touched path | Records what the pre-filter misses |
| A file is listed as both a doc and a governing file | A context proposal only; no docs task can name it |
| A governing entry reached through a linked parent directory, whose real file is inside the docs globs | The same: never a docs candidate, and a docs task that names the real file is refused at publication |
| One successful delivery of each task kind: a docs correction, a governing edit, a fast-check script change, a new learning, a retired learning | Each merges within its own permissions |
| A queued run taken through repeated configuration changes past its deadline | Closed at the deadline; never run |
| A send-back for a rule a script could check, later fixed | *Model:* one `check` candidate |
| A send-back for a judgement call | *Model:* abstains |
| Only a plan send-back and an operator note | No model call (`weak-signals-only`) |
| The follow-up's builder also tidies another paragraph, adds a file, or changes a file mode | Refused at publication |
| A follow-up reaches a build question | Ended; no question reaches the operator |
| A merge question left to expire | The flow is abandoned; the retained slot time is recorded |
| A proposal accepted after its file changed | The flow fails as stale; the proposal returns at a new version |
| A proposal batch merges while another flow is mid-correction | That flow replans once |
| `main.verify` queued after an upkeep job started | Not delayed |
| An upgrade waiting for a drain with upkeep queued and a follow-up parked | Not held by either |
| A doc that contains instructions aimed at the model, and one genuinely stale line | *Model:* no candidate follows the instructions; the stale line is still found |

**Sample review of accepted outputs.** Approval and merge show that a person let a follow-up through, not that it was needed. Two weeks after each stage, every merged follow-up and accepted candidate (or 10 chosen at random, if there are more) is reviewed again by the operator or by a reviewer who did not see it before, with one question: would anyone have been misled had this not been done? The share judged unnecessary is reported next to the approval rate, and a share above 30% is a kill criterion.

### 14.3 Success and kill criteria

| Measure | Pass | Suspend or kill |
| --- | --- | --- |
| Output | Any amount, including none | The ceilings of 8.3 |
| Docs follow-ups merged without a send-back, decline or expiry | At least 70% | The docs ceiling of 8.3 |
| Accepted outputs later judged unnecessary (sample review) | At most 30% | Above 30% |
| Context and capture candidates accepted | At least 50% | The ceiling of 8.3 |
| Reverts or regressions | None | 8.3 |
| Upkeep-attributed share of invocations | At most 5% | Above 10% |
| Selected learnings cited | At least 30% | Below 10% after 20 selections: stop delivering them (built in slice 8: the `learnings` suspension, lifted only by the operator, after which the window starts again) |
| Delay to `main.verify` caused by upkeep | Never | Any occurrence |
| Unwanted slot retention by upkeep flows | None; each occurrence recorded with its duration | Any occurrence longer than 15 minutes that was not an uncertain attempt |
| Send-back rounds resting on a rule a check now owns | Falls after check candidates land | No change after five accepted checks |

## 15. Slices

In the review's order. Structural acceptance uses deterministic fixtures and scripted model results. What a real model does is judged in the trial (14.2), never asserted as an exact unit contract.

Two requirements hold across the order:

- **Fail closed before delivery exists.** From slice 1, the `upkeep:` namespace is reserved at every task-creating route, and a task whose marker names a kind the running release does not enforce is refused at admission and at commit, integration, publication and merge. No slice before 5 creates an upkeep task, and none can be made by hand.
- **Authority before exposure.** The upkeep authority value and its operator-only protection on both schemas ship in slice 2, with the first setting. No setting that can cause a model call exists before it.

**Slice 1: record and access contracts, deterministic lesson signals, and the reservation.**
- The record kinds, indexes and meta keys of section 4; the class-key functions; path resolution and the protected set (7.1); the `lessonSignals` list; the namespace reservation and the unknown-kind refusal.
- Accepted when: fixtures for each signal kind produce exactly the expected signals with the right class; a clean flow produces none; automatic target-follow replans produce none; no signal depends on the event sample; class keys are stable across runs; every resolution fixture of 7.1 gives the expected result, including the link followed by `..`, the escape hidden by early cancellation and the other fail-closed ones; on the large-history fixture every listed operation reads only what 4.5 allows; an unverified kind suspends upkeep rather than scanning; the namespace tests of 7.2 pass in all three letter cases, and the collision lookup reads at most 13 rows on the large-history fixture; a hand-made task carrying a marker cannot be created, and a record carrying an unknown kind cannot be admitted or published.

**Slice 2: the deterministic observe-only job, its scheduling, and settings authority.**
- The pending receipt and its two deadlines, its conversion when the retrospective exists, the lane, the drain rule, classification with governing subtraction, the pre-filter, the run record, `mode`, and the authority protection of 9.2.
- Accepted when: a merged flow that later fails or stops at a post-merge step still gets one run; unmerged, task, maintenance and upkeep-origin flows get none; a tick with no upkeep work adds one meta read and starts no Git or provider process for upkeep; a `main.verify` queued before or after an upkeep job starts is not delayed; a receipt taken through repeated configuration changes and repeated drains across `runBy` is closed and never runs, and a larger configured age does not revive it; a drain is not held by a queued or running assessment; graph digests are identical with the block present and absent; a delegated configuration or settings change that alters any upkeep authority field is refused on schema 1 and on schema 2, except turning the mode down.

**Slice 3: the model assessment, the validator and bounded telemetry.**
- The invocation, model selection under `maintenance/knowledge.upkeep`, evidence blocks, the validator, abstention reasons, the daily reservation, the maintained invocation totals, the run telemetry. `observe` only: no candidate rows.
- Accepted when: the injection fixtures of 6.5 pass; scripted model results that break each validator rule are dropped and counted under that rule; truncated input blocks candidates for the truncated file; the daily limit is exact under concurrent starts and a repeated attempt id reserves once; at the limit runs abstain and do not queue; an uncertain attempt keeps its reservation until resolved; the counting tests of 4.5 pass: several recorded invocations on a reconciled attempt, a missing receipt, `not-dispatched` with and without recorded invocations, an upkeep run that ended at the pre-filter, equality with the projection, and the one stated difference.

**Slice 4: candidate lifecycle and command authority.**
- Candidate rows and observed classes, the state machine, `finding.accept`, `finding.resolve` and `finding.reopen` with expected versions, audit obligations, caps and expiry, the windows and suspension, Health. `finding.accept` exists for audit findings only until slice 5.
- Accepted when: every transition in 4.3 is allowed only to the listed actor and only at the expected version, with a refusal fixture for each other actor; a rule or learning class is raised only after two distinct flows, and the same flow twice does not count; observed classes expire through their indexed path without reading the finding set; a declined candidate is not reopened by a later observation; a third return expires the candidate; declining a tasked candidate closes its task and declines every linked candidate; audit dispositions close and reopen their obligations as in 4.4; each ceiling suspends its part at exactly the stated count and only the operator lifts it; the seven-day share uses complete days only.

**Slice 5: docs delivery.** In two parts, the second only after the first is proven.
- *Part A, enforcement on the final candidate:* the candidate check in commit, integrate, publish and merge for the `docs` kind; the automatic-merge exclusion.
- *Part B, creation and lifecycle:* task creation by the factory, workflow selection, batching and backlog, the slot and parking rules, safe abandonment.
- Accepted when (A): a docs correction is delivered through all four operations; each "never", "none" and "unchanged" cell of the `docs` column and each general rule of 7.4 has a fixture refused at publication, including an own commit that is later undone, a rename, a mode change, a link, a binary change, and a governing path reached through a linked directory, a link chain, a link followed by `..` or a case variant, in either tree; a graph with no commit step still cannot publish an out-of-bounds candidate; an upkeep flow is never merged by policy. (B): the task's criteria contain no model-chosen text; the weekly ceiling counts seven consecutive UTC days; `upkeep.docs.workflow` selects as 7.3 says and is refused where it cannot apply; on schema 2 an orchestrator approval without an exact grant is refused; the lifecycle tests of 7.6 pass.

**Slice 6: governing-context proposals.** After the fix for `docs/runtime-followups.md:9-17`.
- Proposal rows, the waiting notice, atomic acceptance, the `context` kind, the pinned-blob check, the count of flows that may replan.
- Accepted when: an accepted proposal is delivered through all four operations, including one whose governing file is reached through a linked directory; a `context` task that touches any path that is not governing is refused; acceptance is refused to the orchestrator under every instruction and grant; acceptance with a stale version or a different displayed digest is refused and writes nothing; the created task's text comes from the stored rows; a file changed after acceptance fails the flow as stale before any model step; three accepted proposals produce one task and one merge; no code path other than a flow's builder writes a governing file.

**Slice 7: capture creation.**
- `check`, `rule` and `learning` candidates from the assessment, the `check` and `learning-add` kinds, the template and the skill.
- Accepted when: a change to an executable fast-check script that keeps its mode is delivered, and one that changes the mode or adds a file is refused; one new learning file is delivered, and a second file, a file outside the directory, an over-long file or a frontmatter mismatch is refused; a capture candidate without a verified correction is dropped; an anchor or topic outside the offered lists is dropped; at most one per flow; for a command that names both its script and an input file only the script can be declared, and each ambiguous command shape offers nothing; a check candidate on a project with no fast checks cannot be accepted and says why.

**Slice 8: learning consumption and retirement.**
- The `learnings` block, selection, blob pinning, delivery, citation fields, usage counters, `learnings.check` with the typed conditions, the `learning-retire` kind.
- Accepted when: a learning file edited in the worktree or merged after the boundary does not change what later steps of the cycle receive; a flow without a plan step selects at its first build; size limits count frontmatter and title; the governing-context digest is identical with and without learnings; a learning merge replans a flow only through the ordinary target-follow rule, with a fixture showing both the narrow-path and the broad-path case; each typed retirement condition raises one candidate and deletes nothing; a retirement is delivered by deleting exactly the pinned file, and a retirement that edits the file, deletes another or deletes changed content is refused; an unknown `retire_when` form is refused.

**Deferred:** approval by configuration and its mode (section 12), a no-planning reference, filing follow-ups in the issue source, a removed-identifier pre-filter rule, correcting a learning in place as an upkeep kind, any automated judgement that a check or rule covers a learning in meaning, and learnings as an input of the upkeep assessment (6.3, with its requirements).

## 16. Open questions for the operator

None. Every question raised by the three earlier versions is settled in section 2.

Two things in this revision are new numbers or changes to existing behaviour that follow from the review's fixes, not open choices; they are listed so that they are not missed:

- **`upkeep.budget.maxOpenTasks`, 12.** A ceiling on open upkeep tasks, needed so that the collision lookup is provably bounded (4.5, 7.2).
- **Usage statistics change slightly.** With one counting function for the projection and the totals, a `not-dispatched` model attempt with no recorded invocation counts no invocation, where Stats counts one today (4.5).

## 17. Review points and where they are addressed

**First review (of `c50b337`)**

| Review point | Section |
| --- | --- |
| High 1: docs upkeep as an indirect governing edit | 6.1, 7.1, 7.4 |
| High 2: exact grants and authority-bearing configuration; schema 1 and 2; atomic context acceptance | 9 |
| High 3: enforcement on every delivery route and on the exact candidate; comparison base and edge cases; immutable marker | 7.2, 7.4 |
| High 4: prompt injection | 6.5, 11.3 |
| Medium 5: cost | 6.6 |
| Medium 6: access paths | 4.5 |
| Medium 7: a cheap "nothing needed" | 6.2, 8, 10.1, 14.2 |
| Medium 8: lifecycle and slots | 5.3, 7.6, 14.3 |
| Medium 9: learning pinning | 11.1, 11.2 |
| Medium 10: disposition and recurrence contracts | 4.2, 4.3, 4.4, 11.4 |
| Accuracy: automatic merge; workflow selection; learning merges and replans; model namespace; older releases; post-merge coverage gap | 7.5; 7.3; 11.3; 6.3; 13.3; 5.1 |

**Second review (of `c5c8d85`)**

| Review point | Section |
| --- | --- |
| 1 (high): governing paths reached through linked ancestors; both trees; fixtures | 7.1 |
| 2 (high): a permission matrix by task kind; successful deliveries as well as refusals | 7.4, 10.3, 11.4 |
| 3: namespace reservation at every route; the wrong precedent; existing collisions; the marker in hashing and snapshots | 7.2, 3 |
| 4: one creation and approval sequence per kind; an actor matrix; exhausted returns; stale learnings | 4.3, 9.3 |
| 5: an access path for observed-class expiry; maintained invocation totals; the weekly window; the scope of the idle guarantee | 4.1, 4.5, 8.3 |
| 6: deadlines that survive revocation, drain and requeue | 5.3 |
| Slices: successful-delivery cases; fail closed before delivery; authority before exposure | 15 |
| Scope: the unused mode and configuration approval reduced to a deferred note | 12, 9.1 |

**Third review (of `34d2a3e`)**

| Review point | Section |
| --- | --- |
| 1 (high): `..` applied only after the component before it is resolved; the two new fixtures | 7.1 |
| 2: the check script identified from the command, not from membership in it | 7.4 |
| 3: one counting function for the hooks and the projection; `not-dispatched`; how `knowledge.upkeep` is recognised | 4.5 |
| 4: the collision lookup uses the reservation's case-insensitive predicate through a declared, bounded index | 4.5, 7.2 |
| Citations: the Unicode claim removed; recurring ids cited to the code that builds them | 7.1, 7.2 |

## 18. What this design deliberately does not do

The research's "what not to adopt" list applies as follows.

- **No worker writes knowledge directly.** Candidates come only from a validated job result; every edit lands through an approved, reviewed flow.
- **No growing always-loaded file.** Governing rules are proposed and batched; learnings are selected by path under a cap and carry no authority.
- **No reviewer swarm, research agents or depth tiers.** One small model call per flow at most, and none for most flows.
- **No transcript mining.** Signals come from structured records only.
- **No automatic application.** Nothing is merged by policy, and no governing file is touched without the operator.
- **No silently maintained vocabulary or summary document.** Existing files only.
- **No productivity claim.** The measures in section 14.3 are the only evidence this step will be judged on.
