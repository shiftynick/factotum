# dev.86: a forward the proxy fails to send (J7) and the remaining proxy and T3 guide gaps (J9)

Two findings from the dev.85 readiness re-test, both about the T3 triage proxy: J7 (degraded: a forward the proxy failed to send went quiet, and an operator's merge question went unannounced for 13 minutes) and J9 (docs: the remaining points from orchestrator session 6's 28 notes, and two more it added afterwards). This is a local implementation record, not a release, activation or live qualification claim. No provider, forge or T3 tool was called by the tests.

**Only project-owned starter files and docs changed.** `starter/project/integrations/triage.example.mjs`, `t3-triage.example.md` and `t3-notifications.example.md`, `docs/integrations/t3.md`, and tests. No factory code, workflow graph, operation or console file changed, so no workflow digest changes and no task needs approving again. An adopting project picks this up by copying `triage.example.mjs` again and comparing its two guides with the new templates (see "Adopter notes").

## J7: a forward the proxy fails to send goes quiet

### What happened

At 02:44 the proxy decided to forward an operator merge question (rule `operator-question`, send ID `<deliveryId>:1`, `forwardTo` the bound orchestrator session, full ID). Its model called `t3_thread_send` with the thread ID **without its `mcp:launch:` prefix** and got `thread_not_found` twice. As its brief said, it then confirmed nothing, acknowledged nothing, and wrote the failure in its own thread, which nobody reads. The webhook had already accepted the delivery, so Factotum would re-send it only at the question's first reminder, 30 minutes after acceptance. The orchestrator noticed 13 minutes later, only because the next forward's session count had jumped by two with nothing absorbed. `--forwards` lists confirmed forwards only, so the guide's own listing did not show it.

Worse than the trial showed: **Factotum delivers a notice once.** An attention delivery for a notice has no reminder (`reminderInterval` is null for notices unless the item sets `remind`), so once T3 accepts it, its status becomes `delivered` and it is never sent again. The brief's "it is forwarded again later" and the guide's "Factotum re-sends the delivery" were false for every notice, including failed-flow and maintenance notices.

### Fix (`starter/project/integrations/triage.example.mjs`)

1. **Ready-made send arguments.** Every forward a run prints (its own, each re-send, each `next` after a failure) carries `send`: the `t3_thread_send` arguments `{threadId, message, mode: "queue"}`. The brief says to pass that object as it is, character for character, prefix included, and names `thread_not_found` as what a shortened ID gives.
2. **Re-sending unconfirmed forwards.** Each pending send row now keeps the forward's text, the thread it was decided for, the thread it was last sent to, and its re-sends, failures per thread, last error and escalation. Every run (webhook, timer or digest) prints `retries` before its own decision: each delivery or notice forward still unconfirmed `RETRY_GRACE_SECONDS` (120) after it was decided or last re-sent, oldest first, at most `RETRIES_PER_RUN` (3). Only a delivery's newest attempt is re-sent, and only while that delivery is still a forward (not absorbed since). Each keeps its send ID, so `--sent` still matches, and its headline starts "Re-sent (decided …, not confirmed sent since)"; the provenance line is unchanged. A re-send is logged (`retry`, with where it went), and the `sent` line records the thread it finally reached. After `RETRY_HOURS` (24, the webhook's own delivery age) it is no longer re-sent (`retry-expired`) and stays listed as unconfirmed. Timer findings and digests are not in `retries`: their own runs already produce them again until confirmed.
3. **A failed send has a next step.** `--send-failed <sendId> --error '<error>'` records the failure against the thread it was sent to and prints `next`:
   - the same send again, at once (in the trial the thread was right and the arguments were not);
   - after a thread has failed `FAILURES_PER_THREAD` (2) sends, the next thread in order: the bound session read now, the thread it was decided for, the last bound session the proxy saw (the configured thread only when none of those is known). A fallback to the last-seen session is labelled `forwardSource: "last-seen"`;
   - when no thread is left: no send, and `escalate`.
4. **Escalation, and who sees it.** `escalate` is offered when every known thread has failed twice, when the forward is still unconfirmed `ESCALATE_MINUTES` (10) after it was decided (by any run after that, whatever the re-send budget; review fixes P2-1 and P2-2), or at once when there is no thread to send to. It is an `inbox.publish` of a notice with ID `triage-undelivered-<12 hex of the send ID>-<8 random hex>`, made once and kept with the forward, which the proxy runs with `ACT` (as the orchestrator role, like its `delivery.ack`), then reads back with `status --inbox` and passes to `--escalated <sendId> --state <read>`, which accepts only the notice it asked for (review fix P2-3). Standalone notices always have role `operator`, so **the operator sees it in the console's Inbox**; published by the orchestrator role, it wakes nobody at `essential` or `actionable` (`suppressInbox`). It names the item, the threads tried and the last error, says the proxy has answered, approved, merged and acknowledged nothing, tells the operator to open the item and tell the orchestrator, and carries the forward as data. Single quotes are replaced so the payload fits ACT's single-quoted `--payload`. It is offered once (after `--escalated`); re-sending goes on until a send is confirmed. This was the least-bad visible channel the factory already has: the proxy's own replies are unread, and T3 has no notification the proxy can raise to the operator. The proxy's allowed actions grew by exactly this one publish; it still never answers, approves, merges, presents or withdraws anything.
5. **The orchestrator can see unconfirmed forwards.** `--forwards --unconfirmed [--since]` lists forwards decided and never confirmed sent: per delivery its newest attempt (not listed once a later attempt was confirmed or the delivery was absorbed), and the newest timer and digest forward only, each with its re-sends, failures, last error, escalation and expiry. `--counts` adds `unconfirmed`, `sendFailures` and `escalations`. Every delivery forward's last line adds "Earlier forwards not yet confirmed sent: N (list them: triage.mjs --forwards --unconfirmed)" when N > 0.

### Docs

- **Proxy brief** (`t3-triage.example.md`): a new section "Sending a forward" (`SEND`) that every run uses: send the `send` object exactly; `--sent` on success; `--send-failed` on any error and follow `next`; escalate with `ACT` then `--escalated`; what happens when `forwardTo` is null. Each run kind handles `retries` first. "What you may" names the one `escalate` publish. The sentence that a lost forward "is forwarded again later" is gone; the brief says a lost forward of a notice comes back only through these re-sends.
- **Handling guide** (`t3-notifications.example.md`): "Check the count on every forward" (expect n = n0 + a + 1; otherwise `--forwards --unconfirmed`, handle each from state, record `--missed --kind undelivered`); "A forward the proxy could not send" (re-sends, the "Re-sent" headline, the `triage-undelivered-…` notice and what to do with it).
- **Integration guide** (`docs/integrations/t3.md`): "When a send fails, or is never confirmed" under Forwarding (the failure path, re-sends, escalation and who sees it, the orchestrator's view); "How" says to pass `send`; the reminders bullet says notices are sent once; the state file, log lines and counters.

### Runtime recommendation (point 5; not implemented)

Should Factotum treat an accepted delivery as unhandled until the orchestrator acknowledges it? Today, from `operations/notifications.mjs`: an accepted question is reminded `DEFAULT_REMINDER_MS` (30 minutes) later, and an acknowledgement moves its next reminder to four hours out; an accepted notice is `delivered` and never sent again; resolutions and state deliveries are re-sent every 30 minutes until acknowledged.

**Recommendation:** one early re-send of an accepted attention delivery that is still unacknowledged after about 10 minutes, for notices as well as questions, once per delivery, with the existing reminder cadence unchanged after it. That gives every consumer, not only this proxy, a bounded window for a lost wake, and it would have brought the J7 question back at about 02:54 instead of 03:14 (and a lost notice back at all).

**Cost:** one extra wake for every attention delivery that is handled but acknowledged late or never (a consumer that does not acknowledge notices today would get each notice twice; the guides tell the orchestrator to acknowledge every delivery, but older handling guides may not for operator notices); one more due-time state per delivery (`nextAt` for a `delivered` row, which today has none), touching `deliverDue`, `acknowledgeDeliveryInTransaction` and the reminder tests; a re-send counts toward the session's handoff limit (`claimSessionSendInTransaction`), so handoffs come slightly earlier. It changes notification semantics for every adopter, so it needs its own decision and change record. With this release's proxy re-sends the J7 gap is closed for proxy users without it, so it is a recommendation, not a blocker.

## J9: the remaining T3 guide and proxy gaps

Every note from orchestrator session 6 (its dev.85 report, section 5, notes 1 to 28, and notes 29 and 30 from section 6), and the wake directory from its section 2. "Handling guide" is `t3-notifications.example.md`, "brief" is `t3-triage.example.md`, "script" is `triage.example.mjs`, "integration guide" is `docs/integrations/t3.md`.

| # | Note | Where it was fixed |
| --- | --- | --- |
| 1 | References to the removed ask section dangle | Handling guide: "Every notification" step 5, the private state shorthand and the handoff's step 2 now apply "only when this guide has the section …" or "with the ask prompt", so deleting the optional section leaves nothing dangling. |
| 2 | The private state file's keys are unnamed | Handling guide: the shorthand names every key (`scheduledTaskId`, `orchestratorThreadId`, `sessionVersion`, `boundAt`, `proxyThreadId`, `proxyThreadLink`, `triageTimerTaskId`, `triageDigestTaskId`, `triageTimerEnabled`, `triageDigestEnabled`) and says how to rewrite the file; "When this thread starts" and "Taking over" step 3 name the keys they write. |
| 3 | The project's merge policy is not stated; the document-merge sentence reads oddly | Handling guide: new placeholder `[[merge-decision-role]]` and a "Merge policy" shorthand saying that with `operator` no merge is ever delegated; the delegated-merge bullet applies "only when the merge policy above is `orchestrator`"; the document sentence is "Conditions for merging a document workflow's change here: …" with `None: the operator decides them.` as the no-conditions value. |
| 4 | "Report it upstream" names no thread ID or link | Handling guide: `[[upstream-channel]]` must now include the thread ID or link. The project's copy must be refilled. |
| 5 | "Project-specific duties" lost its full stop | Handling guide: the bullet is `**Project-specific duties.** [[project-duties]]` and the placeholder asks for full sentences, with `None beyond this guide.` as the empty value. |
| 6 | "Old-format wakes right after setup" is unclear later | Handling guide: "Only in the minutes after the webhook first moved to the proxy … Later, every wake here is a forward." |
| 7 | No stand-down or resume procedure for the timer and digest | Handling guide: new "Standing down and resuming" (disable and re-enable with `schedule_task {enabled}`, the state keys, and accounting for the absence with `--absorbed` and `--forwards --unconfirmed`); integration guide setup step 6 points to it. |
| 8 | Absorbed deliveries after an absence are visible only in the raw log | Script: `--absorbed [--since]`. Handling guide: the compact paragraph and the count check name it. |
| 9 | `.settings.notifications` shows the handoff limit as absent | Handling guide: the limit in force is `.orchestratorSession.limit` (with `deliveries`); `.settings.notifications` shows only configured values. Core unchanged (it reports configured settings, which is consistent); a console or status display of effective defaults would be a separate change. |
| 10 | The brief's placeholder rule quotes the brackets it forbids | Brief: "a placeholder (a name written with double square brackets around it)"; a test checks that a filled copy has no `[[` or `]]` at all. |
| 11 | `--forward-to` names a retired thread after a handoff | Script: `forwardTarget` now prefers the last bound session seen over the configured thread, so the configured ID is used only before any session was seen. Brief and handling guide ("Taking over" step 5) say no edit is needed at a handoff. |
| 12 | A failed send is silent | J7 above. |
| 13 | The proxy dropped the `mcp:launch:` prefix | J7: `send` object; brief "copied character for character … prefix included"; the template's `[[orchestrator-thread-id]]` and the integration guide's first message ask for the full ID with its prefix. |
| 14 | The handling guide does not say to check the session count | Handling guide: "Check the count on every forward". |
| 15 | `--forwards` hides unsent forwards | J7: `--forwards --unconfirmed`; plain `--forwards` keeps its meaning (confirmed only) for the successor's reconciliation. |
| 16 | `--missed` has no kind for a forward never delivered | Script: `--missed --kind undelivered`, counted as `undelivered`. Handling guide and brief name it. |
| 17 | `--counts` mixes confirmed and decided forwards | Script: `unconfirmed` added; `forwarded` (confirmed sends) and `byRule` (decisions) are documented as different measures in the script, the handling guide and the integration guide. |
| 18 | `status --inbox` refuses inbox IDs over 128 characters | **Follow-up: J8**, a core bug assigned to the other builder (status items). Here: the handling guide's step 2 says to read such an item from `status --compact`; the proxy's `no-state` forward says the same and carries the read error (`--read-error`). |
| 19 | A `no-state` forward goes to the configured thread, not the bound session | Script: `forwardTarget` order (note 11). Tested. |
| 20 | The `no-state` forward contradicts itself | Script: its last line says "Triage did: read no canonical state"; its ask says what to read instead (`no-state` and `item-missing` have their own asks). |
| 21 | The failed-flow steps do not fit a maintenance flow | Handling guide: a paragraph for `flow-notice:maintenance:…` (receipt and stderr usually clean; the notice text; `action-result.json` `mainCheckObservations` and `check-<n>.json`). |
| 22 | `delivery.ack` after `inbox.ack` reports `inboxStatus: "open"` | Handling guide step 3: what a successful acknowledgement looks like (`status: completed`, `acknowledgedAt` set) and that the row's `status` and `inboxStatus` are transport and delivery-time values. Checked against `acknowledgeDeliveryInTransaction`, which returns the delivery row. Core unchanged. |
| 23 | A merge-decision forward lacks the PR number and link | Handling guide: the merge bullet and the compact paragraph give the exact `jq` for `mergeContext`. **Follow-up:** the forward cannot carry it because the narrow read (`status --inbox`) has no `mergeContext`; adding it there is a core change (state view), not done here. |
| 24 | Handoff step 3 does not say how to launch; the integration guide says a launch has no idempotency key | Handling guide step 3: `t3_thread_launch` with `title`, `clientRequestId`, `message`, no `workspaceStrategy`, keep the returned ID. Integration guide: corrected (the tool's description, checked 2026-11-16, offers `clientRequestId` for retries). |
| 25 | Nothing tells the outgoing thread to confirm the successor bound | Handling guide: new step 5 (check once, keep handling until bound, tell the user after about ten minutes). Integration guide handoff step 4. |
| 26 | Standing limits travel only in the launch message | Handling guide and integration guide: the summary includes the operator's standing instructions and what the session learned; "Taking over" step 6 takes them over. |
| 27 | Who acknowledges the handoff forward's delivery | Handling guide step 4: the outgoing thread does. |
| 28 | `session delivery 11/10` reads like an error | Handling guide: a count over its limit is normal (the handoff question's own delivery is counted). |
| 29 | The old thread cannot pass on a stray forward | Handling guide step 6 and integration guide: the old thread sends it on unchanged to the bound session. With note 11's fix, strays are rarer (only forwards decided before the binding). |
| 30 | A refused read gives two messages, one without provenance | Brief: step 3 runs `TRIAGE` without `--state` and with `--read-error`, and "Send no separate message about it"; the old step 5 is gone. The one forward has provenance and fixed wording. |
| §2 | A wake directory was left behind | Brief: remove `WAKE` as the last command of every run, also after a failure. Script: a timer run removes `wake.*` directories older than `WAKE_DIR_HOURS` (24) beside the state file and reports `removedWakeDirs`. |

## Tests

All in `tests/triage-proxy.test.mjs`. Fail-before: the changed test file copied into an export of the base commit `64fcf7c` (`git archive`) and run there: 42 tests, **8 fail, 34 pass**. The 8 are the 7 new tests and 1 updated test; the 34 that pass are the unchanged tests.

| Test | Fail-before (`64fcf7c`) |
| --- | --- |
| New, J7: a forward is printed with ready-made `t3_thread_send` arguments carrying the thread ID exactly, prefix included (from the command line, with an `mcp:launch:` ID) | `pass this object to t3_thread_send as it is` (no `send`) |
| New, J7 repro: a failed send (`thread_not_found`) is sent again at once with the exact arguments and the same send ID; a second failure offers the operator notice, which publishes as the orchestrator role with role `operator`, wakes nobody, and is offered once; the next timer run re-sends it; `--sent` confirms it and it leaves `--unconfirmed` | `the script records a failed send (--send-failed)` |
| New, J7: an unconfirmed forward with nothing recorded is not re-sent within the grace period, then re-sent oldest first, three a run; a new forward counts the unconfirmed; escalated ten minutes on; a forward with no thread is escalated at once | `within the grace period nothing is re-sent` (no `retries`) |
| New, J7: after the decided-for thread fails twice, the forward falls back to the last bound session seen | `triage.sendFailed is not a function` |
| New, J7: `--forwards --unconfirmed` lists decided-never-sent forwards with failures; plain `--forwards` unchanged; `--counts` separates sends and decisions; a delivery confirmed later is not listed; only the newest timer forward is | `--unconfirmed needs a value` |
| New, J9: a `no-state` forward goes to the last bound session over a configured thread, says no state was read and why, and points at `status --compact`; `--absorbed`; `--missed --kind undelivered`; a timer run removes a day-old wake directory and keeps a fresh one | `the last bound session wins over a configured thread that may be retired` |
| New, J7 and J9 docs: the brief's sending section (exact `send`, prefix, `thread_not_found`, `--send-failed`, `next`, escalation, re-sends), no bracket left in a filled brief, no undated "forwarded again later"; the handling guide's count check, unconfirmed listing, keys, stand-down, `mergeContext`, launch, binding check, relay and standing instructions; no dangling ask reference; the integration guide's escalation section and the notice fact | `The input was expected to not match … /\[\[\|\]\]/` |
| Updated: "counts, misses and the digest read the log" (the `--counts` object has the new fields) | the new fields absent |

## Results

On `9a3bae4`: `npm test` **1293 tests, 1293 pass, 0 fail** (0 skipped, 0 cancelled). `npm run eval` exit 0. `git diff --check` clean.

## Review fixes

An independent review (GPT-6.1 Sol) of `9a3bae4` requested changes with three P2 findings. The operator decided the two open questions: keep the `inbox.publish` operator notice for escalation, and leave the runtime re-send as a recommendation for a later release (below; not part of dev.86).

### P2-1: the oldest three forwards starved later ones

**Problem.** `dueResends` walked unconfirmed forwards in decision order and stopped re-sending after `RETRIES_PER_RUN` (3), and escalation was decided only for forwards it re-sent. With four unconfirmed forwards and a run every 30 minutes, every run re-sent the first three; the fourth was never re-sent or escalated, and expired after 24 hours.

**Fix** (`triage.example.mjs`). The forwards eligible for a re-send are ordered by their last attempt (the later of when they were decided and last re-sent), oldest first, so the budget rotates. Escalation is evaluated for every unconfirmed forward in the run, independently of the budget: a forward outside the budget gets an entry in `retries` with `send: null` and its `escalate`.

### P2-2: the default timer escalated after about 60 minutes, not 10

**Problem.** Age-based escalation also required one earlier re-send (`row.retries >= 1`). A forward the proxy neither confirmed nor reported failed, with no more webhooks, was first re-sent by the 30-minute timer run (no escalation, since it had not been re-sent before) and escalated only by the next one, at 60 minutes.

**Fix.** Escalation depends only on the threads left and on the time since the forward was decided: any run 10 minutes or more after it escalates. The real bound is now stated in the brief, the integration guide (Forwarding, and setup step 4 beside the timer interval) and the script's header: a failed send the proxy records is escalated in the same run after its second failure; a forward it neither confirms nor records is escalated by the first run at least 10 minutes after it was decided. (This round first stated the bound as the timer interval alone, "at most 30 minutes"; the re-check below corrects it to threshold + interval.) A project that wants a shorter bound sets the timer's `everyMs` to 600000, tripling the timer runs (each a small, fresh-context turn that is usually absorbed). The default stays at 30 minutes; it is the cheaper choice and the bound is stated.

### P2-3: an existing item could suppress the real escalation

**Problem.** The notice's ID was a digest of the send ID, so anyone who can publish could take it first, and the brief told the proxy to treat "inbox id already exists" as done.

**Fix.** Both remedies:

- The ID gains 8 random hex characters (`triage-undelivered-<12 hex>-<8 hex>`). The whole escalation (ID, title, context) is made once and kept in the forward's pending row, so every later offer, including a re-run after a lost `--escalated`, is the same notice under the same ID.
- `--escalated <sendId>` now needs `--state`, the `status --inbox <id>` read of the notice, taken after `ACT` whether it succeeded or said the ID exists. It accepts the escalation only when the item is exactly that notice: the same ID, kind `notice`, `createdBy: orchestrator`, and the same title and context (`noticeMatches`). If another item holds the ID, it records `escalation-retry` and returns `recorded: "not-escalated"` with the same notice under a new ID; if the item is missing, it offers the same notice again. The brief says to escalate again with what it returns and to say so in its reply. Neither case counts as an escalation in `--counts` or `--forwards --unconfirmed`.

### Tests

All in `tests/triage-proxy.test.mjs`. Fail-before: the changed test file run on an export of `9a3bae4`: 45 tests, **4 fail, 41 pass**. The 4 are the three new tests and the updated J7 test.

| Test | Fail-before (`9a3bae4`) |
| --- | --- |
| New, P2-1: four unconfirmed forwards and the default 30-minute timer, no confirmations: the first run re-sends three and escalates all four; the second run re-sends the fourth first; within two runs every forward was re-sent | `all four overdue forwards are escalated, the fourth too` |
| New, P2-2: one forward decided, then nothing recorded and no webhooks; the first default timer run (30 minutes) re-sends and escalates it; the brief and the integration guide stated the bound (since corrected, below) | `and escalated in the same run, the first one after the threshold` |
| New, P2-3: the ID is not the predictable one; an unrelated notice published under the offered ID makes `ACT` fail and `--escalated` with the read return `not-escalated` with a new ID and the same title and context; still offered on the next run; after the real notice is published and its `--escalated` is lost, the next run offers the same notice under the same ID, the publish says it exists, and the read is accepted; not offered again afterwards; a matching notice published by the operator role does not count; the command line refuses `--escalated` without `--state` | `the ID has a random part` |
| Updated, J7 repro: the notice's ID format, and `--escalated` given the read of the published notice | the ID format |

### Long record IDs with `/` (from J8)

**Problem.** The J8 builder (branch `t3/fix-dev86-console-findings`, not yet on `main`) found that Factotum generates inbox IDs of up to 533 characters (a target-sync flow's notice between two 200-character branch names), some containing `/` because a flow ID can name a branch; core's reads by ID accept up to 640 characters plus `/` (`core/contracts.mjs` `recordId`), while IDs a caller chooses stay at 128. The proxy's payload check allowed 200 characters of `[A-Za-z0-9_.:-]` for every ID, so a post-merge or lifecycle notice with such an ID was forwarded as an unreadable payload ("inboxId malformed"), naming nothing.

**Fix** (`triage.example.mjs`). A separate check for record IDs, `isRecordId`, matching core's `recordId`: at most 640 characters (`RECORD_ID_MAX`; first written as 512 in `5f99048`, corrected to core's 640), starting with a letter or digit, of letters, digits and `._:/-`. It applies to the payload's `projectId`, `deliveryId`, `inboxId`, `taskId`, `flowId` and `presentationId`, and to the record IDs read from state (item, task, flow and attempt IDs, the compact view's project, flows and queue tasks) and written to the log. Thread IDs, `actor` and `taskRevision` keep the old, narrower check. What the proxy builds from an ID was checked: its files have fixed names in its directory, wake directories come from `mktemp`, the state file keys IDs only inside JSON, and the escalation notice's ID is `triage-undelivered-<12 hex digest of the send ID>-<8 random hex>` (40 characters, no `/`), within the 128 allowed for a chosen ID. The brief's step 2 and the handling guide's "Check the IDs" accept the same set (and the brief says an ID is never part of a file name); the integration guide states the rule.

**Test** (`tests/triage-proxy.test.mjs`, new): "J8: delivery payloads with generated IDs up to 640 characters and a `/` are accepted …": a 533-character target-sync notice ID with slashes, a 640-character ID, a 243-character inbox ID and a flow ID with slashes, and a 299-character delivery ID with a slash, pass validation; 641 characters, a leading dash, a space and a leading dot are refused; a run forwards it with the full IDs in the forward, the log and `--forwards --unconfirmed`; its escalation notice ID is at most 128 characters with no slash and publishes; no new file is named after an ID. Fail-before, on `2035f72`: 46 tests, **1 fail** (this one: `a long generated ID with / is valid`), 45 pass; and on `5f99048` (the 512 limit): 46 tests, **1 fail** (this one: `a 533-character generated ID with / is valid`), 45 pass.

### Re-check of `b41d6ca`: the stated bound ignored the timer's phase

An independent re-check (GPT-6.1 Sol) of `b41d6ca` cleared the retry rotation, the budget-independent escalation, the planted-notice fix and the 640-character IDs, and found one P2.

**Problem.** The guides said a forward the proxy neither confirms nor records reaches the operator "at most 30 minutes" after it was decided (10 with `everyMs: 600000`). That ignores the timer's phase: a forward decided at 00:25 is 5 minutes old at the 00:30 timer run, below the 10-minute threshold, and is escalated by the 01:00 run, 35 minutes after the decision (15 minutes with a 10-minute timer).

**Fix.** The scheduling is unchanged. The bound is stated as it is, **within threshold + timer interval**: escalation comes at the first run at least `ESCALATE_MINUTES` (10) after the decision, and with no webhooks the runs are the timer's at a phase unrelated to the decision, so the operator hears of it in just under 40 minutes with the default 30-minute timer and under 20 minutes with `everyMs: 600000`, plus the run's own time. Corrected in the script's header comment, the brief ("Sending a forward"), the handling guide ("A forward the proxy could not send"), `docs/integrations/t3.md` (setup step 4 beside the interval, and "How long a lost forward can stay quiet" under Forwarding), and this record (P2-2 above and the open questions).

**Test** (`tests/triage-proxy.test.mjs`, new): "re-check P2: a forward decided 5 minutes before a timer run is escalated by the next one …": for the default 30-minute timer and for `everyMs: 600000`, a forward decided and left unconfirmed with no failure recorded; a timer run 5 minutes later re-sends it without escalating; the next timer run, one interval later, escalates it (35 and 15 minutes after the decision, each within threshold + interval). It also checks that the brief, the handling guide, the integration guide, the script and this record state the bound as threshold + interval and that none still says "at most 30 minutes". The P2-2 test's check of the old wording moved here. Fail-before, on `b41d6ca`: 47 tests, **1 fail** (this one, on the stated bound: the timing itself already behaved as described above), 46 pass.

### Merge of main

`main` (at `83b0a9f`) was merged after the fixes: merge commit `05d336a`. Since this branch's base (`64fcf7c`), `main` had the knowledge-upkeep slice 1 merge and record commits, including `83b0a9f` ("Record proxy escalation and re-send decisions", one file, `docs/one-factory-progress.md`). None touches a file this branch changes; nothing conflicted.

### Results of the review round

On the merge commit: `npm test` **1356 tests, 1356 pass, 0 fail** (0 skipped, 0 cancelled; 1293 before the merge and this round, plus 3 new tests here and main's new tests). `npm run eval` exit 0. `git diff --check` clean.

After the long-ID fix (on top of the merge): `npm test` **1357 tests, 1357 pass, 0 fail** (0 skipped, 0 cancelled). `npm run eval` exit 0. `git diff --check` clean.

After the limit was corrected to 640: `npm test` **1357 tests, 1357 pass, 0 fail** (0 skipped, 0 cancelled). `npm run eval` exit 0. `git diff --check` clean.

After the re-check fix (the stated bound): `npm test` **1358 tests, 1358 pass, 0 fail** (0 skipped, 0 cancelled). `npm run eval` exit 0. `git diff --check` clean.

## Adopter notes

- **Copy `triage.example.mjs` again.** Its output gains `send`, `retries` and sometimes `escalate`; new commands `--send-failed`, `--escalated` (with `--state`, the read of the notice), `--forwards --unconfirmed`, `--absorbed`, `--missed --kind undelivered`, and the wake option `--read-error`. A state file from before keeps working: pending rows without text are re-sent with a short message naming the send ID to `--verify`.
- **Update the proxy brief** from the new template (the "Sending a forward" section, `retries`, `--read-error`, the placeholder sentence). A brief from dev.85 with the new script still works, but its proxy ignores `retries` and escalations.
- **Update the handling guide** from the new template: one new placeholder, `[[merge-decision-role]]`; `[[upstream-channel]]` now wants a thread ID or link; `[[project-duties]]` and `[[document-merge-conditions]]` want full sentences.
- **Forward targets changed order:** with no state read, a forward now goes to the last bound session the proxy saw rather than the `--forward-to` thread.
- **The proxy may now publish one kind of item:** an operator notice `triage-undelivered-…` about a forward nobody received. Nothing else changes in what it may do.

## Open questions

- **The runtime recommendation** above (an early re-send of an accepted, unacknowledged attention delivery, notices included): decided by the operator as a later follow-up, not part of dev.86.
- **Escalation by operator notice:** decided by the operator: kept.
- **Escalation threshold and timer interval.** Ten minutes, two failures per thread and the 30-minute default timer are judgement; with that timer a forward the proxy loses without noticing can stay quiet for up to the threshold plus the interval, just under 40 minutes. The constants are at the top of the script; the interval is in the brief's setup.
- **Notes 9, 22 and 23** have doc fixes only; each has a possible core follow-up described in its row. Note 18 is J8, with the other builder.
