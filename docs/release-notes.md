# Release notes

Development builds of the reference implementation. Each entry lists changes an adopter needs to act on. "The main thread" in review notes is the coordinating agent session; see [how the change records were written](changes/README.md#how-these-records-were-written).

## 0.2.0-dev.20261022.101

Includes dev.100. The fourth slice of the [must-fix review design](designs/review-must-fix.md): enforcement routing and builder deferral, **for test fixtures only**. `policy.reviewBar: must-fix` is still refused by configuration validation, so no project can reach this code; only fixtures that pin a flow to `must-fix` directly do. **Severity flows (the default) are unchanged**: the dev.98 golden capture still matches without edits. **Shadow flows keep today's route, verdict, evidence and attempt outcome**, their prompts are unchanged, and no new call or preparation runs in them. The reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate.

**Added, for the must-fix bar (refused by configuration; test fixtures only)** See [must-fix enforcement](risk-review.md#must-fix-enforcement-fixtures-only).

- **Route order (6.1).** A must-fix change review routes by the must-fix bar: a second contradictory result parks; incomplete strict attestations revise (park in a final phase); an open must-fix item at the cap parks (`must-fix-cap`), in every phase, a strict final included; an open must-fix item revises (strict bounded-delta final: `adjudicate`; ordinary final: `park`, as today); a strict full phase goes to `delta`; unrecorded operator items or follow-ups `defer`; otherwise `pass`. The verdict is kept, and `mustFix.enforcement` records the route, its reason, the cap, the budget and `verdictOverridden`.
- **The cap, the correction cycle and the budget check (9.5).** `policy.review.mustFixRounds` bounds the reviews that send must-fix items back; the initial build is build visit 1. Before any `revise` the review checks that one more correction cycle (its `revise` edge back to a review, plus the path to the merge question) fits the visit bounds of every step on it, the gate included, and the transition bound, and parks with reason `budget` otherwise, below the cap too. At the review question, `send_back` grants exactly one more must-fix send-back and is that send-back; a must-fix `send_back` whose cycle still cannot fit after today's extension (strict review nodes are not extended) is refused. Commissioning refuses `must-fix` for a graph whose change review lacks a `defer` or `park` edge or a correction cycle.
- **The builder (6.3, 9).** The correction brief replaces the previous review: open must-fix items with evidence and validation, everything else by id as "not required". The builder returns `findingDispositions` (build schema `must-fix-build-1`): `fixed`, or `deferred` once as `cant-happen-here` or `not-worth-mechanism`. A refused deferral makes the build `blocked`, so it reaches the build question. A deferral with a contradicted citation is void. When every open item is deferred and the candidate is unchanged, it is reviewed again once, for the deferrals only.
- **Deferral judgements (9.3).** The next reviewer accepts (with coverage and one `relevance` entry per builder citation, a new protocol check) or rejects each deferral; the result is a follow-up, an operator item (existence-only, unsupported or `disputed`) or a `contested` must-fix item. In strict work a protected-class deferral that is not supported stays must-fix.
- **Rows and the follow-up issue (6.2).** Each operator item and follow-up becomes a `finding` row with source `review` when the review settles, up to `maxFollowupsPerFlow` (the overflow counted on the flow). An operator item's row is the operator's alone. `forge.followup` accepts a must-fix `defer` at either risk level when no must-fix item is open, and its issue lists each row's kind, reason, evidence status and scenario; an upkeep-origin flow records rows only.
- **Plan notes (6.4).** A must-fix plan review revises only for a must-fix plan finding; other findings reach the builder as advisory plan notes.
- **`flow.disposeFinding`** (new command): `operator-accepted` or `operator-required` on one ledger entry, by its version, while the flow waits. No reviewer judgement lowers it: an `operator-required` entry stays required until a later review's `fix-holds` or the operator's own acceptance. Protected-class items and every `operator-accepted` are the operator's alone; on a recorded instruction the orchestrator may record `operator-required` on an outcome item in ordinary work only. It is in the default delegated operations for that purpose; the command checks the rest. See [commands](commands.md).

**Changed, for shadow flows (records only).** Ledger entries now carry a `version`, the finding's severity, file and line, and `recordedRound`, and the ledger version is 2; the ledger's `counts` list every status. A `fix-incomplete` judgement keeps its evidence. Routes, prompts, schemas and shadow route v3 are unchanged.

**What to do.** Nothing. Severity and shadow projects behave as on dev.100. Drain before upgrading, as for any release.

**Validation**

- **Local validation:** **1,950 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed. The suite now runs with stand-in provider commands first on PATH, so it can never start a provider CLI.
- **New tests:** every route of 6.1 at both risk levels and both protocols, as a table and through the dispatcher; every row of the deferral judgement table at both risk levels and both protocols; existence-only acceptance as an operator item; the relevance check and an omitted deferral judgement parking; a void deferral; the correction brief and deferral refusals; plan notes; `forge.followup` at either risk level, refused with an open must-fix item, rows only for an upkeep-origin flow; the reference correction cycles and the commissioning check; through the engine, the review after the third correction parking with `maxBuildRounds: 4` and `mustFixRounds: 3`, `send_back` running one more correction and the next review parking instead of a build visit that is not available, a build-question retry parking the review with reason `budget` one round earlier, a strict `send_back` that cannot fit refused (the ordinary one accepted), the unchanged-candidate exemption and a second deferral of a contested finding reaching the build question, rows at settlement with the overflow, and `flow.disposeFinding`'s version and authority rules; `mustFixRounds: 4` with `maxBuildRounds: 4` refused.
- **Review:** independently reviewed by GPT-6.1 Sol: reject, one high and two medium findings, all reproduced with must-fix fixtures and fixed, each with a test that fails before the fix. A later different-family `exclusion-confirmed` re-derived an `operator-required` exclusion as a follow-up, clearing the operator's requirement (an `exclusion-rejected` or a legacy `remaining` could lower it the same way); an operator's disposition is now never re-derived by a reviewer. A strict bounded-delta final review at the cap adjudicated instead of parking; the cap is now checked before final-phase routing. The budget check counted transitions but not visits on the path to the merge question, so an exhausted gate still fitted; it now counts every bounded step on that path. The reviewer confirmed that severity and shadow flows are unaffected, that default delegation of `flow.disposeFinding` only tightens, and that `forge.followup` keeps its deduplication.
- **Not qualified:** enforcement with a real model; it is fixtures only until the enabling release.

## 0.2.0-dev.20261022.100

Includes dev.99. The third slice of the [must-fix review design](designs/review-must-fix.md): the review ledger, later-round judgements, the in-fix rule, support of a reviewer's exclusion, and shadow route v3. **Severity flows (the default) are unchanged**: the dev.98 golden capture of their prompts, schemas, results, routes, review history and strict-requirement digest still matches byte for byte without edits, and a severity flow stores no ledger. `policy.reviewBar: must-fix` is still refused. The reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate: the ledger is derived from the review history.

**Changed, for shadow flows only**

- **Change review schema `must-fix-3`.** A shadow change review now also returns `ledger`: one judgement per earlier finding awaiting judgement, by its factory id (`fix-holds`; `fix-incomplete` with `sameScenario: true` and evidence; for an exclusion, `exclusion-confirmed` with coverage or `exclusion-rejected`). It is still asked for today's `priorFindingsDisposition`, which today's routing reads. Plan reviews stay on `must-fix-2`.
- **The ledger block.** From the second change review, the prompt has, after the purpose block and before the diff, each ledger entry awaiting judgement as quoted data: its scenario, its original evidence with the validation of each citation, the judgements it may get and, for a claimed fix, the paths changed since it was raised; then every other entry by id, which a new in-fix finding's `fixOf` must name. The changed paths are read with Git only while at least 120 seconds of the attempt would remain, for at most 2 seconds; otherwise they are shown as not known and `mustFix.ledger.preparation` records the skip, so ledger work never fails or times out a review.
- **Legacy findings.** A legacy finding (no must-fix fields) can be judged by its exact message, in `ledger` or in today's `priorFindingsDisposition`, only when no other legacy finding in the ledger has the same message; otherwise each needs a judgement by its factory id.
- **`flow.reviewLedger`.** One entry per change-review finding, with its status (`open`, `fixed-claimed`, `fixed`, `operator-item`, `follow-up`, or `superseded` for a purpose finding raised again) and each later judgement with the judging reviewer's model family. Recomputed from the review history whenever a review is recorded; each review records the digest of the ledger after it.
- **`fix-incomplete` covers only the original failure**: the same inputs, environment assumptions, failure path and wrong result. A materially different failure is a new finding with `origin: in-fix`, judged under the in-fix rule.
- **The in-fix rule.** From review round `policy.review.inFixEvidenceFrom` (default 3), an `in-fix` finding is shown only with a validated citation and stated coverage; otherwise it is read as `unknown`, so it is an operator item (outcome) or a follow-up (no purpose impact), never a send-back. A protected class in strict work still blocks.
- **Support of a reviewer's exclusion.** A reviewer's validated `not-here` is `unconfirmed`, an operator item, until a later review in a fresh session on a **different model family**, shown it as awaiting judgement, returns `exclusion-confirmed` with its own coverage. Its author, the cited fact, a review on the same family and a passing check never confirm it. `exclusion-rejected` from any later review reads it as `unknown`.
- **More protocol checks.** An omitted ledger judgement, a repeated one, one naming no entry or not applying to its entry, `fix-incomplete` without `sameScenario: true` or evidence, and an `in-fix` finding whose `fixOf` names no entry are contradictions. They get the same single correction review as the purpose checks, with the same deadline bound and the same `call: "shadow-review-correction"` accounting label, and a second contradiction is recorded as a protocol failure. **The actual route never changes.**
- **`shadowRoute` version `v3`**: v2 plus the ledger (an earlier fix judged incomplete still sends back; operator items and follow-ups are deferred once), the in-fix rule and support of exclusions. It omits builder deferral, the cap and operator dispositions. It is the only version the decision to enable must-fix may rest on. `mustFix` also records `reviewer` and `ledger`, including the mirrored `priorFindingsDisposition` for comparison. See [review bar](risk-review.md#review-bar-severity-and-shadow).

**Added, for the must-fix bar (refused by configuration; test fixtures only)**

A must-fix change review has `ledger` in place of `priorFindingsDisposition`, and the factory writes `priorFindingsDisposition` from it before today's routing reads it: `fix-holds` as `fixed`, every other judgement as `remaining`, and each unjudged finding of the previous review as `remaining` with the reason. An omitted ledger judgement twice parks with `protocol-failure` and mints no evidence.

**What to do.** Nothing for severity projects. On a shadow project, expect longer change-review prompts from the second review and one extra reviewer call when a review omits or garbles a ledger judgement. Drain before upgrading: a shadow flow started on dev.99 is refused by the executor check after the upgrade, as any flow is. A task flow waiting at a question, which an upgrade carries over, keeps the `must-fix-2` schema it pinned and shadow route v2, and stores no ledger; do not use its estimates to decide enabling.

**Validation**

- **Local validation:** **1,926 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **New tests:** the `must-fix-3` schemas; a fix that holds with a corner case in it, at round 3 with reasoning only and with a validated quote but no coverage, recorded as `fix-holds` and as new `in-fix` operator items, in shadow and in a must-fix fixture, and `inFixEvidenceFrom` moving the round; `fix-incomplete` without `sameScenario` as a contradiction that parks a must-fix review and is recorded in shadow; the other ledger contradictions; a protected-class `in-fix` finding in strict work still blocking with `strictFollowups` on; an exclusion citing a validated fact staying `unconfirmed` through a same-family confirmation (one citing a passing check) and a coverage-less different-family confirmation, and a different-family confirmation making an outcome exclusion a follow-up; fallback, same-session and contradicted confirmations not counting; a strict protected exclusion confirmed staying the operator's; id matching with the legacy fallback; the mirror; purpose entries settled by the next review; an omitted judgement through the engine parking a must-fix flow with no evidence while shadow follows today's route; the stored ledger equal to a recomputation and to the digest the review recorded; a severity flow storing no ledger; a flow pinned to `must-fix-2` keeping v2. The slice 1 and 2 shadow tests now expect v3, and the shadow identity test judges each claimed fix, so the actual route still equals the severity route in every golden scenario.
- **Review:** independently reviewed by GPT-6.1 Sol: approve with fixes, two medium findings, both reproduced and fixed. Ledger preparation's Git reads ran before the reviewer on the reviewer's deadline, so a slow read failed a shadow review that severity passed (12-second attempt, 2.2-second read); they are now skipped when time is short and bounded otherwise. One legacy `priorFindingsDisposition` closed every legacy entry with the same message, in different files, so the estimate passed; a shared message now settles none. The reviewer confirmed that a shadow review keeps its own `priorFindingsDisposition`, that exclusion confirmation cannot be spoofed by model output, and that the ledger is replayed from records. The tests for both fixes fail on the first dev.100 candidate.
- **Not qualified:** a shadow trial with a real model.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.99

Includes dev.98. The second slice of the [must-fix review design](designs/review-must-fix.md): purpose first, fail-closed protocol checks and shadow route v2. **Severity flows (the default) are unchanged**: the dev.98 golden capture of their prompts, schemas, results, routes, review history and strict-requirement digest still matches byte for byte, and the protocol checks never run in them. `policy.reviewBar: must-fix` is still refused. The reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate.

**Changed, for shadow flows only**

- **Purpose first.** A shadow review's prompt now puts a purpose block before the material under review (the diff, or the plan): the task's outcome verbatim, or "none recorded for this task" when it has none; each acceptance criterion, numbered; for a change review, the reviewed plan's summary, checks and risks; and the protected classes. The reviewer answers, in a new `purpose` field, whether the change does what its task says (`outcome`, and one `acceptance` entry per criterion by its exact text; surrounding whitespace is trimmed, nothing else is relaxed) and whether it can give a wrong answer silently (`silentWrongAnswer`: `no`, `yes` with how, or `unknown` with what would settle it). The schema version is now `must-fix-2`.
- **Purpose synthesis.** An outcome or criterion assessed `not-met`, or a silent answer of `yes`, that no must-fix finding covers adds a must-fix finding to the estimate. `partly`, `unverified` and `unknown` add none.
- **Protocol checks.** A result is contradictory when it has no purpose assessment, when its acceptance list does not name each criterion exactly once by exact text, or when it answers `yes` to a silent wrong answer without a finding marked `silent`. A result in today's shape (from a model, a project's own adapter or a scripted provider) has no purpose assessment, so it is always contradictory. A contradictory shadow review gets **one more reviewer call**, the correction review the must-fix bar would run; a second contradictory result is recorded as a protocol failure (`shadowRoute` `park`, `revise` for a satisfied review, `stop` for a plan review). **The correction's result never reaches the route:** the actual route, the reviewed result and the builder brief come from the original result exactly as the severity bar decides them. Today's plan-review correction for a pass with findings runs as before.
- **The correction call never costs the review its result.** It starts only when at least 20 seconds remain before a 30-second margin ahead of the attempt's deadline, and the whole call, provider preflight included, is bounded by that point. If it would not fit, runs out of time or fails for any reason, the review returns its own result and the estimate records `skipped` (`deadline` or `failed`) instead of a shadow route. An operator's stop still stops the attempt.
- **Cost of the correction call.** It uses the reviewer's provider allowance and is counted in usage accounting and in the model-invocation totals like any reviewer call, labelled `call: "shadow-review-correction"`. It is never counted as knowledge upkeep: in an upkeep flow it is left out of the upkeep share and of that flow's own invocation budget.
- **A correction never lowers strict escalation.** When the first result escalated to strict, the correction's estimate is derived as strict work.
- **`shadowRoute` version `v2`** adds purpose synthesis and the protocol failure to v1; it still has no ledger, exclusion confirmation, builder deferral or cap. `mustFix` also records `purpose`, `protocol` and `basis` (whether the estimate was derived from the original result or the correction's). See [review bar](risk-review.md#review-bar-severity-and-shadow).

**Added, for the must-fix bar (refused by configuration; test fixtures only)**

The enforcement code for the protocol checks, which only fixtures that pin a flow to `must-fix` directly can reach until the enabling release: a change review contradictory twice routes `park` with disposition `protocol-failure`, even a pass with no findings, before the legacy fallback and the strict checks, and mints no review evidence; a satisfied review revises instead. A plan review still contradictory after plan review's single correction fails its attempt with classification `protocol-failure`, and the engine stops the flow at plan review without following any edge, the hold a turn limit uses: no plan is published, no plan visit is spent, the stop notice quotes both contradictions, and resume runs a fresh plan review of the same plan. The engine holds only a flow pinned to `must-fix` this way. A correction that reports a lower risk than the result it replaced is still routed as strict work, and a plan protocol-failure hold records the failed review's strict risk assessments (and nothing else of it), so a resumed flow stays strict.

**Fixed (from the trial's dev.97 cleanup re-test)**

- **T1:** `cleanup archive-drop` on a merged flow released by the normal post-merge cleanup now says "no cleanup archive is recorded for this flow" instead of "the flow's workspace is not released".
- **T2:** `cleanup plan` now names a change hidden by an `assume-unchanged` or `skip-worktree` flag (`hiddenByIndexFlags`) and counts it in `changedOrUntracked`. The archive already kept it.

**What to do.** Nothing for severity projects. On a shadow project, expect one extra reviewer call whenever a review's purpose assessment is incomplete or missing and enough of the attempt's time remains, and expect a project adapter or scripted provider that returns today's shape to show `protocol-failure` in every estimate; its routes are unaffected. A shadow flow started on dev.98 is refused by the executor check after the upgrade, as any flow is; drain before upgrading.

**Validation**

- **Local validation:** **1,909 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Review:** independently reviewed by GPT-6.1 Sol, which rejected the first candidate with three medium findings, all reproduced: the shadow's correction call could run past the attempt's deadline (its provider preflight was outside the reserved time), so a finished review ended as a cancelled attempt; a change-review correction that reported ordinary risk was routed without the first result's strict escalation; and a plan protocol-failure hold dropped the strict escalation, so resume continued as ordinary work. All three are fixed. The reviewer also asked for surrounding whitespace to be trimmed in acceptance entries, and for the correction call to be labelled and kept out of the upkeep share. It confirmed that severity flows never reach the new code, that shadow keeps the original verdict, that a stop propagates, and that the plan stop and resume keep the same plan.
- **New tests:** the protocol checks (an omitted, repeated or extra criterion, exact text with surrounding whitespace trimmed and ambiguous duplicates refused, a repeated acceptance line, a `yes` silent answer without a silent finding); shadow route v2; the purpose block with and without an outcome; in a must-fix fixture flow, a pass with no findings that omits a criterion twice parking with `protocol-failure` through the engine and minting no evidence, protocol failure before the legacy fallback and the strict checks, an old-shape result never passing, a satisfied review revising, and one contradiction followed by a valid review proceeding; a must-fix plan review contradictory twice stopping at plan review through the engine with no plan published and no plan visit spent, then resuming with a fresh plan review of the same plan, and one contradiction followed by a valid plan review proceeding; only a must-fix flow held by a plan protocol failure; purpose synthesis for `not-met`, an unmet outcome and a silent `yes`; in shadow, the actual route equal to the severity route in every golden scenario with today's shape (each review then gets its correction call) and with must-fix-shaped results, the reviewed result unchanged, and a stop during the shadow's correction call stopping the attempt. After the review: the correction skipped when too little time remains, abandoned at its bound when a call (a hanging preflight) ignores cancellation, and skipped when it fails, for change and plan reviews; a correction reporting ordinary risk after a strict first result routed as strict work, through the engine too; a plan hold keeping strict risk so that resume reviews as strict work and an ordinary pass goes back to the planner; and the correction labelled and left out of the upkeep share. Each fails on the first dev.99 candidate.
- **Not qualified:** a shadow trial with a real model.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.98

Includes dev.97. The first slice of the [must-fix review design](designs/review-must-fix.md): a review bar setting whose default changes nothing, and a `shadow` bar that asks reviewers the must-fix questions and records what that bar would have done, without acting on it. The reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate.

**Added**

- **`policy.reviewBar`: `severity` (the default) or `shadow`.** See [review bar](risk-review.md#review-bar-severity-and-shadow).
  - **`severity`** keeps today's review behaviour. What is proven, and how: a golden capture taken before the setting existed covers the dispatcher's prompts, the schemas handed to providers, the results it returns, the review history the engine's recorders write, and the strict requirement's digest, for plan review, change review under both protocols and both risk levels, the satisfied review and the builder brief. The same scenarios run with the setting unset and set to `severity` match it exactly. A test also shows that a severity flow's review intents and history rows carry no new field. The golden does not cover intents as a whole, events, effects, console output or resuming from older state. What is known to differ: each new flow record pins `reviewBar: "severity"`, and the settings view lists the review bar.
  - **`shadow`** gives plan and change reviews the must-fix schema (`must-fix-1`): each finding adds a concrete scenario, whether it can happen here with cited evidence, its purpose impact (the task's outcome, a protected class or none), whether it is silent, and its origin. The prompt is today's with these questions after it. The factory assigns ids (`R<round>.<index>`, `P<visit>.<index>` for plan reviews), validates every citation, derives each finding's kind (must-fix, operator item or follow-up), and records `mustFix` and `shadowRoute` (version `v1`) on the review and its history row. **The flow still follows the severity route**, and the builder is briefed as today.
  - **`must-fix`** is refused by configuration validation: "policy.reviewBar must-fix is not available in this release".
- **Citation validation.** A file quote must be in that file at the reviewed head, read through hash-verified Git objects, so a replacement ref, a graft or a rewritten object cannot change what it is checked against; an environment citation must name a fact the flow pinned; a record citation must be one of this flow's attempts, produced for the cited head, which must be the reviewed head, with the cited check and result as recorded. A missing quote or a record for another candidate contradicts the claim, and a `shown` finding without a validated citation is read as `unknown`.
- **`policy.review`:** `environment` (up to 40 operator-declared facts reviews may cite), `strictFollowups` (default `false`: strict work keeps today's bar, where every finding blocks), and `mustFixRounds`, `inFixEvidenceFrom` and `maxFollowupsPerFlow`, which are validated and pinned now and read by later slices. `mustFixRounds` must be at most `maxBuildRounds` − 1 and at most `ordinaryReviewRounds`. `reviewBar`, `strictFollowups` and `environment` are authority: on a migrated project only the operator may change them.
- **Pinning.** Every flow pins its review bar when it starts, beside `reviewProtocol`. A shadow flow also pins the other review settings, a copy of the environment facts and the schema versions it uses. A flow started before this release reads as `severity`. Review phase routing now reads the flow's pinned `reviewProtocol` rather than the current configuration; until now they could differ only if the configuration changed under a running flow, which delivery's drained `config update` prevents.
- **Settings page:** shows the review bar.

**What shadow v1 can and cannot estimate.** It applies the per-finding test and citation validation to the review that actually ran. It adds no finding for an unmet criterion or a silent wrong answer, so it understates blocking. It has no protocol check, no ledger of earlier findings, no confirmation of a reviewer's exclusion, no builder deferral and no cap, so it cannot show later-round behaviour. Every value is labelled `estimate: true` with the parts it omits. Use it for schema and prompt health only, never to decide enabling must-fix.

**What to do.** Nothing, to keep today's review. To try the shadow, set `policy.reviewBar: "shadow"` (and optionally `policy.review.environment`) with `config update` once no change or document flow is running, then run doctor. Expect somewhat longer reviewer output. A project with `maxBuildRounds` below 4 must also set `policy.review.mustFixRounds` to at most `maxBuildRounds` − 1. A model, project adapter or scripted provider that returns a result in today's shape keeps working: the model is still asked for the must-fix schema, but a result valid against today's schema is accepted, marked `schemaFallback: "legacy"`, and its findings are recorded as `legacy` must-fix findings. A result valid against neither is refused, as any malformed result is.

**Validation**

- **Local validation:** **1,891 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Review:** independently reviewed by GPT-6.1 Sol, which reproduced the golden on the previous build and confirmed shadow never changes a route. Its two medium findings were fixed: a severity-only result was refused in shadow before legacy handling, and file citations honoured `git replace`. Phase routing now reads a flow's pinned review protocol. The main thread checked the fixes.
- **New tests:** a fixture for every row and rule of the 4.3 table (rule 2 and rule 4 through the derivation's inputs, which shadow v1 does not supply); `shown` with reasoning only, with a missing quote and with a record at another head read as `unknown`; record citations with the wrong check or result not validating; legacy history rows getting stable ids; the new schemas passing `validateSchemaDefinition`; configuration refusing `must-fix` and out-of-range settings; the reference graph digests unchanged; pinning on admission and after the configuration changes; a severity flow's intents and history rows carrying nothing new; the severity golden; and, under `shadow`, the actual route equal to the severity route in every scenario, with old-shape and must-fix-shaped results. After the review: a severity-only result through the real provider adapter in a shadow flow, a file citation under an installed replacement ref, and phase routing with a pinned protocol that differs from the configuration; each fails on the first dev.98 candidate.
- **Not qualified:** a shadow trial with a real model.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.97

Includes dev.96. A workspace-cleanup fix from the second adopter's report, and two operator commands for the archives it left: one slims an existing archive, one drops the archive of a merged flow. There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate, but read **What to do** if you use `cleanup.excludeIgnored`.

**Fixed (from the second adopter's report)**

- **`cleanup.excludeIgnored` globs now match paths that start with a dot.** The globs were matched with Node's `path.matchesGlob`, which never lets `*` or `**` match a path segment starting with a dot. `node_modules/**` therefore did not cover `node_modules/.pnpm/...`, `**/node_modules/**` did not cover `apps/web/node_modules/.bin/...`, and `.next/**` covered nothing in `.next/cache/`.
  - **Before:** on a pnpm monorepo with `["node_modules/**","**/node_modules/**",".next/**",".artifacts/**"]`, a plan left out 54 files (1.4 MB) and archived 45,665 (1.1 GB), almost all of them under `node_modules/.pnpm/`. Each `cleanup apply` wrote a 1.1 GB `tree.tar`. The same matching decided which ignored files of a completed flow are unsaved work, so completed flows whose only ignored files were dependencies were archived instead of released.
  - **Now:** cleanup uses the factory's own glob matcher (`core/globs.mjs`), the one knowledge upkeep already used. Wildcards match dot segments like any other, and a glob ending in `/**` also matches the directory itself, so `node_modules/**` covers the `node_modules` directory as Git lists it. `[...]`, `{a,b}` and `\` escapes still work. Extended patterns such as `+(a|b)` are no longer supported; a glob using one now matches less, so more is archived, never less. The safety rule is unchanged: a path is left out only if it matches a glob **and** Git reports it ignored. Tracked and plain untracked files are always archived.
  - **Also:** the list of ignored files that a normal post-merge cleanup records as deleted (`ignoredDeleted`) no longer names directories such as `apps/` just because everything in them is ignored. It names only the ignored entries themselves that the globs do not cover.
  - **Also:** inside a character class, `\x` now means `x` itself, so `[a\-z]` matches `a`, `-` or `z` and no longer the range `\`–`z`. A `]` first in a class and an unescaped `-` first or last are literal. Configuration validation rejects `cleanup.excludeIgnored` globs with POSIX classes such as `[:alpha:]`, reversed ranges or characters outside the Basic Multilingual Plane, which the matcher does not support.
- **The post-merge release checks the target as fetched now.** The cleanup step used to fetch with `git fetch <remote> <target>` and then check the owned head against `<remote>/<target>`. Under a custom `remote.<name>.fetch` that does not map the target, that ref is not updated, so a stale ref could count a head as merged after the target was rewound. The step now fetches the target branch into a factory-private ref, checks the head against that exact commit, records it as `preservation.mergedInto` (with `preservation.target` naming the branch), and removes the ref.
  - **What to do:**
    - With such globs, plans and archives from dev.96 and earlier (including dev.95) included every dot path the globs were meant to leave out. Archives already written are **not** removed or shrunk automatically. Each is a complete, verified archive. Slim them with the new `cleanup archive-slim` command below, which keeps the failed work and removes only what the globs now exclude. `cleanup archive-drop` is for merged flows only.
    - Plan again any cleanup you planned on an older release. `cleanup apply` refuses an old plan whose results have changed.
    - Check that your globs cover nested build output: `.next/**` is anchored at the workspace root, so use `**/.next/**` for `apps/web/.next/`.
- **Changes hidden by index flags count as work.** `git status` does not look at files marked `assume-unchanged` or `skip-worktree`, so a changed file behind either flag looked clean. Workspace inspection now compares each flagged file that exists with its index entry, and a difference makes the workspace dirty (`hiddenByIndexFlags` names the files). A completed flow with such a change is archived, not released, and integrate and push refuse it as they refuse any dirty workspace. `cleanup archive-drop` refuses an archive holding one. A flagged file that is absent, as a sparse checkout leaves it, is not a change.
- **Archive locations documented.** [Workspace cleanup](workspace-cleanup.md#where-archives-are-kept) now says where each kind of archive is kept. A flow that was `failed` (including abandoned) when `cleanup apply` ran is archived under `archives/failed-workspaces/`; a completed flow in `archive` mode has been archived under `archives/completed-workspaces/` since dev.82. Nothing is moved or renamed, and `cleanup restore` reads the directory recorded for the flow.

**Added**

- **`cleanup archive-drop`: the operator drops the cleanup archives of merged flows.** `cleanup archive-drop plan --state <state> (--id <flowId> ... | --completed)` lists every eligible archive directory with its files, sizes, SHA-256 digests and manifest digest, and one `planDigest` for the whole selection. `cleanup archive-drop apply ... --actor operator --digest <planDigest> --note "<why>"` plans again, verifies everything again, removes exactly those directories and records `archiveDrop` on each flow's cleanup record and the events `cleanup.archive-dropped` (per flow: directories, files, bytes freed, actor, note) and `cleanup.archives-dropped`. See [dropping the archives of merged flows](workspace-cleanup.md#dropping-the-archives-of-merged-flows).
  - **Eligible:** a `completed` flow with a merged PR or a proven satisfied record, whose workspace is already released, whose archive verifies against its manifest, and whose archive holds nothing beyond its committed head.
    - **The committed head must be kept elsewhere.** For merge method `merge`, it must be reachable from the target's commit as fetched now into a factory-private ref; the plan binds that commit, so apply refuses if the target moved. For squash and rebase, its commits must be in a verified bundle under `archives/workspace-commits/`. A satisfied record excuses only the exact head it proved; any other head needs the target or such a bundle.
    - **Nothing beyond the head.** The plan restores the archive into scratch space and refuses it if Git, with the archive's own ignore rules, reports any staged, modified, deleted or untracked path or an ignored path outside `cleanup.excludeIgnored`, naming them. There is no override.
  - **Never dropped:** the archive of a `failed` or abandoned flow, even if its change was merged later by other means, because it may be the only copy of unsaved work; an archive holding any work beyond its committed head, merged or not (use `cleanup archive-slim`, which keeps it); a squash or rebase flow's archive when it holds the only copy of the branch commits; and anything under `archives/workspace-commits/`.
  - **Who:** the operator only. The operation `cleanup.archive-drop` is not delegable, and the orchestrator is refused with or without an instruction. It is CLI only; the console has no cleanup actions.
  - **What to do:** use it for completed flows whose change is merged, when you no longer need the archive at all. It covers archives under `archives/completed-workspaces/`. Archives under `archives/failed-workspaces/` belong to flows that were `failed` or abandoned when they were archived; it keeps them (the plan counts them as `keptFailedFlowArchives`). To shrink those, use `cleanup archive-slim`.
- **`cleanup archive-slim`: the operator shrinks existing cleanup archives without losing work.** It rewrites an archive, failed or completed, without the ignored paths the project's current `cleanup.excludeIgnored` globs exclude. `cleanup archive-slim plan --state <state> (--id <flowId> ... | --all)` lists, per archive, the current and new file counts and bytes, the bytes freed, the globs, a sample of the removed paths and the current manifest digest, with one `planDigest` for all of them. `cleanup archive-slim apply ... --actor operator --digest <planDigest> --note "<why>"` slims them one at a time. See [slimming archives](workspace-cleanup.md#slimming-existing-archives).
  - **What goes:** exactly what cleanup would leave out today. Each archive is restored into scratch space beside it, and a path goes only if it matches a glob **and** Git, using the archived tree's own `.gitignore` files and index, reports it ignored. Commits, tracked, modified, staged and untracked files, and ignored files no glob matches all stay. The history bundle, index and index objects are kept byte for byte.
  - **How it stays safe:** the new tar and manifest are written beside the old ones, a fresh restore of them must reproduce the slim tree and the same index, and only then does one rename swap in the new manifest; the old tar is removed last. At every point either the old or the new archive is complete. An interrupted apply is finished or rolled back by the next plan and apply: that plan finds the leftovers without restoring anything and holds only those recoveries, so a nearly full disk still converges; plan again afterwards to slim. The new manifest lists the removed paths with their digests, as excluded paths already were, and records `slimmedFrom` (the old manifest digest, the globs, when and by whom). `cleanup restore` says the removed paths must be recreated by the setup step.
  - **Records:** the cleanup record follows the new manifest and keeps an `archiveSlims` history; each archive gets an event `cleanup.archive-slimmed` (old and new manifest digests, removed paths, tar bytes freed, actor, note) and the run gets `cleanup.archives-slimmed`.
  - **Who:** the operator only. `cleanup.archive-slim` is not delegable, and it is CLI only.
  - **Cost:** the plan restores each archive once and apply twice more, one archive at a time. Scratch space sits beside the archive, on the same filesystem, and needs room for one restored archive and its new tar.
  - **What to do:** adopters with oversized archives from dev.95 and earlier, including those of failed flows, should slim them: commission globs that cover the dependency and build output (for pnpm, `["node_modules/**", "**/node_modules/**", "**/.next/**"]`), run `cleanup archive-slim plan --all`, read it, then apply. `cleanup archive-drop` is for merged flows only.
- **`cleanup restore` holds the archives lock and never leaves a partial restore.** It holds the same lock as `archive-slim` and `archive-drop` for its whole run, checks the manifest and every payload file before extracting, and compares the restored tree with the manifest afterwards. A restore that fails partway removes the directory it was writing.

**Validation**

- **Local validation:** **1,868 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Review:** independently reviewed by GPT-6.1 Sol in two rounds. The first rejected the candidate with three high findings (archive-drop could delete unsaved work, trust a stale tracking ref, or accept a later commit after a satisfied record) and two medium ones (restore raced slim and drop; a class-escape glob matched too much); all five were fixed. The re-check confirmed them and found one more: changes hidden by index flags. The main thread fixed it and confirmed the reviewer's reproductions are refused.
- **New tests:** pnpm-style layouts (`node_modules/.pnpm/...`, nested `apps/web/node_modules/.bin/...`, `.next/cache/...`) through `cleanup plan` and `apply`, checking excluded bytes, the tar's contents and the restore; a tracked and an untracked file inside a matching directory are still archived; a completed flow whose only ignored files match the globs is released, not archived; the post-merge deletion record; and unit tests of the matcher. All of them fail on dev.96. For `cleanup archive-drop`: eligible against refused flows (failed, unproven merge, unreleased workspace, head not in the target, squash commits kept only in the archive), `workspace-commits/` left byte for byte, operator-only apply, digest binding (a changed selection, an added file, a tampered tar), one plan over several flows by `--completed` and by repeated `--id` through the CLI, and an interrupted apply finished by the next one. For `cleanup archive-slim`: a pnpm-style failed archive keeps its unpublished commit, modified, staged and untracked files and a non-matching ignored file and loses only the dependency and cache paths, with the bundle, index and object pack byte-identical; restore afterwards; digest binding (changed globs, changed selection); an apply interrupted before and after the commit, rolled back and finished; `workspace-commits/` untouched; operator-only apply; `--all` over several archives, through the CLI too; and archive-drop accepting a slimmed archive. After the review: archive-drop refusing staged, modified, untracked and non-matching ignored work, a stale tracking ref with the target rewound, a target moved after the plan, and a later commit after a satisfied record; drops and slims stopped at every step by a test hook, each converging on the next runs; a recovery plan that restores nothing; the post-merge release with a stale tracking ref; restore under the lock, verified first and never partial; and character-class escapes, negation, `]` placement and rejected class syntax. Each fails on the first dev.97 candidate. After the re-check: a change hidden by `assume-unchanged` and by `skip-worktree` makes the workspace dirty, is archived, and its archive is refused by archive-drop; both fail on the second candidate.
- **Not qualified:**
  - the fix on the second adopter's own monorepo;
  - archives of hundreds of thousands of files.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.96

Includes dev.95. Three small changes from the third adopter's install: a template fix, a documentation note and dead console code removed. There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate.

**Fixed (from the third adopter's install)**

- **The T3 handling-guide template no longer leaves dangling references.** Deleting its optional sections (the triage proxy, issue mirrors and the ask prompt) as the template note says used to leave about eight references to the deleted material.
  - **Before:** a copy with no proxy and no ask route still named the `TRIAGE` shorthand, "After binding", "Standing down and resuming", the proxy's keys in the private state file, the ask-prompt exception and the handoff's presentation-withdraw step.
  - **Now:** every such reference sits in an optional block of its own section, marked like the section itself. A section can have several blocks through the guide, some indented inside a list item; the note says to keep or delete all of a section's blocks together. The successor and handoff steps no longer have "With a triage proxy" and "Without a proxy" variants: the step itself moves the webhook, and the triage-proxy block after it says not to when there is a proxy.
  - **What to do:** nothing for a copy that works. A project that deleted sections from an earlier template can remove the leftover references by hand, or copy the template again and redo its placeholders.
- **Check environment documented.** Gate, fast and main checks take only `PATH` and `HOME` from the factory's environment. `LANG` is always `C.UTF-8`, and the factory adds its own `FACTOTUM_*` variables; `TMPDIR` and everything else are dropped. This was true before and is unchanged. [Running](running.md#configure-and-commission-delivery), [adoption](adoption.md#copy-and-configure), [fast checks](project-workflows.md#fast-checks-before-review) and the starter's setup checklist now say so, and show how a check sets what it needs in its `argv`, for example `["env", "TMPDIR=/srv/scratch/myproject-checks", "npm", "test"]`.
  - **Why:** one adopter's gate fell back to a nearly full shared `/tmp`.

**Removed**

- **Unused timeline marker code.** `markerGap` and `clusterMarkers` in the console's `timeline.mjs` have not been used since dev.95 replaced them with `markerBoxes`. Their tests now check the same behaviour through `markerBoxes`. The console behaves exactly as in dev.95.

**Validation**

- **Local validation:** **1,836 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Review:** checked by the main thread; no independent review, as the changes are documentation, a template and removed dead code.
- **Template test:** a new test deletes each optional section of the handling-guide template by the note's own rule, one at a time and all at once, and checks that nothing left names the deleted material.
- **Not qualified:**
  - the live real-browser re-test on the trial project;
  - live acceptance of a check or learning candidate;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.95

Includes dev.94. One console fix from the dev.94 re-test. There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate.

**Fixed (from the dev.94 re-test)**

- **Event markers no longer overlap at phone width (S1).** Markers are now grouped by the size of the box each one is drawn at, not by a fixed 14 px gap. A group is centred on the events it holds, and every event is still shown exactly once, either as its own marker or inside a counted group.
  - **Where:** a flow's execution timeline and the Timeline tab's events lane.
  - **Before:** in a busy flow, closed groups at 390 and 320 px overlapped each other and single markers by up to 15 px.
  - **Desktop:** grouping can differ slightly from before, because markers merge only when their boxes would touch.
  - **Width changes:** both lanes lay themselves out again when the chart's width changes, and an open group stays open.

**Validation**

- **Local validation:** **1,833 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Overlap tests:** box sizes are computed from the console's CSS, not measured in a browser. The tests fail on dev.94 with the reported overlaps.
- **Review:** independently reviewed by GPT-6.1 Sol, which approved with no findings.
- **Not qualified:**
  - the live real-browser re-test on the trial project;
  - live acceptance of a check or learning candidate;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.94

Includes dev.93. Console fixes from the dev.93 re-test. There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate.

**Fixed (from the dev.93 re-test)**

- **Timeline taps now open the right flow (R1, R2).** Bars are only drawn now. A separate layer of tap targets takes the taps: on a phone each target is at least 44 px, and no two overlap. Bars too close to tell apart open a counted list, on desktop too, and every flow and attempt can be reached.
  - **Before:** a tap at phone width could open a different flow.
  - **Before:** in a busy flow's timeline, about a quarter of the attempts couldn't be tapped at all.
  - **Keyboard:** works throughout, and a refresh no longer moves focus out of an open list.
- **Overview and Queue (R3).** Overview's Queue figure links to Queue. A queue entry held by the whole project names the hold, for example "admission is paused".

**Note for console checklists:** flow bars on the Timeline are no longer links. The new selectors are in [the browser checklist](qualification/console-browser.md).

**Validation**

- **Local validation:** **1,824 tests passed**, zero failures, one skip. The skipped test needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Tap measurements:** taken in headless Chromium against replayed trial data. Every flow and attempt opened its own item at 390, 320 and 1440 px, and no targets overlapped.
- **Review:** independently reviewed by GPT-6.1 Sol. Its one finding, focus lost on refresh, was fixed and checked by the main thread.
- **Not qualified:**
  - the live real-browser re-test on the trial project;
  - live acceptance of a check or learning candidate;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.93

Includes dev.92. Console fixes from the dev.92 re-test. There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. Nothing to migrate.

**Changes worth knowing**

- **Health now shows the share of model calls attributed to upkeep** against its 10% ceiling, whenever upkeep is on.
  - **What counts:** each assessment, plus the planner, builder and reviewer calls of the follow-up tasks it creates. This is as designed.
  - **Small projects:** a project with little other work can reach the ceiling, which suspends upkeep until you review it and lift it.
  - **Docs:** `docs/operations.md` previously said only the assessment counted; that's corrected.
- **Task-scoped holds are described as such.** A context task held for an unqualified provider is shown as a hold on that task alone, with its remedy. Overview counts such tasks. It says the rest of the queue still starts only when nothing else is stopping admission.

**Fixed (from the dev.92 re-test)**

- **Q1:** the flow page shows learning citations. Before, the console server dropped the field.
- **Q2 and Q3:** hold wording on the task page and on Overview.
- **Q4:** long ids wrap, so no page is wider than a phone screen. Timeline axis labels follow the rendered width and no longer overlap.

**Validation**

- **Local validation:** **1,812 tests passed**, with zero failures and one skip. The skip needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Review:** reviewed by GPT-6.1 Sol. The second fix round was checked by the main thread, with headless Chromium measurements recorded in the change record.
- **Not qualified:**
  - the re-test of this release on the trial project;
  - accepting and approving a check or learning candidate live, because none arose in the trial;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.92

Includes dev.91. Fixes from the dev.91 re-test and an adopter report. There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval.

**Action needed**

- **Upkeep task ceilings now limit only factory work and delegated acceptances.** This was an operator decision.
  - `upkeep.budget.maxTasksPerDay` and `maxTasksPerWeek` no longer refuse your own direct acceptances. They still count, and they use up the factory's room.
  - Health shows the budget and when room returns.
- **For orchestrator integrations that decide acceptances:** read `acceptance.delegatedProblems`, which names the ceiling and its reset. `acceptance.problems` now lists what refuses *your* acceptance right now, each entry starting `not now: `, so it can be non-empty where it was `[]`.
- **If doctor's Codex sandbox check said "could not run" on dev.91:** that was a probe bug, and doctor now gives a real result. `upgrade apply` also shows doctor's warnings, as `doctorWarnings`.

**Fixed**

- **Codex sandbox probe:** it lost its output inside the sandbox. It now writes synchronously, and reports `refused: EPERM` where the sandbox blocks child processes. This came from an adopter report.
- **Ceilings:** the daily and weekly ceilings no longer block the operator (P2). Health never offers an Accept that would be refused, and names the later reset when both ceilings are reached.
- **Learning paths:** a learning's `paths` list accepts ordinary spacing, and refusals name the line that differs (P3).
- **Learning citations:** `status --flow` shows learning selection, history, use and per-role citations, and the flow page shows citations. One Health sentence is clearer (P4).

**Validation and upgrading**

- **Local validation:** **1,803 tests passed**, with zero failures and one skip. The skip needs the external Unicode source. Both fictional process evaluations and the shared console passed.
- **Review:** every change was independently reviewed by GPT-6.1 Sol. The reviewer's last P3, the reset time, was fixed by the main thread.
- **Not qualified:**
  - the re-test of this release on the trial project;
  - the design's own upkeep trial;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI.

## 0.2.0-dev.20261022.91

Includes dev.90. This release contains:
- the fixes from the dev.90 re-test (O1–O6);
- the last two knowledge-upkeep slices: slice 7, capture creation, and slice 8, learning consumption and retirement.

All eight slices of the knowledge-upkeep design are now in a release. There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. **Read "Action needed" before upgrading.**

**Action needed**

- **Check this if `learnings.dir` is set.** Two values are now refused:
  - a directory with a hidden folder anywhere on its path (for example `.claude/learnings` or `.github/learnings`);
  - a directory that holds, or lies inside, a `context.files` path.

  A stored value like that makes upkeep read as off, and Settings and doctor give the reason. To fix it, move the files to a plain directory in an ordinary task, then run `config update` with the new `learnings.dir`.
- **If a context task is waiting on you:** `status --task`, Queue and Health now say which providers hold it and what to do. Run the [provider instruction-loading checklist](qualification/provider-instructions.md) for this version on your host before you list a provider in `upkeep.context.qualifiedProviders`. Its live Codex steps now forbid reading files.
- **If your builder is Codex and your checks start processes** (for example tests that run your CLI with `execFileSync`), run doctor. If it warns that Codex's sandbox refuses part of process handling, prefer a Claude builder. Use `providers.builder` to switch every task, or `task.models` for one task. Codex's network filter breaks Node's synchronous child-process calls with piped input. No safe setting lifts this yet.
- **Changing provider configuration folders:**
  - A task that must change `.claude/` or `.mcp.json` needs a Codex builder, or you make the change yourself.
  - A task that must change a top-level `.codex/` or `.agents/` needs a Claude builder.
  - Admission now says so, instead of starting a build that the builder's CLI refuses.
- **New required fields in model results.** Plan and build results now carry `learningsApplied`, and review results carry `learningsChecked`. Factotum's own prompts ask for them. A custom provider adapter must return them.

**Fixed (from the dev.90 re-test)**

- **O5:** a context task held for an unlisted provider now shows its hold and remedy everywhere.
  - Recurring problems (`queue.held` and five others) are written only when they start or change, not on every tick.
  - A task refused at final admission no longer holds up the queue. The claim moves on, and the refused task shows a `claim` hold.
  - Manual "Dispatch now" lists any tasks it skipped and why.
- **O2:** doctor detects the Codex sandbox limit on child processes. A Codex builder no longer gives up on a failure caused only by the sandbox; the factory's own checks still decide.
- **O3:** a task whose declared paths its builder can't write is refused at admission, with the remedy.
- **O1:** the provider checklist tests what is loaded, not what is read, and the docs say tools can still read worktree files as data.
- **O6:** the provider checklist is now required for Codex and Claude alike.
- **O4:** recorded times show once, as a time element.

**New**

- **Knowledge upkeep, slice 7:** turning lessons into reviewed work, with `propose`. When review, a fast check or the gate caught a mistake worth not repeating, upkeep may record one candidate. There are three kinds:
  - **Check.** A change to the fast-check scripts it names, keeping their modes. **Only you can approve a check task**, directly, bound to that revision and those exact script blobs. Nothing bounds what a script does when it runs, so read the change before you approve and merge it.
  - **Rule.** Text added to a governing file, accepted only by you, through the governing-context acceptance.
  - **Learning.** Exactly one new file in `learnings.dir`, written as accepted.
- **New in the starter:**
  - `project/LEARNING.template.md`;
  - an optional orchestrator skill, `project/skills/factotum-compound/`. Factory steps never load it.
- **Knowledge upkeep, slice 8:** learning consumption and retirement.
  - **Delivery.** Each plan cycle selects matching learnings, pins them by blob, and gives them to the planner, plan reviewer, builder and reviewer as advisory data, with no authority. They are never governing context, and never skills or instructions.
  - **Citations.** Citations are counted.
  - **Retirement.** `learnings.check` raises retirement candidates for stale learnings. A retirement task may only delete that one file, with exactly the content the check read.
  - **Automatic stop.** Delivery stops on its own if fewer than 10% of 20 selections were cited. Only you restart it, with `upkeep.lift {part: "learnings"}`.
  - **Visibility.** A flow's page shows what it was given.

**Validation**

- **Local validation:** **1,791 tests passed**, with zero failures and one skip. The skipped test needs the external Unicode source file. Both fictional process evaluations and the shared console passed.
- **Review:** every change was independently reviewed (GPT-6.1 Sol) and re-checked until approved. The last O display fix was checked by the main thread. See the [progress record](one-factory-progress.md).
- **Not qualified:**
  - the re-test of this release on the trial project;
  - the design's own trial of knowledge upkeep (section 14);
  - the revised provider checklist's live Codex steps;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI. `authority migrate` remains withheld.

**Going back to an earlier release**

Do these in order:
1. Lift a `learnings` suspension.
2. Decline or finish open check, learning and learning-retire tasks.
3. Set `upkeep.mode` to `observe` or `off`.

## 0.2.0-dev.20261022.90

Includes dev.89. This release contains:
- provider isolation from the worktree for every model step;
- knowledge upkeep slice 6 (governing-context proposals) and its preconditions;
- the dev.89 re-test fixes (N1–N5).

There is no schema change and the reference graphs are unchanged, so queued tasks need no re-approval. **Read "Action needed" before upgrading: there are several breaking changes.**

**Action needed**

- **Breaking: Codex no longer reads your root `AGENTS.md`, or any repository skill.**
  - **What changed.** Every Codex step now runs from an empty private working root outside the worktree, and works in the worktree by its path. It loads no `AGENTS.md`, `.codex/` configuration, skill or hook from the repository. Claude Code steps already ran without `CLAUDE.md` and project skills.
  - **What to do.** If your factory steps must follow rules in `AGENTS.md`, add it to `context.files`, for example `{"id": "project-agents", "path": "AGENTS.md", "required": true}`, and run `config update` while no change flow is running.
  - **Watch your first Codex builds.** A model that writes relative to its current directory writes into the empty folder, and the build comes back with no change.
- **Breaking: your own and bundled Codex skills are disabled in factory steps.** Put what the steps need into a governing context file instead.
- **Breaking: changes to provider configuration must be declared.** A candidate that adds, changes or removes anything under `.codex/`, `.agents/` or `.claude/`, or a `.mcp.json`, is refused unless the task's `paths` name it. That includes anything reached through a link in those folders. A link cycle there is refused outright.
- **Breaking: older CLIs fail preflight.** Codex needs 0.169.0 or later, and Claude Code 2.1.325 or later. Upgrade, then run doctor.
- **Keep the state directory outside every project checkout.** A Codex step whose artifact folder is inside its worktree is refused.
- **Triage proxy users: copy the script and both guides together.** Commands need `--protocol 90`.
  - A forward's decision is logged before it can be sent or retried.
  - A decision that couldn't be logged is recovered first, by every command.
  - The handling guide covers reset notices and says to diagnose a failed flow before requeueing its task.
  - State files from dev.89 keep working.
  - Details are in [the change record](changes/dev90-n-items.md#action-needed).
- **Knowledge upkeep `propose` now also covers governing context.** A context task runs no model step on a provider that isn't listed in `upkeep.context.qualifiedProviders`, which is empty by default. List a provider only after the [provider instruction-loading checklist](qualification/provider-instructions.md) passes on your host.

**Fixed (from the dev.89 re-test)**

- **N1:** every enforcement refusal names the file and what to do, in its notice and in `status --flow` (`flow.failure`). This covers governing-file, provider-config, upkeep limits, conflict, merge-in-progress and marker refusals.
- **N2:**
  - The proxy never leaves a forward unconfirmed with no end.
  - Each delivery kind is worded correctly.
  - The docs explain which repeats publish no second notice.
- **N3:** confirmations name the finding or candidate and its version.
- **N4:** a finding time is shown once.
- **N5:** the browser checklist matches the product.

**New**

- **Knowledge upkeep slice 6.** A statement in a governing file that a merge made false is recorded as a proposal, with an exact replacement.
  - **Acceptance.** Only you can accept proposals, never by delegation or grant. Accepting writes and approves one context task from the stored proposals, and that task may change only those governing files.
  - **Text rules.** These now judge every model-written reason. Look-alike letters and split words are caught through Unicode's confusables data.
- **Provider isolation for every model step.** This is described under Action needed. The live checklist confirmed that the project-document flags work on Codex 0.169.0 and Claude Code 2.1.325. The empty working root and skill isolation still need live qualification.

**Validation**

- **Local validation:** **1,734 tests passed**, zero failures, one skipped (it needs the external Unicode source file). Both fictional process evaluations and the shared console passed.
- **Review:** every change was independently reviewed (GPT-6.1 Sol) and re-checked. The final rounds of provider isolation and of the N fixes were checked by the main thread. See the [progress record](one-factory-progress.md).
- **Not qualified:**
  - the re-test of this release on the trial project, including real Codex builds from the empty working root;
  - a context task against a real provider;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning, with the release's own CLI. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.89

Includes dev.88. What it contains:
- a fix for a live-settings defect in upgrades (M1);
- the other dev.88 re-test findings;
- a stricter, breaking boundary for governing-file edits;
- knowledge upkeep slice 5 part B: docs follow-up tasks in `propose` mode, which is off by default.

There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. **Read "Action needed" before upgrading.**

**Action needed**

- **Live settings after an upgrade (M1).**
  - **The defect.** Releases dev.82 to dev.88 cleared the record of live setting changes at an upgrade's recommission. The next `config update` from your file then silently reverted them.
  - **What dev.89 does.** It keeps them, and every `config update` names each live setting it changes (`changedLiveSettings`).
  - **If you changed settings live and upgraded since dev.82,** follow `docs/operations.md`, "Live settings after an upgrade", before your next `config update`. Find your changes in History → Events ("Settings updated"), compare them with `config show`, and put the ones you want back in your file or set them again.
- **Breaking: every governing-file change needs your own approval naming the file.**
  - **What is refused.** A candidate that changes a `context.files` entry its task isn't approved to change is refused before review and at commit, integration, publication and merge. Before, it could be reviewed against itself and merged.
  - **To update `AGENTS.md`:** make sure its entry is `required: true`, has no `paths` mapping and isn't under `factory/`. Then, as the operator, put the task with `"governingEdits": ["<entry id>"]` and the path in `paths`, and approve it. The orchestrator can't put or approve such a task.
  - **An adopted PR that touches a governing file** is refused at integration. Have its author drop that change, or carry it as an operator-approved task.
  - **A running task** that changes a governing file without approval stops before its next review.
  - The exact commands are in [the change record](changes/governance-edit-context.md#release-notes).
- **Pull request adoption, for all flows.**
  - **What changed.** Publication no longer adopts an existing pull request on the factory's branch that another account opened, or one from another repository, even if it carries the factory's markers. Publication fails and says to close it and publish again.
  - **Unaffected:** pull requests the factory's own account opened, including one whose creation response was lost.
- **Triage proxy users: copy the script, the brief and the handling guide together.**
  - **Protocol 89.** Every command needs `--protocol 89`.
  - **State resets** publish a `triage-reset-…` operator notice, and the proxy recovers its id from the log.
  - **After a rebind,** forwards whose sends to the old session failed are re-sent at once.
  - **Unchanged:** the webhook prompt. State files from dev.88 keep working.
  - Details are in [the change record](changes/dev89-m-items.md#action-needed).
- **Finding commands are delegated by default.** With no `policy.delegatedOperations` list, the orchestrator may decline, resolve and reopen audit findings on a recorded instruction. The dev.88 notes said otherwise. To keep them with the operator, set an explicit list that leaves them out.

**Fixed (from the dev.88 re-test)**

- **M3:** after a replan that really changed the plan, the unchanged candidate can be reviewed again. Session metadata alone doesn't count as a change. The stop text names `flow.note`.
- **M4:**
  - Proxy resets publish a notice and keep the proxy's identity.
  - The brief's first step has a fallback.
  - A failure before the script runs publishes a notice through the factory CLI.
- **M5:** a click on padding inside the flow window no longer closes it.
- **M7:** the proxy re-sends after a rebind.
- **M8:** a stale stop reason no longer appears for a resumed flow.
- **M9:**
  - Finding times have UTC tooltips.
  - The finding forms confirm before acting.
- **Proxy audit items:**
  - An older read no longer re-sends.
  - The outage for forwards with no destination now ends.
- **M6:** documented. All maintenance jobs wait while admission is paused.
- **M2:** see above.

**New**

- **Knowledge upkeep can propose docs corrections** with `upkeep.mode: "propose"`, which is off by default.
  - **Follow-up tasks.** Kept corrections become an unapproved docs follow-up task: `upkeep:docs:…`, at most 3 files and 40 changed lines, at most 2 a day and 6 in any seven days, one open at a time.
  - **Criteria.** They are factory sentences that name files by evidence id. File names must be plain ASCII.
  - **Running.** Approve it as any task. It runs only while a parked place is free, and its merge decision is never automatic.
  - **Checks.** Stale files or a moved base end it before any model step, and return its candidates.
  - **Closing.** When the factory ends a follow-up, it closes the pull request only if the factory created it, with a comment. It never closes one a person reopened.
  - **Recommended:** run `observe` for about 20 runs first. Projects with a workflow catalog must point follow-ups at a change or document workflow.
- **Approved governance edits.** A task approved to change a governing file can now go through correction rounds without invalidating its own plan. Every step receives the rules as approved. Approved tasks start Codex with `project_doc_max_bytes=0` and Claude Code with `--safe-mode`, so neither reads instruction documents from the worktree. Run the [provider instruction-loading checklist](qualification/provider-instructions.md) before relying on this.

**Validation**

- **Local validation:** **1,674 tests passed**, with zero failures or skips. Both fictional process evaluations and the shared console passed.
- **Review:** every change was independently reviewed (GPT-6.1 Sol) and re-checked until approved. The last M3 fix was checked by the main thread. See the [progress record](one-factory-progress.md).
- **Not qualified:**
  - the re-test of this release on the trial project;
  - the provider instruction-loading checklist;
  - `propose` mode against a real provider;
  - models and GitHub at a large repository's scale.

**Upgrade** with a reviewed, drained adoption and commissioning, using the release's own CLI. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.88

Includes dev.87. It contains:
- the fixes from the dev.87 re-test (L1–L7), with a simpler triage proxy;
- knowledge upkeep slices 3 (the model assessment, observe only), 4 (finding lifecycle and command authority) and 5 part A (enforcement on documentation corrections).

There is no schema change, and the reference graphs are unchanged, so queued tasks need no re-approval. **Read "Action needed" before upgrading.**

**Action needed**

- **If your project has `upkeep.mode: "observe"`, it starts making model calls.**
  - **What it does.** After a merged change that touches what a declared doc or governing file refers to, the factory asks a model once what it would change, and records the answer. It writes no candidate and creates no task.
  - **Limits.** At most one call per merged flow and 30 a day. Each call is bounded to 6 turns, 5 minutes and 40,000 characters, and none is retried.
  - **To make no calls,** the operator sets `upkeep.budget.maxModelRunsPerDay` to `0`, or turns the mode off.
  - **Which model.** `providers.upkeep` if set, otherwise the reviewer's route. Either way it is pinned when upkeep is turned on. A project already observing is pinned at its first configuration write or upkeep run after the upgrade. A later change to `providers.reviewer` doesn't move it.
  - **`providers.upkeep` is now validated.** An invalid stored value is refused at `config update`, doctor and the `upgrade apply` check.
  - **Observe mode can suspend its model call.** That happens when 6 of the last 20 runs asked the model, when 4 of the last 20 kept something, or when upkeep made 10% of the last seven complete UTC days' invocations. Only the operator lifts a suspension: Health → Knowledge upkeep → *Lift this suspension*, or `upkeep.lift`.
- **Triage proxy users: copy the script, the brief and the handling guide together.** Then update the webhook task's prompt. The details are in [the change record](changes/dev88-l-items.md#action-needed-adopters-using-the-triage-proxy).
  - **One destination.** Forwards now go only to the bound session, or to the configured thread before any session is bound. There is no fallback to another thread. A broken binding waits for the operator or a rebind.
  - **One notice per outage.** When the destination is down, or a forward is 10 minutes old, the operator gets one verified Inbox notice for that outage.
  - **Notices for failed runs.** When the proxy can't handle a delivery or a run (a lock timeout, unreadable state, the 2,000-forward limit, or a protocol mismatch), it publishes an operator notice itself. That's why runs need `--factory-state`.
  - **Protocol 88.** Every command needs `--protocol 88`. A dev.87 brief only forwards a notice saying the guides must be copied again.
  - **The webhook prompt** now passes `sessionVersion`, so each forward's count names its session. Until you update it, forwards say their session is not named.
  - **Trust.** Publishers with the orchestrator role are trusted. Webhook content is not.
  - **Existing state.** State files and logs from dev.87 keep working. A forward that dev.87 escalated is escalated again for its current outage if it stays undelivered.
- **Audit findings have new commands.**
  - **In Health:** *Decline*, *Dealt with another way* and, for closed findings, *Reopen*.
  - **In the CLI:** `finding.accept`, `finding.resolve` and `finding.reopen`. Each names the finding version you read.
  - **Who can use them.** The operator, and the orchestrator on a recorded instruction (`--instruction`) unless your `policy.delegatedOperations` list leaves them out. With no list, every delegable operation is delegated, these three included; an explicit list delegates them only if it names them. (Corrected after release: this line first said the orchestrator needed them listed.)
  - **Declining** a finding that has a task closes that task.
  - **Health** now keeps tasked and recently closed findings.
- **Going back to an earlier release.**
  - Turn `upkeep.mode` off and let one tick pass.
  - If your `policy.delegatedOperations` list names `finding.accept`, `finding.resolve` or `finding.reopen`, remove them: an earlier release refuses a list that names them. A project with no list needs nothing here.
  - Reset any saved model default or `stepModels` entry for `maintenance/knowledge.upkeep`.
  - Three new finding indexes stay. dev.87 keeps them up to date.
- **Health after upgrading.** The project service builds three new partial indexes at its first start. Until then, upkeep reads refuse rather than scan.

**Fixed (from the dev.87 re-test)**

- **Proxy, L1–L3.**
  - A send outside its `send` arguments is no longer delivered twice.
  - The proxy re-reads the item before every send and closes forwards about items that are no longer open.
  - Resume and "After binding" touch only the reading thread's own forwards.
- **L4.** `status --flow` shows the flow's knowledge-upkeep run.
- **L6.** Escape closes an open event list before the flow window.
- **L7.** Queue's "Started … ago" times have UTC tooltips.
- **L5.** Not a defect: doctor's progress already goes to stderr. A test now pins this.

**New**

- **Knowledge upkeep slice 3:** the model assessment, in observe mode. See Action needed.
- **Knowledge upkeep slice 4:** finding lifecycle, ceilings and suspension, and a Knowledge upkeep section in Health.
- **Knowledge upkeep slice 5 part A:** documentation-correction tasks are checked at commit, integration, publication and merge. Upkeep flows are never merged by policy. No release creates such tasks yet, so nothing changes for a running project.

**Validation**

- **Local validation:** **1,606 tests passed**, with zero failures or skips. Both fictional process evaluations and the shared console passed.
- **Review:** every change was independently reviewed (GPT-6.1 Sol) and re-checked.
  - The proxy took eight rounds, and the operator ended them by simplifying the design and stating the trust model.
  - The final proxy round's reviewer was stopped by its provider's content filter. The main thread checked the remaining path itself and fixed one more defect.

  See the [progress record](one-factory-progress.md).
- **Not qualified:**
  - the re-test of this release on the trial project, including the proxy's single-destination behaviour and the error notices on T3;
  - an observe-mode model call against a real provider;
  - models and GitHub at a large repository's scale.
- **Upgrade** with a reviewed, drained adoption and commissioning, using the release's own CLI. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.87

Includes dev.86. It does three things:

- fixes the dev.86 re-test findings (K1–K5);
- closes a security gap in root installations: the lock did not authenticate the installed files;
- adds knowledge upkeep slice 2, an observe-only job that is off by default and makes no model calls.

There is no state migration, and the reference graphs are unchanged, so queued tasks need no re-approval. **Read "Action needed" before upgrading.**

**Action needed**

- **Root installations (both current adopters): adopt this release with its own CLI.** Run `node <release>/starter/factory/cli.mjs upgrade apply …`.
  - **Why:** preparation writes authentication evidence (`rootLayout`) into the new lock. Review it with the rest of the adoption.
  - **Keep your current release's directory at hand during this first upgrade.** If the upgrade fails and the checkout returns to the old lock, units stay stopped until `upgrade apply --recover --release <that directory> --digest <its digest>` authenticates the old lock.
  - **Until the new lock lands,** doctor shows one expected warning about an unauthenticated lock and still passes.
  - **`--activate` on a lock without evidence** needs `--release <dir>`, or must be run with the release's own CLI.
  - **After this adoption, every later adoption must keep the evidence.** The project's state records the first time the lock verifies by its own evidence. From then on, doctor (which holds admission), `adopt status --state` and both upgrade commands refuse a lock without evidence, unless `--release` authenticates it.
  - **Don't add evidence by hand.**
  - **Pass `--state` to `adopt status`** when you use it as a check.
- **Upgrades stop, start and recover differently.**
  - **When units stop and start:** an upgrade stops units only on a checkout that verifies from the bytes on disk. It starts them only on a checkout that verifies with an authenticated lock.
  - **Catching up with the target:** `--merge` does this only in the review worktree. It stops, so that you prepare the upgrade again for a new review, if:
    - the rebased branch no longer carries exactly the reviewed changes;
    - the target changed a `.gitattributes` or `.gitmodules` file.
  - **Refused files:** the checkout goes back to the commit it held.
  - **Units stay stopped:** when they can't be safely started, the output ends with "To finish, run in order:" and exact commands, the last being `upgrade apply --recover`.
  - **Before running those commands,** copy anything you want to keep to a private backup outside the repository. Don't stash it.
  - **After an interruption,** run `upgrade apply --recover`. It runs `config update --current` and doctor, and starts units only if both pass.
  - **The old by-hand steps** for a failed `verify` no longer apply. See [updates](updates.md), "When an upgrade stops partway".
- **Triage proxy users: copy all three files together.**
  - **The files:**
    - `triage.example.mjs`;
    - the brief, from `t3-triage.example.md`;
    - the handling guide, from `t3-notifications.example.md`.
  - **New script commands:**
    - every command needs `--protocol 87`;
    - `--sent` and `--send-failed` need `--to <threadId>`;
    - there's a new `--escalate <sendId>` step.
  - **Mismatched copies:** a dev.86 brief with the new script only forwards a notice saying the guides must be copied again.
  - **Old state:** state files and logs from dev.86 keep working.
  - **Escalation notices:** the proxy never withdraws them, including those already open. The operator dismisses them; the orchestrator is told when one is moot.
- **The `upkeep` and `learnings` configuration blocks are now validated.**
  - **What is refused:**
    - unknown keys;
    - limits above their defaults;
    - `upkeep.mode` other than `off` or `observe`;
    - unsafe paths;
    - a `docs.workflow` that isn't a change or document workflow.
  - **Projects without these blocks** are unaffected.
  - **A stored block the last release ignored** reads as off. `upgrade apply` refuses before changing anything, using the new release's verified validator, and names the fix.
  - **To recover,** the operator replaces the block with `"upkeep": {"mode": "off"}` using `config update`. See [updates](updates.md).

**Fixed (from the dev.86 re-test)**

- **The proxy no longer escalates a forward it has just delivered (K1).**
  - Escalation is decided after the run's sends are recorded.
  - Forwards about items no longer open are closed instead of re-sent.
  - Notices have readable titles.
- **Proxy edge cases (K5):**
  - a thread that already failed is never used as a fallback;
  - a confirmation is credited to the thread the send actually reached;
  - re-sends carry their decision time;
  - forwards no longer tell the orchestrator to acknowledge operator-only notices;
  - after a rebind, the handling guide wakes the proxy at once.
- **Console (K2–K4):**
  - the Inbox fits phone widths;
  - a grouped timeline marker's list opens below the chart instead of being clipped;
  - the scheduled-tier time has its UTC tooltip.

**Security**

- **Root-installation locks are now authenticated against the pinned manifest digest,** as prefixed ones already were.
  - **Before:** someone who could push to the target outside the factory could swap a managed file and its lock hash. Activation, `--merge`, doctor and `adopt status` all accepted it.
  - **Now:** the evidence and an anchor kept in the project's state make that refused. The anchor stops a later adoption from silently dropping the evidence.
  - **Not covered** (recorded in [runtime follow-ups](runtime-followups.md)):
    - concurrent writers to the operator checkout between verification and unit start;
    - core authorization not requiring commissioning for carried flows.

**New**

- **Knowledge upkeep, slice 2 (off by default).**
  - **What it does:** with `upkeep.mode: "observe"`, set by the operator, each merged change or document flow gets one recorded run with deterministic classification. There are no model calls, candidates or tasks.
  - **Who can change it:** the upkeep settings are operator-only; a delegate may only turn the mode down.
  - **Where to see it:** Settings → Policy → Knowledge upkeep.
  - See the [design](designs/knowledge-upkeep.md).

- **Local validation:** **1,463 tests passed**, zero failures or skips. Both fictional process evaluations and the shared console passed.
- **Review:** every change was independently reviewed (GPT-6.1 Sol) and re-checked until approved. See the [progress record](one-factory-progress.md).
- **Not qualified:**
  - the re-test of this release on the trial project, including the console's real-browser checks, the proxy's rebind wake on T3, and a real root-install upgrade and recovery;
  - models and GitHub at a large repository's scale.
- **Upgrade with a reviewed, drained adoption and commissioning,** using the release's own CLI. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.86

Includes dev.85. The fix release from the dev.85 readiness re-test, plus an adopter report (the reviewer did not see the reviewed plan) and the first, inert part of knowledge upkeep. There is no state migration, and the reference graphs are unchanged, so queued tasks need no re-approval.

**Action needed**

- **The default branch name must follow the target rule.** `repository.target` must now be at most 200 characters of letters, digits, `.`, `_`, `/` and `-`. It must start with a letter or digit and must not contain `..`. Workflow targets already followed this rule.
  - Validation, `config update` and doctor refuse any other name, and say what the rule is.
  - Names like `main`, `next` or `release/1.2` need nothing.
  - A project whose default branch uses `+`, `@`, `#` or a non-ASCII letter, or is longer than 200 characters, must target a conforming branch and run doctor before upgrading.
  - Factotum builds job, flow and notice ids from target names; this rule keeps them readable (J8, below).
- **Triage proxy users: copy `triage.example.mjs` again** and update the handling guide from the new template. The guide gains one placeholder, `[[merge-decision-role]]`. See [T3](integrations/t3.md#triage-proxy-thread-recommended).
  - **Exact send arguments.** Every forward carries a ready-made `send` object (`t3_thread_send` arguments). Pass it exactly as printed, including any `mcp:launch:` prefix.
  - **Retries.** Every run re-sends forwards still unconfirmed after 2 minutes, in rotation, at most three a run, under the same send ID.
  - **Recording a failure.** `--send-failed` records a failed send. After two failures on a thread, the proxy falls back to the last orchestrator session it saw.
  - **Escalation.** A forward still unconfirmed 10 minutes after it was decided, or with no thread left to try, is escalated. The proxy publishes an operator notice to the console's Inbox; it wakes nobody. The proxy reads the notice back and accepts it only if it is exactly the notice it asked for.
  - **How long a lost forward can stay quiet:** under 40 minutes with the default 30-minute timer, or under 20 minutes with `everyMs: 600000`.
  - **Orchestrator checks.** `--forwards --unconfirmed` and `unconfirmed` in `--counts` let the orchestrator check its forwards add up.
  - **Long ids.** Record ids of up to 640 characters, including `/`, are accepted.
- **Context entries with `..` after a symbolic link.** The context loader now resolves an entry's path the way the operating system does: it follows a link before applying a `..`. Earlier releases cancelled the two as text.
  - For almost every project nothing changes.
  - A `context.files` entry where `..` follows a link may now be delivered from a different file, or be refused if the real path leaves the project.
  - `missing/../AGENTS.md` and `AGENTS.md/` now find nothing.
  - A flow holding a plan reviewed under the old context replans once.
- **The `upkeep:` task namespace is reserved.** In any letter case:
  - a task id starting with `upkeep:` is refused;
  - so are a `sourceSync.namespace` or GitHub id prefix that would produce one.

  Existing tasks in that namespace stay editable, so they can be closed.
- **`status --inbox`, `--flow` and `--task` accept ids of up to 640 characters, including `/`.** New ids a caller chooses are still limited to 128.

**Fixed (from the dev.85 re-test and adopter reports)**

- **Scope review sees the plan.** The reviewer now sees the reviewed plan when judging scope. A file the plan plans to change is not a scope finding unless the change goes beyond the plan. A file the plan restricts, only refers to, or doesn't mention is still treated as out of scope.
- **Silent proxy failures (J7).** A forward the proxy failed to send no longer goes quiet. See Action needed.
- **T3 guide and proxy gaps (J9).** All 28 gaps in the T3 guide and proxy, from the trial orchestrator's notes, are fixed.
- **Long ids (J8).** Generated notice ids (up to 533 characters) can be read by id.
- **Console (J2–J6):**
  - Health keeps showing the previous main verification and its checks while a new one runs.
  - A main-verification attempt lists each check's result, run time and limit, including checks that timed out and checks that didn't run.
  - Event lists say "stopped at turn limit" instead of "passed".
  - Hold and re-verification times show in local time with a UTC tooltip.
- **Stale answers (J1).** A refused stale answer says whether its version was older or one the question never had.

**New**

- **Knowledge upkeep, slice 1 (inert).** It adds the records, path resolution and lesson signals that later releases build on. It makes no model calls, adds no settings and creates no tasks. See the [design](designs/knowledge-upkeep.md).

- **Local validation:** **1,368 tests passed**, zero failures or skips. Both fictional process evaluations and the shared console passed. Every change was independently reviewed (GPT-6.1 Sol) and re-checked until approved. See the [progress record](one-factory-progress.md).
- **Not qualified:**
  - the re-test of this release on the trial project, including the console's real-browser checklist and the proxy's retry and escalation on T3;
  - models and GitHub at a large repository's scale.
- **Upgrading:** use a reviewed, drained adoption and commissioning. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.85

Includes dev.84. Fixes two adopter reports: an upgrade's doctor step cut off at 10 minutes, and post-merge main verification cut off at 10 minutes. Also the remaining dev.84 re-test findings. There is no state migration, and the reference graphs are unchanged, so queued tasks need no re-approval.

**Action needed**

- **Main verification follows its checks' limits.**
  - **Before:** a `main.verify` step (post-merge, refresh or doctor) was cut off at a fixed 10 minutes, and the flow was left uncertain.
  - **Now:** the step is allowed the sum of its checks' `timeoutMs`, plus workspace setup, plus 3 minutes, at most one hour.
  - **A check that reaches its limit fails the verification.** Main goes red, and the notice names the check and its limit. The verification is repeated once automatically after 15 minutes. Its result no longer has to be resolved by hand.
  - **Totals over 57 minutes are refused** by `config update`, live setting changes and doctor after the upgrade. That counts the `mainChecks` `timeoutMs` values plus any registered flake retries. To fix it, lower the limits or move a slow suite into `scheduledTasks`. Putting checks in the scheduled tier doesn't help, because a full verification runs every tier.
  - **The override still works.** `timeouts["main.verify"]` still overrides the derived limit.
  - **Other maintenance steps** (`target.sync`, `audit`, `retention.archive`, integrations) now take their limits from their own settings.
- **Workspace setup commands now have a limit.** `workspace.setupTimeoutMs` defaults to 30 minutes and can be raised to 4 hours. A setup command that runs longer must set it.
- **The upgrade's doctor step can take longer.** `upgrade apply` used to stop doctor after 10 minutes and report "Provider timeout". Doctor can wait up to about 65 minutes for the machine-wide heavy-work permit, so the step's limit is now derived from doctor's own bounds, at most 4 hours.
  - The project runner stays stopped until doctor finishes. A console that runs from the project checkout restarts earlier, with admission held.
  - A failed step names the command, the phase and the limit, with redacted output.
  - Provider probe failures name the role, provider, model, call and kind of failure, and are retried once on a timeout.
- **Triage proxy users: copy `triage.example.mjs` again.**
  - A delivery forward's send ID is now `<deliveryId>:<n>`, one per forward. `--sent <deliveryId>` still confirms the latest.
  - Forwards record their target thread.
  - The T3 templates now mark fill-in values as `[[name]]`. A copy made from an earlier release keeps working. Compare it with the new template to get the successor's takeover section and the corrected paths for a prefixed installation.
- **`status --compact` is now one line of JSON**, about 40% smaller. It drops admission detail from finished queue entries and question fields from resolved items. Pipe it to a program.
- **The stale-answer refusal now explains itself** after "stale or resolved question:". A script that compares the whole string must match only that prefix.

**Fixed**

- **Turn limits (I2):** a build that stopped at its turn limit now reads "stopped at turn limit" (`outcome: "turn-limit"`) instead of "passed". The flow's completion notice comes through even at the `actionable` level.
- **Console (I1, I3):** the Flow slots card lists idle pools, and times in "Admission held" carry their UTC value in a tooltip.
- **Starter guides (I5):** they no longer link to Factotum docs that adoption doesn't install, and a test guards against leftover template text.
- **Check processes:** main checks run in a runner that empties the check's process group before recording the result. Before each signal it re-checks that a process is still in the group. A process that escapes the group is reported, and that run counts as unknown health.

- **Local validation:** **1,282 tests passed**, zero failures or skips. Both fictional process evaluations and the shared console passed. Every change was independently reviewed (GPT-6.1 Sol), and its blocking findings were fixed with tests. See the [progress record](one-factory-progress.md).
- **Not qualified:**
  - the re-test of this release on the trial project;
  - a real upgrade under a busy heavy-work permit;
  - systemd containment of escaped check processes;
  - models and GitHub at a large repository's scale.
- **Gate step:** it keeps its fixed timeout (`timeouts.gate`). Deriving it would change the reference graph and force re-approval, so it's a follow-up.
- **Upgrading:** use a reviewed, drained adoption and commissioning. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.84

Includes dev.83. The fix release from the dev.83 readiness re-test, and the first release the waiting adopter is meant to start on. There is no state migration, and the reference graphs are unchanged, so queued tasks need no re-approval.

**Action needed**

- **Builds may take more Claude turns.** Factotum passed `--max-turns 16` to every model step; a strict build in the re-test hit it. Builds now default to 60 turns; planners and reviewers keep 16. Set `providers.<role>.maxTurns`, or `stepModels.<workflow>.<step>.maxTurns` for one step (1 to 500). Settings shows each role's limit, or its default marked "(default)". Codex has no turn limit.
- **A builder that runs out of turns asks a build question** ("Retry the build"), which resumes the same session with the reviewed plan and the edits so far, instead of failing the flow. A planner or reviewer that runs out of turns stops at its step, so `resume` runs it again. The turn-limit result counts only when its session is the one the step started; anything else stays uncertain.
- **Read the warning before settling an uncertain model step.** Stop notices, resume refusals and `attempt.resolve` now say that settling an uncertain build and then resuming fails the flow and discards the reviewed plan.
- **Doctor no longer needs a pull after ordinary merges.** It refuses only when the operator checkout is behind on installed factory files or on files run from the checkout (source, integration and retention adapters, project workflow commands); for files that gate, fast and main checks, preview, scheduled tasks or `workspace.setup` run in factory workspaces, it warns with a count.
- **Merges into one target run one at a time.** A second answered merge shows `mergeWait` until the first and its post-merge step finish, then re-checks the target.
- **Triage proxy users:** forwards now carry the task title, carried questions and failed attempts, with a provenance line you can check with `--verify`; the setup and handoff guidance changed (the webhook stays on the proxy at handoff). Copy the new `starter/project/integrations/triage.example.mjs` and brief over an earlier copy. See [T3](integrations/t3.md#triage-proxy-thread-recommended).
- **Update the shared console's pinned copy** as well as each project's service, then restart both.

**Fixed (from the dev.83 re-test)**

- A queued task names the answered flows ahead of it (H10). The wrong-candidate notice says whether the pull request moved or the approval named another commit (H1). `triage.mjs --help` prints usage (H12).
- Console: flow detail shows the flow's slot state, the same as Queue (H3); Escape closes a grouped Timeline marker list (H5); flow ids in hold text are links (H7); one Back closes the flow window from any attempt (H4); the browser checklist matches the current UI (H6).
- Triage proxy: all 38 points from the live trial's orchestrator report addressed or listed as runtime follow-ups (H11); forwards stay under 8,000 characters; `--since` compares instants.
- Adoption guidance covers project scripts that walk the tree themselves, with `find … -prune` and `git grep` forms (H2).

- Local validation: **1,229 tests passed**, zero failures or skips; both fictional process evaluations and the shared console passed. Every change was independently reviewed (GPT-6.1 Sol) and its blocking findings fixed with tests; see the [progress record](one-factory-progress.md). Not qualified: the re-test of this release on the trial project (including the real-browser checklist and a live `error_max_turns` resume), the triage proxy's new setup and successor steps on T3, and models and GitHub at a large repository's scale.
- Upgrade with a reviewed, drained adoption and commissioning. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.83

Includes dev.82. The fix release from the dev.82 readiness re-test. It removes the four things that most often needed a person: flows stopping after an outside push, planner and builder questions, a merge question whose target moved, and a waiting flow holding the only slot. **Read "Action needed" before upgrading.**

**Action needed**

- **Parked flows free their slot.**
  - A flow waiting only on an answer no longer counts toward `policy.maxFlows`. That covers a plan question, a merge decision, a strict sign-off or a conflict question.
  - The new live setting `policy.maxParkedFlows` (default 3; `0` restores dev.82 behaviour) caps how many can be parked. It also frees their `categoryLimits` place.
  - An answered flow resumes as soon as a slot is free. Answered merges go first, then other answered flows, then new tasks.
  - Stopped flows still hold their slot.
  - The number of open flows can now reach `maxFlows + maxParkedFlows`. Each parked flow keeps its worktree and branch.
- **Ready plans with only non-blocking questions no longer stop.**
  - The planner, and the builder, now list such questions in a new `assumptions` field, each with the answer it assumed.
  - The plan or build goes on, and the reviewers are told to flag a wrong assumption.
  - The assumptions are carried to the builder, the merge card and the completion notice.
  - Blocking questions, a plan that isn't ready, and an incomplete strict risk assessment still stop.
  - The reference graphs are unchanged, so queued tasks need no re-approval.
- **A merge question whose target moved now says so.**
  - The card names both commits.
  - The answer's version rises, so an answer on the old card is refused as stale.
  - A `merge` answer goes back to integration only if the new target commits touch the candidate's files or declared paths. Otherwise the merge goes ahead, and the card says that review and checks ran against the earlier target.
  - GitHub's "branch is not up to date" refusal now routes back to integration instead of failing the flow.
  - Open merge questions probe their target at most once every five minutes.
- **A workflow copied from the template before dev.83 is not repaired by the update.** If `init` refuses it with "trusted command review cannot claim kernel evidence", rename its evidence entries to `rehearsal:review` and `rehearsal:gate`. See [running](running.md) and the [change record](changes/dev83-pr-adoption-fixes.md).
- **Exclude the installation from project-wide tooling.** That means linters, formatters, test discovery and coverage. See [adoption](adoption.md#keep-project-wide-tooling-off-the-installed-files).
- **External pull requests:**
  - `candidate.base` may now be any commit on the target. It is checked with Git, not GitHub's cached base.
  - A checkout with replace refs or a grafts file can no longer adopt pull requests.
  - Adoption refs left by earlier releases are not removed automatically; the commands to remove them are in [adoption](adoption.md).
- **CLI usage errors exit 2** with a message instead of a stack trace.
- **Update the shared console's pinned copy** as well as each project's service, then restart both.

**Fixed (from the dev.82 re-test)**

- **Flow admission:**
  - A flow started just after an outside push waits for main verification instead of stopping (G10).
  - Files merged into the target by other work no longer count as a flow's own changes for path overlap (G5).
  - A flow at `source` waits through a verification that is making progress, and stops with the action needed when nothing is verifying.
  - Replanning a flow takes a slot like any resume. This includes reviving an abandoned flow, which earlier releases didn't check.
  - A flow waiting only for its category no longer reserves a pool slot. The idle notice names it.
- **Builder questions** arrive as a full card, with what the builder did and its questions (G2). A replanning planner sees its earlier plan, with your answers numbered (G3). `status --task` shows acceptance, models and schedule time (G16).
- **Notices:**
  - A candidate that doesn't match its pull request stops with a notice naming each mismatch (G6).
  - The closing-keyword notice names the reference actually found (G7).
  - A failed trusted command records its last output lines, with known secrets redacted (G19).
  - A refusal to resume names the attempt and the exact reconcile command (G20).
  - An outside pull request refused for changing Factotum's managed files gets a notice naming the files, and one neutral comment on the original pull request (G25).
- **Console (R10):**
  - "Approve again" appears where re-approval is needed.
  - Doctor and job receipts follow the real run.
  - Held queues no longer promise automatic admission, and hold times show in local time.
  - Stats and Timeline fit phone width; grouped Timeline markers open an event list.
  - No text is smaller than 12 px, in either density.
  - Evidence links appear only for files that exist.
  - Findings are counted by severity.
- **Installed core:** functions named like React hooks are renamed, so adopters' React lint passes on the installed files.

**New**

- **Triage proxy thread guidance for T3** ([T3](integrations/t3.md#triage-proxy-thread-recommended)). Factory webhooks and timer checks go to a small proxy thread with fresh context for each notice. A starter rules script absorbs only what is provably routine and forwards stand-alone messages for everything else. The proxy also keeps a log, a digest and counts. It is untested on T3 itself.

- Local validation: **1,189 tests passed**, zero failures or skips; both fictional process evaluations and the shared console passed. Every change was independently reviewed (GPT-6.1 Sol, or Fable 5.2 for admission) and re-checked until approved; see the [progress record](one-factory-progress.md). Not qualified: the re-test of this release on the trial project, including the console's real-browser checklist for the new CSS, GitHub's live branch-protection wording, and models and GitHub at a large repository's scale.
- Upgrade with a reviewed, drained adoption and commissioning. There is no state migration. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.82

Includes dev.81. The fix release from the dev.81 readiness trial, plus an idle-load fix found on a long-running adopter. **Read "Action needed" before upgrading.**

**Action needed**

- **The first service start converts the state database.** Each attempt's dispatch intent moves out of the attempt record into its own record, which removes almost all idle load. Before this, an idle service re-read its whole history several times a second; one adopter's service used a full core. The conversion runs once, after the runner lock and before serving, at about 1 s per 100 MB of state, and keeps every intent byte for byte. A SQLite write fence then stops an earlier release from writing to the converted state. Factotum's own downgrade paths (`upgrade apply`, `upgrade activate`) convert back first, and `layout inline` does it by hand. An earlier CLI started by hand can still read a converted state, but it misjudges attempts it cannot see the intents of, and can change nothing. Schema version stays 1. See [running](running.md) for the `layout` commands.
- **Projects on the reference graphs re-approve queued tasks after recommissioning.** The reference graphs changed (planning, below), so their digest changed. Tasks approved against the old graph need approval again before admission.
- **Workflows must integrate before publishing.** Commissioning now refuses a workflow in which `forge.publish` can be reached other than from `workspace.integrate`'s `integrated` result through steps that keep the workspace unchanged. `forge.publish` also requires the workspace head to be the last clean integration. The reference graphs and the usual `commit → integrate → publish` shape pass. Run doctor after upgrading to see whether a project-owned graph needs changing.
- **Builders cannot change Factotum's own files.** A builder's change to `factotum.lock.json`, or to the managed `factory/`, `VERSION` and `compatibility.json`, is refused at commit, integrate and publish, including committed and later reverted edits. Upgrades still arrive through the target. `policy.allowFactoryEdits` lifts this for the core, but never for the lock.
- **Doctor checks the installed files.** A locked project whose installed factory files differ from the adopted release now fails doctor, naming the files. Line-ending conversion (`core.autocrlf=true`) is one possible cause.
- **`import-task` needs `--actor`**, like other commands.
- **`config update` prints only JSON.**
- **A project held by the notification-file defect stays held.** If an earlier release put the project on a recovery hold because of a notification file problem, release it with `restore.release`. Such a hold has no recorded cause.
- **Merge commit titles change** to `<task title> (#<PR>)`, with the flow ID in the message. Tooling that matched `Factotum delivery <flow id>` should use `git log --grep <flow id>`, which finds both forms.
- **Adopted pull requests:**
  - Their merge questions are operator-only on every path. An orchestrator can still stop the flow.
  - A direct `flow.start` is refused while another merge into the same target is in progress.
  - A new setting, `repository.adoptionNotice` (default on), comments on the original pull request.
- **The shared console runs from one pinned copy.** Update that copy as well as each project's service, then restart both.

**Fixed (from the readiness trial)**

- **Questions:** a waiting question no longer re-fingerprints the candidate every tick (R3). On 20,000 files with five open questions this took service CPU from 107% to under 5% and command handshakes from 1.8 s to 7 ms. A standalone question no longer confuses the engine's flow-question lookup (R1).
- **Cleanup:** a fetch losing a ref-lock race is retried. Failed cleanups retry through the cleanup plan, and normal cleanup lists the ignored files it deletes (R2).
- **Operations and configuration:**
  - A bad notification file pauses delivery instead of placing a recovery hold.
  - `config update` keeps file changes to live settings nobody changed live.
  - Real database faults keep their cause and place the recovery hold.
  - A malformed signing key is a configuration problem.
  - Other operational fixes.
- **Planning converges:**
  - Answering a planner question no longer uses a plan attempt (three free clarifications per plan cycle).
  - A "proceed with this plan" answer for ready plans held only by the planner's own questions.
  - Reviewers report every blocking finding in one round, scoped to the task.
  - Reference plan attempts rise from 2 to 3.
  - Plan-question items carry the planner's questions, options and risk.
- **Smaller fixes:**
  - The exact prompt is kept as `prompt.txt`, with every known secret redacted.
  - The brief's `outcome` is imported.
  - A readable plan comment.
  - Doctor passes a checkout that is only behind its target, but refuses when the missing commits change factory files or files the configuration runs.
  - Answer notes appear on answered items.
  - `status --inbox/--flow/--task/--compact` narrow reads.
  - Acknowledging never brings a reminder earlier.
  - Declared task paths go to checks and reviewers.
- **External pull request adoption (R5):**
  - A closing keyword in an outside commit is refused at `candidate`, before any model call.
  - Commits pushed to the original after adoption are listed in the merge question and the completion notice.
  - The outside author gets a comment and a linked replacement.
  - The `original-pr` obligation resolves itself.
  - Flows wait, not stop, while another merge is in flight, and stop with a named reason if the verifier stops.
- **Console:**
  - Stats shows Orchestrator session, Provider limits and Accounting coverage (R4).
  - Failed fast checks show as failures (`outcome: failed`).
  - Answered items are no longer badged Expired.
  - Decisions show who answered and signed off.
  - The merge card shows the pull request, candidate, review, checks and a diff link.
  - Stale stop reasons are hidden after resume.
  - Overview shows the commissioning hold.
  - Forge links are built only from the configured repository, and `http:` inbox links now show as text.
  - About 25 smaller items (R6).
- **T3 guide:** corrected setup order and a compact state filter. Ask prompts are off by default until a route is verified in your setup.

**New**

- **`adopt install --prefix <folder>`** installs everything under one folder, for projects with their own root `VERSION` or `factory/`. Upgrades find the prefix in `factotum.lock.json`. Root installs are unchanged.
- **Factotum's own test files are no longer shipped.** Upgrading removes the two that earlier releases installed and leaves the project's own tests alone.
- **A real-browser qualification checklist for the console** ([console browser](qualification/console-browser.md)).

- Local validation: **1,025 tests passed**, zero failures or skips; both fictional process evaluations and the shared console passed. Every change was independently reviewed (GPT-6.1 Sol, or Fable 5.2 for the protection work) and re-checked until approved. See the [progress record](one-factory-progress.md). Not yet qualified: the re-test of this release on the trial project, including the real-browser console checklist and the external pull request stage, live webhooks, and a T3 asking-thread route.
- Upgrade with a reviewed, drained adoption and commissioning. The state conversion happens at the first service start. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.81

Includes dev.80. Readiness release for adopting projects that move from their own factories. **Three changes need adopter attention; read "Action needed" first.**

**Action needed**

- **Git-launched gate checks no longer receive Factotum's GitHub token.** A gate check whose argv begins with `git` used to run through Factotum's credential-scoped Git helper and, for `fetch`/`push`/`ls-remote`, received the scoped token. Checks must never receive credentials, so they now run directly, keeping their timeout, environment and Git's non-credential safeguards (no automatic maintenance, no hooks, no signing, no system/global config). A check that needs a private remote will now fail to authenticate; provide the data as a declared input or move the step into a project-owned integration with its own credentials. `mainChecks` are unaffected.
- **Per-run model overrides must name configured models.** `flow.start` `modelOverrides` (which the orchestrator can set) and the new per-task choices may only name a model configured for the effective provider: in a role's `allowedModels`, or used by a configured role or step route. List any model your orchestrator overrides runs with in `allowedModels`.
- **Operator-only settings are enforced on every configuration path.** In dev.79 and dev.80, a delegated orchestrator could widen `policy.delegatedOperations` (for example to approve tasks) through `config.update` with `replaceLive`. That and every other operator-only live setting now require the operator on every path. If your orchestrator changed delegated operations that way, review the current value.

**New**

- **Fast checks between build and review.** Optional `fastChecks` run project scripts on the integrated candidate before review; failures go back to the builder with diagnostics and never count as gate evidence; each check can list the rules it owns, which reviewers then skip for that exact candidate. See [project workflows](project-workflows.md). Opt-in; graphs without it are unchanged.
- **Main-check tiers.** Each `mainChecks` entry may be `"tier": "scheduled"`: merges run only after-merge checks, schedules and doctor run everything, and a failing scheduled check turns the target red and holds new work until an entirely green full run or an attributed operator `main.health` exception. Red targets are probed so an external fix triggers one full run per head. New live setting `policy.scheduledHealthMaxAgeMs` (default 26 h). Projects without tiers are unchanged.
- **Host ask prompt as the front of the inbox.** `inbox.present` records that a question is also shown through a host's ask prompt, with an expiry; an answer by either route settles both; on expiry the question stays open and the presenter is woken once. Answers relayed from a prompt store the relayer, channel and the operator's exact words. T3 guidance (the ask tool cannot be withdrawn or attested, so the orchestrator asks from a cancellable delegated child) is in [integrations/t3](integrations/t3.md); its host assumptions are not yet qualified live.
- **Orchestrator handoff prompt.** `orchestrator.session` declares the session receiving deliveries; each delivery carries its number in the session; at `notifications.handoffAfterDeliveries` (default 100, repeating every 25) Factotum asks the orchestrator to hand off, never blocking work. Both settings are operator-only. Unusually frequent session resets notify the operator, who alone can acknowledge that notice.
- **Model defaults and per-task model choice.** Same-family review is now allowed and recorded as a pairing. Starter defaults: Opus 5.5 builds and plans, GPT-6.1 Sol reviews, Fable 5.2 allowed for important work. `task.models` sets per-role choices for one task without re-approval.
- **Provider usage-limit hold.** Claude rate-limit events and limit refusals, and Codex limit errors, are recorded; a notice at 90% (Claude only — Codex does not report usage percentages); on exhaustion, new work that could only start that provider waits until the reported reset (capped at 8 days; 5 h when no reset is reported) while running work continues; limit-ended attempts are classified and never retried or moved to another provider; `provider.hold` (operator) clears or extends. The exact shape of a live limit error from either CLI is assumed from binaries and retained traces.
- **Blocking reports** were already in dev.80.

- Local validation: **810 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Every change was independently reviewed (GPT-6.1 Sol) and re-checked until approved; see the [progress record](one-factory-progress.md). Not qualified live: provider limit events, T3 ask/child-task behavior, webhooks, browsers.
- Normal reviewed, drained adoption and commissioning; no schema migration. `authority migrate` remains withheld.

## 0.2.0-dev.20261022.80

Includes dev.79. Fixes a blocking adopter problem.

- **Doctor no longer fails when another project holds the shared heavy permit.** Doctor waited only 30 s for the machine-wide `heavy-work` permit, so an upgrade overlapping another project's heavy step failed commissioning and held the project. It now waits up to 65 minutes (the one-hour effect cap plus settling time); a dead holder is still reclaimed at once. While waiting it names the holder (project, flow, attempt, since): the CLI prints it, a requested doctor shows it on its request and in the console, and the failure reason names it if the bound is reached. Doctor requests still run in the service's operations loop, not as flows.
- **Blocking lane for adopter reports.** The feedback template, starter README, use-factotum skill and [adoption guide](adoption.md#reporting-problems-and-the-blocking-lane) define **Blocking** reports: the project's orchestrator or the operator marks them, the operator may downgrade them, and they are triaged ahead of other Factotum work in the same session. Project-owned templates are not replaced on update; copy the wording if wanted.
- Local validation: **721 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. The doctor change was independently reviewed (approved; its two reporting follow-ups are included). No live provider or remote forge qualification.
- Normal reviewed, drained adoption and commissioning; no configuration or schema migration. A project held at commissioning by the old 30 s wait can run doctor again after adopting this release.

## 0.2.0-dev.20261022.79

Includes dev.78. First release built from a clean committed source tree (`sourceState: clean-commit`, source `37ea698`). Manifest digest `0e82f7d81d0a01bd7891b55f755cd8dae1a1d1737bc4b0952b7c6a01431193bc`.

- **Quieter notifications (plan #1).** New `notifications.level: "actionable"` suppresses proven-clean delivery/document completions and successful target syncs, while keeping every attention-worthy outcome: failures, stops, findings and unverified acceptance in nested provider results or retained worker reports, unresolved review findings (resolved only by a later `fixed` disposition with evidence), recovered CI reruns, obligations and decisions. Canonical inbox records are kept. `essential` and `all` are unchanged. Opt in through settings.
- **Usage accounting and Stats (plan #16).** New invocations record versioned usage observations: Codex cumulative counters become per-invocation deltas, Claude costs use per-result deltas or qualified session totals, and replays, resets, overlaps and missing data are handled explicitly. Stats show measured tokens and list-price estimates with known/unknown coverage; periods or roles with no priced step show as unknown, not $0. Historical receipts are unchanged and stay unknown.
- **Original request provenance (plan #5).** Tasks can carry `originalRequest {origin, source, date, text?}`: the operator's verbatim words, or the true non-operator origin. It is part of the approved brief (editing it needs re-approval) and never counts as approval; workers see it as quoted provenance. Console, help, source sync and GitHub import carry it. Starter templates describe it; project-owned templates are not replaced, so copy the guidance if wanted.
- **Path-mapped context no longer invalidates its own plan (plan #13).** A governing file that the reviewed plan's own scope brings in no longer forces endless replans. Builds must use exactly the context package the passing plan review recorded; edits to governing files after planning are still rejected. A plan-scope file that the context budget would omit is now refused with advice to raise `context.maxChars`.
- **Effect supervision reliability.** A live, slow-starting supervisor keeps its attempt `launching` instead of turning `uncertain` after 5 s. A launch stalled before ownership can be stopped: a durable stop request first, then after 15 s an identity-checked freeze followed by kill or resume; an interrupted freeze is resumed after a runner restart. Supervisor stop handlers stay installed until the receipt is durable. A launch still starting after 10 minutes is reported (`launch-stalled`), never stopped automatically. New attempt files: `launch.json`, `abort.json`.
- **Decision-authority foundation, not yet for adopters (plans #7/#8, slices A–C).** The code for durable operator decisions, scoped operator grants and relayed answers is included but only activates on a migrated (schema 2) project, and this release still declares schema 1 only. **Do not run `authority migrate`**: it now refuses without `--unreleased-schema`, because no published release could upgrade or launch a migrated project. Schema-1 projects behave as before.
- **Test reliability.** About 30 tests no longer depend on wall-clock timing under load; no assertion was weakened.
- Guidance: helper scripts that planners or builders run should spawn child processes with stdin ignored (Node `stdio: ['ignore', 'pipe', 'pipe']`); the Codex Linux sandbox makes `spawnSync` fail with `EPERM` on a piped stdin even when the child succeeds. See [providers](integrations/providers.md).
- Local validation: **719 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Every change above was independently reviewed and re-checked before merge; see the [progress record](one-factory-progress.md). No live model, remote forge write, browser or downstream runtime qualification.
- Normal reviewed, drained adoption and commissioning; no configuration or schema migration.

## 0.2.0-dev.20261022.78

Includes dev.77.

- **Git operations suppress automatic maintenance.** Factory-managed Git invocations use `-c maintenance.auto=false -c gc.auto=0`, covering scoped delivery and unscoped workspace helpers, plus adoption, upgrade and archive/cleanup wrappers. Successful commits, merges and fetches cannot launch Git's automatic maintenance through those paths. No repository or global configuration is changed.
- **Containment remains enforced.** Surviving descendants still fail containment; no Git process exemption or retrospective success rewriting. Project scripts and providers that invoke Git independently own their invocation settings. See [Git integration guidance](integrations/github.md#configuration-and-credentials).
- Local validation: **574 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Two added regressions verify effective configuration precedence and real supervised commits using Git 2.56.0. A control commit launches automatic maintenance; scoped and unscoped factory commits retain their committed candidate, launch no maintenance child and finish with zero descendants despite enabled local configuration.
- Normal reviewed, drained adoption and commissioning; no configuration or schema migration. Existing local workarounds may remain. No live model, remote forge write or downstream runtime changes.

## 0.2.0-dev.20261022.77

Includes dev.76.

- **Builder prompts distinguish a reviewer verdict from the factory's decision.** They include the canonical review route and disposition. A strict `revise` requires resolving findings, including low findings attached to `pass`; a builder that needs clarification should report blocked with questions.
- **Unchanged corrections stop before another automatic review.** When a builder claims implementation after `revise` but the actual candidate still matches both its input and the reviewed candidate, the engine retains the unsuccessful attempt and stops at that build step. It emits a notice and preserves remaining visits, queue ownership and evidence. This applies to custom step names and ordinary revision requests too. Explicit guidance and resume/replan are required; strict acceptance rules and ordinary low-finding deferral remain unchanged.
- Local validation: **572 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Three new regressions cover actual prompt construction and engine settlement, the strict low-finding loop, explicit recovery with an edit, immutable evidence, custom steps, output-identity claims, initial/accepted/deferred/different-candidate builds, blocked/failed outcomes, operator stops and revoked approval. No live provider or remote forge qualification.
- Normal reviewed, drained adoption and commissioning; no configuration or schema migration. Existing exhausted budgets are not reset automatically. [Review correction holds and recovery](risk-review.md).

## 0.2.0-dev.20261022.76

Includes dev.75.

- **Replan notes reach agents.** `flow.replan` adds its note to flow guidance with actor and delegated operator attribution, as well as retaining the event. Automatic replans identify the factory. Command help now states this behavior; idempotent replay does not duplicate the note.
- **A new plan supersedes old gate feedback.** Replanning clears previous-cycle gate results, including custom node slots, from current agent inputs. Original attempts and logs remain intact. Ordinary builder corrections still receive current failures. This does not integrate branches; ancestry prerequisites use the opt-in hold/recovery path introduced in dev.75.
- **Uncertain publications retain their cause.** GitHub failures preserve structured HTTP/process details and bounded redacted stderr in action-result evidence. A failed reconciliation lookup retains both errors and keeps the write uncertain. The inspected receipt is retained on the uncertain attempt; no automatic retry or weakened containment.
- Local validation: **569 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Five added regressions cover actual planner/reviewer/builder prompt construction, attribution and command replay, custom gate slots and historical evidence, real CLI timeout/launch/HTTP failures, redaction and output bounds, failed PATCH reconciliation and a complete supervised uncertain publication.
- Normal reviewed, drained adoption and commissioning; no configuration or schema migration. Existing notes/errors are not backfilled, and no live project was changed. No live model or remote forge qualification. [Replan behavior](project-workflows.md#loop-budgets-and-recovery) and [GitHub error evidence](integrations/github.md#configuration-and-credentials).

## 0.2.0-dev.20261022.75

Includes dev.74.

- **Sync failures are reported as failures.** Generated `target.sync` and `main.verify` graphs route unsuccessful outcomes to failed jobs. A sync conflict's notice and job retain the adapter's reason, including the affected paths. A clean process exit no longer implies that the maintenance operation succeeded.
- **Failed synchronization holds admission independently of green health.** Dispatch records a durable hold for the configured branch pair. Failure or interruption keeps it; only a clean successful sync or proven no-op clears it. The destination still needs fresh verification afterward. Already-admitted flows stop at the gate if a hold appears. See [repair and recovery](operations.md#target-synchronization-and-source-holds).
- **Gate wrappers can distinguish prerequisites from product failures.** Optional commissioned `checks[].holdExitCodes` stops at the gate without another builder visit, retaining diagnostics and skipping later checks. A wrapper can reserve an exit code for missing ancestry; ordinary test failures keep their existing routing. No log-text inference or additional builder permissions. See [integration guidance](project-workflows.md#gate-prerequisites-that-builders-cannot-repair).
- Local validation: **564 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Five new regressions cover truthful job/notice outcomes, durable holds despite green verification, source dispatch fencing, clean no-op recovery, gate settlement races, reserved exit handling and configuration validation. Actual local Git sync/conflict/no-op fixtures verify the recorded source and destination identities. No live provider, remote forge, browser or downstream runtime changes.
- Use normal reviewed, drained adoption and commissioning. No database schema migration. Historical outcomes and notices remain unchanged; unresolved pre-upgrade failures require explicit sync and verification before releasing admission. The reserved-exit behavior requires a project-owned wrapper/configuration change. This release does not address the separately tracked intermittent service stalls.

## 0.2.0-dev.20261022.74

Includes dev.73.

- **Builder corrections receive gate failure output.** Failed/blocked check results now include bounded stdout/stderr/error excerpts, delivered inline to the next builder prompt, including resumed sessions. Full raw artifacts remain retained; candidate files and sandbox access are unchanged. Diagnostics are explicitly untrusted output.
- **Check wrappers can supply assertion details.** Gate commands receive `FACTOTUM_CHECK_DIAGNOSTICS`, a designated attempt-owned text file. If detailed failures are kept in external logs, the project-owned wrapper should write selected test names/assertions there. The factory will not follow arbitrary paths printed in logs. See [integration and bounds](project-workflows.md#gate-failure-diagnostics-for-builders).
- The original path sent only check metadata and an artifact filename; this behavior was present in inspected dev.5, dev.70 and dev.73 releases. No evidence establishes why particular earlier builders recovered successfully. Existing failed results/visit budgets are not rewritten; operator recovery remains explicit.
- Local validation: **559 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Four new tests cover real failing check subprocesses, provider prompt/session delivery, unchanged candidate identity, stdout-only fallback, passing checks, shared excerpt limits, large files, terminal controls and refusal of symlinks/directories/FIFOs. No live model or remote forge qualification was performed.
- Normal reviewed, drained adoption and commissioning. No schema/config change for stdout excerpts. Project verifiers that print only summary counts and external paths need the optional wrapper integration to deliver detailed failures.

## 0.2.0-dev.20261022.73

Includes dev.72.

- **Routine console snapshots stop exporting historical execution bodies.** The console's existing 2 MiB response cap rejects larger responses even before its 1500 ms deadline. `/v1/snapshot` now returns a dashboard projection, with execution results, command receipts, retrospectives and statistics loaded through the existing detail/history/stats endpoints. Canonical evidence and CLI `status` remain unchanged.
- **Polling avoids live Git eligibility scans and repeated full-history analysis.** SQLite selects compact fields before decoding records. Per-request metadata is reused for settings and schedules. Task summaries explicitly defer current admission eligibility to task detail; canonical admission still performs its full checks.
- **Attention and queue ownership stay complete.** Every open inbox item, unresolved obligation, unapproved finding, active/stopped flow and unsettled attempt remains visible even when older than the recent-history window. All queued IDs, task revisions, ordering metadata and the conditional queue revision are retained. Recent completed flow/attention summaries are limited to 20; current settings and schedule outcomes remain available.
- Local validation: **555 tests passed**, zero failures/skips; both fictional process evaluations and the shared console passed. Four added regressions cover a history-heavy service in a separate process, the real console/client, retained detail/history, complete queue and older attention, no Git during polling, response-cap enforcement and schedule metadata. Read-only comparison on an adopter database confirmed the compact projection fits under the unchanged response limit; it does not reproduce the exact earlier transient outage.
- No configuration/schema change. Adopt through the normal reviewed, drained update and commissioning. The shared dev.71 console is compatible: its console files are identical to this release's. This change does not require restarting it. Update the project service; live post-adoption responsiveness remains to be observed.

## 0.2.0-dev.20261022.72

Includes dev.71.

- **Target synchronization holds queued work.** A queued or running `target.sync` blocks admission into its destination. Dispatch invalidates that branch's health before any push; settlement requires fresh verification, including no-op and failed syncs. With `autoQueue`, eligible waiting work requests the normal target verification. Cached green for the old head can no longer drain a queue into source failures after synchronization.
- **Late observations cannot restore stale green.** Per-target health generations bind verification settlement to dispatch. Later synchronization, target movement, commissioning or operator health decisions supersede earlier results. A failed verification attempt cannot publish green. Source attempts prepared before an intervening health change or synchronization stop before dispatch.
- **Source drift is recoverable.** When a clean source check observes an unverified head, it invalidates the matching stale health and stops its flow at source, retaining the queue claim. After current verification, explicitly `resume` that flow. The original attempt remains unsuccessful in History; approval revocation and other existing stops remain authoritative. No automatic replay or rewrite of historical failures.
- Local validation: **551 tests passed**, zero failures/skips; both fictional process-evaluation projects and the shared console passed. Ten new regressions cover a seven-task queue, sync crash before settlement, no-op/conflict outcomes, prepared-source fencing, late source/verifier results, supervised verifier success, operator health overrides, revoked approval and operation-owned hold evidence. Existing real local Git tests cover sync and source preparation. No new live provider, remote forge, external webhook or browser qualification.
- No project configuration or schema change. Use normal reviewed, drained adoption and commissioning. For earlier source-only terminal failures, requeue under current approval after checking no active flow still owns the task; retain original evidence. A project pause prevents new maintenance from starting as well as new task admission. See [target recovery](operations.md#target-synchronization-and-source-holds).

## 0.2.0-dev.20261022.71

Includes dev.70.

- **Nested untracked repositories and agent worktrees no longer crash repository identity with `EISDIR`.** Directory entries contribute their path, mode and type; their contents and nested HEAD are outside the parent inventory. Git's tagged inventory distinguishes them from tracked directories without extra per-directory Git calls. Ordinary file, symlink and deletion encoding is unchanged.
- **Useful preparation errors.** Filesystem inspection failures name the quoted repository-relative path and retain the original code/cause. Unsupported special files are rejected before reading. Populated tracked submodules/gitlinks and tracked files replaced by directories remain explicitly unsupported, preserving the integrity boundary. See [repository fingerprints](running.md#repository-fingerprints-and-nested-worktrees).
- Local validation: **541 tests passed**, zero failures/skips; both fictional project evaluations passed. Nine added regressions cover real nested worktrees and embedded repositories, ignore rules, mode/HEAD/content behavior, legacy encoding and unusual filenames, symlinks, tracked gitlink refusal, path-specific errors, special files, parent input drift before dispatch and an actual supervised scheduled check with an unignored nested worktree.
- No configuration or schema change. Existing local excludes can remain. Use normal reviewed, drained adoption and commissioning. A previously stopped scheduled flow is not resumed automatically; explicitly dispose of it during the drain if necessary, then authorize a new scheduled-task run. No new live provider, forge or browser qualification was performed.

## 0.2.0-dev.20261022.70

Includes dev.69.

- **Disable GitHub CLI telemetry per invocation.** A retained containment receipt identified `gh send-telemetry` after a successful plan publication. All factory API and credential calls now force `GH_TELEMETRY=0` and `DO_NOT_TRACK=1`, overriding ambient opt-in without modifying global configuration. Update-notifier and paging controls remain in place.
- **Preserve reviewed plans after a known publication's containment failure.** When `forge.publishPlan` recorded a concrete comment with unchanged input and exit zero, but a surviving descendant caused containment failure, the attempt stays failed and the flow stops at publication. Explicit `resume` reconciles the marked comment in a fresh attempt using retained plan/review results and current authority. The supervisor's containment rule and evidence checks remain unchanged. This is not automatic replay of arbitrary effects.
- Local validation: **532 tests passed**, zero failures/skips; both fictional process evaluations passed. Five added regressions cover forced telemetry opt-out, supervised helper prevention, preserved-plan recovery and comment reconciliation, revoked authority, and refusal to apply this recovery to other failures/effects. Three read-only GitHub requests using installed `gh` 2.103.2 under real systemd supervision exited zero with no descendants. No remote writes or model calls were made.
- Normal reviewed, drained adoption and commissioning; no project configuration change required. Existing terminal failures retain their original disposition. A replacement flow reconciles the existing per-issue plan comment; this release does not transfer the old plan into it.

## 0.2.0-dev.20261022.69

Includes dev.68.

- **Queue scans stop repeating synchronous Git work per task.** Main-health maintenance and paginated Tasks reads reuse one conflict observation per active workspace. Fresh green target health skips the maintenance scan entirely. Final admission still refreshes conflict evidence. The console deadline remains 1.5 seconds.
- **A new stop after recovery gets a new notice.** Repeating the same reason after resume or replan no longer reuses an acknowledged notice. Repeated observation of one stop stays quiet, including legacy records. Existing notification preferences and actor attribution still apply.
- **Replan budgets are explicit.** Every step keeps cumulative visit history. `visitBudgets` in the public flow reports the current allowance, used and remaining visits separately. A refused transition consumes no visits or transitions, and replan clears stale stop/resume fields. Exhaustion messages name the bounded step. The standard reference still allows two plan entries per cycle; `plan-review` has no separate limit. Inspect findings and deliberately replan, or change a project-owned graph's limits for future flows; see [loop budgets](project-workflows.md#loop-budgets-and-recovery).
- Local validation: **527 tests passed**, including five new regressions for bounded Git observations, actual socket handshake/command/Tasks deadlines under a slow scan, signed repeat-stop delivery, legacy notice compatibility and repeated bounded replans. Both fictional projects passed the process evaluation. No new live provider, GitHub or browser qualification.
- Adopt through the normal reviewed, drained update and commissioning procedure. No configuration change or database rewrite is required. Existing retained evidence is preserved; this release does not resume or abandon stopped work automatically.

## 0.2.0-dev.20261022.68

Includes dev.67.

- **Explicit-target workflows start correctly.** Catalog approval includes an explicit target branch in the workflow identity; admission incorrectly retained only the graph digest, causing an immediate "workflow changed; revalidation required" stop. Direct starts, queue admission and task restarts now retain the approved catalog digest. Authorization recomputes that identity from the pinned graph and execution target, including immediately before dispatch. Graph validation remains enforced.
- **Recovery:** no project configuration workaround is needed. Pause admission and explicitly abandon affected stopped flows that have no attempt to reconcile, keeping their history. Adopt through the normal drained update and commissioning procedure, then start a fresh flow or requeue the current approved task when its target health permits. Do not resume or manually change the digest of an affected old flow. Unchanged workflow approvals remain valid; changing a workflow's target still requires reapproval.
- Task workflows carried across recommissioning retain the corresponding target binding. Graph-only identities for workflows without an explicit target, legacy projects, and maintenance remain compatible.
- Local validation: **522 tests passed**, including eight new regressions for the admission paths, target/graph tampering before dispatch, retargeted approval, custom workflow files, legacy/default compatibility and carried task workflows. Both fictional projects passed the process evaluation. No new live provider or GitHub qualification.

## 0.2.0-dev.20261022.67

Includes dev.66.

- **Model selection validates retained fallbacks.** The independent Sol 6.1 review found that a valid primary effort change could make an inherited fallback effort unsupported. Saved defaults and run overrides now check the effective fallback's model, effort, subscription billing mode and allowlist before acceptance. A rejected edit leaves defaults unchanged; a rejected override creates no flow.
- Set an explicit project-owned fallback effort when the primary and fallback need different values (for example, a Codex primary using `minimal` and a Claude fallback using `high`). Explicit fallback settings and resumed sessions retain their existing behavior. Disabled or discarded fallbacks are not checked. Previously invalid fallback configuration now fails configuration validation; correct it through the normal commissioned update. Reset any incompatible saved override before upgrading.
- Local validation: **514 tests passed**, including three new fallback regressions and an injected successful fallback invocation/resume. Both fictional projects passed the process evaluation. The reviewer independently passed all 511 dev.66 tests and the process evaluation; the correction was implemented and verified by the parent. No new live provider or GitHub qualification.

## 0.2.0-dev.20261022.66

Includes dev.65.

- **Settings → Models** edits provider, model and reasoning effort for every model-using step of each commissioned workflow. Reset restores the project default. The audit job has its own `maintenance/audit` entry. Old project services remain read-only until updated.
- **`models.update`** gives the orchestrator the same persistent default controls under normal delegated authority and a recorded instruction. It requires `settings.modelSettingsVersion`, validates against commissioned steps, and rejects stale edits. Explicit `policy.delegatedOperations` lists must add `models.update` if desired; default delegation already includes it.
- **Run-specific models:** `flow.start` and `task.restart` accept `modelOverrides: {stepId: {model, provider?, effort?}}`. `job.enqueue` supports it for audit (`run`). Unknown/non-model steps and unsupported routes are refused before admission. Model allowlists, subscription-only billing and review independence still apply.
- **Pinned routes:** run override → saved default → project `stepModels` → role default. Active flows retain their selected routes, including replans, retries and builder-session resume. Flow detail shows the pinned choices; attempt results report actual models and fallback use.
- **Updates:** saved defaults survive config updates and backups, without rewriting project workflow files. `config show` exports effective defaults. `config update --replace-live` clears saved defaults explicitly. Reset a saved default before removing/renaming its workflow or step, or use `--replace-live`. Model default edits need no drain/doctor; executable or policy changes still do. Every provider invocation still runs capability/authentication preflight.
- Local validation: **511 tests passed**, the two-project process evaluation passed, and Chrome verified save/reload/reset plus desktop and phone-width layouts. Provider selection was tested through injected dispatch; this release does not claim new live provider/GitHub qualification. See [per-step model guidance](project-workflows.md#per-step-models), also included in the downstream workflow skill.

## 0.2.0-dev.20261022.65

Includes dev.64.

- **`upgrade apply --activate`** for targets that only accept pull requests: once the reviewed adoption is merged on the remote target, it checks the drain, stops the project unit, backs up, fast-forwards the checkout, verifies the release digest is what landed, recommissions, runs doctor and restarts. Works with `--when-drained`.
- **A shared console is left running.** `--merge` and `--activate` stop the console unit only when it runs from this project's checkout.
- **Syncs after outside merges.** With `repository.syncTargets`, the operations loop checks each `from` branch's remote head every `policy.mainProbeMs` and queues a `target.sync` when it moved, so merges made outside the factory also reach `into`.
- No configuration change.

## 0.2.0-dev.20261022.64

Includes dev.63. From the second adopter's adoption report.

- **`rerunFailedChecks` inspects jobs, not run conclusions.** A required job marked `continue-on-error` fails while its run concludes success; such runs were missed. The gate now re-runs any pull-request run with a failed job (whole run), and a rerun passes only when none of its jobs failed.
- **Re-approving after a brief edit starts again.** A flow stopped because its task's brief changed can never resume. Approving the new revision now retires it (abandoned, open inbox items closed, its queue claim released), so the task is queued again (`retiredFlows` in the result). A flow with an unsettled attempt still needs `task.restart`. Admission now says when a stopped flow holds the task or a capacity slot, and how to clear it.
- **Replaced flows link to their successor.** When a task's next flow starts, abandoned earlier flows get `replacedBy` and the new one `replaces`; the flow detail shows "This flow was replaced" with a link.
- **`stop` is delegable**, so the orchestrator can drain for an instructed configuration change.
- **The effect timeout error states the limit** (1 to 3,600,000 ms) and the value given.
- **`adopt cleanup` accepts squash-merged review branches**: merged means an ancestor of HEAD, or already contained in it.
- No configuration change.

## 0.2.0-dev.20261022.63

Includes dev.62.

- **Checks are told their branch.** Gate checks and main verification checks get `FACTOTUM_TARGET` (the candidate's or verified branch) and `FACTOTUM_CHECK_KIND` (`gate` or `main`); the preview command gets `FACTOTUM_TARGET`. A shared check can apply branch-specific rules without guessing from refs.
- No configuration change.

## 0.2.0-dev.20261022.62

Includes dev.61. For projects with more than one integration branch, and branch protection that re-reads statuses.

- **Target branch per workflow.** A workflow definition can set `target` (a branch other than `repository.target`); its flows prepare from, integrate, publish to and merge into that branch. Flows record `target`. Route work to it by label.
- **Health per target branch.** The default target keeps `mainHealth`; others are tracked in `targetHealth` (snapshot `targets` and `targetHealth`). Admission, the queue banner, the main-moved probe, automatic verification requests and post-merge verification (`main.verify` with `payload.target`) all work per branch. The Health tab shows each branch. Doctor checks each target branch exists on the remote.
- **`repository.syncTargets: [{from, into}]`** merges `from` into `into` after every merge into `from` (new maintenance operation `target.sync`, run in a throwaway worktree and pushed). Already contained: nothing to do. A conflict stops without pushing, and the failed job notifies.
- **`repository.rerunFailedChecks`** (with `rerunWaitMs`, default 10 minutes): after the gate posts a passing status, it re-runs the head's failed pull-request workflow runs and waits for them, so a required check that read the statuses when the PR opened passes before the merge question. If they fail or don't finish, the flow stops at the gate. Raise `timeouts.gate` to cover checks plus the wait.
- No configuration change. Existing projects have one target and behave as before; workflow digests change only for definitions that set `target`.

## 0.2.0-dev.20261022.61

Includes dev.60.

- **Abandoning a flow closes what it left open.** `flow.abandon` and `task.restart` now resolve the old flow's open questions and notices (`superseded`, "flow abandoned"), so a restarted task leaves nothing to answer or acknowledge.
- **Abandoned flows say so.** Flows now carry `outcome`: `abandoned` for an abandoned flow, otherwise its state. Its `state` stays `failed`. History and the flow detail show the outcome.
- **Preview images open full screen.** Clicking a preview on a merge question opens it full screen in the console (arrow keys move between images; Escape or a click closes) instead of opening a `data:` URL in a new tab. Thumbnails are capped in height and top-aligned.

## 0.2.0-dev.20261022.60

Includes dev.59. Closes a race in `upgrade apply --when-drained`.

- **The hold starts at once and covers maintenance.** Each `--when-drained` run pauses admission from its start, drained or not, and the pause now also holds new maintenance jobs (`pause {paused, holdMaintenance: true}`; running jobs finish). A post-merge main verification can no longer start between the drain check and the upgrade. An operator's own pause is kept when the run ends.
- **The drain is checked before the services stop.** `upgrade apply --merge` refuses before stopping anything if work has started, instead of stopping it mid-run.
- **Stopped maintenance runs are cleared.** A maintenance run left stopped (for example by an earlier attempt stopping the services) never drains by itself: `--when-drained` abandons it and queues the same job again once the upgrade finishes (`requeued` in the result).
- No configuration change.

## 0.2.0-dev.20261022.59

Includes dev.58. Fixes from the first real runs of declared inputs and `--when-drained`.

- **Declared inputs reach every step.** They were copied only in `workspace.prepare` when it created the worktree, but source verification creates the worktree first, so nothing was ever copied: the planner and builder saw no inputs. They are now copied when the worktree is created (before planning), and `workspace.prepare` fills in any input an existing worktree lacks, so flows started earlier get them on their next workspace step. Ignored files don't change the candidate identity.
- **Upgrades catch up with the remote first.** `upgrade apply --merge` fetches the target, fast-forwards the checkout and rebases the review branch onto it before stopping anything (`sync-target` step), so work merged on the forge while it waited (such as the flow it waited for) is not pushed over. A diverged checkout or a branch that doesn't rebase cleanly stops it before any change.
- **`--when-drained` never leaves admission paused silently.** It lifts its pause when it ends, however it ends (including Ctrl-C or SIGTERM), also lifts a pause left by an earlier `--when-drained` run, and reports `pauseLeft: true` with the command to run if it could not.
- No configuration change.

## 0.2.0-dev.20261022.58

Includes dev.57.

- **Strict sign-off is one click.** The strict merge (or accept) question no longer asks you to type the commit you reviewed. It links to the candidate commit and to its pull request's changes (alongside any preview), and **Authorize merge** records the head the page displays as `reviewedHead`. The project still refuses it if the candidate or question changed since the page loaded, so what was shown is what gets merged.
- No configuration change.

## 0.2.0-dev.20261022.57

Includes dev.56. Fixes from the first real run of dev.55–56.

- **The preview runs for project-owned workflows too.** A configured `preview` was only added to the reference workflows, so a project's own `change.json` went from its checks straight to the merge question. It is now inserted in front of every merge question of any change or document workflow, reference or project-owned, at compile time: every step that led to the question leads to the preview first. A graph that already has a preview step is left alone. Takes effect at the next `config update` (re-approve queued tasks afterwards); running flows keep their pinned graph.
- **`source.promote` risk is explicit.** The payload's `risk` (`ordinary` or `strict`) is now documented in `command --help`, and the console's **Make it a task** asks for it (ordinary by default). Omitting it still means strict, as for any brief without a risk.
- No configuration change.

## 0.2.0-dev.20261022.56

Includes dev.55. The rest of the first adopter's feedback (items 5 and 6).

- **Declared offline inputs.** A brief can give `inputs: [{path, sha256?, note?}]` (also in the console's brief editor and GitHub/command source briefs): files the work needs that are not fetched during it. The task is not admitted until each exists in the project checkout (and matches its `sha256`); git-ignored inputs are copied into the flow's worktree and never committed; an input that is neither tracked nor ignored is refused; every model step's brief lists them. `inputs` is part of the brief, so changing it needs approval.
- **Preview before merge.** New optional configuration `preview: {command, timeoutMs, paths?}`. The change and document references then run a `preview` step after the last check: on the exact candidate, only when the change touches `paths`, writing screenshots to `$FACTOTUM_PREVIEW_DIR`. The merge question carries them and the Inbox shows them; a failed preview is shown, not blocking. New operation contract `preview`, service route `/v1/previews/<attemptId>?name=` (PNG, JPEG or WebP only, at most 5 MB), and the console allows `data:` images.
- No configuration change; `preview` is opt-in. Adding it changes the reference workflows' digest, so re-approve queued tasks after the `config update`.

## 0.2.0-dev.20261022.55

Includes dev.54. From the first adopter's feedback (items 1–4, 7 and 8).

- **Review follow-ups are ready to approve.** A follow-up issue is now created with the source's eligibility labels and a drafted `factotum-task` brief (outcome, one acceptance line per finding, the findings' files as paths, ordinary risk), so it imports as an unapproved task and approving it is one step. Still unapproved; edit the brief first if needed.
- **Make a tracked issue a task.** New maintenance operation `source.promote {taskId, outcome?, acceptance | doneWhen, paths?, workflow?, risk?}` (GitHub sources) adds the eligibility labels and a drafted brief to the issue and imports it. The console's tracked-item detail has **Make it a task**. Approving a tracked item now says how.
- **Command help.** `command --help` lists every command; `command --operation <name> --help` prints its payload fields (required or optional), whether it is delegable, and the right route for maintenance operations. Sending a maintenance operation (such as `source.sync`) as a command now says to use `job.enqueue` / `maintenance enqueue`. A missing note says "note is required" and what it should be.
- **`task.restart {taskId, revision, note}`** (delegable): records uncertain attempts of the task's open flow as failed at no cost, abandons the flow, approves the current revision and starts a new flow, with one receipt and a `task.restarted` event. Refused while a step is still running or after a merge. The task detail has **Start again**.
- **Following main.** When main moves under a running change (a direct commit), the build no longer stops with "target changed since reviewed plan" or "planned input changed". If none of the new commits touch the task's paths, the plan's files or a governing context file, the flow carries on against the new main (`flow.target-followed`, recorded in `flow.targetFollows`). If any do, or the planned paths are unknown, it replans with a fresh budget (`flow.replan` by `factory`). `policy.followTarget: false` restores the old stop.
- **`upgrade apply --when-drained`** pauses admission, waits for running work to finish (reporting every minute, up to `--max-wait-hours`, default 72), applies, then lifts the pause it set.
- **Setup checklist** for new projects: `starter/project/SETUP_CHECKLIST.md`, linked from `GETTING_STARTED.md` and the skill.
- No configuration change. `policy.followTarget` defaults to on.

## 0.2.0-dev.20261022.54

Includes dev.53. Attribution fixes on Stats → Failures and stops, checked against real data.

- **Abandoned and failed flows are labelled as such.** An abandoned flow reads "abandoned: <note>" and is attributed to whoever abandoned it; a failed flow reads "failed: <reason>", by the factory. They used to show the flow's last stop reason with no actor.
- **`by` is always set:** `operator`, `orchestrator`, `source` (a change the source sync picked up, such as an edited issue) or `factory` (the factory's own stop: a visit bound, a changed target, an uncertain attempt). `flow.stopped` events now record `source` and `factory` this way; source-sync and import task updates use `source-sync-` command IDs.
- **Older events are attributed more carefully:** from the command receipt of the same transaction only when it follows within half a second with no other actor's event or sync in between, and a task update made during a source sync counts as a source change. Anything else is the factory's.
- Count cards include `hits` (equal to `n`).
- No configuration change.

## 0.2.0-dev.20261022.53

Includes dev.52. Fixes from the first look at Stats with real data.

- **"The orchestrator stepped in" no longer counts routine merges.** A merge or accept answer the orchestrator gives as the configured decision role is counted in a new card, **Routine orchestrator decisions**. Stepping in is anything else it did on a flow: sending work back, retrying, replanning, resuming, stopping, abandoning, reconciling a step, or answering for the operator.
- **Stops count once and name who caused them.** A stop of a flow that is already stopped is not another stop, on the card or in the event log (`stopFlow` no longer writes a second `flow.stopped` with the same reason). Failures and stops show who caused each one.
  - `flow.stopped`, `flow.resumed`, `flow.replan`, `flow.abandoned` and `attempt.reconciled` events now record `by` (the acting role, or null for the factory itself); `attempt.reconciled` also records `flowId`. Older events are attributed from the command receipt written in the same transaction.
  - Reconciling an uncertain attempt now stops the flow with "the orchestrator reconciled an uncertain attempt" (or the operator), instead of always saying operator. Older stops are relabelled on the Stats card.
- No configuration change.

## 0.2.0-dev.20261022.52

Includes dev.51.

- **Stats rebuilt.** A window (by day for 7 or 30 days, by week for 12 weeks; 7 days by default), a headline and a bar per period on every card, faded bars where a period rests on fewer than five samples, and the flows behind any bar on click.
  - Changes, documents, tasks and maintenance are counted separately; maintenance has its own section by operation.
  - New figures: start of work to merge, split by planning, building, review, checks and waiting (on you, the orchestrator or the machine); time in the queue; first-review pass rate; one-build merges; review and build rounds; stops; orchestrator involvement; replans; check time and failures; slowest checks; main verification history; response times for questions; failures and stops with reasons; model steps by provider and model; tasks added, completed and open, and the age of approved work; merges by area.
  - **Subscription estimate:** what the work would cost at list prices, per change and per period by role (builder, reviewer, planner, other), plus tokens per period. A step uses its provider's own figure when the CLI reports one (Claude's `total_cost_usd`, now recorded as `reportedCostUsd`), else the new live setting `stats.pricing` (USD per million tokens per model: `input`, `output`, optional `cachedInput` and `cacheWrite`), else it counts as unknown and the card says how many steps were unpriced.
  - **By model:** the Models table shows each provider and model's tokens (input, cached input, cache writes, output), its estimate and the estimate per step, and a card stacks the estimate per period by model.
  - Removed: the old cost card (always zero with subscriptions), capacity observations, attributed regressions and the coverage card. The outcomes chart, which drew no bars, is replaced.
  - New read route `/v1/stats/<7d|30d|12w>`. The snapshot's `stats` summary is unchanged.

## 0.2.0-dev.20261022.51

Includes dev.50.

- **Queue tab simplified.** The Queue policy panel and the Claimed work panel are gone.
  - A banner appears only when the queue can't move on its own: a pause or other hold, doctor not passed for the current configuration, or main health holding change and document tasks (with the reason).
  - With automatic admission off, the banner offers **Dispatch now** and shows the last dispatch's outcome: what it started, or why nothing could start. With automatic admission on, there is no dispatch button; the loop already does this every pass.
  - **Started from the queue** replaces Recently started and Claimed work: running work plus work started in the last 24 hours.
  - The snapshot has a new `queueStatus` (`autoQueue`, `holds`, `lastDispatch`).
- **Operations tab replaced by Health.** It shows main health, anything that needs recovery (only when present) and unapproved audit findings, each with **Create a task from this finding** (the task still needs approval).
  - **Obligations are Inbox to-dos.** Open ones count in the Inbox badge and are resolved there (done, could not be done or deferred, with evidence).
  - **A flow's detail** now also lists its to-dos, rule proposals, regression reports and the context given to each step. The flow read (`/v1/flows/<id>`) returns `pushback`, `obligations` and `regressions`.
  - **Recovery:** Overview links to Health, and the Timeline shows a banner when a hold or an uncertain step needs recovery. Overview also flags a spending hold.
  - **Removed from the console:** the rule-proposal form (agents' proposals still appear in their flow and History), the machine observation records and History tab (the Timeline's machine charts replace them) and the Settings *Run now* for `machine.sample`. Notification deliveries, rule proposals and regression reports remain in History.

- **Live settings.** Admission, capacity, queue and notification settings change from the console (or `settings.update`) at once, without draining work or running doctor again: automatic admission, queue on approval, the change, document and task flow limits, main-health lifetime, the main probe interval, queue ranking, category order and limits, the orchestrator's delegated operations (operator only) and the notification level. They are left out of the configuration digest, so running flows and doctor stay valid.
  - `config update` keeps live values changed since, and reports them (`keptLiveSettings`); pass `--replace-live` to take the file's. New `config show --state <dir>` prints the configuration in force.
- **Run doctor from the console** (`doctor.request`), when doctor hasn't passed for the current configuration. The operations loop runs it and Settings shows the outcome.
- **Settings rebuilt** into sections (Status, Policy, Models, Repository and checks, Workflows, Advanced, This browser). Policy lists every setting with its effective value, including defaults, which were hidden before. Check commands are shown read-only (the settings view now includes each check's `command`). Workflows lists the whole catalog and how a task's workflow is chosen; before, only the default workflow showed.
- **Scheduled tab** now has Add a maintenance schedule, Enable for a disabled one, and a scheduled task's last report; Settings no longer duplicates them.

## 0.2.0-dev.20261022.50

Includes dev.49.

- **Document workflows.** A new workflow kind, `document`, and reference, `change.document`, for work that produces a document (research, a proposal, a guide) instead of code. It plans (under `policy.planning`), writes in a worktree, is reviewed and merges, with no check gate: the merge decision needs a passing review only. See [project workflows](project-workflows.md#workflow-kinds-change-document-and-task).
  - Own capacity: `policy.maxDocumentFlows` (default 2), separate from `policy.maxFlows`. Green main, path and area checks still apply.
  - Flows record `pool: "document"` and show in their own Timeline lane.
  - Without a gate, no `factotum/gate` status is published; a target branch that requires it refuses the merge.
  - Any effect node can carry `action.guidance` (text, at most 4000 characters), added to that step's model brief. The document reference uses it to say the work is a document and to review it without asking for tests.
- **An edit to a dependency's content revokes its dependents again.** dev.49 kept dependents approved on any dependency change. Now only progress keeps approval (state, lifecycle labels); an edit to a GitHub dependency's title or body revokes the dependent's approval, as before dev.49. Command sources opt in by giving dependency facts (or task rows) a `contentRevision`. Facts recorded before this release are treated as unchanged, so upgrading revokes nothing.
- **`policy.mainProbeMs`** sets how often the loop checks whether main moved outside the factory (default 60000, at least 10000; `0` turns the check off).
- **`policy.deferLowFindings`** (default `true`): set it to `false` to send an ordinary review that passes with only low-severity findings back to the builder instead of finishing with follow-ups.

## 0.2.0-dev.20261022.49

Includes dev.48.

- **A dependency's progress no longer revokes its dependents.** A dependency's facts (its state, such as closed, and its own revision) were part of a dependent task's brief revision. A dependency completing, or its brief being edited, therefore revoked the dependent's approval and aborted its running flow. Now, when the only difference is dependency facts, the dependent keeps its revision, approval and flow, and the new facts are still recorded for admission. A change to the dependent's own brief, or to which dependencies it has, still needs approval.
  - Command sources record a `contentRevision` (without dependency facts), and `source.verify` compares it.
  - Existing revisions are unchanged, so upgrading revokes nothing.
- **Aborted attempts settle as `aborted`.** An attempt stopped on request exits without a result, and its receipt records `reason: abort`. It used to be left `uncertain` and need `attempt.resolve`. It now settles as `aborted`, and resuming the flow reruns the same step.
- **Queue entries are released when their flow finishes.** A queue entry still `claimed` by a failed, abandoned or completed flow is marked `finished` (with `flowState`) by the operations loop. Recently started on the Queue tab still lists it.
- No configuration change.

## 0.2.0-dev.20261022.48

Includes dev.47.

- **Fix: a note given to `flow.start` was silently dropped.** It now reaches the flow's planner, builder and reviewer as operator feedback, exactly like a note on an answer.
- **Unknown fields refused:** `flow.start` now rejects any field other than `taskId`, `revision`, `flowId`, `candidate`, `alreadySatisfied` and `note`, so nothing is silently lost again.
- **New `flow.note {flowId, note}`** (delegable) adds guidance for a running or stopped flow's agents, from their next step on. The console flow detail has an **Add a note for the agents** form.
- **What agents see:** every model step's brief contains the task (title, acceptance), the governing context files (`context.files`), the risk instructions and all operator feedback for the flow (start notes, flow notes and answer notes).
- No configuration change.

## 0.2.0-dev.20261022.47

Includes dev.46.

- **A replan restores the visit budget.** `flow.replan` restarts the plan → build → review cycle. Every step reachable from the plan step now gets its full `maxVisits` budget back (recorded as `limitExtensions`; visit history is kept), and so does the transition budget. Previously, a replan forced by main moving could leave review one visit from its bound, which stopped a passing candidate. The `flow.replan` event lists the restored budgets.
- **Low-only findings on a pass become follow-ups.** At ordinary risk, a review whose verdict is `pass` and whose findings are all `low` now routes `defer`: the findings are filed as follow-ups (`forge.followup`) and the flow continues to the gate and the merge decision, instead of another build round. A review with any medium or higher finding, a `revise` verdict, or strict risk is unchanged.
- No configuration change.

## 0.2.0-dev.20261022.46

Includes dev.45.

- **Main health is kept current while work waits on it.** With `policy.autoQueue`, while tasks are queued:
  - **Stale, unknown or moved health:** if queued change work is held only by main health, the operations loop requests one `main.verify`. This uses the same configured grant as the post-merge verification. It doesn't retry within 15 minutes of a failed verification, and a recent red result is left for someone to fix.
  - **Moved main:** about once a minute, the loop compares the verified head with the target's remote head (`git ls-remote`). If main moved outside the factory, for example a direct commit, health becomes `unknown` with the reason ("Main moved outside the factory from … to …"). The verification then follows, instead of a flow being admitted and failing at `source.verify`.
- **Clearer reasons when main health holds work.** Each case now has its own message:
  - never verified;
  - stale (when it was last verified, at which head, against `policy.mainHealthMaxAgeMs`);
  - moved;
  - verification in progress;
  - red.

  Each says whether a verification is requested automatically or needs `main.verify`.
- **Tasks:** the large Queue readiness link in a task's actions is gone. An approved task that hasn't started now shows why inline ("Not started yet", with the project's latest admission reasons).

## 0.2.0-dev.20261022.45

Includes dev.44.

- **Inbox:** adding a notice or question now opens from a **New inbox item** button in the header on the Inbox tab, like New task, instead of an inline form.
- **Tasks:**
  - The source bar and related labels say **Task source** instead of "Issue source".
  - The Open / Needs approval / Approved / Tracked / All tabs are now a **Show** dropdown with counts, next to the Label dropdown.
  - Task list rows no longer carry an Approve and queue button. Approve from the task's detail.
- **Planning ahead removed.** Factotum no longer plans tasks ahead of admission. Change flows still plan and review the plan before building (`policy.planning`). A project that wants planning as its own workflow builds it in its own graphs and decides where the plan goes. Removed:
  - planning flows;
  - plan records;
  - the planning window;
  - `policy.autoPlanQueue`;
  - the `flow.plan` command and the Plan task action;
  - the Reviewed plan, Planning readiness and Plan records panels;
  - the Timeline's Plans lanes and "Plans made" tile;
  - the `plan` collection in History.

  Plan files no longer widen a queued task's conflict scope; only its brief paths count. The Queue tab now shows each selected task's admission readiness instead.
- **Upgrading.** `policy.autoPlanQueue`, `policy.planningWindow`, `policy.planMaxAgeMs` and `stepModels.planning` are ignored. `config update` lists them as `ignoredSettings`, so remove them from the configuration when convenient. Recommissioning retires any ready plan record. A retained planning worktree becomes a cleanup obligation for the operator, as before. Drain any planning flow before upgrading; one left active must be abandoned. The catalog name `planning` is no longer reserved.
- **Fix:** expanded sections such as Edit labels, Edit brief and raw records collapsed whenever data refreshed. Open and closed sections now keep their state across refreshes, on pages and in the detail modal.
- **Fix:** header buttons with the `hidden` attribute (New task, New inbox item) were still shown, because the button style overrode it.

## 0.2.0-dev.20261022.44

Includes dev.43.

- **Fix: abandoned flows were drawn as active up to now on the Timeline.** `flow.abandon` set `state: failed` and `abandonedAt` but no `finishedAt`. Such a flow also held its slot open, which pushed later flows into extra lanes.
  - `flow.abandon` now sets `finishedAt`.
  - The operations loop backfills `finishedAt` on any finished flow that lacks it: from `abandonedAt`, otherwise the flow's last recorded event. It marks those flows `finishedAtRepaired: true`.
  - The timeline ends a bar at `finishedAt` or `abandonedAt`, never at "now" for a finished flow. The events lane labels abandoned flows "Abandoned".
- No configuration change.

## 0.2.0-dev.20261022.43

Includes dev.42.

- **Timeline:** the Open panel is now **Active**. It lists one full-width row per running or stopped flow, with task title, kind, current step, start time and state. Selecting a row opens its detail.
- No configuration change.

## 0.2.0-dev.20261022.42

Includes dev.41.

- **No repeat wakes for a parked task flow's question.** When the configuration is re-applied, a task flow parked on an unchanged question keeps that question open, with the same ID, version and subject. No new question opens and nobody is woken. This applies to `config update` and the recommission step of `upgrade apply`.
- **When a question must be reopened** (its subject changed), the new question records who caused the rebind. Under `notifications.level: essential`, it doesn't wake the orchestrator when the orchestrator's own command caused it.
- No configuration change.

## 0.2.0-dev.20261022.41

Includes dev.40.

- **Fix: `upgrade apply` reported doctor failing when a parked task flow carried over.** Recommissioning rebinds the flow and supersedes its question. The engine reopens the question on its next step. In between, the flow was `ready` with no open question, so doctor's drain check counted it as blocking. A task flow at a question step with no attempt now carries over whether its question is open or about to be reopened. That covers doctor, `config update` and `upgrade apply`.
- **Recurring tasks accept brief field names:** `task.outcome` works as the title, as in a `factotum-task` brief. Give `title` or `outcome`, not both.
- No configuration change.

## 0.2.0-dev.20261022.40

Includes dev.39.

- **Timeline tab redesigned.**
  - **Open:** a full-width panel at the top lists open work. The Open/Finished tabs are gone.
  - **Slots:** below it, a project timeline for the last 6 h, 12 h, 24 h or 3 days. It shows each change slot, planning slot and any task or maintenance lanes as bars coloured by what the flow was doing: building, planning, review, checks, waiting for the machine slot, waiting on the operator or orchestrator, stopped, or other steps.
  - **Labels:** each slot shows what it is working on now.
  - **Events:** a lane marks merges, failures, stops, questions, upgrades and configuration updates.
  - **Tiles:** changes merged, plans made, completed, and idle slot time.
- **Machine charts.** CPU in use and disk wait, plus memory and swap in use. The operations loop now records a light host sample every two minutes. Samples are kept for 8 days, stored apart from `machine.sample` evidence. Machine samples also record CPU counters and swap.
- **Shared detail modal.** Selecting a flow or task anywhere opens its detail in a modal over the current page. That covers timeline bars and markers, open work, History rows, Overview, Inbox, Queue, Scheduled and the task's flow list. The address carries `?flow=<id>` or `?task=<id>`, so **Copy link** shares it, and opening the link shows the same detail. Closing it returns to the page.
- **Clickable rows.** History rows are clickable across the whole row.
- **New read route:** `GET /v1/timeline/<6|12|24|72>`.
- No configuration change.

## 0.2.0-dev.20261022.39

Includes dev.38.

- **Not-before times.** A task can carry `notBefore`, an absolute time with an offset. An approved, queued task stays queued until then (`scheduled: not before …`) and is then admitted normally. Set it in a brief (GitHub `factotum-task` block or command source row), in the console task form or the source **Create** form, or with the new `task.schedule` command. Changing it keeps approval. A source re-import only changes it when the source item itself changed.
- **Recurring tasks.** `recurringTasks` in the configuration creates a task on a daily, weekly or interval schedule. Each occurrence is a new task, approved by the commissioned configuration and queued. Only `task`-kind workflows are allowed. If the previous occurrence is still open, the new one is skipped with one notice. `recurring.run` creates one now.
- **Scheduled tab.** A new console tab lists tasks with a not-before time, recurring tasks, scheduled tasks and maintenance schedules, soonest first. Each row shows its next time and last outcome, with Run now, Pause/Resume (`schedule.pause`, which survives configuration updates) or Disable, and Edit time for tasks.
- **Fix:** the console rejected every `job.enqueue` command ("Invalid command envelope"). That covered Refresh on Tasks, Run now in Settings, Dispatch queue now and Create in the issue source. It now accepts them.
- **New commands:** `task.schedule`, `schedule.pause` and `recurring.run`, all delegable.
- **Configuration:** adding `recurringTasks` needs `config update` and doctor. Nothing else changes.

## 0.2.0-dev.20261022.38

- Task-kind flows parked on an open question (no attempt, no worktree) no longer block `upgrade apply`, `upgrade stage/activate`, `config update` or doctor. When the configuration is re-applied, each is rebound to the new executor, configuration and workflow, and its question is reopened (one new wake per parked flow). If the step it waits on changed meaning, the flow stops with a reason instead.
- No configuration change.

## 0.2.0-dev.20261022.37

- Under `essential` notifications, a maintenance job the orchestrator enqueued itself completes quietly; a failure still sends a notice.
- Queue shows **Recently started**: tasks the queue admitted in the last 24 hours, with their flow state and a Timeline link. With automatic admission, queueing no longer looks like it did nothing.
- `project/integrations/t3-notifications.example.md`: a T3 webhook handling-guide template. `docs/integrations/t3.md` describes a field-tested setup.
- No configuration change.

## 0.2.0-dev.20261022.36

- Fix: scrolled panels in the console (task list, timeline, record lists) no longer jump back to the top on each automatic refresh. Every scrolled element keeps its position.
- No configuration change.

## 0.2.0-dev.20261022.35

- **Workflow kinds.** Catalog definitions have a `kind`: `change` (build and merge, the default) or `task` (carried out and reported, no worktree or merge). New references `task.orchestrator` and `task.operator`: done closes the task and its issue; blocked returns it to the operator with the note; stop ends it.
- **Selection by label and brief.** Selection rules may match a `label` or a `category`; the first matching rule wins. A task's `workflow` field (from its brief or the console) overrides the rules.
- **Separate capacity.** Task flows use `policy.maxTaskFlows` (default 5), not `maxFlows`, and skip build-only admission checks.
- **Lightweight briefs.** `doneWhen` may replace the acceptance list; briefs may name a `workflow`. The same applies to command sources.
- Any answer can carry a note, and the next question in a task flow shows it. The console asks for a note when answering "blocked".
- The task view's selection details moved from `workflow` to `workflowSelection`; `workflow` is now the task's explicit choice.
- Using task workflows requires a catalog with them, `config update` and doctor. Existing configs are unchanged.

## 0.2.0-dev.20261022.34

- Abandoning a maintenance flow settles its job as `abandoned`. Maintenance also repairs jobs left `running` after their flow finished.
- A scheduled task's manual runs (Run now, or `scheduled:<name>` jobs) count towards its `runs` and `lastRun`.
- The upgrade drain refusal lists the flows that block it, with their kind and state.
- No configuration change.

## 0.2.0-dev.20261022.33

- Fix: delegated manual maintenance jobs (`--actor orchestrator --instruction`) now run end to end. dev.32 fixed the queued-job check, but the engine's per-step authorization still required an operator grant and stopped the flow. One rule (`manualJobGrant`) now governs all three checks.
- No configuration change.

## 0.2.0-dev.20261022.32

- **Scheduled tasks.** `scheduledTasks` defines project commands that run on an interval, daily or weekly schedule (with a timezone) in a clean checkout of the target. Exit 0 completes quietly. Any other exit sends one notice with the captured report. Settings → Scheduled tasks shows the last outcome and report, with Run now. They are config-owned schedules (`task:<name>`). See `docs/advanced-workflows.md`.
- Fix: delegated maintenance jobs (`--actor orchestrator --instruction`) were revoked before admission by a stale grant check.
- Setting `scheduledTasks` requires `config update` and doctor.

## 0.2.0-dev.20261022.31

- **Read-only maintenance workflows** (every step a `read` adapter):
  - a job or schedule without a candidate is bound to the checkout's current head;
  - a pass completes without a notice;
  - a failure produces one notice carrying the adapter's summary and observations.
  See `docs/advanced-workflows.md`.
- Fix: an integration job that cannot be admitted (not commissioned, missing candidate, invalid cap) now fails with a `reason` instead of faulting the operations loop into a recovery hold.
- No configuration change.

## 0.2.0-dev.20261022.30

- **Issue source capabilities.** Sources read, and can declare `create`, `lifecycle` and `close`. GitHub supports all three. Command sources declare them in `sourceSync.capabilities` and implement them through the same stdin protocol, with idempotent operation IDs and a `lookup` operation for uncertain writes. Lifecycle and close now also work for command sources. See `docs/source-sync.md`.
- **Create tasks in the source.** The new `source.create` maintenance job creates a task in the source and imports it unapproved. The New task popup offers "In GitHub" (or the configured source) and "Local only". GitHub creation is on by default; set `sourceSync.create: false` to turn it off.
- Command-source `read` responses may include task `labels`.
- **Tracked items.** `sourceSync.track` (`{"labels": [...]}` or `"all-open"`) imports GitHub issues that aren't workable tasks as read-only tracked items, with labels, state and a link. They can't be approved, queued or run, they close when the issue closes, and they become tasks when given a brief. Tasks has a Tracked filter.
- No configuration change is required; tracking is off unless `track` is set.

## 0.2.0-dev.20261022.29

- **Task labels.** Tasks can carry up to 16 labels for grouping. Labels are not part of the approved brief, so changing them keeps approval. Set them in the task form, with the new `task.label` command (delegable), or by import: GitHub issue labels become task labels, minus eligibility, import-state and lifecycle labels. Tasks shows label chips and a label filter.
- **Approve and queue.** `task.approve` accepts `queue: true` to approve and append to the queue in one step. The console offers "Approve and queue" for unapproved tasks and "Queue" for approved ones. Start appears only as "Start now" when automatic queue admission is off.
- **Console readability.** Flows are labelled by workflow and task name with a short tag instead of their UUID. Task rows drop the revision hash. Timeline lists Open and Finished flows, defaulting to Open. The projects panel can be collapsed. The issue source is a single line. New task opens in a popup from the project header.
- No configuration change.

## 0.2.0-dev.20261022.28

- Fix: an answer that landed between the engine reading a question step and opening its question could reopen the question after the flow had moved on. The engine now rechecks the step (question, wait and end steps) inside its transaction.
- A flow that completes or fails supersedes its open questions. Maintenance also supersedes questions already stranded open on finished flows, which clears existing duplicates after adoption.

## 0.2.0-dev.20261022.27

- **Breaking: `--actor` is required** on every command-executing CLI call (`command`, `config update`, `maintenance enqueue`, `cleanup apply`, `upgrade apply`). Scripts that relied on the old `operator` default must pass `--actor operator`.
- **Operator/orchestrator parity.** Every operator command can be performed by the orchestrator on a recorded instruction, attributed to itself. That now includes `config.update`, `restore.release`, `attempt.resolve`, `spending.reconcile` and merge and already-satisfied decisions. Kept by the operator's decision: strict-review sign-off stays human-only, and deploy and spending approvals need the new `policy.delegateIntegrationDecisions: true`.

## 0.2.0-dev.20261022.26

- Fix: an uncommissioned project now reports `project doctor qualification required` as an admission reason (Queue, task eligibility and status `commissioningRequired`) instead of showing tasks as ready.
- Fix: `queue.dispatch` on an ineligible queue completes as `no-eligible-task` with `heldReasons`; it no longer faults the operations loop into a recovery hold.
- `config update` warns that commissioning was cleared and prints the doctor command.
- `doctor` runs without stopping the runner while commissioning is not current (admission is already held). Re-qualifying a commissioned project still requires the runner stopped.
- `maintenance enqueue` honours `--actor` and `--instruction`; delegated enqueues record the orchestrator and instruction in the job grant and are accepted at dispatch.
- The console has a favicon.

## 0.2.0-dev.20261022.25

- **Behaviour change: fewer wakes by default.** New `notifications.level`, default `essential`. It wakes for questions, notices, approval changes and one flow-end notice per flow. It drops flow admitted, resumed, finished and stopped state events and superseded resolutions, and anything the orchestrator caused itself. Set `"level": "all"` for the previous behaviour.
- New `policy.queueOnApproval` (default off): approving an open, unblocked task appends it to the queue, and revoking or invalidating its approval removes it.
- Setting either option requires `config update` and doctor.

## 0.2.0-dev.20261022.24

- Drain checks for `upgrade apply`, `upgrade stage/activate` and doctor no longer block on ordinary pending obligations such as a human post-merge step. Only obligations that need authorization (`requiresAuthorization`, for example a failed lifecycle sync or a retained planning workspace) block. Carried-over obligations are listed in `carriedOverObligations`. Retention still requires every obligation resolved.
- When main health blocks admission because a main verification is queued or running, the reason names that job and says what happens next.

## 0.2.0-dev.20261022.23

- **Behaviour change: delegation is on by default.** Without `policy.delegatedOperations`, the orchestrator may perform every delegable operator action on a recorded instruction (`--instruction`). Set a list to narrow it, or `[]` to turn it off.
- Newly delegable: `answer` for routine operator questions (not merge, already-satisfied, strict-review or integration decisions) and `cleanup.apply`.
- Still never delegable: `config.update`, `attempt.resolve`, `spending.reconcile`, `restore.release`.

## 0.2.0-dev.20261022.22

- Tasks: open tasks awaiting approval show an "Approval required" chip and an inline Approve button in the list. A notice above the list and a count on the Tasks tab show how many need approval (snapshot `approvalNeededCount`). Approving still never starts or queues work.

## 0.2.0-dev.20261022.21

- Delegated operator actions: `policy.delegatedOperations` lists operator operations the orchestrator may perform on a recorded operator instruction (`onBehalfOf`, or `--instruction`/`--reference` on the CLI). Such commands are attributed to the orchestrator with the instruction. Default: none. `config.update`, `attempt.resolve`, `restore.release`, `spending.reconcile` and `answer` cannot be delegated. Settings lists the delegated operations.
- `docs/commands.md` maps every console action to its command and who may run it.
- Setting `delegatedOperations` requires `config update` and doctor.

## 0.2.0-dev.20261022.20

- Tasks no longer lists scheduled or manual maintenance runs. Their synthetic task records are kept as history but excluded from the Tasks view, the snapshot's `tasks` and `taskCount` (see `maintenanceTaskCount`) and the task collection (pass `include=maintenance` to list them).
- Each schedule in the snapshot and in Settings → Schedules shows `runs` and `lastRun` (status and time).
- No configuration change. Nothing is deleted.

## 0.2.0-dev.20261022.19

- Fix: notice deliveries accepted before dev.14 still carried a reminder time and were re-sent once more. An accepted attention delivery for an item that doesn't remind is now marked `delivered` when it falls due, without sending. No configuration change.

## 0.2.0-dev.20261022.18

- New optional `repository.ghPath` pins the gh binary for every GitHub call. Doctor reports the gh it resolves and warns (or, when pinned, fails) if it is a version-manager shim or wrapper script rather than the real binary. Doctor output now includes `warnings` and `gh`.
- Surviving-descendant evidence in receipts now includes `ppid`, `pgid`, `sid`, `exe` and up to four arguments (never the environment).
- A job whose action succeeded but failed only containment gets a "containment failed" notice saying its results were recorded and, for scheduled jobs, that the next run retries.
- New optional `cleanup.excludeIgnored` globs leave out ignored, reproducible paths from failed-workspace archives, listing them with digests. Default unchanged: archive everything.
- Setting either new option requires `config update` and doctor.

## 0.2.0-dev.20261022.17

- Archived cleanup of failed or abandoned flow workspaces: `cleanup plan`, `cleanup apply` (operator, bound to the plan digest) and `cleanup restore`. Everything in the workspace is archived and a test restore is verified before the worktree and branch are removed. Remote PRs and branches are untouched. See `docs/workspace-cleanup.md`.
- New optional `cleanup.maxArchiveBytes` (default 2 GiB).
- `flow.replan` refuses a flow whose workspace was released.
- `upgrade apply` steps now carry `ok` and `durationMs`; a failed step is the entry with `ok: false`.

## 0.2.0-dev.20261022.16

- `upgrade apply` guides a drained update: without `--merge` it prepares the review worktree; with `--merge` (after your review commit) it stops units, backs up, fast-forwards, optionally pushes (`--push`), cleans up, recommissions with the new code, runs doctor and restarts units. See `docs/updates.md`.
- `config update --current` re-applies the stored configuration.
- `service install` reports linger as `enabled`, `disabled` (with the `loginctl enable-linger` hint) or `unknown`.
- To adopt this build itself with `upgrade apply`, run the command from the release's own CLI (`<release>/starter/factory/cli.mjs`).

## 0.2.0-dev.20261022.15

- `adopt cleanup --root --branch --worktree` removes a merged, clean review worktree and its branch. `adopt install/update` output now includes the cleanup command.
- `service install|uninstall project|console` writes, enables and removes persistent `systemd --user` units with `Restart=on-failure`. Run `loginctl enable-linger "$USER"` once yourself for start at boot. Doctor reports a project unit that points elsewhere.
- No configuration change is required.

## 0.2.0-dev.20261022.14

- **Behaviour change: notices no longer remind.** An open notice is delivered once and then marked `delivered`. Previously it was re-sent every 30 minutes (four hours after `delivery.ack`) until acknowledged. Questions still remind until resolved. Set `remind` on `inbox.publish` to keep reminding a specific notice.
- `inbox.publish` accepts `remind`: `"never"` or an interval from 30 minutes to 7 days in milliseconds.
- `inbox.resolved` webhook payloads include `resolution` and `actor`.
- New `notifications.suppressSelfResolutions` (default `false`) stops resolution wakes for items the orchestrator resolved itself. Changing it requires `config update` and doctor.

## 0.2.0-dev.20261022.13

- `inbox.withdraw` lets the publisher or the operator withdraw an open standalone item with a reason.
- `source.sync` reports `skippedItems` with the reason each open issue was not imported.

## 0.2.0-dev.20261022.12

- Project-owned workflow catalog (`workflows`), approval binding to the selected workflow, `workflow export` and `workflow list`. Re-approve tasks after adding a catalog.
- The engine honours orchestrator merge delegation only when the graph's merge question requests `role: "orchestrator"`; run `config update` after adopting.

## 0.2.0-dev.20261022.11

- `policy.mergeDecisionRole` delegates ordinary-risk merge decisions to the orchestrator.

## 0.2.0-dev.20261022.10

- Tasks and Queue console views; operation contracts govern evidence, decisions and privileged results. Trusted commands may mint only prefixed observations.
