// Synthetic console demonstration data for `node evals/run.mjs --serve --ui-demo`.
// Everything here is fictional. Lifecycle records (tasks, flows, attempts, waits, decisions, commands)
// come from the real copied runtime. Records the rehearsal cannot produce (audit findings,
// notifications, obligations, a regression report, main-health checks) are explicitly labelled
// illustrative and are not delivery, provider or model evidence.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const NOTE = 'Illustrative UI demo record; not delivery, provider or model evidence.';

export async function seedUiDemo({ projects, consoleInstance, consoleRequest, until, runtime }) {
  const [a, b] = projects;
  const command = (project, operation, payload, actor = 'operator') => project.executeCommand(project.store, { protocolVersion: 1, projectId: project.identity.projectId, commandId: `ui-demo-${randomUUID()}`, operation, payload, actor });
  const viaConsole = (project, operation, payload) => consoleRequest('/api/commands', { projectId: project.identity.projectId, bindingId: project.binding.bindingId, commandId: randomUUID(), operation, payload, actor: 'operator' });

  // Project A: finish its first flow through the console, then record a failed and a stopped flow.
  await viaConsole(a, 'answer', { inboxId: a.question.id, version: a.question.version, subjectDigest: a.question.subjectDigest, answer: 'continue' });
  await until(() => a.store.need('flow', 'flow-1').state === 'completed', 'demo flow completion');
  const follow = command(a, 'task.put', { task: { id: 'feature-2', title: 'Fictional follow-up: reapply the same change', acceptance: ['Demonstrates a build that fails on an already-applied patch'], paths: ['src/tasks.js'], risk: 'ordinary' } });
  command(a, 'task.approve', { taskId: 'feature-2', revision: follow.result.revision });
  command(a, 'flow.start', { taskId: 'feature-2', flowId: 'flow-2' });
  await until(() => ['failed', 'stopped'].includes(a.store.need('flow', 'flow-2').state), 'demo failed flow');
  const third = command(a, 'task.put', { task: { id: 'feature-3', title: 'Fictional: export completed items', acceptance: ['Export includes only completed items', 'Output preserves stable item identifiers'], paths: ['src/export.js'], risk: 'ordinary' } });
  command(a, 'task.approve', { taskId: 'feature-3', revision: third.result.revision });
  // Admission and stop run in one synchronous turn, so the runner records a stop before any attempt.
  command(a, 'flow.start', { taskId: 'feature-3', flowId: 'flow-3' });
  command(a, 'stop', { flowId: 'flow-3', note: 'Fictional operator stop to demonstrate a stopped flow' });
  command(a, 'task.put', { task: { id: 'feature-4', title: 'Fictional: document the export format', acceptance: ['Format documented with an example'], risk: 'strict' } });
  command(a, 'queue.put', { taskIds: ['feature-3', 'feature-4'] });
  command(a, 'schedule.put', { schedule: { id: 'nightly-main-check', type: 'daily', timeOfDay: '03:30', timezone: 'UTC', operation: 'main.verify', payload: {} } });
  command(a, 'schedule.put', { schedule: { id: 'hourly-sample', type: 'interval', everyMs: 3600000, operation: 'machine.sample', payload: {} } });
  command(a, 'rule.pushback', { ruleId: 'review.round-limit', flowId: 'flow-2', reason: 'Fictional proposal: explain how a repeated build failure should be escalated.', evidence: 'Flow flow-2 failed at build in this synthetic demo' });
  // A console command the project rejects, so Receipts shows a canonical rejection.
  await viaConsole(a, 'flow.start', { taskId: 'feature-4', revision: 'stale-revision' });

  const now = new Date().toISOString(), s = a.store, flowOne = s.need('flow', 'flow-1');
  const { sampleMachine } = await import(pathToFileURL(join(a.root, 'factory', 'operations', 'sampling.mjs')).href);
  const { digest } = await import(pathToFileURL(join(a.root, 'factory', 'core', 'contracts.mjs')).href);
  s.tx(() => {
    s.setMeta('mainHealth', { status: 'green', head: flowOne.evidence?.gate?.head ?? null, checkedAt: now, source: 'illustrative', checks: [{ id: 'baseline', status: 'passed', evidence: 'Illustrative check record', startedAt: now, endedAt: now }], note: NOTE });
    s.put('finding', { id: 'demo-finding', source: 'audit', title: 'Fictional audit: export format undocumented', evidence: 'src/tasks.js', status: 'unapproved', approved: false, observations: 2, createdAt: flowOne.createdAt, lastObservedAt: now, note: NOTE });
    s.put('obligation', { id: 'demo-obligation', title: 'Review the fictional export-format finding', owner: 'operator', status: 'pending', approved: false, evidence: 'Audit finding demo-finding', createdAt: now, note: NOTE });
    s.put('regression', { id: 'demo-regression', flowId: 'flow-1', reason: 'Fictional later observation: saved order differs after reload', evidence: 'Illustrative reproduction notes', source: 'operator-report', status: 'reported', observedAt: now, note: `${NOTE} Rehearsal flows do not merge; no causal claim.` });
    s.put('machineSample', { id: 'demo-machine', ...sampleMachine(), capacity: { observedAt: now, buildLimit: 1, activeChanges: 0, availableChangePermits: 1 }, note: 'Actual aggregate host sample taken by the demo; no build permit was in use.' });
    // Illustrative host samples for the Timeline's machine charts: a smooth, fictional 12-hour series.
    { const total = 64 * 1073741824, swap = 16 * 1073741824, ticks = { total: 0, idle: 0, iowait: 0 };
      for (let i = 180; i >= 0; i--) { const t = Date.now() - i * 240000, wave = (Math.sin(i / 5) + 1) / 2, busy = .15 + .6 * wave * wave, wait = .02 + .06 * wave;
        ticks.total += 24000; ticks.idle += Math.round(24000 * (1 - busy - wait)); ticks.iowait += Math.round(24000 * wait);
        const at = new Date(t).toISOString();
        s.put('hostSample', { id: at, observedAt: at, loadAverage: [busy * 16, busy * 14, busy * 12], memoryBytes: { total, available: Math.round(total * (.62 - .2 * wave)) }, swapBytes: { total: swap, free: Math.round(swap * (.8 - .1 * Math.cos(i / 30))) }, cpuTicks: { ...ticks }, note: NOTE }); } }
    s.put('delivery', { id: 'demo-delivery', inboxId: s.all('inbox')[0]?.id ?? 'none', channel: 'operator', status: 'accepted', attempts: 1, nextAt: new Date(Date.now() + 30 * 60000).toISOString(), note: NOTE });
    s.put('context', { id: 'demo-context', flowId: 'flow-1', digest: digest('fictional governing context'), chars: 1180, files: [{ id: 'project-governance', path: 'project/GOVERNANCE.md', required: true, digest: digest('fictional governance') }], omitted: [{ id: 'style-guide', reason: 'path mapping did not match' }], deliveredAt: now, note: NOTE });
    s.event('ui-demo.seeded', { note: NOTE });
  });

  // Project B keeps its open decision; add an unapproved task for the Plan view.
  command(b, 'task.put', { task: { id: 'feature-2', title: 'Fictional: show completed count in list footer', acceptance: ['Footer shows the completed count', 'Empty lists show zero'] } });

  // A third fictional project that is registered and then shut down: it must show as unavailable.
  const extra = await unavailableProject({ runtime, root: a.root, consoleInstance });
  // A fictional delivery configuration that has never been commissioned: settings are visible, admission is not.
  const delivery = await deliveryProject({ runtime, root: a.root, consoleInstance });
  // A fictional endpoint that loses command responses, leaving an unresolved receipt fence.
  const lossy = await lossyProject({ runtime, consoleInstance, consoleRequest });
  return { close: async () => { await lossy.close(); await delivery.close(); }, projects: [extra, lossy.info, delivery.info] };
}

async function unavailableProject({ runtime, root, consoleInstance }) {
  const base = join(runtime, 'unavailable'), repo = join(base, 'repo'), stateDir = join(base, 'state');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'README.md'), 'Fictional unavailable project for the console demo.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'demo@example.invalid'], ['config', 'user.name', 'Fictional Demo'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-qm', 'Fictional demo']]) spawnSync('git', args, { cwd: repo });
  const [{ initProject }, { startProjectService }] = await Promise.all(['core/store.mjs', 'service/project-service.mjs'].map(p => import(pathToFileURL(join(root, 'factory', p)).href)));
  const identity = initProject({ stateDir, root: repo, name: 'Fictional offline project', supervisor: 'process', workflow: { version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } } });
  const service = await startProjectService({ stateDir, socketPath: join(stateDir, 'project.sock'), run: false });
  await consoleInstance.registerProject({ socketPath: service.socketPath });
  await service.close();
  return { projectId: identity.projectId, name: 'Fictional offline project', state: 'registered then stopped (unavailable)' };
}

async function lossyProject({ runtime, consoleInstance, consoleRequest }) {
  const socketPath = join(runtime, 'lossy.sock'), projectId = `demo-lossy-${randomUUID().slice(0, 8)}`;
  const handshake = { protocolVersion: 1, projectId, serviceId: `service-${projectId}`, name: 'Fictional lossy endpoint', stateRevision: 1, capabilities: ['snapshot', 'command', 'commandStatus'] };
  const server = http.createServer((req, res) => {
    const send = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/v1/handshake') return send(handshake);
    if (req.url === '/v1/snapshot') return send({ projectId, name: handshake.name, revision: 1, paused: false, tasks: [], flows: [], inbox: [], synthetic: true });
    if (req.method === 'POST' && req.url === '/v1/commands') { req.resume(); return req.on('end', () => req.socket.destroy()); }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'unknown command' }));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const binding = await consoleInstance.registerProject({ socketPath });
  await consoleRequest('/api/commands', { projectId, bindingId: binding.bindingId, commandId: randomUUID(), operation: 'pause', payload: { paused: true, note: 'Fictional command whose response is lost' }, actor: 'operator' });
  return { info: { projectId, name: handshake.name, state: 'older snapshot shape; one unresolved command receipt' }, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }) };
}

async function deliveryProject({ runtime, root, consoleInstance }) {
  const base = join(runtime, 'delivery'), repo = join(base, 'repo'), stateDir = join(base, 'state');
  await mkdir(repo, { recursive: true });
  await writeFile(join(repo, 'README.md'), 'Fictional delivery-configured project for the console demo.\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'demo@example.invalid'], ['config', 'user.name', 'Fictional Demo'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-qm', 'Fictional demo']]) spawnSync('git', args, { cwd: repo });
  const config = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'project', 'factotum.template.json'), 'utf8'));
  config.resources.coordinatorPath = join(base, 'resources.sqlite'); config.backupRoot = join(base, 'backups');
  // Scheduled work for the Scheduled tab: a task workflow, a weekly recurring task and a daily scheduled task.
  config.workflows = { definitions: { change: { reference: 'change.standard' }, 'orchestrator-task': { reference: 'task.orchestrator' } }, selection: { default: 'change', rules: [{ label: 'orchestrator', workflow: 'orchestrator-task' }] } };
  config.recurringTasks = { 'publish-day': { schedule: { type: 'weekly', timeOfDay: '09:00', timezone: 'America/New_York', weekdays: [1] }, task: { title: 'Fictional: publish-day deploy', doneWhen: 'The site serves this week’s build', workflow: 'orchestrator-task', labels: ['deploy'] } } };
  config.scheduledTasks = { 'link-check': { description: 'Fictional: check external links in the docs', command: ['true'], network: true, schedule: { type: 'daily', timeOfDay: '06:00', timezone: 'UTC' } } };
  const [{ initProject, Store }, { startProjectService }, { executeCommand }] = await Promise.all(['core/store.mjs', 'service/project-service.mjs', 'core/project.mjs'].map(p => import(pathToFileURL(join(root, 'factory', p)).href)));
  const identity = initProject({ stateDir, root: repo, name: 'Fictional delivery project (not commissioned)', supervisor: 'process', config });
  const store = new Store(stateDir);
  try {
    const put = executeCommand(store, { protocolVersion: 1, projectId: identity.projectId, commandId: 'ui-demo-delivery-task', operation: 'task.put', actor: 'operator', payload: { task: { id: 'example-1', title: 'Fictional: add a health endpoint', acceptance: ['Endpoint returns ok', 'Documented in the README'], paths: ['src/health.js'], risk: 'ordinary' } } });
    executeCommand(store, { protocolVersion: 1, projectId: identity.projectId, commandId: 'ui-demo-delivery-approve', operation: 'task.approve', actor: 'operator', payload: { taskId: 'example-1', revision: put.result.revision } });
    const later = executeCommand(store, { protocolVersion: 1, projectId: identity.projectId, commandId: 'ui-demo-delivery-later', operation: 'task.put', actor: 'operator', payload: { task: { id: 'example-2', title: 'Fictional: renew the domain', acceptance: ['The domain is renewed for a year'], labels: ['orchestrator'], notBefore: new Date(Date.now() + 2 * 86400000).toISOString() } } });
    executeCommand(store, { protocolVersion: 1, projectId: identity.projectId, commandId: 'ui-demo-delivery-later-approve', operation: 'task.approve', actor: 'operator', payload: { taskId: 'example-2', revision: later.result.revision, queue: true } });
  } finally { store.close(); }
  // run:false: no runner or maintenance ticks; the demo never contacts providers or GitHub.
  const service = await startProjectService({ stateDir, socketPath: join(stateDir, 'project.sock'), run: false });
  await consoleInstance.registerProject({ socketPath: service.socketPath });
  return { info: { projectId: identity.projectId, name: 'Fictional delivery project (not commissioned)', state: 'delivery configuration from the fictional template; runner not started' }, close: () => service.close() };
}
