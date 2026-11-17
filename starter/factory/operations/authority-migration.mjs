// Explicit offline migration of a schema-1 project to the decision-authority
// ledger (schema 2). Opening a database never migrates it; only applying this
// migration, with the runner stopped, a drained project and a fresh backup,
// does. The migration never invents authority: it creates no grant, no
// authority use and no disposition. It records immutable snapshots of current
// task revisions (with history marked incomplete) and an inventory of legacy
// authority, holding anything whose provenance it cannot prove.
import { createServer } from 'node:net';
import { Store, installAuthorityWriteFence } from '../core/store.mjs';
import { backupProject } from '../core/backup.mjs';
import { assert, digest, now } from '../core/contracts.mjs';
import { briefOf, carriesOverUpgrade, isMaintenanceTask } from '../core/project.mjs';
import { drainReasons } from './upgrade-apply.mjs';
import { AUTHORITY_SCHEMA_VERSION, RECORD_SCHEMA_VERSION, assertAuthorityRecordsSound, authorityStatus, bumpTaskAuthority, legacyAuthorityId, legacyInitialStatus, migrationIdOf, migrationInventoryDigest, putAuthorityRecord, recordTaskRevision, requestRefs, validateAuthorityRecord } from '../core/decision-authority.mjs';

const FROM = 1, TO = AUTHORITY_SCHEMA_VERSION;
const DIGEST = /^[a-f0-9]{64}$/, ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
// A compatibility limit, not a design rule: the brief is stored as an opaque JSON
// object inside a bounded record. A legacy brief above it blocks migration.
const SNAPSHOT_BYTES = 256 * 1024;

// Where did the current approval of this exact revision come from? The latest
// task.approved event for the task must name the current revision, and the
// command that emitted it is the first command receipt event after it in the
// same transaction. Anything else is not reconstructible evidence.
function approvalEvidence(store, task) {
  const approval = store.db.prepare("SELECT sequence,at,payload FROM events WHERE type='task.approved' AND json_extract(payload,'$.taskId')=? ORDER BY sequence DESC LIMIT 1").get(task.id);
  if (!approval) return { classification: 'legacy-unverified', reason: 'no approval event records how this revision was approved' };
  const payload = JSON.parse(approval.payload);
  if (payload.revision !== task.revision) return { classification: 'legacy-unverified', reason: 'the latest approval event names a different revision', evidence: { eventSequence: approval.sequence } };
  const closing = store.db.prepare("SELECT payload FROM events WHERE sequence>? AND type IN ('command.completed','command.rejected') ORDER BY sequence LIMIT 1").get(approval.sequence);
  const commandId = closing ? JSON.parse(closing.payload).commandId : undefined, receipt = commandId ? store.command(commandId) : undefined;
  const matches = receipt?.status === 'completed' && Date.parse(receipt.acceptedAt) <= Date.parse(approval.at)
    && (receipt.operation === 'task.approve' ? receipt.result?.id === task.id && receipt.result?.revision === task.revision && receipt.result?.approvalVersion === task.approvalVersion : receipt.operation === 'task.restart' && receipt.result?.taskId === task.id);
  if (!matches) return { classification: 'legacy-unverified', reason: 'no command receipt proves who approved this revision', evidence: { eventSequence: approval.sequence } };
  const evidence = { ...(ID.test(commandId) ? { commandId } : {}), operation: receipt.operation, actor: receipt.actor, onBehalfOf: Boolean(receipt.onBehalfOf), eventSequence: approval.sequence };
  if (receipt.operation === 'task.approve' && digest(receipt.result.approvedWorkflow ?? null) !== digest(task.approvedWorkflow ?? null)) return { classification: 'legacy-unverified', reason: 'the approving command bound a different workflow', evidence };
  // A restart receipt names only the flow it started. The approval binding it made is proven
  // only by that flow's admission record: same task, revision and approval version, and the
  // approved workflow it ran under. Without that evidence the approval stays held.
  if (receipt.operation === 'task.restart' && !restartBindsApproval(store, task, receipt.result.flowId)) return { classification: 'legacy-unverified', reason: 'the restart flow does not prove the approved revision and workflow binding', evidence };
  if (receipt.actor === 'operator' && !receipt.onBehalfOf) return { classification: 'direct-operator', reason: `direct operator ${receipt.operation} of this exact revision`, evidence };
  if (receipt.actor === 'orchestrator') return { classification: 'legacy-delegated', reason: 'approved by the orchestrator on a recorded operator instruction; the instruction is attribution, not a stored grant: ratify directly or issue an exact grant', evidence };
  return { classification: 'legacy-unverified', reason: 'approval provenance is ambiguous', evidence };
}

function restartBindsApproval(store, task, flowId) {
  const flow = typeof flowId === 'string' ? store.get('flow', flowId) : undefined, seen = flow?.taskSnapshot;
  if (!flow || flow.taskId !== task.id || flow.taskRevision !== task.revision || flow.approvalVersion !== task.approvalVersion) return false;
  if (!seen || seen.approvedRevision !== task.revision || seen.approvalVersion !== task.approvalVersion || digest(seen.approvedWorkflow ?? null) !== digest(task.approvedWorkflow ?? null)) return false;
  return !task.approvedWorkflow || (flow.workflowName === task.approvedWorkflow.name && flow.workflowDigest === task.approvedWorkflow.digest);
}

// Deterministic for a given project state, so a rerun after a crash before
// commit produces the same inventory and migration identity.
export function authorityInventory(store) {
  const projectId = store.meta('project').projectId, config = store.meta('config', {}), blocking = [];
  if (store.meta('schemaVersion') !== FROM) blocking.push(`database schema ${store.meta('schemaVersion')} is not ${FROM}`);
  for (const reason of drainReasons(store)) blocking.push(reason);
  if (store.meta('recoveryHold')) blocking.push('a restored project must be reconciled and released before migration');
  if (store.meta('retentionHold')) blocking.push('archive retention owns the mutation fence; finish it first');
  const tasks = store.all('task').filter(task => !isMaintenanceTask(task));
  const snapshots = [], overLimit = [];
  for (const task of tasks) {
    if (!ID.test(task.id ?? '') || !DIGEST.test(task.revision ?? '')) { blocking.push(`task ${task.id} has no valid identity or revision`); continue; }
    const brief = briefOf(task), bytes = Buffer.byteLength(JSON.stringify(brief));
    if (bytes > SNAPSHOT_BYTES) { overLimit.push({ taskId: task.id, bytes, limit: SNAPSHOT_BYTES }); blocking.push(`task ${task.id} brief exceeds the ${SNAPSHOT_BYTES}-byte revision snapshot bound`); continue; }
    snapshots.push({ taskId: task.id, revision: task.revision, brief, briefDigest: digest(brief), requestCoverage: requestRefs(brief).length ? 'recorded' : 'unknown' });
  }
  snapshots.sort((a, b) => a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  // Status follows from the classification alone, so the stored inventory can be re-derived.
  const items = [], add = (item, subject, classification, status, reasons, evidence) => { assert(status === legacyInitialStatus(classification), 'inventory status disagrees with its classification'); items.push({ item, subject, classification, status, reasons, ...(evidence && Object.keys(evidence).length ? { evidence } : {}) }); };
  for (const task of tasks) {
    if (!task.revision || task.approvedRevision !== task.revision) continue;
    const subject = { taskId: task.id, revision: task.revision, approvalVersion: task.approvalVersion ?? 0 };
    if (task.approvalKind === 'recurring') { add('task-approval', subject, 'configured', 'retained', ['approved by the recurring task configuration: operational authority only, never a product answer or plan consent'], { approvalKind: 'recurring' }); continue; }
    const found = approvalEvidence(store, task);
    add('task-approval', subject, found.classification, found.classification === 'direct-operator' ? 'retained' : 'held', [found.reason], found.evidence);
  }
  for (const item of store.all('inbox').filter(row => row.kind === 'question' && row.status === 'open')) {
    const subject = { inboxId: String(item.id).slice(0, 300), ...(item.flowId ? { flowId: String(item.flowId).slice(0, 300) } : {}), ...(item.taskId && ID.test(item.taskId) ? { taskId: item.taskId } : {}) };
    if (item.flowId) add('open-question', subject, 'ambiguous-question', 'held', ['a legacy workflow question has no structured decision meaning: review it, then bind it to a decision or confirm it is operational']);
    else add('open-question', subject, 'informational-v1', 'held', ['a schema-1 standalone question stays informational; any product decision it asks must be bound to a task revision explicitly']);
  }
  for (const flow of store.all('flow').filter(row => carriesOverUpgrade(store, row))) add('carried-over-flow', { flowId: String(flow.id).slice(0, 300), ...(ID.test(flow.taskId ?? '') ? { taskId: flow.taskId } : {}) }, 'ambiguous-question', 'held', ['a task flow parked at a question across the migration: rebind it with its decisions preserved, or restart it explicitly']);
  for (const [name, definition] of Object.entries(config.integrationWorkflows ?? {}).filter(([, d]) => d?.kind === 'release')) if (ID.test(name)) add('release-integration', { integration: name }, 'unqualified-release', 'held', ['a release integration has no release-review clearance mapping; it stays unqualified until commissioned']);
  for (const row of items) row.id = legacyAuthorityId(projectId, row.item, row.subject);
  items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const inventoryDigest = migrationInventoryDigest(projectId, snapshots, items);
  return { projectId, fromSchema: FROM, toSchema: TO, blocking, overLimit, snapshots, items, inventoryDigest, migrationId: migrationIdOf(projectId, inventoryDigest) };
}
const summary = inventory => ({
  snapshots: inventory.snapshots.length,
  requestUnknown: inventory.snapshots.filter(row => row.requestCoverage === 'unknown').length,
  retained: inventory.items.filter(row => row.status === 'retained').length,
  held: inventory.items.filter(row => row.status === 'held').length,
});
const holdReasons = inventory => [
  'decision coverage incomplete: legacy questions and prose cannot be converted to decisions automatically; bind known outstanding decisions to task revisions',
  ...(summary(inventory).held ? [`${summary(inventory).held} legacy authority item(s) held for ratification, an exact grant or review`] : []),
];

// Read-only: reports exactly what apply would write, and why it would refuse.
export function previewAuthorityMigration(stateDir) {
  const store = new Store(stateDir);
  try {
    if (store.meta('schemaVersion') === TO) return { status: 'already-migrated', migration: store.meta('authorityMigration'), authority: authorityStatus(store) };
    const inventory = authorityInventory(store);
    return { status: inventory.blocking.length ? 'blocked' : 'ready', fromSchema: FROM, toSchema: TO, blocking: inventory.blocking, overLimitBriefs: inventory.overLimit, migrationId: inventory.migrationId, inventoryDigest: inventory.inventoryDigest, counts: summary(inventory), creates: { grants: 0, authorityUses: 0, dispositions: 0 }, holdReasons: holdReasons(inventory), snapshots: inventory.snapshots.map(({ taskId, revision, requestCoverage }) => ({ taskId, revision, requestCoverage, historyIncomplete: true })), items: inventory.items };
  } finally { store.close(); }
}

async function runnerLock(projectId) {
  const lock = createServer();
  await new Promise((done, reject) => { lock.once('error', () => reject(new Error('the project runner is still running; stop it (or its unit) before the authority migration'))); lock.listen(`\0factotum-runner-${projectId}`, done); });
  return () => new Promise(done => lock.close(done));
}
// Apply in one SQLite transaction. A crash before commit leaves schema 1 and
// nothing written; a crash after commit leaves the complete migration. Rerun
// is idempotent either way. Rollback means restoring the pre-migration backup.
//
// Offline handoff: the runner lock excludes the service and runner. Every other
// writer, including standalone command writers and connections opened before
// the migration, is excluded by the transaction itself: it is BEGIN IMMEDIATE,
// so no other connection can commit from the inventory, through the backup
// (taken inside it, from the same committed state), to the commit. The commit
// installs the durable write fence (core/store.mjs), so a pre-migration runtime
// that still holds a connection, or opens one later, cannot write afterwards.
export async function applyAuthorityMigration(stateDir, { backupDir, hooks = {}, lock = true } = {}) {
  const store = new Store(stateDir); let release;
  try {
    if (store.meta('schemaVersion') === TO) return { status: 'already-migrated', applied: false, migration: store.meta('authorityMigration'), authority: authorityStatus(store) };
    assert(typeof backupDir === 'string' && backupDir, 'a backup destination is required: the pre-migration backup is the only rollback');
    if (lock) release = await runnerLock(store.meta('project').projectId);
    const preview = authorityInventory(store);
    assert(!preview.blocking.length, `authority migration refused: ${preview.blocking.join('; ')}`);
    const migration = store.tx(() => {
      const inventory = authorityInventory(store);
      assert(!inventory.blocking.length && inventory.inventoryDigest === preview.inventoryDigest, 'project changed during the authority migration; preview it again');
      // Nothing can commit while this transaction holds the write lock, so the backup is exactly
      // the state being migrated (a reader connection sees the last committed state).
      const backup = backupProject(stateDir, backupDir);
      hooks.afterBackup?.();
      const at = now(), counts = summary(inventory);
      const record = { schemaVersion: RECORD_SCHEMA_VERSION, migrationId: inventory.migrationId, fromSchema: FROM, toSchema: TO, migratedAt: at, inventoryDigest: inventory.inventoryDigest, counts, coverage: 'incomplete', backup: { path: backup.destination, files: backup.files }, creates: { grants: 0, authorityUses: 0, dispositions: 0 } };
      installAuthorityWriteFence(store);
      store.setMeta('schemaVersion', TO); store.setMeta('authorityMigration', record);
      for (const row of inventory.snapshots) {
        recordTaskRevision(store, { taskId: row.taskId, revision: row.revision, brief: row.brief, recordedBy: 'migration', at });
        bumpTaskAuthority(store, row.taskId, 'migration', inventory.migrationId);
      }
      for (const row of inventory.items) putAuthorityRecord(store, 'legacyAuthority', validateAuthorityRecord('legacyAuthority', { schemaVersion: RECORD_SCHEMA_VERSION, projectId: inventory.projectId, migrationId: inventory.migrationId, ...row, version: 1, createdAt: at }));
      store.setMeta('authorityHold', { migrationId: inventory.migrationId, since: at, reasons: holdReasons(inventory) });
      assertAuthorityRecordsSound(store, 'authority migration');
      store.event('authority.migrated', { migrationId: inventory.migrationId, fromSchema: FROM, toSchema: TO, ...counts });
      hooks.beforeCommit?.();
      return record;
    });
    hooks.afterCommit?.();
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { status: 'migrated', applied: true, migration, authority: authorityStatus(store) };
  } finally { if (release) await release(); store.close(); }
}
