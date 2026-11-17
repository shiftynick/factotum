// Knowledge upkeep, slice 1: the reserved upkeep: namespace at every task-creating route, and the
// refusal of a task whose marker names a kind this release does not enforce (design 7.2, 7.4, 15).
// Everything is fictional. No test here starts a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sandbox, until } from './helpers.mjs';
import { releaseProject } from './history-fixtures.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';
import { Store } from '../starter/factory/core/store.mjs';
import { validateConfig } from '../starter/factory/core/configuration.mjs';
import { validateIssueProfile } from '../starter/factory/adapters/github/issue-profile.mjs';
import { sourceSettings } from '../starter/factory/operations/source-config.mjs';
import { syncIssueSource } from '../starter/factory/workflows/source-sync.mjs';
import { doctor, importGitHubTask } from '../starter/factory/workflows/commission.mjs';
import { runAction, UPKEEP_CHECKED_OPERATIONS } from '../starter/factory/workflows/dispatch.mjs';
import { createRecurringOccurrence, executeCommand, snapshot } from '../starter/factory/core/project.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { validateRecurringTasks } from '../starter/factory/operations/recurring-tasks.mjs';
import { recurringScheduleId } from '../starter/factory/operations/scheduled-tasks.mjs';
import { migrateStateLayout } from '../starter/factory/operations/state-layout.mjs';
import { ENFORCED_UPKEEP_KINDS, UPKEEP_TASK_KINDS, inUpkeepNamespace, upkeepMarkerRefusal, reservedNamespaceReasons } from '../starter/factory/core/upkeep-namespace.mjs';
import { MAX_OPEN_UPKEEP_TASKS, NAMESPACE_LOOKUP_ROWS, isUpkeepTask, namespaceCollisionReasons, openNamespaceTasks } from '../starter/factory/operations/upkeep-records.mjs';

// The namespace written in three letter cases: each is reserved exactly as the first is.
const CASES = ['upkeep:', 'Upkeep:', 'UPKEEP:'];
const RESERVED = /reserved upkeep: (task )?namespace/;
const template = () => JSON.parse(readFileSync(new URL('../starter/project/factotum.template.json', import.meta.url), 'utf8'));
const brief = (id, extra = {}) => ({ id, title: `Fictional task ${id}`, acceptance: ['Observed fictional behaviour'], ...extra });
// A task record written straight to the store: how an earlier release's task.put left a task in
// the namespace (no marker), or how the factory will write one (with a marker).
function stored(store, id, extra = {}) {
  const fields = brief(id), revision = digest(fields);
  return store.tx(() => store.put('task', { ...fields, revision, approvedRevision: null, approvalVersion: 1, ...extra }));
}
const marker = kind => ({ kind, sourceFlow: 'flow-source', mergeCommit: 'a'.repeat(40), candidates: [] });

test('one predicate: lower-cased, the value starts with upkeep:', () => {
  for (const value of ['upkeep:', 'upkeep:1', 'Upkeep:legacy', 'UPKEEP:x', 'uPkEeP:docs-1']) assert.equal(inUpkeepNamespace(value), true, value);
  for (const value of ['upkeep', 'upkeeps:1', 'xupkeep:1', 'recurring:upkeep:1', 'job:upkeep:1', 'upkeep-docs:1', ' upkeep:1', '', null, undefined, 7, ['upkeep:']]) assert.equal(inUpkeepNamespace(value), false, String(value));
  // Lower-casing is ASCII lower-casing, as SQLite's lower() is: the Kelvin sign is not a k.
  assert.equal(inUpkeepNamespace('UPKEEP:1'), false);
  // This release enforces four upkeep task kinds: docs (slice 5 part A), context (slice 6), check and learning-add (slice 7).
  assert.deepEqual(ENFORCED_UPKEEP_KINDS, ['docs', 'context', 'check', 'learning-add', 'learning-retire']); assert.equal(Object.isFrozen(ENFORCED_UPKEEP_KINDS), true);
});

test('task.put cannot create a task in the namespace, in any letter case', t => {
  const f = sandbox(t), before = f.store.count('task');
  for (const prefix of CASES) for (const id of [`${prefix}docs-1`, `${prefix}legacy`, prefix]) {
    const result = f.command('task.put', { task: brief(id) });
    assert.equal(result.status, 'rejected', id); assert.match(result.error, RESERVED, id); assert.equal(f.store.get('task', id), undefined);
    // Naming a revision to replace changes nothing: there is nothing there to change.
    assert.equal(f.command('task.put', { task: brief(id), expectedRevision: null }).status, 'rejected');
  }
  assert.equal(f.store.count('task'), before);
  // Ids that only resemble the namespace are ordinary.
  for (const id of ['upkeeps:1', 'my-upkeep:1', 'upkeep-1']) assert.equal(f.command('task.put', { task: brief(id) }).status, 'completed', id);
});

test('task.put cannot put the upkeep field on any task, new or existing', t => {
  const f = sandbox(t), before = structuredClone(f.store.need('task', 'task-1'));
  for (const upkeep of [marker('docs'), { kind: 'future-kind' }, {}, null, 'docs', false]) {
    for (const id of ['task-1', 'task-new', 'Upkeep:x']) {
      const result = f.command('task.put', { task: brief(id, { upkeep }) });
      assert.equal(result.status, 'rejected', `${id} ${JSON.stringify(upkeep)}`); assert.match(result.error, /upkeep field is written by the factory only/);
    }
  }
  assert.deepEqual(f.store.need('task', 'task-1'), before); assert.equal(f.store.get('task', 'task-new'), undefined);
});

test('task.put cannot edit or strip a task that carries a marker; labels and the not-before time still apply', t => {
  const f = sandbox(t);
  for (const [index, prefix] of CASES.entries()) {
    const id = `${prefix}docs-${index}`, made = stored(f.store, id, { upkeep: marker('docs'), category: 'knowledge-upkeep' });
    // The same brief, a changed brief, and a brief that would leave the marker out: all refused.
    for (const task of [brief(id), brief(id, { title: 'Edited by hand' }), brief(id, { category: 'knowledge-upkeep', closed: true })]) {
      const result = f.command('task.put', { task, expectedRevision: made.revision });
      assert.equal(result.status, 'rejected'); assert.match(result.error, /carries an upkeep marker/);
    }
    assert.deepEqual(f.store.need('task', id), made, 'the record is exactly as the factory wrote it');
    // Labels and the not-before time are not part of a brief.
    assert.equal(f.command('task.label', { taskId: id, labels: ['docs'] }).status, 'completed');
    assert.deepEqual(f.store.need('task', id).upkeep, made.upkeep); assert.equal(f.store.need('task', id).revision, made.revision);
  }
  // A marker on a task outside the namespace (a record no route can write) is not editable either.
  const odd = stored(f.store, 'odd-task', { upkeep: marker('docs') });
  assert.match(f.command('task.put', { task: brief('odd-task', { title: 'Strip the marker' }) }).error, /carries an upkeep marker/);
  assert.deepEqual(f.store.need('task', 'odd-task'), odd);
});

test('a task that was in the namespace before the reservation stays an ordinary task and never gains a marker', t => {
  const f = sandbox(t);
  for (const prefix of CASES) {
    const id = `${prefix}legacy`, legacy = stored(f.store, id);
    assert.equal(isUpkeepTask(legacy), false); assert.equal(upkeepMarkerRefusal(legacy), null);
    // It cannot be given the field.
    assert.match(f.command('task.put', { task: brief(id, { upkeep: marker('docs') }) }).error, /upkeep field is written by the factory only/);
    // It can still be labelled, and closed: closing is how its namespace is cleared.
    assert.equal(f.command('task.label', { taskId: id, labels: ['old-source'] }).status, 'completed');
    const closed = f.command('task.put', { task: brief(id, { closed: true }), expectedRevision: legacy.revision });
    assert.equal(closed.status, 'completed', closed.error); assert.equal(f.store.need('task', id).closed, true); assert.equal(isUpkeepTask(f.store.need('task', id)), false);
  }
});

test('configuration: a custom source namespace in the reserved namespace is refused, beside the three refused before', () => {
  const config = namespace => ({ ...template(), sourceSync: { type: 'command', argv: ['node', 'project/integrations/issues.mjs'], namespace } });
  for (const namespace of CASES) {
    assert.throws(() => validateConfig(config(namespace)), error => RESERVED.test(error.message) && error.message.includes('sourceSync.namespace') && error.message.includes(JSON.stringify(namespace)), namespace);
    assert.deepEqual(reservedNamespaceReasons(config(namespace)).length, 1);
  }
  // Today's list is still compared exactly, and other namespaces are accepted.
  for (const namespace of ['github:', 'job:', 'maintenance:']) assert.throws(() => validateConfig(config(namespace)), /separate task namespace/);
  for (const namespace of ['issues:', 'upkeeps:', 'ops-upkeep:', 'Job:']) assert.equal(validateConfig(config(namespace)).sourceSync.namespace, namespace);
  // A GitHub source ignores the setting; it is not what gives its tasks their ids.
  assert.deepEqual(reservedNamespaceReasons({ ...template(), sourceSync: { type: 'github', namespace: 'upkeep:' } }), []);
});

test('configuration: a GitHub task-id prefix in the reserved namespace is refused', () => {
  const config = prefix => { const made = template(); made.repository.issueProfile = { ...made.repository.issueProfile, dependencyIdPrefix: prefix }; return made; };
  for (const prefix of CASES) {
    const named = error => RESERVED.test(error.message) && error.message.includes('repository.issueProfile.dependencyIdPrefix') && error.message.includes(JSON.stringify(prefix));
    assert.throws(() => validateIssueProfile({ dependencyIdPrefix: prefix }), named, prefix);
    assert.throws(() => validateConfig(config(prefix)), named, prefix);
  }
  for (const prefix of ['github:', 'gh:', 'upkeeps:', 'issue-upkeep:']) { validateIssueProfile({ dependencyIdPrefix: prefix }); validateConfig(config(prefix)); }
});

test('config update refuses both settings, and nothing is stored', t => {
  const f = releaseProject(t), store = new Store(f.stateDir); t.after(() => store.close());
  const projectId = store.meta('project').projectId, before = store.meta('configDigest');
  let n = 0; const update = config => executeCommand(store, { protocolVersion: 1, projectId, commandId: `config-${n++}`, actor: 'operator', operation: 'config.update', payload: { config, note: 'Fictional change' } });
  for (const namespace of CASES) {
    const custom = update({ ...store.meta('config'), sourceSync: { type: 'command', argv: ['node', 'issues.mjs'], namespace } });
    assert.equal(custom.status, 'rejected'); assert.match(custom.error, /sourceSync\.namespace/);
    const current = store.meta('config'), github = update({ ...current, repository: { ...current.repository, issueProfile: { ...current.repository.issueProfile, dependencyIdPrefix: namespace } } });
    assert.equal(github.status, 'rejected'); assert.match(github.error, /repository\.issueProfile\.dependencyIdPrefix/);
  }
  assert.equal(store.meta('configDigest'), before);
});

// A project that already uses the namespace: its stored configuration predates the reservation.
function legacyProject(t, change) {
  const f = releaseProject(t), store = new Store(f.stateDir); t.after(() => store.close());
  const config = change(structuredClone(store.meta('config')));
  store.tx(() => { store.setMeta('config', config); store.setMeta('configDigest', digest(config)); });
  migrateStateLayout(store);
  return { ...f, store, config };
}
const customSource = namespace => config => ({ ...config, sourceSync: { type: 'command', argv: ['node', 'project/integrations/issues.mjs'], namespace } });
const githubPrefix = prefix => config => ({ ...config, repository: { ...config.repository, issueProfile: { ...config.repository.issueProfile, dependencyIdPrefix: prefix } } });

test('commissioning reports the conflict, for both settings and in every letter case, and read models keep working', async t => {
  for (const namespace of CASES) for (const [change, setting] of [[customSource(namespace), 'sourceSync.namespace'], [githubPrefix(namespace), 'repository.issueProfile.dependencyIdPrefix']]) {
    const f = legacyProject(t, change);
    let probes = 0; const result = await doctor(f.stateDir, { forgeTransport: async () => { probes++; return {}; }, providerPreflight: async () => { probes++; return {}; }, run: async () => { probes++; return { code: 0, stdout: '', stderr: '' }; } });
    assert.equal(result.ready, false, `${setting} ${namespace}`);
    assert.ok(result.reasons.some(reason => RESERVED.test(reason) && reason.includes(setting) && reason.includes(JSON.stringify(namespace))), result.reasons.join(' | '));
    assert.equal(probes, 0, 'refused before any provider, forge or Git probe');
    assert.equal(f.store.meta('commissioning').ready, false);
    // The project can still be looked at: the read models do not validate the stored configuration against the reservation.
    assert.equal(snapshot(f.store).commissioningRequired, true); assert.equal(sourceSettings(f.store.meta('config')).enabled, true);
  }
});

test('a source synchronization whose items would land in the namespace is refused whole, naming the configuration', async t => {
  for (const namespace of CASES) {
    // A custom source: the read adapter is never run.
    const custom = legacyProject(t, customSource(namespace)); let runs = 0;
    const adapter = async () => { runs++; return { code: 0, stdout: JSON.stringify({ version: 1, complete: true, observedAt: new Date().toISOString(), tasks: [{ key: 'one', state: 'open', revision: 'r1', eligible: true, title: 'Fictional item', acceptance: ['Observed'] }] }), stderr: '' }; };
    await assert.rejects(syncIssueSource(custom.stateDir, { run: adapter }), error => RESERVED.test(error.message) && error.message.includes('sourceSync.namespace') && error.message.includes(JSON.stringify(namespace)));
    assert.equal(runs, 0); assert.equal(custom.store.get('task', `${namespace}one`), undefined);
    const report = custom.store.meta('sourceSync'); assert.equal(report.status, 'failed'); assert.match(report.error, /sourceSync\.namespace/); assert.equal(report.imported, 0);
    // A GitHub source with the prefix: nothing is requested from the forge.
    const github = legacyProject(t, githubPrefix(namespace)); let requests = 0;
    const transport = async () => { requests++; return []; };
    await assert.rejects(syncIssueSource(github.stateDir, { transport }), error => RESERVED.test(error.message) && error.message.includes('repository.issueProfile.dependencyIdPrefix'));
    assert.equal(requests, 0); assert.match(github.store.meta('sourceSync').error, /repository\.issueProfile\.dependencyIdPrefix/);
    // A task import under that prefix is refused the same way.
    await assert.rejects(importGitHubTask(github.stateDir, 7, { transport }), error => RESERVED.test(error.message) && error.message.includes('repository.issueProfile.dependencyIdPrefix') && error.message.includes(JSON.stringify(namespace)));
    assert.equal(requests, 0); assert.equal(github.store.get('task', `${namespace}7`), undefined);
  }
});

test('a recurring occurrence cannot produce an id in the namespace', t => {
  // A recurring task's name may not contain a colon, so its schedule id is recurring:<name>, and
  // every occurrence key starts with it (a counter, a date, or manual-<time>).
  for (const name of CASES.map(prefix => `${prefix}x`).concat(CASES)) assert.throws(() => validateRecurringTasks({ [name]: { schedule: { type: 'interval', everyMs: 3600000 }, task: { title: 'x', acceptance: ['y'], workflow: 'w' } } }), /without colons|invalid recurring task name/, name);
  for (const name of ['upkeep', 'Upkeep', 'UPKEEP']) for (const key of [recurringScheduleId(name), `${recurringScheduleId(name)}:1`, `${recurringScheduleId(name)}:2026-11-16`, `${recurringScheduleId(name)}:manual-1763300000000`]) assert.equal(inUpkeepNamespace(key), false, key);
  // And were a key in the namespace ever passed, the occurrence is refused.
  const f = sandbox(t), config = { recurringTasks: { upkeep: { schedule: { type: 'interval', everyMs: 3600000 }, task: { title: 'Fictional recurring work', acceptance: ['Observed'], workflow: 'standard' } } } };
  for (const prefix of CASES) assert.throws(() => f.store.tx(() => createRecurringOccurrence(f.store, config, 'upkeep', { key: `${prefix}recurring-1`, at: new Date().toISOString() })), RESERVED);
  assert.equal(f.store.all('task').filter(task => inUpkeepNamespace(task.id)).length, 0);
  const made = f.store.tx(() => createRecurringOccurrence(f.store, config, 'upkeep', { key: 'recurring:upkeep:1', at: new Date().toISOString() }));
  assert.equal(made.taskId, 'recurring:upkeep:1'); assert.equal(inUpkeepNamespace(made.taskId), false);
});

test('existing open tasks in the namespace block turning upkeep on; closed and completed ones do not; none is treated as an upkeep task', t => {
  const f = sandbox(t);
  assert.deepEqual(namespaceCollisionReasons(f.store), []);
  // History: closed and completed tasks in the namespace, in every letter case.
  for (const [index, prefix] of CASES.entries()) { stored(f.store, `${prefix}closed-${index}`, { closed: true }); stored(f.store, `${prefix}done-${index}`, { status: 'completed' }); }
  assert.deepEqual(namespaceCollisionReasons(f.store), [], 'closed and completed tasks are history');
  assert.deepEqual(openNamespaceTasks(f.store), []);
  const legacy = stored(f.store, 'Upkeep:legacy');
  assert.deepEqual(openNamespaceTasks(f.store).map(task => task.id), ['Upkeep:legacy']);
  const [reason] = namespaceCollisionReasons(f.store); assert.match(reason, /Upkeep:legacy/); assert.match(reason, /finish or close it and rename the source namespace/);
  for (const id of ['Upkeep:legacy', 'upkeep:closed-0', 'UPKEEP:done-2']) assert.equal(isUpkeepTask(f.store.need('task', id)), false, id);
  // The open one is admitted like any ordinary task: the marker rule has nothing to say about it.
  assert.equal(upkeepMarkerRefusal(legacy), null);
  f.store.tx(() => f.store.put('task', { ...legacy, approvedRevision: legacy.revision }));
  const started = f.command('flow.start', { taskId: 'Upkeep:legacy', flowId: 'flow-legacy' }); assert.equal(started.status, 'completed', started.error);
  // Closing it clears the block.
  f.command('flow.abandon', { flowId: 'flow-legacy', note: 'Fictional cleanup' });
  assert.equal(f.command('task.put', { task: brief('Upkeep:legacy', { closed: true }) }).status, 'completed');
  assert.deepEqual(namespaceCollisionReasons(f.store), []);
  // Up to five are named, whatever their number, and the lookup never reads more than its bound.
  for (let i = 0; i < 20; i++) stored(f.store, `${CASES[i % 3]}old-${String(i).padStart(2, '0')}`);
  assert.equal(openNamespaceTasks(f.store).length, NAMESPACE_LOOKUP_ROWS);
  const [many] = namespaceCollisionReasons(f.store); assert.equal(many.match(/old-\d\d/g).length, 5); assert.match(many, /and more/);
});

test('more open marked tasks than the factory can have made also block', t => {
  const f = sandbox(t);
  for (let i = 0; i < MAX_OPEN_UPKEEP_TASKS; i++) stored(f.store, `upkeep:docs-${i}`, { upkeep: marker('docs') });
  assert.deepEqual(namespaceCollisionReasons(f.store), []); assert.equal(isUpkeepTask(f.store.need('task', 'upkeep:docs-0')), true);
  stored(f.store, 'upkeep:docs-extra', { upkeep: marker('docs') });
  assert.match(namespaceCollisionReasons(f.store)[0], /more than 12 open tasks/);
});

// ---- The unknown-kind refusal ----
// Every marker below is refused: each kind but docs is not enforced, and the docs marker here names
// no declared files or limits, so this release cannot read it (slice 5 part A). A well-formed docs
// marker passes this rule and has its candidate checked instead (tests/upkeep-docs-enforcement.test.mjs).
const MARKERS = [...UPKEEP_TASK_KINDS.map(marker), marker('future-kind'), { kind: 7 }, {}, [], 'docs', null];
const REFUSED_MARKER = /carries an upkeep marker .* (which this release does not enforce|that this release cannot read)/;
const wellFormedDocs = { ...marker('docs'), files: [{ path: 'docs/guide.md', blob: 'b'.repeat(40) }], limits: { maxFiles: 3, maxChangedLines: 40 } };

test('the rule: every marker this release cannot enforce is refused, and only a marker', () => {
  for (const upkeep of MARKERS) assert.match(upkeepMarkerRefusal({ id: 'upkeep:x', upkeep }), REFUSED_MARKER, JSON.stringify(upkeep));
  assert.match(upkeepMarkerRefusal({ id: 'upkeep:x', upkeep: marker('docs') }), /that this release cannot read \(files must list 1 to 3 declared files; limits must give/);
  for (const task of [{ id: 'task-1' }, { id: 'Upkeep:legacy' }, { id: 'x', upkeep: undefined }, null, undefined]) assert.equal(upkeepMarkerRefusal(task), null);
  // A well-formed docs marker passes, with the task's paths exactly its declared files.
  assert.equal(upkeepMarkerRefusal({ id: 'upkeep:x', paths: ['docs/guide.md'], upkeep: wellFormedDocs }), null);
  assert.match(upkeepMarkerRefusal({ id: 'upkeep:x', paths: ['docs/guide.md', 'docs/other.md'], upkeep: wellFormedDocs }), /paths are not exactly its declared files/);
  // The rule itself, against a list other than this release's: a kind that is enforced passes, another does not.
  assert.match(upkeepMarkerRefusal({ id: 'upkeep:x', paths: ['docs/guide.md'], upkeep: wellFormedDocs }, { enforced: [] }), /it enforces no upkeep task kind/);
  assert.match(upkeepMarkerRefusal({ id: 'upkeep:x', upkeep: marker('context') }, { enforced: ['docs'] }), /enforced: docs/);
});

test('admission refuses a task that carries a marker, whatever its kind and wherever its id is', t => {
  const f = sandbox(t);
  for (const [index, upkeep] of MARKERS.entries()) for (const id of [`upkeep:made-${index}`, `ordinary-${index}`]) {
    const task = stored(f.store, id, { upkeep }); f.store.tx(() => f.store.put('task', { ...task, approvedRevision: task.revision }));
    for (const payload of [{ taskId: id, flowId: `flow-${index}-${id.length}` }, { taskId: id, flowId: `flow-s-${index}-${id.length}`, alreadySatisfied: true }]) {
      const result = f.command('flow.start', payload);
      assert.equal(result.status, 'rejected', `${id} ${JSON.stringify(upkeep)}`); assert.match(result.error, /^admission: task .* carries an upkeep marker/);
    }
    assert.ok(admissionReasons(f.store, f.store.need('task', id)).some(reason => /carries an upkeep marker/.test(reason)), 'the hold is shown with the task');
    assert.equal(f.store.by('flow', 'taskId', id).length, 0);
  }
  // The ordinary task of the same project is still admitted.
  assert.equal(f.start().status, 'completed');
});

test('commit, integration, publication and merge each refuse a marked task before doing anything', async t => {
  assert.deepEqual([...UPKEEP_CHECKED_OPERATIONS], ['workspace.commit', 'workspace.integrate', 'forge.publish', 'forge.merge']);
  const f = sandbox(t), intent = (operation, task) => ({ attemptId: 'attempt-x', timeoutMs: 60000, cwd: f.root, projectRoot: f.root, action: { operation, flowId: 'flow-x', projectId: 'p', task, results: {}, context: { files: [] }, config: { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, policy: {} } } });
  const head = () => readFileSync(`${f.root}/.git/HEAD`, 'utf8');
  for (const operation of UPKEEP_CHECKED_OPERATIONS) {
    for (const upkeep of MARKERS) await assert.rejects(runAction(intent(operation, { ...brief('upkeep:docs-1'), upkeep })), error => error.message.startsWith(`${operation}: task upkeep:docs-1 carries an upkeep marker`), `${operation} ${JSON.stringify(upkeep)}`);
    // The same step for a task without a marker gets past this check (whatever happens next in this bare fixture).
    let other = null; try { await runAction(intent(operation, brief('upkeep-free'))); } catch (error) { other = error.message; }
    assert.doesNotMatch(other ?? '', /upkeep marker/, operation);
  }
  assert.ok(head());
});

test('a flow already holding a marked task fails at its publish step: no graph routes around the operation', async t => {
  const f = sandbox(t);
  const workflow = { version: 1, start: 'publish', nodes: { publish: { kind: 'effect', action: { operation: 'forge.publish' }, timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.store.setMeta('config', { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional' }, policy: {} });
  assert.equal(f.start().status, 'completed');
  // The marker reaches the task and the flow's snapshot the only way it can here: written to the records.
  f.store.tx(() => { const task = f.store.need('task', 'task-1'), flow = f.store.need('flow', 'flow-1'); f.store.put('task', { ...task, upkeep: marker('docs') }); f.store.put('flow', { ...flow, taskSnapshot: { ...flow.taskSnapshot, upkeep: marker('docs') } }); });
  await until(() => f.store.need('flow', 'flow-1').state === 'failed', { tick: () => f.engine.tick() });
  const attempt = f.store.by('attempt', 'flowId', 'flow-1').at(-1);
  assert.equal(attempt.status, 'failed'); assert.match(JSON.stringify(attempt.receipt), /forge\.publish: task task-1 carries an upkeep marker/);
});

// ---- What exists, and what still does not ----
// Slice 2 added the observe-only job and its mode (tests/upkeep-observe.test.mjs and
// tests/upkeep-authority.test.mjs). Slice 5 part B writes docs follow-up tasks (operations/upkeep-tasks.mjs).
test('the release has one upkeep operation, one upkeep setting and one model step, and one task writer; the modules the tick and the commands call reach no provider', async () => {
  const { MAINTENANCE_OPERATIONS } = await import('../starter/factory/core/command-help.mjs'), { LIVE_SETTINGS } = await import('../starter/factory/operations/live-settings.mjs'), { operationContract } = await import('../starter/factory/core/operations.mjs');
  assert.deepEqual(MAINTENANCE_OPERATIONS.filter(operation => /upkeep|learnings/.test(operation)), ['knowledge.upkeep', 'learnings.check']);
  assert.deepEqual(Object.keys(LIVE_SETTINGS).filter(name => /upkeep|learnings/.test(name)), ['upkeep.mode']);
  // propose (slice 5 part B) writes candidates and docs follow-ups, through operations/upkeep-tasks.mjs only.
  assert.deepEqual(LIVE_SETTINGS['upkeep.mode'].options, ['off', 'observe', 'propose']);
  // The operation's contract names no role; its one model step takes its role from the model graph:
  // providers.upkeep, or the reviewer.
  assert.equal(operationContract('knowledge.upkeep').role, null); assert.deepEqual(operationContract('knowledge.upkeep').privileged, ['upkeepRun', 'turnLimit', 'proposed']);
  const { modelRole, withBuiltinModelGraphs } = await import('../starter/factory/core/step-models.mjs'), graphs = withBuiltinModelGraphs(template(), {});
  assert.deepEqual(Object.keys(graphs).filter(name => /upkeep/.test(name)), ['maintenance/knowledge.upkeep']);
  assert.equal(modelRole('run', graphs['maintenance/knowledge.upkeep'].nodes.run, template()), 'reviewer');
  assert.equal(modelRole('run', graphs['maintenance/knowledge.upkeep'].nodes.run, { ...template(), providers: { ...template().providers, upkeep: { provider: 'claude', model: 'fictional-small' } } }), 'upkeep');
  // The blocks are validated now, and still change no graph and gain no defaults in the stored configuration.
  const withBlocks = validateConfig({ ...template(), upkeep: { mode: 'observe' }, learnings: { dir: 'docs/learnings' } });
  assert.deepEqual(withBlocks.upkeep, { mode: 'observe' }); assert.deepEqual(withBlocks.learnings, { dir: 'docs/learnings' });
  assert.equal(validateConfig({ ...template(), upkeep: { mode: 'propose' } }).upkeep.mode, 'propose');
  // These modules import only contracts, records, each other and Node; none can start a process or a
  // provider. The assessment step (workflows/upkeep-assess.mjs) is the one module that does.
  const factory = new URL('../starter/factory/', import.meta.url), allowed = /^(\.\/(contracts|workflow-kinds)\.mjs|\.\.\/core\/(contracts|records|upkeep-namespace|upkeep-config|tree-paths|line-diff|globs)\.mjs|\.\/(lesson-signals|upkeep-records|context|upkeep-assessment|upkeep-budget|upkeep-class-key|upkeep-evidence|usage-accounting|upkeep-candidates|upkeep-ceilings|upkeep-confusables)\.mjs)$/;
  for (const file of ['core/upkeep-namespace.mjs', 'core/upkeep-config.mjs', 'core/workflow-kinds.mjs', 'core/tree-paths.mjs', 'core/line-diff.mjs', 'core/globs.mjs', 'operations/upkeep-records.mjs', 'operations/upkeep-runs.mjs', 'operations/upkeep-prefilter.mjs', 'operations/upkeep-class-key.mjs', 'operations/upkeep-budget.mjs', 'operations/upkeep-assessment.mjs', 'operations/upkeep-confusables.mjs', 'operations/upkeep-evidence.mjs', 'operations/usage-accounting.mjs', 'operations/lesson-signals.mjs', 'operations/upkeep-candidates.mjs', 'operations/upkeep-ceilings.mjs']) {
    const source = readFileSync(new URL(file, factory), 'utf8'), imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
    for (const name of imports) assert.match(name, allowed, `${file} imports ${name}`);
    assert.doesNotMatch(source, /child_process|import\(|adapters\/|store\.put\('task'/, file);
  }
  // The one upkeep module that writes a task: it reads Git through verified objects and reaches no
  // adapter and no provider, and it imports nothing from the project commands.
  const writer = readFileSync(new URL('operations/upkeep-tasks.mjs', factory), 'utf8'), writerImports = [...writer.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1]);
  assert.match(writer, /store\.put\('task', task\)/); assert.doesNotMatch(writer, /child_process|import\(/);
  for (const name of writerImports) assert.doesNotMatch(name, /adapters\/|providers|core\/project\.mjs|workflows\//, `operations/upkeep-tasks.mjs imports ${name}`);
});
