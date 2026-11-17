# Risk escalation and strict review

Task authors classify work as `ordinary` or `strict`. An omitted classification is strict. Planners, plan reviewers and candidate reviewers return a structured `riskAssessment` containing a level, rationale, threat model and stop conditions. Access control, saved state, spending, security boundaries and destructive operations should be treated as strict.

The factory retains assessments with their attempt identities. An escalation is monotonic for that flow: replacing a plan, correcting code or returning a later ordinary assessment cannot remove it. Cached plans preserve their risk history when admitted into a build flow. Changing the task requires a newly approved revision and a new flow; it does not rewrite the old record.

Strict planning requires a concrete threat model and explicit stop conditions from the planner and plan reviewer. A strict candidate review must inspect the full candidate, provide an updated assessment, and attest all of the following:

- `fullDiffInspected`: the entire candidate diff was inspected. For an already satisfied task, the current implementation was inspected against acceptance even when the diff is empty.
- `threatModelReviewed`: the reviewer examined the relevant assets, trust boundaries and abuse/failure cases.
- `stopConditionsReviewed`: the reviewer examined the circumstances requiring implementation or completion to halt.

Missing attestations or incomplete strict assessments cannot establish readiness. The factory routes an incomplete candidate review back for correction. Every correction receives another fresh full review. The default protocol uses full reviews; the optional bounded delta protocol is described below. There is no independent proof that the model actually inspected each file; the attestations remain model evidence and require the designated reviewer’s judgment.

The factory's route is authoritative for workflow progression. In strict work, a reviewer verdict of `pass` with any findings, including low-severity findings, is still a revision request under the normal correction route. From dev.77, the builder prompt includes the factory route and disposition alongside the review, and explicitly requires resolution of those findings. If the builder believes no edit is warranted or needs missing reviewer evidence clarified, it should return `blocked` with concrete questions.

An `implemented` builder result after `revise` now stops at the build step when the actual repository head and tree fingerprint still equal both the build's input and the reviewed candidate. This also applies to ordinary reviews routed to `revise`, and works with project-owned step names. Builder claims about output identity cannot bypass the comparison. An initial build, an accepted/deferred review, a different candidate, or a changed correction does not trigger this hold; an explicit blocked result follows the graph's existing blocked route.

The attempt is retained as unsuccessful with the reason, and the flow emits a stop notice instead of automatically committing or reviewing the same candidate again. The spent build visit remains recorded; later visits are preserved. Queue ownership and flow capacity remain held for explicit recovery. Inspect the findings, use `flow.note` to give guidance, then deliberately `resume` the build or `flow.replan` where supported. Existing stops and revoked approval remain authoritative. No review or merge requirement is waived, and a changed fingerprint alone does not prove that the findings were correctly addressed.

A strict merge or already-satisfied acceptance opens an operator question containing the exact head, accumulated threat model, stop conditions and assessment digest. Its answer must include `reviewedHead` matching that exact head. For example, the normal `answer` payload adds:

```json
{
  "inboxId": "question-id",
  "version": 1,
  "subjectDigest": "current-question-subject-digest",
  "answer": "merge",
  "reviewedHead": "exact-candidate-commit-sha"
}
```

Use `accept` for an already-satisfied outcome. The web interface displays the assessment and asks the operator to enter the exact reviewed head. Reading the hash alone is not a review: inspect the candidate and its evidence before acknowledging.

The canonical service binds that answer to the candidate, task/configuration authority and risk assessment. The effect dispatcher rechecks the same binding before merge or recording a satisfied outcome. A different head or changed assessment invalidates the decision. Escalated work cannot take an ordinary auto-merge route. Actors remain attribution within the trusted local account, rather than separate authenticated security identities.

The live qualification harness supplies a pinned `reviewedHead` for scripted fixture acceptance. That tests the protocol, not the quality of a human review. Existing live qualification does not automatically qualify this newer protocol; rerun it on the installed executor before claiming current live-provider coverage.

## Configurable bounded review protocol

The conservative default is `policy.reviewProtocol: "fresh-full"`: each corrected candidate receives a fresh full review. An adopting project can select the bounded full/delta protocol:

```json
{
  "policy": {
    "reviewProtocol": "bounded-delta",
    "ordinaryReviewRounds": 4,
    "ordinaryFollowupAfter": 3,
    "strictDecisionRole": "orchestrator"
  }
}
```

Strict work receives a full review, a delta review of commits since the preceding review, and one final delta review if the last correction needs another read. Every review records its phase, base head, exact candidate identity and finding dispositions. An ordinary reviewer that discovers strict risk triggers a real full review before the delta stage. Delta/final reports must account for each finding from the immediately preceding review with concrete evidence.

Strict final findings do not start another automatic builder loop. They appear as unresolved findings in the exact-head decision and require the designated reviewer to merge, send back with a note, or stop. This is explicit adjudication of remaining findings, not a claim that the reviewer returned a clean pass. A final report missing the threat model, scope attestations or prior-finding evidence parks instead. Every head reaching merge has review evidence at that head and a passing verification gate.

For ordinary work, a review that passes with only low-severity findings finishes at once: the findings become a follow-up instead of another build round. Set `policy.deferLowFindings: false` to send them back to the builder instead. Otherwise, medium/low findings at or beyond `ordinaryFollowupAfter` become a separate unapproved follow-up issue linked on the PR. A durable forge action must successfully create/reconcile the issue and link before the flow can proceed to verification. High/critical findings return to the builder; a high/critical finding in the final review parks. The maximum configured review rounds remains bounded; explicit operator retry/send-back can grant another correction without granting money. Factory-owned branches and persistent builder sessions are retained.

`mergeDecisionRole` (default `operator`) delegates **ordinary**-risk merge decisions. With `"mergeDecisionRole": "orchestrator"`, and a merge question whose graph requests `role: "orchestrator"` (the supplied reference does so from this policy), the question opens for the orchestrator, and its answer is recorded with `actor: "orchestrator"` and `authority: "mergeDecisionRole"`. It still authorizes only the exact candidate it was asked about. The kernel re-derives the delegation when the question opens, when it is answered and immediately before the merge. If the candidate has become strict by then, or the flow adopted an external PR, the decision returns to the operator (or `strictDecisionRole` for strict work). The operator can always answer, stop or revoke. This is not `autoMerge`: nothing answers automatically and the forge merge mode stays manual. The role is pinned when a flow starts, so changing it affects only new flows after recommissioning.

**Required checks that read statuses too early.** If the target's branch protection requires a check (for example a GitHub Actions job) that reads the `repository.checkContext` status when the pull request opens, it runs before the gate has posted it and fails. Set `repository.rerunFailedChecks: true`: after posting a passing status, the gate re-runs the head's failed pull-request workflow runs and waits for them (`repository.rerunWaitMs`, default 10 minutes, within the gate's own timeout, so raise `timeouts.gate` to cover both). If they don't pass, the flow stops at the gate instead of asking for a merge the forge would refuse. The status is posted by `repository.account`, so a check that requires the owner's status is satisfied.

In the console, the strict question links to the candidate's commit and its pull request changes, and shows any preview. **Authorize merge** sends the head the page displays as `reviewedHead`; nothing is typed. If the candidate or the question changed since the page loaded, the project refuses it and the refreshed page shows the new candidate.

`strictDecisionRole` defaults to `operator`. Configuring `orchestrator` delegates the exact-head read to that attributed role; the operator may still answer its questions. Role names share the trusted local account and are not a separate authentication boundary. The `reviewedHead` acknowledgement remains mandatory for strict merge and satisfied-outcome decisions.

A send-back or conflict-repair answer requires a note. The note and candidate identity become durable builder/planner input. Conflict repair first refreshes the reviewed plan when planning is enabled, then resumes the same builder in the retained worktree. It never resets the conflict or creates a substitute checkout.

Planner and builder results include `departures`, `unverified`, `pushback` and blocking questions. Reports remain in canonical flow history. A new rule ID produces one proposed pushback record and inbox notice per flow; repeated wording for the same rule does not create another notice. Pushback never edits governance or authorizes an operator-only choice.

An optional repository issue profile publishes lifecycle labels/comments for admission, review, completion and stop. Reviewed plans use one marked issue comment, reconciled to the latest reviewed plan. Stop synchronization uses a durable, configuration-granted outbox job; it does not perform network writes inside the stop transaction. Revoked configuration prevents a stale job from dispatching. Failed publication retains an operator obligation. GitHub comment updates and issue state changes still have read/write races because the API does not provide the factory's canonical compare-and-swap semantics.

## Review bar: severity and shadow

`policy.reviewBar` chooses the test a review's findings are held to ([must-fix review design](designs/review-must-fix.md)).

- **`severity`** (the default) is the review described above. A golden capture taken before the setting existed shows that a severity flow's review prompts, provider schemas, dispatcher results and routes, review history and strict-requirement digest are unchanged; the only known differences are that a new flow records `reviewBar: "severity"` and the settings view lists the bar.
- **`shadow`** asks the reviewer the must-fix questions as well, and records what the must-fix bar would have done. **It changes no route:** the flow follows the severity route, the builder is briefed as today, and the recorded estimate is never acted on.
- **`must-fix`** is refused by configuration validation with "not available in this release". It becomes available only in the release that also ships the finding ledger, the strict-work changes, the decision guard and the console evidence. Until then its enforcement code is exercised only by test fixtures that pin a flow to it directly; from dev.99 that code acts on the protocol checks below.

```json
{
  "policy": {
    "reviewBar": "shadow",
    "review": {
      "environment": [
        { "id": "single-host", "fact": "Each account runs the factory on one host." }
      ]
    }
  }
}
```

**What a shadow review asks.** Plan and change reviews use the must-fix schema (version `must-fix-2`; dev.98 used `must-fix-1`, without `purpose`).

- **Purpose first.** Before the material under review (the diff, or the plan), the prompt has a purpose block: the task's outcome verbatim, or "none recorded for this task" when it has none; each acceptance criterion, numbered; for a change review, the reviewed plan's summary, checks and risks; and the protected classes. The reviewer answers two questions in `purpose`: does the change do what its task says (`outcome`: `met`, `partly`, `not-met` or `unverified`, and `acceptance`: one entry per criterion with its exact text, a status and up to four citations), and can it give a wrong answer silently (`silentWrongAnswer`: `no`, `yes` with how, or `unknown` with what would settle it).
- **Findings.** Every finding keeps `severity`, `file`, `line` and `message`, and adds a concrete `scenario`; `reachable` (`shown`, `unknown` or `not-here`, with up to four citations and a `coverage` statement); `purposeImpact` (`outcome`, one of the protected classes `security`, `data-loss`, `spending` or `check-trust`, or `none`); `silent`; `origin`; and `fixOf`. Each citation is a `file` quote, an `environment` fact id, a `record` of this flow (an attempt id, with the head, check and result as recorded) or `reasoning`, and says what part of the scenario it covers. The prompt is today's prompt with the purpose block before the material under review and these questions after it.

**What the factory records.** On the review result and its review-history row:

- `mustFix`: each finding's factory id (`R<round>.<index>` for change reviews, where the round is the review's position in the flow's history; `P<visit>.<index>` for plan reviews), its kind (`must-fix`, `operator-item` or `follow-up`) and reason, how each citation validated, the support status of an exclusion, any downgrade of `shown`, and a claim digest. A finding without the new fields (from a model, a project's own adapter, a scripted provider, or a recorded result) is a `legacy` finding and counts as must-fix, today's meaning. The model is asked for the must-fix schema, but a result that is valid against today's schema is accepted and marked `schemaFallback: "legacy"`. Rows written before ids existed get ids from their position when read; nothing is migrated.
- `mustFix.purpose`: whether the task has an outcome recorded, the assessed outcome, the criteria not met and not verified, and the silent-answer assessment.
- `mustFix.protocol`: the protocol checks below, the shadow's correction review when one ran (its contradictions and its result), and whether the protocol failed. `mustFix.basis` says whether the derived findings are the original result's or the correction's.
- `shadowRoute`: the route must-fix would have taken, the route actually taken, and whether they differ, with `version: "v2"` and `estimate: true`.

**Purpose synthesis.** An outcome or criterion assessed `not-met`, or a silent answer of `yes`, that no must-fix finding covers adds a must-fix finding (reason `unmet-acceptance` or `silent-wrong-answer`). `partly`, `unverified` and an `unknown` silent answer add none: they name nothing to fix, and later releases route them to the operator.

**Protocol checks fail closed.** A result is contradictory when it has no purpose assessment (today's shape, so a severity-only result always is), when `purpose.acceptance` does not list each acceptance line of the task exactly once by its exact text, with surrounding whitespace trimmed and nothing else relaxed (or lists something that is not one, or lists one line in forms that differ only in surrounding whitespace), or when `silentWrongAnswer` is `yes` and no finding is marked `silent`. A contradictory result gets one fresh correction review with the contradiction stated. A correction never lowers the risk of the result it replaced: when the first result escalated to strict, the correction is routed and derived as strict work, and the first result's assessment is recorded with the flow. A second contradictory result is a **protocol failure**, whatever it reports, including a pass with no findings; it is checked before the legacy fallback, the strict checks and every other route:

| Review | Must-fix (fixtures only in this release) | Shadow |
| --- | --- | --- |
| Change review (`review`, `delta-review`) | Routes `park` with disposition `protocol-failure` to the review question; mints no review evidence | Recorded as `shadowRoute` `park`; the actual route is today's |
| Satisfied review | Routes `revise` (it has no `park` edge), which fails that flow | Recorded as `revise`; the actual route is today's |
| Plan review | Plan review's single correction (`policy.planReviewProtocolCorrections`) also runs for a contradiction. If the result is still contradictory, the attempt fails with classification `protocol-failure` and the flow stops at plan review without following any edge, the hold a turn limit uses: no plan is published and no plan visit is spent. The stop notice quotes both contradictions. The strict risk assessments of the failed review are recorded with the hold (nothing else of it is kept, and no evidence is minted), so a resumed flow stays strict. Resume runs a fresh plan review of the same plan; replan with a note, or stop | Recorded as `shadowRoute` `stop`; the actual route is today's |

In a shadow flow the correction review runs **only for the estimate**: the actual route, the reviewed result and the builder brief are decided by the original result exactly as the severity bar decides them. So a contradictory shadow review costs one more reviewer call. **Cost:** it uses the reviewer's provider allowance like any call, and it is counted in usage accounting and in the project's model-invocation totals, labelled `call: "shadow-review-correction"`. It never counts as upkeep: in a knowledge-upkeep flow it is left out of the upkeep share and of the flow's own invocation budget. **It never costs the review its result:** it starts only when at least 20 seconds remain before a 30-second margin ahead of the attempt's deadline, and the whole call, provider preflight included, is bounded by that point. If it would not fit, runs out of time or fails for any reason, the review returns its own result and the estimate records `skipped` (`deadline` or `failed`) with no shadow route. Only an operator's stop stops the attempt. Today's plan-review correction for a pass with findings runs as before and is the shadow's correction when it runs. Checks that need the finding ledger (a `fixOf` naming a ledger entry, every awaiting entry judged, a relevance for every builder citation) come with the ledger.

**Citations are validated, not trusted.** A `file` quote must appear in that file at the reviewed head (whitespace collapsed), read through hash-verified Git objects, so replacement refs, grafts and rewritten objects are ignored; absolute paths and `..` are refused. An `environment` citation must name a fact the flow pinned. A `record` must be one of this flow's attempts, produced for the cited head, which must be the reviewed head, and the cited check must have the cited result. A quote that is not there, or a record for another candidate, contradicts the claim. A `shown` finding without a validated citation is read as `unknown`. Validation says only that the cited thing exists; a reviewer's own `not-here` stays `unconfirmed` until someone else confirms it.

**What shadow route v2 can and cannot estimate.** It applies the per-finding test, citation validation, purpose synthesis and the protocol checks with their correction review to the review that actually ran. It judges no earlier finding, never confirms an exclusion, has no builder deferral and no cap (`omits` lists these). It cannot show what later rounds would have done, because under must-fix the builder would have acted differently. Use it to measure how often reviews catch purpose failures, never to decide whether to enable must-fix; only the later v3, with the ledger, may inform that. Version v1 (dev.98) had no purpose synthesis and no protocol checks.

**Settings.**

| Setting | Values | Default | Read by the shadow |
| --- | --- | --- | --- |
| `policy.reviewBar` | `severity`, `shadow` | `severity` | Yes |
| `policy.review.environment` | up to 40 `{ id, fact }`, each fact at most 300 characters | none | Yes: `environment` citations |
| `policy.review.strictFollowups` | boolean | `false` | Yes: with it off, every finding in strict work counts as must-fix, as today |
| `policy.review.mustFixRounds` | 1 to 11, at most `maxBuildRounds` − 1 and at most `ordinaryReviewRounds` (checked when set, and for every shadow project) | 3 | Pinned only |
| `policy.review.inFixEvidenceFrom` | 2 to 12 | 3 | Pinned only |
| `policy.review.maxFollowupsPerFlow` | 1 to 50 | 20 | Pinned only |

`policy.reviewBar`, `policy.review.strictFollowups` and `policy.review.environment` are authority: on a migrated project only the operator may change them. None of these is a live setting. Change them with `config update`, which waits until no change or document flow is running, then run doctor. Each flow pins its bar when it starts, and a shadow flow also pins the other review settings, a copy of the environment facts and its schema versions, so a running flow never changes bar. Review phase routing reads the flow's pinned `reviewProtocol`. `policy.deferLowFindings` and `policy.ordinaryFollowupAfter` keep routing shadow flows, since their routes are severity routes.

## Durable observation waits

An installed workflow may use a `wait` node instead of holding an external process open:

```json
{
  "kind": "wait",
  "untilFrom": { "step": "observe", "field": "until" },
  "maxWaitMs": 43200000,
  "next": "reassess",
  "onFailure": "failed"
}
```

The preceding result supplies an ISO date. The canonical service saves the deadline on first entry, records the measured wait, and wakes the workflow when it is reached. Later reads cannot slide that saved deadline. Invalid or excessively distant dates follow `onFailure`; the maximum permitted bound is 36 hours. Stop preserves the completed wait span; resume uses the original result deadline and records a new span. No provider attempt, paid operation or sleeper process is kept running during the wait. Reassessment should read existing evidence and must not replay a paid observation implicitly.


Plan-review protocol contradictions are separate from substantive plan revisions. A reviewer must return `pass` only with an empty findings list; optional observations belong in its summary. By default, `policy.planReviewProtocolCorrections: 1` permits one fresh read-only review of the same plan when a result contradicts that contract. It uses a separate private artifact directory, retains the original result in `protocolCorrections`, preserves any risk escalation and shares the original action deadline. Another contradictory result still returns to substantive revision. A normal `revise` result does not receive this correction turn. Set the bound to zero to disable it.
