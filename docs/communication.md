# Operator presence and standalone inbox

The project service exposes communication records independently of development flows. These records never approve tasks, dispatch work, change policy, merge a candidate, release software or grant spending. Commands use the usual project-bound, idempotent envelope and retained receipts.

## Presence

Only the operator may issue `operator.presence`:

```json
{"state":"here","ttlMs":10800000,"expectedVersion":0}
```

The state is `here` or `away`; the lifetime is positive and at most three hours, defaulting to three hours. `snapshot.operatorPresence` includes the effective state, declared state, observation time and expiry. Unset presence and expired `here` both read as `away`. An orchestrator cannot renew presence on the operator's behalf. The selected project’s header exposes availability from every tab, with its expiry. The version in `snapshot.operatorPresence.version` fences concurrent changes: supply it as `expectedVersion`; stale versions are rejected. All-project scope requires selecting a project first.

An integration can use this information to decide whether to ask in its current conversation or publish an inbox question. Presence itself never supplies an answer. Immediate security/spending incidents remain project-defined escalation policy.

## Notices and questions

Either attributed role may issue `inbox.publish` with a standalone notice:

```json
{
  "kind":"notice",
  "title":"A saved-state migration needs a later review",
  "context":"Describe the observed behavior, consequences and retained evidence here.",
  "links":[{"label":"Evidence","url":"https://example.invalid/evidence"}]
}
```

Optional IDs allow callers to retain a stable publication identity. Command IDs provide normal retry deduplication; a reused inbox ID does not overwrite an existing item. Titles, context and links are bounded; link schemes are HTTP, HTTPS or an optional host thread link. No host integration is required.

A standalone operator question additionally supplies explicit choices:

```json
{
  "kind":"question",
  "title":"Choose the next direction",
  "context":"Explain the decision and its consequences in plain terms.",
  "question":"Which direction should the project take?",
  "choices":[
    {"id":"retain","label":"Retain the current boundary","description":"Continue with the present behavior."},
    {"id":"discuss","label":"Discuss an alternative","description":"Keep the decision open for a conversation."}
  ],
  "expiryMs":86400000
}
```

Questions accept two to eight unique choices. Their expiry defaults to one day and cannot exceed seven days. Only the operator may answer a standalone question. `answer` uses the returned inbox ID, version and subject digest plus a choice ID; it can include a bounded note, kept on the answered item as `answerNote` (a flow question keeps it there too from dev.82, as well as in its flow's `answerNotes`). Flow questions also carry `choices` with readable labels for their answer IDs from dev.82. An answer records a decision only. A worker must separately request whatever canonical task approval, policy change or spending authority the decision requires.

The publisher of a standalone item, or the operator, can withdraw it while it is open with `inbox.withdraw` (`inboxId`, `expectedVersion` and a required `reason`). It becomes `superseded` with the withdrawal actor, reason and time recorded, its wait closes, and the usual resolution delivery replaces further reminders. It can no longer be answered. Flow questions cannot be withdrawn this way; they are resolved through their flow (answer, stop or abandon). The console offers **Withdraw this item** on open standalone items.

Standalone items accept an optional `remind` (`"never"` or 30 minutes to 7 days in milliseconds). Notices are delivered once by default and questions remind until resolved; see [operations](operations.md) for delivery details.

Expired questions retain an expired disposition and measured wait, with no default answer. `inbox.ack` closes a notice. Maintenance queues a new versioned resolution notification for answers, expiry, notice acknowledgment and supersession, including dispositions retained before an upgrade. Consumers read the canonical item to learn the answer, then use `delivery.ack` with `{ "deliveryId": "..." }` to acknowledge that delivery. Delivery acknowledgment does not answer a question or close a notice. Resolution deliveries stop retrying after acknowledgment; open-item acknowledgment defers reminders for four hours. Reading or acknowledging a question does not answer it.

Development stop and finished notices also retain their actual outcome, task revision and retrospective link. The optional `notifications.level: "actionable"` filters only proven routine terminal summary deliveries, including their acknowledgment resolutions; it does not erase these records. Questions, operator answers and independent notices remain subject to essential routing. Publish product-choice review material as a separate actionable notice/question or a retained obligation, never solely as prose in a successful flow summary; delivery or acknowledgment is not approval. See [quiet notification semantics](changes/plan-01-quiet-notifications.md). A failed lifecycle publication creates a retained obligation; it does not recursively create another synchronization flow.

Role names are attribution within the trusted local account. This feature does not introduce a multi-user authentication boundary.

## Prompt presentations and relayed answers

An integration may show an open question through an external prompt channel as well, for example a host's interactive ask prompt. The inbox item stays the question; the factory never talks to the channel. The contract is host-neutral and works on every project schema.

**Presenting.** Either role sends `inbox.present` before showing the prompt:

```json
{"inboxId":"<id>","expectedVersion":1,"channel":"host-ask","expiryMs":900000}
```

`channel` is a short name the presenter chooses. `expiryMs` is one minute to one day, 15 minutes by default, and never runs past the question's own expiry. The result carries the presentation (`id`, `channel`, `presentedBy`, `presentedAt`, `expiresAt`, `status: "pending"`) and the item's `version` and `subjectDigest` for the answer. The presentation is stored on the item as `presentations[]`. It is not an answer and not authority. It does not change the item's version, so an answer form that is already open stays valid, and it holds nothing: other questions, deliveries, flows and commands go on as before. A question has one pending presentation at a time, and at most 32 in its life.

**How a presentation ends.** Each ending is recorded with `endedAt`, `endedBy` and `reason`, and an `inbox.presentation-ended` event:

| Status | When | The question |
| --- | --- | --- |
| `answered` | an answer arrived through it (below) | resolved by that answer; a decision card on a migrated project may stay open, see below |
| `obsolete` | the question was resolved any other way: answered in the inbox, withdrawn, expired, or superseded with its flow | already resolved |
| `expired` | its time passed with no answer | stays open in the inbox, same version |
| `withdrawn` | `inbox.unpresent {inboxId, presentationId, reason}` by the presenter or the operator | stays open in the inbox |

So an answer by either route settles both. Expiry runs on the factory's own timer (each operations tick), whatever the channel does. A presentation that has ended accepts nothing: a late answer naming it is refused and the question is unchanged.

**Telling the presenter.** When a presentation ends by the timer, or through someone other than its presenter, the presenter must take the prompt down. The item's current delivery is then sent once more, whatever the notification level: `inbox.attention` if the question is still open, `inbox.resolved` if it was resolved. The consumer reads the item and finds its presentation no longer pending. That wake counts as sent only when a request dispatched after the presentation ended is accepted, so one that was already on its way is followed by another; presentations that end again before then share one wake, and a delivery that was quiet before it is quiet again afterwards ([operations](operations.md)). While a presentation is pending, reminders for that question are held until it ends; a first delivery, a retry and a resolution are never held.

**Relayed answers.** An answer entered for the operator by someone else is stored as relayed. Add `relay` to `answer`, and `presentationId` when it arrived through a presentation:

```json
{"inboxId":"<id>","version":1,"subjectDigest":"<digest>","answer":"retain",
 "relay":{"quote":"Retain the current boundary","channel":"host-ask"},"presentationId":"<presentation id>"}
```

`quote` is the operator's words verbatim: the option label they chose and any free text. `channel` is where they were given, and must be the presentation's channel when one is named. The relayer is the command's actor; no payload field can name another, and the operator itself cannot send `relay`. An answer through a presentation must carry `relay`: unless a channel can attest that an answer came from the operator, it is relayed. Nothing else is accepted or added.

On schema 1, and for informational and flow questions on a migrated project, the answered item keeps the record:

```json
"relay": {"schemaVersion":1,"relayedBy":"orchestrator","channel":"host-ask","quote":"Retain the current boundary","commandId":"<command>","recordedAt":"<time>","presentationId":"<presentation id>"}
```

`answeredBy` stays the actor that entered it. The record is provenance only. It confers no authority: the command needs exactly what it needed without `relay` (the question's role, or a delegated `answer` with a recorded instruction; strict-review sign-off and, unless enabled, integration decisions stay with the operator). The console shows it on the item and in History, and `inbox.answered` events carry `relayed`, `relayedBy` and `channel`.

On a migrated project a decision card keeps the [relayed-answer rules](changes/plan-07-08-slice-c.md): the relay becomes a `relayedAnswer` authority record, pending until the operator confirms it or applied through an exact grant, and the card stays open in the first case. The presentation is `answered` either way and names the `relayedAnswerId`. A card's non-resolving “discuss” choice takes no relay, so it cannot be answered through a presentation; withdraw the presentation instead.

## Orchestrator session and handoff

The orchestrator is a long-lived host conversation that receives the notification deliveries. Every wake adds to that conversation, so Factotum counts the deliveries made to the current session and asks for a handoff at a limit.

**The session.** The orchestrator (or the operator) declares the session that now receives deliveries with `orchestrator.session`:

```json
{"sessionId":"<host session or thread id>","expectedVersion":1}
```

The identifier is the host's own (letters, digits, `.`, `_`, `:`, `-`; at most 128 characters). Declaring the same session again changes nothing. Declaring a different one starts a new count, closes the previous session's open handoff question (status `superseded`, no wake at the default level) and increments `version`; `expectedVersion` is optional and fences concurrent rebinding: pass the `orchestratorSession.version` you read (0 before any session was declared), or leave it out. Until a session is declared, deliveries count toward an undeclared session, and the first declaration starts a new count. `snapshot.orchestratorSession` and `stats.orchestratorSession` show the session, its delivery count, the limit, the next handoff point, the handoff question's state and the recent resets.

**Resets are visible.** Rebinding needs no operator authorization, but every binding of a different session is recorded with the session it ended and that session's accepted count (the last 20 are kept; the 5 most recent and the number in the last 24 hours are in the views and in the console's Stats → Orchestrator session). Factotum raises one operator notice, at most once a day, when resets are unusually frequent: the last 4 resets ended sessions that together received fewer deliveries than one handoff limit (an orchestrator rebinding to avoid its own prompt), or there were more than 10 resets in 24 hours. Both thresholds are conservative: a session that hands off when asked ends at the limit, so even a busy project stays under them.

**What counts.** A delivery counts when the endpoint accepted it (a 2xx response), including reminders, resolution wakes, state events and the handoff question's own wake. Deliveries suppressed by `notifications.level` are never sent and never counted; refused or failed sends are not counted. An acceptance counts for the session the request was sent to: if a new session is bound while a request is in flight, its acceptance goes to the previous session's reset record, never to the new count. An acceptance that the runner does not record (it crashes after the endpoint accepted and before the recording transaction commits) is not counted, so the count can be lower than what the session really received; the delivery is retried later and counts then.

Every payload carries `sessionDeliveries` and `sessionDeliveryLimit` (`null` when the question is off), and `sessionVersion`, the session the number belongs to (dev.88; 0 before any session is declared): a delivery dispatched before a rebind carries the earlier session's version and number. `sessionDeliveries` is a send ordinal, not the accepted count: each distinct delivery gets the next number in the current session when it is first dispatched, allocated in the transaction that claims it, so concurrent sends never share a number and numbers follow dispatch order. A retry of a send that was not accepted keeps its number (it is the same delivery); a later re-send of an accepted delivery (a reminder) and a retry after a different session was bound get a new number. Numbers of deliveries that are never accepted are not reused, so the latest number can exceed the accepted count that drives the handoff question (`deliveries` in the views; the ordinals handed out are `dispatched`).

**The handoff question.** When the count reaches `notifications.handoffAfterDeliveries` (default 100), Factotum records one standalone question with `role: "orchestrator"` in the inbox, titled "Hand off to a fresh orchestrator session". Its context gives the count and says what to do: start a fresh session, give it the handoff summary, bind it with `orchestrator.session` and move the notification binding to it (or, when a triage proxy receives the notifications and forwards them to the bound session, leave the binding on the proxy), then let the old session stop. It also says that binding the new session closes the question, so a session that hands off need not answer it. Its choices are `handing-off` and `later`; the orchestrator or the operator may answer. It is delivered once (`remind: "never"`), and it expires after a day like other standalone questions.

- **Not raised repeatedly.** At most one handoff question is open. If it is still open after `notifications.handoffRepeatDeliveries` more deliveries (default 25), it gets a new version with the current count, which wakes the session once more. After an answer or expiry, a new question is raised once the count passes the later of the raise and the answer by the same interval. There is no separate hard ceiling: the count-based re-raise already returns the question at a fixed rate, and a ceiling would only add a second, noisier rule.
- **Cleared by handing off.** Binding a new session supersedes the open question and resets the count. Answering clears the question; `handing-off` and `later` differ only in the record, and both start the repeat interval from the answer.
- **Never a hold.** The question gates nothing: admission, flows, other deliveries and answers proceed whether it is open, answered or expired.

Both settings are live (`settings.update`, Settings → Notifications) and operator-only, so the orchestrator cannot switch off or postpone its own handoff prompt. Operator-only is enforced on the effective value by every configuration writer: a delegated `config.update` is refused if it would change one, whether through `replaceLive`, a file that drops the key (falling back to the default), or a mode change. `handoffAfterDeliveries` is 0 (counting continues, no question is asked) or 10 to 100000; `handoffRepeatDeliveries` is 5 to 100000.

**Handing off.** The outgoing session writes the successor a summary of what is not in canonical state: open questions it surfaced and their context, flows it is watching and why, decisions in progress with the operator's latest words, promised follow-ups, and anything it was asked to remember. The successor reads current state with `status` rather than trusting the summary for authority, binds itself with `orchestrator.session`, takes over the notification binding (unless a triage proxy holds it and forwards to the bound session), and reconciles pending deliveries. The old session then stops consuming deliveries. Host-specific steps (for example rebinding a webhook) belong in the host integration; see [the T3 integration](integrations/t3.md#ordinary-threads-and-orchestrator-handoff).

## Task and flow state notifications

With `notifications.level: "all"` and `notifications.configPath` configured, new `task.approved`, `task.revoked`, `task.approval-revoked`, `flow.admitted`, `planning.admitted`, `flow.stopped`, `flow.resumed` and `flow.finished` events queue signed `kind:state` deliveries in the same canonical transaction. Maintenance flow/job transitions are excluded; routine maintenance remains quiet. At `essential` (the default) and `actionable`, only approval/revocation state events queue deliveries, excluding orchestrator-caused events; flow outcomes use inbox notices to avoid duplicate wakes. State deliveries create no inbox item. Set `notifications.stateEvents:false` to prevent new state deliveries; already queued deliveries remain retained. Events from before enablement are not replayed. When a configuration update starts delivery, the earlier backlog is not sent either: only open items are delivered, and settled ones are superseded and summarized (see [notifications](operations.md#notifications)). A problem with the notification configuration file pauses delivery and is shown as a health problem; it never holds the project or stops work, and delivery resumes by itself when the file is valid.

A state payload contains `projectId`, `deliveryId`, `kind:"state"`, `event`, `eventSequence`, `version` (the same event sequence), `eventAt`, `observedAt`, `taskId`, optional `flowId`, `taskRevision` and `approvalVersion`. It contains no title, answer, note, private endpoint or execution grant. Inbox payloads now identify `kind:"inbox"` and retain their prior fields. Consumers must branch on kind rather than require an inbox ID for every wake. A task’s revision is a content identity, not an ordering number; use the project’s event sequence to identify the recorded transition.

Transport is at least once and can arrive out of order. Re-read current canonical task/flow state before acting; an old approval event may describe authority that has already been revoked. Consume and deduplicate each delivery ID, then issue `delivery.ack`. State deliveries retry after transport acceptance until acknowledged; acknowledgment stops them permanently without creating another event delivery. Command replay does not create duplicate events or deliveries. Unknown/missing state must be reconciled rather than guessed.

Approval remains separate from execution. The Tasks view explains this before approval and shows **Approved — not started** with **Start** and **Queue task** afterward. Queueing begins work automatically only when automatic admission is enabled and its policy/capacity checks pass. With automatic admission off, Start or explicit orchestrator dispatch remains necessary. These controls preserve canonical approval, queue-order preconditions and admission checks.
