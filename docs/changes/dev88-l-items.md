# dev.88: the dev.87 readiness re-test findings L1–L7

Seven findings from the dev.87 readiness re-test:

- L1 (friction, triage proxy): a forward the proxy model delivered outside its `send` arguments stayed unconfirmed, and was delivered twice.
- L2 (design, triage proxy): a failed send was retried at once, in the same run, to another orchestrator thread, without reading the item again. So obsolete-closing and escalation were never reached.
- L3 (docs, T3 guide): the resume and "After binding" steps could make a thread that was not the bound session close forwards that were not its own.
- L4 (friction): no `status` read showed an `upkeepRun`.
- L5 (cosmetic): CLI `doctor` was reported to print progress lines into its JSON on stdout.
- L6 (console keyboard): Escape inside an opened event list closed the whole flow window.
- L7 (console): Queue's "Started … ago" times had no UTC tooltip.

This is a local implementation record, not a release, activation or live qualification claim. No provider, forge or T3 tool was called by the tests.

**What changed.**
- The project-owned proxy files: `starter/project/integrations/triage.example.mjs`, `t3-triage.example.md` and `t3-notifications.example.md`. The protocol is now 88.
- Core: `operations/state-view.mjs` (L4), the `status` help text in `core/command-help.mjs`, and `operations/orchestrator-session.mjs`, whose webhook payloads now carry `sessionVersion` (review of 44a3127, counts).
- The console: `ui/timeline.mjs` (L6), `ui/queue.mjs`, `ui/admission.mjs` and `ui/dom.mjs` (L7).
- Docs: `docs/integrations/t3.md`, `docs/running.md`, `docs/communication.md`, `docs/operations.md`, `docs/qualification/console-browser.md` and the console README.
- Tests: `tests/triage-proxy.test.mjs` and the new `tests/dev88-l-items.test.mjs`.

No workflow graph changed, so no workflow digest changes and no task needs approving again. The narrow read gains one field (`upkeepRun`); nothing was removed from it. Adopters using the triage proxy must copy the script and both guides again; see "Action needed".

## L2: the redesign of failed sends

### What happened

In round two of the re-test the operator bound the orchestrator session to a thread that did not exist. The live orchestrator thread was still the last thread a send had reached.

1. Every forward was decided for the missing session, and its first send failed with `thread_not_found`.
2. `--send-failed` at once offered the same send to the last thread a send had reached, in the same run. Nothing read the item again first.
3. Each forward reached the live thread 11 to 37 seconds after it was decided.

Three consequences followed:
- **Obsolete-closing never happened** (`obsolete: 0`). The operator acknowledged notice `j7r2-c` one second after its first send failed. The fallback delivered it ten seconds later, still saying "status open". A forward was closed only by a later run's read, and with a working fallback there was never a later run in which it was still unconfirmed.
- **Escalation never happened** (`escalations: 0`). Escalation was due only when every known thread had failed, and the fallback thread never failed. So the operator was never told that the binding named a missing thread.
- **Forwards reached a thread that was not the bound session**, with nothing in them saying so. For a slow-to-start successor this means the retired thread keeps receiving the successor's forwards.

### The design now (`triage.example.mjs`)

> **Superseded in part.** The other-thread fallback this section describes was removed after the third re-check of 0933596; see "Decision: no thread fallback" below. The re-read before every re-send, the escalation of a broken binding and the closing of obsolete forwards stand.

Three rules, in order.

1. **Forwards belong to the bound session.** The bound session is the one the latest read shows, else the last one the proxy saw, else the thread the forward was decided for, else the configured thread (`boundOf`).
   - After one failed send, the next send goes to the bound session once more.
   - A run's re-send always tries the bound session first, even one that failed before: a successor that was slow to start may be there now.
   - The other threads the proxy knows are fallbacks only: the thread a forward was decided for, the last bound session seen, the last thread a send reached, and the configured thread.
2. **The operator is told before any fallback.** The bound session is *down* for a forward when it failed two sends of it, or one after failing two other forwards with none confirmed since (the dev.87 per-thread rule).
   - When it is down, `next.send` is null and `next.escalateDue` says why: "the bound orchestrator session X failed N send(s) of it (last error …); the proxy sends it to Y, which is not the bound session, only as a fallback".
   - The proxy escalates last, as in dev.87, and the notice now also says to check the binding.
   - Only once a notice about that session has been published and its read-back verified does the forward go to a fallback thread. Since the review of 44a3127 that happens in the same run (`--escalated` lists it under `resend`; the proxy reads the item again and runs `--resend`), and the forward's age no longer allows a fallback by itself.
   - A fallback is recorded in three places:
     - The message: the headline starts "Re-sent as a fallback", and a third line, after the provenance line, says "Fallback: you are not the bound orchestrator session. The bound session is X; the proxy could not reach it (N failed send(s), last error …) [and has told the operator in a notice], so this came to you instead."
     - The log: the `retry` line and the `sent` line carry `fallback: true` and `boundSession`.
     - The read commands: `--forwards`, `--verify` and `--counts` (`fallbacks`) show it.
3. **A fresh read comes before any re-send of an attention forward.** This covers a forward about an open item (`needsRead`: an `inbox.attention` forward with an inbox ID, other than a presentation end).
   - **Re-sends in a run.** A run offers such a re-send only when the run read the open items. A webhook run's narrow read has `openItems`; a timer run reads `status --compact`; a digest run now reads it too (`--digest --state <compact read>`). The run's read has already closed the forwards whose item moved on.
   - **Sends after a failure, including same-run fallbacks.** Every step that sends such a forward names `reread` (`--inbox <inboxId>`). After a failed send the proxy reads the item again and passes the read: `--send-failed … --state <read>`.
     - If the item is no longer open, or is open at a newer version, the forward is closed as `obsolete`: `closed` is printed, `next` is null, and the forward is never sent or escalated.
     - Without the read, the failure is recorded but the forward is not sent again in that run. The output says why, and a later run reads and sends it.

   Resolution forwards (an answer, an expiry, a withdrawal), state-event forwards and notice forwards report something already closed, so they need no read and are sent as before.

**The trial's scenario, as it now runs.**
- A notice acknowledged between two failed sends is closed as `obsolete` by the re-read before the second send, and is never delivered.
- A forward whose bound session fails twice is escalated, with the binding named.
- The next run tries the bound session again. When that fails too, the forward goes to the live thread, saying it is a fallback.

**What this costs.** For a wrong binding with a working orchestrator thread, a forward used to arrive in seconds. Now it arrives in the same run after two failed sends, an escalation with its read-back, and a fresh read of the item: tens of seconds more. The operator hears of the broken binding at once instead of never.

### Tests

- "L2 repro": the operator acknowledges the notice between the two failed sends. The re-read closes the forward as obsolete, nothing is offered to the live thread, and no escalation is due.
- "L2: when the bound session is down…": in order, two failures, `escalateDue` naming the binding, then the notice (escalation is reachable). Then the timer run's re-send to the bound session, the fallback to the live thread with its message lines, the log's `fallback` and `boundSession`, and `--sent`, `--forwards`, `--verify` and `--counts`.
- "L2: an attention forward is never sent again without a fresh read…": `--send-failed` without a read, a digest run without and with the compact read, and a resolution forward that needs no read.
- "K5 and L2" (replaces the dev.87 K5 fallback test) and "J7 (dev.88)" (replaces the J7 "falls back to the last bound session seen" test): a forward decided for the configured thread, sent after a session was bound, goes to the bound session after one failure, and that is not a fallback.

## L1: a forward sent outside its `send` object

### What happened

After the first failed send of `j7r2-a`, the proxy model (Claude Haiku 5.5) did not send `next.send`. It sent the forward to "the configured orchestrator" instead. `--sent --to <that thread>` was refused ("was never handed out for thread …"), so the forward was delivered but logged as unconfirmed, and the next run delivered it again. The brief said nothing about a refused `--sent`.

### Fix

> **Superseded in part.** Accepting a confirmation for a known orchestrator thread (`offTarget`) was removed with the fallback; see "Decision: no thread fallback". The exact refusal message, the misdirected `--send-failed` and the brief's rules stand.

- **`--sent` accepts an orchestrator thread the proxy knows** (`knownThreads`): the bound session last seen, the thread the forward was decided for, the last thread a send reached, the configured thread (`--forward-to`, which the `TRIAGE` shorthand always passes), and every thread the send ID was handed out for.
  - Such a thread received the forward. It is confirmed there and never sent again.
  - The `sent` line says `offTarget: true`, plus `fallback: true` and `boundSession` when that thread is not the bound session. `--counts` counts `offTarget`.
  - The output says "… is an orchestrator thread this proxy knows, so the forward is recorded as delivered there and is not sent again".
- **Any other thread is still refused**, so the dev.87 review's protections hold: a late or forged confirmation never clears a thread's failures or redirects fallbacks. The refusal now says exactly what to do, and never to send again: "Do not send it again. If you sent the send object as printed, run `--sent <id> --to <the threadId of that send object>`. If you sent it to X, the orchestrator did not get it: run `--send-failed <id> --to X --error '…'` and follow its next."
- **`--send-failed --to` a thread the send ID was not handed out for** is recorded as a misdirected send (`misdirected` on the log line and the output). It charges no thread with a failure and plans the next send normally.
- **The brief** ("What you may and may not do", and "Sending a forward" steps 1 to 3):
  - "You send a forward only to the `threadId` of the `send` object … never to the orchestrator thread named in this brief, or any other thread you think is right, instead. Choosing the thread is the script's job."
  - Step 1 repeats it.
  - Step 2: "If `--sent` is refused (it exits 1), never send the forward again: do exactly what its message says."
  - Step 3: when `next.escalateDue` is set, "do not look for another thread yourself".

**Tests.** "L1 repro": the trial's sequence through the command line. The off-target confirmation is accepted and marked; the timer run that follows re-sends nothing; and nothing is listed as unconfirmed. Then a stranger thread is refused with the exact instructions, and the misdirected `--send-failed` charges no thread. The existing refusal tests ("review P2-2", "re-check P2-2") still pass, and one now also checks the new wording.

## L3: whose forwards the orchestrator may close

### What happened

In the dev.87 trial the resume procedure sent a thread that was not the bound session to "After binding". That step's follow-up said to handle and close (`--missed --kind undelivered --ref`) every forward still listed by `--forwards --unconfirmed`. The list held three kinds of forward that were not this thread's to close:
- forwards decided for another session;
- a forward whose send was in progress;
- the L1 forward, which had been delivered.

The woken timer run also started two minutes after `run_scheduled_task_now` returned, behind queued webhook runs. And the guide said nothing about a thread that receives forwards while not bound.

### Fix

**In the script.**
- `--forwards --unconfirmed` rows gain three fields:
  - `addressedTo`: the thread of the latest send (the last retry's, else the one decided for);
  - `lastTriedAt`;
  - `inProgress`: the last send is under two minutes old, the same grace a run waits before re-sending.
- `--for <threadId>` lists only the forwards addressed to that thread.
- `--missed --kind undelivered --ref <id>` now needs `--for <threadId>`, and the script itself checks the forward against the log. It refuses a forward that is:
  - not unconfirmed;
  - addressed to another thread ("leave it to the proxy, which sends it to the bound session and tells the operator if it stays undelivered");
  - still in progress ("Check again in two minutes").
- A new `--missed --kind received --ref <id> --for <threadId>` records a forward that reached this thread although the proxy lists it unconfirmed (the L1 case, from the orchestrator's side). It is not checked against the addressee, since the forward may have arrived off target. It closes the forward (`handled`, "recorded it as received") and is counted as `received`.
- Both kinds close the forward at the proxy's next run. The log line carries `by` and `closes`.

**In the handling guide.**
- A new bullet, "Unconfirmed forwards addressed to this thread", is used only when this thread is the bound session. It lists with `--for <this thread id>`, skips entries with `inProgress: true`, and checks this thread for the message by its send ID before choosing `received` or `undelivered`.
- "Check the count on every forward" points to it, and the unscoped "each listed forward … never reached this thread" is gone.
- **"After binding"** is only for a thread that has just bound itself and is the bound session. It notes that the woken run may start minutes later and that the call's result only says it started. The follow-up check comes about five minutes later and is the scoped bullet above. A forward still addressed to another thread is left to the proxy.
- **Resume step 1:** if `.orchestratorSession.sessionId` is not this thread, tell the operator which session is bound, ask whether to bind this thread, and skip step 3 until it is the bound session.
- **A new bullet, "A forward sent to you as a fallback":**
  - read who is bound;
  - if it is now this thread, handle the forward as usual;
  - if this thread handed off to a bound successor, send the forward on unchanged;
  - otherwise handle it, tell the operator in one line that the bound session could not be reached, and ask whether to bind this thread, without binding on its own.

**In the integration guide.** The rebind bullet describes the scoped check.

**Tests.** "L3" covers:
- the `--for` lists for the two sessions, and `inProgress`;
- the three refusals (no `--for`, another addressee, in progress);
- a successful `undelivered` and a `received` for a forward addressed elsewhere;
- the next run closing both as `handled`.

"L1 to L3" checks the guides' new text and that the unscoped instruction is gone.

## L4: no status read showed an `upkeepRun`

`status --flow <id>` (and `--inbox` or `--task` when the read reaches a flow) now has `upkeepRun`: the record keyed by that flow's ID, as stored. Its fields are status, outcome, reason, stage, flags, counts, merge commit and deadlines.
- An upkeep assessment flow shows the run of the flow it assesses (its job payload names that flow).
- Without a run, `upkeepRun` is `null`.
- It is one `store.get` by primary key. No kind is scanned, and no SQL reads `records.data`.

`status --help` and `docs/running.md` say so. This sits in the narrow read, outside the knowledge-upkeep files that slice 4 changes.

**Test.** "L4" covers:
- the record for the merged flow;
- another flow's record never appearing;
- the assessment flow;
- `null` for a task read and for a flow without a run;
- the command line output and the help text.

## L5: doctor's progress on stdout

**Not reproduced; no code change.** The CLI's `doctor` writes every progress line with `console.error` (`cli.mjs`: `onProgress: (phase, detail) => console.error(doctorProgressLine(phase, detail))`) and prints only its JSON result with `console.log`. That has been so since dev.81's F17 fix of the same kind.
- **Run by hand.** I ran the CLI's doctor on a fictional delivery state, with no provider on `PATH` so nothing could start. Stdout was exactly one JSON document and stderr was empty; that run stopped at the forge qualification before any probe.
- **The other JSON-printing commands.** Every `console.log` in `cli.mjs` is the JSON `print`, `status --compact`'s one line, or a help text. Every progress or waiting line (doctor's, upgrade's "waiting for drain") goes to stderr. In `workflows`, `operations`, `core`, `service` and the adapters, `console.log` appears only in the child script that upgrade's configuration check runs, whose stdout is its JSON answer.
- **Likely cause.** A shell or tool that shows stderr and stdout together. The finding has no captured output to check this against.

**Test.** "L5": the CLI's doctor run on a fictional delivery state with an empty `PATH`. Stdout parses as one JSON document and has no `doctor: [` line. **It passes on the base too**: it pins the contract and does not show a fix.

## L6: Escape closed the whole flow window

**Cause.** The dev.87 K2 panel closes on Escape only while focus is inside it or on its group.
- After a click on the panel's heading text, which cannot take focus, focus moves to the modal or the page.
- Escape then reaches the native `<dialog>`, which closes.
- With focus on the summary, the group's own handler stopped it, which is why that case worked.

**Fix** (`ui/timeline.mjs`). `escapeInnermost` is installed on the document in the capture phase, before the dialog sees the key.
- While a group is open, Escape closes that group's list and returns focus to its summary, wherever focus is in the page or in the window the group is in.
- It stops the event, so the modal stays open, and the next Escape closes the modal.
- A key pressed in another dialog opened over that window is left to that dialog.
- Groups no longer in the page are forgotten.
- The group and panel handlers stay as they were.

**Test.** "L6" renders the real flow detail in a dialog. It checks the listener is on the document in the capture phase. With the list open it presses Escape on the dialog, on the page body and on the panel's heading text: each time the list closes, the event is prevented, and focus returns to the summary. Then:
- with nothing open, Escape goes through;
- a key in another dialog is not taken;
- other keys are ignored.

**Checklist.** A-03 now checks the first Escape with focus on the summary, on a link in the panel, and after a click on the panel's heading or on blank space in the modal.

## L7: Queue's relative times had no UTC tooltip

`ui/admission.mjs` gains `relativeTimeNode`: dev.83's time element, with the relative text and `title` "<ISO> (UTC as recorded)". `chip` takes a list of text and nodes as its label. Queue uses it for:
- "Started … ago" on every entry of "Started from the queue" (the 20 chips of the finding);
- a parked flow's "since …" under "Flow slots";
- "Last dispatch …" and "Dispatch requested …" with automatic admission off.

**Test.** "L7" renders the Queue view. Each "Started" chip, the parked line and the last-dispatch line have a `time` element with the recorded value as tooltip.

**Checklist.** A-05 lists these times.

## Fail-before

The two changed test files were copied into an export of the base `9351f16` (`git archive`) and run there.
- **As they are: 69 tests, 30 fail, 39 pass.** Many fail only because the test helpers pass `--protocol 88`, which the base script refuses.
- **With the helpers' protocol set back to 87: 15 fail, 54 pass.** Every new L test fails on its defect, except L5:

| Test | Fails on the base with |
| --- | --- |
| L1 repro | the refusal "was never handed out for thread" |
| L2 repro | no `reread` on the step; with that line removed, "nothing is sent: in dev.87 the same run delivered it to the last thread a send reached" |
| L2: bound session down | "no fallback in the same run before the operator is told" |
| L2: fresh read | a send offered with no read |
| L3 | the unscoped list |
| L4 | `upkeepRun` missing |
| L6 | no document-level handler |
| L7 | no time element in the chip |
| "K5 and L2", "J7 (dev.88)" | the old fallback |

- **The updated older tests** (protocol 88, `--for`, the guide wording, the counts' new fields) fail on the base's output.
- **L5 passes on the base.**

## Review of 44a3127

> **Superseded in part.** The other-thread fallback this section describes was removed after the third re-check of 0933596; see "Decision: no thread fallback" below. The re-read before every re-send, the escalation of a broken binding and the closing of obsolete forwards stand.

An independent review (GPT-6.1 Sol) of `44a3127` confirmed L2's obsolete handling in the tested paths, L4's read by key, L5 (the real CLI doctor, status and upgrade preparation each print one JSON document) and L6 and L7 in headless Chromium at 320 and 390 px. It requested changes for five P2 findings and one P3, and recommended three more changes, all made here.

### P2-1: an overlapping attempt could escalate after delivery

**Problem.** Each forward of a delivery is its own send attempt. With `d1:1` and `d1:2` pending, confirming `d1:2` left `d1:1` pending, and two failures recorded for it led `--escalate` to publish a notice about a delivery the orchestrator had.

**Fix.** When any attempt of a delivery is confirmed, `--sent` closes the delivery's other pending attempts as `delivered` (a log line, not re-sent, not escalated, not listed as unconfirmed). The delivery keeps `lastSentAt`, and every path that could send or escalate an attempt (`--escalate`, `--send-failed`, `--resend`, and every run's closing pass) first checks whether another attempt of the delivery was confirmed after this one was decided, and closes it if so. A reminder decided after the delivery was confirmed is a new attempt and is still sent. Confirming a closed attempt again is `already-sent`.

### P2-2: a missing read suppressed escalation until the forward expired

**Problem.** A run with no read of the open items skipped an attention forward entirely, so it was neither re-sent nor escalated, and was deleted as `retry-expired` at 24 hours without the operator ever hearing of it.

**Fix.** Such a run sends it nothing but still plans its escalation (`escalateDue`). Past 24 hours a forward is no longer sent, and it is dropped (`retry-expired`, "and the operator was told at …") only once a verified notice covers it.

### P2-3: the ten-minute age bypassed "fallback only after escalation"

**Problem.** A forward over ten minutes old was offered a fallback after two bound-session failures with no escalation recorded; if that send succeeded, `--escalate` returned null and the operator never heard of the broken binding.

**Fix.** A fallback is offered only when a notice about that forward, or about its unreachable session, has been published and its read-back recorded by `--escalated` (`toldAbout`). An offered notice is not enough, and age is not either.

### P2-4: a confirmation could make its own thread known

**Problem.** `--sent <id> --to X --forward-to X` was accepted as off target: the known threads included the confirming command's own `--forward-to`.

**Fix.** The configured thread is recorded with the forward when it is first planned (`configured` on the pending row). `--sent` no longer reads `--forward-to`; only the recorded one counts as known. Fallback planning prefers the recorded one too.

### P2-5: `received` reopened the cross-thread closure hole

**Problem.** `--missed --kind received --ref <id> --for X` closed a forward addressed to the bound session for any X.

**Fix.** `--forwards --unconfirmed` rows carry `handedTo`, every thread the forward was decided or re-sent for. `received` requires `--for` to be one of them ("was never sent to X …, so it cannot have reached it"); `undelivered` keeps requiring the thread it is addressed to now.

### P3: the brief

The paragraph after "Sending a forward" said a digest run reads nothing and closes nothing; it now says the digest run reads `status --compact`, that a forward is also closed when another send of its delivery was confirmed, and its example passes `--for`.

### Recommended by the review

- **Fallback speed.** After the notice's read-back, `--escalated` (and an `--escalate` covered by a published notice) prints `resend`: the covered forwards whose bound session is down and that have a fallback left, each with its `reread`. The proxy reads each item and runs the new `TRIAGE --resend <sendId> --state <read>`, which closes it if the item moved on, or prints the fallback send. The brief's step 4 says so.
- **One notice per unreachable session.** `memory.escalations`, keyed by the bound session, holds the notice offered for it, whether it is verified, and the forwards it covers.
  - The first `--escalate` lists every forward of that session due then ("… and N more forward(s)").
  - Its read-back records `escalatedAt` and the notice ID on each covered forward, and one `escalated` log line naming them in `covers`.
  - A later forward of the session is covered at its own `--escalate` (`coveredBy`, an `escalation-covered` line), with no new notice.
  - A confirmed send to the session ends the outage; the next outage gets a new notice. A notice is reported moot once every forward it covers is confirmed or closed, or at once if that happened before its read-back.
  - `--counts` counts notices.
- **Counts.**
  - **"Absorbed since the last forward"** is now a ledger (`memory.absorbed`): each absorbed delivery is claimed by the delivery forward that reports it, dropped when that forward is confirmed or recorded as received, and released if that forward is closed without arriving. So a forward that was never confirmed and the next one no longer report the same delivery (the trial's gap 7). A dev.87 counter is carried over once.
  - **The session of a count.** Factotum's payload now carries `sessionVersion`, the session the count was taken for (`claimSessionSendInTransaction`). A forward says `session delivery 7/100 (session 10)`, or "(counted for session 10; the bound session is now 11, so this count is not part of its count)" when the read shows another session (the trial's gap 14), or "(session not named: this webhook prompt does not pass sessionVersion)". Both webhook prompts in the guides pass it; the handling guide compares counts within one session only.

### Tests

`tests/triage-proxy.test.mjs`:
- **New.** One test per P2 and for the P3, using the review's repros: "review P2-1 of 44a3127" (also a state from before the fix), "P2-2" (runs without a read at 11 minutes and 25 hours), "P2-3 … and fallback speed" (no fallback at 11 minutes before the read-back, none on an offered notice, the same-run `--resend`, and an item that moved on), "P2-4", "P2-5", "P3". Also "one operator notice per unreachable session", and the two count tests.
- **Updated.**
  - The dev.85 attempt tests: the other attempt is closed as delivered.
  - The K1 repro: one notice for two forwards, moot once both are delivered, and the late publish.
  - K1 obsolete: the moot line names the last of the covered forwards.
  - Review P2-2 of 55fccf4 and P2-3 of 9a3bae4: the verified notice before the fallback, `covers` and `resend`.
  - L2 and L3: the new wording, and `received` needing a thread the forward was sent to.
  - The rendered prompt fields now include `sessionVersion`.

**Fail-before.** The test file was run on an export of `44a3127`: 74 tests, **17 fail, 57 pass**. Every new test fails on its own defect (P2-1 "Missing expected exception", P2-3 "eleven minutes old, and still no fallback", P2-4 "dev.88 first version accepted it as off target", the absorbed count "dev.87 said 1 here too", the session "the payload names the session it was counted for", and so on). The updated tests fail on the old output.

## Re-check of c95fdde

> **Superseded in part.** The other-thread fallback this section describes was removed after the third re-check of 0933596; see "Decision: no thread fallback" below. The re-read before every re-send, the escalation of a broken binding and the closing of obsolete forwards stand.

The GPT-6.1 Sol re-check passed the five earlier P2 repros, the P3 and the earlier regressions, and confirmed the docs, the "Action needed" and that `sessionVersion` is additive. It found two new P2s and one P3.

### P2-1: `--resend` could add an unknown fallback

**Problem.** `planSend` replaced a forward's recorded `configured: null` with the current command's `--forward-to`. A forward planned with a bound session and no configured thread, whose bound session failed twice and whose notice was verified, was sent by `--resend … --forward-to never-verified` to that thread.

**Fix.** `planSend` takes no configured thread from its caller: it uses only `row.configured`, as recorded when the forward was planned, and a recorded null stays null. `--escalate` and `--resend` do the same. No command adds a destination after planning.

### P2-2: a notice for session A authorized a fallback after session B failed

**Problem.** Any `row.escalatedAt` counted as "the operator was told". After A failed twice and its notice was verified, the operator rebound to B; when B failed twice too, the forward went to a fallback (`fallback: true`), with no escalation for B (`escalateDue: null`), and its message said the operator had been told, which was about A.

**Fix.** Coverage is recorded per session: `row.escalatedFor` maps a session to the verified notice covering the forward for it.
- A fallback needs a verified notice for the bound session that failed (`toldAbout`).
- `escalateDue` and `--escalate` look only at that session's coverage, so B's failures give B its own notice, covering the forward for B.
- A forward covered before the map existed counts for the session its notice was offered for.
- A forward's moot notices are reported per notice: once the forward is delivered, A's and B's notices are both moot.

### P3: judging a forward absorbed stranded its count claims

**Problem.** `--judged-absorb` deleted the delivery's pending forwards without releasing what they had claimed in the absorbed ledger. The next forward then said 1 where 2 deliveries had been absorbed since the last forward that arrived.

**Fix.** It releases each forward's claims before deleting it.

### Tests

`tests/triage-proxy.test.mjs`:
- **New.** One test per finding, each the re-check's repro:
  - "re-check P2-1 of c95fdde" (through the command line);
  - "re-check P2-2 of c95fdde" (A's notice, rebind to B, B's failures, B's own notice, then the fallback naming B, two notices counted, both moot once delivered);
  - "re-check P3 of c95fdde" (an absorbed delivery, an unsure forward claiming it, `--judged-absorb`, then 2).
- **Updated.** "review P2-2" of 55fccf4 records its fallback thread B when the forward is planned, since a later command can no longer add it.

**Fail-before.** The test file was run on an export of `c95fdde`: 77 tests, **3 fail, 74 pass**. The three new tests fail on the defects: "no send to a thread nobody planned: \"never-verified\"", "A's notice does not allow a fallback after B fails", and "the earlier absorbed delivery and the judged one (c95fdde: 1)".

## Second re-check of bc8a93d

> **Superseded in part.** The other-thread fallback this section describes was removed after the third re-check of 0933596; see "Decision: no thread fallback" below. The re-read before every re-send, the escalation of a broken binding and the closing of obsolete forwards stand.

The second GPT-6.1 Sol re-check confirmed the three c95fdde repros, every earlier triage regression, repeated distinct rebinds, unverified notices on current-format rows and absent sessions. It found two P2s.

### P2-1: coverage inferred from other fields allowed a fallback before B's notice was verified

**Problem.** `coveredFor` inferred coverage for a row without `escalatedFor` from `escalatedAt` and `escalationGroup` (else `decidedFor`). Offering B's notice sets `escalationGroup`, so for such a row merely offering it made `--resend` return a fallback. The re-check's repro used a row in the c95fdde format, which was never released. The shipped format is dev.87's: a forward escalated under dev.87 has `escalatedAt` and its own notice, but no session and no group. Under bc8a93d such a row counted as covered for the thread it was decided for, so it got a fallback with no notice about this outage.

**Fix: an invariant, not a migration.** Coverage is only ever written by `markCovered`, which runs only after a verified read-back (`--escalated`, or `--escalate` joining a notice already verified). `coveredFor` reads `row.escalatedFor` and nothing else, and offering a notice never touches it. A dev.87 row therefore has no session coverage: its `escalatedAt` still says the operator was told about the forward (it can expire), but a fallback needs the current session's own verified notice. No migration code was added.

### P2-2: recovery and a reused session ID kept stale outage coverage

**Problem.** After forward F failed twice to A and its notice was verified, a confirmed send of another delivery to A ended A's outage, but F kept its failure counts and coverage for A. After binding B and then A again, F's next failure to A gave an immediate fallback, and `--escalate` cited the old notice.

**Fix: outage episodes** (`endEpisode`, `observeSession`). Coverage and failure counts belong to an episode of their session. An episode ends:
- when any send to the session is confirmed (`--sent`, for any forward). Every pending forward's `failedBy` and `escalatedFor` for it are cleared, along with its failures across forwards (`failedThreads`) and its notice. A notice offered and not yet verified is kept (ended), so its late read-back is still reported moot.
- when a rebind to a different session is observed, for the session bound after it. Every read records the bound session's version (`mainSessionVersion`, from `project.session` or `orchestratorSession`); a new version, or another thread when the read has no version, starts the new session's episode the same way. This catches A, then B, then A again even when no proxy run read B's binding.

The next failure there is a new outage: the bound session once more, then its own notice, and no fallback until that notice is verified.

### Tests

`tests/triage-proxy.test.mjs`, all new:
- "second re-check P2-1 of bc8a93d": a pending row rewritten to the dev.87 format (failed twice, its own notice verified, no session, group or coverage map) gets no fallback while still bound to its decided session. After a rebind to B and two failures, B's notice is offered, and coverage stays empty with no fallback until that notice's read-back. Then the fallback names B.
- "second re-check P2-2 of bc8a93d" (three tests):
  - the repro (recovery, B, then A again);
  - a session reused after recovery with no rebind;
  - a rebind B then A with no confirmed send, starting A's new episode.

**Fail-before.** The test file was run on an export of `bc8a93d`: 81 tests, **4 fail, 77 pass**. The new tests fail on the defects: "no fallback on a dev.87 escalation", "the bound session once more, not an immediate fallback (bc8a93d: fallback)" (twice), and the rebind episode left in place.

## Third re-check of 0933596, and the decision: no thread fallback

The third GPT-6.1 Sol re-check found three more P2s, all in the fallback state machine:
- **Late verification.** A notice verified after its outage ended restored coverage: `markEscalated` ignored the outage's end.
- **Expiry.** Expiry dropped a forward whose current outage was never reported: it read the historical `escalatedAt`.
- **Stale reads.** An older, overlapping read rewound `mainSessionVersion`, which cleared the newer outage.

### Decision: no thread fallback

The operator decided to drop thread fallback entirely. The proxy now sends only to the bound session.

**Why.** Sending a forward to another orchestrator thread when the bound session could not be reached was introduced in dev.87 (K5) and redesigned here for L2. Four review rounds of this release each found another way for it to deliver where nobody had agreed, or to claim the operator had been told when they had not:
- a confirmation that made its own thread known;
- a later command adding a destination;
- a notice about one session authorising a fallback after another failed;
- inferred and stale coverage;
- and now late verification, expiry and stale reads.

Each fix added state, and the state had to stay right across rebinds, recoveries and overlapping runs. The benefit was a faster delivery when an operator had bound the wrong thread. The cost was that the proxy could decide on its own that some other thread should handle the project's notifications. A wrong binding is the operator's to fix. The proxy's job is to make sure the operator hears of it, which escalation does.

**What was removed** from `triage.example.mjs` (against `0933596`: 334 lines removed and 270 added, many of them rewritten; net 64 lines and about 8 KB shorter):
- other-thread fallbacks: `fallbacksOf`, `usable`, `toldAbout`, the fallback branch of `planSend`, the fallback text of re-sends ("Re-sent as a fallback", the "Fallback:" line), and `fallbackTo`;
- `--resend` (`resendNow`, `resendList`) and the `resend` lists of `--escalate` and `--escalated`;
- `lastConfirmedThread` as a destination, and the field itself;
- `offTarget` confirmations (`knownThreads`): a confirmation is credited only to a thread the send was handed out for;
- per-session coverage (`escalatedFor`, `markCovered`, `coveredFor`), episodes (`endEpisode`) and `memory.escalations`;
- the `fallback`, `boundSession` and `offTarget` log fields, and the `fallbacks` and `offTarget` counts.

The brief, the handling guide (its section "A forward sent to you as a fallback" is gone) and `docs/integrations/t3.md` say instead that a broken binding waits for the operator or a rebind.

### The model now

1. **One destination.** A send goes to the orchestrator session bound now (the latest read; a rebind changes the destination of every later send), else to the configured thread recorded when the forward was planned (no session bound yet). No command adds a destination.
2. **On failure.**
   - The destination is retried, once more at once, then by every later run, with the re-send rotation as before.
   - The item is read again before every send, and the forward is closed as obsolete if its item has moved on.
   - Once the destination is down for the forward (two failures, or one after two other forwards failed there), or the forward is ten minutes old, it is escalated.
3. **Outages** (`memory.outages`, keyed by destination).
   - An outage starts the first time a forward to its destination is due for escalation. It ends when a send there is confirmed, or when the binding moves; the session bound after a rebind starts afresh.
   - Each outage has a unique ID and one notice. The notice is offered once, verified by read-back, and lists the forwards due. Later forwards in the same outage are covered by it without a new notice.
   - Coverage is a forward's `toldIn`, the outage ID. Only a verified read-back writes it, and it lapses with its outage. Ending an outage clears every forward's failure counts there.
   - A published notice is reported moot once, by the next delivery forward, when its outage ends. The proxy still withdraws nothing.
4. **The three repros, now safe.**
   - **Late verification:** a notice offered for an outage that ended before its read-back is kept aside (`endedNotices`). Its read-back covers nothing and reports it moot, and a new failure is a new outage with its own notice.
   - **Expiry:** a forward past 24 hours is dropped only when its current outage's verified notice covers it.
   - **Stale reads:** session versions are compared by number. A read with an older version changes neither the binding nor any outage, and its run's forward goes to the newest bound session.
   - The stale-read test also exposed a related hole, now closed: a read older than the one a forward was decided from could close that forward as obsolete, because its item did not exist yet in that read. Each forward keeps the project revision of its read (`readRevision`), and an older read closes nothing.
5. **Kept, as reviewed:**
   - per-attempt reconciliation (P2-1 of 44a3127);
   - the escalation of a forward no run could read;
   - `--for` scoping of `--missed`, and `received` needing a thread the forward was sent to;
   - the count fixes and `sessionVersion`;
   - `--to` validation;
   - the protocol check (88);
   - L4 to L7.

### Tests

`tests/triage-proxy.test.mjs`:
- **New** (the three repros, made safe):
  - "late verification": the late read-back covers nothing, a new failure is due again with a new notice, and the old one is reported moot;
  - "expiry": the forward is not dropped at 25 hours while its new outage is unreported, and is dropped once that outage's notice is verified;
  - "stale reads": the older read keeps the newer version, binding and outage, its forward goes to B, and F stays covered.
- **Rewritten for the single destination.** Each now asserts that nothing goes to another thread:
  - K5 (a destination that failed other forwards);
  - L1 (an off-target `--sent` is refused with the exact instructions, and the misdirected record re-sends to the bound session);
  - L2 (the bound session down: escalation, no fallback, re-sends to it, then a rebind delivers and the old notice is moot);
  - review P2-2 of 55fccf4 (a confirmation after a rebind);
  - P2-3 and P2-4 of 44a3127 (no fallback even after a verified notice; `--resend` gone; off-target refused);
  - one notice per outage;
  - re-check P2-1 and P2-2 of c95fdde (no command adds a destination; after A to B, B's failures get their own notice and A's notice is moot);
  - second re-check P2-1 of bc8a93d (a dev.87 row is covered for no outage now, offering covers nothing, and the read-back does);
  - the recovery and rebind tests.
- **Updated for moot-on-outage-end:** the K1 tests.
- **Removed:** the fallback assertions and `lastConfirmedThread`.
- The guide test checks that no guide describes a fallback path.

**Fail-before.** The three new tests were run on an export of `0933596`: **3 fail**. The late read-back covers F, F is dropped as expired, and the stale read redirects the forward.

## Review of 615f5a5

The GPT-6.1 Sol review of `615f5a5` confirmed the three repros of 0933596 and every earlier regression. It found two P2s and one P3, all about the promises "one destination" and "never dropped unseen".

### P2-1: error paths sent to the retired configured thread

**Problem.** When a run could not complete (for example a lock timeout after 30 seconds), the command line's error path addressed its message with `forwardTarget(null, {}, --forward-to)`, ignoring the state file. With bound session B recorded and `--forward-to A`, the message went to A, a thread the binding had replaced. The protocol-mismatch path read the state file, but fell back to `--forward-to` when it could not; and a run whose state file was unreadable (reset) used `--forward-to` for any forward its own read gave no session for.

**Fix.** `knownTarget(memoryPath, configured)` reads the state file without the lock (it is only ever replaced whole) and returns the newest bound session the proxy knows, else the configured thread when it has never seen one, and no thread when the file exists but cannot be read. The run-failure and protocol-mismatch paths use it; with no thread the message's `send` is null, stderr says so, and the next run that can read the state file sends and escalates what is pending. A run that reset an unreadable state file ignores `--forward-to` (its forwards go to a session its own read shows, else nowhere, and are escalated). Audit of the other error paths:
- `decide`'s own catch, the invalid-payload forward and the timer's unreadable-view forward all run inside the lock with the loaded state, so they already used the known binding.
- The CLI's final catch only writes to stderr.

### P2-2: the cap on pending attempts dropped unreported forwards

**Problem.** Over 500 pending delivery forwards, the oldest were deleted, whatever they were. A forward left unconfirmed, followed by 500 more before its re-send grace ended, disappeared from the state file; `--escalate` then returned null, and nobody was ever told.

**Fix.** A forward leaves the state only when it is delivered or closed, or when the operator was told of its current outage by a verified notice (`MAX_PENDING_SENDS` 500, `MAX_UNREPORTED_SENDS` 2000):
- Over 500, `boundPending` evicts only forwards covered by their current outage's verified notice, oldest first, logging each. If that is not enough, `memory.overflow` is set, and every unreported forward is due for escalation at once ("the proxy holds N unconfirmed forwards, more than its limit of 500 …"). The usual grouping makes that one notice per destination.
- At 2000 forwards nobody has been told about, the run refuses to record a new one: it throws, nothing in the state file changes, and the command line prints the error as a `triage-error` forward (to the known binding, P2-1). The delivery stays unacknowledged in Factotum.
- So the state file stays bounded (2000 unreported, plus covered ones down to 500), and no forward is dropped before the operator has been told.

### P3: a new outage hid a late read-back of the previous outage's notice

**Problem.** F's notice N1 was published; that outage ended; F failed again and notice N2 was offered; then N1's read-back arrived. `--escalated` looked the outage up by F's send ID, found the current one (N2), reported N2 missing, and never announced N1 as moot.

**Fix.** `--escalated` matches the read-back's notice ID first, to a current outage or an ended one, and falls back to the send ID only when no notice matches (a notice not found at all). N1's read-back now covers nothing and is reported moot, and N2 stays offered until its own read-back.

### Docs

- The brief: a `triage-error` forward is sent like any other, goes to the known binding, and with `send` null the proxy stops and leaves it to the next run. The 500 and 2000 limits and what happens at each.
- The handling guide: every forward is kept until delivered, closed or reported; an error message is not re-sent.
- The integration guide: a new bullet saying exactly when a forward may leave the state, and one on the error paths.

### Tests

`tests/triage-proxy.test.mjs`, all new, each the review's repro:
- "review P2-1 of 615f5a5": a run that cannot write its state file (as with a lock timeout), called with a retired `--forward-to`, sends its error to the recorded session. An unreadable state file gives no destination (`knownTarget`, and the protocol mismatch through the command line, with the stderr line). A reset run uses no configured thread. A proxy that never saw a session still uses its configured thread.
- "review P2-2 of 615f5a5":
  - the repro at the real limit (F and 500 more forwards within its grace): F is kept, and `--escalate F` offers one notice naming the overflow;
  - with small limits: only forwards covered by a verified notice are evicted, oldest first;
  - at the hard limit a new forward is refused with the error, and the state file is unchanged.
- "review P3 of 615f5a5": N1's late read-back covers nothing and announces N1 as moot; N2's own read-back still covers F.

**Fail-before.** The three tests were run on an export of `615f5a5`: **3 fail**, on "the retired configured thread", "F is kept (615f5a5: evicted)" and "N2 reported missing".

## Re-check of b693894: one rule for every error path

The GPT-6.1 Sol re-check of `b693894` confirmed the three 615f5a5 fixes and every earlier regression. It found three P2s, all in error paths, and asked for one simple rule instead of more state.

**The rule.** Whenever the proxy cannot handle a delivery or a run, the script publishes an operator notice itself:
- **How:** through Factotum's CLI. It runs `command --operation inbox.publish` as the orchestrator role, then `status --inbox` to read the notice back. It uses `--factory-state` (the brief's `TRIAGE` now passes `--factory-state [[state-dir]]`) and the installation's `factory/cli.mjs`, two levels up from the script.
- **No dependency on the proxy's state file:** this path never reads or writes it. The Inbox is the durable channel.
- **When:** a run that fails (a lock timeout, a state file that cannot be read, set aside or written), a delivery refused at the limit, and a protocol mismatch.
- **ID:** from the delivery ID (`triage-failed-<12 hex>`, or `triage-protocol-<12 hex>` for a protocol mismatch). For a timer or digest run, from the run and the UTC date and hour (`triage-failed-timer-<date>T<hour>`). Repeated failures publish it once.
- **Read-back:** it must show a notice by the orchestrator role with the expected title. Another item under that ID makes it publish under a new ID.
- **The floor:** if even `inbox.publish` fails, or `--factory-state` is missing, the command prints the reason to stderr and exits nonzero.

The run still prints its `triage-error` or `protocol-mismatch` message, now with `operatorNotice: {id, published}`. That message is not tracked, but it is no longer the only record of an undelivered notification.

### P2-1: refusing at 2000 could lose a notice forward permanently

**Problem.** Factotum marks a notice delivery `delivered` and never reminds it (`operations/notifications.mjs`). A notice delivery refused at the 2000 limit was therefore never sent again: the error forward was its only trace, and it was untracked.

**Fix.** The refusal publishes an operator notice naming the refused delivery: its ID, its item, and why. The no-loss claim in `docs/integrations/t3.md` now says exactly this.

### P2-2: persistent unreadability suppressed forwards with no escalation

**Problem.** With the state file at mode 000 and its directory at 0500, the state could be neither read nor set aside. Every run failed with no destination, and only stderr knew.

**Fix.** The run's failure publishes an operator notice naming the error and the delivery (or "timer run of <hour>:00 UTC"), and stops. Repeated runs for the same delivery or hour find the same notice.

### P2-3: a reset suppressed the retired configured destination for one run only

**Problem.** The run that reset an unreadable state file ignored `--forward-to`, but the next run fell back to it again with the fresh, empty state.

**Fix.** The reset writes a marker, `bindingLost`, into the new state file. While it is there, nothing falls back to `--forward-to`: not `forwardTarget`, not a forward's recorded configured thread, and not the error paths' `knownTarget`. The first run that reads a binding clears it.

### Docs

- The brief: `TRIAGE` passes `--factory-state`. A `triage-error` or `protocol-mismatch` means the notice is already published; send the message if it has a destination, and stop. If the command says it could not publish the notice, reply with that and stop.
- The handling guide: an error message comes with a `triage-failed-` or `triage-protocol-` notice.
- The integration guide:
  - "What never dropped means exactly" now says that a refusal publishes a notice;
  - a new bullet states the rule, its IDs, its read-back and the floor;
  - the old "error forwards are not tracked" limit is restated with the notice.
- The integration guide also had a "never confirmed" bullet split by the last round's insertion; its tail is back in place.
- `--help` names `--factory-state` and `--factory-cli`.

### Tests

`tests/triage-proxy.test.mjs`, all new:
- "re-check P2-1 of b693894": a state file at the limit, then a notice delivery through the command line. The operator notice is published in the sandbox project, by the orchestrator role, naming the delivery and its item, and a second refusal publishes nothing new.
- "re-check P2-2 of b693894": the repro (state file mode 000, directory mode 0500) for a wake and for a timer run (the hour's ID). The floor: a missing Factotum state directory gives stderr and exit 1. A protocol mismatch publishes its notice.
- "re-check P2-3 of b693894": a reset, then a second run, both with no destination; `knownTarget` agrees; a run that reads the binding clears the marker.
- A guide test for the rule, the floor and the corrected claim.

**Fail-before.** The three repro tests were run on an export of `b693894`: **3 fail**, on "no notice", "only stderr" and, for the second run after a reset, "the retired thread".

## Re-check of 338c3dd: the notice path, and the threat model

The GPT-6.1 Sol re-check of `338c3dd` confirmed the three b693894 repros and every earlier regression. It found three P2s and one P3 in the new notice path. The operator decided to fix these four, state the threat model, and treat anything a final re-check finds outside it as a documented follow-up.

### Threat model

Stated in `docs/integrations/t3.md` ("Threat model"):
- **Trusted:** publishers with the orchestrator role, and anyone who can write the proxy's state file or log, or act through the operator's account. They already hold the proxy's authority.
- **Untrusted:** webhook payload content.

Under this model the planted-notice findings (P2-2, P2-3, and the role check in P2-1) are defence in depth, fixed cheaply.

### P2-1: an error notice could start an endless webhook chain

**Problem.** At `notifications.level: "all"`, the error notice the proxy published produced a webhook. If that run failed too, it published another notice, and so on.

**Fix.** A delivery whose item has one of the proxy's own prefixes (`triage-undelivered-`, `triage-failed-`, `triage-protocol-`) is never the subject of an error notice. The item must also have been published by the orchestrator role per the run's narrow read; when the run read nothing, the prefix alone counts. Such a delivery is absorbed instead: the run prints `decision: absorb`, `rule: own-error-notice`, and logs it best effort. (The final re-check below removed the `delivery.ack` action this first version carried.)

### P2-2: the read-back ignored the context

**Fix.** The read-back requires exactly the notice: the orchestrator role, the same title and the same context, as for escalation notices. A notice under the ID with other content counts as a collision (P2-3).

### P2-3: a collision defeated deduplication

**Problem.** On a collision the notice moved to a random ID, which nothing kept, so the next failure published yet another.

**Fix.** A bounded, deterministic sequence: `<id>`, `<id>-2`, `<id>-3`. The first that is free, or that already holds exactly this notice, is used; if all three are held by something else, the floor applies (stderr, exit 1).

For the same failure to give the same notice, its text must be stable:
- the error for a state file that can be neither read nor set aside no longer includes the set-aside file's timestamped name;
- times in any error text are replaced by `<time>`.

### P3: untrusted IDs were stated as facts

**Fix.** The error notice now says "the webhook payload names delivery …, inbox item …" and that these are unverified claims from the webhook payload. Its title says "Triage proxy could not handle a delivery (the webhook payload names <id>)".

### The brief

"What you may and may not do" said the proxy publishes nothing but an `escalate` notice. It now says the proxy publishes nothing itself except the `escalate` notice `TRIAGE --escalate` gives it. The script publishes its own error notices (`operatorNotice`), and the proxy model never publishes one, or anything else.

### Tests

`tests/triage-proxy.test.mjs`:
- **New.**
  - "re-check P2-1 of 338c3dd": level `all` with a failing proxy (the state file can be neither read nor set aside). The first wake publishes one notice. Its own webhook is absorbed with a `delivery.ack` and logged, no second notice is published, and no further generation follows. An item with the prefix published by the operator role is not taken for the proxy's.
  - "re-check P2-2 and P2-3 of 338c3dd":
    - a notice planted under the ID with the same title and another context moves the proxy to `<id>-2`;
    - two more identical failures find it, giving one notice;
    - all three IDs held gives stderr and exit 1.
  - A guide test for the brief's rule and the threat model.
- **Updated.** "re-check P2-1 of b693894" checks the new title and the "unverified claims from the webhook payload" wording (P3). "re-check P2-2 of b693894" checks the new timer title.

**Fail-before.** The three new tests were run on an export of `338c3dd`: **3 fail**.
- The chain test fails on its first-generation check: the failing wake of the notice's own delivery publishes a second notice instead of absorbing it.
- The collision test fails with "the planted notice was taken for the proxy's own (title only)".
- The guide test fails on the brief's old rule.

The updated b693894 test fails there on the old title.

## Results

On `44a3127`: `npm test` 1512 tests, 1512 pass, 0 fail; `npm run eval` exit 0. After the review fixes and the merge of main at `eafd627` (knowledge upkeep slice 4): `npm test` **1561 tests, 1561 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. After the re-check fixes of c95fdde: `npm test` **1564 tests, 1564 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. After the second re-check fixes of bc8a93d: `npm test` **1568 tests, 1568 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. After dropping thread fallback and the merge of main at `c638d3e` (knowledge upkeep slice 5 part A): `npm test` **1595 tests, 1595 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. After the review fixes of 615f5a5: `npm test` **1598 tests, 1598 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. After the re-check fixes of b693894: `npm test` **1602 tests, 1602 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. After the re-check fixes of 338c3dd (main unchanged since `c638d3e`, already merged): `npm test` **1605 tests, 1605 pass, 0 fail** (0 skipped, 0 cancelled); `npm run eval` exit 0. `git diff --check` is clean.

## Action needed (adopters using the triage proxy)

1. **Copy `triage.example.mjs` to `project/integrations/triage.mjs` again.**
   - Forwards go only to the bound session (or the configured thread before any session is bound); there is no fallback to another thread.
   - Steps that send a forward about an open item carry `reread`; `--send-failed` takes `--state <reread>` and may print `closed` instead of `next`.
   - `--sent` credits only a thread the send was handed out for, and no longer reads `--forward-to`.
   - `--digest` takes `--state <status --compact read>`.
   - `--forwards --unconfirmed` has `--for`, `addressedTo`, `handedTo`, `lastTriedAt` and `inProgress`.
   - `--missed --kind undelivered --ref` needs `--for`, and there is a new `--kind received`.
   - `--counts` gains `received`; `escalations` counts notices.
   - One notice per outage of a thread; `--escalated` prints `covers`.
   - Forwards name the session of their count.
   - Every command needs `--protocol 88`, and runs need `--factory-state <Factotum state dir>` to publish an operator notice when they cannot handle a delivery or a run.

   State files and logs from dev.87 and earlier keep working. A forward escalated under dev.87 is escalated again for its current outage if it stays undelivered.
2. **Update the proxy brief** (`project/integrations/t3-triage.md`) from `t3-triage.example.md`:
   - the `TRIAGE` shorthand (`--factory-state [[state-dir]] --protocol 88`) and its last sentences;
   - the paragraph on `triage-error` (the operator notice is already published);
   - "What you may and may not do" (the new first rule about `send.threadId`);
   - webhook run step 3;
   - "Sending a forward", steps 1 to 5 and the paragraph after them;
   - the webhook prompt, which now passes `"sessionVersion":"{{body.sessionVersion}}"`;
   - "A timer run" and "A digest run" (both make a `WAKE`; the digest reads `status --compact`);
   - "The orchestrator side".

   Then update the webhook task's prompt to the new one: `schedule_task` with only `scheduledTaskId` and `prompt` (as setup step 2 says, never `schedule`, `filters`, `enabled` or a signature). Until then forwards say their session is not named, and nothing else changes.

   Copy the brief and the script together. A dev.87 brief passes `--protocol 87`, so every run then only forwards a notice saying the guides must be copied again.
3. **Update the handling guide** (`project/integrations/t3-notifications.md`) from `t3-notifications.example.md`:
   - the `TRIAGE` shorthand (`--protocol 88`);
   - "Taking over as successor" step 5 (the `--forward-to` sentence);
   - in "Forwards from the triage proxy": "Check the count on every forward" (counts per session), the new "Unconfirmed forwards addressed to this thread", "A forward the proxy could not send" (a broken binding waits for the operator), "Forwards the proxy closes without sending", "After binding" and "Record what the proxy got wrong";
   - "Standing down and resuming", resume steps 1 and 3.

   No new placeholder.

## Open questions

- **L5** could not be reproduced (see above); the review confirmed the CLI's stdout is one JSON document. If it shows again, capturing stdout alone (`doctor … 2>/dev/null`) would settle whether it is the CLI or the shell.
- **The webhook prompt without a proxy** (`docs/integrations/t3.md`, "The short prompt") does not show `sessionVersion`. The handling guide's count check is for proxy forwards; adding it there is optional for adopters and was not done.
- **Real-browser checks of the proxy flow.** The redesign was tested against the real notification code and reads, not with a live T3 proxy thread. A re-test of round two (missing session, acknowledgement during the failures, rebind) would show the escalation, the one notice per outage, the wait for a rebind and the moot report live.

## Final re-check of bcc1e21

The reviewer run for this round was stopped by its provider's content filter while it probed own-notice absorption. The main thread therefore checked that path itself and found one in-model defect, which it fixed.

**Problem.** With no narrow read, a webhook payload that pairs a real delivery ID (an operator question's) with an item ID carrying one of the proxy's prefixes was absorbed with a `delivery.ack` for that delivery ID. The payload's IDs are unverified claims, so the acknowledgement could reach another item's delivery.

**Fix.** Absorption never acknowledges anything. It only stops the error notice, and logs `own-error-notice`. The delivery stays unacknowledged.

**Test.** "final re-check of bcc1e21: a payload that pairs a real delivery with a prefixed item ID is never acknowledged". It fails on `bcc1e21`, and the proxy test file passes 95 of 95.
