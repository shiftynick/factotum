# Plan 01: actionable notification level

Implemented against the dev.78 baseline. This is a local implementation record, not a release, activation or live qualification claim.

## Policy and configuration

`notifications.level` accepts `essential` (unchanged default), `actionable`, or `all`. Choose **Notification level → actionable** in the selected project's console Settings, or send the normal project-bound `settings.update` command:

```json
{
  "changes": { "notifications.level": "actionable" },
  "expected": { "notifications.level": "essential" },
  "note": "Keep actionable attention while quieting routine terminal summaries"
}
```

The equivalent canonical configuration fragment is:

```json
{
  "notifications": {
    "level": "actionable",
    "configPath": "/private/project/notifications.json"
  }
}
```

The endpoint file remains private (0600); its existing URL/signing-key contract is unchanged. Changing the level is live and project-scoped: no draining or doctor renewal, no configuration-digest change, and no change to another registered project. Endpoint configuration remains outside this live knob. `config update` preserves a changed live value unless `replaceLive`/`--replace-live` is explicitly requested. A null live value resets to `essential`.

## Exact notification semantics

`essential` and `all` retain their existing behavior. In particular, essential normally sends one flow-end notice; all also sends eligible flow state events. Successful green built-in `main.verify` was already normally quiet and is not a new suppression in this feature.

`actionable` retains essential routing for questions, independent notices, operator answers/acknowledgments/withdrawals, expiry and approval/revocation events. Orchestrator-created attention, its own resolutions and state events, and superseded dispositions remain filtered as under essential. Flow admission/resume/finish/stop state events do not also wake the consumer: terminal attention uses the inbox notice, with repeated stops distinguished by their existing stop sequence.

Only core terminal-summary deliveries qualify for the additional success filter. The classifier requires a notice with its flow-summary identity, completed outcome and retrospective link, plus known flow evidence:

- Delivery (`kind: change` or `document`, no custom integration): a proven merge or accepted already-satisfied result, and `cleanup.released: true`.
- Built-in `target.sync`: a passing result, explicit destination containment, valid source and destination commit IDs, and no conflict.

A flow with a terminal reason, stop request, failed/blocked/partial/error/uncertain/stopped result, error/reason text, findings, declared post-merge checks, outstanding obligation, or failed/unresolved attempt remains attention-worthy. Result obligations count as fulfilled only when the same flow's canonical obligation is `passed` with evidence. An opaque `pass`, empty result, missing cleanup proof, or success assertion cannot establish fulfillment. Independent notices/questions are not filtered merely because their associated flow completed.

Failures, stops (including orchestrator-caused stops), uncertain outcomes, repeated stops, source changes/partial scans and actionable successful outcomes stay visible. Under this new level, existing broad maintenance success shortcuts cannot hide retained obligations/findings or failed/unresolved attempts, including scheduled-command cleanup and read-only integration follow-up. Successful scheduled commands with follow-up are labelled accordingly. The existing essential/all shortcuts remain unchanged.

Core terminal summaries remain in the canonical inbox even when their delivery is suppressed. They are not automatically acknowledged or resolved. Job/flow evidence, task outcomes, History and retrospectives are unchanged. This policy reduces external wakes; it does not hide historical summaries from the console.

## Compatibility and pending deliveries

No state-schema migration or history rewrite is required. New core summaries retain their terminal reason separately. Legacy summaries can qualify only when their existing context matches the core's plain success template; unknown/custom prose remains visible. New state delivery rows retain command actor attribution internally, without changing the webhook payload. Legacy approval rows lacking that attribution remain eligible rather than guessing that the orchestrator caused them.

At queue time and before each dispatch under `actionable`, the current project policy is applied. Pending rows, accepted reminders/resolution retries and expired send leases that are no longer eligible become `suppressed`. This includes ordinary successful terminal summaries that were queued under essential/all and acknowledgment-resolution deliveries for those summaries. Actionable rows continue normally. Already accepted non-reminding notices complete without another send, preserving the existing deliver-once rule; open questions and substantive operator resolutions retain their retry behavior.

A currently leased/in-flight request cannot be recalled; if already accepted, its next eligible retry is filtered. Consumers must still deduplicate delivery IDs and read current canonical state. Changing back to essential/all does not replay suppressed rows or historic state events. A future distinct item version is evaluated under the policy then in force. Essential/all backlog handling is otherwise unchanged. `stateEvents: false` still prevents new state deliveries; the new policy independently filters existing routine state rows on dispatch.

Delivery suppression is not acknowledgment, a decision, fulfillment of an obligation, or approval. It never edits inbox answers, job/flow results or historical events.

## Product-choice reports and limitations

Future plan 06 product-choice reports are actionable material. They must use independent notice/question or retained-obligation records, not only generic completion prose. Such records remain visible under essential routing; reports published by the consumer itself retain the existing self-wake exception because that consumer already has the material. Receiving or acknowledging a report cannot establish its required operator review. No report schema or review authority is invented here.

Classification is deliberately conservative: historical findings, failed attempts and declared post-merge checks may keep a successful flow visible even after recovery. Unknown/custom success remains visible, except existing explicitly quiet scheduled/read-only observation contracts when there is no recorded attention signal. The classifier does not parse arbitrary prose to prove obligations fulfilled, nor independently discover obligations omitted by an adapter. Suppressed records do not automatically revive if new obligations arrive later: new actionable material must have its own notice/question/version. Live webhook savings, host handling and release qualification remain root/operator work.

## Validation

Focused command:

```sh
node --test tests/actionable-notifications.test.mjs tests/notification-policy.test.mjs tests/notification-resolutions.test.mjs tests/state-notifications.test.mjs tests/maintenance-notices.test.mjs tests/containment-notice.test.mjs tests/live-settings.test.mjs tests/settings-delivery-policy.test.mjs
```

Result: **43/43 passed**. Coverage includes queue-to-transport filtering with injected transport, engine completion and retrospective preservation, success versus actionable/opaque success, failure/uncertainty/repeated stops, operator versus self resolutions, state deduplication, pending/accepted/expired-lease deliveries, legacy rows, resolution backdoors, in-flight policy change, source-closure evidence, scheduled cleanup, and validated project-scoped live settings.

Full suite: `npm test` — **587/587 passed**. The known baseline 150 ms main-health partial-output test is owned by root; this assignment makes no change to it. Tests use fictional local fixtures and injected notification transports; no live models or notifications were used for this feature.

## Independent review fixes

An independent review of `a371117` approved with two blocking findings, both fixed with regression cases that are suppressed on the reviewed commit:

- **Nested and retained worker evidence.** The attention check now reads findings, unverified acceptance, questions, departures and pushback from each result's nested provider `result`, from `flow.workerReports`, and from `flow.reviewHistory`. A historical review finding stays attention-worthy until the latest later review that names it in `priorFindingsDisposition` records `disposition: "fixed"` with non-empty evidence; `remaining`, `outside-scope`, a missing disposition, or a later unresolved disposition keep it visible (tightened after an independent re-check of `09d7725`).
- **Recovered required checks.** A gate result that passed only after `rerun.runs` is treated as a recovery and keeps its terminal notification.

Verification after the fixes: the 8 focused notification and settings test files, 43/43; `npm test` 587/587; `git diff --check` clean.
