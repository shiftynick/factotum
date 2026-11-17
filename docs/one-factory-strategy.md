# One-factory implementation strategy

Status: strategy and qualification plan, 2026-11-13. Baseline: dev.78. Change numbers refer to the operator's numbered one-factory plan of the same date. The [progress record](one-factory-progress.md) is the current status authority for this programme; this document describes the intended sequence, not completed work.

## Scope and decisions

Factotum is the selected base. Preserve project-owned workflows, commissioned policy, canonical evidence and authority, supervised effects, exact-candidate verification and drained upgrades. Keep the reference generic and host-independent. Host-specific supervision belongs behind an integration boundary. Existing projects' configuration changes, branch protection and activation are separate from shipping core support.

The accepted direction includes quiet notifications (1), candidate-path automatic merge (2), intent and decision records (5–8), ordinary delta review (10), fast checks (11), builder environment capabilities (12), category/goal/cost reporting (14b) and usage accounting (16). The starter must carry the handoff, original-request and operator-question practices as well as code examples. These practices cannot be represented as enforced capabilities before their corresponding core changes exist.

The implementation order is ours to manage. Operator decisions and their implementation boundaries:

| Decision | Recommendation or boundary | Blocks |
| --- | --- | --- |
| D2: branch qualification and its document-workflow consequences | Qualify every actual workflow target. Present document-workflow options before applying protection. | Live qualification/configuration changes and automatic-merge activation, not core development |
| D3: delegated task approvals and operator-owned decisions — settled 2026-11-13 | Require stored, operator-issued grants covering the exact scope of delegated brief approvals and substantive operator-decision dispositions. Keep ordinary operational delegation separate. | No remaining policy decision; implementation and qualification of 7/8 still required |
| D4: when to review agent-chosen product behavior — settled 2026-11-13 | Collect other agent-chosen user-visible product choices for operator review before release. Ask earlier for explicitly operator-owned or conflicting decisions; these cannot merge unresolved. | No remaining timing decision; implementation and qualification of 6 and its release integration still required |
| D5: what work to limit | Report approved category, named goal and cost separately. Choose no admission quota on the operator's behalf. | 14c only; reporting 14b can proceed |
| D6: outcome-level delivery versus individual tasks | Preserve the existing route until its results and completion evidence have been audited. | A future replacement/absorption design, not this programme |

The operator selected D3 and D4 on 2026-11-13. Direct operator approvals remain valid; the scoped-grant requirement governs delegated approvals and answers. A general permission to operate the factory is not a scoped grant, and the orchestrator cannot issue itself operator authority. Delivery of a decision report, acknowledgment or silence is not evidence of the required pre-release review. These are target policies, not claims that the current runtime enforces them.

Factotum as the base and implementation phasing are already decided. Paid Codex credits are allowed: change 15 is withdrawn, and no Codex credit hold is planned. This does not authorize unrelated paid adapters or changes to their spending controls.

## Sequence and release boundaries

These are work batches, not a promise of one release per row. Ship independently qualified slices rather than accumulate one large change. Do not activate automatic merging in any project before the decision hold is implemented and qualified.

### A. Establish measurement and remove needless wakes — 16a/16b, then 1

Define the accounting contract first, then fix Codex attempt attribution and align Stats/exported measurements. Preserve raw provider observations. Record uncached input, cached input, cache writes and output separately, including whether a provider reports per-turn or cumulative values. Count each attempt/session segment once; explicitly handle counter resets, duplicate receipts, missing/failed attempts and resumed sessions. Do not subtract every provider's usage blindly. Distinguish measured usage, list-price estimates, known spend and unknown spend; CLI subscription access is not proof that account credits cost zero.

Use versioned, additive projections for historical corrections, not edited receipts or invented historical numbers. Define window semantics: attempt time, flow completion cohorts and admission cohorts are different measurements. Publish the same definitions and fixtures for dashboard and external consumers.

Then add the quieter notification level. Suppress successful terminal summaries while retaining questions, substantive resolutions, approval changes, failures, stops and actionable obligations. A decision report under change 6 is actionable content, not a reason to restore every success wake. Preserve History and describe the treatment of deliveries already queued before a policy change.

This batch can proceed without answers to the outstanding policy questions. Supervision measurement (16c) starts with a host-neutral record contract; its host adapter is qualified in batch E.

### B. Establish intent and authority together — 5, 6, 7 and 8

Bring scoped grants (8) forward from the proposed later phase. Shipping a decision hold while relying on the existing loosely scoped delegated answer would leave the central gap open. Design 7 and 8 together; direct operator resolution can be implemented first, with grant-backed resolution added in the same authority programme before automation relies on it.

Use distinct records:

- Original request: source, date and verbatim operator text, separate from the derived acceptance list. Quotes are provenance, not authority. Some tasks originate from incidents or maintenance schedules; record their true origin rather than invent an operator quotation.
- Decision obligation: stable identity, task/revision, scope and unresolved/resolved disposition, independently of its presentation as an inbox question.
- Approval grant: operator attribution, exact allowed task revisions or decision scopes, permitted operations/dispositions, validity and revocation. Batch task approval must not imply permission to invent answers to product questions.
- Decision report: model-declared user-visible choices with provenance and lifecycle, not proof that every choice was found or that the operator approved it.

The hold survives expiry, withdrawal, task edits, candidate replacement, retries and restart. Editing a task cannot silently discard an unresolved obligation: it must be explicitly carried forward or substantively superseded by authorized disposition. “Discuss,” a notice acknowledgment, a generic delegation note or an orchestrator's own answer cannot release it. A grant-backed answer may release only the exact choice/scope the operator actually authorized.

Check the hold when creating automatic decisions, accepting a merge authorization and at the serialized prepared-to-dispatch transition. Cover alternate terminal paths such as accepting an already-satisfied task and project workflows; a custom graph must not bypass operator-owned obligations. A hold arriving after remote dispatch cannot undo a merge: retain the race and reconcile the actual result rather than claim it was prevented.

Make approval and applicable decision evidence available to the planner/builder before they spend an attempt asking for it. Keep project-required plan consent distinct from initial task approval. Record command replay, grant revocation and exact scope in tests. The current same-account model prevents accidental command-level misuse, not a deliberate agent bypass through arbitrary shell access; no new claim of independent human authentication is made.

Starter templates land alongside their implementation slices, with clear interim instructions where the capability is not yet available. Workflow/schema changes need compatibility handling for existing task definitions, provider reports and pinned runs. Implement the settled D3/D4 policies: scoped grants for delegated approvals and operator decisions, and collected product-choice review before release. Bind the review record to the relevant decision-report versions and release scope so a later changed choice is not silently treated as already reviewed. Explicit operator-owned or conflicting choices remain subject to earlier resolution.

### C. Complete automatic-merge eligibility — 2, after B

Move path rules earlier than the proposed second phase. Do not use risk classification as the permanent substitute for inspecting actual changed paths. Evaluate added/modified/deleted files and both sides of renames against a commissioned policy for the exact candidate and base; missing evidence means a manual decision. Recheck after integration and before merge, and retain the actual manual versus automatic authority in the receipt.

Extend commissioning from the default target to every target a workflow can merge into. Protection remains enforced remotely, including stale-target refusal. Account for document workflows that intentionally lack gate evidence: do not fabricate a green status or weaken shared branch protection to make them fit. Present viable workflow/target choices for the operator's D2 decision.

Shipping the feature, qualifying an installation and enabling it are three different milestones. No live branch-protection or automatic-merge setting is changed by this strategy. Activation also needs the decision-hold acceptance tests and configured path restrictions; we need not rely on a temporary strict-label workaround for the reference qualification.

### D. Reduce rework — context qualification (13), ordinary review ledger (10), fast checks (11), reporting (14b)

Qualify the path-mapped-context defect before encouraging more selective context. Distinguish the immutable governing context for a reviewed plan from new affected scope or proposed edits to governing files. Do not solve the defect by removing the context validity check. Preserve role-specific guidance and the existing approval/invalidation rules, and test the provider's own instruction-loading behavior before claiming a root instruction file has stopped reaching it.

Ordinary delta review (10) remains the main rework feature. Give findings stable identities and preserve their origin, candidate scope, builder response, reviewer disposition and follow-up evidence. A builder's “fixed” assertion cannot settle a finding. New evidence can reopen one. A defect made reachable by the candidate stays relevant even if its faulty line was untouched. Retain the review chain from a full baseline to the current exact candidate; invalidate or return to full review when ancestry, base, governing context, risk or relevant scope changes. Keep strict policy semantics separate and do not introduce a mandatory extra strict review as an incidental part of this work.

Fast checks (11) use the same structured diagnostic envelope and supervised runner where appropriate. They produce named observations, never gate evidence. Qualify the ignored-file project pilot separately; stale output must not look like a current failure. For the core operation, pin candidate/check identity and return bounded diagnostics to the correct build cycle. Separate product failure, prerequisite failure and resource wait. The default fast profile is bounded and lightweight; a project cannot evade resource coordination merely by calling an expensive command “fast.” Recheck branch/environment prerequisites before the first build and when the base changes. The final gate still verifies the final integrated candidate.

Reporting (14b) follows the usage contract from batch A. The task format currently has category but no canonical goal field, so this is not just a Stats view edit: add the goal/source/approval binding through import, validation and task snapshots before aggregating it. Show category, goal, volume and known/unknown cost without labelling them proof of value. No category cap (14c) is implied.

### E. Experiment with bounded supervision — 3 and 16c

Publish a separate experiment design before implementing a handler. Starter handoff guidance can ship earlier. Start with deterministic filtering/current-state lookup and a shadow handler which cannot mutate the project. Only invoke a model for residual ambiguity. Keep the current consumer as the fallback; do not switch the live webhook as an experiment setup shortcut.

Define stable event/item/version identities, durable ownership of escalations, acknowledgment after durable handling/handoff, idempotent actions and uncertain launch recovery. Qualify duplicates, out-of-order/stale events, crashes at each handoff point, concurrency, host outage and successor handoff. Specify which restrictions are enforced by a command boundary and which are only instructions. Do not give a smaller model the existing full orchestrator authority and describe it as restricted.

Collect usage across every handling and escalation session, with explicit project/event attribution and missing-data counts. Compare equivalent time windows and task/risk mix after the earlier changes; a shorter primary transcript alone does not establish savings. Model/provider selection and live routing belong to the experiment's later decision, not this strategy. The generic interface must permit another host to supply session launch and usage observations.

### F. Qualify builder environment capabilities — 12

Begin the design during batches B–D, but keep implementation and qualification separate from their releases. Prefer supervised dependency preparation/test operations and isolated project/workspace resources over blanket sandbox relaxation. A setup hook that runs only before the builder edits a lockfile is insufficient. Specify refresh after a lockfile change, package availability, writable cache scope, database lifecycle/credentials, concurrency, cancellation, resource leases and retained diagnostics.

Use fictional fixtures to prove a changed offline lockfile can be installed and newly written database tests can run under the supported provider modes. Actual builder tests do not replace independent gate verification. Provider differences and unsupported capabilities must be explicit. Do not add remote native-machine execution or production service access by implication.

### G. Conditional work only — 4, 14c and future delivery-unit changes

Change 4 needs its own design only if the measurements after 1–3 show that factory-owned attention processing is worth moving across the current host boundary. It must not become a second model reading events code already handles. A category quota needs D5 plus starvation/restart/exception semantics. Outcome-level delivery needs D6 and an audit of the existing route's proof and ownership. Migration of an existing specialized factory is outside this request.

## Corrections and qualifications to the supplied plan

1. Change 1 is sound, but successful built-in green `main.verify` is already normally quiet. Not every maintenance completion is an unsuppressed success; inspect its operation/result. Successful target synchronization and normal delivery completions still expose the requested gap.
2. Change 9's ordinary-review reading is correct with default bounds: the first four ordinary phases use the full change. However, strict full/delta/final is not a mandatory three-review sequence. An executed probe showed a clean strict delta returning `pass`, and the reference graph routes that directly to the gate. Later reviews can enter final adjudication. Do not silently add a third mandatory review under the heading of enabling existing policy.
3. Change 11's project-command pilot is plausible from the engine's working-directory and observation contracts. It has not been run end to end in this strategy pass; freshness, recovery and diagnostics remain qualification work.
4. Change 13's conditional mapping failure was reproduced against `actionSpecification` in a disposable Git checkout: planning added a newly mapped path and the subsequent build rejected the changed context digest. This is concrete core follow-up, alongside the already recorded governing-file-edit issue.
5. Change 14a already exists for structured inputs. Text-only prerequisites are not machine-readable declarations. Approval provenance and execution-checkout availability remain distinct work.
6. Change 16's code does store raw Codex turn usage and Stats sums it per attempt. The supplied audit reports cumulative-session double counting; qualify that correction against versioned provider fixtures before selecting subtraction rules. Also resolve input-only versus all-token definitions and overlapping reasoning/output fields. A reduction in cached tokens is not by itself a measured reduction in money.
7. The current task schema lacks a canonical goal field, and doctor qualifies only the default target's automatic-merge protection. These broaden 14b and 2 respectively beyond a view edit or policy checkbox.

## What is not being taken

No Codex credit hold; no automatic category quota; no blanket sandbox disabling; no automatic retirement of an existing outcome-level delivery route; no equivalent-diff carryover of exact-commit merge authority; no removal of planning or independent review. No promised token-saving multiplier or automatic rule that every adopter must install each release immediately. Releases remain reviewable, immutable and adoptable by drained activation, with urgency and compatibility documented rather than an unqualified two-release deadline.

Do not port project-specific record parsing, host prompts or merge logic wholesale. Reuse useful operating principles through generic contracts and project-owned integrations. Existing project policy changes in the source plan's phase 0 are owned by those projects, not performed here.

## Quality and progress discipline

- Start each stateful feature with its record/authority contract, compatibility plan and concrete failure/recovery matrix. Exercise custom graph names and alternate paths, not only the reference graph.
- Use focused tests while developing; run the full suite and both fictional evaluations for each runtime release. Authority/evidence changes need an independent review before qualification is marked complete. Review findings remain open in the progress record until fixed and rechecked.
- Preserve raw evidence, command idempotency, uncertain-effect reconciliation and restart behavior. Snapshot/Stats work must remain bounded and avoid restoring historical-body scans to routine console polling.
- Include console, command help, starter examples, update/commissioning guidance and diagnostics in the definition of done, rather than treating them as a later UI project.
- Record each shipped change by its original plan number in release notes and the progress table, with the exact version/digest, validation scope and remaining live qualification. Do not label local fixtures as live proof or write an unshipped release number into the table.
- Keep the earlier [runtime follow-ups](runtime-followups.md) and [core triage](core-request-triage-2026-11-13.md) open. Source-sync retries, resource waits, responsiveness and stop-capacity diagnostics remain a separate reliability lane. Proven reliability fixes may preempt a batch; assign them a separate reference instead of falsely claiming they implement one of changes 1–16.
- Publish definitions and export fixtures for external auditors. Measurements and adopter activation are reported separately from core release completion. A changed risk mix establishes a new comparison baseline.

This pass changes strategy/progress documentation only. It does not publish a release, switch a project policy, implement a grant/hold or begin migration.
