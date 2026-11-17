# R6: defects found driving the console in a real browser

Implemented against `main` at `5b6ed15`. This is a local implementation record, not a release, activation or live qualification claim. The trial drove the console in Chromium at desktop and phone width, in light and dark, through seven passes. It found six defects that would mislead an operator and about thirty smaller ones (trial findings F37–F41 and F44–F46). This change fixes the six, fixes most of the smaller ones, and proposes a reusable browser checklist for release qualification: [console real-browser qualification](../qualification/console-browser.md), linked from the [qualification record](../qualification.md#console-in-a-real-browser).

The repository stays project-neutral: tests and documents use fictional projects only.

## The six misleading defects

### 1. A failed fast check was recorded and drawn as a passed attempt

**Problem.** A fast check that failed settled with attempt `status: passed`. The step's result had `route: fail`, and the flow went back to the builder, as designed. The status means "the effect ran and settled cleanly", and the timeline coloured bars by status, so the failure showed as a green "passed" bar with "Exit code 0". The failing check and its diagnostics were only in `action-result.json`. Gate failures and red verifications had the same problem.

**Decision.** Attempt `status` does not change. It is read by every lifecycle rule: drains, retention, reconciliation, doctor, upgrade and cleanup all ask whether an attempt is settled. Stats also counts settled gates by it. A step that ran and reported a product failure is still a clean settlement, and routing follows its result, so changing the status would change behaviour well beyond the display. A separate field carries the outcome instead.

**Fix.**
- `core/attempt-outcome.mjs` (new): `attemptOutcome(status, result)` returns `{outcome: 'failed', failedChecks: [{id, status, failureClass?, exitCode?}]}` when a `passed` attempt's own result has `route: 'fail'`, and returns nothing otherwise. The list holds at most 16 checks.
- The engine's `settle` records it on the attempt beside `status`. This is one added statement after the status assignment. Routing and visit counting are unchanged: a failed fast check still returns to the builder, and the flow does not fail.
- `publicAttempt` projects `outcome` and `failedChecks`. For an attempt settled before this change, it derives them from the stored receipt. It also projects `route`, the step result's route, and `operation`, the operation name without its inputs.
- The flow detail read (`/v1/flows/:id`) adds each attempt's `checks`: id, status, failure class, exit code and the bounded diagnostics the runner already kept. Collections do not carry them, so history pages stay small.
- The console draws such an attempt as failed in the execution timeline and its table, in History → Attempts, and in the attempt panel. The panel's Status row says the step "ran to completion; reported a failure (route fail)". A **Failed checks** section names each failed check and its failure class, lists the rules the check enforces (from `fastChecks` in Settings), and shows its diagnostics. The exit row is now labelled "Process exit".

**What counts `passed`, and what changes.** Nothing that counts attempts changes its numbers.
- Stats counts gate runs by settled status and gate failures by the result route, as before. It counts model failures by `status: failed`, as before.
- `observedStats.attempts.byStatus` still counts a failed check under `passed`, because that is still the status.
- Notifications: `flowNeedsAttention` reads attempt lifecycle `status` (failed, uncertain, still running) as well as flow results and obligations. An earlier version of this record said otherwise; that was wrong. Its counting is unchanged: a check failure that the builder corrected keeps `status: passed` and does not make a completed flow need attention. See "Review fixes" below.
- Retrospectives, drains, retention, doctor and upgrade checks read `status` or `settledAt` and are unchanged.
- No migration: older attempts are projected from their receipts.

**Tests.**
- `tests/fast-checks.test.mjs` adds "a failed fast check settles as a run that reported a failure". A real supervised fast-check attempt fails. It keeps `status: passed`, records `outcome: failed` with its `failedChecks`, and routes to `build`. A passing run records no outcome.
- `tests/console-browser-defects.test.mjs`:
  - "defect 1 (record)": the projection of an older attempt.
  - "defect 1": the bar and table tone; the attempt panel's failed check, rule and diagnostics; no provider log is offered.

### 2. An answered question was badged "Expired"

**Problem.** Inbox derived "Expired" from the item's expiry time, whatever its status. Once the time passed, an answered question showed "Expired" beside "Answered … by the orchestrator".

**Fix.** Only an open question past its expiry is badged Expired; a resolved item shows its own status.

**Test.** "defect 2". An answered item past its expiry is badged answered, and an open one past its expiry is still badged Expired.

### 3. Decisions omitted answer notes, who answered and the merge sign-off

**Problem.** Flow detail → Decisions showed "→ replan", "→ merge" and nothing else. The notes were only in the flow events. A strict merge never said who signed off.

**Fix.**
- Each decision lists:
  - the answer by its label;
  - who gave it: the operator; the orchestrator; "the orchestrator on behalf of the operator" with the operator instruction it acted on; or, for a relayed answer, the relayer, the channel and the words quoted;
  - the answer time;
  - the note. An older item without `answerNote` falls back to `flow.answerNotes`.
- For the question that authorized a merge, or that accepted an already-satisfied outcome, it says who signed off and on which commit. It names the authority: the operator, the orchestrator on the operator's behalf, the designated strict reviewer, the delegated merge role, or the automatic-merge policy. For a strict merge it adds "after an exact-head strict review". Withdrawn and superseded items give their reason.
- Record change: an orchestrator answering a flow question for the operator now stores `onBehalfOf` on the answered item (`project.mjs`, one statement). Before, the instruction was only in the command receipt, or in `flow.answerNotes` when a note was sent.

**Tests.**
- "defect 3": the Decisions text for an operator answer with a note, a delegated answer whose note exists only in the flow record, and a strict merge sign-off.
- "defect 3 (record)": a real delegated merge answer stores `onBehalfOf` on the item.

### 4. The merge question had nothing to decide with

**Problem.** The merge card had no pull request link, candidate commit, review verdict or check results. The pull request URL and candidate head were only in the raw flow record. The flow summary's "Workspace" line showed the base head with no label, and it read like the candidate.

**Fix.**
- **Service.** `operations/merge-context.mjs` (new) builds `mergeContext` from the flow record:
  - `candidate`: the head the gate and review evidence were minted for, otherwise the published or adopted head.
  - `base` and `branch`.
  - `pullRequest`: `{number, url, adopted}`.
  - `review`: route, verdict, findings count, counts by severity, phase, a summary of at most 600 characters, and whether the review was of this candidate.
  - `gate` and `fastChecks`: route, check list, and whether the result was for this candidate.

  The dashboard snapshot attaches it to the open merge question only (`isMergeQuestion`: the flow's own open question at a `mergeDecision` step). It reads the flow with `store.get` in JavaScript and adds no SQL JSON reads. The stored inbox record is unchanged. Because the context is read when the snapshot is built, questions opened before this change get it too.
- **Card.** A **Candidate** section shows:
  - Pull request: a link, marked "(adopted)" for an adopted pull request.
  - Candidate commit: 12 characters, with a commit link.
  - Base.
  - Review: verdict, findings by severity, and phase.
  - Checks, and Fast checks when they exist: a summary with any check that did not pass.
  - Changes: "View the changes on <host>", the pull request's files page, or a compare link when no pull request is recorded.
  - The review summary.

  A result recorded for another commit is marked "recorded for … not this candidate".
- **Generic for adopted pull requests.** The card keeps showing the question's own `context` text above the section, unchanged. That text is where the external-PR adoption branch (R5) puts the adopted pull request's status and undelivered commits. `pullRequest` falls back to `flow.candidate.number` for an adopted pull request with no publication.
- **Flow summary.** "Workspace" becomes "Workspace branch" and "Created from" (the target head when the workspace was made). New rows: "Candidate commit" (with its basis: gated and reviewed, published, or adopted) and "Pull request". The earlier "Candidate" row for an adopted pull request is now "Adopted pull request".

**Tests.**
- "defect 4: the snapshot gives …" opens a real merge question through the engine and checks `mergeContext` in `dashboardSnapshot`.
- "defect 4: the merge question card shows …" renders the Inbox from that snapshot and checks the links (pull request, files page), the candidate commit, the review and checks text, and the summary.
- "defect 4: the flow summary labels …" checks the flow summary rows.

### 5. The old stop reason stayed after a resume

**Problem.** The stop reason stayed on flow detail, and on Overview's flow cards, while the resumed flow ran, waited and completed.

**Fix.** Flow detail, Overview flow cards and the attention list show "Stop reason" only while the flow is stopped. The History record view labels a leftover reason "Last stop reason (no longer stopped)". The stop and the resume are still in the flow's events and timeline markers. The engine's record is unchanged.

**Test.** "defect 5": a running or completed flow shows no stop reason, and a stopped flow does, in both flow detail and Overview.

### 6. Commissioning required looked like an idle, open project

**Problem.** With doctor not passed, Overview said "Idle", "Project admission is open" and "Approve a task and start it from Tasks". The attention card said doctor must be run "from the CLI", although Settings offered Run doctor. "Run doctor — completed" appeared as soon as the request was recorded.

**Fix.**
- Overview:
  - The project state reads **Commissioning required**. This is also the state shown in the sidebar.
  - A notice at the top says so, with a **Run doctor in Settings** link to Settings → Status. It reports where a requested run is: queued, running, waiting for the shared permit, or failed with its reasons.
  - The empty work card says nothing can start until doctor passes, and links to Run doctor.
  - The admission control's subject reads "Project admission is held until doctor passes".
  - The attention item links to Run doctor in Settings.
- The task detail hint now points to Settings → Status → Run doctor or the CLI.
- **Receipts.** The `doctor.request` toast reads "Run doctor — request accepted; doctor is queued and runs next. Its result appears here and in Receipts" (new `completedText` on command specs). The receipt is still canonically `completed`, because the request was recorded. It now shows "Request accepted ·" followed by the run's real state: Doctor queued, Doctor running, Doctor passed, or Doctor failed with its reasons. It matches the receipt's request id with `settings.doctorRequest`. When the console no longer sees that run, the receipt says so and points to Settings → Status.

**Tests.**
- "defect 6: with commissioning required …": Overview text and the link target, and the running state.
- "defect 6: Run doctor reports an accepted request …": clicks Run doctor in Settings through a stubbed console response, then checks the toast and the four Receipts states.

## Smaller items

Each item from F38–F41 and F44–F46 is listed below with what was done. Items that have a test are named by the test in `tests/console-browser-defects.test.mjs`.

| Trial item | Problem | Change | Test |
| --- | --- | --- | --- |
| F38 | A failed first refresh made the page say "Project not registered" | Without one successful read, the page says the projects could not be loaded and that this says nothing about registration | Not unit-tested: the logic is in `ui.mjs`, the browser entry. Covered by checklist C-11 |
| C1 | Overview's "Provider limits" link led to Stats without that section | Already fixed on `main` by R4 (`STATS_FIELDS`, `orchestratorSession`); declined here | Existing `console-stats-sections` tests; checklist A-08 compares the fields on the wire |
| C2 | The idle-capacity notice kept a hold's old deadline | Between reminders, an open notice's `blockers` and summary are refreshed when they change, without a version bump, so no new notification is sent. The notice also gets a title | "the idle-capacity notice has a title …" |
| C3 | "Open (3)" showed "10 tasks on this page" | "3 shown of 10 tasks on this page · 10 total" | "Tasks counts what the filter shows …" |
| C4 | No time zone anywhere; raw UTC ISO strings in hold and notice text | `time()` always names the zone. Axis ticks omit it, because their lane label carries it. `localizeTimes` rewrites ISO timestamps in stop reasons, attention details, inbox headings, context and notice bodies | "times name their zone …" |
| C5 | Health listed only the merge-tier check | Health's Checks list adds each configured scheduled-only check that the run did not include, with its last full-verification result, or "no full verification recorded yet" | "Health names every main check …" |
| C6 | "Run doctor above" with no such control | The sentence names Run doctor above only when it is offered | "Settings → Status mentions Run doctor above only when it is offered" |
| C7 | History → Flows led with machine identifiers; dates wrapped | The first column is the flow's name (workflow · task title · short tag). The Kind and Task columns are folded into it. Dates and elapsed times do not wrap | Not tested (a column definition) |
| C8 | Timeline event markers printed over each other | Markers closer than 1% of the track (scaled by zoom) are drawn as one marker with a count. The tooltip lists each event, and they stay one per row in the timeline table | "close timeline markers are drawn as one counted marker" |
| C9 | Dark "Revoke approval" had weak contrast | Danger buttons use dark text under the system dark scheme too, not only the explicit dark theme | CSS; checklist |
| C10 | A title-less notice used its whole message as its heading and repeated it; "Subject version 3 · digest …" shown | A title-less item is headed by its first sentence (`itemHeading`), and the idle-capacity notice now has a title. The subject digest row is removed from the card; it stays in the decision record and in confirmations | "a title-less notice is headed by its first sentence …" |
| C11 | "1 documents", "1 tasks"; "chang/e" breaking inside a table cell; "list-price" against "subscription" estimate | Stats sample units are singular for one sample (`unitFor`). Table cells break between words (`overflow-wrap: break-word`). The Policy label and the console guide say "list-price estimate", as Stats does | "sample units are singular …" |
| D3 | A failed cleanup was visible only inside its flow | Already fixed on `main` by R2 (the cleanup obligation and notice); declined here | Existing `cleanup-fetch-race` tests |
| D5 | The log selector offered `provider/stdout.jsonl` for a non-model attempt, which returned HTTP 500 | Provider logs are offered only for `provider.*` attempts (the new `operation` field); an unknown operation still offers all. The console backend now passes a project service's 400, 404 or 409 through instead of turning it into 500 | "the console keeps a project service 404 …"; the defect 1 view test checks the offered files |
| D5 | Uncaught "Cannot set properties of null (setting 'textContent')" | Cause: Copy link wrote to `event.currentTarget` after awaiting the clipboard, and the property is null by then; the catch did the same. `copyButton` keeps the button itself | "Copy link reports success …". On the base the code was inline in `ui.mjs`, so this test fails there for the missing helper, not by reproducing the exception |
| D6 | "1 attempts across 2 lanes"; focus went to the page after Escape; no Cancel on "Choose models for this task" | Plural fixed. Closing the detail modal returns focus to the link, row button or keyed control that opened it, by href, aria-label or focus key, after the page is rebuilt. A Cancel button closes the model choice | Not unit-tested: focus return is in `ui.mjs`. Covered by checklist B-07 |
| P1 | The project selector collapsed to 20 px | At phone width it takes the whole first header row (at least 12 rem wide, 44 px tall); presence and status share the second row | CSS; checklist D-01 |
| P2 | Touch targets of 25–34 px | At ≤780 px or with a coarse pointer, buttons, tabs, segmented controls, selects, inputs, link buttons, History collection tabs, Settings section links, project card links, project chooser items and disclosure summaries are at least 44 px tall. Timeline bars and event markers keep their sizes; see declined items | CSS; checklist D-01 |
| P3 | The active tab could be off-screen in the tab strip | Whenever the active tab changes (a link to another view, a deep link), it is scrolled into view. The strip's scrollbar is shown on touch screens | Not unit-tested: `ui.mjs`. Checklist D-02 |
| P4 | Chart text of 10–12 px | Stats column labels are 0.75 rem everywhere. On narrow or touch screens, axis ticks, column labels, bar labels and the "observed" marker are 0.8 rem (12 px) | CSS; checklist D-05 |
| B2 | Three different open-item counts | One count everywhere: open inbox items plus open to-dos (`openItemCount`) on the sidebar, the tabs and both Overviews. The Overview card says how many of each | "open-item counts agree …" |
| B3 | "Run doctor — completed" on acceptance | See defect 6 | defect 6 tests |
| B4 | After Create task, the cleared form stayed open over the success message | Command forms take `onCompleted`. New task closes its dialog and opens the new task in Tasks; creating in the task source closes the dialog | Not unit-tested: `ui.mjs` wiring; the hook is in `actions.mjs` |
| B5 | "Not before" labelled optional twice; settings changes had no note field | A label that already says "(optional" is not suffixed again. Live setting changes have an optional "Why (recorded with the change)" note, sent as the command note. The local-task form's height is declined (the modal scrolls) | Not tested (labels) |
| M4 | Resume disabled with "needs reconciliation" while the attempt was still running | `resumeBlockers` says the attempt is still finishing and to reload evidence. Only an uncertain attempt is called "needs reconciliation" | "Resume explains a still-running attempt …" |
| S1 | The stale-answer refusal did not say what had happened | Answer forms and buttons take `explainRejection`. After the refresh, a refused stale answer adds who answered what and when (or the new status), and says the answer was not applied and where the item is now | "a refused stale answer says what the project now records" |
| S2 | A paused project's task detail still said the queue admits automatically | Approve and Queue help say nothing is admitted now and why: paused, commissioning, or a recovery hold (`admissionHeld`) | "Tasks counts … does not promise automatic admission" |
| S3 | `policy.maxFlows` accepted 999999 | Declined; see below | — |
| S4 | 403 errors from polling after a console restart | After a 403 ("console session expired; reload the page") the refresh timer stops until reload; Refresh still tries once | Not unit-tested: `ui.mjs` |

### Declined, with reasons

- **C1, D3.** Already fixed on `main` by R4 and R2.
- **S3 (no upper bound on `policy.maxFlows`).** Declined by the operator for now. A bound is a policy decision, and adding one to `validateConfig` would make an existing configuration that sets a higher value fail validation when it loads.
- **P2, for timeline bars and event markers.** They are data marks on a time axis, and widening them to 44 px would misstate durations. The same flows and events are reachable from targets that do meet the size: the Active list, the flow links on Overview and the timeline table.
- **B5 (the local-task form is taller than the viewport).** The dialog scrolls, and the fields are all needed.

## Merge with external PR adoption (R5)

`main` (with R5 at `8286229`) was merged into this branch. Only `engine.mjs` conflicted, in its import block; both sides' imports are kept. `settle` merged without a conflict: R5's `adoptionHold` term stays in `passed`, and the outcome statement follows the status assignment as before. `dispatch.mjs` and the protection code are unchanged from `main`.

The merge card now shows R5's merge-question data alongside `mergeContext`:
- The question's `context` text (the adopted PR's status and the commits not included) is shown above the Candidate section, unchanged.
- `mergeContext.adoptedFrom` names the adopted PR. When the flow has published its own pull request, that row reads "#n (replaces adopted #m)", and `pullRequest.adopted` is true only before a publication exists.
- An **Original pull request** row shows the question's `originalPR` observation: unchanged since adoption, changed after adoption (new head, rewritten history), or could not be checked, each with the time checked.
- A **Not delivered** row lists the commits pushed to the original after adoption, or says they could not be listed.
- A note says that an adopted PR's merge question is answered by the operator only. R5's enforcement is in the `answer` command and is unchanged.

Test: "defect 4 with R5" opens a real adopted merge question whose original moved, and checks the snapshot and the card.

The operator confirmed that refreshing the idle-capacity notice's reasons under the same version is intended. Checklist Pass C runs during the release re-test on the trial project, under that trial's authorization.

## Review fixes

An independent review of `0deb50b` approved the change with two blocking fixes and two non-blocking ones. All four are done.

1. **Blocking: History still showed a failed check as passed.** The History row was red, but the Failed filter used lifecycle `status`, and the record detail showed green "passed" and "Exit code 0".
   - `attemptStatus` now lives in `ui/records.mjs` (`ui/timeline.mjs` re-exports it). It is used for History → Attempts' status filter (`HISTORY_KINDS.attempt.status`, now exported), the row's Status column, the execution timeline and its table, and the attempt panel.
   - A shared `attemptResultRows` gives the History record detail and the attempt panel the same rows:
     - **Outcome**: "failed — the step ran to completion and reported a failure (route fail)".
     - **Lifecycle**: "settled cleanly (status passed); the flow followed the step's fail route".
     - **Failed checks**.
     - **Process exit**: "code 0 (the step runner process, not the outcome)". It replaces the old "Exit code" and "Signal" rows.
   - The remaining reads of attempt `status` in the console ask lifecycle questions and stay: uncertain, not dispatched, and still running for Resume.
   - Test: "review 1".

2. **Blocking: merge links were not validated.** `mergeContext.pullRequest.url` and `originalPR.url` became clickable hrefs, including the generated `/files` link.
   - `ui/dom.mjs` gains link builders. `forgeBase` validates the configured repository's slug and host. `forgePull`, `forgeCommit` and `forgeCompare` build links from that base and a validated number or SHA.
   - `forgeUrl` accepts a recorded URL only if it is `https:`, has no credentials, is on the configured host, and its path equals the repository path or sits under it (case-insensitive; `fictional/demo-evil` does not match `fictional/demo`).
   - `safeUrl` accepts `https:` (and listed schemes) without credentials. `externalLink` renders the label as text when there is no valid URL.
   - Every href built from record data now goes through them:
     - **Merge card.** The pull request and original pull request links are built from the number, falling back to a validated recorded URL. The commit link is built from the SHA. The diff link is the validated pull request's `/files`, otherwise a compare link built from the base and candidate SHAs.
     - **Strict-review candidate links.** These existed before this change and are now built the same way.
     - **Flow summary "Pull request".**
     - **Standalone inbox `links`.** Only `https:` and `t3-thread:` without credentials are linked; anything else is shown as text, marked "not linked". The project service already refused other schemes at publish, but allowed `http:`.
     - **A task's source issue link.** Must be `https:` without credentials.
   - Hrefs built from the console's own routes (`href`, `detailHref`) are unchanged.
   - Tests: the three "review 2" tests cover `javascript:`, `http:`, a foreign host, credentials, another repository, and no configured repository.

3. **Non-blocking: corrected fast-check failures in the completion summary.**
   - Decision: a check failure the builder corrected before the flow completed is not "needs attention". `flowNeedsAttention` keeps counting lifecycle status only, and a comment now says so.
   - Such failures now appear in the completion notice: "Corrected on the way: fast-check reported a failure 2 times (verify-step). Each time the flow went back to the builder and the step later passed; nothing is outstanding from it." This comes from `recoveredFailures` in `core/project.mjs`, which reads the recorded outcome or, for older attempts, the receipt. It applies to completed non-maintenance flows.
   - The notice id is unchanged, so an existing notice is not duplicated.
   - The statement in "What counts passed" that notifications do not read attempt status is corrected above.
   - Test: "review 3".

4. **Non-blocking: touch targets.** The narrow-or-touch rule now also covers `.subtabs a` (History collection tabs), `.section-nav a` (Settings sections), `.card-links a`, `.chooser-item`, and `summary` elements, which get a 44 px minimum height in addition to their padding. The P2 row above lists them.

Fail-before for the review fixes: the test file was run against `0deb50b` extracted with `git archive`. All five review tests fail there, along with the defect 1 view test, whose expected wording changed. 24 tests pass. Four of the six fail on rendered text or records. The first "review 2" test fails because `forgeUrl` is new, and "review 1" fails on the record detail before it reaches the new `HISTORY_KINDS` export.

## Compatibility

- **Records.** Attempts gain an optional `outcome` and `failedChecks`. Answered flow questions gain an optional `onBehalfOf`. The idle-capacity notice gains `title` and, on refresh, `reasonsUpdatedAt`. No migration is needed: older records are projected (attempt outcome) or shown with fallbacks (notes from `flow.answerNotes`; a title-less notice is headed by its first sentence).
- **Service views.**
  - `publicAttempt` adds `outcome`, `failedChecks`, `route` and `operation`.
  - The flow detail read adds `checks` to each attempt.
  - The dashboard snapshot adds `mergeContext` to an open merge question.

  All are additive. The SQL projections are unchanged, and there are no new SQL JSON reads over `records.data`.
- **Console backend.** A project service's 400, 404 or 409 on a read is passed through instead of becoming 500.
- **Untouched.** Protection code in `dispatch.mjs` and `verified-git.mjs` is unchanged. `engine.mjs` gains one import and one statement in `settle`, after the status assignment. The external-PR branch (R5) edits `settle`'s `passed` line nearby, so expect a small textual merge there.

## Verification

- **New and changed tests.**
  - `tests/console-browser-defects.test.mjs`: 24 tests, with `tests/fake-dom.mjs`, a small shared fake DOM.
  - `tests/fast-checks.test.mjs`: 1 new test.
- **Fail-before.** The base tree was extracted from `HEAD` (`5b6ed15`) with `git archive` into a scratch directory. The new test files were copied in and run there with `node tests/run.mjs tests/console-browser-defects.test.mjs tests/fast-checks.test.mjs`. Result: 37 tests, 12 passed, 25 failed. The 25 failures are exactly the new tests; the 12 passes are the existing fast-check tests.
  - 18 fail on behaviour, through an assertion about rendered text, classes, links or records.
  - 6 fail on the base because the helper they exercise is new: `itemHeading`, `clusterMarkers`, `copyButton`, `staleAnswer`, `resumeBlockers` and `unitFor`.
  - 1 fails because the snapshot item has no `mergeContext`.
- **Full suite.** `npm test` on this checkout (Linux, Node 24): 982 tests, 982 passed, 0 failed, 0 skipped, before the merge (the base had 957). After merging `main` with R5: 1008 tests, 1008 passed, 0 failed, including the 26 tests of this change. After the review fixes: 1013 tests, 1013 passed, 0 failed, 0 skipped; `npm run eval` exit 0, `"passed": true`; `git diff --check` clean.
- **Eval.** `npm run eval`: exit 0, `"passed": true`.
- **Whitespace.** `git diff --check`: clean.
- **Not verified here.** No real browser was driven for this change. The checks that only a browser can make are in the new checklist. Untested by unit tests: the failed-refresh message, polling after session expiry, the active-tab scroll, focus return and the New task dialog close, all in `ui.mjs`, plus the CSS changes.

## Re-check fix (root)

Re-check (GPT-6.1 Sol) of `19ddfd1`: approve with fixes; both blocking findings resolved (attempt outcomes everywhere; link validation held against encoded schemes, protocol-relative URLs, userinfo, sibling repositories, IDN and case variants, traversal, backslashes, `data:`, `blob:` and `t3-thread:` payloads). One non-blocking item, fixed by root: the "Pull request changes" links appended `/files` to the whole recorded URL, so a URL with a query or fragment led to the pull request itself. `pullRequestFiles` now adds `/files` to the path and drops the query and fragment, for the merge card and the strict-review candidate links. Test: "pull request changes links drop the query and fragment of a recorded URL" fails with the source change removed and passes with it.
