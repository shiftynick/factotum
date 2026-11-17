# Plans 7/8, slice C: exact stored operator grants and relayed answers

Implementation of slice C from [the decision-authority design](../decision-authority-design.md) §10, on top of [slice A](plan-07-08-slice-a.md) and [slice B](plan-07-08-slice-b.md). Not a release, not a live qualification and not an adopter change. Everything here activates only on a migrated (schema 2) database. `starter/compatibility.json` and the schema of new projects are unchanged, and `authority migrate` stays withheld from adopters. On a schema-1 project nothing changes: the grant commands refuse with "needs the migrated authority ledger", an envelope `authority` field is refused before any receipt, operational delegation still approves tasks, and no new field appears in snapshots or task views.

New code: `starter/factory/core/grants.mjs` (issue, revoke, consumption, lapse) and `starter/factory/core/authority-policy.mjs` (normalized authority-bearing policy). Changed: `decision-authority.mjs` (subject digest, relayed-answer record, audit), `decisions.mjs` (grant-backed and relayed dispositions, lapse handling), `delegation.mjs`, `project.mjs` (command envelope, `task.approve`, `task.restart`, `config.update`, `settings.update`, admission and `authorized`), `engine.mjs` (expiry sweep), the project service, the console server and Inbox view, the CLI and command help.

Every write still goes through slice A's `putAuthorityRecord` inside the command's application savepoint, and the slice A/B rules hold: one authority use per disposition; a disposition written before the decision that names it; one-way transitions; usage only increases; ratification bound to its exact predecessor; and the full disposition → use → grant-entry binding in `auditAuthorityRecords`. Every new command (`grant.issue`, `grant.revoke`, `decision.relay`, grant-backed `decision.dispose`, card answers) and the engine's expiry sweep run the task-scoped audit before commit. The scoped audit now also covers every grant with an entry on the task, the task's current approval use, and its relayed answers.

## Commands and records

| Command | Who | Effect |
| --- | --- | --- |
| `grant.issue {expiresAt, entries, notBefore?, grantId?, reason?}` | operator, directly (never delegable, never with `onBehalfOf`, never itself grant-authorized) | Stores an `operatorGrant` to the orchestrator. Each entry is exact and checked against current state before storing. An approval entry pins `taskId`, the current `taskRevision` and the selected `workflowDigest`. A decision entry pins `obligationId`, the current `obligationVersion`, `scopeDigest`, `optionSetDigest`, and either exact `answers` (option ID plus payload digest) or a cancellation `payloadDigest`. `maxUses` defaults to 1. Validity is at most 30 days. Supersession and plan consent cannot be granted. A changed scope needs a new grant. |
| `grant.revoke {grantId, expectedVersion, reason}` | operator, directly | The grant becomes `revoked` (final; usage unchanged). Derived approvals and clearances are invalidated (see below). |
| `decision.relay {decisionId, expectedDecisionVersion, optionId, quote, channel, inboxId?}` | the orchestrator (the operator is refused: it answers directly) | Stores a `relayedAnswer` with status `pending` and opens an operator notice, `relayed-answer:<id>`. It settles nothing. |
| `decision.dispose` | operator directly; orchestrator only with a grant reference | Grant-backed dispositions are `answer` or `cancel`, and only of an `unresolved` decision that applies to exactly one task revision. The operator may cite `relayedAnswerId` to confirm a relay. A grant-backed answer must carry `relay {quote, channel}` (see the review fixes below). |
| `answer` on a decision card | operator directly; orchestrator always with `relay`, and optionally a grant reference | With a grant and `relay`: the card is answered and the decision settled through the grant. With only `relay`: a pending relayed answer is recorded, and the card and decision stay open. A grant without `relay`, or neither: refused. |
| `task.approve` | operator directly; orchestrator only with a grant reference | Records approval provenance `task.approvalAuthority {source, authorityUseId, workflowDigest, grantId?, entryId?}` and an `authorityUse`, direct or grant. |

New record kind `relayedAnswer`, versioned: `pending → confirmed | superseded`. `applied` is written only together with its grant-backed disposition. It carries the decision ID and version, the task revision, scope and option-set digests, `selected {optionId, payloadDigest}`, `relayedBy: 'orchestrator'`, `quote`, `channel`, `commandId`, optional `inboxId`, and `dispositionId` once settled. `decisionDisposition` gains an optional `relayedAnswerId`, and `taskAuthority.lastChange.cause` gains `grant-expiry`.

Reads: the service collection `GET /v1/collections/grant` (refused on schema 1); `snapshot.grants`; `taskView.grantPins`, the exact pins an approval entry needs now; `taskView.approvalAuthorityReasons`; and on the decision view, `relayedAnswers`, `grantCoverage` and `clearanceLapse`. The handshake adds `operatorGrants.v1`. CLI: `command … --authority '{"grantId","entryId","expectedVersion"}'`. Command help covers all of the above, including the lifetime rule.

**Console.** The Inbox has an **Operator grants** section. It lists grants with their exact entries, usage and validity, and offers revoke. It also offers a batch approval grant for the tasks awaiting approval, built from `grantPins`. The exact entries are shown as JSON, with the lifetime rule, before the confirm step. Each durable decision shows relayed answers, the grants naming it and any lapse. It offers "Confirm the relayed answer" (a direct disposition that cites the relay) and "Let the orchestrator answer X (exact grant)", which shows the single exact entry before issue. No default selects an answer.

## Delegation split

- `NEVER_DELEGABLE` is now `grant.issue`, `grant.revoke`, `decision.dispose`, `decision.revoke` and `decision.ratify`. Listing them in `policy.delegatedOperations` is refused. On a migrated project this is checked even in rehearsal mode, where `validateConfig` checks nothing.
- `task.approve` and `answer` stay in `DELEGABLE` for schema 1. On a migrated project, listing them is **operational delegation only**. An orchestrator `task.approve` needs a grant entry, with or without `onBehalfOf`. Answering a decision card needs a grant, or becomes a relay. Ordinary flow questions keep their existing delegation rules (slice D).
- A grant is the authority for its exact use. It does not also require the operation to be in `policy.delegatedOperations`, and `onBehalfOf` stays optional attribution.
- **Compound commands.** `executeCommand` holds one authority context per command, `store.commandAuthority`. `task.restart` keeps its operational permission check. Its nested approval consumes the cited entry exactly once, or the whole restart is refused. A cited reference that the command does not consume is refused, rather than ignored.
- **Config authority.** On a migrated project, an orchestrator `config.update` (full file or `replaceLive`) or `settings.update` is refused if it changes effective normalized authority-bearing policy. That policy is: `policy.delegatedOperations` (with its default), `delegateIntegrationDecisions`, `mergeDecisionRole`, `strictDecisionRole`, `autoMerge`, `recurringTasks` (approval templates), `integrationWorkflows`, and the question roles and flags of the compiled catalog or default workflow. Omitting a key that widens back to its default counts as a change. Operational edits remain delegated.
- **Job-grant laundering.** Only `operatorGrant` records authorize. A job or schedule grant, or the synthetic maintenance `integration.grant`, cited as `authority` fails with "no operator grant". `job.enqueue` cannot run `grant.issue`.

## Consumption, replay and revocation

- **Reference.** `authority: {grantId, entryId, expectedVersion}` is validated in the envelope. It is included in the command digest, the receipt and the `command.*` event, and is forwarded, journaled and digested by the console. The same command ID with a different reference, a dropped reference or a different payload is refused (by the core, and with 409 by the console).
- **Checks at use**, all inside the application savepoint: the actor is the grantee (`orchestrator`); the grant exists in this project and is at the expected version; it is `active` and within `notBefore ≤ now < expiresAt`; the entry's operation and disposition match; task and current revision match; every operation pin matches (workflow digest; decision ID, version, scope, options, answer or exact cancellation payload); and `usage < maxUses`. Then usage is incremented (grant version +1) and a grant `authorityUse` is written. Its `grantVersion` is the version read, and its `consumptionKey = digest(grant, entry, ordinal)`.
- **Nothing is consumed** by wrong scope, wrong time, a stale version, a refused command, or a later failure in the same command (for example, a restart refused at admission). The savepoint rolls back the usage and the use with everything else.
- **Replay.** The same command ID returns its first receipt, even after revocation, with no second use and without claiming current validity.
- **Concurrency.** Two writers serialize through SQLite `BEGIN IMMEDIATE`. The second sees the incremented version (or exhausted usage) and is refused.
- **Lifetime.** A grant-derived approval or clearance authorizes work only while its grant is unrevoked and unexpired. Boundaries read this at once:
  - `authorized()`, which includes the prepared → dispatching transaction, and `admitFlow` refuse an approval whose use rests on a lapsed grant.
  - `decisionHolds` treats a clearance resting on a lapsed grant as `grant-lapsed` and holds `requiredAt`, plus the delivery boundaries if it was a cancellation. A prepared intent therefore fails the slice B fence.
- **Recording a lapse.**
  - `grant.revoke` records it immediately. Approvals are withdrawn (`approvedRevision` null, dequeued, flows stopped with abort, as `task.revoke` does). Clearances become inactive history and their decisions unresolved (as `decision.revoke` does), and an already-dispatched protected effect is recorded as an authority race.
  - Expiry is recorded by an engine sweep each tick (`grant.expired`). Approvals are withdrawn without stopping flows (their next step fails `authorized`). Clearances are lapsed as for revocation.
  - `decision.dispose`, `ratify`, `revoke`, `present` and `relay` also record a lapse first, for the decision version the operator read. So a ratification sent after expiry works even if no tick has run.
  - Effects already performed are never undone.
- **Ratification after expiry** follows slice A/B unchanged: a direct `decision.ratify` of the inactive answer, only while the decision's revision set, scope and options equal what it answered. Across a changed revision it is refused ("answer anew").

## Relayed-answer contract

- A relay is exactly: who relayed it (the command's actor, never a payload field); the operator's words verbatim (`quote`); where they were said (`channel`); and the option the relayer mapped them to. Any other field, such as `actor`, `answeredBy` or `relay.actor`, is refused. `onBehalfOf.principal: 'operator'` does not make it an operator answer.
- A relay never releases a hold on its own. It settles a decision only when the orchestrator also cites a grant entry covering that exact decision version and answer. The relay is then `applied` and named by the grant-backed disposition.
- Otherwise it stays `pending`. It is shown on the decision, and in an operator notice, for confirmation. The operator confirms it by disposing directly with the same option and `relayedAnswerId`. The relay becomes `confirmed`, and the disposition cites it with a direct-operator use.
- Pending relays of a decision version that moves, or of a decision that is settled, become `superseded`, and their notices close.
- The audit checks that the relay and the disposition name each other. They must have the same decision and option, `applied` must rest on grant authority and `confirmed` on direct authority, and the scope, option set and version must be the decision's.

## `authorityUse.subjectDigest`

`authoritySubjectDigest(subject) = digest({kind: 'authoritySubject', subjectVersion: 1, ...subject})` over the exact semantic subject the use authorized:

- **Task approval:** `{operation: 'task.approve', disposition: 'approve', taskId, taskRevision, workflowDigest}`.
- **Disposition or ratification:** `{operation, disposition, decisionId, decisionVersion, scopeDigest, optionSetDigest, revisions: sorted taskId@revision, answer: {optionId, payloadDigest}` or, for cancel and supersede, `payloadDigest: dispositionPayloadDigest(d), ratifies?}`. For a ratification, `operation` is `decision.ratify` and `disposition` is `ratify`.

It is computed at every use: slice B direct dispositions and ratifications, grant-backed dispositions, and direct and grant-backed approvals. The audit recomputes it for every disposition's use, for every grant approval use against its entry, and for each task's current approval use against the task's approved revision and the recorded `workflowDigest`. The slice A test fixtures now carry correct subject digests. Their assertions are unchanged, except that the kind list now includes `relayedAnswer`.

## Enforced now, and left to slices D–E

Enforced now on migrated projects: everything above, on top of slice B's admission (build), protected preparation, dispatch fence and completed-terminal holds. Left:

- **D:** holds at automatic merge-question creation and at answer acceptance for flow merge/satisfied questions. Classification of legacy operator-role flow questions by purpose (they keep existing delegation here). Cached-intent authority digest. Catalog and operation-contract guard declarations.
- **E:** remote reconciliation of raced effects beyond recording the receipt; lost-launch recovery.
- **F–H:** plan consent (`plan.consent` entries are refused at issue), host ask-tool bridging, reports and release review.

Legacy approvals without `approvalAuthority` (from before migration, or recurring) are not checked here. The migration inventory still holds them, unenforced.

## Design questions for root

1. **Grant alone suffices.** A grant-backed approval or answer does not also require the operation in `policy.delegatedOperations`, or `onBehalfOf`. The grant is the scoped operator authority, and delegation stays operational. The stricter alternative would require both.
2. **Grantable scope narrowed.** Supersession is final once written, so a revocable grant cannot back it, and it is refused at issue. Grant-backed disposition is limited to an `unresolved` decision applying to exactly one revision, because slice A's audit binds a grant entry to one revision and a confirmation reopens the decision to a version that did not exist at issue. Confirmation and multi-revision decisions need the operator directly.
3. **Entries pin current state only.** Issue refuses a non-current task revision, workflow or decision version, rather than allowing pre-authorization of a recorded older revision.
4. **Validity cap of 30 days and `expectedVersion` on every use.** Because each use increments the grant version, sequential uses of a batch grant must re-read the version, and two concurrent uses of different entries of the same grant serialize: one is refused and must retry with a new command ID. This is conservative, and it is what makes the race test show exactly one success.
5. **Revocation versus expiry of approvals.** Revocation withdraws the approval and stops its flows with abort, matching `task.revoke`. Expiry withdraws the approval but lets the current step finish: the next step fails `authorized`, and a prepared intent is not dispatched.
6. **Relayed answers outside decisions.** The relay record and its never-settles rule apply to answers to durable decisions only. Standalone informational questions and flow questions keep today's delegated `answeredBy`/`onBehalfOf` recording. Should every orchestrator answer on an operator-role question require a verbatim relay?
7. **The relayer's option mapping** is stored next to the verbatim quote as `selected`. It is the relayer's interpretation, not the operator's words. The operator's confirmation is what makes it an answer.
8. **Synthetic maintenance `integration.grant.actor: 'operator'`** is untouched (slice H). It cannot be cited as authority, but it still mislabels the enqueuing actor.
9. **Rehearsal configs.** `validateConfig` skips rehearsal configurations, so `NEVER_DELEGABLE` is enforced there only on migrated projects (by `settings.update` and `config.update`).

## Verification

Node 26.12.0, host load average about 17–39.

New file `tests/operator-grants.test.mjs`, 14 tests. All use real command paths: `executeCommand`, the project service and the console `/api/commands` endpoint, the CLI `command --authority`, two child processes for the race, the real engine and supervisor, and slice B's fake merge adapter. They cover:

- schema-1 behavior unchanged;
- only the operator directly issues and revokes; delegation, a job and grant self-authorization are all refused;
- exact pins at issue: wrong revision, workflow, task, operation, field, missing or over-long expiry;
- refusals at use, each consuming nothing: wrong project, task, revision, workflow, operation, grantee, grant version, time (not yet valid and expired) and a job-grant ID;
- exactly-once consumption, replay without a second use, and altered payload, reference or dropped reference under the same ID;
- a batch approval cannot answer a decision, on the command or on the card;
- `task.restart` cannot self-approve, consumes its approval entry exactly once, and rolls back with nothing consumed when admission fails;
- an unused reference is refused;
- two processes racing a one-use entry, with exactly one success;
- decision answers: wrong answer, decision, disposition, options or version refused; exact cancellation payload;
- relayed answers: payload actor fields refused, the operator cannot relay, a relay never settles alone, the operator confirms one and the others are superseded, and a grant-backed relay is applied;
- subjectDigest equality and audit detection of tampering;
- revocation after preparation fails the fence, with no launch; replay after revocation; ratification restores;
- expiry is held at the boundary before it is recorded, the engine records it, and ratification is refused across a changed revision and allowed when unchanged;
- approval revocation after a dispatched merge: the effect is not claimed prevented, and the flow is stopped;
- approval expiry after preparation: not dispatched, no launch, admission refused before the sweep;
- policy widening through `config.update`, `replaceLive` and `settings.update` refused, operational edits allowed, and normalized recurrence and question-role comparison;
- persistence across reopened Store connections;
- the console journal and digest with `authority`, including 409 on an altered or dropped reference, and the CLI flag;
- the console Inbox (fake DOM): the exact entries shown before issue are exactly what is sent, a relay is confirmed as a direct operator answer citing it, and revoke is bound to the version read.

`auditAuthorityRecords` is clean after every legitimate history.

Mutation check: each of these changes makes at least one new test fail —

- no usage increment;
- an unused reference accepted;
- no lazy lapse hold;
- the config policy check removed;
- the subject digest not audited;
- a card answer without a grant settling the decision;
- the operator allowed to cite a grant;
- the workflow pin ignored;
- admission ignoring a lapse.

Runs:

- `node --test tests/operator-grants.test.mjs`: **14/14 pass**.
- Focused set, before the console render test was added (new file, durable-decisions, decision-authority-records, authority-migration, communication, delegation, merge-delegation, command-help, console-wiring, console-views, console-details, project-service, live-settings, integration-authority, question-race, workflow-catalog, tasks-queue, inbox-withdraw, actionable-notifications, notification-resolutions, archive-retention): **169/169 pass**.
- `npm test` (first run, before the last test additions): **703/704 pass, 1 fail**. `tests/target-sync-health.test.mjs` failed at file level (`'test failed'`, no assertion: the process ended under load). Rerun alone it passed **14/14**. That file is on schema 1 and does not reach the new code.
- `npm test` (final): **715/717 pass, 2 fail**, at a load average of about 39. Both failures were environmental, and each file passed rerun alone:
  - `tests/decision-authority-records.test.mjs` "supersession by scope removal …": the sandbox's `git commit` was killed with `SIGKILL` during fixture setup. Alone: **14/14**.
  - `tests/original-request.test.mjs` "planner, plan reviewer and builder prompts …": `Configured GitHub account credential unavailable`. Alone: **12/12**.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

Existing test changes:

- `tests/authority-fixtures.mjs` and five fixtures in `tests/decision-authority-records.test.mjs` compute the now-defined subject digest.
- The kind list includes `relayedAnswer`.
- The slice B handshake assertion includes `operatorGrants.v1`.

No other assertion changed. Not verified: console rendering in a real browser (only a minimal fake DOM), and a project in delivery mode with a workflow catalog (approval pins were exercised without a catalog, so `workflowDigest` is the project workflow's digest).

## Independent review fixes

The independent review rejected the change pending two fixes. Both are made, with new tests that fail on 5b6d2ef (only the source files reverted) and pass now.

**1. Grant-backed answers now always carry relay provenance.** Before, `relay` was optional on a grant-backed answer. An orchestrator could cite an exact answer grant with no quote or channel, and the decision resolved with no `relayedAnswer` and a clean audit.

- `decision.dispose` refuses a grant-backed `answer` without `relay {quote, channel}`. Answering a decision card through a grant without `relay` is refused on the card route too, before the card changes. Nothing is consumed and nothing is written.
- Direct operator answers stay exempt.
- A grant-backed cancellation is unchanged. The grant entry pins its exact payload, including the operator's reason, so the orchestrator cannot invent or alter the cancellation payload and there are no operator words to relay. Where the operator authorized several cancellation entries for one decision, the orchestrator may choose among those explicit alternatives; the chosen entry is recorded in the authority use. A `relayedAnswer` records an option mapping, which a cancellation has none of.
- `auditAuthorityRecords` reports a grant-backed answer disposition with no `relayedAnswerId` ("grant-backed answer has no relayed answer …"). The existing checks still require that link to be mutual, `applied`, and backed by grant authority.
- `selected` is documented, on the record schema and on `writeRelay`, as the relayer's mapping. It takes effect only through a direct operator confirmation or an exact grant.
- Command help for `answer` and `decision.dispose` states the requirement.

**2. Approval and grant revocation now audit before commit.**

- `task.approve` runs the task-scoped audit after its mutations, inside the application savepoint, on migrated projects. This covers direct approvals, grant-backed approvals and `task.restart`'s nested approval. A failing audit rolls back the approval, the grant usage increment and the grant `authorityUse`; for a restart, the whole command rolls back.
- `grant.revoke` audits every task named by the grant's entries, whether the grant was used or not, in addition to the tasks whose derivations were invalidated. `grant.issue` already audited every task its entries name.
- Engine expiry is unchanged: it audits the tasks whose derivations it invalidates.

**Tests.** Two new tests in `tests/operator-grants.test.mjs`, both on real command paths:

- **Missing provenance is refused.** A grant-backed answer without `relay` is refused with and without `onBehalfOf`, and on the card route. Usage, grant version, uses, relays and dispositions are all unchanged, and the card stays open. With `relay`, the same answer applies the relay. The audit flags the disposition once its relay link is stripped. A direct operator answer needs no relay.
- **Audit failures roll back.** With corrupt evidence (a decision naming a missing active disposition), a grant-backed `task.approve`, a direct approval and a grant-backed `task.restart` are each refused. Approval, usage, uses and flows are unchanged. Revoking an unused grant naming the task is refused, and the grant stays active at version 1. Once the evidence is repaired, both commands succeed and the audit is clean.

Mutation checks: removing the revoke audit, removing the relay requirement, or removing the audit's relay check each makes one of these tests fail.

Existing tests changed to match the contract:

- Five grant-backed answers in `tests/operator-grants.test.mjs` now pass `relay`, as do four refusal probes, so they still reach the scope check they test.
- The slice A `grantedAnswer` fixture in `tests/decision-authority-records.test.mjs` now writes its applied relayed answer.
- Two derived cases there drop the relay link where the history becomes direct: the switch to a direct use, and the ratification, which the real `decision.ratify` writes without a relay.

Runs (load average about 15–23):

- `node --test tests/operator-grants.test.mjs`: **16/16 pass**. On 5b6d2ef source: 14/16, and the 2 new tests fail.
- Focused set (operator-grants, durable-decisions, decision-authority-records, authority-migration, delegation, merge-delegation, project-service, console-*, command-help, original-request, communication, integration-authority, live-settings): **140/140 pass**.
- `npm test`: **719/719 pass**.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

Design question 6, whether every orchestrator answer to an operator-role informational question needs a verbatim relay, is still the operator's to decide. Informational and flow questions are unchanged.

Re-check of `ff84bcb` (GPT-6.1 Sol): **approve with fixes**; both findings resolved, the cancellation exemption accepted, and one documentation correction (above) applied by root. Noted limit, unchanged: callers can self-declare `actor: "operator"` through the trusted local interface, consistent with the documented same-account trust model; this is not independent human authentication.
