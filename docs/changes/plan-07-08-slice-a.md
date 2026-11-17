# Plans 7/8, slice A: record and migration contract

Implementation of slice A from [the decision-authority design](../decision-authority-design.md) §10, against main at `23418cb`. Not a release, not a live qualification and not an adopter change. It adds the canonical record contract, immutable task revision snapshots, the per-task authority revision, an explicit offline migration with schema refusal, and retention/backup roots. It wires **no enforcement**: no boundary, command, answer path, admission check or UI reads these records to allow or refuse work yet.

## Records

All records live in the existing `records(kind,id,data)` table. `starter/factory/core/decision-authority.mjs` holds a small closed schema language: every object is closed (unknown keys are refused at every depth), every string, list and map is bounded, and each kind has a total serialized bound. Every record carries `schemaVersion: 1` and `projectId`, which must equal the store's project.

| Kind | Mutability | Main rules beyond the field schema |
| --- | --- | --- |
| `taskRevision` | Immutable | `id = digest(project, task, revision)`; `briefDigest` matches the stored brief (brief ≤ 256 KiB); `requestRefs` derive from the task's `originalRequest` (#5), `requestCoverage` is `recorded` or `unknown`; a migrated snapshot has `historyIncomplete: true` and no `previousRevision`. |
| `taskAuthority` | Monotonic counter | One per task (`id = taskId`); `authorityRevision` only increases, with a closed set of causes. |
| `decisionObligation` | Versioned projection (`version`, `applicability`, `status`, `activeDispositionId`, `supersededBy`, `updatedAt`) | Owner `operator`; scope and option-set digests must match; 1–16 options with unique IDs; `requiredAt` always includes `merge` and `complete`; applicability retains the origin revision; `covered` entries name the active disposition; unresolved has none, resolved/canceled/superseded has one; no self-supersession. |
| `decisionDisposition` | Versioned projection (`status`, `version`, `inactive*`) | Exactly one of `answer`/`cancellation`/`supersession` matching `kind`; cancellation names the exact scope; supersession has replacement decisions or a removed scope tied to a revised revision; inactive records why and when. |
| `operatorGrant` | Versioned projection (`status`, `usage`, `revoked*`) | Issuer and issuing actor `operator`, grantee `orchestrator`; 1–100 entries; immutable payload ≤ 32 KiB; `expiresAt > notBefore`; per-operation exact pins (task approval: revision + workflow; decision disposition: decision version, scope and option-set digests plus exact answers or exact payload; plan consent: plan, context, base and workflow); identifiers and digests cannot be wildcards; usage ≤ `maxUses`. |
| `authorityUse` | Versioned projection | `grant` uses name grant, entry and grant version; `direct-operator` uses name none. |
| `decisionReport` | Immutable | Unique choice IDs, ≤ 64 choices, `completeness` `declared` or `unknown`, body digest matches. |
| `releaseReview` | Versioned projection (`status`, `revoked*`) | Manifest and report-set digests match; dispositions are `accept`, `require-change` or `not-applicable` with rationale and name only reports in the manifest. |
| `legacyAuthority` | Versioned projection (`status`, `resolution`) | Migration inventory row; an ambiguous classification cannot be `retained` without an explicit resolution. |

`putAuthorityRecord(store, kind, record, {expectedVersion})` is the only write path for later slices: it requires the migrated schema, validates, treats immutable kinds as write-once (an identical rewrite is a no-op), and for versioned kinds requires the caller's expected version, an advance of exactly one version, an unchanged immutable part and a permitted transition from the stored version (see [Independent review fixes](#independent-review-fixes)). `auditAuthorityRecords` revalidates everything and checks references: active dispositions exist, belong to their decision and cover it exactly, authority uses and grant entries exist, applicability revisions have snapshots, decisions have an authority revision, replacements exist, supersession is acyclic, report chains and reviewed report versions exist.

`decisionDisposition`, `operatorGrant`, `authorityUse`, `decisionReport` and `releaseReview` are defined and validated only; nothing creates them in this slice.

## Task revision snapshots and authority revision

On a migrated database, `task.put` appends an immutable `taskRevision` snapshot for each new revision, with `previousRevision`, and advances the task's `authorityRevision` in the same command savepoint (a rejected command rolls both back). Recurring occurrences snapshot the same way. A brief-preserving change (labels, `notBefore`, dependency progress) creates no snapshot. A revision that returns to an earlier value keeps its first snapshot. Maintenance job/schedule tasks are not snapshotted. On a schema-1 database nothing new is written.

## Migration and refusal

`operations/authority-migration.mjs`, CLI `authority preview|migrate|status --state <dir>` (`migrate` also needs `--out <new backup dir>`).

- **Opening never migrates.** The Store accepts schema 1 and 2. `init` still creates schema 1. Schema 2 is reached only by `authority migrate`. A schema-2 database without its `authorityMigration` record, or any other version, is refused.
- **Preview** is read-only (verified byte-for-byte on records and the state revision). It reports blocking reasons, the deterministic `migrationId` and inventory digest, counts, the hold reasons, every snapshot and every inventory item, and `creates: {grants: 0, authorityUses: 0, dispositions: 0}`.
- **Apply** refuses unless: a backup destination is given; the project runner lock is free; the project is drained (the existing `drainReasons`: flows other than carried-over question flows, unsettled attempts, authorization-needing obligations); there is no recovery or retention hold; every task has a valid identity/revision and a brief within the snapshot bound. It then, in one `BEGIN IMMEDIATE` SQLite transaction, re-derives the inventory (refusing if it changed since preview), takes a full backup (the only rollback) of that same committed state, installs the write fence, sets `schemaVersion: 2` and `authorityMigration`, writes snapshots, `taskAuthority` rows and `legacyAuthority` rows, records the `authorityHold` reasons, audits the result and emits `authority.migrated`.
- **Crash and rerun.** A crash before commit leaves schema 1 and nothing written (the backup is left behind); rerun with a new backup directory produces the same `migrationId`. A crash after commit leaves the complete migration. A rerun on a migrated database returns `already-migrated` and writes nothing, not even a backup.
- **Old binaries refuse it.** The pre-migration Store requires `schemaVersion === 1`; the test runs the actual `23418cb` runtime from Git history against a migrated database and its backup restore. Upgrade preflight and the launcher also refuse it under `schemaVersions: [1]`. A pre-migration connection opened before the migration is refused by the write fence.

### Inventory classification (never invents authority)

| Item | Classification | Status |
| --- | --- | --- |
| Current approval whose latest `task.approved` event names the current revision and whose enclosing command receipt is a completed operator `task.approve` (same task, revision and workflow binding) or operator `task.restart`, with no `onBehalfOf` | `direct-operator` | retained, citing the command |
| Same, but the receipt is the orchestrator acting on an instruction | `legacy-delegated` | held |
| Approval with no matching event, a different revision, a different workflow binding or no proving receipt | `legacy-unverified` | held |
| Recurring-configuration approval | `configured` (operational only, never a product answer or plan consent) | retained |
| Open standalone (schema-1) question | `informational-v1` | held for review |
| Open workflow question | `ambiguous-question` | held |
| Task flow parked at a question across the drain | `ambiguous-question` (`carried-over-flow`) | held |
| `integrationWorkflows` entry of kind `release` | `unqualified-release` | held |

Unapproved tasks, answered questions, completed history, `onBehalfOf` instructions, original-request and acceptance prose, delegated answers and synthetic maintenance `integration.grant` objects produce no authority: migration creates no grant, authority use, disposition or decision. Approvals, inbox items, flows and tasks are left unchanged. Migration coverage is recorded as `incomplete` and `authorityHold` lists why; `authorityStatus` (CLI `authority status`, and an additive `authority` field in the snapshot on migrated databases only) shows held items with `enforcement: "not-wired"`.

## Retention and backup roots

- **Backup/restore.** The VACUUM copy already carries every record, command receipt and meta value atomically, so decision records, grant usage, authority uses, authority revisions and snapshots travel together (tested by exact comparison). The backup manifest now notes `schemaVersion` (informational). Restore audits authority records before publishing and fails closed on a dangling or corrupt reference, leaving no target. A restored ledger keeps the existing pause and recovery hold.
- **Archive retention** (`runArchiveRetention`) refuses while any decision obligation is unresolved or has uncovered applicability, refuses if authority records fail the audit, and protects the worktree of any terminal flow named by an authority record. Paths cited by authority records are already protected by the generic citation scan. **Governance retention** (`retentionPlan`) skips while a decision is unresolved and skips on an unsound ledger.

## Intentionally not wired yet (slices B–J)

Decision open/present/dispose/revoke/ratify, grant issue/revoke/consume, envelope authority references, communication v2, delegation split, boundary guards (admission, engine question/answer, prepare/dispatch, terminal, `forge.closeTask`), plan consent, report ingestion, release review, console/service projections beyond the additive snapshot field, and any enforcement of `authorityHold` or `legacyAuthority` held status. A migrated project behaves exactly as before apart from snapshots, the authority counter, the snapshot field, the retention guards and the 256 KiB brief bound.

## Design questions for root

1. **Release compatibility.** The new runtime accepts schemas 1 and 2, but `starter/compatibility.json` still declares `schemaVersion: 1`, and `buildRelease` emits `schemaVersions: [schemaVersion]`. A release built from this tree would refuse to upgrade or launch a migrated project. Before any adopter migrates, root needs to declare `[1, 2]` (a distribution change) or bump to 2. Unchanged here.
2. **Hold without enforcement.** `authorityHold` and held legacy items are recorded and visible but enforce nothing; held delegated approvals still admit work. Migrating before slices B–D gives no new protection. Should `authority migrate` be withheld from adopters until enforcement lands?
3. **Standalone schema-1 questions.** §9.5 says they "stay informational". They are inventoried as `informational-v1` but **held** for review, because their product meaning is unknown. Their inbox state is untouched.
4. **Retention breadth.** Following the existing generic-obligation rule, an unresolved decision blocks every archive and governance retention run, rather than only protecting what it references. That may be too broad once holds are long-lived.
5. **Approval provenance.** Direct-operator retention relies on event-to-receipt correlation and the receipt's `actor`. Nested `task.restart` approvals by the operator count as direct. Console-issued commands count as operator under the existing cooperative same-account trust. No `authorityUse` is minted for retained approvals; later slices decide whether ratification or migration evidence becomes one.
6. **New project default.** `init` still creates schema 1, so new projects get no ledger until migrated. §9.2 (new projects enforce by default) is left to the activation slice.
7. **Brief bound.** On migrated databases `task.put` refuses a brief over 256 KiB, and an over-bound legacy brief blocks migration. These are conservative bounds the design does not set.

## Verification

At the implementation commit, Node 24:

- `node --test tests/decision-authority-records.test.mjs tests/authority-migration.test.mjs`: **16/16 pass**. Covered: unknown fields at top level and nested; oversized text, lists, entry counts and the 32 KiB grant payload; wildcard and prose scopes; missing pins and overuse; lifecycle and digest agreement; schema-1 write refusal; immutability and compare-and-swap; audit of dangling references, supersession cycles and corrupt JSON; snapshots, request references, authority revision and rollback on `task.put`; normalized and oversized briefs; read-only preview and full classification; no grants, uses or dispositions from prose, `onBehalfOf`, delegated answers or synthetic job grants; held items visible and inbox/task/flow state unchanged; idempotent rerun; crash injection (child process exit) before and after commit; the real `23418cb` Store and restore refusing a migrated database; refusal of undrained, held or runner-locked projects and missing backup; backup/restore of unresolved holds, grant usage, uses, revisions and receipts with fail-closed corrupt restore; retention roots; CLI preview/migrate/status.
- `npm test`: **634/634 pass, 0 fail**. No load-sensitive test failed.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

No existing test was changed. Not verified: a real adopter database, the console rendering of the new snapshot field, and any release built from this tree (see question 1).

## Independent review fixes

The independent review rejected `2b99273` with four blocking findings. All four are fixed; tests below fail on `2b99273`'s source and pass now.

1. **Versioned writes could restore spent or revoked authority.** `putAuthorityRecord` now validates the stored predecessor and checks the transition against it. Grant usage counters only increase and never disappear; a revoked grant is final, and revoking consumes nothing. A disposition or authority use only moves `active → inactive`, so inactive evidence is never reactivated in place: a new record from ratification or a fresh answer replaces it. A release review only moves `active → revoked`. A decision never drops an applicability entry, a superseded decision is final, a settled decision changes its disposition only by returning to `unresolved`, and a newly named active disposition must exist, be active and belong to it. A legacy inventory row changes only by recording its resolution once; until then its status must be the one its classification gave it. `taskAuthority` now goes through the same compare-and-swap path, with `authorityRevision` as its version.
2. **The audit accepted a disposition that did not cover its decision.** For the disposition a decision names as active, the audit now checks the kind matches the status (`answer`/`resolved`, `cancel`/`canceled`, `supersede`/`superseded`), the scope and option-set digests are equal, the answered decision version is not later, the selected answer is one of the current options with its payload digest, the disposition's revisions are within the decision's applicability, every `covered` entry is one it applies to, and supersession replacements agree. Inactive dispositions stay history and are checked only for references. An active disposition the decision does not name is a problem, as is an active disposition or release review resting on an inactive authority use, or one whose use authorized a different operation. Task and revision references are audited everywhere: snapshots and authority revisions need their task, and dispositions, grant entries, reports, release manifests and legacy approvals need a recorded snapshot. Grant uses must name a grant version that exists and the operation and disposition the entry permits, and a grant's usage must be at least the number of uses citing each entry. Restore and the retention guards use this audit, so they refuse such state.
3. **Runner exclusion did not exclude an already-open old writer.** Two mechanisms together:
   - *Exclusive handoff.* The inventory, the backup and the migration writes now happen inside one `BEGIN IMMEDIATE` transaction. No other connection can commit from inventory to commit, whether a service, a standalone command writer or a connection opened earlier. The backup is taken by a reader connection inside that window, so it is exactly the migrated state. A writer that waits longer than its busy timeout fails with SQLite's busy error rather than writing behind the backup.
   - *Durable write fence.* The migration commit installs `BEFORE INSERT/UPDATE/DELETE` triggers on `meta`, `records`, `events` and `commands` that call `factotum_writer_schema()`. Only the current Store registers that function, on every connection it opens. SQLite compiles triggers into every write statement a connection prepares, and re-prepares older statements after a schema change. So an old binary's write fails with `no such function: factotum_writer_schema` whether its connection was opened before or after the migration, and it doesn't have to check anything. A writer that registers the function with a lower schema fails the trigger's own `RAISE`. Reads are unaffected. Opening a schema-2 database checks the fence is intact. I chose this over the alternatives because it is the only one an already-open old connection trips on: the runner and project locks are advisory and old command writers don't take them, and a schema-cookie change alone only re-prepares statements. Like everything else here, it is cooperative: a same-account process can drop the triggers. The acceptance test holds a real `23418cb` Store open across the migration and shows its `task.put`, raw record writes, `setMeta('schemaVersion', 1)` and event writes are refused with no change to records, receipts or the state revision.
4. **The migration marker was not validated.** `authorityMigration` and `authorityHold` now have closed schemas (unknown fields are refused, `creates` must be all zeros, `coverage` is `incomplete`). Opening a schema-2 database validates them and checks `migrationId` is derived from the project and `inventoryDigest`, and that the hold names the same migration. The audit, and therefore restore, retention and the migration itself, also checks linkage. The marker's counts must match the stored migration snapshots, unknown-request snapshots and inventory rows. Its inventory digest is recomputed from the immutable snapshot facts and inventory rows, and each inventory row's id is derived from project, item and subject. To make the digest reconstructible after a VACUUM copy renumbers rows, the inventory now orders snapshots by task id, and an inventory row's initial status is derived from its classification. A marker reduced to `{toSchema: 2}` no longer opens.

Also fixed:

- **Restart provenance (design question 5).** A `task.restart` receipt names only the flow it started. Migration now retains such an approval as `direct-operator` only when that flow's admission record proves the binding: same task, revision and approval version, a task snapshot with the same approved revision, approval version and `approvedWorkflow`, and, under a catalog, the flow's workflow name and digest equal to the approved ones. Otherwise the approval is held as `legacy-unverified`. A `task.approve` receipt must also carry the current approval version.
- **Old-runtime acceptance tests.** Without the `23418cb` history, they now report a visible skip with the reason (`t.skip`), and the checks that don't need the old runtime are in a separate test.
- **Brief bound.** The task revision snapshot's `brief` is an opaque, size-bounded JSON object: it must be an object belonging to its task and match its digest, but unknown fields inside it are not rejected at every depth, unlike every other authority record. The 256 KiB limit is a compatibility limit for storing the brief in a bounded record, not a design rule. `authority preview` now lists every over-limit task in `overLimitBriefs` (`taskId`, `bytes`, `limit`) besides the blocking reason.

**Root decisions recorded.** `starter/compatibility.json` and the schema defaults for new projects are unchanged (`init` still creates schema 1), per root's decision. `authority migrate` stays withheld from adopters until the enforcement slices land, which answers design questions 1, 2 and 6 for now.

### Verification of the fixes

At the fix commit, Node 26:

- New tests: `versioned writes follow one-way transitions`, `the audit requires an active disposition to cover its decision exactly`, `a pre-migration runtime holding a connection open across the migration cannot write afterwards`, `no other writer can commit between the migration backup and its commit`, `release compatibility and the current runtime refuse … a missing or forged migration record`, `restore refuses a backup whose migration record, inventory or authority references do not match`, `a restart approval is retained only when its restart flow proves …`, `preview lists every task whose brief exceeds the snapshot compatibility limit`. With only `starter/` reverted to `2b99273`, all 8 fail and the 16 earlier slice tests pass.
- `node --test tests/decision-authority-records.test.mjs tests/authority-migration.test.mjs`: **24/24 pass**, 0 skipped (the `23418cb` history is present).
- Focused files from the review brief (slice tests plus runtime, archive-retention, retention-recovery, retrospective, upgrade-apply, tasks-queue, task-workflows, scheduled-tasks, project-service and `core/contracts.test.mjs`): **92/93** in one run. The one failure was the known load-sensitive `tests/runtime.test.mjs` "revocation cancels owned running work and resume requires a new grant". Rerun alone, `tests/runtime.test.mjs` passed **16/16**.
- `npm test`: **642/642 pass, 0 fail**.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

Not verified: SQLite builds compiled with `SQLITE_TRUSTED_SCHEMA=0` would refuse application functions inside triggers, so the current runtime could not write either. The Node builds used here allow them. The busy-timeout behavior of a writer that waits during a long backup was tested only with a 50 ms timeout.

## Re-check fixes

The independent re-check confirmed the four review fixes but rejected `60614e4` with three new blocking findings. All three are fixed; the new tests fail on `60614e4`'s source and pass now.

1. **Cancellation authority could authorize an answer.** The audit now checks the whole disposition → authority use → grant entry binding, for active and inactive dispositions alike:
   - An authority use's disposition must fit its operation (`decision.dispose` permits `answer`, `cancel` or `supersede`; `decision.ratify` permits `ratify` and is direct operator authority only, never granted; `task.approve`, `plan.consent` and `release.review` permit `approve`, `consent` and `review`). This is a record rule, so `putAuthorityRecord` refuses a mismatched use as well.
   - A disposition's use must come from the disposition's own command, and a `decision.dispose` use must permit exactly the disposition's kind.
   - For a grant use, the entry must be a `decision.dispose` entry for that kind. It must pin the disposition's decision ID and version, scope and option-set digests, and the one task revision every applicability entry names. It must list the selected answer (ID and payload digest), or, for cancel and supersede, pin `payloadDigest = dispositionPayloadDigest(disposition)`, a digest of the kind and the exact `cancellation` or `supersession` object. A grant use must also fall within the grant's validity interval.
   - Direct operator ratification (design §4, `decision.ratify`) stays valid. A ratifying disposition must be an answer that repeats an inactive answer of the same decision, with the same option, payload, scope and option set. It cannot change the answer, cancel or supersede.
2. **Supersession could clear a decision with a nonexistent revised brief.** A supersession's `revisedRevision`, when given, must have a task revision snapshot of the decision's own task, and that snapshot must descend from the decision's origin revision through the snapshots' `previousRevision` links. A fabricated digest, the origin itself and another task's revision are refused. Every `decision.dispose` grant entry must now name an existing decision. Its task and revision must be one the decision applies to, its pinned version cannot be later than the decision's, its scope and option-set digests must equal the decision's, and every answer it allows must be one of the decision's options.
3. **The write fence refused the current runtime's own writes when `trusted_schema` was off.** node:sqlite cannot mark a function innocuous: on Node 24.20–24.22 and 26.8–26.13 `database.function()` accepts an `innocuous` key, ignores it, and the trigger still fails with `unsafe use of factotum_writer_schema()`. So every Store connection now runs `PRAGMA trusted_schema=ON` as part of its setup and reads it back. Opening a schema-2 database, and installing the fence during migration, fail with a clear diagnostic (`this SQLite connection does not trust its schema (PRAGMA trusted_schema could not be turned on) …`) if it is not on. A schema-1 database opens as before. Trusting the schema gives an old runtime nothing: it never registers `factotum_writer_schema`, so its writes still fail on the unknown function, with `trusted_schema` either on or off. The database is private to the account, and the fence function is the only application function the Store registers.

### Verification of the re-check fixes

At the fix commit:

- New tests: `a disposition must be the one its authority use and grant entry permit …`, `direct operator ratification restores only an inactive answer …`, `supersession by scope removal needs a recorded later revision …`, `a SQLite build with trusted_schema off still migrates, writes, backs up and restores, and the old runtime stays fenced`, `a connection that cannot trust its schema refuses to migrate or open a migrated database …`. The trusted_schema tests run a child process with a preload that starts every new SQLite connection with `trusted_schema=OFF` (and in one mode ignores attempts to turn it on), which stands in for a build that defaults it off. That child runs the migration, writes to a reopened Store, backs up and restores, and holds a real `23418cb` Store open across the migration. With only `starter/` reverted to `60614e4` (plus the new `dispositionPayloadDigest` export, so the records file imports), all 5 fail and the 24 earlier slice tests pass.
- `node --test tests/decision-authority-records.test.mjs tests/authority-migration.test.mjs`: **29/29 pass** on Node 26.12.0 and on Node 24.22.2, 0 skipped.
- The slice tests plus archive-retention, retention-recovery, upgrade-apply, tasks-queue, scheduled-tasks, project-service and `core/contracts.test.mjs`: **74/74 pass**.
- `npm test`: **647/647 pass, 0 fail**. No load-sensitive test failed.
- `npm run eval`: exit 0.
- `git diff --check`: clean.

No existing test assertion changed. The `baselineRuntime` test helper now also returns the extracted runtime's directory.

Not verified: a real Node or SQLite build that defaults `trusted_schema` off (it is simulated as described), and a build that forbids turning it on (only the diagnostic path is tested). `authorityUse.subjectDigest` still has no derivation in this slice, so the audit does not check it against the disposition. The binding rests on the pinned fields above.

### Second re-check fixes (root)

A second independent re-check of `d9685bf` confirmed the three re-check findings resolved and rejected on two new P1 findings, both fixed here with regression tests that fail on `d9685bf`:

- **One use, one disposition.** The audit now counts the dispositions citing each authority use, active and inactive alike; more than one is a problem (`authorizes N dispositions; one use authorizes exactly one`). A counted one-use grant use can no longer back two outcomes. The fixture that reused `use-direct` for an inactive historical answer now gives that answer its own inactive use.
- **Ratification is bound to its predecessor.** A disposition gains an optional `ratifiesDispositionId`, valid only on an answer. A `decision.ratify` disposition must name the inactive answer it restores, and must repeat it exactly: same decision, answer, scope, options and applicable revisions (`sameSet` over `taskId@revision`). A changed task revision needs fresh disposition authority. An inactive answer can be ratified at most once, only ratification may carry the field, and every ratification chain must end at an original answer (cycles are refused; added after a third re-check approved with this one non-blocking finding).

Verification: the two slice test files 30/30; the nine-file focused set 75/75; with only `starter/` reverted to `d9685bf`, the two new/extended tests fail and the other 12 records tests pass.

Accepted as follow-up for later slices (non-blocking for this unenforced slice): `authorityUse.subjectDigest` still has no defined derivation, and `trusted_schema=ON` is acceptable under the cooperative same-account threat model but does not validate a restored backup's schema beyond the write-fence triggers.
