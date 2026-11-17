# Core request triage — 2026-11-13

Baseline: the current reference source through **0.2.0-dev.20261022.78**. This is a triage and proposed implementation order, not a release or a claim that the requested behavior is implemented. Reports covering older runs may describe behavior already changed upstream; their exact causes are distinguished below from findings reproduced against current source. No adopter configuration or runtime was changed.

| Request | Disposition | Proposed order |
| --- | --- | --- |
| 1. Failed/stopped terminal notifications only | Accept a quieter notification policy; successful main verification is already normally quiet | Small policy batch |
| 2. Path restrictions on automatic merge | Accept commissioned candidate-path restrictions, with manual decision fallback | Policy batch |
| 3a. Missing declared inputs | Admission check already exists; investigate delivery/visibility gaps and add approval diagnostics | Diagnostics batch |
| 3b. Quoted approval for strict work | Support project governance requirements; do not substitute quoted prose for canonical authority | Design before implementation |
| 4a–b. Builder dependency installation and database tests | Accept a development-environment capability gap; reproduce provider-specific failures before selecting an implementation | Design and qualification |
| 5a. Manual target synchronization | Required branch-pair payload is checked too late and poorly documented in command help | Reliability batch |
| 5b. Outside-change synchronization | Old false-success reporting is fixed in dev.75; same-head failure retry remains a confirmed gap | Reliability batch |
| 6. Verification resource waits | Confirmed short wait limit and noisy failure classification | Reliability batch |
| 7. Stopped flows retaining capacity | Deliberate current ownership behavior; improve stop-time guidance first | Diagnostics batch; separate suspension design |

## 1. Failed/stopped terminal notifications only

`notifications.level` currently accepts `essential` or `all`. Essential suppresses intermediate flow state events and some consumer-caused notices, but still creates successful delivery-flow terminal notices. Successful automatic `target.sync` jobs also normally produce notices. See [notification delivery](../starter/factory/operations/notifications.mjs), [flow notices](../starter/factory/core/project.mjs) and [configuration validation](../starter/factory/core/configuration.mjs).

One qualification to the report: a successful built-in `main.verify` with green health and no actionable findings or obligations already completes quietly, irrespective of its `main-refresh:*` job ID. A claimed routine main-refresh notice needs its operation, outcome and retained result to distinguish an older version, an actionable result or a different workflow. The existing maintenance-notice regression covers this suppression.

Proposed behavior: an additional level that keeps the essential policy's actionable questions, operator answers, approval/revocation changes and source-change notices, but suppresses successful terminal summaries. Failures, stops and unresolved outcomes must remain visible. Successful operation records still belong in History. A result carrying a cleanup obligation or other required intervention needs an actionable notice even when its flow completed; suppressing the completion summary must not discard that intervention.

Acceptance: exercise both inbox and state-event delivery, failed and repeated stopped flows, successful changes and syncs, actionable results, operator resolutions and consumer self-resolution suppression. The new level must not accidentally fall through existing equality checks into `all` behavior. Specify how pending deliveries behave when the level changes. This policy is not an option to hide every message except failures.

## 2. Path restrictions on automatic merge

Confirmed missing capability. The engine currently decides automatic merge from the enabled policy, ordinary risk, qualification and candidate mode, without checking changed paths. The forge dispatcher also chooses automatic versus manual mode from the broad policy and risk. Both places need the same candidate-specific decision: [engine](../starter/factory/core/engine.mjs), [merge dispatch](../starter/factory/workflows/dispatch.mjs).

Proposed behavior: commissioned allow/exclude path rules, evaluated against the actual diff for the exact candidate and target base. An excluded path opens the workflow's normal merge question for its configured decision role. It should not require reclassifying an ordinary change as strict. Existing automatic-merge qualification, review, gate and exact-candidate requirements still apply.

Use actual added, modified, deleted and renamed paths, including both sides of a rename. Declared task paths are useful for early explanation but cannot authorize merging. Unavailable or ambiguous diff evidence requires a decision. Record the path-policy result with its candidate/base and policy identity; revalidate after integration or candidate changes and before the remote effect. A manually answered question must remain attributed to that decision, rather than becoming an automatic merge merely because the project enables `autoMerge`.

Acceptance: allowed-only changes; mixed allowed/excluded changes; deletion and rename across the boundary; inaccurate task path declarations; changed base/candidate; custom workflow merge steps; and manual fallback under an otherwise enabled automatic policy.

## 3. Admission checks and approval evidence

### Declared inputs

Structured `inputs: [{path, sha256?, note?}]` already participate in the task revision. [Admission](../starter/factory/operations/admission.mjs) checks that each exists in the project checkout and checks supplied file hashes. Delivery `flow.start` and queued admission use these checks. [Input handling](../starter/factory/operations/inputs.mjs) and [source dispatch](../starter/factory/workflows/dispatch.mjs) copy ignored inputs into the owned worktree before planning; tracked inputs must be present there. This is not a new admission feature to implement from scratch.

Remaining work: show input readiness at approval without confusing approval with readiness, and verify the same prerequisites in the actual execution checkout. Root-checkout availability alone does not prove that an older retained worktree, another target revision or a resumed attempt has the right input. An untracked, unignored input can pass the existence check and then fail copying; move that diagnosis earlier. Preserve a final check at use time because inputs can change after approval. Large input checks must not add blocking full-file hashing to routine console reads.

A specific blocked-agent report needs the retained structured task inputs, selected target, source/workspace results and relevant attempt phase. A prerequisite mentioned only in prose is not currently a declared input. Do not infer that the existing admission check failed solely from an agent asking for a file.

Acceptance: missing and mismatched structured inputs, nonportable untracked inputs, source re-import, target/worktree differences, resume after inputs disappear, and both direct and queued starts, with no provider attempt consumed for a known missing prerequisite.

### Strict-work approval quotations

Current authority is the canonical approval of the task revision, made by the operator or commissioned delegation. Delegated commands require `onBehalfOf.instruction`; that instruction is attribution, not independent proof of consent. Strict candidate sign-off is separately bound to the reviewed candidate. See [delegation](../starter/factory/core/delegation.mjs), [approval commands](../starter/factory/core/project.mjs) and [strict review](../starter/factory/core/risk.mjs).

A project may require a quoted instruction or reference as an additional governance prerequisite. Accept this as an explicit commissioned requirement, with structured evidence associated with the task revision and included in worker context. Missing evidence can hold admission before planning. A flow note cannot be the only way to supply a prerequisite for creating that flow, so this needs a pre-admission task/approval channel as well as recovery guidance. Decide how direct console approval satisfies the requirement and when scope changes invalidate it.

Do not make a text search for an apparent operator quote the universal strict-task authority check. It cannot establish who approved the work, and task text can contain arbitrary quotations. Tests must distinguish a missing project-required reference from missing canonical approval, revoked approval and delegated attribution.

## 4. Builder dependency installation and database tests

Confirmed architectural limitation, with the precise reported failures still unverified locally. [Provider invocation](../starter/factory/adapters/providers/index.mjs) fixes Codex builders to workspace-write, removes user configuration, restricts Claude tools, and passes only a small environment allowlist. It does not expose a commissioned development-service or shared-cache capability. Provider enforcement mechanisms differ; do not describe both as identical filesystem/network isolation.

### Package store access

The reported SQLite error is consistent with an inaccessible store or required metadata write, but does not prove which path or permission failed. Reproduce with the retained provider/version, actual store path and the same offline install command. Offline installation does not by itself imply read-only cache access.

Prefer a per-workspace/project writable store or a supervised project-owned dependency preparation operation over broad access to a shared home directory. Existing [workspace setup](../starter/factory/adapters/workspace/index.mjs) provides trusted preparation, but runs once before the builder changes a lockfile; that alone does not solve installing the changed candidate's dependencies. The design needs an explicit way to refresh them after a lockfile edit, preserve receipts and return useful diagnostics to the builder. A genuinely offline run also needs all required packages already available; filesystem permission cannot supply missing packages.

### Database tests

A project-owned gate can run database tests today, but that does not provide the same capability to a sandboxed builder. Prefer a supervised test command or a commissioned isolated development-service capability with explicit environment, endpoint/socket access, resource ownership and teardown. It must be usable during correction, return bounded diagnostics, and keep independent candidate verification at the gate. Avoid ambient production credentials or an unrestricted-network switch as the solution.

Qualification should exercise a real offline dependency refresh after a lockfile edit and real database tests under each supported provider invocation mode, including concurrent workspaces and unavailable services. Before selecting an implementation, retain provider/version, sanitized failure output, relevant path permissions and connection transport. These requests need more than changing prompt wording.

## 5. Manual and outside-change target synchronization

### Manual payload validation

`target.sync` requires both `payload.from` and `payload.into`, matching one commissioned `repository.syncTargets` entry. Automatic jobs supply these fields. [Enqueue](../starter/factory/core/project.mjs) currently accepts an empty payload; the [maintenance action](../starter/factory/workflows/maintenance.mjs) then produces the reported configuration error. This is a confirmed usability/validation gap, not evidence that a configured automatic pair is missing.

The current command payload is, for example:

```json
{"operation":"target.sync","payload":{"from":"main","into":"next"},"note":"Reconcile the configured target pair"}
```

Send it through `job.enqueue` with the normal operator/delegated authority. Validate the pair at enqueue time and name the missing fields and configured choices. Document the payload in operation help. If a default is offered for a single configured pair, resolve and persist the explicit pair at enqueue; never guess among multiple pairs.

### Outside-change sync outcomes and retry

Dev.75 already fixed generated maintenance graphs that treated a clean process exit with `route: fail` as completion. Failed syncs now retain their reason and hold destination admission; successful reconciliation and fresh verification are required to release that hold. This fixes a known cause of misleading completion notices, but does not establish the cause of every reported absent merge.

A separate current gap is confirmed in [outside-change scheduling](../starter/factory/operations/main-freshness.mjs): `syncSeen[from>into]` is advanced when the job is queued. A failure for that head does not produce another job on a later probe of the same head. The job ID is also derived from that head, so simply moving the `syncSeen` update to settlement would not create a safe retry. An injected-transport reproduction queued one job, marked it failed, advanced past the probe interval, and observed zero retry jobs.

Proposed behavior: distinguish observed, requested and successfully reconciled heads; retain each attempt and make retry identity explicit. Reconcile the destination before retrying an uncertain push. Retry transient failures with bounded backoff, retain conflict holds for explicit repair, and expose why synchronization is held or awaiting retry. Do not turn repeated conflicts into periodic writes and notifications. Reobserve destination containment after manual repair so a stale observation does not permanently block progress.

Acceptance: outside movement without a factory merge, fetch/push failure, uncertain successful push, conflict, restart after enqueue, unchanged source after failure, manual repair, already-contained destination and source movement while a job is running. A claimed successful-but-absent merge still needs its action result, receipt and remote-head evidence; the retry reproduction alone does not prove that report's cause.

## 6. Main verification waiting for resources

Confirmed: [runMaintenanceAction](../starter/factory/workflows/maintenance.mjs) waits at most `min(attempt timeout / 2, 60000)` milliseconds for a permit, then throws `main verification resource wait exhausted`. Increasing the attempt timeout cannot raise that 60-second ceiling. Automatic freshness logic can request another verification after a 15-minute failed-job cooldown when queued work needs it, but this still records an avoidable failure rather than a resource wait.

Proposed behavior: represent resource contention as a durable waiting/deferred state with an explicit deadline, cancellation and bounded retry. Acquire without a race before running the check; preserve the coordinator's owner-liveness and containment rules. A held permit must never be stolen merely because a waiter timed out. Separate resource waiting from verification execution time and product check failures, expose the blocking resource in status, and remain quiet for ordinary contention. Exhausted overall wait policy or genuinely uncertain ownership can still need attention.

Acceptance: a gate holding the permit longer than 60 seconds, eventual acquisition, cancellation, restart, multiple waiting projects, stale/uncertain owners and persistent contention. Confirm verification starts once, target health remains unverified while waiting, and ordinary waiting produces neither a failed-check result nor repeated wakes.

## 7. Stopped flows retaining capacity

This is deliberate current behavior: [admission's active-flow predicate](../starter/factory/operations/admission.mjs) excludes only completed and failed flows. A stopped flow retains its candidate, task ownership and conflict reservations for recovery. The admission error already says that stopped flows hold slots, but [stop command help](../starter/factory/core/command-help.mjs) only says “Stop a flow.” The consequence should be visible before stopping and in the stop result/console, not discovered by the next task.

Immediate proposal: explain that stop preserves the slot, show the stopped owner in queue diagnostics, and distinguish resume, abandon and restart. Abandon releases flow admission ownership subject to existing unresolved-attempt checks; workspace cleanup remains a separate operation. Never offer “stop and release” as a silent synonym for stopping an in-flight or uncertain effect.

Optional future suspension requires separating execution capacity from task/workspace/conflict ownership, proving the attempt is quiescent and reacquiring capacity on resume. Waiting on a question has the same broader scheduling tradeoff. Removing stopped flows from the active predicate alone would lose those safeguards.

## Validation and next implementation boundary

For this triage, **31 existing focused tests passed** across inputs, notification policy, maintenance notices, main freshness and target-sync health. The outside-sync failure/no-retry observation used an in-memory store and injected transport, with no remote operations. No provider run, database service, adopter state or live notification delivery was exercised.

Implement manual sync validation, synchronization retry/reconciliation and resource-wait handling as the first reliability work. Approval/stop diagnostics and notification filtering can be separate smaller changes. Candidate-path automatic merge and builder environment capabilities need their own commissioned contracts and qualification. Nothing in this note changes existing authority, creates a release or marks live reports resolved.
