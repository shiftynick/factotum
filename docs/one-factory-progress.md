# One-factory progress

Updated: **2026-11-14**. Programme baseline: **0.2.0-dev.20261022.78**. Latest release: **0.2.0-dev.20261022.81** (2026-11-15; manifest `daec35b6…2fb8c`, source `42200a7`): the readiness changes, on top of dev.80 (doctor permit wait, blocking lane) and dev.79 (#1, #16a/b, #5, #13, supervision/test reliability). The decision-authority slices A–C are included but withheld (schema 2 not released).

Read the [implementation strategy](one-factory-strategy.md) for order, dependencies, boundaries and pending operator decisions. Numbers below preserve the supplied plan's numbering. This is a living record: update the row when design, implementation, verification, release or live qualification changes.

This record was kept by the coordinating agent session that built Factotum; [the change records' README](changes/README.md) explains its working terms ("root", "the main thread", "the readiness-trial thread").

Status meanings: **queued** = accepted work, not implemented; **in progress** = an implementation assignment is active, not yet accepted; **designing** = a design assignment is active; **design pending** = contract/qualification design needed; **decision pending** = an identified operator decision remains; **existing** = baseline capability, not a new delivery; **conditional** = not authorized for unconditional build; **withdrawn** = deliberately not planned. A released change will name its exact release and verification. “Released” alone does not mean an adopter installed it or that live effectiveness was measured.

| Change | Scope and status | Batch / dependency | Shipped release | Verified so far / next proof |
| --- | --- | --- | --- | --- |
| 1 | Quiet terminal notification level — implemented, independently reviewed, merged to main (`6530caf`); not released | A; coordinate actionable reports with 6 | 0.2.0-dev.20261022.79 | `notifications.level: "actionable"` suppresses proven-clean delivery/document and target-sync summaries; canonical records retained. Attention covers nested provider findings, unverified acceptance, questions, departures, pushback, retained worker reports, unresolved review history and recovered CI reruns. Next: release qualification and live delivery. |
| 2 | Actual-diff path policy and all-target qualification — design pending | C, after 7/8; D2 before live qualification/enablement | — | Engine/dispatcher policy sites and default-target-only doctor check inspected. Need rename/base drift, manual fallback, document workflow and stale remote merge exercises. |
| 3 | Handoff starter guidance — queued. Fresh-session supervision — design pending | Templates early; experiment E after 1/16, with fallback | — | Current handoff is successor rebinding, not a fresh-event handler. Need separate design, durable ownership/replay fixtures and all-session usage measurement. |
| 4 | Factory-owned attention step — conditional | G; measure after 1–3 and produce separate design | — | No implementation or experimental benefit established. |
| 5 | Original request provenance — canonical optional `originalRequest` field implemented, independently reviewed, merged to main (`8b566ba`); not released. Starter templates included | B | 0.2.0-dev.20261022.79 | Field `{origin, source, date, text?}` is part of the approved brief (edits need re-approval) and never reads as authority. Carried through import, source sync, snapshots, worker prompts (JSON-quoted, labelled provenance), console and help. Next: release qualification; `requestRefs` migration with #7/#8 slice A/F. |
| 6 | Planner/builder decision reports — design pending; policy settled | B; D4: collected choices reviewed before release, explicit operator decisions settled earlier | — | Existing report/pushback mechanism inspected. Need bounded schema, provenance, deduplication, operator presentation and release-review contract. |
| 7 | Durable task-linked operator-decision hold — design merged (`10b9ad9`); slice A records/migration merged (`5253a7b`); slice B durable decisions with direct operator authority merged (`418de13`); active only on migrated projects; not released | B with 8; prerequisite for 2 activation | — | Slice B: decision open/present/dispose/revoke/ratify, carry-forward and reopening on task edits, holds at admission, protected preparation, dispatch fence and completed terminal, authority-race recording, actionable-notification integration, service/console projections, in-transaction scoped audit. Not yet guarded: merge-question creation and answer acceptance (slice D). Next: slice D (boundary guards, including merge-question creation and answer acceptance), then E. Migration still withheld from adopters; `starter/compatibility.json` stays at schema 1. |
| 8 | Stored scoped approval grants — design merged (`10b9ad9`); record contract and audit with slice A (`5253a7b`); slice C issue/consume/revoke and relayed answers merged (`7548fd2`); active only on migrated projects; not released; policy settled | B; brought forward; D3 requires exact-scope grants for delegated brief approvals and operator decisions | — | Operator-only, never-delegable grant issue/revoke; entries pin current revision, workflow and decision version; max 30 days; versioned, transactional, replay- and race-safe consumption; authority reference in envelope, digest, receipt and console journal; revocation aborts derived flows, expiry refuses the next step; relayed answers store verbatim operator words and need an exact grant or operator confirmation; defined, audited `subjectDigest`; task-scoped audit before commit on approvals, grant issue and revocation. Limits: grants answer or cancel only open single-revision decisions; actor identity is self-declared under the same-account trust model. Open operator question: whether orchestrator answers to informational questions also need verbatim relays (root recommends no). |
| 9 | Existing bounded review setting — existing; project-owned activation | No new core activation here; informs 10 | Available at dev.78 baseline; no new release | Executed phase/disposition probe confirms ordinary full scope for first four rounds and strict clean delta proceeding to gate without mandatory third review. Live savings not established. |
| 10 | Ordinary delta review and finding ledger — design pending | D, after context/record contract; preserve strict behavior | — | Scope-selection code inspected and ordinary-phase probe passed. Need full-to-delta evidence chain, ledger resolutions, risk escalation, base drift and causal regression fixtures. |
| 11 | Portable fast checks — design pending; project pilot unqualified | D | — | Existing command working-directory/observation contracts inspected; related catalog tests pass. No pilot executed. Need current diagnostics, retry bounds, infrastructure holds and no gate-evidence minting. |
| 12 | Builder dependency/database environment — design pending | Design during B–D; implementation/qualification F | — | Provider boundaries and once-only setup reviewed in earlier triage. Need real fictional offline dependency refresh/database tests and lifecycle/cancellation exercises. |
| 13 | Role guidance starter — queued. Context mapping defect — fixed, independently reviewed, merged to main (`b3200a4`); not released | D before selective-context recommendation/10 qualification | 0.2.0-dev.20261022.79 | A plan-scope path-mapped governing file no longer invalidates its own plan. Plan-review preparation checks context against the planning manifest; builds must use the package the passing plan review recorded; every entry's definition is compared; budget failures name the evicted entry and advise `context.maxChars`. Governing-file edits stay rejected. Operator decision 2026-11-14: the planner keeps not seeing files only its own plan selects; revisit with #10. Open: governing-file-edit issue in runtime follow-ups. |
| 14a | Structured offline inputs — existing; improve starter/diagnostics | Templates early; approval evidence with B | Available at dev.78 baseline; no new release | Existing input tests pass in prior triage. Text-only prerequisites remain outside declared input checks. |
| 14b | Approved category, goal and cost report — queued | D after 16 accounting; add canonical goal schema first | — | Category exists; goal is absent from canonical brief fields. No report implemented or cost improvement claimed. |
| 14c | Category admission quota — conditional | G; D5 and starvation/exception design | — | No quota selected or implemented. |
| 15 | Codex credit hold — withdrawn | Operator decision already made | Not applicable | No hold to build; usage observation remains in 16. |
| 16a/b | Codex usage normalization and Stats alignment — implemented, independently reviewed, merged to main (`2fecbb6`); not released | A | 0.2.0-dev.20261022.79 | Versioned observations, Codex cumulative deltas, Claude delta/cumulative cost, replay/reset/overlap/missing handling and Stats coverage; 49 focused tests and 593/593 full suite at `105e55f`. Next: release qualification and live provider observation. Legacy usage and account credit cost stay unknown. |
| 16c | All-session supervision measurement — design pending | Contract A; host qualification E | — | Single-thread totals are insufficient. Need host-neutral session/event attribution, missing-data accounting and escalation-inclusive measurement. |

Wave 2 (2026-11-13): builders run on Claude Opus 5.5 and independent reviews on GPT-6.1 Sol, both at high effort, at the operator's instruction. Merged so far: #1, #16a/b, #5, #13, the #7/#8 design and slice A. Slice B and the load-sensitive qualification fixes merged 2026-11-14. Slice C merged 2026-11-14. All readiness changes (G1–G5, G7, G8) merged and released in dev.81 (2026-11-15; manifest `daec35b6…2fb8c`, source `42200a7`), announced to both adopters. Final readiness step running: an end-to-end trial on a throwaway project in a separate agent thread (Fable 5.2), which also defines a repeatable factory trial approach and verifies the T3 ask-tool assumptions. Factotum is not considered ready until it reports. Host ask-tool bridging is a separate later slice. Next: release qualification of current main (operator order, 2026-11-14).

## Operator decision record

- **Settled:** Factotum is the base; upstream chooses the implementation order; Codex credits are permitted; no Codex credit hold; no migration of another factory is included in this request.
- **D3, settled by the operator 2026-11-13:** “Require scoped grants for approvals and operator decisions (Recommended)”. Delegated brief approvals and substantive answers to operator-owned decisions require stored operator grants covering their exact scope. Other operational delegation remains separate; direct operator approval remains valid. The orchestrator cannot grant itself that authority.
- **D4, settled by the operator 2026-11-13:** “Review the collected choices before release; ask earlier for explicit operator decisions (Recommended)”. Collect other new user-visible product choices for operator review before release. Explicitly operator-owned or conflicting decisions require earlier substantive resolution and cannot merge unresolved. Report delivery, acknowledgment or silence does not constitute the required review.
- **Operator decisions 2026-11-14 (ask tool, first-hand):**
  - *Blocking problems first:* an adopter's orchestrator can mark its own report blocking, and the operator can mark or downgrade any report. A blocking report takes the next free slot ahead of other work; a slice already being built finishes its current step first; triage happens in the same session.
  - *Order:* qualify and release current main and announce it to adopters; then a read-only readiness gap check for the waiting adopter (kept outside this repository); then the three accepted changes (script checks for rule-only review findings, host ask prompt as the front of the inbox, orchestrator handoff prompt); then authority slices D and E.
  - *Readiness bar:* decided by the operator after the gap check.
  - *Models:* product defaults are Opus 5.5 for building, GPT-6.1 Sol for review, and Fable 5.2 for the most important or complex work. Add a per-task model choice that the operator or orchestrator can set: within the project's allowed providers it needs no approval; anything else stays a project setting change. Added to the readiness work.
  - *Relays:* verbatim relay records stay required for decision answers only, not ordinary questions.
  - *Held flows* continue automatically once their decision is settled; no explicit resume.
  - *Launch timings* (15 s stop grace, 10-minute stall notice) stay constants.
  - *Readiness bar for the waiting adopter (after the gap check, 2026-11-14):* must land before the move — (G1) a fast-check step between build and review with script checks for rule-only review findings (#11 redirect); (G2) a host ask prompt as the front of the inbox, with a schema-1 relay record so relayed answers are stored verbatim before schema 2 ships; (G3) the orchestrator handoff prompt; (G4) the blocking-first lane; (G5) main-check tiers (after-merge versus scheduled-only checks, any failure turns the target red and holds admission); (G7) a provider usage-limit hold; (G8) per-task model choice with product defaults. The gap analysis itself is kept outside this repository.
  - *Per-run model overrides (operator, 2026-11-14):* `flow.start` `modelOverrides` follow the same rule as per-task choices: only models already configured for the provider; ship in the readiness release with a release note asking adopters to list any models their orchestrators use in `allowedModels`.
  - *After the dev.81 readiness trial (operator, 2026-11-15):* the next fix release carries R1–R3, F30 and F19 and the corrected T3 guide (the trial's gate), plus: planning convergence (F15) — answering a planner question no longer spends a plan attempt, a "proceed with this plan" choice for ready plans with non-blocking questions, reviewers report every finding in one round and scope to the task, reference plan attempts raised from 2 to 3; an install prefix so managed paths can live under one folder, and Factotum's own test files no longer shipped (F4, F5); ask-prompt attribution (F31) is documented as a limit only. Re-test the fix release on the throwaway trial project first, then stages 3, 5 and 6 on a private local copy of the waiting adopter's repository (local bare remote, no GitHub writes, no changes to the adopter).
  - *Ask prompt route in T3 (operator, 2026-11-15):* the trial showed asks from a delegated child agent never reach the operator in T3 (three prompts unseen), while prompts from top-level threads do. The T3 guide must say ask prompts are off until a route is verified. The re-test will try a separate top-level asking thread launched by the orchestrator, which shows the question, relays the answer and is interrupted or closed when the question expires or is answered in the inbox; the guide adopts it only if the operator sees the prompts and withdrawal works.
  - *Same-family review (operator, 2026-11-14):* the rule requiring the reviewer to come from a different model family than the builder is retracted; same-family review is allowed.
  - *Blocking-first response target:* same session — triage starts in the Factotum thread's next turn with a reply to the adopter; a fix or workaround follows as soon as a slot frees.
  - *Final readiness step (operator, 2026-11-14):* once everything else is done, a new agent thread tests Factotum end to end on a new throwaway project, including working out the right approach to testing the factory that way. Factotum is not considered ready before this.
- **D2, deferred until installation qualification:** branch protection for all targets and document-workflow handling. No remote changes authorized by this strategy.
- **D5, deferred:** any category quota and its metric. Reporting can proceed without it.
- **D6, deferred:** delivery unit and any retirement/absorption of an existing outcome-level route after its audit.

## Design inputs from field evidence

Received 2026-11-14 from an external audit of adopting projects, at the operator's request. These are inputs for pending designs, not decisions and not reasons to reopen merged work. Finding classes were assigned by helper agents from finding text and were not checked against code.

- **#10 delta review and finding ledger — strengthened.** With equal send-back rates, the factory whose repeat review read only the changed delta spent a markedly smaller share of tokens on repeat attempts than one that re-reviewed in full.
- **#11 fast checks — redirect.** Fast checks caught few builds. The larger opportunity is moving script-checkable rules out of review: a substantial share of send-backs carried no real defect and rested on a single procedural rule. A fast check should own such rules, and reviewer guidance should say not to raise them.
- **#7/#8 — two additions for open slices.** (a) *Relayed answers:* an answer an orchestrator enters on the operator's behalf must be stored as relayed, quoting the operator's words verbatim with nothing added, and must not release an operator-owned hold. (b) *Host ask prompts:* operators want to be asked through the host's interactive ask tool. The design should let one question be presented through a host ask prompt and the inbox together, let an answer by either route settle both, and let an unanswered ask be withdrawn without losing the inbox row; an open ask must never block unrelated delivery. Unless the host can attest that an ask answer came from the operator, it is a relayed answer under (a). Belongs behind the host-integration boundary, with a host-neutral core contract.
- **Plan-section 4 orchestrator read after each merge (deferred):** evidence shows high notification token cost and near-universal pass on the pre-merge read; neither supports carrying the step across unchanged.
- **Plan step:** an alternating-assignment comparison (groups alternated in queue order, not randomized) found a modest one-pass improvement from plans on ordinary changes at roughly double the cost per change; the difference was within chance. The adopting project's operator reviewed this and chose to keep a plan for every ordinary change; reading it as "plans only for strict or wide changes" was the auditor's interpretation, not a decision. (Corrected 2026-11-14.)
- **Builder/reviewer model pairing (new):** an alternating-assignment comparison (not randomized) favoured one cross-family pairing on one-pass merges; that project's own check attributed about a third of the gap to the other model reviewing more leniently, and its operator kept the opposite pairing for that project. Relevant to project model defaults; no core change implied. (Corrected 2026-11-14.)
- **D6 delivery unit:** the separable part worth keeping is outcome verification on the hosted product by an agent that did not build it, from the other model family, briefed by the orchestrator rather than the builder. D6 remains the operator's.

## Relayed requests (confirmed 2026-11-14 where noted in the decision record)

Relayed 2026-11-14 by the external auditor from the operator's ask-tool answers in another thread. Recorded as relayed; not acted on until the operator confirms first-hand here.

- **Blocking adopter problems first.** An adopting project can mark a factory problem as blocking its work, and Factotum takes it ahead of its other work; everything else is sorted as now. Open: who may mark blocking, what happens to a slice already being built, and the target response time.
- **A prospective adopter waits for Factotum.** Its own factory is paused and will restart only on Factotum. Open: what "ready" means and when.
- **Three accepted changes move here:** (1) script-checkable review rules are checked by a script before review (the #11 redirect); (2) a host ask prompt is the front of the inbox — one question is presented through both, an unanswered ask is withdrawn after a set time and stays in the inbox, and an answer by either route settles both, with orchestrator-relayed answers stored as relayed; (3) the runner counts deliveries to the current orchestrator session, reports the count in each delivery, and raises a handoff question at a limit (relates to #3).

## Verification log

**2026-11-13 — orchestration started**

- The operator approved the orchestration strategy and instructed execution. Root owns integration, progress, reviews and immutable releases; at most three parallel child assignments accompany it.
- Created the first local Git baseline, `2f9f70290c886f0dbd81ac849899d5d94f5bb408`, from the existing dev.78 reference and approved strategy. No remote was configured or pushed. Existing whitespace in evaluation patch fixtures was retained as baseline content rather than reformatted.
- Wave 1 assignments: `one-factory-16-accounting-v1` (implementation), `one-factory-01-quiet-v1` (implementation), and `one-factory-07-08-authority-design-v1` (design only). Each uses a separately prepared checkout; children return committed changes and validation, without publishing releases or changing adopters. Independent review follows implementation rather than being performed by the author.
- Fresh full baseline suite: **573/574 passed**, one failure in `tests/main-health-audit.test.mjs` (`timed out main verifier preserves actual partial stdout and stderr`), where the 150 ms child timeout produced no stdout under concurrent suite load. All **13 tests in that file passed** in an isolated rerun. Startup/load sensitivity is a hypothesis, not a waiver: root owns this open qualification issue and must resolve it before marking a release qualified. Logs are retained locally; no production timeout or test was changed. A second load-sensitive test surfaced during #16 work, and a fourth (`tests/runtime.test.mjs` revocation) during #5 work: `tests/timer-wait.test.mjs` 500 ms stop/resume fixture failed once under full-suite load and passed 4/4 in isolation; also root-owned and open. Assignment status is not a claim that any new runtime behavior is implemented or released.

**2026-11-13 — operator policy decisions recorded**

- Recorded the operator's D3/D4 selections and removed their decision blockers from changes 6 and 8. Their design, implementation and qualification remain outstanding.
- Updated the strategy to distinguish delegated grants from direct operator approval, and report delivery from pre-release review. No runtime, adopter policy or release changed.

**2026-11-13 — strategy pass, no runtime changes**

- Read the full revised source plan, its review findings and supporting baseline/findings; did not use the superseded draft as the implementation plan.
- **39 existing tests passed**, zero failed/skipped: `tests/operations-review.test.mjs`, `tests/workflow-catalog.test.mjs`, `tests/providers.test.mjs`, `tests/stats-view.test.mjs`.
- Executed direct phase/disposition probes: default ordinary phases are ordinary for four rounds, then final; passing strict delta routes to gate in the reference graph. These establish mechanics, not review quality or live savings.
- Executed a disposable Git/context probe against `actionSpecification`: a plan adding a path that selects an additional context file causes the subsequent build's context validity rejection. No provider was launched.
- Earlier same-day triage separately ran 31 focused input/notification/freshness/sync tests and reproduced same-head sync failure not being requeued with injected transport. Those are baseline facts, not implementations of this programme.
- Not exercised: live providers, host session launching, builder databases/package installs, remote branch protection/merges, adopter activation, attention handling or intent improvement.

## Release and review log

Programme release 0.2.0-dev.20261022.79 shipped 2026-11-14; see [release notes](release-notes.md) and [qualification](qualification.md).

**2026-11-13 — #16a/b reviewed and merged to main, not released**

- Implementation `01e24e8`; independent review (GPT-6.1 Sol, high effort): approve with fixes, three blocking findings — Claude cumulative cost differenced against an invocation delta or a zeroed error total; a failed partial-trace write replacing a started provider failure; unknown-only Stats periods and roles shown as $0.
- Root fixes `105e55f`, each with a regression test that fails on `01e24e8`. Independent re-check (GPT-6.1 Sol): all three resolved, no new findings.
- Verification at `105e55f`: focused provider, Stats, accounting, plan-review-protocol and provider-route tests 49/49; `npm test` 593/593; `git diff --check` clean. Not verified: browser rendering, live provider usage.
- Merged to main as `2fecbb6`. Remaining before release: release qualification, including the two load-sensitive tests below.

**2026-11-14/15 — readiness work for the waiting adopter (G1–G5, G8) merged to main, not released**

Every change below was built in its own worktree, independently reviewed by GPT-6.1 Sol and re-checked until approved. Records: `docs/changes/readiness-g*.md`.

- **G4 blocking lane** (`e4b7b31`): feedback template, starter README, use-factotum skill and adoption guide define Blocking reports (orchestrator or operator marks; operator downgrades; same-session triage; next free slot). Process only.
- **G1 fast checks** (merge `8a5aa77`; Opus 5.5 build): project-configured fast checks run on the integrated candidate before review; failures return to the builder; listed rules are skipped by reviewers only for the exact passing candidate. Review rejected once; fixes made gate and fast checks run trusted argv directly with their bounds and environment, keep non-credential Git safeguards, never receive factory Git credentials (**adopter-facing**: git-launched checks no longer get the GitHub token), and treat output overflow as infrastructure.
- **G8 models** (merge `e8a7c72`; Opus build): same-family review allowed and recorded; starter defaults Opus 5.5 builds, GPT-6.1 Sol reviews, Fable 5.2 allowed; `task.models` per-role choices outside the approved brief; task choices and run overrides must name models configured for the effective provider (**adopter-facing** for run overrides). Three re-check rounds.
- **G2 ask prompt as the front of the inbox** (merge `7479692`; Fable 5.2 build): host-neutral `inbox.present` with expiry; either route settles both; expiry wakes the presenter once; relayed answers store relayer, channel and verbatim words on schema 1 and 2; T3 guidance (the T3 ask tool has no timeout/withdraw and no answer attestation, so the orchestrator asks from a cancellable delegated child; assumptions to qualify in the end-to-end test). Review found two delivery defects, fixed.
- **G3 orchestrator handoff prompt** (merge `959cc73`; Opus build): per-session delivery counting with atomic numbering, a handoff question at the limit (default 100, repeat 25, operator-only settings), reset history and an operator-only-acknowledged notice for unusual resets. Review rounds also closed a released hole: a delegated orchestrator could widen `policy.delegatedOperations` through `config.update` with `replaceLive` (present in dev.79/dev.80); operator-only live settings are now enforced on every configuration path.
- **G5 main-check tiers** (merge `3d7b509`; Opus build): merge-tier versus scheduled-only main checks; a scheduled red holds admission until an entirely green full verification or an operator exception; red targets probed for external fixes; untiered health shape unchanged.
- **Also:** a date-dependent Stats test pinned to midday UTC (`d65bec3`). Main after these merges: 796/796, `npm run eval` exit 0.
- **G7 provider usage-limit hold** (merge `165fd63`; Opus build): limit signals, threshold notice, exhaustion hold to reset (8-day cap), classified limit attempts, operator `provider.hold`. Review rejected once; fixes `c843d33`; re-check approved. Main after all readiness merges: 810/810.

**2026-11-15 — dev.82 trial fixes merged to main, not released**

Findings from the dev.81 readiness trial (records in `docs/changes/`):

- **R1** (`80587d5`): engine question lookup ignores standalone questions; command help for orchestrator-allowed commands.
- **Second adopter's fixes** (`73b5d41`): follow-ups keep the parent's selection labels and workflow; the stale-source message names the issue and the recovery.
- **R2** (merge `f2cb6d2`): ref-lock fetch retry; failed cleanups retried through the cleanup plan; ignored work archived, and normal cleanup lists the ignored files it deletes.
- **Ops/config F30, F19, F23, F17, F1, F22, F35** (merge `b391c68`; Opus build): review (GPT-6.1 Sol) approved with fixes. Root fixed both findings in `116bd39`: a real `SQLITE_FULL` was masked by a failed rollback and bypassed the recovery hold, and a malformed notification signing key escaped health. Both regressions fail on `165752e`. Branch `npm test` 842/842.
- **T3 guide and docs corrections** (merge `ceabca1`; Opus build): setup steps, compact-state jq filter, ask prompts off by default until a route is verified (the separate top-level asking thread is described only as under test), and the documentation findings from the trial. Review (GPT-6.1 Sol) approved with fixes, two blocking: delivery was enabled before its handling files existed, and the jq filter hid holds, faults, open questions and flow evidence. Fixed in `b9ac1ca`, which also merges main; the re-check approved and its one wording item was fixed by root in `a3923ef`. Main after merge: 845/845, `npm run eval` exit 0.
- **R3 parked-question busy loop** (merge `742a0c8`; Fable 5.2 build): a parked waiting question is no longer re-fingerprinted every tick; it wakes on store changes, Git metadata (throttled to ten times the last fingerprint), expiry, a refused answer or a 60 s revalidation. On 20,000 files with five questions, service CPU fell from 107% to 2.5–4.5% and the worst handshake from 1.8 s to 7 ms. Review (GPT-6.1 Sol) rejected `5184dad`: dispatch and completion trusted a fingerprint taken before waiting for the write lock. Fixed in `5be2074` with two lock-wait race regressions; re-check approved and audited every consequential path; its wording item fixed by root in `7932748`. Main after merge: 865/865, `npm run eval` exit 0.
- **Planning convergence F15 and F12** (merge `6789b04`; Opus build): answering a plan question no longer uses a plan attempt (three free clarifications per plan cycle, then they count, then `replan` answers are refused until `flow.replan`); a "proceed with this plan" answer for ready plans held only by the planner's own questions (goes to plan review, same answer checks, refused on any subject change); reviewers report every blocking finding in one round, scoped to the task; reference plan attempts 2 → 3; plan-question items carry the planner's questions, options and risk. Review (GPT-6.1 Sol) rejected `64224a7`: clarification answers with a note extended the transition allowance without limit (also true on the released base), and long planner text truncated away the risk line and answering guidance; plus C1 controls kept. Fixed in `ba27d4a` (shared sanitiser now also used for check excerpts and GitHub errors); re-check approved. **Adopter-facing:** reference-graph projects must re-approve queued tasks after recommissioning (graph digest changes). Main after merge: 880/880, `npm run eval` exit 0.
- **Trial code items F7, F8, F10, F11, F20, F21, F24, F33, F36** (merge `7cadaf0`; Opus build): exact prompt kept as `prompt.txt` with every known secret redacted; brief `outcome` imported; merge subjects `<task title> (#<PR>)`; readable plan comment; doctor passes a checkout that is only behind, but refuses when the missing commits change factory files, the lock, or files the configuration runs as commands; answer note on the answered item; `status --inbox/--flow/--task/--compact` narrow reads; `delivery.ack` never brings a reminder earlier, labelled flow-question choices; declared paths passed to checks and reviewers. Three review rounds (GPT-6.1 Sol): known secrets in governing context reached `prompt.txt`, compact status loaded every attempt, short secrets skipped, doctor missed paths with spaces or `..`; then quoted shell paths and inline-code over-inclusion, fixed by root in `b058126` (not re-reviewed; tests fail before and pass after). Also fixed the flaky `main-check-tiers` health-writer test (it reconciled before the supervisor exited; 18/36 failures under load before, 0/36 after). Limits: secrets in governing context still reach the model; doctor does not see files a command uses without naming them. **Adopter-facing:** merge titles change; doctor no longer needs a pull after every merge. Main after merge: 898/898, `npm run eval` exit 0.
- **Decision (operator, 2026-11-15): split attempt-intent layout keeps schema version 1.** Older runtimes are fenced by SQLite write triggers (they can open and read, every write fails), and Factotum's downgrade paths convert the state back first. No schema number is spent, so nothing collides with the withheld schema 2.
- **Trial report R4, console Stats sections** (merge, root fix `60e783b`; not independently reviewed, small): the console backend dropped `accounting` and `providerLimits` from stats, and the dashboard snapshot lacked `orchestratorSession`, so three documented Stats sections never appeared in a real browser. A test now ties the console's forwarded fields to every stats key. **Adopter-facing:** update the shared console's pinned copy as well as each project's service. Main: 901/901.
- **Idle-history scan fix** (merge `8d3866c`; Fable 5.2 build): attempt `intent` bodies move to separate records behind a SQLite write fence; hot paths use targeted reads and indexes only for record kinds verified free of duplicate JSON keys (`meta.recordsVerified`, cleared whenever the fence changes); first service start migrates (about 1 s per 100 MB), `layout inline` reverses it byte for byte, and Factotum's downgrade paths inline first. Measured on main after merge (synthetic 3,000 attempts of 80 KB): idle service 0.6% CPU, no database reads; console poll 6 ms (was 879 ms before the fix). Five review rounds (GPT-6.1 Sol): byte changes and no fence for older runtimes, then reader disagreement on duplicate keys, then a stats index using first-member semantics, then a crash point that trusted retained indexes; the final re-check approved with crash tests at every one of 22 migration transactions and a differential against 93395cf. Merge conflicts in queue status and the dashboard snapshot took the branch's verified reads; two reads added on main (launch-stalled attempts, open inbox items in the narrow status read) were moved to the verified live sets by root. **Adopter-facing:** first-start migration, `layout` commands, schema stays 1 (operator decision). Main after merge: 923/923, `npm run eval` exit 0.
- **Install prefix and builder protection, F4 and F5** (merge `b016f65`; Opus build): `adopt install --prefix`, no shipped test files, and, grown out of review, protection of `factotum.lock.json` and the managed core against builder changes: hash-verified Git reads (replace refs, grafts, commit-graph, shallow files and overwritten objects cannot change what checks see), a complete verified ancestry walk, owned-file checks at commit, integrate and publish against the recorded target, `forge.publish` requiring a recorded integration, a doctor drift check, and `upgrade apply` verifying the checkout after its merge. Six review rounds (GPT-6.1 Sol, then Fable 5.2 after Sol's run was stopped by its provider's safety filter), each finding a new route around the protection; round 6 approved with three non-blocking items now in a follow-up (stale integration at publish in custom graphs plus a commissioning rule, an unmerged upgrade branch neutralised by a builder, and a slow walk shape). Merge needed one test expectation updated (`verify` step). Main after merge: 957/957.
- **Test suite temp directory** (`368a773`, root): `npm test` runs with its own short TMPDIR per run and removes it; tests had left about 3,000 directories in the shared `/tmp`.
- **External pull request adoption, trial report R5 and F43** (merge `8286229`; Opus build): closing keywords in outside commits refused at `candidate` before any model call; commits pushed to the original PR after adoption listed in the merge question and completion notice; a comment on the original PR, the replacement naming its author without a ping, and the `original-pr` obligation resolving itself; adopted merge questions operator-only on every path; admission refused, and source flows waiting, while another merge into the same target is in flight. Three review rounds (GPT-6.1 Sol): a source flow could wait forever on a stopped verifier; then cached merge state survived a same-connection rollback, fixed by adding a rollback count to `Store.changeToken()` (also corrected a wrong skip in inbox delivery queueing); final re-check approved with every rollback path audited and idle at 0.56% CPU. **Adopter-facing:** a direct `flow.start` is refused during a merge into the same target; the orchestrator cannot answer any part of an adopted PR's merge question; new setting `repository.adoptionNotice` (default on). Main after merge: 982/982, `npm run eval` exit 0.
- **Console fixes from the real-browser pass, trial report R6** (merge `91e4f28`; Opus build): failed fast checks recorded as `outcome: failed` and shown as failures everywhere (status stays `passed` for drains and cleanup); answered items no longer badged Expired; decisions show who answered, on whose behalf, the note and the strict sign-off; the merge card shows the pull request, candidate commit, review verdict, checks, a diff link and R5's adoption context; stop reasons only while stopped; Overview shows the commissioning hold; about 25 smaller items fixed or declined in the record; a reusable real-browser qualification checklist (`docs/qualification/console-browser.md`). Two review rounds (GPT-6.1 Sol): History still showed failed checks as passed, and merge-card links were not validated (now built from the configured repository; record URLs linked only on that forge); final re-check approved, with one non-blocking link fix by root (`9c22021`). Not driven in a real browser yet; that is part of the re-test. **Adopter-facing:** `http:` inbox links show as text. Main after merge: 1,014/1,014, `npm run eval` exit 0.
- **Protection follow-ups F1–F3** (merge `760af9a`; Opus build): `forge.publish` requires the last clean integration's head and commissioning refuses a graph that can reach publish other than from `workspace.integrate`'s `integrated` result through input-preserving steps; a candidate's own commits may not change managed files even if later reverted (an unmerged upgrade can no longer be neutralised); the verified history walk stays near 70 Git processes on every honest shape and the reviewed hostile ones. Four review rounds (Fable 5.2): a planted shallow file made the walk cost three processes per commit; then an honest flow more than 64 commits behind cost one process per commit moved (fixed: 10,005 → 73 processes at 10,000 behind); final re-check approved, with 7,296 checks matching a brute-force verified walk. Root fixed N13 (`a0b2c3b`): the shallow file is read only as a bounded regular file. Accepted follow-ups: an unreadable object under a merged side chain costs one process per generation for that hostile flow (N10); `ownChanges` can fail closed before its trusted filter (N11); older-Git parser strictness (N12). **Adopter-facing:** project graphs must integrate before publish; committed-then-reverted builder core edits refused. Main after merge: 1,025/1,025, `npm run eval` exit 0.
- **Released 0.2.0-dev.20261022.82** (2026-11-15): manifest `dd42aa20837ee19ad80a618d17a216de18fc8bb665fd6d9ed6b2caea53147f4b`, clean commit `bcc1c3c`, tag `v0.2.0-dev.20261022.82`; 1,025/1,025 and `npm run eval` exit 0; no test files in the payload; adopted from the built release at the root and under a prefix with clean status. Announced to both adopters. The readiness-trial thread was asked to re-test it: the trial project first (upgrade path, twelve stages, real-browser console, external pull requests, the separate top-level asking thread for T3 ask prompts), then stages 3, 5 and 6 on a private local copy of the waiting adopter's repository (local bare remote, no GitHub writes, the original untouched).
- **After dev.82, merged to main, not released.** (1) Hook-like grant functions renamed (`consumeGrant`, `grantUseLapse`) after an adopter's React lint failed on the installed core; a test keeps `use<Capital>` calls out of the core (root, `2efe6dd`). (2) **Triage proxy thread guidance** (operator request; Opus build): a recommended T3 setup in which factory webhooks and timer checks go to a small proxy thread with fresh context per notice, a deterministic rules script (`starter/project/integrations/triage.example.mjs`) that absorbs only what is provably routine and forwards stand-alone messages for everything else, a log, digest and counts; the orchestrator keeps the session binding. Built from the operator's measurements (about half of orchestrator turns were callback or timer wakes) and an adopter's watcher experience. Three review rounds (GPT-6.1 Sol): forwarding treated as handling, unsent timer findings consumed, missed holds, malformed input absorbed, unsafe shared state; then stale-lock takeover with a live owner, hidden main holds, and findings lost when cleared before delivery; root fixed the last two findings (per-wake scratch files, inbox fields refused on state payloads) in `8088905`, not re-reviewed; merged as `17bab64`. Runtime follow-ups listed in `docs/changes/proxy-thread-guidance.md`. Main after both: 1,048/1,048, `npm run eval` exit 0.
- **Decisions (operator, 2026-11-15, from the dev.82 re-test):** (1) A ready plan whose only questions are ones the planner marks non-blocking proceeds to plan review without stopping; the questions and the planner's assumed answers are carried to the merge card. Blocking questions and plans that are not ready still stop. (2) A flow parked on an operator or orchestrator answer (plan question, merge decision, strict sign-off, conflict question) no longer counts toward `maxFlows`, up to `policy.maxParkedFlows` (default 3); an answered flow resumes ahead of new tasks when a slot is free; stopped flows keep holding their slot.
- **Readiness re-test of dev.82 finished (2026-11-15):** verdict "ready for the waiting adopter to start under supervision; not ready for unattended running". Every dev.81 must-fix is fixed and re-verified (R1–R4, F30, F43, F19, the external-PR defects). On a private copy of the adopter's repository, installed under a prefix, overhead was 0.5–0.9% of a core with 5–9 ms responses, and restart, SIGKILL, stop/resume and backup/restore passed. 12 factory merges, no lost work. Frequent person-needed items: G10 (source stop after an outside push), G4 and G2 (planner and builder questions), G9 (target moved during a merge question), G5 (second slot unusable while one flow waits); all four are being fixed for dev.83, with the R10 console items. The ask route works on the factory and host side (relay, withdrawal on inbox answer and on expiry) but is not adopted until the operator states in their own words what they saw. Not exercised: models and GitHub at the adopter's scale. Cost: 59 model invocations, $14.63 at list price. **Decision (operator):** the waiting adopter starts after dev.83 is released and re-tested on the trial project, not on dev.82. The operator will state in the trial thread what they saw of the ask prompts.
- **dev.83 planning and builder questions, G2, G3, G4, G16** (merge `d4c546a`; Opus build): planner and builder results separate blocking `questions` from `assumptions`; a ready plan or an implemented build with only assumptions proceeds, carrying them to reviewers (told to flag wrong ones), the builder, the merge card and the completion notice; full builder question cards; the planner revises its previous plan after a clarification (numbered questions and answers reserved inside a hard 16,000-character cap); `status --task` adds acceptance, models and schedule time. Reference graph digests unchanged (independently computed), so no re-approval. Three review rounds (GPT-6.1 Sol): stale corrected assumptions, questions cut from the previous plan, silent loss past 20, then case-insensitive merging of different questions and JSON escaping past the cap; the round-2 fixes were verified by root with direct probes and the branch tests, not by a third review. Main after merge: 1,065/1,065, `npm run eval` exit 0.
- **dev.83 console fixes, R10 (G15, G23, G25)** (merge `497db2f`; Opus build): "Approve again" where re-approval is needed; doctor and `job.enqueue` receipts follow the real run (new primary-key `GET /v1/jobs/:id`, payload and grant never exposed); held queues stop promising automatic admission; structured hold fields with local times; Stats and Timeline fit phones, with grouped markers opening an accessible event list; a 12 px text floor in both densities, enforced by a stylesheet test; evidence files listed per attempt; per-severity finding counts; an adopted PR refused for touching managed files gets a notice naming files and rule and one neutral comment on the original PR; the superseded-PR to-do is created only when a replacement is published. Review (GPT-6.1 Sol): approve with fixes, one blocking (long file lists cut the guidance from the G25 notice); fixes verified by the branch tests, not re-reviewed. CSS changes still need the real-browser checklist. Main after merge: 1,082/1,082, `npm run eval` exit 0.
- **dev.83 PR notices and adoption fixes, G1, G6–G8, G17–G21** (merge `89c59ba`; Opus build): candidate mismatches stop with a notice naming each mismatch; `candidate.base` verified as an ancestor of the fetched target with verified Git reads (replace refs and grafts refused); closing-keyword notices name the actual reference; the workflow template passes `init` at the root and under a prefix; adoption guidance to exclude the install prefix from project tooling; failed trusted commands record bounded, known-secret-redacted output; reconcile refusals name the attempt and the exact command; clean CLI usage errors; the older-CLI fence message documented (SQLite resolves the function before the trigger's own message). Adoption refs now use per-attempt names, recorded before fetching, and a bounded, time-limited sweep deletes only names of ended flows. One notice path (`attemptNotice`) for action-supplied and command-failure notices. Five review rounds (GPT-6.1 Sol): secrets in diagnostics, forgeable ancestry; then a hanging and unbounded ref sweep; then cleanup racing replan; then an expired claim not fencing an in-flight delete, fixed structurally by per-attempt names. Final re-check approved. **Adopter-facing:** projects with an already-copied broken workflow template rename its evidence entries by hand; refs left by earlier releases are removed by hand (commands in the record). Main after merge: 1,120/1,120, `npm run eval` exit 0.
- **dev.83 parked flows and admission, G5, G9, G10** (merge `476a44a`; Fable 5.2 build): parked flows (waiting only on an answer) free their `maxFlows` and category places up to `policy.maxParkedFlows` (default 3, live); answered flows resume in order (merges first) and wait visibly for a slot; a flow waiting only on its category reserves no pool slot; replan, including reviving an abandoned flow, takes a slot in order; path overlap uses the candidate's diff against the integrated target; source waits through progressing verification; a moved merge target is shown, versions the question, re-integrates only when new commits touch the candidate's paths, and GitHub's out-of-date refusal routes to `stale`; bounded probe and remote reads with exact-ref parsing. Three review rounds (Fable 5.2): over-admission through `flow.replan` (found by a randomized probe), then four small regressions (a detached Git escaping the attempt's group kill, a probe memo, replan queue order, docs). The final 700-seed probe found no over-admission, stuck waiter or deadlock. Limits recorded: a category shared across pools can pass over its waiter; GitHub's refusal wording unverified live. Main after merge: 1,189/1,189, `npm run eval` exit 0.
- **Released 0.2.0-dev.20261022.83** (2026-11-15): manifest `d6fa0aeced6aeb19d63863fa18921f4f8ae2c6bc35861b6e237cfe6c2be80e1e`, clean commit `8b71bea`, tag `v0.2.0-dev.20261022.83`; 1,189/1,189 and `npm run eval` exit 0; no test files in the payload; adopted from the built release at the root and under a prefix with clean status. Announced to both adopters and sent to the readiness-trial thread for re-test; the waiting adopter starts after that re-test.
- **Readiness re-test of dev.83 finished (2026-11-15):** verdict "the waiting adopter can start on dev.83 as a supervised adoption". The four person-needed items from dev.82 are fixed and seen live; with one slot the queue kept moving while questions waited; no over-admission, no lost work, main stayed green; install, recovery and load were fine at the adopter's repository size without models. Terms: exclude the install from the adopter's tree-wide tooling; fast-check timeouts from real durations; `maxFlows: 1`, default `maxParkedFlows`, operator merge decisions; tasks small enough for one build session (H9); `git pull` before config update or doctor (H13); direct webhook or triage proxy; ask prompt off. Findings H1–H13 are being fixed for dev.84. Whole-trial cost: 163 model invocations, $30.44 at list price. **Decision (operator):** wait for dev.84 before starting the adopter; the adopter's orchestrator thread will do the adoption.
- **dev.84 console items, H3–H7** (Opus build): flow detail shows the flow's slot state, derived with Queue from one function (`waitsOnCategoryOnly`, reservations included); Escape closes grouped Timeline marker lists and returns focus; flow ids in hold text are titled links; one Back closes the flow window from any attempt; the browser checklist matches the current UI. Review (GPT-6.1 Sol): approve with fixes, one blocking (detail and Queue disagreed on category-only waits when another waiter reserved the last slot); fixed with the repro as a test, not re-reviewed.
- **dev.84 triage proxy gaps, H11 and H2** (Opus build): all 38 points from the live trial's orchestrator report addressed or deferred: forwards carry the task title, carried questions and failed attempts within per-section budgets under a hard 8,000-character cap; a provenance line with `--verify` (honestly described: T3 does not authenticate senders); `--set-proxy-id`, `--forwards --since`, `--missed`, `--correct`, `--help`; a first-run setup procedure; handoff keeps the webhook on the proxy (core handoff question reworded, text only); tooling-exclusion advice for scripts that walk the tree. Review (GPT-6.1 Sol): approve with fixes, two blocking (`--since` compared strings, the cap ignored the provenance line); fixed with tests, not re-reviewed. Runtime follow-ups: attempt notice and unsettled deliveries in the narrow read, delivery rows following their item, one end notice per flow.
- **dev.84 build recovery and merge fixes, H1, H8, H9, H10, H12, H13** (merge `9811e38`; Opus build): the 17-turn limit was Factotum's own default (`--max-turns 16`); builds now default to 60, configurable per role and step; a session-bound `error_max_turns` is a known result: builders get the build question and retry with the reviewed plan, planners and reviewers stop at their step; warnings before settling an uncertain step; merges into one target serialised (`mergeWait`); doctor refuses only for files run from the operator checkout. Review (GPT-6.1 Sol): approve with fixes, two blocking (a turn-limit result naming another or no session was trusted and saved for resume; export dropped per-step `maxTurns`); fixed with tests, not re-reviewed. The merge conflicted on the triage example's `--help`; main's usage text was kept and the test aligned. Main after merge: 1,229/1,229, `npm run eval` exit 0.
- **Released 0.2.0-dev.20261022.84** (2026-11-15): manifest `42a2ac5c743d8bc8eb9c6a5389bf697e8d5a46b2bed6a81b5cbad5da79bac24a`, clean commit `ebc26e7`, tag `v0.2.0-dev.20261022.84`; 1,229/1,229 and `npm run eval` exit 0; adopted from the built release at the root and under a prefix with clean status. Announced to both adopters and sent to the readiness-trial thread for re-test; the waiting adopter starts on it after that re-test and the operator's go.
- **dev.85 upgrade doctor timeout** (adopter report; Opus build): `upgrade apply` ran doctor with a fixed 600 s while doctor may wait up to 65 minutes for the heavy permit, and the shared runner labelled every timeout "Provider timeout". Doctor's step limit is now derived from its own bounds (permit wait, probes with one retry, main checks, workspace setup, margin; at most 4 hours); failures name the command, phase and limit with redacted output; doctor prints progress lines; provider probe failures name role, provider, model, call and kind, and are retried once on timeout or transient errors; `workspace.setupTimeoutMs` (default 30 minutes) bounds setup commands. Review (GPT-6.1 Sol): approve with fixes, two blocking (auth-call output kept on transport failure; redaction not applied to whole diagnostic strings); fixed with tests, not re-reviewed. **Decision (operator):** the project runner stays stopped until the upgrade's doctor passes; only a checkout-run console returns early. **Adopter-facing:** setup commands longer than 30 minutes need `workspace.setupTimeoutMs`.
- **dev.85 `main.verify` timeout and settlement** (adopter report; Opus build): the post-merge and refresh `main.verify` step limit is derived from its checks (sum of the tier's check limits plus setup and margin, capped at one hour; `timeouts["main.verify"]` overrides); other maintenance steps take their own bounds; commissioning refuses main checks over 57 minutes with a message naming the fixes that work; a check stopped at its own limit settles as failed (`timedOut`) instead of an uncertain attempt; one automatic timeout retry per target head; a new check runner empties the check's process group before settling and re-checks group membership before every signal (escapes reported, counted as unknown health); an outside head change renews the retry through the bounded probe. The gate keeps its fixed timeout (a node change alters the graph digest); recorded as a follow-up. Three review rounds (GPT-6.1 Sol): cleanup left processes, signals could reach a process that left the group, the retry could loop after health expired, sub-second checks were skipped; then an exhausted target never noticed an outside fix. Not re-reviewed after round 2.
- **dev.85 re-test items I1–I5** (merge `e1637df`; Opus build): turn-limited builds shown as such (`outcome: 'turn-limit'`); a successor takeover section and per-forward send IDs with their own destinations in the triage proxy; `status --compact` single-line and trimmed (220 KB → 136 KB on the trial's recorded output); starter guides without links that break after adoption, guarded by a test; idle pools on the Flow slots card; UTC tooltips in admission holds; stale-answer refusals that say why. Review (GPT-6.1 Sol): approve with fixes, one blocking (overlapping forwards recorded the wrong destination); fixed with tests, not re-reviewed. The merge conflicted in `attempt-outcome.mjs`; both the turn-limit outcome and main-verification check rows were kept. Main after merge: 1,282/1,282, `npm run eval` exit 0.
- **Released 0.2.0-dev.20261022.85** (2026-11-15): manifest `1959338f7653f4965a52dcb70d77f86a5cdaab684205ba35db043735d87bc9f2`, clean commit `3561abf`, tag `v0.2.0-dev.20261022.85`; 1,282/1,282 and `npm run eval` exit 0; adopted from the built release at the root and under a prefix with clean status. Announced to both adopters and sent to the readiness-trial thread for re-test; the waiting adopter starts on it after that re-test and the operator's go.
- **Readiness re-test of dev.84 finished (2026-11-15):** verdict "the waiting adopter can start on dev.84 once the operator gives the go". Verified live: H9 (a build at 3 turns got the turn-limit question; "Retry the build" resumed the same session with the reviewed plan and merged), H8 (simultaneous merges serialised, no GitHub refusal), H13 (doctor passed three commits behind), H10, H12, the console items in a real browser including all slot states, H2 on the adopter's copy, and the triage proxy's first-run setup and successor handoff; adopter-copy stages 3, 5 and 6 pass. Remaining for dev.85: I2 (a turn-limited build attempt drawn as passed), I5 (proxy guide and `--forwards` details, a 207 KB compact status), I1, I3, I4. Terms: prefix outside the repository's own tree-walking folders; per-check timeouts; `maxFlows: 1` with operator merge decisions; watch build turns and cost; proxy or direct webhook; ask prompt off. Whole-trial cost: 187 model invocations, $33.66 at list price.
- **Decisions (operator, 2026-11-15):** (1) The waiting adopter starts after dev.85, not on dev.84. (2) New base-workflow step, "knowledge upkeep", to ship after dev.85: a post-merge follow-up that runs only when something relevant to the merged work needs updating. It edits existing project docs directly (as its own small follow-up change), proposes governing-context changes for operator approval rather than editing them, and also applies the compound-engineering capture rule, proposing a check, rule or short learning after send-backs or fixed findings. Guardrails against unnecessary docs: existing files only, "nothing needed" as the normal result, each edit quoting the statement the merged change made false, a small diff budget, review, and measured rates. Design first; research input in the compound-engineering review. Design written (Fable 5.2; branch `t3/design-knowledge-upkeep-step`, `c50b337`, docs/designs/knowledge-upkeep.md): a `knowledge.upkeep` maintenance job queued after proven merges (reference graphs unchanged), a deterministic pre-filter, one small read-only model call and a verbatim-quote validator; docs edits become one budgeted follow-up task through the normal workflow; context changes are operator-accepted batches; lessons at most one per flow in the cheapest form; learnings outside governing context, path-selected and capped; off by default with an observe-only mode; eight slices. The operator accepted all 13 open-question recommendations and asked for an independent design review before building, after dev.85. The design review (GPT-6.1 Sol) asked for rework (governing files reachable as docs, authority gaps on both schemas, enforcement only at the commit node, thin prompt-injection handling, plus cost, access-path, default, lifecycle, pinning and state-machine gaps); the reworked design (`c5c8d85`) answers each point. The operator accepted its six new recommendations (no auto-merge for upkeep flows; a docs follow-up hitting a non-merge question ends; only the operator lifts a suspension; schema-1 upkeep authority settings operator-only; weak signals alone never call a model; ceilings of 2 upkeep tasks a day and 6 a week, 8 model invocations per upkeep flow, 24 h queue age, 14-day docs backlog) and asked for a re-check before building. The re-check asked for a second rework (symlinked governing ancestors, a per-kind permission matrix, the namespace reservation, candidate transitions, bounded access for expiry and invocation totals, absolute queue deadlines); the second revision (`34d2a3e`) answers them. The operator accepted its three new recommendations (retiring a learning only deletes it; reserve `upkeep:` as a breaking refusal with rename steps; check tasks limited to existing fast-check scripts, 2 files and 80 lines, 12 lines per governing proposal) and asked for one more focused re-check, then building.
- **After dev.85: the reviewer sees the reviewed plan** (adopter report; root build, merge `2079165`, not released): the reviewer was told to accept out-of-scope changes "the reviewed plan justifies" but never saw the plan, so a flow whose reviewed plan widened the declared paths was blocked on every round. The reviewer now receives the plan that passed plan review (summary and files, bounded, as model-written data), and out-of-scope files the plan mentions are listed for evaluation, never as automatic justification. Review (GPT-6.1 Sol): approve with fixes (a restricting or ambiguous mention had been presented as a justification; no integration test); fixed by root with both. Main: 1,286/1,286.
- **Knowledge-upkeep design final** (merged to main, docs only): after a third focused re-check (component-by-component link resolution, check-script identification, a shared invocation count, case-insensitive namespace lookup), all 22 decisions are settled (`da5dd79`). Additions made by the designer and kept: `upkeep.budget.maxOpenTasks` 12, and a shared invocation-counting definition under which a `not-dispatched` model attempt with no receipt counts as zero invocations in Stats. Slice 1 (records and access contracts, lesson signals, path resolution, the `upkeep:` reservation and the unknown-kind refusal) is being built.
- **Knowledge upkeep slice 2** (branch `t3/knowledge-upkeep-slice-two`, not merged; Opus build): the deterministic observe-only job. A pending receipt at merge settlement, queued when the retrospective is recorded; its own lane (`main.verify` and `target.sync` are never delayed); two deadlines that are never moved later; a drain ends a running assessment and returns its receipt; classification with governing subtraction and the pre-filter through verified Git objects; the run record. `upkeep.mode` (`off`, `observe`) is a live setting, and every upkeep authority field is operator-only on both schemas except turning the mode down. No model call, candidate or task. An idle tick adds one meta read. Record, decisions and open questions: docs/changes/upkeep-slice2.md.
- **Decision (operator, 2026-11-16):** fix the dev.85 re-test findings J1–J9 for dev.86 (two builders: the triage proxy's silent failed sends J7 with the T3 guide gaps J9; console and status items J1–J6 and J8). The waiting adopter starts only once all current Factotum work is done.
- **Merged:** knowledge upkeep slice 1 (283ba91). The GPT-6.1 Sol review's one blocking finding was fixed and re-checked: a governing path counts as a protected file only when it is a regular file that a governing entry actually reaches, so a missing path, a directory or a case-only match no longer counts. 1,346 tests passed and eval passed. Slice 2 (the observe-only job, scheduling and settings authority) is being built.
- **Merged:** dev.86 triage proxy fixes J7 and J9 (5daaedb). The changes:
  - unconfirmed forwards are re-sent in rotation;
  - forwards are escalated by age through a verified operator notice with an unpredictable id;
  - forwards carry exact `send` arguments;
  - `--unconfirmed` lists forwards never confirmed sent;
  - record ids up to 640 characters are accepted;
  - the escalation bound is stated as threshold + timer interval;
  - all 28 orchestrator notes are handled.

  Two GPT-6.1 Sol rounds (three P2s, then one P2), each fixed; the last doc fix was checked by the main thread. 1,358 tests, eval passed. **Action needed for adopters:** copy the proxy script again and fill `[[merge-decision-role]]`.

  **Operator decisions (2026-11-16):** keep the proxy's `inbox.publish` operator notice as the escalation for an undeliverable forward. A runtime re-send of accepted but unacknowledged deliveries is a later follow-up, decided only after the dev.86 re-test.
- **Merged:** dev.86 console and status fixes J1–J6 and J8 (fedf251).
  - `repository.target` now follows the workflow-target branch rule. This was the operator's decision of 2026-11-16, and a breaking change for unusual branch names.
  - Generated ids reach 533 characters; reads accept 640.
  - Reviewed by GPT-6.1 Sol: one P2 fixed, then re-checked and approved.
- **Released:** dev.86 (`0.2.0-dev.20261022.86`, manifest `85052cb6…`, from 86358a2).
  - 1,368 tests passed, and `npm run eval` passed.
  - Root and prefix installs were clean.
  - Sent to the readiness-trial thread for re-test, and announced to both adopters.
  - The first adopter upgraded to it with all 11 steps passing, doctor included. The shared console was then restarted on dev.86 with the operator's OK.
- **Knowledge upkeep slice 2** (observe-only job, scheduling, settings authority): built on Fable 5.2. The GPT-6.1 Sol review requested changes, and they are fixed:
  - a shortened deadline was lost under a drain hold;
  - legacy blocks had no safe upgrade transition (`upgrade apply` now validates with the target release first);
  - deduplicated governing files dropped path mappings.

  A console Settings row was added. A re-check is running.

  **Operator decision (2026-11-16):** a governing file the merge itself edited gets the same exception as an edited doc. It is a candidate only through a reference to a path the merge removed. Recorded in design 6.2.
- **Readiness trial, dev.86 re-test (2026-11-16):** the J fixes hold.
  - **Verified live:** J7 on T3, covering a failed send, its retry, escalation and the re-send after rebind. Also J8, J2, J4, J3, J5, J6 and J1, and the adopter's scope report (a file named in the plan passed review). Adopter-copy stages 3, 5 and 6 pass. The re-test does not decide the adopter's start.
  - **New findings, none blocking:**
    - K1: escalation followed a successful re-send, with raw send-id titles.
    - K2: a grouped timeline marker's list is clipped.
    - K3: the Inbox overflows phone width.
    - K4: the scheduled-tier time has no tooltip.
    - K5: six proxy edge cases.
  - **Next:** K1–K5 are being fixed for dev.87.
  - **Cost:** 7 invocations, $0.83 at Claude list price.
- **Merged:** knowledge upkeep slice 2 (9c4fe70).
  - It took three GPT-6.1 Sol re-checks. The P1 came from the slice's own preflight, which ran unverified remote code during `--activate`; the remote-checkout preflight was removed.
  - Results: 1,423 tests and eval passed, and the reference digests are unchanged.
  - **Pre-existing weakness found along the way:** a root installation's lock doesn't authenticate managed files against the manifest digest. A fix is being built for dev.87.
  - Slice 3, the model assessment (observe only), is being built.
- **Merged:** the dev.87 K1–K5 fixes.
  - Three GPT-6.1 Sol rounds; the last P2, a destination list losing its original thread, was fixed by the main thread with a fail-before test.
  - The proxy no longer withdraws escalation notices, because it can't prove it published them; the notice says it is informational.
  - Confirmations name the thread used (`--to`).
  - The script checks `--protocol 87`.
  - The console fits phone widths, and the grouped marker list opens below the chart.
  - 1,439 tests and eval passed.
- **Merged:** root-install lock authentication (16a1996). It took five GPT-6.1 Sol rounds, each adding recovery fixes. Scope decided by the operator: fix authentication, rollback, recovery-time recommission and doctor, and the `.gitattributes`/`.gitmodules` stop. Deferred to runtime follow-ups: the window between verification and unit start against a concurrent checkout writer, and core `authorized()` not enforcing commissioning.
- **Released:** dev.87 (`0.2.0-dev.20261022.87`, manifest `6ce3883a…`, from 736a226).
  - Contents: K1–K5, root-lock authentication, and knowledge upkeep slice 2 (observe-only, off by default).
  - 1,463 tests and eval passed.
  - Root and prefix installs were clean and authenticated.
  - Sent to the trial thread and both adopters.
  - The first adopter upgraded to dev.87 with the release's own CLI: all 11 steps passed, doctor had no warnings, and `rootLayout` is in its lock. The shared console was then restarted on dev.87.
- **Merged:** knowledge upkeep slice 3 (13047bd): the model assessment, observe only, at most 30 model runs a day.
  - **Review:** three GPT-6.1 Sol rounds fixed the midnight rollover, a budget refund after a model ran, invisible characters and mixed-script words.
  - **Operator decision:** the upkeep route is pinned when upkeep is turned on.
  - **Results:** 1,502 tests passed, and eval passed.
  - **Residual risk accepted for observe-only, and required before any slice lets accepted text change governing content** (slice 6 and later):
    - whole-word single-script confusables (an all-Cyrillic look-alike word);
    - punctuation-split words (`Ign-о-re`) pass the text rules.

    Fix both with a confusable skeleton plus punctuation-insensitive matching.
  - **Next:** slice 4, candidate lifecycle and command authority.
- **Readiness trial, dev.87 re-test (2026-11-16):** the K fixes hold. Root-lock authentication and upgrade recovery work as documented.
  - **Root lock:** the evidence was written by the release's own CLI, and a hand-stripped lock was refused by doctor through the anchor.
  - **Recovery:** after a SIGINT during `--merge`, `--recover` gave the exact steps, and following them literally recovered the run.
  - **Proxy:** a protocol mismatch was refused, and `run_scheduled_task_now` is permitted on T3.
  - **Upkeep observe:** refused to a delegate and recorded one run.
  - **New findings, none blocking:**
    - L2: a same-run fallback without a re-read, so obsolete-closing and escalation were never reached;
    - L1: a send outside its arguments was delivered twice;
    - L3: resume could close other threads' forwards;
    - L4: no status read for `upkeepRun`;
    - L5: doctor progress in the JSON stdout;
    - L6: Escape closed the whole flow window;
    - L7: Queue start chips have no tooltip.
  - **Next:** L1–L7 are being fixed for dev.88.
  - **Cost:** 4 invocations, $0.33.
- **Slice 4 build (2026-11-16):** the interrupted Fable 5.2 work on slice 4 was saved as a WIP commit and finished on Opus 5.5.
- **Merged:** knowledge upkeep slice 4 (0f7ac6c), covering candidate lifecycle and command authority. Nothing delivers candidates yet.
  - **Review:** one GPT-6.1 Sol round with two P2s, both fixed and approved on re-check.
    - Candidate caps read an unbounded audit backlog. There is now a partial index for open upkeep candidates.
    - Tasked findings dropped out of Health. There are now tasked and closed indexes, ordered by status time.
  - **State layout:** three new indexes, added by the layout step at service start. dev.87 tolerates them.
  - **Results:** 1,542 tests passed, and eval passed.
  - **Next:** slice 5 part A, enforcement on the final candidate for the `docs` kind.
- **Merged:** knowledge upkeep slice 5 part A (ec87f75).
  - **What it does:**
    - The docs candidate check runs at commit, integrate, publish and merge, from verified objects.
    - Upkeep flows are never merged by policy.
    - A docs integration that hits a conflict fails the step.
    - Adopted or already-satisfied upkeep starts are refused.
  - **Review:** one GPT-6.1 Sol round found three P2 bypasses, all fixed and approved on re-check:
    - lossy decoding of file names;
    - line budgets that missed terminators and BOMs;
    - intermediate binary or oversized blobs.
  - **Results:** 1,566 tests and eval passed.
  - **Preconditions:**
    - Part B: bind the marker into the brief and the revision digest.
    - Slice 6: the confusable-text follow-up.
  - **Next:** part B.
- **Merged:** dev.88 L1–L7, with a simplified triage proxy.
  - **Operator decisions (2026-11-16):**
    - drop forwarding to other threads;
    - when the proxy can't handle a delivery or run, it publishes its own operator notice;
    - trust model: orchestrator-role publishers are trusted, webhook content is not;
    - reviews were capped after the final round.
  - **Review:** eight GPT-6.1 Sol rounds. The last reviewer run was stopped by a content filter. The main thread checked the remaining path itself and fixed one defect: own-notice absorption acknowledged an unverified delivery id.
- **Released:** dev.88 (`0.2.0-dev.20261022.88`, manifest `e1384091…`, from 8eb3ef7).
  - **Contents:**
    - L1–L7;
    - knowledge upkeep slice 3 (observe-mode model calls, at most 30 a day);
    - slice 4 (finding lifecycle, suspension);
    - slice 5 part A (docs enforcement).
  - **Tests:** 1,606 tests and eval passed. Root and prefix installs were clean and authenticated.
  - Sent to the trial thread and both adopters.
  - The first adopter upgraded to dev.88 with the release's own CLI; all 11 steps passed, including doctor. The shared console was then restarted on dev.88.
- **Merged:** knowledge upkeep slice 5 part B (f6fed83).
  - **What it does:** in `propose` mode, the factory creates docs follow-up tasks: criteria use evidence ids only, and file names are ASCII. It checks stale pins and base moves before the build and returns candidates with typed reasons. When it ends a follow-up, it closes only PRs it created, and never re-closes one a person reopened. Health has controls for tasked and closed candidates.
  - **Review:** three GPT-6.1 Sol rounds. Their fixes included filename injection into criteria, missing stale returns, orphaned PRs, forged-marker closes and inherited stale causes.
  - **All flows:** `createPR` no longer adopts a PR on the factory's branch that another account opened, or one from another repository.
  - **Results:** 1,640 tests and eval passed.
  - **Next:** two preconditions for slice 6, built in parallel: the governing-file edit correction loop (runtime follow-up), and confusable-skeleton matching for the text rules.
- **Readiness trial, dev.88 re-test (2026-11-16):** nothing blocking.
  - **Verified live:**
    - the proxy redesign through an outage and a rebind: one destination, one notice per outage, obsolete closing, counts naming their session, `triage-failed-` on a held lock;
    - upkeep observe with one real model call, then `abstained:budget` at 0;
    - the finding forms;
    - L4, L6 and L7;
    - adopter-copy stages.

    L5 was withdrawn.
  - **New findings:**
    - M1 (defect): recommission clears `liveSettingChanges`, so the next file-based `config update` silently reverts live changes made before the upgrade.
    - M2: the release notes are wrong about delegation of `finding.*`.
    - M3: an unchanged candidate is stopped after a replan that only fixed the file list.
    - M4: a proxy reset gives no notice and loses the proxy's identity.
    - M5: a click on padding closes the flow window.
    - M6: an upkeep job waits while admission is paused.
    - M7: no re-send after a rebind.
    - M8 and M9: cosmetic.
  - **Next:** these are being fixed for dev.89.
  - **Operator decisions (2026-11-16):**
    - **Governing-file edits:** every task that edits a governing file needs explicit operator approval through `governingEdits`. This supersedes knowledge-upkeep Q2.
    - **Finding commands:** `finding.*` stay delegable by default when a project has no `policy.delegatedOperations` list; only the docs are corrected.
- **Merged:** the governing-file edit fix (be7e06d), the first of two slice 6 preconditions.
  - **Approval:** a task may edit only the governing files named in `governingEdits`, approved directly by the operator. Every other governing-file edit, adopted PRs included, is refused before review and delivery. This is breaking.
  - **Snapshot:** every step reads the rules in force from a fixed comparison commit.
  - **Instruction loading:** approved tasks run Codex with `project_doc_max_bytes=0` and Claude Code with `--safe-mode`, and a provider without suppression is refused.
  - **Review:** three GPT-6.1 Sol rounds, one P1 among them.
  - **Results:** 1,654 tests and eval passed.
  - **Still to do before slice 6:** the live provider-suppression checklist (`docs/qualification/provider-instructions.md`), and `.codex/` and skills isolation (runtime follow-up).
- **Merged:** dev.89 M1–M9 (147aee4). M1 now keeps live setting changes through recommission, and `config update` names the live settings it changes. Three GPT-6.1 Sol rounds; the final M3 digest fix was checked by the main thread.
- **Released:** dev.89 (`0.2.0-dev.20261022.89`, manifest `dcc88a00…`, from c626bd6). Contents:
  - M1–M9;
  - the governing-file edit fix (breaking);
  - knowledge upkeep slice 5 part B;
  - the all-flows PR adoption authorship check.

  1,674 tests and eval passed. Root and prefix installs were clean and authenticated. Sent to the trial thread, with the provider instruction-loading checklist, and to both adopters. The first adopter upgraded to dev.89 with the release's own CLI. All 11 steps passed, and its live `stats.pricing` setting survived the upgrade, confirming the M1 fix. The shared console was then restarted on dev.89.
- **Readiness trial, dev.89 re-test (2026-11-16):** nothing blocking.
  - **Provider instruction-loading checklist: every step passed live.** Codex 0.169.0 with `-c project_doc_max_bytes=0`, on both `exec` and `exec resume`, and Claude Code 2.1.325 with `--safe-mode --setting-sources ''`, on fresh and resumed sessions, loaded no instruction document from the worktree. The controls without the flags did load them.
  - **Verified live:**
    - M1 provenance and `changedLiveSettings`.
    - A governance edit end to end: approved, sent back once, merged without a replan, with the orchestrator refused and an ordinary edit refused at commit.
    - Upkeep `propose` end to end: stale doc, follow-up task, approval, merge decision, one-sentence fix, candidate delivered.
    - M3, proxy protocol 89, M5, M9, and adopter-copy stages.
  - **New small findings, being fixed for dev.90:**
    - N1: generic failure notice for an enforcement refusal.
    - N2: proxy docs, notice dedup and wording, and an unconfirmed forward with no end.
    - N3: confirmations don't name the finding.
    - N4: a time shown twice.
    - N5: a checklist contradiction.
- **Merged:** knowledge upkeep slice 6, governing-context proposals (ff1f3e5).
  - **What it adds:**
    - Operator-only acceptance creates an approved governance-edit `context` task, atomically, from the stored rows.
    - Text rules apply to every model reason.
    - Docs candidates whose files have become governing are reclassified.
    - `upkeep.context.qualifiedProviders` (operator-only, empty by default) gates every provider start.
    - A linked-directory exception applies only to factory-made context tasks.
  - **Review:** GPT-6.1 Sol approved on the first round.
  - **Results:** 1,700 tests passed, 1 skipped, and eval passed.
  - **Follow-up:** bind provider qualification to the CLI version, and invalidate it when the version changes.
  - **Next:** slice 7, capture creation.
- **Merged:** provider worktree isolation (e34209e).
  - **What it does:**
    - Every Codex step, fresh and resumed, runs from an empty private working root outside the worktree, with the worktree as a writable root.
    - Hooks and project docs are disabled, and the operator's own and bundled skills are disabled too (operator decision).
    - Claude adds `--disable-slash-commands`.
    - Candidates that touch `.codex/`, `.agents/`, `.claude/` or `.mcp.json` must declare those paths. Links are resolved through verified trees, and link cycles under provider configuration are refused.
  - **Review:** four GPT-6.1 Sol rounds. The last fix, refusing cycles, was checked by the main thread.
  - **Results:** 1,714 tests passed, 1 skipped, and eval passed.
  - **Still open:**
    - The model's behaviour with an empty working root is unverified live; watch the first Codex builds.
    - `$CODEX_HOME/AGENTS.md` still loads. Containing builder and check processes is a P2 runtime follow-up.
- **Merged:** dev.90 N1–N5 (6b7167a).
  - Every enforcement refusal now carries an explicit `refusal` field, which feeds a specific notice and `flow.failure`.
  - The proxy logs each decision in two phases, and every state command recovers a decision that wasn't logged.
  - Reviewed by GPT-6.1 Sol in three rounds; the main thread checked the final central gate.
- **Released:** dev.90 (`0.2.0-dev.20261022.90`, manifest `bfcf9016…`, from 535bb5d).
  - **Contents:** provider worktree isolation (breaking: Codex no longer reads `AGENTS.md`), slice 6 and its preconditions, and N1–N5.
  - **Checks:** 1,734 tests and eval passed. Root and prefix installs were clean and authenticated.
  - **Sent** to the trial thread and both adopters.
  - **First adopter upgraded to dev.90.** It used the release's own CLI after adding its root `AGENTS.md` to `context.files`, and all 11 steps passed. The shared console was then restarted on dev.90. It will report its first Codex build from the empty working root.
- **Merged:** knowledge upkeep slice 7, capture creation (afdf887).
  - **What it adds:**
    - `check`, `rule` and `learning` candidates.
    - Check scripts are offered only if no configuration word reaches them through any alias.
    - **Operator decision (2026-11-16):** check tasks need the operator's direct approval, bound to the revision and to each script's blob and mode.
    - Rules use slice 6 acceptance.
    - A learning must be exactly one file.
  - **Review:** two GPT-6.1 Sol rounds.
  - **Results:** 1,754 tests passed, 1 skipped, and eval passed.
  - **Slice 8 requirements:** learnings are read from pinned blobs as `advisory-learning` evidence, outside governing context and its digest. They can't grant permissions or relax rules, every role gets hostile-body tests, and learnings are never skills or instruction files.
  - **Next:** slice 8.
- **Readiness trial, dev.90 re-test (2026-11-16):** nothing blocking.
  - **Provider checklist:**
    - Claude passed every step, offline and live.
    - Codex passed every offline step.
    - Codex live step 1 as written got the canary only because the model read the planted files with `rg`/`cat`. With tool reads forbidden it got none, fresh and resumed. Loading is suppressed; reading worktree files as data is inherent (O1).
  - **Codex builds from the empty root work.** Changes land in the worktree, and a resumed send-back works.
  - **Main live risk, which predates dev.90 (O2):** Codex's workspace-write sandbox on the host blocks Node child processes (`spawnSync` EPERM). Project tests fail inside Codex builds, and the lost rounds exhaust the build visit bound.
  - **Slice 6 end to end:** proposal, then an operator-only accept, then a held context task, then a run on Claude once listed, then merged.
  - **O5 (defect):** a context task held because its provider isn't listed shows no hold in status or Health, and `queue.held` is written every second.
  - **Other findings:**
    - O3: Claude can't write `.claude/` in a build.
    - O4: "date (… ago)" still shown.
    - O6: slice 6 notes still say not to list Codex.
  - **Also checked:** N1 to N5 and proxy protocol 90 hold.
  - **Next:** O1–O6 are being fixed for dev.91.
- **Merged:** knowledge upkeep slice 8, learning consumption and retirement (897b743). **All eight knowledge-upkeep slices are now on main.**
  - **Delivery:** learnings come from pinned blobs as `advisory-learning` evidence with a no-authority statement. They are whole, counted in code points, and placed outside governing context.
  - **Citations and counters:** citation fields and usage counters are recorded.
  - **Retirement:** `learnings.check` uses typed conditions. Retirement deletes only the pinned file. Acceptance is refused for changed or repaired content, and candidates refresh on new content.
  - **Kill criterion (14.3):** delivery stops below 10% cited after 20 selections, measured per lift window, and only the operator can lift it. An `all` suspension also stops new delivery.
  - **Console:** Health lists refused files, and the flow view shows pins.
  - **Review:** three GPT-6.1 Sol rounds, the last capped.
  - **Results:** 1,775 tests passed, 1 skipped, and eval passed.
- **Merged:** dev.91 O1–O6 (3166237).
  - The context-provider hold now shows everywhere, and recurring tick problems are deduplicated by their identifying fields.
  - A refused claim moves on to the next task, and manual dispatch lists the tasks it skipped.
  - Doctor warns about the Codex sandbox, and admission refuses paths the builder can't write.
  - Review took three GPT-6.1 Sol rounds; the last fix, a display change, was checked by the main thread.
  - **Decisions:** the Codex permission profile and the Claude permission handler are deferred as follow-ups, and the build-visit bound is kept.
- **Released:** dev.91 (`0.2.0-dev.20261022.91`, manifest `c3564a9e…`, from cd57840).
  - Contents: slices 7 and 8, which put **every knowledge-upkeep slice in a release**, plus O1–O6.
  - 1,791 tests and eval passed. Root and prefix installs were clean and authenticated.
  - Sent to the trial thread and both adopters.
  - **First adopter upgraded to dev.91;** the shared console was restarted. It reported that doctor's Codex sandbox check read as unknown.
  - **Root cause:** the probe's stdout is a socket, and the sandbox refuses the shutdown an asynchronous write needs.
  - **Fixed on main (12c4f09):** the probe now writes synchronously, and a passing doctor's warnings now reach the upgrade result (`doctorWarnings`). It ships in the next release; the main thread fixed and checked it, with tests that fail before the fix.
- **Readiness trial, dev.91 re-test (partial, 2026-11-17):** nothing blocking.
  - **Verified:** O1 to O5, live, including the Codex checklist with no command run. Slice 8 delivery and citations across all four roles, the pin on the flow page, and a `learnings.check` retirement. Adopter-copy stages also pass.
  - **New findings:**
    - P1 is the sandbox probe, already fixed on main (12c4f09).
    - P2: the daily and weekly upkeep ceilings counted the operator's own acceptances, which blocked them for the rest of the UTC day. **Operator decision (2026-11-17):** the ceilings limit only factory-created tasks and delegated acceptances.
    - P3: a learning written with list spacing is refused, and the template doesn't say so.
    - P4: `status --flow` lacks learning selection and use, the flow page shows no citations, and one Health sentence is garbled.
  - **Next:** P2–P4 are being fixed for dev.92.
- **Merged:** dev.92 P2–P4 (4402048).
  - Ceilings now spare the operator, and Health shows the budget and the later reset.
  - The learning `paths` list accepts spacing.
  - Citations appear in `status --flow` and on the flow page.
  - Review: GPT-6.1 Sol, which also approved the probe fix 12c4f09. The last P3 (the reset time) was fixed by the main thread.
- **Released:** dev.92 (`0.2.0-dev.20261022.92`, manifest `61a1088e…`, from 5c93395).
  - 1,803 tests and eval passed. Root and prefix installs were clean and authenticated.
  - Sent to the trial thread to finish the re-test, and to both adopters.
  - The first adopter upgraded to dev.92. All 11 steps passed, and `doctorWarnings` showed the real sandbox result (spawnSync EPERM). The shared console was then restarted on dev.92.
- **Readiness trial, dev.92 re-test, finishing dev.91 (2026-11-17):** nothing blocking.
  - **Verified:**
    - P1 to P4.
    - P2: the operator's acceptances go through at the ceiling, and a delegate is refused with the reset time.
    - The context-provider hold shows everywhere, with two events and no flood.
    - The `gone/**` retirement was accepted, approved, deleted only its file, and merged.
    - Adopter copy.
  - **Upkeep observation:** 14 runs since dev.87.
    - 8 reached the model and 4 proposed (2 docs, 2 context).
    - The rest: 2 already covered, 2 stopped by the budget, 2 with no candidate, 4 at the pre-filter.
    - Each call took about 20–24k input tokens, under 250 output tokens, and about 6 s.
  - **Not tested:** accepting and approving a check or learning. No capture candidate arose in four merges.
  - **New findings:**
    - Q1: the flow page says no citations when some were recorded.
    - Q2: a task-scoped hold is described as holding the whole queue.
    - Q3: Overview doesn't mention holds.
    - Q4: Queue is too wide at 390 px.
    - Q5: the upkeep share is about 15%, because follow-up flows count, as designed. Small projects will reach the 10% ceiling. This needs docs and Health only.
  - **Next:** these are being fixed for dev.93.
- **Merged:** dev.93 Q1–Q5 (3f68a6f).
  - **What changed:**
    - flow citations reach the console;
    - holds are described by their scope;
    - Overview qualifies "the rest of the queue still starts";
    - long ids wrap, and the timeline picks its ticks from the rendered width;
    - Health shows the upkeep share in observe and propose modes.
  - **Review:** GPT-6.1 Sol reviewed it, and the main thread checked the second round.
- **Released:** dev.93 (`0.2.0-dev.20261022.93`, manifest `50c7b448…`, from 009993e). 1,812 tests and eval passed, and root and prefix installs were clean and authenticated. The first adopter upgraded to dev.93, and all 11 steps passed. The shared console was then restarted on dev.93.
- **Readiness trial, dev.93 re-test (2026-11-17):** Q1–Q5 are fixed, checked in a real browser at desktop, 390 and 320 px.
  - **New console findings:**
    - R1: at 390 px a Timeline tap opened a different flow.
    - R2: in a busy flow's timeline, a quarter of attempt bars can't be tapped at phone width.
    - R3: Overview's Queue figure has no link, and a queue line doesn't name the pause.
  - **Still untested live:** the capture path (check and learning acceptance). Four attempts produced no candidate.
  - **The trial's overall view:** Factotum is **ready for the waiting adopter to start, on terms**. The decision is the operator's. The terms:
    - adopt with the release's own CLI, under a prefix;
    - merge decisions stay with the operator;
    - the adopter's instructions go into `context.files`;
    - Claude builders;
    - the provider checklist runs on the adopter's host;
    - upkeep starts at `off` or `observe`;
    - T3 uses the direct webhook, not the proxy, and the ask route is not used yet;
    - the console is used on desktop until R1 is fixed;
    - the state directory stays outside the checkout.
  - **Trial cost so far:** 344 invocations, about $51 at Claude list price.
  - **Next:** R1–R3 are being fixed for dev.94.
- **Merged:** dev.94 R1–R3 (1732034).
  - Timeline bars are drawn only. A separate tap layer gives targets of at least 44 px on phones, with no overlap, and counted groups.
  - A refresh keeps focus inside an open group.
  - Overview links to Queue, and queue entries name the pause.
  - Reviewed by GPT-6.1 Sol; the main thread checked the focus fix.
- **Released:** dev.94 (`0.2.0-dev.20261022.94`, manifest `adc17c3f…`, from 00df417).
  - 1,824 tests and eval passed. Root and prefix installs were clean and authenticated.
  - With it, all planned Factotum work before the waiting adopter's start is done.
  - The first adopter upgraded to dev.94, and all 11 steps passed. The shared console was then restarted on dev.94.
- **Trial re-test (dev.94):** nothing blocking. R1–R3 are fixed, checked by touch at desktop, 390 px and 320 px with no wrong targets. Adopter copy passes stages 3, 5 and 6.
  - **New, small (S1):** at phone width, a busy flow's closed event-marker groups still overlap each other by 2 to 15 px. Only the event-marker lane is affected; tap targets are not.
- **Operator decision (2026-11-17):** the waiting adopter starts on dev.94, on the trial's terms. S1 is fixed in a later release. The go was sent to that adopter's orchestrator, which runs its own adoption.
- **Merged:** dev.95 S1 (fa5f795). Event markers in a flow's execution timeline and on the Timeline tab are grouped by their drawn box sizes, so closed groups no longer overlap at phone width. Reviewed by GPT-6.1 Sol: approved with no findings.
- **Released:** dev.95 (`0.2.0-dev.20261022.95`, manifest `c9301269…`, from b8da8d6). 1,833 tests and eval passed. Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.95, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. The shared console was then restarted on dev.95.
- **Trial re-test (dev.95):** S1 is fixed, R1–R3 still hold, and there is no new product finding. A real browser at desktop, 390 px and 320 px found no overlapping closed event-marker boxes in a busy flow or on the Timeline at 12 h and 24 h, and each event was listed exactly once.
  - **Incident, not a finding:** the tester's phone taps hit the header presence control twice. Presence switches without confirmation, which may be easy to do by accident at phone width.
- **Third adopter on dev.94 (2026-11-17):** installed with the release's own CLI under a prefix, merged with operator approval, commissioned and registered with the shared console. Doctor is ready with no warnings, and admission is paused by the adopter's own hold.
  - **Adopter-side fixes, not Factotum defects:** a project-wide script needed the documented path filter, despite the prefix. Checks receive only PATH, HOME and LANG, so the check argv now sets its own TMPDIR. The `DESCENDANTS_SURVIVE` refusal caught a real leaked compiler server in the adopter's tests.
  - **Upstream note, cosmetic:** after the handling-guide template's optional sections are deleted, about eight cross-references to them remain (the triage shorthand, "After binding", "Standing down and resuming", proxy state keys, the ask-prompt exception and the presentation-withdraw step).
- **Merged:** dev.96 small items. The handling-guide template keeps every optional reference inside its own section, and a test deletes each section and checks for leftovers. The check environment is documented. The unused marker code is removed. Checked by the main thread.
- **Released:** dev.96 (`0.2.0-dev.20261022.96`, manifest `ca5ed3ac…`, from 9bfc78c). 1,836 tests and eval passed. Root and prefix installs were clean and authenticated. It is the first release tagged in the public repository.
  - The first adopter upgraded to dev.96, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. The shared console was then restarted on dev.96.
- **Trial re-test (dev.96, light):** no findings. The upgrade, adoption, doctor and console checks passed with no warnings. The trial stripped the handling-guide template by its note in two combinations, and no reference to deleted material was left.
- **Design merged:** the must-fix review gate ([design](designs/review-must-fix.md)), requested by the third adopter after a seven-round review that fixed only corner cases and missed the defect that mattered. Findings block only when shown reachable here with evidence and breaking the change's purpose or a protected class; uncertain ones become operator items. `must-fix` stays unavailable until slice 6 ships every safeguard, and earlier slices are shadow only.
  - **Review:** GPT-6.1 Sol rejected the first version (nine findings, five high) and the revision (four findings). The main thread checked the final four fixes.
  - **Operator decision (2026-11-17):** every recommended answer to the open questions is accepted.
- **Merged:** dev.97, from the second adopter's report that cleanup archived `node_modules` despite its exclusions. Node's `path.matchesGlob` never lets `*` or `**` match a dot segment, so `node_modules/**` missed `node_modules/.pnpm`; 20 failed-flow archives of 1.1 GB each resulted. Cleanup now uses the factory's own matcher. New operator-only commands: `cleanup archive-slim` shrinks existing archives without losing work, and `cleanup archive-drop` removes merged flows' archives that hold nothing beyond their committed head.
  - **Review:** two GPT-6.1 Sol rounds (five findings, then one). The main thread fixed the last (changes hidden by index flags) and confirmed the reviewer's reproductions are refused.
- **Released:** dev.97 (`0.2.0-dev.20261022.97`, manifest `a48de149…`, from 37178db). 1,868 tests and eval passed. Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.97, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. Its root-anchored globs needed no change, and its archives are small. The shared console was then restarted on dev.97.
- **Merged:** must-fix review slice 1 (schemas, finding ids, citation validation, the 4.3 derivation, `policy.reviewBar` with `severity` and `shadow`, pinning, shadow v1). `must-fix` stays refused. A golden captured before the change shows severity review is unchanged in prompts, schemas, results, routes, history and strict digests. Reviewed by GPT-6.1 Sol; its two medium findings were fixed and checked by the main thread.
- **Released:** dev.98 (`0.2.0-dev.20261022.98`, manifest `a85902c5…`, from 6fa140f). 1,891 tests and eval passed. Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.98, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. It keeps `reviewBar` at `severity`. The shared console was then restarted on dev.98.
- **Trial re-test (dev.97 cleanup):** passed. A planted pnpm-style store reproduced the defect on dev.96 (1 MB excluded, 11 MB tar); on dev.97 the plan excluded 7.3 MB and kept the untracked note, an uncovered ignored file, a staged change and an assume-unchanged edit. `archive-slim` freed 7.5 MB with the bundle, index and pack byte-identical; restore during a slim was refused by the lock; `archive-drop` refused the failed archive and the orchestrator. Not verified: a successful drop of an eligible merged archive.
  - **Two low findings, fixed on main for the next release:** T1, `archive-drop` on a merged flow released by the normal post-merge cleanup said "workspace is not released" instead of "no cleanup archive is recorded"; T2, `cleanup plan` did not name or count a change hidden by an index flag (the archive kept it).
- **Merged:** must-fix review slice 2 (purpose block and synthesis, fail-closed protocol checks with one correction then park, the plan-review protocol-failure stop, shadow v2). Severity flows are unchanged and the slice 1 golden passes without edits. Reviewed by GPT-6.1 Sol: three medium findings (the shadow correction could cross the attempt deadline; a correction could drop strict escalation; a plan hold lost it on resume), all fixed; the builder confirmed the reviewer's probes now pass. The shadow correction's 20-second minimum and 30-second margin are the builder's choice.
- **Released:** dev.99 (`0.2.0-dev.20261022.99`, manifest `df20aa68…`, from dfd5135), with slice 2 and the re-test fixes T1 and T2. 1,909 tests and eval passed. Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.99, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. The shared console was then restarted on dev.99.
- **Merged:** must-fix review slice 3 (the review ledger, later-round judgements, the in-fix rule, exclusion support confirmed only by a different model family, shadow v3). Shadow keeps the reviewer's own `priorFindingsDisposition` for routing, because the factory mirror would let shadow change delta routing; the reviewer agreed. Reviewed by GPT-6.1 Sol: approve with two medium fixes (ledger preparation could eat the reviewer's deadline; one legacy disposition could close two findings with the same message), both fixed with the reviewer's probes reproduced first.
- **Released:** dev.100 (`0.2.0-dev.20261022.100`, manifest `684350c2…`, from 7f9900c). 1,926 tests and eval passed. Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.100, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. The shared console was then restarted on dev.100.
- **Test safety (2026-11-17):** the slice 4 builder found that engine-level review tests start real supervisor processes running the real provider adapter, so with `claude` or `codex` installed they could launch a provider CLI (model "fictional"). `tests/run.mjs` now puts stand-in `claude`, `codex`, `gemini` and `cursor-agent` commands that exit 97 first on PATH for the whole suite. One earlier run did: on 2026-11-16 a knowledge-upkeep assessment test launched the installed `claude`, which rejected the model "fictional" with no tokens used. No other trace was found.
- **Merged:** must-fix review slice 4 (enforcement routing in 6.1 order, builder deferral and its judgement table, the unchanged-candidate exemption, the cap and budget check with `send_back`, `flow.disposeFinding`, plan notes), reachable only from fixtures. Reviewed by GPT-6.1 Sol: one high finding (a reviewer's exclusion confirmation could lower an operator's `operator-required`) and two medium (final-phase adjudication skipped the cap; the budget check ignored visit bounds before the merge question), all fixed with the reviewer's probes failing first.
- **Released:** dev.101 (`0.2.0-dev.20261022.101`, manifest `b42dc17b…`, from 8fd8fce). 1,950 tests and eval passed. Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.101, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. The shared console was then restarted on dev.101.
- **Merged:** must-fix review slice 5 (the strict requirement with acknowledgement digests, the decision guard including `critical` and `autoMerge`, console evidence and the acknowledgement form, operator-only `review.restrict`, notifications, lesson signals and Stats), reachable only from fixtures. No default orchestrator authority widened. Reviewed by GPT-6.1 Sol: one high finding (a merge prepared before a restriction still dispatched; the final dispatch transaction now rechecks the live guard and reopens the question) and one medium (Stats counted only finished flows; it now uses the admission cohort), both fixed with failing tests first. Slices 1 to 5 are now built; slice 6 (enabling) needs a shadow trial on a real project first.
- **Released:** dev.102 (`0.2.0-dev.20261022.102`, manifest `1c0238ef…`, from 036801c). 1,986 tests and eval passed. Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.102, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. The shared console was then restarted on dev.102.
- **Operator decisions (2026-11-21):**
  - **Backups while paused:** the third adopter reported that a paused project ran no scheduled `maintenance.backup` for about two days, because schedules are dispatched only when not held. A due backup schedule will now run while admission is paused; a drain, recovery hold or retention hold still holds it, and any other held schedule that misses an occurrence raises a notice. Being built for dev.103.
  - **Must-fix shadow trial:** the third adopter runs `reviewBar: shadow` on its normal work, plus one planted stale-output false-pass task, when its operator chooses. Slice 6 (enabling `must-fix`) waits for that data.
    - The third adopter confirmed `reviewBar: shadow` is active on dev.102. Its planted stale-output task runs, alone and never merged, after its first Factotum task merges.
- **Merged:** dev.103, scheduled backups while paused. A due `maintenance.backup` schedule runs while admission is paused; recovery, retention, drain and upgrade-in-progress hold it whether or not admission is paused, rechecked inside the admission transaction. Every held schedule raises one notice per hold, kept through acknowledgement, resolved on release and superseded on removal, and found beyond `windowMs`. Reviewed by GPT-6.1 Sol: three medium findings, all fixed with the reviewer's probes failing first.
  - **Open issue:** full suite runs fail one or two unrelated test files that pass alone, on dev.102 too. Cause not found yet.
- **Released:** dev.103 (`0.2.0-dev.20261022.103`, manifest `9c08fcc7…`, from d1fe54d). Root and prefix installs were clean and authenticated.
  - The first adopter upgraded to dev.103, and all 11 steps passed; its only doctor warning was the known Codex sandbox one. The shared console was then restarted on dev.103.
- **Operator decision (2026-11-21):** the shared console may be restarted whenever an adopter's own agent reports a clean upgrade, without asking each time.
- **Operator decision (2026-11-17):** OS containment of builder and check processes is **not needed now**. The documented same-account trust model is accepted, and containment is revisited only on need. The runtime follow-up stays recorded.
- **Merged:** upkeep confusable-text matching (890ed3b), the second slice 6 precondition.
  - **What changed:** text rules now also match a UTS #39 reading, using a vendored, trimmed Unicode 18.0.0 table (1,109 rows) that its generator self-checks against the full source. Look-alike digits and symbols can be read as a letter or as a gap, with gaps capped at four characters.
  - **Review:** three GPT-6.1 Sol rounds, each with one or two P2 bypasses. The operator-style cap ended review after the third round, and the main thread probed the final fix itself.
  - **False positives:** 1 in 156,086 paragraphs.
  - **Limits:** stated in docs/changes/upkeep-confusables.md.
  - **Tests:** 1,686 run, 1,685 pass and 1 is skipped. The skipped test needs the full Unicode source file. Eval passed.
  - **Remaining before slice 6:**
    - the live provider-suppression checklist (with the dev.89 trial);
    - `.codex/` and skills isolation;
    - applying the text rules to reasons.
- **Knowledge upkeep slice 3** (branch `t3/knowledge-upkeep-slice-3`, not merged; the model assessment, the validator and bounded telemetry): an observing run whose pre-filter finds something to assess now asks a model once and counts what a deterministic validator would keep. It still writes no candidate and creates no task.
  - **Built:** evidence blocks (the instruction text is one constant; nothing in a block can close it or pass for an instruction); the validator, with drops counted by rule; model selection under `maintenance/knowledge.upkeep` (`providers.upkeep`, or the reviewer); the daily reservation (exact under concurrent starts, kept by an uncertain attempt until `attempt.resolve`); the maintained invocation totals, counted by the one function Stats uses; the run telemetry.
  - **Carry-overs from the slice 2 review:** `models.update` for the upkeep step is the operator's alone on both schemas; `assessment-unavailable` is not a run that reached a model; the four model budget limits are settled as ceilings; Stats counts upkeep invocations by the same definition.
  - **Changes for adopters:** a project that already observes starts making model calls (at most 30 a day; `maxModelRunsPerDay: 0` keeps it to the deterministic part); `providers.upkeep` is validated; Stats counts a `not-dispatched` model attempt with no recorded invocation as none.
  - **Review (GPT-6.1 Sol) of `bbfe0aa`:** changes requested, three P2s, all fixed with fail-before tests: a step crossing a UTC midnight could bypass the daily ceiling (the reservation now reads the clock in its own transaction); resolving an attempt as `not-dispatched` gave back a model run its receipt proved (kept now); zero-width and other invisible characters carried text past the text rules (refused now, and compatibility forms are folded before matching).
  - **Operator decision (2026-11-16), Q7:** the assessment's route is pinned when upkeep is turned on (`providers.upkeep`, or the reviewer's route at that moment). Later reviewer changes do not reach it; delegates keep the reviewer. A project that already observes is pinned to the route in force when it adopts the release. Settings shows the route.
  - **Other questions settled by the reviewer's recommendations:** a drain closes an assessment that already reached a model; a model call that conclusively ended without a result fails instead of staying uncertain; the rest kept as built. Three design sentences were changed to match (5.3, 6.3, 6.6).
  - **Re-check (GPT-6.1 Sol) of `800d1d5`:** everything held but one P2: a Latin word with a Cyrillic or Greek look-alike letter passed the text rules. Fixed: a word whose letters mix scripts is refused in replacements, reasons and quotes (UTS #39 per word; one-script text in any language is allowed).
  - **Not done:** a second re-check; release notes (the text is ready in the record). Record: docs/changes/upkeep-slice3.md.
- **Readiness trial of dev.81, second session (2026-11-15):** verdict unchanged, not ready for a large project and one fix release away. The trial added real-browser console checks (R4, R6: six misleading displays and about 25 smaller items) and external pull request adoption (R5, F42, F43). 26 console commands behaved, stale answers and approvals were refused, and console values matched `status` across restarts. The trial report now defines a twelve-stage test approach to rerun on every release candidate, including a console stage driven by GPT-6.1 Sol browser agents and an external pull request stage. Plan: the next release carries R5, R6 and the protection follow-ups as well as what is already on main, so the re-test exercises one candidate with every known must-fix.

**2026-11-14 — #7/#8 slice C reviewed and merged to main, not released**

- Implementation `5b6d2ef` (Opus 5.5 builder). Independent review (GPT-6.1 Sol): **reject** — grant-backed orchestrator answers could omit relay provenance; grant-backed approval and unused-grant revocation skipped the task-scoped pre-commit audit. Design questions 1–5 and 7–9 accepted; question 6 (verbatim relays for informational questions) left to the operator. The suspected credential dependency in `tests/original-request.test.mjs` was ruled out (the test uses its own fake `gh`).
- Fixes `ff84bcb` (builder); both new tests fail on `5b6d2ef`. Re-check: **approve with fixes**; root accepted, and the reviewer confirmed, that grant-backed cancellations need no relay (the entry pins the payload; the orchestrator may only choose among explicitly authorized entries). Documentation corrected by root in `dbd00b6`.
- Verification: authority test files 70/70 on re-check; branch `npm test` 719/719 first run; main after merge 719/719; `npm run eval` exit 0.
- Merged to main as `7548fd2`.

**2026-11-14 — load-sensitive test qualification merged to main (reliability lane, not a numbered change)**

- Implementation `9196538` (Opus 5.5 builder): ~30 tests' timing assumptions replaced with condition waits and fixture-only bounds; no assertion weakened, skipped or retried. Production defect fixed: a live, slow-starting supervisor no longer turns its attempt `uncertain` after 5 s (launch identity recorded in `launch.json`). SIGKILLs of test git processes and a test-file process were traced to the host environment, not Factotum (all 398 traced suite signals hit the sender's own fixtures; none in 36 runs launched outside the agent session); host kernel logs show no OOM kill of these processes.
- Review (GPT-6.1 Sol): approve with fixes, one blocking — a supervisor stalled before ownership could not be cancelled. Builder fix `6e48c6b` (durable `abort.json` stop request, then after 15 s a freeze with identity-checked SIGKILL or SIGCONT; 10-minute `launch-stalled` operator notice; reconciliation without attestation only when a complete launch identity proves the supervisor ended before ownership). Re-checks then found, and root fixed: a frozen owner left stopped across a runner restart and incomplete launch identity granting the shortcut (`1c2dfc8`); a freeze left in place when a receipt won first (`2f845df`, durable `launchAbort.frozen` resumed every tick); supervisor stop handlers removed before receipt publication (`359c1b0`). Final re-check approved.
- Operator-recommended decision applied: the bulk-scan responsiveness test keeps its real 1.5 s console-deadline assertion; a separate deterministic test bounds slow scans.
- Verification: builder stress runs (outside and inside the agent session, with 48 busy loops, load 30–57) 675/675 ×7; root final branch run 679/679; merged main 703/703; `npm run eval` exit 0. Not re-established at load above ~60. Residual: the pre-ownership stop test assumes a 1.5 s window; its single observed failure is better explained by the fixed receipt-handler gap.
- Merged to main as `e93fb19`. This resolves the load-sensitive qualification issues recorded above, subject to host conditions.

**2026-11-14 — #7/#8 slice B reviewed and merged to main, not released**

- Implementation `4d68dd1` (Opus 5.5 builder). Independent review (GPT-6.1 Sol): **reject** — restoring an exact pre-removal brief cleared a removed decision's hold and let a flow complete; mixed replacement/removal supersession wrote audit-invalid evidence. Design questions 1, 2, 4–8 judged acceptable interims (held flows resume automatically; policy auto-merge still answers the merge question, with the merge step held at preparation, until slice D).
- Fixes `a76a5f6` (builder): removal clears only revisions recorded from the removal brief; returning to a pre-removal revision reopens a fresh unresolved decision (`reopens`); removal lineage always validated; task-scoped audit inside every decision command. Re-check: **reject** on corrupt-evidence cases (cyclic reopens suppressed holds; scoped audit missed cross-task shared uses). Root fixes `164f762`. Second re-check: **approve with fixes**, two non-blocking items (acyclic invalid ancestry; per-use scan cost), fixed by root in `241f3a5`.
- Verification: decision/authority files 54/54; branch `npm test` 681/681 at `164f762`, then 680/681 at `241f3a5` with one failure (`tests/stats-view.test.mjs`: `git add .` in the test sandbox killed by SIGKILL; 6/6 three times in isolation, on branch and main) passed to the qualification assignment as evidence of an unowned-process kill. Main after merge: 681/681. `npm run eval` exit 0.
- Merged to main as `418de13`.

**2026-11-13 — #7/#8 slice A reviewed and merged to main, not released, not enforced**

- Implementation `2b99273` (Opus 5.5 builder). Independent review (GPT-6.1 Sol): **reject** — versioned writes could roll back usage or reactivate revoked evidence; audit accepted dispositions not covering their decision and dangling revisions; a pre-opened old-runtime connection kept writing after migration; the migration marker was unvalidated.
- Fixes `60614e4` (builder): one-way transitions, exact coverage audit, a trigger-based write fence that old runtimes cannot satisfy, closed migration record. Re-check: **reject** — cancellation authority could back an answer; supersession could cite a nonexistent revised brief; the fence refused current writes with `trusted_schema=OFF`. The re-checking reviewer's harness leaked `GIT_DIR` and created a stray commit in the slice worktree; it reset the branch, root verified main, the branch and git config were intact, and later review briefs forbid git environment overrides.
- Fixes `d9685bf` (builder): full disposition → use → grant-entry binding, recorded revised briefs, explicit `trusted_schema=ON` with verification. Second re-check: **reject** — one counted use could back two dispositions; ratification could extend an answer to a changed revision.
- Root fixes `063f9e9`: one use per disposition; ratification names its exact predecessor and revisions. Third re-check: **approve with fixes**, one non-blocking finding (cyclic ratification history), fixed by root in `454d49c`.
- Verification: slice tests 30/30 (also 29/29 on Node 24.0.0 and 24.22.2 at `d9685bf`); `npm run eval` exit 0; branch `npm test` 648/648 on the final run. Two intermediate full runs each had one different failure (`tests/notification-policy.test.mjs` resolution wakes; `starter/factory/console/console.test.mjs` file-level failure) while the host load average was ~68 from outside work; both files passed 5/5 three times in isolation. Main after merge: 657/657.
- Merged to main as `5253a7b`. Not wired: commands, enforcement, communication v2, UI. Migration must not be offered to adopters before enforcement.

**2026-11-13 — #13 context-mapping fix reviewed and merged to main, not released**

- Implementation `59e5481` (Opus 5.5 builder). Independent review (GPT-6.1 Sol): **reject** — build context not bound to the passing plan review (change → review → restore accepted); existing entries' definitions not compared; budget eviction diagnostic misleading.
- Fixes `b2c68fd` (Opus 5.5 builder); every new test fails on `59e5481`. Re-check (GPT-6.1 Sol): all three resolved, no new findings, approve. Boundary noted: the digest check binds to the canonical plan-review result; custom graphs that deliberately omit plan review keep that capability. Newly rejected, deliberately: a plan-scope file the context budget would omit.
- Verification: focused 11-file set 85/85; branch `npm test` 615/615; main after merge 627/627.
- Merged to main as `b3200a4`.

**2026-11-13 — #5 reviewed and merged to main, not released**

- Implementation `f7bf326` (Opus 5.5 builder). Independent review (GPT-6.1 Sol): approve with fixes — two blocking (console form trimmed verbatim quotations; `Date.parse` accepted impossible dates) and one hardening item (prompt delimiters forgeable; sources could contain line breaks).
- Root fixes `da0e4b7`. Re-check: all three resolved; one new finding, the date fix rejected valid ECMAScript end-of-day and ±15–23 h offset date-times. Root fix `af8db48`; second re-check resolved, with a 579,054-case comparative probe showing only impossible calendar dates newly rejected.
- Verification at `af8db48`: focused original-request, console and source tests 53/53; `npm test` 618/618. An earlier run at `da0e4b7` failed once in `tests/runtime.test.mjs` "revocation cancels owned running work and resume requires a new grant" (timed out waiting for the attempt to start under load); 16/16 three times in isolation and 618/618 on rerun. Recorded as a fourth load-sensitive test.
- Merged to main as `8b566ba`.

**2026-11-13 — #7/#8 design reviewed and merged to main**

- Design `77fe8fc` (document only). First independent review was cancelled before producing output; relaunched review (GPT-6.1 Sol, high effort) approved with no blocking findings and checked insertion points against both the base and current main.
- Two non-blocking clarifications applied by root in `bcb3e89`: the #1 notification classifier added to the insertion points and slice G acceptance; operator-only `decision.revoke` and `decision.ratify` transitions, preconditions and fixtures defined. Not re-reviewed (document-only, non-blocking).
- Merged to main as `10b9ad9`. No runtime behavior changed; implementation remains outstanding.

**2026-11-13 — #1 reviewed and merged to main, not released**

- Implementation `a371117`; independent review (GPT-6.1 Sol, high effort): approve with fixes, two blocking findings — nested provider findings, unverified acceptance and retained worker reports ignored; a required-CI pass after rerun classified as clean.
- Root fixes `09d7725`. Independent re-check: rerun resolved; one remaining silencing defect, historical findings treated as resolved regardless of disposition. Root fix `794c735` requires the latest disposition to be `fixed` with evidence. Second re-check: resolved, no new findings. Every fix has regression cases that are suppressed on the prior commit.
- Verification at `794c735`: 8 focused notification/settings test files 43/43; `npm test` 587/587; `git diff --check` clean. Not verified: live webhook delivery, browser Settings interaction.
- Merged to main as `6530caf`. Combined main suite: first run 605/606, second run 606/606. The single failure was `tests/target-workspace.test.mjs` "reentry validates its existing owned tree and never substitutes another workspace": `git config` exited with no code (terminated by a signal) under suite load; neither change touches workspace code, and the file passed 6/6 three times in isolation. Recorded as a third open load-sensitivity issue, root-owned, to resolve before release qualification.

Each future release entry must list **plan change number(s), version, manifest digest, verification commands/results, review disposition, adoption/commissioning requirements and remaining live proof**. Split changes can have several release entries. Operational reliability changes outside the numbered plan retain separate references to the [triage](core-request-triage-2026-11-13.md) or [runtime follow-ups](runtime-followups.md).
