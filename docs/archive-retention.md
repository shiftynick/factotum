# Archive-first retention

The optional supervised `retention.archive` operation expires project-owned artifacts and terminal worktrees only after a verified external archive exists. It is disabled unless the installation supplies explicit scope, age thresholds and current preservation discovery. No cleanup has been run against a real project as part of reference qualification.

Private configuration:

```json
{
  "retention": {
    "enabled": true,
    "archiveRoot": "/mounted-private-archive/factory",
    "artifactRoots": ["artifacts", "evidence"],
    "artifactAgeMs": 1209600000,
    "worktreeAgeMs": 259200000,
    "preservation": {
      "argv": ["node", "project/tools/preservation-inventory.mjs"],
      "timeoutMs": 60000
    }
  }
}
```

These ages are illustrative project choices. No expiration age is implied when a field is omitted. Artifact subroots are relative to private project state; the state root, attempts, workspace ownership trees and retention staging cannot be selected as generic artifact roots. The archive destination must be outside state, including after resolving symlinks. A mounted remote archive is supported as a filesystem destination; transporting or mounting it is installation work.

The preservation command is trusted configuration and runs under the supervised maintenance attempt. It must fetch current project references and return only JSON:

```json
{"complete":true,"observedAt":"2026-01-01T00:00:00.000Z","protectedPaths":["artifacts/cited-proof"]}
```

The timestamp must be current within sixty seconds. Paths may be absolute or relative to private state. Any protected parent or descendant protects the entire candidate. The installation's command must cover its governing documents, evidence records, live issue citations, keep markers and code-read paths. If discovery is incomplete, fails, or is stale, nothing is deleted. Discovery repeats after archive copy before removing the original. Canonical evidence references are protected independently of the project inventory, including explicit references to ignored files beneath a terminal worktree. Only known workspace ownership-pointer fields, the settled attempt's exact working-directory pointer, the action's exact state-directory pointer and its trusted configuration package are structural execution metadata. Arbitrary result/evidence paths are never excluded simply because they sit under that tree or name the state root.

An explicit `job.enqueue` grant with operation `retention.archive` runs once; a configured daily schedule can run it regularly. Payload `{"dryRun":true}` reports eligibility without archiving or deleting candidates. A live run requires the enabled installation configuration and its normal scoped job/schedule authority. The existing separately approved manual retention manifest workflow remains unchanged.

Artifacts expire by the newest modification time anywhere beneath the candidate. Symlinks and nonordinary filesystem objects remain protected. A compressed archive is staged privately, copied to the external destination and SHA-256 verified there. Before the original can be removed, the external archive file and every ancestor directory are fsynced. Reused archives cross the same durability barrier. A filesystem that rejects these durability operations retains the original and fails the job. Content and citations are checked again before deletion. Canonical references are scanned under a short final SQLite writer transaction, which commits a durable deletion intent. The existing retention hold rejects canonical commands that could add citations throughout asynchronous Git cleanup; Git runs outside the writer transaction so reads and authorized stop commands remain responsive. Run retention in a quiet operational window with drained development. Direct `Store` or raw database writes bypassing canonical commands are unsupported while the hold is active, under the same trusted-account boundary as direct filesystem edits. The durable record retains original path, content identity, external destination and archive checksum. Copy/checksum failures retain the original.

Worktree expiration applies only to terminal or explicitly stopped flows with an observed ending time (`finishedAt`, legacy terminal timestamps, or the durable `flow.finished`/stop event). Unknown or future times remain protected. It verifies ownership, clean state, absence of leases and the current closed PR state. Unpushed commits are preserved in a Git bundle whose external copied checksum and retained head are verified before the existing preservation-aware workspace cleanup removes its own tree and branch. Dirty trees, open PRs and missing PR discovery retain their worktrees. It never deletes remote branches or repositories.

Retention currently requires drained development flows. Concurrent retention is unsupported and `allowConcurrent:true` is rejected. Active flows, unsettled attempts, unanswered inbox questions and unresolved obligations stop retention. Open informational or finished notices do not stop it; their evidence references still protect cited paths. A durable `retentionHold` excludes new development admissions and resumes while the worker removes candidates. Stop flags and cancellation are checked before deletion and again after asynchronous cleanup. Stopping leaves the durable hold and any deletion intent for reconciliation, and prevents later candidates from being removed. An interrupted or failed live run keeps its hold; inspect the retained evidence, then explicitly enqueue the same operation identity via payload `{"operationId":"THE_RETAINED_OPERATION_ID"}` to reconcile. A missing artifact original with an unfinished removal intent is reconciled only when its exact archived bytes still pass checksum and durability verification; missing or corrupt archives retain the hold. Successful reconciliation clears the hold. Do not clear it merely because the worker disappeared: a prior archive or cleanup may need settlement.

Archived evidence is recoverable data, not an automatic state restore. Preserve archive mounting, integrity monitoring and recovery ownership as operational responsibilities. The reference tests exercise real disposable archives, corruption, new citations, symlink rejection, live-writer protection, closed/open PR handling and verified Git-bundle cleanup.

## Recover an interrupted operation

1. Read the canonical hold's `operationId` and owning `flowId`, attempts and archive receipts. Keep the hold in place.
2. If the worker is live, stop/abort that maintenance flow and wait for proven process/cgroup quiescence. Reconcile any uncertain owned attempt with its retained evidence; the hold permits resolution only for its owning flow.
3. Explicitly abandon the stopped maintenance flow after its attempts are settled. This releases its active-flow reservation without clearing the retention hold or deleting archive history. A flow already recorded as completed/failed does not need abandonment.
4. If stop-all paused the project, unpause it through the canonical pause command. The retention hold continues fencing development and unrelated maintenance.
5. Enqueue a newly authorized `retention.archive` job with payload `operationId` set to the retained operation identity. Its fresh maintenance flow becomes the hold owner. Do not start an unrelated operation or change the cleanup scope to bypass reconciliation.
6. Run the recovery job and inspect its receipts. It verifies existing archive bytes and durability, reconciles missing originals/owned Git cleanup, and clears the hold only after successful settlement.
