# dev.90: the dev.89 readiness re-test findings N1–N5

Five findings from the dev.89 readiness re-test:

- **N1 (friction).** An unapproved governing-file edit was refused at `workspace.commit` with a precise message. The flow then failed, and its notice said only "Change workflow failed; inspect retained attempt evidence".
- **N2 (docs and one behaviour, triage proxy).** Gaps the orchestrator found in the forced-failure tests:
  - the handling guide did not mention `triage-reset-…`;
  - the `triage-failed-…` text promised one notice an hour;
  - the text called every failed delivery "a notice delivery";
  - a forward decided while the state could not be written could stay unconfirmed with no end.
- **N3 (console).** The finding and candidate confirmations named only the project.
- **N4 (console).** One finding time was shown both as a date and as "1 hour ago".
- **N5 (docs).** Pass A step 3 of the console checklist contradicted itself about a click on blank space in the flow window.

This is a local implementation record, not a release, activation or live qualification claim. No provider, forge or T3 tool was called by the tests.

**What changed.**
- Core and actions:
  - `workflows/refusal-notice.mjs` (new): the operator notice for an enforcement refusal (N1).
  - `workflows/dispatch.mjs`: `runAction` gives an enforcement refusal its notice, and the two docs-conflict refusals are tagged (N1; review of 8441ff4).
  - The enforcement boundaries each tag their refusal with one field, `refusal {kind, ...}`: `operations/governance-edit.mjs`, `operations/provider-config.mjs` (three refusals), `workflows/upkeep-enforcement.mjs` and `core/upkeep-namespace.mjs` (one expression each; review of 8441ff4).
  - `workflows/actions.mjs`: the before-review governing refusal carries the notice (N1).
  - `core/engine.mjs`: a step error that carries a notice stops the flow with it (one line, N1).
  - `operations/state-view.mjs`: `status --flow` has `flow.failure`, and each attempt row has its `notice` (N1).
- The console: `ui/operations.mjs`, the confirmation texts (N3) and the disposition time (N4).
- The project-owned proxy files:
  - `starter/project/integrations/triage.example.mjs`: the notice text, the two-phase record of a decision (state, log line, state), the log's `--sent` confirmation, and the approval forward's text (N2, gap 13). The protocol is now 90.
  - `t3-notifications.example.md` and `t3-triage.example.md`: the protocol, and in the handling guide the error and reset notices, in-progress forwards, a forward re-addressed after it arrived, `flow.failure`, and a failed flow diagnosed before its task is queued or restarted (gap 13).
- Docs:
  - `docs/integrations/t3.md`: protocol 90, the notice IDs and kinds, and a decision logged before anything is sent.
  - `docs/project-workflows.md` and `docs/running.md`: the refusal's notice and `flow.failure`.
  - `docs/qualification/console-browser.md`: Pass A step 3 (N5).
- Tests:
  - new: `tests/dev90-n-items.test.mjs` and `tests/dev90-console.test.mjs`;
  - `tests/upkeep-docs-enforcement.test.mjs`, `tests/upkeep-context.test.mjs` and `tests/provider-worktree-isolation.test.mjs`: each refusal's tag and notice on its real path (review of 8441ff4);
  - `tests/triage-proxy.test.mjs`: protocol 90, and one expected sentence of the refused-delivery notice;
  - `tests/dev89-console.test.mjs` and `tests/dev89-m-items.test.mjs`: their exact confirmation texts and protocol number moved to the new tests.

No workflow graph changed, so no workflow digest changes and no task needs approving again. No schema changes. No SQL reads `records.data`. Upkeep slice 6 and provider worktree isolation have both merged into main, and main was merged here. This change adds one expression to each of their refusals, nothing else.

## N1: an enforcement refusal's notice says what was refused and what to do

### Cause

An action's error reaches the failed-flow notice only through its `notice` field (`core/engine.mjs` `attemptNotice`), and only the adopted-PR refusals set one. The governing-file boundary (`assertGoverningBoundary`) throws a precise message with `governingBoundary` (the entry IDs) and no `notice`. So `failedChangeReason` fell back to the generic sentence, and the message stayed in the attempt's `action-result.json` (`error`). The upkeep limits (`UpkeepCandidateRefusal`) and the unenforced upkeep marker had the same gap. So does the provider-configuration boundary of the provider-isolation change (`providerConfigBoundary`), which was not yet on main at the time.

The flow failing outright is the graph's design: `workspace.commit`, `workspace.integrate`, `forge.publish` and `forge.merge` route to `failed` on an error. The refusal before review stops the flow instead, so it can be replanned. Both are kept. Only what they tell the operator changes.

### Fix

`refusalNotice(error, {task, where, stopped})` builds the notice from one field every enforcement boundary sets, `refusal {kind, ...facts}`, never from the message's wording (since the review of 8441ff4; the first version read scattered fields, see below). The remedy wording is in one place, `workflows/refusal-notice.mjs`.

- **Governing file, not approved.** It names each entry with its path. It gives both remedies:
  - make the change: put a revision that names the entry in `governingEdits`, with the path in `paths`, approve it directly as the operator (`task.approve`), and start the task again (`task.restart`);
  - undo it: for a failed flow, start the task again with a note that the file must stay unchanged; for a flow stopped before review, `flow.replan` with that note.
- **Governing file, approved but changed by link, move or mode.** It says an approval never covers that, and to undo that part.
- **Provider configuration.** It names the paths. It gives the remedies: declare them in the task's paths and approve, or undo.
- **A provider-configuration link that cannot be checked** (`provider-config-link`: a cycle, naming the link, or more links than the factory follows). Remove or shorten the links.
- **Upkeep limits.** It says nothing was delivered. When the flow fails, the candidates are recorded as failed and the task closed. To try again, reopen a candidate from Health (`finding.reopen`); for a docs candidate the factory then makes a new follow-up. A refusal only because a pinned file moved says the candidates return to waiting, and nothing is needed.
- **An upkeep follow-up's integration conflicted** (`upkeep-conflict`). It names the files, says the merge was undone and nothing delivered, and that the candidates return to waiting; nothing is needed, and the conflict is not to be resolved by hand.
- **A merge in progress in a follow-up's worktree at commit** (`upkeep-merge-in-progress`). It says the factory did not start that merge and refused to commit it, that the candidates are failed when the flow fails, and to reopen one from Health rather than resolve the conflict by hand.
- **Unenforced upkeep marker.** Abandon the flow and close the task, or upgrade.

The notice ends with `Refusal: <the boundary's own message>`. It is cut at 2000 characters, the limit dispatch already applies, so the remedy is never what is cut.

Where it is used:
- `runAction` (`workflows/dispatch.mjs`) gives every enforcement refusal its notice, so `action-result.json` has `notice` and the failed flow's notice reads "Change workflow failed at commit: The candidate of task … changes governing file project-agents (AGENTS.md), which the task is not approved to change … Refusal: workspace.commit: …".
- The refusal before review (`workflows/actions.mjs`) carries the notice with the stopped-flow remedies. The engine's tick stops the flow with an error's `notice` when it has one, else with its message as before.
- `status --flow` (the narrow read) gains `flow.failure {step, attemptId, notice}` for a failed flow whose failing step gave a notice (null otherwise), and each attempt row carries its `notice`. The triage proxy's forward already quotes an attempt's `notice` from the narrow read. So the trial's "no notice in the narrow read" for this flow (the orchestrator's gap 14) now quotes the refusal too, with no change to the script.

The planner's and builder's own refusals to edit governing files (seen in the trial) are unchanged. They come from the run instructions ("Do not change governing factory files or instructions"), and they are the first line of defence.

### Tests

`tests/dev90-n-items.test.mjs`:
- "N1: a governing edit refused at workspace.commit fails the flow…": a real owned workspace and a fictional builder that edits `AGENTS.md`. The commit runs as the supervisor runs it: `dispatch.mjs` as its own process, writing `action-result.json`. The test checks the failed flow's notice (the file, both remedies, the quoted refusal) and `status --flow` (`flow.failure`, the attempt's `notice`).
- "N1: a governing edit refused before review stops the flow…": the stop reason, with the replan remedy.
- "N1, review of 8441ff4: an approved governing edit that also changes an unnamed governing file and the approved file's mode…": on the real path, at `workspace.commit`.
- "N1, review of 8441ff4: refusal-notice reads only the boundary's refusal field, and every boundary sets it": the old fields alone give no notice; a long refusal keeps the remedy; each boundary sets `refusal`.
- `tests/provider-worktree-isolation.test.mjs`: undeclared provider configuration and a link cycle at `workspace.commit` carry their tag and notice.
- `tests/upkeep-docs-enforcement.test.mjs`, on the Q3 fixture: "dev.90 N1, review Q3: a conflicting integration and a commit during a merge each give a notice…" (also through `dispatch.mjs` as its own process, with `status --flow`'s `flow.failure`), and "dev.90 N1: a docs candidate outside its limits, one whose pinned file moved, and an unenforced marker…".
- `tests/upkeep-context.test.mjs`: the context kind's refusal at `workspace.commit` carries its tag and notice.

## N2: the triage proxy's failure modes

### The `triage-reset-…` notice in the handling guide

The guide gains "The proxy's error and reset notices". For `triage-reset-<id>` it says what the proxy forgot and that its identity is recovered. It says what the orchestrator does: list `TRIAGE --forwards --unconfirmed` without `--for` and handle the forwards decided before the reset from state; read the open items; tell the operator in one line. The notices are the operator's: leave them open.

### Two `triage-failed-…` notices 27 seconds apart

**Why.** The two notices were for two different deliveries (both `task.approved`). A webhook delivery's notice ID is `triage-failed-<12 hex of its delivery ID>`. Only a timer or digest run, which has no delivery, uses the run and the UTC hour. The code did what the integration doc's rule intends: each delivery the proxy could not handle gets its own notice, and the same delivery failing again finds its own. The notice's sentence "Repeated failures of the same delivery, or in the same hour, do not publish another" was wrong.

**Decision.** Keep the ID and correct the text. One notice an hour for every delivery would hide the second delivery, and that delivery may be the one that needs someone (no-loss). The notice now says, for a delivery: "A repeated failure of the same delivery does not publish another notice; each other delivery that fails gets its own." For a run: "Another failure of the timer run in the same UTC hour does not publish another notice." The integration doc and the guide say the same.

### "A notice delivery"

The notice now words each kind from Factotum's delivery rules (`operations/notifications.mjs`):
- **A state event** (`task.approved` and the rest): "not an Inbox item, so there is no item to look for". Factotum sends a state event again until it is acknowledged (every 30 minutes by default), so a later proxy run handles it. If it cannot wait, read the task.
- **A resolution:** sent again until acknowledged.
- **An attention delivery:** names its item. The payload does not say whether the item is a notice or a question, so the text gives both: a notice is delivered once and may never reach the orchestrator; a question is sent again while it stays open.
- **Anything else:** unknown, so the operator should look.

Every value shown is a plain ID or a known event name.

### A forward decided while the state could not be written

**Cause.** A run appended its decision line to the log and then saved its state. When the save failed (a full disk, or a folder made read-only during the run), the run failed after logging a forward that the state did not hold. No later run knew it: nothing re-sent, escalated or closed it. `--forwards --unconfirmed` listed it for ever. When it was addressed to a session other than the orchestrator's, the guide told the orchestrator to leave it to the proxy, which never would. The run's error path did publish a `triage-failed` notice for the delivery. The log entry still never ended.

**Fix.** Within the dev.88 trust model: one destination, notices by the orchestrator role through the CLI, nothing from the payload trusted.
- **A decision is recorded in two phases** (since the review of 8441ff4; the first fix only put the state first). The run saves the state with the forward's pending row marked `undecided`, appends the decision line, then saves the state with the mark cleared. Every run, before it closes or re-sends anything, settles marked rows: a row whose line is in the log loses the mark; any other gets its decision line then, with its original time and `recovered: true`. If that append fails, the run fails and sends nothing. So the log shows every forward the state holds, and the proxy never sends one `--verify` cannot find. A run that fails at any of the three writes prints no send; its error path publishes the operator notice, and the delivery stays unacknowledged.
- **The reverse partial write.** `--sent` appends its line before it saves. When the save failed, the forward stayed pending: it was re-sent, and after ten minutes escalated as undelivered, although it had arrived. Now a run that reads the log closes such a forward as `delivered` ("the log has the confirmation; the state write after it failed"), marks its delivery sent, and never re-sends or escalates it.
- **A `--sent` that could not run at all** (the trial's case: the lock could not be made in the read-only folder). The proxy cannot know the forward arrived, so it re-sends it and escalates it after ten minutes. That is the no-loss rule working. It ends when the orchestrator records it.

**The guide.**
- `inProgress: true` only means the last send is under two minutes old: look again after that.
- A forward that reached this thread and was then re-addressed to another session can still be recorded with `--missed --kind received --ref <sendId> --for <this thread>`. Find it with `--forwards --unconfirmed` without `--for`. The script already accepts it when the forward was ever sent to this thread (`handedTo`), whichever session is bound. The guide had restricted the check to forwards listed for this thread.

The protocol is now 90, because the script changed.

### Tests

`tests/dev90-n-items.test.mjs`:
- "N2: a run that cannot write its state logs no forward…": the state folder is read-only for the run.
- "N2, review of 8441ff4 P2-1: a run whose log line fails sends nothing, and the next run logs the decision as recovered before re-sending it": the reviewer's repro (a read-only log, a `task.approved` wake, a timer run three minutes later).
- "N2, review of 8441ff4 P2-1: a forward whose decision cannot be logged is never re-sent; a crash after its line was logged adds no second line".
- "N2: a --sent whose state write failed after its log line is closed as delivered by the next run…".
- "N2: a triage-failed notice words each delivery kind correctly and states the real dedup key": the IDs for two deliveries and for one delivery, and a timer run's hour.
- "N2: the handling guide knows the reset notice…".
- "N2: the script accepts \"received\" from the thread a forward reached after it was re-addressed…": this passes on the base too. It pins the script behaviour the guide now relies on.

The four tests that make a file or folder read-only are skipped when run as root, where a read-only folder does not stop writes.

## N3: the confirmations name what they act on

Decline, Dealt with another way and Reopen now ask, for example:
- "Decline finding audit:<id> “<title>” (version 5)? Its task <task id> is closed too."
- "Reopen upkeep candidate upkeep:… “<title>” (version 3)? It returns to the waiting candidates."

The browser's own dialog still adds "Target: <project>". The title is model text, cut at 120 characters and shown as plain text by the browser's `confirm`. It is never parsed.

**Tests** (`tests/dev90-console.test.mjs`): "N3: each finding confirmation names the finding…" and "N3: an upkeep candidate's confirmations say candidate…". The dev.89 test now checks only that each form asks.

## N4: one time, one form

A finding card showed `statusAt` under "Status changed" as a date, and the disposition's `at`, the same moment, as "1 hour ago". Now the disposition shows its time only when it differs from the time the card already shows. When it does show, it is a date (`timeNode`), like every other finding time. A closed upkeep candidate's card has no "Status changed" row, so it keeps its disposition time, as a date. "Seen … last" stays relative: it is a different time, and the same element with the UTC tooltip.

**Test:** "N4: a finding's status time is shown once, as a date…". Nothing on the cards got wider, so the 320 px layout is unchanged.

## N5: the checklist

Pass A step 3 no longer lists "on blank space in the modal" among the places after which the first Escape closes only the list. It now says that a click there is a click outside the list: it closes the list and the modal stays open (M5), so the next Escape closes the modal. The outside-click rule and the L6 checks on the summary, on a panel link and on the panel's heading text are unchanged.

**Test:** "N5: Pass A step 3 no longer expects…".

## Review of 8441ff4

The GPT-6.1 Sol review confirmed the `--sent` recovery within the trust model, that no model text reaches a refusal's notice, the console in Chromium at 320 px, and N4. It found two P2s and asked for one guidance change.

### P2-1: save-before-log allowed a send with no verifiable provenance

**Problem.** The first fix for the stuck forward saved the state before logging the decision. A run whose log append failed (the reviewer made the log read-only) threw after the state held the pending forward. A timer run three minutes later re-sent it, and `--verify` said "this proxy did not decide to forward it".

**Fix.** The two-phase record described under N2 ("A decision is recorded in two phases"). Every run settles rows marked `undecided` before it closes or re-sends anything: a row whose decision line is in the log loses the mark; any other is logged then as `recovered`, with its original time. If that fails, the run fails. `--verify` keeps its rule (a send it cannot find in the log is unverified) and shows `recovered` on a decision logged late. `openSends` never offers a marked row.

**Tests.** The reviewer's repro, and a crash between the line and clearing the mark (no second line; re-sent as usual). Also a log still read-only at the next run: that run fails, and nothing is sent.

### P2-2: the docs-conflict refusals bypassed N1

**Problem.** `refusal-notice.mjs` recognised refusals by scattered fields (`governingBoundary`, `upkeepViolations`, `upkeepMarker`). The integration-conflict refusal of an upkeep follow-up carried only `upkeepEnding: 'base-moved'`, and the refusal to commit during a merge carried nothing. Both failed their flow with the generic notice and no `flow.failure`.

**Fix.** Every enforcement boundary now tags its refusal with one field, `refusal {kind, ...facts}`, and `refusalNotice` reads only that. The kinds: `governing-file`, `provider-config`, `provider-config-link`, `upkeep-limits`, `upkeep-conflict`, `upkeep-merge-in-progress`, `upkeep-marker`. The two docs-conflict refusals have their own notices and remedies (see N1, "Fix"). Their behaviour is unchanged: a conflict still returns the candidates (`upkeepEnding: 'base-moved'`), and a merge in progress at commit still fails them. `flow.failure` follows from the attempt's notice, as for the other refusals.

**Tests.** Real paths, not synthetic tagged errors:
- the Q3 fixture, for both refusals, including the step run as its own `dispatch.mjs` process and the narrow read's `flow.failure`;
- a docs candidate outside its limits;
- one whose pinned file moved;
- an unenforced marker;
- the context kind;
- an approved governing edit that also changes an unnamed file and the approved file's mode;
- after main brought provider worktree isolation, undeclared provider configuration and a link cycle (`tests/provider-worktree-isolation.test.mjs`).

### Guidance: a failed flow is diagnosed before its task is queued again (gap 13)

The handling guide's `task.approved` rule now reads the task's queue row first. A row `finished` with `flowState: failed` or `abandoned`, or a stopped flow, means the last flow did not deliver. Then "approved, not queued or running" is not a reason to queue or restart: diagnose the flow (`flow.failure`), tell the operator the cause and remedy, and queue or restart only once the cause is fixed or the operator says to. "Restart a flow only when the cause is understood and fixed" now covers queueing again too. The proxy's approval forward says the same. Test: "gap 13: the guide and the approval forward say a failed flow is diagnosed…".

## Re-check of 766c23e

The GPT-6.1 Sol re-check passed six crash probes (no phantom recovered decisions, original times kept, late logging visible), the refusal tagging and its generic fallback, provider isolation, slice 6 and gap 13. It found one P2.

### P2: `--send-failed` skipped decision recovery

**Problem.** Only wake, timer and digest runs settled `undecided` rows. The reviewer's repro:
1. A `task.approved` wake runs with the log read-only, so its forward is saved `undecided`.
2. The log is restored.
3. `--send-failed <id> --to <thread>` runs.

It returned `next.send` for that row while `--verify` said `logged: false`. `--sent`, `--escalate`, `--escalated`, `--judged-absorb` and `--set-proxy-id` skipped recovery the same way.

**Fix, in one place.** The gate now runs in `loadMemory`, which every command that reads the state goes through. With the log known, every `undecided` row has its decision logged as `recovered` (or found logged), its mark cleared and the state saved, before the caller sees any row. If the append or that save fails, the command fails: nothing is offered, sent, closed, escalated or counted. A state file that cannot be read is still reset as before, and the gate never resets.

The commands that read only the log (`--forwards`, `--verify`, `--counts`, `--missed`, `--absorbed`, `--correct`) run the same gate under the lock when given `--memory`. The handling guide's `TRIAGE` gives them no `--memory`. Then they see only the log, where an undecided forward is not yet a forward at all: they neither list, count, verify nor close it. A wake, timer or digest run reports what its own load logged in `recovered`.

**Tests** (`tests/dev90-n-items.test.mjs`):
- "re-check of 766c23e: --send-failed on an undecided forward logs its decision first…": the reviewer's repro through the command line, and a log still read-only, where the command fails and offers no send.
- "re-check of 766c23e: every command that holds the state logs an undecided decision before it acts…": a table over thirteen commands: `--sent`, `--send-failed`, `--escalate`, `--escalated`, `--judged-absorb`, `--set-proxy-id`, `--forwards`, `--verify`, `--counts`, `--absorbed`, `--missed`, `--correct`, and a timer run. Each is run from the same undecided state. Each logs the decision once, as `recovered`, with its original time, as the first line it writes, and clears the mark. Without `--memory`, the log-only commands do not list, count, verify or close it.

On `766c23e` both fail: "logged false", and "--sent: its decision is logged once".

## Fail-before

The two new test files were run against an export of the base, `624710e`. The import of the new `refusal-notice.mjs` was made optional for that run.
- **12 of 13 fail**, each on the defect it pins:
  - N1: no notice, a stop reason without a remedy, no tagging;
  - N2: the orphaned forward, the re-send of a forward that had arrived, "a notice delivery", the guide without `triage-reset`;
  - N3: "Decline this finding?";
  - N4: two time elements for one time;
  - N5: the old checklist sentence.
- The one that passes pins existing script behaviour (the "received" check).

The review's tests were run against an export of `8441ff4`, with this round's versions of `tests/dev90-n-items.test.mjs`, `tests/upkeep-docs-enforcement.test.mjs` and `tests/upkeep-context.test.mjs`. **9 of 54 fail**, the nine tests this round added or changed, each on its defect:
- P2-1: no `undecided` mark, so a later run re-sent a forward whose decision was never logged;
- P2-2: no `refusal` field and no notice for the conflict, the merge in progress, the limits, a pinned file, the marker and the context kind, and the governing boundary's old field;
- gap 13: the old guide;
- the integration doc's old bullet.

## Results

- On `5bc78f0`: `npm test` **1699 tests, 1698 pass, 0 fail**, 1 skipped (the confusables source test, which needs `FACTOTUM_CONFUSABLES_TXT`), 0 cancelled. `npm run eval` exit 0.
- After merging main at `b5f3d84` (knowledge upkeep slice 6) as `5336941`: `npm test` **1714 tests, 1713 pass, 0 fail**, 1 skipped (the same), 0 cancelled. `npm run eval` exit 0. `git diff --check 624710e..HEAD` is clean.
- After the review of 8441ff4 (`236d959`) and merging main at `3db7fe8` (provider worktree isolation) as `34aec2a`: `npm test` **1733 tests, 1732 pass, 0 fail**, 1 skipped (the same), 0 cancelled. `npm run eval` exit 0. `git diff --check 624710e..HEAD` is clean.
- After the re-check of 766c23e (main unchanged at `3db7fe8`): `npm test` **1735 tests, 1734 pass, 0 fail**, 1 skipped (the same), 0 cancelled. `npm run eval` exit 0. `git diff --check 624710e..HEAD` is clean.

## Action needed

**Adopters using the triage proxy.**
1. **Copy `triage.example.mjs` to `project/integrations/triage.mjs` again.** What changed:
   - Every command needs `--protocol 90`.
   - The `triage-failed-…` notice words each kind of delivery correctly, and says which repeats publish no second notice.
   - A decision is recorded in two phases (state, log line, state), and a decision a run could not log is logged as `recovered` before anything is sent again. So no forward stays unconfirmed with no end, and nothing is sent that `--verify` cannot find.
   - The approval forward says to diagnose a failed flow before queueing its task again.
   - A forward whose `--sent` was logged but not saved is closed as delivered, not re-sent and escalated.

   State files and logs from dev.89 keep working.
2. **Update the handling guide** (`project/integrations/t3-notifications.md`) from `t3-notifications.example.md`:
   - the `TRIAGE` shorthand (`--protocol 90`);
   - the new bullet "The proxy's error and reset notices", before "Forwards the proxy closes without sending";
   - in "Unconfirmed forwards addressed to this thread": the sentence on `inProgress` and the new sub-bullet "A forward in this thread now listed for another session";
   - in "A forward the proxy could not send", the pointer to the new bullet;
   - the flow-notice step 1 (`flow.failure`), and the sentence after step 3 ("Restart a flow, or queue its task again, …");
   - the `task.approved` rule (a failed flow is diagnosed before its task is queued or restarted).

   No new placeholder.
3. **Update the proxy brief** (`project/integrations/t3-triage.md`) from `t3-triage.example.md`: only the `TRIAGE` shorthand and the sentence on the protocol (`--protocol 90`).

Copy the script and both guides together: a dev.89 guide passes `--protocol 89`, so every run then only forwards a notice saying the guides must be copied again.

**Everyone.** Nothing to do. A refused governing-file edit, provider-configuration change or upkeep candidate now says what to do in its notice and in `status --flow` (`flow.failure`).

**Console qualification.** Pass A step 3 changed (N5): a click on blank space in the flow window closes the event list, the window stays open, and the next Escape closes the window.

## Open questions and follow-ups

- **Follow-up: a merge question that opened during the failure minute was reported by nothing** (the orchestrator's gap 4). Its delivery was consumed by a run that failed before it could record anything. That run's `triage-failed` notice names that delivery only if the run got as far as reading the payload. In the trial the two notices named two other deliveries. A question is sent again while it stays open and unacknowledged (every 30 minutes by default), so it is not lost, but it can be late. This round does not change that.
- **Live checks.** N3 and N4 are tested with the fake DOM. A live pass of A-03 (the N5 sentence) and of the Health finding forms in a real browser would confirm them there.
- **Follow-up: orphaned forwards from before dev.90.** A log that already holds a forward from a failed state write keeps listing it. The orchestrator records it with `--missed --kind undelivered` when it is addressed to its thread. One addressed to another session has no command to close it; the operator can ignore it.
