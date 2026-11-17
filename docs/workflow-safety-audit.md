# Initial audit of proposed workflow safety enforcement

Status: boundary adopted 2026-10-22. Gaps 1–3 below are addressed by the operation contracts described in the [design](project-workflows-design.md#operation-contracts-implemented); gaps 4–6 remain open. Original audit, 2026-10-22. This reviews [the project-owned workflow proposal](project-workflows-design.md) against the current code. It does not enable custom delivery graphs, change runtime policy or establish an adversarial sandbox. The Tasks/Queue implementation is separate delegated work.

## Overall finding

The proposed separation of project process from core execution is sound, but the proposal puts too much development policy into the kernel. Revise it before implementation. Factotum should enforce accurate, authorized execution under a commissioned policy; its reference profile should express the development practices that are usually desirable. The existing standard profile retains today's safeguards by default. Making those requirements configurable must be an explicit, attributable commissioning change, never an accidental consequence of omitting a node.

An independent review is a policy requirement. The inability to counterfeit required review evidence is an engine guarantee. These are different promises.

## Enforcement classification

| Concern | Kernel guarantee | Project/profile choice |
| --- | --- | --- |
| Authority | An effect has a current, attributable grant scoped to the intended project, resource and operation; graph content cannot grant itself permissions | Manual task approval, schedule/configuration grants, permitted decision roles, explicit per-candidate versus authorized automatic decisions |
| Workflow/config identity | Execute the commissioned and pinned meaning; reject silent substitution or unapproved drift | Graph steps, order, selection rules, permitted variants, optional stages |
| Evidence integrity | Only a qualified typed producer creates a given canonical fact; preserve receipt and complete scope; reject stale or substituted evidence | Which evidence is required for each operation/outcome, permitted reuse, freshness windows and exception mechanisms |
| Review | If the policy requires review/independence, enforce the specified reviewer/scope and retain the actual result | Whether review is required, which reviews, allowed independence exceptions, escalation/adjudication rules |
| Verification | Do not claim a check ran/passed without the corresponding successful, quiescent, scoped result; satisfy every configured requirement | Required checks and environments, whether a task type has checks, safe retries and acceptable reuse |
| Merge/publication | Correct repository/candidate, current permitted authorization, accurate effect outcome and no blind repeat after uncertainty | Role of the decision maker, whether a question is needed, reference manual/automatic modes and stronger remote protection |
| Ownership/containment | Execute in the intended owned scope with supported supervision; do not claim quiescence while known writers remain | Supported execution backend, workspace strategy, named resource classes and commissioned ceilings |
| Recovery | Durable intent/receipt linkage, stable operation identities where supported, uncertain outcomes stay uncertain | Retry/correction process, escalation recipient, acceptable recovery procedures |
| Preservation | Honor declared preservation requirements and canonical references before removal; retain receipts and prevent reuse of released ownership | Which disposable/reproducible files need preservation, archive/retention policy, cleanup role and timing |
| Completion | A terminal graph node is not proof of a merge, release, test result or other external outcome | What constitutes completion for a task type and which outcomes are acceptable |

No graph flag may remove a requirement imposed by the commissioned profile. Conversely, a generic kernel should not invent an extra process requirement that the project never selected. Unsupported contracts fail commissioning rather than being silently weakened.

A content-only workflow might require an editorial review and link check with an orchestrator decision. A data migration might require independent review, migration/restore checks and an operator decision. Both use the same authority/evidence machinery without pretending their processes are identical. If a profile deliberately requires no tests, Factotum must not describe its result as tested; actual observations and omissions remain visible.

## Corrections to the proposal

### 1. Remove universal process mandates from the kernel

The proposal currently says final independent candidate review and candidate verification are universal delivery merge prerequisites. Move those requirements into the standard delivery profile. A project workflow can omit them only if the separately commissioned requirements allow that omission. A copied graph cannot weaken a standard profile simply by deleting its review or gate node.

Similarly, manual task approval, a green-main prerequisite, strict/ordinary risk labels and human final decisions should be supported reference policies, not assumptions in every generic flow. There still must be an appropriate current authority grant. Recovery from red main, approved schedules and qualified automatic merge already show why one universal approval/health process would be inaccurate.

Risk handling needs the same distinction: preserve the actual assessments and apply the selected escalation/downgrade rules. Do not hide a contrary assessment or silently drop a safeguard. The taxonomy and explicitly authorized exception process belong to policy.

### 2. Keep evidence reuse explicit rather than forbidding all cross-flow evidence

An absolute prohibition on cross-flow evidence would break useful existing plan caches and exact-input main-check reuse. Enforce the capability's full applicability and an explicit transfer/reuse rule: task/workflow/context/policy where relevant, exact candidate/input definitions, expiry, producer/receipt provenance and current ownership. Reuse must not refresh its original observation timestamp or make old evidence appear newly executed.

A proof token carrying only head SHA is insufficient. The candidate tree, check/review definition, relevant configuration and context, environment assumptions and producer are part of its meaning. Required scope differs by evidence type; not every observation needs the same tuple.

### 3. Do not overstate what evidence proves

A digest detects drift relative to recorded bytes; it does not authenticate a hostile local account that can alter state and recompute digests. A model's signed/structured report is still a model assertion, not proof that its reasoning is correct. A passing check proves an observed execution result, not that the check suite is adequate. Store machine observations, model assertions and operator attestations distinctly.

The trusted local-account boundary remains. A project-owned script with unrestricted credentials and shell access can bypass the factory by calling external tools directly. An operation registry and JSON validator are not a sandbox for such a script. Enforcing restrictions against hostile integrations would require a separate isolation/credential-broker design and qualification.

### 4. Separate stopped authority from irreversible effects

The operator can revoke permission for further dispatch and request cancellation of running work. That does not undo a write already accepted remotely or guarantee cancellation wins an in-flight race. Check authority immediately before dispatch and at the effect boundary, retain revocation times and report races honestly.

Likewise, leader exit 0 is not sufficient success if containment failed, but a failed execution receipt does not prove that no external write happened. Preserve the separate facts: execution failed; publication may be known, absent or uncertain. Reconciliation must validate the specific operation without manufacturing provider success or repeating a possibly completed write. Do not promise general exactly-once remote execution.

### 5. Treat cleanup restrictions as a contract plus conservative defaults

A bundle cannot preserve dirty/index/untracked/ignored bytes. Deletion must satisfy the selected preservation requirements, with exact ownership and quiescence, and must not invalidate an active successor or cache reference. These are essential guarantees.

Preserving every ignored cache forever, or forbidding every local release while a remote PR remains open, is a conservative default rather than a universal law. A project may classify reproducible caches as disposable or archive and release a local checkout while deliberately keeping its remote PR. Such a contract must retain the required recovery resources and external-effect uncertainty, and must never claim that local release closed the PR or completed delivery.

The first cleanup implementation should stay conservative until snapshots/restoration and interruption recovery are tested. Relaxations need explicit supported policies rather than blanket force-delete options. Resource/size limits must fail before deletion and explain what remains preserved.

### 6. Keep upgrade and source-management choices explicit

Immutable flow meaning is essential. Requiring every future architecture to drain all projects or every workflow to be Git-backed is not a fundamental safety theorem. Drained per-project activation and committed project files are appropriate initial supported defaults, consistent with the requested adoption model. A future reviewed artifact source or mixed-generation runtime would need its own provenance and compatibility contracts.

Editing an upstream reference through an update must still be reviewable and re-commissioned. Workflow, adapter and policy bytes used at dispatch must match the activated generation; pinning a catalog filename alone is insufficient. Candidate edits to workflow files cannot self-activate during the same delivery.

## Concrete current implementation gaps

These are reasons not to expose arbitrary graphs yet. They are not a claim that the current supplied reference path has been demonstrated bypassed.

1. **Graph-controlled guards.** `core/engine.mjs` reads `requireEvidence` when opening questions and invokes `verifyDecision()` only when a node sets `requireDecision`. Resource selection uses `node.heavy` in `workflows/actions.mjs`. The forge worker adds its own checks, so deleting one flag is not proof of a complete exploit; it does mean the proposed generic safety boundary is not centralized or independently specified.
2. **Privileged result adoption.** Settlement in `core/engine.mjs` recognizes fields such as workspace, main health, sessions and merge outcomes. A generic extension-result path must not be able to populate these solely by returning fields with those names. Validation must bind operation type, observed outcome, receipt, identity and applicable authority.
3. **Node-name semantics.** Planning, builder sessions, risk aggregation, plan-cache completion and post-merge health behavior still depend on literal step names or result slots. A custom graph with equivalent operations and renamed nodes can lose required behavior. Typed semantic bindings must replace those conventions.
4. **Role/policy coupling.** `strictDecisionRole` currently affects the strict merge question and exact-head acknowledgment. `autoMerge` is another path to the orchestrator role. The proposed design needs separate, comprehensible grants rather than inferring all merge authority from a question's role string.
5. **Outcome semantics tied to flow kind.** Terminal `change` flows require a merge/already-satisfied proof, while generic terminal flows have other behavior. A loader must not allow a project to select a weaker family to run a privileged operation or mint an incompatible completion claim. Enforce each operation/outcome contract independent of presentation labels.
6. **Static validation is structural.** `validateWorkflow()` validates supported node kinds, edges, time/cost/loop bounds and role syntax. It accepts a nonempty operation name without establishing a supported operation/evidence contract. Unknown operations currently fail later. Catalog commissioning should diagnose unsupported or impossible graphs before work starts.

## Recommended contract structure

Use a small core of typed execution facts and authorized effect boundaries, plus versioned commissioned profiles that say what evidence each effect/outcome requires. The project graph supplies scheduling and semantic bindings between them. References provide a tested standard combination.

Do not make the registry an unchecked list of callback functions that can mutate canonical state. Each operation declares its allowed result schema and capabilities; the kernel validates settlement and mints only those facts. Extensions should initially produce namespaced observations. Supporting a new privileged fact producer is a separate adapter contract and qualification decision.

Static graph analysis can prove bounded structure and reject obvious missing bindings. It cannot prove runtime review quality, exact remote state, current permissions or that an external write did not occur. Recheck the relevant dynamic contract before each effect and validate its receipt afterward. Failure and recovery paths need the same checks as the happy path.

Preserve a distinction between policy configuration errors and runtime holds. A profile requiring independent review with no possible producer should fail commissioning. A previously valid graph whose source changed or whose evidence expired should be held with an actionable reason, without discarding its retained evidence.

## Validation that matters before custom delivery graphs

- Rename/reorder equivalent nodes; prove the same grants, evidence, session continuity, risk observations and outcomes are retained.
- Remove or forge graph guard flags; required operation contracts still apply.
- Submit a custom result claiming review/main health/workspace/merge success; privileged facts are rejected unless its producer is authorized and validated.
- Exercise valid profiles with different optional stages, including a content workflow, while the unchanged standard profile retains its current safeguards.
- Try stale heads, task/workflow/policy/context changes, revoked grants, reused receipts, duplicate/out-of-order wakes, unsupported contracts and incomplete checks.
- Prove permitted cache/check reuse works without timestamp laundering or unauthorized ownership transfer.
- Kill leaders/supervisors around external writes and preservation/removal. Distinguish known outcomes from uncertainty and reconcile without duplicate effects.
- Test operator override, explicit delegated decisions and automatic decisions separately, including risk escalation and revocation races.
- Restore dirty/staged/deleted/untracked/ignored/symlink data before qualifying automatic cleanup. Fail safely for live writers, transferred ownership, archive corruption and changed branch heads.

The design decision to settle first is the boundary itself: engine-enforced truth, authority and ownership; project-selected process requirements. Changing that boundary affects the compiler, policy schema and migration plan, so the workflow implementation should wait for this discussion. The independent Tasks/Queue work need not wait.
