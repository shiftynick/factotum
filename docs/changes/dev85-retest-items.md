# dev.85: the remaining findings of the dev.84 readiness re-test

Five findings from the dev.84 re-test: I2 (a build that ended at its turn limit is drawn and recorded as "passed"), I5 (the successor's takeover steps, the proxy's forward target, the size of `status --compact`, and dead links and template text in the filled-in guides), I1 (the Flow slots card hides an idle pool), I3 (times inside "Admission held" have no UTC tooltip) and I4 (the wording of a refused stale answer). For each: the problem, the fix, compatibility and the tests with their fail-before evidence. This is a local implementation record, not a release, activation or live qualification claim. No provider or forge was called.

**The reference graph is unchanged.** No node, edge, answer or question text in a graph changed, so no workflow digest changes and no task needs approving again. No SQL JSON read over `records.data` and no full scan was added: the new outcome is derived from records already read, and the compact trims are applied in JavaScript to rows the snapshot already reads.

**Fail-before evidence.** The new and changed test files were copied into an export of the base commit `5dd6de9` (`git archive`) and run there. One module that does not exist at base (`core/stale-question.mjs`) was replaced with a stub that throws, so the rest of its test file could run. Result: 62 tests, **15 fail, 47 pass**. The 15 are the 12 new tests and 3 existing tests updated for an intended change; the 47 that pass are the unchanged tests in those files. One more existing test (G18, `tests/adoption-tooling-docs.test.mjs`) was updated after the first full run because it pinned the old checklist link; it fails at base only in the same way (the new reference text is absent). Each failure is quoted under its item.

## I2: a build out of turns was drawn and recorded as "passed"

### Problem

A build attempt that stopped at its turn limit settles cleanly as a runner: status `passed`, `classification: "turn-limit"`, route `blocked` to the build question (dev.84, H9). The console drew it green ("build attempt …: passed", "Outcome: passed", "exit code 0") and `status --flow` listed it as `passed`, while its Reason line named the turn limit. The fast-check attempt beside it, which also settles `passed` and reports a failure, was already drawn red through the dev.83 derived outcome. The build question's title still read the graph's "The builder is blocked. Inspect the retained result before retrying."

### Fix

The dev.83 mechanism carries it: an attempt's lifecycle `status` stays as it is, and its routed outcome is recorded beside it.

- **Core** (`core/attempt-outcome.mjs`). `attemptOutcome(status, result)` returns `{outcome: 'turn-limit'}` for a `passed` attempt whose result has `turnLimit`, before the existing `route: fail` case. Settlement (`core/engine.mjs`, unchanged) records it, so a new turn-limit build has `status: passed, outcome: turn-limit`. `publicAttempt` derives the same from the receipt for an attempt settled before this (dev.84). A planner's or reviewer's turn limit settles `failed` (dev.84) and gets no derived outcome.
- **`status --flow`** (`operations/state-view.mjs`) lists an attempt's `outcome` beside its `status`; the starter state filter (`factotum-state.example.jq`) does the same.
- **Console** (`console/ui/records.mjs`). `attemptStatus` returns `turn-limit` for `outcome: turn-limit`, and for a `passed` attempt classified `turn-limit` (the overview's attempt rows carry the classification, not the outcome). `attemptStatusLabel` words it "stopped at turn limit", and `turn-limit` is a warning tone (`console/ui/dom.mjs`). The timeline bar, its label and accessible text, the timeline table and History's status column use it (`console/ui/timeline.mjs`, `console/ui/history.mjs`). The attempt panel shows "Outcome: stopped at its turn limit — the provider stopped at its turn limit before the step finished; the step returned no result", "Lifecycle: settled cleanly (status passed); the flow followed its blocked route to the step's question", and "Process exit: code 0 (the step runner process, not the outcome)".
- **Notices.** A completed flow's notice adds "Stopped at the turn limit on the way: build stopped at its provider turn limit once. Each time the step did not finish, the flow asked how to continue, and a later attempt finished it." (`recoveredFailures(store, flow, 'turn-limit')`, `core/project.mjs`). Such a flow is not routine (`flowNeedsAttention`, `operations/notifications.mjs`), so the notice is not suppressed at the `actionable` level: the build spent a budget of turns and needed an answer.
- **The build question's title** (`core/worker-questions.mjs`). The turn-limit card sets its `question` to "The builder stopped at its turn limit before the build finished. Retry continues it with the reviewed plan." (the second sentence only when the node has `retry`). The graph's question text is not changed; the card's `question` field was already free to differ from it, as the plan card's context does.

### Compatibility

Lifecycle `status` is unchanged everywhere, so drains, cleanup, uncertain-attempt rules and settlement read what they read before. New field values only: `outcome: "turn-limit"` on attempts, and `outcome` in `status --flow`'s attempt rows when set. A History filter value `turn-limit` appears. A completed flow that had a turn-limit build now notifies at `actionable`.

### Tests

| Test | Fail-before (`5dd6de9`) |
| --- | --- |
| `tests/provider-turn-limit.test.mjs`, new: "dev.85 I2: a build out of turns is recorded and read as stopped at its turn limit …" (the recorded outcome with status `passed`, `publicAttempt` for a new and a dev.84 record, `status --flow`, the question title, attention and the notice text, the fast-check outcome unchanged, none for a failed reviewer attempt) | `the routed outcome is recorded beside it: actual undefined, expected 'turn-limit'` |
| `tests/dev85-retest-items.test.mjs`, new: "I2: the timeline, the attempt panel and History show a build out of turns as stopped at its turn limit" | `actual 'passed', expected 'turn-limit'` |

## I5: the successor's takeover, the forward target, compact status and the filled-in guides

### (a) The successor's steps were in the outgoing thread's section

**Problem.** The handling guide's "When this thread starts" only binds. Reading state, updating the private state file, checking the binding and reconciling forwards were in "Hand off to a fresh orchestrator session", written for the outgoing thread under `kind = inbox`. The predecessor was not asked for the handoff forward's time, which the successor needs.

**Fix** (`starter/project/integrations/t3-notifications.example.md`). A new section "Taking over as successor", between "When this thread starts" and "Every notification", with the steps in order and a command for each:

1. read state: `status --compact` written to a file in the private directory and queried with `jq`, never printed; `READ` for the items the summary names;
2. bind, with what the receipt holds (`version`, `boundAt`) and that the handoff question closes as `superseded` with no delivery;
3. update the private state file (thread ID, session version, `boundAt`; the webhook and proxy IDs stay);
4. check the binding with `status --inbox <the handoff question>`: `project.session.sessionId` and the item's status;
5. the webhook: with a proxy, no `schedule_task`, and `TRIAGE --forwards --since <the handoff forward's time>`, handling each forward whose `forwardTo` is not this thread (older log entries: compare `sentAt` with `boundAt`); without one, `schedule_task … bindToCurrentThread`;
6. take over the summary's open work and tell the user.

The outgoing thread's summary now includes the handoff question's inbox ID and, with a proxy, the handoff forward's time and send ID; its step 3 tells the successor to follow the new section, and keeps the proxy rule. `docs/integrations/t3.md` says the same in its handoff bullet and in "Ordinary threads and orchestrator handoff".

### (b) `--forwards` did not record the target thread

**Problem.** The proxy decides where a forward goes from the bound session it reads, but neither the log nor `--forwards` recorded it. A forward decided before a rebind and confirmed after it looked like the successor's.

**Fix** (`starter/project/integrations/triage.example.mjs`). Each forward's decision line in the log carries `forwardTo` and `forwardSource` (`session`, `configured`, `last-seen`), as do a state-reset line, the pending row and the remembered delivery; `--sent` repeats `forwardTo` on its `sent` line. `--forwards` lists `forwardTo` for each confirmed forward (the `sent` line's, else the decision's; `null` for entries written before dev.85). `--verify` returns `forwardTo` and adds to its verdict "It was addressed to thread T; if that is not this thread, it reached another one." (or that the log does not record it, for an older entry). `--help` says so. The log fields are documented in `docs/integrations/t3.md`.

### (c) `status --compact` was 207 KB

**Measured.** The trial's own `status --compact` output from the dev.84 re-test (a project with 44 tasks, 20 recent flows, 31 queue entries and 23 inbox items in the view) was 220,330 bytes as printed. By part, minified: inbox 46 KB, queue 33 KB, settings 22 KB, tasks 19 KB, flows 14 KB, obligations 8 KB. What made it large:

- **Indentation:** 57 KB of the 220 KB. The CLI printed every view with two-space indentation.
- **Queue entries that left the queue:** 27 finished and 3 claimed entries carried their admission observation (`eligibility`: two 64-character digests, reasons and eight times) and the full `admissionTiming` (29 KB of the queue's 33 KB). The console reads `eligibility` only for queued entries (the Queue editor) and only `admissionTiming.readyToAdmissionMs` for the others ("Started from the queue").
- **Resolved inbox items:** `planQuestion` and `buildQuestion` (about 3.7 KB here), which only answering an open item uses. Their `context`, answer, note, relay and `carriedQuestions` are shown by the Inbox's Resolved view and stay.

**Fix.** `status --compact` prints one line of JSON (`cli.mjs`; `status --help` says to write it to a file and read it with `jq`). The dashboard snapshot (`service/dashboard.mjs`), which the console's service socket serves and `--compact` prints, maps queue entries that are not `queued` to drop `eligibility` and keep `admissionTiming` as `{readyToAdmissionMs}`, and drops `planQuestion` and `buildQuestion` from inbox items that are not open. Both are applied in JavaScript to rows already read.

**Consumers checked.**

- The console: Queue's editor (`console/ui/plan.mjs`, queued entries' `eligibility`), "Started from the queue" (`console/ui/queue.mjs`, `readyToAdmissionMs`), the Inbox (`console/ui/inbox.mjs`: `planQuestion` only inside the open item's answer forms; `buildQuestion` not read; resolved items render context, answer, note, relay and carried questions) and the stale-answer explanation (status, answer, choices, answeredBy, answeredAt).
- The triage proxy's timer check (`triage.example.mjs` `timerCheck`, `healthConditions`): `snapshotView`, `projectId`, `flows`, `queueTasks`, `queueStatus`, `mainHealth`, `health`, `spending`, `providerLimits`, `orchestratorSession`, the pause and recovery fields; none of the trimmed fields.
- The T3 guide's state filter (`factotum-state.example.jq`) reads the full `status`, not `--compact`; unaffected. The handling guide's paths into `--compact` (`.flows[].state`, `.queue[].status`, `.obligations[]`, `.orchestratorSession`) are unchanged.

**Size after.** The same recorded view with the new code's trims applied (a script mirroring them over the recorded JSON, since the trial's state was not available to this checkout): **135,947 bytes**, from 220,330 (−38%): 57,572 from the single line, 23,108 from the queue (32,776 → 9,668) and 3,703 from the inbox (46,281 → 42,578). What remains is what the console shows (inbox context, settings, tasks, flows). The guides now say to write it to a file and query it, never to print it into a thread.

### (d) Dead links and template text in the filled-in guides

**Problem.** Factotum's `docs/` are not installed into an adopting project (only `VERSION`, `compatibility.json`, `factory/` and `project/`), so every relative link from a starter file to them pointed at the project's own `docs/` or above its root. The two T3 templates' links (`../../docs/…` from `project/integrations/`) did not resolve even in this repository. A skill's link left its folder, which is copied elsewhere. The templates' fill-in placeholders looked like the per-wake values (`<project-id>` beside `<inboxId>`), some read like explanations (`<HH:MM, the host's local time>`, `<stall-minutes, default 120>` in a shell command), the opening "Copy this file … fill in the placeholders" stayed in the copy, and the ask section said "Leave this section out" while present.

**Fix.**

- Every link from a starter file to Factotum's docs (28, in seven files including the console and contracts READMEs and a skill) is now plain text naming the doc and section, "(`docs/adoption.md#copy-and-configure` in the Factotum reference)". Links between installed files (`../factory/AGENTS.md`, `skills/…`) stay links.
- The two T3 templates use a separate placeholder form, `[[name]]`, for values filled in once when copying; `<like this>` stays the per-wake form and T3's own `{{body.…}}` is untouched. Each template opens with a **template note** between `<!-- template note: start -->` and `<!-- template note: end -->` markers: the copy instruction, a table of every placeholder and what to put there, and which optional sections to keep. Optional sections (`triage-proxy`, `issue-mirrors`, `ask-prompt` in the handling guide) sit between `<!-- optional: name -->` and `<!-- end optional -->` markers; the ask section's "Leave this section out" text moved into the note, and the section itself now reads correctly when kept. Free-text template slots became placeholders (`[[document-merge-conditions]]`, `[[project-duties]]`, `[[when-to-ask]]`, `[[issue-mirrors]]`, `[[upstream-channel]]`, `[[governance-file]]`, `[[digest-time]]`, `[[stall-minutes]]`, `[[idle-minutes]]`, `[[project-name]]`). Both guides tell their reader to stop and ask on a `[[` left in them, instead of guessing.
- `[[install-root]]` replaces `<project-root>` and its prefix variant: `project/integrations/…` sits under the install prefix too, which the old `<project-root>/project/…` paths got wrong for a prefixed installation. `docs/integrations/t3.md` uses `<install-root>` likewise (the proxy's first message and the two prompts) and describes the template note in its setup steps; `starter/project/README.md` too.

**Test** (`tests/starter-guides.test.mjs`, new). It scans every `.md` under `starter/`: a relative link must resolve inside what is installed (a skill's inside its own folder; a `.template.md` has none), to an existing file and heading; each "`docs/…` in the Factotum reference" must name an existing doc and heading. For each T3 template: every `[[name]]` used is listed in the note and every listed one used; each optional section is named in the note; a copy filled in (note deleted, optional sections all kept and all deleted, placeholders replaced) has no `[[name]]`, no marker, no "Copy this file", "fill in the placeholders", "Leave this section out", "template note" or `../../docs`, and no angle-bracket placeholder in the old forms (a hyphenated name, or one that explains a default or `HH:MM`). A fifth test checks the successor section's steps and the outgoing summary (I5a).

### Tests

| Test | Fail-before (`5dd6de9`) |
| --- | --- |
| `starter-guides`: links resolve after adoption | 28 broken: 25 "outside starter, so not there after adoption" and 3 "missing" (the templates' `../../docs/integrations/t3.md`) |
| `starter-guides`: Factotum references exist | `references found: 1` |
| `starter-guides`: each template's placeholders and a filled-in copy (2 tests) | `the template note is marked so a copy can delete it whole` |
| `starter-guides`: the successor section and the summary (I5a) | `the section exists before the per-notification rules` |
| `dev85-retest-items`: I5b, `forwardTo` in the log, `--forwards` and `--verify`, decided before a rebind and sent after | `actual [['forward', null], ['sent', null], …], expected [['forward', 'thread-old'], …]` |
| `dev85-retest-items`: I5c, one line and the trims, with the consumers' fields kept | the finished entry's `eligibility` present, `expected undefined` |
| Updated `triage-proxy`: "the proxy guide sets itself up …" (the prompts compared with `[[install-root]]` written `<install-root>`; the first message names `<install-root>`) | `did not match /…follow <install-root>\/project\/integrations\/t3-triage\.md…/` |
| Updated `t3-guide`: "the T3 setup states what Factotum signs …" (the ask section is optional and off by default through the note, and "Leave this section out" is gone) | `did not match /<!-- optional: ask-prompt -->\n## Asking through the ask prompt\n/` |
| Updated `adoption-tooling-docs` G18 (the checklist names the section in the reference) | the old relative link, not the reference text |

## I1: the Flow slots card hid an idle pool

**Fix** (`console/ui/queue.mjs`). The card lists every pool the capacity view reports, change and document first, then any other in name order, idle ones included ("Document flows 0 of 2 in use · 2 free for queued tasks"). It used to drop any pool but `change` that had nothing in use, parked or waiting.

**Test.** The existing "the Queue tab lists slots in use, parked flows …" (`tests/console-flow-slots.test.mjs`) asserted that an unused pool is not listed; it now asserts that it is. Fail-before: `an idle pool is listed`, the card text without "Document flows".

## I3: times inside "Admission held" had no UTC tooltip

**Fix** (`console/ui/plan.mjs`). The queue entry's observation ("Observed", "Ready since", "Last not ready") renders each time with `timeNode` from `console/ui/admission.mjs`, the dev.83 structured time: a `<time>` element with `datetime` and the title "<ISO> (UTC as recorded)", showing the local time. A missing time is "—".

**Test** (`dev85-retest-items`, new). Fail-before: `Observed is a time element: actual undefined`.

## I4: the stale-answer wording

**What the code said.** Every answer path (`core/project.mjs` for flow questions, `core/communication.mjs` for standalone questions and `inbox.present`, `core/decisions.mjs` for decision cards) refused with the one string "stale or resolved question" whether the question had been answered, superseded or expired, or was still open at a newer version or subject. That string is the receipt's error, which Receipts and History show. The console's inline explanation (`staleAnswer`, dev.83) is computed after the page refreshes: for an answered item it already said "It had already been answered “Green” by the operator …; your answer was not applied", but with a snapshot that had not caught up it said only "Refresh and read the question again". So the re-test's Receipts and History text was confirmed vague; the inline text could not be confirmed either way from the evidence.

**Fix.** `core/stale-question.mjs` gives the refusal the case, keeping its first words, which scripts, guides and the console match:

- "stale or resolved question: it was already answered “Green” by the operator; this answer was not applied" (the choice's label, and "by the orchestrator (relayed)" for a relayed answer);
- "stale or resolved question: it is superseded and takes no answer; this answer was not applied" (any other resolved status, or withdrawn);
- "stale or resolved question: it changed since it was read (version 2, now 3); read it again before answering";
- "stale or resolved question: what it asks about changed since it was read; read it again before answering".

A missing version is still refused. All four answer paths use it. The console adds only what the refusal lacks: when it was answered and that it is under Inbox → Resolved, and nothing when its snapshot has not caught up, instead of repeating it.

**Tests** (`dev85-retest-items`, 2 new). Every case of the reason; and end to end, a real question answered by one command and then by a second with the same version, whose receipt error is the exact sentence and whose page explanation adds the time and place. Fail-before: `staleQuestionReason missing at base` (stub), and `actual 'stale or resolved question'`.

## Results

`npm test`: first full run 1263 tests, 1262 pass, 1 fail (G18, which pinned the old checklist link; updated). A second run had one unrelated failure, `ENOSPC: no space left on device` in an install-prefix test that writes 8 MB files, while the shared `/tmp` was under load from other work; that file then passed 45 of 45 three times. Final run: **1263 tests, 1263 pass, 0 fail**. `npm run eval` exit 0. `git diff --check` clean.

## Review fixes

An independent review (GPT-6.1 Sol) of `673d582` approved it with fixes, with one blocking finding. It confirmed I2's status, routing, retry and accounting; the compact trims against every consumer; legacy log readability; the placeholder docs and the scanner; the stale-refusal prefix; safe DOM; no new scans; and 1,263 of 1,263 tests passing.

### P2, blocking: overlapping forwards could record the wrong destination

**Problem.** Every forward of a delivery had the send ID of the delivery itself, and `runRecorded` wrote each decision's `forwardTo` onto the delivery's one remembered row, which `confirmSent` read. Reviewer's repro: decide `delivery-1` while `thread-old` is bound and keep the forward; rebind to `thread-new`; decide the same delivery again (a reminder); confirm the first send. The `sent` line then said `thread-new`, both decisions shared `sendId: delivery-1`, and `--forwards` reported the forward that went to the predecessor as the successor's, which the successor's instructions skip.

**Fix** (`starter/project/integrations/triage.example.mjs`).

- Each forward or unsure decision of a delivery is its own **send attempt**, with send ID `<deliveryId>:<n>`. `n` counts the delivery's forwards (`sendAttempts` in its remembered row, carried through rechecks and re-sends; `lastSendId` names the latest). The decision line, the provenance line and the result carry it.
- Each attempt has its own pending row (`kind: 'delivery'`, `deliveryId`, `forwardTo`, `forwardSource`), like timer, digest and notice forwards. Nothing writes a destination onto the delivery's row any more. At most the 500 most recent unconfirmed delivery attempts are kept; an absorb on judgement drops that delivery's attempts.
- `--sent <sendId>` confirms that attempt: it marks the delivery sent and writes `{decision: 'sent', what: 'delivery', deliveryId, sendId, forwardTo}` with that attempt's destination, in whatever order attempts are confirmed.
- **Compatibility.** `--sent <deliveryId>`, as runs before dev.85 call it, confirms the delivery's most recent attempt (`lastSendId`). With a state file from before this change (no attempt rows) it confirms the delivery as before, with the `forwardTo` that row may hold. `--verify <deliveryId>` reports every attempt of that delivery; a send ID matches exactly. Log lines without a send ID on the `sent` line (before dev.85, when the send ID was the delivery ID) are still matched by `--verify` and `--forwards`.
- Docs: `docs/integrations/t3.md` (the provenance example, send IDs per attempt, `--sent` with a delivery ID, the log and state file fields).

**Tests** (`tests/triage-proxy.test.mjs`).

| Test | Fail-before (`673d582`) |
| --- | --- |
| New: "two forwards of one delivery decided for different threads keep their own send IDs and destinations, whatever order they are confirmed in" (the reviewer's interleaving through recorded wakes and real rebinds; the log, `--forwards` from the script and the command line, `--verify` for each attempt, the successor's filter finding the predecessor's forward; then confirmed in the other order) | first `actual: '<deliveryId>', expected: '<deliveryId>:1'`; with the send-ID assertions removed, the destination itself: `the first send went to thread-old: actual [ 'thread-new' ]` |
| New: "--sent with a delivery ID confirms its most recent attempt, and a log or state file from before dev.85 still reads" | the `sent` line without the attempt's `sendId` |
| Updated: "an open operator question is forwarded …" (the send ID is `<deliveryId>:1`; its legacy `confirmSent(<deliveryId>)` is kept) | `actual: '<deliveryId>', expected: '<deliveryId>:1'` |
| Updated: "every recorded forward carries a provenance line …" (the line names `send <deliveryId>:1`; `--verify` by send ID and, as before, by delivery ID) | the line says `send (the delivery ID)` |

Fail-before run: the changed `tests/triage-proxy.test.mjs` on an export of `673d582`: 35 tests, **4 fail, 31 pass**; the 4 are the two new and the two updated tests.

### Merge of main

`main` was merged after the fix (`git merge main`): merge commit `2dd47eb`. Since this branch's base (`5dd6de9`), `main` had one commit, `aace1ce` ("Record knowledge-upkeep design and decisions"), changing one line of `docs/one-factory-progress.md`, which this branch does not touch. Nothing conflicted.

### Results of the review round

On the merge commit with this record: `npm test` **1265 tests, 1265 pass, 0 fail** (1263 before, plus the 2 new tests); `npm run eval` exit 0; `git diff --check` clean.

## Adopter notes

- **A build that ran out of turns now reads "stopped at turn limit"** in the console and has `outcome: "turn-limit"` in `status --flow`; its `status` is still `passed`. A flow that went on to finish notifies even at `actionable`.
- **`status --compact` is one line of JSON** and leaves out finished queue entries' admission observations and resolved items' plan and build question fields. Pipe it to a program or a file.
- **A refused stale answer** now says why after "stale or resolved question:". A script that compares the whole string must match the prefix instead.
- **A delivery forward's send ID is now `<deliveryId>:<n>`**, one per forward; `--sent <deliveryId>` still confirms the latest. Copy `triage.example.mjs` again.
- **The T3 templates changed form.** A copy made from an earlier release keeps working. To pick up the successor section, the `forwardTo` reconciliation and the fixed paths for a prefixed installation, compare your copy with the new template; its note lists every `[[…]]` value to fill in. Copy `triage.example.mjs` again to record `forwardTo`.

## Open questions

- **Compact size.** 136 KB is still large for a thread to read; the rest is what the console shows. A narrower takeover read (open items and flows only) would need a new view; not done here.
- **Measurement.** The after-size was computed by applying the same trims to the recorded view, not by running this code against the trial's state.
- **I3's related nit** (Settings shows "None (Codex has no turn limit)" while `status` reports `defaultMaxTurns: 16` for the same Codex role) is not changed.
- **I5 points not in scope here:** `--forward-to` still names one thread in the proxy guide's `TRIAGE` line (G4); `--counts` without `--since` still mixes an earlier proxy's entries; replaced proxies' task titles still repeat (G7); the private state file's key names are still the adopter's choice.
