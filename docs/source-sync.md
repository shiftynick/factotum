# Issue source synchronization

A delivery project can discover and refresh tasks through the `source.sync` maintenance operation. The Tasks view’s **Refresh from source** enqueues the same job. Viewing a page alone has no side effect. Settings can create an interval or daily `source.sync` schedule; nothing polls until a job or schedule is commissioned. The project service must be running to dispatch maintenance.

For example, enqueue one scan:

```sh
node factory/cli.mjs maintenance enqueue --actor operator --state /private/project-state \
  --operation source.sync --note 'Refresh eligible source tasks'
```

Or create a five-minute schedule through the canonical command (use the existing revision instead of null when replacing a schedule):

```sh
node factory/cli.mjs command --actor operator --state /private/project-state --operation schedule.put \
  --payload '{"expectedSchedule":null,"schedule":{"id":"issue-source","operation":"source.sync","type":"interval","everyMs":300000,"payload":{}}}'
```

Import never approves, queues or starts a task. Changed briefs and dependency facts revoke prior approval through `task.put`, with a retained `task.approval-revoked` event. An unchanged task retains its approval. Task import does not decide queue ordering; approve and queue work separately. Existing launch/dispatch checks still verify source freshness before consequential work.

## GitHub

The default source is the configured GitHub repository. It scans open issues ordered by recent update, including pagination, and separately refreshes already tracked tasks to observe closure and dependency changes. Pull requests are excluded. The default eligibility rule requires a fenced `factotum-task` brief, so ordinary discussion and decision issues stay out of the task list. Set optional label filters in the project’s delivery configuration:

```json
{"sourceSync":{"type":"github","enabled":true,"id":"issues","labels":["factory-task"],"requireBrief":true,"maxItems":100,"timeoutMs":60000}}
```

All labels must match. Without explicit source labels, `repository.issueProfile.requiredLabels` supplies them. `requireBrief:false` requires at least one explicit eligibility label and uses the configured issue profile parser. Import-blocking labels still reject newly discovered tasks; tracked tasks can refresh while carrying workflow lifecycle labels. Task-level blocking semantics remain in force.

A scan reads at most `maxItems` discovery entries, plus at most that many tracked tasks and their bounded dependencies. The bound defaults to 100 and permits 1–500; timeout defaults to one minute and permits 1–300 seconds. A full discovery page at the limit is conservatively reported as partial. Increase the bound or narrow eligibility upstream for a large repository; discovery currently reads the recent open-issue stream before applying label eligibility. Tracked tasks above the bound stop the scan rather than silently omitting them.

Explicitly closed or newly ineligible tracked issues become closed/blocked or blocked respectively and lose approval. Missing or invalid tracked briefs are blocked with an unknown disposition. An incomplete or failed scan never infers that unseen tasks are closed. Partial scans may have imported valid observations before an error; imports are individually canonical and retained.

## Custom read adapter

Put custom scripts outside upstream-owned `factory/`, for example `project/integrations/read-issues.mjs`, and configure a distinct namespace:

```json
{"sourceSync":{"type":"command","id":"tracker","namespace":"tracker:","argv":["node","project/integrations/read-issues.mjs"],"maxItems":100,"timeoutMs":60000}}
```

The namespace may be any `name:` except `github:`, `job:`, `maintenance:` and, in any letter case, `upkeep:`. The `upkeep:` task namespace is reserved for tasks the factory itself writes: a task id in it cannot be created by `task.put`, a synchronization or an import, and a configuration that names it is refused by `config update` and `doctor`. The same holds for the GitHub `issueProfile.dependencyIdPrefix`.

The trusted command runs in the project root, with a bounded process lifetime and output. It receives one JSON request on stdin:

```json
{"version":1,"operation":"read","sourceId":"tracker","maxItems":100}
```

Return one JSON object on stdout; diagnostics belong on stderr:

```json
{
  "version":1,
  "complete":true,
  "observedAt":"2026-10-22T12:00:00.000Z",
  "tasks":[{
    "key":"9","title":"A fictional feature","acceptance":["The behavior is observed"],
    "state":"open","eligible":true,"revision":"remote-revision-7","dependencies":["1"],
    "risk":"strict","paths":["src/*"],"postMerge":[]
  }],
  "dependencyFacts":[{"key":"1","state":"closed","revision":"remote-revision-3","contentRevision":"content-2"}]
}
```

Use a fresh observation timestamp (at most one minute old), stable keys, and `open`, `closed` or `unknown` states. Task keys are 1–80 letters/digits/dots/underscores/hyphens starting with a letter or digit. Titles and nonempty acceptance lists are required. Dependencies have at most 32 unique keys; dependency facts are bounded by `maxItems * 32`. Optional task fields include `risk`, `paths`, `postMerge`, `category`, `area` and `originalRequest` (see [project workflows](project-workflows.md)), subject to normal task validation. The revision must identify current source content; Factotum also hashes normalized task content and dependency facts so an adapter’s unchanged revision cannot hide changed task content. Observation timestamps alone do not revoke approval. A dependency's progress (its state or `revision` changing) never revokes a dependent's approval. Give a dependency fact (or a task row used as a dependency) an optional `contentRevision` that changes only when the dependency's own content is edited: a change to it does revoke the dependent's approval. Without one, an edit to a dependency cannot be told apart from progress, so it keeps the dependent's approval. GitHub dependencies use the issue's title and body.

`complete:true` promises a complete inventory for this configured source, not merely one page. A missing previously tracked task in a complete response becomes blocked/unknown; it is never inferred closed. With `complete:false`, unseen tasks are preserved. For large sources return a deliberately scoped complete inventory or implement pagination inside the adapter while respecting the output bound. Closed/ineligible new rows are not imported. Tracked closed/ineligible rows remain visible and lose approval.

The command receives PATH, HOME and LANG, not ambient provider or forge credentials. Read private source credentials through project-owned private configuration; never put secrets in argv or returned task content. The adapter is trusted local code, not a sandbox.

Custom tasks retain `source.kind:command` and their own namespace; they are not interpreted as GitHub issue numbers. Planning, build and merge source verification reads the adapter again, checking the normalized task revision and closed dependency facts. GitHub may still provide code hosting and PRs. External issue closure, labels, comments and lifecycle writes for a custom tracker belong to a project integration; this read adapter does not implement those writes.

## Tracked items

A project's real work is usually wider than the issues that are ready for the factory. With `sourceSync.track`, GitHub issues that aren't workable tasks are imported as **tracked items**, giving the full picture in Tasks:

```json
{"sourceSync":{"labels":["factory"],"track":{"labels":["operator","on-hold","orchestrator"]}}}
```

`"track": "all-open"` tracks every open issue instead of only those with listed labels.

- **What they are:** tracked items keep their title, labels, state and a link to the issue. They have no acceptance criteria.
- **Read-only:** they can't be approved, queued or run, and admission gives the reason.
- **Closing:** closing the issue closes the tracked item. Closed tracked items are no longer re-read, but they come back if the issue is reopened.
- **Becoming a task:** when an issue gains a `factotum-task` brief and the eligibility labels, the next refresh turns its tracked item into a normal, unapproved task.
- **In the console:** Tasks shows them with a Tracked chip, under the Open and Tracked filters. They don't count towards "needs approval".
- Tracking is GitHub-only for now.

## Source capabilities: creating, lifecycle and closing

Every source reads. Writing back is optional, through declared capabilities:

| Capability | What Factotum does with it |
| --- | --- |
| `create` | The New task popup (and the `source.create` maintenance job) creates the task in the source, then imports it through the normal read path. The imported task still needs approval. |
| `lifecycle` | Records progress on the source task: `admitted`, `review`, `completed` and `stopped`. |
| `close` | Closes the source task after a proven merge. |

**GitHub** supports all three:
- `create` opens an issue with a `factotum-task` brief, the eligibility labels and any labels you add. Set `sourceSync.create: false` to turn it off.
- `lifecycle` uses `repository.issueProfile.lifecycle`.
- `close` uses `repository.closeTasks: true`.
- An issue created this way carries a marker for its operation, so a retried job finds and reuses the issue it already created.

**A command source** declares what its script supports:

```json
{"sourceSync":{"type":"command","id":"tracker","namespace":"tracker:","argv":["node","project/integrations/tracker.mjs"],"capabilities":["create","lifecycle","close"]}}
```

Writes use the same stdin/stdout protocol as `read`. Every write carries an `operationId`, and the script must apply each operation ID at most once:

```json
{"version":1,"operation":"create","sourceId":"tracker","operationId":"…","brief":{"title":"…","acceptance":["…"],"labels":["docs"],"risk":"ordinary"}}
{"version":1,"operation":"lifecycle","sourceId":"tracker","operationId":"…","key":"9","revision":"…","phase":"review"}
{"version":1,"operation":"close","sourceId":"tracker","operationId":"…","key":"9","revision":"…"}
{"version":1,"operation":"lookup","sourceId":"tracker","operationId":"…","lookup":"close"}
```

Each write answers `{"version":1,"operationId":"…","status":"applied","result":{…}}` (for `create`, `result.key` is the new task's key), or `"status":"rejected"` with a `reason`. `lookup` answers `applied` with the original result, or `absent`.

Factotum asks `lookup` before writing and again after a failed or unreadable write. A write that is still unknown after that is recorded as uncertain and is never repeated blindly.

The `read` response may also include `labels` on each task. Labels group tasks and are not part of the task revision.

## Observations and recovery

`snapshot.sourceSync` and the Tasks source card show the last observation, scan status, completeness, imported/changed/revoked/error counts and whether the configuration still matches. `lastAttemptAt`, `lastObservedAt` and `lastSuccessAt` distinguish an attempted scan from a completed observation and a complete successful scan. Failed reads preserve the previous observation. Reports and `source.sync` events contain no adapter argv or private transport errors; supervised attempt evidence is retained privately for diagnosis.

GitHub discovery reads the repository issues list endpoint (`GET /repos/{slug}/issues?state=open&sort=updated`), not search. For GitHub, `complete:true` means discovery reached the end of that list within `maxItems`; it reports what the list returned at that moment. An issue created or relabeled seconds before a scan may not yet appear there, and is then picked up by the next scan. `skippedItems` lists up to 50 open issues the scan saw but did not import, each with its reason (missing labels, no fenced brief), so an issue that was seen and filtered can be told apart from one that was not listed. `import-task` reads one issue directly and does not apply the discovery label and brief filters.

Recommission after source configuration changes and run a fresh sync before renewing approvals. Source refresh is subject to project configuration, retention holds, canonical revision checks and the maintenance job’s authority. It grants no merge or spending permission.

Routine complete scans with no imported, changed or revoked tasks do not create inbox notices or webhook wakes. New/changed work, partial scans and failures still request attention. Every scan retains its job history, observation report and evidence independently of notifications.
