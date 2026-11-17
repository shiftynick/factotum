# dev.86: findings J1–J6 and J8 of the dev.85 readiness re-test

Seven findings from the dev.85 re-test:

- J1: the wording of a refused answer that named a future version.
- J2: Health hides the last run while main verification runs.
- J3: a turn-limited build reads "passed" in the flow's event list.
- J4: a main verification attempt shows no per-check results.
- J5 and J6: the re-verification time is raw, or has no UTC tooltip.
- J8: `status --inbox` refuses generated ids over 128 characters. Fixing it bounds target branch names, which is a breaking change for some adopters (see Action needed).

J7 and J9 (the triage proxy and the T3 guides) are being fixed separately and are not touched here.

For each item, this record gives the problem, the fix, compatibility and the tests with their fail-before evidence. This is a local implementation record, not a release, activation or live qualification claim. No provider or forge was called.

## Action needed

**Target branch names now follow one rule.** `repository.target`, every workflow `target` and so every `repository.syncTargets` entry must be at most 200 characters of letters, digits, `.`, `_`, `/` and `-`, start with a letter or digit, and contain no `..`. Workflow targets already followed this rule; `repository.target` did not (it only had to be non-empty and not start with `-`). Configuration validation, `config.update` and doctor now refuse any other default branch name, for example:

> repository.target must be a branch name of at most 200 characters of letters, digits, ".", "_", "/" and "-", starting with a letter or digit, without ".."; "release+1" is not. Factotum builds record ids from target names, so use a branch whose name follows the rule (rename the branch, or point repository.target at one that does), then run doctor

A project whose default branch is named like `main`, `master`, `develop`, `next` or `release/2026.11` needs nothing. A project whose default branch is longer than 200 characters, or uses another character (such as `+`, `@`, `#` or a non-ASCII letter), must rename the branch (or target a conforming one), update `repository.target`, and run doctor before upgrading. Factotum builds job, flow and notice ids from target names, and this rule is what keeps them readable (J8 below).

**The reference graph is unchanged.** No node, edge, answer or question text changed, so no workflow digest changes and no task needs approving again.

**No SQL JSON read over `records.data` and no full scan was added.**
- The attempt read gets a main verification's configuration with one keyed read of that attempt's intent (`store.intent(id)`), and only for an attempt whose result has main check rows.
- The previous run is copied from the health record being replaced.
- The hold times come from objects queue status already builds.

**Fail-before evidence.** `tests/dev86-console-j-items.test.mjs` (new, 8 tests) and the updated `tests/dev85-retest-items.test.mjs` were copied into an export of the base commit `64fcf7c` (`git archive`) and run there. `recordId` does not exist at base, so `core/contracts.mjs` there got a stub that throws, which let the rest of the file run. Result: 14 tests, **9 fail, 5 pass**. The 9 failures are the 8 new tests and the updated I4 test. The 5 that pass are the unchanged dev.85 tests. Each failure is quoted under its item.

## J1: the stale-answer wording for a version the question never had

**Problem.** An answer naming version 2 of a question at version 1 was refused with "it changed since it was read (version 2, now 1)". The caller had sent a version the question never had, so nothing had changed.

**Fix** (`core/stale-question.mjs`). The version case now says which mismatch it is. Versions only grow and start at 1, so:

- an older version: "it changed since it was read (version 2, now 3)" (unchanged);
- a newer version: "the version given (2) is not the current one (1); it has never had that version";
- no version: "no version was given (it is at version 1)";
- a value that is not a version number (a string, 0, a fraction): "the version given ("1") is not a version number (it is at version 1)".

Every refusal still begins "stale or resolved question:" and ends "read it again before answering". All four answer paths use the same function.

**Tests.** New "J1: an answer naming a version the question never had …". The existing I4 test's missing-version line now expects the new wording. Fail-before: `actual 'stale or resolved question: it changed since it was read (version 2, now 1); …'`; I4: `a missing version is still refused`.

## J8: generated ids longer than 128 characters could not be read back

**Problem.** `status --inbox` validated the id with `id()`: at most 128 characters of `[a-zA-Z0-9._:-]`. The failed main-verification notice `flow-notice:maintenance:main-refresh:<time>:failed:<digest>` is 132 characters, so the narrow read the guides prescribe refused it. The project service's flow, task, job and attempt reads used the same check. The console's read route allowed 160 characters.

**Why the bound depends on target names.** A maintenance flow's id is `maintenance:<job id>`, a flow's notice is `flow-notice:<flow id>:<outcome>:<digest>`, and several job ids embed a flow id or target branch names. The first version of this fix assumed 243 characters was the longest and allowed 512. A review showed the longest form, built from two 200-character workflow targets, is 533. And `repository.target` had no bound at all (only "non-empty, not starting with `-`"), so a sync pair that names the default branch gave ids with no maximum and possibly characters a lookup refuses. The operator chose to bound `repository.target` with the workflow-target rule rather than change any generator, since changing generated ids would change the ids of existing records and the lookups that deduplicate by them.

**The bounds of the parts** after this change:
- a target branch name, at most 200 characters (`TARGET_BRANCH_MAX`, the rule above);
- a flow id a caller chooses, at most 128 (`id()`), and Factotum's own flow ids are uids (36);
- a digest, 64 characters; a generated time, 24 (`toISOString`); a head prefix, 12;
- the longest outcome word, `completed` (9).

**Every generated form at its longest.** The job, flow and notice columns are the ids a maintenance flow of that job gets. Every row marked "driven" is built by its real generator in the new test.

| Job id (generator) | Job | Maintenance flow | Its notice |
| --- | --- | --- | --- |
| `target-sync:outside:<from>:<into>:<head 12>` (`operations/main-freshness.mjs` `ensureTargetSync`, driven) | 434 | 446 | **533** |
| `target-sync:<flow id>:<into>` (engine, after a merge; driven) | 341 | 353 | 440 |
| `main-timeout-retry:<target>:<time>` (`operations/main-freshness.mjs` `verificationRequest`, driven) | 244 | 256 | 343 |
| `main-refresh:<target>:<time>` (`verificationRequest`, driven) | 238 | 250 | 337 |
| `post-merge-main:<flow id>` (engine, after a merge; driven) | 144 | 156 | 243 |
| `lifecycle-stop:<flow id>` (`core/project.mjs` `stopFlow`; driven) | 143 | 155 | 242 |
| a schedule's digest, or a uid (`job.enqueue`) | 64 | 76 | 163 |

The other inbox ids are shorter:
- `cleanup-notice:<flow id>`: raised only for a completed flow with an owned workspace, so a task flow (at most 143); with the longest maintenance flow id it would be 461;
- `authority-race:<attempt id>:<decision id>:<version>`: about 200;
- `relayed-answer:<id>`, `pushback:<digest>`, `finding:audit:<digest>`, `recurring-skipped:<key>`: under 200;
- `provider-hold:<provider>`, `provider-limit:…`, `queue:idle-capacity`, `orchestrator-session-resets:<n>`, `upkeep-suspended:<part>:<ms>` (from main's knowledge-upkeep slice, at most 38), a question's uid, a published item's id: short.

So the longest id Factotum can generate is **533 characters** (`GENERATED_ID_MAX`): the `completed` notice of the maintenance flow that brings one 200-character target up to date with another after it moved outside the factory.

**Fix.**

- **`core/contracts.mjs`.**
  - `TARGET_BRANCH_MAX` (200), `TARGET_BRANCH_RULE`, `isTargetBranch` and `assertTargetBranch`: the target branch rule, moved from `core/catalog.mjs` so both callers share it.
  - `GENERATED_ID_MAX` (533) with its derivation in the comment, and `RECORD_ID_MAX` (**640**), which leaves headroom over it.
  - `recordId` validates an id that names an existing record: at most 640 characters, starting with a letter or digit, from `[a-zA-Z0-9._:/-]`. The error starts "invalid <label>" as before and then gives the rule. `id()` is unchanged, so new ids a caller chooses are still at most 128 characters.
- **The rule's callers.** `core/configuration.mjs` checks `repository.target` with it; `core/catalog.mjs` checks each workflow's `target` with it (the same rule as before, now with the clearer message). A `repository.syncTargets` entry must name two of the project's targets, so it is bounded by the same rule. Doctor validates the configuration first, so it gives the same message.
- **The lookups use `recordId`.**
  - `status --inbox/--flow/--task` (`operations/state-view.mjs`).
  - The project service's task, job, flow, artifact and preview reads (`service/project-service.mjs`).
  - The console's read-route subject (`console/console.mjs`, the same 640 and characters). The route splits the path before decoding, and the subject is encoded on the way to the service, so `/` is safe there.
- **Not changed.** Other id validators check ids a caller chooses, not generated ones: decision ids in `core/decision-authority.mjs` and `operations/authority-migration.mjs`, task workflows, grants and the console's binding and grant ids. They keep 128 or 160 characters. No generator changed.
- **Docs.** `docs/project-workflows.md` and `starter/project/SETUP_CHECKLIST.md` state the target branch rule.

**Tests.**

- New "J8: the longest id of each generated form is built by its generator and read back everywhere". A project with a 200-character default branch, a workflow targeting another 200-character branch and a sync pair between them. It drives each job generator in the table: the probe (`ensureTargetSync`), a merge of a flow with a 128-character id through engine settlement, `verificationRequest` for a timed-out and an unverified target, and `stopFlow` of a change flow from an issue source. The operations loop admits each job as its maintenance flow, and `flowNotice` writes that flow's notice. Each length must match the table, and the longest must be exactly `GENERATED_ID_MAX` (533). Every job, flow and notice id is then read back through the CLI's `status --flow` and `status --inbox`, the project service's flow and job reads, and the console's flow and job routes.
- New "J8: a default branch name outside the target rule is refused …": `main`, `release/2026.11` and a 200-character name pass; a 201-character name, `release+1`, `feature@x`, `-main`, `_main`, `a..b` and a name with a space are refused with the rule and what to do; a long name is shown shortened; a workflow target and a sync pair outside the rule are refused.
- "J8: the longest generated ids pass the read validator …" checks hand-built forms (the 243 form, the finding's 132-character id, a target with a slash) and the 640 bound.
- "J8: status --inbox, the project service and the console read …" reads a real notice of a 156-character flow id through `stateView`, the CLI, the project service and the console, and checks that a 641-character id is refused.

Fail-before. At base `64fcf7c` every J8 test fails (`recordId missing at base`, stub). At `4dda83d`, the first version of this fix (512, no target rule), the file was run again with stub constants for the two new exports: 10 tests, **3 fail, 7 pass**. The generator test fails on `RECORD_ID_MAX > GENERATED_ID_MAX` (512 is below the 533 the generators build), the refusal test with `Missing expected exception` for a 201-character `repository.target`, and the hand-built-forms test on the old "at most 512" message. The 7 that pass are the other items' tests and the 156-character read, which 4dda83d already fixed.

## J2: Health hid the last run while main verification ran

**Problem.** Dispatching a main verification replaces the target's health record with "unknown, Main verification in progress", which has no checks. During an 11-minute run, Health showed no "Last run" and no checks.

**Fix.**

- **`operations/targets.mjs`, `setTargetHealth`.** A health record without its own `checks` keeps the last completed run as `previousRun`:
  - status, head, target and check time;
  - tier and tiers;
  - its checks;
  - its attempt, source and reason;
  - its timeout fields.

  That covers a verification in progress, a merge's "verification required" and an operator exception. The previous run is copied forward until a new record has checks of its own. Admission, freshness and Stats never read it.
- **`core/engine.mjs`.** The in-progress record also says `running: true`.
- **`console/ui/operations.mjs`.** Health shows:
  - "Verification running" beside the status, for `running` or for the in-progress reason on an older record;
  - a "Previous run" row with the run's status, head and time, and every check with its result, marked as the previous run.

  Its help text says admission goes by the current result.

**Test.** New "J2: while main verification runs …". A real verification runs and settles red. A second verification is dispatched through the engine. The in-progress record must keep the first run's checks. A later record without checks keeps the same run. Health shows "Verification running" and "Previous run red at <head>" with both checks and a time element. A completed record shows no previous run. Fail-before: `actual undefined, expected true` (`running`).

## J3: the flow's event list called a turn-limited build "passed"

**Problem.** The `attempt.settled` event carries `passed: true` (the effect ran cleanly). The event list printed "passed" with a green dot even for a build that stopped at its turn limit, or for a failed fast check.

**Fix.**

- **Core** (`core/engine.mjs`). The settled event also records the routed `outcome` (`turn-limit`, `failed`) when settlement derived one.
- **Console** (`console/ui/records.mjs`). `settledResult` gives a settled event's result:
  - the attempt's derived result (`attemptStatus`) when the page has the attempt;
  - else the event's recorded outcome;
  - else "passed" or "did not pass".

  `eventDetail` and `eventList` take the page's attempts. The dot's tone follows the result: amber for the turn limit, red for a failure. "Flow events" passes the flow's attempts, and Overview's "Recent activity" passes the snapshot's.

**Tests.**

- New "J3: an event list reads a turn-limited build as stopped at its turn limit …": from the attempt, from the recorded outcome, and the plain cases. Fail-before: `actual 'Attempt settled — passed · attempt attempt-…'`.
- The J4 end-to-end test checks the recorded outcome and the rendered line for a real failed verification. Fail-before: `actual undefined, expected 'failed'`.

## J4: a main verification attempt showed no per-check results

**Problem.** The attempt panel of a `main.verify` flow showed "hang failed · timeout failure" and the total run time. It did not show the passed checks, each check's limit, or how long each ran.

**Fix.**

- **`service/project-service.mjs`.** The attempt read adds `mainVerification` for an attempt whose result has `mainHealth.checks`:
  - each check's id, tier and status;
  - its failure class and whether it timed out, with the limit it was stopped at and why;
  - when it started and ended, its exit code, runs, flake and reuse;
  - `checkTimeoutMs`, the check's `timeoutMs` in the configuration that attempt ran with (read from its intent);
  - the checks the step's time ran out for (`mainHealth.timeout.notRun`);
  - the step's own limit.

  It is bounded to 32 rows, and output and paths stay out.
- **`console/ui/timeline.mjs`, `mainVerificationView`.** The panel lists "Main checks", replacing the generic "Failed checks", whose help text is about fast checks. For example:
  - "✓ passed slow · ran 11 min 3 s · limit 15 min";
  - "✕ timed out hang · ran 4 min · stopped after 4 min, the time left in the step (its own limit 10 min)";
  - "○ not run after · did not start: the step's time was used up · limit 2 min".

  It ends with "This main.verify step could run … in all". A project service without `checkTimeoutMs` falls back to Settings' current limit, marked "(current configuration)".

The check rows themselves are unchanged. An untiered project's row shape is pinned by `main-check-tiers.test.mjs`, so the limit comes from the run's configuration rather than a new row field.

**Tests.**

- New "J3 and J4: a main verification attempt lists each check …" runs a real verification with a check that times out. It reads the attempt from the project service, with limits 60000, 1500 and 45000 from its configuration. It then renders the list.
- New "J4: checks the step's time ran out for are listed as not run …" covers a check cut short by the step, a pre-dev.86 row and a check that did not run.

Fail-before: `actual undefined, expected 'failed'`, and `timeline.mainVerificationView is not a function`.

## J5 and J6: the re-verification time was raw in Health and had no UTC tooltip in Queue

**Problem.** The main hold's text embeds the re-verification time as recorded ("requested after 2026-11-16T03:10:33.563Z").

- Health → Admission printed the text as it was, so the time was raw ISO.
- Health's "Automatic re-verification" line and Queue's hold banner showed a local time with no `<time>` element and no UTC tooltip.

**Fix.**

- **`operations/queue-status.mjs`.** The main hold carries `times`: the exact recorded strings its text embeds (the re-verification time, and the health record's check times). A stalled launch's hold carries its `since`.
- **`console/ui/admission.mjs`, `queueHoldNode`.** It renders a queue-wide hold with each of those times as the dev.83 `timeNode`: local time, `datetime`, and the title "<ISO> (UTC as recorded)". Flows it names become links. A project service without `times` gets the ISO times found in the text (`isoTimesIn`, `console/ui/dom.mjs`), as `localizeTimes` did.
- **Where it is used.**
  - Queue's hold banner uses it.
  - Health's "Admission" uses it.
  - Health's "Automatic re-verification" and "Checked" lines, and a previous run's check times, use `timeNode` directly.

**Test.** New "J5 and J6: the main hold carries the times it embeds …". A real red, timeout-only health record gives a pending re-verification. The hold's `times` is exactly `[after]`. Health's "Admission" and "Automatic re-verification" each have a time element with the UTC title and no raw ISO text, and "Checked" has one too. Queue's banner has the same, also for a hold without `times`. Fail-before: `the recorded re-verification time, as an exact string`, `actual undefined`.

## Compatibility

- **Health records.** A health record may now have `previousRun`, and an in-progress record has `running: true`. Nothing that decides admission reads either.
- **Events.** `attempt.settled` events may carry `outcome`. Old events have none: with the attempt loaded, the console derives the result from it. History's event rows have no attempts loaded, so an old turn-limited build's event still reads "passed" there; new events read correctly.
- **Reads.**
  - Queue status holds may carry `times`.
  - The attempt read may carry `mainVerification`.
  - The stale-answer refusal's version case has new wording, with the same prefix and ending.
- **Ids.** `status --inbox/--flow/--task` and the read routes accept up to 640 characters and `/`. Every id that used to be accepted still is.
- **Configuration.** `repository.target` must follow the target branch rule (see Action needed). Workflow targets follow the same rule as before; their refusal message changed to name the rule.
- **Browser checklist.** `docs/qualification/console-browser.md` was updated:
  - Pass A step 5 (Queue banner times) and step 9 (Health times, "Verification running", "Previous run");
  - Pass B step 3 (a main verification's checks) and step 4 (settled events in "Flow events").

## Results

| Check | First version (`4dda83d`, on `64fcf7c`) | After the review fix, merged with main at `83b0a9f` |
| --- | --- | --- |
| `npm test` | 1294 tests, 1294 pass, 0 fail | **1356 tests, 1356 pass, 0 fail** |
| `npm run eval` | exit 0 | exit 0 |
| `git diff --check` | clean | clean |

An earlier full run of the first version, before the J4 limit was moved off the check rows, failed only the row-shape test named above. The merge with main was clean; main's knowledge-upkeep slice adds one inbox id form (`upkeep-suspended:`, at most 38 characters).

## Open questions

- **The triage proxy's id check (for the J7/J9 work).** `starter/project/integrations/triage.example.mjs` refused a delivery whose `inboxId`, `flowId` or `taskId` is longer than 200 characters or contains `/`. Its bound should match `RECORD_ID_MAX`: **640**, with `/`. The proxy files were out of scope here.
- **Per-check limits of a passing check cut short by the step.** A check row records the limit it was stopped at only when it timed out. A passing check that ran under a limit the step's remaining time had shortened shows its configured limit.
