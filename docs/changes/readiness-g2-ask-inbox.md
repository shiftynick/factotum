# Readiness G2: a host ask prompt as the front of the inbox, with schema-1 relay records

Operators want to be asked through their agent host's interactive ask prompt as well as through the inbox and console. This change adds the host-neutral contract for that and a relay record for answers that arrive that way. Not a release and not an adopter change. `starter/compatibility.json`, the schema of new projects and the withheld `authority migrate` are unchanged. A schema-1 project that never sends the new commands behaves as before.

## What the operator decided, and where it is met

| Requirement | How |
| --- | --- |
| 1. One question is shown through the ask prompt and the inbox together | `inbox.present` records a presentation on the inbox item. The item's version, digest, status and wait are untouched, so the console answer stays valid. |
| 2. An answer by either route settles both | Answered in the inbox (or resolved any other way): the pending presentation becomes `obsolete`. Answered through the prompt: `answer` with `presentationId` resolves the item and marks the presentation `answered`. |
| 3. An unanswered ask is withdrawn after a set time; the question stays open | Every presentation has an expiry (default 15 minutes). The factory expires it on its own timer, the item stays open at the same version, and the presenter is woken once to take the prompt down. |
| 4. An open ask never blocks other work | A presentation is a record on the item: no wait, no hold, no version change, nothing in admission or dispatch reads it. The host-side cause (an ask holding the orchestrator's turn) is addressed in the T3 guidance. |
| 5. An answer relayed from the ask is stored as relayed | `answer` with `relay {quote, channel}`: the relayer is the command's actor, the words are stored verbatim, nothing else is accepted. Schema 1 keeps it on the item; a migrated decision card keeps slice C's `relayedAnswer`. |
| 6. Unattested ask answers are relayed | An answer naming a presentation must carry `relay`, and the operator role cannot send `relay`. No attestation mechanism exists, so every answer through a presentation is relayed. |

## Contract

The full reference is in [communication](../communication.md#prompt-presentations-and-relayed-answers). In short:

- **`inbox.present {inboxId, expectedVersion, channel, expiryMs?, id?}`**, by either role. Only an open, unexpired question. `expiryMs` is one minute to one day, default 15 minutes, capped at the question's own expiry. One pending presentation per question, 32 in its life. Unknown fields are refused. Returns `{inboxId, version, subjectDigest, presentation}`.
- **`inbox.unpresent {inboxId, presentationId, reason}`**, by the presenter or the operator. The question stays open.
- **`answer`** gains optional `relay {quote, channel}` and `presentationId`.
- **Presentation record** on the item, `presentations[]`: `{id, channel, presentedBy, presentedAt, expiresAt, status}`, and once ended `endedAt`, `endedBy`, `reason`, and `notify: true` when it ended through someone other than its presenter. Status is `pending`, then exactly one of `answered`, `obsolete`, `expired`, `withdrawn`.
- **Events:** `inbox.presented`, `inbox.presentation-ended {status}`, and `relayed`, `relayedBy`, `channel` on `inbox.answered`.

**Settlement is one sweep, not a hook in every path.** `settlePresentations` runs inside each command's transaction after the operation, and on every operations tick. It reads only the items listed in the `presentedInbox` meta index, so a project with no presentation pays one meta read. It marks a pending presentation `obsolete` when its item is no longer open, whichever path closed it (answer, withdrawal, item expiry, a stopped or abandoned flow, a retired decision card), and `expired` when its time has passed. A question closed by the engine outside a command is settled by the next tick.

**Notifications** reuse the item's existing delivery; there is no new delivery kind or payload field.

- A pending presentation holds *reminders* of that question until it ends. A first delivery, a retry after a failed send and every resolution are sent as usual, so `actionable` and `essential` still deliver the question.
- When a presentation expires, or ends through someone other than its presenter, the item's current delivery is sent once more, at every level, including an item the orchestrator published and a superseded resolution. A delivery that was `delivered` or `suppressed` returns to that status after the wake.
- The orchestrator's own relayed answer is its own resolution and wakes no one, as before.

## Relay record

On schema 1, and for informational and flow questions on a migrated project, the answered item carries:

```json
"relay": {"schemaVersion": 1, "relayedBy": "orchestrator", "channel": "host-ask", "quote": "<the operator's words, verbatim>", "commandId": "<command>", "recordedAt": "<time>", "presentationId": "<id, when it came through a presentation>"}
```

- `relayedBy` is the command's actor. `relay` accepts only `quote` and `channel`; with `relay` present the `answer` payload accepts only its documented fields, so `actor`, `answeredBy` or `relayedBy` are refused rather than ignored. `answeredBy` stays the actor that entered the answer.
- **No new authority.** `relay` is read before the authority checks and written after them; the checks themselves are unchanged. An orchestrator still needs the question's role or a delegated `answer` with `onBehalfOf`; strict-review sign-off and undelegated integration decisions still refuse it; `delegatedOperations: []` still turns it off. A merge authorization made by a relayed answer records `actor: orchestrator, authority: delegated` exactly as today.
- **Visible** on the inbox item in the console (“Relayed answer … not as a direct operator answer”), in History (the Decisions table's “Answered by” column, the record detail, and the answered event's detail) and in `snapshot.inbox`.

**Migrated projects.** A decision card answered with `relay` is unchanged from [slice C](plan-07-08-slice-c.md): a `relayedAnswer` authority record, `pending` until the operator confirms it or `applied` through an exact grant. The card carries no item `relay`. `presentationId` only adds that the presentation is settled and names the `relayedAnswerId`. The item-level record is used there for informational and flow questions, which slice C left with today's recording (its design question 6).

**Carrying it forward at migration.** Nothing is implemented; this is how the schema-2 migration can do it:

1. Inbox rows are not rewritten by the migration, so `relay` and `presentations` survive as they are, and the fields keep their meaning.
2. The inventory classifies only open questions today. When it comes to classify answered ones (slice D's flow-question classification), an item with `relay` is a relayed answer and never `direct-operator`: classification `relayed`, held for the operator, with `{inboxId, commandId, relayedBy, channel}` as evidence.
3. If the operator binds such a question to a durable decision, the fields map one to one onto `relayedAnswer`: `relayedBy`, `quote`, `channel`, `commandId`, `inboxId` (the item), and `selected.optionId` from the item's `answer`. It is written `pending`, so it settles nothing until the operator confirms it, which is the slice C rule.
4. `schemaVersion: 1` marks the shape so a later reader can tell it from a newer one.

## Host-neutral boundary

Core knows a channel only as a bounded string chosen by the presenter. It never calls a host, holds no host identifier, and has no host-specific branch. The T3 specifics live in [the T3 integration guide](../integrations/t3.md#asking-through-the-ask-prompt) and the starter's `project/integrations/t3-notifications.example.md`. Removing the host leaves the inbox and console sufficient; a presentation left behind expires by itself.

## T3 guidance, and what was verified about the host

Verified by reading the tool descriptions available to an agent in a T3 session on 2026-11-14. Nothing was sent; one read-only `t3_pending_request list` in the implementing session returned no pending requests.

- The ask tool takes one to four questions, each with two to four options and an automatic free-text “Other”. It has **no timeout, expiry or cancel parameter**. The answer is the tool call's result, so the asking turn waits for it.
- `t3_pending_request` has `list`, `read` and `respond`. There is **no withdraw**. `respond` lets an agent answer a pending question, so an ask answer cannot be attested as the operator's.
- `delegate_task` starts a child asynchronously by default; in `wait` mode “a question or approval ends the wait”. `task_cancel` stops a delegated task's running and queued turns. `t3_thread_interrupt` interrupts a top-level thread's running turn.

Assumed, not exercised:

- a question asked by a delegated child is shown to the operator;
- cancelling that child removes its pending prompt;
- a wake arriving while the orchestrator's own turn is held by an ask is not handled until the ask is answered (this matches the adopter's report, and is why the guidance forbids asking in that turn).

So the design does not depend on the host withdrawing anything. The factory expires its own record and wakes the presenter; the guidance tells the orchestrator to record the presentation first, ask from a delegated child so its own turn stays free, submit the returned words as `relay` with the `presentationId`, cancel the child when the presentation has ended, and never guess a choice from free text. The three assumptions are listed in the guide as qualification checks to pass before an adopter enables it.

## Limitations

- **The host prompt can outlive the presentation.** Until the orchestrator cancels the asking child, the operator can still click a prompt whose presentation has ended. The factory refuses an answer naming an ended presentation. It cannot refuse the same words re-sent as a plain relay without `presentationId`, because relaying words said in chat is legitimate; the guidance says not to.
- **No attestation.** `actor: "operator"` is still self-declared within the trusted local account, as everywhere else. This change adds no way for a host to attest an answer.
- **Verbatim is what the relayer sends.** The factory stores `quote` unchanged and adds nothing, but cannot check it against what the host showed. It does not compare the quote with the choice label.
- **The ask tool takes four options;** a question can have eight. The guidance leaves larger questions in the inbox.
- **A decision card's “discuss”** takes no relay (slice C), so it cannot be answered through a presentation.
- **Engine-closed questions** (a flow question that expires in the engine) are settled at the next operations tick, not in the same transaction.
- **The expiry wake needs a notification endpoint.** Without `notifications.configPath` the presenter learns of an expiry only when it next reads the item.
- **Not verified:** any behaviour of a real T3 ask, a real webhook, or the console in a real browser (rendering was checked with the minimal fake DOM the other console tests use).

## Design questions for root

1. **Relay on schema 1 keeps today's delegation.** A relayed answer settles the question, as a delegated answer does today, and needs `--instruction` as well as `relay`. The stricter alternative, holding a relayed answer for operator confirmation as slice C does for decisions, would change schema-1 behaviour and was not asked for.
2. **Informational and flow questions on a migrated project use the item record,** not `relayedAnswer`, because that record is bound to a decision. This leaves slice C's design question 6 open rather than answering it.
3. **A late answer is dropped, not kept.** After expiry the factory refuses the answer and the question stays open. Keeping it as a note for the operator would be kinder but would store an answer the contract says was withdrawn.
4. **The expiry wake overrides self-suppression once.** An orchestrator that published and presented its own question is woken once at expiry at every level. Without that, the prompt would stay up until someone looked.
5. **Defaults:** 15 minutes, one minute to one day, 32 presentations per question, one pending at a time. All are constants, not settings.
6. **Presenting is not restricted by role or kind of question.** A strict-review question can be presented; it still cannot be answered through the prompt by the orchestrator. The guidance says not to present those.

## Verification

Node 26.12.0.

New file `tests/ask-inbox-relay.test.mjs`, 15 tests on real command paths (`executeCommand`, the operations tick, the delivery loop with an injected transport, the project service, the console `/api/commands` endpoint, the CLI, the real engine):

- presentation: bounds, unknown fields, notices refused, item unchanged, one pending at a time, replay returns the first receipt, withdrawal by presenter or operator only, default and capped expiry;
- an inbox answer, a withdrawal and a stopped flow each make the pending presentation obsolete, and a late answer through it is refused;
- an answer through the prompt: stored verbatim with exactly the documented fields; refused without `relay`, from the operator, with `actor`, `relayedBy` or `answeredBy` anywhere, with a different channel; refused without the delegation an answer needs today and with `delegatedOperations: []`; replay; a relay without a presentation; a delegated answer without `relay` unchanged;
- a flow question answered through the prompt moves its flow, under the unchanged authority checks;
- expiry by the clock before any sweep and by the operations tick, once; the question stays open at the same version and can be presented again or answered in the inbox;
- an open presentation with other questions, notices, a whole flow, deliveries, pause and `config.update` all proceeding, and no wait recorded for it;
- `actionable` and `essential`: one first delivery, no reminder while the prompt is up, one wake at expiry, reminders resume, one resolution;
- the orchestrator's own question: quiet, one wake at expiry and quiet again; a never-reminding question returns to `delivered`; an operator taking the prompt down wakes the presenter once, the presenter taking it down wakes no one; a superseded flow question still tells its presenter once;
- restart: presentations, the relay record and replay across reopened stores, and expiry settled by the next process;
- the console endpoint and the CLI carry both commands and the relayed answer;
- the console shows the prompt on the open item, sends `inbox.unpresent` for that exact presentation, and shows the relay on the answered item and in History;
- migrated project: a card answered through the prompt records a pending `relayedAnswer` and stays open, the operator confirms it, an exact grant applies it, an operator's inbox answer obsoletes the prompt, an informational question keeps the item record, and the authority audit stays clean.

Mutation check: 19 changes to the new code, each making at least one new test fail. They are: no sweep after a command; no sweep on the tick; the operator allowed to relay; a presentation answer accepted without `relay`; extra `relay` fields accepted; extra payload fields accepted; an answer accepted after the expiry time; an answer accepted through an ended presentation; presenting bumping the item version; a second pending presentation allowed; no reminder hold; no presenter wake; the wake not returning the delivery to its earlier status; the wake obeying `actionable` suppression; the relay record not stored (flow, and standalone); a channel mismatch accepted; expiry closing the question; a card's presentation not settled.

Runs:

- `node --test tests/ask-inbox-relay.test.mjs`: **15/15 pass**.
- Focused set (the new file, communication, inbox-withdraw, actionable-notifications, notification-policy, notification-resolutions, state-notifications, operator-grants, durable-decisions, decision-authority-records, authority-migration, delegation, merge-delegation, command-help, console-wiring, console-views, console-details, project-service, question-race, tasks-queue, operational-parity): **174/174 pass**.
- `npm test`: **736/736 pass**, 0 failed, 0 skipped, 0 cancelled (721 existing and the 15 new). Run three times during the work, the last on the committed code; all three passed, so no file needed a rerun alone. Load average about 4–6.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

No existing test or assertion was changed.

## Independent review fixes

An independent review approved the change with two blocking delivery defects, both in `starter/factory/operations/notifications.mjs`. Both are fixed, with three neighbouring defects found while fixing them. No command, payload or record outside the delivery row changed.

**The wake record.** A delivery that owes its presenter a wake carries `presentationEnded {id, resume?, attempt?}`:

- `resume` is the status the delivery had before its first unsent wake (`suppressed`, `delivered`, `accepted` or `acknowledged`).
- `attempt` is the send that carries the wake, written when that send is dispatched.

| Finding | Fix |
| --- | --- |
| P1. A presentation that expired while a request was in flight lost its wake: the reply to that request cleared it, although its consumer could have read the prompt as still up. With `remind: never` nothing followed. | A successful reply clears the wake only if `attempt` is the send it answers. A wake recorded after that send left has no `attempt`, so it is kept and the delivery is sent again at once. A late reply from an earlier attempt is ignored as before. |
| P2. A second expiry before the first wake was delivered replaced the record and dropped `resume: suppressed`, so the orchestrator's own question became `accepted` and reminded. | A later ending replaces `id` and keeps `resume`. Endings before a successful send share one wake, and the delivery returns to the status it had before the first. |

Found while fixing these, same file:

- **An acknowledgement during the wake's request** set the delivery to `accepted` and skipped the reply handling, so the wake stayed and was sent again four hours later. **A late acknowledgement of an earlier request** put a wake that was due off for four hours. An acknowledgement cannot say which request it answers, so it now neither settles nor defers a wake that is owed; the send completes or is retried as usual. Without a wake owed, acknowledgement is unchanged.
- **A wake still owed when the question was resolved** stayed on the superseded delivery. If the resolution was filtered (a flow stopped at `essential` or `actionable`), the presenter was never told. The wake now moves to the resolution's delivery, which is sent once and then returns to `suppressed`.
- **A resolution acknowledged while the request carrying its wake is in flight** kept the wake record for good. It now ends `acknowledged` with nothing owed. By the same rule an already acknowledged resolution that is woken later returns to `acknowledged` after one send, where before it was re-sent until acknowledged again; this last case follows from the code and is not exercised by a test, because every command settles presentations before a resolution can be delivered.

Limits of the fix:

- Delivery is at least once. If a request that carried the wake fails as seen by the factory but reached the consumer, the retry is a second wake. If the question is resolved while the wake's request is in flight and that request fails, the resolution carries the wake.
- An acknowledgement that arrives while a wake is owed is recorded, but does not defer the next reminder by four hours; the usual interval applies after the wake.
- The wake's request is still an ordinary delivery of the item: nothing in the payload says a presentation ended. The consumer reads the item, as before.

### Verification of the fixes

Six tests added to `tests/ask-inbox-relay.test.mjs` (21 in the file), through the real delivery loop with an injected transport that acts while a request is in flight:

- an expiry during the first delivery of a never-reminding question, and during a retry of a reminding one: one further send, then `delivered` or the ordinary reminder (the reviewer's first probe);
- two expiries before any send, for the orchestrator's own question and for a `delivered` one: one send, back to `suppressed` or `delivered`, no reminder (the reviewer's second probe);
- a failed wake, a second expiry before the retry, a third during a retry that also fails: three requests, one accepted, back to `suppressed`;
- an inbox answer during an in-flight first delivery: one attention and one resolution; a flow stopped by the operator while the wake's request fails: the filtered resolution is sent once and is `suppressed` again;
- an acknowledgement during the wake's request, and a late one before it: one wake, on time; acknowledgement without a wake still defers reminders; a resolution acknowledged during its wake's request ends `acknowledged`;
- a process that stops with a request in flight: a second process sends the wake after the lease, and the first request's late reply changes nothing.

With `notifications.mjs` put back to 72df4f3 and the tests kept, the first five fail and the sixth passes; it is a guard, since the lease and attempt check already covered a restart. With the fix all 21 pass.

Mutation check: seven changes to the fix, each making at least one new test fail: a reply clearing any wake; `resume` not kept on replacement; the owed wake not handed to the resolution; an acknowledgement settling and deferring despite a wake; `acknowledged` not restored; no resend for a newer wake; `attempt` not written at dispatch.

Runs, on the committed code, Node 26.12.0:

- `node --test tests/ask-inbox-relay.test.mjs`: **21/21 pass** (16 pass, 5 fail with the 72df4f3 source).
- The new file with communication, inbox-withdraw, actionable-notifications, notification-policy, notification-resolutions, state-notifications, operator-grants, durable-decisions and question-race: **99/99 pass**.
- `npm test`: **742/742 pass**, 0 failed, 0 skipped, 0 cancelled (736 before and the 6 new). Run twice; both passed, so no file needed a rerun alone.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

One existing test helper (`notifying`) gained an optional hook that acts while a request is in flight. No existing assertion was changed.

Not verified: a real webhook endpoint or consumer, and the already acknowledged resolution woken later (see above).
