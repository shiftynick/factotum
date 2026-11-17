import test from 'node:test';
import assert from 'node:assert/strict';
import { sandbox } from './helpers.mjs';
import { ensureMainVerification, probeTargetHead } from '../starter/factory/operations/main-freshness.mjs';
import { mainHealthReason } from '../starter/factory/operations/main-health-reason.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

const base = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { autoQueue: true } };
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
function setup(t, health) {
  const f = sandbox(t);
  assert.equal(f.command('config.update', { config: base, note: 'Delivery' }).status, 'completed');
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  f.store.setMeta('mainHealth', health);
  const put = f.command('task.put', { task: { id: 'change', title: 'A change', acceptance: ['Done'] } }).result;
  assert.equal(f.command('task.approve', { taskId: 'change', revision: put.revision, queue: true }).status, 'completed');
  return f;
}
const days = n => new Date(Date.now() - n * 86400000).toISOString();

test('queued work held by stale main health gets one verification request and a reason that says why', t => {
  const f = setup(t, { status: 'green', head: OLD, checkedAt: days(3) });
  const reasons = admissionReasons(f.store, f.store.need('task', 'change'));
  assert.ok(reasons.some(r => /main health is stale: last verified .* at aaaaaaaaaaaa, older than policy.mainHealthMaxAgeMs; a main verification is requested automatically/.test(r)), reasons.join('; '));
  const id = f.store.tx(() => ensureMainVerification(f.store));
  assert.match(id, /^main-refresh:/);
  assert.equal(f.store.tx(() => ensureMainVerification(f.store)), null, 'only one at a time');
  assert.match(mainHealthReason(f.store), /main verification in progress/);
});

test('no request for recent red health, recently failed verification, or without autoQueue', t => {
  const red = setup(t, { status: 'red', head: OLD, checkedAt: new Date().toISOString() });
  assert.equal(red.store.tx(() => ensureMainVerification(red.store)), null);
  const failed = setup(t, { status: 'green', head: OLD, checkedAt: days(3) });
  failed.store.put('job', { id: 'earlier', operation: 'main.verify', status: 'failed', createdAt: new Date().toISOString(), finishedAt: new Date().toISOString() });
  assert.equal(failed.store.tx(() => ensureMainVerification(failed.store)), null);
  const manual = setup(t, { status: 'green', head: OLD, checkedAt: days(3) });
  manual.store.setMeta('config', { ...manual.store.meta('config'), policy: { autoQueue: false } });
  assert.equal(manual.store.tx(() => ensureMainVerification(manual.store)), null);
  assert.match(mainHealthReason(manual.store), /run main.verify to refresh it/);
});

test('a target head that moved outside the factory makes health unknown, at most one probe a minute', async t => {
  const f = setup(t, { status: 'green', head: OLD, checkedAt: new Date().toISOString() });
  let calls = 0; const run = async () => { calls++; return { code: 0, stdout: `${NEW}\trefs/heads/main\n` }; };
  const nowMs = Date.now();
  assert.deepEqual(await probeTargetHead(f.store, { nowMs, run }), { head: NEW, moved: true });
  const health = f.store.meta('mainHealth');
  assert.equal(health.status, 'unknown'); assert.equal(health.head, NEW); assert.match(health.reason, /moved outside the factory from aaaaaaaaaaaa to bbbbbbbbbbbb/);
  assert.equal(await probeTargetHead(f.store, { nowMs: nowMs + 1000, run }), null); assert.equal(calls, 1);
  assert.match(f.store.tx(() => ensureMainVerification(f.store)), /^main-refresh:/, 'and verification is requested');
  f.store.setMeta('mainHealth', { status: 'green', head: NEW, checkedAt: new Date().toISOString() });
  assert.deepEqual(await probeTargetHead(f.store, { nowMs: nowMs + 120000, run: async () => ({ code: 0, stdout: `${NEW}\trefs/heads/main\n` }) }), null, 'verification in progress: no probe');
});

test('policy.mainProbeMs sets how often main is checked, and 0 turns the check off', async t => {
  const f = setup(t, { status: 'green', head: OLD, checkedAt: new Date().toISOString() });
  let calls = 0; const run = async () => { calls++; return { code: 0, stdout: `${OLD}\trefs/heads/main\n` }; };
  const config = f.store.meta('config'), nowMs = Date.now();
  f.store.setMeta('config', { ...config, policy: { ...config.policy, mainProbeMs: 600000 } });
  await probeTargetHead(f.store, { nowMs, run }); await probeTargetHead(f.store, { nowMs: nowMs + 120000, run });
  assert.equal(calls, 1, 'not again within ten minutes');
  await probeTargetHead(f.store, { nowMs: nowMs + 600000, run }); assert.equal(calls, 2);
  f.store.setMeta('config', { ...config, policy: { ...config.policy, mainProbeMs: 0 } });
  assert.equal(await probeTargetHead(f.store, { nowMs: nowMs + 3600000, run }), null); assert.equal(calls, 2, 'off');
  assert.equal(f.command('config.update', { config: { ...base, policy: { ...base.policy, mainProbeMs: 500 } }, note: 'x', replaceLive: true }).status, 'rejected');
  assert.equal(f.command('settings.update', { changes: { 'policy.mainProbeMs': 500 }, note: 'x' }).status, 'rejected');
});

test('the operations loop requests and starts the verification on its own', async t => {
  const f = setup(t, { status: 'green', head: OLD, checkedAt: days(3) });
  await operationalTick(f.store);
  const job = f.store.all('job').find(j => j.id.startsWith('main-refresh:'));
  assert.ok(job, 'requested'); assert.notEqual(job.status, 'revoked', job.reason);
  assert.equal(job.status, 'running'); assert.ok(f.store.get('flow', job.flowId));
});
