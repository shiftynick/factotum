# A task editing its own governing context

Fixes the runtime follow-up [A task editing its own governing context](../runtime-followups.md#a-task-editing-its-own-governing-context). Base: `main` at `f6fed83`; first round `2d922df`; the fixes for its independent review are in [Review of `2d922df`](#review-of-2d922df). Required before knowledge upkeep slice 6 (design [knowledge-upkeep.md](../designs/knowledge-upkeep.md), Q8 and section 15), whose `context` tasks deliver accepted governing-context proposals by editing governing files.

This is a local implementation record, not a release or live qualification claim.

## The defect

A reviewed plan pins the governing context it was made under (`contextManifest`, `operations/context.mjs`). `assembleContext` reads every entry from the flow's working checkout at every step. When a builder changed a project-owned governing file:

1. planning had used the original context digest;
2. the builder changed the file in the candidate;
3. review received the changed file as governing context, so it judged the change against the proposal itself, and asked for a revision;
4. preparing the next build compared the current package with the plan and failed with `reviewed plan context or task changed; replan required`.

Replanning aligned the digests only until the next edit. And a review that passed instead let the changed rules through as rules in force.

## The design

The approved governing-context snapshot is separated from proposed changes to those files. Only a task the operator explicitly approved may propose such changes; for every other task, and for every file an approval does not name, a governing change is refused before review and before anything is delivered.

### Explicit approval (the decision this change makes)

A task is approved for governance edits when all of these hold:

- **Its brief names the files.** `governingEdits: [context entry id, ...]`, at most 8. The field is one of `BRIEF_FIELDS`, so it is in the revision digest, the flow's task snapshot and, on a migrated project, the immutable revision snapshot. An approval covers exactly the files it names. A task without the field has the same brief and revision as before.
- **Only the operator, directly, sets it.** `task.put` refuses a brief carrying the field from anyone but `actor: operator` without `onBehalfOf`, whatever `policy.delegatedOperations` says. The orchestrator can still put the task without the field, which removes the permission. Source sync and task import never produce the field (they build briefs from a fixed list).
- **Only the operator, directly, approves it.** `task.approve` of a revision with the field is refused to a delegated actor and to an orchestrator citing a grant. The approval writes `governingEditsApproval: { revision, approvalVersion, approvedAt }`. Any later approval change (revocation, a withdrawn grant, a brief edit, a re-approval by another route) moves `approvalVersion` or the revision, and the record no longer applies. `task.restart`'s nested approval goes through the same `task.approve` rule.
- **Each named entry is a project-owned governing file that is always delivered.** It is a configured `context.files` entry with `required: true` and no `paths` mapping; its path is a plain repository path (no `.`, `..`, leading `/` or backslash), listed in the task's `paths`, and not upgrade-owned (compared without regard to case, as the upgrade-owned check compares). At each step the path must also reach an ordinary file at exactly that path in the snapshot tree, with no symbolic link anywhere on it.
- **It runs in its own workspace.** Admission refuses such a task in rehearsal mode, as an adopted pull request and as an already-satisfied outcome.

These are checked at `task.put`, `task.approve`, admission and the preparation of every step. A task whose approval no longer holds is refused at its next step (`... its current approval is not the operator's own approval of revision ...`), rather than silently falling back: the candidate may already hold governing edits that no current approval covers.

**Consistent with slice 6.** The design's `context` task is created and approved by one operator command (design 9.4), in one transaction, as an operator approval. Slice 6's creation path should write `governingEdits` (the entry ids of the files the accepted proposals name) into the brief beside the `context` marker, and record `governingEditsApproval` in the same transaction as the approval it makes. Slice 6 can only name required, unmapped entries. The `context` kind's own candidate check (design 7.4: every changed path governing in both trees, budgets, pinned blobs) is slice 6's; this change provides the flow semantics and the general boundary that check runs inside. Nothing here lets a model, a builder or the orchestrator create the permission.

### The comparison commit

`governanceBase` is recorded in the flow by the engine once, from the first result that brings an owned workspace (`source.verify` or `workspace.prepare`), as that workspace's base, and never changed (`core/engine.mjs`). The flow's comparison commit (`comparisonCommit`, `operations/governance-edit.mjs`) is the integrated target once the factory has integrated one (`results.integrate.base`), else `governanceBase`. Both come from flow state, never from the candidate. A workspace whose base no longer equals `governanceBase` is refused. Before a comparison commit exists, an approved task may run only the operations that create the workspace (`source.verify`, `workspace.prepare`), which send no governing context to a model; any other step is refused.

### What every step receives

For an approved task, `actionSpecification` builds a snapshot and passes it to `assembleContext`:

- The named entries are read from the comparison commit, through hash-verified Git objects. Never from the worktree.
- Every other entry is read from the worktree as before.
- Every named entry is delivered whole. `assembleContext` fails closed if one is missing from the package for any reason (a budget that cannot hold it, a configuration changed after approval).

So the builder's own edits do not change the delivered package. The plan's manifest, the plan review's recorded digest and every later build agree, and the existing guards pass without any exemption for builder sessions. The planner on a replan also gets the approved version.

### The governing-file boundary, for every task

`assertGoverningBoundary` (`operations/governance-edit.mjs`) compares the candidate commit with the comparison commit, entry by entry over every configured governing entry: how the entry's path resolves in each tree (7.1's resolution, links followed) and the object it reaches. An entry differs when its resolution, mode or content differs. A difference is allowed only for an entry the task's current approval names, and only as a content change: the same path in both trees, no link on it, the same mode. Anything else is refused, naming the entries.

It is checked:

- **before review**: when a `provider.review` step is prepared (`workflows/actions.mjs`), against the committed candidate (review refuses an unclean worktree). The reviewer never starts, so it never reads a governing change nobody approved as rules in force;
- **inside the delivery operations** (`workflows/dispatch.mjs`): `workspace.commit` on the commit it just made (undone on refusal, the change left uncommitted, as for upgrade-owned files), `workspace.integrate` on the integrated head against the integrated target, `forge.publish` on the head it would push, and `forge.merge` on the authorized candidate. No graph routes around them.

A review is anchored to a commit the factory recorded before any model work: `governanceBase` (from the first owned workspace or, for a flow without one, the checkout's commit as its first model step other than a review is prepared, `core/engine.mjs`), else the workspace base or the verified source head. A review with none of these (for example a review that is the first step of a flow in the project checkout) is refused for every task, so an unanchored verdict never implies the boundary was checked. Commit, integration, publication and merge always have their own comparison commit.

**This changes behaviour for every task**, by operator decision (2026-11-16), which also extends knowledge-upkeep design decision Q2 (the design records the original wording as superseded). A task without `governingEdits` that changes a governing file was replanned at its next build if review sent it back, and merged if review passed. It is now refused before review. An adopted pull request that changes a governing file is refused at integration. To change a governing file, name it in `governingEdits` and approve the task directly.

### What still needs a new plan

The guards at plan review and build are unchanged in substance:

- **Any other governing file** changed in the worktree: `replan required: governing context <id> changed ...`, followed by `(task <id> is approved to change only these governing files: ...)` or, for a task without approval, `(task <id> is not approved to change governing files: ...)`.
- **Configuration**: a changed entry definition, an added or removed entry. A named entry made optional, mapped or moved into the factory folder is refused at every step.
- **Task approval**: a brief edit changes the revision (`reviewed plan context or task changed; replan required`); an approval change that is not the operator's own approval of this revision stops the next step.
- **The target branch**: target follow counts every context path as a planned path, so a target change to an approved file replans (or, with `policy.followTarget: false`, fails `target changed since reviewed plan; replan required`). After a replan the snapshot is the new target's version.
- **The upstream-owned boundary**: upgrade-owned files can never be named, and the upgrade-owned checks at commit, integration, publication and merge are unchanged.

### Prompts

For an approved task the brief's line `Do not change governing factory files or instructions.` is replaced by a block that:

- names the approved files and the commit their rules in force come from, and says the candidate's version is a proposal that takes effect only once reviewed and merged and does not govern this run;
- when a named file is one a provider CLI may load on its own (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `CLAUDE.local.md`, any folder, any letter case), says that file there may hold the proposal and that the Governing context section applies where they differ;
- tells the builder it may change only those governing files and only as the acceptance criteria require, the planner to plan against the rules in force, and plan and code reviewers to judge the proposal as part of the change against the rules in force. The code reviewer receives the proposal in its trusted diff.

Every other task's prompts are byte for byte unchanged. The attempt intent records `governanceEdit` (`{ commit, entries }`, or `null`) and `governanceBase`.

### Providers that load instructions on their own

Every model step of an approved task is invoked with `suppressWorktreeInstructions: true` (`workflows/dispatch.mjs`), and the provider adapter (`adapters/providers/index.mjs`, `WORKTREE_INSTRUCTION_SUPPRESSION`) passes:

| Provider | Flag | What it does |
| --- | --- | --- |
| Codex | `-c project_doc_max_bytes=0` | `project_doc_max_bytes` is Codex's configuration key for the most bytes it reads from the project documents (`AGENTS.override.md`, `AGENTS.md` and any `project_doc_fallback_filenames`) on the way from the project root to the working directory; at 0 it reads none. `-c` overrides one configuration value for the invocation. It is added to both `codex exec` and `codex exec resume`, which accept `-c` |
| Claude Code | `--safe-mode` | "Start with all customizations (CLAUDE.md, skills, installed plugins, hooks, MCP servers, custom commands and agents, ...) disabled" (`claude --help`). Already part of every Claude invocation, with `--setting-sources ''`, fresh and with `--resume`; for an approved task the adapter now requires it. Claude Code does not read `AGENTS.md` on its own |

The adapter fails closed: a governance-edit invocation whose arguments do not carry its provider's flag, or a provider with no entry in the table, is refused before the CLI starts (`PROVIDER_REJECTED`). A configured fallback provider inherits the requirement. Other tasks' invocations are unchanged.

**How they were confirmed.** No model session was started. From the installed CLIs on the build host (Codex 0.169.0, Claude Code 2.1.325): `codex exec --help` and `codex exec resume --help` list `-c, --config <key=value>` ("Override a configuration value that would otherwise be loaded from `~/.codex/config.toml`"); `project_doc_max_bytes` and `project_doc_fallback_filenames` are configuration keys in the Codex binary, next to its `agents_md` loader and its `AGENTS.override.md` file name; `claude --help` documents `--safe-mode` as quoted above. That a size of 0 disables the documents is Codex's documented behaviour for this key, and is what the live check verifies. `codex debug prompt-input --help` shows a command that renders the model-visible input without a model call; the qualification uses it. The live check, with one cheap invocation and one resume per provider, is [provider instruction loading](../qualification/provider-instructions.md). It has not been run.

## What was built

| Piece | Where |
| --- | --- |
| The permission and its checks, the comparison commit, the snapshot reader, the governing-file boundary, the prompt block | `starter/factory/operations/governance-edit.mjs` (new) |
| `snapshot` option: named entries read from the snapshot and always delivered | `starter/factory/operations/context.mjs` (`assembleContext`); `governingContextChange` names the changed entry |
| The snapshot at every step; the boundary before review; the hint on a refused change; `governanceEdit` and `governanceBase` in the intent | `starter/factory/workflows/actions.mjs` |
| The boundary in commit, integration, publication and merge; the prompt block; the provider flag request | `starter/factory/workflows/dispatch.mjs` |
| `governanceBase` recorded once from the first owned workspace | `starter/factory/core/engine.mjs` |
| The suppression flags and the fail-closed check | `starter/factory/adapters/providers/index.mjs` |
| `governingEdits` in the brief; operator-only `task.put` and `task.approve`; `governingEditsApproval`; the admission checks | `starter/factory/core/project.mjs` |
| Command help | `starter/factory/core/command-help.mjs` |
| Docs | `docs/project-workflows.md`, `docs/commands.md`, `docs/runtime-followups.md`, `docs/qualification.md`, `docs/qualification/provider-instructions.md` (new) |

## Compatibility

- Reference graphs and their digests are unchanged.
- A task without `governingEdits` has the same brief, revision, approval, delivered context, prompts and provider arguments. It is now refused before review, and in commit, integration, publication and merge, if its candidate changes a governing file (see the boundary above).
- Flows recorded before this change have no `governanceBase` until a result with a workspace is settled; an existing task cannot carry `governingEdits` (the field did not exist), and the boundary for other tasks falls back to the workspace base and the verified source head.
- Plans recorded before this change keep their comparison, including the legacy exact digest comparison for plans without a manifest.
- No SQL reads over `records.data` were added.

## Release notes

- **New: approved governance edits.** A task can now change a project-owned governing file through review and correction rounds without its own plan being invalidated. Every step receives the file as approved; the candidate's version is reviewed as a proposal, and Codex and Claude Code are started without reading project instruction documents from the worktree. Factory instructions under `factory/` can never be named.
- **Breaking: every governing-file change needs the operator's own approval naming the file.** A candidate that changes any configured `context.files` entry its task is not approved to change is refused before review and in commit, integration, publication and merge. Before, such a change could be reviewed against itself and merged. A review that has no commit recorded before the flow's model work (a review as the first step of a flow in the project checkout) is also refused.

**What adopters do**

*To update `AGENTS.md` (or any governing file):*

1. Check the file's `context.files` entry has `"required": true` and no `paths` mapping, and that its path is not under `factory/`. If it has a mapping or is optional, change the configuration first (`config update`, with no change flow running).
2. Put the task as the operator, naming the entry and listing the path:
   `node factory/cli.mjs command --state <state> --actor operator --operation task.put --payload '{"task": {"id": "rules-dated-entries", "title": "Say that entries are dated", "acceptance": ["AGENTS.md says every entry is dated"], "paths": ["AGENTS.md"], "governingEdits": ["project-governance"]}}'`
   (`project-governance` stands for the entry's `id` in your configuration). The orchestrator cannot put or approve a task with `governingEdits`, with or without an instruction or grant.
3. Approve it as the operator: `node factory/cli.mjs command --state <state> --actor operator --operation task.approve --payload '{"taskId": "rules-dated-entries", "revision": "<revision shown by task.put>"}'`, then start it as usual. It runs in its own workspace; it cannot be run in rehearsal, as an adopted pull request or as an already-satisfied outcome.
4. Any later edit to the brief, a revocation or a re-approval by another route ends the permission: approve the new revision yourself.

*An adopted pull request that touches a governing file* is refused at integration (`workspace.integrate: the candidate … changes governing context …`). Either ask its author to remove the governing-file change and adopt it again, or close the adoption and carry the governing change as an operator-approved task as above (applying the rest of the pull request as its own task or adoption).

*A task already running* that changes a governing file without approval stops before its next review. Undo that change in the task, or stop the flow and put a new brief that names the file in `governingEdits`.

- **Before relying on governance edits**, run the [provider instruction-loading checklist](../qualification/provider-instructions.md) on the host. A worktree's Codex project configuration and skills are not covered by the suppression; see [runtime follow-ups](../runtime-followups.md#codex-project-configuration-and-skills-in-a-governance-edit-worktree).
- **No configuration or commissioning change** is needed otherwise.

## Tests

`tests/governance-edit-context.test.mjs` (disposable Git fixtures; engine prepare and settle with the real dispatch code and a fictional provider; the delivery operations against a local bare remote and a scripted `gh`; the provider adapter with a scripted transport; no provider CLI is started). Each test's first failing assertion on the runtime before its fix is the boundary it is about; the second and third columns are where it fails on `f6fed83` (no fix) and on `2d922df` (first round).

| Regression | Test | On `f6fed83` | On `2d922df` |
| --- | --- | --- | --- |
| Approved edit through several correction rounds | `an approved governing-file edit survives several correction rounds, ...` | second build: `replan required: governing context project-rules changed` (the reported defect) | the provider-flag assertion (Q1) |
| Replan under the approved rules | `a replan of an approved governance edit plans against the approved rules, ...` | the planner receives the proposal | passes |
| Unrelated context change | `an unrelated governing-context change still requires a replan ...` | the refusal does not say what the task may change | the approved entry made path-mapped is not refused (P2) |
| Changed task approval | `a changed task approval is revalidated ...` | the step is not refused for the changed approval | passes |
| P1: approved task edits an unnamed governing file | `an approved task that also edits an unnamed governing file is stopped before review sees it` | review is prepared | review is prepared |
| Upstream-owned instructions | `upstream-owned factory instructions are refused: ...` | review is prepared with `factory/AGENTS.md` edited | the same |
| Unapproved task edits a governing file | `a task not approved for governance edits ... is stopped before review sees it` | review is prepared | review is prepared |
| P1: delivery operations | `commit, integration, publication and merge refuse a governing change the task is not approved for` | the commit is made | the commit is made |
| P1: approved delivery, and only the named content | `an approved task delivers its named file through commit, integration and publication, and nothing else that governs` | an unnamed governing file is committed | the same |
| P2: approved entries always delivered | `an entry a task may change must be required and unmapped, and is never left out of a step` | a path-mapped entry is accepted | the same |
| P3: no owned workspace | `without an owned workspace a governance edit is refused, never read from the candidate` | the review is prepared | the review is prepared, with the committed proposal as the rules |
| P3: recorded once | `the comparison commit is recorded once, from the first owned workspace, ...` | nothing is recorded | nothing is recorded |
| Q1: provider flags | `a governance-edit step starts Codex with no project documents and Claude Code in safe mode, fresh and resumed` | no Codex flag | no Codex flag |
| Re-check Q1: unanchored review | `a review with no commit recorded before model work is refused for every task; a first model step records one` | (added after `b282de2`) | fails at the first refusal on `b282de2`: the review is prepared |

Results on this branch (with `main` at `201ab43` merged): `node --test tests/governance-edit-context.test.mjs` 14/14; the first thirteen are 0/13 on `f6fed83` and 2/13 on `2d922df` (the two first-round tests whose boundary that round already fixed), and the fourteenth fails at its first refusal on `b282de2`; full `npm test` 1654 tests, 1654 passed, 0 failed, cancelled or skipped; `npm run eval` exit 0; `git diff --check f6fed83..HEAD` clean.

`upkeep` stays the last of `BRIEF_FIELDS` (`governingEdits` sits before it); the slice 5 part B precondition test pins that order.

## Review of `2d922df`

An independent review (GPT-6.1 Sol) requested changes, one P1 and two P2, and asked that provider instruction loading be settled before slice 6. Direct operator checks, the absence of an approval bypass (delegation, grants, source and import, recurring, schedule, console), upgrade-owned case variants and `..`, link rejection, verified reads and unchanged graphs held up. It also noted that several first-round regressions failed on the base before reaching their boundary assertions; they now fail at it (table above).

1. **P1: an edit to an unnamed governing file reached review as rules in force.** With only `project-rules` approved, a builder could edit `GUIDE.md`; review read the edited file as governing context and could pass. Fixed by the governing-file boundary, for every task, before review and inside the four delivery operations.
2. **P2: approved entries could be left out of the delivered context** by a mapping or the budget. Named entries must be `required: true` and unmapped, re-checked at every step, and `assembleContext` fails closed if one is not delivered.
3. **P2: with no workspace and no plan, the snapshot followed the candidate's `HEAD`.** The comparison commit is now `governanceBase`, recorded once from the first owned workspace, or the integrated target; without it an approved task runs no step that delivers context, and admission refuses the shapes that have none.
4. **Q1: provider instruction loading.** Codex gets `-c project_doc_max_bytes=0`, Claude Code `--safe-mode`, fresh and resumed, with a fail-closed check and a live qualification step.

## Re-check of `b282de2`

The re-check (GPT-6.1 Sol) approved: no P1 to P3 remained. The operator kept the strict boundary (every governing-file edit needs the operator's own approval naming the file; adopted pull requests touching governing files are refused), which extends knowledge-upkeep Q2; the design now says so in Q2, 4.3 and 9.4 with the original wording kept as superseded. Its two questions:

1. **A review with no recorded commit.** The engine now records `governanceBase` before any model work in a flow without a workspace (as its first model step other than a review is prepared), and a review with no recorded commit is refused for every task. Two existing fixtures that placed a flow directly at a later step (`tests/provider-turn-limit.test.mjs`, `tests/planning-builder-flow.test.mjs`) now carry the commit a real flow records.
2. **A worktree's `.codex/` configuration and skills.** Recorded as a separate runtime follow-up, to be qualified or isolated before slice 6 relies on the suppression. The suppression claim is unchanged: project documents only.

## Open questions

1. **The live provider check** ([provider instruction loading](../qualification/provider-instructions.md)) has not been run. Until it is, the suppression rests on the CLIs' documented options.
2. **Codex project configuration and skills** in the worktree: [runtime follow-up](../runtime-followups.md#codex-project-configuration-and-skills-in-a-governance-edit-worktree), before slice 6. Resolved by [provider worktree isolation](provider-worktree-isolation.md): every step of every task now runs isolated from the worktree.
