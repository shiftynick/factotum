# Cleaning up flow workspaces

A failed or abandoned flow keeps its owned worktree and branch under the project state's `workspaces/` directory. Successful flows release theirs automatically after a proven merge. For failed ones, an operator-run path removes them after preserving everything in them.

A completed flow whose automatic cleanup failed (it has `cleanupPending: true`) is retried by the operations loop and, if that keeps failing, raised as an operator obligation and notice; see [operations](operations.md#cleanup-that-fails-after-a-completed-flow). The same `cleanup plan` and `cleanup apply` commands finish it by hand.

## 1. Plan (read-only)

```sh
node factory/cli.mjs cleanup plan --state <state> --id <flowId>
```

The flow must be `failed` (stop and `flow.abandon` a stopped flow first), or `completed` with a proven merge or recorded satisfied outcome and a workspace that was not released. Its attempts must be reconciled, the workspace's ownership manifest must match, and no other active flow or ready plan may still reference the workspace.

For a completed flow the plan has `outcome: "completed"` and a `mode`:

- `release` when the workspace has no changed, untracked or ignored files, apart from ignored files matching [`cleanup.excludeIgnored`](#leaving-out-reproducible-ignored-files), which are reproducible and are removed with it. `git status` alone does not decide this: ignored files count as unsaved work. Apply releases it exactly as the cleanup step would have: it fetches the target into a factory-private ref (so a stale remote-tracking ref never stands in for it), requires the owned head to be in that exact commit (merge method `merge`) or keeps it in a verified bundle under `archives/workspace-commits/` (squash and rebase), then removes the worktree and deletes the owned local branch. If an earlier release was interrupted after the worktree was removed, the plan has `reconcile: true` and apply finishes it.
- `archive` when the workspace has uncommitted or untracked files, or ignored files not covered by `cleanup.excludeIgnored` (the plan reports them as `unsavedIgnored`). Apply archives everything as described below, under `archives/completed-workspaces/`, then releases it.

Either way apply clears `cleanupPending`, marks the `<flowId>:cleanup` obligation `passed`, supersedes its notice and rewrites the completion notice to say the cleanup finished.

The automatic retry uses this same plan, under the flow's cleanup lock: it refuses everything the plan refuses, and it carries out only `release` mode. It never archives or removes a workspace that needs `archive` mode; that goes to the operator at once.

For a failed flow, and for a completed flow in `archive` mode, the plan shows:

- the head, branch, and whether the tree is dirty;
- the number of changed, untracked and ignored files, and the total size;
- any blockers, such as special files (FIFOs, sockets, devices) or a size above `cleanup.maxArchiveBytes` (default 2 GiB);
- what happens remotely. A published PR and its remote branch are always left untouched.

It ends with a `planDigest`.

## 2. Apply (operator)

```sh
node factory/cli.mjs cleanup apply --actor operator --state <state> --id <flowId> --digest <planDigest> --note "<why>"
```

Apply refuses if anything in the workspace changed since the plan. It then:

1. writes an archive under `<state>/archives/failed-workspaces/<id>/`, or `completed-workspaces/<id>/` for a completed flow (see [where archives are kept](#where-archives-are-kept)). The archive contains a self-contained Git bundle of the branch history, a POSIX tar of the complete working tree, and a copy of the index. The tar covers tracked, modified, untracked and ignored files, file modes and symlinks. It excludes the `.git` link. The archive also packs every object the index references, including staged content and conflict stages that exist in no commit.
2. restores the archive into a scratch repository and requires the identical working tree and index before continuing;
3. records the archive and checks the workspace is still unchanged;
4. records the removal intent, removes the worktree and deletes the exact owned local branch;
5. marks the flow `workspaceReleased`. That flow can no longer be replanned; new work uses a new flow.

These steps apply to a failed flow and to a completed flow in `archive` mode; `release` mode is described above.

If it is interrupted after archiving, rerunning `cleanup apply` for the same flow finishes the removal from the recorded archive. It does not plan or archive again.

Markers of an operation in progress, such as `MERGE_HEAD`, are recorded in the archive manifest for inspection. The conflicted files and index stages are restored, but the merge itself is not resumed.

## Leaving out reproducible ignored files

By default everything is archived. A project can commission globs for reproducible output, such as dependencies installed by `workspace.setup`:

```json
"cleanup": {"excludeIgnored": ["site/node_modules/**", "site/dist/**", "site/.astro/**"]}
```

The globs are relative to the workspace root and match exactly in letter case:

- `*` matches any run of characters inside one path segment, and `?` one character. Neither crosses `/`.
- `**` matches across segments, and `**/` also matches no directory at all: `**/node_modules/**` covers `node_modules/x` and `apps/web/node_modules/x`.
- A glob ending in `/**` also matches the directory itself, so `node_modules/**` covers the `node_modules` directory, not only what is in it.
- Path segments that start with a dot are matched like any other. `node_modules/**` covers `node_modules/.pnpm/...` and `node_modules/.bin/...`, and `.next/**` covers `.next/cache/...`.
- `[abc]`, `[a-z]` and `[!abc]` match one character other than `/`, `{dist,build}` either alternative, and `\*` a literal `*`. Inside a class, `\x` is `x` itself (`[a\-z]` is `a`, `-` or `z`), a `]` first is literal, and an unescaped `-` first or last is literal. POSIX classes such as `[:alpha:]`, reversed ranges and characters outside the Basic Multilingual Plane are not supported, and configuration validation rejects a glob that uses them.
- A glob without a leading `**/` is anchored at the root: `.next/**` does not cover `apps/web/.next/`. Use `**/.next/**` for that.

For a pnpm monorepo, for example:

```json
"cleanup": {"excludeIgnored": ["node_modules/**", "**/node_modules/**", "**/.next/**"]}
```

Before dev.97 these globs were matched with Node's `path.matchesGlob`, which never lets a wildcard match a segment that starts with a dot. `node_modules/**` then left out only the non-dot paths, and the pnpm store under `node_modules/.pnpm/`, `.bin/` directories and everything in `.next/` were archived. A completed flow with such files was also archived instead of released. A plan made on dev.96 or earlier may no longer match what dev.97 computes; `cleanup apply` then refuses it as changed, and you plan again.

A path is left out only if it matches one of these globs **and** Git reports it ignored. Tracked files and untracked files that aren't ignored are always archived, even when a glob matches them. The plan reports `excludedFiles`, `excludedBytes` and `excludedDigest`, and its digest covers them, so a change to excluded files still invalidates the plan. The archive's `manifest.json` lists every excluded path with its size and SHA-256. The restore check compares everything else exactly. A restore reports how many paths were left out and that the setup step must be rerun to recreate them.

## Where archives are kept

Everything is under `<state>/archives/`:

- `failed-workspaces/<id>/` holds the archive of a flow that was `failed` (including abandoned) when `cleanup apply` ran.
- `completed-workspaces/<id>/` holds the archive of a `completed` flow whose plan was in `archive` mode. Releases since dev.82 have written completed flows here.
- `workspace-commits/` holds the verified history bundles kept when a squash or rebase merge's workspace is released.

The directory name records the flow's state when the archive was written, not whether anything was lost. `<id>` is derived from the flow and its workspace ownership. The flow's `cleanup` record and `workspaceReleased.archiveDir` name the exact directory, and `cleanup restore` reads it from there. Archives are never moved or renamed by an upgrade.

## Restore

```sh
node factory/cli.mjs cleanup restore --state <state> --id <flowId> --out <new directory>
```

This creates a standalone repository at the archived head, with the exact working tree and index. Nothing is restored into the project checkout. Restore holds the same lock as `archive-slim` and `archive-drop` for its whole run, so neither can change the archive meanwhile (a restore started while one runs is refused, and the other way round). It checks the manifest's own digest and every payload file before extracting anything, and the restored tree against the manifest afterwards. A restore that fails partway removes the directory it was writing, so a directory left at `--out` is always complete.

Archives live in private project state and are included in backups. They are not deleted automatically; the operator can slim any of them and drop those of merged flows, as described next. Automatic cleanup of failed flows is not offered; each cleanup is an operator decision. Only a completed flow's own failed cleanup step is retried automatically.

## Slimming existing archives

Archives written before a glob covered some reproducible output, such as those from dev.96 and earlier whose globs missed paths starting with a dot, can be rewritten without it. This works for any cleanup archive, a failed flow's or a completed flow's, and keeps the flow's work restorable:

```sh
node factory/cli.mjs cleanup archive-slim plan --state <state> (--id <flowId> ... | --all)
node factory/cli.mjs cleanup archive-slim apply --state <state> (--id <flowId> ... | --all) --actor operator --digest <planDigest> --note "<why>"
```

A path is removed from an archive only if `cleanup apply` would leave it out today under the project's current `cleanup.excludeIgnored` globs. The plan restores each archive into a scratch directory beside it (`archives/<kind>/.<id>.slim/`, on the same filesystem) and judges each path there: it must match a glob **and** Git must report it ignored, using only the archived tree's own `.gitignore` files and the archived index (not the project's `.git/info/exclude` or a global excludes file). Commits, tracked, modified, staged and untracked files, and ignored files that match no glob, are kept. The history bundle, index and index objects are not rewritten.

For each archive the plan lists the current and new file counts and bytes, the bytes freed, the globs, a sample of the removed paths (the top of each removed directory) and the current manifest digest. One `planDigest` covers every archive in the selection. Archives with nothing to remove are listed under `unchanged`; refused ones (no archive, a dropped archive, an unfinished cleanup, a manifest that does not verify) under `refused`.

Apply is operator only and cannot be delegated. Under the same lock as `archive-drop`, it plans again and refuses if the digest differs. Then, one archive at a time, it:

1. restores the archive into its scratch directory again and requires the same result as the plan;
2. writes the slim tar as `tree-<digest>.tar` beside the old tar and removes the scratch restore;
3. writes `manifest.slim.json`: the same manifest with the new tree digest and tar, the removed entries appended to `excluded` with their sizes and digests, and `slimmedFrom` (the old manifest digest and tar, the globs, how many entries and bytes went, when, by whom, the note and the plan digest);
4. restores the new archive into scratch space and requires the slim tree and the same index;
5. renames `manifest.slim.json` over `manifest.json`. This is the one commit point: before it the old manifest and tar are complete, and after it the new manifest names the new tar, which is complete;
6. updates the cleanup record (its `archive` summary and an `archiveSlims` history) and records the event `cleanup.archive-slimmed`;
7. removes the old tar.

The run ends with `cleanup.archives-slimmed`. If apply is interrupted, the next plan finds what it left without restoring anything: files the current manifest does not name, and, after a commit, a store record still to update. A plan that finds any such leftovers is a recovery plan (`recovery: true`, entries with `action: "recover"` and their `pending` files and record). Its apply only removes those files, which rolls back an uncommitted slim or finishes a committed one, and updates the record. Then plan again to slim. So a disk too full for another restore can still be brought back to a clean state. Stale scratch directories are removed before any restore.

The plan restores each archive once and apply twice more, one archive at a time, so allow for the time and for free space of one restored archive and its new tar on the archives' filesystem. `cleanup restore` works on a slimmed archive and says that the removed paths, like excluded ones, must be recreated by the project's setup step.

## Dropping the archives of merged flows

Once a flow's change is merged, its cleanup archive is usually no longer needed. The operator can remove such archives to reclaim space, again as a plan and an apply:

```sh
node factory/cli.mjs cleanup archive-drop plan --state <state> --id <flowId> [--id <flowId> ...]
node factory/cli.mjs cleanup archive-drop plan --state <state> --completed
node factory/cli.mjs cleanup archive-drop apply --state <state> (--id <flowId> ... | --completed) --actor operator --digest <planDigest> --note "<why>"
```

`--completed` selects every completed flow that has a cleanup archive; repeated `--id` names flows. One plan and one digest cover every eligible archive in the selection. A flow's archive is eligible only when all of these hold:

- the flow is `completed` with a merged PR (`results.merge.merged`) or a proven satisfied record;
- its workspace is already released, so no live workspace is touched;
- its archived head is kept elsewhere:
  - for merge method `merge`, the head is reachable from the target's commit as fetched now. The plan fetches the target branch into a factory-private ref (`refs/factotum/fetched-targets/…`, removed afterwards), whatever `remote.<name>.fetch` maps, so a stale remote-tracking ref never counts. The plan shows that exact commit as `targetHead`, and its digest binds it: if the target moves at all before apply, backwards or forwards, apply refuses and you plan again;
  - for squash and rebase, a verified bundle of the head is kept under `archives/workspace-commits/`. A flow released by `cleanup apply` in `archive` mode has no such bundle, because its archive holds its only copy of the branch commits, so it is refused;
  - for a satisfied flow, the archived head is the exact head the satisfied record proved. Any other head, such as a later commit, must be reachable from the fetched target or kept in a verified `workspace-commits` bundle;
- each archive directory verifies: `manifest.json` matches its own digest and the digest the cleanup recorded, belongs to this flow and head, and the bundle, tree, index and object pack match it;
- the archive holds nothing beyond its committed head. A merge proves only the committed head is safe. The plan restores the archive into scratch space beside it and asks Git, with only the archived tree's own ignore rules, for its status: any staged, modified, deleted or untracked path, any ignored path the commissioned `cleanup.excludeIgnored` globs would not exclude, or an operation recorded as in progress refuses the archive. The reason names how many of each and the first paths. There is no override: shrink such an archive with `cleanup archive-slim`, which keeps that work.

In practice a completed flow is archived only because its workspace held such files, so an archive becomes droppable when all it holds beyond the head is ignored output the current globs cover, for example a dependency store the dev.96 and earlier globs missed. `archive-slim` removes that output too.

The archive of a `failed` or abandoned flow is never dropped, even when its change was later merged by other means: it may be the only copy of unsaved work. With `--completed` the plan counts them as `keptFailedFlowArchives`. `archives/workspace-commits/` is never touched.

The plan lists, for each eligible flow, the archive directory or directories (the flow's directory under `failed-workspaces/` or `completed-workspaces/`), every file with its size and SHA-256, the total bytes and the manifest digest. Flows that are not eligible are listed under `refused` with the reason. The plan restores archives into scratch space, so it takes the same lock as apply.

Apply is operator only and cannot be delegated. It takes the archives lock, plans again from scratch (fetching, verifying and inspecting every archive again), and refuses if the digest differs. It then removes exactly the listed directories, one flow at a time. Each flow's `cleanup` record gets `archiveDrop` (status, actor, note, directories, bytes freed), and the event `cleanup.archive-dropped` records what was deleted, the bytes freed, the actor and the note; `cleanup.archives-dropped` summarises the run. `cleanup restore` then says the archive was dropped. If apply is interrupted while removing, the next plan lists that flow with `resume: true` and apply finishes it.
