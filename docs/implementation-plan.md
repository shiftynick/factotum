# Implementation status and remaining work

The reference implements the core, configured delivery, local shared console, operational controls and optional project extension contracts. Implemented code and qualified deployment behavior are distinct: see the [qualification record](qualification.md) for executed scenarios, results and remaining limits. Live qualification results are not implied by this inventory.

## Delivered reference

| Area | Implemented behavior | Installation qualification |
| --- | --- | --- |
| Durable core | SQLite state/events, pinned workflow/config/executor, bounded graphs, intent-before-dispatch, independent receipts and uncertainty | Process and systemd recovery exercises; retain unknown outcomes rather than replay |
| Authority | Brief revision approval, direct/queue admission, revocation, pause/stop/abort/resume, conditional question answers | Test the project's actual roles and trusted-account boundary |
| Delivery | Remote source/target validation, bounded preplanning independent of build capacity, owned current-target worktrees, persistent builder, fresh review, required checks, exact-candidate manual merge and closeout | Real provider/forge execution in disposable fictional repositories |
| Alternative outcomes | Exact-head existing-PR adoption into a replacement owned branch; already-satisfied review/gate/operator acceptance | Original PR disposition remains an obligation; unknown external builder identity requires explicit treatment |
| GitHub | Per-operation API account selection, stable publication markers, lost-response reconciliation, expected-head guard and closing-reference validation | Configured Git authentication, current permissions and declared target-race mechanism |
| Providers | Codex/Claude subscription preflight, schema validation, private traces, permissions/usage identity, builder resume and cancellation | Exact installed CLI/authentication/configuration; unsupported modes fail closed |
| Shared interface | Project sockets, protocol/identity handshake, one local console, combined overview/inbox and durable command recovery | Two distinct projects, service loss, stale bindings and project-scoped actions |
| Operations | Queue/area/path eligibility, flow limits, host resource leases, numeric machine observations, main health and post-merge revalidation, schedules/jobs, notifications and retained obligations | Explicit schedule grants, shared coordinator and project backup/retention policy |
| Preservation | Artifact-aware backup/restore hold, inspected retention manifests, immutable upgrade staging and drain checks | Real restore rehearsal and reviewed preservation/compatibility inventories |
| Feedback | Bounded audit findings, context provenance, rule pushback, attributed regression reports, measured waits/capacity and persisted factual retrospectives | Measurements describe observed samples; they are not causal proof |
| Extensions | Local release/state-invariant/rollback contracts, product observations/reassessment, generic webhook host | Production project adapters and host ownership must be qualified separately |
| Evaluation | JavaScript/Python adoption fixtures, scripted process rehearsal, real-provider harness and local extension labs | Inspect the qualification record; preserve fictional/live evidence boundaries |

Advanced profiles now include configurable issue formats/lifecycle, bounded full/delta review, safe provider fallback, ranked/pinned queues, category capacity, weighted resources, registered flakes, exact check reuse, durable release/evaluation graphs, operator presence, standalone inbox questions and archive-first retention. See [migration](migration.md) and [advanced workflows](advanced-workflows.md) for ownership and qualification.

The template defaults to one active change, reviewed planning, explicit approval, a Claude Opus 5.5 builder and GPT-6.1 Sol reviewer (same-family review is allowed since readiness G8) and manual merge. Unconfigured baseline/acceptance commands deliberately fail. Importing a task, receiving a webhook or reading a question never grants work authority.

## Readiness checks that remain mandatory

1. Run the full deterministic suite and both disposable stack rehearsals. Exercise systemd containment on the actual Linux installation, not only the process fallback.
2. Commission exact provider CLIs and approved subscription authentication. Confirm requested versus enforced permissions, structured output, cancellation and persistent builder sessions. Reject conflicting credentials/routes before dispatch.
3. Run a small complete live task on each fictional stack, including an independently detected controlled defect and builder correction where that claim is made. Verify the actual remote merge, final acceptance and cleanup receipts.
4. Exercise failure paths: remote brief/target movement, dirty candidates, stale decisions, partial workspace setup, missing workspaces, stopped/uncertain effects, delivery response loss and restore holds.
5. Qualify project-specific verification, context, setup and Git transport. A reference's passing fixture does not prove another application's tests or migration safety.
6. Register two projects with one console and exercise overlapping local IDs, one unavailable service, command-response loss and project switching with pending answers.

The executable suites and live harness provide these exercises; this page does not assert all installation-specific checks have already passed. Final evidence belongs in the [qualification record](qualification.md), with version and scope.

## Explicitly disabled or deferred

- **Metered model APIs:** disabled. Paid project evaluation adapters are now supported through installed durable workflows, but default off and have fictional qualification only. Real provider ceilings, receipts and recovery require independent installation qualification.
- **Automatic merge by default:** disabled. It requires explicit behavioral qualification plus live strict required-check protection enforced for administrators. Local target reads and manual confirmation retain a target race. Merge-queue qualification is deferred.
- **Production deployment adapters:** project work. Local labs demonstrate saved-state invariants, uncertainty and unsupported rollback; they do not authorize production deployment.
- **T3-owned durable execution:** deferred. Generic webhook notification is implemented, and T3 integration guidance describes presentation, acknowledgment and handoff. The local factory remains canonical.
- **Remote project transport and public multi-user hosting:** deferred. The current console connects local project sockets under one trusted account.
- **Automatic schema migration and rolling upgrades:** deferred. Current upgrades use explicit compatibility, immutable copies and drained work.
- **Selective cross-head evidence reuse and composite candidate gates:** project check-adapter work. Core cache reuse requires exact verified identities and artifacts; provider fallback is available only for one explicitly qualified, proven-unstarted attempt.
- **Bulk commands and shared budget allocation policy:** deferred. Weighted/load-sensitive shared resource pools and a global paid-dispatch/settlement ledger are implemented; each project still owns its approved caps and allocations. Console totals grant no authority.
- **Other forges and operating systems:** replacement points are documented, but first-class adapters are not implemented. Local release bundles, adoption lockfiles and isolated update branches are implemented; public release hosting and automated publication remain distribution decisions. The license is Apache-2.0.

## Project integration work

Every adopting project still defines its outcomes, actual tests, required governance, risk policy, setup and credential arrangements. Optional releases need deploy/lookup/probe/smoke/rollback contracts. Optional product evaluation needs fixed journeys and independent observations. Retention needs a complete preservation inventory, and upgrades need recovery ownership and compatible executors.

Existing-PR adoption preserves the original branch and publishes a replacement; it does not seize arbitrary external branches. Already-satisfied handling requires explicit selection and operator acceptance. Source issue closure rereads the brief but has a remote read/write race. GitHub sidebar links and actions remain within the trusted-operator boundary. These limits must remain visible when extending the reference.

The next implementation changes should follow demonstrated adoption failures or measured need. Preserve small explicit contracts and independent fictional fixtures when adding an adapter, rather than embedding a project's product assumptions in the core.
