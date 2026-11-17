import { openPrivateSQLite } from './sqlite.mjs';
import { mkdirSync, existsSync, chmodSync, openSync, closeSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assert, digest, now, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, uid, validateWorkflow } from './contracts.mjs';
import { changeWorkflow, validateConfig } from './configuration.mjs';
import { compileCatalog, defaultWorkflow } from './catalog.mjs';
import { syncScheduledTaskRecords } from '../operations/scheduled-tasks.mjs';
import { validateRecurringWorkflows } from '../operations/recurring-tasks.mjs';
import {queueStateDeliveryInTransaction} from '../operations/notifications.mjs';
import { validateMigrationMarker } from './decision-authority.mjs';
import { INTENT_KIND, KIND_INDEXES, LAYOUT_FUNCTION, LAYOUT_VERSION, LIVE, REFERENCES, VERIFIED_META, bySql, ensureStateIndexes, installLayoutFence, layoutFenceIntact, liveSql, presentIndexes, recordVerification, withIntent } from './records.mjs';
import { intentRecordText, readIntentRecord } from './intent-text.mjs';

// Durable write fence for the decision-authority schema. The migration installs
// these triggers in the same transaction that sets schemaVersion 2. Each one calls
// WRITER_FUNCTION, which only a runtime that understands the migrated schema
// registers on its connections. A pre-migration runtime cannot write the
// database: SQLite compiles the trigger into every INSERT, UPDATE or DELETE it
// prepares (and re-prepares statements it prepared before the schema change),
// fails on the unknown function, and the write is refused. That covers
// connections opened before the migration as well as new ones, without relying
// on the old binary to check anything. Reads are unaffected.
//
// SQLite runs an application function inside a trigger only when the connection
// trusts its schema (PRAGMA trusted_schema, on by default but a build can default
// it off). node:sqlite cannot mark a function innocuous, so every Store
// connection turns trusted_schema on explicitly and verifies it before relying on
// the fence; without it the current runtime could not write its own migrated
// database. The database is private to this account and the only application
// functions registered on the connection are WRITER_FUNCTION and LAYOUT_FUNCTION
// (core/records.mjs: the same kind of fence, for the layout of attempt intents). Trust does not help
// an old runtime: it never registers the function, so its writes still fail.
export const WRITER_FUNCTION = 'factotum_writer_schema';
const WRITER_SCHEMA = Math.max(...SUPPORTED_SCHEMA_VERSIONS);
const FENCED_TABLES = ['meta', 'records', 'events', 'commands'];
export const AUTHORITY_WRITE_FENCE = Object.freeze(FENCED_TABLES.flatMap(table => ['INSERT', 'UPDATE', 'DELETE'].map(action => {
  const name = `factotum_authority_fence_${table}_${action.toLowerCase()}`;
  return { name, sql: `CREATE TRIGGER ${name} BEFORE ${action} ON ${table} WHEN ${WRITER_FUNCTION}() < 2 BEGIN SELECT RAISE(ABORT, 'this runtime cannot write a decision-authority (schema 2) database'); END` };
})));
export const schemaTrusted = db => db.prepare('PRAGMA trusted_schema').get()?.trusted_schema === 1;
const assertFenceWritable = db => assert(schemaTrusted(db), 'this SQLite connection does not trust its schema (PRAGMA trusted_schema could not be turned on), so the decision-authority write fence would refuse this runtime\'s own writes; use a Node.js build whose SQLite allows PRAGMA trusted_schema=ON');
export function installAuthorityWriteFence(store) { assertFenceWritable(store.db); for (const trigger of AUTHORITY_WRITE_FENCE) store.db.exec(trigger.sql); }
export function authorityWriteFenceIntact(db) {
  const found = new Map(db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'factotum_authority_fence_%'").all().map(row => [row.name, row.sql]));
  return found.size === AUTHORITY_WRITE_FENCE.length && AUTHORITY_WRITE_FENCE.every(trigger => found.get(trigger.name) === trigger.sql);
}

// Whether a stored intent record holds this intent value, whatever its text.
function sameIntent(id, stored, intent) {
  try { return JSON.stringify(JSON.parse(readIntentRecord(id, stored).value)) === JSON.stringify(intent); } catch { return false; }
}

export class Store {
  constructor(stateDir, { create = false } = {}) {
    this.stateDir = resolve(stateDir);
    const path = join(this.stateDir, 'state.sqlite');
    if (!create) assert(existsSync(path), 'state database missing; use init explicitly');
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    chmodSync(this.stateDir, 0o700);
    this.db = openPrivateSQLite(path, 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=ON;');
    this.db.function(WRITER_FUNCTION, () => WRITER_SCHEMA);
    this.db.function(LAYOUT_FUNCTION, () => LAYOUT_VERSION);
    if (create) this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL);
    `);
    // A new, empty database stores attempt intents separately from the start (core/records.mjs),
    // when this connection can write behind the fence that requires: fence, indexes and the record
    // that every kind is verified (there is nothing to check) in one transaction. Otherwise it is
    // left in the inline layout, without indexes, for the migration.
    if (create && schemaTrusted(this.db)) this.tx(() => {
      if (layoutFenceIntact(this.db) || this.db.prepare('SELECT 1 FROM records LIMIT 1').get()) return;
      installLayoutFence(this.db); ensureStateIndexes(this.db); recordVerification(this.db, { at: now(), kinds: [...KIND_INDEXES.keys()], duplicates: {} });
    });
    const version = this.meta('schemaVersion');
    // Opening never migrates: a schema-1 database stays schema 1 until the explicit migration runs.
    assert(create ? version === undefined || version === SCHEMA_VERSION : SUPPORTED_SCHEMA_VERSIONS.includes(version), 'unsupported database schema');
    if (version === 2) {
      assert(this.meta('authorityMigration') !== undefined, 'database schema 2 without its authority migration record; restore the pre-migration backup');
      validateMigrationMarker(this);
      assertFenceWritable(this.db);
      assert(authorityWriteFenceIntact(this.db), 'database schema 2 without its intact authority write fence; restore the pre-migration backup');
    }
    if (create && version === undefined) this.setMeta('schemaVersion', SCHEMA_VERSION);
    const integrity = this.db.prepare('PRAGMA quick_check').get();
    assert(Object.values(integrity)[0] === 'ok', 'database integrity check failed');
  }
  close() { this.db.close(); }
  meta(key, fallback) { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  setMeta(key, value) { this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  // An attempt whose own record has an intent member has that intent, as JSON.parse reads it (the
  // last of several, null included); only without one is the separate record its intent. The same
  // rule holds in intent() and all().
  get(kind, key) {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, key); if (!row) return undefined;
    const record = JSON.parse(row.data); if (kind !== 'attempt' || Object.hasOwn(record, 'intent')) return record;
    const intent = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(INTENT_KIND, key);
    return intent ? withIntent(record, JSON.parse(intent.data).intent) : record;
  }
  need(kind, key) { const record = this.get(kind, key); assert(record, `unknown ${kind}: ${key}`); return record; }
  put(kind, record) {
    // Without the layout fence the database is in the inline layout: the attempt is written whole.
    if (kind !== 'attempt' || record.intent === undefined || !this.layout().separate) { this.write(kind, record.id, JSON.stringify(record)); return record; }
    // Intent first: a crash between the two writes leaves an intent without its attempt, never the reverse.
    // A stored intent with the same value is left as it is, text included; a record put without an
    // intent leaves the stored one alone.
    const { intent, ...rest } = record, body = intentRecordText(record.id, intent), stored = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(INTENT_KIND, record.id)?.data;
    if (stored !== body && !(stored && sameIntent(record.id, stored, intent))) this.write(INTENT_KIND, record.id, body);
    this.write(kind, record.id, JSON.stringify(rest)); return record;
  }
  write(kind, key, data) { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, key, data); }
  // Every record of a kind, complete, in insertion order. For attempts that loads every intent:
  // history views use stored('attempt'), and current work uses live, by or recent.
  all(kind) {
    const records = this.stored(kind); if (kind !== 'attempt') return records;
    const intents = new Map(this.db.prepare('SELECT id, data FROM records WHERE kind=?').all(INTENT_KIND).map(row => [row.id, row.data]));
    return records.map(record => !Object.hasOwn(record, 'intent') && intents.has(record.id) ? withIntent(record, JSON.parse(intents.get(record.id)).intent) : record);
  }
  // Records as stored, in insertion order: an attempt comes without its intent (unless an earlier release wrote it inline).
  stored(kind) { return this.db.prepare(`SELECT data FROM records ${this.hint('records_kind')} WHERE kind=? ORDER BY rowid`).all(kind).map(row => JSON.parse(row.data)); }
  // The records of a kind that are not settled history (LIVE), as stored, in insertion order.
  // A kind that is not verified (core/records.mjs) is returned whole: callers filter a live set exactly as they filtered all(kind).
  live(kind) { assert(LIVE[kind], `no live set is defined for ${kind}`); return this.verified(kind) ? this.db.prepare(`${liveSql(this, kind)} ORDER BY rowid`).all().map(row => JSON.parse(row.data)) : this.stored(kind); }
  // The records of a kind whose field (one of REFERENCES) has this value, as stored, in insertion order.
  by(kind, name, value) {
    assert(REFERENCES[name]?.kinds.includes(kind), `no ${name} lookup is defined for ${kind}`);
    if (!this.verified(kind)) return this.stored(kind).filter(record => record[name] === value);
    return this.db.prepare(`${bySql(this, kind, name)} ORDER BY rowid`).all(value).map(row => JSON.parse(row.data));
  }
  // The most recently inserted records of a kind, as stored, in insertion order.
  recent(kind, limit) { return this.db.prepare(`SELECT data FROM records ${this.hint('records_kind')} WHERE kind=? ORDER BY rowid DESC LIMIT ?`).all(kind, limit).map(row => JSON.parse(row.data)).reverse(); }
  // Changes whenever anything was written to this database, by this connection (total_changes)
  // or by any other (data_version). Two constant-time reads.
  // total_changes() also counts writes that were rolled back, and a rollback on this connection does
  // not change data_version: a token read inside a transaction after its writes would equal the token
  // after its rollback, although the data is back to what it was. The rollback count tells them apart.
  changeToken() { return `${this.db.prepare('PRAGMA data_version').get().data_version}:${this.db.prepare('SELECT total_changes() AS changes').get().changes}:${this.rollbacks ?? 0}`; }
  // Every rollback on this connection, transaction or savepoint, changes the change token.
  markRolledBack() { this.rollbacks = (this.rollbacks ?? 0) + 1; }
  count(kind) { return this.db.prepare(`SELECT count(*) AS count FROM records ${this.hint('records_kind')} WHERE kind=?`).get(kind).count; }
  // What this database's schema says about its record layout, re-read when the schema changes
  // (here or through another connection): which of this release's indexes exist with its
  // definitions, and whether attempt intents are stored separately (the fence is installed).
  layout() {
    const version = this.db.prepare('PRAGMA schema_version').get().schema_version;
    if (this.schema?.version !== version) this.schema = { version, indexes: presentIndexes(this.db), separate: layoutFenceIntact(this.db) };
    return this.schema;
  }
  // "INDEXED BY <index>" for an index that exists with this release's definition behind the layout
  // fence, otherwise nothing: without the fence another writer may have changed what it covers.
  hint(index) { const layout = this.layout(); return layout.separate && layout.indexes.has(index) ? `INDEXED BY ${index}` : ''; }
  // Whether SQL may read this kind's records as JSON (core/records.mjs): the fence is in place, the
  // verification record names the kind, and every index over the kind exists. The record is read
  // each time: it is what says so, not the indexes.
  verified(kind) {
    const layout = this.layout(); if (!layout.separate || !(KIND_INDEXES.get(kind) ?? []).every(index => layout.indexes.has(index))) return false;
    const kinds = this.meta(VERIFIED_META, null)?.kinds; return Array.isArray(kinds) && kinds.includes(kind);
  }
  // One attempt's dispatch intent, by the same rule as get(); undefined when it has none.
  intent(attemptId) { return this.get('attempt', attemptId)?.intent; }
  event(type, payload = {}) {
    const at=now(),insert=this.db.prepare('INSERT INTO events(at,type,payload) VALUES(?,?,?)').run(at, type, JSON.stringify(payload));
    queueStateDeliveryInTransaction(this,{sequence:Number(insert.lastInsertRowid),at,type,payload});
    this.setMeta('revision', this.meta('revision', 0) + 1);
  }
  events(limit = 100) { return this.db.prepare('SELECT * FROM events ORDER BY sequence DESC LIMIT ?').all(limit).map(r => ({ ...r, payload: JSON.parse(r.payload) })); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) {
      // SQLite may already have rolled the transaction back (for example on SQLITE_FULL); never let
      // a failed ROLLBACK replace the original error, which callers classify.
      try { if (this.db.isTransaction !== false) this.db.exec('ROLLBACK'); } catch (rollbackError) { error.rollbackError ??= rollbackError.message; }
      this.markRolledBack();
      throw error;
    }
  }
  command(key) { const row = this.db.prepare('SELECT data FROM commands WHERE id=?').get(key); return row ? JSON.parse(row.data) : undefined; }
  putCommand(record, inputDigest) { this.db.prepare('INSERT INTO commands VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.commandId, inputDigest, JSON.stringify(record)); }
  commandDigest(key) { return this.db.prepare('SELECT digest FROM commands WHERE id=?').get(key)?.digest; }
  commandHistory(limit = 100) { return this.db.prepare('SELECT data FROM commands ORDER BY rowid DESC LIMIT ?').all(limit).map(r => JSON.parse(r.data)); }
}

export function initProject({ stateDir, root, name, workflow, config = {}, supervisor = 'systemd' }) {
  config = validateConfig(config);
  const catalog = config.mode === 'delivery' && config.workflows ? compileCatalog(config, root) : null;
  if (config.mode === 'delivery') workflow = catalog ? defaultWorkflow(catalog, config) : changeWorkflow(config);
  if (config.mode === 'delivery') validateRecurringWorkflows(config, catalog);
  validateWorkflow(workflow);
  assert(['systemd', 'process'].includes(supervisor), 'unsupported supervisor');
  const absoluteRoot = resolve(root), absoluteState = resolve(stateDir);
  assert(absoluteState !== absoluteRoot && !absoluteState.startsWith(absoluteRoot + '/'), 'runtime state must be outside the project checkout');
  mkdirSync(absoluteState, { recursive: true, mode: 0o700 });
  // Fence initialization before opening SQLite: racing journal/schema setup can
  // otherwise make every contender fail. Never remove this claim automatically;
  // an interrupted initializer requires inspection, not an empty replacement.
  const claim = openSync(join(absoluteState, 'initialization.claim'), 'wx', 0o600);
  closeSync(claim);
  assert(!existsSync(join(absoluteState, 'state.sqlite')), 'project state already exists');
  const store = new Store(absoluteState, { create: true });
  try {
    store.tx(() => {
      assert(!store.meta('project'), 'project state already initialized');
      store.setMeta('project', { projectId: uid(), serviceId: uid(), name, root: absoluteRoot, supervisor, createdAt: now() });
      store.setMeta('workflow', workflow);
      store.setMeta('workflowDigest', digest(workflow)); store.setMeta('catalog', catalog);
      store.setMeta('config', config); store.setMeta('configDigest', digest(config)); syncScheduledTaskRecords(store, config);
      store.setMeta('paused', false);
      store.setMeta('recoveryHold', false);
      store.event('project.initialized', { name, synthetic: config.mode !== 'delivery' });
    });
    return store.meta('project');
  } finally { store.close(); }
}
