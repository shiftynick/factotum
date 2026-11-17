# Independent design review

Status: documentation review, 2026-10-22. This is not implementation or runtime qualification.

Two separate GPT-6.1-Sol reviewers examined the initial proposal. One compared the research and abstractions with the studied implementation; the other challenged the generic design, adoption plan and optional integration. They used independent sessions of the same model, not different model families. Both initially recommended revision while finding the overall architecture sound.

## Findings and disposition

| Finding | Correction in the proposal |
| --- | --- |
| Stop behavior was underspecified and pinned authority could outlive revocation | Define admission pause, flow stop, abort, emergency stop and deliberate resume. Check current authority at dispatch; reconcile late receipts without advancing stopped work. |
| An answer could apply to a replaced candidate | Bind questions to subject identities/digest and item version; conditionally accept answers against current state and authority. |
| The T3 guide could discard a read but unanswered question | Treat read/acknowledgment as metadata; preserve unresolved questions through crashes and handoff. |
| An approved subscription route could inherit metered credentials | Require verification of the effective authentication/billing route, removal of conflicting settings and refusal of unexpected modes on launch, resume and fallback. |
| Required context, capability and spending controls appeared too late | Make minimum preflight, context provenance and applicable spending enforcement prerequisites of the first real worker. Keep richer diagnostics and optional evaluations later. |
| Target rechecking did not explicitly close the last merge race | Require the adapter to declare remote enforcement versus local checking; test target advancement after the last read before qualifying auto-merge. Disclose the residual race on a local-only manual path. |
| The first usable release boundary was implicit | Define stages one and two as the supervised starter; list automation and extensions that remain disabled. Bring minimum upgrade/recovery requirements forward. |

The authority/stop findings were high priority; the remaining concrete gaps were medium priority or delivery-scope clarifications. These are corrected design requirements with future acceptance tests, not claims that working safeguards now exist. The proposal deliberately strengthens some behaviors rather than preserving every implementation detail of the studied system.

Both reviewers then performed a bounded follow-up on the revised contracts and milestones. Both recommended proceeding to the contract/rehearsal stage, closed their original findings at the documentation level, and reported no substantive contradiction introduced by the changes. This concludes the requested research/design review; it does not authorize or begin implementation.

## Evidence and limits

The design reviewer read all six initial proposal files, including the architecture HTML. The research reviewer read the proposed Markdown, current operating documentation, and targeted execution, stopping, provider and metrics code. The parent checked the cited stop and provider behavior and integrated the findings into the generic contracts and implementation sequence.

The reviews were read-only. No source-project scripts, tests, services, private runtime state or external mutations were used for validation. Coverage was targeted rather than an exhaustive audit. Actual provider behavior, billing enforcement, forge races, recovery and UI behavior still require the implementation-stage evidence in the [readiness plan](implementation-plan.md#readiness-checks-that-remain-mandatory).

At the end of the design pass, document checks found no broken local links/anchors, source-project identifiers or private local paths. The folder then contained only generic design documents and had no initialized Git repository. The studied checkout's commit and clean Git status were unchanged.

No new operator choice is needed to complete this design pass. Deployment-specific authority, provider/spending modes, merge automation, backup/retention and publication licensing remain explicit decisions before enabling the corresponding capability. (The publication license has since been chosen: Apache-2.0.)

## Shared-console design addition

The operator subsequently requested one web interface for multiple projects and selected one Linux machine first, with remote project support left as a future extension. The [shared console contract](web-console.md) adds a private registry, versioned project services, project-qualified views/actions and failure isolation while keeping canonical state and authority in each project.

A GPT-6.1-Sol reviewer challenged the addition and found one medium-priority recovery gap: the console could lose a pending command's identity after its response was lost and the console/browser restarted. The revised contract journals minimal identity metadata durably before submission, recovers the same canonical project receipt, and forbids automatic submission or retargeting during recovery. The journal carries no executable payload and does not replace project authority.

The reviewer rechecked the correction and recommended proceeding, with no substantive concern remaining from this bounded review. Future qualification includes both accepted-command response loss followed by restart, and a crash after journaling but before dispatch. Static checks passed for links, anchors, generic content and whitespace; the updated architecture view was inspected at desktop and phone widths without overflow or console errors. No factory implementation or runtime qualification was performed.

## Initial implementation review

The first runnable implementation was reviewed separately for process recovery and integrated authority/console behavior. Concrete findings were corrected before delivery:

- A worker's process-group descendants could outlive a successful receipt. The supervisor now drains owned descendants, refuses success when descendants survive the leader, and flushes logs before publishing the receipt.
- Stale observational writes could replace settled attempt data. Mutations now reload canonical state inside their transaction and refuse settlement regression or changes to attempts the flow no longer owns.
- Concurrent initialization could replace a project's identity. The initialization transaction now requires absent project metadata; parallel-process coverage checks that exactly one identity wins.
- Socket cleanup could race a replacement runner. The service now removes its socket before releasing exclusive runner ownership.
- Candidate changes after an accepted answer could reach completion. Final decisions now retain their candidate identity, checked again before completion or approval consumption.
- Superseded questions retained answer controls. The actionable inbox now displays only open questions.

Both reviewers rechecked their corrections and recommended proceeding for the local synthetic milestone. Qualification uses real SQLite files, supervised processes, a controller SIGKILL/restart, copied fictional repositories, and both process and systemd backends. The real browser check confirmed that accepting one project's result leaves the other pending, and stopping the remaining flow removes its superseded question after refresh. These results do not qualify real agents, provider billing, GitHub merging or unattended operation.

## Full implementation review

Three independent Sol 6.1 agent sessions reviewed the implemented provider/service, workspace/forge, and operational boundaries. They added regression tests and rechecked corrections. Findings included dirty candidate evidence, stale initial plans, missing-workspace fallback, live-process reconciliation, dropped completed-task status, lost post-delivery obligations, stale schedule starvation, ineffective explicit queue dispatch, referenced-evidence deletion, upgrade verifier mutation, missing activated-version launch, commissioning races, and replay after an interrupted evaluation journey. These now have implementation checks and focused regressions.

Provider/session and transport work was also exercised separately against installed subscription CLIs. The [qualification record](qualification.md) distinguishes these live observations from deterministic fixtures and records the final end-to-end results. Same-model review adds independent sessions; it does not establish reviewer family diversity. Task delivery no longer requires different provider families (readiness G8); each review records the builder and reviewer provider, model and family.


## Completion audit and integration review

The completion audit compared design requirements with normal runtime paths as well as helper tests. It found that several implemented helpers were not yet connected: durable retrospectives, stable audit follow-ups, question/resource waits, canonical rule proposals, machine sampling and bounded preplanning. These are now part of command admission, supervised execution, settlement and console projections, with integration tests.

Separate Sol 6.1 sessions then challenged the new paths. They found that an untouched operator checkout could prevent queue continuity after a merge, ready caches could occupy capacity after revocation, verifier crashes could retain old green health, and audits could inspect stale source. The corrections use owned current-target trees, explicit cache dispositions and preservation obligations, health invalidation before verification dispatch, and retained check evidence. Target movement and cleanup failures hold or preserve work rather than silently replacing it.

The final [completion audit](completion-audit.md) maps these requirements to executed evidence. Review sessions remain bounded same-model reviews; they are not proof against every defect.
