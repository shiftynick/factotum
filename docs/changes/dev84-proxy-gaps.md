# Triage proxy: gaps from the first live trial

Documentation, starter templates, tests and one text-only core change (the handoff question's wording). Not a release. Source: the first live trial of the [triage proxy](../integrations/t3.md#triage-proxy-thread-recommended) on dev.83, with a proxy thread on a small model. The trial confirmed the design:

- the webhook moved to the proxy with fresh context per run;
- setup step 7's check passed (the notice was forwarded, and the operator's acknowledgement was absorbed without waking the orchestrator);
- the timer absorbed "no change".

The orchestrator listed what got in its way. This note goes through every point.

**Numbering.** When the finding was filed, the orchestrator's report had 23 points. It grew to 34 while the trial went on, and the session that took over reused numbers 28 to 31. That makes 38 entries, all covered below; reused numbers are marked "(b)". Two related findings from the same trial are added at the end: the triage script's `--help` (H12) and the tooling-exclusion advice (H2).

## What changed

| Where | What |
| --- | --- |
| `starter/project/integrations/triage.example.mjs` | **Forwards.** The headline names the item by its own title, or by its task's title and ID. The task line is always present. An answer gives its time. Each part of a forward has its own budget, and the whole forward stays under `FORWARD_CHARS` (8,000 characters): title 200, question 600, note 1,000, the context's main text 2,000 (a cut says "context cut: N of M characters shown" and where the rest is), and 500 for each "Corrected on the way" or cleanup paragraph. The carried questions (core's dev.83 list, from a merge question's `carriedQuestions` field or a completion notice's context) get up to 10 entries of 400 characters, then "… and N more". When a forward is still too long, the lowest-priority part is cut first; the headline, provenance, IDs and acknowledgement line are never cut. A failed or stopped flow's forward lists its failed, uncertain, aborted or unsettled attempts: ID, step, status, when settled, the reason (or the notice, when the narrow read has one) and where their files are. A flow notice older than its flow's current end says so. The line "Absorbed since the last forward: N (log: <absolute path>)" is always present. The completion and failure asks say what to tell the operator. **Provenance.** The second line of every recorded forward names the proxy's thread ID, the rule, the delivery, the send ID, when it was decided, and how to check it. The log records each forward's `sendId`. **Commands.** `--set-proxy-id` records the proxy's thread ID (run at setup). `--verify <sendId>` checks a forward against the log. `--forwards [--since]` lists confirmed forwards. `--missed --kind absorbed\|lookup` records the two kinds of miss, which `--counts` reports apart as `missed` and `lookups`. `--correct <at> --note` adds a correction beside a log entry. `--help` prints usage. |
| `starter/project/integrations/t3-triage.example.md` | New section "First run: setup": record your identity, move the webhook with exactly five fields (never `schedule`), check it, create the timer and digest with titles and `clientRequestId`s, report the IDs to the orchestrator. It carries the webhook prompt, identical to the guide's. New section "Any other message". `DIR`, `WAKE` and `TRIAGE` are always absolute paths. The orchestrator side covers `--verify`, `--forwards` and the miss kinds. |
| `docs/integrations/t3.md` | **Setup.** Step 2 gives the proxy's exact first message and says who records `proxyThreadId` and where; working directories don't matter; the runtime modes as tried. Step 3 lists the exact fields and says why `schedule` must not be passed. Step 4 makes removing the orchestrator's own timers a **T** step. Step 5 gives the `timeOfDay` format and time zone. Step 6 records the task IDs. Step 7 checks provenance. **Other additions:** "Deliveries already on their way"; a latency bullet; a handoff bullet (only the session binding moves, and forwards sent to the predecessor are found with `--forwards`); the new forward template and budgets; a "Provenance" paragraph on what the check does and does not prove; counters with `lookups` and corrections; log line shapes. In "Ordinary threads and orchestrator handoff", the unconditional "move the existing webhook task" is now conditional, the summary lists deliveries in flight and open notices, step 3 branches on the proxy, and step 4 says not to answer. |
| `starter/project/integrations/t3-notifications.example.md` | **Proxy fields.** The private state file's proxy keys, written by this thread, and a `TRIAGE` shorthand with `--log` only. **`status --compact`.** Where things are in it. **Forwards section.** Rewritten: the task and the session count, checking provenance, "first news may be the answer", cut forwards, old-format wakes after setup, misses by kind and corrections. **Flow notices.** Tell the operator a completed notice's carried questions. An uncertain attempt's cause is at the end of `provider/stdout.jsonl`, and the operator settles it with `reconcile --attempt`. **Handoff.** The summary adds deliveries in flight and open notices. Step 3 branches: with a proxy, no `schedule_task`, and `--forwards` reconciliation; without one, move the webhook. Step 4: don't answer, and `handing-off` exists only for the record. |
| `starter/factory/operations/orchestrator-session.mjs` | Text only, in the handoff question's `context`: with a triage proxy that forwards to the bound session, leave the notification binding on the proxy, and a session that hands off need not answer. No logic, choice or field changed. The subject digest of a newly raised question covers the new text, as it covers any text. `docs/communication.md` describes the same. |
| `docs/adoption.md`, `starter/project/SETUP_CHECKLIST.md` | H2: a project script that walks the tree itself and has no ignore list needs a path filter in its own code. Generic examples (Node, `find -prune`, `git grep`; corrected in review, below), paths relative to the repository root, and choosing a prefix outside the walked folders to avoid the change. |
| `tests/triage-proxy.test.mjs` | Seven new tests, each failing on the base script: the answered flow question's headline, task and answer time; carried questions from a completion notice and from a merge question's field, with the "… and N more" marker, inside the budget; a long context cut with its length, an overall cap that cuts optional parts and keeps the required ones; attempts named with their reasons, and the "older than the flow" line; provenance on delivery and timer forwards, `--set-proxy-id`, `--verify` for a real and a forged ID, `--forwards`; misses by kind, `--correct`, `--help`, the absolute log path from a relative `--log`. A seventh checks that the brief's setup section and the guide's handoff wording stay stated, and that the two webhook prompts are identical. The counts test now expects `lookups`. |
| `tests/orchestrator-handoff.test.mjs` | The handoff question's text says to leave the binding on a proxy and that handing off needs no answer. |

## Every point

"Guide" is `docs/integrations/t3.md`, "brief" is `t3-triage.example.md`, "handling guide" is `t3-notifications.example.md`, "script" is `triage.example.mjs`.

| # | Point | Where it is fixed, or why it is a follow-up |
| --- | --- | --- |
| 1 | Nothing tells the proxy how to do steps 3 to 5; it asked what was wanted | Brief: "First run: setup", a numbered procedure. Guide step 2: the exact first message, naming that section, the webhook task and the orchestrator thread. Test: the setup section names each required field. |
| 2 | Step 3 does not say to pass no `schedule` field (the signature could be lost) | Guide step 3 and brief setup step 2: exactly five fields; never `schedule`, `filters`, `enabled` or a signature, because an update changes only the given fields and a `schedule` without its signature block leaves URL-token checking only (from the T3 tool description). The brief's step 3 checks the signature is still set. |
| 3 | Who records the proxy's ID, and under which key | Guide steps 2 and 6, and the handling guide: whoever launched the proxy records `proxyThreadId` and `proxyThreadLink` in `t3-integration.json`, and the orchestrator records `triageTimerTaskId` and `triageDigestTaskId` from the proxy's setup report. The proxy never writes that file. |
| 4 | The proxy's working directory is a scratch folder | Guide step 2 and the brief's shorthands: every path is absolute, the CLI runs from any directory, and the working directory does not matter. |
| 5 | The runtime-mode note was untried | Guide step 2: with both threads at `full-access`, sends in both directions were accepted; a narrower proxy is untried. |
| 6 | Removing the orchestrator's timers sat inside a **P** step | Guide step 4: that part is now **T**. `list_scheduled_tasks` lists the whole project, but only the orchestrator knows which timers are its own. The brief tells the proxy to delete nothing. |
| 7 | `timeOfDay` has no format or time zone | Guide step 5 and brief: `"HH:MM"`, read in the host's local time, as observed. |
| 8 | No `title` or `clientRequestId` suggested | Brief setup steps 2, 4 and 5 give both; guide steps 3 and 4 name them. |
| 9 | Deliveries dispatched before the move arrive later as old-format wakes; the proxy has no record of them | Guide "Deliveries already on their way" and the handling guide: handle and acknowledge them as before. One left unacknowledged is re-sent to the proxy, which forwards it as new. That costs one extra forward and loses nothing, so no runtime change is needed. |
| 10 | The webhook task's title stays "Factotum notifications" | Guide step 3 and brief setup step 2: give a `title` that says the webhook now feeds the proxy. |
| 11 | The brief has no setup section, and nothing covers a first message with no payload | Brief: "First run: setup", plus "Any other message" (reply in one line and do nothing). |
| 12 | The file-writing tool needs an absolute path; `DIR` was a shorthand | Brief: `DIR` is defined as an absolute path, `mktemp` prints `WAKE` absolute, and `WAKE` is always written out in full. |
| 13 | The handling guide's handoff still moves the webhook | Handling guide handoff step 3 now branches: with a proxy, the webhook stays and the successor does not call `schedule_task`; without one, it moves. Test. |
| 14 | `--missed` and `--counts` were shown with `--log` only; it was not known whether that works | It works, as the trial found. The handling guide's `TRIAGE` shorthand has only `--log`, and the guide says which commands need only `--log`. |
| 15 | An answered flow question's forward has no task ID or title | Script: the headline uses the item's title, or else its task's title and ID; the task line is always present; the log records the task title. Test. |
| 16 | "Absorbed since the last forward" is missing when it is zero | Script: always present, with the log's absolute path. Test. |
| 17 | The context is cut at 500 characters, losing the carried assumptions | Script: per-section budgets (the context's main text 2,000, with a stated cut and its full length), carried questions in a section of their own (10 entries of 400 characters, then "… and N more"), and an overall cap that never cuts the required lines. Tests. |
| 18 | A forward does not name its rule | Script: the provenance line names the rule. |
| 19 | Anyone who can message the orchestrator can write a forward, and nothing says to check the log | Script: a provenance line, `--set-proxy-id`, `--verify`, and `sendId` in the log. Guide "Provenance" and the handling guide say how to check and what it proves: that a triage run with access to `DIR` decided that forward. It does not prove the sender, since T3 does not authenticate senders and a send ID can be copied. **Follow-up (host):** a T3 field naming the sending thread would close this. Factotum cannot. |
| 20 | `--missed` counts two different things | Script: `--missed --kind absorbed\|lookup`; `--counts` reports `missed` and `lookups`. Older entries without a kind count as `missed`. Guide, brief and handling guide updated. Test. |
| 21 | A failed or stopped forward names no attempt | Script: lists failed, uncertain, aborted and unsettled attempts with ID, step, status, settlement, reason and files. The narrow read gives `reason` (a failed command's summary) and `failure`; it has no `notice`, so the script uses one if a later release adds it. **Follow-up (runtime):** add `notice` (`attemptNotice`, including the action's own notice) to the narrow read's attempts. Today the action's notice is reachable only through `action-result.json`. Test. |
| 22 | An uncertain attempt's cause is in `provider/stdout.jsonl`, and the operator's next step is not stated | Handling guide flow-notice rule: where the cause is for a model step, and that the operator settles it with `reconcile --attempt <id> --note`, after which a newer notice follows. |
| 23 | A notice older than the flow's current state is not marked | Script: "This notice is older than the flow's current state: the notice says stopped, the flow now reads failed…". Test. |
| 24 | Proxy latency: a burst delays an operator question | Guide "Latency" bullet, with the measured figures. **Accepted cost**, not changed: the alternative is waking the large thread for every routine delivery. |
| 25 | The log path was printed as given (a bare file name once) | Script: the path is resolved to an absolute path everywhere it is printed. Brief: `TRIAGE` is one fixed absolute command. Test runs with a relative `--log`. |
| 26 | With fast answers, the orchestrator's first news of a question is its answer | Script: the answer's forward carries the question, choices, context, task and answer time. Handling guide: "A question's first news may be its answer". |
| 27 | `--counts` puts lookups in `missed` | As 20. |
| 28 | The handoff question's own text says to move the notification binding | **Core text change** in `raiseHandoff` (`handoffText`): leave the binding on a triage proxy that forwards to the bound session. Text only and low risk: no logic, choice or field changed, and no test pinned the old wording. The script's handoff ask also says the text does not apply with a proxy, for older releases. `docs/communication.md` updated. Test. |
| 29 | What the `handing-off` choice is for | Core text: there is no need to answer when handing off. Guide handoff step 4 and the handling guide: don't answer; `handing-off` exists only for the record and choosing it is harmless. Removing the choice would be a runtime change; not needed. |
| 30 | The handoff summary needs unsettled deliveries; `--compact` has none, so the full `status` was read | The handling guide says the compact view has no deliveries, and with a proxy `TRIAGE --forwards` shows what was forwarded. **Follow-up (runtime):** a narrow read of unsettled deliveries (for example `status --deliveries`: ID, item, version, status, attempts), so a successor never needs the full `status`. |
| 31 | Delivery rows for long-acknowledged notices still read `delivered` with `inboxStatus: open` and a future `nextAt` | **Follow-up (runtime):** delivery rows keep the item status they were queued with. Settling or refreshing a delivery's `inboxStatus` and `nextAt` when its item closes would make the list trustworthy. No documentation fix makes the stale rows right. |
| 28 (b) | The guide's handoff paragraph says, unconditionally, to move the webhook | Guide "Ordinary threads and orchestrator handoff": with a proxy, the webhook stays and only the session binding moves; without one, move it. Test. |
| 29 (b) | Nothing says how a successor finds forwards sent to the predecessor before it bound | Script `--forwards --since`. Guide handoff bullet and step 3, and the handling guide: list them from the handoff forward onwards and handle each one sent before your `boundAt` that the summary does not mark as handled. Test. |
| 30 (b) | The summary list has no line for deliveries in flight or open notices | Guide handoff step 1 and handling guide step 1: both added. |
| 31 (b) | The flow-notice rule does not mention a completed notice's assumed answers | Handling guide: tell the operator each carried question and the answer assumed before acknowledging. The forward's ask says the same. |
| 32 | No doc names the fields of `status --compact` | Handling guide: `.flows[].state` (not `.status`); `.queue[]` holds queued, claimed and recently finished entries; to-dos are `.obligations[]`; the bound session is `.orchestratorSession`; there are no deliveries. Checked against `service/dashboard.mjs`. |
| 33 | Whether a forward carries the session count | It does (`session delivery <n>/<limit>` on the IDs line). The handling guide now says so. |
| 34 | A wrong `--missed` note cannot be corrected | Script `--correct <at> --note`: appends a correction beside the entry and changes no count. Handling guide and guide. Test. |
| H12 | `triage.mjs --help` said "--help needs a value" | Script: `--help` and `-h` print usage and exit 0. Test. |
| H2 | The tooling-exclusion advice assumes every scanner has an ignore list | `docs/adoption.md`: a table row and a paragraph for scripts that walk the tree themselves, with generic examples and the prefix choice. `SETUP_CHECKLIST.md`: one sentence. |

One more observation from the trial that is not a numbered point: one flow's end produced three forwards within 90 seconds (stopped, stopped again after the operator reconciled, then failed). The "older than the flow" line now tells the reader which is current. **Follow-up (runtime):** superseding an open stop notice when the same flow ends again would remove the extra wakes at the source.

## Review fixes

The independent review of `61709fc` returned "approve with fixes". It confirmed:

- the earlier invariants (locking, pending sends, unknown fields, the re-forward cadence, the re-check);
- the stale-notice line;
- that budget cutting keeps the ask and the IDs;
- that `--verify` is described honestly;
- that the `raiseHandoff` change is text only and correct without a proxy;
- that the two webhook prompts are identical;
- that all 38 points are accounted for;
- neutrality;
- 1,196 of 1,196 tests.

It found two blocking and two non-blocking problems, and asked for required notes. All are fixed. Each new test fails on the script at `61709fc` and passes now.

| Finding | Fix |
| --- | --- |
| 1. P2, blocking: `--forwards --since` compared timestamp strings, so the equivalent cutoff `…T22:30:00+01:00` hid a send that `…T21:30:00Z` showed, and `--since garbage` returned `[]` | `parseSince` accepts only an ISO time (a date, optionally with a time and offset) and returns the instant. `--forwards` and `--counts` compare instants. Anything else throws: the command line exits non-zero with "--since must be an ISO time …" on stderr and prints nothing. Test: four spellings of one cutoff give the same result; six invalid cutoffs are refused by both functions and by the command line. |
| 2. P2, blocking: recorded forwards went over the 8,000-character cap, because the provenance line was added after `fit()` had budgeted the message (8,202 characters in the reviewer's repro) | `runRecorded` reserves room inside the cap for the provenance line before deciding. The reserve is sized with the real proxy ID, delivery ID and log path, and the longest rule and send ID, plus a reset note when there is one. A last guard, `capForward`, applies to every recorded forward, including timer findings and reset notes, which `fit()` does not build. It keeps the headline, provenance and IDs lines and the last line, and cuts the middle, saying how much. Test: a merge question with 20 long carried questions, long title, question and context, and a 196-character proxy ID stays within the cap through `runRecorded` and through the command line, with every required line present. A timer forward with 400 provider holds is cut by the guard and stays within it. |
| 3. P2: a genuine reset forward failed `--verify`, because the `state-reset` line was logged without the send ID the forward got afterwards | The reset line is now written after the send ID is assigned and carries it. The run's own decision line carries a send ID only when that decision was itself a forward. Test: a corrupt state file followed by a healthy timer gives a `state-reset` forward that `--verify` finds and `--forwards` lists once confirmed. |
| 4. P3: the `grep --exclude-dir=tools/factotum` example in `docs/adoption.md` | `--exclude-dir` is documented to match a folder's base name. The GNU grep on the test machine happened to honour the path, but that is not portable, and `--exclude-dir=factotum` would also skip `src/factotum`. Replaced by a `find … -prune` form and a `git grep` pathspec form, both run against a small tree with a decoy `src/factotum`. The other rows were checked against each tool's documented matching. Black's `extend-exclude` is a regular expression, not a list (`'^/tools/factotum/'`). pytest's `norecursedirs` replaces pytest's defaults, so the example keeps them. codespell's `skip` matches paths as walked, so it is run from the root. Ruff and flake8 are now on rows of their own. The Python tools were not installed here, so those rows are checked against documentation only. |
| Also: `--missed` and `--correct` accepted a missing or empty note | Both require a non-empty `--note`. Without one they exit non-zero and record nothing. Test: six missing or blank forms, none recorded. |

**Merge of `main`.** `main` gained one commit since `61709fc` (`2cbfb83`, one line in `docs/one-factory-progress.md`). It merged with no conflicts.

## Runtime follow-ups

1. **The action's notice in the narrow read** (21): add `notice` to `stateView`'s attempts.
2. **A narrow read of unsettled deliveries** (30).
3. **Delivery rows that follow their item** (31).
4. **One open end notice per flow** (the unnumbered observation).
5. **Sender identity in T3** (19): a host feature, not Factotum's.

The earlier follow-up 6 in [proxy-thread-guidance](proxy-thread-guidance.md), the handoff text, is done here as a text-only change. The other earlier follow-ups stand.

## Checked against

- `operations/state-view.mjs`: attempts carry `id`, `step`, `status`, `settledAt`, `reason` and `failure`, but not `notice`. The flow has no `carriedQuestions`. The item is whole, so a merge question's `carriedQuestions` field and a completion notice's context are both there.
- `core/worker-questions.mjs`: `carriedQuestionsText` (the heading the script recognises, numbered lines, "… and N more", the overflow marker) and `carriedQuestionsItem`.
- `core/project.mjs` `flowNotice`: the context is built from paragraphs in this order: reason, "Corrected on the way", carried questions, "Cleanup is outstanding".
- `core/project.mjs` `delivery.ack`: `store.need('delivery', …)` refuses an unknown delivery ID.
- `core/command-help.mjs` and `cli.mjs`: `reconcile --state --attempt --note`.
- The console's artifact names: `provider/stdout.jsonl`.
- `service/dashboard.mjs`: `flows`, `queue` (queued, claimed, and finished within a day), `obligations`.
- The T3 `schedule_task` description: an update changes only the given fields; the signature block reads "Omit for URL token only"; `title` and `clientRequestId` are accepted.

## Not done

- Not exercised in T3: the new setup message, `--set-proxy-id`, and a successor using `--forwards`. The script commands are covered by tests; the T3 steps are untested guidance until the next trial.
- No release notes entry: this is not a release.
