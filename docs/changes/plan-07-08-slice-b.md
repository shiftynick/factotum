# Plans 7/8, slice B: durable decisions, direct operator first

Implementation of slice B from [the decision-authority design](../decision-authority-design.md) §10, on top of [slice A](plan-07-08-slice-a.md). Not a release, not a live qualification and not an adopter change. Everything here activates only on a migrated (schema 2) database, and `authority migrate` stays withheld from adopters. `starter/compatibility.json` and the schema of new projects are unchanged. A schema-1 project behaves exactly as before: every new command refuses with "needs the migrated authority ledger", publication keeps its v1 field set, and no lookup returns a hold.

The new code is in `starter/factory/core/decisions.mjs`. It writes only through slice A's `putAuthorityRecord`, inside the command's application savepoint, so a rejected command leaves nothing behind. It keeps slice A's rules: a disposition is written before the decision that names it, one authority use backs exactly one disposition, ratification names its exact predecessor, and inactive evidence is never reactivated in place.

## Commands

| Command | Who | Preconditions | Effect |
| --- | --- | --- | --- |
| `decision.open` | operator or orchestrator (opening only adds a hold) | `expectedRevision` is the task's current revision, which has a snapshot; not a maintenance task; 1–16 options `{id, label}` (`discuss` is reserved) | `decisionObligation` version 1, `unresolved`, one `pending` entry for the current revision. `requiredAt` is always `merge, complete`, plus `build`/`release` if asked; a producer cannot remove them. Advances the task authority revision. Records an authority race if a protected effect is already dispatched. |
| `decision.present` | operator or orchestrator | `expectedDecisionVersion` matches; the decision is not settled for every revision; it applies to the current task revision; no open card for this version | A v2 decision card (see below). Presentation only. |
| `decision.dispose` | **direct operator only** | `expectedDecisionVersion` matches; not superseded; some applicability entry is uncovered; applies to the current revision; `kind` `answer` (an existing option), `cancel` (with `reason`) or `supersede` | Writes a direct-operator `authorityUse`, then the `decisionDisposition` covering every revision the decision applies to, then the decision (`resolved`/`canceled`/`superseded`, every entry `covered`). Retires the decision's open cards. Advances the authority revision. |
| `decision.revoke` | **direct operator only** | version matches; status `resolved` or `canceled` (superseded is final); `dispositionId` is the active one | Disposition and its use become `inactive` (with reason and time). The decision is `unresolved` again, every entry `pending`. Advances the authority revision. Records an authority race for a dispatched protected effect. |
| `decision.ratify` | **direct operator only** | decision `unresolved`, version matches; the named disposition is an inactive answer of this decision, not ratified before; same scope and option-set digests; the decision's revision set equals the one that answer covered and includes the current revision | A new `answer` disposition with `ratifiesDispositionId`, a `decision.ratify` use, the same answer and revisions. Otherwise refused: "answer anew". |

Delegated and orchestrator dispositions are refused for all three operator commands and for an option chosen on a card, with or without `onBehalfOf`, even though `answer` is delegable by default. They are not routed through a placeholder grant. Grants are slice C. A command replayed with the same ID returns its canonical receipt, whether accepted or rejected, and applies nothing twice. The same ID with different content is refused (existing `executeCommand` behavior). `executeCommand` now exposes the command ID to the operation (`store.commandId`) so dispositions and uses name their command.

### Communication v2

On migrated projects only, `handshake` advertises `decisionAuthority.v1` and `standaloneQuestion.v2`.

- `inbox.publish` accepts `purpose: "informational"`, recorded with `publicationVersion: 2`. It is an ordinary question or notice.
- `inbox.publish` with `purpose: "decision"` and `decision: {decisionId, expectedDecisionVersion, taskId?, taskRevision?, scopeDigest?}` is the same as `decision.present`. The binding must match. The card's question and choices come from the decision, and any other field is refused.
- A decision card carries `decision: {decisionId, version, taskId, taskRevision, scopeDigest, optionSetDigest, requiredAt}` and `choices` that map each option ID to `{kind: 'answer', optionId}`, plus `discuss` mapped to `{kind: 'none'}` (omit it with `discuss: false`).
- `answer` on a card: an option is a direct operator `decision.dispose` of exactly the card's decision version, in the same transaction. The card is answered and the disposition names the card. `discuss` records the reply and leaves the decision unresolved. Because it is not a disposition, it accepts a delegated orchestrator reply. A card whose decision version moved is refused ("present it again"). Cards bound to an older version or a settled decision are retired as `superseded` whenever the decision is written. Nothing re-presents them automatically.
- Withdrawal records `withdrawal.decisionRemains`. Expiry, read, acknowledgment, withdrawal and discuss never touch the decision.

## Lifecycle and carry-forward

- **Edit R1 → R2** (`task.put`, in the same savepoint as the snapshot): every non-superseded decision that applied to R1 gains an R2 entry. The entry is `pending` if the decision is unresolved, and `requires-confirmation` if it is resolved or canceled, because an answer never silently follows a changed brief. A revision that returns to an earlier value keeps its existing entry. The decision version advances, the authority revision advances (`decision-carry-forward`), and stale cards are retired.
- **Confirmation** of a settled decision on a new revision is a fresh `decision.dispose`. The old disposition and use become inactive ("replaced by a disposition covering revision R2"). The decision passes through `unresolved` and is then settled again, so it takes two version steps, as the slice A transition rules require. The new disposition covers every applicability revision.
- **Close/reopen** are task edits and follow the same rule. **Stop, resume, fail, abandon, restart, replan** and **candidate replacement** do not touch decisions; holds are task-revision state, not flow state. **`task.revoke`** changes task approval only.
- **Cancel** removes the scope from the revisions it covers. While the cancellation is active, those revisions cannot be merged, completed or released (the cancellation is not clearance). It does not block build. To deliver the remaining work, revise the brief: the canceled decision then needs confirmation on the new revision. Supersede it with `removedScope`, which is tied to that revision. Answering it reintroduces the scope with a decided answer; canceling it again keeps that revision blocked.
- **Supersede** needs either replacements or a scope removal. Replacements are existing decisions of the same task that apply to its current revision, are not superseded, are not the decision itself, and do not lead back to it; they carry the hold. A scope removal names the current revision as `revisedRevision`. That revision must differ from the origin and descend from it through the snapshots. A superseded decision is final.

## What is enforced now

The hold lookup is `decisionHolds(store, taskId, revision, boundary)`. An uncovered entry holds the decision's `requiredAt`. An active cancellation holds `merge`, `complete` and `release` on the revisions it covers. Superseded decisions hold nothing. Boundary checks, keyed by operation semantics, never by node name:

| Boundary | Check in this slice |
| --- | --- |
| Admission (`admitFlow`: `flow.start`, `task.restart`, queue claim) | Refused while a `build` hold applies to the current revision. `admissionReasons` lists `decision-held: …` for queue diagnostics. A refused `task.restart` rolls back its nested approval. Merge-only holds admit work. |
| Preparation of `provider.build` (build), `forge.merge` and `outcome.satisfied` (merge), `forge.closeTask` (complete) | No intent is prepared. The flow waits at the step with `decisionHold {step, boundary, decisions, reasons}` and an event, and continues on a later tick once the hold clears. |
| Prepared → dispatching transaction | Same lookup, under the same serialization as the dispatch decision. A hold that arrived after preparation marks the attempt `not-dispatched`, at zero cost with a reason. The flow's ownership of it is cleared and the flow waits held. There is no launch. A later tick prepares a fresh intent. |
| `end` with outcome `completed`, any flow kind | The flow waits held instead of completing. A recorded merge fact stays. |
| After dispatch | `decision.revoke` or `decision.open` record an authority race (`flow.authorityRaces`, a `decision.authority-race` event, an operator notice). The effect is not stopped, aborted or retried; its receipt is recorded as fact, and completion is then held. |
| Notifications, `level: "actionable"` | `flowNeedsAttention` treats an unresolved or unconfirmed decision on the flow's task, or an authority race, as attention material, so a routine terminal summary is not suppressed. Opening or revoking a decision requeues that task's already-suppressed completed summaries, and delivery reclassifies them on the same lookup. |

Held flows keep their capacity and ownership exactly as before. Holds add reasons, not permits.

Read projections: the service collection `GET /v1/collections/decision` returns each decision with `blocks`, `holdReason`, its disposition history, `ratifiable` and cards; it is refused on schema 1. `snapshot` and the dashboard snapshot add `decisions` (open ones plus 20 recent settled, at most 100). `taskView` adds `decisionHolds`. These are additive and present only on migrated projects. The console allows the five commands and the `decision` collection. Its Inbox shows a separate **Durable decisions** section with task, revision, scope, options, held boundaries and history. It offers answer, cancel, present, ratify and revoke, each bound to the displayed decision version, and no generic "resolve". A decision card notes that withdrawal, discuss and expiry leave the decision unresolved. Command help covers all five commands and publication v2.

## Left to later slices

- **C:** grants, grant use and consumption; authority references in the command digest; delegation split. `decision.ratify` "after grant expiry" is exercised here only after direct revocation.
- **D:** holds at automatic merge question creation and at answer acceptance for flow merge/satisfied questions (a merge question can still be answered, and policy auto-merge still answers it; the merge step is then held at preparation); cached intent authority digest; catalog/operation-contract guard declarations; document, task-graph and integration-specific guards beyond the generic checks above. Trusted argv steps are not protected operations.
- **E:** reconciling remote merge state for raced effects beyond recording the receipt; lost-launch recovery.
- **F–H:** plan consent, worker authority context, decision reports, release review.
- Legacy `authorityHold` and held `legacyAuthority` rows are still not enforced (`authorityStatus().enforcement` remains `not-wired`, which describes them).

## Design questions for root

1. **Cancellation semantics.** I took "prevents that scope from completing as delivered" to mean an active cancellation blocks merge, completion and release of the task revisions it covers, but not build. Delivery then needs a revised brief plus supersession by removal, or an answer. The alternative is to block only some narrower part of the work, which the record cannot express.
2. **Settled decisions on a new revision.** Resolved and canceled decisions carry forward as `requires-confirmation`, and confirmation is a fresh direct disposition. The replaced answer becomes inactive, so it is no longer ratifiable unless the revision set returns to exactly the one it covered. Is a lighter "confirm unchanged" operation wanted?
3. **Supersession atomicity.** Replacements must already exist (open them first, which already holds), instead of being created inside the disposition command. A removal must name the current revision.
4. **Held flow state.** A held flow is `waiting` with `decisionHold` rather than `stopped`, and a fenced intent is marked `not-dispatched` directly rather than through a stop. Both resume automatically once the hold clears. Is automatic continuation after an answer acceptable, or should it require `resume`?
5. **Guards moved forward from slice D.** The minimum the acceptance list needs: admission (build), protected preparation, the dispatch fence and the completed terminal. Merge-question creation and answer acceptance are not guarded yet (see above).
6. **Applicability bound.** A decision has at most 64 applicability entries (slice A schema). A task edited past that while a decision applies to it is refused (fail closed) rather than dropping history. The refusal names the decision and its recovery route (see “Independent review fixes” below).
7. **Option payloads.** Options carry only `{id, label}`. `payloadDigest = digest({optionId, label})`. Options are immutable, so new options need a new decision that supersedes the old one.
8. **Who may withdraw or discuss.** The publisher (including the orchestrator) may withdraw a decision card, and a delegated orchestrator may reply "discuss". Neither changes the decision.

## Verification

Node 26. New file `tests/durable-decisions.test.mjs`, 17 tests, all real command paths through `executeCommand`, the real engine and supervisor, and a fake merge adapter: a trusted step's prepared intent labeled `forge.merge`, which writes a merged action result. The tests cover:

- schema-1 refusal and unchanged v1 behavior;
- an exact answer clearing only its decision;
- read, ack, discuss, withdraw and expiry leaving the hold;
- orchestrator and delegated dispositions refused and writing nothing;
- stale card, decision and task versions;
- replay of accepted and rejected commands, and altered content under the same ID;
- R1→R2, close/reopen and confirmation; `task.revoke`;
- build holds at admission and a whole `task.restart` rolled back;
- stop, resume, abandon, restart, replan and a failing run keeping the hold, released by an operator answer;
- process restart (new connection and engine);
- cancel blocking delivery until supersession by removal on a revised brief;
- replacement validity, final supersession and no cycles;
- revoke before dispatch (no preparation, admission blocked);
- revoke after preparation (`not-dispatched`, no owner or receipt file, flow held; ratify then completes);
- revoke after dispatch (race recorded, merge fact recorded, no retry, completion held);
- ratification limits;
- actionable notifications, including a summary queued before the decision;
- service, snapshot and publication v2 projections;
- the console card sending only bound `decision.dispose` answers and cancels.

`auditAuthorityRecords` is clean after each scenario. Each guard was mutation-checked: removing carry-forward, the dispatch fence, the completion hold, the notification lookup, race recording or the admission check each makes at least one of these tests fail.

- `node --test tests/durable-decisions.test.mjs tests/decision-authority-records.test.mjs tests/authority-migration.test.mjs`: **47/47 pass** (17 new, 30 slice A).
- Focused set (new file, slice A record and migration tests, communication, inbox-withdraw, actionable-notifications, notification-resolutions, operation-contracts, command-help, console-wiring, project-service, merge-delegation, reconcile, tasks-queue, console-views, archive-retention): **134/134 pass** (before the console render test was added).
- `npm test`: **670/674 pass, 4 fail**, at a host load average of about 130. The failures were `tests/commission-maintenance.test.mjs` “main verification preserves dirty evidence…”, `tests/console-details.test.mjs` “flow, collection and artifact reads…” (project request timed out), `tests/operations.test.mjs` “resource coordinator actually serializes simultaneous processes” and `tests/runtime.test.mjs` “supervisor rejects surviving background descendants”. All four are timing-sensitive and run on schema-1 sandboxes that never reach the new code. Each file passes when rerun alone: **9/9, 4/4, 10/10, 16/16**. None of them is on the known-intermittent list, so root may want to look at them under load.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

No existing test was changed. Not verified: console rendering in a real browser (rendered here with a minimal fake DOM only), a delivery-mode `forge.merge` preparation through `actionSpecification` (preparation is held before it, so the fixture uses the fake adapter for dispatch), and grant expiry (slice C).

## Independent review fixes

The independent review rejected 4d68dd1 with two blocking findings. Both are fixed, and the record now also states the edit-limit recovery route.

### P1: restoring a removed scope bypassed the hold

A superseded decision held nothing at any revision, and carry-forward skipped it. Task revision digests are content-addressed, so restoring the original brief after a scope removal produced the original revision again, with its original snapshot. Nothing held it, and a graph ending in `completed` finished with a clean audit.

The rule now, chosen to be conservative:

- **What a removal clears.** A supersession with `removedScope` clears its removal revision (`revisedRevision`). It also clears later revisions recorded from that brief, following each revision’s first snapshot back through `previousRevision`, as long as the walk reaches the removal revision before any revision the decision applied to before the removal. A revision in the decision’s own pre-removal applicability is never cleared, however it was reached. Nothing else is cleared, including a brief from before the decision was opened.
- **Leaving what it clears reopens the choice.** When `task.put` moves the task to a revision the decision applied to before the removal, or from a cleared revision to one that is not cleared, the same transaction creates a fresh decision. It is `unresolved`, has one `pending` entry for the new revision, and has that revision as its origin. It copies the question, rationale, scope, options and `requiredAt`. Its new optional field `reopens` names the superseded decision, and `source.ref` explains why it was opened. The ID is derived from the superseded decision and the revision. Settling it needs new direct operator authority. The superseded decision and its disposition are not touched.
- **No duplicates.** If any reopening of the superseded decision, in any state, already applies to the new revision, it owns the choice there and nothing new is created. A reopening is an ordinary decision: it carries forward on later edits, and if it is itself removed and the brief is restored again, it is reopened in turn. A decision superseded with both replacements and a removal also reopens; its replacements still carry their own holds.
- **Backstop hold.** `decisionHolds` makes a superseded decision with a removal hold its `requiredAt` at any pre-removal revision other than the removal revision, unless a reopening applies there. Every `task.put` creates that reopening, so in normal use this hold never shows. It keeps progression refused if a revision is ever reached without carry-forward.
- **Schema.** `decisionObligation` gains an optional immutable `reopens` ID (slice A schema). The record rule refuses a decision that reopens itself. The audit reports a reopening whose target is missing, is not superseded, or belongs to another task or scope.

Known limit: a later edit made from the removal revision is treated as still lacking the scope. If such an edit puts the scope back in new wording, nothing detects it, just as nothing detects any other new choice in an edited brief. Whoever adds it must open a decision. The alternative, reopening on every edit after a removal, could never be settled: a reopening’s origin is the new revision, and a removal must be later than the origin.

### P2: a removal beside replacements skipped the lineage check

`decision.dispose` checked the removal lineage only when `replacements` was empty. It still recorded `revisedRevision` whenever `removedScope` was given, so a mixed payload at the origin revision was accepted and left history the audit rejected. Mixed payloads are still allowed (part of the scope removed, the rest replaced), but `removedScope` is now always tied to a revised brief: the current revision must differ from the origin and descend from it. The check runs before any write, so a refusal leaves no disposition, use, decision or authority revision behind.

### In-transaction audit safeguard

`decision.open`, `decision.dispose` (including an option chosen on a card), `decision.revoke`, `decision.ratify`, and a `task.put` that carried or reopened a decision all run `auditAuthorityRecords(store, { taskId })` before they return. Any problem refuses the command, which rolls back the whole application savepoint, and the error lists up to five problems. This fails closed: a task whose records already need repair cannot take decision commands until it is repaired, as restore, retention and migration already require.

The scoped audit covers what these commands write for that one task: its snapshots, its authority revision, its decisions, their dispositions, the uses those dispositions cite, and the grants those uses name (only entries on this task). The migration marker, reports, release reviews and legacy inventory are left to the full audit. **Cost bound:** SQLite selects the scoped rows with `json_extract` over the rows of those kinds. That is no more than the full read of decision rows that every hold lookup already does. Only the scoped rows are parsed and validated in JavaScript, so that work grows with the task’s own records, not with the project’s. A `task.put` that touches no decision does not run the audit.

### Edit-limit refusal (design question 6)

When an edit would give a decision a 65th applicability revision, `task.put` is refused. Before this fix the refusal was a schema error. Now the message is: `task.put refused: decision <id> already applies to 64 task revisions, the most one decision records, and this edit would add another. Settle the choice in a new decision first: open a decision on the current revision (decision.open), supersede <id> with it (decision.dispose kind "supersede", replacements [the new decision]), then edit the task again`. Nothing is written. The recovery route keeps the hold continuous: the replacement holds from the moment it is opened, the superseded decision keeps its history, and the retried edit carries only the replacement. A test follows that route.

### Verification

Five new tests in `tests/durable-decisions.test.mjs`, all through real commands:

- exact restoration of the brief the scope was removed from (the reviewer’s scenario, with the correct expectation): a fresh decision holds the restored revision, the superseded decision and dispositions are unchanged, the end-in-`completed` graph waits held, and an operator answer releases it;
- edits after a removal and after a restoration: an edit made from the removed brief stays cleared; a pre-decision brief reopens; returning to a pre-removal revision while the reopening applies does not reopen again; the reopening carries through later edits; removing the reopening and restoring again reopens it exactly once;
- mixed replacement and removal: refused at the origin with nothing written; accepted on a revised brief; audit clean in the command path and after reopening the Store; restoration reopens the removed part;
- the in-transaction safeguard refusing and rolling back an answer over damaged snapshot evidence;
- the edit-limit refusal and its recovery route.

All five fail on 4d68dd1’s source and pass with the fix. Both of the reviewer’s probe files now fail, because they assert the old behavior.

Runs:

- `node --test tests/durable-decisions.test.mjs tests/decision-authority-records.test.mjs tests/authority-migration.test.mjs`: **52/52 pass** (22 slice B, 30 slice A).
- Focused set (communication, inbox-withdraw, actionable-notifications, notification-resolutions, notification-policy, state-notifications, operations, operation-contracts, command-help, console-wiring, console-views, console-details, project-service, question-race, integration-authority, workflow-catalog, delegation, merge-delegation, runtime): **118/118 pass**.
- `npm test`: **678/679 pass, 1 fail**, at a host load average of about 100–117. The failure was `tests/main-health-audit.test.mjs` “timed out main verifier preserves actual partial stdout and stderr and never claims product failure”, a timing test that does not touch decision code. Rerun alone, the file passed **13/13**.
- `npm run eval`: exit 0. `git diff --check`: clean.

### Re-check fixes (root)

An independent re-check of `a76a5f6` confirmed both review findings resolved and raised two new ones on corrupt evidence (no ordinary command path creates either), both fixed with regression tests that fail on `a76a5f6`:

- **Cyclic `reopens` chains (P1).** The full audit now requires every reopening chain to end at an original decision and reports cycles, so restore and Store-level audits refuse such evidence. Independently, the hold lookup treats a decision whose own or whose reopening's chain is cyclic as having no reopening, so the backstop hold on pre-removal revisions stays in place even if corrupt records are read directly.
- **Scoped safeguard and shared uses (P2).** The task-scoped audit used by decision commands now also counts dispositions on other tasks that cite this task's authority uses, so a use shared across tasks is refused before commit rather than left for the full audit.

Verification: `tests/durable-decisions.test.mjs` 24/24 (2 new; both fail with only `starter/` reverted to `a76a5f6`).

Second re-check (approve with fixes) raised two non-blocking follow-ups, both fixed by root: the hold lookup now validates every link of a reopening chain (predecessor exists, is superseded, same task and scope) and requires it to end at an original decision, so acyclic corrupt ancestry ending at a missing record or crossing tasks also owns nothing; and the scoped audit counts shared uses with one scan over dispositions for all of the task's uses together (`json_each`), instead of one scan per use.
