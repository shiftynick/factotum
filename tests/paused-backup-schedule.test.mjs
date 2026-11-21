// dev.103: a paused project still runs its scheduled backups, every other schedule stays held and
// raises one notice per hold, and the holds that make a backup unsafe still hold it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { COMMANDS } from '../starter/factory/core/command-help.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { placeRecoveryHold } from '../starter/factory/operations/recovery-hold.mjs';

// 00:30 UTC is 01:30 in Berlin (CET): the daily 02:00 occurrence falls due half an hour later.
const BASE = Date.parse('2026-11-19T00:30:00Z'), at = hours => BASE + hours * 3600000;
function project(t) {
  const f = sandbox(t), backupRoot = join(f.base, 'backups'), gh = join(f.base, 'gh');
  // Delivery actions run in a GitHub credential scope; this stand-in only answers `gh auth token`.
  writeFileSync(gh, `#!${process.execPath}\nif(process.argv[2]==='auth')console.log('fictional-token');else process.exit(1);\n`); chmodSync(gh, 0o755);
  const config = { mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', ghPath: gh }, policy: {}, backupRoot };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  return { ...f, backupRoot };
}
function daily(f, id, operation) {
  const put = f.command('schedule.put', { expectedSchedule: null, schedule: { id, operation, type: 'daily', timeOfDay: '02:00', timezone: 'Europe/Berlin' } });
  assert.equal(put.status, 'completed', put.error);
  f.store.tx(() => { const row = f.store.need('schedule', id); row.createdAt = new Date(BASE).toISOString(); f.store.put('schedule', row); });
  return f.store.need('schedule', id);
}
const pause = (f, extra = {}) => assert.equal(f.command('pause', { paused: true, note: 'Fictional pause', ...extra }).status, 'completed');
const events = (f, type) => f.store.db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY sequence').all(type).map(row => JSON.parse(row.payload));
const heldNotice = (f, id) => f.store.get('inbox', `schedule-held:${id}`);

test('a paused project with a due backup schedule writes the backup and records schedule.triggered', async t => {
  const f = project(t); daily(f, 'daily-backup', 'maintenance.backup'); pause(f);
  await operationalTick(f.store, { nowMs: at(1) });
  assert.deepEqual(events(f, 'schedule.triggered'), [{ scheduleId: 'daily-backup', occurrenceKey: 'daily-backup:2026-11-19' }]);
  const job = f.store.all('job')[0];
  assert.equal(job.operation, 'maintenance.backup'); assert.equal(job.status, 'running', JSON.stringify(job));
  await until(() => f.store.need('job', job.id).status === 'completed', { tick: () => f.engine.tick() });
  const written = readdirSync(f.backupRoot); assert.equal(written.length, 1);
  const manifest = JSON.parse(readFileSync(join(f.backupRoot, written[0], 'backup.json'), 'utf8'));
  assert.equal(manifest.projectId, f.project.projectId); assert.ok(manifest.files.some(row => row.path === 'state.sqlite'));
  assert.equal(f.store.meta('paused'), true, 'the pause stays');
  assert.equal(heldNotice(f, 'daily-backup'), undefined, 'a backup that ran raises no held notice');
  // The same occurrence never fires twice.
  await operationalTick(f.store, { nowMs: at(2) });
  assert.equal(f.store.all('job').length, 1);
});

for (const [name, hold, named] of [
  ['drain (pause with holdMaintenance)', f => pause(f, { holdMaintenance: true }), 'maintenance hold (drain)'],
  ['recovery hold', f => { pause(f); f.store.tx(() => placeRecoveryHold(f.store, { cause: 'restore' })); }, 'recovery hold'],
  ['retention hold', f => { pause(f); f.store.setMeta('retentionHold', { operationId: 'fictional-retention', createdAt: new Date().toISOString() }); }, 'retention hold'],
  ['retention hold without a pause', f => f.store.setMeta('retentionHold', { operationId: 'fictional-retention', createdAt: new Date().toISOString() }), 'retention hold'],
  ['upgrade in progress', f => { pause(f); f.store.setMeta('upgradeRecovery', { operation: 'merge', units: ['fictional.service'], at: new Date().toISOString() }); }, 'upgrade in progress'],
]) test(`a ${name} still holds a scheduled backup and says so`, async t => {
  const f = project(t); daily(f, 'daily-backup', 'maintenance.backup'); hold(f);
  // A backup job queued before the hold does not start either.
  f.store.put('job', { id: 'queued-backup', operation: 'maintenance.backup', payload: {}, scheduleId: 'daily-backup', scheduleRevision: f.store.need('schedule', 'daily-backup').revision, status: 'queued', createdAt: new Date().toISOString() });
  await operationalTick(f.store, { nowMs: at(1) });
  assert.equal(events(f, 'schedule.triggered').length, 0);
  assert.equal(f.store.all('flow').length, 0); assert.equal(f.store.need('job', 'queued-backup').status, 'queued');
  assert.equal(existsSync(f.backupRoot), false);
  const notice = heldNotice(f, 'daily-backup');
  assert.equal(notice?.status, 'open'); assert.ok(notice.holds.includes(named), JSON.stringify(notice.holds));
  assert.equal(notice.occurrence.key, 'daily-backup:2026-11-19');
});

test('a non-backup schedule stays held while paused, raises exactly one notice and it is settled after resume, with the usual catch-up', async t => {
  const f = project(t); daily(f, 'daily-retro', 'retrospective'); pause(f);
  await operationalTick(f.store, { nowMs: at(1) });
  await operationalTick(f.store, { nowMs: at(2) });
  assert.equal(f.store.all('job').length, 0); assert.equal(events(f, 'schedule.triggered').length, 0);
  let notice = heldNotice(f, 'daily-retro');
  assert.equal(notice.status, 'open'); assert.equal(notice.kind, 'notice'); assert.equal(notice.role, 'operator');
  assert.deepEqual(notice.holds, ['admission paused']); assert.equal(notice.missed, 1);
  assert.equal(notice.occurrence.key, 'daily-retro:2026-11-19'); assert.match(notice.title, /daily-retro/); assert.match(notice.title, /admission paused/);
  const version = notice.version;
  // The next day's occurrence is missed too: still one notice, kept current, not raised again.
  await operationalTick(f.store, { nowMs: at(25) });
  // Saving the schedule again keeps its notice with it.
  const current = f.store.need('schedule', 'daily-retro');
  assert.equal(f.command('schedule.put', { expectedSchedule: { revision: current.revision, enabled: true }, schedule: { id: 'daily-retro', operation: 'retrospective', type: 'daily', timeOfDay: '02:00', timezone: 'Europe/Berlin', anchorMs: current.anchorMs } }).status, 'completed');
  assert.equal(f.store.need('schedule', 'daily-retro').heldNotice, 'schedule-held:daily-retro');
  notice = heldNotice(f, 'daily-retro');
  assert.equal(notice.version, version); assert.equal(notice.missed, 2); assert.equal(notice.latestOccurrence.key, 'daily-retro:2026-11-20');
  assert.equal(events(f, 'schedule.held').length, 1);
  assert.equal(f.store.all('inbox').filter(row => row.id.startsWith('schedule-held:')).length, 1);
  // Resume: occurrences within windowMs (24 h) catch up, the older one is recorded as missed, and the notice resolves.
  assert.equal(f.command('pause', { paused: false, note: 'Fictional resume' }).status, 'completed');
  await operationalTick(f.store, { nowMs: at(25.5) });
  assert.deepEqual(events(f, 'schedule.triggered').map(row => row.occurrenceKey), ['daily-retro:2026-11-20']);
  assert.equal(events(f, 'schedule.missed').length, 1);
  assert.equal(f.store.all('job').filter(job => job.scheduleId === 'daily-retro').length, 1);
  notice = heldNotice(f, 'daily-retro');
  assert.equal(notice.status, 'resolved'); assert.equal(notice.version, version + 1); assert.match(notice.resolution, /catch-up/);
  const row = f.store.need('schedule', 'daily-retro'); assert.equal(row.heldNotice, undefined); assert.equal(row.heldScannedAt, undefined);
});

test('resume without a long pause catches up the occurrence missed while paused', async t => {
  const f = project(t); daily(f, 'daily-retro', 'retrospective'); pause(f);
  await operationalTick(f.store, { nowMs: at(1) });
  assert.equal(f.store.all('job').length, 0);
  assert.equal(f.command('pause', { paused: false, note: 'Fictional resume' }).status, 'completed');
  await operationalTick(f.store, { nowMs: at(3) });
  assert.deepEqual(events(f, 'schedule.triggered').map(row => row.occurrenceKey), ['daily-retro:2026-11-19']);
  assert.equal(events(f, 'schedule.missed').length, 0);
  assert.equal(heldNotice(f, 'daily-retro').status, 'resolved');
});

test('a schedule disabled while held supersedes its notice', async t => {
  const f = project(t); daily(f, 'daily-retro', 'retrospective'); pause(f);
  await operationalTick(f.store, { nowMs: at(1) });
  assert.equal(f.command('schedule.remove', { scheduleId: 'daily-retro', note: 'Fictional removal' }).status, 'completed');
  await operationalTick(f.store, { nowMs: at(2) });
  assert.equal(heldNotice(f, 'daily-retro').status, 'superseded');
});

test('while paused, task admission and every other job stay held; a paused backup job whose schedule changed is revoked', async t => {
  const f = project(t); const schedule = daily(f, 'daily-backup', 'maintenance.backup'); pause(f);
  f.store.put('job', { id: 'manual-retro', operation: 'retrospective', payload: {}, status: 'queued', grant: { actor: 'operator', note: 'Fictional retrospective', configDigest: f.store.meta('configDigest') }, createdAt: new Date().toISOString() });
  f.store.put('job', { id: 'manual-backup', operation: 'maintenance.backup', payload: {}, status: 'queued', grant: { actor: 'operator', note: 'Fictional manual backup', configDigest: f.store.meta('configDigest') }, createdAt: new Date().toISOString() });
  f.store.put('job', { id: 'stale-backup', operation: 'maintenance.backup', payload: {}, scheduleId: schedule.id, scheduleRevision: 'an-earlier-revision', status: 'queued', createdAt: new Date().toISOString() });
  f.store.put('job', { id: 'stale-retro', operation: 'retrospective', payload: {}, scheduleId: schedule.id, scheduleRevision: 'an-earlier-revision', status: 'queued', createdAt: new Date().toISOString() });
  await operationalTick(f.store, { nowMs: at(0.25) });
  assert.equal(f.store.need('job', 'stale-backup').status, 'revoked');
  assert.equal(f.store.need('job', 'manual-retro').status, 'queued');
  assert.equal(f.store.need('job', 'manual-backup').status, 'queued', 'a manually queued backup waits for the pause');
  assert.equal(f.store.need('job', 'stale-retro').status, 'queued', 'other jobs are not even revoked while paused, as before');
  assert.equal(f.store.all('flow').length, 0);
  // Task admission stays held.
  const started = f.start(); assert.equal(started.status, 'rejected'); assert.match(started.error, /admission paused/);
  // The due backup still runs; only it.
  await operationalTick(f.store, { nowMs: at(1) });
  const running = f.store.all('job').filter(job => job.status === 'running');
  assert.deepEqual(running.map(job => job.operation), ['maintenance.backup']); assert.equal(running[0].scheduleId, 'daily-backup');
  await until(() => f.store.all('job').some(job => job.scheduleId === 'daily-backup' && job.status === 'completed'), { tick: () => f.engine.tick() });
  await operationalTick(f.store, { nowMs: at(2) });
  assert.equal(f.store.need('job', 'manual-retro').status, 'queued'); assert.equal(f.store.need('job', 'manual-backup').status, 'queued');
  // Resume: the held jobs start as before (one built-in maintenance flow at a time).
  assert.equal(f.command('pause', { paused: false, note: 'Fictional resume' }).status, 'completed');
  await operationalTick(f.store, { nowMs: at(2.5) });
  assert.equal(f.store.need('job', 'stale-retro').status, 'revoked');
  assert.ok(['manual-retro', 'manual-backup'].some(id => f.store.need('job', id).status === 'running'));
});

test('the pause help says what still runs', () => {
  const [summary, fields] = COMMANDS.pause;
  assert.match(summary, /a scheduled maintenance\.backup still fires and its job starts/);
  assert.match(summary, /raises one notice/);
  assert.match(fields.find(row => row[0] === 'holdMaintenance')[2], /scheduled backups are held too/);
});
