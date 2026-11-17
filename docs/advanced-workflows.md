# Durable project workflows

Projects can install release, evaluation and maintenance graphs alongside development flows. These use the same canonical jobs, pinned configuration/executor, supervised attempts, question subjects, cancellation, uncertainty and history. They do not run inside the console or a conversational host.

`integrationAdapters` maps stable names to trusted `argv`, an output JSON `schema`, and an `effect` classification (`read`, `write`, or `paid`). Optional `files:[{path,digest}]` pins implementation files by SHA-256; use it for scripts outside the tracked integration checkout. The checkout identity is pinned when the workflow is admitted. Changes require a new installation/grant. Adapter output is namespaced evidence and cannot set factory health, workspaces, sessions or other built-in results.

`integrationWorkflows` maps names to `{kind, singleton, workflow}`. Kinds are `release`, `evaluation`, or `maintenance`; singleton defaults to the workflow name. Graphs are finite DAGs. Effects call `integration.run` with an installed adapter; mutating steps name an earlier role-bound decision through `action.authorization`. Operator authority is the default; nonpaid writes may explicitly delegate a question to `orchestrator` with `authorizedRole:"orchestrator"`, or use `authorization:"grant"` for writes authorized by the installed job/schedule grant. Read-only timer nodes may wait for a persisted result date, bounded to 36 hours. Waiting never replays a paid journey.

Install configuration through the normal configuration command and recommission. Enqueue a named graph through the existing canonical job API:

```sh
node factory/cli.mjs maintenance enqueue --actor operator --state /private/project-state \
  --operation workflow:weekly-release --note 'Start the configured release rehearsal' \
  --payload '{"candidate":{"head":"EXACT_COMMIT_SHA"},"capMicros":0}'
```

A job grant authorizes admission. Nonpaid writes require a candidate-bound decision unless the installed node explicitly selects grant authorization. Paid adapters always require a separate candidate-bound operator cap decision; neither orchestrator delegation nor a job grant grants spending authority. Decisions bind the reviewed result digests as well as the candidate, configuration and workflow. An explicit nonpaid grant node instead authorizes the installed graph’s future `requireResults` pass conditions; it does not pretend those later results were already reviewed. The web inbox displays the candidate, cap, allocations and retained evidence. Changing those inputs invalidates the question. Release singleton ownership does not consume change capacity or prevent ordinary maintenance from running; project adapters must coordinate any shared external environment.

## Scheduled tasks

For a command that should run on a schedule and tell you when it fails, such as a link check, use `scheduledTasks` rather than an adapter and integration workflow:

```json
"scheduledTasks": {
  "source-link-check": {
    "description": "Weekly check of research source links",
    "command": ["node", "research/scripts/check-links.mjs"],
    "schedule": {"type": "weekly", "timeOfDay": "21:00", "timezone": "America/New_York", "weekdays": [0]},
    "timeoutMs": 600000,
    "network": true
  }
}
```

- **Schedule:** `{"type":"interval","everyMs":…}` (at least a minute), `{"type":"daily","timeOfDay","timezone"}` or `{"type":"weekly","timeOfDay","timezone","weekdays":[0-6]}`, where 0 is Sunday.
- **Each run:** a supervised maintenance job runs the command in a fresh, owned checkout of the target's current remote head, with `PATH`, `HOME` and `LANG`. The run is bounded by `timeoutMs` (default 10 minutes, at most an hour).
- **Outcome:** exit 0 completes quietly. Any other exit sends **one** notice (to the `orchestrator`, or set `"notify": "operator"`) carrying the description, exit code, target head and the captured stdout/stderr. The notice holds the last 6 KB; the full report is kept in the run's `report.json`. If the command can't be run at all, for example because the fetch fails, the notice says so.
- **Read-only by default:** if the command leaves changes in its checkout, the checkout is kept and an obligation asks someone to inspect it. Anything that should change the project goes through tasks and flows. `network` records whether the task needs the network; it isn't enforced.
- **Managing them:** they're defined in configuration (`config update` + doctor). Each one becomes a schedule `task:<name>` that `schedule.put` and `schedule.remove` leave alone. Set `"enabled": false` to pause one.
- **In the console:** Settings → Scheduled tasks shows each task's schedule, last outcome, last report and a **Run now** button. Run now is `job.enqueue` with `operation: "scheduled:<name>"`, and it's delegable.

## Not-before times and recurring tasks

**A task that must wait until a time** gets a `notBefore`: an absolute time with an offset, such as `"2026-10-26T09:00:00-04:00"`. Set it:
- in a brief (`factotum-task` block or a command source row),
- in the console task form, or
- with `task.schedule` (`{"taskId": "…", "notBefore": "…"}`, or `null` to clear it).

An approved, queued task stays queued until that time, with the reason `scheduled: not before …`, and is then admitted normally. Nothing runs early, so a task waiting for its time never blocks an upgrade. The time is scheduling, not part of the brief: changing it keeps approval. A source re-import only changes it when the source item itself changed, so a time set in the console survives routine syncs.

**Work that repeats on a cadence**, such as a weekly deploy, is a recurring task:

```json
"recurringTasks": {
  "publish-day": {
    "schedule": {"type": "weekly", "timeOfDay": "09:00", "timezone": "America/New_York", "weekdays": [1]},
    "task": {"title": "Publish-day deploy", "doneWhen": "The site serves this week's build", "workflow": "orchestrator-task", "labels": ["deploy"]}
  }
}
```

- **Each occurrence is a new task**, for example `recurring:publish-day:2026-10-26`. It is approved by the commissioned configuration and queued, so with `policy.autoQueue` its question wakes the orchestrator at the scheduled time.
- **Task workflows only.** `task.workflow` must name a `task`-kind workflow in the catalog. Commissioning rejects a change workflow.
- **No overlap.** If the previous occurrence is still open (queued or running) when the next one comes due, that occurrence is skipped and one notice says why (to the `orchestrator`, or `"notify": "operator"`).
- **Task fields:** `title` (or `outcome`, as in a brief), `doneWhen` or `acceptance`, `workflow`, and optional `labels` and `description`.
- **Schedules** take the same forms as `scheduledTasks`. Set `"enabled": false` to switch one off in configuration.

**The Scheduled tab** lists everything with a time ahead of it, soonest first: tasks with a not-before time, recurring tasks, scheduled tasks and maintenance schedules. Each row shows the next time, the last outcome and actions:
- **Run now** creates a recurring task's occurrence immediately (`recurring.run`, refused while one is open) or runs a scheduled task or maintenance operation (`job.enqueue`).
- **Pause / Resume** (`schedule.pause`) holds a scheduled or recurring task until it is resumed. The pause survives configuration updates, and missed times aren't made up. Other schedules use Disable (`schedule.remove`).
- **Edit time** changes a task's not-before time. The times of recurring and scheduled tasks are changed in the configuration.

All three commands are delegable.

## Read-only maintenance workflows

A `maintenance` workflow whose every step uses a `read` adapter is an observation, such as a link check or an audit. It gets three conveniences:

- **No candidate needed.** A job or schedule without `payload.candidate` is bound to the checkout's current head at admission, and that head is recorded in the flow. Workflows with writes or spending still require an explicit candidate.
- **A pass completes quietly**, with no flow notice.
- **A failure arrives once, with evidence.** When a step returns `route: "fail"` and the graph ends `failed`, the flow notice carries the step's `summary` and its `observations` (or `outcomes`, or the full adapter result), up to a bounded size.

A job that can't be admitted, for example because the project isn't commissioned, fails with a `reason`. It doesn't fault the operations loop.

Example: a weekly link check.

```json
{
  "integrationAdapters": {
    "link-check": {
      "argv": ["node", "project/integrations/source-link-check.mjs"],
      "effect": "read",
      "schema": {"type": "object", "required": ["route"], "properties": {
        "route": {"type": "string"}, "summary": {"type": "string"},
        "observations": {"type": "array", "items": {"type": "object", "required": ["id", "status"], "properties": {"id": {"type": "string"}, "status": {"type": "string"}, "url": {"type": "string"}}}}
      }}
    }
  },
  "integrationWorkflows": {
    "source-link-check": {"kind": "maintenance", "workflow": {"version": 1, "start": "check", "nodes": {
      "check": {"kind": "effect", "action": {"operation": "integration.run", "adapter": "link-check", "stage": "link-check"}, "timeoutMs": 600000, "next": "done", "onFailure": "failed", "resultEdges": {"pass": "done", "fail": "broken"}},
      "done": {"kind": "end", "outcome": "completed"},
      "broken": {"kind": "end", "outcome": "failed"},
      "failed": {"kind": "end", "outcome": "failed"}
    }}}
  }
}
```

Schedule it weekly (Sunday 21:00 New York):

```json
{"schedule": {"id": "source-link-check", "operation": "workflow:source-link-check", "type": "daily", "timeOfDay": "21:00", "timezone": "America/New_York", "weekdays": [0], "enabled": true, "payload": {}}, "note": "Weekly source link check"}
```

## Adapter protocol

The adapter receives one JSON object on stdin with `version`, stable `operationId`, `candidate`, `candidateDigest`, `workflowDigest`, `stage`, approved `payload`, previous `results` and applicable `authorization`. It returns one JSON object on stdout; diagnostic stderr is retained privately. Execution is bounded by the node timeout and output size. An adapter may declare its own `timeoutMs` (1,000 ms to 58.5 minutes): it then runs under that limit, cut short to the step's time left after any heavy-work permit wait, and configuration validation refuses a step that runs it with a `timeoutMs` below the adapter's plus 90 seconds. `releaseWorkflow({..., adapters})` and `evaluationWorkflow({..., adapters})` size each step that way from the project's `integrationAdapters`; without an adapter `timeoutMs` a step keeps the 10-minute default. A read-only adapter that reaches its limit is still an uncertain attempt: its `effect: "read"` is the project's declaration, which the factory cannot prove. Credentials belong in private project/provider arrangements, never in committed configuration or returned evidence.

The output requires `route:pass|fail|unknown|waiting`. `unknown` becomes an uncertain attempt and is never replayed automatically. `waiting` requires an ISO `until` and an explicit timer/reassessment path in the graph. Other fields must satisfy the installed schema. A nonzero exit, malformed response or lost response after a write is ambiguous; inspect and reconcile before continuing.

Saved-state probes return `savedItems:[{id,digest}]`. Every original identity/digest must survive the post-deploy probe; additional items are permitted. Both inventories need unique nonempty identities and digests. A project must prove its probe enumerates all required saved data, artifacts and relationships; a checksum comparison cannot detect omissions from the inventory.

Journeys return `observations:[{id,status,...}]`. Independent readers return `outcomes` covering the same identities. Infrastructure, untested and deferred observations cannot establish product pass/fail. A failed infrastructure disposition stops the series. Use project schemas to constrain statuses, evidence and coverage further.

`evaluationWorkflow()` compiles controls → spending approval → serial journeys/reads → combined judgment → report approval/publication without deployment stages.

## Release builder

`releaseWorkflow()` in `workflows/integrations.mjs` compiles a reference graph:

1. Rehearse the exact candidate and graph without paid execution.
2. Capture saved-state inventory.
3. Obtain operator approval for candidate and cap.
4. Deploy once, then compare saved state and smoke test.
5. Run each journey and an independent read before the next journey.
6. Judge the combined observations, then obtain report approval before publication.

Preservation or smoke failure opens a decision. A rollback option exists only with a separately configured adapter and explicit compatibility declaration. Unknown deployment or rollback outcomes require reconciliation; they are not retried. An installed `lookupAdapter` must be read-only and prove the original operation ID, candidate digest and applied result. The ordinary `reconcile` command can then settle the original uncertain attempt from that lookup. Paid lookup does not settle its financial reservation; `spending.reconcile` remains a separate explicit inspection.

Journey entries can be adapter names or `{adapter, reader, budgetKey, wait:{reassess,maxWaitMs}}`. A waiting read freezes its original deadline, then uses a separate read-only reassessment adapter. It never invokes the original paid journey again. A further unresolved result requires explicit disposition. Product-specific report PR creation, review and merge can be separate installed stages; the generic graph does not silently grant repository writes.

## Opt-in paid adapters

Paid execution defaults off. It requires `spending.enabled:true`, a private shared `spending.coordinatorPath`, a positive operator-approved `capMicros`, and an adapter ceiling plus `enforcement:{enforceableCeiling:true,qualificationDigest}`. Provider CLI roles remain subscription-backed. No metered model route is implicitly enabled by this facility.

The shared ledger serializes paid dispatch across projects. Reservations count before dispatch; unknown charges remain reserved even after a process dies. Actual charges need a cost receipt and the adapter's enforced ceiling. An independent read releases the review hold. Per-journey `budgetKey` uses the approved `allocationsMicros` mapping in addition to the overall cap. An overrun holds global paid dispatch.

The project adapter must enforce the provider-side ceiling and its qualification digest must identify real installation evidence. Declaring a ceiling in configuration is not evidence that an external provider honors it. The reference's tests use fictional receipts and do not qualify any real paid provider. Our live qualification uses subscription CLIs only.

For a stopped, quiescent paid flow, `spending.reconcile` records explicit operator inspection with reservation `id`, `actualMicros`, cost `receiptDigest`, independent `reviewDigest` and `note`. Overrun recovery also requires a sufficient explicit `newCapMicros`. Known charges cannot be rewritten. This releases financial holds; it does not invent a successful deployment/journey result or resolve its uncertain attempt. Use the existing typed/explicit attempt reconciliation separately.

Back up the shared ledger separately from each project's state. Restore holds must remain until shared spending, external effects and local receipts agree. No console aggregate is a spending authorization.
