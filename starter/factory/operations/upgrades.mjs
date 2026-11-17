import { mkdirSync, cpSync, existsSync, renameSync, rmSync, readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assert, atomicJSON, digest, fileDigest } from '../core/contracts.mjs';
import { inlineForRelease } from './state-layout.mjs';
export function upgradePreflight(store, { schemaVersions, configVersions, executorDigests = [], requireDrain = true }) {
  const reasons = [];
  if (!schemaVersions.includes(store.meta('schemaVersion'))) reasons.push('schema version unsupported');
  const config = store.meta('config', { version: 1 }); if (!configVersions.includes(config.version ?? 1)) reasons.push('configuration version unsupported');
  const active = store.live('flow').filter(f => !['completed', 'failed'].includes(f.state));
  if (requireDrain && active.length) reasons.push('active flows must drain before upgrade');
  if (store.live('attempt').some(a => ['prepared', 'dispatching', 'running', 'uncertain'].includes(a.status))) reasons.push('unresolved attempts prevent upgrade');
  if (!requireDrain && active.some(f => !executorDigests.includes(f.executorDigest))) reasons.push('active executor compatibility missing');
  return { ok: !reasons.length, reasons, activeFlows: active.map(f => f.id) };
}
function treeDigest(path) { const entries = []; function walk(dir, prefix = '') { for (const name of readdirSync(dir).sort()) { const p = join(dir, name), relative = prefix + name, stat = lstatSync(p); assert(!stat.isSymbolicLink(), 'upgrade symlinks unsupported'); if (stat.isDirectory()) walk(p, relative + '/'); else { assert(stat.isFile(), 'upgrade contains special file'); entries.push([relative, digest(readFileSync(p).toString('base64'))]); } } } walk(path); return digest(entries); }
export function stageUpgrade(store, { sourceDir, installRoot, version, compatibility }) {
  const preflight = upgradePreflight(store, compatibility); assert(preflight.ok, preflight.reasons.join('; ')); assert(/^[A-Za-z0-9._-]+$/.test(version), 'invalid installation version');
  const root = resolve(installRoot), source = resolve(sourceDir), staged = join(root, `staged-${version}`), final = join(root, `version-${version}`);
  assert(!root.startsWith(source + '/') && root !== source, 'installation root must be outside source tree');
  const codeDigest = treeDigest(source), inputDigest = digest({ source, root, version, compatibility, codeDigest });
  let record = store.get('upgrade', version);
  if (record) {
    assert(record.inputDigest === inputDigest, 'installation version reused with different input');
    if (record.status !== 'preparing') return record;
    assert(record.staged === staged && record.final === final && !existsSync(final), 'staged ownership changed');
    // A durable preparing record owns only this unpublished directory. Re-copy immutable input after a crash.
    if (existsSync(staged)) { assert(!lstatSync(staged).isSymbolicLink(), 'staged directory redirected'); rmSync(staged, { recursive: true }); }
  } else {
    assert(!existsSync(staged) && !existsSync(final), 'installation version already exists without ownership');
    record = { id: version, version, source, staged, final, root, codeDigest, inputDigest, status: 'preparing', compatibility };
    store.tx(() => { store.put('upgrade', record); store.event('upgrade.prepare-intent', { version, codeDigest }); });
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  cpSync(source, staged, { recursive: true, errorOnExist: true, force: false });
  assert(treeDigest(staged) === codeDigest, 'source changed while staging installation');
  record.status = 'staged';
  store.tx(() => { store.put('upgrade', record); store.event('upgrade.staged', { version, codeDigest }); }); return record;
}
export function finishUpgrade(store, { version, verify }) {
  const row = store.need('upgrade', version); assert(['staged', 'installed'].includes(row.status), 'upgrade cannot activate');
  const preflight = upgradePreflight(store, row.compatibility); assert(preflight.ok, preflight.reasons.join('; '));
  if (row.status === 'staged') {
    assert(treeDigest(existsSync(row.staged) ? row.staged : row.final) === row.codeDigest, 'staged installation changed');
    if (existsSync(row.staged)) renameSync(row.staged, row.final);
    store.tx(() => { row.status = 'installed'; store.put('upgrade', row); });
  }
  assert(treeDigest(row.final) === row.codeDigest, 'installed version changed');
  assert(typeof verify === 'function' && verify(row.final) === true, 'installed version verification failed; current pointer unchanged');
  assert(treeDigest(row.final) === row.codeDigest, 'verification changed installed code');
  // A version whose compatibility does not declare this release's record layout reads attempt
  // intents only inline: return the state to that layout before the launcher points at it.
  inlineForRelease(store, row.compatibility);
  atomicJSON(join(row.root, 'current.json'), { version: row.version, path: row.final, codeDigest: row.codeDigest });
  store.tx(() => { row.status = 'activated'; store.put('upgrade', row); store.event('upgrade.activated', { version, codeDigest: row.codeDigest }); }); return row;
}

// Launcher accepts one explicit starter layout and verifies the exact activated tree before execution.
export function resolveInstallation(store, installRoot) {
  const root = realpathSync(resolve(installRoot));
  const pointerPath = join(root, 'current.json'); assert(!lstatSync(pointerPath).isSymbolicLink(), 'installation pointer must be a regular file');
  const pointer = JSON.parse(readFileSync(pointerPath, 'utf8'));
  assert(typeof pointer.version === 'string' && /^[A-Za-z0-9._-]+$/.test(pointer.version), 'invalid installation pointer version');
  const expected = join(root, `version-${pointer.version}`);
  assert(pointer.path === expected && realpathSync(expected) === expected, 'installation pointer escapes immutable version root');
  const row = store.need('upgrade', pointer.version);
  assert(['activated', 'installed'].includes(row.status) && row.root === root && row.final === expected && row.codeDigest === pointer.codeDigest, 'installation pointer is not a recorded verified version');
  assert(row.compatibility.schemaVersions.includes(store.meta('schemaVersion')), 'installed launcher schema incompatible');
  assert(row.compatibility.configVersions.includes(store.meta('config', {}).version ?? 1), 'installed launcher configuration incompatible');
  assert(treeDigest(expected) === row.codeDigest, 'installed runtime digest changed');
  const entry = join(expected, 'factory', 'cli.mjs'); assert(lstatSync(entry).isFile() && realpathSync(entry) === entry, 'installed runtime requires factory/cli.mjs layout');
  const factoryRoot = join(expected, 'factory');
  const executors = dir => readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory() && item.name !== 'console' ? executors(join(dir, item.name)) : item.isFile() && item.name.endsWith('.mjs') && !item.name.endsWith('.test.mjs') && item.name !== 'cli.mjs' ? [join(dir, item.name)] : []);
  const executorDigest = digest(executors(factoryRoot).sort().map(path => [path.slice(factoryRoot.length + 1), fileDigest(path)]));
  assert(store.live('flow').filter(flow => !['completed','failed'].includes(flow.state)).every(flow => flow.executorDigest === executorDigest), 'active flow requires its original pinned executor installation');
  return { version: pointer.version, entry, path: expected, codeDigest: row.codeDigest, executorDigest };
}
