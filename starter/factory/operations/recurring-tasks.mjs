import { assert, id } from '../core/contracts.mjs';
import { validateSchedule } from './scheduled-tasks.mjs';

// Recurring tasks: a config-owned schedule that creates a task on a cadence. Each
// occurrence is a new task, approved by the commissioned configuration and queued.
// Only task-kind workflows (carried out, no build) may recur. If the previous
// occurrence is still open when the next comes due, that occurrence is skipped
// with one notice.
//
// config.recurringTasks = { "<name>": {
//   schedule: {type:"daily"|"weekly"|"interval", ...}, notify?: "orchestrator"|"operator", enabled?: boolean,
//   task: { title | outcome, doneWhen | acceptance, workflow, labels?, description? } } }
export function validateRecurringTasks(tasks) {
  if (tasks === undefined) return;
  assert(tasks && typeof tasks === 'object' && !Array.isArray(tasks) && Object.keys(tasks).length <= 32, 'recurringTasks must map up to 32 names to definitions');
  for (const [name, row] of Object.entries(tasks)) {
    id(name, 'recurring task name'); assert(name.length <= 60 && !name.includes(':'), 'recurring task names are at most 60 characters without colons');
    const allowed = ['schedule', 'task', 'notify', 'enabled'];
    assert(row && Object.keys(row).every(key => allowed.includes(key)), `recurringTasks.${name} supports ${allowed.join(', ')}`);
    validateSchedule(row.schedule, `recurringTasks.${name}`);
    assert(row.notify === undefined || ['orchestrator', 'operator'].includes(row.notify), `recurringTasks.${name}.notify must be orchestrator or operator`);
    assert(row.enabled === undefined || typeof row.enabled === 'boolean', `recurringTasks.${name}.enabled must be boolean`);
    const t = row.task, fields = ['title', 'outcome', 'doneWhen', 'acceptance', 'workflow', 'labels', 'description'];
    assert(t && Object.keys(t).every(key => fields.includes(key)), `recurringTasks.${name}.task supports ${fields.join(', ')}`);
    // Brief field names work too: `outcome` is the title, as in a factotum-task brief.
    const title = t.title ?? t.outcome;
    assert(!(t.title !== undefined && t.outcome !== undefined), `recurringTasks.${name}.task: give title or outcome, not both`);
    assert(typeof title === 'string' && title.trim() && title.length <= 256, `recurringTasks.${name}.task needs a title (or outcome)`);
    const acceptance = recurringAcceptance(t);
    assert(acceptance.length && acceptance.every(x => typeof x === 'string' && x.trim()), `recurringTasks.${name}.task needs doneWhen or acceptance`);
    assert(typeof t.workflow === 'string' && t.workflow, `recurringTasks.${name}.task.workflow must name a task workflow`);
    assert(t.labels === undefined || Array.isArray(t.labels) && t.labels.length <= 16 && t.labels.every(x => typeof x === 'string' && x.trim() && x.length <= 40), `recurringTasks.${name}.task.labels must be up to 16 short strings`);
    assert(t.description === undefined || typeof t.description === 'string' && t.description.length <= 2000, `recurringTasks.${name}.task.description must be at most 2000 characters`);
  }
}
export const recurringAcceptance = t => t.acceptance ?? (t.doneWhen === undefined ? [] : [t.doneWhen].flat());
// At commissioning: every recurring task must name a task-kind workflow in the catalog.
export function validateRecurringWorkflows(config, catalog) {
  for (const [name, row] of Object.entries(config.recurringTasks ?? {})) {
    const workflow = catalog?.workflows?.[row.task.workflow];
    assert(workflow, `recurringTasks.${name}: workflow ${row.task.workflow} is not in the workflow catalog`);
    assert(workflow.kind === 'task', `recurringTasks.${name}: workflow ${row.task.workflow} is a ${workflow.kind ?? 'change'} workflow; recurring tasks use task workflows`);
  }
}
