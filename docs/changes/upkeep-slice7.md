# Knowledge upkeep, slice 7: capture creation

Design: [knowledge-upkeep.md](../designs/knowledge-upkeep.md), section 15, slice 7 (sections 4.2, 4.3, 6.4, 6.5, 7.4, 9.4, 10.3 and 11.1). Base: `main` at `b5f3d84` (slices 1 to 6, the [governance-edit fix](governance-edit-context.md) and the [confusable-text matching](upkeep-confusables.md)). Built in `67cf958`; `main` at `3db7fe8`, which brought the [provider worktree isolation](provider-worktree-isolation.md), merged before the first full test run. The fixes for the [review of `6f83d54`](#review-of-6f83d54) are in `af51051`, with `main` at `539480a` (dev.90) merged before the final test run. See [The skill](#the-skill-and-provider-worktree-isolation).

This is a local implementation record, not a release or live qualification claim.

Slice 7 turns the assessment's capture candidates into reviewed work:

- **Recording.** In `propose`, the one capture candidate a run's validator kept is recorded: a `check` from its first flow, a `rule` or a `learning` from its second distinct flow (Q6). A flow yields at most one, however often it is assessed.
- **`check`.** `finding.accept {findingId, expectedVersion, files?, approve?}` writes one unapproved task of kind `check` that may change only the declared fast-check scripts, keeping their modes, within 2 files and 80 changed lines. Only the operator, directly, approves it (operator decision after the review).
- **`learning`.** `finding.accept {findingId, expectedVersion, paths?, approve?}` writes one unapproved task of kind `learning-add` that adds exactly one learning file, fixed at acceptance, of at most 1,500 characters.
- **`rule`.** Accepted only by the operator, directly, with slice 6's `finding.accept {proposals}`, into the same governance-edit `context` task, with every slice 6 gate.
- **Enforcement.** The `check` and `learning-add` columns of 7.4, in commit, integration, publication and merge. `ENFORCED_UPKEEP_KINDS` is now `docs`, `context`, `check`, `learning-add`.
- **The template and the skill.** `starter/project/LEARNING.template.md` and the optional orchestrator skill `starter/project/skills/factotum-compound/SKILL.md`.

## What was built

| Piece | Where |
| --- | --- |
| The check and learning-add markers; the learning file format (`renderLearning`, `parseLearning`, the frontmatter schema); both kinds enforced | `core/upkeep-namespace.mjs` |
| Which file is a fast check's script (`checkScriptOf`, `checkScripts`), what is offered at a commit (`offeredCheckScripts`), the declared files (`declaredCheckFiles`), the learning's fields | `operations/upkeep-capture.mjs` (new; writes nothing, starts nothing) |
| The `check` and `learning-add` columns of 7.4; an accepted rule's text must be in its file | `workflows/upkeep-enforcement.mjs` |
| Writing check and learning-add tasks (`createCaptureTaskInTransaction`), rules in the context task, recording a run's capture candidate (one per flow), the evidence blocks, the pin check for executable scripts and for a file that must not exist yet, the 14-day expiry | `operations/upkeep-tasks.mjs` (still the one upkeep module that writes a task) |
| A rule's digest, why a rule cannot be accepted, a returned rule read again, a capture title withheld in Health | `operations/upkeep-context.mjs` |
| A rule row keeps its governing file, blob and entries | `operations/upkeep-candidates.mjs` |
| The assessment passes the capture candidate in `propose`, a rule with the file its context anchor reaches | `workflows/upkeep-assess.mjs` |
| `finding.accept` of a check or learning candidate; `approve: true` for the operator, directly; the notice when a check task merges | `core/project.mjs` |
| Health: why a candidate cannot be accepted, each fast check's script, the open check and learning tasks, Accept forms | `operations/views.mjs`, `console/ui/operations.mjs` |
| The template, the skill, the starter README | `starter/project/` |
| Docs | `docs/operations.md` (new section "Capture candidates (propose)"), `docs/commands.md`, `core/command-help.mjs`, `contracts/README.md` |

### Check tasks

**Which file is a check's script** (7.4). From the check's `argv`, by exactly one of two rules:

1. `argv[0]` is a repository path (it contains `/`, is not absolute, has no `..`): the script is `argv[0]`.
2. `argv[0]` is the bare name of `node`, `deno`, `bun`, `python`, `python3`, `bash` or `sh`: the script is `argv[1]`, or `argv[2]` for `deno run` and `bun run`. It must not start with `-`.

Every other shape offers nothing, and no argument after the script is ever eligible. Then, conservatively, a script is offered only when:

- it is a plain repository path within the filename policy, with no hidden component, so never `.codex/`, `.agents/`, `.claude/`, `.mcp.json` or `.github/`;
- at the target head it is a tracked regular file (`100644` or `100755`) that resolves to itself, with no link on its path;
- it is not governing, not upgrade-owned and not in the learnings directory;
- **no other configured word names it**: no word of the configuration other than a fast check's own script position reaches the same file. Every string outside `fastChecks`, and every fast-check argument, is compared whole and split into tokens (on white space, quotes, `=`, `:`, `,`, `;` and parentheses); an absolute word is compared textually (equal to the script, or ending in `/<script>`), and every relative word or token is resolved in the tree, normalization and links included, so `checks/./verify.mjs`, `src/../checks/verify.mjs`, `--import=./checks/./verify.mjs` and a link to the script all reach it (`scriptsNamedElsewhere`, after the review). Past 4,000 distinct words nothing is offered.

**Executable scripts: what is enforced, and what is not.** A check script is code the factory runs on every candidate. Enforced:

- **The command.** The configuration, which says what runs and with which arguments, lives outside the repository; no task can change it.
- **The files.** Only the declared scripts may change. No file is added, deleted or renamed, and no link or submodule is touched. An input file, such as `src/schema.json` in `["checks/verify.mjs", "src/schema.json"]`, is refused.
- **The mode.** Each script keeps the mode it was offered at (`100755` stays executable, `100644` stays ordinary), on the candidate and in every own commit.
- **The configuration at each operation.** At each of the four operations the declared path must still be, under the configuration then in force, the script of the fast checks it was accepted for, and no other configured word may reach it, in the comparison tree or in the candidate's. A configuration change that moves the check to another script, or makes another command name the same file under any spelling, refuses the candidate.
- **The approval.** Only the operator, directly, approves a check task, bound to its revision and to each declared script's blob and mode (below).
- **The review.** The builder gets the rule as data, after a fixed instruction: add no file, command, process, dependency or network access. The reviewer is told to report as blocking anything beyond testing the rule.

Not enforced, and not claimed:

- **That nothing else uses the script.** String matching in configuration cannot prove it: a shell command the tokens do not expose, a glob, a directory argument, an import from another script or a sourced file can reach the script without naming it.
- **What the script does when it runs.** It can spawn processes, read or source other files and depend on its environment, and nothing bounds that.

Those rest on the reviewer, on the operator's own approval of the exact scripts, and on the merge decision, which is never automatic. Confining what checks can do when they run is the open [containment follow-up](../runtime-followups.md#containment-of-builder-and-check-processes-p2), which now names check tasks.

**Approval (operator decision after the review).** A check task is approved only by the operator, acting directly, on both schemas, as a governing edit is:

- `task.approve` (or `finding.accept` with `approve: true`) refuses the orchestrator, on any instruction, under any delegation and with any grant (on schema 2, even a grant pinning this exact revision and workflow), and refuses any command that cites a grant.
- It records `checkScriptsApproval: { revision, approvalVersion, approvedAt, files: [{ path, blob, mode }] }`. `checkScriptsApproved` requires it to name the current revision and approval version and exactly the marker's declared scripts.
- Admission, every step (`actionSpecification`) and commit, integration, publication and merge refuse a check task without it (`approval`).
- A delegated orchestrator may still accept a check candidate into an unapproved task. Strict risk is not added; it would not replace the approval.

**Declaring the files.** `files` names one or two offered scripts. Without it, the task declares the script of the fast check the candidate is anchored to (`check:<id>`). A candidate anchored elsewhere must name its files. A project with no fast checks refuses with the design's reason (10.3): a first check needs a new script and a graph node, which is ordinary work for the operator.

**When it merges.** An operator notice (`upkeep-check-delivered:<task>`) says that listing the rule in `fastChecks.checks[].rules`, so reviewers stop raising it, is a configuration change the operator makes (10.3).

### Learning-add tasks

**The file.** `<learnings.dir>/learning-<first 12 hex digits of the class key>.md`, fixed when the candidate is accepted. It has frontmatter of exactly seven fields, one per line, in this order, then a blank line, the body and a final newline (`renderLearning`; `LEARNING.template.md`):

| Field | Value |
| --- | --- |
| `id` | `learning-` and the 12 hex digits |
| `title` | The accepted title, written as JSON |
| `paths` | Globs, written as JSON; `<dir>/**` for a `dir:` anchor, otherwise the `paths` the accepting person named |
| `kind` | The candidate's topic |
| `enforced_by` | `none` |
| `last_verified` | The acceptance date (UTC) |
| `retire_when` | `none` |

The body is the accepted text. The whole file is at most 1,500 characters. Acceptance refuses a file that would be longer, a store that already holds `learnings.maxEntries` entries, a missing `learnings.dir`, and a directory that is linked or governing at the target head.

**What the check enforces.** The candidate makes exactly one change, adding the declared file, directly inside the learnings directory. That directory must be named exactly and reached through no link in either tree, and must be the directory the task was accepted for. The file must be ordinary and not executable, must not exist before (in any letter case), must parse under the strict layout, and must have every frontmatter field and the body equal to the marker's. It is at most 1,500 characters, and the store stays within `learnings.maxEntries`. The builder is given the exact file (`F1`) as data. The reviewer is told to inspect the text (6.5).

### Rules

A rule is a capture candidate in governing-rule form. When it is anchored to a governing entry (`context:<id>`), the run records the file that entry reaches at the merge commit, the file's blob and every entry that reaches it, as for a proposal. The operator accepts it with `finding.accept {proposals}`, alone or in a batch with proposals.

- **The digest** covers its file, title, text, reason, anchor, topic, blob and entries.
- **Every slice 6 gate applies:** operator only, directly; the version and the displayed digest; required, unmapped entries; one open context task; `governingEdits` and the operator's own approval; `upkeep.context.qualifiedProviders`; the pin check; the return and revalidation.
- **The criterion:** `P1: the rule text in evidence N1 is added, exactly as written there, as one condition where it belongs in the declared governing file evidence P1 names.`
- **The text** is at most 10 lines, within the context task's 12 changed lines.
- **The check:** the context column now also requires each accepted rule's text to be in its file afterwards, whitespace collapsed (`rule-text`).
- **A rule anchored elsewhere** has no governing file. It is listed with why it cannot be accepted.

## Preconditions and integration

| Item | What this slice does |
| --- | --- |
| Text rules on every model-written field | The validator already judged a capture candidate's title, text and reason, confusables included (slices 3 and 6). Acceptance judges the stored title, text and reason again: a check, learning or rule whose stored text fails is refused. Health now also withholds a capture candidate's title when it fails (a docs or context title is repository text and is unchanged) |
| Enforcement and markers | `check` and `learning-add` are enforced kinds. The markers `createCaptureTaskInTransaction` writes pass `checkMarkerProblems` and `learningMarkerProblems`, which admission and the four operations read. Tests run part A's check on created and fixture tasks |
| 4.5 | Acceptance reads the row, the task, the meta rows and seven `upkeepDay` rows by key, the namespace index, and one Git read of the recorded target head (4.5's task-creation row). A test shows it reads no whole kind. One capture per flow is remembered on the run row, read by key. No SQL JSON read over `records.data` was added. The idle tick is unchanged |
| Graph digests | Unchanged: no node and no reference graph changed |

### The skill and provider worktree isolation

Design 10.3: "The starter ships `LEARNING.template.md` and an optional `factotum-compound` skill for the orchestrator. In-flow agents do not load skills; they get the gate through the task."

**My reading.** The skill is project-owned guidance for the orchestrator, the operator's agent working outside any flow. It is installed like `use-factotum` and `factotum-workflows`. It is not a provider skill that factory steps load. It covers:

- the capture gate (would a later agent repeat this, and the cheapest form that works);
- who may accept, decline and approve each kind;
- the commands;
- what each task may change.

Factory steps never rely on it:

- the task carries what a flow must do (its criteria and its evidence block);
- Claude Code steps already run with `--safe-mode` and no setting sources;
- since the [provider worktree isolation](provider-worktree-isolation.md) change, merged into this branch from `main` at `3db7fe8`, every provider step runs with every skill disabled, the repository's and the operator's own: Codex from an empty working root, Claude Code with `--disable-slash-commands`.

The skill says so, and says not to copy it into a folder a task may change. No check script in a hidden folder is offered, so a check task can never declare `.codex/`, `.agents/`, `.claude/` or `.mcp.json` content. That agrees with that change's second line, which refuses a candidate that changes undeclared provider configuration, and which now runs beside the upkeep check at the same operations.

## Decisions where the design was ambiguous

Each is the conservative reading.

| # | Point | What this slice does |
| --- | --- | --- |
| 1 | Who declares a check task's files ("only the script can be declared") | The accepting person, from the offered list (`files`), defaulting to the anchored check's script. The factory offers and pins them |
| 2 | Which scripts are offered | The two rules of 7.4, plus: filename policy, no hidden component, no link on the path, and no other configured word reaching the same file once resolved in the tree (after the review) |
| 3 | When the script identity is judged | At acceptance, at the target head, and again under the configuration current at each of the four operations |
| 4 | A check script's mode | `100644` or `100755`, pinned at the mode offered, never changed in the candidate or in any own commit |
| 5 | What a learning file must equal | Every frontmatter field and the body, not only `id` and `paths`: the design says the builder applies exactly the accepted text (6.5) |
| 6 | A learning's `paths`, `kind`, `enforced_by`, `retire_when`, `last_verified` | `<dir>/**` from a `dir:` anchor (otherwise the person names them); the topic; `none`; `none`; the acceptance date. `retire_when: none` is allowed beside the three typed forms of 11.4 |
| 7 | The learnings cap | Every non-folder entry directly in the directory counts; at the cap acceptance is refused, and the check refuses a candidate that would pass it |
| 8 | One capture candidate per flow | Per run by the validator (as before), and across runs of the same flow by `captureRecorded` on the run row |
| 9 | Open capture tasks | At most one open `check` task and one open `learning-add` task, each counted against the daily, weekly and open-task ceilings |
| 10 | "Accept and approve in one command" (4.3) | `approve: true`, the operator acting directly only; the orchestrator never approves through `finding.accept`. A check task is approved only by the operator, directly, whichever way (operator decision after the review) |
| 11 | A rule anchored to a check or a directory | Dropped by the validator (`rule-not-governing`) and never recorded (after the review, Q1). A row recorded before this change is still listed with why it cannot be accepted |
| 12 | A rule's length | At most 10 lines, inside the 12 lines per proposal of P3 |
| 13 | A rule's text in the delivered file | Required as written (`rule-text`), beyond the design's line budget, because the builder applies exactly the accepted text |
| 14 | Capture suspension and rules | A suspended capture part also refuses accepting a batch that holds a rule |
| 15 | "The completion notice says so" (10.3) | One operator notice per merged check task |

## Compatibility

- **Graph digests:** unchanged. The digest tests pass.
- **State:** no schema, layout or index change. New fields:
  - on a run: `captureRecorded`; a run's dropped counts may name `rule-not-governing`;
  - on a check task: `checkScriptsApproval`;
  - on a rule row: `file`, `blob`, `entries`;
  - `upkeepOpen.captureTasks`;
  - on a check or learning task: `createdBy: 'finding-accept'`;
  - one inbox item per merged check task.
- **Behaviour changes for every project:**
  - In `propose`, capture candidates are now recorded rather than only counted, so Health may list check, rule and learning candidates.
  - Health withholds a capture candidate's title that fails the text rules.
  - The context check refuses a context task whose accepted rule's text is not in its file.
  - The assessment's instruction now says a rule is anchored to the context anchor of its governing file, and the validator drops one that is not.
- **Going back to an earlier release:** set `upkeep.mode` to `observe` or `off`, and decline or finish open check and learning-add tasks first. An earlier release refuses those markers at admission and at the four operations, which fails closed. Rule rows would show there as unacceptable proposals without a quote.

### For the release notes

- **Knowledge upkeep turns lessons into reviewed work (`propose`).**
  - **What is recorded.** When a flow's review, fast check or gate caught a mistake that a later agent would plausibly repeat, upkeep may record one capture candidate for that flow: a **check** (a rule a fast-check script can test), a **rule** (one condition for an existing governing file) or a **learning** (what neither can hold). Health lists it, with why it can or cannot be accepted.
  - **A check.** Accept it in Health, or with `finding.accept {findingId, expectedVersion, files?}` (you, or the orchestrator on your instruction). It becomes one task that may change only the named fast-check scripts, keeping their modes, within 2 files and 80 lines, checked at commit, integration, publication and merge. **Only you can approve it**, directly: never the orchestrator, on any instruction, delegation or grant, on either schema; the approval covers that revision and those exact scripts. Only a fast check's own script can be named: never an input file, and never a file another command or setting in your configuration names, under any spelling or through a link. A command that hides its script (`npm run`, `sh -c`, an option before the script) offers nothing. This does not prove nothing else runs the script (a shell command, an import or a sourced file can reach it without naming it), and nothing bounds what the script does when it runs: read the change before you approve and merge it. After it merges, list the rule in `fastChecks.checks[].rules` yourself if reviewers should stop raising it.
  - **A learning.** Accept it with `finding.accept {findingId, expectedVersion, paths?}`; it needs `learnings.dir`. It becomes one task that adds exactly one file, written exactly as accepted (see `project/LEARNING.template.md`), of at most 1,500 characters.
  - **A rule.** Only you accept it, directly, with the governing-context proposals, into the same approved task: it adds exactly the text you read to the governing file it names. A rule not anchored to a governing-context entry is dropped and never shown.
  - **Approval.** A check or learning task is not approved until it is approved. Add `approve: true` to accept and approve in one step (you only). A check task only you approve; a learning task as any task (on a migrated project the orchestrator needs a grant for that exact task).
  - **Learnings.** `retire_when: none` is accepted beside the three typed conditions.
- **New in the starter:** `project/LEARNING.template.md`, and an optional orchestrator skill, `project/skills/factotum-compound/`, which explains the capture gate and the commands. Factory steps never load it.
- **Going back:** set `upkeep.mode` to `observe` or `off`, and decline or finish open check and learning tasks first.

## Tests

New file `tests/upkeep-capture.test.mjs`, 20 tests (16 in `67cf958`, 4 from the review). In the dispatch fixtures the forge is a scripted `gh`. Elsewhere the model is scripted, and no provider process starts.

The tests changed because the behaviour changed:

- `upkeep-namespace`, `upkeep-context`, `upkeep-lifecycle`: `ENFORCED_UPKEEP_KINDS` is `['docs', 'context', 'check', 'learning-add']`.
- `upkeep-lifecycle`: a check or learning candidate named with a brief or a task is refused with its own message. They are accepted with `files` or `paths` instead.
- `upkeep-docs-enforcement`: the unknown-kind example is now `learning-retire`, and a docs marker relabelled `check` is refused as unreadable.
- `upkeep-assessment` (review): `rule-not-governing` is a validator rule, with two scripted results that break it.

### Acceptance (section 15, slice 7)

| # | Acceptance item | Test (`tests/upkeep-capture.test.mjs`) |
| --- | --- | --- |
| 1 | A change to an executable fast-check script that keeps its mode is delivered | "check acceptance 1": `checks/verify.mjs` (`100755`, `argv[0]`) committed, integrated, published (still `100755`) and merged; then an ordinary interpreter script and an executable one in one task |
| 2 | One that changes the mode or adds a file is refused | "check acceptance 2". Refused at publication, with the forge not called: executable to ordinary; ordinary to executable; an added helper; the input file `src/schema.json`; a mode changed in an own commit and changed back; a deletion; a link; 81 lines; an undeclared second script; a configuration that moved the check, or made the gate run the script; a stale pin. Commit (undone), integration and merge refuse too |
| 3 | One new learning file is delivered | "learning acceptance 1" |
| 4 | A second file, a file outside the directory, an over-long file or a frontmatter mismatch is refused | "learning acceptance 2". Also: another file; an existing learning changed or deleted; a learning written outside the directory; a configured directory that differs; a linked learnings directory; an over-long file; another id; other paths; a missing field; a changed order; an unknown `retire_when`; another body; an executable file; a path that already exists; a full store; a marker whose path is outside its directory |
| 5 | A capture candidate without a verified correction is dropped | "the assessment …" (a proposing run citing no signal: `no-verified-correction`, nothing recorded) and "the validator …" (a weak signal alone is not a verified correction) |
| 6 | An anchor or topic outside the offered lists is dropped | "the assessment …": `check:nonexistent` and a `dir:` anchor no signal named (`anchor-not-offered`), and `security` (`topic-not-offered`); nothing recorded |
| 7 | At most one per flow | "the assessment …": two in one answer (the second `over-count`, one row raised), and a manual re-run of the same flow answering another capture records nothing |
| 8 | For a command that names both its script and an input file only the script can be declared; each ambiguous shape offers nothing | "check acceptance 3": `files: ['src/schema.json']` refused naming why; only `checks/verify.mjs` and `checks/lint.mjs` offered; 17 ambiguous shapes give no script; scripts named elsewhere are not offered; a project whose checks are all ambiguous refuses with each check's reason |
| 9 | A check candidate on a project with no fast checks cannot be accepted and says why | "check acceptance 4" (the refusal and Health carry the 10.3 reason) |
| R | `rule` candidates reuse slice 6's acceptance | "rules: a rule is accepted only by the operator …" (named by findingId refused; the orchestrator refused with and without an instruction; a wrong digest refused; one approved context task with `governingEdits`; `qualifiedProviders` refuses admission; a rule anchored elsewhere and a hostile rule refused) and "rules: an accepted rule in a context task is delivered when its text is in its governing file …" |
| T | Text rules and confusables on every model-written field | "the validator …" (title, text and reason, three hostile forms each) and "Health …" (a stored title that fails is withheld and refused at acceptance) |
| E | Enforcement columns and created markers agree | "check acceptance 3", "learnings …" (created markers pass `checkMarkerProblems` and `learningMarkerProblems` and `upkeepMarkerRefusal`; the part A fixtures use the same shapes) |
| S | The template and the skill | "the starter …" |
| — | Who may accept and approve; evidence; pins; the completion notice; Health at 320 px; 4.5 | "who …", "a check task …", "learnings …", "Health …", "4.5 …" |

### Fail-before evidence

At `b5f3d84` the new test file fails to load: `operations/upkeep-capture.mjs` and the new exports do not exist. Each row below is one partial revert of this slice's source, run against `tests/upkeep-capture.test.mjs` (16 tests).

| Source state | Fails |
| --- | --- |
| The source at `b5f3d84` with the new tests | the file fails to load (`operations/upkeep-capture.mjs` does not exist) |
| check and learning-add not enforced kinds | 7 (4.5, check acceptance 1, check acceptance 2, check acceptance 3, learning acceptance 1, learning acceptance 2, learnings) |
| A check script may change mode (executable allowed, mode not pinned) | 1 (check acceptance 2) |
| The script identity not judged again at each operation | 1 (check acceptance 2) |
| No learning content rules (layout, fields, body, length, cap) | 1 (learning acceptance 2) |
| A learning may be outside the learnings directory | 1 (learning acceptance 2) |
| Capture candidates not recorded by a proposing run | 1 (the assessment) |
| No one-per-flow memory across runs | 1 (the assessment) |
| Any file may be declared for a check task | 1 (check acceptance 3) |
| Ambiguous shapes offer their next argument | 1 (check acceptance 3) |
| Scripts named elsewhere in the configuration are offered | 2 (check acceptance 2, check acceptance 3) |
| No refusal for a project without fast checks | 1 (check acceptance 4) |
| An accepted rule need not land as written | 1 (rules (delivery)) |
| Rules not accepted with proposals | 1 (rules (acceptance)) |
| approve: true allowed to a delegate | 1 (who) |
| Stored capture text not judged again | 1 (Health) |
| A rule row keeps no governing file | 2 (rules (acceptance), the assessment) |
| Executable modes refused for check scripts (docs rule) | 1 (check acceptance 1) |
| Pin check reads only ordinary files, and no absent learning | 1 (a check task) |

The validator's drops (no verified correction, an anchor or topic not offered, the count) existed before this slice (slices 3 and 6). "the assessment" fails before because no capture candidate was recorded at all: its positive control fails, not its drops. "the validator" and "the starter" fail at the base only because what they import does not exist.

### Results

On this branch with `main` at `539480a` merged, after the review's fixes:

- `npm test`: 1,755 tests, 1,754 pass, 0 fail, 0 cancelled, 1 skipped (the confusables whole-source test, which needs `FACTOTUM_CONFUSABLES_TXT`).
- `node --test tests/upkeep-capture.test.mjs`: 20 of 20.
- `npm run eval`: exit 0.
- `git diff --check b5f3d84..HEAD`: clean.

Earlier, with `main` at `3db7fe8` merged (`6f83d54`): 1,731 tests, 1,730 pass, 1 skipped; eval exit 0. Before that merge, at `67cf958`: 1,717 tests, 1,715 pass, 1 fail, 1 skipped. The failure was a starter-guide link from the skill folder to `LEARNING.template.md`, outside what a copied skill folder holds; the skill now names the template in plain text.

No real provider CLI was started.

## Review of `6f83d54`

Independent review (GPT-6.1 Sol): changes requested, one P2 and one operator decision. It confirmed the acceptance assertions, authority, the injection defences, the enforcement columns, the skill's placement, the read limits and the digests. Each fix has a test that fails without it.

**P2. "Used by nothing else" missed the same script under another spelling** (`operations/upkeep-capture.mjs`). Repro: `fastChecks` runs `checks/verify.mjs` and a gate check runs `node checks/./verify.mjs`; the script stayed offered, and a change to it passed all four operations.

*Fix:* `scriptsNamedElsewhere` resolves every word and token of the configuration in the tree (normalization and links included) and withholds a script any of them reaches, at acceptance (the target head) and at each of the four operations (the comparison and the candidate's tree). The docs now state what is enforced and what is not, here, in `docs/operations.md`, the skill, the release notes and the runtime follow-up on containment.

*Test:* "review of 6f83d54, P2: …". The repro, a fast-check argument `src/../checks/./verify.mjs`, a main check that runs a link to the script, a shell string, and an option, are each not offered; the repro is refused at commit (undone), integration, publication and merge; the same change under the plain configuration is delivered.

**Operator decision. Check tasks need the operator's direct approval.** Done as described under [Approval](#check-tasks). Design 9.1 and the actor table of 4.3 are amended (dated, 2026-11-16).

*Tests:* "operator decision: only the operator, directly, approves a check task, on schema 1 and schema 2 …" (the reviewer's repro: a schema-1 orchestrator approving under delegation, refused; on schema 2 the same, and with an exact grant; nothing approved and no flow admitted; the operator directly approves, bound to the revision and scripts, a direct-operator use on schema 2; revoked, it lapses; an approval forged onto the record refuses admission) and "operator decision: a check task without the operator's own, current approval …" (no record, another revision, an older approval version, other scripts: each refused at publication).

**Not covered by a test:** the step-level check in `actionSpecification` (`assertCheckScriptsApproved` before every step). Admission and the four operations, which are tested, refuse the same task; a step is reached only through admission.

**Open questions, as the reviewer recommended and the operator settled:**

| # | Settled |
| --- | --- |
| Q1 | Rules not anchored to a governing-context entry are dropped at validation, under `rule-not-governing`, recorded in the run's dropped counts. Test: "review of 6f83d54, Q1: …" |
| Q2 | Replaced by the P2 fix |
| Q3 | The operator's direct approval (above); strict risk is not added |
| Q4, Q5, Q6, Q8 | Kept as built: no hidden folders; exact learning files; one open check and one open learning-add task; the design's seven interpreters |
| Q7 | `retire_when: none` is accepted; design 11.4 amended |

### Fail-before evidence for the review

Each row is one partial revert of the fixed source, run against `tests/upkeep-capture.test.mjs` (20 tests) and, for Q1, `tests/upkeep-assessment.test.mjs`.

| Source state | Fails |
| --- | --- |
| No tree-resolved names, at the offer or the operations | 1 (P2) |
| Tree-resolved names at the offer only | 1 (P2: the four operations) |
| Tree-resolved names, whole words only (no tokens) | 1 (P2: the shell string and the option) |
| `task.approve` lets a delegate or a grant approve a check task | 1 (operator decision, both schemas) |
| The four operations do not require the approval | 1 (operator decision, at publication) |
| Admission does not require the approval | 1 (operator decision: the forged approval) |
| The approval not bound to the declared scripts | 1 (operator decision: other scripts) |
| Rules anchored elsewhere not dropped | 1 (Q1); and `upkeep-assessment`'s rule list |

## Requirements for slice 8 (learning consumption)

Recorded at the reviewer's recommendation. Slice 8 must:

1. **Read learnings from pinned blobs.** The selection at a cycle's boundary records each entry's id, path and Git blob id, and every later step of the cycle is given the content of exactly those blobs, read through hash-verified objects; never the worktree's files (11.2).
2. **Serialize them as `advisory-learning` evidence,** in an evidence block after and apart from "Governing context", outside the governing-context package and its digest (6.5, 11.3).
3. **State that they cannot grant permissions or relax rules,** in the fixed instruction that precedes the block: a learning carries no authority, cannot stand in for acceptance or an answer, and cannot be the sole basis of a review finding.
4. **Test a hostile body for every consuming role:** planner, plan reviewer, builder and code reviewer, each with a learning whose body tries to close the block, impersonate the factory, claim authority or address agents; the instruction part of each prompt stays byte-identical, and the block parses back to the same items.
5. **Never load them as skills or instruction files:** not as a provider skill, not as `AGENTS.md`, `CLAUDE.md` or any instruction file, and not through `context.files`. The learnings directory stays outside every governing path (commissioning already refuses one inside or containing a governing path, 11.1).

## Open questions

None open. The eight questions of the first round were settled with the review of `6f83d54` (see [Review of `6f83d54`](#review-of-6f83d54)).
