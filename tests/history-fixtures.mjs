// Fixtures for the record-layout and idle-read tests. Everything is fictional.
// States are built the way the release before the attempt-intent split wrote them:
// raw rows with each attempt's dispatch intent inline, and no indexes on records.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store, initProject } from '../starter/factory/core/store.mjs';
import { digest } from '../starter/factory/core/contracts.mjs';

const hex = value => createHash('sha256').update(String(value)).digest('hex');
const RELEASE_DDL = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
  CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL);
  CREATE TABLE commands (id TEXT PRIMARY KEY, digest TEXT NOT NULL, data TEXT NOT NULL);`;
function scratch(t) { const base = mkdtempSync(join(tmpdir(), 'fct-layout-')); t.after(() => rmSync(base, { recursive: true, force: true })); return base; }

// The committed rows of a state the release wrote (tests/fixtures/state-release-format.json), loaded
// verbatim into a database with that release's tables. Its checkout is not recreated: read models only.
export function releaseFormatState(t) {
  const base = scratch(t), stateDir = join(base, 'state'), dump = JSON.parse(readFileSync(new URL('./fixtures/state-release-format.json', import.meta.url), 'utf8')).tables;
  mkdirSync(stateDir, { mode: 0o700 });
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; ${RELEASE_DDL}`); db.exec('BEGIN');
  for (const row of dump.meta) db.prepare('INSERT INTO meta VALUES(?,?)').run(row.key, row.value);
  for (const row of dump.records) db.prepare('INSERT INTO records VALUES(?,?,?)').run(row.kind, row.id, row.data);
  for (const row of dump.events) db.prepare('INSERT INTO events(sequence,at,type,payload) VALUES(?,?,?,?)').run(row.sequence, row.at, row.type, row.payload);
  for (const row of dump.commands) db.prepare('INSERT INTO commands VALUES(?,?,?)').run(row.id, row.digest, row.data);
  db.exec('COMMIT'); db.close();
  return { base, stateDir, rows: dump.records };
}

// A commissioned delivery project with a real checkout, as the earlier release left it: no indexes, no layout fence.
export function releaseProject(t, { policy = {} } = {}) {
  const base = scratch(t), root = join(base, 'repo'), stateDir = join(base, 'state');
  mkdirSync(join(root, 'factory'), { recursive: true }); mkdirSync(join(root, 'project'));
  writeFileSync(join(root, 'factory', 'AGENTS.md'), 'Fictional\n'); writeFileSync(join(root, 'project', 'GOVERNANCE.md'), 'Fictional\n');
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 'fixture@example.invalid'], ['config', 'user.name', 'Fictional Evaluator'], ['config', 'commit.gpgsign', 'false'], ['add', '.'], ['commit', '-qm', 'Fictional baseline']]) execFileSync('git', args, { cwd: root });
  const config = JSON.parse(readFileSync(new URL('../starter/project/factotum.template.json', import.meta.url), 'utf8'));
  config.resources.coordinatorPath = join(base, 'resources.sqlite'); config.backupRoot = join(base, 'backups'); config.policy = { ...config.policy, ...policy };
  const project = initProject({ stateDir, root, name: 'Fictional long-running project', supervisor: 'process', config });
  const store = new Store(stateDir), at = new Date().toISOString(), head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  for (const row of store.db.prepare("SELECT type, name FROM sqlite_master WHERE (type='index' AND tbl_name='records' AND sql IS NOT NULL) OR (type='trigger' AND name LIKE 'factotum_layout_fence_%')").all()) store.db.exec(`DROP ${row.type} ${row.name}`);
  store.setMeta('commissioning', { ready: true, configDigest: store.meta('configDigest'), checkedAt: at });
  store.setMeta('mainHealth', { status: 'green', head, checkedAt: at, checks: [{ id: 'baseline', status: 'passed', passed: true }] });
  store.setMeta('hostSampleAt', at);
  store.close();
  return { base, root, stateDir, project, head };
}

// One settled attempt in the earlier release's shape, intent inline, of about intentBytes.
export function releaseAttempt({ projectId, flowId, step = 'build', operation = 'provider.build', intentBytes = 2000, status = 'passed', settled = true, at = Date.now(), action = {}, extra = {} }) {
  const id = randomUUID(), iso = ms => new Date(at + ms).toISOString();
  const intent = { version: 1, attemptId: id, projectId, flowId, step, argv: ['node', 'dispatch.mjs', `attempts/${id}/intent.json`],
    action: { operation, projectId, flowId, step, task: { id: `task-of-${flowId}`, revision: hex(flowId), acceptance: ['Observed fictional behaviour'] }, results: {}, guidance: 'fictional guidance '.repeat(Math.ceil(intentBytes / 19)).slice(0, intentBytes), ...action },
    cwd: '/fictional/checkout', synthetic: false, projectRoot: '/fictional/checkout', timeoutMs: 600000, maxCostMicros: 0, executorDigest: hex('executor'), inputIdentity: { head: hex('head').slice(0, 40), treeDigest: hex('tree') }, unit: `factotum-${id}`, containment: 'systemd' };
  const intentDigest = digest(intent);
  return { id, flowId, step, status, intent, intentDigest, reservedMicros: 0, createdAt: iso(0), unit: `factotum-${id}`, authorityVersion: 2, dispatchedAt: iso(500),
    ...(settled ? { receipt: { version: 1, attemptId: id, intentDigest, startedAt: iso(600), endedAt: iso(60000), exitCode: status === 'passed' ? 0 : 1, signal: null, reason: null, descendants: [], synthetic: false, costMicros: 0, stdoutDigest: hex(`${id}o`), stderrDigest: hex(`${id}e`), actionResult: { route: status === 'passed' ? 'pass' : 'fail', summary: 'fictional summary '.repeat(40) } }, costMicros: 0, settledAt: iso(61000) } : {}), ...extra };
}

// Settled history written the earlier release's way: `changes` finished change flows of four
// attempts each with their task, queue entry, answered question, wait, deliveries and context;
// `maintenance` finished maintenance flows with their job; and host samples.
export function addHistory(stateDir, { changes = 20, maintenance = 20, samples = 200, intentBytes = 2000 } = {}) {
  const db = new DatabaseSync(join(stateDir, 'state.sqlite')), put = db.prepare('INSERT INTO records VALUES(?,?,?)'), event = db.prepare('INSERT INTO events(at,type,payload) VALUES(?,?,?)');
  const meta = key => JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get(key).value), project = meta('project'), workflow = meta('workflow'), configDigest = meta('configDigest');
  const row = (kind, record) => { put.run(kind, record.id, JSON.stringify(record)); return record; };
  const steps = Object.entries(workflow.nodes).filter(([, node]) => node.kind === 'effect').slice(0, 4).map(([step, node]) => [step, node.action?.operation ?? 'provider.build']);
  let clock = Date.now() - 40 * 86400000, bytes = 0; const tick = ms => (clock += ms), iso = () => new Date(clock).toISOString(), tag = randomUUID().slice(0, 8);
  db.exec('BEGIN');
  for (let i = 0; i < changes; i++) {
    const taskId = `history-${tag}-${i}`, flowId = `history-flow-${tag}-${i}`, revision = hex(taskId); tick(600000); const createdAt = iso();
    const task = row('task', { id: taskId, title: `Fictional settled change ${i}`, acceptance: ['Observed fictional behaviour'], paths: ['src/module.js'], risk: 'ordinary', revision, approvedRevision: null, approvalVersion: 2, status: 'completed' });
    row('queue', { id: taskId, order: i, status: 'finished', queuedAt: createdAt, claimedAt: createdAt, finishedAt: createdAt, flowId, flowState: 'completed', source: 'approval' });
    const results = {};
    for (const [step, operation] of steps) { const attempt = row('attempt', releaseAttempt({ projectId: project.projectId, flowId, step, operation, intentBytes, at: tick(1000) })); bytes += JSON.stringify(attempt).length; tick(61000); results[step] = { route: 'pass', summary: 'fictional result '.repeat(30) }; for (const type of ['attempt.prepared', 'attempt.dispatching', 'attempt.settled']) event.run(iso(), type, JSON.stringify({ attemptId: attempt.id })); }
    const inboxId = randomUUID(), asked = iso(); tick(300000); const answered = iso();
    row('inbox', { id: inboxId, kind: 'question', status: 'answered', flowId, version: 2, subjectDigest: hex(inboxId), question: 'Merge this fictional candidate?', answers: ['merge', 'stop'], transitions: { merge: 'done', stop: 'stopped' }, role: 'operator', createdAt: asked, expiresAt: new Date(Date.parse(asked) + 86400000).toISOString(), answer: 'merge', answeredBy: 'operator', answeredAt: answered });
    row('wait', { id: `question:${inboxId}`, flowId, inboxId, kind: 'question', startedAt: asked, endedAt: answered, reason: 'answered' });
    for (const [version, status] of [[1, 'open'], [2, 'answered']]) row('delivery', { id: digest({ inboxId, version, channel: 'operator' }), inboxId, inboxVersion: version, inboxStatus: status, event: status === 'open' ? 'inbox.attention' : 'inbox.resolved', channel: 'operator', status: version === 1 ? 'superseded' : 'suppressed', attempts: 0, nextAt: asked });
    row('context', { id: `context-${tag}-${i}`, flowId, digest: hex(`context${i}`), chars: 1180, files: [], omitted: [], deliveredAt: asked });
    tick(1000);
    row('flow', { strictDecisionRole: 'operator', mergeDecisionRole: 'operator', reviewProtocol: 'fresh-full', effectiveRisk: 'ordinary', riskAssessments: [], candidate: null, completionMode: 'merge', id: flowId, taskId, taskSnapshot: task, taskRevision: revision, approvalVersion: 2, workflow, workflowDigest: digest(workflow), configDigest, mode: 'delivery', kind: 'change', executorDigest: hex('executor'), step: 'done', state: 'completed', stopRequested: false, abortRequested: false, transitions: steps.length + 1, visits: Object.fromEntries(steps.map(([step]) => [step, 1])), evidence: {}, results: { ...results, merge: { merged: true }, cleanup: { released: true } }, sessions: {}, attemptId: null, createdAt, finishedAt: iso(), target: 'main' });
    event.run(iso(), 'flow.finished', JSON.stringify({ flowId, outcome: 'completed' }));
  }
  for (let i = 0; i < maintenance; i++) {
    const operation = i % 3 ? 'machine.sample' : 'main.verify', jobId = hex(`job-${tag}-${i}`), taskId = `job:${jobId}`, flowId = `maintenance:${jobId}`, revision = hex(taskId); tick(3600000); const createdAt = iso();
    const task = row('task', { id: taskId, title: `Maintenance: ${operation}`, acceptance: [`Execute approved ${operation} scope and retain evidence`], revision, approvedRevision: revision, approvalVersion: 1, approvalKind: 'schedule', scheduleId: 'hourly', paths: [], risk: 'strict' });
    const attempt = row('attempt', releaseAttempt({ projectId: project.projectId, flowId, step: 'run', operation, intentBytes, at: tick(1000) })); bytes += JSON.stringify(attempt).length; tick(61000);
    const wf = { version: 1, start: 'run', nodes: { run: { kind: 'effect', action: { operation }, timeoutMs: 600000, next: 'done', onFailure: 'failed' }, done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' } } };
    row('flow', { id: flowId, taskId, taskRevision: revision, taskSnapshot: task, approvalVersion: 1, kind: 'maintenance', jobId, jobPayload: {}, workflow: wf, workflowDigest: digest(wf), configDigest, mode: 'delivery', executorDigest: hex('executor'), step: 'done', state: 'completed', stopRequested: false, abortRequested: false, transitions: 1, visits: { run: 1 }, evidence: {}, results: { run: { route: 'pass' } }, sessions: {}, attemptId: null, createdAt, finishedAt: iso() });
    row('job', { id: jobId, operation, payload: {}, scheduleId: 'hourly', scheduleRevision: hex('schedule'), status: 'completed', createdAt, flowId, finishedAt: iso(), outcome: 'completed' });
  }
  for (let i = samples; i > 0; i--) { const at = new Date(Date.now() - i * 120000).toISOString(); row('hostSample', { id: at, observedAt: at, uptimeSeconds: 1000 + i, loadAverage: [1, 1, 1], memoryBytes: { total: 64e9, available: 32e9 } }); }
  db.exec('COMMIT'); db.close();
  return { attemptBytes: bytes };
}

// Records every statement a store runs: its text, arguments, rows and bytes returned, so a test
// can bound what a tick or a poll reads without measuring time.
export function instrument(store) {
  let seen = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    for (const name of ['all', 'get']) { const run = statement[name].bind(statement); statement[name] = (...args) => { const out = run(...args), rows = Array.isArray(out) ? out : out ? [out] : []; seen.push({ sql, args, rows: rows.length, bytes: rows.reduce((sum, found) => sum + Object.values(found).reduce((n, value) => n + (typeof value === 'string' ? value.length : 8), 0), 0) }); return out; }; }
    return statement;
  };
  // A read of every record of a kind: a plan that searches records by kind alone (or scans it)
  // in a statement that is neither a count nor limited. Returns the kinds read that way.
  const wholeKinds = statements => {
    const kinds = new Set();
    for (const { sql, args } of statements) {
      if (!/\bFROM records\b/.test(sql) || /count\(\*\)/i.test(sql) || /\bLIMIT\b/i.test(sql)) continue;
      const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(step => step.detail);
      if (plan.some(detail => /^SCAN records/.test(detail) || /^SEARCH records USING (COVERING )?INDEX (records_kind|sqlite_autoindex_records_1) \(kind=\?\)$/.test(detail))) kinds.add(/kind='([A-Za-z]+)'/.exec(sql)?.[1] ?? args[0]);
    }
    return [...kinds].sort();
  };
  return { take() { const statements = seen; seen = []; return { statements: statements.length, rows: statements.reduce((sum, s) => sum + s.rows, 0), bytes: statements.reduce((sum, s) => sum + s.bytes, 0), wholeKinds: wholeKinds(statements), eventScans: statements.filter(s => /\bFROM events\b/.test(s.sql) && !/\bLIMIT\b/i.test(s.sql)).map(s => s.sql) }; } };
}
