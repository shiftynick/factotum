// dev.83: console defects from the dev.82 real-browser pass (G15, G23) and the refused adoption of a
// pull request that changes the factory's managed files (G25). Views render into the fake DOM from
// the data the project service returns; service reads and the integrate refusal run for real.
// Modules are imported as namespaces, so a helper missing on an older tree fails its own test only.
// Fictional fixtures throughout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { installDom, byTag, withText, click, descendants } from './fake-dom.mjs';
import { sandbox } from './helpers.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { startProjectService } from '../starter/factory/service/project-service.mjs';
import { requestProject } from '../starter/factory/console/client.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { git, prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import * as admission from '../starter/factory/operations/admission.mjs';
import * as projectCore from '../starter/factory/core/project.mjs';
import * as engineModule from '../starter/factory/core/engine.mjs';

installDom();
const { state, readPath } = await import('../starter/factory/console/ui/state.mjs');
const plan = await import('../starter/factory/console/ui/plan.mjs');
const { queueView } = await import('../starter/factory/console/ui/queue.mjs');
const { receiptsView } = await import('../starter/factory/console/ui/receipts.mjs');
const timeline = await import('../starter/factory/console/ui/timeline.mjs');
const stats = await import('../starter/factory/console/ui/stats.mjs');
const { mergeCandidateView } = await import('../starter/factory/console/ui/inbox.mjs');

const css = readFileSync(new URL('../starter/factory/console/style.css', import.meta.url), 'utf8');
const text = node => node.textContent;
const NOW = Date.now(), ago = ms => new Date(NOW - ms).toISOString();
function project(snapshot = {}, settings = {}) {
  return { projectId: 'fictional', bindingId: 'binding-1', name: 'Fictional project', status: 'available', observedAt: new Date().toISOString(), snapshot: {
    revision: 1, flows: [], inbox: [], obligations: [], queue: [], attempts: [], events: [], tasks: [],
    ...snapshot, settings: { mode: 'delivery', configDigest: 'config-1', holds: {}, workflow: { steps: [] }, repository: { slug: 'fictional/demo', target: 'main' }, policy: { autoQueue: true }, ...settings } } };
}
function preload(p, kind, subject, data, query = {}) {
  state.reads.set(`${p.projectId}|${p.bindingId}|${readPath(p, kind, subject, query)}`, { status: 'ready', data, fetchedAt: new Date().toISOString(), revision: p.snapshot.revision });
}

// ---- G23 h: an approval that no longer covers the selected workflow can be renewed from the page ----
const STALE = 'approval does not cover selected workflow standard; approve the task again';
const staleTask = (extra = {}) => ({ id: 'task-1', title: 'Fictional change', revision: 'r2', approvedRevision: 'r2', approvalVersion: 3, acceptance: ['It works'], status: 'approved',
  workflowSelection: { selected: 'standard', approved: 'standard', current: false, kind: 'change', reasons: [STALE] }, admissionReasons: [STALE], admissionHolds: [{ text: STALE, code: 'approval-stale', workflow: 'standard' }], ...extra });

test('G23 h: a queued task approved for another workflow offers Approve again, which sends the CLI task.approve with the current revision', async t => {
  const task = staleTask(), p = project({ queue: [{ id: 'task-1', status: 'queued', order: 1 }], tasks: [task] });
  state.projects = [p]; state.unresolved = new Set(); state.journal = [];
  const detail = plan.taskDetail(p, task);
  assert.match(text(detail), /Approved for another workflow/);
  const again = withText(detail, 'button', 'Approve again');
  assert.equal(again.length, 1, 'the task detail offers Approve again beside Revoke approval');
  let sent; const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; state.journal = []; state.projects = []; });
  globalThis.fetch = async (_path, init) => { sent = JSON.parse(init.body); return { ok: true, json: async () => ({ projectId: 'fictional', commandId: sent.commandId, status: 'completed', receipt: { status: 'completed' } }) }; };
  await click(again[0]);
  const confirm = withText(plan.taskDetail(p, task), 'button', 'Confirm: Approve again');
  assert.equal(confirm.length, 1, 'the approval is confirmed first, naming the target');
  await click(confirm[0]);
  assert.equal(sent.operation, 'task.approve');
  assert.deepEqual(sent.payload, { taskId: 'task-1', revision: 'r2' }, 'the same command and precondition as the CLI');
  // Queue → Admission readiness and the Tasks list show the same state, with the action in Queue.
  preload(p, 'tasks', 'task-1', { projectId: 'fictional', task, flows: [] });
  const queue = queueView(p, { params: { task: 'task-1' } });
  assert.equal(withText(queue, 'button', 'Approve again').length, 1, 'Queue offers Approve again');
  assert.match(text(queue), /Approved for another workflow; approve again/);
  preload(p, 'collections', 'task', { projectId: 'fictional', items: [task], total: 1, nextCursor: null }, { cursor: '0', limit: '50', order: 'desc' });
  assert.match(text(plan.tasksView(p, { params: {} })), /Approve again: workflow changed/);
  // A current approval offers no renewal.
  const current = staleTask({ workflowSelection: { selected: 'standard', approved: 'standard', current: true }, admissionHolds: [], admissionReasons: [] });
  assert.equal(withText(plan.taskDetail(p, current), 'button', 'Approve again').length, 0);
});

// ---- G23 j: a held queue never promises automatic admission -----------------------------------------
test('G23 j: a queued task says nothing is admitted while admission is paused or the queue is otherwise held', () => {
  const task = { id: 'task-1', revision: 'r1', approvedRevision: 'r1' }, queue = [{ id: 'task-1', status: 'queued' }];
  const detail = snapshot => plan.approvalState({ queue, settings: { policy: { autoQueue: true } }, ...snapshot }, task).detail;
  const paused = detail({ paused: true, queueStatus: { autoQueue: true, holds: [{ kind: 'paused', text: 'Admission is paused. Resume it from Overview.' }] } });
  assert.doesNotMatch(paused, /Automatic admission will start/); assert.match(paused, /Nothing is admitted while the queue is held: Admission is paused/);
  const spending = detail({ queueStatus: { autoQueue: true, holds: [{ kind: 'money', text: 'A spending overrun hold is in place; see Operations.' }] } });
  assert.doesNotMatch(spending, /Automatic admission will start/); assert.match(spending, /spending overrun hold/);
  // An older project service without queue status: the snapshot's own pause flag.
  assert.match(detail({ paused: true }), /Nothing is admitted while the queue is held: Admission is paused/);
  // A change-scoped hold does not hold a task-kind workflow.
  assert.match(plan.approvalState({ queue, settings: { policy: { autoQueue: true } }, queueStatus: { holds: [{ kind: 'main', scope: 'change', target: 'main', text: 'Change and document tasks wait: main health unknown.' }] } }, { ...task, workflowSelection: { kind: 'task' } }).detail, /Automatic admission will start/);
  assert.match(detail({ queueStatus: { autoQueue: true, holds: [] } }), /Automatic admission will start queued work/);
});

// ---- G15 a: admission holds are structured; times are local with the UTC value as a tooltip ------------
test('G15 a: admission holds carry structured fields beside the unchanged reasons', t => {
  const f = sandbox(t), future = new Date(Date.now() + 3 * 86400000).toISOString().replace(/\.\d+Z$/, 'Z');
  f.command('task.schedule', { taskId: 'task-1', notBefore: future });
  f.command('pause', { paused: true, note: 'Fictional pause' });
  const facts = new Map(), reasons = admission.admissionReasons(f.store, f.store.need('task', 'task-1'), { facts });
  assert.ok(reasons.includes(`scheduled: not before ${future}`), 'the reason text is unchanged');
  assert.deepEqual(facts.get(`scheduled: not before ${future}`), { code: 'not-before', at: future, times: [future] });
  assert.deepEqual(facts.get('project held'), { code: 'held', holds: ['paused'] });
  assert.deepEqual(admission.admissionReasons(f.store, f.store.need('task', 'task-1')), reasons, 'without facts the reasons are the same');
  const view = projectCore.taskView(f.store, f.store.need('task', 'task-1'));
  assert.ok(Array.isArray(view.admissionHolds), 'the task view carries admissionHolds');
});

test('G15 a: Queue and task detail show hold times in the viewer zone with the recorded UTC value as a tooltip, and name flows', () => {
  const at = '2026-11-18T12:48:25Z', checked = '2026-11-15T04:00:00Z', other = 'f1a2b3c4-0000-4000-8000-000000000009';
  const holds = [{ text: `scheduled: not before ${at}`, code: 'not-before', at }, { text: `paths overlap: ${other}`, code: 'paths-overlap', flowId: other },
    { text: `main health is stale: last verified ${checked} at 0123456789ab, older than policy.mainHealthMaxAgeMs; run main.verify to refresh it`, times: [checked] }, { text: 'project held', code: 'held', holds: ['paused'] }];
  const task = { id: 'task-1', title: 'Fictional change', revision: 'r1', approvedRevision: 'r1', acceptance: ['It works'], admissionReasons: holds.map(row => row.text), admissionHolds: holds };
  const p = project({ queue: [{ id: 'task-1', status: 'queued', order: 1 }], tasks: [task], flows: [{ id: other, taskId: 'task-9', kind: 'change', state: 'running', taskSnapshot: { title: 'Other fictional work' } }] });
  state.projects = [p]; state.unresolved = new Set();
  preload(p, 'tasks', 'task-1', { projectId: 'fictional', task, flows: [] });
  for (const view of [queueView(p, { params: { task: 'task-1' } }), plan.taskDetail(p, task)]) {
    // The collapsed raw record keeps the recorded values; everything else is what the operator reads.
    const shown = descendants(view).filter(n => !n.closest('details')).map(n => n._text).join(' ');
    assert.doesNotMatch(shown, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'no raw ISO time is shown');
    const times = byTag(view, 'time');
    // Queue shows the holds twice (Admission readiness, and the queue entry's advisory holds, which since dev.84 render <time> too).
    assert.deepEqual([...new Set(times.map(n => n.getAttribute('datetime')))].sort(), [at, checked].sort());
    assert.ok(times.every(n => n.getAttribute('title').includes(n.getAttribute('datetime')) && /UTC/.test(n.getAttribute('title'))), 'the recorded UTC value is in the tooltip');
    assert.match(shown, /Scheduled: not before/); assert.match(shown, /Admission is held: admission is paused/);
    assert.ok(byTag(view, 'a').some(a => text(a).includes('Other fictional work')), 'the overlapping flow is named and linked');
  }
  state.projects = [];
});

// ---- G23 i: request receipts follow the real work, never "completed" while it runs ----------------------
test('G23 i: a doctor or job request receipt is badged with the run it asked for, not "completed"', () => {
  const doctor = { projectId: 'fictional', commandId: 'c-1', bindingId: 'binding-1', operation: 'doctor.request', status: 'completed', submittedAt: ago(5000), receipt: { status: 'completed', result: { id: 'dr-1' } } };
  const job = { projectId: 'fictional', commandId: 'c-2', bindingId: 'binding-1', operation: 'job.enqueue', status: 'completed', submittedAt: ago(4000), receipt: { status: 'completed', result: { id: 'job-1', operation: 'queue.dispatch', status: 'queued' } } };
  state.journal = [doctor, job];
  const header = view => byTag(view, 'article').map(article => text(byTag(article, 'header')[0]));
  const render = (doctorStatus, jobRecord) => {
    const p = project({ revision: Math.random() }, { doctorRequest: { id: 'dr-1', status: doctorStatus, startedAt: ago(3000), ...(doctorStatus === 'passed' ? { finishedAt: ago(1000) } : {}) } });
    state.projects = [p]; preload(p, 'jobs', 'job-1', { projectId: 'fictional', job: jobRecord });
    return receiptsView(p);
  };
  let view = render('running', { id: 'job-1', operation: 'queue.dispatch', status: 'running', createdAt: ago(4000) });
  let heads = header(view);
  assert.ok(heads.every(row => !/completed/i.test(row)), heads.join(' | '));
  assert.ok(heads.some(row => /Doctor running/.test(row)) && heads.some(row => /queue\.dispatch running/.test(row)));
  assert.ok(byTag(view, 'article').every(article => !article.className.includes('tone-good')), 'not drawn as a finished success');
  view = render('passed', { id: 'job-1', operation: 'queue.dispatch', status: 'completed', outcome: 'dispatched', finishedAt: ago(500) });
  heads = header(view);
  assert.ok(heads.some(row => /Doctor passed/.test(row)) && heads.some(row => /queue\.dispatch finished/.test(row)), heads.join(' | '));
  assert.match(text(view), /started a queued task/);
  state.journal = []; state.projects = [];
});

test('G23 i: the project service reads one job by ID, without its payload or grant', async t => {
  const f = sandbox(t), socketPath = join(f.base, 'd83.sock');
  const app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false }); t.after(() => app.close());
  const job = f.command('job.enqueue', { operation: 'queue.dispatch', payload: {}, note: 'Fictional dispatch' }).result;
  const read = await requestProject(socketPath, { path: `/v1/jobs/${job.id}`, timeoutMs: 30000 });
  assert.equal(read.job.id, job.id); assert.equal(read.job.status, 'queued'); assert.equal(read.job.operation, 'queue.dispatch');
  assert.equal(read.job.grant, undefined); assert.equal(read.job.payload, undefined);
});

// ---- G15 e: only evidence files the attempt has; a missing one is an empty state ------------------------
test('G15 e: flow detail lists each attempt\'s evidence files, and a file never written is an empty state, not a 404', async t => {
  const f = sandbox(t), socketPath = join(f.base, 'd83e.sock');
  f.start();
  for (let i = 0; i < 400 && f.store.need('flow', 'flow-1').state !== 'completed'; i++) { await f.engine.step('flow-1'); await delay(25); }
  assert.equal(f.store.need('flow', 'flow-1').state, 'completed');
  const app = await startProjectService({ stateDir: f.stateDir, socketPath, run: false }); t.after(() => app.close());
  const read = path => requestProject(socketPath, { path, timeoutMs: 30000 });
  const detail = await read('/v1/flows/flow-1'), [attempt] = detail.attempts;
  assert.ok(Array.isArray(attempt.artifacts) && attempt.artifacts.includes('stdout.log'), JSON.stringify(attempt.artifacts));
  assert.ok(!attempt.artifacts.some(name => name.startsWith('provider/')), 'a step that made no model call has no provider files');
  const missing = await read(`/v1/artifacts/${attempt.id}?name=${encodeURIComponent('provider/prompt.txt')}`);
  assert.deepEqual({ available: missing.available, text: missing.text }, { available: false, text: '' });
  assert.equal((await read(`/v1/artifacts/${attempt.id}?name=stdout.log`)).available, undefined, 'an existing file reads as before');
  // The console offers exactly the listed files.
  assert.deepEqual(timeline.artifactNames({ artifacts: ['stdout.log', 'stderr.log', 'action-result.json'] }), ['stdout.log', 'stderr.log', 'action-result.json']);
  assert.deepEqual(timeline.artifactNames({ artifacts: [] }), []);
});

// ---- G15 b, c, d: phone layout ---------------------------------------------------------------------------
test('G15 b: twelve weekly chart labels are thinned and cannot widen the chart', () => {
  assert.match(css, /\.mlabels span \{ min-width: 0; \}/, 'labels do not force their minimum text width on the chart');
  const shown = n => Array.from({ length: n }, (_, i) => stats.chartLabelShown(n, i)).filter(Boolean).length;
  assert.equal(shown(7), 7); assert.ok(shown(12) <= 7, `${shown(12)} labels for 12 weeks`); assert.ok(shown(30) <= 7);
  assert.ok(stats.chartLabelShown(12, 0), 'the first period is labelled');
});

test('G15 c: timeline markers are clustered by their width on screen, so they do not overprint on a phone', t => {
  const old = globalThis.innerWidth; t.after(() => { globalThis.innerWidth = old; });
  const from = Date.parse('2026-11-15T00:00:00Z'), to = from + 12 * 3600000, at = minutes => new Date(from + minutes * 60000).toISOString();
  const events = [{ type: 'merged', at: at(300), label: 'Merged #12', ref: '#12', flowId: 'flow-a' }, { type: 'merged', at: at(360), label: 'Merged #13', ref: '#13', flowId: 'flow-b' }];
  const data = { window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, stats: { merged: 2, completed: 2, idleSlotMs: 0, slotMs: 1 }, pools: [], events, machine: [] };
  const p = project({ revision: 7 });
  const render = width => { globalThis.innerWidth = width; state.reads.clear(); preload(p, 'timeline', '12', data); return descendants(timeline.timelineView(p)).filter(n => n.classList.includes('tl-ev') || n.classList.includes('marker-group')); };
  const phone = render(390);
  assert.equal(phone.length, 1, 'one counted marker at phone width');
  // The group is a disclosure: its summary shows the count, and its list links each event's flow.
  const [group] = phone;
  assert.equal(group.tag, 'details', 'keyboard and touch open it, not only a tooltip');
  const summary = byTag(group, 'summary')[0];
  assert.equal(text(summary), '2'); assert.match(summary.getAttribute('aria-label'), /2 events close together/);
  const items = byTag(byTag(group, 'ul')[0], 'li');
  assert.deepEqual(items.map(li => /Merged #1[23]/.test(text(li))), [true, true]);
  assert.ok(byTag(group, 'a').some(a => /flow=flow-a/.test(a.getAttribute('href'))) && byTag(group, 'a').some(a => /flow=flow-b/.test(a.getAttribute('href'))), 'each event links to its flow');
  assert.equal(render(1440).length, 2, 'an hour apart in twelve hours they stay separate on a desktop');
  // The lane is laid out from the boxes as drawn for the track's width (markerBoxes, dev.95): two
  // markers 3% of the track apart touch on a phone track (250 px) and stay apart on a desktop one (980 px).
  const pair = [{ key: 'a', at: 40 }, { key: 'b', at: 43 }];
  assert.equal(timeline.markerBoxes(pair, 250, 44).length, 1, 'a marker covers more of a phone track');
  assert.equal(timeline.markerBoxes(pair, 980, 22.4).length, 2);
  const edge = pct => timeline.markerGroup([{ text: 'Stopped · 10:00' }, { text: 'Resumed · 10:01' }], { cls: 'marker-cluster', pct }).classList;
  assert.ok(edge(90).includes('opens-left') && edge(50).includes('opens-center') && !edge(10).some(c => c.startsWith('opens-')), 'the list opens toward the middle of the track');
});

test('G15 d: no text is set below 12 CSS px, in either density', () => {
  // Each density's real root size: the default from :root's font shorthand, compact from its own rule.
  const comfortable = Number(/:root \{[^}]*font: (\d+(?:\.\d+)?)px/.exec(css)?.[1]), compact = Number(/:root\[data-density="compact"\] \{[^}]*font-size: (\d+(?:\.\d+)?)px/.exec(css)?.[1]);
  assert.ok(comfortable >= 12 && compact >= 12, `roots ${comfortable} and ${compact}`);
  // Every size the sheet sets: font-size, and the size in a font shorthand (font: <size>[/<line-height>] <family>).
  const sizes = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map(m => m[1].trim())
    .concat([...css.matchAll(/(?<![-\w])font:\s*([^;}]+)/g)].map(m => m[1].trim()).filter(value => value !== 'inherit').map(value => (/^(max\([^)]*\)|[\d.]+[a-z%]+)/.exec(value) ?? [value])[0].split('/')[0]));
  const px = (value, root) => { if (/^max\(12px,/.test(value)) return 12; const m = /^(\d*\.?\d+)(rem|em|px)$/.exec(value); if (!m) return null; return m[2] === 'px' ? Number(m[1]) : m[2] === 'rem' ? Number(m[1]) * root : Number(m[1]) < 1 ? 0 : 12; };
  for (const [density, root] of [['comfortable', comfortable], ['compact', compact]]) {
    const small = sizes.filter(value => { const size = px(value, root); return size !== null && size < 12; });
    assert.deepEqual(small, [], `${density} (${root} px root): sizes below 12 px must be written as max(12px, …)`);
  }
  assert.ok(sizes.some(value => /^max\(12px, \.85rem\)$/.test(value)), 'the code shorthand is covered');
  for (const selector of ['.count', '.badge', 'table.data thead th', '.chip', '.card-sub']) assert.match(css, new RegExp(`${selector.replace(/\./g, '\\.')} \\{[^}]*font-size: max\\(12px`), selector);
});

// ---- Cosmetic: per-severity counts with no findings ---------------------------------------------------------
test('the merge card counts review findings by severity, zero included', () => {
  const p = project({}, { repository: { slug: 'fictional/demo', hostname: 'forge.invalid' } }), head = 'c'.repeat(40);
  const item = { id: 'q', status: 'open', mergeContext: { candidate: head, base: 'b'.repeat(40), pullRequest: { number: 7, url: null, adopted: false }, review: { route: 'pass', verdict: 'pass', findings: 0, bySeverity: {}, phase: 'full', current: true }, gate: null, fastChecks: null, adoptedFrom: null } };
  assert.match(text(mergeCandidateView(p, item)), /pass 0 findings \(0 critical, 0 high, 0 medium, 0 low\) · full review/);
});

// ---- G25: an adopted PR that changes managed files ------------------------------------------------------------
async function ghFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'd83-gh-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'); await mkdir(bin);
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),dir=path.dirname(process.argv[1]),args=process.argv.slice(2);
if(args[0]==='auth'){console.log('fictional-token');process.exit(0);}
const method=args[args.indexOf('--method')+1],endpoint=args.find(a=>a.startsWith('repos/'));
const input=args.includes('--input')?fs.readFileSync(0,'utf8'):'';
fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({method,endpoint,input})+'\\n');
const values=JSON.parse(fs.readFileSync(path.join(dir,'responses.json'),'utf8')),value=values[method+' '+endpoint]??values[endpoint];
if(value===undefined){process.stderr.write('gh: Not Found (HTTP 404)');process.exit(1);}
console.log(JSON.stringify(value));
`); await chmod(gh, 0o700);
  await writeFile(join(bin, 'responses.json'), JSON.stringify({ 'repos/fictional/demo/issues/1/comments?per_page=100&page=1': [], 'POST repos/fictional/demo/issues/1/comments': { id: 10 } }));
  const calls = async () => existsSync(join(bin, 'calls.jsonl')) ? (await readFile(join(bin, 'calls.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { directory, gh, calls };
}
async function adoptedManagedFiles(t, repositoryExtra = {}, { extraManaged = [] } = {}) {
  const f = await ghFixture(t), root = join(f.directory, 'root'), remote = join(f.directory, 'remote.git'); mkdirSync(root);
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fictional Developer']); await git(root, ['config', 'user.email', 'developer@example.invalid']); await git(root, ['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'factory')); mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'factory', 'AGENTS.md'), 'Managed instructions\n'); writeFileSync(join(root, 'docs', 'FAQ.md'), 'Questions\n');
  await git(root, ['add', '.']); await git(root, ['commit', '-m', 'initial']);
  await git(root, ['init', '--bare', remote]); await git(root, ['remote', 'add', 'origin', remote]); await git(root, ['push', '-u', 'origin', 'main']);
  // The outside pull request: a docs change plus one sentence of the factory's own instructions.
  const base = repositoryIdentity(root).head;
  await git(root, ['checkout', '-b', 'outside']);
  writeFileSync(join(root, 'docs', 'FAQ.md'), 'Questions and answers\n'); writeFileSync(join(root, 'factory', 'AGENTS.md'), 'Managed instructions, edited from outside\n');
  for (const name of extraManaged) writeFileSync(join(root, 'factory', name), 'Added from outside\n');
  if (extraManaged.length) await git(root, ['add', '.']);
  await git(root, ['commit', '-am', 'Expand the FAQ']); const head = repositoryIdentity(root).head; await git(root, ['checkout', 'main']);
  const workspace = await prepare({ root, stateDir: join(f.directory, 'state'), projectId: 'project-1', flowId: 'flow-1', baseRef: head });
  const config = { repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin', ghPath: f.gh, ...repositoryExtra }, checks: [], context: { files: [] } };
  const intent = { attemptId: uid(), cwd: workspace.path, projectRoot: root, timeoutMs: 60000, action: { operation: 'workspace.integrate', config, workspace, candidate: { number: 1, head, base }, stateDir: join(f.directory, 'state'), projectId: 'project-1', flowId: 'flow-1', task: { id: 'task-1', title: 'Fictional adoption', acceptance: ['Docs'], revision: 'r1' }, context: { files: [], digest: 'context' }, artifactDir: join(f.directory, 'artifacts'), results: {}, sessions: {} } };
  return { f, intent };
}

test('G25: an adopted PR changing managed files is refused with a notice naming the files and the rule, and its author is told once', async t => {
  const { f, intent } = await adoptedManagedFiles(t);
  const error = await runAction(intent).then(() => null, e => e);
  assert.ok(error, 'integration is still refused');
  assert.match(error.notice, /^Adopted pull request #1 changes files the factory manages, so it was refused\. Rule: the factory's upgrade-owned files \(factory\/\) change only through a Factotum release/);
  assert.match(error.notice, /Files: factory\/AGENTS\.md\.$/, 'the files come last');
  assert.doesNotMatch(error.notice, /docs\/FAQ\.md/, 'only managed files are named');
  assert.match(error.notice, /Ask the author to drop those changes and push, then adopt the pull request again/);
  assert.match(error.notice, /The pull request author was told in a comment on the pull request\./);
  assert.match(error.message, /Refusal: factory changes need explicit installation policy/, 'the original refusal is kept');
  const posted = (await f.calls()).filter(call => call.method === 'POST' && call.endpoint === 'repos/fictional/demo/issues/1/comments');
  assert.equal(posted.length, 1);
  const body = JSON.parse(posted[0].input).body;
  assert.match(body, /^This pull request changes files that this project's software factory manages itself/);
  assert.match(body, /- factory\/AGENTS\.md/); assert.match(body, /Please drop the changes to them/);
  assert.doesNotMatch(body, /@|\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#/i, 'no mentions or closing keywords');
  assert.match(body, /<!-- factotum:[a-f\d]{64} -->/, 'marked, so a retry does not post twice');
});

test('G25: with repository.adoptionNotice false nothing is posted, and the notice says to tell the author', async t => {
  const { f, intent } = await adoptedManagedFiles(t, { adoptionNotice: false });
  const error = await runAction(intent).then(() => null, e => e);
  assert.match(error.notice, /No comment was published on the pull request \(repository\.adoptionNotice is false\); tell the author directly\./);
  assert.equal((await f.calls()).some(call => call.endpoint === 'repos/fictional/demo/issues/1/comments'), false);
});

test('G25: a failed change flow\'s notice carries the failing action\'s own notice', t => {
  const f = sandbox(t);
  f.store.tx(() => {
    f.store.put('flow', { id: 'flow-x', taskId: 'task-1', kind: 'change', state: 'running', step: 'integrate' });
    f.store.put('attempt', { id: 'attempt-x', flowId: 'flow-x', step: 'integrate', status: 'failed', receipt: { actionResult: { route: 'error', error: 'long', notice: 'Adopted pull request #1 changes files the factory manages: factory/AGENTS.md.' } } });
  });
  assert.equal(engineModule.failedChangeReason?.(f.store, 'flow-x'), 'Change workflow failed at integrate: Adopted pull request #1 changes files the factory manages: factory/AGENTS.md.');
  f.store.tx(() => f.store.put('attempt', { id: 'attempt-y', flowId: 'flow-x', step: 'build', status: 'failed', receipt: { actionResult: { route: 'error', error: 'other' } } }));
  assert.equal(engineModule.failedChangeReason(f.store, 'flow-x'), 'Change workflow failed; inspect retained attempt evidence', 'without a notice the text is as before');
});

test('G25: a long list of managed files never pushes the rule, the remedy or the comment outcome out of the notice or the comment', async t => {
  // The reviewer's repro: twenty valid paths of about 190 characters each.
  const extraManaged = Array.from({ length: 20 }, (_, i) => `${i}-${'x'.repeat(180)}.md`);
  const { f, intent } = await adoptedManagedFiles(t, {}, { extraManaged });
  const error = await runAction(intent).then(() => null, e => e);
  const notice = error.notice;
  assert.ok(notice.length <= 2000, `the notice fits what the worker keeps (${notice.length} characters)`);
  assert.match(notice, /Rule: /); assert.match(notice, /Ask the author to drop those changes/); assert.match(notice, /The pull request author was told in a comment/);
  assert.ok(notice.indexOf('Rule: ') < notice.indexOf('Files: ') && notice.indexOf('was told') < notice.indexOf('Files: '), 'guidance comes before the list');
  const more = /… and (\d+) more\.$/.exec(notice);
  assert.ok(more, 'the list ends with a count of the files not named');
  const named = (notice.slice(notice.indexOf('Files: ')).match(/factory\//g) ?? []).length;
  assert.equal(named + Number(more[1]), 21, 'every changed managed file is named or counted');
  const body = JSON.parse((await f.calls()).find(call => call.method === 'POST' && call.endpoint === 'repos/fictional/demo/issues/1/comments').input).body;
  assert.ok(body.indexOf('Please drop the changes') < body.indexOf('The files:'), 'the comment leads with what to do');
  assert.match(body, /\n- … and \d+ more\n/, 'the comment list ends with a count');
  assert.doesNotMatch(body, /@|\b(?:close[sd]?|fix(?:es|ed)?|resolve[sd]?)\s+#/i);
});

test('G25: a refused adoption retires an original-pr to-do that an earlier release created, and creates none itself', async t => {
  const f = sandbox(t);
  f.store.tx(() => {
    f.store.put('flow', { id: 'flow-r', taskId: 'task-1', kind: 'change', state: 'running', step: 'integrate', candidate: { number: 1, head: 'a'.repeat(40), base: 'b'.repeat(40) }, results: {} });
    f.store.put('obligation', { id: 'flow-r:original-pr', flowId: 'flow-r', title: 'Review and close the superseded original PR after replacement delivery.', status: 'pending', owner: 'operator' });
  });
  f.store.tx(() => engineModule.retireUnpublishedAdoption?.(f.store, f.store.need('flow', 'flow-r')));
  const retired = f.store.need('obligation', 'flow-r:original-pr');
  assert.equal(retired.status, 'passed'); assert.match(retired.resolution, /^Retired: the adoption was refused before a replacement pull request was published/); assert.match(retired.resolution, /stays open/);
  // Once a replacement is published, the to-do stands.
  f.store.tx(() => {
    f.store.put('flow', { id: 'flow-p', taskId: 'task-1', kind: 'change', state: 'running', step: 'review', candidate: { number: 2, head: 'c'.repeat(40), base: 'b'.repeat(40) }, results: { publish: { route: 'published', number: 7 } } });
    f.store.put('obligation', { id: 'flow-p:original-pr', flowId: 'flow-p', title: 'Review and close', status: 'pending', owner: 'operator' });
  });
  f.store.tx(() => engineModule.retireUnpublishedAdoption(f.store, f.store.need('flow', 'flow-p')));
  assert.equal(f.store.need('obligation', 'flow-p:original-pr').status, 'pending');
});

test('the failed-flow notice uses any action\'s notice, not only an adoption refusal', t => {
  const f = sandbox(t);
  f.store.tx(() => {
    f.store.put('flow', { id: 'flow-n', taskId: 'task-1', kind: 'change', state: 'running', step: 'candidate' });
    f.store.put('attempt', { id: 'attempt-n', flowId: 'flow-n', step: 'candidate', status: 'failed', receipt: { actionResult: { route: 'error', error: 'x', notice: 'The candidate head does not match the pull request; adopt it again with its current head.' } } });
  });
  assert.equal(engineModule.failedChangeReason(f.store, 'flow-n'), 'Change workflow failed at candidate: The candidate head does not match the pull request; adopt it again with its current head.');
});
