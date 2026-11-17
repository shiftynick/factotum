# Adopting the starter

Factotum is a working reference that projects copy and adapt. Its first environment is Linux, GitHub, subscription-backed Codex and Claude CLIs, and systemd user supervision. The [qualification record](qualification.md) distinguishes tested behavior from unsupported capabilities. The broader [design](design.md) explains the intended invariants.

Concurrent admission compares declared task paths, pinned active task scope and local changes in assigned owned worktrees (including deletions, rename endpoints and untracked files). Missing or invalid assigned-worktree evidence holds admission. This is a bounded local observation, not a lock on future edits: a builder can expand its scope after another change starts. Begin with one active change; raising capacity requires project-specific scope discipline and integration checks. Admission does not fetch remote state solely to discover path conflicts.

Declared task `paths` (repository-relative files or directories, `.` for everything) keep overlapping work apart at admission. They are not a lock: a builder can still change files outside them. From dev.82 the factory passes them on:

- **Checks.** Gate and fast checks get `FACTOTUM_TASK_PATHS` (the declared paths, one per line, normalized; empty when the task declares none) and `FACTOTUM_TASK_PATHS_FILE` (the same list in a private file in the attempt directory), next to `FACTOTUM_TARGET`, `FACTOTUM_CHECK_KIND` and `FACTOTUM_CHECK_DIAGNOSTICS`. A scope rule can fail on changed files outside them; the [starter fast check](../starter/project/integrations/fast-check.example.mjs) has one, off by default (`TASK_PATHS_RULE`).
- **Review.** When the task declares paths, the reviewer's prompt lists them and every file the whole change (not only a delta) touches outside them, and tells the reviewer to treat each as a finding unless the reviewed plan justifies it. The review result records them as `scope: {paths, outside, outsideCount}` (at most 200 files listed).

Before raising `policy.maxFlows` above 1, decide whether review is enough or turn on the fast-check rule, and have whoever decides merges look at `scope.outside` on the review.

## Copy and configure

```text
starter/
  factory/
    core/          Durable records, authority, workflow and supervision
    workflows/     Development delivery, commissioning and maintenance
    adapters/      GitHub, owned workspaces, providers and optional hosts
    operations/    Resources, schedules, context, retention and extensions
    service/       Versioned local project API and canonical commands
    console/       Shared local interface and project registry
    cli.mjs
  project/
    factotum.template.json  Delivery configuration with failing placeholders
    workflow.template.json  Explicit synthetic rehearsal
    task.example.json
  VERSION
  compatibility.json
examples/          Fictional JavaScript, Python and local release fixtures
evals/             Deterministic, live and extension exercises
tests/             Recovery, authority, adapters and integration checks
```

Use the [locked adoption tool](updates.md) to install the entire starter and `factotum.lock.json` on a review branch. The installed `VERSION`, `compatibility.json`, `factory/` and `project/` go at the repository root, or under one folder with `adopt install --prefix tools/factotum` when the project already has its own files at those paths (for example a root `VERSION`). The lock stays at the root and records the prefix, so updates, `upgrade apply`, service units, doctor and printed commands all find it; see [install under a folder](updates.md#install-under-a-folder). Under a prefix, read `factory/` and `project/` in these guides as `<prefix>/factory/` and `<prefix>/project/`, and write configured paths relative to the repository root (`tools/factotum/project/GOVERNANCE.md`). Releases do not contain Factotum's own tests, so nothing installed joins the project's test discovery. Doctor treats installed files that differ from the lock as a blocking reason. Adoption commands (`adopt status/plan/update`, `upgrade apply`) need the full Git history and refuse a shallow clone; the running factory and doctor do not (see [shallow clones](updates.md#install-under-a-folder)). Keep `factory/` upstream-owned and project extensions outside it. Later updates prepare isolated review worktrees, preserve project-owned files and flag core modifications. There is no automatic upstream overwrite or runtime activation. Factotum is licensed under Apache-2.0 ([LICENSE](../LICENSE)). Each release carries the license as `factory/LICENSE`, upstream-managed like the rest of `factory/`, so an installation keeps its copy of the license; exclude it from the project's own licence scanners with the rest of the installation (below).

When you replace the template's placeholder checks (`checks`, `mainChecks`, and `fastChecks` if you add them), remember that a check runs with only `PATH`, `HOME` and `LANG` from the environment, plus the factory's own `FACTOTUM_*` variables. `TMPDIR` and every other variable are dropped, so a check that needs scratch space falls back to `/tmp`. Set what it needs in its `argv`, for example `["env", "TMPDIR=/srv/scratch/myproject-checks", "npm", "test"]` with that directory created beforehand. See [what a check's environment holds](running.md#configure-and-commission-delivery).

### Keep project-wide tooling off the installed files

An installation adds about 150 files of Factotum's own code (`VERSION`, `compatibility.json`, `factory/`, `project/`, at the root or under the install prefix) plus `factotum.lock.json` at the root. A repository's own tree-wide tooling (linters, formatters, type checkers, test discovery, licence, header or naming scanners, spell checkers, pre-commit hooks) will scan them too, and its rules were not written for them: a guard that passed before the installation can fail on the installed files alone as soon as the installation merges. Exclude the installation from that tooling in the same review branch, before the installation merges. Do not edit, reformat or rename managed files to satisfy a local rule: that is drift, which doctor refuses (it names the files), and the next update would undo it.

Exclude the install prefix (for example `tools/factotum/`) and `factotum.lock.json`; for a root installation, `factory/`, `project/`, `VERSION`, `compatibility.json` and `factotum.lock.json`. Project-owned files you keep inside the installation folder (integration scripts under `project/integrations/`, governance) are excluded with it; give them a run of their own if you want them checked. For example, with the prefix `tools/factotum`:

| Tool | Where | Exclusion |
| --- | --- | --- |
| ESLint (flat config) | `eslint.config.js` | `{ ignores: ['tools/factotum/**'] }` as the first config object |
| ESLint (legacy) | `.eslintignore` | `tools/factotum/` |
| Prettier | `.prettierignore` | `tools/factotum/` and `factotum.lock.json` |
| TypeScript | `tsconfig.json` | `"exclude": ["tools/factotum"]` |
| Jest / Vitest | `jest.config.js` / `vitest.config.ts` | `testPathIgnorePatterns: ['/tools/factotum/']` / `exclude: [...configDefaults.exclude, 'tools/factotum/**']` |
| Ruff | `pyproject.toml` (`[tool.ruff]`) | `extend-exclude = ["tools/factotum"]` |
| Black | `pyproject.toml` (`[tool.black]`) | `extend-exclude = '^/tools/factotum/'` (a regular expression over paths from the project root, which start with `/`, not a list) |
| flake8 | `.flake8` / `setup.cfg` | `extend-exclude = tools/factotum` (a pattern with a `/` is taken relative to the config file) |
| pytest | `pytest.ini` / `pyproject.toml` | `norecursedirs = .* *.egg _darcs build CVS dist node_modules venv {arch} tools/factotum` (releases contain no tests, but this keeps collection away; setting `norecursedirs` replaces pytest's defaults, so keep them, and a pattern with a `/` is matched against the whole path) |
| markdownlint | `.markdownlintignore` | `tools/factotum/` |
| codespell | `.codespellrc` | `skip = ./tools/factotum,./factotum.lock.json` (matched against paths as walked, so run it from the root as `codespell` or `codespell .`) |
| pre-commit | `.pre-commit-config.yaml` | top-level `exclude: ^(tools/factotum/|factotum\.lock\.json$)` |
| EditorConfig checkers, licence and header scanners, custom pattern scanners with an ignore list | their own ignore list | the same paths |
| A project script that walks the tree itself, with no ignore list | the script | a path filter in its own code (below) |

**Scripts with no ignore list.** Not every check has an ignore list. A project's own script that walks the tree itself (for example a guard that reads every file under a few fixed top-level folders and matches a pattern) scans whatever is there, and the only way to exclude the installation is a path filter in its own code. Add it through the normal change process, on the installation branch, and keep it one obvious line; for example, in a Node script:

```js
const EXCLUDED = ['tools/factotum/', 'factotum.lock.json']; // the Factotum installation: managed files, not ours
const files = allFiles.filter(file => !EXCLUDED.some(path => file === path || file.startsWith(path)));
```

and in a shell script, prune the paths from `find`, or let Git list the files:

```sh
find . \( -path ./.git -o -path ./tools/factotum -o -path ./factotum.lock.json \) -prune -o -type f -print
git grep -l '<pattern>' -- . ':!tools/factotum' ':!factotum.lock.json'
```

Not `grep -r --exclude-dir=tools/factotum`: `--exclude-dir` is documented to match a folder's base name, so a path does not reliably work, and `--exclude-dir=factotum` would also skip any other folder named `factotum`. Compare paths relative to the repository root, so the filter means the same wherever the script runs from. Choosing an install prefix outside the folders such scripts walk avoids the change altogether: look for them before choosing the prefix (`adopt install --prefix`). After the change, every check that passed before the installation should pass again.

For a root installation use `factory/`, `project/` and the root `VERSION` and `compatibility.json` in place of `tools/factotum/`. Run the project's full tree-wide checks once on the installation branch before merging it, and once more on each update branch: a release can add files.

From dev.83 the core declares and calls no functions named like React hooks (`use` followed by a capital letter), which React's rules-of-hooks lint rule reports anywhere outside a component; earlier releases did, so a repository that lints all `.js`/`.mjs` files with that rule failed on them. Excluding the installation remains the recommendation: other rules can still disagree with the core.

The installed [core agent policy](../starter/factory/AGENTS.md) makes this boundary explicit: project agents customize configuration and integrations, including custom adapter scripts outside `factory/`, and propose missing core capabilities upstream through the operator. Built-in adapters remain part of the upstream core. Retain this policy as required agent context and mirror it in the project's root agent instructions. Core fixes are developed in the reference checkout and consumed through a release update, rather than patched in each adopting repository.

Create a fresh stable project identity with `init`. Keep all runtime state, credentials, connection material, provider traces and real repository identities in private configuration outside Git. Worktrees live beneath that project's private state, outside its checkout. Configure Git commit attribution locally in the repository. Delivery scopes both API and Git network operations to the configured account without switching global CLI state. Git validates the approved host/repository, rewrites approved remotes to HTTPS per invocation, and resolves private credentials only into the network child's environment. Stored remotes and `process.env` are unchanged; global Git transport configuration is ignored and conflicting local transport overrides are rejected.

Copy `project/factotum.template.json` to local configuration. Replace the fictional account/repository, required context, actual baseline/acceptance commands, and private resource/backup locations. The placeholder commands deliberately fail. Provider/model identifiers are explicit configuration, and conflicting API credentials/routing cannot silently change subscription billing.

**Where the configuration file lives.** Keep the project's configuration file outside the repository checkout, in a private directory of its own, for example `/private/config/example.factotum.json` with mode 0600; the same directory holds any other private integration files, such as the notification delivery file. It names an account and absolute private paths, so it must not be tracked. It also must not sit untracked in the checkout: doctor refuses a checkout with any modified file or any untracked file that Git does not ignore. Every command that takes `--config` (`init`, `config update`) is given this path. Record in the project's private notes where it is; `config show` prints the configuration in force.

Run `doctor` while the runner is stopped. It requires a clean checkout matching the current remote target, systemd delivery supervision, verified provider capabilities/subscription routes, repository access, available required governance, and passing actual `mainChecks`. Recommission after changing configuration, CLIs or authentication. Importing a task never approves it.

## Project responsibilities

| Integration | Delivered reference | Project supplies |
| --- | --- | --- |
| Work definition | Versioned GitHub brief import, canonical revision and approval | Outcome, acceptance, risk, dependencies and post-delivery obligations |
| Planning/review | Bounded reviewed planning, persistent builder and fresh reviewer | Approved providers/models, review policy and governing context |
| Workspace | Ownership manifests, isolated worktrees, commit/integration/push/cleanup | Reproducible setup, local Git attribution, configured GitHub account/remote |
| Verification | Explicit required check rows, artifacts and candidate identities | Real checks and a statement of what each proves |
| Authority | Separate approval, pause, stop, abort, resume and merge decision | Trusted operator account and any stronger deployment isolation |
| Resources | Host resource leases and project flow limits | One shared coordinator location before concurrent heavy work |
| Operations | Jobs/schedules, notifications, backup/restore, retention and upgrade helpers | Cadence, destinations, preservation inventory and recovery ownership |
| Optional extensions | Release/evaluation contracts and fictional labs | Actual deployment, saved-data invariants, journeys and independent evidence |

The core does not infer a project's business acceptance, replace its test suite, or discover all relevant governance automatically. Commands are trusted configuration, not task-provided executable strings. Unsupported integrations stay disabled.

## Task-to-delivery commissioning

Use the [running guide](running.md) for exact commands. A GitHub issue supplies a fenced `factotum-task` version-1 JSON brief; see the [GitHub guide](integrations/github.md). Import it, approve the returned canonical revision, then start with `{taskId,revision}`. Every direct/queued admission checks current canonical authority; the source effect also checks the remote brief and current verified target before planning.

The code-owned graph prepares a reviewed plan, creates an owned worktree, invokes the builder, commits/integrates/publishes, obtains fresh independent review and runs all configured checks. Required input changes invalidate readiness. A manual question authorizes the exact candidate before merge. Cleanup follows proven delivery and retains separate failure/obligation state rather than replaying merge.

Task risk defaults to strict when unspecified. Planner and reviewer escalation persists through corrections and cached plans. Strict merge or already-satisfied acceptance requires a full candidate review with threat model and stop conditions, followed by an exact-head operator acknowledgement; see [risk review](risk-review.md). Builder and reviewer may share a model family; each review records the actual builder and reviewer provider, model and family, and marks a same-family pairing. Requested permissions and actual provider enforcement are separate evidence. The same-account trust model still applies: worktrees, prompts and role names do not isolate hostile code from the operator's credentials.

Two explicit completion alternatives are available:

- **Existing PR:** `flow.start` accepts `candidate:{number,head,base}` alongside task ID and revision. It validates that approved PR, copies its exact commit into an owned branch and delivers a replacement PR. The original's branch is untouched and its disposition remains a pending operator obligation. The original builder is unknown; the implemented adoption path always requires manual adjudication: the merge question is answered by the operator only, never by the orchestrator, even on a recorded instruction. In detail:
  - **What `head` and `base` are.** `head` is the pull request's head commit as you approved it (`gh pr view <n> --json headRefOid`). `base` is the target commit you approved it against: any commit in the target branch's history, typically the target's head when you read the pull request (`git ls-remote origin refs/heads/<target>`, or GitHub's `baseRefOid`). From dev.83 the `candidate` step checks `base` with Git, after fetching the target from the configured remote: it must equal the target's current head or be one of its ancestors, shown through hash-verified parents from the fetched target commit. A project checkout with replace refs or a grafts file is refused (they would let Git show an unrelated commit as target history); in a shallow clone a base below the clone's boundary cannot be shown and is refused until `git fetch --unshallow`. It is no longer compared with GitHub's `base.sha`, which GitHub refreshes only some time after the author pushes and which lagged behind the target by several seconds after a force-push. An older `base` is safe: the flow integrates the current target and reviews and gates the result. A `base` that is not on the target (a commit from another branch, or one the target lost in a force-push) is refused.
  - **Private refs.** The step fetches the pull request's head and the target into two refs of the project checkout, `refs/factotum/adoptions/<key>-<attempt>` and `refs/factotum/adoption-targets/<key>-<attempt>`, a pair of its own for every attempt (earlier releases used one pair per flow, without `-<attempt>`). From dev.83 the operations loop deletes them once the flow has ended and its workspace, if it had one, has been released, and only while each still points at the commit it was set to. A ref that cannot be read is kept and retried; the loop handles a bounded batch of ended flows per tick and never waits on Git for long. Refs left by earlier releases stay until removed by hand (`git for-each-ref refs/factotum/adoptions refs/factotum/adoption-targets`, then `git update-ref -d <ref>` for flows that have ended).
  - **A candidate that does not match stops at `candidate` and says why.** Before anything is integrated, published or reviewed, the step compares the approval with the pull request: open and not a draft, its head, the branch it targets, and `base` as above. Each mismatch is named in the stop notice with what was approved, what was found and the fix (for example "head: approved 1a2b…, found 3c4d…; review the new head, then `flow.abandon` and `flow.start` with `candidate.head` 3c4d…"). The flow is stopped, not failed: a transient mismatch (a draft marked ready, a head GitHub had not yet updated) can be resumed. Releases before dev.83 failed the flow with "Change workflow failed; inspect retained attempt evidence".
  - **Closing keywords are checked first.** Before anything is integrated, published or reviewed, the `candidate` step checks every commit of the PR with the rule the merge step applies (a GitHub closing reference such as `Fixes #11` in a commit message, at most 250 commits). The factory cannot reword an outside commit, so a violation stops the flow at `candidate` with a notice naming the commit and keyword and the plain reference to use instead (`Refs #28` for `Fixes #28`): ask the author to reword it with a plain reference and push, or re-create the commit yourself, then `flow.abandon` and `flow.start` with the new head. A PR with more than 250 commits stops the same way.
  - **The approved head is pinned.** Commits pushed to the original PR after `flow.start` are not delivered. The step that leads into the merge question reads the original PR and the question says whether it moved and which commits are not included (or that it could not check). The merge step reads it again; when it moved, or could not be read, the completion notice lists what was not delivered.
  - **The original author is told.** When the replacement PR is published, the factory comments once on the original PR with a link to the replacement and a neutral explanation (no mentions; `repository.adoptionNotice: false` turns it off; a failed comment is recorded on the publish result and does not stop delivery). The replacement PR's body names and links the original PR and its author, with the mention broken so nobody is notified.
  - **The `original-pr` obligation.** It tells the operator not to close the original PR without handling commits pushed after adoption. After merge it resolves by itself when GitHub already shows the original PR merged or closed and nothing was pushed after adoption; otherwise it stays pending with the commits that were not delivered. GitHub can take a moment to mark the original merged, so a merge that just happened may still leave it pending.
  - **Squash is not a way around closing keywords.** With `repository.mergeMethod: "squash"` the outside commit messages would not reach the target, but the merge step checks commit messages for every merge method and adoption follows it; the rule is unchanged.
- **Already satisfied:** `alreadySatisfied:true` starts fresh review and verification of the current target, requires operator acceptance, then checks that the remote target still matches. It records a proven accepted outcome instead of inventing a merge receipt. A normal no-change builder does not silently select this path.

Conflicted integration retains both versions and asks for explicit resolution/commit in the owned worktree. The factory never resets away conflicts. Missing workspaces fail closed rather than redirecting builders into the main checkout.

## Forge correctness and cleanup

GitHub publications carry stable operation/input markers. Ambiguous publication/merge responses are reconciled by querying the existing resource; the caller's durable dispatch owns retry decisions. Marker lookup is not an atomic lock across competing independent writers.

The expected-head merge guard protects the PR branch. An ordinary local target read leaves a race before merge. Keep auto-merge disabled until a disposable exercise proves remote strict checks reject a candidate when another actor advances the target after the final read. Live protection must require the gate context, strict up-to-date behavior and administrator enforcement. Merge-queue qualification is not implemented.

Closing-reference checks reject implicit issue closure in PR prose, merge messages and candidate commits. Source closure is a separate configured disposition and rereads the approved issue revision. GitHub provides no atomic issue-revision comparison for that state update; a remaining read/write race must be understood. Trusted users can also create links/actions directly through GitHub's sidebar; local enforcement does not control those actions.

Owned cleanup requires a verified merge ancestor or retained verified Git bundle. Dirty work, open PRs, active leases and unresolved effects prevent automatic deletion. Supply current canonical obligations; a workspace helper cannot independently infer provider liveness. Retention starts with a dry-run manifest and requires a reviewed preservation inventory. Failed reference discovery cannot authorize deletion.

## One shared console

Start one console and register each project's local socket. Every project retains its own service, state, credentials, policy and authority. The registry verifies identity/protocol compatibility and keeps its connection material outside Git. Removing an entry changes visibility only; it does not cancel or delete project work.

Project/resource identity and original command ID remain attached to pending commands when the browser changes selection. Unknown outcomes reconcile against canonical receipts. One unavailable project must not block another. The console is loopback-only under the trusted local account; it is not public authentication. Remote project transport remains deferred. See the [shared console contract](web-console.md).

## Context and operational extensions

Configure complete governance files with stable IDs, path applicability and required/optional status. Digests detect changed content under the same ID. Required files receive priority; missing or oversized required authority fails closed instead of truncating silently. Context is retained as explicit evidence, not private agent memory.

Configure main verification, queue dispatch, bounded audits, factual retrospectives, notifications, backup/restore and optional retention/upgrade jobs separately. Scheduling grants operational authority; disabling a schedule revokes that grant. Keep one schedule owner, and use the shared resource coordinator before concurrent heavy work. Read/acknowledgment of a notification never answers its question.

The release/evaluation contracts include local fictional examples, durable intent/reconciliation and retained observations. Production deployment and migration semantics remain adopter work. Paid observations are disabled. Monetary accounting helpers are not a hard provider billing ceiling, so they do not enable metered routes.

Upgrades require drained work or explicit abandonment, reconciliation, compatible schema/config declarations and immutable executor installation. There is no automatic database migration or rolling executor replacement. Preserve the original copied code and verified backups for recovery.

## Reporting problems and the blocking lane

Adopters report Factotum problems with `project/UPSTREAM_FEEDBACK.template.md`. A report marked **Blocking** — the problem stops the project's delivery and no project-side workaround keeps work moving — goes ahead of Factotum's other work. The adopting project's orchestrator or the operator may mark a report blocking; the operator may mark or downgrade any report. Maintainers start triage in the same session and reply to the adopter with what is happening; work already being built finishes its current step, and the next free work slot goes to the blocking report until a fix or a documented workaround is available. Everything else is ordered as usual. Fixes ship through a normal reviewed release announced to every adopter.

## Reporting triage proxy counts

Projects that run a [triage proxy thread](integrations/t3.md#triage-proxy-thread-recommended) in front of their orchestrator, please report what it did, so the starter rules can be tuned from real use. After the first two weeks, and then whenever a rule changes, send a short upstream message (the same channel as other feedback, `project/UPSTREAM_FEEDBACK.template.md` for anything that needs a fix) with:

- the output of `triage.mjs --counts --since <start>`: forwarded, absorbed, unsure, missed, timer runs and the count per rule;
- the `notifications.level` in use, and whether the clean-completion rule is on;
- each missed entry's note (what the orchestrator needed and the proxy absorbed), and which rule absorbed it;
- any rule the project added, or any "absorb on judgement" case it listed.

Leave out titles, IDs, thread links and anything else that identifies the project or its work.

## Adoption evidence

Run deterministic and systemd evaluations in disposable copies before live work. The two fictional stacks expose assumptions about setup, checks, state and context. Deliberate live qualification uses private repositories and subscription providers; it retains real identities and traces only in external private state. The [live harness](../evals/LIVE.md) includes a controlled defect explicitly labeled as fault injection and verifies fresh review plus persistent builder correction.

Do not claim support from a green summary alone. Review the [qualification record](qualification.md), exercise the project's own checks and recovery, inspect its first candidate and manual merge, then deliberately enable only the automation that has been qualified for that installation.

## Optional model coauthor attribution

Git keeps the repository's configured directing-human author identity. To add a model coauthor trailer to factory-created implementation commits, configure:

```json
{
  "workspace": {
    "modelCoauthor": {
      "name": "{provider} {model}",
      "email": "model@example.invalid"
    }
  }
}
```

Supply the attribution address appropriate to your project. The name supports only the `{provider}` and `{model}` placeholders and renders the actual builder receipt, including an approved fallback route. Newlines and malformed addresses are rejected. The setting is optional; there is no invented default identity. Existing adopted commits are preserved unchanged, and Git-generated target integration commits retain their normal Git attribution.

See [operator communication](communication.md) for presence and standalone inbox notices/questions. Those messages record communication without granting work or spending authority.
