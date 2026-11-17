# dev.82 runtime fixes from the dev.81 readiness trial

Runtime code for the items [dev82-docs-t3.md](dev82-docs-t3.md) listed under "Needs runtime code, not documentation" (F7, F8, F10, F11, F20, F21, F24, F33, F36), with the docs that described the workarounds updated. Not a release. All tests are in `tests/trial-code-items.test.mjs`; everything in them is fictional.

**Fail-before evidence.** The new test file was run against the base commit `c84a770` (extracted with `git archive` into a scratch directory, new test file copied in, no source changes): 0 of 10 passed. The failure for each item is quoted below. With the changes, 10 of 10 pass.

## F7: keep the exact prompt

**Problem.** The prompt dispatch assembles and sends to the provider CLI on stdin was not kept, so "what was the model told" had to be re-derived from the intent.

**Fix.** `workflows/prompt-record.mjs` `recordPrompt` writes the prompt to `prompt.txt` in the provider's artifact directory (`attempts/<id>/provider/prompt.txt`; a plan-review correction turn uses `provider-protocol-correction-1/`) before the provider starts. The directory is 0700 and the file 0600, as for `stdout.jsonl`. Dispatch's `provider()` wrapper calls it for every planner, plan-review, builder and reviewer turn and adds `promptDigest` (SHA-256 of the prompt as sent) to the action result. Nothing goes into the SQLite attempt record beyond that digest in the action result, which already lives there.

Dispatch redacted nothing before. Credential-shaped text is now replaced with `[redacted]` before the file is written, using the patterns the GitHub adapter already applied to error evidence (GitHub tokens, bearer and basic credentials, `token=`/`password=`/`secret=`-style assignments, URL userinfo), moved to `core/redact.mjs` and extended with `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `CODEX_API_KEY`; `adapters/github/errors.mjs` now uses the shared function. When something was replaced, the result also has `promptRedacted: true`, and the digest then differs from the file's.

Retention, backup and archives already take the whole `attempts/` tree (`core/backup.mjs` copies it, `archive-retention.mjs` protects it), so the file travels with the attempt; the test checks a backup. The console and project service artifact allowlists and the timeline evidence viewer include `provider/prompt.txt`; the service's `publicValue` still removes private paths and token patterns from what it serves.

**Compatibility.** Additive. Attempts from earlier releases have no `prompt.txt`.

**Test.** Runs `provider.planReview` through `runAction` with a fake provider and operator feedback holding a GitHub token and a password; checks the file equals the redacted prompt, modes 0600/0700, `promptDigest` and `promptRedacted`, the correction turn's own file, an unredacted prompt's digest matching the file, and a backup copy. Before: `ENOENT: no such file or directory, open '…/provider-protocol-correction-1/prompt.txt'`.

**Left.** The maintenance audit's fixed prompt (`workflows/maintenance.mjs`) is not recorded; it contains no task content.

## F8: brief `outcome`

**Problem.** `importGitHubTask` used only the issue title; a brief's `outcome` was dropped, and the agent brief was `Task <id>: <title>` plus acceptance.

**Fix.** `outcome` is a brief field (`core/project.mjs` `BRIEF_FIELDS`), validated by `task.put` (non-empty string, at most 4000 characters) and part of the approved brief. Import sets it when the brief's `outcome` differs from the issue title. The agent brief gains `Outcome: …` after the task line when present. The title is unchanged. Recurring tasks keep treating `outcome` as the title (they have no separate title), which is consistent: the same field name means the statement of the result.

**Compatibility.** A task an earlier release imported without its outcome keeps its revision and approval on re-import while its issue is unchanged (same `source.revision`); the outcome is added the next time the issue changes, which needs approval anyway. Tasks without an outcome keep their revision. `task.put` help lists the field.

**Test.** Import with an outcome, an outcome equal to the title, the prompt line through `runAction`, validation, revision effect, and the legacy re-import keeping approval. Before: `importGitHubTask` returned no `outcome` (`Expected values to be strictly equal`).

**Docs.** `integrations/github.md`, `project-workflows.md`, the workflows skill, `task.put` help.

## F10: merge commit titles

**Problem.** Merge and squash commits were titled `Factotum delivery <flow uuid>`.

**Fix.** `workflows/merge-message.mjs` `mergeCommitText`: title `<task title> (#<PR>)`, one line, control characters removed, whitespace collapsed, at most 100 characters (shortened with `…`), falling back to `Factotum delivery (#<PR>)` if it would read as a GitHub closing reference or is empty. Message: `Approved and independently verified candidate.`, then `Task: <task id>` and `Factotum flow: <flow id>`. Dispatch's `forge.merge` passes both. Merge methods: `merge` and `squash` send them; `rebase` sends neither (GitHub does not take them), and the replayed candidate commits already carry the task title and `Factotum flow: <id>` (`workspace.commit`). There is no local merge path for deliveries: `target.sync` is a branch sync with its own `Merge <from> into <into> (Factotum)` title, unchanged.

**Compatibility.** Old merge commits keep their `Factotum delivery <uuid>` titles; new ones have the flow ID in the message (`Factotum flow: <uuid>`). Tooling that matched the subject should search for the flow ID anywhere in the message (`git log --grep <flow id>`), which finds both. Documented in `github.md`.

**Test.** Title and message shape, length bound, closing-reference and control-character fallbacks, and the GitHub adapter's PUT body for all three methods; a source check that dispatch uses it. Before: `ERR_MODULE_NOT_FOUND` for `merge-message.mjs`.

**Docs.** `integrations/github.md`, the setup checklist.

## F11: readable plan comment

**Problem.** The reviewed-plan comment on the issue was `Reviewed implementation plan` followed by raw JSON with escaped newlines.

**Fix.** `workflows/plan-comment.mjs` `renderPlanComment` renders Markdown: summary, steps, files (code spans), checks, risks, risk assessment with threat model and stop conditions, departures, unverified acceptance, open questions, then the review verdict, summary and findings, and the flow ID. Model text is escaped: `&`, `<`, `>` become entities (no raw HTML), Markdown punctuation is backslash-escaped (no links, images, headings, tables or emphasis formed from model text), every `@` is followed by a word joiner (U+2060) so no user or team is mentioned, control characters are removed. Each field is bounded (2000 characters for paragraphs, 500 per list item), each list to 40 items with a count of the rest, the whole comment to 60,000 characters.

Nothing parses the comment (checked: `publishReviewedPlan` compares only its own markers and the exact body for reconciliation; no reader of plan comments exists). The machine-readable plan and review remain the plan and plan-review attempts' `action-result.json`, which the comment points to.

**Compatibility.** The next `forge.publishPlan` on an issue replaces the old JSON comment through the existing canonical-comment update (same identity marker, new input digest). Reconciliation of an in-flight publication from an older release compares exact bodies, so a retried publication from before the upgrade writes the new body once.

**Test.** Structure, escaping of HTML, mentions and links, no JSON, size bound with 500 long steps, and a source check that dispatch uses it. Before: `ERR_MODULE_NOT_FOUND` for `plan-comment.mjs`.

**Docs.** `integrations/github.md`.

## F20: doctor and the operator checkout

**Problem.** Doctor required the operator checkout's HEAD to equal remote main, so it failed (`local root differs from current remote main`) after every merge until someone pulled.

**What relies on the checkout.** Reviewed in code:

- Deliveries run in owned worktrees created from the fetched remote target (`source.verify`); context, checks and reviews read the candidate; doctor's main checks run in a disposable worktree at the remote head. None needs the checkout current.
- The project service unit runs `<root>/factory/cli.mjs` (`operations/services.mjs`). A checkout behind on `factory/` runs an older factory than remote main records (the adoption lock and installed files). That stays refused.
- `config update` compiles project-owned workflow files from the checkout (`core/store.mjs`), and doctor compares that compilation with the files on disk. Command-source scripts run from the checkout (`commandSourceWrite(config, intent.projectRoot …)`). Being behind on these runs older project code; doctor warns and names changed files.

**Fix.** `workflows/commission.mjs` `operatorCheckout`: the checkout must be clean (unchanged check) and its HEAD must be remote main or an ancestor of it. When they differ, doctor fetches only the remote-tracking ref (never the branch, index or files), then refuses local commits not on the remote, and refuses when the commits it lacks touch the installed factory directory (the directory doctor runs from when it is inside the checkout, and `factory/`, where the service unit starts) or `factotum.lock.json`. Otherwise it passes with a warning: how many commits behind, up to five changed files, and what still reads the checkout.

(Review fix 3 below makes files the configuration runs as commands a refusal too.)

**Compatibility.** Strictly more permissive for checkouts that are only behind; a checkout with unpushed commits or behind on factory files is still refused, with a clearer reason.

**Test.** A real Git fixture with a bare remote and a second clone: behind by two non-factory commits passes with the warning; behind on `factory/core/…` is refused; after `pull --ff-only` it passes with no warning; a local unpushed commit is refused; the checkout's HEAD and status are unchanged by doctor. Before: `"reasons":["local root differs from current remote main"]`.

**Docs.** `running.md` (commissioning section, which said to pull first), the setup checklist, T3 setup step 8.

## F21: answer note on the item

**Problem.** A flow question's answer note was only in the flow's `answerNotes`; standalone items already had `answerNote`.

**Fix.** The `answer` command stores `answerNote` (bounded like the flow copy) on the answered flow question too; `flow.answerNotes` is unchanged. The console's inbox shows "Note: …" under an answered item and the record view lists "Answer note". `status` shows it because it is on the item. The webhook payload is unchanged: by design it carries no prose.

**Compatibility.** Additive. Items answered before keep no `answerNote`; their note is still in `flow.answerNotes`.

**Test.** A real flow question answered with a note: on the item, in the flow history and in `status`. Before: `answerNote` undefined.

**Docs.** The handling guide (`t3-notifications.example.md`), `communication.md`.

## F24: narrower CLI read

**Problem.** `status` printed the whole projection (about 790 KB after three flows), and agents needed `jq`.

**Fix.** `status --inbox <id>`, `--flow <id>`, `--task <id>` (any together) print `operations/state-view.mjs` `stateView`: the shape of the starter's state filter (project holds and causes, queue holds, health, spending, main health, operator presence, session, recent faults, open-item summaries, the item, the flow with per-step evidence, its last five attempts, the task with admission reasons, and its queue row), plus `task.outcome`. Everything is read by key or by one targeted query: attempts come from the flow's own `attempt.prepared` events and `store.get`; queue holds use a facade whose `all('attempt')` returns only attempts current flows own (the only ones that can be stalled launching); open items are one inbox query. It never calls `store.all('attempt')` (the test enforces this). `status --compact` prints the dashboard snapshot exactly as the service socket serves it (`publicValue(dashboardSnapshot(store))`). Plain `status` is unchanged.

**Compatibility.** Additive; the default output is byte-for-byte the same code path. The jq filter stays for earlier releases.

**Test.** Through the CLI: each narrow read, holds and queue holds present, attempts listed, `--compact` is `dashboard-v1`, default is the full snapshot, `--compact` with a narrow option refused, and `stateView` with `store.all('attempt')` trapped. Before: `cli.mjs status … --inbox …` failed in `parse_args` (unknown option).

**Docs.** `status` help in `core/command-help.mjs`, `running.md` (the known-limit paragraph became "prefer a narrow read"), both T3 files (`READ` is now the narrow read; the jq form is kept for releases before dev.82), the jq file's header, `starter/project/README.md`. `tests/t3-guide.test.mjs` passes unchanged.

## F33: reminder on ack, choice labels, presentation-end wakes

**Problem.** `delivery.ack` set an open question's next reminder four hours out even when the item's own interval (for example 24 hours) had scheduled it later; flow questions had answer IDs but no labels; a presentation-end wake looked like any other wake.

**Fix.**

- `acknowledgeDeliveryInTransaction` sets the next reminder to the later of four hours out and what was already scheduled. During a send, "already scheduled" is what that send would schedule (now plus the item's interval).
- Flow questions get `choices: [{id, label}]` from `operations/answer-labels.mjs`: fixed labels for the reference workflows' answers (`merge`, `send_back`, `stop`, `retry`, `replan`, `repair`, `accept`, `approve`, `done`, `blocked`, `continue`, `rollback`, `yes`, `no`), any other ID as words. Generic and only where nothing set labels; it adds no workflow schema field, so it does not compete with the planning work's own plan-question labels. The console uses the labels for the answer buttons (for example "Merge" instead of `Answer "merge"`).
- An inbox wake sent because a presentation ended carries `presentationEnded: true` and `presentationId`; other wakes do not have the fields.

**Compatibility.** The ack change only ever makes reminders later than before. Flow question items gain a field. Payload fields are additive; the T3 webhook prompt template gains an optional `presentation ended` part, and an existing prompt keeps working.

**Test.** A 24-hour question delivered, then acked: the reminder stays 24 hours out (before: moved to four hours, `the 24-hour reminder stays where it was`); a default question acked moves to four hours; a presentation-end wake's payload (signed as before) has the fields and others do not; a real flow question has labelled `choices`.

**Docs.** `operations.md` (reminders, acknowledgement, presentations), `communication.md`, both T3 files.

## F36: declared task paths

**Problem.** Declared `paths` were admission-only; checks were not told them and a candidate changing other files was not flagged.

**Fix.** `workflows/task-scope.mjs`. Gate and fast checks get `FACTOTUM_TASK_PATHS` (normalized declared paths, newline-separated, empty when none) and `FACTOTUM_TASK_PATHS_FILE` (the same list in `<prefix>-task-paths.txt` in the attempt directory, 0600). For a task with declared paths, `provider.review` lists the files the whole change (from the integrated base, not only a delta) touches outside them, and appends one separate sentence to the reviewer prompt: the declared paths, the out-of-path files (up to 50 named), and to treat each as a finding unless the reviewed plan justifies it. If the file list cannot be computed it says so instead of failing the review. The review result records `scope: {paths, outside (at most 200), outsideCount}`. The reviewer-prompt change is one appended guidance call, kept apart from the existing prompt text so it merges cleanly with the planning work's reviewer-prompt edits.

No built-in fast check was added. The starter fast-check example gained a `task-paths` rule using `FACTOTUM_TASK_PATHS`, off by default (`TASK_PATHS_RULE = false`); the older `one-area` rule stays for earlier releases.

**Compatibility.** Tasks without declared paths see no change in prompts or results. Checks get two extra environment variables.

**Test.** A real repository with a candidate touching `src/` and `other/`: a fast check reads both variables (normalized `src`, `docs`); the review prompt names `other/b.js` and the instruction; the result has `scope`; a task without paths gets no guidance. Before: the fast check failed with `FACTOTUM_TASK_PATHS_FILE` undefined.

**Docs.** `adoption.md`, `project-workflows.md` (fast-check environment), the setup checklist, the fast-check example.

## Review fixes

Independent review of `d3d625e` (GPT-6.1 Sol): approve with fixes, two blocking. All fixed in `4423349`, then `main` merged in `fc9eaca`. Fail-before for the new tests: run against `d3d625e` (extracted with `git archive`, new test file copied in), the F7, F24 and F20 review tests failed and the ack-during-send test passed (it is coverage the reviewer asked for, of behaviour `d3d625e` already had).

1. **Blocking: configured secrets reached `prompt.txt`.** Pattern redaction alone missed values with no recognisable shape, such as the notification signing key when the delivery file is in configured governing context. `operations/known-secrets.mjs` `knownSecrets(config)` now collects every secret value the factory process knows: the credential variables in its environment (`GH_TOKEN`, `GITHUB_TOKEN`, the enterprise variants, `FACTOTUM_GIT_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CODEX_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), the scoped GitHub token (new `scopedGitHubToken()` in `adapters/github/git.mjs`), every string of at least eight characters under a secret-named key anywhere in the configuration (token, secret, password, passphrase, credential, signing, API key, private key, authorization, cookie), and the delivery file's `signingKey`, `url` and other secret-named values. Each is also matched in its JSON-escaped form. Dispatch passes them to `recordPrompt`, which replaces each verbatim before the pattern pass; `promptRedacted: true` records that something was replaced. Test: the delivery file, an environment token and a configured provider key all in governing context; none is in `prompt.txt`, `promptRedacted` is set, `promptDigest` is still the digest of the prompt as sent. Before: `prompt.txt must not contain fictional-si…`.

   **Limit, not changed here:** the same secrets do reach the provider prompt itself. Governing context is sent as written (`brief` in `workflows/dispatch.mjs` includes every context file's text), and the test asserts that, so this limit stays visible. Context files must be inside the checkout (`operations/context.mjs`), so this needs a secret, or the delivery file, inside the repository and configured as context. `running.md` and the checklist say to keep secrets out of governing context.

2. **Blocking: `status --compact` loaded every attempt.** `dashboardSnapshot` passed its facade to `queueStatus`, whose launch-stalled check called `all('attempt')` (a projected SELECT of every attempt). `queueStatus` now uses `launchStalledAttempts(store)`: one query for unsettled `dispatching` attempts (`status = 'dispatching' AND settledAt IS NULL`), deliberately plain so the coming `store.live(kind)` and partial indexes can replace it. The dashboard facade exposes `db` for it, and the narrow read's own attempt facade is gone (it calls `queueStatus(store)`). Test: 60 settled attempts with large intents and one stalled launch; a trap on `db.prepare` counts the settled attempt rows any one query returns; `publicValue(dashboardSnapshot(store))` (what `status --compact` prints) and `stateView` both find the stalled launch and neither returns more than the 20 recent rows the dashboard lists. Before: `compact read loaded 60 settled attempts in one query`.

3. **Doctor refuses stale command files (operator decision, adopted from the review).** `workflows/commission.mjs` `configuredCommandPaths(config, root)` collects the repository paths the configuration runs: every argument of every `argv` or `command` list (gate, fast and main checks, preview, scheduled tasks, source and integration adapters) and of each `workspace.setup` command that is inside the checkout (absolute) or looks like a relative path (a slash or a file extension, no whitespace, not an option). `operatorCheckout` refuses when the commits the checkout lacks change one of them or a file under a directory one names: `… including files the configuration runs as commands (…)`. Workflow definitions stay warning-only. Test: a workflow file change only warns; a change to a configured fast-check script is refused; `configuredCommandPaths` finds preview (absolute), scheduled-task, source-adapter and setup paths and ignores `-e` code, bare binaries and options. Before: doctor passed with the warning (`Expected values to be strictly equal`).

4. **Coverage: `delivery.ack` during a send.** The transport acknowledges each delivery while it is `sending`: a 24-hour-interval question keeps its reminder 24 hours out, a default one moves to four hours, both end `accepted`, and the send's completion does not overwrite what the acknowledgement set.

**Merge of `main`** (R3 and planning convergence, `6789b04`, recorded at `a0efba0`). Conflicts and resolutions:

- `core/engine.mjs`: the flow question gets the generic `choices` first and main's `...(planItem ?? {})` after, so a plan question keeps `planQuestionItem`'s own labelled choices.
- `workflows/dispatch.mjs`: the change review keeps main's `reviewScopeGuidance` (which says hardening outside scope is not blocking) and the declared-path guidance. The latter now says explicitly that an out-of-path change without a justification in the plan is a blocking finding, not out-of-scope hardening.
- `adapters/github/errors.mjs`: main's control stripping moved to its shared `core/text.mjs` `stripControls`, combined with the shared `redactSecretText`. `workflows/plan-comment.mjs` and `workflows/merge-message.mjs` use `stripControls` too (C1 controls and escape sequences, which their own patterns missed).
- `docs/integrations/t3.md` and `t3-notifications.example.md`: plan questions keep main's labels and instructions; other flow questions name their generic labels.

**Hardcoded `factory/` (to reconcile with the install-prefix branch).** Added by this branch:

- `starter/factory/workflows/commission.mjs:34`, `factoryPaths`: `'factory'` beside the running factory directory relative to the checkout (the service unit starts `factory/cli.mjs`, `operations/services.mjs`). Its comment at line 25 names `factory/cli.mjs`.
- `tests/trial-code-items.test.mjs`: the F20 test pushes `factory/core/fictional.mjs` and expects the refusal to name it.
- Docs: `docs/running.md` (the doctor section: `factory/` files, `factory/cli.mjs`, "if a merge changed `factory/`"), `starter/project/SETUP_CHECKLIST.md` (doctor line), `docs/changes/dev82-trial-code-items.md` (this record).

Already on `main` and left as it is: `starter/factory/workflows/dispatch.mjs:251` (`workspace.commit` refuses `factory/` edits without `allowFactoryEdits`; line 242 before the merge).

**Test environment note.** One `npm test` run after `4423349` failed 39 unrelated tests with `/tmp` at 97% full (other sessions' data); an immediate rerun passed all 879. After the merge, `tests/main-check-tiers.test.mjs` "every health writer preserves scheduled-tier red evidence" failed once in a full run at its `attempt.resolve` step (a test from `main`; it passed 8 of 9 isolated runs and the next full run); this branch does not touch that path.

## Review fixes, round 2

Re-check of `3d4dbba` (GPT-6.1 Sol): approve with fixes, two blocking. The re-check confirmed compact status, the ack-during-send test and the merge resolutions.

1. **Blocking: short known secrets reached `prompt.txt`.** `knownSecrets` dropped values under eight characters, including secret-keyed configuration values and credential variables. Every known value of one character or more now counts: secret-keyed configuration strings, the listed credential variables, the scoped GitHub token and the delivery file's secrets. No length floor remains anywhere in the known-secret set; the only heuristic matching left is `core/redact.mjs`'s credential-shaped patterns, which have their own shapes. Test: the reviewer's repro (`{auth:{password:'tiny123'}}` with "Governing context: use tiny123 to log in") writes `[redacted]` and sets `promptRedacted`; a three-character `GH_TOKEN` and a one-character configured key are known; an empty value and non-secret keys are not. Before (on `3d4dbba`): `tiny123` was written unchanged.

2. **Blocking: doctor missed valid command-file paths.** Arguments with whitespace were discarded and paths with `..` were dropped instead of resolved. `configuredCommandPaths` now takes each argument whole and also split into shell words, resolves relative paths against the repository root with `posix.normalize` and absolute ones against the root's given and real paths, and keeps those that stay inside the repository. It fails safe where it cannot resolve: a leading `$VAR`, `${VAR}` or `~` is dropped and the rest taken as a repository path; an inner variable becomes a `*` wildcard, which `commandPathMatches` matches within one path segment. It also reads an integration adapter's declared implementation `files`. Tests: both repros end to end through doctor (`['node','scripts/my check.mjs']` and `['node','./scripts/../scripts/check.mjs']`, the script changed on the remote: refused, naming the file), plus a shell string, `--opt=path`, an absolute path inside the root, paths outside it, a leading and an inner variable, and adapter `files`. Before: both repros gave no command paths and doctor only warned. The documented gap is now: files a command reads without naming them (imports, `package.json` scripts behind `npm test`, Makefile targets), paths only in environment variables, and extensionless names without a slash. A `-e` code argument that names a file (for example `fixture.txt`) now counts, which is over-inclusion on the safe side.

3. **Redaction boundaries.** Each known secret is matched raw, JSON-escaped, URL-encoded (`encodeURIComponent`) and in base64 (standard padded and unpadded, and URL-safe). Documented in the module, `running.md` and above: a value wrapped across lines, encoded as part of longer data (at any offset; corrected in round 3), or transformed otherwise is not caught; exact matching over-redacts on purpose (a configured secret `integration` replaces every "integration"). Focused tests cover each form, the wrapped-line gap and the over-redaction.

4. **Flaky test from `main`: `tests/main-check-tiers.test.mjs` "every health writer …".** The test waited for the attempt to read as `uncertain` or `terminal` and then called `attempt.resolve`. The supervisor writes its receipt before it exits, so the receipt can be read while the supervisor is still alive, and `attempt.resolve` refuses until its owner is dead (`assertAttemptQuiescent`: `owned process or cgroup quiescence is not established`). The test now also waits until `ownerState(owner) === 'dead'` (the same check `attempt.resolve` makes) and reports the command's error if it is still refused. Production behaviour is right and unchanged: an attempt whose worker left no action result is uncertain whether or not its supervisor has exited yet, and reconciliation must wait for quiescence. Evidence, with a short `TMPDIR`: before the fix, 0 of 20 isolated runs and 0 of 24 runs at 6-way load failed on this machine, but 18 of 36 whole-file runs at 12-way parallel load failed at the `attempt.resolve` step. After it, 0 of 36 failed at the same 12-way load and 32 of 32 consecutive isolated runs passed.

## Verification

After round 2 (with a short `TMPDIR`, as the service tests need):

- `npm test`: 896 tests, 896 passed, 0 failed.
- `npm run eval`: exit 0.
- `git diff --check`: clean.
- Fail-before: the two round-2 tests fail on `3d4dbba` (the seven-character password written unchanged; the space and dot-segment paths missing from the command paths).

## Left and open

- Release notes: no entry written; the items above need one in the next development build's notes, including the merge title change and the doctor relaxation.
- F7: the maintenance audit prompt is not recorded. A secret the factory does not know (one not in its environment, configuration or delivery file) and without a recognisable shape would still be written, as it already is in the provider's own `stdout.jsonl` trace. A known secret wrapped across lines or transformed beyond the matched forms is not caught. Secrets in governing context reach the model (review fix 1).
- F20: doctor does not find command files a command reads without naming them (a script's imports, `package.json` scripts behind `npm test`, a Makefile target), paths given only through environment variables, or extensionless names without a slash. Workflow definitions only warn.
- F24: `flowDetails` on the service socket (`/v1/flows/:id`) still loads all attempts; left to the work removing full attempt scans.
- F33: labels are built-in English words for known IDs; a workflow cannot name its own labels yet.

## Review fixes, round 3 (root)

Re-check (GPT-6.1 Sol) of `d689cf1`: approve with fixes. Fixed by root:

- **Blocking: quoted shell paths with spaces were missed.** `configuredCommandPaths` split command strings on whitespace and quotes, so `sh -c 'node "scripts/my check.mjs"'` produced `scripts/my` and `check.mjs`. Command strings are now split into shell words the way `sh` does (single quotes literal, double quotes with backslash escapes, backslash escapes outside quotes), then at `=` and `,`.
- **Over-inclusion from inline code.** A name inside `node -e` (or `python -c`, `ruby -e` and similar) code made doctor refuse when, for example, `README.md` changed. Inline interpreter code is no longer scanned; `running.md` lists it as a gap. `sh -c` and `bash -c` strings are still scanned.
- **A lone surrogate in a secret aborted the turn** (`encodeURIComponent` throws). The URL-encoded form is skipped for such a value; the other forms remain.
- **Base64 limit understated.** A secret encoded as part of longer data is not matched at any offset, since surrounding bytes change the encoding groups. The module, `running.md` and round 2 above now say so.

Tests: two new tests in `tests/trial-code-items.test.mjs` (shell quoting and inline code; lone surrogate). All three affected tests fail with the source changes stashed and pass with them.
