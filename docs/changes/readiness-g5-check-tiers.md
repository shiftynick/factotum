# Readiness G5: main-check tiers

Implemented against main at `8a5aa77`. This is a local implementation record, not a release, activation or live qualification claim. Operator decision: a project can mark each baseline main check as running after every merge or only in scheduled (full) verifications. Merges then run only the light checks, a schedule runs everything, and a failure in either tier turns the target red and holds admission in code.

## Contract

- `mainChecks[].tier`: `"merge"` (default) or `"scheduled"`. Validated in `validateConfig` (`starter/factory/operations/main-tiers.mjs`); any other value is refused, and at least one check must stay in the merge tier. Absent everywhere means today's behaviour: every check runs after every merge.
- `main.verify` `payload.tier`: `"merge"` (merge-tier checks only) or `"all"` (every check). Default `"all"`. `job.enqueue` and `schedule.put` refuse other values.

| Verification | Tier |
| --- | --- |
| Post-merge baseline (`post-merge-main:<flow>`, autoQueue) | `merge` |
| Admission-triggered refresh (`main-refresh:…`) | `merge`; `all` when scheduled-tier evidence is missing, expired, or red and the target moved since it failed |
| Configured `main.verify` schedule | payload's tier, default `all` |
| Manual `main.verify` | payload's tier, default `all` |
| Doctor | `all` (qualifies the whole baseline) |

Factory-requested jobs add `tier` to their payload only when the project has scheduled-tier checks, so payloads of untiered projects are unchanged.

## Health record

A `main.verify` result's `mainHealth` adds:

- `tier`: the tier the verification ran (`merge` or `all`).
- `tiers`: the check tiers its evidence covers (`["merge"]` or `["merge","scheduled"]`).
- `checks[].tier`, and `tier` on each `mainCheckObservation`.
- `scheduled` (full verifications only): `{status: green|red, head, checkedAt, checks, failed, flowId}` for the scheduled tier, or `null` when the project has no scheduled checks. A full run whose scheduled checks were blocked, whose target moved, or whose input changed records no `scheduled`, so earlier evidence stands and ages.

`setTargetHealth` composes every write (`composeTargetHealth`): a write without `scheduled` carries the stored `scheduled` forward; `null` removes it. If the carried scheduled tier is red, the stored `status` is `red`, `tierStatus` keeps the write's own status, and `reason` names the failed scheduled checks. This covers merge-tier results, merge settlement, dispatch-time invalidation, target sync, probes and failed settlements, per target.

The `main.health` operator exception speaks for every tier: on a tiered project it also records `scheduled` with the same status and `source: "operator-exception"`.

## Freshness and admission

- Merge tier: unchanged. Green and no older than `policy.mainHealthMaxAgeMs` (default one hour).
- Scheduled tier (only when some check has `tier: "scheduled"`): `scheduled` must exist, be green and be no older than `policy.scheduledHealthMaxAgeMs`. Default 26 hours (a daily schedule plus slack), allowed one hour to seven days, a live setting. Missing or expired evidence **holds** admission (chosen over warning: an expired full suite means "a red main stops the line" is no longer being checked). With `autoQueue`, the loop requests one full verification.
- A red scheduled tier holds admission until a later full verification passes. A merge-tier pass, another merge or a probe cannot clear it. With `autoQueue`, a full verification is requested once the target head differs from the failed scheduled evidence's head (a fix merged); never again for the same head, and the existing 15-minute retry back-off after a failed verification still applies.
- Recovery tasks keep their existing bypass. Source verification's green-health guard sees the composed red.

Admission (`admissionReasons`), `waitingOnMain`, `ensureMainVerification`, `queueStatus` and `mainHealthReason` share `scheduledTierHold`. Reasons:

- `main health is red: scheduled-tier check full-suite failed at <head> (<time>); a merge-tier pass does not clear it; fix main or use an explicit recovery task. A full verification is requested automatically once for each new main head, including a fix pushed outside the factory` (wording depends on `autoQueue`, `mainProbeMs` and whether a full `main.verify` schedule exists; see Independent review fixes)
- `main scheduled-tier evidence is stale: last verified <time>, older than policy.scheduledHealthMaxAgeMs; a full main verification (every tier) is requested automatically`
- `main scheduled-tier checks have not passed yet; …`

Other targets are named in place of `main`, as before.

## Reuse, flakes, diagnostics, resources

Per check, unchanged in each tier. Reuse (`reuseMaxAgeMs`) also looks in `scheduled.checks`, only when that evidence is green on the same head, so a scheduled check's clean pass survives intervening merge-tier verifications on that head. Flake registrations, retries, check artifacts, the heavy permit (`main.verify` still takes it whatever the tier) and per-target health are unchanged.

## Console and Stats

- Health card: last run's tier, the merge tier's own status when the scheduled tier overrides it, the scheduled tier's status, head, time, staleness and failed checks, the admission hold text for that target, and a `scheduled tier` tag on check rows.
- Settings: a `Runs` column for main checks and the `Scheduled-tier lifetime` live setting.
- Stats main-verification history: `tier`, `tiers` and `scheduled` per verification, shown as a `Tiers` column.

## Compatibility

Projects without `tier` get the same checks after every merge, the same post-merge and refresh payloads (`{}` / `{target}`), no `scheduled` field in stored health and no new admission reason. Verification results gain `tier`, `tiers`, `checks[].tier` and `scheduled: null`; stored health gains `tier`, `tiers`. Existing stored health without `scheduled` is "never verified" for the scheduled tier, so adopting tiers needs a full verification; doctor (required after the configuration change) provides it. The starter template now spells `"tier": "merge"` and `scheduledHealthMaxAgeMs` explicitly.

## Verification

New `tests/main-check-tiers.test.mjs`, 10 tests. Every main check is a real Node subprocess run by the real verifier against a real local bare remote; jobs are admitted by `operationalTick`, prepared by the engine and settled canonically. Only the forge merge result is injected. Covered: merge-tier only after merge; configured schedule runs every tier; scheduled failure → red → admission and `flow.start` held → merge-tier pass does not clear (`tierStatus` green) → full pass clears; scheduled evidence expiry and missing evidence with automatic full-verification request; red scheduled tier re-verified only after the head moves; operator exception; legacy config unchanged (payload, checks run, stored health); reuse of a scheduled check across a merge-tier run and a registered flake in the scheduled tier; validation; doctor fails on a scheduled failure and records scheduled evidence on pass; two targets with independent scheduled evidence; Health card and Settings tier display; Stats history tiers.

Results on this worktree:

- `node --test tests/main-check-tiers.test.mjs`: 10 pass, 0 fail.
- `npm test`: 743 tests, 742 pass, 1 fail. The failure is `tests/stats-view.test.mjs` "stats count merged work per period…" (`today 0 !== 2`), run at 00:02 UTC: its fixture flows finish ten minutes before now, so just after UTC midnight they land in yesterday's bucket. The same test fails identically on the untouched base commit at that time. Rerun alone at 00:13 UTC: 6 pass, 0 fail.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Independent review fixes

An independent review rejected the first version (24827fb) with four findings; all are fixed.

1. **A failed full verification cleared a scheduled red (P1).** A full run whose scheduled checks passed while a merge-tier check failed replaced the red scheduled evidence with green, so a later merge-tier pass reopened admission. `composeTargetHealth` now latches a red scheduled tier: new scheduled evidence replaces it only when it is red again, when the whole full run is green, or for an operator `main.health` exception. Otherwise the red evidence stays unchanged and gains `stillRedAt: {head, checkedAt, status, flowId}`, so that head is not verified in full again automatically (`scheduledRecheckDue`).
2. **An external fix never triggered recovery (P1).** The head probe skipped red targets, so a fix pushed outside the factory left the recorded head unchanged forever. `probeTargetHead` now also probes targets held red by a scheduled tier; a moved head is written as `unknown` and composed back to red, keeping the scheduled evidence, and `ensureMainVerification` requests one full verification per new head (after the existing 15-minute back-off). The hold text now matches the configuration: with `autoQueue` and probing, "requested automatically once for each new main head, including a fix pushed outside the factory"; with `mainProbeMs: 0`, factory merges only, and run `main.verify` after an outside fix; without `autoQueue`, "After fixing main, run main.verify (every tier, the default)". "Or wait for the scheduled full verification" appears only when an enabled full `main.verify` schedule exists for that target.
3. **Untiered health shapes changed (P2).** The verifier adds `tier`, `tiers`, `checks[].tier`, observation `tier` and `scheduled` only when the project has scheduled-tier checks, and `setTargetHealth` strips any `scheduled` for projects without them (so dropping tiers cannot leave a stale red). A blocked full run (any blocked check, not just a blocked scheduled check) now records no scheduled evidence. The legacy test asserts the exact pre-tier key sets of the result, the stored health and each check row.
4. **Stats counted a merge-tier pass as recovery (P2).** Settling a `main.verify` on a tiered project records the target's effective health on the flow (`targetHealth: {status, head, scheduled}`). Stats history adds `targetStatus` (falling back to the run's own status), and "merges since last green" counts from the last effective green. The Main verification table shows the target status beside the run result when they differ.

This supersedes the Compatibility line above: verification results and stored health of untiered projects gain no new fields.

New tests in `tests/main-check-tiers.test.mjs` (15 in total, all real check subprocesses against a real bare remote): the reviewer's two blocking scenarios (failed full run then merge-tier pass; external fix pushed while red, probed, verified once per head, then cleared); recovery wording for `autoQueue` off, with a schedule, and with probing off; Stats merges-since-green across a merge made while red; every health writer preserving scheduled red evidence (merge, `main.verify` dispatch, `target.sync` dispatch and settlement, failed settlement, head probe, store reopen) and a blocked full run recording none. With only the source files reverted to 24827fb, 7 of the 15 fail (the two updated existing tests and the five new ones).

Results on this worktree after the fixes:

- `node --test tests/main-check-tiers.test.mjs`: 15 pass, 0 fail.
- Related files (main-check-tiers, main-health-audit, main-freshness, target-sync-health, queue-status, commission-maintenance, operations, post-merge-operations, targets, stats-view): 93 pass, 0 fail.
- `npm test`: 748 pass, 0 fail.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

Re-check of `e2fda80`: findings 1–3 confirmed resolved, and every `setTargetHealth` caller traced with no other path clearing a scheduled red. Two remaining items, fixed by root:

- **Superseded settlements (blocking P2).** A merge-tier verification superseded by another health write never recorded effective target health, so Stats fell back to the run's own green. Settlement now records `targetHealth.status = 'superseded'` for an unapplied result, and Stats never counts it as a recovery. The regression fails on `e2fda80`.
- **Same-head recovery guidance (non-blocking).** With autoQueue and probing on, the message now also says to run `main.verify` (every tier) for the same head, for example after a transient failure. A scheduled full run clears the latch on the same head too.
