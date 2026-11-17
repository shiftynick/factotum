# Must-fix review: design

Status: design only, first version (2026-11-17). Not reviewed. Baseline: `main` at `f4b325e` (after dev.96).

Every statement about current behaviour cites a file and line at that commit. Citations that start `core/`, `operations/`, `workflows/`, `adapters/`, `service/` or `console/` are under `starter/factory/`.

This design answers a request from the third adopter's operator: review rounds should send back only findings that must be fixed. It also carries part of design #10, "ordinary delta review and finding ledger" (`docs/one-factory-progress.md:22`), whose direction is already set in `docs/one-factory-strategy.md:70`: findings get stable identities, a builder's "fixed" cannot settle a finding by itself, and the review chain is kept from a full baseline to the exact candidate.

## 1. The design in one page

A finding is **must-fix** when both hold:

- **(a) Reachable:** it can happen in the project's real setup, shown with evidence.
- **(b) Purpose:** it breaks what the change is for. That is the task's outcome, or, for a strict change, one of four protected classes: security (including access), data loss (saved data), spending, and check trust (whether the factory's checks and evidence can be believed).

Everything else a reviewer reports is a **follow-up**: recorded, shown to the operator, and turned into work only if someone approves it. It never sends the change back.

The parts:

1. **Schema.** Each finding states a concrete `scenario`, whether it is `reachable` here with cited `evidence`, its `purposeImpact`, whether it is `silent`, and its `origin` (new code, a previous fix, or something missed earlier). A review also returns a top-level `purpose` assessment: is the outcome met, is each acceptance criterion met, and can the change give a wrong answer silently. The factory, not the model, derives `mustFix` from these fields and checks the cited evidence where it can.
2. **Routing.** The existing review routes are reused: `revise` when a must-fix finding is open, `defer` (to the existing `followups` step) when only follow-ups remain, `pass` when nothing remains. No graph node or edge changes, so reference graph digests stay the same.
3. **Strict bar.** In strict work the four protected classes block even when reachability is only "unknown". Only verified "can't happen here" evidence lifts them, and then the operator acknowledges each one at the exact-head question.
4. **Later rounds.** A per-flow **ledger** keeps every finding by id with the builder's disposition and each reviewer's judgement. A later reviewer first judges whether earlier fixes hold, then reports new findings with their origin. From round 3, a corner case in a fix blocks only with factory-verified evidence.
5. **Builder deferral.** A builder may defer a must-fix finding once, as "can't happen here" or "not worth the mechanism", with evidence. The next reviewer accepts it unless it can show the evidence is wrong. A rejected deferral must then be fixed or put to the operator. Protected classes can only be deferred as "can't happen here" with verified evidence.
6. **Cap.** After 3 must-fix send-backs the flow parks for the operator instead of starting a fourth round.
7. **Evidence.** Citations are checked by the factory: a quoted line must exist at the reviewed head, an environment fact must be one the operator declared, a record must exist in the flow. Reasoning alone is never "verified". The operator sees the evidence status of every deferred and follow-up finding at the merge question.
8. **Rollout.** A new `policy.reviewBar` setting: `severity` (today, the default), `shadow` (new schema, today's routing, records what must-fix would have done) and `must-fix`. The setting is pinned on each flow when it starts, so no running flow changes behaviour.

How this would have played out on the third adopter's PR (section 2): the hostname-and-checkout-path corner cases would have reported `reachable: not-here` or `unknown`, citing nothing that shows two such machines exist, and become follow-ups. The flow would have stopped sending back after round 2. The stale-binaries defect is a silent wrong answer in the check-trust class; the purpose question "can it give a wrong answer silently?" is asked first in every round, and a "yes" or a strict "unknown" there blocks.

## 2. The request and the field evidence

**What the third adopter saw.** One PR's independent review ran seven rounds. All 13 findings were fixed. Rounds 3 to 7 mostly found corner cases in the previous round's fixes, for example two machines with the same hostname and checkout path on one account, which their setup does not have. Each fix added a mechanism, and each mechanism gave the next round something new to find. No round found the defect that mattered: a sandbox could pass a head using main's stale binaries, so a false pass counted as merge evidence. The orchestrator's own reading caught it.

**What they asked for.**

| # | Request | Where this design answers it |
| --- | --- | --- |
| R1 | Review asks about purpose first: does the change do what its issue says, and can it give a wrong answer silently? | Section 9 |
| R2 | Each finding states a concrete scenario, whether it can happen here (with evidence), and whether it touches the change's purpose, as schema fields that drive routing | Sections 5, 6 |
| R3 | Later rounds judge whether earlier fixes hold; a new corner case in a fix is a follow-up unless it passes the must-fix test | Section 7 |
| R4 | A builder may defer a finding with evidence ("can't happen here", "not worth the mechanism"); the next round accepts that unless the evidence is wrong | Section 8 |

**Two failures, not one.** The field case shows both a cost problem (five rounds spent on corner cases) and a quality problem (the defect that mattered was missed). Cutting rounds alone would fix the first and leave the second. That is why purpose-first (R1) and the check-trust class are part of the blocking bar, not extras.

## 3. Current behaviour this design builds on

| Fact | Where |
| --- | --- |
| `REVIEW_SCHEMA` is a `verdict` (`pass` or `revise`), a `summary` and `findings` with `severity`, `file`, `line` and `message`. The schema helper makes every property required and allows no others. | `adapters/providers/index.mjs:9,13` |
| The change review schema adds a risk assessment, strict attestations, a scope summary, `priorFindingsDisposition` (`fixed`, `remaining`, `outside-scope`, with evidence) and learning citations. | `adapters/providers/index.mjs:29-30` |
| The schema validator is a bounded subset: types (including `null` in a type list), `enum`, `required`, `additionalProperties`, `items`, length and size bounds. Unknown keywords are refused. | `adapters/providers/index.mjs:43-64` |
| Every model brief carries the task's id, title, outcome (when set), acceptance criteria and the original request as quoted data, then governing context and risk instructions. | `workflows/dispatch.mjs:352,357`; `operations/original-request.mjs:37-43` |
| Plan review: a pass requires `findings: []`; findings are only "concrete defects or omissions that block accepting this plan". A pass with findings gets one fresh protocol-correction review. Routes are `pass` and `revise`. | `workflows/dispatch.mjs:477-488` |
| Both reviews are told to report every blocking finding in one round, check neighbouring cases together, and keep hardening outside the task's scope out of findings. | `workflows/dispatch.mjs:230-233` |
| The candidate review receives the trusted diff (full, or since the previous reviewed head in the delta phases), the builder's report and all prior reviews. It must give a disposition for every finding of the previous review, matched by exact message text. | `workflows/dispatch.mjs:611-625` |
| The builder receives the previous review result as JSON and the factory's route. For strict work, "every finding requires resolution, including low-severity findings". | `workflows/dispatch.mjs:500-502` |
| Routing is in `reviewDisposition`. Under the default `fresh-full` protocol a review routes `pass` only with a pass verdict and no findings, else `revise`. Ordinary work: a pass with only low findings routes `defer` (`policy.deferLowFindings`, default on). | `core/delivery-review.mjs:10-19` |
| Under `bounded-delta`: strict work goes full, delta, final; a final with findings routes `adjudicate` (the operator decides at the exact-head question). Ordinary work defers medium and low findings from round `ordinaryFollowupAfter` (default 3); high and critical go back to the builder; the final ordinary round parks. A delta or final review that leaves a previous finding without evidence routes `revise` or `park`. | `core/delivery-review.mjs:4-9,13,20-29`; `docs/risk-review.md:41-58` |
| The reference change graph: `review` and `delta-review` route `pass` to the gate, `revise` to build, `delta` to delta review, `defer` to `followups`, `adjudicate` to the gate, `park` to `review-question` (send back or stop). The document graph sends them to the merge question. | `core/configuration.mjs:84-91,120-123` |
| A result route that the node has no edge for fails the attempt. | `core/engine.mjs:803` |
| `forge.followup` accepts only `defer` with medium or low findings in ordinary work, and creates one unapproved GitHub issue with one acceptance line per finding (at most 20), linked from the PR. It records a pending operator obligation and mints review evidence. | `workflows/dispatch.mjs:405-415`; `adapters/github/index.mjs:183-212`; `core/operations.mjs:26` |
| Review evidence is minted only by a `pass` route, or by a strict final `adjudicate`. | `core/delivery-review.mjs:31`; `core/engine.mjs:802` |
| Each review is appended to `flow.reviewHistory` with its phase, risk, identity, disposition and result. Findings have no ids. | `core/delivery-review.mjs:32-35` |
| Risk is `ordinary` or `strict` (there is no other "high-risk" level). A missing classification is strict. Escalation to strict is monotonic within a flow. | `core/risk.mjs:6-8,18-24`; `docs/risk-review.md:3-5` |
| A strict merge needs a passing review, or a final adjudication whose unresolved findings are listed in the exact-head question, and the operator's (or the strict decision role's) exact-head acknowledgement. | `core/risk.mjs:28-45` |
| `mergeDecisionRole: orchestrator` delegates ordinary merge decisions only; strict risk and adopted PRs return to the operator. `autoMerge` needs ordinary risk, qualification and no upkeep marker. | `core/risk.mjs:11-13`; `core/engine.mjs:502` |
| The flow pins `reviewProtocol`, `mergeDecisionRole` and `strictDecisionRole` when it starts, and its configuration digest. | `core/project.mjs:674`; `core/project.mjs:169` |
| A builder that returns `implemented` with the unchanged reviewed candidate after `revise` stops the flow, unless a replan changed the plan since that review (dev.88 M3). | `core/engine.mjs:643-644,825` |
| Lesson signals: a finding of a sent-back round that a later review calls `fixed` with evidence is a verified correction; one absent from a later passing round is a weak inferred one. Matching is by message text. | `operations/lesson-signals.mjs:21-49` |
| A completed flow is not routine (it notifies) while any historical review finding lacks a later `fixed` disposition with evidence. | `operations/notifications.mjs:61-68` |
| The merge question shows the review verdict, finding counts by severity and the summary. | `operations/merge-context.mjs:27-45`; `console/ui/inbox.mjs:6,56-76` |
| Audit and upkeep findings are `finding` rows with a lifecycle (`unapproved`, `tasked`, `delivered`, `declined`, ...) and console commands to create a task from one or decline it. | `operations/governance.mjs:33-49`; `operations/upkeep-candidates.mjs:1-20`; `console/ui/operations.mjs:108-125` |
| Stats already report review and build rounds per merged change. | `operations/stats-view.mjs:117,151-160` |
| A regression can be recorded against a flow. | `core/project.mjs:886-893` |

## 4. The must-fix test

### 4.1 The protected classes

| Class | What it covers |
| --- | --- |
| `security` | Access control, authentication, secrets, trust boundaries, injection, anything that lets someone act or read beyond what they should |
| `data-loss` | Loss or corruption of saved data, destructive operations, migrations that cannot be undone |
| `spending` | Money or metered usage spent without authority, or beyond a limit |
| `check-trust` | Anything that can make a check, a review or other evidence report a pass that is not true, or attach evidence to the wrong candidate. A false pass that counts as merge evidence is the defining case |

These map onto the strict escalation list the factory already uses (`workflows/dispatch.mjs:352`), with check trust named explicitly because the field case shows it is the class reviewers miss.

### 4.2 Why these stay blocking in strict work

- **They cannot be repaired later.** Lost data and spent money stay lost after a follow-up merges.
- **They are silent.** A security hole or a false pass produces no error and no failing check. A follow-up issue has nothing to remind anyone why it matters, and the system looks healthy meanwhile.
- **Check trust is load-bearing.** Every later merge decision relies on gate and review evidence. A defect that lets a false pass count corrupts the evidence of every flow after it, not just this one.
- **"Unknown" is the normal state of such a defect.** Absence of evidence that a security or false-pass scenario can happen is what an undetected defect looks like, so in strict work "unknown" blocks for these classes.
- **The cost is lopsided.** One more correction round costs minutes of model time. A missed one costs data, money or the operator's trust in the factory.

### 4.3 The derivation

The factory computes `mustFix` for each finding from the reported fields, the flow's effective risk and the factory's own evidence check (section 10). The model's verdict does not decide it.

| Flow risk | `purposeImpact` | `reachable` | Result |
| --- | --- | --- | --- |
| any | `outcome` | `shown` | **must-fix** |
| any | `outcome` | `unknown` or `not-here` | follow-up |
| strict | a protected class | `shown` or `unknown` | **must-fix** |
| strict | a protected class | `not-here`, evidence verified | follow-up, listed for the operator's exact-head acknowledgement |
| strict | a protected class | `not-here`, evidence not verified | **must-fix** |
| ordinary | a protected class | `shown` | **must-fix**, and the flow escalates to strict |
| ordinary | a protected class | `unknown` | follow-up marked `protected-class`; the merge decision returns to the operator (11.5) |
| ordinary | a protected class | `not-here` | follow-up |
| any | `none` | any | follow-up |

Two rules apply on top of the table:

- **`shown` needs a citation.** A `shown` finding whose evidence is reasoning only is read as `unknown`. A `shown` finding whose cited quote is not found at the reviewed head is read as `unknown` and marked `contradicted`. Both downgrades are recorded and shown.
- **Unmet purpose always blocks.** If the purpose assessment says the outcome or any acceptance criterion is `not-met`, or that a silent wrong answer is possible (`yes`), and no must-fix finding covers it, the factory adds one (section 9.3).

Severity stays in the schema and is shown, but it does not route under the must-fix bar. See open question Q3 about `critical`.

**Escalation.** An ordinary flow with a `shown` protected-class finding becomes strict, recorded as an escalation by the review step, like a reviewer's own strict assessment (`core/risk.mjs:18-24`). From then on the strict bar, the strict attestations and the exact-head question apply.

## 5. Schema

### 5.1 Finding fields

The must-fix review schema keeps every current field and adds these. The schema helper makes all properties required, so optional values are expressed as `null` (the validator supports `type: ['string','null']`).

```
finding: {
  severity:      critical | high | medium | low       (kept; shown, not routed on)
  file, line, message                                  (kept)
  scenario:      string, 1..1200   concrete inputs and state, and the wrong result they produce
  reachable: {
    status:      shown | unknown | not-here
    evidence:    citation[0..4]
  }
  purposeImpact: outcome | security | data-loss | spending | check-trust | none
  silent:        boolean           the wrong result comes with no error and no failing check
  origin:        new-code | in-fix | missed
  fixOf:         string | null     the ledger id whose fix introduced it (origin in-fix)
}
citation: {
  kind:  file | environment | record | reasoning
  ref:   string, 1..300            a repository path, an environment fact id or a record id; "-" for reasoning
  quote: string, 0..300            the exact text relied on (required for file)
}
```

`origin` means: `new-code` is in code this change adds that no earlier round reviewed; `in-fix` is in code a previous round's fix added; `missed` is in code an earlier round of this flow already reviewed without reporting it.

### 5.2 Top-level purpose assessment and ledger judgements

```
purpose: {
  outcome:     met | partly | not-met | unverified
  acceptance:  [{ criterion: string (exact text of one acceptance line), status: met | not-met | unverified, evidence: citation[0..4] }]
  silentWrongAnswer: { answer: no | yes | unknown, how: string 0..1200, evidence: citation[0..4] }
}
ledger: [{ id: string, judgement: fix-holds | fix-incomplete | deferral-accepted | deferral-rejected, evidence: citation[0..4] }]
```

`ledger` replaces `priorFindingsDisposition` in must-fix flows (section 7.3). The plan review uses the same finding fields and `purpose`, without `ledger` and without the change review's strict attestations.

### 5.3 Fields only the factory writes

Recorded on each finding in `reviewHistory` and in the ledger, never accepted from a model:

| Field | Meaning |
| --- | --- |
| `id` | `R<round>.<index>`, for example `R2.3`: the review round within the flow and the finding's position. Stable for the life of the flow |
| `mustFix` | The result of 4.3 |
| `bar` | `must-fix`, or `legacy` when the finding lacks the new fields |
| `blockingReason` | `outcome-shown`, `protected-class`, `protected-class-unknown`, `unmet-acceptance`, `silent-wrong-answer`, `legacy-severity`, or `null` for a follow-up |
| `evidenceStatus` | `verified`, `unverified` or `contradicted` (section 10.2) |
| `downgraded` | Why a `shown` was read as `unknown`, when it was |

### 5.4 Protocol checks

A result that fails one of these is internally contradictory. As with plan review today (`workflows/dispatch.mjs:480-486`), it gets one fresh correction review with the contradiction stated. A second contradictory result is routed conservatively: every finding it reports is treated as must-fix by the legacy severity rule.

- `purpose.acceptance` lists each acceptance line of the task exactly once, by exact text.
- `origin: in-fix` names a `fixOf` that exists in the ledger.
- `silentWrongAnswer.answer: yes` comes with at least one finding marked `silent`.
- In a delta or final phase, `ledger` judges every entry the factory marked as awaiting judgement (section 7.2).

### 5.5 Backward compatibility

- **Old results.** `reviewHistory` rows written before this change have no ids and no new fields. Ids are derived on read from the row's position (`R<n>.<k>`), so no record is migrated. Their findings carry `bar: legacy` and keep today's routing meaning. Consumers that match prior findings by message text (lesson signals, notifications) keep that path for legacy rows.
- **Adapters and fixtures that return only severity.** The provider adapter gives the model the schema of the flow's bar, so a real model in a must-fix flow returns the new fields or fails validation as any malformed result does today. A scripted provider, a test fixture or a project's own adapter may still return the old shape. The router does not require the new fields: any finding without them is a `legacy` finding and routes by today's severity rule for the flow's protocol. A must-fix flow fed only legacy findings therefore behaves exactly like a severity flow, and the ledger records that it did.
- **Severity flows are unchanged.** A flow pinned to `severity` gets the current schemas and prompts byte for byte. Slice 1 carries a golden test for that.
- **Graphs.** No node, edge or route name is added, so the reference graph digests do not change and no flow is rebound.

## 6. Routing

### 6.1 What forces a revise round

After deriving `mustFix` and reading the ledger, the review routes:

| Condition | Route |
| --- | --- |
| Strict attestations or risk assessment incomplete | `revise`, or `park` in a final phase (unchanged, `core/delivery-review.mjs:18`) |
| Any open must-fix item: a new must-fix finding, a fix judged `fix-incomplete`, or a deferral judged `deferral-rejected` with verified counter-evidence | `revise`; `park` when the must-fix round cap is reached (8.5); in a strict final phase `adjudicate`, as today |
| No open must-fix item, at least one follow-up not yet recorded | `defer` |
| Nothing open | `pass` |

The strict bounded-delta sequence is unchanged: a strict full review that passes goes to `delta`; an ordinary-phase review that finds strict risk goes to a real full review (`core/delivery-review.mjs:20-24`).

The model's `verdict` is kept and shown. When it disagrees with the route (a `revise` verdict with only follow-ups, or a `pass` with a must-fix finding), the review records `verdictOverridden` so the rate can be measured.

`policy.deferLowFindings` and `policy.ordinaryFollowupAfter` belong to the severity bar. They have no effect in a must-fix flow, and doctor says so when they are set on a must-fix project.

### 6.2 Where follow-ups go, and who approves them

**Recommended: rows always, plus the existing issue where the source is GitHub.**

1. **On the flow.** Every follow-up is a ledger entry with status `follow-up`, shown at the merge question and in the flow's review ledger in the console.
2. **As `finding` rows.** Each follow-up is also a `finding` row with `source: 'review'`, keyed by a digest of the flow id and the ledger id, status `unapproved`, carrying the scenario, class, reachability and evidence status. It goes through the same lifecycle and the same console commands as audit findings: create a task from it, decline it, record it as dealt with elsewhere (`console/ui/operations.mjs:108-125`). At most 20 rows per flow; the rest are counted on the flow.
3. **As a GitHub issue,** when the project's source is GitHub: today's single unapproved follow-up issue per review (`adapters/github/index.mjs:183-212`), with each acceptance line now carrying the scenario and reachability. The rows link to it.

There is no inbox item per follow-up; that would be noise. The existing operator obligation for deferred findings remains (`workflows/dispatch.mjs:414`), and the completion notice lists the follow-ups.

**Approval.** A follow-up becomes work only as a task, approved like any task: by the operator, or on a migrated project by an orchestrator holding a grant for that exact task revision (`core/grants.mjs`). Nothing is approved by being created. `forge.followup` keeps refusing approval labels.

**`forge.followup` under the must-fix bar** accepts a `defer` route at either risk level when every finding it records has `mustFix: false` at the reviewed identity. That replaces today's "medium or low, ordinary only" assertion (`workflows/dispatch.mjs:406-407`) for must-fix flows. In strict flows its protected-class follow-ups are added to the exact-head question's unresolved findings.

**Upkeep-origin flows** record follow-ups as ledger entries and rows only. No issue is opened and no task can be created from them by the factory, which keeps upkeep from feeding itself (consistent with knowledge-upkeep decisions N1 and N2).

### 6.3 What the builder is shown

In a must-fix flow the builder's correction brief lists only the open must-fix items: id, scenario, reachability evidence, purpose impact, and, for a fix judged incomplete or a rejected deferral, the reviewer's judgement and evidence. Follow-ups are listed by id and one line under "Not required in this flow (tracked as follow-ups)". The builder is told not to fix them unless the must-fix fix needs it, because each extra fix adds mechanism for the next round to examine. The strict instruction "every finding requires resolution, including low-severity findings" (`workflows/dispatch.mjs:500`) becomes "every must-fix item requires a disposition" (section 8).

### 6.4 Plan review

Plan review uses the same finding fields and the same test. A must-fix plan finding routes `revise`. Plan findings that are not must-fix do not become follow-ups, since nothing has been built. They are carried into the build brief as advisory plan notes and recorded on the flow. The protocol correction for a pass that carries findings (`workflows/dispatch.mjs:481-486`) applies only to must-fix findings. The strict plan check that adds a high finding when the threat model is missing (`workflows/dispatch.mjs:487`) adds it as a must-fix `check-trust` finding.

### 6.5 Already-satisfied review

The `satisfied-review` node routes only `pass` and `revise` (`core/configuration.mjs:68`). A must-fix finding fails it as today. Follow-ups are recorded as ledger entries and rows, with no forge step, and the review passes.

## 7. Later rounds

### 7.1 The ledger

`flow.reviewLedger` holds one entry per finding, by id:

| Field | Meaning |
| --- | --- |
| `id`, `round`, `attemptId` | Where the finding was raised |
| `finding` | As recorded, with the factory-written fields |
| `status` | `open`, `fixed-claimed`, `deferred-claimed`, `fixed`, `deferred`, `contested`, `disputed`, `follow-up`, `operator-accepted`, `operator-required` |
| `builder` | The builder's disposition, reason and evidence, with the evidence status |
| `judgements` | Each later reviewer's judgement and evidence, by round |

The ledger is derived from `reviewHistory` and the build results, and stored on the flow for reading. It can always be recomputed, so it needs no migration and no separate record kind.

### 7.2 How a round judges earlier fixes

Each must-fix review after the first receives, before the diff:

1. The purpose block (section 9).
2. The ledger entries awaiting judgement: every `fixed-claimed`, `deferred-claimed` and `contested` entry, each with its scenario, the builder's disposition and evidence, and the evidence status. Delivered as quoted data, like the original request (`operations/original-request.mjs:41-43`).
3. For each claimed fix, the paths the fix commit changed.
4. The diff: since the previous reviewed head in the delta phases, the whole change in `fresh-full` and full phases (unchanged, `workflows/dispatch.mjs:612-614`).

The reviewer must return a `ledger` judgement for every entry awaiting one:

- `fix-holds`: the scenario no longer produces the wrong result. Becomes `fixed`.
- `fix-incomplete`: the scenario, or the same scenario with a stated variation, still produces it. Stays open and must-fix, with this judgement's evidence.
- `deferral-accepted` or `deferral-rejected`: see section 8.3.

An entry left without a judgement routes as `incomplete-prior-findings` does today (`core/delivery-review.mjs:13`), now matched by id instead of message text. For legacy rows the message match remains.

### 7.3 New findings in later rounds

The reviewer is told, in the purpose block of every round after the first: a corner case in code that a previous fix added goes through the same must-fix test, and most do not pass it. It reports such findings with `origin: in-fix` and `fixOf`.

One rule is added on top of the test. **From round `policy.review.inFixEvidenceFrom` (default 3), an `in-fix` finding is must-fix only when its reachability evidence is verified by the factory** (a quoted line found at the head, a declared environment fact, or a flow record). Reasoning alone makes it a follow-up. This targets exactly the field case: round 3 onward found corner cases in fixes, argued from reasoning about setups the project does not have.

The rule does not apply to protected classes in strict work, where "unknown" still blocks (4.3). Those flows are bounded by the round cap and by the strict final adjudication.

A `missed` finding is judged by the ordinary test. A miss is still a defect, and the count of misses by round is a measure of review quality (section 15).

## 8. Builder deferral

### 8.1 The disposition record

In a must-fix flow, the builder's result adds:

```
findingDispositions: [{
  id:          string                          a ledger id from the correction brief
  disposition: fixed | deferred
  reason:      cant-happen-here | not-worth-mechanism | null    (null when fixed)
  evidence:    citation[0..4]
  note:        string 0..1200
}]
```

- Every open must-fix item should have one entry. A missing entry is read as `fixed-claimed`, which is today's implicit meaning, and the next reviewer judges it.
- `deferred` with `cant-happen-here` needs at least one citation that is not reasoning.
- `deferred` with `not-worth-mechanism` disputes the purpose half of the test: the scenario is real but its effect is outside the change's purpose or tolerable. It is allowed only for `purposeImpact: outcome` findings in ordinary flows.
- A protected-class finding can be deferred only as `cant-happen-here`, and in strict work only with verified evidence. Otherwise the deferral is void and the item stays open.
- A builder may defer a given finding once. After a `deferral-rejected` judgement the finding is `contested`, and the builder must fix it or return `blocked`, which reaches the operator through the existing build question.

### 8.2 An unchanged candidate

Today an unchanged candidate after `revise` stops the flow (`core/engine.mjs:644,825`). In a must-fix flow, when every open must-fix item has a valid `deferred` disposition, the unchanged candidate is reviewed again instead, the same exemption a changed plan already has (`core/engine.mjs:643`). The review that follows has an empty delta and judges only the deferrals. This exemption is used at most once per finding.

### 8.3 How the next reviewer judges a deferral

The reviewer is told to accept a deferral unless it can show the evidence is wrong: the quoted line does not mean what the builder says, an environment fact does not cover the scenario, or the scenario reaches the wrong result by another path. A rejection must cite that.

| Builder's evidence | Reviewer's judgement | Result |
| --- | --- | --- |
| any | `deferral-accepted` | `deferred`: the finding becomes a follow-up |
| any | `deferral-rejected`, with verified counter-evidence | `contested`: must-fix, the builder must fix it or ask |
| verified | `deferral-rejected`, reasoning only | `disputed`: no further round; shown to the operator at the merge question, and the merge decision returns to the operator (11.5) |
| not verified | `deferral-rejected`, reasoning only | `contested` |
| contradicted (quote not found) | none needed | void: the item stays open as if no deferral was made, and the builder is told why |

### 8.4 Why this stops loops without waving defects away

- **Loops end** because a deferral is judged once, a rejected deferral cannot be repeated, reasoning-only rejections of well-evidenced deferrals go to the operator rather than another round, and late corner cases in fixes need verified evidence to block (7.3).
- **Real defects are not waved away** because deferral is only "can't happen here" (with evidence the next reviewer can check against the code) or "outside the purpose" (for outcome findings only). Protected classes need verified evidence. Every accepted deferral stays visible as a follow-up row, at the merge question and in the completion notice, and an accepted deferral without verified evidence returns the merge decision to the operator.

### 8.5 Cap and escalation

`policy.review.mustFixRounds` (default 3, 1 to 12) bounds the review rounds of a flow that route `revise` for must-fix items. The review that would start one more routes `park` instead, to the existing `review-question`, where the operator sends back with a note (one more round) or stops. The existing bounds (`maxBuildRounds`, `ordinaryReviewRounds` and the node visit limits, `core/configuration.mjs:61,85-86`) stay as hard ceilings, and commissioning refuses a cap above them.

Three is chosen because in the field case the defects worth fixing were found in the first two rounds. The trial (section 15) checks this.

**Operator dispositions.** A new operator command, `flow.disposeFinding`, records `operator-accepted` (treat it as a follow-up) or `operator-required` (it must be fixed; the builder may not defer it) on one ledger entry, with a note and the entry's version. It is how the operator settles a contested or disputed finding without a graph change, before answering `retry` or `send_back`. For a protected-class finding it is the operator's alone; for an outcome finding in ordinary work a delegated orchestrator may record it, on the same terms as other delegated operations.

## 9. Purpose first

### 9.1 How the purpose reaches the reviewer

The task's title, outcome, acceptance criteria and original request are already in every brief (`workflows/dispatch.mjs:357`). In a must-fix flow the review prompt is reordered so that a purpose block comes before the diff, and the reviewer is asked to answer it before looking for defects:

1. **The outcome**, verbatim. A task without an `outcome` uses its title and acceptance criteria, and the merge question says "no outcome recorded".
2. **Each acceptance criterion**, numbered, verbatim.
3. **The reviewed plan's** summary, stated checks and risks, when there is a plan.
4. **The ledger entries awaiting judgement** (7.2), from round 2.
5. **The protected classes** and the project's declared environment facts (10.3).

### 9.2 The two questions

- **Does the change do what its task says?** Answered in `purpose.outcome` and per criterion in `purpose.acceptance`, each with evidence. "Unverified" is allowed and shown; it is honest when the reviewer cannot run code.
- **Can it give a wrong answer silently?** Answered in `purpose.silentWrongAnswer`: `no`, `yes` with how, or `unknown` with what would settle it. The prompt names the forms this takes: a check that passes without running what it claims to, results attached to the wrong candidate or head, stale inputs read as current (the field case), an error swallowed into a default value, a fallback that hides a failure.

### 9.3 How the answers are recorded and routed

- `outcome: not-met`, or any criterion `not-met`, with no must-fix finding naming it: the factory adds a finding "Acceptance not met: <criterion>" with `purposeImpact: outcome`, `reachable: shown` and the reviewer's own criterion evidence. It is must-fix.
- `silentWrongAnswer: yes`: a must-fix finding is required (5.4). If its class is a protected class, the strict rules apply; in an ordinary flow with `check-trust` and `shown`, the flow escalates.
- `silentWrongAnswer: unknown` in strict work: does not block by itself, since there is no concrete scenario to fix, but it is shown in the exact-head question with the reviewer's "what would settle it". In ordinary work it returns the merge decision to the operator (11.5).
- The purpose assessment is stored with the review and shown at the merge question for every round's latest review.

## 10. Evidence trust

### 10.1 The problem

A reviewer's "this can happen here" and a builder's "this can't happen here" are both model output. Neither model can run code during review, and both can be wrong with confidence. The design does not try to make model claims trustworthy. It separates what the factory can check from what only judgement can settle, and shows the operator which is which.

### 10.2 What counts as evidence, and what the factory checks

| Citation kind | What it is | Verified when |
| --- | --- | --- |
| `file` | A repository path and an exact quote | The quote is found in that file at the reviewed head, with whitespace collapsed (the same check as knowledge upkeep's validator). Paths are refused if absolute, containing `..`, or outside the repository |
| `environment` | The id of an operator-declared environment fact | The id exists in the flow's pinned configuration |
| `record` | A factory record of this flow: an attempt, a check run, a gate result | The record exists and belongs to this flow |
| `reasoning` | An argument | Never |

A finding's or disposition's `evidenceStatus` is `verified` when at least one citation is verified and none is contradicted, `contradicted` when any `file` quote is not found, and `unverified` otherwise.

"Verified" means the cited text exists where the model said. It does not mean the argument built on it is right. The design says this wherever it is shown.

### 10.3 Environment facts

The strongest "can't happen here" evidence is a fact about the project's real setup that the operator has stated, for example "the factory runs on one host per account" or "each checkout path is unique on a host". These are declared in `policy.review.environment` as a list of `{ id, fact }` (at most 40, each at most 300 characters).

- They are configuration, not repository files, so a builder cannot add one by editing its worktree.
- Changing them changes what blocks a merge, so they are authority-bearing policy: operator-only on both schemas (section 12).
- Every review and build brief in a must-fix flow lists them, so reviewers can cite them and can see what setups do not need defending against.
- A fact the operator later finds wrong is corrected in configuration; flows already running keep the facts they pinned.

### 10.4 Who verifies what

| Claim | Checked by the factory | Judged by |
| --- | --- | --- |
| A quote, an environment fact id, a record id exists | Yes (10.2) | — |
| The scenario is reachable here | Only the citations | The next reviewer for a builder's deferral; the operator at the merge question for anything left disputed or unverified |
| A fix holds | No | The next reviewer (7.2); the gate for anything the checks cover |
| The effect is outside the change's purpose | No | The next reviewer; the operator for any follow-up they choose to look at |

Independence matters here. The reviewer is a fresh session and may be a different model family than the builder (`workflows/dispatch.mjs:622-624`). The ledger records the pairing for each judgement so the operator can see when a builder's deferral was accepted by the same family.

### 10.5 What the operator sees

At the merge question, and on the flow's page, every finding that was not fixed is listed with: id, scenario, class, reachability, evidence status as a chip (`verified`, `reasoning only`, `contradicted`), who deferred it, the reviewer's judgement, and the follow-up row or issue. Disputed deferrals and protected-class follow-ups are listed first. Contradicted citations are shown with the quote that was not found.

## 11. Interactions

### 11.1 Lesson signals

`operations/lesson-signals.mjs` keeps its rules for legacy rows. For must-fix rows, matched by ledger id:

- A `review-correction` (verified) is recorded only for a must-fix finding later judged `fix-holds`. A contested finding later fixed is recorded the same way, with `contested: true`.
- Follow-ups, accepted deferrals and operator acceptances are not corrections and produce no verified signal.
- Two new weak kinds: `review-deferral` (an accepted deferral) and `fix-churn` (an `in-fix` finding). Weak signals alone still never cause an upkeep model call (knowledge-upkeep N5).

This makes upkeep's capture candidates rest on defects that mattered, not on corner cases.

### 11.2 Notification classification

`flowNeedsAttention` (`operations/notifications.mjs:54-87`) reads the ledger for must-fix flows: a flow with any `deferred`, `disputed`, `follow-up` or operator-disposed entry is not routine, as unresolved history is today. A `fixed` entry no longer needs a message-matched disposition. No notification is added per follow-up. A flow parked at the cap notifies through its question, as today.

### 11.3 The console

- **Merge question** (`console/ui/inbox.mjs:56-76`; `operations/merge-context.mjs:27-45`): for must-fix flows, the severity counts are replaced by "must-fix open / follow-ups / deferred (verified, unverified) / disputed", the purpose assessment (outcome, each criterion, silent wrong answer) and the list in 10.5. Legacy and severity flows keep the current display.
- **Flow page:** a review ledger table, one row per finding, with its round, status and judgements.
- **Findings page:** review-source rows next to audit findings, with the existing create-task and decline forms.
- **State view** (`operations/state-view.mjs:22`): the bounded finding projection adds the new fields, clipped like the message.
- **Stats:** the metrics of section 15.

### 11.4 Knowledge upkeep follow-ups

Docs follow-ups and other upkeep-origin flows run through the project's workflow, so they get the project's bar. Their review follow-ups stay on the flow (6.2). A docs follow-up parked at the must-fix cap reaches a question other than its merge decision, so it is ended, not put to the operator (knowledge-upkeep N2).

### 11.5 Delegated merge decisions and automatic merge

An ordinary flow's merge decision returns to the operator, and `autoMerge` does not answer it, when the ledger or purpose assessment holds any of:

- an accepted deferral whose evidence is not verified;
- a disputed deferral;
- a protected-class follow-up;
- `purpose.outcome` other than `met`, or `silentWrongAnswer` other than `no`.

This is re-derived where delegation is re-derived today: when the question opens, when it is answered and before the merge (`core/risk.mjs:11-13`; `core/engine.mjs:502`; `docs/risk-review.md:60`). Strict decisions keep their rules; a deferred protected-class finding in strict work needs the operator's own acknowledgement, not the strict decision role's (open question Q4).

### 11.6 Full and delta review protocols

- **`fresh-full`** (the default protocol): every round reviews the whole change and also receives the ledger (7.2). Must-fix routing replaces the pass-only-when-empty rule.
- **`bounded-delta`:** delta and final reviews judge the ledger by id. The strict full, delta, final sequence and its final `adjudicate` are unchanged. An ordinary final review with an open must-fix item parks, as today.
- Both protocols count must-fix send-backs against the cap (8.5).

### 11.7 Document flows and adopted pull requests

Document flows use the same test; their findings are almost always `outcome` or `none`. Adopted pull requests use the same bar; their merge decision is already the operator's.

## 12. Configuration surface

```json
{
  "policy": {
    "reviewBar": "severity",
    "review": {
      "mustFixRounds": 3,
      "inFixEvidenceFrom": 3,
      "maxFollowupsPerFlow": 20,
      "environment": [
        { "id": "single-host", "fact": "Each account runs the factory on one host." }
      ]
    }
  }
}
```

| Setting | Values | Default | Notes |
| --- | --- | --- | --- |
| `policy.reviewBar` | `severity`, `shadow`, `must-fix` | `severity` | Pinned on each flow at start, beside `reviewProtocol` (`core/project.mjs:674`) |
| `policy.review.mustFixRounds` | 1 to 12 | 3 | Not above `maxBuildRounds` or `ordinaryReviewRounds` |
| `policy.review.inFixEvidenceFrom` | 2 to 12 | 3 | |
| `policy.review.maxFollowupsPerFlow` | 1 to 50 | 20 | |
| `policy.review.environment` | up to 40 `{id, fact}` | none | Ids are ASCII letters, digits and `-` |

`reviewBar` and `review.environment` decide what blocks a merge, so they are authority-bearing (`core/authority-policy.mjs:16-33`): a delegate cannot change them on a migrated project, and they are operator-only live settings on schema 1. The other three are bounds and follow the rules of the existing round settings.

**Commissioning** refuses `must-fix` when a `provider.review` node other than a satisfied review lacks a `defer` edge, since the route would fail the attempt (`core/engine.mjs:803`). The reference graphs have it. `shadow` needs no new edge.

## 13. Rollout and migration

### 13.1 Default

`severity`. Nothing changes for a project that does not opt in.

### 13.2 Shadow first

`shadow` gives reviewers the must-fix schema and purpose-first prompt but routes exactly as `severity` would. Each review records `shadowRoute` (what must-fix would have done) and the derived fields. It costs somewhat longer reviewer output and changes no outcome. It answers, on the project's own flows, how many rounds must-fix would have saved and which findings it would have deferred, before anything depends on it.

Recommended path for the third adopter: `shadow` for 15 merged flows or two weeks, whichever comes first; read the comparison (section 15); then `must-fix`.

### 13.3 Mid-flow behaviour

- The bar is pinned on the flow at start. A flow started under `severity` finishes under `severity`, whatever the configuration says later. A change of `reviewBar` is a configuration change, so running flows go through the existing configuration revalidation (`core/project.mjs:169`) and keep their pinned bar.
- No graph changes, so no flow is rebound and no open question is superseded by this release.
- Records need no migration: ids and the ledger are derived (5.5, 7.1).
- The release notes say all of this, and that `deferLowFindings` and `ordinaryFollowupAfter` do not apply to must-fix flows.

## 14. Slices

Each slice ships on its own with its tests and leaves severity flows unchanged. Structural behaviour is tested with scripted review results; what a real model does is judged in the trial, never asserted as an exact unit contract.

**Slice 1: schema, ids, derivation and shadow.**
- The must-fix schemas for plan review and change review; factory ids; the citation checker; the derivation of 4.3 with the downgrade rules; legacy fallback; `policy.reviewBar` with `severity` and `shadow`, pinned per flow; `shadowRoute` recorded.
- Accepted when: every row of the 4.3 table has a fixture; `shown` with reasoning only, and with a quote not found, are read as `unknown`; legacy rows get stable derived ids; a must-fix flow given legacy-shaped findings routes exactly as a severity flow; citation fixtures cover found, whitespace-collapsed, missing file, absolute path, `..`, a binary file and a path outside the repository; the new schemas pass `validateSchemaDefinition`; a severity flow's prompts and schemas are byte-identical to before (golden test); in shadow the actual route always equals the severity route.

**Slice 2: purpose first.**
- The reordered prompt and purpose block; the purpose assessment; the protocol checks of 5.4 with one correction review; synthesized acceptance findings.
- Accepted when: a review that omits or misquotes a criterion gets one correction review, then is routed conservatively; `not-met` without a finding produces a must-fix finding; `silentWrongAnswer: yes` without a silent finding is contradictory; a task without an outcome is handled and labelled.

**Slice 3: must-fix routing and follow-ups.**
- `reviewBar: must-fix`; routing of 6.1; `verdictOverridden`; the builder brief of 6.3; `forge.followup` accepting non-blocking findings at both risk levels; review-source `finding` rows; the GitHub issue body; escalation on a shown protected-class finding; plan notes; the cap and park; the commissioning check for `defer` edges.
- Accepted when: each route has a fixture at both risk levels and both protocols; a strict flow with a protected-class `unknown` finding is sent back; a strict follow-up appears in the exact-head question; an ordinary shown `check-trust` finding escalates the flow; the fourth must-fix send-back parks; a project graph without a `defer` edge is refused at commissioning; an upkeep-origin flow creates rows but no issue.

**Slice 4: the ledger and later rounds.**
- `flow.reviewLedger`; the reviewer's ledger block and judgements; id matching with the legacy message fallback; `origin` checks; the `inFixEvidenceFrom` rule.
- Accepted when: a missing judgement routes as incomplete prior findings; a round-3 `in-fix` finding with reasoning only is a follow-up and with a verified quote is must-fix; a protected-class `in-fix` finding in strict work still blocks; the ledger recomputed from history equals the stored one.

**Slice 5: builder deferral.**
- `findingDispositions`; the unchanged-candidate exemption; one deferral per finding; the judgement table of 8.3; `flow.disposeFinding` and its authority.
- Accepted when: each row of 8.3 has a fixture; a second deferral of a contested finding reaches the build question; a strict protected-class deferral with unverified evidence is void; an unchanged candidate with all items deferred is reviewed once more and not twice; a delegate cannot dispose a protected-class finding.

**Slice 6: interactions.**
- Merge question context and console (11.3); delegated-merge and `autoMerge` return conditions (11.5); notification classification (11.2); lesson signals (11.1); state view; stats.
- Accepted when: each 11.5 condition returns an ordinary decision to the operator at open, answer and pre-merge; a must-fix flow with an accepted deferral is not routine; follow-ups produce no verified lesson signal and a contested-then-fixed finding does; legacy flows display as before.

**Slice 7: trial with the third adopter.** `shadow`, then `must-fix`, with the measures of section 15 and these seeded cases:

| Seeded case | Expected |
| --- | --- |
| A fix that introduces a corner case needing a setup the project does not have | *Model:* reported `in-fix`, `not-here` or `unknown`; a follow-up |
| A check that can pass on stale build output | *Model:* `silentWrongAnswer: yes`, a `check-trust` finding; blocks |
| An unmet acceptance criterion the diff looks plausible for | *Model:* criterion `not-met`; blocks |
| A builder deferral citing a declared environment fact that covers the scenario | Accepted; a follow-up row |
| A builder deferral citing a quote that is not in the file | Void; the item stays open |
| A strict change with a possible secret leak the reviewer cannot confirm | Blocks (`protected-class-unknown`) |
| A reviewer that keeps rejecting a well-evidenced deferral by argument | `disputed`; no extra round; the operator decides |

## 15. Metrics, success and kill criteria

Measured per merged flow and compared between the shadow period (which shows what severity did and what must-fix would have done on the same flows) and the must-fix period.

| Measure | Pass | Suspend or switch back |
| --- | --- | --- |
| Review rounds per merged flow (mean and 90th percentile) | Mean falls by at least 30% from the shadow period | No fall after 15 must-fix flows |
| Flows parked at the cap | At most 10% | Above 25% |
| Follow-ups created per merged flow, and their fate within 30 days (task approved, declined, expired) | Any number; at least 30% are approved or recorded as dealt with | Above 70% declined or expired: follow-ups are noise; stop creating rows for `not-here` findings |
| Escaped defects: a regression recorded against a must-fix flow, or a follow-up the operator flags "should have blocked" when accepting it | None | Any in a protected class: switch the project back to `severity` and review. Two of any class in 20 flows: the same |
| Accepted deferrals later flagged wrong by the operator | None in a protected class; at most 10% otherwise | Any in a protected class: disable protected-class deferral |
| Purpose catches: silent wrong answers and unmet criteria found by review before merge | Reported; at least one in the trial's seeded cases | The seeded stale-output case not caught |
| Verdict overrides | Reported | Above 40%: the prompt and the test disagree; revisit the prompt |
| `in-fix` share of findings, by round | Falls in rounds 3 and later | — |

"Should have blocked" is a flag on `finding.accept` for review-source rows, so the escape signal comes from the operator's own judgement when the follow-up is picked up.

## 16. Open questions for the operator

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Should new projects default to `must-fix` once the trial passes, or stay on `severity`? | Stay on `severity` until the trial's criteria pass; then make `shadow` the starter template's value and decide the default with the data |
| Q2 | In ordinary work, should a protected-class finding with reachability `unknown` block? | No: a follow-up, and the merge decision returns to the operator (11.5). Blocking would bring back the corner-case loop for every ordinary change that touches a check |
| Q3 | Should a `critical` severity block regardless of the other fields? | No routing on severity, but a `critical` finding that is not must-fix returns the merge decision to the operator |
| Q4 | Who may accept a deferral or follow-up of a protected-class finding in strict work: the operator only, or also `strictDecisionRole`? | The operator only |
| Q5 | Should environment facts live in configuration (as designed) or in a governing context file? | Configuration: they are short, operator-owned, citable by id and pinned per flow |
| Q6 | Cap of 3 must-fix send-backs, then park for the operator? | Yes, 3, and park rather than stop |
| Q7 | For GitHub-source projects, keep opening the follow-up issue in addition to the finding rows? | Yes, as today; the rows give every project the same record whatever its source |
| Q8 | Should the factory refuse a candidate whose builder also changed files only named by follow-ups? | No: tell the builder not to, and measure. Enforcing it needs path attribution the factory does not have |

## 17. What this design deliberately does not do

- It does not let a model's claim settle a finding. The factory checks citations; a fresh reviewer and the operator judge arguments.
- It does not change the strict exact-head acknowledgement, the strict attestations or the bounded-delta strict sequence.
- It does not add graph nodes, edges or route names.
- It does not approve follow-ups or create tasks from them automatically.
- It does not try to prove a reviewer inspected the code; the attestations remain model evidence, as `docs/risk-review.md:13` already states.
- It does not add new risk levels. "High-risk" in the request is the existing `strict` level.
