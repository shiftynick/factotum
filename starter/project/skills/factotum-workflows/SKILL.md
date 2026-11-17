---
name: factotum-workflows
description: Create, change, select and commission this project's own Factotum delivery workflows, per-step model settings and delegated merge decisions. Use when asked to customize the factory's development process, add a workflow for a kind of task, change which model a workflow step uses, or let the orchestrator decide merges.
---

# Project-owned Factotum workflows

This is project-owned guidance. Adapt paths and conventions to this repository. Paths are relative to the repository root. Factotum's reference documentation for this feature is `docs/project-workflows.md` in the Factotum release you adopted.

## What you can and cannot change

The project owns its **process**: which steps run, their order, names, retries, extra checks and questions. Factotum owns the **contracts** of each operation, and enforces them whatever the graph says:

- A merge or already-satisfied outcome always needs a current decision and fresh evidence for the exact candidate. The evidence required is set by the commissioned `requirements` configuration (default: `review` and `gate`), not by the graph.
- Only `provider.review` and `forge.followup` produce `review` evidence, and only `gate` produces `gate` evidence. A shell command can never stand in for them.
- Review, gate and planning steps always keep the candidate unchanged; `gate` always takes a heavy resource lease. Setting those flags to `false` fails commissioning.
- Fields such as `merged`, `mainHealth`, `workspace` and `proven` count only from the operation that owns them.
- Who may decide a merge is capped by `policy.mergeDecisionRole`. A graph can request less authority, never more.
- A plan question (a question the plan step's results route to) may offer `"proceed"`, but only to the step the plan's `ready` route goes to; the factory offers it only for a plan marked ready, and lists the planner's questions in the item. The first three replans after answers to a plan question in a plan cycle do not count against `plan.maxVisits`; later ones do, and none extends a bound. Your graph's own `maxVisits` values are kept across upgrades (the reference allows three plan attempts from dev.82).

Never edit anything under `factory/`. Workflow files live outside it (conventionally `project/workflows/`). If `factotum.lock.json` records an install `prefix`, these are `<prefix>/factory/` and `<prefix>/project/workflows/`, configured workflow paths include the prefix (they are relative to the repository root), and the CLI is `node <prefix>/factory/cli.mjs`. If something you need is impossible without a core change, report it upstream rather than working around it.

## Create or change a workflow

1. **Start from the reference.** Export the standard graph compiled for this project's configuration:
   `node factory/cli.mjs workflow export --state <project-state> --out project/workflows/<name>.json`
   Prefer editing a copy of the reference over writing a graph from scratch.
2. **Edit the graph.** It is JSON: `{"version":1,"start":"<node>","maxTransitions":N,"nodes":{...}}`. Node kinds:
   - `effect`: runs `{"action":{"operation":"..."}}` with `timeoutMs`, `next`, `onFailure` and optional `resultEdges` mapping result routes to nodes. A trusted command uses `argv` instead of `action`.
   - `question`: `role`, `question`, `answers` mapping each answer to a node, and optional `requireEvidence`. Mark the merge question with `"mergeDecision": true`.
   - `wait`: a bounded timer.
   - `end`: `outcome` is `completed`, `failed` or `stopped`. A `completed` end does not prove anything by itself; a change flow completes only after a proven merge or accepted satisfied outcome.
3. **Keep behaviour tied to operations, not names.** You may rename and reorder nodes freely. If an operation can fill more than one result slot, choose with `"binding"` (for example a second review used for already-satisfied tasks takes `"binding": "satisfied-review"`). Keep `resultEdges` for every route an operation can return. Copy them from the reference: for example `source.verify` returns `ready`, `planned`, `candidate` or `satisfied`, and `provider.review` can return `pass`, `revise`, `delta`, `defer`, `adjudicate` or `park`.
4. **Bound every loop.** Any cycle must pass through a node with `maxVisits`. Commissioning rejects unbounded cycles.
   **Publish only what was integrated.** Every route into `forge.publish` must come from the `integrated` result of a `workspace.integrate` step (or its `next` when it has no `resultEdges`), through input-preserving steps only: review, gate, fast checks, preview, or a trusted command marked `"preserveInput": true`. A builder, question, wait or ordinary command in between, a conflict or failure route into it, or no integration at all is refused at commissioning.
5. **Add project checks as observations.** A trusted command may declare `"evidence": "check:<name>"` (any `prefix:name`). Questions can require it with `requireEvidence`. It never satisfies `review` or `gate`.
   Configured `fastChecks` run through a `fastCheck` node (the reference places it between `integrate` and `publish`). It must route `pass` and `fail` explicitly (`fail` normally to the builder), may declare a `prefix:name` observation, and never produces `gate` evidence. See fast checks (`docs/project-workflows.md#fast-checks-before-review` in the Factotum reference).
6. **Commit the file** through the project's normal reviewed change process.

## Select and commission

Add or update the catalog in the project configuration:

```json
"workflows": {
  "definitions": {
    "change": {"path": "project/workflows/change.json"},
    "content": {"path": "project/workflows/content.json"},
    "standard": {"reference": "change.standard"}
  },
  "selection": {"default": "change", "rules": [{"category": "content", "workflow": "content"}]}
}
```

- Selection is by task `category`. One rule per category; unmatched tasks use `default`.

Then, with work drained:

1. `node factory/cli.mjs config update --actor operator --state <project-state> --config <file> --note "<reason>"`
2. `node factory/cli.mjs doctor --state <project-state>`
3. `node factory/cli.mjs workflow list --state <project-state>` to confirm the commissioned definitions, their digests and that `drift` is empty.

`config update` compiles each graph once and pins the file's bytes. Editing the file afterwards changes nothing until the next `config update`; until then, admission refuses new work and says the file changed.

## Approvals

Approving a task records the workflow selected for it. If the selection or the commissioned graph changes before the task starts, it must be approved again. After first adding a catalog, re-approve tasks that were already approved. The Tasks view shows each task's selected and approved workflow.

## Task workflows (no build)

For work that isn't a code change, such as a deploy, a message, an account setup or a decision, use a `task` workflow. Add the references `task.orchestrator` and `task.operator` to the catalog and select them by label (`{"label": "orchestrator", "workflow": "orchestrator-task"}`) or by the brief's `workflow` field.
- **When the question arrives:** the orchestrator carries the task out and answers **done**, **blocked** (always with a note) or **stop**.
- **Never answer as the operator.** An operator-task question belongs to the operator.
- **Capacity:** task flows have their own capacity, `policy.maxTaskFlows`, and never take a build slot.
- **Briefs:** a brief can be lightweight: `{"version":1,"outcome":"…","doneWhen":"…","workflow":"orchestrator-task"}`. Imported from a GitHub issue, the issue title is the task's title and a longer `outcome` is shown to agents as `Outcome: …` beneath it.
- **Timing:** for work due at a time, add `"notBefore": "<time with offset>"` to the brief rather than relying on an outside timer. For work that repeats, add a `recurringTasks` entry to the configuration. Both show in the Scheduled tab.

## Document workflows (review only)

For work that produces a document, such as research, a proposal or a guide, add `{"reference": "change.document"}` to the catalog and select it by label (`{"label": "research", "workflow": "research"}`) or by the brief's `workflow` field.
- **What it does:** plan (under `policy.planning`), write in a worktree, review, then a merge decision. There is no check gate, so the merge needs only a passing review.
- **Capacity:** document flows have their own capacity, `policy.maxDocumentFlows` (default 2), but still need green main and can't overlap a running change's paths.
- **Where the document goes:** say so in the brief's acceptance criteria or `paths`.
- **Branch protection:** if the target branch requires the `factotum/gate` status, the merge is refused; tell the operator instead of working around it.

## Per-step models

Read `status --state <dir>` → `settings.stepModels` for the commissioned workflow and step IDs, current provider/model/effort and source. Use `settings.modelSettingsVersion` for default edits.

- For a persistent default, send `models.update {workflow, changes: {stepId: {model, provider?, effort?} | null}, expectedVersion, note}`. `null` restores the project-config/role default. Use `--actor orchestrator --instruction "<actual standing or specific operator instruction>"`; the existing delegation policy must include `models.update` (it does by default). Never misattribute the command as the operator.
- For one task, send `task.models {taskId, models: {planner?, builder?, reviewer?: {model, provider?, effort?}} | null, note?}` as orchestrator. It applies to every step of that role in the task's next flow, is not part of the brief (approval is kept) and needs no instruction or grant. A model outside the configured providers or their `allowedModels` is refused; that is a configuration change for the operator. Use a stronger model such as `claude-fable-5-2` for the most important or complex work.
- For one run, send `flow.start {taskId, revision, modelOverrides: {stepId: {model, provider?, effort?}}, note?}` as orchestrator. `task.restart` accepts the same map. Overrides cannot select a different workflow or bypass task approval. For a built-in audit use `job.enqueue {operation: "audit", modelOverrides: {run: {model}}, note}` with normal maintenance authority.
- Precedence: run override → task choice → saved default → project `stepModels` → provider role. Omitted fields inherit; `effort: null` clears inherited effort. Switching providers drops inherited effort and fallback. Model allowlists, configured provider boundaries and subscription billing still apply. Builder and reviewer may come from the same model family; review evidence records the pairing.
- Defaults apply to newly admitted flows only, require no drain or doctor, and survive upgrades. Running flows, retries, replans and resumed sessions retain pinned routes. Inspect `flow.modelSelection` and actual attempt results. Provider capability/authentication preflight still runs before invocation; saving a model identifier is not qualification of that model's availability.
- The operator can edit any model step in Settings → Models. Checks, questions, waits and arbitrary commands have no factory-selected model. Workflow names come from the catalog (`standard` without one); the built-in audit is `maintenance/audit`, step `run`.
- Keep reviewed file defaults in project `stepModels`, using normal `config update`/doctor. `config show` exports effective defaults. `config update` keeps saved model defaults unless `--replace-live` is explicit. Reset defaults before removing/renaming their workflow or step, or explicitly replace live settings.

## Delegated merge decisions

To let the orchestrator decide ordinary-risk merges without per-candidate operator approval:

1. Set `"policy": {"mergeDecisionRole": "orchestrator"}` (the commissioned maximum).
2. Put `"role": "orchestrator"` on the graph's `mergeDecision` question (the request; the supplied reference does this from the policy).
3. Recommission.

The orchestrator then answers that question as `orchestrator`, never as the operator. Each answer covers only the exact candidate it was asked about. Strict-risk candidates and adopted external PRs still go to the operator, and the operator can always answer, stop or revoke. An adopted PR's merge question is refused to the orchestrator even on a recorded operator instruction; ask the operator to answer it. This is not automatic merge: someone still answers every merge question.

## Troubleshooting

- `workflow <name>: ...` during `config update`: the graph failed validation; the rest of the message names the node and rule.
- `requests orchestrator merge decisions ... does not delegate them`: set `policy.mergeDecisionRole` or change the node's role to `operator`.
- `... changed since commissioning; run config update`: a workflow file differs from its commissioned bytes.
- `approval does not cover selected workflow ...`: approve the task again.
- `fresh review evidence required` at a merge: the graph reached the merge without a passing review of the current candidate.
