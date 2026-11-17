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
