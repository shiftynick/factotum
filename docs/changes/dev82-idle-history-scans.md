# dev.82: idle cost grew with settled history

Implementation on branch `t3/idle-history-scan-fix`, merged with main at a0efba0 (the waiting-question change and planning convergence) and revised after independent review (see Review fixes); not a release. Found by read-only measurement of a long-running adopter on an earlier release; current main has the same code paths.

## Problem

An idle project service (no events for an hour, no provider work) used a whole core and read about 650 MB/s from its own state database. Its state held 2,615 attempts in 185 MB, 173 MB of which was the `intent` field: the complete dispatch input, stored inline on every attempt. Another adopter with a short history idled at about 9%.

Two causes, both linear in total history:

1. **Whole-kind reads on every tick and poll.** `store.all(kind)` reads and parses every record of a kind. The engine tick (every 75 ms) read every flow. The operations tick (every second) read every flow six times, every job three times, every queue entry and inbox item three times, and opened one transaction per inbox item ever answered. The console's poll projected fields in SQL, which still made SQLite read every task, flow, job and attempt, and its queue status parsed every attempt.
2. **The intent on the hot record.** Any read of attempts, in JavaScript or in SQL, paid for the intents: 93% of attempt bytes.

Profile of the base code idling on the synthetic state below (`node --cpu-prof`, 15 s): `Store.all` accounts for 36.5% of all samples and 87% of the non-idle time; the engine tick for 23.8%, the operations tick for 13.7% (`observeQueue` 4.1%, `captureConflictScope` 3.9%, `backfillFinishedAt` 2.1%, `retryPendingCleanups` 1.9%).

## Measurements

Synthetic state from `node evals/idle-history.mjs generate <dir>`: 3,000 settled attempts (249 MB, intents 35–105 KB), 1,000 finished flows, 1,000 tasks, 400 answered questions with waits, deliveries and contexts, 600 jobs, 5,700 host samples, 17,600 events; 268 MB on disk, written in the earlier release's layout. `node evals/idle-history.mjs measure <dir> [--code <base checkout>]` runs either code on a copy. Same host, same state, 30 s idle; "read" is `/proc/self/io` rchar, "parsed" is bytes given to `JSON.parse`. "After" is this branch with main merged in and the review fixes applied; they changed only the one-time migration (1.1 s before them).

| | Before (93395cf) | After |
|---|---|---|
| Idle service CPU | 41.8% (25,073 ms per minute) | 0.6% (345 ms per minute) |
| Idle service bytes read | 357 MB/s, 87,396 read calls/s | 0.00 MB/s, 0 read calls/s |
| Idle service JSON parsed | 153 MB/s | 0.01 MB/s |
| One engine tick | 20.8 ms, 19 MB read, 8.3 MB parsed | 0.05 ms, nothing read |
| One operations tick | 143 ms, 129 MB read, 54 MB parsed | 0.30 ms, nothing read |
| Console poll (`GET /v1/snapshot`) | 879 ms, 1,289 MB read, 251 MB parsed | 5.1 ms, 0.21 MB read, 0.29 MB parsed |
| Flow detail (`GET /v1/flows/:id`) | 662 ms, 758 MB read | 3.5 ms, 2.1 MB read |
| Timeline, 72 h | 707 ms, 776 MB read | 5.9 ms, 2.9 MB read |
| Statistics, 12 weeks | 663 ms, 785 MB read, 259 MB parsed | 74 ms, 44 MB read, 23 MB parsed |
| Attempt page, 100 rows | 47 ms, 245 MB read | 2.8 ms, 0.5 MB read |
| CLI `status` | 6,571 ms, 6,874 MB read | 166 ms, 366 MB read |
| First start: the one-time migration | — | 2.5 s |

"Nothing read" means the pages were already in SQLite's cache: an idle tick touches a few index pages and the `meta` rows. The remaining idle CPU is the 13 timer wakeups a second.

The test `tests/idle-history-scans.test.mjs` bounds the same thing without timing: an idle engine tick plus operations tick is 86 statements returning 62 rows and 14 KB (configuration and status rows from `meta`, and the schema version and verification record each targeted read checks), and an idle poll 166 statements, 298 rows and 117 KB, with identical statement and row counts for 2 MB and 86 MB of attempt history.

## Design

All in `records(kind,id,data)`; the schema, the tables and `schemaVersion` are unchanged. The layout and the reads over it are in the new `core/records.mjs`.

**1. The intent is stored apart.** In a database that stores intents separately, `Store.put('attempt', record)` writes the intent as a record of kind `attemptIntent` under the attempt's id, and the attempt without it. The intent is written first, so a crash between the two writes can leave an intent without an attempt but never an attempt without its intent. A stored intent with the same value is left as it is, text included; a changed one is stored, so nothing can read a stale intent. `Store.get`/`need` and `Store.all('attempt')` return the complete attempt, so every reader that takes one attempt (the engine's dispatch and settlement, `writeIntent`, `inspect`, `reconcile`, the authority-race check, `attempt.resolve`) is unchanged and cannot see a missing intent. The new targeted reads return attempts as stored, without it; `Store.intent(id)` loads one. One rule decides which intent an attempt has, in every read: if the attempt's own record has an `intent` member, the intent is what `JSON.parse` reads there (the last of several members, a null included); only otherwise is it the separate record's.

The layout is a property of the database, not of the runtime. Intents are stored separately only while the layout fence is installed (see Migration); without it this release writes an attempt whole, exactly as the earlier release does.

Why a record kind and not a table: everything that treats `records` generically keeps working unchanged (backup is a whole-database copy; retention scans every record for cited paths; the schema-2 write fence lists the tables). A new table would have had to be added to each.

Why not a lazy property: a hidden load on `.intent` would let any loop over attempts silently bring the cost back. Whole-attempt reads stay complete and explicit; list reads are explicitly without.

**2. Live sets and lookups, each with an index.** `LIVE` defines, per kind, the records that are not settled history: unfinished flows (plus finished ones still owed a `finishedAt` repair or a cleanup retry), unsettled attempts, open project tasks, open inbox items, queued or running jobs, queued or claimed queue entries, open waits, unresolved obligations, unapproved findings, pending deliveries. `Store.live(kind)` reads only those, through a partial index. Call sites changed from `store.all(kind).filter(f)` to `store.live(kind).filter(f)` with the filter untouched; the change is correct when `f` selects only rows the live set admits, which the test checks for every filter over records with missing, null, empty and wrongly typed fields. `Store.by(kind, field, value)` looks records up by `flowId` (attempts, inbox, waits, contexts, pushback, obligations, regressions), `taskId` (flows), `inboxId` (deliveries) or `operation` (jobs). `Store.recent(kind, n)` replaces `all(kind).slice(-n)`, `Store.count(kind)` replaces `.length`, and `Store.stored('attempt')` is every attempt without intents, for history views.

Totals and latest-of answers come from indexes: the budget total from an index holding only attempts with a cost (none in subscription mode); the run count and last run of a schedule; the last queue dispatch; the last occurrence of a recurring task; task counts. These use expression indexes, which SQLite maintains on every write. Nothing is cached or counted in application state, so nothing can go stale.

SQL reads a record's fields only for a kind that is verified. SQLite's JSON functions read the first of two members of one name and `JSON.parse` the last, so an index key, a predicate or a projection computed by SQL is the JavaScript value only when no object in the record has such a pair. The migration checks every record of the indexed kinds for that before it creates a kind's indexes; the fence then keeps the kind that way, because only `Store.put` (which writes `JSON.stringify` output) and the migration (which keeps text it has checked) can write. `Store.verified(kind)` is true when the fence is installed, the verification record (`meta.recordsVerified`) names the kind and the kind's indexes exist; that record is written only by the transaction that checks the kind and deleted, with every index, by the transactions that install and lift the fence (see Review fixes, round 4); for any other kind, and for the whole database before it is converted, each targeted read parses the whole kind in JavaScript, exactly as the code it replaced did (see Review fixes, round 3).

SQLite has no statistics here and, with several partial indexes on one kind, picked a wrong one in testing (a read of live tasks went through the index of all project tasks). Each targeted read therefore names its index (`INDEXED BY`), which also turns a read its index cannot answer into an error. The name is given only for an index that exists with this release's definition behind the fence (`Store.hint`, re-read when `PRAGMA schema_version` changes).

**3. The one pass that could not be indexed.** The operations tick made sure every inbox item in a notifying status has an operator delivery for its current version, opening a transaction per item, every second. The delivery id is a digest of item id, version and channel, so the pass now reads ids and versions from an index and probes the primary key for each; only an item without its delivery is opened. The pass is skipped while the database is unchanged (`PRAGMA data_version` for other connections, `total_changes()` for this one) since a pass that found nothing to queue. The token is taken before that pass reads, so "unchanged" means nothing was written since before it looked, and what it looks at (statuses, versions, delivery ids) does not depend on time.

## Migration, versions and rollback

**No schema version is bumped; a write fence keeps earlier releases out.** `schemaVersion` stays 1 (a schema-2 database stays 2) and a release still declares `schemaVersions: [1]`. An earlier release reads an intent only inline, so it must not work on a state that stores intents separately. What an earlier release enforces when it opens a database is only `schemaVersion` (1, or 2 with the authority marker and its fence). Schema 2 is the withheld decision-authority ledger, so a new number would have to compose with it, and using one is the operator's decision; it is listed under Limits as the stronger option. The mechanism used instead is the one the authority migration already relies on and that no earlier runtime can bypass, because SQLite enforces it inside that runtime's own connection: `BEFORE INSERT/UPDATE/DELETE` triggers on `meta`, `records`, `events` and `commands` that call `factotum_attempt_intent_layout()`, a function only a runtime that reads both layouts registers. On any other connection every write fails with `no such function: factotum_attempt_intent_layout`. The fence does not stop an earlier runtime from opening and reading the database.

The fence and the layout go together: separate intent records exist only while the fence is installed. The migration installs the fence before it moves the first intent; `layout inline` removes it in the transaction that finds no attempt's intent stored separately; and `Store.put` writes an attempt whole whenever the fence is absent. `initProject` creates new databases fenced. `starter/compatibility.json` gains `"recordLayouts": ["inline", "separate-intents"]`, which a release without this layout lacks.

`operations/state-layout.mjs`, with the text handling in `core/intent-text.mjs`:

- **When.** `startProjectService` runs `migrateStateLayout` after taking the runner lock and before serving. Other processes that run this release's code before that (the CLI recommissioning and doctor that `upgrade apply` runs before the service starts) read and write the inline layout as it is. `layout migrate` does the same offline.
- **What.** Install the fence. Then, for each attempt whose record has an `intent` member (decided by the same scanner that cuts the text, which agrees with `JSON.parse`; SQLite's JSON functions are not used for it, see Review fixes, round 2), in transactions of at most 8 MB: cut the record text at the intent member's exact span into the attempt text without it and the intent record `{"id":…,"intent":<the value text as written>,"restore":{…}}`. Nothing is parsed and written back. `restore` holds what puts the member back exactly where and how it was spelled (offset, the key-and-colon text, the comma) and the SHA-256 of the shortened attempt text it applies to. Before anything is written for an attempt, three checks: both texts parse; they hold the same values as the original; joining them again gives the original text exactly. Then the indexes are created and `state.layout-migrated` is recorded.
- **Refusal.** An attempt that fails a check, or whose record no cut can take apart unambiguously (two `intent` fields, for example), is not changed: it stays inline, is listed in the result, the event and `layout status`, and is read correctly as it is. Later runs refuse it again without recording anything.
- **Digests.** `intentDigest`, the receipt's `intentDigest` and `synthetic` checks, `writeIntent`'s comparison with `intent.json` and reconcile's digest checks are all computed over the parsed intent value. The value parsed from the separate record is the value parsed from the original record (the same text), so each of them gives the same result before and after; the test compares them on an intent with an escape, an exponent and an integer beyond 2^53.
- **Idempotent.** A second run finds nothing, writes nothing and records nothing.
- **Interruptible.** After a failure or a crash, each attempt is either wholly moved or wholly unmoved; the next run moves the rest. Tested with a fault inside a transaction and with the migrating process killed (`SIGKILL`) in the middle of a later one.
- **Failure.** Recorded as `state.layout-migration-failed`; the service starts on the earlier layout.
- **Cost.** 2.5 s for the 268 MB state (three runs). The file grew by 3%; freed pages are reused and `VACUUM` is not run.

**Back to the inline layout** (`inlineAttemptIntents`, `layout inline`): each intent is put back by joining text. An attempt record unchanged since its intent was cut out gets its original text back byte for byte (`restore`); on the 268 MB state the whole `records` table was identical after migrating and inlining. An attempt this release wrote, or rewrote after the migration, has no earlier text to return to: it gets the text this release writes for an inline attempt (intent immediately before `intentDigest`), with the intent's bytes exactly as stored. An attempt that cannot be rebuilt is refused and reported, and the fence then stays.

**Returning to an earlier release** needs the inline layout first, and only this release's code can produce it:

- `upgrade apply --merge`, `upgrade apply --activate` and `upgrade activate` (`finishUpgrade`) read the target release's `compatibility.json`; when it does not declare `separate-intents` they inline the state and remove the fence, with the runner stopped and before the backup, so the backup too is in the layout the target reads.
- `restore` copies a backup as it is, fence included: a backup of a fenced state stays fenced for an earlier release. `restore.release` only lifts the recovery hold and is unaffected.
- A manually started earlier CLI or service cannot be converted for: it can open and read a fenced state, it concludes wrongly about attempts whose intents it cannot see, and it can record none of it. The operator runs `layout inline` with this release (or restores the pre-upgrade backup).

## Public views

No field of `publicAttempt`, the snapshot, the dashboard snapshot, flow detail, the timeline, statistics or any collection changed. The 93395cf code on the unmigrated state and this code on the migrated one produced byte-identical JSON (2.4 MB and 1.9 MB) for the CLI snapshot, dashboard snapshot, queue status, timelines (6/24/72 h), statistics (7 d/30 d/12 w), attempt and flow collections, retrospectives, metrics and the complete first attempt, on two states: the settled 3,000-attempt one, and one with running, waiting and stopped flows, unsettled and uncertain attempts, a queue, schedules with scheduled and manual jobs, occurrences, obligations, findings, a flow without `finishedAt`, one without a task snapshot and one with cleanup pending.

Added, none of it public data: record kind `attemptIntent` (not served by `/v1/collections`), `meta.stateLayout`, the twelve `factotum_layout_fence_*` triggers, `recordLayouts` in `compatibility.json`, events `state.layout-migrated`, `state.layout-migration-failed`, `state.layout-inlined` (the first appears once in a project's recent events after its upgrade), CLI `layout status|migrate|inline`, and the step `layout` in the result of `upgrade apply` when it moves to a release that reads intents only inline.

Two behaviours differ at the edges. In the separate layout, a `put` of an attempt without an `intent` field leaves the stored intent in place (it used to drop it; no caller did that). A write of malformed JSON to one of the indexed kinds now fails at the write (it used to succeed and break every reader of that kind).

## Call sites

Changed to `live`, with the filter unchanged:

| Kind | Sites |
|---|---|
| flow | `Engine.tick` and the machine-sample capacity count; `backfillFinishedAt`; `captureConflictScope`; `observeQueue`; `retryPendingCleanups`; the maintenance capacity check; `admissionReasons`; `flow.start` capacity; `restore.release`; `config.update` drain and rebind; `settingsView`; `drainReasons`; `upgradePreflight`; `resolveInstallation`; doctor; exclusive maintenance; retention's state guard and plan; cleanup's workspace-sharing check; model pinning |
| attempt | queue status (launch stalled); snapshot and dashboard reserved budget; `restore.release`; `drainReasons`; `upgradePreflight`; doctor; exclusive maintenance; retention's state guard and plan; `metrics` unresolved count |
| inbox | the engine's question step; standalone-question expiry; the stranded-question repair; retention |
| job | the running-job repair; the stale-grant check and candidate choice; `verifying`; `ensureTargetSync`; main-health reason |
| queue | the claimed-entry repair; the operations tick's check for queued work before it observes workspaces; `orderedQueue`; `queueRevision`; `observeQueue`; queue-on-approval order; `waitingOnMain`; `probeTargetHead`; snapshot queue tasks |
| task | approval-needed counts; `scheduledRows` |
| obligation | `drainReasons`, carried obligations, retention |
| delivery | `deliverDue` and the session-count pass |

Changed to `by`: flow detail (attempts, inbox, waits, contexts, pushback, obligations, regressions); task detail and every "flows of this task" read in `project.mjs`; `flowNeedsAttention` (obligations, attempts); the failed-attempt receipt in `flowNotice`; open questions and notices of a flow; timer waits of a flow; a flow's unsettled attempts in cleanup; prior deliveries of an inbox item; the retrospective; the timeline's attempts and waits; failed `main.verify` jobs; pushback de-duplication in the engine.

Changed otherwise: the CLI snapshot's lists (`recent`), task counts and budget; the dashboard snapshot (live sets, the latest 20, counts, the queue from its live set plus entries claimed in the last two days, queued tasks by id); `scheduleView` and `scheduledRows` (`scheduleRuns`, `lastOccurrence`); queue status's last dispatch (`latestJob`); the timeline's flows and questions (candidates from the finish-time and creation-time indexes one day wider than the window, then the unchanged exact filter); statistics and `observedStats` (attempts via `stored`; the operation each attempt ran from an index over the intent records; a whole intent only to attribute a model step whose receipt names no invocation); retention's attempt directories (ids only) and its treatment of intent records (same addresses and owning flow as the attempt).

Deliberately left, reading whole kinds:

- Statistics, `observedStats`, `metrics` and the CLI snapshot's queue, schedules and settings read all flows, waits, inbox items and so on: they are views over all history, on demand. They no longer read intents.
- Commands that act on everything or run rarely: `stop.all`, `queue.put`, schedule changes, the recurring-task duplicate check, `retireLeftoverPlans`, source sync's task matching, retention's path collection (it must read every record), workspace cleanup's plan check.
- `core/decisions.mjs`, `core/grants.mjs`, `core/decision-authority.mjs` and `operations/authority-migration.mjs`: active only on schema 2, which is withheld.
- Schedules: bounded by configuration.
- Host samples were already read by id range and pruned after eight days.
- `taskView` reads the event log once per task for approval history (CLI `status` and the Tasks page). That is most of what the CLI snapshot still reads.

## Tests

`tests/idle-history-scans.test.mjs` (3) and `tests/state-layout.test.mjs` (18), with `tests/history-fixtures.mjs`, `tests/fixtures/layout-crash.mjs` and `tests/fixtures/state-release-format.json`. The last is the rows of a state database written by the 93395cf runtime running three real rehearsal flows (completed through a question, failed at a check, waiting on a question), verbatim except for the host boot identifier; tests load it into a database with that release's tables. Larger histories are written as that release wrote them: raw rows, intent inline, no indexes.

- Bounded idle reads: counted statements, rows and bytes, and no statement that reads every record of a history kind, for two history sizes; then with a queued task, an open question, a launch-stalled attempt and a costed attempt, checking the poll still shows them.
- Flow detail, timeline, statistics and an attempt page over the large history.
- Migration of the release-format state: each intent's stored text is the original bytes, each attempt row is the original with exactly the intent removed, complete attempts read back with the same values, no other record changes, every read model is unchanged, a second run is a no-op, and `inlineAttemptIntents` restores the original rows byte for byte and removes the fence. Before migration, a put writes the attempt inline, as the earlier release does.
- Interrupted migration: a fault inside a transaction, then a kill of the migrating process inside a later one; every attempt complete after each; the next run finishes.
- Service start migrates; the offline commands refuse while it runs; a row still in the earlier layout reads correctly and is moved at the next start.
- Intent readers: dispatch of an attempt prepared in the earlier layout through to settlement (written inline while the state is in that layout, moved by the migration, with the effect inspector's result unchanged), with the supervisor's `intent.json` matching the digest; a changed intent is stored; history views attribute a failed review from its intent and recover a brief from one, identically in both layouts; retention protects a file only an intent cites; backup and restore return every attempt complete.
- Every targeted read against the whole-kind filter it replaced, and each read's query plan using its index.
- Review fixes: an intent with an escape, an exponent and an integer beyond 2^53 as the record's first key survives the migration and the way back byte for byte, with every digest over it unchanged, while a record with two intent fields is refused untouched and reported; an intent spelled `"intent" :` is found, moved and restored; an inline intent wins over a separate record in every read and the next migration replaces the stale record (written by the 93395cf `Store.put`); the 93395cf runtime can record nothing on a fenced state and works on it after `layout inline`; `upgrade activate`, `upgrade apply --merge` and `upgrade apply --activate` to a release that does not declare the layout inline the state before the backup.
- Review fixes, round 2: records with several `intent` members, a null first or last member, an escaped key and a nested `intent`, read through every reader and compared with `JSON.parse(data).intent`, and counted, refused and reported by status and migration.
- Review fixes, round 3: an intent that gives `operation` twice, and one that gives a model twice three levels down, are refused and statistics are identical before and after migration; a flow, a job and an intent record that give a field twice are read as `JSON.parse` reads them by `live`, `by`, the job helpers, statistics and the dashboard, their kinds reported and left unindexed until a `put` repairs them.
- Review fixes, round 4: the migration killed right after the fence commits over indexes that outlived the last fence, and the migration and its reverse killed before and after every one of their transactions, each followed by the consistency checks and a finished run.

The existing reconcile tests (which change an intent and expect the digest mismatch) and archive-retention tests (which rely on the `intent.cwd`, `intent.action.stateDir` and `intent.action.config` exemptions) run on attempts stored the new way and pass unchanged.

Fail-before, with the new test files copied onto the 93395cf source:

```
✖ an idle service tick and console poll read a bounded amount, whatever the settled history
  AssertionError: small: an idle tick reads every record of flow,inbox,job,queue,schedule
✖ current work is read in full while history stays out of the tick and the poll
  AssertionError: Expected values to be strictly deep-equal: + ['flow','inbox','job','queue','attempt','flow','job','queue','task']  - []
✖ flow detail, timeline and statistics over a large history read no dispatch intent
  AssertionError: flow detail looks its records up by flow
✖ tests/state-layout.test.mjs
  Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/starter/factory/core/records.mjs'
```

The layout tests can only fail that way on the base: the migration and the targeted reads do not exist there.

## Merge with main

Main was merged in at a0efba0. It brought the waiting-question change (a flow parked on its open question is stepped only when the store changed, its question expired or its checkout needs revalidation) and planning convergence (plan questions in the inbox, capped clarifications).

- **One conflict, `core/engine.mjs`, in two places.** The tick loop keeps the waiting-question change's form (forget parked entries of flows no longer listed, observe checkouts, skip quiet flows) and reads `this.store.live('flow')`. A finished flow is no longer listed, so its parked entry is dropped by the "no longer listed" rule rather than by the terminal-state branch; the result is the same. The question step keeps planning convergence's supersession of a question about an earlier plan and finds the flow's open question with `s.live('inbox')`.
- **One change token.** `Engine.storeVersion()` is removed; the engine calls `Store.changeToken()`, which returns the same string from the same two reads. Parking, waking and the inbox delivery pass now share it.
- **The operations tick's `observeWorkspaces`** reads `store.live('queue')`.
- **Planning convergence adds no read of a whole kind.** `core/plan-questions.mjs` reads no store; clarification counts live on the flow record; the plan-question supersession goes through `supersedeOpenQuestions`, which already looks inbox items up by flow. The waiting-question change's own reads are bounded: one probe of the event log above a remembered sequence, and `max(sequence)`.

All 17 tests of `tests/waiting-question-fingerprints.test.mjs` pass unchanged, including the one asserting which checks fingerprint under the write lock. The bounded-read test counts two more statements per idle tick than before the merge: the engine's change token.

## Review fixes

Independent review of 3fb17d2 rejected it on three findings and noted a fourth. Each was reproduced from the reviewer's probes and is covered by a test with the reviewer's inputs or shape.

1. **The migration and `layout inline` did not preserve bytes.** The migration parsed the record and wrote it back, and compared values, which accepts what parsing already changed (`"\u263a"` became `"☺"`, `1e3` became `1000`, `9007199254740993` became `9007199254740992`); inlining rebuilt the record with the intent at a fixed position. Now neither direction reserialises: `core/intent-text.mjs` finds the intent member's exact span and cuts or joins the text there, the intent record keeps what restores the member's position and spelling, and each attempt is checked (same values, and joining gives the original text) before anything is written for it. A record that cannot be handled losslessly is refused untouched and reported. The earlier claim that `inlineAttemptIntents` restores every record byte for byte was true only for records the runtime itself had serialised; it now holds for any attempt record not rewritten since its intent was moved, and the record says what a rewritten one gets. Every digest and check over the intent is computed on the same parsed value before and after.
2. **Nothing kept an earlier runtime off the new layout.** The 93395cf effect inspector returned `uncertain` for a settled attempt (`Cannot read properties of undefined (reading 'synthetic')`), and that judgement, like a failed dispatch, would have been recorded. The earlier claim that an earlier release "works on a drained project" on the new layout was wrong for anything beyond reading. Fence chosen: the SQLite write fence described under Migration, because it is the one mechanism every earlier runtime is subject to without a new schema number, it is already used and tested in this code base for the same purpose, and it leaves the choice of a number with the operator. With it an earlier runtime can record nothing on a fenced state; it can still open and read one. Factotum's own paths to an earlier release convert the state first. Tested with the actual 93395cf runtime from repository history: its inspector's misjudgement is reproduced, every write (raw, command, tick) fails, the state is unchanged, and after `layout inline` it reads the attempt complete, judges it as this release does, and writes.
3. **Readers disagreed once an earlier runtime had written.** `Store.get` preferred an inline intent and `Store.intent` the separate record. One rule now: an inline intent wins, in `get`, `need`, `intent`, `all` and the history views, and the next migration pass moves it out, replacing the stale separate record. Tested with the 93395cf `Store.put` writing a changed inline intent over a migrated attempt (with the fence removed for the purpose; with it, that write is refused).
4. **Detection depended on spelling** (`"intent":` as text, so `"intent" :` was missed while status reported the state current). The migration and `layout status` now decide it from the record's structure, not from a text match (round 2 below corrects how).

The reviewer's other checks (the idle numbers, crash recovery, idempotency, concurrent CLI access, the single-runner start, read-model equivalence, the index predicates, the merge) were re-run where the fixes could affect them: the idle eval is unchanged (0.5% CPU, nothing read), the 93395cf code on an unmigrated state and this code on the migrated one still produce byte-identical read models on the state with live work, and the crash and idempotency tests pass on the rewritten migration.

**Round 2.** The re-check of 4230a11 confirmed the above and found one more inconsistency: with several `intent` members in one record, SQLite's JSON functions read the first and `JSON.parse` the last. `Store.intent` extracted the intent through SQLite while `Store.get` parsed; detection used `json_type`, so a record whose first `intent` member is null (`{"intent":null,"intent":{…}}`) was neither moved nor reported, and a state where it was the only inline intent left reported `current: true`.

- **Readers.** No reader takes the intent through SQLite any more. `Store.intent` is `Store.get(...).intent`, and `get`, `all`, the statistics view and the retrospective decide by whether the parsed record has an `intent` member of its own: if it has, the intent is `JSON.parse(data).intent`, whatever a separate record says.
- **Detection.** The migration and `layout status` count the top-level members named `intent` with the scanner (keys decoded as `JSON.parse` decodes them, so an escaped spelling counts). One member is moved, a null one included, so that readers and storage keep one rule; several are refused as before, reported by the migration and by `layout status` (`unmovable`), and keep the state at `current: false`. SQL only narrows the rows to scan, by text and with no JSON function: a record with such a member contains `"intent"` or a `\u` escape (`records_inline_intent` indexes that), so finding candidates does not read every attempt.
- **Null.** A null intent was previously treated as no intent; it is now an intent member like any other (found, moved, read back as null), which is what the earlier release's readers saw.
- **Test.** The reviewer's two records, plus a null last member, an escaped key and a nested `intent` that is not the attempt's: every reader (`get`, `need`, `intent`, `all`, `by`, `live`, `stored`, `recent`) against `JSON.parse(data).intent` in the inline layout, after migration and with stale separate records added; status and migration counts and refusals; the way back. It fails on 4230a11 with `inline: intent of twice`.

The migration now scans each record once more to count members: 1.8 s for the 268 MB state (1.6 s before), and the whole `records` table is still identical after migrating and inlining it.

**Round 3.** The re-check of bd6b44f found the same disagreement one level down. The operation index over separate intent records is computed by SQLite, which reads the first of two `operation` members where `JSON.parse` reads the last: for an intent `{"action":{"operation":"gate","operation":"provider.review",…}}` whose receipt names no invocation, statistics counted a review before migration and a gate after it. The class is every value SQL computes from a record's body. It is closed in two ways.

- **Intents with a field given twice are not moved.** The migration refuses an attempt whose intent has two members of one name in any object, at any depth (as it already refused two `intent` members): the record stays as it is, is reported (`refused`, and `unmovable` in `layout status`) and keeps `current: false`. Every separate intent record therefore comes from `JSON.stringify` or from a text checked for this. The check counts the members in the text (a string followed by a colon) against the keys of the parsed value; they differ exactly when some object had two members of one name.
- **SQL reads a record's fields only for a verified kind.** The migration now checks every record of every kind an index or a SQL read covers (flows, attempts, tasks, inbox items, jobs, queue entries, waits, obligations, findings, deliveries, contexts, pushback, regressions, occurrences, intent records). A kind with a record that gives a field twice, or that is not JSON, gets no index, is reported (`unverifiedKinds`, `current: false`) and is read whole in JavaScript by every targeted read: `live` returns the kind (callers filter it as they filtered `all`), `by` filters parsed records, and each helper and each dashboard projection runs the expression it replaced. The check runs when the fence is installed, when no check is recorded, and again at each start for kinds last found wanting (a `put` rewrites a record as `JSON.stringify` gives it, which repairs it). The fence keeps a verified kind verified. Without the fence nothing is verified: an unconverted state is read in JavaScript throughout, at the earlier cost, and `Store.hint` names no index.

Every `json_extract`, `json_type`, `->` and `json_object` over `records.data` in this branch's code, and what makes its input free of duplicated fields:

| Use | Where | Input |
|---|---|---|
| `LIVE` predicates, in the partial indexes and in `live` | `core/records.mjs`, `Store.live`, the dashboard | verified kind, else `stored(kind)` |
| `flowId`, `taskId`, `inboxId`, `operation` lookups | `REFERENCES`, `Store.by` | verified kind, else a JavaScript filter |
| Task counts and the recent page; attempt cost total | `projectTaskCount`, `recentProjectTasks`, `attemptCostMicros` | verified kind, else the whole-kind expression |
| Schedule run count and last run; last dispatch; last occurrence | `scheduleRuns`, `latestJob`, `lastOccurrence` | verified kind, else the whole-kind expression |
| Window candidates by finish and creation time | `flowsSince`, `inboxSince` | verified kind, else the whole kind (the caller's filter is exact) |
| Inbox ids and versions by status | `inboxVersions` | verified kind, else the whole-kind expression |
| Operation of a separate intent | `records_intent_operation`, `attemptOperations` | verified intent records (moved intents are checked at any depth), else each intent parsed |
| Dashboard projections, open-record predicates, queue entries by claim time | `service/dashboard.mjs` | verified kind, else the same shape computed from the parsed record |
| Finding inline intents | `INTENT_TEXT`, `records_inline_intent` | no JSON function: text only, decided by the scanner |

Removed: `Store.intent`'s extraction (round 2) and retention's lookup of an attempt's flow, which now parses the attempt. Not this branch's code and unchanged: the reads of `events.payload`, `pendingTargetSync`, the task filter of `/v1/collections/task` and the decision-authority queries.

Two smaller corrections came with the JavaScript paths. A job or occurrence without a time now counts as the newest in the indexed read too, as it did in the whole-kind sort (`String(undefined)` sorts after every timestamp); and `attemptOperations` returns a lookup, not a map.

Tests: the reviewer's attempt, and one whose route gives its model twice three levels down, are refused untouched and statistics are identical before and after migration; a flow SQL reads as completed and `JSON.parse` as running stays in the engine's live set, in its task's flows and in the dashboard as running, a job with two `operation` and `status` members is found as the last dispatch, and an intent record written from outside with two `operation` members is attributed as `JSON.parse` reads it, with those kinds reported and unindexed until a `put` repairs them and the next run verifies them. On bd6b44f the first fails because the record is moved (`refused` is undefined).

The migration now takes 2.5 s for the 268 MB state (1.8 s before): the checks parse each intent and each remaining record once more. The whole `records` table is still identical after migrating and inlining, and the idle eval is unchanged (0.5% CPU, nothing read). The idle tick's statement count rose from 56 to 71: each targeted read checks the schema version to know whether its kind is verified.

**Round 4.** The re-check of d21040c found that verification could be assumed without having happened. `Store.verified` took the fence plus the kind's indexes as proof, `layout inline` kept the indexes, and the migration committed the fence before it verified anything. So: migrate, inline, write a flow with `"state":"completed","state":"running"` while unfenced, start the migration again and kill it right after the fence commits. The reopened state had `verified('flow') === true`, `get` returned the flow as running and `live('flow')` returned nothing. Reproduced on d21040c with a real `SIGKILL`.

Verification is now a record of its own, and both ways into the mistake are closed atomically:

- **The record.** `meta.recordsVerified` names the verified kinds. It is written only by the transaction that checks those kinds' records and creates their indexes (the check now runs inside that transaction), and by `initProject` for a new, empty database, in the transaction that installs its fence and indexes.
- **Readers.** `Store.verified(kind)` requires the fence, the record naming the kind, and the kind's indexes. An index, or a fence, that merely exists proves nothing.
- **Invalidation.** The transaction that installs the fence deletes the record and drops every index of this release; so does the transaction that lifts it. Whatever was indexed before a fence is never trusted behind it, and no index outlives a fence. After `layout inline` the database has none of this release's indexes or triggers left.
- **Unfenced writes** need no step of their own: without the fence there is no record, no index, and no reader that trusts SQL.

Tests: the reviewer's sequence, with the indexes dropped by `layout inline` as now and with them retained as before, killed after the fence transaction: the flow kind is not verified, the flow is read as running and is in the live set, and the finished migration reports the kind and leaves it unindexed. And every other crash point: the migration (12 transactions, over the retained-index state with the foreign flow and job) and its reverse (10 transactions) are each killed before every transaction commits and after it. After each kill the state is reopened and checked: every targeted read equals the whole-kind JavaScript read, a kind is verified only if none of its records gives a field twice and only behind the fence and on record, no record or index exists without the fence, and no attempt lost its intent; then the run is finished and checked again.

Each targeted read now also reads the verification record: the idle tick's statement count is 86 (71 before), idle CPU 0.6% (345 ms per minute; 326 before), still with nothing read from the database file.

Two existing test fixtures changed, not their assertions. The decision-authority tests that run the 23418cb runtime now first return their project to the inline layout, which is the layout that runtime's projects have (their fixture is created by the current `initProject`, which fences new databases). The upgrade tests' fictional releases declare `recordLayouts`, as a release built from this tree does; a new test covers a target that does not.

## Adopter notes

- **First start after adopting.** The project service converts the state to the new record layout before it serves: about 0.9 s per 100 MB of state on the test host (2.5 s for 268 MB, three runs, SSD, `synchronous=FULL`); allow several times that on a slow or busy disk. The console shows the project as unavailable for that moment. It happens once and records `state.layout-migrated`. The database file grows by a few percent and does not shrink. If it is interrupted, the next start continues; if it fails, `state.layout-migration-failed` is recorded and the service runs on the earlier layout at the earlier cost. An attempt that cannot be moved without changing a byte, or whose intent gives a field twice, is left as it is and listed by `layout status` (`unmovable`); a kind holding a record that gives a field twice is listed as `unverifiedKinds` and read without indexes. Either way the state reports `current: false`. Neither arises from records Factotum wrote.
- **After that start, an earlier release cannot write this state.** Its writes fail with `no such function: factotum_attempt_intent_layout`. It can still open and read the state, and what it shows about attempts is wrong, so do not rely on an earlier release's view of a converted state.
- **Commands.** `layout status --state <dir>` shows the layout, whether earlier releases can write, attempts still carrying their intent inline, those that cannot be moved and why, and missing indexes (read-only, any time). `layout migrate` does what the service does at start, with the runner stopped. `layout inline` puts every intent back into its attempt and lifts the fence, with the runner stopped.
- **Rollback.** The backup `upgrade apply` took when adopting this release is in the earlier layout: restoring it is the complete rollback. To keep later work, use `upgrade apply` to the earlier release from this release: it returns the state to the inline layout by itself (step `layout`) before the earlier code is merged. For a rollback by hand (a revert of the adoption commit, another checkout), run `layout inline` with this release's code first, with the project drained and the runner stopped. If the earlier code is already in place, it has no `layout` command and cannot write: run `layout inline` from a checkout of this release, or restore the backup.
- **Two edge behaviours.** Once intents are stored separately, writing an attempt record without an `intent` field no longer removes its stored intent. A record of an indexed kind (flows, attempts, tasks, inbox items, jobs, queue entries, waits, obligations, findings, deliveries, occurrences and the other flow-scoped kinds) whose data is not valid JSON is now refused when written; before, the write succeeded and every later read of that kind failed. Neither can arise through Factotum's commands; they matter only to a project integration that writes the state database directly, and such an integration is also subject to the fence.

## Limits

- Counts answered from indexes (task counts, the flow total, a schedule's run count) and the inbox delivery pass when the database has changed still walk index entries in proportion to history: tens of bytes per record, no record data. A year of an hourly schedule is about 9,000 entries per poll.
- A running attempt is still read complete, intent included, on every engine tick, as before. That is bounded by running attempts.
- The event log is not addressed: `taskView`, the retrospective and statistics scan it.
- The measurements are synthetic and on one host. The adopter's service was also being polled by a console, which the "console poll" row covers separately.
- Window candidates compare times as the ISO strings the factory writes, one day wider than the window. A finished flow whose `finishedAt` is not such a string would be missing from the timeline.
- If a later release redefines an index while another process is mid-read with the old name, that read fails once.
- The fence stops an earlier runtime's writes, not its reads: one started by hand on a converted state opens it and misjudges attempts in memory. Making it refuse at open needs a `schemaVersion` it does not know, and with 2 reserved for the withheld authority ledger that number and how the two compose are the operator's to decide. The fence does not preclude adding one later.
- One effect of an earlier runtime is outside the database and so outside the fence: for an attempt that was prepared but whose `intent.json` was not yet written (the engine writes it in the same step, so this needs a crash between the two), an earlier engine would write an `intent.json` without the intent before failing. This release then stops that flow with `existing intent differs`.
- Byte-for-byte return applies to attempt records not rewritten since their intent was moved. Records this release wrote in the separate layout never had an inline text.
- A kind that holds a record giving a field twice is read whole in JavaScript until that record is rewritten; the idle cost of that kind is then what it was before this change. Such records do not come from Factotum.
- A state converted by an earlier commit of this branch has no verification record in the current form: it is read in JavaScript until the next service start, which checks it and records the result.
- The bounded-read tests write about 100 MB of temporary state at a time (an 86 MB history, twice in sequence), under the system temporary directory. The tests that run the 93395cf or 23418cb runtime need those commits in the checkout's history and are skipped visibly without them.
- No release notes entry or version change is included; the adopter notes above are the material for one.
