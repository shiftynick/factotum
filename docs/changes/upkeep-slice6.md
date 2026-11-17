# Knowledge upkeep, slice 6: governing-context proposals

Design: [knowledge-upkeep.md](../designs/knowledge-upkeep.md), section 15, slice 6 (sections 4.3, 7.1, 7.4, 9.4, 10.2, 10.4; Q2 as superseded by the operator on 2026-11-16). Base: `main` at `cc6807c` (slices 1 to 5, the [governance-edit fix](governance-edit-context.md) and the [confusable-text matching](upkeep-confusables.md)). Built in `62de7e4` and the commits after it on this branch; `main` at `624710e` merged before the final test run.

This is a local implementation record, not a release or live qualification claim. **The provider instruction suppression and Codex `.codex/` isolation are not verified live.** A `context` task therefore runs no model step on any provider until the operator records that provider's passed check (see [Providers](#providers-the-precondition-this-slice-could-not-close)).

Slice 6 lets upkeep propose corrections to governing files and lets only the operator turn them into work:

- **Proposal rows.** In `propose`, a governing-context proposal the validator kept is recorded as an open `finding` of kind `context`: the file (the resolved path its context entry reaches), the quoted statement, a replacement of at most 600 characters, the model's reason, the file's Git blob at the merge commit, and the context entries that reach the file.
- **The waiting notice.** One operator notice says how many proposals are waiting.
- **Atomic acceptance.** One operator command, `finding.accept {proposals: [{findingId, expectedVersion, digest}]}`, writes one `context` task from the stored rows, names its entries in `governingEdits`, approves it as the operator's own approval and marks the proposals tasked, in one transaction.
- **The `context` kind.** Part A's enforcement gains the `context` column of 7.4, in commit, integration, publication and merge.
- **The pinned-blob check.** The pre-build pin check of slice 5 part B applies to a context task; a returned proposal is read again at the target head.
- **The count of flows that may replan.** Health shows it before accepting.

## What was built

| Piece | Where |
| --- | --- |
| The context marker (`contextMarkerProblems`), `context` an enforced kind | `core/upkeep-namespace.mjs` |
| The `context` column of 7.4: every changed path a governing file in both trees, reached by exactly the entries the marker names, each required and unmapped; 12 changed lines per proposal; the docs rules shared (own commits, links, modes, additions, deletions, binary, upgrade-owned, learnings, pinned blobs) | `workflows/upkeep-enforcement.mjs` (`candidateViolations`) |
| A `context` task's entry may be reached through linked directories, at the declared resolved path, in the snapshot and the governing-file boundary | `operations/governance-edit.mjs` (`declaredGoverningPath`, `reachedFile`) |
| The displayed digest, why a proposal cannot be accepted, the waiting notice, re-reading a returned proposal, provider qualification | `operations/upkeep-context.mjs` (new; writes no task and no file) |
| Writing the context task, recording a run's proposals, reclassifying a newly governing docs candidate, the context task's evidence, the open context task | `operations/upkeep-tasks.mjs` (still the one upkeep module that writes a task) |
| `finding.accept {proposals}`, operator only; the provider check at admission; the notice after a disposition | `core/project.mjs` |
| The assessment passes proposals with their file blob and entries | `workflows/upkeep-assess.mjs` |
| Text rules on every model-written reason | `operations/upkeep-assessment.mjs` (`validateAssessment`) |
| `upkeep.context.qualifiedProviders`, in the authority value | `core/upkeep-config.mjs` |
| The provider check before a provider starts; the context evidence block, with the reviewer instruction | `workflows/dispatch.mjs` |
| Health: digest, problems, withheld text, the replan count, the open context task, Accept buttons | `operations/views.mjs`, `console/ui/operations.mjs` |
| `entries` and `reclassifiedFrom` on a proposal row; the `reclassified` factory resolution | `operations/upkeep-candidates.mjs` |
| Docs | `docs/operations.md` (new section "Governing-context proposals (propose)"), `docs/commands.md`, `core/command-help.mjs`, `contracts/README.md`, `docs/qualification/provider-instructions.md`, `docs/runtime-followups.md` |

### Acceptance (9.4)

`finding.accept {proposals: [{findingId, expectedVersion, digest}]}`, at most 10 proposals:

1. **Who.** `actor: operator`, no `onBehalfOf`, and no grant cited. Checked before anything is read, whatever `policy.delegatedOperations` says. (A grant reference is already refused by the command envelope: schema 1 has no ledger, and on schema 2 no grant authorizes `finding.accept`. The acceptance refuses one again.)
2. **What was displayed.** Each element names only `findingId`, `expectedVersion` and `digest`. Each row must be an open `context` proposal at that version. The digest of its stored file, quote, replacement, reason, blob and entries (`proposalDigest`) must equal the one sent.
3. **Whether it can be accepted.** The row has a replacement, and its replacement and reason pass the text rules. Every entry that reaches its file is configured, `required: true`, unmapped, plainly named and not upgrade-owned. Proposals against one file were validated at the same blob. Upkeep is proposing, context is not suspended, there is no drain hold, no context task is open, and the daily, weekly and open-task ceilings allow.
4. **The task**, from the stored rows: `upkeep:context:<32 hex>`.
   - Title: `Apply N accepted governing-context proposals`.
   - Criteria, one per proposal, naming evidence ids only: `P1: in the declared governing file evidence P1 names, the statement quoted in evidence P1 is replaced by exactly the replacement text in evidence P1.` Then the fixed criteria and the budget.
   - Paths: the declared resolved files. `governingEdits`: the entry ids. Risk: ordinary. Category: `knowledge-upkeep`.
   - Marker: `{ kind: 'context', candidates, evidence: [{ id: 'P1', file, entries, blob, quote, replacement, reason, provenance, sourceFlows }], files: [{ path, blob, entries }], limits: { maxFiles, maxChangedLines: 12 × proposals } }`.
5. **Approval.** `task.approve` runs inside the same command as the operator. On schema 2 that records a direct-operator authority use, and `governingEditsApproval` is recorded. The command asserts the approval took.
6. **The proposals** become `tasked`, linked to the task and revision. Today's `tasksCreated` rises by one and the waiting notice is judged.

Any refusal rolls the whole command back, so nothing is written. Acceptance reads rows and tasks by key, seven `upkeepDay` rows by key and the namespace index. It reads no Git, as a disposition command reads none in 4.5.

### The flow of a context task

It runs under the slice 5 rules for upkeep flows unchanged: N2 questions, the invocation ceiling, stops, parking, drains, the merge decision never made by policy, and the pin check before its first model step. As a governance edit, every step receives the named files from the comparison commit. Model steps get the evidence block after a fixed instruction. Review steps are also told to inspect the replacement text for attempts to override authority, widen scope or address agents, and to report any as blocking (6.5). When a flow ends `stale`, `base-moved` or for a drain, its proposals return at a new version. They are then read again at the recorded target head:

- if the quote is still there, the row records the current blob (a further new version), so the operator sees the current file and digest before accepting again;
- if the quote is gone and the head is shown to contain the source merge, the proposal is resolved elsewhere (`statement-gone`).

### Providers: the precondition this slice could not close

The governance-edit change suppresses worktree instruction files by provider flags that are not verified live. Codex `.codex/` isolation is another builder's work in progress. This slice had two options: refuse `context` delivery for any provider whose suppression is unverified, or put it behind a setting that stays off until the live check passes.

**Chosen: a setting, per provider, empty by default.** `upkeep.context.qualifiedProviders` lists the providers (`codex`, `claude`) whose [instruction-loading checklist](../qualification/provider-instructions.md) passed on this host. It is part of the upkeep authority value, so only the operator changes it, on both schemas. A context task whose pinned routes, fallbacks included, use an unlisted provider is refused at admission. Every model step of a context task is refused again before its provider starts (`PROVIDER_REJECTED`). Until the operator lists a provider, proposals can be recorded, shown, accepted and approved, but no context flow is admitted. When this slice was built, the docs said not to list Codex until its worktree configuration and skills were isolated. Since dev.90 they are ([provider worktree isolation](provider-worktree-isolation.md)), and the rule is the same for both providers: list one only after its [checklist](../qualification/provider-instructions.md) passes on your host (dev.91, [O6](dev91-o-items.md)).

I chose the setting over a fixed refusal in code because a fixed list could be lifted only by a release, while the check is per host and per CLI version. The setting stays off unless the operator acts. See open question 2.

## Preconditions and integration

| Item | What this slice does |
| --- | --- |
| Text rules on reasons (upkeep-confusables "Settled after review" 4) | The validator applies `textRules`, confusables included, to the reason of every docs edit, context proposal and capture candidate. Before, a reason was checked only for hidden characters and mixed-script words. A failing reason drops the candidate (`text-rule`); its flags count. Stored text is checked again: acceptance refuses a proposal whose stored replacement or reason fails; docs follow-up creation does not take a candidate whose stored reason fails (it waits and expires); Health withholds any failing reason, replacement or capture text (`withheld`). Quotes are repository text and are judged as before |
| Approval (governance-edit) | The accept command writes `governingEdits` and records `governingEditsApproval` through `task.approve`, as the operator, in the same transaction. Every entry that reaches a proposal's file must be required and unmapped (and plainly named, project-owned). Health lists any other proposal with the reason it cannot be accepted. The same rules still refuse a hand-made brief |
| Newly governing files (slice 5 part B Q5) | Reclassified, as 7.1 says. At docs follow-up creation, a waiting docs candidate whose file is governing at the head is resolved elsewhere (`reclassified`). The same statement is raised as a proposal against the governing file, with the docs reason, the file's blob and entries, and no replacement. A proposal without a replacement cannot be accepted: there is no exact edit for the operator to read. See open question 3 |
| Enforcement | `context` is in `ENFORCED_UPKEEP_KINDS`. The marker the accept command writes passes `contextMarkerProblems`, and the marker must name exactly the task's `paths` and `governingEdits`. A test runs part A's check on candidates for created and fixture tasks |
| Providers | Above |

## Decisions where the design was ambiguous

Each is the conservative reading. Those a reviewer or the operator should confirm are under [Open questions](#open-questions).

| # | Point | What this slice does |
| --- | --- | --- |
| 1 | A governing file reached through a linked directory: 7.4 and section 15 require such a delivery, but the governance-edit change refuses any link on a named entry's path | Allowed only for a factory-written `context` task. Its marker declares the entry's resolved path, which must be the path in `task.paths`. The entry may pass through linked **directories** only: the last component is not a link and keeps its name. It must resolve to exactly the declared ordinary file in the snapshot, comparison and candidate trees, with the same mode. Every other task keeps the governance-edit rule: no link anywhere on the path |
| 2 | Provider suppression unverified | A per-provider setting, empty by default (above) |
| 3 | What acceptance reads | No Git, as for a disposition command (4.5). A file that changed since the proposal was validated is caught by the pin check before the first model step, which returns the proposals |
| 4 | Several context tasks at once | At most one open context task (`upkeepOpen.contextTask`): two batches would edit the same governing files in two flows |
| 5 | Ceilings and holds for acceptance | The daily, weekly and open-task ceilings count a context task like a docs follow-up. Acceptance requires `propose`, no context suspension and no drain hold |
| 6 | Which entries `governingEdits` names | Every entry recorded as reaching the file. Each must be valid, because the governing boundary refuses a change to any entry left out |
| 7 | Proposals against one file validated at different merges | Refused in one batch; accept them separately |
| 8 | `rule` candidates (a capture candidate in governing-rule form, 4.3) | Not accepted: capture candidates are slice 7. Their acceptance will use this command |
| 9 | The task's risk and workflow | Ordinary, like a docs follow-up: strict risk would add review questions that N2 ends. The task has no `workflow` field (`upkeep.docs.workflow` is the docs selector), so the `knowledge-upkeep` rule or the default selects; a task workflow is refused |
| 10 | The displayed digest | File, quote, replacement, reason, blob and entries, recomputed from the stored row |
| 11 | When the notice is judged | When proposals are recorded, after a decline, reopen or acceptance, and when proposals return. Nothing polls. Once raised, it stays open with the current count until none is waiting. A proposal that only ages past seven days, or expires, changes it at the next such event |
| 12 | "Flows that have a reviewed plan" | Unfinished, non-maintenance flows with both a `plan` and a `plan-review` result. They are read through the live flow set only while a proposal is open |
| 13 | A returned proposal whose quote is gone | Resolved elsewhere only when the head is shown to contain the source merge; otherwise it waits |
| 14 | Text in rows recorded before this release | Withheld in Health and refused at acceptance (docs: not taken), never rewritten |

## Compatibility

- **Graph digests:** unchanged. No node and no reference graph changed; the digest tests pass.
- **State:** no schema, layout or index change. New fields:
  - on a proposal row: `entries`, `reclassifiedFrom`, `revalidated`;
  - `upkeepOpen.contextTask`;
  - on a context task: `createdBy: 'operator-acceptance'`;
  - one inbox item, `upkeep-context-waiting`.
- **4.5:**
  - Acceptance reads by key and the bounded indexes; a test shows it reads no whole kind.
  - The notice reads the open candidates' own index only when one or two proposals are open.
  - Health reads the live flows only while a proposal is open.
  - The idle tick is unchanged: nothing new runs from it.
  - No SQL JSON read over `records.data` was added.
- **Behaviour changes for every project:**
  - A reason a model writes is now judged by the text rules, so an assessment may drop more candidates under `text-rule`.
  - `upkeep.context.qualifiedProviders` is a new configuration key. An earlier release refuses a configuration that sets it.
  - A docs candidate whose file became governing is reclassified instead of waiting until it expires.
  - Health withholds stored model text that fails the rules.
- **Going back to an earlier release:** set `upkeep.mode` to `observe` or `off`, remove `upkeep.context.qualifiedProviders`, and decline or finish open context tasks first. An earlier release refuses the context marker at admission and at the four operations, which fails closed.

### For the release notes

- **Knowledge upkeep proposes governing-context corrections (`propose`).**
  - **What is recorded.** A statement in a governing file that a merge made false is recorded as a proposal, with the exact replacement and the model's reason. Health lists it, with the context entries it names. One notice says when three are waiting or the oldest has waited seven days.
  - **Accepting.** Only you can accept proposals, in Health or with `finding.accept {proposals: [{findingId, expectedVersion, digest}]}`, never on an instruction, by delegation or under a grant. Accepting writes one task from the stored proposals, approves it as your own approval of a governing edit, and refuses everything if any proposal changed since you read it.
  - **What the task may change.** Only those governing files, by at most 12 changed lines per proposal, checked at commit, integration, publication and merge. Its merge is never automatic.
  - **Which entries qualify.** Proposals against optional or path-mapped context entries are listed with why they cannot be accepted.
  - **Before accepting.** Health shows how many unfinished flows have a reviewed plan and may replan once the change merges.
- **Before a context task can run, record your providers.** A context task runs no model step on a provider not listed in `upkeep.context.qualifiedProviders`, which is empty by default. List a provider (`config update`, operator only) after its [instruction-loading checklist](../qualification/provider-instructions.md) passes on your host. (Updated in dev.91: Codex is isolated as of dev.90, so this applies to Codex and Claude alike; list either only after its checklist passes on your host.)
- **Text rules now judge every reason a model writes,** look-alike letters and split words included. A candidate whose reason fails them is dropped, and Health withholds any stored text that fails them.
- **A docs correction whose file became governing** is now recorded as a governing-context proposal, without a replacement, instead of waiting until it expired. Decline it, or correct the file with a task you approve (`governingEdits`).
- **Going back:** set `upkeep.mode` to `observe` or `off`, remove `upkeep.context.qualifiedProviders`, and decline or finish open context tasks first.

## Tests

New file `tests/upkeep-context.test.mjs`, 15 tests. In the dispatch fixtures the forge is a scripted `gh`; elsewhere the model is scripted and no provider process starts.

The tests changed because the behaviour changed:

- `upkeep-authority`: the new authority field and its default;
- `upkeep-lifecycle` and `upkeep-namespace`: `ENFORCED_UPKEEP_KINDS` is `['docs', 'context']`;
- `upkeep-docs-enforcement`: the unknown-kind example is now `check`, and a malformed `context` marker is refused as unreadable;
- `upkeep-docs-delivery`:
  - the hostile reason fixture now passes the text rules but still holds markup and an appeal;
  - a newly governing docs file is reclassified.

### Acceptance (section 15, slice 6)

| # | Acceptance item | Test (`tests/upkeep-context.test.mjs`) |
| --- | --- | --- |
| 1 | An accepted proposal is delivered through all four operations, one of them through a linked directory | "acceptance 1: … including one whose governing file is reached through a linked directory" (AGENTS.md as written, and `rules/current/POLICY.md` with `rules/current` a link to `../docs/policy`, each committed, integrated, published and merged; the snapshot reads through the link; an ordinary governance edit through the same link is still refused) |
| 2 | A `context` task that touches a non-governing path is refused | "acceptance 2: …". It covers an extra doc, a declared non-governing path, an own commit later undone, an optional entry, an addition, a mode change, a line overrun and a stale pin, at publication; commit undone; integration and merge refuse too |
| 3 | Acceptance is refused to the orchestrator under every instruction and grant | "acceptance 3: …", on schema 1 and 2, with no list and with `finding.accept`, `task.approve` and `task.put` delegated. The orchestrator is refused with no instruction, on an instruction, and citing a grant; the operator citing a grant is refused too. The old shape is refused as well and nothing is written. The operator, directly: accepted, with a direct-operator authority use on schema 2 |
| 4 | A stale version or a different displayed digest is refused and writes nothing | "acceptance 4: …". The cases: one of two stale, a version ahead, a digest of other text, a digest of another blob, no digest, a proposal twice, an extra payload field. The task count, the rows, upkeepOpen, the day row, the revisions and the authority uses are all unchanged |
| 5 | The created task's text comes from the stored rows | "acceptance 5 and 7: …" (template title and criteria; no model or repository text outside the marker; the marker's evidence equals the stored rows) and acceptance 4 (payload fields beyond the three are refused) |
| 6 | A file changed after acceptance fails the flow as stale before any model step | "acceptance 6: …". The flow ends `stale` before any attempt; the proposal returns at a new version recording the current blob, and can be accepted again. A proposal whose statement is gone at the head is resolved elsewhere |
| 7 | Three accepted proposals produce one task and one merge | "acceptance 5 and 7: …": one task, one approval, one merge delivering all three. "the context column: …": three proposals over two files, 18 changed lines, delivered with one forge merge; the same candidate under one proposal is refused at 12 |
| 8 | No code path other than a flow's builder writes a governing file | "acceptance 8: …". Static: the context modules import no file-writing function and run no writing Git command; the upkeep workflows write nothing under the project checkout. Dynamic: acceptance, the notice, Health and the factory's ending of the flow leave the checkout and AGENTS.md as they were; the four operations deliver only the builder's workspace change |
| P | Text rules on reasons | "text rules on reasons: …" (confusable, split, authority-claiming and look-alike reasons dropped for docs, context and capture; clean ones kept); "approval: …" (a stored failing reason withheld in Health and refused at acceptance) |
| P | Required and unmapped entries | "approval: …" (mapped, optional, removed entries explained and refused; a hand-made brief refused) |
| P | Newly governing files | "newly governing files: …" |
| P | Providers | "providers: …" (default empty; invalid values refused; admission refused with none, and with only `claude` listed for a codex builder; the provider step refuses before a provider starts) |
| — | The waiting notice; recording from a proposing run; Health and the replan count at 320 px; 4.5 reads | "the waiting notice: …", "a proposing run records …", "4.5: …" |

### Fail-before evidence

At `cc6807c` the new test file fails to load: `operations/upkeep-context.mjs` and the new exports do not exist. Each row below is one partial revert of this slice's source, run against `tests/upkeep-context.test.mjs` (15 tests).

| Source state | Fails |
| --- | --- |
| `context` not an enforced kind | 7 |
| A context task's entry not allowed through linked directories | 2 (acceptance 1; the context column) |
| No operator-only check in the accept command | 1 (acceptance 3; the nested `task.approve` still refuses, with another reason) |
| No digest check | 1 (acceptance 4) |
| No version check | 1 (acceptance 4) |
| Payload fields beyond the three accepted | 1 (acceptance 4) |
| 12 changed lines in all instead of per proposal | 1 (the context column) |
| The context check without its governing requirement | 1 (acceptance 2) |
| Returned proposals not read again | 1 (acceptance 6) |
| Reasons not judged by the text rules | 1 (text rules on reasons) |
| Stored text not checked again at acceptance | 2 (approval; newly governing) |
| No provider check at admission | 1 |
| No provider check at the provider step | 1 |
| No waiting notice | 1 |
| No reclassification | 1 |
| Proposals not recorded from a proposing run | 1 |
| The command does not approve the task | 7 |
| Entries not required to be `required: true` | 1 (approval) |

### Results

On this branch with `main` at `624710e` merged (`171d561`):

- `npm test`: 1,701 tests, 1,700 pass, 0 fail, 0 cancelled, 1 skipped. The skipped test is the confusables whole-source test, which needs `FACTOTUM_CONFUSABLES_TXT`.
- `node --test tests/upkeep-context.test.mjs`: 15 of 15.
- `npm run eval`: exit 0.
- `git diff --check cc6807c..HEAD`: clean.

No real provider CLI was started.

## Open questions

1. **Linked directories and the governance-edit rule (decision 1).** The governance-edit change refuses a named entry reached through any link; 7.4 and section 15 require a `context` delivery through a linked directory. This slice allows linked directories, never a linked file, for factory-written `context` tasks only. Every other task keeps the strict rule. Should the operator confirm this narrowing, or should such entries be refused for context tasks too, with the acceptance item recorded as not applicable?
2. **Provider qualification as a setting (decision 2).** `upkeep.context.qualifiedProviders` relies on the operator listing a provider only after the live check. The alternative is a fixed refusal that only a release lifts. Should the setting also be cleared automatically when a provider CLI version changes?
3. **Reclassified proposals without a replacement.** They cannot be accepted. They inform the operator and occupy a context place until declined or expired. Should they instead be expired at once (`reclassified`), or should a later run be asked for a replacement?
4. **One open context task at a time (decision 4)**, and context tasks counting against the daily and weekly upkeep task ceilings (decision 5).
5. **The notice's seven-day rule (decision 11)** is judged only at events, since nothing polls. A lone proposal that ages past seven days with no other activity raises no notice until the next upkeep event.
6. **`rule` candidates** (decision 8) are accepted by the same command in slice 7.
7. **Unrelated flake.** `tests/waiting-question-fingerprints.test.mjs` "a parked question expires at the first tick after its time" failed once in a full run before the merge of `main` (`superseded` instead of `expired`, a 1.5-second expiry under load). It passed three times alone, and in the final full run. This slice does not touch it.
