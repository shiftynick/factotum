import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sandbox, until } from './helpers.mjs';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { snapshot } from '../starter/factory/core/project.mjs';
import { publicValue, startProjectService } from '../starter/factory/service/project-service.mjs';
import { observedStats, settingsView, workflowOrder, distribution } from '../starter/factory/operations/views.mjs';
import { requestProject } from '../starter/factory/console/client.mjs';
import { startConsole, registerProject } from '../starter/factory/console/console.mjs';

const template = JSON.parse(readFileSync(new URL('../starter/project/factotum.template.json', import.meta.url), 'utf8'));

function deliveryStore(t) {
  const base = mkdtempSync(join(tmpdir(), 'fct-views-')), root = join(base, 'repo'), stateDir = join(base, 'state');
  execFileSync('git', ['init', '-q', root]);
  const config = structuredClone(template);
  config.checks[0].argv = ['node', '-e', 'process.env.SECRET_SENTINEL_ARGV'];
  config.resources.coordinatorPath = join(base, 'PRIVATE-COORDINATOR.sqlite'); config.backupRoot = join(base, 'PRIVATE-BACKUPS');
  config.policy.privateIntegrationKey = 'PRIVATE-POLICY-TOKEN'; config.qualification = {qualified:false,targetFreshness:'strict-status',privateToken:'PRIVATE-QUALIFICATION-TOKEN'};
  config.workspace = { setup: [{ argv: ['PRIVATE-SETUP-ARGV'] }] };
  initProject({ stateDir, root, name: 'Fictional delivery views', config, supervisor: 'process' });
  const store = new Store(stateDir);
  t.after(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  return { store, base };
}

test('settings projection shows check commands read-only but omits private paths, setup commands and private fields', t => {
  const { store, base } = deliveryStore(t);
  const view = publicValue(store, snapshot(store)).settings;
  const text = JSON.stringify(view);
  for (const secret of ['PRIVATE-COORDINATOR', 'PRIVATE-BACKUPS', 'PRIVATE-SETUP-ARGV', 'PRIVATE-POLICY-TOKEN', 'PRIVATE-QUALIFICATION-TOKEN', base]) assert.ok(!text.includes(secret), `settings leaked ${secret}`);
  assert.equal(view.mode, 'delivery');
  assert.equal(view.checks[0].id, 'acceptance');
  assert.match(view.checks[0].commandDigest, /^[a-f0-9]{16,}$/);
  assert.deepEqual(view.checks[0].command, ['node', '-e', 'process.env.SECRET_SENTINEL_ARGV'], 'gate commands are shown read-only');
  assert.deepEqual(view.resources, { pools:{},operations:{},coordinatorConfigured: true, backupConfigured: true, workspaceSetupSteps: 1 });
  assert.equal(view.providers.reviewer.billingMode, 'subscription');
  assert.equal(view.commissioningRequired, true, 'uncommissioned delivery configuration must say so');
  assert.equal(view.activeFlows, 0);
  const kinds = view.workflow.steps.map(step => step.kind);
  assert.equal(view.workflow.steps[0].id, 'source');
  assert.ok(kinds.lastIndexOf('effect') < kinds.indexOf('end'), 'terminal steps follow working steps');
  assert.ok(!text.includes('"argv"'));
});

test('snapshot reports settings and carries no planning-ahead fields', t => {
  const f = sandbox(t), view = snapshot(f.store);
  const task = view.tasks.find(item => item.id === 'task-1');
  assert.equal(task.planningReasons, undefined); assert.equal(task.planReadiness, undefined);
  assert.equal(view.plans, undefined); assert.equal(view.planningUsage, undefined);
  assert.equal(snapshot(f.store).settings.mode, 'rehearsal');
  assert.equal(snapshot(f.store).settings.commissioningRequired, false);
});

test('observed statistics report samples and missing timing without inventing durations', t => {
  const f = sandbox(t);
  const s = f.store, at = offset => new Date(Date.parse('2026-01-01T00:00:00Z') + offset).toISOString();
  s.put('flow', { id: 'done-1', kind: 'rehearsal', state: 'completed', createdAt: at(0), finishedAt: at(60000), taskId: 'task-1' });
  s.put('flow', { id: 'done-2', kind: 'rehearsal', state: 'failed', createdAt: at(0), finishedAt: null, taskId: 'task-1' });
  s.put('flow', { id: 'open-1', kind: 'rehearsal', state: 'waiting', createdAt: at(0), taskId: 'task-1' });
  s.put('attempt', { id: 'a1', flowId: 'done-1', step: 'work', status: 'failed', createdAt: at(0), settledAt: at(2000), costMicros: 0, receipt: { startedAt: at(100), endedAt: at(1100) } });
  s.put('attempt', { id: 'a2', flowId: 'done-1', step: 'work', status: 'passed', createdAt: at(3000), settledAt: at(6000), costMicros: 0, receipt: { startedAt: at(3100), endedAt: at(6100) } });
  s.put('attempt', { id: 'a3', flowId: 'done-1', step: 'gate', status: 'passed', createdAt: at(7000), settledAt: at(8000), costMicros: 0 });
  s.put('attempt', { id: 'a4', flowId: 'open-1', step: 'work', status: 'running', createdAt: at(9000) });
  s.put('wait', { id: 'w1', flowId: 'done-1', kind: 'question', startedAt: at(10000), endedAt: at(40000), reason: 'answered' });
  s.put('wait', { id: 'w2', flowId: 'open-1', kind: 'question', startedAt: at(50000), endedAt: null });
  const st = observedStats(s);
  assert.equal(st.flowDuration.count, 1); assert.equal(st.flowDuration.medianMs, 60000);
  assert.equal(st.flowDuration.missing, 1, 'a finished flow without finish time is missing, not zero');
  const work = st.phases.find(p => p.step === 'work');
  assert.deepEqual([work.attempts, work.count, work.missing, work.medianMs], [3, 2, 1, 1000]);
  assert.equal(st.phases.find(p => p.step === 'gate').count, 0);
  assert.equal(st.coverage.attemptsWithoutReceiptTiming, 1);
  assert.equal(st.waits.question.count, 1); assert.equal(st.waits.question.open, 1); assert.equal(st.waits.question.totalMs, 30000);
  assert.equal(st.retries.extraAttempts, 1); assert.equal(st.retries.byStep.work, 1);
  assert.equal(st.cost.attemptsWithoutSettlement, 1);
  assert.match(st.cost.subscriptionSemantics, /not the subscription price/);
  assert.equal(distribution([]).medianMs, null);
  assert.deepEqual(workflowOrder({ start: 'a', nodes: { z: { kind: 'end' }, a: { kind: 'effect', next: 'b', onFailure: 'z' }, b: { kind: 'effect', next: 'z' } } }).map(n => n.id), ['a', 'b', 'z']);
});

async function serviceFixture(t) {
  const f = sandbox(t, { question: true });
  const socketPath = join(f.base, 'views.sock');
  const app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false });
  t.after(() => app.close());
  return { ...f, socketPath, read: path => requestProject(socketPath, { path, timeoutMs: 30000 }) };
}

test('service collections support bounded ordering and command, retrospective and context kinds', async t => {
  const f = await serviceFixture(t);
  f.command('task.put', { task: { id: 'task-2', title: 'Second fictional task', acceptance: ['Second'] } });
  const asc = await f.read('/v1/collections/task?limit=10'), desc = await f.read('/v1/collections/task?limit=10&order=desc');
  assert.deepEqual(asc.items.map(i => i.id), ['task-1', 'task-2']);
  assert.deepEqual(desc.items.map(i => i.id), ['task-2', 'task-1']);
  const commands = await f.read('/v1/collections/command?limit=1&order=desc');
  assert.equal(commands.total, 2); assert.equal(commands.items[0].operation, 'task.put'); assert.equal(commands.nextCursor, 1);
  assert.equal((await f.read('/v1/collections/retrospective')).total, 0);
  assert.equal((await f.read('/v1/collections/context')).total, 0);
  f.store.put('mainCheckObservation',{id:'observed-check',checkId:'baseline',status:'passed',flaked:true,reused:false,attempts:[{status:'failed'},{status:'passed'}]});
  const ledger=await f.read('/v1/collections/mainCheckObservation?order=desc');assert.equal(ledger.total,1);assert.equal(ledger.items[0].flaked,true);
  await assert.rejects(f.read('/v1/collections/task?order=sideways'), /invalid pagination/);
  await assert.rejects(f.read('/v1/collections/task?order=desc&order=asc'), /unsupported collection parameter/);
  const events = await f.read('/v1/collections/event?limit=2');
  assert.ok(events.items[0].sequence > events.items[1].sequence, 'events keep newest-first default');
});

test('flow details include waits and attempt lifecycle events for the timeline', async t => {
  const f = await serviceFixture(t);
  f.start();
  await until(() => f.store.all('inbox').some(item => item.status === 'open'), { tick: () => f.engine.tick() });
  const detail = await f.read('/v1/flows/flow-1');
  assert.equal(detail.waits.length, 1); assert.equal(detail.waits[0].kind, 'question'); assert.equal(detail.waits[0].endedAt, null);
  assert.ok(detail.events.some(event => event.type === 'attempt.running' || event.type === 'attempt.dispatching'), 'attempt events carry only attemptId and must still be included');
  assert.ok(Array.isArray(detail.contexts)); assert.equal(detail.retrospective, null);
});

test('console forwards ordering, rejects unsafe values before dispatch and serves only allowlisted assets', async t => {
  const f = await serviceFixture(t);
  f.start();
  await until(() => f.store.all('inbox').some(item => item.status === 'open'), { tick: () => f.engine.tick() });
  const state = join(f.base, 'console'), binding = await registerProject(state, { socketPath: f.socketPath }, { timeoutMs: 30000 });
  const app = await startConsole({ stateDir: state, timeoutMs: 30000 }); t.after(() => app.close());
  const page = await fetch(app.url), cookie = page.headers.get('set-cookie').split(';')[0]; await page.text();
  const get = path => fetch(app.url + path, { headers: { cookie } });
  const base = `/api/project/${binding.projectId}`;
  const desc = await (await get(`${base}/collections/command?bindingId=${binding.bindingId}&order=desc&limit=1`)).json();
  assert.equal(desc.items[0].operation, 'flow.start');
  assert.equal((await get(`${base}/collections/command?bindingId=${binding.bindingId}&order=sideways`)).status, 400);
  const flow = await (await get(`${base}/flows/flow-1?bindingId=${binding.bindingId}`)).json();
  assert.equal(flow.waits.length, 1); assert.ok('retrospective' in flow); assert.ok(Array.isArray(flow.contexts));
  // The flow's place in the flow slots reaches the browser (dev.84 H3): parked on its open question, holding no slot.
  assert.deepEqual([flow.capacity?.state, flow.capacity?.holdsSlot], ['parked', false]);
  for (const asset of ['/ui.mjs', '/ui/timeline.mjs', '/ui/queue.mjs', '/ui/state.mjs', '/style.css']) assert.equal((await fetch(app.url + asset)).status, 200, asset);
  for (const asset of ['/ui/../console.mjs', '/ui/unknown.mjs', '/console.mjs', '/ui/%2e%2e/console.mjs', '/README.md']) assert.notEqual((await fetch(app.url + asset)).status, 200, asset);
  const html = await (await fetch(app.url)).text();
  assert.ok(!html.includes(f.socketPath) && !html.includes(f.stateDir));
  const projects = await (await get('/api/projects')).json();
  assert.ok(!JSON.stringify(projects).includes(f.socketPath), 'socket path never reaches the browser');
  assert.ok(projects[0].snapshot.stats.flows.total >= 1);
});

test('browser modules render untrusted content as text, never as markup', () => {
  const dir = new URL('../starter/factory/console/', import.meta.url);
  const sources = ['ui.mjs', ...['dom', 'state', 'actions', 'overview', 'inbox', 'timeline', 'plan', 'queue', 'history', 'stats', 'operations', 'settings', 'receipts', 'records'].map(n => `ui/${n}.mjs`)].map(file => readFileSync(new URL(file, dir), 'utf8'));
  for (const source of sources) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(source));
  const consoleSource = readFileSync(new URL('console.mjs', dir), 'utf8');
  for (const name of ['dom', 'state', 'actions', 'overview', 'inbox', 'timeline', 'plan', 'queue', 'history', 'stats', 'operations', 'settings', 'receipts', 'records']) assert.ok(consoleSource.includes(`'${name}'`), `${name} module is served`);
});

test('operational policy projections show configured limits while omitting unknown pool and flake fields',t=>{
  const {store}=deliveryStore(t),config=store.meta('config');
  config.policy.queueRanking=true;config.policy.categoryOrder=['governance','feature'];config.policy.categoryLimits={governance:1};
  config.resources.pools={verification:{capacity:4,maxLoadAverage:8,minAvailableMemoryBytes:1024,privateToken:'POOL-SECRET'}};
  config.resources.operations={gate:{resource:'verification',weight:2,privateToken:'REQUEST-SECRET'}};
  config.mainChecks=[{id:'baseline',argv:['PRIVATE-CHECK-COMMAND'],timeoutMs:60000,retrySafe:true,reuseMaxAgeMs:60000,flakePolicy:{retries:1,expiresAt:'2099-01-01T00:00:00Z',exitCodes:[1],trackingRef:'PRIVATE-TRACKING-REF',privateToken:'FLAKE-SECRET'}}];
  store.setMeta('config',config);store.setMeta('retentionHold',{id:'archive'});
  const view=settingsView(store),encoded=JSON.stringify(view);
  for(const secret of ['POOL-SECRET','REQUEST-SECRET','PRIVATE-TRACKING-REF','FLAKE-SECRET'])assert.ok(!encoded.includes(secret),`leaked ${secret}`);
  assert.deepEqual(view.mainChecks[0].command,['PRIVATE-CHECK-COMMAND'],'check commands are shown read-only');
  assert.deepEqual(view.queuePolicy,{ranking:true,categoryOrder:['governance','feature'],categoryLimits:{governance:1}});
  assert.deepEqual(view.resources.pools.verification,{capacity:4,maxLoadAverage:8,minAvailableMemoryBytes:1024});
  assert.deepEqual(view.resources.operations.gate,{resource:'verification',weight:2});assert.equal(view.mainChecks[0].reuseMaxAgeMs,60000);assert.equal(view.mainChecks[0].flakePolicy.retries,1);assert.equal(view.holds.retentionHold,true);
});
