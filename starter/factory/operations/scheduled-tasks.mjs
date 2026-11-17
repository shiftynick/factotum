import { assert, digest, id, now } from '../core/contracts.mjs';

// First-class scheduled tasks: a project-owned command run on a schedule in a
// clean checkout of the target. Exit 0 completes quietly; any other exit sends
// one notice carrying the captured report. They observe; anything that writes
// goes through normal tasks and flows.
//
// config.scheduledTasks = { "<name>": {
//   description?, command: [argv], timeoutMs?, network: boolean, notify?: "orchestrator"|"operator", enabled?: boolean,
//   schedule: {type:"interval", everyMs} | {type:"daily", timeOfDay, timezone} | {type:"weekly", timeOfDay, timezone, weekdays:[0-6]} } }
export const SCHEDULED_PREFIX = 'scheduled:';
export const scheduledTaskName = operation => typeof operation === 'string' && operation.startsWith(SCHEDULED_PREFIX) ? operation.slice(SCHEDULED_PREFIX.length) : null;
export const isScheduledOperation = (config, operation) => Boolean(scheduledTaskName(operation) && config?.scheduledTasks?.[scheduledTaskName(operation)]);
export const scheduleIdFor = name => `task:${name}`;

// The schedule shape shared by scheduledTasks and recurringTasks.
export function validateSchedule(s, label) {
  assert(s && ['interval', 'daily', 'weekly'].includes(s.type), `${label}.schedule.type must be interval, daily or weekly`);
  if (s.type === 'interval') assert(Number.isSafeInteger(s.everyMs) && s.everyMs >= 60000, `${label} runs at most once a minute`);
  else {
    assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(s.timeOfDay ?? '') && typeof s.timezone === 'string', `${label}.schedule needs timeOfDay (HH:MM) and timezone`);
    new Intl.DateTimeFormat('en', { timeZone: s.timezone });
    if (s.type === 'weekly') assert(Array.isArray(s.weekdays) && s.weekdays.length && s.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6), `${label}.schedule.weekdays must list days 0 (Sunday) to 6`);
  }
}
export function validateScheduledTasks(tasks) {
  if (tasks === undefined) return;
  assert(tasks && typeof tasks === 'object' && !Array.isArray(tasks) && Object.keys(tasks).length <= 32, 'scheduledTasks must map up to 32 names to definitions');
  for (const [name, task] of Object.entries(tasks)) {
    id(name, 'scheduled task name'); assert(name.length <= 60, 'scheduled task names are at most 60 characters');
    const allowed = ['description', 'command', 'schedule', 'timeoutMs', 'network', 'notify', 'enabled'];
    assert(task && Object.keys(task).every(key => allowed.includes(key)), `scheduledTasks.${name} supports ${allowed.join(', ')}`);
    assert(Array.isArray(task.command) && task.command.length && task.command.every(arg => typeof arg === 'string' && arg && !arg.includes('\0')), `scheduledTasks.${name}.command must be an argv list`);
    assert(typeof task.network === 'boolean', `scheduledTasks.${name}.network must say whether it needs network`);
    assert(task.timeoutMs === undefined || Number.isSafeInteger(task.timeoutMs) && task.timeoutMs >= 1000 && task.timeoutMs <= 3_600_000, `scheduledTasks.${name}.timeoutMs must be 1 second to 1 hour`);
    assert(task.notify === undefined || ['orchestrator', 'operator'].includes(task.notify), `scheduledTasks.${name}.notify must be orchestrator or operator`);
    assert(task.enabled === undefined || typeof task.enabled === 'boolean', `scheduledTasks.${name}.enabled must be boolean`);
    assert(task.description === undefined || typeof task.description === 'string' && task.description.length <= 500, `scheduledTasks.${name}.description must be at most 500 characters`);
    validateSchedule(task.schedule, `scheduledTasks.${name}`);
  }
}

// Config-owned schedule records (scheduled tasks and recurring tasks), kept in step
// with the commissioned config. An unchanged definition keeps its scan position; a
// changed one starts afresh. A pause set in the console survives config updates.
export function syncScheduledTaskRecords(store, config) {
  const at = now(), wanted = new Map();
  for (const [name, task] of Object.entries(config.scheduledTasks ?? {})) wanted.set(scheduleIdFor(name), { owner: { scheduledTask: name }, operation: `${SCHEDULED_PREFIX}${name}`, schedule: task.schedule, configEnabled: task.enabled !== false, revision: digest({ name, task }) });
  for (const [name, task] of Object.entries(config.recurringTasks ?? {})) wanted.set(recurringScheduleId(name), { owner: { recurringTask: name }, operation: recurringScheduleId(name), schedule: task.schedule, configEnabled: task.enabled !== false, revision: digest({ recurring: name, task }) });
  for (const [scheduleId, row] of wanted) {
    const prior = store.get('schedule', scheduleId), enabled = row.configEnabled && !prior?.paused;
    if (prior?.revision === row.revision && prior.enabled === enabled && !prior.removedAt) continue;
    const s = row.schedule, timing = s.type === 'interval' ? { type: 'interval', everyMs: s.everyMs, anchorMs: Date.parse(at) } : { type: 'daily', timeOfDay: s.timeOfDay, timezone: s.timezone, ...(s.type === 'weekly' ? { weekdays: s.weekdays } : {}) };
    store.put('schedule', { id: scheduleId, source: 'config', ...row.owner, operation: row.operation, payload: {}, ...timing, enabled, configEnabled: row.configEnabled, ...(prior?.paused ? { paused: prior.paused } : {}), revision: row.revision, createdAt: prior?.createdAt ?? at, lastScannedAt: at });
    store.event('schedule.configured', { scheduleId, ...row.owner, revision: row.revision });
  }
  for (const prior of store.all('schedule').filter(row => row.source === 'config' && !wanted.has(row.id) && !row.removedAt)) {
    store.put('schedule', { ...prior, enabled: false, removedAt: at }); store.event('schedule.removed', { scheduleId: prior.id, reason: 'removed from configuration' });
  }
}
export const recurringScheduleId = name => `recurring:${name}`;
