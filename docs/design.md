# Proposed design

Status: architectural contract for the implemented reference. Core delivery, subscription CLI adapters, GitHub, local project services, the shared console, operational controls and extension examples are implemented. See the [qualification record](qualification.md) for tested behavior and limits, and the [implementation scope](implementation-plan.md) for deliberately disabled features.

## The system being built

The factory combines an operating method with a durable execution system. Both matter. Instructions define what a good task, review, and decision look like. Code controls admission, state transitions, attempts, evidence, and mechanical actions. A dashboard and command interface make the same recorded state available to people and agents.

The first version serves one trusted operator on a Linux workstation, with one project per factory instance and a shared web console for one or more instances. Each instance retains its own state and authority; the console provides a combined view and routes project-scoped commands. Multiple instances may share a machine resource coordinator. Remote projects are a future transport extension. This is not a hosted service for mutually untrusted users, a replacement for application tests, or a promise that agent work needs no human judgment.

Use a small Node.js implementation with SQLite and systemd as the initial technology choice. Keep the exact supported runtime and provider CLI versions in a tested compatibility manifest when implementation begins. Avoid introducing a general plugin marketplace, arbitrary workflow scripting language, distributed scheduler, or shared package service to deliver the first useful version.

## Boundaries

**Core.** The state store, event history, graph validation, attempt lifecycle, bounded retries, reservations, inbox, and evidence identities. The core knows that work can be admitted, dispatched, reconciled, and settled. It does not know repository labels, test suites, model names, deployment servers, or chat-thread identifiers.

**Workflow and policy.** Planning, change delivery, verification of the main branch, and optional audit, release, and evaluation workflows. Policy decides which work may run, what review it owes, who may answer, and when evidence permits the next step. Policy is versioned and pinned to a flow. Pinning preserves the rules used to evaluate work; it does not override current revocation, stop, or emergency suspension controls.

**Project integration.** Task and pull-request operations, workspace preparation, context selection, verification, risk classification, deployment, product evaluation, and resource cleanup. A project supplies the meaning of success. The reference supplies a default GitHub integration and minimal examples.

**Execution integration.** An agent-provider adapter launches and interprets model sessions. A process supervisor owns operating-system processes. These are separate responsibilities: a provider change must not require rewriting recovery logic.

**Interaction integration.** A local CLI and shared web console are first-class interfaces. A versioned project service exposes the same validated operations to both. The console keeps a private registry of project endpoints and combines read projections; each project service owns its canonical state, authorization and command receipts. An optional host adapter wakes an orchestrator, presents questions, or links external work. An unavailable host leaves questions and results inspectable locally. See the [shared console contract](web-console.md).

Use ordinary modules and explicit interfaces initially. Each integration must prove a real replacement point; avoid making every helper configurable.

## Responsibility and authority

| Actor | Responsibility | Authority boundary |
| --- | --- | --- |
| Operator | Outcomes, priorities, expensive-to-reverse decisions, spending and policy | Grants authority explicitly; can stop work |
| Orchestrator | Queue preparation, exception diagnosis, permitted adjudication, reporting | Acts within recorded policy; cannot invent operator approval |
| Planner | Proposes approach, affected files, checks, risks and questions | Produces a proposal; cannot authorize its own build |
| Builder | Implements the authorized task and addresses findings | Works in the assigned workspace; cannot grant merge or budget authority |
| Reviewer | Examines a named revision and reports substantiated findings | Does not repair its own findings or approve spending |
| Runner | Enforces transitions and performs mechanical operations | Uses trusted adapters and recorded decisions; model output is data |

Approval, review, verification, and merge permission are separate records. A reviewed plan is not permission to build; a green test is not approval to expand scope; an unanswered question is not consent.

The initial trust boundary is the local OS account. Recording an actor name in a CLI argument is attribution, not authentication. Agents running as that same account may have access to its files and credentials; prompt instructions and worktrees alone do not isolate them. Record actual provider enforcement separately from requested permissions. A stronger installation needs separate identities, credentials, and enforced process isolation.

## The change lifecycle

1. **Describe and approve.** A task states its user outcome, build acceptance checks, separately owned checks after merge, risk level, dependencies, and relevant design decisions. Approval references that brief's revision or digest.
2. **Queue and plan.** Queue edits are transactional. Once a change is admitted, a planner reads the code and relevant decisions, proposes a plan, and receives a separate review. Questions hold only the affected task.
3. **Admit.** Every entry point rechecks approval, task revision, dependencies, competing work, main-branch health, and capacity. Taking an item from the queue and creating its flow are one transaction. A deliberate exception is a recorded authorization with its scope and reason.
4. **Prepare.** Create a factory-owned worktree at a recorded base commit; run the project's setup contract; pin workflow, policy, provider choices, and executor version.
5. **Build.** Supply the task, plan, governing context, verification instructions, and bounds. Resume the same builder session for corrections where the provider supports it. If a fresh session is necessary, reconstruct its brief from durable state and inspect existing work before editing.
6. **Review.** A fresh reviewer examines a named head. Later rounds carry previous findings, responses, and an explicit full or delta scope. Report provider/model identity, and record whether builder and reviewer shared a model family.
7. **Integrate and verify.** Incorporate changes from the target branch, address conflicts, and renew review when needed. Run the project gate against the final candidate. Validate individual required checks, their input identity, and evidence, not just a summary saying “passed.”
8. **Decide and merge.** Ordinary changes may merge automatically under the selected policy. Strict changes require a recorded adjudication of the checked diff. Operator-only design or spending decisions remain operator-only even when an orchestrator handles the question. Recheck current authority, stop state, decision validity and evidence before dispatching merge. Merge using an expected-head condition and the qualified target-freshness mechanism described below.
9. **Close out.** Record the merge before cleanup, post checks owed after merge, clear consumed approval, and remove only owned, inactive resources with sufficient preservation evidence. Cleanup failure is a separate state and cannot restart a completed merge.
10. **Learn.** Produce a short factual retrospective: time by phase, wait time, findings, retries, intervention, costs, and unverified acceptance. Keep follow-ups and rule challenges visible and unapproved until their normal approval process completes.

An existing PR may be continued through an explicit adoption path that validates repository, branch, head, ownership, and authorization. “Already satisfied” is another explicit outcome: confirm that no new changes were made and ask the authorized actor whether to close the task.

## Recommended policy defaults

Keep the useful distinction between ordinary work and work affecting access control, saved data, spending, or factory authority. Unknown classification receives the stricter path. Projects may add categories; numeric round limits and risk definitions are policy rather than kernel constants.

Use separate builder and reviewer sessions; a reviewer always starts fresh. Builder and reviewer may come from the same model family (the family-independence rule was retracted in readiness G8). Record the actual pairing so a same-family review is visible, and never describe a same-family review as cross-family.

Bound build, review, gate, and reconciliation loops. When rounds are exhausted, expose the remaining findings and let the designated actor decide. An optional ordinary-change policy can file lower-severity findings as follow-ups. Do not infer that a fixed number of reviews proves correctness.

Default to one active change during adoption, explicit approval for each brief, and manual final merge confirmation until the project's adapters have been exercised. These are commissioning defaults, not a requirement that mature installations keep asking about previously authorized automation. Increasing concurrency or enabling ordinary auto-merge is an explicit policy change.

Keep planning optional by policy, but never build against a plan that is still awaiting a required answer. Plan validity includes the task brief, governing context, base revision, and affected files. Changed inputs trigger validation or refresh. A stopped or unsuccessful refresh must produce an explicit disposition; it cannot silently count as a current plan.

A failed main-branch check holds unrelated admissions. Recovery tasks may proceed under a recorded exception. Unknown or outdated main health is a separate state, with a deliberate bootstrap policy, not an implicit green result.

## Stopping, revocation and resumption

Persist control changes and their reasons before acknowledging them. An **admission pause** blocks new flows, including scheduled and direct launches, while active flows may continue. A **flow stop** blocks that flow's new workflow effects and further progression, including dispatch of prepared attempts. Already-running work may finish unless cancellation is also requested. An **abort request** additionally asks the supervisor/provider to terminate only owned work; it does not prove termination, undo an external write, or establish zero cost. An emergency **stop all** combines an admission pause with stops for every active flow in the named project and offers an explicit abort option. These controls never implicitly span every project registered in the console.

Revoking an approval or applying an emergency policy suspension fences affected flows and requests cancellation of affected running work. Every authorized effect, including retries, merge and deploy, checks current authority and control state at the serialized transition from prepared to dispatching. Record the authority revision used. A stop recorded before that transition prevents dispatch. After that boundary an effect may already be in flight: request cancellation when required and reconcile the actual outcome rather than claiming the stop prevented it. The same-account trust limitation still applies; these controls govern factory dispatch, not arbitrary commands outside it.

Stopped flows continue to collect receipts, record actual effects and costs, and retain unresolved reservations and leases. A late success cannot advance the workflow, trigger merge or authorize cleanup. Permit release requires evidence that the owned work has ended; monetary settlement requires a known cost. Recovery reads and accounting remain available while stopped.

Resume is a deliberate recorded action with a reconciliation note. Unpausing admissions does not restart stopped flows or restore revoked approval. Resuming a particular flow requires valid current authority, reconciled attempts, and revalidation of its task, policy and candidate; a revoked approval needs a new grant. An uncertain attempt cannot become a fresh attempt merely because resume was requested. A stopped flow must not be automatically replaced by a new flow for the same task.

## Durable execution

The minimal durable objects are:

| Object | Information it owns |
| --- | --- |
| Flow | Workflow/policy/executor versions, current step, task snapshot, workspace, stop state and outcome |
| Attempt | One dispatch intent, inputs, command or provider request, authority revision, supervisor identity, limits and receipt |
| Event | An ordered account of state changes and their reasons |
| Approval | Actor attribution, scope, brief or commit identity, validity, revocation and consumption |
| Operator command | Project-scoped client command ID, operation/payload digest, preconditions, acceptance and canonical outcome |
| Control state | Admission pause and emergency suspension, revision, actor attribution and reason |
| Inbox item | A question, notice or note, subject identities/digest, item version, allowed answers, answering role and expiry |
| Delivery | One notification of an inbox item, retry history and acknowledgment |
| Evidence artifact | Content digest, producer attempt, scope, capture time and retention references |
| Reservation or permit | Budget commitment, execution capacity or a named shared resource |
| Schedule | Trigger, timezone, handling window and last claimed occurrence |

SQLite transactions update state and its events together. Events support audit and projections; the design need not pretend to be a complete event-sourcing framework. Retain logs and larger artifacts outside Git under a per-project private state directory. A full-state export is distinct from a SQLite WAL checkpoint and from an independently restorable backup.

An attempt progresses through prepared, dispatching, running, and a terminal receipt, with an explicit uncertain state when its outcome cannot be established. Persist intent before crossing the external execution boundary. A supervisor owns the process, stdout, stderr, deadline, and terminal receipt independently of the runner process. Bind the receipt to the intent digest and attempt identity.

On restart, inspect the existing attempt before creating another. A matching live supervisor means wait. A valid terminal receipt means reconcile and settle once. Missing or contradictory evidence means stop for reconciliation. The reference must not claim exactly-once execution across arbitrary external systems.

Each external action declares its recovery behavior: repeatable read, idempotent write with a stable key, write that can be reconciled by querying external state, or operation requiring human reconciliation. **Zero monetary cost does not make an action safe to repeat.** Opening a PR, posting a comment, deploying, and merging still have effects. Apply provider fallback only when evidence establishes that the original invocation did not start work, or after deliberate reconciliation.

Workflow declarations contain allowed transitions and bounded effect nodes. Models return schema-validated results; trusted adapter code interprets those results. Do not treat model-supplied command strings as executable workflow definitions. This does not remove the shell access a builder legitimately needs inside its execution environment.

## Evidence and merge correctness

Bind review and gate results to the task, base and head commits, relevant policy/check definitions, and clean input tree. Model output saying that tests passed is insufficient. A check record identifies each required check, its outcome, timestamps, logs and applicability. “Not run,” infrastructure failure, product failure, timeout, and unknown are different outcomes.

The starter should invalidate merge readiness whenever the candidate head changes, including a documentation-only change made during finalization. More advanced equivalence rules—carrying review across an unrelated merge, reusing check results, or accepting a combined batch tree—need explicit, independently tested proofs. Defer those optimizations initially.

An expected-head merge protects against a changed PR branch; it does not alone prove that the current target branch was tested. The forge adapter must declare whether target freshness is enforced atomically at merge by a remote condition or qualified forge mechanism, or merely checked locally before a request. A read followed by merge leaves a race even with one active factory flow. Commission auto-merge only after the remote mechanism proves the required candidate/target relationship, including when another actor advances the target after the final local read. Until then, retain manual merge with the residual race visible; a manual confirmation does not itself close it. State which protections the forge enforces and which apply only to the factory's own path.

Evidence retention must preserve unresolved attempts, decisions that cite artifacts, and obligations after merge. Keep an explicit reference index; allow additional project reference discovery. If reference discovery fails, skip deletion. Cleanup should begin as an inspectable dry run. Only remove an owned, inactive artifact after its configured preservation requirements hold.

## Questions, notices and host independence

The canonical inbox lives in the factory store. A notification carries project, inbox, and delivery identities; the recipient looks up the item, checks its current status and authority, and then acts. HTTP acceptance, notification receipt, acknowledgment of a handoff, and a decision are distinct events.

Bind each actionable question to its subject identities and digest, including the relevant task revision, candidate and policy, plus an item version. Accept an answer transactionally only if the item is still open, its version and subject still match current canonical state, the actor has authority, and it has not expired. Refresh required external inputs before relying on them; an inbox transaction cannot make remote state atomic. Changed subjects supersede the question and require a new one where needed. A stale browser submission or delayed host answer cannot authorize a replacement candidate; duplicate submissions cannot record a second decision.

Read and acknowledgment metadata may defer reminders without answering a question. Repeated deliveries are harmless; a late delivery for an answered, expired, superseded or otherwise explicitly resolved item does nothing. An unanswered question remains actionable after it was read, including after consumer failure or handoff. Notices may use an explicit read-to-resolve policy, separate from question semantics. Expiry leaves the blocked action unperformed. Questions for one flow must not stop unrelated work.

The shared console presents a project overview and combined inbox, then project views with active work, queue eligibility reasons, plans, questions and notes, attempt evidence, models, schedules, and history. Every item and command carries its project identity. CLI and page actions share application services and validation. Changing a project selection cannot retarget a pending answer or command. Browser actions need loopback binding and appropriate origin/token checks; this is not a public authentication design. An unavailable project is shown as unavailable or stale, and cannot block healthy projects. Losing the console leaves project execution and CLI access intact.

Presence is optional interaction policy. A host with a usable ask tool can ask a present operator directly; otherwise the question stays in the local inbox. Completion does not depend on a particular chat remaining open. A successor orchestrator reads current state and receives only the unresolved reasoning needed to continue.

## Costs and resource use

Represent money as integer amounts in an explicit currency/unit. Before a paid action, reserve an enforceable maximum within the approved cap. Keep actual spend, unresolved reservations, provider usage, subscription estimates, and historical replay values separate.

Bind each provider invocation to its approved authentication, routing and billing mode. Verify the effective mode using the exact launch configuration, remove conflicting inherited credentials/endpoints or cloud-routing settings, and refuse an unknown or unexpected route. A subscription invocation without incremental metered billing must not silently become an API-paid call. Retain nonsecret mode and preflight evidence with the attempt; keep credentials out of durable specs and logs. Recheck this on resume and fallback as well as first launch.

A local reservation prevents concurrent over-admission; it cannot guarantee a provider bill unless the adapter enforces a corresponding pre-call ceiling. Unsupported paid operations stay disabled. If reported spend exceeds a reservation, record the real amount and stop the series rather than clipping the record. Unknown cost keeps its reservation until reconciled.

Keep three kinds of capacity separate: active development flows, heavy machine work, and paid experiment concurrency. Use a simple host-wide resource lease for expensive commands initially; add weighted capacity only if measurements justify it. Include resource waiting separately in timing, and stop only owned processes identified more strongly than by PID alone.

An active-flow limit and spending cap apply to their project unless explicitly defined otherwise. A combined console total is informational and cannot enforce a shared account budget. If a machine or account needs an aggregate cap, its coordinator must reserve capacity across all participating projects before dispatch; otherwise that configuration remains unsupported. Shared heavy-work coordination is required before enabling concurrent heavy work across projects, independent of whether the console is running.

## Additional workflows

- **Main verification:** scheduled whole-project checks, bounded safe infrastructure retry, main health, and recovery admission. Product-flake classification requires project evidence; a failed product check is never silently retried as infrastructure.
- **Architecture audit:** inspect merged work, verify findings against current code, deduplicate and file bounded follow-ups without approving them.
- **Release:** pin a candidate, verify it, obtain the required authorization, capture durable-state invariants, deploy, compare invariants, and stop on unexpected differences. Rollback is an adapter capability with compatibility preconditions.
- **Product evaluation:** exercise fixed user journeys in a real target environment, retain observations, distinguish product and test-infrastructure failures, and publish only claims supported by evidence. Allow due-later outcomes and later reassessment of retained evidence without overwriting the original judgment.
- **Maintenance:** backup, restore, retention, machine sampling, and optional provider-balance notices.
- **Retrospectives:** use the same projections as the dashboard to measure useful merged changes, later regressions, idle capacity, intervention, and where time and money went. Comparative planning experiments are optional and should not be described as causal proof without appropriate controls.

These workflows share execution and evidence machinery. Their product-specific jobs do not belong in the core.

## Improvements to preserve in the reference

The design should retain durability, bounded work, traceable evidence, fresh review sessions, visible questions, and continuous process improvement. Several common implementation shortcuts deserve explicit tests before reuse:

- Approval checked in a queue selector but omitted from a direct launch or readmission path.
- A documented rule that is only a prompt instruction presented as an enforced boundary.
- A provider allowlist, price, or model choice embedded in the workflow engine.
- Runtime updates pinned by commit while schema compatibility between old and new executors remains implicit.
- Finalization edits or target movement leaving the gate tied to an earlier input.
- Repeated external writes treated as safe because the model or command costs nothing.
- Plans invalidated only by file edits while task acceptance or governing policy also changed.
- Operator notes, rules, or live status stored only in a private agent conversation.
- Tests or replay recordings carrying real operational identifiers into a reusable template.

These are design requirements and review targets, not a claim that the proposed system already enforces them.
