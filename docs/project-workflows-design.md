# Project-owned workflows and execution contracts

Status: design in progress, 2026-10-22. This note covers workflow ownership, explicit merge delegation, preserved cleanup of unsuccessful flows, and separate Tasks/Queue console views. The enforcement boundary is adopted (below). Implemented so far: operation contracts (step 1), a first project workflow catalog (step 2, see [Project-owned workflows](project-workflows.md)) and commissioned ordinary merge delegation (step 3). Preserved failed-flow cleanup (step 4) is implemented as an operator path; see [workspace cleanup](workspace-cleanup.md). Not yet implemented: project-owned planning graphs, label-based selection, manual per-task workflow overrides and delegated or automatic cleanup.

## Adopted enforcement boundary

The project decides which safeguards are required. Factotum ensures those requirements cannot be bypassed or falsely reported as satisfied.

"Enforce" means a check in code at an operation boundary that refuses the operation, not an instruction to an agent. The kernel always enforces scoped authority and attribution, exact workflow/candidate identity, authentic evidence from the operation that produces it, owned execution scope, honest recovery from uncertain writes and preservation before deletion. Which reviews, checks and decisions an outcome requires is commissioned policy. The standard profile keeps today's safeguards, and removing a graph node never removes a commissioned requirement. The [safety audit](workflow-safety-audit.md) explains the classification.

## Intended boundary

Projects own their development process. Factotum supplies useful reference graphs and enforces the execution and authority contracts of its operations. A project can keep a reference unchanged, copy and edit it outside `factory/`, or supply another validated graph. Choosing a different order, adding a content review, or omitting a planning review should not require changing upstream files.

A project workflow is declarative, trusted installation configuration. It does not define what counts as a valid merge authorization, independent review, passing check, completed delivery, paid-operation ceiling or verified preservation receipt. Those remain kernel contracts. Arbitrary project integration code still runs within the existing trusted local-account boundary; this design does not sandbox hostile scripts or prevent the account owner from invoking GitHub outside Factotum. The guarantee is that a declarative graph cannot manufacture canonical evidence or bypass the checks attached to Factotum operations.

Separate three concerns:

1. **Process:** project-owned nodes, edges, questions, optional stages and bounded retries.
2. **Permissions and requirements:** commissioned project policy, including who may decide an ordinary merge, mandatory extra reviews/checks, resource ceilings and permitted integrations.
3. **Execution contracts:** core-owned operation validation, supervision, evidence production/consumption, identity binding, publication reconciliation and recovery.

A graph can impose additional requirements. It cannot relax an operation's kernel requirements, expand commissioned permissions, select weaker containment, or turn an observation into authority.

## Current implementation findings

The current code already stores an immutable graph and digest in each flow and records configuration/executor identities. It also has durable attempts, receipts, exact-candidate questions, reviewed plan caches and supervised maintenance. These are useful foundations, but do not yet form a generic workflow execution contract:

- `core/configuration.mjs` generates the change and planning graphs; `workflows/maintenance.mjs` constructs most maintenance graphs. `validateWorkflow()` checks shape, edges, bounds and allowed question roles. It does not prove a delivery graph safe.
- The engine consumes `requireEvidence`, `requireDecision`, `preserveInput`, `heavy` and `evidence` declarations from graph nodes. Making graph files editable while leaving those declarations as the sole enforcement would allow omissions or forged evidence tags.
- `workflows/actions.mjs`, dispatch, settlement, risk aggregation, planning caches and completion read specific fields such as `results.plan`, `results.build`, `results.review`, `results.integrate`, `results.publish` and `results.merge`. Some updates use literal step names. Renaming a node can therefore change behavior today.
- Settlement can adopt generic result fields such as workspace, session, main health and evidence. Project extension outputs need explicit ownership of result types; an arbitrary command must not populate privileged fields.
- `policy.strictDecisionRole` currently also determines the role of the strict merge question. It is not a separate acknowledgment-only delegation. This needs an explicit compatibility decision rather than silently changing its meaning.
- Workspace bundling/release already validates ownership and preserves committed heads. It rejects dirty workspaces. A Git bundle alone does not retain uncommitted tracked changes, untracked/ignored files or the index.

The implementation must remove these accidental coupling points before enabling arbitrary delivery graphs. Existing contracts/tests stay in force during that refactor.

## Operation contracts (implemented)

`starter/factory/core/operations.mjs` is the operation registry. For each core operation it declares:

- **Bindings:** the semantic result slots it fills, such as `plan`, `build`, `review`, `gate` or `merge`. Settlement writes the slot from the operation pinned in the attempt intent, so a node named `implement` that runs `provider.build` fills `results.build` and owns the builder session. A node whose name matches another operation's slot does not write that slot. Graphs may choose a permitted binding with `binding`; legacy pinned graphs fall back to their standard node names.
- **Inherent guards:** `provider.review`, `gate` and the planning operations always preserve their input; `gate` and `main.verify` always take a heavy resource lease; `forge.merge` and `outcome.satisfied` always require a current decision. Graph flags can add these, and validation rejects a flag that tries to switch one off.
- **Evidence minting:** only `provider.review`/`forge.followup` mint `review` and only `gate` mints `gate`, and only from a passed attempt with an acceptable result. Fresh evidence must match the exact candidate and name its producing attempt. Trusted commands and extension operations can mint only namespaced observations (`check:lint`, `rehearsal:acceptance`), which questions may require but which never satisfy a kernel kind.
- **Privileged result fields:** `workspace`, `merged`, `proven`, `mainHealth`, `findings` and `machineSample` are adopted only from the operations that own them. Other results have those fields stripped before settlement.

The commissioned profile is the optional `requirements` configuration. It is part of the configuration digest, so changing it is an attributable recommissioning:

```json
{"requirements": {"merge": {"evidence": ["review", "gate"]}, "satisfied": {"evidence": ["review", "gate"]}}}
```

Omitting it selects the standard profile shown. The kernel checks the profile's evidence when a merge or satisfied-outcome question opens and again immediately before `forge.merge` or `outcome.satisfied` is prepared, whether or not the graph's question declares `requireEvidence`. A graph's `requireEvidence` can only add to the profile. A current decision is always required for those two operations; who may give it remains the existing role policy until step 3. Unregistered operations run as unprivileged extensions.

Still open from step 1: decision questions are still identified by the `mergeDecision`/`satisfiedDecision` flags (omitting one fails closed at the merge boundary rather than bypassing it), flow-kind completion semantics, and diagnosing unsupported graphs at commissioning instead of dispatch.

## Workflow sources and ownership

Introduce a versioned workflow catalog in project configuration. The first implementation should use bounded JSON files, with no executable workflow modules, network imports or arbitrary expression evaluation. Paths must be relative to the project root, resolve within it, and stay outside upstream-owned `factory/`. Validate ordinary files, reject redirected/symlink paths, bound file size/node count, and retain exact source bytes as a private compiled artifact.

Suggested layout:

```text
factory/references/workflows/        upstream reference definitions, managed by updates
project/workflows/                   project-owned copies or original definitions
project/workflow-catalog.json        project-owned selection and source declarations
project/integrations/                project-owned extension commands
```

Illustrative catalog syntax (not an available configuration API):

```json
{
  "version": 1,
  "definitions": {
    "standard": {"reference": "delivery.standard", "referenceVersion": "PINNED_VERSION"},
    "content": {"path": "project/workflows/content-delivery.json"},
    "planning": {"reference": "planning.reviewed", "referenceVersion": "PINNED_VERSION"},
    "source-refresh": {"reference": "maintenance.source-sync", "referenceVersion": "PINNED_VERSION"}
  },
  "selection": {
    "delivery": {"default": "standard", "rules": [{"category": "content", "workflow": "content"}]},
    "planning": {"default": "planning"},
    "maintenance": {"operations": {"source.sync": "source-refresh"}}
  }
}
```

A reference selected as-is is pinned to its version and content digest. Adopting a new upstream release cannot silently commission a changed reference. Copying a reference creates project-owned files that upstream adoption never overwrites. Provide an export command for the fully resolved graph and an upstream-reference comparison/migration report; avoid introducing a template programming language in the first version.

Start with references equivalent to today's standard change, reviewed planning and built-in maintenance graphs. Additional variants follow real requirements and get the same qualification. Do not ship a collection of nominally supported variants without testing their failure/recovery paths.

## Selection and commissioning

Selection is deterministic over normalized, approved task facts. Support task category/type first and explicitly mapped source labels next. Persist the routing facts from the source adapter; do not consult a mutable live label midway through a flow. Separate routing labels from workflow lifecycle labels such as in-progress/review. Custom issue sources must be able to supply the same normalized facts.

Reject ambiguous matches instead of choosing an undocumented first match. A documented explicit priority can be added if needed. No match uses a declared default; without a default, admission fails with a useful reason. Manual workflow overrides are operator actions bound to the task revision, not an unrecorded orchestrator choice.

Compilation resolves a catalog entry into an immutable execution plan containing:

- source paths/reference identities and exact source digests;
- normalized graph and selected operation-contract versions;
- semantic input/output bindings and required evidence;
- selection rule and task routing-fact digest;
- commissioned policy, role and integration identities;
- the compiler/executor version and a final compiled digest.

Workflow files must be committed and reviewed through the project's normal process before delivery commissioning. Store their bytes/provenance with the configuration generation. Doctor validates the catalog, role permissions, operation support and required integrations, and qualifies the same compiled artifact that admission will use. Editing a file is not a live reload or a new grant. Admission refuses uncommissioned source drift.

Task approval binds the selected workflow/contract/policy identity as well as the task brief. A routing or selected-workflow change invalidates the affected approval and ready plan. A prepared dispatch rechecks those bindings. Approval under one process must not quietly become permission for another process after a catalog edit.

Use drained activation initially, consistent with current executor upgrades. Existing flows retain their pinned graph, receipts and history; never rewrite them to the new graph. A workflow edit in a candidate checkout does not replace the controller's compiled graph during that same delivery. Its activation is a separate reviewed, commissioned change. Do not require mixed-version rolling execution for this feature.

## Semantic operations and evidence

Replace positional result conventions with explicit semantic bindings. Nodes can be named freely; receipts identify both node ID and operation. A compiler may expose compatibility views such as `results.review` while migrating internals, but operation behavior must not depend on a node being called `review`.

A typed core operation registry defines required inputs, permitted result schema, evidence it can mint, inherent preservation/resource requirements, and external-effect/reconciliation semantics. Examples:

| Operation family | Required kernel facts | Evidence or outcome it may produce |
| --- | --- | --- |
| Source verification | Current source/config/task identity and dependency checks | Pinned source observation |
| Workspace preparation/adoption | Approved scope, owned paths, exact base/candidate | Owned workspace identity |
| Planning/review | Current brief/context and supported provider permissions | Typed plan/review observations |
| Build/commit/integration | Task authority, owned workspace, applicable plan contract, bounds | Candidate identity and retained worker/commit results |
| Candidate review | Exact candidate, independent qualified reviewer, schema and risk protocol | Candidate-bound review evidence |
| Verification gate | Required commissioned checks, exact candidate/input, resources, quiescent successful attempts | Complete candidate-bound check evidence |
| Merge decision | Current review/check evidence, task/workflow/policy identities, permitted actor | Exact-candidate attributed authorization |
| Forge merge | Current authorization plus source/target/PR checks and configured merge mode | Proven remote merge receipt |
| Task completion | Proven merge, or the separately authorized already-satisfied contract | Completed task outcome |
| Workspace archive/release | Target ownership, settlement, preservation and cleanup grant | Preservation/release receipts |

A failed, uncertain, dirty, wrong-head or schema-invalid attempt cannot mint privileged evidence, even if it emitted plausible JSON. An `evidence:"review"` label on a custom shell command cannot create independent review evidence. The same applies to main health, workspace ownership, sessions and merge results.

Operation requirements apply at validation/admission, immediately before dispatch, and during settlement. They do not disappear if a graph omits `requireDecision`, `requireEvidence`, `heavy` or `preserveInput`. Those fields can remain as project assertions or presentation hints, but cannot be the authority source. Reject contradictory declarations.

Evidence includes its typed producer, attempt/receipt, exact input/output identity, task/workflow/context/policy binding and provider independence where relevant. A later mutation invalidates dependent evidence. Repeated and parallel reviews use explicit named bindings and bounded aggregation, rather than overwriting a magic `results.review` slot. Unqualified project observations cannot satisfy core review/check requirements.

Planning and plan review are process choices unless the commissioned profile requires them; existing `planning:false` already permits delivery without that phase. Final independent review and candidate verification are requirements of the standard profile, not universal kernel rules. A project can change them only through commissioned `requirements`, never by omitting a node. It can add content-specific review or extra gates. It cannot satisfy a `review` requirement with an exit-0 shell command: trusted commands mint only namespaced observations. Explicit existing bounded-review/adjudication protocols remain supported contracts, not graph loopholes.

Static validation should reject unsupported operations, illegal capability claims, inconsistent bindings, unbounded cycles, invalid roles and obvious missing producers. Bounded graph analysis catches unreachable/missing proof paths. Runtime checks remain authoritative: static reachability alone cannot prove freshness, independence or external outcomes. Unknown operations/contract versions fail commissioning.

Extension commands declare narrow observation schemas, deadlines, resource needs and permitted effects. Projects can add steps through those extension points, but kernel-owned capabilities require a core adapter or a separately qualified extension contract. Provider billing ceilings, independent observations and release target guards remain necessary even when the surrounding graph is project-owned.

## Explicit decision roles and automatic merge

The workflow declares the question and requested role. Commissioned policy supplies the maximum delegation; a graph cannot grant itself more authority. Show both the requested and effective role in Settings and on the question.

For an initial ordinary merge delegation:

- The operator commissions permission for an orchestrator to make explicit merge decisions on ordinary effective risk.
- The project graph requests that role on its merge-decision node.
- The kernel recomputes effective risk, required evidence and actor permission when opening the question, accepting an answer and dispatching the merge.
- Default/strict final merge authority remains operator. Merely requesting an ordinary role cannot authorize an escalated strict candidate.
- The operator can always answer, stop or revoke. No caller impersonates `operator` to use delegated authority.

The resulting authorization retains the real actor and exact head/tree, task, workflow and policy identities. It is not `autoMerge`. A decision is still required for each candidate, so it uses the existing explicit/manual merge mode rather than claiming strict remote target-race qualification. Keep the existing disclosed target race for that mode; delegation does not improve it. Auto-merge continues to require its separate policy and remote qualification.

Before implementing this, explicitly migrate the legacy combined `strictDecisionRole` behavior. Represent strict-review acknowledgment and final merge permission separately. Do not silently revoke an explicitly configured legacy strict delegation, and do not silently import it as a new strict merge grant. Surface it as a migration decision, retain the old commissioned generation until drained, and require explicit operator commissioning of the replacement. The operator-only strict final-merge default is not an assertion that every project must permanently use that policy; broader delegation would need its own explicit supported contract.

## Cleanup of unsuccessful workspaces

Expose a separate cleanup control flow, outside the original development graph. A failed or abandoned development flow should not need to resume its old executor to preserve and release its workspace. A stopped flow must be explicitly retired from further execution before its checkout can be deleted.

Proposed sequence:

1. Produce a read-only cleanup plan for a canonical flow ID. Resolve the workspace from its owned manifest, never a caller-supplied arbitrary path. Show committed head, dirty/index/untracked state, lease/attempt status, reusable-cache or successor ownership, PR/publication uncertainty and the proposed preservation scope.
2. Authorize a bounded archive-and-release job with the plan identity, exact ownership/head/content identities and an operator note. Operator is the default cleanup role. An orchestrator needs a separately commissioned cleanup delegation; record the actual requesting actor and policy grant, never fabricate an operator attribution.
3. Acquire exclusive cleanup ownership. Fence resume, replan, cache reuse, workspace transfer and other cleanup attempts. Require all attempts/supervisors/leases proven quiescent. Unknown external writes or open PR dependencies must be independently reconciled; archiving bytes is not reconciliation of a merge or publication.
4. Preserve committed history in a self-contained verified bundle. For dirty workspaces, also retain a bounded complete working-tree snapshot and index/staging state, including deletions, untracked and ignored files. A bundle alone is insufficient. Preserve symlink entries without following them outside the tree; reject unsupported special files, redirected ownership/archive paths, changed contents and exceeded archive bounds. Private ignored files stay in private state, never webhook payloads or public artifacts.
5. Verify the retained archive against its manifest/content digests and qualify restoration. Persist durable archive intent/receipts before removing anything. Recheck ownership, head/content, PR conditions and quiescence immediately before release.
6. Remove only the owned local worktree and exact owned local branch, record the release receipt and keep original flow/attempt/retrospective evidence. Retrying the same cleanup must reconcile an interrupted removal, not re-create work or discard a partial archive. Released/retired flows cannot resume or replan against a missing checkout; new work uses a new flow.

A ready planning cache or workspace transferred to a successor is not abandoned storage. Release must recognize current ownership across those references and fail closed. An archive held by a cleanup record must itself be protected by normal retention. A failed archive leaves the workspace intact. If a partial deletion cannot be proven, preserve the cleanup hold and require reconciliation.

This should work for earlier settled failed flows after a drained executor upgrade, without weakening their historical receipts. The new cleanup job runs under its own current, commissioned authority and references the old immutable evidence.

Keep automatic failure cleanup out of the first implementation. After archive/restore/crash recovery is qualified, an opt-in policy could enqueue this same canonical path under explicit scope/limits. It must not use a second weaker deletion implementation. Never automatically delete dirty work because a build or commit failed.

Remote branches are separate forge resources. The initial cleanup action does not delete arbitrary remote branches. Hosting-provider deletion after a proven merged PR is the existing replacement point. Any future remote-delete action needs its own exact repository/branch/head and PR-state authorization; it must not assume a local cleanup receipt authorizes a remote write.

## Tasks and Queue views

Replace Plan navigation with two project-scoped views. Keep one canonical task model and one canonical queue; this is a presentation split, not duplicate task ownership.

**Tasks** owns the source/task lifecycle: source sync and last observation, eligibility/source state, current revision, approval/revocation and selected workflow, approved-but-idle status, task detail, approve/revoke/start/queue actions, and links to flows. Task rows must distinguish never approved, explicitly revoked and approval invalidated by changed brief/workflow. Those distinctions should derive from retained canonical facts rather than guessed presentation state.

**Queue** owns execution readiness: queued order, priorities and pins, remove/dequeue, planning window/capacity, preplanning status and ready/expired/invalidated plans, admission diagnostics and observation times, autoQueue/autoPlanQueue policy, and links to Tasks and Timeline. Manual planning actions belong with the queued task/readiness controls. Already active/claimed work remains a linked historical disposition, not an editable queued row. The selected workflow and effective role should be visible when they explain readiness.

A ready-plan artifact can be linked from either view, with Queue as its main management surface. Queueing still does not approve; approval alone still does not start work. With automatic admission off, both views say how work is explicitly started/dispatched.

Keep old `#/p/PROJECT/plan?task=ID` links working through a Tasks alias that preserves project ID and task selection. A bare old Plan link should route to Tasks and offer Queue navigation. Update Overview, Inbox, Timeline, keyboard/tab navigation, browser drafts and documentation links together. Cross-project navigation must keep the existing project binding and conditional command rules.

The current bounded snapshots should not become a hidden data-loss hazard during this split. Source task pagination and full queue identity need explicit read-model support. Do not send a replacement order containing only visible rows. Prefer version-bound queue insert/move/remove operations that preserve unseen rows; retain whole-order replacement only when the complete order is known. Keep drafts attached to their original project registration and reject concurrent edits.

## Implementation sequence and acceptance

1. Extract operation contracts and replace node-name dependencies while keeping today's reference behavior. (Largely done; remaining items are listed under Operation contracts.) Test renamed/reordered equivalent graphs, settlement schemas and every privileged operation independently of node flags. No arbitrary custom graph adoption yet.
2. Export/version the current reference graphs, add project-owned catalog loading/compilation and deterministic selection. Add source/workflow/approval pinning, drift checks, drained activation and migration diagnostics. Keep current reference behavior as the initial compatibility path.
3. Add graph-declared explicit ordinary merge roles under commissioned delegation. (The commissioned half is implemented as `policy.mergeDecisionRole` on the supplied graph; see [risk review](risk-review.md). A graph-declared role request, capped by that policy, follows with the catalog.) Migrate the combined strict role semantics explicitly. Verify actor attribution, risk escalation, operator override, stale head/policy rejection and separation from auto-merge.
4. Implement the preserved cleanup control flow with clean and dirty restoration fixtures, exact ownership checks and crash/retry qualification. No automatic failed-flow deletion in this pass.
5. Split Tasks/Queue; this work is largely independent and can land earlier against current graph behavior, then display workflow/role information as that API becomes available. Preserve old links and canonical command semantics.

Required qualification includes two fictional project stacks and a substantially different project-owned workflow with arbitrary node names, omitted optional planning review and an added content gate. Deliberate bypass graphs must fail: merge without current review/checks/decision, fabricated privileged result fields, stale/cross-flow proof reuse, strict delegation through an ordinary role, missing resource/ceiling requirements and false completed-delivery endings. Exercise workflow edits between approval/admission/prepared dispatch and source-label selection changes. Include uncertain remote writes, supervisor loss and pending questions after upgrades.

Cleanup qualification must restore exact committed and uncommitted content, executable bits, deletions, staged/unstaged differences, ignored/untracked files and symlink entries in a disposable project. Simulate death before/after archive publication and during worktree/branch removal; prevent deletion with live leases, dirty-content races, open/unknown PR state, reused cache/successor ownership, corrupt archives and altered branch heads. Verify runtime evidence/archives survive retention.

Tasks/Queue qualification covers old deep links, mobile layouts, source refresh/approval/start/queue feedback, planning caches, held admission reasons, stale concurrent reorder/dequeue, large/truncated lists and project switching with dirty drafts.

This sequence does not depend on a particular conversation host. Host webhooks consume canonical state and attributed decisions; project workflows, state, recovery and cleanup remain operable through the local CLI and console.
