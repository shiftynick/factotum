// dev.83: an adopted pull request whose candidate does not match is held with a notice naming each
// mismatch (G6), the approved base is checked against the target's history rather than GitHub's
// cached base (G8), and the closing-keyword notice names the keyword actually found (G7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandbox } from './helpers.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { git, adoptCandidate, adoptionRefNames } from '../starter/factory/adapters/workspace/index.mjs';
import { recordAdoptionRefs, releaseAdoptionRefs, sweepAdoptionRefs, runningSweep, BATCH, GIT_TIMEOUT_MS } from '../starter/factory/operations/adoption-refs.mjs';
import { VerifiedObjects } from '../starter/factory/core/verified-git.mjs';
import * as adoption from '../starter/factory/workflows/adoption.mjs';
import { changeWorkflow } from '../starter/factory/core/configuration.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';

const rev = async (cwd, ref = 'HEAD') => (await git(cwd, ['rev-parse', ref])).stdout;
const commitFile = async (cwd, name, text, message) => { await writeFile(join(cwd, name), text); await git(cwd, ['add', '.']); await git(cwd, ['commit', '-m', message]); return rev(cwd); };

// A repository with a remote, a target `main` and an outside pull request #1 at refs/pull/1/head.
async function scenario(t) {
  const directory = await mkdtemp(join(tmpdir(), 'adopt-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'root'), remote = join(directory, 'remote.git'); await mkdir(root);
  await git(root, ['init', '-b', 'main']); await git(root, ['config', 'user.name', 'Fictional Developer']); await git(root, ['config', 'user.email', 'developer@example.invalid']);
  const first = await commitFile(root, 'app.txt', 'initial\n', 'initial');
  await git(root, ['init', '--bare', remote]); await git(root, ['remote', 'add', 'origin', remote]); await git(root, ['push', '-u', 'origin', 'main']);
  await git(root, ['checkout', '-b', 'outside']);
  const head = await commitFile(root, 'outside.txt', 'outside\n', 'Outside change');
  await git(root, ['push', 'origin', 'HEAD:refs/pull/1/head']); await git(root, ['checkout', 'main']);
  return { directory, root, first, head };
}
const pr = (extra = {}) => ({ number: 1, state: 'open', draft: false, merged: false, baseRef: 'main', url: 'https://example.invalid/pull/1', ...extra });
const options = (s, extra) => ({ root: s.root, stateDir: join(s.directory, 'state'), projectId: 'fictional', flowId: `adopt-${uid().slice(0, 8)}`, number: 1, target: 'main', ...extra });

test('G8: an approved base older than GitHub\'s current base is accepted when it is on the target', async t => {
  const s = await scenario(t);
  // The target moves after the operator read the pull request; GitHub now reports the new tip.
  const moved = await commitFile(s.root, 'app.txt', 'moved\n', 'Target moves'); await git(s.root, ['push', 'origin', 'main']);
  const adopted = await adoptCandidate(options(s, { expectedHead: s.head, expectedBase: s.first, forge: { readPR: async () => pr({ head: s.head, base: moved }) } }));
  assert.equal(adopted.workspace.base, s.head);
  assert.equal(adopted.originalPR.approvedBase, s.first); assert.equal(adopted.originalPR.base, moved); assert.equal(adopted.originalPR.targetHead, moved);
});

test('G8: after a force-push GitHub\'s lagging base does not refuse the current target head', async t => {
  const s = await scenario(t);
  const moved = await commitFile(s.root, 'app.txt', 'moved\n', 'Target moves'); await git(s.root, ['push', 'origin', 'main']);
  // The author rewords and force-pushes; for a few seconds GitHub still reports the old base.
  await git(s.root, ['checkout', 'outside']); await git(s.root, ['commit', '--amend', '-m', 'Outside change, reworded']);
  const reworded = await rev(s.root); await git(s.root, ['push', '--force', 'origin', 'HEAD:refs/pull/1/head']); await git(s.root, ['checkout', 'main']);
  const adopted = await adoptCandidate(options(s, { expectedHead: reworded, expectedBase: moved, forge: { readPR: async () => pr({ head: reworded, base: s.first }) } }));
  assert.equal(adopted.workspace.base, reworded);
  assert.equal(adopted.originalPR.base, s.first, 'GitHub\'s reported base is recorded, not required');
});

test('G8: a base that is not in the target\'s history is refused, naming the target head', async t => {
  const s = await scenario(t);
  await assert.rejects(adoptCandidate(options(s, { expectedHead: s.head, expectedBase: s.head, forge: { readPR: async () => pr({ head: s.head, base: s.first }) } })), error => {
    assert.match(error.message, /approved PR candidate or target changed/);
    const [row] = error.adoptionMismatch.mismatches;
    assert.equal(row.field, 'base'); assert.match(row.found, new RegExp(`main is at ${s.first} and ${s.head.slice(0, 12)} is not in its history \\(through verified parents\\); GitHub reports base ${s.first}`));
    assert.match(row.fix, new RegExp(`current head ${s.first}`)); assert.match(row.fix, /git ls-remote origin refs\/heads\/main/);
    return true;
  });
  assert.equal(existsSync(join(s.directory, 'state', 'worktrees')), false, 'no owned worktree was created');
});

test('G6: each mismatching field is named with what was approved and what was found', async t => {
  const s = await scenario(t);
  const other = 'f'.repeat(40);
  await assert.rejects(adoptCandidate(options(s, { expectedHead: other, expectedBase: s.first, forge: { readPR: async () => pr({ head: s.head, base: s.first, draft: true, baseRef: 'release' }) } })), error => {
    const rows = Object.fromEntries(error.adoptionMismatch.mismatches.map(row => [row.field, row]));
    assert.deepEqual(Object.keys(rows).sort(), ['head', 'state', 'target']);
    assert.equal(rows.head.expected, other); assert.equal(rows.head.found, s.head); assert.match(rows.head.fix, new RegExp(`candidate.head ${s.head}`));
    assert.equal(rows.state.found, 'draft'); assert.match(rows.state.fix, /ready for review/);
    assert.equal(rows.target.expected, 'main'); assert.equal(rows.target.found, 'release');
    return true;
  });
});

// The dispatch path, through a fake gh executable (nothing reaches GitHub).
async function ghBinary(directory, responses) {
  const bin = join(directory, 'bin'); await mkdir(bin, { recursive: true });
  const gh = join(bin, 'gh');
  await writeFile(gh, `#!${process.execPath}
const args=process.argv.slice(2);
if(args[0]==='auth'){console.log('fictional-token');process.exit(0);}
const method=args[args.indexOf('--method')+1],endpoint=args.find(a=>a.startsWith('repos/'));
const values=${JSON.stringify(responses)},value=values[method+' '+endpoint]??values[endpoint];
if(value===undefined){process.stderr.write('gh: Not Found (HTTP 404)');process.exit(1);}
console.log(JSON.stringify(value));
`); await chmod(gh, 0o700);
  return gh;
}
const rawPR = (head, base, extra = {}) => ({ number: 1, state: 'open', draft: false, merged: false, commits: 1, head: { sha: head, ref: 'outside' }, base: { sha: base, ref: 'main' }, html_url: 'https://example.invalid/pull/1', user: { login: 'outside-dev' }, title: 'Outside', body: '', ...extra });
const adoptIntent = (s, gh, candidate) => ({ attemptId: uid(), cwd: s.root, projectRoot: s.root, timeoutMs: 60000, action: { operation: 'workspace.adopt', stateDir: join(s.directory, 'state'), projectId: 'project-1', flowId: 'flow-1', candidate, config: { repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin', ghPath: gh }, checks: [], context: { files: [], maxChars: 24000 } }, task: { id: 'task-1', title: 'Fictional adoption', acceptance: ['Works'], revision: 'r1' }, context: { files: [], digest: 'context' }, artifactDir: join(s.directory, 'artifacts'), results: {}, sessions: {} } });

test('G6: the candidate step holds a mismatching candidate with a specific reason instead of failing', async t => {
  const s = await scenario(t);
  const stale = 'e'.repeat(40);
  const gh = await ghBinary(s.directory, { 'repos/fictional/demo/pulls/1': rawPR(s.head, s.first), 'repos/fictional/demo/pulls/1/commits?per_page=100&page=1': [{ sha: s.head, commit: { message: 'Outside change' } }] });
  const result = await runAction(adoptIntent(s, gh, { number: 1, head: stale, base: s.first }));
  assert.equal(result.route, 'held'); assert.equal(result.adoptionHold.kind, 'candidate-mismatch'); assert.equal(result.workspace, undefined);
  assert.deepEqual(result.adoptionHold.mismatches, [{ field: 'head', expected: stale, found: s.head }]);
  assert.match(result.reason, /pull request #1 \(https:\/\/example\.invalid\/pull\/1\) does not match the approved candidate/);
  assert.match(result.reason, new RegExp(`head: approved ${stale}, found ${s.head}\\. Fix: .*flow\\.abandon.*candidate\\.head ${s.head}`));
  // The same intent with the right head and an older base on the target is adopted.
  const adopted = await runAction(adoptIntent(s, gh, { number: 1, head: s.head, base: s.first }));
  assert.equal(adopted.route, 'adopted');
});

test('G6: a candidate-mismatch hold stops the flow at candidate and its notice says what to fix', t => {
  const f = sandbox(t);
  const workflow = changeWorkflow({ policy: {} });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.start();
  const candidate = { number: 1, head: 'a'.repeat(40), base: 'b'.repeat(40) };
  const attempt = { id: 'adopt-attempt', flowId: 'flow-1', step: 'candidate', status: 'running', intent: { action: { operation: 'workspace.adopt' }, cwd: f.root, inputIdentity: repositoryIdentity(f.root) }, createdAt: new Date().toISOString() };
  f.store.put('attempt', attempt);
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), step: 'candidate', state: 'running', candidate, attemptId: attempt.id });
  const hold = adoption.candidateMismatchHold(candidate, { number: 1, mismatches: [{ field: 'head', expected: candidate.head, found: 'c'.repeat(40), fix: 'start a new flow with the new head' }] }, 'https://example.invalid/pull/1');
  assert.equal(hold.notice, hold.reason, 'the hold supplies its notice');
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: hold });
  const stopped = f.store.need('flow', 'flow-1');
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.step, 'candidate'); assert.equal(stopped.stopReason, hold.notice);
  const notice = f.store.all('inbox').find(row => row.kind === 'notice' && row.flowId === 'flow-1');
  assert.doesNotMatch(notice.context, /inspect retained attempt evidence/);
  assert.match(notice.context, new RegExp(`head: approved ${candidate.head}, found ${'c'.repeat(40)}\\. Fix: start a new flow`));
  assert.ok(f.store.events(50).some(event => event.type === 'flow.adoption-held'));
});

test('G7: the closing-keyword notice suggests a plain reference to the issue actually found', () => {
  const candidate = { number: 32, head: 'a'.repeat(40) };
  const hold = adoption.closingReferenceHold(candidate, { violations: [
    { sha: 'a'.repeat(40), keyword: 'Fixes #28', title: 'Docs. Fixes #28' },
    { sha: 'b'.repeat(40), keyword: 'closes fictional/demo#7', title: 'More, closes fictional/demo#7' },
  ] });
  assert.doesNotMatch(hold.reason, /#11/);
  assert.match(hold.reason, /\("Refs #28" instead of "Fixes #28", "Refs fictional\/demo#7" instead of "closes fictional\/demo#7"\)/);
});

// ---- Review fixes ----

test('review P2: a replace ref cannot make an unrelated commit pass as target history', async t => {
  const s = await scenario(t);
  // U: a commit unrelated to the target. F: a fabricated commit with the target's tree and U as parent.
  const emptyTree = (await git(s.root, ['mktree'], {})).stdout;
  const unrelated = (await git(s.root, ['commit-tree', emptyTree, '-m', 'Unrelated'])).stdout;
  const fabricated = (await git(s.root, ['commit-tree', `${s.first}^{tree}`, '-p', unrelated, '-m', 'Fabricated'])).stdout;
  await git(s.root, ['replace', s.first, fabricated]);
  // What plain Git now believes, and what verified parents show.
  assert.equal((await git(s.root, ['merge-base', '--is-ancestor', unrelated, s.first], { allowFailure: true })).code, 0, 'the replace ref fools merge-base');
  assert.equal(new VerifiedObjects(s.root).reaches(s.first, unrelated), false);
  const attempt = () => adoptCandidate(options(s, { flowId: 'forged', expectedHead: s.head, expectedBase: unrelated, forge: { readPR: async () => pr({ head: s.head, base: s.first }) } }));
  await assert.rejects(attempt(), error => {
    const rows = Object.fromEntries(error.adoptionMismatch.mismatches.map(row => [row.field, row]));
    assert.deepEqual(Object.keys(rows), ['repository']); assert.match(rows.repository.found, /replacement refs/); assert.match(rows.repository.fix, /remove the replace refs/);
    return true;
  });
  // Without the replace ref the verified walk refuses the unrelated base on its own.
  await git(s.root, ['replace', '-d', s.first]);
  await assert.rejects(attempt(), error => error.adoptionMismatch.mismatches.map(row => row.field).join() === 'base');
  assert.equal(existsSync(join(s.directory, 'state', 'worktrees')), false, 'no owned worktree was created');
});

test('review P2: a grafts file is refused the same way', async t => {
  const s = await scenario(t);
  const common = (await git(s.root, ['rev-parse', '--git-common-dir'])).stdout;
  await writeFile(join(s.root, common, 'info', 'grafts'), `${s.first}\n`);
  await assert.rejects(adoptCandidate(options(s, { expectedHead: s.head, expectedBase: s.first, forge: { readPR: async () => pr({ head: s.head, base: s.first }) } })), error => error.adoptionMismatch.mismatches.some(row => row.field === 'repository' && /grafts file/.test(row.found)));
});

test('review P3: adoption records its private refs, and a mismatch hold carries them', async t => {
  const s = await scenario(t);
  const o = options(s, { attemptId: 'attempt-1', expectedHead: s.head, expectedBase: s.first, forge: { readPR: async () => pr({ head: s.head, base: s.first }) } }), names = adoptionRefNames(o);
  assert.match(names.head, /^refs\/factotum\/adoptions\/[0-9a-f]{32}-[0-9a-f]{16}$/, 'a name of the attempt\'s own');
  const adopted = await adoptCandidate(o);
  assert.deepEqual(adopted.adoptionRefs, [{ ref: names.head, oid: s.head }, { ref: names.target, oid: s.first }]);
  const mismatch = await adoptCandidate({ ...o, flowId: 'other', attemptId: 'attempt-2', expectedHead: 'f'.repeat(40) }).catch(error => error.adoptionMismatch);
  const hold = adoption.candidateMismatchHold({ number: 1, head: 'f'.repeat(40), base: s.first }, mismatch);
  assert.deepEqual(hold.adoptionRefs, [{ ref: adoptionRefNames({ ...o, flowId: 'other', attemptId: 'attempt-2' }).target, oid: s.first }]);
});

test('review P3: an ended adoption\'s refs are deleted only at their recorded OID, after its workspace is released', async t => {
  const f = sandbox(t); f.start();
  const run = (args, opts) => git(f.root, args, opts), head = (await run(['rev-parse', 'HEAD'])).stdout;
  await run(['commit', '--allow-empty', '-qm', 'Moved']); const moved = (await run(['rev-parse', 'HEAD'])).stdout;
  const names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1' }), stale = 'refs/factotum/adoptions/' + '0'.repeat(32);
  await run(['update-ref', names.head, head]); await run(['update-ref', names.target, moved]);
  // The target ref moved after it was recorded; another ref was already gone.
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: head }, { ref: names.target, oid: head }, { ref: stale, oid: head }, { ref: 'refs/heads/main', oid: head }]));
  assert.deepEqual(f.store.get('adoptionRefs', 'flow-1').refs.map(row => row.ref), [names.head, names.target, stale], 'only adoption refs are recorded');
  // Not while the flow runs.
  assert.deepEqual(await releaseAdoptionRefs(f.store, { root: f.root }), []);
  // Not while a failed flow's workspace is unreleased.
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), state: 'failed', workspace: { path: '/fictional', branch: 'factotum/x' } });
  assert.deepEqual(await releaseAdoptionRefs(f.store, { root: f.root }), []);
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), workspaceReleased: { at: new Date().toISOString() } });
  const [result] = await releaseAdoptionRefs(f.store, { root: f.root });
  assert.deepEqual(result.removed.map(row => row.ref), [names.head, stale]);
  assert.deepEqual(result.kept.map(({ ref, oid, found }) => ({ ref, oid, found })), [{ ref: names.target, oid: head, found: moved }]);
  assert.notEqual((await run(['rev-parse', '-q', '--verify', names.head], { allowFailure: true })).code, 0, 'removed');
  assert.equal((await run(['rev-parse', names.target])).stdout, moved, 'a moved ref is kept');
  assert.equal(f.store.get('adoptionRefs', 'flow-1'), undefined, 'the record is gone');
  assert.ok(f.store.need('flow', 'flow-1').adoptionRefsReleased.kept);
});

test('review P3: an abandoned candidate hold that never created a workspace releases its refs', async t => {
  const f = sandbox(t);
  const workflow = changeWorkflow({ policy: {} });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.start();
  const head = (await git(f.root, ['rev-parse', 'HEAD'])).stdout, names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1' });
  await git(f.root, ['update-ref', names.target, head]);
  const candidate = { number: 1, head: 'a'.repeat(40), base: head };
  const attempt = { id: 'adopt-attempt', flowId: 'flow-1', step: 'candidate', status: 'running', intent: { action: { operation: 'workspace.adopt' }, cwd: f.root, inputIdentity: repositoryIdentity(f.root) }, createdAt: new Date().toISOString() };
  f.store.put('attempt', attempt);
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), step: 'candidate', state: 'running', candidate, attemptId: attempt.id });
  const hold = adoption.candidateMismatchHold(candidate, { number: 1, mismatches: [{ field: 'head', expected: candidate.head, found: 'c'.repeat(40), fix: 'start again' }], refs: [{ ref: names.target, oid: head }] });
  f.engine.settle('flow-1', attempt, { exitCode: 0, costMicros: 0, actionResult: hold });
  assert.deepEqual(f.store.get('adoptionRefs', 'flow-1').refs, [{ ref: names.target, oid: head }]);
  assert.deepEqual(await releaseAdoptionRefs(f.store, { root: f.root }), [], 'kept while the flow is only stopped');
  assert.equal(f.command('flow.abandon', { flowId: 'flow-1', note: 'Wrong head; start again' }).status, 'completed');
  const [result] = await releaseAdoptionRefs(f.store, { root: f.root });
  assert.deepEqual(result.removed.map(row => row.ref), [names.target]);
  assert.notEqual((await git(f.root, ['rev-parse', '-q', '--verify', names.target], { allowFailure: true })).code, 0);
});

// ---- Review round 2 ----

const endedFlow = (f, id) => f.store.put('flow', { ...f.store.need('flow', 'flow-1'), id, state: 'failed', attemptId: null });

test('round 2 P2: a FIFO at a recorded ref path is kept for a retry without blocking the sweep (the review repro)', async t => {
  const f = sandbox(t); f.start(); endedFlow(f, 'flow-1');
  const head = (await git(f.root, ['rev-parse', 'HEAD'])).stdout, names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1' });
  const path = join(f.root, '.git', names.head); mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('mkfifo', [path]); // opening it for reading blocks until a writer opens it; none ever does
  t.after(() => rmSync(path, { force: true }));
  await git(f.root, ['update-ref', names.target, head]);
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: head }, { ref: names.target, oid: head }]));
  const started = Date.now();
  const [result] = await releaseAdoptionRefs(f.store, { root: f.root });
  assert.ok(Date.now() - started < GIT_TIMEOUT_MS, `finished in ${Date.now() - started} ms`);
  assert.deepEqual(result.retry.map(row => row.ref), [names.head]); assert.match(result.retry[0].error, /Git does not read .* as a ref, but something is there/);
  assert.deepEqual(result.removed.map(row => row.ref), [names.target]);
  assert.deepEqual(f.store.get('adoptionRefs', 'flow-1').refs, [{ ref: names.head, oid: head }]);
  // The Git runner itself kills a call that blocks on it (update-ref opens the FIFO).
  const blocked = await git(f.root, ['update-ref', '-d', names.head, head], { allowFailure: true, timeoutMs: 300 });
  assert.equal(blocked.timedOut, true); assert.equal(blocked.code, null);
});

test('round 2 P2: a Git read that blocks is killed after its timeout, and the operations tick waits only its budget', async t => {
  const f = sandbox(t); f.start(); endedFlow(f, 'flow-1');
  const head = (await git(f.root, ['rev-parse', 'HEAD'])).stdout, names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1' });
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: head }]));
  // A FIFO as packed-refs: every ref read opens it and blocks.
  const packed = join(f.root, '.git', 'packed-refs'); rmSync(packed, { force: true }); execFileSync('mkfifo', [packed]);
  t.after(() => rmSync(packed, { force: true }));
  const started = Date.now();
  assert.deepEqual(await sweepAdoptionRefs(f.store, { root: f.root, budgetMs: 100 }), { running: true });
  assert.ok(Date.now() - started < 1000, `the tick waited ${Date.now() - started} ms`);
  assert.deepEqual(await sweepAdoptionRefs(f.store, { root: f.root, budgetMs: 100 }), { running: true }, 'no second sweep while one runs');
  const [result] = await runningSweep(f.store);
  assert.ok(Date.now() - started < 2 * GIT_TIMEOUT_MS + 3000, `bounded by the Git timeout (${Date.now() - started} ms)`);
  assert.deepEqual(result.retry.map(row => row.ref), [names.head]); assert.match(result.retry[0].error, /timed out/);
  const kept = f.store.get('adoptionRefs', 'flow-1');
  assert.deepEqual(kept.refs, [{ ref: names.head, oid: head }]); assert.equal(kept.attempts, 1); assert.match(kept.lastError, /timed out/);
  assert.equal(runningSweep(f.store), null);
});

test('round 2 P2: each sweep reads a bounded batch of records and flows and writes once', async t => {
  const f = sandbox(t); f.start();
  const head = (await git(f.root, ['rev-parse', 'HEAD'])).stdout;
  // 2,000 stopped (not ended) adopted flows waiting, none eligible.
  f.store.tx(() => { for (let i = 0; i < 2000; i++) recordAdoptionRefs(f.store, `flow-${String(i).padStart(5, '0')}`, [{ ref: `refs/factotum/adoptions/${String(i).padStart(32, '0')}`, oid: head }]); });
  for (let i = 0; i < 2000; i++) f.store.put('flow', { ...f.store.need('flow', 'flow-1'), id: `flow-${String(i).padStart(5, '0')}`, state: 'stopped' });
  const reads = { flow: 0, other: 0 }, txs = { count: 0 }, get = f.store.get.bind(f.store), tx = f.store.tx.bind(f.store), all = f.store.all.bind(f.store);
  f.store.get = (kind, key) => { reads[kind === 'flow' ? 'flow' : 'other']++; return get(kind, key); };
  f.store.tx = fn => { txs.count++; return tx(fn); };
  f.store.all = kind => { assert.notEqual(kind, 'adoptionRefs', 'never reads every record'); return all(kind); };
  t.after(() => { f.store.get = get; f.store.tx = tx; f.store.all = all; });
  for (let sweep = 1; sweep <= 3; sweep++) {
    reads.flow = 0; txs.count = 0;
    assert.deepEqual(await releaseAdoptionRefs(f.store, { root: f.root }), []);
    assert.ok(reads.flow <= BATCH, `sweep ${sweep} read ${reads.flow} flows`);
    assert.equal(txs.count, 1, 'one transaction per sweep');
  }
  // The cursor moves on: the third sweep starts after the first two batches.
  assert.equal(f.store.meta('adoptionRefsCursor'), `flow-${String(3 * BATCH - 1).padStart(5, '0')}`);
  // An eligible flow deep in the list is reached within the number of batches, not on the first sweep.
  f.store.put('flow', { ...f.store.need('flow', 'flow-01999'), state: 'failed' });
  let reached = null;
  for (let sweep = 0; sweep < Math.ceil(2000 / BATCH) + 1 && !reached; sweep++) reached = (await releaseAdoptionRefs(f.store, { root: f.root })).find(row => row.flowId === 'flow-01999');
  assert.ok(reached, 'reached by the cursor'); assert.equal(f.store.get('adoptionRefs', 'flow-01999'), undefined);
});

test('round 2 P3: a retry keeps refs recorded earlier that it did not set again', async t => {
  const f = sandbox(t); f.start();
  const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1' }), other = 'refs/factotum/adoptions/' + '1'.repeat(32);
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: a }, { ref: names.target, oid: b }]));
  // The retry fetched no head (the PR head changed) but a newer target; then a different head ref.
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.target, oid: c }]));
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: other, oid: a }]));
  assert.deepEqual(f.store.get('adoptionRefs', 'flow-1').refs, [{ ref: names.head, oid: a }, { ref: names.target, oid: c }, { ref: other, oid: a }]);
});

test('round 2 P3: a ref that cannot be read is retried, not taken for absent', async t => {
  const f = sandbox(t); f.start(); endedFlow(f, 'flow-1');
  const head = (await git(f.root, ['rev-parse', 'HEAD'])).stdout, names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1' }), gone = 'refs/factotum/adoptions/' + '2'.repeat(32);
  const path = join(f.root, '.git', names.head); mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, 'not an object id\n'); // a broken loose ref
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: head }, { ref: gone, oid: head }]));
  const [result] = await releaseAdoptionRefs(f.store, { root: f.root });
  assert.deepEqual(result.retry.map(row => row.ref), [names.head]); assert.match(result.retry[0].error, /broken ref/);
  assert.deepEqual(result.removed.map(row => ({ ref: row.ref, absent: row.absent })), [{ ref: gone, absent: true }]);
  assert.deepEqual(f.store.get('adoptionRefs', 'flow-1').refs, [{ ref: names.head, oid: head }]);
  // Repaired, the next sweep deletes it.
  writeFileSync(path, `${head}\n`);
  const [again] = await releaseAdoptionRefs(f.store, { root: f.root });
  assert.deepEqual(again.removed.map(row => row.ref), [names.head]); assert.equal(f.store.get('adoptionRefs', 'flow-1'), undefined);
});


// ---- Review round 4 ----

test('round 4 P2: an old sweep\'s stalled delete, released after a clock jump, a replan and a fresh fetch, cannot touch the fresh adoption', async t => {
  const s = await scenario(t), f = sandbox(t);
  const workflow = changeWorkflow({ policy: {} });
  f.store.setMeta('workflow', workflow); f.store.setMeta('workflowDigest', digest(workflow));
  f.start();
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), mode: 'delivery', kind: 'change', state: 'failed', finishedAt: new Date().toISOString(), candidate: { number: 1, head: s.head, base: s.first }, attemptId: null });
  // Attempt A of this flow fetched its refs and ended; they are recorded as preparation and settlement record them.
  const flowNames = attemptId => adoptionRefNames({ projectId: 'fictional', flowId: 'flow-1', attemptId });
  const a = flowNames('attempt-a'), b = flowNames('attempt-b');
  await git(s.root, ['update-ref', a.head, s.head]); await git(s.root, ['update-ref', a.target, s.first]);
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: a.head, oid: null }, { ref: a.target, oid: null }]));
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: a.head, oid: s.head }, { ref: a.target, oid: s.first }]));
  const gate = () => { let open; const promise = new Promise(resolve => { open = resolve; }); return { promise, open }; };
  // 1. The sweep reads A's head ref and starts deleting it; the delete stalls.
  const oldDelete = gate(), reachedDelete = gate();
  const sweepRun = async (cwd, args, options) => { if (args[0] === 'update-ref') { reachedDelete.open(); await oldDelete.promise; } return git(cwd, args, options); };
  const oldSweep = releaseAdoptionRefs(f.store, { root: s.root, run: sweepRun });
  await reachedDelete.promise;
  // 2. The clock jumps 61 s.
  const realNow = Date.now; Date.now = () => realNow() + 61_000; t.after(() => { Date.now = realNow; });
  // 3. flow.replan succeeds; the flow is ready.
  assert.equal(f.command('flow.replan', { flowId: 'flow-1', note: 'Adopt the fictional pull request again' }).status, 'completed');
  assert.equal(f.store.need('flow', 'flow-1').state, 'ready');
  // 4. Attempt B: preparation records its names; it fetches a fresh head and its first ref read is paused.
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: b.head, oid: null }, { ref: b.target, oid: null }]));
  const freshRead = gate(), reachedRead = gate();
  let fetched = false;
  const adoptRun = async (cwd, args, options) => { if (args[0] === 'fetch') fetched = true; else if (args[0] === 'rev-parse' && fetched) { reachedRead.open(); await freshRead.promise; } return git(cwd, args, options); };
  const fresh = adoptCandidate(options(s, { flowId: 'flow-1', attemptId: 'attempt-b', run: adoptRun, expectedHead: s.head, expectedBase: s.first, forge: { readPR: async () => pr({ head: s.head, base: s.first }) } }));
  await reachedRead.promise;
  // 5. The old delete is released and the sweep finishes; then the fresh read goes on.
  oldDelete.open();
  const [swept] = await oldSweep;
  // A's head ref is deleted; the clock jump put A's target past the sweep's own deadline, so it is kept for a later sweep.
  assert.deepEqual(swept.removed.map(row => row.ref), [a.head]);
  assert.deepEqual(swept.retry.map(row => [row.ref, row.error]), [[a.target, 'sweep deadline reached']]);
  freshRead.open();
  const adopted = await fresh;
  assert.equal(adopted.workspace.base, s.head, 'the fresh adoption is unaffected');
  assert.deepEqual(adopted.adoptionRefs.map(row => row.ref), [b.head, b.target]);
  const exists = async ref => (await git(s.root, ['rev-parse', '-q', '--verify', ref], { allowFailure: true })).code === 0;
  assert.deepEqual([await exists(a.head), await exists(a.target), await exists(b.head), await exists(b.target)], [false, true, true, true]);
  // The old sweep removed only the names it handled; A's retried target and attempt B's names stay recorded.
  assert.deepEqual(f.store.get('adoptionRefs', 'flow-1').refs, [{ ref: a.target, oid: s.first }, { ref: b.head, oid: null }, { ref: b.target, oid: null }]);
  // The reactivated flow is not swept while it is active.
  assert.deepEqual(await releaseAdoptionRefs(f.store, { root: s.root }), []);
  assert.equal(await exists(b.head), true);
});

test('round 4: names recorded without an OID (an attempt that never settled) are cleaned at the OID read; absent ones count as removed', async t => {
  const f = sandbox(t); f.start(); endedFlow(f, 'flow-1');
  const head = (await git(f.root, ['rev-parse', 'HEAD'])).stdout, names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1', attemptId: 'crashed' });
  await git(f.root, ['update-ref', names.head, head]);
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: null }, { ref: names.target, oid: null }]));
  const [result] = await releaseAdoptionRefs(f.store, { root: f.root });
  assert.deepEqual(result.removed.map(row => ({ ref: row.ref, absent: row.absent ?? false })), [{ ref: names.head, absent: false }, { ref: names.target, absent: true }]);
  assert.equal((await git(f.root, ['rev-parse', '-q', '--verify', names.head], { allowFailure: true })).code, 1);
  assert.equal(f.store.get('adoptionRefs', 'flow-1'), undefined);
  // A later settlement never replaces a recorded OID with null.
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-2', [{ ref: names.head, oid: head }]));
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-2', [{ ref: names.head, oid: null }]));
  assert.deepEqual(f.store.get('adoptionRefs', 'flow-2').refs, [{ ref: names.head, oid: head }]);
});

// ---- Merge of the dev.83 console fixes ----

test('merge: refs of an adoption refused at integrate for managed files wait for its workspace, then are cleaned', async t => {
  const f = sandbox(t); f.start();
  const head = (await git(f.root, ['rev-parse', 'HEAD'])).stdout, names = adoptionRefNames({ projectId: 'p', flowId: 'flow-1', attemptId: 'adopt-1' });
  await git(f.root, ['update-ref', names.head, head]); await git(f.root, ['update-ref', names.target, head]);
  // Preparation and settlement of the candidate attempt recorded its names; the flow then failed at integrate.
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: null }, { ref: names.target, oid: null }]));
  f.store.tx(() => recordAdoptionRefs(f.store, 'flow-1', [{ ref: names.head, oid: head }, { ref: names.target, oid: head }]));
  f.store.put('attempt', { id: 'integrate-1', flowId: 'flow-1', step: 'integrate', status: 'failed', receipt: { actionResult: { route: 'error', notice: 'Adopted pull request #1 changes files the factory manages.' } }, createdAt: new Date().toISOString() });
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), kind: 'change', candidate: { number: 1, head, base: head }, state: 'failed', attemptId: null, workspace: { path: '/fictional/worktree', branch: 'factotum/x' } });
  // The workspace is kept for inspection: nothing is deleted yet.
  assert.deepEqual(await releaseAdoptionRefs(f.store, { root: f.root }), []);
  assert.equal((await git(f.root, ['rev-parse', '-q', '--verify', names.head], { allowFailure: true })).code, 0);
  // Released (cleanup apply): the refs go.
  f.store.put('flow', { ...f.store.need('flow', 'flow-1'), workspaceReleased: { at: new Date().toISOString() } });
  const [result] = await releaseAdoptionRefs(f.store, { root: f.root });
  assert.deepEqual(result.removed.map(row => row.ref), [names.head, names.target]); assert.equal(f.store.get('adoptionRefs', 'flow-1'), undefined);
});
