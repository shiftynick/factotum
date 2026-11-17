import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { runDoctorRequest } from '../starter/factory/operations/doctor-request.mjs';
import { settingsView } from '../starter/factory/operations/views.mjs';
import { publicValue } from '../starter/factory/service/project-service.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { maxFlows: 1 } };
function setup(t) {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  return f;
}

test('a live setting changes without draining work, touching the digest or clearing doctor', t => {
  const f = setup(t), digest = f.store.meta('configDigest');
  f.store.put('flow', { id: 'running', taskId: 'task-1', state: 'ready', kind: 'change', configDigest: digest, workflow: { nodes: {} } });
  const changed = f.command('settings.update', { changes: { 'policy.autoQueue': true, 'policy.maxFlows': 3, 'notifications.level': 'all' }, expected: { 'policy.autoQueue': false }, note: 'Turn on the queue' });
  assert.equal(changed.status, 'completed', changed.error);
  assert.equal(f.store.meta('configDigest'), digest, 'digest unchanged');
  assert.equal(f.store.meta('commissioning').configDigest, digest, 'doctor still current');
  assert.equal(f.store.meta('config').policy.autoQueue, true); assert.equal(f.store.meta('config').policy.maxFlows, 3); assert.equal(f.store.meta('config').notifications.level, 'all');
  assert.equal(f.command('settings.update', { changes: { 'policy.autoQueue': false }, expected: { 'policy.autoQueue': false }, note: 'stale' }).status, 'rejected', 'a stale read is refused');
  assert.equal(f.command('settings.update', { changes: { 'policy.autoMerge': true }, note: 'x' }).status, 'rejected', 'pinned settings need config update');
  assert.equal(f.command('settings.update', { changes: { 'policy.maxFlows': 0 }, note: 'x' }).status, 'rejected', 'still validated');
  assert.equal(f.command('settings.update', { changes: { 'policy.maxFlows': null }, note: 'Reset' }).result.values['policy.maxFlows'], 1, 'null resets to the default');
  const view = settingsView(f.store);
  assert.deepEqual(publicValue(f.store, view).checks[0].command, ['true'], 'check commands reach the console');
  assert.equal(view.live['policy.autoQueue'].value, true); assert.equal(view.live['policy.maxTaskFlows'].isDefault, true); assert.equal(view.pinned.planning.value, true);
});

test('the orchestrator may change live settings for the operator, but not its own delegation', t => {
  const f = setup(t), send = (changes) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'settings.update', payload: { changes, note: 'Operator asked' }, onBehalfOf: { principal: 'operator', instruction: 'Turn on the queue' } });
  assert.equal(send({ 'policy.autoQueue': true }).status, 'completed');
  const widen = send({ 'policy.delegatedOperations': ['answer', 'settings.update'] });
  assert.equal(widen.status, 'rejected'); assert.match(widen.error, /only be changed by the operator/);
  assert.equal(f.command('settings.update', { changes: { 'policy.delegatedOperations': ['answer'] }, note: 'Narrow' }).status, 'completed', 'the operator can');
});

test('config update keeps console changes unless told to take the file', t => {
  const f = setup(t);
  f.command('settings.update', { changes: { 'policy.autoQueue': true }, note: 'x' });
  const kept = f.command('config.update', { config: { ...base, context: { files: [], maxChars: 2000 } }, note: 'Pinned change' });
  assert.deepEqual(kept.result.keptLiveSettings, ['policy.autoQueue']); assert.equal(f.store.meta('config').policy.autoQueue, true); assert.equal(f.store.meta('config').context.maxChars, 2000);
  f.command('config.update', { config: base, note: 'Take the file', replaceLive: true });
  assert.equal(f.store.meta('config').policy.autoQueue, undefined);
});

test('a requested doctor run is started by the loop and its outcome recorded', async t => {
  const f = setup(t);
  assert.equal(f.command('doctor.request', { note: 'x' }).status, 'rejected', 'already qualified for this configuration');
  f.store.setMeta('commissioning', null);
  assert.equal(f.command('doctor.request', { note: 'After a config update' }).status, 'completed');
  assert.equal(f.command('doctor.request', { note: 'again' }).status, 'rejected', 'one at a time');
  await runDoctorRequest(f.store, { doctor: async () => ({ ready: false, reasons: ['nonempty mainChecks required'] }) });
  const request = f.store.meta('doctorRequest');
  assert.equal(request.status, 'failed'); assert.deepEqual(request.reasons, ['nonempty mainChecks required']);
  assert.equal(f.command('doctor.request', { note: 'Retry' }).status, 'completed', 'can run again after it finished');
});

test('actionable notification setting is validated, project-scoped and live across config updates', t => {
  const f = setup(t), other = setup(t), digest = f.store.meta('configDigest');
  f.store.put('flow', { id: 'running', taskId: 'task-1', state: 'ready', kind: 'change', configDigest: digest, workflow: { nodes: {} } });
  assert.equal(f.command('settings.update', { changes: { 'notifications.level': 'actionable' }, expected: { 'notifications.level': 'essential' }, note: 'Quiet routine summaries' }).status, 'completed');
  assert.equal(f.store.meta('configDigest'), digest);
  assert.equal(f.store.meta('commissioning').configDigest, digest);
  assert.equal(settingsView(f.store).live['notifications.level'].value, 'actionable');
  assert.deepEqual(settingsView(f.store).live['notifications.level'].options, ['essential', 'actionable', 'all']);
  assert.equal(settingsView(other.store).live['notifications.level'].value, 'essential');
  assert.equal(f.command('settings.update', { changes: { 'notifications.level': 'quiet' }, note: 'Invalid' }).status, 'rejected');
  f.store.put('flow', { ...f.store.need('flow', 'running'), state: 'completed' });
  const kept = f.command('config.update', { config: base, note: 'Keep live policy' });
  assert.equal(kept.status, 'completed', kept.error);
  assert.equal(f.store.meta('config').notifications.level, 'actionable');
  assert.equal(f.command('config.update', { config: { ...base, notifications: { level: 'actionable' } }, note: 'Canonical file policy', replaceLive: true }).status, 'completed');
  assert.equal(f.command('settings.update', { changes: { 'notifications.level': null }, note: 'Reset' }).result.values['notifications.level'], 'essential');
});

// Operator-only live settings are compared by effective value on every configuration writer, so a
// delegated config.update cannot do what a delegated settings.update is refused.
test('a delegated config.update cannot change operator-only live settings by any route; the operator can', t => {
  const f = setup(t), current = () => f.store.meta('config');
  const delegated = (payload) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'orchestrator', operation: 'config.update', payload: { note: 'Operator asked', ...payload }, onBehalfOf: { principal: 'operator', instruction: 'Fictional operator instruction' } });
  const refused = (result, pattern) => { assert.equal(result.status, 'rejected', JSON.stringify(result.result)); assert.match(result.error, pattern); };
  // replaceLive taking the file's values: switching the prompt off or postponing it.
  refused(delegated({ config: { ...base, notifications: { handoffAfterDeliveries: 0 } }, replaceLive: true }), /operator-only settings \(notifications\.handoffAfterDeliveries\)/);
  refused(delegated({ config: { ...base, notifications: { handoffRepeatDeliveries: 100000 } }, replaceLive: true }), /notifications\.handoffRepeatDeliveries/);
  // Delegation widening (policy.delegatedOperations had the same hole on non-migrated projects).
  assert.equal(f.command('settings.update', { changes: { 'policy.delegatedOperations': ['answer', 'config.update'], 'notifications.handoffAfterDeliveries': 200 }, note: 'Operator narrows delegation, raises the limit' }).status, 'completed');
  refused(delegated({ config: { ...base, policy: { ...base.policy, delegatedOperations: ['answer', 'config.update', 'task.approve'] } }, replaceLive: true }), /policy\.delegatedOperations/);
  // A replacement that drops the keys falls back to the defaults: still a change.
  refused(delegated({ config: base, replaceLive: true }), /policy\.delegatedOperations, notifications\.handoffAfterDeliveries/);
  // A mode change does not keep live values, so it is the same change.
  refused(delegated({ config: { version: 1, mode: 'rehearsal' } }), /policy\.delegatedOperations, notifications\.handoffAfterDeliveries/);
  assert.deepEqual(current().policy.delegatedOperations, ['answer', 'config.update']); assert.equal(current().notifications.handoffAfterDeliveries, 200);
  // Without replaceLive the current values are kept, so a delegated pinned change still works.
  const kept = delegated({ config: { ...base, context: { files: [], maxChars: 3000 }, notifications: { handoffAfterDeliveries: 0 } } });
  assert.equal(kept.status, 'completed', kept.error);
  assert.equal(current().notifications.handoffAfterDeliveries, 200); assert.equal(current().context.maxChars, 3000);
  // A delegated replaceLive that leaves the effective values alone (same set, any order) is allowed.
  assert.equal(delegated({ config: { ...base, policy: { ...base.policy, delegatedOperations: ['config.update', 'answer'] }, notifications: { handoffAfterDeliveries: 200 } }, replaceLive: true }).status, 'completed');
  // The operator may make every one of these changes.
  assert.equal(f.command('config.update', { config: { ...base, notifications: { handoffAfterDeliveries: 0, handoffRepeatDeliveries: 100000 } }, replaceLive: true, note: 'Operator turns it off' }).status, 'completed');
  assert.equal(current().notifications.handoffAfterDeliveries, 0);
  assert.equal(f.command('config.update', { config: { version: 1, mode: 'rehearsal' }, note: 'Operator changes mode' }).status, 'completed');
  assert.equal(current().notifications, undefined);
});
