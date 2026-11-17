# dev.85: the upgrade's doctor step cut doctor off and called it a provider timeout

An adopter ran `upgrade apply` to dev.84 on a host with a load average around 8. The doctor step failed after 600,109 ms with only `"error": "Provider timeout"`, and commissioning stayed required. The error named no role, provider, command or phase, and the step had no `reasons`. A direct `doctor` about ten minutes later passed, with both providers ready.

**Fail-before evidence** for every test below was taken the same way: the new and updated test files were copied into an export of the base commit `db1279f` (`git archive HEAD starter package.json`) and run there with `--test-name-pattern "dev.85"`. All 16 new tests fail at base; the failure each one gives is quoted with it.

## Root cause (confirmed in the code)

- `operations/upgrade-apply.mjs` ran the merged CLI as a child for both `config update --current` and `doctor`, through `run(process.execPath, [cli, ...], { timeoutMs: 600000 })` (`mergeUpgrade` and `activateUpgrade` each had the same line).
- `run` defaults to `runProcess` (`adapters/providers/index.mjs`). When a process outlived its limit, `runProcess` rejected with ``new ProviderError(`Provider ${reason.toLowerCase()}`)``, which is "Provider timeout" whatever it ran. The step's `catch` recorded only `error.message`, so the doctor's stdout and stderr, which `runProcess` had kept on the error, were dropped.
- Doctor can legitimately run longer than 600 s. Before its main verification it waits for the machine-wide heavy-work permit for up to `LEASE_HOLD_BOUND_MS` (3,900,000 ms, about 65 minutes). Before that it probes every role's provider, each fallback and each distinct step model in sequence (three 15 s CLI calls each), and after it runs every main check at its configured timeout.

The text proves which layer failed. Doctor's own probes could not produce "Provider timeout": `preflight` wrapped every transport error as "CLI preflight process failed before model launch". So the message came from the outer `runProcess` that killed the doctor child, and 600,109 ms is the 600,000 ms limit plus the time to stop the process group.

What doctor was doing when it was killed cannot be shown from the report, because the old code discarded its stderr. The permit wait is the likely phase. With weighted admission (`resources.pools.<pool>.maxLoadAverage`), a host load at the pool's limit keeps the permit closed even with no holder ("no recorded holder (pool limits or machine load)"). Under that load the direct `doctor` ten minutes later got through.

## Fix

### 1. The upgrade gives doctor doctor's own time bound

- `doctorTimeBound(stateDir)` (`workflows/commission.mjs`) computes the longest doctor can legitimately run from the stored configuration:
  - the permit wait bound (`LEASE_HOLD_BOUND_MS`);
  - every provider probe (roles, configured fallbacks and distinct step model routes, counted with the same functions doctor probes with), each at `PROBE_BOUND_MS` (three calls of `PREFLIGHT_CALL_TIMEOUT_MS` = 15 s, plus 1 s each to stop) and tried twice, with the 2 s retry pause;
  - every main check at its `timeoutMs` (plus 1 s), times one plus `policy.mainInfrastructureRetries` plus its flake-policy retries;
  - a 15-minute margin (`DOCTOR_MARGIN_MS`) for the Git, forge and workspace work around them.
- The result is capped at `DOCTOR_TIME_CAP_MS` (4 hours), and the step records `limitCapped: true` when the cap applied. An unreadable state gets the estimate for three roles and no checks.
- For the fixture configuration (three roles, one 60 s main check) the bound is 5,155,000 ms (about 86 minutes), against the old 10.
- `mergeUpgrade` and `activateUpgrade` now share `recommissionAndDoctor`, which runs both CLI steps through `cliStep`. The doctor child gets `doctorTimeBound`, recorded as the step's `limitMs`.
- `config update --current` keeps 10 minutes (`CONFIG_UPDATE_TIMEOUT_MS`). It only recompiles and records the configuration and waits on no permit, so 10 minutes is a bound, not a guess.
- Those are the only CLI steps `upgrade apply` runs. Its other steps (stop, layout, backup, merge, verify, push, cleanup, start) run in process or through Git and `systemctl` calls with their own limits, and none of them waits on doctor's resources.
- `runCli` (the test hook) now receives `{ timeoutMs }` too.

### 2. The failure says what failed

- **`runProcess` names what it ran.** It takes a `label`, which defaults to the executable's name, and a stopped process reads `<label> timed out after N s`, `<label> was cancelled`, `<label> was stopped for writing more than N bytes of output`, `<label> left processes running after it exited`, or `<label> could not start (ENOENT)`. The error also carries `elapsedMs` and `timeoutMs`. Codes are unchanged. The upgrade labels its children `factory CLI doctor` and `factory CLI config update`. A model invocation is labelled `<provider> provider` ("codex provider timed out after 600 s"), and preflight calls `<provider> <call>`.
- **A failed CLI step is described.** `cliStep` records:
  - `error`: ``the doctor step (node <cli> doctor --state <dir>) timed out after N s (its limit is M s) during permit wait (waiting up to 65 min for heavy-work, held by …)``. A not-ready doctor reads `exited with code 1 after N s: <doctor's reasons>`. A doctor that had printed no progress reads `before it reported any progress`.
  - `command`, `elapsedMs`, `limitMs`, `exitCode` and `timedOut`.
  - `phase` and `lastProgress`, from doctor's last progress line.
  - `reasons`, parsed from doctor's JSON on stdout.
  - `stdout` and `stderr`: their last 12 lines and 1,200 characters, with controls stripped and the known-secret set (`knownSecrets(config)`) redacted.
- **The excerpt helper is shared.** The bounding and redaction come from `outputExcerpt` (`core/command-failure.mjs`), which the G19 log-tail helper now uses too. The behavior is unchanged: redaction runs before the cut, and a cut first line is dropped.
- **Failed config update.** A failed `config update` keeps its message prefix: `config update failed: <its last output lines> (the recommission step (…) exited with code 2 after N s …)`. The same fields are recorded on the step.
- **Doctor reports its phases.** `doctor` takes `onProgress(phase, detail)` and calls it on entering each long phase:
  - `probe of <route> (<provider>/<model>)`, with `attempt n of 2`;
  - `forge check`;
  - `checkout check`;
  - `permit wait`, each time the holder changes, naming it;
  - `main verification`.

  The CLI prints these to stderr as `doctor: [<phase>] <detail>` (`doctorProgressLine`). `lastDoctorProgress` in upgrade-apply reads the last one. This replaces the CLI's earlier `doctor: waiting for …, held by …` and `doctor: resource acquired; verifying` lines. `onResourceWait`, used by console-requested doctors, is unchanged.

### 3. Doctor names the role, provider, model and phase of a provider failure

- **The preflight says which call failed and how.** `preflight` (`adapters/providers/index.mjs`) sets `call` (`--version`, `--help` or `auth status`), `failure` and, for a process failure, `processCode` (`TIMEOUT`, `ENOENT`, …). The `failure` kinds are:
  - `timeout`;
  - `missing-cli` (ENOENT, EACCES, ENOTDIR or a spawn failure);
  - `process-error`;
  - `invalid-result` (a failing `--version`, or `--help` lacking or failing the required flags, which are now listed);
  - `auth` (subscription not verified).

  It keeps the CLI's stderr as a non-enumerable `stderr`, but never the auth call's output, which can name the account. Error codes (`PREFLIGHT_FAILED`, `PROVIDER_REJECTED`, `BILLING_UNVERIFIED`) and `started: false` are unchanged, so fallback eligibility is unchanged.
- **Doctor classifies and records the failure.** `probeFailure` classifies a failed probe; a probe error without `failure` maps through its code to `configuration` or `error`. Doctor records it in `providers[<role>]` (or `providers["<workflow>.<step>"]`) as:
  - `provider`, `model` and `ready: false`;
  - `phase`: `preflight`, or `fallback preflight` with the fallback's own `provider`, `model` and details under `fallback`;
  - `failure`, `call`, `attempts` and `retried`;
  - `error`: the message plus the CLI's stderr, bounded and redacted with `knownSecrets(config)`.
- **The reason carries the same detail.** For example: `planner provider preflight failed for codex/<model>: timed out during auth status, after one retry (codex CLI preflight failed before model launch: codex auth status timed out after 15 s)`. A fallback reads `reviewer fallback provider preflight failed for codex/<model>: CLI missing during --version (…)`. A step route reads `step model <workflow>.<step> preflight failed for …`.

### 4. One retry for timeouts and transient process errors

- A probe whose failure is `timeout` or `process-error` is tried once more after `PROBE_RETRY_PAUSE_MS` (2 s). No other failure is retried: `auth`, `missing-cli`, `invalid-result`, `configuration` and `error` fail at once.
- A pass on the retry is recorded as `retry: { attempts: 2, firstFailure, firstError }` on the route's entry. A second failure records `attempts: 2`, `retried: true`, and the reason says "after one retry".
- The retry stays inside the step's bound: `doctorTimeBound` counts two full attempts and the pause for every probe.

### 5. Docs

- `docs/updates.md` (guided update) explains how long the doctor step can take and why (the permit wait, probes, main checks), the limits, and how to read a failed recommission or doctor step.
- `docs/running.md` has a new section, "Provider probes in doctor": the three calls, the retry rule, the recorded fields and reason format, the progress lines, and labelled process timeouts.

## Compatibility

- No schema, configuration, workflow graph or digest change. No new CLI option.
- Message changes (codes unchanged):
  - process stops: "Provider timeout" becomes `<label> timed out after N s`, and similarly for the other stops;
  - "Provider executable could not start" becomes `<label> could not start (<code>)`;
  - preflight messages now name the provider and call ("CLI preflight process failed before model launch" becomes `<provider> CLI preflight failed before model launch: …`; "CLI version check failed", "Installed CLI lacks …" and "Subscription billing route could not be verified" gain the provider and exit code).

  Nothing in the reference matches on these texts. Attempt and check records that stored the old messages are unchanged.
- Doctor's reasons for provider failures are longer. Each still begins `<role> provider preflight failed` or `step model <route> preflight failed`.
- The commissioning record's `providers` entries gain fields (`failure`, `call`, `error`, `attempts`, `retried`, `phase`, `retry`, and `fallback` on a failed fallback). Existing fields are unchanged.
- Doctor's progress lines on stderr changed format, as described in fix 2.
- An upgrade's doctor step may now run for up to about 65 minutes plus probes and checks (at most 4 hours) instead of being killed at 10 minutes. The upgrade's units are restarted only after it ends, as before.
- A probe that times out now takes up to two attempts plus 2 s before commissioning fails on it.
- The upgrade step's `output` field (an unredacted 2,000-character tail) is replaced by redacted `stdout` and `stderr` excerpts.
- This fix ships in the release being adopted, and `upgrade apply` runs with the new release's CLI. An upgrade *to* dev.85 run with the dev.85 CLI (as documented) already gets it.

## Tests (16 new; fail at base, pass after)

`tests/upgrade-apply.test.mjs` (7):

- "dev.85: the doctor step gets doctor's own time bound, beyond its permit wait; config update keeps ten minutes": a recording `run` sees the doctor child's `timeoutMs` above 3,900,000 and equal to `doctorTimeBound`, `config update` at 600,000, and the `factory CLI …` labels. Before: `doctor limit 600000 ms must exceed the 3900000 ms permit wait`.
- "dev.85: activate gives its doctor step the same bound". Before: `actual: undefined, expected: 600000` (no limit reached the child).
- "dev.85: a doctor step that times out names the step, command, elapsed time, limit and the phase doctor reported, with redacted output": 40 noise lines, two progress lines and a synthetic `OPENAI_API_KEY` on stderr. The step says `timed out … (its limit is … s) during permit wait (… held by project other-project …)`, with `phase`, `lastProgress`, at most 12 stderr lines ending `debug: key [redacted]`, and the secret nowhere in the result. Before: `actual: undefined, expected: true` (`timedOut`; the step held only "factory CLI doctor timed out…" as a bare error).
- "dev.85: a doctor step that exits not ready carries doctor's reasons". Before: `actual: undefined, expected: 1` (no exit code, reasons or phase).
- "dev.85: a failed config update in the upgrade names its command and keeps its output excerpt". Before: `actual: undefined, expected: 2`.
- "dev.85: lastDoctorProgress reads the line format the doctor CLI prints". Before: `doctorProgressLine is not a function`.
- "dev.85: through the real process runner, a merged CLI whose doctor is not ready is reported with its reasons, phase and output": the merged release's `factory/cli.mjs` prints progress and a not-ready record and exits 1, run through the real `runProcess`. Before: `actual: undefined, expected: [ 'GitHub repository push permission required' ]`.

`tests/commission-maintenance.test.mjs` (6):

- "dev.85: a failed provider probe names the role, provider, model, kind of failure, call and a redacted excerpt; auth is not retried". Before: `actual: undefined, expected: 'auth'`.
- "dev.85: a probe that times out is retried once, and a pass on the retry is recorded" (and two timeouts fail with "after one retry"). Before: `["planner provider preflight failed"]` (not ready, no retry).
- "dev.85: missing CLIs, configuration and invalid results are not retried; a transient process error is". Before: `actual: undefined, expected: 'missing-cli'`.
- "dev.85: a failed fallback probe is named as the fallback, with its own provider and model". Before: `actual: undefined, expected: 'fallback preflight'`.
- "dev.85: doctor reports each long phase as it enters it, including the permit wait and who holds it": a permit held by another project for 1.2 s. Before: `actual: []`.
- "dev.85: doctor's time bound covers the permit wait, every probe with its retry and every main check, under a hard cap". Before: `doctorTimeBound is not a function`.

`tests/providers.test.mjs` (3):

- "dev.85: a stopped process is named by its label or executable, with how long it ran and its limit, never as a provider by default": real child processes. Before: `actual: 'Provider timeout', expected: 'factory CLI doctor timed out after 0 s'`.
- "dev.85: a provider invocation that times out says it was the provider". Before: `ProviderError: Provider transport failed` (no label reached the transport).
- "dev.85: a preflight failure says which call failed and how: timeout, missing CLI, process error, invalid result or auth" (and the auth output is not kept). Before: `ProviderError: CLI preflight process failed before model launch`.

No existing test changed. `tests/upgrade-apply.test.mjs`'s fixture gained an optional `cli` source for the merged release; the existing "apply refuses undrained work…" test still matches `config update failed: invalid configuration` unchanged.

Full run after the first round (`c6e8fc4`): `npm test` 1245 pass, 0 fail (1245 tests); `npm run eval` exit 0; `git diff --check` clean.

## Review fixes

An independent review of `c6e8fc4` (GPT-6.1 Sol) approved it with fixes. It confirmed the root cause, the probe and retry accounting, that nothing parses the old messages, and that provider error codes, fallback and accounting are unchanged. It raised two blocking findings and one non-blocking one, and the operator added a fourth item on downtime. Fail-before evidence for this round was taken the same way as above, against an export of `c6e8fc4` with this round's test files copied in: the 6 new tests and the 3 changed ones fail there, as quoted (9 of the 10 selected; the tenth is the adjusted assertion noted under R4).

### R1 (blocking): the auth call's output was kept when the call failed in transport

**Problem.** `preflight` discarded the `auth status` output only when the call completed and the subscription check rejected it. When the call itself failed (a timeout, a process error), the transport's stderr was copied onto the preflight error like any other call's. An account name or home directory in it (`Account: person@example.invalid; home /home/person`) then reached doctor's excerpt, the `providers[role]` entry and the reason. Known-secret redaction does not remove either.

**Fix.**
- `preflight` never keeps the auth call's output on any path: its errors carry an empty `stderr`, and only the failure kind, the call and the exit status or process code remain. A process code is kept only if it looks like one (capital letters, digits and `_`).
- Doctor's `probeFailure` also ignores stderr on any error for the auth call (`call: 'auth status'`, `failure: 'auth'` or `BILLING_UNVERIFIED`), whoever raised it.

**Tests.**
- "dev.85 review: an auth status call that times out keeps none of its output, through the real adapter into doctor": the reviewer's repro through the real `createProviderAdapter` with a fake transport. Neither the account nor the path appears in the result, the stored record, the `project.doctor` event or the progress lines. Before: `actual: '…codex auth status timed out after 15 s\nstderr: Account: person@example.invalid; home /home/person'`.
- "dev.85: a preflight failure says which call failed and how…" (changed): an auth timeout and an auth rejection both carry an empty `stderr`, while a `--help` timeout keeps its stderr. Before: the auth timeout kept its stderr (`Received false`).
- "dev.85: a failed provider probe names the role, provider, model…" (changed): an injected auth failure carrying stderr is reported without it, and a `--version` failure's stderr is still reported, redacted. Before: `actual: '…(auth status exit code 1)\nstderr: Account: person@example.invalid; token [redacted]'`.

### R2 (blocking): redaction covered the excerpts, not the assembled diagnostics

**Problem.** Only the excerpts were redacted. Doctor sent raw route, provider and model text to the progress lines and built reasons around the excerpt with them, and those reasons also reached the `project.doctor` event. The upgrade recorded the command (with its paths) unredacted. With `OPENAI_API_KEY=fictional` and a model named `fictional`, `codex/fictional` stayed in the progress lines and the stored reason.

**Fix.**
- `redactSecretValues` (`core/redact.mjs`) applies `redactSecretText` to every string and object key of a value.
- **Doctor** starts with the environment's known secrets and adds the configuration's as soon as it is read. It redacts:
  - each progress line, phase and detail, before `onProgress`;
  - the whole `providers`, `reasons`, `warnings` and `gh` of the record it stores and returns;
  - the `project.doctor` event, which now takes the redacted reasons.
- **The upgrade** computes `knownSecrets(config)` once and redacts every step row as it is recorded (commands, paths, messages and excerpts alike), and the returned result as a whole.

**Tests.**
- "dev.85 review: known secrets are redacted from the whole of every doctor report…": `OPENAI_API_KEY` and the planner's model are both `fictionalsecretmodel1`. The progress reads `probe of planner (codex/[redacted])`, the reason `planner provider preflight failed for codex/[redacted]: …`, and the model field `[redacted]`. The secret appears in none of the progress, the result, the stored record or the event. Before: the progress held `probe of planner (codex/fictionalsecretmodel1)`.
- "dev.85 review: the upgrade result is redacted whole: commands, paths and messages of every step": the known secret is the sandbox folder's name, so it sits in every path the steps record. The doctor step's command and error show `[redacted]`, and the secret appears nowhere in the result. Before: `actual: 'node /tmp/…/fct-test-…/repo/factory/cli.mjs doctor --state …'`.

### R3: the time bound did not cover workspace setup

**Problem.** Main verification prepares its workspace with the configured `workspace.setup` commands, and those ran with no timeout (`adapters/workspace/index.mjs`), so a 90-minute setup could outlast the doctor limit.

**Fix: setup is bounded.**
- Each setup command now runs at most `workspace.setupTimeoutMs`, which defaults to `SETUP_TIMEOUT_MS` (30 minutes) and is limited to 4 hours. `validateConfig` refuses a value outside 1 ms–4 h, and `prepare` refuses one too.
- A command still running at its limit is terminated with its descendants: SIGTERM by process tree, then SIGKILL after `GIT_KILL_GRACE_MS`, as for Git calls. Setup then fails with `workspace setup timed out after N s (<command>)` and leaves the manifest `running`, exactly like a setup command that exits nonzero, so the workspace needs inspecting before a retry ("setup outcome uncertain").
- Every `prepare` caller (dispatch and maintenance, five sites) passes the configured value.
- `doctorTimeBound` adds the setup commands at that timeout (plus 1 s each), reported as `parts.setupMs`.
- The bound now describes itself accurately: the sum of doctor's own bounded phases plus the margin for its individually bounded Git and forge calls, under the 4-hour cap. `limitCapped` means the configured setup and checks alone exceed the cap.

**Compatibility.** A project whose setup command takes over 30 minutes must set `workspace.setupTimeoutMs`. That is documented in `docs/running.md`, `docs/updates.md` and the starter's `project/README.md`. Setups already running are unaffected until their workspace is prepared again. `setupDigest` is unchanged (the timeout is not part of it), so existing workspaces stay valid.

**Tests.**
- "dev.85 review: workspace setup is bounded; a command that outlives its timeout is stopped and setup fails": a `sleep 30; touch marker` setup with a 400 ms limit fails within seconds, with the message above. A second attempt reports the uncertain setup, the marker is never written, an invalid limit is refused, a quick setup still passes, and `validateConfig` accepts 1 h and refuses 5 h. Before: `Missing expected rejection` (the setup ran its full 30 s).
- "dev.85 review: doctor's time bound includes workspace setup at its configured or default timeout": two setup commands count 2 × (30 min + 1 s), a 90-minute `setupTimeoutMs` counts in full, and the doctor limit covers it. Before: `actual: undefined, expected: 0` (no `setupMs`).

### R4: units stayed down for the whole doctor step

**Problem.** The upgrade restarted every unit it stopped only after doctor. With doctor's new bound, the project runner and a checkout-owned console could stay down for most of four hours (mostly the permit wait), where they had been down for at most about ten minutes.

**What needs to be stopped, and for how long.**
- The runner lock is taken from the backup to the cleanup, so that the backup is consistent and the checkout does not change beneath a running service.
- Recommissioning (`config update --current`) needs drained work and no concurrent writer of the configuration, and it clears commissioning.
- Doctor itself needs neither unit stopped: with commissioning cleared, the doctor CLI does not take the exclusive runner lock.
- What a running unit would do during doctor:
  - The console only reads state and records commands, and with commissioning required it refuses `flow.start`.
  - The project service is different. Its engine advances a flow whose question is answered, checking only `stopRequested` and `recoveryHold`, not the admission pause or commissioning. A carried-over task flow answered during doctor would therefore run its next steps on the new code before doctor passes.
  - Without a pause, the service would also start scheduled maintenance flows, which would make the doctor that is running obsolete.

**Decision.**
- A console unit the upgrade stopped (one running from this checkout) is restarted right after recommissioning, before doctor. It runs the new code in the same state a shared console is in during any upgrade: commissioning required, admission held, `flow.start` refused.
- The project runner stays stopped until doctor ends, pass or fail. Its downtime is still bounded by the doctor limit. Starting it earlier would gain nothing safe: it could admit no task flow, and the work it could do (advancing an answered carried-over flow, starting maintenance) is exactly what must not run on unqualified code. Answers recorded in the console meanwhile are acted on once it starts.
- I did not add a commissioning gate to the engine so the runner could be started earlier. That would change how every carried-over flow behaves after any `config update`, which is a broader decision than this fix.

The same helper (`unitRestarts`) serves `--merge` and `--activate`. A failed recommission still restarts everything at the end, and doctor does not run.

**Tests.**
- "dev.85 review: the console comes back after recommissioning while the project runner stays stopped until doctor has ended": with both units active, both are stopped during recommission. During doctor the console is up, the project unit is down and commissioning is cleared. The step order is `…, recommission, start factotum-console.service, doctor, start factotum-project-….service`. A failed recommission ends with two `start` steps and no doctor. Before: `actual: { console: false, project: false, commissioning: null }`.
- "apply prepares a review worktree, then merges…" (changed): the expected order becomes `…, recommission, start, doctor`. Before: `actual: [ …, 'recommission', 'doctor', 'start' ]`.
- "dev.85: a doctor step that times out…" (assertion adjusted): the console's `start` step is recorded and the console is active. This assertion holds at `c6e8fc4` too.

### Docs

- `docs/updates.md`: the `--merge`/`--activate` step lists, what stays down and for how long, setup in the time bound, and whole-result redaction.
- `docs/running.md`: the auth output is never kept, whole-report redaction, and `workspace.setupTimeoutMs`.
- `starter/project/README.md`: `workspace.setupTimeoutMs`.

Full run after the review fixes: `npm test` 1251 pass, 0 fail (1251 tests); `npm run eval` exit 0; `git diff --check` clean.
