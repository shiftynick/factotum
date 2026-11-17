// dev.82 adopter-trial fixes: notification faults never hold the project (F30), live-setting
// provenance in config update (F19), import attribution (F23), parseable config update output
// (F17), subcommand help (F1), notification backlog on enable (F22), provider.hold delegation
// wording (F35).
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { sandbox, until } from './helpers.mjs';
import { executeCommand, authorized, snapshot } from '../starter/factory/core/project.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';
// Namespace imports, so each test fails on its own where an export is missing.
import * as notifications from '../starter/factory/operations/notifications.mjs';
import { importGitHubTask } from '../starter/factory/workflows/commission.mjs';
import * as help from '../starter/factory/core/command-help.mjs';
import { backupProject, restoreProject } from '../starter/factory/core/backup.mjs';
import { Store } from '../starter/factory/core/store.mjs';

const execute = promisify(execFile), cli = new URL('../starter/factory/cli.mjs', import.meta.url).pathname;
const events = (store, type) => store.db.prepare('SELECT payload FROM events WHERE type=? ORDER BY sequence').all(type).map(row => JSON.parse(row.payload));
const instruction = { principal: 'operator', instruction: 'Fictional operator instruction' };
const as = (f, actor, operation, payload, extra = {}) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor, operation, payload, ...extra });

// ---- F30: notification configuration problems pause delivery; they never hold the project ----

function notifying(t) {
  const f = sandbox(t), configPath = join(f.base, 'notifications.json');
  writeFileSync(configPath, JSON.stringify({ url: 'https://example.invalid/hook', signingKey: 'FICTIONAL-SIGNING-SENTINEL' }), { mode: 0o600 });
  f.store.setMeta('config', { mode: 'delivery', policy: {}, notifications: { configPath } });
  const sent = [], transport = async request => { sent.push(JSON.parse(request.payload)); return { status: 202 }; };
  f.command('inbox.publish', { id: 'fictional-notice', kind: 'notice', title: 'Fictional notice', context: 'Something to read' });
  return { ...f, configPath, sent, transport };
}

test('a notification file problem pauses delivery once, never holds the project, and delivery resumes when the file is fixed', async t => {
  const f = notifying(t); chmodSync(f.configPath, 0o644);
  const app = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'f30.sock'), tickMs: 5, operationalIntervalMs: 5, operationTick: store => operationalTick(store, { transport: f.transport }) });
  t.after(() => app.close());
  await until(() => f.store.meta('notificationHealth')?.status === 'paused');
  const ticks = () => f.store.db.prepare("SELECT count(*) AS n FROM events WHERE type='notification.paused'").get().n;
  // Several more ticks with the same problem: still one event, no hold, no fault, nothing sent.
  const before = Date.now(); await until(() => Date.now() - before > 100);
  assert.equal(ticks(), 1, 'the problem is recorded once');
  assert.notEqual(f.store.meta('recoveryHold'), true, 'a notification problem is not a recovery hold');
  assert.equal(events(f.store, 'operations.fault').length, 0);
  assert.equal(f.sent.length, 0, 'delivery is paused');
  assert.match(f.store.meta('notificationHealth').problem, /private 0600 file/);
  assert.deepEqual(snapshot(f.store).health.notifications.status, 'paused', 'status shows it');
  chmodSync(f.configPath, 0o600);
  await until(() => f.sent.some(row => row.inboxId === 'fictional-notice'));
  assert.equal(f.store.meta('notificationHealth'), null, 'the problem clears by itself');
  assert.equal(events(f.store, 'notification.resumed').length, 1);
  assert.notEqual(f.store.meta('recoveryHold'), true);
});

test('every notification configuration failure mode is a paused-delivery problem that names no path or secret', async t => {
  const f = notifying(t), deliver = configPath => notifications.deliverDue(f.store, { configPath, transport: f.transport, nowMs: Date.now() + 1000 });
  notifications.queueDelivery(f.store, { inboxId: 'fictional-notice' });
  const cases = [
    ['mode', () => chmodSync(f.configPath, 0o640), f.configPath, /private 0600 file/],
    ['missing (or a typo in configPath)', () => {}, join(f.base, 'notifcations.json'), /file not found at notifications.configPath/],
    ['unparsable', () => writeFileSync(f.configPath, '{"url": "https://example.invalid/FICTIONAL-SIGNING-SENTINEL", oops', { mode: 0o600 }), f.configPath, /not valid JSON/],
    ['bad url', () => writeFileSync(f.configPath, JSON.stringify({ url: 'not a url' }), { mode: 0o600 }), f.configPath, /needs a valid url/],
    ['http url', () => writeFileSync(f.configPath, JSON.stringify({ url: 'http://example.invalid/hook' }), { mode: 0o600 }), f.configPath, /HTTPS/],
  ];
  for (const [name, breakIt, path, expected] of cases) {
    breakIt(); chmodSync(f.configPath, name === 'mode' ? 0o640 : 0o600);
    assert.deepEqual(await deliver(path), [], `${name}: nothing sent, nothing thrown`);
    const health = f.store.meta('notificationHealth');
    assert.match(health.problem, expected, name);
    assert.doesNotMatch(health.problem, /SENTINEL|notifcations|\//, `${name}: no secret or path in the problem`);
    assert.deepEqual(notifications.notificationConfigWarnings({ notifications: { configPath: path } }).length, 1, `${name}: doctor warns`);
  }
  assert.equal(events(f.store, 'notification.paused').length, cases.length, 'one event per distinct problem');
  assert.notEqual(f.store.meta('recoveryHold'), true);
  writeFileSync(f.configPath, JSON.stringify({ url: 'https://example.invalid/hook' }), { mode: 0o600 }); chmodSync(f.configPath, 0o600);
  assert.equal((await deliver(f.configPath)).length, 1, 'valid again: the queued delivery is sent');
  assert.equal(f.store.meta('notificationHealth'), null);
  assert.deepEqual(notifications.notificationConfigWarnings({ notifications: { configPath: f.configPath } }), []);
});

test('an ordinary operations-loop fault is recorded once and clears; only a state-integrity fault holds, and says why', async t => {
  const f = sandbox(t); f.store.setMeta('config', { mode: 'delivery' });
  let mode = 'ordinary';
  const operationTick = async () => {
    if (mode === 'ordinary') throw new Error('Fictional scheduled operation cannot be dispatched');
    if (mode === 'integrity') throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 });
  };
  const app = await startProjectService({ stateDir: f.stateDir, socketPath: join(f.base, 'fault.sock'), tickMs: 5, operationalIntervalMs: 5, operationTick });
  let closed = false; const close = async () => { if (!closed) { closed = true; await app.close(); } }; t.after(close);
  await until(() => f.store.meta('operationsFault'));
  const before = Date.now(); await until(() => Date.now() - before > 100);
  assert.equal(events(f.store, 'operations.fault').length, 1, 'deduplicated');
  assert.equal(events(f.store, 'operations.fault')[0].recoveryHold, false);
  assert.notEqual(f.store.meta('recoveryHold'), true, 'no hold for a fault that does not threaten state integrity');
  assert.match(snapshot(f.store).health.operationsFault.error, /cannot be dispatched/);
  mode = 'ok';
  await until(() => f.store.meta('operationsFault') === null);
  assert.equal(events(f.store, 'operations.recovered').length, 1);
  mode = 'integrity';
  await until(() => f.store.meta('recoveryHold') === true);
  assert.equal(f.store.meta('recoveryHoldReason').cause, 'operations-fault');
  // The reason a flow stops under the hold names what happened.
  assert.throws(() => authorized(f.store, { taskId: f.task.id }), /^Error: recovery hold: the operations loop hit a state-integrity fault \(disk I\/O error\); reconcile .*restore\.release$/);
  mode = 'ok'; await close();
  assert.equal(f.command('restore.release', { note: 'Database checked after the fictional fault' }).status, 'completed');
  assert.equal(f.store.meta('recoveryHold'), false); assert.equal(f.store.meta('recoveryHoldReason'), null);
});

test('a restored project is held with its cause recorded', t => {
  const f = sandbox(t), out = join(f.base, 'backup'), target = join(f.base, 'restored');
  backupProject(f.stateDir, out); restoreProject(out, target);
  const store = new Store(target);
  try {
    assert.equal(store.meta('recoveryHoldReason').cause, 'restore');
    assert.match(snapshot(store).recoveryHoldReason.cause, /restore/);
  } finally { store.close(); }
});

// ---- F19: config update keeps only values actually changed live ----

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 1 } };
const withPolicy = policy => ({ ...base, policy: { ...base.policy, ...policy } });
function delivery(t) { const f = sandbox(t); assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed'); return f; }

test('a file change to a live key nobody changed live is applied', t => {
  const f = delivery(t);
  const update = f.command('config.update', { config: withPolicy({ queueOnApproval: true, maxFlows: 2 }), note: 'Turn on queue-on-approval in the file' });
  assert.equal(update.status, 'completed', update.error);
  assert.deepEqual(update.result.keptLiveSettings, []);
  assert.equal(f.store.meta('config').policy.queueOnApproval, true); assert.equal(f.store.meta('config').policy.maxFlows, 2);
});

test('a value changed live is kept and reported with who changed it, when, and whether the file changed it too', t => {
  const f = delivery(t);
  assert.equal(as(f, 'orchestrator', 'settings.update', { changes: { 'policy.maxFlows': 3 }, note: 'Operator asked for three' }, { onBehalfOf: instruction }).status, 'completed');
  assert.equal(f.command('settings.update', { changes: { 'policy.autoQueue': true }, note: 'Queue on' }).status, 'completed');
  const update = f.command('config.update', { config: withPolicy({ maxFlows: 2, queueRanking: true }), note: 'File edits maxFlows; autoQueue untouched' });
  assert.equal(update.status, 'completed', update.error);
  assert.deepEqual(update.result.keptLiveSettings.sort(), ['policy.autoQueue', 'policy.maxFlows']);
  const detail = Object.fromEntries(update.result.keptLiveDetails.map(row => [row.setting, row]));
  assert.equal(detail['policy.maxFlows'].changedBy, 'orchestrator'); assert.deepEqual(detail['policy.maxFlows'].onBehalfOf, instruction);
  assert.equal(detail['policy.maxFlows'].fileChanged, true); assert.equal(detail['policy.maxFlows'].fileValue, 2); assert.equal(detail['policy.maxFlows'].liveValue, 3);
  assert.ok(Date.parse(detail['policy.maxFlows'].changedAt));
  assert.equal(detail['policy.autoQueue'].changedBy, 'operator'); assert.equal(detail['policy.autoQueue'].fileChanged, false);
  const config = f.store.meta('config');
  assert.equal(config.policy.maxFlows, 3); assert.equal(config.policy.autoQueue, true); assert.equal(config.policy.queueRanking, true, 'the untouched key follows the file');
  // The kept values are still live changes: the same file again keeps them, now with the file unchanged.
  const again = f.command('config.update', { config: withPolicy({ maxFlows: 2, queueRanking: true }), note: 'Same file' });
  assert.deepEqual(again.result.keptLiveSettings.sort(), ['policy.autoQueue', 'policy.maxFlows']);
  assert.equal(again.result.keptLiveDetails.find(row => row.setting === 'policy.maxFlows').fileChanged, false);
  // --replace-live takes the file's values and forgets the live changes.
  assert.equal(f.command('config.update', { config: withPolicy({ maxFlows: 2 }), note: 'Take the file', replaceLive: true }).status, 'completed');
  assert.equal(f.store.meta('config').policy.maxFlows, 2); assert.equal(f.store.meta('config').policy.autoQueue, undefined);
  const after = f.command('config.update', { config: withPolicy({ maxFlows: 4 }), note: 'Plain file change' });
  assert.deepEqual(after.result.keptLiveSettings, []); assert.equal(f.store.meta('config').policy.maxFlows, 4);
});

test('a live change set back to the committed value is no longer a live change', t => {
  const f = delivery(t);
  f.command('settings.update', { changes: { 'policy.maxFlows': 3 }, note: 'Up' });
  f.command('settings.update', { changes: { 'policy.maxFlows': 1 }, note: 'Back' });
  const update = f.command('config.update', { config: withPolicy({ maxFlows: 2 }), note: 'File change' });
  assert.deepEqual(update.result.keptLiveSettings, []); assert.equal(f.store.meta('config').policy.maxFlows, 2);
});

test('projects from earlier releases rebuild live-change provenance from their event log', t => {
  const f = delivery(t);
  f.command('settings.update', { changes: { 'policy.maxFlows': 3 }, note: 'Live change before the upgrade' });
  // An earlier release kept a key nobody changed live (the defect): it is not a live change.
  f.store.tx(() => f.store.event('config.updated', { digest: 'x', note: 'old' }));
  f.store.tx(() => f.store.event('config.kept-live-settings', { settings: ['policy.maxFlows', 'policy.queueOnApproval'] }));
  f.store.setMeta('liveSettingChanges', null);
  const update = f.command('config.update', { config: withPolicy({ maxFlows: 2, queueOnApproval: true }), note: 'After upgrade' });
  assert.deepEqual(update.result.keptLiveSettings, ['policy.maxFlows']);
  assert.equal(update.result.keptLiveDetails[0].changedBy, 'operator'); assert.equal(update.result.keptLiveDetails[0].fileChanged, null, 'the earlier file is unknown');
  assert.equal(f.store.meta('config').policy.queueOnApproval, true);
});

test('operator-only live settings stay operator-only through config update', t => {
  const f = delivery(t), widen = withPolicy({ delegatedOperations: ['answer', 'config.update', 'settings.update'] });
  const refused = as(f, 'orchestrator', 'config.update', { config: widen, note: 'Operator asked' }, { onBehalfOf: instruction });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /operator-only settings \(policy\.delegatedOperations\)/);
  // The operator narrowed it live; a delegated update with a stale file keeps the operator's value.
  assert.equal(f.command('settings.update', { changes: { 'policy.delegatedOperations': ['config.update', 'settings.update'] }, note: 'Narrow' }).status, 'completed');
  const kept = as(f, 'orchestrator', 'config.update', { config: withPolicy({ maxFlows: 2 }), note: 'Operator asked' }, { onBehalfOf: instruction });
  assert.equal(kept.status, 'completed', kept.error); assert.deepEqual(kept.result.keptLiveSettings, ['policy.delegatedOperations']);
  assert.deepEqual(f.store.meta('config').policy.delegatedOperations, ['config.update', 'settings.update']);
});

// ---- F22: enabling notifications sends what is still open, not the backlog ----

test('turning notification delivery on keeps open items and supersedes the settled backlog', t => {
  const f = delivery(t);
  f.command('inbox.publish', { id: 'open-question', kind: 'question', title: 'Pick', context: 'Two options', question: 'Which?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  f.command('inbox.publish', { id: 'old-notice', kind: 'notice', title: 'Old', context: 'Settled long ago' });
  f.command('inbox.publish', { id: 'answered', kind: 'question', title: 'Pick again', context: 'Two options', question: 'Which?', choices: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
  for (const id of ['open-question', 'old-notice', 'answered']) notifications.queueDelivery(f.store, { inboxId: id });
  f.command('inbox.ack', { inboxId: 'old-notice' });
  const answered = f.store.need('inbox', 'answered');
  assert.equal(f.command('answer', { inboxId: 'answered', version: answered.version, subjectDigest: answered.subjectDigest, answer: 'a' }).status, 'completed');
  for (const id of ['old-notice', 'answered']) notifications.queueDelivery(f.store, { inboxId: id });
  const configPath = join(f.base, 'notifications.json');
  const update = f.command('config.update', { config: { ...base, notifications: { configPath } }, note: 'Wire the orchestrator' });
  assert.equal(update.status, 'completed', update.error);
  assert.equal(update.result.notificationBacklog.kept, 1);
  assert.ok(update.result.notificationBacklog.superseded >= 2);
  const active = f.store.all('delivery').filter(row => ['pending', 'sending', 'accepted'].includes(row.status));
  assert.deepEqual(active.map(row => row.inboxId), ['open-question']);
  assert.equal(events(f.store, 'notification.backlog-trimmed').length, 1);
  // A later update that does not start delivery leaves deliveries alone.
  f.command('inbox.publish', { id: 'new-notice', kind: 'notice', title: 'New', context: 'After wiring' }); f.command('inbox.ack', { inboxId: 'new-notice' }); notifications.queueDelivery(f.store, { inboxId: 'new-notice' });
  const later = f.command('config.update', { config: { ...base, notifications: { configPath } }, note: 'Unrelated' });
  assert.equal(later.result.notificationBacklog, undefined);
  assert.ok(f.store.all('delivery').some(row => row.inboxId === 'new-notice' && row.status === 'pending'));
});

// ---- F23: import-task honors the actor ----

const issue = { id: 10, number: 4, title: 'Fictional imported task', state: 'open', body: '```factotum-task\n' + JSON.stringify({ version: 1, acceptance: ['Fictional outcome'], risk: 'ordinary' }) + '\n```', labels: [] };
const issueTransport = async request => request.path === 'graphql' ? { data: { repository: { issue: { parent: null } } } } : structuredClone(issue);
test('an import is recorded as the acting orchestrator, with its instruction, under the usual authority rules', async t => {
  const f = sandbox(t); f.store.setMeta('config', { repository: { slug: 'fictional/demo' } });
  await assert.rejects(importGitHubTask(f.stateDir, 4, { transport: issueTransport, actor: 'orchestrator' }), /operator authority required/);
  const task = await importGitHubTask(f.stateDir, 4, { transport: issueTransport, actor: 'orchestrator', onBehalfOf: instruction });
  assert.equal(task.id, 'github:4');
  const receipt = f.store.commandHistory().find(row => row.operation === 'task.put' && row.status === 'completed' && row.result?.id === 'github:4');
  assert.equal(receipt.actor, 'orchestrator'); assert.deepEqual(receipt.onBehalfOf, instruction);
  const approve = as(f, 'orchestrator', 'task.approve', { taskId: task.id, revision: task.revision }, { onBehalfOf: instruction });
  assert.equal(approve.status, 'completed', approve.error);
  const approved = events(f.store, 'task.approved').at(-1);
  assert.equal(approved.by, 'orchestrator'); assert.deepEqual(approved.onBehalfOf, instruction);
});

// ---- CLI: F23 (--actor), F17 (one JSON document), F1 (help for every subcommand) ----

function cliProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'factotum-ops-cli-')), repo = join(root, 'repo'), state = join(root, 'state');
  mkdirSync(repo); execFileSync('git', ['init', '-q'], { cwd: repo });
  const workflow = join(root, 'workflow.json'); writeFileSync(workflow, JSON.stringify({ version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } }));
  execFileSync(process.execPath, [cli, 'init', '--state', state, '--root', repo, '--name', 'Fictional CLI', '--workflow', workflow, '--supervisor', 'process']);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo, state };
}

test('import-task requires --actor like every other command', async t => {
  const p = cliProject(t);
  await assert.rejects(execute(process.execPath, [cli, 'import-task', '--state', p.state, '--issue', '4']), error => /--actor operator\|orchestrator is required/.test(error.stderr));
});

test('config update prints exactly one JSON document, messages included, and nothing on stderr', async t => {
  const p = cliProject(t), file = join(p.root, 'config.json'); writeFileSync(file, JSON.stringify({ version: 1 }));
  const { stdout, stderr } = await execute(process.execPath, [cli, 'config', 'update', '--state', p.state, '--config', file, '--note', 'Fictional update', '--actor', 'operator']);
  assert.equal(stderr, '');
  const receipt = JSON.parse(stdout);
  assert.equal(receipt.status, 'completed');
  assert.ok(receipt.messages.some(message => /Commissioning cleared/.test(message)));
});

test('every CLI subcommand has --help that prints its usage and runs nothing', async t => {
  const p = cliProject(t), absent = join(p.root, 'never-created');
  await Promise.all(Object.keys(help.CLI_HELP).map(async key => {
    const { stdout } = await execute(process.execPath, [cli, ...key.split(' '), '--help', '--state', absent, '--root', p.repo, '--name', 'x', '--out', absent, '--from', absent]);
    assert.match(stdout, new RegExp(`^Usage: ${key.replace('.', '\\.')}`), key);
    assert.match(stdout, /Options:\n/, key);
  }));
  assert.equal(existsSync(absent), false, 'help has no side effects');
  // A command with actions and no action named lists its actions.
  assert.match((await execute(process.execPath, [cli, 'adopt', '--help'])).stdout, /adopt install --root/);
  assert.match((await execute(process.execPath, [cli, 'config', 'update', '--help'])).stdout, /--replace-live/);
});

// ---- F35: non-delegable operations say so consistently ----

test('provider.hold is operator only: help and refusal agree it cannot be delegated', t => {
  const f = sandbox(t);
  const refused = as(f, 'orchestrator', 'provider.hold', { provider: 'codex', action: 'clear', note: 'Operator asked' }, { onBehalfOf: instruction });
  assert.equal(refused.status, 'rejected'); assert.match(refused.error, /cannot be delegated/); assert.doesNotMatch(refused.error, /can list it in policy/);
  assert.match(help.commandHelp('provider.hold').text, /cannot be delegated/);
  const unnamed = f.command('schedule.remove', { id: 'fictional' });
  assert.equal(unnamed.status, 'rejected'); assert.match(unnamed.error, /needs scheduleId/);
});

test('a real SQLite full-disk failure keeps its cause and places a recovery hold', async t => {
  // Seen in review: SQLite rolled back on SQLITE_FULL and the explicit ROLLBACK's error replaced it.
  const { threatensStateIntegrity, recordOperationsFault } = await import('../starter/factory/operations/recovery-hold.mjs');
  const f = sandbox(t);
  const pages = f.store.db.prepare('PRAGMA page_count').get().page_count;
  f.store.db.exec(`PRAGMA max_page_count=${pages + 2}`);
  let failure;
  try { f.store.tx(() => { for (let i = 0; i < 64; i++) f.store.put('flow', { id: `filler-${i}`, padding: 'x'.repeat(64 * 1024) }); }); } catch (error) { failure = error; }
  f.store.db.exec('PRAGMA max_page_count=1073741823');
  assert.ok(failure, 'the oversized write fails');
  assert.equal(threatensStateIntegrity(failure), true, `classified as an integrity fault: ${failure.message}`);
  recordOperationsFault(f.store, failure);
  assert.equal(f.store.meta('recoveryHold'), true);
});

test('a notification signing key that is not a non-empty string is a configuration problem', t => {
  const dir = mkdtempSync(join(tmpdir(), 'factotum-signing-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'notify.json');
  writeFileSync(path, JSON.stringify({ url: 'https://example.invalid/hook', signingKey: { nested: true } }), { mode: 0o600 }); chmodSync(path, 0o600);
  assert.throws(() => notifications.readDeliveryConfig(path), /signingKey must be a non-empty string/);
  writeFileSync(path, JSON.stringify({ url: 'https://example.invalid/hook', signingKey: 'fictional-key' }), { mode: 0o600 });
  assert.equal(notifications.readDeliveryConfig(path).signingKey, 'fictional-key');
});
