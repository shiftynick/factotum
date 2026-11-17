// Installation under a repository folder (adopt install --prefix), and releases without
// Factotum's own test files. Every project and path here is fictional.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, readdirSync, lstatSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { sandbox, workflow as rehearsalWorkflow } from './helpers.mjs';
import { buildRelease, readRelease, prepareAdoption, adoptionStatus, adoptionPlan } from '../starter/factory/distribution.mjs';
import { prepareUpgrade, mergeUpgrade } from '../starter/factory/operations/upgrade-apply.mjs';
import { projectUnit, unitDiagnostics, installUnit } from '../starter/factory/operations/services.mjs';
import { settingsView } from '../starter/factory/operations/views.mjs';
import * as dispatch from '../starter/factory/workflows/dispatch.mjs';
const { runAction } = dispatch;
import { installPrefix, readInstallLock } from '../starter/factory/core/install-layout.mjs';
import { prepare } from '../starter/factory/adapters/workspace/index.mjs';
import { uid } from '../starter/factory/core/contracts.mjs';
import { compileCatalog } from '../starter/factory/core/catalog.mjs';

const cli = join(process.cwd(), 'starter/factory/cli.mjs');
const PREFIX = 'tools/factotum';
const git = (root, args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (root, path, text) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), text); };
const commit = (root, message = 'Fictional checkpoint') => { git(root, ['add', '.']); git(root, ['commit', '-qm', message]); };
function repository(root) { mkdirSync(root, { recursive: true }); git(root, ['init', '-qb', 'main']); git(root, ['config', 'user.email', 'fictional@example.invalid']); git(root, ['config', 'user.name', 'Fictional Maintainer']); git(root, ['config', 'commit.gpgsign', 'false']); }
function command(args) { const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' }); return { code: result.status, out: result.stdout, err: result.stderr, json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() }; }
const template = { version: 1, context: { files: [{ id: 'factotum-core-ownership', path: 'factory/AGENTS.md', required: true }, { id: 'project-governance', path: 'project/GOVERNANCE.md', required: true }, { id: 'readme', path: 'README.md' }], maxChars: 24000 } };
function starter(source, marker) {
  put(source, 'factory/cli.mjs', `console.log(${JSON.stringify(marker)});\n`); put(source, 'factory/AGENTS.md', 'Fictional core ownership\n');
  // The release's own configuration validator, which upgrade apply runs before it touches anything.
  put(source, 'factory/core/configuration.mjs', 'export const validateConfig = config => config;\n');
  put(source, 'project/GOVERNANCE.md', 'Template governance\n'); put(source, 'project/factotum.template.json', JSON.stringify(template, null, 2) + '\n');
  put(source, 'VERSION', 'development\n'); put(source, 'compatibility.json', JSON.stringify({ schemaVersion: 1, configVersion: 1, projectProtocolVersion: 1 }));
}
// A project whose own root VERSION file blocks a root installation.
function fixture(t, { rootName = 'app' } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'factotum-prefix-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const source = join(base, 'reference/starter'), root = join(base, rootName); repository(join(base, 'reference')); starter(source, 'one'); commit(join(base, 'reference'));
  repository(root); put(root, 'VERSION', '1.4.2\n'); put(root, 'app.txt', 'Existing application\n'); commit(root);
  const releaseDir = join(base, 'release-one'), release = buildRelease({ sourceDir: source, outputDir: releaseDir, version: '1.0.0' });
  const options = { root, releaseDir, expectedDigest: release.manifestDigest, branch: 'chore/install', worktreeDir: join(base, 'install'), initial: true };
  return { base, source, root, releaseDir, release, options };
}
function next(f, version = '1.1.0') {
  starter(f.source, `two ${version}`); put(f.source, 'factory/new.mjs', 'export const next = true;\n'); commit(join(f.base, 'reference'));
  const releaseDir = join(f.base, `release-${version}`), release = buildRelease({ sourceDir: f.source, outputDir: releaseDir, version });
  return { root: f.root, releaseDir, expectedDigest: release.manifestDigest, branch: `chore/update-${version}`, worktreeDir: join(f.base, `update-${version}`) };
}
const merge = (root, prepared) => { commit(prepared.worktree, 'Adopt fictional release'); git(root, ['merge', '--ff-only', prepared.branch]); };

test('a project with its own root VERSION installs under --prefix; its files and later updates stay where they are', t => {
  const f = fixture(t);
  const refused = command(['adopt', 'install', '--root', f.root, '--release', f.releaseDir, '--digest', f.release.manifestDigest, '--branch', 'chore/root', '--worktree', join(f.base, 'root-attempt')]);
  assert.notEqual(refused.code, 0); assert.match(refused.err, /VERSION \(installation would overwrite existing project file\)/);
  const installed = command(['adopt', 'install', '--root', f.root, '--release', f.releaseDir, '--digest', f.release.manifestDigest, '--branch', f.options.branch, '--worktree', f.options.worktreeDir, '--prefix', PREFIX]);
  assert.equal(installed.code, 0, installed.err); const w = installed.json.worktree;
  assert.equal(readFileSync(join(w, 'VERSION'), 'utf8'), '1.4.2\n', 'the project VERSION is untouched');
  assert.equal(readFileSync(join(w, PREFIX, 'VERSION'), 'utf8'), '1.0.0\n');
  for (const path of ['compatibility.json', 'factory/cli.mjs', 'project/GOVERNANCE.md']) assert.ok(existsSync(join(w, PREFIX, path)), path);
  assert.equal(existsSync(join(w, 'factory')), false); assert.equal(existsSync(join(w, 'project')), false);
  const lock = JSON.parse(readFileSync(join(w, 'factotum.lock.json'), 'utf8'));
  assert.equal(lock.prefix, PREFIX); assert.ok(lock.managedFiles.every(file => !file.path.startsWith(PREFIX)), 'managed paths stay release-relative');
  assert.ok(installed.json.plan.changes.every(change => change.path.startsWith(`${PREFIX}/`)));
  // The seeded configuration template names the prefixed governing-context files.
  assert.deepEqual(JSON.parse(readFileSync(join(w, PREFIX, 'project/factotum.template.json'), 'utf8')).context.files.map(file => file.path), [`${PREFIX}/factory/AGENTS.md`, `${PREFIX}/project/GOVERNANCE.md`, 'README.md']);
  merge(f.root, installed.json);
  const status = command(['adopt', 'status', '--root', f.root]); assert.equal(status.code, 0, status.out); assert.equal(status.json.prefix, PREFIX); assert.equal(status.json.clean, true);
  // Drift is reported at its repository path.
  put(f.root, `${PREFIX}/factory/cli.mjs`, 'Local core patch\n');
  assert.deepEqual(adoptionStatus({ root: f.root }).conflicts, [{ path: `${PREFIX}/factory/cli.mjs`, reason: 'locally modified managed file' }]);
  git(f.root, ['checkout', '--', '.']);
  // An update finds the prefix in the lock; it is not given again, and a different one is refused.
  const update = next(f), plan = command(['adopt', 'plan', '--root', f.root, '--release', update.releaseDir, '--digest', update.expectedDigest]);
  assert.equal(plan.code, 0, plan.out); assert.ok(plan.json.changes.some(change => change.path === `${PREFIX}/factory/new.mjs` && change.kind === 'add'));
  assert.throws(() => adoptionPlan({ root: f.root, releaseDir: update.releaseDir, expectedDigest: update.expectedDigest, prefix: 'elsewhere' }), /installed under tools\/factotum .* cannot move it/);
  const updated = command(['adopt', 'update', '--root', f.root, '--release', update.releaseDir, '--digest', update.expectedDigest, '--branch', update.branch, '--worktree', update.worktreeDir]);
  assert.equal(updated.code, 0, updated.err);
  assert.match(readFileSync(join(updated.json.worktree, PREFIX, 'factory/cli.mjs'), 'utf8'), /two/); assert.ok(existsSync(join(updated.json.worktree, PREFIX, 'factory/new.mjs')));
  assert.equal(existsSync(join(updated.json.worktree, 'factory')), false); assert.equal(readFileSync(join(updated.json.worktree, 'VERSION'), 'utf8'), '1.4.2\n');
  assert.equal(JSON.parse(readFileSync(join(updated.json.worktree, 'factotum.lock.json'), 'utf8')).prefix, PREFIX);
  assert.equal(adoptionStatus({ root: updated.json.worktree }).clean, true);
});

test('a root installation has no prefix in the lock, plan or status; its lock carries layout evidence under rootLayout (dev.87)', t => {
  const f = fixture(t); git(f.root, ['rm', '-q', 'VERSION']); commit(f.root);
  const prepared = prepareAdoption(f.options), lock = JSON.parse(readFileSync(join(prepared.worktree, 'factotum.lock.json'), 'utf8'));
  assert.deepEqual(Object.keys(lock), ['formatVersion', 'release', 'managedFiles', 'rootLayout', 'templatePolicy']);
  assert.ok(lock.rootLayout.templateFiles.length && lock.rootLayout.compatibility, 'the same evidence a prefixed lock carries under layout');
  assert.equal(adoptionStatus({ root: prepared.worktree }).authenticated, true);
  assert.equal('prefix' in prepared.plan, false); assert.ok(existsSync(join(prepared.worktree, 'factory/cli.mjs')));
  assert.equal(readFileSync(join(prepared.worktree, 'project/factotum.template.json'), 'utf8'), JSON.stringify(template, null, 2) + '\n', 'the template is seeded byte for byte');
  merge(f.root, prepared); assert.equal('prefix' in adoptionStatus({ root: f.root }), false);
});

test('invalid prefixes are refused before anything is created', t => {
  const f = fixture(t);
  const cases = [['/abs/olute', /not absolute/], ['../outside', /"\.\." is not allowed/], ['tools/../../outside', /"\.\." is not allowed/], ['./tools', /normalised/], ['tools//factotum', /normalised/], ['tools/./factotum', /normalised/],
    ['.git/factotum', /inside \.git/], ['tools/.GIT', /inside \.git/], ['tools\\factotum', /backslashes/], ['C:/factotum', /not absolute/], ['tools/facto tum', /only letters, digits/], ['tools/$(touch x)', /only letters, digits/], ['tools/a;b', /only letters, digits/], ["tools/it's", /only letters, digits/], ['-rf', /may not start with "-"/], ['tools/-x', /may not start with "-"/], ['app.txt', /overlaps an existing project file: app.txt/], ['app.txt/inner', /overlaps an existing project file: app.txt/]];
  for (const [prefix, error] of cases) {
    assert.throws(() => prepareAdoption({ ...f.options, prefix }), error, prefix);
    assert.equal(existsSync(f.options.worktreeDir), false, prefix); assert.equal(git(f.root, ['branch', '--list', f.options.branch]), '', prefix);
  }
  const cliRefusal = command(['adopt', 'install', '--root', f.root, '--release', f.releaseDir, '--digest', f.release.manifestDigest, '--branch', f.options.branch, '--worktree', f.options.worktreeDir, '--prefix', '../escape']);
  assert.notEqual(cliRefusal.code, 0); assert.match(cliRefusal.err, /"\.\." is not allowed/);
  // A file already at a path under the prefix is a conflict, as at the root.
  put(f.root, `${PREFIX}/VERSION`, 'Project file\n'); commit(f.root);
  assert.throws(() => prepareAdoption({ ...f.options, prefix: PREFIX }), /tools\/factotum\/VERSION \(installation would overwrite existing project file\)/);
  // A symlinked folder, a nested repository and an ignored folder are refused too.
  const g = fixture(t); mkdirSync(join(g.base, 'elsewhere')); symlinkSync(join(g.base, 'elsewhere'), join(g.root, 'linked')); commit(g.root);
  assert.throws(() => prepareAdoption({ ...g.options, prefix: 'linked/factotum' }), /symlink/);
  const h = fixture(t); repository(join(h.root, 'vendor/other')); put(h.root, 'vendor/other/readme.txt', 'Nested\n'); commit(join(h.root, 'vendor/other')); commit(h.root);
  assert.throws(() => prepareAdoption({ ...h.options, prefix: 'vendor/other/factotum' }), /(nested Git repository or submodule|inside a submodule): vendor\/other/);
  const i = fixture(t); put(i.root, '.gitignore', 'tools/\n'); commit(i.root);
  assert.throws(() => prepareAdoption({ ...i.options, prefix: PREFIX }), /tools\/factotum\/factory\/cli\.mjs \(ignored by the project's Git ignore rules/);
  assert.equal(existsSync(i.options.worktreeDir), false);
});

test('a prefixed project generates its service unit, doctor check, guidance and upgrade commands from the prefix', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const release = version => { const source = join(f.base, `source-${version}`); starter(source, version); const dir = join(f.base, `release-${version}`); return { dir, ...buildRelease({ sourceDir: source, outputDir: dir, version, allowWorkingTree: true }) }; };
  const one = release('1.0.0'), installed = prepareAdoption({ root: f.root, releaseDir: one.dir, expectedDigest: one.manifestDigest, branch: 'chore/install', worktreeDir: join(f.base, 'install'), initial: true, prefix: PREFIX });
  merge(f.root, installed);
  const project = f.store.meta('project'), prefixedCli = join(project.root, PREFIX, 'factory/cli.mjs');
  // Service unit and its doctor diagnostic.
  const unit = projectUnit({ project, stateDir: f.stateDir, path: '/usr/bin:/bin' });
  assert.ok(unit.content.includes(`ExecStart=${process.execPath} ${prefixedCli} serve --state ${f.stateDir}`), unit.content);
  assert.equal(unit.content.includes(join(project.root, 'factory/cli.mjs')), false);
  const unitDir = join(f.base, 'units'), quiet = async binary => ({ code: 0, stdout: binary === 'loginctl' ? 'yes\n' : '', stderr: '' });
  await installUnit(unit, { unitDir, run: quiet });
  assert.deepEqual(unitDiagnostics(project, f.stateDir, { unitDir }), []);
  writeFileSync(join(unitDir, unit.name), unit.content.replace(prefixedCli, join(project.root, 'factory/cli.mjs')));
  assert.match(unitDiagnostics(project, f.stateDir, { unitDir })[0], /does not start this project's tools\/factotum\/factory\/cli\.mjs/);
  // Guidance text names the prefixed CLI.
  assert.equal(settingsView(f.store).cli, `node ${PREFIX}/factory/cli.mjs`);
  // upgrade apply: prepare and merge without being told the prefix; recommission and doctor run the merged prefixed CLI.
  const two = release('1.1.0'), options = { root: f.root, stateDir: f.stateDir, releaseDir: two.dir, expectedDigest: two.manifestDigest, branch: 'chore/factotum-1.1.0', worktreeDir: join(f.base, 'review-1.1.0') };
  const prepared = prepareUpgrade(options);
  assert.ok(prepared.plan.changes.every(change => change.path.startsWith(`${PREFIX}/`)), JSON.stringify(prepared.plan.changes));
  commit(prepared.worktree, 'Adopt 1.1.0');
  const nodeCalls = [], run = async (binary, args) => { if (binary === process.execPath) { nodeCalls.push(args); return { code: 0, stdout: '{}', stderr: '' }; } if (binary === 'systemctl') return { code: args[1] === 'is-active' ? 3 : 0, stdout: '', stderr: '' }; return { code: 0, stdout: '', stderr: '' }; };
  const result = await mergeUpgrade({ ...options, backupDir: join(f.base, 'backup'), run });
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(nodeCalls.map(args => [args[0], args[1]]), [[prefixedCli, 'config'], [prefixedCli, 'doctor']]);
  assert.match(readFileSync(prefixedCli, 'utf8'), /1\.1\.0/); assert.equal(adoptionStatus({ root: f.root }).version, '1.1.0');
  assert.equal(existsSync(join(f.root, 'factory')), false);
});

test('builders may not edit, and workflows may not live in, the upgrade-owned factory under the install prefix', async t => {
  const f = sandbox(t);
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX }) + '\n'); put(f.root, `${PREFIX}/factory/cli.mjs`, 'Upgrade-owned\n'); commit(f.root);
  const repository = { slug: 'fictional/demo', account: 'fictional', target: 'main' };
  const attempt = async (flowId, path) => {
    const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: 'HEAD' });
    put(workspace.path, path, `Builder change for ${flowId}\n`);
    return runAction({ version: 1, attemptId: uid(), projectRoot: f.root, cwd: workspace.path, timeoutMs: 60000, synthetic: true, maxCostMicros: 0, action: { operation: 'workspace.commit', workspace, projectId: 'fictional', flowId, stateDir: f.stateDir, artifactDir: join(f.base, `attempt-${flowId}`), config: { mode: 'rehearsal', repository }, task: { id: 'task', title: 'Fictional change', acceptance: ['Persist the candidate'] }, context: { files: [] }, results: {} } });
  };
  await assert.rejects(attempt('managed', `${PREFIX}/factory/cli.mjs`), /factory changes need explicit installation policy \(tools\/factotum\/factory\/, tools\/factotum\/VERSION, tools\/factotum\/compatibility\.json are upgrade-owned; changed: tools\/factotum\/factory\/cli\.mjs\)/);
  await assert.rejects(attempt('version', `${PREFIX}/VERSION`), /factory changes need explicit installation policy/);
  // Outside the prefix, a folder named factory is the project's own.
  assert.equal((await attempt('project', 'factory/notes.md')).route, 'committed');
  assert.equal((await attempt('template', `${PREFIX}/project/GOVERNANCE.md`)).route, 'committed');
  const workflow = JSON.stringify(rehearsalWorkflow([process.execPath, '-e', '1']));
  put(f.root, `${PREFIX}/factory/flow.json`, workflow); put(f.root, `${PREFIX}/project/workflows/flow.json`, workflow);
  const catalog = path => compileCatalog({ workflows: { definitions: { custom: { path } }, selection: { default: 'custom' } } }, f.root);
  assert.throws(() => catalog(`${PREFIX}/factory/flow.json`), /outside the upgrade-owned tools\/factotum\/factory\//);
  assert.doesNotThrow(() => catalog(`${PREFIX}/project/workflows/flow.json`));
});

// The inventory order buildRelease and readRelease use.
function inventory(root, prefix = '') { return readdirSync(join(root, prefix)).sort().flatMap(name => { const path = prefix + name, full = join(root, path), stat = lstatSync(full); return stat.isDirectory() ? inventory(root, path + '/') : [{ path, sha256: createHash('sha256').update(readFileSync(full)).digest('hex'), mode: stat.mode & 0o111 ? 0o755 : 0o644 }]; }); }
// A release as earlier builders produced it, when the starter still carried two test files.
function earlierRelease(base, version) {
  const out = join(base, `earlier-${version}`), payload = join(out, 'starter'), starterDir = join(process.cwd(), 'starter');
  cpSync(starterDir, payload, { recursive: true });
  put(payload, 'factory/console/console.test.mjs', readFileSync(join(process.cwd(), 'tests/console-server.test.mjs'), 'utf8'));
  put(payload, 'factory/core/contracts.test.mjs', readFileSync(join(process.cwd(), 'tests/workflow-contracts.test.mjs'), 'utf8'));
  writeFileSync(join(payload, 'VERSION'), version + '\n');
  const c = JSON.parse(readFileSync(join(payload, 'compatibility.json'), 'utf8')); Object.assign(c, { starterVersion: version, schemaVersions: [c.schemaVersion], configVersions: [c.configVersion], requireDrain: true }); writeFileSync(join(payload, 'compatibility.json'), JSON.stringify(c, null, 2) + '\n');
  const files = inventory(payload).map(file => ({ ...file, owner: file.path.startsWith('project/') ? 'template' : 'managed' }));
  const manifest = { formatVersion: 1, version, sourceCommit: null, sourceState: 'working-tree', compatibility: { schemaVersions: [c.schemaVersion], configVersions: [c.configVersion], projectProtocolVersions: [c.projectProtocolVersion], requireDrain: true }, files, payloadDigest: createHash('sha256').update(JSON.stringify(files, null, 2) + '\n').digest('hex') };
  const bytes = JSON.stringify(manifest, null, 2) + '\n'; writeFileSync(join(out, 'release.json'), bytes);
  return { releaseDir: out, digest: createHash('sha256').update(bytes).digest('hex') };
}
const SHIPPED_TESTS = ['factory/console/console.test.mjs', 'factory/core/contracts.test.mjs'];

test('a release built from this starter contains no test files, and the builder refuses one', t => {
  const base = mkdtempSync(join(tmpdir(), 'factotum-release-tests-')); t.after(() => rmSync(base, { recursive: true, force: true }));
  const built = command(['release', 'build', '--source', join(process.cwd(), 'starter'), '--out', join(base, 'release'), '--version', '0.0.0-dev.prefix', '--development']);
  assert.equal(built.code, 0, built.err);
  const release = readRelease(join(base, 'release'), built.json.manifestDigest);
  assert.deepEqual(release.manifest.files.filter(file => /\.test\.mjs$/.test(file.path)).map(file => file.path), []);
  assert.deepEqual(inventory(release.payload).filter(file => /\.test\.mjs$/.test(file.path)), []);
  const source = join(base, 'starter'); starter(source, 'with test'); put(source, 'factory/core/extra.test.mjs', 'export {};\n');
  assert.throws(() => buildRelease({ sourceDir: source, outputDir: join(base, 'refused'), version: '9.9.9', allowWorkingTree: true }), /must not contain test files.*factory\/core\/extra\.test\.mjs/);
  assert.equal(existsSync(join(base, 'refused')), false);
});

test('updating from a release that shipped test files removes them, and only them', t => {
  for (const prefix of ['', PREFIX]) {
    const base = mkdtempSync(join(tmpdir(), 'factotum-shipped-tests-')); t.after(() => rmSync(base, { recursive: true, force: true }));
    const root = join(base, 'app'); repository(root); put(root, 'app.txt', 'Application\n'); put(root, 'tests/app.test.mjs', 'export {};\n'); commit(root);
    const earlier = earlierRelease(base, '0.9.0'), at = path => join(root, prefix, path);
    merge(root, prepareAdoption({ root, releaseDir: earlier.releaseDir, expectedDigest: earlier.digest, branch: 'chore/install', worktreeDir: join(base, 'install'), initial: true, prefix }));
    for (const path of SHIPPED_TESTS) assert.ok(existsSync(at(path)), `${prefix} ${path} installed by the earlier release`);
    put(root, `${prefix ? prefix + '/' : ''}project/integrations/check.test.mjs`, 'export {};\n'); commit(root);
    const built = buildRelease({ sourceDir: join(process.cwd(), 'starter'), outputDir: join(base, 'current'), version: '1.0.0-dev.prefix', allowWorkingTree: true });
    const plan = adoptionPlan({ root, releaseDir: join(base, 'current'), expectedDigest: built.manifestDigest });
    assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
    const removed = plan.changes.filter(change => change.kind === 'remove').map(change => change.path).sort();
    assert.deepEqual(removed, SHIPPED_TESTS.map(path => prefix ? `${prefix}/${path}` : path));
    const prepared = prepareAdoption({ root, releaseDir: join(base, 'current'), expectedDigest: built.manifestDigest, branch: 'chore/update', worktreeDir: join(base, 'update') });
    for (const path of SHIPPED_TESTS) assert.equal(existsSync(join(prepared.worktree, prefix, path)), false, `${prefix} ${path} removed`);
    assert.ok(existsSync(join(prepared.worktree, 'tests/app.test.mjs')), 'project test files stay');
    assert.ok(existsSync(join(prepared.worktree, prefix, 'project/integrations/check.test.mjs')), 'project-owned files under the installation stay');
    assert.equal(adoptionStatus({ root: prepared.worktree }).clean, true);
    assert.equal(JSON.parse(readFileSync(join(prepared.worktree, 'factotum.lock.json'), 'utf8')).managedFiles.some(file => /\.test\.mjs$/.test(file.path)), false);
  }
});

// Review fixes: the lock decides where the core is and what an update may remove.
const builderAttempt = (f, repository = { slug: 'fictional/demo', account: 'fictional', target: 'main' }) => async (flowId, change, policy, results = {}) => {
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: 'HEAD' });
  change(workspace.path);
  return runAction({ version: 1, attemptId: uid(), projectRoot: f.root, cwd: workspace.path, timeoutMs: 60000, synthetic: true, maxCostMicros: 0, action: { operation: 'workspace.commit', workspace, projectId: 'fictional', flowId, stateDir: f.stateDir, artifactDir: join(f.base, `attempt-${flowId}`), config: { mode: 'rehearsal', repository, ...(policy ? { policy } : {}) }, task: { id: 'task', title: 'Fictional change', acceptance: ['Persist the candidate'] }, context: { files: [] }, results } });
};

test('builders may not change, delete or move factotum.lock.json or move upgrade-owned files away (review repro 1)', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX }) + '\n'); put(f.root, `${PREFIX}/factory/cli.mjs`, '// managed\n'); commit(f.root);
  const attempt = builderAttempt(f), refusal = /factotum\.lock\.json is changed only by adopt install\/update, never by a builder/;
  // The reviewer's repro: retarget the prefix, so a later builder could edit the real core.
  await assert.rejects(attempt('retarget', w => put(w, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: 'elsewhere' }))), refusal);
  await assert.rejects(attempt('retarget-allowed', w => put(w, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: 'elsewhere' })), { allowFactoryEdits: true }), refusal, 'allowFactoryEdits never covers the lock');
  await assert.rejects(attempt('delete', w => rmSync(join(w, 'factotum.lock.json'))), refusal);
  assert.equal(installPrefix(f.root), PREFIX, 'the live lock is unchanged');
  // A staged rename reports its source as a separate field; moving the core away is still a core change.
  await assert.rejects(attempt('rename', w => git(w, ['mv', `${PREFIX}/factory/cli.mjs`, 'moved.mjs'])), /factory changes need explicit installation policy.*changed: tools\/factotum\/factory\/cli\.mjs\)/);
  assert.deepEqual(dispatch.changedPaths?.('R  moved.mjs\0tools/factotum/factory/cli.mjs\0 M a.txt\0?? b c.txt\0'), ['moved.mjs', `${PREFIX}/factory/cli.mjs`, 'a.txt', 'b c.txt']);
  // A root installation's lock is protected the same way; a project without a lock cannot gain one from a builder.
  const g = sandbox(t); put(g.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1 }) + '\n'); commit(g.root);
  await assert.rejects(builderAttempt(g)('root-lock', w => put(w, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: 'application' }))), refusal);
  await assert.rejects(builderAttempt(g)('root-version', w => put(w, 'VERSION', 'changed\n')), /factory changes need explicit installation policy/);
  const h = sandbox(t);
  await assert.rejects(builderAttempt(h)('new-lock', w => put(w, 'factotum.lock.json', '{}')), refusal);
  assert.equal((await builderAttempt(h)('own-version', w => put(w, 'VERSION', '1.4.2\n'))).route, 'committed', 'without a lock, a root VERSION is the project\'s');
  // Fail closed: an unreadable or invalid lock in the project checkout refuses every builder commit.
  writeFileSync(join(f.root, 'factotum.lock.json'), '{ not json'); commit(f.root);
  await assert.rejects(attempt('unreadable', w => put(w, 'notes.md', 'Ordinary change\n')), /factotum\.lock\.json is unreadable or not valid JSON/);
  writeFileSync(join(f.root, 'factotum.lock.json'), JSON.stringify({ formatVersion: 1, prefix: '../outside' })); commit(f.root);
  await assert.rejects(attempt('invalid', w => put(w, 'notes.md', 'Ordinary change\n')), /records an invalid install prefix/);
});

test('an update refuses a lock whose prefix or managed files do not match its release or history (review repro 2)', t => {
  // A genuine prefixed installation of release 1.1.0, whose lock is then forged.
  const f = fixture(t), update = next(f);
  const genuine = prepareAdoption({ ...f.options, releaseDir: update.releaseDir, expectedDigest: update.expectedDigest, prefix: PREFIX });
  const realLock = JSON.parse(readFileSync(join(genuine.worktree, 'factotum.lock.json'), 'utf8'));
  // The reviewer's repro: valid release record, prefix moved onto application files, a forged managed entry.
  const bytes = 'application owned data\n', root = join(f.base, 'delete-app'); repository(root); put(root, 'application/factory/keep.txt', bytes);
  const forged = { ...realLock, prefix: 'application', managedFiles: [{ path: 'factory/keep.txt', sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o644 }] };
  for (const [name, lock] of [['without layout', (({ layout, ...rest }) => rest)(forged)], ['with the genuine layout', forged]]) {
    writeFileSync(join(root, 'factotum.lock.json'), JSON.stringify(lock)); commit(root, `Tampered lock ${name}`);
    const worktreeDir = join(f.base, `delete-update-${name.replace(/ /g, '-')}`);
    assert.throws(() => prepareAdoption({ root, releaseDir: f.releaseDir, expectedDigest: f.release.manifestDigest, branch: `update-${name.replace(/ /g, '-')}`, worktreeDir }), /records install prefix application, but its managed files and layout do not rebuild the release manifest/, name);
    assert.equal(existsSync(worktreeDir), false, name); assert.equal(readFileSync(join(root, 'application/factory/keep.txt'), 'utf8'), bytes, name);
    assert.throws(() => adoptionStatus({ root }), /do not rebuild the release manifest/, name);
  }
  assert.ok(realLock.layout?.templateFiles?.length && realLock.layout.compatibility, 'a prefixed lock carries its layout evidence');
  // Continuity with history: on a genuine installation, a later hand edit of the prefix is refused.
  merge(f.root, genuine); const third = next(f, '1.2.0');
  const lockPath = join(f.root, 'factotum.lock.json'), moved = { ...realLock, prefix: 'application' };
  writeFileSync(lockPath, JSON.stringify(moved, null, 2) + '\n'); commit(f.root, 'Hand-edited prefix');
  assert.throws(() => adoptionPlan({ root: f.root, releaseDir: third.releaseDir, expectedDigest: third.expectedDigest }), /changed its install prefix since [0-9a-f]{12} adopted 1\.1\.0 \(tools\/factotum to application\)/);
  git(f.root, ['revert', '--no-edit', 'HEAD']); assert.equal(adoptionStatus({ root: f.root }).clean, true, 'restoring the adoption lock recovers');
  // A lock that names a new release but moves the prefix at the same time is refused too.
  const thirdLock = JSON.parse(readFileSync(join(prepareAdoption({ ...third, root: f.root }).worktree, 'factotum.lock.json'), 'utf8'));
  writeFileSync(lockPath, JSON.stringify({ ...thirdLock, prefix: 'application' }, null, 2) + '\n'); commit(f.root, 'Adoption that moves the prefix');
  assert.throws(() => adoptionStatus({ root: f.root }), /changed its install prefix: [0-9a-f]{12} adopted 1\.1\.0 under tools\/factotum, the lock now says application/);
  // A root installation whose managed files are later forged (same release) is refused too.
  const r = fixture(t); git(r.root, ['rm', '-q', 'VERSION']); commit(r.root); merge(r.root, prepareAdoption(r.options));
  put(r.root, 'factory/keep.txt', bytes); const rootLock = JSON.parse(readFileSync(join(r.root, 'factotum.lock.json'), 'utf8'));
  rootLock.managedFiles.push({ path: 'factory/keep.txt', sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o644 });
  writeFileSync(join(r.root, 'factotum.lock.json'), JSON.stringify(rootLock, null, 2) + '\n'); commit(r.root, 'Forged managed entry');
  const rnext = next(r);
  // dev.87: the root lock's layout evidence refuses it on its own, history or not.
  assert.throws(() => prepareAdoption({ ...rnext, root: r.root }), /managed files and layout do not rebuild the release manifest it names \(1\.0\.0, /);
  assert.throws(() => adoptionStatus({ root: r.root, history: false }), /do not rebuild the release manifest/);
  // With the evidence stripped as well, the history walk still finds the lock differs from its adoption commit.
  const { rootLayout, ...stripped } = rootLock; writeFileSync(join(r.root, 'factotum.lock.json'), JSON.stringify(stripped, null, 2) + '\n'); commit(r.root, 'Forged and stripped');
  assert.throws(() => prepareAdoption({ ...rnext, root: r.root }), /changed its managed files since [0-9a-f]{12} adopted 1\.0\.0, without adopting a release/);
  assert.ok(existsSync(join(r.root, 'factory/keep.txt'))); assert.equal(existsSync(rnext.worktreeDir), false);
  // Fail closed: an unreadable lock stops status, plan and the service-unit check.
  writeFileSync(join(r.root, 'factotum.lock.json'), '{ not json'); commit(r.root, 'Broken lock');
  assert.throws(() => adoptionStatus({ root: r.root }), /unreadable or not valid JSON/);
  assert.throws(() => adoptionPlan({ root: r.root, releaseDir: rnext.releaseDir, expectedDigest: rnext.expectedDigest }), /unreadable or not valid JSON/);
  const unitDir = join(r.base, 'units'); mkdirSync(unitDir); writeFileSync(join(unitDir, 'factotum-project-abcdef12.service'), 'ExecStart=/usr/bin/node x\n');
  assert.match(unitDiagnostics({ projectId: 'abcdef1234567890', root: r.root }, join(r.base, 'state'), { unitDir })[0], /cannot be checked: factotum\.lock\.json is unreadable/);
});

test('workflow ownership follows the recorded prefix, and printed commands quote paths', t => {
  const f = sandbox(t), workflow = JSON.stringify(rehearsalWorkflow([process.execPath, '-e', '1']));
  const catalog = (root, path) => compileCatalog({ workflows: { definitions: { custom: { path } }, selection: { default: 'custom' } } }, root);
  // Prefix tools/factotum: a root factory/ folder is the project's own.
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX })); put(f.root, 'factory/flow.json', workflow); put(f.root, `${PREFIX}/factory/flow.json`, workflow);
  assert.doesNotThrow(() => catalog(f.root, 'factory/flow.json'));
  assert.throws(() => catalog(f.root, `${PREFIX}/factory/flow.json`), /outside the upgrade-owned tools\/factotum\/factory\//);
  // Prefix factory: the seeded project folder is factory/project/, and only factory/factory/ is upgrade-owned.
  writeFileSync(join(f.root, 'factotum.lock.json'), JSON.stringify({ formatVersion: 1, prefix: 'factory' })); put(f.root, 'factory/project/workflows/flow.json', workflow); put(f.root, 'factory/factory/flow.json', workflow);
  assert.doesNotThrow(() => catalog(f.root, 'factory/project/workflows/flow.json'));
  assert.throws(() => catalog(f.root, 'factory/factory/flow.json'), /outside the upgrade-owned factory\/factory\//);
  // No lock: the root factory/ is upgrade-owned, as before.
  rmSync(join(f.root, 'factotum.lock.json'));
  assert.throws(() => catalog(f.root, 'factory/flow.json'), /outside the upgrade-owned factory\//);
  // The printed cleanup command survives a checkout path with spaces.
  const g = fixture(t, { rootName: 'app with space' });
  const prepared = prepareAdoption({ ...g.options, prefix: PREFIX });
  assert.ok(prepared.cleanup.includes(`adopt cleanup --root '${g.root}' --branch chore/install --worktree ${g.options.worktreeDir}`), prepared.cleanup);
});

// Review round 2: commits made in the builder's worktree, history resets, and odd lock files.
const gitc = (root, args) => git(root, ['-c', 'commit.gpgsign=false', ...args]);
test('builder protection covers commits made in the worktree, not only uncommitted changes (re-check repro 1)', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX }, null, 2) + '\n'); put(f.root, `${PREFIX}/factory/cli.mjs`, '// managed\n'); commit(f.root);
  const attempt = builderAttempt(f), lockRefusal = /never by a builder \(also not in commits made in the worktree\)/;
  // The re-check repro: commit the lock's deletion, then commit it recreated with another prefix (and a copy of the core).
  await assert.rejects(attempt('precommitted', w => {
    const lock = JSON.parse(readFileSync(join(w, 'factotum.lock.json'), 'utf8'));
    gitc(w, ['rm', '-q', 'factotum.lock.json']); gitc(w, ['commit', '-qm', 'Remove lock']);
    put(w, 'factotum.lock.json', JSON.stringify({ ...lock, prefix: 'elsewhere' }, null, 2) + '\n'); cpSync(join(w, PREFIX), join(w, 'elsewhere'), { recursive: true });
    gitc(w, ['add', '.']); gitc(w, ['commit', '-qm', 'Recreate lock elsewhere']);
  }), lockRefusal);
  // A committed core edit with nothing left uncommitted, and one that deletes then restores different bytes.
  await assert.rejects(attempt('core-commit', w => { put(w, `${PREFIX}/factory/cli.mjs`, '// builder\n'); gitc(w, ['commit', '-qam', 'Edit core']); }), /factory changes need explicit installation policy.*changed: tools\/factotum\/factory\)/);
  await assert.rejects(attempt('version-commit', w => { put(w, `${PREFIX}/VERSION`, 'forged\n'); gitc(w, ['add', '.']); gitc(w, ['commit', '-qm', 'Add VERSION']); }), /changed: tools\/factotum\/VERSION\)/);
  // An edit committed and then reverted in the worktree leaves the core as it was, but the candidate's
  // own history still changes it: refused since the protection follow-ups (F2), allowed under policy.
  const reverted = w => { put(w, `${PREFIX}/factory/cli.mjs`, '// builder\n'); gitc(w, ['commit', '-qam', 'Edit core']); gitc(w, ['revert', '--no-edit', 'HEAD']); put(w, 'notes.md', 'Work\n'); };
  await assert.rejects(attempt('reverted', reverted), /factory changes need explicit installation policy: commit [0-9a-f]{12}, which is not in the workspace base, changes tools\/factotum\/factory/);
  assert.equal((await attempt('reverted-allowed', reverted, { allowFactoryEdits: true })).route, 'committed');
  // The pre-existing root factory/ protection had the same gap (it read only git status); it is closed too.
  const g = sandbox(t); git(g.root, ['config', 'commit.gpgsign', 'false']); put(g.root, 'factory/cli.mjs', '// root core\n'); commit(g.root);
  await assert.rejects(builderAttempt(g)('root-core-commit', w => { put(w, 'factory/cli.mjs', '// builder\n'); gitc(w, ['commit', '-qam', 'Edit core']); }), /changed: factory\)/);
  await assert.rejects(builderAttempt(g)('root-new-lock', w => { put(w, 'factotum.lock.json', '{}'); gitc(w, ['add', '.']); gitc(w, ['commit', '-qm', 'Add lock']); }), lockRefusal);
  // The target's own change to the lock, merged by the factory's recorded integration, is not the builder's.
  const before = git(g.root, ['rev-parse', 'HEAD']);
  put(g.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1 }) + '\n'); put(g.root, 'factory/cli.mjs', '// upgraded core\n'); commit(g.root, 'Adopt on the target');
  const target = git(g.root, ['rev-parse', 'HEAD']); git(g.root, ['reset', '-q', '--hard', before]);
  const merged = w => { gitc(w, ['merge', '-q', '--no-edit', target]); put(w, 'notes.md', 'Work\n'); };
  assert.equal((await builderAttempt(g)('integrated', merged, undefined, { integrate: { base: target } })).route, 'committed');
  await assert.rejects(builderAttempt(g)('unrecorded-merge', merged), lockRefusal, 'a merge the factory did not record is the builder\'s change');
});

test('a deleted or recreated lock fails closed instead of resetting continuity (re-check repro 2)', t => {
  const f = fixture(t); merge(f.root, prepareAdoption({ ...f.options, prefix: PREFIX }));
  const bytes = 'application data\n'; put(f.root, 'factory/keep.txt', bytes); commit(f.root, 'Application data');
  const lock = JSON.parse(readFileSync(join(f.root, 'factotum.lock.json'), 'utf8')), update = next(f);
  // The re-check repro: delete the lock in one commit, recreate a root lock with a forged entry in the next.
  gitc(f.root, ['rm', '-q', 'factotum.lock.json']); gitc(f.root, ['commit', '-qm', 'Remove lock']);
  // Without a lock, the runtime refuses rather than falling back to the root layout.
  assert.throws(() => readInstallLock(f.root), /factotum\.lock\.json is missing, but this repository's history has one/);
  assert.throws(() => installPrefix(f.root), /history has one/);
  assert.throws(() => prepareAdoption({ ...f.options, branch: 'chore/reinstall', worktreeDir: join(f.base, 'reinstall') }), /history already has factotum\.lock\.json .* treated as tampering/);
  const { prefix, layout, ...rootLock } = lock; rootLock.managedFiles = [{ path: 'factory/keep.txt', sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o644 }];
  writeFileSync(join(f.root, 'factotum.lock.json'), JSON.stringify(rootLock, null, 2) + '\n'); commit(f.root, 'Recreate lock');
  assert.throws(() => adoptionStatus({ root: f.root }), /was deleted in [0-9a-f]{12}; a deleted adoption lock is treated as tampering, even if it was recreated/);
  assert.throws(() => prepareAdoption(update), /was deleted in [0-9a-f]{12}/);
  assert.equal(existsSync(update.worktreeDir), false); assert.equal(readFileSync(join(f.root, 'factory/keep.txt'), 'utf8'), bytes);
  // Recreating it identically does not help either; only restoring history (here, reverting both commits) does.
  writeFileSync(join(f.root, 'factotum.lock.json'), JSON.stringify(lock, null, 2) + '\n'); commit(f.root, 'Recreate identical lock');
  assert.throws(() => adoptionStatus({ root: f.root }), /was deleted in/);
  // Anchored on the adoption commit, not the nearest lock: a later same-release rewrite is refused.
  const g = fixture(t); merge(g.root, prepareAdoption({ ...g.options, prefix: PREFIX }));
  const genuine = JSON.parse(readFileSync(join(g.root, 'factotum.lock.json'), 'utf8'));
  writeFileSync(join(g.root, 'factotum.lock.json'), JSON.stringify({ ...genuine, prefix: 'application' }, null, 2) + '\n'); commit(g.root, 'Edit one');
  writeFileSync(join(g.root, 'factotum.lock.json'), JSON.stringify({ ...genuine, prefix: 'application' }) + '\n'); commit(g.root, 'Edit two');
  assert.throws(() => adoptionStatus({ root: g.root }), /changed its install prefix since [0-9a-f]{12} adopted 1\.0\.0 \(tools\/factotum to application\)/);
});

test('a lock that is a symlink, a folder or unreadable fails closed (re-check finding 2)', t => {
  const f = sandbox(t), lockPath = join(f.root, 'factotum.lock.json'), project = { projectId: 'abcdef1234567890', name: 'Fictional', root: f.root };
  put(f.root, 'factory/cli.mjs', '');
  symlinkSync(join(f.base, 'missing-target.json'), lockPath);
  for (const read of [() => readInstallLock(f.root), () => installPrefix(f.root), () => projectUnit({ project, stateDir: f.stateDir })]) assert.throws(read, /not a regular file/);
  const unitDir = join(f.base, 'units'); mkdirSync(unitDir); writeFileSync(join(unitDir, 'factotum-project-abcdef12.service'), 'ExecStart=/usr/bin/node x\n');
  assert.match(unitDiagnostics(project, f.stateDir, { unitDir })[0], /cannot be checked: factotum\.lock\.json is not a regular file/);
  writeFileSync(join(f.base, 'missing-target.json'), JSON.stringify({ formatVersion: 1, prefix: PREFIX }));
  assert.throws(() => installPrefix(f.root), /not a regular file/, 'a symlink to a valid lock is refused too');
  rmSync(lockPath); mkdirSync(lockPath); assert.throws(() => installPrefix(f.root), /not a regular file/);
  rmSync(lockPath, { recursive: true }); writeFileSync(lockPath, '{}', { mode: 0o000 });
  if (process.getuid?.() !== 0) assert.throws(() => installPrefix(f.root), /unreadable/);
  rmSync(lockPath); assert.equal(installPrefix(f.root), '', 'absent, with no lock in history, is no lock');
});

// Review round 3: the shared Git directory is builder-writable, so nothing in it may change what
// the checks see: replace refs, grafts, rewritten objects, config, attributes, odd tree entries.
const verifiedGit = () => import('../starter/factory/core/verified-git.mjs').catch(() => null);
const prefixedSandbox = t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX }, null, 2) + '\n'); put(f.root, `${PREFIX}/factory/cli.mjs`, '// managed\n'); commit(f.root);
  return f;
};
const lockRefusalAny = /factotum\.lock\.json is changed only by adopt install\/update|replacement refs|grafts file|does not match its id/;

test('replacement refs cannot make a changed lock or core match the workspace base (round 3, replace refs)', async t => {
  const f = prefixedSandbox(t), base = git(f.root, ['rev-parse', 'HEAD']);
  // The reviewer's attack: the builder commits a changed lock, then replaces the recorded base commit with it.
  await assert.rejects(builderAttempt(f)('replace-base', w => {
    put(w, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: 'elsewhere' })); gitc(w, ['commit', '-qam', 'Retarget']);
    gitc(w, ['replace', base, git(w, ['rev-parse', 'HEAD'])]);
  }), /replacement refs \(refs\/replace\//);
  assert.equal(installPrefix(f.root), PREFIX);
  // Even with the refusal set aside, verified reads see the real base, not its replacement.
  const verified = await verifiedGit(); assert.ok(verified, 'verified object reads exist');
  const objects = new verified.VerifiedObjects(f.root), genuine = objects.identity(base, 'factotum.lock.json');
  assert.match(genuine, /^100644 [0-9a-f]{40} factotum\.lock\.json$/);
  assert.equal(genuine.split(' ')[1], git(f.root, ['-c', 'core.useReplaceRefs=false', 'rev-parse', `${base}:factotum.lock.json`]));
  assert.notEqual(git(f.root, ['rev-parse', `${base}:factotum.lock.json`]), genuine.split(' ')[1], 'plain Git follows the replacement');
});

test('a rewritten object file cannot make a changed lock match the workspace base (round 3, object store)', async t => {
  const f = prefixedSandbox(t), base = git(f.root, ['rev-parse', 'HEAD']);
  await assert.rejects(builderAttempt(f)('rewrite-object', w => {
    put(w, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: 'elsewhere' })); gitc(w, ['commit', '-qam', 'Retarget']);
    // Overwrite the base commit's loose object with the builder's commit content under the base id.
    const forged = execFileSync('git', ['cat-file', 'commit', 'HEAD'], { cwd: w }), file = join(f.root, git(f.root, ['rev-parse', '--git-path', 'objects']), base.slice(0, 2), base.slice(2));
    execFileSync('chmod', ['u+w', file]); writeFileSync(file, zlib.deflateSync(Buffer.concat([Buffer.from(`commit ${forged.length}\0`), forged])));
    assert.equal(git(w, ['rev-parse', `${base}:factotum.lock.json`]), git(w, ['rev-parse', 'HEAD:factotum.lock.json']), 'plain Git now reads the forged base');
  }), /Git object [0-9a-f]{40} does not match its id/);
});

test('grafts and replacement grafts cannot hide a lock deletion from the history walk (round 3, grafts)', async t => {
  for (const how of ['grafts file', 'replace --graft']) {
    const f = fixture(t); merge(f.root, prepareAdoption({ ...f.options, prefix: PREFIX }));
    const bytes = 'application data\n'; put(f.root, 'factory/keep.txt', bytes); commit(f.root, 'Application data');
    const lock = JSON.parse(readFileSync(join(f.root, 'factotum.lock.json'), 'utf8')), beforeDeletion = git(f.root, ['rev-parse', 'HEAD']), update = next(f);
    gitc(f.root, ['rm', '-q', 'factotum.lock.json']); gitc(f.root, ['commit', '-qm', 'Remove lock']);
    const { prefix, layout, ...rootLock } = lock; rootLock.managedFiles = [{ path: 'factory/keep.txt', sha256: createHash('sha256').update(bytes).digest('hex'), mode: 0o644 }];
    writeFileSync(join(f.root, 'factotum.lock.json'), JSON.stringify(rootLock, null, 2) + '\n'); commit(f.root, 'Recreate lock');
    const recreated = git(f.root, ['rev-parse', 'HEAD']);
    // Hide the deletion: make the recreation's parent the commit before it.
    if (how === 'grafts file') writeFileSync(join(f.root, '.git/info/grafts'), `${recreated} ${beforeDeletion}\n`);
    else gitc(f.root, ['replace', '--graft', recreated, beforeDeletion]);
    assert.equal(git(f.root, ['log', '--format=%s', '-3']).includes('Remove lock'), false, `${how}: plain Git no longer shows the deletion`);
    const refusal = how === 'grafts file' ? /grafts file/ : /replacement refs/;
    assert.throws(() => adoptionStatus({ root: f.root }), refusal, how);
    assert.throws(() => prepareAdoption(update), refusal, how);
    assert.equal(existsSync(update.worktreeDir), false, how); assert.equal(readFileSync(join(f.root, 'factory/keep.txt'), 'utf8'), bytes, how);
    // With the lock removed again, the runtime's history lookup refuses too instead of reading no lock.
    rmSync(join(f.root, 'factotum.lock.json')); assert.throws(() => readInstallLock(f.root), refusal, `${how}: the runtime refuses too`); git(f.root, ['checkout', '--', 'factotum.lock.json']);
  }
});

test('config, hooks, attributes, filters, symlinks, case variants and submodules cannot get a core change past the checks (round 3)', async t => {
  const f = prefixedSandbox(t), attempt = builderAttempt(f), headCore = () => git(f.root, ['rev-parse', `HEAD:${PREFIX}/factory`]);
  const coreRefusal = /factory changes need explicit installation policy/;
  // A clean filter (configured through an include file) that rewrites the core when the factory stages it.
  await assert.rejects(attempt('filter', w => {
    put(w, 'filter.config', '[filter "evil"]\n\tclean = sed s/managed/evil/\n'); gitc(w, ['config', 'include.path', join(w, 'filter.config')]);
    put(w, '.gitattributes', `${PREFIX}/factory/** filter=evil\n`); execFileSync('touch', ['-d', '2001-01-01', join(w, PREFIX, 'factory/cli.mjs')]);
  }), coreRefusal);
  gitc(f.root, ['config', '--unset', 'include.path']);
  // A hook path with a pre-commit hook that edits and stages the core: either hooks do not run for the
  // factory's commit, or the commit it produces is refused and undone; the core never changes.
  const hooks = join(f.base, 'hooks'); mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\necho '// hook' > ${PREFIX}/factory/cli.mjs\ngit add ${PREFIX}/factory/cli.mjs\n`, { mode: 0o755 });
  const core = headCore();
  try { const result = await attempt('hook', w => { gitc(w, ['config', 'core.hooksPath', hooks]); put(w, 'notes.md', 'Work\n'); }); assert.equal(git(join(f.stateDir), ['-C', result.workspace?.path ?? f.root, 'rev-parse', `${result.head}:${PREFIX}/factory`]), core); }
  catch (error) { assert.match(error.message, coreRefusal); }
  gitc(f.root, ['config', '--unset', 'core.hooksPath']);
  // core.worktree pointing the project checkout elsewhere is refused by every adoption command.
  // (Linked builder worktrees ignore it; the checks there read objects, not the worktree.)
  // A symlink where a prefix folder belongs, a case variant of the lock or the folder, and a submodule at the prefix.
  await assert.rejects(attempt('symlink', w => { cpSync(join(w, 'tools'), join(w, 'real-tools'), { recursive: true }); put(w, `real-tools/factotum/factory/cli.mjs`, '// changed\n'); gitc(w, ['rm', '-rq', 'tools']); symlinkSync('real-tools', join(w, 'tools')); gitc(w, ['add', '-A']); gitc(w, ['commit', '-qm', 'Symlink']); }), coreRefusal);
  await assert.rejects(attempt('case-lock', w => { put(w, 'Factotum.Lock.Json', JSON.stringify({ formatVersion: 1, prefix: 'elsewhere' })); }), /factotum\.lock\.json is changed only by adopt install\/update/);
  await assert.rejects(attempt('case-folder', w => { put(w, `${PREFIX.toUpperCase()}/FACTORY/cli.mjs`, '// shadow\n'); }), coreRefusal);
  await assert.rejects(attempt('submodule', w => { gitc(w, ['rm', '-rq', PREFIX]); gitc(w, ['update-index', '--add', '--cacheinfo', `160000,${git(w, ['rev-parse', 'HEAD'])},${PREFIX}`]); gitc(w, ['commit', '-qm', 'Submodule']); }), coreRefusal);
  assert.equal(headCore(), core, 'the project checkout core never changed');
});

test('adoption refuses core.worktree redirection, a submodule at the prefix and a shallow history (round 3)', t => {
  const f = fixture(t); merge(f.root, prepareAdoption({ ...f.options, prefix: PREFIX }));
  // core.worktree in the shared config would point Git at another checkout.
  const elsewhere = join(f.base, 'elsewhere'); mkdirSync(elsewhere); gitc(f.root, ['config', 'core.worktree', elsewhere]);
  assert.throws(() => adoptionStatus({ root: f.root }), /Git checkout root/);
  gitc(f.root, ['config', '--unset', 'core.worktree']); assert.equal(adoptionStatus({ root: f.root }).clean, true);
  // A shallow clone cannot show the whole history, so the continuity check refuses it.
  const shallow = join(f.base, 'shallow'); execFileSync('git', ['clone', '-q', '--depth', '1', `file://${f.root}`, shallow]);
  assert.throws(() => adoptionStatus({ root: shallow }), /shallow clone/);
  // A submodule (gitlink) at the prefix keeps installed files out of the adoption commit; refused even when not checked out.
  const g = fixture(t); mkdirSync(join(g.root, 'vendor/factotum'), { recursive: true }); gitc(g.root, ['update-index', '--add', '--cacheinfo', `160000,${git(g.root, ['rev-parse', 'HEAD'])},vendor/factotum`]); gitc(g.root, ['commit', '-qm', 'Submodule']);
  assert.equal(existsSync(join(g.root, 'vendor/factotum/.git')), false);
  assert.throws(() => prepareAdoption({ ...g.options, prefix: 'vendor/factotum/core' }), /inside a submodule: vendor\/factotum/);
  assert.equal(existsSync(g.options.worktreeDir), false);
});

// Review round 4: merges, the undo, shallow lock-less projects, the live checkout after an upgrade
// merge, doctor's drift check, and the never-adopted message.
const verifiedDistribution = () => import('../starter/factory/distribution.mjs');
function upgradeOnTarget(t) {
  const f = prefixedSandbox(t); put(f.root, 'app.txt', 'base\n'); commit(f.root, 'App');
  const base = git(f.root, ['rev-parse', 'HEAD']);
  // The target gains an upgrade (lock and core) and an app change; the project checkout stays at base.
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX, note: 'upgraded' }, null, 2) + '\n');
  put(f.root, `${PREFIX}/factory/cli.mjs`, '// upgraded core\n'); put(f.root, 'app.txt', 'target\n'); commit(f.root, 'Upgrade on the target');
  const target = git(f.root, ['rev-parse', 'HEAD']); git(f.root, ['reset', '-q', '--hard', base]);
  return { f, base, target };
}
// The builder edits app.txt, the factory's merge of the target conflicts there, and the builder resolves it.
const conflictedMerge = (target, extra = () => {}) => w => {
  put(w, 'app.txt', 'builder\n'); gitc(w, ['commit', '-qam', 'Builder change']);
  assert.throws(() => gitc(w, ['merge', '-q', '--no-edit', target]));
  put(w, 'app.txt', 'resolved\n'); gitc(w, ['add', 'app.txt']); extra(w);
};
const parentsOf = (root, commit) => git(root, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);

test('a conflicted integration whose target carries an upgrade commits as a merge (round 4, finding 1)', async t => {
  const { f, target } = upgradeOnTarget(t);
  const result = await builderAttempt(f)('merge', conflictedMerge(target), undefined, { integrate: { base: target } });
  assert.equal(result.route, 'committed');
  assert.equal(parentsOf(f.root, result.head).length, 2, 'the commit concludes the merge'); assert.ok(parentsOf(f.root, result.head).includes(target));
  assert.equal(git(f.root, ['rev-parse', `${result.head}:factotum.lock.json`]), git(f.root, ['rev-parse', `${target}:factotum.lock.json`]));
  // The same staged lock and core without a recorded integration are the builder's change.
  const g = upgradeOnTarget(t);
  await assert.rejects(builderAttempt(g.f)('unrecorded', conflictedMerge(g.target)), /factotum\.lock\.json is changed only by adopt install\/update/);
});

test('refusing a commit that concluded a merge keeps the merge in progress (round 4, finding 2)', async t => {
  const { f, target } = upgradeOnTarget(t), attempt = builderAttempt(f), integrate = { integrate: { base: target } };
  await assert.rejects(attempt('merge', conflictedMerge(target, w => { put(w, `${PREFIX}/factory/cli.mjs`, '// builder edit during the merge\n'); gitc(w, ['add', '.']); }), undefined, integrate), /factory changes need explicit installation policy.*changed: tools\/factotum\/factory\)/);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId: 'merge', baseRef: 'HEAD' });
  assert.equal(git(workspace.path, ['rev-parse', 'MERGE_HEAD']), target, 'MERGE_HEAD is restored');
  assert.equal(git(workspace.path, ['log', '-1', '--format=%s']), 'Builder change', 'the refused merge commit is undone');
  assert.match(readFileSync(git(workspace.path, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_MSG']), 'utf8'), /Merge/);
  // The builder restores the target's core; the retry concludes the merge with both parents.
  const retry = await attempt('merge', w => gitc(w, ['checkout', target, '--', `${PREFIX}/factory/cli.mjs`]), undefined, integrate);
  assert.equal(retry.route, 'committed'); assert.deepEqual(parentsOf(f.root, retry.head).length, 2); assert.ok(parentsOf(f.root, retry.head).includes(target));
});

test('a project without a lock works in a shallow clone; one whose visible history had a lock does not (round 4, finding 6)', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']); put(f.root, 'factory/cli.mjs', '// root core\n'); commit(f.root);
  const parent = git(f.root, ['rev-parse', 'HEAD']); put(f.root, 'notes.md', 'More\n'); commit(f.root);
  writeFileSync(join(f.root, '.git/shallow'), `${parent}\n`); assert.equal(git(f.root, ['rev-parse', '--is-shallow-repository']), 'true');
  assert.equal(readInstallLock(f.root), null); assert.equal(installPrefix(f.root), '');
  assert.equal((await builderAttempt(f)('shallow', w => put(w, 'work.md', 'Work\n'))).route, 'committed');
  await assert.rejects(builderAttempt(f)('shallow-core', w => put(w, 'factory/cli.mjs', '// changed\n')), /factory changes need explicit installation policy/);
  // A lock deleted within the visible history is still refused.
  const g = sandbox(t); git(g.root, ['config', 'commit.gpgsign', 'false']); put(g.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1 })); commit(g.root);
  const withLock = git(g.root, ['rev-parse', 'HEAD']); gitc(g.root, ['rm', '-q', 'factotum.lock.json']); gitc(g.root, ['commit', '-qm', 'Remove lock']);
  writeFileSync(join(g.root, '.git/shallow'), `${withLock}\n`);
  assert.throws(() => readInstallLock(g.root), /missing, but this repository's history has one/);
  // With a lock, a shallow clone runs; adoption commands need the whole history; doctor's files-only check does not.
  const h = fixture(t); merge(h.root, prepareAdoption({ ...h.options, prefix: PREFIX }));
  const shallow = join(h.base, 'shallow'); execFileSync('git', ['clone', '-q', '--depth', '1', `file://${h.root}`, shallow]);
  assert.equal(installPrefix(shallow), PREFIX); assert.throws(() => adoptionStatus({ root: shallow }), /shallow clone/);
  const { adoptionDrift } = await verifiedDistribution(); assert.equal(typeof adoptionDrift, 'function');
  assert.deepEqual(adoptionDrift(shallow), []); put(shallow, `${PREFIX}/factory/cli.mjs`, 'Local core patch\n');
  assert.match(adoptionDrift(shallow)[0], /installed Factotum files differ from factotum\.lock\.json .*tools\/factotum\/factory\/cli\.mjs \(locally modified managed file\)/);
});

test('doctor refuses an adopted project whose installed files differ from the lock (round 4, finding 9)', async t => {
  const { doctor } = await import('../starter/factory/workflows/commission.mjs'), { Store, initProject } = await import('../starter/factory/core/store.mjs'), { digest } = await import('../starter/factory/core/contracts.mjs');
  const f = fixture(t); git(f.root, ['rm', '-q', 'VERSION']); put(f.root, 'fixture.txt', 'fictional\n'); commit(f.root); merge(f.root, prepareAdoption({ ...f.options, prefix: PREFIX }));
  const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', 'main']);
  const stateDir = join(f.base, 'state'); initProject({ stateDir, root: f.root, name: 'Fictional', supervisor: 'systemd', workflow: { version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } } });
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/project', account: 'fictional', target: 'main', remote: 'origin' }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { maxFlows: 1 }, checks: [{ id: 'fixture', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], mainChecks: [{ id: 'main', argv: [process.execPath, '-e', "require('node:fs').readFileSync('fixture.txt')"], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, resources: { coordinatorPath: join(f.base, 'host.sqlite') }, backupRoot: join(f.base, 'backups') };
  const store = new Store(stateDir); store.setMeta('config', config); store.setMeta('configDigest', digest(config)); store.close();
  const options = { providerPreflight: async spec => ({ provider: spec.provider, version: 'fictional', billing: { mode: 'subscription' }, capabilities: { structuredOutput: true, readOnly: true } }), forgeTransport: async () => ({ permissions: { push: true } }) };
  const clean = await doctor(stateDir, options); assert.equal(clean.ready, true, JSON.stringify(clean.reasons));
  // A committed, pushed edit to the vendored core: checkout clean and in sync, but not the adopted release.
  put(f.root, `${PREFIX}/factory/cli.mjs`, 'Local core patch\n'); commit(f.root, 'Patch the core'); git(f.root, ['push', '-q', 'origin', 'main']);
  const drifted = await doctor(stateDir, options);
  assert.equal(drifted.ready, false); assert.ok(drifted.reasons.some(reason => /installed Factotum files differ from factotum\.lock\.json \(release 1\.0\.0\): tools\/factotum\/factory\/cli\.mjs \(locally modified managed file\)/.test(reason)), JSON.stringify(drifted.reasons));
});

test('upgrade apply --merge verifies the live checkout after merging (round 4, findings 7 and 9)', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const release = version => { const source = join(f.base, `source-${version}`); starter(source, version); const dir = join(f.base, `release-${version}`); return { dir, ...buildRelease({ sourceDir: source, outputDir: dir, version, allowWorkingTree: true }) }; };
  const one = release('1.0.0'); merge(f.root, prepareAdoption({ root: f.root, releaseDir: one.dir, expectedDigest: one.manifestDigest, branch: 'chore/install', worktreeDir: join(f.base, 'install'), initial: true, prefix: PREFIX }));
  const two = release('1.1.0'), options = { root: f.root, stateDir: f.stateDir, releaseDir: two.dir, expectedDigest: two.manifestDigest, branch: 'chore/factotum-1.1.0', worktreeDir: join(f.base, 'review-1.1.0') };
  const prepared = prepareUpgrade(options); commit(prepared.worktree, 'Adopt 1.1.0');
  // Only the live checkout converts line endings on checkout (per-worktree config, set after the review
  // worktree exists, which copied it), so the merged release lands on disk with bytes that differ from
  // the lock, while the review worktree stays clean.
  git(f.root, ['config', 'extensions.worktreeConfig', 'true']); git(f.root, ['config', '--worktree', 'core.autocrlf', 'true']);
  const cliCalls = [], run = async (binary, args) => binary === 'systemctl' ? { code: args[1] === 'is-active' ? 3 : 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' };
  const result = await mergeUpgrade({ ...options, backupDir: join(f.base, 'backup'), run, runCli: async args => { cliCalls.push(args[0]); return { code: 0, stdout: '{}', stderr: '' }; } });
  assert.equal(result.ok, false);
  const verify = result.steps.find(row => row.step === 'verify');
  assert.ok(verify && verify.ok === false, JSON.stringify(result.steps)); assert.match(verify.error, /installed files differ from 1\.1\.0's lock after the merge: tools\/factotum\/.* \(locally modified managed file\)/);
  assert.deepEqual(cliCalls, [], 'no recommission or doctor ran on the drifted checkout');
});

test('adopt status on a project that never adopted says so; zero-padded folder modes are not a change (round 4, finding 10)', async t => {
  const f = fixture(t), status = command(['adopt', 'status', '--root', f.root]);
  assert.notEqual(status.code, 0); assert.match(status.err, /this project has not adopted Factotum \(no factotum\.lock\.json at its root\); use adopt install/); assert.doesNotMatch(status.err, /restore it/);
  // A tree that stores a folder's mode as 040000 (as some old tools wrote) has the same identity as 40000.
  const verified = await verifiedGit(); assert.ok(verified);
  const g = sandbox(t); git(g.root, ['config', 'commit.gpgsign', 'false']); put(g.root, `${PREFIX}/factory/cli.mjs`, '// core\n'); commit(g.root);
  const head = git(g.root, ['rev-parse', 'HEAD']);
  // Write the zero-padded tree object directly (git mktree would normalise it).
  const entries = execFileSync('git', ['cat-file', 'tree', `${head}^{tree}`], { cwd: g.root }), raw = Buffer.from(entries.toString('latin1').replace(/(^|\0[\s\S]{20})40000 tools\0/, (m, p) => `${p}040000 tools\0`), 'latin1');
  const paddedTree = execFileSync('git', ['hash-object', '-t', 'tree', '-w', '--literally', '--stdin'], { cwd: g.root, input: raw, encoding: 'utf8' }).trim();
  assert.notEqual(paddedTree, git(g.root, ['rev-parse', `${head}^{tree}`]), 'the padded tree is a distinct object');
  const paddedCommit = execFileSync('git', ['commit-tree', paddedTree, '-p', head, '-m', 'Padded'], { cwd: g.root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' } }).trim();
  const objects = new verified.VerifiedObjects(g.root);
  assert.equal(objects.identity(paddedCommit, `${PREFIX}/factory`), objects.identity(head, `${PREFIX}/factory`));
});

// Review round 5: a builder must not be able to hide the recorded target from the ancestry check.
const fastImport = (root, ref, from, count, { date = Math.floor(Date.now() / 1000) - count } = {}) => {
  let stream = '';
  for (let i = 0; i < count; i++) stream += `commit ${ref}\ncommitter F <f@example.invalid> ${date + i} +0000\ndata 7\nfiller\n${i === 0 ? `from ${from}\n` : ''}\n`;
  execFileSync('git', ['fast-import', '--quiet', '--force'], { cwd: root, input: stream }); return git(root, ['rev-parse', ref]);
};
// The builder merges the target, then commits the base's lock and core back on top of the merge.
const revertUpgradeAfterMerge = (base, target) => w => {
  gitc(w, ['merge', '-q', '--no-ff', '--no-edit', target]);
  gitc(w, ['checkout', base, '--', 'factotum.lock.json', `${PREFIX}/factory`]); gitc(w, ['commit', '-qm', 'Carry the base core']);
};
const notContained = /does not contain the recorded target [0-9a-f]{12} that the factory integrated/;
const lockRefused = /factotum\.lock\.json is changed only by adopt install\/update/;

test('a planted shallow file cannot hide the recorded target (round 5, B1 shallow)', async t => {
  const { f, base, target } = upgradeOnTarget(t);
  await assert.rejects(builderAttempt(f)('shallow-hide', w => {
    revertUpgradeAfterMerge(base, target)(w);
    writeFileSync(git(w, ['rev-parse', '--path-format=absolute', '--git-path', 'shallow']), `${git(w, ['rev-parse', 'HEAD'])}\n`);
    assert.equal(git(w, ['rev-list', 'HEAD']).split('\n').length, 1, 'plain Git now sees one commit');
  }, undefined, { integrate: { base: target } }), lockRefused);
});

test('a backdated merge behind thousands of newer commits cannot hide the recorded target (round 5, B1 backdated)', async t => {
  const { f, base, target } = upgradeOnTarget(t);
  await assert.rejects(builderAttempt(f)('backdated', w => {
    // M merges base and target, dated 1980; a side chain of 5,001 recent commits grows from base; J joins them.
    const env = { ...process.env, GIT_AUTHOR_DATE: '315532800 +0000', GIT_COMMITTER_DATE: '315532800 +0000', GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
    const merged = execFileSync('git', ['commit-tree', `${target}^{tree}`, '-p', base, '-p', target, '-m', 'Backdated merge'], { cwd: w, env, encoding: 'utf8' }).trim();
    const side = fastImport(w, 'refs/heads/side-chain', base, 5001);
    const joined = execFileSync('git', ['commit-tree', `${side}^{tree}`, '-p', side, '-p', merged, '-m', 'Join'], { cwd: w, encoding: 'utf8', env: { ...env, GIT_AUTHOR_DATE: '', GIT_COMMITTER_DATE: '' } }).trim();
    gitc(w, ['reset', '-q', '--hard', joined]);
    assert.equal(git(w, ['rev-list', '--max-count=5000', 'HEAD']).split('\n').includes(merged), false, 'the merge is outside the newest 5,000');
  }, undefined, { integrate: { base: target } }), lockRefused);
});

test('thousands of empty commits after the merge cannot hide the recorded target (round 5, B1 depth)', async t => {
  const { f, base, target } = upgradeOnTarget(t);
  await assert.rejects(builderAttempt(f)('deep', w => {
    revertUpgradeAfterMerge(base, target)(w);
    gitc(w, ['reset', '-q', '--hard', fastImport(w, 'refs/heads/deep-chain', git(w, ['rev-parse', 'HEAD']), 5000)]);
  }, undefined, { integrate: { base: target } }), lockRefused);
  // A candidate without the recorded target at all is refused, not compared with the base.
  const g = upgradeOnTarget(t);
  await assert.rejects(builderAttempt(g.f)('no-target', w => put(w, 'work.md', 'Work\n'), undefined, { integrate: { base: g.target } }), notContained);
});

test('a merge whose resolution equals HEAD is concluded with both parents (round 5, N4)', async t => {
  const f = prefixedSandbox(t); put(f.root, 'app.txt', 'base\n'); commit(f.root, 'App');
  const base = git(f.root, ['rev-parse', 'HEAD']); put(f.root, 'app.txt', 'target\n'); commit(f.root, 'Target change');
  const target = git(f.root, ['rev-parse', 'HEAD']); git(f.root, ['reset', '-q', '--hard', base]);
  const result = await builderAttempt(f)('same-as-head', w => { gitc(w, ['merge', '-q', '--no-ff', '--no-commit', target]); gitc(w, ['checkout', 'HEAD', '--', 'app.txt']); assert.equal(git(w, ['diff', '--cached', '--name-only']), ''); }, undefined, { integrate: { base: target } });
  assert.equal(result.route, 'committed'); assert.equal(result.committed, true);
  assert.deepEqual(parentsOf(f.root, result.head), [base, target]);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId: 'same-as-head', baseRef: 'HEAD' });
  assert.throws(() => git(workspace.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']), undefined, 'no merge is left in progress');
});

test('the history cache follows the shallow boundary (round 5, N3)', async t => {
  const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1 })); commit(f.root, 'Lock');
  gitc(f.root, ['rm', '-q', 'factotum.lock.json']); gitc(f.root, ['commit', '-qm', 'Remove lock']); put(f.root, 'notes.md', 'More\n'); commit(f.root, 'More');
  const shallowFile = join(f.root, '.git/shallow');
  writeFileSync(shallowFile, `${git(f.root, ['rev-parse', 'HEAD'])}\n`);
  assert.equal(readInstallLock(f.root), null, 'the boundary hides the deletion');
  rmSync(shallowFile);
  assert.throws(() => readInstallLock(f.root), /missing, but this repository's history has one/, 'without the boundary, the same HEAD is walked again');
});

test('doctor reads the drift check through a symlinked project path (round 5, N1)', async t => {
  const { doctor } = await import('../starter/factory/workflows/commission.mjs'), { Store, initProject } = await import('../starter/factory/core/store.mjs'), { digest } = await import('../starter/factory/core/contracts.mjs');
  const f = fixture(t); git(f.root, ['rm', '-q', 'VERSION']); put(f.root, 'fixture.txt', 'fictional\n'); commit(f.root); merge(f.root, prepareAdoption({ ...f.options, prefix: PREFIX }));
  const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', 'main']);
  const linked = join(f.base, 'linked'); symlinkSync(f.base, linked);
  const stateDir = join(f.base, 'state'); initProject({ stateDir, root: join(linked, 'app'), name: 'Fictional', supervisor: 'systemd', workflow: { version: 1, start: 'done', nodes: { done: { kind: 'end', outcome: 'completed' } } } });
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/project', account: 'fictional', target: 'main', remote: 'origin' }, providers: { planner: { provider: 'codex', model: 'fictional' }, builder: { provider: 'codex', model: 'fictional' }, reviewer: { provider: 'claude', model: 'fictional' } }, policy: { maxFlows: 1 }, checks: [{ id: 'fixture', argv: [process.execPath, '-e', 'process.exit(0)'], timeoutMs: 60000 }], mainChecks: [{ id: 'main', argv: [process.execPath, '-e', "require('node:fs').readFileSync('fixture.txt')"], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, resources: { coordinatorPath: join(f.base, 'host.sqlite') }, backupRoot: join(f.base, 'backups') };
  const store = new Store(stateDir); assert.equal(store.meta('project').root, join(linked, 'app'), 'the stored root keeps the symlinked path'); store.setMeta('config', config); store.setMeta('configDigest', digest(config)); store.close();
  const options = { providerPreflight: async spec => ({ provider: spec.provider, version: 'fictional', billing: { mode: 'subscription' }, capabilities: { structuredOutput: true, readOnly: true } }), forgeTransport: async () => ({ permissions: { push: true } }) };
  const result = await doctor(stateDir, options);
  assert.equal(result.reasons.some(reason => /adoption lock check failed|symlinks/.test(reason)), false, JSON.stringify(result.reasons));
  put(f.root, `${PREFIX}/factory/cli.mjs`, 'Local core patch\n'); commit(f.root, 'Patch'); git(f.root, ['push', '-q', 'origin', 'main']);
  assert.ok((await doctor(stateDir, options)).reasons.some(reason => /installed Factotum files differ .*core\.autocrlf/.test(reason)));
});

// Review round 6: the integrated candidate and the published candidate carry the target's upgrade.
const actionFor = (f, workspace, flowId, operation, results = {}) => ({ version: 1, attemptId: uid(), projectRoot: f.root, cwd: workspace.path, timeoutMs: 60000, synthetic: true, maxCostMicros: 0, action: { operation, workspace, projectId: 'fictional', flowId, stateDir: f.stateDir, artifactDir: join(f.base, `attempt-${flowId}-${operation}`), config: { mode: 'rehearsal', repository: { slug: 'fictional/demo', account: 'fictional', target: 'main', remote: 'origin' } }, task: { id: 'task', title: 'Fictional change', acceptance: ['Persist the candidate'] }, context: { files: [] }, results } });
function upgradeOnRemote(t) {
  const s = upgradeOnTarget(t), remote = join(s.f.base, 'remote.git');
  execFileSync('git', ['init', '--bare', '-q', remote]); git(s.f.root, ['remote', 'add', 'origin', remote]); git(s.f.root, ['push', '-q', 'origin', `${s.target}:refs/heads/main`]);
  return s;
}

test('a builder that merges the target itself and reverts its upgrade is refused at integration (round 6, B2)', async t => {
  const { f, base, target } = upgradeOnRemote(t), flowId = 'premerge';
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: base });
  // The reviewer's scenario: before the factory's first integration, merge the target, check the base's
  // lock and core back out, and commit. With no recorded target the commit is compared with the base.
  gitc(workspace.path, ['merge', '-q', '--no-ff', '--no-edit', target]);
  gitc(workspace.path, ['checkout', base, '--', 'factotum.lock.json', `${PREFIX}/factory`]); gitc(workspace.path, ['commit', '-qm', 'Carry the base core']); put(workspace.path, 'work.md', 'Work\n');
  // Since the protection follow-ups (F2) the commit is refused already: the target's upgrade commit is
  // not in the workspace base, so it is the candidate's own and changes the lock.
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'workspace.commit')), /factotum\.lock\.json is changed only by adopt install\/update, never by a builder: commit [0-9a-f]{12}, which is not in the workspace base, changes factotum\.lock\.json/);
  rmSync(join(workspace.path, 'work.md'));
  // Integration finds the target already merged; the candidate still carries the base's lock and core.
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'workspace.integrate')), /factotum\.lock\.json is changed only by adopt install\/update, never by a builder \(the integrated candidate differs from the target\)/);
  // Publishing that candidate is refused too, with or without a recorded integration.
  const head = git(workspace.path, ['rev-parse', 'HEAD']);
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'forge.publish', { integrate: { base: target, head, conflicts: false } })), /factotum\.lock\.json is changed only by adopt install\/update, never by a builder \(in the candidate to publish\)/);
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'forge.publish')), /forge\.publish needs the factory to have integrated the target first/);
});

test('an ordinary candidate integrates a target that carries an upgrade (round 6, B2 normal use)', async t => {
  const { f, base, target } = upgradeOnRemote(t), flowId = 'ordinary';
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: base });
  put(workspace.path, 'work.md', 'Work\n'); assert.equal((await runAction(actionFor(f, workspace, flowId, 'workspace.commit'))).route, 'committed');
  const integrated = await runAction(actionFor(f, workspace, flowId, 'workspace.integrate'));
  assert.equal(integrated.route, 'integrated'); assert.equal(integrated.base, target);
  assert.equal(git(f.root, ['rev-parse', `${integrated.head}:factotum.lock.json`]), git(f.root, ['rev-parse', `${target}:factotum.lock.json`]));
});

test("doctor's behind-the-target check follows the recorded prefix (round 6, F20)", async t => {
  const { operatorCheckout } = await import('../starter/factory/workflows/commission.mjs');
  const runGit = async (args, { cwd }) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  const setup = lock => {
    const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
    if (lock) put(f.root, 'factotum.lock.json', JSON.stringify(lock) + '\n');
    put(f.root, 'factory/notes.md', 'Project notes\n'); put(f.root, `${PREFIX}/factory/cli.mjs`, '// core\n'); put(f.root, `${PREFIX}/VERSION`, '1.0.0\n'); commit(f.root);
    const remote = join(f.base, 'remote.git'), other = join(f.base, 'other'); execFileSync('git', ['init', '--bare', '-q', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['branch', '-M', 'main']); git(f.root, ['push', '-q', 'origin', 'main']);
    execFileSync('git', ['clone', '-q', '-b', 'main', remote, other]); git(other, ['config', 'user.email', 'o@example.invalid']); git(other, ['config', 'user.name', 'O']); git(other, ['config', 'commit.gpgsign', 'false']);
    const change = path => { put(other, path, `changed ${path}\n`); commit(other, `Change ${path}`); git(other, ['push', '-q', 'origin', 'main']); git(f.root, ['fetch', '-q', 'origin']); };
    return { f, change, check: () => operatorCheckout(runGit, f.root, 'origin', 'main', {}) };
  };
  // Prefixed: the project's own root factory/ is not owned; <prefix>/factory/ and <prefix>/VERSION are.
  const p = setup({ formatVersion: 1, prefix: PREFIX });
  p.change('factory/notes.md'); let result = await p.check();
  assert.equal(result.reason, undefined, JSON.stringify(result)); assert.match(result.warning, /no factory files or configured command files differ/);
  p.change(`${PREFIX}/VERSION`); result = await p.check(); assert.match(result.reason, /including installed factory files \(tools\/factotum\/VERSION\)/);
  const q = setup({ formatVersion: 1, prefix: PREFIX }); q.change(`${PREFIX}/factory/cli.mjs`);
  assert.match((await q.check()).reason, /including installed factory files \(tools\/factotum\/factory\/cli\.mjs\)/);
  // Without a prefix the root factory/ is the installation, as before.
  const r = setup({ formatVersion: 1 }); r.change('factory/notes.md');
  assert.match((await r.check()).reason, /including installed factory files \(factory\/notes\.md\)/);
});

test('the ancestry walk in a real shallow clone reads past nothing and answers correctly (round 6, N2)', async t => {
  const verified = await verifiedGit(), f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const start = git(f.root, ['rev-parse', 'HEAD']), tip = fastImport(f.root, 'refs/heads/long', start, 2100);
  const clone = join(f.base, 'shallow'); execFileSync('git', ['clone', '-q', '--depth', '2000', '--branch', 'long', `file://${f.root}`, clone]);
  const objects = new verified.VerifiedObjects(clone), inside = git(clone, ['rev-parse', 'HEAD~1500']);
  assert.equal(objects.reaches(tip, inside), true);
  const started = Date.now();
  assert.equal(new verified.VerifiedObjects(clone).reaches(tip, start), false, 'a commit beyond the boundary is not shown');
  assert.ok(Date.now() - started < 60000);
});

// Protection follow-ups (docs/changes/dev82-protection-followups.md).
// F1: forge.publish publishes only the head of the last non-conflicting integration, and commissioning
// refuses a graph that can reach forge.publish other than from that integration through input-preserving steps.
test('forge.publish refuses a candidate a builder changed after a stale integration, and a conflicted one (follow-up F1a)', async t => {
  const { f, target } = upgradeOnRemote(t), flowId = 'stale';
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: git(f.root, ['rev-parse', 'HEAD']) });
  put(workspace.path, 'work.md', 'Work\n'); assert.equal((await runAction(actionFor(f, workspace, flowId, 'workspace.commit'))).route, 'committed');
  const integrated = await runAction(actionFor(f, workspace, flowId, 'workspace.integrate'));
  assert.equal(integrated.route, 'integrated'); assert.equal(integrated.base, target);
  // The target moves to T2, a second upgrade, which is fetched into the shared repository.
  const other = join(f.base, 'other'); execFileSync('git', ['clone', '-q', '-b', 'main', join(f.base, 'remote.git'), other]); git(other, ['config', 'user.email', 'o@example.invalid']); git(other, ['config', 'user.name', 'O']); git(other, ['config', 'commit.gpgsign', 'false']);
  put(other, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX, note: 'upgraded twice' }, null, 2) + '\n'); put(other, `${PREFIX}/factory/cli.mjs`, '// second upgrade\n'); commit(other, 'Second upgrade'); git(other, ['push', '-q', 'origin', 'main']);
  const second = git(other, ['rev-parse', 'HEAD']); gitc(workspace.path, ['fetch', '-q', 'origin', 'main']);
  // The builder merges T2 itself, checks T1's lock and core back out, and commits; no new integration is recorded.
  gitc(workspace.path, ['merge', '-q', '--no-edit', second]); gitc(workspace.path, ['checkout', target, '--', 'factotum.lock.json', `${PREFIX}/factory`]); gitc(workspace.path, ['commit', '-qm', 'Keep the first upgrade']);
  assert.equal(git(workspace.path, ['rev-parse', 'HEAD:factotum.lock.json']), git(workspace.path, [`rev-parse`, `${target}:factotum.lock.json`]), 'the candidate matches the recorded target');
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'forge.publish', { integrate: integrated })), /forge\.publish publishes only the candidate the factory has just integrated: HEAD [0-9a-f]{12} is not the head of the last non-conflicting integration \([0-9a-f]{12}\)/);
  // A conflicted integration is never publishable, even at its own head.
  const head = git(workspace.path, ['rev-parse', 'HEAD']);
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'forge.publish', { integrate: { ...integrated, head, conflicts: true } })), /is not the head of the last non-conflicting integration \(it conflicted\)/);
});

test('commissioning refuses a graph that can reach forge.publish without the integration directly before it (follow-up F1b)', t => {
  const root = mkdtempSync(join(tmpdir(), 'fct-publish-graph-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'project/workflows'), { recursive: true });
  const config = { version: 1, mode: 'delivery', repository: { slug: 'fictional/graphs', account: 'fictional', target: 'main' }, providers: { planner: { provider: 'codex', model: 'm' }, builder: { provider: 'codex', model: 'm' }, reviewer: { provider: 'claude', model: 'm' } }, checks: [{ id: 'c', argv: ['true'], timeoutMs: 60000 }], context: { files: [], maxChars: 1000 }, policy: {} };
  const effect = (operation, next, extra = {}) => ({ kind: 'effect', action: { operation }, timeoutMs: 600000, next, onFailure: 'failed', ...extra });
  const ends = { done: { kind: 'end', outcome: 'completed' }, failed: { kind: 'end', outcome: 'failed' }, stopped: { kind: 'end', outcome: 'stopped' } };
  const tail = { review: effect('provider.review', 'gate', { evidence: 'review', resultEdges: { pass: 'gate', revise: 'build', delta: 'gate', defer: 'gate', adjudicate: 'gate', park: 'failed' } }), gate: effect('gate', 'decide', { evidence: 'gate', resultEdges: { pass: 'decide', fail: 'build', blocked: 'failed' } }), decide: { kind: 'question', role: 'operator', question: 'Merge?', requireEvidence: ['review', 'gate'], mergeDecision: true, answers: { merge: 'merge', stop: 'stopped' } }, merge: effect('forge.merge', 'done', { requireDecision: true, resultEdges: { merged: 'done', stale: 'integrate' } }), ...ends };
  // commit -> integrate -> publish, with stale looping back to integrate (integrate routes with next only).
  const typical = { version: 1, start: 'workspace', nodes: { workspace: effect('workspace.prepare', 'build'), build: effect('provider.build', 'commit', { maxVisits: 4 }), commit: effect('workspace.commit', 'integrate'), integrate: effect('workspace.integrate', 'publish', { maxVisits: 6 }), publish: effect('forge.publish', 'review'), ...tail } };
  const compile = (graph, extra = {}) => { writeFileSync(join(root, 'project/workflows/flow.json'), JSON.stringify(graph)); return compileCatalog({ ...config, ...extra, workflows: { definitions: { flow: { path: 'project/workflows/flow.json' } }, selection: { default: 'flow' } } }, root); };
  const variant = change => { const graph = structuredClone(typical); change(graph.nodes, graph); return graph; };
  // Accepted: the reference graphs (with fast checks and a preview too), the typical project graph,
  // adopter shapes, and input-preserving steps of any name between integrate and publish.
  for (const extra of [{}, { fastChecks: { checks: [{ id: 'f', argv: ['true'], timeoutMs: 1000 }] }, preview: { argv: ['true'], timeoutMs: 1000 } }])
    compileCatalog({ ...config, ...extra, workflows: { definitions: { change: { reference: 'change.standard' }, document: { reference: 'change.document' } }, selection: { default: 'change' } } }, root);
  compile(typical);
  compile(variant(nodes => { nodes.workspace = effect('workspace.adopt', 'integrate'); delete nodes.build; delete nodes.commit; nodes.review.resultEdges.revise = 'failed'; nodes.gate.resultEdges.fail = 'failed'; }));
  compile(variant(nodes => { nodes.integrate.resultEdges = { integrated: 'publish', conflict: 'conflict-question' }; nodes['conflict-question'] = { kind: 'question', role: 'operator', question: 'Conflict?', answers: { repair: 'build', retry: 'integrate', stop: 'stopped' } }; }));
  compile(variant(nodes => { nodes.integrate.resultEdges = { integrated: 'house-rules', conflict: 'build' }; nodes['house-rules'] = effect('fastCheck', 'publish', { evidence: 'fast-check:passed', resultEdges: { pass: 'lint', fail: 'build' } }); nodes.lint = { kind: 'effect', argv: ['true'], timeoutMs: 60000, preserveInput: true, next: 'publish', onFailure: 'build' }; }), { fastChecks: { checks: [{ id: 'f', argv: ['true'], timeoutMs: 1000 }] } });
  // Refused: a builder, a question or a command that does not preserve its input between integrate and
  // publish; the conflict route; a failure route; a start at publish; publish with no integration at all.
  const refused = /can reach forge\.publish step publish from (\S+) \(([^)]+)\) without the factory's integration directly before it/;
  const refusedFrom = (graph, from, label) => assert.throws(() => compile(graph), error => { const match = refused.exec(error.message); return Boolean(match) && match[1] === from && match[2] === label; }, `${from} (${label})`);
  refusedFrom(variant(nodes => { nodes.integrate.next = 'polish'; nodes.polish = effect('provider.build', 'publish', { binding: 'build' }); delete nodes.build; nodes.workspace.next = 'commit'; nodes.review.resultEdges.revise = 'commit'; nodes.gate.resultEdges.fail = 'commit'; }), 'polish', 'next');
  refusedFrom(variant(nodes => { nodes.integrate.next = 'confirm'; nodes.confirm = { kind: 'question', role: 'operator', question: 'Publish?', answers: { publish: 'publish', stop: 'stopped' } }; }), 'confirm', 'answer publish');
  refusedFrom(variant(nodes => { nodes.integrate.next = 'touch'; nodes.touch = { kind: 'effect', argv: ['true'], timeoutMs: 60000, next: 'publish', onFailure: 'failed' }; }), 'touch', 'next');
  refusedFrom(variant(nodes => { nodes.integrate.resultEdges = { integrated: 'publish', conflict: 'publish' }; }), 'integrate', 'conflict');
  refusedFrom(variant(nodes => { nodes.integrate.next = 'lint'; nodes.lint = { kind: 'effect', argv: ['true'], timeoutMs: 60000, preserveInput: true, next: 'publish', onFailure: 'publish' }; }), 'lint', 'onFailure');
  refusedFrom(variant(nodes => { nodes.commit.next = 'publish'; nodes.integrate.next = 'publish'; nodes.merge.resultEdges.stale = 'integrate'; }), 'commit', 'next');
  assert.throws(() => compile(variant((nodes, graph) => { graph.start = 'publish'; })), /starts at forge\.publish step publish; add a workspace\.integrate step before it/);
  refusedFrom(variant(nodes => { delete nodes.integrate; nodes.commit.next = 'publish'; nodes.commit.maxVisits = 6; nodes.merge.resultEdges.stale = 'commit'; }), 'commit', 'next');
});

// F2: the candidate's own commits may not change upgrade-owned files, even if a later commit undoes it.
test('a builder cannot neutralise an upgrade branch that is not on the target yet (follow-up F2)', async t => {
  const f = prefixedSandbox(t); put(f.root, 'app.txt', 'base\n'); commit(f.root, 'App');
  const base = git(f.root, ['rev-parse', 'HEAD']), main = git(f.root, ['symbolic-ref', '--short', 'HEAD']);
  // An upgrade review branch exists locally, unmerged; the target is still at base.
  git(f.root, ['checkout', '-qb', 'chore/factotum-upgrade']);
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX, note: 'upgraded' }, null, 2) + '\n'); put(f.root, `${PREFIX}/factory/cli.mjs`, '// upgraded core\n'); commit(f.root, 'Adopt the upgrade');
  const upgrade = git(f.root, ['rev-parse', 'HEAD']); git(f.root, ['checkout', '-q', main]);
  const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `${base}:refs/heads/main`]);
  const flowId = 'neutralise', workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: base });
  // The builder merges the upgrade branch, puts the base's lock and core back and commits: the candidate matches the target.
  gitc(workspace.path, ['merge', '-q', '--no-ff', '--no-edit', upgrade]); gitc(workspace.path, ['checkout', base, '--', 'factotum.lock.json', `${PREFIX}/factory`]); gitc(workspace.path, ['commit', '-qm', 'Keep the old core']);
  assert.equal(git(workspace.path, ['rev-parse', 'HEAD^{tree}']), git(workspace.path, ['rev-parse', `${base}^{tree}`]), 'the candidate has the base tree');
  put(workspace.path, 'work.md', 'Work\n');
  const ownCommit = /factotum\.lock\.json is changed only by adopt install\/update, never by a builder: commit [0-9a-f]{12}, which is not in the (workspace base|recorded target), changes factotum\.lock\.json/;
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'workspace.commit')), ownCommit);
  rmSync(join(workspace.path, 'work.md'));
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'workspace.integrate')), ownCommit);
  const head = git(workspace.path, ['rev-parse', 'HEAD']);
  await assert.rejects(runAction(actionFor(f, workspace, flowId, 'forge.publish', { integrate: { base, head, conflicts: false } })), ownCommit);
  // Why it matters: once such a candidate merges (merge method merge), the upgrade branch reads as merged.
  git(f.root, ['merge', '-q', '--no-ff', '--no-edit', head]);
  assert.match(execFileSync('git', ['merge', '--no-edit', upgrade], { cwd: f.root, encoding: 'utf8' }), /Already up to date/);
  assert.equal(readFileSync(join(f.root, `${PREFIX}/factory/cli.mjs`), 'utf8'), '// managed\n', 'the target kept the old core');
});

test("the candidate's own-history check accepts the factory's merges and an upgrade arriving through integration (follow-up F2 normal use)", async t => {
  // An ordinary candidate: the target carries an upgrade; integrate, then a second builder round and a re-integration.
  const { f, target } = upgradeOnRemote(t), flowId = 'ordinary-rounds', start = git(f.root, ['rev-parse', 'HEAD']);
  const workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: start });
  put(workspace.path, 'work.md', 'Work\n'); assert.equal((await runAction(actionFor(f, workspace, flowId, 'workspace.commit'))).route, 'committed');
  const first = await runAction(actionFor(f, workspace, flowId, 'workspace.integrate'));
  assert.equal(first.route, 'integrated'); assert.equal(first.base, target);
  put(workspace.path, 'more.md', 'More\n'); assert.equal((await runAction(actionFor(f, workspace, flowId, 'workspace.commit', { integrate: first }))).route, 'committed');
  const again = await runAction(actionFor(f, workspace, flowId, 'workspace.integrate', { integrate: first }));
  assert.equal(again.route, 'integrated'); assert.equal(git(f.root, ['rev-parse', `${again.head}:factotum.lock.json`]), git(f.root, ['rev-parse', `${target}:factotum.lock.json`]));
  // A conflicted integration: the builder resolves, the factory's commit concludes the merge, and integration then succeeds.
  const g = upgradeOnRemote(t), conflictFlow = 'conflicted-rounds', gStart = git(g.f.root, ['rev-parse', 'HEAD']);
  const w = await prepare({ root: g.f.root, stateDir: g.f.stateDir, projectId: 'fictional', flowId: conflictFlow, baseRef: gStart });
  put(w.path, 'app.txt', 'builder\n'); assert.equal((await runAction(actionFor(g.f, w, conflictFlow, 'workspace.commit'))).route, 'committed');
  const conflicted = await runAction(actionFor(g.f, w, conflictFlow, 'workspace.integrate'));
  assert.equal(conflicted.route, 'conflict');
  put(w.path, 'app.txt', 'resolved\n'); gitc(w.path, ['add', 'app.txt']);
  const concluded = await runAction(actionFor(g.f, w, conflictFlow, 'workspace.commit', { integrate: conflicted }));
  assert.equal(concluded.route, 'committed'); assert.equal(parentsOf(g.f.root, concluded.head).length, 2);
  const integrated = await runAction(actionFor(g.f, w, conflictFlow, 'workspace.integrate', { integrate: conflicted }));
  assert.equal(integrated.route, 'integrated'); assert.equal(integrated.head, concluded.head);
});

test('upgrade apply --merge says plainly when the upgrade branch is already contained in the checkout (follow-up F2)', async t => {
  const setup = () => {
    const f = sandbox(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
    const release = version => { const source = join(f.base, `source-${version}`); starter(source, version); const dir = join(f.base, `release-${version}`); return { dir, ...buildRelease({ sourceDir: source, outputDir: dir, version, allowWorkingTree: true }) }; };
    const one = release('1.0.0'); merge(f.root, prepareAdoption({ root: f.root, releaseDir: one.dir, expectedDigest: one.manifestDigest, branch: 'chore/install', worktreeDir: join(f.base, 'install'), initial: true, prefix: PREFIX }));
    const two = release('1.1.0'), options = { root: f.root, stateDir: f.stateDir, releaseDir: two.dir, expectedDigest: two.manifestDigest, branch: 'chore/factotum-1.1.0', worktreeDir: join(f.base, 'review-1.1.0') };
    const prepared = prepareUpgrade(options); commit(prepared.worktree, 'Adopt 1.1.0');
    const calls = [], run = async (binary, args) => { calls.push(binary); return binary === 'systemctl' ? { code: args[1] === 'is-active' ? 3 : 0, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }; };
    return { f, options: { ...options, backupDir: join(f.base, 'backup'), run, runCli: async () => { calls.push('cli'); return { code: 0, stdout: '{}', stderr: '' }; } }, calls };
  };
  // A change merged the upgrade branch and restored the old lock and core; the checkout holds 1.0.0.
  const a = setup();
  git(a.f.root, ['merge', '-q', '--no-ff', '--no-edit', a.options.branch]); git(a.f.root, ['checkout', 'HEAD^1', '--', 'factotum.lock.json', PREFIX]); commit(a.f.root, 'Candidate that undid the upgrade');
  assert.equal(adoptionStatus({ root: a.f.root }).version, '1.0.0');
  await assert.rejects(mergeUpgrade(a.options), /the review branch chore\/factotum-1\.1\.0 \([0-9a-f]{12}\) is already contained in the project checkout, but the checkout does not hold release 1\.1\.0 \(its lock names 1\.0\.0\): the upgrade was merged and then undone/);
  assert.deepEqual(a.calls, [], 'nothing was stopped, merged or recommissioned');
  // The branch already merged as intended: nothing to merge, said as such.
  const b = setup();
  git(b.f.root, ['merge', '-q', '--ff-only', b.options.branch]);
  await assert.rejects(mergeUpgrade(b.options), /the review branch chore\/factotum-1\.1\.0 is already merged into the project checkout, which holds 1\.1\.0: there is nothing to merge/);
  // Review fix N4: merged, but an installed file differs from 1.1.0's lock (as after a failed verify).
  put(b.f.root, `${PREFIX}/factory/cli.mjs`, 'Drifted\n'); commit(b.f.root, 'Drift');
  await assert.rejects(mergeUpgrade(b.options), /the review branch chore\/factotum-1\.1\.0 is already merged into the project checkout, which holds 1\.1\.0, but its installed files differ from the lock \(verify failed\): tools\/factotum\/factory\/cli\.mjs/);
  assert.deepEqual(b.calls, []);
});

// F3: the ancestry walk proposes again from the unproposed frontier, so every shape costs a bounded
// number of Git processes, and its answers never depend on the proposals.
function countGit(t) {
  const bin = mkdtempSync(join(tmpdir(), 'fct-git-count-')), log = join(bin, 'count'), real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho >> "$FACTOTUM_TEST_GIT_COUNT"\nexec ${real} "$@"\n`, { mode: 0o755 }); writeFileSync(log, '');
  const before = { PATH: process.env.PATH, count: process.env.FACTOTUM_TEST_GIT_COUNT };
  t.after(() => { process.env.PATH = before.PATH; if (before.count === undefined) delete process.env.FACTOTUM_TEST_GIT_COUNT; else process.env.FACTOTUM_TEST_GIT_COUNT = before.count; rmSync(bin, { recursive: true, force: true }); });
  return fn => { process.env.PATH = `${bin}:${before.PATH}`; process.env.FACTOTUM_TEST_GIT_COUNT = log; writeFileSync(log, ''); try { const value = fn(); return { value, processes: readFileSync(log, 'utf8').length }; } finally { process.env.PATH = before.PATH; } };
}
// History shapes written with fast-import (marks), plus a commit whose parent is absent.
function historyShape(root, build) {
  let stream = '', mark = 0; const now = Math.floor(Date.now() / 1000), future = now + 10 * 365 * 86400, tree = git(root, ['rev-parse', 'HEAD^{tree}']);
  const commitAt = (date, parents, ref = 'refs/heads/shape') => { mark++; stream += `commit ${ref}\nmark :${mark}\ncommitter M <m@example.invalid> ${date} +0000\ndata 1\nc\n${parents.map((p, i) => `${i ? 'merge' : 'from'} ${p}\n`).join('')}\n`; return `:${mark}`; };
  const absentParent = date => execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: root, encoding: 'utf8', input: `tree ${tree}\nparent ${'1'.repeat(40)}\nauthor M <m@example.invalid> ${date} +0000\ncommitter M <m@example.invalid> ${date} +0000\n\nabsent parent\n` }).trim();
  build({ commitAt, absentParent, now, future, start: git(root, ['rev-parse', 'HEAD']) });
  execFileSync('git', ['fast-import', '--quiet', '--force'], { cwd: root, input: stream }); return git(root, ['rev-parse', 'refs/heads/shape']);
}
test('the verified ancestry walk costs a bounded number of Git processes for every history shape (follow-up F3)', async t => {
  const { VerifiedObjects } = await verifiedGit(), f = sandbox(t), count = countGit(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const unrelated = git(f.root, ['commit-tree', git(f.root, ['rev-parse', 'HEAD^{tree}']), '-m', 'Unrelated target']);
  const bounded = (name, root, head, target, expected, setup = () => {}) => {
    const objects = new VerifiedObjects(root); setup(objects);
    const { value, processes } = count(() => objects.reaches(head, target));
    assert.equal(value, expected, `${name}: answer`); assert.ok(processes <= 100, `${name}: ${processes} Git processes`);
  };
  // Linear.
  const linear = historyShape(f.root, ({ commitAt, now, start }) => { let tip = start; for (let i = 0; i < 3000; i++) tip = commitAt(now - 3000 + i, [tip]); });
  bounded('linear', f.root, linear, unrelated, false);
  // The absent-parent shape: a merge 70 commits below the head whose second parent is future-dated and has an absent parent.
  const absent = historyShape(f.root, ({ commitAt, absentParent, now, future, start }) => { let tip = start; for (let i = 0; i < 3000; i++) tip = commitAt(now - 3000 + i, i === 2930 ? [tip, absentParent(future)] : [tip]); });
  bounded('absent parent', f.root, absent, unrelated, false);
  bounded('absent parent, Git without --missing=print for commits', f.root, absent, unrelated, false, objects => { objects.missingPrint = false; });
  bounded('absent parent, found', f.root, absent, git(f.root, ['rev-parse', `${absent}~2500`]), true);
  // The earlier quadratic shape: one future-dated chain from the base, and past-dated merges on the main line each with the chain's tip as second parent.
  const quadratic = historyShape(f.root, ({ commitAt, now, future, start }) => { let chain = start; for (let i = 0; i < 3000; i++) chain = commitAt(future + i, [chain], 'refs/heads/chain'); let tip = start; for (let i = 0; i < 300; i++) tip = commitAt(now - 300 + i, [tip, chain]); });
  bounded('quadratic', f.root, quadratic, unrelated, false);
  // A real two-line shallow clone.
  // Line b is older than all of line a, so a date-ordered listing reaches line a's boundary first.
  const twoLines = historyShape(f.root, ({ commitAt, now, start }) => { let a = start, b = start; for (let i = 0; i < 1500; i++) { a = commitAt(now - 3000 + i, [a], 'refs/heads/line-a'); b = commitAt(now - 9000 + i, [b], 'refs/heads/line-b'); } commitAt(now, [a, b]); });
  const clone = join(f.base, 'shallow'); execFileSync('git', ['clone', '-q', '--depth', '1000', '--branch', 'shape', `file://${f.root}`, clone]);
  bounded('two-line shallow clone', clone, twoLines, git(f.root, ['rev-parse', 'HEAD']), false);
  bounded('two-line shallow clone, Git without --missing=print for commits', clone, twoLines, git(f.root, ['rev-parse', 'HEAD']), false, objects => { objects.missingPrint = false; });
  bounded('two-line shallow clone, found', clone, twoLines, git(clone, ['rev-parse', `${twoLines}^2~900`]), true);
  // Review fixes. N2: an absent parent at the first proposed generation (64 below the head) is never a rev-list start.
  const nearTip = git(f.root, ['rev-parse', `${linear}~100`]);
  const nearMerge = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: f.root, encoding: 'utf8', input: `tree ${git(f.root, ['rev-parse', 'HEAD^{tree}'])}\nparent ${nearTip}\nparent ${'3'.repeat(40)}\nauthor M <m@example.invalid> 1 +0000\ncommitter M <m@example.invalid> 1 +0000\n\nnear\n` }).trim();
  const near = fastImport(f.root, 'refs/heads/near', nearMerge, 63);
  assert.equal(git(f.root, ['rev-list', '--count', '--first-parent', `${nearMerge}..${near}`]), '63');
  bounded('absent parent 64 generations down', f.root, near, unrelated, false);
  bounded('absent parent 64 generations down, Git without --missing=print for commits', f.root, near, unrelated, false, objects => { objects.missingPrint = false; });
  // N1: a garbage loose object where the absent parent's ID belongs (Git reads it as missing; rev-list stops at it, naming nothing).
  const garbage = join(f.root, '.git/objects', '1'.repeat(2), '1'.repeat(38)); mkdirSync(join(garbage, '..'), { recursive: true }); writeFileSync(garbage, 'garbage');
  bounded('absent parent stored as a garbage object', f.root, absent, unrelated, false);
  bounded('absent parent stored as a garbage object, Git without --missing=print for commits', f.root, absent, unrelated, false, objects => { objects.missingPrint = false; });
  rmSync(garbage);
  // B1: a builder-written shallow file that names every commit.
  const deep = git(f.root, ['rev-parse', `${linear}~2900`]), shallowFile = join(f.root, '.git/shallow'); writeFileSync(shallowFile, git(f.root, ['rev-list', linear]) + '\n');
  bounded('a shallow file naming every commit', f.root, linear, unrelated, false);
  bounded('a shallow file naming every commit, Git without --missing=print for commits', f.root, linear, unrelated, false, objects => { objects.missingPrint = false; });
  bounded('a shallow file naming every commit, found', f.root, linear, deep, true);
  rmSync(shallowFile);
  // N7: one unreadable object named as a parent by a merge 70 commits below the tip and by a commit 3 below it.
  const shared = '4'.repeat(40), sharedPath = join(f.root, '.git/objects', shared.slice(0, 2), shared.slice(2));
  const later = Math.floor(Date.now() / 1000) + 1000, sharedMerge = (first, at) => execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: f.root, encoding: 'utf8', input: `tree ${git(f.root, ['rev-parse', 'HEAD^{tree}'])}\nparent ${first}\nparent ${shared}\nauthor M <m@example.invalid> ${at} +0000\ncommitter M <m@example.invalid> ${at} +0000\n\nshared\n` }).trim();
  const sharedTip = fastImport(f.root, 'refs/heads/shared', sharedMerge(fastImport(f.root, 'refs/heads/shared', sharedMerge(linear, later), 66, { date: later + 1 }), later + 100), 3, { date: later + 101 });
  mkdirSync(join(sharedPath, '..'), { recursive: true }); writeFileSync(sharedPath, 'garbage');
  bounded('one unreadable parent shared by two commits', f.root, sharedTip, unrelated, false);
  bounded('one unreadable parent shared by two commits, Git without --missing=print for commits', f.root, sharedTip, unrelated, false, objects => { objects.missingPrint = false; });
  rmSync(sharedPath);
});

// B3: a flow whose base is far behind the target it integrates (a stale flow, a stale adopted pull request).
test('the own-commit split and the dispatch path of a flow far behind its target cost a bounded number of Git processes (review fixes B3, N7)', async t => {
  const { VerifiedObjects } = await verifiedGit(), count = countGit(t), paths = ['factotum.lock.json', `${PREFIX}/factory`];
  const later = Math.floor(Date.now() / 1000) + 1000, dated = (root, at) => ({ cwd: root, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid', GIT_AUTHOR_DATE: `${at} +0000`, GIT_COMMITTER_DATE: `${at} +0000` } });
  // At the level of ownChanges: the factory's merge of a target 600 commits ahead of the fork point.
  const f = prefixedSandbox(t), base = git(f.root, ['rev-parse', 'HEAD']), tree = git(f.root, ['rev-parse', 'HEAD^{tree}']);
  const split = (target, setup = () => {}) => {
    const candidate = execFileSync('git', ['commit-tree', tree, '-p', base, '-m', 'Candidate'], dated(f.root, later + 5000)).trim();
    const merged = execFileSync('git', ['commit-tree', tree, '-p', candidate, '-p', target, '-m', 'Factory merge'], dated(f.root, later + 5001)).trim();
    const objects = new VerifiedObjects(f.root); setup(objects); return count(() => objects.ownChanges(merged, [target], paths));
  };
  const behind = fastImport(f.root, 'refs/heads/behind', base, 600, { date: later });
  for (const [name, setup] of [['current Git', () => {}], ['Git without --missing=print for commits', objects => { objects.missingPrint = false; }]]) {
    const { value, processes } = split(behind, setup); assert.deepEqual(value, []); assert.ok(processes <= 100, `600 behind, ${name}: ${processes} Git processes`);
  }
  // The same with a future-dated side commit whose parent is absent merged into the target 70 commits below its tip.
  const side = execFileSync('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], { cwd: f.root, encoding: 'utf8', input: `tree ${tree}\nparent ${'5'.repeat(40)}\nauthor M <m@example.invalid> ${later + 900000} +0000\ncommitter M <m@example.invalid> ${later + 900000} +0000\n\nside\n` }).trim();
  const sideMerge = execFileSync('git', ['commit-tree', tree, '-p', fastImport(f.root, 'refs/heads/side', base, 530, { date: later }), '-p', side, '-m', 'Side'], dated(f.root, later + 600)).trim();
  const withSide = fastImport(f.root, 'refs/heads/side', sideMerge, 69, { date: later + 601 });
  for (const [name, setup] of [['current Git', () => {}], ['Git without --missing=print for commits', objects => { objects.missingPrint = false; }]]) {
    const { value, processes } = split(withSide, setup); assert.deepEqual(value, []); assert.ok(processes <= 100, `600 behind with an absent side parent, ${name}: ${processes} Git processes`);
  }
  // Through real dispatch: commit, integrate a target 600 commits ahead, commit again, integrate again, publish.
  const { f: g, base: start } = upgradeOnRemote(t), flowId = 'stale-flow';
  const ahead = fastImport(g.root, 'refs/heads/ahead', git(g.root, ['ls-remote', join(g.base, 'remote.git'), 'refs/heads/main']).split(/\s/)[0], 600, { date: later });
  git(g.root, ['push', '-q', 'origin', `${ahead}:refs/heads/main`]);
  const workspace = await prepare({ root: g.root, stateDir: g.stateDir, projectId: 'fictional', flowId, baseRef: start });
  const counted = async (operation, results) => {
    const log = mkdtempSync(join(tmpdir(), 'fct-dispatch-count-')), file = join(log, 'count'); writeFileSync(file, '');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(); writeFileSync(join(log, 'git'), `#!/bin/sh\necho >> "${file}"\nexec ${real} "$@"\n`, { mode: 0o755 });
    const path = process.env.PATH; process.env.PATH = `${log}:${path}`;
    try { let value, error; try { value = await runAction(actionFor(g, workspace, flowId, operation, results)); } catch (caught) { error = caught; } return { value, error, processes: readFileSync(file, 'utf8').length }; }
    finally { process.env.PATH = path; rmSync(log, { recursive: true, force: true }); }
  };
  put(workspace.path, 'work.md', 'Work\n'); const first = await counted('workspace.commit');
  assert.equal(first.value?.route, 'committed', first.error?.message);
  const integrated = await counted('workspace.integrate');
  assert.equal(integrated.value?.route, 'integrated', integrated.error?.message); assert.equal(integrated.value.base, ahead);
  put(workspace.path, 'more.md', 'More\n'); const second = await counted('workspace.commit', { integrate: integrated.value });
  assert.equal(second.value?.route, 'committed', second.error?.message);
  const again = await counted('workspace.integrate', { integrate: integrated.value });
  assert.equal(again.value?.route, 'integrated', again.error?.message);
  // forge.publish passes its checks and pushes; the fictional forge then fails (there is no gh here).
  const published = await counted('forge.publish', { integrate: again.value });
  assert.ok(published.error && !/upgrade-owned|never by a builder|publishes only|does not contain/.test(published.error.message), published.error?.message);
  assert.equal(git(join(g.base, 'remote.git'), ['rev-parse', `refs/heads/${workspace.branch}`]), again.value.head, 'the integrated head was pushed');
  const rows = Object.entries({ commit: first, integrate: integrated, 'second commit': second, 'second integrate': again, publish: published });
  for (const [name, row] of rows) assert.ok(row.processes <= 150, `${name}: ${row.processes} Git processes (${rows.map(([n, r]) => `${n} ${r.processes}`).join(', ')})`);
});

test('the walk and the own-commit split never depend on what rev-list proposes (follow-up F3, F2)', async t => {
  const { VerifiedObjects } = await verifiedGit(), { f, base, target } = upgradeOnTarget(t);
  // The F2 history: an unmerged upgrade merged, then undone.
  git(f.root, ['checkout', '-qb', 'upgrade', base]); put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX, note: 'branch' }) + '\n'); commit(f.root, 'Upgrade branch');
  const upgrade = git(f.root, ['rev-parse', 'HEAD']); git(f.root, ['checkout', '-q', base]);
  gitc(f.root, ['merge', '-q', '--no-ff', '--no-edit', upgrade]); gitc(f.root, ['checkout', base, '--', 'factotum.lock.json']); gitc(f.root, ['commit', '-qm', 'Undo']);
  const head = fastImport(f.root, 'refs/heads/after', git(f.root, ['rev-parse', 'HEAD']), 200), paths = ['factotum.lock.json', `${PREFIX}/factory`];
  const variants = { honest: () => {}, empty: objects => { objects.propose = () => []; }, everything: objects => { const real = objects.propose.bind(objects); objects.propose = starts => real([...starts, target]); }, partial: objects => { const real = objects.propose.bind(objects); objects.propose = (starts, exclude) => real(starts, exclude).slice(0, 5); } };
  for (const [name, setup] of Object.entries(variants)) {
    const objects = new VerifiedObjects(f.root); setup(objects);
    assert.equal(objects.reaches(head, upgrade), true, `${name}: reaches the upgrade branch`); assert.equal(objects.reaches(head, target), false, `${name}: the target is not in the history`);
    const touched = new VerifiedObjects(f.root); setup(touched);
    const rows = touched.ownChanges(head, [base], paths);
    assert.deepEqual([...new Set(rows.map(row => row.path))], ['factotum.lock.json'], `${name}: ${JSON.stringify(rows)}`);
    assert.ok(rows.some(row => row.commit === upgrade), `${name}: the upgrade branch's commit is the candidate's own`);
  }
  // Commits reachable from the trusted commit are not the candidate's own, whatever the proposal claims.
  const merged = git(f.root, ['commit-tree', `${target}^{tree}`, '-p', base, '-p', target, '-m', 'Factory merge']);
  for (const [name, setup] of Object.entries(variants)) { const objects = new VerifiedObjects(f.root); setup(objects); assert.deepEqual(objects.ownChanges(merged, [target], paths), [], name); }
});

// Review fixes: an adopted pull request's own commit is the contributor's to remove, and a shallow clone says so.
test('an adopted pull request that carries an undone upgrade is refused with the contributor remedy, and a shallow clone suggests --unshallow (review fixes (b), N3)', async t => {
  const f = prefixedSandbox(t); put(f.root, 'app.txt', 'base\n'); commit(f.root, 'App');
  const base = git(f.root, ['rev-parse', 'HEAD']), main = git(f.root, ['symbolic-ref', '--short', 'HEAD']);
  git(f.root, ['checkout', '-qb', 'chore/factotum-upgrade']);
  put(f.root, 'factotum.lock.json', JSON.stringify({ formatVersion: 1, prefix: PREFIX, note: 'upgraded' }, null, 2) + '\n'); commit(f.root, 'Adopt the upgrade');
  const upgrade = git(f.root, ['rev-parse', 'HEAD']);
  // The outside pull request: it merged the unmerged upgrade branch and undid it.
  git(f.root, ['checkout', '-qb', 'outside', base]); gitc(f.root, ['merge', '-q', '--no-ff', '--no-edit', upgrade]); gitc(f.root, ['checkout', base, '--', 'factotum.lock.json']); put(f.root, 'feature.txt', 'Outside\n'); commit(f.root, 'Outside work');
  const prHead = git(f.root, ['rev-parse', 'HEAD']); git(f.root, ['checkout', '-q', main]);
  const remote = join(f.base, 'remote.git'); execFileSync('git', ['init', '--bare', '-q', remote]); git(f.root, ['remote', 'add', 'origin', remote]); git(f.root, ['push', '-q', 'origin', `${base}:refs/heads/main`]);
  const flowId = 'adopted', workspace = await prepare({ root: f.root, stateDir: f.stateDir, projectId: 'fictional', flowId, baseRef: prHead });
  const adopted = actionFor(f, workspace, flowId, 'workspace.integrate'); adopted.action.candidate = { number: 1, head: prHead, base };
  const remedy = /commit [0-9a-f]{12}, which is not in the recorded target, changes factotum\.lock\.json .*The commit came from the adopted pull request, whose commits the factory delivers unchanged: its contributor must squash or rebase that commit away/;
  await assert.rejects(runAction(adopted), error => remedy.test(error.message) && !/Rebuild the candidate/.test(error.message) && !/shallow clone/.test(error.message));
  // The same refusal in a repository with a shallow boundary adds the --unshallow hint.
  const shallowFile = join(f.root, '.git/shallow'); writeFileSync(shallowFile, `${base}\n`);
  const again = actionFor(f, workspace, flowId, 'workspace.integrate'); again.action.candidate = adopted.action.candidate;
  await assert.rejects(runAction(again), /This repository is a shallow clone: .*run git fetch --unshallow and retry/);
  rmSync(shallowFile);
});

// N8: the repository's shallow file is read as a hint with limits, and only commits from it are read.
test('the shallow-file hint is bounded in size and entries and reads only commits (review fix N8)', async t => {
  const { VerifiedObjects, SHALLOW_HINT_LIMIT } = await verifiedGit(), f = sandbox(t), count = countGit(t); git(f.root, ['config', 'commit.gpgsign', 'false']);
  const head = fastImport(f.root, 'refs/heads/line', git(f.root, ['rev-parse', 'HEAD']), 300, { date: Math.floor(Date.now() / 1000) + 1000 });
  const unrelated = git(f.root, ['commit-tree', git(f.root, ['rev-parse', 'HEAD^{tree}']), '-m', 'Unrelated target']), shallowFile = join(f.root, '.git/shallow');
  const walk = name => {
    const objects = new VerifiedObjects(f.root), requested = new Set(), each = objects.each.bind(objects);
    objects.each = (ids, fn) => { for (const id of ids) requested.add(id); return each(ids, fn); };
    const { value, processes } = count(() => objects.reaches(head, unrelated));
    assert.equal(value, false, name); assert.ok(processes <= 100, `${name}: ${processes} Git processes`);
    return requested;
  };
  const fake = n => Array.from({ length: n }, (_, i) => createHash('sha1').update(`absent ${i}`).digest('hex'));
  // Over the size limit: 200,000 IDs that do not exist (8 MB). Ignored without reading any of them.
  const many = fake(200000); writeFileSync(shallowFile, many.join('\n') + '\n');
  let requested = walk('200,000 absent IDs'); assert.equal(many.some(id => requested.has(id)), false, 'no hinted ID was read');
  // Within the size limit but over the entry limit.
  const over = fake(SHALLOW_HINT_LIMIT + 1); writeFileSync(shallowFile, over.join('\n') + '\n');
  requested = walk('one entry too many'); assert.equal(over.some(id => requested.has(id)), false);
  // Large blobs named in the hint are typed, never read; a real commit in it is still read.
  const blobs = [1, 2, 3].map(i => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: f.root, encoding: 'utf8', input: Buffer.alloc(8 << 20, i) }).trim());
  const commitInHint = git(f.root, ['rev-parse', `${head}~200`]); writeFileSync(shallowFile, [...blobs, commitInHint].join('\n') + '\n');
  requested = walk('large blobs'); assert.equal(blobs.some(id => requested.has(id)), false, 'no blob was read'); assert.ok(requested.has(commitInHint));
  rmSync(shallowFile);
});

// Root fix after the round-3 re-check (N13): a shallow file that is not a regular file is never read.
test('a shallow file that is a FIFO or a link to a device neither hangs nor floods a check', async t => {
  const { VerifiedObjects, shallowBoundary } = await verifiedGit(), f = sandbox(t), shallowFile = join(f.root, '.git/shallow');
  execFileSync('mkfifo', [shallowFile]);
  const started = Date.now();
  assert.deepEqual(new VerifiedObjects(f.root).shallowHint(), [], 'a FIFO hint is ignored');
  assert.throws(() => shallowBoundary(f.root), /not a regular file/, 'the boundary read refuses a FIFO');
  rmSync(shallowFile); symlinkSync('/dev/zero', shallowFile);
  assert.deepEqual(new VerifiedObjects(f.root).shallowHint(), [], 'a link is not followed');
  assert.throws(() => shallowBoundary(f.root), /cannot read the shallow file safely/);
  assert.ok(Date.now() - started < 5000, 'no read blocked');
});
