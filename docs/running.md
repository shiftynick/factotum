# Running Factotum

Factotum supports deterministic rehearsals and configured GitHub delivery using subscription-backed Codex and Claude CLIs. It provides durable SQLite state/events, isolated development worktrees, bounded planning/build/review rounds, commit/tree-bound gates, operator merge decisions, operational schedules, and one shared local console. Fictional evaluation projects exercise adoption without adding product assumptions to the factory.

## Requirements and compatibility

Use Linux, Node.js 24 or newer with `node:sqlite`, Git, and Python 3. There are no npm or Python dependencies to install. The implementation targets the [built-in Node SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html). The checked host versions and exercised backends are in [compatibility.json](../starter/compatibility.json); this is a tested record rather than a claim that every runtime combination has been qualified.

Normal project initialization selects systemd user transient units. `systemd-run --user` must be available and the user service manager working. The evaluation defaults to an explicit process backend so it can run without a service manager. That backend checks process identity and drains inherited process-group descendants; it does not contain a process that deliberately escapes its group. Same-account processes remain within the trusted boundary.

## Repository fingerprints and nested worktrees

Repository identity binds the checkout's HEAD and Git's tracked/nonignored untracked file inventory. Regular files contribute their contents and mode; symlinks contribute their link text and mode, without reading their targets; tracked deletions remain represented.

Git lists an untracked nested repository or linked worktree as a directory entry rather than listing its files. From dev.71, Factotum fingerprints that entry's path, mode and directory type without descending into it or reading its HEAD. Work inside an unrelated nested agent checkout therefore does not become part of the parent checkout's fingerprint. Adding, removing or changing the mode of the directory itself changes the fingerprint. This applies to any directory name, including `.claude/worktrees/`.

An ignore rule such as `.claude/worktrees/` in the project's `.git/info/exclude` remains a valid local choice when even those temporary directory entries should be outside the parent inventory. Ignoring them is no longer necessary to prevent `EISDIR`. Nested contents are not qualified parent inputs; checks that depend on another repository need an explicit integration contract. Populated tracked submodules/gitlinks and tracked files replaced by directories remain unsupported and fail with their repository-relative path, rather than silently omitting tracked contents. Special filesystem entries also fail before a file read. Inspection failures retain their error code and name the affected path in the stop notice, including when preparation stopped before any attempt or receipt existed.

### Open questions and the candidate

A flow waiting on its own open question costs nothing until something it depends on may have changed. The engine does not step it, start a Git process, read the checkout or write to the database on each 75 ms tick. It steps the flow again at the next tick after any of these:

- any write to the project's database (a command from any actor or process, a stop, resume or replan, another flow's progress). The question is checked against the store exactly as before, using the candidate identity already established;
- the question's expiry time;
- a change to Git's own metadata for the candidate checkout (HEAD, HEAD's reflog or the index: a commit, checkout, reset, rebase, stash or staging). The checkout is fingerprinted again at the next tick, but not sooner than ten times the duration of its last fingerprint, so on a large checkout detection can take a second or more;
- an answer refused with `question subject changed`. The checkout is fingerprinted again, so the flow stops at the next tick, as it always did;
- the revalidation interval: 60 seconds since the checkout was last fingerprinted, or 100 times the duration of that fingerprint if that is longer.

So an edit to a working-tree file that Git has not been told about, with no answer attempted, is found within the revalidation interval rather than within one tick. Until then the question stays open. It cannot be answered: the `answer` command fingerprints the candidate itself and refuses a changed subject, and that refusal stops the flow at the next tick. Questions parked on the same checkout share one fingerprint. The fingerprint runs on a worker thread and outside any database transaction, so a large checkout neither delays the project socket nor locks out commands from other processes. This state is held in memory; a restarted service validates every open question on its first tick.

### Plan questions

From dev.83 a planner (and a builder) separates questions it cannot go on without (`questions`) from questions whose answer would not change its work (`assumptions`, each with the answer it assumed). A ready plan whose only questions are assumptions does not stop: it goes to plan review, the plan reviewer checks the assumptions, and they are listed on the merge question (its `carriedQuestions` field, which the console shows as its own card) and in the completion notice. A later answer to exactly the same question (only leading and trailing whitespace is ignored) replaces the earlier one, which stays as history and is shown as changed. At most 20 are carried; if a plan or build goes ahead on more, the flow stops for you (resume goes on with the list marked incomplete; `flow.replan` with a note asks for fewer), and a `proceed` that could not carry its questions is refused. `flow.replan` archives the carried questions on the flow (`carriedArchive`). The same holds for an implemented build with only assumptions: it goes on to checks and review.

When the planner is blocked, marks its plan ready but still lists questions, or (strict work) has an incomplete threat model or stop conditions, the flow stops at its plan question. The inbox item lists the planner's questions, the plan summary, its proposed options and any risk escalation in `context` (structured in `planQuestion`), with labelled `choices`:

- `replan` ("Replan with my answers"): answer with a note that answers the questions. The planner plans again with it. The first three such replans of a plan cycle do not use one of the plan step's attempts; later ones do, and at the plan bound the answer is refused (use `flow.replan` or `stop`).
- `proceed` ("Proceed with this plan"): offered only for a plan the planner marked ready whose only obstacle is its own questions (and, for strict work, with a complete threat model and stop conditions). The plan goes to plan review as it is; a note reaches the plan reviewer and builder. Refused if the candidate, task, risk or plan changed since the item opened.
- `stop`.

Don't edit the task to answer: a task edit revokes its approval and stops the flow. The reference graph allows three plan attempts per cycle. After a `replan` answer or a plan review revision, the planner is given its previous plan with its questions numbered as you saw them, so a note such as "1: yes; 2 and 3: your assumptions are fine" is understood. See [plan questions](project-workflows.md#plan-questions).

### Build questions

When the builder is blocked, or reports the work implemented but lists questions it cannot settle on its own, the flow stops at its build question. A Codex build blocked by its own sandbox says so ([Codex builders and the sandbox](#codex-builders-and-the-sandbox)). From dev.83 the item lists the builder's questions, what it did, the answers it assumed for other questions, its departures from the plan and the acceptance it could not verify (structured in `buildQuestion`), with labelled `choices`: `retry` ("Answer and continue the build": the builder continues in its session with your note) and `stop`.

**The builder ran out of turns** (dev.84). Claude ends a run that reaches its turn limit with `error_max_turns`. The build does not stop the flow or go uncertain: it is a build question that says so, with the turn count, the limit, the reported cost and where its output is (`attempts/<id>/provider/stdout.jsonl`). Nothing was committed, its edits so far stay in the worktree, and the reviewed plan is kept. `retry` ("Retry the build") resumes the same builder session on those edits, with the same reviewed plan and a fresh budget of turns; a note is optional. `stop` ends the flow. The limit is `providers.builder.maxTurns`, or `stepModels.<workflow>.<step>.maxTurns` for one step (default 60 for builds, 16 for planners and reviewers; see [provider turn limits](integrations/providers.md#permissions-and-process-ownership)); a flow keeps the limits it was admitted with, so a raised limit applies to flows started after the change. A planner or reviewer that runs out of turns is read-only: its attempt is settled as failed (`classification: "turn-limit"`), the flow stops at that same step with a notice naming the cause, and `resume` runs the step again.

## Run the qualification paths

From this directory:

```sh
npm test
npm run eval
node evals/run.mjs --systemd
```

`npm test` (`tests/run.mjs`) runs the suite in its own transient systemd user service when `systemd-run --user` works, so that a host which kills processes in the shell's process tree (seen from agent sessions) cannot reach it; elsewhere, or with `FACTOTUM_TEST_DIRECT=1`, it runs as a child process. See [changes/test-suite-external-kills.md](changes/test-suite-external-kills.md).

Tests use real temporary SQLite databases and supervised processes. They exercise controller SIGKILL/restart, one-time settlement, missing receipts, stop/revocation, stale decisions, evidence identity, safe restore, protocol compatibility and console recovery. Each creates its own disposable project and state.

The evaluation installs the entire starter into two independent temporary Git repositories: a JavaScript task persistence module and a Python task CLI. It proves the baseline passes, the requested feature initially fails, and the feature passes after the synthetic implementation. Both projects deliberately share local task/flow IDs and use different project identities. Their final answers travel through the shared console and remain scoped to one project.

`--keep` retains the projects, databases, intents, logs and receipts and reports their paths. Default successful runs clean up their temporary files. Runs with unsettled effects retain recovery evidence. Everything generated stays outside this reference directory.

## Explore the shared interface

```sh
npm run demo
```

Open the printed loopback URL. Both projects wait for an operator decision; accepting one leaves the other pending. The console's Overview, Inbox, Timeline, Tasks, Queue, History, Stats, Health, Settings and Receipts views are described in the [console guide](../starter/factory/console/README.md). `node evals/run.mjs --serve --ui-demo` adds clearly fictional data for exercising those views: a completed, a failed and a stopped flow, a rejected receipt, an unavailable project, an endpoint whose command response is lost, and an uncommissioned delivery configuration. Records the rehearsal cannot produce (audit finding, plan cache, notification, obligation, regression report, main-health checks) carry an illustrative note. Ctrl+C closes the console and project services and retains the demo's files for inspection. Project services can subsequently be restarted against those state directories. A console restart alone does not own or cancel project work.

The browser uses a local session and request token; reload after restarting the console. Registering a different project endpoint generates a new binding. Unknown command outcomes are reconciled through their original canonical receipt; the console never automatically resubmits an unconfirmed request.

## Project and console commands

The starter can be copied into a project without the reference's root package file. All runtime entry points are `.mjs` and use Node built-ins. The examples assume an installation at the repository root; a project installed under a folder (`adopt install --prefix tools/factotum`, recorded in `factotum.lock.json`) runs `node tools/factotum/factory/cli.mjs` instead. See [install under a folder](updates.md#install-under-a-folder).

```sh
node factory/cli.mjs init --root /absolute/project --state /private/project-state \
  --name "Example project" --workflow project/workflow.json --supervisor systemd
node factory/cli.mjs serve --state /private/project-state --socket /private/project-state/project.sock
```

Configure the trusted workflow before initialization. [workflow.template.json](../starter/project/workflow.template.json) intentionally contains commands that must be replaced; it cannot silently pass verification. With them replaced it passes `init` as it is: its review and gate steps record the namespaced observations `rehearsal:review` and `rehearsal:gate`, which its decision requires (a trusted command cannot claim the kernel's own `review` or `gate` evidence; releases before dev.83 shipped a template that `init` refused for this reason). Workflow code is trusted installation configuration. For deterministic rehearsals use the trusted workflow configuration above. Delivery mode selects the code-owned development workflow from a project configuration; doctor must qualify the installed provider capabilities, subscription authentication, repository permissions, and main baseline before work can start.

In another terminal, create the fictional task payload and approve its returned revision:

```sh
node factory/cli.mjs command --actor operator --state /private/project-state --operation task.put --file project/task.example.json
node factory/cli.mjs command --actor operator --state /private/project-state --operation task.approve \
  --payload '{"taskId":"feature-1","revision":"COPY_RETURNED_REVISION"}'
node factory/cli.mjs command --actor operator --state /private/project-state --operation flow.start \
  --payload '{"taskId":"feature-1"}'
node factory/cli.mjs status --state /private/project-state --task feature-1
```

To share one console across existing local project services:

```sh
node factory/cli.mjs register --state /private/console-state --socket /private/project-state/project.sock
node factory/cli.mjs console --state /private/console-state --port 0
```

State directories must be outside project checkouts. Use private short socket paths: Linux Unix-socket path lengths are limited. Generate project identity once at initialization; paths and display names are not identity. Do not run a restored copy alongside the live original with the same project ID.

Use `--id` to retain a CLI command's identity when an outcome is uncertain. Command history appears in `status`; repeating a command ID with different content is rejected. Direct CLI operations and the web interface use the same canonical validation. Actor names provide attribution and role validation under the local-account trust model, not separate OS authentication.

## Persistent services

`launch`, `serve` and `console` run in the foreground. To keep them running across logouts and reboots, install `systemd --user` units:

```sh
node factory/cli.mjs service install project --state /private/state/project [--install /private/installs/project]
node factory/cli.mjs service install console --state /private/state/console --port 8787
loginctl enable-linger "$USER"   # once per host, so user units start at boot without a login session
```

- The project unit runs this checkout's `factory/cli.mjs` (under the install prefix recorded in `factotum.lock.json`, if any), so it follows `adopt` updates. With `--install` it runs `launch`, which resolves the active verified installation at every start; without it, it runs `serve` directly. The console unit runs the CLI you invoked `service install` with.
- Units restart on failure. They record the `PATH` at install time, minus temporary directories, so `node`, `git`, `gh` and the provider CLIs resolve as they do in your shell. Reinstall after moving those tools.
- Each attempt runs in its own transient unit (`systemd-run --user`, named `factotum-<project prefix>-<attempt>`). The user manager starts that unit with its own environment, not the project service's, so from dev.104 the service records its `PATH`, `HOME` and the account and session variables a supervisor passes on (`USER`, `LOGNAME`, `SHELL`, `XDG_RUNTIME_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `DBUS_SESSION_BUS_ADDRESS`, `SSH_AUTH_SOCK`, when it has them) in the attempt's intent, under its digest. The supervisor gives the attempt exactly those values and nothing from the unit's own environment. Checks still get only `PATH` and `HOME` from them (with a fixed `LANG` and the `FACTOTUM_*` variables); providers get their usual subset. A synthetic attempt records `PATH` only. So a service unit whose `Environment=PATH=` (or a drop-in for it) puts a pinned toolchain first is what checks and builders run, whatever the user manager's `PATH` is; a drop-in that set `PATH` for the attempt units as a workaround is no longer needed. The `process` supervisor starts attempts from the service process, which already passed the service's environment; it now uses the recorded values too.
- From dev.105 the running project service checks this itself, with its own environment, which is exactly what its engine records in each intent. It does so in the background right after it starts serving, and again after the configuration digest changes; it never delays startup or a tick. It starts one short transient unit (`systemd-run --user --wait`, named `factotum-<project prefix>-env-probe-<id>`, with `RuntimeMaxSec` shorter than the service's 30 s wait and without `--pipe`) that builds its environment as a supervisor does from an intent recording the service's environment, and writes what `node` and `git` resolve to into a private directory in the state directory, which is removed afterwards. No provider, check or Git process is started. A probe that fails or times out is stopped by its exact unit name (`systemctl --user stop <unit>`), and the service stops waiting at its own deadline even if the `systemd-run` client does not return; a service that stops meanwhile waits for it at most 2 s and records nothing. Under the `process` supervisor there is nothing to probe (attempts are started from the service process with its environment): the result is `not-applicable`, with no warning.
- The result is recorded in project state (meta `attemptEnvironmentCheck`): `status` (`same`, `differs`, `unverified` or `not-applicable`), the `node` and `git` paths for the service, the attempt unit and the user manager's own `PATH`, `checkedAt`, what started it (`start` or `configuration`), the executor digest of the service code it ran under and the configuration digest; each check is an `attempt-environment.checked` event. `status` shows it as `health.attemptEnvironment`, and the console's Overview shows a difference (and an unverified check) as an attention item.
- **A difference holds admission.** While the latest result is `differs` (compared by real path), no new task flow is admitted: every queued task carries the reason, queue status has an `attempt-environment` hold, and `flow.start` is refused with it. Running flows are not stopped. The reason names both paths and the remedy (remove the drop-in for the attempt units that hides or replaces `PATH`, then restart the project service). The hold lifts when a later check finds no difference, at the next start or configuration change. A service `PATH` with no `node` or `git`, and a probe that fails or times out, are recorded as `unverified` with a warning, never as `same`, and do not hold admission.
- **Doctor reads the recorded result and starts no unit.** When it was recorded under the code doctor runs: `differs` is a blocking reason, `unverified` its warnings, `same` and `not-applicable` nothing. When the service has not checked this code yet, for example during `upgrade apply`, which stops the service before doctor runs, doctor reports the comparison as unverified with the warning that the project service checks it when it next starts. Nothing is refused for it. After the upgrade restarts the service, its check decides, and a difference holds admission as above. The commissioning record's `attemptEnvironment` keeps what doctor read.
- An existing unit with different content is refused unless you pass `--replace`. `--no-start` writes and enables the unit without starting it.
- `service uninstall project|console` stops, disables and removes only units written by `service install`.
- Doctor reports an installed project unit that no longer points at this state directory or checkout.
- The tool never runs `loginctl enable-linger`; that is a host-level choice.

## Pin the GitHub CLI

Every GitHub call runs `gh`. If `gh` on the service's PATH is a version-manager shim or a wrapper script, the shim can do its own work (resolve or upgrade versions, fork helpers) before running gh. That can leave processes the supervisor must terminate. Pin the real binary:

```json
"repository": {"ghPath": "/absolute/path/to/the/gh/binary"}
```

Doctor reports which gh it would use (`gh.path` and `gh.realPath`). With `ghPath` set, it fails unless that path is an executable ELF binary. Without it, it warns when PATH resolves `gh` to a shim or script. Re-pin after upgrading gh if the path includes a version.

## Recovery and current boundaries

Stop and pause are separate: `pause` changes admissions, while `stop` fences one flow's progression. While paused, schedules and queued maintenance jobs are held too, except a scheduled `maintenance.backup`, which still runs; a held schedule that misses an occurrence raises a notice (see [schedules under a hold](operations.md#durable-schedules)). `stop.all` names one project's active flows and pauses admissions. `abort:true` requests owned-process cancellation. Late receipts still record outcomes/costs. `resume` requires a `note`, valid authority and resolved attempts; unpausing cannot restart a stopped flow.

**"has not settled, so the flow cannot resume yet".** `resume` is refused while the flow's last step still owns an attempt that has not settled. The refusal names the attempt, its step and flow, and says which of three cases it is (before dev.83 every case said only "attempt requires reconciliation before resume"):

- **Its process is still running.** `stop` without `abort: true` fences the flow but lets a running step finish. Nothing needs reconciling: run the same `resume` again once the step has finished, and its result is used, not run again. To end the step at once, stop the flow with `abort: true`, then resume (the step runs again).
- **Its process finished, but the runner has not recorded the result yet.** Resume again in a moment; if it persists, check that the project runner is running.
- **Its outcome is uncertain** (no live process and no valid receipt, for example after a crash). Inspect `attempts/<id>/` and any external effect, then settle it: for a forge publish, merge or task close, or an integration step, `reconcile --state <dir> --attempt <id> --note "…"` reads the remote outcome; otherwise `command --actor operator --state <dir> --operation attempt.resolve --payload '{"attemptId":"<id>","disposition":"failed","costMicros":0,"note":"…"}'` (`not-dispatched` when it never started; the actual cost). The refusal prints that command with the attempt's id and the project's paths. Then resume.

**Recovering from an uncertain model step.** Settling an attempt with `attempt.resolve` (either disposition) makes `resume` follow the step's failure route. In the reference graph that route ends the flow as failed for every model step, so the reviewed plan, its review and the plan comment's cost are not reused, and the task needs a new flow from planning (`task.restart`). The stop notice, the resume refusal and the resolve's own stop reason say so before you act ("Settling it (attempt.resolve, failed or not-dispatched) makes resume follow step build's failure route to failed: …"). Read the cause first: the stop notice names it (from dev.84 a Claude end names its subtype, turn count and reported cost, for example `error_during_execution after 5 turns`), and the provider's own output is in `attempts/<id>/provider/stdout.jsonl` (the last line is the final result). A provider that ran out of turns is no longer uncertain (see [build questions](#build-questions)); the other uncertain ends (a timeout, a lost process, malformed output) still need inspection, because the model may have changed the worktree or run commands before it ended.

**A failed trusted command says why.** When a trusted command (a workflow step with `argv`, as in a rehearsal) fails, its attempt records `failure`: how it ended (`exited with code 3`, `was stopped after its timeout`, `could not start (…)`), and the last lines of its standard error and standard output (at most 12 lines and 1,200 characters each, read from the end of each log, with terminal control sequences stripped, and every secret value the factory knows replaced with `[redacted]`, as in a recorded prompt: credential variables in its environment, secret-named configuration values and the notification delivery file's secrets, each also in its JSON-escaped, URL-encoded and base64 forms, plus credential-shaped text; see [what a model was told](#recovery-and-current-boundaries)). The summary is redacted the same way. The summary is also the attempt's `reason`. Summary and excerpts together become the attempt's notice, the same notice an action supplies for its own refusals (`notice`), and the failed flow's notice carries it, so it reads without the state directory: "Change workflow failed at <step>: …" for a change flow, "Failed at <step> (attempt <id>): …" for a rehearsal. `status --flow <id>` lists it on the attempt, and the console's attempt panel shows it under "Why the command failed". The complete logs stay in `attempts/<id>/stdout.log` and `stderr.log`.

**"no such function: factotum_attempt_intent_layout".** This is what a release before dev.82 prints for every write (a command, a tick, a settlement) on a state database that dev.82 or later converted (see [record layout of the state database](#record-layout-of-the-state-database)). Nothing was written, and reads still work. Run that newer release's CLI instead, or, to go back to the earlier release, run `layout inline` with the newer CLI first (runner stopped). The text cannot be made clearer from this side: SQLite resolves the fence's function when it prepares the write, so the older release fails on the missing function before the fence's own message (which names `layout inline`) can run. Giving the function a readable name would refuse dev.82 too, which reads and writes this layout.

Missing or contradictory evidence parks an attempt as uncertain and retains its reservation. There is no automatic replay based on zero cost. Inspect `attempts/<id>/intent.json`, `owner.json`, logs and `receipt.json` in the project's private state directory. The log and intent digests are verified before settlement. Updating core executor files while a flow is active stops it; drain work with its original copied executor before replacing those files.

**What a model was told.** Every planner, plan-review, build and review turn keeps the exact prompt it was given on stdin as `attempts/<id>/provider/prompt.txt` (a plan-review correction turn uses `provider-protocol-correction-1/`), next to the provider's `stdout.jsonl` and `stderr.txt`: written before the provider starts, in the 0700 attempt directory as a 0600 file, and kept, backed up and archived with the rest of the attempt. Before it is written, every secret value the factory knows is replaced with `[redacted]`: credential variables in its environment (GitHub and provider tokens), the scoped GitHub token, every string under a secret-named key in the configuration, and the notification delivery file's signing key, URL and other secret-named values, at any length. Each is matched exactly and also JSON-escaped, URL-encoded and in base64 (standard and URL-safe, with and without padding). Base64 is matched only as the encoding of the value on its own: a value split across lines (wrapped base64, for example), encoded as part of longer data (at any offset, since surrounding bytes change the encoding) or transformed otherwise is not caught. Exact matching over-redacts on purpose: a secret that is an ordinary word replaces every occurrence of that word. Credential-shaped text is replaced too (tokens, bearer and basic credentials, `password=`/`secret=`-style assignments, URL user information). This protects the file only: governing context is sent to the provider as it is, so a secret in a configured context file reaches the model. Keep secrets out of governing context. The action result records `promptDigest`, the SHA-256 of the prompt as sent; it equals `sha256sum prompt.txt` unless the result also has `promptRedacted: true`. The console's attempt evidence viewer shows it as `provider/prompt.txt`.

```sh
node factory/cli.mjs backup --state /private/project-state --out /private/new-backup
node factory/cli.mjs restore --from /private/new-backup --state /private/new-restored-state
```

Restore verifies artifact digests and stages the database with admission/dispatch held before publishing it. Inspect and reconcile every unresolved attempt using canonical `attempt.resolve`, then explicitly release the hold using `restore.release` with an evidence note. A backup taken during work may contain incomplete live logs; uncertainty stays held and is never interpreted as success. Releasing a hold leaves pause and stopped flows intact. A recovery hold is also placed when the runner faults or the operations loop hits a database fault that leaves the state in doubt; `status` shows its cause in `recoveryHoldReason`, and [operations](operations.md#recovery-hold-and-operations-faults) gives the recovery. Other operations-loop errors, and any problem with the notification configuration file, never place a hold: they are shown under `health` in `status` and in the console, and clear by themselves.

Live qualification uses fictional private GitHub repositories and subscription-backed providers; see [the live harness guide](../evals/LIVE.md) for its exact process and retained evidence. Paid APIs and paid evaluations remain disabled. The optional [release/evaluation lab](extensions.md) demonstrates local project adapters; it is not a production deployment integration. Remote projects, database migrations, and rolling upgrades remain outside the first reference. Routine service snapshots carry compact dashboard summaries; historical execution bodies remain in the detail/history endpoints. CLI `status` retains its fuller diagnostic projection. See [console snapshot semantics](web-console.md#dashboard-snapshots).

**Reading state: prefer a narrow read.** `status` without options prints the whole projection: by default the latest 100 tasks, flows, inbox items, attempts, deliveries, events and commands, plus settings, statistics and the other views. It reached about 1.6 MB after a dozen flows in a trial and grows with the project. Agents, and anyone reading state often, should use a narrow read instead:

- `status --inbox <id>`, `--flow <id>`, `--task <id>` (any together) print that inbox item, its flow and its task (the flow defaults to the item's, the task to the flow's or a notice's) with every project hold and its cause (pause, recovery hold and reason, retention, spending, provider holds, doctor, main health, queue holds), operations and notification health, recent faults, a one-line summary of every open inbox item, the flow's risk, workspace and per-step evidence (route, attempt, head, review verdict and findings, check results, merge and cleanup), its last five attempts, the task with its acceptance criteria, per-task model choice (`models`, set by `task.models`), schedule time (`notBefore`, set by `task.schedule`) and admission reasons, and its queue row. It also says who holds the flow slots: `project.capacity` (per pool: in use, free, parked, waiting; each parked flow and each answered flow waiting for a slot), and on the flow `parked` and, for a flow waiting for a slot, `slotWait {position, reason}` ([flow slots](operations.md#flow-slots-and-parked-flows)). A failed flow has `failure {step, attemptId, notice}` when its failing step said why (dev.90): for example a governing file the task was not approved to change, with the two remedies; each of the last five attempts carries its own `notice` when it has one. For a merged change flow it also has `upkeepRun`, the flow's [knowledge upkeep](operations.md) run as recorded (status, outcome, reason, stage, flags and counts; also for an upkeep assessment flow, by the flow it assesses), read by key; `null` when there is none (dev.88). The output has `stateView: "item-v1"` and the same fields as the starter's state filter. It reads records by key and never loads every attempt.
- `status --compact` prints the dashboard snapshot the project service serves the console (`snapshotView: "dashboard-v1"`): recent and open records only, with credentials and private paths removed. From dev.85 it is one line of JSON, and queue entries that left the queue and resolved inbox items carry only what the console shows for them. It still grows with the project (about 136 KB on the readiness trial's project after a day): pipe it to a program or write it to a file and query it with `jq`, rather than printing it into an agent's conversation.

Releases before dev.82 have only the full read; filter it with the starter's `project/integrations/factotum-state.example.jq` (`status | jq -f …`), which produces the same shape.


## Configure and commission delivery

Use the project configuration template and supply real repository/account, explicit role models, governing context, required branch checks, and `mainChecks` for baseline main verification. Each check has `{id,argv:[...],timeoutMs}`. Optional `workspace.setup` commands, which run in every new factory workspace, are each stopped after `workspace.setupTimeoutMs` (from dev.85; default 30 minutes, at most 4 hours), and a setup stopped that way fails like one that exited nonzero. Checks run one after another, and a `main.verify` step may run for the sum of their `timeoutMs`, plus the setup commands' limit (`workspace.setup` count × `workspace.setupTimeoutMs`), plus 3 minutes, at most one hour; configuration validation refuses checks that add up to more than 57 minutes, and `timeouts["main.verify"]` overrides the derived limit (see [how long a main verification may run](operations.md#how-long-a-main-verification-may-run)). A check that reaches its `timeoutMs` fails the verification (red) with a notice naming the check and its limit. Configure a shared `resources.coordinatorPath` outside repositories for heavy work and keep live delivery on systemd supervision. `doctor` requires exclusive drained project ownership and holds the shared host resource while its bounded subprocess groups run. Before provider checks, it requires nonempty `user.name` and `user.email` from the same scoped Git environment used for commits; global/system identity and ambient author overrides do not satisfy this requirement. Set both with `git config --local`. It uses a disposable owned worktree to run main checks on the remote main head; it refuses a dirty project checkout or one with commits that are not on remote main.

**A check takes only PATH and HOME from the environment.** Gate checks (`checks`), fast checks (`fastChecks`) and main checks (`mainChecks`) do not inherit the service's environment. Each runs with `PATH` and `HOME` from the factory service, `LANG=C.UTF-8`, `PYTHONDONTWRITEBYTECODE=1` and the factory's own `FACTOTUM_*` variables (`FACTOTUM_TARGET` and `FACTOTUM_CHECK_KIND`; gate and fast checks also get `FACTOTUM_CHECK_DIAGNOSTICS`, `FACTOTUM_TASK_PATHS` and `FACTOTUM_TASK_PATHS_FILE`), and a check whose `argv[0]` is `git` also gets Git's isolation variables. Nothing else passes through: not `TMPDIR`, not `CI`, `NODE_OPTIONS` or proxy variables, and no credentials, whatever the service or your shell has set. A tool that looks for one of them falls back to its default; for scratch space that is usually `/tmp`, which may be a small or shared filesystem. A check that needs a variable sets it in its own `argv`, for example with `env`:

```json
{ "id": "test", "argv": ["env", "TMPDIR=/srv/scratch/myproject-checks", "npm", "test"], "timeoutMs": 600000 }
```

`env` does not create the directory: create it once on the host (on a disk with room), or set the variable inside the project's own check script instead. The same applies to any other variable a check needs, such as `CI=1`: write it into the `argv`.

The factory never updates the operator's checkout, so after every merge it is behind remote main. Doctor accepts a checkout that is only behind: it must be clean and its HEAD must be on remote main (an ancestor of it or equal to it). Doctor fetches the remote-tracking ref to compare them and never moves the checkout. When it is behind, doctor adds a warning saying by how many commits and naming changed files. It refuses the checkout in three cases:

- **Local work.** Commits that are not on remote main (`the local root has commits that are not on origin/main`). Do your own work in another worktree.
- **An older factory.** The commits it lacks change the installed `factory/` files or `factotum.lock.json`. The project service runs `factory/cli.mjs` from this checkout, so it would run an older factory than the one remote main records. With work drained, `git -C /absolute/project pull --ff-only`, restart the service if it runs, then doctor.

- **Older commands run from the checkout.** The commits it lacks change a file that the configuration runs as a command from the operator checkout, or a file under a directory it names. From dev.84 doctor classifies each configured command by where it runs:

  | Runs | Commands | When the checkout is behind on one of their files |
  | --- | --- | --- |
  | In a factory workspace created from the target (or from the candidate built on it) | gate checks (`checks`) and fast checks in the flow's worktree; main checks and scheduled tasks in an owned checkout of the target's remote head; `preview` on the candidate; `workspace.setup` in each new worktree | A warning with the count ("N changed file(s) are run by the configuration only in factory workspaces created from the target"): they run the target's current copy |
  | From the operator checkout | source adapters (`sourceSync.argv`), integration adapters and their implementation `files`, the retention preservation adapter, commands in project-owned workflow definitions, and any configuration section not listed above | Refused: they would run older code than the target records |

  A path written absolute, or starting with a variable or `~`, may point into the operator checkout whatever the section, so it counts as run from the checkout; a file named in both places counts as run from the checkout. Doctor reads every argument of every `argv` and `command` list, each `workspace.setup` command and the implementation `files` an integration adapter declares. It takes each argument whole (paths may contain spaces) and split into shell words the way `sh` would, honouring quotes and backslash escapes (so a script inside `sh -c "…"` or `--opt=path` counts), and treats a word with a slash or a file extension as a path. Inline interpreter code (`node -e`, `python -c` and similar) is not scanned, so a file such code reads is not found. It resolves paths against the repository root (every command runs in a checkout of it), normalising `.` and `..`, and ignores paths that leave the repository. A variable or `~` it cannot resolve fails safe: a leading one is dropped and the rest taken as a repository path, an inner one becomes a wildcard. Not found: files a command reads without naming them (a script's imports, `package.json` scripts behind `npm test`, a Makefile target), paths given only through environment variables, and extensionless names without a slash (`make`, `pytest`). Run `git -C /absolute/project pull --ff-only`, then doctor.

So a busy project's checkout, which falls further behind with every factory merge, no longer needs a pull before each `doctor` unless the merges changed the factory or a file run from the checkout. There is no `doctor --pull`: pull yourself (`git -C /absolute/project pull --ff-only`) when doctor asks, with work drained when `factory/` changed.

Being behind on anything else does not affect deliveries: they run in owned worktrees started from the remote target, and context, checks and reviews read the candidate. Doctor warns, naming up to five changed files. Pinned workflow definitions are warning-only: `config update` compiles them from the checkout, so fast-forward before `config update` when a merge changed one. Do not pull while flows run if a merge changed `factory/`: updating core executor files while a flow is active stops it.

```sh
node factory/cli.mjs init --root /absolute/project --state /private/project-state \
  --name "Example project" --config /private/config/example.factotum.json --supervisor systemd
node factory/cli.mjs doctor --state /private/project-state
node factory/cli.mjs import-task --actor operator --state /private/project-state --issue 12
node factory/cli.mjs command --actor operator --state /private/project-state --operation task.approve \
  --payload '{"taskId":"github:12","revision":"COPY_RETURNED_REVISION"}'
node factory/cli.mjs command --actor operator --state /private/project-state --operation flow.start \
  --payload '{"taskId":"github:12","revision":"COPY_RETURNED_REVISION"}'
```

Imports never approve work. A source issue change revokes the pinned brief's authority until reimport and reapproval. Re-run doctor after changing configuration, provider authentication, installed CLI capabilities, or main verification requirements. Automatic merge additionally requires enforced strict remote checks and explicit behavioral qualification; otherwise the operator merge decision records the remaining target race.

Configuration replacement is a canonical command and requires drained or explicitly abandoned work:

```sh
node factory/cli.mjs config update --actor operator --state /private/project-state \
  --config /private/config/example.factotum.json --note "Adopt reviewed project policy"
node factory/cli.mjs doctor --state /private/project-state
node factory/cli.mjs maintenance enqueue --actor operator --state /private/project-state \
  --operation main.verify --note "Verify the current main baseline"
```

A manual `main.verify` runs every main check. With [check tiers](operations.md#main-check-tiers-after-every-merge-or-scheduled-only), `--payload '{"tier":"merge"}'` runs only the checks that run after every merge.

Other scoped maintenance operations are `maintenance.backup`, `audit`, `retrospective`, `machine.sample`, `queue.dispatch` and, with `upkeep.mode` on, `knowledge.upkeep` for one merged flow (`--payload '{"flowId":"…"}'`; see [knowledge upkeep](operations.md#knowledge-upkeep)), and `learnings.check`, the read-only check that raises stale-learning candidates (see [learnings](operations.md#learnings); it can also be scheduled). Supply `--payload` or `--file` for a job payload. Configure `backupRoot` for scheduled backups. A retrospective payload can include `flowId`. Scheduling is an explicit operator grant via `schedule.put`; disabling the schedule revokes queued/in-flight scheduled authority. See [operational controls](operations.md) for interval, timezone, catch-up, notification, monetary, and resource contracts.

### Codex builders and the sandbox

A Codex builder runs the project's commands inside Codex's `workspace-write` sandbox. On some Linux hosts that sandbox refuses part of process handling. Checked on the dev.90 trial host with Codex 0.169.0 and Linux 7.2, offline with `codex sandbox` (no model):

- Its network filter denies `shutdown(2)` and `getsockopt(2)` even on a local socket pair, with `EPERM`.
- Node's `spawnSync`, `execSync` and `execFileSync` with a piped stdin call `shutdown` on that pipe, so they fail with `spawnSync <binary> EPERM` although the child process ran.
- Asynchronous `spawn`, and `spawnSync` with `stdio: 'inherit'` or `'ignore'`, work.
- A shell starting `node` works; `node` starting a child with a pipe does not.

So a test suite that starts the project's CLI with `execFileSync` fails in every Codex build of that project, while the factory's own checks (fast checks, gate, main verification), which run outside the sandbox, pass. Claude Code has no such sandbox.

What the factory does (dev.91):
- **Doctor** checks it offline when any builder route uses Codex. It runs one `codex sandbox -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=false -- node -e <spawnSync probe>` in an empty folder under the state directory's `doctor/` folder. If the child cannot be started, doctor adds a warning and records `codexSandbox: {spawn: "refused", error}`. It never blocks commissioning.
- **The Codex builder's prompt** says that its sandbox may refuse such calls, that the factory's checks decide, and that a command failing only for a sandbox reason is not a reason to return blocked: it finishes, returns implemented, and names the command and error in its summary.
- **A build that still comes back blocked** with `EPERM` or "operation not permitted" in the builder's own words gets a build question that says so (`buildQuestion.sandbox: "codex"`). It tells you how to spend no further build round on it: answer `retry` with a note to treat the failure as environmental, or stop and start the task again with the builder on Claude (`task.models`).

**Prefer a Claude builder** (`providers.builder`, or `task.models` for one task) for a project whose checks start processes, until a Codex release or setting on your host lifts the limit. Two settings were found that do let `spawnSync` work, and neither is used by the factory:
- `sandbox_workspace_write.network_access=true` lifts the whole network filter, so the builder's commands get outbound network. It is not a safe default.
- A permission profile (`default_permissions`, beta) with `network.enabled=true` and the experimental `network_proxy` feature, with no allowed domains, put commands in a network namespace where direct connections, DNS and UDP failed and the proxy refused every domain, while `spawnSync` worked. The docs say a profile must not be combined with `sandbox_mode` or `[sandbox_workspace_write]`, which the factory's isolation uses, and both features are pre-release. Adopting it would need its own isolation and qualification work; it is a [runtime follow-up](runtime-followups.md#codex-builders-a-sandbox-that-lets-node-start-child-processes-deferred-dev91).

### Builders and provider configuration

A task may change `.claude/`, `.codex/`, `.agents/` or `.mcp.json` content only when its `paths` declare it ([provider worktree isolation](changes/provider-worktree-isolation.md)). The builder's own CLI also limits what it will write, so the factory checks the declared paths against the builder's provider at admission (dev.91):
- **Claude Code** under `--restricted` lets only a person or a configured permission handler approve writes to tool-configuration files, and a factory step has neither. It refuses every write under a `.claude` folder (any depth, any letter case) and to `.mcp.json`, whatever the allow rules say (`--settings` allow rules were tried).
- **Codex** keeps `.codex/` and `.agents/` at the top of its writable root read-only.

A task that declares such a path for a builder that cannot write it is not admitted. `status --task`, the queue and `flow.start` give the reason: route this task's builder to the other provider (`task.models`), or make the change yourself. A task that needs both a `.claude/` and a top-level `.agents/` change cannot be built by either; split it.

### Provider probes in doctor

Doctor probes each role's provider, each configured fallback and each distinct step model with a read-only preflight: three CLI calls (`--version`, `--help`, and `login status` or `auth status`), each limited to 15 s. From dev.85 a probe that fails on a timeout or a transient process error (for example the CLI being killed for leaving processes behind, or a resource error while starting) is tried once more after 2 s. An auth problem, a missing CLI, an invalid result (a failing `--version`, or `--help` lacking a required flag) or a configuration problem (a model outside the allowlist, for example) is not retried.

A failed probe is recorded in the commissioning record's `providers[<role>]` entry (`providers["<workflow>.<step>"]` for a step model), with `provider`, `model`, `ready: false`, `phase` (`preflight`, or `fallback preflight` with the details under `fallback`), `failure` (`timeout`, `process-error`, `missing-cli`, `auth`, `invalid-result`, `configuration` or `error`), `call` (the CLI call that failed), `attempts`, `retried` and `error`: the error and the CLI's stderr, bounded to the last 12 lines and redacted with the known-secret set. The auth call's output (stdout and stderr) is never kept, on any path, including a timeout or a process error: it can name the account, its home directory or organization, which secret redaction does not remove. Only the failure kind and the exit status remain. The reason reads, for example, `planner provider preflight failed for codex/<model>: timed out during auth status, after one retry (codex CLI preflight failed before model launch: codex auth status timed out after 15 s)`. A probe that passed on its retry records `retry: { attempts: 2, firstFailure, firstError }`.

While it runs, `doctor` prints progress to stderr as `doctor: [<phase>] <detail>`: `probe of <role> (<provider>/<model>)` with the attempt, `forge check`, `checkout check`, `permit wait` (with the permit's holder, while it waits) and `main verification`. A doctor that seems stuck is in the last phase it printed. `upgrade apply` reads these lines to say where a doctor it ran stopped (see [updates: reading a failed doctor step](updates.md#guided-update-upgrade-apply)).

Every string doctor reports is redacted whole with the known secrets before it is printed or stored: the progress lines, the reasons and warnings, the `providers` entries (route, provider and model included) and the `project.doctor` event.

Processes the factory runs and stops are named by what they are: a timeout reads `<label> timed out after N s` (for example `factory CLI doctor timed out after 3900 s`, or `codex provider timed out after 600 s` for a model invocation), never a generic `Provider timeout`.

## Exclusive retention and upgrades

Stop the project runner, drain or explicitly abandon flows, reconcile uncertain attempts, and resolve obligations first. The CLI acquires the same abstract Unix socket used by the live runner and retains it for the whole maintenance action, so a concurrent runner cannot start. Retention and upgrades refuse a live runner.

```sh
node factory/cli.mjs retention plan --state /private/project-state \
  --root /private/artifacts --file candidates.json --preservation preservation.json --out plan.json
node factory/cli.mjs retention apply --state /private/project-state \
  --file plan.json --preservation preservation.json --digest COPY_APPROVED_PLAN_DIGEST
node factory/cli.mjs upgrade stage --state /private/project-state \
  --source /private/reviewed-release --install /private/installed-factory \
  --version v1 --compatibility compatibility.json
node factory/cli.mjs upgrade activate --state /private/project-state \
  --version v1 --verify verification.json
node factory/cli.mjs launch --state /private/project-state --install /private/installed-factory
```

Candidates are a JSON array of paths under the artifact root. Preservation JSON is a reviewed complete inventory such as `{"complete":true,"protectedPaths":["retained-proof.json"],"evidence":"Inventory reference"}`; missing or failed preservation skips deletion. Only the approved manifest's unchanged ordinary files can be deleted. The apply command repeats preservation and state checks while holding exclusive runner ownership.

Compatibility JSON declares supported `schemaVersions`, `configVersions`, optional compatible `executorDigests`, and the default `requireDrain:true`. Verification JSON contains a bounded `{argv:[...],timeoutMs}` command run inside the installed version. A verifier that changes installation files fails activation. Stage a starter directory containing `factory/cli.mjs`: a release's `starter/` payload, or in a project installed under a prefix, that prefix folder (it has the same layout). Activation writes an atomic `current.json` pointer; `launch` validates that pointer and the complete immutable code tree before starting the selected version's service. Use `launch` in the project's runner service entry point. A launcher restart can recover existing work only with its original exact executor digest. It never rewrites running code or migrates a database. Preserve a backup and the previous immutable version for recovery.

## Record layout of the state database

A project's history stays in its state database, and an idle project must not pay for it. Two things in the layout of `records` see to that. Neither changes the schema version (it stays 1), the tables, or any public view.

- **Attempt intents are stored apart.** An attempt's dispatch intent (the complete input of the step, often tens of kilobytes) is a separate record with the attempt's id. Reading one attempt, and `store.all('attempt')`, still return it complete. Lists of attempts (the console, the queue status, flow detail, the timeline, statistics) read attempts without their intents.
- **Indexes for current work.** Unfinished flows, unsettled attempts, open inbox items, queued jobs and the like each have a partial index, and records can be looked up by the flow or task they belong to. The engine tick, the operations tick and the console's poll read these, not whole kinds. A kind is indexed, and read through SQL at all, only after the conversion has checked that none of its records gives a field twice in one object (SQLite would read the first, JavaScript the last); a kind that has such a record is listed by `layout status` as `unverifiedKinds` and read whole in JavaScript until that record is rewritten. Records Factotum writes never do.

**A state that stores intents separately cannot be written by an earlier release.** An earlier release reads an intent only inside its attempt; on this layout it would judge settled attempts uncertain and could not dispatch prepared ones. So the layout comes with a write fence: triggers on every table that SQLite compiles into each write, which succeed only on a connection of a release that reads this layout. An earlier release can still open the database and read it (what it concludes about attempts is wrong), but every write it attempts fails with `no such function: factotum_attempt_intent_layout`: no command, no tick, no settlement, no restore. Which layout a database is in is a property of the database: while the fence is absent, this release too writes attempts whole, exactly as an earlier release does.

A database written by an earlier release has its intents inline, no indexes and no fence. This release reads it correctly as it is. **The project service converts it when it starts**: it installs the fence, moves each inline intent to its own record and creates the indexes, and records `state.layout-migrated`. On a 268 MB state with 3,000 attempts this took 2.5 seconds. Intents are moved by cutting the record text, never by parsing and writing it back, so no byte of an intent or of the rest of an attempt changes; each attempt is checked before anything is written for it, and one that cannot be moved losslessly or whose intent gives a field twice (two `intent` fields, or two `operation` fields inside it, for example) is left as it is and reported: `layout status` lists it as `unmovable` and reports `current: false` while it remains. Such a record is still read correctly, the way `JSON.parse` reads it. The move runs in transactions of bounded size; it can be interrupted at any point and continues at the next start. If it fails, `state.layout-migration-failed` is recorded and the service runs on the earlier layout (correct, but with the earlier cost).

```sh
node factory/cli.mjs layout status --state /private/project-state    # read-only
node factory/cli.mjs layout migrate --state /private/project-state   # runner stopped; what the service does at start
node factory/cli.mjs layout inline --state /private/project-state    # runner stopped; back to the earlier layout, fence lifted
```

**Returning to an earlier release.** The state must be in the inline layout before an earlier release's code runs on it, and only this release's code can put it there.

- `upgrade apply` (with `--merge` or `--activate`) and `upgrade activate` do it themselves: when the release they move to does not declare `"separate-intents"` in the `recordLayouts` of its `compatibility.json`, they run the equivalent of `layout inline` with the runner stopped, before the backup, and report it as the step `layout`.
- By hand (a `git revert` of the adoption, an older checkout): drain, stop the runner and run `layout inline` with this release first. If the earlier code is already in place, it cannot write the state and has no `layout` command: put this release's code back (or use another checkout of it) to run `layout inline`, or restore a backup taken before the upgrade.
- The backup `upgrade apply` took when this release was adopted is in the earlier layout and needs nothing.

`layout inline` gives every attempt record that was not rewritten since its intent was moved its original text back, byte for byte. An attempt this release wrote or rewrote afterwards has no earlier text; it gets the text this release writes for an inline attempt, with the intent's bytes as stored. With the fence go this release's indexes and its record of which kinds were verified: the database is left with the earlier release's schema.

## Reconcile an existing external outcome

When an external write may have completed but its receipt was lost, stop progression and inspect the original uncertain attempt. For PR publication, merge, and source-task closure, use the read-only typed reconciler:

```sh
node factory/cli.mjs reconcile --state /private/project-state \
  --attempt COPY_UNCERTAIN_ATTEMPT_ID --note "Inspect the original remote operation"
```

The command proves the existing remote object's identity against the retained intent and records a reconciliation artifact. It never repeats a publication, merge, or closure. The owned supervisor and its descendants must already be quiescent. Missing or mismatched remote evidence leaves uncertainty held; unsupported outcomes require independent operator inspection. A successful reconciliation records the outcome while preserving stop/approval checks, so inspect `status` before explicitly resuming the flow.

Network Git fetch/push uses the configured repository and explicit GitHub account, independently of whichever account the user last selected globally. Credentials are scoped to the individual Git subprocess and do not enter provider environments or stored state. Remove repository-local transport overrides before commissioning; a mismatched remote or alternate credential/HTTP rewrite fails closed. See [operational controls](operations.md) for exact reconciliation and transport boundaries.

For bounded feedback jobs, enqueue `audit`, `retrospective`, or `machine.sample` with a concrete operator note. Audit findings remain unapproved and deduplicate by actual code evidence; `finding.accept`, `finding.resolve` and `finding.reopen` record a task against one, decline it or record it as dealt with, and reopen it (see [operational controls](operations.md#knowledge-upkeep)). A retrospective payload can name the completed `flowId` to project and persist. Linux machine samples retain only load, uptime, and memory aggregates. Rule challenges use canonical `rule.pushback` and carry a reason/evidence; recording a proposal never changes authority or policy. See [operational controls](operations.md) for exact commands and preplanning-window configuration.


## Continue a queue

Each change flow plans and reviews its plan before building (`policy.planning`, on by default); there is no separate planning ahead of admission. A project that wants planning as its own step can add it to its own workflow graphs and decide where the plan goes.

Set `policy.autoQueue:true` to admit eligible queue entries. While work is queued, the loop also checks whether main moved outside the factory (`git ls-remote` on the target) every `policy.mainProbeMs` (default 60000; at least 10000; `0` turns the check off) and, if it did, requests a main verification. While a merge question is open the target is read too, with or without `policy.autoQueue`, at most once every five minutes per target, so that question can say the target moved. A flow that starts just after such a push and finds main unverified at its source step requests the verification itself and waits for it; with `policy.autoQueue` off it stops there and names the verification to run. A proven merge invalidates main health and creates an explicitly configured post-merge `main.verify` job before another change may start. Verification runs in an owned current-target tree and holds admission while in progress or unknown. Source verification prepares every subsequent change from that verified target, leaving the operator's checkout unchanged. Operator merge questions remain required with the default manual-merge policy. A flow waiting on a question holds no flow slot (up to `policy.maxParkedFlows`, default 3), so the queue keeps moving while a question is open; an answered flow continues when a slot is free, ahead of queued tasks.

The Tasks view can discover and refresh issue-backed tasks through **Refresh from source**. Configure a `source.sync` schedule for periodic discovery. GitHub fenced briefs are the default eligibility rule; custom trackers use a project-owned read adapter. Imports and changed dependency facts never approve work. See [issue source sync](source-sync.md).
