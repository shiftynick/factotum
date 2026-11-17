import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Store } from '../starter/factory/core/store.mjs';
import * as ops from '../starter/factory/operations/index.mjs';
function fixture(t) { const root = mkdtempSync(join(tmpdir(), 'factotum-operations-')), state = join(root, 'state'); const store = new Store(state, { create: true }); store.setMeta('project', { projectId: 'fictional' }); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); }); return { root, store }; }
function task(store, id = 'feature') { const row = { id, revision: 'v1', approvedRevision: 'v1', area: 'app', paths: ['src/main.js'] }; store.put('task', row); store.put('queue', { id, status: 'queued' }); return row; }
test('admission holds stale health, changed approval, overlap, dependencies; claim rollback is atomic', t => {
  const { store } = fixture(t), row = task(store); const nowMs = Date.now();
  assert.match(ops.admissionReasons(store, row).join(), /main health/);
  store.setMeta('mainHealth', { status: 'green', checkedAt: new Date(nowMs).toISOString() });
  assert.deepEqual(ops.admissionReasons(store, row), []);
  assert.match(ops.admissionReasons(store, { ...row, approvedRevision: 'v0' }).join(), /approval/);
  assert.match(ops.admissionReasons(store, { ...row, dependencies: ['missing'] }).join(), /dependency/);
  assert.throws(() => ops.claimCandidate(store, { admit: (task, s) => { s.put('flow', { id: 'flow', taskId: task.id, state: 'ready' }); throw new Error('injected crash'); } }), /injected/);
  assert.equal(store.get('flow', 'flow'), undefined); assert.equal(store.get('queue', row.id).status, 'queued');
  ops.claimCandidate(store, { admit: (task, s) => s.put('flow', { id: 'flow', taskId: task.id, state: 'ready' }) });
  const other = task(store, 'other'); assert.match(ops.admissionReasons(store, other, { policy: { maxFlows: 2 } }).join(), /area occupied.*paths overlap/);
});
test('durable schedules bounded catchup, rollback, restart dedupe, DST skip and once-per-local-day', t => {
  const { store } = fixture(t); const start = Date.parse('2026-01-01T00:00:00Z');
  store.put('schedule', { id: 'interval', type: 'interval', anchorMs: start, everyMs: 1000, enabled: true, createdAt: new Date(start).toISOString() });
  assert.throws(() => ops.dispatchSchedules(store, { nowMs: start + 5000, dispatch: () => { throw new Error('crash'); } }), /crash/);
  assert.equal(store.all('occurrence').length, 0);
  const dispatch = (s, o) => ({ commandId: o.key });
  assert.equal(ops.dispatchSchedules(store, { nowMs: start + 5000, maxCatchUp: 2, dispatch }).length, 2);
  assert.equal(ops.dispatchSchedules(store, { nowMs: start + 5000, maxCatchUp: 2, dispatch }).length, 2);
  assert.equal(ops.dispatchSchedules(store, { nowMs: start + 5000, maxCatchUp: 2, dispatch }).length, 1);
  assert.equal(ops.dispatchSchedules(store, { nowMs: start + 5000, dispatch }).length, 0);
  const daily = { id: 'dst', type: 'daily', timezone: 'America/New_York', timeOfDay: '02:30' };
  assert.equal(ops.dueOccurrences(daily, { afterMs: Date.parse('2026-03-08T05:00Z'), nowMs: Date.parse('2026-03-09T04:00Z') }).length, 0);
  assert.equal(ops.dueOccurrences({ ...daily, timeOfDay: '01:30' }, { afterMs: Date.parse('2026-11-01T04:00Z'), nowMs: Date.parse('2026-11-02T05:00Z'), windowMs: 2 * 86400000 }).length, 1);
});
test('host resource ownership prevents project collision and never steals uncertain leases', t => {
  const { root } = fixture(t), path = join(root, 'host.sqlite'); let owner = 'alive'; const a = new ops.HostResources(path, { inspectOwner: () => owner }), b = new ops.HostResources(path, { inspectOwner: () => owner });
  t.after(() => { a.close(); b.close(); });
  const lease = a.acquire({ projectId: 'one', flowId: 'f', attemptId: 'a' });
  assert.equal(b.acquire({ projectId: 'two', flowId: 'f', attemptId: 'b' }), null);
  owner = 'uncertain'; assert.equal(b.reconcile('heavy-work'), 'uncertain'); assert.equal(b.acquire({ projectId: 'two', flowId: 'f', attemptId: 'b' }), null);
  assert.throws(() => b.release('heavy-work', 'wrong'), /ownership/);
  owner = 'dead'; assert.ok(b.acquire({ projectId: 'two', flowId: 'f', attemptId: 'b' })); assert.notEqual(a.get('heavy-work').token, lease.token);
});
test('resource coordinator actually serializes simultaneous processes', async t => {
  const { root } = fixture(t), db = join(root, 'contenders.sqlite'), module = new URL('../starter/factory/operations/resources.mjs', import.meta.url).href;
  // Each contender keeps its coordinator open until both have reported, however slowly either starts.
  const code = `import {HostResources} from ${JSON.stringify(module)};const r=new HostResources(process.argv[1]);const x=r.acquire({projectId:process.argv[2],flowId:'f',attemptId:'a'});console.log(x?'won':'blocked');process.stdin.resume();process.stdin.on('end',()=>r.close());`;
  const children = ['one', 'two'].map(id => spawn(process.execPath, ['--input-type=module', '-e', code, db, id], { stdio: ['pipe', 'pipe', 'pipe'] }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); });
  const exits = children.map(child => new Promise(resolve => child.on('exit', resolve)));
  const results = await Promise.all(children.map((child, index) => new Promise((resolve, reject) => { let output = '', error = ''; child.stderr.on('data', b => error += b); child.on('error', reject); exits[index].then(code => reject(new Error(`contender exited ${code} before reporting: ${error}`))); child.stdout.on('data', b => { output += b; if (output.includes('\n')) resolve(output.trim()); }); })));
  for (const child of children) child.stdin.end();
  assert.deepEqual(await Promise.all(exits), [0, 0]);
  assert.deepEqual(results.sort(), ['blocked', 'won']);
});
test('monetary cap holds unknowns, paid requires enforcement, overruns record actual and stop', t => {
  const { store } = fixture(t); const input = { id: 'one', flowId: 'flow', ceilingMicros: 60, capMicros: 100 };
  assert.throws(() => ops.reserveMoney(store, input), /disabled/);
  ops.reserveMoney(store, { ...input, capability: { enforceableCeiling: true } }); ops.settleMoney(store, 'one', null);
  assert.throws(() => ops.reserveMoney(store, { ...input, id: 'two', capability: { enforceableCeiling: true } }), /cap exhausted/);
  ops.settleMoney(store, 'one', 80); assert.equal(store.get('money', 'one').status, 'overrun'); assert.equal(store.meta('paused'), true);
  assert.throws(() => ops.settleMoney(store, 'one', 79), /conflicting/);
});
test('context fails closed, refuses symlink escapes and redelivers changed stable IDs', t => {
  const { root, store } = fixture(t); writeFileSync(join(root, 'guide'), 'first');
  const config = { maxChars: 40, files: [{ id: 'rules', path: 'guide', required: true }, { id: 'optional', path: 'absent' }] };
  let context = ops.assembleContext({ repoRoot: root, config }); assert.equal(context.omitted[0].reason, 'unavailable or outside project');
  assert.equal(ops.contextDelivery(store, { consumerId: 'worker', context }).files.length, 1); ops.acknowledgeContext(store, { consumerId: 'worker', context }); assert.equal(ops.contextDelivery(store, { consumerId: 'worker', context }).files.length, 0);
  writeFileSync(join(root, 'guide'), 'second'); context = ops.assembleContext({ repoRoot: root, config }); assert.equal(ops.contextDelivery(store, { consumerId: 'worker', context }).files.length, 1);
  assert.throws(() => ops.assembleContext({ repoRoot: root, config: { ...config, maxChars: 1 } }), /exceeds budget/);
});
test('notification retry is durable, acceptance and acknowledgment never answer canonical inbox', async t => {
  const { root, store } = fixture(t), configPath = join(root, 'notification.json'), nowMs = Date.now();
  writeFileSync(configPath, JSON.stringify({ url: 'https://fictional.invalid/private-token', signingKey: 'fictional-secret' }), { mode: 0o600 });
  store.put('inbox', { id: 'question', version: 1, status: 'open' }); const delivery = ops.queueDelivery(store, { inboxId: 'question', nowMs });
  await ops.deliverDue(store, { configPath, nowMs, transport: async () => { throw new Error('private-token fictional-secret'); } }); assert.equal(store.get('delivery', delivery.id).status, 'pending');
  await ops.deliverDue(store, { configPath, nowMs: nowMs + 30001, transport: async request => { assert.ok(request.headers['x-factotum-signature']); return { status: 202 }; } });
  ops.acknowledgeDelivery(store, { deliveryId: delivery.id }); assert.equal(store.get('inbox', 'question').status, 'open'); assert.equal(store.get('delivery', delivery.id).status, 'accepted');
  assert.doesNotMatch(JSON.stringify(store.all('delivery')) + JSON.stringify(store.events()), /private-token|fictional-secret/);
  chmodSync(configPath, 0o644); assert.throws(() => ops.readDeliveryConfig(configPath), /0600/);
});
test('audit dedup, measured unknowns, retention preserves obligations and validates explicit manifest', t => {
  const { root, store } = fixture(t); const findings = [{ title: 'Fictional issue', evidence: 'fixture:1' }];
  ops.auditFindings(store, { findings }); ops.auditFindings(store, { findings }); assert.equal(store.all('finding').length, 1); assert.equal(store.all('finding')[0].status, 'unapproved'); assert.equal(ops.metrics(store).duration.meanMs, null);
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts); writeFileSync(join(artifacts, 'keep'), 'keep'); writeFileSync(join(artifacts, 'drop'), 'drop');
  const preservation = () => ({ complete: true, protectedPaths: ['keep'], evidence: 'fixture inventory' });
  const manifest = ops.retentionPlan(store, { artifactRoot: artifacts, candidates: ['keep', 'drop'], preservation }); assert.equal(manifest.deletions.length, 1);
  assert.throws(() => ops.applyRetention(store, { manifest, approvedDigest: 'wrong', preservation }), /approved/);
  ops.applyRetention(store, { manifest, approvedDigest: manifest.digest, preservation }); assert.ok(existsSync(join(artifacts, 'keep'))); assert.equal(existsSync(join(artifacts, 'drop')), false);
  assert.match(ops.retentionPlan(store, { artifactRoot: artifacts, candidates: ['keep'], preservation: () => { throw new Error(); } }).skipped, /failed/);
});
test('upgrade stages immutable versions and preserves current pointer on failed verification', t => {
  const { root, store } = fixture(t), sourceDir = join(root, 'source'), installRoot = join(root, 'install'); mkdirSync(sourceDir); writeFileSync(join(sourceDir, 'runtime.mjs'), 'fictional');
  const compatibility = { schemaVersions: [1], configVersions: [1] }; ops.stageUpgrade(store, { sourceDir, installRoot, version: '1', compatibility });
  assert.throws(() => ops.finishUpgrade(store, { version: '1', verify: () => false }), /verification failed/); assert.equal(existsSync(join(installRoot, 'current.json')), false);
  ops.finishUpgrade(store, { version: '1', verify: () => true }); assert.equal(JSON.parse(readFileSync(join(installRoot, 'current.json'))).version, '1');
  store.put('flow', { id: 'active', state: 'ready' }); assert.equal(ops.upgradePreflight(store, compatibility).ok, false);
});

test('notification reminders recur and acknowledgment only defers canonical open questions', async t => {
  const { root, store } = fixture(t), nowMs = Date.now(), configPath = join(root, 'reminder.json'); writeFileSync(configPath, JSON.stringify({ url: 'https://fictional.invalid/remind' }), { mode: 0o600 }); store.put('inbox', { id: 'reminder', version: 1, status: 'open' }); const row = ops.queueDelivery(store, { inboxId: 'reminder', nowMs }); let sends = 0; const transport = async () => { sends++; return { status: 200 }; };
  await ops.deliverDue(store, { configPath, transport, nowMs }); await ops.deliverDue(store, { configPath, transport, nowMs: nowMs + 1800001 }); assert.equal(sends, 2);
  ops.acknowledgeDelivery(store, { deliveryId: row.id, nowMs: nowMs + 1800001 }); await ops.deliverDue(store, { configPath, transport, nowMs: nowMs + 3600000 }); assert.equal(sends, 2); await ops.deliverDue(store, { configPath, transport, nowMs: nowMs + 1800001 + 4 * 3600000 }); assert.equal(sends, 3);
  store.put('inbox', { id: 'reminder', version: 2, status: 'answered' }); await ops.deliverDue(store, { configPath, transport, nowMs: nowMs + 86400000 }); assert.equal(sends, 3); assert.equal(store.get('delivery', row.id).status, 'superseded');
});
