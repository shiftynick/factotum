# Plan 13: path-mapped context no longer invalidated by its own plan

Implemented against the dev.78 baseline. This is a local implementation record, not a release, activation or live qualification claim. It covers only the context-mapping defect under change 13; the role guidance starter, selective-context recommendations, ordinary delta review (10) and fast checks (11) are untouched.

## Root cause

`actionSpecification` assembles governing context from the current scope: task paths, the reviewed plan's `result.files`, and (with an owned workspace) the candidate's changes. When the planner runs, no plan exists yet, so its package is assembled from task paths alone. A context entry with `paths` that matches only a planned file is therefore omitted from the planner's package (`path mapping did not match`) and selected for the plan reviewer and builder.

The build guard compared the whole package digest with the planner's (`starter/factory/workflows/actions.mjs:69` before this change):

```js
assert(flow.results.plan.contextDigest === context.digest && ..., 'reviewed plan context or task changed; replan required');
```

The additional file changed the digest, so every plan that brought a mapped path into scope was rejected before its first build. Replanning could not fix it, because the new planner again sees only task paths.

## The distinction implemented

`assembleContext` (`starter/factory/operations/context.mjs`) now also returns `entries`: for every configured context entry, selected or not, a digest of its definition (`path`, `paths`, `required`) and of its current contents (`null` if unreadable). `entries` is kept out of the package `digest`, so existing digests and delivered packages are unchanged.

The plan step (`provider.plan` in `dispatch.mjs`, whatever the node is called) records `contextManifest`: the planner's selected files (id, path, digest), omissions with reasons, and `entries`. The build guard keeps the task-revision, initial-identity and target-base checks unchanged, and replaces the package-digest comparison with `governingContextChange` (`context.mjs`), which accepts the current package only if:

- the configured entry ids are the same as at planning;
- every file the planner received is still delivered with the same path and contents;
- every entry omitted at planning is either omitted for the same reason, or was omitted only because its mapping did not match **and** now:
  - has the same definition as at planning,
  - has the same contents as at planning, and
  - is selected by the plan's own scope (task paths or the reviewed plan's `files`).

So new affected scope that the reviewed plan introduces brings in a governing file exactly as it existed when the plan was made. That is the file the plan reviewer judged the plan against, and the builder now receives the same package.

A plan result recorded before this change has no `contextManifest` and keeps the exact package-digest comparison. If the manifest's digest disagrees with the plan's `contextDigest`, the build is rejected.

## Still rejected, and why

All of these fail with `reviewed plan context or task changed; replan required: <reason>`:

- **An edit to a governing file after planning**, whether to a file the planner received or to the newly mapped file. This includes an edit made between planning and plan review: the reviewer's copy is not accepted in place of the planner's snapshot. A builder editing its own governing file in a correction round is also still caught. That governance-edit case is tracked separately in [runtime follow-ups](../runtime-followups.md) and is not solved here.
- **A mapping change the approval did not cover.** The conservative choice: any change to an entry's definition that alters what is selected, or any added or removed context entry (even one that matches nothing), needs a replan. `config.update` already refuses while a change flow is live (`drain or abandon work`), so this guard is defence in depth against configuration that changes by any other route.
- **Governing context selected only by candidate changes outside the plan.** For example, a builder touches an unplanned path that maps to another rules file. The plan approval never covered that file, so this still requires a replan. As before, the replanned plan has to name the path.
- **A planned file that is no longer delivered**, for example because a newly mapped file used up the context budget. Raising `context.maxChars` is the remedy. Replanning does not change the budget.

Role-specific guidance, task-approval and target-base invalidation, and the dispatch-time input identity check are unchanged. The planner still does not receive files that only its own plan brings into scope.

## Limitations

- The planner never sees a file that only its own plan selects. The plan reviewer and builder do. This is the existing selection behaviour. Whether the planner should be re-run under the newly selected rules is a product choice and is not made here.
- Newly mapped contents are verified against the planning snapshot by digest, not re-reviewed.
- Provider automatic instruction loading (for example, whether a root instruction file reaches a provider) is not tested or changed here, and no claim is made about it.
- Tests drive the engine's prepare/settle path and the real dispatch code with a fictional provider. No live provider, forge or adopter project was used.

## Verification

New `tests/context-mapping-plan.test.mjs` (disposable Git fixture, fictional files `GUIDE.md`, `rules/ledger.md`, `rules/export.md`) covers:

- custom node names (`draft-approach`, `vet-approach`, `implement`) through the engine: the plan maps in `ledger-rules`, the build is prepared with the same package the plan reviewer received, then a fresh `Store`/`Engine` over the same state accepts the saved intent, stop before dispatch marks it `not-dispatched`, and resuming re-prepares the build with the same context digest;
- the same plan under the reference graph, plus the legacy exact comparison when `contextManifest` is absent;
- edits after approval to the newly mapped file and to an always-selected file (correction round), and a committed edit before the first build (`planned input changed`);
- an edit between planning and plan review;
- broadened mapping and added entry (rejected), with `config.update` refused while live, and restored configuration accepted;
- candidate-only scope selecting `export-rules` (rejected) while the planned path is accepted.

Results:

- Against the unchanged runtime, all 6 new tests fail. Both build reproductions fail with `reviewed plan context or task changed; replan required`.
- With the fix: `node --test tests/context-mapping-plan.test.mjs`: 6/6 pass.
- Focused: `node --test tests/context-mapping-plan.test.mjs tests/delivery.test.mjs tests/replan-feedback.test.mjs tests/flow-notes.test.mjs tests/model-settings.test.mjs tests/archive-retention.test.mjs tests/follow-target.test.mjs tests/runtime.test.mjs tests/commission-maintenance.test.mjs`: 87/87 pass.
- Full `npm test`: 612/612 pass, 0 failed, cancelled or skipped. None of the known load-sensitive tests failed in this run.
- `git diff --check`: clean.

## Independent review fixes

An independent review rejected the first version with two blocking findings and one non-blocking finding. All three are fixed. Where this section differs from the text above, this section is current.

1. **Build context bound to the passing plan review (high).** Before, a governing file could be changed before plan review and restored before the build: the review approved the changed rules, the builder got the restored ones, and the build was accepted. Now:
   - Preparing a `provider.planReview` step checks the current context against the planning manifest with the same `governingContextChange` rules. A change between planning and review fails with `planned context changed before plan review; replan required: <reason>`.
   - Every provider result already records the `contextDigest` of the package it ran with, so the plan review result keeps the identity of the package it approved. When a plan has a manifest and a `plan-review` result exists, the build guard now also requires the build's package digest to equal that review's `contextDigest`. A difference fails with `replan required: governing context differs from the package the plan review approved`. Plan-scope additions are already part of the reviewer's package, so the only additions allowed are ones the reviewer also saw.
   - Restart and resume re-prepare the build against the same recorded review digest, so a prepared attempt stays pinned to the approved package.
2. **Every entry definition checked (medium).** `governingContextChange` now compares each entry's recorded definition (`path`, `paths`, `required`) before any early continuation. Delivered entries, entries that keep their omission reason, and newly selected entries are all covered. A difference fails with `context mapping for <id> changed since the reviewed plan`.
3. **Budget advice (low).** `governingContextChange` now returns `{ reason, remedy }`, and `governingContextMessage` formats it. When a newly selected file exhausts the budget and evicts a file that was delivered at planning, the message names the evicted entry and says `budget exhausted by newly selected context`, `increase context.maxChars, replanning does not change the budget`. It no longer says `replan required`. The same applies when a file the plan's scope selects is itself left out for budget. Every other reason still says `replan required`.

Legacy plans without `contextManifest` keep the exact package-digest comparison and skip the plan-review guard. Custom node names, persisted attempt context, restart and candidate-only scope rejection are unchanged. Role guidance is unchanged.

### Tests added or changed in `tests/context-mapping-plan.test.mjs`

- `a ledger rule edited after planning but before plan review is rejected when the review is prepared`: replaces the earlier test that accepted the review and rejected only at the build. It covers a mapped file through the engine and an always-selected file.
- `rules changed before plan review and restored before the build do not reuse the review approval`: change, then a passing review that saw the changed rules, then restore, then the build is rejected. The approved package then builds, and the prepared build's digest equals the passing review's recorded `contextDigest`.
- `every entry definition is checked, delivered or omitted`: an always-selected entry changed from `required: true` to `false`; a selected entry's mapping changed but still selecting it; an omitted entry's mapping changed while keeping its omission reason. All are rejected at the build, the first also at review preparation, and the restored configuration is accepted.
- `a newly selected file that exhausts the context budget names the budget, not a replan`: rejected at review preparation and at the build with the budget advice and without `replan required`; a larger `context.maxChars` is accepted.

### Verification

- Fail before the fix: with only `starter/factory/operations/context.mjs` and `starter/factory/workflows/actions.mjs` reverted to 59e5481, the 4 new or changed tests fail and the other 5 pass. With only the build's review-digest assertion disabled, the change, review and restore test still fails, so the build binding is tested on its own and not only through the review-preparation guard.
- `node --test tests/context-mapping-plan.test.mjs`: 9/9 pass.
- Focused: `node --test tests/context-mapping-plan.test.mjs tests/operations.test.mjs tests/delivery.test.mjs tests/plan-review-protocol.test.mjs tests/replan-feedback.test.mjs tests/flow-notes.test.mjs tests/model-settings.test.mjs tests/follow-target.test.mjs tests/runtime.test.mjs tests/step-models.test.mjs tests/recovery-delivery.test.mjs`: 85/85 pass.
- Full `npm test`: 615/615 pass, 0 failed, cancelled or skipped. None of the known load-sensitive tests failed in this run.
- `git diff --check`: clean.
