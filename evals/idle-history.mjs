// Idle cost of a project service over a large settled history. Synthetic and fictional:
// no provider, forge or network is used, and nothing outside the given directory is touched.
//
//   node evals/idle-history.mjs generate <dir> [--changes 400] [--maintenance 600] [--intent-bytes 70000] [--samples 5700]
//   node evals/idle-history.mjs measure <dir> [--seconds 20] [--code <checkout>]
//
// generate writes a commissioned delivery project whose history is laid out as the release
// before the attempt-intent split wrote it (each attempt's dispatch intent inline, no indexes
// on records): by default 3,000 settled attempts of about 80 KB, 1,000 finished flows with
// their tasks, questions, waits, deliveries and jobs, and 5,700 host samples.
// measure copies that state, starts the project service on the copy and reports, for an
// idle service and for single reads, CPU time, bytes read by the process (/proc/self/io
// rchar) and bytes of JSON parsed in JavaScript. --code measures another checkout's code on
// the same state (for a before/after comparison); the default is this checkout.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [mode, target, ...rest] = process.argv.slice(2);
const option = (name, fallback) => { const at = rest.indexOf(`--${name}`); return at < 0 ? fallback : rest[at + 1]; };
if (!['generate', 'measure'].includes(mode) || !target) { console.error('usage: node evals/idle-history.mjs generate|measure <dir> [options]; see the comment at the top of this file'); process.exit(1); }
const code = resolve(option('code', fileURLToPath(new URL('..', import.meta.url)))), load = path => import(pathToFileURL(join(code, 'starter', 'factory', path)).href);
const base = resolve(target), hex = value => createHash('sha256').update(String(value)).digest('hex');

if (mode === 'generate') {
  const changes = Number(option('changes', 400)), maintenance = Number(option('maintenance', 600)), intentBytes = Number(option('intent-bytes', 70000)), samples = Number(option('samples', 5700));
  const { Store, initProject } = await load('core/store.mjs'), { digest } = await load('core/contracts.mjs');
  const root = join(base, 'repo'), stateDir = join(base, 'state');
  mkdirSync(join(root, 'factory'), { recursive: true }); mkdirSync(join(root, 'project'));
  writeFileSync(join(root, 'factory', 'AGENTS.md'), 'Fictional\n'); writeFileSync(join(root, 'project', 'GOVERNANCE.md'), 'Fictional\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-qm', 'Fictional baseline']]) execFileSync('git', args, { cwd: root });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const config = JSON.parse(readFileSync(join(code, 'starter', 'project', 'factotum.template.json'), 'utf8'));
  config.resources.coordinatorPath = join(base, 'resources.sqlite'); config.backupRoot = join(base, 'backups');
  const project = initProject({ stateDir, root, name: 'Fictional long-running project', supervisor: 'process', config });
  const store = new Store(stateDir), workflow = store.meta('workflow'), stored = store.meta('config'), configDigest = store.meta('configDigest');
  // The earlier release had no indexes on records and no layout fence.
  for (const row of store.db.prepare("SELECT type, name FROM sqlite_master WHERE (type='index' AND tbl_name='records' AND sql IS NOT NULL) OR (type='trigger' AND name LIKE 'factotum_layout_fence_%')").all()) store.db.exec(`DROP ${row.type} ${row.name}`);
  const put = store.db.prepare('INSERT INTO records VALUES(?,?,?)'), event = store.db.prepare('INSERT INTO events(at,type,payload) VALUES(?,?,?)');
  const row = (kind, record) => { put.run(kind, record.id, JSON.stringify(record)); return record; };
  let seed = 1; const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const words = 'the build review plan check merge flow attempt task result evidence fictional module export import handler state record digest queue'.split(' ');
  const prose = length => { let text = ''; while (text.length < length) text += `${words[Math.floor(random() * words.length)]} `; return text.slice(0, length); };
  let clock = Date.now() - 60 * 86400000, attempts = 0, events = 0; const tick = ms => new Date(clock += ms).toISOString();
  const log = (at, type, payload) => { event.run(at, type, JSON.stringify(payload)); events++; };
  const attempt = (flowId, step, operation, task, results) => {
    const id = randomUUID(), createdAt = tick(2000), unit = `factotum-${project.projectId.slice(0, 8)}-${id}`;
    const intent = { version: 1, attemptId: id, projectId: project.projectId, flowId, step, argv: [process.execPath, join(root, 'factory', 'workflows', 'dispatch.mjs'), join(stateDir, 'attempts', id, 'intent.json')],
      action: { operation, projectId: project.projectId, flowId, step, stateDir, artifactDir: join(stateDir, 'attempts', id), config: stored, task, node: workflow.nodes[step] ?? { kind: 'effect', action: { operation } }, results, guidance: prose(Math.round(intentBytes * (0.5 + random()))), providerHolds: [] },
      cwd: root, synthetic: false, projectRoot: root, timeoutMs: 600000, maxCostMicros: 0, executorDigest: hex('executor'), inputIdentity: { head, treeDigest: hex('tree') }, unit, containment: 'systemd' };
    const intentDigest = digest(intent), startedAt = tick(500), endedAt = tick(60000);
    const receipt = { version: 1, attemptId: id, intentDigest, owner: { pid: 1000 + attempts, bootId: '00000000-0000-4000-8000-000000000000', startTime: String(attempts), attemptId: id, intentDigest }, startedAt, endedAt, exitCode: 0, signal: null, reason: null, descendants: [], synthetic: false, costMicros: 0, stdoutDigest: hex(`${id}o`), stderrDigest: hex(`${id}e`), resultDigest: hex(`${id}r`),
      actionResult: { route: 'pass', provider: { provider: 'claude', model: 'claude-opus-5-5' }, providerInvocations: [{ provider: 'claude', model: 'claude-opus-5-5', usage: { inputTokens: 12000, outputTokens: 3000 }, durationMs: 60000 }], summary: prose(2800) } };
    attempts++; for (const type of ['attempt.prepared', 'attempt.dispatching', 'attempt.running', 'attempt.settled']) log(createdAt, type, { attemptId: id });
    return row('attempt', { id, flowId, step, status: 'passed', intent, intentDigest, reservedMicros: 0, createdAt, unit, authorityVersion: 2, dispatchedAt: startedAt, receipt, costMicros: 0, settledAt: tick(200), outputIdentity: { head, treeDigest: hex('tree') } });
  };
  store.db.exec('BEGIN');
  const steps = Object.entries(workflow.nodes).filter(([, node]) => node.kind === 'effect').map(([step, node]) => [step, node.action?.operation ?? 'provider.build']).slice(0, 6);
  for (let i = 0; i < changes; i++) {
    const taskId = `task-${i}`, flowId = `flow-${i}`, revision = hex(`revision${i}`), createdAt = tick(60000);
    const task = row('task', { id: taskId, title: `Fictional change ${i}`, acceptance: ['Observed fictional behaviour', prose(300)], paths: ['src/module.js'], risk: 'ordinary', revision, approvedRevision: null, approvalVersion: 2, approvedAt: createdAt, approvedWorkflow: null, status: 'completed' });
    row('queue', { id: taskId, order: i, status: 'finished', queuedAt: createdAt, claimedAt: createdAt, finishedAt: createdAt, flowId, flowState: 'completed', source: 'approval' });
    log(createdAt, 'task.approved', { taskId, revision }); log(createdAt, 'flow.admitted', { flowId, taskId });
    const results = {};
    for (const [step, operation] of steps) { const settled = attempt(flowId, step, operation, task, results); results[step] = { route: 'pass', summary: prose(1500), identity: { head, treeDigest: hex('tree') } }; log(settled.settledAt, 'flow.moved', { flowId, from: step }); }
    const inboxId = randomUUID(), asked = tick(1000), answered = tick(600000);
    row('inbox', { id: inboxId, kind: 'question', status: 'answered', flowId, version: 2, subjectDigest: hex(inboxId), question: 'Merge this fictional candidate?', answers: ['merge', 'stop'], transitions: { merge: 'done', stop: 'stopped' }, role: 'operator', createdAt: asked, expiresAt: new Date(Date.parse(asked) + 86400000).toISOString(), answer: 'merge', answeredBy: 'operator', answeredAt: answered, detail: prose(1200) });
    row('wait', { id: `question:${inboxId}`, flowId, inboxId, kind: 'question', startedAt: asked, endedAt: answered, reason: 'answered' });
    for (const [version, status] of [[1, 'open'], [2, 'answered']]) row('delivery', { id: digest({ inboxId, version, channel: 'operator' }), inboxId, inboxVersion: version, inboxStatus: status, event: status === 'open' ? 'inbox.attention' : 'inbox.resolved', channel: 'operator', status: version === 1 ? 'superseded' : 'suppressed', attempts: 0, nextAt: asked });
    log(asked, 'inbox.opened', { inboxId, flowId }); log(answered, 'inbox.answered', { inboxId, flowId });
    row('context', { id: `context-${i}`, flowId, digest: hex(`context${i}`), chars: 1180, files: [{ id: 'project-governance', path: 'project/GOVERNANCE.md', required: true, digest: hex('governance') }], omitted: [], deliveredAt: asked });
    const finishedAt = tick(1000);
    row('flow', { strictDecisionRole: 'operator', mergeDecisionRole: 'operator', reviewProtocol: 'fresh-full', effectiveRisk: 'ordinary', riskAssessments: [], candidate: { head }, completionMode: 'merge', id: flowId, taskId, taskSnapshot: task, taskRevision: revision, approvalVersion: 2, workflow, workflowDigest: digest(workflow), configDigest, mode: 'delivery', kind: 'change', executorDigest: hex('executor'), step: 'done', state: 'completed', stopRequested: false, abortRequested: false, transitions: steps.length + 1, visits: Object.fromEntries(steps.map(([step]) => [step, 1])), evidence: {}, results: { ...results, merge: { merged: true }, cleanup: { released: true } }, sessions: {}, attemptId: null, createdAt, finishedAt, target: 'main' });
    log(finishedAt, 'flow.finished', { flowId, outcome: 'completed' });
  }
  for (let i = 0; i < maintenance; i++) {
    const operation = i % 3 ? 'machine.sample' : 'main.verify', jobId = hex(`job${i}`), taskId = `job:${jobId}`, flowId = `maintenance:${jobId}`, createdAt = tick(3600000), revision = hex(`job-revision${i}`);
    const task = row('task', { id: taskId, title: `Maintenance: ${operation}`, acceptance: [`Execute approved ${operation} scope and retain evidence`], revision, approvedRevision: revision, approvalVersion: 1, approvalKind: 'schedule', scheduleId: 'hourly', scheduleRevision: hex('schedule'), paths: [], risk: 'strict' });
    attempt(flowId, 'run', operation, task, {});
    const finishedAt = tick(500), graph = { version: 1, start: 'run', nodes: { run: { kind: 'effect', action: { operation }, timeoutMs: 600000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
    row('flow', { id: flowId, taskId, taskRevision: revision, taskSnapshot: task, approvalVersion: 1, kind: 'maintenance', jobId, jobPayload: {}, workflow: graph, workflowDigest: digest(graph), configDigest, mode: 'delivery', executorDigest: hex('executor'), step: 'done', state: 'completed', stopRequested: false, abortRequested: false, transitions: 1, visits: { run: 1 }, evidence: {}, results: { run: { route: 'pass' } }, sessions: {}, attemptId: null, createdAt, finishedAt });
    row('job', { id: jobId, operation, payload: {}, scheduleId: 'hourly', scheduleRevision: hex('schedule'), status: 'completed', createdAt, flowId, finishedAt, outcome: 'completed' });
    log(createdAt, 'maintenance.admitted', { jobId, flowId }); log(finishedAt, 'flow.finished', { flowId, outcome: 'completed' });
  }
  row('schedule', { id: 'hourly', type: 'interval', everyMs: 3600000, operation: 'machine.sample', payload: {}, enabled: false, createdAt: new Date(Date.now() - 60 * 86400000).toISOString() });
  for (let i = samples; i > 0; i--) { const at = new Date(Date.now() - i * 120000).toISOString(); row('hostSample', { id: at, observedAt: at, uptimeSeconds: 1000 + i, loadAverage: [1, 1, 1], memoryBytes: { total: 64e9, available: 32e9 }, swapBytes: { total: 16e9, free: 12e9 }, cpuTicks: { total: i * 24000, idle: i * 20000, iowait: i * 100 } }); }
  store.db.exec('COMMIT');
  const at = new Date().toISOString();
  store.setMeta('commissioning', { ready: true, configDigest, checkedAt: at });
  store.setMeta('mainHealth', { status: 'green', head, checkedAt: at, checks: [{ id: 'baseline', status: 'passed', passed: true, tier: 'merge' }], tier: 'all', tiers: ['merge'] });
  store.setMeta('hostSampleAt', at); store.setMeta('revision', events);
  const kinds = store.db.prepare('SELECT kind, count(*) AS records, sum(length(data)) AS bytes FROM records GROUP BY kind').all();
  store.close();
  console.log(JSON.stringify({ synthetic: true, stateDir, attempts, events, kinds }, null, 1));
} else {
  const seconds = Number(option('seconds', 20)), runDir = mkdtempSync(join(tmpdir(), 'fct-idle-')), stateDir = join(runDir, 'state'), socket = join(runDir, 'p.sock');
  cpSync(join(base, 'state'), stateDir, { recursive: true });
  let parsedBytes = 0, parses = 0; const parse = JSON.parse;
  JSON.parse = (text, reviver) => { parses++; parsedBytes += typeof text === 'string' ? text.length : 0; return parse(text, reviver); };
  const io = () => Object.fromEntries(readFileSync('/proc/self/io', 'utf8').trim().split('\n').map(line => line.split(': ')).map(([key, value]) => [key, Number(value)]));
  const mark = () => ({ cpu: process.cpuUsage(), io: io(), parsedBytes, parses, at: performance.now() });
  const since = (a, b = mark()) => ({ wallMs: b.at - a.at, cpuMs: (b.cpu.user + b.cpu.system - a.cpu.user - a.cpu.system) / 1000, readMB: (b.io.rchar - a.io.rchar) / 1e6, readCalls: b.io.syscr - a.io.syscr, parsedMB: (b.parsedBytes - a.parsedBytes) / 1e6, parses: b.parses - a.parses });
  const round = value => Math.round(value * 100) / 100;
  const { startProjectService } = await load('service/project-service.mjs'), { requestProject } = await load('console/client.mjs'), { Engine } = await load('core/engine.mjs'), { operationalTick } = await load('workflows/maintenance.mjs'), { snapshot } = await load('core/project.mjs');
  let engineTicks = 0, operationTicks = 0; const tick = Engine.prototype.tick; Engine.prototype.tick = function () { engineTicks++; return tick.call(this); };
  const out = { synthetic: true, code, state: base };
  // 1. The service as it runs: engine tick every 75 ms, operations tick every second, nothing to do.
  const started = mark(), service = await startProjectService({ stateDir, socketPath: socket, operationTick: store => { operationTicks++; return operationalTick(store); } });
  out.start = { wallMs: round(since(started).wallMs) };
  await new Promise(done => setTimeout(done, 3000)); engineTicks = 0; operationTicks = 0;
  const before = mark(); await new Promise(done => setTimeout(done, seconds * 1000)); const idle = since(before);
  out.idleService = { seconds, engineTicks, operationTicks, cpuPercent: round(idle.cpuMs / idle.wallMs * 100), cpuMsPerMinute: Math.round(idle.cpuMs / idle.wallMs * 60000), readMBPerSecond: round(idle.readMB / (idle.wallMs / 1000)), readCallsPerSecond: Math.round(idle.readCalls / (idle.wallMs / 1000)), parsedMBPerSecond: round(idle.parsedMB / (idle.wallMs / 1000)) };
  await service.close();
  // 2. Single reads on a quiet service (no ticks in between).
  const quiet = await startProjectService({ stateDir, socketPath: socket, run: false }), store = quiet.store;
  const flowId = store.db.prepare("SELECT id FROM records WHERE kind='flow' AND id LIKE 'flow-%' ORDER BY rowid DESC LIMIT 1").get().id;
  const each = async (name, read, times = 3) => { await new Promise(done => setTimeout(done, 50)); let bytes = 0; try { await read(); } catch { await read(); } const a = mark(); for (let i = 0; i < times; i++) bytes = JSON.stringify(await read()).length; const d = since(a); out[name] = { wallMs: round(d.wallMs / times), cpuMs: round(d.cpuMs / times), readMB: round(d.readMB / times), parsedMB: round(d.parsedMB / times), responseBytes: bytes }; };
  const get = path => () => requestProject(socket, { path, timeoutMs: 120000 });
  await each('console poll: GET /v1/snapshot', get('/v1/snapshot'));
  await each('flow detail: GET /v1/flows/:id', get(`/v1/flows/${flowId}`));
  await each('timeline: GET /v1/timeline/72', get('/v1/timeline/72'));
  await each('statistics: GET /v1/stats/12w', get('/v1/stats/12w'), 2);
  await each('attempt page: GET /v1/collections/attempt?limit=100', get('/v1/collections/attempt?limit=100&order=desc'));
  await each('cli status: snapshot(store)', async () => snapshot(store), 2);
  await each('one engine tick', async () => { await new Engine(store).tick(); return {}; }, 5);
  await each('one operations tick', async () => { await operationalTick(store); return {}; }, 5);
  await quiet.close(); rmSync(runDir, { recursive: true, force: true });
  console.log(JSON.stringify(out, null, 1));
}
