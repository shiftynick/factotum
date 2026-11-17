import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { nextOccurrence } from '../starter/factory/operations/schedules.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
import { scheduledRows } from '../starter/factory/core/project.mjs';

const workflows = { definitions: { change: { reference: 'change.standard' }, 'orchestrator-task': { reference: 'task.orchestrator' } }, selection: { default: 'change', rules: [{ label: 'orchestrator', workflow: 'orchestrator-task' }] } };
const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, workflows, policy: { autoQueue: true } };
const weekly = { type: 'weekly', timeOfDay: '09:00', timezone: 'America/New_York', weekdays: [1] };
const recurring = { 'publish-day': { schedule: weekly, task: { title: 'Publish-day deploy', doneWhen: 'The site serves this week’s build', workflow: 'orchestrator-task', labels: ['deploy'] } } };

function setup(t, config = base) {
  const f = sandbox(t);
  const update = f.command('config.update', { config, note: 'Scheduled work' });
  assert.equal(update.status, 'completed', update.error);
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  return f;
}

test('next occurrence follows the zone, its weekdays and daylight saving', () => {
  const schedule = { enabled: true, type: 'daily', ...weekly };
  // Friday 23 October 2026 08:00 EDT: the next Monday 09:00 is 26 October, still EDT.
  assert.equal(nextOccurrence(schedule, { nowMs: Date.parse('2026-10-23T12:00:00Z') }), '2026-10-26T13:00:00.000Z');
  assert.equal(nextOccurrence(schedule, { nowMs: Date.parse('2026-10-26T13:00:00Z') }), '2026-11-02T14:00:00.000Z', 'EST after the change');
  assert.equal(nextOccurrence({ ...schedule, weekdays: undefined }, { nowMs: Date.parse('2026-10-26T12:59:00Z') }), '2026-10-26T13:00:00.000Z');
  assert.equal(nextOccurrence({ enabled: true, type: 'interval', everyMs: 60000, anchorMs: 0 }, { nowMs: 90000 }), new Date(120000).toISOString());
  assert.equal(nextOccurrence({ ...schedule, enabled: false }), null);
});

test('a task with a not-before time stays queued until then, and the time can change without losing approval', async t => {
  const f = setup(t), later = new Date(Date.now() + 3600000).toISOString();
  const put = f.command('task.put', { task: { id: 'deploy', title: 'Deploy', acceptance: ['Live'], labels: ['orchestrator'], notBefore: later } });
  assert.equal(put.status, 'completed', put.error); assert.equal(put.result.notBefore, later);
  assert.equal(f.command('task.put', { task: { id: 'bad', title: 'Bad', acceptance: ['x'], notBefore: '2026-10-26 09:00' } }).status, 'rejected', 'an offset is required');
  assert.equal(f.command('task.approve', { taskId: 'deploy', revision: put.result.revision, queue: true }).status, 'completed');
  assert.deepEqual(admissionReasons(f.store, f.store.need('task', 'deploy')), [`scheduled: not before ${later}`]);
  await operationalTick(f.store);
  assert.equal(f.store.all('flow').length, 0, 'not admitted early');
  assert.equal(scheduledRows(f.store).find(r => r.kind === 'task').at, later);

  const moved = f.command('task.schedule', { taskId: 'deploy', notBefore: new Date(Date.now() - 1000).toISOString() });
  assert.equal(moved.status, 'completed', moved.error); assert.equal(moved.result.approvedRevision, moved.result.revision, 'approval kept');
  await operationalTick(f.store);
  assert.equal(f.store.all('flow').filter(flow => flow.taskId === 'deploy').length, 1, 'admitted once due');
  assert.equal(f.command('task.schedule', { taskId: 'deploy', notBefore: null }).result.notBefore, undefined);
});

test('a source re-import keeps a console-set time unless the source item changed', t => {
  const f = setup(t), source = { repository: 'fictional/demo', issue: 7, revision: 'r1' };
  const put = (task, extra = {}) => f.command('task.put', { task: { id: 'github:7', title: 'Deploy', acceptance: ['Live'], source, ...task }, ...extra });
  assert.equal(put({ notBefore: null }).status, 'completed');
  f.command('task.schedule', { taskId: 'github:7', notBefore: '2026-10-26T09:00:00-04:00' });
  assert.equal(put({ notBefore: null }).result.notBefore, '2026-10-26T09:00:00-04:00', 'unchanged source keeps it');
  assert.equal(f.command('task.put', { task: { id: 'github:7', title: 'Deploy', acceptance: ['Live'], source: { ...source, revision: 'r2' }, notBefore: '2026-11-02T09:00:00-05:00' } }).result.notBefore, '2026-11-02T09:00:00-05:00', 'a changed source sets it');
});

test('recurring tasks must use a task workflow', t => {
  const f = sandbox(t);
  const bad = f.command('config.update', { config: { ...base, recurringTasks: { weekly: { schedule: weekly, task: { title: 'Build', doneWhen: 'Built', workflow: 'change' } } } }, note: 'x' });
  assert.equal(bad.status, 'rejected'); assert.match(bad.error, /recurring tasks use task workflows/);
  assert.equal(f.command('config.update', { config: { ...base, recurringTasks: { weekly: { schedule: weekly, task: { title: 'x', workflow: 'orchestrator-task' } } } }, note: 'x' }).status, 'rejected', 'doneWhen or acceptance required');
});

test('a recurring task may use brief field names: outcome as the title', t => {
  const f = setup(t, { ...base, recurringTasks: { weekly: { schedule: weekly, task: { outcome: 'Weekly deploy', doneWhen: 'Deployed', workflow: 'orchestrator-task' } } } });
  const run = f.command('recurring.run', { name: 'weekly' });
  assert.equal(run.status, 'completed', run.error); assert.equal(f.store.need('task', run.result.taskId).title, 'Weekly deploy');
  assert.equal(scheduledRows(f.store).find(r => r.kind === 'recurring').title, 'Weekly deploy');
  assert.equal(f.command('config.update', { config: { ...base, recurringTasks: { weekly: { schedule: weekly, task: { title: 'a', outcome: 'b', doneWhen: 'x', workflow: 'orchestrator-task' } } } }, note: 'x' }).status, 'rejected', 'not both');
});

test('a recurring task creates an approved, queued task when due, and skips with a notice while the last one is open', async t => {
  const f = setup(t, { ...base, recurringTasks: recurring });
  const schedule = f.store.need('schedule', 'recurring:publish-day');
  assert.equal(schedule.source, 'config'); assert.equal(schedule.enabled, true);
  // Make one occurrence due now: a minute-interval timing anchored in the past.
  const due = () => f.store.put('schedule', { ...f.store.need('schedule', 'recurring:publish-day'), type: 'interval', everyMs: 60000, anchorMs: Date.now() - 125000, lastScannedAt: new Date(Date.now() - 70000).toISOString() });
  due(); await operationalTick(f.store);
  const created = f.store.all('task').filter(task => task.recurring?.name === 'publish-day');
  assert.equal(created.length, 1);
  const [task] = created;
  assert.equal(task.approvedRevision, task.revision); assert.equal(task.approvedWorkflow.name, 'orchestrator-task'); assert.deepEqual(task.labels, ['deploy']);
  assert.deepEqual(task.acceptance, ['The site serves this week’s build']);
  const flow = f.store.all('flow').find(row => row.taskId === task.id);
  assert.equal(flow?.kind, 'task', 'admitted by autoQueue on the same tick');

  due(); await operationalTick(f.store);
  assert.equal(f.store.all('task').filter(row => row.recurring?.name === 'publish-day').length, 1, 'skipped while open');
  const notice = f.store.all('inbox').find(row => row.id.startsWith('recurring-skipped:'));
  assert.equal(notice.role, 'orchestrator'); assert.match(notice.context, /still open/);
  assert.equal(f.command('recurring.run', { name: 'publish-day' }).status, 'rejected', 'Run now refuses while one is open');

  const row = scheduledRows(f.store).find(r => r.kind === 'recurring');
  assert.equal(row.last.outcome, 'skipped'); assert.equal(row.title, 'Publish-day deploy');
});

test('pausing a configuration schedule survives config updates; Run now creates an occurrence', async t => {
  const f = setup(t, { ...base, recurringTasks: recurring });
  const paused = f.command('schedule.pause', { scheduleId: 'recurring:publish-day', paused: true, note: 'Holiday' });
  assert.equal(paused.status, 'completed', paused.error); assert.equal(paused.result.enabled, false);
  assert.equal(f.command('config.update', { config: { ...base, recurringTasks: { 'publish-day': { ...recurring['publish-day'], notify: 'operator' } } }, note: 'Change' }).status, 'completed');
  assert.equal(f.store.need('schedule', 'recurring:publish-day').enabled, false, 'still paused');
  assert.equal(scheduledRows(f.store).find(r => r.kind === 'recurring').at, null);
  assert.equal(f.command('schedule.pause', { scheduleId: 'recurring:publish-day', paused: false }).result.enabled, true);
  assert.equal(f.command('schedule.pause', { scheduleId: 'nope', paused: true }).status, 'rejected');

  const run = f.command('recurring.run', { name: 'publish-day' }, { actor: 'operator' });
  assert.equal(run.status, 'completed', run.error);
  assert.equal(f.store.need('queue', run.result.taskId).status, 'queued');
  assert.equal(scheduledRows(f.store).find(r => r.kind === 'recurring').last.manual, true);
});
