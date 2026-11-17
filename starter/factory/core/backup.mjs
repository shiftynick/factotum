import { mkdirSync, readdirSync, copyFileSync, readFileSync, existsSync, statSync, renameSync, rmSync, openSync, fsyncSync, closeSync, chmodSync } from 'node:fs';
import { join, resolve, relative, dirname } from 'node:path';
import { Store } from './store.mjs';
import { assert, atomicJSON, fileDigest, now, uid } from './contracts.mjs';
import { assertAuthorityRecordsSound } from './decision-authority.mjs';
import { placeRecoveryHold } from '../operations/recovery-hold.mjs';

export function backupProject(stateDir, destination) {
  const store = new Store(stateDir);
  const target = resolve(destination);
  assert(!existsSync(target), 'backup destination must not exist');
  assert(!target.startsWith(store.stateDir + '/'), 'backup destination must be outside source state');
  try {
    mkdirSync(target, { mode: 0o700, recursive: true });
    // SQLite makes a consistent copy including WAL contents; no newer Node serialization API required.
    store.db.prepare('VACUUM INTO ?').run(join(target, 'state.sqlite'));
    chmodSync(join(target, 'state.sqlite'), 0o600);
    for (const directory of ['attempts', 'reconciliations']) {
      const sourceArtifacts = join(store.stateDir, directory);
      if (existsSync(sourceArtifacts)) copyTree(sourceArtifacts, join(target, directory));
    }
    const files = walk(target).map(path => ({ path: relative(target, path), digest: fileDigest(path) }));
    // schemaVersion is informational; restore trusts only the restored database's own schema check.
    atomicJSON(join(target, 'backup.json'), { version: 1, createdAt: now(), projectId: store.meta('project').projectId, schemaVersion: store.meta('schemaVersion'), files });
    return { destination: target, files: files.length };
  } finally { store.close(); }
}
export function restoreProject(source, stateDir) {
  const backup = resolve(source), target = resolve(stateDir);
  assert(!existsSync(target), 'restore destination must not exist');
  assert(!target.startsWith(backup + '/'), 'restore destination must be outside backup');
  const manifest = JSON.parse(readFileSync(join(backup, 'backup.json'), 'utf8'));
  assert(manifest.version === 1 && Array.isArray(manifest.files), 'invalid backup manifest');
  for (const file of manifest.files) {
    const path = resolve(backup, file.path);
    assert(path.startsWith(backup + '/') && fileDigest(path) === file.digest, 'backup artifact missing or corrupt');
  }
  assert(manifest.files.some(f => f.path === 'state.sqlite'), 'backup lacks database');
  const staging = `${target}.restore-${uid()}`;
  mkdirSync(staging, { mode: 0o700, recursive: true });
  try {
    for (const file of manifest.files) {
      const path = resolve(staging, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); copyFileSync(join(backup, file.path), path);
      const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    const store = new Store(staging);
    try {
      // Decision-authority records (holds, grants and their usage, authority revisions) travel in the
      // database copy; a restore whose authority records or references are corrupt fails closed.
      assertAuthorityRecordsSound(store, 'restore');
      store.tx(() => { store.setMeta('paused', true); placeRecoveryHold(store, { cause: 'restore' }); store.event('state.restored', { requiresReconciliation: true }); });
      store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally { store.close(); }
    // Publish only after the dispatch hold is committed; interrupted staging is never authoritative.
    renameSync(staging, target);
    const parent = openSync(dirname(target), 'r'); try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
  return { stateDir: target, paused: true, recoveryHold: true };
}
function walk(root) { return readdirSync(root).sort().flatMap(name => { const path = join(root, name); return statSync(path).isDirectory() ? walk(path) : [path]; }); }
function copyTree(source, target) {
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(source)) { const from = join(source, name), to = join(target, name); if (statSync(from).isDirectory()) copyTree(from, to); else copyFileSync(from, to); }
}
