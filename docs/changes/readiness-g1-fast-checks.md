# Readiness G1: fast checks between build and review

Implemented against the dev.79 baseline (`aae3b12`). This is a local implementation record, not a release, activation or live qualification claim. It covers plan change 11 as redirected by the field evidence: script-checkable rules move out of review into a cheap project-owned check step. The ignored-file project pilot and the strategy's "recheck branch/environment prerequisites before the first build and when the base changes" are not part of this change.

## Contract

- A new core operation, `fastCheck` (result slot `fast-check`), runs the project's configured `fastChecks` on the exact candidate. Its contract preserves the input, mints no kernel evidence and owns one privileged field, `fastCheckHold`. A graph may give the node a `prefix:name` observation; it can never claim `gate` or `review` (existing `validateOperations` rule).
- Each result is pinned: `inputIdentity` (candidate head and tree digest), `checkDefinitionDigest` (digest of the commissioned `fastChecks`) and `attemptId`, plus `checks[]` with the same status, failure class, artifact and bounded `diagnostics` shape as gate checks.
- Checks run through the same runner as the gate (now a shared `runChecks` in `dispatch.mjs`): explicit environment, `FACTOTUM_CHECK_DIAGNOSTICS` per check, the same diagnostic excerpt bounds, `holdExitCodes` stopping later checks. Commands get `FACTOTUM_CHECK_KIND=fast`. Artifacts are `fast-check-N.json` and `fast-check-N-diagnostics.txt`. The tree must be clean before and unchanged after.
- No forge status is published; fast checks are not gate evidence. The final gate, review and merge requirements are unchanged.

## Configuration

```json
"fastChecks": {
  "checks": [{"id": "verify-step", "argv": ["node", "project/integrations/fast-check.mjs"], "timeoutMs": 30000, "holdExitCodes": [78], "rules": ["A change to behaviour updates its verify step"]}],
  "heavy": false
}
```

Validated in `validateConfig` (`starter/factory/workflows/fast-checks.mjs`): 1–8 checks, unique short ids, argv lists, `timeoutMs` ≤ 5 minutes each and ≤ 10 minutes in total, `holdExitCodes` as for gate checks, up to 16 single-line `rules` of ≤ 300 characters, boolean `heavy`. Unknown keys are refused. `fastChecks` is part of the configuration digest, so it changes only through `config update`.

## Graph placement

- `change.standard` with `fastChecks`: `integrate --integrated--> fast-check --pass--> publish`, `--fail--> build`; `maxVisits: maxBuildRounds + 4`; observation `fast-check:passed`; `heavy: true` when `fastChecks.heavy`; effect timeout = sum of check timeouts + 60 s (+60 s when heavy); graph `maxTransitions` +20. Running on the integrated candidate means it checks exactly what is published and reviewed.
- Without `fastChecks` the reference graphs are byte-for-byte the previous graphs (tested by structural equality), so commissioned digests and approvals are unaffected.
- `change.document` never gets the step (documents run no checks).
- Project-owned graphs are not rewritten. They add a node with `"action": {"operation": "fastCheck"}` under any name. Commissioning refuses such a node without explicit `pass` and `fail` result edges (so a failure cannot fall through to `next`), and refuses it when no `fastChecks` are configured.
- When `fastChecks.heavy` is true, the step takes the heavy-work permit even if a project graph omitted `heavy` on the node (`actionSpecification`).

## Routing

| Outcome | Result | Engine |
| --- | --- | --- |
| all pass | `route: pass` | follows `pass`; records the node's observation for the candidate |
| product failure | `route: fail` | follows `fail` (reference: `build`, spending a build visit); observation withdrawn |
| reserved exit | `route: held`, `fastCheckHold.kind: check-prerequisite` | stops at the step, `resumeStep` = the step; no builder visit; later checks skipped |
| timeout / launch failure | `held`, `infrastructure` | as above |
| heavy permit not free within min(timeout/2, 60 s) | `held`, `resource-wait`, reason names the holder | as above; no check runs |
| check changed the tree | `held` reason recorded; attempt not clean | `onFailure` (reference: `failed`), as for the gate |

Prerequisite and infrastructure take precedence over product failure, matching the gate. Each hold emits `flow.fast-check-held`.

The builder prompt receives the failed checks' diagnostics only through `fastCheckCorrection`, which requires the result's `inputIdentity` to equal the builder's current candidate and `checkDefinitionDigest` to equal the commissioned definitions. The review prompt gets the owned-rule guidance (`fastCheckReviewGuidance`) only when the fast checks passed on exactly the candidate under review under the current definitions; otherwise nothing is added. `flow.replan` now supersedes fast-check results along with gate results (`supersededGateResults`).

## Limits and bounds

- Repeated failures spend build visits; the existing `build.maxVisits` stops the flow with `workflow visit bound exhausted at build`.
- A builder returning the unchanged candidate after a fast-check failure on that exact candidate stops (`unchanged candidate after fast checks failed`, event `flow.correction-held` with `cause: fast-check`) instead of rerunning the checks, mirroring the review correction hold.
- Holds need an explicit resume; there is no automatic retry after a resource wait.
- Reviewer guidance is advice in the prompt. It does not filter findings, and a reviewer may still report a real defect.
- Settings view lists `fastChecks` read-only; the timeline counts the step as checks.

## Starter material

`starter/project/integrations/fast-check.example.mjs` (rule: a change to `src/` also changes `test/`; exit 1 for a violation, 78 for a missing target ref; children spawned with stdin ignored; writes `FACTOTUM_CHECK_DIAGNOSTICS`), a configuration example in `starter/project/README.md`, a checklist item in `SETUP_CHECKLIST.md`, and a note in the `factotum-workflows` skill. Reference documentation: [project workflows](../project-workflows.md#fast-checks-before-review).

## Verification

New `tests/fast-checks.test.mjs`, 10 tests. Engine tests launch real supervised attempts of the `fastCheck` step whose checks are real Node subprocesses (fictional script outside the checkout); provider prompts are captured through the real dispatch path with a fictional provider; one builder result and the heavy-permit result are injected into `settle`.

- pass → `publish`, `fast-check:passed` observation pinned to the candidate, no gate evidence, review prompt lists `[verify-step] <rule>`;
- product failure → `build` with designated-file and stdout diagnostics in the builder prompt, no review attempt, no gate evidence; unchanged builder result then stops;
- stale identity: diagnostics and reviewer exemption disappear after the candidate moves or the check definition changes;
- reserved exit 78 → stopped at `fast-check`, no build visit, diagnostics retained; replan supersedes the result;
- timeout → infrastructure hold; a tree-editing check fails the step;
- build visits already at the bound → stopped with the visit-bound reason;
- project-owned graph with steps `house-rules` and `implement` routes failure to `implement`, and the builder sees the diagnostics;
- heavy step: another holder keeps the permit; the real dispatch waits about 1 s, returns `resource-wait` naming the holder, runs no check, and the engine holds without a builder visit;
- configuration bounds; commissioning refuses missing `fail` edge, `evidence: "gate"` and a node without `fastChecks`; reference graphs unchanged without `fastChecks`; document graph unchanged with it;
- the starter example script: 78 without a target ref, `fail` naming `src/app.txt`, `pass` once a test changes.

Results on this checkout (Linux, Node 24):

- `node --test tests/fast-checks.test.mjs`: 10/10 passed.
- Related files (`workflow-catalog`, `delivery`, `target-sync-health`, `review-correction`, `replan-feedback`, `console-views`, `timeline-routing`): 52/52 passed.
- `npm test`: three full runs. Run 1: 731/731 passed. Run 2 (after documentation edits only): 730/731; `tests/launch-liveness.test.mjs` "a stop request received before ownership means the effect is never started" failed with the supervisor exit code `null` (killed by a signal). That file does not exercise this change; rerun alone three times: 21/21 each. Run 3: 731/731 passed.
- Reference graphs without `fastChecks` were compared with the base commit's `configuration.mjs` (`git archive aae3b12`): `changeWorkflow` and `documentWorkflow` digests are identical for the default, no-planning/7-round and preview configurations.
- `npm run eval`: passed (`"passed": true`, two synthetic projects completed).
- `git diff --check`: clean.

Not verified: a live provider, forge or adopting project; the systemd supervisor; the console rendering of the new settings field; a project-owned graph that places fast checks before `integrate`.

## Independent review fixes (root)

Review of `fa79836` (GPT-6.1 Sol): reject on one finding, all six design choices accepted. **Git-launched checks bypassed their bounds.** `runChecks` used the dispatcher whose `git` branch routes to the factory's credential-scoped Git helper, which ignored the check's timeout, signal, output bound and environment (`argv: ["git", …]` with `timeoutMs: 10` passed after 421 ms; `FACTOTUM_CHECK_KIND` was absent). This was inherited from the gate. Checks are trusted project commands that must never receive factory Git credentials, so `runChecks` now always runs them directly; the fix applies to gate checks too. Regression: a git-launched fast check sees `FACTOTUM_CHECK_KIND=fast` and no `GH_TOKEN`, and a `git` alias sleeping 5 s with `timeoutMs: 200` becomes an infrastructure hold; it fails on `fa79836`.

The documentation's claim that a project cannot bypass resource coordination is qualified: `heavy: true` takes the shared permit; `heavy: false` is the project's declaration that its checks are light, enforced only by the time bounds.

Re-check of `93bd401`: the timeout fix was confirmed for fast and gate checks; two follow-ups, fixed by root. (1) Running `git` checks directly had also dropped the old helper's non-credential safeguards. Git-launched checks now get `CHECK_GIT_OPTIONS` (no automatic maintenance or gc, `core.hooksPath=/dev/null`, no commit/tag signing) and `CHECK_GIT_ENV` (no system or global config, no terminal or askpass prompts), and still never the factory's credentials. (2) The regression now asserts the real credential variable, `FACTOTUM_GIT_TOKEN`, is absent, alongside the suppressed hooks, maintenance and global config.

**Adopter-facing compatibility change.** Before this change, a gate check whose argv began with `git` and ran `fetch`, `push` or `ls-remote` received the factory's scoped GitHub token and approved-URL rewriting. Checks must not receive credentials, so such a check now runs without them and may fail to authenticate against a private remote. `mainChecks` used a separate path and are unaffected. Projects should not fetch in checks; if a check genuinely needs a remote, provide the data as a declared input or move the step into a project-owned integration with its own credentials. This needs a release note.

Second re-check of `bfb1ed5`: **approve**. Its one non-blocking, inherited finding is fixed by root: a check exceeding the 2 MiB output bound (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`) is now an infrastructure hold rather than a product failure sent to the builder; the regression fails on `bfb1ed5`.
