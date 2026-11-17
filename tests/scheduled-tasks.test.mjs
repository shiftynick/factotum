import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { sandbox, until } from './helpers.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { dueOccurrences } from '../starter/factory/operations/schedules.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 } };
const linkCheck = exit => ({ description: 'Weekly check of research source links', command: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(exit ? 'research/a.md:3 https://example.invalid/a 404\n' : 'all links resolve\n')}, () => process.exit(${exit}))`], schedule: { type: 'weekly', timeOfDay: '21:00', timezone: 'America/New_York', weekdays: [0] }, timeoutMs: 60000, network: true });

test('scheduled task definitions are validated', () => {
  validateConfig({ ...base, scheduledTasks: { 'source-link-check': linkCheck(0) } });
  assert.throws(() => validateConfig({ ...base, scheduledTasks: { x: { ...linkCheck(0), network: undefined } } }), /needs network/);
  assert.throws(() => validateConfig({ ...base, scheduledTasks: { x: { ...linkCheck(0), schedule: { type: 'weekly', timeOfDay: '21:00', timezone: 'America/New_York' } } } }), /weekdays/);
  assert.throws(() => validateConfig({ ...base, scheduledTasks: { x: { ...linkCheck(0), schedule: { type: 'interval', everyMs: 1000 } } } }), /at most once a minute/);
});

test('a weekly task becomes a config-owned schedule that fires Sunday 21:00 New York', t => {
  const f = sandbox(t);
  f.store.setMeta('config', { ...f.store.meta('config', {}) });
  assert.equal(f.command('config.update', { config: { ...base, scheduledTasks: { 'source-link-check': linkCheck(0) } }, note: 'Add weekly link check' }).status, 'completed');
  const schedule = f.store.need('schedule', 'task:source-link-check');
  assert.equal(schedule.source, 'config'); assert.equal(schedule.operation, 'scheduled:source-link-check'); assert.deepEqual(schedule.weekdays, [0]);
  const sunday = Date.parse('2026-10-25T21:00:30-04:00');
  assert.equal(dueOccurrences(schedule, { nowMs: sunday, afterMs: sunday - 120000 }).length, 1);
  assert.equal(dueOccurrences(schedule, { nowMs: sunday + 86400000, afterMs: sunday + 86400000 - 120000 }).length, 0, 'not on Monday');
  assert.equal(f.command('schedule.put', { schedule: { ...schedule, enabled: false } }).status, 'rejected', 'managed by configuration');
  assert.equal(f.command('config.update', { config: base, note: 'Remove it' }).status, 'completed');
  assert.equal(f.store.need('schedule', 'task:source-link-check').enabled, false);
});

function remoteFixture(t, exit) {
  const f = sandbox(t), git = args => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['branch', '-M', 'main']); const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  const config = { ...base, scheduledTasks: { 'source-link-check': linkCheck(exit) } };
  f.store.setMeta('config', config); f.store.setMeta('configDigest', digest(config));
  return f;
}
async function runNow(f) {
  const job = f.command('job.enqueue', { operation: 'scheduled:source-link-check', note: 'Run now', payload: {} });
  assert.equal(job.status, 'completed', job.error);
  await operationalTick(f.store);
  await until(() => ['completed', 'failed'].includes(f.store.need('job', job.result.id).status), { tick: () => f.engine.tick()});
  return f.store.need('job', job.result.id);
}

test('exit 0 completes quietly in a clean checkout of the target', async t => {
  const f = remoteFixture(t, 0), job = await runNow(f);
  assert.equal(job.status, 'completed');
  const result = f.store.need('flow', job.flowId).results.run;
  assert.equal(result.exitCode, 0); assert.match(result.head, /^[a-f\d]{40}$/); assert.equal(result.wroteFiles, false);
  assert.equal(f.store.all('inbox').filter(row => row.flowId === job.flowId).length, 0);
  assert.equal(snapshot(f.store).schedules.length, 0, 'run now needs no schedule record');
});

test('a scheduled check completes with an unignored linked agent worktree in the project root', async t => {
  const f=remoteFixture(t,0);
  execFileSync('git',['worktree','add','--detach','.claude/worktrees/agent-x','HEAD'],{cwd:f.root,stdio:'pipe'});
  const job=await runNow(f),attempt=f.store.all('attempt').find(row=>row.flowId===job.flowId);
  assert.equal(job.status,'completed');assert.equal(attempt.status,'passed');assert.equal(attempt.receipt.exitCode,0);
  assert.match(f.store.need('flow',job.flowId).results.run.report,/all links resolve/);
});

test('a non-zero exit sends one notice to the orchestrator with the report', async t => {
  const f = remoteFixture(t, 1), job = await runNow(f);
  assert.equal(job.status, 'failed');
  const notices = f.store.all('inbox').filter(row => row.flowId === job.flowId);
  assert.equal(notices.length, 1); assert.equal(notices[0].role, 'orchestrator');
  assert.equal(notices[0].title, 'Scheduled task source-link-check failed (exit 1)');
  assert.match(notices[0].context, /research\/a\.md:3 https:\/\/example\.invalid\/a 404/);
  assert.notEqual(f.store.meta('recoveryHold'), true);
});

test('a manual run counts as the scheduled task\'s last run', async t => {
  const f = remoteFixture(t, 0);
  const { syncScheduledTaskRecords } = await import('../starter/factory/operations/scheduled-tasks.mjs');
  f.store.tx(() => syncScheduledTaskRecords(f.store, f.store.meta('config')));
  const job = await runNow(f);
  const schedule = snapshot(f.store).schedules.find(row => row.id === 'task:source-link-check');
  assert.equal(schedule.runs, 1); assert.equal(schedule.lastRun.jobId, job.id); assert.equal(schedule.lastRun.result.route, 'pass');
});

test('abandoning a maintenance flow settles its job, and stranded running jobs are repaired', async t => {
  const f = sandbox(t);
  f.store.put('job', { id: 'stuck', operation: 'source.sync', status: 'running', flowId: 'maintenance:stuck', createdAt: new Date().toISOString() });
  f.store.put('flow', { id: 'maintenance:stuck', kind: 'maintenance', jobId: 'stuck', taskId: 'job:stuck', state: 'stopped', results: {} });
  assert.equal(f.command('flow.abandon', { flowId: 'maintenance:stuck', note: 'Stopped by an old grant bug' }).status, 'completed');
  assert.equal(f.store.need('job', 'stuck').status, 'abandoned');
  f.store.put('job', { id: 'orphan', operation: 'source.sync', status: 'running', flowId: 'maintenance:orphan', createdAt: new Date().toISOString() });
  f.store.put('flow', { id: 'maintenance:orphan', kind: 'maintenance', jobId: 'orphan', taskId: 'job:orphan', state: 'failed', abandonedAt: new Date().toISOString() });
  await operationalTick(f.store);
  assert.equal(f.store.need('job', 'orphan').status, 'abandoned');
});
