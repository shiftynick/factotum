# Console UX buildout

The console has a project sidebar and dedicated Overview, Inbox, Timeline, Tasks, Queue, History, Stats, Operations, Settings and Receipts views. A mobile selector provides the same project scope. Project services remain canonical; the console has no execution authority of its own.

The timeline draws persisted attempt, question/resource wait and event timestamps, with accessible table equivalents and log drill-down. Explicit historical flow links are read from the canonical service even when outside the recent snapshot. An unknown flow shows an error and never falls back to another flow's controls.

Tasks provides source refresh, paginated brief/revision inspection, retained approval/revocation history and explicit Approve/Start/Queue/Revoke actions. Queue provides the complete queued order, priorities and pins, dequeue, admission observations, planning-window usage, reviewed-plan freshness and explicit Plan/Dispatch actions. Legacy Plan links remain Tasks aliases. History offers all supported collection kinds, ordering, pagination, loaded-record search/status filtering and readable record details. Stats uses observed samples with counts, units, time ranges, missing-data coverage and subscription-cost semantics. Operations exposes findings, rule proposals, regressions, obligations, deliveries, context, machine observations and factual retrospectives.

Settings displays repository, providers/models, policy, check identities, context, resources and commissioning. Schedules have allowlisted enable/disable/create controls. Display preferences remain browser-local. Full executable configuration editing, commissioning, uncertain-attempt reconciliation and restore release remain CLI operations and are labelled accordingly.

## Conditional edits and compatibility

Task, schedule and queue forms send optional canonical preconditions:

| Command | Precondition |
| --- | --- |
| `task.put` | `expectedRevision`: observed revision, or null for a new ID |
| `schedule.put` / `schedule.remove` | `expectedSchedule`: observed `{revision,enabled}`, or null for a new schedule |
| `queue.put` | `expectedTaskIds`: observed ordered queued IDs; `expectedQueueRevision`: observed order, pin and priority digest |

The project checks these inside its canonical transaction before changing records, approvals or flows. A concurrent edit is rejected without overwriting it, including when automatic rendering was deferred while typing. Existing CLI callers that intentionally omit preconditions retain their established upsert semantics.

Snapshots advertise conditional task/schedule/queue capabilities. Queue editing additionally requires `queueComplete:true` and `queueRevision`; task collections remain paginated independently. The redesigned console disables these edits when an older project service lacks the corresponding capability, rather than assuming it enforces an unknown field. Other compatible reads and existing guarded actions remain available.

Dirty drafts retain their project, binding and subject. Unsaved queue order also retains its original binding; a replacement registration requires explicit discard and review. Changing project selection never changes a pending action's target. Unknown command outcomes fence further project mutations until receipt reconciliation.

## Validation

The earlier UX buildout passed 195 tests with no skips. The Tasks/Queue split passes the current 369-test suite, including large queues, metadata concurrency, selected tasks beyond the snapshot, registration binding and actual editor payload regressions. Desktop and 390px browser checks covered queue metadata saves, approval feedback and legacy Plan deep links. Independent review corrected historical-flow fallback, nullable timeline output and queue-draft retargeting. Additional canonical regressions cover concurrent task edits, new-ID collisions, changed schedule grants/enablement and queue replacement. Settings tests exclude private paths, executable arguments and unknown integration keys.

Opus's local browser run exercised navigation, keyboard controls, evidence drill-down, history, confirmed decisions, task creation/approval, draft persistence, binding replacement, unavailable services and unresolved receipts at desktop/mobile widths and light/dark themes. Parent verification used Chrome through CUA, reproduced and verified rejection of a stale browser edit against an independently changed brief, checked missing-flow routing, all history kinds, and repaired/tested the mobile project selector. The final daily chart keeps its date labels visible without vertical scrolling. Both process and systemd adoption rehearsals pass.

The synthetic UI demo includes explicitly illustrative operational records and makes no model or forge calls. These checks qualify local UI/service behavior; historical provider and GitHub delivery evidence retains its own executor fingerprint in the [qualification record](qualification.md). No new live-provider qualification is implied by the UI changes.

Start the populated demo with `node evals/run.mjs --serve --ui-demo`.
