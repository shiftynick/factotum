import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { releaseFormatState, releaseProject, releaseAttempt, addHistory } from './history-fixtures.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { INTENT_KIND, KIND_INDEXES, LIVE, LAYOUT_FENCE, STATE_INDEXES, VERIFIED_META, ensureStateIndexes, layoutFenceIntact, removeLayoutFence, attemptCostMicros, attemptOperations, flowsSince, inboxSince, inboxVersions, lastOccurrence, latestJob, projectTaskCount, recentProjectTasks, scheduleRuns } from '../starter/factory/core/records.mjs';
import { inlineAttemptIntents, inlineForRelease, inlineLayout, layoutStatus, migrateLayout, migrateStateLayout, stateLayout } from '../starter/factory/operations/state-layout.mjs';
import { hasDuplicateKeys, readIntentRecord } from '../starter/factory/core/intent-text.mjs';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildRelease, prepareAdoption } from '../starter/factory/distribution.mjs';
import { prepareUpgrade, mergeUpgrade } from '../starter/factory/operations/upgrade-apply.mjs';
import { stageUpgrade, finishUpgrade } from '../starter/factory/operations/upgrades.mjs';
import { inspect } from '../starter/factory/core/effects.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { snapshot, publicAttempt, isMaintenanceTask, needsApproval } from '../starter/factory/core/project.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { projectStats } from '../starter/factory/operations/stats-view.mjs';
import { projectTimeline } from '../starter/factory/operations/timeline-view.mjs';
import { retrospective, metrics, retentionPlan } from '../starter/factory/operations/index.mjs';
import { startProjectService, collection } from '../starter/factory/service/project-service.mjs';
import { backupProject, restoreProject } from '../starter/factory/core/backup.mjs';
import { attemptDir } from '../starter/factory/core/effects.mjs';
import { Engine } from '../starter/factory/core/engine.mjs';

const records = store => store.db.prepare('SELECT kind, id, data FROM records ORDER BY kind, id').all().map(row => `${row.kind}\u0000${row.id}\u0000${row.data}`);
const attemptRows = store => new Map(store.db.prepare("SELECT id, data FROM records WHERE kind='attempt' ORDER BY rowid").all().map(row => [row.id, row.data]));
const events = (store, type) => store.db.prepare('SELECT count(*) AS count FROM events WHERE type=?').get(type).count;
// What the read models say, without the parts a migration legitimately moves (its own event and the revision it bumps).
const views = (store, nowMs) => JSON.parse(JSON.stringify({ snapshot: snapshot(store), dashboard: dashboardSnapshot(store), stats: projectStats(store, { window: '7d', nowMs }), timeline: projectTimeline(store, { hours: 72, nowMs }), metrics: metrics(store),
  retrospectives: store.all('flow').map(flow => retrospective(store, { flowId: flow.id })), attempts: collection(store, 'attempt', new URLSearchParams('limit=100')) },
  (key, value) => ['revision', 'events', 'observedAt', 'stateRevision'].includes(key) ? undefined : value));
// The exact text of an intent inside its own record.
const intentText = (store, id) => readIntentRecord(id, store.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(INTENT_KIND, id).data).value;
// The migration (or its reverse) in another process, killed at a point (fixtures/layout-crash.mjs).
const crashAt = (stateDir, operation, point, chunkBytes = 100000) => spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/layout-crash.mjs', import.meta.url)), stateDir, operation, point, String(chunkBytes)], { encoding: 'utf8' });
function open(t, stateDir) { const store = new Store(stateDir); t.after(() => { try { store.close(); } catch {} }); return store; }

test('a state the earlier release wrote migrates with every intent preserved byte for byte, and reads the same before and after', t => {
  const f = releaseFormatState(t), store = open(t, f.stateDir), originals = new Map(f.rows.filter(row => row.kind === 'attempt').map(row => [row.id, row.data])), nowMs = Date.now();
  assert.equal(originals.size, 6); assert.ok([...originals.values()].every(data => data.includes('"intent":{')));
  assert.deepEqual(stateLayout(store), { current: false, layout: 'inline', olderReleasesCanWrite: true, inlineIntents: 6, inlineAttempts: [...originals.keys()], separateIntents: 0, verifiedKinds: [], missingIndexes: STATE_INDEXES.map(index => index.name), lastMigration: null });
  // Before anything moves, this release reads the earlier layout completely, and writes it the earlier way.
  assert.deepEqual(store.all('attempt').map(attempt => JSON.stringify(attempt)), [...originals.values()]);
  for (const [id, data] of originals) { assert.equal(JSON.stringify(store.get('attempt', id)), data); assert.equal(digest(store.intent(id)), JSON.parse(data).intentDigest); }
  { const [id, data] = [...originals][0]; store.put('attempt', store.get('attempt', id)); assert.equal(attemptRows(store).get(id), data, 'without the fence an attempt is written inline, as the earlier release writes it'); assert.equal(store.count(INTENT_KIND), 0); }
  const before = views(store, nowMs), untouched = records(store).filter(row => !row.startsWith('attempt\u0000'));

  const result = migrateStateLayout(store);
  assert.equal(result.changed, true); assert.equal(result.movedIntents, 6); assert.equal(result.refused, undefined); assert.equal(result.fenceInstalled, true); assert.deepEqual(result.indexes, STATE_INDEXES.map(index => index.name));
  const status = stateLayout(store);
  assert.equal(status.current, true); assert.equal(status.layout, 'separate-intents'); assert.equal(status.olderReleasesCanWrite, false); assert.equal(status.inlineIntents, 0); assert.equal(status.separateIntents, 6);
  assert.deepEqual(status.verifiedKinds, [...KIND_INDEXES.keys()]); assert.deepEqual(store.meta(VERIFIED_META).kinds, [...KIND_INDEXES.keys()]);
  assert.equal(events(store, 'state.layout-migrated'), 1); assert.ok(layoutFenceIntact(store.db));
  assert.equal(store.meta('schemaVersion'), 1, 'the schema version is not changed');
  for (const [id, data] of originals) {
    const original = JSON.parse(data), stored = attemptRows(store).get(id), text = intentText(store, id);
    assert.ok(!stored.includes('"intent":'), 'the attempt row no longer carries the intent');
    assert.ok(data.includes(`"intent":${text},"intentDigest"`), 'the stored intent is the original bytes');
    assert.equal(data, stored.replace(',"intentDigest"', `,"intent":${text},"intentDigest"`), 'the attempt row is the original with exactly the intent removed');
    assert.equal(digest(store.intent(id)), original.intentDigest);
    assert.deepEqual(store.get('attempt', id), original, 'the complete attempt reads back with the same values');
    assert.deepEqual(publicAttempt(store.get('attempt', id)), publicAttempt(original));
  }
  assert.deepEqual(store.all('attempt'), [...originals.values()].map(data => JSON.parse(data)));
  assert.deepEqual(records(store).filter(row => !/^attempt(Intent)?\u0000/.test(row)), untouched, 'no other record changed');
  assert.deepEqual(views(store, nowMs), before, 'every read model is unchanged');

  // Idempotent: a second run changes nothing and records nothing.
  const settled = records(store);
  assert.deepEqual(migrateStateLayout(store), { changed: false, movedIntents: 0, indexes: [] });
  assert.deepEqual(records(store), settled); assert.equal(events(store, 'state.layout-migrated'), 1);

  // And back: every record is the earlier release's text again, byte for byte, and the fence is gone.
  assert.deepEqual(inlineAttemptIntents(store), { restoredIntents: 6, orphanIntents: 0, fenceRemoved: true, layout: 'inline' });
  assert.deepEqual([...attemptRows(store).values()], [...originals.values()]); assert.equal(store.count(INTENT_KIND), 0); assert.ok(!layoutFenceIntact(store.db));
  // With the fence go the record of verification and every index: nothing is left that a later fence could be mistaken to vouch for.
  assert.equal(store.meta(VERIFIED_META), undefined); assert.deepEqual(stateLayout(store).missingIndexes, STATE_INDEXES.map(index => index.name)); assert.equal(store.verified('flow'), false);
  assert.deepEqual(records(store).filter(row => !row.startsWith('attempt\u0000')), untouched);
  assert.deepEqual(views(store, nowMs), before);
});

test('an interrupted migration loses nothing and the next run finishes it', t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 30, maintenance: 10, samples: 0, intentBytes: 20000 });
  let store = open(t, f.stateDir); const originals = attemptRows(store), total = originals.size;
  assert.equal(total, 130);
  const complete = () => { for (const [id, data] of originals) assert.equal(JSON.stringify(store.get('attempt', id)), data, `attempt ${id} is complete`); assert.deepEqual(store.all('attempt').map(a => JSON.stringify(a)), [...originals.values()]); };
  const moved = () => store.count(INTENT_KIND), inline = () => stateLayout(store).inlineIntents;

  // A failure inside a transaction: the write of an attempt whose intent was just stored fails.
  // That transaction rolls back whole; earlier ones stand.
  const write = store.write.bind(store); let writes = 0;
  store.write = (...args) => { if (++writes === 60) throw new Error('simulated disk fault'); return write(...args); };
  assert.throws(() => migrateStateLayout(store, { chunkBytes: 100000 }), /simulated disk fault/);
  store.write = write;
  const afterFault = moved();
  // 59 writes succeeded: 29 attempts and the 30th's intent. Without the rollback 30 intents would be stored.
  assert.ok(afterFault > 0 && afterFault < 29, `earlier transactions stand and the failed one left nothing behind (${afterFault} attempts moved)`);
  assert.equal(inline(), total - afterFault);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM records i WHERE i.kind=? AND NOT EXISTS (SELECT 1 FROM records a WHERE a.kind='attempt' AND a.id=i.id)").get(INTENT_KIND).count, 0);
  complete(); assert.equal(events(store, 'state.layout-migrated'), 0);
  store.close();

  // A real crash: the migrating process is killed in the middle of a later transaction.
  const crash = crashAt(f.stateDir, 'migrate', 'write:45');
  assert.equal(crash.signal, 'SIGKILL', crash.stderr);
  store = open(t, f.stateDir); // opening checks the database's integrity
  const afterCrash = moved();
  assert.ok(afterCrash > afterFault && afterCrash < total, `the crashed run moved more, not all (${afterFault} then ${afterCrash} of ${total})`);
  assert.equal(inline(), total - afterCrash); complete();

  // The next run finishes, and nothing differs from an uninterrupted migration.
  const result = migrateStateLayout(store, { chunkBytes: 100000 });
  assert.equal(result.movedIntents, total - afterCrash); assert.equal(stateLayout(store).current, true); assert.equal(moved(), total);
  complete(); for (const [id, data] of originals) assert.ok(data.includes(`"intent":${intentText(store, id)},"intentDigest"`));
  assert.equal(events(store, 'state.layout-migrated'), 1);
});

test('the project service migrates when it starts; the offline commands need it stopped', async t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 4, maintenance: 2, samples: 5 });
  assert.equal(layoutStatus(f.stateDir).inlineIntents, 18);
  const service = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'p.sock'), run: false });
  let closed = false; t.after(async () => { if (!closed) await service.close(); });
  assert.equal(stateLayout(service.store).current, true); assert.equal(events(service.store, 'state.layout-migrated'), 1);
  await assert.rejects(migrateLayout(f.stateDir), /runner is still running/); await assert.rejects(inlineLayout(f.stateDir), /runner is still running/);
  assert.equal(layoutStatus(f.stateDir).current, true, 'status is read-only and needs no lock');
  // A row still in the earlier layout (written before the fence, or by a tool that bypassed it) is read as it is, and moved at the next start.
  const late = releaseAttempt({ projectId: f.project.projectId, flowId: 'late-flow', intentBytes: 500 });
  service.store.db.prepare('INSERT INTO records VALUES(?,?,?)').run('attempt', late.id, JSON.stringify(late));
  assert.deepEqual(service.store.get('attempt', late.id), late); assert.deepEqual(service.store.by('attempt', 'flowId', 'late-flow'), [late]); assert.deepEqual(service.store.intent(late.id), late.intent);
  await service.close(); closed = true;
  assert.equal(layoutStatus(f.stateDir).inlineIntents, 1);
  const again = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'p.sock'), run: false });
  assert.equal(stateLayout(again.store).current, true); assert.deepEqual(again.store.get('attempt', late.id), late);
  assert.ok(!('intent' in again.store.by('attempt', 'flowId', 'late-flow')[0]));
  // Offline, with the runner stopped: inline everything, then migrate again.
  await again.close();
  const inlined = await inlineLayout(f.stateDir);
  assert.equal(inlined.status.inlineIntents, 19); assert.equal(inlined.status.layout, 'inline'); assert.equal(inlined.fenceRemoved, true); assert.equal(inlined.status.olderReleasesCanWrite, true);
  const migrated = await migrateLayout(f.stateDir);
  assert.equal(migrated.status.current, true); assert.equal(migrated.movedIntents, 19); assert.equal(migrated.status.olderReleasesCanWrite, false);
});

test('dispatch reads the intent in either layout, and a settled attempt is stored without it', async t => {
  const f = sandbox(t);
  assert.ok(layoutFenceIntact(f.store.db), 'a new project stores intents separately from the start');
  assert.equal(f.start().status, 'completed');
  await f.engine.tick();
  const prepared = f.store.all('attempt')[0]; assert.equal(prepared.status, 'prepared'); assert.equal(digest(prepared.intent), prepared.intentDigest);
  assert.ok(!('intent' in f.store.stored('attempt')[0]), 'a new attempt is stored without its intent');
  assert.deepEqual(f.store.intent(prepared.id), prepared.intent);
  // As the earlier release left a prepared attempt: the intent inline, no fence. This release
  // dispatches and settles it, and while the state is in that layout it writes the attempt inline.
  assert.equal(inlineAttemptIntents(f.store).layout, 'inline'); assert.ok('intent' in f.store.stored('attempt')[0]);
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  const settled = f.store.need('attempt', prepared.id);
  assert.equal(settled.status, 'passed'); assert.deepEqual(settled.intent, prepared.intent); assert.equal(settled.receipt.intentDigest, prepared.intentDigest);
  const file = JSON.parse(readFileSync(join(attemptDir(f.store, settled), 'intent.json'), 'utf8')), { intentDigest, ...written } = file;
  assert.equal(intentDigest, prepared.intentDigest); assert.equal(digest(written), prepared.intentDigest, 'the supervisor ran the retained intent');
  assert.deepEqual(f.store.stored('attempt')[0], settled, 'in the inline layout the settled attempt is stored whole'); assert.equal(f.store.count(INTENT_KIND), 0);
  const inspected = inspect(f.store, settled);
  // The migration moves it out; the effect inspector and every digest see the same attempt.
  assert.equal(migrateStateLayout(f.store).movedIntents, 1);
  assert.ok(!('intent' in f.store.stored('attempt')[0])); assert.deepEqual(f.store.need('attempt', prepared.id), settled);
  assert.deepEqual(inspect(f.store, f.store.need('attempt', prepared.id)), inspected); assert.equal(digest(f.store.intent(prepared.id)), prepared.intentDigest);
  // A second flow, prepared, dispatched and settled in the separate layout.
  f.command('task.put', { task: { id: 'task-2', title: 'Second fictional feature', acceptance: ['Observed'] } });
  f.command('task.approve', { taskId: 'task-2', revision: f.store.need('task', 'task-2').revision }); assert.equal(f.command('flow.start', { taskId: 'task-2', flowId: 'flow-2' }).status, 'completed');
  await until(() => f.store.need('flow', 'flow-2').state === 'completed', { tick: () => f.engine.tick() });
  const second = f.store.by('attempt', 'flowId', 'flow-2')[0]; assert.equal(second.status, 'passed'); assert.ok(!('intent' in second));
  assert.equal(digest(f.store.need('attempt', second.id).intent), second.intentDigest);
  // A changed intent is stored, never silently kept (reconciliation relies on reading what was last written).
  f.store.put('attempt', { ...settled, intent: { ...settled.intent, cwd: '/fictional/elsewhere' } });
  assert.equal(f.store.need('attempt', settled.id).intent.cwd, '/fictional/elsewhere'); assert.notEqual(digest(f.store.need('attempt', settled.id).intent), settled.intentDigest);
  // A record put without an intent (as the targeted reads return it) leaves the stored intent alone.
  f.store.put('attempt', { ...f.store.stored('attempt')[0], note: 'fictional' });
  assert.equal(f.store.need('attempt', settled.id).intent.cwd, '/fictional/elsewhere'); assert.equal(f.store.need('attempt', settled.id).note, 'fictional');
});

test('history views attribute model steps and recover the original task from intents in either layout', t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 3, maintenance: 1, samples: 0 });
  const store = open(t, f.stateDir), projectId = f.project.projectId, nowMs = Date.now(), raw = (kind, row) => store.db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind, row.id, JSON.stringify(row));
  // A flow from before task snapshots: its brief survives only in the attempts' intents.
  const old = { id: 'old-flow', taskId: 'old-task', taskRevision: 'rev-old', kind: 'change', state: 'completed', workflow: store.meta('workflow'), createdAt: new Date(nowMs - 7200000).toISOString(), finishedAt: new Date(nowMs - 3600000).toISOString(), results: {}, visits: {} };
  raw('flow', old);
  const task = { id: 'old-task', revision: 'rev-old', acceptance: ['Recovered from the retained intent'] };
  // A reviewer step that failed before any invocation was recorded: only its intent names the route.
  const failed = releaseAttempt({ projectId, flowId: 'old-flow', step: 'review', operation: 'provider.review', status: 'failed', at: nowMs - 5000000, action: { task, config: { providers: { reviewer: { provider: 'codex', model: 'fictional-reviewer' } } } } });
  delete failed.receipt.actionResult; raw('attempt', failed);
  raw('attempt', releaseAttempt({ projectId, flowId: 'old-flow', step: 'gate', operation: 'gate', at: nowMs - 4000000, action: { task } }));
  const read = () => ({ stats: projectStats(store, { window: '7d', nowMs }), retrospective: retrospective(store, { flowId: 'old-flow' }), operations: (operation => store.stored('attempt').map(attempt => [attempt.id, operation(attempt.id)]).filter(([, found]) => found !== undefined))(attemptOperations(store)) });
  const inline = read();
  assert.match(JSON.stringify(inline.retrospective), /Recovered from the retained intent/);
  assert.match(JSON.stringify(inline.stats), /fictional-reviewer/, 'the failed review is attributed to the route in its intent');
  assert.deepEqual(inline.operations, [], 'nothing is stored separately yet');
  migrateStateLayout(store);
  const moved = read();
  assert.deepEqual(moved.stats, inline.stats); assert.deepEqual(moved.retrospective, inline.retrospective);
  assert.equal(new Map(moved.operations).get(failed.id), 'provider.review'); assert.equal(moved.operations.length, store.count('attempt'));
});

test('retention and backup still see what only an intent cites', t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 2, maintenance: 0, samples: 0 });
  const artifactRoot = join(f.base, 'artifacts'); mkdirSync(artifactRoot);
  for (const name of ['cited.log', 'loose.log']) writeFileSync(join(artifactRoot, name), `${name}\n`);
  let store = open(t, f.stateDir);
  const cites = releaseAttempt({ projectId: f.project.projectId, flowId: 'cites', action: { evidence: join(artifactRoot, 'cited.log') } });
  store.db.prepare('INSERT INTO records VALUES(?,?,?)').run('attempt', cites.id, JSON.stringify(cites));
  const plan = () => retentionPlan(store, { artifactRoot, candidates: ['cited.log', 'loose.log'], preservation: () => ({ complete: true, protectedPaths: [] }) }).deletions.map(file => file.path.slice(artifactRoot.length + 1));
  assert.deepEqual(plan(), ['loose.log'], 'inline: the cited file is protected');
  migrateStateLayout(store);
  assert.ok(!attemptRows(store).get(cites.id).includes('cited.log'), 'the citation now lives only in the separate intent');
  assert.deepEqual(plan(), ['loose.log'], 'separate: the cited file is still protected');
  // A backup carries the separate intents, and a restore reads every attempt complete.
  const complete = store.all('attempt'); store.close();
  backupProject(f.stateDir, join(f.base, 'backup')); restoreProject(join(f.base, 'backup'), join(f.base, 'restored'));
  store = open(t, join(f.base, 'restored'));
  assert.deepEqual(store.all('attempt'), complete); assert.equal(store.count(INTENT_KIND), complete.length); assert.equal(stateLayout(store).current, true);
});

// Each targeted read answers exactly what the whole-kind read it replaced answered. The
// filters below are the ones at the call sites; odd values (missing, null, empty, wrong type)
// are in every set.
test('targeted reads return exactly the rows the whole-kind filters returned, in the same order', t => {
  const f = sandbox(t), store = f.store, odd = [undefined, null, '', 0, false];
  const put = (kind, rows) => rows.forEach((row, i) => store.put(kind, { id: `${kind}-${i}`, ...Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)) }));
  const cross = (...lists) => lists.reduce((rows, [key, values]) => rows.flatMap(row => values.map(value => ({ ...row, [key]: value }))), [{}]);
  const iso = offset => new Date(Date.now() + offset).toISOString();
  put('flow', cross(['state', ['running', 'waiting', 'stopped', 'ready', 'completed', 'failed', ...odd]], ['finishedAt', [iso(-1000), ...odd]], ['cleanupPending', [true, false, undefined, null]], ['kind', ['change', 'maintenance', 'task']]).map((row, i) => ({ ...row, taskId: `t${i % 7}`, attemptId: i % 3 ? null : 'a', workspace: i % 2 ? { manifestPath: '/fictional' } : undefined, createdAt: iso(-i * 1000) })));
  put('attempt', cross(['status', ['prepared', 'dispatching', 'launching', 'running', 'uncertain', 'passed', 'failed', 'aborted', 'not-dispatched', 'completed', ...odd]], ['settledAt', [iso(-500), ...odd]], ['costMicros', [undefined, 0, 250, null]]).map((row, i) => ({ ...row, flowId: `flow-${i % 9}`, reservedMicros: i % 4 ? 10 : undefined, launchStalled: i % 5 ? undefined : { since: iso(-9000), supervisorPid: 1 } })));
  put('task', cross(['closed', [true, ...odd]], ['status', ['completed', 'open', ...odd]], ['approvalKind', ['schedule', 'job', undefined, 'other']], ['notBefore', [iso(60000), undefined]]).map((row, i) => ({ ...row, revision: 'r', approvedRevision: i % 2 ? 'r' : null, blocked: i % 11 === 0, tracked: i % 13 === 0 })));
  store.put('task', { id: 'job:fictional', title: 'maintenance by id' }); store.put('task', { id: 'JOB:not-maintenance', title: 'only the exact prefix marks maintenance' });
  put('inbox', cross(['status', ['open', 'answered', 'expired', 'acknowledged', 'superseded', 'resolved', ...odd]], ['kind', ['question', 'notice']], ['standalone', [true, undefined]], ['version', [1, 2, undefined]]).map((row, i) => ({ ...row, flowId: i % 3 ? `flow-${i % 9}` : undefined, expiresAt: iso(i % 2 ? -1000 : 60000), createdAt: iso(-i * 3600000) })));
  put('job', cross(['status', ['queued', 'running', 'completed', 'failed', 'revoked', ...odd]], ['operation', ['main.verify', 'queue.dispatch', 'target.sync', 'machine.sample']], ['scheduleId', ['s1', 's2', undefined, null]]).map((row, i) => ({ ...row, createdAt: iso(-(i % 6) * 60000), flowId: i % 2 ? 'x' : undefined, payload: i % 3 ? {} : { from: 'main', into: 'next', target: 'next' } })));
  put('queue', cross(['status', ['queued', 'claimed', 'finished', 'removed', ...odd]], ['flowId', ['flow-1', undefined]]).map((row, i) => ({ ...row, order: i, claimedAt: iso(-i * 7200000) })));
  put('wait', cross(['endedAt', [iso(-100), ...odd]], ['kind', ['timer', 'question', 'heavy-resource']]).map((row, i) => ({ ...row, flowId: `flow-${i % 9}` })));
  put('obligation', cross(['status', ['pending', 'passed', 'failed', 'deferred', ...odd]], ['requiresAuthorization', [true, false, undefined]]).map((row, i) => ({ ...row, flowId: `flow-${i % 9}` })));
  put('finding', cross(['status', ['unapproved', 'approved', ...odd]]));
  put('delivery', cross(['status', ['pending', 'sending', 'accepted', 'delivered', 'suppressed', 'superseded', ...odd]], ['channel', ['operator', 'orchestrator']]).map((row, i) => ({ ...row, inboxId: `inbox-${i % 5}`, inboxVersion: i % 3, nextAt: iso(i % 2 ? -1 : 60000) })));
  put('occurrence', cross(['scheduleId', ['s1', 's2']], ['at', [iso(-3000), iso(-2000), iso(-2000), undefined]]));
  for (const kind of ['context', 'pushback', 'regression']) put(kind, cross(['flowId', ['flow-1', 'flow-2', undefined, null]], ['n', [1, 2]]));

  const terminal = flow => ['completed', 'failed'].includes(flow.state), settled4 = ['passed', 'failed', 'not-dispatched', 'aborted'];
  const filters = {
    flow: [f => !terminal(f), f => terminal(f) && !f.finishedAt, f => f.state === 'completed' && f.cleanupPending && f.workspace?.manifestPath, f => !terminal(f) && !['planning', 'maintenance'].includes(f.kind), f => f.kind === 'maintenance' && !terminal(f), f => !['completed', 'failed', 'stopped'].includes(f.state), f => !terminal(f) && !f.modelRoutes, f => f.kind === 'change' && !terminal(f), f => !['stopped', 'failed', 'completed'].includes(f.state)],
    attempt: [a => !a.settledAt, a => !(a.settledAt || settled4.includes(a.status)), a => ['prepared', 'dispatching', 'running', 'uncertain'].includes(a.status), a => !['passed', 'failed', 'aborted', 'not-dispatched', 'completed'].includes(a.status), a => a.launchStalled && a.status === 'dispatching' && !a.settledAt, a => ['uncertain', 'prepared', 'dispatching', 'running'].includes(a.status), a => a.settledAt == null],
    task: [t => !isMaintenanceTask(t) && needsApproval(t), t => t.notBefore && !t.closed && t.status !== 'completed' && !isMaintenanceTask(t)],
    inbox: [q => q.status === 'open', q => q.standalone && q.kind === 'question' && q.status === 'open' && Date.parse(q.expiresAt) <= Date.now(), q => q.flowId && q.kind === 'question' && q.status === 'open'],
    job: [j => j.status === 'queued', j => j.status === 'running' && j.flowId, j => j.operation === 'main.verify' && ['queued', 'running'].includes(j.status), j => j.operation === 'target.sync' && ['queued', 'running'].includes(j.status) && j.payload?.from === 'main'],
    queue: [q => q.status === 'queued', q => q.status === 'claimed' && q.flowId, q => ['queued', 'claimed'].includes(q.status)],
    wait: [w => !w.endedAt, w => w.kind === 'timer' && !w.endedAt],
    obligation: [o => !['passed', 'failed', 'deferred'].includes(o.status), o => !['passed', 'failed', 'deferred'].includes(o.status) && o.requiresAuthorization === true],
    finding: [x => x.status === 'unapproved'],
    delivery: [d => ['pending', 'sending', 'accepted'].includes(d.status), d => ['pending', 'sending', 'accepted'].includes(d.status) && Date.parse(d.nextAt) <= Date.now()],
  };
  assert.deepEqual(Object.keys(filters).sort(), Object.keys(LIVE).sort(), 'every live set is checked');
  for (const [kind, list] of Object.entries(filters)) {
    const all = store.all(kind), live = store.live(kind);
    assert.ok(live.length < all.length, `${kind}: the live set leaves settled rows out`);
    list.forEach((filter, i) => { const expected = all.filter(filter); assert.ok(expected.length > 0, `${kind} filter ${i} selects something`); assert.deepEqual(live.filter(filter), expected, `${kind} filter ${i}`); });
  }
  // Lookups by a referenced field, most recent rows, counts.
  for (const [kind, name, values] of [['attempt', 'flowId', ['flow-1', 'flow-8', 'none']], ['inbox', 'flowId', ['flow-2']], ['wait', 'flowId', ['flow-3']], ['obligation', 'flowId', ['flow-4']], ['context', 'flowId', ['flow-1']], ['pushback', 'flowId', ['flow-2']], ['regression', 'flowId', ['flow-1']], ['flow', 'taskId', ['t0', 't6', 'none']], ['delivery', 'inboxId', ['inbox-0', 'inbox-4']], ['job', 'operation', ['main.verify', 'queue.dispatch']]])
    for (const value of values) assert.deepEqual(store.by(kind, name, value), store.all(kind).filter(row => row[name] === value), `${kind} by ${name} ${value}`);
  assert.throws(() => store.by('task', 'flowId', 'x'), /no flowId lookup is defined for task/); assert.throws(() => store.live('schedule'), /no live set/);
  for (const kind of ['flow', 'attempt', 'inbox', 'wait']) { assert.deepEqual(store.recent(kind, 7), store.stored(kind).slice(-7)); assert.equal(store.count(kind), store.stored(kind).length); }
  assert.deepEqual(store.all('flow'), store.stored('flow'));
  // Totals and latest-of answers.
  assert.equal(attemptCostMicros(store), store.all('attempt').reduce((sum, a) => sum + (a.costMicros ?? 0), 0)); assert.ok(attemptCostMicros(store) > 0);
  const projectTasks = store.all('task').filter(task => !isMaintenanceTask(task));
  assert.equal(projectTaskCount(store), projectTasks.length); assert.ok(projectTasks.some(task => task.id === 'JOB:not-maintenance')); assert.deepEqual(recentProjectTasks(store, 9), projectTasks.slice(-9));
  for (const schedule of [{ id: 's1', operation: 'main.verify' }, { id: 's2', operation: 'machine.sample', source: 'config' }, { id: 's1', operation: 'queue.dispatch', source: 'config' }, { id: 'none', operation: 'target.sync', source: 'config' }, { id: 'none' }]) {
    const jobs = store.all('job').filter(job => job.scheduleId === schedule.id || schedule.source === 'config' && !job.scheduleId && job.operation === schedule.operation).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    assert.deepEqual(scheduleRuns(store, schedule), { runs: jobs.length, last: jobs.at(-1) ?? null }, `schedule ${JSON.stringify(schedule)}`);
  }
  for (const operation of ['queue.dispatch', 'main.verify', 'none']) assert.deepEqual(latestJob(store, operation), store.all('job').filter(job => job.operation === operation).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null);
  for (const scheduleId of ['s1', 's2', 'none']) assert.deepEqual(lastOccurrence(store, scheduleId), store.all('occurrence').filter(o => o.scheduleId === scheduleId).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) ?? null);
  const NOTIFYING = ['open', 'answered', 'expired', 'acknowledged', 'superseded'];
  assert.deepEqual(inboxVersions(store, NOTIFYING).map(row => [row.id, row.version ?? undefined]), store.all('inbox').filter(q => NOTIFYING.includes(q.status)).map(q => [q.id, q.version]));
  // Windowed candidates contain every row the exact window filter keeps.
  const from = Date.now() - 6 * 3600000, since = new Date(from - 86400000).toISOString(), ids = rows => rows.map(row => row.id);
  const flowEnd = flow => Date.parse(flow.finishedAt ?? flow.abandonedAt) || (terminal(flow) ? Date.parse(flow.createdAt) : Date.now()), inWindow = flow => Number.isFinite(Date.parse(flow.createdAt)) && Date.parse(flow.createdAt) < Date.now() && flowEnd(flow) > from;
  assert.deepEqual(ids(flowsSince(store, since).filter(inWindow)), ids(store.all('flow').filter(inWindow)));
  const asked = q => q.kind === 'question' && Date.parse(q.createdAt) >= from && Date.parse(q.createdAt) <= Date.now();
  assert.deepEqual(ids(inboxSince(store, since).filter(asked)), ids(store.all('inbox').filter(asked))); assert.ok(inboxSince(store, since).length < store.count('inbox'));

  // Every targeted read is answered by the index written for it, never by reading the kind.
  const plan = sql => store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(step => step.detail).join(' | '), prepared = [];
  const prepare = store.db.prepare.bind(store.db); store.db.prepare = sql => { prepared.push(sql); return prepare(sql); };
  for (const kind of Object.keys(LIVE)) store.live(kind);
  store.by('attempt', 'flowId', 'x'); store.by('flow', 'taskId', 'x'); store.by('delivery', 'inboxId', 'x'); store.by('job', 'operation', 'x');
  attemptCostMicros(store); projectTaskCount(store); recentProjectTasks(store, 5); scheduleRuns(store, { id: 's1', operation: 'main.verify', source: 'config' }); latestJob(store, 'x'); lastOccurrence(store, 'x'); flowsSince(store, since); inboxSince(store, since); inboxVersions(store, NOTIFYING); attemptOperations(store);
  store.db.prepare = prepare;
  const reads = prepared.filter(sql => /FROM records/.test(sql));
  assert.ok(reads.length >= 25);
  for (const sql of reads) { const steps = plan(sql); assert.ok(/INDEXED BY records_/.test(sql), `no index named in: ${sql}`); assert.ok(!/SCAN records|USING (COVERING )?INDEX (records_kind|sqlite_autoindex_records_1) \(kind=\?\)/.test(steps), `${sql}\n  reads a whole kind: ${steps}`); }
  assert.match(plan(reads.find(sql => /records_attempt_cost/.test(sql))), /COVERING INDEX records_attempt_cost/, 'the budget total reads index entries only');
  assert.match(plan(reads.find(sql => /records_inbox_version/.test(sql))), /COVERING INDEX records_inbox_version/); assert.match(plan(reads.find(sql => /records_intent_operation/.test(sql))), /COVERING INDEX records_intent_operation/);
});

// (Attempts as stored: before the migration the earlier release's rows still carry their intent, which is left out of the comparison.)
// A live set that is not verified is the whole kind; callers filter it. One call-site filter per kind.
const USED = { flow: f => !['completed', 'failed'].includes(f.state), attempt: a => !a.settledAt, task: t => !isMaintenanceTask(t) && needsApproval(t), inbox: q => q.status === 'open', job: j => ['queued', 'running'].includes(j.status), queue: q => ['queued', 'claimed'].includes(q.status), wait: w => !w.endedAt, obligation: o => !['passed', 'failed', 'deferred'].includes(o.status), finding: x => x.status === 'unapproved', delivery: d => ['pending', 'sending', 'accepted'].includes(d.status) };
test('a database without the indexes answers every targeted read the same, only without them', t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 6, maintenance: 4, samples: 3 });
  const store = open(t, f.stateDir), read = () => JSON.stringify([Object.keys(LIVE).map(kind => store.live(kind).filter(USED[kind])), store.by('attempt', 'flowId', store.stored('flow')[0].id), store.recent('attempt', 3), store.count('flow'), attemptCostMicros(store), projectTaskCount(store), recentProjectTasks(store, 3), latestJob(store, 'main.verify'), dashboardSnapshot(store)].map(value => JSON.parse(JSON.stringify(value, (key, x) => ['revision', 'events', 'intent'].includes(key) ? undefined : x))));
  assert.equal(store.hint('records_live_flow'), ''); assert.equal(store.verified('flow'), false); assert.equal(store.live('flow').length, store.count('flow'), 'unverified: the whole kind, parsed in JavaScript');
  const before = read();
  migrateStateLayout(store); assert.equal(store.verified('flow'), true); assert.equal(store.live('flow').length, 0);
  assert.equal(store.hint('records_live_flow'), 'INDEXED BY records_live_flow'); assert.equal(read(), before);
  // An index whose definition is not this release's is not named, and the next migration rebuilds it.
  store.db.exec("DROP INDEX records_live_flow; CREATE INDEX records_live_flow ON records(kind) WHERE kind='flow'");
  assert.equal(store.hint('records_live_flow'), ''); assert.equal(store.verified('flow'), false); assert.equal(read(), before); assert.deepEqual(stateLayout(store).missingIndexes, ['records_live_flow']);
  assert.deepEqual(migrateStateLayout(store).indexes, ['records_live_flow']); assert.equal(store.hint('records_live_flow'), 'INDEXED BY records_live_flow');
});

// Review fixes. The earlier release's actual runtime (reference commit 93395cf), extracted from
// repository history. Without the history (a source archive, a shallow clone) the checks that
// need it are skipped visibly; nothing weaker is silently substituted.
const EARLIER = '93395cf';
async function earlierRuntime(base) {
  const dir = join(base, 'earlier-runtime'); mkdirSync(dir, { recursive: true });
  try { execFileSync('sh', ['-c', `git archive ${EARLIER} starter/factory | tar -x -C "$1"`, 'sh', dir], { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'pipe' }); }
  catch (error) { return { skip: `the earlier runtime ${EARLIER} is not in this checkout's git history (${String(error.stderr || error.message).trim().split('\n')[0]})` }; }
  const load = path => import(pathToFileURL(join(dir, 'starter/factory', path)).href);
  return { Store: (await load('core/store.mjs')).Store, Engine: (await load('core/engine.mjs')).Engine, inspect: (await load('core/effects.mjs')).inspect, executeCommand: (await load('core/project.mjs')).executeCommand };
}
const FENCED = /no such function: factotum_attempt_intent_layout/;

test('unusual but valid JSON survives the migration and the way back byte for byte; what cannot be moved losslessly is refused untouched', t => {
  const f = releaseFormatState(t), store = open(t, f.stateDir), rows = store.db.prepare("SELECT id, data FROM records WHERE kind='attempt' ORDER BY rowid").all();
  // The reviewer's inputs: an escape, an exponent and an integer beyond 2^53, with intent as the first key.
  const exact = '{"unicode":"\\u263a","number":1e3,"big":9007199254740993}', a = JSON.parse(rows[0].data);
  const rest = JSON.stringify({ ...a, intent: undefined }), unusual = rest.replace('"id":', `"intent":${exact},"id":`);
  assert.ok(unusual.startsWith(`{"intent":${exact},"id":`)); assert.notEqual(JSON.stringify(JSON.parse(unusual)), unusual, 'parsing and reserialising this record changes it');
  store.write('attempt', a.id, unusual);
  // A record no cut can take apart unambiguously: two intent fields.
  const twice = rows[1].data.replace('"intentDigest"', '"intent":{"second":true},"intentDigest"'), twiceId = rows[1].id;
  store.write('attempt', twiceId, twice);
  const before = store.get('attempt', a.id), intentDigest = digest(before.intent), receiptCheck = before.receipt.intentDigest === before.intentDigest;

  const result = migrateStateLayout(store);
  assert.equal(result.movedIntents, 5); assert.deepEqual(result.refused, [{ attemptId: twiceId, reason: 'the record has more than one intent field' }]);
  assert.equal(attemptRows(store).get(twiceId), twice, 'the refused record is untouched');
  assert.deepEqual(store.db.prepare("SELECT payload FROM events WHERE type='state.layout-migrated'").all().map(row => JSON.parse(row.payload).refused), [result.refused]);
  const status = stateLayout(store); assert.equal(status.current, false); assert.equal(status.inlineIntents, 1); assert.deepEqual(status.inlineAttempts, [twiceId]);
  // Its two intent fields also make the attempt kind one SQL may not read as JSON: no attempt index, and reads of attempts parse them.
  const unverifiedKinds = { attempt: [{ id: twiceId, reason: 'the record has two fields of one name in an object' }] };
  assert.deepEqual(result.unverifiedKinds, unverifiedKinds); assert.deepEqual(status.unverifiedKinds, unverifiedKinds); assert.equal(store.verified('attempt'), false); assert.equal(store.verified('flow'), true);
  assert.deepEqual(status.missingIndexes, ['records_live_attempt', 'records_flow_ref', 'records_attempt_cost']);
  assert.deepEqual(migrateStateLayout(store), { changed: false, movedIntents: 0, refused: result.refused, unverifiedKinds, indexes: [] }, 'a later run refuses it again and changes nothing');
  // Stored exactly as written: nothing was parsed and written back.
  assert.equal(intentText(store, a.id), exact); assert.equal(attemptRows(store).get(a.id), rest, 'the attempt record is the original text with exactly the member cut out');
  // Every digest and check over the intent sees the same value as before.
  const after = store.get('attempt', a.id);
  assert.deepEqual(after, before); assert.equal(digest(after.intent), intentDigest); assert.equal(digest(store.intent(a.id)), intentDigest); assert.equal(after.receipt.intentDigest === after.intentDigest, receiptCheck);
  assert.equal(digest(store.all('attempt').find(row => row.id === a.id).intent), intentDigest);

  // The way back restores the record's original text, position and spelling included.
  const inlined = inlineAttemptIntents(store);
  assert.equal(inlined.restoredIntents, 5); assert.equal(inlined.fenceRemoved, true); assert.equal(inlined.refused, undefined);
  assert.equal(attemptRows(store).get(a.id), unusual, 'byte for byte'); assert.equal(attemptRows(store).get(twiceId), twice);
  for (const row of rows.slice(2)) assert.equal(attemptRows(store).get(row.id), row.data);
  assert.equal(digest(store.get('attempt', a.id).intent), intentDigest);

  // Once this runtime has rewritten the attempt there is no earlier text to return to. The intent's
  // bytes are still kept (an unchanged intent is not rewritten) and go back where this runtime writes it.
  migrateStateLayout(store);
  store.put('attempt', { ...store.get('attempt', a.id), note: 'rewritten by this runtime' });
  assert.equal(intentText(store, a.id), exact, 'a put with the same intent value keeps the stored text');
  inlineAttemptIntents(store);
  const rewritten = attemptRows(store).get(a.id);
  assert.ok(rewritten.includes(`"intent":${exact},"intentDigest"`)); assert.equal(JSON.parse(rewritten).note, 'rewritten by this runtime'); assert.equal(digest(JSON.parse(rewritten).intent), intentDigest);
});

test('detection parses the record: an intent spelled with spacing is found, moved and restored', t => {
  const f = releaseFormatState(t), store = open(t, f.stateDir), row = store.db.prepare("SELECT id, data FROM records WHERE kind='attempt' LIMIT 1").get();
  const spaced = row.data.replace('"intent":', '"intent" :\n  '); assert.ok(!spaced.includes('"intent":'));
  store.write('attempt', row.id, spaced);
  assert.equal(stateLayout(store).inlineIntents, 6);
  assert.equal(migrateStateLayout(store).movedIntents, 6);
  const status = stateLayout(store); assert.equal(status.current, true); assert.equal(status.inlineIntents, 0);
  assert.equal(store.db.prepare("SELECT json_type(data,'$.intent') AS type FROM records WHERE kind='attempt' AND id=?").get(row.id).type, null);
  assert.deepEqual(store.get('attempt', row.id), JSON.parse(row.data));
  inlineAttemptIntents(store); assert.equal(attemptRows(store).get(row.id), spaced);
  // A null intent is an intent member like any other: found, moved and read back as null.
  const nothing = '{"id":"null-intent","flowId":"x","intent":null,"status":"passed"}';
  store.write('attempt', 'null-intent', nothing);
  assert.equal(stateLayout(store).inlineIntents, 7); assert.equal(store.get('attempt', 'null-intent').intent, null); assert.equal(store.intent('null-intent'), null);
  assert.equal(migrateStateLayout(store).movedIntents, 7); assert.equal(stateLayout(store).current, true);
  assert.equal(attemptRows(store).get('null-intent'), '{"id":"null-intent","flowId":"x","status":"passed"}'); assert.equal(intentText(store, 'null-intent'), 'null');
  assert.deepEqual(store.get('attempt', 'null-intent'), JSON.parse(nothing)); assert.equal(store.intent('null-intent'), null); assert.equal(store.intent('no-such-attempt'), undefined);
  // Written by this runtime in the separate layout, a null intent is stored apart too, and the state stays current.
  store.put('attempt', { id: 'null-put', flowId: 'x', intent: null, status: 'passed' });
  assert.equal(attemptRows(store).get('null-put'), '{"id":"null-put","flowId":"x","status":"passed"}'); assert.equal(store.get('attempt', 'null-put').intent, null); assert.equal(stateLayout(store).current, true);
  inlineAttemptIntents(store); assert.equal(attemptRows(store).get('null-intent'), nothing); assert.equal(attemptRows(store).get(row.id), spaced);
});

// Round 2 of the review. SQLite's JSON functions read the first of several members with one
// name and JSON.parse the last, so nothing that decides or reads an attempt's intent may go
// through them. The first two records are the reviewer's.
test('duplicate intent members: every reader returns what JSON.parse returns, and they are found, refused and counted', t => {
  const f = releaseFormatState(t), store = open(t, f.stateDir);
  const odd = {
    twice: '{"id":"twice","flowId":"odd","intent":{"chosen":"first"},"intent":{"chosen":"last"}}',
    'null-first': '{"id":"null-first","flowId":"odd","intent":null,"intent":{"chosen":"last"}}',
    'last-null': '{"id":"last-null","flowId":"odd","intent":{"chosen":"first"},"intent":null}',
    // One member, its key spelled with an escape: JSON.parse reads it as intent, and it can be moved.
    escaped: '{"id":"escaped","flowId":"odd","\\u0069ntent":{"chosen":"escaped"},"intentDigest":"d"}',
    // No intent member of its own, though the word appears: not an inline intent.
    nested: '{"id":"nested","flowId":"odd","receipt":{"intent":{"chosen":"nested"},"text":"\\u263a \\"intent\\""}}',
  };
  for (const [id, text] of Object.entries(odd)) store.write('attempt', id, text);
  assert.deepEqual(Object.values(odd).map(text => JSON.parse(text).intent), [{ chosen: 'last' }, { chosen: 'last' }, null, { chosen: 'escaped' }, undefined]);
  const duplicates = ['twice', 'null-first', 'last-null'], refusal = duplicates.map(id => ({ attemptId: id, reason: 'the record has more than one intent field' }));
  const agree = when => {
    for (const [id, text] of Object.entries(odd)) {
      const expected = JSON.parse(text).intent, pick = rows => rows.find(row => row.id === id).intent;
      for (const [name, intent] of [['get', store.get('attempt', id).intent], ['need', store.need('attempt', id).intent], ['intent', store.intent(id)], ['all', pick(store.all('attempt'))], ['by', pick(store.by('attempt', 'flowId', 'odd'))], ['live', pick(store.live('attempt'))], ['stored', pick(store.stored('attempt'))], ['recent', pick(store.recent('attempt', 50))]])
        if (id === 'escaped' && when !== 'inline' && ['by', 'live', 'stored', 'recent'].includes(name)) assert.equal(intent, undefined, `${when}: ${name} returns ${id} as stored, without its moved intent`);
        else assert.deepEqual(intent, expected, `${when}: ${name} of ${id}`);
    }
  };
  // Inline layout: every reader agrees with JSON.parse; status finds all four members and says which cannot be moved.
  agree('inline');
  let status = stateLayout(store);
  assert.equal(status.inlineIntents, 10); assert.deepEqual(status.unmovable, refusal); assert.equal(status.current, false);
  const result = migrateStateLayout(store);
  assert.equal(result.movedIntents, 7, 'the six of the fixture and the escaped one'); assert.deepEqual(result.refused, refusal);
  for (const id of [...duplicates, 'nested']) assert.equal(attemptRows(store).get(id), odd[id], `${id} is untouched`);
  assert.equal(attemptRows(store).get('escaped'), '{"id":"escaped","flowId":"odd","intentDigest":"d"}'); assert.equal(intentText(store, 'escaped'), '{"chosen":"escaped"}');
  // Only duplicates are left inline: the state is not current, and they are named.
  status = stateLayout(store);
  assert.equal(status.inlineIntents, 3); assert.deepEqual(status.inlineAttempts, duplicates); assert.deepEqual(status.unmovable, refusal); assert.equal(status.current, false);
  const unverifiedKinds = { attempt: duplicates.map(id => ({ id, reason: 'the record has two fields of one name in an object' })) };
  assert.deepEqual(status.unverifiedKinds, unverifiedKinds); assert.deepEqual(status.missingIndexes, ['records_live_attempt', 'records_flow_ref', 'records_attempt_cost']);
  assert.deepEqual(migrateStateLayout(store), { changed: false, movedIntents: 0, refused: refusal, unverifiedKinds, indexes: [] });
  agree('separate');
  // A separate record for an attempt that has an intent member of its own is never its intent, null member included.
  for (const id of duplicates) store.write(INTENT_KIND, id, `{"id":${JSON.stringify(id)},"intent":{"chosen":"separate"}}`);
  agree('separate, with stale separate records');
  // The way back: the moved one gets its text back exactly, the stale records go, the duplicates stay as they were.
  const inlined = inlineAttemptIntents(store);
  assert.equal(inlined.fenceRemoved, true); assert.equal(inlined.refused, undefined); assert.equal(store.count(INTENT_KIND), 0);
  for (const [id, text] of Object.entries(odd)) assert.equal(attemptRows(store).get(id), text, `${id} is its original text`);
  agree('inline');
});

// Round 3 of the review. The same disagreement one level down: SQL reading a field of a record
// (an index key, a predicate, a projection) takes the first of two members of one name, JSON.parse
// the last. The first intent below is the reviewer's.
test('an intent with two fields of one name is refused, and statistics are the same before and after migration', t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 2, maintenance: 1, samples: 0 });
  const store = open(t, f.stateDir), projectId = f.project.projectId, nowMs = Date.now(), raw = (kind, id, text) => store.db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind, id, text);
  raw('flow', 'review-flow', JSON.stringify({ id: 'review-flow', taskId: 'review-task', taskRevision: 'r', kind: 'change', state: 'completed', workflow: store.meta('workflow'), createdAt: new Date(nowMs - 7200000).toISOString(), finishedAt: new Date(nowMs - 3600000).toISOString(), results: {}, visits: {} }));
  // A settled attempt whose receipt records no provider invocation: only its intent says what ran and on which route.
  const withIntent = (step, intent, at) => { const attempt = releaseAttempt({ projectId, flowId: 'review-flow', step, operation: 'gate', status: 'failed', at }); delete attempt.receipt.actionResult; const text = JSON.stringify({ ...attempt, intent: undefined }).replace('"intentDigest"', `"intent":${intent},"intentDigest"`); raw('attempt', attempt.id, text); return { id: attempt.id, text }; };
  const first = withIntent('review', '{"action":{"operation":"gate","operation":"provider.review","config":{"providers":{"reviewer":{"provider":"codex","model":"fictional-reviewer"}}}}}', nowMs - 5000000);
  // The same three levels further down: the route's model is given twice.
  const deep = withIntent('delta-review', '{"action":{"operation":"provider.review","config":{"providers":{"reviewer":{"provider":"codex","model":"fictional-first","model":"fictional-nested"}}}}}', nowMs - 4000000);
  for (const { id, text } of [first, deep]) assert.deepEqual(store.intent(id), JSON.parse(text).intent);
  assert.equal(store.intent(first.id).action.operation, 'provider.review', 'JSON.parse reads the last');
  assert.equal(store.db.prepare("SELECT json_extract(data,'$.intent.action.operation') AS operation FROM records WHERE kind='attempt' AND id=?").get(first.id).operation, 'gate', 'SQLite reads the first');
  const stats = () => projectStats(store, { window: '7d', nowMs }), before = stats();
  assert.match(JSON.stringify(before), /fictional-reviewer/); assert.match(JSON.stringify(before), /fictional-nested/); assert.doesNotMatch(JSON.stringify(before), /fictional-first/);

  const result = migrateStateLayout(store), refusal = [first, deep].map(({ id }) => ({ attemptId: id, reason: 'the intent has two fields of one name in an object' }));
  assert.deepEqual(result.refused, refusal); assert.equal(result.movedIntents, 9);
  for (const { id, text } of [first, deep]) { assert.equal(attemptRows(store).get(id), text, 'refused untouched'); assert.deepEqual(store.intent(id), JSON.parse(text).intent); assert.equal(attemptOperations(store)(id), undefined, 'no separate intent, so nothing for an index to misread'); }
  const status = stateLayout(store);
  assert.equal(status.current, false); assert.equal(status.inlineIntents, 2); assert.deepEqual(status.unmovable, refusal); assert.deepEqual(Object.keys(status.unverifiedKinds), ['attempt']);
  assert.deepEqual(stats(), before, 'accounting, the reviewer model and the review and gate metrics are unchanged');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM records WHERE kind=? AND (data LIKE '%fictional-reviewer%' OR data LIKE '%fictional-nested%')").get(INTENT_KIND).n, 0);
  // Every separate intent that exists was written from a text checked for this.
  assert.equal(store.verified(INTENT_KIND), true); assert.equal(store.count(INTENT_KIND), 9);
});

test('a kind with a duplicated field is read in JavaScript and not indexed until it is repaired', t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 3, maintenance: 3, samples: 0 });
  const store = open(t, f.stateDir), projectId = f.project.projectId, nowMs = Date.now(), raw = (kind, id, text) => store.db.prepare('INSERT INTO records VALUES(?,?,?)').run(kind, id, text);
  // A flow SQL reads as completed and JSON.parse as running; a job SQL reads as a queued sample and JSON.parse as a finished dispatch.
  const flowText = JSON.stringify({ ...store.stored('flow')[0], id: 'twice-flow', taskId: 'twice-task', results: {} }).replace('"state":"completed"', '"state":"completed","state":"running"');
  const jobText = `{"id":"twice-job","operation":"machine.sample","operation":"queue.dispatch","status":"queued","status":"completed","outcome":"dispatched","createdAt":${JSON.stringify(new Date(nowMs).toISOString())}}`;
  raw('flow', 'twice-flow', flowText); raw('job', 'twice-job', jobText);
  assert.equal(JSON.parse(flowText).state, 'running'); assert.equal(JSON.parse(jobText).operation, 'queue.dispatch');
  // An intent record written from outside, with its operation given twice, for an attempt whose receipt names no invocation.
  raw('flow', 'review-flow', JSON.stringify({ id: 'review-flow', taskId: 'review-task', taskRevision: 'r', kind: 'change', state: 'completed', workflow: store.meta('workflow'), createdAt: new Date(nowMs - 7200000).toISOString(), finishedAt: new Date(nowMs - 3600000).toISOString(), results: {}, visits: {} }));
  const foreign = releaseAttempt({ projectId, flowId: 'review-flow', step: 'review', operation: 'gate', status: 'failed', at: nowMs - 5000000 }); delete foreign.receipt.actionResult; delete foreign.intent;
  raw('attempt', foreign.id, JSON.stringify(foreign));
  raw(INTENT_KIND, foreign.id, `{"id":${JSON.stringify(foreign.id)},"intent":{"action":{"operation":"gate","operation":"provider.review","config":{"providers":{"reviewer":{"provider":"codex","model":"fictional-reviewer"}}}}}}`);
  const active = flow => !['completed', 'failed'].includes(flow.state), ids = rows => rows.map(row => row.id);
  const jobs = () => ({ latest: latestJob(store, 'queue.dispatch'), expected: store.all('job').filter(job => job.operation === 'queue.dispatch').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null, live: ids(store.live('job').filter(job => ['queued', 'running'].includes(job.status))) });
  const read = () => ({ active: ids(store.live('flow').filter(active)), ofTask: ids(store.by('flow', 'taskId', 'twice-task')), jobs: jobs(), stats: projectStats(store, { window: '7d', nowMs }), listed: dashboardSnapshot(store).flows.find(flow => flow.id === 'twice-flow')?.state, intent: store.intent(foreign.id).action.operation, operation: attemptOperations(store)(foreign.id) });
  const before = read();
  assert.deepEqual(before.active, ['twice-flow']); assert.deepEqual(before.ofTask, ['twice-flow']); assert.equal(before.listed, 'running'); assert.equal(before.intent, 'provider.review'); assert.equal(before.operation, 'provider.review');
  assert.equal(before.jobs.latest.id, 'twice-job'); assert.deepEqual(before.jobs.latest, before.jobs.expected); assert.deepEqual(before.jobs.live, []); assert.match(JSON.stringify(before.stats), /fictional-reviewer/);

  const result = migrateStateLayout(store), reason = 'the record has two fields of one name in an object';
  assert.deepEqual(result.unverifiedKinds, { flow: [{ id: 'twice-flow', reason }], job: [{ id: 'twice-job', reason }], [INTENT_KIND]: [{ id: foreign.id, reason }] });
  for (const kind of ['flow', 'job', INTENT_KIND]) assert.equal(store.verified(kind), false); for (const kind of ['attempt', 'task', 'inbox', 'queue']) assert.equal(store.verified(kind), true);
  const status = stateLayout(store);
  assert.equal(status.current, false); assert.deepEqual(status.unverifiedKinds, result.unverifiedKinds);
  assert.deepEqual(status.missingIndexes, ['records_live_flow', 'records_live_job', 'records_flow_task', 'records_job_operation', 'records_job_schedule', 'records_flow_finished', 'records_intent_operation']);
  // What SQL would have got wrong is read in JavaScript: the running flow is still stepped, listed and found by its task.
  assert.deepEqual(read(), before);
  assert.equal(store.db.prepare(`SELECT count(*) AS n FROM records WHERE kind='flow' AND ${LIVE.flow}`).get().n, 0, 'the SQL predicate does not see it');
  assert.deepEqual(migrateStateLayout(store), { changed: false, movedIntents: 0, unverifiedKinds: result.unverifiedKinds, indexes: [] });

  // The runtime writes a record as JSON.stringify gives it: a put repairs it, and the next run verifies and indexes the kind.
  store.put('flow', store.get('flow', 'twice-flow')); store.put('job', store.get('job', 'twice-job'));
  const repaired = migrateStateLayout(store);
  assert.deepEqual(repaired.indexes, ['records_live_flow', 'records_live_job', 'records_flow_task', 'records_job_operation', 'records_job_schedule', 'records_flow_finished']); assert.deepEqual(Object.keys(repaired.unverifiedKinds), [INTENT_KIND]);
  assert.equal(store.verified('flow'), true); assert.equal(store.verified('job'), true); assert.deepEqual(ids(store.live('flow')), ['twice-flow']);
  assert.deepEqual(read(), before);
});

// Round 4 of the review. What says a kind is verified must be written only by the transaction
// that verified it and gone before anything unverified can be written: an index, or a fence,
// that merely exists says nothing.
const TWICE = 'the record has two fields of one name in an object', running = flow => !['completed', 'failed'].includes(flow.state), idsOf = rows => rows.map(row => row.id);
// Written by a connection that is not this runtime's, which only an unfenced database lets happen:
// a flow SQL reads as completed and JSON.parse as running, and a job likewise.
function foreignWrites(stateDir) {
  const foreign = new DatabaseSync(join(stateDir, 'state.sqlite')), at = new Date().toISOString();
  foreign.prepare('INSERT INTO records VALUES(?,?,?)').run('flow', 'f', `{"id":"f","taskId":"t","kind":"change","state":"completed","state":"running","createdAt":${JSON.stringify(at)},"finishedAt":${JSON.stringify(at)}}`);
  foreign.prepare('INSERT INTO records VALUES(?,?,?)').run('job', 'j', `{"id":"j","operation":"machine.sample","operation":"queue.dispatch","status":"queued","status":"completed","createdAt":${JSON.stringify(at)}}`);
  foreign.close();
}
// What must hold of a state whatever interrupted the migration or its reverse.
function consistent(store, originals, label, { retainedIndexes = false } = {}) {
  // Every targeted read answers as the whole-kind JavaScript read does.
  for (const kind of Object.keys(LIVE)) assert.deepEqual(idsOf(store.live(kind).filter(USED[kind])), idsOf(store.stored(kind).filter(USED[kind])), `${label}: live ${kind}`);
  assert.deepEqual(idsOf(store.by('flow', 'taskId', 't')), idsOf(store.stored('flow').filter(flow => flow.taskId === 't')), `${label}: flows of a task`);
  assert.deepEqual(latestJob(store, 'queue.dispatch'), store.stored('job').filter(job => job.operation === 'queue.dispatch').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] ?? null, `${label}: last dispatch`);
  // A kind is verified only if none of its records gives a field twice, only behind the fence, and only on record.
  const fenced = layoutFenceIntact(store.db), record = store.meta(VERIFIED_META), indexes = store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='records' AND sql IS NOT NULL").all();
  for (const kind of KIND_INDEXES.keys()) if (store.verified(kind)) {
    assert.ok(fenced && record.kinds.includes(kind), `${label}: ${kind} is verified on record, behind the fence`);
    for (const row of store.db.prepare('SELECT id, data FROM records WHERE kind=?').all(kind)) assert.equal(hasDuplicateKeys(row.data), false, `${label}: verified ${kind} holds ${row.id}`);
  }
  // (retainedIndexes: a state set up with indexes left behind by an earlier lift; they must not count, and go when the fence is installed.)
  if (!fenced) { assert.equal(record, undefined, `${label}: no record of verification without the fence`); if (!retainedIndexes) assert.deepEqual(indexes, [], `${label}: no index without the fence`); for (const kind of KIND_INDEXES.keys()) assert.equal(store.verified(kind), false, `${label}: nothing is verified without the fence`); }
  // No attempt lost its intent.
  assert.deepEqual(store.all('attempt'), originals, `${label}: attempts complete`);
}

test('a fence re-installed over indexes that outlived the last one vouches for nothing', t => {
  // retained: the indexes survive `layout inline`, as they did before this fix.
  for (const retained of [false, true]) {
    const f = releaseProject(t); addHistory(f.stateDir, { changes: 2, maintenance: 1, samples: 0 });
    let store = new Store(f.stateDir); const originals = store.all('attempt');
    migrateStateLayout(store); assert.equal(store.verified('flow'), true);
    assert.equal(inlineAttemptIntents(store).fenceRemoved, true);
    if (retained) { store.tx(() => ensureStateIndexes(store.db)); assert.deepEqual(stateLayout(store).missingIndexes, []); }
    assert.equal(store.verified('flow'), false, 'indexes without the fence verify nothing'); store.close();
    foreignWrites(f.stateDir);
    // Remigration, killed right after the transaction that installs the fence has committed.
    const crash = crashAt(f.stateDir, 'migrate', 'after:1'); assert.equal(crash.signal, 'SIGKILL', crash.stderr);
    store = open(t, f.stateDir);
    assert.ok(layoutFenceIntact(store.db), 'the fence is committed');
    assert.equal(store.verified('flow'), false); assert.equal(store.get('flow', 'f').state, 'running'); assert.deepEqual(idsOf(store.live('flow').filter(running)), ['f']);
    assert.equal(store.meta(VERIFIED_META), undefined); assert.equal(store.hint('records_live_flow'), ''); assert.deepEqual(stateLayout(store).missingIndexes, STATE_INDEXES.map(index => index.name), 'the same transaction dropped the indexes');
    consistent(store, originals, `retained ${retained}, after the fence`);
    // The next run finishes: the kinds with such a record are reported and stay unindexed, the others are verified.
    const result = migrateStateLayout(store);
    assert.deepEqual(result.unverifiedKinds, { flow: [{ id: 'f', reason: TWICE }], job: [{ id: 'j', reason: TWICE }] });
    assert.equal(store.verified('flow'), false); assert.equal(store.verified('job'), false); assert.equal(store.verified('attempt'), true); assert.deepEqual(idsOf(store.live('flow').filter(running)), ['f']);
    assert.deepEqual(store.meta(VERIFIED_META).kinds, [...KIND_INDEXES.keys()].filter(kind => !['flow', 'job'].includes(kind)));
    consistent(store, originals, `retained ${retained}, finished`);
  }
});

test('killed at any point of the migration or of its reverse, no kind is verified that was not checked', t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 2, maintenance: 1, samples: 0 });
  const setup = new Store(f.stateDir), originals = setup.all('attempt'), texts = attemptRows(setup);
  migrateStateLayout(setup); setup.close();
  const copy = name => { const dir = join(f.base, name); cpSync(f.stateDir, dir, { recursive: true }); return dir; };

  // The reverse, from a verified state: every transaction, killed before it commits and after.
  const inlineSteps = (() => { const dir = copy('inline-count'), counted = crashAt(dir, 'inline', 'count', 4000); assert.equal(counted.status, 0, counted.stderr); return Number(counted.stdout.trim()); })();
  assert.ok(inlineSteps >= 4, `several transactions (${inlineSteps})`);
  for (let n = 1; n <= inlineSteps; n++) for (const where of ['inside', 'after']) {
    const label = `inline ${where}:${n}`, dir = copy(`inline-${where}-${n}`), crash = crashAt(dir, 'inline', `${where}:${n}`, 4000);
    assert.equal(crash.signal, 'SIGKILL', `${label}: ${crash.stderr}`);
    const store = new Store(dir);
    try {
      consistent(store, originals, label);
      // Finished, it is the earlier layout: the original texts, no fence, no index, nothing on record.
      assert.equal(inlineAttemptIntents(store, { chunkBytes: 4000 }).layout, 'inline', label); consistent(store, originals, `${label}, finished`);
      assert.deepEqual([...attemptRows(store).values()], [...texts.values()], label); assert.ok(!layoutFenceIntact(store.db), label);
    } finally { store.close(); }
  }

  // The migration, over a state whose indexes outlived the fence and which a foreign writer then changed.
  const base = copy('remigrate'); { const store = new Store(base); inlineAttemptIntents(store); store.tx(() => ensureStateIndexes(store.db)); store.close(); foreignWrites(base); }
  const from = name => { const dir = join(f.base, name); cpSync(base, dir, { recursive: true }); return dir; };
  const migrateSteps = (() => { const counted = crashAt(from('migrate-count'), 'migrate', 'count', 4000); assert.equal(counted.status, 0, counted.stderr); return Number(counted.stdout.trim()); })();
  assert.ok(migrateSteps >= 6, `the fence, the chunks, the verification and the record (${migrateSteps})`);
  t.diagnostic(`killed before and after each of ${inlineSteps} transactions of the reverse and ${migrateSteps} of the migration`);
  for (let n = 1; n <= migrateSteps; n++) for (const where of ['inside', 'after']) {
    const label = `migrate ${where}:${n}`, dir = from(`migrate-${where}-${n}`), crash = crashAt(dir, 'migrate', `${where}:${n}`, 4000);
    assert.equal(crash.signal, 'SIGKILL', `${label}: ${crash.stderr}`);
    const store = new Store(dir);
    try {
      assert.equal(store.get('flow', 'f').state, 'running', label); assert.equal(store.verified('flow'), false, label); assert.equal(store.verified('job'), false, label);
      assert.deepEqual(idsOf(store.live('flow').filter(running)), ['f'], label);
      consistent(store, originals, label, { retainedIndexes: true });
      migrateStateLayout(store, { chunkBytes: 4000 });
      assert.deepEqual(Object.keys(stateLayout(store).unverifiedKinds), ['flow', 'job'], label); assert.equal(store.verified('flow'), false, label); assert.equal(store.verified('attempt'), true, label);
      assert.deepEqual(idsOf(store.live('flow').filter(running)), ['f'], label); assert.equal(stateLayout(store).inlineIntents, 0, label);
      consistent(store, originals, `${label}, finished`);
    } finally { store.close(); }
  }
});

test('one rule everywhere: an inline intent wins over a separate record, and the next migration moves it out', async t => {
  const f = releaseProject(t); addHistory(f.stateDir, { changes: 2, maintenance: 0, samples: 0 });
  let store = open(t, f.stateDir); migrateStateLayout(store);
  const id = store.stored('attempt')[0].id, complete = store.get('attempt', id), changed = { action: { operation: 'new.operation' }, changed: true };
  // The reviewer's shape: the attempt has a separate intent, and the earlier runtime's own
  // Store.put then writes it with a different inline intent. With the fence that write is
  // refused (next test); here the fence is removed to show the rule that holds without it.
  store.tx(() => removeLayoutFence(store.db)); store.close();
  const earlier = await earlierRuntime(f.base);
  if (earlier.skip) { t.diagnostic(`written directly instead: ${earlier.skip}`); const direct = new Store(f.stateDir); direct.write('attempt', id, JSON.stringify({ ...complete, intent: changed })); direct.close(); }
  else { const old = new earlier.Store(f.stateDir); old.put('attempt', { ...old.get('attempt', id), intent: changed }); old.close(); }
  store = open(t, f.stateDir);
  assert.notDeepEqual(JSON.parse(intentText(store, id)), changed, 'the separate record is stale');
  for (const [name, intent] of [['get', store.get('attempt', id).intent], ['need', store.need('attempt', id).intent], ['intent', store.intent(id)], ['all', store.all('attempt').find(row => row.id === id).intent], ['by', store.by('attempt', 'flowId', complete.flowId).find(row => row.id === id).intent], ['stored', store.stored('attempt').find(row => row.id === id).intent]])
    assert.deepEqual(intent, changed, `${name} returns the inline intent`);
  assert.equal(stateLayout(store).inlineIntents, 1);
  const result = migrateStateLayout(store);
  assert.equal(result.movedIntents, 1); assert.equal(result.fenceInstalled, true);
  assert.deepEqual(JSON.parse(intentText(store, id)), changed, 'the stale separate record is replaced'); assert.ok(!('intent' in store.stored('attempt').find(row => row.id === id)));
  assert.deepEqual(store.get('attempt', id).intent, changed); assert.deepEqual(store.intent(id), changed); assert.equal(stateLayout(store).current, true);
});

test('an earlier runtime cannot write a state that stores intents separately, and reads it correctly once it is inline again', async t => {
  const f = sandbox(t);
  assert.equal(f.start().status, 'completed');
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  const attempt = f.store.all('attempt')[0], path = join(f.stateDir, 'state.sqlite');
  assert.equal(attempt.status, 'passed'); assert.ok(layoutFenceIntact(f.store.db)); assert.equal(LAYOUT_FENCE.length, 12);
  // A second flow left prepared, so the earlier engine has something it would act on.
  f.command('task.put', { task: { id: 'task-2', title: 'Second fictional feature', acceptance: ['Observed'] } });
  f.command('task.approve', { taskId: 'task-2', revision: f.store.need('task', 'task-2').revision }); f.command('flow.start', { taskId: 'task-2', flowId: 'flow-2' });
  await f.engine.tick(); assert.equal(f.store.by('attempt', 'flowId', 'flow-2')[0].status, 'prepared');
  const dump = () => JSON.stringify([f.store.db.prepare('SELECT * FROM records ORDER BY kind, id').all(), f.store.db.prepare('SELECT * FROM meta ORDER BY key').all(), f.store.db.prepare('SELECT count(*) AS n FROM events').get(), f.store.db.prepare('SELECT count(*) AS n FROM commands').get()]), before = dump();
  // Any connection that has not registered the layout function: SQLite refuses every write, on every table.
  const plain = new DatabaseSync(path);
  for (const sql of ["INSERT INTO meta VALUES('fictional','1')", "UPDATE meta SET value='true' WHERE key='paused'", "DELETE FROM meta WHERE key='paused'", "INSERT INTO records VALUES('attempt','x','{}')", "UPDATE records SET data='{}' WHERE kind='attempt'", "DELETE FROM records WHERE kind='attempt'", "INSERT INTO events(at,type,payload) VALUES('x','y','{}')", 'DELETE FROM events', "INSERT INTO commands VALUES('x','y','{}')", 'DELETE FROM commands'])
    assert.throws(() => plain.prepare(sql).run(), FENCED, sql);
  assert.equal(plain.prepare("SELECT count(*) AS n FROM records WHERE kind='attempt'").get().n, 2, 'reading is not fenced'); plain.close();
  const earlier = await earlierRuntime(f.base);
  if (earlier.skip) { assert.equal(dump(), before); return t.skip(earlier.skip); }
  // The reviewer's shape: the earlier runtime opens it (schema 1 is all it checks at open) and its
  // effect inspector misjudges a settled attempt it cannot see the intent of...
  const old = new earlier.Store(f.stateDir), pid = f.project.projectId;
  assert.equal(old.meta('schemaVersion'), 1); assert.equal(old.get('attempt', attempt.id).intent, undefined);
  assert.deepEqual(earlier.inspect(old, old.get('attempt', attempt.id)), { kind: 'uncertain', reason: "Cannot read properties of undefined (reading 'synthetic')" });
  // ...but it can record nothing: not that judgement, not a command, not a raw write, not a tick.
  assert.throws(() => old.put('attempt', { ...old.get('attempt', attempt.id), status: 'uncertain' }), FENCED);
  assert.throws(() => old.setMeta('recoveryHold', true), FENCED); assert.throws(() => old.tx(() => old.event('runner.fault', { error: 'x' })), FENCED);
  assert.throws(() => earlier.executeCommand(old, { protocolVersion: 1, projectId: pid, commandId: 'earlier-1', actor: 'operator', operation: 'pause', payload: { paused: true, note: 'Earlier runtime' } }), FENCED);
  await assert.rejects(new earlier.Engine(old).tick(), FENCED); await assert.rejects(new earlier.Engine(old).tick(), FENCED);
  old.close();
  assert.equal(dump(), before, 'the earlier runtime changed nothing');
  // Converted by this release (`layout inline`), the same state is the earlier release's own layout.
  assert.equal(inlineAttemptIntents(f.store).layout, 'inline');
  const again = new earlier.Store(f.stateDir); t.after(() => { try { again.close(); } catch {} });
  assert.deepEqual(again.get('attempt', attempt.id), attempt); assert.deepEqual(earlier.inspect(again, again.get('attempt', attempt.id)), inspect(f.store, attempt));
  assert.notEqual(earlier.inspect(again, again.get('attempt', attempt.id)).kind, 'uncertain');
  again.put('attempt', { ...again.get('attempt', attempt.id), note: 'written by the earlier runtime' }); again.close();
  assert.equal(f.store.get('attempt', attempt.id).note, 'written by the earlier runtime'); assert.deepEqual(f.store.get('attempt', attempt.id).intent, attempt.intent);
});

test('Factotum\'s own paths to a release that reads intents only inline return the state to that layout first', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  assert.equal(f.start().status, 'completed');
  await until(() => f.store.need('flow', 'flow-1').state === 'completed', { tick: () => f.engine.tick() });
  const attempt = f.store.all('attempt')[0], separate = () => ({ fenced: layoutFenceIntact(f.store.db), intents: f.store.count(INTENT_KIND), inline: stateLayout(f.store).inlineIntents });
  assert.deepEqual(separate(), { fenced: true, intents: 1, inline: 0 });
  const put = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
  const release = (version, layouts) => { const source = join(f.base, `source-${version}`); put(source, 'factory/cli.mjs', `console.log(${JSON.stringify(version)});\n`); put(source, 'factory/core/configuration.mjs', 'export const validateConfig = config => config;\n'); put(source, 'VERSION', 'development\n'); put(source, 'compatibility.json', JSON.stringify({ schemaVersion: 1, configVersion: 1, projectProtocolVersion: 1, ...(layouts ? { recordLayouts: layouts } : {}) })); const dir = join(f.base, `release-${version}`); return { dir, source, ...buildRelease({ sourceDir: source, outputDir: dir, version, allowWorkingTree: true }) }; };
  // The declaration this release ships.
  assert.deepEqual(JSON.parse(readFileSync(new URL('../starter/compatibility.json', import.meta.url), 'utf8')).recordLayouts, ['inline', 'separate-intents']);
  assert.equal(inlineForRelease(f.store, { recordLayouts: ['inline', 'separate-intents'] }), null); assert.deepEqual(separate(), { fenced: true, intents: 1, inline: 0 });

  // upgrade stage/activate of an installed version that declares the layout leaves the state alone...
  const installRoot = join(f.base, 'installed'), current = release('2.0.0', ['inline', 'separate-intents']), compatible = JSON.parse(readFileSync(join(current.dir, 'starter', 'compatibility.json'), 'utf8'));
  stageUpgrade(f.store, { sourceDir: join(current.dir, 'starter'), installRoot, version: '2.0.0', compatibility: compatible }); finishUpgrade(f.store, { version: '2.0.0', verify: () => true });
  assert.deepEqual(separate(), { fenced: true, intents: 1, inline: 0 });
  // ...and of one that does not (an earlier release) inlines every intent and removes the fence before the launcher points at it.
  const earlier = release('1.0.0', null), earlierCompatibility = JSON.parse(readFileSync(join(earlier.dir, 'starter', 'compatibility.json'), 'utf8'));
  assert.equal(earlierCompatibility.recordLayouts, undefined);
  stageUpgrade(f.store, { sourceDir: join(earlier.dir, 'starter'), installRoot, version: '1.0.0', compatibility: earlierCompatibility }); finishUpgrade(f.store, { version: '1.0.0', verify: () => true });
  assert.deepEqual(separate(), { fenced: false, intents: 0, inline: 1 }); assert.equal(JSON.parse(readFileSync(join(installRoot, 'current.json'), 'utf8')).version, '1.0.0');
  assert.deepEqual(f.store.stored('attempt')[0], attempt, 'the attempt is whole in its own record again');
  assert.equal(events(f.store, 'state.layout-inlined'), 1);

  // upgrade apply --merge to an earlier release: the layout step runs with the units stopped, before the backup.
  migrateStateLayout(f.store); assert.deepEqual(separate(), { fenced: true, intents: 1, inline: 0 });
  const first = release('1.1.0', ['inline', 'separate-intents']), installed = prepareAdoption({ root: f.root, releaseDir: first.dir, expectedDigest: first.manifestDigest, branch: 'chore/install', worktreeDir: join(f.base, 'install'), initial: true });
  git(installed.worktree, ['add', '.']); git(installed.worktree, ['commit', '-qm', 'Adopt 1.1.0']); git(f.root, ['merge', '--ff-only', 'chore/install']);
  const older = release('1.0.1', null), options = { root: f.root, stateDir: f.stateDir, releaseDir: older.dir, expectedDigest: older.manifestDigest, branch: 'chore/factotum-1.0.1', worktreeDir: join(f.base, 'review-1.0.1') };
  const run = async (binary, args) => binary === 'systemctl' ? (args[1] === 'is-active' ? { code: 3, stdout: 'inactive' } : { code: 0, stdout: '' }) : { code: 0, stdout: '' }, runCli = async () => ({ code: 0, stdout: '{}', stderr: '' });
  const prepared = prepareUpgrade(options); git(prepared.worktree, ['add', '.']); git(prepared.worktree, ['commit', '-qm', 'Adopt 1.0.1']);
  const result = await mergeUpgrade({ ...options, backupDir: join(f.base, 'backup'), run, runCli });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(result.steps.map(row => row.step).filter(step => step !== 'start'), ['stop', 'layout', 'backup', 'merge', 'verify', 'cleanup', 'recommission', 'doctor']);
  assert.equal(result.steps.find(row => row.step === 'layout').inlinedIntents, 1);
  assert.deepEqual(separate(), { fenced: false, intents: 0, inline: 1 });
  // The backup taken on the way is one the earlier release can use: inline, no fence.
  const backup = new DatabaseSync(join(f.base, 'backup', 'state.sqlite'));
  assert.equal(backup.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'factotum_layout_fence_%'").get().n, 0);
  assert.equal(backup.prepare("SELECT count(*) AS n FROM records WHERE kind='attempt' AND json_type(data,'$.intent')='object'").get().n, 1); assert.equal(backup.prepare('SELECT count(*) AS n FROM records WHERE kind=?').get(INTENT_KIND).n, 0);
  backup.close();
});
const git = (cwd, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
