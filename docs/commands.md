# Commands: console and CLI parity

Every action in the web console is a canonical project command. The console sends it to the project service; an agent can send the same command with the CLI:

```sh
node factory/cli.mjs command --state <state> --actor orchestrator --operation <operation> --payload '<json>'
```

Commands are recorded with their actor in the command history and events. Use `--file <payload.json>` for larger payloads.

## Who is acting

Every command-executing CLI call (`command`, `config update`, `maintenance enqueue`, `cleanup apply`, `cleanup archive-drop apply`, `cleanup archive-slim apply`, `upgrade apply`, `import-task`) requires `--actor operator` or `--actor orchestrator`. There is no default identity. `import-task` is recorded as a `task.put` by that actor, with `--instruction`/`--reference` and the same authority rules. Every subcommand prints its usage and options with `--help` (for example `node factory/cli.mjs config update --help`) without running anything; `command --operation <name> --help` describes one operation's payload.

## Acting on an operator instruction

Operator and orchestrator work as a team: the orchestrator can carry out any operator command when the operator asks. It acts as itself and records the instruction. It must never use `--actor operator`.

```sh
node factory/cli.mjs command --state <state> --actor orchestrator --operation schedule.put --payload '<json>' \
  --instruction 'Operator in thread: "change the sync to every six hours"' --reference '<link to the message>'
```

The command is attributed to `orchestrator` with `onBehalfOf: {principal: "operator", instruction, reference}` in its receipt and event, and in merge authorizations, integration decisions, job grants and cleanup records. An instruction is always required, and it is a record of what the orchestrator was told rather than proof.

Every operator command is delegated by default. That includes `config.update`, `restore.release`, `attempt.resolve`, `spending.reconcile`, `cleanup apply`, and answers to operator questions, including ordinary merge and already-satisfied decisions. To narrow it, list operations in `policy.delegatedOperations`; `[]` turns delegation off.

Two checks are kept by the operator's decision:

- **Strict-review sign-off stays with a human.** Strict changes (access control, saved data, spending, security boundaries) need the operator to read the exact candidate and its threat model, so an instruction cannot stand in for that. `policy.strictDecisionRole` remains the explicit way to assign it.
- **Deploy and spending approvals** (integration decisions) stay with the operator unless `policy.delegateIntegrationDecisions` is `true`.

A third holds by design: **an adopted pull request's merge question is the operator's alone.** Its original builder is unknown, so adoption always needs manual adjudication. The orchestrator's answer is refused (`an adopted pull request's merge question is answered by the operator only…`) with or without a recorded instruction, whatever `policy.delegatedOperations`, `policy.mergeDecisionRole` or `policy.strictDecisionRole` say; the refusal leaves the question open and unchanged. The merge step rechecks that the authorization came from the operator.

A fourth is an operator decision too: **`cleanup archive-drop apply` and `cleanup archive-slim apply` are operator only.** They delete or rewrite archives, so they are not in the delegable list and `policy.delegatedOperations` cannot name them; the orchestrator's attempt is refused with or without an instruction. See [workspace cleanup](workspace-cleanup.md#slimming-existing-archives).

## Reference

| Console action | Operation | Who may run it |
| --- | --- | --- |
| Availability (here/away) | `operator.presence` | operator, or delegated |
| Add an inbox item | `inbox.publish` | operator or orchestrator |
| Withdraw an inbox item | `inbox.withdraw` | its publisher or the operator |
| Record that a question is also shown on a prompt channel | `inbox.present` | operator or orchestrator |
| Withdraw the prompt, keep the question | `inbox.unpresent` | its presenter or the operator |
| Acknowledge a notice | `inbox.ack` | operator or orchestrator |
| Answer a question | `answer` | the question's role (the operator can always answer); the orchestrator on instruction, except strict-review sign-off, an adopted pull request's merge question, a must-fix flow's merge or satisfied decision the decision guard returns to the operator and, unless enabled, deploy/spending approvals. A must-fix flow's question that lists findings (fixtures only until the enabling release) takes `acknowledgedFindings: [{id, claimDigest}]` naming each listed finding once; an operator-only finding needs the operator's own answer |
| Enter the operator's answer for them | `answer` with `relay {quote, channel}` (and `presentationId`) | whoever could answer without it, except the operator; stored as relayed, see [communication](communication.md#prompt-presentations-and-relayed-answers) |
| Feedback with send back / repair / retry | `answer` with `note` | the question's role |
| Acknowledge a delivery | `delivery.ack` | operator or orchestrator |
| Bind the orchestrator session (CLI only) | `orchestrator.session` | orchestrator or operator |
| Add or edit a task | `task.put` | operator, or delegated; a brief with `governingEdits` operator only |
| Approve / revoke a task | `task.approve` / `task.revoke` | operator, or delegated; approving a brief with `governingEdits` operator only |
| Start a task | `flow.start` | operator or orchestrator (needs a current approval); an optional `note` reaches the flow's planner, builder and reviewer |
| Add a note for a running flow's agents | `flow.note` | operator, or delegated |
| Replan / abandon a flow | `flow.replan` / `flow.abandon` | operator, or delegated |
| Settle one review ledger entry of a must-fix flow (fixtures only until the enabling release) | `flow.disposeFinding {flowId, findingId, disposition: operator-accepted \| operator-required, note, expectedVersion}` | operator. On a recorded instruction the orchestrator may record `operator-required` on an outcome item in ordinary work only; `operator-accepted` and every protected-class item stay the operator's. See [must-fix enforcement](risk-review.md#must-fix-enforcement-fixtures-only) |
| Tighten or lift the review restriction of must-fix flows (fixtures only until the enabling release) | `review.restrict {protectedClassDeferral?: false \| true, operatorDisposition?: all \| none, expectedVersion, note}` | operator only, directly; never delegable. Stored in project meta, not the configuration; each change raises the version, supersedes open must-fix merge and satisfied questions and refuses a decision given before it |
| Stop a flow | `stop` | operator or orchestrator |
| Pause / resume / stop all | `pause` / `resume` / `stop.all` | operator, or delegated |
| Queue order, add, remove | `queue.put` | operator, or delegated |
| Refresh issue source, verify main, dispatch queue | `job.enqueue` | operator, or delegated |
| Add, replace, disable or enable a schedule | `schedule.put` / `schedule.remove` | operator, or delegated |
| Change a task's not-before time | `task.schedule` | operator, or delegated |
| Pause or resume a scheduled or recurring task | `schedule.pause` | operator, or delegated |
| Run a recurring task now | `recurring.run` | operator, or delegated |
| Edit a task's labels | `task.label` | operator, or delegated |
| Choose a task's models (by role, next flow) | `task.models` | operator or orchestrator; configured providers and `allowedModels` only |
| Resolve an obligation | `obligation.resolve` | operator, or delegated |
| Record the task for an audit finding | `finding.accept {findingId, expectedVersion, task \| taskId}` | operator, or delegated. A docs candidate is not accepted by command: the factory makes docs follow-ups itself |
| Accept a check or learning candidate | `finding.accept {findingId, expectedVersion, files? \| paths?, approve?}` | operator, or delegated. Writes one unapproved `check` task (the declared fast-check scripts) or `learning-add` task (one learning file); `approve: true` approves it in the same step, operator only, directly. A `check` task is approved only by the operator, directly, never by delegation or a grant |
| Accept a stale-learning candidate | `finding.accept {findingId, expectedVersion, approve?}` | operator, or delegated. Writes one unapproved `learning-retire` task that may only delete that one learning file; refused unless the file is still the content `learnings.check` read and its condition still fires at the target head; `approve: true` approves it in the same step, operator only, directly |
| Accept governing-context proposals and rules | `finding.accept {proposals: [{findingId, expectedVersion, digest}]}` | operator only, directly (never on an instruction, delegation or grant). Writes one `context` task from the stored proposals and rules and approves it, in one step; refused as a whole, writing nothing, if any of them changed |
| Decline a finding, or record it as dealt with another way | `finding.resolve {findingId, expectedVersion, disposition, reason \| evidence}` | operator, or delegated; a governing-context proposal or a rule: operator only |
| Reopen a closed finding | `finding.reopen {findingId, expectedVersion, note}` | operator, or delegated; a governing-context proposal or a rule: operator only |
| Lift a knowledge upkeep suspension | `upkeep.lift {part, note, expectedAt?}` | operator only, directly: not delegable, and `policy.delegatedOperations` cannot list it |
| Record a regression | `regression.record` | operator, or delegated |
| Push back on a rule | `rule.pushback` | operator or orchestrator |
| Change a step’s default model | `models.update` | operator, or delegated; requires `settings.modelSettingsVersion`; new flows only |
| Change a live setting | `settings.update` | operator, or delegated (except `policy.delegatedOperations`, operator only, and `upkeep.mode`, which a delegate may only turn down) |
| Run doctor | `doctor.request` | operator, or delegated |
| Clear or extend a provider usage-limit hold | `provider.hold {provider, action: clear\|extend, until?, note}` | operator only, directly: not delegable, and `policy.delegatedOperations` cannot list it |

**Live settings** change with `settings.update {changes: {"policy.autoQueue": true}, expected: {...}, note}` (`null` resets to the default) without draining work or running doctor again: `policy.autoQueue`, `policy.queueOnApproval`, `policy.maxFlows`, `policy.maxTaskFlows`, `policy.maxDocumentFlows`, `policy.maxParkedFlows` (flows waiting on an answer that hold no slot, see [flow slots](operations.md#flow-slots-and-parked-flows)), `policy.mainHealthMaxAgeMs`, `policy.scheduledHealthMaxAgeMs`, `policy.mainProbeMs`, `policy.queueRanking`, `policy.categoryOrder`, `policy.categoryLimits`, `policy.delegatedOperations`, `policy.providerLimitNoticePercent`, `policy.providerLimitHoldPercent`, `policy.providerLimitDefaultHoldMs` (provider usage limits, see [providers](integrations/providers.md#usage-limits)), `notifications.level`, `notifications.handoffAfterDeliveries` and `notifications.handoffRepeatDeliveries` (operator-only), `upkeep.mode` (`off`, `observe` or `propose`; only the operator turns it up, anyone who may use `settings.update` may turn it down; see [knowledge upkeep](operations.md#knowledge-upkeep)), and `stats.pricing` (list prices for the Stats subscription estimate). Per-step models use `models.update` and per-run `modelOverrides`; see [model selection](project-workflows.md#per-step-models). Other settings change through `config update`. `config update` keeps a live value only when it was changed with `settings.update` since the last configuration update (Factotum records who changed each key and when); a key nobody changed live takes the file's value. Each kept key is reported in the result's `keptLiveDetails` (`setting`, `liveValue`, `fileValue`, `changedBy`, `onBehalfOf`, `changedAt`, and `fileChanged`: whether the file changed it too; `null` for a change made before this was recorded), and a kept value stays a live change for later updates. `--replace-live` takes the file's value for every live setting and forgets the live changes. `config update --current` (what `upgrade apply` runs to recommission) re-applies the stored configuration and keeps every live change as a live change, with its provenance (`preservedLiveSettings`; dev.89: before, it erased the provenance, so the next update from the file reverted those changes). Every live setting whose value an update changes is reported in `changedLiveDetails` (`setting`, `from`, `to`, and `lastLiveChange` when it had been changed live), with a message naming it; see [live settings after an upgrade](operations.md#live-settings-after-an-upgrade). `config update` prints one JSON receipt on stdout, with its guidance in a `messages` list. `config show --state <dir>` prints the configuration in force.

`doctor.request` asks the operations loop to run doctor for the current configuration, when it hasn't passed yet. The outcome is recorded in `meta('doctorRequest')` and shown in Settings. Doctor still needs drained work.

Not available in the console, and CLI only: `config.update`, `attempt.resolve`, `restore.release`, `spending.reconcile`, `cleanup apply` and `main.health`. All of them can be delegated. `cleanup archive-drop` and `cleanup archive-slim` are also CLI only, and are never delegated.
