# dev.82: install under a repository folder (F4) and no test files in releases (F5)

Implementation on branch `t3/adopt-install-prefix`; not a release. Findings are numbered as in the end-to-end adoption trial report. Tests: new `tests/install-prefix.test.mjs` (34 tests after six review rounds); two test files moved into `tests/`.

## Problem

**F4 (blocking for affected projects).** `adopt install` wrote `VERSION`, `compatibility.json`, `factory/` and `project/` at the repository root and refused when any of them existed. A project with its own root `VERSION` could not adopt: `git init`, `echo 1.4.2 > VERSION`, commit, `adopt install` gave `adoption conflicts: VERSION (installation would overwrite existing project file)`. `owner()` in `starter/factory/distribution.mjs` and several runtime sites hard-coded the root layout.

**F5.** The release payload carried `starter/factory/console/console.test.mjs` and `starter/factory/core/contracts.test.mjs` into the adopting project, where they joined its test discovery (plain `node --test`, Jest/Vitest globs, coverage, lint).

## Decisions

1. An install prefix option, `adopt install --prefix <folder>`, puts every installed path under one folder. With no prefix, paths, lockfile and manifests are unchanged.
2. Factotum's own test files are no longer shipped; their coverage still runs in `npm test`.

## Design

### Where the prefix lives and how it is found

`factotum.lock.json` stays at the repository root and gains `"prefix": "tools/factotum"` only when a prefix is used. Its `managedFiles` paths stay relative to the installation folder (`factory/cli.mjs`), so `owner()`, release manifests and the lock's file identities are unchanged. A root installation's lock has exactly the keys it had before (`formatVersion`, `release`, `managedFiles`, `templatePolicy`); `formatVersion` stays 1.

Every later command reads the prefix from that lock; nobody repeats it. This was chosen over discovering it from the running factory's own location because `upgrade apply` is run with the *new release's* CLI (outside the project), which cannot infer the project's layout from where it runs. The lock is the one file every path-dependent command already has: the project root. An older CLI that ignores `prefix` would see every managed file missing at the root and refuse the update (conflicts), so it cannot damage a prefixed project.

`starter/factory/core/install-layout.mjs` (new) holds this in one place: `LOCK`, `normalizePrefix`, `underPrefix`, `installPrefix(root)` (the lock's prefix, `''` with no lock or no prefix), `factoryCli(root)` and `cliCommand(root)` (`node <prefix>/factory/cli.mjs` for guidance text).

### Validation

`normalizePrefix` accepts a relative, already-normalised folder path: no absolute path or drive letter, no `..`, no empty or `.` segment (`./x`, `x//y`, `x/./y` are refused rather than silently rewritten), no backslash or control character, no `.git` segment (any case), at most 200 characters, and (since the review) only `[A-Za-z0-9._-]` in each folder name, never a leading `-`; one trailing `/` is tolerated. `''`, `.` and no option mean the root. In addition, before anything is created, `adoptionPlan` checks that every existing folder along the prefix is an ordinary directory (not a file, not a symlink, not a nested Git repository or submodule), refuses an existing `<prefix>/factory`, applies the per-file overwrite conflict check under the prefix, and refuses installed paths the project's Git ignore rules cover (`git check-ignore --no-index`), which would otherwise be left out of the adoption commit. The ignore check runs only under a prefix, to keep root installations exactly as before.

An update uses the recorded prefix. Passing a different one to `adoptionPlan`/`prepareAdoption` is refused ("this project is installed under tools/factotum … an update cannot move it"). Moving an installation is not supported.

### Test files (F5)

The two files moved to `tests/console-server.test.mjs` and `tests/workflow-contracts.test.mjs` (imports adjusted) and `npm test` is now `node --test tests/*.test.mjs`, so their coverage still runs. Moving them was preferred over excluding them at build time: the starter directory stays byte-for-byte what is shipped, and the clean-commit provenance check (which compares the starter to the committed tree) needs no filter. To keep it that way, `buildRelease` now refuses a starter containing any `*.test.*js`/`*.spec.*js` file and names it. `readRelease` does not refuse such files, so earlier releases remain readable.

Upgrade apply already removed managed files that a new release no longer lists (`kind: "remove"`), and only paths recorded in the lock's `managedFiles`. That covers the two files with no change; the new test proves it at the root and under a prefix, with project test files at the root and under `<prefix>/project/` left alone.

## Path sites

Changed:

| Site | Change |
|---|---|
| `distribution.mjs` `adoptionPlan`, `prepareAdoption`, `adoptionStatus`, `readLock`, `currentFile` | Prefix option, validation, conflict/ignore checks under it, repository-relative paths in plan/status output, prefix recorded in and read from the lock |
| `distribution.mjs` `buildRelease` | Refuses test files in the starter |
| `distribution.mjs` `seedBytes` | Under a prefix, the seeded `project/factotum.template.json` names `<prefix>/factory/AGENTS.md` and `<prefix>/project/GOVERNANCE.md` (configured paths are relative to the repository root). Root installs seed it byte for byte |
| `cli.mjs` `adopt` | `--prefix` option; `adopt status` reports `prefix` |
| `core/command-help.mjs` | `adopt install --prefix`; plan/update say they use the recorded prefix |
| `operations/services.mjs` `projectUnit`, `unitDiagnostics` (doctor) | Unit `ExecStart` and the doctor check use `factoryCli(project.root)` |
| `operations/upgrade-apply.mjs` `mergeUpgrade`, `activateUpgrade` | Recommission and doctor run `factoryCli(project.root)`, resolved after the merge/pull |
| `workflows/dispatch.mjs` `workspace.commit` | Builder protection covers `<prefix>/factory/`; the prefix is read from the project checkout's lock (`intent.projectRoot`), not the builder's worktree. A root-level `factory/` in a prefixed project is project code |
| `core/catalog.mjs` `readProjectFile` | Workflow files may not live in `<prefix>/factory/` |
| `cli.mjs` config update message, `core/project.mjs` cleanup note, `operations/workspace-cleanup.mjs` `cleanupCommand` | Print `cliCommand(project.root)` |
| `operations/views.mjs` `settingsView` | New `cli` field; console Settings and Health hints (`console/ui/settings.mjs`, `console/ui/operations.mjs`) use it, falling back to `node factory/cli.mjs` |
| `package.json`, `console/README.md` | Test glob and moved test path |
| Docs: `docs/updates.md` (new "Install under a folder" section, removals, `upgrade apply`), `docs/adoption.md`, `docs/running.md`, `GETTING_STARTED.md`; shipped `factory/AGENTS.md`, `project/README.md`, both skills, `t3-notifications.example.md` | Describe the prefix, discovery and the removed test files |

Deliberately left:

- `core/effects.mjs`: locates the supervisor from its own module path (`import.meta.url`), and `executorDigest` already excluded `*.test.mjs`. Correct under any prefix.
- `operations/upgrades.mjs` (`upgrade stage/activate`, `launch --install`): works on an installation root with the starter layout (`factory/cli.mjs` at its top), not the repository. Staging a prefixed project stages the prefix folder (documented in `docs/running.md`).
- `operations/context.mjs` context mapping: paths are relative to the repository root, which is correct; only the seeded template needed prefixed paths.
- `services.mjs` `unitRunsFrom`, `consoleUnit`: match on the checkout root or the invoking CLI; prefix-neutral.
- `console/ui/overview.mjs` "No registered projects" hint still prints `node factory/cli.mjs register`: it is console-level with no project (and so no lock) to read; a shared console may serve projects with different prefixes.
- Fast checks, gate checks and git pathspecs: no code assumes the installation folder (checks are project argv run in the worktree; there are no factory pathspecs).
- Project templates other than `factotum.template.json` (README, skills, examples) are seeded unchanged; they now say how to read their paths under a prefix.
- No release-notes entry: this branch is not a release; the release that includes it should add one ("adopters upgrading see two test files removed").

## Tests

`tests/install-prefix.test.mjs`:

1. A project with a root `VERSION`: root install refused through the real CLI; `--prefix tools/factotum` succeeds; project `VERSION` untouched; lock records the prefix with release-relative managed paths; seeded template paths prefixed; status clean; drift reported at its repository path; `adopt plan`/`adopt update` find the prefix without being told and refuse a different one; the updated worktree verifies clean.
2. A root installation is unchanged: lock keys, no `prefix` in plan or status, template seeded byte for byte (regression guard; passes before and after).
3. Invalid prefixes are refused before any branch or worktree exists: absolute, drive letter, `..`, non-normalised, `.git`/`.GIT`, backslash, an existing file at or above the prefix, through the CLI too; an existing file under the prefix; a symlinked folder; a nested repository (gitlink); an ignored folder.
4. A prefixed sandbox project: the service unit runs `<root>/tools/factotum/factory/cli.mjs`; doctor's unit check accepts it and flags a root-path unit; `settingsView().cli`; `prepareUpgrade` plans prefixed paths without a prefix argument; `mergeUpgrade` (default CLI runner, systemctl stubbed) runs `config update` and `doctor` with the prefixed CLI and leaves no root `factory/`.
5. `workspace.commit` refuses a builder change to `tools/factotum/factory/cli.mjs` and accepts root `factory/notes.md` and `tools/factotum/project/GOVERNANCE.md`; the catalog refuses a workflow file under `tools/factotum/factory/` and accepts one under `tools/factotum/project/workflows/`.
6. `release build` of this starter has no `*.test.mjs` in its manifest or payload and reads back; a starter with a test file is refused by name and no output is left.
7. From a release that shipped the two test files (built the way earlier builders did), an update to a release built from this starter removes exactly those two managed files, at the root and under a prefix, and keeps project test files.

**Fail before.** The new test file (plus the moved test files it reads) was run against an export of the base commit `93395cf` outside the checkout: 7 tests, 1 pass, 6 fail. The pass is test 2, the root-layout regression guard. Failures: (1) `Unknown option '--prefix'`; (3) `/abs/olute` was not refused; (4) the unit's `ExecStart` used `<root>/factory/cli.mjs`; (5) "Missing expected rejection" (the prefixed factory edit was committed); (6) manifest listed `factory/console/console.test.mjs` and `factory/core/contracts.test.mjs`; (7) no removals planned. After: 7/7 pass.

## Results

First round (commit `564f56a`):

- `npm test`: 849 tests, 849 pass, 0 fail, 0 skipped. The base commit, run from an export outside the checkout, had 842 tests (840 pass, 2 skipped there); the difference is the 7 new tests. The two moved files keep their 7 tests under `tests/`.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Review fixes

An independent review of `564f56a` rejected it with one blocking and two non-blocking findings. `main` (the R3 and T3-guide merges) was merged in first; it merged without conflicts, and the merged T3 guide's `CLI` definition gained the prefixed form.

### 1 (blocking): builders could change the pointer that controls protection and upgrades

**Finding.** `workspace.commit` protected only the factory the live lock pointed at, and builders could edit `factotum.lock.json`. Reproduced: a builder retargets `prefix` from `tools/factotum` to `elsewhere` (committed); after merging, another builder edits `tools/factotum/factory/cli.mjs` (committed). With a valid release record, a changed prefix and a forged managed entry matching an application file, `prepareAdoption` accepted the lock and deleted `application/factory/keep.txt` in the update worktree.

**Fix.**

- *Builder protection* (`workflows/dispatch.mjs`, `core/install-layout.mjs` `upgradeOwned`). `workspace.commit` refuses any change to `factotum.lock.json`, at the root or under a prefix, with or without an existing lock, and `policy.allowFactoryEdits` does not lift it. Under that policy flag, as before, it also refuses `<prefix>/factory/` and now, once a lock exists, `<prefix>/VERSION` and `<prefix>/compatibility.json` (for a root installation that is the root `VERSION`, which a root install already owns; a project without a lock keeps its own root `VERSION`). The changed paths now come from `git status --porcelain -z --untracked-files=all` parsed with `changedPaths`, which also returns the source path of a staged rename or copy; the old `row.slice(3)` parse mangled that separate field, so moving a core file away was not seen.
- *Fail closed on the lock* (`install-layout.mjs` `readInstallLock`). An unreadable lock, invalid JSON, a non-object, `formatVersion` other than 1, or an invalid `prefix` throws everywhere the runtime reads it: builder commits are refused, the service unit is not written, upgrade apply's recommission step fails, and doctor's unit check reports "cannot be checked: …" rather than crashing. `distribution.mjs` `readLock` does the same for status, plan and update; before, `installPrefix` treated an unparsable lock as "no prefix".
- *Layout continuity* (`distribution.mjs`). (a) A prefixed lock now carries `layout: {compatibility, templateFiles}`. `layoutMatches` rebuilds the release manifest from the lock (managed and template identities in inventory order, payload digest, version, provenance, compatibility) and requires both the payload digest and the manifest SHA-256 the operator pinned to match. A prefixed lock without that evidence, or with any changed or added managed entry, is refused before a worktree exists. `newLock` checks its own output the same way, so a prefixed install refuses a release whose manifest is not in `release build`'s canonical form. Root locks keep their original shape. (b) `layoutHistory` compares every lock with Git history: the managed files and layout must equal the lock written by the commit that adopted the current release (the oldest commit in the run with that manifest digest), and the prefix must equal both that commit's and the previous release's. A hand edit that was reverted is no longer relevant; a lock deleted from history starts afresh (a deliberate reinstall).

**Regressions** (`tests/install-prefix.test.mjs`):

- "builders may not change, delete or move factotum.lock.json or move upgrade-owned files away (review repro 1)": the reviewer's retarget through real `runAction` `workspace.commit`, also with `allowFactoryEdits`; deleting the lock; a staged `git mv` of the core; `changedPaths` on a rename record; a root lock and root `VERSION`; a builder creating a lock in a project without one; a project without a lock keeping its own root `VERSION`; an unreadable and an invalid lock in the checkout refusing an ordinary commit.
- "an update refuses a lock whose prefix or managed files do not match its release or history (review repro 2)": the reviewer's delete probe (a genuine prefixed lock with `prefix: application` and a forged `factory/keep.txt` entry, with and without the genuine layout): `prepareAdoption` and `adoptionStatus` refuse, no worktree is created and the file stays. Also a later hand edit of the prefix (refused; a `git revert` restores updates), a lock naming a new release that moves the prefix at the same time, a forged managed entry added to a root lock (refused, file kept), and an unreadable lock stopping status, plan and doctor's unit check.

**Fail before.** The final test file was run against an export of `564f56a` outside the checkout: 10 tests, 5 pass, 5 fail. Repro 1 fails with "Missing expected rejection" (the builder's lock retarget was committed). Repro 2 fails with "Missing expected exception: without layout" (the forged lock was accepted). The other three failures are findings 2 and 3 and the stricter builder message (below and above).

### 2: prefixes interpolated unquoted into printed commands

**Fix.** `normalizePrefix` allows only `[A-Za-z0-9._-]` in each folder name and refuses a leading `-` (which `node -x/…` would read as an option), so a prefix never needs quoting in `node <prefix>/factory/cli.mjs` or a unit. The one printed command that interpolates other paths, the `adopt cleanup --root … --branch … --worktree …` hint, now shell-quotes each value (`shellWord`); plain paths print exactly as before. Unit files already quoted their arguments.

**Test and fail-before.** "invalid prefixes are refused…" adds `tools/facto tum`, `tools/$(touch x)`, `tools/a;b`, `tools/it's`, `-rf` and `tools/-x`; "workflow ownership follows the recorded prefix, and printed commands quote paths" checks the cleanup hint for a checkout path with a space. On `564f56a`: "Missing expected exception: tools/facto tum".

### 3: workflow ownership ignored the recorded prefix

**Fix.** `core/catalog.mjs` no longer refuses a first segment `factory` at configuration time; `readProjectFile` refuses a workflow path in the recorded upgrade-owned set (`<prefix>/factory/`, the lock, and `<prefix>/VERSION`/`compatibility.json`). With no lock the root `factory/` is still refused, now when the catalog is compiled (config update in delivery mode, and doctor), not when the configuration is validated. `tests/workflow-catalog.test.mjs` changed accordingly: its `factory/workflows/x.json` case now asserts the refusal through `compileCatalog`.

**Test and fail-before.** "workflow ownership follows the recorded prefix…": with prefix `tools/factotum`, a root `factory/flow.json` is accepted and `tools/factotum/factory/flow.json` refused; with `--prefix factory`, `factory/project/workflows/flow.json` is accepted and `factory/factory/flow.json` refused; with no lock, `factory/flow.json` is refused. On `564f56a`: "Got unwanted exception" for the root `factory/flow.json`.

### Results after the review fixes

- `npm test` (after merging `main`): 875 tests, 875 pass, 0 fail, 0 skipped. `tests/install-prefix.test.mjs` has 10 tests (7 from the first round, 3 added).
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Review fixes, round 2

A re-check of `f3b17ed` accepted the direct repros, the catalog assertion change and root-install upgrades across two releases, and rejected it with one blocking and one non-blocking finding.

### 1 (blocking): committed lock changes bypassed protection and reset continuity

**Finding.** `workspace.commit` read only `git status`, so changes a builder had already committed in its worktree were invisible. And `layoutHistory` stopped at the newest commit where the lock was missing, so deleting the lock in one commit and recreating it in the next reset continuity. Repro: adopt under `tools/factotum`; in the builder worktree commit the lock's deletion, then commit it recreated with `prefix: elsewhere` (and a copy of the core) → committed, `adoptionStatus` clean; after merging, a builder edits the original `tools/factotum/factory/` → committed. Variant: recreate a root lock with a forged entry for an application-owned `factory/keep.txt` → status clean, and `prepareAdoption` deletes the file in the update worktree.

**Fix.**

- *Builder protection covers the whole change* (`workflows/dispatch.mjs` `committedOwnedChanges`). Besides pending, staged and untracked paths, `workspace.commit` compares each upgrade-owned item at `HEAD` (the lock, `<prefix>/VERSION`, `<prefix>/compatibility.json` as blobs, `<prefix>/factory` as a tree) with the trusted state: the workspace base the factory prepared the worktree from (`workspace.base`, from factory state). Once the factory has merged the target (a recorded `results.integrate.base` that `HEAD` contains), the target's version is the trusted one wherever the target changed the item. Both commits come from factory state, not from refs a builder could move, so a merge the factory did not record counts as the builder's change. Deleting and recreating, committing, or committing and then restoring different bytes are all caught; committing an edit and reverting it leaves the item unchanged and is allowed. The lock check ignores `allowFactoryEdits`, as before.
- **The pre-existing root `factory/` protection had the same gap.** Before this branch it read only `git status` (`row.slice(3)`), so a builder that committed its core edit in the worktree was never refused. This change closes it for root installations too, and also for projects without a lock.
- *Deletion no longer resets continuity* (`distribution.mjs` `layoutHistory`). It reads every version of the lock in `git log --full-history --topo-order`. A commit where the lock is absent (deleted) or not valid JSON fails closed ("…was deleted in <commit>; a deleted adoption lock is treated as tampering, even if it was recreated"), so recreating it, identically or not, cannot reset anything. Continuity is anchored on adoption commits rather than the nearest lock: for each release record, the oldest commit that wrote it. The current lock must equal its release's adoption commit, and every adoption commit must name the current prefix. `adopt install` refuses a repository whose history already has a lock. At runtime (`core/install-layout.mjs` `readInstallLock`), a missing lock in a repository whose history has one now fails closed for builder commits, service install, upgrade apply and the catalog, instead of falling back to the root layout. Display-only text (`cliCommand`) skips the history lookup.
- *Record correction.* The first-round limit said builders could not exploit a lock replaced in one commit with no earlier history ("Builders cannot do this (they cannot touch the lock)"). That was wrong: committing the deletion and the recreation in the worktree did exactly that. The limit now names what remains (a person committing a lock from scratch in a repository with no lock history).

**Regressions** (`tests/install-prefix.test.mjs`):

- "builder protection covers commits made in the worktree, not only uncommitted changes (re-check repro 1)": the reviewer's precommitted delete and recreate with another prefix; committed edits to `tools/factotum/factory/cli.mjs` and `tools/factotum/VERSION` with nothing uncommitted; an edit committed and reverted (allowed); a committed edit to the root `factory/` of a project without a lock (the pre-existing gap); a builder committing a new lock; and the target's own lock and core change merged by a recorded integration (allowed) versus the same merge unrecorded (refused).
- "a deleted or recreated lock fails closed instead of resetting continuity (re-check repro 2)": a prefixed adoption with an application-owned root `factory/keep.txt`; deleting the lock fails closed at runtime and refuses a reinstall; recreating a root lock with a forged `factory/keep.txt` entry is refused by `adoptionStatus` and `prepareAdoption` (no worktree, file kept); an identical recreation is refused too; and two later same-release rewrites of the prefix are refused against the adoption commit, not the nearest lock.

**Fail before.** The final test file against an export of `f3b17ed`: 13 tests, 9 pass, 4 fail. Repro 1: "Missing expected rejection" (the precommitted lock deletion and recreation were committed). Repro 2: "Missing expected exception" at its first check, a missing lock with lock history read as no lock (the reviewer showed the same commit's `adoptionStatus` clean and `prepareAdoption` deleting the file). Finding 2: below. The fourth failure is only the reworded prefix-change message in the first-round repro 2 test.

### 2: a dangling lock symlink read as "no lock"

**Fix.** `readInstallLock` uses `lstat`: absent (ENOENT) is no lock (subject to the history rule above); a symlink (dangling or not), a folder or any other non-regular file, and an unreadable file all fail closed. `adopt install` treats any existing directory entry at the lock path as already adopted. `distribution.mjs` `readLock` already refused symlinks through `ordinaryPath`.

**Test and fail-before.** "a lock that is a symlink, a folder or unreadable fails closed (re-check finding 2)": a dangling symlink refuses `readInstallLock`, `installPrefix` and `projectUnit`, and doctor's unit check reports it; a symlink to a valid lock, a folder and a mode-000 file (when not root) are refused; an absent lock with no history is no lock. On `f3b17ed`: "Missing expected exception" (`readInstallLock` returned null for the dangling symlink).

### Results after round 2

- `npm test`: 878 tests, 878 pass, 0 fail, 0 skipped. `tests/install-prefix.test.mjs` has 13 tests (3 added in round 2).
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Review fixes, round 3

A further re-check of `1c182a4` stopped early (its provider halted the run) after reporting one blocking finding. The operator added the items it had not reached.

### 1 (blocking): Git object replacement defeated both checks

**Finding.** With `git replace`, the recorded base commit resolved to builder-controlled content, so `workspace.commit`'s base comparison accepted a changed lock or core. A replacement graft hid the lock deletion from the history walk; the forged lock then reported clean and an update removed the application file.

**Choice: verified object reads in the project repository.** Builder worktrees share the common Git directory, so a builder can write its refs, config, `info/`, hooks and object files; disabling replace refs alone leaves grafts, the commit-graph cache, shallow boundaries, alternates and rewritten loose objects or packs. The options considered were (a) environment hardening only; (b) reading from a separate repository the builder cannot write, such as a private mirror in factory state or the remote target; and (c) verifying every object read against its ID. (b) is not stronger in this deployment: builders run as the same OS account, so a mirror in the state directory is just as writable by a builder that looks for it, and the remote does not hold the builder's commit, which is what has to be checked. (c) makes the content of every object the checks use independent of anything writable: an object whose bytes do not hash to the requested ID is refused, and parents and tree entries come only from verified bytes. Only a hash collision could change what the checks see. It costs no extra fetch or network access. (c) is implemented, combined with (a):

- `core/verified-git.mjs`: `VerifiedObjects` reads objects through `git cat-file --batch` and hashes each one (SHA-1 or SHA-256, from the ID length) before use. It parses commits (tree and parents) and trees itself, resolves paths, and checks ancestry with a bounded walk over verified parents. `lockHistoryGraph` takes `git rev-list` only as a proposal: every commit is verified, parents come from the commit bytes, and the set must be closed under parents, so a commit (or a deletion) cannot be hidden. Every command runs with `GIT_NO_REPLACE_OBJECTS=1`, `GIT_GRAFT_FILE` set to a path that cannot exist (`/dev/null/factotum-no-grafts`; Git then reads no grafts, and unlike `/dev/null` it prints no deprecation hint), `core.commitGraph=false`, hooks off, and no system or global config. `assertNoHistoryRewrites` refuses a repository with any `refs/replace/*`, an `info/grafts` file in the common directory, or (for history walks) a shallow history.
- *Builder protection* (`workflows/dispatch.mjs`): `committedOwnedChanges` reads base, target and candidate through `VerifiedObjects` in the project repository, and checks target ancestry with the verified walk. It runs before the commit, on the builder's `HEAD`, and again on the commit the factory has just made, because staging can run clean filters and, in rehearsal mode, hooks. A violation in the factory's own commit is undone with `git reset --soft` to the previous `HEAD`, so the changes go back to being uncommitted. The status-based check stays as an early, readable refusal.
- *Continuity* (`distribution.mjs` `layoutHistory`) works on the verified graph. "Adoption commit" is now defined from the graph rather than from log order: a commit whose lock has a release record that none of its parents' locks have. The rules are unchanged: deleted (absent while a parent had it), non-regular or invalid JSON at any commit fails closed; the current lock must equal every adoption commit of its release; every adoption commit must name the current prefix.
- *Runtime* (`core/install-layout.mjs` `lockHistory`) uses the same verified graph when the lock is missing.
- *Everything else the adoption and upgrade paths run*: `distribution.mjs` `git()` and `buildRelease`'s object reads, and `upgrade-apply.mjs` `git()` (fetch, ancestry, fast-forward merge), run with the same replace, graft and commit-graph settings. `mergeUpgrade` and `activateUpgrade` refuse a repository with replace refs or grafts before stopping anything. `upgrade-apply` keeps the user's global config, which `push` credentials need.

**Regressions and fail-before** (`tests/install-prefix.test.mjs`, run against an export of `1c182a4`: 18 tests, 13 pass, 5 fail):

- "replacement refs cannot make a changed lock or core match the workspace base": a builder commits a retargeted lock, then `git replace <base> <its commit>`. Refused ("replacement refs"), and `VerifiedObjects` resolves the base's real lock while plain Git follows the replacement. On `1c182a4`: "Missing expected rejection".
- "a rewritten object file cannot make a changed lock match the workspace base": the builder overwrites the base commit's loose object file with its own commit's content under the base ID; plain Git then reads the forged base. Refused ("does not match its id"). On `1c182a4`: "Missing expected rejection".
- "grafts and replacement grafts cannot hide a lock deletion from the history walk": the round-2 delete/recreate history with the deletion hidden by an `info/grafts` line and, separately, by `git replace --graft`. Plain `git log` no longer shows the deletion; `adoptionStatus` and `prepareAdoption` refuse (no worktree, the application file kept), and the runtime refuses once the lock is missing. On `1c182a4`: "Missing expected exception" (status clean with the grafts file).

### 2: the items the re-check had not reached

Each either cannot affect the checks or is refused. Tests are in "config, hooks, attributes, filters, symlinks, case variants and submodules cannot get a core change past the checks" and "adoption refuses core.worktree redirection, a submodule at the prefix and a shallow history". On `1c182a4` the first failed because a `pre-commit` hook rewrote the core inside the factory's own commit and the commit was accepted; the second failed because a shallow clone was not refused.

- **Config overrides.** Verified reads ignore config by construction; the commands also run without system or global config, with hooks off, and with `-c` overrides, which beat repository and `include`/`includeIf` config. `core.worktree` in the shared config: adoption commands refuse it because `projectRoot` requires `git rev-parse --show-toplevel` to equal the root (tested). Linked builder worktrees are irrelevant here because the checks read objects, not a worktree. `core.hooksPath`: Factotum's adoption and upgrade commands force `/dev/null`. Delivery-mode builder commits already ran with hooks off; in rehearsal mode the factory's commit can run a hook the builder installed, and the post-commit check refuses and undoes a hook that changes the core (tested). `include.path` is used in the filter test.
- **Attributes and filters.** The checks compare object and tree IDs and never read worktree files or `textconv`/diff output, so `textconv`, `eol` and `diff` attributes cannot change them. A clean filter (from `.gitattributes` plus config, here through `include.path`) that rewrites the core when the factory stages it produces a different stored tree, which is refused (tested). Effects on checked-out files are listed under limits.
- **Symlinked prefix components.** In a candidate, a symlink (`120000`) where a prefix folder belongs is part of the identity the check compares, so it counts as a change and is refused (tested). At installation, `ordinaryPath` already refused symlinks along the prefix.
- **Case variants.** Path identity matches every segment without regard to case, so `Factotum.Lock.Json` or `TOOLS/FACTOTUM/FACTORY/…` added next to the real paths changes the identity and is refused (tested). Unicode normalisation variants are not folded; the target platform is Linux.
- **Submodules at the prefix.** In a candidate, a gitlink (`160000`) replacing the prefix folder changes the identity and is refused (tested). At installation, `prefixLocation` now also refuses a gitlink at or above the prefix in `HEAD`'s tree (verified read), including a submodule that is not checked out, which the existing `.git`-on-disk check missed (tested).

### 3: history-walk cost

Measured with `node evals/history-walk-cost.mjs [commits]` (added; not part of `npm run eval`): a prefixed adoption of the real starter in a scratch repository, updated across 6 releases with ordinary commits in between (written with `git fast-import`, 40 files at the root), 6 commits touching the lock. Timings are the verified walk alone and a full `adoptionStatus` (which includes it), on this machine:

| Commits | Verified walk | `adoptionStatus` | Plain `git log -- factotum.lock.json` |
|---|---|---|---|
| 3,007 | 117–121 ms | 110–120 ms | 15–16 ms |
| 12,007 | 472 ms | 416 ms | 51 ms |

The walk is linear in commits (one batched read of all commits, one of their root trees, one of the distinct lock blobs) and runs once per adoption command or builder commit that needs it (cached per `HEAD` within a process).

### Results after round 3

- `npm test`: 883 tests, 883 pass, 0 fail, 0 skipped. `tests/install-prefix.test.mjs` has 18 tests (5 added in round 3).
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Review fixes, round 4

A re-check of `a181a25` approved the verified-read design (every attack from rounds 1 to 3 refused; SHA-1 and SHA-256, loose and packed objects, all tree modes, three-parent merges and normal use checked) with fixes. `main` was merged first (`9e43be5`); `starter/factory/workflows/dispatch.mjs` conflicted where both sides added functions after `runChecks` (this branch's `changedPaths`/`committedOwnedChanges`, main's planner and review guidance from the planning-convergence change); both were kept.

Fail-before for the round-4 tests: the final test file against an export of `9e43be5` (round 3 plus `main`): 24 tests, 18 pass, 6 fail, each named below.

### 1 (blocking): a conflicted merge was refused when the target carried an upgrade

**Cause.** During the factory's integration merge, `git status` lists the target's own changes as staged; when the target carried an upgrade, the early status check saw the lock and core and refused, and `allowFactoryEdits` could not lift the lock refusal. **Fix.** While a merge is in progress (`MERGE_HEAD` exists), the status-based early check is skipped; the verified tree comparison on the commit decides, and it compares with the recorded target, so the target's lock and core are accepted and anything the builder adds is not. **Regression** "a conflicted integration whose target carries an upgrade commits as a merge": the commit has both parents and the target's lock; the same merge without a recorded integration is refused. On `9e43be5`: refused with "factotum.lock.json is changed only by adopt install/update".

### 2 (blocking): the undo dropped the merge state

**Cause.** `git reset --soft` after a refused commit that concluded a merge removed `MERGE_HEAD`, so a retry would have made a single-parent commit holding the target's changes as the builder's. **Fix.** `workspace.commit` saves `MERGE_HEAD`, `MERGE_MSG` and `MERGE_MODE` before committing and writes them back after the undo. **Regression** "refusing a commit that concluded a merge keeps the merge in progress": the builder also edits the core while resolving; the commit is refused, `MERGE_HEAD` is the target again, the merge message is back, and after restoring the target's core the retry concludes the merge with both parents. On `9e43be5` it stops at finding 1; with only the finding-1 change applied to that export, it fails because `MERGE_HEAD` no longer exists after the undo.

### 3: the history walk's memory

**Cause.** `layoutHistory` parsed the lock once per commit, and the walk kept every commit and root-tree body. **Fix.** Parsed locks are cached by blob ID (a long history has a handful). `VerifiedObjects.each` streams verified objects batch by batch, and `lockHistoryGraph` keeps only each commit's tree and parents and the lock entry of each root tree; only the distinct lock blobs are kept. One graph is cached per process. `evals/history-walk-cost.mjs` now runs a cold `adoptionStatus` in a fresh process and reports its peak resident memory (the earlier version timed a cached call).

### 4: the ancestry check spawned Git once per generation

**Fix.** `VerifiedObjects.reaches` takes the newest 5,000 commits from `git rev-list --max-count` as a proposal, verifies them in one batched read, and walks parents parsed from verified bytes; a commit outside the proposal counts as not reachable (the stricter answer), so a false "reachable" is still impossible. Two Git processes instead of one per generation.

**Measurements** (`node evals/history-walk-cost.mjs <commits>` with a short `TMPDIR`, this machine; "before" is the same script run against an export of `a181a25`). Ancestry is the check `workspace.commit` makes when the recorded target is not in `HEAD`, as in a conflicted merge.

| Commits | Cold `adoptionStatus` before | after | Peak memory before | after | Ancestry check before | after | Plain `git log -- lock` |
|---|---|---|---|---|---|---|---|
| 3,007 | | 142 ms | | 83 MB | | 47 ms | 14 ms |
| 6,007 | 432 ms | 243 ms | 280 MB | 99 MB | 8.9 s | 74 ms | 24–29 ms |
| 12,007 | 836 ms | 449 ms | 443 MB | 133 MB | 12.3 s | 69 ms | 46–49 ms |
| 60,007 | | 2.7 s | | 267 MB | | 78 ms | 250 ms |

The reviewer measured 866 ms and 775 MB at 12k and 4.2 s and 3.4 GB at 60k for the old code, and 19.2 s for a whole `workspace.commit` at 6k. Memory now grows by roughly 3 KB per commit (the parent graph and `rev-list` output), not with the lock's size; the ancestry check is bounded by its 5,000-commit window.

### 5: rehearsal mode does not pin the trusted target

The round-2 record said the base and target "come from factory state". The commits do, but in rehearsal mode `workspace.integrate` fetches the remote by name from the shared Git config, which a builder can repoint (`remote.origin.url`), so the recorded target can be a builder's commit. In delivery mode it cannot: `prepareGitInvocation` pins every fetch and push to `https://<host>/<slug>.git` and refuses repository transport overrides. The protection's trust in the recorded target therefore holds in delivery mode only. Pinning rehearsal would need the remote's URL captured into factory state when the workspace is prepared, which rehearsal does not record today; not done in this change. Rehearsal runs scripted or trusted fixtures.

### 6: a lock-less project in a shallow clone

**Decision: restored.** Round 3 made the runtime's "is there a lock in history" lookup refuse a shallow clone, which broke `workspace.commit`, catalog compilation and `service install` for every project without a lock in one. The lookup (`lockInHistory`) now walks the visible history and stops at the clone's boundary commits (from the `shallow` file). A lock anywhere in the visible history still fails closed. Why it is safe enough: the lookup matters only when the checkout has no lock, a builder can neither delete nor add the lock (builder protection), and a project with a lock never reaches it. Replace refs and grafts are still refused, and adoption commands still refuse shallow clones. Documented in `docs/updates.md` (Shallow clones) and the adoption guide. **Regression** "a project without a lock works in a shallow clone…": builder commits work (and core edits are still refused); a lock deleted within the visible history is refused; with a lock, the runtime works, `adoptionStatus` refuses, and the files-only drift check works and finds a patch. On `9e43be5`: "this repository is a shallow clone".

### 7 and 9: the live checkout after `upgrade apply`, and doctor

**Fix.** `mergeUpgrade` gains a `verify` step right after `merge`: the live checkout must hold the release with the expected manifest digest and every installed file must match the lock; otherwise the upgrade stops before recommissioning (units are restarted as before). `activateUpgrade`'s `pull` step, which already checked the digest, now also requires a clean status. Doctor adds `adoptionDrift` (`distribution.mjs`) for projects with a lock: `adoptionStatus` in a files-only mode (`history: false`: the lock's validity, its layout evidence, and the installed files, with no history walk), so a shallow checkout still reports drift. Each difference is a blocking reason. **Regressions:** "doctor refuses an adopted project whose installed files differ from the lock" (the real `doctor` with a delivery fixture: ready, then a committed and pushed core patch, which leaves the checkout clean and in sync, makes it not ready with the drift reason); "upgrade apply --merge verifies the live checkout after merging" (`core.autocrlf` only in the live checkout's per-worktree config: the merged files land with CRLF, `verify` fails naming them, and neither `config update` nor doctor runs). On `9e43be5`: doctor was ready despite the patch, and the upgrade reported `ok`. `tests/upgrade-apply.test.mjs` now expects the `verify` step.

### 8: Factotum's own Git calls ran planted config

**Fix.** `NO_PLANTED_COMMANDS` (`-c core.fsmonitor=false`, in `core/git-options.mjs`) is added to every Git call in these paths: `distribution.mjs`, `upgrade-apply.mjs`, `verified-git.mjs`, the status and reset calls in `workspace.commit`, and `prepareGitInvocation` (all workspace Git calls). Unscoped (rehearsal) workspace calls now also run with hooks off and signing off, as delivery calls already did; `tests/github-git.test.mjs` expects those options. Filters are deliberately left on (projects use Git LFS), as are credential helpers and `core.sshCommand` outside delivery scope; the record's limit on the same-account boundary now says exactly what Factotum's own commands still run.

### 10: minor

`adopt status` (and plan or update) on a project that never adopted now says "this project has not adopted Factotum (no factotum.lock.json at its root); use adopt install"; a missing lock with one in history still says it was deleted. `VerifiedObjects` normalises tree entry modes (`040000` is `40000`), so an old zero-padded folder mode is not a change. **Regression** "adopt status on a project that never adopted says so; zero-padded folder modes are not a change" (a commit with a hand-written `040000` tree has the same identity as the original). On `9e43be5`: the old "restore it from the adoption commit" message.

### Results after round 4

- `npm test` (short `TMPDIR`): 904 tests, 904 pass, 0 fail, 0 skipped. `tests/install-prefix.test.mjs` has 24 tests (6 added in round 4).
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Review fixes, round 5

A Fable 5.2 re-check of `4a9ebd2` approved round 4 with fixes and one blocking regression. `main` was merged first (`6e28f08`, the dev.82 trial code items); it merged without conflicts.

Fail-before for the round-5 tests: the final test file against an export of `6e28f08` (round 4 plus `main`): 30 tests, 24 pass, 6 fail, one per new regression, each named below.

### B1 (blocking): a builder could hide the recorded target and revert its upgrade

**Cause.** `VerifiedObjects.reaches` walked only the commits `rev-list --max-count=5000` proposed. Anything that kept the target out of that proposal produced "not reachable": a `shallow` file planted in the shared Git directory above the merge, a merge backdated behind 5,000 newer commits (`rev-list` orders by date), or 5,000 empty commits after the merge. `committedOwnedChanges` then compared with the workspace base instead of the target, so a candidate that contained the target but carried the base's lock and core over the upgrade was accepted. The round-4 comment called "not reachable" the stricter answer; for this caller it was the lenient one.

**Fix.**

- `reaches` now answers only "provably reachable" or "not shown", and its walk is complete. It follows parents parsed from hash-verified commits, from the candidate down. `rev-list` (run with `GIT_SHALLOW_FILE` pointing at a path that cannot exist, so a planted `shallow` file is ignored) only warms the cache in batches of up to 20,000; any commit the walk reaches that was not proposed is read and verified directly, and warming restarts from there. So neither `rev-list`'s ordering, a window, nor a `shallow` file decides the answer. A commit that is genuinely absent (a real shallow clone) ends that branch.
- `committedOwnedChanges`: when a target is recorded, the candidate must be shown to contain it, otherwise the commit is refused ("the candidate … does not contain the recorded target … that the factory integrated"). It is never compared with the base instead. The check runs on the builder's `HEAD` before the factory's commit and on the factory's commit after it. During the factory's own merge (`MERGE_HEAD` present), the pre-commit check on `HEAD` is skipped, because `HEAD` legitimately lacks the target until the merge is concluded; the concluding commit has the target as a direct parent and is checked after the commit, as before.

**Regressions** (each failed on `6e28f08` with "Missing expected rejection"):

- "a planted shallow file cannot hide the recorded target": the builder merges the target, commits the base's lock and core back on top, and writes a `shallow` file naming that commit (plain `git rev-list` then shows one commit). Refused.
- "a backdated merge behind thousands of newer commits cannot hide the recorded target": a merge of base and target dated 1980, a 5,001-commit side chain of recent commits from the base, and a join commit with the side chain's tree (the base's lock and core). The merge is outside the newest 5,000. Refused.
- "thousands of empty commits after the merge cannot hide the recorded target": merge, revert the upgrade, then 5,000 empty commits. Refused. The same test checks that a candidate without the recorded target at all is refused with the new message.

The round-4 conflicted-merge and undo tests still pass.

**Cost.** `evals/history-walk-cost.mjs` (each size run on its own, short `TMPDIR`) times the worst case, a target that is not in the candidate, which now walks the whole history before refusing; a legitimate merge finds the target at once as a direct parent.

| Commits | Ancestry check, target absent (round 4, 5,000-commit window) | Round 5, complete walk | Cold `adoptionStatus` | Peak memory |
|---|---|---|---|---|
| 6,007 | 74 ms | 82 ms | 259 ms | 98 MB |
| 12,007 | 69 ms | 139 ms | 459 ms | 133 MB |
| 30,007 | | 419 ms | 1.1 s | 198 MB |
| 60,007 | 78 ms | 697 ms | 2.3 s | 268 MB |

### N1: doctor and a symlinked project path

`initProject` stores `resolve(root)`, which can keep a symlinked folder; the drift check requires a canonical path. Doctor now passes `realpathSync(project.root)` to `adoptionDrift`; what is stored is unchanged. **Regression** "doctor reads the drift check through a symlinked project path": a project registered through a symlinked folder gets no lock-check failure, and still gets the drift reason after a core patch. On `6e28f08`: "adoption lock check failed: distribution paths must not contain symlinks".

### N2: after a failed `verify`

`docs/updates.md` ("When `verify` fails after `--merge`") gives the recovery: the checkout already holds the merged release and rerunning `--merge` is impossible, so restore the named files (turning off a line-ending conversion if that is the cause), push if `--push` was intended, `adopt cleanup`, then `config update --current` and doctor. The `verify` error says the same in short. The drift message from doctor and `verify` now names line-ending conversion (`core.autocrlf`) as a possible cause next to "restore them from the adoption commit".

### N3: the history cache and the shallow boundary

The per-process cache key for `lockHistoryGraph` now includes the `shallow` file's commits. **Regression** "the history cache follows the shallow boundary": with a boundary that hides a lock deletion the lookup reads "no lock"; after the boundary is removed, the same `HEAD` is walked again and refused. On `6e28f08`: the cached "no lock" was returned.

### N4 (pre-existing): a merge whose resolution equals `HEAD`

The workspace adapter skipped the commit when nothing was staged, leaving `MERGE_HEAD` in place while the route said `committed`. It now concludes a merge in progress even when its tree equals `HEAD` (`git commit --allow-empty`, which records both parents), and reports `committed: true`. **Regression** "a merge whose resolution equals HEAD is concluded with both parents": parents are base and target and no merge is left in progress. On `6e28f08`: `committed` was false and `MERGE_HEAD` remained.

### N5: `core.fsmonitor` in other factory Git calls

Added `-c core.fsmonitor=false` to the three named sites (`core/repository.mjs` fingerprint listing, `workflows/actions.mjs` `changedFiles`, the review and gate cleanliness check in `dispatch.mjs`) and to the other worktree-reading calls a search found: admission's untracked listing (`actions.mjs`) and workspace cleanup (`operations/workspace-cleanup.mjs`). `operations/conflicts.mjs` already had it, and doctor's calls go through `prepareGitInvocation`. The limits paragraph lists where it is off.

### Results after round 5

- `npm test` (short `TMPDIR`): 928 tests, 928 pass, 0 fail, 0 skipped. `tests/install-prefix.test.mjs` has 30 tests (6 added in round 5).
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Review fixes, round 6

A Fable 5.2 re-check of `2ed6f44` confirmed B1 (planted shallow files, backdated merges, empty commits past 25,000, six forged `MERGE_HEAD` variants, a fake commit with the target's tree, a real depth-40 shallow clone), the round-5 costs, and N1 to N4. It found one blocking gap that predates round 5. `main` was merged first (`6058ac9`, the console Stats fix); it merged without conflicts.

Fail-before for the round-6 tests: the final test file against an export of `6058ac9`: 34 tests, 32 pass, 2 fail (B2 and F20 below). The shallow-clone walk test passes there too: it checks the answer, which was already right, and its cost is in the table below.

### B2 (blocking): a builder could merge the target itself and revert its upgrade

**Cause.** `workspace.commit` compares with the recorded target only once the factory has integrated one. Before the first integration it compares with the workspace base. A builder that merged a newer target (one carrying an upgrade), checked the base's lock and core back out and committed was therefore compared with the base, and accepted. `workspace.integrate` then found the target already merged, returned `integrated` and recorded it, and nothing checked the owned files again. The candidate went on to publish, review, gate and merge carrying the base's lock and `<prefix>/factory/`, so the merge into the target would have undone the upgrade.

**Fix** (`workflows/dispatch.mjs`).

- `workspace.integrate`: after every integration that does not conflict, including the already-merged case, `committedOwnedChanges` runs on the resulting head against the target just recorded. Any owned difference that does not come from the target is refused before anything is published ("… (the integrated candidate differs from the target)"). A conflicted integration goes to the conflict question as before; the commit that concludes it is checked by `workspace.commit`.
- Other routes to publish. In the reference graph, `commit` and the adopted-candidate path both lead to `integrate`, and `forge.merge` already requires a recorded integration. A project's own workflow could still reach `forge.publish` without integrating. Comparing that candidate with the base is not safe (the base is exactly what a builder-side merge can revert to), so `forge.publish` now requires a recorded integration and checks the candidate's owned files against it before pushing ("forge.publish needs the factory to have integrated the target first: add a workspace.integrate step before forge.publish"). Publishing is the only way a candidate leaves the workspace, so this covers any graph. `tests/publication-rounds.test.mjs` calls `forge.publish` directly and now passes a recorded integration (the workspace base), as a real flow would.
- The three refusals share `refuseOwnedChanges`: the lock always, the rest unless `policy.allowFactoryEdits`.

**Regressions.** "a builder that merges the target itself and reverts its upgrade is refused at integration": the reviewer's scenario through the real `workspace.commit` (accepted), `workspace.integrate` (refused) and `forge.publish` (refused with the recorded integration, and refused without one). On `6058ac9`: "Missing expected rejection" at integration. "an ordinary candidate integrates a target that carries an upgrade": normal use, the merged head carries the target's lock.

**Intended consequence (item 5).** A builder that aborts the factory's conflicted merge and commits is refused ("does not contain the recorded target"): the candidate no longer contains the target the factory recorded. Documented in `docs/updates.md` ("Builder changes and the target").

### 1: doctor's behind-the-target check ignored the recorded prefix

`operatorCheckout` (F20) compared the running code's folder, a hardcoded root `factory/` and the lock. It now uses `upgradeOwned`: the lock, `<prefix>/factory/`, `<prefix>/VERSION` and `<prefix>/compatibility.json` (with no lock: `factory/` and the lock path), plus the running code's folder when it is inside the checkout. A prefixed project's own root `factory/` no longer counts; a root installation's `VERSION` and `compatibility.json` now do. An unreadable layout is a doctor reason. **Regression** "doctor's behind-the-target check follows the recorded prefix": with prefix `tools/factotum`, a remote change to root `factory/notes.md` is only a warning, while changes to `tools/factotum/VERSION` and `tools/factotum/factory/cli.mjs` are reasons; without a prefix, root `factory/notes.md` is a reason as before. On `6058ac9`: the prefixed project's root `factory/notes.md` was a reason.

### 2 and 3: the ancestry walk in a real shallow clone, and hostile shapes

**Cause.** Round 5 warmed the cache with `rev-list` repeatedly. With the shallow file ignored, `rev-list` exits with an error at a real clone's boundary, and `warm` discarded its partial output, so the walk fell back to two processes per generation. And every warm could re-propose commits already verified.

**Fix** (`VerifiedObjects.reaches`). Three phases: (1) up to 64 generations read directly, which finds a legitimate target at once; (2) exactly one complete proposal, `rev-list --stdin` of everything reachable from the remaining frontier (any shallow file ignored), with partial output kept when it stops at missing commits; (3) anything the walk then reaches unproposed is read and verified directly, and a genuinely missing commit ends its branch. The answer still depends only on verified parents. No `^commit` exclusions are used: they would also exclude those commits' ancestors, which include the frontier. One proposal, and each commit verified at most once, make the work linear in commits whatever the shape.

**Measurements** (`evals/history-walk-cost.mjs`, new modes `--shallow <depth>` and `--merges <n> [chain]`; "before" is the same script against an export of `6058ac9`; refusal = target not reachable, the worst case):

| Shape | Commits | Before | After | Peak memory after |
|---|---|---|---|---|
| Real shallow clone, depth 2,000 | 2,000 | 13.4 s | 153 ms | 70 MB |
| 1,000 merges, 25-commit future-dated chains | 26,001 | 344 ms | 471 ms | 102 MB |
| 1,000 merges, 60-commit future-dated chains | 61,001 | 835 ms | | |
| 3,000 merges, 25-commit future-dated chains | 78,001 | | 1.0 s | 184 MB |

The reviewer measured 62 s at 1,000 merges and 205 s at 3,000 on round 5. My constructions of that shape (merges on a past-dated first-parent line, each second parent a chain branching from the previous merge, chains future-dated) did not reproduce it on round-5 code here (344 ms and 835 ms above), so the reviewer's exact shape differs from mine. The fix does not depend on the shape: there is exactly one proposal per call, so the round-5 cause, repeated proposals of known commits, cannot recur. The reviewer's script would confirm the number.

### 4: `git check-ignore`

`operations/inputs.mjs` now runs it with `-c core.fsmonitor=false`.

### 6: setup checklist

`starter/project/SETUP_CHECKLIST.md` now names the installed core (`factory/`, `VERSION`, `compatibility.json`) under the install prefix when the lock records one.

### Results after round 6

- `npm test` (short `TMPDIR`): 935 tests, 935 pass, 0 fail, 0 skipped. `tests/install-prefix.test.mjs` has 34 tests (4 added in round 6); `tests/publication-rounds.test.mjs` passes a recorded integration.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

## Follow-ups

[dev82-protection-followups.md](dev82-protection-followups.md) records three later fixes. F1: `forge.publish` now requires the workspace `HEAD` to be the head of the last non-conflicting integration (round 6 accepted any candidate containing the recorded target), and commissioning refuses a graph that can reach `forge.publish` other than from `workspace.integrate`'s `integrated` result through input-preserving steps. F2: the candidate's own commits may not change upgrade-owned files, even when a later commit undoes the change; this supersedes round 2's "an edit committed and reverted … is allowed" (now allowed only under `policy.allowFactoryEdits`, and never for the lock), and refuses round 6's B2 scenario at `workspace.commit` rather than at integration. F3: round 6's claim that one proposal keeps the ancestry walk linear "whatever the shape" was wrong for proposals that stop early; the walk now proposes again from the unread frontier.

## Limits and open questions

- The prefix is fixed at installation; moving an existing installation to or from a prefix is not supported by the tools.
- An older CLI run against a prefixed project refuses (it sees every managed file missing at the root) rather than giving a clear "prefix not supported" message. Upgrades should use the release's own CLI, as documented.
- The lock cannot authenticate itself. Layout evidence binds a prefixed lock to the manifest digest it names, and history binds every lock to the adoption commits that wrote it, and a lock deleted anywhere in history fails closed. What remains undetected is a lock committed from scratch, with a new release record, digests and layout, in a repository whose history never had one; the plan then shows a `from` release nobody adopted. (The first-round record said builders could not exploit the history reset; the re-check showed they could, by committing the deletion and recreation in the worktree. Round 2 closes that: builder protection now covers committed changes, and deletion no longer resets history.) A builder cannot create a lock either: a lock that the workspace base does not have is a builder change. A person with commit rights can, and such changes go through review.
- Root locks carry no layout evidence (their shape is unchanged). In a repository whose history never had a lock, a root lock committed from scratch by a person with a forged managed entry could name a project file in the root `factory/` and an update would remove it. Once a repository has any lock in its history, a deleted and recreated one is refused.
- Removing an installation and adopting again in the same history is refused (a deleted lock reads as tampering); it needs the history repaired or an explicit baseline audit.
- Adoption commands refuse a shallow clone (they cannot prove the history complete). The running factory, builder protection, service install and doctor work in one. A project without a lock works in a shallow clone when its visible history has no lock; a deletion beyond the clone's boundary, or hidden by a builder-written `shallow` file, is then not visible. That is accepted because a builder cannot delete the lock (builder protection) and only the absent-lock case uses the boundary.
- Checks compare Git objects. What a checkout writes to disk (line-ending conversion, `ident`, `working-tree-encoding`, a smudge filter) is checked on the files instead: doctor and `upgrade apply` run the files-only drift check (round 4). Between a doctor run and a later checkout, nothing re-checks the files before `serve` starts.
- The shared Git directory stays builder-writable, and Factotum's own Git commands can run config planted there, except where switched off. Switched off: hooks (adoption, upgrade, and every workspace Git call in delivery and now rehearsal), `core.fsmonitor` (every factory Git call that reads a worktree: adoption, upgrade, the verified reads, every workspace call, `workspace.commit`, the review and gate cleanliness check, admission's changed and untracked file listings, the repository fingerprint, workspace cleanup, conflict scans and the input ignore check; tree-to-tree diffs do not read a worktree), signing programs (workspace calls), replace refs, grafts and the commit-graph (adoption, upgrade, protection). Still run: clean and smudge filters, because projects rely on them (Git LFS), so a planted filter runs inside `adopt update`'s `git worktree add` and the workspace's `git add`; the verified checks and the drift check catch what it changes in upgrade-owned files, not what it executes. Credential helpers and `core.sshCommand` also still run for `upgrade apply`'s fetch and push outside delivery scope, because users configure them legitimately. The operator's own Git commands outside Factotum run all of it. This is the same-account trust boundary the README states.
- Rehearsal mode does not pin the target remote's URL (see round 4, finding 5).
- Builder protection reads the candidate's own commits too (follow-ups, F2). When an own commit changes an owned path (on refusal, or accepted under `allowFactoryEdits`) it walks the whole trusted history once more; gaps that stop a `rev-list` listing (an absent parent on a Git older than 2.44, or an unreadable object) make the ancestry walk linear in their number, about six Git processes each (follow-ups, F3 and its review fixes). The repository's shallow file is read as a hint only within size and entry limits. In a real shallow clone, a candidate forked below the boundary can be refused falsely; the refusal suggests `git fetch --unshallow`.
- A prefixed installation needs a release in the canonical form `release build` writes (it rebuilds the manifest to check the lock); a hand-made manifest in another key order is refused at install.
- The ignore-rule check runs only for prefixed installs. A root install into an ignored `factory/` would still produce an incomplete adoption commit, as before.
- The console's "No registered projects" hint names the root-layout CLI.
- Project-owned templates other than `factotum.template.json` keep root-layout paths in their text; adopters under a prefix adjust them (each now says so).
- Not exercised: a real systemd unit start, a real GitHub push during `upgrade apply`, or a project using Jest/Vitest discovery; the tests cover file placement and generated paths.
