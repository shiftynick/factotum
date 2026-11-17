# Live GitHub and subscription-provider qualification

This exercise copies the starter into two independent fictional projects, creates private disposable personal GitHub repositories, disables GitHub Actions before pushing, and runs the delivery workflow using subscription-backed Codex and Claude CLIs. It retains all runtime state outside this repository. It never deletes remote repositories.

Run after the deterministic suite passes and the live adapters have completed integration. Repository creation and real provider calls require the operator's authorization; they are not routine CI.

```sh
# Provision only; do not start any provider or factory workflow yet.
node evals/live.mjs --create --provision-only

# Use the printed directory to continue the exact same qualification.
node evals/live.mjs --runtime /absolute/private/runtime
```

Use `--advanced` before commissioning to exercise bounded-delta delivery and an explicitly strict Python task; the JavaScript task retains its controlled-defect challenge. The selected profile is preserved in the private manifest. It never enables paid adapters or automatic merge.

Use `--create --runtime PATH` to resume incomplete provisioning if a repository does not yet exist. Every prospective repository name is saved before remote creation. An uncertain creation response is reconciled by querying that exact name; rerunning with a new runtime creates another qualification and must be deliberate. A private `qualification.json` retains account identity, URLs, project/state paths and progress. Keep it and provider artifacts outside Git. Do not commit live output as a fixture.

Initial provisioning resolves the currently authenticated GitHub account at runtime, then pins that account for API calls. Its initial direct Git push uses the configured SSH remote and requires the corresponding SSH credentials. Factory delivery and the final-snapshot follow-up instead use explicit account-pinned HTTPS Git transport, independent of the user's globally active account. The reference's subscription adapters must confirm provider authentication and billing route before launching. Do not add API tokens to work around a subscription preflight failure.

Provisioning copies the fictional JavaScript and Python fixtures, runs baseline checks, establishes that feature acceptance fails, pushes `main`, and creates a versioned issue brief. Before initializing factory state, execution refreshes and commits the adopted starter from the working reference. After initialization it never updates that executor automatically: drain/reconcile the original pinned code before changing it.

The JavaScript fixture uses Codex for planning/building and Claude for fresh review. The Python fixture reverses those roles. Both use the same approved graph, exact acceptance tests, a host resource coordinator, and manual merge decisions. The harness records the operator's already authorized fictional qualification approval and answers the graph's final `merge` decision only when canonical evidence permits it. Unexpected questions, stopped/failed flows and missing receipts fail the run and retain evidence.

## Register PRs with the supervising host

After publication the script prints a JSON `pull-request.needs-link` event containing the actual URL and an external `ackPath`. It pauses there. In T3 Code, the supervising agent must immediately call `link_pull_request` for that URL, then create the empty acknowledgment file at that exact path. Do not acknowledge before registration. A standalone host can record its equivalent PR registration and acknowledge explicitly; this is a host handoff marker, not merge authority.

## Controlled defect and persistent correction

By default the JavaScript run injects one deliberate product defect after initial publication and before fresh review: loading saved completion state always returns pending. It commits/pushes the mutation through the owned-worktree adapter and records a `qualification.mutation` event explicitly identifying controlled fault injection. This is not described as a model-authored bug. Acceptance tests remain unchanged.

A successful mutated run must retain a failing independent review and a subsequent builder correction that resumes the original builder session. The final independent review, gate, remote merge and feature acceptance must all pass. `--no-inject` is available for an additional plain smoke run; it omits the correction challenge and cannot substantiate that claim.

Each flow is bounded to 20 minutes per invocation. Provider invocations have their own configured limits. A timeout or interruption retains the same flow and attempts; rerun against the existing runtime rather than creating replacement state. Inspect an uncertain attempt before continuing. Existing completed projects are skipped. An executor mismatch is a recovery hold, not permission to rewrite pinned state.

## Reading the result

`qualification.passed` means the fixture's factory flow completed, the original PR is remotely merged and its post-merge checkout passes acceptance. For the seeded challenge it additionally means independent defect detection and persistent builder correction were verified. The private manifest records these claims separately.

The default merge remains manual commissioning. It does not qualify automatic target freshness. Local expected-target reads leave a race; automatic merge needs a separate disposable remote-protection exercise that advances the target after the final local read and demonstrates server rejection. Missing private-repository branch-protection entitlement is an unsupported capability, not a passing auto-merge result.

Repositories and private runtime files remain for inspection after the run. Deletion is a separate operator action. Two fictional fixtures demonstrate portability and selected recovery/control behavior; they do not prove correctness for every application stack or future CLI version.

## Final-snapshot already-satisfied qualification

After both deliveries finish, the authorized follow-up can reuse the existing private web repository without creating another repository or PR:

```sh
node evals/satisfied-live.mjs --runtime /absolute/private/runtime
```

This is a live subscription-backed qualification, not routine CI. The script requires a completed fictional web qualification, a clean main checkout equal to remote main, every existing flow drained, every attempt settled, and no project hold. It acquires exclusive runner ownership before replacing the adopted starter. It copies the final reference starter including its compatibility manifest, commits and pushes that copy, updates the same configuration through the canonical command, and reruns the copied doctor. It never replaces an executor beneath active work. Network Git operations use the explicit account/repository scope.

The follow-up creates a uniquely marked fictional issue with the original web acceptance criteria and records its identity before starting a distinct stable flow with `alreadySatisfied:true`. The real systemd workflow performs a fresh Claude review and actual acceptance checks, and the harness answers only the canonical `satisfied-decide` acceptance question. It verifies the recorded outcome against the unchanged remote target, successful source-issue closure, owned-worktree removal and branch deletion, every new attempt settled as passed, and an unchanged set of remote PRs.

Evidence is appended under the web project's `satisfiedQualification` field in the private manifest. A failure or unexpected question retains the exact flow, artifacts, and history for inspection; the script does not blindly replay an uncertain effect. Once a final-snapshot flow has started, it never refreshes that flow's executor. A completed follow-up is reported without creating another issue or invoking another model. For an explicitly authorized additional final snapshot, pass `--new`; this requires a passed prior certificate and a different reference executor digest, archives the prior certificate in private history, and creates a distinct marked issue/flow. It never forks unresolved work or silently repeats the same qualified snapshot.

Historical qualification warnings remain part of the audit record. In particular, a prior web source-closure attempt completed its remote write but received a supervisor containment warning. Its failed attempt record must not be rewritten as passed. The final-snapshot follow-up separately requires its own source-closure attempt and all other attempts to settle cleanly, so a successful later qualification supplements rather than erases that earlier evidence.
