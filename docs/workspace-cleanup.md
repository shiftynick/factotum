# Cleaning up flow workspaces

A failed or abandoned flow keeps its owned worktree and branch under the project state's `workspaces/` directory. Successful flows release theirs automatically after a proven merge. For failed ones, an operator-run path removes them after preserving everything in them.

A completed flow whose automatic cleanup failed (it has `cleanupPending: true`) is retried by the operations loop and, if that keeps failing, raised as an operator obligation and notice; see [operations](operations.md#cleanup-that-fails-after-a-completed-flow). The same `cleanup plan` and `cleanup apply` commands finish it by hand.

## 1. Plan (read-only)

```sh
node factory/cli.mjs cleanup plan --state <state> --id <flowId>
```

The flow must be `failed` (stop and `flow.abandon` a stopped flow first), or `completed` with a proven merge or recorded satisfied outcome and a workspace that was not released. Its attempts must be reconciled, the workspace's ownership manifest must match, and no other active flow or ready plan may still reference the workspace.

For a completed flow the plan has `outcome: "completed"` and a `mode`:

- `release` when the workspace has no changed, untracked or ignored files, apart from ignored files matching [`cleanup.excludeIgnored`](#leaving-out-reproducible-ignored-files), which are reproducible and are removed with it. `git status` alone does not decide this: ignored files count as unsaved work. Apply releases it exactly as the cleanup step would have: it fetches the target, requires the owned head to be in it (merge method `merge`) or keeps it in a verified bundle under `archives/workspace-commits/` (squash and rebase), then removes the worktree and deletes the owned local branch. If an earlier release was interrupted after the worktree was removed, the plan has `reconcile: true` and apply finishes it.
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
- `[abc]`, `[a-z]` and `[!abc]` match one character, `{dist,build}` either alternative, and `\*` a literal `*`.
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

This creates a standalone repository at the archived head, with the exact working tree and index. Nothing is restored into the project checkout.

Archives live in private project state and are included in backups. They are not deleted automatically. Automatic cleanup of failed flows is not offered; each cleanup is an operator decision. Only a completed flow's own failed cleanup step is retried automatically.
