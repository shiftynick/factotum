# dev.89: the dev.88 readiness re-test findings M1–M9

Nine findings from the dev.88 readiness re-test, and two possible defects the factory's own audit raised in the installed `triage.mjs`:

- M1 (defect): the upgrade's recommission erased the record of live setting changes, so the next `config update` from the operator's file silently reverted them.
- M2 (docs): the dev.88 release notes said the finding commands must be listed in `policy.delegatedOperations`; with no list they are delegated by default.
- M3 (friction): after a replan that only fixed the plan, the unchanged candidate could not be reviewed again, and the stop text did not name `flow.note`.
- M4 (friction, triage proxy): a state reset told only the orchestrator and lost the proxy's identity; a failure before the script ran told nobody.
- M5 (console): a click on blank space inside the flow window closed it.
- M6 (friction): a hand-queued `knowledge.upkeep` job waited while admission was paused, and the docs mentioned only `holdMaintenance`.
- M7 (friction, triage proxy): the "After binding" wake re-sent nothing within the two-minute spacing.
- M8 (cosmetic): a resumed flow kept its old stop reason, and proxy forwards quoted it.
- M9 (cosmetic, console): Health's finding detail showed raw ISO times, and the finding forms had no confirmation.
- The audit's two findings in `triage.mjs`, at lines 1303 and 1111 of the dev.88 file.

This is a local implementation record, not a release, activation or live qualification claim. No provider, forge or T3 tool was called by the tests.

**What changed.**
- Core:
  - `core/project.mjs`: `config.update` takes `current: true`, and reports changed live settings (M1); `replanFlow` records the plan a review verdict was given against (M3); `resume` drops the stop reason (M8).
  - `operations/live-settings.mjs`: `changedLiveSettings` (M1).
  - `core/engine.mjs`: the unchanged-candidate hold and its stop text (M3).
  - `operations/state-view.mjs`: the stop reason only for a stopped flow (M8).
  - `cli.mjs`: `config update --current` and its messages (M1).
  - `core/command-help.mjs`: `config.update` and `pause` (M1, M6).
- The console:
  - `ui.mjs` and `ui/dom.mjs`: `backdropClick` (M5).
  - `ui/records.mjs`: finding detail rows, time elements in generic rows, and the live-settings event labels (M9, M1).
  - `ui/operations.mjs`: confirmations, and time elements in the finding cards (M9).
- The project-owned proxy files: `starter/project/integrations/triage.example.mjs`, `t3-triage.example.md` and `t3-notifications.example.md`. The protocol is now 89.
- Docs:
  - `docs/operations.md`: "Live settings after an upgrade", "Paused admission", and the finding delegation sentence.
  - `docs/commands.md`: `--current` and `changedLiveDetails`.
  - `docs/integrations/t3.md`: protocol 89, the reset notice, a failure before the script runs, the rebind re-send, the stale read, and the no-thread outage.
  - `docs/release-notes.md`: the dev.88 entry's finding commands (M2).
  - `docs/designs/knowledge-upkeep.md`: one clarifying sentence on the default (M2).
- Tests: the new `tests/dev89-m-items.test.mjs` and `tests/dev89-console.test.mjs`, new tests at the end of `tests/triage-proxy.test.mjs`, and that file's protocol moved to 89.

No workflow graph changed, so no workflow digest changes and no task needs approving again. No schema changes. Adopters using the triage proxy must copy the script and both guides again (see "Action needed").

## M1: live setting changes survive the upgrade's recommission

### Cause

`upgrade apply` recommissions with `config update --current`. The CLI read the stored configuration and passed it as the file. `keepLiveValues` skips every key whose stored value equals the file's value. With `--current` that is every key, so it returned no live changes, and `config.update` wrote `liveSettingChanges = {}`. The values stayed in force, but nothing recorded them as live changes any more. The next `config update` from the operator's file therefore applied the file's value for each of them, with `keptLiveSettings: []` and no message. The defect has been there since dev.82, when the provenance record was introduced.

### Fix

- **`current`.** `config update --current` now sends `config.update {current: true}`, with no configuration. The command re-applies the stored configuration and writes the existing provenance back unchanged. It records the preserved keys in `config.kept-live-settings` too, so a project whose meta record is missing rebuilds the same provenance from the event log. The result lists them in `preservedLiveSettings`. `current` refuses a `config` or `replaceLive` beside it.
- **Every change is named.** Every `config.update` compares the effective value of each live setting before and after. Each one that changed is reported in `changedLiveSettings` and `changedLiveDetails`:
  - the fields are `setting`, `from`, `to`, and `lastLiveChange` (`value`, `by`, `onBehalfOf`, `at`, from the newest `settings.updated` event that set it);
  - the change is recorded as a `config.live-settings-changed` event;
  - the CLI prints a message for each, then one line pointing at the repair guidance when any had a live change.

  The scan reads only the newest 500 `settings.updated` events, and only when a value changed. It reads the `events` table, never `records.data`.
- **History shows live changes.** The console labels "Settings updated" events with each setting, its value and who set it. It also labels the two configuration events.

Running `config update --current` (or `upgrade apply`) with an older release's CLI still has the old behaviour. The fix applies from the first recommission that the dev.89 CLI runs.

### Repair for projects that already lost settings

The full guidance is in `docs/operations.md`, "Live settings after an upgrade". In short:
1. History → Events lists every "Settings updated" event, with the values and who set them. History → Commands shows the same commands, and the upgrade backups hold the state before each upgrade.
2. `config show` gives what is in force now.
3. Compare the two:
   - A setting that now differs from its last live change was reverted: set it again with `settings.update`.
   - A setting that still equals its last live change but is not in the file is at risk. Put it in the file before the next `config update`. Setting the same value live records nothing.
   - If the update has already run, its result names the setting with its last live change.

The upgrade to dev.89 cannot rebuild a record an earlier upgrade erased. Rebuilding it from the event log would also restore live changes the operator had deliberately overridden from the file.

### Tests

`tests/dev89-m-items.test.mjs`:
- "M1: config update with current keeps every live change and its provenance…": the provenance is unchanged; a project without the meta record rebuilds it from events; a later file update keeps both values; `current` with a file or `replaceLive` is refused.
- "M1: a file update that reverts a live value names it…": the state a dev.88 recommission left (value stored, provenance `{}`). The file update names `policy.autoQueue` with its last live change, and `policy.maxFlows` with none.
- "M1: through a real upgrade apply…": adopt a release built from this checkout, change `policy.autoQueue` and `notifications.handoffAfterDeliveries` live, then upgrade to a second built release with `mergeUpgrade`. The merged release's real CLI recommissions (only systemctl and doctor are faked). The provenance survives, and the operator's next file update keeps both.

`tests/dev89-console.test.mjs`: "M1: History names live setting changes…".

## M3: re-review after a replan that changed the plan

**Problem.** `flow.replan` keeps `results.review`. When the builder then returned the same candidate, the hold compared it with that review's identity and stopped the flow. It did not consider that the verdict had been given against the old plan. The stop text said "give guidance" without naming `flow.note`, and a resume note does not reach the builder.

**Fix.**
- `replanFlow` records `reviewReplanned {reviewDigest, planDigest}`: the review it answers, and the plan that review was given against. A second replan before that review keeps the first record. The plan is compared by what it says, not how it was produced (`planContentDigest`, `core/plan-questions.mjs`; see "Review of 10cd727").
- In `core/engine.mjs` the unchanged-candidate hold does not apply when the review is that same review and the build's plan differs from the recorded one. The build passes, and the candidate goes to review again, against the new plan. A replan whose new plan is the same still holds.
- The stop text now says: "give the builder guidance with flow.note (a resume note is only the reason and does not reach the builder), then resume this build; or replan with flow.replan: when the new plan differs, the unchanged candidate is reviewed again against it." The fast-check hold's text names `flow.note` the same way.

The edit to `core/engine.mjs` is two lines in the settlement guard. `workflows/actions.mjs` was not touched.

**Tests** (`tests/dev89-m-items.test.mjs`, on the review-correction fixture with a plan step): "M3: after a replan that changed the plan…" goes to review; "M3: after a replan that left the plan as it was…" still holds, and its stop names `flow.note`.

## M4: a state reset and a failure before the script runs

All within the dev.88 trust model: the notices are published by the orchestrator role through the factory CLI, and nothing from the webhook payload is trusted. The proxy still has one destination.

1. **A reset publishes an operator notice.** `loadMemory` records every reset (`stateResets`).
   - Every command that loads the state file can reset it: a run, `--sent`, `--send-failed`, `--escalate`, `--escalated`, `--judged-absorb` or `--set-proxy-id`. When one does, it publishes one notice per reset, `triage-reset-<12 hex of the set-aside file's name>`, and names it in its output (`stateResetNotice`).
   - A command that fails after the reset publishes it before it exits.
   - The notice uses the same path, read-back and collision rule as the error notices. Without `--factory-state`, or if the publish fails, the floor applies: stderr and exit 1, with the result still printed.
   - The notice says what was lost and what to do.
   - The prefix is added to the proxy's own notices, so a delivery of it is absorbed, never the subject of another notice.
2. **The proxy's identity survives a reset.** The fresh state takes `proxyThreadId` from the log's last `proxy-id` line. The log is append-only and not touched by a reset. Forwards keep naming the proxy instead of "identity not recorded".
3. **A failure before the script runs.**
   - The brief's step 0 is now `mkdir -p -m 700 DIR && mktemp -d DIR/wake.XXXXXX`. If that fails, it falls back to `mktemp -d`, a private 0700 directory under the system temporary folder. The script then runs, and its own error path reports what is wrong with `DIR`.
   - If no wake directory can be made, the payload cannot be written, or the script cannot start, the brief has the proxy publish one operator notice directly with the factory CLI: `triage-failed-start-<UTC date and hour>`. The notice names the delivery only if its ID is a plain ID, and as an unverified claim. This is the one notice the proxy publishes itself, and "What you may and may not do" says so.

**Tests** (`tests/triage-proxy.test.mjs`):
- "M4 (dev.89): a state reset publishes one operator notice…": through the command line, a reset by a wake publishes a notice by the orchestrator role, the forward names the recovered proxy ID, and the notice's own delivery is recognized as the proxy's. A reset by `--sent` (which then fails) and by `--set-proxy-id` publishes its own notice. Without `--factory-state`, the floor.
- The existing "the command line serialises concurrent runs…" passes `--factory-state` and checks the reset's notice.
- The brief's step 0 and fallback: "M1, M4: the repair guidance and the brief's first step are written down" in `tests/dev89-m-items.test.mjs`.

## M7: a rebind re-sends at once

**Problem.** `dueResends` spaced every re-send two minutes after the forward's last attempt, even when the destination had changed. So the woken timer run 17 seconds after the rebind logged `timer-no-change`.

**Fix.** The spacing is skipped when two things hold. First, the forward's destination now (the bound session) differs from the thread its last send went to. Second, that last send is known to have failed (`lastFailedAt` is at or after the last attempt). Such forwards come first in the run's three-send budget. A forward whose last send to the old session has not failed keeps the spacing, since that send may still be in progress. The guides say so.

**Test** "M7 (dev.89)…" on the trial's timing:
- without a rebind, a run 15 seconds later sends nothing;
- after the rebind, the timer run 17 seconds later sends to the new session;
- once that send is confirmed, nothing is sent twice.

## M8: a resumed flow's stop reason

**Fix.**
- `resume` deletes `stopReason`; the reason stays in the `flow.stopped` event.
- The narrow read (`status --flow`) shows a stop reason only for a stopped flow, which also covers flows resumed before dev.89.
- The proxy's forward prints it only for a stopped flow, which also covers an older factory's read.

**Tests:** "M8: a resumed flow has no stop reason…" (`tests/dev89-m-items.test.mjs`) and "M8 (dev.89): a forward names a stop reason only for a stopped flow" (`tests/triage-proxy.test.mjs`).

## M5: a click on blank space in the flow window

**Cause.** As the re-test report inferred: the close handler tested `event.target === detailDialog`, which is also true for a click on the dialog's own padding.

**Fix.** `backdropClick(dialog, event)` (`ui/dom.mjs`) closes only for a click on the dialog element whose position is outside its bounding box. A click with no position (from the keyboard) never counts. Escape still closes the window as before.

**Test.** "M5: only a click outside the flow window closes it…" covers the trial's desktop and phone geometry: the padding, the backdrop on two sides, content, and a keyboard click. It also checks that `ui.mjs` uses the helper.

The fix is not yet checked in a real browser (see "Open questions").

## M9: finding times and confirmations

**Fix.**
- **Finding detail.** History's finding detail has its own rows: title, status, source, severity, evidence, file, times seen, task, version, and the created, status-changed and last-observed times as `<time>` elements with the recorded UTC value in their tooltip. Generic rows for any other kind render ISO strings the same way.
- **Health's finding cards.** "Seen … last", the disposition time and a new "Status changed" row are time elements too.
- **Confirmation.** Decline, Dealt with another way and Reopen ask first, with `confirm` on `commandForm` as the decision-cancel and grant-revoke forms do. The question names a task that would be closed.

All text is set with `text`/text nodes, and the confirm is the browser's own dialog. Nothing new is wider than the existing rows at 320px.

**Tests** (`tests/dev89-console.test.mjs`): "M9: a finding's detail shows its times as time elements…" (History and Health), and "M9: Decline, Dealt with another way and Reopen ask for confirmation first…". The second test covers five forms, with and without a task; a refusal sends nothing.

## M6: maintenance jobs while admission is paused

**Finding.** The code already treats every queued maintenance job alike: `operationalTick` starts no maintenance job while admission is paused, `audit` and `knowledge.upkeep` included. I checked this with a test before changing anything: an audit job queued while paused stays `queued`.

The trial's audit, which "ran to completion while the project was paused", must have started before the pause. A job already running finishes. That could not be confirmed from the re-test report, which gives only the times.

**Decision.** Keep the behaviour, the conservative one: a pause means nothing new starts, and an assessment is model work that spends the upkeep budget. Making upkeep an exception would let model calls start on a paused project.

**What changed.**
- `docs/operations.md` gains "Paused admission", just above "Drain" where `holdMaintenance` is described. It covers what waits, what finishes, that receipts are still queued and their deadlines run (a long pause can close a run as `stale-run`), and why.
- The `pause` help says that queued maintenance waits, and what `holdMaintenance` adds.

**Test.** "M6: while admission is paused (without holdMaintenance), a hand-queued knowledge.upkeep job waits exactly like an audit job…": both stay queued over two ticks, and both start (in their separate lanes) at the first tick after resuming. The test also checks the docs and the help. It passes on the base for the behaviour and fails there on the docs.

## M2: who may use the finding commands

**What the default is.** `delegatedOperations(config)` is `config.policy.delegatedOperations ?? DELEGABLE`, and `finding.accept`, `finding.resolve` and `finding.reopen` are in `DELEGABLE`. So a project with no list delegates them: the orchestrator may use them on a recorded instruction (`--instruction`). An explicit list delegates them only if it names them. A governing-context proposal or a rule stays the operator's either way. This is what the re-test saw live.

**Docs corrected.**
- The dev.88 release-notes entry, marked as corrected after release: "Who can use them", and the "Going back" step, which applies only to an explicit list that names them.
- `docs/operations.md`.
- One clarifying sentence in the knowledge-upkeep design's "Who may do what". The design says the three commands "are added to the delegable list", which in this code means delegated by default. The authority default is unchanged: the operator decided, after the first round, that the finding commands stay delegable by default (see "Review of 10cd727").

**Test.** "M2: with no policy.delegatedOperations list the finding commands are delegated, and the docs say so".

## The factory's own audit of `triage.mjs`

**Line 1303 (`dueResends` ignored the read's revision): a defect, fixed.**
- `closeSends` already refused to close a forward on a read older than the one it was decided from (the third re-check of 0933596). `dueResends` received no `readRevision` and sent the forward anyway.
- So an overlapping run holding an older read could re-send an attention forward without a read showing that its item was still open. That breaks the dev.88 rule ("a forward about an open item is re-sent only by a run that read the open items").
- The window is narrow: the forward must be over two minutes old while the older read is used. But the rule is the proxy's, so it is enforced.
- **Fix.** Such a read counts as no read for that forward: it is not sent in that run, and its escalation is still marked.
- **Test.** "audit of dev.88, line 1303…": a stale compact view sends nothing, and a current one sends it.

**Line 1111 (`endOutage` rejected the no-thread outage): a defect, fixed.**
- An outage of forwards with no destination is stored under `(no orchestrator thread)`, and `endOutage` returned at once for a key that is not a thread ID. So that outage never ended: its notice was never reported moot.
- It was worse than the audit said. The outage stayed `published`, so in a later period with no thread (after a reset, before a binding is read), `--escalate` found it and covered new forwards with a notice the operator may have dismissed long before.
- **Fix.** `endOutage(memory, null, …)` ends the no-thread outage. It runs when a read shows a bound session and when a send is confirmed.
- **Test.** "audit of dev.88, line 1111…": the escalation is published and covers the forward. After a binding, the outage is gone, its notice is in `mootEscalations`, and a later no-thread forward is not covered.

## Fail-before

The new tests were run against an export of the base, `87af407`, with the proxy tests' `--protocol` set back to 88 for that run:
- `tests/dev89-m-items.test.mjs`, `tests/dev89-console.test.mjs` and the new proxy tests: **17 of 18 fail**, each on the defect it pins. (The M6 test's docs assertion was added after this run, because its behaviour part passed on the base; it fails there on the docs.)
- The failures, by test:
  - M1: provenance `{}` after the real recommission; `current` unknown; no `changedLiveSettings`; no History label.
  - M3: the unchanged-candidate stop, and the old stop text.
  - M4: no `stateResetNotice`.
  - M5: no `backdropClick`.
  - M7: no re-send.
  - M8: the stale reason, in the read and in the forward.
  - M9: a raw ISO value, and no confirmation.
  - M2 and the guides: the old text.
  - The audit items: "dev.88 re-sent it on the stale read", and the no-thread outage "kept for ever".

## Review of 10cd727

The GPT-6.1 Sol review of `10cd727` confirmed M1 (provenance through a real merge and a real activation, the delegated refusals, and the warning and repair text), the proxy items and the console (in headless Chromium, at 320px), and found no governance conflict. It found one P2.

### P2: M3 took invocation metadata for a plan change

**Problem.** `core/engine.mjs` compared digests of the whole planner result, which includes `provider`, `model`, `sessionId`, usage, cost, timing and the attempt. The reviewer's repro:
1. The review returns `revise`.
2. The replan returns the same plan, with only its `sessionId` changed.
3. The builder returns the unchanged candidate.
4. The flow went to review again instead of stopping.

**Fix.** `planContentDigest(plan)` (`core/plan-questions.mjs`) digests only what the plan says, and the replan record and the engine's hold both use it. It covers:
- the plan report (`result`), which the plan reviewer and the builder receive;
- what the plan was made against: the task revision, the governing context (`contextDigest`, and the context manifest; since the re-check of `0208a44`, the whole manifest, see below) and the base identity (`identity`, `targetBase`).

It leaves out every invocation field: provider, model, session, usage, cost, timing and attempt.

**Test.** "M3, review of 10cd727: a replan that returns the same plan from a new planner session is not a changed plan…" (`tests/dev89-m-items.test.mjs`). It is the reviewer's repro, with the session, usage, cost, timing and attempt all changed, and the flow still stops. It also checks that a new base identity is still a changed plan. The M3 fixture's plans now carry the invocation fields that dispatch records. On `10cd727` the new test fails ("reached review again"), and the two earlier M3 tests still pass.

### M2: the operator's decision

The finding commands stay delegable by default. `docs/changes/upkeep-slice4.md` no longer reads as opt-in: its summary line, its "The people" sentence and its "Going back" step now say what the default is, and the summary points to the corrected design text. The design records the decision. The M2 test checks all three.

## Re-check of 0208a44

The GPT-6.1 Sol re-check of `0208a44` confirmed the metadata repro now stops, a changed report allows re-review, repeated replans keep the original comparison, and the planner-question and target-follow tests pass. It found one P2.

### P2: a changed governing file could still block a legitimate re-review

**Problem.** `planContentDigest` took only the context manifest's `digest`, which is the digest of the delivered package (`operations/context.mjs`). A governing file whose mapping did not match what the planner read is omitted from that package. Its contents are recorded only in the manifest's `entries`, which the context guards use when the plan's own scope delivers it later. The reviewer's repro:
1. A governing file that Git ignores is mapped to `input.txt`. The planner's context leaves it out, but the plan names `input.txt`, so review and build receive it.
2. After a revise, the file changes, and the replan returns the same report.
3. The manifest records the changed file, but the package digest is the same.
4. The unchanged candidate was stopped, instead of being reviewed under the changed rules.

**Fix.** The digest now covers the whole governing evidence of the manifest, normalized by entry ID:
- the package digest;
- each delivered file's ID, path and content digest;
- each omitted entry's ID and reason;
- every entry's definition and content digest, including mapped entries that are delivered later.

Invocation metadata stays out.

**Test.** "M3, re-check of 0208a44: a changed governing file the plan's scope delivers is a changed plan, though the package digest is the same" (`tests/dev89-m-items.test.mjs`). It is the reviewer's repro, with real `assembleContext` and `contextManifest` output on a file excluded from Git. The test asserts that the package digest is unchanged, and that the flow goes to review when the file changed. It also runs a control in which the file is unchanged: the flow is still held. On `0208a44` it fails ("stopped instead of reviewed under the changed rules"), and the three earlier M3 tests pass.

## Results

On `de658a8` and after merging main at `866df71` (main added only a progress record): `npm test` **1658 tests, 1658 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. `git diff --check` is clean.

After the review fixes of `10cd727` (`c8a8dee`) and the merge of main at `49b8701` (main added only progress records): `npm test` **1659 tests, 1659 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. `git diff --check 87af407..HEAD` is clean.

After the re-check fix of `0208a44` (`d104e73`; main not merged again in this round): `npm test` **1660 tests, 1660 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. `git diff --check 87af407..HEAD` is clean.

## Action needed

**Everyone.**
- **Upgrade with the dev.89 CLI and your live settings are kept.** Its recommission keeps every live setting change you made with `settings.update` (console Settings or command) as a live change, and later `config update` runs from your file keep them.
- **If you upgraded with releases dev.82 to dev.88 after changing live settings,** some changes may already be lost, or will be lost at your next `config update`: `upkeep.mode`, admission and flow limits, notification level, the handoff limits, delegated operations and the others. Before your next `config update`, follow `docs/operations.md`, "Live settings after an upgrade":
  1. Find your live changes in History → Events ("Settings updated").
  2. Compare them with `config show`.
  3. Put the ones you want to keep in your configuration file, or set them again with `settings.update`.

  From dev.89 every `config update` names each live setting whose value it changes (`changedLiveSettings`).
- **Who may use the finding commands.** The orchestrator may already decline, resolve and reopen audit findings on a recorded instruction if your project has no `policy.delegatedOperations` list. The dev.88 notes said otherwise. To keep them with the operator, set an explicit list without `finding.accept`, `finding.resolve` and `finding.reopen`.

**Adopters using the triage proxy.**
1. **Copy `triage.example.mjs` to `project/integrations/triage.mjs` again.** What changed:
   - Every command needs `--protocol 89`.
   - A reset of the state file publishes an operator notice, `triage-reset-…`, from any command, and recovers the proxy's ID from the log. It needs `--factory-state`, which the brief's `TRIAGE` already passes.
   - After a rebind, a forward whose sends to the old session failed is re-sent at once.
   - A read older than a forward's own does not re-send it.
   - The outage of forwards with no destination ends when a session is bound.
   - Forwards name a stop reason only for a stopped flow.

   State files and logs from dev.88 keep working.
2. **Update the proxy brief** (`project/integrations/t3-triage.md`) from `t3-triage.example.md`:
   - the `TRIAGE` shorthand (`--protocol 89`);
   - "What you may and may not do" (the one notice it publishes itself);
   - webhook run step 0 (`mkdir -p -m 700 DIR && …`, and the `mktemp -d` fallback);
   - the new paragraph "If a step fails before `TRIAGE` has run", before "Sending a forward";
   - the paragraph on `triage-error` (state resets).

   The webhook prompt is unchanged.
3. **Update the handling guide** (`project/integrations/t3-notifications.md`) from `t3-notifications.example.md`:
   - the `TRIAGE` shorthand (`--protocol 89`);
   - "After binding" (the immediate re-send).

   No new placeholder.

Copy the brief and the script together: a dev.88 brief passes `--protocol 88`, so every run then only forwards a notice saying the guides must be copied again.

## Open questions

- **M5 and M9 in a live console.** The review checked the console in headless Chromium at 320px. A live pass of A-03 (d) and H88 on a real project would still confirm M5's blank click and M9's times and confirmations there.
- **M6's trial observation.** The behaviour was already consistent, so the audit job the re-test saw running while paused most likely started before the pause. The trial's event log (`job.started` against `admission.paused`) would settle it.
- **A read of the lost live changes.** The repair uses History and `config show`. A CLI read that lists live changes whose value is no longer in force, or is not in the file, would make the check one command. It was not added.
