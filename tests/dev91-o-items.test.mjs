// dev.91: the dev.90 readiness re-test findings O1–O6 (docs/changes/dev91-o-items.md).
// Fictional fixtures only: no provider CLI, forge or model is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installDom, byTag } from './fake-dom.mjs';
import { upkeepProject } from './upkeep-fixtures.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { execFileSync } from 'node:child_process';
import { proposalDigest } from '../starter/factory/operations/upkeep-context.mjs';
import { raiseCandidatesInTransaction } from '../starter/factory/operations/upkeep-candidates.mjs';
import { admissionReasons } from '../starter/factory/operations/admission.mjs';
import { queueStatus } from '../starter/factory/operations/queue-status.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { upkeepHealthView } from '../starter/factory/operations/views.mjs';
import { dashboardSnapshot } from '../starter/factory/service/dashboard.mjs';
import { recordTickProblem, clearTickProblem, tickProblems } from '../starter/factory/operations/tick-problems.mjs';
import { operationalTick } from '../starter/factory/workflows/maintenance.mjs';

installDom();
const { operationsView } = await import('../starter/factory/console/ui/operations.mjs');
const { queueView } = await import('../starter/factory/console/ui/queue.mjs');

const PROPOSE = Object.freeze({ mode: 'propose', docs: { include: ['README.md', 'docs/**/*.md'], exclude: ['docs/changes/**'] } });
const QUOTE = 'Never import src/legacy.js from new code.';
const send = (f, operation, payload) => executeCommand(f.store, { protocolVersion: 1, projectId: f.project.projectId, commandId: uid(), actor: 'operator', operation, payload });
const events = (f, type) => f.store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE type=?').get(type).n;
const allEvents = f => f.store.db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
const textOf = node => node.textContent;

// A delivery project with automatic admission, one accepted (and so approved and queued) context task,
// and no provider listed in upkeep.context.qualifiedProviders.
function heldContextTask(t, { qualified } = {}) {
  const f = upkeepProject(t, { upkeep: { ...structuredClone(PROPOSE), ...(qualified ? { context: { qualifiedProviders: qualified } } : {}) }, policy: { autoQueue: true, queueOnApproval: true } });
  // One model step (a codex builder), as the reference graphs have: the routes admission judges.
  const workflow = { version: 1, start: 'build', nodes: { build: { kind: 'effect', action: { operation: 'provider.build' }, timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.green();
  const [raised] = f.store.tx(() => raiseCandidatesInTransaction(f.store, { flowId: 'flow-source', nowMs: Date.now(), candidates: [{ kind: 'context', file: 'AGENTS.md', quote: QUOTE, replacement: 'Never import src/legacy.js; use src/api/users.js instead.', reason: 'The merge replaced the legacy module.', signals: [], flags: [], blob: gitBlob(f.root, 'AGENTS.md'), entries: ['rules'] }] }));
  const row = f.store.need('finding', raised.id);
  const accepted = send(f, 'finding.accept', { proposals: [{ findingId: row.id, expectedVersion: row.version, digest: proposalDigest(row) }] });
  assert.equal(accepted.status, 'completed', accepted.error);
  return { ...f, task: accepted.result.task };
}
const gitBlob = (root, path) => execFileSync('git', ['rev-parse', `HEAD:${path}`], { cwd: root, encoding: 'utf8' }).trim();

test('O5: a context task held for an unqualified provider shows its hold, with reason and remedy, in status, the queue and Health', async t => {
  const f = heldContextTask(t), task = f.store.need('task', f.task.id);
  assert.equal(f.store.need('queue', task.id).status, 'queued', 'accepting approves and queues it');
  // Admission: a reason like any other, with the remedy.
  const reasons = admissionReasons(f.store, task);
  const held = reasons.find(text => /not in upkeep\.context\.qualifiedProviders/.test(text));
  assert.ok(held, `admission reasons name the hold: ${JSON.stringify(reasons)}`);
  assert.match(held, /codex/); assert.match(held, /docs\/qualification\/provider-instructions\.md/);
  assert.match(held, /add it to upkeep\.context\.qualifiedProviders \(config update, operator only\)|add them to upkeep\.context\.qualifiedProviders/);
  assert.match(held, /task\.models/);
  // status --task: the task's admission reasons.
  const narrow = stateView(f.store, { task: task.id });
  assert.ok(narrow.task.admissionReasons.includes(held), 'status --task shows it');
  // The queue status, in the full and the compact (dashboard) reads, and in status's project holds.
  for (const status of [queueStatus(f.store), dashboardSnapshot(f.store).queueStatus]) {
    const hold = status.holds.find(row => row.kind === 'context-provider');
    assert.ok(hold, 'queueStatus.holds names the context task');
    assert.equal(hold.taskId, task.id); assert.equal(hold.scope, 'task'); assert.deepEqual(hold.providers, ['codex']);
    assert.match(hold.text, /not in upkeep\.context\.qualifiedProviders/); assert.match(hold.text, /config update/);
  }
  assert.ok(narrow.project.queueHolds.some(row => row.kind === 'context-provider' && row.taskId === task.id), 'status queue holds name it');
  // A tick observes the queue: its eligibility is not ready, with the reason.
  await operationalTick(f.store);
  const eligibility = f.store.need('queue', task.id).eligibility;
  assert.equal(eligibility.ready, false); assert.ok(eligibility.reasons.includes(held));
  assert.equal(f.store.need('queue', task.id).status, 'queued', 'not started');
  // Health: the hold and the provider warning stay while the task waits; no "Start it from the task".
  const view = upkeepHealthView(f.store, { findings: f.store.live('finding') });
  assert.deepEqual(view.contextTask.providerHold.providers, ['codex']); assert.equal(view.contextTask.queued, true);
  const project = { projectId: f.project.projectId, bindingId: 'binding-1', name: 'Fictional', status: 'available', observedAt: new Date().toISOString(), snapshot: { ...dashboardSnapshot(f.store), upkeep: view } };
  const page = textOf(byTag(operationsView(project), 'section').find(node => node.attributes['aria-label'] === 'Knowledge upkeep'));
  assert.match(page, /Context task held/); assert.match(page, /not in upkeep\.context\.qualifiedProviders/);
  assert.match(page, /No provider is recorded in upkeep\.context\.qualifiedProviders/, 'the provider warning stays while the task waits');
  assert.doesNotMatch(page, /Start it from the task/);
  // The queue page lists it as a held task, linked, not as a whole-queue hold.
  const queuePage = queueView(project, { params: {} });
  assert.match(textOf(queuePage), /A queued task is held\./); assert.doesNotMatch(textOf(queuePage), /The queue is held\./);
  assert.ok(byTag(queuePage, 'a').some(a => a.getAttribute('href')?.includes(encodeURIComponent(task.id)) || a.getAttribute('href')?.includes(task.id)));
});

test('O5: a held context task writes no queue.held on every tick (60 ticks), and other queued work is still admitted past it', async t => {
  const f = heldContextTask(t);
  await operationalTick(f.store);
  const before = allEvents(f);
  for (let i = 0; i < 60; i++) await operationalTick(f.store);
  assert.equal(events(f, 'queue.held'), 0, 'the hold is an admission reason, so the claim never tries and fails');
  assert.equal(allEvents(f), before, 'sixty unchanged ticks write no event at all');
  // An ordinary task queued behind it is admitted: the context task no longer blocks the claim.
  f.green();
  const other = f.command('task.put', { task: { id: 'other', title: 'Fictional other change', acceptance: ['Observed fixture behavior'] } }).result;
  assert.equal(f.command('task.approve', { taskId: other.id, revision: other.revision }).status, 'completed');
  await operationalTick(f.store);
  assert.equal(f.store.need('queue', other.id).status, 'claimed', 'the task behind the held context task started');
  assert.equal(f.store.need('queue', f.task.id).status, 'queued');
});

test('O5: once the operator lists the providers, the hold clears and the next tick admits the context task', async t => {
  const f = heldContextTask(t);
  await operationalTick(f.store);
  f.commission({ ...f.store.meta('config'), upkeep: { ...f.store.meta('config').upkeep, context: { qualifiedProviders: ['claude', 'codex'] } } });
  f.green();
  assert.equal(queueStatus(f.store).holds.filter(row => row.kind === 'context-provider').length, 0);
  assert.equal(upkeepHealthView(f.store, { findings: f.store.live('finding') }).contextTask.providerHold, null);
  await operationalTick(f.store);
  assert.equal(f.store.need('queue', f.task.id).status, 'claimed');
});

test('O5, every hold: a claim refused after admission (a check only admitFlow makes) is recorded once over many ticks, shown in queue status, and again only when its reason changes', async t => {
  const f = upkeepProject(t, { upkeep: { mode: 'off' }, policy: { autoQueue: true, queueOnApproval: true } });
  f.green();
  const task = f.command('task.put', { task: { id: 'drift', title: 'Fictional change', acceptance: ['Observed fixture behavior'] } }).result;
  assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed');
  // admitFlow alone checks that the task's models can be pinned: a stored task whose models no
  // longer validate passes every admission reason and is refused at the claim, on every tick.
  f.store.put('task', { ...f.store.need('task', task.id), models: { nonsense: true } });
  for (let i = 0; i < 40; i++) { f.green(); await operationalTick(f.store); }
  assert.equal(events(f, 'queue.held'), 1, 'one queue.held for forty ticks');
  const [held] = f.store.db.prepare("SELECT payload FROM events WHERE type='queue.held'").all().map(row => JSON.parse(row.payload));
  assert.equal(held.taskId, task.id);
  const hold = queueStatus(f.store).holds.find(row => row.kind === 'claim');
  assert.ok(hold, 'queue status shows the refused claim'); assert.equal(hold.taskId, task.id); assert.match(hold.text, /could not start task drift/);
  assert.equal(typeof hold.times?.[0], 'string');
  // A different reason is recorded again; a claim that goes through clears it.
  f.store.put('task', { ...f.store.need('task', task.id), models: { builder: 'not a model setting' } });
  for (let i = 0; i < 5; i++) { f.green(); await operationalTick(f.store); }
  assert.equal(events(f, 'queue.held'), 2, 'a changed reason is recorded once more');
  const { models: _, ...clean } = f.store.need('task', task.id); f.store.put('task', clean);
  f.green(); await operationalTick(f.store);
  assert.equal(f.store.need('queue', task.id).status, 'claimed');
  assert.equal(tickProblems(f.store)[`queue-claim:${task.id}`], undefined); assert.equal(queueStatus(f.store).holds.filter(row => row.kind === 'claim').length, 0);
});

test('O5, every hold: recordTickProblem writes one event per start or change and survives a reopened store', t => {
  const f = upkeepProject(t, { upkeep: { mode: 'off' } });
  const count = () => events(f, 'upkeep.tick-failed');
  for (let i = 0; i < 100; i++) recordTickProblem(f.store, 'upkeep-closes', 'upkeep.tick-failed', 'fictional failure');
  assert.equal(count(), 1);
  recordTickProblem(f.store, 'upkeep-closes', 'upkeep.tick-failed', 'another fictional failure'); assert.equal(count(), 2);
  f.store.tx(() => recordTickProblem(f.store, 'upkeep-closes', 'upkeep.tick-failed', 'another fictional failure')); assert.equal(count(), 2, 'inside a transaction too');
  assert.equal(tickProblems(f.store)['upkeep-closes'].reason, 'another fictional failure');
  assert.equal(clearTickProblem(f.store, 'upkeep-closes'), true); assert.equal(clearTickProblem(f.store, 'upkeep-closes'), false);
  recordTickProblem(f.store, 'upkeep-closes', 'upkeep.tick-failed', 'another fictional failure'); assert.equal(count(), 3, 'recurring after it cleared is recorded again');
});

// ---- O3: a builder whose CLI refuses to write the declared provider configuration ----
const BUILD_WORKFLOW = { version: 1, start: 'build', nodes: { build: { kind: 'effect', action: { operation: 'provider.build' }, timeoutMs: 60000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
function builderProject(t, builder) {
  const f = upkeepProject(t, { upkeep: { mode: 'off' }, extra: { providers: { builder: { provider: builder, model: 'fictional' } } } });
  f.store.setMeta('workflow', BUILD_WORKFLOW); f.store.setMeta('workflowDigest', digest(BUILD_WORKFLOW)); f.green();
  const put = (id, paths) => { const task = f.command('task.put', { task: { id, title: `Fictional ${id}`, acceptance: ['Observed fixture behavior'], paths } }).result; assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed'); return f.store.need('task', task.id); };
  return { ...f, put };
}
test('O3: a declared .claude/ or .mcp.json change refuses a Claude builder at admission, naming Codex or a person; a Codex builder is refused .codex/ and .agents/ at the top', async t => {
  const claude = builderProject(t, 'claude');
  for (const paths of [['.claude/commands/fictional.md'], ['docs/NOTES.md', '.claude'], ['src/.Claude/skills/report'], ['.mcp.json']]) {
    const task = claude.put(`claude-${paths.length}-${paths.at(-1).replace(/\W/g, '')}`, paths), reasons = admissionReasons(claude.store, task);
    const held = reasons.find(text => /declares provider configuration/.test(text));
    assert.ok(held, `${paths}: ${JSON.stringify(reasons)}`);
    assert.match(held, /its builder on claude cannot write/); assert.match(held, /Claude Code refuses writes under \.claude and to \.mcp\.json/);
    assert.match(held, /Route this task's builder to codex \(task\.models/); assert.match(held, /or make the change yourself/);
    const refused = claude.command('flow.start', { taskId: task.id, revision: task.revision, flowId: `flow-${task.id}` });
    assert.equal(refused.status, 'rejected'); assert.match(refused.error, /its builder on claude cannot write/);
  }
  // Other provider configuration, and ordinary paths, are not held for Claude.
  for (const paths of [['.agents/skills/report'], ['.codex/config.toml'], ['docs/NOTES.md']]) assert.ok(!admissionReasons(claude.store, claude.put(`claude-ok-${paths[0].replace(/\W/g, '')}`, paths)).some(text => /declares provider configuration/.test(text)), String(paths));
  const codex = builderProject(t, 'codex');
  const held = admissionReasons(codex.store, codex.put('codex-agents', ['.agents/skills/report'])).find(text => /declares provider configuration/.test(text));
  assert.match(held, /its builder on codex cannot write \.agents\/skills\/report \(Codex's sandbox keeps \.codex and \.agents at the top of the worktree read-only\)/); assert.match(held, /Route this task's builder to claude/);
  for (const paths of [['.claude/commands/fictional.md'], ['.mcp.json'], ['src/.codex/notes.md']]) assert.ok(!admissionReasons(codex.store, codex.put(`codex-ok-${paths[0].replace(/\W/g, '')}`, paths)).some(text => /declares provider configuration/.test(text)), String(paths));
});

// ---- O2: Codex's sandbox and Node child processes ----
import { CODEX_SANDBOX_NOTICE, codexSandboxSpawnProbe, codexWorktreeNotice } from '../starter/factory/adapters/providers/index.mjs';
import { buildQuestionItem } from '../starter/factory/core/worker-questions.mjs';
import { doctor } from '../starter/factory/workflows/commission.mjs';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('O2: a Codex builder is told what its sandbox refuses and that the factory checks decide; read-only steps are not', () => {
  assert.match(codexWorktreeNotice('/w', { builder: true }), /^Repository: \/w\n/);
  assert.ok(codexWorktreeNotice('/w', { builder: true }).includes(CODEX_SANDBOX_NOTICE));
  assert.match(CODEX_SANDBOX_NOTICE, /spawnSync and execSync fail with EPERM/); assert.match(CODEX_SANDBOX_NOTICE, /not a reason to return blocked/);
  assert.ok(!codexWorktreeNotice('/w').includes(CODEX_SANDBOX_NOTICE));
});
test('O2: the offline sandbox probe runs codex sandbox with the factory\'s settings and reads refused, ok and unknown', async () => {
  const calls = [], fake = stdout => async (binary, args, options) => { calls.push({ binary, args, options }); return { code: 0, stdout, stderr: '' }; };
  assert.deepEqual(await codexSandboxSpawnProbe({ run: fake('{"status":0,"error":"EPERM"}'), cwd: '/empty' }), { spawn: 'refused', error: 'EPERM' });
  const { binary, args, options } = calls[0];
  assert.equal(binary, 'codex'); assert.deepEqual(args.slice(0, 6), ['sandbox', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=false', '--']); assert.equal(options.cwd, '/empty');
  assert.match(args.at(-1), /spawnSync\(process\.execPath/);
  // Its result is written synchronously: inside the sandbox an asynchronous write to the socket the
  // parent gives as stdout is lost (adopter report on dev.91: "codex sandbox exited 0: ").
  assert.match(args.at(-1), /require\('node:fs'\)\.writeSync\(1,/); assert.doesNotMatch(args.at(-1), /process\.stdout\.write/);
  assert.deepEqual(await codexSandboxSpawnProbe({ run: fake('{"status":0,"error":null}') }), { spawn: 'ok' });
  assert.equal((await codexSandboxSpawnProbe({ run: fake('not json') })).spawn, 'unknown');
  assert.equal((await codexSandboxSpawnProbe({ run: async () => { throw new Error('codex: not found'); } })).spawn, 'unknown');
});
function doctorFixture(t, builder = 'codex') {
  const base = mkdtempSync(join(tmpdir(), 'factotum-o2-')), root = join(base, 'repo'), remote = join(base, 'remote.git'), stateDir = join(base, 'state');
  mkdirSync(root); const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']); git(['config', 'user.email', 'fictional@example.invalid']); git(['config', 'user.name', 'Fictional']); writeFileSync(join(root, 'fixture.txt'), 'fictional'); git(['add', '.']); git(['commit', '-qm', 'Fictional baseline']); execFileSync('git', ['init', '--bare', '-q', remote]); git(['remote', 'add', 'origin', remote]); git(['push', '-q', 'origin', 'main']);
  initProject({ stateDir, root, name: 'Fictional', supervisor: 'systemd', workflow: { version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } } });
  const store = new Store(stateDir), config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/project', account: 'fictional', target: 'main', remote: 'origin' }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: builder, model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { maxFlows: 1 }, checks: [{ id: 'fixture', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], mainChecks: [{ id: 'main', argv: [process.execPath, '-e', "require('node:fs').readFileSync('fixture.txt')"], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, resources: { coordinatorPath: join(base, 'host.sqlite') }, backupRoot: join(base, 'backups') };
  store.setMeta('config', config); store.setMeta('configDigest', digest(config));
  t.after(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  return { stateDir };
}
const fakeProviders = { providerPreflight: async spec => ({ provider: spec.provider, version: 'fictional', billing: { mode: 'subscription' }, capabilities: { structuredOutput: true, readOnly: true } }), forgeTransport: async () => ({ permissions: { push: true } }) };
test('O2: doctor checks a Codex builder\'s sandbox offline and warns, never blocks; a Claude builder is not probed', async t => {
  const f = doctorFixture(t), probed = [];
  const refused = await doctor(f.stateDir, { ...fakeProviders, sandboxProbe: async options => { probed.push(options); return { spawn: 'refused', error: 'EPERM' }; } });
  assert.equal(refused.ready, true, JSON.stringify(refused.reasons));
  assert.equal(probed.length, 1); assert.match(probed[0].cwd, /doctor\/codex-sandbox$/);
  const warning = refused.warnings.find(text => /Codex's workspace-write sandbox on this host refuses part of process handling/.test(text));
  assert.ok(warning, JSON.stringify(refused.warnings)); assert.match(warning, /failed with EPERM/); assert.match(warning, /prefer a Claude builder/); assert.match(warning, /factory's fast checks, gate and main verification run outside it/);
  assert.deepEqual(refused.codexSandbox, { spawn: 'refused', error: 'EPERM' });
  const ok = await doctor(f.stateDir, { ...fakeProviders, sandboxProbe: async () => ({ spawn: 'ok' }) });
  assert.ok(!ok.warnings.some(text => /sandbox/.test(text)));
  const claude = doctorFixture(t, 'claude'), none = [];
  const result = await doctor(claude.stateDir, { ...fakeProviders, sandboxProbe: async () => { none.push(1); return { spawn: 'refused', error: 'EPERM' }; } });
  assert.equal(none.length, 0, 'no Codex builder, no probe'); assert.ok(!result.warnings.some(text => /sandbox/.test(text)));
});
test('O2: a Codex build blocked by its sandbox is reported as such, with how to spend no further build round on it', () => {
  const node = { answers: { retry: 'build', stop: 'stopped' } };
  const flow = blocked => ({ results: { build: { attemptId: 'attempt-1', provider: 'codex', result: { status: 'blocked', summary: blocked, questions: [] } } } });
  const item = buildQuestionItem(flow('Implemented the hint; node --test test/ failed: spawnSync /usr/bin/node EPERM in every CLI test.'), node);
  assert.equal(item.buildQuestion.sandbox, 'codex');
  assert.match(item.context, /blocked by a failure inside Codex's sandbox/); assert.match(item.context, /answer retry with a note telling the builder to treat that failure as environmental/); assert.match(item.context, /builder on Claude \(task\.models\)/);
  const other = buildQuestionItem(flow('The plan names a file that does not exist.'), node);
  assert.equal(other.buildQuestion.sandbox, undefined); assert.doesNotMatch(other.context, /Codex's sandbox/);
  const claude = buildQuestionItem({ results: { build: { attemptId: 'a', provider: 'claude', result: { status: 'blocked', summary: 'EPERM writing a file', questions: [] } } } }, node);
  assert.equal(claude.buildQuestion.sandbox, undefined);
});

// ---- O4: one recorded time, one form, as a time element ----
const { inboxView } = await import('../starter/factory/console/ui/inbox.mjs');
const { state } = await import('../starter/factory/console/ui/state.mjs');
test('O4: Inbox and Health show each recorded time once, as a time element, never as "date (… ago)"', () => {
  const AT = new Date(Date.now() - 11 * 60000).toISOString(), CHECKED = new Date(Date.now() - 8 * 60000).toISOString(), SCHEDULED = new Date(Date.now() - 22 * 60000).toISOString();
  const notice = { id: 'refusal-1', kind: 'notice', role: 'operator', status: 'open', version: 1, title: 'Fictional refusal', context: 'Fictional refusal notice.', createdAt: AT, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const project = { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [notice], obligations: [], queue: [], attempts: [], events: [], tasks: [], findings: [],
    mainHealth: { status: 'green', head: 'a'.repeat(40), checkedAt: CHECKED, scheduled: { status: 'green', head: 'b'.repeat(40), checkedAt: SCHEDULED } },
    settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: {}, mainChecks: [{ id: 'nightly', tier: 'scheduled' }] } } };
  state.projects = [project];
  const inbox = () => inboxView(project, { params: { item: notice.id } });
  for (const view of [inbox(), operationsView(project)]) {
    const text = textOf(view);
    assert.doesNotMatch(text, /\(\d+ (seconds?|minutes?|hours?) ago\)/, 'no date followed by a relative time');
  }
  const inboxTimes = byTag(inbox(), 'time').filter(node => node.attributes.datetime === AT);
  assert.ok(inboxTimes.length >= 1); for (const node of inboxTimes) assert.equal(node.attributes.title, `${AT} (UTC as recorded)`);
  const health = operationsView(project);
  for (const at of [CHECKED, SCHEDULED]) { const shown = byTag(health, 'time').filter(node => node.attributes.datetime === at); assert.ok(shown.length >= 1, at); for (const node of shown) assert.doesNotMatch(node.textContent, /ago/); }
});

// ---- Review of 56d49a9 ----
// A delivery project with automatic admission (or not) and a helper that queues approved tasks.
function claimProject(t, { autoQueue = true } = {}) {
  const f = upkeepProject(t, { upkeep: { mode: 'off' }, policy: { autoQueue, queueOnApproval: true } });
  f.green();
  const queue = (id, models) => { const task = f.command('task.put', { task: { id, title: `Fictional ${id}`, acceptance: ['Observed fixture behavior'] } }).result; assert.equal(f.command('task.approve', { taskId: task.id, revision: task.revision }).status, 'completed'); if (models) f.store.put('task', { ...f.store.need('task', id), models }); return id; };
  const held = () => f.store.db.prepare("SELECT payload FROM events WHERE type='queue.held' ORDER BY sequence").all().map(row => JSON.parse(row.payload));
  return { ...f, queue, held };
}
test('review P2: the same refusal of another task is a new problem: the hold and the event name that task', async t => {
  const f = claimProject(t);
  // admitFlow alone checks that a stored model choice still validates: both are refused with the same words.
  const a = f.queue('task-a', { nonsense: true });
  f.green(); await operationalTick(f.store);
  assert.deepEqual(f.held().map(row => row.taskId), [a]);
  const first = queueStatus(f.store).holds.find(row => row.kind === 'claim'); assert.equal(first.taskId, a);
  // A leaves the queue (as queue.put leaving only B would), and B is refused with the same reason.
  f.store.put('queue', { ...f.store.need('queue', a), status: 'removed', removedAt: new Date().toISOString(), removalReason: 'fictional' });
  const b = f.queue('task-b', { nonsense: true });
  f.green(); await operationalTick(f.store);
  assert.deepEqual(f.held().map(row => row.taskId), [a, b], 'B\'s refusal is written, naming B');
  assert.equal(f.held()[0].reason, f.held()[1].reason, 'with the same words');
  const holds = queueStatus(f.store).holds.filter(row => row.kind === 'claim');
  assert.deepEqual(holds.map(row => row.taskId), [b], 'A left the queue, so its hold is gone; the hold names B');
  // At the helper itself: same key, same type and reason, another task is a new event.
  assert.equal(recordTickProblem(f.store, 'fictional', 'queue.held', 'same words', { taskId: 'x' }), true);
  assert.equal(recordTickProblem(f.store, 'fictional', 'queue.held', 'same words', { taskId: 'x' }), false);
  assert.equal(recordTickProblem(f.store, 'fictional', 'queue.held', 'same words', { taskId: 'y' }), true);
  assert.equal(tickProblems(f.store).fictional.taskId, 'y');
});
test('decision 4: a task refused at final admission no longer blocks the tasks behind it; its refusal is one queue hold, and limits and rollback hold', async t => {
  const f = claimProject(t);
  const a = f.queue('task-a', { nonsense: true }), b = f.queue('task-b'), c = f.queue('task-c');
  const flowsBefore = f.store.count('flow');
  f.green(); await operationalTick(f.store);
  assert.equal(f.store.need('queue', b).status, 'claimed', 'the task behind the refused one starts');
  assert.equal(f.store.need('queue', a).status, 'queued'); assert.equal(f.store.need('queue', c).status, 'queued', 'one claim per tick, as before');
  assert.equal(f.store.count('flow'), flowsBefore + 1, 'the refused admission was rolled back: one flow, for B');
  assert.ok(!f.store.all('flow').some(flow => flow.taskId === a));
  assert.deepEqual(f.held().map(row => row.taskId), [a]);
  const hold = queueStatus(f.store).holds.find(row => row.kind === 'claim');
  assert.equal(hold.taskId, a); assert.equal(hold.scope, 'task'); assert.match(hold.text, /The tasks behind it are still started/);
  // Later ticks try A again and write nothing more; C is held by capacity, an ordinary reason.
  for (let i = 0; i < 10; i++) { f.green(); await operationalTick(f.store); }
  assert.deepEqual(f.held().map(row => row.taskId), [a], 'still one event for A');
  // A fixed: it is claimed once a slot is free, and its hold is gone.
  const { models: _, ...clean } = f.store.need('task', a); f.store.put('task', clean);
  f.store.put('flow', { ...f.store.all('flow').find(flow => flow.taskId === b), state: 'completed', finishedAt: new Date().toISOString() });
  f.green(); await operationalTick(f.store);
  assert.equal(f.store.need('queue', a).status, 'claimed');
  assert.equal(queueStatus(f.store).holds.filter(row => row.kind === 'claim').length, 0);
});
test('decision 4: a manual queue dispatch moves past a task refused at final admission and records it on the job', async t => {
  const f = claimProject(t, { autoQueue: false });
  const a = f.queue('task-a', { nonsense: true }), b = f.queue('task-b');
  const sent = f.command('job.enqueue', { operation: 'queue.dispatch', note: 'Fictional dispatch' });
  assert.equal(sent.status, 'completed', sent.error);
  f.green(); await operationalTick(f.store);
  const job = f.store.all('job').find(row => row.operation === 'queue.dispatch');
  assert.equal(job.outcome, 'dispatched'); assert.equal(f.store.need('queue', b).status, 'claimed'); assert.equal(f.store.need('queue', a).status, 'queued');
  assert.deepEqual(job.refused.map(row => row.taskId), [a]);
  assert.ok(!f.store.all('flow').some(flow => flow.taskId === a), 'A\'s admission was rolled back to the savepoint');
});
test('review P3: an upkeep tick failure ends when no such work remains, and a later recurrence is a new event', async t => {
  const f = upkeepProject(t, { upkeep: { mode: 'off' } });
  // A close the tick cannot settle: its record's job list is not a list, so queueing the close throws.
  const failing = () => { f.store.put('flow', { id: 'flow-broken', taskId: 'fictional', state: 'failed', upkeepPullRequest: { number: 7, jobs: 5 } }); f.store.setMeta('upkeepWork', { ...f.store.meta('upkeepWork', {}), closes: { 'flow-broken': 'job-x' } }); };
  failing();
  for (let i = 0; i < 3; i++) await operationalTick(f.store);
  assert.equal(events(f, 'upkeep.tick-failed'), 1);
  assert.ok(tickProblems(f.store)['upkeep-closes']);
  // The work goes away: the problem ends with it.
  f.store.setMeta('upkeepWork', { ...f.store.meta('upkeepWork', {}), closes: {} });
  await operationalTick(f.store);
  assert.equal(tickProblems(f.store)['upkeep-closes'], undefined);
  // The same failure later is recorded again.
  failing();
  await operationalTick(f.store);
  assert.equal(events(f, 'upkeep.tick-failed'), 2, 'a recurrence after the queue emptied is a new event');
  // The same for runs: a run failure recorded as the tick records it ends when no run remains.
  f.store.setMeta('upkeepWork', { closes: {}, runs: {} });
  recordTickProblem(f.store, 'upkeep-runs', 'upkeep.tick-failed', 'fictional run failure');
  await operationalTick(f.store);
  assert.equal(tickProblems(f.store)['upkeep-runs'], undefined, 'no runs left: the problem is over');
  assert.equal(recordTickProblem(f.store, 'upkeep-runs', 'upkeep.tick-failed', 'fictional run failure'), true, 'the same failure later is a new event');
});
test('review of 851fad5: Queue shows the task a manual dispatch started and each task it skipped, with why, as text', async t => {
  const f = claimProject(t, { autoQueue: false });
  const a = f.queue('task-a', { nonsense: true }), b = f.queue('task-b');
  assert.equal(f.command('job.enqueue', { operation: 'queue.dispatch', note: 'Fictional dispatch' }).status, 'completed');
  f.green(); await operationalTick(f.store);
  const snapshot = dashboardSnapshot(f.store), last = snapshot.queueStatus.lastDispatch;
  assert.equal(last.outcome, 'dispatched'); assert.equal(last.taskId, b);
  assert.deepEqual(last.refused.map(row => row.taskId), [a]); assert.match(last.refused[0].reason, /task models map/);
  state.projects = [];
  const project = { projectId: f.project.projectId, bindingId: 'binding-1', name: 'Fictional', status: 'available', observedAt: new Date().toISOString(), snapshot };
  const view = queueView(project, { params: {} }), text = textOf(view);
  assert.match(text, /Last dispatch .* started Fictional task-b \(its flow\)\./);
  assert.match(text, /Skipped, because it could not be admitted:/);
  assert.match(text, /Fictional task-a: .*task models map/);
  assert.match(text, /is skipped, and the next queued task is tried/, 'the Dispatch now help says so');
  const links = byTag(view, 'a').map(node => node.getAttribute('href') ?? '');
  assert.ok(links.some(href => href.includes(encodeURIComponent(a)) || href.includes(a)), 'the skipped task is linked');
  assert.ok(links.some(href => href.includes(encodeURIComponent(b)) || href.includes(b)), 'the started task is linked');
  // The reason is text: markup in it is never parsed.
  const hostile = { ...snapshot, queueStatus: { ...snapshot.queueStatus, lastDispatch: { ...last, refused: [{ taskId: a, reason: '<img src=x onerror=alert(1)> refused' }], refusedCount: 1 } } };
  const safe = queueView({ ...project, snapshot: hostile }, { params: {} });
  assert.equal(byTag(safe, 'img').length, 0); assert.match(textOf(safe), /<img src=x onerror=alert\(1\)> refused/);
  assert.ok(byTag(safe, 'div').some(node => String(node.className ?? node.attributes?.class ?? '').includes('dispatch-result')), 'the result wraps at narrow widths (.dispatch-result)');
});
