# dev.83: console defects from the dev.82 real-browser pass, and the refused adoption of managed files

Implementation on branch `t3/fix-console-browser-defects`, from `main` at `53e432e` (dev.83 planning merged). This is not a release. Findings are numbered as in the dev.82 re-test: G23 h, i, j and the cosmetic k come from Pass C (operations through the page), G15 a to e from the read-only passes, and G25 from the external pull request trial. The repository stays project-neutral: tests and documents use fictional projects only.

Tests: `tests/console-dev83.test.mjs` (17 tests after the review fixes). Existing assertions changed in `tests/console-browser-defects.test.mjs` (the review line now lists every severity), `tests/delivery.test.mjs` (adoption creates no to-do) and `tests/external-pr-adoption.test.mjs` (publication creates it). The sections below describe the change as first built; "Review fixes" at the end records what the review changed.

## G23 h: a stale approval could not be renewed from the page

**Problem.** A queued task approved before its selected workflow changed (or before that workflow's digest changed) showed "Approved revision" and the reason "approval does not cover selected workflow …; approve the task again". The page offered only "Revoke approval". Running `task.approve` with the same revision from the CLI cleared it.

**Fix.**
- `core/catalog.mjs`: `workflowAdmission` also returns `staleApproval`, the reason text, when the current revision's approval does not cover the selected workflow. The condition and the reason are unchanged.
- `console/ui/admission.mjs` (new): `staleApproval(task)` and `reapproveButton(project, task)`. The button "Approve again" sends `task.approve` with `{taskId, revision}`, the same command and revision precondition as the CLI. Its confirmation is bound to the subject version `<revision>:<approvalVersion>`, so a confirmation opened before someone else re-approved is not reused.
- It appears in the task detail (the Tasks tab and the shared task modal), beside Revoke approval, and in Queue → Admission readiness. The status chip reads "Approved for another workflow". The Tasks list badges the row "Approve again: workflow changed". The approval notice explains that nothing starts the task until it is approved again.
- The state needs `workflowSelection`, which the task detail read and the paginated task collection carry. The compact snapshot does not, so the snapshot's own task rows never show the button.

**Test.** "G23 h": the task detail shows the state and the button. Clicking it and confirming sends `task.approve` with `{taskId: 'task-1', revision: 'r2'}`. Queue offers the button and the Tasks list shows the badge. A current approval offers no renewal.

## G23 i: Receipts said "completed" while doctor was still running

**Problem.** The receipt of `doctor.request` is canonically `completed` once the request is recorded. R6 added "Request accepted · Doctor running" under it, but the receipt's badge still read a green "completed". `job.enqueue` had the same gap, with nothing following the job at all: Queue → Dispatch now, the task source Refresh, Make it a task, and Create in the task source all toasted "completed" and were badged "completed" while the job was still queued.

**Fix.**
- `console/ui/receipts.mjs`: `requestFollowUp(receipt, project)` describes the requested work.
  - For `doctor.request` it reads the run from `settings.doctorRequest`, as R6 did.
  - For `job.enqueue` it reads the job by its ID. The read is cached per binding and repeated when the project's revision changes.
  - The receipt's badge shows that state: "Doctor queued", "Doctor running", "Doctor passed" or "Doctor failed", and for a job "queue.dispatch queued", "running", "finished" or "failed". A finished job also says what it did ("started a queued task", "found no task it could start"), and a failed one gives its reason.
  - The card's colour is info while the work is pending and good or bad once it ends. The canonical status stays in the raw receipt, and the Receipts filter still counts by canonical status.
- `console/ui/actions.mjs`: a completed `job.enqueue` toasts "request accepted; the job is queued, and Receipts follows it to its outcome" unless the form gives its own wording.
- `service/project-service.mjs`: `GET /v1/jobs/:id` returns one job's lifecycle fields: id, operation, status, outcome, reason, flow, dispatched flow and times. It never returns the payload or the grant. It is a primary-key read. `console/console.mjs` allows the `jobs` read kind and checks the job's identity. The route is listed in `contracts/README.md`.
- Other request-style commands were checked:
  - `recurring.run` creates its task in the same command, so "completed" is accurate.
  - `task.approve` with `queue: true` approves and queues in the command. Admission is reported on the task, not as a request.

**Tests.** "G23 i: a doctor or job request receipt …" renders running work and then finished work. While the work runs, no header says "completed" and no card is drawn as a success. "G23 i: the project service reads one job by ID …" checks the route on a real service.

## G23 j: a paused project's queued task still promised automatic admission

**Problem.** With admission paused, Queue and Settings said so. The queued task's detail still said "Automatic admission will start queued work when policy and capacity allow." and gave only "project held" as the reason.

**Fix.**
- `console/ui/plan.mjs`: `approvalState` no longer promises admission while anything holds the queue. `queueHolds(snapshot, task)` takes the holds from the project's queue status: pause, recovery, retention, spending, doctor, target health, target sync, merge in flight and stalled launch. An older service without queue status falls back to the snapshot's pause, recovery and commissioning flags.
- Holds scoped to change work are left out for a task-kind workflow, and so are holds for another target.
- The detail now reads "Nothing is admitted while the queue is held: Admission is paused. Resume it from Overview. Automatic admission resumes once the hold clears." When only the task's own reasons hold it, the detail says it will start once they clear.
- "project held" is now structured (G15 a). It is shown as "Admission is held: admission is paused (resume it from Overview)", or as the recovery or retention hold.

**Test.** "G23 j": a pause, a spending hold and an older snapshot's pause flag never produce the promise. A change-scoped hold does not hold a task-kind workflow. An open queue still promises admission.

## G15 a: raw UTC strings in admission reasons

**Problem.** Queue → Admission readiness joined the raw reason strings, for example "scheduled: not before 2026-11-18T12:48:25Z; …; paths overlap: 994fa8a0-…". Scheduled showed the same time as "Nov 18, 2026, 07:48 EST".

**Decision.** The reasons are prose built in core. They are not parsed in the browser. Core adds structured fields beside them, and the reason strings and every decision made from them are unchanged.

**Fix.**
- `operations/admission.mjs`: `admissionReasons(store, task, {facts})` takes an optional `Map` and fills it with fields for each reason text:
  - `not-before` with `at`;
  - `held` with which holds (paused, recovery, retention);
  - `approval-stale` with the workflow;
  - `commissioning`;
  - `paths-overlap` with `flowId`;
  - `stopped-flow` with `flowId`;
  - `capacity` with the stopped flows that hold slots.

  Each reason also gets `times`, the exact recorded ISO strings it embeds. They are taken from records (the task's not-before, the target's health check times, the scheduled tier's check time, provider-hold expiries), not found by searching the text. That covers the main-health and provider-limit reasons, whose text stays prose. The body moved into an inner function unchanged except for these annotations. Without `facts` the function returns exactly what it did before.
- `core/project.mjs`: `taskView` adds `admissionHolds`, the reasons with their fields.
- `console/ui/admission.mjs`: `holdList` renders each hold.
  - Times become `<time>` elements in the viewer's zone, with the recorded UTC value in the tooltip.
  - Flows are named by title and linked.
  - Holds are listed one per line.

  The task detail's "Not started yet", Queue's "Not admitted yet", the Start hints and the queue editor's observed reasons use it, the editor through an exact text match with the task's current holds. A project service without `admissionHolds` still shows its plain reasons.
- Not structured, and left as recorded text: the last dispatch's `heldReasons` in the Queue banner, and other observation strings recorded before this change.

**Tests.**
- "G15 a: admission holds carry structured fields …" works on a real store with a not-before time and a pause, and checks that the reasons are unchanged without `facts`.
- "G15 a: Queue and task detail show hold times …" checks that no raw ISO time is in the rendered text (outside the collapsed raw record), that `<time>` tooltips carry the UTC value, and that the overlapping flow is named.

## G15 b: Stats overflowed at 390 px

**Problem.** Stats "By week, last 12 weeks" measured `scrollWidth` 427 at a 390 px viewport. The 7-day and 30-day windows fit. Cause: chart labels are flex items, and a flex item's minimum width is its text. Twelve "MM-DD" labels of about 36 px each forced the label row, and the page, wider than the chart. The 30-day window thinned its labels, and the 7-day window had few.

**Fix.**
- `.mlabels span { min-width: 0; }`. The first label is left-aligned and the last right-aligned, and the label row clips at the chart's edges.
- `chartLabelShown(count, i)` in `ui/stats.mjs` labels every bar up to seven bars. Beyond that it labels at most seven, evenly spaced from the first, so 12 weeks show 6 labels and 30 days show 6.

**Test.** "G15 b" checks the CSS rule and the label thinning. The page width itself is a browser check (A-08, D-03).

## G15 c: Timeline markers overprinted on phones

**Problem.** R6 clustered a flow's execution-timeline markers closer than 1% of the track. At phone width 1% is about 3 px, and a marker is 10 to 40 px wide. The Timeline tab's event track (merges, failures, stops, questions, upgrades) did not cluster at all.

**Fix.**
- `markerGap(markerPx, {viewport, reserved, zoom})` in `ui/timeline.mjs` gives the share of the track a marker covers at the current viewport width.
- The Timeline tab's event track clusters events closer than a 40 px marker, which has a glyph and a short reference. A cluster is drawn as one marker showing the count. Since the review fixes it is a disclosure listing each event (see Review fixes).
- The execution timeline uses the larger of its old 1% threshold and a 14 px marker.

**Test.** "G15 c" renders the Timeline tab at 390 px with two merges an hour apart in a 12-hour window: one marker with the count "2" and both events in the tooltip. At 1440 px they stay two markers.

## G15 d: text smaller than 12 px

**Problem.** Measured at phone width: count badges 11.1 px; "Observed …" and table headings 11.7 px.

**Fix.**
- Every `font-size` below 0.8 rem (12 px at the 15 px root) is now `max(12px, …)`. That is 21 rules, among them `.count`, `.badge`, `.chip-icon`, `table.data thead th`, `.topbar-status` at phone width, the timeline axis and bars, and the Stats labels.
- `.small` is `max(12px, .86em)`, because it nests inside other small text.
- Desktop text that was already 12 px or more is unchanged.

**Test.** "G15 d" parses `style.css`: no `rem`, `em` or `px` font size computes below 12 px at the 15 px root unless it is written as `max(12px, …)`, and the measured selectors use it.

**Compact density.** As first built, the compact preference (14 px root) still put 0.8 to 0.85 rem text at 11.2 to 11.9 px. Fixed in the review fixes.

## G15 e: provider logs offered for attempts that made no model call

**Problem.** R6 hid provider logs for attempts whose `operation` was not `provider.*`. A fast-check attempt has no recorded action operation, so all seven files were still offered, and selecting a provider file returned HTTP 404.

**Fix.**
- `service/project-service.mjs`:
  - The flow detail read lists each attempt's existing evidence files (`artifacts`), from the attempt's private directory. That is at most eight existence checks per attempt, on flow detail only.
  - `/v1/artifacts/:attempt?name=` for a file the attempt never wrote returns 200 with `{text: '', truncated: false, available: false}`.
  - An unknown attempt or an unsupported name is still refused.
- `console/console.mjs` passes `available` through and validates it.
- `ui/timeline.mjs`:
  - `artifactNames` offers exactly the listed files. Without a list (an older service) it falls back to the operation rule.
  - An attempt with no files says so.
  - An unavailable file reads "… was not written for this attempt."

**Test.** "G15 e" settles a real non-model attempt and checks three things on a real service: the flow read lists `stdout.log` and no `provider/` file, a missing provider file is the empty state, and an existing file reads as before. It also checks that the console offers exactly the listed files.

## Cosmetic k: "pass 0 findings" had no counts by severity

**Fix.** The merge card lists every review-schema severity, zero included, then any other severity recorded: "pass 0 findings (0 critical, 0 high, 0 medium, 0 low) · full review".

**Test.** "the merge card counts review findings by severity, zero included". The R6 assertion "pass 1 finding (1 low)" now expects "(0 critical, 0 high, 0 medium, 1 low)".

## G25: an outside PR that edits managed files fails with a generic notice, and its author is not told

**Problem.** An adopted pull request changed `docs/FAQ.md` and one sentence of `factory/AGENTS.md`. `integrate` refused it correctly: "factory changes need explicit installation policy (…; changed: factory)". The flow notice said only "Change workflow failed; inspect retained attempt evidence". It did not name the file or the rule, and the PR got no comment.

**Fix.** The protection is unchanged: the refusal is still decided by `refuseOwnedChanges` over verified objects.
- `workflows/dispatch.mjs`, `workspace.integrate`: for an adopted candidate only, a refusal goes through `adoptedManagedFilesRefusal`.
  - It names the managed files with a display-only `git diff --name-only` of the owned paths between the integrated target and the candidate. (The review fixes changed how the list is bounded.)
  - If `repository.adoptionNotice` is not false, it posts one comment on the original PR. This is the adoption notice's mechanism: `forge.publishComment` with an operation id per adopted head (`…:managed-files:<head>`), so a retry does not post twice.
  - It throws an error that carries an operator `notice` and keeps the original refusal in its message after "Refusal:".
- `workflows/adoption.mjs`, `managedFilesComment`: fixed neutral text. It says the PR changes files the project's software factory manages itself, lists them, and asks the author to drop those changes. File names go through `markdownText`, the replacement-body escaping, which breaks `@` mentions and escapes `#`. The body is checked with `closingReference`, the merge step's closing-keyword rule, and refused if it would contain one.
- `managedFilesNotice` names the PR, the files and the rule: the factory's upgrade-owned files change only through a Factotum release, never through delivered work, and `policy.allowFactoryEdits` permits it except for the lock. It says nothing was published or reviewed, and gives the remedy: ask the author to drop the changes and push, then adopt the pull request again with the new head. It also says whether the author was told, the comment failed, or comments are off.
- The action worker records an error's `notice` (bounded) and `managedFiles` in `action-result.json`. `core/engine.mjs` `failedChangeReason`: a failed change flow's notice is "Change workflow failed at <step>: <notice>" when the latest failed attempt's action gave a notice, and the old generic text otherwise. Any action can opt in the same way. No other action sets `notice` yet.

**Tests.**
- "G25: an adopted PR changing managed files …" runs `workspace.integrate` on a real repository with a fake `gh`. The refusal holds. The notice names `factory/AGENTS.md`, not `docs/FAQ.md`, with the rule, the remedy and "The pull request author was told". The original refusal is kept. Exactly one comment is posted, with no mention or closing keyword, and it carries the publication marker.
- "G25: with repository.adoptionNotice false …" checks that nothing is posted and the notice says to tell the author.
- "G25: a failed change flow's notice …" covers `failedChangeReason` with and without a notice.

**Not done here (follow-ups).**
- The leftover `original-pr` to-do after a refused adoption was listed here; it is fixed in the review fixes.
- The worker-to-notice path was tested in parts (the action's error, `failedChangeReason` on a stored attempt), not through a full engine run of an adopted flow.

## Fail-before evidence

The base tree (`53e432e`) was copied to a scratch directory, without its `.git`. `tests/console-dev83.test.mjs` was copied in and run there with `node tests/run.mjs tests/console-dev83.test.mjs`. Result: 14 tests, 0 passed, 14 failed. Each fails on behaviour:
- 12 fail on an assertion about rendered text, records, CSS or a service result.
- The job read fails with the service's "unknown operation", because the route did not exist.
- "G25 … failed change flow's notice" fails because the base has no `failedChangeReason` and the notice is the generic text.

The same file passes 14 of 14 on this branch.

## Compatibility

- **Records.** Unchanged. Task views gain `admissionHolds`. Workflow selection gains `staleApproval` only when it applies. Flow-detail attempts gain `artifacts`. A failed attempt's `action-result.json` may carry `notice` and `managedFiles`.
- **Service.**
  - New `GET /v1/jobs/:id`.
  - `/v1/artifacts` answers a missing file with 200 and `available: false` instead of 404. An unknown attempt is still an error.
  - No SQL JSON reads over `records.data` and no full scans were added. The job read is a primary-key `store.get`. The artifact list is file-existence checks on flow detail only.
- **Console.** A new static module, `ui/admission.mjs`, is added to the asset allowlist.
- **Merging.** The Queue tab edits are three lines in `ui/queue.mjs`: an import, the approval row with the button, and the hold list. The queue editor change in `ui/plan.mjs` is one expression. Expect small textual merges with the admission builder's queue-status and Queue-tab work.

## Browser checklist

`docs/qualification/console-browser.md` gains these checks:
- A-03: no overlapping markers at phone width; a group shows a count and opens a list by tap, click or keyboard.
- A-05: local times with UTC tooltips, flows named, Approve again.
- A-08: no sideways scroll on the 12-week Stats at phone width.
- B-02: no provider files for non-model attempts, and no 4xx for a missing file.
- C-01: badges follow doctor runs and job requests.
- C-02: Approve again.
- C-05: every severity counted.
- C-08: the queued task says nothing is admitted while the queue is held.
- D-05: the specific elements to measure, once more in compact density.

The CSS changes (G15 b, c, d) and the focus and layout behaviour are verified only by these browser checks and by the CSS-rule tests above. No real browser was driven for this change.

## Verification

- `npm test`: 1079 tests, 1079 passed, 0 failed, 0 skipped (the base has 1065; the 14 new tests make the difference). The base copy used for fail-before has no `.git`, so it skipped three tests that need the earlier runtimes from git history; this branch runs them, and they pass.
- `npm run eval`: exit 0, `"passed": true`.
- `git diff --check`: clean.

## Review fixes

An independent review (GPT-6.1 Sol) of `e9fe201` approved it with fixes. It found no authority bypass, traversal or cross-site scripting problem, and it confirmed four points: "Approve again" sends exactly what the CLI sends and a stale revision is refused; the job read keeps payload and grant out; the artifact allowlists still apply; and the comment escaping held, with one comment posted. One finding blocked; the rest follow the reviewer's and the operator's decisions.

### 1. Blocking: a long file list pushed the G25 guidance out of the notice

**Problem.** `managedFilesNotice` put the whole file list before the rule, the remedy and the comment outcome, and the worker keeps at most 2,000 characters of a notice. Twenty valid paths of about 190 characters produced a 4,382-character notice. Its kept prefix had no rule, no remedy and no publication outcome.

**Fix.**
- `workflows/adoption.mjs`: the notice now reads, in order:
  - the refusal;
  - `Rule:` with the owned paths;
  - "Nothing was published or reviewed";
  - the remedy;
  - whether the author was told;
  - and last `Files:`.
- The file list has its own budget (`MANAGED_FILES_BUDGET`, 600 characters), filled by `managedFileList`. It takes whole names while they fit (the first one shortened if it alone is too long) and ends with "… and N more", which counts every changed file that is not named.
- The comment uses the same order: what to do first, then "The files:" with the same budget, ending with "- … and N more".
- `dispatch.mjs` considers up to 200 names for the notice and the comment. It stores 20 names in `managedFiles` in the action result, each cut to 300 characters, with the count of the rest.
- With the worst-case owned paths and failure text, the notice stays under the 2,000-character limit that the worker keeps.

**Test.** "G25: a long list of managed files …" uses the reviewer's repro on a real repository: twenty 190-character managed files plus `factory/AGENTS.md`. The notice is at most 2,000 characters. It contains the rule, the remedy and the comment outcome before `Files:`. It ends with "… and N more", and the named files plus N equal 21. In the comment, the guidance comes before the list, the list ends with a count, and there is still no mention or closing keyword. The first G25 test now expects the new order.

### 2. Text below 12 px that the CSS test missed

**Problem.** The CSS test read only `font-size` declarations, at a fixed 15 px root. It ignored the `font` shorthand (`code, pre, .code` at `.85rem`) and the compact density's 14 px root. At that root `.chip` was 11.2 px, and `.card-sub` and code were 11.9 px.

**Fix.**
- Compact density keeps its 14 px root, so spacing and body text still tighten. Every size that falls below 12 px at that root (0.8 to 0.85 rem: 20 more `font-size` rules and the code shorthand) is now `max(12px, …)`. That includes the code shorthand: `font: max(12px, .85rem)/1.5 …`.
- Nothing changes at the default density, where those sizes were already 12 px or more.

**Test.** "G15 d … in either density" reads both root sizes from the stylesheet: the default from `:root`'s `font` shorthand, and compact from its own rule. It collects every `font-size` and the size in every `font` shorthand. It requires each to compute to at least 12 px at both roots, unless it is written `max(12px, …)`; an `em` size below 1 must always be written that way. It also checks the measured selectors, now including `.chip` and `.card-sub`.

### 3. Decision: the superseded-PR to-do

**Decision (operator, following the reviewer).** The to-do is not created when an adoption is refused before a replacement is published. It is created only when a replacement pull request is published. If it already exists, it is retired on refusal, and the original PR stays open.

**Fix.**
- `workspace.adopt` no longer returns the `original-pr` obligation.
- `forge.publish` returns it, for an adopted candidate, together with the replacement. Its evidence is the original PR's URL.
- The post-merge record (`originalPRObligation`) is unchanged.
- `core/engine.mjs`, `retireUnpublishedAdoption`: when a change flow with an adopted candidate fails before its replacement was published, an open `<flow>:original-pr` to-do is closed. A flow that an earlier release adopted is the only case that has one. It is marked resolved with "Retired: the adoption was refused before a replacement pull request was published … It stays open; nothing needs closing.", and an `obligation.retired` event is recorded. A flow that did publish keeps its to-do.

**Tests.**
- `tests/delivery.test.mjs` now expects no obligation from `workspace.adopt`.
- `tests/external-pr-adoption.test.mjs` expects the pending `flow-1:original-pr` obligation from a publication.
- "G25: a refused adoption retires an original-pr to-do …" retires an unpublished flow's to-do and leaves a published one's pending.

### 4. Decision: one failure-notice path (the G6 overlap)

**Decision.** The action-supplied `notice` is the single path for a failed change flow's notice. When the PR and adoption branch merges, its candidate-mismatch notices should set `error.notice` in the action and flow through it.

**Fix.** None was needed. The worker records any thrown error's `notice` in `action-result.json`. `failedChangeReason` uses the latest failed attempt's notice for any action.

**Test.** "the failed-flow notice uses any action's notice …" uses a fictional candidate-step notice. It passes on `e9fe201` too, so it confirms the behaviour rather than fixing it.

### 5. Decision: an accessible list for grouped timeline markers

**Problem.** A group of close markers was a counted marker whose events were only in its tooltip, which keyboard and touch cannot open. On the Timeline tab the grouped events also lost their links.

**Fix.**
- `ui/timeline.mjs`, `markerGroup(items, {cls, pct})`: a group is a `<details>` disclosure.
  - Its summary shows the count and is labelled "N events close together; show them".
  - Its list names each event with its time. On the Timeline tab each event links to its flow.
  - The tooltip repeats the list.
- The Timeline tab's event track and a flow's execution timeline both use it.
- The list opens toward the middle of the track: right-anchored past 67%, centred between 33% and 67%. It is at most 60% of the viewport wide, so an open list stays on screen at phone width.
- On narrow or touch screens the summary and each list row are at least 44 px tall.

**Test.** "G15 c" (extended): at 390 px, two merges an hour apart in a 12-hour window form one disclosure. Its summary reads "2" with the group label, its list names both events, and each event links to its flow. At 1440 px they stay separate. `markerGroup` opens left, centre or right by position. Opening it in a browser and the on-screen position of the open list are checklist items (A-03).

### Fail-before for the review fixes

`e9fe201` was extracted with `git archive` into a scratch directory, and the changed test files were copied in. `node tests/run.mjs tests/console-dev83.test.mjs tests/delivery.test.mjs tests/external-pr-adoption.test.mjs` gave 61 tests: 54 passed, 7 failed. The 7 failures, each on an assertion:
- the grouped marker is not a disclosure;
- the compact-density sizes;
- the G25 notice order;
- the long-list notice, at 4,394 characters;
- the to-do retirement;
- adoption creating the to-do;
- publication not creating it.

The failed-notice confirmation test passes there, as stated in item 4.

### Verification after the review fixes

- `npm test`: 1082 tests, 1082 passed, 0 failed, 0 skipped.
- `npm run eval`: exit 0, `"passed": true`.
- `git diff --check`: clean.
