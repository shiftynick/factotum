# One web console for multiple projects

Status: implemented local contract. The console supports project registration, overview, combined questions, task approval and launch, queue and flow controls, paginated history, evidence and artifact previews, metrics and durable command recovery. Remote transport remains deferred. The initial scope is one trusted operator on one Linux machine; see [running guide](running.md).

## Ownership and deployment

Run one web console and one independently operable factory instance per project. Each instance owns its runner, SQLite store, artifacts, workspaces, approvals, inbox, schedules, provider credentials and spending records. A small project service exposes queries and validated operator commands. It can run alongside the existing runner; this does not require a new service process for each module.

The console owns its private project registry, presentation preferences, disposable read caches and a minimal durable journal of pending command identities. That journal supports recovery, not authority or queued execution; project command receipts remain canonical. The console never opens project databases directly, imports project-specific executable modules, schedules project work or becomes the authoritative inbox. Both the CLI and project service call the same application services. Restarting or removing the console does not stop factory work; each project's CLI remains usable.

The first transport uses local Unix-domain sockets with local-user permissions. The browser talks to one loopback web origin; the console backend routes requests to registered project sockets. One chosen, pinned starter copy supplies the console executable and assets. Independently adapted project copies advertise their protocol version and capabilities. A single-project installation is the same arrangement with one registry entry; no separate dashboard implementation is needed.

## Project identity and registration

Use a stable generated project ID, independent of repository name, filesystem path and display label. Generate it at installation, keep it in private state, and use it consistently in routes, notifications and object references. Separate installations that may run concurrently need separate IDs, even when they use the same repository. A restored installation must follow the existing reconciliation procedure and cannot run alongside another live instance with the same identity.

Registration binds that ID to a private endpoint and an expected service identity. The service handshake reports its project ID, protocol version, capabilities and current state revision. Reject a mismatch or duplicate registration; never guess a project from a flow ID or silently route an unknown ID to the current selection. Endpoint replacement requires explicit registration validation and invalidates unsubmitted browser commands for the old binding; submitted commands retain their original identity for reconciliation. The registry accepts operator-configured endpoints only; task text and model output cannot add endpoints.

Unregistering hides a project without changing its work. Renaming only changes its label. Protocol compatibility is separate from starter and executor version: support documented overlapping protocol versions where practical, disable unsupported commands, and show an incompatible project explicitly if even its reads cannot be interpreted safely. Do not force all copied starters to upgrade together.

## What the operator sees

- A project overview with active work, pending decisions, main health, last observation time and connectivity. Unavailable, incompatible, paused and idle are distinct states.
- A combined inbox whose rows always identify the project. Selecting an item opens its project-scoped question, evidence and allowed actions. A must-fix flow's merge or satisfied question shows its review findings and purpose assessment and is answered with one check box per finding to acknowledge, sending the claim digests the page shows (see the [console guide](../starter/factory/console/README.md)).
- Project pages for queue, flows, plans, evidence, costs and history, using the same components as the single-project view.
- Optional aggregate measurements with explicit units, time range, coverage and missing/stale projects. Keep currencies, actual spend, reservations and subscription estimates separate.

The implemented navigation (Overview, Inbox, Timeline, Tasks, Queue, Scheduled, History, Stats, Health, Settings, Receipts), draft retention and timeline semantics are described in the [console guide](../starter/factory/console/README.md).

Resource links are qualified by project and object identity. A link remains tied to that project when the user changes the navigation selection. An open command or answer form retains its original project, subject/version and registry binding. Show the target project next to the action; changing selection must never retarget a pending submission.

## Command routing and recovery

Route a typed operation to exactly one registered project. A command envelope includes protocol version, project ID, client command ID, operation, payload digest, relevant resource/subject version, actor attribution and the registry binding used. The backend verifies the binding and the project service checks the target ID, current authority, stop state and operation-specific preconditions. Browser selection, cached readiness or an enabled button cannot grant authority. A pause command need not include a nonexistent candidate; a merge or answer requires its applicable candidate or subject identity.

Before sending a command, the console durably journals its project ID, registry binding, client command ID, payload digest and submission time. A browser reload or console restart recovers that identity and queries its canonical receipt. The journal does not need an executable payload and must not automatically submit a request that may never have reached the project. Keep unresolved entries through restart, unregistration and endpoint changes; show them for reconciliation without silently retargeting them to a replacement binding.

Persist command acceptance and its identity in the project's canonical store before applying the transition or dispatching an effect. Deduplicate by project ID and client command ID; reject reuse with different content and return the existing status/receipt for an already recorded command without repeating its transition. Acceptance, completion, rejection and an uncertain external outcome remain distinct. Query the existing command before retrying with the same identity; neither a timeout nor a missing receipt permits inventing a replacement ID. A deliberate retry reuses the identity; any still-unperformed action must pass current authority and subject preconditions before it runs. If the journal is lost, inspect canonical command history before issuing another action; uncertainty is not failure. This does not make arbitrary external writes exactly-once.

Do not queue offline approvals, merges, resumes or answers for later automatic delivery. Disable mutation when the service is unavailable or incompatible, then refresh the subject before a new submission. A timeout after submission is an unknown outcome requiring status lookup, not proof of failure. The initial interface has no cross-project bulk mutations. A control labelled “stop all” always names the one project whose flows it affects.

## Failure isolation and local access

Read projects independently with bounded per-project timeouts, concurrency and pagination. Return healthy results even when another service is slow. Start with bounded polling rather than requiring an event broker; any later event stream needs per-project cursors and snapshot resynchronization after a gap. Mark cached views with their observation time, and never turn unreachable into healthy or empty.

The loopback web server validates Host/origin and uses appropriate session/token and request-forgery protection. Keep endpoint connection material server-side; the browser does not receive provider credentials or arbitrary socket/path access. Render task/model/log content as untrusted text or sanitized markup; active evidence documents must not execute in the console's origin. This preserves the existing trusted-local-account scope; it does not provide isolation against malicious processes running as that account.

Project execution, scheduling and budget admission do not depend on the console. Heavy work shares the machine's resource coordinator where configured. A combined spend display is not a cross-project spending cap; a shared account cap requires a separate authoritative reservation contract before it can be offered.

## Remote extension

Keep transport behind the project-service client. A future remote adapter must retain project identity, command receipts, conditional decisions, compatibility negotiation and failure isolation. It also needs authenticated encrypted connections, credential lifecycle, explicit operator-to-project authorization and a remote artifact access contract. These are prerequisites, not delivered capabilities. Do not make the first local service publicly reachable as a shortcut.

Remote outages can use the same unknown/stale states and reconciliation rules. They must not introduce central ownership of a project's workflow or a distributed transaction across project stores. The local registry and socket client provide the initial replacement point without building remote infrastructure now.

## Qualification before delivery

Use two independently configured fictional projects. Show that overlapping flow/inbox IDs remain separate, a project switch cannot redirect an answer, and a changed registry binding invalidates unsubmitted commands. Prove that one disconnected or incompatible project leaves another usable. Exercise command acceptance followed by response loss, console restart and browser reload: recover the same identity and receipt without resubmission. Also restart after journaling but before dispatch; recovery must not execute the unsubmitted request. Duplicate commands cannot repeat transitions, and unregistering or restarting the console leaves both runners intact and unresolved command identities recoverable. Check that artifact content cannot execute in the console origin and that credentials remain server-side.

Exercise mixed supported protocol versions and explicit incompatibility without requiring synchronized upgrades. The first shared UI can use scripted project workers; real provider and workflow qualification remains a separate obligation in the [implementation plan](implementation-plan.md).

## Tasks and Queue

Tasks shows source synchronization and its last observation, paginated task briefs, source state, revisions and recorded approval/revocation history. Approve permits that exact revision; Start begins delivery and Queue adds it to the queue. With automatic admission off, approval and queueing leave delivery idle. Planning readiness links open Queue, and task links retain the selected project and task. Legacy `#/p/PROJECT/plan?task=ID` links resolve to Tasks without losing the task selection.

Queue shows the complete queued order, priorities, pins and observed dispatch order. Reorder, pin, priority and dequeue changes form one explicit draft, followed by Save queue changes. A full queue revision precondition rejects concurrent order or metadata changes. The editor preserves queue rows whose task briefs fall outside the bounded snapshot. Older project services without a complete-queue indication and revision can still be inspected, but their queue cannot be edited through this console.

Queue also shows **Flow slots**: per pool the slots in use and free for queued tasks, the flows parked on an answer (each labelled Parked, with its step, and Holds a slot when it is beyond `policy.maxParkedFlows`) and the answered flows waiting for a slot, each with its position and reason. Queue also shows why a selected task has not started yet, and **Started from the queue**: running work and work started in the last 24 hours, with how long each waited once ready. A banner appears only when the queue can't move on its own: a hold, doctor not passed, or main health that holds change and document tasks. With automatic admission off, the banner offers **Dispatch now**, which starts the first queued task that passes every admission check, and shows the last dispatch's outcome (what it started, or why nothing could start).

Task and plan collections use pages of 50 records, with explicit Previous/Next controls. Task filters apply to the current page; counts never imply the whole collection was filtered. Selected-task reads can retrieve an older task beyond the snapshot or current page. Reads and drafts stay bound to the registration that produced them. An unavailable read is shown as unavailable rather than an authoritative empty collection; drafts cannot silently retarget a replacement registration.

## Dashboard snapshots

From dev.73, `GET /v1/snapshot` is a compact overview marked `snapshotView: "dashboard-v1"`. Historical flow results, command receipts, retrospectives, context packages and full statistics are not embedded in every refresh. Omission means not loaded, not an empty history. Use `/v1/flows/:id`, `/v1/tasks/:id`, paginated `/v1/collections/:kind` and `/v1/stats/:window`; the snapshot also names these in `detailEndpoints`. The CLI `status` projection is unchanged.

The dashboard includes all active/stopped flows, unsettled attempts, open inbox items, unresolved obligations and unapproved findings, plus the 20 most recent records in each of those categories. Flow and attempt rows are summaries. The complete queued order, task revisions, metadata and `queueRevision` remain available for conditional queue editing, including tasks outside the recent 100-task sample. Claimed queue entries and entries started within the last day remain visible. Current settings and schedule summaries are included. `stats.partial: true` identifies the minimal lifetime flow count; full statistics are fetched separately.

Polling does not run Git or calculate fresh task eligibility. Summary tasks have `admissionObserved: false` and direct the reader to selected-task detail for current advisory reasons. Queue eligibility retains its explicitly timestamped observations. Actual starts and queue claims still validate canonical authority, health, conflicts and capacity. Exact inbox versions and subjects remain unchanged; summary reads never grant authority.

The existing dev.71 shared console is compatible with this project-side projection. The client still enforces a 1500 ms request deadline and 2 MiB response cap. The full snapshot can fail the size check even when it arrives promptly; increasing timeouts does not address that failure. Compact polling removes the historical-body contribution but is not a constant-time database implementation or an unlimited active-backlog guarantee. Individual detail reads retain their transport limits. An unreachable or oversized response remains unavailable rather than silently presented as current cached state.
