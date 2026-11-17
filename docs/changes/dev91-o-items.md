# dev.91: the dev.90 readiness re-test findings O1–O6

Six findings from the dev.90 readiness re-test:

- **O5 (defect, slice 6).** An accepted context task held because its provider is not in `upkeep.context.qualifiedProviders` looked free (`holds: []`, `ready: true`, `admissionReasons: []`). Health dropped its provider warning and said "Start it from the task", and `queue.held` was written about once a second.
- **O2 (live risk, not caused by dev.90).** In Codex's `workspace-write` sandbox on the trial host, Node could not start child processes (`spawnSync /usr/bin/node EPERM`). Every Codex build of a project whose tests do that came back blocked, and the lost rounds used up the build visit bound.
- **O1 (docs).** The live Codex checklist step made the model read the planted skills with `rg` and `cat`. It answered `LINNET` although nothing was loaded.
- **O3.** Claude Code refused a build's write to `.claude/`, so a Claude builder could not make a declared `.claude/` change.
- **O4 (console).** Inbox and Health still showed some times as "date (… ago)".
- **O6 (docs).** The slice 6 notes still said not to list Codex until it was isolated.

This is a local implementation record, not a release, activation or live qualification claim. No model session was started. The O2 and O3 investigations ran `codex sandbox` and Claude Code against a local fake endpoint only.

## Action needed

- **If a context task is waiting on you:** `status --task <id>`, the Queue tab and Health now say which providers hold it and what to do. Run the [provider instruction-loading checklist](../qualification/provider-instructions.md) for them on your host. Once it passes, add them to `upkeep.context.qualifiedProviders` (`config update`). Or route the task's model steps to a listed provider (`task.models`).
- **Before listing a provider in `upkeep.context.qualifiedProviders`, run this version of the checklist.** Its live Codex steps now forbid reading files and count only if no command ran. Codex is isolated as of dev.90, so Codex and Claude follow the same rule: list one only after its checklist passes on your host.
- **If your builder is Codex and your project's checks start processes** (for example `node --test` suites that run your CLI with `execFileSync`), run `doctor`. If it warns that Codex's sandbox refuses part of process handling, prefer a Claude builder (`providers.builder`, or `task.models` for one task). Two Codex settings that lift the limit were found and are not used (see [O2](#o2-codexs-sandbox-and-node-child-processes)); the pre-release one is a [runtime follow-up](../runtime-followups.md#codex-builders-a-sandbox-that-lets-node-start-child-processes-deferred-dev91).
- **If a task must change `.claude/` or `.mcp.json`,** route its builder to Codex (`task.models`) or make the change yourself. **If it must change `.codex/` or `.agents/` at the top of the repository,** route its builder to Claude. Admission now says this instead of starting a build the builder's CLI refuses.
- **A queued task refused at final admission no longer holds up the queue.** The claim moves on to the next task, and the refused one shows as a `claim` hold on that task in the Queue tab and `status`. Fix what it names (often a stored `task.models` choice that no longer validates).
- **Nothing to migrate.** No schema, graph or configuration key changed. One meta row (`tickProblems`) is added on first use.

## O5: a context task's provider hold, shown and recorded once

### Cause

- The provider check for a context task was made only in `admitFlow`, after `admissionReasons` had passed the task. So the task's reasons were empty. The queue's eligibility recorded it as ready, and `status --task` showed nothing.
- The automatic claim (`claimCandidate`) chose the first queued task with no reasons, which was this one. `admitFlow` then refused it, and the operations tick caught the refusal and wrote `queue.held` with its reason, on every tick.
- Because the claim stopped at its first candidate, the context task also kept every task queued behind it from starting.
- Health's provider sentence was shown only while a proposal was open. Accepting the proposals closed them, so the sentence went away exactly when the task began to wait. The context task's notice said "Start it from the task" whatever its state.

### Fix

- **An admission reason** (`operations/admission.mjs`, `contextProviderHold`). The routes the flow would pin (saved defaults, the task's models and run overrides, fallbacks included) are judged in `admissionReasons`, with code `context-provider`. The reason names the providers, the checklist and the remedy: run the checklist and add the providers (`config update`), or route the task's model steps with `task.models`. It is the same text `admitFlow` and the provider step give (`contextProviderRefusal` now carries the remedy).
  - `status --task` shows it in `admissionReasons`.
  - The queue's eligibility records it once, as a change.
  - The claim passes over the task, so the tasks behind it start, and nothing is refused per tick.
- **Queue status** (`operations/queue-status.mjs`). It shows a hold of kind `context-provider` with `scope: 'task'`, the `taskId` and `providers`, whenever the open context task is queued and held. It is read by key, and the dashboard reads the task whole through a new `record()` on its read view. `status`'s `project.queueHolds` carries `taskId`. The console's Queue tab lists task-scoped holds under "A queued task is held." with a link to the task, apart from "The queue is held." A task's own start hints include only holds for that task.
- **Health** (`operations/views.mjs`, `console/ui/operations.mjs`). The context task's view gains `queued`, `flow`, `autoQueue` and `providerHold`. A held task shows "Context task held", the providers and why. The provider sentence stays while a context task is open. The help says what will start it: queued with automatic admission, queued without it, approved but not queued, or running. "Start it from the task" appears only when that is the way.

### Every other hold: written once, not per tick

Every event the operations and engine ticks write from a `catch` was checked. These repeated on every tick while their cause lasted:

| Event | Where | Before |
| --- | --- | --- |
| `queue.held` | automatic claim refused after admission | every tick |
| `upkeep.tick-failed` | upkeep close tick | every tick |
| `upkeep.tick-failed` | upkeep run tick | once per reason, but only in memory: again after each restart |
| `grant.expiry-failed` | engine tick | every tick |
| `provider.limit-release-failed` | engine tick | every tick |
| `adoption.refs-release-failed` | adoption ref sweep | every tick |

`operations/tick-problems.mjs` (new) records such a problem once: when it starts, and again only when its reason changes. The open problems are one meta row, `tickProblems` (`{key: {type, reason, since, ...}}`). So they survive a restart, and queue status shows each open claim refusal as a hold of kind `claim` (task, since when, reason). The next success clears it, and a later recurrence is recorded again. Since the [review of 56d49a9](#review-of-56d49a9), the same problem means the same event type, reason **and** identifying fields, and a claim refused at final admission moves on to the next task. Each store keeps its last copy of the row, so an idle tick adds no statement; the idle-tick statement test pins that. A write inside a caller's transaction drops the copy instead, because that transaction can still roll back.

Every other hold the ticks meet was already recorded once per change:
- flow waits (`flow.slot-wait`, `flow.merge-wait`, `flow.target-wait`, `flow.provider-held`, `flow.decision-held`);
- the queue's eligibility (`queue.eligibility-changed`);
- the idle-capacity notice;
- maintenance refusals (once per job);
- the upkeep job's provider hold, which writes nothing.

### Tests

`tests/dev91-o-items.test.mjs`. On the code before this change (`2985714`, with `tick-problems.mjs` copied in so the file loads), the first four tests below fail and the fifth passes.

| Test | Before |
| --- | --- |
| `O5: a context task held for an unqualified provider shows its hold, with reason and remedy, in status, the queue and Health` | fails: admission reasons `[]` |
| `O5: a held context task writes no queue.held on every tick (60 ticks), and other queued work is still admitted past it` | fails: 61 `queue.held` in 61 ticks |
| `O5: once the operator lists the providers, the hold clears and the next tick admits the context task` | fails (Health has no `providerHold`) |
| `O5, every hold: a claim refused after admission (a check only admitFlow makes) is recorded once over many ticks, shown in queue status, and again only when its reason changes` | fails: 40 `queue.held` in 40 ticks |
| `O5, every hold: recordTickProblem writes one event per start or change and survives a reopened store` | new module |

## O2: Codex's sandbox and Node child processes

### What was found (offline, `codex sandbox`, no model)

Codex 0.169.0 and Node 26.12 on Linux 7.2.15, the dev.90 trial host:

| Probe | Result |
| --- | --- |
| `codex sandbox -c sandbox_mode="workspace-write" -- node probe.js`, where the probe runs `spawnSync(node, ['-v'])` | `error: spawnSync /usr/bin/node EPERM`. The child **ran**: `status 0` and its stdout `v26.12.0` were captured. `/bin/sh` as the child fails the same way |
| Same, `read-only` | same |
| Async `spawn` with piped stdio | works |
| `spawnSync` with `stdio: 'inherit'` or `'ignore'`, or with stdin `'ignore'` | works |
| `spawnSync` with a piped stdin, with or without `timeout` | EPERM |
| `bash -c 'node -v'` | works |
| `UV_USE_IO_URING=0` | no change |
| Python, `socketpair()` then `shutdown(SHUT_WR)` and `getsockopt(SO_TYPE)` | both `EPERM` |
| Same with `-c sandbox_workspace_write.network_access=true` | everything works |
| Permission profile (`-c default_permissions="probe" -c permissions.probe.extends=":workspace"`), network off | EPERM |
| Same profile with `permissions.probe.network.enabled=true` and `--enable network_proxy`, no domains allowed | `spawnSync` works. Direct TCP to two public addresses fails with "Network is unreachable", DNS fails, UDP fails, and an HTTPS request through the proxy gets `403` |

**Cause.** Codex's Linux sandbox restricts network with a seccomp filter. That filter denies `shutdown(2)` and `getsockopt(2)` with `EPERM`, even on a local `AF_UNIX` socket pair. Node's `spawnSync` (and `execSync`, `execFileSync`) closes the child's stdin pipe with `shutdown`, and reports the failure as a spawn error after the child has run. It is the sandbox, not the dev.90 working root: the result is the same with the repository as the working directory.

**Settings.** The Codex docs (configuration reference, advanced configuration, permissions and sandboxing pages) document no process-related sandbox key, and say nothing about seccomp's syscall list or this failure.
- `sandbox_workspace_write.network_access=true` lifts the whole network filter. A builder's commands then reach the network. That is not a safe default, and the factory does not use it.
- A permission profile with the managed network proxy and no allowed domains also makes `spawnSync` work while network stays closed. But permission profiles are beta, `network_proxy` is experimental, and the docs say `default_permissions` must not be combined with `sandbox_mode` or `[sandbox_workspace_write]`. The factory's Codex isolation uses both (`sandbox_mode`, `sandbox_workspace_write.writable_roots`). Moving to profiles would mean rebuilding that isolation on a pre-release surface and qualifying it again (open question 1).
- `danger-full-access` was not considered.

So no documented, stable, safe setting exists. The fix makes the limit visible and cheap.

### Fix

- **Doctor** (`workflows/commission.mjs`). When any builder route (the role, its fallback or a step model) uses Codex, doctor runs `codexSandboxSpawnProbe` once. It runs `codex sandbox` with `workspace-write` and network off, in an empty folder under `doctor/codex-sandbox`, and the probe script makes one `spawnSync` with a piped stdin. A refusal is a warning naming the error, saying the factory's checks run outside the sandbox, and recommending a Claude builder for projects whose checks start processes. The result is recorded as `codexSandbox` on the commissioning record. It never blocks commissioning. An inconclusive probe is a softer warning. A doctor run with faked providers (tests) runs no real probe.
- **The Codex builder's prompt** (`adapters/providers/index.mjs`, `CODEX_SANDBOX_NOTICE`, after the `Repository:` notice, builder steps only). It says what the sandbox may refuse, that the factory's checks run outside it and decide, and that a command failing only for a sandbox reason is not a reason to return blocked: the builder returns implemented and names the command and error. A Codex builder on such a host then completes the round, and the fast checks give the real result. Planner and reviewer steps (read-only) are unchanged.
- **A build that still returns blocked** with `EPERM` or "operation not permitted" in the builder's own words, from a non-Claude builder, gets a build question that says the sandbox blocked it (`core/worker-questions.mjs`, `buildQuestion.sandbox: 'codex'`). It also says how to spend no further round: `retry` with a note to treat it as environmental, or stop and route the builder to Claude.
- **Docs.** [Running: Codex builders and the sandbox](../running.md#codex-builders-and-the-sandbox).

A retry from the build question still uses a build visit, as before. Not counting a sandbox-blocked round against the bound would need a change to visit accounting, which this change does not make (open question 2). The prompt is meant to stop such rounds from happening at all.

### Tests

| Test | Before |
| --- | --- |
| `O2: a Codex builder is told what its sandbox refuses and that the factory checks decide; read-only steps are not` | fails to load (no `CODEX_SANDBOX_NOTICE`) |
| `O2: the offline sandbox probe runs codex sandbox with the factory's settings and reads refused, ok and unknown` | fails to load |
| `O2: doctor checks a Codex builder's sandbox offline and warns, never blocks; a Claude builder is not probed` | fails with `commission.mjs` reverted: no warning |
| `O2: a Codex build blocked by its sandbox is reported as such, with how to spend no further build round on it` | fails with `worker-questions.mjs` reverted |

## O1: the checklist tests loading, not reading

- **The prompt.** `docs/qualification/provider-instructions.md`: the prompt adds "as loaded before this message" and "Do not read any file and do not run any command", which is the form that answered `NONE` fresh and resumed in the re-test.
- **The live Codex steps check the event stream.** A step with any `command_execution` item is inconclusive and is run again. Only a step that ran nothing and answered something other than `NONE` fails.
- **The evidence.** The offline capture is named as the evidence for loading.
- **The Codex control.** It no longer expects `DUNNOCK`. The `$HOME/.agents/skills` skill is listed in the request, and its body was not injected in the re-test.
- **Status.** The status records the dev.90 live results.
- **What passing means, in the checklist and in [provider worktree isolation](provider-worktree-isolation.md#what-isolation-does-not-cover-reading-files-with-tools).** Tools can read worktree files as data, and that is not instruction loading. For governance edits and context tasks the package's `Governing context` block carries the files at the comparison commit, so the worktree's copy is the proposal under review. [Project workflows](../project-workflows.md) says it too.

## O3: provider configuration a builder's CLI will not write

### What was found (offline: Claude Code 2.1.326 against a local endpoint that scripts one `Write` call; `codex sandbox`)

| Path written by the builder | Claude Code (the factory's flags: `--safe-mode --setting-sources '' --disable-slash-commands --restricted --permission-mode acceptEdits --permission-prompts none`) | Codex `workspace-write`, worktree as writable root |
| --- | --- | --- |
| `docs/NOTES.md`, `AGENTS.md`, `CLAUDE.md` | written | written |
| `.claude/commands/t.md`, `.claude/skills/x/SKILL.md`, `src/.claude/…`, `.Claude/…` | **refused** ("requires approval, and this session has no approval surface") | written |
| `.mcp.json`, `src/.mcp.json` | **refused** | written |
| `.claude/commands/…` with `--settings '{"permissions":{"allow":["Write(.claude/commands/**)", …]}}'` | **refused** | — |
| `.codex/config.toml`, `.agents/skills/x/SKILL.md` | written | **refused** |
| `src/.codex/…`, `src/.agents/…`, `.Codex/…`, `.AGENTS/…` | written | written |

Claude Code's help says `--restricted` "lets only a person or the configured permission handler approve writes to settings, git and tool-configuration files". So no allow rule opens them. A permission handler is an MCP tool given by `--permission-prompt-tool`, and the factory starts Claude with an empty MCP configuration. Adding a factory-owned handler that approves only declared paths is possible, but it is a new trusted component (open question 3).

### Fix

`operations/admission.mjs`, `builderConfigHold` (code `builder-config`):
- **The rule.** A task whose `paths` declare provider configuration that its builder's provider refuses is held at admission. That means `.claude` at any depth or `.mcp.json` for Claude, and a top-level `.codex` or `.agents` for Codex. The fallback is checked too.
- **The reason** names the paths and why, and gives the remedy: route this task's builder to the other provider (`task.models`), or make the change yourself. When the declared paths rule out both providers, it says to split the task or make the change by hand.
- **Where it shows.** `flow.start` and the claim refuse with it, and `status --task` and the queue show it.

The commit-time boundary is unchanged.

### Tests

`O3: a declared .claude/ or .mcp.json change refuses a Claude builder at admission, naming Codex or a person; a Codex builder is refused .codex/ and .agents/ at the top`: it fails with the admission line removed.

## O4: one recorded time, one form

- **Inbox** (`console/ui/inbox.mjs`). These now render as the `<time>` element, with the recorded UTC value in its title:
  - a question's "Opened" and "Expires";
  - a to-do's "Created" and "Resolved";
  - a decision's created time;
  - a grant's "Valid from" and "Expires", and its coverage line;
  - a prompt presentation's expiry;
  - an adopted pull request's "checked" time.

  The relative times in presentation, withdrawal, answer, relay and disposition lines are now `<time>` elements too. No "date (… ago)" pair is left.
- **Health** (`console/ui/operations.mjs`):
  - main health "Checked" and the scheduled tier's time are one `<time>` each, without the "(… ago)" suffix;
  - a dispatching attempt's "Prepared" and "Dispatched" are `<time>` elements.
- **The task page** (`console/ui/plan.mjs`): "Not before" and "Approved at" are `<time>` elements.

Test: `O4: Inbox and Health show each recorded time once, as a time element, never as "date (… ago)"`. It fails with the three console files reverted.

## O6: Codex may be listed after its checklist passes

`docs/changes/upkeep-slice6.md` (both places), `docs/operations.md` and `docs/qualification/provider-instructions.md` now say: Codex is isolated as of dev.90 ([provider worktree isolation](provider-worktree-isolation.md)), like Claude Code before it, and either provider is listed in `upkeep.context.qualifiedProviders` only after its checklist passes on your host. The checklist says what that evidence is: a clean offline capture, fresh and resumed, and live steps that ran no command and answered `NONE`.

## Compatibility

- **Graphs.** No graph changed, so no digest changes.
- **Schema.** No schema or configuration key changed, and no SQL reads `records.data`.
- **New fields:**
  - the `context-provider` and `claim` queue-hold kinds (`scope`, `taskId`, `providers`); a `claim` hold for a task has `scope: 'task'`;
  - `refused` (`[{taskId, reason}]`) and `dispatchedTaskId` on a `queue.dispatch` job, and `taskId`, `refused` (at most 10, reasons cut at 600 characters) and `refusedCount` on `queueStatus.lastDispatch`;
  - the `context-provider` and `builder-config` admission fact codes;
  - `codexSandbox` on the commissioning record;
  - `buildQuestion.sandbox`;
  - the context task's `queued`, `flow`, `autoQueue` and `providerHold` in Health;
  - `taskId` on the `queue.held` event;
  - the `tickProblems` meta row.
- **Behaviour changes:**
  - A context task held for its providers no longer stops the queue behind it.
  - A task refused at final admission no longer stops the queue behind it: the automatic claim, and a manual `queue.dispatch`, move on to the next eligible task. Before, the automatic claim retried the same task every tick, and a manual dispatch whose task was refused failed the dispatch job; now the job completes, dispatching the next eligible task or, if none, with `no-eligible-task` and the refusals in `heldReasons` and `refused`.
  - A task declaring provider configuration its builder cannot write is no longer admitted.
  - The listed tick failures write one event per start or change.
  - A Codex builder's prompt is longer by one paragraph.
- **The dashboard read view** gains `record(kind, id)`, a whole record read by key.

## Review of 56d49a9

An independent review (GPT-6.1 Sol) found one P2 and one P3. These held:
- O5 in every view, with queue order and limits preserved;
- the idle tick;
- O2: the diagnosis was reproduced independently, the probe runs offline, and the factory's own checks still gate;
- the O3 path rules;
- O1 and O6;
- the console at 320 px;
- digests.

1. **P2: deduplication kept the wrong task when the claim changed.**
   - **The problem.** `recordTickProblem` compared only the event type and the reason. Tasks A and B had the same invalid stored model choice. A was refused. A then left the queue, and B was refused with the same words. The open problem still named A, with A's time, and no event was written for B.
   - **Fixed** in two ways. The comparison includes the identifying fields (task, flow, job: everything recorded beside the reason). And claim refusals are kept per task (`queue-claim:<taskId>`).
   - **Test:** `review P2: the same refusal of another task is a new problem: the hold and the event name that task`.
2. **P3: upkeep failures outlived their work.**
   - **The problem.** The `upkeep-runs` and `upkeep-closes` problems were cleared only in the branches that had work. A failure recorded before the work ran out stayed open, and the same failure later wrote no event.
   - **Fixed:** each is cleared on a tick with no such work.
   - **Test:** `review P3: an upkeep tick failure ends when no such work remains, and a later recurrence is a new event`. It makes a real close-tick failure: a close whose record's job list is not a list.

**Decisions, as the reviewer recommended:**
1. **The Codex permission profile** is deferred, recorded as a [runtime follow-up](../runtime-followups.md#codex-builders-a-sandbox-that-lets-node-start-child-processes-deferred-dev91): a separately qualified opt-in.
2. **The build visit bound** stays as it is.
3. **The Claude Code permission handler** is deferred, recorded as a [runtime follow-up](../runtime-followups.md#claude-code-builders-a-permission-handler-for-declared-claude-paths-deferred-dev91): a separately reviewed trusted component.
4. **A refused claim moves on to the next eligible task. Implemented.**
   - **The automatic claim** (`operations/queue-claim.mjs`, `claimQueue`). Each attempt is its own `claimCandidate` transaction, so a refused admission rolls back whole. The next attempt passes over the refused tasks (`exclude`), in queue order. Bounds:
     - at most one flow is admitted per tick, as before;
     - at most one attempt per queued task;
     - every normal admission reason and limit still applies.
   - **Each refused task** is one queue hold, scope `task`. It is written once, and again only if its reason changes. It is cleared when the task is claimed, leaves the queue, or is held by an ordinary admission reason.
   - **A refusal that names no task** stops the claim, as before, and is recorded under `queue-claim:*`.
   - **The manual `queue.dispatch` job** does the same inside its own transaction. It undoes a refused admission to a savepoint, moves on, and lists the refusals on the job (`refused`).
   - **Tests:**
     - `decision 4: a task refused at final admission no longer blocks the tasks behind it; its refusal is one queue hold, and limits and rollback hold`;
     - `decision 4: a manual queue dispatch moves past a task refused at final admission and records it on the job`.
   - **What refuses at final admission.** The tests use a stored model choice that no longer validates, a check only `admitFlow` makes. Catalog drift, the reviewer's example, is already an admission reason (`workflowAdmission` reports it), so it never reached the claim's final step.

On `56d49a9` (the tests copied in), all four new tests fail. P2 fails on "B's refusal is written, naming B", and decision 4 on "the task behind the refused one starts". The manual dispatch job fails with the model-choice error, and P3 fails on the second event.

## Re-check of 851fad5

The re-check (GPT-6.1 Sol) found both earlier repros fixed. It confirmed:
- a refused admission rolls back with no partial state (flow, events, outbox, workspace, refs);
- holds, fairness, limits and the idle tick behave;
- the manual dispatch behaviour should be kept.

One P3 remained.

1. **P3: a manual dispatch hid the tasks it skipped.** `queueStatus.lastDispatch` dropped the job's `refused`, and Queue said only "started this flow". An operator who expected task A saw task B started, with no explanation.
   - **Fixed in the job and queue status.** The job records `dispatchedTaskId`. `lastDispatch` carries `taskId`, the skipped tasks with their reasons (`refused`, the first 10, each reason cut at 600 characters) and `refusedCount`.
   - **Fixed in Queue.** A result from an older project service, with no task, still reads "started this flow". Otherwise the result reads "Last dispatch … started <task> (its flow)." It lists "Skipped, because it could not be admitted:" with each skipped task linked and its reason as text. The same list follows "found nothing to start" when every eligible task was refused.
   - **The help.** The "Dispatch now" help says a task refused at admission is skipped, the next one is tried, and the result lists what was skipped and why.
   - **Safe and narrow.** All of it is built as DOM text, never markup. `.dispatch-result` wraps long IDs and reasons at 320 px.
   - **Test:** `review of 851fad5: Queue shows the task a manual dispatch started and each task it skipped, with why, as text`. It fails on `851fad5`.

## Results

On this branch, with `main` merged (see the commit that merges it):

- `node --test tests/dev91-o-items.test.mjs`: 16 of 16.
- Full `npm test`: 1792 tests, 1791 pass, 0 fail, 0 cancelled, 1 skipped (the confusables whole-source test, which needs `FACTOTUM_CONFUSABLES_TXT`). Run with the 851fad5 re-check fix; `main` is still at `bb74a29`, already merged.
- `npm run eval`: exit 0.
- `git diff --check bb74a29..HEAD`: clean.

## Open questions

None left from this change. The deferred items are in [runtime follow-ups](../runtime-followups.md), and the build visit bound stays as it is (decisions above).

## Adopter report on dev.91: the sandbox check read as unknown

**Problem.** On an adopter's host, doctor's Codex sandbox check came back `spawn: "unknown"` with `codex sandbox exited 0: `, so the probe ran but printed nothing. The main thread reproduced this with the factory's own `codexSandboxSpawnProbe`, and found the cause:
- `runProcess` gives a child its stdio as sockets, which is how Node spawns them.
- The probe wrote its result with `process.stdout.write`, which is asynchronous.
- Inside the sandbox, the socket shutdown that write needs to flush is refused, so the output was lost.

Run from a shell with stdout going to a file or a pipe, the same probe printed its result, which is why the earlier offline checks passed.

**Fix.** The probe now writes with `require('node:fs').writeSync(1, …)`. Through the factory's function it now reads `{spawn: "refused", error: "EPERM"}` on the reporting host.

**Also from the report.** Warnings from a doctor run inside `upgrade apply` weren't shown. A passing step now keeps its warnings, and the upgrade result carries `doctorWarnings`. Doctor's are the only warnings so far.

**Tests.** Both of these fail before the fix:
- "the offline sandbox probe …" checks that the probe writes synchronously;
- "dev.91 report: a passing doctor's warnings appear …" checks the warnings in the upgrade result.
