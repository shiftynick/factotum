import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { sandbox } from './helpers.mjs';
import { samples } from './authority-fixtures.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { executeCommand, snapshot } from '../starter/factory/core/project.mjs';
import { canonical, digest, uid } from '../starter/factory/core/contracts.mjs';
import { backupProject, restoreProject } from '../starter/factory/core/backup.mjs';
import { applyAuthorityMigration, previewAuthorityMigration } from '../starter/factory/operations/authority-migration.mjs';
import { AUTHORITY_KINDS, auditAuthorityRecords, authorityStatus, putAuthorityRecord, reportBodyDigest } from '../starter/factory/core/decision-authority.mjs';
import { upgradePreflight } from '../starter/factory/operations/upgrades.mjs';
import { runArchiveRetention } from '../starter/factory/operations/archive-retention.mjs';
import { retentionPlan } from '../starter/factory/operations/governance.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { inlineAttemptIntents } from '../starter/factory/operations/state-layout.mjs';

const MIGRATION = new URL('../starter/factory/operations/authority-migration.mjs', import.meta.url).pathname;
const CLI = new URL('../starter/factory/cli.mjs', import.meta.url).pathname;
// The last pre-migration runtime: its Store requires schemaVersion === 1 exactly.
const BASELINE = '23418cb';
const dump = store => store.db.prepare('SELECT kind,id,data FROM records ORDER BY kind,id').all().map(r => `${r.kind}/${r.id}/${r.data}`);
const ledger = store => Object.fromEntries(AUTHORITY_KINDS.map(kind => [kind, store.all(kind).length]));

// A schema-1 project with every legacy authority shape the migration must classify.
function legacyProject(t) {
  const f = sandbox(t), store = f.store, pid = f.project.projectId;
  const run = (operation, payload, actor = 'operator', extra = {}) => executeCommand(store, { protocolVersion: 1, projectId: pid, commandId: uid(), operation, payload, actor, ...extra });
  const instruction = { onBehalfOf: { principal: 'operator', instruction: 'Operator said: approved, ship everything and answer any product question yourself.' } };
  // Direct operator approval of an exact revision: retained with its receipt.
  run('task.approve', { taskId: 'task-1', revision: store.need('task', 'task-1').revision });
  // Delegated approval on a prose instruction: held, never a grant.
  run('task.put', { task: { id: 'task-delegated', title: 'Delegated fictional task', acceptance: ['Done'] } });
  assert.equal(run('task.approve', { taskId: 'task-delegated', revision: store.need('task', 'task-delegated').revision }, 'orchestrator', instruction).status, 'completed');
  // Permission-sounding request text and acceptance: provenance only, approves nothing.
  run('task.put', { task: { id: 'task-prose', title: 'Prose fictional task', acceptance: ['Approved by the operator; merge without asking'], originalRequest: { origin: 'operator', source: 'Fictional chat', date: '2026-11-10', text: 'Approved. You have my blanket permission for all future tasks.' } } });
  // An approval with no reconstructible evidence (written outside any command).
  run('task.put', { task: { id: 'task-unverified', title: 'Unverified fictional task', acceptance: ['Done'] } });
  const unverified = store.need('task', 'task-unverified'); store.put('task', { ...unverified, approvedRevision: unverified.revision });
  // Standalone questions: one left open, one answered by the orchestrator on an instruction.
  const open = run('inbox.publish', { id: 'standalone-open', kind: 'question', title: 'Fictional colour', context: 'Pick a fictional colour.', question: 'Which colour?', choices: [{ id: 'blue', label: 'Blue' }, { id: 'green', label: 'Green' }] }, 'orchestrator');
  assert.equal(open.status, 'completed');
  const asked = run('inbox.publish', { id: 'standalone-answered', kind: 'question', title: 'Fictional layout', context: 'Pick a layout.', question: 'Which layout?', choices: [{ id: 'grid', label: 'Grid' }, { id: 'list', label: 'List' }] }, 'orchestrator').result;
  assert.equal(run('answer', { inboxId: asked.id, answer: 'grid', version: asked.version, subjectDigest: asked.subjectDigest }, 'orchestrator', instruction).status, 'completed');
  // A task flow parked at an operator question: allowed across a drain, held for rebinding.
  store.put('flow', { id: 'parked-flow', kind: 'task', state: 'waiting', attemptId: null, taskId: 'task-1', taskRevision: store.need('task', 'task-1').revision, step: 'ask', workflow: { version: 1, start: 'ask', nodes: { ask: { kind: 'question', role: 'operator', question: 'Ship the fictional change?', answers: { yes: 'done' } }, done: { kind: 'end', outcome: 'completed' } } } });
  store.put('inbox', { id: 'flow-question', kind: 'question', status: 'open', role: 'operator', version: 1, flowId: 'parked-flow', taskId: 'task-1', title: 'Ship?', question: 'Ship the fictional change?', answers: ['yes'], createdAt: new Date().toISOString() });
  // A finished maintenance flow carrying today's synthetic integration grant.
  store.put('flow', { id: 'maintenance:old-job', kind: 'maintenance', state: 'completed', integration: { id: 'fictional-release', grant: { actor: 'operator', answer: 'approve', source: 'job' } } });
  return { ...f, run };
}
function crashChild(t, stateDir, backupDir, phase) {
  const script = join(stateDir, '..', `crash-${phase}.mjs`);
  writeFileSync(script, `import { applyAuthorityMigration } from ${JSON.stringify(pathToFileURL(MIGRATION).href)};\nawait applyAuthorityMigration(${JSON.stringify(stateDir)}, { backupDir: ${JSON.stringify(backupDir)}, hooks: { ${phase}: () => process.exit(86) } });\nprocess.exit(0);\n`);
  return spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 30000 });
}
// The real pre-migration runtime, extracted from repository history. Without the
// history (a source archive, a shallow clone) the tests that need it are skipped
// visibly with the reason; nothing silently substitutes a weaker check.
async function baselineRuntime(f) {
  const dir = join(f.base, 'baseline-runtime'); mkdirSync(dir, { recursive: true });
  try { execFileSync('sh', ['-c', `git archive ${BASELINE} starter/factory | tar -x -C "$1"`, 'sh', dir], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' }); }
  catch (error) { return { skip: `baseline runtime ${BASELINE} is not in this checkout's git history (${String(error.stderr || error.message).trim().split('\n')[0]})` }; }
  const load = path => import(pathToFileURL(join(dir, 'starter/factory', path)).href);
  // A project of that runtime has its attempt intents inline and no layout fence (core/records.mjs);
  // the fixture was created by this runtime, so it is returned to that layout first.
  assert.equal(inlineAttemptIntents(f.store).layout, 'inline');
  return { dir: join(dir, 'starter/factory'), Store: (await load('core/store.mjs')).Store, executeCommand: (await load('core/project.mjs')).executeCommand, restoreProject: (await load('core/backup.mjs')).restoreProject };
}

test('preview is read-only and inventories every legacy authority shape', t => {
  const f = legacyProject(t), before = dump(f.store), revision = f.store.meta('revision');
  const preview = previewAuthorityMigration(f.stateDir);
  assert.equal(preview.status, 'ready', preview.blocking.join('; '));
  assert.deepEqual(preview.creates, { grants: 0, authorityUses: 0, dispositions: 0 });
  assert.deepEqual(dump(f.store), before); assert.equal(f.store.meta('revision'), revision); assert.equal(f.store.meta('schemaVersion'), 1);
  const by = Object.fromEntries(preview.items.map(i => [`${i.item}:${i.subject.taskId ?? ''}:${i.subject.inboxId ?? ''}:${i.subject.flowId ?? ''}`, i]));
  assert.equal(by['task-approval:task-1::'].classification, 'direct-operator'); assert.equal(by['task-approval:task-1::'].status, 'retained');
  assert.equal(by['task-approval:task-1::'].evidence.actor, 'operator');
  assert.equal(by['task-approval:task-delegated::'].classification, 'legacy-delegated'); assert.equal(by['task-approval:task-delegated::'].status, 'held');
  assert.equal(by['task-approval:task-unverified::'].classification, 'legacy-unverified'); assert.equal(by['task-approval:task-unverified::'].status, 'held');
  assert.ok(!preview.items.some(i => i.subject.taskId === 'task-prose'), 'prose approves nothing');
  assert.equal(by['open-question::standalone-open:'].classification, 'informational-v1'); assert.equal(by['open-question::standalone-open:'].status, 'held');
  assert.equal(by['open-question:task-1:flow-question:parked-flow'].classification, 'ambiguous-question');
  assert.equal(by['carried-over-flow:task-1::parked-flow'].status, 'held');
  assert.ok(!preview.items.some(i => i.subject.inboxId === 'standalone-answered'), 'an answered question is history, not authority');
  assert.equal(preview.counts.snapshots, 4); assert.equal(preview.counts.requestUnknown, 3);
  assert.equal(preview.snapshots.find(s => s.taskId === 'task-prose').requestCoverage, 'recorded');
});

test('a restart approval is retained only when its restart flow proves the approved revision and workflow binding', t => {
  const f = sandbox(t), store = f.store;
  const restart = taskId => {
    const result = f.command('task.restart', { taskId, revision: store.need('task', taskId).revision, note: 'Restart the fictional task' });
    assert.equal(result.status, 'completed', result.error);
    const flow = store.need('flow', result.result.flowId); store.put('flow', { ...flow, state: 'completed' }); return flow;
  };
  f.command('task.put', { task: { id: 'task-1', title: 'Restarted fictional feature', acceptance: ['Restarted'] } });
  restart('task-1');
  f.command('task.put', { task: { id: 'task-2', title: 'Second fictional feature', acceptance: ['Restarted'] } });
  const second = restart('task-2');
  // The restart receipt alone names only the flow; its admission record must carry the approval it ran under.
  store.put('flow', { ...store.need('flow', second.id), taskSnapshot: { ...second.taskSnapshot, approvedWorkflow: { name: 'another-workflow', digest: digest('another') } } });
  const items = previewAuthorityMigration(f.stateDir).items.filter(i => i.item === 'task-approval');
  const of = taskId => items.find(i => i.subject.taskId === taskId);
  assert.equal(of('task-1').classification, 'direct-operator'); assert.equal(of('task-1').evidence.operation, 'task.restart');
  assert.equal(of('task-2').classification, 'legacy-unverified'); assert.equal(of('task-2').status, 'held');
  assert.match(of('task-2').reasons[0], /restart flow does not prove the approved revision and workflow binding/);
  store.db.prepare("DELETE FROM records WHERE kind='flow' AND id=?").run(second.id);
  assert.equal(previewAuthorityMigration(f.stateDir).items.find(i => i.subject.taskId === 'task-2').classification, 'legacy-unverified');
});

test('preview lists every task whose brief exceeds the snapshot compatibility limit', t => {
  const f = sandbox(t), brief = { id: 'task-big', title: 'Big fictional brief', acceptance: ['x'.repeat(300 * 1024)] };
  f.store.put('task', { ...brief, revision: digest(brief) });
  const preview = previewAuthorityMigration(f.stateDir);
  assert.equal(preview.status, 'blocked');
  assert.deepEqual(preview.overLimitBriefs.map(({ taskId, limit }) => ({ taskId, limit })), [{ taskId: 'task-big', limit: 256 * 1024 }]);
  assert.ok(preview.overLimitBriefs[0].bytes > 300 * 1024);
});

test('apply migrates in one transaction without inventing authority; held items stay visible and untouched; rerun is a no-op', async t => {
  const f = legacyProject(t), store = f.store, preview = previewAuthorityMigration(f.stateDir);
  const inboxBefore = canonical(store.all('inbox')), tasksBefore = canonical(store.all('task')), flowsBefore = canonical(store.all('flow'));
  const result = await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup-1') });
  assert.equal(result.status, 'migrated'); assert.equal(result.migration.migrationId, preview.migrationId);
  assert.equal(store.meta('schemaVersion'), 2);
  assert.equal(JSON.parse(readFileSync(join(f.base, 'backup-1', 'backup.json'), 'utf8')).schemaVersion, 1, 'the backup is the pre-migration state');
  // Never a grant, authority use or disposition: not from prose, onBehalfOf, delegated answers or job grants.
  const counts = ledger(store);
  assert.deepEqual({ grants: counts.operatorGrant, uses: counts.authorityUse, dispositions: counts.decisionDisposition, decisions: counts.decisionObligation }, { grants: 0, uses: 0, dispositions: 0, decisions: 0 });
  assert.equal(counts.taskRevision, 4); assert.equal(counts.taskAuthority, 4); assert.equal(counts.legacyAuthority, preview.items.length);
  // Existing state is unchanged: approvals, open questions and flows keep their current meaning.
  assert.equal(canonical(store.all('inbox')), inboxBefore); assert.equal(canonical(store.all('task')), tasksBefore); assert.equal(canonical(store.all('flow')), flowsBefore);
  const status = authorityStatus(store);
  assert.equal(status.enforcement, 'not-wired'); assert.equal(status.migration.coverage, 'incomplete');
  assert.equal(status.legacy.held, preview.counts.held); assert.ok(status.hold.reasons.some(r => /coverage incomplete/.test(r)));
  assert.deepEqual(snapshot(store).authority.legacy.heldItems.map(i => i.classification).sort(), ['ambiguous-question', 'ambiguous-question', 'informational-v1', 'legacy-delegated', 'legacy-unverified']);
  for (const row of store.all('legacyAuthority')) assert.ok(row.status === 'retained' ? ['direct-operator', 'configured'].includes(row.classification) : true);
  assert.deepEqual(auditAuthorityRecords(store), []);
  const records = dump(store), events = store.events(1000).length;
  const again = await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup-2') });
  assert.equal(again.status, 'already-migrated'); assert.equal(again.applied, false);
  assert.deepEqual(dump(store), records); assert.equal(store.events(1000).length, events); assert.equal(existsSync(join(f.base, 'backup-2')), false);
  assert.equal(previewAuthorityMigration(f.stateDir).status, 'already-migrated');
});

test('a crash before commit leaves schema 1 untouched and a rerun completes; a crash after commit leaves the complete migration', async t => {
  const f = legacyProject(t), preview = previewAuthorityMigration(f.stateDir), before = dump(f.store);
  const crashed = crashChild(t, f.stateDir, join(f.base, 'backup-before'), 'beforeCommit');
  assert.equal(crashed.status, 86, crashed.stderr);
  { const fresh = new Store(f.stateDir); try { assert.equal(fresh.meta('schemaVersion'), 1); assert.equal(fresh.meta('authorityMigration'), undefined); assert.deepEqual(dump(fresh), before); } finally { fresh.close(); } }
  assert.ok(existsSync(join(f.base, 'backup-before', 'backup.json')), 'the backup was written inside the uncommitted transaction');
  assert.equal(previewAuthorityMigration(f.stateDir).migrationId, preview.migrationId);
  const g = legacyProject(t), gPreview = previewAuthorityMigration(g.stateDir);
  const committed = crashChild(t, g.stateDir, join(g.base, 'backup-after'), 'afterCommit');
  assert.equal(committed.status, 86, committed.stderr);
  const reopened = new Store(g.stateDir);
  try {
    assert.equal(reopened.meta('schemaVersion'), 2); assert.equal(reopened.meta('authorityMigration').migrationId, gPreview.migrationId);
    assert.equal(reopened.all('legacyAuthority').length, gPreview.items.length); assert.deepEqual(auditAuthorityRecords(reopened), []);
  } finally { reopened.close(); }
  const records = dump(g.store);
  assert.equal((await applyAuthorityMigration(g.stateDir, { backupDir: join(g.base, 'unused') })).status, 'already-migrated');
  assert.deepEqual(dump(g.store), records);
  // The pre-commit crash is recovered by an ordinary rerun with a new backup.
  const rerun = await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup-rerun') });
  assert.equal(rerun.status, 'migrated'); assert.equal(rerun.migration.migrationId, preview.migrationId);
});

test('the pre-migration runtime refuses to open or restore a migrated database', async t => {
  const f = sandbox(t), old = await baselineRuntime(f);
  if (old.skip) return t.skip(old.skip);
  const opened = new old.Store(f.stateDir); opened.close();
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup') });
  assert.throws(() => new old.Store(f.stateDir), /unsupported database schema/);
  backupProject(f.stateDir, join(f.base, 'migrated-backup'));
  assert.throws(() => old.restoreProject(join(f.base, 'migrated-backup'), join(f.base, 'old-restore')), /unsupported database schema/);
  assert.equal(existsSync(join(f.base, 'old-restore')), false);
});

test('a pre-migration runtime holding a connection open across the migration cannot write afterwards', async t => {
  const f = sandbox(t), old = await baselineRuntime(f);
  if (old.skip) return t.skip(old.skip);
  const held = new old.Store(f.stateDir), pid = f.project.projectId;
  t.after(() => held.close());
  const oldCommand = (operation, payload) => old.executeCommand(held, { protocolVersion: 1, projectId: pid, commandId: uid(), operation, payload, actor: 'operator' });
  assert.equal(oldCommand('task.put', { task: { id: 'task-before', title: 'Written by the old runtime before migration', acceptance: ['Done'] } }).status, 'completed');
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup') });
  const before = dump(f.store), revision = f.store.meta('revision'), receipts = f.store.commandHistory(1000).length;
  // The old connection's command path, its raw record writes and an attempt to put the marker back all fail.
  assert.throws(() => oldCommand('task.put', { task: { id: 'task-after', title: 'Old runtime write after migration', acceptance: ['Never stored'] } }), /no such function: factotum_writer_schema/);
  assert.throws(() => held.put('task', { id: 'task-raw', title: 'Raw old write' }), /no such function/);
  assert.throws(() => held.setMeta('schemaVersion', 1), /no such function/);
  assert.throws(() => held.tx(() => held.event('task.updated', { taskId: 'task-1' })), /no such function/);
  assert.deepEqual(dump(f.store), before); assert.equal(f.store.meta('revision'), revision); assert.equal(f.store.commandHistory(1000).length, receipts);
  assert.equal(f.store.meta('schemaVersion'), 2); assert.equal(f.store.get('task', 'task-after'), undefined);
  // A connection the old runtime opens later is refused at open, and the current runtime still writes, with snapshots.
  assert.throws(() => new old.Store(f.stateDir), /unsupported database schema/);
  assert.equal(f.command('task.put', { task: { id: 'task-after', title: 'Current runtime write', acceptance: ['Stored'] } }).status, 'completed');
  assert.equal(f.store.all('taskRevision').filter(r => r.taskId === 'task-after').length, 1);
  assert.deepEqual(auditAuthorityRecords(f.store), []);
});

test('no other writer can commit between the migration backup and its commit', async t => {
  const f = sandbox(t), other = new Store(f.stateDir); t.after(() => other.close());
  other.db.exec('PRAGMA busy_timeout=50');
  let refused;
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup'), hooks: { afterBackup: () => { try { other.tx(() => other.put('task', { ...other.need('task', 'task-1'), title: 'Written behind the backup' })); refused = null; } catch (error) { refused = error.message; } } } });
  assert.match(refused ?? 'the concurrent write committed', /locked|busy/);
  assert.equal(f.store.need('task', 'task-1').title, 'Fictional feature');
});

// A SQLite build that defaults trusted_schema off, simulated by a preload: every
// new connection starts untrusted, and in "refuse" mode cannot be made trusted.
const UNTRUSTED_PRELOAD = `import { DatabaseSync } from 'node:sqlite';
const exec = DatabaseSync.prototype.exec, seen = new WeakSet(), refuse = process.env.FACTOTUM_TEST_REFUSE_TRUST === '1';
for (const name of ['exec', 'prepare', 'function']) {
  const original = DatabaseSync.prototype[name];
  DatabaseSync.prototype[name] = function (...args) {
    if (!seen.has(this)) { seen.add(this); exec.call(this, 'PRAGMA trusted_schema=OFF'); }
    if (name === 'exec' && refuse) args[0] = String(args[0]).replace(/PRAGMA\\s+trusted_schema\\s*=\\s*ON\\s*;?/gi, '');
    return original.apply(this, args);
  };
}
`;
function untrustedChild(f, mode, steps, oldDir = '') {
  const url = path => JSON.stringify(pathToFileURL(new URL(`../starter/factory/${path}`, import.meta.url).pathname).href);
  const preload = join(f.base, 'untrusted-preload.mjs'), script = join(f.base, `untrusted-${mode}-${uid()}.mjs`);
  writeFileSync(preload, UNTRUSTED_PRELOAD);
  writeFileSync(script, `import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { Store } from ${url('core/store.mjs')};
import { executeCommand } from ${url('core/project.mjs')};
import { backupProject, restoreProject } from ${url('core/backup.mjs')};
import { auditAuthorityRecords } from ${url('core/decision-authority.mjs')};
import { applyAuthorityMigration } from ${url('operations/authority-migration.mjs')};
const [stateDir, base, oldDir] = process.argv.slice(2), out = {}, steps = ${JSON.stringify(steps)};
const attempt = async (key, fn) => { try { out[key] = await fn(); } catch (error) { out[key] = { error: error.message }; } };
const put = (store, id) => executeCommand(store, { protocolVersion: 1, projectId: store.meta('project').projectId, commandId: 'cmd-' + id, operation: 'task.put', payload: { task: { id, title: 'Fictional untrusted-schema write', acceptance: ['Stored'] } }, actor: 'operator' }).status;
out.defaultTrusted = new DatabaseSync(':memory:').prepare('PRAGMA trusted_schema').get().trusted_schema;
const OldStore = oldDir ? (await import(new URL('file://' + join(oldDir, 'core/store.mjs')).href)).Store : null;
const held = OldStore && steps.includes('migrate') ? new OldStore(stateDir) : null;
if (steps.includes('migrate')) await attempt('migration', async () => (await applyAuthorityMigration(stateDir, { backupDir: join(base, 'untrusted-pre-' + Date.now()) })).status);
if (steps.includes('write')) await attempt('reopened', () => {
  const store = new Store(stateDir);
  try { store.setMeta('fictionalProbe', 1); const status = put(store, 'task-untrusted'); return { status, schemaVersion: store.meta('schemaVersion'), snapshots: store.all('taskRevision').filter(r => r.taskId === 'task-untrusted').length, audit: auditAuthorityRecords(store).length }; }
  finally { store.close(); }
});
if (steps.includes('restore')) await attempt('restored', () => {
  backupProject(stateDir, join(base, 'untrusted-copy')); restoreProject(join(base, 'untrusted-copy'), join(base, 'untrusted-restored'));
  const store = new Store(join(base, 'untrusted-restored'));
  try { return { status: put(store, 'task-after-restore'), recoveryHold: store.meta('recoveryHold') }; } finally { store.close(); }
});
if (steps.includes('open')) await attempt('opened', () => { new Store(stateDir).close(); return 'opened'; });
if (held) {
  await attempt('oldWrite', () => { held.setMeta('schemaVersion', 1); return 'written'; });
  await attempt('oldPut', () => { held.put('task', { id: 'task-old', title: 'Old runtime write' }); return 'written'; });
  held.close();
  await attempt('oldOpen', () => { new OldStore(stateDir).close(); return 'opened'; });
}
console.log(JSON.stringify(out));
`);
  const child = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script, f.stateDir, f.base, oldDir], { encoding: 'utf8', timeout: 60000, env: { ...process.env, FACTOTUM_TEST_REFUSE_TRUST: mode === 'refuse' ? '1' : '0' } });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split('\n').at(-1));
}

test('a SQLite build with trusted_schema off still migrates, writes, backs up and restores, and the old runtime stays fenced', async t => {
  const f = sandbox(t), old = await baselineRuntime(f);
  if (old.skip) t.diagnostic(`old-runtime checks skipped: ${old.skip}`);
  const result = untrustedChild(f, 'off', ['migrate', 'write', 'restore'], old.skip ? '' : old.dir);
  assert.equal(result.defaultTrusted, 0, 'the preload simulates a build whose connections start untrusted');
  assert.equal(result.migration, 'migrated');
  assert.deepEqual(result.reopened, { status: 'completed', schemaVersion: 2, snapshots: 1, audit: 0 });
  assert.deepEqual(result.restored, { status: 'completed', recoveryHold: true });
  if (!old.skip) {
    // Trust does not help the old runtime: it never registers the fence function.
    assert.match(result.oldWrite.error, /factotum_writer_schema/); assert.match(result.oldPut.error, /factotum_writer_schema/);
    assert.match(result.oldOpen.error, /unsupported database schema/);
  }
  const store = f.store;
  assert.equal(store.meta('schemaVersion'), 2); assert.equal(store.get('task', 'task-old'), undefined); assert.equal(store.meta('fictionalProbe'), 1);
});

test('a connection that cannot trust its schema refuses to migrate or open a migrated database with a clear diagnostic', async t => {
  const f = sandbox(t), store = f.store;
  const refused = untrustedChild(f, 'refuse', ['migrate']);
  assert.match(refused.migration.error, /does not trust its schema \(PRAGMA trusted_schema could not be turned on\)/);
  assert.equal(store.meta('schemaVersion'), 1); assert.equal(store.all('taskRevision').length, 0);
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup') });
  const opened = untrustedChild(f, 'refuse', ['open']);
  assert.match(opened.opened.error, /does not trust its schema/);
  assert.equal(store.meta('schemaVersion'), 2);
});

test('release compatibility and the current runtime refuse unknown schemas and a missing or forged migration record', async t => {
  const f = sandbox(t);
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'backup') });
  assert.ok(upgradePreflight(f.store, { schemaVersions: [1], configVersions: [1] }).reasons.includes('schema version unsupported'));
  assert.deepEqual(upgradePreflight(f.store, { schemaVersions: [1, 2], configVersions: [1] }).reasons, []);
  f.store.setMeta('schemaVersion', 3);
  assert.throws(() => new Store(f.stateDir), /unsupported database schema/);
  f.store.setMeta('schemaVersion', 2); const record = f.store.meta('authorityMigration'); f.store.db.prepare("DELETE FROM meta WHERE key='authorityMigration'").run();
  assert.throws(() => new Store(f.stateDir), /without its authority migration record/);
  // Structural corruption of the marker is refused on open: reduced, extended or with an identity it does not derive.
  for (const [forged, reason] of [[{ toSchema: 2 }, /corrupt authority migration record/], [{ ...record, approvedEverything: true }, /unknown field approvedEverything/], [{ ...record, migrationId: digest('forged') }, /migration id is not derived/], [{ ...record, creates: { ...record.creates, grants: 3 } }, /creates.grants/], [{ ...record, counts: { ...record.counts, requestUnknown: record.counts.snapshots + 1 } }, /more unknown-request snapshots/]]) {
    f.store.setMeta('authorityMigration', forged);
    assert.throws(() => new Store(f.stateDir), reason);
  }
  f.store.setMeta('authorityMigration', record);
  f.store.setMeta('authorityHold', { ...f.store.meta('authorityHold'), migrationId: digest('another migration') });
  assert.throws(() => new Store(f.stateDir), /authority hold names another migration/);
  f.store.setMeta('authorityHold', { ...f.store.meta('authorityHold'), migrationId: record.migrationId });
  // A schema-2 database without its write fence is refused too.
  f.store.db.exec('DROP TRIGGER factotum_authority_fence_records_insert');
  assert.throws(() => new Store(f.stateDir), /intact authority write fence/);
});

test('migration refuses undrained, held or running projects and requires a backup, writing nothing', async t => {
  const f = sandbox(t), before = dump(f.store);
  await assert.rejects(applyAuthorityMigration(f.stateDir, {}), /backup destination is required/);
  f.store.put('flow', { id: 'live-flow', kind: 'change', state: 'running', taskId: 'task-1' });
  assert.equal(previewAuthorityMigration(f.stateDir).status, 'blocked');
  await assert.rejects(applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'b1') }), /authority migration refused: drain or explicitly abandon/);
  f.store.put('flow', { id: 'live-flow', kind: 'change', state: 'completed', taskId: 'task-1' });
  f.store.put('attempt', { id: 'uncertain-attempt', flowId: 'live-flow', status: 'uncertain' });
  await assert.rejects(applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'b2') }), /reconcile all unresolved attempts/);
  f.store.put('attempt', { id: 'uncertain-attempt', flowId: 'live-flow', status: 'failed', settledAt: new Date().toISOString() });
  f.store.setMeta('recoveryHold', true);
  await assert.rejects(applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'b3') }), /reconciled and released/);
  f.store.setMeta('recoveryHold', false);
  const runner = createServer(); await new Promise(done => runner.listen(`\0factotum-runner-${f.project.projectId}`, done));
  try { await assert.rejects(applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'b4') }), /runner is still running/); }
  finally { await new Promise(done => runner.close(done)); }
  assert.equal(f.store.meta('schemaVersion'), 1);
  assert.equal(ledger(f.store).taskRevision, 0);
  for (const dir of ['b1', 'b2', 'b3', 'b4']) assert.equal(existsSync(join(f.base, dir)), false);
  assert.ok(dump(f.store).length >= before.length);
  assert.equal((await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'b5') })).status, 'migrated');
});

test('backup and restore carry unresolved holds, grant consumption, authority uses and revisions; corrupt references fail closed', async t => {
  const f = sandbox(t);
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'pre') });
  const store = f.store, s = samples(f.project.projectId, store.need('task', 'task-1').revision);
  store.tx(() => {
    putAuthorityRecord(store, 'decisionObligation', s.decisionObligation);
    putAuthorityRecord(store, 'operatorGrant', s.operatorGrant);
    putAuthorityRecord(store, 'operatorGrant', { ...s.operatorGrant, version: 2, usage: { 'approve-1': 1 } }, { expectedVersion: 1 });
    putAuthorityRecord(store, 'authorityUse', s.authorityUse);
  });
  const records = dump(store), authority = store.get('taskAuthority', 'task-1'), receipts = canonical(store.commandHistory(1000));
  const backup = backupProject(f.stateDir, join(f.base, 'backup'));
  assert.ok(backup.files > 0);
  const restoredDir = join(f.base, 'restored'), restored = restoreProject(join(f.base, 'backup'), restoredDir);
  assert.equal(restored.recoveryHold, true);
  const copy = new Store(restoredDir);
  try {
    assert.equal(copy.meta('schemaVersion'), 2);
    assert.deepEqual(dump(copy), records); assert.equal(canonical(copy.commandHistory(1000)), receipts);
    assert.equal(copy.get('decisionObligation', 'decision-1').status, 'unresolved');
    assert.deepEqual(copy.get('operatorGrant', 'grant-1').usage, { 'approve-1': 1 });
    assert.deepEqual(copy.get('taskAuthority', 'task-1'), authority);
    assert.equal(authorityStatus(copy).unresolvedDecisions, 1);
    assert.equal(copy.meta('recoveryHold'), true, 'a restored ledger stays under the existing recovery hold');
  } finally { copy.close(); }
  // A dangling active disposition in the backup is refused, and no restore target is published.
  store.put('decisionObligation', { ...s.decisionObligation, version: 2, status: 'resolved', activeDispositionId: 'disposition-missing', applicability: [{ ...s.decisionObligation.applicability[0], state: 'covered', dispositionId: 'disposition-missing' }] });
  backupProject(f.stateDir, join(f.base, 'corrupt-backup'));
  assert.throws(() => restoreProject(join(f.base, 'corrupt-backup'), join(f.base, 'corrupt-restore')), /restore refused: decision-authority records need repair/);
  assert.equal(existsSync(join(f.base, 'corrupt-restore')), false);
});

test('restore refuses a backup whose migration record, inventory or authority references do not match what was migrated', async t => {
  const f = legacyProject(t), store = f.store;
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'pre') });
  const record = store.meta('authorityMigration'), revision = store.need('task', 'task-1').revision, s = samples(f.project.projectId, revision);
  let n = 0;
  const restoreRefused = pattern => {
    const backup = join(f.base, `backup-${++n}`), target = join(f.base, `restore-${n}`);
    backupProject(f.stateDir, backup);
    assert.throws(() => restoreProject(backup, target), pattern);
    assert.equal(existsSync(target), false, 'no restore target is published');
  };
  const reasons = () => auditAuthorityRecords(store, { limit: 200 }).map(p => p.reason).join('\n');
  assert.deepEqual(auditAuthorityRecords(store), []);
  // A marker reduced to {toSchema: 2} no longer opens, so it cannot be backed up or restored as sound.
  store.setMeta('authorityMigration', { toSchema: 2 });
  assert.throws(() => backupProject(f.stateDir, join(f.base, 'reduced')), /corrupt authority migration record/);
  store.setMeta('authorityMigration', record);
  // Well-formed but unlinked: counts or inventory that are not what the migration wrote.
  store.setMeta('authorityMigration', { ...record, counts: { ...record.counts, snapshots: record.counts.snapshots + 1 } });
  assert.match(reasons(), /records \d+ snapshot/); restoreRefused(/restore refused: decision-authority records need repair: authorityMigration/);
  const inventoryDigest = digest('another inventory');
  store.setMeta('authorityMigration', { ...record, inventoryDigest, migrationId: digest({ kind: 'authorityMigration', projectId: f.project.projectId, inventoryDigest }) });
  store.setMeta('authorityHold', { ...store.meta('authorityHold'), migrationId: store.meta('authorityMigration').migrationId });
  assert.match(reasons(), /inventory digest does not match/); restoreRefused(/restore refused/);
  store.setMeta('authorityMigration', record); store.setMeta('authorityHold', { ...store.meta('authorityHold'), migrationId: record.migrationId });
  const legacy = store.all('legacyAuthority').find(r => r.status === 'held');
  store.put('legacyAuthority', { ...legacy, reasons: ['Quietly rewritten inventory reason.'] });
  assert.match(reasons(), /inventory digest does not match/); restoreRefused(/restore refused/);
  store.put('legacyAuthority', legacy);
  assert.deepEqual(auditAuthorityRecords(store), []);
  // A resolved decision whose active disposition covers another scope, option set and a nonexistent task revision.
  const ghost = digest('nonexistent revision'), d = s.decisionDisposition;
  store.put('authorityUse', s.directUse);
  store.put('decisionObligation', { ...s.decisionObligation, version: 2, status: 'resolved', activeDispositionId: d.id, applicability: [{ taskId: 'task-1', revision, state: 'covered', dispositionId: d.id }] });
  store.put('decisionDisposition', { ...d, scopeDigest: digest('another scope'), optionSetDigest: digest('another option set'), applicability: [{ taskId: 'task-ghost', revision: ghost }] });
  restoreRefused(/restore refused: decision-authority records need repair: decisionObligation decision-1: active disposition disposition-1 covers a different scope/);
  store.put('decisionDisposition', d);
  assert.deepEqual(auditAuthorityRecords(store), []);
  // A report about a task revision that was never recorded.
  const report = { ...s.decisionReport, taskId: 'task-ghost', taskRevision: ghost }; report.bodyDigest = reportBodyDigest(report);
  store.put('decisionReport', report);
  restoreRefused(/report names unrecorded revision task-ghost@/);
  // A grant whose recorded usage is below the uses that consumed it.
  store.db.prepare("DELETE FROM records WHERE kind='decisionReport'").run();
  store.put('operatorGrant', s.operatorGrant); store.put('authorityUse', s.authorityUse);
  restoreRefused(/entry approve-1 records 0 use\(s\) but 1 authority use\(s\) cite it/);
});

test('unresolved decisions and authority evidence are retention roots', async t => {
  const f = sandbox(t), age = 10000;
  await applyAuthorityMigration(f.stateDir, { backupDir: join(f.base, 'pre') });
  const store = f.store, s = samples(f.project.projectId, store.need('task', 'task-1').revision);
  const path = join(f.stateDir, 'artifacts', 'expired'); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'proof.txt'), 'Fictional evidence');
  const old = new Date(Date.now() - age * 2); utimesSync(join(path, 'proof.txt'), old, old); utimesSync(path, old, old);
  const config = { archiveRoot: join(f.base, 'external-archive'), artifactRoots: ['artifacts'], artifactAgeMs: age };
  const options = { config, flowId: 'retention', operationId: 'retention-one', discover: async () => ({ complete: true, observedAt: new Date().toISOString(), protectedPaths: [] }) };
  store.tx(() => putAuthorityRecord(store, 'decisionObligation', s.decisionObligation));
  await assert.rejects(runArchiveRetention(store, options), /unresolved decision obligation protects retention/);
  assert.equal(retentionPlan(store, { artifactRoot: join(f.stateDir, 'artifacts'), candidates: [], preservation: () => ({ complete: true, protectedPaths: [] }) }).skipped, 'unresolved decision obligations exist');
  store.db.prepare("DELETE FROM records WHERE kind='decisionObligation'").run();
  // Corrupt authority records fail closed rather than being ignored.
  store.put('authorityUse', { ...s.authorityUse });
  await assert.rejects(runArchiveRetention(store, options), /archive retention refused: decision-authority records need repair/);
  store.db.prepare("DELETE FROM records WHERE kind='authorityUse'").run();
  // A report citing a terminal flow keeps that flow's worktree.
  const owned = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId: 'flow-1' });
  store.put('flow', { id: 'flow-1', state: 'stopped', endedAt: old.toISOString(), workspace: owned, results: {} });
  store.tx(() => putAuthorityRecord(store, 'decisionReport', s.decisionReport));
  const result = await runArchiveRetention(store, { ...options, config: { ...config, artifactAgeMs: undefined, worktreeAgeMs: age } });
  assert.deepEqual(result.results.map(r => [r.status, r.reason]), [['protected', 'cited by decision-authority evidence']]);
  assert.ok(existsSync(owned.path));
});

test('the CLI previews, migrates and reports status', t => {
  const f = sandbox(t);
  const call = (...args) => JSON.parse(execFileSync(process.execPath, [CLI, 'authority', ...args, '--state', f.stateDir], { encoding: 'utf8' }));
  assert.equal(call('preview').status, 'ready');
  assert.equal(call('status').ledger, false);
  // Withheld from adopters: refused without the explicit development opt-in, and nothing changes.
  assert.throws(() => execFileSync(process.execPath, [CLI, 'authority', 'migrate', '--out', join(f.base, 'refused'), '--state', f.stateDir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), /not yet released for adopters/);
  assert.equal(call('status').ledger, false);
  assert.equal(call('migrate', '--out', join(f.base, 'cli-backup'), '--unreleased-schema').status, 'migrated');
  const status = call('status'); assert.equal(status.ledger, true); assert.equal(status.enforcement, 'not-wired');
  assert.equal(call('migrate', '--out', join(f.base, 'cli-backup-2'), '--unreleased-schema').status, 'already-migrated');
});
