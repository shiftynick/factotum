# Must-fix review: design

Status: design only, second version (2026-11-17). Baseline: `main` at `f4b325e` (after dev.96).

Every statement about current behaviour cites a file and line at that commit. Citations that start `core/`, `operations/`, `workflows/`, `adapters/`, `service/` or `console/` are under `starter/factory/`.

This design answers a request from the third adopter's operator: review rounds should send back only findings that must be fixed. It also carries part of design #10, "ordinary delta review and finding ledger" (`docs/one-factory-progress.md:22`), whose direction is already set in `docs/one-factory-strategy.md:70`: findings get stable identities, a builder's "fixed" cannot settle a finding by itself, and the review chain is kept from a full baseline to the exact candidate.

**History of this document**

- First version: commit `0b292e6`, with 8 open questions.
- This version: an independent review (verdict: reject pending changes; direction sound) raised five high and four medium findings. The main points were that the first version weakened today's strict bar without saying so, and that a model's mistaken evidence claim could still clear a real defect. All nine are addressed; [section 18](#18-review-points-and-where-they-are-addressed) maps each to its answer.

## 1. The design in one page

A finding is **must-fix** when both hold:

- **(a) Reachable:** it can happen in the project's real setup, shown with evidence.
- **(b) Purpose:** it breaks what the change is for. That is the task's outcome, or one of four protected classes: security (including access), data loss (saved data), spending, and check trust (whether the factory's checks and evidence can be believed).

A must-fix finding sends the change back to the builder. Every other finding is one of two kinds, and neither sends the change back:

- **Operator item:** a concrete scenario the factory cannot clear on its own, because its reachability is unknown, its exclusion is not supported, it is in a protected class, or it is rated `critical`. The merge decision becomes the operator's, and the operator must accept each item by id (or send the change back) before the merge.
- **Follow-up:** a finding outside the change's purpose, or one whose exclusion is supported (section 11). It is recorded and can become an approved task. It does not affect who decides the merge.

The parts:

1. **Schema.** Each finding states a concrete `scenario`, whether it is `reachable` here with cited evidence, its `purposeImpact`, whether it is `silent`, and its `origin`. Every citation says what part of the scenario it covers, and each claim explains how its evidence covers the whole scenario. A review also returns a `purpose` assessment: is the outcome met, is each acceptance criterion met, and can the change give a wrong answer silently. The factory derives `mustFix` and the finding's kind; the model's verdict does not decide either.
2. **Two evidence checks, kept apart.** The factory **validates** citations: a quoted line exists at the reviewed head, an environment fact is one the operator declared, a record belongs to this flow, at the right candidate, with the cited check and result. Whether a claim is **supported** is a separate judgement: an independent reviewer must explain how validated evidence covers the complete scenario. A claim that rests only on validated existence is not supported and goes to the operator.
3. **Routing** reuses the existing routes (`revise`, `defer`, `pass`, `park`, `adjudicate`, `delta`), so no graph changes. A contradictory review that repeats its contradiction parks for the operator, even with no findings.
4. **Strict work changes, explicitly.** Today any finding blocks a strict pass. Under the must-fix bar that stays true unless the project also turns on `policy.review.strictFollowups`. With it on, three named kinds of finding may stop blocking, and each one must be acknowledged by id in the exact-head question; protected-class items only by the operator. The shared strict requirement in `core/risk.mjs` changes, and is checked at question opening, at answering and before the merge.
5. **One decision guard** decides when an ordinary merge returns to the operator (operator items, unverified criteria, a silent-answer assessment other than `no`, a non-must-fix `critical` finding, protective restrictions), checked at the same three points and for automatic merge.
6. **Later rounds** judge earlier fixes against the original scenario only. A different input, assumption or failure path is a new finding with its own derivation. From round 3, a corner case in a fix blocks only with validated evidence.
7. **Builder deferral** is allowed once per finding, with evidence; the next reviewer accepts it only by explaining coverage of the complete scenario.
8. **Cap:** after 3 must-fix send-backs the flow parks for the operator.
9. **Rollout:** `policy.reviewBar` is `severity` (today, the default) or `shadow`. The value `must-fix` is refused by configuration validation until the release that ships the ledger, the strict changes, the decision guard and the console evidence together, and only after the stale-output false-pass case is caught in a shadow trial. Activation is drained, every behaviour-affecting review setting is pinned per flow, and an operator-only restriction command tightens running flows when a kill criterion trips.

How this would have played out on the third adopter's PR (section 2): the corner cases about two machines with the same hostname and checkout path would have cited a declared environment fact ("one factory host per account") and become follow-ups, or been reported as unknown and become operator items that need one acceptance at the merge question rather than another build round. The stale-binaries defect is a silent wrong answer in the check-trust class; the purpose question "can it give a wrong answer silently?" is asked first in every round, and a `yes` there blocks.

## 2. The request and the field evidence

**What the third adopter saw.** One PR's independent review ran seven rounds. All 13 findings were fixed. Rounds 3 to 7 mostly found corner cases in the previous round's fixes, for example two machines with the same hostname and checkout path on one account, which their setup does not have. Each fix added a mechanism, and each mechanism gave the next round something new to find. No round found the defect that mattered: a sandbox could pass a head using main's stale binaries, so a false pass counted as merge evidence. The orchestrator's own reading caught it.

**What they asked for.**

| # | Request | Where this design answers it |
| --- | --- | --- |
| R1 | Review asks about purpose first: does the change do what its issue says, and can it give a wrong answer silently? | Section 10 |
| R2 | Each finding states a concrete scenario, whether it can happen here (with evidence), and whether it touches the change's purpose, as schema fields that drive routing | Sections 5, 6 |
| R3 | Later rounds judge whether earlier fixes hold; a new corner case in a fix is a follow-up unless it passes the must-fix test | Section 8 |
| R4 | A builder may defer a finding with evidence ("can't happen here", "not worth the mechanism"); the next round accepts that unless the evidence is wrong | Section 9 |

**Two failures, not one.** The field case shows a cost problem (five rounds spent on corner cases) and a quality problem (the defect that mattered was missed). Cutting rounds alone would fix the first and leave the second. That is why purpose-first and the check-trust class are part of the blocking bar, and why "fewer rounds" is never allowed to mean "fewer things the operator sees".

## 3. Current behaviour this design builds on

| Fact | Where |
| --- | --- |
| `REVIEW_SCHEMA` is a `verdict` (`pass` or `revise`), a `summary` and `findings` with `severity`, `file`, `line` and `message`. The schema helper makes every property required and allows no others. | `adapters/providers/index.mjs:9,13` |
| The change review schema adds a risk assessment, strict attestations, a scope summary, `priorFindingsDisposition` (`fixed`, `remaining`, `outside-scope`, with evidence) and learning citations. | `adapters/providers/index.mjs:29-30` |
| The schema validator is a bounded subset: types (including `null` in a type list), `enum`, `required`, `additionalProperties`, `items`, length and size bounds. Unknown keywords are refused. | `adapters/providers/index.mjs:43-64` |
| Every model brief carries the task's id, title, outcome (when set), acceptance criteria and the original request as quoted data, then governing context and risk instructions. | `workflows/dispatch.mjs:352,357`; `operations/original-request.mjs:37-43` |
| Plan review: a pass requires `findings: []`; findings are only blocking defects. A pass with findings gets one fresh protocol-correction review; a second contradictory result goes to substantive revision. Routes are `pass` and `revise`. | `workflows/dispatch.mjs:477-488`; `docs/risk-review.md:91` |
| Reviews are told to report every blocking finding in one round, check neighbouring cases together, and keep hardening outside the task's scope out of findings. | `workflows/dispatch.mjs:230-233` |
| The candidate review receives the trusted diff (full, or since the previous reviewed head in the delta phases), the builder's report and all prior reviews. It must give a disposition for every finding of the previous review, matched by exact message text. | `workflows/dispatch.mjs:611-625` |
| The builder receives the previous review as JSON and the factory's route. For strict work, "every finding requires resolution, including low-severity findings". | `workflows/dispatch.mjs:500-502` |
| Routing is in `reviewDisposition`. Under the default `fresh-full` protocol a review routes `pass` only with a pass verdict and no findings, else `revise`. Ordinary work: a pass with only low findings routes `defer` (`policy.deferLowFindings`, default on). | `core/delivery-review.mjs:10-19` |
| Under `bounded-delta`: strict work goes full, delta, final, and a full review that passes routes `delta`. A strict final with findings routes `adjudicate`. Ordinary work defers medium and low findings from round `ordinaryFollowupAfter`; the final ordinary round parks. A delta or final review that leaves a previous finding without evidence routes `revise` or `park`. | `core/delivery-review.mjs:4-9,13,20-29`; `docs/risk-review.md:41-58` |
| The reference change graph: `review` and `delta-review` route `pass` to the gate, `revise` to build, `delta` to delta review, `defer` to `followups` (then the gate), `adjudicate` to the gate, `park` to `review-question` (send back or stop). | `core/configuration.mjs:84-91` |
| A result route that the node has no edge for fails the attempt. | `core/engine.mjs:803` |
| `forge.followup` accepts only `defer` with medium or low findings in ordinary work, and opens one unapproved GitHub issue (at most 20 acceptance lines), linked from the PR, with a pending operator obligation. Its result mints review evidence. | `workflows/dispatch.mjs:405-415`; `adapters/github/index.mjs:183-212`; `core/operations.mjs:26` |
| Review evidence is minted only by a `pass` route, or by a strict final `adjudicate`. | `core/delivery-review.mjs:31`; `core/engine.mjs:802` |
| The **strict requirement** accepts only a review whose route is `pass` with a pass verdict and no findings, or a bounded-delta final `adjudicate`. Under bounded-delta it also needs a full and a delta review in history. A review routed `defer` is refused. The requirement's digest binds the summary, reviewer, scope, review result and identity; the answer must name the exact head and that digest. | `core/risk.mjs:28-45` |
| The strict requirement is computed when the merge or satisfied question opens, when it is answered, and before the effect: at the merge (`verifyDecision`) and when a satisfied outcome is recorded. | `core/engine.mjs:479`; `core/project.mjs:1021-1031`; `workflows/actions.mjs:193-209`; `workflows/dispatch.mjs:463,704` |
| `mergeDecisionRole: orchestrator` delegates ordinary merge decisions only, re-derived before merge. `autoMerge` needs ordinary risk, qualification and no upkeep marker. | `core/risk.mjs:11-13`; `workflows/actions.mjs:201`; `core/engine.mjs:502` |
| Risk is `ordinary` or `strict` (there is no other "high-risk" level). A missing classification is strict. Escalation is monotonic within a flow. | `core/risk.mjs:6-8,18-24` |
| The flow pins `reviewProtocol`, `mergeDecisionRole`, `strictDecisionRole`, its configuration digest and its executor digest when it starts. Every dispatch refuses a flow whose configuration digest or executor digest differs from the current one. | `core/project.mjs:674`; `core/project.mjs:169-170` |
| `config.update` is refused while any unfinished flow blocks a drain (every change and document flow does). A changed configuration needs doctor again before delivery. | `core/project.mjs:1338,84`; `core/project.mjs:527` |
| Live settings are admission, capacity, queue and notification knobs that leave the configuration digest unchanged, because they must not change how a running flow behaves. | `operations/live-settings.mjs:4-9`; `core/project.mjs:1291-1301` |
| A builder that returns `implemented` with the unchanged reviewed candidate after `revise` stops the flow, unless a replan changed the plan since that review. | `core/engine.mjs:643-644,825` |
| A move past a node's visit bound, or past the flow's transition bound, is refused with "inspect the flow before authorizing another cycle". A `send_back` answer (note required) extends every exhausted visit bound by one, except strict review nodes, adds 12 transitions, and clears the merge authorization and evidence. | `core/project.mjs:586-591,1004-1011` |
| Lesson signals: a finding of a sent-back round that a later review calls `fixed` with evidence is a verified correction. Matching is by message text. | `operations/lesson-signals.mjs:21-49` |
| A completed flow is not routine (it notifies) while any historical review finding lacks a later `fixed` disposition with evidence. | `operations/notifications.mjs:54-87` |
| The merge question shows the review verdict, finding counts by severity and the summary. | `operations/merge-context.mjs:27-45`; `console/ui/inbox.mjs:6,56-76` |
| Audit and upkeep findings are `finding` rows with a lifecycle and console commands to create a task from one or decline it. | `operations/governance.mjs:33-49`; `operations/upkeep-candidates.mjs:1-20`; `console/ui/operations.mjs:108-125` |
| Stats report review and build rounds per merged change. Usage accounting computes model invocations per attempt. A regression can be recorded against a flow. | `operations/stats-view.mjs:117,151-160`; `operations/usage-accounting.mjs:82-93`; `core/project.mjs:886-893` |

## 4. The must-fix test

### 4.1 The protected classes

| Class | What it covers |
| --- | --- |
| `security` | Access control, authentication, secrets, trust boundaries, injection: anything that lets someone act or read beyond what they should |
| `data-loss` | Loss or corruption of saved data, destructive operations, migrations that cannot be undone |
| `spending` | Money or metered usage spent without authority, or beyond a limit |
| `check-trust` | Anything that can make a check, a review or other evidence report a pass that is not true, or attach evidence to the wrong candidate. A false pass that counts as merge evidence is the defining case |

These map onto the strict escalation list the factory already uses (`workflows/dispatch.mjs:352`), with check trust named because the field case shows it is the class reviewers miss.

### 4.2 Why these never clear without the operator

- **They cannot be repaired later.** Lost data and spent money stay lost after a follow-up merges.
- **They are silent.** A security hole or a false pass produces no error and no failing check. A follow-up has nothing to remind anyone why it matters.
- **Check trust is load-bearing.** Every later merge decision relies on gate and review evidence. A false pass corrupts the evidence of every flow after it.
- **"Unknown" is the normal state of such a defect.** Absence of evidence is what an undetected defect looks like, so in strict work "unknown" blocks for these classes.
- **The cost is lopsided.** One more correction round costs minutes of model time. A missed one costs data, money or the operator's trust in the factory.

### 4.3 The derivation

The factory derives each finding's **kind** from the reported fields, the flow's effective risk, and the support status of any exclusion (section 11). `supported` and `unsupported` below are defined in 11.3. The table applies to strict work only when `policy.review.strictFollowups` is on; otherwise see 7.1.

| Flow risk | `purposeImpact` | `reachable` | Kind |
| --- | --- | --- | --- |
| any | `outcome` | `shown` | **must-fix** |
| any | `outcome` | `unknown` | operator item (`unresolved-scenario`) |
| any | `outcome` | `not-here`, supported | follow-up |
| any | `outcome` | `not-here`, unsupported | operator item (`unsupported-exclusion`) |
| strict | a protected class | `shown` or `unknown` | **must-fix** |
| strict | a protected class | `not-here`, supported | operator item (`protected-exclusion`), the operator's own acceptance only |
| strict | a protected class | `not-here`, unsupported | **must-fix** |
| ordinary | a protected class | `shown` | **must-fix**, and the flow escalates to strict |
| ordinary | a protected class | `unknown` or `not-here` | operator item (`protected-class`) |
| any | `none` | any | follow-up |

Rules on top of the table, in this order:

1. **`shown` needs a validated citation.** A `shown` finding whose citations are reasoning only, or none of which validates, is read as `unknown`. A `shown` finding with a citation that contradicts (a quote not found, a record at another head) is read as `unknown` and marked `contradicted`. Downgrades are recorded and shown.
2. **Unmet purpose always blocks.** If the purpose assessment says the outcome or a criterion is `not-met`, or a silent wrong answer is possible (`yes`), and no must-fix finding covers it, the factory adds one (10.3).
3. **A non-must-fix `critical` finding is an operator item** (`critical`), whatever the table says. Severity does not send a change back, but a reviewer's `critical` rating is never cleared without the operator.
4. **Restrictions apply last.** An active `review.restrict` (13.4) can turn follow-ups and exclusions into operator items; it never relaxes a kind.

**Escalation.** An ordinary flow with a `shown` protected-class finding becomes strict, recorded as an escalation by the review step, like a reviewer's own strict assessment (`core/risk.mjs:18-24`). From then on the strict rules of section 7 apply.

**Operator items do not mean another builder round.** The operator accepts each item at the merge question (it then becomes a follow-up row, marked as accepted by the operator), or answers `send_back` with a note, which is a builder round the operator chose.

## 5. Schema

### 5.1 Finding fields

The must-fix review schema keeps every current field and adds these. Optional values are expressed as `null`, since the schema helper requires every property.

```
finding: {
  severity:      critical | high | medium | low       (kept; routes only through rule 3 of 4.3)
  file, line, message                                  (kept)
  scenario:      string, 1..1200   concrete inputs, environment and state, the path taken, and the wrong result
  reachable: {
    status:      shown | unknown | not-here
    evidence:    citation[0..4]
    coverage:    string, 0..1200   how the evidence, taken together, covers the complete scenario
  }
  purposeImpact: outcome | security | data-loss | spending | check-trust | none
  silent:        boolean           the wrong result comes with no error and no failing check
  origin:        new-code | in-fix | missed
  fixOf:         string | null     the ledger id whose fix introduced it (origin in-fix)
}
citation: {
  kind:    file | environment | record | reasoning
  ref:     string, 1..300          a repository path, an environment fact id, a record id; "-" for reasoning
  quote:   string, 0..300          the exact text relied on (file)
  head:    string | null           the candidate the record was produced for (record)
  check:   string | null           the check or step id within the record (record)
  result:  string | null           the result the claim relies on, as recorded (record)
  covers:  string, 1..600          which part of the scenario this citation covers, and how
}
```

`origin`: `new-code` is in code this change adds that no earlier round reviewed; `in-fix` is in code a previous round's fix added; `missed` is in code an earlier round of this flow already reviewed without reporting it.

### 5.2 Purpose assessment and ledger judgements

```
purpose: {
  outcome:     met | partly | not-met | unverified
  acceptance:  [{ criterion: string (exact text of one acceptance line), status: met | not-met | unverified, evidence: citation[0..4] }]
  silentWrongAnswer: { answer: no | yes | unknown, how: string 0..1200, settle: string 0..600, evidence: citation[0..4] }
}
ledger: [{
  id:          string
  judgement:   fix-holds | fix-incomplete | deferral-accepted | deferral-rejected
  sameScenario: boolean            fix-incomplete only: the original scenario, unchanged, still fails
  coverage:    string 0..1200      deferral-accepted: how the builder's evidence covers the complete scenario
  relevance:   [covers | partial | irrelevant]   deferral judgements: one per builder citation, in order
  evidence:    citation[0..4]
}]
```

`settle` says what would settle an `unknown` silent-answer assessment. `ledger` replaces `priorFindingsDisposition` in must-fix and shadow flows; the factory also writes the old field from it (`fix-holds` as `fixed`, the rest as `remaining`) so older readers keep working. The plan review uses the same finding fields and `purpose`, without `ledger` and the strict attestations.

### 5.3 Fields only the factory writes

| Field | Meaning |
| --- | --- |
| `id` | `R<round>.<index>`, for example `R2.3`. Stable for the life of the flow |
| `kind` | `must-fix`, `operator-item` or `follow-up` (4.3) |
| `reason` | `outcome-shown`, `protected-class`, `unmet-acceptance`, `silent-wrong-answer`, `unresolved-scenario`, `unsupported-exclusion`, `protected-exclusion`, `critical`, `restricted`, `legacy-severity`, or `purpose-none` |
| `bar` | `must-fix`, or `legacy` when the finding lacks the new fields |
| `citations` | Per citation: `validated`, `not-found`, `stale`, `unknown-ref` or `not-checkable` (11.2) |
| `support` | For an exclusion or a deferral: `supported`, `existence-only`, `unsupported` or `contradicted` (11.3) |
| `claimDigest` | Digest of the finding as recorded, its citations, their validation and its support status. What an acknowledgement names |
| `downgraded` | Why a `shown` was read as `unknown`, when it was |

### 5.4 Protocol checks fail closed

A result that fails one of these checks is contradictory:

- `purpose.acceptance` lists each acceptance line of the task exactly once, by exact text.
- `silentWrongAnswer.answer: yes` comes with at least one finding marked `silent`.
- `origin: in-fix` names a `fixOf` that exists in the ledger.
- `ledger` judges every entry the factory marked as awaiting judgement (8.2). An omitted judgement is a contradiction, not a send-back: today's route for it (`revise`, `core/delivery-review.mjs:13`) would hand the builder nothing to fix.
- A `deferral-accepted` judgement has a `relevance` entry for every builder citation.

The first contradictory result gets one fresh correction review with the contradiction stated, as plan review does today (`workflows/dispatch.mjs:480-486`). **A second contradictory result routes `park`** with disposition `protocol-failure`, whatever it reports, including a pass with no findings. This check runs first, before the legacy fallback, the strict checks and every other route. It mints no review evidence. In a satisfied review, whose only other route is `revise`, it routes `revise`, which ends that flow as failed (`core/configuration.mjs:68`). In shadow flows the protocol failure is recorded as the shadow route and the actual route is today's.

### 5.5 Backward compatibility

- **Old results.** `reviewHistory` rows written before this change have no ids and no new fields. Ids are derived on read from the row's position, so no record is migrated. Their findings carry `bar: legacy`. Consumers that match prior findings by message text keep that path for legacy rows.
- **Adapters and fixtures that return only severity.** The provider adapter gives a real model the schema of the flow's bar, so a model in a must-fix flow returns the new fields or fails validation, as any malformed result does today. A scripted provider, a test fixture or a project's own adapter may still return the old shape. Each finding without the new fields is a `legacy` finding and is must-fix (today's strict meaning: every reported finding blocks). The purpose assessment is then missing, which is a protocol contradiction under 5.4. So a must-fix flow fed only the old shape can never pass on a weaker bar than today: an old-shape review with findings sends back, and one without findings parks after its correction review.
- **Severity flows are unchanged.** A flow pinned to `severity` gets the current schemas, prompts, routing and strict requirement byte for byte. A golden test holds this.
- **Graphs.** No node, edge or route name is added, so the reference graph digests do not change.

## 6. Routing

### 6.1 Route order

After deriving kinds and reading the ledger, the review takes the first route that applies:

| # | Condition | Route |
| --- | --- | --- |
| 1 | A second contradictory result (5.4) | `park` (`protocol-failure`) |
| 2 | Strict attestations or risk assessment incomplete | `revise`, or `park` in a final phase (unchanged, `core/delivery-review.mjs:18`) |
| 3 | An open must-fix item (a new must-fix finding, a fix judged `fix-incomplete`, or a contested deferral) and the cap is reached | `park` (`must-fix-cap`) |
| 4 | An open must-fix item | `revise`; in a strict bounded-delta final phase `adjudicate` (7.3) |
| 5 | A strict phase that must be followed by another review (7.3) | `delta` |
| 6 | Operator items or follow-ups not yet recorded | `defer` |
| 7 | Nothing open | `pass` |

The model's `verdict` is kept and shown. When it disagrees with the route, the review records `verdictOverridden`.

`policy.deferLowFindings` and `policy.ordinaryFollowupAfter` belong to the severity bar. They have no effect in a must-fix flow, and doctor says so when they are set on a must-fix project.

### 6.2 Recording operator items and follow-ups

- **Rows when the review settles.** The engine writes a `finding` row with `source: 'review'` for each operator item and follow-up in the same transaction that records the review, keyed by a digest of the flow id and the ledger id. Operator items are `needs-operator`; follow-ups are `unapproved`. At most `maxFollowupsPerFlow` rows per flow; the rest are counted on the flow, and an overflow is itself an operator item, so nothing is dropped unseen.
- **The forge step on `defer`.** `forge.followup` opens today's single unapproved GitHub issue when the source is GitHub, now listing scenario, kind and evidence status for each row. Under the must-fix bar it accepts a `defer` route when no item it records is must-fix at the reviewed identity, at either risk level, replacing today's "medium or low, ordinary only" assertion (`workflows/dispatch.mjs:406-407`) for must-fix flows. It is never reached from `adjudicate` (7.3); in that path the rows exist and the issue is not opened.
- **Approval.** A follow-up becomes work only as a task, approved like any task: by the operator, or on a migrated project by an orchestrator holding a grant for that exact task revision. Nothing is approved by being created.
- **Upkeep-origin flows** record rows only, never an issue, and the factory never creates tasks from them (consistent with knowledge-upkeep N1 and N2).

### 6.3 What the builder is shown

In a must-fix flow the correction brief lists only the open must-fix items: id, scenario, reachability evidence and its validation, purpose impact, and, for a fix judged incomplete or a contested deferral, the reviewer's judgement and evidence. Operator items and follow-ups are listed by id and one line under "Not required in this flow". The builder is told not to work on them unless the must-fix fix needs it, because each extra fix adds mechanism for the next round to examine. The strict instruction "every finding requires resolution" (`workflows/dispatch.mjs:500`) stays for strict flows without `strictFollowups`, and otherwise becomes "every must-fix item requires a disposition".

### 6.4 Plan review

Plan review uses the same finding fields and test. A must-fix plan finding routes `revise`. Other plan findings are carried into the build brief as advisory plan notes and recorded on the flow; nothing has been built, so they are neither follow-ups nor operator items. The protocol checks of 5.4 apply, with plan review's existing single correction. The strict plan check that adds a high finding when the threat model is missing (`workflows/dispatch.mjs:487`) adds it as a must-fix `check-trust` finding.

### 6.5 Already-satisfied review

The `satisfied-review` node routes only `pass` and `revise` (`core/configuration.mjs:68`). A must-fix finding or a protocol failure fails it as today. Operator items and follow-ups are recorded as rows and the satisfied question lists them through the decision guard (12.5) and, for strict work, the strict requirement (7.4).

## 7. Strict work

### 7.1 Two strict bars, and the default

| | `strictFollowups: false` (default) | `strictFollowups: true` |
| --- | --- | --- |
| Which findings block a strict pass | Every reported finding, as today, plus any finding the purpose rules add (4.3 rule 2) | Must-fix findings only (4.3) |
| Builder deferral | Not available | Available, with the limits of 9.1 |
| Ledger, purpose block, protocol checks, citation validation | Yes | Yes |
| Exact-head acknowledgement | As today, plus any operator item from 4.3 rules 3 and 4 | Every finding that did not block, by id (7.4) |

So the must-fix bar alone **makes strict work stricter, never weaker**: the same findings block as today, and purpose failures and protocol failures are added. Relaxing strict work is a separate, authority-bearing choice.

### 7.2 What may stop blocking with `strictFollowups` on

Compared with today, exactly these findings in strict work may stop sending the change back:

1. **`purposeImpact: none`**, at any reachability: style, structure, hardening outside the task and its threat model.
2. **`purposeImpact: outcome` with `reachable: unknown` or `not-here`** (an operator item unless the exclusion is supported).
3. **A protected-class finding with `reachable: not-here` and a supported exclusion** (an operator item the operator alone may accept).

Nothing else changes: protected-class findings that are `shown` or `unknown`, outcome findings that are `shown`, unmet criteria and silent wrong answers still block. Every finding in these three groups must be acknowledged, by id and claim digest, in the exact-head question before the strict merge or satisfied outcome is authorized.

### 7.3 Routing by phase

| Protocol and phase | Open must-fix item | No must-fix, items to record | Nothing open |
| --- | --- | --- | --- |
| `fresh-full` (every review is full) | `revise` | `defer`, then `followups`, then the gate | `pass` |
| `bounded-delta`, full phase | `revise` | `delta` (items stay in the ledger; never `defer` here, so the delta review cannot be skipped) | `delta` |
| `bounded-delta`, delta phase | `revise` | `defer`, then `followups`, then the gate | `pass` |
| `bounded-delta`, final phase | `adjudicate` (the open items join the acknowledgement list) | `defer` | `pass` |
| `bounded-delta`, an ordinary-phase review that finds strict risk | `delta` to a real full review, as today | same | same |

### 7.4 The strict requirement

`strictReviewRequirement` (`core/risk.mjs:28-41`) branches on the flow's pinned bar. For `severity` it is unchanged. For `must-fix` it requires:

- **Accepted review evidence:** the latest review at the exact candidate (head and tree) with complete attestations and assessment, and, under bounded-delta, a full and a delta review in history (unchanged). Its route is `pass`; or `defer`, with a `followups` result recorded at the same identity and the same review digest; or a bounded-delta final `adjudicate`. No must-fix item open in the ledger, except under `adjudicate`.
- **The acknowledgement list:** every finding of the flow that is not judged fixed and was not must-fix-and-fixed: adjudicated must-fix items, operator items, follow-ups (with `strictFollowups` on), and a silent-answer assessment of `unknown`. Each entry carries its id, kind, reason, claim digest and whether it is operator-only (protected-class items and anything under a restriction).
- **The digest:** `assessmentDigest` adds the digest of the acknowledgement list and of the ledger, so any change to a finding, a judgement or a support status invalidates an earlier answer.
- **The answer** (`core/project.mjs:1021-1031`) must carry `reviewedHead` (as today) and `acknowledgedFindings: [{ id, claimDigest }]` equal to the list. Operator-only entries require the actor to be the operator, even when `strictDecisionRole` is `orchestrator`.

It is computed at the three existing points with no new path: when the question opens (`core/engine.mjs:479`), when it is answered (`core/project.mjs:1021-1031`) and before the effect (`workflows/actions.mjs:198,208`; `workflows/dispatch.mjs:463,704`). The strict merge requirements therefore change, for must-fix flows only, in two ways: a `defer` review becomes acceptable evidence, and every non-fixed finding needs an explicit acknowledgement.

**End-to-end tests through real merge authorization** (scripted providers, the real `answer` command, the effect dispatcher and the test forge): strict `fresh-full` with a follow-up merges after acknowledgement; strict bounded-delta goes full, delta, `defer`, gate and merge, and a `defer` from the full phase is impossible; an answer missing one acknowledgement is refused; an answer naming a claim digest that changed is refused; `strictDecisionRole: orchestrator` acknowledging a protected exclusion is refused; a ledger change between answer and merge is refused before the merge; a severity flow merges exactly as today.

## 8. Later rounds

### 8.1 The ledger

`flow.reviewLedger` holds one entry per finding, by id: where it was raised, the finding with its factory fields, its status (`open`, `fixed-claimed`, `deferred-claimed`, `fixed`, `contested`, `follow-up`, `operator-item`, `operator-accepted`, `operator-required`), the builder's disposition, and each later judgement with the reviewer's provider and model family. It is derived from `reviewHistory` and the build results, so it can always be recomputed and needs no migration.

### 8.2 How a round judges earlier fixes

Each review after the first receives, before the diff: the purpose block (10.1); the ledger entries awaiting judgement (every `fixed-claimed`, `deferred-claimed` and `contested` entry, with scenario, the builder's disposition, its evidence and the validation of each citation), delivered as quoted data like the original request (`operations/original-request.mjs:41-43`); the paths each claimed fix changed; and the diff, as today (`workflows/dispatch.mjs:612-614`).

The reviewer judges each entry:

- **`fix-holds`:** the original scenario no longer produces the wrong result.
- **`fix-incomplete`:** the **original** scenario still produces it: the same inputs, the same environment assumptions, the same failure path and the same wrong result. The reviewer must set `sameScenario: true` and cite evidence. A judgement that does not is a contradiction (5.4).
- **`deferral-accepted` or `deferral-rejected`:** section 9.3.

**Anything materially different is a new finding.** A different input, a different environment assumption, or a different failure path reaching a similar result is reported as a new finding with `origin: in-fix` and `fixOf`, and gets its own derivation, including the rule in 8.3. The original entry is judged `fix-holds` if its own scenario is fixed.

### 8.3 New corner cases in fixes

From round `policy.review.inFixEvidenceFrom` (default 3), an `in-fix` finding is must-fix only when at least one of its reachability citations validates and its coverage is stated. Reasoning alone makes it an operator item (`unresolved-scenario`) if its purpose impact is `outcome`, or a follow-up if `none`. The rule does not lower protected classes in strict work, where `unknown` still blocks; those flows are bounded by the cap and the strict final adjudication.

A `missed` finding is judged by the ordinary test. A miss is still a defect, and the count of misses by round measures review quality (section 16).

## 9. Builder deferral

### 9.1 The disposition record

```
findingDispositions: [{
  id:          string                          a ledger id from the correction brief
  disposition: fixed | deferred
  reason:      cant-happen-here | not-worth-mechanism | null
  evidence:    citation[0..4]
  coverage:    string 0..1200                  how the evidence covers the complete scenario
  note:        string 0..1200
}]
```

- A missing entry for an open must-fix item is read as `fixed-claimed`, and the next reviewer judges it.
- `cant-happen-here` needs at least one non-reasoning citation and stated coverage.
- `not-worth-mechanism` disputes the purpose half of the test (the scenario is real but its effect is outside the change's purpose or tolerable). It is allowed only for `outcome` findings in ordinary flows.
- Protected-class findings can be deferred only as `cant-happen-here`, only in flows where deferral is available (7.1), and not while the `protectedClassDeferral` restriction is set (13.4).
- A finding can be deferred once. After a `deferral-rejected` judgement it is `contested`: the builder must fix it, or return `blocked`, which reaches the operator through the existing build question.
- A deferral with a contradicted citation is void, and the item stays open; the builder is told which citation failed.

### 9.2 An unchanged candidate

Today an unchanged candidate after `revise` stops the flow (`core/engine.mjs:644,825`). When every open must-fix item has a valid `deferred` disposition, the unchanged candidate is reviewed again instead, the same exemption a changed plan already has (`core/engine.mjs:643`). That review judges only the deferrals. The exemption is used at most once per finding.

### 9.3 How the next reviewer judges a deferral

The reviewer is told to accept a deferral only when the builder's evidence, taken together, covers the complete scenario, and to explain how in `coverage`, marking each builder citation `covers`, `partial` or `irrelevant`. It rejects by citing what the evidence misses or gets wrong.

| Builder's citations | Reviewer's judgement | Result |
| --- | --- | --- |
| at least one validated and marked `covers`, none contradicted | `deferral-accepted` with coverage | supported: a follow-up (or an operator item if the class requires it, 4.3) |
| validated, but none marked `covers`, or coverage empty | `deferral-accepted` | existence-only: an operator item (`unsupported-exclusion`) |
| none validated | `deferral-accepted` | unsupported: an operator item |
| any | `deferral-rejected` with a validated citation | `contested`: must-fix |
| supported | `deferral-rejected`, reasoning only | operator item (`disputed`), no further round |
| not supported | `deferral-rejected`, reasoning only | `contested` |

### 9.4 Why this stops loops without clearing defects

- **Loops end** because a deferral is judged once, a contested finding cannot be deferred again, disputes go to the operator instead of another round, late corner cases in fixes need validated evidence to block, and the cap parks the flow.
- **Defects are not cleared by assertion** because the factory validates every citation, an independent reviewer must explain coverage of the complete scenario, anything accepted on existence alone goes to the operator, protected classes are never cleared without the operator, and every non-fixed finding stays visible as a row, at the merge question and in the completion notice.

### 9.5 Cap and escalation

`policy.review.mustFixRounds` (default 3, 1 to 12) bounds the review rounds of a flow that route `revise` for must-fix items. The review that would start one more routes `park` to `review-question`.

- **"One more round"** is the operator's `send_back` answer there, with its required note. It allows exactly one further must-fix send-back: the cap rises by one for this flow and is recorded with the answer. Through today's mechanism it also extends each exhausted visit bound by one and adds 12 transitions (`core/project.mjs:1004-1011`), but it does not extend strict review nodes, so strict work has no unbounded loop.
- **Running out of budget.** The node visit bounds (`maxBuildRounds` for build, the review visit bound for the review nodes) and the transition bound remain hard limits. Commissioning refuses a cap above `maxBuildRounds` or `ordinaryReviewRounds`, so the cap parks first. If a bound is still reached (for example after several `send_back` answers), the move is refused and the flow stops with "workflow visit bound exhausted" (`core/project.mjs:586-591`); recovery is the existing deliberate resume or replan.
- **Operator dispositions before a retry.** A new operator command, `flow.disposeFinding`, records `operator-accepted` or `operator-required` on one ledger entry, with a note and the entry's version, so a contested or disputed finding can be settled before `retry` or `send_back`. For protected-class items it is the operator's alone; for outcome items in ordinary work a delegated orchestrator may record `operator-required`, never `operator-accepted`.

## 10. Purpose first

### 10.1 How the purpose reaches the reviewer

The task's title, outcome, acceptance criteria and original request are already in every brief (`workflows/dispatch.mjs:357`). In must-fix and shadow flows the review prompt puts a purpose block before the diff and asks the reviewer to answer it before looking for defects: the outcome verbatim (a task without one uses its title and criteria, and the merge question says "no outcome recorded"); each acceptance criterion, numbered; the reviewed plan's summary, checks and risks; from round 2, the ledger entries awaiting judgement; the protected classes; and the declared environment facts.

### 10.2 The two questions

- **Does the change do what its task says?** Answered in `purpose.outcome` and per criterion, each with evidence. `unverified` is allowed; it is honest when the reviewer cannot run code.
- **Can it give a wrong answer silently?** Answered in `silentWrongAnswer`: `no`, `yes` with how, or `unknown` with what would settle it. The prompt names the usual forms: a check that passes without running what it claims to, results attached to the wrong candidate or head, stale inputs read as current (the field case), an error swallowed into a default value, a fallback that hides a failure.

### 10.3 How the answers route

| Answer | Ordinary work | Strict work |
| --- | --- | --- |
| Outcome or a criterion `not-met` | A must-fix finding is added if none covers it | Same |
| A criterion `unverified`, or outcome `partly` or `unverified` | Not a send-back; the decision guard returns the merge to the operator (12.5) | Not a send-back; listed for acknowledgement (7.4) |
| `silentWrongAnswer: yes` | A must-fix finding is required (5.4); a `shown` check-trust one escalates the flow | Must-fix |
| `silentWrongAnswer: unknown` | Not a send-back; the decision guard returns the merge to the operator | **Not a send-back, but it blocks the merge until acknowledged** in the exact-head question with its `settle` text |

Section 1 and this table say the same thing: in strict work, an `unknown` silent-answer assessment never reaches a merge without an explicit acknowledgement, and it never starts a builder round on its own, since it names no scenario to fix.

## 11. Evidence trust

### 11.1 The problem

A reviewer's "this can happen here" and a builder's "this can't happen here" are both model output, often written without running code. A citation can be real and still irrelevant: a guard that exists but sits on a different path, an environment fact about something else, a passing check from another candidate. So the design keeps two questions apart: does the cited thing exist (the factory can check that), and does it support the claim (only judgement can).

### 11.2 Validation, by the factory

| Citation kind | Validated when | Otherwise |
| --- | --- | --- |
| `file` | The quote is found in that file at the head the claim is about, whitespace collapsed (the knowledge-upkeep validator's check). Absolute paths, `..` and paths outside the repository are refused | `not-found` (contradicted) |
| `environment` | The fact id exists in the flow's pinned facts | `unknown-ref` |
| `record` | The record belongs to this flow; its identity's head equals the citation's `head`; that head is the one the claim is about (the reviewed candidate for a reviewer's claim, the build's output for a builder's); the named `check` exists in the record; and its recorded result equals `result` | `stale` when the head differs (contradicted); `unknown-ref` otherwise |
| `reasoning` | Never | `not-checkable` |

The record binding closes the field case's shape: a passing result recorded for another head, or by another check, cannot be cited as evidence about this candidate.

### 11.3 Support, by judgement

A claim is one of:

- **`supported`:** at least one citation validated, none contradicted, coverage of the complete scenario stated, and the claim confirmed by someone other than its author. For a builder's deferral, that is an independent reviewer's `deferral-accepted` with coverage and at least one validated citation marked `covers` (9.3). For a reviewer's own `not-here`, it is a validated `environment` citation whose `covers` text and the finding's coverage tie the fact to the scenario: the fact is the operator's own statement, which is the confirmation.
- **`existence-only`:** citations validate, but no independent confirmation that they cover the scenario.
- **`unsupported`:** nothing validates.
- **`contradicted`:** a citation contradicts.

Only `supported` exclusions and deferrals can become plain follow-ups. Every other status leaves an operator item or a must-fix finding (4.3, 9.3). "Validated" is never shown as "verified", so no one reads it as proof of the argument.

### 11.4 Environment facts

The strongest "can't happen here" evidence is a fact about the project's real setup that the operator stated, such as "each account runs the factory on one host" or "checkout paths are unique on a host". They are declared in `policy.review.environment` as `{ id, fact }` entries (at most 40, each at most 300 characters). They are configuration, not repository files, so a builder cannot add one; they are authority-bearing and operator-only (section 13); every must-fix brief lists them; and each flow pins the facts it started with.

### 11.5 What the operator sees

At the merge question and on the flow's page, every finding that was not fixed is listed with: id, kind and reason, scenario, class, reachability, each citation with its validation status, the support status, who deferred or excluded it, each reviewer judgement with the reviewer's model family, and its row or issue. Operator items come first, then protected-class follow-ups, then the rest. A contradicted citation is shown with the quote or head that did not match.

## 12. Interactions

### 12.1 Lesson signals

`operations/lesson-signals.mjs` keeps its rules for legacy rows. For must-fix rows, matched by ledger id: a verified `review-correction` only for a must-fix finding later judged `fix-holds` (a contested one later fixed is marked `contested`); operator items, follow-ups and accepted deferrals produce no verified signal; two new weak kinds, `review-deferral` and `fix-churn`. Weak signals alone still never cause an upkeep model call (knowledge-upkeep N5).

### 12.2 Notification classification

`flowNeedsAttention` (`operations/notifications.mjs:54-87`) reads the ledger for must-fix flows: any operator item, follow-up, deferral or operator disposition makes the flow non-routine, as unresolved history does today. Parking at the cap or on a protocol failure notifies through its question.

### 12.3 The console

- **Merge and satisfied questions:** for must-fix flows the severity counts are replaced by counts of must-fix open, operator items, follow-ups and deferrals, the purpose assessment, and the list of 11.5. The acknowledgement list is answered with one check box per item, sending the claim digests the page displays; a changed item makes the project refuse the answer and the refreshed page shows the change, as for `reviewedHead` today.
- **Flow page:** the review ledger, one row per finding.
- **Findings page:** review-source rows beside audit findings, with the existing create-task and decline forms.
- **State view and stats:** the new fields, bounded; the measures of section 16.

### 12.4 Knowledge upkeep follow-ups

Upkeep-origin flows get the project's bar. Their rows are never turned into issues or tasks by the factory (6.2). A docs follow-up that parks, at the cap or on a protocol failure, has reached a question other than its merge decision, so it is ended (knowledge-upkeep N2).

### 12.5 The decision guard

One shared function, `reviewDecisionGuard(task, flow, identity)`, returns whether the merge or satisfied decision must be the operator's, the reasons, and the acknowledgement list. In an ordinary must-fix flow the decision is the operator's, and `autoMerge` does not answer, when any of these hold:

- an operator item of any reason (unresolved scenario, unsupported or existence-only exclusion or deferral, disputed deferral, protected class, `critical`, restricted, row overflow);
- a criterion that is not `met`, or an outcome other than `met`;
- a silent-answer assessment other than `no`;
- an active `review.restrict` with `operatorDisposition: all`.

The operator's answer must then carry `acknowledgedFindings` for the listed items, as in 7.4. The guard's digest is part of the question's subject, so a change reopens the question.

It is evaluated at the same three points as the strict requirement: when the question opens (`core/engine.mjs:479-505`, including the `autoMerge` decision at `:502`), when it is answered (`core/project.mjs:1026-1031`, beside the delegation re-check), and before the effect (`workflows/actions.mjs:193-209`; `workflows/dispatch.mjs:463,704`). A severity flow's guard is empty.

### 12.6 Full and delta review protocols

`fresh-full` reviews the whole change every round and also receives the ledger. Under `bounded-delta`, delta and final reviews judge the ledger by id, and section 7.3 gives the strict phase routing. An ordinary final review with an open must-fix item parks, as today. Both protocols count must-fix send-backs against the cap.

### 12.7 Document flows and adopted pull requests

Document flows use the same test; their findings are almost always `outcome` or `none`. Adopted pull requests use the same bar, and their merge decision is already the operator's.

## 13. Configuration, pinning and restrictions

### 13.1 Settings

```json
{
  "policy": {
    "reviewBar": "shadow",
    "review": {
      "mustFixRounds": 3,
      "inFixEvidenceFrom": 3,
      "maxFollowupsPerFlow": 20,
      "strictFollowups": false,
      "environment": [
        { "id": "single-host", "fact": "Each account runs the factory on one host." }
      ]
    }
  }
}
```

| Setting | Values | Default | Authority |
| --- | --- | --- | --- |
| `policy.reviewBar` | `severity`, `shadow`; `must-fix` from the enabling release (15) | `severity` | Authority-bearing: operator-only on both schemas |
| `policy.review.mustFixRounds` | 1 to 12, not above `maxBuildRounds` or `ordinaryReviewRounds` | 3 | As the existing round settings |
| `policy.review.inFixEvidenceFrom` | 2 to 12 | 3 | As the existing round settings |
| `policy.review.maxFollowupsPerFlow` | 1 to 50 | 20 | As the existing round settings |
| `policy.review.strictFollowups` | boolean | `false` | Authority-bearing: operator-only |
| `policy.review.environment` | up to 40 `{id, fact}` | none | Authority-bearing: operator-only |

The authority-bearing ones join `authorityPolicy` (`core/authority-policy.mjs:16-33`). Commissioning refuses `must-fix` when a `provider.review` node other than a satisfied review lacks a `defer` edge, since the route would fail the attempt (`core/engine.mjs:803`).

### 13.2 Activation is drained

None of these settings is a live setting. They change only through `config.update`, which is refused while any change or document flow is unfinished (`core/project.mjs:1338`), followed by doctor (`core/project.mjs:84`). Every dispatch already refuses a flow whose configuration or executor digest differs from the current one (`core/project.mjs:169-170`). So activation is: let running flows finish, or stop or abandon them; change the configuration; run doctor; then new flows start under the new bar. No flow ever changes bar mid-flight through configuration.

### 13.3 Pinning is the invariant

Each flow pins, when it starts and beside `reviewProtocol` (`core/project.mjs:674`), every review setting that affects its behaviour: `reviewBar`, `mustFixRounds`, `inFixEvidenceFrom`, `maxFollowupsPerFlow`, `strictFollowups`, a copy of the environment facts, and the schema version of the review and build schemas it uses. Routing, the strict requirement and the decision guard read only the pinned values. Drained activation means a pinned value never differs from the configuration while the flow runs today; pinning keeps that true if a future change ever lets a flow survive a configuration change (as carried-over task flows already do, `core/project.mjs:530-543`), and it lets records be read correctly after the configuration has moved on.

### 13.4 The restriction command

Kill criteria need a way to tighten running flows without a drain. Live settings cannot do this, by their contract (`operations/live-settings.mjs:4-9`). So this design adds one explicit, tightening-only exception: an operator-only command, `review.restrict`, stored in project meta (not the configuration, so no digest changes and no flow is refused), versioned, and recorded as an event.

| Restriction | Effect from the next step that reads it |
| --- | --- |
| `protectedClassDeferral: false` | Builder deferrals of protected-class findings are void; a reviewer's `not-here` on a protected class is read as `unknown` (must-fix in strict work, an operator item in ordinary work); protected-class follow-ups already recorded become operator items |
| `operatorDisposition: all` | Every non-fixed finding in a must-fix flow is an operator item; no delegated or automatic merge for must-fix flows |

Lifting a restriction is the same command, operator only. The restriction version is part of the decision guard's and the strict requirement's digests, so an open question whose list changes is superseded and reopened, and an answer given before the restriction is refused before the merge. Nothing a restriction does can relax a kind or authorize anything, which is why it may apply to running flows when configuration may not.

## 14. Rollout and migration

### 14.1 Default and stages

`severity` stays the default. A project moves through:

1. **`shadow`:** the must-fix schemas and purpose-first prompt, today's routing. Each review records `shadowRoute` (versions in 14.2) and the derived fields. Costs somewhat longer reviewer output; changes no outcome.
2. **`must-fix`:** available only from the enabling release (slice 6), only after the prerequisites of 15, and only by drained activation (13.2).

### 14.2 What `shadowRoute` can mean

`shadowRoute` is an estimate: the route must-fix would have taken on the review that actually ran. In a must-fix flow the builder would have acted differently and later reviews would have seen a different candidate, so shadow savings are estimates and are labelled so everywhere. Each value records its version:

| Version | From | Includes | Use |
| --- | --- | --- | --- |
| `v1` | Slice 1 | Per-finding derivation and citation validation only. No purpose synthesis, no protocol failure, no ledger, no deferral support. It understates blocking (unmet criteria are not added) and cannot show later-round behaviour | Schema and prompt health only. Never used to decide enabling |
| `v2` | Slice 2 | Adds purpose synthesis and protocol failure | Purpose catch rate |
| `v3` | Slice 3 | Adds the ledger, later-round judgements, the in-fix rule and support status for reviewer exclusions | The only version the enabling decision may rest on |

Builder deferral cannot be shadowed, because builders in shadow flows are told to resolve findings by today's rules; its first data comes from enforcement.

### 14.3 Migration

Records need none: ids, kinds and the ledger are derived (5.5, 8.1). Graphs need none: no node or edge changes. The release notes describe drained activation, the stages, `strictFollowups`, the restriction command, and that `deferLowFindings` and `ordinaryFollowupAfter` do not apply to must-fix flows.

## 15. Slices

Every slice ships with its tests and leaves severity flows byte-identical. **Until slice 6, configuration validation refuses `reviewBar: must-fix`** with "not available in this release"; slices 3 to 5 build enforcement code that only fixtures exercise. Structural behaviour is tested with scripted results; what a real model does is judged in the trial.

**Slice 1: schemas, ids, validation, shadow v1.**
- The must-fix schemas for plan review and change review; factory ids; citation validation including record binding; the derivation of 4.3; legacy handling; `reviewBar: shadow`; pinning of every review setting; `shadowRoute` v1.
- Accepted when: every row and rule of 4.3 has a fixture; `shown` with reasoning only, with a missing quote and with a record at another head is read as `unknown`; record citations with the wrong check or result do not validate; legacy rows get stable ids; the new schemas pass `validateSchemaDefinition`; a severity flow's prompts, schemas and routes are byte-identical (golden test); in shadow the actual route always equals the severity route; `must-fix` is refused by validation.

**Slice 2: purpose first and fail-closed protocol checks, shadow v2.**
- The purpose block; the purpose assessment; the checks of 5.4 with one correction review and `park` on the second; purpose synthesis.
- Accepted when: a pass with **no findings** that omits an acceptance criterion, twice in a row, parks with `protocol-failure` and mints no evidence; the same for an omitted ledger judgement once slice 3 exists; protocol failure takes precedence over the legacy fallback; `not-met` without a finding adds a must-fix finding; an old-shape result in a must-fix fixture flow never passes; a task without an outcome is labelled.

**Slice 3: ledger, later rounds and support, shadow v3.**
- `flow.reviewLedger`; the ledger block and judgements; id matching with the legacy fallback; `sameScenario`; the in-fix rule; support status of reviewer exclusions; the mirrored `priorFindingsDisposition`.
- Accepted when: **a fixture where the original fix holds but the reviewer reports a corner case in that fix with a different input, at round 3 with reasoning only, records the original as `fix-holds` and the corner case as a new `in-fix` finding that is not must-fix**; a `fix-incomplete` without `sameScenario` is a contradiction; a protected-class `in-fix` finding in strict work still blocks; the recomputed ledger equals the stored one.

**Slice 4: enforcement routing and deferral (fixtures only).**
- Route order of 6.1; row recording at settlement; `forge.followup` under the new assertion; builder brief; deferral and its judgement table; the unchanged-candidate exemption; the cap with `send_back` semantics; `flow.disposeFinding`; plan notes; the commissioning `defer`-edge check.
- Accepted when: each route and each row of 9.3 has a fixture at both risk levels and both protocols; existence-only acceptance yields an operator item; a second deferral of a contested finding reaches the build question; the fourth must-fix send-back parks and `send_back` allows exactly one more.

**Slice 5: strict requirement, decision guard, console evidence, restrictions (fixtures and end-to-end).**
- The strict requirement of 7.4; `strictFollowups`; the decision guard of 12.5 with the `critical` rule; the acknowledgement answer field; the console of 12.3; `review.restrict`; notifications and lesson signals.
- Accepted when: the end-to-end tests of 7.4 pass; each guard condition returns an ordinary decision to the operator at opening, answering and before the merge, and blocks `autoMerge`; a non-must-fix `critical` finding does so at all three points; a restriction applied with a merge question open supersedes it and refuses an earlier answer before the merge; a severity flow's questions and answers are unchanged.

**Slice 6: enabling.**
- Configuration validation accepts `must-fix`. Ships only with slices 3 to 5 in the same release, and only after the prerequisite below.
- **Prerequisite:** in a shadow v3 trial on a real project, the seeded stale-output false-pass case (a check that passes on stale build output from the target, so its pass would count as merge evidence) is reported as a must-fix `check-trust` finding or `silentWrongAnswer: yes`, and the deterministic fixture of the same case routes `revise` under the enforcement code in ordinary and strict work. If the trial does not catch it, `must-fix` is not enabled, and the purpose prompt is revised first.

**Slice 7: enforcement trial with the third adopter** (section 16), with these seeded cases:

| Seeded case | Expected |
| --- | --- |
| A fix that introduces a corner case needing a setup the project does not have | *Model:* `in-fix`, `not-here` citing a declared fact (a follow-up) or `unknown` (an operator item); no builder round |
| A check that can pass on stale build output | *Model:* blocks as check trust |
| An unmet acceptance criterion the diff looks plausible for | *Model:* `not-met`; blocks |
| A deferral citing a real guard on a different path | *Model:* rejected, or accepted only as existence-only and put to the operator |
| A deferral citing a passing check from an earlier head | Not validated (`stale`); the item stays open |
| A strict change with a possible secret leak the reviewer cannot confirm | Blocks |
| A reviewer that keeps rejecting a well-supported deferral by argument | A disputed operator item; no extra round |

## 16. Metrics, windows, success and kill criteria

### 16.1 What is measured

For **every admitted change and document flow**, under each bar, not only merged ones:

- terminal outcome: merged, satisfied, failed, stopped, abandoned, or still open at the window's end;
- parked at the cap, parked on a protocol failure;
- review rounds, build rounds and model invocations (from usage accounting);
- operator effort: questions answered, acknowledgements given, dispositions recorded, and time from each question opening to its answer;
- elapsed time from admission to the terminal state;
- operator items, follow-ups and deferrals created, and each follow-up's fate 30 days after creation (task approved, declined, expired, open);
- verdict overrides and contradiction corrections;
- `in-fix` and `missed` findings by round.

**Escaped defects:** a regression recorded against a flow (`core/project.mjs:886-893`), or a review-source row the operator marks "should have blocked" when accepting or declining it, a new flag on `finding.accept` and `finding.resolve` for those rows.

### 16.2 Windows

- **Baseline:** severity flows admitted in the 30 days before shadow activation, from existing records.
- **Shadow window:** from shadow activation until 15 admitted flows have reached a terminal state, at least 7 days and at most 28. Shadow comparisons are reported as estimates (14.2).
- **Enforcement window:** the same rule from must-fix activation.
- **Escape window:** 30 days after each merge, counted for every flow merged in either window.

### 16.3 Criteria and procedures

| Measure | Pass | Trigger | Procedure |
| --- | --- | --- | --- |
| Mean review rounds per admitted flow | Falls at least 30% from baseline (measured, not the shadow estimate) | No fall by the end of the enforcement window | Return to `shadow` by drained activation; revise the test |
| Flows parked at the cap or on a protocol failure | At most 10% | Above 25% | Same |
| Flows stopped or abandoned | No higher than baseline | 10 points above baseline | Same |
| Operator effort per admitted flow | At most baseline plus one acknowledgement | Twice baseline | Review which operator-item reasons dominate; adjust support rules |
| Elapsed time per completed flow | No worse than baseline | 50% worse | Same as rounds |
| Follow-ups approved or recorded as dealt with | At least 30% | Above 70% declined or expired | Stop creating rows for `purpose-none` findings (a design change in the next release) |
| Escaped defect in a protected class | None | Any one | At once: `review.restrict` with `operatorDisposition: all` and `protectedClassDeferral: false`. Then drain and set `reviewBar: severity`. Flows pinned to `must-fix` finish under the restrictions, or the operator stops them |
| Escaped defects of any class | At most 1 in the enforcement window | 2 or more | At once: `review.restrict` with `operatorDisposition: all`; then the same drained switch-back |
| Accepted protected-class deferrals later marked "should have blocked" | None | Any one | `review.restrict` with `protectedClassDeferral: false`, kept until a design change |
| Purpose catches in seeded cases | The stale-output case caught | Not caught | Do not enable, or, after enabling, `operatorDisposition: all` until the prompt is fixed |
| Verdict overrides | Reported | Above 40% | Revise the prompt; no automatic action |

## 17. Open questions for the operator

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Should new projects default to `shadow` once slice 2 ships, or stay on `severity`? | `severity` by default; `shadow` in the starter template once slice 3 ships, so projects collect v3 data |
| Q2 | In ordinary work, may an outcome or protected-class finding with reachability `unknown` stop sending the change back? This now depends on the safeguards of 4.3, 11.3 and 12.5: it becomes an operator item, the merge decision is the operator's, and the operator accepts it by claim digest | Yes, with those safeguards; without them it should block |
| Q3 | Is the `critical` safeguard right: never a send-back by severity alone, but a non-must-fix `critical` finding always returns the decision to the operator, at opening, answering and before the merge? | Yes, as designed in 4.3 rule 3 and 12.5 |
| Q4 | With `strictFollowups` on, may `strictDecisionRole` acknowledge strict items that are not protected-class, or only the operator? | The strict decision role for those; the operator only for protected-class items |
| Q5 | Should environment facts live in configuration (as designed) or in a governing context file? | Configuration: short, operator-owned, citable by id, pinned per flow |
| Q6 | The cap: 3 must-fix send-backs, then park. "One more round" is a `send_back` with a note that allows exactly one further send-back and extends each exhausted visit bound by one (not strict review nodes). When a hard visit or transition bound is reached anyway, the flow stops and needs a deliberate resume or replan. Is that the right behaviour? | Yes; park rather than stop at the cap, and no automatic extension |
| Q7 | For GitHub-source projects, keep opening the follow-up issue in addition to the rows? | Yes, as today |
| Q8 | Should `strictFollowups` exist at all in the first enforcement release, or wait for enforcement data on ordinary work? | Ship it, off, and turn it on for the third adopter only after the enforcement window passes |

## 18. Review points and where they are addressed

| # | Point | Answer |
| --- | --- | --- |
| 1 | A valid citation is not a supported claim | Validation and support are separate (11.2, 11.3); every citation states what it covers and every claim its coverage (5.1, 9.1); record citations are bound to head, check and result (11.2); an acceptance resting on existence alone is an operator item (9.3); strict protected-class exclusions need the operator's acceptance of that claim digest (4.3, 7.4) |
| 2 | Unsupported reachability can allow a delegated merge | Unresolved scenarios and unsupported exclusions are operator items, not follow-ups (4.3), without forcing a builder round; unverified criteria are in the guard (10.3, 12.5); the strict relaxation is opt-in, listed exactly and acknowledged per finding (7.1, 7.2); the strict `unknown` silent answer is consistent in sections 1 and 10.3 |
| 3 | Strict follow-up routing clashes with the strict requirement | Phase routing that never defers from a strict full phase (7.3); accepted evidence, acknowledgement list and digest (7.4); the change at question opening, answering and effect; end-to-end tests through real merge authorization; the document now says strict requirements change |
| 4 | A second contradictory review must fail closed | It parks with `protocol-failure` even with no findings, before the legacy fallback; omitted ledger judgements are contradictions (5.4); old-shape results cannot pass on a weaker bar (5.5); the empty-findings test is in slice 2 |
| 5 | No weaker routing before its safeguards | `must-fix` is refused by validation until slice 6, which ships with the ledger, strict changes, guard and console; earlier slices are shadow only (15); shadow route versions and what each may be used for (14.2); the stale-output case is a prerequisite (15, slice 6) |
| 6 | `fix-incomplete` must cover only the original failure | Defined by same inputs, assumptions, path and result, with `sameScenario` (8.2); anything else is a new finding under the in-fix rule; the fixture is in slice 3 |
| 7 | Critical-finding safeguard | 4.3 rule 3; the guard at all three points (12.5); slice 5 tests; Q3 |
| 8 | Active-flow compatibility claim | Drained activation (13.2); pinning of every behaviour-affecting setting (13.3); the one tightening-only mid-flow change is designed explicitly (13.4) |
| 9 | Trial metrics | Every admitted flow and operator effort (16.1); estimates labelled (14.2, 16.2); windows (16.2); executable procedures with the restriction command and the fate of pinned flows (16.3) |

## 19. What this design deliberately does not do

- It does not let a model's claim clear a finding by itself. The factory validates citations; an independent reviewer or the operator decides whether they support the claim.
- It does not weaken strict work unless the operator turns on `strictFollowups`, and then only for the three groups of 7.2, each acknowledged.
- It does not add graph nodes, edges or route names.
- It does not approve follow-ups or create tasks from them automatically.
- It does not change review behaviour of a running flow through configuration; only the tightening-only restriction reaches running flows.
- It does not try to prove a reviewer inspected the code; attestations remain model evidence (`docs/risk-review.md:13`).
- It does not add risk levels. "High-risk" in the request is the existing `strict` level.
