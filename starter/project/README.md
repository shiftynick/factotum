# Project customization

Copy the starter into the project's repository. Record `VERSION` and local customizations in normal change history. Initialize a fresh project identity and private state outside the checkout; keep account identities, tokens, webhook material and private absolute paths in local configuration.

## Ownership and extension policy

Follow [the core ownership instructions](../factory/AGENTS.md). If the installation sits under a folder (`factotum.lock.json` records it as `prefix`), every `factory/` and `project/` path here is under that folder, and paths in the project configuration, which are relative to the repository root, include it. Treat all of `factory/`, including its built-in adapters, as upstream-owned. Make project-specific Factotum changes only in project-owned configuration, checks, governance and integrations outside that directory. Prefer `project/integrations/` for custom scripts and connect them through the documented extension points. Application development continues in normal application files.

Keep `factory/AGENTS.md` as required governing context alongside the project's own rules, and record this ownership boundary in the project's root agent instructions. If a needed capability requires changing the core, report it to the operator and propose an upstream fix in the reference checkout. Adopt the resulting reviewed release; do not patch or monkey-patch the vendored copy or hand-edit its version/lock metadata to hide drift.

## Optional project agent skill

Copy the entire [use-factotum skill folder](skills/use-factotum/SKILL.md) from `project/skills/use-factotum/` into the project's existing agent skills directory, following that agent's discovery convention. Keep the folder name `use-factotum` and its `SKILL.md`. It is an example for project-local use, not an automatic global skill installation.

The companion [factotum-workflows skill](skills/factotum-workflows/SKILL.md) covers creating, selecting and commissioning project-owned workflows, per-step models and delegated merge decisions. Install it the same way, keeping the folder name `factotum-workflows`.

The optional [factotum-compound skill](skills/factotum-compound/SKILL.md) helps the orchestrator decide what knowledge upkeep's capture candidates (a fast-check change, a governing rule or a learning) should become, and act on them with the factory's commands. Install it the same way, keeping the folder name `factotum-compound`. Factory steps never load it: every provider step runs with every skill disabled, and a flow's agents get what they must do from their task. [LEARNING.template.md](LEARNING.template.md) shows the layout of a learning file (`learnings.dir`); upkeep writes learnings in exactly that layout.

Adapt the copied skill with the project's configuration/state locations, integration mappings and operating conventions. Keep credentials and private configuration outside tracked skill content. Retain the upstream ownership rule: customize integrations outside `factory/`, propose core fixes upstream, and adopt reviewed releases. The copied skill is project-owned; release updates preserve it and do not automatically synchronize upstream skill revisions. The skill supports Factotum-specific work without changing the workflow for unrelated application tasks.

## Suggest upstream changes

Copy [UPSTREAM_FEEDBACK.template.md](UPSTREAM_FEEDBACK.template.md) into a project-owned report or issue/PR draft. It captures the installed release, expected/observed behavior, minimal reproduction, evidence and recovery state, extension points considered, proposal and validation. Bugs do not require an implementation proposal. Keep original evidence private and use sanitized fictional reproductions for upstream reports. Publish only within the operator's authorized scope; keep core fixes separate from downstream integration work.

If a Factotum problem stops this project's delivery, mark the report **Blocking** (the orchestrator or the operator may do so; the operator may downgrade it) and send it to the Factotum maintainers' channel. Blocking reports are triaged ahead of other Factotum work in the same session; meanwhile keep the project's own state intact and record any workaround.

## Configure delivery

Copy `factotum.template.json` to a private configuration file outside the repository checkout (for example `/private/config/example.factotum.json`, mode 0600; see where it lives (`docs/adoption.md#copy-and-configure` in the Factotum reference)) and replace the fictional repository/account and absolute resource/backup locations. Choose explicitly approved provider models and subscription authentication. The template's model defaults are Claude Opus 5.5 (`claude-opus-5-5`) for planning and building and GPT-6.1 Sol (`gpt-6.1-sol`, Codex) for review, with Claude Fable 5.2 (`claude-fable-5-2`) in the Claude roles' `allowedModels` for the most important or complex work: choose it per task with `task.models` (see project workflows (`docs/project-workflows.md#per-task-models` in the Factotum reference)). Same-family review is allowed and recorded. The template defaults to one active flow, reviewed planning, no factory-file edits and manual merge decisions. Source issue closure is disabled until the project chooses complete-task delivery semantics.

The baseline and acceptance commands deliberately throw errors. Replace them with trusted argv arrays running real project checks. The required `project/GOVERNANCE.md` must exist and contain the project's applicable rules, or be replaced with the actual required context entries. Missing governance, failed verification or unsupported provider capabilities cannot silently pass `doctor`.

Use `mainChecks` to prove the current target's baseline and `checks` to prove each final candidate. Specify `{id,argv,timeoutMs}` for every required check. Commands and optional `workspace.setup` argv arrays are trusted installation code; issue text never defines executable workflow commands. Each setup command is stopped after `workspace.setupTimeoutMs` (default 30 minutes, at most 4 hours); a setup that takes longer, such as a cold dependency install on a slow host, needs it raised. Configure reproducible dependencies and `user.name`/`user.email` locally in the repository. Delivery binds API and Git network operations to the configured GitHub account. Approved SSH/HTTPS remote spellings are validated and rewritten to canonical HTTPS per invocation without changing stored remotes. Credentials are private network-child environment values, never provider/check inputs. Remove local credential/HTTP/URL transport overrides; scoped Git ignores global/system configuration and disables hooks/signing. A global active GitHub account or SSH identity cannot silently select delivery credentials.

Optionally move rules a script can decide out of review with `fastChecks`. They run on the built candidate before review; a violation goes back to the builder with the script's diagnostics, and reviewers are told not to raise the listed `rules` for a candidate on which the checks passed:

```json
"fastChecks": {
  "checks": [
    {
      "id": "tests-with-source",
      "argv": ["node", "project/integrations/fast-check.mjs"],
      "timeoutMs": 30000,
      "holdExitCodes": [78],
      "rules": ["A change that edits src/ also changes the tests under test/"]
    }
  ]
}
```

Copy `integrations/fast-check.example.mjs` to `project/integrations/fast-check.mjs` and replace its rule with the project's own. Each check may take at most 5 minutes and all of them 10 minutes; set `"heavy": true` if they need the shared heavy-work permit. Leave `fastChecks` out until a project has such a rule: without it the workflow is unchanged.

If the full baseline is too slow to run after every merge, split `mainChecks` into tiers. Checks with `"tier": "scheduled"` run only in a full verification (a `main.verify` schedule, a manual `main.verify`, or doctor); the rest run after every merge. Keep at least one check in the merge tier:

```json
"mainChecks": [
  { "id": "unit", "argv": ["npm", "test", "--", "--fast"], "timeoutMs": 600000 },
  { "id": "full-suite", "argv": ["npm", "run", "test:all"], "timeoutMs": 2700000, "tier": "scheduled" }
]
```

Schedule the full verification (for example daily with `schedule.put`, operation `main.verify`). A failing scheduled check turns main red and stops admission until a later full verification passes; a passing merge-tier check does not clear it. Scheduled-tier evidence older than `policy.scheduledHealthMaxAgeMs` (default 26 hours) also holds admission, so schedule it more often than that. Leave `tier` out and every check runs after every merge, as before. See main-check tiers (`docs/operations.md#main-check-tiers-after-every-merge-or-scheduled-only` in the Factotum reference).

Run `doctor` while the runner is stopped and the project checkout is clean and matches remote main. It verifies installed provider capabilities and subscription routing, repository permissions, required context and actual baseline checks. Repeat after changing configuration, tools or authentication. A passing doctor does not qualify automatic merge.

## Describe and approve work

`task.example.json` is a payload for `task.put`. Replace its fictional outcome and acceptance. Alternatively import a GitHub issue with the versioned fenced brief described in the GitHub guide (`docs/integrations/github.md` in the Factotum reference). Approve the returned canonical task revision separately. Editing the brief invalidates prior approval and fences affected work. Delivery `flow.start` requires that exact current revision.

Record where each task came from in its optional `originalRequest`: `origin` (`operator`, `incident`, `schedule`, `review` or `other`), `source` (where it was received), `date`, and for an operator request the operator's exact words in `text`. Copy the words; do not summarize or improve them, and keep the derived acceptance list separate. A task that came from an incident, a maintenance schedule or a review records that origin and has no operator quotation; never invent one. The original request is provenance, not approval: it does not approve the task, grant anything, or answer a decision, and planners, builders and reviewers see it labelled that way. It is part of the approved brief, so editing it creates a new revision that needs approval again. Leave it out when the origin is not known rather than guess.

For ordinary delivery, use `{taskId,revision}`. Two explicit alternatives are available:

- Existing PR: add `candidate:{number,head,base}` containing approved exact commit identities. Factotum copies that candidate into a new owned branch, publishes a replacement PR, and retains original PR disposition as a pending operator obligation. It never overwrites the original branch. The external builder is unknown, so the implemented adoption path always requires manual adjudication.
- Already satisfied: add `alreadySatisfied:true`. The target receives fresh review and configured verification, followed by explicit operator acceptance and a current remote-target check. No fabricated merge receipt represents this outcome.

These alternatives cannot be combined. A normal builder returning no changes does not silently close a task as already satisfied.

## Operations and limits

Use the shared console or canonical CLI commands for approval, answers, pause/stop, recovery and operation history. Each project owns its authority, state and credentials independently. CLI actor names provide role validation under the trusted local-account model; they are not OS authentication. Subscription provider permissions are recorded, and worktrees/prompt roles are not a hostile-code sandbox.

Keep automatic merge disabled until the project's remote strict-check mechanism has been behaviorally qualified. Expected-head merging protects the PR branch but leaves a target race on an unqualified manual path. GitHub closing-reference checks protect publication and commit prose; trusted users can still create separate side effects through GitHub's own interface. Task closure rereads the source but cannot make the remote read/write pair atomic.

API-metered providers and paid evaluations remain disabled. Configure backup/restore, retention inventory and any optional release/evaluation adapters deliberately. Drain work and retain the original executor for recovery before upgrading. The `workflow.template.json` remains available for a synthetic rehearsal; its arbitrary commands do not qualify a real provider or forge.

See Factotum's running guide (`docs/running.md`), adoption guide (`docs/adoption.md`) and qualification record (`docs/qualification.md`) in the Factotum reference; they are not installed into the project.

## Optional T3 notification guide

`integrations/t3-notifications.example.md` is a starting point for a project's T3 webhook handling guide. Copy it to `project/integrations/t3-notifications.md` and follow the template note at its top: replace every `[[…]]` placeholder it lists, keep or delete its optional sections, and delete the note. The proxy guide below is filled in the same way. The guide reads state with `status --inbox/--flow/--task`; on a release before dev.82, which lacks those, also copy `integrations/factotum-state.example.jq` to `project/integrations/factotum-state.jq` and read the full `status` output through it. Wire the webhook by following the setup steps in `docs/integrations/t3.md` in the Factotum reference. For the recommended triage proxy thread, which receives the webhook and timer checks and forwards to the orchestrator only what needs it, copy `integrations/t3-triage.example.md` to `project/integrations/t3-triage.md` and `integrations/triage.example.mjs` to `project/integrations/triage.mjs` (rules with no dependencies: a webhook payload in, `absorb`, `forward` or `unsure` out), and follow the triage proxy section of the same guide.
