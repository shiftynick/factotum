// Knowledge upkeep, slice 5 part A: the docs kind enforced on the exact candidate in commit,
// integration, publication and merge, and no upkeep flow merged by policy (design 7.4, 7.5, 15).
//
// Nothing in this release creates an upkeep task, so each fixture writes one straight to the store
// or hands it to the operation, as the factory's creation path will in part B. Every project, path
// and forge here is fictional; the forge is a scripted `gh`. No test starts a provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { sandbox, until } from './helpers.mjs';
import { digest, uid } from '../starter/factory/core/contracts.mjs';
import { runAction } from '../starter/factory/workflows/dispatch.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { repositoryIdentity } from '../starter/factory/core/repository.mjs';
import { VerifiedObjects } from '../starter/factory/core/verified-git.mjs';
import { upgradeOwned } from '../starter/factory/core/install-layout.mjs';
import { compileCatalog } from '../starter/factory/core/catalog.mjs';
import { executeCommand } from '../starter/factory/core/project.mjs';
import { setTargetHealth } from '../starter/factory/operations/targets.mjs';
import { stateView } from '../starter/factory/operations/state-view.mjs';
import { assertUpkeepCandidate, docsCandidateViolations, MAX_TEXT_BYTES, UpkeepCandidateRefusal } from '../starter/factory/workflows/upkeep-enforcement.mjs';

const git = (cwd, args, input) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim();
const put = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
const link = (root, path, target) => { mkdirSync(join(root, path, '..'), { recursive: true }); symlinkSync(target, join(root, path)); };
const commitAll = (cwd, message = 'Fictional change') => { git(cwd, ['add', '-A']); git(cwd, ['commit', '-qm', message, '--allow-empty']); return git(cwd, ['rev-parse', 'HEAD']); };
const GUIDE = Array.from({ length: 12 }, (_, at) => `Guide line ${at + 1}.`).join('\n') + '\n';
const docsUpkeep = (extra = {}) => ({ mode: 'off', docs: { include: ['README.md', 'docs/**/*.md', 'private/**/*.md'], exclude: ['docs/changes/**'], ...extra } });
const CONTEXT = { files: [{ id: 'agents', path: 'AGENTS.md' }], maxChars: 24000 };

// A fictional gh: answers what publication and merge ask, records every call, and serves the pull
// request from pr.json, which the test writes once it knows the published head.
function fakeGh(dir) {
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),dir=path.dirname(process.argv[1]),args=process.argv.slice(2);
if(args[0]==='auth'){console.log('fictional-token');process.exit(0);}
const method=args[args.indexOf('--method')+1],endpoint=args.find(a=>a.startsWith('repos/'));
const input=args.includes('--input')?JSON.parse(fs.readFileSync(0,'utf8')||'null'):null;
fs.appendFileSync(path.join(dir,'calls.jsonl'),JSON.stringify({method,endpoint})+'\\n');
const pr=fs.existsSync(path.join(dir,'pr.json'))?JSON.parse(fs.readFileSync(path.join(dir,'pr.json'),'utf8')):null;
let value;
if(method==='POST'&&endpoint==='repos/fictional/demo/pulls')value={number:7,html_url:'https://example.invalid/pull/7',body:input.body};
else if(method==='POST'&&/issues\\/\\d+\\/comments$/.test(endpoint))value={id:Date.now(),body:input.body};
else if(method==='PUT'&&endpoint==='repos/fictional/demo/pulls/7/merge')value={merged:true,sha:'f'.repeat(40)};
else if(method==='GET'&&endpoint==='repos/fictional/demo/pulls/7'&&pr)value={number:7,state:'open',draft:false,merged:false,commits:1,head:{sha:pr.head,ref:pr.branch},base:{sha:pr.base,ref:'main'},html_url:'https://example.invalid/pull/7',title:pr.title,body:''};
else if(method==='GET'&&endpoint.startsWith('repos/fictional/demo/pulls/7/commits')&&pr)value=[{sha:pr.head,commit:{message:'Fictional docs correction'}}];
else if(method==='GET'&&endpoint.includes('per_page='))value=[];
if(value===undefined){process.stderr.write('gh: Not Found (HTTP 404)');process.exit(1);}
console.log(JSON.stringify(value));
`); chmodSync(gh, 0o700);
  return gh;
}

// A project with docs, a governing file, a remote and a scripted forge. `layout(root)` adds to the
// first commit; the target branch is main.
function project(t, { layout = () => {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'upk5a-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), remote = join(dir, 'remote.git'), bin = join(dir, 'bin'), stateDir = join(dir, 'state');
  mkdirSync(root); mkdirSync(bin);
  git(root, ['init', '-qb', 'main']); git(root, ['config', 'user.email', 'fixture@example.invalid']); git(root, ['config', 'user.name', 'Fictional Maintainer']);
  put(root, 'README.md', 'Fictional readme.\n'); put(root, 'AGENTS.md', 'Fictional governing rules.\n');
  put(root, 'docs/guide.md', GUIDE); put(root, 'docs/other.md', 'Other doc.\n'); put(root, 'docs/changes/2026.md', 'A dated record.\n'); put(root, 'src/app.txt', 'Application.\n');
  layout(root);
  const base = commitAll(root, 'Fictional baseline');
  execFileSync('git', ['init', '--bare', '-q', remote]); git(root, ['remote', 'add', 'origin', remote]); git(root, ['push', '-q', 'origin', 'main']);
  const gh = fakeGh(bin);
  const blob = (path, at = 'HEAD') => git(root, ['rev-parse', `${at}:${path}`]);
  const calls = () => existsSync(join(bin, 'calls.jsonl')) ? readFileSync(join(bin, 'calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const pushed = branch => { try { git(root, ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${branch}`]); return true; } catch { return false; } };
  const marker = (files = ['docs/guide.md'], extra = {}) => ({ kind: 'docs', sourceFlow: 'flow-source', mergeCommit: base, candidates: [{ id: 'candidate-1', version: 1 }], evidence: [], files: files.map(path => ({ path, blob: blob(path) })), limits: { maxFiles: 3, maxChangedLines: 40 }, ...extra });
  const task = (files = ['docs/guide.md'], extra = {}) => ({ id: 'upkeep:docs-1', title: 'Correct the fictional guide', acceptance: ['The statement on line 3 matches the merged change'], revision: 'r1', risk: 'ordinary', paths: [...files], upkeep: marker(files, extra) });
  let flows = 0;
  const workspace = async () => prepare({ root, stateDir, projectId: 'fictional', flowId: `flow-${++flows}`, baseRef: git(root, ['rev-parse', 'HEAD']) });
  const config = (extra = {}) => ({ mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin', ghPath: gh }, context: CONTEXT, upkeep: docsUpkeep(), policy: {}, ...extra });
  const action = (w, operation, { results = {}, taskValue = task(), configValue = config(), extra = {} } = {}) => ({ version: 1, attemptId: uid(), projectRoot: root, cwd: w.path, timeoutMs: 60000, synthetic: true, maxCostMicros: 0, action: { operation, workspace: w, projectId: 'fictional', flowId: w.flowId ?? 'flow-x', stateDir, artifactDir: join(dir, `artifacts-${uid()}`), target: 'main', sessions: {}, config: configValue, task: taskValue, risk: { level: 'ordinary' }, context: { files: [] }, results, ...extra } });
  return { dir, root, remote, bin, base, blob, calls, pushed, marker, task, workspace, config, action };
}

// Publication with a recorded, non-conflicting integration of the candidate the builder left: the
// decisive check, reached here with no commit step and no integration step having run.
async function publishOutcome(p, w, options = {}) {
  const head = git(w.path, ['rev-parse', 'HEAD']), comparison = options.comparison ?? p.base;
  const intent = p.action(w, 'forge.publish', { ...options, results: { integrate: { base: comparison, head, conflicts: false, route: 'integrated' } } });
  try { return { value: await runAction(intent), head }; } catch (error) { return { error, head }; }
}
const codes = error => (error?.upkeepViolations ?? []).map(row => row.code);
async function refusedAtPublication(p, w, expected, options = {}) {
  const callsBefore = p.calls().length, { error, value, head } = await publishOutcome(p, w, options);
  assert.ok(error, `publication was not refused: ${JSON.stringify(value)}`);
  assert.ok(error instanceof UpkeepCandidateRefusal, error.stack);
  assert.match(error.message, /^forge\.publish: the candidate of upkeep task upkeep:docs-1 \(kind docs\) is outside what its kind permits: /);
  for (const code of [expected].flat()) assert.ok(codes(error).includes(code), `expected ${code} in ${JSON.stringify(error.upkeepViolations)}`);
  // Nothing left the workspace: no branch on the remote, no call to the forge.
  assert.equal(p.pushed(w.branch), false); assert.equal(p.calls().length, callsBefore);
  return { error, head };
}

// ---- Acceptance 1: a docs correction is delivered through all four operations ----
test('a docs correction is committed, integrated, published and merged; the merge is manual even with automatic merge on', async t => {
  const p = project(t), w = await p.workspace();
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, corrected.'));
  const committed = await runAction(p.action(w, 'workspace.commit'));
  assert.equal(committed.route, 'committed');
  const integrated = await runAction(p.action(w, 'workspace.integrate', { results: { } }));
  assert.equal(integrated.route, 'integrated'); assert.equal(integrated.base, p.base);
  const published = await runAction(p.action(w, 'forge.publish', { results: { integrate: integrated } }));
  assert.equal(published.route, 'published'); assert.equal(p.pushed(w.branch), true);
  writeFileSync(join(p.bin, 'pr.json'), JSON.stringify({ head: published.head, base: p.base, branch: w.branch, title: 'Correct the fictional guide' }));
  // Automatic merge is on and the risk ordinary: an ordinary task would be merged in `auto` mode,
  // which this forge refuses (no protection); the upkeep task is merged in `manual` mode.
  const merge = taskValue => p.action(w, 'forge.merge', { taskValue, configValue: p.config({ policy: { autoMerge: true } }), results: { publish: { number: 7 }, integrate: integrated }, extra: { mergeAuthorization: { identity: repositoryIdentity(w.path), actor: 'operator', authority: 'operator' } } });
  const { upkeep, ...ordinary } = p.task(); ordinary.id = 'ordinary-1';
  await assert.rejects(runAction(merge(ordinary)), /automatic merge lacks qualified remote target enforcement/);
  const merged = await runAction(merge(p.task()));
  assert.equal(merged.route, 'merged', JSON.stringify(merged)); assert.equal(merged.merged, true);
  assert.equal(p.calls().filter(call => call.method === 'PUT').length, 1, 'the forge was asked to merge once');
  // The check after integration compares with the integrated target; a correction a review sent back
  // and the builder changed again is committed against it, and published again.
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, corrected again.'));
  assert.equal((await runAction(p.action(w, 'workspace.commit', { results: { integrate: integrated } }))).route, 'committed');
});

test('a docs correction against a target that moved elsewhere is integrated and published; the comparison is the integrated target', async t => {
  const p = project(t), w = await p.workspace();
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 9.', 'Guide line 9, corrected.'));
  assert.equal((await runAction(p.action(w, 'workspace.commit'))).route, 'committed');
  // The target moves: another file changes. The factory's merge of it is not the candidate's own change.
  put(p.root, 'src/app.txt', 'Application, moved on.\n'); const moved = commitAll(p.root, 'Target moves'); git(p.root, ['push', '-q', 'origin', 'main']);
  const integrated = await runAction(p.action(w, 'workspace.integrate'));
  assert.equal(integrated.route, 'integrated'); assert.equal(integrated.base, moved); assert.notEqual(integrated.head, moved);
  const published = await runAction(p.action(w, 'forge.publish', { results: { integrate: integrated } }));
  assert.equal(published.route, 'published');
});

// ---- Acceptance 2: every "never", "none" and "unchanged" cell of the docs column ----
test('paths that may change: only the declared files, each in the docs set', async t => {
  const p = project(t, { layout: root => { put(root, 'src/notes.md', 'Source notes.\n'); } });
  // An undeclared doc beside the declared one.
  let w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); put(w.path, 'docs/other.md', 'Other doc, tidied.\n'); commitAll(w.path);
  await refusedAtPublication(p, w, 'undeclared');
  // A declared file outside upkeep.docs.include, and one the project excludes (a dated record).
  for (const path of ['src/notes.md', 'docs/changes/2026.md']) {
    w = await p.workspace(); put(w.path, path, 'Changed.\n'); commitAll(w.path);
    await refusedAtPublication(p, w, 'not-docs', { taskValue: p.task([path]) });
  }
  // With no docs declared at all, nothing is in the docs set.
  w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); commitAll(w.path);
  await refusedAtPublication(p, w, 'not-docs', { configValue: p.config({ upkeep: { mode: 'off' } }) });
});

test('governing paths: never, whatever include says', async t => {
  // A file listed both as a doc and as governing context.
  const p = project(t), w = await p.workspace();
  put(w.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); commitAll(w.path);
  const { error } = await refusedAtPublication(p, w, 'governing', { configValue: p.config({ context: { files: [{ id: 'guide', path: 'docs/guide.md' }], maxChars: 24000 } }) });
  assert.match(error.message, /docs\/guide\.md is governing context in the comparison and candidate tree \(protected\); a docs task never changes a governing file/);
});

test('the learnings directory and upgrade-owned paths: never', async t => {
  const p = project(t, { layout: root => { put(root, 'docs/learnings/one.md', 'A fictional learning.\n'); put(root, 'factory/notes.md', 'Core notes.\n'); } });
  let w = await p.workspace(); put(w.path, 'docs/learnings/one.md', 'A changed learning.\n'); commitAll(w.path);
  await refusedAtPublication(p, w, 'learnings', { taskValue: p.task(['docs/learnings/one.md']), configValue: p.config({ learnings: { dir: 'docs/learnings' } }) });
  // Upgrade-owned: publication refuses it already (the existing protection, which runs first); the
  // docs check refuses it too, so it does not rest on the other check alone.
  w = await p.workspace(); put(w.path, 'factory/notes.md', 'Changed core notes.\n'); const head = commitAll(w.path);
  const configValue = p.config({ upkeep: docsUpkeep({ include: ['factory/*.md'] }) });
  await assert.rejects(runAction(p.action(w, 'forge.publish', { taskValue: p.task(['factory/notes.md']), configValue, results: { integrate: { base: p.base, head, conflicts: false } } })), /factory changes need explicit installation policy \(factory\/ are upgrade-owned/);
  const found = docsCandidateViolations({ objects: new VerifiedObjects(p.root), task: p.task(['factory/notes.md']), config: configValue, owned: upgradeOwned(p.root), head, comparison: p.base });
  assert.ok(found.violations.some(row => row.code === 'upgrade-owned'), JSON.stringify(found.violations));
});

test('additions and deletions: none, including a rename and a new path that differs only by case', async t => {
  const p = project(t);
  let w = await p.workspace(); put(w.path, 'docs/new.md', 'A new doc.\n'); commitAll(w.path);
  await refusedAtPublication(p, w, ['addition', 'undeclared']);
  w = await p.workspace(); unlinkSync(join(w.path, 'docs/guide.md')); commitAll(w.path);
  await refusedAtPublication(p, w, 'deletion');
  // A rename is a deletion and an addition, each judged as that.
  w = await p.workspace(); git(w.path, ['mv', 'docs/guide.md', 'docs/handbook.md']); commitAll(w.path);
  await refusedAtPublication(p, w, ['deletion', 'addition']);
  w = await p.workspace(); git(w.path, ['mv', 'docs/guide.md', 'docs/Guide.md']); commitAll(w.path);
  const { error } = await refusedAtPublication(p, w, ['deletion', 'addition']);
  assert.ok(error.upkeepViolations.some(row => row.code === 'addition' && row.path === 'docs/Guide.md'));
});

test('file mode: ordinary, not executable, unchanged', async t => {
  const p = project(t, { layout: root => { put(root, 'docs/run.md', 'An executable doc.\n'); chmodSync(join(root, 'docs/run.md'), 0o755); } });
  let w = await p.workspace(); chmodSync(join(w.path, 'docs/guide.md'), 0o755); commitAll(w.path);
  await refusedAtPublication(p, w, 'mode');
  // A declared file that is executable already: its content may not change either, and its mode is kept.
  w = await p.workspace(); put(w.path, 'docs/run.md', 'An executable doc, corrected.\n'); commitAll(w.path);
  await refusedAtPublication(p, w, 'mode', { taskValue: p.task(['docs/run.md']) });
  w = await p.workspace(); chmodSync(join(w.path, 'docs/run.md'), 0o644); commitAll(w.path);
  await refusedAtPublication(p, w, 'mode', { taskValue: p.task(['docs/run.md']) });
});

test('budget: 3 files and 40 changed lines, or the configuration if it is tighter', async t => {
  const p = project(t, { layout: root => { for (const name of ['a', 'b', 'c', 'd']) put(root, `docs/${name}.md`, `Doc ${name}.\n`); } });
  const four = ['docs/a.md', 'docs/b.md', 'docs/c.md', 'docs/d.md'];
  // Four declared files cannot be marked (at most three); four changed files with three declared are refused.
  let w = await p.workspace(); for (const path of four) put(w.path, path, 'Corrected.\n'); commitAll(w.path);
  await refusedAtPublication(p, w, ['budget-files', 'undeclared'], { taskValue: p.task(four.slice(0, 3)) });
  // The task's own limit, lower than the configuration's.
  w = await p.workspace(); for (const path of four.slice(0, 2)) put(w.path, path, 'Corrected.\n'); commitAll(w.path);
  await refusedAtPublication(p, w, 'budget-files', { taskValue: p.task(four.slice(0, 2), { limits: { maxFiles: 1, maxChangedLines: 40 } }) });
  // 41 changed lines: every line's ending changed (12 removed, 12 added) and 17 lines added.
  w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace(/\n/g, '\r\n') + 'x\n'.repeat(17)); commitAll(w.path);
  const { error } = await refusedAtPublication(p, w, 'budget-lines');
  assert.match(error.message, /changes \d+ lines; at most 40 are allowed/);
  // The configuration's limit, lower than the task's: three changed lines against a limit of two.
  w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 1.', 'Corrected.').replace('Guide line 12.', 'Corrected too.')); commitAll(w.path);
  await refusedAtPublication(p, w, 'budget-lines', { configValue: p.config({ upkeep: docsUpkeep({ maxChangedLines: 3 }) }) });
  // Exactly at the limits it is published.
  w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 1.', 'Corrected.')); commitAll(w.path);
  assert.equal((await publishOutcome(p, w, { configValue: p.config({ upkeep: docsUpkeep({ maxChangedLines: 2 }) }) })).value?.route, 'published');
});

test('pinned blobs: each declared file must be the file the task was validated against', async t => {
  const p = project(t), task = p.task();
  // The target changes the declared file after the task was made; the workspace is prepared from it.
  put(p.root, 'docs/guide.md', GUIDE.replace('Guide line 5.', 'Guide line 5, changed by someone else.')); const moved = commitAll(p.root, 'Target changes the guide');
  const w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 5.', 'Guide line 5, changed by someone else.').replace('Guide line 3.', 'Guide line 3, corrected.')); commitAll(w.path);
  const { error } = await refusedAtPublication(p, w, 'pinned', { taskValue: task, comparison: moved });
  assert.match(error.message, /the declared file docs\/guide\.md is not the file the task was validated against/);
});

// ---- Acceptance 2: every general rule of 7.4 ----
test('an own commit that is later undone is refused: a path, a mode and a link a builder committed and put back', async t => {
  const p = project(t);
  // The candidate as a whole changes only the declared file; an own commit in between changed another.
  let w = await p.workspace(); put(w.path, 'docs/other.md', 'Other doc, tidied.\n'); const tidy = commitAll(w.path, 'Tidy');
  put(w.path, 'docs/other.md', 'Other doc.\n'); put(w.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); commitAll(w.path, 'Undo the tidy and correct');
  const { error } = await refusedAtPublication(p, w, 'undeclared');
  assert.ok(error.upkeepViolations.some(row => row.code === 'undeclared' && row.commit === tidy && row.path === 'docs/other.md'), JSON.stringify(error.upkeepViolations));
  assert.match(error.message, new RegExp(`commit ${tidy.slice(0, 12)}, which is not in the comparison commit`));
  // The same candidate without the detour is published.
  w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); commitAll(w.path);
  assert.equal((await publishOutcome(p, w)).value?.route, 'published');
  // A mode changed and put back; a file deleted and recreated; a link added and removed.
  w = await p.workspace(); chmodSync(join(w.path, 'docs/guide.md'), 0o755); commitAll(w.path); chmodSync(join(w.path, 'docs/guide.md'), 0o644); commitAll(w.path);
  await refusedAtPublication(p, w, 'mode');
  w = await p.workspace(); unlinkSync(join(w.path, 'docs/guide.md')); commitAll(w.path); put(w.path, 'docs/guide.md', GUIDE); commitAll(w.path);
  await refusedAtPublication(p, w, ['deletion', 'addition']);
  w = await p.workspace(); link(w.path, 'docs/alias.md', 'guide.md'); commitAll(w.path); unlinkSync(join(w.path, 'docs/alias.md')); commitAll(w.path);
  await refusedAtPublication(p, w, ['link', 'addition']);
});

test('links and submodules: none added, changed or removed, and none above a changed path in either tree', async t => {
  const p = project(t, { layout: root => { link(root, 'docs/alias.md', 'guide.md'); put(root, 'docs/real/a.md', 'Real.\n'); link(root, 'docs/sub', 'real'); } });
  // The declared file replaced by a link to itself.
  let w = await p.workspace(); unlinkSync(join(w.path, 'docs/guide.md')); link(w.path, 'docs/guide.md', 'other.md'); commitAll(w.path);
  await refusedAtPublication(p, w, 'link');
  // An existing link retargeted, and one removed.
  w = await p.workspace(); unlinkSync(join(w.path, 'docs/alias.md')); link(w.path, 'docs/alias.md', 'other.md'); commitAll(w.path);
  await refusedAtPublication(p, w, 'link', { taskValue: p.task(['docs/guide.md']) });
  w = await p.workspace(); unlinkSync(join(w.path, 'docs/alias.md')); commitAll(w.path);
  await refusedAtPublication(p, w, ['link', 'deletion']);
  // A changed path with a link above it in the comparison tree: docs/sub is a link there and a folder in the candidate.
  w = await p.workspace(); unlinkSync(join(w.path, 'docs/sub')); put(w.path, 'docs/sub/a.md', 'Through the folder.\n'); commitAll(w.path);
  const { error } = await refusedAtPublication(p, w, 'link-above');
  assert.match(error.message, /docs\/sub, above docs\/sub\/a\.md, is a symbolic link in the comparison tree/);
  // A submodule (a gitlink entry) added.
  w = await p.workspace(); git(w.path, ['update-index', '--add', '--cacheinfo', `160000,${p.base},docs/vendor`]); git(w.path, ['commit', '-qm', 'Add a submodule entry']);
  await refusedAtPublication(p, w, 'submodule');
});

test('binary content: a NUL byte, invalid UTF-8 or more than 1 MiB is refused', async t => {
  const p = project(t), w1 = await p.workspace();
  writeFileSync(join(w1.path, 'docs/guide.md'), Buffer.concat([Buffer.from(GUIDE), Buffer.from([0])])); commitAll(w1.path);
  assert.match((await refusedAtPublication(p, w1, 'binary')).error.message, /docs\/guide\.md is binary: it contains a NUL byte/);
  const w2 = await p.workspace(); writeFileSync(join(w2.path, 'docs/guide.md'), Buffer.concat([Buffer.from(GUIDE), Buffer.from([0xff, 0xfe, 0x0a])])); commitAll(w2.path);
  assert.match((await refusedAtPublication(p, w2, 'binary')).error.message, /it is not valid UTF-8 text/);
  const w3 = await p.workspace(); writeFileSync(join(w3.path, 'docs/guide.md'), GUIDE + 'y'.repeat(MAX_TEXT_BYTES)); commitAll(w3.path);
  assert.match((await refusedAtPublication(p, w3, 'binary')).error.message, /it is larger than 1 MiB/);
});

// Governing paths reached through links, in either tree (7.1 with 7.4). Each fixture changes one
// declared doc that, through the links, is the governing file.
test('a governing path reached through a linked directory, a link chain, a link followed by .. or a case variant is refused, in either tree', async t => {
  const fixtures = [
    // The design's first example: rules/current is a link to ../docs, so the entry is docs/AGENTS.md.
    { name: 'linked directory', entry: 'rules/current/AGENTS.md', doc: 'docs/AGENTS.md', links: [['rules/current', '../docs']] },
    // A chain of two links to a directory.
    { name: 'link chain', entry: 'rules/AGENTS.md', doc: 'docs/AGENTS.md', links: [['rules', 'hop'], ['hop', 'docs']] },
    // The worked example: a `..` after a link resolves to private/AGENTS.md, not docs/AGENTS.md.
    { name: 'link followed by ..', entry: 'rules/AGENTS.md', doc: 'private/AGENTS.md', links: [['rules', 'docs/jump/..'], ['docs/jump', '../private/subdir']], dirs: ['private/subdir'] },
    // A case variant: the entry names the doc in another letter case.
    { name: 'case variant', entry: 'DOCS/Guide.MD', doc: 'docs/guide.md', links: [] },
  ];
  for (const fixture of fixtures) for (const where of fixture.links.length ? ['comparison', 'candidate', 'both'] : ['comparison']) {
    const withLinks = root => { for (const dir of fixture.dirs ?? []) put(root, `${dir}/.keep`, 'kept\n'); for (const [path, target] of fixture.links) link(root, path, target); };
    const p = project(t, { layout: root => { put(root, fixture.doc, 'A fictional doc that is governing.\n'); if (where !== 'candidate') withLinks(root); } });
    const configValue = p.config({ context: { files: [{ id: 'linked', path: fixture.entry }], maxChars: 24000 } });
    const w = await p.workspace();
    put(w.path, fixture.doc, 'A fictional doc that is governing, corrected.\n');
    if (where === 'candidate') withLinks(w.path);
    if (where === 'comparison') for (const [path] of fixture.links) unlinkSync(join(w.path, path));
    commitAll(w.path);
    const { error } = await refusedAtPublication(p, w, 'governing', { taskValue: p.task([fixture.doc]), configValue });
    const governing = error.upkeepViolations.find(row => row.code === 'governing' && row.path === fixture.doc);
    assert.ok(governing, `${fixture.name} (${where}): ${JSON.stringify(error.upkeepViolations)}`);
    // A case variant depends on the configuration, not on a tree: it is governing in both.
    assert.match(governing.detail, where === 'both' || !fixture.links.length ? /in the comparison and candidate tree/ : new RegExp(`in the ${where} tree`), `${fixture.name} (${where})`);
  }
  // The worked example's other side: docs/AGENTS.md is not the governing file on that account, so a
  // docs correction to it is published.
  const p = project(t, { layout: root => { put(root, 'private/subdir/.keep', 'kept\n'); put(root, 'docs/AGENTS.md', 'Docs agents.\n'); link(root, 'rules', 'docs/jump/..'); link(root, 'docs/jump', '../private/subdir'); } });
  const w = await p.workspace(); put(w.path, 'docs/AGENTS.md', 'Docs agents, corrected.\n'); commitAll(w.path);
  const outcome = await publishOutcome(p, w, { taskValue: p.task(['docs/AGENTS.md']), configValue: p.config({ context: { files: [{ id: 'linked', path: 'rules/AGENTS.md' }], maxChars: 24000 } }) });
  assert.equal(outcome.value?.route, 'published', outcome.error?.message);
  // A governing entry the tree cannot place fails closed: nothing is shown to be outside the set.
  const q = project(t, { layout: root => { link(root, 'rules', '/etc'); } }), v = await q.workspace();
  put(v.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); commitAll(v.path);
  const { error } = await refusedAtPublication(q, v, 'governing', { configValue: q.config({ context: { files: [{ id: 'escape', path: 'rules/AGENTS.md' }], maxChars: 24000 } }) });
  assert.match(error.message, /governing-unresolvable/);
});

test('a marker of a kind this release does not enforce, or one it cannot read, is still refused at publication', async t => {
  const p = project(t), w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); commitAll(w.path);
  for (const [upkeep, message] of [[{ ...p.marker(), kind: 'learning-edit' }, /which this release does not enforce \(enforced: docs, context, check, learning-add, learning-retire\)/], [{ ...p.marker(), kind: 'check' }, /of kind "check" that this release cannot read/], [{ ...p.marker(), kind: 'context' }, /of kind "context" that this release cannot read/], [{ ...p.marker(), limits: undefined }, /that this release cannot read/], [{ ...p.marker(), files: [] }, /files must list 1 to 3 declared files/]]) {
    const { error } = await publishOutcome(p, w, { taskValue: { ...p.task(), upkeep } });
    assert.match(error?.message ?? '', message); assert.equal(p.pushed(w.branch), false);
  }
});

// ---- The other three operations refuse the same candidate ----
test('commit, integration and merge each refuse an out-of-bounds candidate; a refused commit is undone', async t => {
  const p = project(t), w = await p.workspace();
  // Commit: undone, the change left in the worktree.
  put(w.path, 'docs/guide.md', GUIDE.replace('line 1.', 'line 1, corrected.')); put(w.path, 'docs/other.md', 'Tidied.\n');
  const before = git(w.path, ['rev-parse', 'HEAD']);
  await assert.rejects(runAction(p.action(w, 'workspace.commit')), error => error instanceof UpkeepCandidateRefusal && /^workspace\.commit: /.test(error.message) && codes(error).includes('undeclared'));
  assert.equal(git(w.path, ['rev-parse', 'HEAD']), before, 'the commit was undone');
  assert.match(git(w.path, ['status', '--porcelain']), /docs\/other\.md/);
  // Integration: the builder committed it itself.
  commitAll(w.path);
  await assert.rejects(runAction(p.action(w, 'workspace.integrate')), error => error instanceof UpkeepCandidateRefusal && /^workspace\.integrate: /.test(error.message) && codes(error).includes('undeclared'));
  // Merge: the authorized candidate is out of bounds (as it could be only if something before had
  // let it through); nothing is asked of the forge.
  const head = git(w.path, ['rev-parse', 'HEAD']);
  writeFileSync(join(p.bin, 'pr.json'), JSON.stringify({ head, base: p.base, branch: w.branch, title: 'x' }));
  await assert.rejects(runAction(p.action(w, 'forge.merge', { results: { publish: { number: 7 }, integrate: { base: p.base, head, conflicts: false } }, extra: { mergeAuthorization: { identity: repositoryIdentity(w.path), actor: 'operator', authority: 'operator' } } })), error => error instanceof UpkeepCandidateRefusal && /^forge\.merge: /.test(error.message) && codes(error).includes('undeclared'));
  assert.equal(p.calls().length, 0, 'the forge was not asked anything');
  // Merge without a recorded integration has nothing to compare with.
  await assert.rejects(runAction(p.action(w, 'forge.merge', { results: { publish: { number: 7 } }, extra: { mergeAuthorization: { identity: repositoryIdentity(w.path), actor: 'operator', authority: 'operator' } } })), /there is no comparison commit/);
  // A recorded comparison commit that the candidate does not contain is refused, not compared.
  put(p.root, 'src/app.txt', 'Elsewhere.\n'); const elsewhere = commitAll(p.root, 'Elsewhere');
  const outcome = await publishOutcome(p, w, { comparison: elsewhere });
  assert.match(outcome.error?.message ?? '', /does not contain the (recorded target|comparison commit)/);
  assert.throws(() => assertUpkeepCandidate({ repository: p.root, task: p.task(), config: p.config(), head: outcome.head, comparison: elsewhere, operation: 'forge.publish' }), /forge\.publish: .* it does not contain the comparison commit [0-9a-f]{12} through verified parents/);
});

// ---- Acceptance 3: a graph with no commit step ----
test('a graph with no commit step still cannot publish an out-of-bounds candidate', async t => {
  const f = sandbox(t);
  // The project: a docs tree, a remote, the target main.
  git(f.root, ['config', 'commit.gpgsign', 'false']); git(f.root, ['branch', '-M', 'main']);
  put(f.root, 'docs/guide.md', GUIDE); put(f.root, 'docs/other.md', 'Other doc.\n'); const base = commitAll(f.root, 'Docs');
  const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', 'main']);
  // Prepare, a project command that edits and commits in the worktree (a builder that commits
  // itself), integrate, publish: no commit step and no build step. Commissioning accepts the graph.
  const effect = (operation, next) => ({ kind: 'effect', action: { operation }, timeoutMs: 60000, next, onFailure: 'failed' });
  const edit = `const fs=require('node:fs'),{execFileSync}=require('node:child_process');fs.writeFileSync('docs/guide.md',${JSON.stringify(GUIDE.replace('line 1.', 'line 1, corrected.'))});fs.writeFileSync('docs/other.md','Tidied.\\n');execFileSync('git',['-c','user.email=b@example.invalid','-c','user.name=B','-c','commit.gpgsign=false','commit','-qam','Builder commit']);`;
  const graph = { version: 1, start: 'prepare', nodes: { prepare: effect('workspace.prepare', 'edit'), edit: { kind: 'effect', argv: [process.execPath, '-e', edit], timeoutMs: 60000, next: 'integrate', onFailure: 'failed' }, integrate: { ...effect('workspace.integrate', 'publish'), resultEdges: { integrated: 'publish', conflict: 'failed' } }, publish: effect('forge.publish', 'done'), done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' }, stopped: { kind: 'end', outcome: 'stopped' } } };
  const config = { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin' }, context: CONTEXT, upkeep: docsUpkeep(), policy: {} };
  mkdirSync(join(f.root, 'project/workflows'), { recursive: true }); writeFileSync(join(f.root, 'project/workflows/bare.json'), JSON.stringify(graph));
  const commissioned = { version: 1, ...config, mode: 'delivery', providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }] };
  assert.ok(compileCatalog({ ...commissioned, workflows: { definitions: { bare: { path: 'project/workflows/bare.json', kind: 'change' } }, selection: { default: 'bare' } } }, f.root));
  rmSync(join(f.root, 'project'), { recursive: true });
  f.store.setMeta('workflow', graph); f.store.setMeta('workflowDigest', digest(graph)); f.store.setMeta('config', config);
  // The task carries a well-formed docs marker the only way it can in this release: written to the
  // record before the flow is admitted (admission accepts a well-formed docs marker).
  const marker = { kind: 'docs', sourceFlow: 'flow-source', mergeCommit: base, candidates: [], evidence: [], files: [{ path: 'docs/guide.md', blob: git(f.root, ['rev-parse', `${base}:docs/guide.md`]) }], limits: { maxFiles: 3, maxChangedLines: 40 } };
  f.store.tx(() => { const task = f.store.need('task', 'task-1'); f.store.put('task', { ...task, paths: ['docs/guide.md'], upkeep: marker }); });
  { const started = f.start(); assert.equal(started.status, 'completed', started.error); }
  assert.ok(f.store.need('flow', 'flow-1').taskSnapshot.upkeep);
  await until(() => ['failed', 'completed'].includes(f.store.need('flow', 'flow-1').state), { tick: () => f.engine.tick() });
  const flow = f.store.need('flow', 'flow-1'), attempts = f.store.by('attempt', 'flowId', 'flow-1');
  assert.equal(flow.state, 'failed'); assert.equal(flow.results.publish, undefined); assert.equal(flow.results.edit?.exitCode ?? 0, 0);
  // Integration refuses it already; publication would too (the decisive check, above).
  assert.match(JSON.stringify(attempts.at(-1).receipt), /workspace\.integrate: the candidate of upkeep task task-1 \(kind docs\) is outside what its kind permits: .*docs\/other\.md is not one of the task's declared files/);
  // Nothing was pushed. Every graph commissioning accepts integrates directly before publishing, so
  // integration meets the candidate first; publication refuses the same candidate on its own
  // (the fixtures above run it with no commit or integration step before it).
  let branch = false; try { git(f.root, ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${flow.results.prepare.workspace.branch}`]); branch = true; } catch {}
  assert.equal(branch, false, 'nothing was pushed');
});

// ---- Acceptance 4: an upkeep flow is never merged by policy ----
// A commissioned delivery project with automatic merge on and qualified, and a flow placed at its
// merge question as the earlier steps would have left it (as tests/admission-capacity.test.mjs does).
async function atMergeQuestion(t, { marked }) {
  const f = sandbox(t), ok = receipt => { assert.equal(receipt.status, 'completed', receipt.error); return receipt.result; };
  git(f.root, ['config', 'commit.gpgsign', 'false']);
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'test', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: { mainProbeMs: 0, autoQueue: true, maxFlows: 2, mergeDecisionRole: 'operator' } };
  ok(f.command('config.update', { config, note: 'Commission fictional delivery' }));
  f.store.setMeta('commissioning', { ready: true, configDigest: f.store.meta('configDigest') });
  setTargetHealth(f.store, 'main', { status: 'green', head: repositoryIdentity(f.root).head, checkedAt: new Date().toISOString() });
  const stored = f.store.meta('config'); f.store.setMeta('config', { ...stored, policy: { ...stored.policy, autoMerge: true }, qualification: { qualified: true, targetFreshness: 'strict-status' } });
  ok(f.command('task.put', { task: { id: 'docs-task', title: 'Fictional docs task', acceptance: ['Observed'], risk: 'ordinary', paths: ['input.txt'] } }));
  if (marked) {
    // The marker, written to the record as the factory's creation path will write it (part B); the
    // revision is kept, so the approval below names it.
    const head = git(f.root, ['rev-parse', 'HEAD']);
    f.store.tx(() => { const task = f.store.need('task', 'docs-task'); f.store.put('task', { ...task, upkeep: { kind: 'docs', sourceFlow: 'flow-source', mergeCommit: head, candidates: [], evidence: [], files: [{ path: 'input.txt', blob: git(f.root, ['rev-parse', `${head}:input.txt`]) }], limits: { maxFiles: 3, maxChangedLines: 40 } } }); });
  }
  ok(f.command('task.approve', { taskId: 'docs-task', revision: f.store.need('task', 'docs-task').revision }));
  const flowId = ok(f.command('flow.start', { taskId: 'docs-task', revision: f.store.need('task', 'docs-task').revision, flowId: 'flow-docs' })).id;
  const integratedAt = repositoryIdentity(f.root).head, workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: f.project.projectId, flowId });
  put(workspace.path, 'input.txt', 'fictional baseline, corrected\n'); commitAll(workspace.path, 'Correct the input');
  const identity = repositoryIdentity(workspace.path);
  const review = { route: 'pass', identity, result: { verdict: 'pass', findings: [], riskAssessment: { level: 'ordinary', rationale: 'Docs change', threatModel: [], stopConditions: [] } } };
  f.store.put('flow', { ...f.store.need('flow', flowId), step: 'decide', state: 'ready', attemptId: null, workspace, results: { integrate: { base: integratedAt, head: identity.head, conflicts: false, route: 'integrated' }, review }, evidence: { review: { ...identity, attemptId: 'review-attempt' }, gate: { ...identity, attemptId: 'gate-attempt' } } });
  await f.engine.step(flowId);
  return { f, flowId, item: f.store.all('inbox').find(row => row.flowId === flowId && row.kind === 'question') };
}

test('an upkeep flow is never merged by policy: its merge question goes to the merge decision role', async t => {
  // The control: the same flow without the marker is merged by policy as its question opens.
  const ordinary = await atMergeQuestion(t, { marked: false });
  assert.equal(ordinary.item.autoMerge, true); assert.equal(ordinary.item.status, 'answered'); assert.equal(ordinary.item.answeredBy, 'orchestrator');
  assert.equal(ordinary.f.store.need('flow', ordinary.flowId).step, 'merge');
  const upkeep = await atMergeQuestion(t, { marked: true });
  assert.equal(upkeep.item.autoMerge, false); assert.equal(upkeep.item.status, 'open'); assert.equal(upkeep.item.role, 'operator');
  const flow = upkeep.f.store.need('flow', upkeep.flowId);
  assert.equal(flow.step, 'decide'); assert.equal(flow.state, 'waiting'); assert.ok(flow.taskSnapshot.upkeep, 'the flow carries the marker in its snapshot');
  // Further ticks change nothing: no policy answer is ever made for it.
  for (let i = 0; i < 3; i++) await upkeep.f.engine.tick();
  assert.equal(upkeep.f.store.need('inbox', upkeep.item.id).status, 'open');
  // The operator answers it, as for any flow.
  const answered = executeCommand(upkeep.f.store, { protocolVersion: 1, projectId: upkeep.f.project.projectId, commandId: uid(), actor: 'operator', operation: 'answer', payload: { inboxId: upkeep.item.id, version: upkeep.item.version, subjectDigest: upkeep.item.subjectDigest, answer: 'merge' } });
  assert.equal(answered.status, 'completed', answered.error);
  assert.equal(upkeep.f.store.need('flow', upkeep.flowId).mergeAuthorization.authority, 'operator');
});

// ---- Review of 406b2eb (GPT-6.1 Sol): three publication bypasses and the open questions ----

// P2-1. Tree names are read exactly: two different Git names must never read as one path.
test('review P2-1: a tree name that is not valid UTF-8 cannot pass as the declared file it decodes to', async t => {
  const declared = 'docs/odd.md', decoded = 'docs/�.md';
  const p = project(t, { layout: root => { put(root, declared, 'A doc with an odd name.\n'); put(root, decoded, 'A doc with a name outside the policy.\n'); } }), w = await p.workspace();
  // The reviewer's repro: a new file whose name is the bytes docs/<FF>.md, which a lossy decoder
  // reads as docs/U+FFFD.md. Any tree the check reads with such a name refuses the candidate.
  writeFileSync(Buffer.from(join(w.path, 'docs/\xff.md'), 'latin1'), 'A doc with an odd name, corrected.\n'); commitAll(w.path);
  const { error } = await refusedAtPublication(p, w, 'tree-name', { taskValue: p.task([declared]) });
  assert.match(error.message, /an entry name in tree [0-9a-f]{12} is not valid UTF-8 \(bytes ff2e6d64\)/);
  // Since part B's filename policy (review of 292d317), a marker cannot declare the decoded name at all.
  const u = await p.workspace(); put(u.path, decoded, 'Corrected.\n'); commitAll(u.path);
  const refused = await publishOutcome(p, u, { taskValue: p.task([decoded]) });
  assert.match(refused.error?.message ?? '', /cannot read \(each declared file needs a plain repository path within the filename policy/);
  // The declared file itself, edited under its real name, is published.
  const v = await p.workspace(); put(v.path, declared, 'A doc with an odd name, corrected.\n'); commitAll(v.path);
  assert.equal((await publishOutcome(p, v, { taskValue: p.task([declared]) })).value?.route, 'published');
});

test('review P2-1: the exact reader refuses duplicate names and names that are not one path component', async t => {
  const { strictTreeReader, InvalidTreeName } = await import('../starter/factory/workflows/upkeep-enforcement.mjs');
  const p = project(t), objects = new VerifiedObjects(p.root), blob = p.blob('docs/guide.md');
  const tree = names => { const id = Buffer.from(blob, 'hex'); return git(p.root, ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], Buffer.concat(names.map(name => Buffer.concat([Buffer.from(`100644 ${name}\0`), id])))); };
  const reader = strictTreeReader(objects);
  assert.throws(() => reader.tree(tree(['a.md', 'a.md'])), error => error instanceof InvalidTreeName && /two entries named "a\.md"/.test(error.message));
  assert.throws(() => reader.tree(tree(['a/b.md'])), error => error instanceof InvalidTreeName && /not a single path component/.test(error.message));
  assert.throws(() => reader.tree(tree(['..'])), InvalidTreeName);
  // A byte order mark at the start of a name is kept: the two names below are two entries.
  assert.deepEqual(reader.tree(tree(['﻿a.md', 'a.md'])).map(entry => entry.name).sort(), ['a.md', '﻿a.md']);
});

// P2-2. Line terminators and byte order marks count.
test('review P2-2: a dropped final newline, an added byte order mark and a changed line ending each count as changed lines', async t => {
  const p = project(t), configValue = p.config({ upkeep: docsUpkeep({ maxChangedLines: 2 }) });
  const line3 = GUIDE.replace('Guide line 3.', 'Guide line 3, corrected.');
  // The control: line 3 replaced is two changed lines, within the limit.
  let w = await p.workspace(); put(w.path, 'docs/guide.md', line3); commitAll(w.path);
  assert.equal((await publishOutcome(p, w, { configValue })).value?.route, 'published');
  for (const [name, text] of [['no final newline', line3.slice(0, -1)], ['a byte order mark', `﻿${line3}`], ['a CRLF line among LF lines', line3.replace('Guide line 7.\n', 'Guide line 7.\r\n')], ['LF lines turned CRLF', line3.replace(/\n/g, '\r\n')]]) {
    w = await p.workspace(); put(w.path, 'docs/guide.md', text); commitAll(w.path);
    const { error } = await refusedAtPublication(p, w, 'budget-lines', { configValue });
    assert.match(error.message, /changes (4|\d{2}) lines; at most 2 are allowed/, name);
  }
});

// P2-3. Every blob an own commit wrote is judged by the content rule.
test('review P2-3: a binary or oversized blob in an intermediate commit is refused, even when a later commit replaces it', async t => {
  const p = project(t), correct = GUIDE.replace('Guide line 3.', 'Guide line 3, corrected.');
  for (const [name, bytes, message] of [['a NUL byte', Buffer.concat([Buffer.from(GUIDE), Buffer.from([0])]), /it contains a NUL byte/], ['1 MiB and one byte', Buffer.from('y'.repeat(MAX_TEXT_BYTES + 1)), /it is larger than 1 MiB \(1048577 bytes\)/], ['invalid UTF-8', Buffer.from([0xff, 0x0a]), /it is not valid UTF-8 text/]]) {
    const w = await p.workspace();
    writeFileSync(join(w.path, 'docs/guide.md'), bytes); const intermediate = commitAll(w.path, `Write ${name}`);
    put(w.path, 'docs/guide.md', correct); commitAll(w.path, 'The valid correction');
    const { error } = await refusedAtPublication(p, w, 'binary');
    const row = error.upkeepViolations.find(violation => violation.code === 'binary');
    assert.equal(row.commit, intermediate, name); assert.match(row.detail, message, name);
  }
});

test('review P2-3: the content reads are bounded, and a candidate whose blobs exhaust the bound is refused', async t => {
  const { MAX_CONTENT_BYTES } = await import('../starter/factory/workflows/upkeep-enforcement.mjs');
  const p = project(t), w = await p.workspace();
  // Each intermediate blob is text within the 1 MiB limit; together they pass the bytes bound.
  const count = Math.floor(MAX_CONTENT_BYTES / MAX_TEXT_BYTES) + 1;
  for (let at = 0; at < count; at++) { writeFileSync(join(w.path, 'docs/guide.md'), `${at}\n`.padEnd(MAX_TEXT_BYTES - 1, 'z') + '\n'); commitAll(w.path, `Large text ${at}`); }
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, corrected.')); commitAll(w.path, 'The valid correction');
  const { error } = await refusedAtPublication(p, w, 'too-many-changes');
  assert.match(error.message, /was not read: the check reads at most 1000 blobs and 33554432 bytes/);
});

// Q3. A docs task whose integration conflicts is ended, not repaired.
test('review Q3: a conflicting integration of a docs task fails the step and undoes the merge; a commit during a merge is refused', async t => {
  const p = project(t), w = await p.workspace();
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, by the task.')); assert.equal((await runAction(p.action(w, 'workspace.commit'))).route, 'committed');
  const before = git(w.path, ['rev-parse', 'HEAD']);
  put(p.root, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, by someone else.')); commitAll(p.root, 'Target changes line 3'); git(p.root, ['push', '-q', 'origin', 'main']);
  await assert.rejects(runAction(p.action(w, 'workspace.integrate')), error => { assert.match(String(error), /^Error: workspace\.integrate: upkeep task upkeep:docs-1 conflicts with the target \(docs\/guide\.md\); a docs task whose integration conflicts is ended, not repaired/); assert.equal(error.upkeepEnding, 'base-moved', 'part B: the base moved under it (review of 292d317, P2-2)'); return true; });
  assert.equal(git(w.path, ['rev-parse', 'HEAD']), before); assert.equal(git(w.path, ['status', '--porcelain']), '', 'the merge was undone');
  assert.equal(existsSync(join(git(w.path, ['rev-parse', '--absolute-git-dir']), 'MERGE_HEAD')), false);
  // The same conflict for an ordinary task opens the conflict route, as before.
  const { upkeep, ...ordinary } = p.task(); ordinary.id = 'ordinary-1';
  const v = await p.workspace(); git(v.path, ['reset', '-q', '--hard', p.base]);
  put(v.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, ordinary.')); commitAll(v.path);
  assert.equal((await runAction(p.action(v, 'workspace.integrate', { taskValue: ordinary }))).route, 'conflict');
  // A merge someone started and resolved in a docs task's worktree is not committed.
  git(w.path, ['fetch', '-q', 'origin', 'main']); try { git(w.path, ['merge', '-q', '--no-edit', 'FETCH_HEAD']); } catch {}
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, resolved.')); git(w.path, ['add', '-A']);
  await assert.rejects(runAction(p.action(w, 'workspace.commit')), /workspace\.commit: upkeep task upkeep:docs-1 has a merge in progress; a docs task whose integration conflicted is ended, not repaired/);
  assert.equal(git(w.path, ['rev-parse', 'HEAD']), before);
});

// Q4. An upkeep task is never started as an adopted pull request or an already-satisfied outcome.
test('review Q4: admission refuses an upkeep task as an adopted pull request or an already-satisfied outcome', t => {
  const f = sandbox(t), head = git(f.root, ['rev-parse', 'HEAD']);
  f.store.tx(() => { const task = f.store.need('task', 'task-1'); f.store.put('task', { ...task, paths: ['input.txt'], upkeep: { kind: 'docs', sourceFlow: 'flow-source', mergeCommit: head, candidates: [], evidence: [], files: [{ path: 'input.txt', blob: git(f.root, ['rev-parse', `${head}:input.txt`]) }], limits: { maxFiles: 3, maxChangedLines: 40 } } }); });
  assert.equal(f.command('task.approve', { taskId: 'task-1', revision: f.store.need('task', 'task-1').revision }).status, 'completed');
  for (const extra of [{ alreadySatisfied: true }, { candidate: { number: 4, head, base: head } }]) {
    const result = f.command('flow.start', { taskId: 'task-1', flowId: `flow-${Object.keys(extra)[0]}`, ...extra });
    assert.equal(result.status, 'rejected'); assert.match(result.error, /task task-1 is an upkeep task; it cannot be started as an adopted pull request or as an already-satisfied outcome/);
  }
  assert.equal(f.store.by('flow', 'taskId', 'task-1').length, 0);
  // Started as its own change it is admitted.
  assert.equal(f.command('flow.start', { taskId: 'task-1', flowId: 'flow-1' }).status, 'completed');
});

// dev.90, review of 8441ff4 P2-2: every refusal of an upkeep task, on its real path, is tagged with one
// `refusal` field and gives the operator a notice with its own remedy. The Q3 refusals carried none.
const DISPATCH = new URL('../starter/factory/workflows/dispatch.mjs', import.meta.url).pathname;
// The step as the supervisor runs it: dispatch.mjs as its own process, writing action-result.json.
function dispatched(intent) {
  mkdirSync(intent.action.artifactDir, { recursive: true });
  const spec = join(intent.action.artifactDir, '..', `spec-${intent.attemptId}.json`);
  writeFileSync(spec, JSON.stringify({ ...intent, intentDigest: digest(intent) }));
  const run = spawnSync(process.execPath, [DISPATCH, spec], { cwd: intent.cwd, encoding: 'utf8', timeout: 60000 });
  assert.equal(run.status, 1, run.stderr);
  return JSON.parse(readFileSync(join(intent.action.artifactDir, 'action-result.json'), 'utf8'));
}
const refusedWith = async (intent, kind) => { let error = null; try { await runAction(intent); } catch (caught) { error = caught; } assert.ok(error, 'refused'); assert.equal(error.refusal?.kind, kind, error.stack); return error; };

test('dev.90 N1, review Q3: a conflicting integration and a commit during a merge each give a notice with their own remedy, and status --flow carries it', async t => {
  const p = project(t), w = await p.workspace();
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, by the task.')); assert.equal((await runAction(p.action(w, 'workspace.commit'))).route, 'committed');
  put(p.root, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, by someone else.')); commitAll(p.root, 'Target changes line 3'); git(p.root, ['push', '-q', 'origin', 'main']);
  const conflict = await refusedWith(p.action(w, 'workspace.integrate'), 'upkeep-conflict');
  assert.equal(conflict.upkeepEnding, 'base-moved', 'its candidates still return');
  assert.deepEqual(conflict.refusal.files, ['docs/guide.md']);
  assert.match(conflict.notice, /^The integration of knowledge-upkeep task upkeep:docs-1 \(kind docs\) with the target conflicted in docs\/guide\.md: the target changed the declared file after the candidate was made\. An upkeep follow-up is ended, not repaired, so workspace\.integrate refused it and undid the merge\. Nothing was delivered\. Its candidates return to waiting \(a third return expires them\); nothing is needed from you\./, 'dev.90 before the review: no notice');
  assert.match(conflict.notice, /Refusal: workspace\.integrate: upkeep task upkeep:docs-1 conflicts with the target/);
  // The same step through the supervisor's path: action-result.json has the notice, and a failed flow's narrow read shows it.
  const result = dispatched(p.action(w, 'workspace.integrate'));
  assert.equal(result.notice.slice(0, result.notice.indexOf(' Refusal: ')), conflict.notice.slice(0, conflict.notice.indexOf(' Refusal: ')), 'the same notice');
  assert.match(result.notice, / Refusal: workspace\.integrate: upkeep task upkeep:docs-1 conflicts with the target/);
  assert.equal(result.upkeepEnding, 'base-moved');
  const f = sandbox(t);
  f.store.tx(() => {
    f.store.put('flow', { id: 'flow-u', taskId: 'upkeep:docs-1', kind: 'change', state: 'failed', step: 'failed', results: {} });
    f.store.put('attempt', { id: 'attempt-u', flowId: 'flow-u', step: 'integrate', status: 'failed', settledAt: new Date().toISOString(), receipt: { exitCode: 1, actionResult: result } });
    f.store.event('attempt.prepared', { attemptId: 'attempt-u', flowId: 'flow-u' });
  });
  const view = stateView(f.store, { flow: 'flow-u' });
  assert.deepEqual(view.flow.failure, { step: 'integrate', attemptId: 'attempt-u', notice: result.notice });

  // A merge someone started and resolved in the follow-up's worktree.
  git(w.path, ['fetch', '-q', 'origin', 'main']); try { git(w.path, ['merge', '-q', '--no-edit', 'FETCH_HEAD']); } catch {}
  put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, resolved.')); git(w.path, ['add', '-A']);
  const merging = await refusedWith(p.action(w, 'workspace.commit'), 'upkeep-merge-in-progress');
  assert.equal(merging.upkeepEnding, undefined, 'unchanged: its candidates are failed, for you to reopen');
  assert.match(merging.notice, /^The worktree of knowledge-upkeep task upkeep:docs-1 \(kind docs\) has a merge in progress that the factory did not start \(an upkeep follow-up whose integration conflicts is ended, not repaired\), so workspace\.commit refused to commit it\. Nothing was delivered\. When its flow fails, its candidates are recorded as failed and its task is closed\. Do not resolve a follow-up's conflict by hand\. To try again, reopen a candidate from Health \(finding\.reopen\) and the factory makes a new follow-up from it against the current target; or make the correction yourself\./, 'dev.90 before the review: no notice');
});

test('dev.90 N1: a docs candidate outside its limits, one whose pinned file moved, and an unenforced marker each give their own notice on the real path', async t => {
  const p = project(t);
  // An undeclared file, refused at commit.
  let w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, corrected.')); put(w.path, 'docs/other.md', 'Other doc, also changed.\n');
  const limits = await refusedWith(p.action(w, 'workspace.commit'), 'upkeep-limits');
  assert.deepEqual([limits.refusal.upkeepKind, limits.refusal.ending], ['docs', null]);
  assert.ok(limits.refusal.files.includes('docs/other.md'));
  assert.match(limits.notice, /^The candidate of knowledge-upkeep task upkeep:docs-1 \(kind docs\) is outside what its kind permits \([^)]*docs\/other\.md[^)]*\), so workspace\.commit refused it\. Nothing was delivered\. When its flow fails, its candidates are recorded as failed and its task is closed\. To try again, reopen a candidate from Health/);
  // The declared file pinned to another blob: refused as stale, candidates returned.
  w = await p.workspace(); put(w.path, 'docs/guide.md', GUIDE.replace('Guide line 3.', 'Guide line 3, corrected.'));
  const stale = p.task(); stale.upkeep.files[0].blob = 'a'.repeat(40);
  const pinned = await refusedWith(p.action(w, 'workspace.commit', { taskValue: stale }), 'upkeep-limits');
  assert.equal(pinned.refusal.ending, 'stale');
  assert.match(pinned.notice, /because a file it declared \(docs\/guide\.md\) is no longer the version its candidates were validated against: the target changed it\. Nothing was delivered\. Its candidates return to waiting \(a third return expires them\); nothing is needed from you\./);
  // A marker of a kind this release does not enforce.
  const unknown = p.task(); unknown.upkeep = { ...unknown.upkeep, kind: 'fictional-kind' };
  const marker = await refusedWith(p.action(w, 'workspace.commit', { taskValue: unknown }), 'upkeep-marker');
  assert.match(marker.notice, /^Task upkeep:docs-1 carries a knowledge-upkeep marker of kind fictional-kind that this release cannot enforce, so workspace\.commit refused it\. Nothing was delivered\. Abandon its flow and close the task/);
});
