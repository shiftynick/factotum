# dev.87: the dev.86 readiness re-test findings K1–K5

Five findings from the dev.86 readiness re-test:

- K1 (misleading): the triage proxy escalated forwards it had just delivered.
- K2 (console): a grouped marker's list in a flow's execution timeline was clipped.
- K3 (console): the Inbox was wider than a phone.
- K4 (console, cosmetic): Health's scheduled-tier time had no UTC tooltip.
- K5 (proxy edges and docs).

This is a local implementation record, not a release, activation or live qualification claim. No provider, forge or T3 tool was called by the tests.

**What changed.**
- The project-owned proxy files: `starter/project/integrations/triage.example.mjs`, `t3-triage.example.md` and `t3-notifications.example.md`.
- The console: `ui/timeline.mjs`, `ui/operations.mjs` and `style.css`.
- Docs: `docs/integrations/t3.md` and `docs/qualification/console-browser.md`.
- Tests.

No core, operation, workflow graph or state view changed, so no workflow digest changes and no task needs approving again. Adopters must copy the proxy script and update both guides again; see "Action needed".

## K1: forwards confirmed sent were escalated anyway

### What happened

In the dev.86 trial, two pending rows were carried over from dev.85, unconfirmed and without text.

1. The proxy's first run re-sent both at 13:27:29.
2. Because both were older than ten minutes, the same run also printed `escalate`, the finished notice payload.
3. The proxy did everything in order: send, `--sent` (13:27:46), then `ACT` with the notice it had been given (13:27:56 and 13:28:07).
4. Its `--escalated` then logged "no pending forward". The script had decided the notice before the send, and nothing re-checked it.

The notices said "the orchestrator has not received it" and "the proxy keeps re-sending it", and both were false. One was about a merge question answered and merged hours earlier. Their titles were raw send IDs, because the rows had no text.

### Fix (`triage.example.mjs`)

1. **A run never prints a notice beside a send.** Every step (a `retries` entry, the run's own result, a `--send-failed` `next`) now carries `escalateDue`, the reason, instead of `escalate`. The proxy asks for the notice with the new `TRIAGE --escalate <sendId>`, and only after every send of the run is recorded with `--sent` or `--send-failed`.
   - `--escalate` checks again under the lock: is the forward still pending, not escalated, and still due (no thread left, or `ESCALATE_MINUTES` old)?
   - A forward confirmed in the same run, or closed meanwhile, gets `escalate: null` with the reason.
   - The bound of review fix P2-2 is unchanged: a forward still unconfirmed after the run's sends is escalated in the same run.
2. **Confirmed after the notice: the notice stays, and is reported moot** (see also K5.2). The notice can be acted on before the confirmation arrives, or published late by an older brief, as in the trial. The proxy does not withdraw it: it cannot prove the notice is its own (see "Re-check of 2ca04f9", P2-1). Instead:
   - the notice's text says it is informational, stays until the operator dismisses it, and how to check whether the forward has been delivered since (`triage.mjs --verify <sendId>` or `--forwards --unconfirmed`);
   - once a forward the proxy escalated is confirmed sent or closed, the proxy's next delivery forward lists the notice once, under "Escalation notices now moot", so the orchestrator can tell the operator.

   Two earlier versions in this release withdrew the notice; see the two review sections below.
3. **Forwards about items that have moved on are closed as obsolete.** Before re-sending, a run checks each unconfirmed attention forward against a complete list of open items:
   - every narrow read has `openItems`, so every webhook run with a read checks;
   - the compact view lists every open inbox item, so every timer run checks.

   A forward whose item is no longer open, or is open at a newer version than it was about, is closed. It is logged as `obsolete`, listed in the run's `closed` (an escalation already published for it is reported moot by the next forward), never re-sent or escalated, and no longer listed by `--forwards --unconfirmed`. `--counts` gains `obsolete`. Resolution forwards (an answer, an expiry, a withdrawal) are never obsolete: they report something closed, and Factotum re-sends them every 30 minutes until acknowledged anyway. A digest run reads no state, so it closes nothing this way. Each pending row now keeps the item's version, the event, title, task and flow.
4. **Readable titles.** An escalation's title is the forward's headline, else `aboutForward`: the kind and title ("Operator question: “…” (task …)"), else the item, flow or task. It is never only a send ID.
5. **Rows kept before dev.86** have no text. `hydrate` fills in once, from the forward's decision line in the log, what that line has: the rule, item, version, event, title, task, flow and the thread it was decided for. The re-send then says "Operator question: “…”. Its full text was not kept (a forward decided before dev.86)". It gives the IDs, asks the orchestrator to read the item ("it may have been handled long ago"), and is closed as obsolete when its item has moved on.

## K5: the proxy's edges

1. **A rebind waits for the next proxy run.** `orchestrator.session` produces no delivery, and T3 has no hook that runs a task when a session binds. But T3's `run_scheduled_task_now {"taskId": …}` starts a task at once (it needs a full-access or default caller). The handling guide therefore has a new step, "After binding", used when the thread starts, takes over, resumes or binds again:
   1. Run `run_scheduled_task_now {"taskId":"<triageTimerTaskId>"}`. That timer run re-sends every unconfirmed forward to the bound session first.
   2. A minute or two later, run `TRIAGE --forwards --unconfirmed`. Handle anything still listed from state (the timer is stood down, or the call was refused or failed), and record it with `--missed --kind undelivered --ref <sendId>`.

   The script now closes a forward so recorded as `handled`, so handling it from state no longer leads to a duplicate re-send (orchestrator report gaps 1, 9 and 10). Without the call, the bound stays the timer interval; the integration guide says so ("A rebind wakes nothing by itself").
2. **Escalation notices outlived their cause. Resolved by documentation, not by the proxy withdrawing them.** The finding allowed either a withdrawal, if the proxy's allowance permits it for notices it published, or a statement in the notice that it is informational.
   - **Why not withdraw.** Factotum lets the publisher withdraw its own standalone item, but it knows the publisher only by role (`core/communication.mjs` `withdrawStandaloneInbox`: `actor === item.createdBy`), and the actor is declared by the caller. So any orchestrator-role caller can withdraw any notice the orchestrator role published, and anyone with that role can publish a notice with the proxy's offered ID, kind, title and context before the proxy does. The proxy cannot prove that a notice is its own, and a withdrawal could remove another publisher's notice. Two versions that withdrew (by ID, then after an exact read-back) were each shown unsafe by review, so the withdrawal was removed.
   - **What there is instead.** The notice says it is informational and stays until the operator dismisses it, and how to check whether the forward has been delivered since. The proxy's next delivery forward lists notices whose forward has since been confirmed or closed ("Escalation notices now moot"), and the handling guide tells the orchestrator to pass that on in one line. The brief forbids the proxy to withdraw or dismiss any notice, its own included.
3. **`delivery.ack` for an operator-only notice.** Core refuses both `inbox.ack` and `delivery.ack` from the orchestrator for an item with `operatorAckOnly` (`core/project.mjs`). Such a forward's last line now says "Only the operator can acknowledge this notice and its delivery: do not run delivery.ack or inbox.ack for it", and its ask says the same. The handling guide's step 3 names the exception and all four delivery statuses (`accepted`, `delivered`, `acknowledged`, `superseded`).
4. **Re-sends carried stale text.** Every re-send is headed "Re-sent (decided <time>, not confirmed sent since; its facts are from then, so read the item before acting)". A re-send whose item has moved on is no longer sent at all when the run read the open items (K1 fix 3). In the trial, the plan question re-sent 44 seconds after its answer was such a case: that run was a webhook run with a read.
5. **Forwards from before dev.86 had no text.** See K1 fix 5.
6. **The "last bound session seen" fallback was the missing thread.**
   - The proxy now records failures per thread across forwards (`failedThreads`) and the last thread a send was confirmed to (`lastConfirmedThread`).
   - The fallback order is: the bound session read now, the thread it was decided for, the last bound session seen, the last thread a send reached, then the configured thread.
   - A thread that failed twice, for any forward, with no send confirmed to it since, is never chosen while another is left. A later forward for that thread moves on after its own first failure.
   - In the trial's J7 test, the forwards would have reached the live orchestrator thread instead of waiting for the rebind.
7. **Smaller points:**
   - The resume step falls back to `triageTimerDisabledAt` and reads state first.
   - "Earlier forwards not yet confirmed sent" now says "when this was decided" and points at the current list.
   - The count check compares with `.orchestratorSession.deliveries` after an absence.
   - The delegated-merge condition is now "main health is `green`": `unknown` during a verification is not green. The merge bullet says to report a non-green main in the summary.
   - All four `delivery.ack` statuses are named.
   - What a stood-down thread does with forwards is stated (acknowledge, one line each).
   - Not fixed: the session-reset notice naming "orchestrator" as the actor of a bind made with that actor. It is core's text and is accurate as recorded; see "Open questions".

## K3: the Inbox was wider than a phone

**Cause, measured.** An Inbox card (`article.decision`) is a grid item of `.decision-list`, itself a grid item of `.view`. Neither had `min-width: 0` or any wrapping, so a card was as wide as its longest unbroken word. I rendered the real `inboxView` (fake DOM, serialised) into the real page shell with the real stylesheet and measured it in headless Chromium at 390 and 320 px. The fixture was an escalation notice shaped like the trial's.

| Case | 390 px | 320 px |
| --- | --- | --- |
| dev.86 stylesheet | `scrollWidth` 680 | 680 |
| only the title long (66-character send ID) | 680 | |
| only the context long (75-character `mcp:launch:` thread ID) | 675 | |
| fixed stylesheet | 375 (no element past the edge) | 305 |

The trial's 680 px is reproduced exactly. Either token alone causes it: the titles were one cause, the contexts carrying full thread and send IDs the other.

**Fix** (`style.css`). `.decision` gets `min-width: 0` and `overflow-wrap: anywhere`, which is inherited and also lowers min-content width, unlike `break-word`. `.decision-list` gets `min-width: 0`. IDs are shown whole and wrap.

## K2: a grouped marker's list was clipped by the flow's chart

**Cause.** In a flow's execution timeline the marker group sat inside `.gantt-scroll`, whose `overflow-x: auto` makes `overflow-y` compute to `auto` as well. So the absolutely placed list was clipped by the chart's box. The Timeline tab's events lane has `overflow: visible`, which is why the dev.84 fix held there.

**Fix** (`ui/timeline.mjs`, `style.css`). `markerGroup` takes a `panel`. In the flow chart, each group's list is shown in a panel directly below the chart, in the page's flow, instead of inside the group:
- The panel is headed "N events close together:"; the summary is labelled "…; show them below the chart" and `aria-controls` the panel.
- Opening fills the panel; closing empties and hides it.
- Escape on the group or inside the panel closes it and returns focus to the summary.
- A click inside the panel does not close it; a click elsewhere does. Only one group is open at a time.

The Timeline tab's groups are unchanged.

**Measured in Chromium** (the real flow detail with three events seconds apart, opened):

| Case | 320 px | 390 px | 1200 px |
| --- | --- | --- | --- |
| dev.86 | list y=200–358, chart box ends at 206: clipped | 200–358, box ends at 206: clipped | 200–282, box ends at 203: clipped |
| fixed | not clipped, right edge 266 of 305 | not clipped, right edge 336 of 375 | not clipped |

In every fixed case, each item is the element at its own centre.

## K4: Health's scheduled-tier time had no UTC tooltip

`ui/operations.mjs`: "Scheduled tier" and a scheduled-only check's "last full verification" use `timeNode` (dev.83's time element, as J5 did), with `title` "<ISO> (UTC as recorded)".

## Qualification checklist

`docs/qualification/console-browser.md`:
- A-02: no sideways scroll at 390 and 320 px with a long unbroken ID in a card, publishing one if needed.
- A-03: in a flow's chart the list opens below the chart; check that every item is fully visible and outside the `.gantt-scroll` box. Escape and click behaviour for the panel.
- A-09: "Scheduled tier" and the scheduled-only line have the UTC tooltip.
- D-03: 390 and 320 px.

## Tests

- `tests/triage-proxy.test.mjs`: 6 new tests.
  - K1 repro: re-sent, confirmed, `--escalate` null; a published notice stays and the next forward reports it moot, once; the trial's late publish.
  - K1 obsolete: a webhook run and a timer run; a resolution forward kept.
  - K1/K5 rows from before dev.86.
  - K5 `operatorAckOnly`, checked against core's refusal.
  - K5 fallback to a thread that has not failed.
  - K5 handled, and the guides.
- 10 dev.86 tests updated for the new output and wording (`escalateDue` on steps, the notice from `--escalate`; `--counts` has `obsolete` and `handled`; the "when this was decided" wording; the brief's "First, `retries` and `closed`" and `next.escalateDue`).
- `tests/dev87-console-k-items.test.mjs`: 4 new tests: K2 (the panel, outside the scrolling box, keyboard and clicks, the CSS), a guard that the Timeline tab's groups keep their own list, K3 (the tokens shown whole, the card's CSS) and K4.

**Fail-before.** Both changed test files were copied into an export of the base `b1ac9e2` (`git archive`) and run there: 57 tests, **19 fail, 38 pass**.
- The 19: the 9 new K tests (6 proxy, 3 console) and the 10 updated dev.86 tests, which fail on the base's output fields and wording.
- The new Timeline-tab guard passes on the base, as intended.

## Review of 55fccf4

An independent review (GPT-6.1 Sol) of `55fccf4` passed the K1 ordering, the evidence for closing obsolete forwards, the Chromium measurements at 320 and 390 px, the safe text handling and the absence of JSON reads. It requested changes for two P2 findings, and asked for a protocol version check.

### P2-1: the withdrawal did not prove the proxy published the notice

*Superseded by "Re-check of 2ca04f9", P2-1: the withdrawal described here was removed. Kept as the record of that round.*

**Problem.** Core authorises `inbox.withdraw` by role (the publisher's role, or the operator), so it cannot tell the proxy from any other orchestrator-role publisher. Two repros:
- After a forward was confirmed, `--escalated` given a genuine read of an unrelated orchestrator-role notice returned a withdrawal, and core ran it. The notice only had an ID starting `triage-undelivered-` and a context containing `Send ID <sendId>.`.
- `--sent` and closing withdrew the notice by its offered ID before any read-back. So an unrelated item occupying that ID was withdrawn.

**Fix** (`triage.example.mjs`):
- **A ledger of the proxy's notices.** The proxy keeps `memory.notices`: per notice ID, the send ID, a SHA-256 digest of exactly the kind, title and context offered, and a status. A notice is `offered` when made, and `published` only after `--escalated` reads it back and it matches. An item found under an offered ID that does not match is dropped from the ledger and never withdrawn.
- **`resolve` names the notice; it is not the action.** When the forward is confirmed or closed, its notices are marked done, and `resolve: {noticeId, reason}` is printed for each one confirmed published. An `--escalated` read-back that matches an offered notice of a forward already done records it as published and returns its `resolve`. This is the trial's late publish, now proven by the exact ID and digest instead of a substring.
- **The new `--withdraw <noticeId> --state <fresh read>`.** It prints the `inbox.withdraw` (with the version read) only when all of these hold:
  - the ledger has the notice as published and done;
  - the read is that ID, a notice, created by the orchestrator role, with the same digest;
  - the notice is still open.

  The ledger forgets the notice either way, so it is asked for once. The context-substring check is gone.
- **The brief.** Step 5 reads the notice again and runs `--withdraw`, never withdrawing an item `--withdraw` did not print. The allowance names `TRIAGE --withdraw` as the one exception.

### P2-2: an overlapping run could credit a confirmation to a failed thread

**Problem.** Overlapping runs can send one send ID to different threads. In the repro:
1. Run A sent to thread A and paused before `--sent`.
2. An overlapping run's sends failed, the send moved to B, and B failed twice.
3. Run A's delayed `--sent` set `lastConfirmedThread` to B and cleared B's failures, because it credited the row's current `forwardTo`.

**Fix.**
- Every send attempt appends its thread to the row's `sentTo` list, which is never rewritten.
- `--sent` and `--send-failed` take `--to <threadId>`, required on the command line: the `threadId` of the `send` object the proxy actually used. The confirmation or failure is credited to that thread, and a thread the send ID was never handed out for is refused.
- Called as functions without `to` (state from before dev.87), they fall back to the last thread planned.
- The `sent` and `send-failed` log lines record the thread named.
- The brief's steps 2 and 3 pass it.

### The protocol version

`PROTOCOL = 87` in the script. Both guides' `TRIAGE` shorthands pass `--protocol 87`, and every command except `--help` needs it.
- **A missing or different version, on a wake, timer or digest run:** the run exits 1, writes the reason to stderr, and prints one forward (rule `protocol-mismatch`) to the last bound session seen. The forward says the brief and handling guide must be copied again and that nothing was decided, acknowledged or recorded. An old brief therefore still delivers the news instead of silently skipping a step such as escalation.
- **Any other command:** it exits 1 with the same message.

The cost is one argument in each shorthand and one comparison per call.

### Tests

`tests/triage-proxy.test.mjs`:
- **New.** "review P2-1": both repros, plus a changed read of the proxy's own notice. "review P2-2": the repro, a never-used thread refused, `--to` required, and the brief. "review: a missing or different protocol version…": wake runs without and with `--protocol 86`, `--sent`, `--counts` and `--escalate`, and both guides.
- **Updated.** The K1 repro and K1 obsolete tests: withdrawal through `--withdraw` after a fresh read. Two CLI calls now pass `--to`, and the dev.85 `--sent` test expects `to`. The dev.86 docs test checks the new `--send-failed` wording. The test helpers pass `--protocol 87`.

**Fail-before.** The changed test file was run on an export of `55fccf4`: 56 tests, **7 fail, 49 pass**.
- The three new tests fail, the two repros on the defects themselves: "not ours: no withdrawal" and "credited to the thread it reached".
- The four updated tests fail on the new output.

### Merge of main

`main` at `32b875a` (knowledge upkeep slice 2 and its record) was merged after the fixes. Nothing conflicted; no file of this branch is touched by slice 2 except `docs/one-factory-progress.md`, which merged cleanly.

## Re-check of 2ca04f9

An independent re-check (GPT-6.1 Sol) of `2ca04f9` confirmed that the earlier repros pass and that the protocol check leaves state unchanged on every path. It found three P2 and one P3.

### P2-1: matching content does not prove the proxy published the notice

**Problem.** Another orchestrator-role publisher can publish the offered ID, kind, title and context first, and extra fields such as links pass too, since the digest ignored them. `--escalated` then accepted it, `--sent` returned `resolve`, and `--withdraw` succeeded in core. Core cannot tell orchestrator-role publishers apart, and actor names are self-declared, so no check in the proxy can prove authorship.

**Decision and fix: the proxy withdraws nothing.**
- Removed: `resolve` from `--sent`, `--escalated` and `closed`; the `--withdraw` command; the published-notice ledger (`memory.notices`). Nothing else needed the ledger.
- Kept: the read-back at `--escalated`, so a mismatched holder of an offered ID still makes the proxy offer the notice again under a new ID.
- The notice's text: informational, stays until the operator dismisses it, and how to check delivery since (`--verify <sendId>`, `--forwards --unconfirmed`).
- The cheap mention. When `--sent` confirms, or a run closes, a forward whose notice was recorded as published, the proxy keeps `{noticeId, sendId, why}` in `memory.mootEscalations` (at most 20). The next delivery forward carries them in one line, "Escalation notices now moot (data): …", and the list is cleared. If that forward is never delivered, the line is lost; the notice text's own check still works.
- The brief: no withdrawal in the allowance ("never withdraw or dismiss an escalation notice, even your own"). Step 5 says why the notice stays. `closed` entries need nothing from the proxy.
- The handling guide and the integration guide say the same, with the reason. K5 item 2 above is now resolved by documentation.

### P2-2: confirming by delivery ID skipped destination validation

**Problem.** After a normal send to A was confirmed (its pending row removed), `--sent <deliveryId> --to attacker-never-used` succeeded and set `lastConfirmedThread` to the never-used thread, which redirects later fallback sends.

**Fix.**
- `--to` is checked on every path. When nothing is pending under the ID and the delivery (named by its delivery ID or by a `<deliveryId>:<n>` send ID) is already confirmed, `--sent` is a no-op: `recorded: "already-sent"`, with nothing written to the state file or the log.
- That no-op is allowed only for a thread the delivery was sent to: a confirmed delivery now keeps every destination of its attempts (`sentTo`). An unknown thread is refused.
- A pending send with no recorded destination at all (state from before dev.85) is confirmed but credits no thread.

### P2-3: retrying a dev.86 row dropped its original destination

**Problem.** A dev.86 pending row addressed to A had no `sentTo`. After B was bound, a timer retry set `sentTo = [B]`, and a delayed confirmation for A was refused.

**Fix.** A row's `sentTo` starts from its `decidedFor` and `forwardTo` before the retry's thread is appended. Checks of a row without a list use the same two fields.

### P3: examples in `docs/integrations/t3.md`

The "How" paragraph and the "A failed send" bullet now show `--sent <sendId> --to <threadId>` and `--send-failed <sendId> --to <threadId> --error …`. The "What the proxy acts as" bullet, unchanged since before dev.86, now names the escalation publish and says the proxy withdraws nothing.

### Tests

`tests/triage-proxy.test.mjs`:
- **New.**
  - "re-check P2-1": the repro (the offered ID and exact content published first by another caller, with links), then no output offering a withdrawal, the notice still open, no `--withdraw`; a mismatched holder still re-offered under a new ID; the guides.
  - "re-check P2-2": the attacker confirmation refused; confirming again by delivery ID and by send ID is `already-sent`, with the state file and log byte for byte unchanged.
  - "re-check P2-3": a dev.86 row retried to B keeps A, and A's late confirmation is accepted and credited.
- **Replaced.** "review P2-1" (the ledger and `--withdraw`) by "re-check P2-1".
- **Updated.** The K1 repro (the notice stays; the next forward reports it moot, once), K1 obsolete (no `resolve`; the moot line names the closed forward) and the K5 guides test.

**Fail-before.** The changed test file was run on an export of `2ca04f9`: 58 tests, **6 fail, 52 pass**.
- The three new tests fail on the defects: a `resolve` returned for the look-alike, "refused" for P2-2, and "the list starts from the thread it was addressed to" for P2-3.
- The three updated tests fail on the removed withdrawal and the new text.

## Results

On `55fccf4`: `npm test` 1378 tests, 1378 pass, 0 fail. On `2ca04f9`, after the merge of `32b875a` (main gained the knowledge-upkeep slice 2 tests): 1436 tests, 1436 pass, 0 fail.

After the re-check fixes: `npm test` **1438 tests, 1438 pass, 0 fail** (0 skipped, 0 cancelled). `npm run eval` exit 0. `git diff --check` clean.

## Action needed (adopters using the triage proxy)

1. **Copy `triage.example.mjs` to `project/integrations/triage.mjs` again.** Its output changed:
   - steps carry `escalateDue` instead of `escalate`;
   - runs print `closed`;
   - a new command `--escalate <sendId>`;
   - `--sent` and `--send-failed` need `--to <threadId>`; confirming a send again is `already-sent`;
   - delivery forwards may carry "Escalation notices now moot";
   - every command needs `--protocol 87`; without it, runs forward a notice to copy the guides again, and other commands fail.

   State files and logs from dev.86 and earlier keep working: old rows are filled in from the log.
2. **Update the proxy brief** (`project/integrations/t3-triage.md`) from `t3-triage.example.md`: "What you may and may not do", webhook run steps 3 to 7, and "Sending a forward" steps 2 to 6. Copy the two together: a dev.86 brief does not pass `--protocol 87`, so every run then only forwards a notice saying the guides must be copied again.
3. **Update the handling guide** (`project/integrations/t3-notifications.md`) from `t3-notifications.example.md`:
   - "After binding";
   - "Forwards the proxy closes without sending";
   - "A forward the proxy could not send";
   - every-notification step 3 (`operatorAckOnly`, the four statuses);
   - the merge condition on `green`;
   - "Standing down and resuming";
   - the `TRIAGE` shorthand, which now ends in `--protocol 87`.

   No new placeholder.
4. **Escalation notices are never withdrawn by the proxy**, those already open from dev.86 included. The operator dismisses them in the console; the handling guide has the orchestrator say when one is moot.

## Open questions

- **K5.1, the rebind wake depends on T3's permission.** `run_scheduled_task_now` needs a full-access or default caller. An orchestrator thread without that permission gets the timer-interval bound, and the guide's fallback (handle from state, record `undelivered`). A Factotum-side delivery on `orchestrator.session` would remove the dependency, but it changes notification semantics for every adopter, so it was not done here.
- **The session-reset notice's actor** (K5.7, last point): it names the actor recorded by `orchestrator.session` ("orchestrator"). Wording it as "bound with the orchestrator role" would be a core text change. Not done.
- **Obsolete closing leaves the delivery unacknowledged.** The item's resolution is its own delivery, and Factotum stops reminding a closed item. The proxy still never acknowledges what it forwarded.
- **The real-browser measurements** were made on static renders of the real views and stylesheet (the harness is not committed). Pass A and Pass D of the qualification checklist on a live console have not been re-run.

## Re-check of 81f35f1

The GPT-6.1 Sol re-check confirmed the earlier fixes:
- No withdrawal or acknowledgement action remains.
- An item that holds an offered ID under a different notice gets the notice re-offered under a new ID.
- Valid `already-sent` calls change nothing.
- The guides match the script.

It found one P2: repeated retries still erased a valid original destination.

**Problem.** `sentToWith` appended duplicates before bounding the list at 50 entries. After 50 retries to B, a legacy row addressed to A listed only B, so a delayed `--sent … --to A`, or `--send-failed` for A, was refused.

**Fix** (main thread). Each thread appears in a send's list once, so retries to the same thread never push the original out.

**Test.** "re-check of 81f35f1: many retries to one thread list it once …": 55 timer retries to B leave `sentTo` as `[A, B]`, and a late confirmation for A is accepted. It fails on `81f35f1` with "each thread once, the original kept". The proxy test file passes 59 of 59.
