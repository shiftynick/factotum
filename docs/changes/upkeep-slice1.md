# Knowledge upkeep, slice 1: record and access contracts, lesson signals, and the reservation

Design: [knowledge-upkeep.md](../designs/knowledge-upkeep.md), section 15, slice 1. Base: `main` at `c523d2c`.

This slice defines records, read paths and pure functions, and closes the `upkeep:` task namespace. It runs nothing: no model call, no setting that could cause one, no upkeep task. Nothing reads the `upkeep` or `learnings` configuration blocks yet.

**One existing behaviour changes.** The context loader now resolves a governing entry's path the way the kernel does, which is what section 7.1 assumes. See [the context loader](#the-context-loader-resolves-as-the-kernel-does) and its adopter note.

## What was built

| Piece | Where |
| --- | --- |
| The reservation predicate, the marker rule and the configuration check | `core/upkeep-namespace.mjs` (imports nothing) |
| Record kinds, meta keys, record invariants and every upkeep read | `operations/upkeep-records.mjs` |
| Two new indexes; `upkeepObserved` as a verified kind | `core/records.mjs` |
| Verification of a kind added by a later release | `operations/state-layout.mjs` |
| Class keys | `operations/upkeep-class-key.mjs` |
| Path resolution in a Git tree, the protected set, "governing in a tree" | `core/tree-paths.mjs` |
| Lesson signals, and `lessonSignals` on the retrospective | `operations/lesson-signals.mjs`, `operations/governance.mjs` |
| The context loader resolves as the kernel does | `operations/context.mjs` (`readEntry`) |
| The reservation at the task routes | `core/project.mjs` (`task.put`, recurring occurrences), `core/configuration.mjs`, `adapters/github/issue-profile.mjs`, `workflows/source-sync.mjs` |
| The unknown-kind refusal at five points | `core/project.mjs` (`admitFlow`), `operations/admission.mjs`, `workflows/dispatch.mjs` |

### The reservation (7.2)

One predicate everywhere: a value is reserved when, with ASCII lower-casing, it starts with `upkeep:`. `Upkeep:x` and `UPKEEP:x` are reserved as `upkeep:x` is.

| Route | Behaviour |
| --- | --- |
| `task.put`, and with it source sync and task import | Refuses to create a task whose id is reserved. Refuses the `upkeep` field on any task, new or existing. Refuses to edit a task that carries a marker (an edit would strip it). |
| Custom source namespace | `validateConfig` refuses `sourceSync.namespace`, so `config update`, `settings update`, `init` and `doctor` all report it. |
| GitHub id prefix | `validateIssueProfile` and `validateConfig` refuse `repository.issueProfile.dependencyIdPrefix`. |
| Source sync and task import | Refused whole, before anything is read from the source, with a reason that names the setting. The sync report carries that reason. |
| Recurring occurrences | Cannot collide (ids start `recurring:`, names have no colon). A test pins it, and `createRecurringOccurrence` refuses a reserved key. |
| Maintenance jobs | Ids start `job:`. Unchanged. |

### The unknown-kind refusal (7.4, 15)

`ENFORCED_UPKEEP_KINDS` is empty in this release, so every task that carries an `upkeep` marker is refused, whatever the marker holds and whatever the task's id:

- at admission (`admitFlow`, which `flow.start` uses for ordinary, adopted and already-satisfied starts; `admissionReasons` shows the hold with the task);
- inside `workspace.commit`, `workspace.integrate`, `forge.publish` and `forge.merge`, before the step reads or writes anything. The check is in the operation, so no graph routes around it.

A later slice adds a kind to that list together with its enforcement.

### Records and access paths (4)

- Kinds: `upkeepRun` (keyed by source flow id), `upkeepObserved` (class key), `upkeepDay` (UTC date), `upkeepWindow` (one row), `learningUse` (learning id). Candidates stay `finding` rows.
- Meta keys: `upkeepWork`, `upkeepOpen`, `upkeepSuspended`.
- Indexes: `records_open_task_lower_id` (open project tasks by `lower(id)`) and `records_upkeep_observed_first` (observed classes by first-observed time).
- Invariants enforced on write: one run per flow; `pendingUntil` written once; `runBy` never moved later (it may be shortened); day counters never negative; the window keeps the last 50 run outcomes and the last 20 disposed outputs per part; an observed class's first-observed time is written once.
- Every read is by primary key, by meta key, or through a declared index with a fixed row limit: the live finding set, observed classes before a time (at most 50, oldest first), and open tasks in the namespace (at most 13).
- Upkeep's indexed reads refuse (`UpkeepAccessUnavailable`) when their kind is not verified. They never fall back to reading a whole kind, unlike the store's general reads. `ensureUpkeepAccess` then records a suspension of everything with the rule `unverified-kind`, the kinds, a reason and one operator notice. Nothing in this slice lifts a suspension.

This slice writes none of these records in production. The lifecycle that fills them (receipts, counters, candidates, caps, expiry) belongs to slices 2 to 4.

### Class keys (4.2)

A SHA-256 digest of a versioned, canonical value:

- `docs`, `context`: kind, resolved path, and the quote with every run of whitespace collapsed to one space;
- `check`, `rule`, `learning`: form, anchor, topic (the fixed list of eight);
- `learning-stale`: learning id and the typed condition.

`anchorDirectories` gives the directories of named files to a depth of two.

### Path resolution and the protected set (7.1)

`resolveTreePath` implements the walk exactly as specified: one component at a time, a link's target placed at the front of the pending list, `..` applied only to what has been resolved, 40 hops at most. Unresolvable: a path that leaves the repository, an absolute or unreadable target, a submodule, a cycle, `..` after a missing component. `gitTreeLookup` reads trees and link targets through `VerifiedObjects`.

`protectedSet` resolves every `context.files` entry, including entries whose file does not exist. It also records which of those paths are regular files that an entry reaches in that tree: the files the loader would deliver.

`governingInTree` gives two answers that err in opposite directions:

- **`governing`** is conservative. It is true when the resolved path is in the set (compared without regard to case), when the path cannot be resolved, or when any governing entry of that tree cannot be. A protected path that is missing or is a directory is governing.
- **`protectedFile`** is strict. It is true only when the path resolves to a regular file in that tree and a governing entry reaches that same file. A missing path, a directory, a file followed by `/`, and a file the entry names only in another letter case are governing but not a protected file; the loader delivers none of them.

`governingAcross` asks two trees at once: `either` (governing in one) for the kinds that may never touch a governing path, `both` (a protected file in each) for the `context` kind.

Classification, task creation and the candidate checks that will call these arrive in slices 2, 5 and 6.

### The context loader resolves as the kernel does

Section 7.1 rests on "context is loaded through the file system's full real path". It was not. `readEntry` called Node's `fs.realpathSync` on a `path.resolve()`d path, and both cancel `name/..` as text, in the configured path and in each link's target: the early normalisation 7.1 rules out. In the design's worked example (`rules` → `docs/jump/..`, `docs/jump` → `../private/subdir`, entry `rules/AGENTS.md`) the kernel and `resolveTreePath` reach `private/AGENTS.md`, and the loader delivered `docs/AGENTS.md`. The protected set would have left unprotected the file agents received.

Decided by the operator (2026-11-16): the loader follows the kernel. `readEntry` now calls `realpathSync.native` (`realpath(3)`) on the path exactly as written under the real root, with no `path.resolve`. The design holds as written.

Every earlier check is kept, and one is now explicit:

- the real path must be inside the project root, or the entry is refused ("context must stay inside project root");
- the real path must be a regular file. A directory was refused before by the read failing; it is now refused by name ("context must be a regular file"), with the same outcome;
- the `context.maxChars` budget and the required-entry rules in `assembleContext` are untouched;
- an absolute entry path is still taken as written, and still refused unless it is inside the root.

The loader and the resolver now agree on every 7.1 fixture the file system can hold (60 comparisons in the tests), including the kernel's own limit of 40 links, which is the resolver's.

### Lesson signals (10.1)

`lessonSignals({flow, attempts, pushback})` is a pure function of the flow record and the rows the retrospective already reads by flow id. It reads nothing else, so it cannot depend on the event sample. The retrospective gains `lessonSignals` (at most 40, verified first) and `lessonSignalsOmitted` when the bound cut something.

| Signal | Class | Source |
| --- | --- | --- |
| `review-correction` | verified | A finding of a round that sent the change back, marked `fixed` with evidence by a later round |
| `fast-check-correction`, `gate-correction` | verified | A failed run and a later passing run of the same operation, one signal per failed check |
| `review-correction-inferred` | weak | No disposition recorded; the finding is absent from a later passing round |
| `plan-send-back` | weak | A plan-review attempt routed `revise` |
| `person-replan`, `operator-note` | weak | `operatorFeedback` entries whose actor is not the factory |
| `rule-pushback` | weak | Pushback rows of the flow |
| `plan-departure`, `unverified-acceptance` | weak | Worker reports |
| `unchanged-candidate` | weak | The attempt's recorded reason |

An attempt's operation is taken from the flow's own pinned workflow, not from the step's name and not from the attempt's intent.

## Mapping to the design

| Design | Status in this slice |
| --- | --- |
| 4.1 records, meta keys | Built |
| 4.2 class keys | Built |
| 4.3, 4.4 lifecycle, audit findings | Not in this slice (slice 4) |
| 4.5 access rule; observed expiry read; collision lookup; weekly window; signals without the event sample | Built and tested on a large history |
| 4.5 invocation totals and the counting function | Not in this slice (slice 3) |
| 7.1 resolution, protected set, both-trees question | Built. The points that apply it are slices 2, 5, 6 |
| 7.1 premise: context is loaded through the file system's real path | Made true: the loader changed (operator decision) |
| 7.2 reservation at every route; existing collisions | Built. Blocking "turning upkeep on" is a function here and is wired to commissioning with `mode` in slice 2 |
| 7.2 the marker in the brief fields and the revision digest | Not in this slice: no route can write a marker yet (slice 5) |
| 7.4 unknown-kind refusal | Built, at five points |
| 10.1 signals | Built |
| 15 cross-cutting: fail closed before delivery; nothing runs | Met; a structural test pins the second |

## Compatibility and adopter notes

### The reservation is a breaking refusal

It affects a project that uses `upkeep:` in any letter case as a custom source namespace (`sourceSync.namespace`) or as the GitHub id prefix (`repository.issueProfile.dependencyIdPrefix`), or that creates tasks with such ids by hand.

After the upgrade such a project sees:

- `doctor` not ready, with a reason naming the setting;
- `config update` and `settings update` refused until the setting is renamed;
- source synchronization and `import-task` refused, naming the setting;
- with the GitHub prefix, every step that opens the forge refused with the same reason.

The console, `status` and the task list keep working. Existing tasks in the namespace are untouched: they have no marker, stay ordinary tasks, and can still be labelled, scheduled, revoked and closed. One that came from the source cannot run again under its old id, because the source's namespace has to change; a hand-written one can, once the configuration is valid.

Rename steps:

1. Drain the project as for any configuration change.
2. Choose another namespace, for example `issues:`. Run `config update` with `sourceSync.namespace` (custom source) or `repository.issueProfile.dependencyIdPrefix` (GitHub) set to it.
3. Run `doctor`.
4. Run a source synchronization. Items are imported again under the new ids, unapproved; approve the ones you want.
5. Close each old task in the `upkeep:` namespace that is still open: `task.put` with its current brief and `"closed": true`. Completed and closed ones are history and need nothing. An old task is not retired by the synchronization, because it belongs to the old namespace.
6. Dependencies that named the old ids are rewritten by the synchronization for source items. Update any hand-written task that lists an old id in `dependencies`.

Step 5 matters for the next release: an open task in the namespace that the factory did not make will block turning upkeep on.

### The context loader: a `..` after a symbolic link

For almost every project nothing changes: an entry whose path and links contain no `..` after a link is delivered from the same file with the same digest. A test compares the old and new reading for ordinary paths, a path with `./`, a `..` after a real directory, a linked parent directory and a file that is a link.

It changes for a `context.files` entry where a `..` follows a symbolic link, in the entry's path or in a link's target on the way. The old loader cancelled the link and the `..` as text; the new one follows the link first, as opening the path always did. Such an entry may now be delivered from a different file, or be refused if the kernel's path leaves the project.

- **Running flows.** The governing-context digest of such a project changes with the upgrade. An upgrade is applied to a drained project, so the flows it meets are those started afterwards and task flows carried over at a question. A flow that holds a reviewed plan made under the old digest replans once at its next build or plan review ("replan required").
- **A required entry that is now refused** fails the step with "required context unavailable". Point the entry at the file directly.
- Three shapes that only text cancellation made work now find nothing, as they do when opened: a `..` after a directory that does not exist (`missing/../AGENTS.md`), and a file followed by `/` or `/.` (`AGENTS.md/`).

To check a project before upgrading: for each `context.files` path, compare `realpath <path>` (run in the project root) with the file you expect.

### Graph digests

Unchanged. `tests/upkeep-records.test.mjs` pins the digests of `change.standard`, `change.document` and `task.orchestrator` for the starter template and three variants (fast checks, no planning, and the `upkeep` and `learnings` blocks present), and compares them with what the baseline runtime at `c523d2c` computes from repository history.

### State

- **No schema change, no layout version change.** New kinds are ordinary rows of `records`. Existing state opens as before.
- **New indexes arrive with the layout step** the project service already runs at start. Until then `verified('task')` is false for this release (one of the kind's indexes is missing), so the store's general reads parse the kind as they do for any database without an index, with the same answers, and upkeep's reads refuse.
- **Verification of the new kind.** The layout step used to re-check only kinds it had last found wanting, so a kind indexed by a later release would never have been verified on an existing database. It now also checks every indexed kind the verification record does not mention, in the same transaction that creates the index.
- **An older runtime is not broken by the new indexes.** It matches indexes by name and definition and only ever creates, drops or requires its own; `verified(kind)` asks for the indexes it knows. Both new indexes are partial indexes limited to one kind, so its writes to other kinds evaluate nothing new, and its writes to tasks are maintained by SQLite itself. If it re-records verification it names only its own kinds; this release then treats `upkeepObserved` as unverified until its own layout step checks it again. If it returns the state to the inline layout it drops the indexes it knows and lifts the fence; the two new ones remain but vouch for nothing, because without the fence this release verifies no kind, and its next layout step drops and rebuilds every index. A test runs the baseline runtime through each of these.
- **Retrospectives** recorded from now on carry `lessonSignals`. Ones recorded earlier do not; a re-recorded one gains the field and a new content digest.

### Going back to an earlier release

Nothing to undo in state. The earlier release has no reservation, so it would again accept ids in the namespace.

## Tests

`npm test`: 1346 tests, 1346 pass, 0 fail, 0 skipped (the base has 1286). `npm run eval`: exit 0. `git diff --check`: clean.

| File | Tests | Covers |
| --- | --- | --- |
| `tests/upkeep-tree-paths.test.mjs` | 21 | Every resolution fixture of 7.1, against an in-memory tree, the same tree as Git objects read through verified objects, the kernel's own resolution (`realpath(3)`) of the same tree on disk, and what the context loader delivers from it. Both directions, with the link in the comparison tree, the candidate's tree and both. The loader: the worked example, ordinary paths unchanged, escapes refused. The strict answer: missing paths, directories, trailing slashes, case-only matches and mixed trees. |
| `tests/upkeep-namespace.test.mjs` | 18 | Every route in three letter cases; both configuration settings at `validateConfig`, `config update` and `doctor`; sync and import; recurring ids; open and closed historical collisions; the refusal at admission and at the four operations, for every known kind, an unknown kind and malformed markers; a flow already holding a marked task failing at its publish step; no operation, setting or provider import added. |
| `tests/upkeep-records.test.mjs` | 7 | Record invariants; access paths on a history of 30,000 attempts, 3,000 flows, 2,500 settled findings and 900 closed tasks in the namespace, by query plan and row count, equal to a history 75 times smaller; the 13-row bound; an unverified kind; upgrade from and return to the baseline runtime; graph digests. |
| `tests/upkeep-signals.test.mjs` | 14 | Each signal kind with its class; a clean flow; automatic target-follow replans; the bound; independence from the event sample; class keys pinned, recomputed in another process, and their inputs. |

What the access test asserts for each read: the plan is one step, either a primary-key search or a search of the named declared index constrained beyond the kind; no scan, no sort; a JSON expression appears only as the key of that index. Each indexed read also reads the verification record (one meta row), as every targeted read of the store does. `hasUpkeepWork`, the read a tick will make from slice 2, is one meta read; this slice adds no read to the tick.

### Fail-before evidence

The four new files, run against partial reverts of the committed source:

| Source state | Result |
| --- | --- |
| Every source change removed (the base plus the new tests) | 4 files, 0 pass: each fails to load a module that does not exist |
| New modules kept; every change to an existing file removed except `core/records.mjs` | 38 run, 5 fail: the namespace file (it needs the dispatch export), both baseline-runtime tests, and both retrospective signal tests |
| Only the route changes removed (`task.put`, admission, configuration, issue profile, source sync) | Namespace file: 18 run, 11 fail, one per route test |
| Only `operations/state-layout.mjs` reverted | Records file: 7 run, 2 fail: on an existing database the new kind is never verified |
| Only `operations/context.mjs` reverted (the old loader) | Tree-paths file: 19 run, 6 fail: the worked example, the escape, and each fixture where a `..` follows a link or a missing component |

## Review fix: the strict answer accepted paths that are not files

Independent review (GPT-6.1 Sol) of `166c97b`: approved with one blocking fix.

**Finding (P2).** `governingInTree` set `protectedFile` whenever the resolved path was in the protected set. So `governingAcross(...).both`, the answer that will let a `context` task change a path, was true for a path with no regular file behind it: a missing path, a directory, an entry written `rules.md/`. The loader delivers none of these. A tree with nothing in it and the entry `missing.md` returned `both: true`.

**Fix.** `protectedFile` is true only when the path resolves to an existing regular file (`found.exists && found.type === 'file'`) and a governing entry reaches that same file. The second condition goes one step past the finding as written, for the same reason: with the entry `rules.md/` or `RULES.md` and a real file `rules.md`, the path `rules.md` is a regular file in the set, but the loader delivers nothing for that entry. `governing` is unchanged and stays conservative. One earlier expectation changed with it: a document that matches the governing entry only by letter case is governing in both trees but no longer a protected file in both.

**Fixtures** (`tests/upkeep-tree-paths.test.mjs`, two tests, each fixture against the in-memory tree and the Git tree, and against what the loader delivers from the tree on disk): the review's own reproduction; a missing path, also in a missing directory; a directory, as entry or as path, with and without `/`; `rules.md/`, `rules.md/.` and `rules.md/inner` as the entry; a case-only match in either direction; and mixed trees where the path is a regular file (or a link to one) in one tree and missing, a directory, a dangling link or a link to a directory in the other, in both orders.

**Fail-before.** All 50 fixture answers that must be `false` were `true` on `166c97b` and are `false` now. With `core/tree-paths.mjs` reverted, 4 of the file's 21 tests fail.

## Design points

All were put to the operator and decided on 2026-11-16.

### The context loader did not resolve as 7.1 assumes

Found by comparing the resolver with the file system on every fixture. Decided: the loader follows the kernel. Described [above](#the-context-loader-resolves-as-the-kernel-does), with the adopter note. The alternatives not taken were protecting both readings, and treating an entry whose readings differ as unresolvable; each would have contradicted the design's worked example.

### `task.put` on a task already in the namespace

The route table in 7.2 says `task.put` refuses to "create or change" a task in the namespace. The bullets below it say that only "with upkeep on" can such a task no longer be changed, and tell the adopter to "finish or close" open ones first. `task.put` is the only way to close a task, and a source task in the old namespace cannot be finished once the namespace is renamed. An unconditional refusal to change would have left existing open tasks impossible to clear.

Decided, and now stated in 7.2 of the design: creation in the namespace is always refused; a task that carries a marker is never editable; a task that was already there, without a marker, stays editable so that it can be closed. Refusing changes "with upkeep on" needs the mode and arrives with it in slice 2.

### Smaller points, each following the code (accepted as recorded)

- **Where the configuration check runs.** The design places the source-namespace refusal beside today's list in `sourceSettings`. `snapshot` and the dashboard call `sourceSettings` on the stored configuration, so a project that already uses the namespace would have lost its console. The check is in `validateConfig` (every configuration write and `doctor`) and in source sync. The GitHub prefix check is in `validateIssueProfile` as designed, and also in `validateConfig`, which did not validate the issue profile before.
- **Verification of a later release's kind.** The layout step did not check a kind the verification record does not mention; it now does. Without it `upkeepObserved` would never be verified on an existing database.
- **The marker is not yet a brief field, and `knowledge.upkeep` is not registered anywhere** (operations, maintenance lists, model graphs). Both belong to the slices that create tasks and add the job.
- **Release notes are not written.** The rename steps and the loader note are here for the release step to carry over.

Further details of the same kind:

- **No commissioning check for existing collisions yet.** There is no `mode` to turn on. `namespaceCollisionReasons` is built and tested, including the 13-row bound.
- **An absolute path given to the resolver** is unresolvable. The design defines this for link targets only. The loader still accepts an absolute entry inside the root, so for such an entry the protected set fails closed.
- **A submodule on a governing entry's path** is unresolvable for the resolver (fail closed), while the loader, on a checkout where the submodule is populated, would read the file. Conservative, and as designed.
- **A missing component followed only by `.` or empty components** resolves to the missing path itself, marked not existing.
- **The unverified-kind suspension is a recorded suspension** (part `all`), so by N3 it stays until the operator lifts it, even after the kind is repaired. The lifting command is slice 4.
- **Class-key paths are exact.** Two paths that differ only by case give different keys; the case-insensitive comparison of 7.1 is for the protected set.
