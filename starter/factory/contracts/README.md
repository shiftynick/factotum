# Runtime contracts, version 1

Database schema, project protocol, configuration and workflow versions are independently declared in `compatibility.json`. Validation lives in `core/contracts.mjs`, `core/configuration.mjs` and `core/project.mjs`; installed actions and adapter schemas live in `workflows/` and `adapters/`. Records and events commit together in SQLite. Larger evidence stays in private state outside the checkout.

## Project service

The local HTTP-over-Unix-socket protocol exposes:

- `GET /v1/handshake`: protocol, project/service identity, name, revision and capabilities.
- `GET /v1/snapshot`: bounded overview, queue, health, metrics, context, obligations and receipts.
- `GET /v1/collections/:kind?cursor=0&limit=50`: bounded pages for tasks, flows, inbox, attempts, schedules, events, deliveries, obligations, findings, pushback, regressions, machine samples, waits and plans. Kind names are singular; maximum page size is 100.
- `GET /v1/flows/:id`: flow, attempts, decisions and bounded event history. Each attempt lists the evidence files it has (`artifacts`). `capacity` is the flow's place in the flow slots (`operations/capacity.mjs` `flowSlot`): `state` (`working`, `parked`, `parked-holding`, `waiting`, `category` or `stopped`), `holdsSlot`, its pool, and for a waiting flow its position and reason; null for a finished flow or a kind that takes no slot.
- `GET /v1/jobs/:id`: one job's lifecycle fields (status, outcome, reason, flow, times), never its payload or grant; the console follows a `job.enqueue` receipt with it.
- `GET /v1/artifacts/:attemptId?name=stdout.log`: bounded previews of a static allowlist of ordinary evidence files. A file the attempt never wrote returns `available: false` with empty text, not an error. Arbitrary paths, symlinks and unsupported names are refused; execution inputs and secrets are projected out.
- `POST /v1/commands`: `{protocolVersion:1,projectId,commandId,operation,payload,actor}`.
- `GET /v1/commands/:commandId`: canonical receipt, or 404 for an unknown identity.
- `GET /v1/commands`: recent command history.

Command receipts contain `{projectId,commandId,operation,actor,acceptedAt,completedAt,status,result?,error?}`. A command's local transition finishes transactionally as completed or rejected; resulting effects have separate durable attempts. Reusing an ID returns the same receipt; different content under that ID is rejected. A missing transport response never proves rejection. Console bindings and command journals are separate from project authority.

## Canonical commands

| Operation | Payload and authority |
| --- | --- |
| `task.put` | Operator: `{task:{id,title,acceptance,source?,dependencies?,area?,paths?,risk?,recovery?,postMerge?,category?,blocked?,closed?},expectedRevision?}`; null expects a new ID, otherwise the observed revision |
| `task.approve` / `task.revoke` | Operator: `{taskId,revision}` / `{taskId,note}` |
| `flow.start` | Valid prior approval: `{taskId,revision,flowId?,candidate?:{number,head,base},alreadySatisfied?:boolean}`; delivery requires exact revision and commissioning. Alternatives cannot be combined. |
| `rule.pushback` | Operator or orchestrator: `{ruleId,reason,evidence,flowId?}`; records a proposal only, never changes rules or grants authority. |
| `regression.record` | Operator: `{flowId,reason,evidence,id?}`; attributes a later reported regression to a proven merged flow, without inferring causation. |
| `queue.put` | Operator: `{taskIds:[id],expectedTaskIds?,entries?:[{id,priority?,pinned?}]}` in desired order; atomic replacement of queued entries with optional observed-order comparison |
| `pause` / `stop.all` | Operator: `{paused,note}` / `{note,abort?:boolean}`; pause controls admissions, stop fences named project flows |
| `stop` / `resume` | `{flowId,note,abort?:boolean}` / operator `{flowId,note}`; resume requires current authority and resolved attempts |
| `inbox.read` / `inbox.ack` | `{inboxId}`; neither answers a question |
| `answer` | Recorded question role: `{inboxId,version,subjectDigest,answer}` |
| `flow.replan` / `flow.abandon` | Operator: `{flowId,note}`; unresolved attempts or completed merges cannot be bypassed |
| `attempt.resolve` | Operator attestation: `{attemptId,disposition:'failed'|'not-dispatched',costMicros,note,quiescence?}`; live/uncertain owners cannot be released, and missing evidence needs an explicit independent quiescence attestation |
| `restore.release` | Operator: `{note}` after all effects are reconciled and flows stopped or terminal; admissions remain paused |
| `config.update` | Operator: `{config,note}` while drained; invalidates commissioning |
| `main.health` | Operator exception: `{status,head,note}`; explicitly attributed, never disguised as a check |
| `schedule.put` / `schedule.remove` | Operator: `{schedule,expectedSchedule?}` / `{scheduleId,expectedSchedule?}`; optional observed `{revision,enabled}` (null expects creation); grant revision pins approved operation/scope, replacement/revocation fences its flows |
| `job.enqueue` | Operator: `{id,operation,payload,note}`; installed maintenance operations only |
| `delivery.ack` | `{deliveryId}`; reminder deferral only |
| `obligation.resolve` | Operator: `{obligationId,status:'passed'|'failed'|'deferred',evidence,note}` |
| `finding.accept` | Operator, or delegated: `{findingId,expectedVersion,task}` or `{findingId,expectedVersion,taskId}`; audit findings only; the task is not approved. Operator, or delegated: `{findingId,expectedVersion,files?}` (a check candidate) or `{findingId,expectedVersion,paths?}` (a learning candidate) or `{findingId,expectedVersion}` (a stale-learning candidate) writes one unapproved `check`, `learning-add` or `learning-retire` task; `approve:true` approves it too, operator only, directly. A `check` task is approved (here or by `task.approve`) only by the operator, directly, never by delegation or a grant. Operator only, directly: `{proposals:[{findingId,expectedVersion,digest}]}` accepts governing-context proposals and rules into one `context` task and approves it |
| `finding.resolve` | Operator, or delegated (a `context` or `rule` candidate: operator only): `{findingId,expectedVersion,disposition:'declined'|'resolved-elsewhere',reason?,evidence?,note?}`; declining a tasked finding closes its task |
| `finding.reopen` | Operator, or delegated (a `context` or `rule` candidate: operator only): `{findingId,expectedVersion,note}`; from `declined`, `expired`, `failed` or `resolved-elsewhere` |
| `upkeep.lift` | Operator only, never delegable: `{part:'model'|'docs'|'context'|'capture'|'all',expectedAt?,note}` |

Actor labels validate attributed roles within one trusted local account; they are not separate OS authentication. The CLI also exposes exclusive administrative backup, restore, doctor, retention and upgrade procedures. Typed `reconcile` performs read-only external proof for selected uncertain GitHub writes; it cannot invent provider output, repeat a write or automatically resume a stopped flow.

## Attempts, evidence and workflows

Task revision hashes the approved brief, including source revision, dependencies, risk and other governing fields. Approval has a separately increasing authority version. Identical synchronization preserves completion; changed authority fences affected flows. A flow pins task, configuration, workflow and executor identities. Its intent binds installed action or trusted argv, cwd, input identity and limits before dispatch. Supervisor receipts bind intent, process/cgroup ownership, logs, result digest and cost. Missing or contradictory evidence remains uncertain, including zero-cost effects.

Workflow v1 supports effect/question/end nodes with explicit failure edges. Effects use trusted argv or an installed action, bounded timeout, and optional semantic result edges. Every cycle crosses a finite `maxVisits` and every flow has a transition bound. Review/check evidence binds the exact clean commit/tree. Questions bind actor, subject and version; a changed candidate invalidates an old answer. Delivery completion requires a proven authorized merge or the explicitly reviewed, checked and accepted already-satisfied target outcome.

Provider plan/build/review schemas are exported by `adapters/providers/index.mjs`. Builders may resume only their owned session; plans and reviews use fresh sessions. Governing context follows declared paths, planned files and actual changes, retaining content digests and omission reasons. Required authority cannot silently disappear for size or read failure. Gate rows cover every trusted check definition and distinguish product failure from blocked infrastructure.

Subscription-backed Codex and Claude are enabled; monetary values are integer USD micro-units and actual incremental API cost is zero in this mode. Metered effects and paid evaluation remain disabled without a separately qualified enforceable adapter. GitHub API and Git network operations use explicit account/repository scope. Manual merge retains a target race unless a remote mechanism is independently qualified. New schemas or incompatible semantics must advertise compatibility rather than reinterpret existing records.

Snapshots advertise conditional task, schedule and queue edits through `editPreconditions`. Rich views and mixed-service behavior are documented in the UI buildout (`docs/ui-buildout.md` in the Factotum reference).
