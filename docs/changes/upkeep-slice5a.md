# Knowledge upkeep, slice 5 part A: enforcement on the final candidate

Design: [knowledge-upkeep.md](../designs/knowledge-upkeep.md), section 15, slice 5 part A (sections 7.1, 7.4 and 7.5). Base: `main` at `eafd627` (slices 1 to 4). First round: `406b2eb`. The independent review of `406b2eb` and its fixes are in [Review of `406b2eb`](#review-of-406b2eb).

Part A makes the `docs` task kind enforceable and keeps upkeep flows away from automatic merge. **Nothing in this release creates an upkeep task.** Task creation by the factory, workflow selection, batching, the backlog, slots and parking, and safe abandonment are part B, which starts only after this part is reviewed. Every test that needs a docs task writes one straight to the store; the `upkeep:` namespace and the marker stay refused at every task-creating route, unchanged from slice 1.

**What changes for every project:** nothing that a project can reach today. A task can carry an upkeep marker only if it is written to the state database by hand.

## What was built

| Piece | Where |
| --- | --- |
| `docs` is an enforced kind; the docs marker and its validation | `core/upkeep-namespace.mjs` (`ENFORCED_UPKEEP_KINDS`, `docsMarkerProblems`, `upkeepMarkerRefusal`) |
| The candidate check for the docs kind: tree comparison, own commits, the matrix of 7.4 | `workflows/upkeep-enforcement.mjs` (new) |
| The check in commit, integration, publication and merge | `workflows/dispatch.mjs` |
| No automatic merge for an upkeep flow | `core/engine.mjs` (the merge question), `workflows/dispatch.mjs` (`forge.merge` mode) |

### The docs marker

Part B will write it; this release reads it and refuses one it cannot read, at admission and at each of the four operations.

```json
"upkeep": {
  "kind": "docs",
  "sourceFlow": "…", "mergeCommit": "…", "candidates": [{"id": "…", "version": 1}], "evidence": [],
  "files": [{"path": "docs/guide.md", "blob": "<Git blob id it was validated at>"}],
  "limits": {"maxFiles": 3, "maxChangedLines": 40}
}
```

- `files`: one to three declared files, each a plain repository path with the blob id it was validated at, listed once. The task's `paths` must be exactly these paths.
- `limits`: positive whole numbers. The check applies these or the current `upkeep.docs` limits, whichever is tighter.

### Where the check runs (7.4)

| Operation | Candidate | Comparison commit | On failure |
| --- | --- | --- | --- |
| `workspace.commit` | The commit just made | The integrated target if one is recorded, otherwise the workspace base | The commit is undone (`reset --soft`, merge state restored); the step fails |
| `workspace.integrate` | The non-conflicting integrated head | The integrated target | The step fails |
| `forge.publish` (decisive) | The head that will be pushed | The integrated target | Nothing is pushed and nothing is asked of the forge |
| `forge.merge` | The authorized head | The integrated target | Refused before the forge is read; nothing is merged |

The check runs after the existing upgrade-owned check, inside the operation, so no graph routes around it. The candidate must contain the comparison commit through verified parents, or it is refused without being compared.

### What is compared

The candidate's tree against the comparison commit's tree, entry by entry, through hash-verified objects (`core/verified-git.mjs`), never `git diff`. Then every commit of the candidate's own (not reachable from the comparison commit, shown through verified parents), each against its parents: a path counts as changed by a commit when it differs from every parent, so the factory's merge of the target changes nothing of its own.

Each refusal lists every rule broken, with a code, the path and, for an own commit, the commit.

| Rule | Code | Applied to |
| --- | --- | --- |
| Every tree the check reads has exact entry names: valid UTF-8, one path component, no two entries alike | `tree-name` | Every tree read |
| Only the declared files change | `undeclared` | Candidate and own commits |
| Each changed path is in the docs set: `upkeep.docs.include` less `exclude`, from the configuration current at the operation | `not-docs` | Candidate and own commits |
| Never a governing path: governing in the comparison tree or the candidate's tree, resolved as 7.1 does (links, chains, `..` after a link, case), or any governing entry unresolvable (fail closed) | `governing` | Candidate and own commits |
| Never an upgrade-owned path, as written or as resolved in either tree | `upgrade-owned` | Candidate and own commits |
| Never the learnings directory, resolved in each tree; one that a tree cannot place refuses every change | `learnings`, `learnings-unresolvable` | Candidate and own commits |
| No link, submodule or file in any directory above a changed path, in either tree | `link-above` | Candidate and own commits |
| No addition (a rename and a case-only rename are a deletion and an addition) | `addition` | Candidate and own commits |
| No deletion | `deletion` | Candidate and own commits |
| No symbolic link or submodule added, changed or removed | `link`, `submodule` | Candidate and own commits |
| Ordinary, not executable, unchanged mode on every side | `mode` | Candidate and own commits |
| Both sides of a changed file, and every blob an own commit wrote, are text: at most 1 MiB, no NUL byte, valid UTF-8. Sizes are read before content; at most 1,000 blobs and 32 MiB are read per check, and a blob past either bound refuses the candidate | `binary`, `too-many-changes` | Candidate and own commits |
| At most `maxFiles` changed files and `maxChangedLines` added plus removed lines, each line with its terminator and any byte order mark (a dropped final newline, a changed line ending and a BOM each count) | `budget-files`, `budget-lines` | Candidate |
| Each declared file, in the comparison tree, is exactly the ordinary file whose blob the marker pins | `pinned` | All declared files |
| At most 200 changed entries are read, then the candidate is refused | `too-many-changes` | Candidate and each own commit |
| A malformed marker, or a kind this release does not enforce | refused before the check (slice 1's rule, extended) | Admission and the four operations |

### Automatic merge (7.5, N1)

A merge question of a flow whose task, or whose own task snapshot, carries an upkeep marker is never answered by `policy.autoMerge`. It goes to `policy.mergeDecisionRole`, with a strict escalation to the operator, as for any flow. `forge.merge` also uses the forge's manual mode for such a task, so it never depends on the automatic-merge qualification.

## Decisions where the design was ambiguous

Each is the conservative reading. The open questions below are the ones a reviewer or the operator should confirm before part B.

| # | Point | What this part does |
| --- | --- | --- |
| 1 | The shape of the docs marker (7.2 names its contents but not its fields). | As above. Part B must write exactly this. A marker without declared files with blobs, or without limits, is refused. |
| 2 | Pinned blobs are checked "before the first build" (7.4). | Checked at every one of the four operations against the comparison commit, so a declared file the target changed under the task is refused at integration, publication and merge too. The pre-build check that fails the flow as `stale` and returns its candidates is lifecycle, in part B. |
| 3 | What an own commit is judged on. | Every path and entry rule, and the content rule for every blob it wrote, within the read bounds (changed in review). The line budget is judged on the candidate as a whole only. |
| 4 | "A changed blob" that is binary. | Both sides of a changed file must be text, not only the new one. |
| 5 | An executable doc. | Every side must be mode `100644`, so a declared file that is executable already cannot be changed by a docs task at all. |
| 6 | A conflicting integration of a docs task ("ended, not repaired", 7.4 and 7.6). | The integration step fails and the merge is undone, so no conflict question opens; a commit with a merge in progress is refused (changed in review). What happens to the flow and its candidates afterwards is part B's abandonment. |
| 7 | The configuration the docs set is read from. | The configuration the operation runs with (`action.config`). If the stored `upkeep` block is one this release would refuse, its fields read as defaults: no docs are declared, so every change is refused. |
| 8 | Upgrade-owned paths. | The existing protection refuses them first, with its own message; the docs check refuses them too. |
| 9 | Letter case. | Declared files match exactly; governing, upgrade-owned and learnings paths match without regard to case; `include` and `exclude` match exactly, as the pre-filter matches them. |
| 10 | Bounding the comparison. | 200 changed entries per comparison, then a refusal. A docs task changes at most three files. |
| 11 | The automatic-merge exclusion's key. | The marker on the task record or on the flow's snapshot of it, either one. The task is read once, as before. |
| 12 | An adopted pull request or an already-satisfied start of an upkeep task (7.2). | Refused at admission (added in review). |
| 13 | Tree names. | Exact: a tree the check reads with a name that is not valid UTF-8, is not one path component, or repeats another entry's name refuses the candidate (added in review). Only trees the check reads are judged; a subtree identical in both trees is not read. |

### Preconditions for later work

The open questions of the first round were settled with the review (below). Two items remain, as preconditions:

1. **Before part B: bind the marker into the brief.** 7.2 puts `upkeep` in the brief fields, the revision digest, the flow's task snapshot and, on a migrated project, the immutable revision snapshot. This part does not, because adding a field to the brief can change the revision of existing tasks and so their approvals; part B's creation path must do it, with a test that existing revisions are unchanged. Until then a marker exists only if someone writes the state database by hand, and every product route refuses it.
2. **Before slice 6: the confusable-text follow-up** (`docs/runtime-followups.md`). Untouched here; nothing in this part accepts model text into governing context.

## Compatibility

- **Graph digests:** unchanged. No node is added and no reference graph reads the new code; the digest tests of slices 1 and 2 pass.
- **State:** no schema, layout or index change. The check reads Git only: no store read, no SQL JSON read, no scan (4.5).
- **Idle tick:** unchanged. The check runs only inside the four operations, and only for a task with a marker.
- **Behaviour change for the slice 1 tests:** `ENFORCED_UPKEEP_KINDS` is now `['docs']`. A well-formed docs marker is admitted and checked; a malformed one is still refused at admission and at each operation, now with "that this release cannot read". The slice 1 and 4 tests that pinned an empty list were updated.
- **Going back to an earlier release:** nothing to undo. An earlier release refuses every marker, so a docs task written by hand would be refused there too.

### For the release notes

- **Knowledge upkeep, slice 5 part A (nothing to do for adopters).** The factory can now check a documentation-correction task's candidate in commit, integration, publication and merge: only the declared docs may change, within 3 files and 40 lines, with no added, deleted, renamed, linked, executable or binary file and no governing, upgrade-owned or learnings path, judged on the published tree and on every commit the builder made. A documentation-correction task whose integration conflicts fails instead of asking for a repair, and one can never be started as an adopted pull request or as an already-satisfied outcome. Upkeep flows are never merged by `policy.autoMerge`; their merge question goes to the merge decision role. No release creates such a task yet, so nothing changes for a running project.

## Tests

`npm test`: 1566 tests, 1566 pass, 0 fail, 0 skipped (1542 at the base, 24 new). `npm run eval`: exit 0. `git diff --check eafd627..HEAD`: clean. (First round: 1559 tests, 17 new.)

New file `tests/upkeep-docs-enforcement.test.mjs`, 24 tests (17 in the first round, 7 from the review). Changed: `tests/upkeep-namespace.test.mjs` (the marker rule now allows a well-formed docs marker) and `tests/upkeep-lifecycle.test.mjs` (the enforced list).

### Acceptance (section 15, slice 5 part A)

| Acceptance item | Test (`tests/upkeep-docs-enforcement.test.mjs`) |
| --- | --- |
| 1. A docs correction is delivered through all four operations | "a docs correction is committed, integrated, published and merged…"; "a docs correction against a target that moved elsewhere…" |
| 2. Paths: only declared files, each in the docs set | "paths that may change…" (undeclared doc, outside `include`, excluded dated record, no docs declared) |
| 2. Governing paths: never | "governing paths: never…" (a file in both `include` and `context.files`) and the link test below |
| 2. Learnings directory: never; upgrade-owned: never | "the learnings directory and upgrade-owned paths: never" |
| 2. Additions and deletions: none; a rename | "additions and deletions: none, including a rename and a new path that differs only by case" |
| 2. File mode: ordinary, not executable, unchanged; a mode change | "file mode…" |
| 2. Budget | "budget: 3 files and 40 changed lines, or the configuration if it is tighter" |
| 2. Pinned blobs | "pinned blobs…" |
| 2. An own commit that is later undone | "an own commit that is later undone is refused: a path, a mode and a link…" |
| 2. A link; submodules; a link above a changed path | "links and submodules…" |
| 2. A binary change | "binary content…" |
| 2. A governing path through a linked directory, a link chain, a link followed by `..` or a case variant, in either tree | "a governing path reached through…" (each link fixture with the link in the comparison tree, the candidate's tree and both; the worked example's other side published; an unresolvable entry fails closed) |
| 2. Unknown kind | "a marker of a kind this release does not enforce, or one it cannot read…"; slice 1's tests in `upkeep-namespace` |
| The other three operations refuse too | "commit, integration and merge each refuse an out-of-bounds candidate; a refused commit is undone" |
| 3. A graph with no commit step cannot publish an out-of-bounds candidate | "a graph with no commit step…" (an engine-run graph of prepare, a command that commits, integrate and publish, accepted by commissioning; the flow fails and nothing is pushed). Every refusal fixture above also runs publication with no commit or integration step before it. |
| 4. An upkeep flow is never merged by policy | "an upkeep flow is never merged by policy…" (control: the same flow without a marker is answered by policy); the first test (the forge merge mode) |
| 4.5 read limits; graph digests | `upkeep-records` and `upkeep-authority`, unchanged and passing |

Every refusal fixture at publication also asserts that no branch reached the remote and the forge was not called.

### Fail-before evidence

At the base (`eafd627`) the new file fails to load (the module does not exist). Each row below is one partial revert of the committed source, run against the new file (17 tests).

| Source state | Fails |
| --- | --- |
| The base source with the new tests (`dispatch.mjs`, `engine.mjs`, `upkeep-namespace.mjs` at `eafd627`; the new module absent) | the file fails to load |
| The check wired into none of the four operations | 13 of 17 |
| The check missing only from `forge.publish` | 11 |
| The automatic-merge exclusion removed from the engine | 1 (acceptance 4) |
| `forge.merge` in automatic mode for an upkeep task | 1 (acceptance 1) |
| Own commits not judged | 1 |
| No check for a link above a changed path | 1 |
| Governing judged in the candidate's tree only | 2 |
| Governing judged in the comparison tree only | 2 |
| No binary check | 1 |
| No pinned-blob check | 1 |
| No mode check | 1 |
| No changed-lines budget | 1 |
| The marker's limits only, not the tighter configuration | 1 |
| No docs-set check | 1 |
| No learnings check | 1 |
| No addition check | 2 |
| No deletion check | 3 |
| No link check | 2 |
| A refused commit not undone | 1 |

## Review of `406b2eb`

Independent review (GPT-6.1 Sol): three P2 publication bypasses and one P3. It confirmed the rest of the docs matrix, the operation wiring (graph order, the commit step omitted), parent traversal, governing paths, renames, modes, submodules, filters, conflict resolution, the namespace and the digests. Each fix has a test that fails without it; the seven new tests all fail on the `406b2eb` source.

| Finding | Fix | Test |
| --- | --- | --- |
| **P2-1. Different Git names collapse into one.** Tree entries were keyed by names decoded lossily, so a new file named with the bytes `docs/\xff.md` read as the declared `docs/\uFFFD.md` and published as an edit to it. | `strictTreeReader`: every tree the check reads (the comparison, the candidate, the own commits and their parents, and the 7.1 lookups) is read with exact names. A name that is not valid UTF-8, is empty, `.`, `..` or contains `/`, or that two entries share, refuses the candidate (`tree-name`). Names are decoded without dropping a byte order mark. | "review P2-1: a tree name that is not valid UTF-8…"; "review P2-1: the exact reader refuses duplicate names…" |
| **P2-2. Line budgets missed terminator and BOM changes.** Line 3 replaced plus a dropped final newline, or plus a BOM, counted 2 changed lines instead of 4. | `changedLinesExact` (`core/line-diff.mjs`) compares lines with their terminators; the decoder keeps a BOM. `changedLines`, which the assessment uses, is unchanged. | "review P2-2: a dropped final newline, an added byte order mark and a changed line ending…" (no final newline, a BOM, one CRLF among LF, all CRLF, and the 2-line control) |
| **P2-3. Intermediate binary and oversized blobs published.** Own commits were checked for entries only. | Every blob an own commit wrote is judged by the content rule. Sizes come from the object store first (`cat-file --batch-check`, replace objects off), so a blob over 1 MiB is refused unread; a blob read is hash-verified, so a size the store under-reports cannot pass. At most 1,000 blobs and 32 MiB are read per check; past that the candidate is refused. The line budget stays on the final candidate. | "review P2-3: a binary or oversized blob in an intermediate commit…" (a NUL byte, 1 MiB and one byte, invalid UTF-8); "review P2-3: the content reads are bounded…" (33 intermediate 1 MiB texts) |
| **P3. The automatic-merge exclusion added a store read.** | The marker is checked on the task the risk is read from, in the same single read, after the policy test as before. | Covered by the acceptance 4 test |

The open questions of the first round, as settled with the review:

| Question | Outcome |
| --- | --- |
| A conflicting docs integration | Now: `workspace.integrate` fails for a docs task whose integration conflicts and undoes the merge (`git merge --abort`), so no conflict question opens. `workspace.commit` refuses a docs task with a merge in progress. Test: "review Q3…", which also shows an ordinary task still routed to `conflict`. |
| Adopted and already-satisfied starts | Now: `admitFlow` refuses an upkeep task started either way. Test: "review Q4…". |
| Own commits' content | Now judged (P2-3). |
| The marker in the brief | A precondition for part B (above). |
| The confusable-text follow-up | A precondition for slice 6 (above). |

### Fail-before evidence for the review

Each row is one partial revert of the fixed source, run against the seven review tests.

| Source state | Fails |
| --- | --- |
| The `406b2eb` source (all five changed source files) | 7 of 7 |
| Trees read through the lossy reader | P2-1 (the repro) |
| Terminators dropped from the line comparison | P2-2 |
| A BOM stripped by the decoder | P2-2 |
| Own commits' blobs not read | both P2-3 tests |
| No read bound | P2-3, the bound |
| A conflicting docs integration routed to `conflict` | Q3 |
| A commit with a merge in progress allowed | Q3 |
| Adopted and already-satisfied starts admitted | Q4 |

`main` was still at `eafd627`, which this branch contains, so there was nothing to merge.
